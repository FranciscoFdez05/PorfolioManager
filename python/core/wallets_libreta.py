"""Libreta de direcciones: qué contrapartes son del usuario y cómo se llaman.

Los lectores de cada red solo saben que un movimiento es «entre wallets» cuando
las dos direcciones son de la misma wallet (la misma xpub, la misma dirección).
Un envío a otra wallet del usuario sale como «enviada», y en Transacciones y en
la cartera resta lo que en realidad solo ha cambiado de sitio. La libreta lo
corrige:

* **Manual.** El usuario marca una dirección como suya o ajena y le pone un
  apodo (`stores.wallets_store.DireccionMarcada`).
* **Automática.** Las direcciones de las wallets propias enlazadas cuentan como
  propias sin marcarlas, con el nombre de su seguimiento. De una clave pública,
  todas las que puede tener; de una xpub, las que ya tienen uso, que la vigilancia
  va guardando en `Wallet.direccionesDerivadas`.

* **Por transacción.** Una marca sobre una transacción concreta
  (`stores.wallets_store.MovimientoMarcado`) manda sobre las de su dirección: el
  retiro de un exchange a la wallet fría es «entre wallets» aunque la dirección
  del exchange no sea del usuario.

Una marca manual manda sobre la automática. Un movimiento hacia o desde una
dirección propia pasa a «entre wallets»; marcarla ajena lo deja como estaba. Si
una transacción tiene varias contrapartes, solo lo es cuando todas son propias.

Una entrada de dinero de terceros no cuenta hasta que el usuario la verifica con
una marca (`pendienteDeVerificar`): nada en la red dice si es un ingreso real o
algo ya comprado en un exchange.

Este módulo solo clasifica: no lee ficheros ni redes, para que lo usen igual la
pantalla, los avisos y la importación.
"""

import logging
from collections.abc import Iterable
from dataclasses import dataclass, replace
from functools import lru_cache

from core.cripto_direcciones import (
    TIPO_CLAVE_PUBLICA,
    TIPO_DIRECCION,
    TIPO_XPUB,
    DatoWalletInvalido,
    clavesP2pk,
    direccionesDeClavePublica,
    normalizarDatoWallet,
)
from providers.blockchain_clients import ENTRE_WALLETS, ENVIADA, RECIBIDA, MovimientoWallet
from stores.wallets_store import DireccionMarcada, MovimientoMarcado, Wallet, WalletsRepository

log = logging.getLogger(__name__)

MARCA_PROPIA = "propia"
MARCA_AJENA = "ajena"
# Solo estos tienen una contraparte que reclasificar: un «entre wallets» de la
# propia red ya es entre direcciones del usuario.
SENTIDOS = (ENVIADA, RECIBIDA)
# Tipo de una fila importada de Transacciones que espera verificación. Sigue a la
# vista, pero los cálculos de posición solo aceptan los tres tipos de la red: no suma.
PENDIENTE = "pendiente"


@dataclass(frozen=True)
class EntradaLibreta:
    """Lo que la libreta sabe de una dirección.

    `enlazada` distingue las que vienen de una wallet propia enlazada (no se
    editan en la libreta: se cambian enlazando o desenlazando la wallet).
    """

    red: str
    direccion: str
    apodo: str
    propia: bool
    enlazada: bool = False

    @property
    def marca(self) -> str:
        return MARCA_PROPIA if self.propia else MARCA_AJENA


@lru_cache(maxsize=4096)
def canonica(red: str, direccion: str) -> str:
    """La dirección en la forma en que se guarda, para compararla.

    Lo que no es una dirección válida de la red (un contrato raro, un texto
    editado a mano) se compara tal cual: no se marca, pero tampoco falla.
    Cacheada porque el historial pregunta por las mismas contrapartes una y otra vez.

    Example:
        >>> canonica("eth", "0xABCDEF0123456789ABCDEF0123456789ABCDEF01")
        '0xabcdef0123456789abcdef0123456789abcdef01'
    """
    texto = str(direccion or "").strip()
    try:
        return normalizarDatoWallet(red, TIPO_DIRECCION, texto)
    except DatoWalletInvalido:
        return texto


