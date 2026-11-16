"""Importes en céntimos enteros: conversión, lectura y migración desde texto.

Los importes en moneda se guardan en columnas `INTEGER` con sufijo `_cent`
(`cantidad_cent`, `comision_cent`, `saldo_inicial_cent`). La columna de texto
original se conserva con otro papel: guarda **solo** lo que no se pudo convertir
a céntimos exactos (un texto ilegible, un importe con más de dos decimales, otra
divisa). Así la migración nunca pierde ni redondea un dato: lo que no cabe en
céntimos se queda como estaba y se sigue leyendo.

Reglas de lectura y escritura, comunes a todas las tablas:

* `cent` no nulo: es el importe y el texto legado está vacío.
* `cent` nulo: el importe es el texto legado (puede ser `""`, que es una celda
  vacía y vale cero).

La API sigue hablando en texto (`"1.234,56 €"`): la conversión vive en los
stores, y el frontend no cambia.

Nunca se usa `float`. Las sumas por SQL (`importeSql`) trabajan con enteros.
"""

import logging
import sqlite3
from decimal import Decimal

from core import dinero

log = logging.getLogger(__name__)

# Tope de un importe convertible: 10^12 euros. Por encima es un dato corrupto o
# un error de tecleo, y un entero de SQLite (64 bits) cabría de sobra, pero un
# importe así tiene que seguir visible como texto para que alguien lo revise.
_MAXIMO = Decimal(10) ** 12

# Columnas convertidas: (tabla, columna de texto) o (tabla, columna, columna de
# moneda). La de céntimos es `<col>_cent`. Se amplía fase a fase; cada versión de
# esquema añade las suyas. La columna de moneda limita la conversión a las filas
# en euros en las tablas que guardan cada importe en la divisa de su fila:
# `_cent` no lleva divisa y se lee siempre como euros, así que un importe en
# dólares sin símbolo saldría con «€» y la pantalla lo interpretaría mal.
Columna = tuple[str, str] | tuple[str, str, str]
COLUMNAS_FASE_A: tuple[tuple[str, str], ...] = (
    ("gastos_rows", "cantidad"),
    ("ingresos_rows", "cantidad"),
    ("transferencias", "cantidad"),
    ("transferencias", "comision"),
    ("cuentas", "saldo_inicial"),
)


MESES: tuple[str, ...] = (
    "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
    "septiembre", "octubre", "noviembre", "diciembre",
)

# Fase B: el importe habitual y los doce importes mensuales de mensualidades e
# ingresos recurrentes.
COLUMNAS_FASE_B: tuple[tuple[str, str], ...] = tuple(
    (tabla, columna)
    for tabla in ("mensualidades", "ingresos_recurrentes")
    for columna in (*MESES, "importe")
)


_EUR_TOTAL = "moneda_total"
_EUR = "currency"

# Fase C: dividendos, intereses de cuentas remuneradas, renta fija y bonos.
# `dividendo_accion` es un precio por acción (admite decimales) y se queda en texto.
COLUMNAS_FASE_C: tuple[Columna, ...] = (
    ("dividendos", "total", _EUR_TOTAL),
    ("dividendos", "impuestos", _EUR_TOTAL),
    ("intereses_v2", "acumulado"),
    ("intereses_v2", "impuestos"),
    ("renta_fija", "invertido", _EUR),
    ("renta_fija", "interes_acumulado", _EUR),
    ("renta_fija", "impuestos", _EUR),
    ("bonos", "invertido", _EUR),
    ("bonos", "interes_acumulado", _EUR),
    ("bonos", "impuestos", _EUR),
)

# Fase D: deudas y ventas. De las ventas solo lo que se teclea: el resto de
# columnas (`valor_compra`, `tramo1-5`, `total_pagar`, `bruto`, `neto`...) es
# una copia que el servidor recalcula en cada lectura y no se convierte.
COLUMNAS_FASE_D: tuple[Columna, ...] = (
    ("hipotecas", "capital"),
    ("financiaciones", "precio"),
    ("financiaciones", "entrada"),
    ("microcreditos", "importe"),
    ("microcreditos", "comision"),
    ("ventas", "valor_venta", _EUR),
    ("ventas", "comision_venta", _EUR),
)


