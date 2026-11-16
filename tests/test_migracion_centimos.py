"""Migración del paso 35: importes de cuentas, transferencias, gastos e ingresos a céntimos.

Lo que más importa de una migración de datos no es que corra, sino que lo que
se lee después sea lo mismo que antes. Por eso se comprueba la equivalencia de
los saldos con los datos en texto y ya convertidos, que la migración no pierda
lo que no cabe en céntimos, que sea idempotente y que un fallo revierta el paso.
"""

from decimal import Decimal

import pytest

from core import centimos, db

COLUMNAS_A = (
    ("gastos_rows", "cantidad_cent"),
    ("ingresos_rows", "cantidad_cent"),
    ("transferencias", "cantidad_cent"),
    ("transferencias", "comision_cent"),
    ("cuentas", "saldo_inicial_cent"),
)
COLUMNAS_B = tuple((tabla, f"{col}_cent") for tabla, col in centimos.COLUMNAS_FASE_B)
COLUMNAS_C = tuple((spec[0], f"{spec[1]}_cent") for spec in centimos.COLUMNAS_FASE_C)
COLUMNAS_D = tuple((spec[0], f"{spec[1]}_cent") for spec in centimos.COLUMNAS_FASE_D)
COLUMNAS_E = tuple((spec[0], f"{spec[1]}_cent") for spec in centimos.COLUMNAS_FASE_E)
COLUMNAS_F = tuple((spec[0], f"{spec[1]}_cent") for spec in centimos.COLUMNAS_FASE_F)
COLUMNAS = COLUMNAS_A + COLUMNAS_B + COLUMNAS_C + COLUMNAS_D + COLUMNAS_E + COLUMNAS_F


@pytest.fixture
def conn(tempDb):
    return db.getDb()


def _volverAlEsquema34(conn):
    """Deja la base como estaba antes del paso 35: sin columnas `_cent`."""
    for tabla, columna in COLUMNAS:
        conn.execute(f"ALTER TABLE {tabla} DROP COLUMN {columna}")
    conn.execute("PRAGMA user_version = 34")
    conn.commit()


def _sembrarTexto(conn):
    conn.execute("UPDATE cuentas SET saldo_inicial = '1000.00' WHERE id = 'banco'")
    conn.executemany(
        "INSERT INTO gastos_rows (year, month, fecha, nombre, tipo, cantidad) VALUES ('2026', 'enero', ?, ?, 'x', ?)",
        [("05-01-2026", "luz", "40,00 €"), ("06-01-2026", "agua", "1.234,56 €"), ("07-01-2026", "raro", "0,005"),
         ("08-01-2026", "dolares", "12 $"), ("09-01-2026", "vacio", "")],
    )
    conn.execute(
        "INSERT INTO ingresos_rows (year, month, fecha, nombre, tipo, cantidad) "
        "VALUES ('2026', 'enero', '01-01-2026', 'nomina', 'x', '2.000,00 €')"
    )
    conn.execute(
        "INSERT INTO transferencias (fecha, origen, destino, cantidad, comision) "
        "VALUES ('02-01-2026', 'banco', 'ahorro', '100,00 €', '1,50 €')"
    )
    conn.commit()


def _saldoBanco(conn):
    from stores.cuentas_store import saldos

    return saldos(conn, hoy=__import__("datetime").date(2026, 12, 31))["banco"]["saldo"]


def testUnaBaseNuevaNaceEnLaVersionActualConLasColumnas(conn):
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.ESQUEMA_VERSION
    for tabla, columna in COLUMNAS:
        assert columna in {f[1] for f in conn.execute(f"PRAGMA table_info({tabla})")}


