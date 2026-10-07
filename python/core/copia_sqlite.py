"""Copia consistente de una base SQLite, en un único sitio.

Había cuatro versiones de lo mismo —en routes/backup.py, routes/ajustes.py,
routes/portfolios.py y admin/backup_manager.py—, cada una con su propio
timeout y su propia forma de cerrar las conexiones si algo fallaba a medias.

Se usa la API de backup de SQLite y no una copia del fichero: con WAL, el .db
solo no lleva las últimas escrituras (están en el -wal), y copiarlo con el
servidor en marcha da una base desfasada o inconsistente.
"""

import sqlite3
from pathlib import Path

from core import settings


def copiar(origen, destino, *, timeout=None) -> Path:
    """Copia `origen` en `destino` (incluido el WAL pendiente) y devuelve `destino`.

    `destino` se crea o se sobrescribe. Quien necesite que el cambio sea
    atómico (sustituir una base en uso) copia a un temporal y renombra después.
    Las dos conexiones quedan cerradas pase lo que pase: una abierta impide en
    Windows borrar o renombrar el temporal.
    """
    segundos = settings.backupSqliteTimeout() if timeout is None else timeout
    src = dst = None
    try:
        src = sqlite3.connect(str(origen), timeout=segundos)
        dst = sqlite3.connect(str(destino), timeout=segundos)
        dst.execute(f"PRAGMA busy_timeout={int(segundos * 1000)}")
        src.backup(dst)
        dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        dst.commit()
    finally:
        for conn in (dst, src):
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
    return Path(destino)
