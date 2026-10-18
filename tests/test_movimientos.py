"""Pruebas de los endpoints del Atajo de iOS.

La app se construye a mano (Flask + blueprint) en lugar de importar `server`,
siguiendo la regla de conftest.py: importar `server` ejecutaría initPortfolios()
y escribiría sobre los datos reales de quien lance la suite.
"""

import hashlib
import hmac
import json
import time

import pytest

from tests.conftest import ClienteAtajo

CLAVE = "clave-de-prueba-0123456789abcdef"


@pytest.fixture
def movimientosApp(tempDb, monkeypatch):
    from flask import Flask

    from core.errors import registerErrorHandlers
    from routes.movimientos import movimientosBp

    # Overrides por entorno para que la suite no dependa del config.ini real
    # de la máquina donde se ejecuta.
    monkeypatch.setenv("MOVIMIENTOS_SECRET_KEY", CLAVE)
    monkeypatch.setenv("MOVIMIENTOS_REDES_PERMITIDAS", "192.168.1.0/24,10.0.0.0/24")
    monkeypatch.setenv("MOVIMIENTOS_ACTIVADO", "true")

    app = Flask(__name__)
    app.config["TESTING"] = True
    registerErrorHandlers(app)
    app.register_blueprint(movimientosBp)
    return ClienteAtajo.instalar(app)


def _firmar(timestamp, cuerpo, clave=CLAVE):
    mensaje = f"{timestamp}.".encode() + cuerpo
    return hmac.new(clave.encode(), mensaje, hashlib.sha256).hexdigest()


def _enviar(client, payload, ip="192.168.1.50", timestamp=None, firma=None, clave=CLAVE):
    cuerpo = json.dumps(payload).encode()
    ts = int(time.time()) if timestamp is None else timestamp
    return client.post(
        "/api/movimiento",
        data=cuerpo,
        content_type="application/json",
        headers={"X-Timestamp": str(ts), "X-Signature": firma or _firmar(ts, cuerpo, clave)},
        environ_base={"REMOTE_ADDR": ip},
    )


# ── Filtro de IP ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("ip", ["192.168.1.20", "10.0.0.7", "::ffff:192.168.1.20"])
def testIpPermitidaEntra(movimientosApp, ip):
    client = movimientosApp.test_client()
    respuesta = client.get("/api/categorias", environ_base={"REMOTE_ADDR": ip})
    assert respuesta.status_code == 200


@pytest.mark.parametrize("ip", ["8.8.8.8", "192.168.2.10", "127.0.0.1"])
def testIpExternaRechazada(movimientosApp, ip):
    client = movimientosApp.test_client()
    respuesta = client.get("/api/categorias", environ_base={"REMOTE_ADDR": ip})
    assert respuesta.status_code == 403


def testEl403DiceConQueIpTeVeElServidor(movimientosApp):
    """Permite configurar redes_permitidas desde el móvil, sin leer logs."""
    client = movimientosApp.test_client()
    datos = client.get("/api/categorias", environ_base={"REMOTE_ADDR": "10.6.0.2"}).get_json()

    assert datos["ip"] == "10.6.0.2"
    # Los rangos permitidos no se filtran nunca.
    assert "192.168" not in str(datos)


def testElRechazoQuedaApuntadoParaElPanel(movimientosApp):
    """Ajustes enseña las IPs rechazadas con un botón de permitirlas: es lo que
    hace falta cuando el móvil llega desde otra subred de la misma wifi."""
    from core import red_local

    red_local.olvidarRechazos()
    client = movimientosApp.test_client()
    client.get("/api/portfolios-lista", environ_base={"REMOTE_ADDR": "172.16.1.10"})
    client.get("/api/categorias", environ_base={"REMOTE_ADDR": "172.16.1.10"})
    client.get("/api/categorias", environ_base={"REMOTE_ADDR": "8.8.8.8"})

    filas = red_local.rechazosRecientes()

    # Una fila por IP, la más reciente primero, con cuántas veces ha llamado.
    assert [f["ip"] for f in filas] == ["8.8.8.8", "172.16.1.10"]
    assert filas[1]["veces"] == 2
    assert filas[1]["ruta"] == "/api/categorias"
    assert filas[1]["permitida"] is False


def testUnaIpRechazadaPasaAPermitidaAlAmpliarLasRedes(movimientosApp, monkeypatch):
    """`permitida` se calcula al consultar, no al rechazar: tras añadir el rango
    la fila cambia sin esperar a que el móvil vuelva a llamar."""
    from core import red_local

    red_local.olvidarRechazos()
    client = movimientosApp.test_client()
    client.get("/api/categorias", environ_base={"REMOTE_ADDR": "172.16.1.10"})
    assert red_local.rechazosRecientes()[0]["permitida"] is False

    monkeypatch.setenv("MOVIMIENTOS_REDES_PERMITIDAS", "192.168.1.0/24,172.16.1.0/24")
    assert red_local.rechazosRecientes()[0]["permitida"] is True


def testLasIpsPermitidasNoSeApuntan(movimientosApp):
    from core import red_local

    red_local.olvidarRechazos()
    client = movimientosApp.test_client()
    client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.20"})
    assert red_local.rechazosRecientes() == []


def testDeFabricaSeAceptanLasTresRedesPrivadas(movimientosApp, configAtajo, monkeypatch):
    """Una wifi con varias subredes (invitados, un punto de acceso con su propio
    DHCP, un router que reparte 172.16.x) no debe dejar al móvil fuera sin
    haber tocado nada. Ninguno de esos rangos se alcanza desde Internet."""
    monkeypatch.delenv("MOVIMIENTOS_REDES_PERMITIDAS", raising=False)
    configAtajo("activado = true")

    client = movimientosApp.test_client()
    for ip in ["192.168.1.9", "192.168.50.9", "10.6.0.2", "172.16.1.10", "172.31.255.1"]:
        assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": ip}).status_code == 200, ip
    for ip in ["8.8.8.8", "172.32.0.1", "127.0.0.1"]:
        assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": ip}).status_code == 403, ip


