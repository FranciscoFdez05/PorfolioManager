"""Pruebas del catálogo de ajustes y de su coherencia con config.ini.

Las de la última sección son las que más valor tienen a largo plazo: comprueban
que el config.ini que se distribuye y el catálogo de settings.py no se separen.
Sin ellas, renombrar un ajuste en el código deja en config.ini una opción huérfana
que el usuario edita creyendo que hace algo.
"""

import configparser

import pytest

from core import config_ini, settings


@pytest.fixture
def config(tmp_path, monkeypatch):
    """Apunta el lector a un config.ini de prueba, no al del repositorio."""
    def escribir(contenido):
        ruta = tmp_path / "config.ini"
        ruta.write_text(contenido, encoding="utf-8")
        monkeypatch.setattr(config_ini, "RUTA_CONFIG", ruta)
        config_ini.invalidarCache()
        return ruta

    yield escribir
    config_ini.invalidarCache()


# ── Catálogo ──────────────────────────────────────────────────────────────────

def test_todos_los_ajustes_se_pueden_leer():
    """Ningún ajuste declarado revienta al resolverse con los valores actuales."""
    for ajuste in settings.CATALOGO:
        ajuste.leer()


def test_los_nombres_no_se_repiten():
    nombres = [ajuste.nombre for ajuste in settings.CATALOGO]
    assert len(nombres) == len(set(nombres))


def test_las_variables_de_entorno_no_se_repiten():
    """Dos ajustes con la misma env se pisarían entre ellos sin avisar."""
    envs = [ajuste.env for ajuste in settings.CATALOGO if ajuste.env]
    assert len(envs) == len(set(envs))


def test_todos_los_ajustes_estan_documentados():
    for ajuste in settings.CATALOGO:
        assert ajuste.descripcion.strip(), f"{ajuste.nombre} sin descripción"


def test_los_defectos_respetan_su_propio_rango():
    for ajuste in settings.CATALOGO:
        if ajuste.minimo is not None:
            assert ajuste.defecto >= ajuste.minimo, ajuste.nombre
        if ajuste.maximo is not None:
            assert ajuste.defecto <= ajuste.maximo, ajuste.nombre
        if ajuste.tipo == settings.OPCION:
            assert ajuste.defecto in ajuste.permitidos, ajuste.nombre


def test_obtener_falla_con_un_nombre_no_declarado():
    with pytest.raises(KeyError):
        settings.obtener("seccion.inventada")


def test_el_entorno_gana_al_fichero(config, monkeypatch):
    config("[seguridad]\nmax_intentos_login = 3\n")
    assert settings.maxIntentosLogin() == 3

    monkeypatch.setenv("MAX_INTENTOS_LOGIN", "9")
    assert settings.maxIntentosLogin() == 9


def test_un_valor_fuera_de_rango_se_recorta(config):
    """Recortar y avisar, en vez de dejar pasar un valor peligroso."""
    config("[seguridad]\nbloqueo_segundos = 0\n")
    assert settings.bloqueoSegundos() == 1  # el mínimo declarado


def test_un_valor_ilegible_cae_al_defecto(config):
    config("[proveedores]\ntimeout_segundos = pronto\n")
    assert settings.proveedorTimeout() == 10.0


def test_las_unidades_se_convierten(config):
    config("[server]\nmax_cuerpo_mb = 3\n\n[proveedores]\nmax_respuesta_mb = 2\n")
    assert settings.maxCuerpoBytes() == 3 * 1024 * 1024
    assert settings.proveedorMaxRespuestaBytes() == 2 * 1024 * 1024


def test_el_decimal_acepta_coma(config):
    config("[proveedores]\nbackoff_inicial_segundos = 1,5\n")
    assert settings.proveedorBackoffInicial() == 1.5


def test_samesite_none_sin_https_se_degrada_a_lax(config):
    """SameSite=None sin Secure haría que el navegador tirase la cookie."""
    config("[server]\ncookie_samesite = None\nhttps_activado = false\n")
    assert settings.cookieSameSite() == "Lax"

    config("[server]\ncookie_samesite = None\nhttps_activado = true\n")
    assert settings.cookieSameSite() == "None"


