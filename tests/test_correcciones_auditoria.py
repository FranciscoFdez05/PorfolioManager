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

def _activoConCompra(fecha="02-01-2024", divisa="USD"):
    from stores.asset_store import writeAssetFile

    writeAssetFile("fx-prueba", {
        "name": "FX Prueba", "type": "acciones", "currency": divisa,
        "rows": [{"fechaOperacion": fecha, "tipoOperacion": "Compra", "currency": divisa,
                  "participaciones": "10", "precioParticipacion": "100", "capitalInvertidoBruto": "1000"}],
    })


def _fxDe(conn, tabla="activo_rows"):
    return conn.execute(f"SELECT fx_rate, fx_fecha, fx_origen FROM {tabla} WHERE asset_id='fx-prueba'").fetchall()


def testGuardarElActivoConservaElTipoDeCambio(tempDb):
    """[A-01] El formulario manda las filas sin fx_*: antes se borraban en cada guardado."""
    from core.db import getDb
    from stores.asset_store import readAssetFile, writeAssetFile

    _activoConCompra()
    conn = getDb()
    conn.execute("UPDATE activo_rows SET fx_rate='0.91', fx_fecha='2024-01-02', fx_origen='manual'")
    conn.commit()

    datos = readAssetFile("fx-prueba")
    for fila in datos["rows"]:  # como llegan del navegador: sin el trío fx
        for clave in ("fxRate", "fxFecha", "fxOrigen"):
            fila.pop(clave, None)
    writeAssetFile("fx-prueba", datos)

    assert [tuple(f) for f in _fxDe(conn)] == [("0.91", "2024-01-02", "manual")]


def testCambiarLaFechaDeLaCompraDejaElTipoPendiente(tempDb):
    """El tipo depende de la fecha: con otra fecha ya no vale y debe volver a pedirse."""
    from core.db import getDb
    from stores.asset_store import readAssetFile, writeAssetFile

    _activoConCompra()
    conn = getDb()
    conn.execute("UPDATE activo_rows SET fx_rate='0.91', fx_fecha='2024-01-02', fx_origen='manual'")
    conn.commit()

    datos = readAssetFile("fx-prueba")
    datos["rows"][0] = {**datos["rows"][0], "fechaOperacion": "05-03-2024", "fxRate": ""}
    writeAssetFile("fx-prueba", datos)

    assert [tuple(f) for f in _fxDe(conn)] == [("", "", "")]


def testGetOperacionesNoTocaLasComprasNiEscribeSiNoHayCambios(tempDb):
    """[A-01][M-07] El GET reescribía todos los activos y borraba su tipo de cambio."""
    from core.db import getDb
    from stores.helpers import syncCompletedOperationsIntoAssets

    _activoConCompra()
    conn = getDb()
    conn.execute("UPDATE activo_rows SET fx_rate='0.91', fx_fecha='2024-01-02', fx_origen='manual'")
    conn.commit()
    idAntes = conn.execute("SELECT id FROM activo_rows").fetchone()[0]

    operaciones = [{"id": "op-1", "assetId": "fx-prueba", "estado": "Completado", "orden": "Compra",
                    "fechaApertura": "03-01-2024", "cantidad": "1", "total": "100", "currency": "USD"}]
    syncCompletedOperationsIntoAssets(operaciones)
    cambios = conn.total_changes
    syncCompletedOperationsIntoAssets(operaciones)  # lo que hace cada GET

    assert conn.total_changes == cambios, "un GET sin cambios no debe escribir"
    assert conn.execute("SELECT id FROM activo_rows").fetchone()[0] == idAntes
    assert [tuple(f) for f in _fxDe(conn)] == [("0.91", "2024-01-02", "manual")]
    assert conn.execute("SELECT COUNT(*) FROM activo_operation_rows").fetchone()[0] == 1


