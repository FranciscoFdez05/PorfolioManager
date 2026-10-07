"""Regresiones de los fallos que encontró la auditoría del 7 de octubre de 2026.

Cada test reproduce un fallo que llegó a confirmarse (petición real o script)
y comprueba que ya no ocurre. El identificador entre corchetes es el del
informe (`auditoria/informe.md`).
"""

import json
import re
import sqlite3
import time
import zipfile
from io import BytesIO
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parent.parent


# ── [A-01] El tipo de cambio histórico no se pierde al reescribir un activo ──

def _activo_con_compra(fecha="02-01-2024", divisa="USD"):
    from stores.asset_store import writeAssetFile

    writeAssetFile("fx-prueba", {
        "name": "FX Prueba", "type": "acciones", "currency": divisa,
        "rows": [{"fechaOperacion": fecha, "tipoOperacion": "Compra", "currency": divisa,
                  "participaciones": "10", "precioParticipacion": "100", "capitalInvertidoBruto": "1000"}],
    })


def _fx_de(conn, tabla="activo_rows"):
    return conn.execute(f"SELECT fx_rate, fx_fecha, fx_origen FROM {tabla} WHERE asset_id='fx-prueba'").fetchall()


def test_guardar_el_activo_conserva_el_tipo_de_cambio(temp_db):
    """[A-01] El formulario manda las filas sin fx_*: antes se borraban en cada guardado."""
    from core.db import get_db
    from stores.asset_store import readAssetFile, writeAssetFile

    _activo_con_compra()
    conn = get_db()
    conn.execute("UPDATE activo_rows SET fx_rate='0.91', fx_fecha='2024-01-02', fx_origen='manual'")
    conn.commit()

    datos = readAssetFile("fx-prueba")
    for fila in datos["rows"]:  # como llegan del navegador: sin el trío fx
        for clave in ("fxRate", "fxFecha", "fxOrigen"):
            fila.pop(clave, None)
    writeAssetFile("fx-prueba", datos)

    assert [tuple(f) for f in _fx_de(conn)] == [("0.91", "2024-01-02", "manual")]


def test_cambiar_la_fecha_de_la_compra_deja_el_tipo_pendiente(temp_db):
    """El tipo depende de la fecha: con otra fecha ya no vale y debe volver a pedirse."""
    from core.db import get_db
    from stores.asset_store import readAssetFile, writeAssetFile

    _activo_con_compra()
    conn = get_db()
    conn.execute("UPDATE activo_rows SET fx_rate='0.91', fx_fecha='2024-01-02', fx_origen='manual'")
    conn.commit()

    datos = readAssetFile("fx-prueba")
    datos["rows"][0] = {**datos["rows"][0], "fechaOperacion": "05-03-2024", "fxRate": ""}
    writeAssetFile("fx-prueba", datos)

    assert [tuple(f) for f in _fx_de(conn)] == [("", "", "")]


def test_get_operaciones_no_toca_las_compras_ni_escribe_si_no_hay_cambios(temp_db):
    """[A-01][M-07] El GET reescribía todos los activos y borraba su tipo de cambio."""
    from core.db import get_db
    from stores.helpers import sync_completed_operations_into_assets

    _activo_con_compra()
    conn = get_db()
    conn.execute("UPDATE activo_rows SET fx_rate='0.91', fx_fecha='2024-01-02', fx_origen='manual'")
    conn.commit()
    id_antes = conn.execute("SELECT id FROM activo_rows").fetchone()[0]

    operaciones = [{"id": "op-1", "assetId": "fx-prueba", "estado": "Completado", "orden": "Compra",
                    "fechaApertura": "03-01-2024", "cantidad": "1", "total": "100", "currency": "USD"}]
    sync_completed_operations_into_assets(operaciones)
    cambios = conn.total_changes
    sync_completed_operations_into_assets(operaciones)  # lo que hace cada GET

    assert conn.total_changes == cambios, "un GET sin cambios no debe escribir"
    assert conn.execute("SELECT id FROM activo_rows").fetchone()[0] == id_antes
    assert [tuple(f) for f in _fx_de(conn)] == [("0.91", "2024-01-02", "manual")]
    assert conn.execute("SELECT COUNT(*) FROM activo_operation_rows").fetchone()[0] == 1


