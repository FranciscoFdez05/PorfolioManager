"""Imagen de cabecera de los avisos de Telegram.

Nada sale a la red: se sustituyen `_enviarFoto` y `_enviar`, salvo en el test que
comprueba el cuerpo de la petición, que sustituye `urlopen`. Lo importante es que
un fallo con la imagen nunca se lleve por delante el aviso.
"""

import json
from pathlib import Path

import pytest

from core import telegram_notifier


@pytest.fixture
def canal(datosAislados, monkeypatch, tmp_path):
    """Telegram configurado, una carpeta con una imagen y los dos envíos capturados."""
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    telegram_notifier.reiniciarParaPruebas()
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    imagenes = tmp_path / "avisos"
    imagenes.mkdir()
    (imagenes / "backup-critico.png").write_bytes(b"png")
    monkeypatch.setattr(telegram_notifier, "_DIR_IMAGENES", imagenes)

    salida = {"fotos": [], "textos": []}
    monkeypatch.setattr(
        telegram_notifier, "_enviarFoto",
        lambda token, chat, ruta, texto="": salida["fotos"].append((ruta.name, texto)),
    )
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chat, texto: salida["textos"].append(texto))
    yield salida
    telegram_notifier.reiniciarParaPruebas()


def testElAvisoSaleComoFotoConElTextoDePie(canal):
    assert telegram_notifier.notificar("backup", "Ha fallado", gravedad=telegram_notifier.CRITICO) is True

    assert canal["fotos"] == [("backup-critico.png", "Ha fallado")]
    assert canal["textos"] == []


def testSinImagenParaEsaCombinacionSaleComoTexto(canal):
    assert telegram_notifier.notificar("backup", "Copia creada", gravedad=telegram_notifier.CORRECTO) is True

    assert canal["fotos"] == []
    assert canal["textos"] == ["Copia creada"]


def testSiFallaLaImagenElAvisoSaleComoTexto(canal, monkeypatch):
    def _cae(*_a):
        raise OSError("sin red")

    monkeypatch.setattr(telegram_notifier, "_enviarFoto", _cae)

    assert telegram_notifier.notificar("backup", "Ha fallado", gravedad=telegram_notifier.CRITICO) is True
    assert canal["textos"] == ["Ha fallado"]


def testUnTextoQueNoCabeEnElPieVaEnOtroMensaje(canal):
    largo = "x" * (telegram_notifier._MAX_PIE + 1)

    telegram_notifier.notificar("backup", largo, gravedad=telegram_notifier.CRITICO)

    assert canal["fotos"] == [("backup-critico.png", "")]
    assert canal["textos"] == [largo]


def testUnTextoJustoEnElLimiteCabeEnElPie(canal):
    justo = "x" * telegram_notifier._MAX_PIE

    telegram_notifier.notificar("backup", justo, gravedad=telegram_notifier.CRITICO)

    assert canal["fotos"] == [("backup-critico.png", justo)]
    assert canal["textos"] == []


def testResponderSinCategoriaNuncaLlevaImagen(canal):
    """Un código de verificación o la respuesta a un comando son texto, no un aviso."""
    assert telegram_notifier.responder("123456") is True

    assert canal["fotos"] == []
    assert canal["textos"] == ["123456"]


def testResponderConCategoriaLlevaImagenAunqueHayaSilencio(canal):
    telegram_notifier.silenciar(3600)

    assert telegram_notifier.responder("Caída", categoria="backup", gravedad=telegram_notifier.CRITICO) is True

    assert canal["fotos"] == [("backup-critico.png", "Caída")]


def testElCuerpoDeLaFotoMarcaLaPrimeraLineaEnNegrita(tmp_path, monkeypatch):
    capturado = {}

    class _Respuesta:
        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

        def read(self):
            return b'{"ok": true}'

    def _urlopen(peticion, timeout=None):
        capturado["url"] = peticion.full_url
        capturado["cuerpo"] = peticion.data
        return _Respuesta()

    monkeypatch.setattr(telegram_notifier.urllib.request, "urlopen", _urlopen)
    imagen = tmp_path / "a.png"
    imagen.write_bytes(b"contenido-png")

    # El carácter fuera del BMP ocupa dos unidades UTF-16: es lo que mide Telegram.
    telegram_notifier._enviarFoto("t", "1", imagen, "Título \U0001F600 <b>\nDetalle")

    assert "/sendPhoto" in capturado["url"]
    cuerpo = capturado["cuerpo"].decode("utf-8")
    assert "contenido-png" in cuerpo
    assert "parse_mode" not in cuerpo
    entidades = json.loads(cuerpo.split('name="caption_entities"\r\n\r\n')[1].split("\r\n")[0])
    assert entidades == [{"type": "bold", "offset": 0, "length": 13}]


def testTelegramRechazaLaFotoSeTrataComoFallo(tmp_path, monkeypatch):
    class _Respuesta:
        def __enter__(self):
            return self

        def __exit__(self, *_a):
            return False

        def read(self):
            return b'{"ok": false, "description": "PHOTO_INVALID_DIMENSIONS"}'

    monkeypatch.setattr(telegram_notifier.urllib.request, "urlopen", lambda p, timeout=None: _Respuesta())
    imagen = tmp_path / "a.png"
    imagen.write_bytes(b"x")

    with pytest.raises(ValueError, match="PHOTO_INVALID_DIMENSIONS"):
        telegram_notifier._enviarFoto("t", "1", imagen, "texto")


def testHayImagenParaCadaCategoriaYGravedad():
    """Se comprueba la carpeta real: conftest deja `_DIR_IMAGENES` apuntando a una vacía."""
    carpeta = Path(telegram_notifier.__file__).with_name("datos") / "avisos"
    # El fichero de la copia sale como documento, sin foto de cabecera.
    categorias = set(telegram_notifier.CATEGORIAS_AVISO) - {"backupFichero"}

    faltan = [
        f"{categoria}-{gravedad}.png"
        for categoria in categorias
        for gravedad in telegram_notifier.GRAVEDADES
        if not (carpeta / f"{categoria}-{gravedad}.png").is_file()
    ]

    assert faltan == []


def testCadaCategoriaTienePresentacionEnAjustes():
    assert set(telegram_notifier.PRESENTACION_AVISO) == set(telegram_notifier.CATEGORIAS_AVISO)


def testCadaGrupoTieneSuSeccionEnLaPaginaDeAvisos():
    """Un grupo sin sección dejaría sus interruptores fuera de sitio."""
    raiz = Path(telegram_notifier.__file__).resolve().parents[2]
    indice = (raiz / "index.html").read_text("utf-8")

    for grupo, _detalle in telegram_notifier.PRESENTACION_AVISO.values():
        assert f'data-aviso-grupo="{grupo}"' in indice


@pytest.mark.parametrize("texto,gravedad", [
    ("La aplicación no responde desde las 10:00:00", telegram_notifier.CRITICO),
    ("La aplicación responde pero está degradado desde las 10:00:00", telegram_notifier.AVISO),
    ("La aplicación vuelve a responder (estuvo mal 5 min)", telegram_notifier.CORRECTO),
])
def testElVigilanteDistingueLaGravedad(texto, gravedad):
    import vigilante

    assert vigilante._gravedadDe(texto) == gravedad
