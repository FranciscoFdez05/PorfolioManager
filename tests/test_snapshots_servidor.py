"""Snapshots guardados por el servidor, sin navegador de por medio.

Cubre las tres piezas nuevas: la posición viva que calcula el FIFO del
servidor, la valoración en euros con cotizaciones frescas, y el reparto de
huecos horarios entre el hilo y el frontend.
"""

import pytest

from core.db import get_db, use_db_path
from routes.snapshots import guardar_snapshot, reservar_bucket
from stores import valoracion, ventas_fifo
from stores.asset_store import writeAssetFile
from stores.ventas_store import read_ventas_year, sanitize_ventas_payload, write_ventas_year


def crear_activo(asset_id="acme", tipo="accion", precio="100,00", currency="EUR", filas=(), simbolo="ACME"):
    writeAssetFile(asset_id, {
        "name": asset_id.upper(),
        "symbol": asset_id.upper(),
        "marketSymbol": simbolo,
        "type": tipo,
        "price": precio,
        "currency": currency,
        "rows": list(filas),
    })


def compra(fecha, participaciones, precio, comisiones="0"):
    return {
        "fechaOperacion": fecha,
        "tipoOperacion": "Compra",
        "participaciones": participaciones,
        "precioParticipacion": precio,
        "comisiones": comisiones,
    }


def guardar_venta(year, fecha, cantidad, valor, asset_id="acme"):
    payload, error = sanitize_ventas_payload({"year": year, "rows": [{
        "id": "v1", "fecha": fecha, "assetId": asset_id,
        "cantidad": cantidad, "valorVenta": valor,
    }]}, year)
    assert error is None, error
    write_ventas_year(year, payload)
    return read_ventas_year(year)


class TestCarteraViva:
    def test_suma_compras_y_descuenta_ventas_por_fifo(self, temp_db):
        crear_activo(filas=[
            compra("01-01-2023", "10", "10"),   # 100 €
            compra("01-06-2023", "10", "20"),   # 200 €
        ])
        guardar_venta("2024", "01-09-2024", "15", "30")

        posicion = ventas_fifo.cartera_viva()["acme"]

        # Quedan 5 participaciones, todas del segundo lote (20 €/participación).
        assert float(posicion["cantidad"]) == pytest.approx(5)
        assert float(posicion["coste"]) == pytest.approx(100)

    def test_el_coste_es_el_invertido_bruto_sin_comisiones(self, temp_db):
        # El frontend manda invertidoBruto como total_invested; si el servidor
        # sumara la comisión, el histórico tendría dos definiciones distintas
        # de "invertido" según quién guardara el punto.
        crear_activo(filas=[compra("01-01-2024", "10", "10", comisiones="25")])

        assert float(ventas_fifo.cartera_viva()["acme"]["coste"]) == pytest.approx(100)

    def test_un_activo_liquidado_no_aparece(self, temp_db):
        crear_activo(filas=[compra("01-01-2023", "10", "10")])
        guardar_venta("2024", "01-09-2024", "10", "30")

        assert "acme" not in ventas_fifo.cartera_viva()


class TestValoracion:
    def test_valora_con_la_cotizacion_fresca(self, temp_db, monkeypatch):
        crear_activo(precio="100,00", filas=[compra("01-01-2024", "10", "10")])
        monkeypatch.setattr(
            valoracion, "fetch_asset_quote",
            lambda symbol, provider=None: ({"price": 150.0, "currency": "EUR"}, None),
        )

        resultado = valoracion.valorar_portfolio()

        assert resultado["total_value"] == pytest.approx(1500)
        assert resultado["total_invested"] == pytest.approx(100)
        assert resultado["precios_frescos"] == 1
        assert resultado["assets"] == [{"id": "acme", "v": pytest.approx(1500), "c": pytest.approx(100)}]

    def test_acepta_el_precio_formateado_que_devuelven_los_proveedores(self, temp_db, monkeypatch):
        # Los clientes serializan `price` con `format_decimal` ("1.500,00"), no
        # como número: un float() directo reventaba el snapshot entero.
        crear_activo(precio="100,00", filas=[compra("01-01-2024", "10", "10")])
        monkeypatch.setattr(
            valoracion, "fetch_asset_quote",
            lambda symbol, provider=None: ({"price": "1.500,00", "currency": "EUR"}, None),
        )

        resultado = valoracion.valorar_portfolio()

        assert resultado["total_value"] == pytest.approx(15000)
        assert resultado["precios_frescos"] == 1

    def test_si_falla_la_cotizacion_usa_el_ultimo_precio(self, temp_db, monkeypatch):
        # Un hueco en el histórico hace más daño que un punto con el precio de
        # hace unas horas: el snapshot se guarda igual.
        crear_activo(precio="100,00", filas=[compra("01-01-2024", "10", "10")])
        monkeypatch.setattr(
            valoracion, "fetch_asset_quote",
            lambda symbol, provider=None: (None, "429 Too Many Requests"),
        )

        resultado = valoracion.valorar_portfolio()

        assert resultado["total_value"] == pytest.approx(1000)
        assert resultado["precios_frescos"] == 0

    def test_convierte_a_euros_la_cotizacion_en_otra_divisa(self, temp_db, monkeypatch):
        crear_activo(precio="100,00", currency="USD", filas=[compra("01-01-2024", "10", "10")])
        monkeypatch.setattr(
            valoracion, "fetch_asset_quote",
            lambda symbol, provider=None: ({"price": 200.0, "currency": "USD"}, None),
        )
        monkeypatch.setattr(valoracion, "fetch_exchange_rate", lambda origen, destino: (0.5, None))

        resultado = valoracion.valorar_portfolio()

        assert resultado["total_value"] == pytest.approx(1000)   # 10 x 200 USD x 0,5
        assert resultado["total_invested"] == pytest.approx(50)  # 100 USD x 0,5

    def test_sin_posiciones_no_pide_cotizaciones(self, temp_db, monkeypatch):
        crear_activo(filas=[])

        def _explotar(*args, **kwargs):
            raise AssertionError("no debería pedir cotizaciones sin posición viva")

        monkeypatch.setattr(valoracion, "fetch_asset_quote", _explotar)

        resultado = valoracion.valorar_portfolio()

        assert resultado["activos"] == 0
        assert resultado["total_value"] == 0


