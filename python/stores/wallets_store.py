"""Wallets enlazadas: las propias, cifradas en API/wallets.key; las ajenas, en API/wallets_ajenas.json.

Las ajenas (la de Satoshi, un exchange, una ballena) son direcciones públicas de
otros y no dicen nada del dinero del usuario: van en un JSON aparte, sin cifrar
y sin necesitar SECRET_KEY, para que wallets.key guarde solo lo suyo. Lo que hay
que saber de las dos sigue igual: el resto del código ve una sola lista.

Una xpub no permite gastar, pero quien la tenga ve todas las direcciones de la
wallet, su saldo y cada movimiento pasado y futuro. Una dirección suelta es
pública en la blockchain, pero junto a esta aplicación queda ligada a una
persona. Por eso las dos se tratan igual que un secreto:

* **Cifrado obligatorio de las propias.** Fernet (AES-128-CBC + HMAC-SHA256) con una clave
  PBKDF2-HMAC-SHA256 derivada de SECRET_KEY y una sal propia, independiente de
  la de las claves de API. A diferencia de esas, aquí no hay modo de compatibilidad
  en claro: sin una SECRET_KEY de calidad no se guarda nada.
* **Fuera de git y nunca en claro en un ZIP.** El fichero vive en API/, ignorado
  por git, con permisos 0600. Solo viaja en el paquete cifrado de las copias y de
  las exportaciones con contraseña (`core.wallets_copia`); una exportación sin
  contraseña no lo lleva.
* **Nunca salen enteras.** `Wallet.resumen()` es lo único que ven las rutas, y
  lleva el valor enmascarado.

Patrón Repository: las rutas y el servicio de sincronización no saben nada de
ficheros ni de cifrado, y los tests inyectan la ruta y el proveedor de Fernet.
"""

import json
import logging
import os
import secrets
from dataclasses import asdict, dataclass, field, fields, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from cryptography.fernet import Fernet, InvalidToken

from core import bloqueo, paths
from core.cripto_direcciones import REDES, TIPO_DIRECCION
from core.escritura import escribirAtomico
from core.secret_store import fernetDeSecretKey, readSecretLines

log = logging.getLogger(__name__)

NOMBRE_FICHERO = "wallets.key"
NOMBRE_FICHERO_AJENAS = "wallets_ajenas.json"
_PREFIJO = b"WAL1:"
# Sal distinta a la de API/*.key y auth.dat: si una de esas claves derivadas se
# filtrase, no abriría este fichero.
_SALT = b"portfolio-wallets-v1"
# Una SECRET_KEY de 64 caracteres hexadecimales (lo que genera docker-up.sh) son
# 256 bits. Por debajo de 32 caracteres ya no se puede presumir que sea aleatoria.
LARGO_MINIMO_SECRET_KEY = 32
# Sin tope de wallets: el coste de cada una son sus consultas en cada revisión,
# y eso lo decide quien las enlaza. Se deja el hueco por si hiciera falta uno.
MAX_WALLETS: int | None = None
MAX_TOKENS_VERIFICADOS = 500
# Más que verificados: el spam llega solo y se marca de uno en uno.
MAX_TOKENS_MARCADOS = 1000
MARCA_IMITACION = "imitacion"
MARCA_LEGITIMO = "legitimo"
MARCAS_TOKEN = (MARCA_IMITACION, MARCA_LEGITIMO)
# Etiqueta manual aparte de la marca: un token verificado puede ser sospechoso.
MAX_TOKENS_SOSPECHOSOS = 1000
MAX_TOKENS_PRECIO = 500
# Proveedores de cotización (stores.market_data); el primero es el de por defecto.
PROVEEDORES_PRECIO = ("tradingview", "finnhub", "eodhd", "yahoo", "alphavantage")
MAX_LARGO_TICKER = 60
# Tokens vistos en las wallets, para la lista «Seguimiento» de la Watchlist. Se
# anotan solos (spam incluido): al pasar del tope se olvidan los más antiguos.
MAX_TOKENS_CONOCIDOS = 2000
MAX_LARGO_ALIAS = 60
# Libreta de direcciones: las que el usuario ha marcado como suyas o ajenas.
MAX_DIRECCIONES = 1000
# Transacciones marcadas una a una: al menos una por cada retiro de un exchange.
MAX_MOVIMIENTOS_MARCADOS = 5000
# Contraparte de cada fila importada a Transacciones, para poder reetiquetarla
# cuando cambia la libreta. El fichero se reescribe en cada revisión de la
# vigilancia: el tope evita que crezca sin límite; se olvidan las más antiguas.
MAX_CONTRAPARTES = 20000
_ESPERA_BLOQUEO_SEGUNDOS = 5.0


class WalletError(Exception):
    """Error de dominio de las wallets enlazadas."""


class CifradoNoDisponible(WalletError):
    """No hay SECRET_KEY o es demasiado débil para proteger las wallets."""


class AlmacenIlegible(WalletError):
    """El fichero existe pero no se puede descifrar (otra SECRET_KEY)."""


class WalletNoEncontrada(WalletError):
    """No hay ninguna wallet con ese identificador."""


class LimiteWallets(WalletError):
    """Se ha alcanzado el máximo de wallets enlazadas."""


