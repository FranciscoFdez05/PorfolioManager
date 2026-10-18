# Línea base de rendimiento

Fecha: 2026-10-18. Commit de partida: `fd1639a`. Datos en bruto en
`perf/resultados/baseline/`.

## Entorno de medición

- Windows 11 Pro, Python 3.14.4 (producción: Docker `python:3.12-slim`).
- Servidor WSGI: waitress, 1 proceso y 8 hilos. Producción usa gunicorn gthread
  con 2 workers y 4 hilos (`entrypoint.sh`), que no funciona en Windows; la
  concurrencia total (8) es la misma, pero aquí todos los hilos comparten un GIL.
- Datos: copia del portfolio activo (36 MB): 33 activos, 466 k filas en
  `asset_snapshots`, 17,7 k en `portfolio_snapshots`.
- Cotizaciones al abrir la interfaz: simuladas con 200 ms por activo (mediana
  medida contra Yahoo) para que el resultado no dependa del proveedor.
- Docker: no está instalado en esta máquina. Las métricas de imagen, build y
  `docker stats` quedan pendientes de ejecutar `perf/medir_docker.sh` en el
  servidor.
- Tests de partida: pytest (unos 1925) y vitest (381), todos en verde.

## 1. Carga de la interfaz (Chromium, `medir_frontend.py`)

Mediana de 5 repeticiones (red local) y 3 (40 ms de latencia, 20 Mbit/s).

| Métrica | Local, frío | Local, caliente | 40 ms, frío | 40 ms, caliente |
|---|---:|---:|---:|---:|
| Peticiones | 342 | 342 | 342 | 342 |
| Bytes transferidos | 1 106 KB | 154 KB | 1 106 KB | 154 KB |
| Bytes descomprimidos | 4 096 KB | 4 096 KB | 4 096 KB | 4 096 KB |
| Recursos servidos desde caché | 0 | 3 | 0 | 3 |
| DOMContentLoaded | 274 ms | 284 ms | 1 305 ms | 1 288 ms |
| Fin del último JS/CSS | 240 ms | 254 ms | 1 287 ms | 1 281 ms |
| Fin de la última llamada a la API | 7 805 ms | 7 791 ms | 11 662 ms | 11 790 ms |
| Red en reposo (mín-máx) | 8 635 ms (8 590-8 730) | 8 689 ms (8 527-8 848) | 13 533 ms | 13 612 ms |

Composición de las 342 peticiones: 1 documento, 64 scripts, 38 hojas de estilo
y 239 llamadas a la API. En caliente, los 102 JS/CSS propios se revalidan uno a
uno (`Cache-Control: no-cache`, respuesta 304); solo las 3 librerías de
`js/vendor/` salen de caché.

Llamadas a la API en la carga inicial:

| Ruta | Veces |
|---|---:|
| `GET /api/activos/<id>` | 167 (33 activos, unas 5 veces cada uno) |
| `POST /api/activos/<id>/refresh-market-data` | 33, **en serie** (una tras otra) |
| `GET /api/activos` | 6 |
| `GET /api/ventas` | 5 |
| otras 16 rutas | 1-2 cada una |

Cascada: los 33 `refresh-market-data` empiezan a los ~580 ms y terminan a los
~6 900 ms, uno detrás de otro (~200 ms cada uno). Es el 80 % del tiempo hasta
que la red queda en reposo.

Al entrar en cada página (red local, primera visita):

| Página | ms hasta reposo | Llamadas API | de ellas `GET /api/activos/<id>` |
|---|---:|---:|---:|
| Vista general | 321 | 35 | 33 |
| Activos | 315 | 34 | 33 |
| Métricas | 313 | 50 | 33 |
| Paneles | 311 | 36 | 33 |
| Heatmap | 313 | 34 | 33 |
| Dividendos, gastos, ingresos, cuentas, ventas, seguimiento | 310-595 | 2-6 | 0 |

## 2. Latencia por endpoint en proceso (`medir_backend.py`, 200 iteraciones)

Sin red ni servidor WSGI; mide Python + SQLite. Con `Accept-Encoding: gzip`.

| Endpoint | p50 ms | p95 ms | p99 ms | Bytes | SQL |
|---|---:|---:|---:|---:|---:|
| `/api/portfolio/history/by-type?range=ALL` | 529,6 | 636,9 | 716,5 | 137 523 | 1 |
| `/api/health` | 105,7 | 115,4 | 121,5 | 413 | 4 |
| `/api/portfolio/history/by-type?range=1M` | 83,7 | 95,3 | 99,4 | 26 779 | 1 |
| `/api/portfolio/rentabilidad` | 44,3 | 55,4 | 61,4 | 1 509 | 1 |
| `/api/portfolio/history?range=ALL` | 44,1 | 54,4 | 64,2 | 105 191 | 1 |
| `/api/portfolio/history?range=1M` | 7,9 | 12,2 | 13,4 | 18 082 | 1 |
| `/api/cuentas/saldos-mes` | 6,3 | 10,3 | 13,4 | 293 | 20 |
| `/api/cuentas` | 5,3 | 7,5 | 9,3 | 514 | 12 |
| `/api/activos/rendimiento-batch` | 4,4 | 8,2 | 13,9 | 1 413 | 4 |
| `/api/activos` | 3,3 | 5,5 | 6,3 | 2 908 | 3 |
| `/` (index.html) | 3,3 | 4,0 | 4,8 | 23 501 | 0 |
| `/api/gastos/<año>` | 3,0 | 4,2 | 4,6 | 3 155 | 16 |
| `/css/components.css` | 2,6 | 3,6 | 3,9 | 18 681 | 0 |
| `/js/core/app-core.js` | 2,1 | 2,7 | 2,9 | 16 297 | 0 |
| `/api/activos/<id>` | 1,8 | 2,4 | 2,7 | 490 | 4 |
| resto de endpoints de la carga inicial | 1,2-2,6 | 1,6-4,8 | 1,8-8,0 | | 0-7 |

