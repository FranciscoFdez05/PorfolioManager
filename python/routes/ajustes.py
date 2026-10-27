import datetime
import hashlib
import hmac
import io
import json
import logging
import re
import sqlite3
import tempfile
import zipfile
from contextlib import closing, contextmanager
from dataclasses import dataclass, field
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file

from admin.backup_manager import problemasDeIntegridad
from core import (
    clave_copias,
    dinero,
    dos_factores,
    exportables,
    paths,
    proveedores_pausados,
    sesion,
    settings,
    telegram_notifier,
    zip_seguro,
)
from core.copia_sqlite import copiar as copiarSqlite
from core.db import getActiveDbPath, getDb
from core.errors import registrarFalloEscritura
from core.escritura import escribirJsonAtomico, temporalPara
from core.paths import AJUSTES_JSON as _AJUSTES_JSON, API_DIR as _API_DIR, JSON_DIR
from core.secret_store import readSecretLines, writeSecretLines
from core.validation import jsonBody
from providers import estado as estadoProveedores
from providers.api_stats import getTodayStats
from routes import auth
from stores import app_data
from stores.cuenta_ahorro_store import normalizarConfig, vinculosDeConfig
from stores.cuentas_store import importarVinculos
from stores.paneles_config import normalizarPaneles

log = logging.getLogger(__name__)

ajustesBp = Blueprint("ajustes", __name__)

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
    # servidor (no se lee ni se acepta desde la web): ver aplicarRecurrentes.
    "cuentaAhorroGenerado": {},
    # Activos > Paneles: los paneles del usuario y sus widgets (ver
    # stores.paneles_config).
    "panelesConfig": {},
}

_GLOBAL_KEYS    = set(_GLOBAL_DEFAULTS)
_PORTFOLIO_KEYS = set(_PORTFOLIO_DEFAULTS)


def _activePortfolioId() -> str:
    return getActiveDbPath().stem


def _prefsPath(portfolioId: str) -> Path:
    return JSON_DIR / f"prefs_{portfolioId}.json"


def _tipoCompatible(valor, defecto) -> bool:
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
        if clave not in defaults or not _tipoCompatible(valor, defaults[clave]):
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


def _coercionarImportados(guardado: dict, defaults: dict, actuales: dict | None = None) -> tuple[dict, list]:
    """Ajustes de un fichero importado, con los números escritos como texto convertidos.

    `_sanear` descarta al leer lo que no tiene la forma esperada y deja el valor
    de fábrica: un `"20"` en un ajuste numérico acababa en 0 sin que nadie se
    enterase. Aquí un texto que es un número válido pasa a número, y lo que no
    se puede convertir se devuelve en la lista de ignorados para avisar.

    Args:
        guardado: Ajustes tal cual vienen en el fichero.
        defaults: Valores de fábrica, que fijan el tipo esperado de cada clave.
        actuales: Ajustes que ya hay guardados. Un valor que no vale conserva el
            de aquí (y no el de fábrica, que desactivaba cosas como el refresco
            automático); sin valor anterior, la clave se omite.

    Returns:
        `(ajustes, ignorados)`: los ajustes a guardar y los nombres de las claves
        cuyo valor no vale.
    """
    resultado = dict(guardado)
    ignorados = []
    for clave, valor in guardado.items():
        if clave not in defaults or _tipoCompatible(valor, defaults[clave]):
            continue
        defecto = defaults[clave]
        numerico = isinstance(defecto, (int, float)) and not isinstance(defecto, bool)
        numero = dinero.aDecimalONulo(valor) if numerico and isinstance(valor, str) else None
        if numero is None:
            ignorados.append(clave)
        elif isinstance(defecto, int):
            if numero != numero.to_integral_value():
                ignorados.append(clave)
            else:
                resultado[clave] = int(numero)
        else:
            resultado[clave] = float(numero)
    for clave in ignorados:
        if actuales and clave in actuales:
            resultado[clave] = actuales[clave]
        else:
            resultado.pop(clave, None)
    return resultado, ignorados


def _readAjustes():
    if not _AJUSTES_JSON.exists():
        return dict(_GLOBAL_DEFAULTS)
    try:
        return _sanear(json.loads(_AJUSTES_JSON.read_text("utf-8")), _GLOBAL_DEFAULTS)
    except Exception:
        return dict(_GLOBAL_DEFAULTS)


def _atomicWriteJson(path: Path, data) -> None:
    """Escribe JSON de forma atómica y durable: tmp → fsync → rename.

    write_text() directo truncaba el fichero antes de escribirlo: un fallo a
    mitad dejaba un JSON inválido y _readAjustes/_readPrefs caen al valor por
    defecto en silencio, es decir, todos los ajustes perdidos sin aviso.

    La mecánica vive ahora en core/escritura.py, que es de donde la toman
    también los backups y portfolios.json: era el mismo procedimiento escrito
    de tres formas distintas, y solo una de las tres era correcta.
    """
    escribirJsonAtomico(path, data)


def _writeAjustes(data):
    _atomicWriteJson(_AJUSTES_JSON, data)


def _readPrefs(portfolioId: str) -> dict:
    path = _prefsPath(portfolioId)
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
        # _readAjustes: un prefs importado podía inyectar claves arbitrarias
        # que luego se reescriben, o valores que tumbaban el guardado.
        return _sanear(json.loads(path.read_text("utf-8")), _PORTFOLIO_DEFAULTS)
    except Exception:
        return dict(_PORTFOLIO_DEFAULTS)


def _writePrefs(portfolioId: str, data: dict):
    _atomicWriteJson(_prefsPath(portfolioId), data)


def _opcion(valor, permitidos, defecto):
    """`valor` si es una de las cadenas permitidas; si no, `defecto`.

    `valor in {…}` con una lista u objeto lanza TypeError (no son hashables), y
    eso era un 500 al guardar ajustes con `{"theme": [1]}`.
    """
    return valor if isinstance(valor, str) and valor in permitidos else defecto


def _asInt(value, default, allowed=None):
    """int() tolerante. Un valor no numérico en ajustes.json (o en el JSON de un
    import) reventaba GET /api/settings con un 500 permanente que dejaba la app
    inutilizable, porque no había forma de corregir el ajuste desde la UI."""
    try:
        result = int(value)
    except (TypeError, ValueError, OverflowError):
        # OverflowError: int(float("inf")) o 1e999 no caben en un entero.
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


def _ficheroDeClaves(proveedor):
    """Ruta del fichero del proveedor, o None si el nombre no es de los tres.

    El nombre llega en el cuerpo de la petición: sin contrastarlo contra los
    tres conocidos sería una forma de señalar cualquier fichero del disco.
    """
    nombre = _FICHEROS_CLAVES.get(str(proveedor or "").strip().lower())
    return (_API_DIR / nombre) if nombre else None


