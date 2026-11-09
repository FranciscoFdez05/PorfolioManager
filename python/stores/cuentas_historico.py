"""Histórico diario del saldo de cada cuenta, para las gráficas de la ventana Cuentas.

`cuentas_store.saldos` da el saldo de hoy; aquí se reparte ese mismo dinero en el
tiempo. Cada movimiento cae en su día:

  * transferencias, gastos e ingresos llevan fecha dd-mm-aaaa y se colocan en ese
    día (si la fecha no casa con el mes de la fila, manda el mes: el día 1);
  * mensualidades e ingresos recurrentes solo tienen mes y cuentan el día 1;
    intereses y dividendos, el día de su fecha si la tiene, o el 1 si solo
    dicen el mes;
  * lo que no tiene fecha que se entienda pero `saldos` cuenta igualmente (una
    transferencia «sin fecha», una fila con el mes mal escrito) va al punto de
    partida, junto al saldo inicial.

Lo ocurrido en el mes en curso con un día posterior a hoy se apunta hoy: `saldos`
trabaja por meses y ya lo cuenta, y el último punto del histórico tiene que ser
exactamente el saldo de hoy.
"""

import datetime
from collections import defaultdict
from collections.abc import Callable
from decimal import Decimal

from core.db import getDb
from stores.cuentas_store import (
    _FECHA,
    ID_BANCO,
    MONTH_KEYS,
    _anioMes,
    _cambioAEuros,
    _cuentaDeFila,
    _decimal,
    _excepcionesDeCuenta,
    _yaOcurrido,
    _yearMonth,
    listarCuentas,
)

_CERO = Decimal(0)

# Movimientos sin día conocido que aun así forman parte del saldo.
_SIN_DIA = None


class _Acumulador:
    """Entradas y salidas de cada cuenta por día, más lo que no tiene día."""

    def __init__(self, cuentas: list[dict]) -> None:
        self.existentes = {c["id"] for c in cuentas}
        self.base = {c["id"]: _decimal(c["saldo_inicial"]) for c in cuentas}
        self.porDia: dict[str, dict[datetime.date, list[Decimal]]] = defaultdict(
            lambda: defaultdict(lambda: [_CERO, _CERO])
        )

    def entrada(self, cuentaId: str, dia: datetime.date | None, importe: Decimal) -> None:
        self._anotar(cuentaId, dia, importe, 0)

    def salida(self, cuentaId: str, dia: datetime.date | None, importe: Decimal) -> None:
        self._anotar(cuentaId, dia, importe, 1)

    def _anotar(self, cuentaId: str, dia: datetime.date | None, importe: Decimal, posicion: int) -> None:
        if cuentaId not in self.existentes or not importe:
            return
        if dia is _SIN_DIA:
            self.base[cuentaId] += importe if posicion == 0 else -importe
            return
        self.porDia[cuentaId][dia][posicion] += importe


def _diaDeFecha(texto: str) -> datetime.date | None:
    """`date` de un texto dd-mm-aaaa o aaaa-mm-dd, o None si no lo es o no existe."""
    limpio = str(texto or "").strip()
    coincide = _FECHA.match(limpio)
    try:
        if coincide:
            dia, mes, anio = (int(g) for g in coincide.groups())
            return datetime.date(anio, mes, dia)
        return datetime.date.fromisoformat(limpio)
    except ValueError:
        return None


def _diaDeMes(year: str, month: str, fecha: str, hoy: datetime.date) -> datetime.date | bool | None:
    """Día en que cuenta una fila de año y mes.

    Devuelve False si el mes todavía no ha llegado (no cuenta), `_SIN_DIA` si el
    año o el mes no se entienden (`saldos` la cuenta igual) y si no la fecha de
    la fila cuando cae en ese mes, o el día 1. Nunca un día posterior a hoy.
    """
    if not _yaOcurrido(year, month, hoy):
        return False
    try:
        primero = datetime.date(int(year), MONTH_KEYS.index(month) + 1, 1)
    except (ValueError, TypeError):
        return _SIN_DIA
    dia = _diaDeFecha(fecha) if fecha else None
    if dia is None or (dia.year, dia.month) != (primero.year, primero.month):
        dia = primero
    return min(dia, hoy)