def testMigrarConvierteLoExactoYConservaLoDemas(conn):
    _volverAlEsquema34(conn)
    _sembrarTexto(conn)
    # Las filas se siembran en el esquema viejo: sin columnas `_cent` aún.
    db._migrate(conn)

    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.ESQUEMA_VERSION
    gastos = {f["nombre"]: (f["cantidad"], f["cantidad_cent"]) for f in conn.execute("SELECT * FROM gastos_rows")}
    assert gastos["luz"] == ("", 4000)
    assert gastos["agua"] == ("", 123456)
    assert gastos["raro"] == ("0,005", None)
    assert gastos["dolares"] == ("12 $", None)
    assert gastos["vacio"] == ("", None)
    assert conn.execute("SELECT cantidad_cent FROM ingresos_rows").fetchone()[0] == 200000
    transferencia = conn.execute("SELECT cantidad_cent, comision_cent FROM transferencias").fetchone()
    assert tuple(transferencia) == (10000, 150)
    assert conn.execute("SELECT saldo_inicial_cent FROM cuentas WHERE id = 'banco'").fetchone()[0] == 100000


def testElSaldoEsElMismoConElTextoQueConLosCentimos(conn):
    """Equivalencia: leer el texto antiguo y leer los céntimos da el mismo saldo."""
    _sembrarTexto(conn)
    antes = _saldoBanco(conn)

    centimos.convertirImportes(conn)
    conn.commit()

    despues = _saldoBanco(conn)
    assert antes == despues
    # 1000 inicial + 2000 ingreso - 40 - 1234,56 de gastos convertibles - 100 de
    # la transferencia - 1,50 de comisión. El 0,005 y los 12 $ no son
    # convertibles y siguen leyéndose del texto, igual que antes: `dinero` descarta el
    # símbolo y los lee como 0,005 y 12.
    assert despues == Decimal("1000") + Decimal("2000") - Decimal("40") - Decimal("1234.56") \
        - Decimal("0.005") - Decimal("12") - Decimal("100") - Decimal("1.50")


def testLaMigracionEsIdempotente(conn):
    _sembrarTexto(conn)
    centimos.convertirImportes(conn)
    antes = [tuple(f) for f in conn.execute("SELECT * FROM gastos_rows ORDER BY id")]

    assert all(convertidas == 0 for convertidas, _ in centimos.convertirImportes(conn).values())
    assert [tuple(f) for f in conn.execute("SELECT * FROM gastos_rows ORDER BY id")] == antes


def testSiLaSumaNoCuadraElPasoSeRevierteEntero(conn, monkeypatch):
    _volverAlEsquema34(conn)
    _sembrarTexto(conn)
    monkeypatch.setattr(centimos, "aCentimos", lambda texto: 1)

    with pytest.raises(centimos.MigracionImportesError):
        db._migrate(conn)

    # Ni la versión ni las columnas: el paso no quedó a medias.
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 34
    assert "cantidad_cent" not in {f[1] for f in conn.execute("PRAGMA table_info(gastos_rows)")}
    assert conn.execute("SELECT cantidad FROM gastos_rows WHERE nombre = 'luz'").fetchone()[0] == "40,00 €"


def testMigrarGuardaLaCopiaPrevia(conn, tempDb):
    _volverAlEsquema34(conn)
    db._migrate(conn, tempDb)
    from admin import backup_manager

    copias = list(backup_manager._BACKUP_DIR.glob(f"{tempDb.stem}_pre-esquema-34-a-{db.ESQUEMA_VERSION}_*.db"))
    assert copias, "no se creó la copia previa a la migración"


def testLoEscritoDespuesTambienVaEnCentimos(conn):
    from stores.cuentas_store import crearCuenta, crearTransferencia, listarTransferencias

    crearCuenta("Cuenta nomina", "banco", saldoInicial="1000")
    cuenta = conn.execute("SELECT saldo_inicial, saldo_inicial_cent FROM cuentas WHERE nombre = 'Cuenta nomina'").fetchone()
    assert tuple(cuenta) == ("", 100000)

    crearTransferencia("banco", "ahorro", "10-01-2026", "250,75", comision="1,5")
    fila = conn.execute("SELECT cantidad, cantidad_cent, comision, comision_cent FROM transferencias").fetchone()
    assert tuple(fila) == ("", 25075, "", 150)
    # La API sigue hablando en texto, con el mismo formato de siempre.
    transferencia = listarTransferencias(conn)[0]
    assert transferencia["cantidad"] == "250,75 €"
    assert transferencia["comision"] == "1,50 €"


