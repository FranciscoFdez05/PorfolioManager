"""Endpoints para el Atajo de iOS: alta de movimientos y catálogo de categorías.

Estas rutas no pasan por la sesión de la web app (un Atajo no puede mantener la
cookie ni el token CSRF), así que están exentas de require_login en server.py y
se protegen con dos barreras propias:

  1. Filtro de IP (core/red_local.py): solo LAN y WireGuard.
  2. Firma HMAC-SHA256 (core/firma_hmac.py) sobre timestamp + cuerpo crudo.

Ambas se comprueban antes de tocar la base de datos.
"""

import json
import logging
import time

from flask import Blueprint, jsonify, request

from admin.portfolios_manager import (
    find_portfolio_id,
    get_active_portfolio_id,
    get_portfolio_db_path,
    get_portfolios,
)
from core.db import open_db_at
from core.firma_hmac import (
    ErrorFirma,
    calcularFirma,
    construirMensaje,
    maxTextoFirma,
    verificarPeticionFirmada,
)
from core.red_local import soloRedLocal
from stores.movimientos_store import (
    TIPOS_VALIDOS,
    DatosMovimientoInvalidos,
    crearMovimiento,
    leerCategorias,
    sanitizarMovimiento,
)

log = logging.getLogger(__name__)

movimientos_bp = Blueprint("movimientos", __name__)

# Campos que /api/preparar acepta y serializa. Cualquier otra clave que mande el
# cliente se descarta: el cuerpo firmado solo puede contener lo que el endpoint
# de alta va a leer.
CAMPOS_MOVIMIENTO = ("tipo", "categoria", "nombre", "importe", "fecha", "portfolio")


def _resolverPortfolio(pid):
    """Traduce un id **o nombre** de portfolio a la ruta de su .db.

    Devuelve (ruta, None) o (None, respuestaDeError). Sin valor se usa el
    portfolio activo, con lo que un Atajo que no lo mande sigue funcionando
    igual que antes.
    """
    texto = str(pid or "").strip()

    if not texto:
        return None, None

    identificador = find_portfolio_id(texto)

    if identificador is None:
        log.warning("[movimientos] Portfolio inexistente solicitado: %r", texto)
        return None, (jsonify({"ok": False, "error": f"Portfolio '{texto}' no encontrado"}), 404)

    try:
        return get_portfolio_db_path(identificador), None
    except ValueError:
        return None, (jsonify({"ok": False, "error": f"Portfolio '{texto}' no encontrado"}), 404)


@movimientos_bp.route("/api/movimiento", methods=["POST"])
@soloRedLocal
def createMovimiento():
    # get_data() cachea el cuerpo, así que get_json() más abajo sigue funcionando.
    cuerpoRaw = request.get_data(cache=True)

    try:
        verificarPeticionFirmada(request.headers, cuerpoRaw)
    except ErrorFirma as error:
        log.warning("[movimientos] Firma rechazada desde %s: %s", request.remote_addr, error.mensaje)
        return jsonify({"ok": False, "error": error.mensaje}), error.status

    payload = request.get_json(silent=True)

    if payload is None:
        return jsonify({"ok": False, "error": "El cuerpo debe ser JSON válido"}), 400

    try:
        movimiento = sanitizarMovimiento(payload)
    except DatosMovimientoInvalidos as error:
        return jsonify({"ok": False, "error": str(error)}), 400

    # El portfolio viaja dentro del JSON, no en la query string, para que quede
    # cubierto por la firma: si no, cualquiera podría redirigir el movimiento a
    # otra base de datos sin invalidar el HMAC.
    rutaPortfolio, errorPortfolio = _resolverPortfolio(payload.get("portfolio"))
    if errorPortfolio:
        return errorPortfolio

    if rutaPortfolio is None:
        creado = crearMovimiento(movimiento)
    else:
        with open_db_at(rutaPortfolio) as conn:
            creado = crearMovimiento(movimiento, conn=conn)

    creado["portfolio"] = str(payload.get("portfolio") or "").strip() or (get_active_portfolio_id() or "")
    log.info(
        "[movimientos] %s registrado en '%s': %s (%s)",
        creado["tipo"], creado["portfolio"], creado["nombre"], creado["cantidad"],
    )

    return jsonify({"ok": True, "movimiento": creado}), 201


