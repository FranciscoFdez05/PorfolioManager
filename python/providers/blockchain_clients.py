"""Lectores de movimientos on-chain de las redes soportadas.

Patrón Adapter + Strategy: cada red tiene su API (Esplora para Bitcoin,
Etherscan v2 para Ethereum y BNB Smart Chain, NodeReal como alternativa para
BNB, el RPC JSON de Solana y el de XRPL) y aquí se traduce a una sola forma,
`MovimientoWallet`. El servicio de sincronización elige el lector con
`lectorPara(red)` y no sabe nada de ninguna API concreta.

Todas las llamadas pasan por `providers.http.fetchJson`: timeout, reintentos
con backoff y tope de tamaño de respuesta. Cada red anota sus llamadas y su
último resultado con un nombre `ESTADO_*`, que es la fila de Ajustes > API.

Los mensajes de error que suben al usuario nunca llevan la dirección ni la xpub.
"""

import hashlib
import logging
import threading
import time
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from decimal import Decimal
from typing import Callable, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit

from core import bloqueo, paths, proveedor_bnb, settings
from core.cripto_direcciones import (
    RAMA_CAMBIO,
    RAMA_RECEPCION,
    REDES,
    TIPO_CLAVE_PUBLICA,
    TIPO_XPUB,
    clavesP2pk,
    direccionesDeClavePublica,
    leerClaveExtendida,
)
from providers.api_stats import recordApiResult
from providers.http import ProviderError, fetchJson, motivoConexion
from stores.app_data import readEtherscanApiKey, readNodeRealApiKey

log = logging.getLogger(__name__)

ENVIADA = "enviada"
RECIBIDA = "recibida"
ENTRE_WALLETS = "entre_wallet"

_ETHERSCAN_URL = "https://api.etherscan.io/v2/api"
_ETHERSCAN_CADENAS = {"eth": 1, "bnb": 56}
# El plan gratuito de Etherscan admite 3 llamadas por segundo por clave y
# responde «Max calls per sec rate limit reached». La cuota la comparten
# movimientos, saldo y visor de tokens de todas las wallets, que pueden ir a la
# vez en varios hilos: se espacian en todo el proceso, con margen.
_ETHERSCAN_INTERVALO = 0.4
# Los workers de gunicorn no comparten el ritmo: si aun así Etherscan corta, se
# espera a que pase su ventana de un segundo y se repite.
_ETHERSCAN_REINTENTOS = 2
_ETHERSCAN_ESPERA_LIMITE = 1.1
# Fila de cada API en Ajustes > API. BNB tiene nombre propio y no el de su
# proveedor para que un fallo suyo no se confunda con uno de Ethereum.
ESTADO_ETHERSCAN = "Etherscan"
ESTADO_BNB = "BNB Chain"
ESTADO_ESPLORA = "Bitcoin"
ESTADO_SOLANA = "Solana"
ESTADO_XRPL = "XRP Ledger"
_ESTADO_ETHERSCAN_POR_RED = {"eth": ESTADO_ETHERSCAN, "bnb": ESTADO_BNB}
_NODEREAL_URL = "https://bsc-mainnet.nodereal.io/v1/{clave}"
# Una consulta de historial cuesta 250 CU y el plan gratuito admite 150 o 300 CU
# por segundo (su propia página da las dos cifras): con 2 s no se supera ninguna.
_NODEREAL_INTERVALO = 2.0
_NODEREAL_MAX_PAGINA = 1000
_NODEREAL_MAX_PAGINA_TOKENS = 100
_NODEREAL_CATEGORIAS = {"txlist": "external", "tokentx": "20"}
_MAX_LARGO_NOMBRE_TOKEN = 60
_ESPLORA_PAGINA = 25
_SOLANA_LOTE = 20
_SOLANA_MAX_FIRMAS = 1000
_XRPL_MAX_PAGINA = 400
# Segundos entre el 1-1-1970 y el 1-1-2000, el origen de las fechas de XRPL.
_XRPL_EPOCA = 946_684_800
# Tope de seguridad al explorar una xpub: con gap_limit 20 una wallet normal
# usa unas decenas de direcciones; miles indicarían un bucle por datos raros.
_MAX_INDICES_XPUB = 5000
_MAX_LARGO_SIMBOLO = 20
# Una clave pública en hex: comprimida (33 bytes) o sin comprimir (65). Ninguna
# dirección Bitcoin tiene esa forma, así que distingue sin ambigüedad un destino
# P2PK de una dirección.
_LARGOS_CLAVE_P2PK = (66, 130)
_OP_CHECKSIG = b"\xac"

ObtenerJson = Callable[..., object]


class ErrorLecturaWallet(Exception):
    """No se pudieron leer los movimientos. El mensaje se puede enseñar tal cual."""


class ErrorFueraDePlan(ErrorLecturaWallet):
    """El plan de la clave no cubre la lectura: repetirla dará lo mismo hasta que cambie algo.

    Args:
        mensaje: Texto que se puede enseñar tal cual.
        fila: Fila de Ajustes > API (`ESTADO_*`) donde ha quedado anotado el fallo.
    """

    def __init__(self, mensaje: str, fila: str) -> None:
        super().__init__(mensaje)
        self.fila = fila


@dataclass(frozen=True)
class MovimientoWallet:
    """Un movimiento ya normalizado, en unidades de la moneda (no en satoshis o wei).

    `contraparte` es la otra dirección del movimiento ('' si es entre direcciones
    propias). `contrato` solo lo llevan los tokens, para poder distinguir uno
    legítimo de una copia con el mismo símbolo.

    `comision` es lo que pagó la wallet (None si la pagó otro) y es lo que se
    suma e importa; `comisionTx` es la comisión de la transacción pagara quien
    la pagara, solo para enseñarla. `propia` es la dirección de la wallet que
    intervino: con una xpub cambia de un movimiento a otro.
    """

    red: str
    hash: str
    fecha: datetime
    simbolo: str
    cantidad: Decimal
    comision: Decimal | None
    tipo: str
    contraparte: str = ""
    contrato: str = ""
    nota: str = ""
    comisionTx: Decimal | None = None
    propia: str = ""
    # Todas las contrapartes de la transacción cuando hay más de una (Bitcoin): solo
    # es «entre wallets» si todas son del usuario, no por la primera que se encuentre.
    contrapartes: tuple[str, ...] = ()


@dataclass(frozen=True)
class UtxoBitcoin:
    """Una salida de Bitcoin sin gastar de la wallet.

    `altura` y `fecha` son las del bloque que la confirmó; None si sigue en la
    mempool. `satoshis` va entero para que el cliente reparta el área del
    treemap sin redondeos; `cantidad` es lo mismo en BTC.
    """

    txid: str
    vout: int
    satoshis: int
    direccion: str
    altura: int | None
    fecha: datetime | None

    @property
    def cantidad(self) -> Decimal:
        return _unidades(self.satoshis, 8)


@dataclass(frozen=True)
class SaldoToken:
    """Saldo actual de un token ERC-20/BEP-20 de la wallet, en unidades del token.

    `simbolo` y `nombre` son los que declara el contrato: los elige quien lo
    crea, así que no dicen por sí solos si el token es auténtico.
    """

    contrato: str
    simbolo: str
    nombre: str
    cantidad: Decimal
    # None si la API da el saldo pero la fecha no está en el historial leído.
    ultimoMovimiento: datetime | None


class LectorWallet(Protocol):
    def leer(self, tipo: str, valor: str, limite: int) -> list[MovimientoWallet]:
        """Movimientos más recientes primero, como mucho `limite`."""

    def saldo(self, tipo: str, valor: str) -> Decimal:
        """Saldo confirmado de la moneda nativa, en unidades (no satoshis ni wei)."""


@dataclass(frozen=True)
class ComisionPagada:
    """Lo que pagó la wallet en moneda de la red por una transacción sin movimiento de esa moneda.

    Enviar un token, aprobarlo, operar en un DEX o una transacción fallida gastan
    moneda de la red sin moverla: no son un movimiento, pero bajan el saldo.
    """

    red: str
    hash: str
    fecha: datetime
    comision: Decimal


def leerConComisiones(lector: LectorWallet, tipo: str, valor: str,
                      limite: int) -> tuple[list[MovimientoWallet], list[ComisionPagada]]:
    """Los movimientos y las comisiones sueltas de una wallet, en una sola lectura.

    Bitcoin no tiene `leerConComisiones`: toda su comisión va en un movimiento.

    Returns:
        (movimientos como los de `leer`, comisiones sin movimiento de la moneda de la red).

    Raises:
        ErrorLecturaWallet: si la red no responde o responde un error.
    """
    if hasattr(lector, "leerConComisiones"):
        return lector.leerConComisiones(tipo, valor, limite)
    return lector.leer(tipo, valor, limite), []


def _unidades(entero: int, decimales: int) -> Decimal:
    return Decimal(int(entero)).scaleb(-int(decimales))


def _fecha(segundos: int | float) -> datetime:
    return datetime.fromtimestamp(int(segundos), timezone.utc)


def _comprobarUrl(url: str, nombre: str) -> str:
    partes = urlsplit(str(url or "").strip())
    if partes.scheme not in ("http", "https") or not partes.netloc:
        raise ErrorLecturaWallet(f"La URL de {nombre} en config.ini [wallets] no es válida")
    return url.strip().rstrip("/")


