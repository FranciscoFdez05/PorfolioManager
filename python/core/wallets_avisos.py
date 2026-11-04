"""Qué avisa cada wallet por Telegram y cómo se entregan esos avisos.

Reglas puras, sin red ni ficheros: las usa `wallets_vigilancia` en cada
revisión y las rutas para validar lo que llega del navegador.

Tipos de aviso:

* **Movimientos**, filtrados por dirección (recibidas, enviadas, entre
  direcciones propias), por si son tokens y por un mínimo en moneda nativa
  (`Wallet.umbralAviso`) o en euros.
* **Saldo** que baja de un mínimo o sube de un máximo. Avisa al cruzar el
  límite, no en cada revisión mientras siga fuera.
* **Wallet que despierta**: vuelve a moverse tras N días quieta.
* **Movimientos sospechosos**, que avisan aunque los filtros de arriba no
  dejen pasar el movimiento: envío a una dirección nunca vista, polvo o
  dirección que imita a una conocida (envenenamiento de direcciones), vaciado
  de la wallet, ráfaga de envíos en una misma revisión y token imitación.
  Apagados por defecto.

Un token imitación (marcado así por el usuario o detectado por
`core.wallets_tokens`) nunca avisa como un movimiento normal: es spam que llega
sin pedirlo. Solo avisa como sospechoso, con `imitaciones` o si además cumple
otro motivo (la dirección parecida del envenenamiento suele venir con uno).

Entrega: un mensaje por aviso, todos en uno (`agrupar`) o hasta un tope por
revisión con el resto juntos en el último. En las horas de silencio no se
manda nada: se guarda y sale en un solo mensaje al terminar.
"""

import re
from dataclasses import asdict, dataclass, fields
from datetime import datetime
from decimal import Decimal, InvalidOperation

from providers.blockchain_clients import ENTRE_WALLETS, ENVIADA, RECIBIDA, MovimientoWallet

MAX_DIAS_DORMIDA = 3650
# Vaciado: el saldo queda en el 10 % o menos del que había tras algún envío.
FRACCION_VACIADO = Decimal("0.9")
# Ráfaga: tantos envíos o más entre dos revisiones.
MIN_RAFAGA = 3
# Polvo: lo recibido que vale menos que esto. Sin precio, solo los importes cero
# (el spam de tokens de valor nulo): sin listas por red ni por activo.
UMBRAL_POLVO_EUR = Decimal("1")
# Una dirección «parecida» comparte principio y final con una conocida sin ser
# ella: es lo que mira quien copia una dirección del historial a ojo, y lo que
# imitan los ataques de envenenamiento.
_PARECIDA_INICIO = 6
_PARECIDA_FINAL = 4

MOTIVO_NUEVA = "envío a una dirección nunca vista"
MOTIVO_POLVO = "importe ínfimo (polvo)"
MOTIVO_PARECIDA = "dirección parecida a una conocida: no la copies del historial"
MOTIVO_IMITACION = "token imitación: no interactúes con su contrato"
MAX_AVISOS_REVISION = 50
# Los avisos de las horas de silencio que se guardan, como mucho, por wallet.
MAX_PENDIENTES = 50
# Telegram rechaza los textos de más de 4096 caracteres; se deja margen.
MAX_LARGO_MENSAJE = 4000
_HORA = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_LARGO_NUMERO = 40

BAJO = "bajo"
ALTO = "alto"


class ConfigAvisosInvalida(ValueError):
    """Un ajuste de avisos no válido. `campo` es la clave que lo causa."""

    def __init__(self, mensaje: str, campo: str) -> None:
        super().__init__(mensaje)
        self.campo = campo