@movimientos_bp.route("/api/portfolios-lista", methods=["GET"])
@soloRedLocal
def getPortfoliosLista():
    """Portfolios disponibles, para que el Atajo tampoco los lleve escritos.

    Cada usuario tiene los suyos y puede crear más desde la web, así que la
    lista se pide en tiempo de ejecución igual que las categorías.
    """
    meta = get_portfolios() or {}
    activo = meta.get("active")

    portfolios = [
        {"id": p.get("id", ""), "nombre": p.get("name", ""), "activo": p.get("id") == activo}
        for p in meta.get("portfolios", [])
        if p.get("id")
    ]

    # Atajos no sabe presentar una lista de diccionarios de forma legible, así
    # que se sirve también la lista plana de nombres y el diccionario que los
    # traduce a id: el mismo patrón que ya usa el Atajo con las categorías.
    nombres = []
    idPorNombre = {}

    for portfolio in portfolios:
        etiqueta = portfolio["nombre"] or portfolio["id"]

        # Dos portfolios pueden llamarse igual (el id sí es único), y entonces
        # el diccionario perdería uno de los dos.
        if etiqueta in idPorNombre:
            etiqueta = f"{etiqueta} ({portfolio['id']})"

        nombres.append(etiqueta)
        idPorNombre[etiqueta] = portfolio["id"]

    return jsonify({
        "portfolios": portfolios,
        "nombres": nombres,
        "idPorNombre": idPorNombre,
        "activo": activo or "",
    })


@movimientos_bp.route("/api/categorias", methods=["GET"])
@soloRedLocal
def getCategorias():
    """Categorías vivas de la base de datos, para que el Atajo no las hardcodee.

    Se devuelven separadas por tipo y además en una lista plana: el Atajo puede
    usar la que le convenga según si ya ha preguntado ingreso/gasto o no.

    Acepta ?portfolio=<id-o-nombre> porque cada base de datos tiene sus
    categorías; sin el parámetro se lee la activa.

    Acepta también ?tipo=gasto|ingreso y entonces añade `lista` con solo las de
    ese tipo. Existe para el Atajo de iOS: sin esto tenía que hacer un segundo
    «Obtener valor del diccionario» usando una variable como clave, que es la
    acción más frágil de montar a mano. Con `lista` la clave se teclea.
    """
    rutaPortfolio, errorPortfolio = _resolverPortfolio(request.args.get("portfolio"))
    if errorPortfolio:
        return errorPortfolio

    tipoPedido = str(request.args.get("tipo") or "").strip().lower()

    # Un tipo mal escrito devuelve error en vez de una lista vacía: vacío haría
    # que el Atajo se saltara el paso de elegir en silencio, que es justo el
    # fallo más difícil de localizar.
    if tipoPedido and tipoPedido not in TIPOS_VALIDOS:
        return jsonify({
            "ok": False,
            "error": f"El parámetro 'tipo' debe ser {' o '.join(TIPOS_VALIDOS)}, no '{tipoPedido}'",
        }), 400

    if rutaPortfolio is None:
        categorias = leerCategorias()
    else:
        with open_db_at(rutaPortfolio) as conn:
            categorias = leerCategorias(conn=conn)

    todas = sorted(
        {etiqueta for lista in categorias.values() for etiqueta in lista},
        key=lambda texto: texto.lower(),
    )

    respuesta = {"categorias": categorias, "todas": todas}

    if tipoPedido:
        respuesta["tipo"] = tipoPedido
        respuesta["lista"] = categorias.get(tipoPedido, [])

    return jsonify(respuesta)


