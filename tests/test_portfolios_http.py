"""Importar y exportar carteras (/api/portfolios/import y /export).

La aplicación genera tres ficheros distintos con carteras dentro —el `.db`
suelto de «Exportar portfolio», el ZIP de «Exportar ZIP» y el ZIP de las copias
de seguridad— y el usuario los suelta en el sitio que le parece. Que uno se
acepte y otro conteste «no es una base de datos SQLite válida» no es una
validación: es una trampa. Aquí se fija qué entiende cada entrada y, cuando no
puede resolverlo sola, que lo diga con lo que hay que hacer.
"""

import io
import json
import sqlite3
import zipfile

import pytest


@pytest.fixture
def cliente(cliente_autenticado, datos_aislados, monkeypatch):
    from routes.portfolios import portfolios_bp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")

    client, cabeceras, _app = cliente_autenticado(portfolios_bp)
    datos_aislados["meta"].write_text(
        json.dumps({"active": "principal", "portfolios": [{"id": "principal", "name": "Principal"}]}),
        encoding="utf-8",
    )
    return client, cabeceras, datos_aislados


def _db_de_prueba(ruta):
    conn = sqlite3.connect(str(ruta))
    conn.execute("CREATE TABLE activos (id TEXT PRIMARY KEY, name TEXT)")
    conn.execute("INSERT INTO activos VALUES ('btc', 'Bitcoin')")
    conn.commit()
    conn.close()
    return ruta.read_bytes()


def _subir(client, cabeceras, nombre, contenido, portfolio="Importada"):
    return client.post(
        "/api/portfolios/import",
        data={"name": portfolio, "file": (io.BytesIO(contenido), nombre)},
        headers=cabeceras,
        content_type="multipart/form-data",
    )


def test_importa_un_db_suelto(cliente, tmp_path):
    client, cabeceras, rutas = cliente
    contenido = _db_de_prueba(tmp_path / "origen.db")

    respuesta = _subir(client, cabeceras, "portfolio_principal.db", contenido)

    assert respuesta.status_code == 200, respuesta.get_json()
    assert (rutas["portfolios"] / "importada.db").exists()


def test_importa_el_zip_que_genera_exportar_zip(cliente, tmp_path):
    """Lo que fallaba: el zip de export se rechazaba por «no es SQLite»."""
    client, cabeceras, rutas = cliente
    contenido = _db_de_prueba(tmp_path / "origen.db")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("portfolio-2026-09-02.db", contenido)
        zf.writestr("portfolio-export-2026-09-02.json", b"{}")
        zf.writestr("ajustes.json", b"{}")
    buf.seek(0)

    respuesta = _subir(client, cabeceras, "portfolio-export.zip", buf.read())

    assert respuesta.status_code == 200, respuesta.get_json()
    assert (rutas["portfolios"] / "importada.db").exists()

    conn = sqlite3.connect(str(rutas["portfolios"] / "importada.db"))
    try:
        assert conn.execute("SELECT name FROM activos").fetchone()[0] == "Bitcoin"
    finally:
        conn.close()


def test_un_zip_con_varias_carteras_manda_a_restaurar(cliente, tmp_path):
    """Una copia de seguridad completa no cabe en «una cartera nueva»."""
    client, cabeceras, _rutas = cliente
    contenido = _db_de_prueba(tmp_path / "origen.db")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("portfolios/principal.db", contenido)
        zf.writestr("portfolios/cripto.db", contenido)
    buf.seek(0)

    respuesta = _subir(client, cabeceras, "backup.zip", buf.read())
    error = respuesta.get_json()["error"]

    assert respuesta.status_code == 400
    assert "Restaurar" in error
    # Y dice cuáles trae, para no dejar al usuario adivinando.
    assert "cripto" in error and "principal" in error


def test_un_zip_sin_bases_de_datos_se_rechaza(cliente):
    client, cabeceras, _rutas = cliente
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("leeme.txt", b"nada")
    buf.seek(0)

    respuesta = _subir(client, cabeceras, "cosas.zip", buf.read())

    assert respuesta.status_code == 400
    assert "no contiene ninguna base de datos" in respuesta.get_json()["error"]


def test_un_fichero_que_no_es_ni_db_ni_zip_se_rechaza(cliente):
    client, cabeceras, _rutas = cliente

    respuesta = _subir(client, cabeceras, "notas.txt", b"esto no es una base de datos")

    assert respuesta.status_code == 400
    assert "SQLite" in respuesta.get_json()["error"]


def test_la_importacion_no_deja_temporales_entre_las_carteras(cliente, tmp_path):
    """El temporal de la subida vive en data/tmp, no en data/portfolios."""
    client, cabeceras, rutas = cliente
    contenido = _db_de_prueba(tmp_path / "origen.db")

    _subir(client, cabeceras, "portfolio_principal.db", contenido)

    assert sorted(p.name for p in rutas["portfolios"].iterdir()) == ["importada.db"]
