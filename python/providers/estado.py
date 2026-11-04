"""Estado de cada proveedor de datos de mercado y de lectura de wallets.

El contador de "Peticiones API hoy" dice cuánta cuota se ha gastado, pero no si
el proveedor responde. Cuando la cartera deja de actualizar precios la pregunta
es otra: ¿se acabó la cuota, caducó la clave o está caído el servicio? Hasta
ahora había que abrir los logs del contenedor para distinguirlo.

Cada proveedor se comprueba con la llamada más barata que tiene —una cotización
de un símbolo conocido— y el fallo se traduce a uno de estos estados:

* ``ok``        — responde y devuelve datos.
* ``sin_clave`` — no hay clave configurada; el proveedor ni se llega a llamar.
* ``clave``     — la clave existe pero el proveedor la rechaza (401).
* ``plan``      — la clave vale, pero el plan no cubre lo que se ha pedido (403).
* ``limite``    — cuota agotada (429/402, o el aviso en el cuerpo de Alpha Vantage).
* ``caido``     — no contesta: timeout, corte de red o 5xx.
* ``error``     — contesta algo que no se entiende.
* ``sin_datos`` — todavía no se le ha hecho ninguna petición.

Los proveedores que admiten varias claves se comprueban recorriéndolas hasta
que una responde: el diagnóstico dice si el proveedor sirve, no si sirve la
primera clave de la lista.

**Las comprobaciones gastan cuota real**, así que solo se hacen cuando el
usuario pulsa «Comprobar ahora». El resto del tiempo el estado es el de la
última petición real que hizo el servidor a cada proveedor (`api_stats`), con
su antigüedad: ver la pantalla nunca gasta cuota.

Cada fila dice además qué cubre y, si falla, el motivo y qué hacer
(`_presentar`), porque una etiqueta como «Fuera del plan» no dice qué ha dejado
de funcionar ni si se arregla solo.
"""

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit

from core import proveedor_bnb, proveedores_pausados, settings
from providers import api_stats
from providers.api_stats import lastApiResults, recordApiResult
from providers.blockchain_clients import (
    _ETHERSCAN_CADENAS,
    _ETHERSCAN_URL,
    ESTADO_BNB,
    ESTADO_ESPLORA,
    ESTADO_ETHERSCAN,
    ESTADO_SOLANA,
    ESTADO_XRPL,
    estadoPorMensaje,
    estadoRespuestaEtherscan,
    urlNodeReal,
)
from providers.http import fetchJson
from stores import app_data

log = logging.getLogger(__name__)

# Los proveedores gratuitos tardan lo suyo cuando van justos, pero aquí hay
# alguien esperando delante de la pantalla: es mejor decir "no responde" a los
# seis segundos que dejar la pantalla colgada con el timeout normal.
_TIMEOUT = 6.0

_YAHOO_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

# Etiqueta de cada estado guardado por `api_stats.recordApiResult`.
_ETIQUETAS = {
    "ok": "Operativa",
    "clave": "Clave rechazada",
    "plan": "Fuera del plan",
    "limite": "Cuota agotada",
    "caido": "No responde",
    "error": "Error",
}

# Lectores de claves de cada proveedor que las necesita: (lista, una sola). Por
# nombre y no por referencia, para leer siempre el de `app_data` de ese momento.
_LECTORES_CLAVE = {
    "finnhub": ("readFinnhubApiKeys", "readFinnhubApiKey"),
    "eodhd": ("readEodhdApiKeys", "readEodhdApiKey"),
    "alphavantage": ("readAlphaVantageApiKeys", "readAlphaVantageApiKey"),
    "etherscan": (None, "readEtherscanApiKey"),
    "nodereal": (None, "readNodeRealApiKey"),
}

# Una dirección cualquiera: al sondeo solo le importa si la API contesta.
_DIRECCION_SONDEO_ETHERSCAN = "0x0000000000000000000000000000000000000000"

