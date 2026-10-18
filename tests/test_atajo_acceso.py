"""Quién puede escribir por los endpoints del Atajo.

Aquí se comprueba sobre todo **que aflojar una barrera no afloje la otra**. La
firma se puede quitar desde Ajustes —a veces la alternativa real es quedarse sin
Atajo—, pero el filtro de red sigue siendo obligatorio y sigue siendo
fail-closed: sin rangos válidos no entra nadie, con firma o sin ella. Y el valor
de fábrica, y el de cualquier fichero ilegible, es exigirla.

No se levanta ningún iPhone: se llama a los endpoints con el cliente de pruebas.
"""

import json

import pytest

from core import atajo_acceso, red_local


@pytest.fixture(autouse=True)
def accesoAislado(tmp_path, monkeypatch):
    """Saca `data/atajo/` del repositorio en todos los tests de este fichero."""
    destino = tmp_path / "atajo"
    monkeypatch.setattr(atajo_acceso, "ATAJO_DIR", destino, raising=False)
    monkeypatch.setattr(atajo_acceso, "ACCESO_FILE", destino / "acceso.json", raising=False)
    return destino


# ── Estado ────────────────────────────────────────────────────────────────────

def testDeFabricaSeExigeLaFirma():
    """El valor por defecto no puede ser el flojo: quien no toque nada tiene que
    quedarse con las dos barreras."""
    assert atajo_acceso.exigirFirma() is True
    assert atajo_acceso.leer()["redes"] == []


def testUnFicheroIlegibleSeLeeComoQueSíSeExige(accesoAislado):
    """Si algo va mal, que vaya mal hacia el lado cerrado."""
    accesoAislado.mkdir(parents=True, exist_ok=True)
    (accesoAislado / "acceso.json").write_text("{roto", encoding="utf-8")

    assert atajo_acceso.exigirFirma() is True


def testUnFicheroSinLaClaveTampocoAfloja(accesoAislado):
    """Un JSON a medias —editado a mano, truncado— no puede significar «acepta
    a cualquiera»."""
    accesoAislado.mkdir(parents=True, exist_ok=True)
    (accesoAislado / "acceso.json").write_text(json.dumps({"redes": []}), encoding="utf-8")

    assert atajo_acceso.exigirFirma() is True


def testElEstadoVaYVuelve():
    atajo_acceso.guardar(False, ["192.168.1.0/24"])

    estado = atajo_acceso.leer()
    assert estado["exigirFirma"] is False
    assert estado["redes"] == ["192.168.1.0/24"]
    assert estado["actualizado"]


# ── Redes ─────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("entrada,esperado", [
    # Se guarda la red de verdad, no lo que se escribió: quien pone una IP con
    # /24 está permitiendo las 256, y tiene que verlo escrito.
    (["192.168.1.5/24"], ["192.168.1.0/24"]),
    (["192.168.1.100/32"], ["192.168.1.100/32"]),
    ([" 10.0.0.0/8 "], ["10.0.0.0/8"]),
    # Lo que no es una red se descarta en vez de colarse hasta el filtro.
    (["no-es-una-red", "192.168.1.0/24"], ["192.168.1.0/24"]),
    (["192.168.1.0/24", "192.168.1.0/24"], ["192.168.1.0/24"]),
])
def testLasRedesSeNormalizan(entrada, esperado):
    assert atajo_acceso.normalizarRedes(entrada) == esperado


def testLoGuardadoMandaSobreConfigIni():
    atajo_acceso.guardar(True, ["10.9.0.0/24"])

    assert atajo_acceso.redesEfectivas() == ["10.9.0.0/24"]
    assert atajo_acceso.origenDeLasRedes() == "ajustes"
    assert [str(r) for r in red_local.leerRedesPermitidas()] == ["10.9.0.0/24"]


def testSinRedesPropiasSeUsaConfigIni():
    """Vaciar el campo del panel es «vuelve a la configuración», no «cierra la
    puerta»: un botón cuyo único efecto fuera romper el Atajo sin avisar no
    debería existir."""
    atajo_acceso.guardar(True, [])

    assert atajo_acceso.origenDeLasRedes() == "config"
    assert atajo_acceso.redesEfectivas()


def testElFiltroDeRedSigueMandandoSinFirma():
    """La barrera que queda tiene que seguir entera: quitar la firma no puede
    ensanchar de rebote quién llega."""
    atajo_acceso.guardar(False, ["192.168.1.0/24"])

    assert red_local.ipEstaPermitida("192.168.1.50") is True
    assert red_local.ipEstaPermitida("10.1.2.3") is False


# ── Aviso ─────────────────────────────────────────────────────────────────────

def testSinFirmaSeAvisaYSeDiceQuéQuedaEnPie():
    """Desde fuera, un servidor sin firma no se distingue de uno que sí comprueba
    quién escribe. Tiene que quedar escrito al arrancar."""
    atajo_acceso.guardar(False, ["192.168.1.0/24"])

    aviso = atajo_acceso.avisoSinFirma()

    assert "sin" in aviso.lower()
    assert "192.168.1.0/24" in aviso


def testConFirmaNoHayNadaQueAvisar():
    assert atajo_acceso.avisoSinFirma() is None


# ── En Docker ─────────────────────────────────────────────────────────────────
# Ahí hay un proxy delante siempre, así que la IP que ve la aplicación es la de
# Caddy salvo que ProxyFix esté puesto. Con la firma quitada esa IP es la ÚNICA
# barrera, así que el panel tiene que poder enseñarla.

def testElPanelDiceConQuéIpTeVeElServidor(clienteAutenticado, monkeypatch):
    """Sin esto, un ProxyFix mal puesto se diagnostica leyendo el log por SSH:
    el Atajo falla desde el móvil con la IP correcta escrita en los rangos."""
    from routes.atajo import atajoBp

    atajo_acceso.guardar(True, ["192.168.1.0/24"])
    client, _cab, _app = clienteAutenticado(atajoBp)

    datos = client.get("/api/atajo", environ_base={"REMOTE_ADDR": "192.168.1.77"}).get_json()

    assert datos["verTe"]["ip"] == "192.168.1.77"
    assert datos["verTe"]["permitida"] is True


def testUnaIpDeLaRedDeDockerSeVeComoNoPermitida(clienteAutenticado):
    """El síntoma exacto de un PROXY_FIX_HOPS mal puesto: la aplicación ve la IP
    del contenedor del proxy, no la del iPhone."""
    from routes.atajo import atajoBp

    atajo_acceso.guardar(True, ["192.168.1.0/24"])
    client, _cab, _app = clienteAutenticado(atajoBp)

    datos = client.get("/api/atajo", environ_base={"REMOTE_ADDR": "172.18.0.4"}).get_json()

    assert datos["verTe"]["ip"] == "172.18.0.4"
    assert datos["verTe"]["permitida"] is False


def testElEstadoDelAtajoNoViajaEnUnExport():
    """Vive en `data/atajo/`, no en `data/JSON/`, que es lo que se exporta.

    Importar el export de otra instalación no puede traerse puesto un «acepta
    sin firma» ni los rangos de otra red: eso es configuración de esta máquina.
    """
    assert atajo_acceso.ACCESO_FILE.parent.name == "atajo"
    assert "JSON" not in str(atajo_acceso.ACCESO_FILE)
