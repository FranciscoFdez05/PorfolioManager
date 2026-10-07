"""Claves de API dentro de las copias y envío de la copia automática a Telegram.

Lo que se comprueba, sobre todo, es lo que no debe pasar: que una clave salga en
claro en un ZIP, o que restaurar con la contraseña equivocada toque algo.
"""

import io
import json
import zipfile

import pytest
from werkzeug.security import generate_password_hash

from tests import test_backup_http
from tests.test_backup_http import _crear_db

# La fixture se reutiliza asignándola, no importándola por nombre: un import
# que luego reaparece como parámetro de los tests es un F811 para ruff.
cliente = test_backup_http.cliente


def _poner_contrasena(monkeypatch, rutas, contrasena="la-clave-de-la-web"):
    from routes import auth

    monkeypatch.setattr(auth, "_AUTH_FILE", rutas["auth"])
    auth._save_credentials("admin", generate_password_hash(contrasena, method="pbkdf2:sha256:1000"))


@pytest.fixture
def con_claves(cliente, monkeypatch):
    from core import paths

    client, cabeceras, rutas = cliente
    monkeypatch.setattr(paths, "API_DIR", rutas["claves"])
    _poner_contrasena(monkeypatch, rutas)
    _crear_db(rutas["portfolios"] / "principal.db", [("2026-01-01", 100.0, 90.0)])
    rutas["meta"].write_text(json.dumps({"active": "principal"}), encoding="utf-8")
    from core.secret_store import write_secret_lines

    write_secret_lines(rutas["claves"] / "finnhub.key", ["CLAVE-SECRETA-FINNHUB"])
    return client, cabeceras, rutas


def _ajustes(rutas, **valores):
    rutas["ajustes"].write_text(json.dumps(valores), encoding="utf-8")


def test_sin_la_opcion_la_copia_no_lleva_claves(con_claves):
    client, cabeceras, rutas = con_claves
    nombre = client.post("/api/backup", headers=cabeceras).get_json()["filename"]
    with zipfile.ZipFile(rutas["backups"] / nombre) as zf:
        assert "claves-api.cifradas.json" not in zf.namelist()


def test_con_la_opcion_las_claves_van_cifradas_y_nunca_en_claro(con_claves):
    client, cabeceras, rutas = con_claves
    _ajustes(rutas, backupIncluirClaves=True)
    nombre = client.post("/api/backup", headers=cabeceras).get_json()["filename"]
    ruta = rutas["backups"] / nombre
    with zipfile.ZipFile(ruta) as zf:
        assert "claves-api.cifradas.json" in zf.namelist()
        assert json.loads(zf.read("manifest.json"))["claves"] is True
    assert b"CLAVE-SECRETA-FINNHUB" not in ruta.read_bytes()
    # ni siquiera dentro de entradas comprimidas
    with zipfile.ZipFile(ruta) as zf:
        assert all(b"CLAVE-SECRETA-FINNHUB" not in zf.read(n) for n in zf.namelist())


def test_restaurar_con_la_misma_contrasena_recupera_las_claves_sin_preguntar(con_claves):
    client, cabeceras, rutas = con_claves
    _ajustes(rutas, backupIncluirClaves=True)
    nombre = client.post("/api/backup", headers=cabeceras).get_json()["filename"]
    (rutas["claves"] / "finnhub.key").unlink()

    r = client.post("/api/restore", json={"filename": nombre}, headers=cabeceras)
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["claves"] == ["finnhub.key"]
    from core.secret_store import read_secret_lines

    assert read_secret_lines(rutas["claves"] / "finnhub.key") == ["CLAVE-SECRETA-FINNHUB"]


