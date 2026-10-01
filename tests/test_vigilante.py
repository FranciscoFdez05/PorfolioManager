"""Vigilante: cuándo avisa de que la aplicación no responde y cuándo se calla.

Sin red ni esperas: la sonda, el envío y el reloj se inyectan. Lo que importa es
la regla de los avisos —esperar N fallos seguidos, no repetirse, contar la
recuperación solo si se avisó de la caída y no dar nada por enviado si Telegram
no estaba disponible— porque es lo que decide si el aviso llega a tiempo o si
llega demasiado.
"""

import io
import json
from urllib.error import HTTPError, URLError

import pytest
import vigilante
from vigilante import CAIDO, DEGRADADO, OK, Vigia


class Bandeja:
    """Envío de prueba: guarda los textos y puede fingir que Telegram no responde."""

    def __init__(self):
        self.textos = []
        self.disponible = True

    def __call__(self, texto):
        if not self.disponible:
            return False
        self.textos.append(texto)
        return True


@pytest.fixture
def bandeja():
    return Bandeja()


def _vigia(bandeja, umbral=3, recordatorio=3600):
    return Vigia("La aplicación", umbral, recordatorio, bandeja)


# ── Cuándo avisa ──────────────────────────────────────────────────────────────

def test_no_avisa_hasta_el_numero_de_fallos_seguidos(bandeja):
    vigia = _vigia(bandeja, umbral=3)

    vigia.procesar(CAIDO, "timeout", 100)
    vigia.procesar(CAIDO, "timeout", 130)
    assert bandeja.textos == []

    vigia.procesar(CAIDO, "timeout", 160)
    assert len(bandeja.textos) == 1
    assert "🔴" in bandeja.textos[0] and "no responde" in bandeja.textos[0]
    assert "timeout" in bandeja.textos[0]


def test_un_reinicio_corto_no_molesta(bandeja):
    vigia = _vigia(bandeja, umbral=3)

    vigia.procesar(CAIDO, "x", 100)
    vigia.procesar(CAIDO, "x", 130)
    vigia.procesar(OK, "", 160)
    vigia.procesar(CAIDO, "x", 190)
    vigia.procesar(CAIDO, "x", 220)

    assert bandeja.textos == [], "los fallos no son seguidos: la racha se reinicia"


def test_no_se_repite_el_aviso_dentro_del_recordatorio(bandeja):
    vigia = _vigia(bandeja, umbral=1, recordatorio=3600)

    for instante in (100, 130, 160, 190):
        vigia.procesar(CAIDO, "x", instante)

    assert len(bandeja.textos) == 1


def test_recuerda_que_sigue_caida_pasado_el_plazo(bandeja):
    vigia = _vigia(bandeja, umbral=1, recordatorio=3600)

    vigia.procesar(CAIDO, "x", 100)
    vigia.procesar(CAIDO, "x", 100 + 3600)

    assert len(bandeja.textos) == 2
    assert "Sigue igual" in bandeja.textos[1]


def test_sin_recordatorio_avisa_una_sola_vez(bandeja):
    vigia = _vigia(bandeja, umbral=1, recordatorio=0)

    vigia.procesar(CAIDO, "x", 100)
    vigia.procesar(CAIDO, "x", 100 + 10 * 3600)

    assert len(bandeja.textos) == 1


def test_avisa_de_que_vuelve_con_lo_que_duro(bandeja):
    vigia = _vigia(bandeja, umbral=1)

    vigia.procesar(CAIDO, "x", 1000)
    vigia.procesar(OK, "", 1000 + 5 * 60)

    assert len(bandeja.textos) == 2
    assert "🟢" in bandeja.textos[1] and "5 min" in bandeja.textos[1]


def test_no_cuenta_la_recuperacion_de_una_caida_de_la_que_no_aviso(bandeja):
    vigia = _vigia(bandeja, umbral=3)

    vigia.procesar(CAIDO, "x", 100)
    vigia.procesar(OK, "", 130)

    assert bandeja.textos == []


