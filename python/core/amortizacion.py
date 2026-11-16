"""Cuadro de amortización (sistema francés) para hipotecas y compras financiadas.

Módulo puro: sin Flask, sin base de datos y sin reloj propio (la fecha de «hoy»
se pasa como argumento), de modo que se prueba con números a mano. Todo el
cálculo va en `Decimal`; el redondeo al céntimo se hace en cada recibo porque
es lo que hace un banco, y así la suma de los recibos cuadra con lo que se paga.

Un préstamo a tipo fijo y uno variable usan la misma función: lo único que
cambia es de dónde sale el tipo de cada periodo (`tipoParaFecha`) y cada cuántos
meses se revisa (`revisionMeses`). Es una Strategy mínima: quien llama decide la
política de tipos y el cuadro no sabe nada de Euríbor.
"""

import calendar
import logging
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_CEILING, Decimal
from typing import Callable, Optional, Sequence

from core import dinero

log = logging.getLogger(__name__)

CERO = Decimal(0)
_CENTIMO = Decimal("0.01")
_CIEN = Decimal(100)
_DOCE = Decimal(12)
# Margen de seguridad del bucle: con cuotas bien formadas termina siempre en el
# plazo, pero una cuota por debajo de los intereses (tipo absurdo) no amortiza
# nunca y sin tope el bucle sería infinito.
_MAX_MESES_EXTRA = 600


class AmortizacionInvalida(ValueError):
    """Los datos del préstamo no permiten construir un cuadro."""


@dataclass(frozen=True)
class Amortizacion:
    """Pago anticipado de capital.

    Attributes:
        fecha: Día en que se aplica; entra en el primer recibo posterior.
        importe: Capital que se amortiza.
        modo: `"cuota"` mantiene el plazo y baja la cuota; `"plazo"` mantiene la
            cuota y acorta el plazo.
    """

    fecha: date
    importe: Decimal
    modo: str = "plazo"


@dataclass(frozen=True)
class Recibo:
    """Un mes del cuadro de amortización."""

    numero: int
    fecha: date
    cuota: Decimal
    interes: Decimal
    capital: Decimal
    extra: Decimal
    pendiente: Decimal
    tipo: Decimal


def redondear(valor: Decimal) -> Decimal:
    """Redondea al céntimo con ROUND_HALF_UP."""
    return dinero.redondear(valor, 2)


def sumarMeses(base: date, meses: int) -> date:
    """Suma meses de calendario recortando el día al último del mes de destino.

    Así un préstamo que arranca el 31 paga el 28 o 29 de febrero y vuelve al 31
    en marzo, en vez de desplazarse para siempre al día 28.

    Args:
        base: Fecha de partida.
        meses: Meses a sumar (puede ser 0).

    Returns:
        La fecha resultante.

    Example:
        >>> sumarMeses(date(2024, 1, 31), 1)
        datetime.date(2024, 2, 29)
    """
    indice = base.year * 12 + (base.month - 1) + meses
    anio, mes = divmod(indice, 12)
    mes += 1
    ultimo = calendar.monthrange(anio, mes)[1]
    return date(anio, mes, min(base.day, ultimo))


def tipoMensual(tipoAnual: Decimal) -> Decimal:
    """Tipo mensual (fracción) a partir de un TIN anual en porcentaje."""
    return tipoAnual / _CIEN / _DOCE


def calcularCuota(capital: Decimal, tipoAnual: Decimal, meses: int) -> Decimal:
    """Cuota constante del sistema francés.

    Args:
        capital: Capital pendiente.
        tipoAnual: TIN en porcentaje (3,5 es 3,5 %). Puede ser 0.
        meses: Meses que quedan; debe ser positivo.

    Returns:
        La cuota sin redondear. A tipo 0 es un reparto lineal.

    Raises:
        AmortizacionInvalida: si `meses` no es positivo.
    """
    if meses <= 0:
        raise AmortizacionInvalida("El plazo debe ser de al menos un mes")
    if capital <= CERO:
        return CERO
    r = tipoMensual(tipoAnual)
    if r == CERO:
        return capital / meses
    factor = (1 + r) ** meses
    return capital * r * factor / (factor - 1)


def _mesesParaCuota(capital: Decimal, tipoAnual: Decimal, cuota: Decimal) -> int:
    """Meses que hacen falta para liquidar `capital` pagando `cuota`.

    Se resuelve sumando recibos en vez de con logaritmos: con Decimal no hay
    `log` exacto cómodo y el resultado entero es lo único que interesa.
    """
    r = tipoMensual(tipoAnual)
    if r == CERO:
        return int((capital / cuota).to_integral_value(rounding=ROUND_CEILING))
    if cuota <= capital * r:
        raise AmortizacionInvalida("La cuota no cubre los intereses del periodo")
    saldo = capital
    meses = 0
    while saldo > _CENTIMO and meses < 12 * 100:
        saldo = saldo * (1 + r) - cuota
        meses += 1
    return max(meses, 1)


