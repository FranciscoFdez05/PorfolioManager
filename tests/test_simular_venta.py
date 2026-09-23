"""Simulador de venta: qué pagarías si vendieras hoy.

Comparte motor con la pantalla de Ventas, así que lo que se prueba aquí es que
la simulación **no** se desvía de él: mismo coste FIFO, misma escala del ahorro
y misma regla de los dos meses. Y que no deja nada escrito, que es lo que
separa una simulación de una venta.
"""

import pytest

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


def guardar_venta(year, filas):
    payload, error = sanitize_ventas_payload({"year": year, "rows": filas}, year)
    assert error is None, error
    validar_para_guardar(payload)
    write_ventas_year(year, payload)
    return read_ventas_year(year)


# ── Coste y ganancia ─────────────────────────────────────────────────────────

def test_el_coste_sale_del_fifo_no_del_precio_medio(temp_db):
    crear_activo(filas=[
        compra_ficha("01-01-2023", "10", "10"),   # 100 €
        compra_ficha("01-06-2023", "10", "20"),   # 200 €
    ])

    dato, incidencia = ventas_fifo.simular_venta("acme", "01-09-2026", "15", "30")

    assert incidencia == ""
    # FIFO: las 10 primeras a 10 € y 5 de las segundas a 20 € = 200 €.
    # El precio medio (15 €) habría dado 225 €.
    assert dato["costeAdquisicion"] == "200.00"
    assert dato["valorTransmision"] == "450.00"
    assert dato["ganancia"] == "250.00"
    assert dato["disponible"] == "20.00000000"


def test_detalla_los_lotes_que_consume(temp_db):
    crear_activo(filas=[
        compra_ficha("01-01-2023", "10", "10"),
        compra_ficha("01-06-2023", "10", "20"),
    ])

    dato, _ = ventas_fifo.simular_venta("acme", "01-09-2026", "15", "30")

    assert [(l["fecha"], l["cantidad"]) for l in dato["lotes"]] == [
        ("01-01-2023", "10.00000000"),
        ("01-06-2023", "5.00000000"),
    ]


# ── Cuota ────────────────────────────────────────────────────────────────────

def test_la_cuota_es_la_del_primer_tramo_cuando_no_hay_mas_ventas(temp_db):
    crear_activo(filas=[compra_ficha("01-01-2023", "10", "100")])

    dato, _ = ventas_fifo.simular_venta("acme", "01-09-2026", "10", "200")

    # 1.000 € de ganancia, todo dentro del tramo del 19 %.
    assert dato["ganancia"] == "1000.00"
    assert dato["cuota"] == "190.00"
    assert dato["tipoEfectivo"] == "19.00"


def test_la_cuota_es_incremental_sobre_lo_ya_vendido_ese_año(temp_db):
    """Con 6.000 € ya declarados, la ganancia nueva entra en el tramo del 21 %."""
    crear_activo(filas=[
        compra_ficha("01-01-2023", "100", "10"),
        compra_ficha("02-01-2023", "10", "100"),
    ])
    # Venta real de 2026: 6.000 € de ganancia, que agotan el primer tramo.
    guardar_venta("2026", [{
        "id": "v1", "fecha": "01-03-2026", "assetId": "acme",
        "cantidad": "100", "valorVenta": "70", "comisionVenta": "",
    }])

    dato, _ = ventas_fifo.simular_venta("acme", "01-09-2026", "10", "200")

    assert dato["ganancia"] == "1000.00"
    # Si se hubiera calculado aislada habrían salido 190 € (19 %).
    assert dato["cuota"] == "210.00"
    assert dato["tipoEfectivo"] == "21.00"
    assert dato["cuotaEjercicioAntes"] == "1140.00"
    assert dato["cuotaEjercicioDespues"] == "1350.00"


def test_una_perdida_anterior_compensa_y_baja_el_tipo(temp_db):
    crear_activo(filas=[
        compra_ficha("01-01-2023", "10", "100"),   # 1.000 €
        compra_ficha("02-01-2023", "10", "100"),
    ])
    # 2024 cierra con 500 € de pérdida.
    guardar_venta("2024", [{
        "id": "v1", "fecha": "01-03-2024", "assetId": "acme",
        "cantidad": "10", "valorVenta": "50", "comisionVenta": "",
    }])

    dato, _ = ventas_fifo.simular_venta("acme", "01-09-2026", "10", "200")

    assert dato["ganancia"] == "1000.00"
    assert dato["compensadoAnteriores"] == "500.00"
    # Solo tributan los 500 € que quedan después de compensar.
    assert dato["cuota"] == "95.00"


# ── Normativa y avisos ───────────────────────────────────────────────────────

def test_la_perdida_recomprada_no_computa(temp_db):
    """Regla de los dos meses: recomprar bloquea la minusvalía (art. 33.5)."""
    crear_activo(filas=[
        compra_ficha("01-01-2023", "10", "100"),
        compra_ficha("15-09-2026", "10", "50"),   # recompra dentro de la ventana
    ])

    dato, _ = ventas_fifo.simular_venta("acme", "01-09-2026", "10", "50")

    assert dato["ganancia"] == "0.00"
    assert dato["perdidaNoComputable"] == "500.00"
    assert dato["notaAntiaplicacion"]


def test_vender_mas_de_lo_que_hay_avisa_sin_romper(temp_db):
    crear_activo(filas=[compra_ficha("01-01-2023", "10", "100")])

    dato, incidencia = ventas_fifo.simular_venta("acme", "01-09-2026", "50", "200")

    assert incidencia == ""
    assert dato["incidencia"]
    assert "más participaciones de las disponibles" in dato["mensaje"]
    assert dato["disponible"] == "10.00000000"


def test_cripto_usa_la_ventana_de_un_año(temp_db):
    """Para los no cotizados la recompra bloquea durante un año, no dos meses."""
    crear_activo("btc", tipo="cripto", filas=[
        compra_ficha("01-01-2023", "1", "40000"),
        compra_ficha("01-03-2027", "1", "20000"),   # seis meses después
    ])

    dato, _ = ventas_fifo.simular_venta("btc", "01-09-2026", "1", "20000")

    assert dato["perdidaNoComputable"] == "20000.00"


# ── Entradas inválidas ───────────────────────────────────────────────────────

@pytest.mark.parametrize("args, esperado", [
    (("no-existe", "01-09-2026", "1", "10"), ventas_fifo.INCIDENCIA_ACTIVO),
    (("acme", "32-13-2026", "1", "10"), ventas_fifo.INCIDENCIA_FECHA),
    (("acme", "01-09-2026", "0", "10"), ventas_fifo.INCIDENCIA_CANTIDAD),
    (("acme", "01-09-2026", "1", "-5"), ventas_fifo.INCIDENCIA_PRECIO),
])
def test_entradas_invalidas(temp_db, args, esperado):
    crear_activo(filas=[compra_ficha("01-01-2023", "10", "100")])

    dato, incidencia = ventas_fifo.simular_venta(*args)

    assert dato is None
    assert incidencia == esperado


def test_simular_no_guarda_nada(temp_db):
    crear_activo(filas=[compra_ficha("01-01-2023", "10", "100")])
    antes = ventas_fifo.cartera_viva()["acme"]["cantidad"]

    ventas_fifo.simular_venta("acme", "01-09-2026", "5", "200")

    assert ventas_fifo.cartera_viva()["acme"]["cantidad"] == antes
