"""Rutas de las wallets enlazadas (Cripto > Seguimiento y Transacciones).

Solo traducen HTTP ↔ dominio: validar la entrada, llamar al repositorio o a los
servicios (importación y seguimiento) y convertir sus excepciones en respuestas.
Como el resto de /api, exigen sesión y token CSRF (core/seguridad_app.py).

Ninguna respuesta lleva la dirección o la xpub completas, y ningún log tampoco,
salvo /api/wallets/seguimientos/ver-completas, /api/wallets/direcciones/ver-completas
y /api/wallets/<id>/a-libreta, que antes piden la contraseña de acceso a la web.
"""

import logging
import re
from dataclasses import asdict
from decimal import Decimal, InvalidOperation
from typing import Callable, Iterable

from flask import Blueprint, jsonify, request

from core import paths, settings, wallets_vigilancia
from core.cripto_direcciones import (
    REDES,
    TIPO_DIRECCION,
    TIPOS_ENTRADA,
    DatoWalletInvalido,
    normalizarDatoWallet,
    prepararDatoWallet,
)
from core.errors import ApiError, ConflictError, NotFoundError, UpstreamError, ValidationError
from core.secret_store import writeSecretLines
from core.validation import asText, jsonBody
from core.wallets_avisos import ConfigAvisos, ConfigAvisosInvalida
from core.wallets_libreta import SENTIDOS, Libreta, anotar, entraEnLibreta, entradaComoDict, libretaDe
from core.wallets_tokens import anotarConocidos, esNombreDeLaRed, indicePublico, publicosRelacionados
from core.wallets_sync import ActivoDeWalletInexistente, SincronizadorWallets, textoDecimal
from core.wallets_visor_tokens import VisorTokens
from core.wallets_watchlist import ListaWatchlist
from providers.blockchain_clients import ErrorLecturaWallet, UtxoBitcoin, lectorPara, lectorUtxos, redesConTokens
from providers.listas_tokens import tokensPublicos
from stores.app_data import readEtherscanApiKey
from stores.asset_store import listarActivosCripto
from stores.market_data import fetchAssetQuote
from stores.wallets_store import (
    MARCAS_TOKEN,
    MAX_LARGO_ALIAS,
    MAX_LARGO_TICKER,
    PROVEEDORES_PRECIO,
    AlmacenIlegible,
    CifradoNoDisponible,
    DireccionMarcada,
    LimiteWallets,
    MovimientoMarcado,
    TokenMarcado,
    TokenPrecio,
    TokenVerificado,
    Wallet,
    WalletError,
    WalletNoEncontrada,
    WalletsRepository,
    ahoraIso,
    claveSeguimiento,
    enmascarar,
    fernetWallets,
    nuevoId,
)

log = logging.getLogger(__name__)

walletsBp = Blueprint("wallets", __name__)

_MAX_LARGO_CLAVE_API = 200
# El mismo tope que aplican los lectores al símbolo que llega de la red.
_MAX_LARGO_SIMBOLO = 20
# Lo que llevan los tickers de los proveedores: «BINANCE:PEPEUSDT», «BTC-EUR», «^GSPC», «EURUSD=X».
_PATRON_TICKER = re.compile(r"[A-Z0-9:._\-^=/]+")
# Hashes y firmas de las redes (hexadecimal con 0x, base58), y contratos.
_PATRON_HASH = re.compile(r"[A-Za-z0-9]{1,130}")


def _errorDeDominio(error: Exception) -> ApiError:
    """La respuesta HTTP de cada error de dominio."""
    if isinstance(error, WalletNoEncontrada):
        return NotFoundError(str(error))
    if isinstance(error, CifradoNoDisponible):
        return ConflictError(str(error))
    if isinstance(error, AlmacenIlegible):
        return ApiError(str(error), 500)
    if isinstance(error, ErrorLecturaWallet):
        return UpstreamError(str(error))
    return ValidationError(str(error))


def _repositorio() -> WalletsRepository:
    return WalletsRepository()


def _libreta(repositorio: WalletsRepository) -> Libreta:
    """La libreta vigente.

    Raises:
        WalletError: si el fichero no se puede leer.
    """
    return libretaDe(repositorio)


def _conValor(wallets: list[Wallet], libreta: Libreta) -> tuple[list[dict], Decimal]:
    """Resúmenes con el valor en euros del último saldo, y el total de las propias.

    Los movimientos recientes se guardan como los leyó la red y la libreta se
    aplica aquí: marcar una dirección cambia lo que se ve sin esperar a la vigilancia.

    Raises:
        WalletError: si no se pueden leer los tickers guardados.
    """
    precios = {}
    tickers = {p.red: p for p in _repositorio().preciosToken() if not p.contrato}
    resumenes = []
    total = Decimal(0)
    for wallet in wallets:
        resumen = wallet.resumen()
        resumen["recientes"] = [anotar(m, wallet.red, libreta) for m in resumen["recientes"]]
        clavePrecio = (wallet.red, wallet.assetId)
        if clavePrecio not in precios:
            try:
                precios[clavePrecio] = wallets_vigilancia.precioEurDeMoneda(wallet.red, wallet.assetId,
                                                                            tickers.get(wallet.red))
            except Exception as error:
                # Sin tipo de cambio la página se enseña igual, sin el valor en euros.
                log.debug("[wallets] Sin precio en euros para %s: %s", wallet.assetId, error)
                precios[clavePrecio] = None
        precio = precios[clavePrecio]
        valor = None
        if precio is not None and wallet.saldo:
            valor = Decimal(wallet.saldo) * precio
            if wallet.propia:
                total += valor
        resumen["valorEur"] = textoDecimal(valor.quantize(Decimal("0.01"))) if valor is not None else ""
        resumen["sinPrecio"] = precio is None
        resumenes.append(resumen)
    return resumenes, total


def _tokensPublicosDe(movimientos: Iterable[tuple[str, dict]]) -> list[dict]:
    """Los contratos de las listas públicas que la página necesita para esos movimientos.

    Args:
        movimientos: Pares (red, movimiento en dict) de lo que se enseña.
    """
    tokens = [(red, mov.get("simbolo", ""), mov["contrato"]) for red, mov in movimientos if mov.get("contrato")]
    # Sin tokens no se descargan las listas: una cartera solo de BTC no las necesita.
    if not tokens:
        return []
    return [asdict(t) for t in publicosRelacionados(indicePublico(tokensPublicos()), tokens)]


