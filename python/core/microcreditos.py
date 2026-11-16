"""Lógica de negocio de los microcréditos: validación y cálculo.

Un microcrédito es un préstamo pequeño y de corta duración. Admite dos modos:

- `unico`: se devuelve de una vez, en la fecha de vencimiento, el importe más
  una comisión fija. Es el formato habitual de los créditos «rápidos» a 30 días.
- `cuotas`: cuotas mensuales iguales a tipo fijo. Reutiliza el cuadro de
  `core.amortizacion`.

Ambos modos devuelven el mismo `resumen`, para que la ventana los pinte igual.
"""

import logging
import math
from datetime import date
from decimal import Decimal

from core import amortizacion, dinero
from core.amortizacion import AmortizacionInvalida
from core.errors import ValidationError
from core.hipotecas import _fecha, _numero, sanearDiaCobro
from core.validation import asBool, asDecimal, asInt, asRows, asText, oneOf

log = logging.getLogger(__name__)

modoUnico = "unico"
modoCuotas = "cuotas"
modos = (modoUnico, modoCuotas)

estadoActivo = "activo"
estadoVencido = "vencido"
estadoDevuelto = "devuelto"

maxImporte = Decimal("1000000")
maxCuotas = 60
# Los microcréditos «rápidos» superan con frecuencia el 100 % de TIN.
maxTin = Decimal(1000)
maxMicrocreditos = 500


def sanearMicrocredito(fila: dict) -> dict:
    """Valida y normaliza un microcrédito recibido del cliente.

    Los campos que no corresponden al modo elegido se guardan con su valor
    neutro, para que cambiar de modo al editar no arrastre datos antiguos.

    Args:
        fila: Objeto JSON del microcrédito.

    Returns:
        El microcrédito con importes como texto canónico. `id` puede venir vacío.

    Raises:
        ValidationError: si falta un dato, está fuera de rango o las fechas son
            incoherentes.
    """
    modo = oneOf(fila.get("modo"), modos, "modo", default=modoUnico)
    fechaInicio = _fecha(fila.get("fechaInicio"), "fechaInicio")
    saneado = {
        "id": asText(fila.get("id"), "id", maxLength=64),
        "nombre": asText(fila.get("nombre"), "nombre", maxLength=120, required=True),
        "modo": modo,
        "importe": dinero.aTexto(asDecimal(fila.get("importe"), "importe", required=True,
                                           minimum=Decimal("0.01"), maximum=maxImporte)),
        "fechaInicio": fechaInicio,
        "nota": asText(fila.get("nota"), "nota", maxLength=500),
        "comision": "0",
        "fechaVencimiento": "",
        "devuelto": False,
        "fechaDevolucion": "",
        "cuotas": 0,
        "tin": "0",
        "cuenta": asText(fila.get("cuenta"), "cuenta", maxLength=64),
        "diaCobro": sanearDiaCobro(fila.get("diaCobro")),
        "categoria": asText(fila.get("categoria"), "categoria", maxLength=80),
    }
    if modo == modoUnico:
        saneado.update(_camposPagoUnico(fila, fechaInicio))
    else:
        saneado.update(_camposCuotas(fila))
    return saneado


def _camposPagoUnico(fila: dict, fechaInicio: str) -> dict:
    """Campos propios del pago único: comisión, vencimiento y devolución."""
    vencimiento = _fecha(fila.get("fechaVencimiento"), "fechaVencimiento")
    if vencimiento < fechaInicio:
        raise ValidationError("«fechaVencimiento» no puede ser anterior a la concesión",
                              field="fechaVencimiento")
    devuelto = asBool(fila.get("devuelto"))
    fechaDevolucion = ""
    if devuelto and fila.get("fechaDevolucion"):
        fechaDevolucion = _fecha(fila.get("fechaDevolucion"), "fechaDevolucion")
        if fechaDevolucion < fechaInicio:
            raise ValidationError("«fechaDevolucion» no puede ser anterior a la concesión",
                                  field="fechaDevolucion")
    return {
        "comision": dinero.aTexto(asDecimal(fila.get("comision"), "comision", default=Decimal(0),
                                            minimum=Decimal(0), maximum=maxImporte)),
        "fechaVencimiento": vencimiento,
        "devuelto": devuelto,
        "fechaDevolucion": fechaDevolucion,
    }


