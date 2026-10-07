"""Un ajustes.json con valores de forma inesperada no puede inutilizar Ajustes.

Regresión: importar `{"ajustes": {"fiatCurrencies": ["x"]}}` dejaba
POST /api/settings respondiendo 500 para siempre, y desde la interfaz no había
forma de arreglarlo. Lo mismo con `{"theme": [1]}` enviado directamente.
"""

import io
import json

import pytest

from tests import test_ajustes_http

cliente = test_ajustes_http.cliente


@pytest.mark.parametrize("ajustes", [
    {"fiatCurrencies": ["x"]},
    {"fiatCurrencies": [{"code": 1, "name": "x"}]},
    {"fiatCurrencies": "EUR"},
    {"soloMercadoTipos": [[1], {"a": 1}]},
    {"theme": ["default"], "snapshotMinutes": "mucho", "sidebarCollapsed": "sí"},
])
def test_un_ajustes_importado_raro_no_rompe_el_guardado(cliente, ajustes):
    client, cabeceras, _rutas = cliente
    r = client.post(
        "/api/import/json",
        data={"file": (io.BytesIO(json.dumps({"ajustes": ajustes}).encode()), "export.json")},
        headers=cabeceras, content_type="multipart/form-data",
    )
    assert r.status_code == 200

    assert client.get("/api/settings").status_code == 200
    r = client.post("/api/settings", json={"monedaBase": "EUR", "soloMercadoTipos": ["acciones"]}, headers=cabeceras)
    assert r.status_code == 200, r.get_json()


def test_los_valores_con_tipo_incorrecto_vuelven_al_de_fabrica(cliente):
    client, _cabeceras, rutas = cliente
    rutas["ajustes"].write_text(json.dumps({
        "fiatCurrencies": ["x"], "staleHours": "veinte", "theme": "black", "sidebarCollapsed": 1,
    }), "utf-8")

    datos = client.get("/api/settings").get_json()

    from routes.ajustes import _read_ajustes

    assert _read_ajustes()["fiatCurrencies"][0]["code"] == "EUR"  # de fábrica
    assert datos["staleHours"] == 24                     # de fábrica
    assert datos["sidebarCollapsed"] is False             # 1 no es un booleano
    assert datos["theme"] == "black"                      # válido: se conserva


@pytest.mark.parametrize("campos", [
    {"theme": [1]},
    {"numLocale": {"a": 1}},
    {"dateFormat": [1]},
    {"soloMercadoTipos": [[1]]},
    {"hiddenAssets": 5},
    {"hiddenAssets": [{"x": 1}, "activo-1"]},
    {"metricasDisplayType": [1], "metricasDistMetric": {}},
])
def test_guardar_con_tipos_inesperados_no_da_500(cliente, campos):
    client, cabeceras, _rutas = cliente

    r = client.post("/api/settings", json=campos, headers=cabeceras)

    assert r.status_code == 200, r.get_json()