def testGuardarElEjercicioDeVentasConservaSuTipoDeCambio(tempDb):
    """[A-01] El mismo fallo, en las ventas fiscales."""
    from core.db import getDb
    from stores.ventas_store import writeVentasYear

    _activoConCompra()
    venta = {"id": "venta-1", "fecha": "10-01-2026", "assetId": "fx-prueba", "cantidad": "1", "valorVenta": "100"}
    writeVentasYear("2026", {"rows": [venta]})
    conn = getDb()
    conn.execute("UPDATE ventas SET fx_rate='0.95', fx_fecha='2026-01-10', fx_origen='yahoo'")
    conn.commit()

    writeVentasYear("2026", {"rows": [venta]})

    assert conn.execute("SELECT fx_rate FROM ventas").fetchone()[0] == "0.95"


# ── [A-02] Guardar un año con una copia antigua ya no borra lo que entró ──────

@pytest.fixture
def clienteGastos(tempDb, clienteAutenticado):
    from routes.gastos import gastosBp
    from routes.ingresos import ingresosBp

    client, cabeceras, _app = clienteAutenticado(gastosBp, ingresosBp)
    client.post("/api/gastos", json={"year": "2026"}, headers=cabeceras)
    return client, cabeceras


def testUnGuardadoConUnaCopiaAntiguaRecibe409(clienteGastos):
    from stores.movimientos_store import crearMovimiento, sanitizarMovimiento

    client, cabeceras = clienteGastos
    copia = client.get("/api/gastos/2026").get_json()

    # Entra un gasto por otro camino (el Atajo) mientras la pestaña tiene su copia.
    crearMovimiento(sanitizarMovimiento({"tipo": "gasto", "nombre": "Desde el iPhone", "importe": 3,
                                         "fecha": "2026-10-02"}))

    respuesta = client.post("/api/gastos/2026", json=copia, headers=cabeceras)

    assert respuesta.status_code == 409
    assert respuesta.get_json()["conflicto"] is True
    filas = client.get("/api/gastos/2026").get_json()["months"]["octubre"]["rows"]
    assert [f["nombre"] for f in filas] == ["Desde el iPhone"]


def testGuardadosConsecutivosConLaRevisionDevueltaEntran(clienteGastos):
    client, cabeceras = clienteGastos
    datos = client.get("/api/gastos/2026").get_json()

    primera = client.post("/api/gastos/2026", json=datos, headers=cabeceras).get_json()
    datos["revision"] = primera["revision"]
    segunda = client.post("/api/gastos/2026", json=datos, headers=cabeceras)

    assert segunda.status_code == 200
    assert segunda.get_json()["revision"] == primera["revision"] + 1


def testSinRevisionSeGuardaComoSiempre(clienteGastos):
    """Scripts e importaciones que no la mandan siguen funcionando."""
    client, cabeceras = clienteGastos
    datos = client.get("/api/gastos/2026").get_json()
    datos.pop("revision")

    assert client.post("/api/gastos/2026", json=datos, headers=cabeceras).status_code == 200


def testIngresosTambienDetectaLaCopiaAntigua(clienteGastos):
    from stores.movimientos_store import crearMovimiento, sanitizarMovimiento

    client, cabeceras = clienteGastos
    client.post("/api/ingresos", json={"year": "2026"}, headers=cabeceras)
    copia = client.get("/api/ingresos/2026").get_json()
    crearMovimiento(sanitizarMovimiento({"tipo": "ingreso", "nombre": "Bizum", "importe": 5, "fecha": "2026-10-02"}))

    assert client.post("/api/ingresos/2026", json=copia, headers=cabeceras).status_code == 409


def testRenombrarUnaCategoriaInvalidaLasCopiasAbiertas(clienteGastos):
    """Si no, la pestaña abierta desharía el renombrado al guardar."""
    from stores import categorias_store, revisiones

    client, cabeceras = clienteGastos
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
def testListasConBasuraNoDan500(clienteGastos, ruta, cuerpo):
    client, cabeceras = clienteGastos
    assert client.post(ruta, json=cuerpo, headers=cabeceras).status_code < 500