def _camposCuotas(fila: dict) -> dict:
    """Campos propios del modo en cuotas: número de cuotas y TIN."""
    return {
        "cuotas": asInt(fila.get("cuotas"), "cuotas", required=True, minimum=1, maximum=maxCuotas),
        "tin": dinero.aTexto(asDecimal(fila.get("tin"), "tin", default=Decimal(0),
                                       minimum=Decimal(0), maximum=maxTin)),
    }


def sanearListadoMicrocreditos(filas) -> list[dict]:
    """Valida el listado completo (sin asignar ids)."""
    return [sanearMicrocredito(f) for f in asRows(filas, "rows", maxRows=maxMicrocreditos)]


def calcularMicrocredito(microcredito: dict, hoy: date) -> dict:
    """Métricas de un microcrédito a fecha `hoy`.

    Args:
        microcredito: Microcrédito saneado.
        hoy: Fecha de referencia.

    Returns:
        `{"resumen": {...}, "cuadro": [...]}` con importes como `float`, o
        `{"error": "..."}` si no se puede construir el cuadro. `cuadro` va vacío
        en pago único. Un error de cálculo no tumba el resto del listado.
    """
    if microcredito["modo"] == modoUnico:
        return _calcularPagoUnico(microcredito, hoy)
    return _calcularEnCuotas(microcredito, hoy)


def taeDePagoUnico(importe: Decimal, comision: Decimal, dias: int) -> float | None:
    """TAE equivalente de un préstamo que se devuelve de una vez.

    Capitaliza la comisión sobre el plazo y la anualiza: `((1 + c/i)^(365/d) - 1)`.
    Un plazo corto con comisión alta da cifras enormes, y es justo lo que hay que
    enseñar al comparar este tipo de créditos.

    Args:
        importe: Capital recibido.
        comision: Coste fijo total.
        dias: Días entre la concesión y el vencimiento; se toma al menos 1.

    Returns:
        TAE en porcentaje, o `None` si la cifra no es representable.

    Example:
        >>> round(taeDePagoUnico(Decimal(300), Decimal(45), 30), 2)
        447.63
    """
    plazo = max(1, dias)
    try:
        factor = math.pow(1 + float(comision / importe), 365 / plazo)
    except OverflowError:
        return None
    return (factor - 1) * 100 if math.isfinite(factor) else None


def _progresoPorTiempo(inicio: date, fin: date, hoy: date) -> float:
    """Porcentaje del plazo transcurrido, acotado entre 0 y 100."""
    total = (fin - inicio).days
    if total <= 0:
        return 100.0 if hoy >= fin else 0.0
    return round(min(100.0, max(0.0, (hoy - inicio).days / total * 100)), 2)


def _estadoPagoUnico(microcredito: dict, vencimiento: date, hoy: date) -> str:
    if microcredito["devuelto"]:
        return estadoDevuelto
    return estadoVencido if hoy > vencimiento else estadoActivo


def _calcularPagoUnico(microcredito: dict, hoy: date) -> dict:
    importe = dinero.aDecimal(microcredito["importe"], "importe")
    comision = dinero.aDecimal(microcredito["comision"], "comision")
    inicio = date.fromisoformat(microcredito["fechaInicio"])
    vencimiento = date.fromisoformat(microcredito["fechaVencimiento"])
    total = importe + comision
    estado = _estadoPagoUnico(microcredito, vencimiento, hoy)
    devuelto = estado == estadoDevuelto
    dias = (vencimiento - inicio).days
    tae = taeDePagoUnico(importe, comision, dias)

    return {
        "resumen": {
            "modo": modoUnico,
            "estado": estado,
            "liquidado": devuelto,
            "importe": _numero(importe),
            "coste": _numero(comision),
            "totalAPagar": _numero(total),
            "pagado": _numero(total if devuelto else Decimal(0)),
            "pendiente": _numero(Decimal(0) if devuelto else total),
            "tae": None if tae is None else round(tae, 2),
            "plazoDias": dias,
            "fechaVencimiento": vencimiento.isoformat(),
            "proximaFecha": None if devuelto else vencimiento.isoformat(),
            "proximoImporte": 0.0 if devuelto else _numero(total),
            "diasRestantes": 0 if devuelto else (vencimiento - hoy).days,
            "progreso": 100.0 if devuelto else _progresoPorTiempo(inicio, vencimiento, hoy),
        },
        "cuadro": [],
    }


