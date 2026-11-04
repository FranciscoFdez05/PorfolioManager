"""Pruebas del seguimiento de wallets y de sus avisos por Telegram."""

import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest

from core import wallets_vigilancia as wv
from core.wallets_libreta import EntradaLibreta, Libreta
from providers.blockchain_clients import ENVIADA, RECIBIDA, ErrorFueraDePlan, ErrorLecturaWallet, MovimientoWallet
from stores import wallets_store as ws

_SECRET = "c" * 64
_DIRECCION = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"


def _mov(hash_, cantidad="0.5", tipo=RECIBIDA, minuto=0, contrato="", simbolo="BTC"):
    return MovimientoWallet(red="btc", hash=hash_, fecha=datetime(2026, 5, 1, 10, minuto, tzinfo=timezone.utc),
                            simbolo=simbolo, cantidad=Decimal(cantidad), comision=None, tipo=tipo,
                            contraparte="bc1qcontrapartecontrapartecontraparte", contrato=contrato)


class Lector:
    def __init__(self):
        self.movimientos = []
        self.saldoActual = Decimal("1.25")

    def saldo(self, tipo, valor):
        return self.saldoActual

    def leer(self, tipo, valor, limite):
        return list(self.movimientos)


@pytest.fixture
def entorno(tmp_path, monkeypatch):
    monkeypatch.setenv("SECRET_KEY", _SECRET)
    repositorio = ws.WalletsRepository(ruta=tmp_path / "wallets.key")
    lector = Lector()
    enviados = []
    vigilante = wv.VigilanteWallets(
        repositorio=repositorio,
        fabricaLectores=lambda red: lector,
        notificar=lambda categoria, texto: enviados.append((categoria, texto)) or True,
        precioEur=lambda assetId: Decimal("60000"),
        # Sin red: las listas públicas de tokens se descargarían en cada prueba.
        leerTokensPublicos=lambda: [],
    )
    return repositorio, lector, enviados, vigilante


def _enlazar(repositorio, **cambios):
    datos = {"id": ws.nuevoId(), "alias": "Satoshi", "red": "btc", "tipo": "direccion", "valor": _DIRECCION,
             "assetId": "btc", "creada": ws.ahoraIso(), "propia": False, "avisos": True, **cambios}
    return repositorio.anadir(ws.Wallet(**datos))


def testLaPrimeraRevisionSoloMemorizaYLaSiguienteAvisaDeLoNuevo(entorno):
    repositorio, lector, enviados, vigilante = entorno
    wallet = _enlazar(repositorio)
    lector.movimientos = [_mov("viejo1"), _mov("viejo2")]

    primera, avisos = vigilante.revisar(wallet.id)

    assert avisos == 0 and enviados == []
    assert primera.saldo == "1.25" and primera.vigilanciaIniciada
    assert [m["hash"] for m in primera.recientes] == ["viejo1", "viejo2"]

    lector.movimientos = [_mov("nuevo2", minuto=5), _mov("nuevo1", minuto=1), _mov("viejo1"), _mov("viejo2")]
    _segunda, avisos = vigilante.revisar(wallet.id)

    assert avisos == 2
    assert [c for c, _t in enviados] == ["wallets", "wallets"]
    assert "Satoshi" in enviados[0][1] and "30.000,00 €" in enviados[0][1]
    assert _DIRECCION not in enviados[0][1]

    _tercera, avisos = vigilante.revisar(wallet.id)
    assert avisos == 0


def testLosAvisosSalenEnOrdenCronologico(entorno):
    repositorio, lector, enviados, vigilante = entorno
    wallet = _enlazar(repositorio)
    vigilante.revisar(wallet.id)
    lector.movimientos = [_mov("b" * 64, minuto=9), _mov("a" * 64, minuto=1)]

    vigilante.revisar(wallet.id)

    assert ["10:01" in t for _c, t in enviados] == [True, False]


def testSinAvisosActivadosNoSeMandaNadaPeroSeMemoriza(entorno):
    repositorio, lector, enviados, vigilante = entorno
    wallet = _enlazar(repositorio, avisos=False)
    vigilante.revisar(wallet.id)
    lector.movimientos = [_mov("n1")]

    vigilante.revisar(wallet.id)
    repositorio.actualizar(wallet.id, avisos=True)
    vigilante.revisar(wallet.id)

    assert enviados == []


