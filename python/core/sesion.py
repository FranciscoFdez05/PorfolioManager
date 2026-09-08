"""Ciclo de vida de la sesión: identificador, caducidad y revocación.

La sesión de Flask es una cookie firmada: el servidor no guarda nada, solo
comprueba la firma. Eso basta para saber que el contenido no se ha manipulado,
pero deja fuera tres cosas que sí hacen falta:

* **Caducar.** Una sesión no permanente no lleva ningún `exp` dentro del payload
  firmado. El navegador borra la cookie al cerrarse, pero eso es una cortesía
  del cliente: una copia de la cookie —del disco del navegador, de un proxy, de
  un log— seguía siendo válida indefinidamente, y el servidor la aceptaba sin
  preguntar cuándo se emitió.
* **Revocar.** `session.clear()` en el logout vacía la cookie que se devuelve al
  navegador que la pidió. La copia que tuviera otro seguía funcionando: no había
  nada del lado del servidor que pudiera decir «esa ya no».
* **Cerrar todo.** Cambiar la contraseña no echaba a nadie. Si el motivo del
  cambio era justo que alguien más tenía acceso, el cambio no servía de nada.

Las tres se arreglan con lo mínimo: un identificador aleatorio por sesión, dos
marcas de tiempo dentro de la propia cookie, y un fichero pequeño en `data/` con
la lista de identificadores revocados y un contador de época.

**Por qué un fichero y no memoria.** Gunicorn levanta varios workers, y un dict
de módulo lo tendría cada uno por su cuenta: cerrar sesión en el worker A no la
cerraría en el B, que es exactamente el fallo que esto viene a corregir. Es el
mismo motivo por el que `atajo_acceso` guarda su estado en disco. Se acepta el
coste: son unos pocos cientos de bytes leídos por petición autenticada, sobre un
fichero que el sistema tiene en caché.

**Por qué una época y no revocar una a una.** Para «cierra todas las sesiones»
no hace falta conocerlas: basta con un número que se incrementa y que toda
sesión lleva grabado. Las que traigan un número viejo dejan de valer, sin
mantener una lista de sesiones activas que habría que ir podando.

**Qué pasa al actualizar.** Las cookies emitidas por la versión anterior no
llevan identificador ni marcas de tiempo, así que se rechazan y hay que volver a
entrar una vez. Es lo correcto: son precisamente las que no se pueden caducar.
"""

import json
import logging
import secrets
import time

from core import paths, settings
from core.bloqueo import BloqueoOcupado, exclusivo

log = logging.getLogger(__name__)

SESION_DIR = paths.DATA_DIR / "sesion"
ESTADO_FILE = SESION_DIR / "estado.json"
LOCK_FILE = SESION_DIR / "estado.lock"

# Claves dentro de la cookie de sesión.
SID = "sid"
EPOCA = "epoca"
CREADA = "creada"
VISTA = "vista"

# Cada cuánto se reescribe la marca de actividad. Sin este margen, *cada*
# petición modificaría la sesión y saldría con su Set-Cookie; con él, la cookie
# se reemite como mucho una vez por minuto y el timeout por inactividad sigue
# siendo igual de exacto (el error máximo es este valor).
REFRESCO_SEGUNDOS = 60

# Tope de identificadores revocados que se guardan. No debería acercarse nunca
# —cada uno es un logout, y caducan solos—, pero este fichero se lee en cada
# petición y no puede crecer sin fin si alguien automatiza logins y logouts.
MAX_REVOCADOS = 5000

# Cuánto se recuerda un identificador revocado cuando no hay caducidad absoluta
# configurada. Sin un límite, la lista solo podría crecer.
RETENCION_POR_DEFECTO = 30 * 24 * 3600


# ── Estado compartido ─────────────────────────────────────────────────────────

def _vacio() -> dict:
    return {"epoca": 0, "revocados": {}}


def leerEstado() -> dict:
    """Lo guardado, o el estado inicial si no hay fichero.

    Nunca lanza: esto se consulta en cada petición autenticada, y un fichero
    ilegible no puede tumbar la aplicación entera. Un JSON corrupto se lee como
    «sin revocaciones»: la alternativa —tratarlo como si todo estuviera
    revocado— dejaría al usuario sin poder entrar y sin forma de arreglarlo
    desde la interfaz, porque para llegar a Ajustes hace falta sesión. Las
    caducidades, que van dentro de la cookie, siguen aplicándose igual.
    """
    try:
        datos = json.loads(ESTADO_FILE.read_text("utf-8"))
    except FileNotFoundError:
        return _vacio()
    except (OSError, ValueError) as e:
        log.warning("[sesion] estado.json ilegible (%s); se sigue sin revocaciones", e)
        return _vacio()

    if not isinstance(datos, dict):
        return _vacio()

    revocados = datos.get("revocados")
    if not isinstance(revocados, dict):
        revocados = {}

    try:
        epoca = int(datos.get("epoca", 0))
    except (TypeError, ValueError):
        epoca = 0

    return {
        "epoca": epoca,
        "revocados": {str(k): float(v) for k, v in revocados.items()
                      if isinstance(v, (int, float))},
    }


