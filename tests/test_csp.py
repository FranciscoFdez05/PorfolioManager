"""Content-Security-Policy y procedencia de los scripts que carga index.html.

La política es una cadena larga y silenciosa: si una directiva se queda corta,
el navegador bloquea el recurso y solo se ve en la consola. Y al revés —si se
abre de más— no se nota nada en absoluto, que es el caso peligroso. Por eso
aquí se afirma el contenido exacto.

La segunda sección vigila algo que la política sola no puede: que index.html no
vuelva a cargar una librería desde un CDN. Es una regresión de una sola línea,
fácil de introducir copiando un snippet de la documentación de cualquier
librería, y reabre a la vez el `script-src` y la dependencia de internet.
"""

import re
from pathlib import Path

from core import csp, settings

RAIZ = Path(__file__).resolve().parent.parent


def _directivas(politica):
    """La cabecera como dict {nombre: [valores]}, para afirmar sin depender del orden."""
    salida = {}
    for trozo in politica.split(";"):
        partes = trozo.split()
        if partes:
            salida[partes[0]] = partes[1:]
    return salida


# ── La política ───────────────────────────────────────────────────────────────

def testScriptSrcEstaCerradoASelf():
    """El motivo de vendorizar Chart.js: ningún dominio externo en script-src.

    Si alguien vuelve a añadir un CDN a `csp_origenes_scripts`, este test lo
    dice. Es el ajuste que más fácil se relaja "solo para probar una cosa".
    """
    assert list(settings.cspOrigenesScripts()) == []
    assert _directivas(csp.construir())["script-src"] == ["'self'"]


def testScriptSrcNoAdmiteUnsafeInline():
    """Con 'unsafe-inline' la directiva no protegería de nada, que es el fallo a cubrir."""
    assert "'unsafe-inline'" not in _directivas(csp.construir())["script-src"]
    assert "'unsafe-inline'" not in _directivas(csp.construir("abc123"))["script-src"]


def testElNonceEntraEnScriptSrc():
    directiva = _directivas(csp.construir("abc123"))["script-src"]
    assert "'nonce-abc123'" in directiva
    assert "'self'" in directiva


def testSinNonceNoApareceLaPalabraNonce():
    """Un `nonce-` vacío invalidaría la directiva entera en algunos navegadores."""
    assert "nonce" not in csp.construir()


def testOrigenesExtraConfiguradosSeRespetan(monkeypatch):
    """El ajuste sigue siendo útil para quien añada una librería externa a conciencia."""
    monkeypatch.setattr(settings, "cspOrigenesScripts", lambda: ["https://ejemplo.test"])
    assert _directivas(csp.construir())["script-src"] == ["'self'", "https://ejemplo.test"]


def testDirectivasDeCierre():
    """Las que impiden inyección de base, formularios y plugins."""
    directivas = _directivas(csp.construir())
    assert directivas["object-src"] == ["'none'"]
    assert directivas["base-uri"] == ["'self'"]
    assert directivas["form-action"] == ["'self'"]
    assert directivas["frame-ancestors"] == ["'self'"]
    assert directivas["default-src"] == ["'self'"]


def testFrameSrcPermiteTradingview():
    """El modal de gráfico incrusta widgetembed; sin esto el iframe sale en blanco.

    El síntoma es engañoso —el navegador pinta su propia página de "contenido
    bloqueado", sin decir que la culpa es de la CSP— así que la directiva se
    afirma aquí para que nadie la borre por parecer de más.
    """
    directiva = _directivas(csp.construir())["frame-src"]
    assert "https://www.tradingview.com" in directiva
    assert directiva[0] == "'self'"


def testFrameSrcNoSeAbreACualquiera():
    """Una lista cerrada: el comodín dejaría incrustar cualquier página."""
    directiva = _directivas(csp.construir())["frame-src"]
    assert "*" not in directiva
    assert all(o == "'self'" or o.startswith("https://") for o in directiva)


def testConnectSrcSoloSelf():
    """El navegador solo habla con /api/; a los proveedores sale el servidor."""
    assert _directivas(csp.construir())["connect-src"] == ["'self'"]


