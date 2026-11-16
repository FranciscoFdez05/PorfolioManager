"""Exportación de datos a CSV.

La generación vive en `core.exportar_csv` y el catálogo de módulos en
`stores.exportar_store`; la ruta solo une las dos cosas y responde el fichero.
"""

from flask import Blueprint, Response, request

from core.exportar_csv import generarCsv
from stores.exportar_store import prepararExportacion

exportarBp = Blueprint("exportar", __name__)


@exportarBp.route("/api/exportar/<modulo>.csv", methods=["GET"])
def exportarCsv(modulo: str):
    """Descarga un módulo en CSV; `?anio=` en los que se exportan por ejercicio."""
    nombreFichero, columnas, filas = prepararExportacion(modulo, request.args.get("anio"))
    return Response(
        generarCsv(columnas, filas),
        # charset explícito además del BOM: si el navegador decide el suyo, los
        # acentos se ven mal al abrirlo directamente en vez de descargarlo.
        mimetype="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f"attachment; filename={nombreFichero}",
            "Cache-Control": "no-store",
        },
    )
