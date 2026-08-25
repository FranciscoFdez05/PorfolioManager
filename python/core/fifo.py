"""Motor FIFO de lotes para ganancias y pérdidas patrimoniales.

España obliga a aplicar FIFO en la transmisión de valores homogéneos (art. 37.2
LIRPF): se entiende transmitido el que se adquirió en primer lugar. Hasta ahora
el cálculo vivía en `js/finanzas/ventas.js`, dentro del navegador, con cuatro
problemas que invalidaban el resultado fiscal:

  1. Los lotes se reconstruían con las ventas del año que estuviera abierto en
     pantalla, así que una venta de 2025 y otra de 2026 consumían ambas los
     mismos lotes originales y el coste de adquisición salía duplicado.
  2. Las pérdidas se recortaban con `Math.max(..., 0)`: una minusvalía
     desaparecía en vez de compensar.
  3. Vender más de lo disponible no era un error, sino una fila con números a
     medias.
  4. Al ser cliente, cualquiera podía guardar los importes que quisiera: el
     servidor almacenaba las cadenas tal cual.

Este módulo es la mitad aritmética de la solución: puro, sin Flask ni SQLite,
en `Decimal` y determinista. La normativa (tramos, antiaplicación,
compensaciones) vive en `core.fiscal_es`, y el puente con la base de datos en
`stores.ventas_fifo`.

Convenios de valoración (art. 35 LIRPF):

  * Valor de adquisición = importe real + gastos y tributos inherentes a la
    compra. Por eso las comisiones **suman** al coste del lote.
  * Valor de transmisión = importe real - gastos satisfechos por el
    transmitente. Por eso las comisiones **restan** al vender.
"""

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from core import dinero

# Cantidades y precios se manejan con esta escala interna. Es holgada a
# propósito: una fracción de bitcoin tiene 8 decimales y el coste unitario de
# un lote parcialmente consumido añade unos cuantos más. El redondeo a dos
# decimales se hace solo al presentar importes, nunca en cadena.
_ESCALA = Decimal("0.00000001")

ADQUISICION = "adquisicion"
TRANSMISION = "transmision"

# Motivos de incidencia. Se devuelven como dato, no como excepción: una
# incidencia describe datos del usuario incoherentes entre sí (vender más de lo
# que hay), y la página tiene que poder cargar y enseñar cuál es la fila mala.
INCIDENCIA_STOCK = "stock_insuficiente"
INCIDENCIA_SIN_LOTES = "sin_adquisiciones"


class FifoError(ValueError):
    """Entrada inutilizable para el motor (tipo de operación desconocido…).

    Reservado para lo que ningún dato de usuario debería poder provocar: las
    rutas validan formato antes, y las incoherencias fiscales salen como
    incidencia, no como excepción.
    """


def _dec(value, campo="importe") -> Decimal:
    """Convierte a Decimal aceptando None, números y cadenas es-ES.

    La conversión en sí vive en `core.dinero`, que es la única que hay en el
    proyecto: había cinco, y dos de ellas devolvían cero para los importes en
    formato español que guarda el propio esquema. Aquí solo se traduce la
    excepción a `FifoError`, porque el motor tiene su propio contrato de
    errores, y se conserva el vacío como cero: una comisión sin rellenar es
    cero comisión, no una fila corrupta.
    """
    if value is None or (isinstance(value, str) and not value.strip()):
        return Decimal("0")
    try:
        return dinero.aDecimal(value, campo)
    except dinero.ImporteInvalido as error:
        raise FifoError(str(error)) from error


def parse_decimal(value, campo="importe") -> Decimal:
    """Igual que `_dec`, expuesto para quien construye las operaciones."""
    return _dec(value, campo)


def parse_fecha(value, campo="fecha") -> date:
    """Acepta dd-mm-aaaa, dd/mm/aaaa y aaaa-mm-dd. Estricta a propósito.

    Una fecha ilegible rompe el orden FIFO entero, así que no hay valor por
    defecto: quien la escribió tiene que corregirla.
    """
    if isinstance(value, date):
        return value

    texto = str(value or "").strip()
    if not texto:
        raise FifoError(f"«{campo}» es obligatoria")

    separadores = ("-", "/")
    for sep in separadores:
        partes = texto.split(sep)
        if len(partes) != 3:
            continue
        try:
            if len(partes[0]) == 4:
                anio, mes, dia = (int(p) for p in partes)
            else:
                dia, mes, anio = (int(p) for p in partes)
            return date(anio, mes, dia)
        except (ValueError, TypeError):
            continue

    raise FifoError(f"«{campo}» no es una fecha válida: {value!r} (usa dd-mm-aaaa)")


