"""Configuración por cuenta de ahorro y aportación mensual automática."""

import datetime

import pytest


@pytest.fixture
def cliente(cliente_autenticado, datos_aislados, temp_db, monkeypatch):
    from routes.ajustes import ajustes_bp
    from routes.cuenta_ahorro import cuenta_ahorro_bp
    from routes.cuentas import cuentas_bp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")

    client, cabeceras, _app = cliente_autenticado(ajustes_bp, cuenta_ahorro_bp, cuentas_bp)
    return client, cabeceras


# ── Configuración ────────────────────────────────────────────────────────────

def test_la_configuracion_antigua_pasa_a_la_cuenta_principal():
    from stores.cuenta_ahorro_store import normalizar_config

    cfg = normalizar_config({"cuentasRemuneradas": ["a", "a", " b ", ""], "incluirDividendos": 1})

    assert len(cfg["cuentas"]) == 1
    principal = cfg["cuentas"][0]
    assert principal["nombre"] == ""
    assert principal["remuneradas"] == ["a", "b"]
    assert principal["incluirDividendos"] is True


def test_la_configuracion_se_normaliza_al_guardar(cliente):
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
    from stores.cuentas_store import listar_transferencias

    return listar_transferencias()


def test_la_aportacion_automatica_es_una_transferencia_desde_el_banco(temp_db):
    from stores.cuenta_ahorro_store import aplicar_recurrentes

    generado, creados = aplicar_recurrentes(_config(), {}, hoy=datetime.date(2026, 3, 10))

    assert [t["fecha"] for t in creados] == ["05-01-2026", "05-02-2026", "05-03-2026"]
    assert generado == {"_": "2026-03"}
    assert {(t["origen"], t["destino"], t["cantidad"]) for t in _transferencias()} == {
        ("banco", "ahorro", "300,00 €")
    }


def test_la_aportacion_automatica_no_cuenta_como_gasto(temp_db):
    from core.db import get_db
    from stores.cuenta_ahorro_store import aplicar_recurrentes

    aplicar_recurrentes(_config(), {}, hoy=datetime.date(2026, 3, 10))

    assert get_db().execute("SELECT COUNT(*) FROM gastos_rows").fetchone()[0] == 0


def test_la_aportacion_automatica_es_idempotente_y_respeta_lo_borrado(temp_db):
    from stores.cuenta_ahorro_store import aplicar_recurrentes
    from stores.cuentas_store import eliminar_transferencia

    hoy = datetime.date(2026, 3, 10)
    generado, creados = aplicar_recurrentes(_config(), {}, hoy=hoy)
    eliminar_transferencia(creados[0]["id"])

    generado, creados = aplicar_recurrentes(_config(), generado, hoy=hoy)

    assert creados == []
    assert len(_transferencias()) == 2


def test_la_aportacion_automatica_no_adelanta_el_dia_del_mes(temp_db):
    from stores.cuenta_ahorro_store import aplicar_recurrentes

    generado, creados = aplicar_recurrentes(_config(desde="2026-03"), {}, hoy=datetime.date(2026, 3, 4))
    assert creados == [] and generado == {}

    generado, creados = aplicar_recurrentes(_config(desde="2026-03"), generado, hoy=datetime.date(2026, 3, 5))
    assert [t["fecha"] for t in creados] == ["05-03-2026"]


def test_la_aportacion_automatica_ajusta_el_dia_a_meses_cortos(temp_db):
    from stores.cuenta_ahorro_store import aplicar_recurrentes

    _gen, creados = aplicar_recurrentes(_config(dia=31, desde="2026-02"), {}, hoy=datetime.date(2026, 2, 28))

    assert [t["fecha"] for t in creados] == ["28-02-2026"]


def test_una_cuenta_sin_la_aportacion_activa_no_genera_nada(temp_db):
    from stores.cuenta_ahorro_store import aplicar_recurrentes

    _gen, creados = aplicar_recurrentes(_config(activa=False), {}, hoy=datetime.date(2026, 3, 10))
    assert creados == []


def test_la_aportacion_va_a_la_cuenta_de_ahorro_que_toca(temp_db):
    from stores.cuenta_ahorro_store import aplicar_recurrentes
    from stores.cuentas_store import crear_cuenta

    viaje = crear_cuenta("Viaje", "ahorro")

    aplicar_recurrentes(_config("Viaje"), {}, hoy=datetime.date(2026, 1, 10))

    assert [t["destino"] for t in _transferencias()] == [viaje["id"]]


def test_una_cuenta_de_la_configuracion_que_ya_no_existe_se_ignora(temp_db):
    from stores.cuenta_ahorro_store import aplicar_recurrentes

    _gen, creados = aplicar_recurrentes(_config("Borrada"), {}, hoy=datetime.date(2026, 3, 10))

    assert creados == []


def test_abrir_la_ventana_aplica_la_aportacion_automatica_una_sola_vez(cliente):
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
