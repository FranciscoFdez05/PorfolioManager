"""Informe anual de ganancias y pérdidas patrimoniales, listo para la Renta.

`core.fiscal_es` ya calculaba bien el ejercicio; lo que faltaba era poder
llevárselo. En abril, la pantalla de ventas obliga a copiar cifras a mano de una
tabla a Renta Web, y ese trasvase manual es donde se cuela el error que ningún
FIFO correcto evita.

Aquí se generan dos salidas del mismo cálculo:

  * **CSV** — una fila por transmisión más el bloque de totales, pensado para
    abrirlo en una hoja de cálculo y contrastarlo con la información fiscal que
    remite el bróker.
  * **HTML imprimible** — el mismo contenido maquetado para "Imprimir → Guardar
    como PDF", que es el PDF que hacía falta sin meter una dependencia de
    generación de PDF en la imagen Docker.

**Sobre las casillas.** El informe nombra los conceptos ("saldo neto de
ganancias y pérdidas patrimoniales a integrar en la base del ahorro"), no
números de casilla. La numeración del modelo 100 cambia de un ejercicio a otro,
y una casilla equivocada en un documento que se va a copiar a Renta Web es peor
que no dar ninguna: el usuario confiaría en ella. Los conceptos, en cambio, son
los que rotula el propio programa de ayuda en el apartado de ganancias y
pérdidas patrimoniales derivadas de la transmisión de elementos patrimoniales.

Lo que el informe **no** cubre, y sale advertido en él, es lo mismo que no
cubre `fiscal_es`: compensación con rendimientos del capital mobiliario,
exención por reinversión y coeficientes de abatimiento de la DT 9ª.
"""

import csv
import html
import io
from datetime import date
from decimal import Decimal

from core import dinero

TITULO = "Ganancias y pérdidas patrimoniales — base del ahorro"

ADVERTENCIAS = (
    "Este informe recoge únicamente las ganancias y pérdidas patrimoniales "
    "derivadas de transmisiones que constan en esta aplicación.",
    "No incluye la compensación con rendimientos del capital mobiliario "
    "(art. 49.1 LIRPF), la exención por reinversión ni los coeficientes de "
    "abatimiento de la DT 9ª para adquisiciones anteriores al 31-12-1994.",
    "Las cifras salen del criterio FIFO y de la regla de los dos meses "
    "(art. 33.5 LIRPF) aplicados a los datos introducidos. Contrástalas con la "
    "información fiscal que te remite cada entidad antes de presentar.",
)

# Columnas del detalle. El orden es el de lectura de una transmisión: qué se
# vendió, cuándo, por cuánto, qué costó y qué resultado sale.
COLUMNAS_DETALLE = (
    ("fecha", "Fecha de transmisión"),
    ("activo", "Elemento patrimonial"),
    ("cantidad", "Cantidad transmitida"),
    ("valorTransmision", "Valor de transmisión"),
    ("costeAdquisicion", "Valor de adquisición"),
    ("dineroDeclarar", "Ganancia o pérdida patrimonial"),
    ("perdidaNoComputable", "Pérdida no computable (art. 33.5)"),
    ("perdidaDiferidaLiberada", "Pérdida diferida integrada"),
)


def _dec(valor):
    """Decimal tolerante para las cifras que llegan ya serializadas.

    Antes hacía `Decimal(str(valor))` a pelo, y eso devolvía **cero** para
    cualquier importe en el formato español que usa el esquema ("1.234,56",
    "83,58 €"). No llegaba a ocurrir porque a este módulo le entran cifras
    canónicas salidas del motor FIFO, pero un informe de la renta que convierte
    importes en ceros en silencio no es algo que deba depender de quién llame.
    `core.dinero` entiende los dos formatos.

    Se mantiene tolerante —cero para lo que no se entienda— porque aquí el dato
    ya pasó por la validación del motor: lo que llega vacío es una columna
    opcional, no un error nuevo.
    """
    return dinero.aDecimal(valor, defecto=Decimal("0"))


def _es(valor):
    """Importe en formato español, que es como se teclea en Renta Web."""
    cantidad = _dec(valor).quantize(Decimal("0.01"))
    entero, _punto, decimales = f"{abs(cantidad):.2f}".partition(".")
    grupos = []
    while len(entero) > 3:
        grupos.insert(0, entero[-3:])
        entero = entero[:-3]
    grupos.insert(0, entero)
    signo = "-" if cantidad < 0 else ""
    return f"{signo}{'.'.join(grupos)},{decimales}"