@dataclass(frozen=True)
class ConfigAvisos:
    """Ajustes de avisos de una wallet. Los valores por defecto avisan de todo, como antes de existir.

    Los importes van como texto («0.5») para no perder precisión al guardarlos
    en JSON; vacío significa sin límite. Las horas, «HH:MM» en hora local.
    """

    recibidas: bool = True
    enviadas: bool = True
    internas: bool = True
    tokens: bool = True
    minimoEur: str = ""
    saldoMinimo: str = ""
    saldoMaximo: str = ""
    despiertaDias: int = 0
    agrupar: bool = False
    maxPorRevision: int = 0
    silencioDesde: str = ""
    silencioHasta: str = ""
    direccionNueva: bool = False
    vaciado: bool = False
    polvo: bool = False
    rafaga: bool = False
    imitaciones: bool = False

    @classmethod
    def desdeGuardado(cls, datos: dict | None) -> "ConfigAvisos":
        """La configuración guardada en la wallet; lo que no se entienda, por defecto.

        Tolerante a propósito: un fichero escrito por otra versión no debe dejar
        la vigilancia sin avisos.
        """
        try:
            return cls.validar(datos or {})
        except ConfigAvisosInvalida:
            return cls()

    @classmethod
    def validar(cls, datos: dict) -> "ConfigAvisos":
        """Valida y normaliza lo que llega del navegador.

        Args:
            datos: Claves de `ConfigAvisos`; las que falten toman su valor por defecto.

        Returns:
            La configuración normalizada.

        Raises:
            ConfigAvisosInvalida: si algún valor no es válido.

        Example:
            >>> ConfigAvisos.validar({"minimoEur": "0,50", "enviadas": False}).minimoEur
            '0.5'
        """
        if not isinstance(datos, dict):
            raise ConfigAvisosInvalida("Los ajustes de avisos no son válidos", "avisosConfig")
        defecto = cls()
        booleanos = {
            nombre: _booleano(datos.get(nombre, getattr(defecto, nombre)), nombre)
            for nombre in _BOOLEANOS
        }
        config = cls(
            **booleanos,
            minimoEur=_numero(datos.get("minimoEur"), "minimoEur", "El mínimo en euros"),
            saldoMinimo=_numero(datos.get("saldoMinimo"), "saldoMinimo", "El saldo mínimo"),
            saldoMaximo=_numero(datos.get("saldoMaximo"), "saldoMaximo", "El saldo máximo"),
            despiertaDias=_entero(datos.get("despiertaDias"), "despiertaDias", MAX_DIAS_DORMIDA,
                                  "Los días sin movimientos"),
            maxPorRevision=_entero(datos.get("maxPorRevision"), "maxPorRevision", MAX_AVISOS_REVISION,
                                   "El máximo de avisos por revisión"),
            silencioDesde=_hora(datos.get("silencioDesde"), "silencioDesde"),
            silencioHasta=_hora(datos.get("silencioHasta"), "silencioHasta"),
        )
        if config.saldoMinimo and config.saldoMaximo and Decimal(config.saldoMinimo) >= Decimal(config.saldoMaximo):
            raise ConfigAvisosInvalida("El saldo mínimo tiene que ser menor que el máximo", "saldoMaximo")
        if bool(config.silencioDesde) != bool(config.silencioHasta):
            raise ConfigAvisosInvalida("Pon el principio y el final de las horas de silencio", "silencioHasta")
        if config.silencioDesde and config.silencioDesde == config.silencioHasta:
            raise ConfigAvisosInvalida("Las horas de silencio no pueden empezar y acabar a la vez", "silencioHasta")
        return config

    def comoDict(self) -> dict:
        return asdict(self)


_BOOLEANOS = tuple(f.name for f in fields(ConfigAvisos) if isinstance(f.default, bool))


def _booleano(valor, campo: str) -> bool:
    if not isinstance(valor, bool):
        raise ConfigAvisosInvalida("Valor no válido", campo)
    return valor


def _numero(valor, campo: str, nombre: str) -> str:
    texto = str(valor if valor is not None else "").strip().replace(",", ".")
    if not texto:
        return ""
    if len(texto) > _LARGO_NUMERO:
        raise ConfigAvisosInvalida(f"{nombre} es demasiado largo", campo)
    try:
        numero = Decimal(texto)
    except InvalidOperation as error:
        raise ConfigAvisosInvalida(f"{nombre} debe ser un número sin signo", campo) from error
    if not numero.is_finite() or numero < 0:
        raise ConfigAvisosInvalida(f"{nombre} debe ser un número sin signo", campo)
    # Sin exponente ni ceros de sobra, como `wallets_sync.textoDecimal`.
    return format(numero.normalize(), "f")


def _entero(valor, campo: str, maximo: int, nombre: str) -> int:
    if valor in (None, ""):
        return 0
    if isinstance(valor, bool):
        raise ConfigAvisosInvalida(f"{nombre} debe ser un número entero", campo)
    try:
        numero = int(str(valor).strip())
    except ValueError as error:
        raise ConfigAvisosInvalida(f"{nombre} debe ser un número entero", campo) from error
    if not 0 <= numero <= maximo:
        raise ConfigAvisosInvalida(f"{nombre} tiene que estar entre 0 y {maximo}", campo)
    return numero


