"""Cuentas de dinero y transferencias: lo que mueve cada saldo y lo que no es un gasto."""

import datetime

import pytest

HOY = datetime.date(2026, 10, 5)


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.ajustes import ajustesBp
    from routes.cuenta_ahorro import cuentaAhorroBp
    from routes.cuentas import cuentasBp
    from routes.gastos import gastosBp
    from routes.ingresos import ingresosBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")

    client, cabeceras, _app = clienteAutenticado(cuentasBp, cuentaAhorroBp, gastosBp, ingresosBp, ajustesBp)
    return client, cabeceras


def _cuenta(client, cabeceras, nombre, tipo="exchange", **extra):
    res = client.post("/api/cuentas", json={"nombre": nombre, "tipo": tipo, **extra}, headers=cabeceras)
    assert res.status_code == 201, res.get_json()
    return res.get_json()["cuenta"]


def _transferir(client, cabeceras, origen, destino, cantidad, fecha="10-03-2026", **extra):
    return client.post(
        "/api/transferencias",
        json={"origen": origen, "destino": destino, "cantidad": cantidad, "fecha": fecha, **extra},
        headers=cabeceras,
    )


def _saldo(client, cuentaId):
    cuentas = client.get("/api/cuentas").get_json()["cuentas"]
    return float(next(c for c in cuentas if c["id"] == cuentaId)["saldo"])


def _guardarGastos(client, cabeceras, filas, year="2026", mes="marzo"):
    client.post(
        f"/api/gastos/{year}",
        json={"year": year, "months": {mes: {"rows": filas}}},
        headers=cabeceras,
    )


# ── Cuentas ──────────────────────────────────────────────────────────────────

def testSiempreExistenLaCuentaBancariaYLaDeAhorro(cliente):
    client, _cabeceras = cliente

    cuentas = client.get("/api/cuentas").get_json()["cuentas"]

    assert [(c["id"], c["tipo"]) for c in cuentas[:2]] == [("banco", "banco"), ("ahorro", "ahorro")]
    assert all(c["protegida"] for c in cuentas[:2])


def testSePuedenCrearCuentasDeCadaTipo(cliente):
    client, cabeceras = cliente

    for nombre, tipo in (
        ("Binance", "exchange"),
        ("Degiro", "broker"),
        ("BBVA", "banco"),
        ("Viaje", "ahorro"),
        ("Cartera", "metalico"),
    ):
        cuenta = _cuenta(client, cabeceras, nombre, tipo)
        assert cuenta["tipo"] == tipo

    nombres = [c["nombre"] for c in client.get("/api/cuentas").get_json()["cuentas"]]
    assert nombres == ["Cuenta bancaria", "Cuenta de ahorro", "Binance", "Degiro", "BBVA", "Viaje", "Cartera"]
    assert next(c for c in client.get("/api/cuentas").get_json()["cuentas"] if c["nombre"] == "Cartera")["tipo_etiqueta"] == "Metálico"


@pytest.mark.parametrize(
    "cuerpo",
    [
        {"nombre": "", "tipo": "exchange"},
        {"nombre": "X", "tipo": "otro"},
        {"nombre": "Cuenta bancaria", "tipo": "exchange"},
        {"nombre": "banco", "tipo": "exchange"},
        {"nombre": "Binance", "tipo": "exchange", "saldoInicial": "abc"},
    ],
)
def testLasCuentasInvalidasSeRechazan(cliente, cuerpo):
    client, cabeceras = cliente
    _cuenta(client, cabeceras, "Binance")

    assert client.post("/api/cuentas", json=cuerpo, headers=cabeceras).status_code == 400


def testElNombreNoSeRepiteAunqueCambienLasMayusculas(cliente):
    client, cabeceras = cliente
    _cuenta(client, cabeceras, "Binance")

    assert client.post("/api/cuentas", json={"nombre": "BINANCE", "tipo": "broker"}, headers=cabeceras).status_code == 400


