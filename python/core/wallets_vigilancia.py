"""Seguimiento de wallets: saldo, movimientos recientes y avisos por Telegram.

Sirve para wallets propias y ajenas (la de Satoshi, una ballena…). Cada
revisión lee el saldo y los últimos movimientos de la red, guarda lo visto en
el fichero cifrado de wallets y, si la wallet tiene los avisos activados, avisa
por Telegram de lo nuevo según sus ajustes (tipos de movimiento, mínimos, saldo,
wallet que despierta, movimientos sospechosos, agrupar, tope y horas de
silencio: `core.wallets_avisos`).

La primera revisión de una wallet solo memoriza lo que ya hay: sin eso, enlazar
la wallet de Satoshi mandaría cientos de avisos de golpe. Los avisos nunca
llevan la dirección ni la xpub; sí el nombre, el importe y el hash abreviado.
Telegram no cifra de extremo a extremo los chats con bots, así que esos datos
pasan por sus servidores: por eso los avisos se activan wallet a wallet.

Esto no importa nada a Transacciones: eso sigue siendo manual (Sincronizar).
"""

import json
import logging
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from core import dinero, paths, settings, telegram_notifier, wallets_avisos
from core.cripto_direcciones import REDES, TIPO_XPUB
from core.wallets_avisos import ConfigAvisos
from core.wallets_libreta import Libreta, aplicar, canonica, libretaDe
from core.wallets_sync import SincronizadorWallets, resolverActivoToken, textoDecimal
from core.wallets_tokens import (
    IMITACION,
    RECONOCIDO,
    VERIFICADO,
    anotarConocidos,
    estadoToken,
    indiceMarcas,
    indicePublico,
    indiceVerificados,
)
from providers.api_stats import lastApiResults
from providers.blockchain_clients import (
    ENTRE_WALLETS,
    ENVIADA,
    ErrorFueraDePlan,
    ErrorLecturaWallet,
    MovimientoWallet,
    lectorPara,
)
from providers.listas_tokens import TokenPublico, tokensPublicos
from stores.wallets_store import (
    TokenPrecio,
    Wallet,
    WalletError,
    WalletsRepository,
    ahoraIso,
    claveSeguimiento,
    enmascarar,
)

log = logging.getLogger(__name__)

CATEGORIA_AVISO = "wallets"
CLAVE_AJUSTE_MINUTOS = "walletsVigilanciaMinutos"
OPCIONES_MINUTOS = (0, 5, 15, 30, 60, 180, 360, 1440)
MINUTOS_DEFECTO = 15
# Movimientos que se piden en cada revisión. Entre dos revisiones de 15 minutos
# no entran 25 movimientos en una wallet normal; una ballena muy activa podría
# superarlo: si ninguno de los leídos es conocido se lee `_LIMITE_AMPLIADO`, y si
# tampoco alcanza lo ya visto, la wallet queda marcada como lectura incompleta.
_LIMITE_LECTURA = 25
_LIMITE_AMPLIADO = 200
_MAX_LARGO_ERROR = 300
_PREFIJO_SOSPECHOSO = "Posible movimiento sospechoso"
_MAX_RECIENTES = 10
_MAX_HASHES = 1000
_MAX_CONTRAPARTES = 1000
_TIPOS_TEXTO = {ENVIADA: "enviada", ENTRE_WALLETS: "entre direcciones propias"}
# Lo que se añade al importe de un token según su estado. Reconocido (por las
# listas públicas) se enseña como verificado, igual que en la página.
_ESTADOS_TEXTO = {VERIFICADO: "token verificado", RECONOCIDO: "token verificado", IMITACION: "imitación"}
# Cuánto deja de leer la vigilancia una red que su API dice que el plan no cubre.
# El reintento diario recoge un plan contratado con la misma clave sin que el
# usuario tenga que hacer nada más.
_pausaFueraDePlan = timedelta(hours=24)


@dataclass(frozen=True)
class _PausaPlan:
    """Una red que la vigilancia no lee: hasta cuándo y qué fila de Ajustes > API la levanta."""

    fila: str
    hasta: datetime
    mensaje: str = ""


# Red → pausa. En memoria porque la vigilancia corre en un solo proceso: tras un
# reinicio basta con un intento para volver a saberlo. Cada red la toca solo su
# hilo, así que no hace falta cerrojo.
_pausasPlan: dict[str, _PausaPlan] = {}