def _sembrarRecurrentes(conn):
    mens = ", ".join(["year", "nombre", "enero", "febrero", "marzo", "importe"])
    conn.execute(f"INSERT INTO mensualidades ({mens}) VALUES ('2026', 'gimnasio', '30,00 €', '30,00 €', '0,005', '30,00 €')")
    conn.execute(f"INSERT INTO ingresos_recurrentes ({mens}) VALUES ('2026', 'sueldo', '1.500,00 €', '1.500,00 €', '', '1.500,00 €')")
    conn.commit()


def testLaFaseBConvierteMensualidadesYRecurrentes(conn):
    _volverAlEsquema34(conn)
    _sembrarRecurrentes(conn)
    db._migrate(conn)

    mens = conn.execute("SELECT enero, enero_cent, marzo, marzo_cent, importe, importe_cent FROM mensualidades").fetchone()
    assert tuple(mens) == ("", 3000, "0,005", None, "", 3000)
    rec = conn.execute("SELECT enero_cent, marzo, marzo_cent, importe_cent FROM ingresos_recurrentes").fetchone()
    assert tuple(rec) == (150000, "", None, 150000)


def testElSaldoEsElMismoConLasRecurrentesEnTextoQueEnCentimos(conn):
    _sembrarRecurrentes(conn)
    antes = _saldoBanco(conn)
    centimos.convertirImportes(conn, centimos.COLUMNAS_FASE_B)
    conn.commit()
    assert _saldoBanco(conn) == antes
    # sueldo 2 x 1.500 - gimnasio 2 x 30 - 0,005 de marzo (no convertible, sigue en texto)
    assert antes == Decimal("3000") - Decimal("60") - Decimal("0.005")


def testGuardarYLeerMensualidadesDaElMismoTexto(conn):
    from stores.gastos_store import createDefaultGastosYear, readGastosYear, writeGastosYear

    datos = createDefaultGastosYear("2026")
    datos["mensualidades"] = [{"nombre": "gimnasio", "importe": "30 €", "meses": {"enero": "30,00 €", "febrero": "0,005"}}]
    writeGastosYear("2026", datos)

    fila = conn.execute("SELECT enero, enero_cent, febrero, febrero_cent, importe_cent FROM mensualidades").fetchone()
    assert tuple(fila) == ("", 3000, "0,005", None, 3000)
    leida = readGastosYear("2026")["mensualidades"][0]
    assert leida["importe"] == "30,00 €"
    assert leida["meses"]["enero"] == "30,00 €"
    assert leida["meses"]["febrero"] == "0,005"
    assert leida["meses"]["marzo"] == ""


def testLasCuotasDeUnaDeudaNoSeReescribenSiNoHayCambios(conn):
    from stores.deudas_mensualidades import sincronizarAnio
    from stores.hipotecas_store import guardarHipotecas, sanearListado

    guardarHipotecas(sanearListado([{
        "alias": "Casa", "tipo": "fija", "capital": "100000", "fechaInicio": "2026-01-01",
        "plazoMeses": 120, "tin": "3",
    }]))
    fila = conn.execute("SELECT importe_cent, enero_cent, financiacion_id FROM mensualidades WHERE year = '2026'").fetchone()
    assert fila["importe_cent"] and fila["financiacion_id"].startswith("hipoteca:")
    # Segunda sincronización: lo guardado en céntimos y lo generado en texto deben
    # coincidir, o cada guardado reescribiría las cuotas y avanzaría la revisión.
    assert sincronizarAnio(conn, "2026") is False


def _sembrarFaseC(conn):
    conn.execute("INSERT INTO cuentas_remuneradas (id, nombre) VALUES ('r1', 'Remunerada')")
    conn.execute("INSERT INTO cuenta_remunerada_vinculo (remunerada_id, cuenta_id) VALUES ('r1', 'banco')")
    conn.execute("INSERT INTO intereses_v2 (cuenta_id, fecha, acumulado, impuestos) VALUES ('r1', '01-2026', '10,00 €', '1,90 €')")
    conn.executemany(
        "INSERT INTO dividendos (fecha, instrumento, total, impuestos, moneda_total) VALUES (?, ?, ?, ?, ?)",
        [("05-03-2026", "EURO", "25,50 €", "4,00 €", "EUR"), ("06-03-2026", "DOLAR", "12,50", "1,00", "USD")],
    )
    conn.execute("INSERT INTO renta_fija (instrumento, currency, invertido, interes_acumulado, impuestos) "
                 "VALUES ('letra', 'EUR', '1.000,00 €', '20,00 €', '3,80 €')")
    conn.execute("INSERT INTO bonos (instrumento, currency, invertido) VALUES ('bono usd', 'USD', '500,00')")
    conn.commit()