class Libreta:
    """Índice (red, dirección) → `EntradaLibreta`; la última entrada de una dirección manda.

    Args:
        entradas: Entradas en orden de prioridad creciente.
        marcas: Transacciones marcadas una a una.
    """

    def __init__(self, entradas: Iterable[EntradaLibreta] = (), marcas: Iterable[MovimientoMarcado] = ()) -> None:
        self._indice = {(e.red, e.direccion): e for e in entradas}
        marcas = list(marcas)
        self._marcas = {(m.red, m.hash, m.contrato): m for m in marcas}
        # Las filas de Transacciones no guardan el contrato sino el activo, y
        # comparan el hash sin distinguir mayúsculas, como al importar.
        self._marcasFila = {(m.red, m.hash.lower(), m.assetId): m for m in marcas if m.assetId}

    @classmethod
    def desde(cls, direcciones: Iterable[DireccionMarcada], wallets: Iterable[Wallet],
              marcas: Iterable[MovimientoMarcado] = ()) -> "Libreta":
        """La libreta de las direcciones marcadas más las de las wallets propias enlazadas.

        Args:
            direcciones: `WalletsRepository.direcciones()`.
            wallets: `WalletsRepository.listar()`.
            marcas: `WalletsRepository.movimientosMarcados()`.
        """
        # Primero las enlazadas, para que una marca manual de la misma dirección las sustituya.
        enlazadas = [
            EntradaLibreta(w.red, destino, w.nombreSeguimiento, propia=True, enlazada=True)
            for w in wallets for destino in destinosDeWallet(w)
        ]
        manuales = [EntradaLibreta(d.red, d.direccion, d.apodo, d.propia) for d in direcciones]
        return cls([*enlazadas, *manuales], marcas)

    def buscar(self, red: str, direccion: str) -> EntradaLibreta | None:
        """La entrada de esa dirección, o None si la libreta no sabe nada de ella."""
        if not direccion:
            return None
        return self._indice.get((red, canonica(red, direccion)))

    def paraClasificar(self, red: str, contraparte: str, todas: Iterable[str] = ()) -> EntradaLibreta | None:
        """La entrada que decide el tipo de un movimiento con esas contrapartes.

        Con una mezcla de propias y de terceros no vale ninguna: tratarla como
        «entre wallets» escondería el dinero que sí ha entrado o salido.

        Args:
            red: Red del movimiento.
            contraparte: La contraparte principal del movimiento.
            todas: Todas las contrapartes de la transacción, si hay más de una.

        Returns:
            La entrada de `contraparte`, o None si no se sabe o hay una mezcla.
        """
        entrada = self.buscar(red, contraparte)
        if entrada is None or not entrada.propia:
            return entrada
        for otra in todas:
            otraEntrada = self.buscar(red, otra)
            if otraEntrada is None or not otraEntrada.propia:
                return None
        return entrada

    def direccionesDe(self, red: str) -> set[str]:
        """Las direcciones que la libreta conoce en una red, canónicas, propias o ajenas."""
        return {direccion for (redEntrada, direccion) in self._indice if redEntrada == red}

    def marcaDe(self, red: str, hashTx: str, contrato: str = "") -> MovimientoMarcado | None:
        """La marca de una transacción tal como la leyó la red, o None."""
        return self._marcas.get((red, hashTx, contrato))

    def marcaDeFila(self, red: str, hashTx: str, assetId: str) -> MovimientoMarcado | None:
        """La marca de una fila de Transacciones, o None."""
        return self._marcasFila.get((red, str(hashTx or "").lower(), assetId))


def libretaDe(repositorio: WalletsRepository) -> Libreta:
    """La libreta vigente de un repositorio.

    Raises:
        WalletError: si el fichero no se puede leer.
    """
    return Libreta.desde(repositorio.direcciones(), repositorio.listar(), repositorio.movimientosMarcados())


