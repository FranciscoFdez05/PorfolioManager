"""Tokens verificados: qué contrato es el auténtico de cada símbolo en cada red.

El símbolo de un token lo elige quien lo crea, y las memecoins son lo que más se
imita: llegan sin pedirlas tokens llamados «PEPE» o «USDT» que no valen nada.
Con solo el símbolo, una copia se importaría al activo del token auténtico.

El usuario confirma, desde el historial de un seguimiento, qué contrato es el
bueno. A partir de ahí, en esa red:

* ese contrato es **verificado**;
* cualquier otro contrato con el mismo símbolo es una **imitación**, y no se
  importa a Transacciones;
* los símbolos que nadie ha confirmado siguen **sin verificar** y se importan
  por símbolo, como antes de existir esto.

Un token que se llama como la moneda nativa de la red se toma por una imitación.

Si el usuario no ha confirmado nada de un símbolo, deciden las listas públicas
de tokens (`providers.listas_tokens`): un contrato que aparece en ellas es
**reconocido** (se enseña como verificado) y cualquier otro con su símbolo, una
imitación. El contrato reconocido se busca por contrato y no por símbolo, porque
las listas no siempre coinciden con la red (CoinGecko llama «RENDER» al «RNDR»).
Lo que confirma el usuario manda sobre las listas.

Todo lo anterior es la detección automática; la última palabra es del usuario.
Puede marcar un contrato como **imitación** (spam que nada delata) o como
**legítimo** (no es una imitación aunque lo parezca), y esa marca manda sobre
la regla. Un contrato legítimo se importa por su símbolo, como uno sin verificar.

Aparte de la marca, el usuario puede etiquetar un contrato como **sospechoso**
(`TokenSospechoso`): ve algo raro que ninguna lista ni regla delata. Es solo
una etiqueta para la pantalla; no cambia el estado ni lo que se importa.

Los símbolos se comparan por su esqueleto, sin acentos ni otras marcas: «ĖŢḤ»
es «ETH» y «PEPĖ» es «PEPE». Las letras de otros alfabetos que solo se parecen
(la «Е» cirílica) no se detectan: haría falta la tabla de confusables de Unicode.

js/cripto/wallets-seguimiento.js repite esta regla (`walletsSegEstadoToken`)
para pintar el estado sin pedírselo al servidor: si cambia aquí, cambia allí.
"""

import logging
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass, field

from core.cripto_direcciones import REDES
from providers.listas_tokens import TokenPublico
from stores.wallets_store import (
    MARCA_IMITACION,
    MARCA_LEGITIMO,
    TokenConocido,
    TokenMarcado,
    TokenVerificado,
    WalletError,
    WalletsRepository,
)

log = logging.getLogger(__name__)

VERIFICADO = "verificado"
IMITACION = "imitacion"
SIN_VERIFICAR = "sinVerificar"
LEGITIMO = "legitimo"
RECONOCIDO = "reconocido"

IndiceTokens = dict[tuple[str, str], frozenset[str]]
IndiceMarcas = dict[tuple[str, str], str]


@dataclass(frozen=True)
class IndicePublico:
    """Los tokens de las listas públicas, por contrato y por esqueleto del símbolo."""

    porContrato: dict[tuple[str, str], TokenPublico] = field(default_factory=dict)
    porSimbolo: dict[tuple[str, str], tuple[TokenPublico, ...]] = field(default_factory=dict)


def esqueletoSimbolo(simbolo: str) -> str:
    """El símbolo sin acentos ni marcas, en mayúsculas, para comparar imitaciones.

    Example:
        >>> esqueletoSimbolo("ĖŢḤ")
        'ETH'
    """
    descompuesto = unicodedata.normalize("NFKD", str(simbolo or ""))
    return "".join(c for c in descompuesto if not unicodedata.combining(c)).upper()


def esNombreDeLaRed(red: str, simbolo: str) -> bool:
    """¿Se hace pasar el símbolo por la moneda nativa de la red?"""
    datosRed = REDES.get(red)
    return datosRed is not None and esqueletoSimbolo(simbolo) == datosRed.simbolo


def indiceVerificados(tokens: Iterable[TokenVerificado]) -> IndiceTokens:
    """Los contratos verificados agrupados por (red, esqueleto del símbolo), para buscarlos en O(1).

    Example:
        >>> indiceVerificados([TokenVerificado("eth", "0xa", "PEPE")])
        {('eth', 'PEPE'): frozenset({'0xa'})}
    """
    agrupados: dict[tuple[str, str], set[str]] = {}
    for token in tokens:
        agrupados.setdefault((token.red, esqueletoSimbolo(token.simbolo)), set()).add(token.contrato)
    return {clave: frozenset(contratos) for clave, contratos in agrupados.items()}


