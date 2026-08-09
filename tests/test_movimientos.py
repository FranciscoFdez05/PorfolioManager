"""Pruebas de los endpoints del Atajo de iOS.

La app se construye a mano (Flask + blueprint) en lugar de importar `server`,
siguiendo la regla de conftest.py: importar `server` ejecutaría init_portfolios()
y escribiría sobre los datos reales de quien lance la suite.
"""

import hashlib
import hmac
import json
import time

import pytest

CLAVE = "clave-de-prueba-0123456789abcdef"


@pytest.fixture
def movimientos_app(temp_db, monkeypatch):
    from flask import Flask

    from core.errors import register_error_handlers
    from routes.movimientos import movimientos_bp

    # Overrides por entorno para que la suite no dependa del config.ini real
    # de la máquina donde se ejecuta.
    monkeypatch.setenv("MOVIMIENTOS_SECRET_KEY", CLAVE)
    monkeypatch.setenv("MOVIMIENTOS_REDES_PERMITIDAS", "192.168.1.0/24,10.0.0.0/24")
    monkeypatch.setenv("MOVIMIENTOS_ACTIVADO", "true")

    app = Flask(__name__)
    app.config["TESTING"] = True
    register_error_handlers(app)
    app.register_blueprint(movimientos_bp)
    return app


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
def test_ip_permitida_entra(movimientos_app, ip):
    client = movimientos_app.test_client()
    respuesta = client.get("/api/categorias", environ_base={"REMOTE_ADDR": ip})
    assert respuesta.status_code == 200


@pytest.mark.parametrize("ip", ["8.8.8.8", "192.168.2.10", "127.0.0.1"])
def test_ip_externa_rechazada(movimientos_app, ip):
    client = movimientos_app.test_client()
    respuesta = client.get("/api/categorias", environ_base={"REMOTE_ADDR": ip})
    assert respuesta.status_code == 403


def test_el_403_dice_con_que_ip_te_ve_el_servidor(movimientos_app):
    """Permite configurar redes_permitidas desde el móvil, sin leer logs."""
    client = movimientos_app.test_client()
    datos = client.get("/api/categorias", environ_base={"REMOTE_ADDR": "10.6.0.2"}).get_json()

    assert datos["ip"] == "10.6.0.2"
    # Los rangos permitidos no se filtran nunca.
    assert "192.168" not in str(datos)


def test_ip_se_comprueba_antes_que_la_firma(movimientos_app):
    """Una IP externa no debe poder ni siquiera sondear si su firma es válida."""
    client = movimientos_app.test_client()
    respuesta = _enviar(client, {"tipo": "gasto", "nombre": "x", "importe": 1}, ip="8.8.8.8")
    assert respuesta.status_code == 403


def test_redes_configurables_por_entorno(movimientos_app, monkeypatch):
    monkeypatch.setenv("MOVIMIENTOS_REDES_PERMITIDAS", "172.16.0.0/24")
    client = movimientos_app.test_client()
    assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": "172.16.0.9"}).status_code == 200
    assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.9"}).status_code == 403


def test_rangos_invalidos_no_abren_la_puerta(movimientos_app, monkeypatch):
    monkeypatch.setenv("MOVIMIENTOS_REDES_PERMITIDAS", "esto-no-es-un-cidr")
    client = movimientos_app.test_client()
    respuesta = client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.9"})
    assert respuesta.status_code == 403


# ── Configuración desde config.ini ───────────────────────────────────────────

@pytest.fixture
def config_atajo(tmp_path, monkeypatch):
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


def test_redes_salen_de_config_ini(movimientos_app, config_atajo, monkeypatch):
    monkeypatch.delenv("MOVIMIENTOS_REDES_PERMITIDAS", raising=False)
    config_atajo("redes_permitidas = 172.16.5.0/24")

    client = movimientos_app.test_client()
    assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": "172.16.5.9"}).status_code == 200
    assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.9"}).status_code == 403


def test_entorno_tiene_prioridad_sobre_config_ini(movimientos_app, config_atajo):
    """El override por entorno existe para ajustes puntuales sin tocar el .ini."""
    config_atajo("redes_permitidas = 172.16.5.0/24")

    client = movimientos_app.test_client()
    # La fixture deja MOVIMIENTOS_REDES_PERMITIDAS con la 192.168.1.0/24.
    assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.9"}).status_code == 200
    assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": "172.16.5.9"}).status_code == 403


