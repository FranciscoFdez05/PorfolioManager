"""Pruebas del informe anual de ganancias y pérdidas patrimoniales.

Dos cosas se comprueban aquí y ninguna es cosmética:

  * Que el CSV y el HTML salen del **mismo** cálculo. Son el documento que se
    archiva y el que se mira; si divergen, la discrepancia no la ve nadie.
  * Que el desglose de saldos negativos arrastrados dice de qué ejercicio viene
    cada trozo y hasta cuándo se puede aplicar. El total agregado que había
    antes no sirve para declarar: cada saldo caduca por su cuenta a los cuatro
    ejercicios (art. 49.1.b LIRPF).
"""

from decimal import Decimal

import pytest


@pytest.fixture
def cliente(cliente_autenticado, temp_db, monkeypatch):
    from routes.ventas import ventas_bp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = cliente_autenticado(ventas_bp)
    return client, cabeceras


def _sembrar(activo="apple", tipo="acciones", compras=(), ventas=()):
    """Crea un activo con sus compras en la ficha y sus ventas en la tabla fiscal."""
    from core.db import get_db

    conn = get_db()
    conn.execute("INSERT INTO activos (id, name, type) VALUES (?,?,?)", (activo, activo.title(), tipo))
    for fecha, cantidad, capital in compras:
        conn.execute(
            "INSERT INTO activo_rows (asset_id, fecha_operacion, tipo_operacion, "
            "participaciones, capital_invertido_bruto) VALUES (?,?,?,?,?)",
            (activo, fecha, "Compra", cantidad, capital),
        )
    for year in {v[0][-4:] for v in ventas}:
        conn.execute("INSERT OR IGNORE INTO ventas_years (year) VALUES (?)", (year,))
    for indice, (fecha, cantidad, valor) in enumerate(ventas):
        conn.execute(
            "INSERT INTO ventas (id, year, fecha, asset_id, activo, cantidad, valor_venta, comision_venta) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (f"v{indice}", fecha[-4:], fecha, activo, activo.title(), cantidad, valor, "0"),
        )
    conn.commit()


# ── Formato de importes ──────────────────────────────────────────────────────

@pytest.mark.parametrize("valor,esperado", [
    ("1234.5", "1.234,50"),
    ("0", "0,00"),
    ("-987.65", "-987,65"),
    ("1234567.891", "1.234.567,89"),
    ("", "0,00"),
    (None, "0,00"),
    ("no es un número", "0,00"),
])
def test_los_importes_salen_en_formato_espaniol(valor, esperado):
    """Se van a teclear en Renta Web, que espera coma decimal y punto de millar."""
    from core.informe_renta import _es

    assert _es(valor) == esperado


# ── Estructura del informe ───────────────────────────────────────────────────

def test_el_informe_separa_las_filas_con_incidencia(cliente):
    """Una fila que no se pudo calcular no puede sumar en los totales."""
    from core.informe_renta import construir

    informe = construir(
        "2026",
        [
            {"fecha": "10-01-2026", "activo": "Apple", "cantidad": "10",
             "dineroDeclarar": "500", "incidencia": ""},
            {"fecha": "11-01-2026", "activo": "Fantasma", "cantidad": "1",
             "dineroDeclarar": "", "incidencia": "activo_desconocido",
             "mensaje": "El activo seleccionado ya no existe."},
        ],
        {"saldo": "500", "base": "500", "cuota": "95"},
    )

    assert len(informe["detalle"]) == 1
    assert len(informe["incidencias"]) == 1
    assert informe["incidencias"][0]["activo"] == "Fantasma"


def test_ganancias_y_perdidas_se_agregan_por_separado(cliente):
    """La declaración pide los dos importes, no solo el neto."""
    from core.informe_renta import construir

    informe = construir("2026", [
        {"fecha": "10-01-2026", "activo": "A", "cantidad": "1", "dineroDeclarar": "1000", "incidencia": ""},
        {"fecha": "11-01-2026", "activo": "B", "cantidad": "1", "dineroDeclarar": "-400", "incidencia": ""},
    ], {"saldo": "600"})

    totales = dict(informe["totales"])
    assert totales["Ganancias patrimoniales del ejercicio"] == "1.000,00"
    assert totales["Pérdidas patrimoniales computables del ejercicio"] == "400,00"
    assert totales["Saldo neto del ejercicio"] == "600,00"


# ── CSV ──────────────────────────────────────────────────────────────────────

