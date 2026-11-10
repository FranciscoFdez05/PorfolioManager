"""Genera las imágenes de cabecera de los avisos de Telegram.

    python tools/generar_imagenes_avisos.py

Deja un PNG por categoría y gravedad en `python/core/datos/avisos/`. Son ficheros
estáticos que van en el repositorio: la aplicación solo los sube a Telegram y no
necesita ninguna librería de imágenes para funcionar. Este script sí necesita
Playwright con Chromium, que no es dependencia del proyecto, y solo hay que
lanzarlo al cambiar una categoría, una gravedad o el diseño.

Los iconos son los de `img/icons/` (Lucide, licencia ISC).
"""

import logging
import sys
from html import escape
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

RAIZ = Path(__file__).resolve().parent.parent
ICONOS = RAIZ / "img" / "icons"
DESTINO = RAIZ / "python" / "core" / "datos" / "avisos"

ANCHO = 960
ALTO = 180

# Categoría -> (título, icono, color). «backupFichero» no está: sale como
# documento, y Telegram no admite una foto de cabecera en un documento.
CATEGORIAS = {
    "precios": ("Alerta de precio", "ajustes/grafico-linea.svg", "#38bdf8"),
    "movimientos": ("Caída o subida brusca", "ajustes/umbral.svg", "#fb7185"),
    "posicion": ("Tu posición", "ajustes/billete.svg", "#4ade80"),
    "cartera": ("Tu cartera", "ajustes/portfolio.svg", "#fbbf24"),
    "wallets": ("Wallets", "ajustes/moneda.svg", "#f59e0b"),
    "resumen": ("Resumen diario", "ajustes/grafico-barras.svg", "#a78bfa"),
    "proveedores": ("Proveedores", "ajustes/conexion.svg", "#22d3ee"),
    "backup": ("Copia de seguridad", "ajustes/zip.svg", "#818cf8"),
    "seguridad": ("Seguridad", "ajustes/escudo.svg", "#f472b6"),
    "sesion": ("Inicio de sesión", "general/usuario.svg", "#2dd4bf"),
    "sistema": ("Servidor", "ajustes/pulso.svg", "#94a3b8"),
    "version": ("Versión nueva", "general/subir.svg", "#a3e635"),
}

# Gravedad -> (etiqueta, color).
GRAVEDADES = {
    "correcto": ("Correcto", "#34d399"),
    "info": ("Información", "#60a5fa"),
    "aviso": ("Atención", "#fbbf24"),
    "critico": ("Crítico", "#f87171"),
}

log = logging.getLogger(__name__)


def _html(titulo: str, iconoSvg: str, colorCategoria: str, etiqueta: str, colorGravedad: str) -> str:
    """Compone la cabecera: icono y título de la categoría, y la gravedad."""
    return f"""<!doctype html><meta charset="utf-8"><style>
*{{box-sizing:border-box;margin:0}}
body{{width:{ANCHO}px;height:{ALTO}px;background:#0b1220;display:flex;align-items:center;gap:32px;
padding:0 48px 0 40px;border-left:16px solid {colorGravedad};
font-family:"Segoe UI",system-ui,sans-serif}}
.tile{{width:100px;height:100px;border-radius:24px;display:flex;align-items:center;justify-content:center;
background:{colorCategoria}26;border:2px solid {colorCategoria}66;color:{colorCategoria};flex-shrink:0}}
.tile svg{{width:56px;height:56px}}
.marca{{color:#64748b;font-size:22px;font-weight:600;letter-spacing:.04em;margin-bottom:4px}}
.titulo{{color:#f1f5f9;font-size:46px;font-weight:700;line-height:1.1}}
.texto{{flex:1;min-width:0}}
.gravedad{{padding:12px 26px;border-radius:999px;font-size:28px;font-weight:700;color:{colorGravedad};
background:{colorGravedad}22;border:2px solid {colorGravedad}66;white-space:nowrap}}
</style><div class="tile">{iconoSvg}</div>
<div class="texto"><div class="marca">PortfolioManager</div><div class="titulo">{escape(titulo)}</div></div>
<div class="gravedad">{escape(etiqueta)}</div>"""


def _generar(pagina: Page) -> int:
    """Escribe todas las combinaciones. Devuelve cuántas imágenes ha creado."""
    DESTINO.mkdir(parents=True, exist_ok=True)
    creadas = 0
    for categoria, (titulo, icono, colorCategoria) in CATEGORIAS.items():
        iconoSvg = (ICONOS / icono).read_text("utf-8")
        for gravedad, (etiqueta, colorGravedad) in GRAVEDADES.items():
            pagina.set_content(_html(titulo, iconoSvg, colorCategoria, etiqueta, colorGravedad))
            pagina.screenshot(path=str(DESTINO / f"{categoria}-{gravedad}.png"))
            creadas += 1
    return creadas


def main() -> int:
    """Punto de entrada. Devuelve el código de salida."""
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    with sync_playwright() as motor:
        navegador = motor.chromium.launch()
        try:
            pagina = navegador.new_page(viewport={"width": ANCHO, "height": ALTO})
            creadas = _generar(pagina)
        finally:
            navegador.close()
    log.info("%d imágenes en %s", creadas, DESTINO)
    return 0


if __name__ == "__main__":
    sys.exit(main())