def testIpSeCompruebaAntesQueLaFirma(movimientosApp):
    """Una IP externa no debe poder ni siquiera sondear si su firma es válida."""
    client = movimientosApp.test_client()
    respuesta = _enviar(client, {"tipo": "gasto", "nombre": "x", "importe": 1}, ip="8.8.8.8")
    assert respuesta.status_code == 403


def testRedesConfigurablesPorEntorno(movimientosApp, monkeypatch):
    monkeypatch.setenv("MOVIMIENTOS_REDES_PERMITIDAS", "172.16.0.0/24")
    client = movimientosApp.test_client()
    assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": "172.16.0.9"}).status_code == 200
    assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.9"}).status_code == 403


def testRangosInvalidosNoAbrenLaPuerta(movimientosApp, monkeypatch):
    monkeypatch.setenv("MOVIMIENTOS_REDES_PERMITIDAS", "esto-no-es-un-cidr")
    client = movimientosApp.test_client()
    respuesta = client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.9"})
    assert respuesta.status_code == 403


# ── Configuración desde config.ini ───────────────────────────────────────────

@pytest.fixture
def configAtajo(tmp_path, monkeypatch):
    """Sustituye config.ini por uno de prueba con la sección [atajo]."""
    from core import config_ini

    def escribir(cuerpo):
        ruta = tmp_path / "config.ini"
        ruta.write_text(f"[atajo]\n{cuerpo}\n", encoding="utf-8")
        monkeypatch.setattr(config_ini, "RUTA_CONFIG", ruta)
        config_ini.invalidarCache()
        return ruta

    yield escribir
    config_ini.invalidarCache()


def testRedesSalenDeConfigIni(movimientosApp, configAtajo, monkeypatch):
    monkeypatch.delenv("MOVIMIENTOS_REDES_PERMITIDAS", raising=False)
    configAtajo("redes_permitidas = 172.16.5.0/24")

    client = movimientosApp.test_client()
    assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": "172.16.5.9"}).status_code == 200
    assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.9"}).status_code == 403


def testEntornoTienePrioridadSobreConfigIni(movimientosApp, configAtajo):
    """El override por entorno existe para ajustes puntuales sin tocar el .ini."""
    configAtajo("redes_permitidas = 172.16.5.0/24")

    client = movimientosApp.test_client()
    # La fixture deja MOVIMIENTOS_REDES_PERMITIDAS con la 192.168.1.0/24.
    assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.9"}).status_code == 200
    assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": "172.16.5.9"}).status_code == 403


def testDesactivadoResponde404(movimientosApp, configAtajo, monkeypatch):
    monkeypatch.delenv("MOVIMIENTOS_ACTIVADO", raising=False)
    configAtajo("activado = false\nredes_permitidas = 192.168.1.0/24")

    client = movimientosApp.test_client()
    assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.9"}).status_code == 404
    assert _enviar(client, {"tipo": "gasto", "nombre": "x", "importe": 1}).status_code == 404


def testToleranciaSaleDeConfigIni(movimientosApp, configAtajo, monkeypatch):
    monkeypatch.delenv("MOVIMIENTOS_TOLERANCIA_SEGUNDOS", raising=False)
    configAtajo("redes_permitidas = 192.168.1.0/24\ntolerancia_segundos = 600")

    client = movimientosApp.test_client()
    # 120 s de desfase: rechazado con la tolerancia por defecto de 60, aceptado
    # con la de 600 que declara este config.ini.
    respuesta = _enviar(
        client,
        {"tipo": "gasto", "nombre": "Metro", "importe": 1},
        timestamp=int(time.time()) - 120,
    )
    assert respuesta.status_code == 201


def testConfigIniAusenteUsaLosValoresPorDefecto(movimientosApp, tmp_path, monkeypatch):
    """Sin config.ini la app arranca igual, con los rangos de último recurso."""
    from core import config_ini

    monkeypatch.delenv("MOVIMIENTOS_REDES_PERMITIDAS", raising=False)
    monkeypatch.setattr(config_ini, "RUTA_CONFIG", tmp_path / "no-existe.ini")
    config_ini.invalidarCache()

    try:
        client = movimientosApp.test_client()
        assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.9"}).status_code == 200
        assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": "8.8.8.8"}).status_code == 403
    finally:
        config_ini.invalidarCache()


def testClaveLeidaDelFicheroConfigurado(movimientosApp, tmp_path, monkeypatch):
    """Sin variable de entorno, la clave sale del fichero de [atajo] fichero_clave."""
    from core.secret_store import writeSecretLines

    ruta = tmp_path / "movimientos.key"
    writeSecretLines(ruta, ["clave-desde-fichero"])

    monkeypatch.delenv("MOVIMIENTOS_SECRET_KEY", raising=False)
    monkeypatch.setattr("core.firma_hmac.rutaFicheroClave", lambda: ruta)

    client = movimientosApp.test_client()
    respuesta = _enviar(
        client,
        {"tipo": "gasto", "nombre": "Metro", "importe": 1},
        clave="clave-desde-fichero",
    )
    assert respuesta.status_code == 201


def testSinClaveNiEnEntornoNiEnFichero503(movimientosApp, tmp_path, monkeypatch):
    monkeypatch.delenv("MOVIMIENTOS_SECRET_KEY", raising=False)
    monkeypatch.setattr("core.firma_hmac.rutaFicheroClave", lambda: tmp_path / "no-existe.key")

    client = movimientosApp.test_client()
    assert _enviar(client, {"tipo": "gasto", "nombre": "x", "importe": 1}).status_code == 503