def test_el_csv_usa_punto_y_coma_y_lleva_bom(cliente):
    """Con coma como separador, Excel en español mete la fila en una celda."""
    from core.informe_renta import a_csv, construir

    texto = a_csv(construir("2026", [], {}))

    assert texto.startswith("﻿")
    assert ";" in texto
    assert "\r\n" in texto


def test_el_csv_lista_cada_transmision(cliente):
    from core.informe_renta import a_csv, construir

    texto = a_csv(construir("2026", [
        {"fecha": "10-01-2026", "activo": "Apple", "cantidad": "10",
         "valorTransmision": "1500", "costeAdquisicion": "1000",
         "dineroDeclarar": "500", "incidencia": ""},
    ], {"saldo": "500", "base": "500", "cuota": "95"}))

    assert "10-01-2026;Apple;10;1.500,00;1.000,00;500,00" in texto
    assert "Base imponible del ahorro por este concepto;500,00" in texto


def test_el_csv_desglosa_los_arrastres_con_su_caducidad(cliente):
    from core.informe_renta import a_csv, construir

    texto = a_csv(construir("2026", [], {
        "arrastres": [
            {"anioOrigen": "2023", "importe": "1200", "ultimoEjercicio": "2027"},
            {"anioOrigen": "2025", "importe": "300", "ultimoEjercicio": "2029"},
        ],
    }))

    assert "2023;1.200,00;2027" in texto
    assert "2025;300,00;2029" in texto


def test_el_csv_dice_explicitamente_que_no_hay_arrastres(cliente):
    """Una sección vacía sin texto se lee como "se me olvidó mirarlo"."""
    from core.informe_renta import a_csv, construir

    assert "(ninguno)" in a_csv(construir("2026", [], {}))


def test_el_csv_incluye_las_advertencias(cliente):
    """El informe no cubre todo el apartado, y eso tiene que viajar con él."""
    from core.informe_renta import a_csv, construir

    texto = a_csv(construir("2026", [], {}))

    assert "capital mobiliario" in texto
    assert "abatimiento" in texto


# ── HTML ─────────────────────────────────────────────────────────────────────

def test_el_html_escapa_el_nombre_del_activo(cliente):
    """El nombre lo escribe el usuario y acaba dentro de una celda de tabla."""
    from core.informe_renta import a_html, construir

    documento = a_html(construir("2026", [
        {"fecha": "10-01-2026", "activo": "<img src=x onerror=alert(1)>", "cantidad": "1",
         "dineroDeclarar": "10", "incidencia": ""},
    ], {}))

    assert "<img src=x" not in documento
    assert "&lt;img src=x" in documento


def test_el_boton_de_imprimir_va_con_nonce_no_con_onclick(cliente):
    """La CSP de la aplicación no lleva 'unsafe-inline': un onclick no correría."""
    from core.informe_renta import a_html, construir

    documento = a_html(construir("2026", [], {}), nonce="abc123")

    assert 'nonce="abc123"' in documento
    assert "onclick=" not in documento


def test_el_html_tiene_estilos_de_impresion(cliente):
    from core.informe_renta import a_html, construir

    documento = a_html(construir("2026", [], {}))

    assert "@media print" in documento
    # El botón no debe salir en el papel.
    assert ".acciones { display: none; }" in documento


def test_csv_y_html_muestran_las_mismas_cifras(cliente):
    """Son el documento que se archiva y el que se mira: no pueden divergir."""
    from core.informe_renta import a_csv, a_html, construir

    informe = construir("2026", [
        {"fecha": "10-01-2026", "activo": "Apple", "cantidad": "10",
         "valorTransmision": "1500", "costeAdquisicion": "1000",
         "dineroDeclarar": "500", "incidencia": ""},
    ], {"saldo": "500", "compensadoAnteriores": "200", "base": "300", "cuota": "57"})

    csv_texto = a_csv(informe)
    html_texto = a_html(informe)

    for importe in ("1.500,00", "1.000,00", "500,00", "200,00", "300,00", "57,00"):
        assert importe in csv_texto
        assert importe in html_texto


# ── Rutas ────────────────────────────────────────────────────────────────────