@walletsBp.route("/api/wallets", methods=["GET"])
def listarWallets():
    repositorio = _repositorio()
    try:
        enlazadas = repositorio.listar()
        wallets, total = _conValor(enlazadas, _libreta(repositorio))
        tokens = repositorio.tokensVerificados()
        marcas = repositorio.marcasToken()
        sospechosos = repositorio.tokensSospechosos()
        precios = repositorio.preciosToken()
        direcciones = repositorio.direcciones()
    except WalletError as error:
        raise _errorDeDominio(error) from error
    return jsonify({
        "ok": True,
        "wallets": wallets,
        "totalPropiasEur": textoDecimal(total.quantize(Decimal("0.01"))),
        "totalSinPrecio": sum(1 for w in wallets if w["propia"] and w["sinPrecio"]),
        "redes": [
            {"clave": r.clave, "nombre": r.nombre, "simbolo": r.simbolo, "admiteXpub": r.admiteXpub,
             "admiteClavePublica": r.admiteClavePublica,
             "explorador": r.explorador, "exploradorToken": r.exploradorToken,
             "visorTokens": r.clave in redesConTokens()}
            for r in REDES.values()
        ],
        "tokensVerificados": [asdict(t) for t in tokens],
        "tokensMarcados": [asdict(m) for m in marcas],
        "tokensSospechosos": [asdict(s) for s in sospechosos],
        "preciosToken": [asdict(p) for p in precios],
        "proveedoresPrecio": list(PROVEEDORES_PRECIO),
        "tokensPublicos": _tokensPublicosDe((w["red"], m) for w in wallets for m in w["recientes"]),
        **_respuestaLibreta(direcciones, enlazadas),
        "cifradoDisponible": fernetWallets() is not None,
        "hayClaveEtherscan": bool(readEtherscanApiKey()),
        "vigilanciaMinutos": wallets_vigilancia.minutosVigilancia(),
        "opcionesMinutos": list(wallets_vigilancia.OPCIONES_MINUTOS),
        "ajenasCadaMinutos": settings.walletsAjenasCadaMinutos(),
    })


def _umbral(valor) -> str:
    texto = asText(valor, "umbralAviso", maxLength=40).replace(",", ".")
    if not texto:
        return ""
    try:
        numero = Decimal(texto)
    except InvalidOperation as error:
        raise ValidationError("El mínimo para avisar debe ser un número", field="umbralAviso") from error
    if not numero.is_finite() or numero < 0:
        raise ValidationError("El mínimo para avisar no puede ser negativo", field="umbralAviso")
    return textoDecimal(numero)


def _configAvisos(valor) -> dict:
    """`avisosConfig` validado y completo; sin valor, el de por defecto."""
    try:
        return ConfigAvisos.validar(valor if valor is not None else {}).comoDict()
    except ConfigAvisosInvalida as error:
        raise ValidationError(str(error), field=error.campo) from error


def _cambiosAvisos(datos: dict) -> dict:
    """Los campos de avisos que trae la petición, validados."""
    cambios = {}
    if "avisos" in datos:
        cambios["avisos"] = bool(datos["avisos"])
    if "umbralAviso" in datos:
        cambios["umbralAviso"] = _umbral(datos["umbralAviso"])
    if "avisosConfig" in datos:
        cambios["avisosConfig"] = _configAvisos(datos["avisosConfig"])
    return cambios


def _mezclaConfig(parcial) -> Callable[[dict], dict] | None:
    """Valida unos cambios sueltos de `avisosConfig` y devuelve cómo aplicarlos a cada wallet.

    Args:
        parcial: Las claves de `ConfigAvisos` que cambian, p. ej. `{"despiertaDias": 90}`.

    Returns:
        Función que mezcla esos cambios con la config de una wallet y la
        devuelve validada, o None si no hay nada que cambiar.

    Raises:
        ValidationError: si no es un objeto, trae claves que no existen o
            algún valor no es válido.
    """
    if not isinstance(parcial, dict):
        raise ValidationError("Los ajustes de avisos no son válidos", field="avisosConfigCambios")
    desconocidas = set(parcial) - set(ConfigAvisos().comoDict())
    if desconocidas:
        raise ValidationError(f"Ajuste de avisos desconocido: {sorted(desconocidas)[0]}", field="avisosConfigCambios")
    if not parcial:
        return None
    # Se validan ya, para fallar antes de tocar nada; la mezcla de cada wallet se
    # vuelve a validar entera porque hay reglas que cruzan campos.
    _configAvisos(parcial)
    return lambda actual: _configAvisos({**actual, **parcial})


def _activoValido(assetId: str, propia: bool) -> str:
    # Una wallet ajena no va a Transacciones: el activo solo sirve para el valor
    # en euros, así que puede quedar sin elegir.
    if not assetId:
        if propia:
            raise ValidationError("Elige una cripto de Activos para la moneda de la wallet", field="assetId")
        return ""
    if not any(a["id"] == assetId for a in listarActivosCripto()):
        raise ValidationError("Esa cripto no está en Activos", field="assetId")
    return assetId


def _walletDePeticion(datos: dict) -> Wallet:
    red = asText(datos.get("red"), "red", maxLength=10, required=True).lower()
    tipo = asText(datos.get("tipo"), "tipo", default=TIPO_DIRECCION, maxLength=20).lower()
    alias = asText(datos.get("alias"), "alias", maxLength=MAX_LARGO_ALIAS, required=True)
    # Espacios repetidos fuera: si no, «Mi  Ledger» abriría un seguimiento aparte
    # en pantalla aunque al compararlo sea el mismo.
    seguimiento = " ".join(asText(datos.get("seguimiento"), "seguimiento", maxLength=MAX_LARGO_ALIAS).split())
    propia = datos.get("propia", True) is not False
    if tipo not in TIPOS_ENTRADA:
        raise ValidationError("Tipo de enlace no válido", field="tipo")
    assetId = _activoValido(asText(datos.get("assetId"), "assetId", maxLength=200), propia)
    try:
        tipo, valor = prepararDatoWallet(red, tipo, datos.get("valor"))
    except DatoWalletInvalido as error:
        raise ValidationError(str(error), field="valor") from error
    return Wallet(
        id=nuevoId(), alias=alias, red=red, tipo=tipo, valor=valor, assetId=assetId, creada=ahoraIso(),
        propia=propia, avisos=bool(datos.get("avisos", False)), umbralAviso=_umbral(datos.get("umbralAviso")),
        avisosConfig=_configAvisos(datos.get("avisosConfig")), seguimiento=seguimiento,
    )


