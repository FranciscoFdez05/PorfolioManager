"""Sanitización de payloads: la frontera entre lo que manda el navegador y la BD.

Estas funciones son las que impiden que una tabla del frontend escriba en la
base de datos valores fuera de rango, campos gigantes o filas duplicadas que
rompen las claves únicas.
"""

import pytest

from stores.asset_utils import (
    ALLOWED_ASSET_TYPES,
    createAssetSymbol,
    inferMarketProviderFromSymbol,
    normalizeAssetCurrency,
    normalizeConvertCurrency,
    normalizeMarketProvider,
    sanitizeAssetPayload,
    sanitizeAssetRows,
    sanitizeAssetType,
    sanitizeColor,
    slugify,
)
from stores.gastos_store import (
    MONTH_KEYS,
    normalizeDiaCobro,
    normalizeDiasCobro,
    normalizeFrecuencia,
    normalizeMes,
    normalizeYear,
    sanitizeGastosTypes,
    sanitizeMensualidadesRows,
    sanitizeMonthRows,
    serializeDiasCobro,
)


class TestSlugify:
    @pytest.mark.parametrize("raw,expected", [
        ("Bitcoin", "bitcoin"),
        ("  S&P 500  ", "s-p-500"),
        ("Éxito", "xito"),
        ("---", "activo"),
        ("", "activo"),
    ])
    def testSlug(self, raw, expected):
        assert slugify(raw) == expected


class TestTiposDeActivo:
    @pytest.mark.parametrize("tipo", sorted(ALLOWED_ASSET_TYPES))
    def testTiposPermitidos(self, tipo):
        assert sanitizeAssetType(tipo) == tipo

    def testTipoDesconocidoSeRechaza(self):
        assert sanitizeAssetType("inmuebles") is None
        assert sanitizeAssetType("") is None


class TestProveedorDeMercado:
    def testDesconocidoCaeAlFallback(self):
        assert normalizeMarketProvider("bloomberg") == "finnhub"
        assert normalizeMarketProvider("eodhd") == "eodhd"

    @pytest.mark.parametrize("symbol,expected", [
        ("BINANCE:BTCUSDT", "finnhub"),
        ("SAP.XETRA", "eodhd"),
        ("AAPL.US", "eodhd"),
        ("AAPL", "finnhub"),
        ("", "finnhub"),
        ("ALGO.INVENTADO", "finnhub"),
    ])
    def testInferenciaPorSimbolo(self, symbol, expected):
        assert inferMarketProviderFromSymbol(symbol) == expected


class TestDivisaDeConversion:
    @pytest.mark.parametrize("raw,expected", [
        ("EUR", "EUR"),
        ("usd", "USD"),  # se normaliza a mayúsculas
        (" gbp ", "GBP"),
        ("CHF", "CHF"),
        ("JPY", "JPY"),
        ("", ""),
        (None, ""),
        ("XYZ", ""),  # no es una de las cinco soportadas: apagado, no error
        ("BLOOMBERG", ""),
    ])
    def testNormalizaOApaga(self, raw, expected):
        assert normalizeConvertCurrency(raw) == expected


class TestColor:
    @pytest.mark.parametrize("raw", ["#ff8800", "#FFFFFF"])
    def testHexValido(self, raw):
        assert sanitizeColor(raw) == raw

    @pytest.mark.parametrize("raw", [
        "rojo", "#fff", "#gggggg", "", None,
        # Un color se inyecta en un atributo style: nada que no sea hex entra.
        "#fff;background:url(javascript:alert(1))",
    ])
    def testValoresNoHexSeDescartan(self, raw):
        assert sanitizeColor(raw) == ""


class TestSimboloDeActivo:
    def testLimpiaYAcorta(self):
        assert createAssetSymbol("Bitcoin Cash") == "BITCOINCASH"
        assert len(createAssetSymbol("a" * 100)) == 24

    def testSinAlfanumericosUsaDefecto(self):
        assert createAssetSymbol("---") == "ACTIVO"


