"""Catálogo único de los ajustes operativos del proyecto.

`core.config_ini` sabe *leer* un fichero .ini; este módulo declara *qué* ajustes
existen. Cada uno se define una sola vez con su tipo, su valor por defecto, su
rango válido y la variable de entorno que lo puede sobrescribir, en vez de
repartir esos datos por constantes de módulo (`_MAX_ATTEMPTS = 8`,
`MAX_BACKUPS = 14`, `timeout=10`…) que había que buscar por todo el código.

Ventajas de tenerlo en una tabla y no en constantes sueltas:

* Añadir un ajuste es una línea, y queda documentado, validado y expuesto en el
  diagnóstico sin tocar nada más.
* `validar()` detecta al arrancar los valores fuera de rango o mal escritos, en
  vez de que aparezcan como un comportamiento raro semanas después.
* `diagnostico()` permite ver la configuración efectiva —con su origen— sin
  entrar por SSH a comparar config.ini con las variables de entorno.

Prioridad de resolución (la de `config_ini`): entorno → config.ini → defecto.

Lo que NO va aquí:

* **Secretos** (claves de API, SECRET_KEY, hashes): config.ini está versionado.
  Van en .env o en API/*.key, cifrados en reposo por `core.secret_store`.
* **Preferencias de usuario** (tema, decimales, moneda base…): son datos de la
  aplicación, se editan desde Ajustes y viven en data/JSON/ajustes.json.
* **Constantes de dominio** (tipos de activo válidos, URLs de los proveedores,
  expresiones regulares de validación): no son ajustes de despliegue. Cambiar
  la URL de un proveedor sin cambiar el parseo de su respuesta no funcionaría,
  así que exponerlas sería ofrecer una palanca rota.
"""

import logging
import os
from dataclasses import dataclass, field
from typing import Any

from core import config_ini

log = logging.getLogger(__name__)

TEXTO = "texto"
ENTERO = "entero"
DECIMAL = "decimal"
BOOLEANO = "booleano"
LISTA = "lista"
OPCION = "opcion"


@dataclass(frozen=True)
class Ajuste:
    """Declaración de un ajuste: dónde vive, qué valores admite y qué significa."""

    seccion: str
    opcion: str
    tipo: str
    defecto: Any
    descripcion: str
    env: str | None = None
    minimo: Any = None
    maximo: Any = None
    permitidos: tuple = field(default_factory=tuple)
    # Solo para listas: si la opción está escrita pero vacía, ¿vale la lista
    # vacía en vez del valor por defecto? Ver config_ini.obtenerLista.
    vaciarEsExplicito: bool = False

    @property
    def nombre(self) -> str:
        return f"{self.seccion}.{self.opcion}"

    def leer(self):
        """Valor efectivo ahora mismo, releyendo config.ini si ha cambiado."""
        if self.tipo == TEXTO:
            return config_ini.obtenerTexto(self.seccion, self.opcion, self.defecto, env=self.env)
        if self.tipo == ENTERO:
            return config_ini.obtenerEntero(
                self.seccion, self.opcion, self.defecto,
                env=self.env, minimo=self.minimo, maximo=self.maximo,
            )
        if self.tipo == DECIMAL:
            return config_ini.obtenerDecimal(
                self.seccion, self.opcion, self.defecto,
                env=self.env, minimo=self.minimo, maximo=self.maximo,
            )
        if self.tipo == BOOLEANO:
            return config_ini.obtenerBooleano(self.seccion, self.opcion, self.defecto, env=self.env)
        if self.tipo == LISTA:
            return config_ini.obtenerLista(
                self.seccion, self.opcion, self.defecto,
                env=self.env, vaciarEsExplicito=self.vaciarEsExplicito,
            )
        if self.tipo == OPCION:
            return config_ini.obtenerOpcion(
                self.seccion, self.opcion, self.defecto, self.permitidos, env=self.env,
            )
        raise ValueError(f"Tipo de ajuste desconocido: {self.tipo!r}")


