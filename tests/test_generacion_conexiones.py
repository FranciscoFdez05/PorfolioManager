"""Sustituir un .db tiene que hacer que TODOS los procesos reabran sus conexiones.

Regresión: restaurar una copia reemplaza el fichero (`os.replace`), y
`invalidate_all_connections()` solo afectaba al proceso que restauraba. El otro
worker de gunicorn seguía escribiendo sobre el fichero anterior, ya
desvinculado, y esas escrituras se perdían al reiniciar.
"""

import os
import sqlite3


def _otro_proceso_publica(ruta):
    """Lo que hace invalidate_all_connections() en el otro worker."""
    ruta.parent.mkdir(parents=True, exist_ok=True)
    ruta.write_text(f"otro-proceso-{os.urandom(4).hex()}", "utf-8")
    st = ruta.stat()
    os.utime(ruta, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))


def test_un_aviso_de_otro_proceso_reabre_la_conexion(temp_db):
    from core import db

    antes = db.get_db()
    assert db.get_db() is antes  # sin avisos, se reutiliza

    _otro_proceso_publica(db._fichero_generacion())

    assert db.get_db() is not antes


def test_tras_el_aviso_se_lee_el_fichero_sustituido(temp_db, tmp_path):
    """El caso real: el fichero cambia de inodo por debajo de la conexión."""
    from core import db

    conn = db.get_db()
    conn.execute("INSERT INTO activos (id, name, type) VALUES ('viejo', 'Viejo', 'acciones')")
    conn.commit()

    # Otro proceso restaura: copia nueva con otro contenido y rename encima.
    nueva = tmp_path / "restaurada.db"
    origen, destino = sqlite3.connect(str(temp_db)), sqlite3.connect(str(nueva))
    origen.backup(destino)
    destino.execute("DELETE FROM activos")
    destino.execute("INSERT INTO activos (id, name, type) VALUES ('restaurado', 'Restaurado', 'acciones')")
    destino.commit()
    origen.close()
    destino.close()
    # En Linux el rename funciona con la conexión abierta (y por eso se perdían
    # escrituras); Windows no deja sustituir un fichero abierto.
    db.reset_db()
    os.replace(nueva, temp_db)
    _otro_proceso_publica(db._fichero_generacion())

    ids = [fila[0] for fila in db.get_db().execute("SELECT id FROM activos")]
    assert ids == ["restaurado"]


def test_el_aviso_propio_no_provoca_una_segunda_invalidacion(temp_db):
    from core import db

    db.invalidate_all_connections()
    conn = db.get_db()

    assert db.get_db() is conn


def test_el_primer_aviso_tras_arrancar_sin_fichero_tambien_cuenta(temp_db, monkeypatch):
    """Un proceso que arrancó sin fichero de generación tiene que reaccionar al
    primero que publique otro."""
    from core import db

    ruta = db._fichero_generacion()
    ruta.unlink(missing_ok=True)
    monkeypatch.setattr(db, "_generacion_vista", db._SIN_LEER)
    conn = db.get_db()  # primera lectura: no hay fichero

    _otro_proceso_publica(ruta)

    assert db.get_db() is not conn
