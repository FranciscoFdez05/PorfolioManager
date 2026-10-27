"""Lista los snapshots del histórico que parecen mal valorados. No borra nada.

    python tools/detectar_snapshots_erroneos.py data/portfolios/principal.db
    python tools/detectar_snapshots_erroneos.py principal.db --desde 2026-10-26 --hasta 2026-10-27
    python tools/detectar_snapshots_erroneos.py principal.db --tolerancia 0.05 --maximo 120

Dos criterios, y un punto es candidato solo si falla el primero, o el segundo
**con el invertido también discrepante**:

1. **Invertido reconstruido (el fiable).** El servidor sabe reconstruir las
   posiciones de cada día con las operaciones (ficha, Operaciones, ventas,
   transacciones y conversiones). Para cada día se calcula el invertido neto que
   debía tener la cartera (el que enseña la ficha de cada activo) y se compara
   con el `total_invested` guardado en el snapshot. Un snapshot mal valorado
   (por ejemplo, por una valoración que no contaba transacciones ni
   conversiones) guarda un invertido que no cuadra: 73.050 € frente a unos
   106.800 € reales. Se agrupan los puntos seguidos que discrepan más de
   `--tolerancia` (5 %) en **tramos**, y un tramo es candidato si dura como mucho
   `--maximo` puntos y está rodeado por puntos que sí cuadran.
2. **Nivel respecto a la zona.** El criterio de la versión anterior: un tramo de
   nivel distinto al de las 6 horas de alrededor. Por sí solo daba falsos
   positivos cuando los puntos malos dominaban una zona, así que ya no basta: se
   exige que además discrepe el invertido.

Operaciones retroactivas. Una operación apuntada hoy con fecha antigua cambia el
invertido reconstruido de todos los días desde esa fecha, pero no el de los
snapshots que ya se guardaron sin ella. Esos puntos discrepan, pero de forma
continua durante días y no están rodeados de puntos que cuadren por los dos
lados; por eso el requisito de "tramo corto y rodeado" los deja fuera. Lo que sí
queda marcado es una racha corta intercalada entre puntos buenos, que es la
firma de un error de valoración. Si una operación retroactiva se apunta y se
borra poco después, podría aparecer un tramo corto: por eso esto lista
candidatos y no borra.

El invertido se reconstruye con el último cambio de divisa guardado en la propia
base (`fx_rates`), sin red. Solo abre la base en modo lectura.

Códigos de salida: 0 si no hay candidatos, 1 si los hay, 2 si falla algo.
"""

import argparse
import sqlite3
import statistics
import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from stores import rendimiento_activo as posiciones_


def _abrir(ruta: Path):
    conexion = sqlite3.connect(f"file:{ruta.resolve().as_posix()}?mode=ro", uri=True)
    conexion.row_factory = sqlite3.Row
    return conexion


def _leerPuntos(conexion) -> list:
    """Puntos `(ts, total_value, total_invested)` ordenados."""
    return [
        (f["ts"], f["total_value"], f["total_invested"])
        for f in conexion.execute(
            "SELECT ts, total_value, total_invested FROM portfolio_snapshots ORDER BY ts"
        )
    ]


def _desviacion(valor: float, referencia: float) -> float:
    return abs(valor - referencia) / max(abs(referencia), 1.0)


# ── criterio de nivel ────────────────────────────────────────────────────────

def _tramos(puntos: list, cambio: float = 0.08) -> list:
    """Agrupa los índices en tramos consecutivos de nivel parecido."""
    tramos = []
    actual = []
    for indice, (_ts, total, _invertido) in enumerate(puntos):
        if actual and _desviacion(total, puntos[indice - 1][1]) > cambio:
            tramos.append(actual)
            actual = []
        actual.append(indice)
    if actual:
        tramos.append(actual)
    return tramos


def detectar(puntos: list, umbral: float = 0.25, maximo: int = 120, contexto: float = 6) -> list:
    """Índices de los puntos en tramos cortos de nivel distinto al de la zona."""
    tramos = _tramos(puntos)
    indices = set()
    for numero in range(1, len(tramos) - 1):
        antes = puntos[tramos[numero - 1][-1]][1]
        despues = puntos[tramos[numero + 1][0]][1]
        if _desviacion(antes, despues) > 0.10:
            continue  # la cartera cambió de nivel y se quedó
        tramo = tramos[numero]
        if len(tramo) > maximo:
            continue
        inicio = puntos[tramo[0]][0] - contexto * 3600
        fin = puntos[tramo[-1]][0] + contexto * 3600
        alrededor = [p[1] for p in puntos if inicio <= p[0] <= fin]
        if len(alrededor) < 8:
            continue
        esperado = statistics.median(alrededor)
        if _desviacion(statistics.median(puntos[i][1] for i in tramo), esperado) > umbral:
            indices.update(tramo)
    return sorted(indices)


