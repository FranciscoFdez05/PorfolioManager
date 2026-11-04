"""Pruebas del repositorio cifrado de wallets (stores/wallets_store.py).

Lo que importa aquí es la seguridad: el valor nunca en claro en disco, nada se
guarda sin una SECRET_KEY de calidad, y el resumen que ven las rutas no lleva
el valor completo.
"""

import json
from dataclasses import asdict, replace

import pytest

from stores import wallets_store as ws

_SECRET = "a" * 16 + "0123456789abcdef0123456789abcdef"
_XPUB = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs"


@pytest.fixture
def repositorio(tmp_path, monkeypatch):
    monkeypatch.setenv("SECRET_KEY", _SECRET)
    return ws.WalletsRepository(ruta=tmp_path / "wallets.key")


def _wallet(valor=_XPUB, red="btc", tipo="xpub"):
    return ws.Wallet(id=ws.nuevoId(), alias="Ledger", red=red, tipo=tipo, valor=valor,
                     assetId="btc", creada=ws.ahoraIso())


def testGuardaCifradoYLeeLoMismo(repositorio):
    wallet = repositorio.anadir(_wallet())

    contenido = repositorio.ruta.read_bytes()
    assert contenido.startswith(b"WAL1:")
    assert _XPUB.encode() not in contenido
    assert b"Ledger" not in contenido
    assert repositorio.listar() == [wallet]


def testSinSecretKeyNoGuardaNada(tmp_path, monkeypatch):
    monkeypatch.delenv("SECRET_KEY", raising=False)
    repositorio = ws.WalletsRepository(ruta=tmp_path / "wallets.key")

    with pytest.raises(ws.CifradoNoDisponible):
        repositorio.anadir(_wallet())
    assert not repositorio.ruta.exists()


@pytest.mark.parametrize("secreto", ["corta", "cambia_esto_por_una_clave_aleatoria_larga"])
def testUnaSecretKeyDebilOEjemploNoSirve(tmp_path, monkeypatch, secreto):
    monkeypatch.setenv("SECRET_KEY", secreto)

    with pytest.raises(ws.CifradoNoDisponible):
        ws.WalletsRepository(ruta=tmp_path / "wallets.key").anadir(_wallet())


def testRecuperaElFicheroEnvueltoPorLaMigracionDeClaves(repositorio):
    # Lo que hacía server.py al arrancar: tomar wallets.key por una clave en
    # claro y cifrarlo otra vez con el formato ENC1: de API/*.key.
    from core.secret_store import migratePlaintextIfNeeded

    wallet = repositorio.anadir(_wallet())
    assert migratePlaintextIfNeeded(repositorio.ruta)
    assert repositorio.ruta.read_bytes().startswith(b"ENC1:")

    assert repositorio.listar() == [wallet]
    repositorio.marcarSincronizada(wallet.id, ws.ahoraIso())
    assert repositorio.ruta.read_bytes().startswith(b"WAL1:")


def testUnFicheroSinFormatoSigueSiendoIlegible(repositorio):
    repositorio.ruta.write_bytes(b"basura")

    with pytest.raises(ws.AlmacenIlegible, match="formato esperado"):
        repositorio.listar()


def testConOtraSecretKeyEsIlegible(repositorio, monkeypatch):
    repositorio.anadir(_wallet())
    monkeypatch.setenv("SECRET_KEY", "b" * 64)

    with pytest.raises(ws.AlmacenIlegible, match="SECRET_KEY"):
        repositorio.listar()


def testUnFicheroAjenoEsIlegible(repositorio):
    repositorio.ruta.write_text("bc1q en claro")

    with pytest.raises(ws.AlmacenIlegible):
        repositorio.listar()


def testNoSeEnlazaDosVecesLaMisma(repositorio):
    repositorio.anadir(_wallet())

    with pytest.raises(ws.WalletError, match="ya está enlazada"):
        repositorio.anadir(_wallet())


