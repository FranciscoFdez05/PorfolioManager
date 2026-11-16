"""Lógica de negocio de las compras financiadas: validación y cálculo.

Una compra financiada es un préstamo a tipo fijo (o sin intereses, TIN 0) sobre
`precio - entrada`, con cuotas mensuales iguales. Reutiliza el cuadro de
`core.amortizacion`; aquí solo se valida la entrada y se calculan las métricas
propias: cuotas pagadas y restantes, tiempo que falta y coste total.
"""

import calendar
from datetime import date
from decimal import Decimal

from core import amortizacion, dinero
from core.amortizacion import Amortizacion, AmortizacionInvalida
from core.errors import ValidationError
from core.hipotecas import _fecha, _numero, sanearAmortizaciones
from core.validation import asDecimal, asInt, asRows, asText

MAX_CUOTAS = 240
MAX_PRECIO = Decimal("10000000")
MAX_TIPO = Decimal(60)


def sanearFinanciacion(fila: dict) -> dict:
    """Valida y normaliza una compra financiada recibida del cliente.

    Args:
        fila: Objeto JSON de la compra.

    Returns:
        La compra con importes como texto canónico. `id` puede venir vacío.

    Raises:
        ValidationError: si falta un dato, está fuera de rango o la entrada no
            deja nada que financiar.
    """
    precio = asDecimal(fila.get("precio"), "precio", required=True,
                       minimum=Decimal("0.01"), maximum=MAX_PRECIO)
    entrada = asDecimal(fila.get("entrada"), "entrada", default=Decimal(0),
                        minimum=Decimal(0), maximum=MAX_PRECIO)
    if entrada >= precio:
        raise ValidationError("«entrada» debe ser menor que el precio", field="entrada")

    return {
        "id": asText(fila.get("id"), "id", maxLength=64),
        "articulo": asText(fila.get("articulo"), "articulo", maxLength=120, required=True),
        "precio": dinero.aTexto(precio),
        "entrada": dinero.aTexto(entrada),
        "cuotas": asInt(fila.get("cuotas"), "cuotas", required=True, minimum=1, maximum=MAX_CUOTAS),
        "tin": dinero.aTexto(asDecimal(fila.get("tin"), "tin", default=Decimal(0),
                                       minimum=Decimal(0), maximum=MAX_TIPO)),
        "fechaInicio": _fecha(fila.get("fechaInicio"), "fechaInicio"),
        "nota": asText(fila.get("nota"), "nota", maxLength=500),
        "cuenta": asText(fila.get("cuenta"), "cuenta", maxLength=64),
        "diaCobro": _diaCobro(fila.get("diaCobro")),
        "categoria": asText(fila.get("categoria"), "categoria", maxLength=80),
        "amortizaciones": sanearAmortizaciones(fila.get("amortizaciones")),
    }


def _diaCobro(valor) -> str:
    """Día del mes en que se cobra la cuota; vacío = el día de la fecha de inicio."""
    if valor is None or str(valor).strip() == "":
        return ""
    dia = asInt(valor, "diaCobro", minimum=1, maximum=31)
    return str(dia)


def sanearListadoFinanciaciones(filas) -> list[dict]:
    """Valida el listado completo (sin asignar ids)."""
    return [sanearFinanciacion(f) for f in asRows(filas, "rows", maxRows=500)]


