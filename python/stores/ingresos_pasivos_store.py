"""Reúne dividendos, costes y valores de la cartera activa para el resumen pasivo.

Adapta los registros de Dividendos y la valoración de la cartera a las entradas
de `core.ingresos_pasivos`. El cálculo vive allí; aquí se lee y se convierte a
euros.

Los dividendos se asocian a un activo por nombre, que es lo único que guarda el
registro (la ventana elige el instrumento de la lista de activos). Un dividendo
de un activo renombrado o ya vendido no encuentra posición y sale sin
rentabilidad en vez de con una inventada.
"""

import logging
from datetime import date
from decimal import Decimal

from core import dinero
from core.db import getDb
from core.ingresos_pasivos import Cobro, PosicionActivo, leerFecha, resumirIngresosPasivos
from stores.app_data import readDividendosFile
from stores.valoracion import _Cambios, valorarPortfolio

log = logging.getLogger(__name__)


def _cobros(cambios: _Cambios) -> list[Cobro]:
    cobros = []
    for fila in readDividendosFile()["rows"]:
        total = dinero.aDecimalONulo(fila["total"])
        if total is None:
            # Una celda vacía o ilegible no es un cobro de cero: se ignora y se avisa.
            log.warning("Dividendo sin total legible (%s, %s); no entra en el resumen",
                        fila["instrumento"], fila["fecha"])
            continue
        moneda = fila["monedaTotal"]
        impuestos = dinero.aDecimalONulo(fila["impuestos"]) or Decimal(0)
        cobros.append(Cobro(
            fecha=leerFecha(fila["fecha"]),
            instrumento=fila["instrumento"].strip(),
            importe=cambios.aEuros(total, moneda),
            impuestos=cambios.aEuros(impuestos, moneda),
        ))
    return cobros


def _posiciones() -> dict[str, PosicionActivo]:
    """Coste y valor en euros de cada activo con posición viva, por nombre."""
    nombres = {fila["id"]: str(fila["name"]).strip()
               for fila in getDb().execute("SELECT id, name FROM activos").fetchall()}
    desglose = valorarPortfolio(refrescarPrecios=False)["assets"]
    return {
        nombres[a["id"]]: PosicionActivo(dinero.aDecimal(a["c"]), dinero.aDecimal(a["v"]))
        for a in desglose if a["id"] in nombres
    }


def calcularIngresosPasivos(hoy: date | None = None) -> dict:
    """Resumen de ingresos pasivos de la cartera activa.

    Args:
        hoy: Fecha de referencia; por defecto, la de hoy.

    Returns:
        El resultado de `core.ingresos_pasivos.resumirIngresosPasivos`.
    """
    return resumirIngresosPasivos(_cobros(_Cambios()), _posiciones(), hoy or date.today())