def testElLimiteDeWallets(repositorio, monkeypatch):
    monkeypatch.setattr(ws, "MAX_WALLETS", 1)
    repositorio.anadir(_wallet())

    with pytest.raises(ws.LimiteWallets):
        repositorio.anadir(_wallet(valor="0x" + "1" * 40, red="eth", tipo="direccion"))


def testSinTopeDeWalletsPorDefecto(repositorio):
    for indice in range(60):
        repositorio.anadir(_wallet(valor="0x" + format(indice, "040x"), red="eth", tipo="direccion"))

    assert len(repositorio.listar()) == 60


def testAjustarSeguimientoMezclaLaConfigDeCadaWallet(repositorio):
    primera = repositorio.anadir(_wallet())
    segunda = repositorio.anadir(_wallet(valor="0x" + "1" * 40, red="eth", tipo="direccion"))
    repositorio.actualizar(segunda.id, avisosConfig={"agrupar": True})

    wallets = repositorio.ajustarSeguimiento("ledger", lambda actual: {**actual, "despiertaDias": 90}, avisos=True)

    assert {w.id for w in wallets} == {primera.id, segunda.id}
    porId = {w.id: w for w in repositorio.listar()}
    assert porId[primera.id].avisosConfig == {"despiertaDias": 90}
    assert porId[segunda.id].avisosConfig == {"agrupar": True, "despiertaDias": 90}
    assert all(w.avisos for w in porId.values())


def testAjustarSeguimientoNoGuardaNadaSiLaMezclaFalla(repositorio):
    wallet = repositorio.anadir(_wallet())

    def falla(actual):
        raise ValueError("no válida")

    with pytest.raises(ValueError):
        repositorio.ajustarSeguimiento("ledger", falla, avisos=True)

    assert repositorio.obtener(wallet.id).avisos is False


def testEliminarYMarcarSincronizada(repositorio):
    primera = repositorio.anadir(_wallet())
    segunda = repositorio.anadir(_wallet(valor="0x" + "1" * 40, red="eth", tipo="direccion"))

    repositorio.marcarSincronizada(segunda.id, "2026-10-28T10:00:00+00:00")
    repositorio.eliminar(primera.id)

    assert [w.id for w in repositorio.listar()] == [segunda.id]
    assert repositorio.obtener(segunda.id).ultimaSincronizacion == "2026-10-28T10:00:00+00:00"
    with pytest.raises(ws.WalletNoEncontrada):
        repositorio.eliminar(primera.id)


def testSinFicheroNoHayWallets(repositorio):
    assert repositorio.listar() == []


def testElResumenNoLlevaElValor():
    resumen = _wallet().resumen()

    assert "valor" not in resumen
    assert _XPUB not in str(resumen)
    assert resumen["valorEnmascarado"] == "zpub6rFR…tZYs"


@pytest.mark.parametrize("valor, esperado", [
    ("", ""),
    ("rCorta", "…orta"),
    ("0x1234567890abcdef1234567890abcdef12345678", "0x123456…5678"),
])
def testEnmascarar(valor, esperado):
    assert ws.enmascarar(valor) == esperado


# ── Seguimientos: varias wallets agrupadas ────────────────────────────────────

_DIRECCION_BTC = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
_DIRECCION_ETH = "0x" + "b" * 40


def testUnSeguimientoAgrupaWalletsDeRedesDistintas(repositorio):
    repositorio.anadir(_wallet())
    repositorio.anadir(replace(_wallet(_DIRECCION_BTC, tipo="direccion"), alias="Cuenta 2", seguimiento="ledger"))
    repositorio.anadir(replace(_wallet(_DIRECCION_ETH, red="eth", tipo="direccion"), alias="ETH",
                               seguimiento=" LEDGER "))

    resumenes = [w.resumen() for w in repositorio.listar()]

    assert {r["seguimientoClave"] for r in resumenes} == {"ledger"}
    assert [r["seguimiento"] for r in resumenes] == ["Ledger", "ledger", " LEDGER "]