def testElUmbralFiltraLaMonedaYLosTokens(entorno):
    repositorio, lector, enviados, vigilante = entorno
    wallet = _enlazar(repositorio, umbralAviso="100")
    vigilante.revisar(wallet.id)
    lector.movimientos = [
        _mov("pequeno", cantidad="0.01"),
        _mov("grande", cantidad="150", tipo=ENVIADA),
        _mov("token", cantidad="5000", contrato="0xtoken", simbolo="USDT"),
    ]

    vigilante.revisar(wallet.id)

    assert len(enviados) == 1
    assert "enviada 150 BTC" in enviados[0][1]


def testUnaWalletQueFallaNoImpideRevisarLasDemas(entorno):
    repositorio, lector, _enviados, _vigilante = entorno
    mala = _enlazar(repositorio, red="eth", valor="0x" + "1" * 40)
    buena = _enlazar(repositorio)

    def fabrica(red):
        if red == "eth":
            class Roto:
                def saldo(self, tipo, valor):
                    raise ErrorLecturaWallet("Etherscan caído")
            return Roto()
        return lector

    vigilante = wv.VigilanteWallets(repositorio=repositorio, fabricaLectores=fabrica,
                                    notificar=lambda c, t: True, precioEur=lambda a: None)
    vigilante.revisarTodas()

    assert repositorio.obtener(buena.id).saldo == "1.25"
    assert repositorio.obtener(mala.id).saldo == ""


def testLosHashesConocidosTienenTope(entorno, monkeypatch):
    repositorio, lector, _enviados, vigilante = entorno
    monkeypatch.setattr(wv, "_MAX_HASHES", 3)
    wallet = _enlazar(repositorio)
    lector.movimientos = [_mov(f"h{i}") for i in range(5)]

    actualizada, _ = vigilante.revisar(wallet.id)

    assert len(actualizada.hashesConocidos) == 3


def testElTextoNoLlevaPrecioParaTokens():
    wallet = ws.Wallet(id="w", alias="Mi ETH", red="eth", tipo="direccion", valor="0x" + "a" * 40,
                       assetId="eth", creada="")
    token = _mov("0x" + "f" * 64, cantidad="10", contrato="0xusdt", simbolo="USDT")

    texto = wv.textoAviso(wallet, token, Decimal("3000"))

    assert "€" not in texto and "10 USDT" in texto and "Ethereum" in texto


@pytest.mark.parametrize("seguimiento, esperado", [
    ("", "Wallet «Mi ETH»"),
    ("mi eth", "Wallet «Mi ETH»"),
    ("Ledger", "Wallet «Ledger · Mi ETH»"),
])
def testElAvisoNombraElSeguimiento(seguimiento, esperado):
    wallet = ws.Wallet(id="w", alias="Mi ETH", red="eth", tipo="direccion", valor="0x" + "a" * 40,
                       assetId="eth", creada="", seguimiento=seguimiento)

    texto = wv.textoAviso(wallet, _mov("0x" + "f" * 64), None)

    assert texto.startswith(f"{esperado} (Ethereum)")


def testLosTiposDeAvisoFiltranLosMovimientos(entorno):
    repositorio, lector, enviados, vigilante = entorno
    wallet = _enlazar(repositorio, avisosConfig={"recibidas": False, "tokens": False})
    vigilante.revisar(wallet.id)
    lector.movimientos = [
        _mov("entrada"),
        _mov("salida", tipo=ENVIADA, minuto=1),
        _mov("token", tipo=ENVIADA, minuto=2, contrato="0xt", simbolo="USDT"),
    ]

    vigilante.revisar(wallet.id)

    assert len(enviados) == 1 and "enviada 0.5 BTC" in enviados[0][1]


def testElMinimoEnEurosUsaElPrecioDelActivo(entorno):
    repositorio, lector, enviados, vigilante = entorno
    wallet = _enlazar(repositorio, avisosConfig={"minimoEur": "10000"})
    vigilante.revisar(wallet.id)
    lector.movimientos = [_mov("poco", cantidad="0.1"), _mov("mucho", cantidad="0.2", minuto=1)]

    vigilante.revisar(wallet.id)

    assert len(enviados) == 1 and "0.2 BTC" in enviados[0][1]