def minutosVigilancia() -> int:
    """Cada cuántos minutos se revisan las wallets (0 = nunca), según Ajustes.

    Se lee el fichero directamente, como hace `telegram_notifier`: este módulo
    lo usa el hilo de avisos, sin petición de Flask.
    """
    try:
        valor = json.loads(paths.AJUSTES_JSON.read_text("utf-8")).get(CLAVE_AJUSTE_MINUTOS, MINUTOS_DEFECTO)
    except (OSError, ValueError, AttributeError):
        return MINUTOS_DEFECTO
    return valor if valor in OPCIONES_MINUTOS else MINUTOS_DEFECTO


def precioEurDeMoneda(red: str, assetId: str, ticker: TokenPrecio | None = None) -> Decimal | None:
    """Precio en euros de la moneda de una red, o None si no se sabe.

    Como en la Watchlist, el ticker puesto a mano manda sobre el activo. Sin
    ninguno de los dos (una ajena sin activo, o el activo es de otro portfolio) se
    busca una cripto del portfolio activo con el símbolo de la red.

    Args:
        red: Clave de la red.
        assetId: Activo asociado a la wallet; "" si no tiene.
        ticker: Ticker puesto a mano a la moneda de la red.
    """
    precio = precioEurDeTicker(ticker.proveedor, ticker.ticker) if ticker else None
    if precio is None and assetId:
        precio = precioEurDeActivo(assetId)
    if precio is None:
        from stores.asset_store import listarActivosCripto

        activo = resolverActivoToken(REDES[red].simbolo, listarActivosCripto(), [])
        precio = precioEurDeActivo(activo["id"]) if activo else None
    return precio


def precioEurDeActivo(assetId: str) -> Decimal | None:
    """Precio en euros del activo asociado a la wallet, o None si no se sabe."""
    from stores.asset_store import readAssetFile

    # La conversión es la de la valoración de la cartera: así el valor de la
    # wallet y el del activo en Activos salen con el mismo tipo de cambio.
    from stores.valoracion import _Cambios

    if not assetId:
        return None
    activo = readAssetFile(assetId)
    precio = dinero.aDecimalONulo(activo.get("price")) if activo else None
    if not precio or precio <= 0:
        return None
    return _Cambios().aEuros(precio, activo.get("currency") or "EUR")


def precioEurDeTicker(proveedor: str, ticker: str) -> Decimal | None:
    """Precio en euros de un ticker en un proveedor de cotización, o None si no se sabe.

    Para los tokens sin activo en Activos a los que el usuario ha puesto un
    ticker. Pasa por la caché de cotizaciones, así que repetirlo es barato.
    """
    from stores.market_data import fetchAssetQuote
    from stores.valoracion import _Cambios

    if not ticker:
        return None
    cotizacion, error = fetchAssetQuote(ticker, proveedor)
    if error or not cotizacion:
        log.debug("[wallets] Sin cotización para %s en %s: %s", ticker, proveedor, error)
        return None
    precio = dinero.aDecimalONulo(cotizacion.get("price"))
    if not precio or precio <= 0:
        return None
    return _Cambios().aEuros(precio, cotizacion.get("currency") or "EUR")


def claveMovimiento(movimiento: MovimientoWallet) -> str:
    # Una transacción de Ethereum puede mover la moneda y un token a la vez.
    return f"{movimiento.hash}|{movimiento.simbolo}"


def movimientoComoDict(movimiento: MovimientoWallet) -> dict:
    """La forma en que se guarda y se enseña un movimiento reciente."""
    guardado = {
        "hash": movimiento.hash,
        "fecha": movimiento.fecha.isoformat(),
        "simbolo": movimiento.simbolo,
        "cantidad": textoDecimal(movimiento.cantidad),
        "comision": textoDecimal(movimiento.comision),
        "comisionTx": textoDecimal(movimiento.comisionTx),
        "tipo": movimiento.tipo,
        "contraparte": movimiento.contraparte,
        "propia": movimiento.propia,
        "contrato": movimiento.contrato,
    }
    if len(movimiento.contrapartes) > 1:
        guardado["contrapartes"] = list(movimiento.contrapartes)
    return guardado


