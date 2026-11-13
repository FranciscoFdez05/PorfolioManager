"""Precalentado del histórico por tipo al cambiar de cartera.

El agregado de `history/by-type` cuesta ~1 s la primera vez por cartera. Al
cambiar de cartera se lanza en un hilo para que la primera visita a Métricas ya
lo encuentre listo, sin retrasar la respuesta del cambio.
"""

import threading

import pytest

from stores import historico_tipos


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, monkeypatch):
    from routes import portfolios as rutas

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    # El cambio real reasigna la BD activa del proceso; aquí solo importa lo que
    # hace la ruta después, así que se sustituye por uno que no toca nada.
    monkeypatch.setattr(rutas, "switchPortfolio", lambda pid: None)

    client, cabeceras, _app = clienteAutenticado(rutas.portfoliosBp)
    return client, cabeceras


def testElCambioDeCarteraLanzaElPrecalentadoUnaVez(cliente, monkeypatch):
    client, cabeceras = cliente
    llamadas = []
    monkeypatch.setattr(historico_tipos, "precalentar", lambda: llamadas.append(1))

    respuesta = client.post("/api/portfolios/switch", json={"id": "otra"}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert respuesta.get_json() == {"ok": True}
    assert llamadas == [1]


def testUnFalloAlPrecalentarNoRompeElCambio(cliente, monkeypatch):
    client, cabeceras = cliente

    def roto():
        raise RuntimeError("no hay hilos")

    monkeypatch.setattr(historico_tipos, "precalentar", roto)

    respuesta = client.post("/api/portfolios/switch", json={"id": "otra"}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert respuesta.get_json() == {"ok": True}


def testUnCambioRechazadoNoPrecalienta(cliente, monkeypatch):
    from routes import portfolios as rutas

    client, cabeceras = cliente
    llamadas = []

    def rechaza(pid):
        raise ValueError("Portfolio no encontrado")

    monkeypatch.setattr(rutas, "switchPortfolio", rechaza)
    monkeypatch.setattr(historico_tipos, "precalentar", lambda: llamadas.append(1))

    respuesta = client.post("/api/portfolios/switch", json={"id": "otra"}, headers=cabeceras)

    assert respuesta.status_code == 400
    assert llamadas == []


def testLaRespuestaNoEsperaAlCalculo(cliente, monkeypatch):
    client, cabeceras = cliente
    liberar = threading.Event()
    arrancado = threading.Event()

    def agregadoLento(conn):
        arrancado.set()
        liberar.wait(timeout=30)

    monkeypatch.setattr(historico_tipos, "_agregado", agregadoLento)
    try:
        respuesta = client.post("/api/portfolios/switch", json={"id": "otra"}, headers=cabeceras)

        # Si la ruta esperase al hilo, este punto no se alcanzaría hasta liberar.
        assert respuesta.status_code == 200
        assert arrancado.wait(timeout=10)
    finally:
        liberar.set()


@pytest.mark.usefixtures("tempDb")
class TestPrecalentarSinDuplicados:
    def testDosLlamadasSeguidasComparteElHilo(self, monkeypatch):
        liberar = threading.Event()
        calculos = []

        def agregadoLento(conn):
            calculos.append(1)
            liberar.wait(timeout=30)

        monkeypatch.setattr(historico_tipos, "_agregado", agregadoLento)
        try:
            primero = historico_tipos.precalentar()
            segundo = historico_tipos.precalentar()
        finally:
            liberar.set()
        primero.join(timeout=30)

        assert segundo is primero
        assert calculos == [1]

    def testTerminadoElCalculoSePuedeVolverALanzar(self, monkeypatch):
        calculos = []
        monkeypatch.setattr(historico_tipos, "_agregado", lambda conn: calculos.append(1))

        historico_tipos.precalentar().join(timeout=30)
        historico_tipos.precalentar().join(timeout=30)

        assert calculos == [1, 1]
        assert historico_tipos._precalentando == {}

    def testUnFalloLiberaElRegistroDeEnCurso(self, monkeypatch):
        def roto(conn):
            raise RuntimeError("base rota")

        monkeypatch.setattr(historico_tipos, "_agregado", roto)

        historico_tipos.precalentar().join(timeout=30)

        assert historico_tipos._precalentando == {}
