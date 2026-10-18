"""Carga de la interfaz en Chromium (Playwright) sobre una instancia aislada.

Mide, en frío (sin caché) y en caliente (recarga con caché):
  - número de peticiones y bytes transferidos (comprimidos) y descomprimidos
  - DOMContentLoaded, load y momento en que la red queda en reposo
  - las llamadas a /api/ que hace cada página al entrar en ella

Proveedor de cotizaciones simulado: al abrir, la interfaz pide una cotización
nueva por activo (POST /api/activos/<id>/refresh-market-data), y el servidor la
pide a Yahoo/Finnhub. Medir contra el proveedor real da números que dependen de
su latencia del momento y gasta cuota desde la IP del usuario en cada
repetición. Aquí esas peticiones se responden desde el navegador con el activo
tal como está en la BD y tras un retardo fijo (--proveedorMs, por defecto 200,
la mediana medida contra Yahoo). /api/exchange-rate (una llamada por carga)
sigue yendo al servidor. Con --proveedorReal se usan los proveedores de verdad.

Uso:
    python perf/medir_frontend.py [--repeticiones 5] [--latencia 40] [--json salida.json]
"""

import argparse
import asyncio
import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from entorno import CLAVE, USUARIO, Instancia

PAGINAS = [
    "vistaGeneral", "activos", "metricas", "dividendos", "gastos", "ingresos",
    "cuentas", "ventas", "paneles", "heatmap", "calendario", "seguimiento",
]


def recogerRed(pagina):
    registro = []

    async def alTerminar(req):
        try:
            tam = await req.sizes()
        except Exception:
            tam = {}
        registro.append({
            "url": req.url,
            "tipo": req.resource_type,
            "bytesRed": tam.get("responseBodySize", 0) + tam.get("responseHeadersSize", 0),
            "duracionMs": req.timing.get("responseEnd", -1),
        })

    pagina.on("requestfinished", alTerminar)
    return registro


# Se envuelve window.fetch en vez de usar contexto.route(): Playwright desactiva
# la caché HTTP del navegador en cuanto hay una ruta interceptada, y entonces la
# recarga "en caliente" volvería a descargarlo todo. La cotización simulada pide
# el activo con ?perfSimulado=1 para poder contarla aparte (ver rutaNormalizada).
_PROVEEDOR_SIMULADO = r"""(() => {
    const original = window.fetch.bind(window);
    const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
    window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        const m = url.match(/\/api\/activos\/([^/?]+)\/refresh-market-data/);
        if (!m) return original(input, init);
        const r = await original(`/api/activos/${m[1]}?perfSimulado=1`);
        const activo = await r.json();
        await esperar(RETARDO);
        return new Response(JSON.stringify({ok: true, asset: activo, marketData: {}, alertasSaltadas: 0}),
                            {status: 200, headers: {"Content-Type": "application/json"}});
    };
})();"""


async def instalarProveedorSimulado(contexto, retardoMs):
    await contexto.add_init_script(_PROVEEDOR_SIMULADO.replace("RETARDO", str(int(retardoMs))))


async def tiemposNavegacion(pagina):
    return await pagina.evaluate("""() => {
        const n = performance.getEntriesByType('navigation')[0];
        return {dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd};
    }""")


async def resumenRecursos(pagina):
    """Resource Timing: bytes reales por red (0 si salió de caché) y fin de la cascada."""
    return await pagina.evaluate("""() => {
        const rs = performance.getEntriesByType('resource');
        const est = rs.filter(r => r.initiatorType === 'script' || r.initiatorType === 'link');
        const api = rs.filter(r => r.name.includes('/api/'));
        return {
            bytesRed: rs.reduce((a, r) => a + (r.transferSize || 0), 0),
            bytesDescomprimidos: rs.reduce((a, r) => a + (r.decodedBodySize || 0), 0),
            desdeCache: rs.filter(r => r.transferSize === 0).length,
            finEstaticosMs: Math.round(Math.max(0, ...est.map(r => r.responseEnd))),
            finApiMs: Math.round(Math.max(0, ...api.map(r => r.responseEnd))),
        };
    }""")