def testLaFaseCSoloConviertePorFilasEnEuros(conn):
    _volverAlEsquema34(conn)
    _sembrarFaseC(conn)
    db._migrate(conn)

    euro, dolar = conn.execute("SELECT total, total_cent, impuestos_cent FROM dividendos ORDER BY id").fetchall()
    assert tuple(euro) == ("", 2550, 400)
    # Una fila en dólares se queda como texto: `_cent` se lee siempre como euros.
    assert tuple(dolar) == ("12,50", None, None)
    assert tuple(conn.execute("SELECT invertido_cent, interes_acumulado_cent FROM renta_fija").fetchone()) == (100000, 2000)
    assert tuple(conn.execute("SELECT invertido, invertido_cent FROM bonos").fetchone()) == ("500,00", None)
    assert tuple(conn.execute("SELECT acumulado_cent, impuestos_cent FROM intereses_v2").fetchone()) == (1000, 190)


def testElSaldoEsElMismoConInteresesYDividendosEnTextoQueEnCentimos(conn):
    _sembrarFaseC(conn)
    antes = _saldoBanco(conn)
    centimos.convertirImportes(conn, centimos.COLUMNAS_FASE_C)
    conn.commit()
    assert _saldoBanco(conn) == antes


def testLeerYEscribirDividendosEnEurosYEnDolares(conn):
    from stores.app_data import readDividendosFile, writeDividendosFile

    base = {"fecha": "05-03-2026", "instrumento": "X", "acciones": "", "dividendoAccion": "", "cuenta": ""}
    writeDividendosFile({"rows": [
        {**base, "total": "25,5", "impuestos": "4", "monedaDividendo": "EUR", "monedaTotal": "EUR"},
        {**base, "total": "12,5", "impuestos": "1", "monedaDividendo": "USD", "monedaTotal": "USD"},
    ]})
    crudas = conn.execute("SELECT total, total_cent FROM dividendos ORDER BY id").fetchall()
    assert [tuple(f) for f in crudas] == [("", 2550), ("12,5", None)]
    leidas = readDividendosFile()["rows"]
    assert (leidas[0]["total"], leidas[0]["impuestos"]) == ("25,50 €", "4,00 €")
    assert (leidas[1]["total"], leidas[1]["impuestos"]) == ("12,5", "1")


def testLaFaseDConvierteDeudasYVentasEnEuros(conn):
    _volverAlEsquema34(conn)
    conn.execute("INSERT INTO hipotecas (id, alias, capital) VALUES ('h', 'Casa', '150000')")
    conn.execute("INSERT INTO financiaciones (id, articulo, precio, entrada) VALUES ('f', 'TV', '999.99', '0')")
    conn.execute("INSERT INTO microcreditos (id, nombre, importe, comision) VALUES ('m', 'Rapido', '300', '45.5')")
    conn.executemany(
        "INSERT INTO ventas (id, year, valor_venta, comision_venta, currency) VALUES (?, '2026', ?, ?, ?)",
        [("v1", "1.000,00 €", "5,00 €", "EUR"), ("v2", "1.100,00", "6,00", "USD")],
    )
    db._migrate(conn)

    assert conn.execute("SELECT capital, capital_cent FROM hipotecas").fetchone()[:] == ("", 15000000)
    assert tuple(conn.execute("SELECT precio_cent, entrada_cent FROM financiaciones").fetchone()) == (99999, 0)
    assert tuple(conn.execute("SELECT importe_cent, comision_cent FROM microcreditos").fetchone()) == (30000, 4550)
    v1, v2 = conn.execute("SELECT valor_venta, valor_venta_cent, comision_venta_cent FROM ventas ORDER BY id").fetchall()
    assert tuple(v1) == ("", 100000, 500)
    assert tuple(v2) == ("1.100,00", None, None)