# ── Firma HMAC ───────────────────────────────────────────────────────────────

def testFirmaValidaCreaElMovimiento(movimientosApp):
    client = movimientosApp.test_client()
    respuesta = _enviar(client, {
        "tipo": "gasto", "categoria": "Transporte", "nombre": "Metro",
        "importe": 12.5, "fecha": "2026-03-04",
    })

    assert respuesta.status_code == 201
    movimiento = respuesta.get_json()["movimiento"]
    assert movimiento["year"] == "2026"
    assert movimiento["month"] == "marzo"
    assert movimiento["cantidad"] == "12,50 €"


def testSinFirma401(movimientosApp):
    client = movimientosApp.test_client()
    respuesta = client.post(
        "/api/movimiento",
        data=b"{}",
        content_type="application/json",
        headers={"X-Timestamp": str(int(time.time()))},
        environ_base={"REMOTE_ADDR": "192.168.1.50"},
    )
    assert respuesta.status_code == 401


def testFirmaIncorrecta401(movimientosApp):
    client = movimientosApp.test_client()
    respuesta = _enviar(client, {"tipo": "gasto", "nombre": "Metro", "importe": 1}, firma="00" * 32)
    assert respuesta.status_code == 401


def testFirmaConOtraClave401(movimientosApp):
    client = movimientosApp.test_client()
    respuesta = _enviar(client, {"tipo": "gasto", "nombre": "Metro", "importe": 1}, clave="otra-clave")
    assert respuesta.status_code == 401


def testCuerpoAlteradoTrasFirmar401(movimientosApp):
    """La firma cubre el cuerpo: cambiar el importe la invalida."""
    client = movimientosApp.test_client()
    original = json.dumps({"tipo": "gasto", "nombre": "Metro", "importe": 1}).encode()
    manipulado = json.dumps({"tipo": "gasto", "nombre": "Metro", "importe": 9999}).encode()
    ts = int(time.time())

    respuesta = client.post(
        "/api/movimiento",
        data=manipulado,
        content_type="application/json",
        headers={"X-Timestamp": str(ts), "X-Signature": _firmar(ts, original)},
        environ_base={"REMOTE_ADDR": "192.168.1.50"},
    )
    assert respuesta.status_code == 401


@pytest.mark.parametrize("desfase", [-120, 120])
def testTimestampFueraDeVentana401(movimientosApp, desfase):
    client = movimientosApp.test_client()
    respuesta = _enviar(
        client,
        {"tipo": "gasto", "nombre": "Metro", "importe": 1},
        timestamp=int(time.time()) + desfase,
    )
    assert respuesta.status_code == 401


def testSinClaveConfigurada503(movimientosApp, monkeypatch):
    monkeypatch.delenv("MOVIMIENTOS_SECRET_KEY", raising=False)
    client = movimientosApp.test_client()
    respuesta = _enviar(client, {"tipo": "gasto", "nombre": "Metro", "importe": 1})
    assert respuesta.status_code == 503


# ── Validación del payload ───────────────────────────────────────────────────

@pytest.mark.parametrize("payload", [
    {"tipo": "transferencia", "nombre": "x", "importe": 1},
    {"tipo": "gasto", "nombre": "x", "importe": "no-es-un-numero"},
    {"tipo": "gasto", "nombre": "x", "importe": 0},
    {"tipo": "gasto", "nombre": "x", "importe": -5},
    {"tipo": "gasto", "nombre": "x", "importe": 5, "fecha": "2026/03/04"},
    {"tipo": "gasto", "nombre": "x", "importe": 5, "fecha": "32-03-2026"},
])
def testPayloadsInvalidos400(movimientosApp, payload):
    client = movimientosApp.test_client()
    assert _enviar(client, payload).status_code == 400


@pytest.mark.parametrize(("fecha", "esperado"), [
    ("2026-08-09", "2026-08-09"),   # ISO
    ("09-08-2026", "2026-08-09"),   # formato español, el de la web y el del Atajo
    ("31-12-2025", "2025-12-31"),
])
def testAceptaLasDosFormasDeEscribirLaFecha(movimientosApp, fecha, esperado):
    client = movimientosApp.test_client()
    respuesta = _enviar(client, {
        "tipo": "gasto", "categoria": "Otros", "nombre": "Prueba",
        "importe": 1, "fecha": fecha,
    })

    assert respuesta.status_code == 201
    assert respuesta.get_json()["movimiento"]["fecha"] == esperado


def testLaFechaEspanolaTambienCaeEnSuMes(movimientosApp):
    """09-08-2026 es el 9 de agosto, no el 8 de septiembre."""
    client = movimientosApp.test_client()
    creado = _enviar(client, {
        "tipo": "gasto", "nombre": "Prueba", "importe": 1, "fecha": "09-08-2026",
    }).get_json()["movimiento"]

    assert (creado["year"], creado["month"]) == ("2026", "agosto")


def testImporteConComaDecimal(movimientosApp):
    client = movimientosApp.test_client()
    respuesta = _enviar(client, {
        "tipo": "ingreso", "categoria": "Nómina", "nombre": "Sueldo",
        "importe": "1234,56", "fecha": "2026-01-15",
    })
    assert respuesta.status_code == 201
    assert respuesta.get_json()["movimiento"]["cantidad"] == "1.234,56 €"