def test_desactivado_responde_404(movimientos_app, config_atajo, monkeypatch):
    monkeypatch.delenv("MOVIMIENTOS_ACTIVADO", raising=False)
    config_atajo("activado = false\nredes_permitidas = 192.168.1.0/24")

    client = movimientos_app.test_client()
    assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.9"}).status_code == 404
    assert _enviar(client, {"tipo": "gasto", "nombre": "x", "importe": 1}).status_code == 404


def test_tolerancia_sale_de_config_ini(movimientos_app, config_atajo, monkeypatch):
    monkeypatch.delenv("MOVIMIENTOS_TOLERANCIA_SEGUNDOS", raising=False)
    config_atajo("redes_permitidas = 192.168.1.0/24\ntolerancia_segundos = 600")

    client = movimientos_app.test_client()
    # 120 s de desfase: rechazado con la tolerancia por defecto de 60, aceptado
    # con la de 600 que declara este config.ini.
    respuesta = _enviar(
        client,
        {"tipo": "gasto", "nombre": "Metro", "importe": 1},
        timestamp=int(time.time()) - 120,
    )
    assert respuesta.status_code == 201


def test_config_ini_ausente_usa_los_valores_por_defecto(movimientos_app, tmp_path, monkeypatch):
    """Sin config.ini la app arranca igual, con los rangos de último recurso."""
    from core import config_ini

    monkeypatch.delenv("MOVIMIENTOS_REDES_PERMITIDAS", raising=False)
    monkeypatch.setattr(config_ini, "RUTA_CONFIG", tmp_path / "no-existe.ini")
    config_ini.invalidarCache()

    try:
        client = movimientos_app.test_client()
        assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.9"}).status_code == 200
        assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": "8.8.8.8"}).status_code == 403
    finally:
        config_ini.invalidarCache()


def test_clave_leida_del_fichero_configurado(movimientos_app, tmp_path, monkeypatch):
    """Sin variable de entorno, la clave sale del fichero de [atajo] fichero_clave."""
    from core.secret_store import write_secret_lines

    ruta = tmp_path / "movimientos.key"
    write_secret_lines(ruta, ["clave-desde-fichero"])

    monkeypatch.delenv("MOVIMIENTOS_SECRET_KEY", raising=False)
    monkeypatch.setattr("core.firma_hmac.rutaFicheroClave", lambda: ruta)

    client = movimientos_app.test_client()
    respuesta = _enviar(
        client,
        {"tipo": "gasto", "nombre": "Metro", "importe": 1},
        clave="clave-desde-fichero",
    )
    assert respuesta.status_code == 201


def test_sin_clave_ni_en_entorno_ni_en_fichero_503(movimientos_app, tmp_path, monkeypatch):
    monkeypatch.delenv("MOVIMIENTOS_SECRET_KEY", raising=False)
    monkeypatch.setattr("core.firma_hmac.rutaFicheroClave", lambda: tmp_path / "no-existe.key")

    client = movimientos_app.test_client()
    assert _enviar(client, {"tipo": "gasto", "nombre": "x", "importe": 1}).status_code == 503


# ── Firma HMAC ───────────────────────────────────────────────────────────────

def test_firma_valida_crea_el_movimiento(movimientos_app):
    client = movimientos_app.test_client()
    respuesta = _enviar(client, {
        "tipo": "gasto", "categoria": "Transporte", "nombre": "Metro",
        "importe": 12.5, "fecha": "2026-03-04",
    })

    assert respuesta.status_code == 201
    movimiento = respuesta.get_json()["movimiento"]
    assert movimiento["year"] == "2026"
    assert movimiento["month"] == "marzo"
    assert movimiento["cantidad"] == "12,50 €"


def test_sin_firma_401(movimientos_app):
    client = movimientos_app.test_client()
    respuesta = client.post(
        "/api/movimiento",
        data=b"{}",
        content_type="application/json",
        headers={"X-Timestamp": str(int(time.time()))},
        environ_base={"REMOTE_ADDR": "192.168.1.50"},
    )
    assert respuesta.status_code == 401