@walletsBp.route("/api/wallets", methods=["POST"])
def enlazarWallet():
    wallet = _walletDePeticion(jsonBody())
    try:
        _repositorio().anadir(wallet)
    except LimiteWallets as error:
        raise ValidationError(str(error)) from error
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] Enlazada %s en %s (%s, %s)", wallet.id, wallet.red, wallet.tipo,
             "propia" if wallet.propia else "ajena")
    # Su dirección pasa a contar como propia en lo ya importado de otras wallets.
    reetiquetado = _reetiquetar(wallet.red, wallet.valor) if entraEnLibreta(wallet) else {}
    return jsonify({"ok": True, "wallet": wallet.resumen(), **reetiquetado})


@walletsBp.route("/api/wallets/<walletId>/ajustes", methods=["POST"])
def ajustarWallet(walletId):
    """Cambia el nombre, los avisos y sus ajustes, el mínimo para avisar o la cripto asociada."""
    datos = jsonBody()
    repositorio = _repositorio()
    try:
        actual = repositorio.obtener(walletId)
        cambios = _cambiosAvisos(datos)
        if "alias" in datos:
            cambios["alias"] = asText(datos["alias"], "alias", maxLength=MAX_LARGO_ALIAS, required=True)
            # Una wallet de antes de los grupos usa su alias como seguimiento:
            # renombrarla la sacaría del suyo, así que se fija el nombre actual.
            if not actual.seguimiento:
                cambios["seguimiento"] = actual.nombreSeguimiento
        if "assetId" in datos:
            cambios["assetId"] = _activoValido(asText(datos["assetId"], "assetId", maxLength=200), actual.propia)
        wallet = repositorio.actualizar(walletId, **cambios) if cambios else actual
    except WalletError as error:
        raise _errorDeDominio(error) from error
    return jsonify({"ok": True, "wallet": wallet.resumen()})


@walletsBp.route("/api/wallets/seguimientos/renombrar", methods=["POST"])
def renombrarSeguimiento():
    """Cambia el nombre de un seguimiento en todas sus wallets.

    El seguimiento va por su clave en el cuerpo y no en la URL: es un nombre
    libre, con espacios y acentos.
    """
    datos = jsonBody()
    # casefold() puede alargar el texto («ß» → «ss»): de ahí el margen.
    clave = claveSeguimiento(asText(datos.get("clave"), "clave", maxLength=MAX_LARGO_ALIAS * 2, required=True))
    nombre = " ".join(asText(datos.get("nombre"), "nombre", maxLength=MAX_LARGO_ALIAS, required=True).split())
    try:
        wallets = _repositorio().renombrarSeguimiento(clave, nombre)
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] Seguimiento renombrado (%d wallets)", len(wallets))
    return jsonify({"ok": True, "wallets": [w.resumen() for w in wallets]})


@walletsBp.route("/api/wallets/seguimientos/avisos", methods=["POST"])
def ajustarAvisosSeguimiento():
    """Activa o desactiva los avisos de todas las wallets de un seguimiento, con sus ajustes.

    Cuerpo: `clave` del seguimiento y cualquiera de `avisos`, `umbralAviso`,
    `avisosConfig` (la config entera, igual para todas) y `avisosConfigCambios`
    (solo esas claves, mezcladas con la config que ya tiene cada wallet). Lo
    que no venga se queda como estaba en cada wallet.
    """
    datos = jsonBody()
    clave = claveSeguimiento(asText(datos.get("clave"), "clave", maxLength=MAX_LARGO_ALIAS * 2, required=True))
    cambios = _cambiosAvisos(datos)
    ajustarConfig = _mezclaConfig(datos["avisosConfigCambios"]) if "avisosConfigCambios" in datos else None
    if "avisosConfig" in cambios and ajustarConfig:
        raise ValidationError("Manda «avisosConfig» o «avisosConfigCambios», no los dos")
    if not cambios and not ajustarConfig:
        raise ValidationError("No hay nada que cambiar")
    try:
        wallets = _repositorio().ajustarSeguimiento(clave, ajustarConfig, **cambios)
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] Avisos de un seguimiento ajustados (%d wallets)", len(wallets))
    return jsonify({"ok": True, "wallets": [w.resumen() for w in wallets]})


@walletsBp.route("/api/wallets/seguimientos/ver-completas", methods=["POST"])
def verWalletsCompletas():
    """Direcciones, claves y xpub completas de un seguimiento, tras la contraseña de acceso.

    Una xpub deja seguir todas las direcciones y el saldo de la cuenta, así que
    una cookie de sesión no basta: se vuelve a pedir la contraseña cada vez.
    Comparte el contador de intentos con /login, como el resto de endpoints que
    la piden. La respuesta no se guarda en la caché del navegador.
    """
    # Importado aquí, como en routes/backup.py: auth importa medio servidor.
    from routes import auth

    bloqueado = auth._rechazarSiBloqueado()
    if bloqueado:
        return bloqueado
    datos = auth._cuerpoDict()
    clave = claveSeguimiento(asText(datos.get("clave"), "clave", maxLength=MAX_LARGO_ALIAS * 2, required=True))
    rechazo = auth._comprobarContrasenaActual(auth._texto(datos.get("currentPassword")), "ver wallets completas")
    if rechazo:
        return rechazo
    auth._clearFailures(auth._clientIp())
    try:
        wallets = [w for w in _repositorio().listar() if w.claveSeguimiento == clave]
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] Mostradas completas las %d wallets de un seguimiento", len(wallets))
    respuesta = jsonify({"ok": True, "valores": {w.id: w.valor for w in wallets}})
    respuesta.headers["Cache-Control"] = "no-store"
    return respuesta