@pytest.mark.parametrize(("fecha", "year", "month"), [
    ("2026-01-31", "2026", "enero"),
    ("2026-02-01", "2026", "febrero"),
    ("2026-03-15", "2026", "marzo"),
    ("2026-04-30", "2026", "abril"),
    ("2026-05-01", "2026", "mayo"),
    ("2026-06-10", "2026", "junio"),
    ("2026-07-04", "2026", "julio"),
    ("2026-08-09", "2026", "agosto"),
    ("2026-09-30", "2026", "septiembre"),
    ("2026-10-01", "2026", "octubre"),
    ("2026-11-11", "2026", "noviembre"),
    ("2026-12-25", "2026", "diciembre"),
    ("2025-12-31", "2025", "diciembre"),
])
def testLaFechaDecideElMesYElAnio(movimientosApp, fecha, year, month):
    """El Atajo no pregunta el mes: lo deduce el servidor de la fecha."""
    client = movimientosApp.test_client()
    respuesta = _enviar(client, {
        "tipo": "gasto", "categoria": "Otros", "nombre": "Prueba",
        "importe": 1, "fecha": fecha,
    })

    assert respuesta.status_code == 201
    creado = respuesta.get_json()["movimiento"]
    assert (creado["year"], creado["month"]) == (year, month)


def testLaFilaGuardadaCaeEnElMesCorrecto(movimientosApp):
    """09-08-2026 tiene que acabar en agosto de 2026, no en otro sitio."""
    from stores.gastos_store import readGastosYear

    client = movimientosApp.test_client()
    _enviar(client, {
        "tipo": "gasto", "categoria": "Gasoil", "nombre": "Repostaje",
        "importe": 60, "fecha": "2026-08-09",
    })

    with movimientosApp.app_context():
        datos = readGastosYear("2026")

    assert datos["months"]["agosto"]["rows"] == [
        {"fecha": "09-08-2026", "nombre": "Repostaje", "tipo": "Gasoil", "cantidad": "60,00 €", "nota": "", "cuenta": ""}
    ]
    # Y ningún otro mes se ha llevado la fila.
    otros = [mes for mes, datosMes in datos["months"].items() if mes != "agosto" and datosMes["rows"]]
    assert otros == []


def testFechaAusenteUsaHoy(movimientosApp):
    from datetime import date

    client = movimientosApp.test_client()
    respuesta = _enviar(client, {"tipo": "gasto", "nombre": "Café", "importe": 2})
    assert respuesta.status_code == 201
    assert respuesta.get_json()["movimiento"]["fecha"] == date.today().isoformat()


# ── Integración con las tablas de la web app ─────────────────────────────────

def testGastoVisibleParaLaWebApp(movimientosApp):
    from stores.gastos_store import readGastosYear

    client = movimientosApp.test_client()
    _enviar(client, {
        "tipo": "gasto", "categoria": "Alquiler", "nombre": "Piso",
        "importe": 800, "fecha": "2026-05-01",
    })

    with movimientosApp.app_context():
        datos = readGastosYear("2026")

    assert datos is not None
    filas = datos["months"]["mayo"]["rows"]
    assert filas == [
        {"fecha": "01-05-2026", "nombre": "Piso", "tipo": "Alquiler", "cantidad": "800,00 €", "nota": "", "cuenta": ""}
    ]
    assert "Alquiler" in datos["gastosTipos"]


def testIngresoVisibleParaLaWebApp(movimientosApp):
    from stores.ingresos_store import readIngresosYear

    client = movimientosApp.test_client()
    _enviar(client, {
        "tipo": "ingreso", "categoria": "Dividendos", "nombre": "VWCE",
        "importe": 42.1, "fecha": "2026-07-20",
    })

    with movimientosApp.app_context():
        datos = readIngresosYear("2026")

    assert datos is not None
    filas = datos["months"]["julio"]["rows"]
    assert filas == [
        {"fecha": "20-07-2026", "nombre": "VWCE", "tipo": "Dividendos", "cantidad": "42,10 €", "nota": "", "cuenta": ""}
    ]


# ── Selección de portfolio (base de datos) ───────────────────────────────────

@pytest.fixture
def portfolios(tmp_path, monkeypatch):
    """Dos portfolios con .db propios, sin tocar los del usuario.

    Hay que parchear también `routes.movimientos`: ese módulo importa
    `getPortfolios` por nombre, así que sustituirlo solo en
    `portfolios_manager` no le afecta y acabaría leyendo el portfolios.json
    real de quien ejecute la suite.
    """
    from admin import portfolios_manager
    from core.db import initDbAtPath
    from routes import movimientos as rutas

    directorio = tmp_path / "portfolios"
    directorio.mkdir()

    for pid in ("principal", "test2"):
        initDbAtPath(directorio / f"{pid}.db")

    meta = {
        "active": "principal",
        "portfolios": [
            {"id": "principal", "name": "Principal"},
            {"id": "test2", "name": "Test2"},
        ],
    }

    monkeypatch.setattr(portfolios_manager, "_PORTFOLIOS_DIR", directorio)
    monkeypatch.setattr(portfolios_manager, "getPortfolios", lambda: meta)
    monkeypatch.setattr(rutas, "getPortfolios", lambda: meta)
    monkeypatch.setattr(rutas, "getActivePortfolioId", lambda: meta.get("active"))

    return directorio


def testListaDePortfolios(movimientosApp, portfolios):
    """El Atajo tampoco lleva los portfolios escritos: los pide al servidor."""
    client = movimientosApp.test_client()
    datos = client.get("/api/portfolios-lista", environ_base={"REMOTE_ADDR": "192.168.1.50"}).get_json()

    assert datos["activo"] == "principal"
    assert datos["portfolios"] == [
        {"id": "principal", "nombre": "Principal", "activo": True},
        {"id": "test2", "nombre": "Test2", "activo": False},
    ]


