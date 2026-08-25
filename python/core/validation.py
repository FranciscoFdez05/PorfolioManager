"""Validación y normalización de la entrada de las rutas.

Las rutas repetían por todas partes el mismo patrón defensivo
(`str(row.get("x", "")).strip()`, comprobar que `rows` es una lista, recortar
longitudes, normalizar opciones de un desplegable…). Centralizarlo evita que un
módulo se olvide de un caso: aquí cualquier entrada inesperada acaba en un
`ValidationError`, que la capa de errores traduce a un 400 con mensaje útil.

Todas las funciones son puras y no dependen de Flask salvo `json_body`, para
poder testearlas sin contexto de petición.
"""

from core import dinero
from core.errors import ValidationError

# Tope por defecto para cualquier cadena que venga del cliente. Los campos de
# la app son etiquetas, importes y notas cortas; sin límite, un POST podía
# escribir megabytes en una celda de la BD.
DEFAULT_MAX_LENGTH = 512
MAX_ROWS = 10_000


def json_body(required=True) -> dict:
    """Cuerpo JSON de la petición actual como dict.

    `silent=True` porque un JSON malformado debe dar un 400 con mensaje propio,
    no el 400 HTML de Werkzeug.
    """
    from flask import request

    data = request.get_json(silent=True)
    if data is None:
        if required:
            raise ValidationError("Se esperaba un cuerpo JSON válido")
        return {}
    if not isinstance(data, dict):
        raise ValidationError("El cuerpo JSON debe ser un objeto")
    return data


def as_text(value, field="valor", *, default="", max_length=DEFAULT_MAX_LENGTH,
            required=False, strip=True) -> str:
    """Convierte a cadena acotada. None/ausente pasa a `default`."""
    if value is None:
        text = default
    elif isinstance(value, (dict, list, tuple, set)):
        raise ValidationError(f"«{field}» debe ser un texto", field=field)
    elif isinstance(value, bool):
        # bool es subclase de int: sin este caso, True acabaría como "True".
        raise ValidationError(f"«{field}» debe ser un texto", field=field)
    else:
        text = str(value)

    if strip:
        text = text.strip()
    if required and not text:
        raise ValidationError(f"«{field}» es obligatorio", field=field)
    if max_length is not None and len(text) > max_length:
        raise ValidationError(
            f"«{field}» supera el máximo de {max_length} caracteres", field=field
        )
    return text


def as_decimal(value, field="valor", *, default=None, minimum=None, maximum=None,
               required=False):
    """Número validado, en `Decimal`. Es la forma correcta para un importe.

    La conversión la hace `core.dinero`, la única del proyecto. Antes esta
    función tenía su propia copia, que descartaba cualquier carácter que no
    fuera dígito o separador: "12abc34" se convertía en 1234 y entraba en la
    aplicación como un importe legítimo.
    """
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise ValidationError(f"«{field}» es obligatorio", field=field)
        return default

    try:
        number = dinero.aDecimal(value, field)
    except dinero.ImporteInvalido:
        raise ValidationError(f"«{field}» debe ser numérico", field=field) from None

    if minimum is not None and number < minimum:
        raise ValidationError(f"«{field}» debe ser mayor o igual que {minimum}", field=field)
    if maximum is not None and number > maximum:
        raise ValidationError(f"«{field}» debe ser menor o igual que {maximum}", field=field)
    return number


def as_number(value, field="valor", *, default=None, minimum=None, maximum=None,
              required=False):
    """Igual que `as_decimal` pero devuelve `float`.

    Para lo que no es dinero: porcentajes de una gráfica, límites, contadores.
    Para importes usa `as_decimal`, porque lo que sale de aquí se suma.
    """
    number = as_decimal(value, field, default=default, minimum=minimum,
                        maximum=maximum, required=required)
    return number if number is None or isinstance(number, (int, float)) else float(number)


def as_int(value, field="valor", *, default=None, minimum=None, maximum=None,
           required=False):
    number = as_number(value, field, default=None, minimum=minimum,
                       maximum=maximum, required=required)
    if number is None:
        return default
    return int(number)


def as_bool(value, *, default=False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() in {"1", "true", "yes", "on", "si", "sí"}


def one_of(value, options, field="valor", *, default=None, upper=False,
           capitalize=False):
    """Normaliza contra un conjunto cerrado de opciones.

    Si el valor no está en `options` se usa `default` cuando existe; solo si no
    hay default se considera un error. Así los desplegables siguen siendo
    tolerantes (que es como funcionaba la app) sin dejar de validar cuando el
    campo es realmente obligatorio.
    """
    text = as_text(value, field)
    if upper:
        text = text.upper()
    elif capitalize:
        text = text.capitalize()

    if text in options:
        return text
    if default is not None:
        return default
    raise ValidationError(
        f"«{field}» debe ser uno de: {', '.join(sorted(options))}", field=field
    )


def as_rows(value, field="rows", *, max_rows=MAX_ROWS) -> list:
    """Lista de objetos tal como la envían las tablas del frontend."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValidationError(f"«{field}» debe ser una lista", field=field)
    if len(value) > max_rows:
        raise ValidationError(
            f"«{field}» supera el máximo de {max_rows} filas", field=field
        )
    for index, row in enumerate(value):
        if not isinstance(row, dict):
            raise ValidationError(
                f"«{field}[{index}]» debe ser un objeto", field=field
            )
    return value


def as_year(value, field="year") -> str:
    """Año de 4 dígitos en un rango razonable.

    Las tablas de gastos/ingresos/ventas usan el año como parte de la clave
    primaria y como nombre de fichero histórico, así que un valor libre aquí
    creaba entradas basura imposibles de borrar desde la interfaz.
    """
    text = as_text(value, field, max_length=8)
    if not text.isdigit() or len(text) != 4:
        raise ValidationError(f"«{field}» debe ser un año de 4 dígitos", field=field)
    year = int(text)
    if not 1900 <= year <= 2200:
        raise ValidationError(f"«{field}» está fuera de rango", field=field)
    return text
