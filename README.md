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
- **Atajo de iOS** — alta rápida de gastos e ingresos desde el Centro de Control, restringida a la LAN y a WireGuard ([guía](docs/atajo-ios.md))

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

## Atajo de iOS — apuntar gastos desde el móvil

Añadido opcional para dar de alta un gasto o un ingreso desde el Centro de Control del iPhone, sin abrir la web. Escribe en las mismas tablas que la aplicación, así que lo apuntado desde el móvil aparece en la pestaña de Gastos o Ingresos como cualquier otra fila. La web app funciona exactamente igual con esto activado o desactivado.

Solo se aceptan peticiones desde la LAN y desde el túnel de WireGuard, firmadas con HMAC-SHA256.

### 1. Generar la clave de firma

Hay que hacerlo **en la máquina donde corre el servidor**, no en la de desarrollo: la clave se cifra con la `SECRET_KEY` de ese `.env` y se lee desde ahí.

```bash
# Con Docker (lo habitual)
docker compose exec -u appuser porfoliopython python tools/generar_clave_movimientos.py

# Sin Docker
python tools/generar_clave_movimientos.py
```

Escribe `API/movimientos.key`, ignorado por git y cifrado con `SECRET_KEY` igual que las claves de los proveedores. Sin este paso los endpoints responden `503`.

> El `-u appuser` importa: el contenedor sirve la app como `appuser` y el fichero se crea con permisos `600`. Generado como root, gunicorn no podría leerlo hasta el siguiente reinicio (el `entrypoint.sh` hace `chown` de `API/` al arrancar).

### 2. Ajustar las redes permitidas

En `config.ini`, sección `[atajo]`:

```ini
[atajo]
activado = true
redes_permitidas = 192.168.1.0/24, 10.0.0.0/24
tolerancia_segundos = 60
max_texto_firma = 8192
fichero_clave = API/movimientos.key
```

El primer rango es tu LAN; el segundo, el de WireGuard — ajústalo al `Address` de tu interfaz `wg0`. Reinicia el servidor tras generar la clave.

### 3. Averiguar la dirección del servidor

El Atajo necesita una IP y un puerto. El puerto es el de `[server] port` (5000 por defecto).

```bash
# En el servidor (Linux / Banana Pi)
ip -4 addr show | grep inet

# En el servidor (Windows)
ipconfig

# La IP del túnel de WireGuard
wg show
```

De ahí salen dos direcciones: la de la LAN (`192.168.1.X`) y la del túnel (`10.0.0.X`).

> **Recomendación:** usa la IP de WireGuard en el Atajo y deja el túnel en modo *On-Demand* en el iPhone. Así funciona un único Atajo tanto en casa como fuera, sin tener que mantener dos versiones ni cambiar la URL al salir.

### 4. Comprobar la conexión desde el iPhone

Con el móvil en la misma Wi-Fi (o con WireGuard conectado), abre en Safari:

```
http://192.168.1.X:5000/api/categorias
```

| Lo que ves | Qué significa |
|---|---|
| Un JSON con `categorias` | Todo correcto, ya puedes montar el Atajo |
| `403 Origen no autorizado` | La IP del móvil no cae en `redes_permitidas` |
| `404 Recurso no encontrado` | `activado = false` en `config.ini` |
| No carga nada | Cortafuegos del servidor, IP equivocada, o WireGuard desconectado |

**Si sale `403`, la respuesta te dice con qué IP te ve el servidor** — no hay que adivinarla ni entrar por SSH:

```json
{ "ok": false, "error": "Origen no autorizado", "ip": "10.6.0.2" }
```

Añade esa IP (o su rango) a `redes_permitidas`. Haz la prueba **dos veces, una por Wi-Fi y otra con la VPN conectada**: según si el túnel enmascara o enruta el tráfico, el móvil puede aparecer con su IP del túnel o con la del router, y así configuras los dos rangos de una vez. La misma información queda en el log:

```bash
docker compose logs --tail=20 porfoliopython | grep red_local
```

Este endpoint es el que hace que el Atajo no tenga ninguna categoría escrita a mano dentro: las pide aquí cada vez que se ejecuta, así que una categoría nueva creada desde la web aparece sola en el móvil.

### 5. Montar el Atajo

Los pasos concretos, con los nombres de cada acción de la app Atajos, están en **[docs/atajo-ios.md](docs/atajo-ios.md)**. El flujo es:

```
Elegir del menú (Gasto / Ingreso)
        ↓
GET  /api/categorias        → Elegir de la lista
        ↓
Pedir concepto e importe
        ↓
Construir el JSON en una acción "Texto"
        ↓
POST /api/firmar            → devuelve firma + timestamp
        ↓
POST /api/movimiento        → cabeceras X-Signature y X-Timestamp
```

`/api/firmar` existe porque la acción nativa *Hash* de Atajos no admite HMAC con clave: la firma la calcula el servidor. De paso pone su propio reloj, así que el Atajo no tiene que calcular ningún epoch ni preocuparse por el desfase horario.

### 6. Añadirlo al Centro de Control

Centro de Control → `+` arriba a la izquierda → **Añadir un control** → busca *Atajo* → elige el tuyo. También se puede asignar al botón de Acción (Ajustes → Botón de Acción → Atajo).

### Desactivarlo

`activado = false` en `[atajo]`. Los tres endpoints pasan a responder `404` y la web app no se entera.

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
| `core/config_ini.py` | Lectura de `config.ini` con caché por mtime y prioridad entorno → fichero → defecto. Los ajustes viven en el `.ini`, no como constantes repartidas por el código. |
| `core/red_local.py` + `core/firma_hmac.py` | Autenticación de los endpoints que no pueden usar la sesión de la web app (el Atajo de iOS): filtro de IP por CIDR y firma HMAC-SHA256 sobre timestamp + cuerpo crudo. Se configuran en `[atajo]` de `config.ini`. Ver [docs/atajo-ios.md](docs/atajo-ios.md). |
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
