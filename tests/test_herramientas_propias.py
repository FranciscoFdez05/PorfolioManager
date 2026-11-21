"""Herramientas creadas desde la aplicación: forma admitida, altas, cambios y bajas.

Se prueban dos capas: las funciones puras de `stores.herramientas_propias`
(validación y operaciones sobre la lista) y las rutas, con la seguridad real
(sesión y CSRF) y `ajustes.json` en una carpeta temporal.
"""

import json

import pytest

from stores import herramientas_propias as hp


def _datos(**cambios):
    datos = {
        "titulo": "Regla del 4 %",
        "descripcion": "Capital para vivir de rentas.",
        "campos": [
            {"clave": "gasto", "etiqueta": "Gasto anual", "unidad": "€", "defecto": 24000},
            {"clave": "tasa", "etiqueta": "Tasa", "unidad": "%", "defecto": "4"},
        ],
        "resultados": [
            {"etiqueta": "Capital necesario", "formula": "gasto / (tasa / 100)",
             "formato": "moneda", "destacado": True},
        ],
    }
    datos.update(cambios)
    return datos


# ── Validación ───────────────────────────────────────────────────────────────

def testValidarDaLaFormaQueSeGuarda():
    herramienta = hp.validar(_datos(titulo="  Regla  "), "abc123")

    assert herramienta["id"] == "abc123"
    assert herramienta["titulo"] == "Regla"
    # El input del navegador manda texto: se guarda como número.
    assert herramienta["campos"][1]["defecto"] == 4.0
    resultado = herramienta["resultados"][0]
    assert resultado == {
        "etiqueta": "Capital necesario", "formula": "gasto / (tasa / 100)", "formato": "moneda",
        "decimales": 2, "sufijo": "", "destacado": True,
    }


@pytest.mark.parametrize("cambios, fragmento", [
    ({"titulo": ""}, "Título"),
    ({"titulo": "x" * 61}, "Título"),
    ({"campos": []}, "Campos"),
    ({"campos": [{"clave": "1x", "etiqueta": "X"}]}, "nombre en la fórmula"),
    ({"campos": [{"clave": "año", "etiqueta": "X"}]}, "nombre en la fórmula"),
    ({"campos": [{"clave": "a", "etiqueta": "A"}, {"clave": "a", "etiqueta": "B"}]}, "mismo nombre"),
    ({"campos": [{"clave": "a", "etiqueta": "A", "defecto": "abc"}]}, "valor por defecto"),
    ({"campos": [{"clave": "a", "etiqueta": "A", "defecto": float("nan")}]}, "valor por defecto"),
    ({"resultados": []}, "Resultados"),
    ({"resultados": [{"etiqueta": "R", "formula": ""}]}, "fórmula"),
    ({"resultados": [{"etiqueta": "R", "formula": "a", "formato": "fecha"}]}, "formato"),
    ({"resultados": [{"etiqueta": "R", "formula": "a", "decimales": 7}]}, "decimales"),
    ({"resultados": [{"etiqueta": "R", "formula": "a", "decimales": 1.5}]}, "decimales"),
])
def testValidarRechazaConUnMensajeQueDiceQue(cambios, fragmento):
    with pytest.raises(hp.HerramientaInvalida, match=fragmento):
        hp.validar(_datos(**cambios), "abc")


@pytest.mark.parametrize("identificador", ["", "ABC", "a-b", "x" * 17, None])
def testValidarRechazaIdsQueNoValenComoIdHtml(identificador):
    with pytest.raises(hp.HerramientaInvalida):
        hp.validar(_datos(), identificador)


def testLosTopesDeCamposYResultados():
    campos = [{"clave": f"c{i}", "etiqueta": "C"} for i in range(hp.MAX_CAMPOS + 1)]

    with pytest.raises(hp.HerramientaInvalida, match="como mucho"):
        hp.validar(_datos(campos=campos), "abc")


def testNormalizarDescartaLoQueNoValeYLosIdsRepetidos():
    buena = hp.validar(_datos(), "a1")
    guardado = [buena, {**buena, "titulo": "Otra"}, {"id": "b2", "titulo": ""}, "basura", {"id": ["x"]}]

    assert hp.normalizarLista(guardado) == [buena]
    assert hp.normalizarLista("no es lista") == []


