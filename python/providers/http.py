"""Cliente HTTP común a los proveedores de datos de mercado.

Añade sobre el `urlopen` pelado que usaba cada cliente:

* **Reintentos con backoff exponencial + jitter** ante fallos transitorios
  (timeouts, cortes de red, 5xx y 429). Un pico de latencia de Finnhub dejaba
  antes el precio del activo sin actualizar hasta el siguiente refresco.
* **Tope de tamaño de respuesta**: `response.read()` sin límite carga en
  memoria lo que mande el servidor. Con varios activos refrescándose en
  paralelo, una respuesta anómala podía tumbar el proceso.
* **JSON malformado tratado como error de red**: antes subía un
  `JSONDecodeError` que ningún llamante capturaba (todos capturan
  `HTTPError`/`URLError`), y acababa en un 500.
* **Respeto de `Retry-After`** en los 429, acotado para no bloquear la petición
  del usuario indefinidamente.

Las excepciones que escapan siguen siendo `HTTPError`/`URLError`/`TimeoutError`
de urllib, que es lo que los clientes ya capturan.
"""

import json
import logging
import random
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from core import settings
from providers.api_stats import record_api_call

log = logging.getLogger(__name__)

# Los parámetros de red (timeout, reintentos, backoff, tope de respuesta,
# User-Agent) salen de la sección [proveedores] de config.ini. Ajustar la
# paciencia con un proveedor lento no debería exigir tocar este fichero ni
# reconstruir la imagen.

_RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}


def _headers_base():
    return {
        "User-Agent": settings.proveedorUserAgent(),
        "Accept": "application/json",
    }


class ProviderError(URLError):
    """Fallo de un proveedor que no es ni HTTP ni de conexión.

    Hereda de `URLError` a propósito: los clientes ya tienen ramas
    `except URLError` con el mensaje de "no se pudo conectar", así que estos
    casos se tratan igual sin tocar cada llamante.
    """

    def __init__(self, message):
        super().__init__(message)
        self.message = str(message)

    def __str__(self):
        return self.message


class ProviderResponseError(ProviderError):
    """El proveedor respondió algo que no es JSON válido o es demasiado grande."""


def _sleep_for(attempt: int, retry_after: float | None) -> float:
    if retry_after is not None:
        # Tope al Retry-After: los proveedores gratuitos llegan a pedir 60 s y
        # el usuario está esperando delante de la pantalla.
        return min(retry_after, settings.proveedorMaxRetryAfter())
    # Backoff exponencial con jitter: evita que los refrescos de varios activos
    # reintenten todos en el mismo instante y vuelvan a saturar al proveedor.
    base = min(settings.proveedorBackoffInicial() * (2 ** attempt), settings.proveedorBackoffMaximo())
    return base * (0.5 + random.random() / 2)


def _parse_retry_after(error: HTTPError):
    raw = error.headers.get("Retry-After") if error.headers else None
    if not raw:
        return None
    try:
        return max(0.0, float(str(raw).strip()))
    except (TypeError, ValueError):
        # También admite fecha HTTP; no merece la pena parsearla, se usa backoff.
        return None


def _read_json(response, url: str):
    # El mayor payload legítimo son los catálogos de símbolos de Finnhub (unos
    # 2 MB); el resto son cotizaciones de pocos KB. El tope protege la memoria
    # del proceso cuando varios activos se refrescan a la vez.
    maximo = settings.proveedorMaxRespuestaBytes()
    payload = response.read(maximo + 1)
    if len(payload) > maximo:
        raise ProviderResponseError(
            f"Respuesta demasiado grande (> {maximo // (1024 * 1024)} MB)"
        )
    if not payload:
        raise ProviderResponseError("El proveedor devolvió una respuesta vacía")
    try:
        return json.loads(payload.decode("utf-8", errors="replace"))
    except ValueError as exc:
        # Los proveedores devuelven HTML en mantenimientos y páginas de error.
        log.warning("Respuesta no-JSON de %s: %s", url, exc)
        raise ProviderResponseError("El proveedor devolvió una respuesta no válida") from exc


def build_url(url: str, params=None) -> str:
    query = urlencode(params or {})
    return f"{url}?{query}" if query else url


def fetch_json(url, params=None, *, timeout=None, provider=None, headers=None,
               retries=None):
    """GET + parseo JSON con reintentos.

    `provider` es la etiqueta con la que se contabiliza la llamada en las
    estadísticas de uso de API (pantalla de Ajustes). Se registra una vez por
    intento porque cada intento consume cuota real.

    `timeout` y `retries` a None (lo habitual) usan los valores de
    [proveedores] en config.ini; pasarlos explícitamente es para el caso puntual
    de una llamada que sabe que necesita otra cosa.
    """
    request_url = build_url(url, params)
    request_headers = _headers_base()
    if headers:
        request_headers.update(headers)

    if timeout is None:
        timeout = settings.proveedorTimeout()
    if retries is None:
        retries = settings.proveedorReintentos()

    attempts = max(1, int(retries) + 1)
    last_error = None

    for attempt in range(attempts):
        if provider:
            record_api_call(provider)
        try:
            request = Request(request_url, headers=request_headers)
            with urlopen(request, timeout=timeout) as response:
                return _read_json(response, url)
        except HTTPError as error:
            last_error = error
            retryable = error.code in _RETRYABLE_STATUS
            delay = _sleep_for(attempt, _parse_retry_after(error)) if retryable else 0
        except (TimeoutError, ProviderResponseError, URLError, OSError) as error:
            # OSError cubre ConnectionResetError y similares, que urllib deja
            # pasar sin envolver en URLError.
            last_error = error
            retryable = True
            delay = _sleep_for(attempt, None)

        if not retryable or attempt == attempts - 1:
            break
        log.info(
            "Reintento %s/%s de %s tras %s (espera %.2fs)",
            attempt + 1, attempts - 1, provider or url, last_error, delay,
        )
        time.sleep(delay)

    if isinstance(last_error, (HTTPError, URLError, TimeoutError)):
        raise last_error
    raise ProviderError(str(last_error) if last_error else "Fallo desconocido")
