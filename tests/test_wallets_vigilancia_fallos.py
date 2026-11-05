"""La vigilancia cuando algo va mal: lecturas que fallan, que no alcanzan y avisos sin entregar."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from core import wallets_avisos, wallets_vigilancia as wv
from providers.blockchain_clients import ENVIADA, RECIBIDA, ErrorFueraDePlan, ErrorLecturaWallet, MovimientoWallet
from stores import wallets_store as ws

_SECRET = "a" * 64
_DIRECCION = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
_VACIADA = {"vaciado": True}


def _mov(indice: int, tipo: str = RECIBIDA) -> MovimientoWallet:
    return MovimientoWallet(red="btc", hash=f"h{indice}", fecha=datetime(2026, 1, 1, tzinfo=UTC) + timedelta(minutes=indice),
                            simbolo="BTC", cantidad=Decimal("0.5"), comision=None, tipo=tipo, contraparte="bc1qotra")


class _Lector:
    def __init__(self):
        self.movimientos = []
        self.saldoActual = Decimal("1")
        self.limites = []
        self.errorEn = None

    def saldo(self, tipo, valor):
        return self.saldoActual

    def leer(self, tipo, valor, limite):
        self.limites.append(limite)
        if self.errorEn == limite:
            raise ErrorLecturaWallet("sin red")
        return self.movimientos[:limite]


@pytest.fixture
def entorno(tmp_path, monkeypatch):
    monkeypatch.setenv("SECRET_KEY", _SECRET)
    monkeypatch.setattr(wv, "_pausasPlan", {})
    repositorio = ws.WalletsRepository(ruta=tmp_path / "wallets.key")
    lector = _Lector()
    enviados = []

    def vigilante(notificar=None, puedeAvisar=lambda categoria: True, **extra):
        return wv.VigilanteWallets(
            repositorio=repositorio, fabricaLectores=lambda red: lector,
            notificar=notificar or (lambda categoria, texto: enviados.append(texto) or True),
            precioEur=lambda assetId: Decimal("60000"), leerTokensPublicos=lambda: [],
            puedeAvisar=puedeAvisar, **extra,
        )

    return repositorio, lector, enviados, vigilante


def _enlazar(repositorio, **cambios):
    datos = {"id": ws.nuevoId(), "alias": "Ballena", "red": "btc", "tipo": "direccion", "valor": _DIRECCION,
             "assetId": "btc", "creada": ws.ahoraIso(), "propia": False, "avisos": True, "vigilanciaIniciada": True,
             **cambios}
    return repositorio.anadir(ws.Wallet(**datos))


# ── Fallos visibles ───────────────────────────────────────────────────────────

def testUnaLecturaAManoFallidaAnotaElMotivoYSigueSubiendoElError(entorno):
    repositorio, lector, _enviados, vigilante = entorno
    wallet = _enlazar(repositorio)
    lector.errorEn = wv._LIMITE_LECTURA

    with pytest.raises(ErrorLecturaWallet, match="sin red"):
        vigilante().revisarAnotandoFallo(wallet.id)

    fallida = repositorio.obtener(wallet.id)
    assert fallida.ultimoError == "sin red" and fallida.ultimoErrorFecha


def testUnaLecturaAManoCorrectaDevuelveLoMismoQueRevisar(entorno):
    repositorio, _lector, _enviados, vigilante = entorno
    wallet = _enlazar(repositorio)

    leida, avisos = vigilante().revisarAnotandoFallo(wallet.id)

    assert leida.saldoFecha and leida.ultimoError == "" and avisos == 0


def testUnFalloQuedaEnLaWalletYSeBorraAlLeerBien(entorno):
    repositorio, lector, _enviados, vigilante = entorno
    wallet = _enlazar(repositorio)
    lector.errorEn = wv._LIMITE_LECTURA

    assert vigilante()._revisarSinFallar(wallet) == 0
    fallida = repositorio.obtener(wallet.id)
    assert fallida.ultimoError == "sin red" and fallida.ultimoErrorFecha
    assert fallida.resumen()["ultimoError"] == "sin red"

    lector.errorEn = None
    vigilante().revisar(wallet.id)

    leida = repositorio.obtener(wallet.id)
    assert (leida.ultimoError, leida.ultimoErrorFecha) == ("", "")


def testUnaRedEnPausaAnotaElMotivoEnTodasSusWallets(entorno):
    repositorio, lector, _enviados, vigilante = entorno
    primera = _enlazar(repositorio, propia=True)
    segunda = _enlazar(repositorio, propia=True, valor="bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", alias="Otra")
    filas = {}

    def saldo(tipo, valor):
        filas["fila"] = {"estado": "plan"}
        raise ErrorFueraDePlan("El plan no cubre esta red", "fila")

    lector.saldo = saldo
    vigilante(ultimosResultados=lambda: filas).revisarTodas()

    assert repositorio.obtener(primera.id).ultimoError == "El plan no cubre esta red"
    assert repositorio.obtener(segunda.id).ultimoError == "El plan no cubre esta red"


def testUnFalloAlAnotarNoCortaLaPasada(entorno):
    repositorio, lector, _enviados, vigilante = entorno
    wallet = _enlazar(repositorio)
    lector.errorEn = wv._LIMITE_LECTURA
    probado = vigilante()
    probado._repositorio.actualizar = lambda *a, **k: (_ for _ in ()).throw(OSError("disco lleno"))

    assert probado._revisarSinFallar(wallet) == 0


# ── Lecturas que no alcanzan ──────────────────────────────────────────────────

def testConLoYaVistoAlAlcanceNoSeAmplia(entorno):
    repositorio, lector, _enviados, vigilante = entorno
    lector.movimientos = [_mov(i) for i in range(30, 0, -1)]
    wallet = _enlazar(repositorio, hashesConocidos=["h10|BTC"])

    vigilante().revisar(wallet.id)

    assert lector.limites == [wv._LIMITE_LECTURA]
    assert repositorio.obtener(wallet.id).lecturaIncompleta is False


def testSiNadaEsConocidoSeAmpliaYSeEnlaza(entorno):
    repositorio, lector, enviados, vigilante = entorno
    lector.movimientos = [_mov(i) for i in range(40, 0, -1)]
    wallet = _enlazar(repositorio, hashesConocidos=["h1|BTC"])

    vigilante().revisar(wallet.id)

    assert lector.limites == [wv._LIMITE_LECTURA, wv._LIMITE_AMPLIADO]
    assert repositorio.obtener(wallet.id).lecturaIncompleta is False
    # Los 39 nuevos avisan, no solo los 25 de la lectura corta.
    assert len(enviados) == 39


def testSiNiLaAmpliadaAlcanzaSeMarcaYSeAvisa(entorno):
    repositorio, lector, enviados, vigilante = entorno
    lector.movimientos = [_mov(i) for i in range(wv._LIMITE_AMPLIADO + 5, 0, -1)]
    wallet = _enlazar(repositorio, hashesConocidos=["h1|BTC"])

    vigilante().revisar(wallet.id)

    assert repositorio.obtener(wallet.id).lecturaIncompleta is True
    assert any("Puede haber otros" in texto for texto in enviados)


def testSiFallaLaAmpliadaSeSigueConLaCortaMarcada(entorno):
    repositorio, lector, _enviados, vigilante = entorno
    lector.movimientos = [_mov(i) for i in range(40, 0, -1)]
    lector.errorEn = wv._LIMITE_AMPLIADO
    wallet = _enlazar(repositorio, hashesConocidos=["h1|BTC"])

    actualizada, _ = vigilante().revisar(wallet.id)

    assert actualizada.lecturaIncompleta is True and actualizada.ultimoError == ""


def testLaPrimeraRevisionNoAmplia(entorno):
    repositorio, lector, enviados, vigilante = entorno
    lector.movimientos = [_mov(i) for i in range(40, 0, -1)]
    wallet = _enlazar(repositorio, vigilanciaIniciada=False)

    vigilante().revisar(wallet.id)

    assert lector.limites == [wv._LIMITE_LECTURA] and enviados == []


# ── Avisos sin entregar ───────────────────────────────────────────────────────

def _sospechoso(lector, repositorio):
    """Una wallet que se vacía: su aviso es de los que se reintentan."""
    lector.movimientos = [_mov(2, ENVIADA), _mov(1)]
    lector.saldoActual = Decimal("0.001")
    return _enlazar(repositorio, saldo="1", hashesConocidos=["h1|BTC"], avisosConfig=_VACIADA)


def testSiTelegramFallaElSospechosoSeReintentaYElRestoNo(entorno):
    repositorio, lector, enviados, vigilante = entorno
    wallet = _sospechoso(lector, repositorio)

    vigilante(notificar=lambda categoria, texto: False).revisar(wallet.id)

    guardados = repositorio.obtener(wallet.id).avisosReintento
    assert len(guardados) == 1 and guardados[0].startswith("Posible movimiento sospechoso")
    assert repositorio.obtener(wallet.id).resumen()["avisosReintento"] == 1

    _, mandados = vigilante().revisar(wallet.id)

    assert mandados == 1 and "no se pudieron entregar" in enviados[0] and "casi vaciada" in enviados[0]
    assert repositorio.obtener(wallet.id).avisosReintento == []


def testSinTelegramOSilenciadoNoSeGuardaNada(entorno):
    repositorio, lector, _enviados, vigilante = entorno
    wallet = _sospechoso(lector, repositorio)

    vigilante(notificar=lambda categoria, texto: False, puedeAvisar=lambda categoria: False).revisar(wallet.id)

    assert repositorio.obtener(wallet.id).avisosReintento == []


def testEnHorasDeSilencioSeConservanLosReintentos(entorno):
    repositorio, lector, enviados, vigilante = entorno
    wallet = _enlazar(repositorio, avisosReintento=["Posible movimiento sospechoso: x"],
                      avisosConfig={"silencioDesde": "00:00", "silencioHasta": "23:59"})
    lector.movimientos = []

    vigilante(ahora=lambda: datetime(2026, 1, 1, 12, 0)).revisar(wallet.id)

    assert repositorio.obtener(wallet.id).avisosReintento == ["Posible movimiento sospechoso: x"] and not enviados


# ── Mensajes largos ───────────────────────────────────────────────────────────

def testTrocearNoPasaDelMaximoNiParteUnAviso():
    avisos = [f"aviso {i} " + "x" * 300 for i in range(40)]

    trozos = wallets_avisos.trocear("\n\n".join(avisos))

    assert len(trozos) > 1
    assert all(len(trozo) <= wallets_avisos.MAX_LARGO_MENSAJE for trozo in trozos)
    assert "\n\n".join(trozos).split("\n\n") == avisos


def testUnTextoCortoNoSeParte():
    assert wallets_avisos.trocear("corto") == ["corto"]


def testSinTopeElegidoSeAplicaElMaximo():
    mensajes = wallets_avisos.componerMensajes("Ballena", ["a"] * 120, wallets_avisos.ConfigAvisos())

    assert len(mensajes) == wallets_avisos.MAX_AVISOS_REVISION


# ── Precio de la moneda ───────────────────────────────────────────────────────

@pytest.fixture
def precios(monkeypatch):
    activos = {}
    tickers = {}
    monkeypatch.setattr(wv, "precioEurDeActivo", lambda assetId: activos.get(assetId))
    monkeypatch.setattr(wv, "precioEurDeTicker", lambda proveedor, ticker: tickers.get(ticker))
    monkeypatch.setattr("stores.asset_store.listarActivosCripto",
                        lambda: [{"id": "a-btc", "name": "Bitcoin", "symbol": "BTC", "marketSymbol": ""}])
    return activos, tickers


def testElTickerPuestoAManoMandaSobreElActivo(precios):
    activos, tickers = precios
    activos["mio"], tickers["BTC-EUR"] = Decimal("1"), Decimal("2")
    ticker = ws.TokenPrecio(red="btc", contrato="", proveedor="yahoo", ticker="BTC-EUR")

    assert wv.precioEurDeMoneda("btc", "mio", ticker) == Decimal("2")


def testSinTickerValeElActivoDeLaWallet(precios):
    precios[0]["mio"] = Decimal("1")

    assert wv.precioEurDeMoneda("btc", "mio") == Decimal("1")


def testSinActivoSeBuscaPorElSimboloDeLaRed(precios):
    precios[0]["a-btc"] = Decimal("3")

    assert wv.precioEurDeMoneda("btc", "") == Decimal("3")
    # El activo elegido puede ser de otro portfolio: aquí no da precio.
    assert wv.precioEurDeMoneda("btc", "de-otro-portfolio") == Decimal("3")


def testSinNadaNoHayPrecio(precios):
    assert wv.precioEurDeMoneda("eth", "") is None


# ── Canal de avisos ───────────────────────────────────────────────────────────

@pytest.mark.parametrize(("configurado", "permitido", "esperado"), [
    (("token", "chat"), True, True),
    (("token", "chat"), False, False),
    (("", ""), True, False),
])
def testPuedeAvisarDistingueLoQueQuiereElUsuario(monkeypatch, configurado, permitido, esperado):
    from core import telegram_notifier

    monkeypatch.setattr(telegram_notifier, "leerConfig", lambda: configurado)
    monkeypatch.setattr(telegram_notifier, "_permitido", lambda categoria: permitido)

    assert telegram_notifier.puedeAvisar("wallets") is esperado