def testLasDeudasVuelvenConElMismoTextoCanonico(conn):
    from stores.hipotecas_store import guardarHipotecas, listarHipotecas, sanearListado
    from stores.microcreditos_store import guardarMicrocreditos, listarMicrocreditos, sanearListado as sanearMicro

    guardarHipotecas(sanearListado([{
        "alias": "Casa", "tipo": "fija", "capital": "150000.5", "fechaInicio": "2026-01-01", "plazoMeses": 120, "tin": "3",
    }]))
    assert conn.execute("SELECT capital, capital_cent FROM hipotecas").fetchone()[:] == ("", 15000050)
    assert listarHipotecas()[0]["capital"] == "150000.5"

    guardarMicrocreditos(sanearMicro([{
        "nombre": "Rapido", "modo": "unico", "importe": "300", "comision": "45", "fechaInicio": "2026-01-01",
        "fechaVencimiento": "2026-02-01",
    }]))
    leido = listarMicrocreditos()[0]
    assert (leido["importe"], leido["comision"]) == ("300", "45")


def testLasVentasEnEurosVanACentimosYLasDeOtraDivisaNo(conn):
    from stores.ventas_store import readVentasYear, writeVentasYear

    conn.execute("INSERT INTO activos (id, name, currency) VALUES ('a', 'Activo', 'EUR'), ('b', 'Activo USD', 'USD')")
    conn.commit()
    writeVentasYear("2026", {"year": "2026", "rows": [
        {"id": "v1", "assetId": "a", "fecha": "01-03-2026", "cantidad": "1", "valorVenta": "100", "comisionVenta": "1"},
        {"id": "v2", "assetId": "b", "fecha": "02-03-2026", "cantidad": "1", "valorVenta": "110", "comisionVenta": "2"},
    ]})
    crudas = conn.execute("SELECT valor_venta, valor_venta_cent FROM ventas ORDER BY id").fetchall()
    assert [tuple(f) for f in crudas] == [("", 10000), ("110", None)]
    filas = readVentasYear("2026")["rows"]
    assert [f["valorVenta"] for f in filas] == ["100,00 €", "110"]


def testLaFaseEConvierteTradingMercadoPrivadoYStablecoinsEnEuros(conn):
    _volverAlEsquema34(conn)
    conn.executemany(
        "INSERT INTO trading (id, capital, capital_currency, ganancia, ganancia_neta) VALUES (?, ?, ?, ?, ?)",
        [("t1", "1.000,00 €", "EUR", "50,00 €", "45,00 €"), ("t2", "1.000,00", "USD", "50,00", "45,00")],
    )
    conn.executemany(
        "INSERT INTO private_market (nombre, currency, comprometido, llamado, distribuido, valor_actual) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [("fondo", "EUR", "100.000,00 €", "40.000,00 €", "5.000,00 €", "52.000,00 €"),
         ("fondo usd", "USD", "100.000,00", "", "", "")],
    )
    conn.executemany(
        "INSERT INTO stablecoins_rows (id, total, comisiones, currency) VALUES (?, ?, ?, ?)",
        [("s1", "100,00 €", "0,50 €", "EUR"), ("s2", "100,00", "0,50", "USD")],
    )
    db._migrate(conn)

    t1, t2 = conn.execute("SELECT capital, capital_cent, ganancia_cent, ganancia_neta_cent FROM trading ORDER BY id").fetchall()
    assert tuple(t1) == ("", 100000, 5000, 4500)
    assert tuple(t2) == ("1.000,00", None, None, None)
    fondo = conn.execute("SELECT comprometido_cent, llamado_cent, distribuido_cent, valor_actual_cent "
                         "FROM private_market WHERE nombre = 'fondo'").fetchone()
    assert tuple(fondo) == (10000000, 4000000, 500000, 5200000)
    assert conn.execute("SELECT comprometido_cent FROM private_market WHERE nombre = 'fondo usd'").fetchone()[0] is None
    assert [tuple(f) for f in conn.execute("SELECT total_cent, comisiones_cent FROM stablecoins_rows ORDER BY id")] == [
        (10000, 50), (None, None)]


