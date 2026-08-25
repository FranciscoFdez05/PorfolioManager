"""Fixtures compartidas.

Regla importante: **ningún test toca `data/` del repositorio**. Los tests que
necesitan base de datos apuntan `db` a un fichero temporal con
`set_active_db_path()`, y ninguno importa `server`, porque ese módulo ejecuta
`init_portfolios()` / `ensureDataFile()` al importarse y escribiría sobre los
datos reales del usuario que ejecuta la suite en su máquina.
"""

import sys
from pathlib import Path

import pytest

# El código se importa de forma plana desde python/ (igual que en gunicorn).
# pyproject ya lo configura vía `pythonpath`, pero repetirlo aquí permite
# lanzar `pytest tests/…` desde cualquier directorio.
_PYTHON_DIR = Path(__file__).resolve().parent.parent / "python"
if str(_PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(_PYTHON_DIR))


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    """Base de datos SQLite vacía y aislada para el test."""
    from core import db

    original_path = db.get_active_db_path()
    db_path = tmp_path / "test_portfolio.db"
    db.set_active_db_path(db_path)
    # Crea el esquema y deja la conexión del hilo lista.
    db.init_db()

    yield db_path

    db.reset_db()
    db.set_active_db_path(original_path)
    db.invalidate_all_connections()


@pytest.fixture
def datos_aislados(tmp_path, monkeypatch):
    """Redirige a tmp_path todos los directorios de datos que tocan las rutas.

    `core.paths` resuelve sus constantes al importarse y los módulos las copian
    con `from … import BACKUPS_DIR as _BACKUP_DIR`, así que reasignar
    `core.paths.DATA_DIR` no alcanzaría a nadie: hay que parchear el nombre en
    cada módulo que ya se lo llevó. Por eso la lista es explícita y no un bucle
    sobre `core.paths`; si mañana otro módulo importa uno de estos, el test que
    lo cubra fallará escribiendo en `data/` y el fallo se verá.
    """
    from admin import portfolios_manager
    from core import paths
    from routes import ajustes as rutas_ajustes, backup as rutas_backup

    data = tmp_path / "data"
    backups = data / "backups"
    portfolios = data / "portfolios"
    json_dir = data / "JSON"
    for carpeta in (data, backups, portfolios, json_dir):
        carpeta.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(paths, "DATA_DIR", data, raising=False)
    monkeypatch.setattr(paths, "BACKUPS_DIR", backups, raising=False)
    monkeypatch.setattr(paths, "PORTFOLIOS_DIR", portfolios, raising=False)
    monkeypatch.setattr(paths, "JSON_DIR", json_dir, raising=False)
    monkeypatch.setattr(paths, "AJUSTES_JSON", json_dir / "ajustes.json", raising=False)
    monkeypatch.setattr(paths, "PORTFOLIOS_META_FILE", data / "portfolios.json", raising=False)
    monkeypatch.setattr(paths, "AUTH_FILE", data / "auth.dat", raising=False)

    monkeypatch.setattr(rutas_backup, "DATA_DIR", data)
    monkeypatch.setattr(rutas_backup, "_BACKUP_DIR", backups)
    monkeypatch.setattr(rutas_backup, "_PORTFOLIOS_DIR", portfolios)
    monkeypatch.setattr(rutas_backup, "_JSON_DIR", json_dir)
    monkeypatch.setattr(rutas_backup, "_AJUSTES_SRC", json_dir / "ajustes.json")
    monkeypatch.setattr(rutas_backup, "_META_FILE", data / "portfolios.json")
    monkeypatch.setattr(rutas_ajustes, "_AJUSTES_JSON", json_dir / "ajustes.json")
    monkeypatch.setattr(rutas_ajustes, "JSON_DIR", json_dir)
    # Las claves de API se guardan cifradas en API/*.key; sin aislarlas, un test
    # de /api/settings sobrescribiría las del usuario.
    claves = tmp_path / "API"
    claves.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(paths, "API_DIR", claves, raising=False)
    monkeypatch.setattr(rutas_ajustes, "_API_DIR", claves)

    # /api/restore llama a init_portfolios() al terminar, que reactiva el
    # portfolio guardado en el backup. Sin parchear también estos nombres, ese
    # paso final leería y escribiría el portfolios.json real.
    monkeypatch.setattr(portfolios_manager, "_PORTFOLIOS_DIR", portfolios)
    monkeypatch.setattr(portfolios_manager, "_META_FILE", data / "portfolios.json")
    monkeypatch.setattr(portfolios_manager, "_DELETED_DIR", data / "deleted")
    monkeypatch.setattr(portfolios_manager, "_LEGACY_DB", data / "portfolio.db")

    return {
        "data": data,
        "backups": backups,
        "portfolios": portfolios,
        "json": json_dir,
        "ajustes": json_dir / "ajustes.json",
        "meta": data / "portfolios.json",
        "auth": data / "auth.dat",
        "claves": claves,
    }


