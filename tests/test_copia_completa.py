"""Una copia lleva todos los datos de cada perfil y restaurarla los deja como estaban.

También cubre el aislamiento entre perfiles al importar y al borrar: lo que
importa aquí es que nada de un perfil acabe en otro. Ningún caso toca `data/`.
"""

import io
import json
import sqlite3
import zipfile

import pytest
from werkzeug.security import generate_password_hash

from stores import seguimiento_prefs
from tests.test_backup_http import _crearDb

_LISTA = [{"_segId": "c1", "nombre": "Prueba", "ticker": "PRB", "price": "1,5"}]


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    """Copias, ajustes y portfolios, con los límites de escritura abiertos."""
    from routes.ajustes import ajustesBp
    from routes.backup import backupBp
    from routes.portfolios import portfoliosBp

    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(backupBp, ajustesBp, portfoliosBp)
    return client, cabeceras, datosAislados, tempDb.stem


@pytest.fixture
def conContrasena(cliente, monkeypatch):
    """Instalación con contraseña de acceso, que es lo que cifra las wallets."""
    from routes import auth

    rutas = cliente[2]
    monkeypatch.setattr(auth, "_AUTH_FILE", rutas["auth"])
    auth._saveCredentials("admin", generate_password_hash("la-de-la-web", method="pbkdf2:sha256:1000"))
    return cliente


def _dosPerfiles(rutas) -> None:
    _crearDb(rutas["portfolios"] / "uno.db", [("2026-01-01", 100.0, 90.0), ("2026-01-02", 110.0, 90.0)])
    _crearDb(rutas["portfolios"] / "dos.db", [("2026-02-01", 50.0, 40.0)])
    rutas["meta"].write_text(json.dumps({
        "active": "uno",
        "portfolios": [{"id": "uno", "name": "Uno"}, {"id": "dos", "name": "Dos"}],
    }), encoding="utf-8")


def _prefs(rutas, pid: str, **valores) -> None:
    (rutas["json"] / f"prefs_{pid}.json").write_text(json.dumps(valores), encoding="utf-8")


def _leerPrefs(rutas, pid: str) -> dict:
    return json.loads((rutas["json"] / f"prefs_{pid}.json").read_text("utf-8"))


def _copiar(client, cabeceras) -> str:
    respuesta = client.post("/api/backup", headers=cabeceras)
    assert respuesta.status_code == 200
    return respuesta.get_json()["filename"]


def _restaurar(client, cabeceras, nombre: str) -> dict:
    respuesta = client.post("/api/restore", json={"filename": nombre}, headers=cabeceras)
    assert respuesta.status_code == 200, respuesta.get_data(as_text=True)
    return respuesta.get_json()


def _filas(ruta) -> int:
    with sqlite3.connect(str(ruta)) as conn:
        return conn.execute("SELECT COUNT(*) FROM portfolio_snapshots").fetchone()[0]


# ── Copia y restauración ─────────────────────────────────────────────────────

def testCadaPerfilRecuperaSusDatosYSuConfiguracion(cliente):
    client, cabeceras, rutas, _activo = cliente
    _dosPerfiles(rutas)
    _prefs(rutas, "uno", topMetricsConfig={"topStaking": True}, seguimientoLista=_LISTA)
    _prefs(rutas, "dos", topMetricsConfig={"topStaking": False}, seguimientoOcultos=["portfolio_x"])
    nombre = _copiar(client, cabeceras)

    _crearDb(rutas["portfolios"] / "uno.db", [("2026-03-01", 1.0, 1.0)])
    _prefs(rutas, "uno", topMetricsConfig={}, seguimientoLista=[])
    _prefs(rutas, "dos", topMetricsConfig={})

    assert _restaurar(client, cabeceras, nombre)["ignorados"] == []
    assert _filas(rutas["portfolios"] / "uno.db") == 2
    assert _filas(rutas["portfolios"] / "dos.db") == 1
    uno, dos = _leerPrefs(rutas, "uno"), _leerPrefs(rutas, "dos")
    assert uno["topMetricsConfig"] == {"topStaking": True} and uno["seguimientoLista"] == _LISTA
    assert dos["topMetricsConfig"] == {"topStaking": False} and dos["seguimientoOcultos"] == ["portfolio_x"]
    assert "seguimientoLista" not in dos