def test_firma_incorrecta_401(movimientos_app):
    client = movimientos_app.test_client()
    respuesta = _enviar(client, {"tipo": "gasto", "nombre": "Metro", "importe": 1}, firma="00" * 32)
    assert respuesta.status_code == 401


def test_firma_con_otra_clave_401(movimientos_app):
    client = movimientos_app.test_client()
    respuesta = _enviar(client, {"tipo": "gasto", "nombre": "Metro", "importe": 1}, clave="otra-clave")
    assert respuesta.status_code == 401


def test_cuerpo_alterado_tras_firmar_401(movimientos_app):
    """La firma cubre el cuerpo: cambiar el importe la invalida."""
    client = movimientos_app.test_client()
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
def test_timestamp_fuera_de_ventana_401(movimientos_app, desfase):
    client = movimientos_app.test_client()
    respuesta = _enviar(
        client,
        {"tipo": "gasto", "nombre": "Metro", "importe": 1},
        timestamp=int(time.time()) + desfase,
    )
    assert respuesta.status_code == 401


def test_sin_clave_configurada_503(movimientos_app, monkeypatch):
    monkeypatch.delenv("MOVIMIENTOS_SECRET_KEY", raising=False)
    client = movimientos_app.test_client()
    respuesta = _enviar(client, {"tipo": "gasto", "nombre": "Metro", "importe": 1})
    assert respuesta.status_code == 503


# ── Validación del payload ───────────────────────────────────────────────────

@pytest.mark.parametrize("payload", [
    {"tipo": "transferencia", "nombre": "x", "importe": 1},
    {"tipo": "gasto", "nombre": "x", "importe": "no-es-un-numero"},
    {"tipo": "gasto", "nombre": "x", "importe": 0},
    {"tipo": "gasto", "nombre": "x", "importe": -5},
    {"tipo": "gasto", "nombre": "", "importe": 5},
    {"tipo": "gasto", "nombre": "x", "importe": 5, "fecha": "2026/03/04"},
    {"tipo": "gasto", "nombre": "x", "importe": 5, "fecha": "32-03-2026"},
])
def test_payloads_invalidos_400(movimientos_app, payload):
    client = movimientos_app.test_client()
    assert _enviar(client, payload).status_code == 400


@pytest.mark.parametrize(("fecha", "esperado"), [
    ("2026-08-09", "2026-08-09"),   # ISO
    ("09-08-2026", "2026-08-09"),   # formato español, el de la web y el del Atajo
    ("31-12-2025", "2025-12-31"),
])
def test_acepta_las_dos_formas_de_escribir_la_fecha(movimientos_app, fecha, esperado):
    client = movimientos_app.test_client()
    respuesta = _enviar(client, {
        "tipo": "gasto", "categoria": "Otros", "nombre": "Prueba",
        "importe": 1, "fecha": fecha,
    })

    assert respuesta.status_code == 201
    assert respuesta.get_json()["movimiento"]["fecha"] == esperado


def test_la_fecha_espanola_tambien_cae_en_su_mes(movimientos_app):
    """09-08-2026 es el 9 de agosto, no el 8 de septiembre."""
    client = movimientos_app.test_client()
    creado = _enviar(client, {
        "tipo": "gasto", "nombre": "Prueba", "importe": 1, "fecha": "09-08-2026",
    }).get_json()["movimiento"]

    assert (creado["year"], creado["month"]) == ("2026", "agosto")


def test_importe_con_coma_decimal(movimientos_app):
    client = movimientos_app.test_client()
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
def test_la_fecha_decide_el_mes_y_el_anio(movimientos_app, fecha, year, month):
    """El Atajo no pregunta el mes: lo deduce el servidor de la fecha."""
    client = movimientos_app.test_client()
    respuesta = _enviar(client, {
        "tipo": "gasto", "categoria": "Otros", "nombre": "Prueba",
        "importe": 1, "fecha": fecha,
    })

    assert respuesta.status_code == 201
    creado = respuesta.get_json()["movimiento"]
    assert (creado["year"], creado["month"]) == (year, month)


