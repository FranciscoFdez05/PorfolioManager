"""Pruebas de la descomposición activo/divisa y del histórico de tipos de cambio.

La propiedad que sostiene todo lo demás y que se comprueba una y otra vez aquí:

    efecto activo + efecto divisa == resultado total

Si deja de cumplirse, la pantalla enseñaría dos cifras que se contradicen entre
sí y la de siempre —el rendimiento agregado— dejaría de cuadrar con su propio
desglose. Es un invariante, no un caso de prueba más.
"""

from datetime import date
from decimal import Decimal

import pytest

from core import pnl_divisa


def _d(valor):
    return Decimal(str(valor))


# ── El invariante ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("invertido,valor,fx0,fx1", [
    ("1000", "1200", "0.90", "0.95"),      # activo sube, divisa sube
    ("1000", "1200", "0.90", "0.85"),      # activo sube, divisa baja
    ("1000", "800", "0.90", "0.95"),       # activo baja, divisa sube
    ("1000", "800", "0.90", "0.85"),       # ambos bajan
    ("1000", "1000", "0.90", "0.90"),      # nada se mueve
    ("1000", "0", "0.90", "0.95"),         # posición liquidada a cero
    ("0", "500", "0.90", "0.95"),          # posición sin coste registrado
    ("1234.56", "987.65", "1.0987", "0.8123"),
])
def testLosDosEfectosSumanSiempreElTotal(invertido, valor, fx0, fx1):
    resultado = pnl_divisa.descomponer(invertido, valor, fx0, fx1)

    assert resultado.efectoActivo + resultado.efectoDivisa == resultado.total


def testElTotalEsElDeSiempre(invertido="1000", valor="1200"):
    """El desglose no puede cambiar la cifra que ya se venía mostrando."""
    resultado = pnl_divisa.descomponer("1000", "1200", "0.90", "0.95")

    # 1200 x 0,95 - 1000 x 0,90 = 1140 - 900
    assert resultado.total == _d("240.00")
    assert resultado.invertidoEur == _d("900.00")
    assert resultado.valorEur == _d("1140.00")


# ── Qué significa cada efecto ────────────────────────────────────────────────

def testSinMovimientoDeDivisaTodoEsEfectoActivo():
    resultado = pnl_divisa.descomponer("1000", "1200", "0.90", "0.90")

    assert resultado.efectoDivisa == 0
    assert resultado.efectoActivo == _d("180.00")   # 200 x 0,90


def testSinMovimientoDelActivoTodoEsEfectoDivisa():
    """Es el caso que hoy queda escondido: ganar dinero sin que el activo suba."""
    resultado = pnl_divisa.descomponer("1000", "1000", "0.90", "0.95")

    assert resultado.efectoActivo == 0
    assert resultado.efectoDivisa == _d("50.00")    # 1000 x 0,05


def testUnActivoEnEurosNoTieneEfectoDivisa():
    """Con ambos tipos a 1 el desglose es inocuo: no hay que filtrar por moneda."""
    resultado = pnl_divisa.descomponer("1000", "1200", "1", "1")

    assert resultado.efectoDivisa == 0
    assert resultado.efectoActivo == resultado.total == _d("200")


def testElActivoPuedeSubirMientrasSePierdeDinero():
    """El caso que justifica todo el módulo.

    El activo sube un 5 % en dólares, pero el dólar se deprecia lo suficiente
    como para que la posición pierda en euros. Con un solo número, esto se ve
    como "el activo va mal", que es la lectura equivocada.
    """
    resultado = pnl_divisa.descomponer("1000", "1050", "1.00", "0.90")

    assert resultado.efectoActivo > 0
    assert resultado.efectoDivisa < 0
    assert resultado.total < 0
    assert resultado.efectoActivo + resultado.efectoDivisa == resultado.total


def testElTerminoCruzadoVaDentroDelEfectoDivisa():
    """Se expone aparte, pero no se suma dos veces."""
    resultado = pnl_divisa.descomponer("1000", "1200", "0.90", "0.95")

    # (1200 - 1000) x (0,95 - 0,90)
    assert resultado.terminoCruzado == _d("10.00")
    assert resultado.efectoActivo + resultado.efectoDivisa == resultado.total