# ── Operaciones sobre la lista ───────────────────────────────────────────────

def testCrearAnadeAlFinalConUnIdNuevo():
    lista, primera = hp.crear([], _datos())
    lista, segunda = hp.crear(lista, _datos(titulo="Otra"))

    assert [h["titulo"] for h in lista] == ["Regla del 4 %", "Otra"]
    assert primera["id"] != segunda["id"]


def testCrearRespetaElTope(monkeypatch):
    monkeypatch.setattr(hp, "MAX_HERRAMIENTAS", 1)
    lista, _ = hp.crear([], _datos())

    with pytest.raises(hp.HerramientaInvalida, match="Como mucho"):
        hp.crear(lista, _datos())


def testActualizarConservaIdYPosicion():
    lista, a = hp.crear([], _datos(titulo="A"))
    lista, _b = hp.crear(lista, _datos(titulo="B"))

    nueva, cambiada = hp.actualizar(lista, a["id"], _datos(titulo="A2", id="intento"))

    assert cambiada["id"] == a["id"]
    assert [h["titulo"] for h in nueva] == ["A2", "B"]
    # La original no se toca.
    assert lista[0]["titulo"] == "A"


def testActualizarYBorrarUnaQueNoExiste():
    with pytest.raises(hp.HerramientaNoEncontrada):
        hp.actualizar([], "nada", _datos())
    with pytest.raises(hp.HerramientaNoEncontrada):
        hp.borrar([], "nada")


def testBorrar():
    lista, a = hp.crear([], _datos(titulo="A"))
    lista, b = hp.crear(lista, _datos(titulo="B"))

    assert hp.borrar(lista, a["id"]) == [b]


# ── Rutas ────────────────────────────────────────────────────────────────────

@pytest.fixture
def cliente(clienteAutenticado, datosAislados, monkeypatch):
    from routes.herramientas import herramientasBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(herramientasBp)
    return client, cabeceras, datosAislados


def testCrearEditarYBorrarPorHttp(cliente):
    client, cabeceras, rutas = cliente
    assert client.get("/api/herramientas-propias").get_json()["herramientas"] == []

    creada = client.post("/api/herramientas-propias", json=_datos(), headers=cabeceras)
    assert creada.status_code == 200
    identificador = creada.get_json()["herramienta"]["id"]

    editada = client.put(f"/api/herramientas-propias/{identificador}", json=_datos(titulo="Nuevo"), headers=cabeceras)
    assert editada.status_code == 200
    assert [h["titulo"] for h in client.get("/api/herramientas-propias").get_json()["herramientas"]] == ["Nuevo"]

    # Se guarda en ajustes.json, que es lo que entra en las copias.
    guardado = json.loads(rutas["ajustes"].read_text("utf-8"))
    assert guardado[hp.CLAVE][0]["titulo"] == "Nuevo"

    assert client.delete(f"/api/herramientas-propias/{identificador}", headers=cabeceras).status_code == 200
    assert client.get("/api/herramientas-propias").get_json()["herramientas"] == []


def testNoPisaElRestoDeAjustes(cliente):
    client, cabeceras, rutas = cliente
    rutas["ajustes"].write_text(json.dumps({"staleHours": 7}), encoding="utf-8")

    client.post("/api/herramientas-propias", json=_datos(), headers=cabeceras)

    assert json.loads(rutas["ajustes"].read_text("utf-8"))["staleHours"] == 7


def testDatosMalosDan400ConMensaje(cliente):
    client, cabeceras, _ = cliente

    respuesta = client.post("/api/herramientas-propias", json=_datos(titulo=""), headers=cabeceras)

    assert respuesta.status_code == 400
    assert "Título" in respuesta.get_json()["error"]


def testUnaQueNoExisteDa404(cliente):
    client, cabeceras, _ = cliente

    assert client.put("/api/herramientas-propias/nada", json=_datos(), headers=cabeceras).status_code == 404
    assert client.delete("/api/herramientas-propias/nada", headers=cabeceras).status_code == 404


def testEscribirSinCsrfSeRechaza(cliente):
    client, _, _ = cliente

    assert client.post("/api/herramientas-propias", json=_datos()).status_code == 403