def test_la_fila_guardada_cae_en_el_mes_correcto(movimientos_app):
    """09-08-2026 tiene que acabar en agosto de 2026, no en otro sitio."""
    from stores.gastos_store import read_gastos_year

    client = movimientos_app.test_client()
    _enviar(client, {
        "tipo": "gasto", "categoria": "Gasoil", "nombre": "Repostaje",
        "importe": 60, "fecha": "2026-08-09",
    })

    with movimientos_app.app_context():
        datos = read_gastos_year("2026")

    assert datos["months"]["agosto"]["rows"] == [
        {"fecha": "09-08-2026", "nombre": "Repostaje", "tipo": "Gasoil", "cantidad": "60,00 €"}
    ]
    # Y ningún otro mes se ha llevado la fila.
    otros = [mes for mes, datosMes in datos["months"].items() if mes != "agosto" and datosMes["rows"]]
    assert otros == []


def test_fecha_ausente_usa_hoy(movimientos_app):
    from datetime import date

    client = movimientos_app.test_client()
    respuesta = _enviar(client, {"tipo": "gasto", "nombre": "Café", "importe": 2})
    assert respuesta.status_code == 201
    assert respuesta.get_json()["movimiento"]["fecha"] == date.today().isoformat()


# ── Integración con las tablas de la web app ─────────────────────────────────

def test_gasto_visible_para_la_web_app(movimientos_app):
    from stores.gastos_store import read_gastos_year

    client = movimientos_app.test_client()
    _enviar(client, {
        "tipo": "gasto", "categoria": "Alquiler", "nombre": "Piso",
        "importe": 800, "fecha": "2026-05-01",
    })

    with movimientos_app.app_context():
        datos = read_gastos_year("2026")

    assert datos is not None
    filas = datos["months"]["mayo"]["rows"]
    assert filas == [{"fecha": "01-05-2026", "nombre": "Piso", "tipo": "Alquiler", "cantidad": "800,00 €"}]
    assert "Alquiler" in datos["gastosTipos"]


def test_ingreso_visible_para_la_web_app(movimientos_app):
    from stores.ingresos_store import read_ingresos_year

    client = movimientos_app.test_client()
    _enviar(client, {
        "tipo": "ingreso", "categoria": "Dividendos", "nombre": "VWCE",
        "importe": 42.1, "fecha": "2026-07-20",
    })

    with movimientos_app.app_context():
        datos = read_ingresos_year("2026")

    assert datos is not None
    filas = datos["months"]["julio"]["rows"]
    assert filas == [{"fecha": "20-07-2026", "nombre": "VWCE", "tipo": "Dividendos", "cantidad": "42,10 €"}]


# ── Selección de portfolio (base de datos) ───────────────────────────────────

@pytest.fixture
def portfolios(tmp_path, monkeypatch):
    """Dos portfolios con .db propios, sin tocar los del usuario.

    Hay que parchear también `routes.movimientos`: ese módulo importa
    `get_portfolios` por nombre, así que sustituirlo solo en
    `portfolios_manager` no le afecta y acabaría leyendo el portfolios.json
    real de quien ejecute la suite.
    """
    from admin import portfolios_manager
    from core.db import init_db_at_path
    from routes import movimientos as rutas

    directorio = tmp_path / "portfolios"
    directorio.mkdir()

    for pid in ("principal", "test2"):
        init_db_at_path(directorio / f"{pid}.db")

    meta = {
        "active": "principal",
        "portfolios": [
            {"id": "principal", "name": "Principal"},
            {"id": "test2", "name": "Test2"},
        ],
    }

    monkeypatch.setattr(portfolios_manager, "_PORTFOLIOS_DIR", directorio)
    monkeypatch.setattr(portfolios_manager, "get_portfolios", lambda: meta)
    monkeypatch.setattr(rutas, "get_portfolios", lambda: meta)
    monkeypatch.setattr(rutas, "get_active_portfolio_id", lambda: meta.get("active"))

    return directorio


def test_lista_de_portfolios(movimientos_app, portfolios):
    """El Atajo tampoco lleva los portfolios escritos: los pide al servidor."""
    client = movimientos_app.test_client()
    datos = client.get("/api/portfolios-lista", environ_base={"REMOTE_ADDR": "192.168.1.50"}).get_json()

    assert datos["activo"] == "principal"
    assert datos["portfolios"] == [
        {"id": "principal", "nombre": "Principal", "activo": True},
        {"id": "test2", "nombre": "Test2", "activo": False},
    ]


