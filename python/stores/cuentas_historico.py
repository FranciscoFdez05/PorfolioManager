"""Histórico diario del saldo de cada cuenta, para las gráficas de la ventana Cuentas.

`cuentas_store.saldos` da el saldo de hoy; aquí se reparte ese mismo dinero en el
tiempo. Cada movimiento cae en su día, con la misma regla que `saldos`
(`cuentas_store._diaEfectivo`):

  * transferencias, gastos e ingresos llevan fecha dd-mm-aaaa y se colocan en ese
    día (si la fecha no casa con el mes de la fila, manda el mes: el día 1);
  * mensualidades e ingresos recurrentes solo tienen mes: cuentan su día de
    cobro, o el 1 si no lo tienen; intereses y dividendos, el día de su fecha si
    la tiene, o el 1 si solo dicen el mes;
  * lo que no tiene fecha que se entienda pero `saldos` cuenta igualmente (una
    transferencia «sin fecha», una fila con el mes mal escrito) va al punto de
    partida, junto al saldo inicial.

Lo que tiene un día posterior a hoy todavía no ha pasado y no cuenta. En una
cuenta con fecha de inicio, tampoco lo de ese día o anterior (ni lo que no
tiene día): su saldo inicial ya lo incluye.

`movimientosDetallados` recorre los mismos movimientos, uno a uno, para la
ventana de una cuenta: así su lista y su saldo tras cada movimiento cuadran por
construcción con la gráfica y con el saldo de la tarjeta.
"""

import datetime
from collections import defaultdict
from collections.abc import Callable
from decimal import Decimal

from core.centimos import importeSql
from core.db import getDb
from core.dinero import aTexto
from stores.cuentas_store import (
    ID_BANCO,
    MONTH_KEYS,
    _anioMes,
    _cambioAEuros,
    _columnasRecurrentes,
    _cuentaDeFila,
    _decimal,
    _diaCobroDelMes,
    _diaEfectivo,
    _excepcionesDeCuenta,
    _iniciosDe,
    _yearMonth,
    esAnteriorAlInicio,
    listarCuentas,
)

_CERO = Decimal(0)

# Movimientos sin día conocido que aun así forman parte del saldo.
_SIN_DIA = None

# Fecha de corte para recorrer también lo que todavía no ha pasado.
_SIN_LIMITE = datetime.date.max


class _Acumulador:
    """Entradas y salidas de cada cuenta por día, más lo que no tiene día."""

    def __init__(self, cuentas: list[dict]) -> None:
        self.existentes = {c["id"] for c in cuentas}
        self.base = {c["id"]: _decimal(c["saldo_inicial"]) for c in cuentas}
        self.inicios = _iniciosDe(cuentas)
        self.porDia: dict[str, dict[datetime.date, list[Decimal]]] = defaultdict(
            lambda: defaultdict(lambda: [_CERO, _CERO])
        )

    def entrada(self, cuentaId: str, dia: datetime.date | None, importe: Decimal, detalle: dict | None = None) -> None:
        self._anotar(cuentaId, dia, importe, 0, detalle)

    def salida(self, cuentaId: str, dia: datetime.date | None, importe: Decimal, detalle: dict | None = None) -> None:
        self._anotar(cuentaId, dia, importe, 1, detalle)

    def _anotar(
        self, cuentaId: str, dia: datetime.date | None, importe: Decimal, posicion: int, detalle: dict | None
    ) -> None:
        if cuentaId not in self.existentes or not importe:
            return
        anterior = esAnteriorAlInicio(self.inicios, cuentaId, dia)
        self._registrar(cuentaId, dia, importe, posicion, {**(detalle or {}), "anterior": anterior})
        if anterior:
            return
        if dia is _SIN_DIA:
            self.base[cuentaId] += importe if posicion == 0 else -importe
            return
        self.porDia[cuentaId][dia][posicion] += importe

    def _registrar(
        self, cuentaId: str, dia: datetime.date | None, importe: Decimal, posicion: int, detalle: dict
    ) -> None:
        """Gancho para guardar cada movimiento suelto; el histórico solo suma."""


class _Registro(_Acumulador):
    """Acumulador que además guarda cada movimiento de una cuenta, en el orden en
    que se anota, con su detalle (de dónde viene, concepto, categoría…)."""

    def __init__(self, cuentas: list[dict], cuentaId: str) -> None:
        super().__init__(cuentas)
        self.cuentaId = cuentaId
        self.movimientos: list[dict] = []

    def _registrar(
        self, cuentaId: str, dia: datetime.date | None, importe: Decimal, posicion: int, detalle: dict
    ) -> None:
        if cuentaId != self.cuentaId:
            return
        self.movimientos.append({
            **detalle,
            "dia": dia,
            "importe": importe,
            "kind": "entrada" if posicion == 0 else "salida",
        })


