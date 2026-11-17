"""Herramientas fiscales: compensación de pérdidas y previsión del IRPF del ahorro.

Reúne los datos guardados (cartera, ventas, dividendos e intereses) y los pasa a
los motores que ya existen: `stores.ventas_fifo` para el FIFO y la regla de los
dos meses, y `core.fiscal_es` para la escala y la integración de la base del
ahorro. Aquí no se calcula ningún impuesto por cuenta propia: si la aritmética
fiscal estuviera repetida, un día dejaría de coincidir con la pantalla de Ventas.

Las dos funciones públicas devuelven diccionarios listos para JSON, con los
importes como texto con punto decimal, igual que `/api/ventas`.
"""

import logging
import re
from datetime import date, timedelta
from decimal import Decimal

from core import dinero, fiscal_es
from core.db import getDb
from core.ingresos_pasivos import leerFecha
from stores import ventas_fifo
from stores.app_data import readDividendosFile, readInteresesFile

log = logging.getLogger(__name__)

_CERO = Decimal("0")

# "mm-aaaa": las filas antiguas de intereses no traen el día.
_MES_ANIO = re.compile(r"^\s*(\d{1,2})[-/.](\d{4})\s*$")

ADVERTENCIAS_COMPENSACION = (
    "El ahorro es la diferencia de cuota de la base del ahorro con y sin la venta, "
    "con el mismo FIFO y la misma regla de los dos meses que la pantalla de Ventas.",
    "No tiene en cuenta la compensación del 25 % con dividendos e intereses: con "
    "rendimientos del capital, una pérdida puede ahorrar algo más de lo indicado. "
    "La previsión del IRPF del ahorro sí lo calcula.",
    "Los precios son los últimos guardados de cada activo. Vender a otro precio "
    "cambia el resultado.",
)

ADVERTENCIAS_IRPF = (
    "Previsión orientativa de la parte del ahorro: solo cuenta las ventas, los "
    "dividendos y los intereses registrados en esta aplicación.",
    "El dividendo bruto es el total cobrado más los impuestos anotados. Si esos "
    "impuestos son una retención extranjera, no se descuentan como retención "
    "española: se recupera, con límites, por la deducción por doble imposición.",
    "No incluye staking, renta fija, bonos ni otros rendimientos que no estén en "
    "Dividendos o en Intereses.",
)


class EntradaInvalida(ValueError):
    """Un parámetro de la herramienta no se puede interpretar."""


# ── Utilidades ───────────────────────────────────────────────────────────────


def _texto(valor, decimales: int = 2) -> str:
    """Importe como texto con punto decimal, redondeado como el resto de la app."""
    return f"{dinero.redondear(Decimal(valor), decimales):f}"


def _fechaDeRegistro(texto) -> date | None:
    """Fecha de una fila de dividendos o intereses; día 1 si solo trae mes y año."""
    completa = leerFecha(texto)
    if completa is not None:
        return completa
    coincidencia = _MES_ANIO.match(str(texto or ""))
    if not coincidencia:
        return None
    mes, anio = int(coincidencia.group(1)), int(coincidencia.group(2))
    if not 1 <= mes <= 12:
        return None
    return date(anio, mes, 1)


def _aEuros(importe: Decimal, moneda: str, fecha: date) -> Decimal | None:
    """Importe en euros con el tipo de la caché para esa fecha, o None si falta.

    No descarga: una previsión no debe depender de que responda un proveedor de
    tipos de cambio, y el tipo que falte se avisa en vez de inventarse.
    """
    codigo = str(moneda or "EUR").strip().upper() or "EUR"
    if codigo == "EUR":
        return importe
    from stores.fx_historico import tasa

    tipo, _origen, _fechaUsada = tasa(codigo, fecha, permitirDescarga=False)
    if tipo is None or tipo <= 0:
        return None
    return importe * tipo