def testSinSeguimientoElGrupoEsSuAlias():
    wallet = _wallet()

    assert (wallet.nombreSeguimiento, wallet.claveSeguimiento) == ("Ledger", "ledger")
    assert ws.claveSeguimiento("  Mi   Ledger ") == "mi ledger"


def testUnSeguimientoNoMezclaPropiasYAjenas(repositorio):
    repositorio.anadir(_wallet())
    ajena = replace(_wallet(_DIRECCION_BTC, tipo="direccion"), propia=False, seguimiento="LEDGER")

    with pytest.raises(ws.WalletError, match="propias"):
        repositorio.anadir(ajena)
    assert len(repositorio.listar()) == 1
    assert repositorio.anadir(replace(ajena, seguimiento="Satoshi")).propia is False


def testRenombrarUnSeguimientoCambiaTodasSusWallets(repositorio):
    # La primera es de antes de los grupos: su seguimiento es su alias.
    repositorio.anadir(_wallet())
    repositorio.anadir(replace(_wallet(_DIRECCION_BTC, tipo="direccion"), alias="Cuenta 2", seguimiento="ledger"))
    otra = repositorio.anadir(replace(_wallet(_DIRECCION_ETH, red="eth", tipo="direccion"), seguimiento="Trezor"))

    renombradas = repositorio.renombrarSeguimiento("ledger", "Cold")

    assert [w.alias for w in renombradas] == ["Ledger", "Cuenta 2"]
    assert [w.nombreSeguimiento for w in repositorio.listar()] == ["Cold", "Cold", "Trezor"]
    assert repositorio.obtener(otra.id) == otra


def testRenombrarSoloCambiandoMayusculasVale(repositorio):
    repositorio.anadir(_wallet())

    assert [w.nombreSeguimiento for w in repositorio.renombrarSeguimiento("ledger", "LEDGER")] == ["LEDGER"]


def testRenombrarNoUneDosSeguimientos(repositorio):
    repositorio.anadir(_wallet())
    repositorio.anadir(replace(_wallet(_DIRECCION_BTC, tipo="direccion"), seguimiento="Trezor"))

    with pytest.raises(ws.WalletError, match="Ya hay"):
        repositorio.renombrarSeguimiento("ledger", " trezor")
    assert [w.nombreSeguimiento for w in repositorio.listar()] == ["Ledger", "Trezor"]


def testRenombrarUnSeguimientoQueNoExiste(repositorio):
    repositorio.anadir(_wallet())

    with pytest.raises(ws.WalletNoEncontrada):
        repositorio.renombrarSeguimiento("trezor", "Cold")


def testEliminarUnSeguimientoQuitaTodasSusWalletsYNadaMas(repositorio):
    repositorio.anadir(_wallet())
    repositorio.anadir(replace(_wallet(_DIRECCION_BTC, tipo="direccion"), alias="Cuenta 2", seguimiento="LEDGER"))
    otra = repositorio.anadir(replace(_wallet(_DIRECCION_ETH, red="eth", tipo="direccion"), seguimiento="Trezor"))

    quitadas = repositorio.eliminarSeguimiento("ledger")

    assert [w.alias for w in quitadas] == ["Ledger", "Cuenta 2"]
    assert repositorio.listar() == [otra]


def testEliminarUnSeguimientoQueNoExiste(repositorio):
    wallet = repositorio.anadir(_wallet())

    with pytest.raises(ws.WalletNoEncontrada):
        repositorio.eliminarSeguimiento("trezor")
    assert repositorio.listar() == [wallet]


def testLosTokensVerificadosSeGuardanCifradosJuntoALasWallets(repositorio):
    wallet = repositorio.anadir(_wallet())
    token = ws.TokenVerificado("eth", "0x" + "ab" * 20, "PEPE")

    assert repositorio.verificarToken(token) == [token]
    repositorio.marcarSincronizada(wallet.id, "2026-01-01T00:00:00+00:00")

    # Cambiar las wallets no pierde los tokens, ni al revés.
    assert repositorio.tokensVerificados() == [token]
    assert [w.id for w in repositorio.listar()] == [wallet.id]
    assert b"PEPE" not in repositorio.ruta.read_bytes()


