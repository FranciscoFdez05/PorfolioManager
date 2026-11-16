"""Pruebas de /api/hipotecas: validación, guardado y cálculo adjunto."""

import pytest


@pytest.fixture
def cliente(clienteAutenticado, tempDb, monkeypatch):
    from routes.hipotecas import hipotecasBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    client, cabeceras, _app = clienteAutenticado(hipotecasBp)
    return client, cabeceras


def _fija(**cambios):
    datos = {"alias": "Casa", "tipo": "fija", "capital": "200000", "fechaInicio": "2020-01-01",
             "plazoMeses": 360, "tin": "3"}
    datos.update(cambios)
    return datos


def _guardar(client, cabeceras, *filas):
    return client.post("/api/hipotecas", json={"rows": list(filas)}, headers=cabeceras)


def testSinHipotecasDevuelveListaVacia(cliente):
    client, _ = cliente
    assert client.get("/api/hipotecas").get_json() == {"rows": []}


def testGuardaYDevuelveElCalculo(cliente):
    client, cabeceras = cliente
    resp = _guardar(client, cabeceras, _fija())
    assert resp.status_code == 200
    fila = client.get("/api/hipotecas").get_json()["rows"][0]
    assert fila["id"]
    assert fila["calculo"]["resumen"]["totalCuotas"] == 360
    assert fila["calculo"]["cuadro"][0]["cuota"] == 843.21


def testVariableUsaElEuriborMasDiferencial(cliente):
    client, cabeceras = cliente
    fila = _fija(tipo="variable", tin="2", diferencial="1", revisionMeses=12,
                 euribor=[{"fecha": "2021-01-01", "valor": "2"}])
    _guardar(client, cabeceras, fila)
    cuadro = client.get("/api/hipotecas").get_json()["rows"][0]["calculo"]["cuadro"]
    assert cuadro[0]["tipo"] == 2.0
    assert cuadro[12]["tipo"] == 3.0


def testCapitalNegativoSeRechaza(cliente):
    client, cabeceras = cliente
    assert _guardar(client, cabeceras, _fija(capital="-5")).status_code == 400


def testFechaInvalidaSeRechaza(cliente):
    client, cabeceras = cliente
    assert _guardar(client, cabeceras, _fija(fechaInicio="2020-13-45")).status_code == 400


def testRevisionDistintaDeSeisOdoceSeRechaza(cliente):
    client, cabeceras = cliente
    assert _guardar(client, cabeceras, _fija(revisionMeses=5)).status_code == 400


def testIdsRepetidosSeRechazan(cliente):
    client, cabeceras = cliente
    assert _guardar(client, cabeceras, _fija(id="a"), _fija(id="a")).status_code == 400


def testGuardarSustituyeElListado(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, _fija(), _fija(alias="Otra"))
    _guardar(client, cabeceras, _fija(alias="Sola"))
    filas = client.get("/api/hipotecas").get_json()["rows"]
    assert [f["alias"] for f in filas] == ["Sola"]


def testAmortizacionAnticipadaAcortaElCuadro(cliente):
    client, cabeceras = cliente
    fila = _fija(amortizaciones=[{"fecha": "2022-01-01", "importe": "50000", "modo": "plazo"}])
    _guardar(client, cabeceras, fila)
    calculo = client.get("/api/hipotecas").get_json()["rows"][0]["calculo"]
    assert calculo["resumen"]["totalCuotas"] < 360
    assert calculo["resumen"]["ahorroIntereses"] > 0


def _idDeLaHipoteca(client, cabeceras, **cambios):
    _guardar(client, cabeceras, _fija(**cambios))
    return client.get("/api/hipotecas").get_json()["rows"][0]["id"]


def _simular(client, cabeceras, hipotecaId, **cuerpo):
    return client.post(f"/api/hipotecas/{hipotecaId}/simulacion", json=cuerpo, headers=cabeceras)


def testSimulacionDevuelveLosTresEscenarios(cliente):
    client, cabeceras = cliente
    hipotecaId = _idDeLaHipoteca(client, cabeceras, fechaInicio="2024-01-01")
    resp = _simular(client, cabeceras, hipotecaId, importe="20000")
    assert resp.status_code == 200
    datos = resp.get_json()
    assert datos["plazo"]["mesesAhorrados"] > 0
    assert datos["plazo"]["cuotaTrasElPago"] == datos["actual"]["cuotaTrasElPago"]
    assert datos["cuota"]["mesesAhorrados"] == 0
    assert datos["cuota"]["cuotaTrasElPago"] < datos["actual"]["cuotaTrasElPago"]
    assert datos["cuota"]["cuotaDiferencia"] > 0
    assert datos["plazo"]["ahorroIntereses"] > datos["cuota"]["ahorroIntereses"] > 0


def testSimulacionNoGuardaNada(cliente):
    client, cabeceras = cliente
    hipotecaId = _idDeLaHipoteca(client, cabeceras, fechaInicio="2024-01-01")
    _simular(client, cabeceras, hipotecaId, importe="20000")
    assert client.get("/api/hipotecas").get_json()["rows"][0]["amortizaciones"] == []


def testSimulacionDeHipotecaInexistenteDa404(cliente):
    client, cabeceras = cliente
    assert _simular(client, cabeceras, "no-existe", importe="100").status_code == 404


def testSimulacionRechazaImporteMayorQueElPendiente(cliente):
    client, cabeceras = cliente
    hipotecaId = _idDeLaHipoteca(client, cabeceras, fechaInicio="2024-01-01")
    assert _simular(client, cabeceras, hipotecaId, importe="999999").status_code == 400


def testSimulacionRechazaImporteVacioONegativo(cliente):
    client, cabeceras = cliente
    hipotecaId = _idDeLaHipoteca(client, cabeceras, fechaInicio="2024-01-01")
    assert _simular(client, cabeceras, hipotecaId).status_code == 400
    assert _simular(client, cabeceras, hipotecaId, importe="-5").status_code == 400


def testSimulacionRechazaFechaPasada(cliente):
    client, cabeceras = cliente
    hipotecaId = _idDeLaHipoteca(client, cabeceras, fechaInicio="2024-01-01")
    assert _simular(client, cabeceras, hipotecaId, importe="1000", fecha="2020-01-01").status_code == 400


def testSimulacionDeHipotecaLiquidadaSeRechaza(cliente):
    client, cabeceras = cliente
    hipotecaId = _idDeLaHipoteca(client, cabeceras, fechaInicio="2000-01-01", plazoMeses=12)
    assert _simular(client, cabeceras, hipotecaId, importe="100").status_code == 400
