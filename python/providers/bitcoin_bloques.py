"""Bloques de Bitcoin en bruto: bajarlos de Esplora y ver qué monedas gastan.

Para saber si se mueve alguna de las ~22.000 monedas de Satoshi no hace falta
preguntar por cada una: basta con mirar cada bloque nuevo (unos 144 al día) y
comprobar si alguna transacción las usa como entrada. Un bloque entero son
~1,5 MB en una sola petición; sus transacciones con entradas detalladas serían
más de cien páginas.

El formato es el de la red (BIP 144 para SegWit): no hace falta ningún nodo.
"""

import hashlib
import json
import logging
import time
from collections.abc import Callable, Iterator
from urllib.error import HTTPError, URLError
from urllib.request import Request

from core import settings
from providers.blockchain_clients import esperarTurnoEsplora
from providers.conexion import abrir

log = logging.getLogger(__name__)

# Un bloque cabe de sobra: el máximo por consenso son 4 MB de peso.
_MAX_BLOQUE_BYTES = 8 * 1024 * 1024
_REINTENTOS = 3


class BloqueIlegible(ValueError):
    """Los bytes no son un bloque de Bitcoin bien formado."""


class _Lector:
    """Cursor sobre los bytes del bloque."""

    def __init__(self, datos: bytes) -> None:
        self.datos = memoryview(datos)
        self.pos = 0

    def leer(self, n: int) -> memoryview:
        if self.pos + n > len(self.datos):
            raise BloqueIlegible("El bloque se acaba antes de tiempo")
        trozo = self.datos[self.pos:self.pos + n]
        self.pos += n
        return trozo

    def entero(self, n: int) -> int:
        return int.from_bytes(self.leer(n), "little")

    def varint(self) -> int:
        primero = self.entero(1)
        if primero < 0xFD:
            return primero
        return self.entero({0xFD: 2, 0xFE: 4, 0xFF: 8}[primero])

    def saltarScript(self) -> None:
        self.leer(self.varint())


def _txid(partes: list[memoryview]) -> str:
    """txid: doble SHA-256 de la transacción sin testigos, en el orden en que se muestra."""
    resumen = hashlib.sha256()
    for parte in partes:
        resumen.update(parte)
    return hashlib.sha256(resumen.digest()).digest()[::-1].hex()


def gastosDeBloque(datos: bytes) -> Iterator[tuple[str, int, str]]:
    """Cada moneda que gasta el bloque: (txid de origen, salida, txid que la gasta).

    Args:
        datos: El bloque serializado, tal como lo da `/block/:hash/raw`.

    Yields:
        Una tupla por entrada de cada transacción, salvo la coinbase, que no gasta nada.

    Raises:
        BloqueIlegible: si los bytes no tienen la forma de un bloque.

    Example:
        >>> for origen, salida, gasto in gastosDeBloque(bloque):
        ...     if (origen, salida) in monedas: ...
    """
    lector = _Lector(datos)
    lector.leer(80)  # cabecera
    transacciones = lector.varint()
    for indice in range(transacciones):
        inicio = lector.pos
        lector.leer(4)  # versión
        segwit = lector.datos[lector.pos] == 0 and lector.datos[lector.pos + 1] != 0
        if segwit:
            lector.leer(2)  # marcador y bandera: no entran en el txid
        inicioCuerpo = lector.pos
        entradas = []
        for _ in range(lector.varint()):
            origen = bytes(lector.leer(32))[::-1].hex()
            salida = lector.entero(4)
            lector.saltarScript()
            lector.leer(4)  # secuencia
            entradas.append((origen, salida))
        for _ in range(lector.varint()):
            lector.leer(8)  # importe
            lector.saltarScript()
        finCuerpo = lector.pos
        if segwit:
            for _ in entradas:
                for _ in range(lector.varint()):
                    lector.saltarScript()
        lector.leer(4)  # locktime
        if indice == 0:
            continue
        txid = _txid([lector.datos[inicio:inicio + 4], lector.datos[inicioCuerpo:finCuerpo],
                      lector.datos[lector.pos - 4:lector.pos]])
        for origen, salida in entradas:
            yield origen, salida, txid
    if lector.pos != len(lector.datos):
        raise BloqueIlegible("Sobran bytes al final del bloque")


class LectorBloques:
    """Altura actual y bloques en bruto desde Esplora (mempool.space o un nodo propio).

    Args:
        baseUrl: URL de Esplora; por defecto, la de `[wallets] esplora_url`.
        abrirUrl: Como `urllib.request.urlopen`; inyectable para los tests.
        dormir: Espera entre reintentos; inyectable para los tests.
    """

    def __init__(self, baseUrl: str | None = None, abrirUrl: Callable = abrir,
                 dormir: Callable[[float], None] = time.sleep) -> None:
        self._baseUrl = baseUrl
        self._abrirUrl = abrirUrl
        self._dormir = dormir

    def _pedir(self, ruta: str) -> bytes:
        base = (self._baseUrl or settings.walletsEsploraUrl()).rstrip("/")
        peticion = Request(f"{base}/{ruta}", headers={"User-Agent": settings.proveedorUserAgent()})
        for intento in range(_REINTENTOS):
            # El mismo ritmo que las wallets: van a la misma Esplora y su límite es por IP.
            esperarTurnoEsplora(base, self._dormir)
            try:
                with self._abrirUrl(peticion, timeout=settings.proveedorTimeout() * 3) as respuesta:
                    datos = respuesta.read(_MAX_BLOQUE_BYTES + 1)
                if len(datos) > _MAX_BLOQUE_BYTES:
                    raise BloqueIlegible("Respuesta demasiado grande para ser un bloque")
                return datos
            except HTTPError as error:
                # Un 404 es definitivo (el bloque aún no existe); 429 y 5xx, no.
                if (error.code < 500 and error.code != 429) or intento == _REINTENTOS - 1:
                    raise
            except (URLError, TimeoutError, OSError):
                if intento == _REINTENTOS - 1:
                    raise
            self._dormir(2 ** intento)
        raise OSError("Sin respuesta de Esplora")

    def altura(self) -> int:
        """Altura del último bloque."""
        altura = json.loads(self._pedir("blocks/tip/height"))
        if isinstance(altura, bool) or not isinstance(altura, int):
            raise BloqueIlegible("Esplora devolvió una altura inesperada")
        return altura

    def bloque(self, altura: int) -> bytes:
        """El bloque de esa altura, serializado."""
        hashBloque = self._pedir(f"block-height/{altura}").decode("ascii").strip()
        if len(hashBloque) != 64:
            raise BloqueIlegible("Esplora devolvió un hash de bloque inesperado")
        return self._pedir(f"block/{hashBloque}/raw")
