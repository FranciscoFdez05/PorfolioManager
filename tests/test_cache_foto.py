"""Caché por foto de la base de datos y lo que la usa (core/cache_foto.py).

Lo que no puede pasar es servir un dato viejo tras una escritura: ni la de esta
conexión, ni la de otra, ni un cambio de tipo de cambio que no está en la base.
"""

import sqlite3
import threading
from decimal import Decimal

import pytest

from core import db
from core.cache_foto import CachePorFoto
from core.db import getDb
from stores import historico_tipos


def escribir(conn, valor="x"):
    conn.execute("INSERT INTO gastos_tipos (label) VALUES (?)", (valor,))
    conn.commit()


@pytest.mark.usefixtures("tempDb")
class TestCachePorFoto:
    def testElSegundoAciertoNoRecalcula(self):
        cache = CachePorFoto()
        llamadas = []

        def calcular():
            llamadas.append(1)
            return "valor", None

        assert cache.obtener(getDb(), "k", calcular) == "valor"
        assert cache.obtener(getDb(), "k", calcular) == "valor"
        assert len(llamadas) == 1

    def testUnaEscrituraDeEstaConexionInvalida(self):
        cache = CachePorFoto()
        conn = getDb()
        cache.obtener(conn, "k", lambda: ("viejo", None))

        escribir(conn, "a")

        assert cache.obtener(conn, "k", lambda: ("nuevo", None)) == "nuevo"

    def testUnaEscrituraDeOtraConexionInvalida(self):
        cache = CachePorFoto()
        conn = getDb()
        cache.obtener(conn, "k", lambda: ("viejo", None))
        ruta = str(db.getActiveDbPath())

        def otraConexion():
            otra = sqlite3.connect(ruta)
            otra.execute("INSERT INTO gastos_tipos (label) VALUES ('b')")
            otra.commit()
            otra.close()

        hilo = threading.Thread(target=otraConexion)
        hilo.start()
        hilo.join()

        assert cache.obtener(conn, "k", lambda: ("nuevo", None)) == "nuevo"

    def testCambiarDeBaseInvalida(self, tmp_path):
        cache = CachePorFoto()
        cache.obtener(getDb(), "k", lambda: ("viejo", None))

        db.setActiveDbPath(tmp_path / "otra.db")
        db.initDb()

        assert cache.obtener(getDb(), "k", lambda: ("nuevo", None)) == "nuevo"

    def testValidarFalsoRecalculaYVerdaderoReutiliza(self):
        cache = CachePorFoto()
        conn = getDb()
        cache.obtener(conn, "k", lambda: ("uno", 1))

        assert cache.obtener(conn, "k", lambda: ("dos", 2), lambda contexto: contexto == 1) == "uno"
        assert cache.obtener(conn, "k", lambda: ("dos", 2), lambda contexto: False) == "dos"
        assert cache.obtener(conn, "k", lambda: ("tres", 3), lambda contexto: contexto == 2) == "dos"

    def testClavesDistintasNoSeMezclan(self):
        cache = CachePorFoto()
        conn = getDb()

        assert cache.obtener(conn, "a", lambda: (1, None)) == 1
        assert cache.obtener(conn, "b", lambda: (2, None)) == 2
        assert cache.obtener(conn, "a", lambda: (9, None)) == 1

    def testRespetaElTopeDeEntradas(self):
        cache = CachePorFoto(maxEntradas=2)
        conn = getDb()
        for clave in ("a", "b", "c"):
            cache.obtener(conn, clave, lambda clave=clave: (clave, None))

        # Al llegar a la tercera se vació: "c" sigue y "a" se recalcula.
        assert cache.obtener(conn, "c", lambda: ("otro", None)) == "c"
        assert cache.obtener(conn, "a", lambda: ("recalculado", None)) == "recalculado"

    def testCadaHiloTieneSuCache(self):
        cache = CachePorFoto()
        cache.obtener(getDb(), "k", lambda: ("principal", None))
        resultado = []

        def otroHilo():
            resultado.append(cache.obtener(getDb(), "k", lambda: ("hilo", None)))

        hilo = threading.Thread(target=otroHilo)
        hilo.start()
        hilo.join()

        assert resultado == ["hilo"]