@dataclass(frozen=True)
class Wallet:
    """Una wallet enlazada. `valor` es la dirección o la xpub: es el secreto.

    Una wallet ajena (`propia=False`: la de Satoshi, una ballena…) solo se vigila:
    no se importa a Transacciones ni suma al total. El saldo, los movimientos
    recientes y los hashes ya vistos van con la wallet: cifrados en las propias,
    porque dicen cuánto dinero tiene el usuario y en qué se mueve; en claro en
    las ajenas, que son públicas.
    """

    id: str
    alias: str
    red: str
    tipo: str
    valor: str
    assetId: str
    creada: str
    ultimaSincronizacion: str = ""
    propia: bool = True
    avisos: bool = False
    # Cantidad mínima, en unidades de la moneda, para avisar. Vacío: cualquiera.
    umbralAviso: str = ""
    # Tipos y opciones de aviso (core.wallets_avisos.ConfigAvisos como dict).
    # Vacío: los valores por defecto, que avisan de todo como antes de existir.
    avisosConfig: dict = field(default_factory=dict)
    # «bajo», «alto» o "": dónde quedó el saldo respecto a sus límites en la
    # última revisión, para avisar solo al cruzarlos.
    estadoSaldo: str = ""
    # Avisos retenidos durante las horas de silencio, para mandarlos al acabar.
    avisosPendientes: list = field(default_factory=list)
    saldo: str = ""
    saldoFecha: str = ""
    ultimoMovimiento: str = ""
    recientes: list = field(default_factory=list)
    hashesConocidos: list = field(default_factory=list)
    # Contrapartes ya vistas, canónicas, para el aviso de envío a una dirección
    # nueva. None en las wallets de antes de ese aviso: la primera revisión las
    # apunta sin avisar, igual que hace `vigilanciaIniciada` con los movimientos.
    contrapartesConocidas: list | None = None
    # False hasta la primera revisión: esa solo memoriza lo que ya había, para
    # no mandar un aviso por cada movimiento antiguo.
    vigilanciaIniciada: bool = False
    # Nombre del seguimiento que agrupa varias wallets (las direcciones de un
    # Ledger, las claves de una misma persona). Vacío en las enlazadas antes de
    # existir los grupos: forman uno propio con su alias, sin migrar nada.
    seguimiento: str = ""
    # Por qué falló la última revisión en segundo plano, y cuándo. La vigilancia
    # corre en otro proceso: sin esto, el fallo solo quedaba en su log.
    ultimoError: str = ""
    ultimoErrorFecha: str = ""
    # La última revisión no alcanzó lo ya visto: pudo haber más movimientos.
    lecturaIncompleta: bool = False
    # Avisos sospechosos que Telegram no aceptó, para volver a intentarlo.
    avisosReintento: list = field(default_factory=list)

    @property
    def nombreSeguimiento(self) -> str:
        """Nombre del seguimiento al que pertenece; su alias si no tiene."""
        return self.seguimiento or self.alias

    @property
    def claveSeguimiento(self) -> str:
        """Identidad del seguimiento: «Ledger» y «ledger» son el mismo."""
        return claveSeguimiento(self.nombreSeguimiento)

    def resumen(self) -> dict:
        """Lo que se puede enseñar en pantalla: todo menos el valor completo."""
        return {
            "id": self.id,
            "alias": self.alias,
            "red": self.red,
            "tipo": self.tipo,
            "valorEnmascarado": enmascarar(self.valor),
            "assetId": self.assetId,
            "creada": self.creada,
            "ultimaSincronizacion": self.ultimaSincronizacion,
            "propia": self.propia,
            "avisos": self.avisos,
            "umbralAviso": self.umbralAviso,
            "avisosConfig": dict(self.avisosConfig),
            "avisosPendientes": len(self.avisosPendientes),
            "saldo": self.saldo,
            "saldoFecha": self.saldoFecha,
            "ultimoMovimiento": self.ultimoMovimiento,
            "recientes": list(self.recientes),
            "seguimiento": self.nombreSeguimiento,
            "seguimientoClave": self.claveSeguimiento,
            "ultimoError": self.ultimoError,
            "ultimoErrorFecha": self.ultimoErrorFecha,
            "lecturaIncompleta": self.lecturaIncompleta,
            "avisosReintento": len(self.avisosReintento),
        }


@dataclass(frozen=True)
class TokenVerificado:
    """El contrato que el usuario ha confirmado como el auténtico de un símbolo en una red.

    Va en el mismo fichero cifrado que las wallets: la lista dice qué tokens
    tiene o sigue el usuario. `contrato` está en forma canónica (las
    direcciones EVM, en minúsculas) y `simbolo`, en mayúsculas.
    """

    red: str
    contrato: str
    simbolo: str


@dataclass(frozen=True)
class TokenMarcado:
    """La decisión del usuario sobre un contrato, que manda sobre la detección automática.

    `marca` es `MARCA_IMITACION` (no se importa aunque nada lo delate) o
    `MARCA_LEGITIMO` (no es una imitación aunque lo parezca). Un contrato está
    marcado o verificado, nunca las dos cosas. Va cifrado con las wallets, como
    los verificados, y por eso en su propia lista: una versión anterior que no
    la conoce la ignora en vez de leer las marcas como verificaciones.
    """

    red: str
    contrato: str
    marca: str


@dataclass(frozen=True)
class TokenSospechoso:
    """Un contrato que el usuario ha etiquetado como sospechoso.

    Es solo una etiqueta: no cambia qué se importa ni su estado (verificado,
    imitación…). Sirve para los tokens que ninguna lista ni regla delata pero
    en los que el usuario ve algo raro.
    """

    red: str
    contrato: str


@dataclass(frozen=True)
class TokenPrecio:
    """El ticker con el que se cotiza un token que no tiene activo asociado en Activos.

    `proveedor` es uno de `PROVEEDORES_PRECIO`; `ticker`, el símbolo en ese
    proveedor (p. ej. «BINANCE:PEPEUSDT» en TradingView). Con `contrato` vacío
    es el ticker de la moneda de la red (ETH, BTC...), que no tiene contrato.
    """

    red: str
    contrato: str
    proveedor: str
    ticker: str


@dataclass(frozen=True)
class TokenConocido:
    """Un token visto en alguna wallet, sin saldo: solo qué contrato es y cómo se llama."""

    red: str
    contrato: str
    simbolo: str
    nombre: str = ""


@dataclass(frozen=True)
class DireccionMarcada:
    """Una dirección de la libreta: el usuario dice si es suya o ajena y le pone un apodo.

    Decide cómo se clasifican los movimientos con esa contraparte: hacia o
    desde una propia son «entre wallets», no un envío o un recibo. `direccion`
    está en forma canónica (`normalizarDatoWallet`). Va cifrada con las
    wallets: un apodo junto a una dirección dice de quién es.
    """

    red: str
    direccion: str
    apodo: str
    propia: bool


@dataclass(frozen=True)
class MovimientoMarcado:
    """La decisión del usuario sobre una transacción, que manda sobre la de su dirección.

    Sirve para lo que la libreta no puede decir: la dirección de un exchange no es
    del usuario, pero el retiro de lo que compró ahí sí es dinero que ya contaba.
    `propia=True` la deja en «entre wallets», que solo descuenta la comisión;
    `propia=False`, en lo que leyó la red. `comision` es la que se descuenta, en
    unidades del activo, y vacía deja la que leyó la red. `contrato` distingue la
    moneda de un token dentro de una misma transacción, y `assetId` localiza su
    fila en Transacciones, que no guarda el contrato.
    """

    red: str
    hash: str
    contrato: str
    propia: bool
    comision: str = ""
    assetId: str = ""


# Lo que guarda el fichero de wallets además de las propias wallets.
_COLECCIONES = {
    "tokens": TokenVerificado,
    "marcas": TokenMarcado,
    "sospechosos": TokenSospechoso,
    "precios": TokenPrecio,
    "conocidos": TokenConocido,
    "direcciones": DireccionMarcada,
    "movimientos": MovimientoMarcado,
}


def claveSeguimiento(nombre: str) -> str:
    """Forma normalizada de un nombre de seguimiento para compararlo.

    Example:
        >>> claveSeguimiento("  Ledger ")
        'ledger'
    """
    return " ".join(str(nombre or "").split()).casefold()


def enmascarar(valor: str) -> str:
    """Primeros y últimos caracteres, suficientes para reconocerla y no para usarla.

    Example:
        >>> enmascarar("zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1")
        'zpub6rFR…H1r1'
    """
    texto = str(valor or "")
    if len(texto) <= 12:
        return "…" + texto[-4:] if texto else ""
    return f"{texto[:8]}…{texto[-4:]}"


