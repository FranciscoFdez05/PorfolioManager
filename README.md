# Portfolio Python

Aplicación web local para el seguimiento integral de una cartera de inversión personal. Gestiona activos (acciones, ETFs, criptomonedas, materias primas, bonos e interés fijo), registra gastos e ingresos, calcula ganancias y pérdidas en ventas, consolida dividendos e intereses y ofrece un panel de métricas con gráficos interactivos. Todo corre en local sin dependencias de servicios en la nube; los únicos datos externos son las cotizaciones opcionales vía API.

---

## Módulos

### Portfolio — Activos
Cada activo (acción, ETF, cripto, materia prima, bono o interés fijo) tiene su propia ficha con:
- Historial de compras/aportes con precio medio ponderado y coste total.
- Precio de mercado actualizable manualmente o mediante API (Finnhub / EODHD).
- Color personalizado, ticker de mercado y proveedor de datos configurables desde el botón **Editar**.
- Posición actual, valor de mercado, rendimiento en euros y porcentaje.
- **Vista general** en cuadrícula con tarjetas por activo, filtros por tipo y búsqueda por nombre.

### Gastos & Ingresos
- **Gastos anuales**: tabla mensual con categorías personalizables, mensualidades recurrentes y totales por columna. Botón 👁 por categoría y por el bloque de mensualidades para incluirlas o excluirlas de las métricas.
- **Movimientos de gastos**: registro mensual de gastos individuales con importe, tipo y nota.
- **Ingresos personales**: ingresos recurrentes (nómina, alquiler…) y movimientos puntuales por mes y año.

### Renta — Dividendos, Intereses y Bonos
- **Dividendos**: registro de cobros con fecha, importe bruto e impuestos; resumen anual.
- **Intereses**: histórico de intereses cobrados por instrumento y año.
- **Bonos / Interés Fijo**: tabla unificada con bonos gubernamentales, corporativos e interés fijo. Cupón, vencimiento, invertido, interés acumulado, impuestos y neto. Filtrables por tipo.

### Cripto
- **Stablecoins**: seguimiento de saldos y movimientos en stablecoins.
- **Operaciones**: registro de trades abiertos con par, entrada y notas.
- **Transacciones**: movimientos on-chain entre wallets y exchanges.
- **Conversiones**: historial de conversiones entre criptomonedas.

### Ventas
Registro de ventas con cálculo automático de ganancia/pérdida (precio de venta vs. precio medio de compra), comisiones e impacto fiscal estimado.

### Finanzas
- **Vista General**: tabla resumen de todos los activos con ordenación por columna.
- **Ingresos**: ingresos recurrentes y puntuales consolidados.

### Métricas
Panel de análisis con KPIs de portfolio, gastos e ingresos, y gráficos interactivos:
- **Distribución por tipo** (donut/barras) y **por activo individual** con filtros de tipo persistentes.
- **Comparativa de gastos vs. ingresos** mensual por año con exclusión de categorías.
- Gráficos de dividendos, intereses, bonos y renta fija con desglose por instrumento.
- Configuraciones (tipo de gráfico, métrica, activos ocultos) guardadas automáticamente.

### Herramientas
- **Ratio Oro/Plata**: calculadora con carga automática de precios desde la cartera.
- Otras utilidades de análisis y conversión.

### Ajustes
- Gestión de claves API (Finnhub, EODHD).
- Horas de caducidad de cotizaciones, backup y restauración de la base de datos.
- Selector de tema (oscuro, claro, negro).

---

## Índice