def testRenombrarYPonerSaldoInicial(cliente):
    client, cabeceras = cliente
    cuenta = _cuenta(client, cabeceras, "Binance")

    res = client.put(
        f"/api/cuentas/{cuenta['id']}", json={"nombre": "Kraken", "saldoInicial": "1.500,50"}, headers=cabeceras
    )

    assert res.status_code == 200
    assert res.get_json()["cuenta"]["nombre"] == "Kraken"
    assert _saldo(client, cuenta["id"]) == 1500.50


def testLaCuentaBancariaSePuedeRenombrarPeroNoEliminar(cliente):
    client, cabeceras = cliente

    res = client.put("/api/cuentas/banco", json={"nombre": "BBVA nómina"}, headers=cabeceras)

    assert res.status_code == 200
    assert client.get("/api/cuentas").get_json()["cuentas"][0]["nombre"] == "BBVA nómina"
    assert client.delete("/api/cuentas/banco", headers=cabeceras).status_code == 400
    assert client.delete("/api/cuentas/ahorro", headers=cabeceras).status_code == 400


def testLaCuentaBancariaPuedeVolverALlamarseComoAlPrincipio(cliente):
    client, cabeceras = cliente
    client.put("/api/cuentas/banco", json={"nombre": "BBVA"}, headers=cabeceras)

    res = client.put("/api/cuentas/banco", json={"nombre": "Cuenta bancaria"}, headers=cabeceras)

    assert res.status_code == 200


def testLaCuentaBancariaRenombradaSigueSiendoLaDeLasFilasSinCuenta(cliente):
    client, cabeceras = cliente
    client.put("/api/cuentas/banco", json={"nombre": "BBVA"}, headers=cabeceras)
    _guardarGastos(client, cabeceras, [
        {"fecha": "12-03-2026", "nombre": "Cena", "tipo": "Comida", "cantidad": "30,00 €"},
    ])

    assert _saldo(client, "banco") == -30


def testNingunaOtraCuentaPuedeLlamarseComoLosAliasDeLaBancaria(cliente):
    client, cabeceras = cliente
    client.put("/api/cuentas/banco", json={"nombre": "BBVA"}, headers=cabeceras)

    assert client.post("/api/cuentas", json={"nombre": "Banco", "tipo": "exchange"}, headers=cabeceras).status_code == 400
    assert client.post("/api/cuentas", json={"nombre": "BBVA", "tipo": "exchange"}, headers=cabeceras).status_code == 400


def testUnaCuentaConMovimientosNoSeElimina(cliente):
    client, cabeceras = cliente
    usada = _cuenta(client, cabeceras, "Binance")
    vacia = _cuenta(client, cabeceras, "Vacía", "broker")
    _transferir(client, cabeceras, "banco", usada["id"], "100")

    assert client.delete(f"/api/cuentas/{usada['id']}", headers=cabeceras).status_code == 409
    assert client.delete(f"/api/cuentas/{vacia['id']}", headers=cabeceras).status_code == 200


# ── Transferencias ───────────────────────────────────────────────────────────

def testUnaTransferenciaMueveElSaldoDeLasDosCuentas(cliente):
    client, cabeceras = cliente
    exchange = _cuenta(client, cabeceras, "Binance")

    res = _transferir(client, cabeceras, "banco", exchange["id"], "250,50", concepto="Compra de cripto")

    assert res.status_code == 201
    assert _saldo(client, exchange["id"]) == 250.50
    assert _saldo(client, "banco") == -250.50


def testUnaTransferenciaNoEsUnGastoNiUnIngreso(cliente):
    client, cabeceras = cliente
    _transferir(client, cabeceras, "banco", "ahorro", "1000")

    assert client.get("/api/gastos").get_json()["years"] == ["2026"]  # solo el año por defecto
    assert client.get("/api/gastos/2026").get_json()["months"]["marzo"]["rows"] == []
    assert client.get("/api/ingresos/2026").get_json()["months"]["marzo"]["rows"] == []


