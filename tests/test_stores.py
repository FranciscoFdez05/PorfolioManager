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
    sanitize_color,
    sanitizeAssetPayload,
    sanitizeAssetRows,
    sanitizeAssetType,
    slugify,
)
from stores.gastos_store import (
    MONTH_KEYS,
    normalize_dia_cobro,
    normalize_dias_cobro,
    normalize_frecuencia,
    normalize_mes,
    normalize_year,
    sanitize_gastos_types,
    sanitize_mensualidades_rows,
    sanitize_month_rows,
    serialize_dias_cobro,
)


class TestSlugify:
    @pytest.mark.parametrize("raw,expected", [
        ("Bitcoin", "bitcoin"),
        ("  S&P 500  ", "s-p-500"),
        ("Éxito", "xito"),
        ("---", "activo"),
        ("", "activo"),
    ])
    def test_slug(self, raw, expected):
        assert slugify(raw) == expected


class TestTiposDeActivo:
    @pytest.mark.parametrize("tipo", sorted(ALLOWED_ASSET_TYPES))
    def test_tipos_permitidos(self, tipo):
        assert sanitizeAssetType(tipo) == tipo

    def test_tipo_desconocido_se_rechaza(self):
        assert sanitizeAssetType("inmuebles") is None
        assert sanitizeAssetType("") is None


class TestProveedorDeMercado:
    def test_desconocido_cae_al_fallback(self):
        assert normalizeMarketProvider("bloomberg") == "finnhub"
        assert normalizeMarketProvider("eodhd") == "eodhd"

    @pytest.mark.parametrize("symbol,expected", [
        ("BINANCE:BTCUSDT", "finnhub"),
        ("SAP.XETRA", "eodhd"),
        ("AAPL.US", "eodhd"),
        ("AAPL", "finnhub"),
        ("", "finnhub"),
        ("ALGO.INVENTADO", "finnhub"),
        # "MERCADO:TICKER" con un prefijo que Finnhub no entiende en ese
        # formato (bolsa de acciones, índice, futuro) es de TradingView, no de
        # Finnhub -aunque siga habiendo dos puntos, como en el caso cripto de
        # arriba, que sigue cayendo en Finnhub por ser un exchange conocido de
        # ese proveedor.
        ("NASDAQ:AAPL", "tradingview"),
        ("XETR:SAP", "tradingview"),
        ("COMEX:GC1!", "tradingview"),
    ])
    def test_inferencia_por_simbolo(self, symbol, expected):
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
    def test_normaliza_o_apaga(self, raw, expected):
        assert normalizeConvertCurrency(raw) == expected


class TestColor:
    @pytest.mark.parametrize("raw", ["#ff8800", "#FFFFFF"])
    def test_hex_valido(self, raw):
        assert sanitize_color(raw) == raw

    @pytest.mark.parametrize("raw", [
        "rojo", "#fff", "#gggggg", "", None,
        # Un color se inyecta en un atributo style: nada que no sea hex entra.
        "#fff;background:url(javascript:alert(1))",
    ])
    def test_valores_no_hex_se_descartan(self, raw):
        assert sanitize_color(raw) == ""


class TestSimboloDeActivo:
    def test_limpia_y_acorta(self):
        assert createAssetSymbol("Bitcoin Cash") == "BITCOINCASH"
        assert len(createAssetSymbol("a" * 100)) == 24

    def test_sin_alfanumericos_usa_defecto(self):
        assert createAssetSymbol("---") == "ACTIVO"


class TestSanitizeAssetRows:
    def test_divisa_no_soportada_cae_a_eur(self):
        rows = sanitizeAssetRows([{"currency": "JPY"}])
        assert rows[0]["currency"] == "EUR"

    def test_divisa_valida_se_mantiene_en_mayusculas(self):
        assert sanitizeAssetRows([{"currency": "usd"}])[0]["currency"] == "USD"

    def test_campos_largos_se_truncan(self):
        rows = sanitizeAssetRows([{"exchange": "x" * 500}])
        assert len(rows[0]["exchange"]) <= 30

    def test_comisiones_legacy_se_propagan(self):
        # Filas antiguas guardaban la comisión cripto en `comisionesSatoshis`.
        rows = sanitizeAssetRows([{"comisionesSatoshis": "1200"}])
        assert rows[0]["comisionesCripto"] == "1200"
        assert rows[0]["comisionesSatoshis"] == "1200"


class TestNormalizadoresDeGastos:
    def test_frecuencia(self):
        assert normalize_frecuencia("TRIMESTRAL") == "trimestral"
        assert normalize_frecuencia("cada dos días") == "mensual"

    def test_mes(self):
        assert normalize_mes("Marzo") == "marzo"
        assert normalize_mes("brumario") == "enero"

    @pytest.mark.parametrize("raw,expected", [
        ("15", "15"), ("1", "1"), ("31", "31"),
        ("0", ""), ("32", ""), ("-5", ""), ("abc", ""), ("", ""),
    ])
    def test_dia_de_cobro(self, raw, expected):
        assert normalize_dia_cobro(raw) == expected

    @pytest.mark.parametrize("raw,expected", [
        ("2026", "2026"), (2026, "2026"), ("26", None), ("abcd", None), ("", None), (None, None),
    ])
    def test_año(self, raw, expected):
        assert normalize_year(raw) == expected