def _euros(valor: Decimal) -> str:
    return f"{valor:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def nombreAviso(wallet: Wallet) -> str:
    """Cómo se nombra la wallet en un aviso.

    Con varias wallets en un seguimiento, el alias solo («Cuenta 2») no dice de quién es.
    """
    if wallet.claveSeguimiento != claveSeguimiento(wallet.alias):
        return f"{wallet.nombreSeguimiento} · {wallet.alias}"
    return wallet.alias


def _cabeceraAviso(wallet: Wallet) -> str:
    red = REDES[wallet.red].nombre
    return f"Wallet «{nombreAviso(wallet)}» ({red}{'' if wallet.propia else ', seguimiento'})"


def textoAviso(wallet: Wallet, movimiento: MovimientoWallet, precioEur: Decimal | None,
               libreta: Libreta | None = None, estado: str = "") -> str:
    """Mensaje de Telegram de un movimiento. Sin la dirección ni la xpub de la wallet.

    Args:
        wallet: Wallet del movimiento.
        movimiento: Movimiento tal como lo leyó la red.
        precioEur: Precio de la moneda nativa, para el valor en euros.
        libreta: Libreta de direcciones: da el tipo efectivo y el apodo de la contraparte.
        estado: Estado del token (`core.wallets_tokens.estadoToken`); "" en la moneda nativa.
    """
    entrada = libreta.buscar(movimiento.red, movimiento.contraparte) if libreta is not None else None
    efectivo = aplicar(movimiento, libreta).tipo if libreta is not None else movimiento.tipo
    tipo = "entre wallets propias" if efectivo != movimiento.tipo else _TIPOS_TEXTO.get(efectivo, "recibida")
    importe = f"{textoDecimal(movimiento.cantidad)} {movimiento.simbolo}"
    if precioEur is not None and not movimiento.contrato:
        importe += f" (≈ {_euros(movimiento.cantidad * precioEur)} €)"
    if estado in _ESTADOS_TEXTO:
        importe += f" · {_ESTADOS_TEXTO[estado]}"
    lineas = [f"{_cabeceraAviso(wallet)}: {tipo} {importe}"]
    if movimiento.contraparte:
        # El apodo lo ha puesto el usuario; la dirección, enmascarada, como siempre.
        contraparte = entrada.apodo if entrada is not None and entrada.apodo else enmascarar(movimiento.contraparte)
        lineas.append(f"{'Hacia' if movimiento.tipo == ENVIADA else 'Desde'}: {contraparte}")
    lineas.append(f"Tx: {enmascarar(movimiento.hash)} · {movimiento.fecha.strftime('%d-%m-%Y %H:%M')} UTC")
    return "\n".join(lineas)


def textoSaldo(wallet: Wallet, config: ConfigAvisos, estado: str, saldo: Decimal) -> str:
    """Aviso de saldo que ha cruzado su mínimo o su máximo."""
    simbolo = REDES[wallet.red].simbolo
    if estado == wallets_avisos.BAJO:
        cruce = f"el saldo ha bajado de {config.saldoMinimo} {simbolo}"
    else:
        cruce = f"el saldo ha superado {config.saldoMaximo} {simbolo}"
    return f"{_cabeceraAviso(wallet)}: {cruce}. Ahora: {textoDecimal(saldo)} {simbolo}"


def textoDespierta(wallet: Wallet, dias: int) -> str:
    """Aviso de wallet que vuelve a moverse tras mucho tiempo quieta."""
    return f"{_cabeceraAviso(wallet)}: vuelve a moverse tras {dias} días sin movimientos"


def textoSospechoso(motivos: list[str], texto: str) -> str:
    """El aviso de un movimiento con lo que lo hace sospechoso delante."""
    return f"{_PREFIJO_SOSPECHOSO}: {'; '.join(motivos)}.\n{texto}"


def textoIncompleta(wallet: Wallet, leidos: int) -> str:
    """Aviso de que entre dos revisiones hubo más movimientos de los que se pueden leer."""
    return (f"{_cabeceraAviso(wallet)}: {leidos} movimientos nuevos o más desde la última revisión. "
            "Puede haber otros que no se han leído ni avisado: revisa su historial.")


def textoVaciado(wallet: Wallet, saldoPrevio: Decimal, saldo: Decimal) -> str:
    """Aviso de wallet que se ha quedado casi vacía tras uno o más envíos."""
    simbolo = REDES[wallet.red].simbolo
    return (f"{_PREFIJO_SOSPECHOSO}: {_cabeceraAviso(wallet)} casi vaciada. "
            f"Saldo: {textoDecimal(saldoPrevio)} → {textoDecimal(saldo)} {simbolo}")


