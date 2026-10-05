"""Ventana «Cuenta de ahorro»: las cuentas de ahorro y lo que las mueve.

Crear, renombrar y eliminar cuentas, y las transferencias, van por
`routes/cuentas.py`: una cuenta de ahorro es una cuenta más. Aquí solo está lo
que necesita esta ventana al abrirse.
"""

import logging

from flask import Blueprint, jsonify

from routes.ajustes import _active_portfolio_id, _read_prefs, _write_prefs
from stores.cuenta_ahorro_store import (
    aplicar_recurrentes,
    clave_de_cuenta,
    cuentas_de_ahorro,
    listar_movimientos,
)

log = logging.getLogger(__name__)

cuenta_ahorro_bp = Blueprint("cuenta_ahorro", __name__)


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
            # Las transferencias ya están creadas: si el estado no se guarda, la
            # próxima vez se duplicarían. Se avisa en el log con todo detalle.
            log.exception("[cuenta-ahorro] No se pudo guardar el estado de las aportaciones automáticas")
    return creados


@cuenta_ahorro_bp.route("/api/cuenta-ahorro", methods=["GET"])
def getCuentaAhorro():
    _aplicar_aportaciones_automaticas()
    return jsonify({
        "cuentas": [{**c, "clave": clave_de_cuenta(c)} for c in cuentas_de_ahorro()],
        "movimientos": listar_movimientos(),
    })