def testPreferenciasPosterioresALaCopiaSeRetiran(cliente):
    """Si el perfil no tenía preferencias al copiar, no conserva las de después."""
    client, cabeceras, rutas, _activo = cliente
    _dosPerfiles(rutas)
    nombre = _copiar(client, cabeceras)
    _prefs(rutas, "uno", topMetricsConfig={"topStaking": True})

    assert _restaurar(client, cabeceras, nombre)["ignorados"] == []
    assert not (rutas["json"] / "prefs_uno.json").exists()
    assert list((rutas["data"] / "deleted").glob("prefs_uno_*.json")), "debe poder recuperarse"


def testPerfilQueNoEstabaEnLaCopiaSeArchivaSinPerderlo(cliente):
    client, cabeceras, rutas, _activo = cliente
    _dosPerfiles(rutas)
    nombre = _copiar(client, cabeceras)
    _crearDb(rutas["portfolios"] / "nuevo.db", [("2026-04-01", 5.0, 5.0)])
    _prefs(rutas, "nuevo", hiddenAssets=["a"])

    assert _restaurar(client, cabeceras, nombre)["ignorados"] == []
    assert not (rutas["portfolios"] / "nuevo.db").exists()
    archivados = list((rutas["data"] / "deleted").glob("nuevo_*.db"))
    assert len(archivados) == 1 and _filas(archivados[0]) == 1
    assert list((rutas["data"] / "deleted").glob("prefs_nuevo_*.json"))


def testUnZipSinManifestNoRetiraNada(cliente):
    """Un ZIP hecho a mano puede traer solo una parte: no autoriza a retirar lo demás."""
    client, cabeceras, rutas, _activo = cliente
    _dosPerfiles(rutas)
    origen = _crearDb(rutas["data"] / "origen.db", [("2026-05-01", 1.0, 1.0)])
    nombre = "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(rutas["backups"] / nombre, "w") as zf:
        zf.write(origen, "portfolios/uno.db")
        zf.writestr("portfolios.json", json.dumps({
            "active": "uno", "portfolios": [{"id": "uno", "name": "Uno"}, {"id": "dos", "name": "Dos"}],
        }))
    _prefs(rutas, "dos", hiddenAssets=["a"])

    assert _restaurar(client, cabeceras, nombre)["ignorados"] == []
    assert (rutas["portfolios"] / "dos.db").exists()
    assert (rutas["json"] / "prefs_dos.json").exists()


def testPerfilDelIndiceSinBaseSeAvisa(cliente):
    client, cabeceras, rutas, _activo = cliente
    origen = _crearDb(rutas["data"] / "origen.db", [("2026-05-01", 1.0, 1.0)])
    nombre = "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(rutas["backups"] / nombre, "w") as zf:
        zf.write(origen, "portfolios/uno.db")
        zf.writestr("manifest.json", json.dumps({"version": 2}))
        zf.writestr("portfolios.json", json.dumps({
            "active": "uno", "portfolios": [{"id": "uno", "name": "Uno"}, {"id": "perdido", "name": "Perdido"}],
        }))

    ignorados = _restaurar(client, cabeceras, nombre)["ignorados"]
    assert len(ignorados) == 1 and "perdido" in ignorados[0]