# Qué cubre cada fila. La de BNB depende de la API elegida (`_cobertura`).
_COBERTURA = {
    "finnhub": "Cotizaciones. El plan gratuito no incluye bolsas fuera de EE. UU. ni históricos",
    "eodhd": "Cotizaciones",
    "alphavantage": "Cotizaciones",
    "yahoo": "Cotizaciones, sin clave",
    "tradingview": "Cotizaciones, sin clave",
    "divisas": "Tipos de cambio, sin clave",
    "etherscan": "Wallets y tokens de Ethereum. El plan gratuito no incluye BNB",
    "esplora": "Wallets de Bitcoin, sin clave",
    "solana": "Wallets de Solana, sin clave. Solo SOL: los tokens SPL no se leen",
    "xrpl": "Wallets de XRP, sin clave. Solo XRP: otras divisas del ledger no se leen",
}

# Los servidores públicos no tienen cuota de una clave: limitan por IP.
_SIN_CUENTA = ("yahoo", "tradingview", "divisas", "esplora", "solana", "xrpl")

# Cuánto sigue diciendo algo un límite si nadie vuelve a llamar al proveedor. La
# pantalla solo aprende de peticiones reales: sin esto, un proveedor que la
# aplicación ya no usa se quedaría para siempre en «Cuota agotada» o «Frenada».
_vigenciaFrenoSegundos = 5 * 60
_vigenciaCuotaSegundos = 24 * 3600


class _Fallo(Exception):
    """Contestó 200, pero el cuerpo dice que falló: lleva el estado ya traducido."""

    def __init__(self, estado, detalle):
        super().__init__(detalle)
        self.estado = estado


class _Limite(Exception):
    """Contestó 200, pero el cuerpo dice que no queda cuota."""


class _Clave(Exception):
    """Contestó 200, pero el cuerpo dice que la clave no vale."""


class _SinClave(Exception):
    """No hay clave configurada, así que no se ha llegado a llamar."""


def _clave(lector):
    """La clave, o corta la comprobación antes de gastar una petición.

    Llamar sin clave devolvería un 401 previsible que cuenta como llamada y
    que además se pintaría como "clave rechazada": el usuario buscaría una clave
    mala donde lo que hay es un hueco.
    """
    try:
        valor = lector()
    except Exception as error:
        log.debug("[estado] No se pudo leer la clave: %s", error)
        raise _SinClave() from error
    if not valor:
        raise _SinClave()
    return valor


def _listaClaves(lectorLista, lectorLegado):
    """Todas las claves configuradas del proveedor, en orden.

    El lector "legado" es el de una sola clave y sigue haciendo falta: cubre las
    instalaciones que nunca llegaron a configurar varias. Si no hay ninguna,
    corta la comprobación igual que `_clave`.
    """
    try:
        claves = [clave for clave in (lectorLista() or []) if clave]
    except Exception as error:
        log.debug("[estado] No se pudieron leer las claves: %s", error)
        claves = []
    return claves or [_clave(lectorLegado)]


def _sondearClaves(claves, llamada):
    """Prueba las claves en orden y para en la primera que responde.

    Antes se sondeaba solo la primera. Con varias configuradas —EODHD da 20
    peticiones al día por clave, que es justo el motivo de poner varias— que la
    #1 se quedara sin cuota pintaba «EODHD · Cuota agotada» aunque las otras
    estuvieran enteras y la aplicación siguiera actualizando precios con ellas.
    El usuario veía un proveedor roto que no lo estaba.

    Mientras la primera responda —el caso normal— sigue costando una sola
    petición: solo baja por la lista cuando ya hay un fallo que explicar, y esas
    claves de más que se prueban son precisamente las que no tienen cuota que
    gastar.
    """
    ultimoError = None

    for numero, clave in enumerate(claves, start=1):
        try:
            llamada(clave)
        except Exception as error:
            ultimoError = error
            continue

        if numero == 1:
            return ""

        # Que responda la tercera no es lo mismo que responder a la primera: el
        # proveedor sirve, pero quedan menos claves de las que parece.
        return f"Responde la clave {numero} de {len(claves)}; las anteriores, no"

    raise ultimoError


