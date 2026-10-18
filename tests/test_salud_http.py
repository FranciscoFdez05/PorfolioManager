"""Pruebas de GET /api/health.

Los dos casos que justifican el endpoint:

* que responda **503** cuando la base de datos no está, porque el healthcheck
  anterior (`/login`) devolvía 200 en esa situación y el contenedor se quedaba
  en pie sirviendo errores;
* que **no filtre** rutas del disco ni el nombre del portfolio a quien no ha
  iniciado sesión, porque para que el healthcheck del contenedor funcione el
  endpoint tiene que ser público.
"""

import pytest


@pytest.fixture
def clienteSalud(crearApp, tempDb):
    from routes.salud import saludBp

    return crearApp(saludBp).test_client()


# ── Sano ──────────────────────────────────────────────────────────────────────

def testResponde200ConLaBdDisponible(clienteSalud):
    respuesta = clienteSalud.get("/api/health")
    assert respuesta.status_code == 200
    assert respuesta.get_json()["ok"] is True
    assert respuesta.get_json()["estado"] == "ok"


def testEsPublico(clienteSalud):
    """Sin esto el healthcheck del contenedor recibiría 401 y lo marcaría enfermo."""
    assert clienteSalud.get("/api/health").status_code == 200


def testLaRespuestaAnonimaNoLlevaDatosDelUsuario(clienteSalud):
    cuerpo = clienteSalud.get("/api/health").get_json()
    assert set(cuerpo) == {"ok", "estado", "version"}


def testLaRespuestaAnonimaNoMencionaRutasDelDisco(clienteSalud):
    texto = clienteSalud.get("/api/health").get_data(as_text=True)
    for fragmento in ("portfolio.db", "/data", "\\data", "ruta"):
        assert fragmento not in texto


# ── Con sesión ────────────────────────────────────────────────────────────────

def testConSesionIncluyeElDiagnostico(clienteAutenticado, tempDb):
    from routes.salud import saludBp

    client, _, _ = clienteAutenticado(saludBp)
    cuerpo = client.get("/api/health").get_json()

    assert cuerpo["ok"] is True
    assert cuerpo["bd"]["journal_mode"].lower() == "wal"
    assert cuerpo["bd"]["ruta"].endswith("test_portfolio.db")
    assert cuerpo["bd"]["tamano_bytes"] > 0
    assert cuerpo["uptime_segundos"] >= 0
    assert "esquema" in cuerpo["bd"]


def testElEsquemaPublicadoEsElDeLaBd(clienteAutenticado, tempDb):
    """El número de `PRAGMA user_version`: sirve para saber si una BD está migrada."""
    from core import db
    from routes.salud import saludBp

    client, _, _ = clienteAutenticado(saludBp)
    cuerpo = client.get("/api/health").get_json()

    esperado = db.getDb().execute("PRAGMA user_version").fetchone()[0]
    assert cuerpo["bd"]["esquema"] == esperado
    assert esperado > 0, "una BD recién creada debería quedar marcada con la versión actual"


# ── Enfermo ───────────────────────────────────────────────────────────────────

def testResponde503SiLaBdNoResponde(clienteSalud, monkeypatch):
    from routes import salud

    def explotar():
        raise RuntimeError("unable to open database file")

    monkeypatch.setattr(salud.db, "getDb", explotar)

    respuesta = clienteSalud.get("/api/health")
    assert respuesta.status_code == 503
    assert respuesta.get_json()["ok"] is False
    assert respuesta.get_json()["estado"] == "degradado"


def testElFalloAnonimoNoExponeElMensajeDelMotor(clienteSalud, monkeypatch):
    """El error de SQLite puede llevar la ruta absoluta del servidor."""
    from routes import salud

    def explotar():
        raise RuntimeError("unable to open database file: /srv/secreto/portfolio.db")

    monkeypatch.setattr(salud.db, "getDb", explotar)

    texto = clienteSalud.get("/api/health").get_data(as_text=True)
    assert "/srv/secreto" not in texto
    assert "no disponible" in texto


def testUnaBdCorruptaSeDetecta(clienteSalud, monkeypatch, tmp_path):
    """`quick_check` es lo que distingue este endpoint de un simple `SELECT 1`."""
    from routes import salud

    class ConexionCorrupta:
        def execute(self, sql, *args):
            if "quick_check" in sql:
                return _Fila(["*** in database main *** Page 4 is never used"])
            return _Fila([1])

    class _Fila:
        def __init__(self, valores):
            self._valores = valores

        def fetchone(self):
            return self._valores

    monkeypatch.setattr(salud.db, "getDb", ConexionCorrupta)

    respuesta = clienteSalud.get("/api/health")
    assert respuesta.status_code == 503
    assert respuesta.get_json()["fallo"] == "corrupta"


def testConSesionPublicaElEstadoDeLosDirectorios(clienteAutenticado, tempDb, datosAislados):
    """El diagnóstico que faltaba cuando "no guarda nada" en Docker.

    Dice qué ruta resolvió la aplicación **dentro** del contenedor y si puede
    escribir en ella, que es justo lo que no se ve desde el host.
    """
    from routes.salud import saludBp

    client, _, _ = clienteAutenticado(saludBp)
    almacenamiento = client.get("/api/health").get_json()["almacenamiento"]

    assert set(almacenamiento) >= {"datos", "portfolios", "json", "backups", "claves"}
    assert almacenamiento["datos"]["ruta"] == str(datosAislados["data"])
    assert almacenamiento["datos"]["escribible"] is True


def testElEstadoDeLosDirectoriosNoSaleSinSesion(clienteSalud):
    assert "almacenamiento" not in clienteSalud.get("/api/health").get_json()