@walletsBp.route("/api/wallets/<walletId>", methods=["DELETE"])
def desenlazarWallet(walletId):
    repositorio = _repositorio()
    try:
        wallet = repositorio.obtener(walletId)
        repositorio.eliminar(walletId)
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] Desenlazada %s", walletId)
    reetiquetado = _reetiquetar(wallet.red, wallet.valor) if entraEnLibreta(wallet) else {}
    return jsonify({"ok": True, **reetiquetado})


@walletsBp.route("/api/wallets/seguimientos/eliminar", methods=["POST"])
def dejarDeSeguir():
    """Desenlaza todas las wallets de un seguimiento. Lo ya importado se queda en Transacciones."""
    clave = claveSeguimiento(asText(jsonBody().get("clave"), "clave", maxLength=MAX_LARGO_ALIAS * 2, required=True))
    try:
        quitadas = _repositorio().eliminarSeguimiento(clave)
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] Seguimiento quitado (%d wallets)", len(quitadas))
    reetiquetadas, avisos = 0, []
    for wallet in quitadas:
        if entraEnLibreta(wallet):
            reetiquetado = _reetiquetar(wallet.red, wallet.valor)
            reetiquetadas += reetiquetado["reetiquetadas"]
            if reetiquetado.get("avisoReetiquetado"):
                avisos.append(reetiquetado["avisoReetiquetado"])
    respuesta = {"ok": True, "quitadas": len(quitadas), "reetiquetadas": reetiquetadas}
    if avisos:
        respuesta["avisoReetiquetado"] = avisos[0]
    return jsonify(respuesta)


@walletsBp.route("/api/wallets/<walletId>/actualizar", methods=["POST"])
def actualizarWallet(walletId):
    """Saldo y últimos movimientos ahora mismo (avisa de lo nuevo, como la vigilancia)."""
    repositorio = _repositorio()
    try:
        wallet, avisos = wallets_vigilancia.VigilanteWallets(repositorio).revisar(walletId)
        resumen = _conValor([wallet], _libreta(repositorio))[0][0]
    except (WalletError, ErrorLecturaWallet) as error:
        raise _errorDeDominio(error) from error
    return jsonify({"ok": True, "wallet": resumen, "avisosEnviados": avisos})


@walletsBp.route("/api/wallets/<walletId>/movimientos", methods=["GET"])
def historialWallet(walletId):
    """Los `limite` movimientos más recientes, leídos de la red en el momento.

    No hay cursor: cada red pagina a su manera (txid, página, firma, marcador) y
    una xpub reparte el historial entre muchas direcciones. Pedir más es pedir un
    `limite` mayor; el tope lo pone `[wallets] max_historial` y el tiempo, el
    plazo de los lectores.
    """
    maximo = settings.walletsMaxHistorial()
    try:
        limite = max(1, min(int(request.args.get("limite", 100)), maximo))
    except ValueError as error:
        raise ValidationError("«limite» debe ser un número", field="limite") from error
    repositorio = _repositorio()
    try:
        wallet = repositorio.obtener(walletId)
        movimientos = lectorPara(wallet.red).leer(wallet.tipo, wallet.valor, limite)
        libreta = _libreta(repositorio)
    except (WalletError, ErrorLecturaWallet) as error:
        raise _errorDeDominio(error) from error
    filas = [anotar(wallets_vigilancia.movimientoComoDict(m), wallet.red, libreta) for m in movimientos]
    anotarConocidos(repositorio, wallet.red, ((m.contrato, m.simbolo, "") for m in movimientos if m.contrato))
    return jsonify({
        "ok": True,
        "movimientos": filas,
        "tokensPublicos": _tokensPublicosDe((wallet.red, fila) for fila in filas),
        "limite": limite,
        "maximo": maximo,
    })


def _utxoComoDict(utxo: UtxoBitcoin) -> dict:
    return {
        "txid": utxo.txid,
        "vout": utxo.vout,
        "satoshis": utxo.satoshis,
        "cantidad": textoDecimal(utxo.cantidad),
        # Enmascarada: un visor de saldos no puede destapar sin contraseña lo que
        # /api/wallets/seguimientos/ver-completas protege con ella.
        "direccion": enmascarar(utxo.direccion),
        "altura": utxo.altura,
        "fecha": utxo.fecha.isoformat() if utxo.fecha else "",
    }


def _comisionDePeticion(valor, campo: str) -> str:
    """Una comisión en unidades del activo, sin ceros de sobra; vacía si no viene."""
    texto = asText(valor, campo, maxLength=40).replace(",", ".")
    if not texto:
        return ""
    try:
        numero = Decimal(texto)
    except InvalidOperation as error:
        raise ValidationError("La comisión debe ser un número", field=campo) from error
    if not numero.is_finite() or numero < 0:
        raise ValidationError("La comisión no puede ser negativa", field=campo)
    return textoDecimal(numero)


def _marcaDePeticion(datos: dict) -> tuple[str, str, str, bool | None]:
    """(hash, contrato, símbolo, propia) validados; `propia` None es quitar la marca."""
    hashTx = asText(datos.get("hash"), "hash", maxLength=130, required=True)
    if not _PATRON_HASH.fullmatch(hashTx):
        raise ValidationError("Hash de transacción no válido", field="hash")
    contrato = asText(datos.get("contrato"), "contrato", maxLength=100)
    if contrato and not _PATRON_HASH.fullmatch(contrato):
        raise ValidationError("Contrato no válido", field="contrato")
    simbolo = asText(datos.get("simbolo"), "simbolo", maxLength=_MAX_LARGO_SIMBOLO)
    propia = datos.get("propia")
    if propia is not None and not isinstance(propia, bool):
        raise ValidationError("Indica si la transacción es entre tus wallets", field="propia")
    return hashTx, contrato, simbolo, propia