def test_el_metodo_de_hash_usa_las_iteraciones_configuradas(config):
    config("[seguridad]\nhash_iteraciones = 250000\n")
    assert settings.metodoHashPassword() == "pbkdf2:sha256:250000"


# ── Validación ────────────────────────────────────────────────────────────────

def test_una_configuracion_correcta_no_genera_avisos(config):
    config("[server]\nport = 8080\n")
    assert settings.validar() == []


def test_avisa_de_un_valor_fuera_de_rango(config):
    config("[server]\nport = 99999\n")
    avisos = settings.validar()
    assert any("port" in aviso for aviso in avisos)


def test_avisa_de_un_valor_ilegible(config):
    config("[backups]\nmax_copias = muchas\n")
    assert any("max_copias" in aviso for aviso in settings.validar())


def test_avisa_de_una_opcion_no_permitida(config):
    config("[registros]\nnivel = CHARLATAN\n")
    assert any("nivel" in aviso for aviso in settings.validar())


def test_avisa_de_un_booleano_ilegible(config):
    config("[server]\ndebug = quizas\n")
    assert any("debug" in aviso for aviso in settings.validar())


def test_avisa_si_la_subida_es_menor_que_el_cuerpo(config):
    """Cada valor es válido por separado; la combinación no tiene sentido."""
    config("[server]\nmax_cuerpo_mb = 100\nmax_subida_mb = 10\n")
    assert any("max_subida_mb" in aviso for aviso in settings.validar())


def test_avisa_del_atajo_activado_sin_redes(config):
    """Fail-closed: sin redes no entra nadie, mejor decirlo que dejarlo pasar."""
    config("[atajo]\nactivado = true\nredes_permitidas =\n")
    assert any("redes_permitidas" in aviso for aviso in settings.validar())


def test_avisa_del_modo_debug(config):
    config("[server]\ndebug = true\n")
    assert any("debug" in aviso for aviso in settings.validar())


# ── TLS y proxy inverso ───────────────────────────────────────────────────────

def test_avisa_de_https_sin_proxy(config):
    """La app no termina TLS: con https_activado hay un proxy, y hay que decirlo.

    Sin proxy_saltos, la IP de todas las peticiones sería la del proxy, y con
    ella se cuentan el límite de escrituras y el bloqueo por intentos de login.
    """
    config("[server]\nhttps_activado = true\nproxy_saltos = 0\n")
    assert any("proxy_saltos" in aviso for aviso in settings.validar())


def test_avisa_de_proxy_sin_https(config):
    """Al revés: hay proxy declarado, pero la cookie sale sin Secure."""
    config("[server]\nhttps_activado = false\nproxy_saltos = 1\n")
    assert any("Secure" in aviso for aviso in settings.validar())


def test_https_con_proxy_no_genera_avisos(config):
    config("[server]\nhttps_activado = true\nproxy_saltos = 1\n")
    assert settings.validar() == []


def test_el_aviso_de_http_plano_esta_fuera_de_validar(config):
    """Servir por HTTP es el defecto, no un error de configuración.

    Si estuviera en validar(), el config.ini que se distribuye no pasaría su
    propia validación. El recordatorio vive en core/tls.py, que es quien sabe si
    el HTTPS está encendido desde Ajustes, y sale en el log de arranque.
    """
    config("[server]\nhttps_activado = false\n")
    assert settings.validar() == []


def test_proxy_saltos_se_acota_por_abajo(config):
    """Un valor raro aquí decide de quién se fía la app: se recorta al mínimo."""
    config("[server]\nproxy_saltos = -1\n")
    assert settings.proxySaltos() == 0


# ── Diagnóstico ───────────────────────────────────────────────────────────────

