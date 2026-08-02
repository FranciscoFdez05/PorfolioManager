# Portfolio Python

Aplicación web **local** para el seguimiento de una cartera de inversión personal. Sin dependencias cloud obligatorias: todo se guarda en **SQLite** y corre en tu máquina (o en cualquier servidor doméstico con Docker).

---

## Características

- **Vista General** — resumen del portfolio con tabla de activos y métricas clave
- **Activos** — ficha por activo: compras/aportes, precio medio y rendimiento
- **Gastos & Ingresos** — gastos por categoría, ingresos recurrentes y puntuales
- **Finanzas** — cuenta remunerada, dividendos, renta fija, bonos y ventas
- **Cripto** — stablecoins, operaciones, transacciones y conversiones
- **Earn / Staking / Trading** — módulos adicionales para rendimientos cripto
- **Métricas** — KPIs y gráficos interactivos
- **Herramientas** — utilidades varias
- **Ajustes** — claves API, caducidad de cotizaciones, backup/restauración y tema

Las cotizaciones se obtienen opcionalmente vía **Finnhub**, **EODHD**, **Yahoo Finance** y **Alpha Vantage** (basta con dejar los archivos de clave vacíos para funcionar sin ellas).

---

## Quick start — Docker (recomendado)

**Requisitos:** Docker + Docker Compose.

```bash
git clone https://github.com/FranciscoFdez05/PorfolioPython.git
cd PorfolioPython
./docker-up.sh
```

`docker-up.sh` deja el stack listo en un solo paso: crea `.env` a partir de `.env.example` si no existe, genera la `SECRET_KEY`, pide usuario y contraseña la primera vez (guarda el hash, nunca la contraseña), lee el puerto de `config.ini` y lanza `docker compose up -d --build`. Al terminar imprime la URL de acceso desde la LAN.

No hace falta tener Python instalado en el servidor: si no lo encuentra, usa la propia imagen base para generar la clave y el hash.

| Acceso | URL |
|---|---|
| Misma máquina | `http://localhost:5000` |
| Red local | `http://<IP_DEL_SERVIDOR>:5000` |

El contenedor publica el puerto en todas las interfaces del host, así que cualquier dispositivo de la misma red llega poniendo la IP del servidor y el puerto. Si no responde desde otro equipo, casi siempre es el firewall del host: hay que abrir ese puerto (por ejemplo `sudo ufw allow 5000/tcp`).

El puerto se controla con `port` en `config.ini` (sección `[server]`, por defecto `5000`) — esa es la fuente de verdad. `docker-up.sh` lo lee de ahí y lo exporta como `PORT` antes de levantar el stack, así `docker-compose.yml`, `entrypoint.sh` y el healthcheck siempre usan el mismo valor sin tener que tocar varios sitios. Si lanzas `docker compose up` directamente (sin pasar por `docker-up.sh`), se usará el `PORT` que haya en `.env` en su lugar.

```bash
# Ver logs en tiempo real
docker compose logs -f porfoliopython

# Parar
docker compose down
```

### Volúmenes montados

| Directorio local | Ruta en contenedor | Uso |
|---|---|---|
| `data/` | `/app/data` | Base de datos SQLite + backups |
| `logs/` | `/app/logs` | Logs en disco |
| `API/` | `/app/API` | Archivos de claves API (se escriben desde Ajustes) |

---

## Quick start — Sin Docker

**Requisitos:** Python 3.10+

```bash
python -m venv .venv

# macOS / Linux
source .venv/bin/activate

# Windows
.venv\Scripts\activate

pip install -r requirements.txt
python python/server.py
```

Abre `http://localhost:5000`.

---

## Claves API (opcional)

La aplicación soporta cuatro proveedores de cotizaciones:

| Proveedor | Requiere clave | Archivo | Varias claves |
|---|---|---|---|
| **Yahoo Finance** | No — usa endpoints públicos | — | — |
| **Finnhub** | Sí | `API/finnhub.key` | No |
| **EODHD** | Sí | `API/eodhd.key` | Sí |
| **Alpha Vantage** | Sí | `API/alphavantage.key` | Sí |

Para usar Finnhub, EODHD o Alpha Vantage, crea el directorio `API/` y coloca la clave en el archivo correspondiente:

```
API/
├── finnhub.key
├── eodhd.key
└── alphavantage.key
```

**Yahoo Finance** no requiere ningún archivo de clave: se puede seleccionar como proveedor en la ficha de cada activo y funciona directamente.

### Varias claves por proveedor (EODHD y Alpha Vantage)

EODHD y Alpha Vantage admiten múltiples claves para evitar cortes por límite de peticiones. Cuando una clave falla, la aplicación pasa automáticamente a la siguiente.

**Opción 1 — archivo:** una clave por línea (las líneas que empiecen por `#` se ignoran):

```
# API/alphavantage.key
CLAVE_PRINCIPAL
CLAVE_SECUNDARIA
CLAVE_TERCIARIA
```

**Opción 2 — variable de entorno** (útil en Docker):

```
ALPHA_VANTAGE_API_KEYS=CLAVE1,CLAVE2,CLAVE3
EODHD_API_KEYS=CLAVE1,CLAVE2
```

Las claves se rotan en round-robin entre peticiones, distribuyendo la carga.

Sin ningún archivo de clave la aplicación funciona igualmente; solo no obtendrá cotizaciones en tiempo real de los proveedores que lo requieren.

### Cifrado en reposo

Los `API/*.key` se guardan cifrados (Fernet con clave derivada de `SECRET_KEY`) y los ficheros cifrados empiezan por `ENC1:`. La conversión es automática al arrancar: si tienes claves en texto plano de una versión anterior, se leen igual y se reescriben cifradas.