@walletsBp.route("/api/wallets/<walletId>/movimientos/marcar", methods=["POST"])
def marcarMovimiento(walletId):
    """Marca una sola transacción como entre wallets propias o como lo que leyó la red.

    Para lo comprado en un exchange y pasado a la wallet: ya está en la posición
    por la compra y, como «entre wallets», solo descuenta su comisión. Manda sobre
    la marca de su dirección y corrige la fila de Transacciones si ya estaba.

    Cuerpo: `hash`, `contrato` ("" en la moneda de la red), `simbolo`, `sentido`
    (`enviada` o `recibida`, lo que leyó la red), `propia` (true, false o null
    para quitar la marca), `comision` (la que se descuenta) y `comisionLeida` (la
    de la red, a la que vuelve la fila sin esa marca).
    """
    datos = jsonBody()
    hashTx, contrato, simbolo, propia = _marcaDePeticion(datos)
    sentido = asText(datos.get("sentido"), "sentido", maxLength=20, required=True)
    if sentido not in SENTIDOS:
        raise ValidationError("Solo se marcan los envíos y los recibos", field="sentido")
    comision = _comisionDePeticion(datos.get("comision"), "comision") if propia else ""
    comisionLeida = _comisionDePeticion(datos.get("comisionLeida"), "comisionLeida")
    repositorio = _repositorio()
    sincronizador = SincronizadorWallets(repositorio)
    try:
        wallet = repositorio.obtener(walletId)
        if not wallet.propia:
            raise ValidationError("Las wallets ajenas solo se siguen: sus transacciones no se marcan")
        assetId = sincronizador.activoDeMovimiento(wallet, contrato, simbolo)
        marca = None
        if propia is None:
            repositorio.desmarcarMovimiento(wallet.red, hashTx, contrato)
        else:
            marca = MovimientoMarcado(red=wallet.red, hash=hashTx, contrato=contrato, propia=propia,
                                      comision=comision, assetId=assetId)
            repositorio.marcarMovimiento(marca)
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] Transacción de %s %s", wallet.red, "desmarcada" if marca is None else "marcada")
    # Como en la libreta: un fallo aquí no deshace la marca, que ya está guardada.
    try:
        aplicado = {"reetiquetadas": sincronizador.aplicarMarca(wallet.red, hashTx, assetId, sentido, comisionLeida)
                    if assetId else 0}
    except (WalletError, ErrorLecturaWallet) as error:
        log.warning("[wallets] No se pudo aplicar la marca a Transacciones: %s", error)
        aplicado = {"reetiquetadas": 0, "avisoReetiquetado": f"Lo ya importado no se ha actualizado: {error}"}
    return jsonify({"ok": True, "marca": asdict(marca) if marca else None, **aplicado})


@walletsBp.route("/api/wallets/<walletId>/utxos", methods=["GET"])
def utxosWallet(walletId):
    """Las salidas sin gastar de una wallet de Bitcoin, leídas de la red en el momento.

    Para el visor de UTXOs del detalle del seguimiento: vale igual para las
    propias y para las ajenas, porque solo lee.
    """
    try:
        wallet = _repositorio().obtener(walletId)
        if wallet.red != "btc":
            raise ValidationError("Solo las wallets de Bitcoin tienen UTXOs")
        utxos, alturaActual = lectorUtxos().utxos(wallet.tipo, wallet.valor)
    except (WalletError, ErrorLecturaWallet) as error:
        raise _errorDeDominio(error) from error
    return jsonify({
        "ok": True,
        "utxos": [_utxoComoDict(utxo) for utxo in utxos],
        "alturaActual": alturaActual,
        "total": textoDecimal(sum((utxo.cantidad for utxo in utxos), Decimal(0))),
    })


@walletsBp.route("/api/wallets/<walletId>/tokens", methods=["GET"])
def tokensWallet(walletId):
    """Saldo actual de cada token de una wallet de Ethereum o BNB, leído de la red en el momento.

    Para el visor de tokens del detalle del seguimiento: como el de UTXOs, vale
    para las propias y para las ajenas, porque solo lee.
    """
    try:
        resultado = VisorTokens(_repositorio()).leer(walletId)
    except (WalletError, ErrorLecturaWallet) as error:
        raise _errorDeDominio(error) from error
    return jsonify({"ok": True, **resultado})


@walletsBp.route("/api/wallets/<walletId>/sincronizar", methods=["POST"])
def sincronizarWallet(walletId):
    try:
        if not _repositorio().obtener(walletId).propia:
            raise ValidationError("Las wallets ajenas solo se siguen: no se importan a Transacciones")
        resultado = SincronizadorWallets().sincronizar(walletId)
    except ActivoDeWalletInexistente as error:
        raise ValidationError(str(error)) from error
    except (WalletError, ErrorLecturaWallet) as error:
        raise _errorDeDominio(error) from error
    return jsonify({"ok": True, **resultado.comoDict()})


def _tokenDePeticion(datos: dict) -> tuple[str, str]:
    """(red, contrato) validados; solo en redes cuyos tokens se leen."""
    red = asText(datos.get("red"), "red", maxLength=10, required=True).lower()
    if red not in REDES or not REDES[red].exploradorToken:
        raise ValidationError("En esa red no se leen tokens", field="red")
    try:
        contrato = normalizarDatoWallet(red, TIPO_DIRECCION, asText(datos.get("contrato"), "contrato", maxLength=100,
                                                                     required=True))
    except DatoWalletInvalido as error:
        raise ValidationError(f"Contrato no válido: {error}", field="contrato") from error
    return red, contrato


@walletsBp.route("/api/wallets/tokens/verificar", methods=["POST"])
def verificarToken():
    """Confirma un contrato como el auténtico de su símbolo en su red.

    Cuerpo: `red`, `contrato` y `simbolo` (el que trae el token en la red).
    Desde entonces los demás contratos con ese símbolo en esa red son imitaciones.
    """
    datos = jsonBody()
    red, contrato = _tokenDePeticion(datos)
    simbolo = asText(datos.get("simbolo"), "simbolo", maxLength=_MAX_LARGO_SIMBOLO, required=True)
    # Misma limpieza que los lectores, para que el símbolo coincida con el de los movimientos.
    simbolo = "".join(c for c in simbolo if c.isalnum()).upper()
    if not simbolo:
        raise ValidationError("Falta el símbolo del token", field="simbolo")
    if esNombreDeLaRed(red, simbolo):
        raise ValidationError(f"Un token llamado {simbolo} en {REDES[red].nombre} es siempre una imitación",
                              field="simbolo")
    repositorio = _repositorio()
    try:
        repositorio.verificarToken(TokenVerificado(red=red, contrato=contrato, simbolo=simbolo))
        respuesta = _respuestaTokens(repositorio)
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] Token %s verificado en %s", simbolo, red)
    return respuesta


