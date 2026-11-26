"""Canjes de valores por fusión, absorción o canje: qué movimientos FIFO generan.

Una fusión cambia los títulos de una sociedad por los de otra según una ecuación
de canje (por ejemplo, 1 acción de A por 0,85 de B). Fiscalmente hay dos
tratamientos, y el usuario elige el que corresponda a cada operación porque
depende de datos que la aplicación no puede comprobar:

* **Régimen neutral** (régimen especial de fusiones, canjes y escisiones: arts.
  76 a 89 LIS; para el socio, art. 81 LIS). El canje no genera renta. Los
  títulos recibidos se valoran por el valor fiscal de los entregados y
  **conservan su fecha de adquisición**, así que cada lote FIFO de A se convierte
  en un lote de B con su misma fecha y su mismo coste; solo cambia la cantidad.
  La compensación complementaria en dinero disminuye ese valor (art. 81.1 LIS).
  Los picos (la fracción de título que la entidad liquida en efectivo) son una
  transmisión ordinaria de títulos ya canjeados.
* **Régimen general** (el canje no se acoge al especial): es una permuta (art.
  37.1.h LIRPF). Se transmiten los títulos de A por el valor de mercado de lo
  recibido, con ganancia o pérdida por FIFO, y los de B se adquieren por ese
  valor con la fecha del canje.

Si una fusión entre sociedades no residentes en la UE (por ejemplo, dos
estadounidenses) puede acogerse al régimen neutral depende de la doctrina de la
DGT para cada operación; por eso no se decide aquí.

Este módulo es puro: recibe el canje ya leído y en euros, y devuelve
`Operacion` del motor FIFO. La lectura de la base y el orden en la línea
temporal viven en `stores.ventas_fifo`.

Patrón: Strategy. Cada régimen es una estrategia con la misma interfaz, y
`estrategia()` elige la que corresponde al canje.
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from core import fifo
from core.fifo import ADQUISICION, TRANSMISION, Operacion, Resultado

NEUTRAL = "neutral"
GRAVADO = "gravado"
REGIMENES = (NEUTRAL, GRAVADO)

ORIGEN = "canje"

# Incidencias propias del canje (las de reparto vienen de `core.fifo`).
INCIDENCIA_SIN_VALOR = "canje_valor_mercado_pendiente"
INCIDENCIA_COMPENSACION = "canje_compensacion_excede_coste"
INCIDENCIA_ACTIVO = "canje_activo_desconocido"

# Separación de las operaciones del canje en la línea temporal: detrás de las
# ventas del mismo día (2_000_000) y delante de las simulaciones (3_000_000). Un
# canje se ejecuta al cierre del día: lo vendido ese día ya no se canjea.
ORDEN_BASE = 2_500_000

_CERO = Decimal("0")


class CanjeError(ValueError):
    """Canje con un régimen que no existe."""


@dataclass(frozen=True)
class Canje:
    """Un canje ya validado, con los importes en euros.

    Attributes:
        id: Identificador estable del canje.
        fecha: Día en que se ejecutó el canje.
        origenId: Activo cuyos títulos se entregan.
        destinoId: Activo cuyos títulos se reciben.
        entregadas: Títulos de origen entregados.
        recibidas: Títulos enteros de destino recibidos.
        regimen: `NEUTRAL` o `GRAVADO`.
        valorMercadoEur: Valor de mercado de los títulos recibidos; obligatorio
            en el régimen general, informativo en el neutral. None si no consta.
        compensacionEur: Compensación complementaria en dinero recibida.
        picosCantidad: Fracción de título de destino liquidada en efectivo.
        picosImporteEur: Efectivo cobrado por los picos.
        secuencia: Orden de alta, para desempatar canjes del mismo día.
        defecto: Incidencia de los datos del propio canje (tipo de cambio que
            falta, por ejemplo); vacío si están bien.
    """

    id: str
    fecha: date
    origenId: str
    destinoId: str
    entregadas: Decimal
    recibidas: Decimal
    regimen: str
    valorMercadoEur: Decimal | None = None
    compensacionEur: Decimal = _CERO
    picosCantidad: Decimal = _CERO
    picosImporteEur: Decimal = _CERO
    secuencia: int = 0
    defecto: str = ""

    @property
    def refEntrega(self) -> str:
        """Ref de la transmisión de los títulos de origen."""
        return f"canje:{self.id}:entrega"

    @property
    def refPicos(self) -> str:
        """Ref de la transmisión de los picos en el activo de destino."""
        return f"canje:{self.id}:picos"

    def refLote(self, indice: int) -> str:
        """Ref del lote de destino número `indice`."""
        return f"canje:{self.id}:lote:{indice}"

    @property
    def orden(self) -> int:
        return ORDEN_BASE + self.secuencia

    @property
    def titulosDestino(self) -> Decimal:
        """Títulos de destino que corresponden por la ecuación, picos incluidos."""
        return self.recibidas + self.picosCantidad


class RegimenNeutral:
    """Canje sin renta: los lotes pasan al destino con su fecha y su coste."""

    def operacionEntrega(self, canje: Canje) -> Operacion:
        """Salida de los títulos de origen, sin resultado declarable."""
        return Operacion(
            ref=canje.refEntrega,
            activoId=canje.origenId,
            fecha=canje.fecha,
            tipo=TRANSMISION,
            cantidad=canje.entregadas,
            defecto=canje.defecto,
            orden=canje.orden,
            origen=ORIGEN,
            fiscal=False,
        )

    def operacionesDestino(self, canje: Canje, entrega: Resultado) -> list[Operacion]:
        """Un lote de destino por cada trozo de lote de origen entregado.

        Args:
            canje: El canje.
            entrega: Resultado FIFO de `operacionEntrega` sobre el origen.

        Returns:
            Las adquisiciones heredadas y, si hay picos, su transmisión. Vacía si
            la entrega no pudo consumir lotes (no había títulos suficientes): sin
            lotes de origen no hay coste que heredar, y la incidencia ya sale en
            la entrega.
        """
        if not entrega.lotes:
            return []
        operaciones = [
            self._loteHeredado(canje, indice, consumo, entrega.incidencia)
            for indice, consumo in enumerate(entrega.lotes)
        ]
        if canje.picosCantidad > 0:
            operaciones.append(_transmisionPicos(canje))
        return operaciones

    def _loteHeredado(self, canje: Canje, indice: int, consumo, incidencia: str) -> Operacion:
        proporcion = consumo.cantidad / canje.entregadas
        coste = consumo.coste - canje.compensacionEur * proporcion
        defecto = incidencia or consumo.defecto or canje.defecto
        if coste < 0:
            # La compensación supera el valor fiscal: el art. 81.1 LIS solo dice
            # que lo disminuye. El exceso no se convierte aquí en ganancia; se
            # deja a cero y marcado para que se revise.
            coste = _CERO
            defecto = defecto or INCIDENCIA_COMPENSACION
        return Operacion(
            ref=canje.refLote(indice),
            activoId=canje.destinoId,
            fecha=canje.fecha,
            tipo=ADQUISICION,
            cantidad=consumo.cantidad * canje.titulosDestino / canje.entregadas,
            importe=coste,
            defecto=defecto,
            orden=canje.orden,
            origen=ORIGEN,
            fiscal=False,
            fechaAntiguedad=consumo.fechaAdquisicion,
            perdidaDiferida=consumo.perdidaDiferida,
        )


class RegimenGravado:
    """Canje como permuta: transmisión a valor de mercado y lote nuevo."""

    def operacionEntrega(self, canje: Canje) -> Operacion:
        """Transmisión de los títulos de origen por todo lo recibido.

        El valor de transmisión es el de mercado de los títulos recibidos más el
        efectivo cobrado (compensación y picos): todo es contraprestación de lo
        entregado.
        """
        valor = canje.valorMercadoEur or _CERO
        return Operacion(
            ref=canje.refEntrega,
            activoId=canje.origenId,
            fecha=canje.fecha,
            tipo=TRANSMISION,
            cantidad=canje.entregadas,
            importe=valor + canje.compensacionEur + canje.picosImporteEur,
            defecto=_defectoGravado(canje),
            orden=canje.orden,
            origen=ORIGEN,
            fiscal=True,
        )

    def operacionesDestino(self, canje: Canje, entrega: Resultado) -> list[Operacion]:
        """Un único lote de destino, adquirido el día del canje a valor de mercado.

        Se genera aunque la entrega tenga incidencia: los títulos se recibieron
        igualmente, y quitarlos descuadraría el destino además del origen.
        """
        if canje.recibidas <= 0:
            return []
        return [Operacion(
            ref=canje.refLote(0),
            activoId=canje.destinoId,
            fecha=canje.fecha,
            tipo=ADQUISICION,
            cantidad=canje.recibidas,
            importe=canje.valorMercadoEur or _CERO,
            defecto=_defectoGravado(canje),
            orden=canje.orden,
            origen=ORIGEN,
            fiscal=False,
        )]


def _defectoGravado(canje: Canje) -> str:
    if canje.defecto:
        return canje.defecto
    if canje.valorMercadoEur is None or canje.valorMercadoEur <= 0:
        return INCIDENCIA_SIN_VALOR
    return ""


def _transmisionPicos(canje: Canje) -> Operacion:
    """Venta de la fracción sobrante, ya en títulos de destino."""
    return Operacion(
        ref=canje.refPicos,
        activoId=canje.destinoId,
        fecha=canje.fecha,
        tipo=TRANSMISION,
        cantidad=canje.picosCantidad,
        importe=canje.picosImporteEur,
        defecto=canje.defecto,
        orden=canje.orden,
        origen=ORIGEN,
        fiscal=True,
    )


_ESTRATEGIAS = {NEUTRAL: RegimenNeutral(), GRAVADO: RegimenGravado()}


def estrategia(regimen: str):
    """Estrategia del régimen indicado.

    Raises:
        CanjeError: si el régimen no es uno de `REGIMENES`.
    """
    try:
        return _ESTRATEGIAS[regimen]
    except KeyError:
        raise CanjeError(f"Régimen de canje desconocido: {regimen!r}") from None


def esRefDeCanje(ref: str) -> bool:
    """Si una ref de operación pertenece a un canje."""
    return str(ref).startswith("canje:")


def idDeRef(ref: str) -> str:
    """Id del canje al que pertenece una ref (`canje:<id>:...`)."""
    return str(ref).split(":", 2)[1]


def fechaFifo(texto) -> date:
    """Fecha del canje, con el mismo lector estricto que el resto del FIFO."""
    return fifo.parseFecha(texto, "fecha del canje")
