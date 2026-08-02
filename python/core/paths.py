"""Rutas del proyecto, en un único sitio.

Cada módulo calculaba la raíz por su cuenta con `Path(__file__).parent.parent`,
y el número de `.parent` dependía de a qué profundidad estuviera el fichero. Al
reorganizar `python/` en paquetes, todas esas cuentas se rompieron a la vez.

Definirlas aquí desacopla las rutas de la posición del fichero que las usa: si
un módulo cambia de carpeta, no hay nada que ajustar.
"""

from pathlib import Path

# python/core/paths.py → python/core → python → raíz del proyecto
BASE_DIR = Path(__file__).resolve().parent.parent.parent

DATA_DIR = BASE_DIR / "data"
LOGS_DIR = BASE_DIR / "logs"
API_DIR = BASE_DIR / "API"
HTML_DIR = BASE_DIR / "html"
BACKUPS_DIR = DATA_DIR / "backups"
PORTFOLIOS_DIR = DATA_DIR / "portfolios"

__all__ = [
    "API_DIR",
    "BACKUPS_DIR",
    "BASE_DIR",
    "DATA_DIR",
    "HTML_DIR",
    "LOGS_DIR",
    "PORTFOLIOS_DIR",
]
