"""La tabla de ventas de punta a punta: BD → línea temporal → liquidación."""

import pytest

from core.errors import ValidationError
from stores import ventas_fifo
from stores.asset_store import writeAssetFile
from stores.ventas_store import (
    read_ventas_year,
    sanitize_ventas_payload,
    validar_para_guardar,
    write_ventas_year,
)


def crear_activo(asset_id="acme", tipo="accion", filas=()):
    writeAssetFile(asset_id, {
        "name": asset_id.upper(),
        "symbol": asset_id.upper(),
        "type": tipo,
        "rows": list(filas),
    })


def compra_ficha(fecha, participaciones, precio, comisiones="0"):
    return {
        "fechaOperacion": fecha,
        "tipoOperacion": "Compra",
        "participaciones": participaciones,
        "precioParticipacion": precio,
        "comisiones": comisiones,
    }


def guardar(year, filas):
    payload, error = sanitize_ventas_payload({"year": year, "rows": filas}, year)
    assert error is None, error
    validar_para_guardar(payload)
    write_ventas_year(year, payload)
    return read_ventas_year(year)


def venta(id_, fecha, cantidad, valor, asset_id="acme", comision=""):
    return {
        "id": id_,
        "fecha": fecha,
        "assetId": asset_id,
        "cantidad": cantidad,
        "valorVenta": valor,
        "comisionVenta": comision,
    }


class TestCalculo:
    def test_coste_fifo_y_cuota_los_pone_el_servidor(self, temp_db):
        crear_activo(filas=[
            compra_ficha("01-01-2023", "10", "10"),    # 100 €
            compra_ficha("01-06-2023", "10", "20"),    # 200 €
        ])
        datos = guardar("2024", [venta("v1", "01-09-2024", "15", "30")])

        fila = datos["rows"][0]
        # 10 a 10 € + 5 a 20 € = 200 € de coste sobre 15 participaciones.
        assert fila["costeAdquisicion"] == "200.00"
        assert fila["valorCompra"] == "13.33"
        assert fila["dineroDeclarar"] == "250.00"
        assert fila["totalPagar"] == "47.50"          # 250 x 19%
        assert fila["neto"] == "402.50"
        assert fila["incidencia"] == ""

    def test_los_importes_que_manda_el_cliente_se_ignoran(self, temp_db):
        # El POST antes escribía estos campos tal cual. Ahora son derivados.
        crear_activo(filas=[compra_ficha("01-01-2023", "10", "10")])
        fila_manipulada = venta("v1", "01-09-2024", "10", "30")
        fila_manipulada.update({
            "dineroDeclarar": "0", "totalPagar": "0", "valorCompra": "999",
        })
        datos = guardar("2024", [fila_manipulada])

        assert datos["rows"][0]["valorCompra"] == "10.00"
        assert datos["rows"][0]["dineroDeclarar"] == "200.00"

    def test_la_traza_de_lotes_acompana_a_cada_venta(self, temp_db):
        crear_activo(filas=[
            compra_ficha("01-01-2023", "10", "10"),
            compra_ficha("01-06-2023", "10", "20"),
        ])
        datos = guardar("2024", [venta("v1", "01-09-2024", "15", "30")])

        lotes = datos["rows"][0]["lotes"]
        assert len(lotes) == 2
        assert lotes[0]["fecha"] == "01-01-2023"
        assert lotes[0]["cantidad"] == "10.00000000"
        assert lotes[1]["coste"] == "100.00"

    def test_la_comision_de_venta_minora_el_valor_de_transmision(self, temp_db):
        crear_activo(filas=[compra_ficha("01-01-2023", "10", "10")])
        datos = guardar("2024", [venta("v1", "01-09-2024", "10", "30", comision="25")])

        assert datos["rows"][0]["valorTransmision"] == "275.00"
        assert datos["rows"][0]["dineroDeclarar"] == "175.00"

    def test_una_venta_anterior_no_se_regala_a_la_siguiente(self, temp_db):
        # El fallo que arrastraba la versión en el navegador: al abrir 2026 se
        # reconstruían los lotes sin descontar lo vendido en 2025, y las dos
        # ventas usaban el mismo lote barato.
        crear_activo(filas=[
            compra_ficha("01-01-2023", "10", "10"),    # 10 €/ud
            compra_ficha("01-06-2023", "10", "50"),    # 50 €/ud
        ])
        guardar("2025", [venta("v1", "01-09-2025", "10", "60")])
        datos = guardar("2026", [venta("v2", "01-09-2026", "10", "60")])

        assert datos["rows"][0]["valorCompra"] == "50.00"
        assert datos["rows"][0]["dineroDeclarar"] == "100.00"

    def test_los_tramos_de_las_filas_suman_la_cuota_del_ejercicio(self, temp_db):
        crear_activo(filas=[compra_ficha("01-01-2023", "1000", "1")])
        datos = guardar("2024", [
            venta("v1", "01-03-2024", "100", "51"),
            venta("v2", "01-06-2024", "100", "51"),
            venta("v3", "01-09-2024", "100", "51"),
        ])

        from decimal import Decimal
        suma = sum(
            Decimal(fila[f"tramo{n}"]) for fila in datos["rows"] for n in range(1, 6)
        )
        assert suma == Decimal(datos["resumen"]["cuota"])