def _transferencias(conn, acumulado: _Acumulador, hoy: datetime.date) -> None:
    for fila in conn.execute("SELECT fecha, origen, destino, cantidad, comision FROM transferencias").fetchall():
        year, month = _yearMonth(fila["fecha"])
        if year:
            dia = _diaDeMes(year, month, fila["fecha"], hoy)
            if dia is False:
                continue
        else:
            dia = _SIN_DIA
        importe = _decimal(fila["cantidad"])
        acumulado.entrada(fila["destino"], dia, importe)
        acumulado.salida(fila["origen"], dia, importe + _decimal(fila["comision"]))


def _filas(conn, acumulado: _Acumulador, hoy: datetime.date) -> None:
    for tabla, anotar in (("ingresos_rows", acumulado.entrada), ("gastos_rows", acumulado.salida)):
        for fila in conn.execute(f"SELECT year, month, fecha, cantidad, cuenta FROM {tabla}").fetchall():
            dia = _diaDeMes(fila["year"], fila["month"], fila["fecha"], hoy)
            if dia is not False:
                anotar(_cuentaDeFila(fila["cuenta"]), dia, _decimal(fila["cantidad"]))


def _recurrentes(conn, acumulado: _Acumulador, hoy: datetime.date) -> None:
    columnas = ", ".join(["year", "cuenta", "cuentas_cobro", *MONTH_KEYS])
    for tabla, anotar in (("ingresos_recurrentes", acumulado.entrada), ("mensualidades", acumulado.salida)):
        for fila in conn.execute(f"SELECT {columnas} FROM {tabla}").fetchall():
            habitual = _cuentaDeFila(fila["cuenta"])
            excepciones = _excepcionesDeCuenta(fila["cuentas_cobro"])
            for mes in MONTH_KEYS:
                if not fila[mes]:
                    continue
                dia = _diaDeMes(fila["year"], mes, "", hoy)
                if dia is False:
                    continue
                destino = _cuentaDeFila(excepciones.get(mes)) if mes in excepciones else habitual
                # Igual que en `saldos`: una cuenta que ya no existe es la bancaria.
                if destino not in acumulado.existentes:
                    destino = ID_BANCO
                anotar(destino, dia, _decimal(fila[mes]))


def _diaDeRendimiento(texto: str, hoy: datetime.date) -> datetime.date | bool | None:
    """Día de un interés o dividendo; False si no se entiende o aún no ha llegado,
    como en `cuentas_store._rendimientosEn`, que entonces no lo cuenta."""
    year, month = _anioMes(texto)
    if not year or not _yaOcurrido(year, month, hoy):
        return False
    try:
        primero = datetime.date(int(year), MONTH_KEYS.index(month) + 1, 1)
    except ValueError:
        # Año 0000: `saldos` lo cuenta, así que va al punto de partida.
        return _SIN_DIA
    dia = _diaDeFecha(texto)
    if dia is None or (dia.year, dia.month) != (primero.year, primero.month):
        dia = primero
    return min(dia, hoy)


def _rendimientos(conn, acumulado: _Acumulador, hoy: datetime.date, aEuros: Callable | None) -> None:
    for fila in conn.execute(
        "SELECT v.cuenta_id, i.fecha, i.acumulado, i.impuestos FROM intereses_v2 i "
        "JOIN cuenta_remunerada_vinculo v ON v.remunerada_id = i.cuenta_id"
    ).fetchall():
        dia = _diaDeRendimiento(fila["fecha"], hoy)
        if dia is not False:
            acumulado.entrada(fila["cuenta_id"], dia, _decimal(fila["acumulado"]) - _decimal(fila["impuestos"]))

    cobra = conn.execute("SELECT id FROM cuentas WHERE dividendos = 1 ORDER BY sort_order, rowid").fetchone()
    for fila in conn.execute("SELECT fecha, total, moneda_total, cuenta FROM dividendos").fetchall():
        destino = fila["cuenta"] if fila["cuenta"] in acumulado.existentes else (cobra["id"] if cobra else None)
        if destino is None:
            continue
        dia = _diaDeRendimiento(fila["fecha"], hoy)
        if dia is False:
            continue
        # El cambio se pide solo si hay algún dividendo que convertir: es una
        # llamada de red por divisa.
        aEuros = aEuros or _cambioAEuros()
        acumulado.entrada(destino, dia, aEuros(_decimal(fila["total"]), fila["moneda_total"]))


