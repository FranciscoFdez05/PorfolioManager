"""Patrimonio neto: la suma pura (core.patrimonio) y la ruta /api/patrimonio."""

from decimal import Decimal

import pytest

from core.patrimonio import Partida, componerPatrimonio


def _p(grupo, nombre, importe):
    return Partida(grupo, nombre, Decimal(importe))


def testSinPartidasTodoEsCero():
    resultado = componerPatrimonio([], [])
    assert resultado["neto"] == 0
    assert resultado["activos"]["total"] == 0
    assert resultado["pasivos"]["total"] == 0


def testNetoEsActivosMenosPasivos():
    resultado = componerPatrimonio(
        [_p("inversiones", "Cartera", "10000"), _p("cuentas", "Banco", "2500.50")],
        [_p("hipotecas", "Casa", "7000")],
    )
    assert resultado["activos"]["total"] == 12500.50
    assert resultado["pasivos"]["total"] == 7000
    assert resultado["neto"] == 5500.50


def testElDesgloseAgrupaPorGrupoYConservaLasPartidas():
    resultado = componerPatrimonio(
        [_p("cuentas", "A", "100"), _p("cuentas", "B", "50")], [])
    cuentas = next(g for g in resultado["activos"]["grupos"] if g["grupo"] == "cuentas")
    assert cuentas["total"] == 150
    assert [p["nombre"] for p in cuentas["partidas"]] == ["A", "B"]
    assert next(g for g in resultado["activos"]["grupos"] if g["grupo"] == "inversiones")["partidas"] == []


def testUnDescubiertoRestaDelActivo():
    resultado = componerPatrimonio([_p("cuentas", "Banco", "-300"), _p("inversiones", "Cartera", "1000")], [])
    assert resultado["neto"] == 700


def testPuedeSerNegativo():
    assert componerPatrimonio([_p("cuentas", "Banco", "100")], [_p("hipotecas", "Casa", "5000")])["neto"] == -4900


@pytest.mark.parametrize("activos, pasivos", [
    ([_p("hipotecas", "Mal puesta", "1")], []),
    ([], [_p("cuentas", "Mal puesta", "1")]),
    ([], [_p("inventado", "x", "1")]),
])
def testUnGrupoEnElLadoEquivocadoSeRechaza(activos, pasivos):
    with pytest.raises(ValueError):
        componerPatrimonio(activos, pasivos)


def testRedondeaACentimos():
    resultado = componerPatrimonio([_p("cuentas", "A", "0.005"), _p("cuentas", "B", "0.005")], [])
    assert resultado["activos"]["total"] == 0.01


@pytest.fixture
def cliente(clienteAutenticado, tempDb, monkeypatch):
    from routes.hipotecas import hipotecasBp
    from routes.patrimonio import patrimonioBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    client, cabeceras, _app = clienteAutenticado(patrimonioBp, hipotecasBp)
    return client, cabeceras


def testRutaSinDatosDevuelveCeros(cliente):
    client, _ = cliente
    datos = client.get("/api/patrimonio").get_json()
    assert datos["neto"] == 0
    assert datos["avisos"] == []


def testRutaSumaCuentasYRestaLaHipoteca(cliente):
    from stores.cuentas_store import crearCuenta

    client, cabeceras = cliente
    crearCuenta("Cuenta nomina", "banco", saldoInicial="1000")
    client.post("/api/hipotecas", headers=cabeceras, json={"rows": [{
        "alias": "Casa", "tipo": "fija", "capital": "100000", "fechaInicio": "2024-01-01",
        "plazoMeses": 240, "tin": "3"}]})

    datos = client.get("/api/patrimonio").get_json()
    cuentas = next(g for g in datos["activos"]["grupos"] if g["grupo"] == "cuentas")
    hipotecas = next(g for g in datos["pasivos"]["grupos"] if g["grupo"] == "hipotecas")
    # La hipoteca descuenta sus cuotas pagadas de la cuenta bancaria por defecto,
    # así que solo se comprueba la cuenta creada aquí, no el total de cuentas.
    assert {"nombre": "Cuenta nomina", "importe": 1000} in cuentas["partidas"]
    assert 0 < hipotecas["total"] < 100000
    assert datos["neto"] == pytest.approx(datos["activos"]["total"] - datos["pasivos"]["total"])


def testRentaFijaVencidaNoCuentaYLaVigenteSi(cliente):
    from datetime import date

    from stores.app_data import writeRentaFijaFile

    client, _ = cliente
    futuro = f"01-01-{date.today().year + 1}"
    base = {"fecha": "", "tipo": "bancario", "currency": "EUR", "rentabilidad": "",
            "interesAcumulado": "", "impuestos": ""}
    writeRentaFijaFile({"rows": [
        {**base, "instrumento": "Vencida", "vencimiento": "01-01-2020", "invertido": "5000"},
        {**base, "instrumento": "Vigente", "vencimiento": futuro, "invertido": "2000"},
        {**base, "instrumento": "Sin fecha", "vencimiento": "", "invertido": "100"},
    ]})
    grupo = next(g for g in client.get("/api/patrimonio").get_json()["activos"]["grupos"]
                 if g["grupo"] == "rentaFija")
    assert sorted(p["nombre"] for p in grupo["partidas"]) == ["Sin fecha", "Vigente"]
    assert grupo["total"] == 2100
