"""Evaluación de las reglas de alerta y aviso por Telegram.

El hilo de avisos (`admin.avisos_scheduler`) llama a `comprobar` cada
`[avisos] reglas_intervalo_minutos` en cada portfolio. Una pasada:

  1. Purga las muestras que ya no caben en ninguna ventana.
  2. Para las reglas que se miden con la cotización de cada activo, pide la
     cotización de los activos vigilados (solo esos), guarda una muestra y
     evalúa sus reglas. Si la cotización falla, solo se evalúa «sin cotización».
  3. Si hay reglas de cartera, valora la cartera entera una vez y las evalúa.

Cada tipo tiene su función evaluadora (patrón Strategy, `_evaluadores`): recibe
la regla y el contexto, y devuelve un `Resultado` o None si no se puede
evaluar ahora (falta el precio, la posición o un tipo de cambio). Qué hacer con
el resultado —reclamar el aviso, rearmar una alerta de nivel, mandar el
mensaje— es común y vive en `_procesar`.

Dos workers no pueden avisar dos veces: el aviso se reclama con un UPSERT
condicionado y solo quien ve `rowcount == 1` manda el mensaje.
"""

import logging
import time
from dataclasses import dataclass, field
from decimal import Decimal

from core import dinero, telegram_notifier
from core.db import getDb
from stores import reglas_alerta_store as store

log = logging.getLogger(__name__)

# Sin muestras previas, «sin cotización» cuenta desde que arrancó el proceso: un
# reinicio tras horas apagado no puede avisar de golpe de horas sin precio.
arranqueProceso = int(time.time())

# Holgura al purgar: una muestra justo en el borde de la ventana más larga
# todavía puede ser el máximo de una regla de 24 h.
margenPurgaSegundos = 600


@dataclass
class Resultado:
    """Lo que dice una regla sobre un activo (o la cartera) en esta pasada.

    Attributes:
        cumple: si la condición se cumple ahora.
        valor: la medida que se ha comparado (caída en %, rentabilidad…).
        detalle: resumen corto para la lista de avisos de la web.
        cuerpo: líneas del mensaje de Telegram, sin cabecera ni nota.
    """

    cumple: bool
    valor: Decimal = Decimal(0)
    detalle: str = ""
    cuerpo: list = field(default_factory=list)


@dataclass
class Contexto:
    """Datos con los que se evalúa una regla sobre un activo o sobre la cartera."""

    ahora: int
    clave: str
    nombre: str
    simbolo: str = ""
    moneda: str = ""
    precio: Decimal | None = None
    posicion: dict | None = None
    peso: Decimal | None = None
    valorCartera: Decimal | None = None
    aEuros: object = None


# ── Utilidades de cálculo ─────────────────────────────────────────────────────

def caidaDesdeMaximo(precios, actual) -> tuple:
    """Caída en % de `actual` respecto al máximo de `precios`.

    Función pura, para poder probar el cálculo solo.

    Returns:
        `(caida, maximo)`; la caída es 0 si `actual` no está por debajo.

    Example:
        >>> caidaDesdeMaximo([Decimal("100"), Decimal("104")], Decimal("97.76"))
        (Decimal('6.00'), Decimal('104'))
    """
    maximo = max(precios, default=actual)
    if maximo <= 0 or actual >= maximo:
        return Decimal(0), max(maximo, actual)
    return dinero.redondear((maximo - actual) / maximo * 100, 2), maximo


def subidaDesdeMinimo(precios, actual) -> tuple:
    """Subida en % de `actual` respecto al mínimo de `precios`. Ver `caidaDesdeMaximo`."""
    minimo = min(precios, default=actual)
    if minimo <= 0 or actual <= minimo:
        return Decimal(0), min(minimo, actual)
    return dinero.redondear((actual - minimo) / minimo * 100, 2), minimo


def _pct(numero: Decimal) -> str:
    return dinero.aTextoEs(numero, decimales=2)


