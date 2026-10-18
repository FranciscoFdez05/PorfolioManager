"""Entorno aislado para las mediciones de rendimiento.

Todo lo que hay en perf/ trabaja sobre una COPIA de los datos, nunca sobre
data/ directamente: se copian las bases de datos de los portfolios (con la API
de backup de SQLite, que consolida el WAL sin escribir en el original) y los
JSON de ajustes. No se copian auth.dat (las credenciales se fijan por entorno),
las copias de seguridad (cientos de MB que ninguna medición necesita) ni API/
(sin claves no hay llamadas a proveedores externos ni mensajes de Telegram, que
meterían ruido de red en los números y avisarían al usuario de cada arranque).

Uso desde otro script de perf/:

    from entorno import Instancia
    with Instancia() as inst:
        sesion = inst.sesion()
        sesion.get("/api/activos")
"""

import http.cookiejar
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[1]
DIR_PYTHON = RAIZ / "python"
USUARIO = "perf"
CLAVE = "perf-clave-de-medicion"
# Clave fija y larga: rechazarSecretKeyInsegura() no acepta las cortas ni la
# del ejemplo. Solo firma las sesiones de esta copia.
SECRET_KEY = "perf-" + "0123456789abcdef" * 4


def dirTemporal() -> Path:
    base = os.environ.get("PERF_TMP") or tempfile.gettempdir()
    return Path(base) / "porfoliomanager-perf"


def copiarBd(origen: Path, destino: Path) -> None:
    fuente = sqlite3.connect(f"file:{origen.as_posix()}?mode=ro", uri=True)
    try:
        copia = sqlite3.connect(str(destino))
        try:
            fuente.backup(copia)
        finally:
            copia.close()
    finally:
        fuente.close()


def prepararDatos(origen: Path, destino: Path) -> Path:
    """Copia limpia de los datos de `origen` en `destino/data`."""
    if destino.exists():
        shutil.rmtree(destino)
    dirDatos = destino / "data"
    (dirDatos / "portfolios").mkdir(parents=True)
    (dirDatos / "JSON").mkdir()
    (destino / "API").mkdir()
    (destino / "logs").mkdir()

    for bd in sorted((origen / "portfolios").glob("*.db")):
        copiarBd(bd, dirDatos / "portfolios" / bd.name)
    for fichero in sorted((origen / "JSON").glob("*.json")):
        shutil.copy2(fichero, dirDatos / "JSON" / fichero.name)
    meta = origen / "portfolios.json"
    if meta.exists():
        shutil.copy2(meta, dirDatos / "portfolios.json")
    return dirDatos


def hashClave() -> str:
    sys.path.insert(0, str(DIR_PYTHON))
    from werkzeug.security import generate_password_hash

    # Pocas iteraciones a propósito: el login no es lo que se mide y con las
    # 600 000 de producción cada arranque de prueba pierde casi un segundo.
    return generate_password_hash(CLAVE, method="pbkdf2:sha256:1000")


def variablesEntorno(destino: Path, puerto: int) -> dict:
    entorno = dict(os.environ)
    entorno.update({
        "PORTFOLIO_DATA_DIR": str(destino / "data"),
        "PORTFOLIO_API_DIR": str(destino / "API"),
        "PORTFOLIO_LOGS_DIR": str(destino / "logs"),
        "PORT": str(puerto),
        "HOST": "127.0.0.1",
        "SECRET_KEY": SECRET_KEY,
        "LOGIN_USERNAME": USUARIO,
        "LOGIN_PASSWORD_HASH": hashClave(),
        # Sin proxy delante: no se intenta hablar con Caddy al arrancar.
        "PROXY_FIX_HOPS": "0",
        "HTTPS_ENABLED": "false",
        "FLASK_DEBUG": "false",
        # Nada de trabajo en segundo plano que dependa de la red o del reloj:
        # el snapshot del servidor y la comprobación de versión salen a internet.
        "MERCADO_SNAPSHOT_SERVIDOR": "false",
        "ACTUALIZACION_COMPROBAR": "false",
        "LOG_NIVEL": "WARNING",
        # Las pruebas de carga hacen muchas escrituras de sesión; el límite de
        # escrituras por minuto no es lo que se mide.
        "ESCRITURAS_POR_MINUTO": "100000",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUTF8": "1",
    })
    return entorno


