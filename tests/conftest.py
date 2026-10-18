"""Fixtures compartidas.

Regla importante: **ningún test toca `data/` del repositorio**. Los tests que
necesitan base de datos apuntan `db` a un fichero temporal con
`setActiveDbPath()`, y ninguno importa `server`, porque ese módulo ejecuta
`initPortfolios()` / `ensureDataFile()` al importarse y escribiría sobre los
datos reales del usuario que ejecuta la suite en su máquina.
"""

import sys
from pathlib import Path

import pytest

# El código se importa de forma plana desde python/ (igual que en gunicorn).
# pyproject ya lo configura vía `pythonpath`, pero repetirlo aquí permite
# lanzar `pytest tests/…` desde cualquier directorio.
_PYTHON_DIR = Path(__file__).resolve().parent.parent / "python"
if str(_PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(_PYTHON_DIR))


@pytest.fixture(autouse=True)
def _tmpDeDatosAislado(tmp_path_factory, monkeypatch):
    """Saca `data/tmp` y `data/backups/auto` del repositorio en TODOS los tests.

    Ahí van los ficheros de bloqueo entre procesos (migración del esquema,
    copia automática) y los temporales de las copias de bases de datos. A
    diferencia del resto de rutas, los usa cualquier test que abra una base de
    datos, no solo los que piden `datosAislados`, así que el aislamiento tiene
    que ser automático: si no, la suite deja ficheros sueltos en el `data/` real
    de quien la ejecuta.

    El directorio de copias automáticas se quedó fuera de esa regla y el efecto
    era acumulativo: cada base que crea `tempDb` nace en la versión 0 del
    esquema, así que migra, y cada migración deja su copia previa
    `<base>_pre-esquema-N-a-M_*.db`. Esas copias están **exentas de la
    rotación** a propósito —son el punto de retorno de una actualización—, así
    que nadie las borraba nunca: una sola pasada de la suite deja unas
    cuatrocientas en el `data/backups/auto` de verdad.

    Se parchea el nombre dentro de `admin.backup_manager`, no en `core.paths`,
    por lo mismo que explica `datosAislados`: el módulo se lo lleva con
    `from core.paths import AUTO_BACKUPS_DIR as _BACKUP_DIR` al importarse, y
    reasignar el original ya no alcanza a nadie.
    """
    from admin import backup_manager
    from core import paths, sesion

    destino = tmp_path_factory.getbasetemp() / "datos_tmp"
    destino.mkdir(exist_ok=True)
    monkeypatch.setattr(paths, "TMP_DIR", destino, raising=False)

    copias = tmp_path_factory.getbasetemp() / "backups_auto"
    copias.mkdir(exist_ok=True)
    monkeypatch.setattr(backup_manager, "_BACKUP_DIR", copias, raising=False)

    # Telegram lee su token de API/telegram.key. Sin esto, un test que provoque
    # un aviso (una copia, un login bloqueado) sin pedir `datosAislados` leería
    # el API/ real de quien ejecuta la suite y, con SECRET_KEY exportada, mandaría
    # mensajes de verdad a su chat.
    clavesVacias = tmp_path_factory.getbasetemp() / "API_vacio"
    clavesVacias.mkdir(exist_ok=True)
    monkeypatch.setattr(paths, "API_DIR", clavesVacias, raising=False)

    # Estado de revocación de sesiones. Va aquí y no en `datosAislados` por el
    # mismo motivo que los dos de arriba: lo escribe cualquier test que cierre
    # sesión o cambie credenciales, no solo los que piden rutas aisladas, y sin
    # esto la suite dejaría revocaciones en el `data/sesion` real.
    # El resolutor del portfolio activo (core/db.py) relee portfolios.json
    # cuando cambia. Lo registra initPortfolios() y es estado de módulo: sin
    # quitarlo, un test que lo registró con un portfolios.json temporal lo
    # dejaría apuntando, tras deshacer los monkeypatch, al data/ real del
    # usuario, y el siguiente test podría acabar abriendo su base de datos.
    from core import db as _db

    monkeypatch.setattr(_db, "_resolutorActivo", None, raising=False)

    # Firmas del Atajo ya usadas y nombres de host aprendidos: un fichero por
    # test. Compartidos, dos tests que firman el mismo cuerpo en el mismo
    # segundo se verían como una repetición; y los hosts, sin redirigir,
    # acabarían en el data/atajo real.
    from core import firma_hmac, red_local

    propios = tmp_path_factory.mktemp("atajo")
    monkeypatch.setattr(firma_hmac, "_ficheroFirmasUsadas", lambda: propios / "atajo-firmas-usadas.json")
    monkeypatch.setattr(red_local, "_ficheroHosts", lambda: propios / "hosts.json")
    monkeypatch.setattr(red_local, "_hostsCache", {"firma": None, "hosts": frozenset()})

    # Registro de intentos de login: vive en un fichero compartido entre
    # procesos. Uno por test, para que el bloqueo de uno no pase al siguiente.
    from routes import auth

    intentos = tmp_path_factory.mktemp("login") / "login-intentos.json"
    monkeypatch.setattr(auth, "_ficheroIntentos", lambda: intentos)
    auth._attempts.clear()

    sesiones = tmp_path_factory.getbasetemp() / "sesion"
    sesiones.mkdir(exist_ok=True)
    monkeypatch.setattr(sesion, "SESION_DIR", sesiones, raising=False)
    monkeypatch.setattr(sesion, "ESTADO_FILE", sesiones / "estado.json", raising=False)
    monkeypatch.setattr(sesion, "LOCK_FILE", sesiones / "estado.lock", raising=False)


