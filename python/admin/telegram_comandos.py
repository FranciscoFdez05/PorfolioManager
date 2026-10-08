"""Comandos del bot de Telegram: preguntar al servidor desde el móvil.

`telegram_listener` decide **quién** puede hablar (solo el chat guardado en
Ajustes) y este módulo decide **qué contesta**. Cada comando es una función que
recibe los argumentos ya separados y devuelve el texto de la respuesta; no envía
nada por su cuenta, así que se prueba sin red.

Trabajan sobre el portfolio activo, el mismo que se ve en la web. Lo que
escriben (crear una alerta, hacer una copia) queda igual que si se hubiera hecho
desde la interfaz.
"""

import logging
import shutil
import threading
import time
from datetime import datetime

from core import dinero, paths, telegram_notifier
from core.db import get_active_db_path, get_db
from core.version import __version__

log = logging.getLogger(__name__)

# Momento en que arrancó este proceso: es el «activo desde hace» de /estado.
_ARRANQUE = time.time()

# (comando, ayuda corta). El orden es el del menú de Telegram y el de /ayuda.
COMANDOS = (
    ("status", "Estado del servidor: base de datos, disco, copias, hilos"),
    ("cartera", "Valor, invertido y resultado de la cartera"),
    ("activos", "Precio y variación de cada activo"),
    ("precio", "Cotización de un activo: /precio btc"),
    ("alertas", "Alertas de precio activas (se crean desde la web)"),
    ("backup", "Hacer una copia de seguridad ahora"),
    ("backups", "Últimas copias de seguridad"),
    ("proveedores", "Llamadas de hoy a cada proveedor de cotizaciones"),
    ("ping", "Comprobar que el bot responde"),
    ("comandos", "Lista de los comandos disponibles"),
    ("ayuda", "Lo mismo que /comandos"),
)


# ── Utilidades ────────────────────────────────────────────────────────────────

def _duracion(segundos: float) -> str:
    segundos = int(segundos)
    dias, resto = divmod(segundos, 86400)
    horas, resto = divmod(resto, 3600)
    minutos = resto // 60
    if dias:
        return f"{dias} d {horas} h"
    if horas:
        return f"{horas} h {minutos} min"
    return f"{minutos} min" if minutos else f"{segundos} s"


def _tamano(bytes_) -> str:
    if bytes_ >= 1024 ** 3:
        return f"{bytes_ / 1024 ** 3:.1f} GB".replace(".", ",")
    return f"{bytes_ / 1024 ** 2:.1f} MB".replace(".", ",")


def _numero(valor, decimales=2) -> str:
    return dinero.aTextoEs(valor, decimales=decimales)


# ── Activos ───────────────────────────────────────────────────────────────────

def _activos():
    return get_db().execute(
        "SELECT id, name, symbol, market_provider, market_symbol, finnhub_symbol, price, currency, "
        "change, last_updated FROM activos ORDER BY sort_order, symbol"
    ).fetchall()


def buscar_activo(texto: str):
    """(activo, error): el activo que mejor encaja con `texto`, o por qué no hay uno.

    Coincidencia exacta con id, ticker o nombre primero; si no la hay, por
    trozo del nombre. Con varias candidatas no adivina: las lista.
    """
    buscado = (texto or "").strip().lower()
    if not buscado:
        return None, "Dime de qué activo hablas."

    todos = _activos()
    exactos = [
        a for a in todos
        if buscado in (a["id"].lower(), str(a["symbol"]).lower(), str(a["market_symbol"]).lower(),
                       str(a["name"]).lower())
    ]
    candidatos = exactos or [
        a for a in todos if buscado in str(a["name"]).lower() or buscado in str(a["symbol"]).lower()
    ]

    if not candidatos:
        return None, f"No encuentro ningún activo que se parezca a «{texto}». Prueba /activos."
    if len(candidatos) > 1:
        nombres = ", ".join(a["name"] or a["id"] for a in candidatos[:6])
        return None, f"«{texto}» encaja con varios: {nombres}. Sé más concreto."
    return candidatos[0], None


def _linea_activo(a) -> str:
    cambio = str(a["change"] or "").strip()
    return f"{a['name'] or a['id']} · {a['price']} {a['currency']}" + (f" ({cambio})" if cambio else "")


def cmd_activos(_args):
    filas = _activos()
    if not filas:
        return "No hay activos en esta cartera."
    return "📈 Activos\n" + "\n".join(_linea_activo(a) for a in filas[:40])


