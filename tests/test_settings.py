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

def testTodosLosAjustesSePuedenLeer():
    """Ningún ajuste declarado revienta al resolverse con los valores actuales."""
    for ajuste in settings.CATALOGO:
        ajuste.leer()


def testLosNombresNoSeRepiten():
    nombres = [ajuste.nombre for ajuste in settings.CATALOGO]
    assert len(nombres) == len(set(nombres))


def testLasVariablesDeEntornoNoSeRepiten():
    """Dos ajustes con la misma env se pisarían entre ellos sin avisar."""
    envs = [ajuste.env for ajuste in settings.CATALOGO if ajuste.env]
    assert len(envs) == len(set(envs))


def testTodosLosAjustesEstanDocumentados():
    for ajuste in settings.CATALOGO:
        assert ajuste.descripcion.strip(), f"{ajuste.nombre} sin descripción"


def testLosDefectosRespetanSuPropioRango():
    for ajuste in settings.CATALOGO:
        if ajuste.minimo is not None:
            assert ajuste.defecto >= ajuste.minimo, ajuste.nombre
        if ajuste.maximo is not None:
            assert ajuste.defecto <= ajuste.maximo, ajuste.nombre
        if ajuste.tipo == settings.OPCION:
            assert ajuste.defecto in ajuste.permitidos, ajuste.nombre


def testObtenerFallaConUnNombreNoDeclarado():
    with pytest.raises(KeyError):
        settings.obtener("seccion.inventada")


def testElEntornoGanaAlFichero(config, monkeypatch):
    config("[seguridad]\nmax_intentos_login = 3\n")
    assert settings.maxIntentosLogin() == 3

    monkeypatch.setenv("MAX_INTENTOS_LOGIN", "9")
    assert settings.maxIntentosLogin() == 9


def testUnValorFueraDeRangoSeRecorta(config):
    """Recortar y avisar, en vez de dejar pasar un valor peligroso."""
    config("[seguridad]\nbloqueo_segundos = 0\n")
    assert settings.bloqueoSegundos() == 1  # el mínimo declarado


def testUnValorIlegibleCaeAlDefecto(config):
    config("[proveedores]\ntimeout_segundos = pronto\n")
    assert settings.proveedorTimeout() == 10.0


def testLasUnidadesSeConvierten(config):
    config("[server]\nmax_cuerpo_mb = 3\n\n[proveedores]\nmax_respuesta_mb = 2\n")
    assert settings.maxCuerpoBytes() == 3 * 1024 * 1024
    assert settings.proveedorMaxRespuestaBytes() == 2 * 1024 * 1024


def testElDecimalAceptaComa(config):
    config("[proveedores]\nbackoff_inicial_segundos = 1,5\n")
    assert settings.proveedorBackoffInicial() == 1.5


def testSamesiteNoneSinHttpsSeDegradaALax(config):
    """SameSite=None sin Secure haría que el navegador tirase la cookie."""
    config("[server]\ncookie_samesite = None\nhttps_activado = false\n")
    assert settings.cookieSameSite() == "Lax"

    config("[server]\ncookie_samesite = None\nhttps_activado = true\n")
    assert settings.cookieSameSite() == "None"


def testElMetodoDeHashUsaLasIteracionesConfiguradas(config):
    config("[seguridad]\nhash_iteraciones = 250000\n")
    assert settings.metodoHashPassword() == "pbkdf2:sha256:250000"


# ── Validación ────────────────────────────────────────────────────────────────

def testUnaConfiguracionCorrectaNoGeneraAvisos(config):
    config("[server]\nport = 8080\n")
    assert settings.validar() == []


def testAvisaDeUnValorFueraDeRango(config):
    config("[server]\nport = 99999\n")
    avisos = settings.validar()
    assert any("port" in aviso for aviso in avisos)


def testAvisaDeUnValorIlegible(config):
    config("[backups]\nmax_copias = muchas\n")
    assert any("max_copias" in aviso for aviso in settings.validar())


def testAvisaDeUnaOpcionNoPermitida(config):
    config("[registros]\nnivel = CHARLATAN\n")
    assert any("nivel" in aviso for aviso in settings.validar())


def testAvisaDeUnBooleanoIlegible(config):
    config("[server]\ndebug = quizas\n")
    assert any("debug" in aviso for aviso in settings.validar())


def testAvisaSiLaSubidaEsMenorQueElCuerpo(config):
    """Cada valor es válido por separado; la combinación no tiene sentido."""
    config("[server]\nmax_cuerpo_mb = 100\nmax_subida_mb = 10\n")
    assert any("max_subida_mb" in aviso for aviso in settings.validar())


def testAvisaDelAtajoActivadoSinRedes(config):
    """Fail-closed: sin redes no entra nadie, mejor decirlo que dejarlo pasar."""
    config("[atajo]\nactivado = true\nredes_permitidas =\n")
    assert any("redes_permitidas" in aviso for aviso in settings.validar())


def testAvisaDelModoDebug(config):
    config("[server]\ndebug = true\n")
    assert any("debug" in aviso for aviso in settings.validar())


