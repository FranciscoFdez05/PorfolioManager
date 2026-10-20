"""Números que no caben en un entero o en un decimal no deben dar un 500.

`Infinity` y `1e999` los acepta el JSON de Flask; un entero de cientos de
dígitos también. Convertirlos con `int()`, `float()` o `Decimal.quantize` lanza
`OverflowError` o `InvalidOperation`, que no son `ValueError` y se escapaban de
los `except` que ya había.
"""

from decimal import Decimal

import pytest

CLAVES_ENTERAS = [
    "autoBackupDays", "staleHours", "autoRefreshMinutes", "snapshotMinutes",
    "precioDecimalesAcciones", "precioDecimalesEtf", "precioDecimalesComoditis",
    "precioDecimalesCripto", "bloqueoInactividad", "maxBackups",
]
VALORES = ["Infinity", "-Infinity", "1e999", "1" + "0" * 400]


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.ajustes import ajustesBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    client, cabeceras, _app = clienteAutenticado(ajustesBp)
    return client, {**cabeceras, "Content-Type": "application/json"}


@pytest.mark.parametrize("clave", CLAVES_ENTERAS)
@pytest.mark.parametrize("valor", VALORES)
def testAjusteEnteroConNumeroEnormeNoDa500(cliente, clave, valor):
    client, cabeceras = cliente
    respuesta = client.post("/api/settings", data=f'{{"{clave}": {valor}}}', headers=cabeceras)

    assert respuesta.status_code == 200
    assert client.get("/api/settings").status_code == 200


def testPanelesConEnteroEnormeNoDa500(cliente):
    client, cabeceras = cliente
    enorme = "1" + "0" * 400
    cuerpo = f'{{"panelesConfig":{{"paneles":[{{"id":"a","widgets":[{{"id":"w","tipo":"mapa","w":{enorme}}}]}}]}}}}'

    respuesta = client.post("/api/settings", data=cuerpo, headers=cabeceras)

    assert respuesta.status_code == 200
    widget = client.get("/api/settings").get_json()["panelesConfig"]["paneles"][0]["widgets"][0]
    assert widget["w"] == 6  # cae al valor de fábrica


def testPorcentajeConEnteroEnormeUsaElDefecto():
    from routes.ajustes import _porcentaje

    assert _porcentaje(10 ** 400, 7.0) == 7.0


def testRedondearUnImporteEnormeLanzaImporteInvalido():
    from core import dinero

    with pytest.raises(dinero.ImporteInvalido):
        dinero.redondear("1" + "0" * 30)
    assert dinero.redondear("12345678901234567890123456.99") == Decimal("12345678901234567890123456.99")


def testMovimientoConImporteEnormeEsUn400(tmp_path):
    from stores.movimientos_store import DatosMovimientoInvalidos, normalizarImporte

    with pytest.raises(DatosMovimientoInvalidos):
        normalizarImporte("1" + "0" * 30)


def testSnapshotConImporteEnormeEsUn400(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.snapshots import snapshotsBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(snapshotsBp)

    respuesta = client.post(
        "/api/portfolio/snapshot",
        json={"total_value": "1" + "0" * 30, "total_invested": "5"},
        headers=cabeceras,
    )

    assert respuesta.status_code == 400


def testLosImportesFiscalesRedondeanMedioArriba():
    from core.informe_renta import _es
    from stores.ventas_fifo import _money

    assert _money("0.125") == "0.13"
    assert _money("2.675") == "2.68"
    assert _money("0.123456785", escala="0.00000001") == "0.12345679"
    assert _es("0.125") == "0,13"
    assert _es("-1234.565") == "-1.234,57"