def _probarFinnhub():
    return _sondearClaves(
        _listaClaves(app_data.readFinnhubApiKeys, app_data.readFinnhubApiKey),
        lambda clave: fetchJson(
            "https://finnhub.io/api/v1/quote",
            {"symbol": "AAPL", "token": clave},
            timeout=_TIMEOUT, provider="Finnhub", retries=0,
        ),
    )


def _probarEodhd():
    return _sondearClaves(
        _listaClaves(app_data.readEodhdApiKeys, app_data.readEodhdApiKey),
        lambda clave: fetchJson(
            "https://eodhd.com/api/real-time/AAPL.US",
            {"api_token": clave, "fmt": "json"},
            timeout=_TIMEOUT, provider="EODHD", retries=0,
        ),
    )


def _consultarAlphaVantage(clave):
    payload = fetchJson(
        "https://www.alphavantage.co/query",
        {
            "function": "GLOBAL_QUOTE",
            "symbol": "AAPL",
            "apikey": clave,
        },
        timeout=_TIMEOUT, provider="Alpha Vantage", retries=0,
    )
    # Alpha Vantage no usa códigos HTTP para esto: el límite diario y la clave
    # inválida llegan como un 200 con un texto explicativo, así que sin mirar
    # el cuerpo saldría "Operativa" con la cuota agotada. Se mira aquí dentro,
    # y no después del sondeo, para que una clave sin cuota deje paso a la
    # siguiente en vez de dar por fallado al proveedor entero.
    if not isinstance(payload, dict):
        return
    aviso = payload.get("Note") or payload.get("Information")
    if aviso:
        raise _Limite(aviso)
    if payload.get("Error Message"):
        raise _Clave(payload["Error Message"])


def _probarAlphaVantage():
    return _sondearClaves(
        _listaClaves(app_data.readAlphaVantageApiKeys, app_data.readAlphaVantageApiKey),
        _consultarAlphaVantage,
    )


def _probarYahoo():
    fetchJson(
        "https://query1.finance.yahoo.com/v8/finance/chart/AAPL",
        {"range": "1d", "interval": "1d"},
        timeout=_TIMEOUT, provider="Yahoo Finance", retries=0,
        headers={"User-Agent": _YAHOO_UA},
    )


def _probarTradingview():
    fetchJson(
        "https://scanner.tradingview.com/global/scan",
        timeout=_TIMEOUT, provider="TradingView", retries=0,
        jsonBody={
            "symbols": {"tickers": ["NASDAQ:AAPL"], "query": {"types": []}},
            "columns": ["close"],
        },
    )


def _probarDivisas():
    fetchJson(
        "https://api.frankfurter.app/latest",
        {"from": "EUR", "to": "USD"},
        timeout=_TIMEOUT, provider="Tipo de cambio", retries=0,
    )


def _sondearEtherscan(red, nombre):
    respuesta = fetchJson(
        _ETHERSCAN_URL,
        {"chainid": _ETHERSCAN_CADENAS[red], "module": "account", "action": "balance",
         "address": _DIRECCION_SONDEO_ETHERSCAN, "tag": "latest", "apikey": _clave(app_data.readEtherscanApiKey)},
        timeout=_TIMEOUT, provider=nombre, retries=0,
    )
    fallo = estadoRespuestaEtherscan(respuesta)
    if fallo:
        raise _Fallo(*fallo)


def _probarEtherscan():
    _sondearEtherscan("eth", ESTADO_ETHERSCAN)


def _falloRpc(respuesta):
    """Lanza `_Fallo` si una respuesta JSON-RPC trae un error en el cuerpo."""
    error = respuesta.get("error") if isinstance(respuesta, dict) else None
    if error:
        detalle = str(error.get("message") if isinstance(error, dict) else error)[:200]
        raise _Fallo(estadoPorMensaje(detalle), detalle)


