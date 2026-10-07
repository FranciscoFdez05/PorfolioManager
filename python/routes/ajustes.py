import datetime
import hashlib
import hmac
import io
import json
import logging
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from flask import Blueprint, Response, jsonify, request

from core import clave_copias, exportables, paths, proveedores_pausados, sesion, settings, telegram_notifier, zip_seguro
from core.copia_sqlite import copiar as copiar_sqlite
from core.db import get_active_db_path, get_db
from core.errors import registrarFalloEscritura
from core.escritura import escribirJsonAtomico, temporalPara
from core.paths import AJUSTES_JSON as _AJUSTES_JSON, API_DIR as _API_DIR, JSON_DIR
from core.secret_store import read_secret_lines, write_secret_lines
from providers import estado as estado_proveedores
from providers.api_stats import get_today_stats
from stores import app_data
from stores.cuenta_ahorro_store import normalizar_config, vinculos_de_config
from stores.cuentas_store import importar_vinculos

log = logging.getLogger(__name__)

ajustes_bp = Blueprint("ajustes", __name__)

# Claves globales (compartidas entre todos los portfolios)
_FIAT_DEFAULTS = [
    {"code": "EUR", "name": "Euro"},
    {"code": "USD", "name": "Dólar estadounidense"},
    {"code": "GBP", "name": "Libra esterlina"},
    {"code": "CHF", "name": "Franco suizo"},
    {"code": "JPY", "name": "Yen japonés"},
]

# Expuesto aparte porque routes/snapshots.py necesita el mismo valor cuando
# ajustes.json no trae uno legible, y duplicarlo dejaba los dos sitios libres
# para divergir.
DEFAULT_SNAPSHOT_MINUTES = 60

_GLOBAL_DEFAULTS = {
    "autoBackupDays": 0,
    # Si las copias llevan dentro las claves de API (cifradas con la contraseña de la web).
    "backupIncluirClaves": False,
    "staleHours": 24,
    "autoRefreshMinutes": 0,
    "snapshotMinutes": DEFAULT_SNAPSHOT_MINUTES,
    # Qué portfolios cubre el hilo de snapshots del servidor: solo el activo
    # (lo que hacía el navegador) o todos.
    "snapshotAlcance": "activo",
    "theme": "default",
    "sidebarCollapsed": False,
    "monedaBase": "EUR",
    "fiatCurrencies": _FIAT_DEFAULTS,
    "precioDecimalesAcciones": 2,
    "precioDecimalesEtf": 2,
    "precioDecimalesComoditis": 2,
    "precioDecimalesCripto": 4,
    "soloHorarioMercado": False,
    "soloMercadoTipos": ["acciones", "etfs", "comoditis"],
    "bloqueoInactividad": 0,
    "numLocale": "es-ES",
    "dateFormat": "DD/MM/YYYY",
    "maxBackups": 0,
    # Qué tipos de aviso se mandan por Telegram: {categoria: bool}. Vacío = los
    # de fábrica (ver core.telegram_notifier.CATEGORIAS_AVISO). Lo lee el propio
    # notificador directamente del fichero; aquí solo hace falta que la clave
    # sea conocida para que guardar otros ajustes no la descarte.
    "telegramAvisos": {},
    "telegramResumenHora": telegram_notifier.RESUMEN_HORA_DEFECTO,
    # Proveedores de cotizaciones pausados desde Ajustes > API (ver
    # core.proveedores_pausados).
    "apisPausadas": [],
}

# Claves por portfolio (cada DB tiene su propio archivo prefs_{id}.json)
_PORTFOLIO_DEFAULTS = {
    "hiddenAssets": [],
    "comparativaExcluded": [],
    "gastosHiddenTipos": [],
    "gastosHiddenMensualidades": [],
    "gastosMostrarPausadas": False,
    "metricasActivosHidden": [],
    "metricasDisplayType": "doughnut",
    "metricasDistMetric": "netoActualEur",
    "metricasSectionsCollapsed": [],
    "topMetricsConfig": {},
    "modulosConfig": {},
    "ahorroConfig": {"objetivoAhorro": 30, "presupuesto": {}},
    # Cuentas de ahorro: por cada una, qué cuentas remuneradas y dividendos
    # cuentan, el objetivo y la aportación mensual (ver stores.cuenta_ahorro_store).
    "cuentaAhorroConfig": {},
    # Último mes con aportación automática creada, por cuenta. Solo lo escribe el
    # servidor (no se lee ni se acepta desde la web): ver aplicar_recurrentes.
    "cuentaAhorroGenerado": {},
}

_GLOBAL_KEYS    = set(_GLOBAL_DEFAULTS)
_PORTFOLIO_KEYS = set(_PORTFOLIO_DEFAULTS)


def _active_portfolio_id() -> str:
    return get_active_db_path().stem


def _prefs_path(portfolio_id: str) -> Path:
    return JSON_DIR / f"prefs_{portfolio_id}.json"


def _tipo_compatible(valor, defecto) -> bool:
    if isinstance(defecto, bool):
        return isinstance(valor, bool)
    if isinstance(defecto, (int, float)):
        return isinstance(valor, (int, float)) and not isinstance(valor, bool)
    return isinstance(valor, type(defecto))


def _sanear(guardado, defaults: dict) -> dict:
    """Los valores guardados que tienen la forma esperada; el resto, de fábrica.

    Filtrar solo por clave no bastaba: un `ajustes.json` importado con
    `"fiatCurrencies": ["x"]` pasaba el filtro y dejaba POST /api/settings en
    500 para siempre, sin forma de arreglarlo desde la interfaz. Se valida al
    leer, y no al importar, porque así da igual por dónde llegó el fichero
    (importación, restauración de una copia o edición a mano).
    """
    if not isinstance(guardado, dict):
        return dict(defaults)
    limpio = dict(defaults)
    for clave, valor in guardado.items():
        if clave not in defaults or not _tipo_compatible(valor, defaults[clave]):
            continue
        if clave == "fiatCurrencies":
            if not valor or not all(
                isinstance(c, dict) and isinstance(c.get("code"), str) and isinstance(c.get("name"), str)
                for c in valor
            ):
                continue
        elif isinstance(valor, list):
            # Todas las demás listas de ajustes son de cadenas (ids, tipos,
            # categorías); un número o un objeto ahí rompía un `in {…}`.
            valor = [v for v in valor if isinstance(v, str)]
        limpio[clave] = valor
    return limpio


def _read_ajustes():
    if not _AJUSTES_JSON.exists():
        return dict(_GLOBAL_DEFAULTS)
    try:
        return _sanear(json.loads(_AJUSTES_JSON.read_text("utf-8")), _GLOBAL_DEFAULTS)
    except Exception:
        return dict(_GLOBAL_DEFAULTS)


def _atomic_write_json(path: Path, data) -> None:
    """Escribe JSON de forma atómica y durable: tmp → fsync → rename.

    write_text() directo truncaba el fichero antes de escribirlo: un fallo a
    mitad dejaba un JSON inválido y _read_ajustes/_read_prefs caen al valor por
    defecto en silencio, es decir, todos los ajustes perdidos sin aviso.

    La mecánica vive ahora en core/escritura.py, que es de donde la toman
    también los backups y portfolios.json: era el mismo procedimiento escrito
    de tres formas distintas, y solo una de las tres era correcta.
    """
    escribirJsonAtomico(path, data)