def testListaDePortfoliosTraeNombresPlanos(movimientosApp, portfolios):
    """Atajos no sabe pintar diccionarios: necesita la lista de nombres suelta."""
    client = movimientosApp.test_client()
    datos = client.get("/api/portfolios-lista", environ_base={"REMOTE_ADDR": "192.168.1.50"}).get_json()

    assert datos["nombres"] == ["Principal", "Test2"]
    assert datos["idPorNombre"] == {"Principal": "principal", "Test2": "test2"}


def testNombresRepetidosNoSePisan(movimientosApp, monkeypatch, portfolios):
    from routes import movimientos as rutas

    monkeypatch.setattr(rutas, "getPortfolios", lambda: {
        "active": "casa",
        "portfolios": [{"id": "casa", "name": "Casa"}, {"id": "casa_2", "name": "Casa"}],
    })

    client = movimientosApp.test_client()
    datos = client.get("/api/portfolios-lista", environ_base={"REMOTE_ADDR": "192.168.1.50"}).get_json()

    assert datos["nombres"] == ["Casa", "Casa (casa_2)"]
    assert datos["idPorNombre"]["Casa"] == "casa"
    assert datos["idPorNombre"]["Casa (casa_2)"] == "casa_2"


def testListaDePortfoliosRechazaIpExterna(movimientosApp, portfolios):
    client = movimientosApp.test_client()
    assert client.get("/api/portfolios-lista", environ_base={"REMOTE_ADDR": "8.8.8.8"}).status_code == 403


def testMovimientoVaAlPortfolioIndicado(movimientosApp, portfolios):
    """Lo escrito en test2 acaba en test2.db, no en la base de datos activa."""
    import sqlite3

    client = movimientosApp.test_client()
    respuesta = _enviar(client, {
        "tipo": "gasto", "categoria": "Alquiler", "nombre": "Piso",
        "importe": 800, "fecha": "2026-05-01", "portfolio": "test2",
    })

    assert respuesta.status_code == 201
    assert respuesta.get_json()["movimiento"]["portfolio"] == "test2"

    conn = sqlite3.connect(str(portfolios / "test2.db"))
    filas = conn.execute("SELECT nombre, tipo, cantidad FROM gastos_rows").fetchall()
    conn.close()
    assert filas == [("Piso", "Alquiler", "800,00 €")]

    # Y el otro portfolio se ha quedado intacto.
    otro = sqlite3.connect(str(portfolios / "principal.db"))
    assert otro.execute("SELECT COUNT(*) FROM gastos_rows").fetchone()[0] == 0
    otro.close()


def testPortfolioNoCambiaLaBdActivaDelProceso(movimientosApp, portfolios, tempDb):
    """Escribir en otro portfolio no puede robarle la BD a la sesión web."""
    from core.db import getActiveDbPath

    antes = getActiveDbPath()
    client = movimientosApp.test_client()
    _enviar(client, {"tipo": "gasto", "nombre": "Piso", "importe": 800, "portfolio": "test2"})

    assert getActiveDbPath() == antes


def testCategoriasDeUnPortfolioConcreto(movimientosApp, portfolios):
    client = movimientosApp.test_client()
    _enviar(client, {"tipo": "gasto", "categoria": "Solo-Test2", "nombre": "x", "importe": 1, "portfolio": "test2"})

    deTest2 = client.get("/api/categorias?portfolio=test2", environ_base={"REMOTE_ADDR": "192.168.1.50"}).get_json()
    dePrincipal = client.get("/api/categorias?portfolio=principal", environ_base={"REMOTE_ADDR": "192.168.1.50"}).get_json()

    assert "Solo-Test2" in deTest2["categorias"]["gasto"]
    assert "Solo-Test2" not in dePrincipal["categorias"]["gasto"]


def testPortfolioSePuedeIndicarPorNombre(movimientosApp, portfolios):
    """Le ahorra al Atajo traducir nombre→id, que era su parte más frágil."""
    import sqlite3

    client = movimientosApp.test_client()
    respuesta = _enviar(client, {
        "tipo": "gasto", "nombre": "Piso", "importe": 800, "portfolio": "Test2",
    })

    assert respuesta.status_code == 201
    conn = sqlite3.connect(str(portfolios / "test2.db"))
    assert conn.execute("SELECT COUNT(*) FROM gastos_rows").fetchone()[0] == 1
    conn.close()


def testNombreDePortfolioSinDistinguirMayusculas(movimientosApp, portfolios):
    client = movimientosApp.test_client()
    datos = client.get("/api/categorias?portfolio=principal", environ_base={"REMOTE_ADDR": "192.168.1.50"})
    otro = client.get("/api/categorias?portfolio=PRINCIPAL", environ_base={"REMOTE_ADDR": "192.168.1.50"})

    assert datos.status_code == 200
    assert otro.status_code == 200


def testElIdGanaAlNombre(movimientosApp, monkeypatch, portfolios):
    """Si un portfolio se llama como el id de otro, el id manda."""
    from admin import portfolios_manager
    from routes import movimientos as rutas

    meta = {
        "active": "principal",
        "portfolios": [
            {"id": "principal", "name": "Test2"},
            {"id": "test2", "name": "Otro"},
        ],
    }
    monkeypatch.setattr(portfolios_manager, "getPortfolios", lambda: meta)
    monkeypatch.setattr(rutas, "getPortfolios", lambda: meta)

    assert portfolios_manager.findPortfolioId("test2") == "test2"


def testPortfolioInexistenteDa404(movimientosApp, portfolios):
    client = movimientosApp.test_client()
    respuesta = _enviar(client, {"tipo": "gasto", "nombre": "x", "importe": 1, "portfolio": "no-existe"})

    assert respuesta.status_code == 404


def testPortfolioConTraversalDa404(movimientosApp, portfolios):
    """Un id no puede escaparse del directorio de portfolios."""
    client = movimientosApp.test_client()
    respuesta = _enviar(client, {"tipo": "gasto", "nombre": "x", "importe": 1, "portfolio": "../portfolio"})

    assert respuesta.status_code == 404