def _resumenLiquidacion(liquidacion) -> dict:
    """Las cifras del ejercicio que enseña la herramienta (ceros si no hay)."""
    if liquidacion is None:
        return dict.fromkeys(
            ("ganancias", "perdidas", "saldo", "compensadoAnteriores", "base", "cuota", "pendienteCompensar"),
            "0.00",
        )
    return {
        "ganancias": _texto(liquidacion.ganancias),
        "perdidas": _texto(liquidacion.perdidas),
        "saldo": _texto(liquidacion.saldo),
        "compensadoAnteriores": _texto(liquidacion.compensadoAnteriores),
        "base": _texto(liquidacion.base),
        "cuota": _texto(liquidacion.cuota),
        "pendienteCompensar": _texto(liquidacion.pendienteCompensar),
    }


def _cuota(liquidaciones: dict, anio: str) -> Decimal:
    liquidacion = liquidaciones.get(anio)
    return liquidacion.cuota if liquidacion is not None else _CERO


def _saldoNegativo(liquidaciones: dict, anio: str) -> Decimal:
    liquidacion = liquidaciones.get(anio)
    return liquidacion.saldoNegativoGenerado if liquidacion is not None else _CERO


# ── Compensación de pérdidas ─────────────────────────────────────────────────


def _posicionesConPrecio() -> tuple[list[dict], list[dict]]:
    """Posiciones vivas con su último precio, y las que no tienen cotización.

    Returns:
        `(conPrecio, sinPrecio)`. Cada posición es
        `{"id", "nombre", "tipo", "moneda", "cantidad", "precio"}`.
    """
    cartera = ventas_fifo.carteraViva()
    if not cartera:
        return [], []

    filas = getDb().execute("SELECT id, name, type, currency, price FROM activos").fetchall()
    conPrecio, sinPrecio = [], []
    for fila in filas:
        posicion = cartera.get(fila["id"])
        if posicion is None:
            continue
        dato = {
            "id": fila["id"],
            "nombre": fila["name"],
            "tipo": fila["type"],
            "moneda": str(fila["currency"] or "EUR").strip().upper() or "EUR",
            "cantidad": posicion["cantidad"],
            "precio": dinero.aDecimal(fila["price"], "precio", defecto=_CERO),
        }
        (conPrecio if dato["precio"] > 0 else sinPrecio).append(dato)
    return conPrecio, sinPrecio


def _fechaRecompraLibre(fecha: date, tipoActivo: str) -> tuple[int, date]:
    """Meses de la ventana de antiaplicación y primer día en que recomprar no bloquea.

    La ventana de `fiscal_es` incluye su último día, así que el primero libre es
    el siguiente.
    """
    meses = fiscal_es.ventanaAntiaplicacion(tipoActivo)
    return meses, fiscal_es.sumarMeses(fecha, meses) + timedelta(days=1)


def _candidata(posicion: dict, dato: dict, base: dict, anio: str, fecha: date) -> dict:
    """Serializa la venta simulada de una posición en pérdidas."""
    resultado = dato["resultado"]
    liquidaciones = dato["liquidaciones"]
    meses, libre = _fechaRecompraLibre(fecha, posicion["tipo"])
    ahorro = _cuota(base, anio) - _cuota(liquidaciones, anio)
    computable = -resultado.gananciaComputable if resultado.gananciaComputable < 0 else _CERO
    return {
        "id": posicion["id"],
        "nombre": posicion["nombre"],
        "tipo": posicion["tipo"],
        "moneda": posicion["moneda"],
        "cantidad": _texto(posicion["cantidad"], 8),
        "precio": _texto(posicion["precio"], 4),
        "valorTransmision": _texto(resultado.valorTransmision),
        "costeAdquisicion": _texto(resultado.costeAdquisicion),
        "perdida": _texto(-resultado.ganancia),
        "perdidaComputable": _texto(computable),
        "perdidaNoComputable": _texto(resultado.perdidaNoComputable),
        "notaAntiaplicacion": resultado.notaAntiaplicacion,
        "ahorroCuota": _texto(max(ahorro, _CERO)),
        "perdidaParaAnosSiguientes": _texto(
            max(_saldoNegativo(liquidaciones, anio) - _saldoNegativo(base, anio), _CERO)
        ),
        "ventanaMeses": meses,
        "recompraDesde": libre.strftime("%d-%m-%Y"),
    }


