"""Cuentas de ahorro: varias cuentas, edición y aportación mensual automática."""

import datetime

import pytest


@pytest.fixture
def cliente(cliente_autenticado, datos_aislados, temp_db, monkeypatch):
    from routes.ajustes import ajustes_bp
    from routes.cuenta_ahorro import cuenta_ahorro_bp
    from routes.gastos import gastos_bp
    from routes.ingresos import ingresos_bp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")

    client, cabeceras, _app = cliente_autenticado(cuenta_ahorro_bp, gastos_bp, ingresos_bp, ajustes_bp)
    return client, cabeceras


def _anadir(client, cabeceras, **campos):
    return client.post("/api/cuenta-ahorro/movimientos", json=campos, headers=cabeceras)


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


# ── Varias cuentas ───────────────────────────────────────────────────────────

def test_cada_cuenta_lleva_su_propia_categoria(cliente):
    client, cabeceras = cliente

    _anadir(client, cabeceras, kind="ingreso", fecha="01-02-2026", cantidad="50", cuenta="Viaje")
    _anadir(client, cabeceras, kind="ingreso", fecha="01-02-2026", cantidad="80")

    datos = client.get("/api/cuenta-ahorro").get_json()
    assert datos["cuentas"] == ["Viaje"]
    assert sorted((m["cuenta"], m["cantidad"]) for m in datos["movimientos"]) == [
        ("", "80,00 €"),
        ("Viaje", "50,00 €"),
    ]
    assert "Cuenta de ahorro · Viaje" in client.get("/api/gastos-tipos").get_json()["types"]


def test_un_gasto_con_la_categoria_de_otra_cuenta_cuenta_para_esa_cuenta(cliente):
    client, cabeceras = cliente
    client.post(
        "/api/gastos/2026",
        json={"year": "2026", "months": {"mayo": {"rows": [
            {"fecha": "05-05-2026", "nombre": "Hucha", "tipo": "Cuenta de ahorro · Coche", "cantidad": "30,00 €"}
        ]}}},
        headers=cabeceras,
    )

    datos = client.get("/api/cuenta-ahorro").get_json()

    assert datos["cuentas"] == ["Coche"]
    assert [(m["cuenta"], m["nombre"]) for m in datos["movimientos"]] == [("Coche", "Hucha")]


def test_renombrar_una_cuenta_mueve_sus_movimientos(cliente):
    client, cabeceras = cliente
    _anadir(client, cabeceras, kind="ingreso", fecha="01-02-2026", cantidad="50", cuenta="Viaje")
    _anadir(client, cabeceras, kind="retiro", fecha="02-02-2026", cantidad="10", cuenta="Viaje")

    res = client.post("/api/cuenta-ahorro/cuentas/renombrar", json={"de": "Viaje", "a": "Vacaciones"}, headers=cabeceras)

    assert res.status_code == 200
    datos = client.get("/api/cuenta-ahorro").get_json()
    assert datos["cuentas"] == ["Vacaciones"]
    assert {m["cuenta"] for m in datos["movimientos"]} == {"Vacaciones"}
    assert "Cuenta de ahorro · Viaje" not in client.get("/api/ingresos-tipos").get_json()["types"]


def test_no_se_renombra_a_una_cuenta_existente_ni_la_principal(cliente):
    client, cabeceras = cliente
    client.post("/api/cuenta-ahorro/cuentas", json={"nombre": "A"}, headers=cabeceras)
    client.post("/api/cuenta-ahorro/cuentas", json={"nombre": "B"}, headers=cabeceras)

    renombrar = "/api/cuenta-ahorro/cuentas/renombrar"
    assert client.post(renombrar, json={"de": "A", "a": "b"}, headers=cabeceras).status_code == 400
    assert client.post(renombrar, json={"de": "", "a": "C"}, headers=cabeceras).status_code == 400
    assert client.post("/api/cuenta-ahorro/cuentas", json={"nombre": "a"}, headers=cabeceras).status_code == 400


def test_una_cuenta_con_movimientos_no_se_elimina(cliente):
    client, cabeceras = cliente
    _anadir(client, cabeceras, kind="ingreso", fecha="01-02-2026", cantidad="50", cuenta="Viaje")
    client.post("/api/cuenta-ahorro/cuentas", json={"nombre": "Vacía"}, headers=cabeceras)

    eliminar = "/api/cuenta-ahorro/cuentas/eliminar"
    assert client.post(eliminar, json={"nombre": "Viaje"}, headers=cabeceras).status_code == 409
    assert client.post(eliminar, json={"nombre": "Vacía"}, headers=cabeceras).status_code == 200
    assert client.get("/api/cuenta-ahorro").get_json()["cuentas"] == ["Viaje"]


def test_las_categorias_de_todas_las_cuentas_estan_reservadas(temp_db):
    from stores.categorias_store import CategoriaInvalida, eliminarCategoria, renombrarCategoria

    with pytest.raises(CategoriaInvalida):
        renombrarCategoria("gasto", "Cuenta de ahorro · Viaje", "Otra")
    with pytest.raises(CategoriaInvalida):
        eliminarCategoria("ingreso", "cuenta de ahorro · viaje")


# ── Editar ───────────────────────────────────────────────────────────────────

