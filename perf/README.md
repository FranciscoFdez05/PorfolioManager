# perf/

Scripts reproducibles para medir el rendimiento de PorfolioManager. Ninguno toca
`data/`: todos trabajan sobre una copia en un directorio temporal (ver
`entorno.py`), sin claves de API (no hay llamadas a proveedores ni mensajes de
Telegram) y con el snapshot del servidor y la comprobación de versión
desactivados.

| Script | Qué mide |
|---|---|
| `medir_frontend.py` | Carga de la interfaz en Chromium (Playwright): peticiones, bytes, DOMContentLoaded, red en reposo, en frío y en caliente; llamadas a la API por página. `--latencia 40` emula un acceso remoto. |
| `medir_backend.py` | Latencia p50/p95/p99 por endpoint dentro del proceso (Flask `test_client`), sentencias SQL por petición y, con `--perfil`, cProfile de los más lentos. |
| `carga_http.py` | Carga HTTP concurrente (solo stdlib) contra waitress (Windows) o gunicorn gthread (Linux): p50/p95/p99, peticiones/s, errores, RSS antes y después. |
| `explain_sql.py` | `EXPLAIN QUERY PLAN` y tiempos de las consultas sobre las tablas grandes. |
| `medir_arranque.py` | Tiempo hasta que `/api/health` responde, tiempo de `import server` y RSS al arrancar. |
| `medir_docker.sh` | Build, tamaño de imagen, arranque hasta healthy y `docker stats`. Se ejecuta en el servidor (necesita Docker). |

Requisitos: los de `requirements-dev.txt` más `playwright` (con Chromium) para
el frontend y `waitress` en Windows para la carga HTTP. `psutil` es opcional
(memoria).

```sh
export PERF_TMP=/ruta/temporal          # opcional; por defecto el temporal del sistema
python perf/medir_frontend.py --repeticiones 5 --json perf/resultados/X/frontend-local.json
python perf/medir_frontend.py --repeticiones 3 --latencia 40 --json perf/resultados/X/frontend-40ms.json
python perf/medir_backend.py --iteraciones 200 --perfil --json perf/resultados/X/backend.json
python perf/carga_http.py --segundos 15 --concurrencia 1,8 --json perf/resultados/X/carga.json
python perf/explain_sql.py --json perf/resultados/X/sql.json
python perf/medir_arranque.py --veces 5 --json perf/resultados/X/arranque.json
```

Las cotizaciones que pide la interfaz al abrirse se simulan con un retardo fijo
de 200 ms por activo (ver la cabecera de `medir_frontend.py`); `--proveedorReal`
usa Yahoo/Finnhub de verdad.