def test_tras_recuperarse_una_caida_nueva_vuelve_a_avisar(bandeja):
    vigia = _vigia(bandeja, umbral=1)

    vigia.procesar(CAIDO, "x", 100)
    vigia.procesar(OK, "", 200)
    vigia.procesar(CAIDO, "x", 300)

    assert len(bandeja.textos) == 3
    assert "🔴" in bandeja.textos[2]


def test_degradado_no_es_lo_mismo_que_caido(bandeja):
    vigia = _vigia(bandeja, umbral=1)

    vigia.procesar(DEGRADADO, "corrupta", 100)

    assert "⚠️" in bandeja.textos[0] and "degradado" in bandeja.textos[0]
    assert "corrupta" in bandeja.textos[0]


def test_pasar_de_caido_a_degradado_avisa_del_cambio(bandeja):
    vigia = _vigia(bandeja, umbral=1)

    vigia.procesar(CAIDO, "x", 100)
    vigia.procesar(DEGRADADO, "bd", 130)

    assert len(bandeja.textos) == 2
    assert "⚠️" in bandeja.textos[1]


# ── Telegram no disponible ────────────────────────────────────────────────────

def test_si_el_aviso_no_sale_se_reintenta_en_la_siguiente(bandeja):
    """Una caída de internet suele llevarse la aplicación y Telegram a la vez."""
    vigia = _vigia(bandeja, umbral=1)
    bandeja.disponible = False

    vigia.procesar(CAIDO, "x", 100)
    vigia.procesar(CAIDO, "x", 130)
    assert bandeja.textos == []

    bandeja.disponible = True
    vigia.procesar(CAIDO, "x", 160)
    assert len(bandeja.textos) == 1


def test_si_la_recuperacion_no_sale_se_reintenta(bandeja):
    vigia = _vigia(bandeja, umbral=1)
    vigia.procesar(CAIDO, "x", 100)
    bandeja.disponible = False

    vigia.procesar(OK, "", 200)
    assert len(bandeja.textos) == 1

    bandeja.disponible = True
    vigia.procesar(OK, "", 230)
    assert len(bandeja.textos) == 2 and "🟢" in bandeja.textos[1]

    vigia.procesar(OK, "", 260)
    assert len(bandeja.textos) == 2, "y una vez contada no se repite"


# ── Qué se vigila ─────────────────────────────────────────────────────────────

def test_sin_configurar_se_vigila_la_maquina_local():
    assert vigilante.leer_objetivos("", 8080) == [("La aplicación", ["http://127.0.0.1:8080/api/health"])]


def test_una_url_a_secas_es_la_url_no_un_nombre():
    assert vigilante.leer_objetivos("http://host:5000/api/health?a=b", 5000) == [
        ("La aplicación", ["http://host:5000/api/health?a=b"])
    ]


def test_nombre_y_alternativas():
    objetivos = vigilante.leer_objetivos(
        "Web=https://caddy:5000/api/health|http://caddy:5000/api/health, Otro=http://x/api/health", 5000
    )

    assert objetivos == [
        ("Web", ["https://caddy:5000/api/health", "http://caddy:5000/api/health"]),
        ("Otro", ["http://x/api/health"]),
    ]


def test_el_valor_que_pone_docker_compose_se_entiende():
    valor = "La aplicación=https://caddy:5000/api/health|http://caddy:5000/api/health"

    assert vigilante.leer_objetivos(valor, 5000) == [
        ("La aplicación", ["https://caddy:5000/api/health", "http://caddy:5000/api/health"])
    ]


# ── La sonda ──────────────────────────────────────────────────────────────────

class _Ok:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _http(codigo, cuerpo=b""):
    return HTTPError("http://x", codigo, "err", {}, io.BytesIO(cuerpo))


def test_200_es_ok(monkeypatch):
    monkeypatch.setattr(vigilante, "urlopen", lambda *a, **k: _Ok())

    assert vigilante.sondear(["http://x"]) == (OK, "")


