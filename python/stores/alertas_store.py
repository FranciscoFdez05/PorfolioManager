"""Alertas de precio de los activos.

Una alerta dice «avísame cuando este activo llegue a X». Se evalúa en dos
momentos, con la misma función (`evaluar_activo`) para que no puedan divergir:

  * cada vez que el precio de un activo se actualiza en la aplicación (botón de
    refrescar, refresco automático de la web);
  * cada pocos minutos, desde `admin.avisos_scheduler`, pidiendo la cotización
    solo de los activos que tienen alguna alerta activa. Así las alertas saltan
    aunque no haya una pestaña abierta, que es justo cuando interesan.

**Salta una sola vez.** Al cumplirse queda desactivada con la hora y el precio
que la disparó, y no se vuelve a evaluar hasta que el usuario la reactiva. Con
un aviso que se repite cada vez que el precio cruza el umbral, un activo que
oscile alrededor de él llenaría el chat de mensajes.

**Dos workers, un solo aviso.** Reclamar la alerta es un `UPDATE … WHERE
activa = 1` y solo quien ve `rowcount == 1` manda el mensaje: la base de datos
decide, no un bloqueo en memoria que el otro worker no ve.
"""

import logging
import time
from decimal import Decimal

from core import dinero, telegram_notifier
from core.db import get_db

log = logging.getLogger(__name__)

# condicion -> etiqueta que enseña la interfaz.
CONDICIONES = {
    "sube_a": "Precio igual o superior a",
    "baja_a": "Precio igual o inferior a",
    "var_dia": "Variación del día (±%) igual o superior a",
}

_MAX_NOTA = 200


class AlertaInvalida(ValueError):
    """La alerta que se intenta crear no tiene sentido."""


def _como_dict(fila) -> dict:
    return {
        "id": fila["id"],
        "assetId": fila["asset_id"],
        "condicion": fila["condicion"],
        "valor": fila["valor"],
        "nota": fila["nota"],
        "activa": bool(fila["activa"]),
        "creada": fila["creada_ts"],
        "disparada": fila["disparada_ts"],
        "precioDisparo": fila["precio_disparo"],
    }


_COLUMNAS = "id, asset_id, condicion, valor, nota, activa, creada_ts, disparada_ts, precio_disparo"


def listar(asset_id=None) -> list:
    """Alertas de un activo, o de todos, las activas primero."""
    conn = get_db()
    consulta = f"SELECT {_COLUMNAS} FROM alertas_precio"
    parametros = ()
    if asset_id:
        consulta += " WHERE asset_id = ?"
        parametros = (asset_id,)
    consulta += " ORDER BY activa DESC, id"
    return [_como_dict(f) for f in conn.execute(consulta, parametros).fetchall()]


def contar_activas() -> int:
    return get_db().execute("SELECT COUNT(*) FROM alertas_precio WHERE activa = 1").fetchone()[0]