def test_guardar_el_ejercicio_de_ventas_conserva_su_tipo_de_cambio(temp_db):
    """[A-01] El mismo fallo, en las ventas fiscales."""
    from core.db import get_db
    from stores.ventas_store import write_ventas_year

    _activo_con_compra()
    venta = {"id": "venta-1", "fecha": "10-01-2026", "assetId": "fx-prueba", "cantidad": "1", "valorVenta": "100"}
    write_ventas_year("2026", {"rows": [venta]})
    conn = get_db()
    conn.execute("UPDATE ventas SET fx_rate='0.95', fx_fecha='2026-01-10', fx_origen='yahoo'")
    conn.commit()

    write_ventas_year("2026", {"rows": [venta]})

    assert conn.execute("SELECT fx_rate FROM ventas").fetchone()[0] == "0.95"


# ── [A-02] Guardar un año con una copia antigua ya no borra lo que entró ──────

@pytest.fixture
def cliente_gastos(temp_db, cliente_autenticado):
    from routes.gastos import gastos_bp
    from routes.ingresos import ingresos_bp

    client, cabeceras, _app = cliente_autenticado(gastos_bp, ingresos_bp)
    client.post("/api/gastos", json={"year": "2026"}, headers=cabeceras)
    return client, cabeceras


def test_un_guardado_con_una_copia_antigua_recibe_409(cliente_gastos):
    from stores.movimientos_store import crearMovimiento, sanitizarMovimiento

    client, cabeceras = cliente_gastos
    copia = client.get("/api/gastos/2026").get_json()

    # Entra un gasto por otro camino (el Atajo) mientras la pestaña tiene su copia.
    crearMovimiento(sanitizarMovimiento({"tipo": "gasto", "nombre": "Desde el iPhone", "importe": 3,
                                         "fecha": "2026-10-02"}))

    respuesta = client.post("/api/gastos/2026", json=copia, headers=cabeceras)

    assert respuesta.status_code == 409
    assert respuesta.get_json()["conflicto"] is True
    filas = client.get("/api/gastos/2026").get_json()["months"]["octubre"]["rows"]
    assert [f["nombre"] for f in filas] == ["Desde el iPhone"]


def test_guardados_consecutivos_con_la_revision_devuelta_entran(cliente_gastos):
    client, cabeceras = cliente_gastos
    datos = client.get("/api/gastos/2026").get_json()

    primera = client.post("/api/gastos/2026", json=datos, headers=cabeceras).get_json()
    datos["revision"] = primera["revision"]
    segunda = client.post("/api/gastos/2026", json=datos, headers=cabeceras)

    assert segunda.status_code == 200
    assert segunda.get_json()["revision"] == primera["revision"] + 1


def test_sin_revision_se_guarda_como_siempre(cliente_gastos):
    """Scripts e importaciones que no la mandan siguen funcionando."""
    client, cabeceras = cliente_gastos
    datos = client.get("/api/gastos/2026").get_json()
    datos.pop("revision")

    assert client.post("/api/gastos/2026", json=datos, headers=cabeceras).status_code == 200


def test_ingresos_tambien_detecta_la_copia_antigua(cliente_gastos):
    from stores.movimientos_store import crearMovimiento, sanitizarMovimiento

    client, cabeceras = cliente_gastos
    client.post("/api/ingresos", json={"year": "2026"}, headers=cabeceras)
    copia = client.get("/api/ingresos/2026").get_json()
    crearMovimiento(sanitizarMovimiento({"tipo": "ingreso", "nombre": "Bizum", "importe": 5, "fecha": "2026-10-02"}))

    assert client.post("/api/ingresos/2026", json=copia, headers=cabeceras).status_code == 409


def test_renombrar_una_categoria_invalida_las_copias_abiertas(cliente_gastos):
    """Si no, la pestaña abierta desharía el renombrado al guardar."""
    from stores import categorias_store, revisiones

    client, cabeceras = cliente_gastos
    datos = client.get("/api/gastos/2026").get_json()
    datos["months"]["enero"]["rows"] = [{"fecha": "01-01-2026", "nombre": "Pan", "tipo": "Comida", "cantidad": "1"}]
    client.post("/api/gastos/2026", json=datos, headers=cabeceras)
    antes = revisiones.actual("gastos", "2026")

    categorias_store.renombrarCategoria("gasto", "Comida", "Alimentación")

    assert revisiones.actual("gastos", "2026") == antes + 1


# ── [B-01] Listas con elementos que no son objetos: 400, no 500 ───────────────

