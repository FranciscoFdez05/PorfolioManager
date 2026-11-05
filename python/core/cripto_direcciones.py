"""Redes cripto soportadas, validación de direcciones y derivación de xpub.

Todo lo que hay aquí es **público**: direcciones, claves públicas sueltas
(02…/03…/04…) y claves públicas extendidas (xpub/ypub/zpub). Una clave privada o una frase semilla no tienen ningún uso en
la aplicación —para ver movimientos basta con lo público— y se rechazan con un
mensaje explícito en vez de con un «formato no válido» genérico, para que nadie
las vuelva a intentar pegar en otro campo.

La derivación de direcciones desde la xpub se hace en local a propósito. Hay
servicios que aceptan la xpub y devuelven el historial completo, pero mandarla
a un tercero le entrega de una vez todas las direcciones presentes y futuras de
la wallet. Derivándolas aquí, el proveedor solo ve direcciones sueltas.

No se añade ninguna dependencia: secp256k1, RIPEMD-160, base58 y bech32 son
unas decenas de líneas cada uno, y una librería de criptomonedas completa
traería mucho más código del que se usa. Como solo se opera con datos públicos,
la aritmética no necesita ser de tiempo constante.
"""

import hashlib
import hmac
from dataclasses import dataclass, replace

# ── Redes ─────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Red:
    """Una red soportada, su moneda nativa y el explorador donde ver una transacción.

    `explorador` lleva `{hash}` donde va el hash. Solo se abre si el usuario
    pulsa el enlace: el explorador ve qué transacción se consulta.
    `exploradorToken` lleva `{contrato}` y solo lo tienen las redes cuyos tokens
    se leen; sin él, los tokens de esa red no se pueden verificar.
    """

    clave: str
    nombre: str
    simbolo: str
    explorador: str
    admiteXpub: bool = False
    admiteClavePublica: bool = False
    exploradorToken: str = ""


REDES = {
    "btc": Red("btc", "Bitcoin", "BTC", "https://mempool.space/tx/{hash}", admiteXpub=True,
               admiteClavePublica=True),
    "eth": Red("eth", "Ethereum", "ETH", "https://etherscan.io/tx/{hash}", admiteClavePublica=True,
               exploradorToken="https://etherscan.io/token/{contrato}"),
    "bnb": Red("bnb", "BNB Smart Chain", "BNB", "https://bscscan.com/tx/{hash}", admiteClavePublica=True,
               exploradorToken="https://bscscan.com/token/{contrato}"),
    "sol": Red("sol", "Solana", "SOL", "https://solscan.io/tx/{hash}"),
    "xrp": Red("xrp", "XRP Ledger", "XRP", "https://livenet.xrpl.org/transactions/{hash}"),
}

TIPO_DIRECCION = "direccion"
TIPO_XPUB = "xpub"
# Clave pública individual en hexadecimal (02…/03… comprimida, 04… sin comprimir).
# Solo se guarda así en Bitcoin, donde una clave tiene varias direcciones. En
# las redes EVM tiene una sola y se guarda ya convertida en esa dirección.
TIPO_CLAVE_PUBLICA = "clave"

# Lo que puede pedir el formulario además de los tipos que se guardan. «auto»
# deja que el servidor reconozca el formato; las «xpub-…» sirven para las
# wallets que exportan «xpub» aunque la cuenta sea SegWit o Taproot (Electrum,
# Sparrow, Ledger…): con el prefijo xpub se derivarían direcciones 1… sin
# movimientos.
TIPO_AUTO = "auto"
TIPO_XPUB_SEGWIT = "xpub-p2wpkh"
TIPO_XPUB_SEGWIT_COMPATIBLE = "xpub-p2sh-p2wpkh"
TIPO_XPUB_TAPROOT = "xpub-p2tr"
TIPOS_ENTRADA = (
    TIPO_AUTO, TIPO_DIRECCION, TIPO_XPUB, TIPO_XPUB_SEGWIT, TIPO_XPUB_SEGWIT_COMPATIBLE, TIPO_XPUB_TAPROOT,
    TIPO_CLAVE_PUBLICA,
)
_REDES_EVM = frozenset({"eth", "bnb"})


class DatoWalletInvalido(ValueError):
    """La dirección o la xpub no tienen un formato válido para la red."""


class SecretoRechazado(DatoWalletInvalido):
    """Se ha pegado una clave privada o una frase semilla."""


# ── Hashes y codificaciones ───────────────────────────────────────────────────

_ALFABETO_BTC = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
# XRP usa base58 con otro orden de alfabeto (por eso sus direcciones empiezan
# por «r», que es su cero).
_ALFABETO_XRP = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz"


def _sha256d(datos: bytes) -> bytes:
    return hashlib.sha256(hashlib.sha256(datos).digest()).digest()


def base58Codificar(datos: bytes, alfabeto: str = _ALFABETO_BTC) -> str:
    """Codifica bytes en base58 conservando los ceros iniciales."""
    numero = int.from_bytes(datos, "big")
    salida = []
    while numero:
        numero, resto = divmod(numero, 58)
        salida.append(alfabeto[resto])
    ceros = len(datos) - len(datos.lstrip(b"\0"))
    return alfabeto[0] * ceros + "".join(reversed(salida))


