"""Lo que los planes gratuitos no dan, y cómo se cuenta.

Finnhub y EODHD funcionan —responden, la clave vale— pero su plan gratuito deja
fuera cosas que la aplicación pide: Finnhub sirve solo mercado de EE. UU. y no
da históricos, y EODHD corta a las 20 peticiones diarias por clave. Los tres
fallos llegaban al usuario como «devolvió HTTP 403» o «HTTP 402», que no dicen
qué hacer, y uno de ellos —el 403— se pintaba además como clave rechazada, que
manda a cambiar una clave que funciona.

Aparte, `real-time` de EODHD no devuelve la divisa de la cotización, y el valor
por defecto era "EUR": todo precio de EODHD acababa etiquetado en euros, así que
un valor en dólares ni se convertía ni se marcaba.

Nada sale a la red: se sustituye `fetch_json` en cada cliente, que es la
frontera con el proveedor.
"""

from urllib.error import HTTPError

import pytest

from providers import eodhd_client, finnhub_client


def _http(codigo):
    return HTTPError("https://proveedor", codigo, "nope", {}, None)


def _responde(monkeypatch, modulo, funcion):
    monkeypatch.setattr(modulo, "fetch_json", funcion)


# ── EODHD · divisa de la cotización ──────────────────────────────────────────

class TestDivisaEodhd:
    @pytest.mark.parametrize("simbolo,esperado", [
        ("AAPL.US", "USD"),
        ("SAN.MC", "EUR"),
        ("SAP.XETRA", "EUR"),
        ("SHOP.TO", "CAD"),
        ("NESN.SW", "CHF"),
        # La bolsa de Londres cotiza en peniques: decir "GBP" multiplicaría por
        # cien el valor del activo.
        ("VOD.LSE", "GBX"),
        # Pares: la cotización va en la segunda divisa.
        ("XAUEUR.FOREX", "EUR"),
        ("EURUSD.FOREX", "USD"),
        ("BTC-USD.CC", "USD"),
    ])
    def test_se_deduce_del_sufijo_de_mercado(self, simbolo, esperado):
        assert eodhd_client.infer_currency_from_symbol(simbolo) == esperado

    @pytest.mark.parametrize("simbolo", ["", "AAPL", "COSA.MERCADORARO"])
    def test_lo_que_no_se_reconoce_cae_al_valor_por_defecto(self, simbolo):
        assert eodhd_client.infer_currency_from_symbol(simbolo) == "EUR"

    def test_una_cotizacion_estadounidense_no_se_etiqueta_en_euros(self, monkeypatch):
        """El fallo de fondo: `real-time` no trae `currency` nunca.

        Con "EUR" por defecto, un AAPL a 320 USD se guardaba como 320 €, y la
        conversión a la divisa de la cartera mira esa etiqueta, así que tampoco
        corregía nada después.
        """
        _responde(monkeypatch, eodhd_client,
                  lambda *a, **k: {"close": 320.65, "previousClose": 328.21, "change_p": -2.3})

        cotizacion, error = eodhd_client.fetch_quote("AAPL.US", "clave")

        assert error is None
        assert cotizacion["currency"] == "USD"

    def test_si_el_proveedor_dice_la_divisa_manda_la_suya(self, monkeypatch):
        _responde(monkeypatch, eodhd_client,
                  lambda *a, **k: {"close": 10, "previousClose": 10, "currency": "gbp"})

        cotizacion, _error = eodhd_client.fetch_quote("RARO.XX", "clave")

        assert cotizacion["currency"] == "GBP"


# ── EODHD · cuota ────────────────────────────────────────────────────────────

def test_el_402_de_eodhd_se_explica_como_cuota_diaria(monkeypatch):
    """20 peticiones al día por clave es el límite del plan gratuito.

    Es con diferencia el corte más habitual, y «EODHD devolvió HTTP 402» lo
    hacía parecer una avería del proveedor.
    """
    def falla(*a, **k):
        raise _http(402)

    _responde(monkeypatch, eodhd_client, falla)

    _cotizacion, error = eodhd_client.fetch_quote("AAPL.US", "clave")

    assert "cuota" in error.lower()


# ── Finnhub · lo que el plan no cubre ────────────────────────────────────────

def test_el_403_de_finnhub_habla_del_plan_y_no_de_la_clave(monkeypatch):
    """Cualquier bolsa fuera de EE. UU. contesta 403 en el plan gratuito."""
    def falla(*a, **k):
        raise _http(403)

    _responde(monkeypatch, finnhub_client, falla)

    _cotizacion, error = finnhub_client.fetch_quote("SAN.MC", "clave")

    assert "plan" in error.lower()
    assert "403" in error


def test_la_busqueda_tambien_explica_el_403(monkeypatch):
    def falla(*a, **k):
        raise _http(403)

    _responde(monkeypatch, finnhub_client, falla)

    _resultados, error = finnhub_client.search_symbol("santander", "clave")

    assert "plan" in error.lower()


# ── Finnhub · históricos ─────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def sin_memoria_de_historicos():
    finnhub_client.reiniciar_historicos_para_pruebas()
    yield
    finnhub_client.reiniciar_historicos_para_pruebas()


def test_el_403_de_los_historicos_no_se_pregunta_una_vez_por_activo(monkeypatch):
    """Las velas salieron del plan gratuito: contestan 403 pase lo que pase.

    Quien las pide es la variación por periodo, que las lanza en paralelo para
    todos los activos sin snapshot, así que cada consulta gastaba una tanda
    entera de peticiones condenadas al mismo 403.
    """
    llamadas = []

    def falla(*a, **k):
        llamadas.append(1)
        raise _http(403)

    _responde(monkeypatch, finnhub_client, falla)

    primero = finnhub_client.fetch_candle_close("AAPL", 0, 1, "clave")
    segundo = finnhub_client.fetch_candle_close("MSFT", 0, 1, "clave")

    assert len(llamadas) == 1
    assert primero[0] is None and segundo[0] is None
    assert segundo[1] == finnhub_client.SIN_HISTORICO


def test_al_reiniciar_el_proceso_se_vuelve_a_intentar(monkeypatch):
    """Si se mejora el plan, un reinicio basta: no queda nada guardado."""
    llamadas = []

    def falla(*a, **k):
        llamadas.append(1)
        raise _http(403)

    _responde(monkeypatch, finnhub_client, falla)
    finnhub_client.fetch_candle_close("AAPL", 0, 1, "clave")
    finnhub_client.reiniciar_historicos_para_pruebas()
    finnhub_client.fetch_candle_close("AAPL", 0, 1, "clave")

    assert len(llamadas) == 2


def test_un_historico_que_llega_se_devuelve(monkeypatch):
    _responde(monkeypatch, finnhub_client,
              lambda *a, **k: {"s": "ok", "c": [123.45, 130.0]})

    precio, error = finnhub_client.fetch_candle_close("AAPL", 0, 1, "clave")

    assert error is None
    assert precio == pytest.approx(123.45)
