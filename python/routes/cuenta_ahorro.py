"""Ventana «Cuenta de ahorro»: las cuentas de ahorro y lo que las mueve.

Crear, renombrar y eliminar cuentas, y las transferencias, van por
`routes/cuentas.py`: una cuenta de ahorro es una cuenta más. Aquí solo está lo
que necesita esta ventana al abrirse.
"""

import logging

from flask import Blueprint, jsonify

from routes.ajustes import _activePortfolioId, _readPrefs, _writePrefs
from stores.cuenta_ahorro_store import (
    aplicarRecurrentes,
    claveDeCuenta,
    cuentasDeAhorro,
    dividendosDeConfig,
    listarMovimientos,
    normalizarConfig,
    vinculosDeConfig,
)
from stores.cuentas_store import importarDividendos, importarVinculos, listarRemuneradas

log = logging.getLogger(__name__)

cuentaAhorroBp = Blueprint("cuenta_ahorro", __name__)


def pasarVinculosAntiguos():
    """Pasa a la base las remuneradas y la casilla de dividendos que la
    configuración de ahorro guardaba por nombre, y las quita de ahí para que un
    vínculo deshecho no vuelva a aparecer.

    Se llama al abrir Cuentas y Cuenta de ahorro. Sin nada antiguo no escribe
    nada.
    """
    pid = _activePortfolioId()
    prefs = _readPrefs(pid)
    config = prefs.get("cuentaAhorroConfig")
    pares = vinculosDeConfig(config)
    conDividendos = dividendosDeConfig(config)
    if not pares and conDividendos is None:
        return
    if pares:
        importarVinculos(pares)
    if conDividendos is not None:
        importarDividendos(conDividendos)
    prefs["cuentaAhorroConfig"] = normalizarConfig(config)
    try:
        _writePrefs(pid, prefs)
    except OSError:
        # Los vínculos ya están en la base y con INSERT OR IGNORE: repetirlo la
        # próxima vez no duplica nada, solo podría rehacer uno que se quitara.
        log.exception("[cuenta-ahorro] No se pudo limpiar la configuración antigua de remuneradas")


def _aplicarAportacionesAutomaticas():
    """Crea las aportaciones mensuales que ya tocan. Se llama al abrir la ventana."""
    pid = _activePortfolioId()
    prefs = _readPrefs(pid)
    generado = prefs.get("cuentaAhorroGenerado") or {}

    nuevo, creados = aplicarRecurrentes(prefs.get("cuentaAhorroConfig"), generado)
    if nuevo != generado:
        prefs["cuentaAhorroGenerado"] = nuevo
        try:
            _writePrefs(pid, prefs)
        except OSError:
            # Las transferencias ya están creadas: si el estado no se guarda, la
            # próxima vez se duplicarían. Se avisa en el log con todo detalle.
            log.exception("[cuenta-ahorro] No se pudo guardar el estado de las aportaciones automáticas")
    return creados


@cuentaAhorroBp.route("/api/cuenta-ahorro", methods=["GET"])
def getCuentaAhorro():
    pasarVinculosAntiguos()
    _aplicarAportacionesAutomaticas()
    return jsonify({
        "cuentas": [{**c, "clave": claveDeCuenta(c)} for c in cuentasDeAhorro()],
        "movimientos": listarMovimientos(),
        "remuneradas": listarRemuneradas(),
    })
