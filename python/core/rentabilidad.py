"""Rentabilidad y riesgo a partir del histórico de snapshots.

Modified Dietz (que vive en el frontend, en el gráfico de rentabilidad anual)
ya corrige el sesgo de las aportaciones dentro de un año. Lo que falta encima
son las dos medidas que cuentan historias distintas y complementarias:

  * **TWR** (time-weighted return): encadena el rendimiento de cada subperiodo
    entre snapshots quitándole el flujo, así que mide *la cartera* sin que las
    aportaciones la distorsionen. Es la cifra comparable contra un índice.
  * **XIRR**: la TIR de los flujos reales con sus fechas. Mide *tu dinero*: si
    aportaste fuerte justo antes de una subida, la XIRR sube y la TWR no.

Con la serie encadenada salen casi gratis el máximo drawdown y la volatilidad,
que hay que calcular sobre el índice TWR y **no** sobre el valor de la cartera:
una retirada de 5.000 € hunde el valor sin que se haya perdido nada, y saldría
como una caída del 30 % que nunca existió.

El flujo de cada periodo es el dinero que de verdad entró o salió: cada snapshot
guarda el suyo (`f`, ver stores/flujos_snapshot.py), con las compras con
comisión y las ventas cobradas netas, en euros y con el tipo de cambio de cada
operación. Donde no hay (los puntos anteriores a guardarlo, o un tramo con una
operación que no se pudo convertir) se estima con la variación del invertido,
que es un coste y no dinero, y el tramo sale marcado como estimado. TWR, XIRR y
Dietz (en el navegador) usan los mismos flujos por tramo para no contradecirse.
"""

import datetime
import math
from itertools import pairwise

# Días de año usados para anualizar. 365 y no 252 (los días hábiles de bolsa)
# porque la cartera lleva cripto, que cotiza también fines de semana, y los
# snapshots se guardan por reloj, no por sesión de mercado.
DIAS_ANIO = 365

# Por debajo de un año, anualizar convierte una racha de dos semanas en un
# número de tres cifras. Se deja sin anualizar y que lo diga la UI.
MINIMO_DIAS_ANUALIZAR = 365

# Con menos de esto la desviación típica es ruido, no volatilidad.
MINIMO_MUESTRAS_VOLATILIDAD = 5


def _dia(ts):
    """Fecha local del timestamp. Local y no UTC para cuadrar con el frontend,
    que agrupa por año con `new Date(ts * 1000).getFullYear()`."""
    return datetime.date.fromtimestamp(ts)


def serieDiaria(snaps):
    """Un punto por día: el último snapshot de cada jornada.

    El histórico guarda un punto cada pocos minutos. Sin colapsarlo, la
    volatilidad mediría el ruido intradía (y dependería del intervalo que el
    usuario tenga puesto en Ajustes, que es lo último que debería influir en
    una métrica de riesgo).
    """
    porDia = {}
    flujos = {}
    perdido = False
    for punto in snaps:
        try:
            ts = int(punto["ts"])
            valor = float(punto["v"])
            invertido = float(punto["i"])
        except (KeyError, TypeError, ValueError):
            perdido = True  # su flujo no se puede sumar: el tramo siguiente se estima
            continue
        if not (math.isfinite(valor) and math.isfinite(invertido)):
            perdido = True
            continue
        dia = _dia(ts)
        # El flujo de un día es la suma de los de sus snapshots (cada uno cubre
        # desde el anterior); basta con que falte uno para que el día se estime.
        flujo = _flujo(punto)
        if perdido:
            flujo, perdido = None, False
        previo = flujos.get(dia, 0.0)
        flujos[dia] = None if previo is None or flujo is None else previo + flujo
        anterior = porDia.get(dia)
        if anterior is None or ts >= anterior["ts"]:
            porDia[dia] = {"ts": ts, "dia": dia, "v": valor, "i": invertido}

    return [{**porDia[d], "f": flujos[d]} for d in sorted(porDia)]


def _flujo(punto):
    """Flujo real guardado en el punto (`f`), o None si no hay o no es un número."""
    try:
        flujo = float(punto["f"])
    except (KeyError, TypeError, ValueError):
        return None
    return flujo if math.isfinite(flujo) else None


def flujoDelTramo(previo, actual):
    """`(flujo, estimado)` del tramo entre dos días de la serie.

    El real si el punto lo trae; si no, la variación del invertido, marcada como
    estimada.
    """
    real = actual.get("f")
    if real is not None:
        return real, False
    return actual["i"] - previo["i"], True


