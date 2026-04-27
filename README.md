# Portfolio Python

Aplicación web local para seguimiento de una cartera de inversión: acciones, ETFs, criptomonedas y materias primas. Incluye módulos de gastos, ventas (cálculo de ganancias/pérdidas), intereses, dividendos, transacciones on-chain y stablecoins.

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