1. [Requisitos](#requisitos)
2. [Instalación](#instalación)
3. [Configuración de API Keys](#configuración-de-api-keys)
4. [Ejecución](#ejecución)
5. [Estructura del proyecto](#estructura-del-proyecto)
6. [Base de datos](#base-de-datos)
7. [Backup y restauración](#backup-y-restauración)

---

## Requisitos

- **Python 3.10 o superior** — [python.org/downloads](https://www.python.org/downloads/)
- **pip** (incluido con Python)
- SQLite — ya incluido en la librería estándar de Python, no requiere instalación adicional

Comprueba tu versión de Python antes de continuar:

```bash
python --version
```

---

## Instalación

### 1. Clona o descarga el repositorio

```bash
git clone https://github.com/FranciscoFdez05/PorfolioPython.git
cd PorfolioPython
```

O descarga el ZIP desde GitHub y extráelo.

### 2. (Recomendado) Crea un entorno virtual

Evita conflictos con otras instalaciones de Python en tu equipo:

```bash
# Crear el entorno
python -m venv .venv

# Activarlo en macOS / Linux
source .venv/bin/activate

# Activarlo en Windows (CMD)
.venv\Scripts\activate.bat

# Activarlo en Windows (PowerShell)
.venv\Scripts\Activate.ps1
```

> Si PowerShell bloquea la ejecución de scripts, ejecuta primero:
> `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`

### 3. Instala las dependencias

```bash
pip install -r requirements.txt
```

Las únicas dependencias externas son **Flask** y **python-dotenv**. Todo lo demás (SQLite, urllib) forma parte de la librería estándar.

---

## Configuración de API Keys

Los precios de mercado en tiempo real requieren al menos una clave de API. La aplicación soporta dos proveedores: **Finnhub** y **EODHD**.

> Sin claves configuradas la app funciona igualmente: solo fallarán las actualizaciones de precios.

### Opción A — Variables de entorno (recomendado)

Copia el fichero de plantilla y rellena tus claves:

```bash
# macOS / Linux
cp .env.example .env

# Windows
copy .env.example .env
```

Edita `.env`:

```env
FINNHUB_API_KEY=tu_clave_finnhub
EODHD_API_KEYS=clave1,clave2   # admite varias claves separadas por comas
FLASK_DEBUG=false
```


### Opción B — Ficheros de clave

Crea la carpeta `API/` en la raíz del proyecto y coloca las claves en ficheros de texto plano:

| Fichero            | Proveedor | Formato                          |
|--------------------|-----------|----------------------------------|
| `API/finnhub.key`  | Finnhub   | Una clave por línea              |
| `API/eodhd.key`    | EODHD     | Una clave por línea              |

Las líneas que empiezan por `#` se tratan como comentarios y se ignoran.

### ¿Dónde conseguir las claves?

| Proveedor | Registro | Plan gratuito |
|-----------|----------|---------------|
| Finnhub   | [finnhub.io](https://finnhub.io) | Sí — 60 req/min |
| EODHD     | [eodhd.com](https://eodhd.com)  | Sí — 20 req/día |

---

## Ejecución

### Arranque normal

```bash
cd python
python server.py
```

Abre el navegador en `http://127.0.0.1:5000`.

La base de datos `data/portfolio.db` se crea automáticamente en el primer arranque. No es necesario ningún paso previo de inicialización.

### Modo debug (recarga automática al editar código)

```bash
# macOS / Linux
FLASK_DEBUG=true python server.py

# Windows CMD
set FLASK_DEBUG=true && python server.py

# Windows PowerShell
$env:FLASK_DEBUG="true"; python server.py
```

O simplemente pon `FLASK_DEBUG=true` en tu fichero `.env`.

> El modo debug **no debe usarse** si la aplicación es accesible desde otras máquinas de la red.

### Parar el servidor

Pulsa `Ctrl + C` en la terminal donde corre el servidor.

---

## Estructura del proyecto

```
PorfolioPython/
├── python/
│   ├── server.py          # Punto de entrada Flask
│   ├── db.py              # Conexión SQLite y esquema de tablas
│   ├── app_data.py        # Lectura/escritura de operaciones, stablecoins, etc.
│   ├── asset_store.py     # CRUD de activos e historial de posiciones
│   ├── gastos_store.py    # CRUD de gastos por año/mes
│   ├── ventas_store.py    # CRUD de ventas y cálculo de ganancias
│   ├── asset_utils.py     # Validación y normalización de activos
│   ├── helpers.py         # Helpers compartidos (conversión de divisa, sync)
│   ├── finnhub_client.py  # Cliente API Finnhub
│   ├── eodhd_client.py    # Cliente API EODHD
│   └── routes/
│       ├── activos.py     # /api/activos
│       ├── operaciones.py # /api/operaciones, /api/stablecoins
│       ├── gastos.py      # /api/gastos, /api/gastos-tipos
│       ├── ventas.py      # /api/ventas
│       ├── registros.py   # /api/intereses, /api/dividendos, /api/transacciones
│       └── market.py      # /api/market/*, /api/exchange-rate
├── html/                  # Vistas HTML
├── css/                   # Estilos
├── js/                    # Lógica frontend
├── data/
│   └── portfolio.db       # Base de datos SQLite (generada automáticamente)
├── API/                   # Claves de API (no subir al repo)
├── .env                   # Variables de entorno locales (no subir al repo)
├── .env.example           # Plantilla de variables de entorno
└── requirements.txt       # Dependencias Python
```

---

## Base de datos

Todas las tablas se crean automáticamente al arrancar el servidor. El fichero `data/portfolio.db` es el único almacén de datos.

| Tabla                    | Contenido                               |
|--------------------------|-----------------------------------------|
| `activos`                | Metadatos de cada activo                |
| `activo_rows`            | Historial de compras/aportes por activo |
| `activo_operation_rows`  | Operaciones completadas sincronizadas   |
| `activo_conversion_rows` | Conversiones de cripto                  |
| `operaciones`            | Operaciones abiertas                    |
| `intereses`              | Registro de intereses cobrados          |
| `dividendos`             | Registro de dividendos cobrados         |
| `transacciones`          | Transacciones on-chain / entre wallets  |
| `stablecoins_catalog`    | Catálogo de stablecoins disponibles     |
| `stablecoins_enabled`    | Stablecoins activadas                   |
| `stablecoins_rows`       | Movimientos de stablecoins              |
| `gastos_tipos`           | Categorías de gastos (global)           |
| `gastos_rows`            | Gastos por año, mes y categoría         |
| `mensualidades`          | Suscripciones mensuales por año         |
| `ventas`                 | Ventas realizadas con cálculo fiscal    |

---

## Backup y restauración

### Hacer backup

Copia el fichero de base de datos mientras el servidor **está parado**:

```bash
# macOS / Linux
cp data/portfolio.db data/portfolio.db.bak

# Windows
copy data\portfolio.db data\portfolio.db.bak
```

### Restaurar un backup

```bash
# macOS / Linux
cp data/portfolio.db.bak data/portfolio.db

# Windows
copy data\portfolio.db.bak data\portfolio.db
```

### Inspeccionar la base de datos manualmente

Puedes abrir `data/portfolio.db` con cualquier cliente SQLite, por ejemplo [DB Browser for SQLite](https://sqlitebrowser.org/) (gratuito, multiplataforma).

---

## Changelog

### 2026-04-30 — Corrección de Vista General vacía (corrupción de índice SQLite)

#### Problema
La Vista General mostraba la tabla completamente vacía y las KPIs del encabezado aparecían como `---`, a pesar de que los activos existían y se mostraban correctamente en la barra lateral.

#### Causa raíz
El índice de clave primaria de la tabla `activos` en SQLite estaba corrupto (`wrong # of entries in index sqlite_autoindex_activos_1`). El activo **MSCI Emerging Markets** existía como fila en la tabla pero su entrada faltaba en el índice. Esto provocaba que cualquier consulta con `WHERE id = 'msci-emerging-markets'` devolviera vacío, mientras que un `SELECT *` sin filtro sí lo encontraba. Como resultado, el endpoint `/api/activos/msci-emerging-markets` respondía 404, y dado que el frontend usaba `Promise.all` para cargar todos los activos en paralelo, ese único fallo hacía que la carga completa fallara silenciosamente, dejando la tabla en blanco.

#### Solución aplicada
- **Base de datos**: `REINDEX activos` para reconstruir el índice corrupto, seguido de `VACUUM` para eliminar páginas huérfanas. La integridad quedó en `ok`.
- **Frontend — resiliencia**: cambiado `Promise.all` por `Promise.allSettled` en `renderVistaGeneralTable` y `refreshTopPortfolioMetrics`. Ahora, si un activo falla al cargar o al procesar, los demás siguen mostrándose en lugar de bloquearse todos.
- **Frontend — estado vacío**: el bloque `catch` de `renderVistaGeneralTable` ahora llama a `renderOverviewRows([])` para mostrar el mensaje de estado vacío en lugar de dejar la tabla en silencio.
- **Cache busting**: actualizada la versión de `assets.js` a `20260430a` en `index.html` para forzar la recarga del fichero modificado en el navegador.

---

### 2026-04-28 — Mejoras de UI y unificación de Interés Fijo

#### Ticker editable desde el modal de activo
- El modal **Editar activo** incluye ahora un campo **Ticker de mercado** que permite cambiar el símbolo de cotización (`marketSymbol`) sin necesidad de recrear el activo. El valor se muestra pre-rellenado con el ticker actual y se guarda al confirmar.

#### Círculo de color en las tarjetas de activo
- Las tarjetas de la **vista general de activos** muestran un pequeño círculo con el color personalizado del activo en la esquina superior derecha, junto a los botones de editar y eliminar. El círculo aparece al pasar el cursor sobre la tarjeta y muestra un glow del mismo color al hacer hover sobre él.

#### Botones de visibilidad en Gastos
- Los botones 👁 (ocultar/mostrar en Métricas) se mantienen únicamente en la **fila de cabecera "Mensualidades"** y en las **filas de gastos por tipo**. Se eliminaron de las mensualidades individuales para reducir ruido visual.

#### Unificación de Interés Fijo
- Los tipos **"Interés Fijo Bancario"** y **"Interés Fijo Estatal"** se fusionaron en un único tipo **"Interés Fijo"** (`tipo = "if"`). El selector del modal de alta/edición pasa de dos opciones a una. Los registros existentes con `bancario` o `estatal` se migran automáticamente al guardar.
- En **Métricas**, el grupo "Renta Fija" muestra solo la tarjeta **Neto** (se eliminaron "Bancario" y "Estatal"). El gráfico de tipos de renta fija muestra un único segmento "Interés Fijo".
- Código muerto eliminado: `rentaFija.js` (308 líneas) y `rentaFija.html` vaciados; `rentaFijaModalActions` y reglas CSS de `bancario`/`estatal` en los filtros eliminadas.

#### Filtros de activos en Métricas persistentes
- Los botones de tipo (Cripto, Acciones, ETFs…) del gráfico **"Por activo individual"** en Métricas ahora persisten su estado. Al ocultar un tipo, la preferencia se guarda en `/api/settings` (`metricasActivosHidden`) y se restaura en la próxima visita.

---

### 2026-04-28 — Color de activo en gráficos de dividendos

El color personalizado asignado a cada activo ahora se aplica de forma consistente en todos los apartados de métricas relacionados con dividendos.

- **Distribución de dividendos por acción**: el gráfico de barras y el donut usan el color del activo correspondiente al instrumento. Si el activo no tiene color asignado, se mantiene el fallback a la paleta por índice.
- **Dividendos por instrumento / Dividendos por mes**: el gráfico de barras apiladas asigna a cada serie (instrumento) su color de activo, tanto en la leyenda como en los tooltips y en el renderizado de segmentos.
- Implementación: `mRenderAll` construye un `colorMap` (`nombre → color`) desde `summaries` y lo propaga a `mRenderDividendos` y `mRenderDivMensual`; este último lo pasa también al listener de cambio de año para que el color se mantenga al navegar entre años.

#### Reorganización del header de activo

- Los botones **"Actualizar cotización"** y **"Eliminar activo"** se han agrupado en un nuevo contenedor `.assetHeaderRight` junto al panel **"Pasar a EUR"**, quedando a su izquierda.
- Antes, los botones de acción flotaban de forma independiente en el centro del header; ahora forman un bloque compacto alineado a la derecha junto al selector de moneda.

---

### 2026-04-28 — Módulo Interés Fijo / Bonos unificado

#### Ventana única con tabla unificada
- Eliminada la ventana **Renta Fija** como página independiente. Su contenido se integró como tipo dentro de la ventana **Interés Fijo** (antes llamada "Bonos").
- El menú de navegación muestra una única entrada "Interés Fijo" bajo el desplegable "Renta".
- La tabla es ahora única y contiene todos los instrumentos: bonos gubernamentales, bonos corporativos, interés fijo bancario e interés fijo estatal.
- Los filtros de la barra de herramientas permiten ver **Todos / Interés Fijo / Corporativos / Gubernamentales**. El filtro "Interés Fijo" agrupa los tipos `bancario` y `estatal`.

#### Campo Moneda
- Nueva columna **Moneda** (EUR / USD / GBP / CHF / JPY) en la tabla y en el modal de alta/edición.
- Persiste en base de datos (`bonos.currency`, `renta_fija.currency`) con migración automática en el arranque para tablas existentes.

#### Totales por categoría
- Las tarjetas de resumen muestran: Total neto, Interés acumulado, Impuestos, Invertido total, **Interés Fijo neto**, **Corporativos neto**, **Gubernamentales neto**.

#### Backend
- `/api/bonos` y `/api/rentafija` siguen existiendo como almacenes separados. El frontend los carga, fusiona para mostrar y los vuelve a separar por tipo al guardar.
- Sanitización de `currency` en `registros.py` para ambas rutas POST (valores permitidos: `EUR`, `USD`, `GBP`, `CHF`, `JPY`).

---

### 2026-04-28 — Selector de color HSV en activos

#### Nuevo color picker de canvas
- Sustituida la paleta de swatches por un selector HSV completo: canvas de saturación/valor, slider de tono, campo hexadecimal con previsualización en tiempo real.
- Botón **"Color aleatorio"** que genera un color vivo aleatorio (saturación 0,55–0,95, valor 0,65–0,95).
- El selector funciona con Pointer Capture API para drag fluido sin listeners globales.

#### Corrección de navegación en vista Activos
- Al confirmar la edición de un activo desde las tarjetas de la vista **Activos**, la aplicación permanece en esa vista en lugar de navegar a la ficha del activo.
- Si se edita desde la ficha del activo (panel lateral), el comportamiento anterior se conserva.

---

### 2026-04-27 — Color personalizado por activo

Cada activo puede tener ahora un color propio que se mantiene consistente en todos los gráficos de métricas.

#### Selector de color en los modales
- **Modal "Nuevo activo"**: incluye una paleta de 20 colores seleccionables antes de confirmar la creación. El color elegido se guarda junto con el resto de metadatos del activo.
- **Modal "Editar activo"**: muestra la paleta con el color actual del activo preseleccionado. Permite cambiar nombre y color en la misma acción; si ninguno cambia, el modal se cierra sin hacer ninguna petición al servidor.

#### Persistencia
- El campo `color` se almacena en el JSON del activo en `data/portfolio.db` y se incluye en todos los payloads de creación (`POST /api/activos`) y edición (`POST /api/activos/:id`).
- `renderAssetTablePage` escribe el color en `data-asset-color` del elemento DOM para que `buildCurrentAssetPayload` lo recupere en el autosave.

#### Reflejo en métricas
- El gráfico **"Por activo individual"** usa el color guardado de cada activo. Si un activo no tiene color asignado, sigue tomando uno de la paleta por orden de índice (comportamiento anterior).
- El color se propaga a través de `buildMetricasPayload` → `summaries[].color` → `mRenderDistActivos`.

#### Corrección de la edición desde la vista Activos
- El botón ✎ de las tarjetas de la vista **Activos** ahora pasa el objeto completo del activo a `openEditAssetModal`, evitando que el guardado sobreescriba las filas y operaciones del activo con valores vacíos.

---

### 2026-04-27 — Mejoras de UI en módulo Cripto

#### Botón "Añadir fila" anclado al fondo izquierdo
- En las páginas **Stablecoins**, **Operaciones**, **Transacciones** y **Conversiones**, el botón "Añadir fila" se ha movido fuera del `<section>` como hijo directo de `#dynamicContent` (`display:flex; flex-direction:column; min-height:100%`). Con `margin-top:auto` queda anclado en la esquina inferior izquierda del viewport independientemente del número de filas.

#### Borde dinámico de las secciones
- Las secciones compactas (`.operationsPageCompact`) usan `flex:none` para ajustar su altura al contenido, eliminando el espacio vacío entre la tabla y el botón.
- La tabla de Stablecoins limita el scroll a **9 filas visibles** (`max-height: calc(9 * 41px + 42px)`).

#### Tabla de Conversiones rediseñada
- Cambio de clase `assetOperationsTable` → `operationsTable` para heredar el estilo unificado (cabeceras en mayúsculas, fondo oscuro, sticky header, hover y filas alternas).
- Borde redondeado (`border-radius:10px; border:1px solid #1e2d45`) igual al del resto de tablas.
- Altura dinámica: eliminado `min-height` fijo del wrapper.
- Las celdas **Fecha**, **Par** y **Cantidad** dejan de ser `contenteditable`; el campo **Tipo** pasa de `<select>` inline a texto plano con `data-value`. Todo se edita exclusivamente desde el modal (botón ✎).

#### Ordenación por columna
- Añadida ordenación ascendente/descendente al pulsar cualquier cabecera en: **Bonos**, **Renta Fija**, **Stablecoins**, **Operaciones**, **Transacciones** y **Conversiones**.
- Reutiliza la función `bindTableSort()` de `shared-utils.js` (ya usada en Ventas y Vista General). Soporta fechas `dd-mm-aaaa`, números y texto. Las flechas ▲▼ indican la columna y dirección activas.

### 2026-04-27 — Herramienta Ratio Oro/Plata

Nueva calculadora en el módulo **Herramientas** que muestra cuántas onzas de plata son necesarias para comprar una onza de oro.

#### Funcionamiento
- Botón **"Cargar precios guardados"**: busca automáticamente en la cartera activos cuyo nombre o símbolo contenga `oro/gold/xau` y `plata/silver/xag`, rellena los inputs con sus precios actuales y calcula el ratio al instante.
- Los precios también se pueden introducir manualmente para cualquier combinación de valores.

#### Resultados mostrados
| Campo | Descripción |
|---|---|
| Onzas de plata por 1 oz de oro | El ratio actual |
| vs. media histórica (~50) | Desviación porcentual respecto a la media histórica del siglo XX |
| Precio justo de la plata (ratio 50) | A qué precio debería cotizar la plata si el ratio fuera 50 |
| Plata necesaria para 1 oz de oro | Ozs y valor en euros al precio actual |

- Si el ratio está **por encima de 50** → la plata está relativamente barata frente al oro (banner verde).
- Si el ratio está **por debajo de 50** → la plata está relativamente cara frente al oro (banner rojo).
