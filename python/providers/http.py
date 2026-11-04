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
from urllib.parse import urlencode, urlsplit
from urllib.request import Request

from core import settings
from providers.api_stats import recordApiCall, recordApiResult
from providers.conexion import abrir as urlopen
from providers.conexion import servidorCaido

log = logging.getLogger(__name__)

# Los parámetros de red (timeout, reintentos, backoff, tope de respuesta,
# User-Agent) salen de la sección [proveedores] de config.ini. Ajustar la
# paciencia con un proveedor lento no debería exigir tocar este fichero ni
# reconstruir la imagen.

_RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}


def motivoConexion(error, proveedor="") -> str:
    """El motivo de un fallo de conexión, dicho en corto y sin datos internos.

    `error.reason` es el texto del sistema operativo («[WinError 10061] No se
    puede establecer una conexión…», direcciones de proxy, rutas de
    certificados) y llegaba tal cual al navegador dentro del mensaje de error.
    Al usuario le sirve la categoría; el detalle completo va al log.
    """
    razon = getattr(error, "reason", error)
    texto = str(razon).lower()
    log.warning("Fallo de conexión%s: %s", f" con {proveedor}" if proveedor else "", razon)
    if isinstance(razon, TimeoutError) or "timed out" in texto or "tiempo de espera" in texto:
        return "tiempo de espera agotado"
    if "refused" in texto or "10061" in texto or "denegó" in texto:
        return "conexión rechazada"
    if "getaddrinfo" in texto or "name or service" in texto or "11001" in texto or "nodename" in texto:
        return "no se encuentra el servidor (DNS)"
    if "certificate" in texto or "ssl" in texto:
        return "error de certificado TLS"
    if "unreachable" in texto or "inalcanzable" in texto:
        return "red inalcanzable"
    return "error de red"


def _headersBase():
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


def _sleepFor(attempt: int, retryAfter: float | None) -> float:
    if retryAfter is not None:
        # Tope al Retry-After: los proveedores gratuitos llegan a pedir 60 s y
        # el usuario está esperando delante de la pantalla.
        return min(retryAfter, settings.proveedorMaxRetryAfter())
    # Backoff exponencial con jitter: evita que los refrescos de varios activos
    # reintenten todos en el mismo instante y vuelvan a saturar al proveedor.
    base = min(settings.proveedorBackoffInicial() * (2 ** attempt), settings.proveedorBackoffMaximo())
    return base * (0.5 + random.random() / 2)


def _parseRetryAfter(error: HTTPError):
    raw = error.headers.get("Retry-After") if error.headers else None
    if not raw:
        return None
    try:
        return max(0.0, float(str(raw).strip()))
    except (TypeError, ValueError):
        # También admite fecha HTTP; no merece la pena parsearla, se usa backoff.
        return None


def _readJson(response, url: str):
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
        # Solo el servidor: hay proveedores (NodeReal) con la clave en la ruta.
        log.warning("Respuesta no-JSON de %s: %s", urlsplit(url).netloc, exc)
        raise ProviderResponseError("El proveedor devolvió una respuesta no válida") from exc


def _servidorDeUrlCaido(url: str) -> bool:
    """Si no conectó ninguna IP del servidor de `url` (ver `providers.conexion`)."""
    partes = urlsplit(url)
    if not partes.hostname:
        return False
    try:
        puerto = partes.port or (443 if partes.scheme == "https" else 80)
    except ValueError:
        return False
    return servidorCaido(partes.hostname, puerto)


def buildUrl(url: str, params=None) -> str:
    query = urlencode(params or {})
    return f"{url}?{query}" if query else url


# Errores que son culpa de lo pedido (un símbolo que no existe), no del proveedor:
# no cambian su estado en Ajustes.
_CODIGOS_DE_PETICION = (400, 404, 422)


def estadoPorCodigo(codigo: int) -> str:
    """Estado de un proveedor según el código HTTP con que falló.

    Example:
        >>> estadoPorCodigo(429)
        'limite'
    """
    if codigo == 401:
        return "clave"
    if codigo == 403:
        return "plan"
    if codigo in (402, 429):
        return "limite"
    if codigo >= 500:
        return "caido"
    return "error"