def test_lista_de_portfolios_trae_nombres_planos(movimientos_app, portfolios):
    """Atajos no sabe pintar diccionarios: necesita la lista de nombres suelta."""
    client = movimientos_app.test_client()
    datos = client.get("/api/portfolios-lista", environ_base={"REMOTE_ADDR": "192.168.1.50"}).get_json()

    assert datos["nombres"] == ["Principal", "Test2"]
    assert datos["idPorNombre"] == {"Principal": "principal", "Test2": "test2"}


def test_nombres_repetidos_no_se_pisan(movimientos_app, monkeypatch, portfolios):
    from routes import movimientos as rutas

    monkeypatch.setattr(rutas, "get_portfolios", lambda: {
        "active": "casa",
        "portfolios": [{"id": "casa", "name": "Casa"}, {"id": "casa_2", "name": "Casa"}],
    })

    client = movimientos_app.test_client()
    datos = client.get("/api/portfolios-lista", environ_base={"REMOTE_ADDR": "192.168.1.50"}).get_json()

    assert datos["nombres"] == ["Casa", "Casa (casa_2)"]
    assert datos["idPorNombre"]["Casa"] == "casa"
    assert datos["idPorNombre"]["Casa (casa_2)"] == "casa_2"


def test_lista_de_portfolios_rechaza_ip_externa(movimientos_app, portfolios):
    client = movimientos_app.test_client()
    assert client.get("/api/portfolios-lista", environ_base={"REMOTE_ADDR": "8.8.8.8"}).status_code == 403


def test_movimiento_va_al_portfolio_indicado(movimientos_app, portfolios):
    """Lo escrito en test2 acaba en test2.db, no en la base de datos activa."""
    import sqlite3

    client = movimientos_app.test_client()
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


def test_portfolio_no_cambia_la_bd_activa_del_proceso(movimientos_app, portfolios, temp_db):
    """Escribir en otro portfolio no puede robarle la BD a la sesión web."""
    from core.db import get_active_db_path

    antes = get_active_db_path()
    client = movimientos_app.test_client()
    _enviar(client, {"tipo": "gasto", "nombre": "Piso", "importe": 800, "portfolio": "test2"})

    assert get_active_db_path() == antes


def test_categorias_de_un_portfolio_concreto(movimientos_app, portfolios):
    client = movimientos_app.test_client()
    _enviar(client, {"tipo": "gasto", "categoria": "Solo-Test2", "nombre": "x", "importe": 1, "portfolio": "test2"})

    deTest2 = client.get("/api/categorias?portfolio=test2", environ_base={"REMOTE_ADDR": "192.168.1.50"}).get_json()
    dePrincipal = client.get("/api/categorias?portfolio=principal", environ_base={"REMOTE_ADDR": "192.168.1.50"}).get_json()

    assert "Solo-Test2" in deTest2["categorias"]["gasto"]
    assert "Solo-Test2" not in dePrincipal["categorias"]["gasto"]


def test_portfolio_se_puede_indicar_por_nombre(movimientos_app, portfolios):
    """Le ahorra al Atajo traducir nombre→id, que era su parte más frágil."""
    import sqlite3

    client = movimientos_app.test_client()
    respuesta = _enviar(client, {
        "tipo": "gasto", "nombre": "Piso", "importe": 800, "portfolio": "Test2",
    })

    assert respuesta.status_code == 201
    conn = sqlite3.connect(str(portfolios / "test2.db"))
    assert conn.execute("SELECT COUNT(*) FROM gastos_rows").fetchone()[0] == 1
    conn.close()


def test_nombre_de_portfolio_sin_distinguir_mayusculas(movimientos_app, portfolios):
    client = movimientos_app.test_client()
    datos = client.get("/api/categorias?portfolio=principal", environ_base={"REMOTE_ADDR": "192.168.1.50"})
    otro = client.get("/api/categorias?portfolio=PRINCIPAL", environ_base={"REMOTE_ADDR": "192.168.1.50"})

    assert datos.status_code == 200
    assert otro.status_code == 200


def test_el_id_gana_al_nombre(movimientos_app, monkeypatch, portfolios):
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
    monkeypatch.setattr(portfolios_manager, "get_portfolios", lambda: meta)
    monkeypatch.setattr(rutas, "get_portfolios", lambda: meta)

    assert portfolios_manager.find_portfolio_id("test2") == "test2"