def puertoLibre() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Sesion:
    """Cliente HTTP mínimo con cookies y CSRF, solo stdlib."""

    def __init__(self, baseUrl: str):
        self.baseUrl = baseUrl
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies))

    def _csrf(self) -> str:
        for cookie in self.cookies:
            if cookie.name == "csrf_token":
                return cookie.value
        return ""

    def peticion(self, metodo: str, ruta: str, cuerpo=None, cabeceras=None, formulario=None):
        datos = None
        todas = {"X-CSRF-Token": self._csrf()}
        if cuerpo is not None:
            datos = json.dumps(cuerpo).encode()
            todas["Content-Type"] = "application/json"
        if formulario is not None:
            datos = urllib.parse.urlencode(formulario).encode()
            todas["Content-Type"] = "application/x-www-form-urlencoded"
        todas.update(cabeceras or {})
        req = urllib.request.Request(self.baseUrl + ruta, data=datos, method=metodo, headers=todas)
        try:
            with self.opener.open(req, timeout=60) as resp:
                return resp.status, resp.read(), dict(resp.headers)
        except urllib.error.HTTPError as error:
            return error.code, error.read(), dict(error.headers)

    def get(self, ruta: str, cabeceras=None):
        return self.peticion("GET", ruta, cabeceras=cabeceras)

    def login(self) -> None:
        self.get("/login")
        estado, cuerpo, _ = self.peticion(
            "POST", "/login", formulario={"username": USUARIO, "password": CLAVE},
        )
        if estado >= 400:
            raise RuntimeError(f"Login fallido ({estado}): {cuerpo[:200]!r}")
        estado, _, _ = self.get("/api/activos")
        if estado != 200:
            raise RuntimeError(f"Login sin efecto: /api/activos devuelve {estado}")


class Instancia:
    """Arranca la aplicación sobre una copia de los datos y la para al salir.

    `servidor`:
      - "waitress": servidor WSGI multihilo de un solo proceso. Es lo más
        parecido a gunicorn gthread que funciona en Windows.
      - "gunicorn": el mismo comando que entrypoint.sh (solo Linux/macOS).
      - "flask": el servidor de desarrollo (python python/server.py).
    """

    def __init__(self, origen=None, servidor=None, hilos=8, workers=2, puerto=None, reutilizarDatos=False):
        self.origen = Path(origen) if origen else RAIZ / "data"
        if servidor is None:
            servidor = "gunicorn" if os.name != "nt" else "waitress"
        self.servidor = servidor
        self.hilos = hilos
        self.workers = workers
        self.puerto = puerto or puertoLibre()
        self.destino = dirTemporal() / f"instancia-{self.puerto}"
        self.reutilizarDatos = reutilizarDatos
        self.proc = None
        self.segundosArranque = None
        self.baseUrl = f"http://127.0.0.1:{self.puerto}"

    def comando(self) -> list:
        if self.servidor == "waitress":
            return [sys.executable, "-m", "waitress", f"--listen=127.0.0.1:{self.puerto}",
                    f"--threads={self.hilos}", "server:app"]
        if self.servidor == "gunicorn":
            return [sys.executable, "-m", "gunicorn", "--chdir", str(DIR_PYTHON),
                    "--bind", f"127.0.0.1:{self.puerto}", "--worker-class", "gthread",
                    "--workers", str(self.workers), "--threads", str(self.hilos // max(1, self.workers)),
                    "--timeout", "120", "--keep-alive", "5", "server:app"]
        return [sys.executable, str(DIR_PYTHON / "server.py")]

    def __enter__(self):
        if not (self.reutilizarDatos and (self.destino / "data").exists()):
            prepararDatos(self.origen, self.destino)
        entorno = variablesEntorno(self.destino, self.puerto)
        self.log = open(self.destino / "logs" / "servidor.log", "wb")
        inicio = time.perf_counter()
        self.proc = subprocess.Popen(self.comando(), cwd=str(DIR_PYTHON), env=entorno,
                                     stdout=self.log, stderr=subprocess.STDOUT)
        self.esperarListo(inicio)
        return self

    def esperarListo(self, inicio: float, limite: float = 120.0) -> None:
        while time.perf_counter() - inicio < limite:
            if self.proc.poll() is not None:
                raise RuntimeError(f"El servidor terminó al arrancar; ver {self.log.name}")
            try:
                with urllib.request.urlopen(self.baseUrl + "/api/health", timeout=2) as resp:
                    if resp.status == 200:
                        self.segundosArranque = time.perf_counter() - inicio
                        return
            except Exception:
                time.sleep(0.05)
        raise RuntimeError("El servidor no respondió a tiempo")

    def sesion(self) -> Sesion:
        s = Sesion(self.baseUrl)
        s.login()
        return s

    def __exit__(self, *exc):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.log.close()
        return False