# Fase E: trading, mercado privado y stablecoins. Cada importe va en la divisa de
# su fila (`capital_currency` en trading, `currency` en las otras dos).
# Staking y earn no tienen importes en moneda: solo cantidades de cripto y precios
# unitarios, que necesitan más decimales y se quedan en texto.
COLUMNAS_FASE_E: tuple[Columna, ...] = (
    ("trading", "capital", "capital_currency"),
    ("trading", "ganancia", "capital_currency"),
    ("trading", "ganancia_neta", "capital_currency"),
    ("private_market", "comprometido", _EUR),
    ("private_market", "llamado", _EUR),
    ("private_market", "distribuido", _EUR),
    ("private_market", "valor_actual", _EUR),
    ("stablecoins_rows", "total", _EUR),
    ("stablecoins_rows", "comisiones", _EUR),
)


# Fase F: el núcleo de inversión. Solo los importes en moneda: `capital_invertido_bruto`,
# `comisiones` y `comisiones_fiat` de la ficha, `total` y `comisiones_fiat` de las
# operaciones, y `valor_eur` y la comisión de las conversiones. Cantidades,
# precios, comisiones en cripto y tipos de cambio se quedan en texto: necesitan
# más de dos decimales. `transacciones` solo tiene cantidades de cripto.
COLUMNAS_FASE_F: tuple[Columna, ...] = (
    ("activo_rows", "capital_invertido_bruto", _EUR),
    ("activo_rows", "comisiones", _EUR),
    ("activo_rows", "comisiones_fiat", _EUR),
    ("activo_operation_rows", "total", _EUR),
    ("activo_operation_rows", "comisiones_fiat", _EUR),
    ("operaciones", "total", _EUR),
    ("operaciones", "comisiones_fiat", _EUR),
    ("activo_conversion_rows", "valor_eur"),
    ("activo_conversion_rows", "comision", "comision_moneda"),
)


class MigracionImportesError(RuntimeError):
    """La conversión a céntimos no cuadra con el original y no se debe confirmar."""


def aCentimos(valor) -> int | None:
    """Céntimos exactos de un importe, o `None` si no se puede convertir sin perder nada.

    Args:
        valor: Texto (`"1.234,56 €"`, `"40"`, `"-3.5"`), número o `Decimal`.

    Returns:
        El importe en céntimos. `None` si está vacío, no se entiende, lleva una
        divisa distinta del euro, tiene más de dos decimales o es desmesurado.
        `"1.234"` es 1,234 (así lo lee `dinero`), así que no se convierte.
    """
    if valor is None:
        return None
    texto = str(valor).strip()
    if not texto:
        return None
    sinEuro = "".join(texto.replace("€", "").split())
    if not sinEuro or not all(c.isdigit() or c in "+-.," for c in sinEuro):
        return None
    numero = dinero.aDecimalONulo(sinEuro)
    if numero is None or abs(numero) > _MAXIMO:
        return None
    if numero != numero.quantize(dinero.CENTIMO):
        return None
    return int(numero * 100)


def _aDecimal(centimos: int) -> Decimal:
    return Decimal(centimos).scaleb(-2)


def deCentimos(centimos: int) -> str:
    """Formato de presentación que escribe la web en las celdas: `"1.234,56 €"`."""
    return dinero.aTextoEs(_aDecimal(centimos), decimales=2) + " €"


def deCentimosCompacto(centimos: int) -> str:
    """Canónico sin ceros sobrantes (`"150000"`, `"1234.5"`): como guardan las deudas."""
    return dinero.aTexto(_aDecimal(centimos))


def deCentimosCanonico(centimos: int) -> str:
    """Formato canónico de almacenamiento (`"1234.56"`), el que usa `cuentas.saldo_inicial`."""
    return dinero.aTexto(_aDecimal(centimos), decimales=2)