def calcularFinanciacion(compra: dict, hoy: date) -> dict:
    """Cuadro y métricas de una compra financiada a fecha `hoy`.

    Args:
        compra: Compra saneada.
        hoy: Fecha de referencia.

    Returns:
        `{"resumen": {...}, "cuadro": [...]}` con importes como `float`, o
        `{"error": "..."}` si no se puede construir el cuadro.
    """
    precio = dinero.aDecimal(compra["precio"], "precio")
    entrada = dinero.aDecimal(compra["entrada"], "entrada")
    financiado = precio - entrada
    tin = dinero.aDecimal(compra["tin"], "tin")

    try:
        cuadro = generarCuadroDeCompra(compra)
        cuadroSinExtras = (generarCuadroDeCompra(compra, conAmortizaciones=False)
                           if compra.get("amortizaciones") else None)
    except AmortizacionInvalida as error:
        return {"error": str(error)}

    base = amortizacion.resumir(cuadro, financiado, hoy, cuadroSinExtras)
    base["fechaFin"] = base["fechaFin"].isoformat()
    base["proximaFecha"] = base["proximaFecha"].isoformat() if base["proximaFecha"] else None
    resumen = {k: (_numero(v) if isinstance(v, Decimal) else v) for k, v in base.items()}
    fechasCobro = [_fechaDeCobro(compra, r) for r in cuadro]
    pagados = [r for r in cuadro if r.fecha <= hoy]
    totalPagado = entrada + sum((r.cuota + r.extra for r in pagados), Decimal(0))
    resumen.update({
        "financiado": _numero(financiado),
        "totalAPagar": _numero(entrada + sum((r.cuota + r.extra for r in cuadro), Decimal(0))),
        "totalPagado": _numero(totalPagado),
        "cuotaMensual": _numero(cuadro[0].cuota),
        "progreso": round(base["cuotasPagadas"] / base["totalCuotas"] * 100, 2),
        "sinIntereses": tin == 0,
    })
    return {
        "resumen": resumen,
        "cuadro": [
            {"numero": r.numero, "fecha": r.fecha.isoformat(), "fechaCobro": cobro.isoformat(),
             "cuota": _numero(r.cuota), "interes": _numero(r.interes), "capital": _numero(r.capital),
             "extra": _numero(r.extra), "pendiente": _numero(r.pendiente),
             "pagado": cobro <= hoy}
            for r, cobro in zip(cuadro, fechasCobro, strict=True)
        ],
    }


def generarCuadroDeCompra(compra: dict, conAmortizaciones: bool = True) -> list[amortizacion.Recibo]:
    """Cuadro de amortización de una compra saneada.

    Es el único sitio que lo construye: lo usan el cálculo de la ventana y la
    sincronización con Mensualidades, y deben coincidir recibo a recibo.

    Args:
        compra: Compra saneada.
        conAmortizaciones: `False` ignora los pagos anticipados (para medir el
            ahorro de intereses que suponen).

    Returns:
        Un recibo por mes hasta liquidar.

    Raises:
        AmortizacionInvalida: si los datos no permiten construir el cuadro.
    """
    financiado = (dinero.aDecimal(compra["precio"], "precio")
                  - dinero.aDecimal(compra["entrada"], "entrada"))
    tin = dinero.aDecimal(compra["tin"], "tin")
    extras = [Amortizacion(date.fromisoformat(a["fecha"]), dinero.aDecimal(a["importe"], "importe"), a["modo"])
              for a in compra.get("amortizaciones", [])] if conAmortizaciones else []
    return amortizacion.generarCuadro(
        financiado, compra["cuotas"], date.fromisoformat(compra["fechaInicio"]), lambda _f: tin,
        amortizaciones=extras)


def _fechaDeCobro(compra: dict, recibo: amortizacion.Recibo) -> date:
    """Fecha en que se carga un recibo: su mes con el día de cobro de la compra."""
    return recibo.fecha.replace(day=diaDeCobro(compra, recibo))


def diaDeCobro(compra: dict, recibo: amortizacion.Recibo) -> int:
    """Día del mes en que se carga un recibo.

    Con `diaCobro` informado se usa ese día, recortado al último del mes si no
    existe (30 de febrero); si no, el de la fecha del recibo, que ya viene
    recortada por el cuadro.
    """
    if not compra.get("diaCobro"):
        return recibo.fecha.day
    ultimoDia = calendar.monthrange(recibo.fecha.year, recibo.fecha.month)[1]
    return min(int(compra["diaCobro"]), ultimoDia)