def conPlazo(obtenerJson: ObtenerJson, segundos: float) -> ObtenerJson:
    """`obtenerJson` que deja de hacer llamadas pasado el plazo.

    La sincronización corre dentro de la petición HTTP: una xpub con muchas
    direcciones sobre una red lenta podía pasar del timeout de gunicorn, que
    mata el worker sin respuesta. Con el plazo, el usuario recibe un mensaje.
    """
    limite = time.monotonic() + segundos

    def envuelto(*args, **kwargs):
        if time.monotonic() > limite:
            raise ErrorLecturaWallet(
                "La lectura de la wallet ha superado el tiempo máximo ([wallets] plazo_segundos). "
                "Prueba con un nodo propio o con menos movimientos."
            )
        return obtenerJson(*args, **kwargs)

    return envuelto


def _llamar(nombre: str, obtenerJson: ObtenerJson, *args, **kwargs):
    """fetchJson con los errores de red convertidos en un mensaje presentable."""
    try:
        return obtenerJson(*args, **kwargs)
    except HTTPError as error:
        if error.code == 429:
            raise ErrorLecturaWallet(f"{nombre} ha limitado las peticiones; prueba dentro de un rato") from error
        if error.code == 401:
            raise ErrorLecturaWallet(f"{nombre} rechaza la clave: revísala en Ajustes › API") from error
        raise ErrorLecturaWallet(f"{nombre} respondió HTTP {error.code}") from error
    except ProviderError as error:
        raise ErrorLecturaWallet(f"{nombre}: {error.message}") from error
    except (URLError, TimeoutError, OSError) as error:
        raise ErrorLecturaWallet(f"No se pudo conectar con {nombre}: {motivoConexion(error, nombre)}") from error


def estadoPorMensaje(mensaje: str) -> str:
    """El estado de `api_stats.recordApiResult` que indica el aviso de una API.

    Varias APIs contestan 200 con el motivo del fallo en el cuerpo.

    Args:
        mensaje: El aviso tal como lo da la API.

    Returns:
        ``limite``, ``clave``, ``plan`` o ``error``.

    Example:
        >>> estadoPorMensaje("Max calls per sec rate limit reached")
        'limite'
    """
    texto = str(mensaje).lower()
    if any(aviso in texto for aviso in ("rate limit", "too many", "slowdown", "exceeded")):
        return "limite"
    if "api key" in texto or "unauthorized" in texto:
        return "clave"
    if "not supported" in texto or "upgrade" in texto:
        return "plan"
    return "error"


def conProveedor(obtenerJson: ObtenerJson, nombre: str) -> ObtenerJson:
    """`obtenerJson` que anota sus llamadas y su resultado a nombre de `nombre`.

    Args:
        obtenerJson: La función que hace la petición.
        nombre: Uno de los `ESTADO_*`, la fila de Ajustes > API.

    Returns:
        Una función con la misma firma.
    """

    def envuelto(*args, **kwargs):
        return obtenerJson(*args, provider=nombre, **kwargs)

    return envuelto


# ── Bitcoin (Esplora) ─────────────────────────────────────────────────────────


def _destinosDeClave(claveHex: str) -> list[str]:
    """Direcciones y formas P2PK de una clave suelta: todo lo que puede cobrar con ella."""
    return direccionesDeClavePublica(claveHex) + clavesP2pk(claveHex)


def _esClaveP2pk(destino: str) -> bool:
    return len(destino) in _LARGOS_CLAVE_P2PK and all(c in "0123456789abcdef" for c in destino)


def _rutaEsplora(destino: str) -> str:
    """`address/…` para una dirección; `scripthash/…` para una clave cobrada por P2PK.

    Esplora no busca P2PK por dirección (no la tiene): se busca por el SHA-256
    del script, sin invertir, que es como lo indexa su /scripthash.
    """
    if not _esClaveP2pk(destino):
        return f"address/{quote(destino)}"
    clave = bytes.fromhex(destino)
    script = bytes([len(clave)]) + clave + _OP_CHECKSIG
    return f"scripthash/{hashlib.sha256(script).hexdigest()}"


# Tras fallar una Esplora, se va directo a la siguiente este rato: probar
# primero la caída en cada llamada añadía su espera a todas.
_ESPLORA_CAIDA_SEGUNDOS = 300.0
_esploraLock = threading.Lock()
_esploraCaidas: dict[str, float] = {}


def olvidarEsploraCaidas() -> None:
    """Borra qué Esploras se dieron por caídas. Para los tests."""
    with _esploraLock:
        _esploraCaidas.clear()
        _ritmosEsplora.clear()
    # El ritmo vive también en disco, y los tests comparten data/tmp.
    for marca in paths.TMP_DIR.glob("ritmo-esplora-*.marca"):
        marca.unlink(missing_ok=True)


# Un ritmo por URL base: cada Esplora pública limita por su cuenta, y un nodo
# propio con el intervalo a 0 no debe esperar por lo que se pide a las demás.
# La clave lleva el intervalo para que un cambio en config.ini se aplique solo.
_ritmosEsplora: dict[tuple[str, float], "RitmoCompartido"] = {}


def esperarTurnoEsplora(base: str, dormir: Callable[[float], None] = time.sleep) -> None:
    """Espera, si hace falta, para dejar `[wallets] esplora_intervalo_segundos` desde la anterior llamada a `base`.

    Lo comparten todos los hilos y procesos: la vigilancia y la de Satoshi (en
    Docker, en el worker), y «Actualizar» y el visor de UTXOs (en los workers de
    gunicorn). Las Esploras públicas cortan por ráfagas
    (429) y, tras muchas, dejan de aceptar conexiones desde la IP un tiempo.

    Args:
        base: URL base de la Esplora a la que se va a llamar.
        dormir: Inyectable para los tests.
    """
    intervalo = float(settings.walletsEsploraIntervalo())
    if intervalo <= 0:
        return
    with _esploraLock:
        clave = f"esplora-{hashlib.sha256(base.encode('utf-8')).hexdigest()[:16]}"
        ritmo = _ritmosEsplora.setdefault((base, intervalo), RitmoCompartido(clave, intervalo))
    espera = ritmo.turno()
    if espera > 0:
        dormir(espera)


def _ordenarEsploras(bases: list[str], ahora: float) -> list[str]:
    """Las URL de Esplora con las caídas hace poco al final, sin cambiar el resto del orden."""
    with _esploraLock:
        caidas = {base for base in bases if _esploraCaidas.get(base, 0.0) > ahora}
    return [b for b in bases if b not in caidas] + [b for b in bases if b in caidas]


def _anotarEsplora(base: str, funciona: bool, ahora: float) -> None:
    with _esploraLock:
        if funciona:
            _esploraCaidas.pop(base, None)
        else:
            _esploraCaidas[base] = ahora + _ESPLORA_CAIDA_SEGUNDOS


def _culpaDelServidor(error: ErrorLecturaWallet) -> bool:
    """Si el fallo es del servidor (red, 5xx, 429, respuesta ilegible) y otro podría responder.

    Un 4xx es culpa de lo pedido y el plazo agotado no tiene causa: otra
    Esplora contestaría lo mismo, o no queda tiempo para preguntarle.
    """
    causa = error.__cause__
    if isinstance(causa, HTTPError):
        return causa.code == 429 or causa.code >= 500
    return isinstance(causa, (URLError, TimeoutError, OSError))


def _destino(salida: dict) -> str:
    """La dirección de una salida, o su clave si es P2PK; '' si no tiene ninguna."""
    if salida.get("scriptpubkey_address"):
        return salida["scriptpubkey_address"]
    script = str(salida.get("scriptpubkey") or "").lower()
    if salida.get("scriptpubkey_type") == "p2pk" and script.endswith(_OP_CHECKSIG.hex()):
        return script[2:-2]
    return ""


def _destinosDistintos(partes: list[dict]) -> tuple[str, ...]:
    """Direcciones (o claves P2PK) de unas entradas o salidas, sin repetir y en su orden."""
    return tuple(dict.fromkeys(destino for destino in map(_destino, partes) if destino))


