"""Latencia por endpoint dentro del proceso (Flask test_client), sin red.

Aísla el coste de Python + SQLite de cada endpoint: sin sockets, sin servidor
WSGI y sin navegador. Importa la aplicación sobre una copia de los datos (ver
entorno.py), inicia sesión y repite cada GET N veces.

Uso:
    python perf/medir_backend.py [--iteraciones 200] [--perfil] [--json salida.json]

--perfil añade un cProfile de los endpoints más lentos (las 15 funciones con
más tiempo acumulado de cada uno).
"""

import argparse
import cProfile
import io
import json
import os
import pstats
import sqlite3
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import entorno

# GETs que la interfaz hace al cargar o al entrar en las páginas principales
# (medidos con medir_frontend.py). Quedan fuera los que salen a internet
# (/api/exchange-rate, refresh-market-data, /api/market/*): su tiempo es el del
# proveedor, no el de la aplicación.
ENDPOINTS = [
    "/api/activos",
    "/api/activos/{activo}",
    "/api/activos/rendimiento-batch",
    "/api/ventas",
    "/api/ventas/{year}",
    "/api/operaciones",
    "/api/transacciones",
    "/api/dividendos",
    "/api/intereses",
    "/api/gastos",
    "/api/gastos/{year}",
    "/api/ingresos",
    "/api/ingresos/{year}",
    "/api/cuentas",
    "/api/cuentas/saldos-mes?year={year}&month={mes}",
    "/api/transferencias",
    "/api/settings",
    "/api/portfolios",
    "/api/metricas/inversiones",
    "/api/portfolio/history?range=1M",
    "/api/portfolio/history?range=ALL",
    "/api/portfolio/history/by-type?range=1M",
    "/api/portfolio/history/by-type?range=ALL",
    "/api/portfolio/rentabilidad",
    "/api/bonos",
    "/api/rentafija",
    "/api/trading",
    "/api/staking",
    "/api/privatemarket",
    "/api/health",
    "/",
    "/js/core/app-core.js",
    "/css/components.css",
]

MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
         "septiembre", "octubre", "noviembre", "diciembre"]


def percentil(valores, p):
    orden = sorted(valores)
    k = (len(orden) - 1) * p / 100
    f = int(k)
    c = min(f + 1, len(orden) - 1)
    return orden[f] + (orden[c] - orden[f]) * (k - f)


# Recuento de sentencias SQL por petición (detección de N+1). Se envuelve
# sqlite3.connect antes de importar la aplicación; el callback solo cuenta
# cuando `contarSql["activo"]` está a True, así que no afecta a los tiempos.
contarSql = {"activo": False, "n": 0}
_conectarOriginal = sqlite3.connect


def _conectarConTraza(*args, **kwargs):
    conexion = _conectarOriginal(*args, **kwargs)

    def traza(_sentencia):
        if contarSql["activo"]:
            contarSql["n"] += 1

    conexion.set_trace_callback(traza)
    return conexion


sqlite3.connect = _conectarConTraza


def sentenciasPorPeticion(cliente, ruta, cabeceras):
    contarSql["n"] = 0
    contarSql["activo"] = True
    try:
        cliente.get(ruta, headers=cabeceras)
    finally:
        contarSql["activo"] = False
    return contarSql["n"]


def cargarApp(destino: Path):
    os.environ.update(entorno.variablesEntorno(destino, 5999))
    os.chdir(entorno.DIR_PYTHON)
    sys.path.insert(0, str(entorno.DIR_PYTHON))
    inicio = time.perf_counter()
    import server

    segundosImport = time.perf_counter() - inicio
    return server.app, segundosImport


def iniciarSesion(cliente):
    cliente.get("/login")
    respuesta = cliente.post("/login", data={"username": entorno.USUARIO, "password": entorno.CLAVE})
    assert respuesta.status_code in (200, 302), respuesta.status_code
    assert cliente.get("/api/activos").status_code == 200


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--iteraciones", type=int, default=200)
    parser.add_argument("--perfil", action="store_true")
    parser.add_argument("--json")
    parser.add_argument("--origen", default=str(entorno.RAIZ / "data"))
    args = parser.parse_args()

    destino = entorno.dirTemporal() / "backend"
    entorno.prepararDatos(Path(args.origen), destino)
    app, segundosImport = cargarApp(destino)
    cliente = app.test_client()
    iniciarSesion(cliente)

    activos = cliente.get("/api/activos").get_json()["assets"]
    # El activo con más filas: el caso más caro de /api/activos/<id>.
    activo = max(activos, key=lambda a: abs(float(a.get("invertidoNeto") or 0)))["id"]
    year = str(time.localtime().tm_year)
    mes = MESES[time.localtime().tm_mon - 1]

    cabeceras = {"Accept-Encoding": "gzip"}
    resultados = {}
    for plantilla in ENDPOINTS:
        ruta = plantilla.format(activo=activo, year=year, mes=mes)
        for _ in range(5):
            cliente.get(ruta, headers=cabeceras)
        tiempos = []
        tam = 0
        estado = None
        for _ in range(args.iteraciones):
            t0 = time.perf_counter()
            r = cliente.get(ruta, headers=cabeceras)
            tiempos.append((time.perf_counter() - t0) * 1000)
            estado = r.status_code
            tam = len(r.get_data())
        resultados[plantilla] = {
            "estado": estado,
            "bytes": tam,
            "p50": round(percentil(tiempos, 50), 3),
            "p95": round(percentil(tiempos, 95), 3),
            "p99": round(percentil(tiempos, 99), 3),
            "media": round(statistics.fmean(tiempos), 3),
            "sentenciasSql": sentenciasPorPeticion(cliente, ruta, cabeceras),
        }
        print(f"{plantilla:45s} {estado} p50={resultados[plantilla]['p50']:8.3f} ms "
              f"p95={resultados[plantilla]['p95']:8.3f} p99={resultados[plantilla]['p99']:8.3f} "
              f"bytes={tam} sql={resultados[plantilla]['sentenciasSql']}")

    perfiles = {}
    if args.perfil:
        masLentos = sorted(resultados, key=lambda k: -resultados[k]["p50"])[:6]
        for plantilla in masLentos:
            ruta = plantilla.format(activo=activo, year=year, mes=mes)
            perfil = cProfile.Profile()
            perfil.enable()
            for _ in range(50):
                cliente.get(ruta, headers=cabeceras)
            perfil.disable()
            salida = io.StringIO()
            pstats.Stats(perfil, stream=salida).sort_stats("cumulative").print_stats(15)
            perfiles[plantilla] = salida.getvalue()
            print(f"\n==== perfil {plantilla} (50 peticiones) ====")
            print(salida.getvalue())

    salidaJson = {"segundosImportApp": round(segundosImport, 3), "iteraciones": args.iteraciones,
                  "endpoints": resultados, "perfiles": perfiles}
    if args.json:
        Path(args.json).write_text(json.dumps(salidaJson, indent=2, ensure_ascii=False), "utf-8")
    # os._exit para no esperar a los hilos de los schedulers; antes, vaciar stdout.
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
