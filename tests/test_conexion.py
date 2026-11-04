"""Pruebas de providers/conexion.py: saltar rápido una IP que no conecta.

Nada sale a la red: la resolución DNS y la creación del socket son dobles.
"""

import socket

import pytest

from providers import conexion


@pytest.fixture(autouse=True)
def _limpio():
    conexion.olvidar()
    yield
    conexion.olvidar()


class _Socket:
    def __init__(self, ip):
        self.ip = ip
        self.timeout = "sin tocar"

    def settimeout(self, valor):
        self.timeout = valor


def _resolver(*ips):
    def resolver(host, puerto, type=None):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, puerto)) for ip in ips]
    return resolver


def _crear(muertas, intentos):
    def crear(direccion, timeout, source_address):
        intentos.append((direccion[0], timeout))
        if direccion[0] in muertas:
            raise TimeoutError("timed out")
        return _Socket(direccion[0])
    return crear


def _conectar(ips, muertas, intentos, timeout=10.0, reloj=lambda: 0.0):
    return conexion.conectar(("api.ejemplo", 443), timeout, None, plazoConexion=lambda: 3.0,
                             resolver=_resolver(*ips), crear=_crear(muertas, intentos), reloj=reloj)


def testSaltaLaIpMuertaConElPlazoCortoYLeeConElTimeoutEntero():
    intentos = []

    sock = _conectar(["10.0.0.1", "10.0.0.2"], {"10.0.0.1"}, intentos)

    assert intentos == [("10.0.0.1", 3.0), ("10.0.0.2", 3.0)]
    assert (sock.ip, sock.timeout) == ("10.0.0.2", 10.0)


def testRecuerdaLaIpQueFuncionoYDejaLaMuertaParaElFinal():
    _conectar(["10.0.0.1", "10.0.0.2", "10.0.0.3"], {"10.0.0.1"}, [])
    intentos = []

    _conectar(["10.0.0.1", "10.0.0.2", "10.0.0.3"], {"10.0.0.1"}, intentos)

    assert intentos == [("10.0.0.2", 3.0)]


def testPasadoElCastigoLaIpMuertaVuelveASuSitio():
    _conectar(["10.0.0.1", "10.0.0.2"], {"10.0.0.1"}, [])
    # La buena deja de funcionar: se vuelve a probar la castigada, que ya revivió.
    intentos = []

    sock = _conectar(["10.0.0.1", "10.0.0.2"], {"10.0.0.2"}, intentos, reloj=lambda: 10_000.0)

    assert [ip for ip, _ in intentos] == ["10.0.0.2", "10.0.0.1"]
    assert sock.ip == "10.0.0.1"


def testConUnaSolaIpUsaElTimeoutEntero():
    intentos = []

    _conectar(["10.0.0.1"], set(), intentos)

    assert intentos == [("api.ejemplo", 10.0)]


def testSiNoConectaNingunaSubeElUltimoError():
    with pytest.raises(TimeoutError):
        _conectar(["10.0.0.1", "10.0.0.2"], {"10.0.0.1", "10.0.0.2"}, [])


def testUnTimeoutMenorQueElPlazoMandaTambienAlConectar():
    intentos = []

    _conectar(["10.0.0.1", "10.0.0.2"], set(), intentos, timeout=1.0)

    assert intentos == [("10.0.0.1", 1.0)]


def testConElServidorCaidoSoloSeSondeaUnaIpYSeVanTurnando():
    ips = ["10.0.0.1", "10.0.0.2", "10.0.0.3"]
    with pytest.raises(TimeoutError):
        _conectar(ips, set(ips), [], reloj=lambda: 0.0)
    assert conexion.servidorCaido("api.ejemplo", 443, ahora=1.0)

    primera, segunda = [], []
    with pytest.raises(TimeoutError):
        _conectar(ips, set(ips), primera, reloj=lambda: 1.0)
    with pytest.raises(TimeoutError):
        _conectar(ips, set(ips), segunda, reloj=lambda: 2.0)

    assert len(primera) == 1 and len(segunda) == 1
    assert primera[0][0] != segunda[0][0]


def testElServidorCaidoRevivoVuelveAContarComoVivo():
    ips = ["10.0.0.1", "10.0.0.2"]
    with pytest.raises(TimeoutError):
        _conectar(ips, set(ips), [], reloj=lambda: 0.0)

    sock = _conectar(ips, set(), [], reloj=lambda: 1.0)

    assert sock.ip == "10.0.0.1"
    assert not conexion.servidorCaido("api.ejemplo", 443, ahora=1.0)


def testUnServidorConIpsVivasNoSeDaPorCaido():
    _conectar(["10.0.0.1", "10.0.0.2"], {"10.0.0.1"}, [])

    assert not conexion.servidorCaido("api.ejemplo", 443, ahora=0.0)


def testElCaidoSeOlvidaPasadoElCastigo():
    ips = ["10.0.0.1", "10.0.0.2"]
    with pytest.raises(TimeoutError):
        _conectar(ips, set(ips), [], reloj=lambda: 0.0)

    assert not conexion.servidorCaido("api.ejemplo", 443, ahora=10_000.0)


def testTrasDosIpsSinRespuestaSeDaPorCaidoSinProbarElResto():
    ips = ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"]
    intentos = []

    with pytest.raises(TimeoutError):
        _conectar(ips, set(ips), intentos)

    assert [ip for ip, _ in intentos] == ["10.0.0.1", "10.0.0.2"]
    assert conexion.servidorCaido("api.ejemplo", 443, ahora=1.0)


def testSiLasDosPrimerasEstabanMuertasLaSiguienteLlamadaPruebaUnaNueva():
    ips = ["10.0.0.1", "10.0.0.2", "10.0.0.3"]
    with pytest.raises(TimeoutError):
        _conectar(ips, {"10.0.0.1", "10.0.0.2"}, [])

    sock = _conectar(ips, {"10.0.0.1", "10.0.0.2"}, [], reloj=lambda: 1.0)

    assert sock.ip == "10.0.0.3"
    assert not conexion.servidorCaido("api.ejemplo", 443, ahora=1.0)