class TestSanitizeMensualidades:
    def test_nombres_duplicados_se_desambiguan(self):
        # (year, nombre) es UNIQUE: sin esto el INSERT fallaba y se perdía todo
        # el guardado del año.
        rows = sanitize_mensualidades_rows([{"nombre": "Luz"}, {"nombre": "Luz"}, {"nombre": "luz"}])
        nombres = [row["nombre"] for row in rows]
        # El sufijo se añade conservando el nombre tal cual lo escribió el usuario.
        assert nombres == ["Luz", "Luz (2)", "luz (3)"]

    def test_nombre_vacio_recibe_uno_por_defecto(self):
        assert sanitize_mensualidades_rows([{"nombre": "  "}])[0]["nombre"] == "Mensualidad"

    def test_siempre_devuelve_los_doce_meses(self):
        assert set(sanitize_mensualidades_rows([{"nombre": "Luz"}])[0]["meses"]) == set(MONTH_KEYS)

    def test_tope_de_filas(self):
        assert len(sanitize_mensualidades_rows([{"nombre": f"g{i}"} for i in range(150)])) == 100

    def test_entrada_no_lista(self):
        assert sanitize_mensualidades_rows("no soy una lista") == []

    def test_dias_por_mes_sobreviven_al_saneado(self):
        row = sanitize_mensualidades_rows([{"nombre": "Luz", "diasCobro": {"marzo": "5"}}])[0]
        assert row["diasCobro"] == {"marzo": "5"}


class TestDiasCobro:
    """El día de cobro que cambia de un mes a otro.

    Se guarda como JSON en una sola columna, así que el saneado es también el
    parser: lo que entre mal escrito se descarta mes a mes, sin tirar la fila.
    """

    def test_solo_pasan_los_meses_reconocibles(self):
        assert normalize_dias_cobro({"marzo": "5", "brumario": "9"}) == {"marzo": "5"}

    @pytest.mark.parametrize("dia", ["0", "32", "", "  ", "cinco", None])
    def test_dias_fuera_de_rango_se_descartan(self, dia):
        assert normalize_dias_cobro({"marzo": dia}) == {}

    def test_acepta_el_json_con_el_que_se_guarda(self):
        assert normalize_dias_cobro('{"marzo": "5"}') == {"marzo": "5"}

    @pytest.mark.parametrize("raw", ["", "   ", "{no es json", "[1, 2]", None, 7])
    def test_lo_que_no_es_un_mapa_de_meses_no_rompe(self, raw):
        assert normalize_dias_cobro(raw) == {}

    def test_ida_y_vuelta_por_la_columna(self):
        guardado = serialize_dias_cobro({"marzo": "5", "julio": 12})
        assert normalize_dias_cobro(guardado) == {"marzo": "5", "julio": "12"}

    def test_sin_excepciones_no_se_guarda_json_vacio(self):
        # Una columna con "{}" en cada fila sería ruido: lo normal es no tener
        # ninguna excepción.
        assert serialize_dias_cobro({}) == ""
        assert serialize_dias_cobro({"brumario": "9"}) == ""


