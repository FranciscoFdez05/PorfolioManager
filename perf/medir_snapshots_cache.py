"""Antes/después de la caché de snapshots (P-05) dentro del mismo proceso.

Mide `history?range=ALL` y `rentabilidad` (sin y con punto vivo) con la caché
activa y con la caché anulada (la huella cambia en cada llamada, así que cada
petición lee y calcula todo, como antes). Secuencial y con 8 clientes a la vez
(hilos sobre el cliente de pruebas de Flask: mide el coste de CPU del servidor,
no la red).

Uso:
    python perf/medir_snapshots_cache.py [--iteraciones 40] [--json salida.json]
"""

import argparse
import itertools
import json
import os
import statistics
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import entorno
import medir_backend

RUTAS = {
    "history ALL": "/api/portfolio/history?range=ALL",
    "rentabilidad sin vivo": "/api/portfolio/rentabilidad",
    "rentabilidad con vivo": "/api/portfolio/rentabilidad?value=250000.00&invested=200000.00",
}


def percentil(valores, p):
    return medir_backend.percentil(valores, p)


def secuencial(app, ruta, n):
    cliente = app.test_client()
    medir_backend.iniciarSesion(cliente)
    for _ in range(3):
        cliente.get(ruta)
    tiempos = []
    for _ in range(n):
        t0 = time.perf_counter()
        cliente.get(ruta)
        tiempos.append((time.perf_counter() - t0) * 1000)
    return tiempos


def concurrente(app, ruta, clientes, n):
    tiempos = []
    candado = threading.Lock()

    def trabajo():
        cliente = app.test_client()
        medir_backend.iniciarSesion(cliente)
        cliente.get(ruta)
        locales = []
        for _ in range(n):
            t0 = time.perf_counter()
            cliente.get(ruta)
            locales.append((time.perf_counter() - t0) * 1000)
        with candado:
            tiempos.extend(locales)

    hilos = [threading.Thread(target=trabajo) for _ in range(clientes)]
    for hilo in hilos:
        hilo.start()
    for hilo in hilos:
        hilo.join()
    return tiempos


def resumen(tiempos):
    return {"p50": round(percentil(tiempos, 50), 2), "p95": round(percentil(tiempos, 95), 2),
            "media": round(statistics.fmean(tiempos), 2)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--iteraciones", type=int, default=40)
    parser.add_argument("--json")
    parser.add_argument("--origen", default=str(entorno.RAIZ / "data"))
    args = parser.parse_args()

    destino = entorno.dirTemporal() / "snapshots"
    entorno.prepararDatos(Path(args.origen), destino)
    app, _segundos = medir_backend.cargarApp(destino)

    from stores import historico_snapshots

    huellaOriginal = historico_snapshots._huella
    contador = itertools.count()
    resultados = {}
    for modo in ("sinCache", "conCache"):
        if modo == "sinCache":
            historico_snapshots._huella = lambda conn: (next(contador),)
        else:
            historico_snapshots._huella = huellaOriginal
        historico_snapshots.invalidar()
        for nombre, ruta in RUTAS.items():
            resultados.setdefault(nombre, {})[modo] = {
                "secuencial": resumen(secuencial(app, ruta, args.iteraciones)),
                "8 clientes": resumen(concurrente(app, ruta, 8, max(5, args.iteraciones // 4))),
            }
            print(nombre, modo, resultados[nombre][modo], flush=True)

    if args.json:
        Path(args.json).write_text(json.dumps(resultados, indent=2, ensure_ascii=False), "utf-8")
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