def _editar(client, cabeceras, mov, **cambios):
    cuerpo = {
        "kind": mov["kind"], "id": mov["id"],
        "fechaOriginal": mov["fecha"], "cantidadOriginal": mov["cantidad"],
        "fecha": mov["fecha"], "nombre": mov["nombre"], "cantidad": mov["cantidad"],
    }
    cuerpo.update(cambios)
    return client.post("/api/cuenta-ahorro/movimientos/editar", json=cuerpo, headers=cabeceras)


def test_editar_cambia_de_mes_y_conserva_la_cuenta(cliente):
    client, cabeceras = cliente
    mov = _anadir(client, cabeceras, kind="ingreso", fecha="10-04-2026", cantidad="75",
                  cuenta="Viaje").get_json()["movimiento"]

    res = _editar(client, cabeceras, mov, fecha="03-06-2026", cantidad="90", nombre="Junio")

    assert res.status_code == 200
    meses = client.get("/api/gastos/2026").get_json()["months"]
    assert meses["abril"]["rows"] == []
    fila = meses["junio"]["rows"][0]
    assert (fila["nombre"], fila["cantidad"], fila["tipo"]) == ("Junio", "90,00 €", "Cuenta de ahorro · Viaje")


def test_editar_de_ingreso_a_retirada_cambia_de_tabla(cliente):
    client, cabeceras = cliente
    mov = _anadir(client, cabeceras, kind="ingreso", fecha="10-04-2026", cantidad="75").get_json()["movimiento"]

    _editar(client, cabeceras, mov, kindNuevo="retiro")

    assert client.get("/api/gastos/2026").get_json()["months"]["abril"]["rows"] == []
    assert len(client.get("/api/ingresos/2026").get_json()["months"]["abril"]["rows"]) == 1


def test_editar_con_datos_invalidos_deja_el_original(cliente):
    client, cabeceras = cliente
    mov = _anadir(client, cabeceras, kind="ingreso", fecha="10-04-2026", cantidad="75").get_json()["movimiento"]

    assert _editar(client, cabeceras, mov, cantidad="abc").status_code == 400
    assert len(client.get("/api/cuenta-ahorro").get_json()["movimientos"]) == 1


def test_editar_una_fila_que_ha_cambiado_da_404(cliente):
    client, cabeceras = cliente
    mov = _anadir(client, cabeceras, kind="ingreso", fecha="10-04-2026", cantidad="75").get_json()["movimiento"]

    assert _editar(client, cabeceras, {**mov, "cantidad": "1,00 €"}, nombre="x").status_code == 404


# ── Aportación mensual automática ────────────────────────────────────────────

def _config(**rec):
    base = {"activa": True, "importe": "300", "dia": 5, "desde": "2026-01"}
    base.update(rec)
    return {"cuentas": [{"nombre": "", "recurrente": base}]}


def test_la_aportacion_automatica_crea_los_meses_vencidos(temp_db):
    from stores.cuenta_ahorro_store import aplicar_recurrentes, listar_movimientos

    generado, creados = aplicar_recurrentes(_config(), {}, hoy=datetime.date(2026, 3, 10))

    assert [m["fecha"] for m in creados] == ["05-01-2026", "05-02-2026", "05-03-2026"]
    assert generado == {"_": "2026-03"}
    assert {m["cantidad"] for m in listar_movimientos()} == {"300,00 €"}


def test_la_aportacion_automatica_es_idempotente_y_respeta_lo_borrado(temp_db):
    from stores.cuenta_ahorro_store import aplicar_recurrentes, eliminar_movimiento, listar_movimientos

    hoy = datetime.date(2026, 3, 10)
    generado, creados = aplicar_recurrentes(_config(), {}, hoy=hoy)
    primero = creados[0]
    eliminar_movimiento("ingreso", primero["id"], primero["fecha"], primero["cantidad"])

    generado, creados = aplicar_recurrentes(_config(), generado, hoy=hoy)

    assert creados == []
    assert len(listar_movimientos()) == 2


def test_la_aportacion_automatica_no_adelanta_el_dia_del_mes(temp_db):
    from stores.cuenta_ahorro_store import aplicar_recurrentes

    generado, creados = aplicar_recurrentes(_config(desde="2026-03"), {}, hoy=datetime.date(2026, 3, 4))
    assert creados == [] and generado == {}

    generado, creados = aplicar_recurrentes(_config(desde="2026-03"), generado, hoy=datetime.date(2026, 3, 5))
    assert [m["fecha"] for m in creados] == ["05-03-2026"]


def test_la_aportacion_automatica_ajusta_el_dia_a_meses_cortos(temp_db):
    from stores.cuenta_ahorro_store import aplicar_recurrentes

    _gen, creados = aplicar_recurrentes(_config(dia=31, desde="2026-02"), {}, hoy=datetime.date(2026, 2, 28))

    assert [m["fecha"] for m in creados] == ["28-02-2026"]


def test_una_cuenta_sin_la_aportacion_activa_no_genera_nada(temp_db):
    from stores.cuenta_ahorro_store import aplicar_recurrentes

    _gen, creados = aplicar_recurrentes(_config(activa=False), {}, hoy=datetime.date(2026, 3, 10))
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