def _subperiodos(serie):
    """Rendimiento de cada tramo entre dos días con datos, sin el flujo.

    El flujo se supone al final del tramo: con granularidad diaria no se sabe
    a qué hora entró el dinero, y suponerlo al final es lo que hace que una
    aportación no cuente como rendimiento del día en que se hizo.

        r = (V1 - Flujo) / V0 - 1
    """
    tramos = []
    for previo, actual in pairwise(serie):
        flujo, estimado = flujoDelTramo(previo, actual)
        if previo["v"] <= 0:
            # Cartera vacía (o histórico que empieza en cero): no hay base
            # sobre la que medir un porcentaje. El siguiente tramo reengancha.
            continue
        factor = (actual["v"] - flujo) / previo["v"]
        # Una cartera no puede valer menos que cero; un factor negativo solo
        # sale de datos corruptos y arrastraría el índice entero.
        if not math.isfinite(factor) or factor <= 0:
            continue
        tramos.append({
            "ts": actual["ts"],
            "dias": max((actual["dia"] - previo["dia"]).days, 1),
            "factor": factor,
            "flujo": flujo,
            "estimado": estimado,
        })
    return tramos


def indiceTwr(serie):
    """Índice encadenado base 100: cuánto valdrían 100 € invertidos al inicio.

    Es la serie que se compara con un índice de bolsa y sobre la que se miden
    drawdown y volatilidad.
    """
    if not serie:
        return []
    puntos = [{"ts": serie[0]["ts"], "idx": 100.0}]
    acumulado = 100.0
    for tramo in _subperiodos(serie):
        acumulado *= tramo["factor"]
        puntos.append({"ts": tramo["ts"], "idx": acumulado})
    return puntos


def twr(serie):
    """Rentabilidad time-weighted total y anualizada, en tanto por uno."""
    puntos = indiceTwr(serie)
    if len(puntos) < 2:
        return {"total": None, "anual": None, "dias": 0, "estimado": False}

    total = puntos[-1]["idx"] / 100.0 - 1
    dias = max((serie[-1]["dia"] - serie[0]["dia"]).days, 1)
    anual = None
    if dias >= MINIMO_DIAS_ANUALIZAR:
        anual = (1 + total) ** (DIAS_ANIO / dias) - 1
    estimado = any(tramo["estimado"] for tramo in _subperiodos(serie))
    return {"total": total, "anual": anual, "dias": dias, "estimado": estimado}


# ── XIRR ───────────────────────────────────────────────────────────────────

def flujosDeCaja(serie):
    """Flujos con fecha, vistos desde el bolsillo del inversor.

    Negativo lo que sale (la cartera inicial y cada aportación), positivo lo
    que entra (las ventas) y, al final, el valor vivo como si se liquidara
    todo hoy. Es la lista que necesita la XIRR.
    """
    if len(serie) < 2:
        return []

    flujos = []
    if serie[0]["v"] > 0:
        flujos.append({"ts": serie[0]["ts"], "importe": -serie[0]["v"]})
    for previo, actual in pairwise(serie):
        flujo, _estimado = flujoDelTramo(previo, actual)
        if abs(flujo) > 0.005:
            flujos.append({"ts": actual["ts"], "importe": -flujo})
    flujos.append({"ts": serie[-1]["ts"], "importe": serie[-1]["v"]})
    return flujos


def _van(flujos, tasa, tsBase):
    total = 0.0
    for flujo in flujos:
        anios = (flujo["ts"] - tsBase) / (DIAS_ANIO * 86400)
        total += flujo["importe"] / (1 + tasa) ** anios
    return total


def xirr(flujos):
    """TIR de flujos con fechas irregulares, en tanto por uno anual.

    Bisección y no Newton: es más lenta y da igual (son cuatro decenas de
    flujos), pero no se escapa a un mínimo local ni diverge, que es justo lo
    que hace Newton con series que alternan aportaciones y retiradas grandes.

    Devuelve None si los flujos no acotan ninguna solución (todo aportaciones
    sin valor final, o una cartera que se quedó a cero).
    """
    if len(flujos) < 2:
        return None
    if not (any(f["importe"] > 0 for f in flujos) and any(f["importe"] < 0 for f in flujos)):
        return None

    tsBase = flujos[0]["ts"]
    # -99,99 %: por debajo, el descuento se dispara y no aporta información.
    baja, alta = -0.9999, 1.0
    vanBaja = _van(flujos, baja, tsBase)

    # La tasa alta se estira hasta encontrar cambio de signo. Una cartera que
    # multiplica por diez en tres meses tiene una TIR anual de miles por cien.
    for _ in range(60):
        if vanBaja * _van(flujos, alta, tsBase) <= 0:
            break
        alta *= 2
        if alta > 1e6:
            return None
    else:
        return None

    for _ in range(200):
        media = (baja + alta) / 2
        vanMedia = _van(flujos, media, tsBase)
        if vanBaja * vanMedia <= 0:
            alta = media
        else:
            baja, vanBaja = media, vanMedia
    tasa = (baja + alta) / 2
    return tasa if math.isfinite(tasa) else None


# ── riesgo ─────────────────────────────────────────────────────────────────