def testConnectSrcAdmiteElPuertoDeComprobacionDelCertificado():
    """La única excepción, y se calcula por petición.

    El panel de HTTPS pide esa página para averiguar si **este** navegador se
    fía del certificado, que es lo que el servidor no puede contestar. Sin la
    directiva, la CSP la bloquea y el navegador no dice por qué: parecería que
    el certificado falla cuando lo que ha fallado es la política.
    """
    directiva = _directivas(csp.construir("", ("https://192.168.1.163:9443",)))["connect-src"]

    assert directiva == ["'self'", "https://192.168.1.163:9443"]


def testConnectSrcNoSeAbreACualquiera():
    """Lo que se añade es un host concreto, nunca un comodín: la excepción es
    para el propio servidor, no para la red."""
    directiva = _directivas(csp.construir("", ("https://192.168.1.163:9443",)))["connect-src"]

    assert "*" not in directiva
    assert all(o == "'self'" or o.startswith("https://") for o in directiva)


def testLosNoncesNoSeRepiten():
    assert len({csp.generarNonce() for _ in range(50)}) == 50


def testInsertarNonceSustituyeElMarcador():
    assert csp.insertarNonce("<script nonce='__CSP_NONCE__'>", "xyz") == "<script nonce='xyz'>"


def testInsertarNonceSinMarcadorDevuelveElHtmlIntacto():
    """Preferible a reventar la petición entera: la página funciona salvo el script de tema."""
    assert csp.insertarNonce("<html></html>", "xyz") == "<html></html>"


# ── Procedencia de los scripts ────────────────────────────────────────────────

def testIndexNoCargaScriptsDeNingunDominioExterno():
    html = (RAIZ / "index.html").read_text("utf-8")
    externos = re.findall(r'<script[^>]+src="(https?://[^"]+)"', html)
    assert externos == [], f"index.html carga scripts externos: {externos}"


def testIndexCargaChartjsDesdeVendor():
    html = (RAIZ / "index.html").read_text("utf-8")
    assert "js/vendor/chart.umd.min.js" in html


def testChartjsVendorizadoExisteYEsLaVersionDocumentada():
    """Que el fichero, el README y el `?v=` de index.html no se separen.

    Al actualizar la librería es fácil cambiar el fichero y olvidar el resto:
    el `?v=` obsoleto deja a los navegadores con la versión antigua en caché.
    """
    fichero = RAIZ / "js" / "vendor" / "chart.umd.min.js"
    assert fichero.exists(), "js/vendor/chart.umd.min.js no está en el repositorio"

    contenido = fichero.read_text("utf-8", errors="ignore")
    version = re.search(r"Chart\.js v([0-9]+\.[0-9]+\.[0-9]+)", contenido)
    assert version, "no se pudo leer la versión del propio fichero de Chart.js"
    version = version.group(1)

    readme = (RAIZ / "js" / "vendor" / "README.md").read_text("utf-8")
    assert version in readme, f"js/vendor/README.md no menciona la versión {version}"

    html = (RAIZ / "index.html").read_text("utf-8")
    assert f"chart.umd.min.js?v={version}" in html, (
        f"index.html no pide ?v={version}; los navegadores servirán la copia antigua"
    )


def testSoloLasLibreriasDeTercerosLlevanCacheBusting():
    """El `?v=` a mano se quedó únicamente donde sirve para algo.

    El servidor manda el código propio con `Cache-Control: no-store`, así que
    los 48 `?v=20260813a` repartidos por las etiquetas no invalidaban nada: solo
    eran 48 cadenas que había que acordarse de subir a mano en cada cambio.
    En `js/vendor/` sí cuenta, porque esos ficheros se cachean un año y la
    versión de la URL es lo único que distingue una de otra.
    """
    html = (RAIZ / "index.html").read_text("utf-8")

    conVersion = re.findall(r'(?:href|src)="([^"]+?)\?v=[^"]*"', html)

    ajenos = [ruta for ruta in conVersion if not ruta.startswith("js/vendor/")]
    assert not ajenos, (
        f"estas rutas llevan ?v= y se sirven con no-store, así que no hace nada: {ajenos}"
    )
