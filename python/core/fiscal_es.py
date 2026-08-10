"""Normativa española aplicada a los resultados que devuelve `core.fifo`.

Separado del motor FIFO a propósito: el reparto en lotes es aritmética que no
caduca, mientras que lo de aquí (escala del ahorro, regla de los dos meses,
compensación de saldos negativos) cambia con cada reforma y conviene poder
tocarlo sin rozar el cálculo del coste de adquisición.

Qué implementa:

  * Escala de la base del ahorro por ejercicio (art. 66 LIRPF).
  * Regla de antiaplicación o "de los dos meses" (art. 33.5.f y 33.5.g LIRPF):
    la pérdida no se computa si se recompran valores homogéneos dentro de la
    ventana, y se integra más adelante, según se transmitan esos valores.
  * Integración y compensación del saldo de ganancias y pérdidas patrimoniales
    del ejercicio, con arrastre del saldo negativo a los cuatro ejercicios
    siguientes (art. 49.1.b LIRPF).

Qué **no** implementa, y hay que tener presente al leer los totales: la
compensación cruzada con rendimientos del capital mobiliario (el 25% del
art. 49.1), porque la aplicación no modela esos rendimientos en esta pantalla;
la exención por reinversión; ni los coeficientes de abatimiento de la DT 9ª
para adquisiciones anteriores a 31-12-1994. Todo eso queda fuera y el resumen
lo advierte.
"""

from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal

from core.fifo import ADQUISICION, aplicar_fifo

# Escala del ahorro por ejercicio. Cada entrada es (límite superior del tramo,
# tipo). El último tramo es abierto.
_ESCALA_2023 = (
    (Decimal("6000"), Decimal("0.19")),
    (Decimal("50000"), Decimal("0.21")),
    (Decimal("200000"), Decimal("0.23")),
    (Decimal("300000"), Decimal("0.27")),
    (None, Decimal("0.28")),
)

_ESCALA_2021 = (
    (Decimal("6000"), Decimal("0.19")),
    (Decimal("50000"), Decimal("0.21")),
    (Decimal("200000"), Decimal("0.23")),
    (None, Decimal("0.26")),
)

_ESCALA_2016 = (
    (Decimal("6000"), Decimal("0.19")),
    (Decimal("50000"), Decimal("0.21")),
    (None, Decimal("0.23")),
)

# La tabla se consulta por ejercicio para que un año antiguo no se recalcule
# con la escala vigente hoy. Ordenada de más reciente a más antigua.
_ESCALAS_POR_ANIO = (
    (2023, _ESCALA_2023),
    (2021, _ESCALA_2021),
    (2016, _ESCALA_2016),
)

# Nombres de las columnas de la tabla de ventas. La escala vigente tiene cinco
# tramos; las antiguas rellenan solo los primeros.
CLAVES_TRAMOS = ("tramo1", "tramo2", "tramo3", "tramo4", "tramo5")

# Ventana de la regla de antiaplicación. Dos meses para valores admitidos a
# negociación en mercados regulados (art. 33.5.f) y un año para los que no lo
# están (art. 33.5.g). La DGT ha venido aplicando el supuesto de no cotizados a
# las monedas virtuales (entre otras, V1948-21), así que cripto usa un año.
VENTANA_COTIZADOS = timedelta(days=60)
VENTANA_NO_COTIZADOS = timedelta(days=365)

_TIPOS_NO_COTIZADOS = {"cripto", "criptomoneda", "crypto", "no cotizado", "private"}

# Años durante los que un saldo negativo puede compensarse (art. 49.1.b).
EJERCICIOS_ARRASTRE = 4


def escala_del_ejercicio(anio):
    """Escala de la base del ahorro aplicable a un ejercicio."""
    try:
        anio = int(anio)
    except (TypeError, ValueError):
        anio = date.today().year
    for desde, escala in _ESCALAS_POR_ANIO:
        if anio >= desde:
            return escala
    return _ESCALA_2016


def ventana_antiaplicacion(tipo_activo):
    """Plazo de recompra que bloquea la pérdida, según el tipo de activo."""
    normalizado = str(tipo_activo or "").strip().lower()
    if normalizado in _TIPOS_NO_COTIZADOS:
        return VENTANA_NO_COTIZADOS
    return VENTANA_COTIZADOS


@dataclass
class Liquidacion:
    """Cierre fiscal de un ejercicio sobre la base del ahorro."""

    anio: str
    ganancias: Decimal = Decimal("0")
    perdidas: Decimal = Decimal("0")
    saldo: Decimal = Decimal("0")
    compensado_anteriores: Decimal = Decimal("0")
    base: Decimal = Decimal("0")
    cuota: Decimal = Decimal("0")
    tramos: dict = field(default_factory=dict)
    saldo_negativo_generado: Decimal = Decimal("0")
    pendiente_compensar: Decimal = Decimal("0")
    perdidas_no_computables: Decimal = Decimal("0")
    perdidas_diferidas_liberadas: Decimal = Decimal("0")


