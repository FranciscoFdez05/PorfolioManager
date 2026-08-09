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
"""

import configparser
import logging
import os
import threading

from core.paths import BASE_DIR

log = logging.getLogger(__name__)

RUTA_CONFIG = BASE_DIR / "config.ini"

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

        parser = configparser.ConfigParser(inline_comment_prefixes=(";", "#"))
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


def obtenerTexto(seccion, opcion, defecto="", env=None):
    if env:
        valorEntorno = os.environ.get(env, "").strip()
        if valorEntorno:
            return valorEntorno

    valor = leerConfig().get(seccion, opcion, fallback=None)
    valor = "" if valor is None else valor.strip()

    return valor or defecto


def obtenerEntero(seccion, opcion, defecto, env=None, minimo=None, maximo=None):
    texto = obtenerTexto(seccion, opcion, "", env=env)

    try:
        valor = int(texto)
    except (TypeError, ValueError):
        if texto:
            log.warning("[config_ini] [%s] %s = %r no es un entero; se usa %s", seccion, opcion, texto, defecto)
        return defecto

    if minimo is not None and valor < minimo:
        log.warning("[config_ini] [%s] %s = %s por debajo del mínimo %s", seccion, opcion, valor, minimo)
        return minimo

    if maximo is not None and valor > maximo:
        log.warning("[config_ini] [%s] %s = %s por encima del máximo %s", seccion, opcion, valor, maximo)
        return maximo

    return valor


def obtenerBooleano(seccion, opcion, defecto, env=None):
    texto = obtenerTexto(seccion, opcion, "", env=env).lower()

    if texto in _VALORES_VERDADEROS:
        return True
    if texto in _VALORES_FALSOS:
        return False

    if texto:
        log.warning("[config_ini] [%s] %s = %r no es booleano; se usa %s", seccion, opcion, texto, defecto)

    return defecto


def obtenerLista(seccion, opcion, defecto=(), env=None, separador=","):
    """Lista de valores separados por coma, sin entradas vacías."""
    texto = obtenerTexto(seccion, opcion, "", env=env)

    if not texto:
        return list(defecto)

    return [fragmento.strip() for fragmento in texto.split(separador) if fragmento.strip()]
