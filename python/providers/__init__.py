"""Utilidades compartidas por los clientes de datos de mercado.

Finnhub, EODHD, Yahoo Finance y Alpha Vantage tenían cada uno su propia copia
de `_fetch_json`, `_normalize_text`, `_format_decimal`, `_format_percent` y
`_safe_float`. Al estar duplicadas, cualquier mejora (reintentos, límite de
tamaño de respuesta, tolerancia a JSON malformado) había que aplicarla cuatro
veces —y en la práctica no se aplicaba en ninguna—.
"""

from providers.http import (
    ProviderError,
    ProviderResponseError,
    fetch_json,
)
from providers.text import (
    compact_symbol,
    format_decimal,
    format_percent,
    normalize_text,
    safe_float,
)

__all__ = [
    "ProviderError",
    "ProviderResponseError",
    "compact_symbol",
    "fetch_json",
    "format_decimal",
    "format_percent",
    "normalize_text",
    "safe_float",
]