def testVerificarDosVecesElMismoContratoNoLoDuplica(repositorio):
    contrato = "0x" + "ab" * 20
    repositorio.verificarToken(ws.TokenVerificado("eth", contrato, "PEPE"))

    tokens = repositorio.verificarToken(ws.TokenVerificado("eth", contrato, "PEPE2"))

    assert tokens == [ws.TokenVerificado("eth", contrato, "PEPE2")]


def testOlvidarUnTokenSoloQuitaEseContratoDeEsaRed(repositorio):
    contrato = "0x" + "ab" * 20
    enBnb = ws.TokenVerificado("bnb", contrato, "PEPE")
    repositorio.verificarToken(ws.TokenVerificado("eth", contrato, "PEPE"))
    repositorio.verificarToken(enBnb)

    assert repositorio.olvidarToken("eth", contrato) == [enBnb]
    assert repositorio.olvidarToken("eth", contrato) == [enBnb]


def testElLimiteDeTokensVerificados(repositorio, monkeypatch):
    monkeypatch.setattr(ws, "MAX_TOKENS_VERIFICADOS", 1)
    repositorio.verificarToken(ws.TokenVerificado("eth", "0x1", "PEPE"))

    with pytest.raises(ws.WalletError, match="Como máximo"):
        repositorio.verificarToken(ws.TokenVerificado("eth", "0x2", "SHIB"))
    # Volver a verificar uno que ya está no cuenta como uno más.
    assert repositorio.verificarToken(ws.TokenVerificado("eth", "0x1", "PEPE")) == [
        ws.TokenVerificado("eth", "0x1", "PEPE")
    ]


def testSinFicheroNoHayTokensVerificados(repositorio):
    assert repositorio.tokensVerificados() == []


def testMarcarUnTokenSustituyeLaMarcaAnteriorYSuVerificacion(repositorio):
    contrato = "0x" + "ab" * 20
    otro = ws.TokenVerificado("eth", "0x" + "cd" * 20, "PEPE")
    repositorio.verificarToken(ws.TokenVerificado("eth", contrato, "PEPE"))
    repositorio.verificarToken(otro)
    repositorio.marcarToken(ws.TokenMarcado("eth", contrato, ws.MARCA_IMITACION))

    marcas = repositorio.marcarToken(ws.TokenMarcado("eth", contrato, ws.MARCA_LEGITIMO))

    assert marcas == [ws.TokenMarcado("eth", contrato, ws.MARCA_LEGITIMO)]
    assert repositorio.marcasToken() == marcas
    assert repositorio.tokensVerificados() == [otro]
    assert b"legitimo" not in repositorio.ruta.read_bytes()


def testVerificarUnTokenQuitaSuMarca(repositorio):
    contrato = "0x" + "ab" * 20
    repositorio.marcarToken(ws.TokenMarcado("eth", contrato, ws.MARCA_IMITACION))

    repositorio.verificarToken(ws.TokenVerificado("eth", contrato, "PEPE"))

    assert repositorio.marcasToken() == []


def testDesmarcarSoloQuitaEseContratoDeEsaRed(repositorio):
    contrato = "0x" + "ab" * 20
    enBnb = ws.TokenMarcado("bnb", contrato, ws.MARCA_IMITACION)
    repositorio.marcarToken(ws.TokenMarcado("eth", contrato, ws.MARCA_IMITACION))
    repositorio.marcarToken(enBnb)

    assert repositorio.desmarcarToken("eth", contrato) == [enBnb]
    assert repositorio.desmarcarToken("eth", contrato) == [enBnb]


def testUnaMarcaDesconocidaNoSeGuarda(repositorio):
    with pytest.raises(ws.WalletError, match="no válida"):
        repositorio.marcarToken(ws.TokenMarcado("eth", "0x1", "quizas"))
    assert repositorio.marcasToken() == []


