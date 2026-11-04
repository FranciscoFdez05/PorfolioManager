"""Rutas de la vigilancia de las monedas de Satoshi (Cripto > Seguimiento).

Solo traducen HTTP ↔ dominio (`core.satoshi_vigilancia`). Como el resto de
/api, exigen sesión y token CSRF (core/seguridad_app.py).
"""

import logging
from decimal import Decimal
from urllib.error import URLError

from flask import Blueprint, jsonify

from core import wallets_vigilancia
from core.errors import NotFoundError, UpstreamError, ValidationError
from core.satoshi_vigilancia import SATOSHIS_POR_BTC, FotoNoDisponible, VigilanteSatoshi
from core.validation import jsonBody
from providers.bitcoin_bloques import BloqueIlegible
from stores.asset_store import listarActivosCripto

log = logging.getLogger(__name__)

satoshiBp = Blueprint("satoshi", __name__)


def _precioBtcEur() -> Decimal | None:
    """Precio en euros del Bitcoin de Activos, o None si no hay o no tiene precio.

    El mismo que usan las wallets: el del activo del portfolio activo. Se busca
    por símbolo y, si no, por nombre; un token «envuelto» (WBTC) no cuenta.
    """
    activos = listarActivosCripto()
    bitcoin = next((a for a in activos if a["symbol"].strip().upper() == "BTC"), None) or next(
        (a for a in activos if a["name"].strip().lower() == "bitcoin"), None)
    if bitcoin is None:
        return None
    try:
        return wallets_vigilancia.precioEurDeActivo(bitcoin["id"])
    except Exception as error:
        # Sin tipo de cambio la tarjeta se enseña igual, sin el valor en euros.
        log.debug("[satoshi] Sin precio en euros del Bitcoin: %s", error)
        return None


def _vigilante() -> VigilanteSatoshi:
    return VigilanteSatoshi()


def _respuesta(resumen: dict) -> dict:
    precio = _precioBtcEur()
    valor = Decimal(resumen["satoshis"]) / SATOSHIS_POR_BTC * precio if precio is not None else None
    return {"ok": True, **resumen, "valorEur": f"{valor:.2f}" if valor is not None else ""}


def _resumen(vigilante: VigilanteSatoshi) -> dict:
    try:
        return vigilante.resumen()
    except FotoNoDisponible as error:
        raise NotFoundError(str(error)) from error


@satoshiBp.route("/api/wallets/satoshi", methods=["GET"])
def verSatoshi():
    """Saldo real de Satoshi, monedas sin mover, bloques revisados y monedas movidas."""
    return jsonify(_respuesta(_resumen(_vigilante())))


@satoshiBp.route("/api/wallets/satoshi/ajustes", methods=["POST"])
def ajustarSatoshi():
    """Enciende o apaga la vigilancia (`activo`) o sus avisos por Telegram (`avisos`)."""
    datos = jsonBody()
    cambios = {}
    for campo in ("activo", "avisos"):
        if campo in datos:
            if not isinstance(datos[campo], bool):
                raise ValidationError("Valor no válido", field=campo)
            cambios[campo] = datos[campo]
    if not cambios:
        raise ValidationError("No hay nada que cambiar")
    vigilante = _vigilante()
    _resumen(vigilante)
    return jsonify(_respuesta(vigilante.ajustar(**cambios)))


@satoshiBp.route("/api/wallets/satoshi/revisar", methods=["POST"])
def revisarSatoshi():
    """Revisa ya los bloques que falten (unos pocos por llamada) aunque la vigilancia esté apagada."""
    vigilante = _vigilante()
    _resumen(vigilante)
    try:
        encontradas = vigilante.revisar(forzar=True)
    except (URLError, TimeoutError, OSError, BloqueIlegible) as error:
        raise UpstreamError(f"No se pudieron leer los bloques: {error}") from error
    return jsonify({**_respuesta(vigilante.resumen()), "encontradas": encontradas})