# ── TLS y proxy inverso ───────────────────────────────────────────────────────

def testAvisaDeHttpsSinProxy(config):
    """La app no termina TLS: con https_activado hay un proxy, y hay que decirlo.

    Sin proxy_saltos, la IP de todas las peticiones sería la del proxy, y con
    ella se cuentan el límite de escrituras y el bloqueo por intentos de login.
    """
    config("[server]\nhttps_activado = true\nproxy_saltos = 0\n")
    assert any("proxy_saltos" in aviso for aviso in settings.validar())


def testAvisaDeProxySinHttps(config):
    """Al revés: hay proxy declarado, pero la cookie sale sin Secure."""
    config("[server]\nhttps_activado = false\nproxy_saltos = 1\n")
    assert any("Secure" in aviso for aviso in settings.validar())


def testHttpsConProxyNoGeneraAvisos(config):
    config("[server]\nhttps_activado = true\nproxy_saltos = 1\n")
    assert settings.validar() == []


def testElAvisoDeHttpPlanoEstaFueraDeValidar(config):
    """Servir por HTTP es el defecto, no un error de configuración.

    Si estuviera en validar(), el config.ini que se distribuye no pasaría su
    propia validación. El recordatorio vive en core/tls.py, que es quien sabe si
    el HTTPS está encendido desde Ajustes, y sale en el log de arranque.
    """
    config("[server]\nhttps_activado = false\n")
    assert settings.validar() == []


def testProxySaltosSeAcotaPorAbajo(config):
    """Un valor raro aquí decide de quién se fía la app: se recorta al mínimo."""
    config("[server]\nproxy_saltos = -1\n")
    assert settings.proxySaltos() == 0


# ── Sombras: el .env tapando a config.ini ─────────────────────────────────────
#
# El fallo de la 1.6.0 con las claves de API, en su versión de configuración:
# dos sitios donde poner lo mismo, uno con prioridad, y nada que lo diga. Estas
# pruebas fijan que el choque se avise y que avisar no se convierta en ruido.

def testAvisaCuandoElEntornoTapaUnValorEscrito(config, monkeypatch):
    config("[backups]\nmax_copias = 7\n")
    monkeypatch.setenv("BACKUPS_MAX_COPIAS", "30")

    avisos = settings.sombras()

    assert len(avisos) == 1
    assert "max_copias" in avisos[0]
    assert "7" in avisos[0] and "30" in avisos[0]
    assert "BACKUPS_MAX_COPIAS" in avisos[0]
    assert avisos == [aviso for aviso in settings.validar() if aviso in avisos]


def testNoAvisaSiLosDosSitiosDicenLoMismo(config, monkeypatch):
    """Redundante, pero no engaña a nadie: avisar aquí sería ruido."""
    config("[backups]\nmax_copias = 30\n")
    monkeypatch.setenv("BACKUPS_MAX_COPIAS", "30")

    assert settings.sombras() == []


def testNoAvisaSiElFicheroEstaComoSeDistribuye(config, monkeypatch):
    """El README recomienda dejar config.ini quieto y cambiar las cosas en .env.

    Como el fichero se distribuye con todas las opciones escritas en su valor
    por defecto, avisar de esas líneas denunciaría el flujo recomendado en cada
    arranque. Solo es una decisión perdida si alguien editó el fichero.
    """
    config("[backups]\nmax_copias = 14\n")
    monkeypatch.setenv("BACKUPS_MAX_COPIAS", "30")

    assert settings.sombras() == []


def testElConfigIniDelRepositorioNoGeneraSombras(monkeypatch):
    """La comprobación de arriba, contra el fichero de verdad y todo el catálogo."""
    for ajuste in settings.CATALOGO:
        if ajuste.env and ajuste.env not in settings.FIJADAS_POR_EL_DESPLIEGUE:
            monkeypatch.setenv(ajuste.env, "1")

    assert settings.sombras() == []


def testNoAvisaDeUnAjusteQueNoEstaEscrito(config, monkeypatch):
    """Sin la opción en el fichero no hay dos valores: el entorno es el único."""
    config("[server]\nport = 8080\n")
    monkeypatch.setenv("BACKUPS_MAX_COPIAS", "30")

    assert settings.sombras() == []


def testUnaVariableVaciaNoTapaNada(config, monkeypatch):
    config("[backups]\nmax_copias = 7\n")
    monkeypatch.setenv("BACKUPS_MAX_COPIAS", "")

    assert settings.sombras() == []


def testNoAvisaDeLoQueFijaElDespliegue(config, monkeypatch):
    """PROXY_FIX_HOPS lo pone docker-compose.yml en todos los arranques."""
    config("[server]\nproxy_saltos = 2\n")
    monkeypatch.setenv("PROXY_FIX_HOPS", "1")

    assert settings.sombras() == []


def testLasVariablesFijadasExistenEnElCatalogo():
    envs = {ajuste.env for ajuste in settings.CATALOGO if ajuste.env}
    assert envs >= settings.FIJADAS_POR_EL_DESPLIEGUE