def _write_ajustes(data):
    _atomic_write_json(_AJUSTES_JSON, data)


def _read_prefs(portfolio_id: str) -> dict:
    path = _prefs_path(portfolio_id)
    if not path.exists():
        # Migración: extraer claves por-portfolio desde ajustes.json si existen
        try:
            raw = json.loads(_AJUSTES_JSON.read_text("utf-8")) if _AJUSTES_JSON.exists() else {}
            return _sanear(raw, _PORTFOLIO_DEFAULTS)
        except Exception:
            pass
        return dict(_PORTFOLIO_DEFAULTS)
    try:
        # Filtrar a las claves conocidas y con la forma esperada, igual que
        # _read_ajustes: un prefs importado podía inyectar claves arbitrarias
        # que luego se reescriben, o valores que tumbaban el guardado.
        return _sanear(json.loads(path.read_text("utf-8")), _PORTFOLIO_DEFAULTS)
    except Exception:
        return dict(_PORTFOLIO_DEFAULTS)


def _write_prefs(portfolio_id: str, data: dict):
    _atomic_write_json(_prefs_path(portfolio_id), data)


def _opcion(valor, permitidos, defecto):
    """`valor` si es una de las cadenas permitidas; si no, `defecto`.

    `valor in {…}` con una lista u objeto lanza TypeError (no son hashables), y
    eso era un 500 al guardar ajustes con `{"theme": [1]}`.
    """
    return valor if isinstance(valor, str) and valor in permitidos else defecto


def _as_int(value, default, allowed=None):
    """int() tolerante. Un valor no numérico en ajustes.json (o en el JSON de un
    import) reventaba GET /api/settings con un 500 permanente que dejaba la app
    inutilizable, porque no había forma de corregir el ajuste desde la UI."""
    try:
        result = int(value)
    except (TypeError, ValueError):
        return default
    if allowed is not None and result not in allowed:
        return default
    return result


# Los tres ficheros de claves, por el nombre con el que los pide la interfaz.
_FICHEROS_CLAVES = {
    "finnhub": "finnhub.key",
    "eodhd": "eodhd.key",
    "alphavantage": "alphavantage.key",
}


def _fichero_de_claves(proveedor):
    """Ruta del fichero del proveedor, o None si el nombre no es de los tres.

    El nombre llega en el cuerpo de la petición: sin contrastarlo contra los
    tres conocidos sería una forma de señalar cualquier fichero del disco.
    """
    nombre = _FICHEROS_CLAVES.get(str(proveedor or "").strip().lower())
    return (_API_DIR / nombre) if nombre else None


def _huella_clave(clave: str) -> str:
    """Identificador estable de una clave que no permite reconstruirla."""
    return hashlib.sha256(clave.encode("utf-8")).hexdigest()[:16]


def _enmascarar_clave(clave):
    """Lo justo para reconocer una clave sin enseñarla.

    Con las puntas se distingue una clave de otra —que es lo que hace falta para
    saber cuál de ellas es la que está fallando— sin dejar el valor entero
    legible en pantalla a la espalda de cualquiera. El relleno usa guiones y no
    el carácter «•»: al borrar una clave hay que teclear esta máscara tal cual
    para confirmar, y «•» no está en ningún teclado.
    """
    if len(clave) <= 8:
        # Demasiado corta para dejar puntas sin regalar media clave.
        return "-" * len(clave)
    return f"{clave[:4]}{'-' * 6}{clave[-4:]}"


def _read_key_file(path):
    """Claves del fichero, descifrando si está en formato cifrado."""
    return "\n".join(read_secret_lines(path))


def _write_key_file(path, value):
    write_secret_lines(path, str(value).splitlines())


def _append_key_file(path, value):
    existing = read_secret_lines(path)
    new_key = str(value).strip()
    if new_key and new_key not in existing:
        existing.append(new_key)
    write_secret_lines(path, existing)


@ajustes_bp.route("/api/settings", methods=["GET"])
def get_settings():
    pid  = _active_portfolio_id()
    gcfg = _read_ajustes()
    pcfg = _read_prefs(pid)
    finnhub_raw      = _read_key_file(_API_DIR / "finnhub.key")
    eodhd_raw        = _read_key_file(_API_DIR / "eodhd.key")
    alphavantage_raw = _read_key_file(_API_DIR / "alphavantage.key")
    return jsonify({
        "ok":                    True,
        "finnhubKeyCount":       len([k for k in finnhub_raw.splitlines() if k.strip()]),
        "eodhdKeyCount":         len([k for k in eodhd_raw.splitlines() if k.strip()]),
        "alphaVantageKeyCount":  len([k for k in alphavantage_raw.splitlines() if k.strip()]),
        # Globales
        "autoBackupDays":        _as_int(gcfg.get("autoBackupDays"), 0),
        "backupIncluirClaves":   bool(gcfg.get("backupIncluirClaves", False)),
        "backupContrasena":      clave_copias.configurada(),
        "staleHours":            _as_int(gcfg.get("staleHours"), 24),
        "autoRefreshMinutes":    _as_int(gcfg.get("autoRefreshMinutes"), 0),
        "snapshotMinutes":       _as_int(gcfg.get("snapshotMinutes"), 60),
        "snapshotAlcance":       gcfg.get("snapshotAlcance") or "activo",
        "snapshotServidor":      settings.snapshotServidorActivo(),
        "theme":                 gcfg.get("theme") or "default",
        "sidebarCollapsed":      bool(gcfg.get("sidebarCollapsed", False)),
        "monedaBase":            gcfg.get("monedaBase") or "EUR",
        "precioDecimalesAcciones":  _as_int(gcfg.get("precioDecimalesAcciones"), 2),
        "precioDecimalesEtf":       _as_int(gcfg.get("precioDecimalesEtf"), 2),
        "precioDecimalesComoditis": _as_int(gcfg.get("precioDecimalesComoditis"), 2),
        "precioDecimalesCripto":    _as_int(gcfg.get("precioDecimalesCripto"), 4),
        "soloHorarioMercado":       bool(gcfg.get("soloHorarioMercado", False)),
        "soloMercadoTipos":         gcfg.get("soloMercadoTipos") or ["acciones", "etfs", "comoditis"],
        "bloqueoInactividad":       _as_int(gcfg.get("bloqueoInactividad"), 0),
        "numLocale":                gcfg.get("numLocale") or "es-ES",
        "dateFormat":               gcfg.get("dateFormat") or "DD/MM/YYYY",
        "maxBackups":               _as_int(gcfg.get("maxBackups"), 0),
        # Por-portfolio
        "hiddenAssets":             pcfg.get("hiddenAssets") or [],
        "comparativaExcluded":      pcfg.get("comparativaExcluded") or [],
        "gastosHiddenTipos":        pcfg.get("gastosHiddenTipos") or [],
        "gastosHiddenMensualidades": pcfg.get("gastosHiddenMensualidades") or [],
        "gastosMostrarPausadas":    bool(pcfg.get("gastosMostrarPausadas", False)),
        "metricasActivosHidden":    pcfg.get("metricasActivosHidden") or [],
        "metricasDisplayType":      pcfg.get("metricasDisplayType") or "doughnut",
        "metricasDistMetric":       pcfg.get("metricasDistMetric") or "netoActualEur",
        "metricasSectionsCollapsed": pcfg.get("metricasSectionsCollapsed") or [],
        "topMetricsConfig":         pcfg.get("topMetricsConfig") or {},
        "modulosConfig":            pcfg.get("modulosConfig") or {},
        "ahorroConfig":             pcfg.get("ahorroConfig") or {"objetivoAhorro": 30, "presupuesto": {}},
        "cuentaAhorroConfig":       normalizar_config(pcfg.get("cuentaAhorroConfig")),
    })


