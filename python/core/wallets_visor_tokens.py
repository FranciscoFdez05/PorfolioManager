"""Visor de tokens: lo que tiene ahora una wallet de Ethereum o BNB, token a token.

Es el equivalente del visor de UTXOs de Bitcoin: solo lee, vale para wallets
propias y ajenas y no importa nada a Transacciones.

Cada token lleva su estado frente a los contratos verificados
(`core.wallets_tokens`) y el activo de Activos que le corresponde por símbolo:
una cripto, una stablecoin activada o un ETF, porque hay ETFs tokenizados.
El activo y el valor se devuelven aunque el token sea una imitación: el
usuario puede verificar o marcar contratos desde la misma página sin volver a
leer la red, así que es la página la que, con el estado del momento, no le da
valor a una imitación (se llama como uno de verdad, pero no vale lo mismo).

El valor en euros sale del precio del activo asociado, el mismo que usa
Activos. En un ETF tokenizado es aproximado: el token sigue al ETF, pero su
emisor puede aplicar una proporción distinta de 1 a 1 o acumular dividendos.
Si el usuario le ha puesto un ticker a un token (`TokenPrecio`), se valora con
él aunque tenga activo asociado: lo ha puesto porque el activo no le sirve.

Cada lectura anota los tokens vistos (`anotarConocidos`) para la lista
«Seguimiento» de la Watchlist.
"""

import logging
from collections.abc import Callable
from dataclasses import asdict
from decimal import Decimal

from core import settings
from core.wallets_sync import resolverActivoToken, textoDecimal
from core.wallets_tokens import (
    anotarConocidos,
    estadoToken,
    indiceMarcas,
    indicePublico,
    indiceVerificados,
    publicosRelacionados,
)
from core.wallets_vigilancia import precioEurDeActivo, precioEurDeTicker
from providers.blockchain_clients import SaldoToken, lectorTokens, redesConTokens
from providers.listas_tokens import TokenPublico, tokensPublicos
from stores.app_data import readStablecoinsFile
from stores.asset_store import listarActivosParaTokens
from stores.wallets_store import TokenPrecio, WalletError, WalletsRepository

log = logging.getLogger(__name__)


class RedSinVisorTokens(WalletError):
    """La wallet es de una red cuyos tokens no se leen (todas salvo Ethereum y BNB)."""