class LectorBitcoin:
    """Bitcoin por la API Esplora (mempool.space, blockstream.info o un nodo propio).

    Con una xpub se derivan en local las direcciones de recepción y de cambio
    hasta encontrar `gapLimit` seguidas sin uso, y el historial es la unión del
    de todas ellas. Las transacciones sin confirmar se dejan para la siguiente
    sincronización: todavía pueden cambiar o no confirmarse nunca.

    Si la Esplora principal falla por culpa suya (no conecta, 5xx, 429), la
    misma llamada se repite en la de respaldo, y durante unos minutos se va
    directo a esta. Todas sirven la misma cadena, así que mezclar respuestas
    de una y otra en una sincronización no cambia el resultado.
    """

    def __init__(self, baseUrl: str | None = None, gapLimit: int | None = None,
                 obtenerJson: ObtenerJson = fetchJson, respaldoUrl: str | None = None,
                 reloj: Callable[[], float] = time.monotonic,
                 dormir: Callable[[float], None] = time.sleep) -> None:
        """Crea el lector.

        Args:
            baseUrl: Esplora principal; por defecto, `[wallets] esplora_url`.
            gapLimit: Direcciones seguidas sin uso para dejar de explorar una xpub.
            obtenerJson: `fetchJson` o un doble para los tests.
            respaldoUrl: Esplora de respaldo. Por defecto, `[wallets]
                esplora_url_respaldo` si tampoco se dio `baseUrl`; con una
                `baseUrl` explícita y sin respaldo, no se usa ninguno.
            reloj: Reloj monotónico, inyectable para los tests.
            dormir: Espera del ritmo entre llamadas (`esperarTurnoEsplora`),
                inyectable para los tests.
        """
        self._baseUrl = baseUrl
        self._gapLimit = gapLimit
        self._obtenerJson = obtenerJson
        self._respaldoUrl = respaldoUrl
        self._reloj = reloj
        self._dormir = dormir
        # Direcciones usadas de cada xpub según `saldo`, para que `leer` no repita
        # la exploración: las dos comparten plazo y, al ritmo de una llamada por
        # segundo, 40 direcciones sin uso por pasada ya lo agotaban. No caduca
        # porque un lector dura una revisión: `lectorPara` le pone plazo.
        self._usadasXpub: dict[str, list[str]] = {}

    def _bases(self) -> list[str]:
        """Las URL de Esplora válidas, sin repetir: la principal y, si la hay, la de respaldo."""
        if self._baseUrl:
            respaldo = self._respaldoUrl
        else:
            respaldo = self._respaldoUrl or settings.walletsEsploraUrlRespaldo()
        bases = [_comprobarUrl(self._baseUrl or settings.walletsEsploraUrl(), "Esplora")]
        if respaldo:
            bases.append(_comprobarUrl(respaldo, "Esplora de respaldo"))
        return list(dict.fromkeys(bases))

    def _get(self, ruta: str):
        bases = _ordenarEsploras(self._bases(), self._reloj())
        for posicion, base in enumerate(bases):
            esperarTurnoEsplora(base, self._dormir)
            # Con otra Esplora detrás no se reintenta: los reintentos de una caída
            # gastaban 30 s del plazo de lectura antes de pasar a la que responde.
            reintentos = {} if posicion == len(bases) - 1 else {"retries": 0}
            try:
                datos = _llamar("Esplora", self._obtenerJson, f"{base}/{ruta}", **reintentos)
            except ErrorLecturaWallet as error:
                if posicion == len(bases) - 1 or not _culpaDelServidor(error):
                    raise
                _anotarEsplora(base, False, self._reloj())
                # Solo las URL base, que son configuración: nunca la ruta, que lleva la dirección.
                log.warning("[wallets] Esplora %s falla (%s); se usa %s", base, error, bases[posicion + 1])
                continue
            _anotarEsplora(base, True, self._reloj())
            principal = self._bases()[0]
            if base != principal:
                # fetchJson acaba de anotar «ok», que ocultaría que la principal falla.
                recordApiResult(ESTADO_ESPLORA, "ok",
                                f"Responde el respaldo ({urlsplit(base).netloc}); "
                                f"la principal ({urlsplit(principal).netloc}), no")
            return datos

    def leer(self, tipo: str, valor: str, limite: int) -> list[MovimientoWallet]:
        if tipo == TIPO_XPUB:
            historiales = self._historialesXpub(valor, limite)
        elif tipo == TIPO_CLAVE_PUBLICA:
            historiales = self._historialesClave(valor, limite)
        else:
            historiales = {valor: self._historial(valor, limite)[1]}
        propias = set(historiales)
        transacciones = {}
        for confirmadas in historiales.values():
            for tx in confirmadas:
                transacciones.setdefault(tx.get("txid"), tx)
        ordenadas = sorted(transacciones.values(), key=lambda tx: tx["status"]["block_time"], reverse=True)
        movimientos = (self._normalizar(tx, propias) for tx in ordenadas[:limite])
        return [m for m in movimientos if m is not None]

    def saldo(self, tipo: str, valor: str) -> Decimal:
        if tipo == TIPO_CLAVE_PUBLICA:
            return _unidades(sum(self._estadisticas(d)[1] for d in _destinosDeClave(valor)), 8)
        if tipo != TIPO_XPUB:
            return _unidades(self._estadisticas(valor)[1], 8)
        # Misma exploración por huecos que el historial, pero con /address, que
        # da el saldo de cada dirección en una sola llamada.
        clave = leerClaveExtendida(valor)
        gapLimit = self._gapLimit or settings.walletsGapLimit()
        total = 0
        usadas = []
        for rama in (RAMA_RECEPCION, RAMA_CAMBIO):
            nodoRama = clave.hijo(rama)
            sinUso = 0
            for indice in range(_MAX_INDICES_XPUB):
                if sinUso >= gapLimit:
                    break
                direccion = nodoRama.hijo(indice).direccion()
                usada, satoshis = self._estadisticas(direccion)
                total += satoshis
                sinUso = 0 if usada else sinUso + 1
                if usada:
                    usadas.append(direccion)
        self._usadasXpub[valor] = usadas
        return _unidades(total, 8)

    def direccionesUsadas(self, valor: str) -> list[str] | None:
        """Las direcciones con uso de una xpub según el último `saldo` de este lector.

        Args:
            valor: La xpub, tal como se pasó a `saldo`.

        Returns:
            Las direcciones, o None si este lector aún no ha explorado esa xpub.
        """
        return self._usadasXpub.get(valor)

    def utxos(self, tipo: str, valor: str) -> tuple[list[UtxoBitcoin], int]:
        """Las salidas sin gastar de la wallet, la mayor primero, y la altura actual.

        Incluye las que aún están en la mempool (altura None): son dinero que ya
        se ve llegar, y el visor las distingue.

        Args:
            tipo: TIPO_DIRECCION, TIPO_XPUB o TIPO_CLAVE_PUBLICA.
            valor: la dirección, la xpub o la clave pública en hexadecimal.

        Returns:
            (UTXOs ordenados de mayor a menor importe, altura del último bloque).

        Raises:
            ErrorLecturaWallet: si Esplora falla o responde algo inesperado.
        """
        if tipo == TIPO_XPUB:
            direcciones = self._direccionesConSalidasXpub(valor)
        elif tipo == TIPO_CLAVE_PUBLICA:
            direcciones = _destinosDeClave(valor)
        else:
            direcciones = [valor]
        utxos = [utxo for direccion in direcciones for utxo in self._utxosDe(direccion)]
        utxos.sort(key=lambda utxo: utxo.satoshis, reverse=True)
        return utxos, self._alturaActual()

    def _direccionesConSalidasXpub(self, xpub: str) -> list[str]:
        # La misma exploración por huecos que `saldo`, pero solo se pide /utxo
        # a las direcciones que tienen algo: una xpub usada deja muchas a cero.
        clave = leerClaveExtendida(xpub)
        gapLimit = self._gapLimit or settings.walletsGapLimit()
        conSalidas = []
        for rama in (RAMA_RECEPCION, RAMA_CAMBIO):
            nodoRama = clave.hijo(rama)
            sinUso = 0
            for indice in range(_MAX_INDICES_XPUB):
                if sinUso >= gapLimit:
                    break
                direccion = nodoRama.hijo(indice).direccion()
                usada, tieneSalidas = self._usoYSalidas(direccion)
                if tieneSalidas:
                    conSalidas.append(direccion)
                sinUso = 0 if usada else sinUso + 1
        return conSalidas

    def _usoYSalidas(self, direccion: str) -> tuple[bool, bool]:
        """(¿tiene transacciones?, ¿le queda alguna salida, confirmada o en la mempool?)."""
        info = self._get(f"address/{quote(direccion)}")
        if not isinstance(info, dict):
            raise ErrorLecturaWallet("Esplora devolvió una respuesta inesperada")
        cadena = info.get("chain_stats") or {}
        pendientes = info.get("mempool_stats") or {}
        usada = bool(int(cadena.get("tx_count", 0)) + int(pendientes.get("tx_count", 0)))
        # Un gasto en la mempool deja el saldo confirmado intacto, pero Esplora ya
        # no lista esa salida en /utxo: se mira lo que queda contando ambos.
        recibido = int(cadena.get("funded_txo_count", 0)) + int(pendientes.get("funded_txo_count", 0))
        gastado = int(cadena.get("spent_txo_count", 0)) + int(pendientes.get("spent_txo_count", 0))
        return usada, recibido > gastado

    def _utxosDe(self, direccion: str) -> list[UtxoBitcoin]:
        respuesta = self._get(f"{_rutaEsplora(direccion)}/utxo")
        if not isinstance(respuesta, list):
            raise ErrorLecturaWallet("Esplora devolvió una respuesta inesperada")
        return [utxo for utxo in (self._normalizarUtxo(dato, direccion) for dato in respuesta) if utxo is not None]

    @staticmethod
    def _normalizarUtxo(dato, direccion: str) -> UtxoBitcoin | None:
        if not isinstance(dato, dict) or not isinstance(dato.get("txid"), str):
            log.debug("[wallets] UTXO con forma inesperada descartado")
            return None
        estado = dato.get("status") or {}
        confirmado = bool(estado.get("confirmed")) and estado.get("block_height") is not None
        return UtxoBitcoin(
            txid=dato["txid"],
            vout=int(dato.get("vout", 0)),
            satoshis=int(dato.get("value", 0)),
            direccion=direccion,
            altura=int(estado["block_height"]) if confirmado else None,
            fecha=_fecha(estado["block_time"]) if confirmado and estado.get("block_time") else None,
        )

    def _alturaActual(self) -> int:
        # Esplora responde el número a pelo, que como JSON ya es un entero.
        altura = self._get("blocks/tip/height")
        if isinstance(altura, bool) or not isinstance(altura, int):
            raise ErrorLecturaWallet("Esplora devolvió una respuesta inesperada")
        return altura

    def _estadisticas(self, direccion: str) -> tuple[bool, int]:
        """(¿tiene transacciones?, saldo confirmado en satoshis)."""
        info = self._get(_rutaEsplora(direccion))
        if not isinstance(info, dict):
            raise ErrorLecturaWallet("Esplora devolvió una respuesta inesperada")
        cadena = info.get("chain_stats") or {}
        pendientes = info.get("mempool_stats") or {}
        usada = bool(int(cadena.get("tx_count", 0)) + int(pendientes.get("tx_count", 0)))
        return usada, int(cadena.get("funded_txo_sum", 0)) - int(cadena.get("spent_txo_sum", 0))

    def _historialesXpub(self, xpub: str, limite: int) -> dict[str, list]:
        # La primera página del historial ya dice si la dirección se ha usado:
        # pedir antes /address/{dir} solo para saberlo duplicaba las llamadas.
        usadas = self._usadasXpub.get(xpub)
        if usadas is not None:
            return {direccion: self._historial(direccion, limite)[1] for direccion in usadas}
        clave = leerClaveExtendida(xpub)
        gapLimit = self._gapLimit or settings.walletsGapLimit()
        historiales = {}
        for rama in (RAMA_RECEPCION, RAMA_CAMBIO):
            nodoRama = clave.hijo(rama)
            sinUso = 0
            for indice in range(_MAX_INDICES_XPUB):
                if sinUso >= gapLimit:
                    break
                direccion = nodoRama.hijo(indice).direccion()
                usada, confirmadas = self._historial(direccion, limite)
                if usada:
                    historiales[direccion] = confirmadas
                    sinUso = 0
                else:
                    sinUso += 1
        return historiales

    def _historialesClave(self, claveHex: str, limite: int) -> dict[str, list]:
        # Una clave suelta tiene un puñado fijo de direcciones (una por tipo) y
        # sus dos formas P2PK: se consultan todas y se quedan las que tienen uso.
        historiales = {}
        for direccion in _destinosDeClave(claveHex):
            usada, confirmadas = self._historial(direccion, limite)
            if usada:
                historiales[direccion] = confirmadas
        return historiales

    def _historial(self, direccion: str, limite: int) -> tuple[bool, list]:
        """(¿tiene alguna transacción, aunque sea sin confirmar?, las confirmadas)."""
        base = _rutaEsplora(direccion)
        ruta = f"{base}/txs"
        usada = False
        confirmadas = []
        while len(confirmadas) < limite:
            pagina = self._get(ruta)
            if not isinstance(pagina, list):
                raise ErrorLecturaWallet("Esplora devolvió una respuesta inesperada")
            usada = usada or bool(pagina)
            nuevas = [tx for tx in pagina if tx.get("status", {}).get("confirmed")]
            confirmadas += nuevas
            if len(nuevas) < _ESPLORA_PAGINA:
                break
            ruta = f"{base}/txs/chain/{quote(nuevas[-1]['txid'])}"
        return usada, confirmadas

    @staticmethod
    def _normalizar(tx: dict, propias: set) -> MovimientoWallet | None:
        entradas = [v.get("prevout") or {} for v in tx.get("vin", [])]
        salidas = tx.get("vout", [])
        entradaPropia = sum(int(e.get("value", 0)) for e in entradas if _destino(e) in propias)
        salidaPropia = sum(int(s.get("value", 0)) for s in salidas if _destino(s) in propias)
        externas = [s for s in salidas if _destino(s) not in propias]
        salidaExterna = sum(int(s.get("value", 0)) for s in externas)
        comision = _unidades(int(tx.get("fee", 0)), 8)
        comun = {"red": "btc", "hash": tx["txid"], "fecha": _fecha(tx["status"]["block_time"]), "simbolo": "BTC",
                 "comisionTx": comision}

        if entradaPropia:
            propia = next((_destino(e) for e in entradas if _destino(e) in propias), "")
            # Sin salida externa con valor pero tampoco propia, todo se fue en
            # comisión (p. ej. un barrido a OP_RETURN): no es un movimiento
            # entre wallets propias, sino un gasto.
            if not salidaExterna and salidaPropia:
                return MovimientoWallet(**comun, cantidad=_unidades(salidaPropia, 8), comision=comision,
                                        tipo=ENTRE_WALLETS, propia=propia)
            destinos = _destinosDistintos(externas)
            return MovimientoWallet(**comun, cantidad=_unidades(salidaExterna, 8), comision=comision,
                                    tipo=ENVIADA, contraparte=destinos[0] if destinos else "", propia=propia,
                                    contrapartes=destinos)
        if not salidaPropia:
            return None
        origenes = _destinosDistintos(entradas)
        propia = next((_destino(s) for s in salidas if _destino(s) in propias), "")
        return MovimientoWallet(**comun, cantidad=_unidades(salidaPropia, 8), comision=None,
                                tipo=RECIBIDA, contraparte=origenes[0] if origenes else "", propia=propia,
                                contrapartes=origenes)