def textoRafaga(wallet: Wallet, envios: int) -> str:
    """Aviso de muchos envíos seguidos entre dos revisiones."""
    return f"{_PREFIJO_SOSPECHOSO}: {_cabeceraAviso(wallet)} ha hecho {envios} envíos desde la última revisión"


def contrapartesVistas(wallet: Wallet, movimientos: list[MovimientoWallet]) -> list[str]:
    """Las contrapartes conocidas tras esta revisión, las más recientes primero y con tope.

    Una wallet de antes del aviso de dirección nueva parte de sus `recientes`,
    para no tomar por nuevas las que ya salían en pantalla.
    """
    previas = wallet.contrapartesConocidas
    if previas is None:
        previas = [canonica(wallet.red, m.get("contraparte", "")) for m in wallet.recientes]
    leidas = [canonica(m.red, m.contraparte) for m in movimientos]
    return list(dict.fromkeys(c for c in [*leidas, *previas] if c))[:_MAX_CONTRAPARTES]


def _sinEnganche(movimientos: list[MovimientoWallet], wallet: Wallet, limite: int) -> bool:
    """¿Se ha llenado la lectura sin llegar a nada ya visto? Entonces pudo quedarse algo fuera."""
    conocidos = set(wallet.hashesConocidos)
    return len(movimientos) >= limite and not any(claveMovimiento(m) in conocidos for m in movimientos)


def _esAjena(wallet: Wallet) -> bool:
    # Sin el campo cuenta como propia, igual que el valor por defecto de Wallet.
    return getattr(wallet, "propia", True) is False


def tocaRevisar(wallet: Wallet, ahoraUtc: datetime, minutosAjenas: int) -> bool:
    """Si la vigilancia debe revisar `wallet` en esta pasada.

    Las propias, siempre. Las ajenas, solo si hace al menos `minutosAjenas`
    desde su última lectura (`saldoFecha`, que se apunta en cada revisión): así
    no hace falta guardar nada más. Una ajena sin leer nunca, o con una fecha
    ilegible, toca.

    Args:
        wallet: La wallet enlazada.
        ahoraUtc: Hora actual, con zona.
        minutosAjenas: `[wallets] ajenas_cada_minutos`; 0 revisa las ajenas siempre.

    Returns:
        True si hay que revisarla ahora.
    """
    if not _esAjena(wallet) or minutosAjenas <= 0 or not wallet.saldoFecha:
        return True
    try:
        leida = datetime.fromisoformat(wallet.saldoFecha)
    except ValueError:
        return True
    if leida.tzinfo is None:
        leida = leida.replace(tzinfo=UTC)
    return ahoraUtc - leida >= timedelta(minutes=minutosAjenas)