@movimientos_bp.route("/api/preparar", methods=["POST"])
@soloRedLocal
def prepararMovimiento():
    """Construye el cuerpo JSON del movimiento y lo firma, en una sola llamada.

    Existe para que el Atajo no tenga que escribir JSON a mano. Montarlo con una
    acción «Texto» obliga a teclear comillas y llaves, y arrastra tres
    problemas: un concepto con comillas dobles rompe el JSON, un importe con
    coma decimal lo invalida, y cualquier reserialización por parte de Atajos
    cambia los bytes y tumba la firma.

    Aquí el Atajo manda un diccionario nativo con los campos sueltos y recibe
    `cuerpo` (el texto exacto a enviar), `firma` y `timestamp`. Como el mismo
    proceso que firma es el que serializa, los bytes coinciden por construcción.

    El cuerpo se genera en ASCII puro (los acentos van como \\uXXXX), así que no
    puede haber discrepancias de codificación entre lo que se firma aquí y lo
    que el iPhone envía después.
    """
    payload = request.get_json(silent=True)

    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "El cuerpo debe ser un objeto JSON"}), 400

    datos = {}
    for campo in CAMPOS_MOVIMIENTO:
        valor = payload.get(campo)
        if valor is None or valor == "":
            continue
        datos[campo] = valor if isinstance(valor, (int, float)) and not isinstance(valor, bool) else str(valor)

    # Se valida antes de firmar: así un fallo del usuario sale aquí con un
    # mensaje claro en vez de convertirse en un 400 opaco en /api/movimiento.
    try:
        sanitizarMovimiento(datos)
    except DatosMovimientoInvalidos as error:
        return jsonify({"ok": False, "error": str(error)}), 400

    _, errorPortfolio = _resolverPortfolio(datos.get("portfolio"))
    if errorPortfolio:
        return errorPortfolio

    cuerpo = json.dumps(datos, sort_keys=True, separators=(",", ":"))

    if len(cuerpo) > maxTextoFirma():
        return jsonify({"ok": False, "error": "El contenido a firmar es demasiado largo"}), 400

    timestamp = int(time.time())

    try:
        firma = calcularFirma(construirMensaje(timestamp, cuerpo))
    except ErrorFirma as error:
        return jsonify({"ok": False, "error": error.mensaje}), error.status

    return jsonify({"ok": True, "cuerpo": cuerpo, "firma": firma, "timestamp": str(timestamp)})


@movimientos_bp.route("/api/firmar", methods=["POST"])
@soloRedLocal
def firmarTexto():
    """Calcula el HMAC que el Atajo no puede calcular por su cuenta.

    La acción nativa "Hash" de Atajos no admite clave, así que la firma la hace
    el servidor. Este endpoint solo está protegido por el filtro de IP: quien
    pueda alcanzarlo desde la LAN o el túnel puede firmar cualquier texto, de
    modo que la firma protege frente a terceros en la red, no frente a un
    dispositivo ya dentro de ella.

    Admite dos formas:

      {"cuerpo": "<json>"}  el servidor pone su propio timestamp y devuelve
                            firma y timestamp ya listos para las cabeceras.
      {"texto": "<ts>.<json>"}  firma literal del texto recibido, para quien
                            prefiera construir el mensaje por su cuenta.

    La primera existe porque Atajos no tiene ninguna acción que devuelva un
    epoch en segundos, y porque usar el reloj del servidor elimina de raíz el
    desfase con la ventana de tolerancia.
    """
    payload = request.get_json(silent=True)

    if not isinstance(payload, dict):
        return jsonify({"ok": False, "error": "El cuerpo debe ser un objeto JSON"}), 400

    cuerpo = payload.get("cuerpo")
    texto = payload.get("texto")
    timestamp = None

    if isinstance(cuerpo, str) and cuerpo:
        timestamp = int(time.time())
        mensaje = construirMensaje(timestamp, cuerpo)
        longitud = len(cuerpo)
    elif isinstance(texto, str) and texto:
        mensaje = texto
        longitud = len(texto)
    else:
        return jsonify({"ok": False, "error": "Se requiere el campo 'cuerpo' o el campo 'texto'"}), 400

    if longitud > maxTextoFirma():
        return jsonify({"ok": False, "error": "El contenido a firmar es demasiado largo"}), 400

    try:
        firma = calcularFirma(mensaje)
    except ErrorFirma as error:
        return jsonify({"ok": False, "error": error.mensaje}), error.status

    respuesta = {"ok": True, "firma": firma}

    if timestamp is not None:
        respuesta["timestamp"] = str(timestamp)

    return jsonify(respuesta)