def escribirImporte(texto) -> tuple[int | None, str]:
    """Par `(céntimos, legado)` a guardar para un importe recibido como texto.

    Args:
        texto: Lo que llega de la API.

    Returns:
        `(céntimos, "")` si es convertible; `(None, texto)` si no; `(None, "")`
        para una celda vacía.
    """
    limpio = "" if texto is None else str(texto).strip()
    if not limpio:
        return None, ""
    centimos = aCentimos(limpio)
    return (centimos, "") if centimos is not None else (None, limpio)


def esEuro(moneda) -> bool:
    """`True` si `moneda` es el euro. Una moneda vacía no lo es: no se asume."""
    return str(moneda or "").strip().upper() == "EUR"


def escribirImporteEn(texto, moneda) -> tuple[int | None, str]:
    """Como `escribirImporte`, pero solo convierte a céntimos si la fila es en euros."""
    if esEuro(moneda):
        return escribirImporte(texto)
    return None, "" if texto is None else str(texto).strip()


def legadoYCentimos(texto, moneda="EUR") -> tuple[str, int | None]:
    """`(texto legado, céntimos)` en el orden de las columnas `<col>, <col>_cent`.

    Para los INSERT de las tablas con importes en céntimos. Con `moneda` distinta
    del euro no convierte: el texto va tal cual a su columna.
    """
    centimosImporte, legado = escribirImporteEn(texto, moneda)
    return legado, centimosImporte


def normalizarImporte(texto, moneda="EUR") -> str:
    """El texto tal como se leerá tras guardarlo: sirve para comparar sin falsas diferencias.

    Un importe en euros convertible sale con el formato de presentación; el resto
    queda como estaba (sin espacios sobrantes).
    """
    centimosImporte, legado = escribirImporteEn(texto, moneda)
    return leerImporte(centimosImporte, legado)


def leerImporteCompacto(centimos, legado) -> str:
    """Como `leerImporte`, en canónico compacto (las deudas guardan `"150000"`, no `"150000.00"`)."""
    if centimos is None:
        return legado or ""
    return deCentimosCompacto(centimos)


def leerImporte(centimos, legado) -> str:
    """Importe como texto de presentación; el legado tal cual si no hay céntimos."""
    if centimos is None:
        return legado or ""
    return deCentimos(centimos)


def leerImporteCanonico(centimos, legado) -> str:
    """Como `leerImporte`, pero en formato canónico (para `saldo_inicial`)."""
    if centimos is None:
        return legado or ""
    return deCentimosCanonico(centimos)


def importeDecimal(centimos, legado) -> Decimal:
    """Importe como `Decimal` para sumar; ilegible o vacío vale cero."""
    if centimos is not None:
        return _aDecimal(centimos)
    return dinero.aDecimalONulo(legado) or Decimal(0)


def importeSql(columna: str) -> str:
    """Expresión SQL con el importe de `columna` como texto canónico (`"40.00"`).

    Para las lecturas que solo suman: devuelve lo mismo que el texto de antes si
    no hay céntimos, y el entero formateado con aritmética entera si los hay.
    Se usa con un alias: `SELECT {importeSql('cantidad')} AS cantidad`.

    Args:
        columna: Nombre de la columna de texto; la de céntimos es `<columna>_cent`.
    """
    cent = f"{columna}_cent"
    return (
        f"(CASE WHEN {cent} IS NULL THEN {columna} ELSE "
        f"(CASE WHEN {cent} < 0 THEN '-' ELSE '' END) || (ABS({cent}) / 100) || '.' || "
        f"printf('%02d', ABS({cent}) % 100) END)"
    )


def _tieneColumna(conn, tabla: str, columna: str) -> bool:
    return any(fila[1] == columna for fila in conn.execute(f"PRAGMA table_info({tabla})"))


def columnasConCent(columnas) -> str:
    """Lista SQL `a, a_cent, b, b_cent` para seleccionar cada importe con sus céntimos."""
    return ", ".join(f"{c}, {c}_cent" for c in columnas)


def leerColumnas(fila, columnas) -> dict[str, str]:
    """`{columna: importe como texto}` de una fila que trae `columnasConCent(columnas)`."""
    return {c: leerImporte(fila[f"{c}_cent"], fila[c]) for c in columnas}