# ── Catálogo ──────────────────────────────────────────────────────────────────
# Orden y nombres de sección coinciden con los de config.ini, para poder leer
# los dos ficheros en paralelo.

CATALOGO: tuple[Ajuste, ...] = (
    # [server] — el nombre de la sección se mantiene en inglés porque
    # docker-up.sh ya lee de ahí el puerto para el mapeo del contenedor.
    Ajuste("server", "host", TEXTO, "0.0.0.0", env="HOST",
           descripcion="Interfaz en la que escucha el servidor de desarrollo."),
    Ajuste("server", "port", ENTERO, 5000, env="PORT", minimo=1, maximo=65535,
           descripcion="Puerto HTTP. Fuente de verdad del proyecto: docker-up.sh lo lee de aquí."),
    Ajuste("server", "debug", BOOLEANO, False, env="FLASK_DEBUG",
           descripcion="Modo debug de Flask. Nunca en producción: expone la consola de depuración."),
    Ajuste("server", "https_activado", BOOLEANO, False, env="HTTPS_ENABLED",
           descripcion="Marca las cookies como Secure. Solo con HTTPS delante, o no habrá sesión."),
    Ajuste("server", "cookie_samesite", OPCION, "Lax", env="COOKIE_SAMESITE",
           permitidos=("Lax", "Strict", "None"),
           descripcion="SameSite de la cookie de sesión. 'None' exige https_activado."),
    Ajuste("server", "proxy_saltos", ENTERO, 0, env="PROXY_FIX_HOPS", minimo=0, maximo=10,
           descripcion="Proxies inversos de confianza delante. 0 = ninguno; con Caddy, 1."),
    Ajuste("server", "max_cuerpo_mb", ENTERO, 5, env="MAX_CUERPO_MB", minimo=1, maximo=1024,
           descripcion="Tamaño máximo de una petición normal, en MB."),
    Ajuste("server", "max_subida_mb", ENTERO, 256, env="MAX_SUBIDA_MB", minimo=1, maximo=4096,
           descripcion="Tamaño máximo en los endpoints de importación/restauración, en MB."),

    # [gunicorn] — los lee entrypoint.sh, no el código Python.
    Ajuste("gunicorn", "workers", ENTERO, 2, env="GUNICORN_WORKERS", minimo=1, maximo=64,
           descripcion="Procesos worker de Gunicorn en el contenedor."),
    Ajuste("gunicorn", "threads", ENTERO, 4, env="GUNICORN_THREADS", minimo=1, maximo=256,
           descripcion="Hilos por worker."),
    Ajuste("gunicorn", "timeout", ENTERO, 120, env="GUNICORN_TIMEOUT", minimo=5, maximo=3600,
           descripcion="Segundos antes de que Gunicorn mate un worker atascado."),
    Ajuste("gunicorn", "keep_alive", ENTERO, 5, env="GUNICORN_KEEP_ALIVE", minimo=0, maximo=300,
           descripcion="Segundos que se mantiene abierta una conexión ociosa."),

    # [registros]
    Ajuste("registros", "nivel", OPCION, "INFO", env="LOG_NIVEL",
           permitidos=("CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"),
           descripcion="Nivel mínimo que se escribe en el log."),
    Ajuste("registros", "formato", TEXTO, "%(asctime)s [%(levelname)s] %(name)s - %(message)s",
           env="LOG_FORMATO",
           descripcion="Formato de cada línea de log (estilo %% de logging)."),

    # [seguridad]
    Ajuste("seguridad", "max_intentos_login", ENTERO, 8, env="MAX_INTENTOS_LOGIN", minimo=1, maximo=1000,
           descripcion="Intentos fallidos por IP antes de bloquear el login."),
    Ajuste("seguridad", "bloqueo_segundos", ENTERO, 300, env="BLOQUEO_SEGUNDOS", minimo=1, maximo=86400,
           descripcion="Duración del bloqueo tras agotar los intentos."),
    Ajuste("seguridad", "max_ips_vigiladas", ENTERO, 1000, env="MAX_IPS_VIGILADAS", minimo=10, maximo=1_000_000,
           descripcion="Tope del registro de intentos en memoria; evita crecer sin fin con IPs falsificadas."),
    Ajuste("seguridad", "hash_iteraciones", ENTERO, 600_000, env="HASH_ITERACIONES",
           minimo=100_000, maximo=10_000_000,
           descripcion="Iteraciones PBKDF2-SHA256 de la contraseña de acceso."),
    Ajuste("seguridad", "escrituras_por_minuto", ENTERO, 120, env="ESCRITURAS_POR_MINUTO",
           minimo=0, maximo=100_000,
           descripcion="Peticiones de escritura (POST/PUT/PATCH/DELETE) por IP y minuto. 0 desactiva el límite."),
    Ajuste("seguridad", "escrituras_pesadas_por_hora", ENTERO, 30, env="ESCRITURAS_PESADAS_POR_HORA",
           minimo=0, maximo=100_000,
           descripcion="Tope por IP y hora de backup/restore/importación, que copian bases enteras. 0 lo desactiva."),
    Ajuste("seguridad", "csp_activada", BOOLEANO, True, env="CSP_ACTIVADA",
           descripcion="Envía la cabecera Content-Security-Policy. Desactívalo solo para depurar."),
    Ajuste("seguridad", "csp_origenes_scripts", LISTA, (),
           env="CSP_ORIGENES_SCRIPTS", vaciarEsExplicito=True,
           descripcion="Orígenes externos permitidos en script-src. Vacío: Chart.js se sirve desde js/vendor/."),

    # [atajo] — endpoints del Atajo de iOS
    Ajuste("atajo", "activado", BOOLEANO, True, env="MOVIMIENTOS_ACTIVADO",
           descripcion="Con false, los endpoints del Atajo responden 404 como si no existieran."),
    Ajuste("atajo", "redes_permitidas", LISTA, ("192.168.1.0/24", "10.0.0.0/24"),
           env="MOVIMIENTOS_REDES_PERMITIDAS", vaciarEsExplicito=True,
           descripcion="Redes CIDR aceptadas. Vacío no significa 'todas': no se acepta a nadie."),
    Ajuste("atajo", "tolerancia_segundos", ENTERO, 60, env="MOVIMIENTOS_TOLERANCIA_SEGUNDOS",
           minimo=1, maximo=3600,
           descripcion="Desfase máximo admitido entre X-Timestamp y el reloj del servidor."),
    Ajuste("atajo", "max_texto_firma", ENTERO, 8192, env="MOVIMIENTOS_MAX_TEXTO_FIRMA",
           minimo=1, maximo=1_048_576,
           descripcion="Caracteres que /api/firmar acepta firmar de una vez."),
    Ajuste("atajo", "fichero_clave", TEXTO, "API/movimientos.key", env="MOVIMIENTOS_FICHERO_CLAVE",
           descripcion="Fichero con la clave HMAC, relativo a la raíz. La clave nunca va en config.ini."),

    # [backups]
    Ajuste("backups", "max_copias", ENTERO, 14, env="BACKUPS_MAX_COPIAS", minimo=1, maximo=3650,
           descripcion="Backups diarios que se conservan por portfolio antes de rotar."),
    Ajuste("backups", "sqlite_timeout_segundos", ENTERO, 15, env="BACKUPS_SQLITE_TIMEOUT",
           minimo=1, maximo=600,
           descripcion="Espera máxima por el lock de SQLite al copiar o reparar una BD."),

    # [base_datos]
    Ajuste("base_datos", "timeout_segundos", ENTERO, 10, env="DB_TIMEOUT", minimo=1, maximo=600,
           descripcion="Espera de sqlite3.connect por el lock del fichero."),
    Ajuste("base_datos", "busy_timeout_ms", ENTERO, 5000, env="DB_BUSY_TIMEOUT_MS", minimo=0, maximo=600_000,
           descripcion="PRAGMA busy_timeout: milisegundos que SQLite reintenta antes de dar 'database is locked'."),

    # [mercado]
    Ajuste("mercado", "historico_ttl_segundos", ENTERO, 4 * 3600, env="MERCADO_HISTORICO_TTL",
           minimo=0, maximo=30 * 24 * 3600,
           descripcion="Vida de la caché del histórico de precios. 0 desactiva la caché."),
    Ajuste("mercado", "max_peticiones_paralelas", ENTERO, 6, env="MERCADO_MAX_PARALELAS", minimo=1, maximo=64,
           descripcion="Cotizaciones que se piden a la vez. Subirlo agota antes la cuota del proveedor."),
    Ajuste("mercado", "snapshot_intervalo_minimo_segundos", ENTERO, 60, env="MERCADO_SNAPSHOT_MIN",
           minimo=1, maximo=86400,
           descripcion="Suelo del intervalo entre snapshots, por debajo de lo que pida Ajustes."),
    Ajuste("mercado", "snapshot_servidor", BOOLEANO, True, env="MERCADO_SNAPSHOT_SERVIDOR",
           descripcion="Hilo que guarda snapshots sin navegador abierto. Al apagarlo, el histórico "
                       "vuelve a depender de que la web esté abierta."),
    Ajuste("mercado", "snapshot_servidor_gracia_segundos", ENTERO, 120,
           env="MERCADO_SNAPSHOT_GRACIA", minimo=0, maximo=3600,
           descripcion="Margen que espera ese hilo tras cada hueco horario para que, si hay una "
                       "pestaña abierta, guarde ella el punto y no se pidan las cotizaciones dos veces."),

    # [proveedores]
    Ajuste("proveedores", "timeout_segundos", DECIMAL, 10.0, env="PROVEEDORES_TIMEOUT",
           minimo=1.0, maximo=300.0,
           descripcion="Timeout por intento de las llamadas a las APIs de mercado."),
    Ajuste("proveedores", "reintentos", ENTERO, 2, env="PROVEEDORES_REINTENTOS", minimo=0, maximo=10,
           descripcion="Reintentos tras un fallo transitorio (timeout, 5xx, 429)."),
    Ajuste("proveedores", "backoff_inicial_segundos", DECIMAL, 0.4, env="PROVEEDORES_BACKOFF",
           minimo=0.0, maximo=60.0,
           descripcion="Base de la espera exponencial entre reintentos."),
    Ajuste("proveedores", "backoff_maximo_segundos", DECIMAL, 4.0, env="PROVEEDORES_BACKOFF_MAX",
           minimo=0.0, maximo=300.0,
           descripcion="Techo de esa espera."),
    Ajuste("proveedores", "max_retry_after_segundos", DECIMAL, 5.0, env="PROVEEDORES_MAX_RETRY_AFTER",
           minimo=0.0, maximo=300.0,
           descripcion="Tope al Retry-After del proveedor: hay un usuario esperando delante."),
    Ajuste("proveedores", "max_respuesta_mb", ENTERO, 8, env="PROVEEDORES_MAX_RESPUESTA_MB",
           minimo=1, maximo=512,
           descripcion="Tamaño máximo de una respuesta. Protege la memoria del proceso."),
    Ajuste("proveedores", "user_agent", TEXTO, "PortfolioPython/1.0", env="PROVEEDORES_USER_AGENT",
           descripcion="Cabecera User-Agent con la que se identifica el cliente."),

    # [rutas] — las lee core.paths. Relativas a la raíz del proyecto, o
    # absolutas si se quiere sacar los datos fuera del directorio del código.
    Ajuste("rutas", "datos", TEXTO, "data", env="PORTFOLIO_DATA_DIR",
           descripcion="Directorio de bases de datos, JSON de configuración y backups."),
    Ajuste("rutas", "logs", TEXTO, "logs", env="PORTFOLIO_LOGS_DIR",
           descripcion="Directorio de logs."),
    Ajuste("rutas", "claves", TEXTO, "API", env="PORTFOLIO_API_DIR",
           descripcion="Directorio de las claves de API cifradas."),
)