@pytest.mark.parametrize(
    "cuerpo",
    [
        {"origen": "banco", "destino": "banco", "cantidad": "5"},
        {"origen": "banco", "destino": "nadie", "cantidad": "5"},
        {"origen": "banco", "destino": "ahorro", "cantidad": "0"},
        {"origen": "banco", "destino": "ahorro", "cantidad": "-3"},
        {"origen": "banco", "destino": "ahorro", "cantidad": "abc"},
        {"origen": "banco", "destino": "ahorro", "cantidad": "5", "fecha": "31-02-2026"},
        {"origen": "banco", "destino": "ahorro", "cantidad": "5", "fecha": "ayer"},
    ],
)
def testLasTransferenciasInvalidasSeRechazan(cliente, cuerpo):
    client, cabeceras = cliente

    assert client.post("/api/transferencias", json=cuerpo, headers=cabeceras).status_code == 400
    assert client.get("/api/transferencias").get_json()["transferencias"] == []


def testEditarYEliminarUnaTransferencia(cliente):
    client, cabeceras = cliente
    exchange = _cuenta(client, cabeceras, "Binance")
    t = _transferir(client, cabeceras, "banco", exchange["id"], "100").get_json()["transferencia"]

    res = client.put(
        f"/api/transferencias/{t['id']}",
        json={"origen": exchange["id"], "destino": "banco", "cantidad": "40", "fecha": "11-03-2026"},
        headers=cabeceras,
    )

    assert res.status_code == 200
    assert _saldo(client, exchange["id"]) == -40
    assert client.delete(f"/api/transferencias/{t['id']}", headers=cabeceras).status_code == 200
    assert _saldo(client, exchange["id"]) == 0
    assert client.delete(f"/api/transferencias/{t['id']}", headers=cabeceras).status_code == 404
    assert client.put(f"/api/transferencias/{t['id']}", json={}, headers=cabeceras).status_code in (400, 404)


# ── Gastos e ingresos con cuenta ─────────────────────────────────────────────

def testUnGastoPagadoConAhorroBajaEseSaldoYNoElDelBanco(cliente):
    client, cabeceras = cliente
    _transferir(client, cabeceras, "banco", "ahorro", "500")
    _guardarGastos(client, cabeceras, [
        {"fecha": "12-03-2026", "nombre": "Nevera", "tipo": "Casa", "cantidad": "120,00 €", "cuenta": "ahorro"},
        {"fecha": "13-03-2026", "nombre": "Cena", "tipo": "Comida", "cantidad": "30,00 €"},
    ])

    assert _saldo(client, "ahorro") == 500 - 120
    assert _saldo(client, "banco") == -500 - 30


def testElGastoPagadoConAhorroSigueSiendoUnGastoDeSuCategoria(cliente):
    client, cabeceras = cliente
    _guardarGastos(client, cabeceras, [
        {"fecha": "12-03-2026", "nombre": "Nevera", "tipo": "Casa", "cantidad": "120,00 €", "cuenta": "ahorro"},
    ])

    fila = client.get("/api/gastos/2026").get_json()["months"]["marzo"]["rows"][0]

    assert (fila["tipo"], fila["cuenta"]) == ("Casa", "ahorro")


def testUnIngresoCobradoEnAhorroSubeEseSaldo(cliente):
    client, cabeceras = cliente
    client.post(
        "/api/ingresos/2026",
        json={"year": "2026", "months": {"marzo": {"rows": [
            {"fecha": "01-03-2026", "nombre": "Intereses", "tipo": "Otros", "cantidad": "10,00 €", "cuenta": "ahorro"}
        ]}}},
        headers=cabeceras,
    )

    assert _saldo(client, "ahorro") == 10
    assert _saldo(client, "banco") == 0


def testUnaCuentaDesconocidaEnUnaFilaVuelveALaBancaria(cliente):
    client, cabeceras = cliente
    _guardarGastos(client, cabeceras, [
        {"fecha": "12-03-2026", "nombre": "x", "tipo": "Casa", "cantidad": "10,00 €", "cuenta": "fantasma"},
    ])

    assert client.get("/api/gastos/2026").get_json()["months"]["marzo"]["rows"][0]["cuenta"] == ""


def testUnaCuentaConGastosPagadosNoSeElimina(cliente):
    client, cabeceras = cliente
    exchange = _cuenta(client, cabeceras, "Binance")
    _guardarGastos(client, cabeceras, [
        {"fecha": "12-03-2026", "nombre": "x", "tipo": "Casa", "cantidad": "10,00 €", "cuenta": exchange["id"]},
    ])

    assert client.delete(f"/api/cuentas/{exchange['id']}", headers=cabeceras).status_code == 409