def _probarNodeReal():
    # Se prueba el historial y no solo la clave: es la consulta de la que depende
    # que se lean las wallets, y un plan que no la incluya solo se ve así.
    _falloRpc(fetchJson(
        urlNodeReal(_clave(app_data.readNodeRealApiKey)),
        timeout=_TIMEOUT, provider=ESTADO_BNB, retries=0,
        jsonBody={"jsonrpc": "2.0", "id": 1, "method": "nr_getTransactionByAddress", "params": [{
            "category": ["external"], "address": _DIRECCION_SONDEO_ETHERSCAN, "order": "desc", "maxCount": "0x1",
        }]},
    ))


def _probarBnb():
    if proveedor_bnb.actual() == proveedor_bnb.NODEREAL:
        _probarNodeReal()
    else:
        _sondearEtherscan("bnb", ESTADO_BNB)


def _probarEsplora():
    principal = settings.walletsEsploraUrl().rstrip("/")
    respaldo = settings.walletsEsploraUrlRespaldo().rstrip("/")
    try:
        fetchJson(f"{principal}/blocks/tip/height", timeout=_TIMEOUT, provider=ESTADO_ESPLORA, retries=0)
    except (HTTPError, TimeoutError, URLError, OSError):
        if not respaldo or respaldo == principal:
            raise
        fetchJson(f"{respaldo}/blocks/tip/height", timeout=_TIMEOUT, provider=ESTADO_ESPLORA, retries=0)
        return f"Responde el respaldo ({urlsplit(respaldo).netloc}); la principal ({urlsplit(principal).netloc}), no"
    return ""


def _probarSolana():
    _falloRpc(fetchJson(
        settings.walletsSolanaRpcUrl(),
        timeout=_TIMEOUT, provider=ESTADO_SOLANA, retries=0,
        jsonBody={"jsonrpc": "2.0", "id": 1, "method": "getHealth", "params": []},
    ))


def _probarXrpl():
    respuesta = fetchJson(
        settings.walletsXrplRpcUrl(),
        timeout=_TIMEOUT, provider=ESTADO_XRPL, retries=0,
        jsonBody={"method": "server_info", "params": [{}]},
    )
    resultado = respuesta.get("result") if isinstance(respuesta, dict) else None
    if isinstance(resultado, dict) and resultado.get("status") == "error":
        detalle = str(resultado.get("error_message") or resultado.get("error") or "Error")[:200]
        raise _Fallo(estadoPorMensaje(detalle), detalle)


# (id, nombre visible, comprobación)
_PROVEEDORES = (
    ("finnhub",      "Finnhub",        _probarFinnhub),
    ("eodhd",        "EODHD",          _probarEodhd),
    ("alphavantage", "Alpha Vantage",  _probarAlphaVantage),
    ("yahoo",        "Yahoo Finance",  _probarYahoo),
    ("tradingview",  "TradingView",    _probarTradingview),
    ("divisas",      "Tipo de cambio", _probarDivisas),
    ("etherscan",    ESTADO_ETHERSCAN, _probarEtherscan),
    ("bnb",          ESTADO_BNB,       _probarBnb),
    ("esplora",      ESTADO_ESPLORA,   _probarEsplora),
    ("solana",       ESTADO_SOLANA,    _probarSolana),
    ("xrpl",         ESTADO_XRPL,      _probarXrpl),
)


def _fila(idProveedor, nombre, estado, etiqueta, detalle="", ms=0):
    return {
        "id": idProveedor,
        "nombre": nombre,
        "estado": estado,
        "etiqueta": etiqueta,
        "detalle": str(detalle)[:200],
        "ms": ms,
        # Instante del diagnóstico: un fallo real posterior pide repetirlo.
        "_momento": time.monotonic(),
    }