def testTradingMercadoPrivadoYStablecoinsVuelvenConElTextoDePresentacion(conn):
    from stores.app_data import (
        readPrivateMarketFile,
        readStablecoinsFile,
        readTradingFile,
        writePrivateMarketFile,
        writeStablecoinsFile,
        writeTradingFile,
    )

    writeTradingFile({"rows": [
        {"id": "t1", "capital": "1000", "capital_currency": "EUR", "ganancia": "50,5", "ganancia_neta": "45"},
        {"id": "t2", "capital": "1000", "capital_currency": "USD", "ganancia": "50,5", "ganancia_neta": "45"},
    ]})
    t1, t2 = readTradingFile()["rows"]
    assert (t1["capital"], t1["ganancia"], t1["ganancia_neta"]) == ("1.000,00 €", "50,50 €", "45,00 €")
    assert (t2["capital"], t2["ganancia"], t2["ganancia_neta"]) == ("1000", "50,5", "45")

    writePrivateMarketFile({"rows": [{"nombre": "f", "currency": "EUR", "comprometido": "100000", "valorActual": "52000,5"}]})
    fondo = readPrivateMarketFile()["rows"][0]
    assert (fondo["comprometido"], fondo["llamado"], fondo["valorActual"]) == ("100.000,00 €", "", "52.000,50 €")

    writeStablecoinsFile({"catalog": [], "enabledSymbols": [], "rows": [
        {"id": "s1", "total": "100", "comisiones": "0,5", "currency": "EUR", "cantidad": "100,12345678", "precio": "0,9999"},
        {"id": "s2", "total": "100", "comisiones": "0,5", "currency": "USD"},
    ]})
    s1, s2 = readStablecoinsFile()["rows"]
    assert (s1["total"], s1["comisiones"]) == ("100,00 €", "0,50 €")
    assert (s1["cantidad"], s1["precio"]) == ("100,12345678", "0,9999")
    assert (s2["total"], s2["comisiones"]) == ("100", "0,5")


def _sembrarNucleo(conn):
    conn.execute("INSERT INTO activos (id, name, currency, type) VALUES ('a', 'Accion', 'EUR', 'acciones')")
    conn.execute("INSERT INTO activos (id, name, currency, type) VALUES ('b', 'Accion USD', 'USD', 'acciones')")
    conn.executemany(
        "INSERT INTO activo_rows (asset_id, currency, participaciones, precio_participacion, "
        "capital_invertido_bruto, comisiones, comisiones_fiat) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [("a", "EUR", "10", "100,00", "1.000,00 €", "2,00 €", "1,00 €"),
         ("b", "USD", "10", "100,00", "1.000,00", "2,00", "1,00")],
    )
    conn.execute(
        "INSERT INTO activo_operation_rows (id, asset_id, estado, currency, cantidad, precio_orden, total, comisiones_fiat) "
        "VALUES ('o1', 'a', 'Completado', 'EUR', '0,1', '50000', '5.000,00 €', '1,50 €')"
    )
    conn.execute(
        "INSERT INTO activo_conversion_rows (id, asset_id, cantidad, comision, comision_moneda, valor_eur) "
        "VALUES ('c1', 'a', '1', '0,5', 'EUR', '123.45')"
    )
    conn.execute(
        "INSERT INTO activo_conversion_rows (id, asset_id, cantidad, comision, comision_moneda, valor_eur) "
        "VALUES ('c2', 'a', '1', '0,0001', 'BTC', '10')"
    )
    conn.commit()


def testLaFaseFConvierteElNucleoDeInversionSoloEnEuros(conn):
    _volverAlEsquema34(conn)
    _sembrarNucleo(conn)
    db._migrate(conn)

    a, b = conn.execute("SELECT capital_invertido_bruto_cent, comisiones_cent, comisiones_fiat_cent, precio_participacion "
                        "FROM activo_rows ORDER BY id").fetchall()
    assert tuple(a) == (100000, 200, 100, "100,00")
    assert tuple(b) == (None, None, None, "100,00")
    assert tuple(conn.execute("SELECT total_cent, comisiones_fiat_cent, precio_orden FROM activo_operation_rows")
                 .fetchone()) == (500000, 150, "50000")
    c1, c2 = conn.execute("SELECT comision_cent, comision, valor_eur_cent FROM activo_conversion_rows ORDER BY id").fetchall()
    assert tuple(c1) == (50, "", 12345)
    # Una comisión en BTC es una cantidad de cripto: no se convierte.
    assert tuple(c2) == (None, "0,0001", 1000)