async def emularRed(contexto, pagina, latenciaMs):
    """Latencia y ancho de banda de un acceso remoto (móvil, VPN), vía CDP."""
    if not latenciaMs:
        return
    cdp = await contexto.new_cdp_session(pagina)
    await cdp.send("Network.enable")
    await cdp.send("Network.emulateNetworkConditions", {
        "offline": False,
        "latency": latenciaMs,
        "downloadThroughput": 20 * 1024 * 1024 / 8,
        "uploadThroughput": 5 * 1024 * 1024 / 8,
    })


async def cargar(contexto, baseUrl, latenciaMs=0):
    pagina = await contexto.new_page()
    await emularRed(contexto, pagina, latenciaMs)
    registro = recogerRed(pagina)
    inicio = time.perf_counter()
    await pagina.goto(baseUrl + "/", wait_until="load")
    await pagina.wait_for_load_state("networkidle")
    reposoMs = (time.perf_counter() - inicio) * 1000
    tiempos = await tiemposNavegacion(pagina)
    recursos = await resumenRecursos(pagina)
    return pagina, registro, {
        "peticiones": len(registro),
        "bytesTransferidos": recursos["bytesRed"],
        "bytesDescomprimidos": recursos["bytesDescomprimidos"],
        "recursosDesdeCache": recursos["desdeCache"],
        "finEstaticosMs": recursos["finEstaticosMs"],
        "finApiMs": recursos["finApiMs"],
        "domContentLoadedMs": tiempos["dcl"],
        "loadMs": tiempos["load"],
        "redEnReposoMs": reposoMs,
        "porTipo": porTipo(registro),
        "apiPorRuta": apiPorRuta(registro),
    }


def rutaNormalizada(url):
    if "perfSimulado=1" in url:
        return "/api/activos/<id>/refresh-market-data (simulado)"
    ruta = "/" + url.split("//", 1)[-1].split("/", 1)[-1].split("?", 1)[0]
    partes = ruta.split("/")
    # /api/activos/<id> y /api/<x>/<año>: se agrupan para ver el patrón N+1.
    if len(partes) == 4 and partes[2] == "activos" and partes[3] not in ("reorder", "rendimiento-batch"):
        return "/api/activos/<id>"
    if len(partes) == 5 and partes[2] == "activos":
        return f"/api/activos/<id>/{partes[4]}"
    if len(partes) == 4 and partes[3].isdigit():
        return f"/api/{partes[2]}/<year>"
    return ruta


def apiPorRuta(registro):
    rutas = {}
    for r in registro:
        if "/api/" not in r["url"]:
            continue
        ruta = rutaNormalizada(r["url"])
        d = rutas.setdefault(ruta, {"n": 0, "msMax": 0.0, "bytes": 0})
        d["n"] += 1
        d["msMax"] = round(max(d["msMax"], r["duracionMs"]), 1)
        d["bytes"] += r["bytesRed"]
    return dict(sorted(rutas.items(), key=lambda kv: -kv[1]["n"]))


def porTipo(registro):
    tipos = {}
    for r in registro:
        t = tipos.setdefault(r["tipo"], {"n": 0, "bytes": 0})
        t["n"] += 1
        t["bytes"] += r["bytesRed"]
    return tipos


async def iniciarSesion(contexto, baseUrl):
    """Login por la API del contexto, sin navegar.

    Entrar por el formulario redirige a / y esa redirección ya descarga todos
    los JS y CSS: la primera carga "medida" saldría de caché y no sería fría.
    """
    peticiones = contexto.request
    await peticiones.get(baseUrl + "/login")
    csrf = next((c["value"] for c in await contexto.cookies() if c["name"] == "csrf_token"), "")
    respuesta = await peticiones.post(baseUrl + "/login", form={"username": USUARIO, "password": CLAVE},
                                      headers={"X-CSRF-Token": csrf}, max_redirects=0)
    if respuesta.status >= 400:
        raise RuntimeError(f"Login fallido: {respuesta.status}")
    comprobacion = await peticiones.get(baseUrl + "/api/activos")
    if comprobacion.status != 200:
        raise RuntimeError(f"Login sin efecto: /api/activos devuelve {comprobacion.status}")