def _importe(numero: Decimal) -> str:
    """Un precio legible: dos decimales, o seis si es menor que 1 (cripto barata)."""
    return dinero.aTextoEs(numero, decimales=2 if abs(numero) >= 1 else 6)


def _tiempo(minutos: int) -> str:
    return f"{minutos // 60} h" if minutos >= 60 else f"{minutos} min"


def _umbral(regla) -> Decimal | None:
    return dinero.aDecimalONulo(regla["valor"], "umbral")


def _cumpleSentido(regla, medida: Decimal, umbral: Decimal) -> bool:
    """Arriba: medida ≥ umbral. Abajo: la medida baja al menos `umbral` (medida ≤ -umbral)."""
    return medida >= umbral if regla["sentido"] == "arriba" else -medida >= umbral


# ── Muestras ──────────────────────────────────────────────────────────────────

def registrarMuestra(conn, assetId: str, precio: Decimal, ahora: int) -> None:
    """Guarda el precio de `assetId` en el instante `ahora` (segundos)."""
    conn.execute(
        "INSERT OR REPLACE INTO muestras_precio (asset_id, ts, precio) VALUES (?, ?, ?)",
        (assetId, int(ahora), dinero.aTexto(precio)),
    )
    conn.commit()


def registrarMuestraCartera(conn, valor: Decimal, ahora: int) -> None:
    """Guarda el valor total de la cartera en el instante `ahora`."""
    conn.execute(
        "INSERT OR REPLACE INTO muestras_cartera (ts, valor) VALUES (?, ?)", (int(ahora), dinero.aTexto(valor))
    )
    conn.commit()


def purgarMuestras(conn, ahora: int, hayReglas: bool) -> int:
    """Borra las muestras que ya no caben en ninguna ventana. Devuelve cuántas.

    Sin reglas activas se borra todo: un historial viejo solo serviría para
    disparar avisos falsos al reactivar una regla días después.
    """
    if hayReglas:
        limite = int(ahora) - store.ventanaMaximaSegundos - margenPurgaSegundos
        borradas = conn.execute("DELETE FROM muestras_precio WHERE ts < ?", (limite,)).rowcount
        borradas += conn.execute("DELETE FROM muestras_cartera WHERE ts < ?", (limite,)).rowcount
    else:
        borradas = conn.execute("DELETE FROM muestras_precio").rowcount
        borradas += conn.execute("DELETE FROM muestras_cartera").rowcount
    conn.commit()
    return borradas


def _valoresDesde(conn, consulta: str, parametros: tuple) -> list:
    valores = (dinero.aDecimalONulo(f[0], "muestra") for f in conn.execute(consulta, parametros).fetchall())
    return [v for v in valores if v is not None and v > 0]


def _ultimaMuestra(conn, assetId: str) -> int:
    fila = conn.execute("SELECT MAX(ts) FROM muestras_precio WHERE asset_id = ?", (assetId,)).fetchone()
    return fila[0] or 0


# ── Evaluadores (uno por tipo) ────────────────────────────────────────────────

def _evaluarCaida(conn, regla, ctx: Contexto, desde: int):
    if ctx.precio is None:
        return None
    precios = _valoresDesde(conn, "SELECT precio FROM muestras_precio WHERE asset_id = ? AND ts >= ?",
                            (ctx.clave, desde))
    caida, maximo = caidaDesdeMaximo(precios, ctx.precio)
    umbral = _umbral(regla)
    ventana = _tiempo(regla["ventana_min"])
    return Resultado(
        cumple=umbral is not None and caida >= umbral, valor=caida,
        detalle=f"-{_pct(caida)} % · de {_importe(maximo)} a {_importe(ctx.precio)} {ctx.moneda}",
        cuerpo=[f"-{_pct(caida)} % en menos de {ventana}",
                f"De {_importe(maximo)} a {_importe(ctx.precio)} {ctx.moneda}",
                f"Tu alerta: caída ≥ {_pct(umbral or 0)} % en {ventana}"],
    )