def _huellaClave(clave: str) -> str:
    """Identificador estable de una clave que no permite reconstruirla."""
    return hashlib.sha256(clave.encode("utf-8")).hexdigest()[:16]


def _enmascararClave(clave):
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


def _readKeyFile(path):
    """Claves del fichero, descifrando si está en formato cifrado."""
    return "\n".join(readSecretLines(path))


def _writeKeyFile(path, value):
    writeSecretLines(path, str(value).splitlines())


def _appendKeyFile(path, value):
    existing = readSecretLines(path)
    newKey = str(value).strip()
    if newKey and newKey not in existing:
        existing.append(newKey)
    writeSecretLines(path, existing)


@ajustesBp.route("/api/settings", methods=["GET"])
def getSettings():
    pid  = _activePortfolioId()
    gcfg = _readAjustes()
    pcfg = _readPrefs(pid)
    finnhubRaw      = _readKeyFile(_API_DIR / "finnhub.key")
    eodhdRaw        = _readKeyFile(_API_DIR / "eodhd.key")
    alphavantageRaw = _readKeyFile(_API_DIR / "alphavantage.key")
    return jsonify({
        "ok":                    True,
        "finnhubKeyCount":       len([k for k in finnhubRaw.splitlines() if k.strip()]),
        "eodhdKeyCount":         len([k for k in eodhdRaw.splitlines() if k.strip()]),
        "alphaVantageKeyCount":  len([k for k in alphavantageRaw.splitlines() if k.strip()]),
        # Globales
        "autoBackupDays":        _asInt(gcfg.get("autoBackupDays"), 0),
        "backupIncluirClaves":   bool(gcfg.get("backupIncluirClaves", False)),
        "backupContrasena":      clave_copias.configurada(),
        "staleHours":            _asInt(gcfg.get("staleHours"), 24),
        "autoRefreshMinutes":    _asInt(gcfg.get("autoRefreshMinutes"), 0),
        "snapshotMinutes":       _asInt(gcfg.get("snapshotMinutes"), 60),
        "snapshotAlcance":       gcfg.get("snapshotAlcance") or "activo",
        "snapshotServidor":      settings.snapshotServidorActivo(),
        "theme":                 gcfg.get("theme") or "default",
        "sidebarCollapsed":      bool(gcfg.get("sidebarCollapsed", False)),
        "monedaBase":            gcfg.get("monedaBase") or "EUR",
        "precioDecimalesAcciones":  _asInt(gcfg.get("precioDecimalesAcciones"), 2),
        "precioDecimalesEtf":       _asInt(gcfg.get("precioDecimalesEtf"), 2),
        "precioDecimalesComoditis": _asInt(gcfg.get("precioDecimalesComoditis"), 2),
        "precioDecimalesCripto":    _asInt(gcfg.get("precioDecimalesCripto"), 4),
        "soloHorarioMercado":       bool(gcfg.get("soloHorarioMercado", False)),
        "soloMercadoTipos":         gcfg.get("soloMercadoTipos") or ["acciones", "etfs", "comoditis"],
        "bloqueoInactividad":       _asInt(gcfg.get("bloqueoInactividad"), 0),
        "numLocale":                gcfg.get("numLocale") or "es-ES",
        "dateFormat":               gcfg.get("dateFormat") or "DD/MM/YYYY",
        "maxBackups":               _asInt(gcfg.get("maxBackups"), 0),
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
        "cuentaAhorroConfig":       normalizarConfig(pcfg.get("cuentaAhorroConfig")),
        "panelesConfig":            normalizarPaneles(pcfg.get("panelesConfig")),
    })


@ajustesBp.route("/api/settings/apikeys", methods=["GET"])
def listApiKeys():
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
                    "vista": _enmascararClave(clave),
                    "huella": _huellaClave(clave),
                    "longitud": len(clave),
                }
                for indice, clave in enumerate(origen["claves"])
            ],
        }

    respuesta = jsonify({"ok": True, "proveedores": proveedores})
    # Lleva secretos dentro: que no se quede en ninguna caché intermedia.
    respuesta.headers["Cache-Control"] = "no-store"
    return respuesta


@ajustesBp.route("/api/settings/apikey/ver", methods=["POST"])
def verApiKey():
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
        if hmac.compare_digest(_huellaClave(clave), huella):
            respuesta = jsonify({"ok": True, "clave": clave})
            respuesta.headers["Cache-Control"] = "no-store"
            return respuesta

    return jsonify({"ok": False, "error": "Esa clave ya no está guardada"}), 404


@ajustesBp.route("/api/settings/apikey", methods=["POST"])
def appendApiKey():
    data = jsonBody()
    if data.get("finnhubKey"):
        _appendKeyFile(_API_DIR / "finnhub.key", str(data["finnhubKey"]).strip())
    if data.get("eodhdKeys"):
        _appendKeyFile(_API_DIR / "eodhd.key", str(data["eodhdKeys"]).strip())
    if data.get("alphaVantageKeys"):
        _appendKeyFile(_API_DIR / "alphavantage.key", str(data["alphaVantageKeys"]).strip())
    return jsonify({
        "ok":               True,
        "finnhubKeys":      len([k for k in _readKeyFile(_API_DIR / "finnhub.key").splitlines() if k.strip()]),
        "eodhdKeys":        len([k for k in _readKeyFile(_API_DIR / "eodhd.key").splitlines() if k.strip()]),
        "alphaVantageKeys": len([k for k in _readKeyFile(_API_DIR / "alphavantage.key").splitlines() if k.strip()]),
    })