# ── Robustez ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("fx", ["0", "-1", "0.00"])
def testUnTipoDeCambioImposibleNoValoraLaPosicionACero(fx):
    """Tomarlo al pie de la letra daría una cartera en cero sin avisar."""
    resultado = pnl_divisa.descomponer("1000", "1200", fx, "0.95")

    assert resultado.invertidoEur > 0
    assert resultado.completo is False


@pytest.mark.parametrize("basura", ["", None, "no es un número", "1,5"])
def testUnImporteIlegibleCuentaComoCeroYNoLanza(basura):
    resultado = pnl_divisa.descomponer(basura, "1200", "0.90", "0.95")

    assert resultado.efectoActivo + resultado.efectoDivisa == resultado.total


def testElDesgloseSeSerializaConDosDecimales():
    datos = pnl_divisa.descomponer("1000", "1200.005", "0.90", "0.95").comoDict()

    assert datos["total"].count(".") == 1
    assert len(datos["total"].split(".")[1]) == 2
    assert datos["completo"] is True


# ── Varias compras, cada una con su tipo ─────────────────────────────────────

def testCadaCompraAportaSuPropioTipoDeCambio():
    """Un tipo medio daría un efecto divisa que no corresponde a ninguna compra."""
    lotes = [
        {"invertido": "1000", "valorActual": "1200", "fxCompra": "0.80"},
        {"invertido": "1000", "valorActual": "1200", "fxCompra": "1.00"},
    ]
    agregado = pnl_divisa.descomponerLotes(lotes, "0.95")

    primero = pnl_divisa.descomponer("1000", "1200", "0.80", "0.95")
    segundo = pnl_divisa.descomponer("1000", "1200", "1.00", "0.95")

    assert agregado.total == primero.total + segundo.total
    assert agregado.efectoActivo == primero.efectoActivo + segundo.efectoActivo
    assert agregado.efectoActivo + agregado.efectoDivisa == agregado.total


def testUnLoteSinTipoDeCambioMarcaElConjuntoComoIncompleto():
    """La pantalla tiene que poder decir que la atribución es aproximada."""
    lotes = [
        {"invertido": "1000", "valorActual": "1200", "fxCompra": "0.80"},
        {"invertido": "1000", "valorActual": "1200", "fxCompra": ""},
    ]
    agregado = pnl_divisa.descomponerLotes(lotes, "0.95")

    assert agregado.completo is False
    # Pero el total sigue cuadrando: no se pierde ni se inventa dinero.
    assert agregado.efectoActivo + agregado.efectoDivisa == agregado.total


def testSinLotesTodoQuedaACero():
    agregado = pnl_divisa.descomponerLotes([], "0.95")

    assert agregado.total == 0
    assert agregado.efectoActivo == 0
    assert agregado.efectoDivisa == 0


# ── Histórico de tipos de cambio ─────────────────────────────────────────────

@pytest.mark.parametrize("texto,esperado", [
    ("15-06-2026", date(2026, 6, 15)),
    ("2026-06-15", date(2026, 6, 15)),
    ("15/06/2026", date(2026, 6, 15)),
    ("", None),
    ("no es una fecha", None),
    ("31-02-2026", None),
])
def testSeAdmitenLosFormatosDeFechaQueGuardaLaAplicacion(texto, esperado):
    from stores.fx_historico import normalizarFecha

    assert normalizarFecha(texto) == esperado


def testElEuroConsigoMismoEsUnoYNoConsultaANadie(tempDb):
    from stores.fx_historico import tasa

    rate, origen, _fecha = tasa("EUR", "15-06-2026", permitirDescarga=False)

    assert rate == Decimal("1")
    assert origen == "base"


def testSinDatoEnCacheYSinDescargaNoSeInventaUnTipo(tempDb):
    from stores.fx_historico import tasa

    rate, motivo, _fecha = tasa("USD", "15-06-2026", permitirDescarga=False)

    assert rate is None
    assert "caché" in motivo


