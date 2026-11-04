"""Pruebas de validación de direcciones y derivación de xpub.

Los vectores son los publicados en BIP 32, BIP 49 y BIP 84: si la aritmética de
la curva, RIPEMD-160, base58 o bech32 fallan en un solo bit, no coinciden.
"""

import hashlib
import os

import pytest

from core import cripto_direcciones as cd

# BIP 32, vector de prueba 2: clave maestra y su hijo no endurecido m/0.
_BIP32_V2_MAESTRA = (
    "xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB"
)
_BIP32_V2_HIJO0 = (
    "xpub69H7F5d8KSRgmmdJg2KhpAK8SR3DjMwAdkxj3ZuxV27CprR9LgpeyGmXUbC6wb7ERfvrnKZjXoUmmDznezpbZb7ap6r1D3tgFxHmwMkQTPH"
)
# BIP 32, vector 1: clave maestra. Su dirección P2PKH es conocida.
_BIP32_V1_MAESTRA = (
    "xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8"
)
# BIP 84: cuenta m/84'/0'/0' de la semilla de prueba.
_BIP84_ZPUB = (
    "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs"
)


def testRipemd160PuroCoincideConLosVectores():
    assert cd.ripemd160Puro(b"").hex() == "9c1185a5c5e9fc54612808977ee8f548b2258d31"
    assert cd.ripemd160Puro(b"abc").hex() == "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc"


@pytest.mark.parametrize("largo", [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000])
def testRipemd160PuroCoincideConHashlibEnLosBordesDelRelleno(largo):
    try:
        hashlib.new("ripemd160")
    except ValueError:
        pytest.skip("Este OpenSSL no trae RIPEMD-160 para comparar")
    datos = os.urandom(largo)
    assert cd.ripemd160Puro(datos) == hashlib.new("ripemd160", datos).digest()


def testDerivacionPublicaBip32():
    assert cd.leerClaveExtendida(_BIP32_V2_MAESTRA).hijo(0).serializar() == _BIP32_V2_HIJO0


def testDireccionP2pkhDeLaMaestraBip32():
    assert cd.leerClaveExtendida(_BIP32_V1_MAESTRA).direccion() == "15mKKb2eos1hWa6tisdPwwDC1a5J1y9nma"