@dataclass(frozen=True)
class Operacion:
    """Un movimiento del histórico de un activo, ya normalizado.

    `orden` desempata dentro del mismo día. No basta con la fecha: comprar y
    vender el mismo día es legítimo y el resultado depende del orden, así que
    quien construye la lista fija una secuencia estable (el orden de inserción
    en la base de datos) en vez de dejarlo al azar del sort.
    """

    ref: str
    activo_id: str
    fecha: date
    tipo: str
    cantidad: Decimal
    importe: Decimal = Decimal("0")       # contraprestación bruta, sin comisiones
    comision: Decimal = Decimal("0")
    orden: int = 0
    origen: str = ""                      # "ficha" | "ventas": de dónde salió la fila
    fiscal: bool = True                   # si genera resultado declarable

    def clave_orden(self):
        # Una adquisición del mismo día se coloca antes que la transmisión: no
        # se puede vender por la mañana lo que se compra por la tarde, pero sí
        # al revés, y esta es la lectura que no genera falsos negativos.
        prioridad = 0 if self.tipo == ADQUISICION else 1
        return (self.fecha, prioridad, self.orden)


@dataclass
class Lote:
    """Paquete de participaciones adquirido de una vez, con su coste."""

    ref: str
    fecha: date
    cantidad: Decimal
    coste_total: Decimal
    restante: Decimal
    origen: str = ""
    # Pérdida cuya imputación quedó aplazada por la regla de antiaplicación
    # (art. 33.5 LIRPF) al ser este lote la recompra que la bloqueó. Se libera
    # cuando el lote se transmite. Lo rellena `core.fiscal_es`.
    perdida_diferida: Decimal = Decimal("0")
    # Cantidad de este lote ya usada como "recompra" para bloquear una pérdida,
    # para que una sola recompra no bloquee dos minusvalías distintas.
    bloqueo_usado: Decimal = Decimal("0")

    @property
    def coste_unitario(self) -> Decimal:
        if self.cantidad <= 0:
            return Decimal("0")
        return self.coste_total / self.cantidad


@dataclass
class ConsumoLote:
    """Trozo de un lote imputado a una transmisión concreta.

    Es la traza que hace auditable el FIFO: para cada venta queda escrito de
    qué compras salió, en qué proporción y a qué coste.
    """

    lote_ref: str
    fecha_adquisicion: date
    cantidad: Decimal
    coste_unitario: Decimal
    coste: Decimal
    origen: str = ""


@dataclass
class Resultado:
    """Ganancia o pérdida patrimonial de una transmisión."""

    ref: str
    activo_id: str
    fecha: date
    cantidad: Decimal
    valor_transmision: Decimal
    coste_adquisicion: Decimal
    ganancia: Decimal
    lotes: list = field(default_factory=list)
    disponible_antes: Decimal = Decimal("0")
    fiscal: bool = True
    origen: str = ""
    incidencia: str = ""
    # Rellenados por `core.fiscal_es` al aplicar la regla de los dos meses.
    perdida_no_computable: Decimal = Decimal("0")
    perdida_diferida_liberada: Decimal = Decimal("0")
    nota_antiaplicacion: str = ""

    @property
    def coste_unitario(self) -> Decimal:
        if self.cantidad <= 0:
            return Decimal("0")
        return self.coste_adquisicion / self.cantidad

    @property
    def ganancia_computable(self) -> Decimal:
        """Ganancia que entra en la declaración del ejercicio.

        Se le suma la pérdida que en su día quedó aplazada y que esta
        transmisión libera, y se le descuenta la parte de pérdida que la
        recompra deja fuera.
        """
        return (
            self.ganancia
            + self.perdida_no_computable
            - self.perdida_diferida_liberada
        )


def ordenar(operaciones):
    """Operaciones en orden cronológico estable."""
    return sorted(operaciones, key=lambda op: op.clave_orden())