def testSinPortfolioUsaElActivo(movimientosApp, tempDb):
    """Un Atajo antiguo que no manda el campo sigue funcionando igual."""
    from stores.gastos_store import readGastosYear

    client = movimientosApp.test_client()
    respuesta = _enviar(client, {
        "tipo": "gasto", "categoria": "Coche", "nombre": "Taller",
        "importe": 90, "fecha": "2026-04-01",
    })

    assert respuesta.status_code == 201
    with movimientosApp.app_context():
        assert readGastosYear("2026")["months"]["abril"]["rows"][0]["nombre"] == "Taller"


def testElPortfolioVaFirmado(movimientosApp, portfolios):
    """Cambiar el portfolio tras firmar invalida la petición."""
    import json as _json

    client = movimientosApp.test_client()
    original = _json.dumps({"tipo": "gasto", "nombre": "x", "importe": 1, "portfolio": "principal"}).encode()
    manipulado = _json.dumps({"tipo": "gasto", "nombre": "x", "importe": 1, "portfolio": "test2"}).encode()
    ts = int(time.time())

    respuesta = client.post(
        "/api/movimiento",
        data=manipulado,
        content_type="application/json",
        headers={"X-Timestamp": str(ts), "X-Signature": _firmar(ts, original)},
        environ_base={"REMOTE_ADDR": "192.168.1.50"},
    )
    assert respuesta.status_code == 401


# ── Categorías ───────────────────────────────────────────────────────────────

def testCategoriasSalenDeLaBaseDeDatos(movimientosApp):
    from stores.gastos_store import writeGastosTypes
    from stores.ingresos_store import writeIngresosTypes

    with movimientosApp.app_context():
        writeGastosTypes(["Transporte", "Alquiler"])
        writeIngresosTypes(["Nómina"])

    client = movimientosApp.test_client()
    datos = client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.50"}).get_json()

    assert datos["categorias"]["gasto"] == ["Alquiler", "Transporte"]
    assert datos["categorias"]["ingreso"] == ["Nómina"]
    assert datos["todas"] == ["Alquiler", "Nómina", "Transporte"]


def testCategoriasFiltradasPorTipo(movimientosApp):
    """`lista` evita que el Atajo tenga que usar una variable como clave."""
    from stores.gastos_store import writeGastosTypes
    from stores.ingresos_store import writeIngresosTypes

    with movimientosApp.app_context():
        writeGastosTypes(["Transporte", "Alquiler"])
        writeIngresosTypes(["Nómina"])

    client = movimientosApp.test_client()
    datos = client.get(
        "/api/categorias?tipo=gasto", environ_base={"REMOTE_ADDR": "192.168.1.50"}
    ).get_json()

    assert datos["tipo"] == "gasto"
    assert datos["lista"] == ["Alquiler", "Transporte"]
    # Lo anterior se mantiene, para no romper un Atajo ya montado.
    assert datos["categorias"]["ingreso"] == ["Nómina"]


def testSinTipoNoHayLista(movimientosApp):
    client = movimientosApp.test_client()
    datos = client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.50"}).get_json()

    assert "lista" not in datos


@pytest.mark.parametrize("tipo", ["gastos", "Gasto ", "cualquiera"])
def testTipoInvalidoDa400EnVezDeListaVacia(movimientosApp, tipo):
    """Una lista vacía haría que el Atajo se saltara el paso en silencio."""
    client = movimientosApp.test_client()
    respuesta = client.get(
        f"/api/categorias?tipo={tipo}", environ_base={"REMOTE_ADDR": "192.168.1.50"}
    )

    if tipo.strip().lower() in ("gasto", "ingreso"):
        assert respuesta.status_code == 200
    else:
        assert respuesta.status_code == 400


def testCategoriaNuevaDelAtajoApareceEnCategorias(movimientosApp):
    client = movimientosApp.test_client()
    _enviar(client, {"tipo": "gasto", "categoria": "Farmacia", "nombre": "Ibuprofeno", "importe": 4})

    datos = client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.50"}).get_json()
    assert "Farmacia" in datos["categorias"]["gasto"]


# ── /api/preparar (el Atajo no escribe JSON a mano) ──────────────────────────

def _preparar(client, campos, ip="192.168.1.50"):
    return client.post("/api/preparar", json=campos, environ_base={"REMOTE_ADDR": ip})


def testPrepararDevuelveUnCuerpoQueMovimientoAcepta(movimientosApp):
    """El circuito completo sin construir JSON en el cliente."""
    client = movimientosApp.test_client()
    preparado = _preparar(client, {
        "tipo": "gasto", "categoria": "Transporte", "nombre": "Metro",
        "importe": "12,50", "fecha": "2026-03-04",
    }).get_json()

    respuesta = client.post(
        "/api/movimiento",
        data=preparado["cuerpo"].encode(),
        content_type="application/json",
        headers={"X-Timestamp": preparado["timestamp"], "X-Signature": preparado["firma"]},
        environ_base={"REMOTE_ADDR": "192.168.1.50"},
    )

    assert respuesta.status_code == 201
    assert respuesta.get_json()["movimiento"]["cantidad"] == "12,50 €"


def testPrepararAdmiteComillasEnElConcepto(movimientosApp):
    """Lo que era imposible con el JSON escrito a mano en el Atajo."""
    client = movimientosApp.test_client()
    nombre = 'Bar "El Rincón" \\ y más'
    preparado = _preparar(client, {"tipo": "gasto", "nombre": nombre, "importe": 3}).get_json()

    respuesta = client.post(
        "/api/movimiento",
        data=preparado["cuerpo"].encode(),
        content_type="application/json",
        headers={"X-Timestamp": preparado["timestamp"], "X-Signature": preparado["firma"]},
        environ_base={"REMOTE_ADDR": "192.168.1.50"},
    )

    assert respuesta.status_code == 201
    assert respuesta.get_json()["movimiento"]["nombre"] == nombre