@ajustes_bp.route("/api/settings/apikeys", methods=["GET"])
def list_api_keys():
    """Las claves de cada proveedor, y —lo importante— de dónde salen.

    Hasta aquí la interfaz solo sabía **cuántas** claves había. Con varias
    configuradas —y con el proveedor recorriéndolas cuando una se queda sin
    cuota— «2 claves» no dice cuáles son ni si la que falla sigue ahí.

    Y cada proveedor dice su `origen`: manda el fichero, y la variable de
    entorno del `.env` es el respaldo para cuando no hay ninguna guardada. Hasta
    la 1.5.0 era al revés y la precedencia no se veía por ningún lado, así que
    se podían añadir y borrar claves aquí, ver la lista actualizarse, y que la
    aplicación siguiera usando otra distinta. Ahora manda lo que se ve, y si
    queda alguna clave del entorno sin usar, se dice.

    Solo va la máscara y una huella de cada clave, no su valor. Antes se mandaba
    también el valor completo para que el ojo la descubriera sin preguntar; eso
    dejaba todas las claves en la memoria de la pestaña y en las herramientas de
    desarrollo cada vez que se abría Ajustes. El valor se pide ahora clave a
    clave, al pulsar el ojo (POST /api/settings/apikey/ver), y la huella basta
    para identificarla al borrarla.
    """
    proveedores = {}

    for proveedor in _FICHEROS_CLAVES:
        origen = app_data.readApiKeysConOrigen(proveedor)
        proveedores[proveedor] = {
            "origen": origen["origen"],
            "variable": origen["variable"],
            "fichero": _FICHEROS_CLAVES[proveedor],
            "ignoradas": origen["ignoradas"],
            "claves": [
                {
                    "indice": indice,
                    "vista": _enmascarar_clave(clave),
                    "huella": _huella_clave(clave),
                    "longitud": len(clave),
                }
                for indice, clave in enumerate(origen["claves"])
            ],
        }

    respuesta = jsonify({"ok": True, "proveedores": proveedores})
    # Lleva secretos dentro: que no se quede en ninguna caché intermedia.
    respuesta.headers["Cache-Control"] = "no-store"
    return respuesta


@ajustes_bp.route("/api/settings/apikey/ver", methods=["POST"])
def ver_api_key():
    """El valor completo de UNA clave, identificada por su huella.

    POST y no GET para que pase por el CSRF y no quede en ningún historial ni
    caché: devuelve un secreto.
    """
    datos = request.get_json(silent=True)
    datos = datos if isinstance(datos, dict) else {}
    proveedor = datos.get("proveedor")
    huella = datos.get("huella")

    if proveedor not in _FICHEROS_CLAVES or not isinstance(huella, str):
        return jsonify({"ok": False, "error": "Petición incorrecta"}), 400

    for clave in app_data.readApiKeysConOrigen(proveedor)["claves"]:
        if hmac.compare_digest(_huella_clave(clave), huella):
            respuesta = jsonify({"ok": True, "clave": clave})
            respuesta.headers["Cache-Control"] = "no-store"
            return respuesta

    return jsonify({"ok": False, "error": "Esa clave ya no está guardada"}), 404


@ajustes_bp.route("/api/settings/apikey", methods=["POST"])
def append_api_key():
    data = request.get_json(silent=True) or {}
    if data.get("finnhubKey"):
        _append_key_file(_API_DIR / "finnhub.key", str(data["finnhubKey"]).strip())
    if data.get("eodhdKeys"):
        _append_key_file(_API_DIR / "eodhd.key", str(data["eodhdKeys"]).strip())
    if data.get("alphaVantageKeys"):
        _append_key_file(_API_DIR / "alphavantage.key", str(data["alphaVantageKeys"]).strip())
    return jsonify({
        "ok":               True,
        "finnhubKeys":      len([k for k in _read_key_file(_API_DIR / "finnhub.key").splitlines() if k.strip()]),
        "eodhdKeys":        len([k for k in _read_key_file(_API_DIR / "eodhd.key").splitlines() if k.strip()]),
        "alphaVantageKeys": len([k for k in _read_key_file(_API_DIR / "alphavantage.key").splitlines() if k.strip()]),
    })


@ajustes_bp.route("/api/settings/apikey", methods=["DELETE"])
def delete_api_key():
    """Quita una clave del fichero de su proveedor.

    Se borra **por valor, no por posición**. La lista que el usuario tiene
    delante puede haberse quedado atrás —otra pestaña, otra sesión, una clave
    añadida entretanto— y con un índice viejo se borraría la clave equivocada
    sin que nada lo advirtiera. Por valor, o coincide o no se toca nada.

    La clave va en el cuerpo y no en la URL para no dejarla escrita en los logs
    del proxy ni en el historial del navegador, que es donde acaban las rutas.
    """
    datos = request.get_json(silent=True) or {}
    fichero = _fichero_de_claves(datos.get("proveedor"))

    if fichero is None:
        return jsonify({"ok": False, "error": "Proveedor desconocido"}), 400

    claves = read_secret_lines(fichero)
    # Se identifica por la huella que da el listado (el listado ya no lleva el
    # valor). Se sigue aceptando el valor tal cual para quien lo tenga.
    huella = datos.get("huella")
    if isinstance(huella, str) and huella:
        clave = next((c for c in claves if hmac.compare_digest(_huella_clave(c), huella)), "")
    else:
        clave = str(datos.get("clave") or "").strip()

    if not clave or clave not in claves:
        # También cae aquí una clave que viene del entorno: esa no está en el
        # fichero y no se puede quitar desde aquí, sino del `.env` del servidor.
        return jsonify({"ok": False, "error": "Esa clave ya no está guardada"}), 404

    restantes = [existente for existente in claves if existente != clave]
    write_secret_lines(fichero, restantes)
    log.info("Clave de API eliminada de %s; quedan %s", fichero.name, len(restantes))

    return jsonify({"ok": True, "restantes": len(restantes)})


@ajustes_bp.route("/api/stats/api-calls", methods=["GET"])
def get_api_call_stats():
    return jsonify({"ok": True, **get_today_stats()})


