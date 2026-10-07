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
import json
import logging
import threading
from collections import OrderedDict
from datetime import UTC, datetime
from pathlib import Path

from flask import jsonify, request

from core import atajo_acceso, settings
from core.escritura import escribirJsonAtomico

log = logging.getLogger(__name__)

SECCION = "atajo"

# Las últimas IPs rechazadas por este filtro, para que Ajustes las pueda enseñar
# con un botón de «permitir» al lado. En memoria y no en disco: es un apunte de
# diagnóstico —«¿desde qué dirección llega el móvil?»—, no un registro, y al
# reiniciar basta con volver a lanzar el Atajo para que reaparezca. Una entrada
# por IP, con la última vez, la ruta y cuántas veces; sin las rutas repetidas
# de un mismo Atajo (lista, categorías, preparar…) ocupando cuatro filas.
MAX_RECHAZOS = 20
_rechazos = OrderedDict()
_rechazosLock = threading.Lock()


def registrarRechazo(ip, metodo, ruta):
    if not ip:
        return
    with _rechazosLock:
        previo = _rechazos.pop(ip, None)
        _rechazos[ip] = {
            "ip": ip,
            "metodo": metodo,
            "ruta": ruta,
            "ultima": datetime.now(UTC).isoformat(timespec="seconds"),
            "veces": (previo["veces"] if previo else 0) + 1,
        }
        while len(_rechazos) > MAX_RECHAZOS:
            _rechazos.popitem(last=False)


def rechazosRecientes():
    """Las IPs rechazadas, la más reciente primero, y si ya estarían permitidas.

    `permitida` se calcula ahora y no cuando se rechazó: así, tras añadir un
    rango en Ajustes, la fila cambia a «ya permitida» sin esperar a que el
    móvil vuelva a llamar.
    """
    with _rechazosLock:
        filas = list(reversed(_rechazos.values()))
    redes = leerRedesPermitidas()
    return [{**fila, "permitida": ipEstaPermitida(fila["ip"], redes)} for fila in filas]


def olvidarRechazos():
    with _rechazosLock:
        _rechazos.clear()


# ── Nombres de host admitidos (DNS rebinding) ─────────────────────────────────
# El filtro de IP no basta frente a una web maliciosa visitada desde la LAN: su
# dominio puede pasar a resolver a la IP de este servidor (DNS rebinding) y el
# navegador de la víctima hace entonces peticiones «del mismo origen» que salen
# de una IP permitida. Lo que delata esas peticiones es la cabecera Host, que
# lleva el dominio del atacante. Se admiten:
#
#   - IPs literales y `localhost`: con ellas no hay dominio que reapuntar.
#   - Los nombres por los que ya se ha entrado CON SESIÓN iniciada. Se aprenden
#     solos (lo anota require_login en core/seguridad_app.py): el dominio de un
#     atacante nunca llega con la cookie de sesión de esta aplicación, y así no
#     hay que mantener ninguna lista a mano.
MAX_HOSTS = 20
_hostsCache = {"firma": None, "hosts": frozenset()}
_hostsLock = threading.Lock()


def _ficheroHosts():
    # Se deriva de ACCESO_FILE en cada llamada para seguir a donde apunte (los
    # tests lo redirigen a un temporal).
    return atajo_acceso.ACCESO_FILE.parent / "hosts.json"


def nombreDeHost(cabeceraHost) -> str:
    """El nombre de la cabecera Host, sin puerto y en minúsculas."""
    texto = str(cabeceraHost or "").strip().lower()
    if texto.startswith("["):                        # IPv6: [::1]:5000
        return texto[1:texto.find("]")] if "]" in texto else ""
    if texto.count(":") == 1:                        # nombre:puerto o ipv4:puerto
        texto = texto.rsplit(":", 1)[0]
    return texto.rstrip(".")


def _esDireccionDirecta(nombre) -> bool:
    if nombre == "localhost":
        return True
    try:
        ipaddress.ip_address(nombre)
        return True
    except ValueError:
        return False