def indiceMarcas(marcas: Iterable[TokenMarcado]) -> IndiceMarcas:
    """Las marcas del usuario por (red, contrato), para buscarlas en O(1).

    Example:
        >>> indiceMarcas([TokenMarcado("eth", "0xa", "imitacion")])
        {('eth', '0xa'): 'imitacion'}
    """
    return {(m.red, m.contrato): m.marca for m in marcas}


def indicePublico(tokens: Iterable[TokenPublico]) -> IndicePublico:
    """Los tokens de las listas públicas indexados para buscarlos en O(1).

    Example:
        >>> indicePublico([TokenPublico("eth", "0xa", "LINK")]).porSimbolo
        {('eth', 'LINK'): (TokenPublico(red='eth', contrato='0xa', simbolo='LINK'),)}
    """
    porContrato: dict[tuple[str, str], TokenPublico] = {}
    porSimbolo: dict[tuple[str, str], list[TokenPublico]] = {}
    for token in tokens:
        porContrato[(token.red, token.contrato)] = token
        porSimbolo.setdefault((token.red, esqueletoSimbolo(token.simbolo)), []).append(token)
    return IndicePublico(porContrato, {clave: tuple(lista) for clave, lista in porSimbolo.items()})


def anotarConocidos(repositorio: WalletsRepository, red: str, tokens: Iterable[tuple[str, str, str]]) -> int:
    """Anota los tokens vistos en una wallet para la lista «Seguimiento» de la Watchlist.

    Nunca falla: es un efecto secundario de leer la red, y quien sigue solo
    wallets ajenas sin SECRET_KEY no puede guardar nada cifrado. Eso no debe
    romper la lectura que lo ha provocado.

    Args:
        repositorio: Repositorio de wallets.
        red: Clave de `REDES`.
        tokens: Tripletas (contrato, símbolo, nombre) de lo leído.

    Returns:
        Cuántos tokens nuevos se han anotado (0 también si no se pudo).
    """
    conocidos = [TokenConocido(red, contrato, simbolo, nombre) for contrato, simbolo, nombre in tokens if contrato]
    if not conocidos:
        return 0
    try:
        return repositorio.anotarTokensConocidos(conocidos)
    except WalletError as error:
        log.debug("[wallets] No se anotaron los tokens vistos en %s: %s", red, error)
        return 0


def publicosRelacionados(indice: IndicePublico, tokens: Iterable[tuple[str, str, str]]) -> list[TokenPublico]:
    """Lo que la página necesita de las listas para repetir `estadoToken` con esos tokens.

    La lista entera son miles de contratos; para decidir el estado de un token
    basta con su propio contrato y los que comparten su símbolo en su red.

    Args:
        indice: Resultado de `indicePublico`.
        tokens: Tripletas (red, símbolo, contrato) de los tokens que se enseñan.
    """
    relacionados: dict[tuple[str, str], TokenPublico] = {}
    for red, simbolo, contrato in tokens:
        propio = indice.porContrato.get((red, contrato))
        if propio:
            relacionados[(red, contrato)] = propio
        for token in indice.porSimbolo.get((red, esqueletoSimbolo(simbolo)), ()):
            relacionados[(token.red, token.contrato)] = token
    return list(relacionados.values())


def estadoToken(red: str, simbolo: str, contrato: str, indice: IndiceTokens,
                marcas: IndiceMarcas | None = None, publicos: IndicePublico | None = None) -> str:
    """`VERIFICADO`, `RECONOCIDO`, `IMITACION`, `LEGITIMO` o `SIN_VERIFICAR`; "" si no es un token.

    Args:
        red: Clave de `REDES`.
        simbolo: Símbolo del token, en mayúsculas.
        contrato: Contrato del token, en forma canónica.
        indice: Resultado de `indiceVerificados`.
        marcas: Resultado de `indiceMarcas`; la marca de un contrato manda sobre la regla.
        publicos: Resultado de `indicePublico`; solo decide en los símbolos
            que el usuario no ha verificado.
    """
    if not contrato:
        return ""
    marca = (marcas or {}).get((red, contrato))
    if marca == MARCA_IMITACION:
        return IMITACION
    if marca == MARCA_LEGITIMO:
        return LEGITIMO
    if esNombreDeLaRed(red, simbolo):
        return IMITACION
    esqueleto = esqueletoSimbolo(simbolo)
    autenticos = indice.get((red, esqueleto))
    if autenticos:
        return VERIFICADO if contrato in autenticos else IMITACION
    publicos = publicos or IndicePublico()
    if (red, contrato) in publicos.porContrato:
        return RECONOCIDO
    return IMITACION if (red, esqueleto) in publicos.porSimbolo else SIN_VERIFICAR