def testPrepararGeneraCuerpoAscii(movimientosApp):
    """ASCII puro: descarta cualquier discrepancia de codificación en tránsito."""
    client = movimientosApp.test_client()
    preparado = _preparar(client, {
        "tipo": "gasto", "categoria": "Café", "nombre": "Nómina", "importe": 1,
    }).get_json()

    preparado["cuerpo"].encode("ascii")  # no debe lanzar
    assert "\\u00e9" in preparado["cuerpo"]


def testPrepararDescartaCamposDesconocidos(movimientosApp):
    client = movimientosApp.test_client()
    preparado = _preparar(client, {
        "tipo": "gasto", "nombre": "Metro", "importe": 1, "colado": "no deberia estar",
    }).get_json()

    assert "colado" not in preparado["cuerpo"]


@pytest.mark.parametrize("campos", [
    {"tipo": "transferencia", "nombre": "x", "importe": 1},
    {"tipo": "gasto", "nombre": "x", "importe": -3},
    {"tipo": "gasto", "nombre": "x", "importe": 1, "fecha": "2026/03/04"},
])
def testPrepararValidaAntesDeFirmar(movimientosApp, campos):
    client = movimientosApp.test_client()
    assert _preparar(client, campos).status_code == 400


def testPrepararRechazaPortfolioInexistente(movimientosApp, portfolios):
    client = movimientosApp.test_client()
    respuesta = _preparar(client, {
        "tipo": "gasto", "nombre": "x", "importe": 1, "portfolio": "no-existe",
    })
    assert respuesta.status_code == 404


def testPrepararRechazaIpExterna(movimientosApp):
    client = movimientosApp.test_client()
    assert _preparar(client, {"tipo": "gasto", "nombre": "x", "importe": 1}, ip="8.8.8.8").status_code == 403


def testPrepararSinClaveDa503(movimientosApp, monkeypatch):
    monkeypatch.delenv("MOVIMIENTOS_SECRET_KEY", raising=False)
    client = movimientosApp.test_client()
    assert _preparar(client, {"tipo": "gasto", "nombre": "x", "importe": 1}).status_code == 503


# ── /api/firmar ──────────────────────────────────────────────────────────────

def testFirmarDevuelveUnaFirmaUtilizable(movimientosApp):
    client = movimientosApp.test_client()
    cuerpo = json.dumps({"tipo": "gasto", "nombre": "Metro", "importe": 2}).encode()
    ts = int(time.time())

    firmado = client.post(
        "/api/firmar",
        json={"texto": f"{ts}.{cuerpo.decode()}"},
        environ_base={"REMOTE_ADDR": "192.168.1.50"},
    ).get_json()

    respuesta = client.post(
        "/api/movimiento",
        data=cuerpo,
        content_type="application/json",
        headers={"X-Timestamp": str(ts), "X-Signature": firmado["firma"]},
        environ_base={"REMOTE_ADDR": "192.168.1.50"},
    )
    assert respuesta.status_code == 201


def testFirmarConCuerpoPoneElTimestampDelServidor(movimientosApp):
    """Modo que usa el Atajo: no necesita saber la hora ni calcular epochs."""
    client = movimientosApp.test_client()
    cuerpo = json.dumps({"tipo": "gasto", "nombre": "Metro", "importe": 2}).encode()

    firmado = client.post(
        "/api/firmar",
        json={"cuerpo": cuerpo.decode()},
        environ_base={"REMOTE_ADDR": "192.168.1.50"},
    ).get_json()

    assert abs(int(firmado["timestamp"]) - int(time.time())) <= 5

    respuesta = client.post(
        "/api/movimiento",
        data=cuerpo,
        content_type="application/json",
        headers={"X-Timestamp": firmado["timestamp"], "X-Signature": firmado["firma"]},
        environ_base={"REMOTE_ADDR": "192.168.1.50"},
    )
    assert respuesta.status_code == 201


def testFirmarRechazaIpExterna(movimientosApp):
    client = movimientosApp.test_client()
    respuesta = client.post("/api/firmar", json={"texto": "hola"}, environ_base={"REMOTE_ADDR": "8.8.8.8"})
    assert respuesta.status_code == 403


def testFirmarExigeTextoOCuerpo(movimientosApp):
    client = movimientosApp.test_client()
    respuesta = client.post("/api/firmar", json={}, environ_base={"REMOTE_ADDR": "192.168.1.50"})
    assert respuesta.status_code == 400


def testFirmarConTextoNoDevuelveTimestamp(movimientosApp):
    """El modo 'texto' firma literal: el timestamp ya lo eligió el cliente."""
    client = movimientosApp.test_client()
    datos = client.post(
        "/api/firmar",
        json={"texto": "123.{}"},
        environ_base={"REMOTE_ADDR": "192.168.1.50"},
    ).get_json()

    assert datos["firma"] == _firmar(123, b"{}")
    assert "timestamp" not in datos


# ── Sin firma, cuando se pide desde Ajustes ──────────────────────────────────
# La firma se puede quitar (Ajustes > API): a veces la alternativa real no es
# «con firma o sin firma», es «con firma o sin Atajo» —una clave perdida en una
# reinstalación deja al iPhone sin poder apuntar nada—. Lo que no se puede es
# que al quitarla se caiga también la otra barrera.

@pytest.fixture
def sinFirma(tmp_path, monkeypatch):
    from core import atajo_acceso

    destino = tmp_path / "atajo"
    monkeypatch.setattr(atajo_acceso, "ATAJO_DIR", destino, raising=False)
    monkeypatch.setattr(atajo_acceso, "ACCESO_FILE", destino / "acceso.json", raising=False)
    atajo_acceso.guardar(False, [])
    return atajo_acceso


