"""Pruebas del lector de config.ini."""

import pytest


@pytest.fixture
def config(tmp_path, monkeypatch):
    """Escribe un config.ini de prueba y apunta el módulo a él."""
    from core import config_ini

    def escribir(contenido):
        ruta = tmp_path / "config.ini"
        ruta.write_text(contenido, encoding="utf-8")
        monkeypatch.setattr(config_ini, "RUTA_CONFIG", ruta)
        config_ini.invalidarCache()
        return ruta

    yield escribir
    config_ini.invalidarCache()


def test_lee_texto_y_aplica_el_defecto(config):
    from core.config_ini import obtenerTexto

    config("[demo]\nvalor = hola\nvacio =\n")

    assert obtenerTexto("demo", "valor", "defecto") == "hola"
    assert obtenerTexto("demo", "vacio", "defecto") == "defecto"
    assert obtenerTexto("demo", "ausente", "defecto") == "defecto"
    assert obtenerTexto("seccion-ausente", "valor", "defecto") == "defecto"


def test_el_entorno_gana_al_fichero(config, monkeypatch):
    from core.config_ini import obtenerTexto

    config("[demo]\nvalor = del-fichero\n")
    monkeypatch.setenv("DEMO_VALOR", "del-entorno")

    assert obtenerTexto("demo", "valor", "", env="DEMO_VALOR") == "del-entorno"


def test_entorno_vacio_no_pisa_el_fichero(config, monkeypatch):
    """Una variable declarada pero vacía no debe borrar el valor configurado."""
    from core.config_ini import obtenerTexto

    config("[demo]\nvalor = del-fichero\n")
    monkeypatch.setenv("DEMO_VALOR", "   ")

    assert obtenerTexto("demo", "valor", "", env="DEMO_VALOR") == "del-fichero"


def test_entero_con_limites(config):
    from core.config_ini import obtenerEntero

    config("[demo]\nbajo = 0\nalto = 999\nok = 42\nbasura = abc\n")

    assert obtenerEntero("demo", "ok", 1) == 42
    assert obtenerEntero("demo", "bajo", 1, minimo=10) == 10
    assert obtenerEntero("demo", "alto", 1, maximo=100) == 100
    assert obtenerEntero("demo", "basura", 7) == 7
    assert obtenerEntero("demo", "ausente", 7) == 7


@pytest.mark.parametrize(("texto", "esperado"), [
    ("true", True), ("1", True), ("yes", True), ("on", True), ("si", True), ("Sí", True),
    ("false", False), ("0", False), ("no", False), ("off", False),
])
def test_booleanos(config, texto, esperado):
    from core.config_ini import obtenerBooleano

    config(f"[demo]\nvalor = {texto}\n")

    assert obtenerBooleano("demo", "valor", not esperado) is esperado


def test_booleano_ilegible_usa_el_defecto(config):
    from core.config_ini import obtenerBooleano

    config("[demo]\nvalor = quizas\n")

    assert obtenerBooleano("demo", "valor", True) is True
    assert obtenerBooleano("demo", "valor", False) is False


def test_lista_ignora_huecos(config):
    from core.config_ini import obtenerLista

    config("[demo]\nvalores = uno,  dos ,,tres,\n")

    assert obtenerLista("demo", "valores") == ["uno", "dos", "tres"]
    assert obtenerLista("demo", "ausente", ("a", "b")) == ["a", "b"]


def test_comentario_en_linea(config):
    """inline_comment_prefixes evita que el ';' acabe dentro del valor."""
    from core.config_ini import obtenerLista

    config("[demo]\nvalores = uno, dos  ; esto es un comentario\n")

    assert obtenerLista("demo", "valores") == ["uno", "dos"]


def test_relee_al_cambiar_el_fichero(config):
    """Editar config.ini con el servidor arrancado surte efecto sin reiniciar."""
    import os

    from core.config_ini import obtenerTexto

    ruta = config("[demo]\nvalor = antes\n")
    assert obtenerTexto("demo", "valor") == "antes"

    ruta.write_text("[demo]\nvalor = despues\n", encoding="utf-8")
    # El cambio se detecta por mtime; en sistemas con poca resolución dos
    # escrituras seguidas pueden compartir marca de tiempo.
    marca = ruta.stat().st_mtime + 1
    os.utime(ruta, (marca, marca))

    assert obtenerTexto("demo", "valor") == "despues"


def test_fichero_ausente_no_revienta(tmp_path, monkeypatch):
    from core import config_ini

    monkeypatch.setattr(config_ini, "RUTA_CONFIG", tmp_path / "no-existe.ini")
    config_ini.invalidarCache()

    try:
        assert config_ini.obtenerTexto("demo", "valor", "defecto") == "defecto"
        assert config_ini.obtenerEntero("demo", "valor", 5) == 5
        assert config_ini.obtenerBooleano("demo", "valor", True) is True
    finally:
        config_ini.invalidarCache()