@pytest.fixture
def tempDb(tmp_path, monkeypatch):
    """Base de datos SQLite vacía y aislada para el test."""
    from core import db

    originalPath = db.getActiveDbPath()
    dbPath = tmp_path / "test_portfolio.db"
    db.setActiveDbPath(dbPath)
    # Crea el esquema y deja la conexión del hilo lista.
    db.initDb()

    yield dbPath

    db.resetDb()
    db.setActiveDbPath(originalPath)
    db.invalidateAllConnections()


@pytest.fixture
def datosAislados(tmp_path, monkeypatch):
    """Redirige a tmp_path todos los directorios de datos que tocan las rutas.

    `core.paths` resuelve sus constantes al importarse y los módulos las copian
    con `from … import BACKUPS_DIR as _BACKUP_DIR`, así que reasignar
    `core.paths.DATA_DIR` no alcanzaría a nadie: hay que parchear el nombre en
    cada módulo que ya se lo llevó. Por eso la lista es explícita y no un bucle
    sobre `core.paths`; si mañana otro módulo importa uno de estos, el test que
    lo cubra fallará escribiendo en `data/` y el fallo se verá.
    """
    from admin import portfolios_manager
    from core import paths
    from routes import (
        ajustes as rutasAjustes,
        backup as rutasBackup,
        portfolios as rutasPortfolios,
    )

    data = tmp_path / "data"
    backups = data / "backups"
    portfolios = data / "portfolios"
    jsonDir = data / "JSON"
    # logs/ también: el diagnóstico de almacenamiento comprueba la escritura
    # creando un fichero de verdad en cada directorio, y sin aislarlo tocaría el
    # logs/ del repositorio.
    logs = tmp_path / "logs"
    for carpeta in (data, backups, portfolios, jsonDir, logs):
        carpeta.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(paths, "DATA_DIR", data, raising=False)
    monkeypatch.setattr(paths, "BACKUPS_DIR", backups, raising=False)
    monkeypatch.setattr(paths, "PORTFOLIOS_DIR", portfolios, raising=False)
    monkeypatch.setattr(paths, "JSON_DIR", jsonDir, raising=False)
    monkeypatch.setattr(paths, "AJUSTES_JSON", jsonDir / "ajustes.json", raising=False)
    monkeypatch.setattr(paths, "PORTFOLIOS_META_FILE", data / "portfolios.json", raising=False)
    monkeypatch.setattr(paths, "AUTH_FILE", data / "auth.dat", raising=False)
    monkeypatch.setattr(paths, "LOGS_DIR", logs, raising=False)
    monkeypatch.setattr(paths, "TMP_DIR", data / "tmp", raising=False)

    monkeypatch.setattr(rutasBackup, "DATA_DIR", data)
    monkeypatch.setattr(rutasBackup, "_BACKUP_DIR", backups)
    monkeypatch.setattr(rutasBackup, "_PORTFOLIOS_DIR", portfolios)
    monkeypatch.setattr(rutasBackup, "_JSON_DIR", jsonDir)
    monkeypatch.setattr(rutasBackup, "_AJUSTES_SRC", jsonDir / "ajustes.json")
    monkeypatch.setattr(rutasBackup, "_META_FILE", data / "portfolios.json")
    monkeypatch.setattr(rutasAjustes, "_AJUSTES_JSON", jsonDir / "ajustes.json")
    monkeypatch.setattr(rutasAjustes, "JSON_DIR", jsonDir)
    # Las claves de API se guardan cifradas en API/*.key; sin aislarlas, un test
    # de /api/settings sobrescribiría las del usuario.
    claves = tmp_path / "API"
    claves.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(paths, "API_DIR", claves, raising=False)
    monkeypatch.setattr(rutasAjustes, "_API_DIR", claves)
    # `stores.app_data` lee las claves de `paths.API_DIR` en cada llamada, así
    # que el parche de arriba ya lo cubre.

    # /api/restore llama a initPortfolios() al terminar, que reactiva el
    # portfolio guardado en el backup. Sin parchear también estos nombres, ese
    # paso final leería y escribiría el portfolios.json real.
    monkeypatch.setattr(portfolios_manager, "_PORTFOLIOS_DIR", portfolios)
    # routes/portfolios.py se lleva el nombre con `from … import`, así que
    # parchear solo el de admin dejaría la importación de carteras escribiendo
    # en el data/ real.
    monkeypatch.setattr(rutasPortfolios, "_PORTFOLIOS_DIR", portfolios)
    monkeypatch.setattr(portfolios_manager, "_META_FILE", data / "portfolios.json")
    monkeypatch.setattr(portfolios_manager, "_DELETED_DIR", data / "deleted")
    monkeypatch.setattr(portfolios_manager, "_LEGACY_DB", data / "portfolio.db")

    return {
        "data": data,
        "logs": logs,
        "backups": backups,
        "portfolios": portfolios,
        "json": jsonDir,
        "ajustes": jsonDir / "ajustes.json",
        "meta": data / "portfolios.json",
        "auth": data / "auth.dat",
        "claves": claves,
    }