_POR_NOMBRE = {ajuste.nombre: ajuste for ajuste in CATALOGO}

if len(_POR_NOMBRE) != len(CATALOGO):
    raise RuntimeError("Hay ajustes duplicados en CATALOGO")


def declaracion(nombre: str) -> Ajuste:
    """Declaración de un ajuste por su nombre 'seccion.opcion'."""
    try:
        return _POR_NOMBRE[nombre]
    except KeyError:
        raise KeyError(f"Ajuste no declarado: {nombre!r}. Añádelo a CATALOGO.") from None


def obtener(nombre: str):
    """Valor efectivo de un ajuste. Se resuelve en cada llamada.

    No se cachea a propósito: `config_ini` ya evita releer el fichero mientras
    no cambie su mtime, y resolver en vivo es lo que permite editar config.ini
    con el servidor arrancado.
    """
    return declaracion(nombre).leer()


# ── Accesos con nombre ────────────────────────────────────────────────────────
# Se prefieren a obtener("...") en el resto del código: una errata en la cadena
# es un fallo en tiempo de ejecución, mientras que una en el nombre de la
# función la ve el linter.

def host() -> str:
    return obtener("server.host")


def puerto() -> int:
    return obtener("server.port")


def modoDebug() -> bool:
    return obtener("server.debug")


