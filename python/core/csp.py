"""Content-Security-Policy de la aplicación.

Aparte para poder probarla sin levantar el servidor: la política es una cadena
larga y silenciosa —si una directiva se queda corta, el navegador bloquea el
recurso y solo se ve en la consola—, así que conviene poder afirmar en un test
qué contiene exactamente.

Decisiones que no son obvias:

* **script-src con nonce, no 'unsafe-inline'.** index.html lleva un único script
  en línea (el que aplica el tema guardado antes de pintar, para que no haya
  destello blanco al cargar). Con 'unsafe-inline' la directiva no protegería de
  nada, que es justo el fallo que se quiere cubrir. `serveIndex` sustituye el
  marcador por el nonce de la petición.
* **style-src sí admite 'unsafe-inline'.** El HTML usa atributos `style=` en
  una docena de sitios y varios módulos de JS escriben `el.style.…` para
  posicionar tooltips y menús flotantes. Quitarlo exigiría reescribir eso, y el
  riesgo que cubre (exfiltración por CSS) es mucho menor que el de un script.
* **connect-src 'self'.** Todas las llamadas a proveedores de mercado las hace
  el servidor; el navegador solo habla con /api/. Si alguna vez el frontend
  llamara directamente a una API externa, esta directiva lo delataría.
* **frame-ancestors 'self'** duplica X-Frame-Options a propósito: la cabecera
  antigua la ignoran los navegadores modernos cuando hay CSP, y la nueva no la
  entienden los muy viejos.
"""

import secrets

from core import settings

_MARCADOR_NONCE = "__CSP_NONCE__"


def generar_nonce() -> str:
    return secrets.token_urlsafe(16)


def construir(nonce: str = "") -> str:
    """Cadena de la cabecera Content-Security-Policy."""
    origenes_script = ["'self'", *[o for o in settings.cspOrigenesScripts() if o]]
    if nonce:
        origenes_script.append(f"'nonce-{nonce}'")

    directivas = [
        ("default-src", ["'self'"]),
        ("script-src", origenes_script),
        ("style-src", ["'self'", "'unsafe-inline'"]),
        # blob: lo necesitan las descargas de CSV/JSON que genera el frontend.
        ("img-src", ["'self'", "data:", "blob:"]),
        ("font-src", ["'self'"]),
        ("connect-src", ["'self'"]),
        ("object-src", ["'none'"]),
        ("base-uri", ["'self'"]),
        ("form-action", ["'self'"]),
        ("frame-ancestors", ["'self'"]),
    ]
    return "; ".join(f"{nombre} {' '.join(valores)}" for nombre, valores in directivas)


def insertar_nonce(html: str, nonce: str) -> str:
    """Rellena el marcador de nonce de index.html.

    Si el marcador no está (index.html editado a mano, o servido desde una copia
    antigua) se devuelve el HTML tal cual: la página seguirá funcionando salvo
    por el script de tema en línea, que el navegador bloqueará. Es preferible a
    reventar la petición entera.
    """
    return html.replace(_MARCADOR_NONCE, nonce)