@ajustesBp.route("/api/settings/apikey", methods=["DELETE"])
def deleteApiKey():
    """Quita una clave del fichero de su proveedor.

    Se borra **por valor, no por posición**. La lista que el usuario tiene
    delante puede haberse quedado atrás —otra pestaña, otra sesión, una clave
    añadida entretanto— y con un índice viejo se borraría la clave equivocada
    sin que nada lo advirtiera. Por valor, o coincide o no se toca nada.

    La clave va en el cuerpo y no en la URL para no dejarla escrita en los logs
    del proxy ni en el historial del navegador, que es donde acaban las rutas.
    """
    datos = jsonBody()
    fichero = _ficheroDeClaves(datos.get("proveedor"))

    if fichero is None:
        return jsonify({"ok": False, "error": "Proveedor desconocido"}), 400

    claves = readSecretLines(fichero)
    # Se identifica por la huella que da el listado (el listado ya no lleva el
    # valor). Se sigue aceptando el valor tal cual para quien lo tenga.
    huella = datos.get("huella")
    if isinstance(huella, str) and huella:
        clave = next((c for c in claves if hmac.compare_digest(_huellaClave(c), huella)), "")
    else:
        clave = str(datos.get("clave") or "").strip()

    if not clave or clave not in claves:
        # También cae aquí una clave que viene del entorno: esa no está en el
        # fichero y no se puede quitar desde aquí, sino del `.env` del servidor.
        return jsonify({"ok": False, "error": "Esa clave ya no está guardada"}), 404

    restantes = [existente for existente in claves if existente != clave]
    writeSecretLines(fichero, restantes)
    log.info("Clave de API eliminada de %s; quedan %s", fichero.name, len(restantes))

    return jsonify({"ok": True, "restantes": len(restantes)})


@ajustesBp.route("/api/stats/api-calls", methods=["GET"])
def getApiCallStats():
    return jsonify({"ok": True, **getTodayStats()})


@ajustesBp.route("/api/stats/api-estado", methods=["GET"])
def getApiEstado():
    """Estado de cada proveedor: operativo, sin clave, sin cuota o caído.

    `?forzar=1` salta la caché. Se deja fuera de la comprobación automática
    porque cada sondeo gasta cuota real: la pantalla pide el estado cacheado y
    solo se fuerza cuando el usuario lo pide a mano.
    """
    forzar = str(request.args.get("forzar", "")).strip().lower() in ("1", "true", "si", "sí")
    try:
        return jsonify({"ok": True, **estadoProveedores.obtener(forzar=forzar)})
    except Exception as error:
        log.warning("No se pudo comprobar el estado de los proveedores: %s", error)
        return jsonify({"ok": False, "error": str(error)[:200]}), 500


@ajustesBp.route("/api/settings/apis-pausadas", methods=["POST"])
def saveApiPausada():
    """Pausa o reanuda un proveedor de cotizaciones: {proveedor, pausada}."""
    data = jsonBody()
    proveedor = str(data.get("proveedor") or "").strip().lower()
    if proveedor not in proveedores_pausados.PAUSABLES:
        return jsonify({"ok": False, "error": "Ese proveedor no se puede pausar"}), 400

    pausados = set(proveedores_pausados.pausados())
    if data.get("pausada"):
        pausados.add(proveedor)
    else:
        pausados.discard(proveedor)

    gcfg = _readAjustes()
    gcfg["apisPausadas"] = [p for p in proveedores_pausados.PAUSABLES if p in pausados]
    try:
        _writeAjustes(gcfg)
    except OSError as error:
        mensaje = registrarFalloEscritura(log, "No se pudo guardar la pausa del proveedor", error, _AJUSTES_JSON)
        return jsonify({"ok": False, "error": mensaje}), 500
    return jsonify({"ok": True, "pausados": gcfg["apisPausadas"]})


@ajustesBp.route("/api/settings/telegram", methods=["GET"])
def getTelegramSettings():
    token, chatId = telegram_notifier.leerConfig()
    activos = telegram_notifier.preferencias()
    return jsonify({
        "ok": True,
        "configurado": bool(token) and bool(chatId),
        # Igual que /api/settings/apikeys: solo la máscara. Con el token del bot
        # se lee y se escribe en el chat del usuario; mandarlo entero lo dejaba
        # en la memoria de la pestaña cada vez que se abría Ajustes. Para
        # cambiarlo se escribe uno nuevo; guardar con el campo vacío conserva
        # el que hay.
        "hayToken": bool(token),
        "tokenVista": _enmascararClave(token) if token else "",
        "chatId": chatId,
        "avisos": [
            {"clave": clave, "titulo": titulo, "activo": activos[clave]}
            for clave, (titulo, _defecto) in telegram_notifier.CATEGORIAS_AVISO.items()
        ],
        "resumenHora": telegram_notifier.resumenHora(),
        "silenciadoHasta": telegram_notifier.silenciadoHasta(),
    })


@ajustesBp.route("/api/settings/telegram/avisos", methods=["POST"])
def saveTelegramAvisos():
    """Qué tipos de aviso se mandan y a qué hora sale el resumen diario."""
    data = jsonBody()
    gcfg = _readAjustes()

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
        gcfg["telegramResumenHora"] = max(0, min(23, _asInt(data["resumenHora"], telegram_notifier.RESUMEN_HORA_DEFECTO)))

    try:
        _writeAjustes(gcfg)
    except OSError as error:
        mensaje = registrarFalloEscritura(log, "No se pudieron guardar los avisos de Telegram", error, _AJUSTES_JSON)
        return jsonify({"ok": False, "error": mensaje}), 500
    return jsonify({"ok": True})


@ajustesBp.route("/api/settings/telegram", methods=["POST"])
def saveTelegramSettings():
    data = jsonBody()
    token = str(data.get("token") or "").strip()
    chatId = str(data.get("chatId") or "").strip()
    if not token:
        # El formulario ya no recibe el token guardado (solo su máscara): vacío
        # significa «el que hay».
        token, _chatGuardado = telegram_notifier.leerConfig()
    if not token or not chatId:
        return jsonify({"ok": False, "error": "Rellena el token del bot y el ID de chat"}), 400
    anteriores = telegram_notifier.leerConfig()
    if (token, chatId) == anteriores:
        # Nada que cambiar: «Enviar prueba» guarda antes de probar y no debe
        # pedir la verificación en dos pasos para dejarlo todo igual.
        return jsonify({"ok": True})
    rechazo = auth.autorizarCambioTelegram(data if isinstance(data, dict) else {})
    if rechazo:
        return rechazo
    if dos_factores.activa() and all(anteriores):
        # Al chat que deja de recibir los códigos, antes de perderlo: si el
        # cambio no lo ha hecho el usuario, es la última ocasión de enterarse.
        telegram_notifier.responder(
            f"Se ha cambiado el bot o el chat de Telegram de PortfolioManager (desde {request.remote_addr}). "
            "Los códigos de la verificación en dos pasos dejarán de llegar aquí. Si no has sido tú, "
            "entra con la frase de recuperación y cambia la contraseña."
        )
    telegram_notifier.escribirConfig(token, chatId)
    return jsonify({"ok": True})


@ajustesBp.route("/api/settings/telegram", methods=["DELETE"])
def deleteTelegramSettings():
    # Sin bot no llega el código del login: borrarlo con la 2FA activa obligaría
    # a gastar la frase de recuperación en el siguiente inicio de sesión.
    if dos_factores.activa():
        return jsonify({
            "ok": False,
            "error": "Desactiva antes la verificación en dos pasos (Ajustes > Cuenta): el código del login llega por este bot.",
        }), 409
    telegram_notifier.borrarConfig()
    return jsonify({"ok": True})


