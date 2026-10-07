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
    dividendos_de_config,
    listar_movimientos,
    normalizar_config,
    vinculos_de_config,
)
from stores.cuentas_store import importar_dividendos, importar_vinculos, listar_remuneradas

log = logging.getLogger(__name__)

cuenta_ahorro_bp = Blueprint("cuenta_ahorro", __name__)


def pasar_vinculos_antiguos():
    """Pasa a la base las remuneradas y la casilla de dividendos que la
    configuración de ahorro guardaba por nombre, y las quita de ahí para que un
    vínculo deshecho no vuelva a aparecer.

    Se llama al abrir Cuentas y Cuenta de ahorro. Sin nada antiguo no escribe
    nada.
    """
    pid = _active_portfolio_id()
    prefs = _read_prefs(pid)
    config = prefs.get("cuentaAhorroConfig")
    pares = vinculos_de_config(config)
    con_dividendos = dividendos_de_config(config)
    if not pares and con_dividendos is None:
        return
    if pares:
        importar_vinculos(pares)
    if con_dividendos is not None:
        importar_dividendos(con_dividendos)
    prefs["cuentaAhorroConfig"] = normalizar_config(config)
    try:
        _write_prefs(pid, prefs)
    except OSError:
        # Los vínculos ya están en la base y con INSERT OR IGNORE: repetirlo la
        # próxima vez no duplica nada, solo podría rehacer uno que se quitara.
        log.exception("[cuenta-ahorro] No se pudo limpiar la configuración antigua de remuneradas")


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
    pasar_vinculos_antiguos()
    _aplicar_aportaciones_automaticas()
    return jsonify({
        "cuentas": [{**c, "clave": clave_de_cuenta(c)} for c in cuentas_de_ahorro()],
        "movimientos": listar_movimientos(),
        "remuneradas": listar_remuneradas(),
    })