def compensacionDePerdidas(fecha: date | None = None) -> dict:
    """Qué posiciones en pérdidas conviene vender para compensar el ejercicio.

    Simula vender cada posición en pérdidas, por separado y todas juntas, al
    último precio guardado, y mide cuánta cuota de la base del ahorro se ahorra.

    Args:
        fecha: Fecha de la venta hipotética; por defecto, hoy.

    Returns:
        Diccionario con el ejercicio (`ejercicio`), las candidatas ordenadas por
        ahorro (`candidatas`), el efecto de venderlas todas (`conjunta`), las
        posiciones que no se pudieron evaluar (`noEvaluables`) y
        `advertencias`.
    """
    fecha = fecha or date.today()
    anio = str(fecha.year)
    conPrecio, sinPrecio = _posicionesConPrecio()
    porId = {p["id"]: p for p in conPrecio}

    noEvaluables = [
        {"id": p["id"], "nombre": p["nombre"], "motivo": "Sin cotización guardada."} for p in sinPrecio
    ]

    simulacion = ventas_fifo.simularVariasVentas(
        [{"activo": p["id"], "cantidad": p["cantidad"], "precio": p["precio"]} for p in conPrecio],
        fecha,
        conjunto=lambda _activoId, resultado: not resultado.incidencia and resultado.ganancia < 0,
    )
    base = simulacion["base"]

    candidatas = []
    for activoId, dato in simulacion["individuales"].items():
        resultado = dato["resultado"]
        posicion = porId[activoId]
        if resultado is None:
            continue
        if resultado.incidencia:
            noEvaluables.append({
                "id": activoId,
                "nombre": posicion["nombre"],
                "motivo": ventas_fifo.mensajeIncidencia(resultado.incidencia) or resultado.incidencia,
            })
            continue
        if resultado.ganancia < 0:
            candidatas.append(_candidata(posicion, dato, base, anio, fecha))

    candidatas.sort(key=lambda c: (-Decimal(c["ahorroCuota"]), -Decimal(c["perdida"]), c["nombre"]))
    noEvaluables.sort(key=lambda n: n["nombre"] or "")

    conjunta = simulacion["conjunta"]
    return {
        "fecha": fecha.strftime("%d-%m-%Y"),
        "anio": anio,
        "ejercicio": _resumenLiquidacion(base.get(anio)),
        "candidatas": candidatas,
        "conjunta": {
            "activos": len(simulacion["enConjunta"]),
            "ahorroCuota": _texto(max(_cuota(base, anio) - _cuota(conjunta, anio), _CERO)),
            "cuotaDespues": _texto(_cuota(conjunta, anio)),
            "perdidaParaAnosSiguientes": _texto(
                max(_saldoNegativo(conjunta, anio) - _saldoNegativo(base, anio), _CERO)
            ),
        },
        "noEvaluables": noEvaluables,
        "advertencias": list(ADVERTENCIAS_COMPENSACION),
    }


# ── Previsión del IRPF del ahorro ────────────────────────────────────────────


