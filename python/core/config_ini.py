"""Lectura de config.ini, en un único sitio.

Los ajustes del proyecto viven en config.ini, no repartidos como constantes por
el código: cambiar un rango de red o una tolerancia no debe obligar a tocar un
.py ni a reconstruir la imagen de Docker.

Prioridad de resolución, de mayor a menor:

  1. Variable de entorno, si el ajuste declara una (override puntual, útil en
     Docker y en los tests).
  2. Valor en config.ini.
  3. Valor por defecto que pasa quien llama.

El fichero se relee cuando cambia su mtime, así que editar config.ini con el
servidor arrancado surte efecto sin reiniciar.

Aquí NO van secretos: config.ini está versionado en git. Las claves se guardan
en API/*.key (ignorado por git y cifrado en reposo por core/secret_store.py).

Este módulo es deliberadamente el más básico de core/: no importa nada del
proyecto. `core.paths` sí lee de aquí (la sección [rutas]), y depender de él
crearía un ciclo de importación cuyo resultado dependería de qué módulo se
importase primero. Por eso la raíz se calcula abajo en vez de reutilizar
`paths.BASE_DIR`.
"""

import configparser
import logging
import os
import threading
from pathlib import Path

log = logging.getLogger(__name__)

# python/core/config_ini.py → python/core → python → raíz del proyecto.
# Es el mismo cálculo que hace core.paths; ver la nota del docstring.
_RAIZ = Path(__file__).resolve().parents[2]


def _rutaConfigInicial():
    """Ruta del config.ini a usar.

    PORTFOLIO_CONFIG permite apuntar a otro fichero sin mover el proyecto: es
    lo que necesitan un despliegue con el config montado fuera del código y los
    tests, que no deben leer el config.ini real del repositorio.
    """
    personalizada = os.environ.get("PORTFOLIO_CONFIG", "").strip()
    return Path(personalizada).expanduser() if personalizada else _RAIZ / "config.ini"


RUTA_CONFIG = _rutaConfigInicial()

_lock = threading.Lock()
_cache = None
_cacheMtime = None

_VALORES_VERDADEROS = {"1", "true", "yes", "on", "si", "sí"}
_VALORES_FALSOS = {"0", "false", "no", "off"}


def leerConfig():
    """ConfigParser del fichero, releído solo si el fichero ha cambiado."""
    global _cache, _cacheMtime

    try:
        mtime = RUTA_CONFIG.stat().st_mtime
    except OSError:
        # Sin config.ini todo funciona con los valores por defecto de cada
        # llamada: el fichero es opcional, no un requisito de arranque.
        mtime = None

    with _lock:
        if _cache is not None and mtime == _cacheMtime:
            return _cache

        # interpolation=None: los valores se toman literales. Con la
        # interpolación por defecto, un formato de log como
        # "%(asctime)s [%(levelname)s]" reventaba al leerlo (configparser busca
        # una opción llamada "asctime") y obligaba a escribir "%%" en el .ini,
        # que es justo el detalle que nadie recuerda.
        parser = configparser.ConfigParser(
            inline_comment_prefixes=(";", "#"),
            interpolation=None,
        )
        if mtime is not None:
            try:
                parser.read(RUTA_CONFIG, encoding="utf-8")
            except (OSError, configparser.Error) as error:
                log.error("[config_ini] No se pudo leer config.ini: %s", error)

        _cache = parser
        _cacheMtime = mtime
        return parser


def invalidarCache():
    """Fuerza la relectura en la próxima consulta (lo usan los tests)."""
    global _cache, _cacheMtime
    with _lock:
        _cache = None
        _cacheMtime = None


def estaDefinida(seccion, opcion, env=None):
    """¿La opción aparece escrita, aunque sea vacía?

    Distinguir "no está" de "está y está vacía" importa en los ajustes donde
    vaciar es una decisión: dejar `redes_permitidas =` significa «no aceptes a
    nadie», y devolver ahí el valor por defecto reabriría precisamente los
    rangos que el usuario acaba de quitar.
    """
    if env and env in os.environ:
        return True

    return leerConfig().has_option(seccion, opcion)


def obtenerTexto(seccion, opcion, defecto="", env=None):
    if env:
        valorEntorno = os.environ.get(env, "").strip()
        if valorEntorno:
            return valorEntorno

    valor = leerConfig().get(seccion, opcion, fallback=None)
    valor = "" if valor is None else valor.strip()

    return valor or defecto


