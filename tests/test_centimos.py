"""Importes en céntimos: conversión exacta, lectura con legado y migración desde texto."""

import sqlite3
from decimal import Decimal

import pytest

from core import centimos
from core.centimos import (
    MigracionImportesError,
    aCentimos,
    anadirColumnasCentimos,
    convertirImportes,
    deCentimos,
    deCentimosCanonico,
    escribirImporte,
    importeDecimal,
    importeSql,
    leerImporte,
    leerImporteCanonico,
)


@pytest.mark.parametrize("texto, esperado", [
    ("40,00 €", 4000), ("40", 4000), ("1.234,56 €", 123456), ("1234.56", 123456),
    ("-12,50", -1250), ("+3,5", 350), ("0,00", 0), ("  7,25  ", 725), ("1 234,56", 123456),
    (Decimal("2.50"), 250), (3, 300),
])
def testConviertenExactos(texto, esperado):
    assert aCentimos(texto) == esperado


@pytest.mark.parametrize("texto", [
    None, "", "  ", "abc", "12abc34", "40 $", "40 USD", "0,005", "1.234", "1e3", "NaN",
    "1,2,3", "€", "10000000000000", "--5",
])
def testNoConviertenLoDudoso(texto):
    assert aCentimos(texto) is None


def testElFormatoDePresentacionYElCanonico():
    assert deCentimos(123456) == "1.234,56 €"
    assert deCentimos(-5) == "-0,05 €"
    assert deCentimos(0) == "0,00 €"
    assert deCentimosCanonico(123456) == "1234.56"
    assert deCentimosCanonico(-5) == "-0.05"


@pytest.mark.parametrize("texto", ["1.234,56 €", "-0,01 €", "0,00 €", "999999,99 €"])
def testIdaYVueltaNoPierdeNada(texto):
    assert deCentimos(aCentimos(texto)) == dinero_es(texto)


def dinero_es(texto):
    from core import dinero

    return dinero.aTextoEs(dinero.aDecimal(texto.replace("€", "")), decimales=2) + " €"


def testEscribirImporte():
    assert escribirImporte("40,00 €") == (4000, "")
    assert escribirImporte("") == (None, "")
    assert escribirImporte(None) == (None, "")
    assert escribirImporte(" 0,005 ") == (None, "0,005")
    assert escribirImporte("12 USD") == (None, "12 USD")


def testLeerImporteUsaElLegadoSoloSinCentimos():
    assert leerImporte(4000, "") == "40,00 €"
    assert leerImporte(None, "0,005") == "0,005"
    assert leerImporte(None, "") == ""
    assert leerImporte(None, None) == ""
    assert leerImporte(0, "") == "0,00 €"
    assert leerImporteCanonico(100000, "") == "1000.00"
    assert leerImporteCanonico(None, "") == ""


def testImporteDecimal():
    assert importeDecimal(1250, "") == Decimal("12.50")
    assert importeDecimal(None, "3,5") == Decimal("3.5")
    assert importeDecimal(None, "basura") == 0
    assert importeDecimal(None, "") == 0


@pytest.fixture
def conn():
    c = sqlite3.connect(":memory:")
    c.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, importe TEXT NOT NULL DEFAULT '')")
    yield c
    c.close()


def testImporteSqlCoincideConElTexto(conn):
    anadirColumnasCentimos(conn, (("t", "importe"),))
    conn.executemany("INSERT INTO t (importe, importe_cent) VALUES (?, ?)", [
        ("", 4000), ("", -5), ("", 0), ("", 123456), ("0,005", None), ("", None),
    ])
    valores = [f[0] for f in conn.execute(f"SELECT {importeSql('importe')} FROM t ORDER BY id")]
    assert valores == ["40.00", "-0.05", "0.00", "1234.56", "0,005", ""]


def testAnadirColumnasEsIdempotente(conn):
    anadirColumnasCentimos(conn, (("t", "importe"),))
    anadirColumnasCentimos(conn, (("t", "importe"),))
    assert [f[1] for f in conn.execute("PRAGMA table_info(t)")].count("importe_cent") == 1


def testConvertirImportesMigraLoExactoYDejaElResto(conn):
    anadirColumnasCentimos(conn, (("t", "importe"),))
    conn.executemany("INSERT INTO t (importe) VALUES (?)",
                     [("40,00 €",), ("1.234,56 €",), ("0,005",), ("basura",), ("",), ("-2,5",)])
    informe = convertirImportes(conn, (("t", "importe"),))
    assert informe == {"t.importe": (3, 2)}

    filas = conn.execute("SELECT importe, importe_cent FROM t ORDER BY id").fetchall()
    assert filas == [("", 4000), ("", 123456), ("0,005", None), ("basura", None), ("", None), ("", -250)]


def testConvertirImportesEsIdempotente(conn):
    anadirColumnasCentimos(conn, (("t", "importe"),))
    conn.execute("INSERT INTO t (importe) VALUES ('10,00 €')")
    convertirImportes(conn, (("t", "importe"),))
    assert convertirImportes(conn, (("t", "importe"),)) == {"t.importe": (0, 0)}
    assert conn.execute("SELECT importe_cent FROM t").fetchone()[0] == 1000


def testSiLaSumaNoCuadraSeAbortaSinConfirmar(conn, monkeypatch):
    anadirColumnasCentimos(conn, (("t", "importe"),))
    conn.execute("INSERT INTO t (importe) VALUES ('10,00 €')")
    monkeypatch.setattr(centimos, "aCentimos", lambda texto: 999)
    with pytest.raises(MigracionImportesError):
        convertirImportes(conn, (("t", "importe"),))