@ajustesBp.route("/api/settings/telegram/prueba", methods=["POST"])
def testTelegramSettings():
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
    return lambda valor, _cfg: max(minimo, min(maximo, _asInt(valor, defecto)))


def _enteroDe(permitidos, defecto):
    return lambda valor, _cfg: _asInt(valor, defecto, permitidos)


def _unaDe(permitidas, defecto):
    return lambda valor, _cfg: _opcion(valor, permitidas, defecto)


def _booleano(valor, _cfg):
    return bool(valor)


def _listaDeTextos(valor, _cfg):
    return [str(t) for t in valor if isinstance(t, str) and t.strip()] if isinstance(valor, list) else []


def _alcanceSnapshot(valor, _cfg):
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


def _monedaBase(valor, cfg):
    # Depende de las divisas ya aplicadas: va detrás de fiatCurrencies en la tabla.
    codigos = {c["code"] for c in cfg.get("fiatCurrencies", _FIAT_DEFAULTS)}
    return str(valor) if str(valor) in codigos else "EUR"


def _tiposSoloMercado(valor, _cfg):
    return [t for t in valor if _opcion(t, _TIPOS_SOLO_MERCADO, None)] if isinstance(valor, list) else []


def _inactividad(valor, _cfg):
    # La lista de valores vive en core/sesion.py: es quien la aplica en el
    # servidor, y el navegador solo la imita para cerrar la pestaña abierta.
    return _asInt(valor, 0, set(sesion.INACTIVIDAD_OPCIONES))


def _activosOcultos(valor, _cfg):
    return [str(i) for i in valor if i and isinstance(i, (str, int))] if isinstance(valor, list) else []


def _mapaBooleanos(permitidas=None):
    def normalizar(valor, _cfg):
        if not isinstance(valor, dict):
            return _SIN_CAMBIO
        return {k: bool(v) for k, v in valor.items()
                if isinstance(k, str) and (permitidas is None or k in permitidas)}
    return normalizar


def _porcentaje(valor, defecto):
    try:
        return max(0.0, min(100.0, float(valor)))
    except (ValueError, TypeError, OverflowError):
        return defecto


def _configAhorro(valor, _cfg):
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


def _configCuentaAhorro(valor, _cfg):
    if not isinstance(valor, dict):
        return _SIN_CAMBIO
    # Una configuración antigua (importada, o de una pestaña sin recargar) aún
    # puede traer remuneradas: pasan a la base antes de que la normalización las quite.
    pares = vinculosDeConfig(valor)
    if pares:
        importarVinculos(pares)
    return normalizarConfig(valor)


def _configPaneles(valor, _cfg):
    if not isinstance(valor, dict):
        return _SIN_CAMBIO
    return normalizarPaneles(valor)


_NORMALIZADORES_GLOBALES = {
    "autoBackupDays": _acotado(0, 365, 0),
    "backupIncluirClaves": lambda valor, _cfg: valor is True,
    "staleHours": _acotado(1, 8760, 24),
    "autoRefreshMinutes": _enteroDe({0, 1, 5, 15, 30, 60}, 0),
    "snapshotMinutes": _enteroDe({0, 1, 5, 15, 30, 60, 240, 1440}, 60),
    "snapshotAlcance": _alcanceSnapshot,
    "theme": _unaDe({"default", "black", "light"}, "default"),
    "sidebarCollapsed": _booleano,
    "fiatCurrencies": _divisas,
    "monedaBase": _monedaBase,
    "precioDecimalesAcciones": _enteroDe(_DECIMALES_PRECIO, 2),
    "precioDecimalesEtf": _enteroDe(_DECIMALES_PRECIO, 2),
    "precioDecimalesComoditis": _enteroDe(_DECIMALES_PRECIO, 2),
    "precioDecimalesCripto": _enteroDe(_DECIMALES_PRECIO, 2),
    "soloHorarioMercado": _booleano,
    "soloMercadoTipos": _tiposSoloMercado,
    "bloqueoInactividad": _inactividad,
    "numLocale": _unaDe({"es-ES", "en-US", "fr-FR"}, "es-ES"),
    "dateFormat": _unaDe({"DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"}, "DD/MM/YYYY"),
    "maxBackups": _enteroDe({0, 5, 10, 20, 50}, 0),
}

_NORMALIZADORES_PORTFOLIO = {
    "hiddenAssets": _activosOcultos,
    "metricasDisplayType": _unaDe({"doughnut", "bar"}, "doughnut"),
    "metricasDistMetric": _unaDe({"netoActualEur", "invertidoEur", "rendimientoEur"}, "netoActualEur"),
    "comparativaExcluded": _listaDeTextos,
    "gastosHiddenTipos": _listaDeTextos,
    "gastosHiddenMensualidades": _listaDeTextos,
    "metricasActivosHidden": _listaDeTextos,
    "metricasSectionsCollapsed": _listaDeTextos,
    "gastosMostrarPausadas": _booleano,
    "topMetricsConfig": _mapaBooleanos(),
    "modulosConfig": _mapaBooleanos(_MODULOS),
    "ahorroConfig": _configAhorro,
    "cuentaAhorroConfig": _configCuentaAhorro,
    "panelesConfig": _configPaneles,
}


def _aplicar(cfg: dict, data: dict, normalizadores: dict) -> None:
    """Aplica a `cfg`, en el orden de la tabla, los ajustes que trae `data`."""
    for clave, normalizar in normalizadores.items():
        if clave in data:
            valor = normalizar(data[clave], cfg)
            if valor is not _SIN_CAMBIO:
                cfg[clave] = valor


@ajustesBp.route("/api/settings", methods=["POST"])
def saveSettings():
    data = jsonBody()
    pid  = _activePortfolioId()

    if data.get("finnhubKey"):
        _writeKeyFile(_API_DIR / "finnhub.key", str(data["finnhubKey"]).strip())
    if data.get("eodhdKeys"):
        _writeKeyFile(_API_DIR / "eodhd.key", str(data["eodhdKeys"]).strip())
    # Faltaba: /api/settings/apikey sí permitía añadir claves de Alpha Vantage,
    # pero guardarlas desde la pantalla de ajustes las descartaba en silencio.
    if data.get("alphaVantageKeys"):
        _writeKeyFile(_API_DIR / "alphavantage.key", str(data["alphaVantageKeys"]).strip())

    gcfg = _readAjustes()
    pcfg = _readPrefs(pid)

    _aplicar(gcfg, data, _NORMALIZADORES_GLOBALES)
    _aplicar(pcfg, data, _NORMALIZADORES_PORTFOLIO)

    try:
        _writeAjustes(gcfg)
        _writePrefs(pid, pcfg)
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


