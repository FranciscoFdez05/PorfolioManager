"""Refresco de cotizaciones: la carga automática admite la caché y el botón no."""

import pytest

from core import settings
from stores import market_data


@pytest.fixture
def cliente(clienteAutenticado, tempDb, monkeypatch):
    from routes.activos import activosBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setattr(market_data, "_quoteCache", {})
    monkeypatch.setattr(settings, "cotizacionTtlSegundos", lambda: 90)
    client, cabeceras, _app = clienteAutenticado(activosBp)

    llamadas = []

    def proveedor(symbol):
        llamadas.append(symbol)
        return {
            "symbol": symbol, "price": f"{100 + len(llamadas)},00", "currency": "USD", "change": "+0,00%",
            "status": "Cotización actualizada", "lastUpdated": "2026-01-01T00:00:00", "marketData": {},
        }, None

    monkeypatch.setitem(market_data._FETCHERS, "yahoo", proveedor)
    res = client.post(
        "/api/activos",
        json={"name": "Apple", "type": "acciones", "marketSymbol": "AAPL", "marketProvider": "yahoo", "currency": "USD"},
        headers=cabeceras,
    )
    assert res.status_code == 201, res.get_json()
    return client, cabeceras, llamadas


def _refrescar(client, cabeceras, cuerpo=None):
    res = client.post("/api/activos/apple/refresh-market-data", json=cuerpo, headers=cabeceras)
    assert res.status_code == 200, res.get_json()
    return res.get_json()


def testSinParametroSiempreVaAlProveedor(cliente):
    client, cabeceras, llamadas = cliente

    primera = _refrescar(client, cabeceras)
    segunda = _refrescar(client, cabeceras)

    assert len(llamadas) == 2
    assert primera["desdeCache"] is False and segunda["desdeCache"] is False
    assert segunda["edadCacheSegundos"] is None


def testLaCargaAutomaticaUsaLaCacheDentroDelTtl(cliente):
    client, cabeceras, llamadas = cliente

    primera = _refrescar(client, cabeceras, {"usarCache": True})
    segunda = _refrescar(client, cabeceras, {"usarCache": True})

    assert len(llamadas) == 1
    assert primera["desdeCache"] is False
    assert segunda["desdeCache"] is True
    assert segunda["edadCacheSegundos"] >= 0
    assert segunda["asset"]["price"] == primera["asset"]["price"]


def testElBotonFuerzaPrecioNuevoAunqueHayaCache(cliente):
    client, cabeceras, llamadas = cliente

    _refrescar(client, cabeceras, {"usarCache": True})
    boton = _refrescar(client, cabeceras)

    assert len(llamadas) == 2
    assert boton["desdeCache"] is False
    # El dato nuevo queda en la caché para la siguiente carga automática.
    siguiente = _refrescar(client, cabeceras, {"usarCache": True})
    assert len(llamadas) == 2
    assert siguiente["desdeCache"] is True
    assert siguiente["asset"]["price"] == boton["asset"]["price"]


def testPasadoElTtlLaCargaAutomaticaVuelveAlProveedor(cliente, monkeypatch):
    client, cabeceras, llamadas = cliente
    _refrescar(client, cabeceras, {"usarCache": True})
    for entrada in market_data._quoteCache.values():
        entrada["ts"] -= 91

    res = _refrescar(client, cabeceras, {"usarCache": True})

    assert len(llamadas) == 2
    assert res["desdeCache"] is False


def testMaxEdadRecortaElTtlParaElRefrescoAutomatico(cliente):
    client, cabeceras, llamadas = cliente
    _refrescar(client, cabeceras, {"usarCache": True})
    for entrada in market_data._quoteCache.values():
        entrada["ts"] -= 61  # dentro del TTL de 90 s, fuera de un intervalo de 60 s

    res = _refrescar(client, cabeceras, {"usarCache": True, "maxEdadSegundos": 60})

    assert len(llamadas) == 2
    assert res["desdeCache"] is False


def testMaxEdadNoImpideUsarLaCacheMasFresca(cliente):
    client, cabeceras, llamadas = cliente
    _refrescar(client, cabeceras, {"usarCache": True})

    res = _refrescar(client, cabeceras, {"usarCache": True, "maxEdadSegundos": 60})

    assert len(llamadas) == 1
    assert res["desdeCache"] is True