def testElSaldoAvisaSoloAlCruzarElLimite(entorno):
    repositorio, lector, enviados, vigilante = entorno
    wallet = _enlazar(repositorio, avisosConfig={"saldoMinimo": "1"})
    vigilante.revisar(wallet.id)

    lector.saldoActual = Decimal("0.4")
    vigilante.revisar(wallet.id)
    vigilante.revisar(wallet.id)
    assert len(enviados) == 1 and "ha bajado de 1 BTC" in enviados[0][1] and "0.4 BTC" in enviados[0][1]

    lector.saldoActual = Decimal("2")
    vigilante.revisar(wallet.id)
    lector.saldoActual = Decimal("0.5")
    vigilante.revisar(wallet.id)
    assert len(enviados) == 2


def testUnCruceConLosAvisosApagadosNoAvisaAlEncenderlos(entorno):
    repositorio, lector, enviados, vigilante = entorno
    wallet = _enlazar(repositorio, avisos=False, avisosConfig={"saldoMaximo": "1"})
    vigilante.revisar(wallet.id)
    vigilante.revisar(wallet.id)

    repositorio.actualizar(wallet.id, avisos=True)
    vigilante.revisar(wallet.id)

    assert enviados == []


def testLaWalletQueDespiertaAvisa(entorno):
    repositorio, lector, enviados, vigilante = entorno
    wallet = _enlazar(repositorio, avisosConfig={"despiertaDias": "365", "recibidas": False})
    lector.movimientos = [replace(_mov("antiguo"), fecha=datetime(2020, 1, 1, tzinfo=timezone.utc))]
    vigilante.revisar(wallet.id)
    lector.movimientos = [_mov("nuevo"), *lector.movimientos]

    vigilante.revisar(wallet.id)

    assert len(enviados) == 1 and "vuelve a moverse tras" in enviados[0][1]


def testAgruparMandaUnSoloMensaje(entorno):
    repositorio, lector, enviados, vigilante = entorno
    wallet = _enlazar(repositorio, avisosConfig={"agrupar": True})
    vigilante.revisar(wallet.id)
    lector.movimientos = [_mov(f"n{i}", minuto=i) for i in range(4)]

    _wallet, avisos = vigilante.revisar(wallet.id)

    assert avisos == 1 and enviados[0][1].startswith("4 avisos de «Satoshi»:")


def testElTopeResumeElResto(entorno):
    repositorio, lector, enviados, vigilante = entorno
    wallet = _enlazar(repositorio, avisosConfig={"maxPorRevision": 2})
    vigilante.revisar(wallet.id)
    lector.movimientos = [_mov(f"n{i}", minuto=i) for i in range(5)]

    _wallet, avisos = vigilante.revisar(wallet.id)

    assert avisos == 2 and enviados[1][1].startswith("Y 4 avisos más de «Satoshi»:")


def testEnHorasDeSilencioSeGuardaYSeMandaAgrupadoAlAcabar(entorno):
    repositorio, lector, enviados, _vigilante = entorno
    hora = {"ahora": datetime(2026, 5, 1, 2, 0)}
    vigilante = wv.VigilanteWallets(
        repositorio=repositorio,
        fabricaLectores=lambda red: lector,
        notificar=lambda categoria, texto: enviados.append((categoria, texto)) or True,
        precioEur=lambda assetId: None,
        ahora=lambda: hora["ahora"],
    )
    wallet = _enlazar(repositorio, avisosConfig={"silencioDesde": "23:00", "silencioHasta": "08:00"})
    vigilante.revisar(wallet.id)
    lector.movimientos = [_mov("n1"), _mov("n2", minuto=1)]

    callada, avisos = vigilante.revisar(wallet.id)
    assert avisos == 0 and enviados == [] and len(callada.avisosPendientes) == 2
    assert callada.resumen()["avisosPendientes"] == 2

    hora["ahora"] = datetime(2026, 5, 1, 9, 0)
    despierta, avisos = vigilante.revisar(wallet.id)

    assert avisos == 1 and despierta.avisosPendientes == []
    assert enviados[0][1].startswith("Durante las horas de silencio, 2 avisos de «Satoshi»:")


