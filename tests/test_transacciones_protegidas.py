"""Las filas importadas de la blockchain no se cambian ni se borran desde la pantalla."""

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from core.db import getDb
from core.wallets_sync import filaDeMovimiento, filaProtegidaDeBorrado, protegerFilasImportadas, redesConWalletPropia
from providers.blockchain_clients import RECIBIDA, MovimientoWallet
from stores.app_data import writeTransaccionesFile
from stores.wallets_store import AlmacenIlegible

_DIRECCION = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"
_MANUAL = {"id": "transaccion-1", "assetId": "btc", "assetName": "Bitcoin", "fechaOperacion": "01-01-2026", "total": "1",
           "comisionRed": "", "walletTipo": "recibida", "walletDesde": "Exchange", "walletDestino": "Fria",
           "hashTransaccion": "", "nota": ""}


def _filaImportada(red: str = "btc") -> dict:
    movimiento = MovimientoWallet(red=red, hash="abc123", fecha=datetime(2026, 11, 1, tzinfo=UTC), simbolo="BTC",
                                  cantidad=Decimal("0.5"), comision=Decimal("0.0001"), tipo=RECIBIDA,
                                  contraparte="origen")
    return filaDeMovimiento(movimiento, {"id": "btc", "name": "Bitcoin"}, "Ledger")


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.registros import registrosBp
    from routes.wallets import walletsBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    conn = getDb()
    conn.execute("INSERT INTO activos (id, name, symbol, type) VALUES ('btc', 'Bitcoin', 'BTC', 'cripto')")
    conn.commit()
    client, cabeceras, _app = clienteAutenticado(walletsBp, registrosBp)
    return client, cabeceras


def _enlazar(client, cabeceras) -> str:
    respuesta = client.post("/api/wallets", json={"alias": "Ledger", "red": "btc", "tipo": "direccion",
                                                  "valor": _DIRECCION, "assetId": "btc"}, headers=cabeceras)
    return respuesta.get_json()["wallet"]["id"]


def testDeUnaFilaImportadaSoloSeCambiaLaNota(cliente):
    client, cabeceras = cliente
    original = _filaImportada()
    writeTransaccionesFile({"rows": [original]})
    manipulada = {**original, "total": "99", "comisionRed": "1", "walletTipo": "enviada", "walletDesde": "Otra",
                  "walletDestino": "Otra", "hashTransaccion": "otro", "fechaOperacion": "02-02-2020",
                  "assetId": "aapl", "assetName": "Apple", "nota": "Mi nota"}

    assert client.post("/api/transacciones", json={"rows": [manipulada]}, headers=cabeceras).status_code == 200

    assert client.get("/api/transacciones").get_json()["rows"] == [{**original, "nota": "Mi nota"}]


def testUnaFilaImportadaConWalletEnlazadaNoSeBorra(cliente):
    client, cabeceras = cliente
    _enlazar(client, cabeceras)
    original = _filaImportada()
    writeTransaccionesFile({"rows": [original]})

    respuesta = client.post("/api/transacciones", json={"rows": []}, headers=cabeceras)

    assert respuesta.get_json()["conservadas"] == 1
    assert client.get("/api/transacciones").get_json()["rows"] == [original]


def testUnaFilaImportadaSinWalletDeSuRedSeBorra(cliente):
    client, cabeceras = cliente
    writeTransaccionesFile({"rows": [_filaImportada()]})

    respuesta = client.post("/api/transacciones", json={"rows": []}, headers=cabeceras)

    assert respuesta.get_json()["conservadas"] == 0
    assert client.get("/api/transacciones").get_json()["rows"] == []


def testConWalletDeOtraRedSeBorra(cliente):
    client, cabeceras = cliente
    _enlazar(client, cabeceras)
    writeTransaccionesFile({"rows": [_filaImportada("eth")]})

    assert client.post("/api/transacciones", json={"rows": []}, headers=cabeceras).get_json()["conservadas"] == 0


def testUnaFilaEscritaAManoSeSigueEditandoYBorrando(cliente):
    client, cabeceras = cliente
    _enlazar(client, cabeceras)
    writeTransaccionesFile({"rows": [_MANUAL]})

    editada = {**_MANUAL, "total": "2"}
    assert client.post("/api/transacciones", json={"rows": [editada]}, headers=cabeceras).status_code == 200
    assert client.get("/api/transacciones").get_json()["rows"] == [editada]

    assert client.post("/api/transacciones", json={"rows": []}, headers=cabeceras).get_json()["conservadas"] == 0
    assert client.get("/api/transacciones").get_json()["rows"] == []


def testUnaPestanaDesfasadaRecibeElConflictoAntesQueLaProteccion(cliente):
    client, cabeceras = cliente
    _enlazar(client, cabeceras)
    revision = client.get("/api/transacciones").get_json()["revision"]
    writeTransaccionesFile({"rows": [_filaImportada()]})

    # Sin la fila nueva y con la revisión vieja: tiene que poder fusionar al recibir el 409.
    respuesta = client.post("/api/transacciones", json={"rows": [], "revision": revision}, headers=cabeceras)

    assert respuesta.status_code == 409


def testLaListaDeProtegidasSoloSeCalculaSiSePide(cliente):
    client, cabeceras = cliente
    _enlazar(client, cabeceras)
    importada = _filaImportada()
    writeTransaccionesFile({"rows": [importada, _filaImportada("eth"), _MANUAL]})

    assert "filasProtegidas" not in client.get("/api/transacciones").get_json()
    assert client.get("/api/transacciones?conProteccion=1").get_json()["filasProtegidas"] == [importada["id"]]


def testUnaFilaQueNoReconoceSuRedSeProtegeSiQuedaAlgunaWallet():
    conHashEditado = {**_filaImportada(), "hashTransaccion": "editado"}

    assert filaProtegidaDeBorrado(conHashEditado, {"eth"}) is True
    assert filaProtegidaDeBorrado(conHashEditado, set()) is False


def testSinPoderLeerLasWalletsSeProtegenTodasLasRedes():
    class Ilegible:
        def listar(self):
            raise AlmacenIlegible("corrupto")

    filas, conservadas = protegerFilasImportadas([], [_filaImportada()], redesConWalletPropia(Ilegible()))

    assert (len(filas), conservadas) == (1, 1)


def testLasWalletsAjenasNoCuentanComoEnlazadas():
    class Repositorio:
        def listar(self):
            return [type("Wallet", (), {"red": "btc", "propia": False})(),
                    type("Wallet", (), {"red": "sol", "propia": True})()]

    assert redesConWalletPropia(Repositorio()) == {"sol"}
