"""Forma admitida de la configuración de Activos > Paneles.

La pantalla de paneles guarda en las preferencias del portfolio la lista de
paneles del usuario y, en cada uno, sus widgets con su tamaño y sus opciones.
Es un JSON que construye el navegador, así que aquí no se confía en nada:

* Solo pasan los tipos de widget que la pantalla sabe pintar. Uno desconocido
  (de una versión futura, o escrito a mano) se descarta en vez de dejar un
  hueco que la pantalla no sabría rellenar.
* Los tamaños se acotan a la rejilla de 12 columnas.
* Las opciones de cada widget (`cfg`) son planas: textos, números, booleanos y
  listas de textos. Un objeto anidado o un texto enorme no tiene uso legítimo
  y solo serviría para inflar `prefs_<id>.json`.
* Hay topes de paneles, widgets y longitudes por la misma razón.

La normalización se aplica al guardar y al leer, como el resto de ajustes: da
igual por dónde haya llegado el fichero (importación, copia, edición a mano).
"""

import math

TIPOS_WIDGET = frozenset({
    "mapa", "grafico", "cartera", "favoritos",
    "rendimiento", "distribucion", "resumen", "notas",
    # Mercado e información (los cuatro últimos son widgets de TradingView).
    "mapaMercado", "instrumento", "tecnico", "ficha", "perfil", "noticias", "calendario",
    # Sentimiento de mercado y los apartados de Métricas.
    "miedoCodicia", "amplitud", "indices", "sectores", "escaner", "metrica",
})

MAX_PANELES = 20
MAX_WIDGETS = 24
MAX_LISTA = 300
_MAX_ID = 40
_MAX_NOMBRE = 60
_MAX_CLAVE = 40
_MAX_TEXTO = 120
# Las notas son el único texto largo: el contenido de un widget de notas.
_MAX_NOTA = 5000

COLUMNAS = 12
MIN_ALTO, MAX_ALTO = 2, 16
MIN_ANCHO = 2


def _texto(valor, maximo):
    return valor[:maximo] if isinstance(valor, str) else ""


# Claves que en el navegador no son una opción más: «cfg.__proto__ = …»
# cambia el prototipo del objeto en vez de guardar un valor.
_CLAVES_PROHIBIDAS = frozenset({"__proto__", "constructor", "prototype"})


def _numero(valor) -> bool:
    """Un número de verdad: ni booleano, ni NaN, ni infinito.

    Flask acepta NaN e Infinity en el JSON que recibe, pero no son JSON: si se
    guardaran, /api/settings devolvería algo que el navegador no puede leer y
    la aplicación entera se quedaría sin ajustes.
    """
    if not isinstance(valor, (int, float)) or isinstance(valor, bool):
        return False
    try:
        return math.isfinite(valor)
    except OverflowError:
        # Un entero de cientos de dígitos no cabe en un float: no es un tamaño
        # ni una opción razonable, y math.isfinite lanza en vez de decir que no.
        return False


def _entero(valor, minimo, maximo, defecto):
    if not _numero(valor):
        return defecto
    return max(minimo, min(maximo, int(valor)))


def _opciones(cfg) -> dict:
    if not isinstance(cfg, dict):
        return {}
    limpio = {}
    for clave, valor in cfg.items():
        if not isinstance(clave, str) or not clave or len(clave) > _MAX_CLAVE or clave in _CLAVES_PROHIBIDAS:
            continue
        if isinstance(valor, bool) or _numero(valor):
            limpio[clave] = valor
        elif isinstance(valor, str):
            limpio[clave] = valor[: _MAX_NOTA if clave == "texto" else _MAX_TEXTO]
        elif isinstance(valor, list):
            limpio[clave] = [v[:_MAX_TEXTO] for v in valor if isinstance(v, str)][:MAX_LISTA]
    return limpio


def _widget(crudo):
    if not isinstance(crudo, dict) or crudo.get("tipo") not in TIPOS_WIDGET:
        return None
    ident = _texto(crudo.get("id"), _MAX_ID)
    if not ident:
        return None
    return {
        "id": ident,
        "tipo": crudo["tipo"],
        "w": _entero(crudo.get("w"), MIN_ANCHO, COLUMNAS, 6),
        "h": _entero(crudo.get("h"), MIN_ALTO, MAX_ALTO, 5),
        "cfg": _opciones(crudo.get("cfg")),
    }


def _panel(crudo):
    if not isinstance(crudo, dict):
        return None
    ident = _texto(crudo.get("id"), _MAX_ID)
    if not ident:
        return None
    widgets, vistos = [], set()
    for w in crudo.get("widgets") if isinstance(crudo.get("widgets"), list) else []:
        limpio = _widget(w)
        if limpio and limpio["id"] not in vistos:
            vistos.add(limpio["id"])
            widgets.append(limpio)
        if len(widgets) >= MAX_WIDGETS:
            break
    return {
        "id": ident,
        "nombre": _texto(crudo.get("nombre"), _MAX_NOMBRE).strip() or "Panel",
        # Opciones del panel entero (alto de fila, separación…): la misma
        # forma plana que las de un widget.
        "cfg": _opciones(crudo.get("cfg")),
        "widgets": widgets,
    }


def normalizarPaneles(valor) -> dict:
    """La configuración de paneles con la forma esperada; vacía si no la tiene."""
    if not isinstance(valor, dict):
        return {}
    paneles, vistos = [], set()
    for p in valor.get("paneles") if isinstance(valor.get("paneles"), list) else []:
        limpio = _panel(p)
        if limpio and limpio["id"] not in vistos:
            vistos.add(limpio["id"])
            paneles.append(limpio)
        if len(paneles) >= MAX_PANELES:
            break
    activo = _texto(valor.get("activo"), _MAX_ID)
    if activo not in vistos:
        activo = paneles[0]["id"] if paneles else ""
    return {"paneles": paneles, "activo": activo}