@walletsBp.route("/api/wallets/tokens/olvidar", methods=["POST"])
def olvidarToken():
    """Quita la verificación de un contrato. Cuerpo: `red` y `contrato`."""
    red, contrato = _tokenDePeticion(jsonBody())
    repositorio = _repositorio()
    try:
        repositorio.olvidarToken(red, contrato)
        respuesta = _respuestaTokens(repositorio)
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] Verificación de un token quitada en %s", red)
    return respuesta


@walletsBp.route("/api/wallets/tokens/marcar", methods=["POST"])
def marcarToken():
    """Guarda la decisión del usuario sobre un contrato, que manda sobre la detección automática.

    Cuerpo: `red`, `contrato` y `marca` (`imitacion` o `legitimo`). Sustituye a
    la verificación del contrato, si la tenía.
    """
    datos = jsonBody()
    red, contrato = _tokenDePeticion(datos)
    marca = asText(datos.get("marca"), "marca", maxLength=20, required=True)
    if marca not in MARCAS_TOKEN:
        raise ValidationError("Marca no válida", field="marca")
    repositorio = _repositorio()
    try:
        repositorio.marcarToken(TokenMarcado(red=red, contrato=contrato, marca=marca))
        respuesta = _respuestaTokens(repositorio)
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] Token marcado como %s en %s", marca, red)
    return respuesta


@walletsBp.route("/api/wallets/tokens/desmarcar", methods=["POST"])
def desmarcarToken():
    """Quita la decisión sobre un contrato, que vuelve a la detección automática. Cuerpo: `red` y `contrato`."""
    red, contrato = _tokenDePeticion(jsonBody())
    repositorio = _repositorio()
    try:
        repositorio.desmarcarToken(red, contrato)
        respuesta = _respuestaTokens(repositorio)
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] Marca de un token quitada en %s", red)
    return respuesta


@walletsBp.route("/api/wallets/tokens/sospechoso", methods=["POST"])
def etiquetarSospechoso():
    """Pone o quita la etiqueta de sospechoso de un contrato.

    Cuerpo: `red`, `contrato` y `sospechoso` (booleano). Es solo una etiqueta:
    no cambia la marca, la verificación ni lo que se importa.
    """
    datos = jsonBody()
    red, contrato = _tokenDePeticion(datos)
    sospechoso = datos.get("sospechoso")
    if not isinstance(sospechoso, bool):
        raise ValidationError("Indica si el token es sospechoso", field="sospechoso")
    repositorio = _repositorio()
    try:
        if sospechoso:
            repositorio.marcarSospechoso(red, contrato)
        else:
            repositorio.desmarcarSospechoso(red, contrato)
        respuesta = _respuestaTokens(repositorio)
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] Token %s como sospechoso en %s", "etiquetado" if sospechoso else "desetiquetado", red)
    return respuesta


def _tickerDePeticion(datos: dict) -> tuple[str, str]:
    """(proveedor, ticker) validados; el proveedor por defecto es el primero de `PROVEEDORES_PRECIO`."""
    proveedor = asText(datos.get("proveedor"), "proveedor", default=PROVEEDORES_PRECIO[0], maxLength=20).lower()
    if proveedor not in PROVEEDORES_PRECIO:
        raise ValidationError("Proveedor de cotización no válido", field="proveedor")
    ticker = asText(datos.get("ticker"), "ticker", maxLength=MAX_LARGO_TICKER, required=True).upper()
    if not _PATRON_TICKER.fullmatch(ticker):
        raise ValidationError("El ticker solo lleva letras, números y : . _ - ^ = /", field="ticker")
    return proveedor, ticker


def _duenoTickerDePeticion(datos: dict) -> tuple[str, str]:
    """(red, contrato) a los que se pone un ticker; sin contrato es la moneda de la red, y vale cualquier red."""
    if asText(datos.get("contrato"), "contrato", maxLength=100):
        return _tokenDePeticion(datos)
    red = asText(datos.get("red"), "red", maxLength=10, required=True).lower()
    if red not in REDES:
        raise ValidationError("Red no válida", field="red")
    return red, ""


@walletsBp.route("/api/wallets/tokens/precio", methods=["POST"])
def ponerPrecioToken():
    """Pone el ticker con el que se cotiza un token o, sin `contrato`, la moneda de la red.

    Cuerpo: `red`, `contrato`, `proveedor` y `ticker`. Antes de guardarlo se pide
    la cotización: un ticker que no cotiza dejaría el token sin valor sin que el
    usuario supiera por qué.
    """
    datos = jsonBody()
    red, contrato = _duenoTickerDePeticion(datos)
    proveedor, ticker = _tickerDePeticion(datos)
    cotizacion, error = fetchAssetQuote(ticker, proveedor)
    if error or not cotizacion or not cotizacion.get("price"):
        raise ValidationError(f"No se encuentra cotización para {ticker}: {error or 'sin precio'}", field="ticker")
    repositorio = _repositorio()
    try:
        repositorio.guardarPrecioToken(TokenPrecio(red=red, contrato=contrato, proveedor=proveedor, ticker=ticker))
        respuesta = _respuestaTokens(repositorio)
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] Ticker %s (%s) puesto a un token de %s", ticker, proveedor, red)
    return respuesta


@walletsBp.route("/api/wallets/tokens/precio/quitar", methods=["POST"])
def quitarPrecioToken():
    """Quita el ticker de cotización de un token o, sin `contrato`, de la moneda de la red. Cuerpo: `red` y `contrato`."""
    red, contrato = _duenoTickerDePeticion(jsonBody())
    repositorio = _repositorio()
    try:
        repositorio.quitarPrecioToken(red, contrato)
        respuesta = _respuestaTokens(repositorio)
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] Ticker de un token quitado en %s", red)
    return respuesta


@walletsBp.route("/api/wallets/watchlist", methods=["GET"])
def watchlistWallets():
    """La cripto de las wallets para la lista «Seguimiento» de la Watchlist (`core.wallets_watchlist`)."""
    try:
        entradas = ListaWatchlist(_repositorio()).entradas()
    except WalletError as error:
        raise _errorDeDominio(error) from error
    return jsonify({"ok": True, "entradas": entradas})