def escribirColumnas(valores: dict, columnas) -> tuple[list, list]:
    """Pares listos para un INSERT: `(textos legados, céntimos)` en el orden de `columnas`.

    Args:
        valores: `{columna: texto}`; una columna ausente es una celda vacía.
        columnas: Orden de salida.
    """
    pares = [escribirImporte(valores.get(c, "")) for c in columnas]
    return [legado for _cent, legado in pares], [cent for cent, _legado in pares]


def importeLegible(conn, tabla: str, columna: str) -> str:
    """Expresión SQL del importe de `columna`, valga o no la base ya en céntimos.

    Para quien lee una base que puede ser anterior a la migración (la heredada,
    una copia): si no tiene `<columna>_cent` devuelve la columna tal cual.
    """
    return importeSql(columna) if _tieneColumna(conn, tabla, f"{columna}_cent") else columna


def anadirColumnasCentimos(conn, columnas=COLUMNAS_FASE_A) -> None:
    """Crea las columnas `<col>_cent INTEGER` que falten. Idempotente."""
    for tabla, columna, *_moneda in columnas:
        # Una tabla que aún no existe (base muy antigua) no tiene nada que convertir.
        if _tieneColumna(conn, tabla, columna) and not _tieneColumna(conn, tabla, f"{columna}_cent"):
            conn.execute(f"ALTER TABLE {tabla} ADD COLUMN {columna}_cent INTEGER")


def convertirImportes(conn: sqlite3.Connection, columnas=COLUMNAS_FASE_A) -> dict[str, tuple[int, int]]:
    """Pasa a céntimos los importes de texto que se puedan convertir exactos.

    Idempotente: solo toca filas con `<col>_cent` nulo y texto no vacío. Lo que
    no se convierte se deja intacto y se cuenta como pendiente. Al terminar cada
    columna comprueba que la suma convertida coincide con la suma original; si no,
    lanza `MigracionImportesError` y quien llama debe revertir.

    Args:
        conn: Conexión dentro de una transacción abierta por el llamador.
        columnas: Pares `(tabla, columna)` a convertir.

    Returns:
        `{"tabla.columna": (convertidas, pendientes)}`.

    Raises:
        MigracionImportesError: si la suma tras convertir no cuadra.
    """
    informe: dict[str, tuple[int, int]] = {}
    for tabla, columna, *moneda in columnas:
        cent = f"{columna}_cent"
        if not _tieneColumna(conn, tabla, cent):
            continue
        filtro = ""
        if moneda:
            if not _tieneColumna(conn, tabla, moneda[0]):
                # Sin columna de moneda no se sabe en qué divisa está el importe:
                # no se convierte nada, que es lo seguro.
                log.warning("%s no tiene la columna %s: %s no se convierte a céntimos", tabla, moneda[0], columna)
                continue
            filtro = f" AND UPPER(TRIM({moneda[0]})) = 'EUR'"
        filas = conn.execute(
            f"SELECT rowid, {columna} FROM {tabla} WHERE {cent} IS NULL AND {columna} != ''{filtro}"
        ).fetchall()
        convertidas = pendientes = 0
        sumaOriginal = Decimal(0)
        sumaCentimos = 0
        for rowid, texto in filas:
            centimos = aCentimos(texto)
            if centimos is None:
                pendientes += 1
                log.warning("Importe no convertible a céntimos en %s.%s (fila %s): %r", tabla, columna, rowid, texto)
                continue
            conn.execute(f"UPDATE {tabla} SET {cent} = ?, {columna} = '' WHERE rowid = ?", (centimos, rowid))
            sumaOriginal += dinero.aDecimal(texto.replace("€", ""))
            sumaCentimos += centimos
            convertidas += 1
        if sumaOriginal * 100 != sumaCentimos:
            raise MigracionImportesError(
                f"{tabla}.{columna}: la suma convertida ({sumaCentimos} cént.) no cuadra con la original ({sumaOriginal})"
            )
        informe[f"{tabla}.{columna}"] = (convertidas, pendientes)
        if convertidas or pendientes:
            log.info("Importes de %s.%s: %s convertidos, %s sin convertir", tabla, columna, convertidas, pendientes)
    return informe