def cmd_precio(args):
    activo, error = buscar_activo(" ".join(args))
    if error:
        return error

    simbolo = str(activo["market_symbol"] or activo["finnhub_symbol"] or "").strip()
    if simbolo:
        from stores.helpers import normalize_currency_code
        from stores.market_data import fetch_asset_quote

        moneda = normalize_currency_code(activo["currency"], fallback="EUR")
        quote, fallo = fetch_asset_quote(simbolo, activo["market_provider"], target_currency=moneda)
        if not fallo and quote:
            cambio = str(quote.get("change") or "").strip()
            return (f"💹 {activo['name'] or activo['id']}\n"
                    f"{quote['price']} {quote.get('currency') or moneda}" + (f" ({cambio})" if cambio else ""))
        log.info("[telegram] /precio %s sin cotización en vivo: %s", activo["id"], fallo)

    guardado = f" (último guardado: {activo['last_updated']})" if activo["last_updated"] else ""
    return f"💹 {_linea_activo(activo)}{guardado}\nNo he podido pedir la cotización en vivo."


# ── Cartera ───────────────────────────────────────────────────────────────────

def cmd_cartera(_args):
    from admin.portfolios_manager import get_portfolios
    from stores import resumen_cartera

    pid = get_active_db_path().stem
    nombre = next(
        (p.get("name") for p in (get_portfolios() or {}).get("portfolios", []) if p.get("id") == pid), pid
    )
    return resumen_cartera.formatear(nombre or pid, resumen_cartera.calcular())


# ── Alertas ───────────────────────────────────────────────────────────────────

def _describir_alerta(a, nombres) -> str:
    nombre = nombres.get(a["assetId"], a["assetId"])
    if a["condicion"] == "var_dia":
        regla = f"variación del día ≥ {_numero(a['valor'])} %"
    else:
        decimales = 2 if dinero.aDecimal(a["valor"]) >= 1 else 6
        regla = f"precio {'≥' if a['condicion'] == 'sube_a' else '≤'} {_numero(a['valor'], decimales)}"
    nota = f" · {a['nota']}" if a["nota"] else ""
    return f"#{a['id']} {nombre}: {regla}{nota}"


def cmd_alertas(_args):
    from stores import alertas_store

    todas = alertas_store.listar()
    activas = [a for a in todas if a["activa"]]
    saltadas = [a for a in todas if not a["activa"] and a["disparada"]]
    nombres = {a["id"]: a["name"] or a["id"] for a in _activos()}

    if not activas:
        texto = "🔔 No hay alertas de precio activas.\nSe crean desde la pestaña Alertas de la ficha de cada activo."
    else:
        texto = "🔔 Alertas activas\n" + "\n".join(_describir_alerta(a, nombres) for a in activas)
    if saltadas:
        texto += f"\n\n{len(saltadas)} alerta(s) ya saltaron y esperan que las reactives desde la web."
    return texto


# ── Copias ────────────────────────────────────────────────────────────────────

def cmd_backup(_args):
    from core.bloqueo import BloqueoOcupado
    from routes.backup import _BACKUP_DIR, crear_backup_manual

    try:
        nombre = crear_backup_manual(avisar=False)
    except BloqueoOcupado:
        return "Ya hay otra copia en curso en el servidor. Inténtalo en unos segundos."
    except Exception as error:
        log.warning("[telegram] /backup ha fallado: %s", error)
        return f"❌ No se pudo hacer la copia: {str(error)[:200]}"

    try:
        peso = _tamano((_BACKUP_DIR / nombre).stat().st_size)
    except OSError:
        peso = "tamaño desconocido"
    texto = f"💾 Copia creada\n{nombre} · {peso}"
    # El zip viaja con el texto de pie; si no sale, se contesta solo con el texto.
    if telegram_notifier.responder_archivo(_BACKUP_DIR / nombre, texto):
        return None
    return texto + "\n⚠️ No he podido adjuntar el fichero."


def cmd_backups(_args):
    from routes.backup import _BACKUP_DIR, _list_backups

    copias = _list_backups()
    if not copias:
        return "No hay copias de seguridad."
    lineas = []
    for nombre in copias[:6]:
        try:
            peso = _tamano((_BACKUP_DIR / nombre).stat().st_size)
        except OSError:
            peso = "?"
        lineas.append(f"• {nombre} · {peso}")
    return f"💾 Copias ({len(copias)} en total)\n" + "\n".join(lineas)


# ── Servidor ──────────────────────────────────────────────────────────────────