@ajustes_bp.route("/api/stats/api-estado", methods=["GET"])
def get_api_estado():
    """Estado de cada proveedor: operativo, sin clave, sin cuota o caído.

    `?forzar=1` salta la caché. Se deja fuera de la comprobación automática
    porque cada sondeo gasta cuota real: la pantalla pide el estado cacheado y
    solo se fuerza cuando el usuario lo pide a mano.
    """
    forzar = str(request.args.get("forzar", "")).strip().lower() in ("1", "true", "si", "sí")
    try:
        return jsonify({"ok": True, **estado_proveedores.obtener(forzar=forzar)})
    except Exception as error:
        log.warning("No se pudo comprobar el estado de los proveedores: %s", error)
        return jsonify({"ok": False, "error": str(error)[:200]}), 500


@ajustes_bp.route("/api/settings/apis-pausadas", methods=["POST"])
def save_api_pausada():
    """Pausa o reanuda un proveedor de cotizaciones: {proveedor, pausada}."""
    data = request.get_json(silent=True) or {}
    proveedor = str(data.get("proveedor") or "").strip().lower()
    if proveedor not in proveedores_pausados.PAUSABLES:
        return jsonify({"ok": False, "error": "Ese proveedor no se puede pausar"}), 400

    pausados = set(proveedores_pausados.pausados())
    if data.get("pausada"):
        pausados.add(proveedor)
    else:
        pausados.discard(proveedor)

    gcfg = _read_ajustes()
    gcfg["apisPausadas"] = [p for p in proveedores_pausados.PAUSABLES if p in pausados]
    try:
        _write_ajustes(gcfg)
    except OSError as error:
        mensaje = registrarFalloEscritura(log, "No se pudo guardar la pausa del proveedor", error, _AJUSTES_JSON)
        return jsonify({"ok": False, "error": mensaje}), 500
    return jsonify({"ok": True, "pausados": gcfg["apisPausadas"]})


@ajustes_bp.route("/api/settings/telegram", methods=["GET"])
def get_telegram_settings():
    token, chat_id = telegram_notifier.leerConfig()
    activos = telegram_notifier.preferencias()
    return jsonify({
        "ok": True,
        "configurado": bool(token) and bool(chat_id),
        # Igual que /api/settings/apikeys: solo la máscara. Con el token del bot
        # se lee y se escribe en el chat del usuario; mandarlo entero lo dejaba
        # en la memoria de la pestaña cada vez que se abría Ajustes. Para
        # cambiarlo se escribe uno nuevo; guardar con el campo vacío conserva
        # el que hay.
        "hayToken": bool(token),
        "tokenVista": _enmascarar_clave(token) if token else "",
        "chatId": chat_id,
        "avisos": [
            {"clave": clave, "titulo": titulo, "activo": activos[clave]}
            for clave, (titulo, _defecto) in telegram_notifier.CATEGORIAS_AVISO.items()
        ],
        "resumenHora": telegram_notifier.resumenHora(),
        "silenciadoHasta": telegram_notifier.silenciadoHasta(),
    })


@ajustes_bp.route("/api/settings/telegram/avisos", methods=["POST"])
def save_telegram_avisos():
    """Qué tipos de aviso se mandan y a qué hora sale el resumen diario."""
    data = request.get_json(silent=True) or {}
    gcfg = _read_ajustes()

    if "avisos" in data:
        raw = data["avisos"]
        if not isinstance(raw, dict):
            return jsonify({"ok": False, "error": "«avisos» debe ser un objeto {categoría: true/false}"}), 400
        # Solo categorías conocidas: lo demás se descarta en vez de guardarse
        # como una clave que nada lee.
        actuales = telegram_notifier.preferencias()
        for clave in telegram_notifier.CATEGORIAS_AVISO:
            if clave in raw:
                actuales[clave] = bool(raw[clave])
        gcfg["telegramAvisos"] = actuales

    if "resumenHora" in data:
        gcfg["telegramResumenHora"] = max(0, min(23, _as_int(data["resumenHora"], telegram_notifier.RESUMEN_HORA_DEFECTO)))

    try:
        _write_ajustes(gcfg)
    except OSError as error:
        mensaje = registrarFalloEscritura(log, "No se pudieron guardar los avisos de Telegram", error, _AJUSTES_JSON)
        return jsonify({"ok": False, "error": mensaje}), 500
    return jsonify({"ok": True})


@ajustes_bp.route("/api/settings/telegram", methods=["POST"])
def save_telegram_settings():
    data = request.get_json(silent=True) or {}
    token = str(data.get("token") or "").strip()
    chat_id = str(data.get("chatId") or "").strip()
    if not token:
        # El formulario ya no recibe el token guardado (solo su máscara): vacío
        # significa «el que hay».
        token, _chat_guardado = telegram_notifier.leerConfig()
    if not token or not chat_id:
        return jsonify({"ok": False, "error": "Rellena el token del bot y el ID de chat"}), 400
    telegram_notifier.escribirConfig(token, chat_id)
    return jsonify({"ok": True})


@ajustes_bp.route("/api/settings/telegram", methods=["DELETE"])
def delete_telegram_settings():
    telegram_notifier.borrarConfig()
    return jsonify({"ok": True})


@ajustes_bp.route("/api/settings/telegram/prueba", methods=["POST"])
def test_telegram_settings():
    ok, error = telegram_notifier.enviarPrueba()
    if not ok:
        return jsonify({"ok": False, "error": error}), 400
    return jsonify({"ok": True})


# ── Normalización de lo que llega a POST /api/settings ──────────────────────
# Una entrada por ajuste: clave → función (valor recibido, cfg) → valor a
# guardar, o _SIN_CAMBIO para dejar el que había. Antes era una cadena de ~40
# `if "clave" in data:` en una sola función de complejidad 72; así, añadir un
# ajuste es añadir una línea y cada regla se lee sola.
_SIN_CAMBIO = object()
_DECIMALES_PRECIO = {2, 4, 6, 8}
_TIPOS_SOLO_MERCADO = {"acciones", "etfs", "comoditis", "cripto"}
_MODULOS = {
    "panelSuperior", "vistaGeneral", "activos", "gastos",
    "finanzas", "cripto", "planes", "herramientas", "metricas",
}


def _acotado(minimo, maximo, defecto):
    return lambda valor, _cfg: max(minimo, min(maximo, _as_int(valor, defecto)))


def _entero_de(permitidos, defecto):
    return lambda valor, _cfg: _as_int(valor, defecto, permitidos)


def _una_de(permitidas, defecto):
    return lambda valor, _cfg: _opcion(valor, permitidas, defecto)


def _booleano(valor, _cfg):
    return bool(valor)


def _lista_de_textos(valor, _cfg):
    return [str(t) for t in valor if isinstance(t, str) and t.strip()] if isinstance(valor, list) else []


def _alcance_snapshot(valor, _cfg):
    alcance = str(valor).strip().lower()
    return alcance if alcance in {"activo", "todos"} else "activo"