def testLaCacheSirveElCierreAnteriorCuandoLaFechaCaeEnFinDeSemana(tempDb):
    """El mercado de divisas cierra: para un sábado no existe cierre propio."""
    from core.db import getDb
    from stores.fx_historico import tasa

    # La conexión se guarda en una variable: cada getDb() comprueba si hay una
    # transacción huérfana y hace rollback preventivo, así que llamarlo entre el
    # INSERT y el commit deshace el INSERT.
    conn = getDb()
    conn.execute(
        "INSERT INTO fx_rates (par, fecha, rate, origen) VALUES (?,?,?,?)",
        ("USD/EUR", "2026-06-12", "0.92000000", "yahoo"),   # viernes
    )
    conn.commit()

    rate, origen, fechaUsada = tasa("USD", "13-06-2026", permitirDescarga=False)

    assert rate == Decimal("0.92000000")
    assert origen == "yahoo"
    # Y queda constancia de qué sesión se usó realmente.
    assert fechaUsada == "2026-06-12"


def testUnCierreDemasiadoAntiguoNoValeComoTipoDeEsaFecha(tempDb):
    """Un cierre de hace meses no es "el de ese día": es que falta el dato."""
    from core.db import getDb
    from stores.fx_historico import tasa

    conn = getDb()
    conn.execute(
        "INSERT INTO fx_rates (par, fecha, rate, origen) VALUES (?,?,?,?)",
        ("USD/EUR", "2026-01-02", "0.92000000", "yahoo"),
    )
    conn.commit()

    rate, _motivo, _fecha = tasa("USD", "15-06-2026", permitirDescarga=False)

    assert rate is None


# ── Relleno del histórico ────────────────────────────────────────────────────

def _sembrarActivo(currency="USD"):
    from core.db import getDb

    conn = getDb()
    conn.execute("INSERT INTO activos (id, name, type, currency) VALUES (?,?,?,?)",
                 ("apple", "Apple", "acciones", currency))
    conn.executemany(
        "INSERT INTO activo_rows (asset_id, fecha_operacion, tipo_operacion, currency, "
        "participaciones, capital_invertido_bruto) VALUES (?,?,?,?,?,?)",
        [
            ("apple", "12-06-2026", "Compra", currency, "10", "1000"),
            ("apple", "12-06-2026", "Compra", currency, "5", "500"),
        ],
    )
    conn.commit()
    return conn


def testLasOperacionesEnEurosSeResuelvenSinSalirALaRed(tempDb):
    """Dejarlas vacías haría que cada pasada volviera a mirarlas."""
    from stores.fx_historico import contarPendientes, rellenarPendientes

    _sembrarActivo(currency="EUR")
    assert contarPendientes() == 2

    resultado = rellenarPendientes(permitirDescarga=False)

    assert resultado["resueltas"] == 2
    assert resultado["pendientes"] == 0


def testElRellenoUsaElTipoCacheadoYAnotaDeDondeViene(tempDb):
    from core.db import getDb
    from stores.fx_historico import rellenarPendientes

    conn = _sembrarActivo(currency="USD")
    conn.execute(
        "INSERT INTO fx_rates (par, fecha, rate, origen) VALUES (?,?,?,?)",
        ("USD/EUR", "2026-06-12", "0.92000000", "yahoo"),
    )
    conn.commit()

    resultado = rellenarPendientes(permitirDescarga=False)

    assert resultado["resueltas"] == 2
    fila = getDb().execute(
        "SELECT fx_rate, fx_fecha, fx_origen FROM activo_rows LIMIT 1"
    ).fetchone()
    assert Decimal(fila["fx_rate"]) == Decimal("0.92")
    assert fila["fx_fecha"] == "2026-06-12"
    assert fila["fx_origen"] == "yahoo"


def testSinTipoDisponibleLaOperacionQuedaPendienteNoACero(tempDb):
    """Escribir un 0 haría que la posición valiera cero euros en la pantalla."""
    from core.db import getDb
    from stores.fx_historico import rellenarPendientes

    _sembrarActivo(currency="USD")

    resultado = rellenarPendientes(permitirDescarga=False)

    assert resultado["resueltas"] == 0
    assert resultado["fallidas"] == 2
    assert getDb().execute(
        "SELECT COUNT(*) FROM activo_rows WHERE fx_rate = ''"
    ).fetchone()[0] == 2


def testElRellenoRespetaElLimiteDelLote(tempDb):
    """Sin tope, una cartera con años de histórico daría timeout en el navegador."""
    from stores.fx_historico import rellenarPendientes

    _sembrarActivo(currency="EUR")

    resultado = rellenarPendientes(limite=1, permitirDescarga=False)

    assert resultado["resueltas"] == 1
    assert resultado["pendientes"] == 1