def testUnaBaseQueNoCoincideConLaCopiaNoSeDaPorBuena(cliente, monkeypatch):
    """Simula una copia que se queda a medias sin lanzar ningún error."""
    from routes import backup

    client, cabeceras, rutas, _activo = cliente
    _dosPerfiles(rutas)
    nombre = _copiar(client, cabeceras)

    monkeypatch.setattr(backup, "_reemplazarAtomicoViaSqlite", lambda _origen, destino: _crearDb(destino))
    with sqlite3.connect(str(rutas["portfolios"] / "dos.db")) as conn:
        conn.execute("DELETE FROM portfolio_snapshots")

    ignorados = _restaurar(client, cabeceras, nombre)["ignorados"]
    assert any("portfolios/dos.db" in e and "no coincide" in e and "portfolio_snapshots" in e for e in ignorados)


# ── Wallets ──────────────────────────────────────────────────────────────────

_WALLETS = {"walletsSeguimiento": {"wallets": {"wallets": [{"valor": "DIRECCION-SECRETA"}]}}}


def testLasWalletsEntranCifradasAunqueLaOpcionDeClavesEsteApagada(conContrasena, monkeypatch):
    from core import exportables, wallets_copia

    client, cabeceras, rutas, _activo = conContrasena
    _dosPerfiles(rutas)
    monkeypatch.setattr(exportables, "soloWallets", lambda: _WALLETS)
    restauradas = []
    monkeypatch.setattr(wallets_copia, "restaurar", lambda partes: restauradas.append(partes) or ["wallets.key"])

    respuesta = client.post("/api/backup", headers=cabeceras).get_json()
    assert respuesta["aviso"] is None
    ruta = rutas["backups"] / respuesta["filename"]
    with zipfile.ZipFile(ruta) as zf:
        assert exportables.FICHERO_CLAVES_CIFRADAS in zf.namelist()
        assert all(b"DIRECCION-SECRETA" not in zf.read(n) for n in zf.namelist())
        assert json.loads(zf.read("manifest.json"))["walletsFuera"] is False

    assert _restaurar(client, cabeceras, respuesta["filename"])["claves"] == ["wallets.key"]
    assert restauradas == [_WALLETS["walletsSeguimiento"]]


def testSinContrasenaLaCopiaSaleSinWalletsYLoDice(cliente, monkeypatch):
    from core import exportables
    from routes import auth

    client, cabeceras, rutas, _activo = cliente
    _dosPerfiles(rutas)
    monkeypatch.setattr(exportables, "soloWallets", lambda: _WALLETS)
    monkeypatch.setattr(auth, "_loadCredentials", lambda: ("__no_user__", ""))

    respuesta = client.post("/api/backup", headers=cabeceras).get_json()
    assert "wallets" in respuesta["aviso"]
    with zipfile.ZipFile(rutas["backups"] / respuesta["filename"]) as zf:
        assert exportables.FICHERO_CLAVES_CIFRADAS not in zf.namelist()
        assert all(b"DIRECCION-SECRETA" not in zf.read(n) for n in zf.namelist())
        assert json.loads(zf.read("manifest.json"))["walletsFuera"] is True


# ── Importar un ZIP de export ────────────────────────────────────────────────

def _zipExport(prefs: dict | None = None, ui: dict | None = None, base=None) -> io.BytesIO:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("ajustes.json", "{}")
        if base is not None:
            zf.write(base, "portfolio-2026-11-05.db")
        for nombre, contenido in (prefs or {}).items():
            zf.writestr(nombre, json.dumps(contenido))
        if ui is not None:
            zf.writestr("ui.json", json.dumps(ui))
    buf.seek(0)
    return buf


def _importar(client, cabeceras, buf) -> dict:
    respuesta = client.post(
        "/api/import/zip", data={"file": (buf, "export.zip")}, headers=cabeceras,
        content_type="multipart/form-data",
    )
    assert respuesta.status_code == 200, respuesta.get_data(as_text=True)
    return respuesta.get_json()


def testImportarAplicaLasPrefsAlPerfilActivoSinTocarElDeOrigen(cliente):
    client, cabeceras, rutas, activo = cliente
    _prefs(rutas, "otro", topMetricsConfig={"topInvertido": True})

    _importar(client, cabeceras, _zipExport({"prefs_otro.json": {"topMetricsConfig": {"topStaking": True}}}))

    assert _leerPrefs(rutas, activo)["topMetricsConfig"] == {"topStaking": True}
    assert _leerPrefs(rutas, "otro")["topMetricsConfig"] == {"topInvertido": True}


