"""Registro interno: copia en archivo de lo que cada proceso escribe en su log.

En Docker la salida de cada contenedor solo se ve con ``docker logs``. Aquí cada
proceso (web, worker) escribe además las mismas líneas en ``logs/<proceso>.log``,
carpeta que web y worker comparten como volumen, para poder leerlas desde
Ajustes sin montar el socket de Docker en la web.

Los errores del navegador (``recuperacion.js``) llegan por ``/api/registro/cliente``
y se escriben con el logger ``cliente`` en el archivo de la web.

Limitación conocida: con varios workers de gunicorn escribiendo en el mismo
archivo, la rotación puede perder alguna línea justo en el instante de rotar.
Es un log de diagnóstico, no una auditoría.
"""

import logging
import os
import time
from collections import deque
from logging.handlers import RotatingFileHandler
from pathlib import Path

from core import settings
from core.paths import LOGS_DIR

log = logging.getLogger(__name__)

MAX_BYTES = 2 * 1024 * 1024
COPIAS_ROTADAS = 3
MAX_LINEAS_LECTURA = 1000
LINEAS_POR_DEFECTO = 300
PROCESOS_CONOCIDOS = ("web", "worker")
# Los errores del navegador pueden repetirse en bucle: se acotan para no llenar el archivo.
MAX_ERRORES_CLIENTE_POR_MINUTO = 30
MAX_CAMPO_CLIENTE = 2000

_NIVELES = {"CRITICAL": 50, "ERROR": 40, "WARNING": 30, "INFO": 20, "DEBUG": 10}
_MARCA_HANDLER = "registroInternoArchivo"

_procesoActivo: str | None = None
_erroresCliente: deque[float] = deque()


def rutaArchivo(proceso: str) -> Path:
    """Ruta del archivo de log de un proceso.

    Args:
        proceso: Uno de ``PROCESOS_CONOCIDOS``.

    Returns:
        Ruta dentro de ``LOGS_DIR``.

    Raises:
        ValueError: Si el proceso no es uno de los conocidos (evita rutas arbitrarias).
    """
    if proceso not in PROCESOS_CONOCIDOS:
        raise ValueError(f"Proceso de log desconocido: {proceso!r}")
    return LOGS_DIR / f"{proceso}.log"


def configurar(proceso: str) -> bool:
    """Añade al logger raíz un handler que escribe en ``logs/<proceso>.log``.

    Es idempotente. Si no se puede escribir (permisos del volumen) no aborta el
    arranque: deja constancia y la salida estándar sigue funcionando.

    Args:
        proceso: ``"web"`` o ``"worker"``.

    Returns:
        True si el archivo queda activo; False si está desactivado o falló.
    """
    global _procesoActivo
    if not settings.obtener("registros.archivo"):
        return False
    raiz = logging.getLogger()
    if any(getattr(handler, _MARCA_HANDLER, False) for handler in raiz.handlers):
        return True
    try:
        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(
            rutaArchivo(proceso), maxBytes=MAX_BYTES, backupCount=COPIAS_ROTADAS, encoding="utf-8"
        )
    except OSError as error:
        log.warning("[registro] No se puede escribir en %s: %s", LOGS_DIR, error)
        return False
    handler.setFormatter(logging.Formatter(settings.formatoLog()))
    setattr(handler, _MARCA_HANDLER, True)
    raiz.addHandler(handler)
    _procesoActivo = proceso
    return True


def estaActivo() -> bool:
    """Indica si este proceso tiene el handler de archivo puesto."""
    return any(getattr(handler, _MARCA_HANDLER, False) for handler in logging.getLogger().handlers)


def enDocker() -> bool:
    """Indica si el proceso corre dentro de un contenedor Docker."""
    return Path("/.dockerenv").exists()


def estadoArchivos() -> list[dict]:
    """Estado de cada archivo de log conocido.

    Returns:
        Una entrada por proceso con ``proceso``, ``existe``, ``bytes`` y
        ``modificado`` (epoch en segundos, None si no existe).
    """
    estados = []
    for proceso in PROCESOS_CONOCIDOS:
        try:
            datos = rutaArchivo(proceso).stat()
            estados.append({"proceso": proceso, "existe": True, "bytes": datos.st_size, "modificado": datos.st_mtime})
        except OSError:
            estados.append({"proceso": proceso, "existe": False, "bytes": 0, "modificado": None})
    return estados


def _nivelDeLinea(linea: str) -> int:
    for nombre, valor in _NIVELES.items():
        if f"[{nombre}]" in linea:
            return valor
    return 0


def leerCola(proceso: str, maxLineas: int = LINEAS_POR_DEFECTO, nivelMinimo: str = "DEBUG") -> list[str]:
    """Últimas líneas de un log, de la más antigua a la más reciente.

    Las líneas sin nivel reconocible (trazas de excepciones, continuaciones) se
    conservan siempre que la anterior se conserve, para no cortar un stack.

    Args:
        proceso: ``"web"`` o ``"worker"``.
        maxLineas: Máximo de líneas devueltas, acotado a ``MAX_LINEAS_LECTURA``.
        nivelMinimo: Nivel mínimo (``DEBUG`` a ``CRITICAL``).

    Returns:
        Líneas sin salto final; vacío si el archivo no existe.

    Raises:
        ValueError: Si el proceso es desconocido.
    """
    limite = max(1, min(int(maxLineas), MAX_LINEAS_LECTURA))
    minimo = _NIVELES.get(nivelMinimo.upper(), 0)
    cola: deque[str] = deque(maxlen=limite)
    mostrando = True
    try:
        with open(rutaArchivo(proceso), encoding="utf-8", errors="replace") as archivo:
            for linea in archivo:
                texto = linea.rstrip("\n")
                nivel = _nivelDeLinea(texto)
                if nivel:
                    mostrando = nivel >= minimo
                if mostrando:
                    cola.append(texto)
    except FileNotFoundError:
        return []
    return list(cola)


def _recortar(valor: object) -> str:
    return str(valor if valor is not None else "")[:MAX_CAMPO_CLIENTE].replace("\r", " ")


def registrarErrorCliente(datos: dict) -> bool:
    """Escribe en el log un error capturado en el navegador.

    Args:
        datos: ``mensaje``, ``stack``, ``origen``, ``pagina`` y ``contexto``; todo opcional.

    Returns:
        False si se descartó por superar ``MAX_ERRORES_CLIENTE_POR_MINUTO``.
    """
    ahora = time.monotonic()
    while _erroresCliente and ahora - _erroresCliente[0] > 60:
        _erroresCliente.popleft()
    if len(_erroresCliente) >= MAX_ERRORES_CLIENTE_POR_MINUTO:
        return False
    _erroresCliente.append(ahora)
    logging.getLogger("cliente").error(
        "[navegador] %s | origen=%s pagina=%s contexto=%s\n%s",
        _recortar(datos.get("mensaje")),
        _recortar(datos.get("origen")),
        _recortar(datos.get("pagina")),
        _recortar(datos.get("contexto")),
        _recortar(datos.get("stack")),
    )
    return True


def estado() -> dict:
    """Resumen para la pantalla de Ajustes."""
    return {
        "activo": estaActivo(),
        "habilitado": bool(settings.obtener("registros.archivo")),
        "proceso": _procesoActivo,
        "pid": os.getpid(),
        "docker": enDocker(),
        "nivel": settings.nivelLog(),
        "archivos": estadoArchivos(),
    }