def testElLimiteDeTokensMarcados(repositorio, monkeypatch):
    monkeypatch.setattr(ws, "MAX_TOKENS_MARCADOS", 1)
    repositorio.marcarToken(ws.TokenMarcado("eth", "0x1", ws.MARCA_IMITACION))

    with pytest.raises(ws.WalletError, match="Como máximo"):
        repositorio.marcarToken(ws.TokenMarcado("eth", "0x2", ws.MARCA_IMITACION))
    # Cambiar la marca de uno que ya está no cuenta como uno más.
    assert repositorio.marcarToken(ws.TokenMarcado("eth", "0x1", ws.MARCA_LEGITIMO)) == [
        ws.TokenMarcado("eth", "0x1", ws.MARCA_LEGITIMO)
    ]


def testLibretaGuardaCifradaSustituyeEnSuSitioYOlvida(repositorio):
    primera = ws.DireccionMarcada("btc", "bc1qprimera", "Exchange", propia=False)
    segunda = ws.DireccionMarcada("btc", "bc1qsegunda", "Mamá", propia=False)
    repositorio.guardarDireccion(primera)
    repositorio.guardarDireccion(segunda)

    editada = replace(primera, apodo="Mi Exchange", propia=True)
    assert repositorio.guardarDireccion(editada) == [editada, segunda]
    assert "Mamá".encode() not in repositorio.ruta.read_bytes()
    assert repositorio.olvidarDireccion("btc", "bc1qprimera") == [segunda]
    assert repositorio.olvidarDireccion("btc", "bc1qprimera") == [segunda]
    # Otra red, aunque sea la misma cadena, es otra dirección.
    assert repositorio.olvidarDireccion("eth", "bc1qsegunda") == [segunda]


def testLibretaNoPisaLasWalletsNiLosTokens(repositorio):
    wallet = repositorio.anadir(_wallet())
    repositorio.verificarToken(ws.TokenVerificado("eth", "0x1", "USDC"))

    repositorio.guardarDireccion(ws.DireccionMarcada("btc", "bc1qx", "", propia=True))

    assert repositorio.listar() == [wallet]
    assert repositorio.tokensVerificados() == [ws.TokenVerificado("eth", "0x1", "USDC")]


def testElLimiteDeLaLibreta(repositorio, monkeypatch):
    monkeypatch.setattr(ws, "MAX_DIRECCIONES", 1)
    repositorio.guardarDireccion(ws.DireccionMarcada("btc", "bc1qa", "", propia=True))

    with pytest.raises(ws.WalletError, match="Como máximo"):
        repositorio.guardarDireccion(ws.DireccionMarcada("btc", "bc1qb", "", propia=True))
    # Editar una que ya está no cuenta como una más.
    repositorio.guardarDireccion(ws.DireccionMarcada("btc", "bc1qa", "Nueva", propia=False))


def testLasContrapartesTienenTopeYOlvidanLasMasAntiguas(repositorio, monkeypatch):
    monkeypatch.setattr(ws, "MAX_CONTRAPARTES", 2)
    contraparte = {"red": "btc", "direccion": "bc1qa", "sentido": "enviada"}

    repositorio.anotarContrapartes({"f1": contraparte, "f2": contraparte})
    repositorio.anotarContrapartes({"f3": contraparte})
    repositorio.anotarContrapartes({})

    assert list(repositorio.contrapartesImportadas()) == ["f2", "f3"]


# ── Propias cifradas en wallets.key, ajenas en wallets_ajenas.json ──────────────

def _ajena(valor="1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"):
    return ws.Wallet(id=ws.nuevoId(), alias="Satoshi", red="btc", tipo="direccion", valor=valor,
                     assetId="", creada=ws.ahoraIso(), propia=False)


def _cifradas(repositorio):
    """Las wallets que hay dentro de wallets.key, descifradas."""
    return [w["id"] for w in repositorio._leerDatos().get("wallets", [])]