def _porCodigo(codigo):
    if codigo == 401:
        return "clave", "Clave rechazada"
    if codigo == 403:
        # Finnhub usa el 403 para "tu plan no cubre esto" —bolsas fuera de
        # EE. UU., históricos— con la clave perfectamente válida. Pintarlo como
        # clave rechazada mandaba al usuario a cambiar una clave que funciona,
        # y a no encontrar nunca el problema, que es el plan.
        return "plan", "Fuera del plan"
    if codigo in (402, 429):
        # 402 es lo que devuelve EODHD cuando se agota el plan del día.
        return "limite", "Cuota agotada"
    if codigo >= 500:
        return "caido", "Caída"
    return "error", f"HTTP {codigo}"


def _diagnosticar(idProveedor, nombre, probar):
    inicio = time.monotonic()

    def fin(estado, etiqueta, detalle=""):
        ms = round((time.monotonic() - inicio) * 1000)
        return _fila(idProveedor, nombre, estado, etiqueta, detalle, ms)

    try:
        detalleOk = probar()
    except _SinClave:
        return fin("sin_clave", "Sin clave", "No hay ninguna clave configurada")
    except _Limite as error:
        return fin("limite", "Cuota agotada", error)
    except _Clave as error:
        return fin("clave", "Clave rechazada", error)
    except _Fallo as error:
        return fin(error.estado, _ETIQUETAS.get(error.estado, "Error"), error)
    except HTTPError as error:
        estado, etiqueta = _porCodigo(error.code)
        return fin(estado, etiqueta, f"HTTP {error.code}")
    except (TimeoutError, URLError) as error:
        return fin("caido", "No responde", getattr(error, "reason", error))
    except Exception as error:
        log.debug("[estado] %s falló de forma inesperada: %s", nombre, error)
        return fin("error", "Error", error)
    return fin("ok", "Operativa", detalleOk or "")


def _diagnosticarOPausa(idProveedor, nombre, probar):
    # Un proveedor pausado no se sondea: sería gastar cuota en algo que el
    # usuario ha apagado a propósito.
    if proveedores_pausados.estaPausado(idProveedor):
        return _fila(idProveedor, nombre, "pausada", "Pausada", "Pausada desde Ajustes")
    return _diagnosticar(idProveedor, nombre, probar)


def _conPausa(proveedores):
    """Marca `pausable` y `pausada` con el ajuste de ahora, no el de cuando se cacheó."""
    pausados = proveedores_pausados.pausados()
    filas = []
    for fila in proveedores:
        fila = dict({k: v for k, v in fila.items() if k != "_momento"}, pausable=fila["id"] in proveedores_pausados.PAUSABLES, pausada=fila["id"] in pausados)
        if fila["pausada"] and fila["estado"] != "pausada":
            fila.update(estado="pausada", etiqueta="Pausada", detalle="Pausada desde Ajustes", ms=0)
        filas.append(fila)
    return filas


def comprobar():
    """Diagnostica todos los proveedores en paralelo, sin mirar la caché."""
    # En serie serían cinco timeouts encadenados: medio minuto con todo caído.
    # En paralelo, el peor caso es un timeout.
    with ThreadPoolExecutor(max_workers=len(_PROVEEDORES)) as pool:
        # `map` conserva el orden de entrada, que es el declarado arriba: una
        # lista que se reordena sola según quién conteste antes sería ilegible.
        return list(pool.map(lambda datos: _diagnosticarOPausa(*datos), _PROVEEDORES))


def _tieneClave(idProveedor) -> bool:
    """¿Hay clave para el proveedor? Sin red: solo mira lo configurado."""
    # La clave que necesita la fila de BNB es la de la API elegida.
    lectores = _LECTORES_CLAVE.get(proveedor_bnb.actual() if idProveedor == "bnb" else idProveedor)
    if not lectores:
        return True
    lista, legado = lectores
    try:
        _listaClaves(getattr(app_data, lista) if lista else list, getattr(app_data, legado))
    except _SinClave:
        return False
    return True