def _arrastresAlEmpezar(liquidaciones: dict, anio: int) -> list[dict]:
    """Saldos negativos de ejercicios anteriores pendientes al empezar `anio`.

    Si el ejercicio ya está liquidado, lo pendiente al empezar es lo que sigue
    pendiente al cerrarlo más lo que él mismo aplicó. Si no hay liquidación de
    ese año (ninguna venta todavía), es lo que dejó pendiente el último cerrado.
    """
    actual = liquidaciones.get(str(anio))
    pendientes: dict[int, Decimal] = {}
    if actual is not None:
        for arrastre in actual.arrastres:
            if arrastre["anio_origen"] < anio:
                pendientes[arrastre["anio_origen"]] = pendientes.get(arrastre["anio_origen"], _CERO) + arrastre["importe"]
        for aplicado in actual.compensacionesAplicadas:
            pendientes[aplicado["anio_origen"]] = pendientes.get(aplicado["anio_origen"], _CERO) + aplicado["importe"]
    else:
        anteriores = [int(a) for a in liquidaciones if a.isdigit() and int(a) < anio]
        if anteriores:
            for arrastre in liquidaciones[str(max(anteriores))].arrastres:
                pendientes[arrastre["anio_origen"]] = arrastre["importe"]
    return [{"anio_origen": origen, "importe": importe} for origen, importe in sorted(pendientes.items())]


def _rendimientosDividendos(anio: int) -> dict:
    """Dividendos brutos e impuestos del ejercicio, en euros."""
    bruto, impuestos = _CERO, _CERO
    cobros, sinTipo, sinFecha = 0, set(), 0
    for fila in readDividendosFile()["rows"]:
        fecha = _fechaDeRegistro(fila.get("fecha"))
        if fecha is None:
            sinFecha += 1
            continue
        if fecha.year != anio:
            continue
        total = dinero.aDecimalONulo(fila.get("total"))
        if total is None:
            log.warning("[irpf] Dividendo sin total legible (%s, %s)", fila.get("instrumento"), fila.get("fecha"))
            continue
        retenido = dinero.aDecimalONulo(fila.get("impuestos")) or _CERO
        moneda = fila.get("monedaTotal") or "EUR"
        brutoEur = _aEuros(total + retenido, moneda, fecha)
        retenidoEur = _aEuros(retenido, moneda, fecha)
        if brutoEur is None or retenidoEur is None:
            sinTipo.add(str(moneda).upper())
            continue
        bruto += brutoEur
        impuestos += retenidoEur
        cobros += 1
    return {"bruto": bruto, "impuestos": impuestos, "cobros": cobros, "sinTipo": sorted(sinTipo), "sinFecha": sinFecha}


def _rendimientosIntereses(anio: int) -> dict:
    """Intereses brutos y retenciones del ejercicio, en euros."""
    bruto, impuestos, apuntes, sinFecha = _CERO, _CERO, 0, 0
    for cuenta in readInteresesFile().get("cuentas", []):
        for fila in cuenta.get("rows", []):
            fecha = _fechaDeRegistro(fila.get("fecha"))
            if fecha is None:
                sinFecha += 1
                continue
            if fecha.year != anio:
                continue
            importe = dinero.aDecimalONulo(fila.get("acumulado"))
            if importe is None:
                continue
            bruto += importe
            impuestos += dinero.aDecimalONulo(fila.get("impuestos")) or _CERO
            apuntes += 1
    return {"bruto": bruto, "impuestos": impuestos, "apuntes": apuntes, "sinFecha": sinFecha}


def leerAnio(texto) -> int:
    """Ejercicio pedido, o el actual si no se indica.

    Raises:
        EntradaInvalida: si no es un año de cuatro cifras razonable.
    """
    if texto is None or not str(texto).strip():
        return date.today().year
    limpio = str(texto).strip()
    if not limpio.isdigit() or not 2000 <= int(limpio) <= 2100:
        raise EntradaInvalida("El ejercicio debe ser un año entre 2000 y 2100.")
    return int(limpio)


def leerRetenciones(texto) -> Decimal | None:
    """Retenciones indicadas a mano, o None para usar las apuntadas.

    Raises:
        EntradaInvalida: si no es un importe mayor o igual que cero.
    """
    if texto is None or not str(texto).strip():
        return None
    valor = dinero.aDecimalONulo(texto)
    if valor is None or valor < 0:
        raise EntradaInvalida("Las retenciones deben ser un importe mayor o igual que cero.")
    return valor