class VisorTokens:
    """Servicio del visor. Todas las dependencias son inyectables para los tests."""

    def __init__(
        self,
        repositorio: WalletsRepository | None = None,
        fabricaLector: Callable | None = None,
        leerActivos: Callable[[], list[dict]] = listarActivosParaTokens,
        leerStablecoins: Callable[[], list[str]] = lambda: readStablecoinsFile().get("enabledSymbols", []),
        precioEur: Callable[[str], Decimal | None] = precioEurDeActivo,
        maxTokens: Callable[[], int] = settings.walletsMaxTokensVisor,
        historial: Callable[[], int] = settings.walletsMaxHistorial,
        leerTokensPublicos: Callable[[], list[TokenPublico]] = tokensPublicos,
        precioTicker: Callable[[str, str], Decimal | None] = precioEurDeTicker,
    ) -> None:
        self._precioTicker = precioTicker
        self._leerTokensPublicos = leerTokensPublicos
        self._repositorio = repositorio or WalletsRepository()
        self._fabricaLector = fabricaLector or lectorTokens
        self._leerActivos = leerActivos
        self._leerStablecoins = leerStablecoins
        self._precioEur = precioEur
        self._maxTokens = maxTokens
        self._historial = historial

    def leer(self, walletId: str) -> dict:
        """Los tokens con saldo de la wallet, ya clasificados y valorados.

        Returns:
            `{"tokens": [...], "sinLeer": int, "tokensPublicos": [...]}`; cada
            token es un dict con contrato, símbolo, nombre, cantidad, último
            movimiento, estado, activo asociado por símbolo (o None), ticker
            puesto a mano (`precio`: `{"proveedor", "ticker"}` o None) y valor en
            euros ("" si no se sabe). `tokensPublicos` son los contratos de las
            listas públicas que la página necesita para recalcular el estado.

        Raises:
            WalletNoEncontrada: si la wallet no existe.
            RedSinVisorTokens: si la wallet no es de Ethereum ni de BNB.
            ErrorLecturaWallet: si Etherscan falla o responde algo inesperado.
        """
        wallet = self._repositorio.obtener(walletId)
        if wallet.red not in redesConTokens():
            raise RedSinVisorTokens("Solo las wallets de Ethereum y BNB Smart Chain tienen visor de tokens")
        saldos, sinLeer = self._fabricaLector(wallet.red).saldosTokens(
            wallet.valor, self._maxTokens(), self._historial()
        )
        verificados = indiceVerificados(self._repositorio.tokensVerificados())
        marcas = indiceMarcas(self._repositorio.marcasToken())
        publicos = indicePublico(self._leerTokensPublicos()) if saldos else None
        activos = self._leerActivos()
        tiposPorId = {activo["id"]: activo["type"] for activo in activos}
        stablecoins = self._leerStablecoins()
        precios: dict[str, Decimal | None] = {}
        tickers = {(p.red, p.contrato): p for p in self._repositorio.preciosToken()} if saldos else {}
        tokens = []
        for saldo in saldos:
            estado = estadoToken(wallet.red, saldo.simbolo, saldo.contrato, verificados, marcas, publicos)
            activo = resolverActivoToken(saldo.simbolo, activos, stablecoins)
            ticker = tickers.get((wallet.red, saldo.contrato))
            # El ticker puesto a mano manda sobre el activo por símbolo, como en la Watchlist.
            valor = self._valorTicker(saldo, ticker) if ticker else self._valor(saldo, activo, precios)
            tokens.append(self._comoDict(saldo, estado, activo, tiposPorId, valor, ticker))
        anotarConocidos(self._repositorio, wallet.red, ((s.contrato, s.simbolo, s.nombre) for s in saldos))
        log.info("[wallets] Visor de tokens: %d con saldo, %d sin leer", len(tokens), sinLeer)
        relacionados = []
        if publicos:
            relacionados = publicosRelacionados(publicos, ((wallet.red, s.simbolo, s.contrato) for s in saldos))
        return {"tokens": tokens, "sinLeer": sinLeer, "tokensPublicos": [asdict(t) for t in relacionados]}

    def _valor(self, saldo: SaldoToken, activo: dict | None, precios: dict) -> Decimal | None:
        if activo is None:
            return None
        if activo["id"] not in precios:
            try:
                precios[activo["id"]] = self._precioEur(activo["id"])
            except Exception as error:
                # Sin tipo de cambio el token se enseña igual, sin valor en euros.
                log.debug("[wallets] Sin precio en euros para %s: %s", activo["id"], error)
                precios[activo["id"]] = None
        precio = precios[activo["id"]]
        return None if precio is None else saldo.cantidad * precio

    def _valorTicker(self, saldo: SaldoToken, ticker: TokenPrecio | None) -> Decimal | None:
        if ticker is None:
            return None
        try:
            precio = self._precioTicker(ticker.proveedor, ticker.ticker)
        except Exception as error:
            # Igual que con el activo: sin cotización el token sale sin valor.
            log.debug("[wallets] Sin precio para el ticker %s: %s", ticker.ticker, error)
            return None
        return None if precio is None else saldo.cantidad * precio

    @staticmethod
    def _comoDict(saldo: SaldoToken, estado: str, activo: dict | None, tiposPorId: dict,
                  valor: Decimal | None, ticker: TokenPrecio | None = None) -> dict:
        return {
            "contrato": saldo.contrato,
            "simbolo": saldo.simbolo,
            "nombre": saldo.nombre,
            "cantidad": textoDecimal(saldo.cantidad),
            "ultimoMovimiento": saldo.ultimoMovimiento.isoformat() if saldo.ultimoMovimiento else "",
            "estado": estado,
            # Las stablecoins no están en Activos: su id es «stablecoin-…».
            "activo": None if activo is None else {
                **activo, "type": tiposPorId.get(activo["id"], "stablecoin"),
            },
            "precio": None if ticker is None else {"proveedor": ticker.proveedor, "ticker": ticker.ticker},
            "valorEur": textoDecimal(valor.quantize(Decimal("0.01"))) if valor is not None else "",
        }