def construir(anio, filas, resumen):
    """Estructura intermedia que comparten el CSV y el HTML.

    Se calcula una sola vez y la usan las dos salidas: si el CSV y el HTML se
    construyeran por separado acabarían divergiendo, y la discrepancia entre el
    fichero que se archiva y el que se mira es justo lo que no se detecta.
    """
    computables = [f for f in filas if not f.get("incidencia")]
    incidencias = [f for f in filas if f.get("incidencia")]

    ganancias = sum((_dec(f["dineroDeclarar"]) for f in computables
                     if _dec(f["dineroDeclarar"]) > 0), Decimal("0"))
    perdidas = sum((-_dec(f["dineroDeclarar"]) for f in computables
                    if _dec(f["dineroDeclarar"]) < 0), Decimal("0"))

    resumen = resumen or {}
    return {
        "anio": str(anio),
        "generado": date.today().strftime("%d-%m-%Y"),
        "detalle": computables,
        "incidencias": incidencias,
        # Conceptos en el orden en que los pide el apartado de la declaración.
        "totales": [
            ("Ganancias patrimoniales del ejercicio", _es(ganancias)),
            ("Pérdidas patrimoniales computables del ejercicio", _es(perdidas)),
            ("Saldo neto del ejercicio", _es(resumen.get("saldo"))),
            ("Compensación con saldos negativos de ejercicios anteriores",
             _es(resumen.get("compensadoAnteriores"))),
            ("Base imponible del ahorro por este concepto", _es(resumen.get("base"))),
            ("Cuota íntegra del ahorro correspondiente", _es(resumen.get("cuota"))),
        ],
        # Bloque aparte porque no va a ninguna casilla de este ejercicio: es lo
        # que hay que arrastrar y no perder de vista los cuatro años siguientes.
        "arrastres": resumen.get("arrastres") or [],
        "compensaciones": resumen.get("compensacionesAplicadas") or [],
        "saldoNegativoGenerado": _es(resumen.get("saldoNegativoGenerado")),
        "pendienteCompensar": _es(resumen.get("pendienteCompensar")),
        "perdidasNoComputables": _es(resumen.get("perdidasNoComputables")),
        "perdidasDiferidasLiberadas": _es(resumen.get("perdidasDiferidasLiberadas")),
    }


# ── CSV ───────────────────────────────────────────────────────────────────────

def a_csv(informe):
    """CSV con separador ';' y coma decimal: lo que espera Excel en español.

    Con separador ',' y punto decimal, Excel con configuración regional
    española mete toda la fila en una sola celda, que es exactamente lo que hace
    inútil un export.
    """
    buffer = io.StringIO(newline="")
    escritor = csv.writer(buffer, delimiter=";", lineterminator="\r\n")

    escritor.writerow([TITULO, f"Ejercicio {informe['anio']}"])
    escritor.writerow(["Generado el", informe["generado"]])
    escritor.writerow([])

    escritor.writerow(["DETALLE DE TRANSMISIONES"])
    escritor.writerow([etiqueta for _clave, etiqueta in COLUMNAS_DETALLE])
    for fila in informe["detalle"]:
        escritor.writerow([
            fila.get("fecha", "") if clave == "fecha" else
            fila.get("activo", "") if clave == "activo" else
            fila.get("cantidad", "") if clave == "cantidad" else
            _es(fila.get(clave))
            for clave, _etiqueta in COLUMNAS_DETALLE
        ])

    escritor.writerow([])
    escritor.writerow(["RESUMEN DEL EJERCICIO"])
    for concepto, importe in informe["totales"]:
        escritor.writerow([concepto, importe])

    escritor.writerow([])
    escritor.writerow(["REGLA DE LOS DOS MESES (art. 33.5 LIRPF)"])
    escritor.writerow(["Pérdidas bloqueadas por recompra en este ejercicio",
                       informe["perdidasNoComputables"]])
    escritor.writerow(["Pérdidas bloqueadas en ejercicios anteriores ya integradas",
                       informe["perdidasDiferidasLiberadas"]])

    escritor.writerow([])
    escritor.writerow(["SALDOS NEGATIVOS PENDIENTES DE COMPENSAR (art. 49.1.b LIRPF)"])
    escritor.writerow(["Ejercicio de origen", "Importe pendiente", "Último ejercicio para aplicarlo"])
    for arrastre in informe["arrastres"]:
        escritor.writerow([
            arrastre["anioOrigen"], _es(arrastre["importe"]), arrastre["ultimoEjercicio"],
        ])
    if not informe["arrastres"]:
        escritor.writerow(["(ninguno)", "", ""])
    escritor.writerow(["Saldo negativo generado en este ejercicio",
                       informe["saldoNegativoGenerado"], ""])

    if informe["compensaciones"]:
        escritor.writerow([])
        escritor.writerow(["COMPENSACIONES APLICADAS EN ESTE EJERCICIO"])
        escritor.writerow(["Ejercicio de origen", "Importe aplicado"])
        for compensacion in informe["compensaciones"]:
            escritor.writerow([compensacion["anioOrigen"], _es(compensacion["importe"])])

    if informe["incidencias"]:
        escritor.writerow([])
        escritor.writerow(["FILAS EXCLUIDAS DEL CÁLCULO"])
        escritor.writerow(["Fecha", "Elemento patrimonial", "Motivo"])
        for fila in informe["incidencias"]:
            escritor.writerow([fila.get("fecha", ""), fila.get("activo", ""),
                               fila.get("mensaje", "")])

    escritor.writerow([])
    escritor.writerow(["ADVERTENCIAS"])
    for advertencia in ADVERTENCIAS:
        escritor.writerow([advertencia])

    # BOM: sin él, Excel abre el CSV como ANSI y destroza los acentos.
    return "﻿" + buffer.getvalue()


