# Diagnóstico

Cuellos de botella ordenados por impacto medido en lo que nota el usuario (ver
`baseline.md`). Las ganancias son estimaciones a partir de la línea base; los
números de verdad saldrán de volver a medir tras cada cambio.

## 1. Las cotizaciones de la carga inicial se piden en serie

- Dónde: `js/cartera/assets-resumen.js:374` (`refreshOverviewMarketData`, bucle
  `for ... await refreshAssetMarketDataOnServer`).
- Medido: 33 peticiones encadenadas de ~200 ms cada una, de 580 ms a 6 900 ms.
  Son el 80 % de los 8,6 s hasta que la red queda en reposo (13,5 s con 40 ms de
  latencia).
- Causa: cada cotización espera a que termine la anterior.
- Solución: pedirlas con un tope de concurrencia (propuesta: 4, por debajo del
  `max_peticiones_paralelas = 6` que ya usa el servidor). Mismo número de
  peticiones al proveedor; solo cambia que se solapan.
- Ganancia estimada: red en reposo de 8,6 s a ~3,3 s en local (-60 %), y de
  13,5 s a ~7 s con 40 ms de latencia.
- Riesgo: medio. El proveedor recibe las mismas 33 peticiones en ~2 s en vez de
  en ~7 s; con un plan gratuito justo de cuota puede salir algún 429 que hoy no
  sale. El servidor ya tiene reintentos, reposo por 429 y respaldo entre
  proveedores.

## 2. N+1 en el frontend: una petición por activo en cada página

- Dónde: `loadAssetData` (`js/cartera/assets.js:331`), llamado en bucle desde
  `assets-resumen.js:158` y `:1245`, `analisis/metricas.js:245`,
  `cartera/activos-pagina.js:664`, `core/informes.js:397`, `cartera/paneles.js:601`;
  y `analisis/heatmap.js:172` con su propio `fetch`.
- Medido: 167 `GET /api/activos/<id>` en la carga inicial (cada activo unas 5
  veces, varias a la vez) y 33 más al entrar en Vista general, Activos, Métricas,
  Paneles o Heatmap.
- Causa: cada pantalla pide los activos uno a uno, y varias pantallas lo hacen a
  la vez al arrancar.
- Solución: que `loadAssetData` agrupe las llamadas del mismo ciclo en una sola
  petición a un endpoint nuevo `GET /api/activos/lote?ids=...` (devuelve lo
  mismo que `GET /api/activos/<id>` para cada uno, con `readAssetFile`) y que
  dos llamadas simultáneas al mismo activo compartan respuesta (cada llamador
  recibe su propia copia). Los llamadores no cambian. `heatmap.js:172` pasaría a
  usar `loadAssetData`.
- Ganancia estimada: carga inicial de 239 a ~75 llamadas a la API; al entrar en
  esas 5 páginas, de 33 peticiones a 1. Con 40 ms de latencia, ~350 ms menos por
  página y ~1 s menos en la carga inicial. En local la diferencia de tiempo es
  pequeña (decenas de ms); baja la CPU del servidor.
- Riesgo: medio. Endpoint nuevo (con test) y cambio en una función que usan 15
  sitios; el modo "todos los portfolios" (`/api/portfolios/<pid>/activo/<id>`)
  se deja como está.

## 3. Los 102 JS/CSS propios se revalidan en cada carga

- Dónde: `python/server.py:245` (`Cache-Control: no-cache` para `.js`/`.css`).
- Medido: en caliente, 102 respuestas 304; con 40 ms de latencia el
  DOMContentLoaded se queda en 1 288 ms aunque no se descargue nada (en local
  284 ms).
- Causa: `no-cache` obliga a preguntar por cada fichero en cada carga.
- Solución: al servir `index.html` (que ya se reescribe para el nonce y la
  versión), añadir a cada `js/...` y `css/...` local un `?v=` calculado del
  propio fichero (mtime y tamaño). Si el `v` de la petición coincide con el del
  fichero, se sirve con `max-age` de un año e `immutable`; si no, se mantiene el
  `no-cache` de hoy. No depende de acordarse de subir ninguna versión: cambia el
  fichero, cambia la URL.
- Ganancia estimada: carga en caliente de 342 a ~240 peticiones; DOMContentLoaded
  con 40 ms de latencia de ~1 290 ms a ~250 ms (-80 %); en local de 284 ms a ~150 ms.
- Riesgo: medio. Se reescribe `index.html` en cada petición (ya se hace); un
  error en la expresión que localiza las rutas dejaría un fichero sin versionar,
  que seguiría con `no-cache` (falla hacia lo seguro).

## 4. Histórico por tipo de activo: 530 ms por petición

- Dónde: `python/routes/snapshots.py:200` (`getHistoryByType`).
- Medido: p50 530 ms con `range=ALL`, 84 ms con `1M`; 61 % en SQL, el resto en
  Python y JSON. Con 8 clientes, el escenario de histórico llega a p95 5,8 s.
- Causa: agrupa las 466 k filas de `asset_snapshots` en cada petición. Ningún
  índice lo mejora (probados 4 enfoques, ver `baseline.md`).
- Solución: caché por proceso del agregado completo, que se amplía solo con las
  filas nuevas (las sumas son acumulables) y se recalcula entero si cambia algo
  más (purga, cambio de tipo o borrado de un activo, restauración o cambio de
  BD). Los rangos se recortan de ese agregado, así que la respuesta es idéntica
  a la de hoy.
- Ganancia estimada: `ALL` de 530 ms a ~60 ms y `1M` de 84 ms a ~15 ms tras la
  primera petición después de cada snapshot.
- Riesgo: medio. Invalidar mal la caché daría un gráfico viejo; +10-15 MB por
  worker. No hay tests de este endpoint: habría que escribirlos antes.
- Alternativa más barata pero que cambia el resultado: reducir resolución en
  rangos largos (un punto por hora o por día). Necesita tu decisión.

## 5. gzip de los estáticos en cada petición

- Dónde: `python/core/seguridad_app.py:371` (`comprimirRespuesta`).
- Medido: comprimir es ~1 ms de los ~2,1-2,6 ms que cuesta servir un JS/CSS.
- Causa: el mismo fichero se comprime una y otra vez.
- Solución: guardar en memoria la versión comprimida de cada estático, por ruta,
  mtime y tamaño (unos 1,1 MB en total).
- Ganancia estimada: -40 % por estático servido con 200; ~90 ms de CPU menos por
  carga en frío. Si entra la mejora 3, solo afecta a las cargas en frío.
- Riesgo: bajo. Ya hay tests de la compresión (`tests/test_compresion_gzip.py`).

## No propuestos ahora

- `/api/portfolio/rentabilidad` (44 ms) e `/api/portfolio/history?range=ALL`
  (44 ms, la mitad en JSON): una vez por visita a Métricas. Mejorarlos pide
  cambiar el algoritmo de `core/rentabilidad.py` o el formato de la respuesta.
- 8 `stat()` y 4 `open()` por petición: el 28 % de un GET simple en Windows,
  pero en Linux (producción) cuestan mucho menos y no lo he podido medir allí.
- `/api/health` (106 ms, `quick_check`): lo llama Docker cada 30 s, ~0,35 % de un
  núcleo.
- Docker: sin medir aquí. La imagen ya es `slim` y está bien ordenada por capas;
  un multi-stage no quitaría casi nada porque no hay dependencias de
  compilación. Pendiente de `perf/medir_docker.sh` en el servidor.
- Workers de gunicorn: con un único usuario la concurrencia actual (2×4) sobra;
  sin medirlo en Linux no hay base para tocarlo.