def _acotar(seccion, opcion, valor, minimo, maximo):
    """Recorta el valor al rango permitido, avisando en el log si no cabía.

    Se recorta en vez de rechazar: un ajuste fuera de rango es casi siempre un
    despiste (un 0 donde iba un 60), y arrancar con el extremo más cercano es
    más útil que tumbar el servidor o quedarse con un valor peligroso.
    """
    if minimo is not None and valor < minimo:
        log.warning("[config_ini] [%s] %s = %s por debajo del mínimo %s", seccion, opcion, valor, minimo)
        return minimo

    if maximo is not None and valor > maximo:
        log.warning("[config_ini] [%s] %s = %s por encima del máximo %s", seccion, opcion, valor, maximo)
        return maximo

    return valor


def obtenerEntero(seccion, opcion, defecto, env=None, minimo=None, maximo=None):
    texto = obtenerTexto(seccion, opcion, "", env=env)

    try:
        valor = int(texto)
    except (TypeError, ValueError):
        if texto:
            log.warning("[config_ini] [%s] %s = %r no es un entero; se usa %s", seccion, opcion, texto, defecto)
        return defecto

    return _acotar(seccion, opcion, valor, minimo, maximo)


def obtenerDecimal(seccion, opcion, defecto, env=None, minimo=None, maximo=None):
    """Igual que obtenerEntero pero para valores con decimales (segundos de
    backoff, factores de espera…). Acepta coma o punto como separador."""
    texto = obtenerTexto(seccion, opcion, "", env=env).replace(",", ".")

    try:
        valor = float(texto)
    except (TypeError, ValueError):
        if texto:
            log.warning("[config_ini] [%s] %s = %r no es un número; se usa %s", seccion, opcion, texto, defecto)
        return defecto

    if valor != valor or valor in (float("inf"), float("-inf")):
        log.warning("[config_ini] [%s] %s = %r no es un número finito; se usa %s", seccion, opcion, texto, defecto)
        return defecto

    return _acotar(seccion, opcion, valor, minimo, maximo)


def obtenerBooleano(seccion, opcion, defecto, env=None):
    texto = obtenerTexto(seccion, opcion, "", env=env).lower()

    if texto in _VALORES_VERDADEROS:
        return True
    if texto in _VALORES_FALSOS:
        return False

    if texto:
        log.warning("[config_ini] [%s] %s = %r no es booleano; se usa %s", seccion, opcion, texto, defecto)

    return defecto


def obtenerOpcion(seccion, opcion, defecto, permitidos, env=None):
    """Valor restringido a un conjunto cerrado (nivel de log, SameSite…).

    La comparación ignora mayúsculas y devuelve el valor tal y como aparece en
    `permitidos`, para que quien llama no tenga que volver a normalizarlo.
    """
    texto = obtenerTexto(seccion, opcion, "", env=env)

    if not texto:
        return defecto

    for permitido in permitidos:
        if texto.lower() == str(permitido).lower():
            return permitido

    log.warning(
        "[config_ini] [%s] %s = %r no está entre %s; se usa %s",
        seccion, opcion, texto, ", ".join(str(p) for p in permitidos), defecto,
    )
    return defecto


def esBooleanoValido(texto):
    """¿Este texto se reconoce como booleano? Lo usa la validación de arranque."""
    normalizado = str(texto or "").strip().lower()
    return normalizado in _VALORES_VERDADEROS or normalizado in _VALORES_FALSOS


def obtenerLista(seccion, opcion, defecto=(), env=None, separador=",", vaciarEsExplicito=False):
    """Lista de valores separados por coma, sin entradas vacías.

    Con `vaciarEsExplicito`, una opción escrita pero vacía devuelve la lista
    vacía en vez del valor por defecto: es lo que hace falta en las listas
    donde vaciar significa "ninguno" y no "los de siempre" (ver estaDefinida).
    """
    texto = obtenerTexto(seccion, opcion, "", env=env)

    if not texto:
        if vaciarEsExplicito and estaDefinida(seccion, opcion, env=env):
            return []
        return list(defecto)

    return [fragmento.strip() for fragmento in texto.split(separador) if fragmento.strip()]