def _divisas(valor, _cfg):
    if not isinstance(valor, list):
        return _SIN_CAMBIO
    validas, vistas = [], set()
    for item in valor:
        if not isinstance(item, dict):
            continue
        code = str(item.get("code", "")).strip().upper()
        name = str(item.get("name", "")).strip()
        if code and name and code.isalpha() and 2 <= len(code) <= 5 and code not in vistas:
            validas.append({"code": code, "name": name})
            vistas.add(code)
    return validas or _SIN_CAMBIO


def _moneda_base(valor, cfg):
    # Depende de las divisas ya aplicadas: va detrás de fiatCurrencies en la tabla.
    codigos = {c["code"] for c in cfg.get("fiatCurrencies", _FIAT_DEFAULTS)}
    return str(valor) if str(valor) in codigos else "EUR"


def _tipos_solo_mercado(valor, _cfg):
    return [t for t in valor if _opcion(t, _TIPOS_SOLO_MERCADO, None)] if isinstance(valor, list) else []


def _inactividad(valor, _cfg):
    # La lista de valores vive en core/sesion.py: es quien la aplica en el
    # servidor, y el navegador solo la imita para cerrar la pestaña abierta.
    return _as_int(valor, 0, set(sesion.INACTIVIDAD_OPCIONES))


def _activos_ocultos(valor, _cfg):
    return [str(i) for i in valor if i and isinstance(i, (str, int))] if isinstance(valor, list) else []


def _mapa_booleanos(permitidas=None):
    def normalizar(valor, _cfg):
        if not isinstance(valor, dict):
            return _SIN_CAMBIO
        return {k: bool(v) for k, v in valor.items()
                if isinstance(k, str) and (permitidas is None or k in permitidas)}
    return normalizar


def _porcentaje(valor, defecto):
    try:
        return max(0.0, min(100.0, float(valor)))
    except (ValueError, TypeError):
        return defecto


def _config_ahorro(valor, _cfg):
    if not isinstance(valor, dict):
        return _SIN_CAMBIO
    crudo = valor.get("presupuesto", {})
    presupuesto = {}
    if isinstance(crudo, dict):
        for clave, importe in crudo.items():
            limpia = str(clave)[:80].strip()
            if limpia:
                presupuesto[limpia] = _porcentaje(importe, 0.0)
    return {"objetivoAhorro": _porcentaje(valor.get("objetivoAhorro", 30), 30.0), "presupuesto": presupuesto}


def _config_cuenta_ahorro(valor, _cfg):
    if not isinstance(valor, dict):
        return _SIN_CAMBIO
    # Una configuración antigua (importada, o de una pestaña sin recargar) aún
    # puede traer remuneradas: pasan a la base antes de que la normalización las quite.
    pares = vinculos_de_config(valor)
    if pares:
        importar_vinculos(pares)
    return normalizar_config(valor)


_NORMALIZADORES_GLOBALES = {
    "autoBackupDays": _acotado(0, 365, 0),
    "backupIncluirClaves": lambda valor, _cfg: valor is True,
    "staleHours": _acotado(1, 8760, 24),
    "autoRefreshMinutes": _entero_de({0, 1, 5, 15, 30, 60}, 0),
    "snapshotMinutes": _entero_de({0, 1, 5, 15, 30, 60, 240, 1440}, 60),
    "snapshotAlcance": _alcance_snapshot,
    "theme": _una_de({"default", "black", "light"}, "default"),
    "sidebarCollapsed": _booleano,
    "fiatCurrencies": _divisas,
    "monedaBase": _moneda_base,
    "precioDecimalesAcciones": _entero_de(_DECIMALES_PRECIO, 2),
    "precioDecimalesEtf": _entero_de(_DECIMALES_PRECIO, 2),
    "precioDecimalesComoditis": _entero_de(_DECIMALES_PRECIO, 2),
    "precioDecimalesCripto": _entero_de(_DECIMALES_PRECIO, 2),
    "soloHorarioMercado": _booleano,
    "soloMercadoTipos": _tipos_solo_mercado,
    "bloqueoInactividad": _inactividad,
    "numLocale": _una_de({"es-ES", "en-US", "fr-FR"}, "es-ES"),
    "dateFormat": _una_de({"DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"}, "DD/MM/YYYY"),
    "maxBackups": _entero_de({0, 5, 10, 20, 50}, 0),
}

_NORMALIZADORES_PORTFOLIO = {
    "hiddenAssets": _activos_ocultos,
    "metricasDisplayType": _una_de({"doughnut", "bar"}, "doughnut"),
    "metricasDistMetric": _una_de({"netoActualEur", "invertidoEur", "rendimientoEur"}, "netoActualEur"),
    "comparativaExcluded": _lista_de_textos,
    "gastosHiddenTipos": _lista_de_textos,
    "gastosHiddenMensualidades": _lista_de_textos,
    "metricasActivosHidden": _lista_de_textos,
    "metricasSectionsCollapsed": _lista_de_textos,
    "gastosMostrarPausadas": _booleano,
    "topMetricsConfig": _mapa_booleanos(),
    "modulosConfig": _mapa_booleanos(_MODULOS),
    "ahorroConfig": _config_ahorro,
    "cuentaAhorroConfig": _config_cuenta_ahorro,
}


def _aplicar(cfg: dict, data: dict, normalizadores: dict) -> None:
    """Aplica a `cfg`, en el orden de la tabla, los ajustes que trae `data`."""
    for clave, normalizar in normalizadores.items():
        if clave in data:
            valor = normalizar(data[clave], cfg)
            if valor is not _SIN_CAMBIO:
                cfg[clave] = valor


@ajustes_bp.route("/api/settings", methods=["POST"])
def save_settings():
    data = request.get_json(silent=True) or {}
    pid  = _active_portfolio_id()

    if data.get("finnhubKey"):
        _write_key_file(_API_DIR / "finnhub.key", str(data["finnhubKey"]).strip())
    if data.get("eodhdKeys"):
        _write_key_file(_API_DIR / "eodhd.key", str(data["eodhdKeys"]).strip())
    # Faltaba: /api/settings/apikey sí permitía añadir claves de Alpha Vantage,
    # pero guardarlas desde la pantalla de ajustes las descartaba en silencio.
    if data.get("alphaVantageKeys"):
        _write_key_file(_API_DIR / "alphavantage.key", str(data["alphaVantageKeys"]).strip())

    gcfg = _read_ajustes()
    pcfg = _read_prefs(pid)

    _aplicar(gcfg, data, _NORMALIZADORES_GLOBALES)
    _aplicar(pcfg, data, _NORMALIZADORES_PORTFOLIO)

    try:
        _write_ajustes(gcfg)
        _write_prefs(pid, pcfg)
    except OSError as e:
        # Igual que en /api/backup: si el fallo es del disco (permisos del
        # volumen en Docker, montaje de solo lectura, disco lleno), el manejador
        # genérico devolvía "Error interno del servidor" y no había forma de
        # saber por qué los ajustes no se guardaban.
        mensaje = registrarFalloEscritura(
            log, "[ajustes] No se pudieron guardar los ajustes", e, JSON_DIR
        )
        return jsonify({"ok": False, "error": mensaje}), 500
    return jsonify({"ok": True})