@pytest.fixture
def clienteRegistros(tempDb, clienteAutenticado):
    from routes.registros import registrosBp
    from routes.trading import tradingBp

    client, cabeceras, _app = clienteAutenticado(registrosBp, tradingBp)
    return client, cabeceras


def testInteresesConUnaCuentaQueNoEsObjetoDa400(clienteRegistros):
    client, cabeceras = clienteRegistros
    assert client.post("/api/intereses", json={"cuentas": [1]}, headers=cabeceras).status_code == 400
    assert client.post("/api/intereses", json={"cuentas": [{"rows": [1]}]}, headers=cabeceras).status_code == 400


# ── [M-09] Rutas que no tenían ningún test ────────────────────────────────────

def testInteresesIdaYVuelta(clienteRegistros):
    client, cabeceras = clienteRegistros
    cuentas = [{"id": "c1", "nombre": "Remunerada", "rows": [{"fecha": "01-2026", "acumulado": "10", "impuestos": "1"}]}]

    assert client.post("/api/intereses", json={"cuentas": cuentas}, headers=cabeceras).get_json()["ok"]
    # Sin cuenta de «Cuentas» elegida, `cuenta` vuelve vacío.
    assert client.get("/api/intereses").get_json()["cuentas"] == [{**cuentas[0], "cuenta": ""}]
    assert client.post("/api/intereses/reset", headers=cabeceras).get_json()["ok"]
    assert client.get("/api/intereses").get_json()["cuentas"] == []


def testTradingIdaYVueltaYNormalizaValores(clienteRegistros):
    client, cabeceras = clienteRegistros
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
def testLasRutasDeRegistrosNoDan500ConTiposCambiados(clienteRegistros, ruta):
    client, cabeceras = clienteRegistros
    assert client.get(ruta).status_code == 200
    for cuerpo in ({"rows": [1, "x", None]}, {"rows": "x"}, {"cuentas": "x"}, {"items": [None]}, {}):
        assert client.post(ruta, json=cuerpo, headers=cabeceras).status_code < 500, (ruta, cuerpo)


def testGetOperacionesResponde(tempDb, clienteAutenticado):
    from routes.operaciones import operacionesBp

    client, cabeceras, _app = clienteAutenticado(operacionesBp)
    filas = [{"id": "op-1", "activo": "BTC", "orden": "Compra", "estado": "Activo", "cantidad": "1"}]
    assert client.post("/api/operaciones", json={"rows": filas}, headers=cabeceras).get_json()["ok"]
    assert client.get("/api/operaciones").get_json()["rows"][0]["id"] == "op-1"


# ── [M-02] SECRET_KEY de ejemplo ──────────────────────────────────────────────

@pytest.mark.parametrize("clave", ["cambia_esto_por_una_clave_aleatoria_larga", "CAMBIA_ESTO_tambien", "corta"])
def testUnaSecretKeyInseguraNoArranca(clave):
    from core import seguridad_app

    with pytest.raises(SystemExit):
        seguridad_app.rechazarSecretKeyInsegura(clave)


@pytest.mark.parametrize("clave", ["", "a" * 64])
def testUnaSecretKeyAceptableArranca(clave):
    from core import seguridad_app

    seguridad_app.rechazarSecretKeyInsegura(clave)


def testElEjemploPublicadoEstaEnLaListaNegra():
    texto = (RAIZ / ".env.example").read_text("utf-8")
    ejemplo = re.search(r"^SECRET_KEY=(.*)$", texto, re.M).group(1).strip()
    from core import seguridad_app

    with pytest.raises(SystemExit):
        seguridad_app.rechazarSecretKeyInsegura(ejemplo)


# ── [M-06] La copia previa a una migración es de la base que se migra ─────────

