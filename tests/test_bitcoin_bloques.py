"""Pruebas de providers/bitcoin_bloques.py: qué monedas gasta un bloque en bruto.

Nada sale a la red: el bloque 170 es real (tests/datos/bloque_170.hex) y el
bloque SegWit se construye aquí.
"""

import hashlib
from pathlib import Path

import pytest

from providers.bitcoin_bloques import BloqueIlegible, LectorBloques, gastosDeBloque

_BLOQUE_170 = bytes.fromhex((Path(__file__).parent / "datos" / "bloque_170.hex").read_text().strip())


def _varint(n: int) -> bytes:
    return bytes([n]) if n < 0xFD else b"\xfd" + n.to_bytes(2, "little")


def _script(datos: bytes) -> bytes:
    return _varint(len(datos)) + datos


def _entrada(txid: str, salida: int) -> bytes:
    return bytes.fromhex(txid)[::-1] + salida.to_bytes(4, "little") + _script(b"\x51") + b"\xff" * 4


def _salida(satoshis: int) -> bytes:
    return satoshis.to_bytes(8, "little") + _script(b"\x51")


def _coinbase() -> bytes:
    return (b"\x01\x00\x00\x00" + _varint(1) + _entrada("00" * 32, 0xFFFFFFFF) + _varint(1) + _salida(50)
            + b"\x00" * 4)


def _segwit(entradas: list[tuple[str, int]]) -> tuple[bytes, str]:
    """Una transacción SegWit con un testigo por entrada, y su txid (sin testigos)."""
    cuerpo = (_varint(len(entradas)) + b"".join(_entrada(t, s) for t, s in entradas)
              + _varint(1) + _salida(1000))
    testigos = b"".join(_varint(1) + _script(b"\xaa" * 72) for _ in entradas)
    tx = b"\x02\x00\x00\x00" + b"\x00\x01" + cuerpo + testigos + b"\x00" * 4
    sinTestigos = b"\x02\x00\x00\x00" + cuerpo + b"\x00" * 4
    return tx, hashlib.sha256(hashlib.sha256(sinTestigos).digest()).digest()[::-1].hex()


def _bloque(*transacciones: bytes) -> bytes:
    return b"\x00" * 80 + _varint(len(transacciones)) + b"".join(transacciones)


def testElBloque170GastaLaMonedaDelBloque9EnLaTransaccionAHalFinney():
    gastos = list(gastosDeBloque(_BLOQUE_170))

    assert gastos == [("0437cd7f8525ceed2324359c2d0ba26006d92d856a9c20fa0241106ee5a597c9", 0,
                       "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16")]


def testUnBloqueSegwitDaLasEntradasYElTxidSinTestigos():
    origenA, origenB = "ab" * 32, "cd" * 32
    tx, txid = _segwit([(origenA, 1), (origenB, 7)])

    gastos = list(gastosDeBloque(_bloque(_coinbase(), tx)))

    assert gastos == [(origenA, 1, txid), (origenB, 7, txid)]


def testLaCoinbaseNoGastaNada():
    assert list(gastosDeBloque(_bloque(_coinbase()))) == []


@pytest.mark.parametrize("datos", [_BLOQUE_170[:-3], _BLOQUE_170 + b"\x00", b"\x00" * 40])
def testUnBloqueCortadoOConBytesDeMasEsIlegible(datos):
    with pytest.raises(BloqueIlegible):
        list(gastosDeBloque(datos))


class _Respuesta:
    def __init__(self, datos: bytes) -> None:
        self._datos = datos

    def read(self, limite=None):
        return self._datos

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def testElLectorPideElHashYLuegoElBloque():
    pedidas = []

    def abrir(peticion, timeout=None):
        pedidas.append(peticion.full_url)
        if peticion.full_url.endswith("/blocks/tip/height"):
            return _Respuesta(b"925000")
        if "/block-height/" in peticion.full_url:
            return _Respuesta(b"ab" * 32)
        return _Respuesta(_BLOQUE_170)

    lector = LectorBloques(baseUrl="https://esplora.ejemplo/api", abrirUrl=abrir, dormir=lambda s: None)

    assert lector.altura() == 925000
    assert lector.bloque(170) == _BLOQUE_170
    assert pedidas[1:] == ["https://esplora.ejemplo/api/block-height/170",
                           f"https://esplora.ejemplo/api/block/{'ab' * 32}/raw"]
