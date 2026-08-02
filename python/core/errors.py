"""Errores de aplicación y manejadores globales de Flask.

Antes de este módulo, un fallo no previsto en cualquier ruta salía como la
página HTML de error de Werkzeug (o como una traza completa con debug=True).
El frontend hace `response.json()` sobre casi todas las respuestas, así que ese
HTML se convertía en un `SyntaxError: Unexpected token '<'` en consola y el
usuario no veía nada. Aquí se garantiza que todo lo que cuelgue de /api/
responda siempre JSON con la forma {"ok": false, "error": ...}.
"""

import logging
import uuid

from flask import current_app, g, jsonify, request
from werkzeug.exceptions import HTTPException

log = logging.getLogger(__name__)

_REQUEST_ID_HEADER = "X-Request-Id"

# Mensajes genéricos por código: nunca se filtra al cliente el detalle interno
# de un fallo inesperado (rutas del sistema, SQL, nombres de tablas…). El
# detalle real va al log junto al request id, que sí se devuelve para poder
# correlacionar lo que ve el usuario con la línea del log.
_GENERIC_MESSAGES = {
    400: "Petición inválida",
    401: "Sesión no iniciada",
    403: "Petición rechazada",
    404: "Recurso no encontrado",
    405: "Método no permitido",
    409: "Conflicto con el estado actual",
    413: "El contenido enviado es demasiado grande",
    415: "Formato de contenido no soportado",
    429: "Demasiadas peticiones",
    500: "Error interno del servidor",
    502: "El proveedor externo no respondió correctamente",
    503: "Servicio no disponible",
}


class ApiError(Exception):
    """Error de negocio que se traduce a una respuesta JSON conocida.

    Se lanza desde stores y rutas en lugar de devolver tuplas
    `(jsonify(...), status)` por todo el árbol de llamadas: así una validación
    profunda puede abortar sin que cada capa intermedia tenga que propagar el
    error a mano.
    """

    status_code = 400

    def __init__(self, message, status_code=None, *, field=None, details=None):
        super().__init__(message)
        self.message = str(message)
        if status_code is not None:
            self.status_code = int(status_code)
        self.field = field
        self.details = details

    def to_dict(self) -> dict:
        payload = {"ok": False, "error": self.message}
        if self.field:
            payload["field"] = self.field
        if self.details:
            payload["details"] = self.details
        return payload


class ValidationError(ApiError):
    status_code = 400


class NotFoundError(ApiError):
    status_code = 404


class ConflictError(ApiError):
    status_code = 409


class UpstreamError(ApiError):
    """Fallo de un proveedor externo (Finnhub, EODHD, Yahoo, Alpha Vantage)."""

    status_code = 502


def wants_json() -> bool:
    """True si la respuesta de error debe ser JSON en vez de HTML."""
    if request.path.startswith("/api/"):
        return True
    if request.is_json:
        return True
    accept = request.accept_mimetypes
    return accept.accept_json and not accept.accept_html


def current_request_id() -> str:
    request_id = getattr(g, "request_id", None)
    if not request_id:
        request_id = uuid.uuid4().hex[:12]
        g.request_id = request_id
    return request_id


def register_error_handlers(app) -> None:
    """Instala el request id y los manejadores globales de error."""

    @app.before_request
    def _assign_request_id():
        # Se respeta el id que venga de un proxy inverso para poder seguir una
        # petición a través de varias capas.
        incoming = request.headers.get(_REQUEST_ID_HEADER, "").strip()
        g.request_id = incoming[:64] if incoming else uuid.uuid4().hex[:12]

    @app.after_request
    def _expose_request_id(response):
        request_id = getattr(g, "request_id", None)
        if request_id:
            response.headers[_REQUEST_ID_HEADER] = request_id
        return response

    @app.errorhandler(ApiError)
    def _handle_api_error(error: ApiError):
        # Errores de negocio esperados: nivel info/warning, sin traza.
        log.warning(
            "[%s] %s %s -> %s: %s",
            current_request_id(), request.method, request.path,
            error.status_code, error.message,
        )
        payload = error.to_dict()
        payload["requestId"] = current_request_id()
        return jsonify(payload), error.status_code

    @app.errorhandler(HTTPException)
    def _handle_http_exception(error: HTTPException):
        if not wants_json():
            return error
        status = error.code or 500
        message = _GENERIC_MESSAGES.get(status) or error.name or "Error"
        if status >= 500:
            log.error(
                "[%s] %s %s -> %s: %s",
                current_request_id(), request.method, request.path, status, error,
            )
        return jsonify({
            "ok": False,
            "error": message,
            "requestId": current_request_id(),
        }), status

    @app.errorhandler(Exception)
    def _handle_unexpected(error: Exception):
        # exc_info=True: la traza completa va al log, nunca a la respuesta.
        log.exception(
            "[%s] Error no controlado en %s %s",
            current_request_id(), request.method, request.path,
        )
        # Con debug activo interesa la traza del depurador de Werkzeug en el
        # navegador, así que se deja propagar.
        if current_app.debug:
            raise error
        if not wants_json():
            return "Error interno del servidor", 500
        return jsonify({
            "ok": False,
            "error": _GENERIC_MESSAGES[500],
            "requestId": current_request_id(),
        }), 500
