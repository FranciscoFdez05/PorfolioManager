"""Listas públicas de tokens: los contratos que la comunidad da por auténticos.

Patrón Adapter: las listas siguen el estándar Token Lists (tokenlists.org),
que publican Uniswap y CoinGecko, y aquí se reducen a `TokenPublico` de las
redes que se leen (Ethereum y BNB Smart Chain). `core.wallets_tokens` decide
con ellas qué contrato sale verificado sin que el usuario lo confirme.

Se descargan enteras y se busca en local: preguntar a un tercero por un
contrato concreto le diría qué tokens tiene la wallet.

La caché es de proceso (una por worker de gunicorn) y por lista: si una falla,
se sigue con su última copia buena y se reintenta antes que una que fue bien,
para que un fallo puntual no cambie de golpe el estado de los tokens.
"""

import logging
import re
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit

from core import settings
from providers.blockchain_clients import cadenasEvm
from providers.http import ProviderError, fetchJson

log = logging.getLogger(__name__)

# Tras un fallo, cuánto se espera antes de volver a intentarlo: sin esto, cada
# petición que necesite la lista esperaría el timeout mientras la fuente siga caída.
_ESPERA_TRAS_FALLO = 15 * 60
_CONTRATO_EVM = re.compile(r"^0x[0-9a-f]{40}$")
# El mismo tope que aplican los lectores al símbolo que llega de la red.
_MAX_LARGO_SIMBOLO = 20


@dataclass(frozen=True)
class TokenPublico:
    """Un contrato que una lista pública da por auténtico.

    `contrato` va en minúsculas, como los que leen los lectores EVM, y
    `simbolo` limpio como el de la red: solo letras y números, en mayúsculas.
    """

    red: str
    contrato: str
    simbolo: str


def _simbolo(texto) -> str:
    return "".join(c for c in str(texto or "") if c.isalnum()).upper()[:_MAX_LARGO_SIMBOLO]


def tokensDeLista(datos, redesPorCadena: dict[int, str]) -> list[TokenPublico]:
    """Los tokens de una lista en formato Token Lists que son de las redes dadas.

    Las entradas mal formadas se descartan una a una: la lista viene de fuera.

    Args:
        datos: El JSON de la lista, ya parseado.
        redesPorCadena: Clave de red por chainId.

    Example:
        >>> tokensDeLista({"tokens": [{"chainId": 1, "address": "0x" + "A" * 40, "symbol": "Link"}]}, {1: "eth"})
        [TokenPublico(red='eth', contrato='0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', simbolo='LINK')]
    """
    entradas = datos.get("tokens") if isinstance(datos, dict) else None
    if not isinstance(entradas, list):
        return []
    tokens = []
    for entrada in entradas:
        if not isinstance(entrada, dict):
            continue
        red = redesPorCadena.get(entrada.get("chainId"))
        contrato = str(entrada.get("address") or "").lower()
        simbolo = _simbolo(entrada.get("symbol"))
        if red and simbolo and _CONTRATO_EVM.match(contrato):
            tokens.append(TokenPublico(red, contrato, simbolo))
    return tokens


class ListasTokens:
    """Descarga y caché de las listas. Todas las dependencias son inyectables para los tests."""

    def __init__(
        self,
        urls: Callable[[], list[str]] = settings.walletsListasTokens,
        horas: Callable[[], int] = settings.walletsListasTokensHoras,
        obtenerJson: Callable = fetchJson,
        reloj: Callable[[], float] = time.monotonic,
    ) -> None:
        self._urls = urls
        self._horas = horas
        self._obtenerJson = obtenerJson
        self._reloj = reloj
        self._porUrl: dict[str, tuple[TokenPublico, ...]] = {}
        self._caduca: dict[str, float] = {}
        # Con la caché fría, varias peticiones a la vez descargarían lo mismo.
        self._cerrojo = threading.Lock()

    def tokens(self) -> list[TokenPublico]:
        """Los tokens de todas las listas configuradas, sin repetir contrato.

        Nunca lanza: una lista que no se puede descargar aporta su última copia
        buena, o nada si nunca se llegó a descargar.
        """
        with self._cerrojo:
            unicos: dict[tuple[str, str], TokenPublico] = {}
            for url in self._urls():
                for token in self._deUrl(url):
                    unicos.setdefault((token.red, token.contrato), token)
            return list(unicos.values())

    def _deUrl(self, url: str) -> tuple[TokenPublico, ...]:
        ahora = self._reloj()
        if ahora < self._caduca.get(url, 0.0):
            return self._porUrl.get(url, ())
        try:
            tokens = self._descargar(url)
        except (ProviderError, HTTPError, URLError, TimeoutError, OSError, ValueError) as error:
            log.warning("[wallets] No se pudo descargar la lista de tokens %s: %s", url, error)
            self._caduca[url] = ahora + _ESPERA_TRAS_FALLO
            return self._porUrl.get(url, ())
        log.info("[wallets] Lista de tokens %s: %d contratos", url, len(tokens))
        self._porUrl[url] = tokens
        self._caduca[url] = ahora + self._horas() * 3600
        return tokens

    def _descargar(self, url: str) -> tuple[TokenPublico, ...]:
        if urlsplit(url).scheme not in ("http", "https"):
            raise ValueError("solo se admiten URL http o https")
        redesPorCadena = {cadena: red for red, cadena in cadenasEvm().items()}
        # Sin reintentos: la lista se pide dentro de una petición del usuario y,
        # si falla, se tira de la copia anterior.
        return tuple(tokensDeLista(self._obtenerJson(url, retries=0), redesPorCadena))


_LISTAS = ListasTokens()


def tokensPublicos() -> list[TokenPublico]:
    """Los tokens de las listas públicas configuradas, con la caché del proceso."""
    return _LISTAS.tokens()