def testLaCopiaPreviaEsDeLaBaseMigrada(tempDb, tmp_path, monkeypatch):
    from admin import backup_manager
    from core import db

    copiadas = []
    monkeypatch.setattr(backup_manager, "backupPrevioAMigracion",
                        lambda ruta, desde, hasta: copiadas.append(Path(ruta).name))
    otra = tmp_path / "otra.db"
    sqlite3.connect(otra).close()

    with db.openDbAt(otra):
        pass

    assert copiadas == ["otra.db"]


# ── [B-11] Cada paso de migración es atómico ──────────────────────────────────

def testUnPasoQueFallaNoDejaNadaAMedias(tmp_path, monkeypatch):
    from core import db

    ruta = tmp_path / "migrar.db"
    conn = sqlite3.connect(ruta)
    conn.executescript(db._SCHEMA)
    conn.execute(f"PRAGMA user_version = {db.ESQUEMA_VERSION}")
    conn.commit()

    def pasoQueFalla(c):
        c.executescript("CREATE TABLE a_medias (x); INSERT INTO a_medias VALUES (1);")
        raise RuntimeError("corte a mitad del paso")

    siguiente = db.ESQUEMA_VERSION + 1
    monkeypatch.setattr(db, "_MIGRACIONES", [*db._MIGRACIONES, (siguiente, pasoQueFalla)])
    monkeypatch.setattr(db, "ESQUEMA_VERSION", siguiente)
    monkeypatch.setattr(db, "_copiaAntesDeMigrar", lambda *a: None)

    with pytest.raises(RuntimeError):
        db._migrate(conn, ruta)

    assert conn.execute("PRAGMA user_version").fetchone()[0] == siguiente - 1
    assert not conn.execute("SELECT 1 FROM sqlite_master WHERE name='a_medias'").fetchone()
    conn.close()


# ── [M-08] Sin manejadores en línea que la CSP bloquea ────────────────────────

def testNingunHtmlLlevaManejadoresEnLinea():
    """La CSP no lleva 'unsafe-inline' en script-src: un onclick="…" no se ejecuta."""
    ficheros = [RAIZ / "index.html", *sorted((RAIZ / "html").rglob("*.html"))]
    culpables = [
        f"{f.relative_to(RAIZ)}: {m.group(0)}"
        for f in ficheros
        for m in re.finditer(r"\son[a-z]+\s*=\s*[\"']", f.read_text("utf-8"))
    ]
    assert culpables == []


# ── [B-06] Nombres del certificado ────────────────────────────────────────────

def testLosNombresDelCertificadoNoAdmitenNadaQueNoSeaUnHost():
    from core import tls

    assert tls.normalizarNombres([
        "casa.lan", "https://Nas.Local:5000/x", "192.168.1.10", "[fd00::1]", "*.casa.lan",
        "malo\n#inyeccion", "con espacio", "a;b", "{x}", "",
    ]) == ["casa.lan", "nas.local", "192.168.1.10", "fd00::1", "*.casa.lan"]


# ── [B-08] Ficheros de ajustes enormes dentro de un ZIP ───────────────────────

def testUnJsonDeAjustesEnormeSeRechaza():
    from core import zip_seguro

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("prefs_principal.json", "[" + "0," * (3 * 1024 * 1024) + "0]")
    with zipfile.ZipFile(buf) as zf, pytest.raises(zip_seguro.ZipNoAdmitido):
        zip_seguro.comprobar(zf)


# ── [B-09] Temporales huérfanos ───────────────────────────────────────────────

def testLaLimpiezaBarreLosTemporalesDeHoy(datosAislados):
    import os

    from core import paths
    from routes import backup

    tmp = paths.TMP_DIR
    tmp.mkdir(parents=True, exist_ok=True)
    viejo = tmp / ".principal.db.123-abc-ff00ff.tmp"
    reciente = tmp / ".principal.db.456-def-00ff00.tmp"
    zipViejo = datosAislados["backups"] / "_tmp_backup_01-01-2026_00-00-00.zip"
    for f in (viejo, reciente, zipViejo):
        f.write_bytes(b"x")
    haceDosHoras = time.time() - 7200
    for f in (viejo, zipViejo):
        os.utime(f, (haceDosHoras, haceDosHoras))

    backup._limpiarTemporalesHuerfanos()

    assert not viejo.exists() and not zipViejo.exists()
    assert reciente.exists()  # puede ser una copia en curso


