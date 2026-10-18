# Informe de rendimiento

Fecha: 2026-10-18. Punto de partida: `f370fe2` (herramientas de `perf/` sobre
`fd1639a`). Final: `c365e5f`. Entorno y método: ver `baseline.md` y `README.md`.

## Cómo se ha medido la comparación final

La máquina de medición varió mucho a lo largo del día: el mismo código llegó a
dar un 15-20 % menos de peticiones por segundo por la tarde que por la mañana.
Comparar el final con la línea base de la mañana habría mezclado mis cambios
con ese ruido. Por eso las tablas de abajo comparan el código base y el final
medidos **en la misma sesión**, uno detrás del otro y métrica a métrica (base
en un worktree aparte con `f370fe2`). Los datos están en
`perf/resultados/baseline-misma-sesion/` y `perf/resultados/final/`; los de
cada mejora por separado, en `perf/resultados/mejora1..4/`.

## Resultado: antes y después

### Carga de la interfaz (Chromium; cotizaciones simuladas a 200 ms por activo)

| Métrica | Antes | Después | Cambio |
|---|---:|---:|---:|
| Peticiones al abrir | 342 | 182 | -47 % |
| Red en reposo, local, en frío | 8 505 ms | 3 111 ms | **-63 %** |
| Red en reposo, local, en caliente | 8 503 ms | 3 034 ms | **-64 %** |
| Red en reposo, 40 ms de latencia, en frío | 13 610 ms | 5 662 ms | **-58 %** |
| Red en reposo, 40 ms de latencia, en caliente | 13 541 ms | 4 568 ms | **-66 %** |
| DOMContentLoaded, local, en caliente | 216 ms | 133 ms | -38 % |
| DOMContentLoaded, 40 ms, en caliente | 1 291 ms | 199 ms | **-85 %** |
| DOMContentLoaded, en frío (local / 40 ms) | 219 / 1 310 ms | 208 / 1 296 ms | sin cambio |
| JS/CSS servidos desde caché en una recarga | 3 de 105 | 105 de 105 | |
| Bytes transferidos en una recarga | 154 KB | 95 KB | -38 % |
| Bytes transferidos en frío | 1 107 KB | 1 078 KB | -3 % |
| `GET /api/activos/<id>` al entrar en Vista general / Activos / Paneles / Heatmap | 33 | 0 (1 lote) | |

### Endpoints en proceso (p50 / p95 / p99, ms; 200 iteraciones)

| Endpoint | Antes | Después | Cambio p50 |
|---|---|---|---:|
| `/api/portfolio/history/by-type?range=ALL` | 500,7 / 520,5 / 529,5 | 57,7 / 69,7 / 75,7 | **-88 %** |
| `/api/portfolio/history/by-type?range=1M` | 79,8 / 88,7 / 93,0 | 11,5 / 15,4 / 17,2 | **-86 %** |
| `/css/components.css` (gzip) | 2,42 / 2,88 / 3,52 | 1,48 / 2,01 / 2,42 | -39 % |
| `/js/core/app-core.js` (gzip) | 1,97 / 2,51 / 3,97 | 1,64 / 2,08 / 2,30 | -17 % |
| `/` (index.html) | 3,27 / 3,87 / 4,55 | 6,45 / 7,57 / 8,08 | **+97 %** (ver abajo) |
| Resto de endpoints de la carga inicial | | | dentro de ±15 %, sin cambios de código |

En la mejora 5 aislada (A/B alterno contra el commit anterior),
`app-core.js` bajó de 2,3 a 1,3 ms de p50 (-43 %); en esta tabla sale menos
porque la base ya era más rápida en esa tanda.

### Carga HTTP (waitress 8 hilos, 15 s por escenario)

| Escenario | Clientes | Antes: req/s, p95 ms | Después: req/s, p95 ms |
|---|---:|---|---|
| carga-inicial | 1 | 459,0, 3,21 | 458,8, 3,27 |
| carga-inicial | 8 | 665,4, 32,7 | 660,2, 35,9 |
| histórico (Métricas) | 1 | 4,9, 638 | **25,6, 72** |
| histórico | 8 | 4,6, 5 265 | **15,8, 1 522** |
| estáticos (incluye `/`) | 1 | 324,7, 4,63 | 355,7, 6,65 |
| estáticos (incluye `/`) | 8 | 580,8, 18,1 | **501,2, 44,6** (peor) |

### Arranque y memoria

| Métrica | Antes | Después |
|---|---:|---:|
| Hasta que `/api/health` responde | 3,23 s | 3,23 s |
| `import server` | 1,63 s | 1,62 s |
| RSS al arrancar | 64,7 MB | 64,6 MB |
| RSS tras la prueba de carga | 204,3 MB | 186,7 MB |

### Tests

pytest: toda la suite en verde (unos 1925 de partida más 18 nuevos). vitest:
381 → 386, todos en verde.

## Qué se ha cambiado (un commit por mejora)