def hostsConocidos() -> frozenset:
    ruta = _ficheroHosts()
    try:
        st = ruta.stat()
    except OSError:
        return frozenset()
    firma = (str(ruta), st.st_mtime_ns, st.st_size)
    if firma != _hostsCache["firma"]:
        try:
            datos = json.loads(ruta.read_text("utf-8"))
            hosts = frozenset(str(h) for h in datos.get("hosts", []) if str(h).strip())
        except (OSError, ValueError, AttributeError):
            hosts = frozenset()
        _hostsCache.update(firma=firma, hosts=hosts)
    return _hostsCache["hosts"]


def anotarHostConSesion(cabeceraHost) -> None:
    """Recuerda el nombre por el que ha entrado una sesión válida."""
    nombre = nombreDeHost(cabeceraHost)
    if not nombre or _esDireccionDirecta(nombre) or nombre in hostsConocidos():
        return
    with _hostsLock:
        hosts = [h for h in hostsConocidos() if h != nombre] + [nombre]
        try:
            escribirJsonAtomico(_ficheroHosts(), {"hosts": hosts[-MAX_HOSTS:]})
        except OSError as error:
            log.warning("[red_local] No se pudo guardar el host %s: %s", nombre, error)
            return
    log.info("[red_local] Nombre de host admitido para el Atajo: %s", nombre)


def hostAdmitido(cabeceraHost) -> bool:
    nombre = nombreDeHost(cabeceraHost)
    return bool(nombre) and (_esDireccionDirecta(nombre) or nombre in hostsConocidos())


def atajoActivado():
    return settings.obtener("atajo.activado")


def leerRedesPermitidas():
    """Devuelve la lista de redes permitidas ya parseadas.

    Salen de `atajo_acceso`, que devuelve lo guardado desde Ajustes o, si ahí no
    hay nada, lo que diga `[atajo] redes_permitidas`. Dejar esa lista vacía en
    config.ini devuelve una lista vacía, no los rangos por defecto: el decorador
    de abajo lo traduce en rechazar todo.
    """
    crudas = atajo_acceso.redesEfectivas()
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


# Rangos que reparte Docker a sus redes (el puente por defecto es 172.17/16, las
# redes de compose van de 172.18 a 172.31) y el de Docker Desktop. 172.16/16 no
# está: es el primero que se usa en redes domésticas o de empresa de ese bloque.
_REDES_INTERNAS_DOCKER = tuple(
    ipaddress.ip_network(r)
    for r in ("172.17.0.0/16", "172.18.0.0/15", "172.20.0.0/14", "172.24.0.0/13", "192.168.65.0/24")
)


def pareceRedInternaDeDocker(ipCliente) -> bool:
    """¿La IP con la que llega la petición es la de una red interna de Docker?

    Solo dentro de un contenedor. Cuando pasa, la IP real del cliente se ha
    perdido por el camino (docker-proxy, Docker Desktop, o `PROXY_FIX_HOPS` sin
    poner con Caddy delante): todos los clientes se ven con esa IP y el filtro de
    red no distingue a nadie. El panel lo avisa junto a «IP con la que te ve el
    servidor».
    """
    if not Path("/.dockerenv").exists():
        return False
    try:
        direccion = ipaddress.ip_address(str(ipCliente or "").strip())
    except ValueError:
        return False
    if direccion.version == 6 and direccion.ipv4_mapped is not None:
        direccion = direccion.ipv4_mapped
    return any(direccion in red for red in _REDES_INTERNAS_DOCKER)


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
            registrarRechazo(ipCliente, request.method, request.path)
            # Se devuelve la IP de origen para que configurar esto no exija
            # entrar por SSH a leer el log: basta abrir el endpoint desde el
            # móvil y ver con qué dirección llega. No revela nada que el
            # cliente no sepa ya, y nunca se devuelven los rangos permitidos.
            return jsonify({
                "ok": False,
                "error": "Origen no autorizado",
                "ip": ipCliente or "",
            }), 403

        if not hostAdmitido(request.host):
            nombre = nombreDeHost(request.host)
            log.warning("[red_local] %s %s rechazada: Host %r no reconocido", request.method, request.path, nombre)
            return jsonify({
                "ok": False,
                "error": (
                    f"La dirección «{nombre}» no está reconocida. Entra una vez en la aplicación "
                    "con esa misma dirección y la sesión iniciada, y vuelve a lanzar el Atajo."
                ),
            }), 403

        return func(*args, **kwargs)

    return wrapper