def testDireccionesBip84DeRecepcionYCambio():
    zpub = cd.leerClaveExtendida(_BIP84_ZPUB)

    assert list(zpub.direcciones(cd.RAMA_RECEPCION, 0, 2)) == [
        (0, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"),
        (1, "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g"),
    ]
    assert list(zpub.direcciones(cd.RAMA_CAMBIO, 0, 1)) == [(0, "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el")]


def testDireccionP2shP2wpkhBip49():
    # Vector de BIP 49 (testnet: versión P2SH 0xC4).
    clave = bytes.fromhex("03a1af804ac108a8a51782198c2d034b28bf90c8803f5a53f76276fa69a4eae77f")

    assert cd.direccionDeClave(clave, "p2sh-p2wpkh", versionP2sh=0xC4) == "2Mww8dCYPUpKHofjgcXcBCEGmniw9CoaiD2"


def testUnIndiceEndurecidoSeRechaza():
    with pytest.raises(cd.DatoWalletInvalido):
        cd.leerClaveExtendida(_BIP84_ZPUB).hijo(0x80000000)


def testUnaClavePrivadaExtendidaSeRechazaConSuPropioError():
    datos = cd.base58CheckDecodificar(_BIP32_V1_MAESTRA)
    xprv = cd.base58CheckCodificar(bytes.fromhex("0488ADE4") + datos[4:])

    with pytest.raises(cd.SecretoRechazado, match="PRIVADA"):
        cd.normalizarDatoWallet("btc", cd.TIPO_XPUB, xprv)


def testUnaFraseSemillaSeRechaza():
    semilla = " ".join(["abandon"] * 11 + ["about"])

    with pytest.raises(cd.SecretoRechazado, match="semilla"):
        cd.normalizarDatoWallet("btc", cd.TIPO_DIRECCION, semilla)


def testUnaClavePrivadaHexadecimalSeRechazaEnEvm():
    with pytest.raises(cd.SecretoRechazado):
        cd.normalizarDatoWallet("eth", cd.TIPO_DIRECCION, "0x" + "ab" * 32)


def testUnaSemillaXrpSeRechaza():
    with pytest.raises(cd.SecretoRechazado):
        cd.normalizarDatoWallet("xrp", cd.TIPO_DIRECCION, "snoPBrXtMeMyMHUVTgbuqAfg1SUTb")


def testUnaXpubConUnCaracterCambiadoNoPasaLaSumaDeControl():
    alterada = _BIP84_ZPUB[:-1] + ("t" if _BIP84_ZPUB[-1] != "t" else "u")

    with pytest.raises(cd.DatoWalletInvalido):
        cd.normalizarDatoWallet("btc", cd.TIPO_XPUB, alterada)


def testSoloBitcoinAdmiteXpub():
    with pytest.raises(cd.DatoWalletInvalido, match="dirección"):
        cd.normalizarDatoWallet("eth", cd.TIPO_XPUB, _BIP84_ZPUB)


@pytest.mark.parametrize("red, entrada, esperada", [
    ("btc", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"),
    ("btc", "BC1QCR8TE4KR609GCAWUTMRZA0J4XV80JY8Z306FYU", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"),
    ("btc", "15mKKb2eos1hWa6tisdPwwDC1a5J1y9nma", "15mKKb2eos1hWa6tisdPwwDC1a5J1y9nma"),
    ("eth", "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01", "0xabcdef0123456789abcdef0123456789abcdef01"),
    ("bnb", " 0xabcdef0123456789abcdef0123456789abcdef01 ", "0xabcdef0123456789abcdef0123456789abcdef01"),
    ("sol", "11111111111111111111111111111111", "11111111111111111111111111111111"),
    ("xrp", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"),
])
def testDireccionesValidasSeNormalizan(red, entrada, esperada):
    assert cd.normalizarDatoWallet(red, cd.TIPO_DIRECCION, entrada) == esperada


@pytest.mark.parametrize("red, entrada", [
    ("btc", "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyv"),
    ("btc", "15mKKb2eos1hWa6tisdPwwDC1a5J1y9nmb"),
    ("btc", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"),
    ("eth", "0x1234"),
    ("eth", "abcdef0123456789abcdef0123456789abcdef01"),
    ("sol", "0OIl"),
    ("xrp", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTi"),
    ("doge", "D8vFz4p1L37jdg47HXKtSHA5uYLYxbGgPD"),
    ("btc", ""),
])
def testDireccionesInvalidasSeRechazan(red, entrada):
    with pytest.raises(cd.DatoWalletInvalido):
        cd.normalizarDatoWallet(red, cd.TIPO_DIRECCION, entrada)


# ── Claves públicas sueltas y detección del formato ──────────────────────────

# El generador de secp256k1 (clave pública de la privada 1): sus direcciones
# son conocidas y BIP 173 lo usa como ejemplo de P2WPKH.
_G_COMPRIMIDA = "0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798"
_G_SIN_COMPRIMIR = (
    "0479BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798"
    "483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8"
)
# BIP 86, m/86'/0'/0'/0/0 de la semilla de prueba: clave interna y su dirección.
_BIP86_INTERNA = "02cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115"
_BIP86_DIRECCION = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr"


def _conVersion(version: str, extendida: str = _BIP84_ZPUB) -> str:
    return cd.base58CheckCodificar(bytes.fromhex(version) + cd.base58CheckDecodificar(extendida)[4:])


def testDireccionTaprootBip86():
    assert cd.direccionDeClave(bytes.fromhex(_BIP86_INTERNA), "p2tr") == _BIP86_DIRECCION


def testDireccionesDeUnaClaveComprimida():
    assert cd.direccionesDeClavePublica(_G_COMPRIMIDA)[:3] == [
        "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
        cd.direccionDeClave(bytes.fromhex(_G_COMPRIMIDA), "p2sh-p2wpkh"),
        "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    ]
    assert cd.direccionesDeClavePublica(_G_COMPRIMIDA)[3].startswith("bc1p")


def testUnaClaveSinComprimirIncluyeSuP2pkhAntiguaYLasDeSuFormaComprimida():
    direcciones = cd.direccionesDeClavePublica(_G_SIN_COMPRIMIR)

    assert direcciones[0] == "1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm"
    assert direcciones[1:] == cd.direccionesDeClavePublica(_G_COMPRIMIDA)


def testClavesP2pkDanLasDosFormasEmpezandoPorLaQueVino():
    comprimida, sinComprimir = _G_COMPRIMIDA.lower(), _G_SIN_COMPRIMIR.lower()

    assert cd.clavesP2pk(_G_COMPRIMIDA) == [comprimida, sinComprimir]
    assert cd.clavesP2pk(_G_SIN_COMPRIMIR) == [sinComprimir, comprimida]


@pytest.mark.parametrize("entrada", [
    "02" + "00" * 32,              # x = 0 no está en la curva
    _G_SIN_COMPRIMIR[:-2] + "B9",  # y que no corresponde a x
    _G_COMPRIMIDA[:-1],            # longitud impar
    "05" + _G_COMPRIMIDA[2:],      # prefijo que no existe
])
def testClavesPublicasInvalidasSeRechazan(entrada):
    with pytest.raises(cd.DatoWalletInvalido):
        cd.normalizarDatoWallet("btc", cd.TIPO_CLAVE_PUBLICA, entrada)


def testLaClavePublicaSeGuardaEnMinusculas():
    assert cd.normalizarDatoWallet("btc", cd.TIPO_CLAVE_PUBLICA, _G_COMPRIMIDA) == _G_COMPRIMIDA.lower()


@pytest.mark.parametrize("red", ["sol", "xrp"])
def testLasRedesSinClavePublicaPidenLaDireccion(red):
    with pytest.raises(cd.DatoWalletInvalido, match="dirección"):
        cd.normalizarDatoWallet(red, cd.TIPO_CLAVE_PUBLICA, _G_COMPRIMIDA)


@pytest.mark.parametrize("entrada, tipo", [
    (_BIP84_ZPUB, cd.TIPO_XPUB),
    (_BIP32_V1_MAESTRA, cd.TIPO_XPUB),
    (_G_COMPRIMIDA, cd.TIPO_CLAVE_PUBLICA),
    (_G_SIN_COMPRIMIR.lower(), cd.TIPO_CLAVE_PUBLICA),
    ("15mKKb2eos1hWa6tisdPwwDC1a5J1y9nma", cd.TIPO_DIRECCION),
    ("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", cd.TIPO_DIRECCION),
    ("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", cd.TIPO_DIRECCION),
    (_BIP86_DIRECCION, cd.TIPO_DIRECCION),
])
def testLaDeteccionAutomaticaReconoceCadaFormato(entrada, tipo):
    guardado, _valor = cd.prepararDatoWallet("btc", cd.TIPO_AUTO, entrada)

    assert guardado == tipo


def testFueraDeBitcoinLaDeteccionSiempreDaDireccion():
    assert cd.prepararDatoWallet("eth", cd.TIPO_AUTO, "0x" + "ab" * 20) == (cd.TIPO_DIRECCION, "0x" + "ab" * 20)


@pytest.mark.parametrize("tipo, version", [
    (cd.TIPO_XPUB_SEGWIT, "04B24746"),
    (cd.TIPO_XPUB_SEGWIT_COMPATIBLE, "049D7CB2"),
])
def testUnaXpubDeCuentaSegwitSeGuardaConElPrefijoDeSuTipo(tipo, version):
    xpub = _conVersion("0488B21E")

    guardado, valor = cd.prepararDatoWallet("btc", tipo, xpub)

    assert (guardado, valor) == (cd.TIPO_XPUB, _conVersion(version))


def testLaXpubForzadaASegwitDerivaLasDireccionesBip84():
    _tipo, valor = cd.prepararDatoWallet("btc", cd.TIPO_XPUB_SEGWIT, _conVersion("0488B21E"))

    assert next(cd.leerClaveExtendida(valor).direcciones(cd.RAMA_RECEPCION, 0, 1)) == (
        0, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu")


def testUnaClaveMultifirmaSeRechazaConSuPropioMensaje():
    with pytest.raises(cd.DatoWalletInvalido, match="multifirma"):
        cd.prepararDatoWallet("btc", cd.TIPO_AUTO, _conVersion("02AA7ED3"))


@pytest.mark.parametrize("entrada", [
    "ab" * 32,
    "0x" + "ab" * 32,
    cd.base58CheckCodificar(b"\x80" + (1).to_bytes(32, "big")),            # WIF sin comprimir (5…)
    cd.base58CheckCodificar(b"\x80" + (1).to_bytes(32, "big") + b"\x01"),  # WIF comprimida (K…/L…)
    _conVersion("02AA7A99"),                                                # Zprv
])
def testLasClavesPrivadasSeRechazanComoSecretoEnModoAutomatico(entrada):
    with pytest.raises(cd.SecretoRechazado):
        cd.prepararDatoWallet("btc", cd.TIPO_AUTO, entrada)


def testSiValeParaOtraRedElErrorLaNombra():
    with pytest.raises(cd.DatoWalletInvalido, match="sí para Bitcoin"):
        cd.prepararDatoWallet("eth", cd.TIPO_AUTO, "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")
    with pytest.raises(cd.DatoWalletInvalido, match="Ethereum o BNB Smart Chain"):
        cd.prepararDatoWallet("btc", cd.TIPO_AUTO, "0x" + "ab" * 20)


def testUnTipoDeEntradaDesconocidoSeRechaza():
    with pytest.raises(cd.DatoWalletInvalido, match="Tipo"):
        cd.prepararDatoWallet("btc", "otra", _BIP84_ZPUB)


# ── Keccak-256 y claves públicas en redes EVM ────────────────────────────────

# Dirección EVM de la clave privada 1 (la pública es el generador).
_EVM_DE_G = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"


@pytest.mark.parametrize("datos, esperado", [
    (b"", "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"),
    (b"abc", "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"),
])
def testKeccak256CoincideConLosVectores(datos, esperado):
    assert cd.keccak256(datos).hex() == esperado


@pytest.mark.parametrize("largo", [0, 1, 135, 136, 137, 271, 272, 1000])
def testLaEsponjaConElRellenoDeSha3CoincideConHashlibEnLosBordesDelBloque(largo):
    datos = os.urandom(largo)

    assert cd._esponjaKeccak(datos, 0x06) == hashlib.sha3_256(datos).digest()


@pytest.mark.parametrize("clave", [_G_COMPRIMIDA, _G_SIN_COMPRIMIR, "0x" + _G_SIN_COMPRIMIR.lower()])
def testDireccionEvmDeUnaClavePublica(clave):
    assert cd.direccionEvmDeClavePublica(clave) == _EVM_DE_G


@pytest.mark.parametrize("red", ["eth", "bnb"])
def testEnEvmLaClavePublicaSeGuardaComoSuDireccion(red):
    assert cd.prepararDatoWallet(red, cd.TIPO_AUTO, _G_SIN_COMPRIMIR) == (cd.TIPO_DIRECCION, _EVM_DE_G)
    assert cd.prepararDatoWallet(red, cd.TIPO_CLAVE_PUBLICA, _G_COMPRIMIDA) == (cd.TIPO_DIRECCION, _EVM_DE_G)


def testEnEvmUnaClavePrivadaSigueRechazandoseEnModoAutomatico():
    with pytest.raises(cd.SecretoRechazado):
        cd.prepararDatoWallet("eth", cd.TIPO_AUTO, "0x" + "ab" * 32)


# ── xpub de cuentas Taproot (BIP 86) ─────────────────────────────────────────

# Cuenta m/86'/0'/0' de la semilla de prueba de BIP 86.
_BIP86_XPUB = (
    "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ"
)


def testUnaXpubTaprootSeGuardaEnvueltaYDerivaLasDireccionesBip86():
    tipo, valor = cd.prepararDatoWallet("btc", cd.TIPO_XPUB_TAPROOT, _BIP86_XPUB)
    clave = cd.leerClaveExtendida(valor)

    assert (tipo, valor) == (cd.TIPO_XPUB, f"tr({_BIP86_XPUB})")
    assert list(clave.direcciones(cd.RAMA_RECEPCION, 0, 2)) == [
        (0, _BIP86_DIRECCION),
        (1, "bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh"),
    ]
    assert list(clave.direcciones(cd.RAMA_CAMBIO, 0, 1)) == [
        (0, "bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7"),
    ]


def testUnaZpubForzadaATaprootSeGuardaConPrefijoXpub():
    _tipo, valor = cd.prepararDatoWallet("btc", cd.TIPO_XPUB_TAPROOT, _BIP84_ZPUB)

    assert valor == f"tr({_conVersion('0488B21E')})"


def testLaFormaEnvueltaSeReconoceEnModoAutomatico():
    assert cd.prepararDatoWallet("btc", cd.TIPO_AUTO, f" TR({_BIP86_XPUB}) ") == (cd.TIPO_XPUB, f"tr({_BIP86_XPUB})")


def testUnaPrivadaEnvueltaEnTrSigueRechazandose():
    with pytest.raises(cd.SecretoRechazado):
        cd.prepararDatoWallet("btc", cd.TIPO_AUTO, f"tr({_conVersion('0488ADE4', _BIP86_XPUB)})")
