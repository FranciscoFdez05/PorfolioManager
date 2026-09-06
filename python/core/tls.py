"""HTTPS gobernado desde Ajustes, con Caddy delante como quien termina el TLS.

**Por qué no lo hace la propia aplicación.** Gunicorn sabe servir TLS, pero lee
el certificado al arrancar: activar el HTTPS desde la interfaz obligaría a
reiniciar el contenedor en mitad de la petición que lo activa. Y generar los
certificados a mano trae detrás toda la cola: renovarlos antes de que caduquen
(iOS rechaza los de más de 398 días), volver a emitirlos cuando cambia una IP,
y una CA propia que mantener. Caddy ya hace las tres cosas.

**Por qué no se arranca Caddy desde aquí.** Sería `docker compose up` desde
dentro del contenedor, y eso exige montarle el socket de Docker a la
aplicación: cualquier fallo de esta pasaría a ser root en el host. Un agujero
peor que el que veníamos a tapar. Así que Caddy está **siempre levantado** y lo
que hace este módulo es *reconfigurarlo en caliente* por su API de admin, que
vive en la red interna de Compose y no se publica al host.

El flujo completo de activar el HTTPS:

    Ajustes ──POST /load (text/caddyfile)──> caddy:2019
                                              ├─ emite el certificado con su CA interna
                                              └─ el puerto pasa a hablar solo TLS
    Ajustes ──GET /pki/ca/local────────────> raíz de la CA, para instalar en cada aparato

**Dónde vive el estado.** En `data/tls/estado.json`, no en config.ini: es una
decisión del usuario tomada desde la interfaz, y config.ini está versionado y se
sobrescribe en cada `git pull`. `[server] https_activado` sigue existiendo como
override de despliegue —para el caso de un dominio público con Let's Encrypt,
que se configura por .env— y cuando está puesto manda sobre el fichero.

**El puerto no cambia.** Caddy escucha en el mismo `[server] port` que ya usabas
(la aplicación deja de publicarlo y solo se llega a ella a través de Caddy), así
que activar el HTTPS no mueve la dirección: `http://IP:5000` pasa a ser
`https://IP:5000`. Y ese puerto deja de aceptar texto plano, que era el objetivo.
"""

import json
import logging
import os
import socket
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime

from core import paths, settings

log = logging.getLogger(__name__)

# Directorio propio y no data/JSON/: ahí viven las preferencias de la interfaz,
# que se exportan e importan con el portfolio. Esto es configuración de la
# máquina —qué nombres tiene este servidor— y no debe viajar en un export.
TLS_DIR = paths.DATA_DIR / "tls"
ESTADO_FILE = TLS_DIR / "estado.json"

# Dirección de la API de admin de Caddy dentro de la red de Compose. No se
# publica al host en ningún caso: quien la alcanza puede reconfigurar el proxy
# entero, así que el único que debe verla es este contenedor.
CADDY_ADMIN = os.environ.get("CADDY_ADMIN_URL", "http://caddy:2019").rstrip("/")

# Corto a propósito. Estas llamadas ocurren dentro de una petición del navegador
# y Caddy está a un salto de red; si no contesta en unos segundos, lo que hay es
# un problema, no lentitud.
TIMEOUT = 10

# El identificador que Caddy da a su CA interna. Es fijo.
CA_INTERNA = "local"

# Reintentos al arrancar, solo para la convergencia inicial. Suman 8 segundos en
# el peor caso; el arranque de gunicorn tiene 120 s de margen.
_REINTENTOS_ARRANQUE = 5
_ESPERA_REINTENTO = 2

_ESTADO_POR_DEFECTO = {"activado": False, "nombres": [], "actualizado": None}


# ── Estado ────────────────────────────────────────────────────────────────────

def leerEstado() -> dict:
    """Estado guardado, o los valores por defecto si aún no hay fichero.

    Nunca lanza: esto lo consulta `seguridad_app` en cada respuesta para decidir
    si la cookie lleva `Secure`, y un JSON corrupto no puede tumbar la
    aplicación entera. Un fichero ilegible se trata como «HTTPS desactivado»,
    que es el estado que siempre funciona.
    """
    try:
        datos = json.loads(ESTADO_FILE.read_text("utf-8"))
    except FileNotFoundError:
        return dict(_ESTADO_POR_DEFECTO)
    except (OSError, ValueError) as e:
        log.warning("[tls] estado.json ilegible (%s); se asume HTTPS desactivado", e)
        return dict(_ESTADO_POR_DEFECTO)

    if not isinstance(datos, dict):
        return dict(_ESTADO_POR_DEFECTO)

    return {
        "activado": bool(datos.get("activado")),
        "nombres": [str(n) for n in datos.get("nombres", []) if str(n).strip()],
        "actualizado": datos.get("actualizado"),
    }


