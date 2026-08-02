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
