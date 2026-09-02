"""Escrituras a disco seguras: temporal único y reemplazo atómico.

Media docena de sitios escribían su propio temporal con un nombre fijo —
`portfolios.tmp`, `_import_tmp_<id>.db`, `principal_2026-09-02.tmp`— y luego lo
renombraban sobre el destino. Eso arrastraba dos problemas que en el PC de
desarrollo casi no se ven y en el servidor sí:

* **El nombre fijo no es único.** El servidor de desarrollo es un proceso con
  un hilo; en Docker corren dos workers de gunicorn con cuatro hilos cada uno,
  y los dos hacen lo mismo a la vez al arrancar (copia automática, migración,
  guardado de `portfolios.json`). Dos escrituras simultáneas sobre el mismo
  temporal se pisan y lo que acaba renombrándose es una mezcla de las dos.

* **El sitio importaba.** Varios de esos temporales eran `.db` y vivían en
  `data/portfolios/`, que es justo donde todo el proyecto hace `glob("*.db")`
  para saber qué portfolios hay. Una importación a medias o una exportación en
  curso aparecían como un portfolio más: se copiaban al backup, se listaban y
  se les buscaban snapshots.

Aquí están las dos piezas que faltaban —un nombre temporal único y un
reemplazo atómico con fsync— para que ningún módulo tenga que volver a
resolverlo por su cuenta.
"""

import json
import os
import secrets
import threading
from contextlib import contextmanager
from pathlib import Path

# Sufijos que SQLite crea junto al fichero de base de datos. Al limpiar un
# temporal hay que llevárselos: quedaban huérfanos y ningún barrido los mira.
_SIDECARS_SQLITE = ("-wal", "-shm", "-journal")


def rutaTemporal(destino, directorio=None):
    """Ruta temporal única para escribir antes de renombrar sobre `destino`.

    Lleva pid e identificador de hilo, así que dos workers —o dos hilos del
    mismo worker— nunca eligen el mismo fichero. El punto inicial y el sufijo
    `.tmp` la dejan fuera de los `glob("*.db")` y de los listados.

    `directorio` permite sacar el temporal de la carpeta del destino, que es lo
    que hace falta cuando el destino vive en `data/portfolios/`.
    """
    destino = Path(destino)
    carpeta = Path(directorio) if directorio is not None else destino.parent
    carpeta.mkdir(parents=True, exist_ok=True)
    marca = f"{os.getpid()}-{threading.get_ident():x}-{secrets.token_hex(3)}"
    return carpeta / f".{destino.name}.{marca}.tmp"


def limpiarTemporal(tmp):
    """Borra un temporal y los sidecars que SQLite haya podido dejar al lado."""
    tmp = Path(tmp)
    try:
        tmp.unlink(missing_ok=True)
    except OSError:
        pass
    for sufijo in _SIDECARS_SQLITE:
        try:
            Path(str(tmp) + sufijo).unlink(missing_ok=True)
        except OSError:
            pass


@contextmanager
def temporalPara(destino, directorio=None):
    """Cede una ruta temporal única y la limpia pase lo que pase.

    Para lo que no es un simple volcado de bytes: copias de SQLite, ficheros
    que se suben y hay que validar antes de publicarlos. Quien la usa decide si
    la renombra sobre el destino (`Path.replace`, atómico) o si solo la lee.
    """
    tmp = rutaTemporal(destino, directorio)
    try:
        yield tmp
    finally:
        limpiarTemporal(tmp)


def escribirAtomico(destino, datos, *, permisos=None):
    """Escribe `datos` en `destino` sin dejarlo nunca a medias.

    tmp → fsync → rename. El rename es atómico dentro del mismo sistema de
    ficheros, así que quien lea el destino ve el contenido antiguo o el nuevo,
    nunca la mitad. Un `write_text()` directo trunca el fichero antes de
    escribirlo: si el proceso muere ahí, lo que queda es un fichero vacío.

    El temporal se crea en la carpeta del destino a propósito. Usar el /tmp del
    sistema rompería el rename entre sistemas de ficheros distintos, que es
    exactamente lo que pasa en Docker cuando `data/` es un volumen montado.
    """
    destino = Path(destino)
    destino.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(datos, str):
        datos = datos.encode("utf-8")

    tmp = rutaTemporal(destino)
    try:
        with open(tmp, "wb") as manejador:
            manejador.write(datos)
            manejador.flush()
            os.fsync(manejador.fileno())
        if permisos is not None:
            try:
                os.chmod(tmp, permisos)
            except OSError:
                pass  # sistemas de ficheros sin permisos POSIX (p. ej. Windows)
        os.replace(tmp, destino)
    except BaseException:
        limpiarTemporal(tmp)
        raise


def escribirJsonAtomico(destino, objeto, *, indent=2):
    """`escribirAtomico` con el volcado JSON que usa todo el proyecto."""
    escribirAtomico(destino, json.dumps(objeto, indent=indent, ensure_ascii=False))


__all__ = [
    "escribirAtomico",
    "escribirJsonAtomico",
    "limpiarTemporal",
    "rutaTemporal",
    "temporalPara",
]