class TestSanitizeAssetRows:
    def testDivisaNoSoportadaCaeAEur(self):
        rows = sanitizeAssetRows([{"currency": "JPY"}])
        assert rows[0]["currency"] == "EUR"

    def testDivisaValidaSeMantieneEnMayusculas(self):
        assert sanitizeAssetRows([{"currency": "usd"}])[0]["currency"] == "USD"

    def testCamposLargosSeTruncan(self):
        rows = sanitizeAssetRows([{"exchange": "x" * 500}])
        assert len(rows[0]["exchange"]) <= 30

    def testComisionesLegacySePropagan(self):
        # Filas antiguas guardaban la comisión cripto en `comisionesSatoshis`.
        rows = sanitizeAssetRows([{"comisionesSatoshis": "1200"}])
        assert rows[0]["comisionesCripto"] == "1200"
        assert rows[0]["comisionesSatoshis"] == "1200"


class TestNormalizadoresDeGastos:
    def testFrecuencia(self):
        assert normalizeFrecuencia("TRIMESTRAL") == "trimestral"
        assert normalizeFrecuencia("cada dos días") == "mensual"

    def testMes(self):
        assert normalizeMes("Marzo") == "marzo"
        assert normalizeMes("brumario") == "enero"

    @pytest.mark.parametrize("raw,expected", [
        ("15", "15"), ("1", "1"), ("31", "31"),
        ("0", ""), ("32", ""), ("-5", ""), ("abc", ""), ("", ""),
    ])
    def testDiaDeCobro(self, raw, expected):
        assert normalizeDiaCobro(raw) == expected

    @pytest.mark.parametrize("raw,expected", [
        ("2026", "2026"), (2026, "2026"), ("26", None), ("abcd", None), ("", None), (None, None),
    ])
    def testAño(self, raw, expected):
        assert normalizeYear(raw) == expected


class TestSanitizeMensualidades:
    def testNombresDuplicadosSeDesambiguan(self):
        # (year, nombre) es UNIQUE: sin esto el INSERT fallaba y se perdía todo
        # el guardado del año.
        rows = sanitizeMensualidadesRows([{"nombre": "Luz"}, {"nombre": "Luz"}, {"nombre": "luz"}])
        nombres = [row["nombre"] for row in rows]
        # El sufijo se añade conservando el nombre tal cual lo escribió el usuario.
        assert nombres == ["Luz", "Luz (2)", "luz (3)"]

    def testNombreVacioRecibeUnoPorDefecto(self):
        assert sanitizeMensualidadesRows([{"nombre": "  "}])[0]["nombre"] == "Mensualidad"

    def testSiempreDevuelveLosDoceMeses(self):
        assert set(sanitizeMensualidadesRows([{"nombre": "Luz"}])[0]["meses"]) == set(MONTH_KEYS)

    def testTopeDeFilas(self):
        assert len(sanitizeMensualidadesRows([{"nombre": f"g{i}"} for i in range(150)])) == 100

    def testEntradaNoLista(self):
        assert sanitizeMensualidadesRows("no soy una lista") == []

    def testDiasPorMesSobrevivenAlSaneado(self):
        row = sanitizeMensualidadesRows([{"nombre": "Luz", "diasCobro": {"marzo": "5"}}])[0]
        assert row["diasCobro"] == {"marzo": "5"}