def guardarEstado(activado: bool, nombres: list[str]) -> dict:
    estado = {
        "activado": bool(activado),
        "nombres": list(nombres),
        "actualizado": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    TLS_DIR.mkdir(parents=True, exist_ok=True)
    # Escritura atómica: un corte de corriente a medias dejaría un JSON truncado,
    # y este fichero decide si las cookies salen con Secure.
    tmp = ESTADO_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(estado, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(ESTADO_FILE)
    return estado


def httpsActivo() -> bool:
    """¿Se está sirviendo por HTTPS ahora mismo?

    Es la pregunta que hacen las cookies (`Secure`) y la cabecera HSTS. El
    override de despliegue gana al fichero: quien pone `HTTPS_ENABLED=true` en
    .env tiene un proxy propio delante (o el Caddy con dominio público y Let's
    Encrypt) y no pasa por esta interfaz.
    """
    return settings.httpsActivado() or leerEstado()["activado"]


# ── Nombres ───────────────────────────────────────────────────────────────────

def normalizarNombres(nombres) -> list[str]:
    """Limpia la lista que llega de la interfaz y quita duplicados.

    Los nombres importan más de lo que parece: el certificado solo vale para los
    que se declaren aquí. Entrar por una IP que no esté en la lista da un aviso
    del navegador aunque la CA esté instalada, porque el nombre no coincide.
    """
    limpios = []
    for bruto in nombres or []:
        nombre = str(bruto).strip().lower().rstrip(".")
        # Se acepta que peguen una URL entera: es lo que tiene el usuario en la
        # barra del navegador, y exigirle que la desmonte solo genera errores.
        for prefijo in ("https://", "http://"):
            if nombre.startswith(prefijo):
                nombre = nombre[len(prefijo):]
        nombre = nombre.split("/")[0]
        # El puerto lo pone la configuración, no el usuario: dejarlo aquí haría
        # que Caddy montase un sitio en un puerto que no está publicado.
        if nombre.count(":") == 1:
            nombre = nombre.split(":")[0]
        if not nombre or any(c in nombre for c in " \t\"'{}"):
            continue
        if nombre not in limpios:
            limpios.append(nombre)
    return limpios


def nombresSugeridos(hostActual: str = "") -> list[str]:
    """Con qué nombres llega relleno el campo del certificado.

    Este campo es donde se falla, y se falla en silencio: el certificado solo
    vale para lo que se declare, así que quien activa el HTTPS entrando por
    `localhost` se queda con uno que no cubre la IP por la que entra desde el
    móvil. El navegador sigue avisando, la CA ya está instalada y no hay nada
    que sugiera que lo que falta es una línea en esta lista.

    Se juntan las dos únicas pistas fiables: el nombre por el que ha llegado
    esta petición —lo que el usuario tiene escrito en la barra— y la IP de la
    LAN del servidor. La segunda no se puede averiguar desde dentro del
    contenedor (ahí solo se ve la red de Compose), así que la pone
    `docker-up.sh`, que sí corre en el host, en PORTFOLIO_LAN_IP.
    """
    return normalizarNombres([hostActual, os.environ.get("PORTFOLIO_LAN_IP", "")])


# ── Configuración de Caddy ────────────────────────────────────────────────────

def construirCaddyfile(activado: bool, nombres: list[str]) -> str:
    """Configuración completa de Caddy para el estado pedido.

    Se genera un Caddyfile y no el JSON nativo porque la API de admin sabe
    adaptarlo (`Content-Type: text/caddyfile`) y esto se puede leer: el JSON
    equivalente son ochenta líneas anidadas en las que un error no se ve.
    """
    puerto = settings.puerto()
    admin = """{
	admin :2019 {
		origins caddy:2019 localhost:2019 127.0.0.1:2019
	}
"""

    if not activado or not nombres:
        # Sin nombres no hay certificado posible, así que se sirve en claro
        # aunque el estado dijera lo contrario: mejor accesible y avisando que
        # un proxy que rechaza todo y deja al usuario fuera de su propia app.
        return (
            admin
            + "\tauto_https off\n}\n\n"
            + f":{puerto} {{\n"
            + f"\treverse_proxy porfoliomanager:{puerto}\n"
            + "}\n"
        )

    # localhost y 127.0.0.1 van SIEMPRE, aunque el usuario no los escriba. Caddy
    # rechaza la conexión si el nombre pedido no tiene sitio, y por localhost
    # entran dos cosas que no se ven: el healthcheck del contenedor y la
    # comprobación de docker-update.sh, que al fallar da la actualización por
    # mala y vuelve atrás sola. No añaden riesgo: solo valen desde el propio host.
    efectivos = list(nombres)
    for fijo in ("localhost", "127.0.0.1"):
        if fijo not in efectivos:
            efectivos.append(fijo)

    # disable_redirects: el redirector automático de Caddy escucha en el 80, que
    # aquí no se publica. Sin esto, el log se llena de avisos por un puerto que
    # nadie puede alcanzar.
    sitios = ", ".join(f"https://{n}:{puerto}" for n in efectivos)
    return (
        admin
        + "\tauto_https disable_redirects\n}\n\n"
        + f"{sitios} {{\n"
        + "\ttls internal\n"
        + f"\treverse_proxy porfoliomanager:{puerto}\n"
        + "}\n"
    )


def _admin(ruta: str, datos: bytes | None = None, tipo: str | None = None) -> bytes:
    peticion = urllib.request.Request(f"{CADDY_ADMIN}{ruta}", data=datos)
    if tipo:
        peticion.add_header("Content-Type", tipo)
    with urllib.request.urlopen(peticion, timeout=TIMEOUT) as respuesta:
        return respuesta.read()


class ErrorCaddy(RuntimeError):
    """El proxy no ha aceptado la configuración, o no responde."""


def aplicar(activado: bool, nombres: list[str]) -> None:
    """Carga la configuración en Caddy. Lanza ErrorCaddy si no la acepta.

    Que Caddy valide antes de aplicar es lo que hace segura la activación desde
    la interfaz: si el Caddyfile generado no es válido, responde 400, no toca su
    configuración en marcha y el usuario sigue conectado como estaba.
    """
    caddyfile = construirCaddyfile(activado, nombres)
    try:
        _admin("/load", caddyfile.encode("utf-8"), "text/caddyfile")
    except urllib.error.HTTPError as e:
        detalle = e.read().decode("utf-8", "replace").strip()[:400]
        raise ErrorCaddy(f"Caddy rechazó la configuración ({e.code}): {detalle}") from e
    except OSError as e:
        raise ErrorCaddy(
            f"No se puede hablar con el proxy en {CADDY_ADMIN}: {e}. "
            "Comprueba que el contenedor 'caddy' está en marcha."
        ) from e


def raizDeLaCa() -> str:
    """Certificado raíz de la CA interna de Caddy, en PEM.

    Se pide por la API de admin y no leyendo el volumen de Caddy: ese volumen
    pertenece a root y la aplicación corre sin privilegios, así que montarlo
    solo funcionaría según qué permisos deje Caddy a sus ficheros. La API lo
    devuelve siempre y sin depender de eso.
    """
    try:
        datos = json.loads(_admin(f"/pki/ca/{CA_INTERNA}"))
    except urllib.error.HTTPError as e:
        raise ErrorCaddy(
            f"El proxy no ha devuelto la CA ({e.code}). Si acabas de activar el "
            "HTTPS, espera unos segundos: se genera en la primera emisión."
        ) from e
    except OSError as e:
        raise ErrorCaddy(f"No se puede hablar con el proxy en {CADDY_ADMIN}: {e}") from e

    raiz = (datos or {}).get("root_certificate", "")
    if not raiz.strip():
        raise ErrorCaddy(
            "El proxy responde pero aún no ha generado su CA. Activa el HTTPS "
            "primero: la autoridad se crea al emitir el primer certificado."
        )
    return raiz


def proxyDisponible() -> bool:
    """¿Contesta la API de admin? Para poder decirlo en la interfaz antes de
    ofrecer un botón que no va a funcionar."""
    try:
        _admin("/config/")
        return True
    except (OSError, ValueError):
        return False


# ── Comprobación ──────────────────────────────────────────────────────────────

# Segundos que se le dan a cada handshake. Es una conexión a un contenedor
# vecino: si tarda más, no está lento, está roto.
TIMEOUT_PRUEBA = 5


def _hostDelProxy() -> str:
    """Dónde escucha Caddy visto desde esta aplicación.

    Sale de la misma variable que la API de admin para que no haya dos sitios
    que puedan discrepar: quien cambia uno cambia el otro.
    """
    return urllib.parse.urlsplit(CADDY_ADMIN).hostname or "caddy"


def _resumenCertificado(cert: dict) -> dict:
    """Lo que importa de un certificado ya validado: qué cubre y hasta cuándo.

    Aparte de `_probarNombre()` porque es la única parte con reglas propias y sí
    se puede probar sin levantar un TLS de verdad.
    """
    nombres = [valor for clave, valor in cert.get("subjectAltName", ()) if clave in ("DNS", "IP Address")]

    caduca, dias = None, None
    bruto = cert.get("notAfter")
    if bruto:
        try:
            fin = ssl.cert_time_to_seconds(bruto)
        except ValueError:
            fin = None
        if fin is not None:
            caduca = datetime.fromtimestamp(fin, UTC).date().isoformat()
            # Hacia abajo: un certificado al que le quedan 29 horas tiene un día,
            # no dos. Redondear al alza aquí sería tranquilizar de más.
            dias = int((fin - time.time()) // 86400)

    return {"cubre": nombres, "caduca": caduca, "dias": dias}


def _contextoDeConfianza() -> ssl.SSLContext:
    """Valida contra la CA interna de Caddy, no contra las del sistema.

    Es lo que convierte la prueba en algo que responde a la pregunta del
    usuario: no basta con que haya TLS, tiene que ser el certificado que firma
    **la misma CA que se descarga desde esta pantalla**, que es la que va a
    instalar en el móvil.
    """
    return ssl.create_default_context(cadata=raizDeLaCa())


def _probarNombre(contexto: ssl.SSLContext, nombre: str, puerto: int) -> dict:
    """Abre una conexión TLS real contra el proxy pidiendo `nombre`.

    Se conecta al proxy por su nombre en la red de Compose, no al que se está
    comprobando: los nombres de la lista son los que valen desde fuera (la IP de
    la LAN, `portfolio.casa`) y dentro del contenedor no tienen por qué
    resolver. Lo que se comprueba es el certificado que Caddy presenta cuando le
    piden ese nombre, que es exactamente lo que verá el navegador.
    """
    salida = {"nombre": nombre, "ok": False, "error": None, "cubre": [], "caduca": None, "dias": None}
    try:
        with (
            socket.create_connection((_hostDelProxy(), puerto), timeout=TIMEOUT_PRUEBA) as bruto,
            contexto.wrap_socket(bruto, server_hostname=nombre) as seguro,
        ):
            salida.update(_resumenCertificado(seguro.getpeercert() or {}))
            salida["ok"] = True
    except ssl.SSLCertVerificationError as e:
        # El caso que de verdad se viene a cazar: hay TLS, pero el certificado no
        # sirve para este nombre (o no lo firma la CA que el usuario instaló).
        salida["error"] = f"El certificado no vale para este nombre: {e.verify_message or e.reason}"
    except ssl.SSLError as e:
        salida["error"] = f"El proxy no ha levantado el TLS: {e}"
    except OSError as e:
        salida["error"] = f"No se puede conectar con el proxy: {e}"
    return salida


def probar() -> dict:
    """Comprueba el cifrado de verdad, en vez de repetir lo que dice el estado.

    `estado.json` solo dice lo que se pidió; esto abre una conexión por cada
    nombre declarado y valida el certificado **contra la misma CA que se
    descarga desde Ajustes**. Así el botón responde a la pregunta que de verdad
    tiene el usuario —«¿me va a seguir avisando el navegador?»— y no a «¿quedó
    guardado el interruptor?».
    """
    estado = leerEstado()
    salida = {
        "https": httpsActivo(),
        "proxy": proxyDisponible(),
        "nombres": [],
        "caduca": None,
        "dias": None,
        "error": None,
    }

    if not salida["https"]:
        # No es un fallo: es la otra mitad de la decisión que el usuario ha
        # tomado. Servir en claro es un estado legítimo y la interfaz lo dice
        # sin pintarlo de rojo.
        return salida

    if not salida["proxy"]:
        salida["error"] = (
            f"El proxy no responde en {CADDY_ADMIN}. Comprueba que el contenedor "
            "'caddy' está en marcha."
        )
        return salida

    try:
        contexto = _contextoDeConfianza()
    except ErrorCaddy as e:
        salida["error"] = str(e)
        return salida
    except ssl.SSLError as e:
        # La CA llega por la red y puede volver truncada o vacía. Sin esto, un
        # PEM malformado subía como un 500 sin explicación en vez de como lo que
        # es: una comprobación que no se ha podido hacer.
        salida["error"] = f"La CA que devuelve el proxy no es un certificado legible: {e}"
        return salida

    puerto = settings.puerto()
    for nombre in estado["nombres"] or ["localhost"]:
        salida["nombres"].append(_probarNombre(contexto, nombre, puerto))

    # El resumen se queda con el que caduca antes: es el que va a dar el primer
    # susto, y el único plazo que sirve para decidir si hay que renovar.
    plazos = [r["dias"] for r in salida["nombres"] if r["dias"] is not None]
    if plazos:
        pronto = min(salida["nombres"], key=lambda r: r["dias"] if r["dias"] is not None else 10**6)
        salida["caduca"] = pronto["caduca"]
        salida["dias"] = pronto["dias"]

    return salida


def avisoSinHttps() -> str | None:
    """Recordatorio de que el login viaja en claro, o None si hay HTTPS.

    Fuera de `settings.validar()` a propósito: allí van las configuraciones
    **mal** puestas, y el config.ini que se distribuye tiene que pasar esa
    validación sin un solo aviso. Servir por HTTP no está mal puesto —es el
    estado de fábrica, y en localhost es razonable—, pero sí es lo que hay que
    ver escrito al arrancar si se entra desde otro aparato de la red.
    """
    if httpsActivo():
        return None
    return (
        "HTTPS desactivado: la contraseña del login y la cookie de sesión viajan "
        "en claro. Se activa desde la propia aplicación, en Ajustes > Seguridad > HTTPS; la "
        "dirección no cambia, solo pasa a ser https://."
    )


# ── Arranque ──────────────────────────────────────────────────────────────────

def converger() -> None:
    """Reaplica en Caddy el estado guardado. Se llama al arrancar la aplicación.

    Caddy arranca con un Caddyfile mínimo (proxy en claro) y guarda la última
    configuración cargada, pero las dos pueden separarse: si se recrea su
    contenedor sin volumen de configuración, o si alguien lo levanta a mano,
    volvería a servir en claro con el estado diciendo que hay HTTPS —y entonces
    las cookies saldrían con `Secure` sobre una conexión que no lo es, es decir,
    nadie podría iniciar sesión—. Reaplicarlo al arrancar cierra esa ventana.

    No aborta el arranque si falla: la aplicación tiene que poder levantar y
    contarlo en el log aunque el proxy esté caído, o no habría interfaz desde la
    que arreglarlo.
    """
    estado = leerEstado()
    if settings.httpsActivado():
        # El HTTPS lo lleva un proxy configurado por .env (dominio público,
        # Let's Encrypt). Tocar su configuración desde aquí la machacaría.
        log.info("[tls] https_activado por configuración: no se toca el proxy")
        return

    # Se reintenta porque los dos contenedores arrancan a la vez: `depends_on`
    # espera a que el de la aplicación exista, no a que Caddy esté escuchando,
    # así que el primer intento cae en medio segundo de ventana con bastante
    # frecuencia. Rendirse ahí dejaría el proxy sirviendo en claro con el estado
    # diciendo que hay HTTPS hasta el siguiente reinicio.
    ultimo = None
    for intento in range(_REINTENTOS_ARRANQUE):
        try:
            aplicar(estado["activado"], estado["nombres"])
            break
        except ErrorCaddy as e:
            ultimo = e
            if intento < _REINTENTOS_ARRANQUE - 1:
                time.sleep(_ESPERA_REINTENTO)
    else:
        log.warning("[tls] No se ha podido aplicar la configuración del proxy: %s", ultimo)
        return

    if estado["activado"]:
        log.info("[tls] HTTPS activo para %s", ", ".join(estado["nombres"]))
    else:
        log.info("[tls] HTTPS desactivado: el proxy sirve en claro")
