"""Peticiones al proveedor y tiempo de una carga de cotizaciones (P-04).

Simula lo que hace la interfaz al abrirse: un POST refresh-market-data por
activo con ticker, 4 a la vez (igual que refreshOverviewMarketData). Los
proveedores se sustituyen por un doble que cuenta llamadas y tarda
`--proveedorMs` (200 por defecto, la mediana medida contra Yahoo).

Tres escenarios sobre la misma copia de los datos:
  antes      sin parámetro (comportamiento anterior): siempre al proveedor
  despues    con `usarCache` (carga y refresco automáticos nuevos)
  boton      sin parámetro tras una carga con caché: el botón fuerza precio nuevo
Cada uno hace una carga en frío y una en caliente (segunda carga, dentro del TTL).

Uso:
    python perf/medir_cotizaciones_cache.py [--proveedorMs 200] [--json salida.json]
"""

import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import entorno
import medir_backend


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--proveedorMs", type=int, default=200)
    parser.add_argument("--json")
    parser.add_argument("--origen", default=str(entorno.RAIZ / "data"))
    args = parser.parse_args()

    destino = entorno.dirTemporal() / "cotizaciones"
    entorno.prepararDatos(Path(args.origen), destino)
    app, _segundos = medir_backend.cargarApp(destino)
    cliente = app.test_client()
    medir_backend.iniciarSesion(cliente)

    from stores import market_data

    activos = [a for a in cliente.get("/api/activos").get_json()["assets"]
               if str(a.get("marketSymbol") or a.get("finnhubSymbol") or "").strip()]
    divisas = {str(a.get("marketSymbol") or a.get("finnhubSymbol")).strip().upper(): a.get("currency") or "EUR"
               for a in activos}
    llamadas = {"n": 0}

    def proveedor(symbol):
        llamadas["n"] += 1
        time.sleep(args.proveedorMs / 1000)
        return {"symbol": symbol, "price": "10,00", "currency": divisas.get(symbol, "EUR"), "change": "+0,00%",
                "status": "ok", "lastUpdated": "2026-01-01T00:00:00", "marketData": {}}, None

    for nombre in list(market_data._FETCHERS):
        market_data._FETCHERS[nombre] = proveedor

    def cargar(cuerpo):
        llamadas["n"] = 0
        hilosCliente = [app.test_client() for _ in range(4)]
        for c in hilosCliente:
            medir_backend.iniciarSesion(c)

        def uno(par):
            c, activo = par
            cookie = c.get_cookie("csrf_token")
            cabeceras = {"X-CSRF-Token": cookie.value if cookie else ""}
            return c.post(f"/api/activos/{activo['id']}/refresh-market-data", json=cuerpo,
                          headers=cabeceras).status_code

        pares = [(hilosCliente[i % 4], a) for i, a in enumerate(activos)]
        t0 = time.perf_counter()
        with ThreadPoolExecutor(max_workers=4) as pool:
            estados = list(pool.map(uno, pares))
        return {"segundos": round(time.perf_counter() - t0, 2), "llamadasProveedor": llamadas["n"],
                "errores": sum(1 for e in estados if e != 200)}

    resultados = {"activosConTicker": len(activos), "proveedorMs": args.proveedorMs}
    market_data._quoteCache.clear()
    resultados["antes"] = {"frio": cargar(None), "caliente": cargar(None)}
    market_data._quoteCache.clear()
    resultados["despues"] = {"frio": cargar({"usarCache": True}), "caliente": cargar({"usarCache": True})}
    resultados["boton"] = {"trasCarga": cargar(None)}
    print(json.dumps(resultados, indent=2), flush=True)
    if args.json:
        Path(args.json).write_text(json.dumps(resultados, indent=2), "utf-8")
    os._exit(0)


if __name__ == "__main__":
    main()