def testLosPendientesTienenTope(entorno, monkeypatch):
    repositorio, lector, _enviados, _vigilante = entorno
    monkeypatch.setattr(wv.wallets_avisos, "MAX_PENDIENTES", 3)
    vigilante = wv.VigilanteWallets(repositorio=repositorio, fabricaLectores=lambda red: lector,
                                    notificar=lambda c, t: True, precioEur=lambda a: None,
                                    ahora=lambda: datetime(2026, 5, 1, 2, 0))
    wallet = _enlazar(repositorio, avisosConfig={"silencioDesde": "00:00", "silencioHasta": "08:00"})
    vigilante.revisar(wallet.id)
    lector.movimientos = [_mov(f"n{i}", minuto=i) for i in range(5)]

    actualizada, _ = vigilante.revisar(wallet.id)

    assert len(actualizada.avisosPendientes) == 3 and "10:04" in actualizada.avisosPendientes[-1]


@pytest.mark.parametrize("contenido, esperado", [
    (None, 15),
    ({"walletsVigilanciaMinutos": 60}, 60),
    ({"walletsVigilanciaMinutos": 0}, 0),
    ({"walletsVigilanciaMinutos": 7}, 15),
    ("no es json", 15),
])
def testMinutosVigilancia(tmp_path, monkeypatch, contenido, esperado):
    from core import paths

    ruta = tmp_path / "ajustes.json"
    if contenido is not None:
        ruta.write_text(contenido if isinstance(contenido, str) else json.dumps(contenido), "utf-8")
    monkeypatch.setattr(paths, "AJUSTES_JSON", ruta)

    assert wv.minutosVigilancia() == esperado


def testLaLibretaDecideElTipoDelAvisoYNombraLaContraparte(entorno):
    repositorio, lector, enviados, vigilante = entorno
    wallet = _enlazar(repositorio, avisosConfig={"internas": False})
    vigilante.revisar(wallet.id)
    repositorio.guardarDireccion(ws.DireccionMarcada("btc", "bc1qcontrapartecontrapartecontraparte", "Exodus",
                                                     propia=False))
    lector.movimientos = [_mov("entrada")]

    vigilante.revisar(wallet.id)
    assert len(enviados) == 1 and "Desde: Exodus" in enviados[0][1]

    # Marcada como propia, es «entre wallets» y esos avisos están apagados.
    repositorio.guardarDireccion(ws.DireccionMarcada("btc", "bc1qcontrapartecontrapartecontraparte", "Exodus",
                                                     propia=True))
    lector.movimientos = [_mov("otra", minuto=1)]
    vigilante.revisar(wallet.id)
    assert len(enviados) == 1


def testElTextoDeUnMovimientoEntreWalletsPropias():
    wallet = ws.Wallet(id="w", alias="Ledger", red="btc", tipo="direccion", valor=_DIRECCION, assetId="btc",
                       creada="")
    libreta = Libreta([EntradaLibreta("btc", "bc1qcontrapartecontrapartecontraparte", "", propia=True)])

    texto = wv.textoAviso(wallet, _mov("h", tipo=ENVIADA), None, libreta)

    assert "entre wallets propias 0.5 BTC" in texto
    assert "Hacia: bc1qcont" in texto


_SOSPECHOSOS = {"direccionNueva": True, "vaciado": True, "polvo": True, "rafaga": True}


def _envio(hash_, contraparte, minuto=0, cantidad="0.5"):
    return replace(_mov(hash_, cantidad=cantidad, tipo=ENVIADA, minuto=minuto), contraparte=contraparte)