def testLaFichaDelActivoVuelveConElMismoTextoYGuardaCentimos(conn):
    from stores.asset_store import readAssetFile, writeAssetFile

    conn.execute("INSERT INTO activos (id, name, currency, type) VALUES ('a', 'Accion', 'EUR', 'acciones')")
    conn.commit()
    writeAssetFile("a", {
        "name": "Accion", "currency": "EUR",
        "rows": [{"fechaOperacion": "01-03-2026", "tipoOperacion": "Compra", "currency": "EUR", "participaciones": "10",
                  "precioParticipacion": "100", "capitalInvertidoBruto": "1000", "comisiones": "2", "comisionesFiat": "1"},
                 {"fechaOperacion": "02-03-2026", "tipoOperacion": "Compra", "currency": "USD", "participaciones": "1",
                  "precioParticipacion": "10", "capitalInvertidoBruto": "10,5", "comisiones": "1", "comisionesFiat": ""}],
        "operationRows": [{"id": "o1", "orden": "Compra", "estado": "Completado", "currency": "EUR", "total": "5000",
                           "comisionesFiat": "1,5", "cantidad": "0,1", "precioOrden": "50000"}],
        "conversionRows": [{"id": "c1", "comision": "0,5", "comisionMoneda": "EUR", "valorEur": "123.45"}],
    })
    crudas = conn.execute("SELECT capital_invertido_bruto, capital_invertido_bruto_cent FROM activo_rows ORDER BY id").fetchall()
    assert [tuple(f) for f in crudas] == [("", 100000), ("10,5", None)]

    ficha = readAssetFile("a")
    assert [r["capitalInvertidoBruto"] for r in ficha["rows"]] == ["1.000,00 €", "10,5"]
    assert [r["comisionesFiat"] for r in ficha["rows"]] == ["1,00 €", ""]
    assert (ficha["operationRows"][0]["total"], ficha["operationRows"][0]["comisionesFiat"]) == ("5.000,00 €", "1,50 €")
    # Precios y cantidades no se tocan.
    assert (ficha["rows"][0]["precioParticipacion"], ficha["operationRows"][0]["precioOrden"]) == ("100", "50000")
    assert (ficha["conversionRows"][0]["valorEur"], ficha["conversionRows"][0]["comision"]) == ("123.45", "0.5")


def testLaSincronizacionDeOperacionesNoReescribeSiNoHayCambios(conn):
    from stores import revisiones
    from stores.app_data import readOperacionesFile, writeOperacionesFile
    from stores.helpers import syncCompletedOperationsIntoAssets

    conn.execute("INSERT INTO activos (id, name, currency, type) VALUES ('btc', 'Bitcoin', 'EUR', 'cripto')")
    conn.commit()
    writeOperacionesFile({"rows": [
        {"id": "o1", "assetId": "btc", "activo": "Bitcoin", "fechaApertura": "01-03-2026", "par": "BTC/EUR",
         "orden": "Compra", "precioOrden": "50000", "precioCurrency": "EUR", "cantidad": "0,1",
         "comisionesFiat": "1,5", "total": "5000", "currency": "EUR", "estado": "Completado",
         "fechaCierre": "01-03-2026"}]})
    filas = readOperacionesFile()["rows"]
    assert tuple(conn.execute("SELECT total, total_cent, comisiones_fiat_cent FROM operaciones").fetchone()) == ("", 500000, 150)

    syncCompletedOperationsIntoAssets(filas)
    copia = conn.execute("SELECT total, total_cent, comisiones_fiat_cent FROM activo_operation_rows").fetchone()
    assert tuple(copia) == ("", 500000, 150)

    antes = revisiones.leer(conn, "activos", "btc")
    syncCompletedOperationsIntoAssets(filas)
    # Segunda pasada: lo guardado en céntimos y lo deseado en texto coinciden, así
    # que no se reescribe ni avanza la revisión.
    assert revisiones.leer(conn, "activos", "btc") == antes
