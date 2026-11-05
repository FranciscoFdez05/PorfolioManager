"""Pruebas de /api/wallets con la capa de seguridad real (sesión y CSRF).

Lo esencial: ninguna respuesta devuelve la dirección o la xpub completa, el
fichero en disco no las lleva en claro y sin sesión o sin CSRF no se entra.
"""

from datetime import datetime, timezone
from decimal import Decimal

import pytest

from core.db import getDb
from providers.blockchain_clients import ENVIADA, RECIBIDA, ErrorLecturaWallet, MovimientoWallet, SaldoToken, UtxoBitcoin

_ZPUB = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs"


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.registros import registrosBp
    from routes.wallets import walletsBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    conn = getDb()
    conn.execute("INSERT INTO activos (id, name, symbol, type) VALUES ('btc', 'Bitcoin', 'BTC', 'cripto')")
    conn.execute("INSERT INTO activos (id, name, symbol, type) VALUES ('aapl', 'Apple', 'AAPL', 'acciones')")
    conn.commit()
    client, cabeceras, _app = clienteAutenticado(walletsBp, registrosBp)
    return client, cabeceras, datosAislados


def _enlazar(client, cabeceras, **cambios):
    datos = {"alias": "Ledger", "red": "btc", "tipo": "xpub", "valor": _ZPUB, "assetId": "btc", **cambios}
    return client.post("/api/wallets", json=datos, headers=cabeceras)


def testEnlazarListarYNoDevolverNuncaElValor(cliente):
    client, cabeceras, rutas = cliente

    respuesta = _enlazar(client, cabeceras)
    listado = client.get("/api/wallets")

    assert respuesta.status_code == 200
    assert _ZPUB not in respuesta.get_data(as_text=True)
    assert _ZPUB not in listado.get_data(as_text=True)
    datos = listado.get_json()
    assert datos["cifradoDisponible"] is True
    assert [w["valorEnmascarado"] for w in datos["wallets"]] == ["zpub6rFR…tZYs"]
    assert {r["clave"] for r in datos["redes"]} == {"btc", "eth", "bnb", "sol", "xrp"}
    assert _ZPUB.encode() not in (rutas["claves"] / "wallets.key").read_bytes()


def testUnaClavePrivadaSeRechazaYNoSeGuarda(cliente):
    client, cabeceras, rutas = cliente

    respuesta = _enlazar(client, cabeceras, tipo="direccion", valor=" ".join(["abandon"] * 11 + ["about"]))

    assert respuesta.status_code == 400
    assert respuesta.get_json()["field"] == "valor"
    assert not (rutas["claves"] / "wallets.key").exists()


@pytest.mark.parametrize("cambios, campo", [
    ({"assetId": "aapl"}, "assetId"),
    ({"assetId": "no-existe"}, "assetId"),
    ({"tipo": "otra"}, "tipo"),
    ({"alias": ""}, "alias"),
    ({"valor": "bc1qnovalida"}, "valor"),
])
def testValidaLaEntrada(cliente, cambios, campo):
    client, cabeceras, _ = cliente

    respuesta = _enlazar(client, cabeceras, **cambios)

    assert respuesta.status_code == 400
    assert respuesta.get_json()["field"] == campo


def testSinSecretKeyDeCalidadNoSeEnlaza(cliente, monkeypatch):
    client, cabeceras, _ = cliente
    monkeypatch.setenv("SECRET_KEY", "corta")

    respuesta = _enlazar(client, cabeceras)

    assert respuesta.status_code == 409
    assert "SECRET_KEY" in respuesta.get_json()["error"]


def testSinSecretKeyDeCalidadSiSeSigueUnaAjena(cliente, monkeypatch):
    client, cabeceras, _ = cliente
    monkeypatch.setenv("SECRET_KEY", "corta")

    respuesta = _enlazar(client, cabeceras, alias="Satoshi", tipo="direccion", valor=_SATOSHI,
                         assetId="", propia=False)

    assert respuesta.status_code == 200
    wallets = client.get("/api/wallets").get_json()["wallets"]
    assert [(w["alias"], w["propia"]) for w in wallets] == [("Satoshi", False)]


def testSinCsrfNoSeEnlaza(cliente):
    client, _cabeceras, _ = cliente

    assert _enlazar(client, {}).status_code == 403


def testSinSesionNoSeLista(crearApp, datosAislados, tempDb):
    from routes.wallets import walletsBp

    assert crearApp(walletsBp).test_client().get("/api/wallets").status_code == 401


def testDesenlazar(cliente):
    client, cabeceras, _ = cliente
    walletId = _enlazar(client, cabeceras).get_json()["wallet"]["id"]

    assert client.delete(f"/api/wallets/{walletId}", headers=cabeceras).status_code == 200
    assert client.delete(f"/api/wallets/{walletId}", headers=cabeceras).status_code == 404
    assert client.get("/api/wallets").get_json()["wallets"] == []


class _Lector:
    def __init__(self, resultado):
        self.resultado = resultado

    def leer(self, tipo, valor, limite):
        if isinstance(self.resultado, Exception):
            raise self.resultado
        return self.resultado


def testSincronizarImportaATransacciones(cliente, monkeypatch):
    from core import wallets_sync

    client, cabeceras, _ = cliente
    movimiento = MovimientoWallet(red="btc", hash="abc123", fecha=datetime(2026, 1, 2, tzinfo=timezone.utc),
                                  simbolo="BTC", cantidad=Decimal("0.01"), comision=None, tipo=RECIBIDA,
                                  contraparte="bc1qorigen")
    monkeypatch.setattr(wallets_sync, "lectorPara", lambda red: _Lector([movimiento]))
    walletId = _enlazar(client, cabeceras).get_json()["wallet"]["id"]
    # Una entrada de dinero solo se importa ya verificada por el usuario.
    client.post(f"/api/wallets/{walletId}/movimientos/marcar", headers=cabeceras,
                json={"hash": "abc123", "simbolo": "BTC", "sentido": "recibida", "propia": False})

    respuesta = client.post(f"/api/wallets/{walletId}/sincronizar", headers=cabeceras)
    otra = client.post(f"/api/wallets/{walletId}/sincronizar", headers=cabeceras)

    assert respuesta.get_json()["anadidas"] == 1
    assert otra.get_json()["yaImportadas"] == 1
    filas = client.get("/api/transacciones").get_json()["rows"]
    assert [(f["assetId"], f["total"], f["fechaOperacion"], f["walletDestino"]) for f in filas] == [
        ("btc", "0.01", "02-01-2026", "Ledger"),
    ]
    assert client.get("/api/wallets").get_json()["wallets"][0]["ultimaSincronizacion"]


def testUnFalloDeLaRedEsUn502ConMensaje(cliente, monkeypatch):
    from core import wallets_sync

    client, cabeceras, _ = cliente
    monkeypatch.setattr(wallets_sync, "lectorPara", lambda red: _Lector(ErrorLecturaWallet("Esplora respondió HTTP 503")))
    walletId = _enlazar(client, cabeceras).get_json()["wallet"]["id"]

    respuesta = client.post(f"/api/wallets/{walletId}/sincronizar", headers=cabeceras)

    assert respuesta.status_code == 502
    assert respuesta.get_json()["error"] == "Esplora respondió HTTP 503"