def _realTables(conn) -> list:
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


class ExportacionRechazada(Exception):
    """La base de datos no está en condiciones de exportarse (p. ej. dañada)."""


def _escribirExport(destino, conn, pid: str) -> None:
    """Escribe en `destino` (binario) el volcado completo de `conn`, fila a fila.

    Antes se exportaba una lista fija de 11 nombres de los que 4 ni existían
    ('gastos', 'ingresos', 'stablecoins', 'seguimiento'), y quedaban fuera
    tablas con todos los movimientos: activo_rows, activo_operation_rows,
    gastos_rows, mensualidades, ingresos_rows, intereses_v2, staking_rows,
    earn_rows, trading, renta_fija, private_market… El "export completo" perdía
    casi todos los datos. Ahora se enumera el esquema real.

    El JSON se genera por partes en vez de con un único `json.dumps`: con
    cientos de miles de filas de `asset_snapshots`, el dict con todas las filas
    más el texto con sangría pasaban de 600 MB por petición, y con el
    `mem_limit` del contenedor el kernel mataba al worker a mitad de export. La
    estructura es la misma de siempre (`version` 3), así que la importación no
    cambia.

    Args:
        destino: Fichero binario abierto para escritura.
        conn: Conexión a la base que se vuelca.
        pid: Portfolio cuyas preferencias se incluyen.
    """
    cabecera = {
        "exported_at": datetime.datetime.now(datetime.UTC).isoformat(),
        "version": 3,
        "ajustes": _readAjustes(),
        "portfolio_prefs": _readPrefs(pid),
    }
    texto = io.TextIOWrapper(destino, encoding="utf-8", newline="\n", write_through=False)
    try:
        texto.write("{\n")
        for clave, valor in cabecera.items():
            texto.write(f"  {json.dumps(clave)}: {json.dumps(valor, ensure_ascii=False)},\n")
        texto.write('  "tables": {')
        for indice, table in enumerate(_realTables(conn)):
            texto.write(f'{"," if indice else ""}\n    {json.dumps(table)}: [')
            cursor = conn.execute(f'SELECT * FROM "{table}"')
            columnas = [descripcion[0] for descripcion in cursor.description]
            vacia = True
            for fila in cursor:
                texto.write(f'{"" if vacia else ","}\n      ')
                texto.write(json.dumps(dict(zip(columnas, fila, strict=True)), ensure_ascii=False))
                vacia = False
            texto.write("]" if vacia else "\n    ]")
        texto.write("\n  }\n}\n")
        texto.flush()
    finally:
        # detach() y no close(): quien abrió `destino` decide cuándo cerrarlo
        # (una entrada de ZIP, un temporal que aún hay que enviar).
        texto.detach()


@contextmanager
def _copiaComprobada(dbPath):
    """Copia consistente de `dbPath` en data/tmp, ya verificada.

    Se exporta desde la copia y no desde la base viva: así el JSON y el .db del
    ZIP salen del mismo instante, y la integridad comprobada es la de lo que se
    entrega. Una base dañada no se exporta: el usuario se llevaría un fichero
    que parece una copia y no sirve para restaurar.

    El temporal va a data/tmp. Antes se llamaba `_tmp_export_<portfolio>.db` y
    se creaba **dentro de data/portfolios**, donde todo el proyecto hace
    `glob("*.db")` para saber qué portfolios existen: exportar mientras corría
    una copia de seguridad metía la exportación a medias en el backup como si
    fuera un portfolio más.

    Raises:
        ExportacionRechazada: La copia no pasa `integrity_check` o
            `foreign_key_check`; el mensaje dice qué falla.
    """
    with temporalPara(dbPath, directorio=paths.TMP_DIR) as tmp:
        copiarSqlite(dbPath, tmp, timeout=settings.dbTimeout())
        problemas = problemasDeIntegridad(tmp)
        if problemas:
            log.error("[export] %s no pasa la comprobación de integridad: %s", dbPath.name, problemas)
            raise ExportacionRechazada(
                f"La base de datos del portfolio está dañada y no se exporta: {'; '.join(problemas)}"
            )
        yield tmp


def _abrirCopia(ruta):
    """Conexión de solo lectura a una copia temporal del export."""
    return closing(sqlite3.connect(f"{Path(ruta).resolve().as_uri()}?mode=ro", uri=True))


def _temporalDeSalida():
    """Fichero anónimo en data/tmp para la respuesta.

    Anónimo para que no quede nada en disco si el worker muere a mitad: el
    sistema lo borra al cerrarse, y Werkzeug lo cierra al terminar de enviarlo.
    """
    paths.TMP_DIR.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryFile(dir=paths.TMP_DIR)


def _verificarZip(fichero) -> None:
    """Comprueba el CRC de todas las entradas del ZIP antes de entregarlo.

    Raises:
        ExportacionRechazada: Alguna entrada no se lee igual que se escribió.
    """
    fichero.seek(0)
    with zipfile.ZipFile(fichero) as zf:
        mala = zf.testzip()
    if mala:
        raise ExportacionRechazada(f"El ZIP generado está corrupto ({mala}); vuelve a intentarlo")
    fichero.seek(0)


def _respuestaFalloExport(error: Exception):
    """Respuesta JSON con la causa real, para que la pantalla pueda enseñarla."""
    if isinstance(error, ExportacionRechazada):
        return jsonify({"ok": False, "error": str(error)}), 409
    mensaje = registrarFalloEscritura(log, "[export] No se pudo generar la exportación", error, paths.TMP_DIR)
    return jsonify({"ok": False, "error": mensaje}), 500


def _enviarTemporal(fichero, mimetype: str, nombre: str):
    fichero.seek(0)
    return send_file(fichero, mimetype=mimetype, as_attachment=True, download_name=nombre)


@ajustesBp.route("/api/export/json", methods=["GET"])
def exportJson():
    pid  = _activePortfolioId()
    getDb().commit()
    salida = None
    try:
        salida = _temporalDeSalida()
        with _copiaComprobada(getActiveDbPath()) as copia, _abrirCopia(copia) as conn:
            _escribirExport(salida, conn, pid)
        return _enviarTemporal(salida, "application/json", "portfolio-export.json")
    except (ExportacionRechazada, OSError, sqlite3.Error) as e:
        if salida is not None:
            salida.close()
        return _respuestaFalloExport(e)


