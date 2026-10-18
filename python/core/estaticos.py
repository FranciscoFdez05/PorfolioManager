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

import os
import re
import zlib
from pathlib import Path

from core import paths

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


def versionarReferencias(html, base=None):
    versiones = _versionesPorCarpeta({m.group(2) for m in _REFERENCIA.finditer(html)}, base)

    def sustituir(m):
        version = versiones.get(m.group(2))
        if version is None:
            return m.group(0)
        return f"{m.group(1)}{m.group(2)}?v={version}{m.group(3)}"

    return _REFERENCIA.sub(sustituir, html)


def esVersionVigente(rutaRelativa, version, base=None):
    """¿La URL pedida lleva la versión actual del fichero? Solo entonces es inmutable."""
    if not version:
        return False
    return firmaEstatico(rutaRelativa, base) == version


__all__ = ["esVersionVigente", "firmaEstatico", "versionarReferencias"]
