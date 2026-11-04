"""Conexiones TCP que no se quedan colgadas en una IP muerta.

Un servidor con varias IPs (mempool.space tiene ocho) puede tener alguna que no
contesta desde la red del usuario. `socket.create_connection` las prueba en
orden y espera en cada una el timeout entero de la petición: con la primera IP
caída, cada llamada perdía 10 s antes de pasar a la siguiente, y leer una wallet
de Bitcoin con varias páginas tardaba minutos.

Aquí cada IP tiene un plazo de conexión corto, aparte del de lectura, y se
recuerda por proceso qué IP funcionó (se prueba la primera la próxima vez) y
cuáles fallaron (se dejan para el final durante un rato). Nada de listas de IPs
por proveedor: el arreglo vale para cualquier servidor.

`abrir` sustituye a `urllib.request.urlopen` con estas conexiones.
"""

import http.client
import logging
import socket
import threading
import time
import urllib.request
from collections.abc import Callable

from core import settings

log = logging.getLogger(__name__)

# Una IP que no conectó se deja para el final este rato: la caída suele durar,
# pero tampoco se descarta para siempre por un fallo puntual.
_CASTIGO_SEGUNDOS = 600.0
# IPs sin respuesta seguidas en una llamada tras las que se da el servidor por
# caído. Recorrer las ocho de mempool.space costaba 24 s antes de pasar a la
# Esplora de respaldo; una IP muerta suelta se salta igual con la segunda.
_MAX_IPS_SIN_RESPUESTA = 2

_lock = threading.Lock()
_buenas: dict[tuple[str, int], str] = {}
_malas: dict[tuple[str, int, str], float] = {}
# Servidores de los que no conectó ninguna IP: hasta cuándo se dan por caídos.
_caidos: dict[tuple[str, int], float] = {}


def olvidar() -> None:
    """Borra lo aprendido sobre qué IPs funcionan. Para los tests."""
    with _lock:
        _buenas.clear()
        _malas.clear()
        _caidos.clear()


def servidorCaido(host: str, puerto: int, ahora: float | None = None) -> bool:
    """Si hace poco no conectó ninguna IP de este servidor.

    `providers.http` lo usa para no reintentar: con todas las IPs sin contestar,
    repetir la petición al cabo de un segundo solo alarga la espera.

    Args:
        host: Nombre del servidor.
        puerto: Puerto TCP.
        ahora: Instante monotónico; por defecto, el actual.

    Returns:
        True si la última vez no conectó ninguna IP y no ha pasado el castigo.
    """
    momento = time.monotonic() if ahora is None else ahora
    with _lock:
        return _caidos.get((host, puerto), 0.0) > momento


def _ordenar(host: str, puerto: int, ips: list[str], ahora: float) -> list[str]:
    """Las IPs en el orden en que conviene probarlas: la buena, las demás y las castigadas.

    Las castigadas van de la que lleva más tiempo castigada a la que menos: si
    el servidor está caído y solo se sondea una, así se van turnando.
    """
    with _lock:
        buena = _buenas.get((host, puerto))
        castigo = {ip: _malas.get((host, puerto, ip), 0.0) for ip in ips}
    castigadas = sorted((ip for ip in ips if castigo[ip] > ahora and ip != buena), key=castigo.__getitem__)
    primero = [ip for ip in ips if ip == buena]
    normales = [ip for ip in ips if ip != buena and castigo[ip] <= ahora]
    return primero + normales + castigadas


def _anotar(host: str, puerto: int, ip: str, funciona: bool, ahora: float) -> None:
    with _lock:
        if funciona:
            _buenas[(host, puerto)] = ip
            _malas.pop((host, puerto, ip), None)
            _caidos.pop((host, puerto), None)
        else:
            _malas[(host, puerto, ip)] = ahora + _CASTIGO_SEGUNDOS
            if _buenas.get((host, puerto)) == ip:
                del _buenas[(host, puerto)]


def _anotarCaido(host: str, puerto: int, ahora: float) -> None:
    with _lock:
        _caidos[(host, puerto)] = ahora + _CASTIGO_SEGUNDOS


def conectar(
    direccion: tuple[str, int],
    timeout: float | object = socket._GLOBAL_DEFAULT_TIMEOUT,
    source_address: tuple[str, int] | None = None,
    *,
    plazoConexion: Callable[[], float] = settings.proveedorTimeoutConexion,
    resolver: Callable = socket.getaddrinfo,
    crear: Callable = socket.create_connection,
    reloj: Callable[[], float] = time.monotonic,
) -> socket.socket:
    """Como `socket.create_connection`, pero sin esperar el timeout entero en cada IP.

    Args:
        direccion: (host, puerto).
        timeout: Timeout de la petición; tras conectar, el socket lo usa para leer.
        source_address: Como en `socket.create_connection`.
        plazoConexion: Segundos máximos para conectar con cada IP. Inyectable.
        resolver: `socket.getaddrinfo`, inyectable para los tests.
        crear: `socket.create_connection`, inyectable para los tests.
        reloj: Reloj monotónico, inyectable para los tests.

    Returns:
        El socket conectado.

    Raises:
        OSError: el error de la última IP si no conecta ninguna, o el de la
            resolución DNS.
    """
    host, puerto = direccion
    conTimeout = isinstance(timeout, (int, float))
    ips = list(dict.fromkeys(info[4][0] for info in resolver(host, puerto, type=socket.SOCK_STREAM)))
    # Con una sola IP no hay a dónde saltar: se le da todo el tiempo de la petición.
    if len(ips) <= 1:
        return crear(direccion, timeout, source_address)
    plazo = min(float(timeout), plazoConexion()) if conTimeout else plazoConexion()
    candidatas = _ordenar(host, puerto, ips, reloj())[:_MAX_IPS_SIN_RESPUESTA]
    # Con el servidor entero caído (mempool.space con sus ocho IPs sin contestar
    # desde la red del usuario), recorrerlas todas costaba 8 × plazo en cada
    # llamada. Se sondea una sola hasta que vuelva.
    if servidorCaido(host, puerto, reloj()):
        candidatas = candidatas[:1]
    ultimoError: OSError | None = None
    for ip in candidatas:
        try:
            sock = crear((ip, puerto), plazo, source_address)
        except OSError as error:
            log.info("No conecta %s (%s:%s): %s; se prueba otra IP", host, ip, puerto, error)
            _anotar(host, puerto, ip, False, reloj())
            ultimoError = error
            continue
        _anotar(host, puerto, ip, True, reloj())
        sock.settimeout(float(timeout) if conTimeout else None)
        return sock
    _anotarCaido(host, puerto, reloj())
    raise ultimoError or OSError(f"No se pudo conectar con {host}")


# http.client fija `_create_connection` en __init__, como atributo de la
# instancia: hay que sustituirlo después, no en la clase.
class _ConexionHttp(http.client.HTTPConnection):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._create_connection = conectar


class _ConexionHttps(http.client.HTTPSConnection):
    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._create_connection = conectar


class _ManejadorHttp(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(_ConexionHttp, req)


class _ManejadorHttps(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(_ConexionHttps, req, context=self._context)


# build_opener sustituye los manejadores por defecto por estas subclases y
# conserva el resto (proxies del entorno, redirecciones, errores HTTP).
_abridor = urllib.request.build_opener(_ManejadorHttp, _ManejadorHttps)


def abrir(peticion, timeout: float | object = socket._GLOBAL_DEFAULT_TIMEOUT):
    """`urllib.request.urlopen` con las conexiones de este módulo."""
    return _abridor.open(peticion, timeout=timeout)
