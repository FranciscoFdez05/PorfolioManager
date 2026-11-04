"""Importa a Cripto > Transacciones los movimientos de una wallet enlazada.

Cada movimiento se convierte en una fila normal de Transacciones —editable y
borrable como las demás— y se identifica por (hash, activo). Volver a
sincronizar solo añade lo nuevo, y borrar a mano una fila importada no la hace
reaparecer… salvo que se vuelva a sincronizar: el hash ya no está y se
considera nueva. Es el comportamiento esperable de un «importar».

La moneda nativa va al activo que se eligió al enlazar la wallet: los símbolos
de Activos son libres («BTC», «BITCOIN», «BITVAVO:BTCEUR»…) y adivinarlo
fallaría en silencio. Los tokens de Ethereum/BNB sí se buscan por símbolo entre
las criptos de Activos y las stablecoins activadas; los que no encajan se
cuentan y se devuelven, no se inventan. Si el usuario ha verificado el contrato
de un símbolo, los demás contratos con ese símbolo son imitaciones y tampoco se
importan (`core.wallets_tokens`); si no ha verificado ninguno, hace lo mismo el
contrato que dan por auténtico las listas públicas de tokens.

La escritura usa la misma revisión que la pantalla de Transacciones: si otra
pestaña guarda entre la lectura y la escritura, se relee y se repite.

La libreta de direcciones (`core.wallets_libreta`) decide si un envío o un
recibo es en realidad entre wallets propias y qué nombre lleva la contraparte.
Cada fila importada deja apuntada su contraparte en el fichero de wallets: así,
al marcar después esa dirección, `reetiquetar` corrige las filas que ya estaban.

Una transacción también se marca por separado (`aplicarMarca`). Lo comprado en un
exchange y pasado a la wallet fría ya está en la posición por la compra: como
«entre wallets» no vuelve a sumar y solo descuenta su comisión.
"""

import hashlib
import logging
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Callable

from core import settings
from core.cripto_direcciones import REDES, TIPO_DIRECCION, DatoWalletInvalido, normalizarDatoWallet
from core.wallets_libreta import (
    SENTIDOS,
    Libreta,
    canonica,
    clasificarMovimiento,
    comisionMarcada,
    libretaDe,
    nombreContraparte,
    reciboConComision,
)
from core.wallets_tokens import IMITACION, estadoToken, indiceMarcas, indicePublico, indiceVerificados
from providers.blockchain_clients import (
    ENTRE_WALLETS,
    ENVIADA,
    ComisionPagada,
    ErrorLecturaWallet,
    MovimientoWallet,
    lectorPara,
    leerConComisiones,
)
from providers.listas_tokens import TokenPublico, tokensPublicos
from stores import revisiones
from stores.app_data import readStablecoinsFile, readTransaccionesFile, writeTransaccionesFile
from stores.asset_store import listarActivosCripto
from stores.wallets_store import TokenMarcado, TokenVerificado, Wallet, WalletError, WalletsRepository, ahoraIso

log = logging.getLogger(__name__)

_INTENTOS_ESCRITURA = 3


class ActivoDeWalletInexistente(WalletError):
    """El activo elegido al enlazar no existe en el portfolio activo."""


@dataclass
class ResultadoSincronizacion:
    """Lo que ha pasado en una sincronización, para enseñarlo al usuario."""

    anadidas: int = 0
    yaImportadas: int = 0
    sinActivo: dict[str, int] = field(default_factory=dict)
    revision: int | None = None
    # La lectura se ha llenado: puede haber movimientos más antiguos sin importar.
    truncada: bool = False
    limite: int = 0
    # Fecha del movimiento más antiguo leído («dd-mm-aaaa»), lo que sí está cubierto.
    desde: str = ""

    def comoDict(self) -> dict:
        datos = {
            "anadidas": self.anadidas,
            "yaImportadas": self.yaImportadas,
            "sinActivo": dict(sorted(self.sinActivo.items())),
            "revision": self.revision,
        }
        if self.truncada:
            datos.update(truncada=True, limite=self.limite, desde=self.desde)
        return datos