def test_portfolio_inexistente_da_404(movimientos_app, portfolios):
    client = movimientos_app.test_client()
    respuesta = _enviar(client, {"tipo": "gasto", "nombre": "x", "importe": 1, "portfolio": "no-existe"})

    assert respuesta.status_code == 404


def test_portfolio_con_traversal_da_404(movimientos_app, portfolios):
    """Un id no puede escaparse del directorio de portfolios."""
    client = movimientos_app.test_client()
    respuesta = _enviar(client, {"tipo": "gasto", "nombre": "x", "importe": 1, "portfolio": "../portfolio"})

    assert respuesta.status_code == 404


def test_sin_portfolio_usa_el_activo(movimientos_app, temp_db):
    """Un Atajo antiguo que no manda el campo sigue funcionando igual."""
    from stores.gastos_store import read_gastos_year

    client = movimientos_app.test_client()
    respuesta = _enviar(client, {
        "tipo": "gasto", "categoria": "Coche", "nombre": "Taller",
        "importe": 90, "fecha": "2026-04-01",
    })

    assert respuesta.status_code == 201
    with movimientos_app.app_context():
        assert read_gastos_year("2026")["months"]["abril"]["rows"][0]["nombre"] == "Taller"


def test_el_portfolio_va_firmado(movimientos_app, portfolios):
    """Cambiar el portfolio tras firmar invalida la petición."""
    import json as _json

    client = movimientos_app.test_client()
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

def test_categorias_salen_de_la_base_de_datos(movimientos_app):
    from stores.gastos_store import write_gastos_types
    from stores.ingresos_store import write_ingresos_types

    with movimientos_app.app_context():
        write_gastos_types(["Transporte", "Alquiler"])
        write_ingresos_types(["Nómina"])

    client = movimientos_app.test_client()
    datos = client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.50"}).get_json()

    assert datos["categorias"]["gasto"] == ["Alquiler", "Transporte"]
    assert datos["categorias"]["ingreso"] == ["Nómina"]
    assert datos["todas"] == ["Alquiler", "Nómina", "Transporte"]


def test_categorias_filtradas_por_tipo(movimientos_app):
    """`lista` evita que el Atajo tenga que usar una variable como clave."""
    from stores.gastos_store import write_gastos_types
    from stores.ingresos_store import write_ingresos_types

    with movimientos_app.app_context():
        write_gastos_types(["Transporte", "Alquiler"])
        write_ingresos_types(["Nómina"])

    client = movimientos_app.test_client()
    datos = client.get(
        "/api/categorias?tipo=gasto", environ_base={"REMOTE_ADDR": "192.168.1.50"}
    ).get_json()

    assert datos["tipo"] == "gasto"
    assert datos["lista"] == ["Alquiler", "Transporte"]
    # Lo anterior se mantiene, para no romper un Atajo ya montado.
    assert datos["categorias"]["ingreso"] == ["Nómina"]


def test_sin_tipo_no_hay_lista(movimientos_app):
    client = movimientos_app.test_client()
    datos = client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.50"}).get_json()

    assert "lista" not in datos


@pytest.mark.parametrize("tipo", ["gastos", "Gasto ", "cualquiera"])
def test_tipo_invalido_da_400_en_vez_de_lista_vacia(movimientos_app, tipo):
    """Una lista vacía haría que el Atajo se saltara el paso en silencio."""
    client = movimientos_app.test_client()
    respuesta = client.get(
        f"/api/categorias?tipo={tipo}", environ_base={"REMOTE_ADDR": "192.168.1.50"}
    )

    if tipo.strip().lower() in ("gasto", "ingreso"):
        assert respuesta.status_code == 200
    else:
        assert respuesta.status_code == 400


def test_categoria_nueva_del_atajo_aparece_en_categorias(movimientos_app):
    client = movimientos_app.test_client()
    _enviar(client, {"tipo": "gasto", "categoria": "Farmacia", "nombre": "Ibuprofeno", "importe": 4})

    datos = client.get("/api/categorias", environ_base={"REMOTE_ADDR": "192.168.1.50"}).get_json()
    assert "Farmacia" in datos["categorias"]["gasto"]