def testUnEnvioAUnaDireccionNuevaAvisaAunqueLosEnviosEstenApagados(entorno):
    repositorio, lector, enviados, vigilante = entorno
    wallet = _enlazar(repositorio, avisosConfig={**_SOSPECHOSOS, "enviadas": False})
    lector.movimientos = [_envio("viejo", "bc1qconocidaconocidaconocida")]
    vigilante.revisar(wallet.id)
    lector.movimientos = [_envio("a", "bc1qconocidaconocidaconocida", minuto=1),
                          _envio("b", "bc1qdesconocidadesconocida", minuto=2), *lector.movimientos]

    vigilante.revisar(wallet.id)

    assert len(enviados) == 1
    assert enviados[0][1].startswith("Posible movimiento sospechoso: envío a una dirección nunca vista.")


def testUnaWalletAntiguaApuntaSusContrapartesSinAvisar(entorno):
    repositorio, lector, enviados, vigilante = entorno
    wallet = _enlazar(repositorio, avisosConfig=_SOSPECHOSOS)
    lector.movimientos = [_envio("viejo", "bc1qconocidaconocidaconocida")]
    vigilante.revisar(wallet.id)
    # Como si la hubiera escrito una versión sin el aviso de dirección nueva.
    repositorio.actualizar(wallet.id, contrapartesConocidas=None)
    lector.movimientos = [_envio("a", "bc1qdesconocidadesconocida", minuto=1), *lector.movimientos]

    actualizada, _avisos = vigilante.revisar(wallet.id)

    assert not any("nunca vista" in texto for _categoria, texto in enviados)
    assert "bc1qdesconocidadesconocida" in actualizada.contrapartesConocidas


def testElVaciadoYLaRafagaAvisan(entorno):
    repositorio, lector, enviados, vigilante = entorno
    wallet = _enlazar(repositorio, avisosConfig={**_SOSPECHOSOS, "direccionNueva": False, "enviadas": False})
    lector.saldoActual = Decimal("10")
    vigilante.revisar(wallet.id)
    lector.saldoActual = Decimal("0.2")
    lector.movimientos = [_envio(f"n{i}", "bc1qladronladronladronladron", minuto=i) for i in range(3)]

    vigilante.revisar(wallet.id)

    textos = [texto for _categoria, texto in enviados]
    assert len(textos) == 2
    assert "ha hecho 3 envíos desde la última revisión" in textos[0]
    assert "casi vaciada. Saldo: 10 → 0.2 BTC" in textos[1]


def testElPolvoRecibidoSeMarcaComoSospechoso(entorno):
    repositorio, lector, enviados, vigilante = entorno
    wallet = _enlazar(repositorio, avisosConfig={"polvo": True})
    vigilante.revisar(wallet.id)
    lector.movimientos = [_mov("polvo", cantidad="0.00000546"), _mov("normal", cantidad="0.5", minuto=1)]

    vigilante.revisar(wallet.id)

    textos = [texto for _categoria, texto in enviados]
    assert len(textos) == 2
    assert textos[0].startswith("Posible movimiento sospechoso: importe ínfimo (polvo).")
    assert not textos[1].startswith("Posible")


# ── Tokens: la decisión sobre un contrato vale para lo que vuelva a llegar ────

_ETH = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045"
_PEPE_BUENO = "0x" + "a" * 40
_PEPE_FALSO = "0x" + "b" * 40
_SPAM = "0x" + "c" * 40
_SIN_VERIFICAR = "0x" + "d" * 40


def _token(hash_, contrato, simbolo, minuto=0):
    return replace(_mov(hash_, cantidad="1000", minuto=minuto, contrato=contrato, simbolo=simbolo), red="eth")


@pytest.fixture
def tokensEth(entorno):
    repositorio, lector, _enviados, _vigilante = entorno
    repositorio.verificarToken(ws.TokenVerificado("eth", _PEPE_BUENO, "PEPE"))
    repositorio.marcarToken(ws.TokenMarcado("eth", _SPAM, ws.MARCA_IMITACION))
    lector.movimientos = [_token("viejo", _PEPE_BUENO, "PEPE")]
    return entorno


