"""Regresiones de tolerancia a fallos: cuerpos no-objeto, fechas imposibles,
hueco de snapshot perdido y hilo de Telegram."""

import contextlib
import re
from datetime import date

import pytest
from flask import Flask

from admin import snapshot_scheduler, telegram_listener
from core import telegram_notifier
from core.errors import registerErrorHandlers
from stores.cuentas_historico import historicoSaldos


@pytest.fixture
def appRutas(tempDb, datosAislados):
    from routes.activos import activosBp
    from routes.categorias import categoriasBp
    from routes.cuentas import cuentasBp
    from routes.gastos import gastosBp
    from routes.ingresos import ingresosBp
    from routes.operaciones import operacionesBp
    from routes.registros import registrosBp
    from routes.trading import tradingBp

    app = Flask(__name__)
    registerErrorHandlers(app)
    for blueprint in (activosBp, categoriasBp, cuentasBp, gastosBp, ingresosBp, operacionesBp, registrosBp, tradingBp):
        app.register_blueprint(blueprint)
    return app


def _rutasEscritura(app):
    for regla in app.url_map.iter_rules():
        url = re.sub(r"<(?:int:)?[^>]+>", "1", regla.rule)
        if "fx/rellenar" in url:
            continue
        for metodo in regla.methods & {"POST", "PUT"}:
            yield metodo, url


class TestCuerpoNoObjeto:
    @pytest.mark.parametrize("cuerpo", [[1, 2], "txt", 5])
    def testNingunaRutaDeEscrituraDa500(self, appRutas, cuerpo):
        cliente = appRutas.test_client()
        fallos = [
            f"{metodo} {url}"
            for metodo, url in _rutasEscritura(appRutas)
            if cliente.open(url, method=metodo, json=cuerpo).status_code >= 500
        ]
        assert fallos == []

    def testUnCuerpoVacioSigueSiendoValido(self, appRutas):
        cliente = appRutas.test_client()
        assert cliente.post("/api/gastos-tipos").status_code == 200
        assert cliente.post("/api/gastos-tipos", json={"types": []}).status_code == 200

    def testUnCuerpoNoObjetoEs400(self, appRutas):
        assert appRutas.test_client().post("/api/trading", json=5).status_code == 400


class TestHistoricoConAnoImposible:
    def testUnDividendoDelAnoCeroNoRompeElHistorico(self, tempDb):
        from core.db import getDb

        conn = getDb()
        conn.execute(
            "INSERT INTO dividendos (fecha, total, moneda_total, cuenta) VALUES ('01-01-0000', '5', 'EUR', 'banco')"
        )
        conn.commit()

        series = historicoSaldos(conn, hoy=date(2026, 5, 10), aEuros=lambda importe, moneda: importe)

        assert "banco" in series


class TestHuecoDeSnapshot:
    def _preparar(self, monkeypatch, tmp_path, valoracion):
        from routes import backup, snapshots
        from stores import valoracion as modValoracion

        monkeypatch.setattr(snapshot_scheduler, "_rutasObjetivo", lambda: [tmp_path / "t.db"])
        monkeypatch.setattr(backup, "bloqueoSiLibre", contextlib.nullcontext)
        eventos = []
        monkeypatch.setattr(snapshots, "reservarBucket", lambda ahora=None: eventos.append("reserva") or True)
        monkeypatch.setattr(snapshots, "liberarBucket", lambda ahora=None: eventos.append("libera"))
        monkeypatch.setattr(modValoracion, "valorarPortfolio", valoracion)
        monkeypatch.setattr(snapshot_scheduler, "useDbPath", lambda ruta: contextlib.nullcontext())
        return eventos

    def testValoracionIncompletaLiberaElHuecoYPideReintento(self, monkeypatch, tmp_path):
        eventos = self._preparar(monkeypatch, tmp_path, lambda refrescarPrecios=True: {"activos": 1, "completa": False})

        snapshot_scheduler.ejecutarUnaVez()

        assert eventos == ["reserva", "libera"]
        assert snapshot_scheduler._reintentoPendiente is True

    def testUnaExcepcionTrasReservarLiberaElHueco(self, monkeypatch, tmp_path):
        def falla(refrescarPrecios=True):
            raise RuntimeError("proveedor caido")

        eventos = self._preparar(monkeypatch, tmp_path, falla)

        snapshot_scheduler.ejecutarUnaVez()

        assert eventos == ["reserva", "libera"]

    def testElReintentoNoEncadenaOtroReintento(self, monkeypatch, tmp_path):
        self._preparar(monkeypatch, tmp_path, lambda refrescarPrecios=True: {"activos": 1, "completa": False})

        snapshot_scheduler.ejecutarUnaVez(esReintento=True)

        assert snapshot_scheduler._reintentoPendiente is False

    def testLiberarBucketDejaElHuecoReservable(self, tempDb):
        from routes.snapshots import liberarBucket, reservarBucket

        assert reservarBucket(1_000_000) is True
        assert reservarBucket(1_000_000) is False
        liberarBucket(1_000_000)
        assert reservarBucket(1_000_000) is True


class TestHiloDeTelegram:
    @pytest.fixture(autouse=True)
    def _limpio(self):
        telegram_notifier.reiniciarParaPruebas()
        yield
        telegram_listener.detener()
        telegram_notifier.reiniciarParaPruebas()

    def testUnaConfigIlegibleNoMataElHilo(self, monkeypatch):
        def falla():
            raise OSError("fichero ilegible")

        monkeypatch.setattr(telegram_notifier, "leerConfig", falla)
        # La espera es lo que corta el bucle: True equivale a "se pidio parar".
        monkeypatch.setattr(telegram_listener._parada, "wait", lambda segundos: True)

        assert telegram_listener._escuchar() is True

    def testUnaActualizacionSinIdNoMataElHilo(self, monkeypatch):
        monkeypatch.setattr(telegram_notifier, "leerConfig", lambda: ("tok", "1"))
        monkeypatch.setattr(telegram_listener, "_registrarMenu", lambda token: None)
        llamadas = {"n": 0}

        def getUpdates(token, offset):
            llamadas["n"] += 1
            if llamadas["n"] > 1:
                telegram_listener._parada.set()
                return []
            return [{"message": {"text": "/start"}}]

        monkeypatch.setattr(telegram_listener, "_getUpdates", getUpdates)
        telegram_listener._parada.clear()

        assert telegram_listener._escuchar() is True
        assert llamadas["n"] == 2