def crear(asset_id, condicion, valor, nota="") -> dict:
    """Crea una alerta activa. Lanza `AlertaInvalida` si algo no cuadra."""
    if condicion not in CONDICIONES:
        raise AlertaInvalida("Condición de alerta desconocida")

    try:
        numero = dinero.aDecimal(valor, "valor de la alerta")
    except dinero.ImporteInvalido:
        raise AlertaInvalida("El valor de la alerta no es un número válido") from None
    if numero <= 0:
        raise AlertaInvalida("El valor de la alerta tiene que ser mayor que cero")

    conn = get_db()
    if conn.execute("SELECT 1 FROM activos WHERE id = ?", (asset_id,)).fetchone() is None:
        raise AlertaInvalida("Activo no encontrado")

    cursor = conn.execute(
        "INSERT INTO alertas_precio (asset_id, condicion, valor, nota, activa, creada_ts) "
        "VALUES (?, ?, ?, ?, 1, ?)",
        (asset_id, condicion, dinero.aTexto(numero), str(nota or "").strip()[:_MAX_NOTA], int(time.time())),
    )
    conn.commit()
    fila = conn.execute(f"SELECT {_COLUMNAS} FROM alertas_precio WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return _como_dict(fila)


def borrar(alerta_id) -> bool:
    conn = get_db()
    borradas = conn.execute("DELETE FROM alertas_precio WHERE id = ?", (alerta_id,)).rowcount
    conn.commit()
    return borradas > 0


def cambiar_estado(alerta_id, activa: bool) -> bool:
    """Activa o pausa una alerta. Activarla borra la marca de «ya saltó»."""
    conn = get_db()
    if activa:
        cambiadas = conn.execute(
            "UPDATE alertas_precio SET activa = 1, disparada_ts = NULL, precio_disparo = '' WHERE id = ?",
            (alerta_id,),
        ).rowcount
    else:
        cambiadas = conn.execute("UPDATE alertas_precio SET activa = 0 WHERE id = ?", (alerta_id,)).rowcount
    conn.commit()
    return cambiadas > 0


def cambio_desde_texto(texto):
    """Variación diaria en % desde el texto de la ficha («+1,23%»), o None."""
    return dinero.aDecimalONulo(texto, "variación") if str(texto or "").strip() else None


def _cumple(condicion, umbral: Decimal, precio: Decimal, cambio) -> bool:
    if condicion == "sube_a":
        return precio >= umbral
    if condicion == "baja_a":
        return precio <= umbral
    if condicion == "var_dia":
        return cambio is not None and abs(cambio) >= umbral
    return False


def _formato(numero: Decimal) -> str:
    """Un precio legible: dos decimales, o seis si es menor que 1 (cripto barata)."""
    return dinero.aTextoEs(numero, decimales=2 if abs(numero) >= 1 else 6)


def _texto_aviso(activo, alerta, umbral, precio, cambio, cartera) -> str:
    nombre = activo["name"] or activo["id"]
    simbolo = f" ({activo['symbol']})" if activo["symbol"] else ""
    moneda = activo["currency"] or ""
    cabecera = f"🔔 Alerta de precio · {nombre}{simbolo}"

    if alerta["condicion"] == "var_dia":
        movimiento = f"{'+' if cambio >= 0 else '-'}{dinero.aTextoEs(abs(cambio), decimales=2)} %"
        cuerpo = (f"Se ha movido {movimiento} hoy\n"
                  f"Tu alerta: variación del día ≥ {dinero.aTextoEs(umbral, decimales=2)} %\n"
                  f"Precio: {_formato(precio)} {moneda}")
    else:
        verbo = "ha subido a" if alerta["condicion"] == "sube_a" else "ha bajado a"
        signo = "≥" if alerta["condicion"] == "sube_a" else "≤"
        cuerpo = (f"{nombre} {verbo} {_formato(precio)} {moneda}\n"
                  f"Tu alerta: precio {signo} {_formato(umbral)} {moneda}")

    if alerta["nota"]:
        cuerpo += f"\n📝 {alerta['nota']}"
    if cartera:
        cuerpo += f"\nCartera: {cartera}"
    return f"{cabecera}\n{cuerpo}"


def evaluar_activo(asset_id, precio, cambio=None, cartera="") -> list:
    """Comprueba las alertas activas de `asset_id` contra `precio` y avisa de las que saltan.

    `precio` es el actual en la divisa del activo (la misma en la que se puso
    el umbral). `cambio` es la variación del día en %, si se conoce; sin ella no
    puede saltar una alerta `var_dia`. Devuelve las alertas que han saltado.
    Nunca lanza: se llama desde el refresco de precios y desde un hilo, y una
    alerta mal formada no puede tumbar ninguno de los dos.
    """
    try:
        precio = dinero.aDecimal(precio, "precio")
        if precio <= 0:
            return []

        conn = get_db()
        pendientes = conn.execute(
            f"SELECT {_COLUMNAS} FROM alertas_precio WHERE asset_id = ? AND activa = 1", (asset_id,)
        ).fetchall()
        if not pendientes:
            return []

        activo = conn.execute(
            "SELECT id, name, symbol, currency FROM activos WHERE id = ?", (asset_id,)
        ).fetchone()
        if activo is None:
            return []

        saltadas = []
        for fila in pendientes:
            alerta = _como_dict(fila)
            umbral = dinero.aDecimalONulo(alerta["valor"], "valor de la alerta")
            if umbral is None or not _cumple(alerta["condicion"], umbral, precio, cambio):
                continue

            # La base de datos decide quién se la queda: si el otro worker la
            # reclamó entre el SELECT y aquí, rowcount es 0 y no se repite.
            reclamada = conn.execute(
                "UPDATE alertas_precio SET activa = 0, disparada_ts = ?, precio_disparo = ? "
                "WHERE id = ? AND activa = 1",
                (int(time.time()), dinero.aTexto(precio), alerta["id"]),
            ).rowcount
            conn.commit()
            if reclamada != 1:
                continue

            saltadas.append(alerta)
            log.info("[alertas] %s: %s %s con precio %s", asset_id, alerta["condicion"], alerta["valor"], precio)
            telegram_notifier.notificar(
                "precios", _texto_aviso(activo, alerta, umbral, precio, cambio, cartera)
            )
        return saltadas
    except Exception as error:
        log.warning("[alertas] No se pudo evaluar %s: %s", asset_id, error)
        return []


def activos_con_alertas() -> list:
    """Datos de mercado de los activos que tienen al menos una alerta activa."""
    filas = get_db().execute(
        "SELECT a.id, a.name, a.symbol, a.market_provider, a.market_symbol, a.finnhub_symbol, a.currency "
        "FROM activos a WHERE EXISTS "
        "(SELECT 1 FROM alertas_precio p WHERE p.asset_id = a.id AND p.activa = 1)"
    ).fetchall()
    return [dict(f) for f in filas]


def comprobar_activas(cartera="") -> int:
    """Pide la cotización de cada activo con alertas activas y las evalúa. Devuelve cuántas saltaron.

    Solo se piden los activos con alerta: vigilar cinco alertas no puede costar
    la cuota de una cartera de cincuenta valores. La cotización se convierte a
    la divisa del activo, como hace el botón de refrescar: si la conversión
    falla se descarta, porque comparar dólares con un umbral en euros haría
    saltar alertas falsas.
    """
    from stores.helpers import normalize_currency_code
    from stores.market_data import fetch_asset_quote

    total = 0
    for activo in activos_con_alertas():
        simbolo = str(activo["market_symbol"] or activo["finnhub_symbol"] or "").strip()
        if not simbolo:
            continue
        moneda = normalize_currency_code(activo["currency"], fallback="EUR")
        try:
            quote, error = fetch_asset_quote(simbolo, activo["market_provider"], target_currency=moneda)
        except Exception as fallo:
            quote, error = None, str(fallo)
        if error or not quote:
            log.info("[alertas] %s sin cotización: %s", activo["id"], error)
            continue
        if normalize_currency_code(quote.get("currency", ""), fallback="") != moneda:
            log.info("[alertas] %s: la cotización no llegó en %s; se ignora", activo["id"], moneda)
            continue
        total += len(evaluar_activo(
            activo["id"], quote.get("price"), cambio_desde_texto(quote.get("change")), cartera=cartera,
        ))
    return total