# ── /api/preparar (el Atajo no escribe JSON a mano) ──────────────────────────

def _preparar(client, campos, ip="192.168.1.50"):
    return client.post("/api/preparar", json=campos, environ_base={"REMOTE_ADDR": ip})


def test_preparar_devuelve_un_cuerpo_que_movimiento_acepta(movimientos_app):
    """El circuito completo sin construir JSON en el cliente."""
    client = movimientos_app.test_client()
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


def test_preparar_admite_comillas_en_el_concepto(movimientos_app):
    """Lo que era imposible con el JSON escrito a mano en el Atajo."""
    client = movimientos_app.test_client()
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


def test_preparar_genera_cuerpo_ascii(movimientos_app):
    """ASCII puro: descarta cualquier discrepancia de codificación en tránsito."""
    client = movimientos_app.test_client()
    preparado = _preparar(client, {
        "tipo": "gasto", "categoria": "Café", "nombre": "Nómina", "importe": 1,
    }).get_json()

    preparado["cuerpo"].encode("ascii")  # no debe lanzar
    assert "\\u00e9" in preparado["cuerpo"]


def test_preparar_descarta_campos_desconocidos(movimientos_app):
    client = movimientos_app.test_client()
    preparado = _preparar(client, {
        "tipo": "gasto", "nombre": "Metro", "importe": 1, "colado": "no deberia estar",
    }).get_json()

    assert "colado" not in preparado["cuerpo"]


@pytest.mark.parametrize("campos", [
    {"tipo": "transferencia", "nombre": "x", "importe": 1},
    {"tipo": "gasto", "nombre": "", "importe": 1},
    {"tipo": "gasto", "nombre": "x", "importe": -3},
    {"tipo": "gasto", "nombre": "x", "importe": 1, "fecha": "2026/03/04"},
])
def test_preparar_valida_antes_de_firmar(movimientos_app, campos):
    client = movimientos_app.test_client()
    assert _preparar(client, campos).status_code == 400


def test_preparar_rechaza_portfolio_inexistente(movimientos_app, portfolios):
    client = movimientos_app.test_client()
    respuesta = _preparar(client, {
        "tipo": "gasto", "nombre": "x", "importe": 1, "portfolio": "no-existe",
    })
    assert respuesta.status_code == 404


def test_preparar_rechaza_ip_externa(movimientos_app):
    client = movimientos_app.test_client()
    assert _preparar(client, {"tipo": "gasto", "nombre": "x", "importe": 1}, ip="8.8.8.8").status_code == 403


def test_preparar_sin_clave_da_503(movimientos_app, monkeypatch):
    monkeypatch.delenv("MOVIMIENTOS_SECRET_KEY", raising=False)
    client = movimientos_app.test_client()
    assert _preparar(client, {"tipo": "gasto", "nombre": "x", "importe": 1}).status_code == 503


# ── /api/firmar ──────────────────────────────────────────────────────────────

def test_firmar_devuelve_una_firma_utilizable(movimientos_app):
    client = movimientos_app.test_client()
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


def test_firmar_con_cuerpo_pone_el_timestamp_del_servidor(movimientos_app):
    """Modo que usa el Atajo: no necesita saber la hora ni calcular epochs."""
    client = movimientos_app.test_client()
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


def test_firmar_rechaza_ip_externa(movimientos_app):
    client = movimientos_app.test_client()
    respuesta = client.post("/api/firmar", json={"texto": "hola"}, environ_base={"REMOTE_ADDR": "8.8.8.8"})
    assert respuesta.status_code == 403


def test_firmar_exige_texto_o_cuerpo(movimientos_app):
    client = movimientos_app.test_client()
    respuesta = client.post("/api/firmar", json={}, environ_base={"REMOTE_ADDR": "192.168.1.50"})
    assert respuesta.status_code == 400


def test_firmar_con_texto_no_devuelve_timestamp(movimientos_app):
    """El modo 'texto' firma literal: el timestamp ya lo eligió el cliente."""
    client = movimientos_app.test_client()
    datos = client.post(
        "/api/firmar",
        json={"texto": "123.{}"},
        environ_base={"REMOTE_ADDR": "192.168.1.50"},
    ).get_json()

    assert datos["firma"] == _firmar(123, b"{}")
    assert "timestamp" not in datos