def _escribirCifrado(repositorio, wallets):
    """wallets.key como quedaba antes de separar las ajenas."""
    claro = json.dumps({"wallets": [asdict(w) for w in wallets], "version": 1})
    repositorio.ruta.write_bytes(ws._PREFIJO + ws.fernetWallets().encrypt(claro.encode("utf-8")))


def _jsonAjenas(repositorio):
    return json.loads(repositorio.rutaAjenas.read_text(encoding="utf-8"))["wallets"]


def testLasAjenasVanAlJsonYLasPropiasAlCifrado(repositorio):
    propia = repositorio.anadir(_wallet())
    ajena = repositorio.anadir(_ajena())

    assert [w["id"] for w in _jsonAjenas(repositorio)] == [ajena.id]
    assert ajena.valor.encode() not in repositorio.ruta.read_bytes()
    assert _cifradas(repositorio) == [propia.id]
    assert [w.id for w in repositorio.listar()] == [propia.id, ajena.id]


def testSeguirAjenasNoNecesitaSecretKey(tmp_path):
    repositorio = ws.WalletsRepository(ruta=tmp_path / "wallets.key", proveedorFernet=lambda: None)

    ajena = repositorio.anadir(_ajena())
    repositorio.actualizar(ajena.id, avisos=True)

    assert not repositorio.ruta.exists()
    assert repositorio.obtener(ajena.id).avisos is True
    with pytest.raises(ws.CifradoNoDisponible):
        repositorio.anadir(_wallet())


def testUnaAjenaDeAntesSePasaAlJsonEnLaSiguienteEscritura(repositorio):
    # Como quedaba wallets.key antes de separarlas: la ajena dentro del cifrado.
    ajena = _ajena()
    _escribirCifrado(repositorio, [ajena])
    assert [w.id for w in repositorio.listar()] == [ajena.id]

    repositorio.actualizar(ajena.id, alias="Génesis")

    assert [w["alias"] for w in _jsonAjenas(repositorio)] == ["Génesis"]
    assert _cifradas(repositorio) == []


def testSiUnaAjenaQuedaEnLosDosFicherosMandaElJson(repositorio):
    ajena = _ajena()
    _escribirCifrado(repositorio, [ajena])
    repositorio._escribirAjenas([asdict(replace(ajena, alias="Nueva"))])

    assert [(w.id, w.alias) for w in repositorio.listar()] == [(ajena.id, "Nueva")]


def testCambiarUnaAjenaNoReescribeElCifrado(repositorio):
    repositorio.anadir(_wallet())
    ajena = repositorio.anadir(_ajena())
    antes = repositorio.ruta.read_bytes()

    repositorio.actualizar(ajena.id, saldo="1")

    assert repositorio.ruta.read_bytes() == antes


def testJsonDeAjenasDanado(repositorio):
    repositorio.rutaAjenas.write_text('{"wallets": "no"}', encoding="utf-8")

    with pytest.raises(ws.AlmacenIlegible):
        repositorio.listar()



# ── Sospechosos, tickers de precio y tokens conocidos ─────────────────────────

_CONTRATO = "0x" + "ab" * 20


def testEtiquetarSospechosoNoTocaLaMarcaNiLaVerificacion(repositorio):
    verificado = ws.TokenVerificado("eth", _CONTRATO, "PEPE")
    repositorio.verificarToken(verificado)

    repositorio.marcarSospechoso("eth", _CONTRATO)
    sospechosos = repositorio.marcarSospechoso("eth", _CONTRATO)

    # Etiquetarlo dos veces no lo duplica.
    assert sospechosos == [ws.TokenSospechoso("eth", _CONTRATO)]
    assert repositorio.tokensVerificados() == [verificado]
    assert repositorio.marcasToken() == []
    assert _CONTRATO.encode() not in repositorio.ruta.read_bytes()


def testDesmarcarSospechosoSoloQuitaEseContratoDeEsaRed(repositorio):
    repositorio.marcarSospechoso("eth", _CONTRATO)
    repositorio.marcarSospechoso("bnb", _CONTRATO)

    assert repositorio.desmarcarSospechoso("eth", _CONTRATO) == [ws.TokenSospechoso("bnb", _CONTRATO)]
    # Quitar uno que no estaba no falla.
    assert repositorio.desmarcarSospechoso("eth", _CONTRATO) == [ws.TokenSospechoso("bnb", _CONTRATO)]


