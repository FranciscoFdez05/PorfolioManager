"""Altas de portfolios simultáneas.

Regresión: diez POST /api/portfolios con el mismo nombre a la vez daban dos
«ok» con el mismo id y ocho 500; en Linux la segunda alta borraba en silencio
el .db que la primera acababa de crear.
"""

import json
from concurrent.futures import ThreadPoolExecutor

import pytest


@pytest.fixture
def entorno(tmp_path, monkeypatch):
    from admin import portfolios_manager as pm

    directorio = tmp_path / "portfolios"
    directorio.mkdir()
    meta = tmp_path / "portfolios.json"
    monkeypatch.setattr(pm, "_PORTFOLIOS_DIR", directorio)
    monkeypatch.setattr(pm, "_LEGACY_DB", tmp_path / "portfolio.db")
    monkeypatch.setattr(pm, "_META_FILE", meta)
    monkeypatch.setattr("admin.backup_manager.run_startup_backup", lambda *a, **k: None)
    pm.init_portfolios()
    return {"pm": pm, "dir": directorio, "meta": meta}


def test_altas_simultaneas_con_el_mismo_nombre_solo_crean_una(entorno):
    """El nombre visible no se repite: el Atajo elige la cartera por él."""
    pm = entorno["pm"]

    def alta(_):
        try:
            return pm.create_portfolio("Carrera")
        except pm.NombreDuplicado:
            return None

    with ThreadPoolExecutor(10) as hilos:
        ids = [pid for pid in hilos.map(alta, range(10)) if pid]

    assert len(ids) == 1
    indice = json.loads(entorno["meta"].read_text("utf-8"))
    assert [p["id"] for p in indice["portfolios"] if p["name"] == "Carrera"] == ids
    # Las rechazadas no dejan ningún .db suelto.
    assert sorted(f.stem for f in entorno["dir"].glob("carrera*.db")) == ids


def test_importaciones_simultaneas_con_el_mismo_nombre_dan_ids_y_nombres_distintos(entorno):
    """Importar no falla por el nombre: se queda con «Carrera (2)», «Carrera (3)»…"""
    pm = entorno["pm"]

    def importar(_):
        return pm.registrar_portfolio("Carrera", lambda destino: destino.write_bytes(b""), renombrar_si_existe=True)

    with ThreadPoolExecutor(10) as hilos:
        ids = list(hilos.map(importar, range(10)))

    assert len(set(ids)) == 10
    indice = json.loads(entorno["meta"].read_text("utf-8"))
    nombres = [p["name"] for p in indice["portfolios"] if p["id"] in ids]
    assert len(set(nombres)) == 10
    for pid in ids:
        assert (entorno["dir"] / f"{pid}.db").exists()


def test_un_db_huerfano_no_se_borra_para_reutilizar_su_id(entorno):
    huerfano = entorno["dir"] / "ahorro.db"
    huerfano.write_bytes(b"datos que nadie ha apuntado en el indice")

    pid = entorno["pm"].create_portfolio("Ahorro")

    assert pid != "ahorro"
    assert huerfano.read_bytes() == b"datos que nadie ha apuntado en el indice"