| Commit | Mejora | Ganancia principal medida |
|---|---|---|
| `f02cc66` | 1. Cotizaciones del arranque en paralelo (máx. 4) en vez de en serie (`js/cartera/assets-resumen.js`) | Red en reposo 8,6 → 3,5 s local (-60 %) |
| `871141a` | 2. `loadAssetData` agrupa las llamadas simultáneas en `GET /api/activos-lote` (`js/cartera/assets.js`, `python/routes/activos.py`, `js/analisis/heatmap.js`) | 342 → 182 peticiones; 33 → 1 al entrar en cada página; -19 % con latencia |
| `4a7caf8`, `5c37cdf` | 3. `?v=` automático por fichero en los JS/CSS propios y caché `immutable` para la versión vigente (`python/core/estaticos.py`, `python/server.py`) | DOMContentLoaded en caliente con latencia 1 291 → 199 ms (-85 %) |
| `f06bf5b` | 4. Agregado del histórico por tipo en caché por proceso, ampliado de forma incremental (`python/stores/historico_tipos.py`) | by-type ALL 501 → 58 ms (-88 %) |
| `c365e5f` | 5. Reutilizar el gzip de los estáticos que no han cambiado (`python/core/seguridad_app.py`) | -43 % por estático (A/B aislado) |

Tests añadidos antes de tocar código sin cobertura: `tests/test_historico_tipos_http.py`
(el endpoint by-type no tenía ninguno), tres de `/api/activos-lote` en
`tests/test_activos_http.py`, `tests/test_estaticos.py`, tres de caché en
`tests/test_compresion_gzip.py`, y en vitest `cotizaciones-paralelo.test.js` y
`activos-lote.test.js`. `tests-js/activos-edicion.test.js` se ha adaptado para
que su servidor simulado también conteste a `/api/activos-lote`; sus
aserciones no han cambiado.

## Lo que ha empeorado y por qué se ha mantenido

- **`/` (index.html) pasa de 3,3 a 6,5 ms en proceso** y, por eso, el escenario
  sintético de estáticos con 8 clientes (una de cada cinco peticiones es `/`)
  baja de 581 a 501 req/s y su p95 sube de 18 a 45 ms. Es el coste de la mejora
  3: en cada carga hay que leer la fecha y el tamaño de los 99 JS/CSS y
  reescribir sus URLs. La primera versión costaba 40 ms (`Path.resolve()` por
  fichero en Windows); con `os.scandir` por carpeta se quedó en 2 ms más el
  gzip de un HTML algo mayor. Se mantiene porque pediste conservar la mejora y
  porque el balance es claramente positivo: un navegador pide `/` una vez por
  carga, y a cambio se ahorra ~100 revalidaciones (unos 200 ms de CPU del
  servidor y más de 1 s de espera con latencia). Además, `stat` y `scandir`
  cuestan mucho menos en Linux que en NTFS, así que en Docker el sobrecoste
  debería ser menor; no lo he podido medir allí.
- `/api/health` sale con +22 % en la tabla (102 → 125 ms), pero ni ese endpoint
  ni `PRAGMA quick_check` han cambiado: es variación de la máquina.

## Descartado

- **Índices para el histórico por tipo**: probados un índice cubriente
  `(ts, asset_id, price_eur, cost_eur)` (411 ms, peor), agregación condicional
  sin JOIN (407 ms), agregación en Python (584 ms) y caché de página de SQLite
  de 64 MB (351 ms). Ninguno llega al 5 %, o empeora; detalle en `baseline.md`.
- **Caché con duración en el navegador para `loadAssetData`**: solo se agrupan
  las llamadas simultáneas. Una caché con TTL podía devolver la ficha anterior
  justo después de guardar.
- **Menos resolución en los históricos largos**: daría más ganancia, pero
  cambia lo que se ve en el gráfico; la caché exacta lo hace innecesario por
  ahora.
- **Las 8 lecturas de ficheros por petición** (`config.ini`, `tls/estado.json`,
  sesión, generación de BD): pesan un 28 % de un GET simple en Windows, pero en
  Linux deberían ser despreciables y sin medirlo allí no hay base para tocarlas.
- **Workers de gunicorn y Docker**: sin Docker en esta máquina no hay números.

## Próximos pasos recomendados

1. Ejecutar `sh perf/medir_docker.sh` en el servidor para tener build, tamaño
   de imagen, arranque y `docker stats`, y repetir `perf/carga_http.py` allí
   (usa gunicorn gthread como `entrypoint.sh`). Confirmaría en Linux el coste
   real de versionar index.html.
2. `/api/portfolio/rentabilidad` (~42 ms) e `/api/portfolio/history?range=ALL`
   (~43 ms, la mitad en serializar 17,7 k puntos) son ahora lo más lento de
   Métricas. El primero admite la misma técnica de caché incremental que el
   histórico por tipo; el segundo se beneficiaría de un formato compacto
   (arrays en vez de objetos), que obliga a tocar el frontend.
3. La carga inicial sigue pidiendo `/api/activos` 6 veces y `/api/ventas` 5; el
   mismo agrupado de la mejora 2 aplicado a `loadAssetsList` las reduciría.
4. Si la carga en frío importa (primer acceso desde el móvil), los 102 JS/CSS
   siguen siendo 102 peticiones: concatenarlos en el servidor por carpeta
   reduciría la cascada sin introducir un paso de build.