def httpsActivado() -> bool:
    return obtener("server.https_activado")


def cookieSameSite() -> str:
    """SameSite de la cookie de sesión, degradado si la combinación no es válida.

    SameSite=None solo lo aceptan los navegadores junto a Secure; sin HTTPS
    delante, dejarlo tal cual haría que el navegador descartase la cookie y
    nadie pudiera iniciar sesión.
    """
    valor = obtener("server.cookie_samesite")

    if valor == "None" and not httpsActivado():
        log.warning(
            "[settings] cookie_samesite = None exige https_activado = true; se usa Lax."
        )
        return "Lax"

    return valor


def proxySaltos() -> int:
    """Cuántos proxies inversos de confianza hay delante de la aplicación.

    Es el número de saltos que ProxyFix debe descontar de las cabeceras
    `X-Forwarded-*`. Con 0 (el defecto, sin proxy) el middleware no se instala y
    esas cabeceras se ignoran, que es lo correcto cuando cualquiera puede
    inventárselas conectando directamente al puerto de gunicorn.
    """
    return obtener("server.proxy_saltos")


def maxCuerpoBytes() -> int:
    return obtener("server.max_cuerpo_mb") * 1024 * 1024


def maxSubidaBytes() -> int:
    return obtener("server.max_subida_mb") * 1024 * 1024