@pytest.fixture
def crearApp(monkeypatch):
    """Fábrica de apps Flask con la capa de seguridad real instalada.

    Monta los mismos `before_request`/`after_request` que `server.py` —CSRF,
    tope de cuerpo, límite de escrituras, sesión y cabeceras— sobre una app
    mínima con los blueprints que pida cada test. Importar `server` no es una
    opción (ver la nota de arriba), y sin esto la capa que decide qué peticiones
    entran no la comprobaba nadie.
    """
    # Fija para que la sesión firmada sobreviva entre peticiones del mismo test
    # y para que el Fernet de auth.py sea determinista.
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")

    def _crear(*blueprints, **config):
        from flask import Flask

        from core import seguridad_app
        from core.errors import registerErrorHandlers

        app = Flask(__name__, static_folder=None)
        app.secret_key = "clave-de-pruebas-0123456789abcdef0123456789abcdef"
        app.config["TESTING"] = True
        # Mismo orden que server.py: el proxy envuelve la wsgi_app antes de que
        # nada mire request.remote_addr.
        seguridad_app.aplicarProxyInverso(app)
        seguridad_app.aplicarConfiguracionSesion(app)
        app.config.update(config)

        registerErrorHandlers(app)
        for blueprint in blueprints:
            app.register_blueprint(blueprint)

        limites = seguridad_app.instalar(app)
        app.extensions["limites_prueba"] = limites
        return app

    return _crear


# Token CSRF de los tests. Fijo y no aleatorio para que, cuando un caso falle
# con 403, se vea en el diff si el problema es el token o la sesión.
CSRF_PRUEBA = "token-csrf-de-pruebas"


@pytest.fixture
def clienteAutenticado(crearApp):
    """Devuelve `(client, cabeceras, app)` con sesión abierta y token CSRF válido.

    La sesión se escribe directamente con `session_transaction()` en vez de
    pasar por /login: eso exigiría credenciales reales en disco y convertiría
    cada test de rutas en un test de autenticación. Las cabeceras ya llevan el
    X-CSRF-Token, porque si no todos los POST recibirían 403 y estarían
    comprobando el CSRF una y otra vez en vez de lo que pretenden.

    El sellado de `core.sesion` (identificador y marcas de tiempo) se aplica
    igual que en el login real: sin él la sesión se rechaza por «versión
    anterior», que es justo lo que tiene que pasarle a una cookie sin marcas.
    """
    from core import sesion

    def _abrir(*blueprints, **config):
        app = crearApp(*blueprints, **config)
        client = app.test_client()
        with client.session_transaction() as sesionPrueba:
            sesionPrueba["logged_in"] = True
            sesionPrueba["csrf_token"] = CSRF_PRUEBA
            sesion.abrir(sesionPrueba)
        return client, {"X-CSRF-Token": CSRF_PRUEBA}, app

    return _abrir


@pytest.fixture
def errorApp():
    """App Flask mínima con la capa de errores instalada.

    Se construye a mano en vez de importar `server` para que estos tests
    verifiquen exclusivamente `errors.registerErrorHandlers` sin arrastrar la
    inicialización completa de la aplicación.
    """
    from flask import Flask

    from core.errors import registerErrorHandlers

    app = Flask(__name__)
    app.config["TESTING"] = True
    registerErrorHandlers(app)
    return app


class ClienteAtajo:
    """Fábrica de clientes de prueba que mandan el token del Atajo.

    Desde que los endpoints del Atajo exigen `X-Atajo-Token`, cada petición de
    estos tests tendría que llevarlo a mano. El cliente lo añade calculado con la
    clave vigente en ese momento (la de MOVIMIENTOS_SECRET_KEY del fixture),
    salvo que la petición traiga ya la cabecera: así los tests que comprueban el
    rechazo pueden mandar uno falso o vacío.
    """

    @staticmethod
    def instalar(app):
        from flask.testing import FlaskClient

        class _Cliente(FlaskClient):
            def open(self, *args, **kwargs):
                from core import firma_hmac

                cabeceras = dict(kwargs.pop("headers", None) or {})
                if not any(k.lower() == firma_hmac.CABECERA_TOKEN.lower() for k in cabeceras):
                    try:
                        cabeceras[firma_hmac.CABECERA_TOKEN] = firma_hmac.tokenDispositivo()
                    except firma_hmac.ErrorFirma:
                        pass  # sin clave: el test comprueba justo eso
                return super().open(*args, headers=cabeceras, **kwargs)

        app.test_client_class = _Cliente
        return app
