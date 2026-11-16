"""Sincroniza las deudas con la tabla `mensualidades`.

Las compras financiadas, las hipotecas y los microcréditos se pagan en fechas
conocidas, así que cada pago se cobra como una mensualidad más: descuenta de su
cuenta, suma en las métricas y en Ahorro, y aparece en el calendario sin que
saldos, histórico ni categorías tengan que conocer las deudas.

Las filas generadas llevan `financiacion_id` y son del servidor: el formulario de
Mensualidades no las guarda (`sanitizeMensualidadesRows` las descarta) y aquí se
regeneran enteras cada vez que cambia una deuda o se guarda un año. Regenerar
en vez de parchear evita que un pago editado a mano quede desfasado del cuadro.

El id de la fila indica de dónde viene: el de la compra financiada va tal cual
(así eran las filas anteriores a las hipotecas) y los demás con prefijo
(`hipoteca:`, `microcredito:`). Una sola tabla y un solo borrado por año:
repartir esto en tres módulos haría que cada uno borrase las filas de los otros.
"""

import json
import logging
from datetime import date
from decimal import Decimal
from typing import NamedTuple

from core.amortizacion import AmortizacionInvalida
from core.centimos import columnasConCent, escribirImporte, leerImporte
from core.dinero import aDecimal, aTextoEs
from core.financiaciones import diaDeCobro, generarCuadroDeCompra
from core.hipotecas import generarCuadroDeHipoteca
from core.microcreditos import fechaDePagoUnico, generarCuadroDeMicrocredito, modoUnico
from stores import revisiones
from stores.cuentas_store import cuentasValidasParaFilas, normalizarCuentaDeFila
from stores.financiaciones_store import listarFinanciaciones
from stores.gastos_store import MONTH_KEYS
from stores.hipotecas_store import listarHipotecas
from stores.microcreditos_store import listarMicrocreditos

log = logging.getLogger(__name__)

origenFinanciada = "financiada"
origenHipoteca = "hipoteca"
origenMicrocredito = "microcredito"

_prefijos = {origenHipoteca: "hipoteca:", origenMicrocredito: "microcredito:"}
_sufijosNombre = {
    origenFinanciada: " (financiada)",
    origenHipoteca: " (hipoteca)",
    origenMicrocredito: " (microcrédito)",
}
_columnas = (
    "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
    "septiembre", "octubre", "noviembre", "diciembre",
)


class Pago(NamedTuple):
    """Un pago de una deuda: lo que sale de la cuenta en una fecha.

    Attributes:
        fecha: Fecha del recibo; fija el mes y el año en que cae.
        cuota: Importe del recibo.
        extra: Pago anticipado que sale del bolsillo ese mismo mes.
        dia: Día del mes en que se carga.
    """

    fecha: date
    cuota: Decimal
    extra: Decimal
    dia: int


def origenDeFila(financiacionId: str) -> str:
    """De qué tipo de deuda viene una fila de mensualidades generada.

    Args:
        financiacionId: Valor de `financiacion_id` de la fila.

    Returns:
        `"hipoteca"`, `"microcredito"`, `"financiada"` (cualquier otro id no
        vacío) o `""` si la fila no está generada.
    """
    if not financiacionId:
        return ""
    for origen, prefijo in _prefijos.items():
        if financiacionId.startswith(prefijo):
            return origen
    return origenFinanciada


def _idDeFila(origen: str, idDeuda: str) -> str:
    return _prefijos.get(origen, "") + idDeuda


def _nombreUnico(base: str, usados: set[str]) -> str:
    """Nombre libre en el año: la tabla exige (year, nombre) único."""
    nombre = base
    contador = 2
    while nombre.lower() in usados:
        nombre = f"{base} ({contador})"
        contador += 1
    usados.add(nombre.lower())
    return nombre


def _pagosDeRecibos(recibos, referencia: dict) -> list[Pago]:
    return [Pago(r.fecha, r.cuota, r.extra, diaDeCobro(referencia, r)) for r in recibos]


def _diaHabitual(deuda: dict) -> str:
    """Día pedido o, en su defecto, el de la fecha de inicio."""
    return str(int(deuda["diaCobro"] or deuda["fechaInicio"][8:10]))