def _diaDeMes(year: str, month: str, fecha: str, hoy: datetime.date, diaCobro: str = "") -> datetime.date | bool | None:
    """Día en que cuenta una fila de año y mes.

    Devuelve False si ese día todavía no ha llegado (no cuenta), `_SIN_DIA` si
    el año o el mes no se entienden (`saldos` la cuenta igual) y si no el día
    (ver `cuentas_store._diaEfectivo`).
    """
    dia = _diaEfectivo(year, month, fecha, diaCobro)
    if dia is None:
        return _SIN_DIA
    return dia if dia <= hoy else False


def _transferencias(conn, acumulado: _Acumulador, hoy: datetime.date, nombres: dict) -> None:
    for fila in conn.execute(
        f"SELECT id, fecha, origen, destino, {importeSql('cantidad')} AS cantidad, "
        f"{importeSql('comision')} AS comision, concepto, nota FROM transferencias ORDER BY id"
    ).fetchall():
        year, month = _yearMonth(fila["fecha"])
        if year:
            dia = _diaDeMes(year, month, fila["fecha"], hoy)
            if dia is False:
                continue
        else:
            dia = _SIN_DIA
        importe = _decimal(fila["cantidad"])
        comun = {"id": fila["id"], "fecha": fila["fecha"], "nota": fila["nota"]}
        acumulado.entrada(fila["destino"], dia, importe, {
            **comun, "origen": "transferencia", "nombre": fila["concepto"],
            "contraparte_id": fila["origen"], "contraparte": nombres.get(fila["origen"], fila["origen"]),
        })
        detalleSalida = {
            **comun, "contraparte_id": fila["destino"], "contraparte": nombres.get(fila["destino"], fila["destino"]),
        }
        acumulado.salida(fila["origen"], dia, importe, {
            **detalleSalida, "origen": "transferencia", "nombre": fila["concepto"],
        })
        # La comisión es un movimiento propio: así se ve y se busca aparte.
        acumulado.salida(fila["origen"], dia, _decimal(fila["comision"]), {
            **detalleSalida, "origen": "comision",
            "nombre": f"Comisión · {fila['concepto']}" if fila["concepto"] else "Comisión",
        })


def _filas(conn, acumulado: _Acumulador, hoy: datetime.date) -> None:
    for tabla, anotar, origen in (
        ("ingresos_rows", acumulado.entrada, "ingreso"),
        ("gastos_rows", acumulado.salida, "gasto"),
    ):
        for fila in conn.execute(
            f"SELECT id, year, month, fecha, nombre, tipo, nota, {importeSql('cantidad')} AS cantidad, cuenta "
            f"FROM {tabla} ORDER BY id"
        ).fetchall():
            dia = _diaDeMes(fila["year"], fila["month"], fila["fecha"], hoy)
            if dia is not False:
                anotar(_cuentaDeFila(fila["cuenta"]), dia, _decimal(fila["cantidad"]), {
                    "origen": origen, "id": fila["id"], "fecha": fila["fecha"], "nombre": fila["nombre"],
                    "contraparte_id": "", "contraparte": fila["tipo"], "nota": fila["nota"],
                })


def _recurrentes(conn, acumulado: _Acumulador, hoy: datetime.date) -> None:
    for tabla, anotar, origen in (
        ("ingresos_recurrentes", acumulado.entrada, "recurrente"),
        ("mensualidades", acumulado.salida, "mensualidad"),
    ):
        for fila in conn.execute(f"SELECT {_columnasRecurrentes(tabla)} FROM {tabla} ORDER BY id").fetchall():
            habitual = _cuentaDeFila(fila["cuenta"])
            excepciones = _excepcionesDeCuenta(fila["cuentas_cobro"])
            for mes in MONTH_KEYS:
                if not fila[mes]:
                    continue
                dia = _diaDeMes(fila["year"], mes, "", hoy, _diaCobroDelMes(fila, mes))
                if dia is False:
                    continue
                destino = _cuentaDeFila(excepciones.get(mes)) if mes in excepciones else habitual
                # Igual que en `saldos`: una cuenta que ya no existe es la bancaria.
                if destino not in acumulado.existentes:
                    destino = ID_BANCO
                anotar(destino, dia, _decimal(fila[mes]), {
                    "origen": origen, "id": fila["id"], "fecha": "", "nombre": fila["nombre"],
                    "contraparte_id": "", "contraparte": fila["categoria"], "nota": fila["nota"],
                    "year": fila["year"], "month": mes,
                })


def _diaDeRendimiento(texto: str, hoy: datetime.date) -> datetime.date | bool | None:
    """Día de un interés o dividendo; False si no se entiende o aún no ha llegado,
    como en `cuentas_store._rendimientosEn`, que entonces no lo cuenta."""
    year, month = _anioMes(texto)
    if not year:
        return False
    return _diaDeMes(year, month, texto, hoy)