def generarCuadro(
    capital: Decimal,
    plazoMeses: int,
    fechaInicio: date,
    tipoParaFecha: Callable[[date], Decimal],
    revisionMeses: int = 0,
    amortizaciones: Sequence[Amortizacion] = (),
) -> list[Recibo]:
    """Construye el cuadro de amortización completo.

    El primer recibo vence un mes después de `fechaInicio`. A tipo fijo
    (`revisionMeses` 0) la cuota se calcula una vez; en variable se recalcula al
    comenzar cada periodo de revisión sobre el capital pendiente y los meses que
    quedan. Una amortización anticipada se aplica justo después del recibo que
    la contiene: modo `"cuota"` recalcula la cuota con los meses que quedan,
    modo `"plazo"` conserva la cuota y recalcula cuántos meses quedan.

    Args:
        capital: Capital inicial; debe ser positivo.
        plazoMeses: Plazo en meses; debe ser positivo.
        fechaInicio: Fecha de formalización.
        tipoParaFecha: Devuelve el TIN anual (en %) vigente en una fecha. Se
            consulta con el inicio de cada periodo de revisión.
        revisionMeses: Meses entre revisiones; 0 para tipo fijo.
        amortizaciones: Pagos anticipados, en cualquier orden.

    Returns:
        Un `Recibo` por mes hasta liquidar el préstamo.

    Raises:
        AmortizacionInvalida: capital o plazo no positivos, o un tipo que impide
            amortizar.
    """
    if capital <= CERO:
        raise AmortizacionInvalida("El capital debe ser mayor que cero")
    if plazoMeses <= 0:
        raise AmortizacionInvalida("El plazo debe ser de al menos un mes")

    pendientes = sorted(amortizaciones, key=lambda a: a.fecha)
    saldo = redondear(capital)
    restantes = plazoMeses
    cuota = CERO
    tipoAnual = CERO
    recibos: list[Recibo] = []
    mes = 0

    while saldo > CERO and mes < plazoMeses + _MAX_MESES_EXTRA:
        mes += 1
        fecha = sumarMeses(fechaInicio, mes)

        inicioPeriodo = mes == 1 or (revisionMeses > 0 and (mes - 1) % revisionMeses == 0)
        if inicioPeriodo:
            referencia = sumarMeses(fechaInicio, mes - 1)
            tipoAnual = tipoParaFecha(referencia)
            cuota = redondear(calcularCuota(saldo, tipoAnual, restantes))

        interes = redondear(saldo * tipoMensual(tipoAnual))
        ultimo = restantes <= 1 or cuota - interes >= saldo
        if ultimo:
            capitalMes = saldo
            cuotaMes = capitalMes + interes
        else:
            capitalMes = cuota - interes
            cuotaMes = cuota
        saldo = redondear(saldo - capitalMes)
        restantes -= 1

        extra = CERO
        while pendientes and pendientes[0].fecha <= fecha:
            pago = pendientes.pop(0)
            aplicado = min(redondear(pago.importe), saldo)
            if aplicado <= CERO:
                continue
            extra += aplicado
            saldo = redondear(saldo - aplicado)
            if saldo <= CERO or restantes <= 0:
                continue
            if pago.modo == "cuota":
                cuota = redondear(calcularCuota(saldo, tipoAnual, restantes))
            else:
                restantes = _mesesParaCuota(saldo, tipoAnual, cuota)

        recibos.append(Recibo(mes, fecha, cuotaMes, interes, capitalMes, extra, saldo, tipoAnual))

    if saldo > CERO:
        log.warning("El cuadro no liquida el préstamo tras %s meses", mes)
        raise AmortizacionInvalida("Con esos datos el préstamo no se llega a liquidar")
    return recibos


def resumir(recibos: Sequence[Recibo], capital: Decimal, hoy: date,
            recibosSinExtras: Optional[Sequence[Recibo]] = None) -> dict:
    """Métricas del préstamo a fecha `hoy`.

    Un recibo cuenta como pagado si su fecha es hoy o anterior. Los pagos
    anticipados con fecha futura todavía no han reducido el capital, así que el
    pendiente se toma del último recibo ya vencido.

    Args:
        recibos: Cuadro devuelto por `generarCuadro`.
        capital: Capital inicial.
        hoy: Fecha de referencia.
        recibosSinExtras: Mismo préstamo sin pagos anticipados; si se da, se
            calcula el ahorro de intereses que suponen.

    Returns:
        Diccionario de importes como `Decimal` y de contadores como `int`.
    """
    pagados = [r for r in recibos if r.fecha <= hoy]
    futuros = [r for r in recibos if r.fecha > hoy]

    interesesTotales = sum((r.interes for r in recibos), CERO)
    interesesPagados = sum((r.interes for r in pagados), CERO)
    capitalPagado = sum((r.capital + r.extra for r in pagados), CERO)
    pendiente = pagados[-1].pendiente if pagados else redondear(capital)
    siguiente = futuros[0] if futuros else None
    ultimo = recibos[-1]

    ahorro = CERO
    if recibosSinExtras is not None:
        ahorro = sum((r.interes for r in recibosSinExtras), CERO) - interesesTotales

    return {
        "cuotaActual": (siguiente or ultimo).cuota,
        "tipoActual": (siguiente or ultimo).tipo,
        "capitalPendiente": pendiente,
        "capitalAmortizado": capitalPagado,
        "porcentajeAmortizado": (capitalPagado / capital * _CIEN) if capital else CERO,
        "interesesPagados": interesesPagados,
        "interesesPendientes": interesesTotales - interesesPagados,
        "interesesTotales": interesesTotales,
        "costeTotal": sum((r.cuota + r.extra for r in recibos), CERO),
        "ahorroIntereses": ahorro,
        "cuotasPagadas": len(pagados),
        "cuotasRestantes": len(futuros),
        "totalCuotas": len(recibos),
        "proximaFecha": siguiente.fecha if siguiente else None,
        "fechaFin": ultimo.fecha,
        "liquidado": not futuros,
    }