def aplicar_fifo(operaciones, perdidas_diferidas=None):
    """Recorre el histórico de un activo y resuelve cada transmisión por FIFO.

    Devuelve `(resultados, lotes_vivos)`. Los resultados salen en el mismo
    orden cronológico en que se procesaron, que es el único orden en el que el
    FIFO tiene sentido.

    `perdidas_diferidas` es un mapa `{ref_adquisicion: importe}` con las
    minusvalías que la regla de antiaplicación dejó pendientes de imputar y que
    viajan adheridas al lote de la recompra. Lo calcula `core.fiscal_es`, que
    llama a esta función dos veces: la primera para saber qué pérdidas se
    bloquean, la segunda ya con el importe adherido para poder liberarlo cuando
    esas participaciones se transmitan.

    Una transmisión sin existencias suficientes **no consume nada**: se marca
    con incidencia y los lotes quedan como estaban. Consumir a medias dejaría
    la cartera en un estado que ya no cuadra con ninguna realidad, y arrastraría
    el error a todas las ventas posteriores.
    """
    diferidas = perdidas_diferidas or {}
    lotes: list[Lote] = []
    resultados: list[Resultado] = []

    for op in ordenar(operaciones):
        if op.tipo == ADQUISICION:
            if op.cantidad <= 0:
                continue
            # Valor de adquisición = importe + gastos inherentes (art. 35.1).
            coste = op.importe + op.comision
            lotes.append(Lote(
                ref=op.ref,
                fecha=op.fecha,
                cantidad=op.cantidad,
                coste_total=coste,
                restante=op.cantidad,
                origen=op.origen,
                perdida_diferida=diferidas.get(op.ref, Decimal("0")),
            ))
            continue

        if op.tipo != TRANSMISION:
            raise FifoError(f"Tipo de operación desconocido: {op.tipo!r}")

        resultados.append(_transmitir(lotes, op))

    lotes_vivos = [lote for lote in lotes if lote.restante > 0]
    return resultados, lotes_vivos


def _transmitir(lotes, op):
    disponible = sum((lote.restante for lote in lotes), Decimal("0"))
    # Valor de transmisión = importe - gastos del transmitente (art. 35.2).
    valor_transmision = op.importe - op.comision

    if op.cantidad <= 0 or disponible < op.cantidad:
        return Resultado(
            ref=op.ref,
            activo_id=op.activo_id,
            fecha=op.fecha,
            cantidad=op.cantidad,
            valor_transmision=valor_transmision,
            coste_adquisicion=Decimal("0"),
            ganancia=Decimal("0"),
            disponible_antes=disponible,
            fiscal=op.fiscal,
            origen=op.origen,
            incidencia=INCIDENCIA_SIN_LOTES if disponible <= 0 else INCIDENCIA_STOCK,
        )

    pendiente = op.cantidad
    coste_total = Decimal("0")
    liberada_total = Decimal("0")
    consumos = []

    for lote in lotes:
        if pendiente <= 0:
            break
        if lote.restante <= 0:
            continue

        tomado = min(lote.restante, pendiente)
        coste_unitario = lote.coste_unitario

        # La pérdida aplazada del lote viaja con las participaciones: si se
        # transmite la mitad de la recompra, se libera la mitad de la pérdida.
        # Se calcula antes de descontar `restante`, que es sobre lo que queda
        # pendiente de liberar.
        if lote.perdida_diferida > 0:
            liberada = lote.perdida_diferida * tomado / lote.restante
            lote.perdida_diferida -= liberada
            liberada_total += liberada

        coste = coste_unitario * tomado
        consumos.append(ConsumoLote(
            lote_ref=lote.ref,
            fecha_adquisicion=lote.fecha,
            cantidad=tomado,
            coste_unitario=coste_unitario,
            coste=coste,
            origen=lote.origen,
        ))

        coste_total += coste
        lote.restante -= tomado
        pendiente -= tomado

    return Resultado(
        ref=op.ref,
        activo_id=op.activo_id,
        fecha=op.fecha,
        cantidad=op.cantidad,
        valor_transmision=valor_transmision,
        coste_adquisicion=coste_total,
        ganancia=valor_transmision - coste_total,
        lotes=consumos,
        disponible_antes=disponible,
        fiscal=op.fiscal,
        origen=op.origen,
        perdida_diferida_liberada=liberada_total,
    )


def cuantizar(value, escala=Decimal("0.01")) -> Decimal:
    """Redondea un importe para presentarlo, con redondeo bancario estándar."""
    if value is None:
        return Decimal("0")
    return Decimal(value).quantize(escala)


def cuantizar_cantidad(value) -> Decimal:
    return Decimal(value or 0).quantize(_ESCALA).normalize()