def _rendimientos(conn, acumulado: _Acumulador, hoy: datetime.date, aEuros: Callable | None) -> None:
    for fila in conn.execute(
        f"SELECT i.rowid AS id, v.cuenta_id, i.fecha, {importeSql('i.acumulado')} AS acumulado, "
        f"{importeSql('i.impuestos')} AS impuestos, COALESCE(r.nombre, '') AS remunerada FROM intereses_v2 i "
        "JOIN cuenta_remunerada_vinculo v ON v.remunerada_id = i.cuenta_id "
        "LEFT JOIN cuentas_remuneradas r ON r.id = i.cuenta_id ORDER BY i.rowid"
    ).fetchall():
        dia = _diaDeRendimiento(fila["fecha"], hoy)
        if dia is not False:
            acumulado.entrada(fila["cuenta_id"], dia, _decimal(fila["acumulado"]) - _decimal(fila["impuestos"]), {
                "origen": "interes", "id": fila["id"], "fecha": fila["fecha"], "nombre": "Intereses netos",
                "contraparte_id": "", "contraparte": fila["remunerada"], "nota": "",
            })

    cobra = conn.execute("SELECT id FROM cuentas WHERE dividendos = 1 ORDER BY sort_order, rowid").fetchone()
    # Los reinvertidos no entran en la cuenta (ver `cuentas_store`).
    for fila in conn.execute(
        f"SELECT rowid AS id, fecha, instrumento, {importeSql('total')} AS total, moneda_total, cuenta "
        "FROM dividendos WHERE reinvertido = 0 ORDER BY rowid"
    ).fetchall():
        destino = fila["cuenta"] if fila["cuenta"] in acumulado.existentes else (cobra["id"] if cobra else None)
        if destino is None:
            continue
        dia = _diaDeRendimiento(fila["fecha"], hoy)
        if dia is False:
            continue
        # El cambio se pide solo si hay algún dividendo que convertir: es una
        # llamada de red por divisa.
        aEuros = aEuros or _cambioAEuros()
        acumulado.entrada(destino, dia, aEuros(_decimal(fila["total"]), fila["moneda_total"]), {
            "origen": "dividendo", "id": fila["id"], "fecha": fila["fecha"], "nombre": fila["instrumento"],
            "contraparte_id": "", "contraparte": "Dividendos", "nota": "",
        })


def _recorrer(conn, acumulado: _Acumulador, hoy: datetime.date, aEuros: Callable | None, nombres: dict) -> None:
    """Anota en `acumulado` todo lo que mueve las cuentas hasta `hoy`."""
    _transferencias(conn, acumulado, hoy, nombres)
    _filas(conn, acumulado, hoy)
    _recurrentes(conn, acumulado, hoy)
    _rendimientos(conn, acumulado, hoy, aEuros)


def _serie(
    base: Decimal, dias: dict[datetime.date, list[Decimal]], hoy: datetime.date, inicio: datetime.date | None = None
) -> list[dict]:
    """Puntos `{fecha, entradas, salidas, saldo}` ordenados, del punto de
    partida (solo el saldo inicial) hasta hoy. La partida es la fecha de inicio
    de la cuenta si la tiene, o el día anterior al primer movimiento."""
    saldo = base
    fechas = sorted(dias)
    puntos = []
    if inicio is not None:
        puntos.append({"fecha": min(inicio, hoy), "entradas": _CERO, "salidas": _CERO, "saldo": saldo})
    elif fechas:
        puntos.append({"fecha": fechas[0] - datetime.timedelta(days=1), "entradas": _CERO, "salidas": _CERO, "saldo": saldo})
    for fecha in fechas:
        entradas, salidas = dias[fecha]
        saldo += entradas - salidas
        puntos.append({"fecha": fecha, "entradas": entradas, "salidas": salidas, "saldo": saldo})
    if not puntos or puntos[-1]["fecha"] < hoy:
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
    _recorrer(conn, acumulado, hoy, aEuros, {})
    return {
        c["id"]: _serie(acumulado.base[c["id"]], acumulado.porDia.get(c["id"], {}), hoy, acumulado.inicios.get(c["id"]))
        for c in cuentas
    }


def _ordenCronologico(movimiento: dict) -> tuple:
    # Lo que no tiene día va primero: forma parte del saldo de partida. Dentro
    # de un mismo día no se sabe la hora, así que las entradas van antes que las
    # salidas: el saldo intermedio no baja de cero por un orden que no existió.
    dia = movimiento["dia"]
    entra = 0 if movimiento["kind"] == "entrada" else 1
    return (0, datetime.date.min, entra) if dia is _SIN_DIA else (1, dia, entra)