@ajustesBp.route("/api/export/zip", methods=["GET", "POST"])
def exportZip():
    """El ZIP completo. En POST admite lo que un GET no puede llevar.

    Sigue aceptando GET —un enlace directo o un `curl` siguen valiendo—, pero
    entonces sale sin las dos cosas que dependen de quien pide: el volcado del
    `localStorage`, que solo tiene el navegador, y las claves de API, que no se
    incluyen si nadie las pide expresamente.
    """
    pid  = _activePortfolioId()

    peticion = request.get_json(silent=True) if request.method == "POST" else None
    peticion = peticion if isinstance(peticion, dict) else {}
    ui = exportables.sanearUi(peticion.get("ui"))
    incluirClaves = bool(peticion.get("incluirClaves"))
    contrasena = peticion.get("contrasena")
    contrasena = contrasena if isinstance(contrasena, str) else ""
    if len(contrasena) > exportables.MAX_LARGO_CONTRASENA:
        return jsonify({"ok": False, "error": "La contraseña es demasiado larga"}), 400

    getDb().commit()
    dateStr = datetime.datetime.now().strftime("%Y-%m-%d")
    salida = None
    try:
        salida = _temporalDeSalida()
        with _copiaComprobada(getActiveDbPath()) as copia:
            _escribirZipExport(salida, copia, pid, dateStr, ui, incluirClaves, contrasena)
        _verificarZip(salida)
        return _enviarTemporal(salida, "application/zip", f"portfolio-export-{dateStr}.zip")
    except (ExportacionRechazada, OSError, sqlite3.Error, zipfile.BadZipFile) as e:
        if salida is not None:
            salida.close()
        return _respuestaFalloExport(e)


def _escribirZipExport(salida, copia, pid: str, dateStr: str, ui: dict, incluirClaves: bool, contrasena: str) -> None:
    """Escribe en `salida` el ZIP de exportación a partir de la copia ya comprobada."""
    with zipfile.ZipFile(salida, "w", zipfile.ZIP_DEFLATED) as zf:
        with _abrirCopia(copia) as conn, zf.open(f"portfolio-export-{dateStr}.json", "w") as entrada:
            _escribirExport(entrada, conn, pid)
        # La copia ya es consistente (API de backup de SQLite, con el WAL
        # pendiente): zf.write() del .db en caliente podía capturar páginas a
        # medias y dejar en el zip una BD corrupta.
        zf.write(str(copia), f"portfolio-{dateStr}.db")
        if _AJUSTES_JSON.exists():
            zf.write(str(_AJUSTES_JSON), "ajustes.json")
        prefsFile = _prefsPath(pid)
        if prefsFile.exists():
            zf.write(str(prefsFile), f"prefs_{pid}.json")

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


def _mensajeDeIntegridad(error, tabla, numero) -> str:
    """Texto para el usuario de un fallo de integridad, sin el mensaje de SQLite."""
    texto = str(error)
    columna = texto.rsplit(".", 1)[-1].strip() if "." in texto else ""
    if texto.startswith("NOT NULL") and columna:
        return f"Tabla «{tabla}», fila {numero}: falta el campo obligatorio «{columna}»"
    if texto.startswith(("UNIQUE", "PRIMARY KEY")) and columna:
        return f"Tabla «{tabla}», fila {numero}: el valor de «{columna}» está repetido"
    return f"Tabla «{tabla}», fila {numero}: los datos no son válidos"


def _comprobarClavesAjenas(conn, tablas) -> None:
    """Rechaza la importación si alguna fila apunta a algo que no existe.

    Las claves ajenas se comprueban al confirmar (`defer_foreign_keys`), y el fallo
    salía como un 500 con «FOREIGN KEY constraint failed». Aquí se busca la fila
    y el campo concretos para decirlo.
    """
    violaciones = [v for v in conn.execute("PRAGMA foreign_key_check").fetchall() if v[0] in tablas]
    if not violaciones:
        return
    tabla, rowid, padre, fkid = violaciones[0][0], violaciones[0][1], violaciones[0][2], violaciones[0][3]
    campo = next(
        (f[3] for f in conn.execute(f'PRAGMA foreign_key_list("{tabla}")').fetchall() if f[0] == fkid), "?"
    )
    valor = conn.execute(f'SELECT "{campo}" FROM "{tabla}" WHERE rowid = ?', (rowid,)).fetchone()
    numero = conn.execute(f'SELECT COUNT(*) FROM "{tabla}" WHERE rowid <= ?', (rowid,)).fetchone()[0]
    if not valor or valor[0] is None or str(valor[0]).strip() == "":
        raise ImportacionInvalida(f"Tabla «{tabla}», fila {numero}: falta el campo obligatorio «{campo}»")
    raise ImportacionInvalida(
        f"Tabla «{tabla}», fila {numero}: «{campo}» vale «{valor[0]}» y no existe en «{padre}»"
    )


class ImportacionInvalida(RuntimeError):
    """El fichero a importar trae una fila que no se puede guardar. La ruta responde 400."""


# Campos que, además de las claves de texto, no pueden venir vacíos aunque el
# esquema los admita con valor por defecto: una fila sin ellos no se puede
# situar en el tiempo o no sabe de qué es.
_CAMPOS_OBLIGATORIOS = {
    "trading": ("fecha",),
    "activo_rows": ("fecha_operacion",),
    "activos": ("name",),
    "ventas": ("fecha",),
}


def _estaVacio(valor) -> bool:
    return valor is None or (isinstance(valor, str) and not valor.strip())


