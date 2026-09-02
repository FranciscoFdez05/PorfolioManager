"""Temporales únicos y escritura atómica (core/escritura.py).

Media docena de sitios escribían su propio temporal con un nombre fijo y luego
lo renombraban. Con un proceso y un hilo —el servidor de desarrollo— eso
funciona; con los dos workers y cuatro hilos de gunicorn del contenedor, dos
escrituras simultáneas se pisan el temporal y lo que se renombra es la mezcla.
Y varios de esos temporales eran `.db` dentro de `data/portfolios/`, que es
donde todo el proyecto busca los portfolios con `glob("*.db")`.
"""

import json
import threading

import pytest

from core.escritura import (
    escribirAtomico,
    escribirJsonAtomico,
    limpiarTemporal,
    rutaTemporal,
    temporalPara,
)

# ── Nombres ───────────────────────────────────────────────────────────────────

def test_dos_temporales_del_mismo_destino_nunca_coinciden(tmp_path):
    destino = tmp_path / "portfolios.json"

    nombres = {rutaTemporal(destino).name for _ in range(50)}

    assert len(nombres) == 50


def test_los_temporales_de_varios_hilos_no_coinciden(tmp_path):
    """El caso del contenedor: cuatro hilos por worker sobre el mismo destino."""
    destino = tmp_path / "principal.db"
    nombres = []
    barrera = threading.Barrier(8)

    def tarea():
        barrera.wait()
        nombres.append(rutaTemporal(destino).name)

    hilos = [threading.Thread(target=tarea) for _ in range(8)]
    for hilo in hilos:
        hilo.start()
    for hilo in hilos:
        hilo.join()

    assert len(set(nombres)) == 8


def test_el_temporal_no_lo_recoge_un_glob_de_bases_de_datos(tmp_path):
    """Lo que metía una importación a medias en la copia de seguridad."""
    destino = tmp_path / "principal.db"
    rutaTemporal(destino).write_bytes(b"a medias")

    assert list(tmp_path.glob("*.db")) == []


def test_se_puede_sacar_el_temporal_de_la_carpeta_del_destino(tmp_path):
    aparte = tmp_path / "tmp"

    tmp = rutaTemporal(tmp_path / "portfolios" / "principal.db", directorio=aparte)

    assert tmp.parent == aparte
    assert aparte.is_dir()


# ── temporalPara ──────────────────────────────────────────────────────────────

def test_temporalPara_limpia_el_fichero_y_los_sidecars_de_sqlite(tmp_path):
    with temporalPara(tmp_path / "principal.db") as tmp:
        tmp.write_bytes(b"copia")
        for sufijo in ("-wal", "-shm"):
            (tmp.parent / (tmp.name + sufijo)).write_bytes(b"x")

    assert list(tmp_path.iterdir()) == []


def test_temporalPara_limpia_aunque_falle_lo_de_dentro(tmp_path):
    with pytest.raises(RuntimeError), temporalPara(tmp_path / "principal.db") as tmp:
        tmp.write_bytes(b"copia")
        raise RuntimeError("copia interrumpida")

    assert list(tmp_path.iterdir()) == []


# ── Escritura atómica ─────────────────────────────────────────────────────────

def test_escribe_el_contenido_y_no_deja_temporales(tmp_path):
    destino = tmp_path / "sub" / "ajustes.json"

    escribirJsonAtomico(destino, {"maxBackups": 5})

    assert json.loads(destino.read_text("utf-8")) == {"maxBackups": 5}
    assert list(tmp_path.glob("sub/*")) == [destino]


def test_acepta_texto_y_bytes(tmp_path):
    escribirAtomico(tmp_path / "a.txt", "cañón")
    escribirAtomico(tmp_path / "b.bin", b"\x00\x01")

    assert (tmp_path / "a.txt").read_text("utf-8") == "cañón"
    assert (tmp_path / "b.bin").read_bytes() == b"\x00\x01"


def test_un_fallo_al_escribir_deja_intacto_el_fichero_anterior(tmp_path, monkeypatch):
    """Lo que se perdía con write_text() directo: trunca antes de escribir."""
    destino = tmp_path / "ajustes.json"
    destino.write_text('{"valor": "el bueno"}', encoding="utf-8")

    import os as _os

    def _fsync_roto(_fd):
        raise OSError("disco lleno")

    monkeypatch.setattr(_os, "fsync", _fsync_roto)

    with pytest.raises(OSError):
        escribirAtomico(destino, '{"valor": "el nuevo"}')

    assert destino.read_text("utf-8") == '{"valor": "el bueno"}'
    assert list(tmp_path.iterdir()) == [destino]


def test_sobrescribe_un_destino_que_ya_existe(tmp_path):
    destino = tmp_path / "portfolios.json"
    escribirJsonAtomico(destino, {"v": 1})
    escribirJsonAtomico(destino, {"v": 2})

    assert json.loads(destino.read_text("utf-8")) == {"v": 2}


def test_limpiarTemporal_no_protesta_si_ya_no_está(tmp_path):
    limpiarTemporal(tmp_path / "no-existe.tmp")
