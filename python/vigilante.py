"""Vigilante: avisa por Telegram si la aplicación deja de responder.

Es un proceso **aparte** de la aplicación, y tiene que serlo: si el servidor se
cuelga, se queda sin memoria o el contenedor se para, los hilos de dentro se van
con él y nadie llega a contarlo. Este script no importa Flask ni abre la base de
datos; solo pregunta por HTTP a `/api/health` cada pocos segundos y usa el mismo
bot que el resto de avisos (`core.telegram_notifier`).

Cómo se lanza:

  * **Docker** — ya va como el servicio `vigilante` de docker-compose.yml.
  * **Sin Docker** — `python python/vigilante.py` en otra terminal o como
    servicio del sistema (tarea programada al iniciar, systemd…), junto al
    servidor. Lee `.env` para poder descifrar el token de Telegram.

Qué avisa:

  * 🔴 no responde (conexión rechazada, timeout, 5xx del proxy…) tras
    `[vigilante] fallos_para_avisar` comprobaciones seguidas, para no molestar
    por un reinicio de un par de segundos;
  * ⚠️ responde pero `/api/health` dice que está degradado (base de datos
    corrupta o inaccesible);
  * 🟢 vuelve a responder, con lo que duró la caída — solo si se había avisado;
  * un recordatorio cada `[vigilante] recordatorio_minutos` mientras siga mal.

Si Telegram no se puede alcanzar en ese momento (una caída de internet suele
llevarse las dos cosas), el aviso no se da por hecho y se reintenta en la
siguiente comprobación.
"""

import json
import logging
import ssl
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

log = logging.getLogger("vigilante")

OK, DEGRADADO, CAIDO = "ok", "degradado", "caido"
_TIMEOUT_SONDA = 10.0


# ── Qué vigilar ───────────────────────────────────────────────────────────────

def leer_objetivos(texto: str, puerto: int) -> list:
    """[(nombre, [urls])] a partir de «nombre=url|url2, otro=url».

    Varias URL separadas por «|» son alternativas para el mismo objetivo: sirve
    para un proxy que puede hablar HTTPS o HTTP según cómo esté configurado, y
    basta con que conteste una. Sin texto se vigila esta misma máquina.
    """
    objetivos = []
    for indice, trozo in enumerate(str(texto or "").split(","), start=1):
        trozo = trozo.strip()
        if not trozo:
            continue
        nombre, separador, resto = trozo.partition("=")
        # «http://host» contiene «=» solo en la query; sin «nombre=» delante el
        # trozo entero es la URL.
        if not separador or "://" in nombre:
            nombre, resto = f"web{indice}" if indice > 1 else "La aplicación", trozo
        urls = [u.strip() for u in resto.split("|") if u.strip()]
        if urls:
            objetivos.append((nombre.strip() or "La aplicación", urls))

    return objetivos or [("La aplicación", [f"http://127.0.0.1:{puerto}/api/health"])]


# ── Una comprobación ──────────────────────────────────────────────────────────

# Raíz de la CA interna de Caddy (`tls internal`). docker-compose monta el
# volumen de datos de Caddy en solo lectura en /caddy-data para que el vigilante
# pueda comprobar que quien contesta es de verdad ese Caddy.
_CA_POR_DEFECTO = "/caddy-data/caddy/pki/authorities/local/root.crt"
_avisado_sin_ca = False


def contexto_tls(ruta_ca=None):
    """Contexto TLS para sondear el proxy.

    Con la CA de Caddy a mano se verifica la cadena: un equipo de la red interna
    que se hiciera pasar por el proxy ya no contaría como «la aplicación
    responde». El nombre no se comprueba porque el certificado se emite para los
    nombres que el usuario escribió en Ajustes, y el vigilante llama a `caddy`.
    Se cargan también las raíces del sistema, por si el HTTPS es de una CA
    pública (`HTTPS_ENABLED` con Let's Encrypt).

    Sin el fichero (fuera de Docker, o sin el volumen montado) se sigue como
    antes, sin verificar: un vigilante que diese por caída una aplicación sana
    solo porque no encuentra la CA sería peor. Se avisa una vez en el log.
    """
    global _avisado_sin_ca
    import os

    ruta = ruta_ca or os.environ.get("VIGILANTE_CA", _CA_POR_DEFECTO)
    if ruta and os.path.isfile(ruta):
        contexto = ssl.create_default_context()
        contexto.load_verify_locations(cafile=ruta)
        contexto.check_hostname = False
        contexto.verify_mode = ssl.CERT_REQUIRED
        return contexto

    if not _avisado_sin_ca:
        _avisado_sin_ca = True
        log.warning("Sin la CA de Caddy (%s): el certificado del proxy no se verifica.", ruta)
    return ssl._create_unverified_context()


def sondear(urls, timeout=_TIMEOUT_SONDA, contexto=None):
    """(estado, detalle) tras preguntar a las URL en orden. Nunca lanza."""
    contexto = contexto or contexto_tls()
    resultado = (CAIDO, "sin respuesta")

    for url in urls:
        peticion = Request(url, headers={"User-Agent": "PorfolioManager-vigilante"})
        try:
            with urlopen(peticion, timeout=timeout, context=contexto):
                return OK, ""
        except HTTPError as error:
            if error.code == 503:
                return DEGRADADO, _fallo_del_health(error)
            resultado = (CAIDO, f"HTTP {error.code}")
        except (URLError, OSError, ValueError) as error:
            motivo = getattr(error, "reason", error)
            resultado = (CAIDO, str(motivo)[:120] or "sin respuesta")
    return resultado