def nivelLog() -> str:
    return obtener("registros.nivel")


def formatoLog() -> str:
    return obtener("registros.formato")


def maxIntentosLogin() -> int:
    return obtener("seguridad.max_intentos_login")


def bloqueoSegundos() -> int:
    return obtener("seguridad.bloqueo_segundos")


def maxIpsVigiladas() -> int:
    return obtener("seguridad.max_ips_vigiladas")


def metodoHashPassword() -> str:
    """Cadena `method` de werkzeug para hashear la contraseña de acceso."""
    return f"pbkdf2:sha256:{obtener('seguridad.hash_iteraciones')}"


def escriturasPorMinuto() -> int:
    return obtener("seguridad.escrituras_por_minuto")


def escriturasPesadasPorHora() -> int:
    return obtener("seguridad.escrituras_pesadas_por_hora")


def cspActivada() -> bool:
    return obtener("seguridad.csp_activada")


def cspOrigenesScripts() -> list:
    return obtener("seguridad.csp_origenes_scripts")


def maxCopiasBackup() -> int:
    return obtener("backups.max_copias")


def backupSqliteTimeout() -> int:
    return obtener("backups.sqlite_timeout_segundos")


def dbTimeout() -> int:
    return obtener("base_datos.timeout_segundos")


def dbBusyTimeoutMs() -> int:
    return obtener("base_datos.busy_timeout_ms")