def testGuardarClaveEtherscanCifrada(cliente):
    client, cabeceras, rutas = cliente

    respuesta = client.post("/api/wallets/etherscan", json={"clave": "ABC123DEF456"}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert client.get("/api/wallets").get_json()["hayClaveEtherscan"] is True
    assert b"ABC123DEF456" not in (rutas["claves"] / "etherscan.key").read_bytes()


def testUnaClaveEtherscanConSimbolosSeRechaza(cliente):
    client, cabeceras, _ = cliente

    respuesta = client.post("/api/wallets/etherscan", json={"clave": "abc; rm -rf"}, headers=cabeceras)

    assert respuesta.status_code == 400


# ── Seguimiento: wallets ajenas, ajustes, saldo e intervalo ───────────────────

_SATOSHI = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"


def testUnaWalletAjenaNoNecesitaActivoNiSeImporta(cliente):
    client, cabeceras, _ = cliente

    respuesta = _enlazar(client, cabeceras, alias="Satoshi", tipo="direccion", valor=_SATOSHI,
                         assetId="", propia=False, avisos=True, umbralAviso="1,5")
    wallet = respuesta.get_json()["wallet"]
    importar = client.post(f"/api/wallets/{wallet['id']}/sincronizar", headers=cabeceras)

    assert respuesta.status_code == 200
    assert (wallet["propia"], wallet["avisos"], wallet["umbralAviso"]) == (False, True, "1.5")
    assert importar.status_code == 400 and "ajenas" in importar.get_json()["error"]


def testVariasWalletsEnUnMismoSeguimiento(cliente):
    client, cabeceras, _ = cliente

    _enlazar(client, cabeceras, seguimiento="Mi  Ledger")
    segunda = _enlazar(client, cabeceras, alias="Cuenta 2", tipo="direccion", valor=_SATOSHI,
                       seguimiento="mi ledger")
    wallets = client.get("/api/wallets").get_json()["wallets"]

    assert segunda.status_code == 200
    assert [(w["seguimiento"], w["seguimientoClave"]) for w in wallets] == [
        ("Mi Ledger", "mi ledger"), ("mi ledger", "mi ledger"),
    ]


def testUnSeguimientoPropioNoAdmiteUnaAjena(cliente):
    client, cabeceras, _ = cliente
    _enlazar(client, cabeceras, seguimiento="Ledger")

    respuesta = _enlazar(client, cabeceras, alias="Satoshi", tipo="direccion", valor=_SATOSHI,
                         assetId="", propia=False, seguimiento="Ledger")

    assert respuesta.status_code == 400 and "propias" in respuesta.get_json()["error"]
    assert len(client.get("/api/wallets").get_json()["wallets"]) == 1


def testUnaWalletPropiaSinActivoSeRechaza(cliente):
    client, cabeceras, _ = cliente

    assert _enlazar(client, cabeceras, assetId="").get_json()["field"] == "assetId"


@pytest.mark.parametrize("umbral", ["-1", "abc", "NaN"])
def testUmbralInvalido(cliente, umbral):
    client, cabeceras, _ = cliente

    assert _enlazar(client, cabeceras, umbralAviso=umbral).get_json()["field"] == "umbralAviso"


def testAjustarAvisosYNombre(cliente):
    client, cabeceras, _ = cliente
    walletId = _enlazar(client, cabeceras).get_json()["wallet"]["id"]

    respuesta = client.post(f"/api/wallets/{walletId}/ajustes",
                            json={"alias": "Cold", "avisos": True, "umbralAviso": "0.01"}, headers=cabeceras)

    assert respuesta.status_code == 200
    wallet = client.get("/api/wallets").get_json()["wallets"][0]
    assert (wallet["alias"], wallet["avisos"], wallet["umbralAviso"]) == ("Cold", True, "0.01")


def testEnlazarConAjustesDeAvisos(cliente):
    client, cabeceras, _ = cliente

    wallet = _enlazar(client, cabeceras, avisos=True,
                      avisosConfig={"enviadas": False, "minimoEur": "50,5", "silencioDesde": "23:00",
                                    "silencioHasta": "08:00"}).get_json()["wallet"]

    config = wallet["avisosConfig"]
    assert (config["enviadas"], config["recibidas"], config["minimoEur"]) == (False, True, "50.5")
    assert (config["silencioDesde"], config["agrupar"], wallet["avisosPendientes"]) == ("23:00", False, 0)


@pytest.mark.parametrize("config, campo", [
    ({"saldoMinimo": "-1"}, "saldoMinimo"),
    ({"silencioDesde": "7:00", "silencioHasta": "08:00"}, "silencioDesde"),
    ("todo", "avisosConfig"),
])
def testAjustesDeAvisosInvalidos(cliente, config, campo):
    client, cabeceras, _ = cliente

    respuesta = _enlazar(client, cabeceras, avisosConfig=config)

    assert respuesta.status_code == 400 and respuesta.get_json()["field"] == campo


def testAjustarLosAvisosDeTodoUnSeguimiento(cliente):
    client, cabeceras, _ = cliente
    _enlazar(client, cabeceras, seguimiento="Ledger")
    _enlazar(client, cabeceras, alias="Cuenta 2", tipo="direccion", valor=_SATOSHI, seguimiento="Ledger",
             umbralAviso="2")

    respuesta = client.post("/api/wallets/seguimientos/avisos",
                            json={"clave": "LEDGER", "avisos": True, "avisosConfig": {"agrupar": True}},
                            headers=cabeceras)

    assert respuesta.status_code == 200
    assert _ZPUB not in respuesta.get_data(as_text=True)
    wallets = client.get("/api/wallets").get_json()["wallets"]
    assert [(w["avisos"], w["avisosConfig"]["agrupar"]) for w in wallets] == [(True, True), (True, True)]
    # Lo que no viene se queda como estaba en cada wallet.
    assert [w["umbralAviso"] for w in wallets] == ["", "2"]


@pytest.mark.parametrize("cuerpo, estado", [
    ({"clave": "ledger"}, 400),
    ({"clave": "trezor", "avisos": True}, 404),
    ({"clave": "ledger", "avisosConfig": {"maxPorRevision": 0.5}}, 400),
])
def testAjustarLosAvisosDeUnSeguimientoValida(cliente, cuerpo, estado):
    client, cabeceras, _ = cliente
    _enlazar(client, cabeceras, seguimiento="Ledger")

    respuesta = client.post("/api/wallets/seguimientos/avisos", json=cuerpo, headers=cabeceras)

    assert respuesta.status_code == estado


def testCambiosSueltosDeAvisosRespetanLaConfigDeCadaWallet(cliente):
    client, cabeceras, _ = cliente
    walletId = _enlazar(client, cabeceras, seguimiento="Ledger").get_json()["wallet"]["id"]
    _enlazar(client, cabeceras, alias="Cuenta 2", tipo="direccion", valor=_SATOSHI, seguimiento="Ledger")
    client.post(f"/api/wallets/{walletId}/ajustes", json={"avisosConfig": {"agrupar": True}}, headers=cabeceras)

    respuesta = client.post("/api/wallets/seguimientos/avisos",
                            json={"clave": "ledger", "avisos": True,
                                  "avisosConfigCambios": {"direccionNueva": True, "vaciado": True}},
                            headers=cabeceras)

    assert respuesta.status_code == 200
    wallets = client.get("/api/wallets").get_json()["wallets"]
    assert [(w["avisos"], w["avisosConfig"]["agrupar"], w["avisosConfig"]["vaciado"]) for w in wallets] == [
        (True, True, True), (True, False, True)]


@pytest.mark.parametrize("cuerpo", [
    {"clave": "ledger", "avisosConfigCambios": []},
    {"clave": "ledger", "avisosConfigCambios": {"noExiste": True}},
    {"clave": "ledger", "avisosConfigCambios": {"vaciado": "si"}},
    {"clave": "ledger", "avisosConfigCambios": {}},
    {"clave": "ledger", "avisosConfig": {}, "avisosConfigCambios": {"vaciado": True}},
])
def testCambiosSueltosDeAvisosSeValidan(cliente, cuerpo):
    client, cabeceras, _ = cliente
    _enlazar(client, cabeceras, seguimiento="Ledger")

    respuesta = client.post("/api/wallets/seguimientos/avisos", json=cuerpo, headers=cabeceras)

    assert respuesta.status_code == 400
    assert client.get("/api/wallets").get_json()["wallets"][0]["avisos"] is False


def testAjustarLosAvisosDeUnSeguimientoExigeCsrf(cliente):
    client, _, _ = cliente

    respuesta = client.post("/api/wallets/seguimientos/avisos", json={"clave": "ledger", "avisos": True})

    assert respuesta.status_code == 403


def testCambiarElNombreDeUnaWalletSinGrupoNoLaSacaDeSuSeguimiento(cliente):
    client, cabeceras, _ = cliente
    walletId = _enlazar(client, cabeceras).get_json()["wallet"]["id"]
    _enlazar(client, cabeceras, alias="Cuenta 2", tipo="direccion", valor=_SATOSHI, seguimiento="Ledger")

    client.post(f"/api/wallets/{walletId}/ajustes", json={"alias": "Cuenta 1"}, headers=cabeceras)

    wallets = client.get("/api/wallets").get_json()["wallets"]
    assert [(w["alias"], w["seguimientoClave"]) for w in wallets] == [("Cuenta 1", "ledger"), ("Cuenta 2", "ledger")]


def testRenombrarUnSeguimiento(cliente):
    client, cabeceras, _ = cliente
    _enlazar(client, cabeceras, seguimiento="Ledger")
    _enlazar(client, cabeceras, alias="Cuenta 2", tipo="direccion", valor=_SATOSHI, seguimiento="ledger")

    respuesta = client.post("/api/wallets/seguimientos/renombrar",
                            json={"clave": "LEDGER", "nombre": "  Mi   Cold "}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert _ZPUB not in respuesta.get_data(as_text=True)
    assert [w["seguimiento"] for w in respuesta.get_json()["wallets"]] == ["Mi Cold", "Mi Cold"]
    assert {w["seguimientoClave"] for w in client.get("/api/wallets").get_json()["wallets"]} == {"mi cold"}


@pytest.mark.parametrize("cuerpo, estado", [
    ({"clave": "ledger", "nombre": ""}, 400),
    ({"clave": "", "nombre": "Cold"}, 400),
    ({"clave": "ledger", "nombre": "Satoshi"}, 400),
    ({"clave": "trezor", "nombre": "Cold"}, 404),
])
def testRenombrarUnSeguimientoValida(cliente, cuerpo, estado):
    client, cabeceras, _ = cliente
    _enlazar(client, cabeceras, seguimiento="Ledger")
    _enlazar(client, cabeceras, alias="Satoshi", tipo="direccion", valor=_SATOSHI, assetId="", propia=False)

    respuesta = client.post("/api/wallets/seguimientos/renombrar", json=cuerpo, headers=cabeceras)

    assert respuesta.status_code == estado
    assert [w["seguimiento"] for w in client.get("/api/wallets").get_json()["wallets"]] == ["Ledger", "Satoshi"]


def testDejarDeSeguirQuitaTodasLasWalletsDelSeguimiento(cliente):
    client, cabeceras, _ = cliente
    _enlazar(client, cabeceras, alias="Satoshi", tipo="direccion", valor=_SATOSHI, assetId="", propia=False)
    _enlazar(client, cabeceras, seguimiento="Ledger")

    respuesta = client.post("/api/wallets/seguimientos/eliminar", json={"clave": " SATOSHI "}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert respuesta.get_json()["quitadas"] == 1
    assert [w["seguimiento"] for w in client.get("/api/wallets").get_json()["wallets"]] == ["Ledger"]


@pytest.mark.parametrize("cuerpo, estado", [({"clave": ""}, 400), ({"clave": "trezor"}, 404)])
def testDejarDeSeguirValida(cliente, cuerpo, estado):
    client, cabeceras, _ = cliente
    _enlazar(client, cabeceras, seguimiento="Ledger")

    respuesta = client.post("/api/wallets/seguimientos/eliminar", json=cuerpo, headers=cabeceras)

    assert respuesta.status_code == estado
    assert len(client.get("/api/wallets").get_json()["wallets"]) == 1


def testDejarDeSeguirExigeCsrf(cliente):
    client, _, _ = cliente

    respuesta = client.post("/api/wallets/seguimientos/eliminar", json={"clave": "ledger"})

    assert respuesta.status_code == 403


def testRenombrarUnSeguimientoExigeCsrf(cliente):
    client, _, _ = cliente

    respuesta = client.post("/api/wallets/seguimientos/renombrar", json={"clave": "ledger", "nombre": "Cold"})

    assert respuesta.status_code == 403


def testActualizarGuardaSaldoYDaValorEnEuros(cliente, monkeypatch):
    from core import wallets_vigilancia

    client, cabeceras, _ = cliente

    class Lector:
        def saldo(self, tipo, valor):
            return Decimal("0.5")

        def leer(self, tipo, valor, limite):
            return []

    monkeypatch.setattr(wallets_vigilancia, "lectorPara", lambda red: Lector())
    monkeypatch.setattr(wallets_vigilancia, "precioEurDeActivo", lambda assetId: Decimal("60000") if assetId else None)
    walletId = _enlazar(client, cabeceras).get_json()["wallet"]["id"]
    _enlazar(client, cabeceras, alias="Satoshi", tipo="direccion", valor=_SATOSHI, assetId="btc", propia=False)
    ajenaId = client.get("/api/wallets").get_json()["wallets"][1]["id"]

    respuesta = client.post(f"/api/wallets/{walletId}/actualizar", headers=cabeceras)
    client.post(f"/api/wallets/{ajenaId}/actualizar", headers=cabeceras)
    listado = client.get("/api/wallets").get_json()

    assert respuesta.get_json()["wallet"]["saldo"] == "0.5"
    assert respuesta.get_json()["wallet"]["valorEur"] == "30000"
    # La ajena no suma al total.
    assert listado["totalPropiasEur"] == "30000"


@pytest.mark.parametrize("minutos, estado", [(60, 200), (0, 200), (7, 400), (True, 400), ("15", 400)])
def testGuardarIntervaloDeVigilancia(cliente, minutos, estado):
    client, cabeceras, _ = cliente

    respuesta = client.post("/api/wallets/vigilancia", json={"minutos": minutos}, headers=cabeceras)

    assert respuesta.status_code == estado
    if estado == 200:
        assert client.get("/api/wallets").get_json()["vigilanciaMinutos"] == minutos


# ── Historial de una wallet ───────────────────────────────────────────────────


def _movimientoBtc(indice):
    return MovimientoWallet(red="btc", hash=f"{indice:064x}", fecha=datetime(2026, 1, 1, tzinfo=timezone.utc),
                            simbolo="BTC", cantidad=Decimal("0.1"), comision=None, tipo=RECIBIDA,
                            contraparte="bc1qorigen")


class _LectorHistorial:
    def __init__(self):
        self.limites = []

    def leer(self, tipo, valor, limite):
        self.limites.append(limite)
        return [_movimientoBtc(i) for i in range(min(limite, 30))]


@pytest.mark.parametrize("pedido, usado", [("100", 100), ("5", 5), ("0", 1), ("999999", 1000)])
def testHistorialRespetaElTope(cliente, monkeypatch, pedido, usado):
    from routes import wallets as rutasWallets

    client, cabeceras, _ = cliente
    lector = _LectorHistorial()
    monkeypatch.setattr(rutasWallets, "lectorPara", lambda red: lector)
    walletId = _enlazar(client, cabeceras).get_json()["wallet"]["id"]

    respuesta = client.get(f"/api/wallets/{walletId}/movimientos?limite={pedido}")
    datos = respuesta.get_json()

    assert respuesta.status_code == 200
    assert lector.limites == [usado]
    assert (datos["limite"], datos["maximo"]) == (usado, 1000)
    assert len(datos["movimientos"]) == min(usado, 30)
    assert datos["movimientos"][0]["contraparte"] == "bc1qorigen"
    assert _ZPUB not in respuesta.get_data(as_text=True)


class _LectorTokensEth:
    def leer(self, tipo, valor, limite):
        fecha = datetime(2026, 1, 1, tzinfo=timezone.utc)
        return [
            MovimientoWallet(red="eth", hash=f"0x{indice:064x}", fecha=fecha, simbolo="LINK", cantidad=Decimal("1"),
                             comision=None, tipo=RECIBIDA, contrato=contrato)
            for indice, contrato in enumerate(["0x" + "1" * 40, "0x" + "2" * 40])
        ]


def testElHistorialLlevaLosContratosPublicosQueNecesitaLaPagina(cliente, monkeypatch):
    from providers.listas_tokens import TokenPublico
    from routes import wallets as rutasWallets

    client, cabeceras, _ = cliente
    publicos = [TokenPublico("eth", "0x" + "1" * 40, "LINK"), TokenPublico("eth", "0x" + "9" * 40, "SHIB")]
    monkeypatch.setattr(rutasWallets, "lectorPara", lambda red: _LectorTokensEth())
    monkeypatch.setattr(rutasWallets, "tokensPublicos", lambda: publicos)
    walletId = _enlazar(client, cabeceras, alias="Ballena", red="eth", tipo="direccion", valor="0x" + "a" * 40,
                        assetId="", propia=False).get_json()["wallet"]["id"]

    datos = client.get(f"/api/wallets/{walletId}/movimientos").get_json()

    assert datos["tokensPublicos"] == [{"red": "eth", "contrato": "0x" + "1" * 40, "simbolo": "LINK"}]


def testSinTokensNoSeDescarganLasListasPublicas(cliente, monkeypatch):
    from routes import wallets as rutasWallets

    client, cabeceras, _ = cliente
    monkeypatch.setattr(rutasWallets, "lectorPara", lambda red: _LectorHistorial())
    monkeypatch.setattr(rutasWallets, "tokensPublicos", lambda: pytest.fail("no debe descargar las listas"))
    walletId = _enlazar(client, cabeceras).get_json()["wallet"]["id"]

    assert client.get(f"/api/wallets/{walletId}/movimientos").get_json()["tokensPublicos"] == []
    assert client.get("/api/wallets").get_json()["tokensPublicos"] == []


def testHistorialConLimiteNoNumerico(cliente):
    client, cabeceras, _ = cliente
    walletId = _enlazar(client, cabeceras).get_json()["wallet"]["id"]

    assert client.get(f"/api/wallets/{walletId}/movimientos?limite=abc").status_code == 400


class _LectorUtxos:
    def __init__(self):
        self.pedidos = []

    def utxos(self, tipo, valor):
        self.pedidos.append((tipo, valor))
        confirmado = UtxoBitcoin(txid="t1", vout=2, satoshis=150_000, direccion="bc1qpropia", altura=860_000,
                                 fecha=datetime(2024, 9, 1, tzinfo=timezone.utc))
        pendiente = UtxoBitcoin(txid="t2", vout=0, satoshis=1_000, direccion="bc1qpropia", altura=None, fecha=None)
        return [confirmado, pendiente], 870_000


def testUtxosDeUnaWalletBitcoin(cliente, monkeypatch):
    from routes import wallets as rutasWallets

    client, cabeceras, _ = cliente
    lector = _LectorUtxos()
    monkeypatch.setattr(rutasWallets, "lectorUtxos", lambda: lector)
    walletId = _enlazar(client, cabeceras).get_json()["wallet"]["id"]

    respuesta = client.get(f"/api/wallets/{walletId}/utxos")
    datos = respuesta.get_json()

    assert respuesta.status_code == 200
    assert lector.pedidos == [("xpub", _ZPUB)]
    assert datos["alturaActual"] == 870_000
    assert datos["total"] == "0.00151"
    assert "bc1qpropia" not in respuesta.get_data(as_text=True)
    assert datos["utxos"][0] == {"txid": "t1", "vout": 2, "satoshis": 150_000, "cantidad": "0.0015",
                                 "direccion": "…opia", "altura": 860_000, "fecha": "2024-09-01T00:00:00+00:00"}
    assert (datos["utxos"][1]["altura"], datos["utxos"][1]["fecha"]) == (None, "")
    assert _ZPUB not in respuesta.get_data(as_text=True)


def testUtxosSoloEnBitcoin(cliente, monkeypatch):
    from routes import wallets as rutasWallets

    client, cabeceras, _ = cliente
    monkeypatch.setattr(rutasWallets, "lectorUtxos", lambda: pytest.fail("no debe leer la red"))
    walletId = _enlazar(client, cabeceras, alias="Ballena", red="eth", tipo="direccion", valor="0x" + "a" * 40,
                        assetId="", propia=False).get_json()["wallet"]["id"]

    respuesta = client.get(f"/api/wallets/{walletId}/utxos")

    assert respuesta.status_code == 400
    assert "Bitcoin" in respuesta.get_json()["error"]


def testUtxosConFalloDeLaRed(cliente, monkeypatch):
    from routes import wallets as rutasWallets

    class _Caido:
        def utxos(self, tipo, valor):
            raise ErrorLecturaWallet("Esplora respondió HTTP 503")

    client, cabeceras, _ = cliente
    monkeypatch.setattr(rutasWallets, "lectorUtxos", lambda: _Caido())
    walletId = _enlazar(client, cabeceras).get_json()["wallet"]["id"]

    respuesta = client.get(f"/api/wallets/{walletId}/utxos")

    assert respuesta.status_code == 502
    assert "503" in respuesta.get_json()["error"]


def testUtxosDeUnaWalletQueNoExiste(cliente):
    client, _cabeceras, _ = cliente

    assert client.get("/api/wallets/wallet-nada/utxos").status_code == 404


class _LectorTokens:
    def __init__(self):
        self.pedidos = []

    def saldosTokens(self, valor, maximo, historial):
        self.pedidos.append(valor)
        return [SaldoToken(contrato="0xcspx", simbolo="CSPX", nombre="iShares S&P 500", cantidad=Decimal("3"),
                           ultimoMovimiento=datetime(2026, 3, 1, tzinfo=timezone.utc))], 0


def testTokensDeUnaWalletEthConUnEtfTokenizado(cliente, monkeypatch):
    from core import wallets_visor_tokens

    client, cabeceras, _ = cliente
    conn = getDb()
    conn.execute("INSERT INTO activos (id, name, symbol, type, price, currency) "
                 "VALUES ('cspx', 'iShares S&P 500', 'CSPX', 'etfs', '500', 'EUR')")
    conn.commit()
    lector = _LectorTokens()
    monkeypatch.setattr(wallets_visor_tokens, "lectorTokens", lambda red: lector)
    direccion = "0x" + "c" * 40
    walletId = _enlazar(client, cabeceras, alias="Metamask", red="eth", tipo="direccion", valor=direccion,
                        assetId="", propia=False).get_json()["wallet"]["id"]

    respuesta = client.get(f"/api/wallets/{walletId}/tokens")
    datos = respuesta.get_json()

    assert respuesta.status_code == 200
    assert lector.pedidos == [direccion]
    token = datos["tokens"][0]
    assert (token["simbolo"], token["cantidad"], token["estado"]) == ("CSPX", "3", "sinVerificar")
    assert token["activo"]["type"] == "etfs"
    assert token["valorEur"] == "1500"
    assert direccion not in respuesta.get_data(as_text=True)


def testTokensSoloEnRedesConEtherscan(cliente, monkeypatch):
    from core import wallets_visor_tokens

    client, cabeceras, _ = cliente
    monkeypatch.setattr(wallets_visor_tokens, "lectorTokens", lambda red: pytest.fail("no debe leer la red"))
    walletId = _enlazar(client, cabeceras).get_json()["wallet"]["id"]

    respuesta = client.get(f"/api/wallets/{walletId}/tokens")

    assert respuesta.status_code == 400
    assert "Ethereum" in respuesta.get_json()["error"]
    redes ={r["clave"]: r["visorTokens"] for r in client.get("/api/wallets").get_json()["redes"]}
    assert redes == {"btc": False, "eth": True, "bnb": True, "sol": False, "xrp": False}


def testTokensDeUnaWalletQueNoExiste(cliente):
    client, _cabeceras, _ = cliente

    assert client.get("/api/wallets/wallet-nada/tokens").status_code == 404


def testHistorialDeUnaWalletQueNoExiste(cliente):
    client, _cabeceras, _ = cliente

    assert client.get("/api/wallets/wallet-nada/movimientos").status_code == 404


def testLasRedesLlevanSuExplorador(cliente):
    client, _cabeceras, _ = cliente

    redes = client.get("/api/wallets").get_json()["redes"]

    assert all("{hash}" in r["explorador"] and r["explorador"].startswith("https://") for r in redes)


def testEnModoAutomaticoSeGuardaElTipoDetectado(cliente):
    client, cabeceras, _ = cliente

    respuesta = _enlazar(client, cabeceras, tipo="auto",
                         valor="0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798")

    assert respuesta.status_code == 200
    assert respuesta.get_json()["wallet"]["tipo"] == "clave"


def testUnaClavePublicaEnEthereumSeEnlazaComoDireccion(cliente):
    client, cabeceras, _ = cliente

    respuesta = _enlazar(client, cabeceras, red="eth", tipo="auto", propia=False, assetId="",
                         valor="0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798")
    redes = {r["clave"]: r for r in client.get("/api/wallets").get_json()["redes"]}

    assert respuesta.status_code == 200
    assert respuesta.get_json()["wallet"]["tipo"] == "direccion"
    assert respuesta.get_json()["wallet"]["valorEnmascarado"].startswith("0x7e5f45")
    assert (redes["eth"]["admiteClavePublica"], redes["sol"]["admiteClavePublica"]) == (True, False)


def _ponerContrasena(monkeypatch, rutas, contrasena="la-clave-de-la-web"):
    from werkzeug.security import generate_password_hash

    from routes import auth

    monkeypatch.setattr(auth, "_AUTH_FILE", rutas["auth"])
    auth._saveCredentials("admin", generate_password_hash(contrasena, method="pbkdf2:sha256:1000"))


def testVerCompletasDevuelveLosValoresDelSeguimientoConLaContrasena(cliente, monkeypatch):
    client, cabeceras, rutas = cliente
    _ponerContrasena(monkeypatch, rutas)
    ledger = _enlazar(client, cabeceras, seguimiento="Ledger").get_json()["wallet"]["id"]
    otro = _enlazar(client, cabeceras, alias="Satoshi", tipo="direccion", valor=_SATOSHI, assetId="",
                    propia=False).get_json()["wallet"]["id"]

    respuesta = client.post("/api/wallets/seguimientos/ver-completas",
                            json={"clave": "LEDGER", "currentPassword": "la-clave-de-la-web"}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert respuesta.get_json()["valores"] == {ledger: _ZPUB}
    assert otro not in respuesta.get_json()["valores"]
    assert respuesta.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize("cuerpo", [
    {"clave": "ledger", "currentPassword": "mal"},
    {"clave": "ledger"},
    {"clave": "ledger", "currentPassword": 123},
])
def testVerCompletasSinLaContrasenaCorrectaNoDaNada(cliente, monkeypatch, cuerpo):
    client, cabeceras, rutas = cliente
    _ponerContrasena(monkeypatch, rutas)
    _enlazar(client, cabeceras, seguimiento="Ledger")

    respuesta = client.post("/api/wallets/seguimientos/ver-completas", json=cuerpo, headers=cabeceras)

    assert respuesta.status_code == 400
    assert _ZPUB not in respuesta.get_data(as_text=True)


def testVerCompletasCuentaLosFallosComoElLogin(cliente, monkeypatch):
    client, cabeceras, rutas = cliente
    _ponerContrasena(monkeypatch, rutas)
    monkeypatch.setenv("MAX_INTENTOS_LOGIN", "2")
    _enlazar(client, cabeceras, seguimiento="Ledger")
    cuerpo = {"clave": "ledger", "currentPassword": "mal"}

    for _ in range(2):
        client.post("/api/wallets/seguimientos/ver-completas", json=cuerpo, headers=cabeceras)
    respuesta = client.post("/api/wallets/seguimientos/ver-completas",
                            json={**cuerpo, "currentPassword": "la-clave-de-la-web"}, headers=cabeceras)

    assert respuesta.status_code == 429
    assert _ZPUB not in respuesta.get_data(as_text=True)


def testVerCompletasExigeCsrf(cliente):
    client, _, _ = cliente

    respuesta = client.post("/api/wallets/seguimientos/ver-completas",
                            json={"clave": "ledger", "currentPassword": "la-clave-de-la-web"})

    assert respuesta.status_code == 403


_CONTRATO = "0x6982508145454Ce325dDbE47a25d4ec3d2311933"


def testVerificarYOlvidarUnToken(cliente):
    client, cabeceras, _ = cliente

    verificado = client.post("/api/wallets/tokens/verificar",
                             json={"red": "eth", "contrato": _CONTRATO, "simbolo": " pepe "}, headers=cabeceras)
    listado = client.get("/api/wallets").get_json()
    olvidado = client.post("/api/wallets/tokens/olvidar", json={"red": "eth", "contrato": _CONTRATO},
                           headers=cabeceras)

    esperado = [{"red": "eth", "contrato": _CONTRATO.lower(), "simbolo": "PEPE"}]
    assert verificado.get_json()["tokensVerificados"] == esperado
    assert listado["tokensVerificados"] == esperado
    assert {r["clave"]: r["exploradorToken"] for r in listado["redes"]}["eth"] == "https://etherscan.io/token/{contrato}"
    assert olvidado.get_json()["tokensVerificados"] == []


@pytest.mark.parametrize("cuerpo, campo", [
    ({"red": "btc", "contrato": _CONTRATO, "simbolo": "PEPE"}, "red"),
    ({"red": "sol", "contrato": _CONTRATO, "simbolo": "PEPE"}, "red"),
    ({"red": "eth", "contrato": "0x1234", "simbolo": "PEPE"}, "contrato"),
    ({"red": "eth", "contrato": _CONTRATO, "simbolo": "$$$"}, "simbolo"),
    ({"red": "eth", "contrato": _CONTRATO, "simbolo": "eth"}, "simbolo"),
    ({"red": "eth", "contrato": _CONTRATO, "simbolo": "ĖŢḤ"}, "simbolo"),
])
def testVerificarUnTokenValidaLaEntrada(cliente, cuerpo, campo):
    client, cabeceras, _ = cliente

    respuesta = client.post("/api/wallets/tokens/verificar", json=cuerpo, headers=cabeceras)

    assert respuesta.status_code == 400
    assert respuesta.get_json().get("field") == campo
    assert client.get("/api/wallets").get_json()["tokensVerificados"] == []


def testMarcarYDesmarcarUnToken(cliente):
    client, cabeceras, _ = cliente
    client.post("/api/wallets/tokens/verificar",
                json={"red": "eth", "contrato": _CONTRATO, "simbolo": "PEPE"}, headers=cabeceras)

    marcado = client.post("/api/wallets/tokens/marcar",
                          json={"red": "eth", "contrato": _CONTRATO, "marca": "imitacion"}, headers=cabeceras)
    listado = client.get("/api/wallets").get_json()
    desmarcado = client.post("/api/wallets/tokens/desmarcar", json={"red": "eth", "contrato": _CONTRATO},
                             headers=cabeceras)

    esperado = [{"red": "eth", "contrato": _CONTRATO.lower(), "marca": "imitacion"}]
    # Marcarlo sustituye a su verificación.
    assert marcado.get_json()["tokensMarcados"] == esperado
    assert marcado.get_json()["tokensVerificados"] == []
    assert listado["tokensMarcados"] == esperado
    assert desmarcado.get_json()["tokensMarcados"] == []


def testUnTokenConElNombreDeLaRedSePuedeMarcarLegitimo(cliente):
    client, cabeceras, _ = cliente

    respuesta = client.post("/api/wallets/tokens/marcar",
                            json={"red": "eth", "contrato": _CONTRATO, "marca": "legitimo"}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert respuesta.get_json()["tokensMarcados"][0]["marca"] == "legitimo"


@pytest.mark.parametrize("cuerpo, campo", [
    ({"red": "eth", "contrato": _CONTRATO, "marca": "quizas"}, "marca"),
    ({"red": "eth", "contrato": _CONTRATO}, "marca"),
    ({"red": "btc", "contrato": _CONTRATO, "marca": "imitacion"}, "red"),
    ({"red": "eth", "contrato": "0x1234", "marca": "imitacion"}, "contrato"),
])
def testMarcarUnTokenValidaLaEntrada(cliente, cuerpo, campo):
    client, cabeceras, _ = cliente

    respuesta = client.post("/api/wallets/tokens/marcar", json=cuerpo, headers=cabeceras)

    assert respuesta.status_code == 400
    assert respuesta.get_json().get("field") == campo
    assert client.get("/api/wallets").get_json()["tokensMarcados"] == []


def testMarcarUnTokenExigeCsrf(cliente):
    client, _, _ = cliente

    respuesta = client.post("/api/wallets/tokens/marcar",
                            json={"red": "eth", "contrato": _CONTRATO, "marca": "imitacion"})

    assert respuesta.status_code == 403


def testVerificarUnTokenExigeCsrf(cliente):
    client, _, _ = cliente

    respuesta = client.post("/api/wallets/tokens/verificar",
                            json={"red": "eth", "contrato": _CONTRATO, "simbolo": "PEPE"})

    assert respuesta.status_code == 403


# ── Libreta de direcciones ────────────────────────────────────────────────────

_BECH32 = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"


def _guardarDireccion(client, cabeceras, **cambios):
    datos = {"red": "btc", "direccion": _BECH32.upper(), "apodo": "  Mi   Exchange ", "propia": False, **cambios}
    return client.post("/api/wallets/direcciones/guardar", json=datos, headers=cabeceras)


def testGuardarYOlvidarUnaDireccion(cliente):
    client, cabeceras, rutas = cliente

    respuesta = _guardarDireccion(client, cabeceras).get_json()

    assert respuesta["direccion"] == _BECH32
    assert respuesta["efectiva"] == {"apodo": "Mi Exchange", "marca": "ajena", "enlazada": False}
    assert client.get("/api/wallets").get_json()["direcciones"] == [
        {"red": "btc", "direccion": _BECH32, "apodo": "Mi Exchange", "propia": False},
    ]
    assert b"Mi Exchange" not in (rutas["claves"] / "wallets.key").read_bytes()

    olvidada = client.post("/api/wallets/direcciones/olvidar", json={"red": "btc", "direccion": _BECH32},
                           headers=cabeceras).get_json()
    assert (olvidada["efectiva"], olvidada["direcciones"]) == (None, [])


@pytest.mark.parametrize("cambios, campo", [
    ({"direccion": "bc1qnovalida"}, "direccion"),
    ({"direccion": ""}, "direccion"),
    ({"red": "doge"}, "red"),
    ({"propia": "si"}, "propia"),
    ({"apodo": "x" * 61}, "apodo"),
])
def testGuardarDireccionValidaLaEntrada(cliente, cambios, campo):
    client, cabeceras, _ = cliente

    respuesta = _guardarDireccion(client, cabeceras, **cambios)

    assert respuesta.status_code == 400
    assert respuesta.get_json()["field"] == campo


def testGuardarDireccionExigeCsrf(cliente):
    client, _cabeceras, _ = cliente

    assert _guardarDireccion(client, {}).status_code == 403


# ── Vincular direcciones propias a un seguimiento ─────────────────────────────

def _vincular(client, cabeceras, **cambios):
    datos = {"red": "btc", "direccion": _BECH32, "seguimiento": "  Mi   Ledger ", "assetId": "btc", **cambios}
    return client.post("/api/wallets/direcciones/vincular", json=datos, headers=cabeceras)


def testVincularConvierteLaDireccionEnWalletDelSeguimiento(cliente):
    client, cabeceras, _ = cliente
    _guardarDireccion(client, cabeceras, propia=True, apodo="Fría")

    respuesta = _vincular(client, cabeceras)

    assert respuesta.status_code == 200
    cuerpo = respuesta.get_json()
    assert cuerpo["direcciones"] == []
    assert cuerpo["efectiva"] == {"apodo": "Mi Ledger", "marca": "propia", "enlazada": True}
    assert (cuerpo["wallet"]["alias"], cuerpo["wallet"]["seguimiento"]) == ("Fría", "Mi Ledger")
    assert _BECH32 not in respuesta.get_data(as_text=True)
    listado = client.get("/api/wallets").get_json()
    assert [w["id"] for w in listado["wallets"]] == [cuerpo["wallet"]["id"]]
    assert listado["wallets"][0]["propia"] is True
    assert listado["wallets"][0]["assetId"] == "btc"
    assert listado["direccionesEnlazadas"][0]["walletId"] == cuerpo["wallet"]["id"]


def testVincularSeUneAlSeguimientoExistenteConSuNombre(cliente):
    client, cabeceras, _ = cliente
    _enlazar(client, cabeceras, seguimiento="Mi Ledger")
    _guardarDireccion(client, cabeceras, propia=True)

    cuerpo = _vincular(client, cabeceras, seguimiento="mi ledger").get_json()

    assert cuerpo["wallet"]["seguimiento"] == "Mi Ledger"
    assert len({w["seguimientoClave"] for w in client.get("/api/wallets").get_json()["wallets"]}) == 1


@pytest.mark.parametrize("cambios, campo", [
    ({"seguimiento": ""}, "seguimiento"),
    ({"seguimiento": "x" * 61}, "seguimiento"),
    ({"assetId": ""}, "assetId"),
    ({"assetId": "aapl"}, "assetId"),
    ({"direccion": "bc1qnovalida"}, "direccion"),
])
def testVincularValidaLaEntrada(cliente, cambios, campo):
    client, cabeceras, _ = cliente
    _guardarDireccion(client, cabeceras, propia=True)

    respuesta = _vincular(client, cabeceras, **cambios)

    assert respuesta.status_code == 400
    assert respuesta.get_json()["field"] == campo
    assert client.get("/api/wallets").get_json()["wallets"] == []


@pytest.mark.parametrize("marcar", [False, True])
def testSoloSeVinculaUnaDireccionMarcadaComoPropia(cliente, marcar):
    client, cabeceras, _ = cliente
    if marcar:
        _guardarDireccion(client, cabeceras, propia=False)

    respuesta = _vincular(client, cabeceras)

    assert respuesta.status_code == 400
    assert client.get("/api/wallets").get_json()["wallets"] == []


def testVincularASeguimientoDeAjenasSeRechazaSinPerderLaMarca(cliente):
    client, cabeceras, _ = cliente
    _enlazar(client, cabeceras, seguimiento="Ballena", propia=False, assetId="")
    _guardarDireccion(client, cabeceras, propia=True)

    respuesta = _vincular(client, cabeceras, seguimiento="Ballena")

    assert respuesta.status_code == 400
    listado = client.get("/api/wallets").get_json()
    assert len(listado["wallets"]) == 1
    assert len(listado["direcciones"]) == 1


def testVincularUnaDireccionYaEnlazadaSeRechaza(cliente):
    client, cabeceras, _ = cliente
    _enlazar(client, cabeceras, tipo="direccion", valor=_BECH32, seguimiento="Otro")
    _guardarDireccion(client, cabeceras, propia=True)

    assert _vincular(client, cabeceras).status_code == 400


def testVincularExigeCsrf(cliente):
    client, cabeceras, _ = cliente
    _guardarDireccion(client, cabeceras, propia=True)

    assert _vincular(client, {}).status_code == 403


def testVincularPoneElNombreDelSeguimientoEnLoImportado(cliente, monkeypatch):
    client, cabeceras, _ = cliente
    _guardarDireccion(client, cabeceras, propia=True, apodo="Fría")
    from core import wallets_sync
    llamadas = []
    monkeypatch.setattr(wallets_sync.SincronizadorWallets, "reetiquetar",
                        lambda self, red, direccion: llamadas.append((red, direccion)) or 1)

    cuerpo = _vincular(client, cabeceras).get_json()

    assert llamadas == [("btc", _BECH32)]
    assert cuerpo["reetiquetadas"] == 1


def testMoverUnaWalletDeSeguimiento(cliente):
    client, cabeceras, _ = cliente
    walletId = _enlazar(client, cabeceras, tipo="direccion", valor=_BECH32, seguimiento="Origen").get_json()["wallet"]["id"]
    _enlazar(client, cabeceras, seguimiento="Destino")

    respuesta = client.post(f"/api/wallets/{walletId}/seguimiento", json={"seguimiento": "destino"}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert respuesta.get_json()["wallet"]["seguimiento"] == "Destino"
    assert {w["seguimiento"] for w in client.get("/api/wallets").get_json()["wallets"]} == {"Destino"}


def testMoverNoMezclaPropiasConAjenas(cliente):
    client, cabeceras, _ = cliente
    walletId = _enlazar(client, cabeceras, tipo="direccion", valor=_BECH32, seguimiento="Origen").get_json()["wallet"]["id"]
    _enlazar(client, cabeceras, seguimiento="Ballena", propia=False, assetId="")

    respuesta = client.post(f"/api/wallets/{walletId}/seguimiento", json={"seguimiento": "Ballena"}, headers=cabeceras)

    assert respuesta.status_code == 400
    wallet = next(w for w in client.get("/api/wallets").get_json()["wallets"] if w["id"] == walletId)
    assert wallet["seguimiento"] == "Origen"


def testMoverUnaWalletQueNoExiste(cliente):
    client, cabeceras, _ = cliente

    respuesta = client.post("/api/wallets/nada/seguimiento", json={"seguimiento": "Destino"}, headers=cabeceras)

    assert respuesta.status_code == 404


def _aLibreta(client, cabeceras, walletId, contrasena="la-clave-de-la-web"):
    return client.post(f"/api/wallets/{walletId}/a-libreta", json={"currentPassword": contrasena}, headers=cabeceras)


def testDevolverALaLibretaEsLoContrarioDeVincular(cliente, monkeypatch):
    client, cabeceras, rutas = cliente
    _ponerContrasena(monkeypatch, rutas)
    _guardarDireccion(client, cabeceras, propia=True, apodo="Fría")
    walletId = _vincular(client, cabeceras).get_json()["wallet"]["id"]

    respuesta = _aLibreta(client, cabeceras, walletId)

    assert respuesta.status_code == 200
    assert respuesta.headers["Cache-Control"] == "no-store"
    cuerpo = respuesta.get_json()
    assert cuerpo["direcciones"] == [{"red": "btc", "direccion": _BECH32, "apodo": "Fría", "propia": True}]
    assert cuerpo["efectiva"] == {"apodo": "Fría", "marca": "propia", "enlazada": False}
    assert client.get("/api/wallets").get_json()["wallets"] == []


def testDevolverALaLibretaBorraSusLecturasGuardadas(cliente, monkeypatch):
    from stores.wallets_lecturas import SECCION_UTXOS, LecturasRepository

    client, cabeceras, rutas = cliente
    _ponerContrasena(monkeypatch, rutas)
    _guardarDireccion(client, cabeceras, propia=True, apodo="Fría")
    walletId = _vincular(client, cabeceras).get_json()["wallet"]["id"]
    assert LecturasRepository().guardar(walletId, SECCION_UTXOS, {"utxos": []}) is True

    assert _aLibreta(client, cabeceras, walletId).status_code == 200

    assert LecturasRepository().leer(walletId) == {}


@pytest.mark.parametrize("datos", [
    {"tipo": "xpub", "valor": _ZPUB},
    {"tipo": "direccion", "valor": _BECH32, "propia": False, "assetId": ""},
])
def testSoloUnaDireccionPropiaVuelveALaLibreta(cliente, monkeypatch, datos):
    client, cabeceras, rutas = cliente
    _ponerContrasena(monkeypatch, rutas)
    walletId = _enlazar(client, cabeceras, **datos).get_json()["wallet"]["id"]

    respuesta = _aLibreta(client, cabeceras, walletId)

    assert respuesta.status_code == 400
    assert len(client.get("/api/wallets").get_json()["wallets"]) == 1


def testSinLaContrasenaNoSeDestapaLaDireccionEnlazada(cliente, monkeypatch):
    client, cabeceras, rutas = cliente
    _ponerContrasena(monkeypatch, rutas)
    walletId = _enlazar(client, cabeceras, tipo="direccion", valor=_BECH32).get_json()["wallet"]["id"]

    respuesta = _aLibreta(client, cabeceras, walletId, "mal")

    assert respuesta.status_code == 400
    assert _BECH32 not in respuesta.get_data(as_text=True)
    listado = client.get("/api/wallets")
    assert _BECH32 not in listado.get_data(as_text=True)
    assert len(listado.get_json()["wallets"]) == 1


def testDevolverALaLibretaExigeCsrf(cliente):
    client, _cabeceras, _ = cliente

    assert _aLibreta(client, {}, "wallet-x").status_code == 403


# ── Marcar una transacción ────────────────────────────────────────────────────

def _marcarMovimiento(client, cabeceras, walletId, **cambios):
    datos = {"hash": "abc123", "contrato": "", "simbolo": "BTC", "sentido": RECIBIDA, "propia": True,
             "comision": "0,0002", "comisionLeida": "", **cambios}
    return client.post(f"/api/wallets/{walletId}/movimientos/marcar", json=datos, headers=cabeceras)


def _walletPropia(client, cabeceras):
    return _enlazar(client, cabeceras, tipo="direccion", valor=_BECH32).get_json()["wallet"]["id"]


def testCompletarComisionesExigeCsrfYSinNadaQueHacerDevuelveCero(cliente):
    client, cabeceras, _ = cliente
    url = "/api/wallets/transacciones/completar-comisiones"

    assert client.post(url).status_code == 403
    respuesta = client.post(url, headers=cabeceras)

    assert respuesta.status_code == 200
    assert respuesta.get_json() == {"ok": True, "completadas": 0}


def testUnaFilaAntiguaDeBitcoinConOrigenPropioRecuperaLaComision(cliente):
    from core.wallets_vigilancia import movimientoComoDict
    from routes import wallets as rutasWallets

    client, cabeceras, _ = cliente
    walletId = _walletPropia(client, cabeceras)
    movimiento = MovimientoWallet(red="btc", hash="abc123", fecha=datetime(2026, 11, 1, tzinfo=timezone.utc), simbolo="BTC",
                                  cantidad=Decimal("0.01355828"), comision=None, tipo=RECIBIDA, contraparte=_SATOSHI,
                                  comisionTx=Decimal("0.00000413"))
    rutasWallets._repositorio().actualizar(walletId, recientes=[movimientoComoDict(movimiento)])
    filas = {"rows": [{"id": "wallet-antigua", "assetId": "btc", "assetName": "Bitcoin", "fechaOperacion": "01-11-2026",
                       "total": "0.01355828", "comisionRed": "", "walletTipo": "recibida", "walletDesde": _SATOSHI,
                       "walletDestino": "Cartera", "hashTransaccion": "abc123", "nota": ""}]}
    assert client.post("/api/transacciones", json=filas, headers=cabeceras).status_code == 200
    assert _marcarMovimiento(client, cabeceras, walletId, comision="", direcciones=[_SATOSHI]).status_code == 200
    fila = client.get("/api/transacciones").get_json()["rows"][0]
    # Es el estado de partida: marcada y sin comisión, porque lo apuntado de la fila no la lleva.
    assert (fila["walletTipo"], fila["comisionRed"]) == ("entre_wallet", "")

    respuesta = client.post("/api/wallets/transacciones/completar-comisiones", headers=cabeceras).get_json()

    assert respuesta["completadas"] == 1
    fila = client.get("/api/transacciones").get_json()["rows"][0]
    assert (fila["walletTipo"], fila["comisionRed"], fila["total"]) == ("entre_wallet", "0.00000413", "0.01355828")


def testMarcarUnRetiroEntreWalletsCorrigeLoImportado(cliente):
    client, cabeceras, _ = cliente
    walletId = _walletPropia(client, cabeceras)
    filas = {"rows": [{"id": "manual", "assetId": "btc", "assetName": "Bitcoin", "fechaOperacion": "01-03-2026",
                       "total": "1", "comisionRed": "", "walletTipo": "recibida", "walletDesde": "Exchange",
                       "walletDestino": "Fria", "hashTransaccion": "ABC123", "nota": ""}]}
    assert client.post("/api/transacciones", json=filas, headers=cabeceras).status_code == 200

    respuesta = _marcarMovimiento(client, cabeceras, walletId)

    assert respuesta.status_code == 200
    cuerpo = respuesta.get_json()
    assert (cuerpo["marca"]["propia"], cuerpo["marca"]["comision"]) == (True, "0.0002")
    assert cuerpo["reetiquetadas"] == 1
    fila = client.get("/api/transacciones").get_json()["rows"][0]
    assert (fila["walletTipo"], fila["comisionRed"], fila["total"]) == ("entre_wallet", "0.0002", "1")


def testQuitarLaMarcaDeUnaTransaccion(cliente):
    client, cabeceras, _ = cliente
    walletId = _walletPropia(client, cabeceras)
    _marcarMovimiento(client, cabeceras, walletId)

    respuesta = _marcarMovimiento(client, cabeceras, walletId, propia=None)

    assert respuesta.status_code == 200
    assert respuesta.get_json()["marca"] is None


_ORIGEN_BTC = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"


def _libretaManual(client):
    return {d["direccion"]: d for d in client.get("/api/wallets").get_json()["direcciones"]}


def testMarcarEntreMisWalletsDaPorPropiasLasDosDirecciones(cliente):
    client, cabeceras, _ = cliente
    walletId = _walletPropia(client, cabeceras)

    respuesta = _marcarMovimiento(client, cabeceras, walletId, direcciones=[_BECH32, _ORIGEN_BTC])

    assert respuesta.status_code == 200
    cuerpo = respuesta.get_json()
    # La de la wallet ya era propia por estar enlazada: no se duplica a mano.
    assert cuerpo["marca"]["direccionesAnadidas"] == [_ORIGEN_BTC]
    assert list(cuerpo["efectivas"]) == [_ORIGEN_BTC]
    assert cuerpo["efectivas"][_ORIGEN_BTC]["marca"] == "propia"
    assert _libretaManual(client)[_ORIGEN_BTC]["propia"] is True
    assert _BECH32 not in _libretaManual(client)


def testMarcarSinLaOtraDireccionNoTocaLaLibreta(cliente):
    client, cabeceras, _ = cliente
    walletId = _walletPropia(client, cabeceras)

    cuerpo = _marcarMovimiento(client, cabeceras, walletId, direcciones=[_BECH32]).get_json()

    assert cuerpo["marca"]["direccionesAnadidas"] == []
    assert "efectivas" not in cuerpo
    assert _libretaManual(client) == {}


def testMarcarAjenaNoDaDireccionesPorPropias(cliente):
    client, cabeceras, _ = cliente
    walletId = _walletPropia(client, cabeceras)

    _marcarMovimiento(client, cabeceras, walletId, propia=False, direcciones=[_ORIGEN_BTC])

    assert _libretaManual(client) == {}


def testQuitarLaMarcaSacaLasDireccionesQueAnadio(cliente):
    client, cabeceras, _ = cliente
    walletId = _walletPropia(client, cabeceras)
    _marcarMovimiento(client, cabeceras, walletId, direcciones=[_ORIGEN_BTC])

    cuerpo = _marcarMovimiento(client, cabeceras, walletId, propia=None).get_json()

    assert cuerpo["efectivas"] == {_ORIGEN_BTC: None}
    assert _libretaManual(client) == {}


def testDesmarcarLaOtraDireccionAlRemarcarLaSaca(cliente):
    client, cabeceras, _ = cliente
    walletId = _walletPropia(client, cabeceras)
    _marcarMovimiento(client, cabeceras, walletId, direcciones=[_ORIGEN_BTC])

    cuerpo = _marcarMovimiento(client, cabeceras, walletId, direcciones=[]).get_json()

    assert cuerpo["marca"]["propia"] is True
    assert cuerpo["marca"]["direccionesAnadidas"] == []
    assert _libretaManual(client) == {}


def testCambiarLaComisionConservaLaDireccionAnadida(cliente):
    client, cabeceras, _ = cliente
    walletId = _walletPropia(client, cabeceras)
    _marcarMovimiento(client, cabeceras, walletId, direcciones=[_ORIGEN_BTC])

    cuerpo = _marcarMovimiento(client, cabeceras, walletId, comision="0,5", direcciones=[_ORIGEN_BTC]).get_json()

    assert cuerpo["marca"]["direccionesAnadidas"] == [_ORIGEN_BTC]
    assert _ORIGEN_BTC in _libretaManual(client)


def testQuitarLaMarcaRespetaLaDireccionQueOtraMarcaNecesita(cliente):
    client, cabeceras, _ = cliente
    walletId = _walletPropia(client, cabeceras)
    _marcarMovimiento(client, cabeceras, walletId, direcciones=[_ORIGEN_BTC])
    # La segunda transacción no la añade (ya es propia), así que no la reclama;
    # sí la reclama si se marca antes en otra moneda de la misma transacción.
    _marcarMovimiento(client, cabeceras, walletId, hash="def456", direcciones=[_ORIGEN_BTC])

    _marcarMovimiento(client, cabeceras, walletId, hash="def456", propia=None)

    assert _ORIGEN_BTC in _libretaManual(client)


def testQuitarLaMarcaRespetaLaDireccionConApodo(cliente):
    client, cabeceras, _ = cliente
    walletId = _walletPropia(client, cabeceras)
    _marcarMovimiento(client, cabeceras, walletId, direcciones=[_ORIGEN_BTC])
    client.post("/api/wallets/direcciones/guardar", headers=cabeceras,
                json={"red": "btc", "direccion": _ORIGEN_BTC, "apodo": "Trezor viejo", "propia": True})

    _marcarMovimiento(client, cabeceras, walletId, propia=None)

    assert _libretaManual(client)[_ORIGEN_BTC]["apodo"] == "Trezor viejo"


def testUnaDireccionNoValidaNoImpideMarcar(cliente):
    client, cabeceras, _ = cliente
    walletId = _walletPropia(client, cabeceras)

    respuesta = _marcarMovimiento(client, cabeceras, walletId, direcciones=["", "no-es-una-direccion"])

    assert respuesta.status_code == 200
    assert respuesta.get_json()["marca"]["propia"] is True
    assert _libretaManual(client) == {}


def testMarcarMasDeDosDireccionesSeRechaza(cliente):
    client, cabeceras, _ = cliente
    walletId = _walletPropia(client, cabeceras)

    respuesta = _marcarMovimiento(client, cabeceras, walletId, direcciones=[_BECH32, _ORIGEN_BTC, _ORIGEN_BTC])

    assert respuesta.status_code == 400


@pytest.mark.parametrize("cambios, campo", [
    ({"hash": ""}, "hash"),
    ({"hash": "abc/../x"}, "hash"),
    ({"contrato": "0x-malo"}, "contrato"),
    ({"propia": "si"}, "propia"),
    ({"sentido": "entre_wallet"}, "sentido"),
    ({"sentido": ""}, "sentido"),
    ({"comision": "-1"}, "comision"),
    ({"comision": "NaN"}, "comision"),
    ({"comision": "mucha"}, "comision"),
    ({"comisionLeida": "mucha"}, "comisionLeida"),
])
def testMarcarUnaTransaccionValidaLaEntrada(cliente, cambios, campo):
    client, cabeceras, _ = cliente
    walletId = _walletPropia(client, cabeceras)

    respuesta = _marcarMovimiento(client, cabeceras, walletId, **cambios)

    assert respuesta.status_code == 400
    assert respuesta.get_json()["field"] == campo


def testUnaWalletAjenaNoMarcaTransacciones(cliente):
    client, cabeceras, _ = cliente
    walletId = _enlazar(client, cabeceras, alias="Ballena", tipo="direccion", valor=_BECH32, assetId="",
                        propia=False).get_json()["wallet"]["id"]

    assert _marcarMovimiento(client, cabeceras, walletId).status_code == 400


def testMarcarUnaTransaccionDeUnaWalletQueNoExiste(cliente):
    client, cabeceras, _ = cliente

    assert _marcarMovimiento(client, cabeceras, "nada").status_code == 404


def testMarcarUnaTransaccionExigeCsrf(cliente):
    client, cabeceras, _ = cliente
    walletId = _walletPropia(client, cabeceras)

    assert _marcarMovimiento(client, {}, walletId).status_code == 403


def testElHistorialEnsenaLaMarca(cliente, monkeypatch):
    client, cabeceras, _ = cliente
    walletId = _walletPropia(client, cabeceras)
    movimiento = MovimientoWallet(red="btc", hash="abc123", fecha=datetime(2026, 3, 1, tzinfo=timezone.utc), simbolo="BTC",
                                  cantidad=Decimal("1"), comision=None, tipo=RECIBIDA, contraparte=_SATOSHI)

    class Lector:
        def leer(self, tipo, valor, limite):
            return [movimiento]

    monkeypatch.setattr("routes.wallets.lectorPara", lambda red: Lector())
    _marcarMovimiento(client, cabeceras, walletId)

    fila = client.get(f"/api/wallets/{walletId}/movimientos").get_json()["movimientos"][0]

    assert (fila["tipo"], fila["sentido"]) == ("entre_wallet", RECIBIDA)
    assert (fila["comision"], fila["comisionLeida"], fila["marcaMovimiento"]) == ("0.0002", "", "propia")


def testUnaDireccionVinculadaEntraEnLaWatchlist(cliente):
    client, cabeceras, _ = cliente
    _guardarDireccion(client, cabeceras, propia=True)
    assert client.get("/api/wallets/watchlist").get_json()["entradas"] == []

    _vincular(client, cabeceras)

    entradas = client.get("/api/wallets/watchlist").get_json()["entradas"]
    assert [(e["red"], e["assetId"]) for e in entradas] == [("btc", "btc")]


def testLasDireccionesEnlazadasSalenEnmascaradas(cliente):
    client, cabeceras, _ = cliente
    walletId = _enlazar(client, cabeceras, alias="Cartera", tipo="direccion", valor=_BECH32).get_json()["wallet"]["id"]
    _enlazar(client, cabeceras, alias="Satoshi", tipo="direccion", valor=_SATOSHI, propia=False)

    listado = client.get("/api/wallets")

    assert listado.get_json()["direccionesEnlazadas"] == [
        {"walletId": walletId, "red": "btc", "valorEnmascarado": "bc1qw508…f3t4", "apodo": "Cartera"},
    ]
    assert _BECH32 not in listado.get_data(as_text=True)


def testMarcarUnaDireccionReetiquetaLoImportadoYElHistorial(cliente, monkeypatch):
    from core import wallets_sync
    from routes import wallets as rutasWallets

    client, cabeceras, _ = cliente
    movimiento = MovimientoWallet(red="btc", hash="abc123", fecha=datetime(2026, 1, 2, tzinfo=timezone.utc),
                                  simbolo="BTC", cantidad=Decimal("0.01"), comision=None, tipo=RECIBIDA,
                                  contraparte=_BECH32)
    monkeypatch.setattr(wallets_sync, "lectorPara", lambda red: _Lector([movimiento]))
    monkeypatch.setattr(rutasWallets, "lectorPara", lambda red: _Lector([movimiento]))
    walletId = _enlazar(client, cabeceras).get_json()["wallet"]["id"]
    # Una fila «recibida» de antes de existir la verificación de entradas.
    wallets_sync.SincronizadorWallets(verificarEntradas=False).sincronizar(walletId)

    respuesta = _guardarDireccion(client, cabeceras, apodo="Exodus", propia=True).get_json()

    assert respuesta["reetiquetadas"] == 1
    fila = client.get("/api/transacciones").get_json()["rows"][0]
    assert (fila["walletTipo"], fila["walletDesde"], fila["walletDestino"]) == ("entre_wallet", "Exodus", "Ledger")
    historial = client.get(f"/api/wallets/{walletId}/movimientos").get_json()["movimientos"][0]
    assert (historial["tipo"], historial["sentido"], historial["contraparteApodo"]) == (
        "entre_wallet", "recibida", "Exodus"
    )

    client.post("/api/wallets/direcciones/olvidar", json={"red": "btc", "direccion": _BECH32}, headers=cabeceras)
    fila = client.get("/api/transacciones").get_json()["rows"][0]
    assert (fila["walletTipo"], fila["walletDesde"]) == ("pendiente", _BECH32)


def testEnlazarUnaWalletPropiaReetiquetaLoQueIbaHaciaElla(cliente, monkeypatch):
    from core import wallets_sync

    client, cabeceras, _ = cliente
    movimiento = MovimientoWallet(red="btc", hash="abc123", fecha=datetime(2026, 1, 2, tzinfo=timezone.utc),
                                  simbolo="BTC", cantidad=Decimal("0.01"), comision=None, tipo=ENVIADA,
                                  contraparte=_BECH32)
    monkeypatch.setattr(wallets_sync, "lectorPara", lambda red: _Lector([movimiento]))
    walletId = _enlazar(client, cabeceras).get_json()["wallet"]["id"]
    client.post(f"/api/wallets/{walletId}/sincronizar", headers=cabeceras)

    enlazada = _enlazar(client, cabeceras, alias="Cartera", tipo="direccion", valor=_BECH32).get_json()
    fila = client.get("/api/transacciones").get_json()["rows"][0]

    assert enlazada["reetiquetadas"] == 1
    assert (fila["walletTipo"], fila["walletDestino"]) == ("entre_wallet", "Cartera")

    client.delete(f"/api/wallets/{enlazada['wallet']['id']}", headers=cabeceras)
    fila = client.get("/api/transacciones").get_json()["rows"][0]
    assert (fila["walletTipo"], fila["walletDestino"]) == ("enviada", _BECH32)


def testVerDireccionesCompletasConLaContrasena(cliente, monkeypatch):
    client, cabeceras, rutas = cliente
    _ponerContrasena(monkeypatch, rutas)
    cartera = _enlazar(client, cabeceras, alias="Cartera", tipo="direccion", valor=_BECH32).get_json()["wallet"]["id"]
    xpub = _enlazar(client, cabeceras, seguimiento="Ledger").get_json()["wallet"]["id"]
    ajena = _enlazar(client, cabeceras, alias="Satoshi", tipo="direccion", valor=_SATOSHI, assetId="",
                     propia=False).get_json()["wallet"]["id"]

    respuesta = client.post("/api/wallets/direcciones/ver-completas",
                            json={"currentPassword": "la-clave-de-la-web"}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert respuesta.get_json()["valores"] == {cartera: _BECH32}
    assert xpub not in respuesta.get_json()["valores"] and ajena not in respuesta.get_json()["valores"]
    assert respuesta.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize("cuerpo", [{"currentPassword": "mal"}, {}, {"currentPassword": 123}])
def testVerDireccionesCompletasSinLaContrasenaCorrectaNoDaNada(cliente, monkeypatch, cuerpo):
    client, cabeceras, rutas = cliente
    _ponerContrasena(monkeypatch, rutas)
    _enlazar(client, cabeceras, alias="Cartera", tipo="direccion", valor=_BECH32)

    respuesta = client.post("/api/wallets/direcciones/ver-completas", json=cuerpo, headers=cabeceras)

    assert respuesta.status_code == 400
    assert _BECH32 not in respuesta.get_data(as_text=True)


def testVerDireccionesCompletasExigeCsrf(cliente):
    client, _, _ = cliente

    respuesta = client.post("/api/wallets/direcciones/ver-completas", json={"currentPassword": "x"})

    assert respuesta.status_code == 403


class _LectorSaldo:
    def __init__(self, resultado):
        self.resultado = resultado
        self.pedidos = []

    def saldo(self, tipo, valor):
        self.pedidos.append((tipo, valor))
        if isinstance(self.resultado, Exception):
            raise self.resultado
        return self.resultado


def testSaldoDeUnaDireccionDeLaLibreta(cliente, monkeypatch):
    from routes import wallets as rutasWallets

    client, cabeceras, _ = cliente
    lector = _LectorSaldo(Decimal("0.12500000"))
    monkeypatch.setattr(rutasWallets, "lectorPara", lambda red: lector)

    respuesta = client.post("/api/wallets/direcciones/saldo", json={"red": "btc", "direccion": _BECH32.upper()},
                            headers=cabeceras)

    assert respuesta.status_code == 200
    assert (respuesta.get_json()["saldo"], respuesta.get_json()["simbolo"]) == ("0.125", "BTC")
    assert lector.pedidos == [("direccion", _BECH32)]


def testSaldoDeUnaDireccionConFalloDeLaRed(cliente, monkeypatch):
    from routes import wallets as rutasWallets

    client, cabeceras, _ = cliente
    monkeypatch.setattr(rutasWallets, "lectorPara", lambda red: _LectorSaldo(ErrorLecturaWallet("Sin conexion")))

    respuesta = client.post("/api/wallets/direcciones/saldo", json={"red": "btc", "direccion": _BECH32},
                            headers=cabeceras)

    assert respuesta.status_code == 502
    assert "Sin conexion" in respuesta.get_json()["error"]


@pytest.mark.parametrize("cuerpo, campo", [
    ({"red": "btc", "direccion": "bc1qnovalida"}, "direccion"),
    ({"red": "doge", "direccion": _BECH32}, "red"),
])
def testSaldoDeUnaDireccionValidaLaEntrada(cliente, cuerpo, campo):
    client, cabeceras, _ = cliente

    respuesta = client.post("/api/wallets/direcciones/saldo", json=cuerpo, headers=cabeceras)

    assert respuesta.status_code == 400
    assert respuesta.get_json()["field"] == campo


def testSaldoDeUnaDireccionExigeCsrf(cliente):
    client, _, _ = cliente

    respuesta = client.post("/api/wallets/direcciones/saldo", json={"red": "btc", "direccion": _BECH32})

    assert respuesta.status_code == 403



# ── Sospechosos, ticker de precio y lista de la Watchlist ─────────────────────


def testEtiquetarYDesetiquetarUnTokenComoSospechoso(cliente):
    client, cabeceras, _ = cliente
    client.post("/api/wallets/tokens/verificar",
                json={"red": "eth", "contrato": _CONTRATO, "simbolo": "PEPE"}, headers=cabeceras)

    etiquetado = client.post("/api/wallets/tokens/sospechoso",
                             json={"red": "eth", "contrato": _CONTRATO, "sospechoso": True}, headers=cabeceras)
    listado = client.get("/api/wallets").get_json()
    quitado = client.post("/api/wallets/tokens/sospechoso",
                          json={"red": "eth", "contrato": _CONTRATO, "sospechoso": False}, headers=cabeceras)

    esperado = [{"red": "eth", "contrato": _CONTRATO.lower()}]
    assert etiquetado.get_json()["tokensSospechosos"] == esperado
    # Es solo una etiqueta: la verificación sigue.
    assert len(etiquetado.get_json()["tokensVerificados"]) == 1
    assert listado["tokensSospechosos"] == esperado
    assert quitado.get_json()["tokensSospechosos"] == []


@pytest.mark.parametrize("cuerpo, campo", [
    ({"red": "eth", "contrato": _CONTRATO}, "sospechoso"),
    ({"red": "eth", "contrato": _CONTRATO, "sospechoso": "si"}, "sospechoso"),
    ({"red": "btc", "contrato": _CONTRATO, "sospechoso": True}, "red"),
])
def testEtiquetarSospechosoValidaLaEntrada(cliente, cuerpo, campo):
    client, cabeceras, _ = cliente

    respuesta = client.post("/api/wallets/tokens/sospechoso", json=cuerpo, headers=cabeceras)

    assert respuesta.status_code == 400
    assert respuesta.get_json().get("field") == campo


def testPonerYQuitarElTickerDePrecioDeUnToken(cliente, monkeypatch):
    from routes import wallets as rutasWallets

    client, cabeceras, _ = cliente
    pedidos = []
    monkeypatch.setattr(rutasWallets, "fetchAssetQuote",
                        lambda simbolo, proveedor: pedidos.append((simbolo, proveedor)) or ({"price": 0.001}, None))

    puesto = client.post("/api/wallets/tokens/precio",
                         json={"red": "eth", "contrato": _CONTRATO, "ticker": " binance:pepeusdt "}, headers=cabeceras)
    listado = client.get("/api/wallets").get_json()
    quitado = client.post("/api/wallets/tokens/precio/quitar", json={"red": "eth", "contrato": _CONTRATO},
                          headers=cabeceras)

    # Sin proveedor, el de por defecto: TradingView.
    assert pedidos == [("BINANCE:PEPEUSDT", "tradingview")]
    esperado = [{"red": "eth", "contrato": _CONTRATO.lower(), "proveedor": "tradingview",
                 "ticker": "BINANCE:PEPEUSDT"}]
    assert puesto.get_json()["preciosToken"] == esperado
    assert listado["preciosToken"] == esperado
    assert listado["proveedoresPrecio"][0] == "tradingview"
    assert quitado.get_json()["preciosToken"] == []


@pytest.mark.parametrize("red", ["btc", "eth"])
def testPonerYQuitarElTickerDeLaMonedaDeUnaRedSinContrato(cliente, monkeypatch, red):
    from routes import wallets as rutasWallets

    client, cabeceras, _ = cliente
    monkeypatch.setattr(rutasWallets, "fetchAssetQuote", lambda simbolo, proveedor: ({"price": 1.0}, None))

    puesto = client.post("/api/wallets/tokens/precio", json={"red": red, "ticker": "BITVAVO:XEUR"}, headers=cabeceras)
    quitado = client.post("/api/wallets/tokens/precio/quitar", json={"red": red, "contrato": ""}, headers=cabeceras)

    assert puesto.get_json()["preciosToken"] == [{"red": red, "contrato": "", "proveedor": "tradingview",
                                                  "ticker": "BITVAVO:XEUR"}]
    assert quitado.get_json()["preciosToken"] == []


def testPonerTickerSinContratoRechazaUnaRedDesconocida(cliente, monkeypatch):
    from routes import wallets as rutasWallets

    client, cabeceras, _ = cliente
    monkeypatch.setattr(rutasWallets, "fetchAssetQuote", lambda *args: pytest.fail("no debe pedir cotización"))

    respuesta = client.post("/api/wallets/tokens/precio", json={"red": "doge", "ticker": "X"}, headers=cabeceras)

    assert respuesta.status_code == 400
    assert respuesta.get_json().get("field") == "red"


def testLaCotizacionTraeElPrecioExactoAdemasDelRedondeado(clienteAutenticado, monkeypatch):
    from routes import market as rutasMarket

    client, _, _ = clienteAutenticado(rutasMarket.marketBp)
    monkeypatch.setattr(rutasMarket, "fetchAssetQuote", lambda simbolo, proveedor: (
        {"price": "0,00", "currency": "USDT", "marketData": {"currentPrice": 4.93e-06}}, None
    ))

    datos = client.get("/api/market/quote?symbol=BINANCE:PEPEUSDT&provider=tradingview").get_json()

    assert (datos["price"], datos["currentPrice"]) == ("0,00", 4.93e-06)


def testUnTickerQueNoCotizaNoSeGuarda(cliente, monkeypatch):
    from routes import wallets as rutasWallets

    client, cabeceras, _ = cliente
    monkeypatch.setattr(rutasWallets, "fetchAssetQuote", lambda simbolo, proveedor: (None, "símbolo desconocido"))

    respuesta = client.post("/api/wallets/tokens/precio",
                            json={"red": "eth", "contrato": _CONTRATO, "proveedor": "yahoo", "ticker": "NOEXISTE"},
                            headers=cabeceras)

    assert respuesta.status_code == 400
    assert "NOEXISTE" in respuesta.get_json()["error"]
    assert client.get("/api/wallets").get_json()["preciosToken"] == []


@pytest.mark.parametrize("cuerpo, campo", [
    ({"red": "eth", "contrato": _CONTRATO, "proveedor": "bloomberg", "ticker": "PEPE"}, "proveedor"),
    ({"red": "eth", "contrato": _CONTRATO, "ticker": ""}, "ticker"),
    ({"red": "eth", "contrato": _CONTRATO, "ticker": "PEPE USD"}, "ticker"),
    ({"red": "eth", "contrato": _CONTRATO, "ticker": "<script>"}, "ticker"),
])
def testPonerTickerValidaLaEntradaSinPedirCotizacion(cliente, monkeypatch, cuerpo, campo):
    from routes import wallets as rutasWallets

    client, cabeceras, _ = cliente
    monkeypatch.setattr(rutasWallets, "fetchAssetQuote", lambda *args: pytest.fail("no debe pedir cotización"))

    respuesta = client.post("/api/wallets/tokens/precio", json=cuerpo, headers=cabeceras)

    assert respuesta.status_code == 400
    assert respuesta.get_json().get("field") == campo


def testLaWatchlistTraeLaMonedaYLosTokensVistosEnLasWallets(cliente, monkeypatch):
    from core import wallets_visor_tokens

    client, cabeceras, _ = cliente
    monkeypatch.setattr(wallets_visor_tokens, "lectorTokens", lambda red: _LectorTokens())
    direccion = "0x" + "c" * 40
    walletId = _enlazar(client, cabeceras, alias="Metamask", red="eth", tipo="direccion", valor=direccion,
                        assetId="", propia=False).get_json()["wallet"]["id"]
    vacia = client.get("/api/wallets/watchlist").get_json()["entradas"]

    client.get(f"/api/wallets/{walletId}/tokens")
    respuesta = client.get("/api/wallets/watchlist")

    assert [(e["tipo"], e["simbolo"]) for e in vacia] == [("moneda", "ETH")]
    entradas = respuesta.get_json()["entradas"]
    assert [(e["tipo"], e["simbolo"], e["nombre"]) for e in entradas] == [
        ("moneda", "ETH", "Ethereum"), ("token", "CSPX", "iShares S&P 500")
    ]
    assert direccion not in respuesta.get_data(as_text=True)


# ── Entradas por verificar y direcciones de las claves públicas ───────────────

_CLAVE_G = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"


class _LectorRevision(_Lector):
    def saldo(self, tipo, valor):
        return Decimal("0.01")


def _movimientoEntrada(tipo=RECIBIDA, contraparte="bc1qorigen"):
    return MovimientoWallet(red="btc", hash="abc123", fecha=datetime(2026, 1, 2, tzinfo=timezone.utc), simbolo="BTC",
                            cantidad=Decimal("0.01"), comision=None, tipo=tipo, contraparte=contraparte)


def _walletRevisada(client, cabeceras, monkeypatch, movimiento):
    from core import wallets_sync, wallets_vigilancia

    lector = _LectorRevision([movimiento])
    monkeypatch.setattr(wallets_vigilancia, "lectorPara", lambda red: lector)
    monkeypatch.setattr(wallets_sync, "lectorPara", lambda red: lector)
    walletId = _enlazar(client, cabeceras).get_json()["wallet"]["id"]
    assert client.post(f"/api/wallets/{walletId}/actualizar", headers=cabeceras).status_code == 200
    return walletId


def _recientes(client):
    return client.get("/api/wallets").get_json()["wallets"][0]["recientes"]


def _verificar(client, cabeceras, walletId, propia=False):
    return client.post(f"/api/wallets/{walletId}/movimientos/marcar", headers=cabeceras,
                       json={"hash": "abc123", "simbolo": "BTC", "sentido": "recibida", "propia": propia}).get_json()


def testUnaEntradaSaleComoPendienteYNoSeImportaAlSincronizar(cliente, monkeypatch):
    client, cabeceras, _ = cliente
    walletId = _walletRevisada(client, cabeceras, monkeypatch, _movimientoEntrada())

    assert _recientes(client)[0]["pendiente"] is True
    sincronizado = client.post(f"/api/wallets/{walletId}/sincronizar", headers=cabeceras).get_json()

    assert (sincronizado["anadidas"], sincronizado["pendientes"]) == (0, 1)
    assert client.get("/api/transacciones").get_json()["rows"] == []


def testUnEnvioNoQuedaPendiente(cliente, monkeypatch):
    client, cabeceras, _ = cliente
    _walletRevisada(client, cabeceras, monkeypatch, _movimientoEntrada(tipo=ENVIADA))

    assert _recientes(client)[0]["pendiente"] is False


@pytest.mark.parametrize("propia, tipo", [(False, "recibida"), (True, "entre_wallet")])
def testVerificarUnaEntradaLaImportaSinReleerLaRed(cliente, monkeypatch, propia, tipo):
    client, cabeceras, _ = cliente
    walletId = _walletRevisada(client, cabeceras, monkeypatch, _movimientoEntrada())

    respuesta = _verificar(client, cabeceras, walletId, propia)

    assert respuesta["importadas"] == 1
    assert [f["walletTipo"] for f in client.get("/api/transacciones").get_json()["rows"]] == [tipo]
    assert _recientes(client)[0]["pendiente"] is False


def testVerificarUnaEntradaAntiguaPideSincronizar(cliente):
    client, cabeceras, _ = cliente
    walletId = _enlazar(client, cabeceras).get_json()["wallet"]["id"]

    respuesta = _verificar(client, cabeceras, walletId)

    assert respuesta["porSincronizar"] is True
    assert client.get("/api/transacciones").get_json()["rows"] == []


def testUnaRecibidaYaImportadaNoSalePendiente(cliente, monkeypatch):
    from core import wallets_sync

    client, cabeceras, _ = cliente
    walletId = _walletRevisada(client, cabeceras, monkeypatch, _movimientoEntrada())
    wallets_sync.SincronizadorWallets(verificarEntradas=False).sincronizar(walletId)

    assert _recientes(client)[0]["pendiente"] is False


def testUnaWalletAjenaNoTieneEntradasPendientes(cliente, monkeypatch):
    from core import wallets_vigilancia

    client, cabeceras, _ = cliente
    monkeypatch.setattr(wallets_vigilancia, "lectorPara", lambda red: _LectorRevision([_movimientoEntrada()]))
    walletId = _enlazar(client, cabeceras, assetId="", propia=False).get_json()["wallet"]["id"]
    client.post(f"/api/wallets/{walletId}/actualizar", headers=cabeceras)

    assert _recientes(client)[0]["pendiente"] is False


def testUnaClavePublicaPropiaSaleEnLaListaConTodasSusDireccionesEnmascaradas(cliente, monkeypatch):
    from core.cripto_direcciones import direccionesDeClavePublica

    client, cabeceras, rutas = cliente
    _ponerContrasena(monkeypatch, rutas)
    walletId = _enlazar(client, cabeceras, tipo="clave", valor=_CLAVE_G).get_json()["wallet"]["id"]
    direcciones = direccionesDeClavePublica(_CLAVE_G)

    listado = client.get("/api/wallets")
    enlazadas = listado.get_json()["direccionesEnlazadas"]

    assert [(d["walletId"], d["clave"], d["derivada"]) for d in enlazadas] == [
        (walletId, f"{walletId}#{indice}", True) for indice in range(4)
    ]
    assert not any(direccion in listado.get_data(as_text=True) for direccion in direcciones)

    completas = client.post("/api/wallets/direcciones/ver-completas", headers=cabeceras,
                            json={"currentPassword": "la-clave-de-la-web"}).get_json()["valores"]
    assert completas == {f"{walletId}#{indice}": direccion for indice, direccion in enumerate(direcciones)}


def testUnMovimientoDesdeUnaDireccionDeLaClaveNoEsUnaEntrada(cliente, monkeypatch):
    from core.cripto_direcciones import direccionesDeClavePublica

    client, cabeceras, _ = cliente
    origen = direccionesDeClavePublica(_CLAVE_G)[2]
    _enlazar(client, cabeceras, alias="Clave", tipo="clave", valor=_CLAVE_G, seguimiento="Clave")
    _walletRevisada(client, cabeceras, monkeypatch, _movimientoEntrada(contraparte=origen))

    wallets = client.get("/api/wallets").get_json()["wallets"]
    movimiento = next(w for w in wallets if w["tipo"] == "xpub")["recientes"][0]

    assert (movimiento["tipo"], movimiento["pendiente"]) == ("entre_wallet", False)


def testEnlazarUnaClavePublicaReetiquetaLoQueVeniaDeSusDirecciones(cliente, monkeypatch):
    from core import wallets_sync
    from core.cripto_direcciones import direccionesDeClavePublica

    client, cabeceras, _ = cliente
    destino = direccionesDeClavePublica(_CLAVE_G)[3]
    monkeypatch.setattr(wallets_sync, "lectorPara", lambda red: _Lector([_movimientoEntrada(ENVIADA, destino)]))
    walletId = _enlazar(client, cabeceras).get_json()["wallet"]["id"]
    client.post(f"/api/wallets/{walletId}/sincronizar", headers=cabeceras)

    enlazada = _enlazar(client, cabeceras, alias="Clave", tipo="clave", valor=_CLAVE_G, seguimiento="Clave").get_json()

    assert enlazada["reetiquetadas"] == 1
    assert client.get("/api/transacciones").get_json()["rows"][0]["walletTipo"] == "entre_wallet"


def testLaWatchlistSinSesionNoSeVe(crearApp, datosAislados, tempDb):
    from routes.wallets import walletsBp

    assert crearApp(walletsBp).test_client().get("/api/wallets/watchlist").status_code == 401
