"""Resumen de ingresos pasivos por dividendos y rentabilidad sobre coste.

Lógica pura: no lee la base de datos ni pide tipos de cambio. Quien la llama
entrega los cobros ya en euros y el coste (y valor) de cada activo; así se
prueba con números sin montar nada.

Dos decisiones de criterio:

* El «importe» de un cobro es el campo `total` del registro, el mismo que suma
  la ventana Dividendos en su cabecera. Los impuestos se informan aparte; no se
  restan una segunda vez.
* La proyección a 12 meses es lo cobrado en los últimos 12 meses. No hay
  calendario fiable de pagos futuros, así que se dice lo que es: una
  extrapolación del último año, no una previsión.
"""

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from core import dinero

_CERO = Decimal(0)
_CIEN = Decimal(100)
_SEPARADOR = re.compile(r"[-/.]")


@dataclass(frozen=True)
class Cobro:
    """Un dividendo cobrado, ya convertido a euros.

    Attributes:
        fecha: Día del cobro, o `None` si el registro no trae una fecha completa.
        instrumento: Nombre del activo tal como está en el registro.
        importe: Total cobrado en euros.
        impuestos: Impuestos retenidos en euros.
    """

    fecha: date | None
    instrumento: str
    importe: Decimal
    impuestos: Decimal = _CERO


@dataclass(frozen=True)
class PosicionActivo:
    """Coste y valor actual de un activo en euros, para medir la rentabilidad."""

    coste: Decimal
    valor: Decimal


def leerFecha(texto) -> date | None:
    """Fecha de un registro de dividendos, o `None` si no es una fecha completa.

    Args:
        texto: `dd-mm-aaaa` o `aaaa-mm-dd`, separados por `-`, `/` o `.`.

    Returns:
        La fecha, o `None` si faltan partes o no existe en el calendario. Un
        registro sin fecha utilizable no se descarta: cuenta como «sin fecha».
    """
    partes = _SEPARADOR.split(str(texto or "").strip())
    if len(partes) != 3 or not all(p.isdigit() for p in partes):
        return None
    primero, medio, ultimo = partes
    try:
        if len(primero) == 4:
            return date(int(primero), int(medio), int(ultimo))
        return date(int(ultimo), int(medio), int(primero))
    except ValueError:
        return None


def _restarMeses(hoy: date, meses: int) -> tuple[int, int]:
    indice = hoy.year * 12 + (hoy.month - 1) - meses
    return indice // 12, indice % 12 + 1


def _ultimosDoceMeses(hoy: date) -> list[str]:
    """Claves `aaaa-mm` de los 12 meses que acaban en el de `hoy`, del más antiguo al más reciente."""
    return [f"{a:04d}-{m:02d}" for a, m in (_restarMeses(hoy, atras) for atras in range(11, -1, -1))]


def _porcentaje(parte: Decimal, base: Decimal) -> float | None:
    if base <= _CERO:
        return None
    return float(dinero.redondear(parte / base * _CIEN, 2))


def _euros(valor: Decimal) -> float:
    return float(dinero.redondear(valor, 2))


def _porActivo(cobros: Iterable[Cobro], posiciones: Mapping[str, PosicionActivo]) -> list[dict]:
    totales: dict[str, Decimal] = {}
    for cobro in cobros:
        totales[cobro.instrumento] = totales.get(cobro.instrumento, _CERO) + cobro.importe

    filas = []
    for nombre, cobrado in totales.items():
        posicion = posiciones.get(nombre)
        filas.append({
            "instrumento": nombre,
            "cobrado12m": _euros(cobrado),
            "coste": _euros(posicion.coste) if posicion else None,
            "yieldOnCost": _porcentaje(cobrado, posicion.coste) if posicion else None,
            "yieldSobreValor": _porcentaje(cobrado, posicion.valor) if posicion else None,
        })
    return sorted(filas, key=lambda f: f["cobrado12m"], reverse=True)


def resumirIngresosPasivos(cobros: Iterable[Cobro], posiciones: Mapping[str, PosicionActivo],
                           hoy: date) -> dict:
    """Totales, media mensual, proyección y rentabilidad por dividendo.

    Args:
        cobros: Dividendos cobrados, ya en euros.
        posiciones: Coste y valor actual por nombre de instrumento. Un
            instrumento ausente (vendido, o renombrado) no tiene rentabilidad:
            sale con `None`, no con un cero que pareciera un dato.
        hoy: Fecha de referencia de la ventana de 12 meses.

    Returns:
        Diccionario serializable con `ultimos12Meses`, `mediaMensual`,
        `proyeccion12Meses`, `anioActual`, `anioAnterior`, `porMes` (los 12
        últimos meses, con ceros donde no hubo cobro), `porActivo`,
        `yieldOnCostGlobal` y `sinFecha` (registros que no entran en ninguna
        ventana por no tener fecha completa).
    """
    claves = _ultimosDoceMeses(hoy)
    porMes = dict.fromkeys(claves, _CERO)
    ultimos12: list[Cobro] = []
    anioActual = anioAnterior = _CERO
    sinFecha = 0

    for cobro in cobros:
        if cobro.fecha is None:
            sinFecha += 1
            continue
        clave = f"{cobro.fecha.year:04d}-{cobro.fecha.month:02d}"
        if clave in porMes and cobro.fecha <= hoy:
            porMes[clave] += cobro.importe
            ultimos12.append(cobro)
        if cobro.fecha.year == hoy.year:
            anioActual += cobro.importe
        elif cobro.fecha.year == hoy.year - 1:
            anioAnterior += cobro.importe

    total12 = sum((c.importe for c in ultimos12), _CERO)
    conCoste = [c for c in ultimos12 if c.instrumento in posiciones and posiciones[c.instrumento].coste > _CERO]
    costeMedido = sum((posiciones[n].coste for n in {c.instrumento for c in conCoste}), _CERO)
    cobradoMedido = sum((c.importe for c in conCoste), _CERO)

    return {
        "ultimos12Meses": _euros(total12),
        "mediaMensual": _euros(total12 / 12),
        "proyeccion12Meses": _euros(total12),
        "anioActual": _euros(anioActual),
        "anioAnterior": _euros(anioAnterior),
        "porMes": [{"mes": clave, "importe": _euros(porMes[clave])} for clave in claves],
        "porActivo": _porActivo(ultimos12, posiciones),
        "yieldOnCostGlobal": _porcentaje(cobradoMedido, costeMedido),
        "sinFecha": sinFecha,
    }