def _guardarEstado(estado: dict) -> bool:
    """Escribe el estado de forma atómica. False si no se pudo.

    No propaga el fallo: que `data/` esté montado de solo lectura tiene que
    impedir revocar, no impedir cerrar sesión en el navegador. Lo que no se
    puede es callarlo, porque el usuario creería que ha echado a alguien.
    """
    try:
        SESION_DIR.mkdir(parents=True, exist_ok=True)
        tmp = ESTADO_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(estado, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(ESTADO_FILE)
        return True
    except OSError as e:
        log.error("[sesion] No se pudo guardar estado.json (%s): la revocación no persiste", e)
        return False


def _modificar(cambio) -> bool:
    """Aplica `cambio(estado)` bajo bloqueo entre procesos.

    Sin el bloqueo, dos workers que revoquen a la vez harían cada uno
    leer-modificar-escribir sobre su propia copia y el último borraría la
    revocación del otro.
    """
    try:
        with exclusivo(LOCK_FILE, espera=2.0, obligatorio=False):
            estado = leerEstado()
            cambio(estado)
            _podar(estado)
            return _guardarEstado(estado)
    except BloqueoOcupado:  # pragma: no cover - obligatorio=False no lo lanza
        return False


def _retencion() -> float:
    """Cuánto tiene sentido recordar un identificador revocado.

    Pasada la caducidad absoluta, la cookie ya no vale por sí sola y guardarla
    en la lista no aporta nada. Sin caducidad absoluta configurada se recurre a
    la de inactividad, y si tampoco la hay, a un plazo fijo.
    """
    return float(settings.sesionMaximaSegundos()
                 or settings.sesionInactividadSegundos()
                 or RETENCION_POR_DEFECTO)


def _podar(estado: dict) -> None:
    ahora = time.time()
    revocados = {k: v for k, v in estado["revocados"].items() if v > ahora}
    if len(revocados) > MAX_REVOCADOS:
        # Los que antes caducan son los que menos falta hacen: sus cookies son
        # las que más cerca están de dejar de valer por sí solas.
        sobrantes = sorted(revocados.items(), key=lambda par: par[1])[:-MAX_REVOCADOS]
        for clave, _ in sobrantes:
            revocados.pop(clave, None)
        log.warning("[sesion] Lista de revocados por encima de %d; se han descartado los más antiguos",
                    MAX_REVOCADOS)
    estado["revocados"] = revocados


# ── Operaciones ───────────────────────────────────────────────────────────────

def abrir(sesion) -> str:
    """Sella una sesión recién autenticada y devuelve su identificador.

    `secrets.token_urlsafe` y no `uuid4`: aunque uuid4 también sea aleatorio, su
    generador no está pensado para esto y su formato invita a tratarlo como un
    identificador cualquiera. 32 bytes de un generador criptográfico no admiten
    esa duda, y el valor es distinto en cada login aunque sea el mismo usuario.
    """
    ahora = time.time()
    sid = secrets.token_urlsafe(32)
    sesion[SID] = sid
    sesion[EPOCA] = leerEstado()["epoca"]
    sesion[CREADA] = ahora
    sesion[VISTA] = ahora
    return sid


def cerrar(sesion) -> None:
    """Revoca la sesión en el servidor antes de vaciarla en el cliente.

    El orden importa: hay que leer el identificador de la cookie mientras
    todavía está ahí. Vaciarla primero era justo lo que hacía que el logout no
    revocase nada.
    """
    sid = sesion.get(SID)
    if sid:
        hasta = time.time() + _retencion()
        _modificar(lambda estado: estado["revocados"].update({sid: hasta}))
    sesion.clear()


def invalidarTodas() -> None:
    """Cierra todas las sesiones abiertas, incluidas las de otros dispositivos.

    Se llama al cambiar las credenciales. La lista de revocados se vacía a la
    vez: con la época incrementada, ninguna de esas cookies vale ya, así que
    seguir guardándolas solo ocuparía sitio.
    """
    def cambio(estado):
        estado["epoca"] = int(estado["epoca"]) + 1
        estado["revocados"] = {}

    _modificar(cambio)
    log.info("[sesion] Todas las sesiones invalidadas")


def motivoInvalidez(sesion) -> str | None:
    """Por qué esta sesión ya no vale, o None si sigue siendo buena.

    Devuelve el motivo en vez de un booleano para poder registrarlo: «expiró por
    inactividad» y «la cookie estaba revocada» son incidentes muy distintos, y
    desde fuera los dos se ven igual (una redirección al login).
    """
    sid = sesion.get(SID)
    creada = sesion.get(CREADA)
    vista = sesion.get(VISTA)

    # Sesión emitida antes de que existiera este control: no se puede saber
    # cuándo se abrió, así que no se puede caducar. Se rechaza.
    if not sid or not isinstance(creada, (int, float)) or not isinstance(vista, (int, float)):
        return "sin identificador ni marcas de tiempo (versión anterior)"

    ahora = time.time()

    # Una marca en el futuro significa reloj cambiado o cookie manipulada. No es
    # manipulable sin la firma, pero un salto de hora del servidor sí puede
    # dejarla ahí, y entonces la sesión no caducaría nunca.
    if creada > ahora + 60 or vista > ahora + 60:
        return "marcas de tiempo en el futuro"

    inactividad = settings.sesionInactividadSegundos()
    if inactividad and ahora - vista > inactividad:
        return f"inactiva más de {inactividad}s"

    maxima = settings.sesionMaximaSegundos()
    if maxima and ahora - creada > maxima:
        return f"abierta hace más de {maxima}s"

    estado = leerEstado()

    if int(sesion.get(EPOCA, -1)) != estado["epoca"]:
        return "emitida antes del último cambio de credenciales"

    if sid in estado["revocados"]:
        return "revocada al cerrar sesión"

    return None


def refrescar(sesion) -> None:
    """Actualiza la marca de actividad, como mucho una vez por minuto."""
    ahora = time.time()
    vista = sesion.get(VISTA)
    if not isinstance(vista, (int, float)) or ahora - vista >= REFRESCO_SEGUNDOS:
        sesion[VISTA] = ahora


__all__ = [
    "CREADA", "EPOCA", "SID", "VISTA",
    "abrir", "cerrar", "invalidarTodas", "leerEstado", "motivoInvalidez", "refrescar",
]
