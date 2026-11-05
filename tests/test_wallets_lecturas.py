"""Pruebas de las lecturas guardadas del detalle de una wallet.

Lo esencial: volver a entrar enseña lo ya leído sin tocar la red, buscar lo nuevo no
pierde lo anterior, el fichero no lleva nada en claro y un fallo de la red o del
almacén no se lleva lo guardado.
"""

from datetime import datetime, timezone
from decimal import Decimal

import pytest
from cryptography.fernet import Fernet

from core.wallets_historial import HistorialWallets, claveMovimiento, fusionarMovimientos
from providers.blockchain_clients import RECIBIDA, ErrorLecturaWallet, MovimientoWallet, UtxoBitcoin
from stores.wallets_lecturas import SECCION_MOVIMIENTOS, SECCION_UTXOS, LecturasRepository

_DIRECCION = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"


def _fila(hashTx: str, fecha: str = "2026-01-01T00:00:00+00:00", **cambios) -> dict:
    return {"hash": hashTx, "fecha": fecha, "simbolo": "BTC", "cantidad": "1", "tipo": "recibida",
            "contraparte": "x", "propia": "y", "contrato": "", **cambios}


def _almacen(tmp_path, clave: bytes | None = None) -> LecturasRepository:
    fernet = Fernet(clave or Fernet.generate_key())
    return LecturasRepository(tmp_path / "lecturas", lambda: fernet)


def _lector(pagina: list[dict], registro: list[int] | None = None):
    def leerRed(limite: int) -> list[dict]:
        if registro is not None:
            registro.append(limite)
        return pagina[:limite]
    return leerRed


def _leer(servicio, leerRed, limite=100, maximo=1000, **opciones):
    return servicio.leer("wallet-1", limite, maximo, leerRed, lambda filas: [], **opciones)


class TestAlmacen:
    def testGuardaCifradoYLoRecupera(self, tmp_path):
        almacen = _almacen(tmp_path)

        assert almacen.guardar("wallet-1", SECCION_UTXOS, {"direccion": _DIRECCION}) is True

        assert almacen.leer("wallet-1") == {SECCION_UTXOS: {"direccion": _DIRECCION}}
        assert _DIRECCION.encode() not in (tmp_path / "lecturas" / "wallet-1.key").read_bytes()

    def testGuardarUnaSeccionNoTocaLasDemas(self, tmp_path):
        almacen = _almacen(tmp_path)
        almacen.guardar("wallet-1", SECCION_UTXOS, {"a": 1})

        almacen.guardar("wallet-1", SECCION_MOVIMIENTOS, {"b": 2})

        assert almacen.leer("wallet-1") == {SECCION_UTXOS: {"a": 1}, SECCION_MOVIMIENTOS: {"b": 2}}

    def testConOtraClaveCuentaComoVacioSinFallar(self, tmp_path):
        _almacen(tmp_path).guardar("wallet-1", SECCION_UTXOS, {"a": 1})

        assert _almacen(tmp_path).leer("wallet-1") == {}

    @pytest.mark.parametrize("contenido", [b"", b"basura", b"LEC1:basura"])
    def testUnFicheroDanadoCuentaComoVacio(self, tmp_path, contenido):
        almacen = _almacen(tmp_path)
        almacen.guardar("wallet-1", SECCION_UTXOS, {"a": 1})
        (tmp_path / "lecturas" / "wallet-1.key").write_bytes(contenido)

        assert almacen.leer("wallet-1") == {}

    def testSinClaveNoGuardaNada(self, tmp_path):
        almacen = LecturasRepository(tmp_path / "lecturas", lambda: None)

        assert almacen.disponible is False
        assert almacen.guardar("wallet-1", SECCION_UTXOS, {"a": 1}) is False
        assert almacen.leer("wallet-1") == {}
        assert not (tmp_path / "lecturas").exists()

    @pytest.mark.parametrize("walletId", ["../wallets", "..\\wallets", "a/b", "", "a.b"])
    def testUnIdentificadorRaroNoSaleDeLaCarpeta(self, tmp_path, walletId):
        almacen = _almacen(tmp_path)

        assert almacen.guardar(walletId, SECCION_UTXOS, {"a": 1}) is False
        assert almacen.leer(walletId) == {}
        almacen.borrar(walletId)
        assert not (tmp_path / "wallets.key").exists()

    def testBorrarOlvidaYNoFallaSiNoHabiaNada(self, tmp_path):
        almacen = _almacen(tmp_path)
        almacen.guardar("wallet-1", SECCION_UTXOS, {"a": 1})

        almacen.borrar("wallet-1")
        almacen.borrar("wallet-1")

        assert almacen.leer("wallet-1") == {}
        assert list((tmp_path / "lecturas").iterdir()) == []


