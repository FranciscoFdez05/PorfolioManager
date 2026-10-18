"""Cuentas de dinero y transferencias entre ellas (ventana «Cuentas»)."""

import logging

from flask import Blueprint, jsonify, request

from core.dinero import aTexto
from routes.ajustes import _activePortfolioId, _readPrefs, _writePrefs
from routes.cuenta_ahorro import pasarVinculosAntiguos
from stores.cuenta_ahorro_store import claveDeCuenta, renombrarEnConfig
from stores.cuentas_store import (
    ETIQUETAS_TIPO,
    MONTH_KEYS,
    TIPOS,
    CuentaEnUso,
    CuentaInvalida,
    crearCuenta,
    crearTransferencia,
    eliminarCuenta,
    eliminarTransferencia,
    listarCuentas,
    listarRemuneradas,
    listarTransferencias,
    modificarCuenta,
    modificarTransferencia,
    obtenerCuenta,
    reordenarCuentas,
    saldos,
    saldosDelMes,
)

log = logging.getLogger(__name__)

cuentasBp = Blueprint("cuentas", __name__)


def _error(error, codigo=400):
    return jsonify({"ok": False, "error": str(error)}), codigo


def _conSaldo(cuenta, calculados):
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


def _moverConfiguracionAhorro(claveVieja, claveNueva):
    """Una cuenta de ahorro cambia de nombre: su configuración y el estado de sus
    aportaciones automáticas (que se guardan por nombre) la siguen."""
    pid = _activePortfolioId()
    prefs = _readPrefs(pid)
    prefs["cuentaAhorroConfig"] = renombrarEnConfig(prefs.get("cuentaAhorroConfig"), claveVieja, claveNueva)

    generado = dict(prefs.get("cuentaAhorroGenerado") or {})
    origen = claveVieja.lower() or "_"
    if origen in generado:
        generado[claveNueva.lower() or "_"] = generado.pop(origen)
        prefs["cuentaAhorroGenerado"] = generado
    try:
        _writePrefs(pid, prefs)
    except OSError:
        log.exception("[cuentas] No se pudo mover la configuración de la cuenta de ahorro renombrada")


@cuentasBp.route("/api/cuentas", methods=["GET"])
def getCuentas():
    pasarVinculosAntiguos()
    calculados = saldos()
    return jsonify({
        "tipos": [{"id": t, "nombre": ETIQUETAS_TIPO[t]} for t in TIPOS],
        "cuentas": [_conSaldo(c, calculados) for c in listarCuentas()],
        "remuneradas": listarRemuneradas(),
    })


@cuentasBp.route("/api/cuentas/saldos-mes", methods=["GET"])
def getSaldosMes():
    """Saldo con el que cada cuenta entra en un mes, para la gráfica de Métricas."""
    year = request.args.get("year", "")
    month = request.args.get("month", "")
    if not year.isdigit() or month not in MONTH_KEYS:
        return _error("Falta el año o el mes")
    calculados = saldosDelMes(year, month)
    return jsonify({
        "cuentas": {
            cuentaId: {
                "inicial": aTexto(datos["inicial"], decimales=2),
                "rendimientos": aTexto(datos["rendimientos"], decimales=2),
            }
            for cuentaId, datos in calculados.items()
        }
    })


@cuentasBp.route("/api/cuentas", methods=["POST"])
def addCuenta():
    datos = request.get_json(silent=True) or {}
    try:
        cuenta = crearCuenta(
            datos.get("nombre"), datos.get("tipo"), datos.get("saldoInicial", ""), datos.get("remunerada", ""),
            bool(datos.get("dividendos", False)),
            None if datos.get("ahorro") is None else bool(datos.get("ahorro")),
        )
    except CuentaInvalida as error:
        return _error(error)
    return jsonify({"ok": True, "cuenta": cuenta}), 201


@cuentasBp.route("/api/cuentas/orden", methods=["PUT"])
def ordenCuentas():
    datos = request.get_json(silent=True) or {}
    ids = datos.get("ids")
    if not isinstance(ids, list):
        return _error("Falta la lista de cuentas")
    reordenarCuentas([str(i) for i in ids])
    return jsonify({"ok": True})


@cuentasBp.route("/api/cuentas/<cuentaId>", methods=["PUT"])
def editCuenta(cuentaId):
    datos = request.get_json(silent=True) or {}
    antes = obtenerCuenta(cuentaId)
    try:
        cuenta = modificarCuenta(
            cuentaId, datos.get("nombre"), datos.get("saldoInicial"), datos.get("remunerada"),
            None if datos.get("dividendos") is None else bool(datos.get("dividendos")),
            None if datos.get("ahorro") is None else bool(datos.get("ahorro")),
        )
    except CuentaInvalida as error:
        return _error(error)

    if antes and antes["ahorro"] and antes["nombre"] != cuenta["nombre"]:
        _moverConfiguracionAhorro(claveDeCuenta(antes), claveDeCuenta(cuenta))
    return jsonify({"ok": True, "cuenta": cuenta})


@cuentasBp.route("/api/cuentas/<cuentaId>", methods=["DELETE"])
def deleteCuenta(cuentaId):
    try:
        eliminarCuenta(cuentaId)
    except CuentaInvalida as error:
        return _error(error)
    except CuentaEnUso:
        return _error("No se puede eliminar: la cuenta todavía tiene movimientos.", 409)
    return jsonify({"ok": True})


@cuentasBp.route("/api/transferencias", methods=["GET"])
def getTransferencias():
    return jsonify({"transferencias": listarTransferencias()})


@cuentasBp.route("/api/transferencias", methods=["POST"])
def addTransferencia():
    datos = request.get_json(silent=True) or {}
    try:
        transferencia = crearTransferencia(
            datos.get("origen"), datos.get("destino"), datos.get("fecha"),
            datos.get("cantidad"), datos.get("concepto"), datos.get("nota"), datos.get("comision"),
        )
    except CuentaInvalida as error:
        return _error(error)
    return jsonify({"ok": True, "transferencia": transferencia}), 201


@cuentasBp.route("/api/transferencias/<int:transferenciaId>", methods=["PUT"])
def editTransferencia(transferenciaId):
    datos = request.get_json(silent=True) or {}
    try:
        transferencia = modificarTransferencia(
            transferenciaId, datos.get("origen"), datos.get("destino"), datos.get("fecha"),
            datos.get("cantidad"), datos.get("concepto"), datos.get("nota"), datos.get("comision"),
        )
    except CuentaInvalida as error:
        return _error(error)
    if transferencia is None:
        return _error("La transferencia ya no existe", 404)
    return jsonify({"ok": True, "transferencia": transferencia})


@cuentasBp.route("/api/transferencias/<int:transferenciaId>", methods=["DELETE"])
def deleteTransferencia(transferenciaId):
    if not eliminarTransferencia(transferenciaId):
        return _error("La transferencia ya no existe", 404)
    return jsonify({"ok": True})