# ── criterio del invertido reconstruido ──────────────────────────────────────

def _tipoDeLaBase(conexion):
    """Función `(desde, hacia) -> Decimal | None` con el último cambio guardado en la base."""
    tasas = {}
    try:
        for fila in conexion.execute("SELECT par, rate FROM fx_rates WHERE rate <> '' ORDER BY fecha"):
            origen = fila["par"].split("/")[0]
            tasas[origen] = Decimal(fila["rate"])  # el último por fecha queda el último
    except (sqlite3.Error, ArithmeticError):
        pass

    def aEuros(moneda):
        codigo = str(moneda or "EUR").strip().upper() or "EUR"
        return Decimal("1") if codigo == "EUR" else tasas.get(codigo)

    def tipo(desde, hacia):
        origen, destino = aEuros(desde), aEuros(hacia)
        if origen is None or destino is None or destino <= 0:
            return None
        return origen / destino

    return tipo


def _hasta(filas: list, columna: str, dia: date) -> list:
    """Filas con fecha hasta `dia`, más las de fecha ilegible.

    `lotesVivos(hasta=)` descartaría las filas sin fecha legible, pero el servidor
    las cuenta al final de la línea temporal y por tanto están en el
    `total_invested` guardado: dejarlas fuera haría discrepar a todos los puntos.
    """
    return [f for f in filas if posiciones_._fechaOrden(f[columna]) <= dia or posiciones_._fechaOrden(f[columna]) == date.max]


def invertidoReconstruido(posiciones: dict, activos: dict, dia: date, tipo) -> float:
    """Invertido neto en euros que debía tener la cartera al final de `dia`."""
    total = Decimal("0")
    for assetId, datos in posiciones.items():
        activo = activos.get(assetId)
        if activo is None:
            continue
        esCripto = str(activo["type"] or "").strip().lower() == "cripto"
        moneda = str(activo["currency"] or "EUR").strip().upper() or "EUR"
        filas = _hasta(datos["filas"], "fecha_operacion", dia)
        operaciones = _hasta(datos["operaciones"], "fecha_apertura", dia)
        lotes = posiciones_.lotesVivos(
            filas, operaciones, esCripto, _hasta(datos["ventas"], "fecha", dia), None,
            _hasta(datos["transacciones"], "fecha_operacion", dia),
            _hasta(datos["conversiones"], "fecha", dia), moneda, tipo,
        )
        if not any(lote["cantidad"] > 0 for lote in lotes):
            continue
        neto = sum((lote["coste"] for lote in lotes), Decimal("0")) - posiciones_.comisionesFiat(
            filas, operaciones, esCripto, moneda, tipo
        )
        cambio = tipo(moneda, "EUR")
        total += neto * (cambio if cambio is not None else Decimal("1"))
    return float(total)


def detectarPorInvertido(puntos: list, reconstruido: dict, tolerancia: float = 0.05, maximo: int = 120) -> list:
    """Tramos `(indices, resumen)` cortos y rodeados de puntos que sí cuadran, donde el invertido no cuadra."""
    discrepancia = []
    for ts, _total, invertido in puntos:
        esperado = reconstruido.get(datetime.fromtimestamp(ts).date())
        discrepancia.append(None if not esperado or esperado <= 0 else invertido / esperado - 1)

    def malo(i):
        return discrepancia[i] is not None and abs(discrepancia[i]) > tolerancia

    def bueno(i):
        return discrepancia[i] is not None and abs(discrepancia[i]) <= tolerancia

    tramos = []
    i = 0
    while i < len(puntos):
        if not malo(i):
            i += 1
            continue
        j = i
        while j + 1 < len(puntos) and malo(j + 1):
            j += 1
        if i > 0 and j + 1 < len(puntos) and bueno(i - 1) and bueno(j + 1) and (j - i + 1) <= maximo:
            tramos.append((list(range(i, j + 1)), discrepancia))
        i = j + 1
    return tramos


# ── resultado ────────────────────────────────────────────────────────────────