# ── [B-12] auth.dat ilegible ──────────────────────────────────────────────────

def testUnAuthDatIlegibleSeApartaEnVezDeSobrescribirse(datosAislados, monkeypatch):
    from routes import auth

    monkeypatch.setattr(auth, "_AUTH_FILE", datosAislados["auth"])
    datosAislados["auth"].write_bytes(b"cifrado con otra SECRET_KEY")
    monkeypatch.setenv("LOGIN_USERNAME", "admin")
    monkeypatch.setenv("LOGIN_PASSWORD_HASH", "pbkdf2:sha256:600000$x$y")

    auth._loadCredentials()

    apartados = list(datosAislados["data"].glob("auth.dat.ilegible-*"))
    assert len(apartados) == 1 and apartados[0].read_bytes() == b"cifrado con otra SECRET_KEY"


# ── [B-02] Las peticiones anónimas no gastan el cupo de escrituras ────────────

def testLasPeticionesAnonimasNoAgotanElCupoDelUsuario(tempDb, crearApp, monkeypatch):
    from core import sesion
    from routes.trading import tradingBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "3")
    app = crearApp(tradingBp)
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

def testNoSePuedeCrearNiRenombrarAUnNombreQueYaExiste(datosAislados):
    from admin import portfolios_manager as pm

    datosAislados["meta"].write_text(json.dumps({"active": None, "portfolios": []}), "utf-8")
    pid = pm.createPortfolio("Ahorro")
    otro = pm.createPortfolio("Otro")

    with pytest.raises(pm.NombreDuplicado):
        pm.createPortfolio("ahorro")
    with pytest.raises(pm.NombreDuplicado):
        pm.renamePortfolio(otro, "AHORRO")
    pm.renamePortfolio(pid, "Ahorro")  # renombrarse a sí mismo no choca


# ── [I-04] Un único cálculo de rendimiento ────────────────────────────────────

def testLaListaYLaTablaDanLasMismasCifras(tempDb, clienteAutenticado):
    """Antes eran dos copias del cálculo (float y Decimal) y podían diferir."""
    from routes.activos import activosBp
    from stores.asset_store import listAssets, writeAssetFile

    writeAssetFile("cent", {
        "name": "Céntimos", "type": "acciones", "price": "10,01",
        "rows": [
            {"tipoOperacion": "Compra", "participaciones": "3", "capitalInvertidoBruto": "0,1", "comisiones": "0,01"},
            {"tipoOperacion": "Compra", "participaciones": "7", "capitalInvertidoBruto": "0,2", "comisiones": "0,02"},
            {"tipoOperacion": "Venta", "participaciones": "1,5"},
        ],
    })
    client, _cab, _app = clienteAutenticado(activosBp)

    tabla = client.get("/api/activos/rendimiento-batch").get_json()["cent"]
    lista = next(a for a in listAssets() if a["id"] == "cent")

    for campo in ("rendimiento", "invertidoNeto", "rendimientoPct"):
        assert lista[campo] == tabla[campo], campo
    assert tabla["invertidoNeto"] == 0.22
    assert tabla["netoActual"] == 85.09  # 8,5 participaciones por 10,01


def testElImporteDelAtajoAdmiteSeparadorDeMiles():
    from decimal import Decimal

    from stores.movimientos_store import formatearImporteEuro, normalizarImporte

    assert normalizarImporte("1.234,50 €") == Decimal("1234.50")
    assert normalizarImporte(12.345) == Decimal("12.35")  # redondeo comercial, no bancario
    assert formatearImporteEuro(Decimal("1234.5")) == "1.234,50 €"