@lru_cache(maxsize=256)
def _direccionesDeClave(claveHex: str) -> tuple[str, ...]:
    # Cacheada: derivar son varias multiplicaciones en la curva y la libreta se
    # monta en cada listado de wallets.
    return tuple(direccionesDeClavePublica(claveHex))


def direccionesDeWallet(wallet: Wallet) -> list[str]:
    """Las direcciones que esta wallet enlazada aporta a la libreta; ninguna si es ajena.

    Args:
        wallet: Wallet enlazada.

    Returns:
        Su dirección; todas las de su clave pública; o las ya usadas de su xpub.
    """
    if not wallet.propia:
        return []
    if wallet.tipo == TIPO_DIRECCION:
        return [wallet.valor]
    if wallet.tipo == TIPO_XPUB:
        return list(wallet.direccionesDerivadas)
    if wallet.tipo != TIPO_CLAVE_PUBLICA:
        return []
    try:
        return list(_direccionesDeClave(wallet.valor))
    except DatoWalletInvalido as error:
        # Se validó al enlazarla: solo puede venir de una copia dañada o editada.
        log.warning("[wallets] Clave pública no válida en %s: %s", wallet.id, error)
        return []


def destinosDeWallet(wallet: Wallet) -> list[str]:
    """Todo lo que puede aparecer como contraparte de esta wallet: sus direcciones y sus P2PK.

    Las formas P2PK son claves, no direcciones: clasifican movimientos, pero no
    salen en la lista de direcciones.
    """
    direcciones = direccionesDeWallet(wallet)
    if direcciones and wallet.tipo == TIPO_CLAVE_PUBLICA:
        return [*direcciones, *clavesP2pk(wallet.valor)]
    return direcciones


def entraEnLibreta(wallet: Wallet) -> bool:
    """¿Aporta esta wallet enlazada alguna dirección que cuente como propia sin marcarla?"""
    return bool(direccionesDeWallet(wallet))


def filasLibretaDe(wallet: Wallet) -> list[tuple[str, str, bool]]:
    """Las filas de esta wallet en la lista de direcciones.

    Returns:
        (clave de la fila, dirección, ¿derivada de una xpub o clave pública?). La
        clave de una dirección suelta es el id de la wallet, que usan sus acciones.
    """
    derivada = wallet.tipo != TIPO_DIRECCION
    return [(f"{wallet.id}#{indice}" if derivada else wallet.id, direccion, derivada)
            for indice, direccion in enumerate(direccionesDeWallet(wallet))]


def pendienteDeVerificar(sentido: str, tipoEfectivo: str, marca: MovimientoMarcado | None) -> bool:
    """¿Es una entrada de dinero que el usuario aún no ha confirmado?

    Las que vienen de una dirección propia ya no son entradas y una marca es la
    verificación, sea para contarla como entrada real o como «entre wallets».

    Example:
        >>> pendienteDeVerificar("recibida", "recibida", None)
        True
    """
    return sentido == RECIBIDA and tipoEfectivo == RECIBIDA and marca is None


def clasificar(tipo: str, entrada: EntradaLibreta | None) -> str:
    """El tipo de un movimiento después de mirar la libreta.

    Example:
        >>> clasificar("enviada", EntradaLibreta("btc", "bc1q…", "Ledger", propia=True))
        'entre_wallet'
    """
    if tipo in SENTIDOS and entrada is not None and entrada.propia:
        return ENTRE_WALLETS
    return tipo


def clasificarMovimiento(tipo: str, entrada: EntradaLibreta | None, marca: MovimientoMarcado | None) -> str:
    """Como `clasificar`, pero la marca de la transacción manda sobre la de su dirección.

    Example:
        >>> marca = MovimientoMarcado("eth", "0xabc", "", propia=True)
        >>> clasificarMovimiento("recibida", None, marca)
        'entre_wallet'
    """
    if marca is None or tipo not in SENTIDOS:
        return clasificar(tipo, entrada)
    return ENTRE_WALLETS if marca.propia else tipo