def detectarCandidatos(conexion, tolerancia: float = 0.05, maximo: int = 120, umbral: float = 0.25) -> list:
    """Candidatos agrupados en tramos: `{puntos, motivo, ...}` ordenados por fecha."""
    puntos = _leerPuntos(conexion)
    activos = {f["id"]: f for f in conexion.execute("SELECT id, type, currency FROM activos")}
    posiciones = posiciones_.cargarPosiciones(conexion)
    tipo = _tipoDeLaBase(conexion)

    dias = sorted({datetime.fromtimestamp(p[0]).date() for p in puntos})
    reconstruido = {dia: invertidoReconstruido(posiciones, activos, dia, tipo) for dia in dias}

    porInvertido = detectarPorInvertido(puntos, reconstruido, tolerancia, maximo)
    discrepancia = {}
    for indices, tabla in porInvertido:
        for indice in indices:
            discrepancia[indice] = tabla[indice]

    # El criterio de nivel solo cuenta si el invertido también discrepa.
    porNivel = {
        i for i in detectar(puntos, umbral, maximo)
        if _discrepa(puntos[i], reconstruido, tolerancia)
    }
    todos = sorted(set(discrepancia) | porNivel)

    resultado = []
    grupo = []
    for indice in todos:
        if grupo and (indice != grupo[-1] + 1):
            resultado.append(_describir(grupo, puntos, reconstruido, discrepancia, porNivel))
            grupo = []
        grupo.append(indice)
    if grupo:
        resultado.append(_describir(grupo, puntos, reconstruido, discrepancia, porNivel))
    return resultado


def _discrepa(punto, reconstruido, tolerancia) -> bool:
    esperado = reconstruido.get(datetime.fromtimestamp(punto[0]).date())
    return bool(esperado and esperado > 0 and abs(punto[2] / esperado - 1) > tolerancia)


def _describir(indices, puntos, reconstruido, discrepancia, porNivel) -> dict:
    tramo = [puntos[i] for i in indices]
    esperado = reconstruido.get(datetime.fromtimestamp(tramo[0][0]).date())
    criterios = []
    if any(i in discrepancia or i in porNivel for i in indices):
        # Por nivel solo se llega si el invertido también discrepa, así que se cita siempre.
        criterios.append(
            f"invertido guardado {statistics.median(p[2] for p in tramo):,.0f} frente a {esperado:,.0f} reconstruido"
        )
    if any(i in porNivel for i in indices):
        criterios.append("total de otro nivel que su zona")
    return {
        "desde": tramo[0][0], "hasta": tramo[-1][0], "puntos": len(tramo),
        "totalMediano": statistics.median(p[1] for p in tramo),
        "invertidoMediano": statistics.median(p[2] for p in tramo),
        "invertidoEsperado": esperado, "motivo": "; ".join(criterios),
    }


def _fecha(texto: str) -> date:
    return datetime.strptime(texto, "%Y-%m-%d").date()


def main(argumentos=None) -> int:
    parser = argparse.ArgumentParser(description="Lista snapshots mal valorados (no borra nada).")
    parser.add_argument("base", type=Path, help="ruta del .db de la cartera")
    parser.add_argument("--tolerancia", type=float, default=0.05, help="discrepancia del invertido que se tolera (0,05)")
    parser.add_argument("--umbral", type=float, default=0.25, help="desviación de nivel del total (0,25)")
    parser.add_argument("--maximo", type=int, default=120, help="puntos que puede durar un tramo erróneo (120)")
    parser.add_argument("--desde", type=_fecha, help="solo tramos desde esta fecha (AAAA-MM-DD)")
    parser.add_argument("--hasta", type=_fecha, help="solo tramos hasta esta fecha, incluida (AAAA-MM-DD)")
    opciones = parser.parse_args(argumentos)

    if not opciones.base.is_file():
        print(f"No existe {opciones.base}", file=sys.stderr)
        return 2
    try:
        conexion = _abrir(opciones.base)
        try:
            tramos = detectarCandidatos(conexion, opciones.tolerancia, opciones.maximo, opciones.umbral)
            total = conexion.execute("SELECT COUNT(*) FROM portfolio_snapshots").fetchone()[0]
        finally:
            conexion.close()
    except sqlite3.Error as error:
        print(f"No se pudo leer {opciones.base}: {error}", file=sys.stderr)
        return 2

    if opciones.desde:
        tramos = [t for t in tramos if datetime.fromtimestamp(t["desde"]).date() >= opciones.desde]
    if opciones.hasta:
        tramos = [t for t in tramos if datetime.fromtimestamp(t["desde"]).date() <= opciones.hasta]

    puntos = sum(t["puntos"] for t in tramos)
    print(f"{opciones.base}: {total} snapshots, {len(tramos)} tramos candidatos ({puntos} puntos). "
          "No se ha borrado nada.")
    if tramos:
        print(f"{'desde':<17} {'hasta':<17} {'puntos':>6} {'total':>12} {'invertido':>12} {'reconstr.':>12}  motivo")
        for t in tramos:
            desde = datetime.fromtimestamp(t["desde"]).strftime("%Y-%m-%d %H:%M")
            hasta = datetime.fromtimestamp(t["hasta"]).strftime("%Y-%m-%d %H:%M")
            print(f"{desde:<17} {hasta:<17} {t['puntos']:>6} {t['totalMediano']:12,.0f} "
                  f"{t['invertidoMediano']:12,.0f} {t['invertidoEsperado']:12,.0f}  {t['motivo']}")
    return 1 if tramos else 0


if __name__ == "__main__":
    sys.exit(main())
