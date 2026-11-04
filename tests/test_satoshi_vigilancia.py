"""Pruebas de core/satoshi_vigilancia.py y de /api/wallets/satoshi.

Sin red: la foto de monedas, el lector de bloques y Telegram son dobles; los
bloques se construyen con las ayudas de test_bitcoin_bloques.
"""

import gzip
from datetime import UTC, datetime

import pytest
from test_bitcoin_bloques import _bloque, _coinbase, _segwit

from core import satoshi_vigilancia as sv

_MONEDA_A = ("aa" * 32, 0)
_MONEDA_B = ("bb" * 32, 0)


def _foto():
    return sv.FotoMonedas(altura=100, fecha="2026-11-03T00:00:00+00:00", claves=2,
                          monedas={_MONEDA_A: (3, 5_000_000_000), _MONEDA_B: (4, 5_000_000_000)})


class _Lector:
    def __init__(self, altura, bloques):
        self._altura = altura
        self._bloques = bloques
        self.pedidos = []

    def altura(self):
        return self._altura

    def bloque(self, altura):
        self.pedidos.append(altura)
        if isinstance(self._bloques.get(altura), Exception):
            raise self._bloques[altura]
        return self._bloques.get(altura, _bloque(_coinbase()))


@pytest.fixture
def entorno(tmp_path):
    avisos = []
    repositorio = sv.SatoshiEstadoRepository(ruta=tmp_path / "satoshi.json")

    def vigilante(lector, **opciones):
        return sv.VigilanteSatoshi(repositorio=repositorio, lector=lector, foto=_foto,
                                   notificar=lambda categoria, texto: avisos.append((categoria, texto)) or True,
                                   ahora=lambda: datetime(2026, 11, 3, tzinfo=UTC), **opciones)

    return repositorio, vigilante, avisos


def testApagadaNoMiraNingunBloque(entorno):
    _, vigilante, _ = entorno
    lector = _Lector(105, {})

    assert vigilante(lector).revisar() == 0
    assert lector.pedidos == []


def testEncuentraLaMonedaGastadaLaDescuentaYAvisaUnaVez(entorno):
    _, vigilante, avisos = entorno
    gasto, txid = _segwit([_MONEDA_A])
    lector = _Lector(103, {102: _bloque(_coinbase(), gasto)})
    vigilante(lector).ajustar(activo=True)

    encontradas = vigilante(lector).revisar()
    otraVez = vigilante(lector).revisar()

    assert (encontradas, otraVez) == (1, 0)
    assert lector.pedidos == [101, 102, 103]
    resumen = vigilante(lector).resumen()
    assert (resumen["satoshis"], resumen["monedas"], resumen["alturaRevisada"]) == (5_000_000_000, 1, 103)
    assert resumen["gastadas"][0] | {"fecha": ""} == {
        "txid": "aa" * 32, "vout": 0, "satoshis": 5_000_000_000, "alturaOrigen": 3,
        "alturaGasto": 102, "txGasto": txid, "fecha": ""}
    assert len(avisos) == 1 and avisos[0][0] == "wallets"
    assert "50 BTC" in avisos[0][1] and txid in avisos[0][1]


def testSinAvisosApuntaPeroNoManda(entorno):
    _, vigilante, avisos = entorno
    gasto, _ = _segwit([_MONEDA_B])
    lector = _Lector(101, {101: _bloque(_coinbase(), gasto)})
    vigilante(lector).ajustar(activo=True, avisos=False)

    assert vigilante(lector).revisar() == 1
    assert avisos == []


def testCadaPasadaMiraComoMuchoMaxBloques(entorno):
    _, vigilante, _ = entorno
    lector = _Lector(200, {})
    vigilante(lector).ajustar(activo=True)

    vigilante(lector, maxBloques=3).revisar()
    vigilante(lector, maxBloques=3).revisar()

    assert lector.pedidos == [101, 102, 103, 104, 105, 106]


def testUnFalloGuardaLoRevisadoYElErrorParaLaSiguiente(entorno):
    repositorio, vigilante, _ = entorno
    lector = _Lector(105, {103: OSError("sin red")})
    vigilante(lector).ajustar(activo=True)

    with pytest.raises(OSError):
        vigilante(lector).revisar()

    estado = repositorio.leer()
    assert (estado.altura, estado.error) == (102, "sin red")
    lector._bloques = {}
    vigilante(lector).revisar()
    assert repositorio.leer().altura == 105 and repositorio.leer().error == ""


def testForzarRevisaAunqueEsteApagada(entorno):
    _, vigilante, _ = entorno
    lector = _Lector(101, {})

    vigilante(lector).revisar(forzar=True)

    assert lector.pedidos == [101]


def testLaFotoSeLeeDelCsvComprimido(tmp_path):
    ruta = tmp_path / "foto.csv.gz"
    with gzip.open(ruta, "wt", encoding="utf-8") as fichero:
        fichero.write("# altura=925000 fecha=2026-11-03T10:00:00+00:00 claves=21953 fuente=x\n"
                      f"altura,txid,vout,satoshis\n3,{'aa' * 32},0,5000000000\n")

    foto = sv.leerFoto.__wrapped__(ruta)

    assert (foto.altura, foto.claves, foto.satoshis) == (925000, 21953, 5_000_000_000)
    assert foto.monedas == {_MONEDA_A: (3, 5_000_000_000)}


def testSinFotoLoDiceClaro(tmp_path):
    with pytest.raises(sv.FotoNoDisponible, match=r"tools/generar_satoshi_monedas\.py"):
        sv.leerFoto.__wrapped__(tmp_path / "no-existe.csv.gz")


# ── HTTP ──────────────────────────────────────────────────────────────────────

@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.satoshi import satoshiBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    from routes import satoshi as rutas

    # El repositorio por defecto va a paths.API_DIR, que datosAislados redirige.
    monkeypatch.setattr(rutas, "_vigilante", lambda: sv.VigilanteSatoshi(
        lector=_Lector(101, {}), foto=_foto, notificar=lambda c, t: True))
    client, cabeceras, _app = clienteAutenticado(satoshiBp)
    return client, cabeceras


def testVerElResumen(cliente):
    client, _ = cliente

    datos = client.get("/api/wallets/satoshi").get_json()

    assert (datos["btc"], datos["monedas"], datos["activo"]) == ("100.00000000", 2, False)


def testActivarYRevisar(cliente):
    client, cabeceras = cliente

    activado = client.post("/api/wallets/satoshi/ajustes", json={"activo": True}, headers=cabeceras).get_json()
    revisado = client.post("/api/wallets/satoshi/revisar", headers=cabeceras).get_json()

    assert activado["activo"] is True
    assert (revisado["alturaRevisada"], revisado["encontradas"]) == (101, 0)


@pytest.mark.parametrize("cuerpo", [{}, {"activo": "si"}])
def testAjustesSeValidan(cliente, cuerpo):
    client, cabeceras = cliente

    assert client.post("/api/wallets/satoshi/ajustes", json=cuerpo, headers=cabeceras).status_code == 400


def testAjustesExigenCsrf(cliente):
    client, _ = cliente

    assert client.post("/api/wallets/satoshi/ajustes", json={"activo": True}).status_code == 403
