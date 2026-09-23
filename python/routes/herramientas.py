"""Herramientas de la página Herramientas añadidas por el usuario.

El navegador no puede listar una carpeta: puede pedir un fichero concreto, pero
no preguntar qué hay dentro de `html/analisis/herramientas-extra/`. Por eso
existe este endpoint. Sin él, añadir una calculadora propia obligaría a editar
el HTML y el JS de la aplicación, y esos cambios se perderían en la siguiente
actualización.

El contrato es a propósito el mínimo: **un fichero `.html` es una herramienta**.
El nombre del fichero es su identificador, la cabecera de metadatos (un
comentario HTML al principio) da el título y la descripción, y si existe un
`.js` con el mismo nombre se carga junto a él. Nada que registrar en ningún
sitio: se deja el fichero y aparece.

Lo que aquí se publica son rutas relativas, no el contenido. El HTML y el JS los
pide después el navegador por la vía estática de siempre (`serveStatic`), que ya
tiene su lista de extensiones permitidas y sus prefijos bloqueados.

**Qué se valida y qué no.** Se valida el nombre del fichero (para que no pueda
salirse de la carpeta ni colarse en un id de HTML) y se recortan los metadatos.
El contenido del HTML y del JS no se toca: son ficheros que el dueño del
servidor ha dejado ahí a mano, con el mismo acceso que tiene al resto del código.
Filtrarlos daría una falsa sensación de aislamiento —se ejecutan en la misma
página que el resto de la aplicación— sin impedir nada que ese usuario no pueda
hacer ya editando el código directamente.
"""

import logging
import re
from datetime import date

from flask import Blueprint, jsonify, request

from core.paths import BASE_DIR
from stores import ventas_fifo

log = logging.getLogger(__name__)

herramientas_bp = Blueprint("herramientas", __name__)

# Carpeta que mira este endpoint. Va dentro de html/ y no en data/ porque el
# navegador tiene que poder descargar los ficheros, y data/ está bloqueado.
EXTRAS_DIR = BASE_DIR / "html" / "analisis" / "herramientas-extra"

# Ruta pública de esa misma carpeta.
_URL_BASE = "html/analisis/herramientas-extra"

# El nombre del fichero acaba siendo un id de HTML y un trozo de URL, así que se
# limita a lo que no hay que escapar en ninguno de los dos sitios.
_ID_VALIDO = re.compile(r"^[a-z0-9][a-z0-9_-]{0,48}$")

# Cabecera de metadatos: el primer comentario del fichero, si empieza por
# "herramienta". El resto del fichero no se lee.
_CABECERA = re.compile(r"<!--\s*herramienta\s*(.*?)-->", re.DOTALL | re.IGNORECASE)

_CLAVES = ("titulo", "descripcion", "disposicion")

# Tope de herramientas y de cabecera leída. No es una medida de seguridad —quien
# deja ficheros ahí ya tiene acceso al servidor—, es para que un fichero enorme
# o una carpeta con basura no conviertan una petición barata en una cara.
_MAX_HERRAMIENTAS = 50
_MAX_CABECERA_BYTES = 4096


def _metadatos(cabecera):
    """Pares `clave: valor` de la cabecera, solo los conocidos."""
    datos = {}
    for linea in cabecera.splitlines():
        if ":" not in linea:
            continue
        clave, _, valor = linea.partition(":")
        clave = clave.strip().lower()
        if clave in _CLAVES:
            datos[clave] = valor.strip()[:300]
    return datos


def _leerCabecera(ruta):
    """Metadatos declarados al principio del fichero, o {} si no los hay."""
    try:
        with ruta.open("r", encoding="utf-8", errors="replace") as fichero:
            inicio = fichero.read(_MAX_CABECERA_BYTES)
    except OSError as error:
        log.warning("[herramientas] No se pudo leer %s: %s", ruta.name, error)
        return {}

    encontrada = _CABECERA.search(inicio)
    return _metadatos(encontrada.group(1)) if encontrada else {}


def listar(directorio=None):
    """Herramientas encontradas en la carpeta, ya ordenadas.

    Recibe el directorio para poder probarla sin tocar el del repositorio.
    """
    carpeta = directorio if directorio is not None else EXTRAS_DIR
    if not carpeta.is_dir():
        return []

    herramientas = []
    for ruta in sorted(carpeta.glob("*.html")):
        identificador = ruta.stem.lower()
        if not _ID_VALIDO.match(identificador):
            log.warning(
                "[herramientas] %s se ignora: el nombre debe ser minúsculas, "
                "números, guiones o guiones bajos.", ruta.name,
            )
            continue

        datos = _leerCabecera(ruta)
        js = ruta.with_suffix(".js")

        herramientas.append({
            "id": identificador,
            # Sin título declarado, el nombre del fichero ya dice algo:
            # "precio-objetivo" → "Precio objetivo".
            "titulo": datos.get("titulo") or identificador.replace("-", " ").replace("_", " ").capitalize(),
            "descripcion": datos.get("descripcion", ""),
            "disposicion": datos.get("disposicion", ""),
            "html": f"{_URL_BASE}/{ruta.name}",
            "js": f"{_URL_BASE}/{js.name}" if js.is_file() else None,
        })

        if len(herramientas) >= _MAX_HERRAMIENTAS:
            log.warning("[herramientas] Se listan solo las primeras %d.", _MAX_HERRAMIENTAS)
            break

    herramientas.sort(key=lambda h: h["titulo"].lower())
    return herramientas


@herramientas_bp.route("/api/herramientas-extra", methods=["GET"])
def getHerramientasExtra():
    return jsonify({"ok": True, "herramientas": listar()})


# ── Simulador de venta ───────────────────────────────────────────────────────
# GET y no POST porque no cambia nada: es una consulta con parámetros. De paso
# se ahorra el token CSRF, que aquí solo sería ceremonia.
#
# El cálculo entero vive en stores/ventas_fifo.py, el mismo módulo que liquida
# las ventas de verdad. Esta ruta solo traduce parámetros y errores.


@herramientas_bp.route("/api/herramientas/simular-venta", methods=["GET"])
def getSimulacionVenta():
    activo = (request.args.get("activo") or "").strip()
    if not activo:
        return jsonify({"ok": False, "error": "Falta el activo"}), 400

    fecha = (request.args.get("fecha") or "").strip() or date.today().strftime("%d-%m-%Y")

    dato, incidencia = ventas_fifo.simular_venta(
        activo,
        fecha,
        request.args.get("cantidad", ""),
        request.args.get("precio", ""),
        request.args.get("comision", "0"),
    )

    if incidencia:
        return jsonify({
            "ok": False,
            "codigo": incidencia,
            "error": ventas_fifo.mensaje_incidencia(incidencia),
        }), 400

    return jsonify({"ok": True, "simulacion": dato})