class TestMensualidadesEnLaBase:
    """Ida y vuelta por SQLite: es donde se vería que falta la columna nueva."""

    def test_los_dias_por_mes_vuelven_tal_cual(self, temp_db):
        from stores.gastos_store import read_gastos_year, write_gastos_year

        write_gastos_year("2026", {
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

        fila = read_gastos_year("2026")["mensualidades"][0]

        assert fila["diaCobro"] == "2"
        assert fila["diasCobro"] == {"marzo": "5", "agosto": "9"}

    def test_una_mensualidad_sin_excepciones_las_lee_vacias(self, temp_db):
        from stores.gastos_store import read_gastos_year, write_gastos_year

        write_gastos_year("2026", {
            "year": "2026",
            "gastosTipos": [],
            "months": {mes: {"rows": []} for mes in MONTH_KEYS},
            "mensualidades": [{"nombre": "Luz", "meses": dict.fromkeys(MONTH_KEYS, "")}],
        })

        assert read_gastos_year("2026")["mensualidades"][0]["diasCobro"] == {}


class TestSanitizeMonthRows:
    def test_tope_de_filas(self):
        assert len(sanitize_month_rows([{} for _ in range(1500)])) == 1000

    def test_campos_se_truncan_y_recortan(self):
        row = sanitize_month_rows([{"nombre": "  " + "n" * 500 + "  "}])[0]
        assert len(row["nombre"]) <= 120

    def test_entrada_no_lista(self):
        assert sanitize_month_rows(None) == []

    def test_la_nota_se_recorta_y_sale_vacia_si_no_viene(self):
        con_nota, sin_nota = sanitize_month_rows([{"nota": "  " + "n" * 500 + "  "}, {}])
        assert len(con_nota["nota"]) <= 300
        assert sin_nota["nota"] == ""


class TestNotaDeMovimientosEnLaBase:
    """La nota de un gasto o ingreso del mes hace el viaje completo por SQLite."""

    @pytest.mark.parametrize("modulo", ["gastos_store", "ingresos_store"])
    def test_la_nota_vuelve_tal_cual(self, temp_db, modulo):
        import importlib

        store = importlib.import_module(f"stores.{modulo}")
        write_year = getattr(store, f"write_{modulo.split('_')[0]}_year")
        read_year = getattr(store, f"read_{modulo.split('_')[0]}_year")

        months = {mes: {"rows": []} for mes in MONTH_KEYS}
        months["agosto"]["rows"] = [
            {"fecha": "11-08-2026", "nombre": "Steam", "tipo": "Compras", "cantidad": "8,88 €", "nota": "Oferta de verano"},
            {"fecha": "13-08-2026", "nombre": "Steam", "tipo": "Compras", "cantidad": "26,98 €"},
        ]
        write_year("2026", {"year": "2026", "months": months})

        filas = read_year("2026")["months"]["agosto"]["rows"]

        assert filas[0]["nota"] == "Oferta de verano"
        assert filas[1]["nota"] == "", "sin nota se guarda y se lee en blanco, no None"


class TestSanitizeGastosTypes:
    def test_desduplica_sin_distinguir_mayusculas(self):
        assert sanitize_gastos_types(["Ocio", "ocio", "Casa"]) == ["Ocio", "Casa"]

    def test_descarta_vacios(self):
        assert sanitize_gastos_types(["  ", "", "Casa"]) == ["Casa"]

    def test_acepta_envoltorio_dict(self):
        assert sanitize_gastos_types({"types": ["Casa"]}) == ["Casa"]

    def test_tope(self):
        assert len(sanitize_gastos_types([f"t{i}" for i in range(300)])) == 200


class TestMonedaDelActivo:
    """El activo tiene UNA moneda: la del precio y la de lo invertido.

    Cuando hubo dos campos podían divergir y la misma fila salía con el precio
    en euros y el invertido en dólares.
    """

    def test_el_payload_guarda_una_sola_moneda(self):
        payload, error = sanitizeAssetPayload({"name": "Bitcoin", "type": "cripto", "currency": "EUR", "rows": []})
        assert error is None
        assert payload["currency"] == "EUR"
        assert "precioCurrency" not in payload

    def test_cliente_antiguo_que_solo_manda_precio_currency(self):
        payload, error = sanitizeAssetPayload({"name": "Bitcoin", "type": "cripto", "precioCurrency": "usd", "rows": []})
        assert error is None
        assert payload["currency"] == "USD"

    def test_currency_manda_sobre_la_heredada(self):
        assert normalizeAssetCurrency({"currency": "EUR", "precioCurrency": "USD"}) == "EUR"

    @pytest.mark.parametrize("raw", ["", "   ", "1234", "e", None])
    def test_valores_invalidos_caen_al_fallback(self, raw):
        assert normalizeAssetCurrency({"currency": raw}) == "EUR"


class TestActivoOculto:
    """Ocultar un activo tiene que sobrevivir al siguiente guardado.

    El cliente reenvía el activo entero en cada POST, así que un campo que el
    saneado no copie se pierde en el upsert: el activo se ocultaba y volvía a
    aparecer al recargar.
    """

    def test_hidden_viaja_en_el_payload(self):
        payload, error = sanitizeAssetPayload({"name": "Colgate", "type": "acciones", "hidden": True, "rows": []})
        assert error is None
        assert payload["hidden"] is True

    def test_sin_hidden_el_activo_es_visible(self):
        payload, _ = sanitizeAssetPayload({"name": "Colgate", "type": "acciones", "rows": []})
        assert payload["hidden"] is False


class TestConvertCurrencyEnElPayload:
    """Igual que `hidden`: si el saneado no lo copia, se pierde en el upsert."""

    def test_convert_currency_viaja_en_el_payload(self):
        payload, error = sanitizeAssetPayload(
            {"name": "Oro", "type": "comoditis", "convertCurrency": "eur", "rows": []}
        )
        assert error is None
        assert payload["convertCurrency"] == "EUR"

    def test_sin_convert_currency_queda_apagado(self):
        payload, _ = sanitizeAssetPayload({"name": "Oro", "type": "comoditis", "rows": []})
        assert payload["convertCurrency"] == ""

    def test_valor_no_soportado_se_apaga_en_vez_de_dar_error(self):
        payload, error = sanitizeAssetPayload(
            {"name": "Oro", "type": "comoditis", "convertCurrency": "BLOOMBERG", "rows": []}
        )
        assert error is None
        assert payload["convertCurrency"] == ""
