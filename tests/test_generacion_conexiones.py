"""Sustituir un .db tiene que hacer que TODOS los procesos reabran sus conexiones.

Regresión: restaurar una copia reemplaza el fichero (`os.replace`), y
`invalidateAllConnections()` solo afectaba al proceso que restauraba. El otro
worker de gunicorn seguía escribiendo sobre el fichero anterior, ya
desvinculado, y esas escrituras se perdían al reiniciar.
"""

import os
import sqlite3


def _otroProcesoPublica(ruta):
    """Lo que hace invalidateAllConnections() en el otro worker."""
    ruta.parent.mkdir(parents=True, exist_ok=True)
    ruta.write_text(f"otro-proceso-{os.urandom(4).hex()}", "utf-8")
    st = ruta.stat()
    os.utime(ruta, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))


def testUnAvisoDeOtroProcesoReabreLaConexion(tempDb):
    from core import db

    antes = db.getDb()
    assert db.getDb() is antes  # sin avisos, se reutiliza

    _otroProcesoPublica(db._ficheroGeneracion())

    assert db.getDb() is not antes


def testTrasElAvisoSeLeeElFicheroSustituido(tempDb, tmp_path):
    """El caso real: el fichero cambia de inodo por debajo de la conexión."""
    from core import db

    conn = db.getDb()
    conn.execute("INSERT INTO activos (id, name, type) VALUES ('viejo', 'Viejo', 'acciones')")
    conn.commit()

    # Otro proceso restaura: copia nueva con otro contenido y rename encima.
    nueva = tmp_path / "restaurada.db"
    origen, destino = sqlite3.connect(str(tempDb)), sqlite3.connect(str(nueva))
    origen.backup(destino)
    destino.execute("DELETE FROM activos")
    destino.execute("INSERT INTO activos (id, name, type) VALUES ('restaurado', 'Restaurado', 'acciones')")
    destino.commit()
    origen.close()
    destino.close()
    # En Linux el rename funciona con la conexión abierta (y por eso se perdían
    # escrituras); Windows no deja sustituir un fichero abierto.
    db.resetDb()
    os.replace(nueva, tempDb)
    _otroProcesoPublica(db._ficheroGeneracion())

    ids = [fila[0] for fila in db.getDb().execute("SELECT id FROM activos")]
    assert ids == ["restaurado"]


def testElAvisoPropioNoProvocaUnaSegundaInvalidacion(tempDb):
    from core import db

    db.invalidateAllConnections()
    conn = db.getDb()

    assert db.getDb() is conn


def testElPrimerAvisoTrasArrancarSinFicheroTambienCuenta(tempDb, monkeypatch):
    """Un proceso que arrancó sin fichero de generación tiene que reaccionar al
    primero que publique otro."""
    from core import db

    ruta = db._ficheroGeneracion()
    ruta.unlink(missing_ok=True)
    monkeypatch.setattr(db, "_generacionVista", db._SIN_LEER)
    conn = db.getDb()  # primera lectura: no hay fichero

    _otroProcesoPublica(ruta)

    assert db.getDb() is not conn