# ── HTML imprimible ───────────────────────────────────────────────────────────

_ESTILOS = """
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #16181d; background: #fff;
    margin: 0; padding: 32px 40px; line-height: 1.5;
}
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 32px 0 10px; text-transform: uppercase;
     letter-spacing: .06em; color: #4a5160; border-bottom: 1px solid #d8dce4;
     padding-bottom: 6px; }
.meta { color: #6b7280; font-size: 13px; margin: 0 0 8px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 7px 10px; border-bottom: 1px solid #e5e7eb; text-align: left; }
th { background: #f4f6f9; font-weight: 600; }
/* Los importes se leen comparando: alineados a la derecha y con cifras de
   ancho fijo, un dígito de más salta a la vista. */
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.total td { font-weight: 700; background: #f4f6f9; }
.neg { color: #b42318; }
.aviso { margin-top: 28px; padding: 14px 16px; background: #fffaeb;
         border: 1px solid #f5d98a; border-radius: 8px; font-size: 12.5px; }
.aviso ul { margin: 6px 0 0; padding-left: 18px; }
.vacio { color: #6b7280; font-style: italic; font-size: 13px; }
.acciones { margin-bottom: 20px; }
button { font: inherit; padding: 8px 16px; border-radius: 8px;
         border: 1px solid #c7cdd8; background: #fff; cursor: pointer; }
@media print {
    /* Al imprimir sobra el botón y sobran los márgenes de pantalla; y una
       tabla partida por la mitad entre dos páginas no se puede contrastar. */
    body { padding: 0; }
    .acciones { display: none; }
    h2 { break-after: avoid; }
    tr { break-inside: avoid; }
}
"""


def _fila_html(celdas):
    return "<tr>" + "".join(celdas) + "</tr>"


def _num_html(valor):
    texto = _es(valor)
    clase = "num neg" if texto.startswith("-") else "num"
    return f'<td class="{clase}">{html.escape(texto)}</td>'