def _evaluarSubida(conn, regla, ctx: Contexto, desde: int):
    if ctx.precio is None:
        return None
    precios = _valoresDesde(conn, "SELECT precio FROM muestras_precio WHERE asset_id = ? AND ts >= ?",
                            (ctx.clave, desde))
    subida, minimo = subidaDesdeMinimo(precios, ctx.precio)
    umbral = _umbral(regla)
    ventana = _tiempo(regla["ventana_min"])
    return Resultado(
        cumple=umbral is not None and subida >= umbral, valor=subida,
        detalle=f"+{_pct(subida)} % · de {_importe(minimo)} a {_importe(ctx.precio)} {ctx.moneda}",
        cuerpo=[f"+{_pct(subida)} % en menos de {ventana}",
                f"De {_importe(minimo)} a {_importe(ctx.precio)} {ctx.moneda}",
                f"Tu alerta: subida ≥ {_pct(umbral or 0)} % en {ventana}"],
    )


def _evaluarRentabilidad(_conn, regla, ctx: Contexto, _desde: int):
    posicion = ctx.posicion
    if ctx.precio is None or not posicion or posicion["cantidad"] <= 0 or posicion["coste"] <= 0:
        return None
    umbral = _umbral(regla)
    if umbral is None:
        return None
    # Con comisiones: el coste bruto es lo que salió de verdad del bolsillo.
    resultado = posicion["cantidad"] * ctx.precio - posicion["coste"]
    if regla["unidad"] == "EUR":
        medida = ctx.aEuros(resultado, ctx.moneda) if ctx.aEuros else None
        if medida is None:
            return None
        medida = dinero.redondear(medida, 2)
        texto = f"{'+' if medida >= 0 else '-'}{_importe(abs(medida))} €"
        textoUmbral = f"{_importe(umbral)} €"
    else:
        medida = dinero.redondear(resultado / posicion["coste"] * 100, 2)
        texto = f"{'+' if medida >= 0 else '-'}{_pct(abs(medida))} %"
        textoUmbral = f"{_pct(umbral)} %"
    etiqueta = store.tipos["rentabilidad"].sentidos.get(regla["sentido"], "").lower()
    return Resultado(
        cumple=_cumpleSentido(regla, medida, umbral), valor=medida,
        detalle=f"Resultado {texto} con {_importe(ctx.precio)} {ctx.moneda}",
        cuerpo=[f"Tu posición va {texto} (con comisiones)",
                f"Precio: {_importe(ctx.precio)} {ctx.moneda}",
                f"Tu alerta: {etiqueta} {textoUmbral}"],
    )


def _evaluarPrecioMedio(_conn, regla, ctx: Contexto, _desde: int):
    posicion = ctx.posicion
    if ctx.precio is None or not posicion or posicion["cantidad"] <= 0 or posicion["invertido"] <= 0:
        return None
    umbral = _umbral(regla)
    if umbral is None:
        return None
    medio = posicion["invertido"] / posicion["cantidad"]
    diferencia = dinero.redondear((ctx.precio / medio - 1) * 100, 2)
    signo = "+" if diferencia >= 0 else "-"
    etiqueta = store.tipos["precio_medio"].sentidos.get(regla["sentido"], "").lower()
    return Resultado(
        cumple=_cumpleSentido(regla, diferencia, umbral), valor=diferencia,
        detalle=f"{signo}{_pct(abs(diferencia))} % frente a {_importe(medio)} {ctx.moneda}",
        cuerpo=[f"Precio: {_importe(ctx.precio)} {ctx.moneda} ({signo}{_pct(abs(diferencia))} %)",
                f"Tu precio medio: {_importe(medio)} {ctx.moneda}",
                f"Tu alerta: {etiqueta} {_pct(umbral)} %"],
    )