class VigilanteWallets:
    """Revisa wallets y avisa de lo nuevo. Dependencias inyectables para los tests.

    Args:
        repositorio: Almacén cifrado de wallets.
        fabricaLectores: Red → lector de movimientos (por defecto `lectorPara`).
        notificar: Función `(categoria, texto) -> bool` que manda el aviso.
        precioEur: assetId → precio en euros o None. Por defecto, `precioEurDeMoneda`,
            que además mira el ticker de la moneda de la red.
        ahora: Hora local actual, para las horas de silencio.
        leerTokensPublicos: Contratos de las listas públicas de tokens, para
            decidir el estado de un token como la página y la importación.
        ahoraUtc: Hora UTC actual, para el intervalo de las ajenas.
        ultimosResultados: Último resultado de cada fila de Ajustes > API, para
            saber si sigue en pie el fallo que pausó una red.
        puedeAvisar: Si la categoría de los avisos está en condiciones de mandarse:
            lo que falla sin eso no se reintenta, porque es lo que quiere el usuario.
    """

    def __init__(
        self,
        repositorio: WalletsRepository | None = None,
        fabricaLectores: Callable | None = None,
        notificar: Callable[[str, str], bool] | None = None,
        precioEur: Callable[[str], Decimal | None] | None = None,
        ahora: Callable[[], datetime] | None = None,
        leerTokensPublicos: Callable[[], list[TokenPublico]] = tokensPublicos,
        ahoraUtc: Callable[[], datetime] = lambda: datetime.now(UTC),
        ultimosResultados: Callable[[], dict] = lastApiResults,
        puedeAvisar: Callable[[str], bool] | None = None,
    ) -> None:
        self._puedeAvisar = puedeAvisar or telegram_notifier.puedeAvisar
        self._ahoraUtc = ahoraUtc
        self._ultimosResultados = ultimosResultados
        self._repositorio = repositorio or WalletsRepository()
        self._fabricaLectores = fabricaLectores or lectorPara
        self._notificar = notificar or telegram_notifier.notificar
        self._precioEur = precioEur
        self._ahora = ahora or datetime.now
        self._leerTokensPublicos = leerTokensPublicos

    def revisar(self, walletId: str) -> tuple[Wallet, int]:
        """Lee saldo y movimientos de una wallet y avisa de los nuevos.

        Returns:
            La wallet actualizada y cuántos avisos se han mandado.

        Raises:
            WalletNoEncontrada: si la wallet no existe.
            ErrorLecturaWallet: si la red no responde o responde un error.
        """
        wallet = self._repositorio.obtener(walletId)
        lector = self._fabricaLectores(wallet.red)
        saldo = lector.saldo(wallet.tipo, wallet.valor)
        movimientos, incompleta = self._leerMovimientos(lector, wallet)

        conocidos = set(wallet.hashesConocidos)
        nuevos = [m for m in movimientos if claveMovimiento(m) not in conocidos]
        config = ConfigAvisos.desdeGuardado(wallet.avisosConfig)
        # El estado del saldo se apunta siempre, avise o no: así activar los
        # avisos no dispara uno por un cruce que ya había pasado.
        estado = wallets_avisos.estadoSaldo(config, saldo)
        enviados, pendientes, reintentos = 0, [], []
        if wallet.vigilanciaIniciada and wallet.avisos:
            avisos = self._avisos(wallet, config, nuevos, saldo, estado)
            if incompleta:
                avisos.append(textoIncompleta(wallet, len(nuevos)))
            enviados, pendientes, reintentos = self._entregar(
                wallet, config, list(wallet.avisosPendientes), list(wallet.avisosReintento), avisos
            )

        hashes = list(dict.fromkeys([claveMovimiento(m) for m in movimientos] + list(wallet.hashesConocidos)))
        nuevasDerivadas = self._direccionesNuevas(lector, wallet)
        actualizada = self._repositorio.actualizar(
            wallet.id,
            direccionesDerivadas=[*wallet.direccionesDerivadas, *nuevasDerivadas],
            saldo=textoDecimal(saldo),
            saldoFecha=ahoraIso(),
            recientes=[movimientoComoDict(m) for m in movimientos[:_MAX_RECIENTES]],
            hashesConocidos=hashes[:_MAX_HASHES],
            contrapartesConocidas=contrapartesVistas(wallet, movimientos),
            ultimoMovimiento=movimientos[0].fecha.isoformat() if movimientos else wallet.ultimoMovimiento,
            vigilanciaIniciada=True,
            estadoSaldo=estado,
            avisosPendientes=pendientes,
            avisosReintento=reintentos,
            lecturaIncompleta=incompleta,
            ultimoError="",
            ultimoErrorFecha="",
        )
        anotarConocidos(self._repositorio, wallet.red,
                        ((m.contrato, m.simbolo, "") for m in movimientos if m.contrato))
        self._reetiquetarNuevas(wallet.red, nuevasDerivadas)
        return actualizada, enviados

    @staticmethod
    def _direccionesNuevas(lector, wallet: Wallet) -> list[str]:
        """Las direcciones con uso de una xpub propia que aún no estaban guardadas."""
        if not wallet.propia or wallet.tipo != TIPO_XPUB or not hasattr(lector, "direccionesUsadas"):
            return []
        conocidas = set(wallet.direccionesDerivadas)
        return [direccion for direccion in lector.direccionesUsadas(wallet.valor) or [] if direccion not in conocidas]

    def _reetiquetarNuevas(self, red: str, direcciones: list[str]) -> None:
        """Corrige lo ya importado de otras wallets que venía de estas direcciones.

        Un fallo no cuenta como fallo de lectura: lo leído ya está guardado, y
        la próxima dirección nueva o un cambio en la libreta vuelve a reetiquetar.
        """
        if not direcciones:
            return
        try:
            SincronizadorWallets(self._repositorio).reetiquetarVarias(red, direcciones)
        except (WalletError, ErrorLecturaWallet) as error:
            log.warning("[wallets] No se pudo reetiquetar Transacciones: %s", error)

    def revisarAnotandoFallo(self, walletId: str) -> tuple[Wallet, int]:
        """Como `revisar`, pero deja el motivo de un fallo de lectura para enseñarlo en la tarjeta.

        Para las lecturas a mano: el aviso del momento desaparece, y sin esto la
        tarjeta de una wallet nueva diría que sigue pendiente de leer.

        Raises:
            WalletNoEncontrada: si la wallet no existe.
            ErrorLecturaWallet: si la red no responde o responde un error.
        """
        try:
            return self.revisar(walletId)
        except ErrorLecturaWallet as error:
            self._anotarFallo(walletId, str(error))
            raise

    def _leerMovimientos(self, lector, wallet: Wallet) -> tuple[list[MovimientoWallet], bool]:
        """Los movimientos que hacen falta para enlazar con lo ya visto.

        La lectura corta basta casi siempre y gasta menos API; la ampliada es para
        la wallet que ha tenido más actividad que eso entre dos revisiones.

        Returns:
            Los movimientos y si, aun así, puede haberse quedado alguno fuera.

        Raises:
            ErrorLecturaWallet: si falla la primera lectura. Si falla la ampliada
                se sigue con la corta, marcada como incompleta.
        """
        movimientos = lector.leer(wallet.tipo, wallet.valor, _LIMITE_LECTURA)
        # La primera revisión solo memoriza: no hay nada con lo que enlazar.
        if not wallet.vigilanciaIniciada or not _sinEnganche(movimientos, wallet, _LIMITE_LECTURA):
            return movimientos, False
        try:
            ampliados = lector.leer(wallet.tipo, wallet.valor, _LIMITE_AMPLIADO)
        except ErrorLecturaWallet as error:
            log.warning("[wallets] Lectura ampliada de %s (%s): %s", wallet.id, wallet.red, error)
            return movimientos, True
        return ampliados, _sinEnganche(ampliados, wallet, _LIMITE_AMPLIADO)

    def _avisos(self, wallet: Wallet, config: ConfigAvisos, nuevos: list[MovimientoWallet],
                saldo: Decimal | None, estado: str) -> list[str]:
        """Los textos de todo lo que merece aviso en esta revisión, en orden."""
        avisos = []
        # Del más antiguo al más reciente, que es el orden en que ocurrieron.
        nuevos = sorted(nuevos, key=lambda m: m.fecha)
        if config.despiertaDias and nuevos:
            dias = wallets_avisos.diasDormida(wallet.ultimoMovimiento, nuevos[0].fecha)
            if dias is not None and dias >= config.despiertaDias:
                avisos.append(textoDespierta(wallet, dias))
        precio = self._precio(wallet) if any(not m.contrato for m in nuevos) else None
        libreta = libretaDe(self._repositorio) if nuevos else Libreta()
        # Los filtros por tipo miran el efectivo: un envío a otra wallet propia
        # avisa como «entre wallets», no como «enviada».
        efectivos = [aplicar(m, libreta) for m in nuevos]
        vistas = set(wallet.contrapartesConocidas) if wallet.contrapartesConocidas is not None else None
        enLibreta = libreta.direccionesDe(wallet.red)
        estadosToken = self._estadosToken(wallet, nuevos)
        for original, efectivo, estadoDelToken in zip(nuevos, efectivos, estadosToken, strict=True):
            imitacion = estadoDelToken == IMITACION
            motivos = wallets_avisos.motivosSospecha(
                config, efectivo, canonica(wallet.red, efectivo.contraparte), vistas, enLibreta, precio, imitacion
            )
            # Lo sospechoso avisa aunque los filtros de tipo y mínimo no lo dejen pasar.
            if motivos:
                avisos.append(textoSospechoso(motivos, textoAviso(wallet, original, precio, libreta, estadoDelToken)))
            elif wallets_avisos.avisaDeMovimiento(config, wallet.umbralAviso, efectivo, precio, imitacion):
                avisos.append(textoAviso(wallet, original, precio, libreta, estadoDelToken))
        envios = wallets_avisos.enviosRafaga(config, efectivos)
        if envios:
            avisos.append(textoRafaga(wallet, envios))
        saldoPrevio = dinero.aDecimalONulo(wallet.saldo)
        if wallets_avisos.esVaciado(config, saldoPrevio, saldo, efectivos):
            avisos.append(textoVaciado(wallet, saldoPrevio, saldo))
        if estado and estado != wallet.estadoSaldo:
            avisos.append(textoSaldo(wallet, config, estado, saldo))
        return avisos

    def _estadosToken(self, wallet: Wallet, movimientos: list[MovimientoWallet]) -> list[str]:
        """El estado de cada token, con la misma regla que la página y la importación.

        Las marcas y verificaciones son por contrato: un token que vuelve a
        llegar de un contrato ya decidido sale con esa decisión. Sin tokens no
        se lee nada, ni el fichero cifrado ni las listas públicas.
        """
        if not any(m.contrato for m in movimientos):
            return [""] * len(movimientos)
        verificados = indiceVerificados(self._repositorio.tokensVerificados())
        marcas = indiceMarcas(self._repositorio.marcasToken())
        publicos = indicePublico(self._leerTokensPublicos())
        return [estadoToken(wallet.red, m.simbolo, m.contrato, verificados, marcas, publicos) for m in movimientos]

    def _precio(self, wallet: Wallet) -> Decimal | None:
        try:
            if self._precioEur is not None:
                return self._precioEur(wallet.assetId)
            ticker = next((p for p in self._repositorio.preciosToken() if (p.red, p.contrato) == (wallet.red, "")),
                          None)
            return precioEurDeMoneda(wallet.red, wallet.assetId, ticker)
        except Exception as error:
            # Sin precio el aviso sale igual, solo sin el valor en euros.
            log.debug("[wallets] Sin precio en euros para %s: %s", wallet.id, error)
            return None

    def _entregar(self, wallet: Wallet, config: ConfigAvisos, pendientes: list[str], reintentos: list[str],
                  avisos: list[str]) -> tuple[int, list[str], list[str]]:
        """Manda los avisos, o los guarda si es hora de silencio.

        Returns:
            Mensajes mandados, avisos que quedan para cuando acabe el silencio y
            avisos sospechosos que hay que volver a intentar.
        """
        if wallets_avisos.enSilencio(config, self._ahora()):
            return 0, (pendientes + avisos)[-wallets_avisos.MAX_PENDIENTES:], reintentos
        nombre = nombreAviso(wallet)
        mensajes = []
        if pendientes:
            mensajes.append(wallets_avisos.agrupar(
                f"Durante las horas de silencio, {len(pendientes)} avisos de «{nombre}»:", pendientes
            ))
        if reintentos:
            mensajes.append(wallets_avisos.agrupar(
                f"Avisos sospechosos de «{nombre}» que no se pudieron entregar antes:", reintentos
            ))
        mensajes.extend(wallets_avisos.componerMensajes(nombre, avisos, config))
        troceados = [trozo for mensaje in mensajes for trozo in wallets_avisos.trocear(mensaje)]
        fallidos = [texto for texto in troceados if not self._notificar(CATEGORIA_AVISO, texto)]
        return len(troceados) - len(fallidos), [], self._paraReintentar([*reintentos, *pendientes, *avisos], fallidos)

    def _paraReintentar(self, avisos: list[str], fallidos: list[str]) -> list[str]:
        """Los avisos sospechosos que iban en un mensaje que Telegram no ha aceptado.

        Solo los sospechosos: el resto llegaría tarde y fuera de contexto, pero
        saber que han vaciado una wallet sirve aunque sea horas después. Y solo si
        el canal debería funcionar: sin Telegram o con /silenciar no hay nada que
        reintentar, es lo que ha elegido el usuario.
        """
        if not fallidos or not self._puedeAvisar(CATEGORIA_AVISO):
            return []
        log.warning("[wallets] Telegram no ha aceptado %d mensajes de avisos", len(fallidos))
        return [aviso for aviso in dict.fromkeys(avisos)
                if aviso.startswith(_PREFIJO_SOSPECHOSO) and any(aviso in texto for texto in fallidos)
                ][-wallets_avisos.MAX_PENDIENTES:]

    def revisarTodas(self, contexto: Callable[[], AbstractContextManager] = nullcontext) -> int:
        """Revisa todas las wallets; un fallo en una no impide las demás.

        Las redes van en paralelo, un hilo por red, porque cada una tiene su API
        (mempool.space, Etherscan, Solana, XRPL). Dentro de una red, de una en
        una: varias a la vez contra la misma API es lo que hace que limite o
        corte la IP. ETH y BNB comparten Etherscan, pero su `Ritmo` ya las pone
        en fila.

        Si la API de una red dice que el plan no la cubre, esa red se deja de leer
        (`_redEnPausa`): el resto de sus wallets darían el mismo error.

        Args:
            contexto: Se abre en cada hilo antes de revisar. Sirve para lo que
                es por hilo, como el portfolio de `useDbPath` del que sale el
                precio en euros: un hilo nuevo no lo hereda.

        Returns:
            Avisos mandados en total.
        """
        try:
            wallets = self._repositorio.listar()
        except WalletError as error:
            log.warning("[wallets] No se pueden leer las wallets para vigilarlas: %s", error)
            return 0
        porRed: dict[str, list[Wallet]] = {}
        ahoraUtc = self._ahoraUtc()
        minutosAjenas = settings.walletsAjenasCadaMinutos()
        # Las propias primero: si la API empieza a limitar a mitad de pasada,
        # que lo que se quede sin leer sean las ajenas.
        for wallet in sorted(wallets, key=_esAjena):
            if tocaRevisar(wallet, ahoraUtc, minutosAjenas):
                porRed.setdefault(wallet.red, []).append(wallet)
        if not porRed:
            return 0

        def revisarRed(lista: list[Wallet]) -> int:
            with contexto():
                enviados = 0
                for wallet in lista:
                    if self._redEnPausa(wallet.red):
                        self._anotarPausa(wallet)
                    else:
                        enviados += self._revisarSinFallar(wallet)
                return enviados

        with ThreadPoolExecutor(max_workers=len(porRed), thread_name_prefix="wallets-red") as hilos:
            return sum(hilos.map(revisarRed, porRed.values()))

    def _redEnPausa(self, red: str) -> bool:
        """Si la vigilancia debe saltarse `red` porque su API no la cubre.

        La pausa se levanta sola al pasar `_pausaFueraDePlan` o en cuanto la fila
        de Ajustes > API deja de decir «plan»: al cambiar de API o de clave, al
        pulsar Comprobar o al revisar una wallet a mano con éxito.

        Args:
            red: Red de la wallet.

        Returns:
            True si no hay que leerla ahora.
        """
        pausa = _pausasPlan.get(red)
        if pausa is None:
            return False
        if self._ahoraUtc() < pausa.hasta and self._ultimosResultados().get(pausa.fila, {}).get("estado") == "plan":
            return True
        del _pausasPlan[red]
        return False

    def _revisarSinFallar(self, wallet: Wallet) -> int:
        """Avisos mandados al revisar `wallet`; 0 si falla, que no corta las demás."""
        try:
            return self.revisar(wallet.id)[1]
        except ErrorFueraDePlan as error:
            _pausasPlan[wallet.red] = _PausaPlan(error.fila, self._ahoraUtc() + _pausaFueraDePlan, str(error))
            self._anotarFallo(wallet.id, str(error))
            log.warning("[wallets] Vigilancia de la red %s en pausa durante %d horas: %s",
                        wallet.red, _pausaFueraDePlan.total_seconds() // 3600, error)
            return 0
        except (WalletError, ErrorLecturaWallet) as error:
            log.warning("[wallets] Vigilancia de %s (%s): %s", wallet.id, wallet.red, error)
            self._anotarFallo(wallet.id, str(error))
            return 0

    def _anotarPausa(self, wallet: Wallet) -> None:
        """Deja constancia en una wallet que no se lee porque su red está en pausa."""
        pausa = _pausasPlan.get(wallet.red)
        if pausa is not None and getattr(wallet, "ultimoError", "") != pausa.mensaje:
            self._anotarFallo(wallet.id, pausa.mensaje)

    def _anotarFallo(self, walletId: str, mensaje: str) -> None:
        """Guarda por qué ha fallado la revisión, para que lo enseñe la página.

        Lo llevan los mensajes de `ErrorLecturaWallet`, que se pueden enseñar tal
        cual.
        """
        try:
            self._repositorio.actualizar(walletId, ultimoError=mensaje[:_MAX_LARGO_ERROR], ultimoErrorFecha=ahoraIso())
        except Exception as error:
            # Cualquier fallo: disco, bloqueo ocupado… El error original ya está en
            # el log, y anotarlo no puede cortar la revisión de las demás wallets.
            log.warning("[wallets] No se pudo anotar el fallo de %s: %s", walletId, error)