@pytest.mark.parametrize("ruta,cuerpo", [
    ("/api/gastos/2026", {"mensualidades": [1, "x", None]}),
    ("/api/gastos/2026", {"months": {"enero": {"rows": [1, None]}}, "year": "2026"}),
    ("/api/ingresos/2026", {"recurrentes": [1, "x", None]}),
    ("/api/ingresos/2026", {"months": "no-es-un-objeto"}),
])
def test_listas_con_basura_no_dan_500(cliente_gastos, ruta, cuerpo):
    client, cabeceras = cliente_gastos
    assert client.post(ruta, json=cuerpo, headers=cabeceras).status_code < 500


@pytest.fixture
def cliente_registros(temp_db, cliente_autenticado):
    from routes.registros import registros_bp
    from routes.trading import trading_bp

    client, cabeceras, _app = cliente_autenticado(registros_bp, trading_bp)
    return client, cabeceras


def test_intereses_con_una_cuenta_que_no_es_objeto_da_400(cliente_registros):
    client, cabeceras = cliente_registros
    assert client.post("/api/intereses", json={"cuentas": [1]}, headers=cabeceras).status_code == 400
    assert client.post("/api/intereses", json={"cuentas": [{"rows": [1]}]}, headers=cabeceras).status_code == 400


# ── [M-09] Rutas que no tenían ningún test ────────────────────────────────────

def test_intereses_ida_y_vuelta(cliente_registros):
    client, cabeceras = cliente_registros
    cuentas = [{"id": "c1", "nombre": "Remunerada", "rows": [{"fecha": "01-2026", "acumulado": "10", "impuestos": "1"}]}]

    assert client.post("/api/intereses", json={"cuentas": cuentas}, headers=cabeceras).get_json()["ok"]
    # Sin cuenta de «Cuentas» elegida, `cuenta` vuelve vacío.
    assert client.get("/api/intereses").get_json()["cuentas"] == [{**cuentas[0], "cuenta": ""}]
    assert client.post("/api/intereses/reset", headers=cabeceras).get_json()["ok"]
    assert client.get("/api/intereses").get_json()["cuentas"] == []


def test_trading_ida_y_vuelta_y_normaliza_valores(cliente_registros):
    client, cabeceras = cliente_registros
    filas = [{"id": "t1", "fecha": "01-10-2026", "tipo": "swing", "moneda": "btc",
              "direccion": "inventada", "resultado": "perdida", "capital": "100"}]

    assert client.post("/api/trading", json={"rows": filas}, headers=cabeceras).get_json()["ok"]
    guardada = client.get("/api/trading").get_json()["rows"][0]

    assert (guardada["tipo"], guardada["moneda"], guardada["direccion"], guardada["resultado"]) == (
        "SWING", "BTC", "LONG", "PÉRDIDA")


@pytest.mark.parametrize("ruta", [
    "/api/intereses", "/api/dividendos", "/api/dividendos/calendar", "/api/transacciones", "/api/bonos",
    "/api/rentafija", "/api/privatemarket", "/api/staking", "/api/earn", "/api/trading",
])
def test_las_rutas_de_registros_no_dan_500_con_tipos_cambiados(cliente_registros, ruta):
    client, cabeceras = cliente_registros
    assert client.get(ruta).status_code == 200
    for cuerpo in ({"rows": [1, "x", None]}, {"rows": "x"}, {"cuentas": "x"}, {"items": [None]}, {}):
        assert client.post(ruta, json=cuerpo, headers=cabeceras).status_code < 500, (ruta, cuerpo)


def test_get_operaciones_responde(temp_db, cliente_autenticado):
    from routes.operaciones import operaciones_bp

    client, cabeceras, _app = cliente_autenticado(operaciones_bp)
    filas = [{"id": "op-1", "activo": "BTC", "orden": "Compra", "estado": "Activo", "cantidad": "1"}]
    assert client.post("/api/operaciones", json={"rows": filas}, headers=cabeceras).get_json()["ok"]
    assert client.get("/api/operaciones").get_json()["rows"][0]["id"] == "op-1"


# ── [M-02] SECRET_KEY de ejemplo ──────────────────────────────────────────────

@pytest.mark.parametrize("clave", ["cambia_esto_por_una_clave_aleatoria_larga", "CAMBIA_ESTO_tambien", "corta"])
def test_una_secret_key_insegura_no_arranca(clave):
    from core import seguridad_app

    with pytest.raises(SystemExit):
        seguridad_app.rechazar_secret_key_insegura(clave)


@pytest.mark.parametrize("clave", ["", "a" * 64])
def test_una_secret_key_aceptable_arranca(clave):
    from core import seguridad_app

    seguridad_app.rechazar_secret_key_insegura(clave)