def testUnPrefsConRutaDeEscapeSeIgnoraYElBuenoVaAlActivo(cliente, tmp_path):
    client, cabeceras, rutas, activo = cliente
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("prefs_..\\..\\robado.json", b'{"x": 1}')
        zf.writestr("prefs_principal.json", b'{"hiddenAssets": ["9"]}')
    buf.seek(0)

    _importar(client, cabeceras, buf)

    assert not (rutas["data"] / "robado.json").exists() and not (tmp_path / "robado.json").exists()
    assert _leerPrefs(rutas, activo)["hiddenAssets"] == ["9"]
    assert not (rutas["json"] / "prefs_principal.json").exists()


def testImportarZipAntiguoTraeSoloElSeguimientoDelPerfilExportado(cliente):
    """Los ZIP antiguos volcaban el `localStorage` entero, con las listas de todos."""
    client, cabeceras, rutas, activo = cliente
    ui = {
        "seguimientoList_origen": json.dumps(_LISTA),
        "seguimientoHidden_origen": json.dumps(["portfolio_a"]),
        "seguimientoList_ajeno": json.dumps([{"_segId": "ajeno", "nombre": "Ajeno"}]),
        "portfolioTheme": "black",
    }

    datos = _importar(client, cabeceras, _zipExport({"prefs_origen.json": {"hiddenAssets": []}}, ui))

    prefs = _leerPrefs(rutas, activo)
    assert prefs["seguimientoLista"] == _LISTA and prefs["seguimientoOcultos"] == ["portfolio_a"]
    assert datos["ui"] == {"portfolioTheme": "black"}


def testImportarBaseSinPrefsNoDejaLaConfiguracionAnterior(cliente):
    client, cabeceras, rutas, activo = cliente
    from core.db import getActiveDbPath, invalidateAllConnections

    origen = rutas["data"] / "origen.db"
    with sqlite3.connect(str(getActiveDbPath())) as conn, sqlite3.connect(str(origen)) as destino:
        conn.backup(destino)
    invalidateAllConnections()
    _prefs(rutas, activo, hiddenAssets=["viejo"])

    _importar(client, cabeceras, _zipExport(base=origen))

    assert not (rutas["json"] / f"prefs_{activo}.json").exists()


def testImportarComoPerfilNuevoSeLlevaSuConfiguracion(cliente):
    client, cabeceras, rutas, _activo = cliente
    from core.db import getActiveDbPath

    # Con la API de backup y antes de crear los perfiles mínimos: es la base que
    # tiene el esquema real, y parte de él aún está en el WAL.
    baseReal = rutas["data"] / "origen.db"
    with sqlite3.connect(str(getActiveDbPath())) as conn, sqlite3.connect(str(baseReal)) as destino:
        conn.backup(destino)
    _dosPerfiles(rutas)
    buf = _zipExport(
        {"prefs_origen.json": {"topMetricsConfig": {"topStaking": True}}},
        {"seguimientoList_origen": json.dumps(_LISTA)},
        base=baseReal,
    )
    respuesta = client.post(
        "/api/portfolios/import", data={"name": "Importada", "file": (buf, "export.zip")},
        headers=cabeceras, content_type="multipart/form-data",
    )
    assert respuesta.status_code == 200, respuesta.get_data(as_text=True)
    prefs = _leerPrefs(rutas, respuesta.get_json()["id"])
    assert prefs["topMetricsConfig"] == {"topStaking": True} and prefs["seguimientoLista"] == _LISTA