class TestFusion:
    def testUnaMismaTransaccionConMonedaYTokenSonDos(self):
        moneda, token = _fila("h1"), _fila("h1", simbolo="USDT", contrato="0xabc")

        assert claveMovimiento(moneda) != claveMovimiento(token)

    def testLoLeidoSustituyeALoGuardadoSinRepetir(self):
        pendiente = _fila("h1", fecha="")
        confirmada = _fila("h1", fecha="2026-02-01T00:00:00+00:00")

        assert fusionarMovimientos([confirmada], [pendiente], 10) == [confirmada]

    def testOrdenaDeMasRecienteAMasAntiguoYRespetaElTope(self):
        vieja = _fila("h1", fecha="2026-01-01T00:00:00+00:00")
        media = _fila("h2", fecha="2026-02-01T00:00:00+00:00")
        nueva = _fila("h3", fecha="2026-03-01T00:00:00+00:00")

        assert fusionarMovimientos([nueva], [media, vieja], 2) == [nueva, media]


class TestServicio:
    def testBuscarLoNuevoConservaLoYaCargado(self, tmp_path):
        servicio = HistorialWallets(_almacen(tmp_path))
        antiguas = [_fila(f"h{i}") for i in range(250)]
        _leer(servicio, _lector(antiguas), limite=250)
        nueva = _fila("nueva", fecha="2026-05-01T00:00:00+00:00")

        leido = _leer(servicio, _lector([nueva, *antiguas]), limite=100)

        assert len(leido.filas) == 251
        assert leido.filas[0] == nueva
        assert leido.limite == 250
        assert leido.guardado is True

    def testSiLaLecturaFallaLoGuardadoSigueIntacto(self, tmp_path):
        almacen = _almacen(tmp_path)
        servicio = HistorialWallets(almacen)
        _leer(servicio, _lector([_fila("h1")]))

        def falla(limite):
            raise ErrorLecturaWallet("red caída")

        with pytest.raises(ErrorLecturaWallet):
            _leer(servicio, falla, reiniciar=True)

        assert [f["hash"] for f in almacen.leer("wallet-1")[SECCION_MOVIMIENTOS]["filas"]] == ["h1"]

    def testReiniciarOlvidaLoQueLaRedYaNoDevuelve(self, tmp_path):
        servicio = HistorialWallets(_almacen(tmp_path))
        _leer(servicio, _lector([_fila("descartada"), _fila("h1")]))

        leido = _leer(servicio, _lector([_fila("h1")]), reiniciar=True)

        assert [f["hash"] for f in leido.filas] == ["h1"]

    def testPideMasHastaEnlazarParaNoDejarUnHueco(self, tmp_path):
        servicio = HistorialWallets(_almacen(tmp_path))
        antigua = _fila("antigua")
        _leer(servicio, _lector([antigua]))
        recientes = [_fila(f"r{i}", fecha="2026-06-01T00:00:00+00:00") for i in range(150)]
        pedidos: list[int] = []

        leido = _leer(servicio, _lector([*recientes, antigua], pedidos), limite=100)

        assert pedidos == [100, 200]
        assert len(leido.filas) == 151

    def testNoInsisteMasAllaDelMaximo(self, tmp_path):
        servicio = HistorialWallets(_almacen(tmp_path))
        _leer(servicio, _lector([_fila("antigua")]))
        recientes = [_fila(f"r{i}", fecha="2026-06-01T00:00:00+00:00") for i in range(500)]
        pedidos: list[int] = []

        _leer(servicio, _lector(recientes, pedidos), limite=100, maximo=150)

        assert pedidos == [100, 150]

    def testAgotadoSoloSiPedirMasNoTraeNada(self, tmp_path):
        servicio = HistorialWallets(_almacen(tmp_path))
        filas = [_fila("h1"), _fila("h2")]

        assert _leer(servicio, _lector(filas), limite=100).agotado is False
        assert _leer(servicio, _lector(filas), limite=100).agotado is False
        assert _leer(servicio, _lector(filas), limite=200).agotado is True
        # Buscar lo nuevo no cambia lo que se sabe de lo más antiguo.
        assert _leer(servicio, _lector(filas), limite=100).agotado is True

    def testWalletVaciaQuedaAgotada(self, tmp_path):
        assert _leer(HistorialWallets(_almacen(tmp_path)), _lector([])).agotado is True

    def testSinClaveDevuelveLoLeidoSinGuardar(self, tmp_path):
        leido = _leer(HistorialWallets(LecturasRepository(tmp_path, lambda: None)), _lector([_fila("h1")]))

        assert [f["hash"] for f in leido.filas] == ["h1"]
        assert leido.guardado is False


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.registros import registrosBp
    from routes.wallets import walletsBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(walletsBp, registrosBp)
    respuesta = client.post("/api/wallets", json={
        "alias": "Satoshi", "red": "btc", "tipo": "direccion", "valor": _DIRECCION, "assetId": "", "propia": False,
    }, headers=cabeceras)
    assert respuesta.status_code == 200
    return client, cabeceras, respuesta.get_json()["wallet"]["id"], datosAislados