def _restoreTablesFromDict(conn, data: dict):
    """Restaura tablas de la BD activa desde un dict de exportación.

    Todo ocurre en UNA transacción: si algo falla se revierte por completo. La
    versión anterior ejecutaba 'DELETE FROM gastos' (tabla inexistente) fuera de
    su try/except, así que importar el propio export siempre lanzaba
    OperationalError con las tablas ya vaciadas dentro de una transacción
    abierta que nadie revertía.
    """
    tablesPayload = data.get("tables")
    if not isinstance(tablesPayload, dict):
        # Formato legacy: las tablas eran claves de primer nivel
        tablesPayload = {k: v for k, v in data.items() if isinstance(v, list)}

    existing = set(_realTables(conn))
    skipped = [name for name in tablesPayload if name not in existing]
    if skipped:
        log.warning("[import] Tablas del fichero que no existen en el esquema, ignoradas: %s",
                    ", ".join(sorted(skipped)))

    targets = [t for t in sorted(tablesPayload)
               if t in existing and isinstance(tablesPayload[t], list)]

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
            rows = tablesPayload[table]
            if not rows or not isinstance(rows[0], dict):
                continue
            actualCols = {r[1] for r in conn.execute(f'PRAGMA table_info("{table}")').fetchall()}
            # Cada fila lleva sus propias columnas: sacarlas solo de la primera
            # perdía las que otras filas sí traían y rellenaba con NULL las que
            # les faltaban. INSERT a secas (sin OR IGNORE): una fila que no cabe
            # revierte la importación entera, en vez de descartarse en silencio
            # con las tablas ya vaciadas.
            clavesTexto = {
                r[1] for r in conn.execute(f'PRAGMA table_info("{table}")').fetchall()
                if r[5] and str(r[2]).upper() == "TEXT"
            }
            for numero, row in enumerate(rows, start=1):
                if not isinstance(row, dict):
                    continue
                # Una clave de texto NULL entra en SQLite sin error (solo las
                # enteras la rechazan), y un campo obligatorio vacío tampoco
                # falla: hay que mirarlos aquí.
                nulas = [c for c in clavesTexto if c in row and row[c] is None]
                vacios = [c for c in _CAMPOS_OBLIGATORIOS.get(table, ()) if _estaVacio(row.get(c))]
                for campo in nulas + vacios:
                    raise ImportacionInvalida(
                        f"Tabla «{table}», fila {numero}: falta el campo obligatorio «{campo}»"
                    )
                columnas = tuple(c for c in row if c in actualCols)
                if not columnas:
                    continue
                colStr      = ", ".join(f'"{c}"' for c in columnas)
                placeholders = ", ".join("?" for _ in columnas)
                try:
                    conn.execute(
                        f'INSERT INTO "{table}" ({colStr}) VALUES ({placeholders})',
                        [row[c] for c in columnas],
                    )
                except sqlite3.IntegrityError as error:
                    raise ImportacionInvalida(_mensajeDeIntegridad(error, table, numero)) from error
        _comprobarClavesAjenas(conn, targets)
        conn.commit()
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        if isinstance(e, ImportacionInvalida):
            raise
        raise RuntimeError(f"Error restaurando datos: {e}") from e


@ajustesBp.route("/api/import/json", methods=["POST"])
def importJson():
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
        _respuestaBloqueoOcupado,
        bloqueoRestauracion,
        copiaPreviaObligatoria,
        respuestaSinCopiaPrevia,
    )

    try:
        with bloqueoRestauracion():
            copia, copiaOk = copiaPreviaObligatoria()
            if not copiaOk:
                return respuestaSinCopiaPrevia()

            pid  = _activePortfolioId()
            conn = getDb()

            try:
                _restoreTablesFromDict(conn, data)
            except ImportacionInvalida as e:
                return jsonify({"ok": False, "error": str(e)}), 400
            except RuntimeError as e:
                return jsonify({"ok": False, "error": str(e)}), 500

            # Después de las tablas: si la importación falla, los ajustes y las
            # preferencias que ya había no se tocan.
            ignorados = []
            if "ajustes" in data and isinstance(data["ajustes"], dict):
                ajustes, rechazados = _coercionarImportados(data["ajustes"], _GLOBAL_DEFAULTS, _readAjustes())
                ignorados += rechazados
                _writeAjustes(ajustes)
            if "portfolio_prefs" in data and isinstance(data["portfolio_prefs"], dict):
                prefs, rechazados = _coercionarImportados(data["portfolio_prefs"], _PORTFOLIO_DEFAULTS, _readPrefs(pid))
                ignorados += rechazados
                _writePrefs(pid, prefs)
    except BloqueoOcupado:
        return _respuestaBloqueoOcupado()

    if ignorados:
        log.warning("[import] Ajustes con un valor no válido, vueltos a su valor de fábrica: %s", ", ".join(ignorados))
    return jsonify({"ok": True, "copiaPrevia": copia.name if copia else None, "ajustesIgnorados": ignorados})