@pytest.mark.parametrize("imitaciones", [False, True])
def testCadaTokenAvisaConElEstadoDeSuContrato(tokensEth, imitaciones):
    repositorio, lector, enviados, vigilante = tokensEth
    wallet = _enlazar(repositorio, red="eth", valor=_ETH, assetId="eth", avisosConfig={"imitaciones": imitaciones})
    vigilante.revisar(wallet.id)
    lector.movimientos = [
        _token("bueno", _PEPE_BUENO, "PEPE", minuto=1),
        _token("falso", _PEPE_FALSO, "PEPE", minuto=2),
        _token("marcado", _SPAM, "AIRDROP", minuto=3),
        _token("nuevo", _SIN_VERIFICAR, "LINK", minuto=4),
    ]

    vigilante.revisar(wallet.id)

    textos = [texto for _categoria, texto in enviados]
    assert "1000 PEPE · token verificado" in textos[0]
    assert "1000 LINK\n" in textos[-1] and "·" not in textos[-1].split("\n")[0]
    deImitaciones = textos[1:-1]
    if not imitaciones:
        # Ni la imitación detectada (otro contrato con el símbolo verificado)
        # ni la marcada por el usuario avisan como un movimiento normal.
        assert deImitaciones == []
    else:
        assert len(deImitaciones) == 2
        for texto in deImitaciones:
            assert texto.startswith("Posible movimiento sospechoso: token imitación")
            assert "· imitación" in texto


def testUnaMarcaNuevaValeParaLoQueVuelvaALlegarDeEseContrato(tokensEth):
    repositorio, lector, enviados, vigilante = tokensEth
    wallet = _enlazar(repositorio, red="eth", valor=_ETH, assetId="eth")
    vigilante.revisar(wallet.id)
    lector.movimientos = [_token("primero", _SIN_VERIFICAR, "LINK", minuto=1)]
    vigilante.revisar(wallet.id)
    assert len(enviados) == 1

    repositorio.marcarToken(ws.TokenMarcado("eth", _SIN_VERIFICAR, ws.MARCA_IMITACION))
    lector.movimientos = [_token("segundo", _SIN_VERIFICAR, "LINK", minuto=2), *lector.movimientos]
    vigilante.revisar(wallet.id)

    assert len(enviados) == 1


def testSinTokensNoSeLeenNiLasMarcasNiLasListas(entorno):
    repositorio, lector, enviados, _vigilante = entorno
    leidas = []
    vigilante = wv.VigilanteWallets(
        repositorio=repositorio, fabricaLectores=lambda red: lector,
        notificar=lambda categoria, texto: enviados.append(texto) or True,
        precioEur=lambda assetId: Decimal("60000"), leerTokensPublicos=lambda: leidas.append(1) or [],
    )
    wallet = _enlazar(repositorio)
    vigilante.revisar(wallet.id)
    lector.movimientos = [_mov("nuevo")]

    vigilante.revisar(wallet.id)

    assert len(enviados) == 1 and leidas == []


# ── Revisión de todas: un hilo por red ────────────────────────────────────────

class _RepositorioLista:
    def __init__(self, wallets):
        self._wallets = wallets

    def listar(self):
        return self._wallets


class _LectorFueraDePlan:
    """Lector de una red que su API no cubre; como el real, anota el fallo en su fila."""

    def __init__(self, filas):
        self.lecturas = 0
        self._filas = filas

    def saldo(self, tipo, valor):
        self.lecturas += 1
        self._filas["BNB Chain"] = {"estado": "plan"}
        raise ErrorFueraDePlan("El plan no cubre esta red", "BNB Chain")


@pytest.fixture
def fueraDePlan(tmp_path, monkeypatch):
    """Dos wallets de BNB fuera de plan, una de BTC sana y un reloj y una fila que se pueden mover."""
    monkeypatch.setenv("SECRET_KEY", _SECRET)
    monkeypatch.setattr(wv, "_pausasPlan", {})
    repositorio = ws.WalletsRepository(ruta=tmp_path / "wallets.key")
    _enlazar(repositorio, red="bnb", valor="0x" + "1" * 40)
    _enlazar(repositorio, red="bnb", valor="0x" + "2" * 40)
    sana = _enlazar(repositorio)
    filas = {}
    bnb, btc = _LectorFueraDePlan(filas), Lector()
    reloj = {"ahora": datetime(2026, 5, 1, 10, 0, tzinfo=timezone.utc)}
    vigilante = wv.VigilanteWallets(
        repositorio=repositorio,
        fabricaLectores=lambda red: bnb if red == "bnb" else btc,
        notificar=lambda c, t: True,
        precioEur=lambda a: None,
        ahoraUtc=lambda: reloj["ahora"],
        ultimosResultados=lambda: filas,
    )
    return SimpleNamespace(vigilante=vigilante, bnb=bnb, reloj=reloj, filas=filas, repositorio=repositorio, sana=sana)