def historicoTtlSegundos() -> int:
    return obtener("mercado.historico_ttl_segundos")


def maxPeticionesParalelas() -> int:
    return obtener("mercado.max_peticiones_paralelas")


def snapshotIntervaloMinimo() -> int:
    return obtener("mercado.snapshot_intervalo_minimo_segundos")


def snapshotServidorActivo() -> bool:
    return obtener("mercado.snapshot_servidor")


def snapshotServidorGracia() -> int:
    return obtener("mercado.snapshot_servidor_gracia_segundos")


def proveedorTimeout() -> float:
    return obtener("proveedores.timeout_segundos")


def proveedorReintentos() -> int:
    return obtener("proveedores.reintentos")


def proveedorBackoffInicial() -> float:
    return obtener("proveedores.backoff_inicial_segundos")


def proveedorBackoffMaximo() -> float:
    return obtener("proveedores.backoff_maximo_segundos")


def proveedorMaxRetryAfter() -> float:
    return obtener("proveedores.max_retry_after_segundos")


def proveedorMaxRespuestaBytes() -> int:
    return obtener("proveedores.max_respuesta_mb") * 1024 * 1024


def proveedorUserAgent() -> str:
    return obtener("proveedores.user_agent")


# ── Diagnóstico y validación ──────────────────────────────────────────────────

def _origen(ajuste: Ajuste) -> str:
    """De dónde sale el valor efectivo: entorno, config.ini o el defecto."""
    if ajuste.env and os.environ.get(ajuste.env, "").strip():
        return "entorno"

    if config_ini.leerConfig().get(ajuste.seccion, ajuste.opcion, fallback="").strip():
        return "config.ini"

    return "defecto"


def diagnostico(incluirDescripcion: bool = False) -> list[dict]:
    """Configuración efectiva completa, con el origen de cada valor.

    Aquí no hay nada sensible: el catálogo no admite secretos (ver el docstring
    del módulo), así que se puede volcar al log o exponer en Ajustes sin filtrar
    claves. `atajo.fichero_clave` es una ruta, no la clave.
    """
    filas = []

    for ajuste in CATALOGO:
        fila = {
            "nombre": ajuste.nombre,
            "valor": ajuste.leer(),
            "defecto": list(ajuste.defecto) if ajuste.tipo == LISTA else ajuste.defecto,
            "origen": _origen(ajuste),
        }
        if incluirDescripcion:
            fila["descripcion"] = ajuste.descripcion
        filas.append(fila)

    return filas