def calcular_con_normativa(operaciones, tipo_activo=""):
    """FIFO + regla de los dos meses sobre el histórico de **un** activo.

    Va en dos pasadas porque la regla mira hacia adelante: para saber si una
    pérdida está bloqueada hay que conocer las recompras posteriores, y para
    liberar esa pérdida aplazada hay que volver a recorrer la línea temporal
    con el importe ya adherido al lote de la recompra. Una sola pasada no puede
    hacer las dos cosas.
    """
    resultados, lotes = aplicar_fifo(operaciones)
    bloqueos, diferidas_por_lote = _detectar_antiaplicacion(
        resultados, operaciones, ventana_antiaplicacion(tipo_activo)
    )

    if not diferidas_por_lote:
        return resultados, lotes

    resultados, lotes = aplicar_fifo(operaciones, diferidas_por_lote)
    for resultado in resultados:
        bloqueo = bloqueos.get(resultado.ref)
        if bloqueo:
            resultado.perdida_no_computable = bloqueo["importe"]
            resultado.nota_antiaplicacion = bloqueo["nota"]
    return resultados, lotes


def _detectar_antiaplicacion(resultados, operaciones, ventana):
    """Marca las pérdidas bloqueadas por recompra y a qué lote se aplazan.

    Devuelve `(bloqueos_por_transmision, importe_diferido_por_lote)`.

    Una recompra solo puede bloquear una vez: se lleva la cuenta de la
    capacidad ya gastada, para que dos minusvalías consecutivas no se apoyen en
    la misma compra. Tampoco cuenta como recompra la parte de una adquisición
    que la propia venta consumió: esas participaciones ya no están en cartera y
    la finalidad de la norma (penalizar el lavado de la pérdida manteniendo la
    posición) no se cumple.
    """
    adquisiciones = [op for op in operaciones if op.tipo == ADQUISICION and op.cantidad > 0]
    if not adquisiciones:
        return {}, {}

    capacidad = {op.ref: op.cantidad for op in adquisiciones}
    consumido = {op.ref: Decimal("0") for op in adquisiciones}
    bloqueos = {}
    diferidas = {}

    for resultado in resultados:
        # Las participaciones que esta venta se llevó dejan de estar en cartera
        # y dejan de poder bloquear nada de aquí en adelante.
        for consumo in resultado.lotes:
            if consumo.lote_ref in consumido:
                consumido[consumo.lote_ref] += consumo.cantidad

        if resultado.incidencia or not resultado.fiscal:
            continue
        if resultado.ganancia >= 0 or resultado.cantidad <= 0:
            continue

        perdida = -resultado.ganancia
        inicio = resultado.fecha - ventana
        fin = resultado.fecha + ventana

        candidatas = [
            op for op in adquisiciones
            if inicio <= op.fecha <= fin
            and capacidad[op.ref] - consumido[op.ref] > 0
        ]
        if not candidatas:
            continue

        bloqueable = min(
            sum((capacidad[op.ref] - consumido[op.ref] for op in candidatas), Decimal("0")),
            resultado.cantidad,
        )
        if bloqueable <= 0:
            continue

        importe_bloqueado = perdida * bloqueable / resultado.cantidad
        bloqueos[resultado.ref] = {
            "importe": importe_bloqueado,
            "nota": (
                f"Pérdida no computable por recompra de {_num(bloqueable)} "
                f"participaciones dentro de los {ventana.days} días anteriores "
                f"o posteriores a la venta (art. 33.5 LIRPF)."
            ),
        }

        # El importe aplazado se reparte entre las recompras que lo bloquearon,
        # en proporción a lo que aporta cada una, y se libera cuando esas
        # participaciones se transmitan.
        pendiente = bloqueable
        for op in candidatas:
            if pendiente <= 0:
                break
            disponible = capacidad[op.ref] - consumido[op.ref]
            usado = min(disponible, pendiente)
            consumido[op.ref] += usado
            pendiente -= usado
            diferidas[op.ref] = diferidas.get(op.ref, Decimal("0")) + (
                importe_bloqueado * usado / bloqueable
            )

    return bloqueos, diferidas