def base58Decodificar(texto: str, alfabeto: str = _ALFABETO_BTC) -> bytes:
    """Decodifica base58.

    Raises:
        DatoWalletInvalido: si hay caracteres fuera del alfabeto.
    """
    numero = 0
    for caracter in texto:
        indice = alfabeto.find(caracter)
        if indice < 0:
            raise DatoWalletInvalido("Contiene caracteres que no son base58")
        numero = numero * 58 + indice
    cuerpo = numero.to_bytes((numero.bit_length() + 7) // 8, "big") if numero else b""
    ceros = len(texto) - len(texto.lstrip(alfabeto[0]))
    return b"\0" * ceros + cuerpo


def base58CheckCodificar(carga: bytes, alfabeto: str = _ALFABETO_BTC) -> str:
    """base58 con los 4 bytes de suma de control (doble SHA-256) al final."""
    return base58Codificar(carga + _sha256d(carga)[:4], alfabeto)


def base58CheckDecodificar(texto: str, alfabeto: str = _ALFABETO_BTC) -> bytes:
    """Inversa de `base58CheckCodificar`.

    Raises:
        DatoWalletInvalido: si la suma de control no cuadra.
    """
    datos = base58Decodificar(texto, alfabeto)
    if len(datos) < 5 or _sha256d(datos[:-4])[:4] != datos[-4:]:
        raise DatoWalletInvalido("La suma de control no coincide (¿falta o sobra algún carácter?)")
    return datos[:-4]


# RIPEMD-160 en Python puro. hashlib lo ofrece solo si el OpenSSL del sistema lo
# trae habilitado, y en OpenSSL 3 depende de la compilación: en Windows está y en
# algunas imágenes Linux no. Se usa el de hashlib cuando existe.
_RMD_ML = (
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
    3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
    1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
    4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13,
)
_RMD_MR = (
    5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
    6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
    15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
    8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
    12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11,
)
_RMD_RL = (
    11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
    7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
    11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
    11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
    9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6,
)
_RMD_RR = (
    8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
    9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
    9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
    15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
    8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11,
)
_RMD_KL = (0, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E)
_RMD_KR = (0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0)
_MASCARA32 = 0xFFFFFFFF


def _rmdF(x: int, y: int, z: int, ronda: int) -> int:
    if ronda == 0:
        return x ^ y ^ z
    if ronda == 1:
        return (x & y) | (~x & z)
    if ronda == 2:
        return (x | ~y) ^ z
    if ronda == 3:
        return (x & z) | (y & ~z)
    return x ^ (y | ~z)


def _rmdRotar(x: int, n: int) -> int:
    x &= _MASCARA32
    return ((x << n) | (x >> (32 - n))) & _MASCARA32


def _rmdComprimir(estado: tuple, bloque: bytes) -> tuple:
    h0, h1, h2, h3, h4 = estado
    al, bl, cl, dl, el = estado
    ar, br, cr, dr, er = estado
    palabras = [int.from_bytes(bloque[4 * i:4 * i + 4], "little") for i in range(16)]
    for j in range(80):
        ronda = j >> 4
        al = (_rmdRotar(al + _rmdF(bl, cl, dl, ronda) + palabras[_RMD_ML[j]] + _RMD_KL[ronda], _RMD_RL[j]) + el) & _MASCARA32
        al, bl, cl, dl, el = el, al, bl, _rmdRotar(cl, 10), dl
        ar = (_rmdRotar(ar + _rmdF(br, cr, dr, 4 - ronda) + palabras[_RMD_MR[j]] + _RMD_KR[ronda], _RMD_RR[j]) + er) & _MASCARA32
        ar, br, cr, dr, er = er, ar, br, _rmdRotar(cr, 10), dr
    return (
        (h1 + cl + dr) & _MASCARA32,
        (h2 + dl + er) & _MASCARA32,
        (h3 + el + ar) & _MASCARA32,
        (h4 + al + br) & _MASCARA32,
        (h0 + bl + cr) & _MASCARA32,
    )


def ripemd160Puro(datos: bytes) -> bytes:
    """RIPEMD-160 sin depender de OpenSSL."""
    estado = (0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0)
    relleno = b"\x80" + b"\x00" * ((55 - len(datos)) % 64) + (8 * len(datos)).to_bytes(8, "little")
    mensaje = datos + relleno
    for inicio in range(0, len(mensaje), 64):
        estado = _rmdComprimir(estado, mensaje[inicio:inicio + 64])
    return b"".join(h.to_bytes(4, "little") for h in estado)


def _ripemd160(datos: bytes) -> bytes:
    try:
        return hashlib.new("ripemd160", datos).digest()
    except ValueError:
        return ripemd160Puro(datos)


def hash160(datos: bytes) -> bytes:
    """RIPEMD-160(SHA-256(datos)): el identificador de clave de Bitcoin."""
    return _ripemd160(hashlib.sha256(datos).digest())


# Keccak-256, el hash de las direcciones EVM. No es el `sha3_256` de hashlib:
# Ethereum adoptó Keccak antes de que NIST cambiara el relleno al estandarizar
# SHA-3, y con un byte de relleno distinto sale otro hash.
_KECCAK_RONDAS = (
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
)
# Rotación de cada carril, indexado por x + 5·y.
_KECCAK_ROTACIONES = (
    0, 1, 62, 28, 27,
    36, 44, 6, 55, 20,
    3, 10, 43, 25, 39,
    41, 45, 15, 21, 8,
    18, 2, 61, 56, 14,
)
_MASCARA64 = (1 << 64) - 1
_KECCAK_TASA = 136


def _keccakRotar(x: int, n: int) -> int:
    return ((x << n) | (x >> (64 - n))) & _MASCARA64 if n else x


def _keccakPermutar(estado: list) -> list:
    for constante in _KECCAK_RONDAS:
        columnas = [estado[x] ^ estado[x + 5] ^ estado[x + 10] ^ estado[x + 15] ^ estado[x + 20] for x in range(5)]
        ajustes = [columnas[(x - 1) % 5] ^ _keccakRotar(columnas[(x + 1) % 5], 1) for x in range(5)]
        estado = [carril ^ ajustes[i % 5] for i, carril in enumerate(estado)]
        movido = [0] * 25
        for x in range(5):
            for y in range(5):
                movido[y + 5 * ((2 * x + 3 * y) % 5)] = _keccakRotar(estado[x + 5 * y], _KECCAK_ROTACIONES[x + 5 * y])
        estado = [
            movido[i] ^ (~movido[(i + 1) % 5 + 5 * (i // 5)] & movido[(i + 2) % 5 + 5 * (i // 5)] & _MASCARA64)
            for i in range(25)
        ]
        estado[0] ^= constante
    return estado


def keccak256(datos: bytes) -> bytes:
    """Keccak-256 original (relleno 0x01), el que usa Ethereum."""
    return _esponjaKeccak(datos, 0x01)


def _esponjaKeccak(datos: bytes, separador: int) -> bytes:
    # Con separador 0x06 es SHA3-256: los tests lo comparan con hashlib para
    # validar la permutación sin depender de otra librería.
    relleno = _KECCAK_TASA - len(datos) % _KECCAK_TASA
    mensaje = bytearray(datos) + bytes([separador]) + b"\x00" * (relleno - 1)
    mensaje[-1] |= 0x80
    estado = [0] * 25
    for inicio in range(0, len(mensaje), _KECCAK_TASA):
        bloque = mensaje[inicio:inicio + _KECCAK_TASA]
        for i in range(_KECCAK_TASA // 8):
            estado[i] ^= int.from_bytes(bloque[8 * i:8 * i + 8], "little")
        estado = _keccakPermutar(estado)
    return b"".join(carril.to_bytes(8, "little") for carril in estado[:4])


# Bech32 (BIP 173) y bech32m (BIP 350): direcciones segwit v0 y taproot.
_BECH32_ALFABETO = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_BECH32_CONSTANTE = 1
_BECH32M_CONSTANTE = 0x2BC830A3


def _bech32Polymod(valores) -> int:
    generadores = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    suma = 1
    for valor in valores:
        alto = suma >> 25
        suma = ((suma & 0x1FFFFFF) << 5) ^ valor
        for i, generador in enumerate(generadores):
            if (alto >> i) & 1:
                suma ^= generador
    return suma


def _bech32ExpandirHrp(hrp: str) -> list:
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def _convertirBits(datos, desde: int, hacia: int, rellenar: bool) -> list:
    acumulado = 0
    bits = 0
    salida = []
    maximo = (1 << hacia) - 1
    for valor in datos:
        if valor < 0 or valor >> desde:
            raise DatoWalletInvalido("Datos bech32 fuera de rango")
        acumulado = (acumulado << desde) | valor
        bits += desde
        while bits >= hacia:
            bits -= hacia
            salida.append((acumulado >> bits) & maximo)
    if rellenar:
        if bits:
            salida.append((acumulado << (hacia - bits)) & maximo)
    elif bits >= desde or ((acumulado << (hacia - bits)) & maximo):
        raise DatoWalletInvalido("Relleno bech32 no válido")
    return salida


def segwitCodificar(hrp: str, version: int, programa: bytes) -> str:
    """Dirección segwit (bech32 para v0, bech32m para v1+)."""
    datos = [version, *_convertirBits(programa, 8, 5, True)]
    constante = _BECH32_CONSTANTE if version == 0 else _BECH32M_CONSTANTE
    polymod = _bech32Polymod(_bech32ExpandirHrp(hrp) + datos + [0] * 6) ^ constante
    suma = [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(_BECH32_ALFABETO[d] for d in datos + suma)


def segwitDecodificar(hrp: str, direccion: str) -> tuple:
    """Devuelve (versión, programa) de una dirección segwit.

    Raises:
        DatoWalletInvalido: si el formato o la suma de control no son válidos.
    """
    if direccion.lower() != direccion and direccion.upper() != direccion:
        raise DatoWalletInvalido("Mezcla mayúsculas y minúsculas")
    direccion = direccion.lower()
    separador = direccion.rfind("1")
    if separador < 1 or separador + 7 > len(direccion) or len(direccion) > 90:
        raise DatoWalletInvalido("Longitud bech32 no válida")
    if direccion[:separador] != hrp:
        raise DatoWalletInvalido("No es una dirección de la red principal")
    datos = [_BECH32_ALFABETO.find(c) for c in direccion[separador + 1:]]
    if -1 in datos:
        raise DatoWalletInvalido("Contiene caracteres que no son bech32")
    version = datos[0]
    esperada = _BECH32_CONSTANTE if version == 0 else _BECH32M_CONSTANTE
    if _bech32Polymod(_bech32ExpandirHrp(hrp) + datos) != esperada:
        raise DatoWalletInvalido("La suma de control no coincide (¿falta o sobra algún carácter?)")
    programa = bytes(_convertirBits(datos[1:-6], 5, 8, False))
    if version > 16 or not 2 <= len(programa) <= 40 or (version == 0 and len(programa) not in (20, 32)):
        raise DatoWalletInvalido("Programa segwit no válido")
    return version, programa


# ── secp256k1 y BIP 32 (solo derivación pública) ─────────────────────────────

_P = 2**256 - 2**32 - 977
_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
_G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)
_INDICE_ENDURECIDO = 0x80000000


def _sumarPuntos(a, b):
    if a is None:
        return b
    if b is None:
        return a
    if a[0] == b[0]:
        if (a[1] + b[1]) % _P == 0:
            return None
        pendiente = 3 * a[0] * a[0] * pow(2 * a[1], -1, _P) % _P
    else:
        pendiente = (b[1] - a[1]) * pow(b[0] - a[0], -1, _P) % _P
    x = (pendiente * pendiente - a[0] - b[0]) % _P
    return x, (pendiente * (a[0] - x) - a[1]) % _P


def _multiplicarPunto(escalar: int, punto):
    resultado = None
    sumando = punto
    while escalar:
        if escalar & 1:
            resultado = _sumarPuntos(resultado, sumando)
        sumando = _sumarPuntos(sumando, sumando)
        escalar >>= 1
    return resultado


def _descomprimir(clave: bytes):
    if len(clave) != 33 or clave[0] not in (2, 3):
        raise DatoWalletInvalido("La clave pública no está en formato comprimido")
    x = int.from_bytes(clave[1:], "big")
    if x >= _P:
        raise DatoWalletInvalido("La clave pública no es un punto de la curva")
    cuadrado = (pow(x, 3, _P) + 7) % _P
    y = pow(cuadrado, (_P + 1) // 4, _P)
    if y * y % _P != cuadrado:
        raise DatoWalletInvalido("La clave pública no es un punto de la curva")
    if (y & 1) != (clave[0] & 1):
        y = _P - y
    return x, y


def _comprimir(punto) -> bytes:
    return bytes([2 + (punto[1] & 1)]) + punto[0].to_bytes(32, "big")


def _puntoDeClave(clave: bytes):
    """Punto de una clave pública comprimida (33 bytes) o sin comprimir (65).

    Raises:
        DatoWalletInvalido: si el formato no es ninguno de los dos o no está en la curva.
    """
    if len(clave) == 33:
        return _descomprimir(clave)
    if len(clave) != 65 or clave[0] != 4:
        raise DatoWalletInvalido("Una clave pública son 33 bytes (02…/03…) o 65 (04…)")
    x = int.from_bytes(clave[1:33], "big")
    y = int.from_bytes(clave[33:], "big")
    if x >= _P or y >= _P or (y * y - pow(x, 3, _P) - 7) % _P:
        raise DatoWalletInvalido("La clave pública no es un punto de la curva")
    return x, y


def _hashEtiquetado(etiqueta: str, datos: bytes) -> bytes:
    """Hash con etiqueta de BIP 340."""
    etiquetaHash = hashlib.sha256(etiqueta.encode()).digest()
    return hashlib.sha256(etiquetaHash + etiquetaHash + datos).digest()


def _claveTaproot(clave: bytes) -> bytes:
    """Clave de salida x-only de BIP 86: la interna ajustada sin árbol de scripts.

    Es la que usan las wallets Taproot de una sola firma; con scripts el
    ajuste sería otro y la dirección no se puede sacar solo de la clave.
    """
    x, y = _descomprimir(clave)
    interno = (x, y if y % 2 == 0 else _P - y)
    ajuste = int.from_bytes(_hashEtiquetado("TapTweak", x.to_bytes(32, "big")), "big")
    if ajuste >= _N:
        raise DatoWalletInvalido("Clave pública no válida para Taproot")
    salida = _sumarPuntos(interno, _multiplicarPunto(ajuste, _G))
    if salida is None:
        raise DatoWalletInvalido("Clave pública no válida para Taproot")
    return salida[0].to_bytes(32, "big")


# Prefijo de versión de cada clave extendida y el tipo de dirección que se
# deriva de ella por convención (SLIP-132). Las privadas se listan para poder
# rechazarlas con un mensaje claro.
_VERSIONES_PUBLICAS = {
    bytes.fromhex("0488B21E"): "p2pkh",        # xpub (BIP 44)
    bytes.fromhex("049D7CB2"): "p2sh-p2wpkh",  # ypub (BIP 49)
    bytes.fromhex("04B24746"): "p2wpkh",       # zpub (BIP 84)
}
_VERSIONES_PRIVADAS = {
    bytes.fromhex("0488ADE4"), bytes.fromhex("049D7878"), bytes.fromhex("04B2430C"),
    bytes.fromhex("0295B005"), bytes.fromhex("02AA7A99"),  # Yprv, Zprv (multifirma)
}
# Ypub y Zpub son de cuentas multifirma: sus direcciones combinan las claves de
# todos los firmantes, así que con una sola no se pueden derivar.
_VERSIONES_MULTIFIRMA = {bytes.fromhex("0295B43F"), bytes.fromhex("02AA7ED3")}
_VERSION_POR_TIPO = {tipo: version for version, tipo in _VERSIONES_PUBLICAS.items()}
_PREFIJO_TAPROOT = "tr("
RAMA_RECEPCION = 0
RAMA_CAMBIO = 1


@dataclass(frozen=True)
class ClaveExtendida:
    """Clave pública extendida (BIP 32) ya validada."""

    version: bytes
    tipoDireccion: str
    profundidad: int
    huellaPadre: bytes
    indice: int
    cadena: bytes
    clave: bytes

    def hijo(self, indice: int) -> "ClaveExtendida":
        """Derivación pública CKDpub de BIP 32.

        Raises:
            DatoWalletInvalido: con un índice endurecido, que exige la privada.
        """
        if not 0 <= indice < _INDICE_ENDURECIDO:
            raise DatoWalletInvalido("Una clave pública solo deriva índices no endurecidos")
        digest = hmac.new(self.cadena, self.clave + indice.to_bytes(4, "big"), hashlib.sha512).digest()
        desplazamiento = int.from_bytes(digest[:32], "big")
        punto = _sumarPuntos(_multiplicarPunto(desplazamiento, _G), _descomprimir(self.clave))
        # Probabilidad ~2^-127; BIP 32 manda saltar al índice siguiente.
        if desplazamiento >= _N or punto is None:
            raise DatoWalletInvalido("Índice de derivación no válido")
        return ClaveExtendida(
            version=self.version,
            tipoDireccion=self.tipoDireccion,
            profundidad=self.profundidad + 1,
            huellaPadre=hash160(self.clave)[:4],
            indice=indice,
            cadena=digest[32:],
            clave=_comprimir(punto),
        )

    def serializar(self) -> str:
        """La clave en el formato xpub/ypub/zpub de partida, o `tr(xpub…)` si es Taproot."""
        extendida = base58CheckCodificar(
            self.version + bytes([self.profundidad]) + self.huellaPadre
            + self.indice.to_bytes(4, "big") + self.cadena + self.clave
        )
        return f"{_PREFIJO_TAPROOT}{extendida})" if self.tipoDireccion == "p2tr" else extendida

    def direccion(self) -> str:
        """Dirección de esta clave según el tipo que marca su versión."""
        return direccionDeClave(self.clave, self.tipoDireccion)

    def direcciones(self, rama: int, desde: int, cuantas: int):
        """Genera (índice, dirección) de la rama de recepción o de cambio."""
        nodoRama = self.hijo(rama)
        for indice in range(desde, desde + cuantas):
            yield indice, nodoRama.hijo(indice).direccion()


def direccionDeClave(clave: bytes, tipoDireccion: str, versionP2pkh: int = 0x00, versionP2sh: int = 0x05) -> str:
    """Dirección Bitcoin de una clave pública.

    Las versiones se pueden cambiar solo para comprobar contra vectores de
    testnet; la aplicación trabaja siempre en la red principal. Solo P2PKH
    admite claves sin comprimir: SegWit y Taproot las exigen comprimidas.
    """
    identificador = hash160(clave)
    if tipoDireccion == "p2pkh":
        return base58CheckCodificar(bytes([versionP2pkh]) + identificador)
    if tipoDireccion == "p2sh-p2wpkh":
        guion = b"\x00\x14" + identificador
        return base58CheckCodificar(bytes([versionP2sh]) + hash160(guion))
    if tipoDireccion == "p2wpkh":
        return segwitCodificar("bc", 0, identificador)
    if tipoDireccion == "p2tr":
        return segwitCodificar("bc", 1, _claveTaproot(clave))
    raise DatoWalletInvalido(f"Tipo de dirección no soportado: {tipoDireccion}")


def _leerClavePublica(texto: str) -> bytes:
    """Valida una clave pública en hexadecimal y devuelve sus bytes.

    Raises:
        SecretoRechazado: si tiene la longitud de una clave privada.
        DatoWalletInvalido: si no es una clave pública de la curva.
    """
    hexadecimal = texto[2:] if texto[:2].lower() == "0x" else texto
    if any(c not in "0123456789abcdefABCDEF" for c in hexadecimal):
        raise DatoWalletInvalido("Una clave pública va en hexadecimal (02…, 03… o 04…)")
    if len(hexadecimal) == 64:
        raise SecretoRechazado("Eso tiene la longitud de una clave privada. No la introduzcas aquí.")
    clave = bytes.fromhex(hexadecimal) if len(hexadecimal) % 2 == 0 else b""
    _puntoDeClave(clave)
    return clave


def direccionesDeClavePublica(claveHex: str) -> list[str]:
    """Todas las direcciones de una sola firma que puede tener una clave pública.

    Una clave no dice con qué tipo de dirección se ha usado, así que se dan
    todas: P2PKH, P2SH-P2WPKH, P2WPKH y Taproot (BIP 86) de su forma
    comprimida y, si viene sin comprimir, también su P2PKH antigua.

    Raises:
        DatoWalletInvalido: si la clave no es válida.
    """
    clave = _leerClavePublica(claveHex)
    comprimida = _comprimir(_puntoDeClave(clave))
    direcciones = [direccionDeClave(clave, "p2pkh")] if len(clave) == 65 else []
    return direcciones + [direccionDeClave(comprimida, tipo) for tipo in ("p2pkh", "p2sh-p2wpkh", "p2wpkh", "p2tr")]


def clavesP2pk(claveHex: str) -> list[str]:
    """Las dos formas de una clave pública (en hex) que pueden cobrar por P2PK.

    Las salidas P2PK (los 50 BTC de las primeras recompensas de minado) pagan
    a la clave a pelo, sin dirección: no salen en ninguna de
    `direccionesDeClavePublica`. Pueden llevar la clave sin comprimir o
    comprimida, así que se dan las dos, primero la forma en que vino.

    Raises:
        DatoWalletInvalido: si la clave no es válida.

    Example:
        >>> len(clavesP2pk("02" + "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"))
        2
    """
    clave = _leerClavePublica(claveHex)
    x, y = _puntoDeClave(clave)
    sinComprimir = (b"\x04" + x.to_bytes(32, "big") + y.to_bytes(32, "big")).hex()
    comprimida = _comprimir((x, y)).hex()
    return [sinComprimir, comprimida] if len(clave) == 65 else [comprimida, sinComprimir]


def direccionEvmDeClavePublica(claveHex: str) -> str:
    """Dirección EVM (en minúsculas) de una clave pública comprimida o sin comprimir.

    Son los 20 últimos bytes del Keccak-256 de las coordenadas x e y del punto.

    Raises:
        DatoWalletInvalido: si la clave no es válida.
    """
    x, y = _puntoDeClave(_leerClavePublica(claveHex))
    return "0x" + keccak256(x.to_bytes(32, "big") + y.to_bytes(32, "big"))[-20:].hex()


def _quitarEnvolturaTaproot(texto: str) -> tuple[str, bool]:
    """(clave sin envolver, ¿venía como `tr(…)`?)."""
    if texto[:len(_PREFIJO_TAPROOT)].lower() == _PREFIJO_TAPROOT and texto.endswith(")"):
        return texto[len(_PREFIJO_TAPROOT):-1].strip(), True
    return texto, False


def leerClaveExtendida(texto: str) -> ClaveExtendida:
    """Valida y decodifica una xpub/ypub/zpub, o una cuenta Taproot como `tr(xpub…)`.

    Taproot no tiene prefijo SLIP-132 propio: sus wallets exportan una xpub
    normal. Para guardar que es Taproot se envuelve como en los descriptores
    de Bitcoin Core, sin ruta de derivación (se usan las ramas 0 y 1 de BIP 86).

    Raises:
        SecretoRechazado: si es una clave privada extendida.
        DatoWalletInvalido: si no es una clave pública extendida válida.
    """
    texto, esTaproot = _quitarEnvolturaTaproot(texto.strip())
    datos = base58CheckDecodificar(texto)
    if len(datos) != 78:
        raise DatoWalletInvalido("Una clave extendida ocupa 78 bytes")
    version = datos[:4]
    if version in _VERSIONES_PRIVADAS:
        raise SecretoRechazado(
            "Es una clave PRIVADA extendida (xprv/yprv/zprv). No la introduzcas aquí ni en "
            "ningún sitio: da acceso a los fondos. Exporta la xpub/zpub de la cuenta."
        )
    if version in _VERSIONES_MULTIFIRMA:
        raise DatoWalletInvalido(
            "Es la clave de una cuenta multifirma (Ypub/Zpub): sus direcciones combinan varias "
            "claves y no se pueden sacar de una sola. Enlaza las direcciones de la cuenta."
        )
    if version not in _VERSIONES_PUBLICAS:
        raise DatoWalletInvalido("Solo se admiten xpub, ypub y zpub de la red principal")
    clave = datos[45:]
    _descomprimir(clave)
    return ClaveExtendida(
        version=_VERSION_POR_TIPO["p2pkh"] if esTaproot else version,
        tipoDireccion="p2tr" if esTaproot else _VERSIONES_PUBLICAS[version],
        profundidad=datos[4],
        huellaPadre=datos[5:9],
        indice=int.from_bytes(datos[9:13], "big"),
        cadena=datos[13:45],
        clave=clave,
    )


# ── Validación por red ────────────────────────────────────────────────────────


def _rechazarSemilla(texto: str) -> None:
    # 12, 15, 18, 21 o 24 palabras separadas por espacios: una frase BIP 39.
    palabras = texto.split()
    if len(palabras) >= 12 and all(p.isalpha() for p in palabras):
        raise SecretoRechazado(
            "Parece una frase semilla. No la introduzcas aquí ni en ningún sitio: quien la "
            "tenga controla los fondos. Para ver movimientos basta con la dirección o la xpub."
        )


def _validarBitcoin(texto: str) -> str:
    if texto.lower().startswith("bc1"):
        segwitDecodificar("bc", texto)
        return texto.lower()
    datos = base58CheckDecodificar(texto)
    # WIF: clave privada suelta (5…, K…, L…), la que exportan las wallets de papel.
    if len(datos) in (33, 34) and datos[0] == 0x80:
        raise SecretoRechazado("Es una clave PRIVADA (formato WIF). No la introduzcas aquí ni en ningún sitio.")
    if len(datos) != 21 or datos[0] not in (0x00, 0x05):
        raise DatoWalletInvalido("No es una dirección Bitcoin de la red principal")
    return texto


def _validarEvm(texto: str) -> str:
    hexadecimal = texto[2:] if texto[:2].lower() == "0x" else texto
    if len(hexadecimal) == 64:
        raise SecretoRechazado("Eso tiene la longitud de una clave privada. No la introduzcas aquí.")
    cuerpo = texto[2:] if texto[:2].lower() == "0x" else ""
    if len(cuerpo) != 40 or any(c not in "0123456789abcdefABCDEF" for c in cuerpo):
        raise DatoWalletInvalido("Una dirección EVM es 0x seguido de 40 caracteres hexadecimales")
    # En minúsculas: las APIs no distinguen y así se comparan sin sorpresas.
    return "0x" + cuerpo.lower()


def _validarSolana(texto: str) -> str:
    datos = base58Decodificar(texto)
    if len(datos) == 64:
        raise SecretoRechazado("Eso tiene la longitud de una clave privada de Solana. No la introduzcas aquí.")
    if len(datos) != 32:
        raise DatoWalletInvalido("Una dirección de Solana son 32 bytes en base58")
    return texto


def _validarXrp(texto: str) -> str:
    if texto.startswith("s"):
        raise SecretoRechazado("Las semillas de XRP empiezan por «s». No la introduzcas aquí.")
    datos = base58CheckDecodificar(texto, _ALFABETO_XRP)
    if len(datos) != 21 or datos[0] != 0x00:
        raise DatoWalletInvalido("No es una dirección clásica de XRP (empieza por «r»)")
    return texto


_VALIDADORES = {
    "btc": _validarBitcoin,
    "eth": _validarEvm,
    "bnb": _validarEvm,
    "sol": _validarSolana,
    "xrp": _validarXrp,
}


def normalizarDatoWallet(red: str, tipo: str, valor: str) -> str:
    """Valida lo que el usuario pega y lo devuelve en forma canónica.

    Args:
        red: Clave de `REDES`.
        tipo: `TIPO_DIRECCION` o `TIPO_XPUB`.
        valor: Dirección o clave pública extendida.

    Returns:
        El valor normalizado (p. ej. direcciones EVM en minúsculas).

    Raises:
        SecretoRechazado: si parece una clave privada o una semilla.
        DatoWalletInvalido: si no es válido para esa red.

    Example:
        >>> normalizarDatoWallet("eth", "direccion", "0xAbC...")  # doctest: +SKIP
    """
    if red not in REDES:
        raise DatoWalletInvalido("Red no soportada")
    texto = str(valor or "").strip()
    if not texto:
        raise DatoWalletInvalido("Falta la dirección o la clave pública")
    if len(texto) > 300:
        raise DatoWalletInvalido("Demasiado largo para ser una dirección o una xpub")
    _rechazarSemilla(texto)
    if tipo == TIPO_XPUB:
        if not REDES[red].admiteXpub:
            raise DatoWalletInvalido(f"{REDES[red].nombre} no usa claves públicas extendidas: indica la dirección")
        return leerClaveExtendida(texto).serializar()
    if tipo == TIPO_CLAVE_PUBLICA:
        if not REDES[red].admiteClavePublica:
            raise DatoWalletInvalido(f"En {REDES[red].nombre} indica la dirección, no la clave pública")
        # En EVM una clave tiene una única dirección: se devuelve esa, y quien
        # guarda la wallet la trata como una dirección más (`prepararDatoWallet`).
        if red in _REDES_EVM:
            return direccionEvmDeClavePublica(texto)
        return _leerClavePublica(texto).hex()
    if tipo != TIPO_DIRECCION:
        raise DatoWalletInvalido("Tipo de enlace no válido")
    return _VALIDADORES[red](texto)


def _pareceClaveExtendida(texto: str) -> bool:
    try:
        return len(base58CheckDecodificar(_quitarEnvolturaTaproot(texto)[0])) == 78
    except DatoWalletInvalido:
        return False


def _pareceClavePublicaHex(texto: str) -> bool:
    # 64 caracteres es una clave privada: se manda por la vía de la clave
    # pública para que se rechace como secreto y no como «formato no válido».
    hexadecimal = texto[2:] if texto[:2].lower() == "0x" else texto
    return len(hexadecimal) in (64, 66, 130) and all(c in "0123456789abcdefABCDEF" for c in hexadecimal)


def detectarTipo(red: str, valor: str) -> str:
    """Reconoce si lo pegado es una dirección, una clave extendida o una clave pública.

    Solo mira la forma; la validación completa la hace `normalizarDatoWallet`.
    Solo se proponen los tipos que admite la red; lo demás se trata como una
    dirección y la validación de la red lo rechaza con su propio mensaje.

    Example:
        >>> detectarTipo("btc", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")
        'direccion'
    """
    texto = str(valor or "").strip()
    if red not in REDES:
        return TIPO_DIRECCION
    if REDES[red].admiteXpub and _pareceClaveExtendida(texto):
        return TIPO_XPUB
    if REDES[red].admiteClavePublica and _pareceClavePublicaHex(texto):
        return TIPO_CLAVE_PUBLICA
    return TIPO_DIRECCION


def _redesQueLoAceptan(texto: str, salvo: str) -> list[str]:
    """Nombres de las otras redes donde el valor sí sería válido, para orientar el error."""
    nombres = []
    for clave, red in REDES.items():
        if clave == salvo or red.nombre in nombres:
            continue
        try:
            normalizarDatoWallet(clave, detectarTipo(clave, texto), texto)
        except DatoWalletInvalido:
            continue
        nombres.append(red.nombre)
    return nombres


def _forzarTipoDireccion(texto: str, tipoDireccion: str) -> str:
    # Misma clave con el prefijo SLIP-132 que corresponde (o envuelta en tr(…)
    # si es Taproot): así se guarda ya con el tipo de dirección bueno y el
    # lector no necesita saber nada más.
    clave = leerClaveExtendida(texto)
    version = _VERSION_POR_TIPO.get(tipoDireccion, _VERSION_POR_TIPO["p2pkh"])
    return replace(clave, version=version, tipoDireccion=tipoDireccion).serializar()


def prepararDatoWallet(red: str, tipo: str, valor: str) -> tuple[str, str]:
    """Resuelve el tipo pedido en el formulario y valida el valor.

    Acepta los de `TIPOS_ENTRADA`: con `TIPO_AUTO` se reconoce el formato, y
    con las variantes «xpub-…» la clave se guarda con el prefijo del tipo de
    dirección elegido. Una clave pública en una red EVM se guarda como su
    dirección. Si el valor no vale para la red elegida pero sí para otra, el
    error lo dice.

    Args:
        red: Clave de `REDES`.
        tipo: Uno de `TIPOS_ENTRADA`.
        valor: Lo que ha pegado el usuario.

    Returns:
        (tipo que se guarda, valor normalizado).

    Raises:
        SecretoRechazado: si parece una clave privada o una semilla.
        DatoWalletInvalido: si no es válido para esa red.

    Example:
        >>> prepararDatoWallet("btc", "auto", "0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798")
        ('clave', '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798')
    """
    if red not in REDES:
        raise DatoWalletInvalido("Red no soportada")
    if tipo not in TIPOS_ENTRADA:
        raise DatoWalletInvalido("Tipo de enlace no válido")
    if tipo == TIPO_AUTO:
        tipo = detectarTipo(red, valor)
    tipoDireccion = {
        TIPO_XPUB_SEGWIT: "p2wpkh", TIPO_XPUB_SEGWIT_COMPATIBLE: "p2sh-p2wpkh", TIPO_XPUB_TAPROOT: "p2tr",
    }.get(tipo)
    try:
        if tipoDireccion:
            normalizada = normalizarDatoWallet(red, TIPO_XPUB, valor)
            return TIPO_XPUB, _forzarTipoDireccion(normalizada, tipoDireccion)
        normalizado = normalizarDatoWallet(red, tipo, valor)
        if tipo == TIPO_CLAVE_PUBLICA and red in _REDES_EVM:
            return TIPO_DIRECCION, normalizado
        return tipo, normalizado
    except SecretoRechazado:
        raise
    except DatoWalletInvalido as error:
        otras = _redesQueLoAceptan(str(valor or "").strip(), red)
        if not otras:
            raise
        raise DatoWalletInvalido(f"No vale para {REDES[red].nombre}, pero sí para {' o '.join(otras)}: "
                                 "elige esa red") from error