class TestDiasCobro:
    """El día de cobro que cambia de un mes a otro.

    Se guarda como JSON en una sola columna, así que el saneado es también el
    parser: lo que entre mal escrito se descarta mes a mes, sin tirar la fila.
    """

    def testSoloPasanLosMesesReconocibles(self):
        assert normalizeDiasCobro({"marzo": "5", "brumario": "9"}) == {"marzo": "5"}

    @pytest.mark.parametrize("dia", ["0", "32", "", "  ", "cinco", None])
    def testDiasFueraDeRangoSeDescartan(self, dia):
        assert normalizeDiasCobro({"marzo": dia}) == {}

    def testAceptaElJsonConElQueSeGuarda(self):
        assert normalizeDiasCobro('{"marzo": "5"}') == {"marzo": "5"}

    @pytest.mark.parametrize("raw", ["", "   ", "{no es json", "[1, 2]", None, 7])
    def testLoQueNoEsUnMapaDeMesesNoRompe(self, raw):
        assert normalizeDiasCobro(raw) == {}

    def testIdaYVueltaPorLaColumna(self):
        guardado = serializeDiasCobro({"marzo": "5", "julio": 12})
        assert normalizeDiasCobro(guardado) == {"marzo": "5", "julio": "12"}

    def testSinExcepcionesNoSeGuardaJsonVacio(self):
        # Una columna con "{}" en cada fila sería ruido: lo normal es no tener
        # ninguna excepción.
        assert serializeDiasCobro({}) == ""
        assert serializeDiasCobro({"brumario": "9"}) == ""


class TestMensualidadesEnLaBase:
    """Ida y vuelta por SQLite: es donde se vería que falta la columna nueva."""

    def testLosDiasPorMesVuelvenTalCual(self, tempDb):
        from stores.gastos_store import readGastosYear, writeGastosYear

        writeGastosYear("2026", {
            "year": "2026",
            "gastosTipos": [],
            "months": {mes: {"rows": []} for mes in MONTH_KEYS},
            "mensualidades": [{
                "nombre": "Claude",
                "importe": "22,00 €",
                "diaCobro": "2",
                "diasCobro": {"marzo": "5", "agosto": "9"},
                "meses": dict.fromkeys(MONTH_KEYS, "22,00 €"),
            }],
        })

        fila = readGastosYear("2026")["mensualidades"][0]

        assert fila["diaCobro"] == "2"
        assert fila["diasCobro"] == {"marzo": "5", "agosto": "9"}

    def testUnaMensualidadSinExcepcionesLasLeeVacias(self, tempDb):
        from stores.gastos_store import readGastosYear, writeGastosYear

        writeGastosYear("2026", {
            "year": "2026",
            "gastosTipos": [],
            "months": {mes: {"rows": []} for mes in MONTH_KEYS},
            "mensualidades": [{"nombre": "Luz", "meses": dict.fromkeys(MONTH_KEYS, "")}],
        })

        assert readGastosYear("2026")["mensualidades"][0]["diasCobro"] == {}


class TestSanitizeMonthRows:
    def testTopeDeFilas(self):
        assert len(sanitizeMonthRows([{} for _ in range(1500)])) == 1000

    def testCamposSeTruncanYRecortan(self):
        row = sanitizeMonthRows([{"nombre": "  " + "n" * 500 + "  "}])[0]
        assert len(row["nombre"]) <= 120

    def testEntradaNoLista(self):
        assert sanitizeMonthRows(None) == []

    def testLaNotaSeRecortaYSaleVaciaSiNoViene(self):
        conNota, sinNota = sanitizeMonthRows([{"nota": "  " + "n" * 500 + "  "}, {}])
        assert len(conNota["nota"]) <= 300
        assert sinNota["nota"] == ""


class TestNotaDeMovimientosEnLaBase:
    """La nota de un gasto o ingreso del mes hace el viaje completo por SQLite."""

    @pytest.mark.parametrize("modulo", ["gastos_store", "ingresos_store"])
    def testLaNotaVuelveTalCual(self, tempDb, modulo):
        import importlib

        store = importlib.import_module(f"stores.{modulo}")
        writeYear = getattr(store, f"write{modulo.split('_')[0].capitalize()}Year")
        readYear = getattr(store, f"read{modulo.split('_')[0].capitalize()}Year")

        months = {mes: {"rows": []} for mes in MONTH_KEYS}
        months["agosto"]["rows"] = [
            {"fecha": "11-08-2026", "nombre": "Steam", "tipo": "Compras", "cantidad": "8,88 €", "nota": "Oferta de verano"},
            {"fecha": "13-08-2026", "nombre": "Steam", "tipo": "Compras", "cantidad": "26,98 €"},
        ]
        writeYear("2026", {"year": "2026", "months": months})

        filas = readYear("2026")["months"]["agosto"]["rows"]

        assert filas[0]["nota"] == "Oferta de verano"
        assert filas[1]["nota"] == "", "sin nota se guarda y se lee en blanco, no None"


