"""Valor de mercado de las conversiones cripto (`activo_conversion_rows.valor_eur`).

Convertir una cripto en otra es una permuta y su ganancia sale del valor en euros
en ese momento, que la aplicación no puede reconstruir: lo anota el usuario. Aquí
se comprueba la migración 26, la ida y vuelta por API, export/import y backup, y
que una permuta con valor ya no sale con incidencia.
"""

import io
import json
import sqlite3

import pytest


@pytest.fixture
def cliente(clienteAutenticado, tempDb, monkeypatch):
    from routes.activos import activosBp
    from routes.ajustes import ajustesBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(activosBp, ajustesBp)
    return client, cabeceras


def _fichaConConversion(client, cabeceras, **fila):
    client.post("/api/activos", json={"name": "Bitcoin", "type": "cripto"}, headers=cabeceras)
    ficha = client.get("/api/activos/bitcoin").get_json()
    ficha["conversionRows"] = [{
        "id": "c1", "fecha": "10-01-2026", "par": "BTC/ETH", "tipo": "BTC convertidos", "cantidad": "0,01",
        **fila,
    }]
    return client.post("/api/activos/bitcoin", json=ficha, headers=cabeceras)


def testLaMigracion26AnadeLaColumnaVaciaSinTocarLasConversiones(tempDb):
    from core import db

    conexion = db.getDb()
    conexion.execute("INSERT INTO activos (id, name) VALUES ('bitcoin', 'Bitcoin')")
    conexion.execute("ALTER TABLE activo_conversion_rows DROP COLUMN valor_eur")
    conexion.execute(
        "INSERT INTO activo_conversion_rows (id, asset_id, fecha, par, tipo, cantidad) "
        "VALUES ('c1', 'bitcoin', '10-01-2026', 'BTC/ETH', 'BTC convertidos', '0,01')"
    )
    conexion.execute("PRAGMA user_version = 25")

    db._migrate(conexion)

    fila = conexion.execute("SELECT cantidad, valor_eur FROM activo_conversion_rows WHERE id = 'c1'").fetchone()
    assert tuple(fila) == ("0,01", "")
    assert conexion.execute("PRAGMA user_version").fetchone()[0] == db.ESQUEMA_VERSION >= 26


def testElValorEnEurosSeGuardaEnFormatoCanonicoYSeDevuelve(cliente):
    client, cabeceras = cliente

    # Se acepta el formato español y se guarda en canónico.
    assert _fichaConConversion(client, cabeceras, valorEur="1.234,5").status_code == 200

    assert client.get("/api/activos/bitcoin").get_json()["conversionRows"][0]["valorEur"] == "1234.5"


def testUnaConversionSinValorLoDevuelveVacio(cliente):
    client, cabeceras = cliente

    assert _fichaConConversion(client, cabeceras).status_code == 200

    assert client.get("/api/activos/bitcoin").get_json()["conversionRows"][0]["valorEur"] == ""


@pytest.mark.parametrize("valor", ["-5", "abc"])
def testUnValorNegativoOIlegibleSeRechazaConUn400(cliente, valor):
    client, cabeceras = cliente

    respuesta = _fichaConConversion(client, cabeceras, valorEur=valor)

    assert respuesta.status_code == 400
    assert "valor en euros" in respuesta.get_json()["error"].lower()
    assert client.get("/api/activos/bitcoin").get_json()["conversionRows"] == []


def testElValorViajaEnElExportYEnLaImportacionJson(cliente):
    from core.db import getDb

    client, cabeceras = cliente
    assert _fichaConConversion(client, cabeceras, valorEur="150").status_code == 200

    exportado = client.get("/api/export/json").get_data(as_text=True)
    assert json.loads(exportado)["tables"]["activo_conversion_rows"][0]["valor_eur"] == "150"

    conn = getDb()
    conn.execute("UPDATE activo_conversion_rows SET valor_eur = ''")
    conn.commit()
    respuesta = client.post(
        "/api/import/json", data={"file": (io.BytesIO(exportado.encode("utf-8")), "export.json")},
        headers=cabeceras, content_type="multipart/form-data",
    )

    assert respuesta.status_code == 200
    assert client.get("/api/activos/bitcoin").get_json()["conversionRows"][0]["valorEur"] == "150"


