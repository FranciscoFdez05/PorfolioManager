"""Rutas del catálogo de carteras conocidas (Cripto > Seguimiento > Enlazar wallets).

Solo traducen HTTP ↔ dominio (`core.carteras_conocidas`). Como el resto de
/api, exigen sesión y token CSRF (core/seguridad_app.py).

A diferencia de /api/wallets, aquí las direcciones van completas: las de serie
son públicas y las del usuario las ha escrito él; la pantalla las necesita
para enlazarlas. Los logs no las llevan.
"""

import logging

from flask import Blueprint, jsonify, request

from core.carteras_conocidas import (
    CATEGORIAS,
    MAX_RESULTADOS,
    CarteraInvalida,
    CarteraNoEncontrada,
    CatalogoCarteras,
    entradaComoDict,
)
from core.errors import ApiError, ConflictError, NotFoundError, ValidationError
from core.validation import asText, jsonBody
from stores.carteras_conocidas_store import CatalogoBaseIlegible
from stores.wallets_store import AlmacenIlegible, CifradoNoDisponible, WalletError, WalletsRepository

log = logging.getLogger(__name__)

carterasConocidasBp = Blueprint("carterasConocidas", __name__)

_MAX_LARGO_CONSULTA = 120
_MAX_LARGO_ID = 40


def _errorDeDominio(error: Exception) -> ApiError:
    """La respuesta HTTP de cada error de dominio."""
    if isinstance(error, CarteraNoEncontrada):
        return NotFoundError(str(error))
    if isinstance(error, CifradoNoDisponible):
        return ConflictError(str(error))
    if isinstance(error, (AlmacenIlegible, CatalogoBaseIlegible)):
        return ApiError(str(error), 500)
    if isinstance(error, CarteraInvalida):
        return ValidationError(str(error), field=error.campo or None)
    return ValidationError(str(error))


def _catalogo() -> CatalogoCarteras:
    return CatalogoCarteras()


def _enlazadas() -> set[tuple[str, str]]:
    """(red, valor) de las wallets ya enlazadas; vacío si no se pueden leer.

    Es solo una ayuda para no ofrecer lo que ya se sigue: si falta la
    SECRET_KEY o el fichero no se abre, el catálogo se enseña igual.
    """
    try:
        return {(w.red, w.valor) for w in WalletsRepository().listar()}
    except WalletError as error:
        log.debug("[carteras] Sin la lista de wallets enlazadas: %s", error)
        return set()


def _idDePeticion(datos: dict) -> str:
    return asText(datos.get("id"), "id", maxLength=_MAX_LARGO_ID, required=True)


def _limite(valor) -> int:
    try:
        return min(max(int(valor), 1), MAX_RESULTADOS)
    except (TypeError, ValueError):
        return MAX_RESULTADOS


@carterasConocidasBp.route("/api/wallets/catalogo", methods=["GET"])
def buscarCarteras():
    """Busca en el catálogo por nombre, alias, categoría, etiqueta o dirección (`?q=`)."""
    consulta = asText(request.args.get("q"), "q", maxLength=_MAX_LARGO_CONSULTA)
    catalogo = _catalogo()
    try:
        encontradas = catalogo.buscar(consulta, _limite(request.args.get("limite")))
        fuentes = catalogo.fuentes()
        ocultas = catalogo.ocultas()
    except (WalletError, CatalogoBaseIlegible) as error:
        raise _errorDeDominio(error) from error
    enlazadas = _enlazadas()
    return jsonify({
        "carteras": [entradaComoDict(e, fuentes, enlazadas) for e in encontradas],
        "categorias": [{"clave": clave, "nombre": nombre} for clave, nombre in CATEGORIAS.items()],
        "ocultas": [{"id": c.id, "nombre": c.nombre} for c in ocultas],
    })


@carterasConocidasBp.route("/api/wallets/catalogo/guardar", methods=["POST"])
def guardarCartera():
    """Crea una entidad (sin `id`) o guarda los cambios de una existente."""
    datos = jsonBody()
    carteraId = asText(datos.get("id"), "id", maxLength=_MAX_LARGO_ID)
    catalogo = _catalogo()
    try:
        entrada = catalogo.guardar(datos, carteraId)
        fuentes = catalogo.fuentes()
    except (WalletError, CatalogoBaseIlegible) as error:
        raise _errorDeDominio(error) from error
    log.info("[carteras] Guardada %s (%s, %d direcciones)", entrada.cartera.id, entrada.origen,
             len(entrada.cartera.direcciones))
    return jsonify({"ok": True, "cartera": entradaComoDict(entrada, fuentes, _enlazadas())})


@carterasConocidasBp.route("/api/wallets/catalogo/eliminar", methods=["POST"])
def eliminarCartera():
    """Borra una entidad propia u oculta una de serie."""
    carteraId = _idDePeticion(jsonBody())
    try:
        _catalogo().eliminar(carteraId)
    except (WalletError, CatalogoBaseIlegible) as error:
        raise _errorDeDominio(error) from error
    log.info("[carteras] Quitada del catálogo %s", carteraId)
    return jsonify({"ok": True})


@carterasConocidasBp.route("/api/wallets/catalogo/restaurar", methods=["POST"])
def restaurarCartera():
    """Devuelve una entidad de serie a como venía (sin editar y sin ocultar)."""
    carteraId = _idDePeticion(jsonBody())
    catalogo = _catalogo()
    try:
        entrada = catalogo.restaurar(carteraId)
        fuentes = catalogo.fuentes()
    except (WalletError, CatalogoBaseIlegible) as error:
        raise _errorDeDominio(error) from error
    log.info("[carteras] Restaurada %s", carteraId)
    return jsonify({"ok": True, "cartera": entradaComoDict(entrada, fuentes, _enlazadas())})