def validar() -> list[str]:
    """Revisa la configuración entera y devuelve los avisos encontrados.

    Se llama al arrancar. Devuelve la lista en vez de lanzar para que un ajuste
    dudoso no impida arrancar: `config_ini` ya recorta al rango válido, así que
    la app siempre tiene un valor con el que funcionar y el aviso solo sirve
    para que el problema se vea en el log.
    """
    avisos = []

    for ajuste in CATALOGO:
        crudo = config_ini.leerConfig().get(ajuste.seccion, ajuste.opcion, fallback=None)

        if crudo is None or not crudo.strip():
            continue

        # Con un override por entorno, el valor efectivo no sale del fichero:
        # compararlo con lo escrito en config.ini daría un aviso inventado
        # ("port = 5000 fuera de rango" cuando el efectivo es el 5099 del
        # entorno). El valor del entorno lo valida config_ini al resolverlo.
        if _origen(ajuste) == "entorno":
            continue

        valor = ajuste.leer()

        # Un valor que no sobrevive tal cual a su propia declaración es un
        # error de escritura ("abc" donde iba un número) o está fuera de rango.
        if ajuste.tipo in (ENTERO, DECIMAL):
            try:
                original = float(crudo.strip().replace(",", "."))
            except ValueError:
                avisos.append(f"[{ajuste.seccion}] {ajuste.opcion} = {crudo.strip()!r} no es un número; se usa {valor}")
                continue
            if float(valor) != original:
                avisos.append(
                    f"[{ajuste.seccion}] {ajuste.opcion} = {crudo.strip()} fuera del rango "
                    f"[{ajuste.minimo}, {ajuste.maximo}]; se usa {valor}"
                )

        elif ajuste.tipo == OPCION and crudo.strip().lower() not in {str(p).lower() for p in ajuste.permitidos}:
            avisos.append(
                f"[{ajuste.seccion}] {ajuste.opcion} = {crudo.strip()!r} no está entre "
                f"{', '.join(str(p) for p in ajuste.permitidos)}; se usa {valor}"
            )

        elif ajuste.tipo == BOOLEANO and not config_ini.esBooleanoValido(crudo):
            avisos.append(f"[{ajuste.seccion}] {ajuste.opcion} = {crudo.strip()!r} no es booleano; se usa {valor}")

    # Comprobaciones que cruzan varios ajustes: cada uno es válido por separado,
    # pero la combinación no funciona.
    if obtener("server.max_subida_mb") < obtener("server.max_cuerpo_mb"):
        avisos.append(
            "[server] max_subida_mb es menor que max_cuerpo_mb: las importaciones "
            "quedarían más limitadas que una petición normal"
        )

    if obtener("proveedores.backoff_maximo_segundos") < obtener("proveedores.backoff_inicial_segundos"):
        avisos.append("[proveedores] backoff_maximo_segundos es menor que backoff_inicial_segundos")

    if obtener("atajo.activado") and not obtener("atajo.redes_permitidas"):
        avisos.append("[atajo] activado = true sin redes_permitidas: se rechazarán todas las peticiones")

    if obtener("server.debug"):
        avisos.append("[server] debug = true: no lo dejes activado en producción")

    # ── TLS y proxy inverso ───────────────────────────────────────────────────
    # La aplicación nunca termina TLS por sí misma: si hay HTTPS, lo pone un
    # proxy delante. De ahí que estos dos ajustes casi siempre vayan juntos y
    # que cada combinación suelta signifique un despliegue a medio configurar.
    https = obtener("server.https_activado")
    saltos = obtener("server.proxy_saltos")

    if https and not saltos:
        avisos.append(
            "[server] https_activado = true con proxy_saltos = 0: el TLS lo termina "
            "un proxy, así que sin proxy_saltos la IP registrada en el log, en el "
            "límite de escrituras y en el bloqueo de login será la del proxy para "
            "todas las peticiones"
        )

    if saltos and not https:
        avisos.append(
            "[server] proxy_saltos > 0 con https_activado = false: la cookie de "
            "sesión sale sin Secure, así que puede acabar viajando en claro"
        )

    return avisos


def registrarConfiguracion() -> None:
    """Vuelca al log los avisos y los ajustes cuyo valor no es el de fábrica.

    Cuando algo va raro en el servidor, la primera pregunta es «¿con qué
    configuración está corriendo esto?». Dejarlo escrito al arrancar la
    responde sin tener que reconstruirla a mano entre config.ini y el entorno.

    Se filtra por valor y no por origen a propósito: config.ini trae escritas
    todas las opciones para que sirvan de documentación, así que listar "lo que
    no viene del defecto" imprimiría el catálogo entero y no se leería.
    """
    for aviso in validar():
        log.warning("[config] %s", aviso)

    modificados = [
        fila for fila in diagnostico()
        if fila["valor"] != fila["defecto"]
    ]

    if not modificados:
        log.info("[config] %d ajustes, todos en su valor por defecto", len(CATALOGO))
        return

    log.info(
        "[config] %d ajustes; fuera del valor por defecto: %s",
        len(CATALOGO),
        ", ".join(f"{fila['nombre']}={fila['valor']} ({fila['origen']})" for fila in modificados),
    )