def test_descargar_el_csv_de_un_ejercicio(cliente):
    client, _cabeceras = cliente
    _sembrar(
        compras=[("10-01-2025", "10", "1000")],
        # `valor_venta` es el precio POR participación, no el total: 10 x 150 = 1.500.
        ventas=[("15-06-2026", "10", "150")],
    )

    respuesta = client.get("/api/ventas/2026/informe.csv")

    assert respuesta.status_code == 200
    assert "attachment" in respuesta.headers["Content-Disposition"]
    assert "ganancias-patrimoniales-2026.csv" in respuesta.headers["Content-Disposition"]
    texto = respuesta.get_data(as_text=True)
    assert "Apple" in texto
    # 1500 de transmisión menos 1000 de coste.
    assert "500,00" in texto


def test_descargar_el_html_de_un_ejercicio(cliente):
    client, _cabeceras = cliente
    _sembrar(
        compras=[("10-01-2025", "10", "1000")],
        # `valor_venta` es el precio POR participación, no el total: 10 x 150 = 1.500.
        ventas=[("15-06-2026", "10", "150")],
    )

    respuesta = client.get("/api/ventas/2026/informe.html")

    assert respuesta.status_code == 200
    assert respuesta.headers["Content-Type"].startswith("text/html")
    documento = respuesta.get_data(as_text=True)
    assert "Ganancias y pérdidas patrimoniales" in documento
    assert "Apple" in documento


def test_el_html_del_informe_pasa_la_csp_de_la_aplicacion(cliente):
    """El nonce de la respuesta tiene que ser el mismo que el de la cabecera."""
    import re

    client, _cabeceras = cliente
    _sembrar(compras=[("10-01-2025", "10", "1000")], ventas=[("15-06-2026", "10", "150")])

    respuesta = client.get("/api/ventas/2026/informe.html")

    nonce_html = re.search(r'nonce="([^"]+)"', respuesta.get_data(as_text=True)).group(1)
    assert f"'nonce-{nonce_html}'" in respuesta.headers["Content-Security-Policy"]


def test_un_ejercicio_inexistente_es_404(cliente):
    client, _cabeceras = cliente
    assert client.get("/api/ventas/2099/informe.csv").status_code == 404
    assert client.get("/api/ventas/2099/informe.html").status_code == 404


def test_un_anio_invalido_es_400(cliente):
    client, _cabeceras = cliente
    assert client.get("/api/ventas/no-es-un-anio/informe.csv").status_code == 400


def test_el_informe_no_se_descarga_sin_sesion(crear_app, temp_db):
    """Lleva dentro el histórico fiscal completo del usuario."""
    from routes.ventas import ventas_bp

    client = crear_app(ventas_bp).test_client()
    assert client.get("/api/ventas/2026/informe.csv").status_code == 401


# ── Arrastres, extremo a extremo con el motor fiscal ─────────────────────────

def test_una_perdida_se_arrastra_con_su_ejercicio_de_origen():
    """Es el dato que el total agregado no daba y que la declaración pide."""
    from core.fiscal_es import liquidar_ejercicios

    class _R:
        """Resultado mínimo: liquidar_ejercicios solo mira estos atributos."""
        def __init__(self, ganancia):
            self.fiscal = True
            self.incidencia = ""
            self.ganancia_computable = Decimal(ganancia)
            self.perdida_no_computable = Decimal("0")
            self.perdida_diferida_liberada = Decimal("0")

    liquidaciones = liquidar_ejercicios({
        "2024": [_R("-1000")],
        "2025": [_R("-500")],
        "2026": [_R("300")],
    })

    arrastres_2026 = liquidaciones["2026"].arrastres
    # 2024 aportó 1000 y 2026 compensó 300 contra el más antiguo.
    assert arrastres_2026[0]["anio_origen"] == 2024
    assert arrastres_2026[0]["importe"] == Decimal("700")
    assert arrastres_2026[0]["ultimo_ejercicio"] == 2028
    assert arrastres_2026[1]["anio_origen"] == 2025
    assert arrastres_2026[1]["importe"] == Decimal("500")
    assert arrastres_2026[1]["ultimo_ejercicio"] == 2029

    # Y queda constancia de contra qué ejercicio se compensó.
    aplicadas = liquidaciones["2026"].compensaciones_aplicadas
    assert aplicadas == [{"anio_origen": 2024, "importe": Decimal("300"), "ultimo_ejercicio": 2028}]


def test_un_saldo_negativo_caducado_desaparece_del_arrastre():
    """Pasados cuatro ejercicios ya no se puede aplicar (art. 49.1.b)."""
    from core.fiscal_es import liquidar_ejercicios

    class _R:
        def __init__(self, ganancia):
            self.fiscal = True
            self.incidencia = ""
            self.ganancia_computable = Decimal(ganancia)
            self.perdida_no_computable = Decimal("0")
            self.perdida_diferida_liberada = Decimal("0")

    liquidaciones = liquidar_ejercicios({
        "2020": [_R("-1000")],
        "2026": [_R("0")],
    })

    assert liquidaciones["2026"].arrastres == []
    assert liquidaciones["2026"].pendiente_compensar == Decimal("0")