def test_el_diagnostico_indica_el_origen_de_cada_valor(config, monkeypatch):
    config("[server]\nport = 8080\n")
    monkeypatch.setenv("BACKUPS_MAX_COPIAS", "30")

    por_nombre = {fila["nombre"]: fila for fila in settings.diagnostico()}

    assert por_nombre["server.port"]["origen"] == "config.ini"
    assert por_nombre["backups.max_copias"]["origen"] == "entorno"
    assert por_nombre["server.host"]["origen"] == "defecto"


def test_el_diagnostico_cubre_el_catalogo_entero(config):
    config("")
    assert len(settings.diagnostico()) == len(settings.CATALOGO)


# ── Coherencia entre config.ini y el catálogo ─────────────────────────────────

def _config_del_repositorio():
    parser = configparser.ConfigParser(inline_comment_prefixes=(";", "#"), interpolation=None)
    parser.read(config_ini._RAIZ / "config.ini", encoding="utf-8")
    return parser


def test_config_ini_del_repositorio_es_legible():
    parser = _config_del_repositorio()
    assert parser.sections(), "config.ini vacío o ilegible"


def test_config_ini_no_tiene_opciones_sin_declarar():
    """Una opción que el código no lee es una trampa: se edita y no hace nada."""
    parser = _config_del_repositorio()
    declarados = {ajuste.nombre for ajuste in settings.CATALOGO}

    huerfanos = [
        f"{seccion}.{opcion}"
        for seccion in parser.sections()
        for opcion in parser.options(seccion)
        if f"{seccion}.{opcion}" not in declarados
    ]

    assert not huerfanos, f"Opciones en config.ini que settings.py no declara: {huerfanos}"


def test_config_ini_declara_todos_los_ajustes():
    """Al revés: un ajuste sin línea en config.ini es un ajuste que nadie descubre."""
    parser = _config_del_repositorio()

    ausentes = [
        ajuste.nombre for ajuste in settings.CATALOGO
        if not parser.has_option(ajuste.seccion, ajuste.opcion)
    ]

    assert not ausentes, f"Ajustes declarados que config.ini no documenta: {ausentes}"


def test_config_ini_del_repositorio_no_genera_avisos():
    """El fichero que se distribuye tiene que pasar su propia validación."""
    config_ini.invalidarCache()
    try:
        assert settings.validar() == []
    finally:
        config_ini.invalidarCache()


def test_config_ini_coincide_con_los_defectos_del_catalogo():
    """Los valores distribuidos son los valores por defecto.

    Si divergen, el usuario que borre una línea de config.ini obtiene un
    comportamiento distinto del que tenía, sin haber cambiado nada más.
    """
    config_ini.invalidarCache()
    try:
        divergentes = []
        for ajuste in settings.CATALOGO:
            if ajuste.env and __import__("os").environ.get(ajuste.env, "").strip():
                continue  # el entorno de quien ejecuta la suite manda
            esperado = list(ajuste.defecto) if ajuste.tipo == settings.LISTA else ajuste.defecto
            if ajuste.leer() != esperado:
                divergentes.append((ajuste.nombre, ajuste.leer(), esperado))
        assert not divergentes
    finally:
        config_ini.invalidarCache()


# ── Rutas ─────────────────────────────────────────────────────────────────────

def test_las_rutas_derivan_del_directorio_de_datos():
    from core import paths

    assert paths.AUTH_FILE.parent == paths.DATA_DIR
    assert paths.JSON_DIR.parent == paths.DATA_DIR
    assert paths.AUTO_BACKUPS_DIR.parent == paths.BACKUPS_DIR
    assert paths.AJUSTES_JSON.parent == paths.JSON_DIR


def test_una_ruta_relativa_del_config_cuelga_de_la_raiz():
    from core import paths

    assert paths.rutaDesdeBase("API/movimientos.key") == paths.BASE_DIR / "API" / "movimientos.key"


def test_una_ruta_absoluta_del_config_se_respeta(tmp_path):
    from core import paths

    assert paths.rutaDesdeBase(tmp_path / "claves.key") == tmp_path / "claves.key"