def _hora(valor, campo: str) -> str:
    texto = str(valor or "").strip()
    if texto and not _HORA.match(texto):
        raise ConfigAvisosInvalida("La hora va como HH:MM, por ejemplo 23:00", campo)
    return texto


# ── Reglas ────────────────────────────────────────────────────────────────────

def superaUmbral(umbralAviso: str, movimiento: MovimientoWallet) -> bool:
    """¿Supera el mínimo en moneda nativa? Sin mínimo, todo.

    Un mínimo en BTC no se puede comparar con un token, así que con mínimo los
    tokens no avisan: es lo que se quiere al seguir una ballena llena de spam.
    """
    try:
        umbral = Decimal(umbralAviso) if umbralAviso else None
    except InvalidOperation:
        umbral = None
    if umbral is None:
        return True
    return not movimiento.contrato and movimiento.cantidad >= umbral


def avisaDeMovimiento(config: ConfigAvisos, umbralAviso: str, movimiento: MovimientoWallet,
                      precioEur: Decimal | None, imitacion: bool = False) -> bool:
    """¿Merece aviso este movimiento según su tipo, si es token y los mínimos?

    Con mínimo en euros, los tokens no avisan (no tienen precio aquí) y la
    moneda nativa sin precio conocido sí: mejor un aviso de más que perder uno.
    Un token imitación (`imitacion`) nunca avisa por aquí; solo como sospechoso.
    """
    if imitacion:
        return False
    if movimiento.tipo == ENVIADA:
        permitido = config.enviadas
    elif movimiento.tipo == ENTRE_WALLETS:
        permitido = config.internas
    else:
        permitido = config.recibidas
    if not permitido or (movimiento.contrato and not config.tokens):
        return False
    if not superaUmbral(umbralAviso, movimiento):
        return False
    if config.minimoEur:
        if movimiento.contrato:
            return False
        if precioEur is not None and movimiento.cantidad * precioEur < Decimal(config.minimoEur):
            return False
    return True


def pareceA(direccion: str, conocidas: set[str]) -> bool:
    """¿Se parece `direccion` a alguna conocida sin ser ninguna de ellas?

    Las direcciones van en forma canónica: con mayúsculas distintas, una
    dirección EVM sería «parecida» a sí misma.

    Example:
        >>> pareceA("0xabcd99999999dead", {"0xabcd11111111dead"})
        True
    """
    if not direccion or direccion in conocidas or len(direccion) < _PARECIDA_INICIO + _PARECIDA_FINAL:
        return False
    inicio, final = direccion[:_PARECIDA_INICIO], direccion[-_PARECIDA_FINAL:]
    return any(c.startswith(inicio) and c.endswith(final) for c in conocidas)


def _esPolvo(movimiento: MovimientoWallet, precioEur: Decimal | None) -> bool:
    if movimiento.cantidad == 0:
        return True
    return not movimiento.contrato and precioEur is not None and movimiento.cantidad * precioEur < UMBRAL_POLVO_EUR


def motivosSospecha(config: ConfigAvisos, movimiento: MovimientoWallet, contraparte: str,
                    vistas: set[str] | None, libreta: set[str], precioEur: Decimal | None,
                    imitacion: bool = False) -> list[str]:
    """Por qué un movimiento parece sospechoso; vacío si no lo parece.

    Args:
        config: Ajustes de la wallet.
        movimiento: Movimiento con el tipo efectivo (ya pasado por la libreta).
        contraparte: Su contraparte en forma canónica ('' si no tiene).
        vistas: Contrapartes de movimientos anteriores, canónicas; None si aún
            no se han apuntado (wallet de una versión anterior): entonces
            ninguna dirección cuenta como nueva.
        libreta: Direcciones de la libreta en la red del movimiento, canónicas.
        precioEur: Precio de la moneda nativa, para medir el polvo.
        imitacion: Si el movimiento es de un token imitación.
    """
    motivos = []
    if config.imitaciones and imitacion:
        motivos.append(MOTIVO_IMITACION)
    conocidas = (vistas or set()) | libreta
    if (config.direccionNueva and vistas is not None and movimiento.tipo == ENVIADA and contraparte
            and contraparte not in conocidas):
        motivos.append(MOTIVO_NUEVA)
    if config.polvo and movimiento.tipo == RECIBIDA and _esPolvo(movimiento, precioEur):
        motivos.append(MOTIVO_POLVO)
    if config.polvo and movimiento.tipo in (ENVIADA, RECIBIDA) and pareceA(contraparte, conocidas):
        motivos.append(MOTIVO_PARECIDA)
    return motivos


