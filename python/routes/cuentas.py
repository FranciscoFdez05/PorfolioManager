"""Cuentas de dinero y transferencias entre ellas (ventana «Cuentas»)."""

import logging

from flask import Blueprint, jsonify, request

from core.dinero import aTexto
from routes.ajustes import _active_portfolio_id, _read_prefs, _write_prefs
from routes.cuenta_ahorro import pasar_vinculos_antiguos
from stores.cuenta_ahorro_store import clave_de_cuenta, renombrar_en_config
from stores.cuentas_store import (
    ETIQUETAS_TIPO,
    TIPOS,
    CuentaEnUso,
    CuentaInvalida,
    crear_cuenta,
    crear_transferencia,
    eliminar_cuenta,
    eliminar_transferencia,
    listar_cuentas,
    listar_remuneradas,
    listar_transferencias,
    modificar_cuenta,
    modificar_transferencia,
    obtener_cuenta,
    reordenar_cuentas,
    saldos,
)

log = logging.getLogger(__name__)

cuentas_bp = Blueprint("cuentas", __name__)


def _error(error, codigo=400):
    return jsonify({"ok": False, "error": str(error)}), codigo


def _con_saldo(cuenta, calculados):
    datos = calculados.get(cuenta["id"], {})
    return {
        **cuenta,
        "tipo_etiqueta": ETIQUETAS_TIPO.get(cuenta["tipo"], cuenta["tipo"]),
        "entradas": aTexto(datos["entradas"], decimales=2) if datos else "0.00",
        "salidas": aTexto(datos["salidas"], decimales=2) if datos else "0.00",
        "comisiones": aTexto(datos["comisiones"], decimales=2) if datos else "0.00",
        "intereses": aTexto(datos["intereses"], decimales=2) if datos else "0.00",
        "dividendos_cobrados": aTexto(datos["dividendos"], decimales=2) if datos else "0.00",
        "saldo": aTexto(datos["saldo"], decimales=2) if datos else "0.00",
    }


def _mover_configuracion_ahorro(clave_vieja, clave_nueva):
    """Una cuenta de ahorro cambia de nombre: su configuración y el estado de sus
    aportaciones automáticas (que se guardan por nombre) la siguen."""
    pid = _active_portfolio_id()
    prefs = _read_prefs(pid)
    prefs["cuentaAhorroConfig"] = renombrar_en_config(prefs.get("cuentaAhorroConfig"), clave_vieja, clave_nueva)

    generado = dict(prefs.get("cuentaAhorroGenerado") or {})
    origen = clave_vieja.lower() or "_"
    if origen in generado:
        generado[clave_nueva.lower() or "_"] = generado.pop(origen)
        prefs["cuentaAhorroGenerado"] = generado
    try:
        _write_prefs(pid, prefs)
    except OSError:
        log.exception("[cuentas] No se pudo mover la configuración de la cuenta de ahorro renombrada")


@cuentas_bp.route("/api/cuentas", methods=["GET"])
def getCuentas():
    pasar_vinculos_antiguos()
    calculados = saldos()
    return jsonify({
        "tipos": [{"id": t, "nombre": ETIQUETAS_TIPO[t]} for t in TIPOS],
        "cuentas": [_con_saldo(c, calculados) for c in listar_cuentas()],
        "remuneradas": listar_remuneradas(),
    })


@cuentas_bp.route("/api/cuentas", methods=["POST"])
def addCuenta():
    datos = request.get_json(silent=True) or {}
    try:
        cuenta = crear_cuenta(
            datos.get("nombre"), datos.get("tipo"), datos.get("saldoInicial", ""), datos.get("remunerada", ""),
            bool(datos.get("dividendos", False)),
            None if datos.get("ahorro") is None else bool(datos.get("ahorro")),
        )
    except CuentaInvalida as error:
        return _error(error)
    return jsonify({"ok": True, "cuenta": cuenta}), 201


@cuentas_bp.route("/api/cuentas/orden", methods=["PUT"])
def ordenCuentas():
    datos = request.get_json(silent=True) or {}
    ids = datos.get("ids")
    if not isinstance(ids, list):
        return _error("Falta la lista de cuentas")
    reordenar_cuentas([str(i) for i in ids])
    return jsonify({"ok": True})


@cuentas_bp.route("/api/cuentas/<cuenta_id>", methods=["PUT"])
def editCuenta(cuenta_id):
    datos = request.get_json(silent=True) or {}
    antes = obtener_cuenta(cuenta_id)
    try:
        cuenta = modificar_cuenta(
            cuenta_id, datos.get("nombre"), datos.get("saldoInicial"), datos.get("remunerada"),
            None if datos.get("dividendos") is None else bool(datos.get("dividendos")),
            None if datos.get("ahorro") is None else bool(datos.get("ahorro")),
        )
    except CuentaInvalida as error:
        return _error(error)

    if antes and antes["ahorro"] and antes["nombre"] != cuenta["nombre"]:
        _mover_configuracion_ahorro(clave_de_cuenta(antes), clave_de_cuenta(cuenta))
    return jsonify({"ok": True, "cuenta": cuenta})


@cuentas_bp.route("/api/cuentas/<cuenta_id>", methods=["DELETE"])
def deleteCuenta(cuenta_id):
    try:
        eliminar_cuenta(cuenta_id)
    except CuentaInvalida as error:
        return _error(error)
    except CuentaEnUso:
        return _error("No se puede eliminar: la cuenta todavía tiene movimientos.", 409)
    return jsonify({"ok": True})


@cuentas_bp.route("/api/transferencias", methods=["GET"])
def getTransferencias():
    return jsonify({"transferencias": listar_transferencias()})


@cuentas_bp.route("/api/transferencias", methods=["POST"])
def addTransferencia():
    datos = request.get_json(silent=True) or {}
    try:
        transferencia = crear_transferencia(
            datos.get("origen"), datos.get("destino"), datos.get("fecha"),
            datos.get("cantidad"), datos.get("concepto"), datos.get("nota"), datos.get("comision"),
        )
    except CuentaInvalida as error:
        return _error(error)
    return jsonify({"ok": True, "transferencia": transferencia}), 201


@cuentas_bp.route("/api/transferencias/<int:transferencia_id>", methods=["PUT"])
def editTransferencia(transferencia_id):
    datos = request.get_json(silent=True) or {}
    try:
        transferencia = modificar_transferencia(
            transferencia_id, datos.get("origen"), datos.get("destino"), datos.get("fecha"),
            datos.get("cantidad"), datos.get("concepto"), datos.get("nota"), datos.get("comision"),
        )
    except CuentaInvalida as error:
        return _error(error)
    if transferencia is None:
        return _error("La transferencia ya no existe", 404)
    return jsonify({"ok": True, "transferencia": transferencia})


@cuentas_bp.route("/api/transferencias/<int:transferencia_id>", methods=["DELETE"])
def deleteTransferencia(transferencia_id):
    if not eliminar_transferencia(transferencia_id):
        return _error("La transferencia ya no existe", 404)
    return jsonify({"ok": True})