def _respuestaTokens(repositorio: WalletsRepository):
    """Las listas de tokens tras un cambio: verificar quita la marca del contrato y marcar, su verificación.

    Raises:
        WalletError: si el fichero no se puede leer.
    """
    return jsonify({
        "ok": True,
        "tokensVerificados": [asdict(t) for t in repositorio.tokensVerificados()],
        "tokensMarcados": [asdict(m) for m in repositorio.marcasToken()],
        "tokensSospechosos": [asdict(s) for s in repositorio.tokensSospechosos()],
        "preciosToken": [asdict(p) for p in repositorio.preciosToken()],
    })


def _respuestaLibreta(direcciones: list[DireccionMarcada], wallets: list[Wallet]) -> dict:
    """Las direcciones marcadas y las que cuentan como propias por ser de una wallet enlazada.

    Las de las wallets enlazadas van enmascaradas, como en el resto de respuestas.
    """
    return {
        "direcciones": [asdict(d) for d in direcciones],
        "direccionesEnlazadas": [
            {"walletId": w.id, "red": w.red, "valorEnmascarado": enmascarar(w.valor), "apodo": w.nombreSeguimiento}
            for w in wallets if entraEnLibreta(w)
        ],
    }


def _reetiquetar(red: str, direccion: str) -> dict:
    """Aplica la libreta a lo ya importado de esa dirección.

    Un fallo no deshace el cambio ya guardado en la libreta: se devuelve como
    aviso, y el siguiente cambio de esa dirección lo vuelve a intentar.
    """
    try:
        return {"reetiquetadas": SincronizadorWallets().reetiquetar(red, direccion)}
    except (WalletError, ErrorLecturaWallet) as error:
        log.warning("[wallets] No se pudo reetiquetar Transacciones: %s", error)
        return {"reetiquetadas": 0, "avisoReetiquetado": f"Lo ya importado no se ha actualizado: {error}"}


def _direccionDePeticion(datos: dict) -> tuple[str, str]:
    """(red, dirección en forma canónica) validados."""
    red = asText(datos.get("red"), "red", maxLength=10, required=True).lower()
    if red not in REDES:
        raise ValidationError("Red no soportada", field="red")
    try:
        direccion = normalizarDatoWallet(red, TIPO_DIRECCION, asText(datos.get("direccion"), "direccion",
                                                                     maxLength=100, required=True))
    except DatoWalletInvalido as error:
        raise ValidationError(str(error), field="direccion") from error
    return red, direccion


def _estadoDireccion(repositorio: WalletsRepository, red: str, direccion: str) -> dict:
    """La libreta tras un cambio, cómo queda esa dirección y lo reetiquetado en Transacciones."""
    reetiquetado = _reetiquetar(red, direccion)
    try:
        direcciones, wallets = repositorio.direcciones(), repositorio.listar()
    except WalletError as error:
        raise _errorDeDominio(error) from error
    return {
        "ok": True,
        "red": red,
        "direccion": direccion,
        "efectiva": entradaComoDict(Libreta.desde(direcciones, wallets).buscar(red, direccion)),
        **_respuestaLibreta(direcciones, wallets),
        **reetiquetado,
    }


def _respuestaDireccion(repositorio: WalletsRepository, red: str, direccion: str):
    """`_estadoDireccion` como respuesta HTTP."""
    return jsonify(_estadoDireccion(repositorio, red, direccion))


def _seguimientoDePeticion(datos: dict) -> str:
    """Nombre del seguimiento sin espacios repetidos, para no abrir uno aparte en pantalla."""
    return " ".join(asText(datos.get("seguimiento"), "seguimiento", maxLength=MAX_LARGO_ALIAS, required=True).split())


@walletsBp.route("/api/wallets/direcciones/guardar", methods=["POST"])
def guardarDireccion():
    """Marca una dirección como propia o ajena, con un apodo opcional.

    Cuerpo: `red`, `direccion`, `apodo` y `propia` (booleano). Si ya estaba en
    la libreta, se sustituyen su apodo y su marca. Lo ya importado a
    Transacciones con esa contraparte se reetiqueta.
    """
    datos = jsonBody()
    red, direccion = _direccionDePeticion(datos)
    apodo = " ".join(asText(datos.get("apodo"), "apodo", maxLength=MAX_LARGO_ALIAS).split())
    propia = datos.get("propia")
    if not isinstance(propia, bool):
        raise ValidationError("Indica si la dirección es tuya o ajena", field="propia")
    repositorio = _repositorio()
    try:
        repositorio.guardarDireccion(DireccionMarcada(red=red, direccion=direccion, apodo=apodo, propia=propia))
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] Dirección de %s marcada como %s", red, "propia" if propia else "ajena")
    return _respuestaDireccion(repositorio, red, direccion)


@walletsBp.route("/api/wallets/direcciones/olvidar", methods=["POST"])
def olvidarDireccion():
    """Quita una dirección de la libreta y reetiqueta lo importado. Cuerpo: `red` y `direccion`."""
    red, direccion = _direccionDePeticion(jsonBody())
    repositorio = _repositorio()
    try:
        repositorio.olvidarDireccion(red, direccion)
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] Dirección de %s quitada de la libreta", red)
    return _respuestaDireccion(repositorio, red, direccion)


@walletsBp.route("/api/wallets/direcciones/vincular", methods=["POST"])
def vincularDireccion():
    """Vincula a un seguimiento una dirección marcada como propia: pasa a ser una wallet más.

    Cuerpo: `red`, `direccion`, `seguimiento` (nuevo o existente) y `assetId`.
    Desde ahí se vigila, suma al total y entra en la Watchlist y en Sincronizar.
    Las direcciones ya vistas con ella en Transacciones toman el nombre del seguimiento.
    """
    datos = jsonBody()
    red, direccion = _direccionDePeticion(datos)
    seguimiento = _seguimientoDePeticion(datos)
    assetId = _activoValido(asText(datos.get("assetId"), "assetId", maxLength=200), propia=True)
    repositorio = _repositorio()
    try:
        wallet = repositorio.vincularDireccion(red, direccion, seguimiento, assetId)
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] Dirección de %s vinculada a un seguimiento como %s", red, wallet.id)
    # Sin `direccion`: desde ahora es una wallet enlazada y sale enmascarada.
    estado = {k: v for k, v in _estadoDireccion(repositorio, red, direccion).items() if k != "direccion"}
    return jsonify({**estado, "wallet": wallet.resumen()})