def testExportarNoLlevaElSeguimientoDeOtrosPerfiles(cliente):
    client, cabeceras, _rutas, _activo = cliente
    respuesta = client.post("/api/export/zip", headers=cabeceras, json={
        "ui": {"seguimientoList_ajeno": json.dumps(_LISTA), "portfolioTheme": "black"},
    })
    assert respuesta.status_code == 200
    with zipfile.ZipFile(io.BytesIO(respuesta.data)) as zf:
        assert json.loads(zf.read("ui.json")) == {"portfolioTheme": "black"}


# ── Borrar un perfil ─────────────────────────────────────────────────────────

def testUnPerfilNuevoNoHeredaLaConfiguracionDelBorrado(cliente):
    from admin import portfolios_manager

    client, cabeceras, rutas, _activo = cliente
    _dosPerfiles(rutas)
    _prefs(rutas, "dos", hiddenAssets=["secreto"])

    assert client.delete("/api/portfolios/dos", headers=cabeceras).status_code == 200

    assert not (rutas["json"] / "prefs_dos.json").exists()
    assert list((rutas["data"] / "deleted").glob("prefs_dos_*.json"))
    assert portfolios_manager.createPortfolio("Dos") == "dos"
    assert not (rutas["json"] / "prefs_dos.json").exists()


# ── Seguimiento en las preferencias del perfil ───────────────────────────────

def testElSeguimientoSeGuardaEnElPerfilConSusObjetos(cliente):
    client, cabeceras, rutas, activo = cliente
    assert client.post("/api/settings", json={
        "seguimientoLista": _LISTA,
        "seguimientoOcultos": ["portfolio_a"],
        "seguimientoOverrides": {"portfolio_a": {"tvSymbol": "X"}},
    }, headers=cabeceras).status_code == 200

    datos = client.get("/api/settings").get_json()
    assert datos["portfolioId"] == activo
    assert datos["seguimientoLista"] == _LISTA
    assert datos["seguimientoOcultos"] == ["portfolio_a"]
    assert datos["seguimientoOverrides"] == {"portfolio_a": {"tvSymbol": "X"}}
    assert _leerPrefs(rutas, activo)["seguimientoLista"] == _LISTA


def testUnValorDeOtroTipoNoBorraLaLista(cliente):
    client, cabeceras, _rutas, _activo = cliente
    client.post("/api/settings", json={"seguimientoLista": _LISTA}, headers=cabeceras)
    client.post("/api/settings", json={"seguimientoLista": "basura"}, headers=cabeceras)
    assert client.get("/api/settings").get_json()["seguimientoLista"] == _LISTA


