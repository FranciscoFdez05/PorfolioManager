"""Exclusión mutua entre procesos (core/bloqueo.py).

`threading.Lock` protege de los otros hilos del proceso, que es todo lo que hay
con el servidor de desarrollo. En el contenedor, gunicorn levanta dos workers:
dos procesos que importan server.py a la vez, migran la misma base de datos y
lanzan cada uno su hilo de copias automáticas. Ahí un lock de hilos no protege
de nada.

Se prueba con descriptores distintos, que es como lo ve el sistema operativo:
dos aperturas del mismo fichero se excluyen igual estén en un proceso o en dos.
"""

import threading
import time

import pytest

from core.bloqueo import BloqueoOcupado, exclusivo


def test_solo_uno_lo_consigue_a_la_vez(tmp_path):
    lock = tmp_path / "esquema.lock"

    with exclusivo(lock) as primero:
        with exclusivo(lock, obligatorio=False) as segundo:
            assert segundo is False
        assert primero is True


def test_se_suelta_al_salir(tmp_path):
    lock = tmp_path / "esquema.lock"

    with exclusivo(lock):
        pass

    with exclusivo(lock) as conseguido:
        assert conseguido is True


def test_se_suelta_aunque_lo_de_dentro_falle(tmp_path):
    """Si una migración revienta, el bloqueo no puede quedarse puesto."""
    lock = tmp_path / "esquema.lock"

    with pytest.raises(RuntimeError), exclusivo(lock):
        raise RuntimeError("migración fallida")

    with exclusivo(lock) as conseguido:
        assert conseguido is True


def test_obligatorio_avisa_en_vez_de_seguir(tmp_path):
    """La migración prefiere morir a aplicarse dos veces sobre los datos."""
    lock = tmp_path / "esquema.lock"

    with exclusivo(lock), pytest.raises(BloqueoOcupado), exclusivo(lock, espera=0):
        pass


def test_espera_a_que_el_otro_termine(tmp_path):
    lock = tmp_path / "esquema.lock"
    soltado = threading.Event()

    def ocupar():
        with exclusivo(lock):
            time.sleep(0.4)
        soltado.set()

    hilo = threading.Thread(target=ocupar)
    hilo.start()
    time.sleep(0.1)

    with exclusivo(lock, espera=5) as conseguido:
        assert conseguido is True
        assert soltado.is_set()

    hilo.join()


def test_sin_sitio_donde_crearlo_se_continua_sin_bloqueo(tmp_path):
    """Un bloqueo que no se puede crear no debe impedir arrancar.

    Es el peor momento posible para negarse a funcionar: el volumen de datos no
    es escribible, y de eso ya avisa el arranque con un mensaje que se entiende.
    """
    ocupado = tmp_path / "fichero"
    ocupado.write_text("no soy un directorio", encoding="utf-8")

    with exclusivo(ocupado / "sub" / "x.lock") as conseguido:
        assert conseguido is False


def test_crea_el_directorio_del_bloqueo_si_falta(tmp_path):
    lock = tmp_path / "tmp" / "backup-automatico.lock"

    with exclusivo(lock) as conseguido:
        assert conseguido is True

    assert lock.exists()