# ── Integración con la API ───────────────────────────────────────────────────

@pytest.fixture
def cliente(clienteAutenticado, tempDb, monkeypatch):
    from routes.activos import activosBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(activosBp)
    return client, cabeceras


def testElRendimientoIncluyeElDesglosePorDivisa(cliente):

    client, _cabeceras = cliente
    conn = _sembrarActivo(currency="USD")
    conn.execute("UPDATE activos SET price = '120' WHERE id = 'apple'")
    conn.execute("UPDATE activo_rows SET fx_rate = '0.90'")
    hoy = date.today().isoformat()
    conn.execute(
        "INSERT INTO fx_rates (par, fecha, rate, origen) VALUES (?,?,?,?)",
        ("USD/EUR", hoy, "0.95", "yahoo"),
    )
    conn.commit()

    datos = client.get("/api/activos/rendimiento-batch").get_json()["apple"]

    assert datos["divisa"]["moneda"] == "USD"
    # El desglose cuadra con su propio total, que es lo que se puede afirmar
    # sin atarse a la cotización concreta del día.
    total = Decimal(datos["divisa"]["total"])
    activo = Decimal(datos["divisa"]["efectoActivo"])
    divisa = Decimal(datos["divisa"]["efectoDivisa"])
    assert abs((activo + divisa) - total) <= Decimal("0.02")   # solo redondeo
    assert datos["divisa"]["completo"] is True


def testUnActivoSinFxHistoricoSeMarcaComoIncompleto(cliente):
    """La pantalla debe poder advertir de que la atribución es aproximada."""
    client, _cabeceras = cliente
    conn = _sembrarActivo(currency="USD")
    conn.execute("UPDATE activos SET price = '120' WHERE id = 'apple'")
    conn.commit()

    datos = client.get("/api/activos/rendimiento-batch").get_json()["apple"]

    assert datos["divisa"]["completo"] is False


def testUnActivoEnEurosNoArrastraEfectoDivisa(cliente):
    client, _cabeceras = cliente
    conn = _sembrarActivo(currency="EUR")
    conn.execute("UPDATE activos SET price = '120' WHERE id = 'apple'")
    conn.commit()

    datos = client.get("/api/activos/rendimiento-batch").get_json()["apple"]

    assert Decimal(datos["divisa"]["efectoDivisa"]) == 0


def testLasCifrasDeSiempreNoCambianAlAnadirElDesglose(cliente):
    """El desglose se añade al lado; la tabla existente no puede moverse."""
    client, _cabeceras = cliente
    conn = _sembrarActivo(currency="USD")
    conn.execute("UPDATE activos SET price = '120' WHERE id = 'apple'")
    conn.commit()

    datos = client.get("/api/activos/rendimiento-batch").get_json()["apple"]

    assert datos["invertidoNeto"] == 1500.0
    assert datos["netoActual"] == 1800.0      # 15 participaciones x 120
    assert datos["rendimiento"] == 300.0


def testConsultarYRellenarPendientesPorHttp(cliente):
    client, cabeceras = cliente
    _sembrarActivo(currency="EUR")

    assert client.get("/api/fx/pendientes").get_json()["pendientes"] == 2

    respuesta = client.post("/api/fx/rellenar", json={"limite": 5}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert respuesta.get_json()["resueltas"] == 2
    assert client.get("/api/fx/pendientes").get_json()["pendientes"] == 0


def testElLimiteDelLoteEstaAcotado(cliente):
    """Sin tope superior, un cliente podría pedir un lote que bloquee un worker."""
    client, cabeceras = cliente
    _sembrarActivo(currency="EUR")

    for limite in (0, -5, 10_000_000, "muchos", None):
        respuesta = client.post("/api/fx/rellenar", json={"limite": limite}, headers=cabeceras)
        assert respuesta.status_code == 200


def testRellenarFxSinCsrfEs403(clienteAutenticado, tempDb):
    from routes.activos import activosBp

    client, _cabeceras, _app = clienteAutenticado(activosBp)
    assert client.post("/api/fx/rellenar", json={}).status_code == 403