def previsionIrpfAhorro(anio: int, retenciones: Decimal | None = None) -> dict:
    """Cuota prevista de la base del ahorro de un ejercicio.

    Suma las ganancias y pérdidas patrimoniales de la pantalla de Ventas, los
    dividendos y los intereses del ejercicio, y los integra con la compensación
    cruzada del 25 % y los saldos negativos pendientes (art. 49 LIRPF).

    Args:
        anio: Ejercicio.
        retenciones: Retenciones a descontar. Sin ellas, se usan las anotadas
            en dividendos e intereses.

    Returns:
        Diccionario con los rendimientos, las ganancias, la integración, la
        cuota por tramos, el resultado y `advertencias`.
    """
    liquidaciones = ventas_fifo.calcularTodo()["liquidaciones"]
    liquidacion = liquidaciones.get(str(anio))
    saldoGyp = liquidacion.saldo if liquidacion is not None else _CERO

    dividendos = _rendimientosDividendos(anio)
    intereses = _rendimientosIntereses(anio)
    rcm = dividendos["bruto"] + intereses["bruto"]

    integracion = fiscal_es.integrarBaseAhorro(rcm, saldoGyp, _arrastresAlEmpezar(liquidaciones, anio), anio)

    apuntadas = dividendos["impuestos"] + intereses["impuestos"]
    aplicadas = apuntadas if retenciones is None else retenciones

    advertencias = list(ADVERTENCIAS_IRPF)
    if dividendos["sinTipo"]:
        advertencias.append(
            "Dividendos fuera del cálculo por no tener tipo de cambio en la caché para su fecha: "
            + ", ".join(dividendos["sinTipo"]) + ". Complétalos desde Ajustes → Tipos de cambio."
        )
    sinFecha = dividendos["sinFecha"] + intereses["sinFecha"]
    if sinFecha:
        advertencias.append(f"{sinFecha} apunte(s) sin fecha legible no entran en ningún ejercicio.")

    return {
        "anio": str(anio),
        "rendimientos": {
            "dividendosBrutos": _texto(dividendos["bruto"]),
            "dividendosImpuestos": _texto(dividendos["impuestos"]),
            "dividendosCobros": dividendos["cobros"],
            "interesesBrutos": _texto(intereses["bruto"]),
            "interesesRetenciones": _texto(intereses["impuestos"]),
            "interesesApuntes": intereses["apuntes"],
            "total": _texto(rcm),
        },
        "ganancias": _resumenLiquidacion(liquidacion),
        "integracion": {
            "saldoGyp": _texto(integracion.saldoGyp),
            "cruzadoGypContraRcm": _texto(integracion.cruzadoGypContraRcm),
            "cruzadoRcmContraGyp": _texto(integracion.cruzadoRcmContraGyp),
            "arrastresAplicadosGyp": _texto(integracion.arrastresAplicadosGyp),
            "arrastresAplicadosRcm": _texto(integracion.arrastresAplicadosRcm),
            "baseGyp": _texto(integracion.baseGyp),
            "baseRcm": _texto(integracion.baseRcm),
            "perdidaArrastrable": _texto(integracion.perdidaArrastrable),
            "detalleArrastres": [
                {
                    "anioOrigen": str(d["anio_origen"]),
                    "contraGyp": _texto(d["contraGyp"]),
                    "contraRcm": _texto(d["contraRcm"]),
                    "restante": _texto(d["restante"]),
                    "ultimoEjercicio": str(d["ultimo_ejercicio"]),
                }
                for d in integracion.detalleArrastres
            ],
        },
        "base": _texto(integracion.base),
        "tramos": {clave: _texto(valor) for clave, valor in integracion.tramos.items()},
        "cuota": _texto(integracion.cuota),
        "tipoMedio": _texto(integracion.cuota / integracion.base * 100 if integracion.base > 0 else _CERO),
        "retencionesApuntadas": _texto(apuntadas),
        "retencionesAplicadas": _texto(aplicadas),
        "resultado": _texto(integracion.cuota - aplicadas),
        "advertencias": advertencias,
    }