def testMigrarSeparaPorPerfilYSaltaLosQueNoExisten(cliente):
    client, cabeceras, rutas, _activo = cliente
    _dosPerfiles(rutas)
    _prefs(rutas, "dos", seguimientoOcultos=["ya"])

    respuesta = client.post("/api/settings/seguimiento/migrar", json={"portfolios": {
        "uno": {"seguimientoLista": _LISTA},
        "dos": {"seguimientoOcultos": ["nuevo"]},
        "borrado": {"seguimientoLista": _LISTA},
    }}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert sorted(respuesta.get_json()["migrados"]) == ["dos", "uno"]
    assert _leerPrefs(rutas, "uno")["seguimientoLista"] == _LISTA
    assert _leerPrefs(rutas, "dos")["seguimientoOcultos"] == ["ya", "nuevo"]
    assert _leerPrefs(rutas, "dos")["seguimientoLista"] == []
    assert not (rutas["json"] / "prefs_borrado.json").exists()


def testMigrarRechazaUnCuerpoIncorrecto(cliente):
    client, cabeceras, _rutas, _activo = cliente
    respuesta = client.post("/api/settings/seguimiento/migrar", json={"portfolios": ["x"]}, headers=cabeceras)
    assert respuesta.status_code == 400


# ── Escritura con un lector bloqueando (Windows) ─────────────────────────────

def testEnWindowsSeReintentaSiElDestinoEstaOcupado(tmp_path, monkeypatch):
    from core import escritura

    reemplazar = escritura.os.replace
    intentos = []

    def ocupadoLaPrimeraVez(origen, destino):
        intentos.append(destino)
        if len(intentos) == 1:
            raise PermissionError("en uso")
        reemplazar(origen, destino)

    monkeypatch.setattr(escritura.os, "name", "nt")
    monkeypatch.setattr(escritura.os, "replace", ocupadoLaPrimeraVez)
    monkeypatch.setattr(escritura, "_ESPERA_SUSTITUIR_SEGUNDOS", 0)
    escritura._sustituir(_temporal(tmp_path), tmp_path / "destino.json")
    assert len(intentos) == 2 and (tmp_path / "destino.json").read_text() == "x"


def testUnErrorDePermisosDeVerdadTerminaSaliendo(tmp_path, monkeypatch):
    from core import escritura

    def siempreOcupado(_origen, _destino):
        raise PermissionError("sin permiso")

    monkeypatch.setattr(escritura.os, "name", "nt")
    monkeypatch.setattr(escritura.os, "replace", siempreOcupado)
    monkeypatch.setattr(escritura, "_ESPERA_SUSTITUIR_SEGUNDOS", 0)
    with pytest.raises(PermissionError):
        escritura._sustituir(_temporal(tmp_path), tmp_path / "destino.json")


def _temporal(carpeta):
    ruta = carpeta / "temporal"
    ruta.write_text("x")
    return ruta


# ── stores.seguimiento_prefs ─────────────────────────────────────────────────

@pytest.mark.parametrize("valor", [None, "x", 3, {"a": 1}])
def testNormalizarListaConOtrosTiposDaVacio(valor):
    assert seguimiento_prefs.normalizarLista(valor) == []


def testNormalizarListaQuitaRepetidosSinIdentidadYAnidados():
    lista = seguimiento_prefs.normalizarLista([
        {"_segId": "a", "nombre": "A", "anidado": {"x": 1}, "largo": "z" * 6000},
        {"_segId": "a", "nombre": "Repetido"},
        {"ticker": "SIN-IDENTIDAD"},
        {"nombre": "Antigua"},
        "no es un objeto",
    ])
    assert lista == [{"_segId": "a", "nombre": "A"}, {"nombre": "Antigua"}]


def testNormalizarListaRespetaElTope():
    enorme = [{"_segId": str(i)} for i in range(seguimiento_prefs.MAX_ELEMENTOS + 5)]
    assert len(seguimiento_prefs.normalizarLista(enorme)) == seguimiento_prefs.MAX_ELEMENTOS


def testFusionarDaPrioridadALoQueYaEstaGuardado():
    fusion = seguimiento_prefs.fusionar(
        {"hiddenAssets": ["h"], "seguimientoLista": [{"_segId": "a", "nombre": "Guardada"}],
         "seguimientoOverrides": {"x": {"tvSymbol": "GUARDADO"}}},
        {"seguimientoLista": [{"_segId": "a", "nombre": "Vieja"}, {"_segId": "b", "nombre": "Nueva"}],
         "seguimientoOverrides": {"x": {"tvSymbol": "VIEJO"}, "y": {"tvSymbol": "Y"}}},
    )
    assert fusion["hiddenAssets"] == ["h"]
    assert [e["nombre"] for e in fusion["seguimientoLista"]] == ["Guardada", "Nueva"]
    assert fusion["seguimientoOverrides"] == {"x": {"tvSymbol": "GUARDADO"}, "y": {"tvSymbol": "Y"}}


def testSepararDeUiNoAdivinaSiHayVariosPerfiles(caplog):
    ui = {"seguimientoList_a": "[]", "seguimientoList_b": "[]", "tema": "x"}
    datos, resto = seguimiento_prefs.separarDeUi(ui, None)
    assert datos is None and resto == {"tema": "x"}
    assert "varios portfolios" in caplog.text


def testSepararDeUiIgnoraJsonRoto():
    datos, resto = seguimiento_prefs.separarDeUi({"seguimientoList_a": "{roto"}, "a")
    assert datos is None and resto == {}