def testSinFirmaExigidaElMovimientoEntra(movimientosApp, sinFirma):
    """Es lo que se viene a poder hacer: apuntar sin clave."""
    client = movimientosApp.test_client()

    respuesta = client.post(
        "/api/movimiento",
        data=json.dumps({"tipo": "gasto", "categoria": "Compra", "nombre": "Pan", "importe": 1.2}).encode(),
        content_type="application/json",
        environ_base={"REMOTE_ADDR": "192.168.1.50"},
    )

    assert respuesta.status_code == 201
    assert respuesta.get_json()["ok"] is True


def testSinFirmaExigidaLaIpSigueMandando(movimientosApp, sinFirma):
    """La barrera que queda tiene que quedar entera.

    Si quitar la firma ensanchara además quién puede llegar, el apaño dejaría de
    ser un apaño: cualquiera en cualquier red podría escribir.
    """
    client = movimientosApp.test_client()

    respuesta = client.post(
        "/api/movimiento",
        data=json.dumps({"tipo": "gasto", "categoria": "Compra", "nombre": "Pan", "importe": 1.2}).encode(),
        content_type="application/json",
        environ_base={"REMOTE_ADDR": "8.8.8.8"},
    )

    assert respuesta.status_code == 403


def testSinFirmaExigidaNoHaceFaltaNiClave(movimientosApp, sinFirma, monkeypatch):
    """El caso que lo motiva: `movimientos.key` perdida tras restaurar un backup.

    Con la firma exigida esto es un 503 y el Atajo no puede enviar nada; sin
    exigirla tiene que entrar, porque no hay nada que verificar.
    """
    monkeypatch.delenv("MOVIMIENTOS_SECRET_KEY", raising=False)
    client = movimientosApp.test_client()

    respuesta = client.post(
        "/api/movimiento",
        data=json.dumps({"tipo": "ingreso", "categoria": "Nomina", "nombre": "Paga", "importe": 10}).encode(),
        content_type="application/json",
        environ_base={"REMOTE_ADDR": "192.168.1.50"},
    )

    assert respuesta.status_code == 201


# ── Token de dispositivo ─────────────────────────────────────────────────────
# Antes /api/preparar firmaba para cualquiera que llegase desde una red
# permitida, y con esa firma /api/movimiento aceptaba el alta: la clave no
# probaba quién escribía. Ahora todas las rutas del Atajo piden el token que va
# dentro del .shortcut.

@pytest.mark.parametrize("ruta,metodo", [
    ("/api/portfolios-lista", "get"),
    ("/api/cuentas-lista", "get"),
    ("/api/categorias", "get"),
    ("/api/preparar", "post"),
    ("/api/firmar", "post"),
    ("/api/movimiento", "post"),
])
def testSinTokenNingunaRutaDelAtajoResponde(movimientosApp, ruta, metodo):
    client = movimientosApp.test_client()
    respuesta = getattr(client, metodo)(
        ruta, json={}, headers={"X-Atajo-Token": ""}, environ_base={"REMOTE_ADDR": "192.168.1.50"},
    )
    assert respuesta.status_code == 401
    assert "token" in respuesta.get_json()["error"]


def testUnTokenFalsoNoVale(movimientosApp):
    client = movimientosApp.test_client()
    respuesta = client.get(
        "/api/categorias", headers={"X-Atajo-Token": "0" * 64}, environ_base={"REMOTE_ADDR": "192.168.1.50"},
    )
    assert respuesta.status_code == 401


def testElOraculoDeFirmaYaNoSirveSinToken(movimientosApp):
    """El ataque de la auditoría: pedir la firma a /api/preparar y usarla."""
    client = movimientosApp.test_client()
    sinToken = {"X-Atajo-Token": ""}
    preparado = client.post(
        "/api/preparar", json={"tipo": "gasto", "nombre": "Intruso", "importe": 1},
        headers=sinToken, environ_base={"REMOTE_ADDR": "192.168.1.50"},
    )
    assert preparado.status_code == 401
    assert "firma" not in (preparado.get_json() or {})


def testRehacerLaClaveRevocaElToken(movimientosApp, monkeypatch):
    from core import firma_hmac

    tokenViejo = firma_hmac.tokenDispositivo()
    monkeypatch.setenv("MOVIMIENTOS_SECRET_KEY", "otra-clave-0123456789abcdef-otra")
    client = movimientosApp.test_client()

    respuesta = client.get(
        "/api/categorias", headers={"X-Atajo-Token": tokenViejo}, environ_base={"REMOTE_ADDR": "192.168.1.50"},
    )

    assert respuesta.status_code == 401


def testConLaFirmaDesactivadaNoSePideToken(movimientosApp, sinFirma):
    client = movimientosApp.test_client()
    respuesta = client.get(
        "/api/categorias", headers={"X-Atajo-Token": ""}, environ_base={"REMOTE_ADDR": "192.168.1.50"},
    )
    assert respuesta.status_code == 200


# ── Revisión del año ─────────────────────────────────────────────────────────

def testUnAltaDelAtajoAvanzaLaRevisionDelAnio(movimientosApp):
    """Es lo que hace que la pestaña de Gastos abierta no lo borre al guardar."""
    from stores import revisiones

    antes = revisiones.actual("gastos", "2026")
    respuesta = _enviar(
        movimientosApp.test_client(),
        {"tipo": "gasto", "nombre": "Pan", "importe": 1, "fecha": "2026-03-04"},
    )

    assert respuesta.status_code == 201
    assert revisiones.actual("gastos", "2026") == antes + 1