class _LectorFalso:
    def __init__(self, movimientos):
        self.movimientos = movimientos
        self.llamadas = 0

    def leer(self, _tipo, _valor, limite):
        self.llamadas += 1
        if isinstance(self.movimientos, Exception):
            raise self.movimientos
        return self.movimientos[:limite]


def _movimiento(hashTx: str, dia: int = 1) -> MovimientoWallet:
    return MovimientoWallet(red="btc", hash=hashTx, fecha=datetime(2026, 1, dia, tzinfo=timezone.utc), simbolo="BTC",
                            cantidad=Decimal("0.5"), comision=None, tipo=RECIBIDA, contraparte="bc1qotra")


def _ponerLector(monkeypatch, movimientos) -> _LectorFalso:
    lector = _LectorFalso(movimientos)
    monkeypatch.setattr("routes.wallets.lectorPara", lambda _red: lector)
    return lector


class TestRutas:
    def testLoLeidoSeVeAlVolverSinTocarLaRed(self, cliente, monkeypatch):
        client, _cabeceras, walletId, rutas = cliente
        hashLargo = "abcdef0123456789abcdef0123456789"
        lector = _ponerLector(monkeypatch, [_movimiento(hashLargo)])

        assert client.get(f"/api/wallets/{walletId}/movimientos").get_json()["guardado"] is True
        llamadas = lector.llamadas
        guardado = client.get("/api/wallets/seguimientos/lecturas", query_string={"clave": "satoshi"}).get_json()

        assert lector.llamadas == llamadas
        historial = guardado["lecturas"][walletId]["movimientos"]
        assert [m["hash"] for m in historial["movimientos"]] == [hashLargo]
        assert historial["fecha"]
        # Con la libreta aplicada al enseñarlo, igual que lo recién leído.
        assert "sentido" in historial["movimientos"][0]
        assert hashLargo.encode() not in (rutas["claves"] / "wallets_lecturas" / f"{walletId}.key").read_bytes()

    def testLosNuevosSeSumanALoGuardado(self, cliente, monkeypatch):
        client, _cabeceras, walletId, _rutas = cliente
        _ponerLector(monkeypatch, [_movimiento("h1")])
        client.get(f"/api/wallets/{walletId}/movimientos")
        _ponerLector(monkeypatch, [_movimiento("h2", 2)])

        datos = client.get(f"/api/wallets/{walletId}/movimientos").get_json()

        assert [m["hash"] for m in datos["movimientos"]] == ["h2", "h1"]

    def testReiniciarSustituyeLoGuardado(self, cliente, monkeypatch):
        client, _cabeceras, walletId, _rutas = cliente
        _ponerLector(monkeypatch, [_movimiento("h1")])
        client.get(f"/api/wallets/{walletId}/movimientos")
        _ponerLector(monkeypatch, [_movimiento("h2", 2)])

        datos = client.get(f"/api/wallets/{walletId}/movimientos?reiniciar=1").get_json()

        assert [m["hash"] for m in datos["movimientos"]] == ["h2"]

    def testSiFallaLaRedLoGuardadoSeSigueViendo(self, cliente, monkeypatch):
        client, _cabeceras, walletId, _rutas = cliente
        _ponerLector(monkeypatch, [_movimiento("h1")])
        client.get(f"/api/wallets/{walletId}/movimientos")
        _ponerLector(monkeypatch, ErrorLecturaWallet("red caída"))

        assert client.get(f"/api/wallets/{walletId}/movimientos?reiniciar=1").status_code == 502
        guardado = client.get("/api/wallets/seguimientos/lecturas", query_string={"clave": "satoshi"}).get_json()

        assert [m["hash"] for m in guardado["lecturas"][walletId]["movimientos"]["movimientos"]] == ["h1"]

    def testUtxosSeGuardanEnmascarados(self, cliente, monkeypatch):
        client, _cabeceras, walletId, _rutas = cliente

        class Lector:
            def utxos(self, _tipo, _valor):
                return [UtxoBitcoin(txid="t", vout=0, satoshis=1000, direccion=_DIRECCION, altura=5, fecha=None)], 10

        monkeypatch.setattr("routes.wallets.lectorUtxos", Lector)
        assert client.get(f"/api/wallets/{walletId}/utxos").status_code == 200

        respuesta = client.get("/api/wallets/seguimientos/lecturas", query_string={"clave": "satoshi"})
        utxos = respuesta.get_json()["lecturas"][walletId]["utxos"]

        assert _DIRECCION not in respuesta.get_data(as_text=True)
        assert utxos["alturaActual"] == 10
        assert utxos["fecha"]

    def testOtroSeguimientoNoVeLoGuardado(self, cliente, monkeypatch):
        client, _cabeceras, walletId, _rutas = cliente
        _ponerLector(monkeypatch, [_movimiento("h1")])
        client.get(f"/api/wallets/{walletId}/movimientos")

        datos = client.get("/api/wallets/seguimientos/lecturas", query_string={"clave": "otro"}).get_json()

        assert datos["lecturas"] == {}

    def testDesenlazarBorraLoGuardado(self, cliente, monkeypatch):
        client, cabeceras, walletId, rutas = cliente
        _ponerLector(monkeypatch, [_movimiento("h1")])
        client.get(f"/api/wallets/{walletId}/movimientos")
        fichero = rutas["claves"] / "wallets_lecturas" / f"{walletId}.key"
        assert fichero.exists()

        assert client.delete(f"/api/wallets/{walletId}", headers=cabeceras).status_code == 200

        assert not fichero.exists()

    def testDejarDeSeguirBorraLoGuardado(self, cliente, monkeypatch):
        client, cabeceras, walletId, rutas = cliente
        _ponerLector(monkeypatch, [_movimiento("h1")])
        client.get(f"/api/wallets/{walletId}/movimientos")
        fichero = rutas["claves"] / "wallets_lecturas" / f"{walletId}.key"

        respuesta = client.post("/api/wallets/seguimientos/eliminar", json={"clave": "satoshi"}, headers=cabeceras)

        assert respuesta.status_code == 200
        assert not fichero.exists()

    def testSinSecretKeyDeCalidadSeLeeIgualSinGuardar(self, cliente, monkeypatch):
        client, _cabeceras, walletId, _rutas = cliente
        monkeypatch.setenv("SECRET_KEY", "corta")
        _ponerLector(monkeypatch, [_movimiento("h1")])

        datos = client.get(f"/api/wallets/{walletId}/movimientos").get_json()

        assert [m["hash"] for m in datos["movimientos"]] == ["h1"]
        assert datos["guardado"] is False

    def testSinSesionNoSeVeLoGuardado(self, crearApp, datosAislados, tempDb):
        from routes.wallets import walletsBp

        respuesta = crearApp(walletsBp).test_client().get("/api/wallets/seguimientos/lecturas?clave=x")

        assert respuesta.status_code == 401