def _hilos_de_fondo() -> str:
    vivos = {hilo.name for hilo in threading.enumerate()}
    nombres = (("snapshot-scheduler", "snapshots"), ("backup-scheduler", "copias"),
               ("avisos-scheduler", "avisos"), ("telegram-listener", "bot"))
    return "  ".join(f"{etiqueta} {'✓' if hilo in vivos else '✗'}" for hilo, etiqueta in nombres)


def cmd_estado(_args):
    from routes.backup import _list_backups, _parse_dt
    from routes.salud import _comprobar_bd
    from stores import alertas_store

    lineas = [f"🖥 PortfolioManager {__version__}", f"⏱ Activo desde hace {_duracion(time.time() - _ARRANQUE)}"]

    sano, detalle = _comprobar_bd()
    ruta = get_active_db_path()
    if sano:
        try:
            peso = _tamano(ruta.stat().st_size)
        except OSError:
            peso = "?"
        lineas.append(f"🗄 Base de datos: correcta ({ruta.stem}, esquema {detalle.get('esquema')}, {peso})")
    else:
        lineas.append(f"🚨 Base de datos con problemas: {detalle.get('bd')} {detalle.get('detalle', '')}".strip())

    try:
        uso = shutil.disk_usage(paths.DATA_DIR)
        lineas.append(f"💽 Disco: {_tamano(uso.free)} libres de {_tamano(uso.total)} ({uso.free * 100 // uso.total} %)")
    except OSError:
        lineas.append("💽 Disco: no se pudo medir")

    copias = _list_backups()
    if copias:
        cuando = _parse_dt(copias[0]).strftime("%d/%m/%Y %H:%M")
        lineas.append(f"💾 Última copia: {cuando} ({len(copias)} guardadas)")
    else:
        lineas.append("💾 Aún no hay copias de seguridad")

    lineas.append(f"🔔 Alertas de precio activas: {alertas_store.contar_activas()}")
    lineas.append(f"🧵 Hilos: {_hilos_de_fondo()}")

    hasta = telegram_notifier.silenciadoHasta()
    if hasta:
        lineas.append(f"🔇 Avisos silenciados hasta las {datetime.fromtimestamp(hasta).strftime('%H:%M del %d/%m')}")
    return "\n".join(lineas)


def cmd_proveedores(_args):
    from providers.api_stats import get_today_stats

    datos = get_today_stats()
    if not datos["counts"]:
        return "📡 Hoy no se ha llamado a ningún proveedor de cotizaciones."
    desglose = "\n".join(f"• {nombre}: {n}" for nombre, n in sorted(datos["counts"].items(), key=lambda x: -x[1]))
    return f"📡 Llamadas de hoy: {datos['total']}\n{desglose}"


def cmd_ping(_args):
    return "pong 🏓"


def cmd_ayuda(_args):
    return "Comandos:\n" + "\n".join(f"/{c} — {ayuda}" for c, ayuda in COMANDOS)


_MANEJADORES = {
    "status": cmd_estado, "estado": cmd_estado, "cartera": cmd_cartera, "activos": cmd_activos, "precio": cmd_precio,
    "alertas": cmd_alertas,
    "backup": cmd_backup, "backups": cmd_backups, "proveedores": cmd_proveedores,
    "ping": cmd_ping,
    "ayuda": cmd_ayuda, "comandos": cmd_ayuda, "help": cmd_ayuda,
}


def partir(texto: str):
    """(comando, [argumentos]) de «/estado@MiBot x y», o (None, []) si no es un comando."""
    texto = (texto or "").strip()
    if not texto.startswith("/"):
        return None, []
    cabeza, *args = texto.split()
    return cabeza[1:].split("@", 1)[0].lower(), args


def responder(texto: str):
    """Texto de respuesta al mensaje, o None si no es un comando."""
    comando, args = partir(texto)
    if comando is None:
        return None
    if comando == "start":
        return None  # lo contesta el listener: es el que desbloquea el bot
    manejador = _MANEJADORES.get(comando)
    if manejador is None:
        return "No conozco ese comando. /ayuda te dice cuáles hay."
    try:
        # Sin sesión ni petición: el hilo del bot trabaja sobre la cartera
        # activa, la misma que ve la web.
        return manejador(args)
    except Exception as error:
        log.warning("[telegram] /%s ha fallado: %s", comando, error, exc_info=True)
        return f"⚠️ Algo ha ido mal con /{comando}: {str(error)[:200]}"