def reciboConComision(sentido: str, contrato: str) -> bool:
    """¿La comisión de la transacción de este recibo es del usuario si el origen es suyo?

    Lo recibido no trae comisión porque la pagó quien envió, pero si quien envió
    es otra dirección del usuario, la pagó él. No en un token, que la paga en otra
    moneda. Una retirada de exchange no llega aquí como origen propio: se marca
    solo la transacción, porque en Bitcoin su comisión es la de todo el lote.
    """
    return sentido == RECIBIDA and not contrato


def comisionMarcada(marca: MovimientoMarcado | None) -> str:
    """La comisión que la marca pide descontar; vacía deja la que leyó la red."""
    return marca.comision if marca is not None and marca.propia else ""


def nombreContraparte(direccion: str, entrada: EntradaLibreta | None) -> str:
    """El apodo de la contraparte, o la dirección si no tiene."""
    return entrada.apodo if entrada is not None and entrada.apodo else direccion


def aplicar(movimiento: MovimientoWallet, libreta: Libreta) -> MovimientoWallet:
    """El movimiento con el tipo que le da la libreta (el mismo objeto si no cambia)."""
    marca = libreta.marcaDe(movimiento.red, movimiento.hash, movimiento.contrato)
    entrada = libreta.paraClasificar(movimiento.red, movimiento.contraparte, movimiento.contrapartes)
    tipo = clasificarMovimiento(movimiento.tipo, entrada, marca)
    return movimiento if tipo == movimiento.tipo else replace(movimiento, tipo=tipo)


def anotar(movimiento: dict, red: str, libreta: Libreta) -> dict:
    """Un movimiento ya en dict (`movimientoComoDict`) con lo que la pantalla necesita de la libreta.

    `tipo` pasa a ser el efectivo y `sentido` conserva el que leyó la red, que
    dice quién envió a quién. Igual con `comision` y `comisionLeida`. Se puede
    aplicar dos veces sin cambiar nada.

    Args:
        movimiento: Movimiento tal como se guarda en `recientes` o sale del historial.
        red: Red de la wallet del movimiento (el dict no la lleva).
        libreta: Libreta vigente.
    """
    sentido = movimiento.get("sentido") or movimiento.get("tipo", "")
    contraparte = movimiento.get("contraparte", "")
    entrada = libreta.buscar(red, contraparte)
    decisiva = libreta.paraClasificar(red, contraparte, movimiento.get("contrapartes", ()))
    marca = libreta.marcaDe(red, movimiento.get("hash", ""), movimiento.get("contrato", ""))
    comisionLeida = movimiento.get("comisionLeida", movimiento.get("comision", ""))
    comisionOrigenPropio = ""
    if (marca is None or marca.propia) and decisiva is not None and decisiva.propia and reciboConComision(
            sentido, movimiento.get("contrato", "")):
        comisionOrigenPropio = movimiento.get("comisionTx", "")
    return {
        **movimiento,
        "tipo": clasificarMovimiento(sentido, decisiva, marca),
        "sentido": sentido,
        "comision": comisionMarcada(marca) or comisionLeida or comisionOrigenPropio,
        "comisionLeida": comisionLeida,
        "comisionMarcada": comisionMarcada(marca),
        "marcaMovimiento": ("" if marca is None else MARCA_PROPIA if marca.propia else MARCA_AJENA),
        "contraparteClave": canonica(red, contraparte) if contraparte else "",
        "contraparteApodo": entrada.apodo if entrada is not None else "",
        "contraparteMarca": entrada.marca if entrada is not None else "",
        "contraparteEnlazada": bool(entrada is not None and entrada.enlazada),
    }


def entradaComoDict(entrada: EntradaLibreta | None) -> dict | None:
    """Lo que la pantalla necesita para repintar los movimientos de una dirección tras marcarla."""
    if entrada is None:
        return None
    return {"apodo": entrada.apodo, "marca": entrada.marca, "enlazada": entrada.enlazada}
