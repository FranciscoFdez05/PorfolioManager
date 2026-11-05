"""Lista «Seguimiento» de la Watchlist: la cripto que hay en las wallets enlazadas.

Una entrada por la moneda de cada red con alguna wallet y otra por cada token
visto en ellas (`TokenConocido`), propias y ajenas. Las imitaciones no entran:
se llaman como otro activo pero no valen como él. Los sospechosos sí, con su
etiqueta, porque es el usuario quien decide si le interesa seguirlos.

Aquí no hay precios: cada entrada dice con qué se cotiza (el activo de Activos
o el ticker puesto a mano) y la Watchlist pide la cotización como con el resto
de activos.
"""

from collections.abc import Callable
from dataclasses import dataclass

from core.cripto_direcciones import REDES
from core.wallets_sync import resolverActivoToken
from core.wallets_tokens import IMITACION, estadoToken, indiceMarcas, indicePublico, indiceVerificados
from providers.listas_tokens import TokenPublico, tokensPublicos
from stores.app_data import readStablecoinsFile
from stores.asset_store import listarActivosParaTokens
from stores.wallets_store import TokenPrecio, WalletsRepository

TIPO_MONEDA = "moneda"
TIPO_TOKEN = "token"


@dataclass
class ListaWatchlist:
    """Construye la lista. Patrón de inyección de dependencias, como `VisorTokens`, para los tests.

    Args:
        repositorio: Repositorio de wallets.
        leerActivos: Criptos y ETFs de Activos (`listarActivosParaTokens`).
        leerStablecoins: Símbolos de las stablecoins activadas.
        leerTokensPublicos: Listas públicas de tokens; solo se leen si hay tokens.
    """

    repositorio: WalletsRepository
    leerActivos: Callable[[], list[dict]] = listarActivosParaTokens
    leerStablecoins: Callable[[], list[str]] = lambda: readStablecoinsFile().get("enabledSymbols", [])
    leerTokensPublicos: Callable[[], list[TokenPublico]] = tokensPublicos

    def entradas(self) -> list[dict]:
        """Las monedas de cada red y luego los tokens, en el orden en que se vieron.

        Returns:
            Dicts con `id`, `tipo` (`TIPO_MONEDA` o `TIPO_TOKEN`), `red`,
            `redNombre`, `simbolo`, `nombre`, `contrato` ("" en las monedas),
            `assetId` (activo con el que se cotiza, o ""), `proveedor` y
            `ticker` (los puestos a mano, o "") y `sospechoso`.

        Raises:
            WalletError: si el fichero de wallets no se puede leer.
        """
        wallets = self.repositorio.listar()
        redes = list(dict.fromkeys(w.red for w in wallets if w.red in REDES))
        tickers = {(p.red, p.contrato): p for p in self.repositorio.preciosToken()}
        monedas = [self._moneda(red, next((w.assetId for w in wallets if w.red == red and w.assetId), ""),
                                tickers.get((red, "")))
                   for red in redes]
        conocidos = [t for t in self.repositorio.tokensConocidos() if t.red in redes]
        if not conocidos:
            return monedas
        return monedas + self._tokens(conocidos, tickers)

    @staticmethod
    def _moneda(red: str, assetId: str, ticker: TokenPrecio | None) -> dict:
        datosRed = REDES[red]
        # Como en los tokens, el ticker puesto a mano manda sobre el activo.
        entrada = _entrada(f"moneda-{red}", TIPO_MONEDA, red, datosRed.simbolo, datosRed.nombre, "",
                           "" if ticker else assetId)
        if ticker:
            entrada.update(proveedor=ticker.proveedor, ticker=ticker.ticker)
        return entrada

    def _tokens(self, conocidos: list, tickers: dict[tuple[str, str], TokenPrecio]) -> list[dict]:
        verificados = indiceVerificados(self.repositorio.tokensVerificados())
        marcas = indiceMarcas(self.repositorio.marcasToken())
        publicos = indicePublico(self.leerTokensPublicos())
        sospechosos = {(s.red, s.contrato) for s in self.repositorio.tokensSospechosos()}
        activos = self.leerActivos()
        stablecoins = self.leerStablecoins()
        resultado = []
        for token in conocidos:
            if estadoToken(token.red, token.simbolo, token.contrato, verificados, marcas, publicos) == IMITACION:
                continue
            clave = (token.red, token.contrato)
            ticker = tickers.get(clave)
            # El ticker puesto a mano manda: si el usuario lo ha puesto es
            # porque el activo por símbolo no le sirve o no existe.
            activo = None if ticker else resolverActivoToken(token.simbolo, activos, stablecoins)
            entrada = _entrada(f"token-{token.red}-{token.contrato}", TIPO_TOKEN, token.red, token.simbolo,
                               token.nombre or token.simbolo, token.contrato, activo["id"] if activo else "")
            if ticker:
                entrada.update(proveedor=ticker.proveedor, ticker=ticker.ticker)
            entrada["sospechoso"] = clave in sospechosos
            resultado.append(entrada)
        return resultado


def _entrada(identificador: str, tipo: str, red: str, simbolo: str, nombre: str, contrato: str,
             assetId: str) -> dict:
    return {
        "id": identificador,
        "tipo": tipo,
        "red": red,
        "redNombre": REDES[red].nombre,
        "simbolo": simbolo,
        "nombre": nombre,
        "contrato": contrato,
        "assetId": assetId,
        "proveedor": "",
        "ticker": "",
        "sospechoso": False,
    }