# Los nombres de tabla se interpolan en las consultas de export/import porque
# SQLite no admite parametrizar identificadores. Se restringen a un patrón
# seguro: una BD subida por /api/portfolios/import podría traer una tabla con
# comillas o corchetes en el nombre y romper el entrecomillado.
_SAFE_TABLE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# Nombres de fichero de prefs admisibles al importar un zip (mismo patrón que
# usa el restore de backups en routes/backup.py)
_RE_SAFE_PREFS_NAME = re.compile(r"^prefs_[A-Za-z0-9_-]{1,64}\.json$")


def _real_tables(conn) -> list:
    """Tablas de datos que existen realmente en la BD activa, en orden estable."""
    nombres = [
        r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
    ]
    seguras = [n for n in nombres if _SAFE_TABLE_RE.match(n)]
    for descartada in set(nombres) - set(seguras):
        log.warning("[export] Tabla con nombre no admitido, se omite: %r", descartada)
    return seguras


def _build_export(conn, pid: str) -> dict:
    """Volcado completo de la BD activa.

    Antes se exportaba una lista fija de 11 nombres de los que 4 ni existían
    ('gastos', 'ingresos', 'stablecoins', 'seguimiento'), y quedaban fuera
    tablas con todos los movimientos: activo_rows, activo_operation_rows,
    gastos_rows, mensualidades, ingresos_rows, intereses_v2, staking_rows,
    earn_rows, trading, renta_fija, private_market… El "export completo" perdía
    casi todos los datos. Ahora se enumera el esquema real.
    """
    export = {
        "exported_at": datetime.datetime.now(datetime.UTC).isoformat(),
        "version": 3,
        "ajustes": _read_ajustes(),
        "portfolio_prefs": _read_prefs(pid),
        "tables": {},
    }
    for table in _real_tables(conn):
        rows = conn.execute(f'SELECT * FROM "{table}"').fetchall()
        export["tables"][table] = [dict(r) for r in rows]
    return export


@ajustes_bp.route("/api/export/json", methods=["GET"])
def export_json():
    pid  = _active_portfolio_id()
    conn = get_db()
    export = _build_export(conn, pid)

    payload = json.dumps(export, ensure_ascii=False, indent=2)
    return Response(
        payload,
        mimetype="application/json",
        headers={"Content-Disposition": "attachment; filename=portfolio-export.json"}
    )


@ajustes_bp.route("/api/export/zip", methods=["GET", "POST"])
def export_zip():
    """El ZIP completo. En POST admite lo que un GET no puede llevar.

    Sigue aceptando GET —un enlace directo o un `curl` siguen valiendo—, pero
    entonces sale sin las dos cosas que dependen de quien pide: el volcado del
    `localStorage`, que solo tiene el navegador, y las claves de API, que no se
    incluyen si nadie las pide expresamente.
    """
    pid  = _active_portfolio_id()
    conn = get_db()
    export = _build_export(conn, pid)

    peticion = request.get_json(silent=True) if request.method == "POST" else None
    peticion = peticion if isinstance(peticion, dict) else {}
    ui = exportables.sanearUi(peticion.get("ui"))
    incluirClaves = bool(peticion.get("incluirClaves"))
    contrasena = peticion.get("contrasena")
    contrasena = contrasena if isinstance(contrasena, str) else ""
    if len(contrasena) > exportables.MAX_LARGO_CONTRASENA:
        return jsonify({"ok": False, "error": "La contraseña es demasiado larga"}), 400

    json_bytes = json.dumps(export, ensure_ascii=False, indent=2).encode("utf-8")

    buf = io.BytesIO()
    date_str = datetime.datetime.now().strftime("%Y-%m-%d")
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"portfolio-export-{date_str}.json", json_bytes)
        db_path = get_active_db_path()
        if db_path.exists():
            # Copia vía API de backup: zf.write() del .db en caliente puede
            # capturar páginas a medias y dejar en el zip una BD corrupta,
            # porque los cambios recientes viven aún en el fichero -wal.
            zf.writestr(f"portfolio-{date_str}.db", _consistent_db_bytes(db_path))
        if _AJUSTES_JSON.exists():
            zf.write(str(_AJUSTES_JSON), "ajustes.json")
        prefs_file = _prefs_path(pid)
        if prefs_file.exists():
            zf.write(str(prefs_file), f"prefs_{pid}.json")

        # Preferencias de la interfaz: orden de las tarjetas de Ajustes, orden
        # de cada tabla y modos de visualización. Viven en el navegador, así que
        # llegan en la petición o no llegan.
        if ui:
            zf.writestr(exportables.FICHERO_UI, json.dumps(ui, ensure_ascii=False, indent=2))

        # Las claves van EN CLARO, y por eso solo si se piden: cifradas con la
        # SECRET_KEY solo servirían para restaurar en un servidor con la misma,
        # que es justo el caso en el que no se habían perdido. Con contraseña
        # van cifradas con ella, en un fichero aparte para que la importación
        # sepa que tiene que pedirla.
        if incluirClaves:
            claves = exportables.clavesEnClaro()
            if claves and contrasena:
                paquete = exportables.cifrarClaves(claves, contrasena)
                zf.writestr(exportables.FICHERO_CLAVES_CIFRADAS, json.dumps(paquete, ensure_ascii=False, indent=2))
                log.info("[export] ZIP generado con claves de API cifradas con contraseña (%d proveedores)", len(claves))
            elif claves:
                zf.writestr(exportables.FICHERO_CLAVES, json.dumps(claves, ensure_ascii=False, indent=2))
                log.info("[export] ZIP generado CON claves de API en claro (%d proveedores)", len(claves))

    buf.seek(0)
    return Response(
        buf.read(),
        mimetype="application/zip",
        headers={"Content-Disposition": f"attachment; filename=portfolio-export-{date_str}.zip"}
    )


def _consistent_db_bytes(db_path) -> bytes:
    """Bytes de una copia consistente del .db (incluye el WAL pendiente).

    El temporal va a data/tmp. Antes se llamaba `_tmp_export_<portfolio>.db` y
    se creaba **dentro de data/portfolios**, donde todo el proyecto hace
    `glob("*.db")` para saber qué portfolios existen: exportar mientras corría
    una copia de seguridad metía la exportación a medias en el backup como si
    fuera un portfolio más.
    """
    with temporalPara(db_path, directorio=paths.TMP_DIR) as tmp:
        return copiar_sqlite(db_path, tmp, timeout=settings.dbTimeout()).read_bytes()