# ── Saldos ───────────────────────────────────────────────────────────────────

def testElSaldoCuentaLasMensualidadesYRecurrentesHastaElMesActual(tempDb):
    from core.db import getDb
    from stores.cuentas_store import saldos

    conn = getDb()
    conn.execute("INSERT INTO mensualidades (year, nombre, enero, febrero, diciembre) VALUES ('2026', 'Gym', '30,00', '30,00', '30,00')")
    conn.execute("INSERT INTO ingresos_recurrentes (year, nombre, enero, diciembre) VALUES ('2026', 'Nómina', '1.000,00', '1.000,00')")
    conn.commit()

    banco = saldos(conn, hoy=HOY)["banco"]

    # Diciembre todavía no ha llegado: no es dinero que ya esté en la cuenta.
    assert float(banco["salidas"]) == 60
    assert float(banco["entradas"]) == 1000
    assert float(banco["saldo"]) == 940


def testUnaMensualidadConCuentaRestaDeEsaCuentaYNoDeLaBancaria(tempDb):
    from core.db import getDb
    from stores.cuentas_store import saldos

    conn = getDb()
    conn.execute("INSERT INTO cuentas (id, nombre, tipo, sort_order) VALUES ('tarjeta', 'Tarjeta', 'banco', 5)")
    conn.execute("INSERT INTO mensualidades (year, nombre, enero, febrero, cuenta) VALUES ('2026', 'Gym', '30,00', '30,00', 'tarjeta')")
    # Una cuenta que ya no existe vuelve a la bancaria en vez de perder el cargo.
    conn.execute("INSERT INTO mensualidades (year, nombre, enero, cuenta) VALUES ('2026', 'Cine', '10,00', 'borrada')")
    conn.commit()

    resultado = saldos(conn, hoy=HOY)

    assert float(resultado["tarjeta"]["salidas"]) == 60
    assert float(resultado["banco"]["salidas"]) == 10


def testUnMesDeLaMensualidadPuedeCobrarseConOtraCuenta(tempDb):
    from core.db import getDb
    from stores.cuentas_store import saldos
    from stores.gastos_store import readGastosYear, sanitizeGastosPayload, writeGastosYear

    conn = getDb()
    conn.execute("INSERT INTO cuentas (id, nombre, tipo, sort_order) VALUES ('tarjeta', 'Tarjeta', 'banco', 5)")
    conn.execute("INSERT INTO cuentas (id, nombre, tipo, sort_order) VALUES ('santander', 'Santander', 'banco', 6)")
    conn.commit()
    payload, _ = sanitizeGastosPayload({"year": "2026", "mensualidades": [{
        "nombre": "Claude", "cuenta": "santander",
        "meses": {"enero": "20,00", "febrero": "20,00", "marzo": "20,00"},
        # Febrero con la tarjeta, marzo con la bancaria (explícita) y abril con una cuenta que no existe.
        "cuentasCobro": {"febrero": "tarjeta", "marzo": "banco", "abril": "borrada"},
    }]})
    writeGastosYear("2026", payload)

    assert readGastosYear("2026")["mensualidades"][0]["cuentasCobro"] == {"febrero": "tarjeta", "marzo": "banco"}
    resultado = saldos(conn, hoy=HOY)
    assert float(resultado["santander"]["salidas"]) == 20
    assert float(resultado["tarjeta"]["salidas"]) == 20
    assert float(resultado["banco"]["salidas"]) == 20


