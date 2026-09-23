"""Descubrimiento de las herramientas que el usuario deja en una carpeta.

Lo que se prueba es el contrato que promete la guía (docs/herramientas-extra.md):
un .html suelto ya es una herramienta, los metadatos de la cabecera son
opcionales, el .js se engancha solo si existe y un nombre de fichero que no
valga como id de HTML se ignora en vez de llegar a la página.
"""

import pytest


@pytest.fixture
def carpeta(tmp_path):
    destino = tmp_path / "herramientas-extra"
    destino.mkdir()
    return destino


def _escribir(carpeta, nombre, contenido=""):
    ruta = carpeta / nombre
    ruta.write_text(contenido, encoding="utf-8")
    return ruta


# ── Listado ──────────────────────────────────────────────────────────────────

def test_un_html_suelto_ya_es_una_herramienta(carpeta):
    from routes.herramientas import listar

    _escribir(carpeta, "precio-objetivo.html", "<div>hola</div>")

    herramientas = listar(carpeta)

    assert len(herramientas) == 1
    assert herramientas[0]["id"] == "precio-objetivo"
    # Sin metadatos, el título sale del nombre del fichero.
    assert herramientas[0]["titulo"] == "Precio objetivo"
    assert herramientas[0]["html"] == "html/analisis/herramientas-extra/precio-objetivo.html"
    assert herramientas[0]["js"] is None


def test_la_cabecera_da_titulo_y_descripcion(carpeta):
    from routes.herramientas import listar

    _escribir(carpeta, "inflacion.html", """<!-- herramienta
titulo: Poder adquisitivo
descripcion: Lo que valdrán tus euros dentro de unos años.
-->
<div></div>""")

    herramienta = listar(carpeta)[0]

    assert herramienta["titulo"] == "Poder adquisitivo"
    assert herramienta["descripcion"] == "Lo que valdrán tus euros dentro de unos años."



def test_el_js_se_enlaza_solo_si_existe(carpeta):
    from routes.herramientas import listar

    _escribir(carpeta, "con-js.html")
    _escribir(carpeta, "con-js.js", "// ...")
    _escribir(carpeta, "sin-js.html")

    porId = {h["id"]: h for h in listar(carpeta)}

    assert porId["con-js"]["js"] == "html/analisis/herramientas-extra/con-js.js"
    assert porId["sin-js"]["js"] is None


@pytest.mark.parametrize("nombre", [
    "Con Mayúsculas.html",
    "con espacios.html",
    "acentuada-ñ.html",
    "con.punto.html",
])
def test_los_nombres_que_no_valen_como_id_se_ignoran(carpeta, nombre):
    from routes.herramientas import listar

    _escribir(carpeta, nombre)

    assert listar(carpeta) == []


def test_se_ordenan_por_titulo(carpeta):
    from routes.herramientas import listar

    _escribir(carpeta, "zeta.html", "<!-- herramienta\ntitulo: Alfa\n-->")
    _escribir(carpeta, "alfa.html", "<!-- herramienta\ntitulo: Zeta\n-->")

    assert [h["titulo"] for h in listar(carpeta)] == ["Alfa", "Zeta"]


def test_sin_carpeta_no_falla(tmp_path):
    from routes.herramientas import listar

    assert listar(tmp_path / "no-existe") == []


# ── Endpoint ─────────────────────────────────────────────────────────────────

def test_el_endpoint_devuelve_lo_que_hay_en_la_carpeta(cliente_autenticado, carpeta, monkeypatch):
    from routes import herramientas

    _escribir(carpeta, "mia.html", "<!-- herramienta\ntitulo: La mía\n-->")
    monkeypatch.setattr(herramientas, "EXTRAS_DIR", carpeta)

    client, _cabeceras, _app = cliente_autenticado(herramientas.herramientas_bp)
    respuesta = client.get("/api/herramientas-extra")

    assert respuesta.status_code == 200
    cuerpo = respuesta.get_json()
    assert cuerpo["ok"] is True
    assert [h["titulo"] for h in cuerpo["herramientas"]] == ["La mía"]


def test_el_endpoint_pide_sesion(crear_app, carpeta, monkeypatch):
    from routes import herramientas

    monkeypatch.setattr(herramientas, "EXTRAS_DIR", carpeta)

    app = crear_app(herramientas.herramientas_bp)
    respuesta = app.test_client().get("/api/herramientas-extra")

    assert respuesta.status_code in (401, 403, 302)
