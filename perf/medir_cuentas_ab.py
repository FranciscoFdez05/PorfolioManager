"""Microbenchmark A/B de saldos() y saldosDelMes() sobre una copia de la mayor BD.

Se ejecuta una vez por variante del código (`--dirPython` apunta a la carpeta
python/ a medir) y se alternan las variantes desde fuera para repartir el ruido
de la máquina. Usa un cambio a euros fijo: aquí no se mide la red.

Uso:
    python perf/medir_cuentas_ab.py --dirPython <ruta>/python --bd copia.db [--iteraciones 40]
"""

import argparse
import datetime
import json
import statistics
import sys
import time
from decimal import Decimal
from pathlib import Path


def percentil(valores, p):
    orden = sorted(valores)
    k = (len(orden) - 1) * p / 100
    f = int(k)
    c = min(f + 1, len(orden) - 1)
    return orden[f] + (orden[c] - orden[f]) * (k - f)


def aEurosFijo(importe, moneda):
    return importe * (Decimal("0.9") if str(moneda or "EUR").upper() != "EUR" else Decimal(1))


def medir(funcion, iteraciones):
    for _ in range(3):
        funcion()
    tiempos = []
    for _ in range(iteraciones):
        t0 = time.perf_counter()
        funcion()
        tiempos.append((time.perf_counter() - t0) * 1000)
    return {"p50": round(percentil(tiempos, 50), 2), "p95": round(percentil(tiempos, 95), 2),
            "media": round(statistics.fmean(tiempos), 2)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dirPython", required=True)
    parser.add_argument("--bd", required=True)
    parser.add_argument("--iteraciones", type=int, default=40)
    args = parser.parse_args()

    sys.path.insert(0, args.dirPython)
    from core import db
    from stores import cuentas_store

    db.setActiveDbPath(Path(args.bd))
    conn = db.getDb()
    hoy = datetime.date.today()
    meses = cuentas_store.MONTH_KEYS
    resultado = {
        "saldos": medir(lambda: cuentas_store.saldos(conn, hoy, aEurosFijo), args.iteraciones),
        "saldosDelMes": medir(
            lambda: cuentas_store.saldosDelMes(str(hoy.year), meses[hoy.month - 1], conn, aEurosFijo),
            args.iteraciones,
        ),
    }
    print(json.dumps(resultado))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