# ── Secciones condicionales del CSV y del HTML ───────────────────────────────
#
# Las compensaciones, los arrastres y las filas excluidas solo se imprimen si
# hay algo que imprimir. Son ramas enteras que ninguna prueba recorría, y son
# precisamente las que aparecen el año en que hay pérdidas que compensar: el
# año en que el informe importa de verdad.

def _resumen(**extra):
    """Resumen con la forma que devuelve el motor fiscal, para variar solo un campo."""
    base = {
        "saldoNegativoGenerado": "0",
        "perdidasDiferidasLiberadas": "0",
        "arrastres": [],
        # La clave que lee `construir` es esta, no "compensaciones": el nombre
        # cambia entre lo que produce el motor fiscal y lo que expone el informe.
        "compensacionesAplicadas": [],
    }
    base.update(extra)
    return base


def test_el_csv_lista_las_compensaciones_aplicadas():
    from core.informe_renta import a_csv, construir

    texto = a_csv(construir("2026", [], _resumen(
        compensacionesAplicadas=[
            {"anioOrigen": "2022", "importe": "1500.50"},
            {"anioOrigen": "2023", "importe": "800"},
        ],
    )))

    assert "COMPENSACIONES APLICADAS EN ESTE EJERCICIO" in texto
    assert "2022" in texto and "1.500,50" in texto
    assert "2023" in texto and "800,00" in texto


def test_el_csv_lista_las_filas_excluidas_con_su_motivo():
    """Sin esta sección, el usuario no sabe qué se quedó fuera del cálculo."""
    from core.informe_renta import a_csv, construir

    texto = a_csv(construir("2026", [
        {"fecha": "10-01-2026", "activo": "Fantasma", "dineroDeclarar": "",
         "incidencia": "sin_adquisiciones", "mensaje": "No hay compras registradas"},
    ], _resumen()))

    assert "FILAS EXCLUIDAS DEL CÁLCULO" in texto
    assert "Fantasma" in texto
    assert "No hay compras registradas" in texto


def test_el_html_lista_los_arrastres_pendientes():
    from core.informe_renta import a_html, construir

    documento = a_html(construir("2026", [], _resumen(
        arrastres=[{"anioOrigen": "2024", "importe": "2000", "ultimoEjercicio": "2028"}],
    )))

    assert "2024" in documento
    assert "2.000,00" in documento
    assert "2028" in documento
    assert "No queda ningún saldo negativo pendiente" not in documento


def test_el_html_dice_cuando_no_hay_arrastres():
    """El caso normal: hay que decirlo, no dejar la sección en blanco."""
    from core.informe_renta import a_html, construir

    documento = a_html(construir("2026", [], _resumen()))

    assert "No queda ningún saldo negativo pendiente" in documento


def test_el_html_lista_las_compensaciones_aplicadas():
    from core.informe_renta import a_html, construir

    documento = a_html(construir("2026", [], _resumen(
        compensacionesAplicadas=[{"anioOrigen": "2023", "importe": "450.75"}],
    )))

    assert "Compensaciones aplicadas en este ejercicio" in documento
    assert "450,75" in documento


def test_el_html_escapa_lo_que_viene_del_usuario():
    """El nombre del activo lo teclea el usuario y acaba dentro de una tabla HTML."""
    from core.informe_renta import a_html, construir

    documento = a_html(construir("2026", [
        {"fecha": "10-01-2026", "activo": "<script>alert(1)</script>",
         "dineroDeclarar": "", "incidencia": "sin_adquisiciones", "mensaje": "x"},
    ], _resumen()))

    assert "<script>alert(1)</script>" not in documento
    assert "&lt;script&gt;" in documento


def test_el_html_lista_las_filas_excluidas():
    from core.informe_renta import a_html, construir

    documento = a_html(construir("2026", [
        {"fecha": "10-01-2026", "activo": "Fantasma", "dineroDeclarar": "",
         "incidencia": "sin_adquisiciones", "mensaje": "No hay compras registradas"},
    ], _resumen()))

    assert "Filas excluidas del cálculo" in documento
    assert "No hay compras registradas" in documento