def _serie(base: Decimal, dias: dict[datetime.date, list[Decimal]], hoy: datetime.date) -> list[dict]:
    """Puntos `{fecha, entradas, salidas, saldo}` ordenados, del día anterior al
    primer movimiento (solo el saldo de partida) hasta hoy."""
    saldo = base
    fechas = sorted(dias)
    puntos = []
    if fechas:
        puntos.append({"fecha": fechas[0] - datetime.timedelta(days=1), "entradas": _CERO, "salidas": _CERO, "saldo": saldo})
    for fecha in fechas:
        entradas, salidas = dias[fecha]
        saldo += entradas - salidas
        puntos.append({"fecha": fecha, "entradas": entradas, "salidas": salidas, "saldo": saldo})
    if not fechas or fechas[-1] < hoy:
        puntos.append({"fecha": hoy, "entradas": _CERO, "salidas": _CERO, "saldo": saldo})
    return puntos


def historicoSaldos(conn=None, hoy: datetime.date | None = None, aEuros: Callable | None = None) -> dict[str, list[dict]]:
    """Saldo día a día de cada cuenta: `{id: [{fecha, entradas, salidas, saldo}]}`.

    Solo hay punto en los días con movimientos, más uno de partida (el día
    anterior al primero) y otro hoy. Entre dos puntos el saldo no cambia. El
    último `saldo` coincide con el de `cuentas_store.saldos`.

    Args:
        conn: Conexión a la base de datos; por defecto la del portfolio activo.
        hoy: Fecha de corte; por defecto, hoy.
        aEuros: Conversión `(importe, moneda) -> Decimal` para los dividendos;
            por defecto, el cambio del día.

    Returns:
        Un diccionario con la serie de cada cuenta existente, en orden de fecha.
    """
    conn = conn or getDb()
    hoy = hoy or datetime.date.today()
    cuentas = listarCuentas(conn)
    acumulado = _Acumulador(cuentas)

    _transferencias(conn, acumulado, hoy)
    _filas(conn, acumulado, hoy)
    _recurrentes(conn, acumulado, hoy)
    _rendimientos(conn, acumulado, hoy, aEuros)

    return {c["id"]: _serie(acumulado.base[c["id"]], acumulado.porDia.get(c["id"], {}), hoy) for c in cuentas}


SIN_CATEGORIA = "Sin categoría"


def gastosPorCategoria(
    desde: datetime.date | None = None, conn=None, hoy: datetime.date | None = None
) -> list[dict]:
    """Lo gastado por categoría entre `desde` y hoy, de mayor a menor.

    Cuenta las filas de Gastos (su `tipo` es la categoría) y las mensualidades
    (su `categoria`), con el mismo criterio de día que el histórico: la fecha de
    la fila o el día 1 del mes, y nada posterior al mes en curso. Lo que no tiene
    fecha que se entienda solo entra cuando no hay `desde` (todo el histórico).

    Args:
        desde: Primer día del periodo; None para todo el histórico.
        conn: Conexión a la base de datos; por defecto la del portfolio activo.
        hoy: Fecha de corte; por defecto, hoy.

    Returns:
        `[{categoria, importe}]` con importe Decimal positivo, sin categorías a cero.
    """
    conn = conn or getDb()
    hoy = hoy or datetime.date.today()
    totales: dict[str, Decimal] = defaultdict(lambda: _CERO)

    def anotar(categoria: str, dia, importe: Decimal) -> None:
        if dia is False or not importe:
            return
        if dia is _SIN_DIA and desde is not None:
            return
        if dia is not _SIN_DIA and desde is not None and dia < desde:
            return
        totales[str(categoria or "").strip() or SIN_CATEGORIA] += importe

    for fila in conn.execute("SELECT year, month, fecha, tipo, cantidad FROM gastos_rows").fetchall():
        anotar(fila["tipo"], _diaDeMes(fila["year"], fila["month"], fila["fecha"], hoy), _decimal(fila["cantidad"]))

    columnas = ", ".join(["year", "categoria", *MONTH_KEYS])
    for fila in conn.execute(f"SELECT {columnas} FROM mensualidades").fetchall():
        for mes in MONTH_KEYS:
            if fila[mes]:
                anotar(fila["categoria"], _diaDeMes(fila["year"], mes, "", hoy), _decimal(fila[mes]))

    positivas = [(categoria, importe) for categoria, importe in totales.items() if importe > 0]
    return [
        {"categoria": categoria, "importe": importe}
        for categoria, importe in sorted(positivas, key=lambda par: (-par[1], par[0]))
    ]