def comprobarDuenoSeguimiento(wallets: list[Wallet], nueva: Wallet) -> None:
    """Un seguimiento es todo de wallets propias o todo de ajenas.

    Mezclarlas haría que la tarjeta sumase al total solo una parte de lo que
    enseña, y que «Sincronizar» importase la mitad del grupo.

    Raises:
        WalletError: si el seguimiento de `nueva` ya tiene wallets del otro tipo.
    """
    for wallet in wallets:
        if wallet.claveSeguimiento == nueva.claveSeguimiento and wallet.propia != nueva.propia:
            tipo = "propias" if wallet.propia else "ajenas"
            raise WalletError(
                f"«{wallet.nombreSeguimiento}» es un seguimiento de wallets {tipo}: "
                "esta también tiene que serlo, o ponla en otro seguimiento"
            )


def _nombreDeSeguimiento(wallets: list[Wallet], nombre: str) -> str:
    """El nombre con el que ya existe ese seguimiento, o `nombre` si es nuevo.

    «ledger» entra en «Ledger» sin dejar dos grafías en un mismo seguimiento.
    """
    clave = claveSeguimiento(nombre)
    return next((w.nombreSeguimiento for w in wallets if w.claveSeguimiento == clave), nombre)


def ahoraIso() -> str:
    """Marca de tiempo UTC con segundos, la que se guarda en las wallets."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def nuevoId() -> str:
    """Identificador opaco: no deriva del valor para no filtrar nada de él."""
    return f"wallet-{secrets.token_hex(8)}"


def fernetWallets() -> Fernet | None:
    """Fernet de las wallets, o None si SECRET_KEY no sirve para protegerlas."""
    secreto = os.environ.get("SECRET_KEY", "").strip()
    if len(secreto) < LARGO_MINIMO_SECRET_KEY or secreto.startswith("cambia_esto"):
        return None
    return fernetDeSecretKey(_SALT)


def _registros(datos: dict, clave: str, clase: type) -> list:
    """Los registros de `datos[clave]` como instancias de `clase`.

    Raises:
        AlmacenIlegible: si la lista o sus elementos no tienen la forma esperada.
    """
    # Solo los campos conocidos: un fichero escrito por una versión más nueva
    # no debe dejar la lista ilegible al volver a una anterior.
    conocidos = {f.name for f in fields(clase)}
    try:
        return [clase(**{k: v for k, v in r.items() if k in conocidos}) for r in datos.get(clave, [])]
    except (ValueError, TypeError, AttributeError) as error:
        raise AlmacenIlegible(f"{NOMBRE_FICHERO} está dañado") from error


def _contenido(datos: dict) -> dict:
    """`datos` sin la versión ni las colecciones vacías, para comparar si ha cambiado algo.

    Así un wallets.key que no existe y uno con todas sus listas vacías cuentan
    como iguales, y añadir una ajena no obliga a crearlo.
    """
    return {k: v for k, v in datos.items() if k != "version" and v not in ([], {}, None, "")}


def _ajustada(wallet: Wallet, ajustarConfig: Callable[[dict], dict] | None, cambios: dict) -> Wallet:
    """`wallet` con `cambios` y, si hay `ajustarConfig`, con su config de avisos ajustada."""
    if ajustarConfig is not None:
        cambios = {**cambios, "avisosConfig": ajustarConfig(dict(wallet.avisosConfig))}
    return replace(wallet, **cambios)


class WalletsRepository:
    """Lectura y escritura del fichero cifrado de wallets.

    Args:
        ruta: Fichero de wallets. Por defecto `API_DIR/wallets.key`, resuelto en
            cada llamada para que una prueba que redirige API/ no toque el real.
        proveedorFernet: Devuelve el Fernet o None. Inyectable para los tests.
    """

    def __init__(self, ruta: Path | None = None,
                 proveedorFernet: Callable[[], Fernet | None] = fernetWallets) -> None:
        self._ruta = ruta
        self._proveedorFernet = proveedorFernet

    @property
    def ruta(self) -> Path:
        return self._ruta if self._ruta is not None else paths.API_DIR / NOMBRE_FICHERO

    def _fernet(self) -> Fernet:
        fernet = self._proveedorFernet()
        if fernet is None:
            raise CifradoNoDisponible(
                f"Para enlazar wallets hace falta una SECRET_KEY aleatoria de al menos "
                f"{LARGO_MINIMO_SECRET_KEY} caracteres en .env (docker-up.sh la genera). "
                "Sin ella no se guardan, para no dejarlas en claro."
            )
        return fernet

    @property
    def rutaAjenas(self) -> Path:
        """El JSON de las wallets ajenas, junto a `ruta`."""
        return self.ruta.with_name(NOMBRE_FICHERO_AJENAS)

    def listar(self) -> list[Wallet]:
        """Todas las wallets, propias y ajenas, en el orden en que se enlazaron.

        Raises:
            CifradoNoDisponible: si hay wallets propias guardadas y no hay SECRET_KEY válida.
            AlmacenIlegible: si algún fichero no se puede leer o está corrupto.
        """
        return _registros(self._leerTodo(), "wallets", Wallet)

    def tokensVerificados(self) -> list[TokenVerificado]:
        """Los contratos confirmados como auténticos, en el orden en que se confirmaron.

        Raises:
            CifradoNoDisponible: si hay wallets guardadas y no hay SECRET_KEY válida.
            AlmacenIlegible: si el fichero no se puede descifrar o está corrupto.
        """
        return _registros(self._leerDatos(), "tokens", TokenVerificado)

    def verificarToken(self, token: TokenVerificado) -> list[TokenVerificado]:
        """Confirma un contrato como el auténtico de su símbolo; si ya estaba, lo deja igual.

        Returns:
            La lista completa ya con el token.

        Raises:
            WalletError: si ya hay `MAX_TOKENS_VERIFICADOS`.
        """
        resultado = []

        def cambio(datos: dict) -> dict:
            tokens = _registros(datos, "tokens", TokenVerificado)
            # Un contrato tiene un solo símbolo: si se vuelve a confirmar con
            # otro (el token cambió de nombre), manda el último.
            otros = [t for t in tokens if (t.red, t.contrato) != (token.red, token.contrato)]
            if len(otros) >= MAX_TOKENS_VERIFICADOS:
                raise WalletError(f"Como máximo se pueden verificar {MAX_TOKENS_VERIFICADOS} tokens")
            resultado.extend([*otros, token])
            # Verificarlo sustituye a la marca que tuviera.
            marcas = _registros(datos, "marcas", TokenMarcado)
            return {**datos, "tokens": [asdict(t) for t in resultado],
                    "marcas": [asdict(m) for m in marcas if (m.red, m.contrato) != (token.red, token.contrato)]}

        self._modificarDatos(cambio)
        return resultado

    def olvidarToken(self, red: str, contrato: str) -> list[TokenVerificado]:
        """Quita la confirmación de un contrato. No falla si no estaba.

        Returns:
            La lista completa sin el token.
        """
        resultado = []

        def cambio(tokens: list[TokenVerificado]) -> list[TokenVerificado]:
            resultado.extend(t for t in tokens if (t.red, t.contrato) != (red, contrato))
            return resultado

        self._modificarTokens(cambio)
        return resultado

    def marcasToken(self) -> list[TokenMarcado]:
        """Las decisiones del usuario sobre contratos, en el orden en que se tomaron.

        Raises:
            CifradoNoDisponible: si hay wallets guardadas y no hay SECRET_KEY válida.
            AlmacenIlegible: si el fichero no se puede descifrar o está corrupto.
        """
        return _registros(self._leerDatos(), "marcas", TokenMarcado)

    def marcarToken(self, marcado: TokenMarcado) -> list[TokenMarcado]:
        """Guarda la decisión sobre un contrato; sustituye a la anterior y a su verificación.

        Returns:
            La lista completa de marcas ya con esta.

        Raises:
            WalletError: si la marca no es una de `MARCAS_TOKEN` o ya hay `MAX_TOKENS_MARCADOS`.
        """
        if marcado.marca not in MARCAS_TOKEN:
            raise WalletError("Marca de token no válida")
        resultado = []
        clave = (marcado.red, marcado.contrato)

        def cambio(datos: dict) -> dict:
            otras = [m for m in _registros(datos, "marcas", TokenMarcado) if (m.red, m.contrato) != clave]
            if len(otras) >= MAX_TOKENS_MARCADOS:
                raise WalletError(f"Como máximo se pueden marcar {MAX_TOKENS_MARCADOS} tokens")
            resultado.extend([*otras, marcado])
            tokens = _registros(datos, "tokens", TokenVerificado)
            return {**datos, "marcas": [asdict(m) for m in resultado],
                    "tokens": [asdict(t) for t in tokens if (t.red, t.contrato) != clave]}

        self._modificarDatos(cambio)
        return resultado

    def desmarcarToken(self, red: str, contrato: str) -> list[TokenMarcado]:
        """Quita la decisión sobre un contrato, que vuelve a la detección automática. No falla si no estaba.

        Returns:
            La lista completa de marcas sin la de este contrato.
        """
        resultado = []

        def cambio(datos: dict) -> dict:
            marcas = _registros(datos, "marcas", TokenMarcado)
            resultado.extend(m for m in marcas if (m.red, m.contrato) != (red, contrato))
            return {**datos, "marcas": [asdict(m) for m in resultado]}

        self._modificarDatos(cambio)
        return resultado

    def tokensSospechosos(self) -> list[TokenSospechoso]:
        """Los contratos etiquetados como sospechosos, en el orden en que se etiquetaron.

        Raises:
            CifradoNoDisponible: si hay wallets guardadas y no hay SECRET_KEY válida.
            AlmacenIlegible: si el fichero no se puede descifrar o está corrupto.
        """
        return _registros(self._leerDatos(), "sospechosos", TokenSospechoso)

    def marcarSospechoso(self, red: str, contrato: str) -> list[TokenSospechoso]:
        """Etiqueta un contrato como sospechoso; si ya lo estaba, lo deja igual.

        Returns:
            La lista completa ya con el contrato.

        Raises:
            WalletError: si ya hay `MAX_TOKENS_SOSPECHOSOS`.
        """
        return self._guardarEnLista("sospechosos", TokenSospechoso(red, contrato), MAX_TOKENS_SOSPECHOSOS,
                                    "Como máximo se pueden etiquetar {maximo} tokens como sospechosos")

    def desmarcarSospechoso(self, red: str, contrato: str) -> list[TokenSospechoso]:
        """Quita la etiqueta de sospechoso de un contrato. No falla si no la tenía.

        Returns:
            La lista completa sin el contrato.
        """
        return self._quitarDeLista("sospechosos", TokenSospechoso, red, contrato)

    def preciosToken(self) -> list[TokenPrecio]:
        """Los tickers de cotización puestos a mano a los tokens.

        Raises:
            CifradoNoDisponible: si hay wallets guardadas y no hay SECRET_KEY válida.
            AlmacenIlegible: si el fichero no se puede descifrar o está corrupto.
        """
        return _registros(self._leerDatos(), "precios", TokenPrecio)

    def guardarPrecioToken(self, precio: TokenPrecio) -> list[TokenPrecio]:
        """Pone el ticker de cotización de un contrato; sustituye al que tuviera.

        Returns:
            La lista completa ya con este ticker.

        Raises:
            WalletError: si el proveedor no es uno de `PROVEEDORES_PRECIO`, el
                ticker está vacío o ya hay `MAX_TOKENS_PRECIO`.
        """
        if precio.proveedor not in PROVEEDORES_PRECIO:
            raise WalletError("Proveedor de cotización no válido")
        if not precio.ticker:
            raise WalletError("Falta el ticker")
        return self._guardarEnLista("precios", precio, MAX_TOKENS_PRECIO,
                                    "Como máximo se pueden poner {maximo} tickers a tokens")

    def quitarPrecioToken(self, red: str, contrato: str) -> list[TokenPrecio]:
        """Quita el ticker de cotización de un contrato. No falla si no tenía.

        Returns:
            La lista completa sin el de este contrato.
        """
        return self._quitarDeLista("precios", TokenPrecio, red, contrato)

    def tokensConocidos(self) -> list[TokenConocido]:
        """Los tokens vistos en las wallets, del más antiguo al más reciente.

        Raises:
            CifradoNoDisponible: si hay wallets guardadas y no hay SECRET_KEY válida.
            AlmacenIlegible: si el fichero no se puede descifrar o está corrupto.
        """
        return _registros(self._leerDatos(), "conocidos", TokenConocido)

    def anotarTokensConocidos(self, tokens: list[TokenConocido]) -> int:
        """Añade los tokens que aún no estaban; por encima de `MAX_TOKENS_CONOCIDOS` olvida los más antiguos.

        Un token ya anotado no cambia aunque llegue con otro nombre: el símbolo
        lo elige el contrato y no hace falta reescribir el fichero por eso.

        Returns:
            Cuántos tokens nuevos se han anotado.
        """
        # Sin nada nuevo no se toma el bloqueo: la vigilancia llama en cada pasada.
        vistos = {(t.red, t.contrato) for t in self.tokensConocidos()}
        candidatos = list({(t.red, t.contrato): t for t in tokens if (t.red, t.contrato) not in vistos}.values())
        if not candidatos:
            return 0
        anotados = []

        def cambio(datos: dict) -> dict:
            actuales = _registros(datos, "conocidos", TokenConocido)
            claves = {(t.red, t.contrato) for t in actuales}
            anotados.extend(t for t in candidatos if (t.red, t.contrato) not in claves)
            conocidos = [*actuales, *anotados][-MAX_TOKENS_CONOCIDOS:]
            return {**datos, "conocidos": [asdict(t) for t in conocidos]}

        self._modificarDatos(cambio)
        return len(anotados)

    def _guardarEnLista(self, clave: str, registro, maximo: int, mensajeTope: str) -> list:
        """Guarda `registro` en la lista `clave`, sustituyendo el de su mismo (red, contrato).

        Raises:
            WalletError: si es nuevo y la lista ya tiene `maximo` registros.
        """
        resultado = []
        identidad = (registro.red, registro.contrato)

        def cambio(datos: dict) -> dict:
            anteriores = _registros(datos, clave, type(registro))
            # Se queda en su sitio al cambiarlo, como las direcciones de la libreta.
            if any((r.red, r.contrato) == identidad for r in anteriores):
                resultado.extend(registro if (r.red, r.contrato) == identidad else r for r in anteriores)
            elif len(anteriores) >= maximo:
                raise WalletError(mensajeTope.format(maximo=maximo))
            else:
                resultado.extend([*anteriores, registro])
            return {**datos, clave: [asdict(r) for r in resultado]}

        self._modificarDatos(cambio)
        return resultado

    def _quitarDeLista(self, clave: str, clase: type, red: str, contrato: str) -> list:
        """Quita de la lista `clave` el registro de (red, contrato). No falla si no estaba."""
        resultado = []

        def cambio(datos: dict) -> dict:
            anteriores = _registros(datos, clave, clase)
            resultado.extend(r for r in anteriores if (r.red, r.contrato) != (red, contrato))
            return {**datos, clave: [asdict(r) for r in resultado]}

        self._modificarDatos(cambio)
        return resultado

    def direcciones(self) -> list[DireccionMarcada]:
        """La libreta de direcciones, en el orden en que se marcaron.

        Raises:
            CifradoNoDisponible: si hay wallets guardadas y no hay SECRET_KEY válida.
            AlmacenIlegible: si el fichero no se puede descifrar o está corrupto.
        """
        return _registros(self._leerDatos(), "direcciones", DireccionMarcada)

    def guardarDireccion(self, marcada: DireccionMarcada) -> list[DireccionMarcada]:
        """Guarda una dirección en la libreta; si ya estaba, sustituye su apodo y su marca.

        Returns:
            La libreta completa ya con esta dirección.

        Raises:
            WalletError: si ya hay `MAX_DIRECCIONES`.
        """
        resultado = []
        clave = (marcada.red, marcada.direccion)

        def cambio(datos: dict) -> dict:
            anteriores = _registros(datos, "direcciones", DireccionMarcada)
            # Se queda en su sitio al editarla: la lista no salta al cambiar un apodo.
            if any((d.red, d.direccion) == clave for d in anteriores):
                resultado.extend(marcada if (d.red, d.direccion) == clave else d for d in anteriores)
            elif len(anteriores) >= MAX_DIRECCIONES:
                raise WalletError(f"Como máximo se pueden guardar {MAX_DIRECCIONES} direcciones")
            else:
                resultado.extend([*anteriores, marcada])
            return {**datos, "direcciones": [asdict(d) for d in resultado]}

        self._modificarDatos(cambio)
        return resultado

    def olvidarDireccion(self, red: str, direccion: str) -> list[DireccionMarcada]:
        """Quita una dirección de la libreta. No falla si no estaba.

        Returns:
            La libreta completa sin esa dirección.
        """
        resultado = []

        def cambio(datos: dict) -> dict:
            anteriores = _registros(datos, "direcciones", DireccionMarcada)
            resultado.extend(d for d in anteriores if (d.red, d.direccion) != (red, direccion))
            return {**datos, "direcciones": [asdict(d) for d in resultado]}

        self._modificarDatos(cambio)
        return resultado

    def movimientosMarcados(self) -> list[MovimientoMarcado]:
        """Las transacciones marcadas una a una, en el orden en que se marcaron.

        Raises:
            CifradoNoDisponible: si hay wallets guardadas y no hay SECRET_KEY válida.
            AlmacenIlegible: si el fichero no se puede descifrar o está corrupto.
        """
        return _registros(self._leerDatos(), "movimientos", MovimientoMarcado)

    def marcarMovimiento(self, marcado: MovimientoMarcado) -> None:
        """Guarda la decisión sobre una transacción; sustituye a la anterior.

        Raises:
            WalletError: si es nueva y ya hay `MAX_MOVIMIENTOS_MARCADOS`.
        """
        identidad = (marcado.red, marcado.hash, marcado.contrato)

        def cambio(datos: dict) -> dict:
            otras = [m for m in _registros(datos, "movimientos", MovimientoMarcado)
                     if (m.red, m.hash, m.contrato) != identidad]
            if len(otras) >= MAX_MOVIMIENTOS_MARCADOS:
                raise WalletError(f"Como máximo se pueden marcar {MAX_MOVIMIENTOS_MARCADOS} transacciones")
            return {**datos, "movimientos": [asdict(m) for m in [*otras, marcado]]}

        self._modificarDatos(cambio)

    def desmarcarMovimiento(self, red: str, hashTx: str, contrato: str) -> None:
        """Quita la decisión sobre una transacción. No falla si no estaba."""
        identidad = (red, hashTx, contrato)

        def cambio(datos: dict) -> dict:
            marcas = _registros(datos, "movimientos", MovimientoMarcado)
            return {**datos, "movimientos": [asdict(m) for m in marcas if (m.red, m.hash, m.contrato) != identidad]}

        self._modificarDatos(cambio)

    def contrapartesImportadas(self) -> dict[str, dict]:
        """Contraparte de cada fila importada: id de la fila → `{red, direccion, sentido}`.

        Raises:
            CifradoNoDisponible: si hay wallets guardadas y no hay SECRET_KEY válida.
            AlmacenIlegible: si el fichero no se puede descifrar o está corrupto.
        """
        contrapartes = self._leerDatos().get("contrapartes", {})
        if not isinstance(contrapartes, dict):
            raise AlmacenIlegible(f"{NOMBRE_FICHERO} está dañado")
        return contrapartes

    def anotarContrapartes(self, nuevas: dict[str, dict]) -> None:
        """Añade contrapartes de filas importadas; por encima de `MAX_CONTRAPARTES` olvida las más antiguas."""
        if not nuevas:
            return

        def cambio(datos: dict) -> dict:
            contrapartes = {**datos.get("contrapartes", {}), **nuevas}
            sobran = len(contrapartes) - MAX_CONTRAPARTES
            if sobran > 0:
                contrapartes = dict(list(contrapartes.items())[sobran:])
            return {**datos, "contrapartes": contrapartes}

        self._modificarDatos(cambio)

    def _leerDatos(self) -> dict:
        """El contenido descifrado del fichero, o un dict vacío si no existe.

        Raises:
            CifradoNoDisponible: si hay fichero y no hay SECRET_KEY válida.
            AlmacenIlegible: si el fichero no se puede descifrar o está corrupto.
        """
        if not self.ruta.exists():
            return {}
        try:
            crudo = self.ruta.read_bytes()
        except OSError as error:
            raise AlmacenIlegible(f"No se pudo leer {NOMBRE_FICHERO}: {error.strerror or error}") from error
        crudo = self._desenvolverMigracion(crudo)
        if not crudo.startswith(_PREFIJO):
            raise AlmacenIlegible(f"{NOMBRE_FICHERO} no tiene el formato esperado")
        try:
            claro = self._fernet().decrypt(crudo[len(_PREFIJO):])
            datos = json.loads(claro.decode("utf-8"))
        except InvalidToken as error:
            raise AlmacenIlegible(
                "No se pueden descifrar las wallets. ¿Ha cambiado SECRET_KEY desde que se enlazaron?"
            ) from error
        except ValueError as error:
            raise AlmacenIlegible(f"{NOMBRE_FICHERO} está dañado") from error
        if not isinstance(datos, dict):
            raise AlmacenIlegible(f"{NOMBRE_FICHERO} está dañado")
        return datos

    def _leerAjenas(self) -> list[dict]:
        """Las wallets ajenas del JSON, o una lista vacía si no existe.

        Raises:
            AlmacenIlegible: si el fichero no se puede leer o no tiene la forma esperada.
        """
        if not self.rutaAjenas.exists():
            return []
        try:
            datos = json.loads(self.rutaAjenas.read_text(encoding="utf-8"))
        except OSError as error:
            raise AlmacenIlegible(f"No se pudo leer {NOMBRE_FICHERO_AJENAS}: {error.strerror or error}") from error
        except ValueError as error:
            raise AlmacenIlegible(f"{NOMBRE_FICHERO_AJENAS} está dañado") from error
        wallets = datos.get("wallets") if isinstance(datos, dict) else None
        if not isinstance(wallets, list) or not all(isinstance(w, dict) for w in wallets):
            raise AlmacenIlegible(f"{NOMBRE_FICHERO_AJENAS} está dañado")
        return wallets

    def _leerTodo(self) -> dict:
        """El contenido de wallets.key con las wallets ajenas del JSON añadidas.

        Una ajena que siga en wallets.key (de antes de separarlas) se lee igual;
        la próxima escritura la pasa al JSON. Si por un corte quedase en los dos,
        manda la del JSON, que es la que se escribe primero.
        """
        datos = self._leerDatos()
        ajenas = self._leerAjenas()
        idsAjenas = {w.get("id") for w in ajenas}
        heredadas = [w for w in datos.get("wallets", []) if isinstance(w, dict) and w.get("id") not in idsAjenas]
        # Estable: dentro de cada fichero se respeta el orden en que están.
        wallets = sorted([*heredadas, *ajenas], key=lambda w: str(w.get("creada", "")))
        return {**datos, "wallets": wallets}

    def _desenvolverMigracion(self, crudo: bytes) -> bytes:
        """Recupera un fichero que la migración de claves de API envolvió en `ENC1:`.

        Hasta que server.py dejó de tocarlo, cada arranque cifraba wallets.key
        otra vez como si fuera una clave en claro. El contenido de dentro sigue
        intacto, así que se desenvuelve en vez de dar las wallets por perdidas;
        la siguiente escritura lo deja de nuevo en `WAL1:`.

        Args:
            crudo: Bytes leídos del fichero.

        Returns:
            Los bytes `WAL1:` de dentro si estaban envueltos, o `crudo` tal cual.
        """
        if crudo.startswith(_PREFIJO):
            return crudo
        # Solo puede haber una capa: la migración no vuelve a tocar un fichero
        # que ya empieza por su propio prefijo.
        lineas = readSecretLines(self.ruta)
        if len(lineas) == 1 and lineas[0].startswith(_PREFIJO.decode()):
            log.warning("[wallets] %s venía envuelto por la migración de claves de API; recuperado", NOMBRE_FICHERO)
            return lineas[0].encode("utf-8")
        return crudo

    def volcado(self) -> dict:
        """Todo lo guardado, propias y ajenas juntas, para el paquete cifrado de las copias.

        Raises:
            CifradoNoDisponible: si hay wallets propias guardadas y no hay SECRET_KEY válida.
            AlmacenIlegible: si algún fichero no se puede leer o está corrupto.
        """
        return self._leerTodo()

    def restaurarVolcado(self, datos: dict) -> int:
        """Sustituye todo lo guardado por un `volcado`, cifrándolo con la SECRET_KEY de aquí.

        No lee lo que ya hubiera: suele ser de otra SECRET_KEY e ilegible, que es
        justo el caso en el que hace falta restaurar. La primera revisión de cada
        wallet solo vuelve a memorizar: una copia antigua no debe avisar de todo
        lo ocurrido desde entonces.

        Args:
            datos: Contenido de `volcado`; viene de un ZIP, así que no se da por bueno.

        Returns:
            Cuántas wallets se han restaurado.

        Raises:
            AlmacenIlegible: si `datos` no tiene la forma esperada.
            CifradoNoDisponible: si hay datos cifrables y no hay SECRET_KEY válida.
        """
        wallets = _registros(datos, "wallets", Wallet)
        if any(w.red not in REDES for w in wallets):
            raise AlmacenIlegible("La copia trae una wallet de una red desconocida")
        contrapartes = datos.get("contrapartes", {})
        if not isinstance(contrapartes, dict):
            raise AlmacenIlegible("La copia trae las contrapartes dañadas")
        colecciones = {clave: [asdict(r) for r in _registros(datos, clave, clase)]
                       for clave, clase in _COLECCIONES.items()}
        limpias = [asdict(replace(w, vigilanciaIniciada=False, avisosPendientes=[], avisosReintento=[],
                                  ultimoError="", ultimoErrorFecha="", lecturaIncompleta=False)) for w in wallets]
        ajenas = [w for w in limpias if w["propia"] is False]
        cifrado = {**colecciones, "contrapartes": contrapartes,
                   "wallets": [w for w in limpias if w["propia"] is not False]}
        # Antes de escribir nada: sin clave, no se queda medio restaurado.
        fernet = self._fernet() if _contenido(cifrado) else None
        with bloqueo.exclusivo(self.ruta.with_name(f".{NOMBRE_FICHERO}.lock"), espera=_ESPERA_BLOQUEO_SEGUNDOS):
            self._escribirAjenas(ajenas)
            if fernet is None:
                self.ruta.unlink(missing_ok=True)
            else:
                claro = json.dumps({**cifrado, "version": 1}, ensure_ascii=False)
                escribirAtomico(self.ruta, _PREFIJO + fernet.encrypt(claro.encode("utf-8")), permisos=0o600)
        log.info("[wallets] Restauradas %d wallets de una copia", len(limpias))
        return len(limpias)

    def obtener(self, walletId: str) -> Wallet:
        """La wallet con ese id.

        Raises:
            WalletNoEncontrada: si no existe.
        """
        for wallet in self.listar():
            if wallet.id == walletId:
                return wallet
        raise WalletNoEncontrada("Esa wallet ya no está enlazada")

    def anadir(self, wallet: Wallet) -> Wallet:
        """Guarda una wallet nueva.

        Raises:
            LimiteWallets: si hay un `MAX_WALLETS` y ya se ha llegado a él.
            WalletError: si esa misma dirección o xpub ya está enlazada, o si su
                seguimiento ya existe y es de wallets de otro dueño (propias o ajenas).
        """
        def cambio(wallets: list[Wallet]) -> list[Wallet]:
            if MAX_WALLETS is not None and len(wallets) >= MAX_WALLETS:
                raise LimiteWallets(f"Como máximo se pueden enlazar {MAX_WALLETS} wallets")
            if any(w.red == wallet.red and w.valor == wallet.valor for w in wallets):
                raise WalletError("Esa wallet ya está enlazada")
            comprobarDuenoSeguimiento(wallets, wallet)
            return [*wallets, wallet]

        self._modificar(cambio)
        return wallet

    def eliminar(self, walletId: str) -> None:
        """Quita una wallet. Las transacciones ya importadas se quedan.

        Raises:
            WalletNoEncontrada: si no existe.
        """
        def cambio(wallets: list[Wallet]) -> list[Wallet]:
            restantes = [w for w in wallets if w.id != walletId]
            if len(restantes) == len(wallets):
                raise WalletNoEncontrada("Esa wallet ya no está enlazada")
            return restantes

        self._modificar(cambio)

    def eliminarSeguimiento(self, clave: str) -> list[Wallet]:
        """Quita todas las wallets de un seguimiento en una sola escritura.

        Args:
            clave: `claveSeguimiento` del seguimiento que se deja de seguir.

        Returns:
            Las wallets quitadas.

        Raises:
            WalletNoEncontrada: si ninguna wallet es de ese seguimiento.
        """
        quitadas = []

        def cambio(wallets: list[Wallet]) -> list[Wallet]:
            restantes = [w for w in wallets if w.claveSeguimiento != clave]
            if len(restantes) == len(wallets):
                raise WalletNoEncontrada("Ese seguimiento ya no existe")
            quitadas.extend(w for w in wallets if w.claveSeguimiento == clave)
            return restantes

        self._modificar(cambio)
        return quitadas

    def vincularDireccion(self, red: str, direccion: str, seguimiento: str, assetId: str) -> Wallet:
        """Convierte una dirección «mía» de la libreta en una wallet de un seguimiento.

        Quitar la marca y crear la wallet van en una sola escritura: una marca
        manual manda sobre la enlazada (`Libreta.desde`) y, si quedase, la
        dirección saldría dos veces y conservaría un apodo distinto al del seguimiento.

        Args:
            red: Red de la dirección.
            direccion: Dirección en forma canónica.
            seguimiento: Nombre del seguimiento, nuevo o existente, ya saneado.
            assetId: Cripto de Activos para la moneda de la red, ya validada.

        Returns:
            La wallet creada; su alias es el apodo de la dirección o, sin apodo, el seguimiento.

        Raises:
            WalletError: si la dirección no está marcada como propia, ya está
                enlazada o el seguimiento es de wallets ajenas.
        """
        creadas = []

        def cambio(datos: dict) -> dict:
            wallets = _registros(datos, "wallets", Wallet)
            direcciones = _registros(datos, "direcciones", DireccionMarcada)
            marcada = next((d for d in direcciones if (d.red, d.direccion) == (red, direccion)), None)
            if marcada is None or not marcada.propia:
                raise WalletError("Esa dirección no está marcada como tuya")
            if any(w.red == red and w.valor == direccion for w in wallets):
                raise WalletError("Esa dirección ya está enlazada: quita la marca de la libreta")
            nombre = _nombreDeSeguimiento(wallets, seguimiento)
            wallet = Wallet(id=nuevoId(), alias=marcada.apodo or nombre, red=red, tipo=TIPO_DIRECCION,
                            valor=direccion, assetId=assetId, creada=ahoraIso(), seguimiento=nombre)
            comprobarDuenoSeguimiento(wallets, wallet)
            creadas.append(wallet)
            return {**datos, "wallets": [asdict(w) for w in [*wallets, wallet]],
                    "direcciones": [asdict(d) for d in direcciones if d is not marcada]}

        self._modificarDatos(cambio)
        return creadas[0]

    def moverASeguimiento(self, walletId: str, seguimiento: str) -> Wallet:
        """Pasa una wallet a otro seguimiento, nuevo o existente, sin tocar sus lecturas.

        Args:
            walletId: Wallet que se mueve.
            seguimiento: Nombre del seguimiento de destino, ya saneado.

        Returns:
            La wallet ya en su nuevo seguimiento.

        Raises:
            WalletNoEncontrada: si no existe.
            WalletError: si el seguimiento de destino es de wallets de otro dueño.
        """
        resultado = []

        def cambio(wallets: list[Wallet]) -> list[Wallet]:
            actual = next((w for w in wallets if w.id == walletId), None)
            if actual is None:
                raise WalletNoEncontrada("Esa wallet ya no está enlazada")
            otras = [w for w in wallets if w.id != walletId]
            movida = replace(actual, seguimiento=_nombreDeSeguimiento(otras, seguimiento))
            comprobarDuenoSeguimiento(otras, movida)
            resultado.append(movida)
            return [movida if w.id == walletId else w for w in wallets]

        self._modificar(cambio)
        return resultado[0]

    def devolverALibreta(self, walletId: str) -> DireccionMarcada:
        """Saca una dirección propia de su seguimiento y la deja en la libreta como «mía».

        Es lo contrario de `vincularDireccion`: la dirección sigue contando como
        propia al clasificar movimientos, pero deja de vigilarse y de sumar al total.

        Args:
            walletId: Wallet propia enlazada por dirección.

        Returns:
            La entrada de la libreta, con el alias de la wallet como apodo.

        Raises:
            WalletNoEncontrada: si no existe.
            WalletError: si es ajena, es una xpub o una clave pública, o la
                libreta ya tiene `MAX_DIRECCIONES`.
        """
        resultado = []

        def cambio(datos: dict) -> dict:
            wallets = _registros(datos, "wallets", Wallet)
            wallet = next((w for w in wallets if w.id == walletId), None)
            if wallet is None:
                raise WalletNoEncontrada("Esa wallet ya no está enlazada")
            if not wallet.propia or wallet.tipo != TIPO_DIRECCION:
                raise WalletError("Solo una dirección propia puede volver a la libreta")
            marcada = DireccionMarcada(red=wallet.red, direccion=wallet.valor, apodo=wallet.alias, propia=True)
            direcciones = [d for d in _registros(datos, "direcciones", DireccionMarcada)
                           if (d.red, d.direccion) != (wallet.red, wallet.valor)]
            if len(direcciones) >= MAX_DIRECCIONES:
                raise WalletError(f"Como máximo se pueden guardar {MAX_DIRECCIONES} direcciones")
            resultado.append(marcada)
            return {**datos, "wallets": [asdict(w) for w in wallets if w.id != walletId],
                    "direcciones": [asdict(d) for d in [*direcciones, marcada]]}

        self._modificarDatos(cambio)
        return resultado[0]

    def marcarSincronizada(self, walletId: str, cuando: str) -> None:
        """Anota la fecha de la última sincronización correcta."""
        self.actualizar(walletId, ultimaSincronizacion=cuando)

    def actualizar(self, walletId: str, **cambios) -> Wallet:
        """Cambia campos de una wallet (nunca `id`, `red`, `tipo` ni `valor`).

        Raises:
            WalletNoEncontrada: si no existe.
            WalletError: si se intenta cambiar un campo de identidad.
        """
        if {"id", "red", "tipo", "valor"} & set(cambios):
            raise WalletError("La dirección o la red de una wallet no se cambian: desenlázala y vuelve a enlazarla")
        resultado = []

        def cambio(wallets: list[Wallet]) -> list[Wallet]:
            nuevas = [replace(w, **cambios) if w.id == walletId else w for w in wallets]
            resultado.extend(w for w in nuevas if w.id == walletId)
            if not resultado:
                raise WalletNoEncontrada("Esa wallet ya no está enlazada")
            return nuevas

        self._modificar(cambio)
        return resultado[0]

    def renombrarSeguimiento(self, clave: str, nombre: str) -> list[Wallet]:
        """Cambia el nombre de un seguimiento en todas sus wallets, en una sola escritura.

        Args:
            clave: `claveSeguimiento` del seguimiento que se renombra.
            nombre: Nombre nuevo, ya saneado.

        Returns:
            Las wallets del seguimiento, ya con el nombre nuevo.

        Raises:
            WalletNoEncontrada: si ninguna wallet es de ese seguimiento.
            WalletError: si el nombre nuevo ya es de otro seguimiento.
        """
        nuevaClave = claveSeguimiento(nombre)
        resultado = []

        def cambio(wallets: list[Wallet]) -> list[Wallet]:
            if not any(w.claveSeguimiento == clave for w in wallets):
                raise WalletNoEncontrada("Ese seguimiento ya no existe")
            # Renombrar no une seguimientos: juntaría dos tarjetas sin querer y,
            # si el otro es de otro dueño, propias con ajenas.
            if nuevaClave != clave and any(w.claveSeguimiento == nuevaClave for w in wallets):
                raise WalletError(f"Ya hay un seguimiento llamado «{nombre}»")
            nuevas = [replace(w, seguimiento=nombre) if w.claveSeguimiento == clave else w for w in wallets]
            resultado.extend(w for w in nuevas if w.claveSeguimiento == nuevaClave)
            return nuevas

        self._modificar(cambio)
        return resultado

    def ajustarSeguimiento(
        self, clave: str, ajustarConfig: Callable[[dict], dict] | None = None, **cambios
    ) -> list[Wallet]:
        """Aplica los mismos cambios a todas las wallets de un seguimiento, en una sola escritura.

        Args:
            clave: `claveSeguimiento` del seguimiento.
            ajustarConfig: Si viene, recibe el `avisosConfig` de cada wallet y
                devuelve el nuevo: para cambiar solo unos ajustes y dejar el resto
                como lo tenga cada una. Si lanza, no se guarda nada.
            **cambios: Campos que se cambian (nunca los de identidad ni el seguimiento).

        Returns:
            Las wallets del seguimiento, ya cambiadas.

        Raises:
            WalletNoEncontrada: si ninguna wallet es de ese seguimiento.
            WalletError: si se intenta cambiar un campo de identidad o el seguimiento.
        """
        if {"id", "red", "tipo", "valor", "seguimiento"} & set(cambios):
            raise WalletError("Eso no se cambia desde aquí")
        resultado = []

        def cambio(wallets: list[Wallet]) -> list[Wallet]:
            nuevas = [_ajustada(w, ajustarConfig, cambios) if w.claveSeguimiento == clave else w for w in wallets]
            resultado.extend(w for w in nuevas if w.claveSeguimiento == clave)
            if not resultado:
                raise WalletNoEncontrada("Ese seguimiento ya no existe")
            return nuevas

        self._modificar(cambio)
        return resultado

    def _modificar(self, cambio: Callable[[list[Wallet]], list[Wallet]]) -> None:
        def cambioDatos(datos: dict) -> dict:
            wallets = cambio(_registros(datos, "wallets", Wallet))
            return {**datos, "wallets": [asdict(w) for w in wallets]}

        self._modificarDatos(cambioDatos)

    def _modificarTokens(self, cambio: Callable[[list[TokenVerificado]], list[TokenVerificado]]) -> None:
        def cambioDatos(datos: dict) -> dict:
            tokens = cambio(_registros(datos, "tokens", TokenVerificado))
            return {**datos, "tokens": [asdict(t) for t in tokens]}

        self._modificarDatos(cambioDatos)

    def _modificarDatos(self, cambio: Callable[[dict], dict]) -> None:
        # Leer, cambiar y escribir bajo un bloqueo entre procesos: con dos
        # workers de gunicorn, dos altas simultáneas se pisarían la una a la otra.
        # Un solo bloqueo para los dos ficheros: una wallet nunca cambia de
        # fichero a medias para otro proceso.
        with bloqueo.exclusivo(self.ruta.with_name(f".{NOMBRE_FICHERO}.lock"), espera=_ESPERA_BLOQUEO_SEGUNDOS):
            cifradoAntes = self._leerDatos()
            ajenasAntes = self._leerAjenas()
            datos = cambio(self._leerTodo())
            wallets = datos.get("wallets", [])
            ajenas = [w for w in wallets if w.get("propia", True) is False]
            cifrado = {**datos, "wallets": [w for w in wallets if w.get("propia", True) is not False]}
            # Primero el JSON: si algo corta entre las dos escrituras, la ajena
            # queda duplicada (y `_leerTodo` se queda con esta), nunca perdida.
            if ajenas != ajenasAntes:
                self._escribirAjenas(ajenas)
            # Sin cambios en lo cifrado no se toca wallets.key: así seguir
            # wallets ajenas no necesita SECRET_KEY.
            if _contenido(cifrado) != _contenido(cifradoAntes):
                claro = json.dumps({**cifrado, "version": 1}, ensure_ascii=False)
                escribirAtomico(self.ruta, _PREFIJO + self._fernet().encrypt(claro.encode("utf-8")), permisos=0o600)
        # debug y no info: la vigilancia lo reescribe en cada pasada.
        log.debug("[wallets] Wallets actualizadas (%d propias, %d ajenas)", len(wallets) - len(ajenas), len(ajenas))

    def _escribirAjenas(self, ajenas: list[dict]) -> None:
        texto = json.dumps({"version": 1, "wallets": ajenas}, ensure_ascii=False, indent=1)
        escribirAtomico(self.rutaAjenas, texto.encode("utf-8"), permisos=0o600)
