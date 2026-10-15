"""Validación de la configuración de Activos > Paneles (stores.paneles_config).

Lo que llega a `panelesConfig` lo construye el navegador, pero también puede
venir de una copia restaurada, de un ZIP importado o de una petición hecha a
mano. Lo que no pase por aquí se guarda en prefs_<id>.json y se le sirve a la
pantalla en cada carga, así que un valor imposible no se queda en un widget
roto: puede dejar sin cargar los ajustes de toda la aplicación.
"""

import json
import math

import pytest

from stores.paneles_config import MAX_LISTA, MAX_PANELES, MAX_WIDGETS, normalizar_paneles


def _panel(widgets=(), **extra):
    return {"id": "p1", "nombre": "P", "widgets": list(widgets), **extra}


def _widget(**extra):
    return {"id": "w1", "tipo": "notas", "w": 4, "h": 4, **extra}


def _uno(widget):
    return normalizar_paneles({"paneles": [_panel([widget])]})["paneles"][0]["widgets"]


@pytest.mark.parametrize("valor", [None, [], "texto", 3, {"paneles": "no"}, {"paneles": [None, 1, "x"]}])
def test_lo_que_no_tiene_forma_de_configuracion_queda_vacio(valor):
    resultado = normalizar_paneles(valor)
    assert resultado in ({}, {"paneles": [], "activo": ""})


@pytest.mark.parametrize("valor", [math.nan, math.inf, -math.inf])
def test_un_tamano_no_finito_cae_al_de_fabrica_sin_reventar(valor):
    [w] = _uno(_widget(w=valor, h=valor))
    assert (w["w"], w["h"]) == (6, 5)


@pytest.mark.parametrize("valor", [math.nan, math.inf, -math.inf])
def test_una_opcion_no_finita_no_se_guarda(valor):
    """NaN e Infinity no son JSON: el navegador no podría leer los ajustes."""
    [w] = _uno(_widget(cfg={"n": valor, "ok": 2}))
    assert w["cfg"] == {"ok": 2}
    json.dumps(normalizar_paneles({"paneles": [_panel([_widget(cfg={"n": valor})])]}), allow_nan=False)


def test_las_claves_del_prototipo_de_javascript_no_se_guardan():
    [w] = _uno(_widget(cfg={"__proto__": "x", "constructor": "y", "prototype": "z", "texto": "hola"}))
    assert w["cfg"] == {"texto": "hola"}


def test_los_booleanos_no_cuentan_como_tamano():
    [w] = _uno(_widget(w=True, h=False))
    assert (w["w"], w["h"]) == (6, 5)


def test_los_tamanos_se_acotan_a_la_rejilla():
    [w] = _uno(_widget(w=99, h=-5))
    assert (w["w"], w["h"]) == (12, 2)


def test_solo_las_notas_pueden_ser_largas():
    [w] = _uno(_widget(cfg={"texto": "a" * 9000, "titulo": "b" * 9000}))
    assert len(w["cfg"]["texto"]) == 5000
    assert len(w["cfg"]["titulo"]) == 120


def test_las_listas_se_quedan_en_textos_y_con_tope():
    [w] = _uno(_widget(cfg={"activos": ["a", 1, None, {"x": 1}, ["y"]] + ["z"] * (MAX_LISTA + 50)}))
    assert w["cfg"]["activos"][0] == "a"
    assert all(isinstance(v, str) for v in w["cfg"]["activos"])
    assert len(w["cfg"]["activos"]) == MAX_LISTA


def test_un_objeto_anidado_no_entra():
    [w] = _uno(_widget(cfg={"a": {"b": {"c": 1}}, "b": 1}))
    assert w["cfg"] == {"b": 1}


def test_ids_repetidos_quedan_una_vez():
    resultado = normalizar_paneles({"paneles": [
        _panel([_widget(), _widget(tipo="mapa")]),
        _panel([]),
    ]})
    assert len(resultado["paneles"]) == 1
    assert [w["tipo"] for w in resultado["paneles"][0]["widgets"]] == ["notas"]


def test_topes_de_paneles_y_widgets():
    resultado = normalizar_paneles({"paneles": [
        {"id": f"p{i}", "widgets": [_widget(id=f"w{j}") for j in range(MAX_WIDGETS + 10)]}
        for i in range(MAX_PANELES + 10)
    ]})
    assert len(resultado["paneles"]) == MAX_PANELES
    assert all(len(p["widgets"]) == MAX_WIDGETS for p in resultado["paneles"])


@pytest.mark.parametrize("ident", [None, 3, "", ["x"]])
def test_un_id_que_no_es_texto_descarta_el_widget(ident):
    assert _uno(_widget(id=ident)) == []


def test_el_nombre_en_blanco_o_no_texto_se_llama_panel():
    for nombre in ("   ", None, 7):
        assert normalizar_paneles({"paneles": [_panel(nombre=nombre)]})["paneles"][0]["nombre"] == "Panel"


def test_el_panel_activo_tiene_que_existir():
    assert normalizar_paneles({"activo": "otro", "paneles": [_panel()]})["activo"] == "p1"
    assert normalizar_paneles({"activo": "p1", "paneles": []})["activo"] == ""


# ── Por HTTP: lo que de verdad se guarda y se sirve ─────────────────────────

@pytest.fixture
def cliente(cliente_autenticado, datos_aislados, temp_db, monkeypatch):
    from routes.ajustes import ajustes_bp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = cliente_autenticado(ajustes_bp)
    return client, cabeceras


def test_un_nan_enviado_a_mano_no_deja_los_ajustes_ilegibles(cliente):
    """Flask acepta NaN en el JSON de entrada; si se guardara, GET /api/settings
    devolvería un JSON que el navegador no sabe leer y la aplicación entera se
    quedaría sin ajustes."""
    client, cabeceras = cliente
    cuerpo = '{"panelesConfig": {"paneles": [{"id": "p1", "widgets": [{"id": "w1", "tipo": "notas", "w": NaN, "h": Infinity, "cfg": {"x": NaN}}]}]}}'
    respuesta = client.post("/api/settings", data=cuerpo, headers={**cabeceras, "Content-Type": "application/json"})
    assert respuesta.status_code == 200

    crudo = client.get("/api/settings").get_data(as_text=True)
    assert "NaN" not in crudo and "Infinity" not in crudo
    datos = json.loads(crudo)
    assert datos["panelesConfig"]["paneles"][0]["widgets"][0]["cfg"] == {}