def textoDecimal(valor: Decimal | None) -> str:
    """Un Decimal sin exponente ni ceros de sobra: «0.00012», no «1.2E-4».

    Example:
        >>> textoDecimal(Decimal("0.000120"))
        '0.00012'
    """
    if valor is None:
        return ""
    texto = format(valor.normalize(), "f")
    return "0" if texto in ("-0", "") else texto


def _baseDeSimbolo(simbolo: str) -> str:
    # «BITVAVO:BTC-EUR» → «BTC»; «ETH/USD» → «ETH». Solo se parte por los
    # separadores; un «BTCEUR» pegado no se intenta trocear.
    texto = str(simbolo or "").split(":")[-1]
    for separador in ("-", "/"):
        texto = texto.split(separador)[0]
    return "".join(c for c in texto if c.isalnum()).upper()


def resolverActivoToken(simbolo: str, activos: list[dict], stablecoins: list[str]) -> dict | None:
    """La cripto de Activos o la stablecoin activada que corresponde a un símbolo.

    Args:
        simbolo: Símbolo del token, ya en mayúsculas.
        activos: Resultado de `listarActivosCripto()`.
        stablecoins: Símbolos de las stablecoins activadas.

    Returns:
        `{"id", "name"}` o None si no hay ninguna.
    """
    for activo in activos:
        if simbolo in (_baseDeSimbolo(activo["symbol"]), _baseDeSimbolo(activo["marketSymbol"])):
            return {"id": activo["id"], "name": activo["name"]}
    if simbolo in {_baseDeSimbolo(s) for s in stablecoins}:
        return {"id": f"stablecoin-{simbolo}", "name": simbolo}
    return None


_PREFIJO_FILA = "wallet-"


def _huella(red: str, hashTx: str, assetId: str) -> str:
    return hashlib.sha256(f"{red}|{hashTx}|{assetId}".encode()).hexdigest()[:20]


def filaDeMovimiento(movimiento: MovimientoWallet, activo: dict, alias: str, libreta: Libreta | None = None) -> dict:
    """La fila de Transacciones de un movimiento, con el formato de la pantalla.

    Args:
        movimiento: Movimiento tal como lo leyó la red.
        activo: `{"id", "name"}` del activo al que se importa.
        alias: Nombre de la wallet propia en Transacciones.
        libreta: Libreta de direcciones; sin ella, la contraparte va tal cual.
    """
    propio = alias or "Wallet enlazada"
    tipo = movimiento.tipo
    contraparte = movimiento.contraparte
    comision = textoDecimal(movimiento.comision)
    if libreta is not None and tipo in SENTIDOS:
        entrada = libreta.buscar(movimiento.red, contraparte)
        marca = libreta.marcaDe(movimiento.red, movimiento.hash, movimiento.contrato)
        tipo, contraparte = clasificarMovimiento(tipo, entrada, marca), nombreContraparte(contraparte, entrada)
        comision = comisionMarcada(marca) or comision or _comisionDeOrigenPropio(
            contraparteDeMovimiento(movimiento), entrada, marca)
    # La dirección del dinero es la que leyó la red, aunque la libreta lo
    # convierta en «entre wallets»: dice cuál de las dos wallets es el destino.
    if movimiento.tipo == ENTRE_WALLETS:
        desde, hacia = propio, propio
    elif movimiento.tipo == ENVIADA:
        desde, hacia = propio, contraparte
    else:
        desde, hacia = contraparte, propio
    nota = f"Importado de {propio}"
    if movimiento.nota:
        nota += f" · {movimiento.nota}"
    return {
        "id": f"{_PREFIJO_FILA}{_huella(movimiento.red, movimiento.hash, activo['id'])}",
        "assetId": activo["id"],
        "assetName": activo["name"],
        "fechaOperacion": movimiento.fecha.strftime("%d-%m-%Y"),
        "total": textoDecimal(movimiento.cantidad),
        "comisionRed": comision,
        "walletTipo": tipo,
        "walletDesde": desde,
        "walletDestino": hacia,
        "hashTransaccion": movimiento.hash,
        "nota": nota,
    }