def testFueraDePlanSeIntentaUnaVezYSeAvisaUnaVez(fueraDePlan, caplog):
    with caplog.at_level("WARNING", logger=wv.log.name):
        fueraDePlan.vigilante.revisarTodas()
        fueraDePlan.vigilante.revisarTodas()

    assert fueraDePlan.bnb.lecturas == 1
    assert caplog.text.count("en pausa") == 1


def testFueraDePlanNoAfectaALasOtrasRedes(fueraDePlan):
    fueraDePlan.vigilante.revisarTodas()

    assert fueraDePlan.repositorio.obtener(fueraDePlan.sana.id).saldo == "1.25"


def testLaPausaAcabaAlPasarElPlazo(fueraDePlan):
    fueraDePlan.vigilante.revisarTodas()

    fueraDePlan.reloj["ahora"] += wv._pausaFueraDePlan - timedelta(seconds=1)
    fueraDePlan.vigilante.revisarTodas()
    assert fueraDePlan.bnb.lecturas == 1

    fueraDePlan.reloj["ahora"] += timedelta(seconds=1)
    fueraDePlan.vigilante.revisarTodas()
    assert fueraDePlan.bnb.lecturas == 2


@pytest.mark.parametrize("filas", [{}, {"BNB Chain": {"estado": "ok"}}])
def testLaPausaAcabaSiLaFilaDejaDeDecirPlan(fueraDePlan, filas):
    """Cambiar de API o de clave olvida la fila; Comprobar o una lectura buena la pone en ok."""
    fueraDePlan.vigilante.revisarTodas()

    fueraDePlan.filas.clear()
    fueraDePlan.filas.update(filas)
    fueraDePlan.vigilante.revisarTodas()

    assert fueraDePlan.bnb.lecturas == 2


def testLaPausaNoImpideRevisarUnaWalletAMano(fueraDePlan):
    fueraDePlan.vigilante.revisarTodas()
    wallet = next(w for w in fueraDePlan.repositorio.listar() if w.red == "bnb")

    with pytest.raises(ErrorFueraDePlan):
        fueraDePlan.vigilante.revisar(wallet.id)

    assert fueraDePlan.bnb.lecturas == 2


def testUnFalloCorrienteNoPausaLaRed(fueraDePlan):
    def saldo(tipo, valor):
        fueraDePlan.bnb.lecturas += 1
        raise ErrorLecturaWallet("Etherscan caído")

    fueraDePlan.bnb.saldo = saldo

    fueraDePlan.vigilante.revisarTodas()

    assert fueraDePlan.bnb.lecturas == 2


def testRevisarTodasVaEnUnHiloPorRedYEnOrdenDentroDeCadaRed(monkeypatch):
    import threading
    from contextlib import contextmanager
    from types import SimpleNamespace

    wallets = [SimpleNamespace(id=f"{red}-{i}", red=red) for red in ("btc", "eth", "sol") for i in range(3)]
    vigilante = wv.VigilanteWallets(repositorio=_RepositorioLista(wallets))
    revisadas, contextos = [], []

    def revisar(walletId):
        revisadas.append((walletId, threading.current_thread().name))
        if walletId == "eth-1":
            raise ErrorLecturaWallet("sin red")
        return None, 1

    @contextmanager
    def contexto():
        contextos.append(threading.current_thread().name)
        yield

    monkeypatch.setattr(vigilante, "revisar", revisar)

    enviados = vigilante.revisarTodas(contexto=contexto)

    assert enviados == 8
    porRed = {}
    for walletId, hilo in revisadas:
        porRed.setdefault(walletId.split("-")[0], []).append((walletId, hilo))
    for red, lista in porRed.items():
        assert [w for w, _ in lista] == [f"{red}-0", f"{red}-1", f"{red}-2"]
        assert len({h for _, h in lista}) == 1
    assert len(contextos) == 3