def liquidar_ejercicios(resultados_por_anio):
    """Cierra cada ejercicio en orden y arrastra los saldos negativos.

    `resultados_por_anio` es un dict `{anio: [Resultado, …]}`. Se procesan de
    más antiguo a más reciente porque una pérdida de 2024 solo puede compensar
    ganancias de 2024 en adelante, nunca hacia atrás.
    """
    liquidaciones = {}
    # Cola de saldos negativos vivos: (ejercicio de origen, importe pendiente).
    pendientes = []

    for anio in sorted(resultados_por_anio, key=_anio_int):
        resultados = resultados_por_anio[anio]
        liquidacion = Liquidacion(anio=str(anio))

        computables = [
            r for r in resultados if r.fiscal and not r.incidencia
        ]
        for resultado in computables:
            valor = resultado.ganancia_computable
            if valor >= 0:
                liquidacion.ganancias += valor
            else:
                liquidacion.perdidas += -valor
            liquidacion.perdidas_no_computables += resultado.perdida_no_computable
            liquidacion.perdidas_diferidas_liberadas += resultado.perdida_diferida_liberada

        liquidacion.saldo = liquidacion.ganancias - liquidacion.perdidas

        if liquidacion.saldo > 0:
            disponible = liquidacion.saldo
            anio_actual = _anio_int(anio)
            for pendiente in pendientes:
                if disponible <= 0:
                    break
                if anio_actual - pendiente["anio"] > EJERCICIOS_ARRASTRE:
                    continue  # caducado
                aplicado = min(pendiente["importe"], disponible)
                pendiente["importe"] -= aplicado
                disponible -= aplicado
                liquidacion.compensado_anteriores += aplicado
            liquidacion.base = disponible
        else:
            liquidacion.base = Decimal("0")
            liquidacion.saldo_negativo_generado = -liquidacion.saldo
            if liquidacion.saldo_negativo_generado > 0:
                pendientes.append({
                    "anio": _anio_int(anio),
                    "importe": liquidacion.saldo_negativo_generado,
                })

        pendientes = [p for p in pendientes if p["importe"] > 0]
        liquidacion.pendiente_compensar = sum(
            (p["importe"] for p in pendientes
             if _anio_int(anio) - p["anio"] <= EJERCICIOS_ARRASTRE),
            Decimal("0"),
        )

        liquidacion.tramos = repartir_en_tramos(liquidacion.base, escala_del_ejercicio(anio))
        liquidacion.cuota = sum(liquidacion.tramos.values(), Decimal("0"))
        liquidaciones[str(anio)] = liquidacion

    return liquidaciones


def repartir_en_tramos(base, escala):
    """Cuota de cada tramo para una base dada."""
    tramos = {clave: Decimal("0") for clave in CLAVES_TRAMOS}
    restante = max(base, Decimal("0"))
    limite_anterior = Decimal("0")

    for indice, (limite, tipo) in enumerate(escala):
        if restante <= 0:
            break
        if limite is None:
            porcion = restante
        else:
            porcion = min(restante, limite - limite_anterior)
            limite_anterior = limite
        tramos[CLAVES_TRAMOS[indice]] = porcion * tipo
        restante -= porcion

    return tramos


def repartir_cuota_por_venta(resultados, liquidacion, escala):
    """Imputa a cada venta su parte de la cuota anual.

    La escala del ahorro es anual y progresiva: no existe "el impuesto de esta
    venta" hasta que se suman todas. Aplicarla venta a venta —lo que hacía la
    versión anterior— cobraba el primer tramo tantas veces como filas hubiera e
    inflaba la factura. Aquí se calcula la cuota una sola vez sobre la base
    anual y se reparte apilando las ventas en orden cronológico, de modo que la
    suma de las columnas coincide exactamente con la cuota del ejercicio.

    Las ventas en pérdida no reciben cuota; su papel ya está en la
    compensación que redujo la base.
    """
    reparto = {}
    positivas = [
        r for r in resultados
        if r.fiscal and not r.incidencia and r.ganancia_computable > 0
    ]
    total_positivo = sum((r.ganancia_computable for r in positivas), Decimal("0"))

    if total_positivo <= 0 or liquidacion.base <= 0:
        return {r.ref: {clave: Decimal("0") for clave in CLAVES_TRAMOS} for r in resultados}

    # La base gravada puede ser menor que la suma de ganancias si se
    # compensaron pérdidas del propio año o de ejercicios anteriores: cada
    # venta cede parte de su ganancia en la misma proporción.
    factor = liquidacion.base / total_positivo

    acumulado = Decimal("0")
    for resultado in sorted(positivas, key=lambda r: (r.fecha, r.ref)):
        porcion = resultado.ganancia_computable * factor
        tramos_hasta = repartir_en_tramos(acumulado + porcion, escala)
        tramos_previos = repartir_en_tramos(acumulado, escala)
        reparto[resultado.ref] = {
            clave: tramos_hasta[clave] - tramos_previos[clave]
            for clave in CLAVES_TRAMOS
        }
        acumulado += porcion

    for resultado in resultados:
        reparto.setdefault(
            resultado.ref, {clave: Decimal("0") for clave in CLAVES_TRAMOS}
        )

    return reparto


def _anio_int(value):
    try:
        return int(str(value)[:4])
    except (TypeError, ValueError):
        return 0


def _num(value):
    texto = f"{Decimal(value).normalize():f}"
    return texto