@pytest.fixture
def crear_app(monkeypatch):
    """Fábrica de apps Flask con la capa de seguridad real instalada.

    Monta los mismos `before_request`/`after_request` que `server.py` —CSRF,
    tope de cuerpo, límite de escrituras, sesión y cabeceras— sobre una app
    mínima con los blueprints que pida cada test. Importar `server` no es una
    opción (ver la nota de arriba), y sin esto la capa que decide qué peticiones
    entran no la comprobaba nadie.
    """
    # Fija para que la sesión firmada sobreviva entre peticiones del mismo test
    # y para que el Fernet de auth.py sea determinista.
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")

    def _crear(*blueprints, **config):
        from flask import Flask

        from core import seguridad_app
        from core.errors import register_error_handlers

        app = Flask(__name__, static_folder=None)
        app.secret_key = "clave-de-pruebas-0123456789abcdef0123456789abcdef"
        app.config["TESTING"] = True
        seguridad_app.aplicar_configuracion_sesion(app)
        app.config.update(config)

        register_error_handlers(app)
        for blueprint in blueprints:
            app.register_blueprint(blueprint)

        limites = seguridad_app.instalar(app)
        app.extensions["limites_prueba"] = limites
        return app

    return _crear


# Token CSRF de los tests. Fijo y no aleatorio para que, cuando un caso falle
# con 403, se vea en el diff si el problema es el token o la sesión.
CSRF_PRUEBA = "token-csrf-de-pruebas"


@pytest.fixture
def cliente_autenticado(crear_app):
    """Devuelve `(client, cabeceras, app)` con sesión abierta y token CSRF válido.

    La sesión se escribe directamente con `session_transaction()` en vez de
    pasar por /login: eso exigiría credenciales reales en disco y convertiría
    cada test de rutas en un test de autenticación. Las cabeceras ya llevan el
    X-CSRF-Token, porque si no todos los POST recibirían 403 y estarían
    comprobando el CSRF una y otra vez en vez de lo que pretenden.
    """
    def _abrir(*blueprints, **config):
        app = crear_app(*blueprints, **config)
        client = app.test_client()
        with client.session_transaction() as sesion:
            sesion["logged_in"] = True
            sesion["csrf_token"] = CSRF_PRUEBA
        return client, {"X-CSRF-Token": CSRF_PRUEBA}, app

    return _abrir


@pytest.fixture
def error_app():
    """App Flask mínima con la capa de errores instalada.

    Se construye a mano en vez de importar `server` para que estos tests
    verifiquen exclusivamente `errors.register_error_handlers` sin arrastrar la
    inicialización completa de la aplicación.
    """
    from flask import Flask

    from core.errors import register_error_handlers

    app = Flask(__name__)
    app.config["TESTING"] = True
    register_error_handlers(app)
    return app
