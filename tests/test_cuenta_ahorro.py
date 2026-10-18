"""Configuración por cuenta de ahorro y aportación mensual automática."""

import datetime

import pytest


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.ajustes import ajustesBp
    from routes.cuenta_ahorro import cuentaAhorroBp
    from routes.cuentas import cuentasBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")

    client, cabeceras, _app = clienteAutenticado(ajustesBp, cuentaAhorroBp, cuentasBp)
    return client, cabeceras


# ── Configuración ────────────────────────────────────────────────────────────

def testLaConfiguracionAntiguaPasaALaCuentaPrincipal():
    from stores.cuenta_ahorro_store import normalizarConfig

    cfg = normalizarConfig({"cuentasRemuneradas": ["a", "a", " b ", ""], "incluirDividendos": 1})

    assert len(cfg["cuentas"]) == 1
    principal = cfg["cuentas"][0]
    assert principal["nombre"] == ""
    # Las remuneradas y los dividendos ya no se guardan aquí: son de la cuenta, en la base.
    assert "remuneradas" not in principal
    assert "incluirDividendos" not in principal


def testLaConfiguracionSeNormalizaAlGuardar(cliente):
    client, cabeceras = cliente

    client.post(
        "/api/settings",
        json={"cuentaAhorroConfig": {"cuentas": [
            {"nombre": "", "objetivo": "12.000,50",
             "recurrente": {"activa": 1, "importe": "300", "dia": 45, "desde": "2026-10"}},
            {"nombre": "  Viaje ", "remuneradas": ["x"], "objetivo": "abc"},
            {"nombre": "viaje"},
        ]}},
        headers=cabeceras,
    )

    cuentas = client.get("/api/settings").get_json()["cuentaAhorroConfig"]["cuentas"]
    assert [c["nombre"] for c in cuentas] == ["", "Viaje"]
    assert cuentas[0]["objetivo"] == "12000.50"
    assert cuentas[0]["recurrente"] == {"activa": True, "importe": "300.00", "dia": 31, "desde": "2026-10"}
    assert cuentas[1]["objetivo"] == ""


# ── Aportación mensual automática ────────────────────────────────────────────

def _config(clave="", **rec):
    base = {"activa": True, "importe": "300", "dia": 5, "desde": "2026-01"}
    base.update(rec)
    return {"cuentas": [{"nombre": clave, "recurrente": base}]}


def _transferencias():
    from stores.cuentas_store import listarTransferencias

    return listarTransferencias()


def testLaAportacionAutomaticaEsUnaTransferenciaDesdeElBanco(tempDb):
    from stores.cuenta_ahorro_store import aplicarRecurrentes

    generado, creados = aplicarRecurrentes(_config(), {}, hoy=datetime.date(2026, 3, 10))

    assert [t["fecha"] for t in creados] == ["05-01-2026", "05-02-2026", "05-03-2026"]
    assert generado == {"_": "2026-03"}
    assert {(t["origen"], t["destino"], t["cantidad"]) for t in _transferencias()} == {
        ("banco", "ahorro", "300,00 €")
    }


def testLaAportacionAutomaticaNoCuentaComoGasto(tempDb):
    from core.db import getDb
    from stores.cuenta_ahorro_store import aplicarRecurrentes

    aplicarRecurrentes(_config(), {}, hoy=datetime.date(2026, 3, 10))

    assert getDb().execute("SELECT COUNT(*) FROM gastos_rows").fetchone()[0] == 0


def testLaAportacionAutomaticaEsIdempotenteYRespetaLoBorrado(tempDb):
    from stores.cuenta_ahorro_store import aplicarRecurrentes
    from stores.cuentas_store import eliminarTransferencia

    hoy = datetime.date(2026, 3, 10)
    generado, creados = aplicarRecurrentes(_config(), {}, hoy=hoy)
    eliminarTransferencia(creados[0]["id"])

    generado, creados = aplicarRecurrentes(_config(), generado, hoy=hoy)

    assert creados == []
    assert len(_transferencias()) == 2


def testLaAportacionAutomaticaNoAdelantaElDiaDelMes(tempDb):
    from stores.cuenta_ahorro_store import aplicarRecurrentes

    generado, creados = aplicarRecurrentes(_config(desde="2026-03"), {}, hoy=datetime.date(2026, 3, 4))
    assert creados == [] and generado == {}

    generado, creados = aplicarRecurrentes(_config(desde="2026-03"), generado, hoy=datetime.date(2026, 3, 5))
    assert [t["fecha"] for t in creados] == ["05-03-2026"]


def testLaAportacionAutomaticaAjustaElDiaAMesesCortos(tempDb):
    from stores.cuenta_ahorro_store import aplicarRecurrentes

    _gen, creados = aplicarRecurrentes(_config(dia=31, desde="2026-02"), {}, hoy=datetime.date(2026, 2, 28))

    assert [t["fecha"] for t in creados] == ["28-02-2026"]


def testUnaCuentaSinLaAportacionActivaNoGeneraNada(tempDb):
    from stores.cuenta_ahorro_store import aplicarRecurrentes

    _gen, creados = aplicarRecurrentes(_config(activa=False), {}, hoy=datetime.date(2026, 3, 10))
    assert creados == []


def testLaAportacionVaALaCuentaDeAhorroQueToca(tempDb):
    from stores.cuenta_ahorro_store import aplicarRecurrentes
    from stores.cuentas_store import crearCuenta

    viaje = crearCuenta("Viaje", "ahorro")

    aplicarRecurrentes(_config("Viaje"), {}, hoy=datetime.date(2026, 1, 10))

    assert [t["destino"] for t in _transferencias()] == [viaje["id"]]


def testUnaCuentaDeLaConfiguracionQueYaNoExisteSeIgnora(tempDb):
    from stores.cuenta_ahorro_store import aplicarRecurrentes

    _gen, creados = aplicarRecurrentes(_config("Borrada"), {}, hoy=datetime.date(2026, 3, 10))

    assert creados == []


def testAbrirLaVentanaAplicaLaAportacionAutomaticaUnaSolaVez(cliente):
    client, cabeceras = cliente
    hoy = datetime.date.today()
    client.post(
        "/api/settings",
        json={"cuentaAhorroConfig": _config(dia=1, desde=f"{hoy.year:04d}-{hoy.month:02d}")},
        headers=cabeceras,
    )

    primera = client.get("/api/cuenta-ahorro").get_json()["movimientos"]
    segunda = client.get("/api/cuenta-ahorro").get_json()["movimientos"]

    assert len(primera) == 1 and len(segunda) == 1
    assert primera[0]["nombre"] == "Ahorro mensual"