class TestSanitizeGastosTypes:
    def testDesduplicaSinDistinguirMayusculas(self):
        assert sanitizeGastosTypes(["Ocio", "ocio", "Casa"]) == ["Ocio", "Casa"]

    def testDescartaVacios(self):
        assert sanitizeGastosTypes(["  ", "", "Casa"]) == ["Casa"]

    def testAceptaEnvoltorioDict(self):
        assert sanitizeGastosTypes({"types": ["Casa"]}) == ["Casa"]

    def testTope(self):
        assert len(sanitizeGastosTypes([f"t{i}" for i in range(300)])) == 200


class TestMonedaDelActivo:
    """El activo tiene UNA moneda: la del precio y la de lo invertido.

    Cuando hubo dos campos podían divergir y la misma fila salía con el precio
    en euros y el invertido en dólares.
    """

    def testElPayloadGuardaUnaSolaMoneda(self):
        payload, error = sanitizeAssetPayload({"name": "Bitcoin", "type": "cripto", "currency": "EUR", "rows": []})
        assert error is None
        assert payload["currency"] == "EUR"
        assert "precioCurrency" not in payload

    def testClienteAntiguoQueSoloMandaPrecioCurrency(self):
        payload, error = sanitizeAssetPayload({"name": "Bitcoin", "type": "cripto", "precioCurrency": "usd", "rows": []})
        assert error is None
        assert payload["currency"] == "USD"

    def testCurrencyMandaSobreLaHeredada(self):
        assert normalizeAssetCurrency({"currency": "EUR", "precioCurrency": "USD"}) == "EUR"

    @pytest.mark.parametrize("raw", ["", "   ", "1234", "e", None])
    def testValoresInvalidosCaenAlFallback(self, raw):
        assert normalizeAssetCurrency({"currency": raw}) == "EUR"


class TestActivoOculto:
    """Ocultar un activo tiene que sobrevivir al siguiente guardado.

    El cliente reenvía el activo entero en cada POST, así que un campo que el
    saneado no copie se pierde en el upsert: el activo se ocultaba y volvía a
    aparecer al recargar.
    """

    def testHiddenViajaEnElPayload(self):
        payload, error = sanitizeAssetPayload({"name": "Colgate", "type": "acciones", "hidden": True, "rows": []})
        assert error is None
        assert payload["hidden"] is True

    def testSinHiddenElActivoEsVisible(self):
        payload, _ = sanitizeAssetPayload({"name": "Colgate", "type": "acciones", "rows": []})
        assert payload["hidden"] is False


class TestConvertCurrencyEnElPayload:
    """Igual que `hidden`: si el saneado no lo copia, se pierde en el upsert."""

    def testConvertCurrencyViajaEnElPayload(self):
        payload, error = sanitizeAssetPayload(
            {"name": "Oro", "type": "comoditis", "convertCurrency": "eur", "rows": []}
        )
        assert error is None
        assert payload["convertCurrency"] == "EUR"

    def testSinConvertCurrencyQuedaApagado(self):
        payload, _ = sanitizeAssetPayload({"name": "Oro", "type": "comoditis", "rows": []})
        assert payload["convertCurrency"] == ""

    def testValorNoSoportadoSeApagaEnVezDeDarError(self):
        payload, error = sanitizeAssetPayload(
            {"name": "Oro", "type": "comoditis", "convertCurrency": "BLOOMBERG", "rows": []}
        )
        assert error is None
        assert payload["convertCurrency"] == ""
