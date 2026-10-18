"""Utilidades compartidas por los clientes de datos de mercado.

Finnhub, EODHD, Yahoo Finance y Alpha Vantage tenían cada uno su propia copia
de `_fetchJson`, `_normalize_text`, `_format_decimal`, `_format_percent` y
`_safe_float`. Al estar duplicadas, cualquier mejora (reintentos, límite de
tamaño de respuesta, tolerancia a JSON malformado) había que aplicarla cuatro
veces —y en la práctica no se aplicaba en ninguna—.
"""

from providers.http import (
    ProviderError,
    ProviderResponseError,
    fetchJson,
)
from providers.text import (
    compactSymbol,
    formatDecimal,
    formatPercent,
    normalizeText,
    safeFloat,
)

__all__ = [
    "ProviderError",
    "ProviderResponseError",
    "compactSymbol",
    "fetchJson",
    "formatDecimal",
    "formatPercent",
    "normalizeText",
    "safeFloat",
]