def testLasFijadasCubrenLoQueEscribeDockerCompose():
    """Un override nuevo en docker-compose.yml sin añadir aquí = aviso en cada arranque.

    docker-compose.yml escribe algunas variables en el contenedor a propósito
    —el proxy, las rutas de los volúmenes, el puerto— porque ahí el valor
    correcto no es el del fichero. Si una de ellas no está exenta, `sombras()`
    la denunciaría en todos los arranques con Docker y el aviso dejaría de
    significar nada.
    """
    compose = (config_ini._RAIZ / "docker-compose.yml").read_text(encoding="utf-8")
    envs = {ajuste.env for ajuste in settings.CATALOGO if ajuste.env}

    escritas = {
        linea.strip().lstrip("- ").split("=", 1)[0]
        for linea in compose.splitlines()
        if linea.strip().startswith("- ") and "=" in linea
    }
    delCatalogo = escritas & envs

    assert delCatalogo == set(settings.FIJADAS_POR_EL_DESPLIEGUE), (
        "docker-compose.yml y settings.FIJADAS_POR_EL_DESPLIEGUE se han separado: "
        f"sobra(n) {set(settings.FIJADAS_POR_EL_DESPLIEGUE) - delCatalogo}, "
        f"falta(n) {delCatalogo - set(settings.FIJADAS_POR_EL_DESPLIEGUE)}"
    )


def testElConfigIniSeMontaEnElContenedor():
    """Sin el montaje, editar config.ini no hace nada hasta reconstruir la imagen."""
    compose = (config_ini._RAIZ / "docker-compose.yml").read_text(encoding="utf-8")
    assert "./config.ini:/app/config.ini:ro" in compose


# ── Diagnóstico ───────────────────────────────────────────────────────────────

def testElDiagnosticoIndicaElOrigenDeCadaValor(config, monkeypatch):
    config("[server]\nport = 8080\n")
    monkeypatch.setenv("BACKUPS_MAX_COPIAS", "30")

    porNombre = {fila["nombre"]: fila for fila in settings.diagnostico()}

    assert porNombre["server.port"]["origen"] == "config.ini"
    assert porNombre["backups.max_copias"]["origen"] == "entorno"
    assert porNombre["server.host"]["origen"] == "defecto"


def testElDiagnosticoCubreElCatalogoEntero(config):
    config("")
    assert len(settings.diagnostico()) == len(settings.CATALOGO)


# ── Coherencia entre config.ini y el catálogo ─────────────────────────────────

def _configDelRepositorio():
    parser = configparser.ConfigParser(inline_comment_prefixes=(";", "#"), interpolation=None)
    parser.read(config_ini._RAIZ / "config.ini", encoding="utf-8")
    return parser


def testConfigIniDelRepositorioEsLegible():
    parser = _configDelRepositorio()
    assert parser.sections(), "config.ini vacío o ilegible"


def testConfigIniNoTieneOpcionesSinDeclarar():
    """Una opción que el código no lee es una trampa: se edita y no hace nada."""
    parser = _configDelRepositorio()
    declarados = {ajuste.nombre for ajuste in settings.CATALOGO}

    huerfanos = [
        f"{seccion}.{opcion}"
        for seccion in parser.sections()
        for opcion in parser.options(seccion)
        if f"{seccion}.{opcion}" not in declarados
    ]

    assert not huerfanos, f"Opciones en config.ini que settings.py no declara: {huerfanos}"


def testConfigIniDeclaraTodosLosAjustes():
    """Al revés: un ajuste sin línea en config.ini es un ajuste que nadie descubre."""
    parser = _configDelRepositorio()

    ausentes = [
        ajuste.nombre for ajuste in settings.CATALOGO
        if not parser.has_option(ajuste.seccion, ajuste.opcion)
    ]

    assert not ausentes, f"Ajustes declarados que config.ini no documenta: {ausentes}"


def testConfigIniDelRepositorioNoGeneraAvisos():
    """El fichero que se distribuye tiene que pasar su propia validación."""
    config_ini.invalidarCache()
    try:
        assert settings.validar() == []
    finally:
        config_ini.invalidarCache()


def testConfigIniCoincideConLosDefectosDelCatalogo():
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

def testLasRutasDerivanDelDirectorioDeDatos():
    from core import paths

    assert paths.AUTH_FILE.parent == paths.DATA_DIR
    assert paths.JSON_DIR.parent == paths.DATA_DIR
    assert paths.AUTO_BACKUPS_DIR.parent == paths.BACKUPS_DIR
    assert paths.AJUSTES_JSON.parent == paths.JSON_DIR


def testUnaRutaRelativaDelConfigCuelgaDeLaRaiz():
    from core import paths

    assert paths.rutaDesdeBase("API/movimientos.key") == paths.BASE_DIR / "API" / "movimientos.key"


def testUnaRutaAbsolutaDelConfigSeRespeta(tmp_path):
    from core import paths

    assert paths.rutaDesdeBase(tmp_path / "claves.key") == tmp_path / "claves.key"