def generarCuadroDeMicrocredito(microcredito: dict) -> list[amortizacion.Recibo]:
    """Cuadro de un microcrédito en cuotas.

    Es el único sitio que lo construye: lo usan el cálculo de la ventana y la
    sincronización con Mensualidades, y deben coincidir recibo a recibo.

    Raises:
        AmortizacionInvalida: si los datos no permiten construir el cuadro.
    """
    tin = dinero.aDecimal(microcredito["tin"], "tin")
    return amortizacion.generarCuadro(
        dinero.aDecimal(microcredito["importe"], "importe"), microcredito["cuotas"],
        date.fromisoformat(microcredito["fechaInicio"]), lambda _f: tin)


def fechaDePagoUnico(microcredito: dict) -> date:
    """Día en que sale de la cuenta el pago único.

    Si ya se devolvió y se anotó cuándo, ese día; si no, el vencimiento.
    """
    if microcredito["devuelto"] and microcredito["fechaDevolucion"]:
        return date.fromisoformat(microcredito["fechaDevolucion"])
    return date.fromisoformat(microcredito["fechaVencimiento"])


def _calcularEnCuotas(microcredito: dict, hoy: date) -> dict:
    importe = dinero.aDecimal(microcredito["importe"], "importe")
    tin = dinero.aDecimal(microcredito["tin"], "tin")
    inicio = date.fromisoformat(microcredito["fechaInicio"])
    try:
        cuadro = generarCuadroDeMicrocredito(microcredito)
    except AmortizacionInvalida as error:
        log.warning("Microcrédito %s sin cuadro: %s", microcredito.get("id"), error)
        return {"error": str(error)}

    base = amortizacion.resumir(cuadro, importe, hoy)
    pagado = sum((r.cuota + r.extra for r in cuadro if r.fecha <= hoy), Decimal(0))
    total = base["costeTotal"]
    liquidado = base["liquidado"]
    siguiente = base["proximaFecha"]
    tae = ((1 + float(tin) / 1200) ** 12 - 1) * 100
    return {
        "resumen": {
            "modo": modoCuotas,
            "estado": estadoDevuelto if liquidado else estadoActivo,
            "liquidado": liquidado,
            "importe": _numero(importe),
            "coste": _numero(base["interesesTotales"]),
            "totalAPagar": _numero(total),
            "pagado": _numero(pagado),
            "pendiente": _numero(total - pagado),
            "tae": round(tae, 2),
            "plazoDias": (base["fechaFin"] - inicio).days,
            "fechaVencimiento": base["fechaFin"].isoformat(),
            "proximaFecha": siguiente.isoformat() if siguiente else None,
            "proximoImporte": 0.0 if liquidado else _numero(base["cuotaActual"]),
            "diasRestantes": 0 if liquidado else (base["fechaFin"] - hoy).days,
            "progreso": round(base["cuotasPagadas"] / base["totalCuotas"] * 100, 2),
            "cuotasPagadas": base["cuotasPagadas"],
            "cuotasRestantes": base["cuotasRestantes"],
            "totalCuotas": base["totalCuotas"],
            "cuotaMensual": _numero(cuadro[0].cuota),
        },
        "cuadro": [
            {"numero": r.numero, "fecha": r.fecha.isoformat(), "cuota": _numero(r.cuota),
             "interes": _numero(r.interes), "capital": _numero(r.capital),
             "pendiente": _numero(r.pendiente), "pagado": r.fecha <= hoy}
            for r in cuadro
        ],
    }
