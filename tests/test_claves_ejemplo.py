"""Los valores de ejemplo de la documentación no son claves.

`.env.example` traía `FINNHUB_API_KEY=tu_clave_finnhub`, así que quien copiaba
el fichero y luego ponía sus claves de verdad desde Ajustes se quedaba con el
proveedor en «clave rechazada» sin nada que lo explicara. Descartarlos fue el
arreglo; lo que se prueba aquí es que además **se dice una sola vez**, porque
esta función corre en cada lectura de claves —cada ciclo de precios— y el aviso
repetido llegó a ser el 95 % del log del servidor.
"""

import pytest

from stores import app_data


@pytest.fixture(autouse=True)
def sin_avisos_previos():
    """El registro de avisos vive en el módulo y sobrevive entre tests: sin esto,
    el segundo test que mirase la misma procedencia no vería ninguna línea."""
    app_data._EJEMPLOS_AVISADOS.clear()
    yield
    app_data._EJEMPLOS_AVISADOS.clear()


def test_se_descartan_los_ejemplos_y_se_conservan_las_claves():
    utiles = app_data._sin_ejemplos(["tu_clave_finnhub", "d3f8a1c209", "CLAVE1"], "el valor de X")

    assert utiles == ["d3f8a1c209"]


def test_el_aviso_no_se_repite_en_cada_lectura(caplog):
    """Veinte lecturas, un aviso. Es la diferencia entre un log que se lee y uno
    en el que hay que buscar."""
    with caplog.at_level("WARNING", logger=app_data.log.name):
        for _ in range(20):
            app_data._sin_ejemplos(["tu_clave_finnhub"], "el valor de FINNHUB_API_KEY")

    avisos = [r for r in caplog.records if "valor de ejemplo" in r.getMessage()]
    assert len(avisos) == 1
    # Que el log diga que no va a repetirse evita buscar más apariciones.
    assert "No se repetirá" in avisos[0].getMessage()


def test_cada_procedencia_avisa_por_su_cuenta(caplog):
    """Dos variables mal puestas son dos problemas distintos, y callar la segunda
    porque ya se avisó de la primera dejaría a EODHD sin explicación."""
    with caplog.at_level("WARNING", logger=app_data.log.name):
        app_data._sin_ejemplos(["tu_clave_finnhub"], "el valor de FINNHUB_API_KEY")
        app_data._sin_ejemplos(["tu_clave_EODHD1"], "el valor de EODHD_API_KEYS")
        app_data._sin_ejemplos(["tu_clave_finnhub"], "el valor de FINNHUB_API_KEY")

    avisos = [r.getMessage() for r in caplog.records if "valor de ejemplo" in r.getMessage()]
    assert len(avisos) == 2
    assert "FINNHUB_API_KEY" in avisos[0]
    assert "EODHD_API_KEYS" in avisos[1]