def _filasDePagos(origen: str, deuda: dict, nombre: str, pagos: list[Pago], diaHabitual: str,
                  validas: set[str]) -> dict[str, dict]:
    """Una fila de mensualidad por año, con los pagos de la deuda en su mes."""
    pagosPorAnio: dict[str, list[Pago]] = {}
    for pago in pagos:
        pagosPorAnio.setdefault(str(pago.fecha.year), []).append(pago)

    filas = {}
    for anio, delAnio in pagosPorAnio.items():
        meses = dict.fromkeys(MONTH_KEYS, "")
        dias = {}
        for pago in delAnio:
            clave = MONTH_KEYS[pago.fecha.month - 1]
            # Un pago anticipado sale del bolsillo ese mismo mes: va con la cuota.
            meses[clave] = aTextoEs(pago.cuota + pago.extra) + " €"
            # Solo los meses con un día distinto del habitual (30 de febrero) se
            # anotan como excepción, para que la vista de Mensualidades no avise
            # de «meses aparte» en todos.
            if str(pago.dia) != diaHabitual:
                dias[clave] = str(pago.dia)
        filas[anio] = {
            "financiacionId": _idDeFila(origen, deuda["id"]),
            "origen": origen,
            "nombre": nombre,
            "categoria": deuda["categoria"],
            "importe": aTextoEs(delAnio[0].cuota) + " €",
            "diaCobro": diaHabitual,
            "diasCobro": json.dumps(dias, sort_keys=True) if dias else "",
            "mesInicio": MONTH_KEYS[delAnio[0].fecha.month - 1],
            "nota": deuda["nota"],
            "cuenta": normalizarCuentaDeFila(deuda["cuenta"], validas),
            "meses": meses,
        }
    return filas


def _filasDeFinanciadas(compras: list[dict], validas: set[str]):
    for compra in compras:
        try:
            cuadro = generarCuadroDeCompra(compra)
        except AmortizacionInvalida as error:
            log.warning("Compra %s sin cuadro, no se sincroniza: %s", compra["id"], error)
            continue
        yield _filasDePagos(origenFinanciada, compra, compra["articulo"],
                            _pagosDeRecibos(cuadro, compra), _diaHabitual(compra), validas)


def _filasDeHipotecas(hipotecas: list[dict], validas: set[str]):
    for hipoteca in hipotecas:
        try:
            cuadro = generarCuadroDeHipoteca(hipoteca)
        except AmortizacionInvalida as error:
            log.warning("Hipoteca %s sin cuadro, no se sincroniza: %s", hipoteca["id"], error)
            continue
        yield _filasDePagos(origenHipoteca, hipoteca, hipoteca["alias"],
                            _pagosDeRecibos(cuadro, hipoteca), _diaHabitual(hipoteca), validas)


def _filasDeMicrocreditos(microcreditos: list[dict], validas: set[str]):
    for microcredito in microcreditos:
        if microcredito["modo"] == modoUnico:
            fecha = fechaDePagoUnico(microcredito)
            total = (aDecimal(microcredito["importe"], "importe")
                     + aDecimal(microcredito["comision"], "comision"))
            pagos = [Pago(fecha, total, Decimal(0), fecha.day)]
            habitual = str(fecha.day)
        else:
            try:
                cuadro = generarCuadroDeMicrocredito(microcredito)
            except AmortizacionInvalida as error:
                log.warning("Microcrédito %s sin cuadro, no se sincroniza: %s", microcredito["id"], error)
                continue
            pagos = _pagosDeRecibos(cuadro, microcredito)
            habitual = _diaHabitual(microcredito)
        yield _filasDePagos(origenMicrocredito, microcredito, microcredito["nombre"], pagos, habitual, validas)


def _filasPorAnio(conn) -> dict[str, list[dict]]:
    """Filas de mensualidad de todas las deudas, agrupadas por año."""
    validas = cuentasValidasParaFilas(conn)
    porAnio: dict[str, list[dict]] = {}
    generadores = (
        _filasDeFinanciadas(listarFinanciaciones(conn), validas),
        _filasDeHipotecas(listarHipotecas(conn), validas),
        _filasDeMicrocreditos(listarMicrocreditos(conn), validas),
    )
    for generador in generadores:
        for filasDeUnaDeuda in generador:
            for anio, fila in filasDeUnaDeuda.items():
                porAnio.setdefault(anio, []).append(fila)
    return porAnio


def _firma(filas) -> list[tuple]:
    return sorted(tuple(fila) for fila in filas)


