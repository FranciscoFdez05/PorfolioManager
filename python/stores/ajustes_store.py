"""Ajustes globales (ajustes.json) y preferencias por portfolio (prefs_<id>.json).

Lectura, saneado y escritura atómica de los dos ficheros, con sus valores de
fábrica. Antes vivía en routes/ajustes.py y el resto de rutas (cuentas,
cuenta_ahorro, backup, snapshots) lo importaba de allí, es decir, unas rutas
dependían de otras. Aquí queda en la capa de datos y cualquier módulo lo puede
usar sin arrastrar el blueprint de Ajustes.

Los nombres conservan el guion bajo con el que nacieron: los citan comentarios
y pruebas, y cambiarlos no aportaba nada.
"""
import json
import re
from pathlib import Path

from core import dinero, proveedor_bnb, telegram_notifier
from core.db import getActiveDbPath
from core.escritura import escribirJsonAtomico
from core.paths import AJUSTES_JSON as _AJUSTES_JSON, JSON_DIR
from stores import seguimiento_prefs

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
    # API que lee las wallets de BNB Smart Chain (ver core.proveedor_bnb).
    "bnbProveedor": proveedor_bnb.POR_DEFECTO,
    # Cada cuántos minutos se revisan las wallets de Cripto > Seguimiento (0 =
    # nunca). Lo valida y lo lee core.wallets_vigilancia.
    "walletsVigilanciaMinutos": 15,
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
    # Módulo que se abre al arrancar. Vacío: el primero visible del menú.
    "moduloPrincipal": "",
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
    # Análisis > Seguimiento: lista propia, ocultos y símbolos retocados (ver
    # stores.seguimiento_prefs).
    seguimiento_prefs.CLAVE_LISTA: [],
    seguimiento_prefs.CLAVE_OCULTOS: [],
    seguimiento_prefs.CLAVE_OVERRIDES: {},
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
        elif clave == seguimiento_prefs.CLAVE_LISTA:
            # La única lista de objetos: el filtro de abajo la dejaría vacía.
            valor = seguimiento_prefs.normalizarLista(valor)
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


# Nombres de fichero de prefs admisibles al importar un zip (mismo patrón que
# usa el restore de backups en routes/backup.py)
_RE_SAFE_PREFS_NAME = re.compile(r"^prefs_[A-Za-z0-9_-]{1,64}\.json$")