async def medirPaginas(pagina, registro):
    resultado = {}
    for nombre in PAGINAS:
        registro.clear()
        inicio = time.perf_counter()
        await pagina.evaluate(f"document.querySelector('[data-page={nombre}]')?.click()")
        try:
            await pagina.wait_for_load_state("networkidle", timeout=15000)
        except Exception:
            pass
        await pagina.wait_for_timeout(300)
        transcurridoMs = (time.perf_counter() - inicio) * 1000
        resultado[nombre] = {"msHastaReposo": round(transcurridoMs), "api": apiPorRuta(registro)}
    return resultado


def mediana(valores):
    return round(statistics.median(valores), 1)


def resumen(muestras):
    return {
        "peticiones": muestras[0]["peticiones"],
        "bytesTransferidos": int(statistics.median(m["bytesTransferidos"] for m in muestras)),
        "bytesDescomprimidos": int(statistics.median(m["bytesDescomprimidos"] for m in muestras)),
        "recursosDesdeCache": muestras[0]["recursosDesdeCache"],
        "domContentLoadedMs": mediana([m["domContentLoadedMs"] for m in muestras]),
        "loadMs": mediana([m["loadMs"] for m in muestras]),
        "finEstaticosMs": mediana([m["finEstaticosMs"] for m in muestras]),
        "finApiMs": mediana([m["finApiMs"] for m in muestras]),
        "redEnReposoMs": mediana([m["redEnReposoMs"] for m in muestras]),
        "redEnReposoMinMax": [round(min(m["redEnReposoMs"] for m in muestras)),
                              round(max(m["redEnReposoMs"] for m in muestras))],
        "porTipo": muestras[0]["porTipo"],
        "apiPorRuta": muestras[0]["apiPorRuta"],
    }


async def medir(args):
    from playwright.async_api import async_playwright

    with Instancia(servidor=args.servidor) as inst:
        async with async_playwright() as pw:
            navegador = await pw.chromium.launch()
            frias, calientes = [], []
            paginas = None
            for i in range(args.repeticiones):
                contexto = await navegador.new_context(viewport={"width": 1440, "height": 900})
                if not args.proveedorReal:
                    await instalarProveedorSimulado(contexto, args.proveedorMs)
                await iniciarSesion(contexto, inst.baseUrl)
                pagina, registro, fria = await cargar(contexto, inst.baseUrl, args.latencia)
                frias.append(fria)
                await pagina.close()
                # Recarga con la caché del contexto ya poblada.
                pagina, registro, caliente = await cargar(contexto, inst.baseUrl, args.latencia)
                calientes.append(caliente)
                if i == 0:
                    paginas = await medirPaginas(pagina, registro)
                await contexto.close()
            await navegador.close()
    return frias, calientes, paginas


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeticiones", type=int, default=5)
    parser.add_argument("--json")
    parser.add_argument("--servidor", default=None)
    parser.add_argument("--latencia", type=int, default=0,
                        help="ms de latencia emulada por petición (0 = red local)")
    parser.add_argument("--proveedorMs", type=int, default=200)
    parser.add_argument("--proveedorReal", action="store_true")
    args = parser.parse_args()

    frias, calientes, paginas = asyncio.run(medir(args))
    salida = {
        "latenciaEmuladaMs": args.latencia,
        "proveedor": "real" if args.proveedorReal else f"simulado {args.proveedorMs} ms",
        "repeticiones": args.repeticiones,
        "fria": resumen(frias),
        "caliente": resumen(calientes),
        "paginas": paginas,
    }
    texto = json.dumps(salida, indent=2, ensure_ascii=False)
    print(texto)
    if args.json:
        Path(args.json).write_text(texto, "utf-8")


if __name__ == "__main__":
    main()
