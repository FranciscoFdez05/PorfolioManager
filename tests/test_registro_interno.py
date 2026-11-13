"""Pruebas del registro interno (log en archivo y errores del navegador)."""

import logging

import pytest

from core import registro_interno


@pytest.fixture
def carpetaLogs(tmp_path, monkeypatch):
    """Redirige logs/ a una carpeta temporal y limpia el handler al terminar."""
    monkeypatch.setattr(registro_interno, "LOGS_DIR", tmp_path)
    yield tmp_path
    raiz = logging.getLogger()
    for handler in list(raiz.handlers):
        if getattr(handler, registro_interno._MARCA_HANDLER, False):
            raiz.removeHandler(handler)
            handler.close()


def _escribir(proceso, lineas):
    registro_interno.rutaArchivo(proceso).write_text("\n".join(lineas) + "\n", encoding="utf-8")


def test_rutaArchivoRechazaProcesosDesconocidos():
    with pytest.raises(ValueError):
        registro_interno.rutaArchivo("../etc/passwd")


def test_configurarEscribeEnArchivoYEsIdempotente(carpetaLogs):
    assert registro_interno.configurar("web") is True
    assert registro_interno.configurar("web") is True
    logging.getLogger("prueba").warning("hola registro")
    for handler in logging.getLogger().handlers:
        handler.flush()
    contenido = (carpetaLogs / "web.log").read_text(encoding="utf-8")
    assert contenido.count("hola registro") == 1
    assert registro_interno.estaActivo() is True


def test_configurarNoAbortaSiNoSePuedeEscribir(tmp_path, monkeypatch):
    # Un archivo donde debería haber carpeta hace fallar mkdir/open con OSError.
    ocupado = tmp_path / "ocupado"
    ocupado.write_text("x")
    monkeypatch.setattr(registro_interno, "LOGS_DIR", ocupado / "dentro")
    assert registro_interno.configurar("web") is False


def test_leerColaDevuelveLasUltimasLineas(carpetaLogs):
    _escribir("web", [f"2026-01-01 [INFO] x - linea {i}" for i in range(10)])
    assert registro_interno.leerCola("web", 3) == [
        "2026-01-01 [INFO] x - linea 7",
        "2026-01-01 [INFO] x - linea 8",
        "2026-01-01 [INFO] x - linea 9",
    ]


def test_leerColaFiltraPorNivelYConservaLasTrazas(carpetaLogs):
    _escribir("web", [
        "2026-01-01 [INFO] x - normal",
        "2026-01-01 [ERROR] cliente - [navegador] fallo",
        "TypeError: algo",
        "    at linea 3",
        "2026-01-01 [INFO] x - otra",
    ])
    assert registro_interno.leerCola("web", 50, "ERROR") == [
        "2026-01-01 [ERROR] cliente - [navegador] fallo",
        "TypeError: algo",
        "    at linea 3",
    ]


def test_leerColaSinArchivoDevuelveVacio(carpetaLogs):
    assert registro_interno.leerCola("worker") == []


def test_estadoArchivosIndicaCuandoNoExiste(carpetaLogs):
    _escribir("web", ["a"])
    estados = {e["proceso"]: e for e in registro_interno.estadoArchivos()}
    assert estados["web"]["existe"] is True
    assert estados["worker"]["existe"] is False


def test_registrarErrorClienteEscribeYAcotaLaFrecuencia(caplog, monkeypatch):
    monkeypatch.setattr(registro_interno, "_erroresCliente", registro_interno.deque())
    with caplog.at_level(logging.ERROR, logger="cliente"):
        assert registro_interno.registrarErrorCliente({"mensaje": "boom", "stack": "at x"}) is True
    assert "boom" in caplog.text and "at x" in caplog.text
    for _ in range(registro_interno.MAX_ERRORES_CLIENTE_POR_MINUTO):
        registro_interno.registrarErrorCliente({"mensaje": "otro"})
    assert registro_interno.registrarErrorCliente({"mensaje": "de más"}) is False


def test_registrarErrorClienteRecortaCamposLargos(caplog, monkeypatch):
    monkeypatch.setattr(registro_interno, "_erroresCliente", registro_interno.deque())
    with caplog.at_level(logging.ERROR, logger="cliente"):
        registro_interno.registrarErrorCliente({"mensaje": "m" * 100_000})
    assert len(caplog.text) < 3 * registro_interno.MAX_CAMPO_CLIENTE


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.registro_interno import registroInternoBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(registroInternoBp)
    return client, cabeceras


def test_rutasEstadoYLecturaDeLog(cliente, carpetaLogs):
    client, _cabeceras = cliente
    _escribir("web", ["2026-01-01 [INFO] x - hola"])
    estado = client.get("/api/registro/estado").get_json()
    assert estado["ok"] is True and "archivos" in estado
    assert client.get("/api/registro/web").get_json()["lineas"] == ["2026-01-01 [INFO] x - hola"]
    assert client.get("/api/registro/otro").status_code == 404


def test_rutaClienteGuardaYAceptaCuerpoVacio(cliente, monkeypatch):
    client, cabeceras = cliente
    monkeypatch.setattr(registro_interno, "_erroresCliente", registro_interno.deque())
    respuesta = client.post("/api/registro/cliente", json={"mensaje": "boom"}, headers=cabeceras)
    assert respuesta.status_code == 200
    assert client.post("/api/registro/cliente", headers=cabeceras).status_code == 200


def test_rutaClienteNoDevuelve429AlDescartar(cliente, monkeypatch):
    # Un 429 en /api dispara un aviso por cada error en api.js.
    client, cabeceras = cliente
    monkeypatch.setattr(registro_interno, "_erroresCliente", registro_interno.deque())
    for _ in range(registro_interno.MAX_ERRORES_CLIENTE_POR_MINUTO):
        client.post("/api/registro/cliente", json={"mensaje": "x"}, headers=cabeceras)
    respuesta = client.post("/api/registro/cliente", json={"mensaje": "de más"}, headers=cabeceras)
    assert respuesta.status_code == 200
    assert respuesta.get_json()["guardado"] is False
