"""Medidas contra el bloqueo de las Esploras públicas.

blockstream.info y mempool.space cortan las ráfagas con 429 y, si siguen,
dejan de aceptar conexiones desde la IP. Con 30 wallets ajenas revisadas en
cada pasada, la de un usuario se quedaba sin leer. Aquí se comprueba:

* el ritmo entre llamadas a una misma Esplora (y que 0 lo desactiva);
* que la vigilancia revisa primero las propias;
* que las ajenas solo se revisan cada `[wallets] ajenas_cada_minutos`.
"""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from core import settings, wallets_vigilancia as wv
from core.cripto_direcciones import TIPO_DIRECCION
from providers import blockchain_clients as bc

_AHORA = datetime(2026, 11, 3, 20, 0, tzinfo=UTC)


def _fijarIntervalo(monkeypatch, segundos: float) -> None:
    monkeypatch.setattr(settings, "walletsEsploraIntervalo", lambda: segundos)
    bc.olvidarEsploraCaidas()


# ── Ritmo ─────────────────────────────────────────────────────────────────────


def testElRitmoEspaciaLasLlamadasAUnaMismaEsplora(monkeypatch):
    _fijarIntervalo(monkeypatch, 1.0)
    esperas = []

    for _ in range(3):
        bc.esperarTurnoEsplora("https://esplora.test/api", esperas.append)

    # La primera sale ya; las dos siguientes esperan su hueco (con algo menos
    # de un segundo por lo que tarda el propio bucle).
    assert len(esperas) == 2
    assert esperas[0] == pytest.approx(1.0, abs=0.1)
    assert esperas[1] == pytest.approx(2.0, abs=0.1)


def testCadaEsploraLlevaSuPropioRitmo(monkeypatch):
    _fijarIntervalo(monkeypatch, 1.0)
    esperas = []

    bc.esperarTurnoEsplora("https://una.test/api", esperas.append)
    bc.esperarTurnoEsplora("https://otra.test/api", esperas.append)

    assert esperas == []


def testIntervaloCeroNoEsperaNunca(monkeypatch):
    _fijarIntervalo(monkeypatch, 0.0)
    esperas = []

    for _ in range(5):
        bc.esperarTurnoEsplora("https://nodo.local/api", esperas.append)

    assert esperas == []


def testElLectorBitcoinRespetaElRitmo(monkeypatch):
    _fijarIntervalo(monkeypatch, 1.0)
    esperas = []
    info = {"chain_stats": {"tx_count": 1, "funded_txo_sum": 5000, "spent_txo_sum": 0}}
    lector = bc.LectorBitcoin(baseUrl="https://esplora.test/api", obtenerJson=lambda *a, **k: info,
                              respaldoUrl=None, dormir=esperas.append)

    lector.saldo(TIPO_DIRECCION, "bc1qprueba")
    lector.saldo(TIPO_DIRECCION, "bc1qprueba")

    assert len(esperas) == 1


# ── Qué revisa la vigilancia ──────────────────────────────────────────────────


def _wallet(id_: str, propia: bool, saldoFecha: str = "") -> SimpleNamespace:
    return SimpleNamespace(id=id_, red="btc", propia=propia, saldoFecha=saldoFecha)


def testLasPropiasSeRevisanSiempre():
    reciente = _wallet("p", True, (_AHORA - timedelta(minutes=1)).isoformat())
    assert wv.tocaRevisar(reciente, _AHORA, 360)


@pytest.mark.parametrize("hace, toca", [(10, False), (359, False), (360, True), (720, True)])
def testLasAjenasEsperanSuIntervalo(hace, toca):
    ajena = _wallet("a", False, (_AHORA - timedelta(minutes=hace)).isoformat())
    assert wv.tocaRevisar(ajena, _AHORA, 360) is toca


@pytest.mark.parametrize("saldoFecha", ["", "no es una fecha"])
def testUnaAjenaSinLecturaValidaSeRevisa(saldoFecha):
    assert wv.tocaRevisar(_wallet("a", False, saldoFecha), _AHORA, 360)


def testIntervaloCeroRevisaLasAjenasEnCadaPasada():
    ajena = _wallet("a", False, _AHORA.isoformat())
    assert wv.tocaRevisar(ajena, _AHORA, 0)


def testUnaFechaSinZonaSeTomaComoUtc():
    ajena = _wallet("a", False, (_AHORA - timedelta(minutes=10)).replace(tzinfo=None).isoformat())
    assert not wv.tocaRevisar(ajena, _AHORA, 360)


class _RepositorioLista:
    def __init__(self, wallets):
        self._wallets = wallets

    def listar(self):
        return self._wallets


def testRevisarTodasEmpiezaPorLasPropiasYSaltaLasAjenasRecientes(monkeypatch):
    monkeypatch.setattr(settings, "walletsAjenasCadaMinutos", lambda: 360)
    reciente = (_AHORA - timedelta(minutes=5)).isoformat()
    antigua = (_AHORA - timedelta(hours=7)).isoformat()
    wallets = [
        _wallet("ajena-reciente", False, reciente),
        _wallet("ajena-antigua", False, antigua),
        _wallet("propia-1", True, reciente),
        _wallet("ajena-sin-leer", False),
        _wallet("propia-2", True),
    ]
    vigilante = wv.VigilanteWallets(repositorio=_RepositorioLista(wallets), ahoraUtc=lambda: _AHORA)
    revisadas = []
    monkeypatch.setattr(vigilante, "revisar", lambda walletId: (revisadas.append(walletId), (None, 0))[1])

    vigilante.revisarTodas()

    assert revisadas == ["propia-1", "propia-2", "ajena-antigua", "ajena-sin-leer"]