def _fallo_del_health(error: HTTPError) -> str:
    try:
        cuerpo = json.loads(error.read().decode("utf-8", errors="replace"))
        return str(cuerpo.get("fallo") or cuerpo.get("estado") or "degradado")[:120]
    except Exception:
        return "degradado"


# ── Qué contar y cuándo ───────────────────────────────────────────────────────

def _duracion(segundos: float) -> str:
    minutos = int(segundos // 60)
    if minutos < 1:
        return f"{int(segundos)} s"
    if minutos < 120:
        return f"{minutos} min"
    return f"{minutos // 60} h {minutos % 60} min"


@dataclass
class Vigia:
    """Estado de un objetivo y las reglas de cuándo avisar de él."""

    nombre: str
    umbral: int
    recordatorio: float
    enviar: callable
    fallos: int = 0
    problema: str | None = None      # OK, DEGRADADO o CAIDO mientras dura una racha
    desde: float | None = None       # instante (epoch) del primer fallo de la racha
    avisado: str | None = None       # qué problema se ha llegado a contar
    ultimo_aviso: float = 0.0
    recuperacion_pendiente: bool = field(default=False)

    def procesar(self, estado: str, detalle: str, ahora: float) -> None:
        if estado == OK:
            self._recuperado(ahora)
            return

        if estado != self.problema:
            # Cambia el tipo de problema (de «no responde» a «degradado» o al
            # revés): la racha empieza de nuevo, pero la hora de la caída sigue
            # siendo la del primer fallo.
            self.problema = estado
            self.fallos = 0
            self.desde = self.desde or ahora
        self.fallos += 1
        self.recuperacion_pendiente = False

        if self.fallos < self.umbral:
            return

        toca_recordar = (
            self.recordatorio > 0 and self.avisado == estado
            and ahora - self.ultimo_aviso >= self.recordatorio
        )
        if self.avisado != estado or toca_recordar:
            self._avisar(estado, detalle, ahora, recordatorio=self.avisado == estado)

    def _avisar(self, estado, detalle, ahora, recordatorio) -> None:
        desde = datetime.fromtimestamp(self.desde or ahora).strftime("%H:%M:%S")
        if estado == CAIDO:
            texto = f"🔴 {self.nombre} no responde desde las {desde}"
        else:
            texto = f"⚠️ {self.nombre} responde pero está degradado desde las {desde}"
        if detalle:
            texto += f"\n{detalle}"
        if recordatorio:
            texto += f"\nSigue igual tras {_duracion(ahora - (self.desde or ahora))}."

        if self.enviar(texto):
            self.avisado = estado
            self.ultimo_aviso = ahora
        else:
            log.warning("No se pudo enviar el aviso de %s; se reintenta en la siguiente comprobación", self.nombre)

    def _recuperado(self, ahora) -> None:
        if self.avisado is not None or self.recuperacion_pendiente:
            duracion = _duracion(ahora - (self.desde or ahora))
            if self.enviar(f"🟢 {self.nombre} vuelve a responder (estuvo mal {duracion})"):
                self.recuperacion_pendiente = False
            else:
                # Sin poder contarlo: se conserva la hora de la caída y se
                # reintenta en la siguiente comprobación.
                self.recuperacion_pendiente = True
                self.avisado = None
                return
        self.fallos = 0
        self.problema = None
        self.desde = None
        self.avisado = None
        self.ultimo_aviso = 0.0


# ── Bucle ─────────────────────────────────────────────────────────────────────

def _enviar_por_telegram(texto: str) -> bool:
    from core import telegram_notifier

    # `responder` y no `notificar`: que la aplicación esté caída es lo que el
    # usuario quiere saber aunque haya silenciado los demás avisos.
    return telegram_notifier.responder(texto)


def ejecutar(objetivos, intervalo, umbral, recordatorio, enviar=_enviar_por_telegram,
             sonda=sondear, dormir=time.sleep, vueltas=None) -> None:
    """Bucle principal. `vueltas` limita las rondas (para las pruebas)."""
    vigias = [(Vigia(nombre, umbral, recordatorio, enviar), urls) for nombre, urls in objetivos]
    ronda = 0
    while vueltas is None or ronda < vueltas:
        ronda += 1
        for vigia, urls in vigias:
            estado, detalle = sonda(urls)
            if estado != OK:
                log.info("%s: %s %s", vigia.nombre, estado, detalle)
            try:
                vigia.procesar(estado, detalle, time.time())
            except Exception as error:
                # Un fallo enviando no puede parar la vigilancia.
                log.warning("%s: %s", vigia.nombre, error)
        if vueltas is None or ronda < vueltas:
            dormir(intervalo)


def main() -> int:
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass

    from core import settings, telegram_notifier

    logging.basicConfig(level=settings.nivelLog(), format=settings.formatoLog())

    objetivos = leer_objetivos(settings.vigilanteUrl(), settings.puerto())
    log.info(
        "Vigilando %s cada %s s (avisa tras %s fallos seguidos)",
        ", ".join(f"{n} → {u[0]}" for n, u in objetivos),
        settings.vigilanteIntervalo(), settings.vigilanteFallos(),
    )
    if not telegram_notifier.configurado():
        log.warning("Telegram no está configurado (Ajustes > Telegram): se vigila, pero no se avisará a nadie")

    try:
        ejecutar(
            objetivos, settings.vigilanteIntervalo(), settings.vigilanteFallos(),
            settings.vigilanteRecordatorioSegundos(),
        )
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