@pytest.fixture
def clienteGastos(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.gastos import gastosBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    client, cabeceras, _app = clienteAutenticado(gastosBp)
    return client, cabeceras


def guardarGasto(client, cabeceras, year="2026", cantidad="12,50"):
    respuesta = client.post(
        f"/api/gastos/{year}",
        json={"year": year, "months": {"marzo": {"rows": [{"nombre": "Luz", "cantidad": cantidad, "fecha": f"01-03-{year}"}]}}},
        headers=cabeceras,
    )
    assert respuesta.status_code == 200, respuesta.get_json()


class TestGastosTodosCacheado:
    def testDosPeticionesDanLoMismoYLaSegundaNoLeeAnios(self, clienteGastos, monkeypatch):
        client, cabeceras = clienteGastos
        guardarGasto(client, cabeceras)
        primera = client.get("/api/gastos/todos")

        import routes.gastos as rutaGastos

        def noDeberiaLeer(year):
            raise AssertionError("la segunda petición debía salir de la caché")

        monkeypatch.setattr(rutaGastos, "readGastosYear", noDeberiaLeer)
        segunda = client.get("/api/gastos/todos")

        assert segunda.status_code == 200
        assert segunda.get_data() == primera.get_data()
        assert segunda.mimetype == "application/json"

    def testGuardarUnAnioInvalida(self, clienteGastos):
        client, cabeceras = clienteGastos
        guardarGasto(client, cabeceras, "2026", "12,50")
        antes = client.get("/api/gastos/todos").get_json()["years"]

        guardarGasto(client, cabeceras, "2026", "99")
        guardarGasto(client, cabeceras, "2025", "5")
        despues = client.get("/api/gastos/todos").get_json()["years"]

        assert sorted(despues) == ["2025", "2026"]
        assert despues["2026"] != antes["2026"]
        assert despues["2026"] == client.get("/api/gastos/2026").get_json()

    def testBorrarUnAnioInvalida(self, clienteGastos):
        client, cabeceras = clienteGastos
        guardarGasto(client, cabeceras, "2025")
        guardarGasto(client, cabeceras, "2026")
        assert sorted(client.get("/api/gastos/todos").get_json()["years"]) == ["2025", "2026"]

        respuesta = client.delete("/api/gastos/2025", headers=cabeceras)
        assert respuesta.status_code == 200, respuesta.get_json()

        assert sorted(client.get("/api/gastos/todos").get_json()["years"]) == ["2026"]

    def testSinDatosSigueDevolviendoVacio(self, clienteGastos):
        client, _cabeceras = clienteGastos

        assert client.get("/api/gastos/todos").get_json() == {"years": {}}


@pytest.fixture
def clienteCuentas(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.cuentas import cuentasBp

    client, cabeceras, _app = clienteAutenticado(cuentasBp)
    return client, cabeceras


def transferir(client, cabeceras, cantidad="12,5"):
    respuesta = client.post(
        "/api/transferencias",
        json={"origen": "banco", "destino": "ahorro", "cantidad": cantidad, "fecha": "02-01-2026"},
        headers=cabeceras,
    )
    assert respuesta.status_code in (200, 201), respuesta.get_json()


class TestHistoricoDeCuentasCacheado:
    def testRepetidaDaLoMismo(self, clienteCuentas):
        client, cabeceras = clienteCuentas
        transferir(client, cabeceras)

        primera = client.get("/api/cuentas/historico")
        segunda = client.get("/api/cuentas/historico")

        assert primera.status_code == 200
        assert segunda.get_data() == primera.get_data()
        assert "ahorro" in primera.get_json()["cuentas"]

    def testUnaTransferenciaNuevaInvalida(self, clienteCuentas):
        client, cabeceras = clienteCuentas
        transferir(client, cabeceras, "12,5")
        antes = client.get("/api/cuentas/historico").get_json()["cuentas"]["ahorro"]

        transferir(client, cabeceras, "7,5")
        despues = client.get("/api/cuentas/historico").get_json()["cuentas"]["ahorro"]

        assert antes[-1]["saldo"] == "12.50"
        assert despues[-1]["saldo"] == "20.00"

    def testElCambioDeDivisaInvalida(self, clienteCuentas, monkeypatch):
        import routes.cuentas as rutaCuentas

        client, cabeceras = clienteCuentas
        conn = getDb()
        conn.execute("UPDATE cuentas SET dividendos = 1 WHERE id = 'banco'")
        conn.execute(
            "INSERT INTO dividendos (fecha, instrumento, total, moneda_total, cuenta) "
            "VALUES ('05-01-2026', 'X', '10', 'USD', 'banco')"
        )
        conn.commit()
        tipos = {"USD": Decimal("2")}

        def fabrica():
            return lambda importe, moneda: importe * tipos.get(str(moneda).upper(), Decimal(1))

        monkeypatch.setattr(rutaCuentas, "_cambioAEuros", fabrica)

        antes = client.get("/api/cuentas/historico").get_json()["cuentas"]["banco"][-1]["saldo"]
        tipos["USD"] = Decimal("3")
        despues = client.get("/api/cuentas/historico").get_json()["cuentas"]["banco"][-1]["saldo"]

        assert Decimal(despues) - Decimal(antes) == Decimal("10")


@pytest.mark.usefixtures("tempDb")
class TestPrecalentarHistoricoPorTipo:
    def testDejaElAgregadoCalculado(self):
        historico_tipos.invalidar()

        historico_tipos.precalentar().join(timeout=30)

        assert str(db.getActiveDbPath()) in historico_tipos._cache

    def testUnFalloNoSePropaga(self, monkeypatch):
        def roto(conn):
            raise RuntimeError("base rota")

        monkeypatch.setattr(historico_tipos, "_agregado", roto)

        hilo = historico_tipos.precalentar()
        hilo.join(timeout=30)

        assert not hilo.is_alive()