> **Importante:** las claves quedan ligadas a tu `SECRET_KEY`. Si la cambias, habrá que volver a introducirlas desde Ajustes. Lo mismo aplica a `data/auth.dat` (usuario y contraseña).

---

## Base de datos y backups

- **BD activa:** `data/portfolios/<id>.db` (una por portfolio; `data/portfolio.db` es solo el fichero heredado de versiones anteriores)
- **Backups automáticos diarios:** `data/backups/auto/` — se conservan los últimos 14
- **Backups manuales:** `data/backups/` (ZIP con todos los portfolios, ajustes y preferencias)
- **Copias previas a una restauración:** `data/pre_restore/<fecha>/` — se crean solas antes de sobrescribir nada, por si restauras el backup equivocado

Al arrancar se verifica la integridad de la BD activa (`integrity_check` + `foreign_key_check`). Si falla, se intenta reparar y, si no es posible, se restaura desde el backup automático válido más reciente.

Backup manual rápido (con el servidor parado):

```bash
cp data/portfolios/principal.db data/portfolios/principal.db.bak
```

---

## Stack

| Capa | Tecnología |
|---|---|
| Backend | Python + Flask + Gunicorn |
| Base de datos | SQLite |
| Frontend | HTML + CSS + JavaScript (sin frameworks) |
| Despliegue | Docker / Docker Compose |

---

## Desarrollo

```bash
pip install -r requirements-dev.txt

pytest              # suite completa
pytest -m "not network"   # lo que corre en CI
ruff check .        # lint
ruff check . --fix  # correcciones automáticas
```

La configuración de pytest y ruff está en `pyproject.toml`. Los tests **nunca tocan `data/`**: usan una BD temporal vía `set_active_db_path()` y no importan `server`, porque ese módulo inicializa los portfolios reales al importarse.

`.github/workflows/ci.yml` ejecuta lint + tests en Python 3.11/3.12/3.13 y comprueba que la imagen Docker construye.

### Estructura del proyecto

```
python/
  server.py          arranque de Flask, rutas estáticas, CSRF y sesión
  core/              infraestructura: paths, db, errors, validation, secret_store
  stores/            acceso a datos y sanitización por dominio
  providers/         clientes de cotizaciones + http/text comunes + api_stats
  admin/             portfolios, backups y credenciales
  routes/            un blueprint por área de la API

js/
  core/              csrf, api, dom, app-core, shared-utils
  cartera/           assets, portfolios, private-market
  finanzas/          gastos, ingresos, ahorro, ventas, dividendos, intereses, bonos
  cripto/            stablecoins, operaciones, transacciones, conversiones,
                     staking, earn, trading-journal
  analisis/          metricas, seguimiento, heatmap, herramientas
  ajustes/           ajustes

html/                fragmentos de página, con las mismas carpetas que js/
                     (+ sesion/ para login, setup y el overlay de ajustes)
css/                 variables, base, components, pages, themes
```

`python/` es la raíz de importación (`gunicorn --chdir python server:app`), así que los paquetes se importan como `from core.db import …`, `from stores.gastos_store import …`.

**Rutas del sistema de ficheros:** todas salen de `core/paths.py` (`BASE_DIR`, `DATA_DIR`, `API_DIR`, `HTML_DIR`…). Ningún módulo debe recalcular la raíz con `Path(__file__).parent.parent`: esa cuenta depende de la profundidad del fichero y se rompe al mover nada de sitio.

**Fragmentos HTML:** `loadPage()` resuelve la carpeta con el mapa `_PAGE_DIRS` de `js/core/app-core.js`. Al añadir una página nueva dentro de una subcarpeta hay que registrarla ahí; si no aparece en el mapa se busca en la raíz de `html/`.

### Piezas transversales del backend

| Módulo | Responsabilidad |
|---|---|
| `core/errors.py` | Excepciones de negocio (`ValidationError`, `NotFoundError`, `ConflictError`, `UpstreamError`) y manejadores globales. Todo lo que cuelga de `/api/` responde JSON `{ok:false, error, requestId}`, incluso ante un fallo no previsto, y el detalle interno solo va al log. |
| `core/validation.py` | Normalización de la entrada de las rutas (`as_text`, `as_number`, `as_year`, `as_rows`, `one_of`…) con límites de longitud y de número de filas. |
| `core/paths.py` | Única fuente de verdad de las rutas del proyecto. |
| `providers/` | Capa común de los cuatro clientes de cotizaciones: `http.py` (reintentos con backoff, `Retry-After`, tope de tamaño de respuesta, JSON malformado tratado como error de red) y `text.py` (formato numérico y normalización de símbolos). |

Cada respuesta lleva la cabecera `X-Request-Id`; ese mismo identificador aparece en el log y en el cuerpo del error, así que un fallo reportado por el usuario se localiza buscando esa cadena en `logs/`.

### Piezas transversales del frontend

| Fichero | Responsabilidad |
|---|---|
| `js/core/csrf.js` | Envuelve `fetch` para adjuntar la cabecera CSRF. Debe cargarse el primero. |
| `js/core/api.js` | `Api.get/post/put/del`: timeout, reintento de las lecturas, mensaje de error real del servidor y redirección al login cuando caduca la sesión (esto último se aplica también a las llamadas a `fetch` sin migrar). |
| `js/core/dom.js` | `escapeHtml`, constructores de nodos (`el`, `setText`, `clearNode`) y avisos no bloqueantes (`showToast`, `showError`). |

---

## Licencia

Consulta el archivo [LICENSE](LICENSE).