def _restore_tables_from_dict(conn, data: dict):
    """Restaura tablas de la BD activa desde un dict de exportación.

    Todo ocurre en UNA transacción: si algo falla se revierte por completo. La
    versión anterior ejecutaba 'DELETE FROM gastos' (tabla inexistente) fuera de
    su try/except, así que importar el propio export siempre lanzaba
    OperationalError con las tablas ya vaciadas dentro de una transacción
    abierta que nadie revertía.
    """
    tables_payload = data.get("tables")
    if not isinstance(tables_payload, dict):
        # Formato legacy: las tablas eran claves de primer nivel
        tables_payload = {k: v for k, v in data.items() if isinstance(v, list)}

    existing = set(_real_tables(conn))
    skipped = [name for name in tables_payload if name not in existing]
    if skipped:
        log.warning("[import] Tablas del fichero que no existen en el esquema, ignoradas: %s",
                    ", ".join(sorted(skipped)))

    targets = [t for t in sorted(tables_payload)
               if t in existing and isinstance(tables_payload[t], list)]

    try:
        # Aplaza la verificación de FK al commit, para poder insertar hijos antes
        # que padres sin violar las referencias.
        conn.execute("PRAGMA defer_foreign_keys=ON")

        # Pasada 1: vaciar TODO antes de insertar nada. Intercalar DELETE e
        # INSERT perdía datos: activo_rows se insertaba antes del
        # 'DELETE FROM activos' (orden alfabético) y el ON DELETE CASCADE de
        # activos borraba las filas recién insertadas. defer_foreign_keys no
        # evita eso: aplaza la comprobación de constraints, no las acciones
        # CASCADE.
        for table in targets:
            conn.execute(f'DELETE FROM "{table}"')

        # Pasada 2: insertar
        for table in targets:
            rows = tables_payload[table]
            if not rows or not isinstance(rows[0], dict):
                continue
            actual_cols = {r[1] for r in conn.execute(f'PRAGMA table_info("{table}")').fetchall()}
            valid_cols = [c for c in rows[0] if c in actual_cols]
            if not valid_cols:
                continue
            col_str      = ", ".join(f'"{c}"' for c in valid_cols)
            placeholders = ", ".join("?" for _ in valid_cols)
            conn.executemany(
                f'INSERT OR IGNORE INTO "{table}" ({col_str}) VALUES ({placeholders})',
                [[row.get(c) for c in valid_cols] for row in rows if isinstance(row, dict)],
            )
        conn.commit()
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        raise RuntimeError(f"Error restaurando datos: {e}") from e


@ajustes_bp.route("/api/import/json", methods=["POST"])
def import_json():
    f = request.files.get("file")
    if not f:
        return jsonify({"ok": False, "error": "No se recibió ningún archivo"}), 400
    try:
        data = json.loads(f.read().decode("utf-8"))
    except Exception:
        return jsonify({"ok": False, "error": "Archivo JSON inválido"}), 400

    if not isinstance(data, dict):
        return jsonify({"ok": False, "error": "Formato de archivo incorrecto"}), 400

    # Vacía y rellena las tablas de la cartera activa: es una restauración, y
    # va con las mismas garantías (cerrojo y copia previa) que /api/restore.
    from core.bloqueo import BloqueoOcupado
    from routes.backup import (
        _respuesta_bloqueo_ocupado,
        bloqueo_restauracion,
        copia_previa_obligatoria,
        respuesta_sin_copia_previa,
    )

    try:
        with bloqueo_restauracion():
            copia, copia_ok = copia_previa_obligatoria()
            if not copia_ok:
                return respuesta_sin_copia_previa()

            pid  = _active_portfolio_id()
            conn = get_db()

            if "ajustes" in data and isinstance(data["ajustes"], dict):
                _write_ajustes(data["ajustes"])
            if "portfolio_prefs" in data and isinstance(data["portfolio_prefs"], dict):
                _write_prefs(pid, data["portfolio_prefs"])

            try:
                _restore_tables_from_dict(conn, data)
            except RuntimeError as e:
                return jsonify({"ok": False, "error": str(e)}), 500
    except BloqueoOcupado:
        return _respuesta_bloqueo_ocupado()

    return jsonify({"ok": True, "copiaPrevia": copia.name if copia else None})