# ── Ethereum y BNB Smart Chain (Etherscan v2) ────────────────────────────────


def estadoRespuestaEtherscan(respuesta) -> tuple[str, str] | None:
    """Estado del proveedor que deja una respuesta de Etherscan, si dice que falló.

    Etherscan contesta 200 también con la cuota agotada o la clave mal: el
    aviso va en el cuerpo, con `status` 0.

    Returns:
        (estado, detalle) con el estado de `api_stats.recordApiResult`, o None
        si la respuesta es buena (también «No transactions found»).

    Example:
        >>> estadoRespuestaEtherscan({"status": "0", "message": "NOTOK", "result": "Max rate limit reached"})
        ('limite', 'Max rate limit reached')
    """
    if not isinstance(respuesta, dict) or str(respuesta.get("status")) != "0":
        return None
    mensaje = str(respuesta.get("message") or "")
    if mensaje.startswith("No transactions found"):
        return None
    detalle = respuesta["result"] if isinstance(respuesta.get("result"), str) else mensaje
    return estadoPorMensaje(detalle), detalle


class Ritmo:
    """Separa las llamadas a una API un intervalo mínimo, entre todos los hilos.

    Cada llamada reserva su hueco con el cerrojo cogido y espera fuera de él,
    así los hilos hacen cola en orden sin bloquearse unos a otros mientras
    duermen.
    """

    def __init__(self, intervalo: float, reloj: Callable[[], float] = time.monotonic) -> None:
        self._intervalo = intervalo
        self._reloj = reloj
        self._siguiente = 0.0
        self._lock = threading.Lock()

    def turno(self) -> float:
        """Reserva el siguiente hueco libre.

        Returns:
            Segundos que hay que esperar antes de hacer la llamada (0 si ya toca).
        """
        with self._lock:
            ahora = self._reloj()
            hueco = max(ahora, self._siguiente)
            self._siguiente = hueco + self._intervalo
            return hueco - ahora


# Una marca más adelantada que esto no es una cola de llamadas, sino un reloj
# que ha cambiado: respetarla dejaría sin leer hasta que el reloj la alcance.
_colaMaximaSegundos = 300.0
_esperaBloqueoRitmo = 2.0


class RitmoCompartido(Ritmo):
    """Un `Ritmo` que se respeta también entre procesos.

    El límite de una API es por IP o por clave, no por proceso, y en Docker la
    llaman los dos workers de gunicorn y el servicio worker. El siguiente hueco
    libre se guarda en `data/tmp`, con el bloqueo de fichero de `core.bloqueo`.
    Se usa la hora del sistema porque `time.monotonic` no es comparable entre
    procesos; los contenedores comparten el reloj del host.

    Si el disco no deja coordinarse, se sigue con el ritmo de este proceso:
    mejor algún 429 que dejar de leer.
    """

    def __init__(self, clave: str, intervalo: float, reloj: Callable[[], float] = time.time) -> None:
        super().__init__(intervalo, reloj)
        self._clave = clave

    def _reservar(self, marca) -> float:
        """Reserva el hueco en `marca`. Hay que llamarla con el bloqueo cogido."""
        ahora = self._reloj()
        try:
            siguiente = float(marca.read_text("utf-8"))
        except (OSError, ValueError):
            siguiente = 0.0
        if siguiente - ahora > _colaMaximaSegundos:
            siguiente = 0.0
        hueco = max(ahora, siguiente)
        marca.write_text(f"{hueco + self._intervalo:.3f}", "utf-8")
        return hueco - ahora

    def turno(self) -> float:
        """Reserva el siguiente hueco libre entre todos los procesos.

        Returns:
            Segundos que hay que esperar antes de hacer la llamada (0 si ya toca).
        """
        # El cerrojo evita que los hilos de este proceso compitan por el fichero,
        # donde esperarían a base de reintentos.
        with self._lock:
            marca = paths.TMP_DIR / f"ritmo-{self._clave}.marca"
            try:
                with bloqueo.exclusivo(marca.with_suffix(".lock"), espera=_esperaBloqueoRitmo,
                                       obligatorio=False) as conseguido:
                    if conseguido:
                        return self._reservar(marca)
            except OSError as error:
                log.warning("[ritmo] No se pudo usar %s: %s", marca.name, error)
        return super().turno()


_RITMO_ETHERSCAN = RitmoCompartido("etherscan", _ETHERSCAN_INTERVALO)