def _filaDeUltimaPeticion(idProveedor, nombre, ultimo, ahora):
    estadoUltimo = ultimo.get("estado", "error")
    fila = _fila(idProveedor, nombre, estadoUltimo, _ETIQUETAS.get(estadoUltimo, "Error"),
                 ultimo.get("detalle", ""), ultimo.get("ms", 0))
    fila["edadSegundos"] = max(0, round(ahora - float(ultimo.get("momento") or ahora)))
    return fila


def _esFreno(detalle: str) -> bool:
    """¿El límite es por segundo (dura segundos) y no la cuota del día?"""
    return "per sec" in str(detalle).lower()


def _limiteCaducado(ultimo: dict, ahora: float) -> bool:
    """¿Es un límite tan viejo que ya no dice nada del proveedor?

    Args:
        ultimo: Resultado guardado por `recordApiResult`.
        ahora: Instante actual, en segundos desde la época.

    Returns:
        True si es un límite anterior a su vigencia. Otros estados nunca caducan:
        una clave rechazada sigue siéndolo hasta que alguien la cambie.
    """
    if ultimo.get("estado") != "limite":
        return False
    vigencia = _vigenciaFrenoSegundos if _esFreno(ultimo.get("detalle", "")) else _vigenciaCuotaSegundos
    return ahora - float(ultimo.get("momento") or ahora) > vigencia


def _desdeUltimasPeticiones():
    """Una fila por proveedor con cómo terminó su última petición real, sin llamar a nadie."""
    ultimos = lastApiResults()
    ahora = time.time()
    filas = []
    for idProveedor, nombre, _probar in _PROVEEDORES:
        if proveedores_pausados.estaPausado(idProveedor):
            filas.append(_fila(idProveedor, nombre, "pausada", "Pausada", "Pausada desde Ajustes"))
        elif not _tieneClave(idProveedor):
            filas.append(_fila(idProveedor, nombre, "sin_clave", "Sin clave", "No hay ninguna clave configurada"))
        elif nombre in ultimos and _limiteCaducado(ultimos[nombre], ahora):
            filas.append(_fila(idProveedor, nombre, "sin_datos", "Sin datos",
                               "Su último límite ya ha caducado y no se le ha vuelto a pedir nada"))
        elif nombre in ultimos:
            filas.append(_filaDeUltimaPeticion(idProveedor, nombre, ultimos[nombre], ahora))
        else:
            filas.append(_fila(idProveedor, nombre, "sin_datos", "Sin datos",
                               "Todavía no se le ha hecho ninguna petición; «Comprobar ahora» lo prueba"))
    return filas


def _cobertura(idProveedor: str) -> str:
    if idProveedor != "bnb":
        return _COBERTURA.get(idProveedor, "")
    if proveedor_bnb.actual() == proveedor_bnb.NODEREAL:
        return "Wallets y tokens de BNB, por NodeReal. No da la comisión de red de los envíos de tokens"
    return "Wallets y tokens de BNB, por Etherscan. Requiere un plan de pago"


def _motivoLimite(idProveedor: str, detalle: str) -> tuple[str, str]:
    """(etiqueta, motivo) de un límite: no es lo mismo un freno de segundos que la cuota del día."""
    if idProveedor in _SIN_CUENTA:
        return "Limitada", "El servicio público está limitando esta IP. Suele levantarse solo en un rato."
    if _esFreno(detalle):
        return "Frenada", "Demasiadas peticiones por segundo. Se recupera sola en unos segundos."
    return "Cuota agotada", ("Se ha gastado la cuota de esta clave. Volverá cuando el proveedor "
                             "reinicie el contador, o añade otra clave si admite varias.")


def _motivoPlan(idProveedor: str, detalle: str) -> str:
    if idProveedor == "bnb" and proveedor_bnb.actual() == proveedor_bnb.ETHERSCAN:
        return ("El plan gratuito de Etherscan no incluye BNB Smart Chain; Ethereum sigue funcionando. "
                "Elige NodeReal en esta fila (clave gratuita) o contrata un plan de pago de Etherscan.")
    return f"La clave es válida, pero tu plan no cubre lo pedido.{' ' + detalle if detalle else ''}"