class TestIncidencias:
    def test_vender_mas_de_lo_disponible_se_guarda_marcado(self, temp_db):
        crear_activo(filas=[compra_ficha("01-01-2023", "5", "10")])
        datos = guardar("2024", [venta("v1", "01-09-2024", "50", "30")])

        fila = datos["rows"][0]
        assert fila["incidencia"] == "stock_insuficiente"
        assert fila["dineroDeclarar"] == ""
        assert "más participaciones de las disponibles" in fila["mensaje"]
        assert datos["incidencias"][0]["id"] == "v1"
        # Y no contamina la liquidación del ejercicio.
        assert datos["resumen"]["cuota"] == "0.00"

    def test_una_fecha_ilegible_impide_guardar(self, temp_db):
        crear_activo(filas=[compra_ficha("01-01-2023", "10", "10")])
        with pytest.raises(ValidationError) as error:
            guardar("2024", [venta("v1", "el martes", "1", "30")])
        assert error.value.details[0]["codigo"] == ventas_fifo.INCIDENCIA_FECHA

    def test_una_cantidad_de_cero_impide_guardar(self, temp_db):
        crear_activo(filas=[compra_ficha("01-01-2023", "10", "10")])
        with pytest.raises(ValidationError):
            guardar("2024", [venta("v1", "01-09-2024", "0", "30")])

    def test_un_activo_inexistente_impide_guardar(self, temp_db):
        crear_activo()
        with pytest.raises(ValidationError):
            guardar("2024", [venta("v1", "01-09-2024", "1", "30", asset_id="fantasma")])

    def test_una_fecha_de_otro_ejercicio_impide_guardar(self, temp_db):
        crear_activo(filas=[compra_ficha("01-01-2023", "10", "10")])
        with pytest.raises(ValidationError) as error:
            guardar("2024", [venta("v1", "01-09-2025", "1", "30")])
        assert error.value.details[0]["codigo"] == ventas_fifo.INCIDENCIA_ANIO

    def test_una_fila_a_medio_rellenar_se_guarda_marcada_sin_bloquear(self, temp_db):
        crear_activo(filas=[compra_ficha("01-01-2023", "10", "10")])
        datos = guardar("2024", [
            venta("v1", "", "", ""),                     # solo el activo elegido
            venta("v2", "01-09-2024", "5", "30"),
        ])
        assert datos["rows"][0]["incidencia"] == ventas_fifo.INCIDENCIA_CANTIDAD
        assert datos["rows"][1]["dineroDeclarar"] == "100.00"

    def test_dos_filas_con_el_mismo_id_se_rechazan(self, temp_db):
        crear_activo(filas=[compra_ficha("01-01-2023", "10", "10")])
        payload, error = sanitize_ventas_payload({
            "year": "2024",
            "rows": [venta("v1", "01-09-2024", "1", "30"),
                     venta("v1", "02-09-2024", "1", "30")],
        }, "2024")
        assert payload is None
        assert "mismo identificador" in error


class TestNormativa:
    def test_la_recompra_rapida_bloquea_la_minusvalia(self, temp_db):
        crear_activo(filas=[
            compra_ficha("01-01-2023", "10", "100"),
            compra_ficha("15-06-2024", "10", "60"),
        ])
        datos = guardar("2024", [venta("v1", "01-06-2024", "10", "60")])

        fila = datos["rows"][0]
        assert fila["dineroDeclarar"] == "0.00"
        assert fila["perdidaNoComputable"] == "400.00"
        assert fila["notaAntiaplicacion"]

    def test_el_saldo_negativo_de_un_ano_compensa_el_siguiente(self, temp_db):
        crear_activo(filas=[
            compra_ficha("01-01-2023", "10", "200"),
            compra_ficha("01-02-2023", "10", "100"),
        ])
        guardar("2024", [venta("v1", "01-06-2024", "10", "100")])    # -1000
        datos = guardar("2025", [venta("v2", "01-06-2025", "10", "400")])

        assert datos["resumen"]["compensadoAnteriores"] == "1000.00"
        assert datos["resumen"]["base"] == "2000.00"
