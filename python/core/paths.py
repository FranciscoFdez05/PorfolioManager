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
# Temporales de las copias de bases de datos. Tienen carpeta propia y no viven
# en portfolios/: allí, un `_tmp_bak_x.db` a medio escribir lo veía cualquier
# `glob("*.db")` —la rotación de backups, el scheduler de snapshots, el listado
# de portfolios— como si fuera un portfolio más. Con un solo proceso (el
# servidor de desarrollo en Windows) la ventana era mínima; con los dos workers
# y cuatro hilos de gunicorn en Docker, deja de serlo.
TMP_DIR = DATA_DIR / "tmp"

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


# ── Diagnóstico de escritura ─────────────────────────────────────────────────
# Que una ruta exista no significa que se pueda escribir en ella, y esa es
# justo la diferencia entre ejecutar la aplicación en Windows (donde el proceso
# es el dueño de la carpeta del proyecto) y en Docker sobre Linux (donde
# data/, logs/ y API/ son volúmenes montados desde el host, con el propietario
# y los permisos que tenga el host, y el proceso corre como otro usuario).
#
# El síntoma era desconcertante: la aplicación arrancaba, la lista de backups
# se veía —leer solo necesita permiso de lectura— y cualquier intento de
# guardar fallaba, porque crear un fichero exige permiso de escritura sobre el
# **directorio**. Comprobarlo aquí, con el mismo Path que usa el resto del
# código, convierte ese fallo difuso en un mensaje que dice qué carpeta es y
# qué dice el sistema operativo.


def comprobarEscritura(directorio, crear=True):
    """(sePuedeEscribir, motivo) sobre `directorio`.

    Se comprueba creando y borrando un fichero de verdad, no con os.access():
    access() consulta los bits de permiso del proceso y devuelve respuestas
    equivocadas justo en los casos que aquí importan —montajes de solo
    lectura, ACL, root dentro del contenedor— que son los que hay que
    detectar.
    """
    ruta = Path(directorio)
    try:
        if crear:
            ruta.mkdir(parents=True, exist_ok=True)
        elif not ruta.is_dir():
            return False, "no existe"
    except OSError as error:
        return False, f"no se pudo crear: {error.strerror or error}"

    testigo = ruta / f".escritura_{os.getpid()}"
    try:
        with open(testigo, "wb") as handle:
            handle.write(b"ok")
        testigo.unlink()
        return True, ""
    except OSError as error:
        try:
            testigo.unlink()
        except OSError:
            pass
        return False, error.strerror or str(error)


def directoriosDeDatos():
    """Los directorios que la aplicación necesita poder escribir.

    Se leen de los globales en cada llamada (y no en una constante calculada al
    importar) para que los tests, que reasignan DATA_DIR y compañía, no acaben
    comprobando el `data/` real del usuario.
    """
    return {
        "datos": DATA_DIR,
        "portfolios": PORTFOLIOS_DIR,
        "json": JSON_DIR,
        "backups": BACKUPS_DIR,
        "logs": LOGS_DIR,
        "claves": API_DIR,
    }


def diagnosticoAlmacenamiento(crear=True):
    """Estado de cada directorio de datos: ruta resuelta y si se puede escribir.

    Lo usan el aviso de arranque y /api/health. Devuelve rutas absolutas: en
    Docker el 90 % de los "no me guarda" se resuelve viendo que la ruta que la
    aplicación resolvió no es la que el usuario creía tener montada.
    """
    informe = {}
    for nombre, ruta in directoriosDeDatos().items():
        escribible, motivo = comprobarEscritura(ruta, crear=crear)
        informe[nombre] = {
            "ruta": str(ruta),
            "escribible": escribible,
            "motivo": motivo,
        }
    return informe


def descripcionProceso():
    """Usuario y permisos con los que corre el proceso.

    En Windows no existen uid/gid; devolver el diccionario vacío evita tener
    que preguntarlo en cada sitio donde se imprime el diagnóstico.
    """
    if not hasattr(os, "geteuid"):
        return {}
    return {"uid": os.geteuid(), "gid": os.getegid()}


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
    "TMP_DIR",
    "comprobarEscritura",
    "descripcionProceso",
    "diagnosticoAlmacenamiento",
    "directoriosDeDatos",
    "rutaDesdeBase",
]
