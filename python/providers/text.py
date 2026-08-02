"""Normalización y formato de texto/números comunes a todos los proveedores."""

import re

_NON_ALNUM_LOWER = re.compile(r"[^a-z0-9]+")
_NON_ALNUM_UPPER = re.compile(r"[^A-Za-z0-9]+")

# Marcadores de "sin dato" que devuelven los proveedores en campos numéricos.
_NULL_TOKENS = {"NA", "N/A", "NONE", "NULL", "-", "--"}


def normalize_text(value) -> str:
    """Texto en minúsculas sin nada que no sea alfanumérico (para comparar)."""
    return _NON_ALNUM_LOWER.sub("", str(value or "").lower())


def compact_symbol(value) -> str:
    """Símbolo en mayúsculas sin separadores: BTC-USD y BTC/USD → BTCUSD."""
    return _NON_ALNUM_UPPER.sub("", str(value or "").upper())


def format_decimal(value, digits=2) -> str:
    """Número con coma decimal (formato español).

    Acepta cadenas además de números: las versiones duplicadas hacían
    `f"{value:.2f}"` directamente y reventaban con TypeError si el proveedor
    devolvía el precio como texto, que es justo lo que hace EODHD a veces.
    """
    number = safe_float(value, fallback=None)
    if number is None:
        number = 0.0
    return f"{number:.{digits}f}".replace(".", ",")


def format_percent(value, digits=2) -> str:
    number = safe_float(value, fallback=0.0)
    sign = "+" if number >= 0 else ""
    return f"{sign}{format_decimal(number, digits)}%"


def safe_float(value, fallback=0.0):
    """float() tolerante: acepta '1.234,56', '3,5%', 'N/A' y None."""
    if isinstance(value, bool):
        return fallback
    if isinstance(value, (int, float)):
        number = float(value)
        # NaN/inf de un proveedor propagados a un cálculo dan resultados
        # imposibles de depurar; se tratan como "sin dato".
        return fallback if number != number or number in (float("inf"), float("-inf")) else number

    text = str(value or "").strip().replace("%", "").strip()
    if not text or text.upper() in _NULL_TOKENS:
        return fallback

    if "," in text and "." in text:
        text = text.replace(".", "").replace(",", ".")
    else:
        text = text.replace(",", ".")

    try:
        number = float(text)
    except (TypeError, ValueError):
        return fallback
    return fallback if number != number or number in (float("inf"), float("-inf")) else number