def conRitmoEtherscan(obtenerJson: ObtenerJson, ritmo: Ritmo = _RITMO_ETHERSCAN,
                      dormir: Callable[[float], None] = time.sleep) -> ObtenerJson:
    """Envuelve `obtenerJson` para respetar el límite de llamadas de Etherscan.

    Espera su turno en `ritmo` antes de cada llamada y, si Etherscan contesta
    que se superó el límite, espera y repite hasta `_ETHERSCAN_REINTENTOS`
    veces; la última respuesta, buena o no, se devuelve tal cual.

    Args:
        obtenerJson: La función que hace la petición (fetchJson con su plazo).
        ritmo: Turnos compartidos; por defecto, el de todo el proceso.
        dormir: Inyectable para los tests.

    Returns:
        Una función con la misma firma que `obtenerJson`.
    """

    def envuelto(*args, **kwargs):
        for intento in range(_ETHERSCAN_REINTENTOS + 1):
            espera = ritmo.turno()
            if espera > 0:
                dormir(espera)
            respuesta = obtenerJson(*args, **kwargs)
            fallo = estadoRespuestaEtherscan(respuesta)
            if not fallo or fallo[0] != "limite" or intento == _ETHERSCAN_REINTENTOS:
                return respuesta
            log.info("Etherscan ha limitado las llamadas; reintento %d de %d", intento + 1, _ETHERSCAN_REINTENTOS)
            dormir(_ETHERSCAN_ESPERA_LIMITE)

    return envuelto



class LectorEvm:
    """Movimientos de la moneda nativa y de tokens ERC-20/BEP-20 por Etherscan v2.

    Una misma clave de Etherscan sirve para las dos cadenas, pero el plan
    gratuito no cubre BNB: ese aviso se traduce a qué hacer (`_errorEtherscan`).

    Las transferencias de tokens de valor cero se descartan: son el «address
    poisoning», que siembra el historial con direcciones parecidas a las tuyas.
    """

    def __init__(self, red: str, apiKey: str | None = None, obtenerJson: ObtenerJson = fetchJson) -> None:
        self._red = red
        self._apiKey = apiKey
        self._obtenerJson = obtenerJson

    def _peticion(self, params: dict):
        apiKey = self._apiKey or readEtherscanApiKey()
        if not apiKey:
            raise ErrorLecturaWallet(
                "Falta la clave de Etherscan: guárdala en «Wallets enlazadas» o define ETHERSCAN_API_KEY"
            )
        params = {"chainid": _ETHERSCAN_CADENAS[self._red], "module": "account", **params, "apikey": apiKey}
        estadoFila = _ESTADO_ETHERSCAN_POR_RED[self._red]
        respuesta = _llamar("Etherscan", self._obtenerJson, _ETHERSCAN_URL, params, provider=estadoFila)
        fallo = estadoRespuestaEtherscan(respuesta)
        if fallo:
            recordApiResult(estadoFila, *fallo)
        return respuesta

    def _errorEtherscan(self, detalle: object) -> ErrorLecturaWallet:
        """El error que ve el usuario: qué pasa y qué hacer, seguido del aviso original.

        El aviso se conserva porque es lo que hay que buscar o citar en el soporte
        de Etherscan si la explicación no basta.
        """
        texto = str(detalle)[:200]
        estado = estadoPorMensaje(texto)
        if estado == "plan" and self._red == "bnb":
            explicacion = ("El plan gratuito de Etherscan no incluye BNB Smart Chain; Ethereum sigue funcionando. "
                           "En Ajustes › API puedes elegir NodeReal para BNB o contratar un plan de pago de Etherscan.")
        elif estado == "plan":
            explicacion = "Tu plan de Etherscan no cubre esta consulta."
        elif estado == "limite":
            explicacion = "Etherscan ha limitado las peticiones; prueba dentro de un rato."
        elif estado == "clave":
            explicacion = "Etherscan rechaza la clave: revísala en Ajustes › API."
        else:
            return ErrorLecturaWallet(f"Etherscan: {texto}")
        mensaje = f"{explicacion} Aviso de Etherscan: {texto}"
        if estado == "plan":
            return ErrorFueraDePlan(mensaje, _ESTADO_ETHERSCAN_POR_RED[self._red])
        return ErrorLecturaWallet(mensaje)

    def saldo(self, tipo: str, valor: str) -> Decimal:
        respuesta = self._peticion({"action": "balance", "address": valor.lower(), "tag": "latest"})
        if not isinstance(respuesta, dict):
            raise ErrorLecturaWallet("Etherscan devolvió una respuesta inesperada")
        resultado = str(respuesta.get("result") or "")
        if str(respuesta.get("status")) != "1" or not resultado.isdigit():
            raise self._errorEtherscan(resultado or "respuesta inesperada")
        return _unidades(int(resultado), 18)

    def _consulta(self, accion: str, direccion: str, limite: int) -> list:
        respuesta = self._peticion({
            "action": accion, "address": direccion, "page": 1, "offset": limite, "sort": "desc",
        })
        if not isinstance(respuesta, dict):
            raise ErrorLecturaWallet("Etherscan devolvió una respuesta inesperada")
        if str(respuesta.get("status")) == "1" and isinstance(respuesta.get("result"), list):
            return respuesta["result"]
        mensaje = str(respuesta.get("message") or "")
        if mensaje.startswith("No transactions found"):
            return []
        detalle = respuesta.get("result") if isinstance(respuesta.get("result"), str) else mensaje
        raise self._errorEtherscan(detalle)

    def leer(self, tipo: str, valor: str, limite: int) -> list[MovimientoWallet]:
        return self.leerConComisiones(tipo, valor, limite)[0]

    def leerConComisiones(self, tipo: str, valor: str,
                          limite: int) -> tuple[list[MovimientoWallet], list[ComisionPagada]]:
        direccion = valor.lower()
        nativo = REDES[self._red].simbolo
        transacciones = self._consulta("txlist", direccion, limite)
        movimientos = [m for tx in transacciones if (m := self._normalizarNativo(tx, direccion, nativo))]
        conMovimiento = {m.hash for m in movimientos}
        comisiones = [c for tx in transacciones
                      if tx.get("hash") not in conMovimiento and (c := self._comisionSuelta(tx, direccion))]
        movimientos += [m for tx in self._consulta("tokentx", direccion, limite)
                        if (m := self._normalizarToken(tx, direccion, nativo))]
        movimientos.sort(key=lambda m: m.fecha, reverse=True)
        return movimientos[:limite], comisiones

    def _comisionSuelta(self, tx: dict, direccion: str) -> ComisionPagada | None:
        # De `txlist` y no de `tokentx`: ahí el «from» es el de la transferencia,
        # que un token de spam puede falsear con la dirección de la víctima. El
        # «from» de la transacción es quien la firmó y pagó su gas.
        comision = self._comision(tx)
        if str(tx.get("from") or "").lower() != direccion or not comision:
            return None
        return ComisionPagada(red=self._red, hash=tx["hash"], fecha=_fecha(tx["timeStamp"]), comision=comision)

    def saldosTokens(self, valor: str, maximo: int, historial: int) -> tuple[list[SaldoToken], int]:
        """Saldo actual de los tokens que aparecen en las transferencias de la wallet.

        Etherscan gratuito no lista los tokens de una dirección: se sacan de sus
        últimas `historial` transferencias y se pide el saldo de cada contrato.
        Si el historial cabe entero, los contratos cuyo neto (entrado menos
        salido) no es positivo se saltan, porque ya no queda nada; si no cabe, el
        neto no es fiable y solo sirve para pedir antes los que más prometen.

        Args:
            valor: Dirección de la wallet.
            maximo: Contratos cuyo saldo se pide como mucho (una llamada cada uno).
            historial: Transferencias de tokens que se leen para encontrarlos.

        Returns:
            (tokens con saldo, en el orden en que se piden: primero los que el
            historial da con saldo y, dentro de cada grupo, de más a menos
            reciente; contratos que se quedaron sin leer por `maximo`).

        Raises:
            ErrorLecturaWallet: si Etherscan falla o responde algo inesperado.
        """
        direccion = valor.lower()
        candidatos = self._tokensDelHistorial(direccion, historial)
        leidos = candidatos[:maximo]
        saldos = []
        for token in leidos:
            crudo = self._saldoTokenCrudo(direccion, token["contrato"])
            if crudo > 0:
                saldos.append(SaldoToken(
                    contrato=token["contrato"], simbolo=token["simbolo"], nombre=token["nombre"],
                    cantidad=_unidades(crudo, token["decimales"]), ultimoMovimiento=_fecha(token["ultimo"]),
                ))
        return saldos, len(candidatos) - len(leidos)

    def _tokensDelHistorial(self, direccion: str, historial: int) -> list[dict]:
        transferencias = self._consulta("tokentx", direccion, historial)
        completo = len(transferencias) < historial
        tokens: dict[str, dict] = {}
        for tx in transferencias:
            valor = int(tx.get("value") or 0)
            sentido = self._sentido(tx, direccion)
            contrato = str(tx.get("contractAddress") or "").lower()
            # Las de valor cero son «address poisoning», como en el historial.
            if not valor or sentido is None or not contrato:
                continue
            token = tokens.setdefault(contrato, {
                "contrato": contrato,
                "simbolo": self._simboloToken(tx),
                "nombre": str(tx.get("tokenName") or "").strip()[:_MAX_LARGO_NOMBRE_TOKEN],
                "decimales": int(tx.get("tokenDecimal") or 0),
                "neto": 0,
                "ultimo": 0,
            })
            if sentido[0] == RECIBIDA:
                token["neto"] += valor
            elif sentido[0] == ENVIADA:
                token["neto"] -= valor
            token["ultimo"] = max(token["ultimo"], int(tx.get("timeStamp") or 0))
        lista = [t for t in tokens.values() if t["simbolo"] and (not completo or t["neto"] > 0)]
        lista.sort(key=lambda t: (t["neto"] > 0, t["ultimo"]), reverse=True)
        return lista

    def _saldoTokenCrudo(self, direccion: str, contrato: str) -> int:
        respuesta = self._peticion({
            "action": "tokenbalance", "contractaddress": contrato, "address": direccion, "tag": "latest",
        })
        if not isinstance(respuesta, dict):
            raise ErrorLecturaWallet("Etherscan devolvió una respuesta inesperada")
        resultado = str(respuesta.get("result") or "")
        if str(respuesta.get("status")) != "1" or not resultado.isdigit():
            raise self._errorEtherscan(resultado or "respuesta inesperada")
        return int(resultado)

    @staticmethod
    def _simboloToken(tx: dict) -> str:
        return "".join(c for c in str(tx.get("tokenSymbol") or "") if c.isalnum()).upper()[:_MAX_LARGO_SIMBOLO]

    @staticmethod
    def _comision(tx: dict) -> Decimal:
        return _unidades(int(tx.get("gasUsed") or 0) * int(tx.get("gasPrice") or 0), 18)

    @staticmethod
    def _sentido(tx: dict, direccion: str) -> tuple[str, str] | None:
        origen = str(tx.get("from") or "").lower()
        destino = str(tx.get("to") or "").lower()
        if origen == direccion and destino == direccion:
            return ENTRE_WALLETS, ""
        if origen == direccion:
            return ENVIADA, destino or str(tx.get("contractAddress") or "").lower()
        if destino == direccion:
            return RECIBIDA, origen
        return None

    def _normalizarNativo(self, tx: dict, direccion: str, nativo: str) -> MovimientoWallet | None:
        valor = int(tx.get("value") or 0)
        sentido = self._sentido(tx, direccion)
        # Las llamadas a contratos sin valor (aprobar, operar en un DEX) no
        # mueven la moneda nativa; su comisión aparece en el movimiento del token.
        if str(tx.get("isError")) == "1" or not valor or sentido is None:
            return None
        tipo, contraparte = sentido
        comision = self._comision(tx)
        return MovimientoWallet(
            red=self._red, hash=tx["hash"], fecha=_fecha(tx["timeStamp"]), simbolo=nativo,
            cantidad=_unidades(valor, 18), comision=None if tipo == RECIBIDA else comision,
            tipo=tipo, contraparte=contraparte, comisionTx=comision, propia=direccion,
        )

    def _normalizarToken(self, tx: dict, direccion: str, nativo: str) -> MovimientoWallet | None:
        valor = int(tx.get("value") or 0)
        sentido = self._sentido(tx, direccion)
        simbolo = "".join(c for c in str(tx.get("tokenSymbol") or "") if c.isalnum()).upper()[:_MAX_LARGO_SIMBOLO]
        if not valor or sentido is None or not simbolo:
            return None
        tipo, contraparte = sentido
        contrato = str(tx.get("contractAddress") or "").lower()
        nota = f"Token {contrato}"
        if tipo != RECIBIDA:
            nota += f" · comisión de red {format(self._comision(tx).normalize(), 'f')} {nativo}"
        return MovimientoWallet(
            red=self._red, hash=tx["hash"], fecha=_fecha(tx["timeStamp"]), simbolo=simbolo,
            cantidad=_unidades(valor, int(tx.get("tokenDecimal") or 0)), comision=None,
            tipo=tipo, contraparte=contraparte, contrato=contrato, nota=nota,
            comisionTx=self._comision(tx), propia=direccion,
        )


