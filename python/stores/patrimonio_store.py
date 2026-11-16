"""Reúne las partidas del patrimonio desde la base de datos activa.

Adapta cada módulo (inversiones, cuentas, renta fija, bonos y las tres clases de
deuda) a la lista de `Partida` que consume `core.patrimonio`. La suma y el
criterio de qué cuenta como activo o pasivo viven allí; aquí solo se lee y se
convierte a euros.

Una deuda que no se puede calcular (datos incompletos) no tumba el resumen: se
deja fuera y se devuelve en `avisos`, para que el total no parezca completo
cuando no lo es.
"""

from datetime import date
from decimal import Decimal

from core import dinero
from core.financiaciones import calcularFinanciacion
from core.hipotecas import calcularHipoteca
from core.ingresos_pasivos import leerFecha
from core.microcreditos import calcularMicrocredito
from core.patrimonio import Partida, componerPatrimonio
from stores.app_data import readBonosFile, readRentaFijaFile
from stores.cuentas_store import listarCuentas, saldos
from stores.financiaciones_store import listarFinanciaciones
from stores.hipotecas_store import listarHipotecas
from stores.microcreditos_store import listarMicrocreditos
from stores.valoracion import _Cambios, valorarPortfolio

_CERO = Decimal(0)


def _inversiones() -> list[Partida]:
    total = dinero.aDecimal(valorarPortfolio(refrescarPrecios=False)["total_value"])
    return [Partida("inversiones", "Cartera de inversión", total)] if total else []


def _cuentas() -> list[Partida]:
    calculados = saldos()
    return [Partida("cuentas", c["nombre"], calculados[c["id"]]["saldo"])
            for c in listarCuentas() if c["id"] in calculados]


def _valorRenta(fila: dict, cambios: _Cambios) -> Decimal:
    """Capital más intereses netos de una fila de renta fija o bono, en euros."""
    importes = (dinero.aDecimalONulo(fila.get(c)) or _CERO
                for c in ("invertido", "interesAcumulado", "impuestos"))
    invertido, intereses, impuestos = importes
    return cambios.aEuros(invertido + intereses - impuestos, fila.get("currency") or "EUR")


def _rentaFija(hoy: date, cambios: _Cambios) -> list[Partida]:
    """Renta fija y bonos que aún no han vencido.

    Lo vencido ya volvió a una cuenta: contarlo también aquí lo duplicaría.
    Una fila sin vencimiento legible se incluye, porque excluirla escondería
    dinero invertido.
    """
    partidas = []
    for fila in [*readRentaFijaFile()["rows"], *readBonosFile()["rows"]]:
        vencimiento = leerFecha(fila.get("vencimiento"))
        if vencimiento is not None and vencimiento < hoy:
            continue
        valor = _valorRenta(fila, cambios)
        if valor:
            partidas.append(Partida("rentaFija", fila.get("instrumento") or "Sin nombre", valor))
    return partidas


def _deuda(grupo: str, nombre: str, calculo: dict, clave: str, avisos: list[str]) -> list[Partida]:
    if "error" in calculo:
        avisos.append(f"{nombre}: {calculo['error']}")
        return []
    pendiente = dinero.aDecimal(calculo["resumen"][clave])
    return [Partida(grupo, nombre, pendiente)] if pendiente > _CERO else []


def _pasivos(hoy: date, avisos: list[str]) -> list[Partida]:
    """Deuda viva de hipotecas, compras financiadas y microcréditos.

    En hipotecas y compras financiadas es el capital pendiente; en microcréditos,
    lo que queda por pagar, comisión incluida, porque es lo que hay que devolver.
    """
    partidas: list[Partida] = []
    for h in listarHipotecas():
        partidas += _deuda("hipotecas", h["alias"], calcularHipoteca(h, hoy), "capitalPendiente", avisos)
    for f in listarFinanciaciones():
        partidas += _deuda("financiaciones", f["articulo"], calcularFinanciacion(f, hoy), "capitalPendiente", avisos)
    for m in listarMicrocreditos():
        partidas += _deuda("microcreditos", m["nombre"], calcularMicrocredito(m, hoy), "pendiente", avisos)
    return partidas


def calcularPatrimonioActual(hoy: date | None = None) -> dict:
    """Patrimonio neto de la cartera activa a fecha `hoy`.

    Args:
        hoy: Fecha de referencia; por defecto, la de hoy.

    Returns:
        El resultado de `core.patrimonio.componerPatrimonio` más `avisos`, la
        lista de deudas que no se pudieron calcular y quedan fuera del total.
    """
    hoy = hoy or date.today()
    avisos: list[str] = []
    cambios = _Cambios()
    resultado = componerPatrimonio([*_inversiones(), *_cuentas(), *_rentaFija(hoy, cambios)],
                                   _pasivos(hoy, avisos))
    resultado["avisos"] = avisos
    return resultado