def test_el_ejemplo_publicado_esta_en_la_lista_negra():
    texto = (RAIZ / ".env.example").read_text("utf-8")
    ejemplo = re.search(r"^SECRET_KEY=(.*)$", texto, re.M).group(1).strip()
    from core import seguridad_app

    with pytest.raises(SystemExit):
        seguridad_app.rechazar_secret_key_insegura(ejemplo)


# ── [M-06] La copia previa a una migración es de la base que se migra ─────────

def test_la_copia_previa_es_de_la_base_migrada(temp_db, tmp_path, monkeypatch):
    from admin import backup_manager
    from core import db

    copiadas = []
    monkeypatch.setattr(backup_manager, "backup_previo_a_migracion",
                        lambda ruta, desde, hasta: copiadas.append(Path(ruta).name))
    otra = tmp_path / "otra.db"
    sqlite3.connect(otra).close()

    with db.open_db_at(otra):
        pass

    assert copiadas == ["otra.db"]


# ── [B-11] Cada paso de migración es atómico ──────────────────────────────────

def test_un_paso_que_falla_no_deja_nada_a_medias(tmp_path, monkeypatch):
    from core import db

    ruta = tmp_path / "migrar.db"
    conn = sqlite3.connect(ruta)
    conn.executescript(db._SCHEMA)
    conn.execute(f"PRAGMA user_version = {db.ESQUEMA_VERSION}")
    conn.commit()

    def paso_que_falla(c):
        c.executescript("CREATE TABLE a_medias (x); INSERT INTO a_medias VALUES (1);")
        raise RuntimeError("corte a mitad del paso")

    siguiente = db.ESQUEMA_VERSION + 1
    monkeypatch.setattr(db, "_MIGRACIONES", [*db._MIGRACIONES, (siguiente, paso_que_falla)])
    monkeypatch.setattr(db, "ESQUEMA_VERSION", siguiente)
    monkeypatch.setattr(db, "_copia_antes_de_migrar", lambda *a: None)

    with pytest.raises(RuntimeError):
        db._migrate(conn, ruta)

    assert conn.execute("PRAGMA user_version").fetchone()[0] == siguiente - 1
    assert not conn.execute("SELECT 1 FROM sqlite_master WHERE name='a_medias'").fetchone()
    conn.close()


# ── [M-08] Sin manejadores en línea que la CSP bloquea ────────────────────────

def test_ningun_html_lleva_manejadores_en_linea():
    """La CSP no lleva 'unsafe-inline' en script-src: un onclick="…" no se ejecuta."""
    ficheros = [RAIZ / "index.html", *sorted((RAIZ / "html").rglob("*.html"))]
    culpables = [
        f"{f.relative_to(RAIZ)}: {m.group(0)}"
        for f in ficheros
        for m in re.finditer(r"\son[a-z]+\s*=\s*[\"']", f.read_text("utf-8"))
    ]
    assert culpables == []


# ── [B-06] Nombres del certificado ────────────────────────────────────────────

def test_los_nombres_del_certificado_no_admiten_nada_que_no_sea_un_host():
    from core import tls

    assert tls.normalizarNombres([
        "casa.lan", "https://Nas.Local:5000/x", "192.168.1.10", "[fd00::1]", "*.casa.lan",
        "malo\n#inyeccion", "con espacio", "a;b", "{x}", "",
    ]) == ["casa.lan", "nas.local", "192.168.1.10", "fd00::1", "*.casa.lan"]


# ── [B-08] Ficheros de ajustes enormes dentro de un ZIP ───────────────────────

def test_un_json_de_ajustes_enorme_se_rechaza():
    from core import zip_seguro

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("prefs_principal.json", "[" + "0," * (3 * 1024 * 1024) + "0]")
    with zipfile.ZipFile(buf) as zf, pytest.raises(zip_seguro.ZipNoAdmitido):
        zip_seguro.comprobar(zf)


# ── [B-09] Temporales huérfanos ───────────────────────────────────────────────

def test_la_limpieza_barre_los_temporales_de_hoy(datos_aislados):
    import os

    from core import paths
    from routes import backup

    tmp = paths.TMP_DIR
    tmp.mkdir(parents=True, exist_ok=True)
    viejo = tmp / ".principal.db.123-abc-ff00ff.tmp"
    reciente = tmp / ".principal.db.456-def-00ff00.tmp"
    zip_viejo = datos_aislados["backups"] / "_tmp_backup_01-01-2026_00-00-00.zip"
    for f in (viejo, reciente, zip_viejo):
        f.write_bytes(b"x")
    hace_dos_horas = time.time() - 7200
    for f in (viejo, zip_viejo):
        os.utime(f, (hace_dos_horas, hace_dos_horas))

    backup._limpiar_temporales_huerfanos()

    assert not viejo.exists() and not zip_viejo.exists()
    assert reciente.exists()  # puede ser una copia en curso