def movimientosDetallados(
    cuentaId: str, conn=None, hoy: datetime.date | None = None, aEuros: Callable | None = None
) -> list[dict]:
    """Todo lo que mueve una cuenta, uno a uno y en orden, con el saldo tras cada uno.

    Incluye ingresos y gastos sueltos, mensualidades, ingresos recurrentes,
    transferencias (y su comisión, aparte), intereses y dividendos, también los
    que todavía no han llegado (`pendiente`), que no mueven el saldo de hoy pero
    sí el previsto. El `saldo` del último no pendiente es el de
    `cuentas_store.saldos`.

    Args:
        cuentaId: Identificador de la cuenta.
        conn: Conexión a la base de datos; por defecto la del portfolio activo.
        hoy: Fecha de corte; por defecto, hoy.
        aEuros: Conversión `(importe, moneda) -> Decimal` para los dividendos.

    Returns:
        Lista cronológica de diccionarios con `origen` (ingreso, gasto,
        mensualidad, recurrente, transferencia, comision, interes, dividendo),
        `kind` (entrada o salida), `cantidad`, `saldo` (textos canónicos),
        `dia` (aaaa-mm-dd, vacío si no tiene), `year`, `month`, `pendiente`,
        `anterior` (de antes de la fecha de inicio de la cuenta: no cuenta y
        su `saldo` va vacío) y el detalle de su origen (`id`, `fecha`,
        `nombre`, `contraparte`, `nota`).
    """
    conn = conn or getDb()
    hoy = hoy or datetime.date.today()
    cuentas = listarCuentas(conn)
    cuenta = next((c for c in cuentas if c["id"] == cuentaId), None)
    if cuenta is None:
        return []
    registro = _Registro(cuentas, cuentaId)
    _recorrer(conn, registro, _SIN_LIMITE, aEuros, {c["id"]: c["nombre"] for c in cuentas})

    saldo = _decimal(cuenta["saldo_inicial"])
    resultado = []
    for orden, movimiento in enumerate(sorted(registro.movimientos, key=_ordenCronologico)):
        dia = movimiento["dia"]
        anterior = movimiento["anterior"]
        # Lo anterior al inicio se enseña, pero no mueve el saldo: ya está en el inicial.
        if not anterior:
            saldo += movimiento["importe"] if movimiento["kind"] == "entrada" else -movimiento["importe"]
        year = movimiento.get("year") or (f"{dia.year:04d}" if dia else "")
        month = movimiento.get("month") or (MONTH_KEYS[dia.month - 1] if dia else "")
        resultado.append({
            **{k: v for k, v in movimiento.items() if k not in ("dia", "importe")},
            "orden": orden,
            "dia": dia.isoformat() if dia else "",
            "fecha": movimiento.get("fecha") or (dia.strftime("%d-%m-%Y") if dia else ""),
            "year": year,
            "month": month,
            "cantidad": aTexto(movimiento["importe"], decimales=2),
            "saldo": "" if anterior else aTexto(saldo, decimales=2),
            "pendiente": not anterior and dia is not _SIN_DIA and dia > hoy,
        })
    return resultado


SIN_CATEGORIA = "Sin categoría"


def gastosPorCategoria(
    desde: datetime.date | None = None, conn=None, hoy: datetime.date | None = None
) -> list[dict]:
    """Lo gastado por categoría entre `desde` y hoy, de mayor a menor.

    Cuenta las filas de Gastos (su `tipo` es la categoría) y las mensualidades
    (su `categoria`), con el mismo criterio de día que el histórico: la fecha de
    la fila, su día de cobro o el día 1 del mes, y nada posterior a hoy. Lo que
    no tiene fecha que se entienda solo entra cuando no hay `desde` (todo el
    histórico).

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

    for fila in conn.execute(
        f"SELECT year, month, fecha, tipo, {importeSql('cantidad')} AS cantidad FROM gastos_rows"
    ).fetchall():
        anotar(fila["tipo"], _diaDeMes(fila["year"], fila["month"], fila["fecha"], hoy), _decimal(fila["cantidad"]))

    for fila in conn.execute(f"SELECT {_columnasRecurrentes('mensualidades')} FROM mensualidades").fetchall():
        for mes in MONTH_KEYS:
            if fila[mes]:
                dia = _diaDeMes(fila["year"], mes, "", hoy, _diaCobroDelMes(fila, mes))
                anotar(fila["categoria"], dia, _decimal(fila[mes]))

    positivas = [(categoria, importe) for categoria, importe in totales.items() if importe > 0]
    return [
        {"categoria": categoria, "importe": importe}
        for categoria, importe in sorted(positivas, key=lambda par: (-par[1], par[0]))
    ]
