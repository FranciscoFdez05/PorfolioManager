"""Versión automática en las URLs de los JS y CSS propios.

El código propio se servía con `Cache-Control: no-cache`: correcto (nunca se usa
una copia vieja), pero el navegador tenía que preguntar por cada uno de los
~100 ficheros en cada carga. En local son unos milisegundos; desde el móvil o
una VPN, más de un segundo de 304 sin descargar nada.

Al servir index.html, cada `src="js/..."` y `href="css/..."` recibe un `?v=`
calculado del propio fichero (fecha de modificación y tamaño). Una petición
cuyo `v` coincide con el del fichero en ese momento se puede cachear un año:
si el fichero cambia, cambia su `v`, el index.html siguiente pide otra URL y el
navegador la descarga. No hay ninguna versión que acordarse de subir.

Lo que no encaje (un fichero que no existe, una referencia que ya lleva `?`,
como las de js/vendor/) se deja tal cual y se sigue sirviendo como antes.
"""

import logging
import os
import re
import threading
import time
import zlib
from pathlib import Path

from core import paths

log = logging.getLogger(__name__)

# Solo etiquetas que cargan recursos, solo rutas relativas a js/ o css/ y solo
# las que aún no llevan query: las de js/vendor/ traen su propio ?v= a mano.
_REFERENCIA = re.compile(
    r'(<(?:script|link)\b[^>]*?\s(?:src|href)=")((?:js|css)/[^"?#]+\.(?:js|css))(")'
)


def _base(base):
    return Path(base) if base is not None else paths.BASE_DIR


def _version(st):
    return format(zlib.crc32(f"{st.st_mtime_ns}:{st.st_size}".encode()), "08x")


def _segmentosSeguros(rutaRelativa):
    # Sin Path.resolve(): en Windows costaba ~0,4 ms por fichero, 40 ms en cada
    # index.html. Basta con no aceptar segmentos "..": las rutas son relativas
    # (empiezan por js/ o css/) y nunca suben de la base.
    segmentos = rutaRelativa.replace("\\", "/").split("/")
    if ".." in segmentos or rutaRelativa.startswith(("/", "\\")) or ":" in rutaRelativa:
        return None
    return segmentos


def firmaEstatico(rutaRelativa, base=None):
    """Versión del fichero (8 hex), o None si no existe o sale de la base."""
    segmentos = _segmentosSeguros(rutaRelativa)
    if segmentos is None:
        return None
    try:
        return _version(os.stat(os.path.join(_base(base), *segmentos)))
    except OSError:
        return None


def _versionesPorCarpeta(rutas, base):
    """Versión de cada ruta leyendo cada carpeta una sola vez.

    Un os.stat() por fichero eran ~5 ms por index.html en Windows (99
    ficheros). os.scandir trae fecha y tamaño en el mismo listado del
    directorio, sin una llamada al sistema por fichero.
    """
    porCarpeta = {}
    for ruta in rutas:
        segmentos = _segmentosSeguros(ruta)
        if segmentos is not None:
            porCarpeta.setdefault(tuple(segmentos[:-1]), set()).add(segmentos[-1])

    versiones = {}
    for carpeta, nombres in porCarpeta.items():
        try:
            with os.scandir(os.path.join(_base(base), *carpeta)) as entradas:
                for entrada in entradas:
                    if entrada.name in nombres and entrada.is_file():
                        versiones["/".join((*carpeta, entrada.name))] = _version(entrada.stat())
        except OSError:
            continue
    return versiones


def _sustituirVersiones(html, versiones):
    def sustituir(m):
        version = versiones.get(m.group(2))
        if version is None:
            return m.group(0)
        return f"{m.group(1)}{m.group(2)}?v={version}{m.group(3)}"

    return _REFERENCIA.sub(sustituir, html)


def versionarReferencias(html, base=None):
    versiones = _versionesPorCarpeta({m.group(2) for m in _REFERENCIA.finditer(html)}, base)
    return _sustituirVersiones(html, versiones)


class IndiceVersionado:
    """index.html ya versionado, rehecho solo cuando algo cambia.

    Versionar en cada petición duplicaba lo que costaba servir index.html:
    leerlo y mirar los 99 ficheros que referencia eran ~3,5 ms por carga en
    Windows. Aquí se guarda el resultado y un hilo lo comprueba cada
    `intervalo` segundos (fecha y tamaño de index.html y de cada fichero
    referenciado); si algo cambió, lo rehace. La petición solo pone el nonce.

    Durante ese segundo como mucho, una carga puede llevar el `v` anterior de un
    fichero recién cambiado. No sirve nada viejo: esa URL ya no es la vigente,
    así que serveStatic la manda con `no-cache` y el contenido actual.

    `transformar` se aplica a la plantilla al leerla (la versión de la
    aplicación, que no cambia mientras el proceso vive).
    """

    def __init__(self, ruta, base=None, transformar=None, intervalo=1.0):
        self.ruta = Path(ruta)
        self.base = base
        self.transformar = transformar or (lambda texto: texto)
        self.intervalo = intervalo
        self._lock = threading.Lock()
        self._hilo = None
        self._firmaIndice = None
        self._plantilla = None
        self._referencias = frozenset()
        self._versiones = None
        self._html = None

    def _firmaFichero(self):
        try:
            st = os.stat(self.ruta)
        except OSError:
            return None
        return (st.st_mtime_ns, st.st_size)

    def comprobar(self):
        """Rehace el HTML si cambió algo. Devuelve si lo ha rehecho."""
        with self._lock:
            firma = self._firmaFichero()
            plantilla, referencias = self._plantilla, self._referencias
            if plantilla is None or firma != self._firmaIndice:
                plantilla = self.transformar(self.ruta.read_text("utf-8"))
                referencias = frozenset(m.group(2) for m in _REFERENCIA.finditer(plantilla))
            versiones = _versionesPorCarpeta(referencias, self.base)
            if plantilla is self._plantilla and versiones == self._versiones:
                return False
            self._html = _sustituirVersiones(plantilla, versiones)
            self._firmaIndice, self._plantilla = firma, plantilla
            self._referencias, self._versiones = referencias, versiones
            return True

    def html(self, arrancarHilo=True):
        if self._html is None:
            self.comprobar()
        if arrancarHilo and self._hilo is None:
            self._arrancar()
        return self._html

    def _arrancar(self):
        with self._lock:
            if self._hilo is not None:
                return
            self._hilo = threading.Thread(target=self._vigilar, name="estaticos-index", daemon=True)
            self._hilo.start()

    def _vigilar(self):
        while True:
            time.sleep(self.intervalo)
            try:
                self.comprobar()
            except Exception as error:
                # Se sigue sirviendo la última versión buena; la siguiente
                # vuelta lo vuelve a intentar.
                log.warning("[estaticos] No se pudo comprobar index.html: %s", error)


def esVersionVigente(rutaRelativa, version, base=None):
    """¿La URL pedida lleva la versión actual del fichero? Solo entonces es inmutable."""
    if not version:
        return False
    return firmaEstatico(rutaRelativa, base) == version


__all__ = ["IndiceVersionado", "esVersionVigente", "firmaEstatico", "versionarReferencias"]
