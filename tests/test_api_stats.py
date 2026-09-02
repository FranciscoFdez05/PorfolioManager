"""El contador de llamadas a proveedores, compartido entre workers.

Los proveedores gratuitos limitan las peticiones por día, así que este número
es el que dice si queda margen para refrescar la cartera. Vivía en memoria del
proceso: con los dos workers de gunicorn del contenedor, cada uno llevaba su
cuenta y la pantalla enseñaba la del worker que contestara —la mitad, y una
distinta en cada recarga—. Estas pruebas fijan que la cuenta sea una sola y que
un fallo de disco nunca tumbe la consulta de cotizaciones.
"""

import json

import pytest

from providers import api_stats


@pytest.fixture(autouse=True)
def stats_aisladas(tmp_path, monkeypatch):
    from core import paths

    json_dir = tmp_path / "JSON"
    json_dir.mkdir()
    monkeypatch.setattr(paths, "JSON_DIR", json_dir, raising=False)
    monkeypatch.setattr(paths, "TMP_DIR", tmp_path / "tmp", raising=False)
    api_stats.reiniciar_para_pruebas()
    yield json_dir
    api_stats.reiniciar_para_pruebas()


def test_cuenta_las_llamadas_por_proveedor():
    api_stats.record_api_call("Finnhub")
    api_stats.record_api_call("Finnhub")
    api_stats.record_api_call("EODHD")

    estado = api_stats.get_today_stats()

    assert estado["counts"] == {"Finnhub": 2, "EODHD": 1}
    assert estado["total"] == 3


def test_dos_workers_suman_sobre_la_misma_cuenta():
    """`reiniciar_para_pruebas` deja el proceso como un worker recién arrancado.

    Es la situación real del contenedor: dos procesos distintos, sin memoria
    compartida, contando llamadas al mismo proveedor.
    """
    api_stats.record_api_call("Finnhub")
    api_stats.reiniciar_para_pruebas()      # ← el otro worker
    api_stats.record_api_call("Finnhub")

    assert api_stats.get_today_stats()["counts"]["Finnhub"] == 2


def test_el_recuento_de_ayer_no_se_arrastra(stats_aisladas):
    (stats_aisladas / "api_stats.json").write_text(
        json.dumps({"date": "2020-01-01", "counts": {"Finnhub": 99}}), encoding="utf-8"
    )

    api_stats.record_api_call("Finnhub")

    assert api_stats.get_today_stats()["counts"] == {"Finnhub": 1}


def test_un_fichero_ilegible_no_rompe_el_contador(stats_aisladas):
    (stats_aisladas / "api_stats.json").write_text("{no es json", encoding="utf-8")

    api_stats.record_api_call("Yahoo Finance")

    assert api_stats.get_today_stats()["counts"] == {"Yahoo Finance": 1}


def test_sin_poder_escribir_se_sigue_contando_en_memoria(monkeypatch):
    """Una cotización no puede fallar porque el contador no quepa en disco."""
    def _denegado(*_args, **_kwargs):
        raise PermissionError("Permission denied")

    monkeypatch.setattr(api_stats, "escribirJsonAtomico", _denegado)

    api_stats.record_api_call("Finnhub")

    assert api_stats.get_today_stats()["counts"] == {"Finnhub": 1}


def test_sin_llamadas_devuelve_el_dia_a_cero():
    estado = api_stats.get_today_stats()

    assert estado["counts"] == {}
    assert estado["total"] == 0