# ── BNB Smart Chain (NodeReal) ───────────────────────────────────────────────


def _entero(valor: object) -> int:
    """Un entero de NodeReal: número, hexadecimal con `0x` o decimal sin él.

    Su documentación mezcla las tres formas (`gasPrice` 5000000000, `value`
    "0x0", `decimal` "18").

    Raises:
        ValueError: si no es ninguna de ellas.
        TypeError: si es de un tipo que no admite conversión.
    """
    if isinstance(valor, str):
        texto = valor.strip().lower()
        return int(texto, 16) if texto.startswith("0x") else int(texto)
    return int(valor)


class LectorBnbNodeReal(LectorEvm):
    """Wallets de BNB Smart Chain por las API de NodeReal.

    Patrón Adapter: traduce cada transferencia a la forma de Etherscan y reutiliza
    la normalización de `LectorEvm`, para que un mismo movimiento quede igual
    venga de una API o de otra.

    Limitación: NodeReal solo da el gas de las transacciones `external`, así que
    en un envío de tokens se desconoce la comisión de red. El saldo no se ve
    afectado, porque se pide directamente a la cadena.
    """

    def __init__(self, apiKey: str | None = None, obtenerJson: ObtenerJson = fetchJson) -> None:
        super().__init__("bnb", apiKey=apiKey, obtenerJson=obtenerJson)

    def _rpc(self, metodo: str, params: list):
        apiKey = self._apiKey or readNodeRealApiKey()
        if not apiKey:
            raise ErrorLecturaWallet(
                "Falta la clave de NodeReal: guárdala en Ajustes › API o define NODEREAL_API_KEY"
            )
        respuesta = _llamar("NodeReal", self._obtenerJson, urlNodeReal(apiKey), provider=ESTADO_BNB, jsonBody={
            "jsonrpc": "2.0", "id": 1, "method": metodo, "params": params,
        })
        if not isinstance(respuesta, dict):
            raise ErrorLecturaWallet("NodeReal devolvió una respuesta inesperada")
        error = respuesta.get("error")
        if error:
            detalle = str(error.get("message") if isinstance(error, dict) else error)[:200]
            estado = estadoPorMensaje(detalle)
            recordApiResult(ESTADO_BNB, estado, detalle)
            if estado == "plan":
                raise ErrorFueraDePlan(f"NodeReal: {detalle}", ESTADO_BNB)
            raise ErrorLecturaWallet(f"NodeReal: {detalle}")
        return respuesta.get("result")

    def saldo(self, tipo: str, valor: str) -> Decimal:
        try:
            return _unidades(_entero(self._rpc("eth_getBalance", [valor.lower(), "latest"])), 18)
        except (TypeError, ValueError) as error:
            raise ErrorLecturaWallet("NodeReal devolvió un saldo inesperado") from error

    def _consulta(self, accion: str, direccion: str, limite: int) -> list:
        """Las transferencias de la dirección, con la forma de la acción de Etherscan."""
        categoria = _NODEREAL_CATEGORIAS[accion]
        filas: list[dict] = []
        pagina = None
        while len(filas) < limite:
            # Sin rango de bloques: con él, NodeReal limita la consulta a 1000
            # bloques, unos minutos de cadena, y aquí se quiere el historial.
            params = {"category": [categoria], "address": direccion, "order": "desc", "excludeZeroValue": False,
                      "maxCount": hex(min(_NODEREAL_MAX_PAGINA, limite - len(filas)))}
            if pagina:
                params["pageKey"] = pagina
            resultado = self._rpc("nr_getTransactionByAddress", [params]) or {}
            if not isinstance(resultado, dict):
                raise ErrorLecturaWallet("NodeReal devolvió una respuesta inesperada")
            transferencias = resultado.get("transfers") or []
            filas += [f for t in transferencias if (f := self._comoEtherscan(t, categoria))]
            pagina = resultado.get("pageKey")
            if not pagina or not transferencias:
                break
        return filas[:limite]

    @staticmethod
    def _comoEtherscan(transferencia: dict, categoria: str) -> dict | None:
        if str(transferencia.get("category")) != categoria:
            return None
        # La documentación escribe el campo de las dos formas.
        marca = transferencia.get("blockTimeStamp", transferencia.get("blockTimestamp"))
        try:
            fila = {
                "hash": transferencia["hash"], "timeStamp": _entero(marca),
                "from": transferencia.get("from"), "to": transferencia.get("to"),
                "value": _entero(transferencia.get("value") or 0),
                "gasUsed": _entero(transferencia.get("gasUsed") or 0),
                "gasPrice": _entero(transferencia.get("gasPrice") or 0),
                "isError": "1" if transferencia.get("receiptsStatus") == 0 else "0",
            }
            if categoria == _NODEREAL_CATEGORIAS["txlist"]:
                return fila
            # Sin decimales el importe podría salir multiplicado por 10^18.
            if transferencia.get("decimal") is None:
                return None
            return fila | {"contractAddress": transferencia.get("contractAddress"),
                           "tokenSymbol": transferencia.get("asset"), "tokenName": "",
                           "tokenDecimal": _entero(transferencia["decimal"])}
        except (AttributeError, KeyError, TypeError, ValueError) as error:
            raise ErrorLecturaWallet("NodeReal devolvió una respuesta inesperada") from error

    def _normalizarToken(self, tx: dict, direccion: str, nativo: str) -> MovimientoWallet | None:
        movimiento = super()._normalizarToken(tx, direccion, nativo)
        # El «0» de gas de un token significa «no lo sé»: no se enseña como comisión.
        return movimiento and replace(movimiento, nota=f"Token {movimiento.contrato}", comisionTx=None)

    def saldosTokens(self, valor: str, maximo: int, historial: int) -> tuple[list[SaldoToken], int]:
        """Saldos actuales de los tokens, de `nr_getTokenHoldings`.

        Args:
            valor: Dirección de la wallet.
            maximo: Tokens que se devuelven como mucho.
            historial: Transferencias que se leen para fechar el último movimiento.

        Returns:
            (tokens con saldo, tokens que quedan por leer).

        Raises:
            ErrorLecturaWallet: si NodeReal falla o responde algo inesperado.
        """
        direccion = valor.lower()
        tenencias, total = self._tenencias(direccion, maximo)
        ultimos: dict[str, int] = {}
        for tx in self._consulta("tokentx", direccion, historial):
            contrato = str(tx.get("contractAddress") or "").lower()
            ultimos[contrato] = max(ultimos.get(contrato, 0), tx["timeStamp"])
        saldos = [self._saldoDeTenencia(t, ultimos) for t in tenencias[:maximo]]
        return [s for s in saldos if s], max(0, total - min(len(tenencias), maximo))

    def _tenencias(self, direccion: str, maximo: int) -> tuple[list[dict], int]:
        tenencias: list[dict] = []
        total = 0
        numero = 1
        while len(tenencias) < maximo:
            resultado = self._rpc("nr_getTokenHoldings", [direccion, hex(numero), hex(_NODEREAL_MAX_PAGINA_TOKENS)]) or {}
            try:
                total = _entero(resultado.get("totalCount") or 0)
                pagina = resultado.get("details") or []
            except (AttributeError, TypeError, ValueError) as error:
                raise ErrorLecturaWallet("NodeReal devolvió una respuesta inesperada") from error
            tenencias += pagina
            if not pagina or len(tenencias) >= total:
                break
            numero += 1
        return tenencias, total

    def _saldoDeTenencia(self, tenencia: dict, ultimos: dict[str, int]) -> SaldoToken | None:
        try:
            contrato = str(tenencia.get("tokenAddress") or "").lower()
            crudo = _entero(tenencia.get("tokenBalance") or 0)
            # «tokenDecimails» es como lo escribe NodeReal en su documentación.
            decimales = tenencia.get("tokenDecimails", tenencia.get("tokenDecimals"))
            simbolo = self._simboloToken(tenencia)
            if not crudo or not contrato or not simbolo or decimales is None:
                return None
            ultimo = ultimos.get(contrato)
            return SaldoToken(
                contrato=contrato, simbolo=simbolo,
                nombre=str(tenencia.get("tokenName") or "").strip()[:_MAX_LARGO_NOMBRE_TOKEN],
                cantidad=_unidades(crudo, _entero(decimales)),
                ultimoMovimiento=_fecha(ultimo) if ultimo else None,
            )
        except (AttributeError, TypeError, ValueError) as error:
            raise ErrorLecturaWallet("NodeReal devolvió una respuesta inesperada") from error