@pytest.fixture
def hueco_de_una_hora(monkeypatch):
    """Intervalo fijo: el real sale de ajustes.json, que es del usuario."""
    import routes.snapshots as snapshots

    monkeypatch.setattr(snapshots, "_interval_seconds", lambda: 3600)


@pytest.mark.usefixtures("hueco_de_una_hora")
class TestBucket:
    def test_solo_se_guarda_un_punto_por_hueco(self, temp_db):
        assert guardar_snapshot(1000, 900, now_ts=10_000) is True
        # El hilo del servidor y una pestaña abierta pueden coincidir: el
        # segundo punto del mismo bucket se descarta.
        assert guardar_snapshot(1100, 900, now_ts=10_030) is False

        filas = get_db().execute("SELECT total_value FROM portfolio_snapshots").fetchall()
        assert [f["total_value"] for f in filas] == [1000]

    def test_el_hueco_siguiente_si_se_guarda(self, temp_db):
        assert guardar_snapshot(1000, 900, now_ts=10_000) is True
        assert guardar_snapshot(1100, 900, now_ts=10_000 + 3600) is True

    def test_el_bucket_solo_lo_reclama_uno(self, temp_db):
        assert reservar_bucket(now_ts=10_000) is True
        assert reservar_bucket(now_ts=10_030) is False
        assert reservar_bucket(now_ts=10_000 + 3600) is True

    def test_el_desglose_por_activo_va_en_la_misma_transaccion(self, temp_db):
        guardar_snapshot(1000, 900, [{"id": "acme", "v": 600, "c": 500}], now_ts=10_000)

        filas = get_db().execute("SELECT asset_id, price_eur, cost_eur FROM asset_snapshots").fetchall()
        assert [(f["asset_id"], f["price_eur"], f["cost_eur"]) for f in filas] == [("acme", 600, 500)]


@pytest.mark.usefixtures("hueco_de_una_hora")
class TestScheduler:
    def test_espera_al_siguiente_hueco_mas_la_gracia(self, monkeypatch):
        from admin import snapshot_scheduler

        monkeypatch.setattr(snapshot_scheduler.settings, "snapshotServidorGracia", lambda: 120)

        # A las 10:00:30, el siguiente hueco es 11:00 y se le suman 2 minutos de
        # gracia para que gane el navegador si hay una pestaña abierta.
        assert snapshot_scheduler._espera_hasta_siguiente(ahora=36_030) == pytest.approx(3690)

    def test_la_gracia_no_se_come_el_hueco_entero(self, monkeypatch):
        from admin import snapshot_scheduler

        monkeypatch.setattr(snapshot_scheduler, "_intervalo", lambda: 300)
        monkeypatch.setattr(snapshot_scheduler.settings, "snapshotServidorGracia", lambda: 600)

        # Gracia pedida 600 s sobre un hueco de 300: se limita a un cuarto (75).
        assert snapshot_scheduler._espera_hasta_siguiente(ahora=0) == pytest.approx(375)

    def test_alcance_activo_solo_mira_el_portfolio_abierto(self, temp_db, monkeypatch):
        from admin import snapshot_scheduler

        monkeypatch.setattr(snapshot_scheduler, "_ajustes", lambda: {"snapshotAlcance": "activo"})

        assert snapshot_scheduler._rutas_objetivo() == [temp_db]

    def test_ejecutar_una_vez_guarda_y_respeta_el_hueco(self, temp_db, monkeypatch):
        from admin import snapshot_scheduler

        crear_activo(precio="100,00", filas=[compra("01-01-2024", "10", "10")])
        monkeypatch.setattr(snapshot_scheduler, "_ajustes", lambda: {"snapshotAlcance": "activo"})
        monkeypatch.setattr(
            valoracion, "fetch_asset_quote",
            lambda symbol, provider=None: ({"price": 120.0, "currency": "EUR"}, None),
        )

        assert snapshot_scheduler.ejecutar_una_vez() == 1
        # Segunda pasada dentro del mismo hueco: ni siquiera vuelve a valorar.
        assert snapshot_scheduler.ejecutar_una_vez() == 0

        fila = get_db().execute("SELECT total_value, total_invested FROM portfolio_snapshots").fetchone()
        assert (fila["total_value"], fila["total_invested"]) == (1200, 100)


@pytest.mark.usefixtures("hueco_de_una_hora")
class TestOverrideDeBaseDeDatos:
    def test_use_db_path_no_toca_la_base_activa(self, temp_db, tmp_path):
        # El hilo del servidor recorre portfolios; si cambiara la global, le
        # movería la base de datos bajo los pies a la sesión web abierta.
        guardar_snapshot(1000, 900, now_ts=10_000)
        otra = tmp_path / "otro_portfolio.db"

        with use_db_path(otra):
            guardar_snapshot(555, 500, now_ts=10_000)
            assert get_db().execute("SELECT total_value FROM portfolio_snapshots").fetchone()[0] == 555

        assert get_db().execute("SELECT total_value FROM portfolio_snapshots").fetchone()[0] == 1000
