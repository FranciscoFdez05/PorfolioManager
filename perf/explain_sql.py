"""EXPLAIN QUERY PLAN y tiempos de las consultas pesadas, sobre una copia de la BD.

Las consultas son las mismas que lanzan los endpoints de histórico
(routes/snapshots.py) y de cambios por periodo (routes/market.py), que son los
únicos que recorren las tablas grandes (asset_snapshots, portfolio_snapshots).

Uso:
    python perf/explain_sql.py [--bd ruta.db] [--repeticiones 7] [--json salida.json]

Por defecto usa el portfolio activo de data/portfolios.json, copiado antes con
la API de backup de SQLite para no tocar el original.
"""

import argparse
import json
import sqlite3
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import entorno

_BY_TYPE = """SELECT s.ts, a.type, SUM(s.price_eur) as v, SUM(s.cost_eur) as cost
              FROM asset_snapshots s
              JOIN activos a ON s.asset_id = a.id
              WHERE {where} a.type IS NOT NULL AND a.type != ''
              GROUP BY s.ts, a.type
              ORDER BY s.ts ASC"""


def consultas(ahora):
    mes = ahora - 30 * 86400
    return {
        "history ALL": ("SELECT ts, total_value, total_invested FROM portfolio_snapshots ORDER BY ts ASC", ()),
        "history 1M": ("SELECT ts, total_value, total_invested FROM portfolio_snapshots "
                       "WHERE ts >= ? ORDER BY ts ASC", (mes,)),
        "by-type ALL": (_BY_TYPE.format(where=""), ()),
        "by-type 1M": (_BY_TYPE.format(where="s.ts >= ? AND"), (mes,)),
        "historical-changes latest": ("SELECT asset_id, price_eur FROM asset_snapshots "
                                      "WHERE ts = (SELECT MAX(ts) FROM asset_snapshots)", ()),
        "historical-changes ventana": ("SELECT asset_id, price_eur FROM asset_snapshots "
                                       "WHERE ts BETWEEN ? AND ? ORDER BY ts ASC", (mes, mes + 10 * 86400)),
        "resumen valor previo": ("SELECT total_value FROM portfolio_snapshots WHERE ts <= ? "
                                 "ORDER BY ts DESC LIMIT 1", (mes,)),
        "health quick_check": ("PRAGMA quick_check(1)", ()),
    }


def bdActiva() -> Path:
    meta = json.loads((entorno.RAIZ / "data" / "portfolios.json").read_text("utf-8"))
    return entorno.RAIZ / "data" / "portfolios" / f"{meta['active']}.db"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bd")
    parser.add_argument("--repeticiones", type=int, default=7)
    parser.add_argument("--json")
    args = parser.parse_args()

    origen = Path(args.bd) if args.bd else bdActiva()
    copia = entorno.dirTemporal() / "explain.db"
    copia.parent.mkdir(parents=True, exist_ok=True)
    copia.unlink(missing_ok=True)
    entorno.copiarBd(origen, copia)

    conexion = sqlite3.connect(str(copia))
    # Los mismos PRAGMA que getDb() en core/db.py.
    conexion.execute("PRAGMA synchronous=NORMAL")
    conexion.execute("PRAGMA cache_size=-8000")

    tamanos = {}
    for (tabla,) in conexion.execute("SELECT name FROM sqlite_master WHERE type='table'"):
        n = conexion.execute(f'SELECT COUNT(*) FROM "{tabla}"').fetchone()[0]
        if n >= 1000:
            tamanos[tabla] = n

    resultado = {"bd": origen.name, "filasTablasGrandes": tamanos, "consultas": {}}
    for nombre, (sql, params) in consultas(int(time.time())).items():
        plan = [fila[3] for fila in conexion.execute("EXPLAIN QUERY PLAN " + sql, params)] \
            if not sql.startswith("PRAGMA") else []
        tiempos, filas = [], 0
        for _ in range(args.repeticiones):
            t0 = time.perf_counter()
            filas = len(conexion.execute(sql, params).fetchall())
            tiempos.append((time.perf_counter() - t0) * 1000)
        resultado["consultas"][nombre] = {
            "plan": plan, "filas": filas,
            "msMediana": round(statistics.median(tiempos), 2), "msMin": round(min(tiempos), 2),
        }
        print(f"{nombre:28s} {statistics.median(tiempos):9.2f} ms  filas={filas:7d}  plan={plan}")

    conexion.close()
    if args.json:
        Path(args.json).write_text(json.dumps(resultado, indent=2, ensure_ascii=False), "utf-8")


if __name__ == "__main__":
    main()