def urlNodeReal(apiKey: str) -> str:
    """La URL de NodeReal con la clave en la ruta, que es como la pide su API.

    Quien la use no debe registrarla en logs ni mensajes: contiene la clave.
    """
    return _NODEREAL_URL.format(clave=quote(str(apiKey), safe=""))


_RITMO_NODEREAL = RitmoCompartido("nodereal", _NODEREAL_INTERVALO)


def conRitmoNodeReal(obtenerJson: ObtenerJson, ritmo: Ritmo = _RITMO_NODEREAL,
                     dormir: Callable[[float], None] = time.sleep) -> ObtenerJson:
    """Envuelve `obtenerJson` para espaciar las llamadas a NodeReal.

    Args:
        obtenerJson: La función que hace la petición.
        ritmo: Turnos compartidos; por defecto, el de todo el proceso.
        dormir: Inyectable para los tests.

    Returns:
        Una función con la misma firma que `obtenerJson`.
    """

    def envuelto(*args, **kwargs):
        espera = ritmo.turno()
        if espera > 0:
            dormir(espera)
        return obtenerJson(*args, **kwargs)

    return envuelto


# ── Solana (RPC JSON) ─────────────────────────────────────────────────────────


class LectorSolana:
    """SOL nativo por el RPC JSON de Solana.

    Los tokens SPL no se leen: el símbolo de un token SPL no viaja en la
    transacción, y sacarlo exigiría un registro externo de metadatos.
    """

    def __init__(self, rpcUrl: str | None = None, obtenerJson: ObtenerJson = fetchJson) -> None:
        self._rpcUrl = rpcUrl
        self._obtenerJson = obtenerJson

    def _url(self) -> str:
        return _comprobarUrl(self._rpcUrl or settings.walletsSolanaRpcUrl(), "Solana RPC")

    def _rpc(self, metodo: str, params: list):
        respuesta = _llamar("Solana RPC", self._obtenerJson, self._url(),
                            jsonBody={"jsonrpc": "2.0", "id": 1, "method": metodo, "params": params})
        if not isinstance(respuesta, dict):
            raise ErrorLecturaWallet("Solana RPC devolvió una respuesta inesperada")
        if respuesta.get("error"):
            detalle = str(respuesta['error'].get('message', 'error'))[:200]
            recordApiResult(ESTADO_SOLANA, estadoPorMensaje(detalle), detalle)
            raise ErrorLecturaWallet(f"Solana RPC: {detalle}")
        return respuesta.get("result")

    def saldo(self, tipo: str, valor: str) -> Decimal:
        resultado = self._rpc("getBalance", [valor, {"commitment": "finalized"}])
        lamports = resultado.get("value") if isinstance(resultado, dict) else None
        if not isinstance(lamports, int):
            raise ErrorLecturaWallet("Solana RPC devolvió un saldo inesperado")
        return _unidades(lamports, 9)

    def leer(self, tipo: str, valor: str, limite: int) -> list[MovimientoWallet]:
        return self.leerConComisiones(tipo, valor, limite)[0]

    def leerConComisiones(self, tipo: str, valor: str,
                          limite: int) -> tuple[list[MovimientoWallet], list[ComisionPagada]]:
        movimientos, comisiones = [], []
        for firma, tx in self._transacciones(self._firmas(valor, limite)):
            movimiento = self._normalizar(tx, firma, valor)
            if movimiento is not None:
                movimientos.append(movimiento)
            elif (comision := self._comisionSuelta(tx, firma, valor)) is not None:
                comisiones.append(comision)
        return movimientos, comisiones

    @staticmethod
    def _comisionSuelta(tx: dict, firma: str, direccion: str) -> ComisionPagada | None:
        # La primera cuenta de una transacción de Solana es la que paga la comisión.
        meta = tx.get("meta") or {}
        claves = [k.get("pubkey") if isinstance(k, dict) else k
                  for k in tx.get("transaction", {}).get("message", {}).get("accountKeys", [])]
        comision = int(meta.get("fee", 0))
        if meta.get("err") is not None or not tx.get("blockTime") or not comision or claves[:1] != [direccion]:
            return None
        return ComisionPagada(red="sol", hash=firma, fecha=_fecha(tx["blockTime"]), comision=_unidades(comision, 9))

    def _firmas(self, direccion: str, limite: int) -> list[str]:
        firmas = []
        antes = None
        while len(firmas) < limite:
            opciones = {"limit": min(_SOLANA_MAX_FIRMAS, limite - len(firmas)), "commitment": "finalized"}
            if antes:
                opciones["before"] = antes
            pagina = self._rpc("getSignaturesForAddress", [direccion, opciones]) or []
            firmas += [f["signature"] for f in pagina if f.get("err") is None]
            if len(pagina) < opciones["limit"]:
                break
            antes = pagina[-1]["signature"]
        return firmas[:limite]

    def _transacciones(self, firmas: list[str]):
        opciones = {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0, "commitment": "finalized"}
        for inicio in range(0, len(firmas), _SOLANA_LOTE):
            lote = firmas[inicio:inicio + _SOLANA_LOTE]
            peticiones = [{"jsonrpc": "2.0", "id": i, "method": "getTransaction", "params": [f, opciones]}
                          for i, f in enumerate(lote)]
            respuesta = _llamar("Solana RPC", self._obtenerJson, self._url(), jsonBody=peticiones)
            if isinstance(respuesta, list):
                porId = {r.get("id"): r.get("result") for r in respuesta if isinstance(r, dict)}
                for i, firma in enumerate(lote):
                    if porId.get(i):
                        yield firma, porId[i]
                continue
            # Hay RPC que no aceptan peticiones por lotes: una a una.
            for firma in lote:
                tx = self._rpc("getTransaction", [firma, opciones])
                if tx:
                    yield firma, tx

    @staticmethod
    def _normalizar(tx: dict, firma: str, direccion: str) -> MovimientoWallet | None:
        meta = tx.get("meta") or {}
        if meta.get("err") is not None or not tx.get("blockTime"):
            return None
        claves = [k.get("pubkey") if isinstance(k, dict) else k
                  for k in tx.get("transaction", {}).get("message", {}).get("accountKeys", [])]
        if direccion not in claves:
            return None
        posicion = claves.index(direccion)
        deltas = [post - pre for pre, post in zip(meta.get("preBalances", []), meta.get("postBalances", []))]
        if posicion >= len(deltas):
            return None
        pagaComision = posicion == 0
        comision = int(meta.get("fee", 0)) if pagaComision else 0
        neto = deltas[posicion] + comision
        if not neto:
            return None
        otras = [(d, claves[i]) for i, d in enumerate(deltas) if i != posicion and i < len(claves)]
        comun = {"red": "sol", "hash": firma, "fecha": _fecha(tx["blockTime"]), "simbolo": "SOL",
                 "comisionTx": _unidades(int(meta.get("fee", 0)), 9), "propia": direccion}
        if neto < 0:
            contraparte = max(otras, default=(0, ""))[1]
            return MovimientoWallet(**comun, cantidad=_unidades(-neto, 9),
                                    comision=_unidades(comision, 9) if pagaComision else None,
                                    tipo=ENVIADA, contraparte=contraparte)
        contraparte = min(otras, default=(0, ""))[1]
        return MovimientoWallet(**comun, cantidad=_unidades(neto, 9), comision=None,
                                tipo=RECIBIDA, contraparte=contraparte)