def filaDeComision(comision: ComisionPagada, activo: dict, alias: str) -> dict:
    """La fila de una comisión sin movimiento de la moneda de la red.

    Una fila «entre wallets» solo descuenta su comisión. `total` es la misma
    comisión y no cero porque todos los cálculos de posición (navegador,
    rendimiento y FIFO) saltan las filas sin cantidad.

    Args:
        comision: Comisión leída de la red.
        activo: `{"id", "name"}` de la moneda de la red.
        alias: Nombre de la wallet propia en Transacciones.
    """
    propio = alias or "Wallet enlazada"
    cantidad = textoDecimal(comision.comision)
    return {
        "id": f"{_PREFIJO_FILA}{_huella(comision.red, comision.hash, activo['id'])}",
        "assetId": activo["id"],
        "assetName": activo["name"],
        "fechaOperacion": comision.fecha.strftime("%d-%m-%Y"),
        "total": cantidad,
        "comisionRed": cantidad,
        "walletTipo": ENTRE_WALLETS,
        "walletDesde": propio,
        "walletDestino": propio,
        "hashTransaccion": comision.hash,
        "nota": f"Comisión de red de {propio}: la transacción no mueve esta moneda",
    }


def contraparteDeMovimiento(movimiento: MovimientoWallet) -> dict | None:
    """Lo que se apunta de una fila importada para poder reetiquetarla; None si no tiene contraparte."""
    if movimiento.tipo not in SENTIDOS or not movimiento.contraparte:
        return None
    contraparte = {"red": movimiento.red, "direccion": canonica(movimiento.red, movimiento.contraparte),
                   "sentido": movimiento.tipo}
    # Solo si puede hacer falta: al marcar después el origen como propio ya no se relee la red.
    if movimiento.comisionTx and reciboConComision(movimiento.red, movimiento.tipo, movimiento.contrato):
        contraparte["comisionTx"] = textoDecimal(movimiento.comisionTx)
    return contraparte


def _comisionDeOrigenPropio(contraparte: dict | None, entrada, marca) -> str:
    """La comisión de un recibo cuyo origen es del usuario; la marca de la transacción manda."""
    if contraparte is None or marca is not None or entrada is None or not entrada.propia:
        return ""
    return str(contraparte.get("comisionTx", ""))


def contraparteDeFila(fila: dict) -> dict | None:
    """La contraparte de una fila importada antes de existir la libreta, sacada de la propia fila.

    Entonces la contraparte iba tal cual en «Desde» o «Destino». La red no se
    guarda en la fila, pero el id es la huella de red, hash y activo: se prueba
    con cada red. Si el usuario editó el campo y ya no es una dirección, None.
    """
    filaId = str(fila.get("id", ""))
    sentido = fila.get("walletTipo")
    if not filaId.startswith(_PREFIJO_FILA) or sentido not in SENTIDOS:
        return None
    huella = filaId[len(_PREFIJO_FILA):]
    hashTx, assetId = str(fila.get("hashTransaccion", "")), str(fila.get("assetId", ""))
    red = next((r for r in REDES if _huella(r, hashTx, assetId) == huella), None)
    if red is None:
        return None
    try:
        direccion = normalizarDatoWallet(red, TIPO_DIRECCION, fila.get("walletDestino" if sentido == ENVIADA
                                                                       else "walletDesde", ""))
    except DatoWalletInvalido:
        return None
    return {"red": red, "direccion": direccion, "sentido": sentido}