def _evaluarSinCotizacion(conn, regla, ctx: Contexto, _desde: int):
    if ctx.precio is not None:
        return Resultado(cumple=False)
    desde = max(_ultimaMuestra(conn, ctx.clave), regla["creada_ts"] or 0, arranqueProceso)
    minutos = max(0, (ctx.ahora - desde) // 60)
    ventana = _tiempo(regla["ventana_min"])
    return Resultado(
        cumple=minutos >= regla["ventana_min"], valor=Decimal(minutos),
        detalle=f"Sin precio desde hace {_tiempo(minutos)}",
        cuerpo=[f"No se ha podido cotizar en {_tiempo(minutos)}",
                "Mientras no haya precio, sus otras alertas no pueden saltar",
                f"Tu alerta: sin cotización durante más de {ventana}"],
    )


def _evaluarCarteraValor(_conn, regla, ctx: Contexto, _desde: int):
    umbral = _umbral(regla)
    if ctx.valorCartera is None or umbral is None:
        return None
    arriba = regla["sentido"] == "arriba"
    cumple = ctx.valorCartera >= umbral if arriba else ctx.valorCartera <= umbral
    return Resultado(
        cumple=cumple, valor=ctx.valorCartera,
        detalle=f"Valor {_importe(ctx.valorCartera)} €",
        cuerpo=[f"Valor de la cartera: {_importe(ctx.valorCartera)} €",
                f"Tu alerta: {'sube de' if arriba else 'baja de'} {_importe(umbral)} €"],
    )


def _evaluarCarteraCaida(conn, regla, ctx: Contexto, desde: int):
    if ctx.valorCartera is None:
        return None
    valores = _valoresDesde(conn, "SELECT valor FROM muestras_cartera WHERE ts >= ?", (desde,))
    caida, maximo = caidaDesdeMaximo(valores, ctx.valorCartera)
    umbral = _umbral(regla)
    ventana = _tiempo(regla["ventana_min"])
    return Resultado(
        cumple=umbral is not None and caida >= umbral, valor=caida,
        detalle=f"-{_pct(caida)} % · de {_importe(maximo)} € a {_importe(ctx.valorCartera)} €",
        cuerpo=[f"-{_pct(caida)} % en menos de {ventana}",
                f"De {_importe(maximo)} € a {_importe(ctx.valorCartera)} €",
                f"Tu alerta: caída de la cartera ≥ {_pct(umbral or 0)} % en {ventana}"],
    )


def _evaluarPeso(_conn, regla, ctx: Contexto, _desde: int):
    umbral = _umbral(regla)
    if ctx.peso is None or umbral is None:
        return None
    return Resultado(
        cumple=ctx.peso >= umbral, valor=ctx.peso,
        detalle=f"Pesa el {_pct(ctx.peso)} % de la cartera",
        cuerpo=[f"Pesa el {_pct(ctx.peso)} % de la cartera",
                f"Tu alerta: peso ≥ {_pct(umbral)} %"],
    )


_evaluadores = {
    "caida": _evaluarCaida,
    "subida": _evaluarSubida,
    "rentabilidad": _evaluarRentabilidad,
    "precio_medio": _evaluarPrecioMedio,
    "sin_cotizacion": _evaluarSinCotizacion,
    "cartera_valor": _evaluarCarteraValor,
    "cartera_caida": _evaluarCarteraCaida,
    "peso": _evaluarPeso,
}


# ── Reclamar y avisar ─────────────────────────────────────────────────────────

def _ultimoAviso(conn, reglaId, clave) -> int:
    fila = conn.execute(
        "SELECT avisada_ts FROM alertas_reglas_avisos WHERE regla_id = ? AND clave = ?", (reglaId, clave)
    ).fetchone()
    return fila[0] if fila else 0


def _reclamar(conn, regla, clave, ahora, resultado: Resultado, nivel: bool) -> bool:
    """Apunta el aviso si toca. True si esta llamada se lo queda.

    Movimiento: basta con que haya pasado el enfriamiento. Nivel: además tiene
    que estar fuera de la condición (`dentro = 0`), para no repetir el aviso
    mientras siga cumpliéndose.
    """
    limite = int(ahora) - regla["enfriamiento_min"] * 60
    condicionNivel = "alertas_reglas_avisos.dentro = 0 AND " if nivel else ""
    reclamado = conn.execute(
        "INSERT INTO alertas_reglas_avisos (regla_id, clave, avisada_ts, dentro, valor, detalle) "
        "VALUES (?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(regla_id, clave) DO UPDATE SET avisada_ts = excluded.avisada_ts, dentro = excluded.dentro, "
        "valor = excluded.valor, detalle = excluded.detalle "
        f"WHERE {condicionNivel}alertas_reglas_avisos.avisada_ts <= ?",
        (regla["id"], clave, int(ahora), 1 if nivel else 0, dinero.aTexto(resultado.valor), resultado.detalle,
         limite),
    ).rowcount
    conn.commit()
    return reclamado == 1


def _rearmar(conn, reglaId, clave) -> None:
    """Una alerta de nivel que sale de la condición queda lista para avisar otra vez."""
    if conn.execute(
        "UPDATE alertas_reglas_avisos SET dentro = 0 WHERE regla_id = ? AND clave = ? AND dentro = 1",
        (reglaId, clave),
    ).rowcount:
        conn.commit()


def _texto(regla, ctx: Contexto, resultado: Resultado, cartera: str) -> str:
    tipo = store.tipos[regla["tipo"]]
    sujeto = f"{ctx.nombre}{f' ({ctx.simbolo})' if ctx.simbolo else ''}" if ctx.nombre else ""
    lineas = [f"{tipo.etiqueta}{f' · {sujeto}' if sujeto else ''}", *resultado.cuerpo]
    if regla["nota"]:
        lineas.append(f"Nota: {regla['nota']}")
    if cartera:
        lineas.append(f"Cartera: {cartera}")
    return "\n".join(lineas)


def evaluarRegla(conn, regla, ctx: Contexto, cartera: str = "") -> bool:
    """Evalúa una regla sobre un contexto y avisa si toca. True si ha avisado.

    Nunca lanza: una regla mal formada no puede tumbar la pasada.
    """
    try:
        tipo = store.tipos.get(regla["tipo"])
        evaluador = _evaluadores.get(regla["tipo"])
        if tipo is None or evaluador is None:
            return False
        nivel = tipo.familia == "nivel"
        desde = 0
        if not nivel:
            # La ventana empieza en el último aviso si es más reciente: el pico
            # previo a una caída ya avisada no puede volver a disparar la misma.
            desde = max(ctx.ahora - regla["ventana_min"] * 60, _ultimoAviso(conn, regla["id"], ctx.clave))
        resultado = evaluador(conn, regla, ctx, desde)
        if resultado is None:
            return False
        if not resultado.cumple:
            if nivel:
                _rearmar(conn, regla["id"], ctx.clave)
            return False
        if not _reclamar(conn, regla, ctx.clave, ctx.ahora, resultado, nivel):
            return False

        log.info("[reglas] %s regla %s sobre %s: %s", tipo.clave, regla["id"], ctx.clave, resultado.detalle)
        telegram_notifier.notificar(
            tipo.categoriaAviso, _texto(regla, ctx, resultado, cartera), gravedad=telegram_notifier.AVISO
        )
        return True
    except Exception as error:
        log.warning("[reglas] No se pudo evaluar la regla %s sobre %s: %s", regla["id"], ctx.clave, error)
        return False


# ── Pasada ────────────────────────────────────────────────────────────────────

def _conversorEuros(cambio=None):
    """Convierte importes a euros con un tipo por divisa y pasada. None si falla."""
    if cambio is None:
        from providers.finnhub_client import fetchExchangeRate as cambio
    cache = {"EUR": Decimal(1)}

    def aEuros(importe: Decimal, moneda: str):
        divisa = str(moneda or "EUR").strip().upper() or "EUR"
        if divisa not in cache:
            try:
                tasa, error = cambio(divisa, "EUR")
            except Exception as fallo:
                tasa, error = None, str(fallo)
            # Sin tipo no se adivina: valorar 1:1 haría saltar alertas falsas.
            cache[divisa] = None if error or not tasa else dinero.aDecimal(tasa, "tipo de cambio")
        return None if cache[divisa] is None else importe * cache[divisa]

    return aEuros


def _cotizacionEnSuDivisa(activo, fetcher, maxEdadSegundos):
    """Precio del activo en su divisa (Decimal > 0), o None si no se puede obtener fiable."""
    from stores.helpers import normalizeCurrencyCode

    simbolo = str(activo["market_symbol"] or activo["finnhub_symbol"] or "").strip()
    moneda = normalizeCurrencyCode(activo["currency"], fallback="EUR")
    try:
        quote, error = fetcher(simbolo, activo["market_provider"], targetCurrency=moneda,
                               maxEdadSegundos=maxEdadSegundos)
    except Exception as fallo:
        quote, error = None, str(fallo)
    if error or not quote:
        log.info("[reglas] %s sin cotización: %s", activo["id"], error)
        return None
    # Mezclar divisas entre muestras fabricaría movimientos que son solo el tipo de cambio.
    if normalizeCurrencyCode(quote.get("currency", ""), fallback="") != moneda:
        log.info("[reglas] %s: la cotización no llegó en %s; se ignora", activo["id"], moneda)
        return None
    precio = dinero.aDecimalONulo(quote.get("price"), "precio")
    return precio if precio is not None and precio > 0 else None


def _activosConSimbolo(conn, ids) -> list:
    if not ids:
        return []
    marcadores = ",".join("?" * len(ids))
    return conn.execute(
        "SELECT id, name, symbol, market_provider, market_symbol, finnhub_symbol, currency FROM activos "
        f"WHERE id IN ({marcadores}) AND (TRIM(market_symbol) <> '' OR TRIM(finnhub_symbol) <> '')",
        tuple(ids),
    ).fetchall()


def _aplica(regla, assetId: str, enCartera: set) -> bool:
    if regla["asset_id"] is not None:
        return regla["asset_id"] == assetId
    return assetId in enCartera


def _pasadaActivos(conn, reglas, ahora, cartera, posiciones, fetcher, maxEdadSegundos, aEuros) -> int:
    enCartera = {assetId for assetId, p in posiciones.items() if p["cantidad"] > 0}
    ids = {r["asset_id"] for r in reglas if r["asset_id"]}
    if any(r["asset_id"] is None for r in reglas):
        ids |= enCartera

    avisos = 0
    for activo in _activosConSimbolo(conn, ids):
        propias = [r for r in reglas if _aplica(r, activo["id"], enCartera)]
        if not propias:
            continue
        precio = _cotizacionEnSuDivisa(activo, fetcher, maxEdadSegundos)
        if precio is not None:
            registrarMuestra(conn, activo["id"], precio, ahora)
        ctx = Contexto(
            ahora=ahora, clave=activo["id"], nombre=activo["name"] or activo["id"], simbolo=activo["symbol"] or "",
            moneda=activo["currency"] or "", precio=precio, posicion=posiciones.get(activo["id"]), aEuros=aEuros,
        )
        avisos += sum(evaluarRegla(conn, regla, ctx, cartera) for regla in propias)
    return avisos


def _pasadaCartera(conn, reglas, ahora, cartera, valorador) -> int:
    valoracion = valorador(refrescarPrecios=True)
    # Una valoración incompleta (sin un tipo de cambio, o con mucho valor de
    # reserva) es una aproximación: comparar con ella haría saltar caídas falsas.
    if not valoracion.get("activos") or not valoracion.get("completa", True):
        log.info("[reglas] %s: valoración incompleta; no se evalúan las reglas de cartera", cartera or "cartera")
        return 0
    valor = dinero.aDecimal(valoracion["total_value"], "valor de la cartera")
    if valor <= 0:
        return 0
    registrarMuestraCartera(conn, valor, ahora)

    pesos = {a["id"]: dinero.aDecimal(a["v"], "valor") / valor * 100 for a in valoracion.get("assets", [])}
    nombres = {f["id"]: (f["name"] or f["id"], f["symbol"] or "")
               for f in conn.execute("SELECT id, name, symbol FROM activos").fetchall()}

    avisos = 0
    for regla in reglas:
        if regla["tipo"] != "peso":
            ctx = Contexto(ahora=ahora, clave=store.claveCartera, nombre="", valorCartera=valor)
            avisos += evaluarRegla(conn, regla, ctx, cartera)
            continue
        for assetId, peso in pesos.items():
            if regla["asset_id"] is not None and regla["asset_id"] != assetId:
                continue
            nombre, simbolo = nombres.get(assetId, (assetId, ""))
            ctx = Contexto(ahora=ahora, clave=assetId, nombre=nombre, simbolo=simbolo,
                           peso=dinero.redondear(peso, 2), valorCartera=valor)
            avisos += evaluarRegla(conn, regla, ctx, cartera)
    return avisos


def comprobar(cartera: str = "", maxEdadSegundos=None, fetcher=None, valorador=None, posiciones=None,
              cambio=None, ahora=None) -> int:
    """Evalúa todas las reglas activas del portfolio abierto. Devuelve cuántos avisos.

    Args:
        cartera: id del portfolio, para el texto del aviso.
        maxEdadSegundos: edad máxima de una cotización en caché; el intervalo
            de muestreo, para no guardar dos veces el mismo precio.
        fetcher: cotizador con la firma de `stores.market_data.fetchAssetQuote`.
        valorador: con la firma de `stores.valoracion.valorarPortfolio`.
        posiciones: `{asset_id: {"cantidad", "coste", "invertido"}}`; por
            defecto, `stores.ventas_fifo.carteraViva()` si alguna regla lo necesita.
        cambio: con la firma de `providers.finnhub_client.fetchExchangeRate`.
        ahora: instante de la pasada en segundos; por defecto, el actual.

    Todas las dependencias son inyectables para poder probar sin red.
    """
    ahora = int(time.time() if ahora is None else ahora)
    conn = getDb()
    reglas = [r for r in store.activas(conn) if r["tipo"] in store.tipos]
    purgarMuestras(conn, ahora, hayReglas=bool(reglas))
    if not reglas:
        return 0

    porCotizacion = [r for r in reglas if store.tipos[r["tipo"]].fuente == "cotizacion"]
    porValoracion = [r for r in reglas if store.tipos[r["tipo"]].fuente == "valoracion"]
    avisos = 0

    if porCotizacion:
        if fetcher is None:
            from stores.market_data import fetchAssetQuote as fetcher
        necesitaCartera = any(r["asset_id"] is None or store.tipos[r["tipo"]].necesitaPosicion
                              for r in porCotizacion)
        if posiciones is None and necesitaCartera:
            # Import tardío: el FIFO arrastra medio stores/ y solo hace falta aquí.
            from stores.ventas_fifo import carteraViva
            posiciones = carteraViva()
        avisos += _pasadaActivos(conn, porCotizacion, ahora, cartera, posiciones or {}, fetcher,
                                 maxEdadSegundos, _conversorEuros(cambio))

    if porValoracion:
        if valorador is None:
            from stores.valoracion import valorarPortfolio as valorador
        avisos += _pasadaCartera(conn, porValoracion, ahora, cartera, valorador)

    return avisos
