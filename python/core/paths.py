"""Rutas del proyecto, en un único sitio.

Cada módulo calculaba la raíz por su cuenta con `Path(__file__).parent.parent`,
y el número de `.parent` dependía de a qué profundidad estuviera el fichero. Al
reorganizar `python/` en paquetes, todas esas cuentas se rompieron a la vez.

Definirlas aquí desacopla las rutas de la posición del fichero que las usa: si
un módulo cambia de carpeta, no hay nada que ajustar. Y como los ficheros
concretos (auth.dat, portfolios.json…) también salen de aquí, renombrar uno es
un cambio de una línea en vez de una búsqueda por todo el código.

Los tres directorios de datos son configurables desde la sección [rutas] de
config.ini, o por entorno. Esto es lo que permite montar `data/` en un disco
distinto al del código —un volumen persistente, un NAS— sin parchear nada:

    [rutas]
    datos = /srv/portfolio/data

Las rutas relativas se resuelven desde la raíz del proyecto; las absolutas se
usan tal cual.
"""

import os
from pathlib import Path

from core.config_ini import obtenerTexto

# python/core/paths.py → python/core → python → raíz del proyecto.
# PORTFOLIO_BASE_DIR existe para escenarios donde el código está en otro sitio
# (por ejemplo instalado como paquete); en el uso normal no hace falta tocarlo.
_RAIZ_POR_DEFECTO = Path(__file__).resolve().parents[2]
_baseIndicada = os.environ.get("PORTFOLIO_BASE_DIR", "").strip()
BASE_DIR = Path(_baseIndicada).expanduser().resolve() if _baseIndicada else _RAIZ_POR_DEFECTO


def _directorio(opcion, defecto, env):
    """Directorio de [rutas], relativo a BASE_DIR salvo que sea absoluto."""
    valor = obtenerTexto("rutas", opcion, defecto, env=env)
    ruta = Path(valor).expanduser()
    return ruta if ruta.is_absolute() else BASE_DIR / ruta


# ── Directorios ───────────────────────────────────────────────────────────────
# Se resuelven una vez al importar, no en cada acceso: media docena de módulos
# hacen `from core.paths import DATA_DIR` y esperan una ruta estable. Mover los
# datos con el servidor arrancado no es un caso de uso; requiere reiniciar.
DATA_DIR = _directorio("datos", "data", "PORTFOLIO_DATA_DIR")
LOGS_DIR = _directorio("logs", "logs", "PORTFOLIO_LOGS_DIR")
API_DIR = _directorio("claves", "API", "PORTFOLIO_API_DIR")

HTML_DIR = BASE_DIR / "html"

BACKUPS_DIR = DATA_DIR / "backups"
AUTO_BACKUPS_DIR = BACKUPS_DIR / "auto"
PORTFOLIOS_DIR = DATA_DIR / "portfolios"
DELETED_DIR = DATA_DIR / "deleted"
JSON_DIR = DATA_DIR / "JSON"

# ── Ficheros ──────────────────────────────────────────────────────────────────
ENV_FILE = BASE_DIR / ".env"
INDEX_FILE = BASE_DIR / "index.html"
LOGIN_HTML = HTML_DIR / "sesion" / "login.html"

AUTH_FILE = DATA_DIR / "auth.dat"
PORTFOLIOS_META_FILE = DATA_DIR / "portfolios.json"
AJUSTES_JSON = JSON_DIR / "ajustes.json"

# BD anterior a la migración multi-portfolio. Se conserva congelada: sirve de
# origen para la migración, nunca como base de datos activa.
LEGACY_DB = DATA_DIR / "portfolio.db"


def rutaDesdeBase(relativa):
    """Resuelve una ruta relativa del config contra la raíz del proyecto."""
    ruta = Path(str(relativa)).expanduser()
    return ruta if ruta.is_absolute() else BASE_DIR / ruta


__all__ = [
    "AJUSTES_JSON",
    "API_DIR",
    "AUTH_FILE",
    "AUTO_BACKUPS_DIR",
    "BACKUPS_DIR",
    "BASE_DIR",
    "DATA_DIR",
    "DELETED_DIR",
    "ENV_FILE",
    "HTML_DIR",
    "INDEX_FILE",
    "JSON_DIR",
    "LEGACY_DB",
    "LOGIN_HTML",
    "LOGS_DIR",
    "PORTFOLIOS_DIR",
    "PORTFOLIOS_META_FILE",
    "rutaDesdeBase",
]