def drawdown(puntosIndice):
    """Peor caída desde un máximo del índice TWR, y la caída actual.

    Se mide sobre el índice y no sobre el valor en euros: retirar dinero baja
    el valor sin que la cartera haya perdido nada.
    """
    vacio = {"maximo": None, "ts_pico": None, "ts_valle": None, "actual": None}
    if len(puntosIndice) < 2:
        return vacio

    pico = puntosIndice[0]["idx"]
    tsPicoActual = puntosIndice[0]["ts"]
    peor, tsPico, tsValle = 0.0, None, None

    for punto in puntosIndice:
        if punto["idx"] > pico:
            pico = punto["idx"]
            tsPicoActual = punto["ts"]
        caida = punto["idx"] / pico - 1
        if caida < peor:
            peor, tsPico, tsValle = caida, tsPicoActual, punto["ts"]

    return {
        "maximo": peor,
        "ts_pico": tsPico,
        "ts_valle": tsValle,
        "actual": puntosIndice[-1]["idx"] / pico - 1,
    }


def volatilidad(serie):
    """Desviación típica de los rendimientos, diaria y anualizada.

    Los tramos no siempre miden un día: si no hubo snapshots durante una
    semana, ese rendimiento acumula siete. Cada uno se normaliza dividiendo
    por la raíz de sus días (la varianza escala con el tiempo) antes de
    promediar, que si no una temporada sin registrar infla la cifra.
    """
    tramos = _subperiodos(serie)
    rendimientos = [math.log(t["factor"]) / math.sqrt(t["dias"]) for t in tramos]
    if len(rendimientos) < MINIMO_MUESTRAS_VOLATILIDAD:
        return {"diaria": None, "anual": None, "muestras": len(rendimientos)}

    media = sum(rendimientos) / len(rendimientos)
    varianza = sum((r - media) ** 2 for r in rendimientos) / (len(rendimientos) - 1)
    diaria = math.sqrt(varianza)
    return {
        "diaria": diaria,
        "anual": diaria * math.sqrt(DIAS_ANIO),
        "muestras": len(rendimientos),
    }


# ── cobertura del histórico ────────────────────────────────────────────────

def coberturaAnual(snaps, hoy=None):
    """Cuántos días de cada año tienen snapshot, y cuántos debería haber.

    La rentabilidad anual se dibuja como una barra por año, y una barra
    calculada con tres puntos pesa lo mismo en el gráfico que una con
    trescientos. Esto es lo que deja marcarlas.
    """
    hoy = hoy or datetime.date.today()
    diasPorAnio = {}
    totalPorAnio = {}
    for punto in snaps:
        try:
            ts = int(punto["ts"])
        except (KeyError, TypeError, ValueError):
            continue
        dia = _dia(ts)
        diasPorAnio.setdefault(dia.year, set()).add(dia)
        totalPorAnio[dia.year] = totalPorAnio.get(dia.year, 0) + 1

    resultado = {}
    for anio, dias in diasPorAnio.items():
        if anio == hoy.year:
            esperados = (hoy - datetime.date(anio, 1, 1)).days + 1
        else:
            esperados = (datetime.date(anio, 12, 31) - datetime.date(anio, 1, 1)).days + 1
        resultado[anio] = {
            "dias": len(dias),
            "esperados": esperados,
            "snapshots": totalPorAnio[anio],
            "pct": round(len(dias) / esperados * 100, 1) if esperados else 0.0,
        }
    return resultado


# ── fachada ────────────────────────────────────────────────────────────────

def resumen(snaps, hoy=None):
    """Todas las métricas de una pasada, con la serie del índice TWR."""
    serie = serieDiaria(snaps)
    puntosIndice = indiceTwr(serie)
    tramosDeFlujo = [flujoDelTramo(previo, actual) for previo, actual in pairwise(serie)]
    estimados = sum(1 for _flujo, estimado in tramosDeFlujo if estimado)

    return {
        "twr":          twr(serie),
        "xirr":         xirr(flujosDeCaja(serie)),
        # Los mismos flujos por tramo que usan TWR y XIRR, para que Dietz los reutilice.
        "xirrEstimado": estimados > 0,
        "flujos": {
            "tramos": len(tramosDeFlujo),
            "reales": len(tramosDeFlujo) - estimados,
            "estimados": estimados,
            "serie": [
                {"ts": actual["ts"], "flujo": flujo, "estimado": estimado}
                for (_previo, actual), (flujo, estimado) in zip(pairwise(serie), tramosDeFlujo, strict=True)
            ],
        },
        "drawdown":     drawdown(puntosIndice),
        "volatilidad":  volatilidad(serie),
        "cobertura":    coberturaAnual(snaps, hoy=hoy),
        "indice":       [{"ts": p["ts"], "idx": round(p["idx"], 4)} for p in puntosIndice],
        "dias":         len(serie),
    }