def _json_de_zip(zf, nombre):
    """Contenido JSON de una entrada, o ValueError si no es JSON válido."""
    try:
        return json.loads(zf.read(nombre).decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise ValueError(f"{nombre} no es un JSON válido") from error


@ajustes_bp.route("/api/import/zip", methods=["POST"])
def import_zip():
    f = request.files.get("file")
    if not f:
        return jsonify({"ok": False, "error": "No se recibió ningún archivo"}), 400

    raw_bytes = f.read()
    try:
        buf = io.BytesIO(raw_bytes)
        with zipfile.ZipFile(buf, "r") as zf:
            # Antes que testzip(), que descomprime todo para validar el CRC: un
            # ZIP de 1 MB con 1 GB de ceros llevaba el proceso a 2 GB de memoria.
            zip_seguro.comprobar(zf)
            bad = zf.testzip()
            if bad:
                return jsonify({"ok": False, "error": f"ZIP corrupto: {bad}"}), 400
            names = zf.namelist()
    except zipfile.BadZipFile:
        return jsonify({"ok": False, "error": "El archivo no es un ZIP válido"}), 400
    except zip_seguro.ZipNoAdmitido as error:
        return jsonify({"ok": False, "error": str(error)}), 400

    # Una copia de seguridad completa no es un export de una cartera: trae todas
    # las bases bajo `portfolios/`, más `portfolios.json`. Se restaura con el
    # mismo código que /api/restore. Antes se buscaba el `.db` en la raíz, no se
    # encontraba, se restauraban solo los ajustes y se respondía «ok»: la
    # pantalla decía que había ido bien y las carteras seguían como estaban.
    from routes.backup import es_backup_completo, restaurar_backup_subido

    if es_backup_completo(names):
        with temporalPara(paths.BACKUPS_DIR / "importado.zip", directorio=paths.TMP_DIR) as tmp:
            tmp.write_bytes(raw_bytes)
            return restaurar_backup_subido(tmp)

    # Claves protegidas con contraseña: se descifran ANTES de tocar nada. Si la
    # contraseña falta o falla, la respuesta lo dice y la cartera sigue como
    # estaba; el navegador la pide y vuelve a mandar el mismo ZIP. Quien no la
    # tenga puede importar el resto sin las claves (`sinClaves`).
    contrasena = request.form.get("contrasena", "")
    sin_claves = request.form.get("sinClaves", "") == "1"
    claves_descifradas = None
    entrada_cifrada = next((n for n in names if Path(n).name == exportables.FICHERO_CLAVES_CIFRADAS), None)
    if entrada_cifrada and not sin_claves:
        if not contrasena:
            return jsonify({
                "ok": False, "necesitaContrasena": True,
                "error": "El ZIP lleva las claves de API protegidas con contraseña",
            }), 400
        if len(contrasena) > exportables.MAX_LARGO_CONTRASENA:
            return jsonify({"ok": False, "error": "La contraseña es demasiado larga"}), 400
        try:
            with zipfile.ZipFile(io.BytesIO(raw_bytes), "r") as zf:
                paquete = json.loads(zf.read(entrada_cifrada).decode("utf-8"))
            claves_descifradas = exportables.descifrarClaves(paquete, contrasena)
        except (exportables.ContrasenaIncorrecta, ValueError, UnicodeDecodeError):
            log.warning("[import] Contraseña incorrecta para las claves del ZIP")
            return jsonify({"ok": False, "necesitaContrasena": True, "error": "Contraseña incorrecta"}), 400

    from core.bloqueo import BloqueoOcupado
    from routes.backup import _respuesta_bloqueo_ocupado, bloqueo_restauracion

    try:
        with bloqueo_restauracion():
            return _importar_zip(raw_bytes, claves_descifradas, sin_claves)
    except BloqueoOcupado:
        return _respuesta_bloqueo_ocupado()


class _ImportacionRechazada(Exception):
    """El ZIP no se puede importar; lleva el mensaje para el usuario."""


@dataclass
class _ContenidoImportado:
    """Lo que trae un ZIP de «Exportar ZIP», ya leído y validado."""

    nombres: list
    base: str | None = None          # entrada .db de la raíz, ya extraída al temporal
    export_json: dict | None = None  # o, en su lugar, el export JSON
    ajustes: dict | None = None
    prefs: dict = field(default_factory=dict)


_SIN_NADA_QUE_IMPORTAR = (
    "El ZIP no contiene ni una base de datos ni un export de esta aplicación. Usa el ZIP "
    "que genera «Exportar ZIP», o una copia de seguridad de Ajustes → Copias de seguridad."
)


def _leer_contenido_zip(zf, tmp_db) -> _ContenidoImportado:
    """Valida todo lo que se va a usar, sin escribir nada fuera de `tmp_db`."""
    from admin.backup_manager import problema_de_portfolio

    nombres = zf.namelist()
    contenido = _ContenidoImportado(nombres=nombres)
    # Base de datos en la raíz (formato de exportación: portfolio-{fecha}.db)
    contenido.base = next((n for n in nombres if n.endswith(".db") and "/" not in n), None)
    nombre_json = next((n for n in nombres if n.endswith(".json") and "export" in n and "/" not in n), None)
    # `ajustes.json` y las preferencias también cuentan: un zip que solo traiga
    # eso sí tiene algo que importar.
    trae_configuracion = any(
        Path(n).name == "ajustes.json" or Path(n).name.startswith("prefs_") for n in nombres
    )
    if not contenido.base and not nombre_json and not trae_configuracion:
        # Decirlo es la diferencia entre «este zip no vale» y creer que se ha
        # importado algo que en realidad sigue sin estar.
        raise _ImportacionRechazada(_SIN_NADA_QUE_IMPORTAR)

    if contenido.base:
        # A disco y no a memoria; el temporal va a data/tmp para que ningún
        # `glob("*.db")` de data/portfolios lo tome por una cartera.
        zip_seguro.extraer(zf, contenido.base, tmp_db)
        problema = problema_de_portfolio(tmp_db)
        if problema:
            raise _ImportacionRechazada(f"{contenido.base}: {problema}")
    elif nombre_json:
        contenido.export_json = _json_de_zip(zf, nombre_json)
        if not isinstance(contenido.export_json, dict):
            raise _ImportacionRechazada(f"{nombre_json} no tiene el formato de un export")

    if "ajustes.json" in nombres:
        contenido.ajustes = _json_de_zip(zf, "ajustes.json")
        if not isinstance(contenido.ajustes, dict):
            raise _ImportacionRechazada("ajustes.json no tiene el formato esperado")

    # El nombre de cada prefs se reduce a su parte final y se valida contra un
    # patrón: comprobar solo que no hubiera "/" dejaba pasar entradas como
    # "prefs_..\..\algo.json", que en Windows escriben fuera de data/JSON.
    for nombre in nombres:
        prefs_name = Path(nombre).name
        if _RE_SAFE_PREFS_NAME.match(prefs_name):
            contenido.prefs[prefs_name] = _json_de_zip(zf, nombre)
        elif prefs_name.startswith("prefs_"):
            log.warning("[import] Entrada de prefs ignorada por nombre inseguro: %r", nombre)
    return contenido


def _restaurar_claves_del_zip(zf, nombres, claves_descifradas, sin_claves) -> list:
    """Claves de API del ZIP, guardadas cifradas con la SECRET_KEY de ESTA
    instalación: ese cambio de cifrado es lo que hace que una copia sirva en un
    servidor recién montado."""
    if claves_descifradas is not None:
        return exportables.restaurarClaves(claves_descifradas)
    entrada = next((n for n in nombres if Path(n).name == exportables.FICHERO_CLAVES), None)
    if entrada and not sin_claves:
        return exportables.restaurarClaves(_json_de_zip(zf, entrada))
    return []


def _aplicar_contenido(contenido: _ContenidoImportado, tmp_db, db_path) -> None:
    """Sustituye la cartera activa y la configuración por lo importado."""
    from core.db import invalidate_all_connections

    if contenido.base:
        invalidate_all_connections()
        # Por la API de backup sobre el mismo fichero, no con un rename: así
        # no cambia el inodo bajo las conexiones de los demás procesos.
        copiar_sqlite(tmp_db, db_path)
    elif contenido.export_json is not None:
        _restore_tables_from_dict(get_db(), contenido.export_json)

    if contenido.ajustes is not None:
        escribirJsonAtomico(_AJUSTES_JSON, contenido.ajustes)
    for prefs_name, prefs in contenido.prefs.items():
        escribirJsonAtomico(_AJUSTES_JSON.parent / prefs_name, prefs)


def _importar_zip(raw_bytes, claves_descifradas, sin_claves):
    """La importación propiamente dicha, ya con el cerrojo de restauración.

    Hasta aquí no se ha escrito nada. El orden es: validar todo lo que se va a
    usar, guardar una copia del estado actual y solo entonces sustituir. Antes
    cualquier SQLite —una vacía incluida— reemplazaba la cartera activa sin
    copia previa, y los ajustes se escribían sin comprobar que fueran JSON.
    """
    from routes.backup import copia_previa_obligatoria, respuesta_sin_copia_previa

    db_path = get_active_db_path()
    try:
        with zipfile.ZipFile(io.BytesIO(raw_bytes), "r") as zf, \
                temporalPara(db_path, directorio=paths.TMP_DIR) as tmp_db:
            contenido = _leer_contenido_zip(zf, tmp_db)

            copia, copia_ok = copia_previa_obligatoria()
            if not copia_ok:
                return respuesta_sin_copia_previa()

            _aplicar_contenido(contenido, tmp_db, db_path)
            claves = _restaurar_claves_del_zip(zf, contenido.nombres, claves_descifradas, sin_claves)
            if claves:
                log.info("[import] Claves de API restauradas: %s", ", ".join(claves))
            # Preferencias de interfaz: no se guardan aquí, se devuelven para
            # que las escriba el navegador, que es donde viven.
            entrada_ui = next((n for n in contenido.nombres if Path(n).name == exportables.FICHERO_UI), None)
            ui = exportables.sanearUi(_json_de_zip(zf, entrada_ui)) if entrada_ui else {}
    except (_ImportacionRechazada, ValueError) as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

    return jsonify({"ok": True, "ui": ui, "claves": claves, "copiaPrevia": copia.name if copia else None})