@walletsBp.route("/api/wallets/<walletId>/seguimiento", methods=["POST"])
def moverWalletDeSeguimiento(walletId):
    """Pasa una wallet a otro seguimiento, nuevo o existente. Cuerpo: `seguimiento`."""
    seguimiento = _seguimientoDePeticion(jsonBody())
    repositorio = _repositorio()
    try:
        wallet = repositorio.moverASeguimiento(walletId, seguimiento)
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] %s movida de seguimiento", walletId)
    reetiquetado = _reetiquetar(wallet.red, wallet.valor) if entraEnLibreta(wallet) else {}
    return jsonify({"ok": True, "wallet": wallet.resumen(), **reetiquetado})


@walletsBp.route("/api/wallets/<walletId>/a-libreta", methods=["POST"])
def devolverWalletALibreta(walletId):
    """Saca una dirección propia de su seguimiento y la deja en la libreta como «mía».

    Deja de vigilarse y de sumar al total, y pierde sus lecturas y avisos. Lo
    enviado a ella sigue contando como «entre wallets».

    Pide la contraseña de acceso, como /api/wallets/direcciones/ver-completas: la
    libreta enseña sus direcciones enteras, así que sin ella una cookie de sesión
    bastaría para destapar una dirección enlazada. Cuerpo: `currentPassword`.
    """
    # Importado aquí, como en routes/backup.py: auth importa medio servidor.
    from routes import auth

    bloqueado = auth._rechazarSiBloqueado()
    if bloqueado:
        return bloqueado
    rechazo = auth._comprobarContrasenaActual(auth._texto(auth._cuerpoDict().get("currentPassword")),
                                              "sacar una wallet de su seguimiento")
    if rechazo:
        return rechazo
    auth._clearFailures(auth._clientIp())
    repositorio = _repositorio()
    try:
        marcada = repositorio.devolverALibreta(walletId)
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] %s devuelta a la libreta", walletId)
    respuesta = _respuestaDireccion(repositorio, marcada.red, marcada.direccion)
    respuesta.headers["Cache-Control"] = "no-store"
    return respuesta


@walletsBp.route("/api/wallets/direcciones/ver-completas", methods=["POST"])
def verDireccionesCompletas():
    """Direcciones completas de las wallets enlazadas de la libreta, tras la contraseña de acceso.

    Mismas garantías que /api/wallets/seguimientos/ver-completas: se pide la
    contraseña cada vez, comparte el contador de intentos con /login y la
    respuesta no se guarda en la caché del navegador. Solo devuelve las que
    salen en la libreta (direcciones de wallets propias), nunca xpub ni claves.
    """
    from routes import auth

    bloqueado = auth._rechazarSiBloqueado()
    if bloqueado:
        return bloqueado
    datos = auth._cuerpoDict()
    rechazo = auth._comprobarContrasenaActual(auth._texto(datos.get("currentPassword")), "ver direcciones completas")
    if rechazo:
        return rechazo
    auth._clearFailures(auth._clientIp())
    try:
        wallets = [w for w in _repositorio().listar() if entraEnLibreta(w)]
    except WalletError as error:
        raise _errorDeDominio(error) from error
    log.info("[wallets] Mostradas completas las %d direcciones enlazadas de la libreta", len(wallets))
    respuesta = jsonify({"ok": True, "valores": {w.id: w.valor for w in wallets}})
    respuesta.headers["Cache-Control"] = "no-store"
    return respuesta


@walletsBp.route("/api/wallets/direcciones/saldo", methods=["POST"])
def saldoDireccion():
    """Saldo de la moneda nativa de una dirección de la libreta, leído de la red en el momento.

    Cuerpo: `red` y `direccion`. No se guarda: las direcciones marcadas no se
    vigilan, solo se consultan cuando el usuario lo pide.
    """
    red, direccion = _direccionDePeticion(jsonBody())
    try:
        saldo = lectorPara(red).saldo(TIPO_DIRECCION, direccion)
    except ErrorLecturaWallet as error:
        raise _errorDeDominio(error) from error
    return jsonify({"ok": True, "red": red, "direccion": direccion, "saldo": textoDecimal(saldo),
                    "simbolo": REDES[red].simbolo})


@walletsBp.route("/api/wallets/vigilancia", methods=["POST"])
def guardarVigilancia():
    """Cada cuántos minutos se revisan las wallets en segundo plano (0 = nunca)."""
    # Importado aquí: es el único sitio que escribe ajustes.json, y así este
    # ajuste se guarda saneado junto al resto, sin pisar los demás.
    from routes import ajustes as rutasAjustes

    minutos = jsonBody().get("minutos")
    if isinstance(minutos, bool) or minutos not in wallets_vigilancia.OPCIONES_MINUTOS:
        raise ValidationError("Intervalo no válido", field="minutos")
    datos = rutasAjustes._readAjustes()
    datos[wallets_vigilancia.CLAVE_AJUSTE_MINUTOS] = minutos
    rutasAjustes._writeAjustes(datos)
    return jsonify({"ok": True, "vigilanciaMinutos": minutos})


@walletsBp.route("/api/wallets/etherscan", methods=["POST"])
def guardarClaveEtherscan():
    clave = asText(jsonBody().get("clave"), "clave", maxLength=_MAX_LARGO_CLAVE_API, required=True)
    if not clave.isalnum():
        raise ValidationError("Una clave de Etherscan solo lleva letras y números", field="clave")
    # Mismo requisito que las wallets: la clave no se guarda en claro.
    if fernetWallets() is None:
        raise _errorDeDominio(CifradoNoDisponible(
            "Hace falta una SECRET_KEY aleatoria en .env para guardar la clave cifrada"
        ))
    writeSecretLines(paths.API_DIR / "etherscan.key", [clave])
    return jsonify({"ok": True})
