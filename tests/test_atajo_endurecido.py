"""Endurecimiento del Atajo de iOS tras la auditoría.

- Una petición firmada vale una sola vez: antes se podía reenviar durante toda
  la ventana de tolerancia y cada envío creaba otro movimiento.
- La cabecera Host tiene que ser una IP, `localhost` o un nombre por el que ya
  se haya entrado con sesión: sin eso, una web maliciosa podía usar DNS
  rebinding para hablar con estos endpoints desde el navegador de alguien de la
  LAN.
- `X-Timestamp: inf` daba 500.
"""

import json
import time

import pytest

from tests import test_movimientos
from tests.test_movimientos import _enviar, _firmar

# Reutilizada por asignación (ver test_comision_transferencias.py).
movimientos_app = test_movimientos.movimientos_app

LAN = {"REMOTE_ADDR": "192.168.1.50"}
GASTO = {"tipo": "gasto", "nombre": "Metro", "importe": 1}


# ── Repetición ───────────────────────────────────────────────────────────────

def test_la_misma_peticion_firmada_no_se_acepta_dos_veces(movimientos_app):
    client = movimientos_app.test_client()
    ts = int(time.time())

    primera = _enviar(client, GASTO, timestamp=ts)
    segunda = _enviar(client, GASTO, timestamp=ts)

    assert primera.status_code == 201
    assert segunda.status_code == 401
    assert "repetida" in segunda.get_json()["error"]


def test_dos_movimientos_distintos_en_el_mismo_segundo_si_entran(movimientos_app):
    client = movimientos_app.test_client()
    ts = int(time.time())

    assert _enviar(client, GASTO, timestamp=ts).status_code == 201
    assert _enviar(client, {**GASTO, "importe": 2}, timestamp=ts).status_code == 201


def test_las_firmas_caducadas_se_olvidan():
    from core import firma_hmac

    firma_hmac.marcarFirmaUsada("abc", 1000, ahora=1000)
    with pytest.raises(firma_hmac.ErrorFirma):
        firma_hmac.marcarFirmaUsada("abc", 1000, ahora=1001)

    # Pasada la ventana ya no hace falta recordarla (el timestamp, por sí solo,
    # la rechazaría), y el fichero no crece sin límite.
    firma_hmac.marcarFirmaUsada("otra", 5000, ahora=5000)
    guardadas = json.loads(firma_hmac._ficheroFirmasUsadas().read_text("utf-8"))
    assert "abc" not in guardadas


def test_un_timestamp_infinito_es_401_y_no_500(movimientos_app):
    client = movimientos_app.test_client()
    cuerpo = json.dumps(GASTO).encode()

    respuesta = client.post(
        "/api/movimiento", data=cuerpo, content_type="application/json",
        headers={"X-Timestamp": "inf", "X-Signature": _firmar("inf", cuerpo)},
        environ_base=LAN,
    )

    assert respuesta.status_code == 401


# ── Cabecera Host ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("host", ["192.168.1.10:5000", "localhost:5000", "[fd00::1]:5000", "192.168.1.10"])
def test_las_direcciones_directas_entran(movimientos_app, host):
    client = movimientos_app.test_client()
    assert client.get("/api/categorias", headers={"Host": host}, environ_base=LAN).status_code == 200


def test_un_nombre_desconocido_se_rechaza(movimientos_app):
    client = movimientos_app.test_client()

    respuesta = client.get("/api/portfolios-lista", headers={"Host": "evil.example"}, environ_base=LAN)

    assert respuesta.status_code == 403
    assert "evil.example" in respuesta.get_json()["error"]


def test_firmar_tampoco_responde_a_un_nombre_desconocido(movimientos_app):
    client = movimientos_app.test_client()

    respuesta = client.post("/api/firmar", json={"cuerpo": "{}"}, headers={"Host": "evil.example"},
                            environ_base=LAN)

    assert respuesta.status_code == 403


def test_un_nombre_usado_con_sesion_queda_admitido(movimientos_app):
    from core import red_local

    client = movimientos_app.test_client()
    assert client.get("/api/categorias", headers={"Host": "nas.casa:5000"}, environ_base=LAN).status_code == 403

    red_local.anotarHostConSesion("NAS.casa:5000")

    assert client.get("/api/categorias", headers={"Host": "nas.casa:5000"}, environ_base=LAN).status_code == 200


def test_una_sesion_valida_anota_su_host(crear_app, datos_aislados):
    """El aprendizaje lo hace require_login, solo con la sesión ya validada."""
    from core import red_local, sesion

    client = crear_app().test_client()

    # Sin sesión: no se aprende nada.
    client.get("/api/lo-que-sea", base_url="http://intruso.example")
    assert "intruso.example" not in red_local.hostsConocidos()

    # La cookie de sesión es del host por el que se entró: un dominio ajeno no
    # la recibe nunca, y por eso basta con aprender los que llegan con ella.
    with client.session_transaction(base_url="http://portfolio.casa") as s:
        s["logged_in"] = True
        sesion.abrir(s)
    client.get("/api/lo-que-sea", base_url="http://portfolio.casa")

    assert "portfolio.casa" in red_local.hostsConocidos()
    assert "intruso.example" not in red_local.hostsConocidos()


@pytest.mark.parametrize("cabecera, nombre", [
    ("Ejemplo.COM:8443", "ejemplo.com"),
    ("[::1]:5000", "::1"),
    ("192.168.1.2:5000", "192.168.1.2"),
    ("nas.local.", "nas.local"),
    ("", ""),
])
def test_nombre_de_host(cabecera, nombre):
    from core.red_local import nombreDeHost

    assert nombreDeHost(cabecera) == nombre