def _motivoSinClave(idProveedor: str) -> str:
    if idProveedor == "bnb" and proveedor_bnb.actual() == proveedor_bnb.NODEREAL:
        return "Falta la clave de NodeReal. Se crea gratis en nodereal.io y se guarda en Claves API."
    if idProveedor == "bnb":
        return "Falta la clave de Etherscan, y BNB requiere además un plan de pago. Puedes elegir NodeReal en esta fila."
    return "Falta la clave. Sin ella no se usa este proveedor; se añade en Claves API."


def _presentar(fila: dict) -> dict:
    """Añade a una fila qué cubre, el motivo de su estado y las APIs que se pueden elegir."""
    fila = dict(fila, cubre=_cobertura(fila["id"]), motivo="")
    estadoFila, detalle = fila["estado"], str(fila.get("detalle") or "")
    if estadoFila == "limite":
        fila["etiqueta"], fila["motivo"] = _motivoLimite(fila["id"], detalle)
    elif estadoFila == "plan":
        fila["motivo"] = _motivoPlan(fila["id"], detalle)
    elif estadoFila == "sin_clave":
        fila["motivo"] = _motivoSinClave(fila["id"])
    elif estadoFila == "clave":
        fila["motivo"] = "El proveedor rechaza la clave guardada. Se cambia en Claves API."
    elif estadoFila == "caido":
        fila["motivo"] = "No contesta. No depende de tu configuración y suele arreglarse solo."
    elif estadoFila == "error":
        fila["motivo"] = f"Ha contestado algo inesperado: {detalle}" if detalle else "Ha contestado algo inesperado."
    elif estadoFila == "ok":
        # «Responde la clave 2 de 4» o «responde el respaldo»: funciona, pero importa.
        fila["motivo"] = detalle
    if fila["id"] == "bnb":
        fila["opciones"] = [{"id": clave, "nombre": nombre} for clave, nombre in proveedor_bnb.OPCIONES.items()]
        fila["seleccion"] = proveedor_bnb.actual()
    return fila


def obtener(forzar: bool = False) -> dict:
    """Estado de los proveedores.

    Sin `forzar` no se llama a nadie: cada fila dice cómo terminó la última
    petición real que hizo el servidor a ese proveedor (al actualizar precios,
    leer wallets…). Así la pantalla nunca gasta cuota por su cuenta, ni al
    abrirla ni porque haya fallado una llamada. Solo `forzar`, que es el botón
    «Comprobar ahora», sondea a todos; su resultado queda como última petición.

    Args:
        forzar: Sondear ahora todos los proveedores (gasta cuota).

    Returns:
        {"proveedores": [...], "comprobado": bool}. Cada fila sin forzar lleva
        `edadSegundos`, lo que hace de su última petición. Todas llevan `cubre` y
        `motivo`; la de BNB, además, `opciones` y `seleccion`.
    """
    if not forzar:
        filas = _conPausa(_desdeUltimasPeticiones())
        return {"proveedores": [_presentar(fila) for fila in filas], "comprobado": False}

    proveedores = comprobar()
    # fetchJson ya anota cada llamada, pero no lo que solo ve el diagnóstico (el
    # aviso de cuota dentro de un 200, «responde la clave 2 de 4»).
    for fila in proveedores:
        if fila["estado"] not in ("pausada", "sin_clave"):
            recordApiResult(fila["nombre"], fila["estado"], fila["detalle"], fila["ms"])
    return {"proveedores": [_presentar(fila) for fila in _conPausa(proveedores)], "comprobado": True}


def reiniciarParaPruebas() -> None:
    """Olvida los últimos resultados en memoria. Simula un worker recién arrancado."""
    api_stats.reiniciarParaPruebas()
