"""`problemasDeIntegridad`: el diagnóstico que acompaña al rechazo de una copia
o de una exportación.

`checkIntegrity` solo dice sí o no; esta función tiene que decir qué falla, y
sobre todo no puede dar por buena una base que no lo está.
"""

import sqlite3

from admin.backup_manager import problemasDeIntegridad


def _crearDbConFk(ruta, huerfana=False):
    conn = sqlite3.connect(str(ruta))
    conn.executescript(
        "CREATE TABLE activos (id TEXT PRIMARY KEY);"
        "CREATE TABLE activo_rows (id INTEGER PRIMARY KEY, activo TEXT REFERENCES activos(id));"
        "INSERT INTO activos VALUES ('btc');"
        "INSERT INTO activo_rows (activo) VALUES ('btc');"
    )
    if huerfana:
        # Con foreign_keys desactivado (el valor por defecto) SQLite la deja
        # entrar, que es justo como aparecen en una base real.
        conn.execute("INSERT INTO activo_rows (activo) VALUES ('eth')")
    conn.commit()
    conn.close()
    return ruta


def testUnaBaseSanaNoTieneProblemas(tmp_path):
    assert problemasDeIntegridad(_crearDbConFk(tmp_path / "sana.db")) == []


def testUnaFilaHuerfanaSeDiceConSuTabla(tmp_path):
    problemas = problemasDeIntegridad(_crearDbConFk(tmp_path / "huerfana.db", huerfana=True))

    assert len(problemas) == 1
    assert "activo_rows" in problemas[0]
    assert "activos" in problemas[0]


def testUnaPaginaRotaSeDetecta(tmp_path):
    ruta = tmp_path / "rota.db"
    conn = sqlite3.connect(str(ruta))
    conn.execute("CREATE TABLE t (x TEXT)")
    conn.executemany("INSERT INTO t VALUES (?)", [("x" * 500,) for _ in range(200)])
    conn.commit()
    conn.close()

    # Se machaca una página de datos del medio, dejando intacta la cabecera.
    datos = bytearray(ruta.read_bytes())
    datos[4096 * 3 : 4096 * 3 + 64] = b"\xff" * 64
    ruta.write_bytes(bytes(datos))

    assert problemasDeIntegridad(ruta) != []


def testUnFicheroQueNoEsSqliteNoPasa(tmp_path):
    ruta = tmp_path / "basura.db"
    ruta.write_bytes(b"esto no es una base de datos" * 200)

    problemas = problemasDeIntegridad(ruta)

    assert problemas
    assert "no se puede leer" in problemas[0]


def testLosProblemasSeLimitan(tmp_path):
    ruta = _crearDbConFk(tmp_path / "muchas.db")
    conn = sqlite3.connect(str(ruta))
    conn.executemany("INSERT INTO activo_rows (activo) VALUES (?)", [(f"x{i}",) for i in range(50)])
    conn.commit()
    conn.close()

    assert len(problemasDeIntegridad(ruta, maxProblemas=3)) == 3