def esVaciado(config: ConfigAvisos, saldoPrevio: Decimal | None, saldo: Decimal | None,
              nuevos: list[MovimientoWallet]) -> bool:
    """¿Ha quedado la wallet casi vacía por envíos de la moneda nativa?

    Mover todo a otra wallet propia no cuenta: `nuevos` lleva el tipo efectivo
    y esos envíos son «entre wallets».
    """
    if not config.vaciado or not saldoPrevio or saldo is None or saldoPrevio <= 0:
        return False
    envio = any(m.tipo == ENVIADA and not m.contrato for m in nuevos)
    return envio and saldo <= saldoPrevio * (1 - FRACCION_VACIADO)


def enviosRafaga(config: ConfigAvisos, nuevos: list[MovimientoWallet]) -> int:
    """Cuántos envíos hay si forman una ráfaga; 0 si no la hay o está apagada."""
    if not config.rafaga:
        return 0
    envios = sum(1 for m in nuevos if m.tipo == ENVIADA)
    return envios if envios >= MIN_RAFAGA else 0


def estadoSaldo(config: ConfigAvisos, saldo: Decimal | None) -> str:
    """«bajo», «alto» o "" según los límites de saldo."""
    if saldo is None:
        return ""
    if config.saldoMinimo and saldo < Decimal(config.saldoMinimo):
        return BAJO
    if config.saldoMaximo and saldo > Decimal(config.saldoMaximo):
        return ALTO
    return ""


def diasDormida(ultimoMovimiento: str, siguiente: datetime) -> int | None:
    """Días entre el último movimiento conocido y `siguiente`; None si no se sabe."""
    if not ultimoMovimiento:
        return None
    try:
        anterior = datetime.fromisoformat(ultimoMovimiento)
        return (siguiente - anterior).days
    except (ValueError, TypeError):
        return None


def enSilencio(config: ConfigAvisos, ahora: datetime) -> bool:
    """¿Cae `ahora` (hora local) en las horas de silencio? Admite franjas que cruzan la medianoche."""
    if not config.silencioDesde:
        return False
    hora = ahora.strftime("%H:%M")
    if config.silencioDesde < config.silencioHasta:
        return config.silencioDesde <= hora < config.silencioHasta
    return hora >= config.silencioDesde or hora < config.silencioHasta


def agrupar(cabecera: str, lineas: list[str]) -> str:
    """Varios avisos en un solo mensaje."""
    return "\n\n".join([cabecera, *lineas])


def trocear(texto: str, maximo: int = MAX_LARGO_MENSAJE) -> list[str]:
    """Parte un mensaje agrupado entre avisos para que Telegram lo acepte.

    Un aviso nunca se parte: va entero en un trozo, y un aviso suelto no llega
    ni de lejos al máximo.

    Example:
        >>> trocear("aaaa\n\nbbbb", maximo=5)
        ['aaaa', 'bbbb']
    """
    trozos, actual = [], ""
    for parte in texto.split("\n\n"):
        candidato = f"{actual}\n\n{parte}" if actual else parte
        if actual and len(candidato) > maximo:
            trozos.append(actual)
            actual = parte
        else:
            actual = candidato
    return [*trozos, actual]


def componerMensajes(nombre: str, lineas: list[str], config: ConfigAvisos) -> list[str]:
    """Los mensajes que salen de una revisión, según `agrupar` y el tope.

    Con tope, salen sueltos los primeros y el resto va junto en el último, para
    que el total de mensajes no lo pase nunca.

    Example:
        >>> componerMensajes("Ledger", ["a", "b", "c"], ConfigAvisos(maxPorRevision=2))
        ['a', 'Y 2 avisos más de «Ledger»:\\n\\nb\\n\\nc']
    """
    if len(lineas) > 1 and config.agrupar:
        return [agrupar(f"{len(lineas)} avisos de «{nombre}»:", lineas)]
    # Sin tope elegido, el máximo admitido: una ballena puede traer 200 movimientos de golpe.
    tope = config.maxPorRevision or MAX_AVISOS_REVISION
    if len(lineas) > tope:
        sueltos = tope - 1
        resto = lineas[sueltos:]
        cabecera = f"Y {len(resto)} avisos más de «{nombre}»:" if sueltos else f"{len(resto)} avisos de «{nombre}»:"
        return [*lineas[:sueltos], agrupar(cabecera, resto)]
    return list(lineas)
