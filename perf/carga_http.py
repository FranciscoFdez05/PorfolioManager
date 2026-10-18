"""Prueba de carga HTTP contra una instancia aislada (solo stdlib).

Arranca la aplicación con un servidor WSGI multihilo (waitress en Windows,
gunicorn gthread como en entrypoint.sh en Linux), inicia sesión y lanza C
clientes concurrentes con conexión persistente durante D segundos por
escenario. Mide latencia p50/p95/p99, peticiones por segundo, errores, tiempo
de arranque y memoria (RSS) del servidor antes y después de la carga.

Escenarios:
  - carga-inicial: la mezcla de GETs que hace la interfaz al abrirse, con los
    pesos medidos por medir_frontend.py (sin las llamadas que salen a internet).
  - historico: los endpoints de evolución y rentabilidad de Métricas.
  - estaticos: JS y CSS propios con revalidación (If-None-Match -> 304) y sin ella.

Uso:
    python perf/carga_http.py [--segundos 15] [--concurrencia 1,8] [--json salida.json]
"""

import argparse
import http.client
import json
import random
import statistics
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from entorno import Instancia

try:
    import psutil
except ImportError:  # psutil es opcional: sin él no hay medida de memoria.
    psutil = None


def escenarios(activos, year):
    activo = activos[0]
    cargaInicial = [
        ("/api/activos/{a}", 167),
        ("/api/activos", 6),
        ("/api/ventas", 5),
        ("/api/transacciones", 2),
        ("/api/operaciones", 2),
        ("/api/bonos", 2),
        ("/api/rentafija", 2),
        ("/api/intereses", 2),
        ("/api/trading", 2),
        ("/api/staking", 2),
        ("/api/privatemarket", 2),
        ("/api/dividendos", 2),
        (f"/api/ingresos/{year}", 2),
        (f"/api/gastos/{year}", 2),
        ("/api/settings", 1),
        ("/api/portfolios", 1),
    ]
    historico = [
        ("/api/portfolio/history?range=1M", 1),
        ("/api/portfolio/history?range=ALL", 1),
        ("/api/portfolio/history/by-type?range=1M", 1),
        ("/api/portfolio/history/by-type?range=ALL", 1),
        ("/api/portfolio/rentabilidad", 1),
    ]
    estaticos = [
        ("/", 1),
        ("/js/core/app-core.js", 1),
        ("/js/cartera/assets.js", 1),
        ("/css/components.css", 1),
        ("/css/base.css", 1),
    ]
    return {
        "carga-inicial": ([(r.replace("{a}", "{activo}"), p) for r, p in cargaInicial], activos),
        "historico": (historico, [activo]),
        "estaticos": (estaticos, [activo]),
    }


def percentil(valores, p):
    if not valores:
        return 0.0
    orden = sorted(valores)
    k = (len(orden) - 1) * p / 100
    f = int(k)
    c = min(f + 1, len(orden) - 1)
    return orden[f] + (orden[c] - orden[f]) * (k - f)


def cliente(puerto, cookie, rutas, pesos, activos, finEn, tiempos, errores, revalidar, etags):
    conexion = http.client.HTTPConnection("127.0.0.1", puerto, timeout=60)
    azar = random.Random(threading.get_ident())
    while time.perf_counter() < finEn:
        ruta = azar.choices(rutas, pesos)[0].replace("{activo}", azar.choice(activos))
        cabeceras = {"Cookie": cookie, "Accept-Encoding": "gzip"}
        if revalidar and ruta in etags:
            cabeceras["If-None-Match"] = etags[ruta]
        t0 = time.perf_counter()
        try:
            conexion.request("GET", ruta, headers=cabeceras)
            resp = conexion.getresponse()
            resp.read()
            ms = (time.perf_counter() - t0) * 1000
            if resp.status >= 400:
                errores.append(resp.status)
            else:
                tiempos.append(ms)
                etag = resp.getheader("ETag")
                if etag:
                    etags[ruta] = etag
        except Exception as error:
            errores.append(type(error).__name__)
            conexion.close()
            conexion = http.client.HTTPConnection("127.0.0.1", puerto, timeout=60)
    conexion.close()


def rssMb(proc):
    if psutil is None:
        return None
    try:
        p = psutil.Process(proc.pid)
        total = p.memory_info().rss + sum(h.memory_info().rss for h in p.children(recursive=True))
        return round(total / 1024 / 1024, 1)
    except Exception:
        return None


def ejecutar(inst, cookie, nombre, rutasPesos, activos, concurrencia, segundos, revalidar=False):
    rutas = [r for r, _ in rutasPesos]
    pesos = [p for _, p in rutasPesos]
    tiempos, errores, etags = [], [], {}
    # Calentamiento corto para que las conexiones y cachés estén abiertas.
    calentar = time.perf_counter() + 1.0
    cliente(inst.puerto, cookie, rutas, pesos, activos, calentar, [], [], revalidar, etags)
    finEn = time.perf_counter() + segundos
    hilos = [threading.Thread(target=cliente, args=(inst.puerto, cookie, rutas, pesos, activos, finEn,
                                                      tiempos, errores, revalidar, etags))
             for _ in range(concurrencia)]
    inicio = time.perf_counter()
    for h in hilos:
        h.start()
    for h in hilos:
        h.join()
    duracion = time.perf_counter() - inicio
    return {
        "escenario": nombre + ("-304" if revalidar else ""),
        "concurrencia": concurrencia,
        "peticiones": len(tiempos),
        "errores": len(errores),
        "rps": round(len(tiempos) / duracion, 1),
        "p50": round(percentil(tiempos, 50), 2),
        "p95": round(percentil(tiempos, 95), 2),
        "p99": round(percentil(tiempos, 99), 2),
        "media": round(statistics.fmean(tiempos), 2) if tiempos else 0,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--segundos", type=float, default=15)
    parser.add_argument("--concurrencia", default="1,8")
    parser.add_argument("--servidor", default=None)
    parser.add_argument("--hilos", type=int, default=8)
    parser.add_argument("--json")
    args = parser.parse_args()
    niveles = [int(n) for n in args.concurrencia.split(",")]

    with Instancia(servidor=args.servidor, hilos=args.hilos) as inst:
        sesion = inst.sesion()
        cookie = "; ".join(f"{c.name}={c.value}" for c in sesion.cookies)
        _, cuerpo, _ = sesion.get("/api/activos")
        activos = [a["id"] for a in json.loads(cuerpo)["assets"]]
        year = str(time.localtime().tm_year)
        memoriaArranque = rssMb(inst.proc)

        resultados = []
        for nombre, (rutasPesos, ids) in escenarios(activos, year).items():
            for c in niveles:
                resultados.append(ejecutar(inst, cookie, nombre, rutasPesos, ids, c, args.segundos))
                print(json.dumps(resultados[-1]), flush=True)
                if nombre == "estaticos":
                    resultados.append(ejecutar(inst, cookie, nombre, rutasPesos, ids, c, args.segundos, True))
                    print(json.dumps(resultados[-1]), flush=True)
        memoriaFinal = rssMb(inst.proc)
        salida = {
            "servidor": inst.servidor,
            "hilos": inst.hilos,
            "segundosArranque": round(inst.segundosArranque, 2),
            "rssArranqueMb": memoriaArranque,
            "rssTrasCargaMb": memoriaFinal,
            "resultados": resultados,
        }
    print(json.dumps({k: v for k, v in salida.items() if k != "resultados"}))
    if args.json:
        Path(args.json).write_text(json.dumps(salida, indent=2), "utf-8")


if __name__ == "__main__":
    main()
