"""Índice Fear & Greed de cripto (alternative.me), sin clave.

Mezcla volatilidad, volumen, dominancia de BTC, redes sociales y tendencias de
búsqueda en un único número de 0 (miedo extremo) a 100 (codicia extrema). No
se recalcula nada aquí: se enseña tal cual lo publica la fuente, que es la
única referencia de "sentimiento" ya calculada y gratuita que hay sin clave.
"""

from urllib.error import HTTPError, URLError

from providers import fetch_json
from providers.http import motivo_conexion

FEAR_GREED_URL = "https://api.alternative.me/fng/"


def _fila_a_punto(fila):
    try:
        valor = int(fila["value"])
    except (KeyError, TypeError, ValueError):
        return None
    return {
        "valor": valor,
        "clasificacion": fila.get("value_classification", ""),
        "timestamp": fila.get("timestamp"),
    }


def fetch_history(days=30, timeout=None):
    """Los últimos `days` valores del índice, el más reciente primero (tal
    cual los devuelve la fuente). `(lista, None)` o `([], error)`.
    """
    try:
        payload = fetch_json(FEAR_GREED_URL, {"limit": days, "format": "json"}, timeout=timeout, provider="FearGreed")
    except HTTPError as error:
        return [], f"Fear & Greed devolvió HTTP {error.code}"
    except URLError as error:
        return [], f"No se pudo conectar con Fear & Greed: {motivo_conexion(error, 'Fear & Greed')}"

    filas = payload.get("data") or []
    serie = [punto for fila in filas if (punto := _fila_a_punto(fila)) is not None]
    return serie, None


def fetch_index(timeout=None):
    """`({"valor", "clasificacion", "timestamp"}, None)` o `(None, error)`.

    Es `fetch_history(days=1)` quedándose con el único punto: mismo dato, sin
    duplicar la llamada ni el parseo.
    """
    serie, error = fetch_history(days=1, timeout=timeout)
    if error:
        return None, error
    if not serie:
        return None, "Fear & Greed no devolvió datos"
    return serie[0], None