def _jsonDeZip(zf, nombre):
    """Contenido JSON de una entrada, o ValueError si no es JSON válido."""
    try:
        return json.loads(zf.read(nombre).decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise ValueError(f"{nombre} no es un JSON válido") from error


@ajustesBp.route("/api/import/zip", methods=["POST"])
def importZip():
    f = request.files.get("file")
    if not f:
        return jsonify({"ok": False, "error": "No se recibió ningún archivo"}), 400

    rawBytes = f.read()
    try:
        buf = io.BytesIO(rawBytes)
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
    from routes.backup import esBackupCompleto, restaurarBackupSubido

    if esBackupCompleto(names):
        with temporalPara(paths.BACKUPS_DIR / "importado.zip", directorio=paths.TMP_DIR) as tmp:
            tmp.write_bytes(rawBytes)
            return restaurarBackupSubido(tmp)

    # Claves protegidas con contraseña: se descifran ANTES de tocar nada. Si la
    # contraseña falta o falla, la respuesta lo dice y la cartera sigue como
    # estaba; el navegador la pide y vuelve a mandar el mismo ZIP. Quien no la
    # tenga puede importar el resto sin las claves (`sinClaves`).
    contrasena = request.form.get("contrasena", "")
    sinClaves = request.form.get("sinClaves", "") == "1"
    clavesDescifradas = None
    entradaCifrada = next((n for n in names if Path(n).name == exportables.FICHERO_CLAVES_CIFRADAS), None)
    if entradaCifrada and not sinClaves:
        if not contrasena:
            return jsonify({
                "ok": False, "necesitaContrasena": True,
                "error": "El ZIP lleva las claves de API protegidas con contraseña",
            }), 400
        if len(contrasena) > exportables.MAX_LARGO_CONTRASENA:
            return jsonify({"ok": False, "error": "La contraseña es demasiado larga"}), 400
        try:
            with zipfile.ZipFile(io.BytesIO(rawBytes), "r") as zf:
                paquete = json.loads(zf.read(entradaCifrada).decode("utf-8"))
            clavesDescifradas = exportables.descifrarClaves(paquete, contrasena)
        except (exportables.ContrasenaIncorrecta, ValueError, UnicodeDecodeError):
            log.warning("[import] Contraseña incorrecta para las claves del ZIP")
            return jsonify({"ok": False, "necesitaContrasena": True, "error": "Contraseña incorrecta"}), 400

    from core.bloqueo import BloqueoOcupado
    from routes.backup import _respuestaBloqueoOcupado, bloqueoRestauracion

    try:
        with bloqueoRestauracion():
            return _importarZip(rawBytes, clavesDescifradas, sinClaves)
    except BloqueoOcupado:
        return _respuestaBloqueoOcupado()


class _ImportacionRechazada(Exception):
    """El ZIP no se puede importar; lleva el mensaje para el usuario."""


@dataclass
class _ContenidoImportado:
    """Lo que trae un ZIP de «Exportar ZIP», ya leído y validado."""

    nombres: list
    base: str | None = None          # entrada .db de la raíz, ya extraída al temporal
    exportJson: dict | None = None  # o, en su lugar, el export JSON
    ajustes: dict | None = None
    prefs: dict = field(default_factory=dict)


_SIN_NADA_QUE_IMPORTAR = (
    "El ZIP no contiene ni una base de datos ni un export de esta aplicación. Usa el ZIP "
    "que genera «Exportar ZIP», o una copia de seguridad de Ajustes → Copias de seguridad."
)


def _leerContenidoZip(zf, tmpDb) -> _ContenidoImportado:
    """Valida todo lo que se va a usar, sin escribir nada fuera de `tmp_db`."""
    from admin.backup_manager import problemaDePortfolio

    nombres = zf.namelist()
    contenido = _ContenidoImportado(nombres=nombres)
    # Base de datos en la raíz (formato de exportación: portfolio-{fecha}.db)
    contenido.base = next((n for n in nombres if n.endswith(".db") and "/" not in n), None)
    nombreJson = next((n for n in nombres if n.endswith(".json") and "export" in n and "/" not in n), None)
    # `ajustes.json` y las preferencias también cuentan: un zip que solo traiga
    # eso sí tiene algo que importar.
    traeConfiguracion = any(
        Path(n).name == "ajustes.json" or Path(n).name.startswith("prefs_") for n in nombres
    )
    if not contenido.base and not nombreJson and not traeConfiguracion:
        # Decirlo es la diferencia entre «este zip no vale» y creer que se ha
        # importado algo que en realidad sigue sin estar.
        raise _ImportacionRechazada(_SIN_NADA_QUE_IMPORTAR)

    if contenido.base:
        # A disco y no a memoria; el temporal va a data/tmp para que ningún
        # `glob("*.db")` de data/portfolios lo tome por una cartera.
        zip_seguro.extraer(zf, contenido.base, tmpDb)
        problema = problemaDePortfolio(tmpDb)
        if problema:
            raise _ImportacionRechazada(f"{contenido.base}: {problema}")
    elif nombreJson:
        contenido.exportJson = _jsonDeZip(zf, nombreJson)
        if not isinstance(contenido.exportJson, dict):
            raise _ImportacionRechazada(f"{nombreJson} no tiene el formato de un export")

    if "ajustes.json" in nombres:
        contenido.ajustes = _jsonDeZip(zf, "ajustes.json")
        if not isinstance(contenido.ajustes, dict):
            raise _ImportacionRechazada("ajustes.json no tiene el formato esperado")

    # El nombre de cada prefs se reduce a su parte final y se valida contra un
    # patrón: comprobar solo que no hubiera "/" dejaba pasar entradas como
    # "prefs_..\..\algo.json", que en Windows escriben fuera de data/JSON.
    for nombre in nombres:
        prefsName = Path(nombre).name
        if _RE_SAFE_PREFS_NAME.match(prefsName):
            contenido.prefs[prefsName] = _jsonDeZip(zf, nombre)
        elif prefsName.startswith("prefs_"):
            log.warning("[import] Entrada de prefs ignorada por nombre inseguro: %r", nombre)
    return contenido


def _restaurarClavesDelZip(zf, nombres, clavesDescifradas, sinClaves) -> list:
    """Claves de API del ZIP, guardadas cifradas con la SECRET_KEY de ESTA
    instalación: ese cambio de cifrado es lo que hace que una copia sirva en un
    servidor recién montado."""
    if clavesDescifradas is not None:
        return exportables.restaurarClaves(clavesDescifradas)
    entrada = next((n for n in nombres if Path(n).name == exportables.FICHERO_CLAVES), None)
    if entrada and not sinClaves:
        return exportables.restaurarClaves(_jsonDeZip(zf, entrada))
    return []


def _aplicarContenido(contenido: _ContenidoImportado, tmpDb, dbPath) -> None:
    """Sustituye la cartera activa y la configuración por lo importado."""
    from core.db import invalidateAllConnections

    if contenido.base:
        invalidateAllConnections()
        # Por la API de backup sobre el mismo fichero, no con un rename: así
        # no cambia el inodo bajo las conexiones de los demás procesos.
        copiarSqlite(tmpDb, dbPath)
    elif contenido.exportJson is not None:
        _restoreTablesFromDict(getDb(), contenido.exportJson)

    if contenido.ajustes is not None:
        escribirJsonAtomico(_AJUSTES_JSON, contenido.ajustes)
    for prefsName, prefs in contenido.prefs.items():
        escribirJsonAtomico(_AJUSTES_JSON.parent / prefsName, prefs)


def _importarZip(rawBytes, clavesDescifradas, sinClaves):
    """La importación propiamente dicha, ya con el cerrojo de restauración.

    Hasta aquí no se ha escrito nada. El orden es: validar todo lo que se va a
    usar, guardar una copia del estado actual y solo entonces sustituir. Antes
    cualquier SQLite —una vacía incluida— reemplazaba la cartera activa sin
    copia previa, y los ajustes se escribían sin comprobar que fueran JSON.
    """
    from routes.backup import copiaPreviaObligatoria, respuestaSinCopiaPrevia

    dbPath = getActiveDbPath()
    try:
        with zipfile.ZipFile(io.BytesIO(rawBytes), "r") as zf, \
                temporalPara(dbPath, directorio=paths.TMP_DIR) as tmpDb:
            contenido = _leerContenidoZip(zf, tmpDb)

            copia, copiaOk = copiaPreviaObligatoria()
            if not copiaOk:
                return respuestaSinCopiaPrevia()

            _aplicarContenido(contenido, tmpDb, dbPath)
            claves = _restaurarClavesDelZip(zf, contenido.nombres, clavesDescifradas, sinClaves)
            if claves:
                log.info("[import] Claves de API restauradas: %s", ", ".join(claves))
            # Preferencias de interfaz: no se guardan aquí, se devuelven para
            # que las escriba el navegador, que es donde viven.
            entradaUi = next((n for n in contenido.nombres if Path(n).name == exportables.FICHERO_UI), None)
            ui = exportables.sanearUi(_jsonDeZip(zf, entradaUi)) if entradaUi else {}
    except (_ImportacionRechazada, ValueError) as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

    return jsonify({"ok": True, "ui": ui, "claves": claves, "copiaPrevia": copia.name if copia else None})