def testElValorViajaEnLaCopiaDeSeguridad(cliente, tmp_path):
    from admin import backup_manager
    from core.db import getActiveDbPath, getDb

    client, cabeceras = cliente
    assert _fichaConConversion(client, cabeceras, valorEur="150").status_code == 200
    getDb().commit()

    copia = tmp_path / "copia.db"
    backup_manager._checkpointAndCopy(getActiveDbPath(), copia)

    conexion = sqlite3.connect(copia)
    try:
        assert conexion.execute("SELECT valor_eur FROM activo_conversion_rows").fetchone()[0] == "150"
    finally:
        conexion.close()


def testUnaPermutaConValorYaNoSaleConIncidenciaYDeclaraLaGanancia(cliente):
    from stores import ventas_fifo

    client, cabeceras = cliente
    client.post("/api/activos", json={"name": "Bitcoin", "type": "cripto"}, headers=cabeceras)
    ficha = client.get("/api/activos/bitcoin").get_json()
    ficha["rows"] = [{"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra", "participaciones": "1",
                      "capitalInvertidoBruto": "100", "currency": "EUR"}]
    ficha["conversionRows"] = [{
        "id": "c1", "fecha": "01-06-2025", "par": "BTC/ETH", "tipo": "BTC convertidos", "cantidad": "1",
        "valorEur": "150",
    }]
    assert client.post("/api/activos/bitcoin", json=ficha, headers=cabeceras).status_code == 200
    ventas_fifo._cacheHilo.clave = None

    permuta = ventas_fifo.calcularTodo()["permutas"]["2025"][0]

    assert permuta["incidencia"] == ""
    assert permuta["dineroDeclarar"] == "50.00"


def testLaComisionEnCriptoDeUnaSalidaRestaDelValorDeTransmisionEnProporcion(cliente):
    from stores import ventas_fifo

    client, cabeceras = cliente
    client.post("/api/activos", json={"name": "Bitcoin", "type": "cripto", "symbol": "BTC"}, headers=cabeceras)
    ficha = client.get("/api/activos/bitcoin").get_json()
    ficha["rows"] = [{"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra", "participaciones": "1",
                      "capitalInvertidoBruto": "100", "currency": "EUR"}]
    ficha["conversionRows"] = [{
        "id": "c1", "fecha": "01-06-2025", "par": "BTC/ETH", "tipo": "BTC convertidos", "cantidad": "1",
        "valorEur": "150", "comision": "0.01", "comisionMoneda": "btc",
    }]
    client.post("/api/activos/bitcoin", json=ficha, headers=cabeceras)
    ventas_fifo._cacheHilo.clave = None

    permuta = ventas_fifo.calcularTodo()["permutas"]["2025"][0]

    # 0,01 de 1 BTC entregado vale el 1 % de 150 = 1,5 euros: transmisión 148,5 y ganancia 48,5.
    assert permuta["valorTransmision"] == "148.50"
    assert permuta["dineroDeclarar"] == "48.50"


def testLaComisionEnUnaMonedaAjenaAlParNoSeValora(cliente):
    from stores import ventas_fifo

    client, cabeceras = cliente
    client.post("/api/activos", json={"name": "Bitcoin", "type": "cripto", "symbol": "BTC"}, headers=cabeceras)
    ficha = client.get("/api/activos/bitcoin").get_json()
    ficha["rows"] = [{"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra", "participaciones": "1",
                      "capitalInvertidoBruto": "100", "currency": "EUR"}]
    ficha["conversionRows"] = [{
        "id": "c1", "fecha": "01-06-2025", "par": "BTC/ETH", "tipo": "BTC convertidos", "cantidad": "1",
        "valorEur": "150", "comision": "2", "comisionMoneda": "EUR",
    }]
    client.post("/api/activos/bitcoin", json=ficha, headers=cabeceras)
    ventas_fifo._cacheHilo.clave = None

    assert ventas_fifo.calcularTodo()["permutas"]["2025"][0]["valorTransmision"] == "150.00"
