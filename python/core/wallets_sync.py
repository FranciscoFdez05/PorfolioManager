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

Desde la pantalla, de una fila importada solo se cambia la nota, y solo se borra
si ya no queda una wallet propia en su red (`protegerFilasImportadas`).

La libreta de direcciones (`core.wallets_libreta`) decide si un envío o un
recibo es en realidad entre wallets propias y qué nombre lleva la contraparte.
Cada fila importada deja apuntada su contraparte en el fichero de wallets: así,
al marcar después esa dirección, `reetiquetar` corrige las filas que ya estaban.

Una transacción también se marca por separado (`aplicarMarca`). Lo comprado en un
exchange y pasado a la wallet fría ya está en la posición por la compra: como
«entre wallets» no vuelve a sumar y solo descuenta su comisión.

Las entradas de dinero de terceros no se importan hasta que el usuario las verifica
con esa misma marca: se cuentan en `pendientes` y se quedan en Seguimiento. Así la
posición nunca incluye dinero sin confirmar. Una fila importada que pierde su
verificación (al quitar la marca) y las «recibida» de antes de existir la verificación
(migración 27 de `core.db`) quedan con tipo `PENDIENTE`: siguen a la vista y no suman.
"""

import hashlib
import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal, InvalidOperation

from core import settings
from core.cripto_direcciones import REDES, TIPO_DIRECCION, DatoWalletInvalido, normalizarDatoWallet
from core.wallets_libreta import (
    PENDIENTE,
    SENTIDOS,
    Libreta,
    canonica,
    clasificarMovimiento,
    comisionMarcada,
    libretaDe,
    nombreContraparte,
    pendienteDeVerificar,
    reciboConComision,
)
from core.wallets_tokens import IMITACION, estadoToken, indiceMarcas, indicePublico, indiceVerificados
from providers.blockchain_clients import (
    ENTRE_WALLETS,
    ENVIADA,
    RECIBIDA,
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
    # Entradas de dinero sin importar porque el usuario aún no las ha verificado.
    pendientes: int = 0

    def comoDict(self) -> dict:
        datos = {
            "anadidas": self.anadidas,
            "yaImportadas": self.yaImportadas,
            "sinActivo": dict(sorted(self.sinActivo.items())),
            "revision": self.revision,
        }
        if self.pendientes:
            datos["pendientes"] = self.pendientes
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
        decisiva = libreta.paraClasificar(movimiento.red, contraparte, movimiento.contrapartes)
        marca = libreta.marcaDe(movimiento.red, movimiento.hash, movimiento.contrato)
        tipo, contraparte = clasificarMovimiento(tipo, decisiva, marca), nombreContraparte(contraparte, entrada)
        comision = comisionMarcada(marca) or comision or _comisionDeOrigenPropio(
            contraparteDeMovimiento(movimiento), decisiva, marca)
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
    if movimiento.comisionTx and reciboConComision(movimiento.tipo, movimiento.contrato):
        contraparte["comisionTx"] = textoDecimal(movimiento.comisionTx)
    if len(movimiento.contrapartes) > 1:
        contraparte["todas"] = [canonica(movimiento.red, d) for d in movimiento.contrapartes]
    return contraparte


def movimientoDeGuardado(red: str, guardado: dict) -> MovimientoWallet:
    """El movimiento de un `recientes` guardado (`movimientoComoDict`), para importarlo sin releer la red.

    Args:
        red: Red de la wallet (el dict no la lleva).
        guardado: Movimiento tal como se guardó, sin la libreta aplicada.

    Raises:
        ValueError: si la fecha o una cantidad no tienen la forma esperada.
        KeyError: si falta un campo obligatorio.
    """
    comision, comisionTx = guardado.get("comision"), guardado.get("comisionTx")
    try:
        return MovimientoWallet(
            red=red, hash=guardado["hash"], fecha=datetime.fromisoformat(guardado["fecha"]),
            simbolo=guardado["simbolo"], cantidad=Decimal(guardado["cantidad"]),
            comision=Decimal(comision) if comision else None, tipo=guardado["tipo"],
            contraparte=guardado.get("contraparte", ""), contrato=guardado.get("contrato", ""),
            comisionTx=Decimal(comisionTx) if comisionTx else None, propia=guardado.get("propia", ""),
            contrapartes=tuple(guardado.get("contrapartes", ())),
        )
    except InvalidOperation as error:
        raise ValueError("Cantidad no válida en un movimiento guardado") from error


def hashesImportados(filas: list[dict]) -> set[str]:
    """Los hashes, en minúsculas, que ya tienen en Transacciones una fila que cuenta.

    Una fila pendiente no vale: esa transacción sigue por verificar.
    """
    return {str(fila.get("hashTransaccion", "")).lower() for fila in filas
            if fila.get("hashTransaccion") and fila.get("walletTipo") != PENDIENTE}


def esFilaImportada(fila: dict) -> bool:
    """Si la fila salió de la blockchain y no la escribió el usuario."""
    return str(fila.get("id", "")).startswith(_PREFIJO_FILA)


def redesConWalletPropia(repositorio: WalletsRepository | None = None) -> set[str]:
    """Las redes en las que queda alguna wallet propia enlazada.

    Sin poder leer las wallets (otra `SECRET_KEY`, fichero dañado) se devuelven
    todas: es preferible no dejar borrar a borrar lo que la red no devolvería.

    Args:
        repositorio: Repositorio de wallets; por defecto, el real.

    Returns:
        Los identificadores de esas redes.
    """
    try:
        wallets = (repositorio or WalletsRepository()).listar()
    except WalletError as error:
        log.warning("[wallets] No se pudieron leer las wallets para proteger Transacciones: %s", error)
        return set(REDES)
    return {wallet.red for wallet in wallets if wallet.propia}


def filaProtegidaDeBorrado(fila: dict, redesEnlazadas: set[str]) -> bool:
    """Si una fila importada no se puede borrar porque aún se lee de una wallet enlazada.

    Borrarla no serviría: la siguiente sincronización la trae de vuelta, o cambia la
    posición para siempre si la red ya no la devuelve. Sin wallet en su red sí se
    puede: es la salida cuando se enlazó una wallet por error, y desenlazarla deja
    aquí sus filas.

    La red sale de la huella del id. Una fila cuyo hash se editó antes de existir esta
    protección ya no la revela, y se protege mientras quede alguna wallet.

    Args:
        fila: Fila de Transacciones.
        redesEnlazadas: Resultado de `redesConWalletPropia`.

    Returns:
        True si hay que conservarla; False si se puede borrar o no es importada.
    """
    if not esFilaImportada(fila):
        return False
    huella = str(fila.get("id", ""))[len(_PREFIJO_FILA):]
    hashTx, assetId = str(fila.get("hashTransaccion", "")), str(fila.get("assetId", ""))
    red = next((r for r in REDES if _huella(r, hashTx, assetId) == huella), None)
    return bool(redesEnlazadas) if red is None else red in redesEnlazadas


def protegerFilasImportadas(pedidas: list[dict], actuales: list[dict],
                            redesEnlazadas: set[str]) -> tuple[list[dict], int]:
    """Lo que se puede guardar de una lista de filas enviada desde la pantalla.

    De una fila importada que ya existe solo se acepta la nota: lo demás lo dice la
    blockchain, y la comisión del exchange y la clasificación se cambian marcando la
    transacción (`POST /api/wallets/<id>/movimientos/marcar`), que deja constancia.
    Una pestaña desfasada tampoco puede así deshacer una marca hecha desde otro sitio.

    Args:
        pedidas: Filas ya saneadas de la petición.
        actuales: Filas guardadas ahora mismo.
        redesEnlazadas: Resultado de `redesConWalletPropia`.

    Returns:
        Las filas a guardar y cuántas importadas se han conservado aunque faltaban
        en la petición, que van al final.
    """
    importadas = {fila["id"]: fila for fila in actuales if esFilaImportada(fila)}
    pedidasIds = {fila["id"] for fila in pedidas}
    filas = [{**importadas[fila["id"]], "nota": fila.get("nota", "")} if fila["id"] in importadas else fila
             for fila in pedidas]
    conservadas = [fila for filaId, fila in importadas.items()
                   if filaId not in pedidasIds and filaProtegidaDeBorrado(fila, redesEnlazadas)]
    return [*filas, *conservadas], len(conservadas)


def _tipoSegunVerificacion(tipo: str, sentido: str, marca, verificarEntradas: bool, tipoActual: str = "") -> str:
    """El tipo de una fila importada: una entrada sin verificar se queda en `PENDIENTE`.

    Una fila que ya es «recibida» sin marca la ha dado por buena el usuario en
    Transacciones: un cambio en la libreta no se lo deshace.
    """
    if not verificarEntradas or tipoActual == RECIBIDA or not pendienteDeVerificar(sentido, tipo, marca):
        return tipo
    return PENDIENTE


def _comisionDeOrigenPropio(contraparte: dict | None, entrada, marca) -> str:
    """La comisión de un recibo cuyo origen es del usuario; marcar la transacción como ajena la anula."""
    if contraparte is None or entrada is None or not entrada.propia:
        return ""
    if marca is not None and not marca.propia:
        return ""
    return str(contraparte.get("comisionTx", ""))


def contraparteDeFila(fila: dict) -> dict | None:
    """La contraparte de una fila importada antes de existir la libreta, sacada de la propia fila.

    Entonces la contraparte iba tal cual en «Desde» o «Destino». La red no se
    guarda en la fila, pero el id es la huella de red, hash y activo: se prueba
    con cada red. Si el usuario editó el campo y ya no es una dirección, None.
    """
    filaId = str(fila.get("id", ""))
    # Una pendiente siempre es un recibo: solo las entradas esperan verificación.
    sentido = RECIBIDA if fila.get("walletTipo") == PENDIENTE else fila.get("walletTipo")
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


def filaReetiquetada(fila: dict, contraparte: dict, libreta: Libreta, verificarEntradas: bool = False) -> dict:
    """La fila con el tipo y el nombre de la contraparte que le da la libreta ahora.

    Solo toca el tipo y el lado de la contraparte: el de la wallet propia, la
    cantidad y la nota se quedan como estén.

    Args:
        fila: Fila importada de Transacciones.
        contraparte: Lo apuntado al importarla.
        libreta: Libreta vigente.
        verificarEntradas: Si una entrada sin marca debe quedar en `PENDIENTE`.
    """
    entrada = libreta.buscar(contraparte["red"], contraparte["direccion"])
    decisiva = libreta.paraClasificar(contraparte["red"], contraparte["direccion"], contraparte.get("todas", ()))
    marca = libreta.marcaDeFila(contraparte["red"], fila.get("hashTransaccion", ""), fila.get("assetId", ""))
    campo = "walletDestino" if contraparte["sentido"] == ENVIADA else "walletDesde"
    # Solo se pone en una fila sin comisión y se quita si sigue siendo la misma:
    # la que el usuario haya escrito a mano no se toca.
    comision = str(fila.get("comisionRed", "") or "").strip()
    propuesta = str(contraparte.get("comisionTx", ""))
    deOrigenPropio = _comisionDeOrigenPropio(contraparte, decisiva, marca)
    if deOrigenPropio and not comision:
        comision = deOrigenPropio
    elif not deOrigenPropio and not comisionMarcada(marca) and propuesta and comision == propuesta:
        comision = ""
    tipo = _tipoSegunVerificacion(clasificarMovimiento(contraparte["sentido"], decisiva, marca),
                                  contraparte["sentido"], marca, verificarEntradas, fila.get("walletTipo", ""))
    return {**fila, "walletTipo": tipo, "comisionRed": comision,
            campo: nombreContraparte(contraparte["direccion"], entrada)}


def filaConMarca(fila: dict, contraparte: dict | None, red: str, libreta: Libreta, sentido: str,
                 comisionLeida: str, verificarEntradas: bool = False) -> dict:
    """La fila con el tipo y la comisión que le da la marca de su transacción, o la falta de ella.

    Args:
        fila: Fila de Transacciones de esa transacción.
        contraparte: Lo apuntado al importarla; None si es una fila escrita a mano.
        red: Red de la wallet.
        libreta: Libreta ya con la marca aplicada.
        sentido: Lo que leyó la red, para una fila sin contraparte apuntada.
        comisionLeida: Lo que leyó la red, para volver a ella al quitar la marca.
        verificarEntradas: Si una entrada importada sin marca debe quedar en `PENDIENTE`.
    """
    marca = libreta.marcaDeFila(red, fila.get("hashTransaccion", ""), fila.get("assetId", ""))
    if _contraparteValida(contraparte):
        # El tipo de antes no vale: al quitar la marca, la fila pierde lo que la hacía contar.
        base = filaReetiquetada({**fila, "comisionRed": "", "walletTipo": PENDIENTE}, contraparte, libreta,
                                verificarEntradas)
    else:
        # Una fila escrita a mano la ha verificado quien la escribió.
        importada = str(fila.get("id", "")).startswith(_PREFIJO_FILA)
        tipo = _tipoSegunVerificacion(clasificarMovimiento(sentido, None, marca), sentido, marca,
                                      verificarEntradas and importada)
        base = {**fila, "walletTipo": tipo, "comisionRed": ""}
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
        verificarEntradas: bool = True,
    ) -> None:
        self._repositorio = repositorio or WalletsRepository()
        self._leerTokensPublicos = leerTokensPublicos
        self._verificarEntradas = verificarEntradas
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

    def importarVerificado(self, wallet: Wallet, hashTx: str, contrato: str) -> int | None:
        """Importa un movimiento recién verificado sin volver a leer la red.

        Con una xpub, releerla son decenas de llamadas por algo que ya está
        guardado en `recientes`.

        Args:
            wallet: Wallet del movimiento.
            hashTx: Hash de la transacción.
            contrato: Contrato del token; "" en la moneda de la red.

        Returns:
            Filas añadidas, o None si no está en `recientes`: lo importará la
            próxima sincronización, que ya respeta la marca.

        Raises:
            ActivoDeWalletInexistente: si su activo no está en el portfolio activo.
            ErrorLecturaWallet: si Transacciones cambia continuamente desde otro sitio.
        """
        if hashTx.lower() in hashesImportados(self._leerTransacciones().get("rows", [])):
            return 0
        guardado = next((m for m in wallet.recientes
                         if m.get("hash") == hashTx and m.get("contrato", "") == contrato), None)
        if guardado is None:
            return None
        try:
            movimiento = movimientoDeGuardado(wallet.red, guardado)
        except (KeyError, ValueError, TypeError) as error:
            log.warning("[wallets] Movimiento guardado no válido en %s: %s", wallet.id, error)
            return None
        activos = self._leerActivos()
        nativo = next((a for a in activos if a["id"] == wallet.assetId), None)
        if nativo is None:
            raise ActivoDeWalletInexistente(
                "El activo de esta wallet no existe en el portfolio activo. Vuelve a enlazarla eligiendo uno."
            )
        return self._importar(wallet, [movimiento], [], nativo, activos).anadidas

    def reetiquetar(self, red: str, direccion: str) -> int:
        """Aplica la libreta actual a las filas ya importadas cuya contraparte es esa dirección.

        Solo las de esa dirección: reetiquetarlas todas desharía los cambios que
        el usuario hubiera hecho a mano en filas que no tienen nada que ver.

        Returns:
            Cuántas filas han cambiado.

        Raises:
            ErrorLecturaWallet: si Transacciones cambia continuamente desde otro sitio.
        """
        return self.reetiquetarVarias(red, [direccion])

    def reetiquetarVarias(self, red: str, direcciones: Iterable[str]) -> int:
        """Como `reetiquetar`, de una sola escritura, para las direcciones de una xpub o una clave.

        Args:
            red: Red de las direcciones.
            direcciones: Direcciones que acaban de cambiar en la libreta.

        Returns:
            Cuántas filas han cambiado.

        Raises:
            ErrorLecturaWallet: si Transacciones cambia continuamente desde otro sitio.
        """
        claves = {canonica(red, direccion) for direccion in direcciones}
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
                        and claves & {contraparte["direccion"], *contraparte.get("todas", ())}):
                    nueva = filaReetiquetada(fila, contraparte, libreta, self._verificarEntradas)
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

    def completarComisiones(self) -> int:
        """Pone la comisión a las filas «entre wallets» sin ella cuyo origen es del usuario.

        Para las filas importadas antes de apuntar esa comisión: lo apuntado de
        ellas no la lleva, así que ni marcar ni reetiquetar pueden ponérsela. Sale
        de los `recientes` guardados, sin leer la red. No añade filas, y una
        comisión ya escrita (también un «0») no se toca.

        Returns:
            Cuántas filas han cambiado.

        Raises:
            ErrorLecturaWallet: si Transacciones cambia continuamente desde otro sitio.
        """
        propuestas = self._comisionesDeRecientes()
        if not propuestas:
            return 0
        for intento in range(_INTENTOS_ESCRITURA):
            revision = self._revisionActual()
            filas, contrapartes = [], {}
            for fila in self._leerTransacciones().get("rows", []):
                propuesta = propuestas.get((str(fila.get("hashTransaccion", "")).lower(), fila.get("assetId", "")))
                if (propuesta is not None and fila.get("walletTipo") == ENTRE_WALLETS
                        and not str(fila.get("comisionRed", "") or "").strip()):
                    fila = {**fila, "comisionRed": propuesta["comisionTx"]}
                    contrapartes[str(fila.get("id", ""))] = propuesta
                filas.append(fila)
            if not contrapartes:
                return 0
            # Antes de escribir, como al reetiquetar: si el origen deja de ser
            # propio, la fila tiene que poder perder esta comisión.
            self._repositorio.anotarContrapartes(contrapartes)
            try:
                self._escribirTransacciones({"rows": filas}, revisionEsperada=revision)
                log.info("[wallets] Completada la comisión de %d filas de Transacciones", len(contrapartes))
                return len(contrapartes)
            except revisiones.ConflictoRevision:
                log.info("[wallets] Transacciones cambiadas al completar comisiones; reintento %d", intento + 1)
        raise ErrorLecturaWallet("Las transacciones cambian continuamente desde otro sitio; vuelve a intentarlo")

    def _comisionesDeRecientes(self) -> dict[tuple[str, str], dict]:
        """(hash en minúsculas, activo) → contraparte con `comisionTx`, de los recibos con origen propio."""
        libreta = self._leerLibreta()
        propuestas = {}
        for wallet in self._repositorio.listar():
            if not wallet.propia:
                continue
            for guardado in wallet.recientes:
                try:
                    movimiento = movimientoDeGuardado(wallet.red, guardado)
                except (KeyError, ValueError, TypeError) as error:
                    log.warning("[wallets] Movimiento guardado no válido en %s: %s", wallet.id, error)
                    continue
                contraparte = contraparteDeMovimiento(movimiento)
                decisiva = libreta.paraClasificar(movimiento.red, movimiento.contraparte, movimiento.contrapartes)
                marca = libreta.marcaDe(movimiento.red, movimiento.hash, movimiento.contrato)
                if not movimiento.contrato and _comisionDeOrigenPropio(contraparte, decisiva, marca):
                    propuestas[(movimiento.hash.lower(), wallet.assetId)] = contraparte
        return propuestas

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
                    nueva = filaConMarca(fila, contraparte, red, libreta, sentido, comisionLeida,
                                         self._verificarEntradas)
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

    def _esPendiente(self, movimiento: MovimientoWallet, libreta: Libreta) -> bool:
        if not self._verificarEntradas:
            return False
        marca = libreta.marcaDe(movimiento.red, movimiento.hash, movimiento.contrato)
        decisiva = libreta.paraClasificar(movimiento.red, movimiento.contraparte, movimiento.contrapartes)
        return pendienteDeVerificar(movimiento.tipo, clasificarMovimiento(movimiento.tipo, decisiva, marca), marca)

    def _filas(self, wallet: Wallet, movimientos: list[MovimientoWallet], nativo: dict,
               activos: list[dict]) -> tuple[list[dict], dict[str, int], int]:
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
        pendientes = 0
        importados = hashesImportados(self._leerTransacciones().get("rows", []))
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
            if self._esPendiente(movimiento, libreta):
                # Una «recibida» con fila ya la dio por buena el usuario: no está pendiente.
                pendientes += movimiento.hash.lower() not in importados
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
        return filas, sinActivo, pendientes

    def _importar(self, wallet: Wallet, movimientos: list[MovimientoWallet], comisiones: list[ComisionPagada],
                  nativo: dict, activos: list[dict]) -> ResultadoSincronizacion:
        nuevas, sinActivo, pendientes = self._filas(wallet, movimientos, nativo, activos)
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
                    # Si ha llegado hasta aquí es que ya no espera verificación: la
                    # migración no pudo ver las marcas, que están en otro fichero.
                    if indice is not None and filasActuales[indice].get("walletTipo") == PENDIENTE:
                        filasActuales[indice] = {**filasActuales[indice], "walletTipo": fila["walletTipo"]}
                        completadas += 1
                    continue
                vistas[clave] = None
                ids.add(fila["id"])
                anadir.append(fila)
            resultado = ResultadoSincronizacion(
                anadidas=len(anadir), yaImportadas=len(nuevas) - len(anadir), sinActivo=sinActivo, revision=revision,
                pendientes=pendientes,
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