# ── [B-12] auth.dat ilegible ──────────────────────────────────────────────────

def test_un_auth_dat_ilegible_se_aparta_en_vez_de_sobrescribirse(datos_aislados, monkeypatch):
    from routes import auth

    monkeypatch.setattr(auth, "_AUTH_FILE", datos_aislados["auth"])
    datos_aislados["auth"].write_bytes(b"cifrado con otra SECRET_KEY")
    monkeypatch.setenv("LOGIN_USERNAME", "admin")
    monkeypatch.setenv("LOGIN_PASSWORD_HASH", "pbkdf2:sha256:600000$x$y")

    auth._load_credentials()

    apartados = list(datos_aislados["data"].glob("auth.dat.ilegible-*"))
    assert len(apartados) == 1 and apartados[0].read_bytes() == b"cifrado con otra SECRET_KEY"


# ── [B-02] Las peticiones anónimas no gastan el cupo de escrituras ────────────

def test_las_peticiones_anonimas_no_agotan_el_cupo_del_usuario(temp_db, crear_app, monkeypatch):
    from core import sesion
    from routes.trading import trading_bp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "3")
    app = crear_app(trading_bp)
    anonimo = app.test_client()
    for _ in range(10):
        assert anonimo.post("/api/trading", json={"rows": []}).status_code == 401

    usuario = app.test_client()
    with usuario.session_transaction() as s:
        s["logged_in"] = True
        s["csrf_token"] = "t" * 43
        sesion.abrir(s)
    respuesta = usuario.post("/api/trading", json={"rows": []}, headers={"X-CSRF-Token": "t" * 43})

    assert respuesta.status_code == 200


# ── [B-15] Nombres de cartera ─────────────────────────────────────────────────

def test_no_se_puede_crear_ni_renombrar_a_un_nombre_que_ya_existe(datos_aislados):
    from admin import portfolios_manager as pm

    datos_aislados["meta"].write_text(json.dumps({"active": None, "portfolios": []}), "utf-8")
    pid = pm.create_portfolio("Ahorro")
    otro = pm.create_portfolio("Otro")

    with pytest.raises(pm.NombreDuplicado):
        pm.create_portfolio("ahorro")
    with pytest.raises(pm.NombreDuplicado):
        pm.rename_portfolio(otro, "AHORRO")
    pm.rename_portfolio(pid, "Ahorro")  # renombrarse a sí mismo no choca


# ── [I-04] Un único cálculo de rendimiento ────────────────────────────────────

def test_la_lista_y_la_tabla_dan_las_mismas_cifras(temp_db, cliente_autenticado):
    """Antes eran dos copias del cálculo (float y Decimal) y podían diferir."""
    from routes.activos import activos_bp
    from stores.asset_store import listAssets, writeAssetFile

    writeAssetFile("cent", {
        "name": "Céntimos", "type": "acciones", "price": "10,01",
        "rows": [
            {"tipoOperacion": "Compra", "participaciones": "3", "capitalInvertidoBruto": "0,1", "comisiones": "0,01"},
            {"tipoOperacion": "Compra", "participaciones": "7", "capitalInvertidoBruto": "0,2", "comisiones": "0,02"},
            {"tipoOperacion": "Venta", "participaciones": "1,5"},
        ],
    })
    client, _cab, _app = cliente_autenticado(activos_bp)

    tabla = client.get("/api/activos/rendimiento-batch").get_json()["cent"]
    lista = next(a for a in listAssets() if a["id"] == "cent")

    for campo in ("rendimiento", "invertidoNeto", "rendimientoPct"):
        assert lista[campo] == tabla[campo], campo
    assert tabla["invertidoNeto"] == 0.27
    assert tabla["netoActual"] == 85.09  # 8,5 participaciones × 10,01


def test_el_importe_del_atajo_admite_separador_de_miles():
    from decimal import Decimal

    from stores.movimientos_store import formatearImporteEuro, normalizarImporte

    assert normalizarImporte("1.234,50 €") == Decimal("1234.50")
    assert normalizarImporte(12.345) == Decimal("12.35")  # redondeo comercial, no bancario
    assert formatearImporteEuro(Decimal("1234.5")) == "1.234,50 €"
