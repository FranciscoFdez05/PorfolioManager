"""Límites al abrir los ZIP que sube el usuario (copias, exports, carteras).

Las tres rutas que aceptan un ZIP —«Importar ZIP», restaurar una copia y
importar una cartera— hacían `zf.read(entrada)` sin mirar cuánto ocupaba la
entrada descomprimida. DEFLATE comprime ceros a razón de ~1000:1: un ZIP de
1 MB con una «base de datos» de 1 GB de ceros llevaba el proceso a 2 GB de
memoria, y con el tope de subida (256 MB) un solo fichero podía pedir cientos
de GB y hacer que el sistema matase el worker.

Aquí se comprueba el tamaño declarado de cada entrada ANTES de descomprimir
nada (también antes de `testzip()`, que descomprime todo para validar el CRC),
y las bases de datos se extraen en streaming a disco en vez de a memoria.

El tamaño declarado en la cabecera es fiable a estos efectos: `zipfile` deja
de entregar datos al llegar a `file_size`, así que una entrada no puede
descomprimir más de lo que declara.
"""

import shutil
from pathlib import Path

from core import settings

# Por debajo de este tamaño no se mira la proporción: una base vacía de unos
# cientos de KB comprime muchísimo sin ser sospechosa de nada.
_UMBRAL_PROPORCION = 16 * 1024 * 1024
# DEFLATE no pasa de ~1032:1. Datos reales (SQLite, JSON) rondan 3-20:1; por
# encima de 500:1 lo que hay son ceros fabricados a propósito.
_PROPORCION_MAXIMA = 500
# Entradas que se leen a memoria (JSON de ajustes, preferencias, export). Un
# export JSON completo ronda los 25 MB: hay margen de sobra.
_MAX_EN_MEMORIA = 128 * 1024 * 1024
# Los JSON de configuración (ajustes.json, prefs_<cartera>.json) ocupan KB. Con el
# tope general, un ZIP con ocho prefs de 120 MB cada una pasaba la comprobación
# y `json.loads` de todas a la vez superaba varios GB de memoria.
_MAX_JSON_CONFIGURACION = 4 * 1024 * 1024
# Un export real lleva una base y unos pocos JSON por cartera.
_MAX_ENTRADAS = 2000


def _es_json_de_configuracion(nombre: str) -> bool:
    base = Path(nombre).name
    return base == "ajustes.json" or (base.startswith("prefs_") and base.endswith(".json"))


class ZipNoAdmitido(ValueError):
    """El ZIP descomprimiría más de lo razonable. La ruta lo traduce a 400."""


def limiteTotal() -> int:
    """Máximo descomprimido por ZIP: cuatro veces el tope de subida."""
    return settings.maxSubidaBytes() * 4


def comprobar(zf) -> None:
    """Lanza ZipNoAdmitido si alguna entrada (o el total) es desproporcionada."""
    total = 0
    limite = limiteTotal()
    entradas = zf.infolist()
    if len(entradas) > _MAX_ENTRADAS:
        raise ZipNoAdmitido(f"El ZIP tiene {len(entradas)} entradas; no parece una copia de esta aplicación")
    for info in entradas:
        tamano = info.file_size
        if _es_json_de_configuracion(info.filename) and tamano > _MAX_JSON_CONFIGURACION:
            raise ZipNoAdmitido(f"La entrada {info.filename!r} es demasiado grande para ser un fichero de ajustes")
        if tamano > _UMBRAL_PROPORCION and tamano > _PROPORCION_MAXIMA * max(info.compress_size, 1):
            raise ZipNoAdmitido(f"La entrada {info.filename!r} tiene una compresión anómala")
        if not info.filename.endswith(".db") and tamano > _MAX_EN_MEMORIA:
            raise ZipNoAdmitido(f"La entrada {info.filename!r} es demasiado grande")
        total += tamano
        if total > limite:
            raise ZipNoAdmitido("El ZIP descomprimido supera el tamaño máximo admitido")


def extraer(zf, nombre: str, destino) -> Path:
    """Descomprime la entrada `nombre` en `destino` sin pasar por memoria."""
    destino = Path(destino)
    with zf.open(nombre) as origen, open(destino, "wb") as salida:
        shutil.copyfileobj(origen, salida, 1024 * 1024)
    return destino


def esSqlite(ruta) -> bool:
    with open(ruta, "rb") as f:
        return f.read(16).startswith(b"SQLite format 3\x00")