def test_si_la_contrasena_cambio_se_pide_la_de_entonces_y_no_se_toca_nada(con_claves, monkeypatch):
    client, cabeceras, rutas = con_claves
    _ajustes(rutas, backupIncluirClaves=True)
    nombre = client.post("/api/backup", headers=cabeceras).get_json()["filename"]
    _poner_contrasena(monkeypatch, rutas, "otra-contrasena-nueva")
    (rutas["claves"] / "finnhub.key").unlink()
    antes = (rutas["portfolios"] / "principal.db").read_bytes()

    r = client.post("/api/restore", json={"filename": nombre}, headers=cabeceras)
    assert r.status_code == 400 and r.get_json()["necesitaContrasena"] is True

    r = client.post("/api/restore", json={"filename": nombre, "contrasena": "mal"}, headers=cabeceras)
    assert r.status_code == 400 and r.get_json()["error"] == "Contraseña incorrecta"
    assert (rutas["portfolios"] / "principal.db").read_bytes() == antes
    assert not (rutas["claves"] / "finnhub.key").exists()

    r = client.post("/api/restore", json={"filename": nombre, "contrasena": "la-clave-de-la-web"}, headers=cabeceras)
    assert r.status_code == 200 and r.get_json()["claves"] == ["finnhub.key"]


def test_restaurar_sin_las_claves_funciona_aunque_no_se_sepa_la_contrasena(con_claves, monkeypatch):
    client, cabeceras, rutas = con_claves
    _ajustes(rutas, backupIncluirClaves=True)
    nombre = client.post("/api/backup", headers=cabeceras).get_json()["filename"]
    _poner_contrasena(monkeypatch, rutas, "otra-contrasena-nueva")

    r = client.post("/api/restore", json={"filename": nombre, "sinClaves": True}, headers=cabeceras)
    assert r.status_code == 200 and r.get_json()["claves"] == []


def test_importar_zip_de_una_copia_con_claves_tambien_pide_contrasena(con_claves, monkeypatch):
    from routes.ajustes import ajustes_bp

    client, cabeceras, rutas = con_claves
    client.application.register_blueprint(ajustes_bp)
    _ajustes(rutas, backupIncluirClaves=True)
    nombre = client.post("/api/backup", headers=cabeceras).get_json()["filename"]
    contenido = (rutas["backups"] / nombre).read_bytes()
    _poner_contrasena(monkeypatch, rutas, "otra-contrasena-nueva")

    r = client.post("/api/import/zip", data={"file": (io.BytesIO(contenido), "b.zip")},
                    headers=cabeceras, content_type="multipart/form-data")
    assert r.status_code == 400 and r.get_json()["necesitaContrasena"] is True

    r = client.post("/api/import/zip",
                    data={"file": (io.BytesIO(contenido), "b.zip"), "contrasena": "la-clave-de-la-web"},
                    headers=cabeceras, content_type="multipart/form-data")
    assert r.status_code == 200 and r.get_json()["claves"] == ["finnhub.key"]


def test_un_metodo_de_hash_abusivo_en_el_zip_se_rechaza():
    from core import exportables

    paquete = {"formato": exportables.FORMATO_CLAVES_APP, "metodo": "pbkdf2:sha256:999999999",
               "salt": "x", "datos": "abc"}
    with pytest.raises(exportables.ContrasenaIncorrecta):
        exportables.descifrarClavesConHashApp(paquete, contrasena="x")


def test_el_resumen_que_se_recalcula_es_el_que_guarda_werkzeug():
    """Si una versión de werkzeug cambiase `_hash_internal`, la restauración dejaría
    de abrir las copias antiguas: este test lo hace saltar en la actualización."""
    from core import exportables

    hash_app = generate_password_hash("abc", method="pbkdf2:sha256:1000")
    paquete = exportables.cifrarClavesConHashApp({"finnhub": ["k"]}, hash_app)
    assert exportables.descifrarClavesConHashApp(paquete, contrasena="abc") == {"finnhub": ["k"]}
    assert exportables.descifrarClavesConHashApp(paquete, hash_app=hash_app) == {"finnhub": ["k"]}


# ── Telegram ─────────────────────────────────────────────────────────────────