def testUnIngresoRecurrenteConCuentaSumaAEsaCuentaYSeGuarda(tempDb):
    from core.db import getDb
    from stores.cuentas_store import saldos
    from stores.ingresos_store import readIngresosYear, sanitizeIngresosPayload, writeIngresosYear

    conn = getDb()
    conn.execute("INSERT INTO cuentas (id, nombre, tipo, sort_order) VALUES ('tarjeta', 'Tarjeta', 'banco', 5)")
    conn.commit()
    payload, _ = sanitizeIngresosPayload({"year": "2026", "recurrentes": [
        {"nombre": "Paga", "cuenta": "tarjeta", "meses": {"enero": "200,00", "febrero": "200,00"}},
        {"nombre": "Otra", "cuenta": "no-existe", "meses": {"enero": "50,00"}},
    ]})
    writeIngresosYear("2026", payload)

    assert {r["nombre"]: r["cuenta"] for r in readIngresosYear("2026")["recurrentes"]} == {"Paga": "tarjeta", "Otra": ""}
    resultado = saldos(conn, hoy=HOY)
    assert float(resultado["tarjeta"]["entradas"]) == 400
    assert float(resultado["banco"]["entradas"]) == 50


def testUnMesDelIngresoRecurrentePuedeEntrarEnOtraCuenta(tempDb):
    from core.db import getDb
    from stores.cuentas_store import saldos
    from stores.ingresos_store import readIngresosYear, sanitizeIngresosPayload, writeIngresosYear

    conn = getDb()
    conn.execute("INSERT INTO cuentas (id, nombre, tipo, sort_order) VALUES ('tarjeta', 'Tarjeta', 'banco', 5)")
    conn.execute("INSERT INTO cuentas (id, nombre, tipo, sort_order) VALUES ('santander', 'Santander', 'banco', 6)")
    conn.commit()
    payload, _ = sanitizeIngresosPayload({"year": "2026", "recurrentes": [{
        "nombre": "Paga", "cuenta": "santander",
        "meses": {"enero": "100,00", "febrero": "100,00", "marzo": "100,00"},
        "cuentasCobro": {"febrero": "tarjeta", "marzo": "banco", "abril": "borrada"},
    }]})
    writeIngresosYear("2026", payload)

    assert readIngresosYear("2026")["recurrentes"][0]["cuentasCobro"] == {"febrero": "tarjeta", "marzo": "banco"}
    resultado = saldos(conn, hoy=HOY)
    assert float(resultado["santander"]["entradas"]) == 100
    assert float(resultado["tarjeta"]["entradas"]) == 100
    assert float(resultado["banco"]["entradas"]) == 100


def testLaCuentaDeLaMensualidadSeGuardaYUnaDesconocidaVuelveALaBancaria(tempDb):
    from core.db import getDb
    from stores.gastos_store import readGastosYear, sanitizeGastosPayload, writeGastosYear

    conn = getDb()
    conn.execute("INSERT INTO cuentas (id, nombre, tipo, sort_order) VALUES ('tarjeta', 'Tarjeta', 'banco', 5)")
    conn.commit()
    payload, _ = sanitizeGastosPayload({"year": "2026", "mensualidades": [
        {"nombre": "Gym", "cuenta": "tarjeta"},
        {"nombre": "Cine", "cuenta": "no-existe"},
        {"nombre": "Luz"},
    ]})
    writeGastosYear("2026", payload)

    cuentas = {m["nombre"]: m["cuenta"] for m in readGastosYear("2026")["mensualidades"]}

    assert cuentas == {"Gym": "tarjeta", "Cine": "", "Luz": ""}


def testLasFilasFuturasNoMuevenElSaldoTodavia(tempDb):
    from core.db import getDb
    from stores.cuentas_store import crearTransferencia, saldos

    crearTransferencia("banco", "ahorro", "10-12-2026", "100")
    crearTransferencia("banco", "ahorro", "10-03-2026", "40")

    assert float(saldos(getDb(), hoy=HOY)["ahorro"]["saldo"]) == 40
    assert float(saldos(getDb(), hoy=datetime.date(2026, 12, 20))["ahorro"]["saldo"]) == 140


# ── Ventana de ahorro ────────────────────────────────────────────────────────