def _anotarFallo(nombre: str, error: Exception, ms: int) -> None:
    """Guarda el estado que deja un fallo real, salvo si es culpa de la petición."""
    if isinstance(error, HTTPError):
        if error.code in _CODIGOS_DE_PETICION:
            return
        recordApiResult(nombre, estadoPorCodigo(error.code), f"HTTP {error.code}", ms)
    elif isinstance(error, (TimeoutError, URLError, OSError)):
        recordApiResult(nombre, "caido", str(getattr(error, "reason", error)), ms)
    else:
        recordApiResult(nombre, "error", str(error), ms)


def fetchJson(url, params=None, *, timeout=None, provider=None, headers=None,
               retries=None, jsonBody=None, estadoDe=None):
    """GET (o POST con `jsonBody`) + parseo JSON con reintentos.

    `provider` es la etiqueta con la que se contabiliza la llamada en las
    estadísticas de uso de API (pantalla de Ajustes). Se registra una vez por
    intento porque cada intento consume cuota real.

    `timeout` y `retries` a None (lo habitual) usan los valores de
    [proveedores] en config.ini; pasarlos explícitamente es para el caso puntual
    de una llamada que sabe que necesita otra cosa.

    `jsonBody`, si se da, convierte la petición en POST con ese cuerpo
    serializado a JSON (lo pide el scanner de TradingView; el resto de
    proveedores solo usan `params` en la query string).

    `estadoDe` es el proveedor cuyo estado (Ajustes › API) refleja la llamada;
    por defecto, `provider`. Existe para Yahoo, que cuenta sus llamadas por su
    cuenta y no pasa `provider`.
    """
    nombreEstado = estadoDe or provider
    inicio = time.monotonic()
    requestUrl = buildUrl(url, params)
    requestHeaders = _headersBase()
    if headers:
        requestHeaders.update(headers)

    requestData = None
    if jsonBody is not None:
        requestData = json.dumps(jsonBody).encode("utf-8")
        requestHeaders["Content-Type"] = "application/json"

    if timeout is None:
        timeout = settings.proveedorTimeout()
    if retries is None:
        retries = settings.proveedorReintentos()

    attempts = max(1, int(retries) + 1)
    lastError = None

    for attempt in range(attempts):
        if provider:
            recordApiCall(provider)
        try:
            request = Request(requestUrl, data=requestData, headers=requestHeaders)
            with urlopen(request, timeout=timeout) as response:
                datos = _readJson(response, url)
            if nombreEstado:
                recordApiResult(nombreEstado, "ok", "", round((time.monotonic() - inicio) * 1000))
            return datos
        except HTTPError as error:
            lastError = error
            retryable = error.code in _RETRYABLE_STATUS
            delay = _sleepFor(attempt, _parseRetryAfter(error)) if retryable else 0
        except (TimeoutError, ProviderResponseError, URLError, OSError) as error:
            # OSError cubre ConnectionResetError y similares, que urllib deja
            # pasar sin envolver en URLError.
            lastError = error
            # Si no conectó ninguna de sus IPs, reintentar al segundo no lo
            # arregla y alarga la espera; un timeout de lectura sí se reintenta.
            retryable = not _servidorDeUrlCaido(requestUrl)
            delay = _sleepFor(attempt, None)

        if not retryable or attempt == attempts - 1:
            break
        log.info(
            "Reintento %s/%s de %s tras %s (espera %.2fs)",
            attempt + 1, attempts - 1, provider or urlsplit(url).netloc, lastError, delay,
        )
        time.sleep(delay)

    if nombreEstado and lastError is not None:
        _anotarFallo(nombreEstado, lastError, round((time.monotonic() - inicio) * 1000))

    if isinstance(lastError, (HTTPError, URLError, TimeoutError)):
        raise lastError
    raise ProviderError(str(lastError) if lastError else "Fallo desconocido")