def test_503_es_degradado_y_dice_por_que(monkeypatch):
    def _degradada(*a, **k):
        raise _http(503, json.dumps({"ok": False, "fallo": "corrupta"}).encode())

    monkeypatch.setattr(vigilante, "urlopen", _degradada)

    assert vigilante.sondear(["http://x"]) == (DEGRADADO, "corrupta")


def test_502_del_proxy_es_caido(monkeypatch):
    def _bad_gateway(*a, **k):
        raise _http(502)

    monkeypatch.setattr(vigilante, "urlopen", _bad_gateway)

    assert vigilante.sondear(["http://x"]) == (CAIDO, "HTTP 502")


def test_conexion_rechazada_es_caido(monkeypatch):
    def _rechazada(*a, **k):
        raise URLError(ConnectionRefusedError("rechazada"))

    monkeypatch.setattr(vigilante, "urlopen", _rechazada)

    estado, detalle = vigilante.sondear(["http://x"])

    assert estado == CAIDO and "rechazada" in detalle


def test_prueba_la_siguiente_alternativa(monkeypatch):
    """Primero HTTPS y, si no hay, HTTP: el esquema lo elige el usuario en Ajustes."""
    llamadas = []

    def _urlopen(peticion, **k):
        llamadas.append(peticion.full_url)
        if peticion.full_url.startswith("https"):
            raise URLError("sin TLS")
        return _Ok()

    monkeypatch.setattr(vigilante, "urlopen", _urlopen)

    assert vigilante.sondear(["https://x", "http://x"]) == (OK, "")
    assert llamadas == ["https://x", "http://x"]


def test_un_timeout_no_lanza(monkeypatch):
    def _lento(*a, **k):
        raise TimeoutError("timed out")

    monkeypatch.setattr(vigilante, "urlopen", _lento)

    assert vigilante.sondear(["http://x"])[0] == CAIDO


# ── Bucle ─────────────────────────────────────────────────────────────────────

def test_el_bucle_avisa_tras_los_fallos_y_cuenta_la_vuelta(bandeja):
    respuestas = iter([CAIDO, CAIDO, OK, OK])
    esperas = []

    vigilante.ejecutar(
        [("App", ["http://x"])], intervalo=30, umbral=2, recordatorio=0,
        enviar=bandeja, sonda=lambda urls: (next(respuestas), "x"),
        dormir=esperas.append, vueltas=4,
    )

    assert len(bandeja.textos) == 2
    assert "🔴" in bandeja.textos[0] and "🟢" in bandeja.textos[1]
    assert esperas == [30, 30, 30], "duerme entre rondas pero no tras la última"


def test_un_fallo_del_envio_no_para_la_vigilancia():
    def _cae(texto):
        raise RuntimeError("telegram")

    vigilante.ejecutar(
        [("App", ["http://x"])], intervalo=1, umbral=1, recordatorio=0,
        enviar=_cae, sonda=lambda urls: (CAIDO, "x"), dormir=lambda s: None, vueltas=3,
    )


def test_varios_objetivos_se_vigilan_por_separado(bandeja):
    def _sonda(urls):
        return (CAIDO, "x") if urls == ["http://a"] else (OK, "")

    vigilante.ejecutar(
        [("A", ["http://a"]), ("B", ["http://b"])], intervalo=1, umbral=1, recordatorio=0,
        enviar=bandeja, sonda=_sonda, dormir=lambda s: None, vueltas=2,
    )

    assert len(bandeja.textos) == 1 and "A" in bandeja.textos[0]


def test_duraciones_legibles():
    assert vigilante._duracion(20) == "20 s"
    assert vigilante._duracion(300) == "5 min"
    assert vigilante._duracion(3 * 3600 + 120) == "3 h 2 min"


def test_por_defecto_avisa_por_el_bot_de_ajustes_sin_pasar_por_las_categorias(datos_aislados, monkeypatch):
    """Que la aplicación esté caída se cuenta aunque el usuario haya silenciado el resto."""
    from core import telegram_notifier

    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")
    telegram_notifier.silenciar(3600)
    enviados = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chat, texto: enviados.append(texto))

    assert vigilante._enviar_por_telegram("🔴 caída") is True
    assert enviados == ["🔴 caída"]