def filaReetiquetada(fila: dict, contraparte: dict, libreta: Libreta) -> dict:
    """La fila con el tipo y el nombre de la contraparte que le da la libreta ahora.

    Solo toca el tipo y el lado de la contraparte: el de la wallet propia, la
    cantidad y la nota se quedan como estén.
    """
    entrada = libreta.buscar(contraparte["red"], contraparte["direccion"])
    marca = libreta.marcaDeFila(contraparte["red"], fila.get("hashTransaccion", ""), fila.get("assetId", ""))
    campo = "walletDestino" if contraparte["sentido"] == ENVIADA else "walletDesde"
    # Solo se pone en una fila sin comisión y se quita si sigue siendo la misma:
    # la que el usuario haya escrito a mano no se toca.
    comision = str(fila.get("comisionRed", "") or "").strip()
    propuesta = str(contraparte.get("comisionTx", ""))
    deOrigenPropio = _comisionDeOrigenPropio(contraparte, entrada, marca)
    if deOrigenPropio and not comision:
        comision = deOrigenPropio
    elif not deOrigenPropio and marca is None and propuesta and comision == propuesta:
        comision = ""
    return {**fila, "walletTipo": clasificarMovimiento(contraparte["sentido"], entrada, marca),
            "comisionRed": comision, campo: nombreContraparte(contraparte["direccion"], entrada)}


def filaConMarca(fila: dict, contraparte: dict | None, red: str, libreta: Libreta, sentido: str,
                 comisionLeida: str) -> dict:
    """La fila con el tipo y la comisión que le da la marca de su transacción, o la falta de ella.

    Args:
        fila: Fila de Transacciones de esa transacción.
        contraparte: Lo apuntado al importarla; None si es una fila escrita a mano.
        red: Red de la wallet.
        libreta: Libreta ya con la marca aplicada.
        sentido: Lo que leyó la red, para una fila sin contraparte apuntada.
        comisionLeida: Lo que leyó la red, para volver a ella al quitar la marca.
    """
    marca = libreta.marcaDeFila(red, fila.get("hashTransaccion", ""), fila.get("assetId", ""))
    if _contraparteValida(contraparte):
        base = filaReetiquetada({**fila, "comisionRed": ""}, contraparte, libreta)
    else:
        base = {**fila, "walletTipo": clasificarMovimiento(sentido, None, marca), "comisionRed": ""}
    return {**base, "comisionRed": comisionMarcada(marca) or comisionLeida or base["comisionRed"]}


def _contraparteValida(contraparte) -> bool:
    # Viene del fichero de wallets: una versión futura podría guardar otra forma.
    return (isinstance(contraparte, dict) and contraparte.get("red") in REDES
            and contraparte.get("sentido") in SENTIDOS and isinstance(contraparte.get("direccion"), str))