def testLosMovimientosDeAhorroSonTransferenciasIngresosYGastosDeEsaCuenta(cliente):
    client, cabeceras = cliente
    _transferir(client, cabeceras, "banco", "ahorro", "500", concepto="Aportación")
    _transferir(client, cabeceras, "ahorro", "banco", "50", fecha="11-03-2026")
    _guardarGastos(client, cabeceras, [
        {"fecha": "12-03-2026", "nombre": "Nevera", "tipo": "Casa", "cantidad": "120,00 €", "cuenta": "ahorro"},
    ])

    datos = client.get("/api/cuenta-ahorro").get_json()

    assert [c["id"] for c in datos["cuentas"]] == ["ahorro"]
    assert [(m["origen"], m["kind"], m["cantidad"]) for m in datos["movimientos"]] == [
        ("transferencia", "entrada", "500,00 €"),
        ("transferencia", "salida", "50,00 €"),
        ("gasto", "salida", "120,00 €"),
    ]
    assert datos["movimientos"][0]["contraparte"] == "Cuenta bancaria"


def testCadaCuentaDeAhorroSoloVeLoSuyo(cliente):
    client, cabeceras = cliente
    viaje = _cuenta(client, cabeceras, "Viaje", "ahorro")
    _transferir(client, cabeceras, "banco", viaje["id"], "70")
    _transferir(client, cabeceras, "banco", "ahorro", "20")

    movs = client.get("/api/cuenta-ahorro").get_json()["movimientos"]

    assert sorted((m["cuenta"], m["cantidad"]) for m in movs) == [("ahorro", "20,00 €"), (viaje["id"], "70,00 €")]


def testLasCuentasQueNoSonDeAhorroNoSalenEnSuVentana(cliente):
    client, cabeceras = cliente
    exchange = _cuenta(client, cabeceras, "Binance")
    _transferir(client, cabeceras, "banco", exchange["id"], "70")

    datos = client.get("/api/cuenta-ahorro").get_json()

    assert [c["id"] for c in datos["cuentas"]] == ["ahorro"]
    assert datos["movimientos"] == []


def testRenombrarUnaCuentaDeAhorroMueveSuConfiguracion(cliente):
    client, cabeceras = cliente
    viaje = _cuenta(client, cabeceras, "Viaje", "ahorro")
    client.post(
        "/api/settings",
        json={"cuentaAhorroConfig": {"cuentas": [{"nombre": "Viaje", "objetivo": "1000"}]}},
        headers=cabeceras,
    )

    client.put(f"/api/cuentas/{viaje['id']}", json={"nombre": "Vacaciones"}, headers=cabeceras)

    cuentas = client.get("/api/settings").get_json()["cuentaAhorroConfig"]["cuentas"]
    assert {c["nombre"]: c["objetivo"] for c in cuentas}["Vacaciones"] == "1000.00"


# ── Categorías ───────────────────────────────────────────────────────────────

def testYaNoHayCategoriasReservadas(cliente):
    client, _cabeceras = cliente

    assert client.get("/api/gastos-tipos").get_json()["types"] == []
    assert client.get("/api/ingresos-tipos").get_json()["types"] == []


def testLeerLasCuentasYLosSaldosNoDejaUnaTransaccionAbierta(tempDb):
    """Una lectura que escribiera dejaría la base bloqueada para los demás hilos."""
    from core.db import getDb
    from stores.cuentas_store import listarCuentas, listarTransferencias, movimientosDeCuenta, saldos

    conn = getDb()
    listarCuentas(conn)
    listarTransferencias(conn)
    saldos(conn)
    movimientosDeCuenta("ahorro", conn)

    assert conn.in_transaction is False


def testElSaldoDelMesArrancaConLoOcurridoEnLosMesesAnteriores(tempDb):
    from core.db import getDb
    from stores.cuentas_store import saldosDelMes

    conn = getDb()
    conn.execute("UPDATE cuentas SET saldo_inicial = '100.00' WHERE id = 'banco'")
    conn.execute("INSERT INTO mensualidades (year, nombre, enero, febrero, marzo) VALUES ('2026', 'Gym', '30,00', '30,00', '30,00')")
    conn.execute("INSERT INTO ingresos_recurrentes (year, nombre, enero, febrero, marzo) VALUES ('2026', 'Nómina', '1.000,00', '1.000,00', '1.000,00')")
    conn.commit()

    assert float(saldosDelMes("2026", "enero", conn)["banco"]["inicial"]) == 100
    assert float(saldosDelMes("2026", "marzo", conn)["banco"]["inicial"]) == 100 + 2 * 970