def test_la_copia_automatica_se_envia_como_fichero_a_telegram(con_claves, monkeypatch):
    from core import telegram_notifier
    from routes import backup

    _ajustes(con_claves[2], telegramAvisos={"backupFichero": True})
    telegram_notifier.reiniciar_para_pruebas()
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")
    enviados, textos = [], []
    monkeypatch.setattr(telegram_notifier, "_enviar_documento",
                        lambda token, chat, ruta, texto: enviados.append((ruta.name, texto)))
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chat, texto: textos.append(texto))

    nombre = backup.crear_backup_automatico()

    assert [n for n, _ in enviados] == [nombre] and nombre.endswith("_auto.zip")
    assert "automática" in enviados[0][1]
    assert textos == []   # el pie del fichero ya lo cuenta: sin segundo mensaje


def test_si_el_fichero_no_sale_se_cae_al_aviso_de_texto(con_claves, monkeypatch):
    from core import telegram_notifier
    from routes import backup

    telegram_notifier.reiniciar_para_pruebas()
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")
    textos = []

    def falla(*_a):
        raise OSError("sin red")

    monkeypatch.setattr(telegram_notifier, "_enviar_documento", falla)
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chat, texto: textos.append(texto))

    backup.crear_backup_automatico()
    assert len(textos) == 1 and "automática" in textos[0]


def test_un_zip_demasiado_grande_avisa_en_vez_de_intentar_subirlo(con_claves, monkeypatch):
    from core import telegram_notifier
    from routes import backup

    _ajustes(con_claves[2], telegramAvisos={"backupFichero": True})
    telegram_notifier.reiniciar_para_pruebas()
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")
    textos = []
    monkeypatch.setattr(telegram_notifier, "MAX_BYTES_DOCUMENTO", 10)
    monkeypatch.setattr(telegram_notifier, "_enviar_documento",
                        lambda *a: pytest.fail("no debería intentar subirlo"))
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chat, texto: textos.append(texto))

    backup.crear_backup_automatico()
    assert len(textos) == 1 and "50 MB" in textos[0]


def test_el_ajuste_se_guarda_y_se_lee(cliente):
    from routes.ajustes import ajustes_bp

    client, cabeceras, _rutas = cliente
    client.application.register_blueprint(ajustes_bp)
    assert client.get("/api/settings").get_json()["backupIncluirClaves"] is False
    assert client.post("/api/settings", json={"backupIncluirClaves": True}, headers=cabeceras).get_json()["ok"]
    assert client.get("/api/settings").get_json()["backupIncluirClaves"] is True
    # Un valor que no es booleano de verdad no lo activa
    client.post("/api/settings", json={"backupIncluirClaves": "false"}, headers=cabeceras)
    assert client.get("/api/settings").get_json()["backupIncluirClaves"] is False

def test_de_fabrica_la_copia_no_se_sube_a_telegram(con_claves, monkeypatch):
    """Subir el ZIP (todas las carteras) a Telegram es opt-in: solo sale el aviso de texto."""
    from core import telegram_notifier
    from routes import backup

    telegram_notifier.reiniciar_para_pruebas()
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")
    textos = []
    monkeypatch.setattr(telegram_notifier, "_enviar_documento",
                        lambda *a: pytest.fail("no debería subir el fichero sin pedirlo"))
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chat, texto: textos.append(texto))

    backup.crear_backup_automatico()

    assert len(textos) == 1 and "automática" in textos[0]


# ── Contraseña propia de las copias ─────────────────────────────────────────

def test_el_formato_de_la_contrasena_de_copias_es_el_del_export_manual():
    from core import clave_copias, exportables

    assert clave_copias.FORMATO == exportables._FORMATO_CIFRADO
    assert clave_copias.ITERACIONES == exportables._ITERACIONES_CIFRADO