class SincronizadorWallets:
    """Servicio de importación. Todas las dependencias son inyectables para los tests."""

    def __init__(
        self,
        repositorio: WalletsRepository | None = None,
        fabricaLectores: Callable | None = None,
        leerActivos: Callable[[], list[dict]] = listarActivosCripto,
        leerStablecoins: Callable[[], list[str]] = lambda: readStablecoinsFile().get("enabledSymbols", []),
        leerTransacciones: Callable[[], dict] = readTransaccionesFile,
        escribirTransacciones: Callable = writeTransaccionesFile,
        revisionActual: Callable[[], int] = lambda: revisiones.actual("transacciones", revisiones.CLAVE_UNICA),
        maxMovimientos: Callable[[], int] = settings.walletsMaxMovimientos,
        leerTokensVerificados: Callable[[], list[TokenVerificado]] | None = None,
        leerMarcasToken: Callable[[], list[TokenMarcado]] | None = None,
        leerLibreta: Callable[[], Libreta] | None = None,
        leerTokensPublicos: Callable[[], list[TokenPublico]] = tokensPublicos,
    ) -> None:
        self._repositorio = repositorio or WalletsRepository()
        self._leerTokensPublicos = leerTokensPublicos
        # Por defecto, del mismo fichero que las wallets.
        self._leerTokensVerificados = leerTokensVerificados or self._repositorio.tokensVerificados
        self._leerMarcasToken = leerMarcasToken or self._repositorio.marcasToken
        self._leerLibreta = leerLibreta or (lambda: libretaDe(self._repositorio))
        self._fabricaLectores = fabricaLectores or lectorPara
        self._leerActivos = leerActivos
        self._leerStablecoins = leerStablecoins
        self._leerTransacciones = leerTransacciones
        self._escribirTransacciones = escribirTransacciones
        self._revisionActual = revisionActual
        self._maxMovimientos = maxMovimientos

    def sincronizar(self, walletId: str) -> ResultadoSincronizacion:
        """Lee la wallet e importa a Transacciones lo que no estuviera ya.

        Raises:
            WalletNoEncontrada: si la wallet no existe.
            ActivoDeWalletInexistente: si su activo no está en el portfolio activo.
            ErrorLecturaWallet: si la red no responde o responde un error.
        """
        wallet = self._repositorio.obtener(walletId)
        activos = self._leerActivos()
        nativo = next((a for a in activos if a["id"] == wallet.assetId), None)
        if nativo is None:
            raise ActivoDeWalletInexistente(
                "El activo de esta wallet no existe en el portfolio activo. Vuelve a enlazarla eligiendo uno."
            )
        limite = self._maxMovimientos()
        movimientos, comisiones = leerConComisiones(self._fabricaLectores(wallet.red), wallet.tipo, wallet.valor,
                                                    limite)
        resultado = self._importar(wallet, movimientos, comisiones, nativo, activos)
        # Sin importar lo anterior, la posición en Transacciones no cuadra con el
        # saldo de la red: hay que decirlo, no dar «N nuevos» como si fuera todo.
        if len(movimientos) >= limite:
            resultado.truncada, resultado.limite = True, limite
            resultado.desde = min(m.fecha for m in movimientos).strftime("%d-%m-%Y")
            log.warning("[wallets] Importación de %s limitada a %d movimientos", wallet.id, limite)
        self._repositorio.marcarSincronizada(wallet.id, ahoraIso())
        log.info("[wallets] Sincronizada %s (%s): %d nuevas, %d ya estaban",
                 wallet.id, wallet.red, resultado.anadidas, resultado.yaImportadas)
        return resultado

    def reetiquetar(self, red: str, direccion: str) -> int:
        """Aplica la libreta actual a las filas ya importadas cuya contraparte es esa dirección.

        Solo las de esa dirección: reetiquetarlas todas desharía los cambios que
        el usuario hubiera hecho a mano en filas que no tienen nada que ver.

        Returns:
            Cuántas filas han cambiado.

        Raises:
            ErrorLecturaWallet: si Transacciones cambia continuamente desde otro sitio.
        """
        clave = canonica(red, direccion)
        libreta = self._leerLibreta()
        conocidas = self._repositorio.contrapartesImportadas()
        for intento in range(_INTENTOS_ESCRITURA):
            revision = self._revisionActual()
            existentes = self._leerTransacciones().get("rows", [])
            aprendidas, filas, cambiadas = {}, [], 0
            for fila in existentes:
                filaId = str(fila.get("id", ""))
                contraparte = conocidas.get(filaId)
                if contraparte is None:
                    contraparte = contraparteDeFila(fila)
                    if contraparte is not None:
                        aprendidas[filaId] = contraparte
                if (_contraparteValida(contraparte) and contraparte["red"] == red
                        and contraparte["direccion"] == clave):
                    nueva = filaReetiquetada(fila, contraparte, libreta)
                    cambiadas += nueva != fila
                    fila = nueva
                filas.append(fila)
            # Antes de escribir: la fila reetiquetada ya no lleva la dirección en
            # «Desde» o «Destino» y sin esto no se podría volver a reetiquetar.
            self._repositorio.anotarContrapartes(aprendidas)
            conocidas.update(aprendidas)
            if not cambiadas:
                return 0
            try:
                self._escribirTransacciones({"rows": filas}, revisionEsperada=revision)
                log.info("[wallets] Reetiquetadas %d filas de Transacciones por la libreta", cambiadas)
                return cambiadas
            except revisiones.ConflictoRevision:
                log.info("[wallets] Transacciones cambiadas durante el reetiquetado; reintento %d", intento + 1)
        raise ErrorLecturaWallet("Las transacciones cambian continuamente desde otro sitio; vuelve a intentarlo")

    def activoDeMovimiento(self, wallet: Wallet, contrato: str, simbolo: str) -> str:
        """El activo al que se importa un movimiento de esa wallet; "" si no se importa."""
        if not contrato:
            return wallet.assetId
        activo = resolverActivoToken(simbolo, self._leerActivos(), self._leerStablecoins())
        return activo["id"] if activo else ""

    def aplicarMarca(self, red: str, hashTx: str, assetId: str, sentido: str, comisionLeida: str) -> int:
        """Aplica a la fila ya importada de una transacción la marca que tenga ahora.

        Si aún no se ha importado no hay nada que hacer: `filaDeMovimiento` mira
        la marca al importarla.

        Args:
            red: Red de la transacción.
            hashTx: Hash de la transacción.
            assetId: Activo de la fila.
            sentido: Tipo leído de la red (`ENVIADA` o `RECIBIDA`).
            comisionLeida: Comisión leída de la red, la de la fila si no hay marca.

        Returns:
            Cuántas filas han cambiado.

        Raises:
            ErrorLecturaWallet: si Transacciones cambia continuamente desde otro sitio.
        """
        clave = (str(hashTx).lower(), assetId)
        libreta = self._leerLibreta()
        conocidas = self._repositorio.contrapartesImportadas()
        for intento in range(_INTENTOS_ESCRITURA):
            revision = self._revisionActual()
            filas, cambiadas = [], 0
            for fila in self._leerTransacciones().get("rows", []):
                if (str(fila.get("hashTransaccion", "")).lower(), fila.get("assetId", "")) == clave:
                    filaId = str(fila.get("id", ""))
                    contraparte = conocidas.get(filaId)
                    if contraparte is None:
                        contraparte = contraparteDeFila(fila)
                        if contraparte is not None:
                            # Sin esto, una fila antigua ya marcada no podría volver atrás.
                            self._repositorio.anotarContrapartes({filaId: contraparte})
                            conocidas[filaId] = contraparte
                    nueva = filaConMarca(fila, contraparte, red, libreta, sentido, comisionLeida)
                    cambiadas += nueva != fila
                    fila = nueva
                filas.append(fila)
            if not cambiadas:
                return 0
            try:
                self._escribirTransacciones({"rows": filas}, revisionEsperada=revision)
                return cambiadas
            except revisiones.ConflictoRevision:
                log.info("[wallets] Transacciones cambiadas al aplicar una marca; reintento %d", intento + 1)
        raise ErrorLecturaWallet("Las transacciones cambian continuamente desde otro sitio; vuelve a intentarlo")

    def _filas(self, wallet: Wallet, movimientos: list[MovimientoWallet], nativo: dict,
               activos: list[dict]) -> tuple[list[dict], dict[str, int]]:
        simboloNativo = REDES[wallet.red].simbolo
        stablecoins = None
        # Solo se descifra la lista si hay algún token entre los movimientos.
        hayTokens = any(m.contrato for m in movimientos)
        indice = indiceVerificados(self._leerTokensVerificados()) if hayTokens else {}
        marcas = indiceMarcas(self._leerMarcasToken()) if hayTokens else {}
        publicos = indicePublico(self._leerTokensPublicos()) if hayTokens else None
        libreta = self._leerLibreta()
        contrapartes = {}
        filas, sinActivo = [], {}
        for movimiento in movimientos:
            clave = movimiento.simbolo
            if not movimiento.contrato:
                activo = {"id": nativo["id"], "name": nativo["name"]}
            elif movimiento.simbolo == simboloNativo:
                # Un token que se hace llamar como la moneda nativa es una
                # imitación (los de spam lo hacen a propósito): no se suma a ella.
                # Ni aunque el usuario lo marque legítimo: un token no es la
                # moneda de la red, sea lo que sea.
                activo, clave = None, f"{movimiento.simbolo} (token)"
            elif estadoToken(wallet.red, movimiento.simbolo, movimiento.contrato, indice, marcas,
                             publicos) == IMITACION:
                activo, clave = None, f"{movimiento.simbolo} (imitación)"
            else:
                if stablecoins is None:
                    stablecoins = self._leerStablecoins()
                activo = resolverActivoToken(movimiento.simbolo, activos, stablecoins)
            if activo is None:
                sinActivo[clave] = sinActivo.get(clave, 0) + 1
                continue
            # El seguimiento («Ledger»), no la dirección suelta: en Transacciones
            # todas las direcciones de una misma wallet son la misma wallet.
            fila = filaDeMovimiento(movimiento, activo, wallet.nombreSeguimiento, libreta)
            filas.append(fila)
            contraparte = contraparteDeMovimiento(movimiento)
            if contraparte is not None:
                contrapartes[fila["id"]] = contraparte
        # Antes de escribir las filas: con apodo ya no llevan la dirección y,
        # sin esto, no se podrían reetiquetar. Las de filas que al final no se
        # añaden (ya estaban) tienen el mismo id y no sobran.
        self._repositorio.anotarContrapartes(contrapartes)
        return filas, sinActivo

    def _importar(self, wallet: Wallet, movimientos: list[MovimientoWallet], comisiones: list[ComisionPagada],
                  nativo: dict, activos: list[dict]) -> ResultadoSincronizacion:
        nuevas, sinActivo = self._filas(wallet, movimientos, nativo, activos)
        # Detrás de las filas de movimientos: si una transacción saliese en las
        # dos listas, se queda la de su movimiento.
        activoNativo = {"id": nativo["id"], "name": nativo["name"]}
        nuevas += [filaDeComision(c, activoNativo, wallet.nombreSeguimiento) for c in comisiones]
        for intento in range(_INTENTOS_ESCRITURA):
            revision = self._revisionActual()
            existentes = self._leerTransacciones().get("rows", [])
            filasActuales = list(existentes)
            vistas = {(str(f.get("hashTransaccion", "")).lower(), f.get("assetId", "")): i
                      for i, f in enumerate(filasActuales)}
            ids = {f.get("id") for f in existentes}
            anadir = []
            completadas = 0
            for fila in nuevas:
                clave = (fila["hashTransaccion"].lower(), fila["assetId"])
                if clave in vistas or fila["id"] in ids:
                    # Entre dos wallets propias, si se importó primero la que
                    # recibe la fila no lleva comisión: la trae la que envió.
                    indice = vistas.get(clave)
                    if (indice is not None and fila["comisionRed"]
                            and not str(filasActuales[indice].get("comisionRed", "")).strip()):
                        filasActuales[indice] = {**filasActuales[indice], "comisionRed": fila["comisionRed"]}
                        completadas += 1
                    continue
                vistas[clave] = None
                ids.add(fila["id"])
                anadir.append(fila)
            resultado = ResultadoSincronizacion(
                anadidas=len(anadir), yaImportadas=len(nuevas) - len(anadir), sinActivo=sinActivo, revision=revision,
            )
            if not anadir and not completadas:
                return resultado
            try:
                resultado.revision = self._escribirTransacciones({"rows": [*filasActuales, *anadir]},
                                                                 revisionEsperada=revision)
                return resultado
            except revisiones.ConflictoRevision:
                log.info("[wallets] Transacciones cambiadas durante la importación; reintento %d", intento + 1)
        raise ErrorLecturaWallet("Las transacciones cambian continuamente desde otro sitio; vuelve a intentarlo")