def a_html(informe, nonce=""):
    """Documento completo. `nonce` es el de la CSP de esta petición.

    El botón de imprimir se enlaza desde un `<script>` con nonce y no con un
    `onclick=`: la Content-Security-Policy de la aplicación no lleva
    'unsafe-inline' en script-src, así que un manejador en el atributo lo
    bloquearía el navegador y el botón no haría nada.
    """
    atributo_nonce = f' nonce="{html.escape(nonce)}"' if nonce else ""
    partes = [
        f"<title>{html.escape(TITULO)} — {informe['anio']}</title>",
        f"<style>{_ESTILOS}</style>",
        '<div class="acciones">'
        '<button type="button" id="botonImprimir">Imprimir o guardar como PDF</button>'
        "</div>"
        f"<script{atributo_nonce}>"
        'document.getElementById("botonImprimir").addEventListener("click", function () {'
        " window.print() });"
        "</script>",
        f"<h1>{html.escape(TITULO)}</h1>",
        f'<p class="meta">Ejercicio {html.escape(informe["anio"])} · '
        f'generado el {html.escape(informe["generado"])}</p>',
    ]

    # ── Detalle ──
    partes.append("<h2>Detalle de transmisiones</h2>")
    if informe["detalle"]:
        cabeceras = "".join(
            f'<th class="{"num" if clave not in ("fecha", "activo") else ""}">'
            f"{html.escape(etiqueta)}</th>"
            for clave, etiqueta in COLUMNAS_DETALLE
        )
        cuerpo = []
        for fila in informe["detalle"]:
            celdas = [
                f'<td>{html.escape(str(fila.get("fecha", "")))}</td>',
                f'<td>{html.escape(str(fila.get("activo", "")))}</td>',
                f'<td class="num">{html.escape(str(fila.get("cantidad", "")))}</td>',
            ]
            celdas += [_num_html(fila.get(clave))
                       for clave, _e in COLUMNAS_DETALLE[3:]]
            cuerpo.append(_fila_html(celdas))
        partes.append(
            f"<table><thead><tr>{cabeceras}</tr></thead>"
            f"<tbody>{''.join(cuerpo)}</tbody></table>"
        )
    else:
        partes.append('<p class="vacio">Sin transmisiones en este ejercicio.</p>')

    # ── Resumen ──
    partes.append("<h2>Resumen del ejercicio</h2>")
    filas_resumen = []
    for indice, (concepto, importe) in enumerate(informe["totales"]):
        clase = ' class="total"' if indice >= len(informe["totales"]) - 2 else ""
        signo = "num neg" if importe.startswith("-") else "num"
        filas_resumen.append(
            f"<tr{clase}><td>{html.escape(concepto)}</td>"
            f'<td class="{signo}">{html.escape(importe)}</td></tr>'
        )
    partes.append(f"<table><tbody>{''.join(filas_resumen)}</tbody></table>")

    # ── Regla de los dos meses ──
    partes.append("<h2>Regla de los dos meses (art. 33.5 LIRPF)</h2>")
    partes.append(
        "<table><tbody>"
        f"<tr><td>Pérdidas bloqueadas por recompra en este ejercicio</td>"
        f'<td class="num">{html.escape(informe["perdidasNoComputables"])}</td></tr>'
        f"<tr><td>Pérdidas bloqueadas en ejercicios anteriores ya integradas</td>"
        f'<td class="num">{html.escape(informe["perdidasDiferidasLiberadas"])}</td></tr>'
        "</tbody></table>"
    )

    # ── Arrastres ──
    partes.append("<h2>Saldos negativos pendientes de compensar (art. 49.1.b LIRPF)</h2>")
    if informe["arrastres"]:
        filas_arrastre = "".join(
            f'<tr><td>{html.escape(a["anioOrigen"])}</td>'
            f'<td class="num">{html.escape(_es(a["importe"]))}</td>'
            f'<td>{html.escape(a["ultimoEjercicio"])}</td></tr>'
            for a in informe["arrastres"]
        )
        partes.append(
            "<table><thead><tr><th>Ejercicio de origen</th>"
            '<th class="num">Importe pendiente</th>'
            "<th>Último ejercicio para aplicarlo</th></tr></thead>"
            f"<tbody>{filas_arrastre}</tbody></table>"
        )
    else:
        partes.append('<p class="vacio">No queda ningún saldo negativo pendiente.</p>')

    if informe["compensaciones"]:
        partes.append("<h2>Compensaciones aplicadas en este ejercicio</h2>")
        filas_comp = "".join(
            f'<tr><td>Saldo negativo de {html.escape(c["anioOrigen"])}</td>'
            f'<td class="num">{html.escape(_es(c["importe"]))}</td></tr>'
            for c in informe["compensaciones"]
        )
        partes.append(f"<table><tbody>{filas_comp}</tbody></table>")

    # ── Incidencias ──
    if informe["incidencias"]:
        partes.append("<h2>Filas excluidas del cálculo</h2>")
        filas_inc = "".join(
            f'<tr><td>{html.escape(str(f.get("fecha", "")))}</td>'
            f'<td>{html.escape(str(f.get("activo", "")))}</td>'
            f'<td>{html.escape(str(f.get("mensaje", "")))}</td></tr>'
            for f in informe["incidencias"]
        )
        partes.append(
            "<table><thead><tr><th>Fecha</th><th>Elemento patrimonial</th>"
            f"<th>Motivo</th></tr></thead><tbody>{filas_inc}</tbody></table>"
        )

    partes.append(
        '<div class="aviso"><strong>Antes de presentar:</strong><ul>'
        + "".join(f"<li>{html.escape(a)}</li>" for a in ADVERTENCIAS)
        + "</ul></div>"
    )

    return (
        '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        + "".join(partes[:2])
        + "</head><body>"
        + "".join(partes[2:])
        + "</body></html>"
    )
