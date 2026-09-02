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
def cliente_salud(crear_app, temp_db):
    from routes.salud import salud_bp

    return crear_app(salud_bp).test_client()


# ── Sano ──────────────────────────────────────────────────────────────────────

def test_responde_200_con_la_bd_disponible(cliente_salud):
    respuesta = cliente_salud.get("/api/health")
    assert respuesta.status_code == 200
    assert respuesta.get_json()["ok"] is True
    assert respuesta.get_json()["estado"] == "ok"


def test_es_publico(cliente_salud):
    """Sin esto el healthcheck del contenedor recibiría 401 y lo marcaría enfermo."""
    assert cliente_salud.get("/api/health").status_code == 200


def test_la_respuesta_anonima_no_lleva_datos_del_usuario(cliente_salud):
    cuerpo = cliente_salud.get("/api/health").get_json()
    assert set(cuerpo) == {"ok", "estado", "version"}


def test_la_respuesta_anonima_no_menciona_rutas_del_disco(cliente_salud):
    texto = cliente_salud.get("/api/health").get_data(as_text=True)
    for fragmento in ("portfolio.db", "/data", "\\data", "ruta"):
        assert fragmento not in texto


# ── Con sesión ────────────────────────────────────────────────────────────────

def test_con_sesion_incluye_el_diagnostico(cliente_autenticado, temp_db):
    from routes.salud import salud_bp

    client, _, _ = cliente_autenticado(salud_bp)
    cuerpo = client.get("/api/health").get_json()

    assert cuerpo["ok"] is True
    assert cuerpo["bd"]["journal_mode"].lower() == "wal"
    assert cuerpo["bd"]["ruta"].endswith("test_portfolio.db")
    assert cuerpo["bd"]["tamano_bytes"] > 0
    assert cuerpo["uptime_segundos"] >= 0
    assert "esquema" in cuerpo["bd"]


def test_el_esquema_publicado_es_el_de_la_bd(cliente_autenticado, temp_db):
    """El número de `PRAGMA user_version`: sirve para saber si una BD está migrada."""
    from core import db
    from routes.salud import salud_bp

    client, _, _ = cliente_autenticado(salud_bp)
    cuerpo = client.get("/api/health").get_json()

    esperado = db.get_db().execute("PRAGMA user_version").fetchone()[0]
    assert cuerpo["bd"]["esquema"] == esperado
    assert esperado > 0, "una BD recién creada debería quedar marcada con la versión actual"


# ── Enfermo ───────────────────────────────────────────────────────────────────

def test_responde_503_si_la_bd_no_responde(cliente_salud, monkeypatch):
    from routes import salud

    def explotar():
        raise RuntimeError("unable to open database file")

    monkeypatch.setattr(salud.db, "get_db", explotar)

    respuesta = cliente_salud.get("/api/health")
    assert respuesta.status_code == 503
    assert respuesta.get_json()["ok"] is False
    assert respuesta.get_json()["estado"] == "degradado"


def test_el_fallo_anonimo_no_expone_el_mensaje_del_motor(cliente_salud, monkeypatch):
    """El error de SQLite puede llevar la ruta absoluta del servidor."""
    from routes import salud

    def explotar():
        raise RuntimeError("unable to open database file: /srv/secreto/portfolio.db")

    monkeypatch.setattr(salud.db, "get_db", explotar)

    texto = cliente_salud.get("/api/health").get_data(as_text=True)
    assert "/srv/secreto" not in texto
    assert "no disponible" in texto


def test_una_bd_corrupta_se_detecta(cliente_salud, monkeypatch, tmp_path):
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

    monkeypatch.setattr(salud.db, "get_db", ConexionCorrupta)

    respuesta = cliente_salud.get("/api/health")
    assert respuesta.status_code == 503
    assert respuesta.get_json()["fallo"] == "corrupta"


def test_con_sesion_publica_el_estado_de_los_directorios(cliente_autenticado, temp_db, datos_aislados):
    """El diagnóstico que faltaba cuando "no guarda nada" en Docker.

    Dice qué ruta resolvió la aplicación **dentro** del contenedor y si puede
    escribir en ella, que es justo lo que no se ve desde el host.
    """
    from routes.salud import salud_bp

    client, _, _ = cliente_autenticado(salud_bp)
    almacenamiento = client.get("/api/health").get_json()["almacenamiento"]

    assert set(almacenamiento) >= {"datos", "portfolios", "json", "backups", "claves"}
    assert almacenamiento["datos"]["ruta"] == str(datos_aislados["data"])
    assert almacenamiento["datos"]["escribible"] is True


def test_el_estado_de_los_directorios_no_sale_sin_sesion(cliente_salud):
    assert "almacenamiento" not in cliente_salud.get("/api/health").get_json()