def _reescribirAnio(conn, anio: str, filas: list[dict]) -> bool:
    """Deja en `anio` exactamente las filas generadas indicadas.

    Returns:
        `True` si algo cambió; así un guardado sin cambios no hace avanzar la
        revisión del año ni obliga a otras pestañas a fusionar.
    """
    campos = ("financiacion_id, nombre, categoria, importe, importe_cent, dia_cobro, dias_cobro, mes_inicio, "
              f"nota, cuenta, {columnasConCent(_columnas)}")
    # Se compara como texto de presentación: lo guardado en céntimos y lo
    # generado (ya formateado) tienen que dar la misma cadena, o cada guardado
    # reescribiría las cuotas y avanzaría la revisión del año.
    actuales = [
        (f["financiacion_id"], f["nombre"], f["categoria"], leerImporte(f["importe_cent"], f["importe"]),
         f["dia_cobro"], f["dias_cobro"], f["mes_inicio"], f["nota"], f["cuenta"],
         *(leerImporte(f[f"{mes}_cent"], f[mes]) for mes in _columnas))
        for f in conn.execute(
            f"SELECT {campos} FROM mensualidades WHERE year = ? AND financiacion_id != ''", (anio,)
        ).fetchall()
    ]

    usados = {f["nombre"].lower() for f in conn.execute(
        "SELECT nombre FROM mensualidades WHERE year = ? AND financiacion_id = ''", (anio,))}
    nuevas = []
    for fila in filas:
        nombre = _nombreUnico(fila["nombre"], usados) if fila["nombre"].lower() not in usados \
            else _nombreUnico(fila["nombre"] + _sufijosNombre[fila["origen"]], usados)
        nuevas.append((
            fila["financiacionId"], nombre, fila["categoria"], fila["importe"], fila["diaCobro"],
            fila["diasCobro"], fila["mesInicio"], fila["nota"], fila["cuenta"],
            *(fila["meses"][mes] for mes in MONTH_KEYS),
        ))

    if _firma(actuales) == _firma(nuevas):
        return False

    conn.execute("DELETE FROM mensualidades WHERE year = ? AND financiacion_id != ''", (anio,))
    columnasCent = ", ".join(f"{mes}_cent" for mes in _columnas)
    filasNuevas = []
    for fila in nuevas:
        importeCent, importeLegado = escribirImporte(fila[3])
        mesesEscritos = [escribirImporte(valor) for valor in fila[9:]]
        filasNuevas.append((
            anio, *fila[:3], importeLegado, importeCent, *fila[4:9],
            *(legado for _cent, legado in mesesEscritos), *(cent for cent, _legado in mesesEscritos),
        ))
    conn.executemany(
        f"INSERT INTO mensualidades (year, activa, frecuencia, financiacion_id, nombre, categoria, importe, "
        f"importe_cent, dia_cobro, dias_cobro, mes_inicio, nota, cuenta, {', '.join(_columnas)}, {columnasCent}) "
        f"VALUES (?, 1, 'mensual', {', '.join('?' * (10 + 2 * len(_columnas)))})",
        filasNuevas,
    )
    return True


def sincronizarAnio(conn, anio: str, bumpRevision: bool = False) -> bool:
    """Regenera las filas generadas de un año ya existente.

    Lo llama `writeGastosYear` tras guardar las mensualidades del usuario, antes
    de avanzar la revisión (por eso `bumpRevision` es `False` por defecto).
    """
    filas = _filasPorAnio(conn).get(anio, [])
    cambio = _reescribirAnio(conn, anio, filas)
    if cambio and bumpRevision:
        revisiones.avanzar(conn, "gastos", anio)
    return cambio


def sincronizarTodo(conn) -> None:
    """Regenera las filas generadas de todos los años tras cambiar una deuda.

    Se crean los años que faltan entre el primer cobro y el año actual: sin su
    año, los cobros pasados no descontarían de ninguna cuenta. Los años futuros
    no se crean (saldrían en el selector de años sin que nadie los haya pedido);
    se rellenan al crearlos, porque su guardado pasa por `sincronizarAnio`.
    """
    porAnio = _filasPorAnio(conn)

    hoy = date.today().year
    existentes = {f["year"] for f in conn.execute("SELECT year FROM gastos_years")}
    for anio in porAnio:
        if anio not in existentes and int(anio) <= hoy:
            conn.execute("INSERT OR IGNORE INTO gastos_years (year) VALUES (?)", (anio,))
            existentes.add(anio)

    for anio in sorted(existentes):
        if _reescribirAnio(conn, anio, porAnio.get(anio, [])):
            revisiones.avanzar(conn, "gastos", anio)