# ── XRP Ledger (RPC JSON de rippled) ─────────────────────────────────────────


class LectorXrp:
    """Pagos en XRP por `account_tx`. Los pagos en otras divisas del ledger se ignoran."""

    def __init__(self, rpcUrl: str | None = None, obtenerJson: ObtenerJson = fetchJson) -> None:
        self._rpcUrl = rpcUrl
        self._obtenerJson = obtenerJson

    def _url(self) -> str:
        return _comprobarUrl(self._rpcUrl or settings.walletsXrplRpcUrl(), "XRPL")

    def saldo(self, tipo: str, valor: str) -> Decimal:
        respuesta = _llamar("XRPL", self._obtenerJson, self._url(), jsonBody={
            "method": "account_info", "params": [{"account": valor, "ledger_index": "validated"}],
        })
        resultado = respuesta.get("result", {}) if isinstance(respuesta, dict) else {}
        if resultado.get("error") == "actNotFound":
            return Decimal(0)
        drops = (resultado.get("account_data") or {}).get("Balance")
        if resultado.get("status") != "success" or not str(drops).isdigit():
            raise self._errorXrpl(resultado)
        return _unidades(int(drops), 6)

    @staticmethod
    def _errorXrpl(resultado: dict) -> ErrorLecturaWallet:
        """Anota en Ajustes > API el fallo que viene en el cuerpo y prepara el error."""
        detalle = str(resultado.get("error_message") or resultado.get("error") or "respuesta inesperada")[:200]
        recordApiResult(ESTADO_XRPL, estadoPorMensaje(detalle), detalle)
        return ErrorLecturaWallet(f"XRPL: {detalle}")

    def leer(self, tipo: str, valor: str, limite: int) -> list[MovimientoWallet]:
        return self.leerConComisiones(tipo, valor, limite)[0]

    def leerConComisiones(self, tipo: str, valor: str,
                          limite: int) -> tuple[list[MovimientoWallet], list[ComisionPagada]]:
        url = self._url()
        movimientos, comisiones = [], []
        marcador = None
        leidas = 0
        while leidas < limite:
            params = {"account": valor, "ledger_index_min": -1, "ledger_index_max": -1,
                      "limit": min(_XRPL_MAX_PAGINA, limite - leidas), "forward": False}
            if marcador is not None:
                params["marker"] = marcador
            respuesta = _llamar("XRPL", self._obtenerJson, url,
                                jsonBody={"method": "account_tx", "params": [params]})
            resultado = respuesta.get("result", {}) if isinstance(respuesta, dict) else {}
            if resultado.get("status") != "success":
                if resultado.get("error") == "actNotFound":
                    return [], []
                raise self._errorXrpl(resultado)
            entradas = resultado.get("transactions", [])
            leidas += len(entradas)
            for entrada in entradas:
                movimiento = self._normalizar(entrada, valor)
                if movimiento is not None:
                    movimientos.append(movimiento)
                elif (comision := self._comisionSuelta(entrada, valor)) is not None:
                    comisiones.append(comision)
            marcador = resultado.get("marker")
            if marcador is None or not entradas:
                break
        return movimientos, comisiones

    @staticmethod
    def _comisionSuelta(entrada: dict, direccion: str) -> ComisionPagada | None:
        # Las líneas de confianza, los pagos en otra divisa y los fallidos con
        # código «tec» también cobran la comisión a quien los firma.
        tx = entrada.get("tx") or entrada.get("tx_json") or {}
        comision = int(tx.get("Fee") or 0)
        if tx.get("Account") != direccion or not comision or "date" not in tx:
            return None
        return ComisionPagada(red="xrp", hash=tx.get("hash") or entrada.get("hash", ""),
                              fecha=_fecha(int(tx["date"]) + _XRPL_EPOCA), comision=_unidades(comision, 6))

    @staticmethod
    def _normalizar(entrada: dict, direccion: str) -> MovimientoWallet | None:
        tx = entrada.get("tx") or entrada.get("tx_json") or {}
        meta = entrada.get("meta") or {}
        if tx.get("TransactionType") != "Payment" or meta.get("TransactionResult") != "tesSUCCESS":
            return None
        entregado = meta.get("delivered_amount", tx.get("Amount"))
        # Un importe en drops es una cadena; un objeto es otra divisa del ledger.
        if not isinstance(entregado, str) or "date" not in tx:
            return None
        # Los pagos parciales antiguos traen «unavailable»: no se estima con
        # `Amount`, que puede ser mayor que lo que llegó de verdad.
        if not entregado.isdecimal():
            log.warning("[wallets] XRPL: pago %s sin importe entregado conocido; se omite",
                        tx.get("hash") or entrada.get("hash", ""))
            return None
        origen, destino = tx.get("Account", ""), tx.get("Destination", "")
        comision = _unidades(int(tx.get("Fee", 0)), 6)
        comun = {"red": "xrp", "hash": tx.get("hash") or entrada.get("hash", ""),
                 "fecha": _fecha(int(tx["date"]) + _XRPL_EPOCA), "simbolo": "XRP",
                 "cantidad": _unidades(int(entregado), 6), "comisionTx": comision, "propia": direccion}
        if origen == direccion and destino == direccion:
            return MovimientoWallet(**comun, comision=comision, tipo=ENTRE_WALLETS)
        if origen == direccion:
            return MovimientoWallet(**comun, comision=comision, tipo=ENVIADA, contraparte=destino)
        if destino == direccion:
            return MovimientoWallet(**comun, comision=None, tipo=RECIBIDA, contraparte=origen)
        return None


# ── Factory ───────────────────────────────────────────────────────────────────

def _lectorBnb(obtener: ObtenerJson) -> LectorEvm:
    """El lector de BNB de la API elegida en Ajustes (patrón Strategy)."""
    if proveedor_bnb.actual() == proveedor_bnb.NODEREAL:
        return LectorBnbNodeReal(obtenerJson=conRitmoNodeReal(obtener))
    return LectorEvm("bnb", obtenerJson=conRitmoEtherscan(obtener))


_FABRICAS: dict[str, Callable[[ObtenerJson], LectorWallet]] = {
    "btc": lambda obtener: LectorBitcoin(obtenerJson=conProveedor(obtener, ESTADO_ESPLORA)),
    "eth": lambda obtener: LectorEvm("eth", obtenerJson=conRitmoEtherscan(obtener)),
    "bnb": _lectorBnb,
    "sol": lambda obtener: LectorSolana(obtenerJson=conProveedor(obtener, ESTADO_SOLANA)),
    "xrp": lambda obtener: LectorXrp(obtenerJson=conProveedor(obtener, ESTADO_XRPL)),
}


def lectorPara(red: str, plazoSegundos: int | None = None) -> LectorWallet:
    """El lector de movimientos de una red, con el plazo de [wallets] ya aplicado.

    Args:
        red: Clave de la red.
        plazoSegundos: Plazo de la lectura; por defecto, `[wallets] plazo_segundos`,
            el de una lectura dentro de una petición HTTP.

    Raises:
        ErrorLecturaWallet: si la red no está soportada.
    """
    fabrica = _FABRICAS.get(red)
    if fabrica is None:
        raise ErrorLecturaWallet("Red no soportada")
    return fabrica(conPlazo(fetchJson, plazoSegundos or settings.walletsPlazoSegundos()))


def lectorUtxos() -> LectorBitcoin:
    """El lector de Bitcoin para el visor de UTXOs, con el plazo de [wallets] aplicado.

    Aparte de `lectorPara` porque los UTXOs solo existen en Bitcoin y no forman
    parte del contrato común `LectorWallet`.
    """
    obtener = conProveedor(conPlazo(fetchJson, settings.walletsPlazoSegundos()), ESTADO_ESPLORA)
    return LectorBitcoin(obtenerJson=obtener)


def redesConTokens() -> frozenset[str]:
    """Las redes cuyo visor de tokens funciona: las EVM, sea cual sea su API."""
    return frozenset(_ETHERSCAN_CADENAS)


def cadenasEvm() -> dict[str, int]:
    """El chainId EVM de cada red con tokens, por clave de red."""
    return dict(_ETHERSCAN_CADENAS)


def lectorTokens(red: str) -> LectorEvm:
    """El lector de la red para el visor de tokens, con el plazo de [wallets] aplicado.

    Raises:
        ErrorLecturaWallet: si la red no tiene visor de tokens.
    """
    if red not in _ETHERSCAN_CADENAS:
        raise ErrorLecturaWallet("Esta red no tiene visor de tokens")
    return _FABRICAS[red](conPlazo(fetchJson, settings.walletsPlazoSegundos()))
