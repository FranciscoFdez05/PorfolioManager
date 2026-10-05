import logging

from flask import Blueprint, jsonify, request

from routes.ajustes import _active_portfolio_id, _read_prefs, _write_prefs
from stores.cuenta_ahorro_store import (
    TIPO_AHORRO,
    CuentaConMovimientos,
    MovimientoInvalido,
    anadir_movimiento,
    aplicar_recurrentes,
    crear_cuenta,
    eliminar_cuenta,
    eliminar_movimiento,
    listar_cuentas,
    listar_movimientos,
    modificar_movimiento,
    renombrar_cuenta,
)

log = logging.getLogger(__name__)

cuenta_ahorro_bp = Blueprint("cuenta_ahorro", __name__)


def _error(error, codigo=400):
    return jsonify({"ok": False, "error": str(error)}), codigo


def _aplicar_aportaciones_automaticas():
    """Crea las aportaciones mensuales que ya tocan. Se llama al abrir la ventana."""
    pid = _active_portfolio_id()
    prefs = _read_prefs(pid)
    generado = prefs.get("cuentaAhorroGenerado") or {}

    nuevo, creados = aplicar_recurrentes(prefs.get("cuentaAhorroConfig"), generado)
    if nuevo != generado:
        prefs["cuentaAhorroGenerado"] = nuevo
        try:
            _write_prefs(pid, prefs)
        except OSError:
            # Los movimientos ya están creados: si el estado no se guarda, la
            # próxima vez se duplicarían. Se avisa en el log con todo detalle.
            log.exception("[cuenta-ahorro] No se pudo guardar el estado de las aportaciones automáticas")
    return creados


def _clave_estado(nombre):
    return str(nombre or "").strip().lower() or "_"


def _mover_estado(de, a=None):
    """Pasa (o quita, si `a` es None) el estado de aportaciones de una cuenta.

    Sin esto, una cuenta renombrada perdería su último mes creado y la próxima
    vez se regenerarían todas las aportaciones desde el mes de inicio.
    """
    pid = _active_portfolio_id()
    prefs = _read_prefs(pid)
    generado = dict(prefs.get("cuentaAhorroGenerado") or {})
    origen = _clave_estado(de)
    if origen not in generado:
        return
    valor = generado.pop(origen)
    if a is not None:
        generado[_clave_estado(a)] = valor
    prefs["cuentaAhorroGenerado"] = generado
    try:
        _write_prefs(pid, prefs)
    except OSError:
        log.exception("[cuenta-ahorro] No se pudo actualizar el estado de las aportaciones automáticas")


@cuenta_ahorro_bp.route("/api/cuenta-ahorro", methods=["GET"])
def getCuentaAhorro():
    _aplicar_aportaciones_automaticas()
    return jsonify({
        "tipo": TIPO_AHORRO,
        "cuentas": listar_cuentas(),
        "movimientos": listar_movimientos(),
    })


@cuenta_ahorro_bp.route("/api/cuenta-ahorro/movimientos", methods=["POST"])
def addMovimientoAhorro():
    datos = request.get_json(silent=True) or {}

    try:
        movimiento = anadir_movimiento(
            datos.get("kind"),
            datos.get("fecha"),
            datos.get("nombre"),
            datos.get("cantidad"),
            datos.get("nota"),
            datos.get("cuenta"),
        )
    except MovimientoInvalido as error:
        return _error(error)

    return jsonify({"ok": True, "movimiento": movimiento}), 201


@cuenta_ahorro_bp.route("/api/cuenta-ahorro/movimientos/editar", methods=["POST"])
def editMovimientoAhorro():
    datos = request.get_json(silent=True) or {}

    try:
        movimiento = modificar_movimiento(
            datos.get("kind"),
            datos.get("id"),
            datos.get("fechaOriginal"),
            datos.get("cantidadOriginal"),
            datos.get("kindNuevo", datos.get("kind")),
            datos.get("fecha"),
            datos.get("nombre"),
            datos.get("cantidad"),
            datos.get("nota"),
        )
    except MovimientoInvalido as error:
        return _error(error)

    if movimiento is None:
        return _error("El movimiento ya no existe o ha cambiado", 404)

    return jsonify({"ok": True, "movimiento": movimiento})


@cuenta_ahorro_bp.route("/api/cuenta-ahorro/movimientos/eliminar", methods=["POST"])
def deleteMovimientoAhorro():
    datos = request.get_json(silent=True) or {}

    try:
        borrado = eliminar_movimiento(
            datos.get("kind"), datos.get("id"), datos.get("fecha"), datos.get("cantidad")
        )
    except MovimientoInvalido as error:
        return _error(error)

    if not borrado:
        return _error("El movimiento ya no existe o ha cambiado", 404)

    return jsonify({"ok": True})


@cuenta_ahorro_bp.route("/api/cuenta-ahorro/cuentas", methods=["POST"])
def addCuentaAhorro():
    datos = request.get_json(silent=True) or {}

    try:
        nombre = crear_cuenta(datos.get("nombre"))
    except MovimientoInvalido as error:
        return _error(error)

    return jsonify({"ok": True, "nombre": nombre}), 201


@cuenta_ahorro_bp.route("/api/cuenta-ahorro/cuentas/renombrar", methods=["POST"])
def renameCuentaAhorro():
    datos = request.get_json(silent=True) or {}

    try:
        nombre = renombrar_cuenta(datos.get("de"), datos.get("a"))
    except MovimientoInvalido as error:
        return _error(error)

    _mover_estado(datos.get("de"), nombre)

    return jsonify({"ok": True, "nombre": nombre})


@cuenta_ahorro_bp.route("/api/cuenta-ahorro/cuentas/eliminar", methods=["POST"])
def deleteCuentaAhorro():
    datos = request.get_json(silent=True) or {}

    try:
        eliminar_cuenta(datos.get("nombre"))
    except MovimientoInvalido as error:
        return _error(error)
    except CuentaConMovimientos:
        return _error("No se puede eliminar: la cuenta todavía tiene movimientos.", 409)

    _mover_estado(datos.get("nombre"))

    return jsonify({"ok": True})
