"""Filtro de IP para los endpoints que no pasan por la sesión de la web app.

Los endpoints del Atajo de iOS no pueden autenticarse con la cookie de sesión,
así que su primera barrera es la red de origen: solo se aceptan peticiones que
lleguen desde la LAN o desde el túnel de WireGuard. La segunda barrera es la
firma HMAC de core/firma_hmac.py.

Los rangos salen de [atajo] redes_permitidas en config.ini (o de la variable de
entorno MOVIMIENTOS_REDES_PERMITIDAS como override puntual), no de constantes
en este fichero: cambiar de red no debe obligar a tocar código.

Importante: el filtro mira `request.remote_addr`, así que depende de que esa IP
sea la de verdad. Sin proxy delante lo es. Con un proxy inverso (el Caddy del
perfil `https`) lo es solo si `[server] proxy_saltos` está bien puesto: ese
ajuste instala ProxyFix en server.py, que reescribe remote_addr con la IP real
del cliente. Con un proxy delante y proxy_saltos = 0, remote_addr sería la del
proxy en todas las peticiones y este filtro dejaría de discriminar nada —lo
dejaría todo dentro o todo fuera, según los rangos configurados—. `validar()`
en core/settings.py avisa al arrancar de esa combinación.
"""

import functools
import ipaddress
import logging

from flask import jsonify, request

from core import settings

log = logging.getLogger(__name__)

SECCION = "atajo"


def atajoActivado():
    return settings.obtener("atajo.activado")


def leerRedesPermitidas():
    """Devuelve la lista de redes permitidas ya parseadas.

    Dejar `redes_permitidas =` vacío en config.ini devuelve una lista vacía, no
    los rangos por defecto: el decorador de abajo lo traduce en rechazar todo.
    """
    crudas = settings.obtener("atajo.redes_permitidas")
    redes = []

    for texto in crudas:
        try:
            # strict=False acepta "192.168.1.5/24" además de "192.168.1.0/24".
            redes.append(ipaddress.ip_network(texto, strict=False))
        except ValueError:
            log.warning("[red_local] Rango inválido en [%s] redes_permitidas, ignorado: %r", SECCION, texto)

    return redes


def ipEstaPermitida(ipCliente, redes=None):
    if not ipCliente:
        return False

    try:
        direccion = ipaddress.ip_address(str(ipCliente).strip())
    except ValueError:
        return False

    # Una IPv4 encapsulada en IPv6 (::ffff:192.168.1.20) no coincide con ninguna
    # red IPv4 hasta que se desenvuelve.
    if direccion.version == 6 and direccion.ipv4_mapped is not None:
        direccion = direccion.ipv4_mapped

    if redes is None:
        redes = leerRedesPermitidas()

    return any(direccion in red for red in redes)


def obtenerIpCliente():
    """IP de origen de la petición.

    Se lee remote_addr y nunca X-Forwarded-For a mano: esa cabecera la puede
    falsificar cualquiera y confiar en ella sin más convertiría este filtro en
    un adorno. Quien la traduce, cuando hay proxy, es ProxyFix, y solo hasta el
    número de saltos declarado en `[server] proxy_saltos`; el resultado ya viene
    en remote_addr, así que aquí no cambia nada.
    """
    return request.remote_addr


def soloRedLocal(func):
    """Rechaza cualquier petición que no venga de las redes permitidas."""

    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        if not atajoActivado():
            # 404 y no 403: con la función apagada, estas rutas no deberían ni
            # dejar ver que existen.
            return jsonify({"ok": False, "error": "Recurso no encontrado"}), 404

        redes = leerRedesPermitidas()

        if not redes:
            # Fail-closed: una configuración vacía o completamente inválida no
            # puede traducirse en "acepta a todo el mundo".
            log.error("[red_local] Sin redes permitidas válidas; se rechaza la petición")
            return jsonify({"ok": False, "error": "Filtro de red mal configurado"}), 403

        ipCliente = obtenerIpCliente()

        if not ipEstaPermitida(ipCliente, redes):
            log.warning("[red_local] %s %s rechazada desde %s", request.method, request.path, ipCliente)
            # Se devuelve la IP de origen para que configurar esto no exija
            # entrar por SSH a leer el log: basta abrir el endpoint desde el
            # móvil y ver con qué dirección llega. No revela nada que el
            # cliente no sepa ya, y nunca se devuelven los rangos permitidos.
            return jsonify({
                "ok": False,
                "error": "Origen no autorizado",
                "ip": ipCliente or "",
            }), 403

        return func(*args, **kwargs)

    return wrapper