def test_fijar_contrasena_valida_el_largo_y_no_guarda_la_contrasena(con_claves):
    client, cabeceras, rutas = con_claves
    r = client.post("/api/backup/contrasena", json={"contrasena": "corta"}, headers=cabeceras)
    assert r.status_code == 400 and not (rutas["data"] / "backup_clave.dat").exists()

    r = client.post("/api/backup/contrasena", json={"contrasena": "una-contrasena-larga"}, headers=cabeceras)
    assert r.status_code == 200 and r.get_json()["configurada"] is True
    # ni la contraseña ni la clave derivada quedan legibles en el disco
    fichero = (rutas["data"] / "backup_clave.dat").read_bytes()
    assert fichero.startswith(b"ENC1:") and b"una-contrasena-larga" not in fichero

    r = client.delete("/api/backup/contrasena", headers=cabeceras)
    assert r.get_json()["configurada"] is False and not (rutas["data"] / "backup_clave.dat").exists()


def test_la_copia_usa_la_contrasena_de_copias_y_no_la_de_la_web(con_claves, monkeypatch):
    from core import exportables

    client, cabeceras, rutas = con_claves
    client.post("/api/backup/contrasena", json={"contrasena": "una-contrasena-larga"}, headers=cabeceras)
    _ajustes(rutas, backupIncluirClaves=True)
    nombre = client.post("/api/backup", headers=cabeceras).get_json()["filename"]
    ruta = rutas["backups"] / nombre
    with zipfile.ZipFile(ruta) as zf:
        paquete = json.loads(zf.read("claves-api.cifradas.json"))
    assert b"CLAVE-SECRETA-FINNHUB" not in ruta.read_bytes()
    assert exportables.descifrarClaves(paquete, "una-contrasena-larga")["finnhub"] == ["CLAVE-SECRETA-FINNHUB"]
    with pytest.raises(exportables.ContrasenaIncorrecta):
        exportables.descifrarClaves(paquete, "la-clave-de-la-web")

    # En este servidor, con la misma contraseña, se restaura sin preguntar
    (rutas["claves"] / "finnhub.key").unlink()
    r = client.post("/api/restore", json={"filename": nombre}, headers=cabeceras)
    assert r.status_code == 200 and r.get_json()["claves"] == ["finnhub.key"]


def test_si_cambia_la_contrasena_de_copias_se_pide_la_de_entonces(con_claves):
    client, cabeceras, rutas = con_claves
    client.post("/api/backup/contrasena", json={"contrasena": "contrasena-de-ayer"}, headers=cabeceras)
    _ajustes(rutas, backupIncluirClaves=True)
    nombre = client.post("/api/backup", headers=cabeceras).get_json()["filename"]
    client.post("/api/backup/contrasena", json={"contrasena": "contrasena-de-hoy!"}, headers=cabeceras)
    (rutas["claves"] / "finnhub.key").unlink()

    r = client.post("/api/restore", json={"filename": nombre}, headers=cabeceras)
    assert r.status_code == 400 and r.get_json()["necesitaContrasena"] is True
    r = client.post("/api/restore", json={"filename": nombre, "contrasena": "mal-mal-mal"}, headers=cabeceras)
    assert r.status_code == 400 and r.get_json()["error"] == "Contraseña incorrecta"
    r = client.post("/api/restore", json={"filename": nombre, "contrasena": "contrasena-de-ayer"}, headers=cabeceras)
    assert r.status_code == 200 and r.get_json()["claves"] == ["finnhub.key"]


def test_ver_la_contrasena_de_copias_exige_la_contrasena_de_la_web(con_claves):
    client, cabeceras, _rutas = con_claves
    client.post("/api/backup/contrasena", json={"contrasena": "una-contrasena-larga"}, headers=cabeceras)

    r = client.post("/api/backup/contrasena/ver", json={"currentPassword": "mal"}, headers=cabeceras)
    assert r.status_code == 400 and "contrasena" not in r.get_json()
    r = client.post("/api/backup/contrasena/ver", json={}, headers=cabeceras)
    assert r.status_code == 400

    r = client.post("/api/backup/contrasena/ver", json={"currentPassword": "la-clave-de-la-web"}, headers=cabeceras)
    assert r.status_code == 200 and r.get_json()["contrasena"] == "una-contrasena-larga"
    assert r.headers["Cache-Control"] == "no-store"