No hay N+1 en el servidor: el número de sentencias por petición es constante y
no crece con el número de filas.

Perfil (cProfile, 50 peticiones):

- `by-type ALL`: 61 % en la consulta SQL (agrupación de 466 k filas con JOIN a
  `activos`), 12 % en el bucle Python que reorganiza 62 k grupos y 6,2 M de
  llamadas a `round()`, 8 % en serializar el JSON.
- `rentabilidad`: 75 % en `core/rentabilidad.py` (`serieDiaria` y
  `coberturaAnual` sobre los 17,7 k snapshots).
- `history ALL`: 50 % serializando 17,7 k objetos JSON.
- `health`: 95 % en `PRAGMA quick_check(1)`.
- Petición simple (`/api/activos/<id>`): el 28 % del tiempo son 8 `stat()` y 4
  `open()` por petición (relectura de `config.ini`, `tls/estado.json`, estado de
  sesión y generación de BD). En NTFS cada `stat()` cuesta ~70 µs; en Linux es
  mucho menos, así que este dato no es extrapolable a Docker.
- Estáticos: comprimir con gzip en cada petición es ~1 ms de los ~2,1 ms de un
  JS (en proceso: 200 con gzip 2,31 ms, sin gzip 1,43 ms, 304 1,40 ms).

## 3. Consultas SQL (`explain_sql.py`, mediana de 7)

| Consulta | ms | Filas | Plan |
|---|---:|---:|---|
| by-type ALL | 405,1 | 61 918 | SCAN por `idx_asset_snapshots_ts` + búsqueda en `activos` + 2 TEMP B-TREE (GROUP BY y ORDER BY) |
| health `quick_check` | 112,0 | 1 | - |
| by-type 1M | 66,7 | 11 244 | SEARCH por `idx_asset_snapshots_ts (ts>?)` + 2 TEMP B-TREE |
| historical-changes ventana | 50,1 | 75 030 | SEARCH por `idx_asset_snapshots_ts` |
| history ALL | 11,1 | 17 671 | SCAN por `idx_portfolio_snapshots_ts` |
| history 1M | 1,7 | 2 824 | SEARCH por índice |
| historical-changes último | 0,02 | 30 | índice cubriente |

Probado y descartado para by-type (sobre una copia): índice cubriente
`(ts, asset_id, price_eur, cost_eur)` 411 ms (peor), agregación condicional por
tipo sin JOIN 407 ms, agregación en Python 584 ms, `cache_size` de 64 MB 351 ms.
Recorrer la tabla entera cuesta 38 ms: lo caro es agrupar, no leer, y ningún
índice lo evita.

## 4. Carga HTTP (`carga_http.py`, waitress 8 hilos, 15 s por escenario)

| Escenario | Concurrencia | Peticiones/s | p50 ms | p95 ms | p99 ms | Errores |
|---|---:|---:|---:|---:|---:|---:|
| carga-inicial (mezcla de la interfaz) | 1 | 476,6 | 1,94 | 3,01 | 3,98 | 0 |
| carga-inicial | 8 | 703,0 | 8,40 | 34,31 | 69,44 | 0 |
| histórico (Métricas) | 1 | 6,4 | 46,87 | 536,56 | 558,22 | 0 |
| histórico | 8 | 4,5 | 941,03 | 5 828,85 | 6 315,48 | 0 |
| estáticos (200) | 1 | 281,0 | 3,33 | 5,31 | 6,53 | 0 |
| estáticos (200) | 8 | 699,8 | 10,96 | 16,06 | 21,40 | 0 |
| estáticos (304) | 1 | 124,2 | 3,53 | 26,32 | 28,36 | 0 |
| estáticos (304) | 8 | 619,0 | 10,24 | 30,57 | 34,45 | 0 |

El p95 de 26 ms de los 304 con un solo cliente es un artefacto de la pila TCP
de Windows con respuestas sin cuerpo (en proceso, un 304 tarda 1,4 ms); no se
tiene en cuenta.

## 5. Arranque y memoria (`medir_arranque.py`, 5 arranques)

| Métrica | Valor |
|---|---:|
| Hasta que `/api/health` responde 200 | 3,22 s (3,20-3,75) |
| Solo `import server` | 1,66 s (1,62-1,83) |
| RSS al arrancar | 64,7 MB |
| RSS tras las pruebas de carga | 199,5 MB |

## 6. Docker

Sin medir: Docker no está disponible en esta máquina. `perf/medir_docker.sh`
deja medidos el build con y sin caché, el tamaño de la imagen, el arranque hasta
healthy y `docker stats` en reposo y con carga; hay que ejecutarlo en el servidor.
La imagen ya parte de `python:3.12-slim`, instala con `--no-cache-dir` y ordena
las capas para que un cambio de código no reinstale dependencias.