def testHayTopeDeSospechosos(repositorio, monkeypatch):
    monkeypatch.setattr(ws, "MAX_TOKENS_SOSPECHOSOS", 1)
    repositorio.marcarSospechoso("eth", "0x1")

    with pytest.raises(ws.WalletError, match="Como máximo"):
        repositorio.marcarSospechoso("eth", "0x2")
    assert repositorio.marcarSospechoso("eth", "0x1") == [ws.TokenSospechoso("eth", "0x1")]


def testGuardarUnTickerSustituyeElAnteriorEnSuSitio(repositorio):
    otro = ws.TokenPrecio("eth", "0x2", "yahoo", "SHIB-USD")
    repositorio.guardarPrecioToken(ws.TokenPrecio("eth", _CONTRATO, "tradingview", "BINANCE:PEPEUSDT"))
    repositorio.guardarPrecioToken(otro)

    precios = repositorio.guardarPrecioToken(ws.TokenPrecio("eth", _CONTRATO, "finnhub", "BINANCE:PEPEUSDT"))

    assert precios == [ws.TokenPrecio("eth", _CONTRATO, "finnhub", "BINANCE:PEPEUSDT"), otro]
    assert repositorio.preciosToken() == precios
    assert b"PEPEUSDT" not in repositorio.ruta.read_bytes()


@pytest.mark.parametrize("precio, mensaje", [
    (ws.TokenPrecio("eth", "0x1", "bloomberg", "PEPE"), "Proveedor"),
    (ws.TokenPrecio("eth", "0x1", "tradingview", ""), "ticker"),
])
def testUnTickerNoValidoNoSeGuarda(repositorio, precio, mensaje):
    with pytest.raises(ws.WalletError, match=mensaje):
        repositorio.guardarPrecioToken(precio)
    assert repositorio.preciosToken() == []


def testQuitarUnTicker(repositorio):
    repositorio.guardarPrecioToken(ws.TokenPrecio("eth", _CONTRATO, "tradingview", "BINANCE:PEPEUSDT"))

    assert repositorio.quitarPrecioToken("eth", _CONTRATO) == []
    assert repositorio.quitarPrecioToken("eth", _CONTRATO) == []


def testAnotarTokensConocidosSoloAnadeLosNuevos(repositorio):
    pepe = ws.TokenConocido("eth", "0x1", "PEPE", "Pepe")
    assert repositorio.anotarTokensConocidos([pepe, pepe, ws.TokenConocido("bnb", "0x1", "PEPE")]) == 2

    # Ya anotado, aunque llegue con otro nombre, no se cambia ni se reescribe el fichero.
    antes = repositorio.ruta.read_bytes()
    assert repositorio.anotarTokensConocidos([ws.TokenConocido("eth", "0x1", "PEPE2")]) == 0
    assert repositorio.ruta.read_bytes() == antes
    assert repositorio.tokensConocidos() == [pepe, ws.TokenConocido("bnb", "0x1", "PEPE")]


def testAnotarTokensConocidosOlvidaLosMasAntiguosPasadoElTope(repositorio, monkeypatch):
    monkeypatch.setattr(ws, "MAX_TOKENS_CONOCIDOS", 2)
    tokens = [ws.TokenConocido("eth", f"0x{i}", f"T{i}") for i in range(3)]

    repositorio.anotarTokensConocidos(tokens[:2])
    repositorio.anotarTokensConocidos(tokens[2:])

    assert repositorio.tokensConocidos() == tokens[1:]


def testSinNadaAnotadoNoSeCreaElFichero(repositorio):
    assert repositorio.anotarTokensConocidos([]) == 0
    assert repositorio.tokensSospechosos() == []
    assert repositorio.preciosToken() == []
    assert not repositorio.ruta.exists()
