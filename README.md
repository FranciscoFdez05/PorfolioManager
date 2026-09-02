# PorfolioManager

[![CI](https://github.com/FranciscoFdez05/PorfolioManager/actions/workflows/ci.yml/badge.svg)](https://github.com/FranciscoFdez05/PorfolioManager/actions/workflows/ci.yml)
[![Versión](https://img.shields.io/badge/versi%C3%B3n-1.0.0-blue)](CHANGELOG.md)
[![Python](https://img.shields.io/badge/python-3.11%20%7C%203.12%20%7C%203.13-blue)](pyproject.toml)
[![Licencia](https://img.shields.io/badge/licencia-GPL--3.0-green)](LICENSE)

Aplicación web **local** para el seguimiento de una cartera de inversión personal. Sin dependencias cloud obligatorias: todo se guarda en **SQLite** y corre en tu máquina (o en cualquier servidor doméstico con Docker).

Nada sale de tu red salvo las consultas de cotizaciones, y esas son opcionales: sin ninguna clave de API la aplicación funciona igual, solo que los precios los introduces tú.

**[Novedades de cada versión →](CHANGELOG.md)**

---

## Índice

| Empezar | Uso | Operación |
|---|---|---|
| [Características](#características) | [Ventas y fiscalidad (España)](#ventas-y-fiscalidad-españa) | [Configuración](#configuración) |
| [Quick start — Docker](#quick-start--docker-recomendado) | [Rentabilidad y riesgo](#rentabilidad-riesgo-y-comparación-con-índices) | [Actualizar](#actualizar) |
| [Quick start — Sin Docker](#quick-start--sin-docker) | [Efecto activo y efecto divisa](#efecto-activo-y-efecto-divisa) | [Base de datos y backups](#base-de-datos-y-backups) |
| [Claves API](#claves-api-opcional) | [Histórico del portfolio](#histórico-del-portfolio) | [Seguridad](#seguridad) |
| [Atajo de iOS](#atajo-de-ios--apuntar-gastos-desde-el-móvil) | [Stack](#stack) | [Desarrollo](#desarrollo) |

---

## Características

- **Vista General** — resumen del portfolio con tabla de activos y métricas clave
- **Activos** — ficha por activo: compras/aportes, precio medio, rendimiento y, en los activos en divisa extranjera, el desglose entre **efecto activo** y **efecto divisa**
- **Planes de inversión** — dentro de la ficha de cada activo: a qué precio entrar, a qué precio recoger el beneficio y con cuánto capital, con el porcentaje que falta desde el precio actual hasta cada uno y el aviso cuando la cotización entra en zona
- **Planes DCA** — también por activo: aportación periódica con importe, frecuencia y horizonte, los aportes ya vencidos, el siguiente y el calendario de los doce próximos
- **Gastos & Ingresos** — gastos por categoría, ingresos recurrentes y puntuales
- **Finanzas** — cuenta remunerada, dividendos, renta fija, bonos y ventas
- **Ventas con FIFO fiscal español** — lotes, regla de los dos meses y escala del ahorro calculados en el servidor, con **informe anual de la Renta** en CSV y en HTML imprimible ([detalle](#ventas-y-fiscalidad-españa))
- **Cripto** — stablecoins, operaciones, transacciones y conversiones
- **Earn / Staking / Trading** — módulos adicionales para rendimientos cripto
- **Métricas** — KPIs y gráficos interactivos, con **TWR, XIRR, máximo drawdown y volatilidad**, y comparación de la evolución contra un índice ([detalle](#rentabilidad-riesgo-y-comparación-con-índices))
- **Histórico automático** — el servidor guarda los puntos de evolución en segundo plano, sin depender de que haya una pestaña abierta
- **Herramientas** — utilidades varias
- **Ajustes** — claves API, caducidad de cotizaciones, backup/restauración, tipos de cambio históricos y tema
- **Atajo de iOS** — alta rápida de gastos e ingresos desde el Centro de Control, restringida a la LAN y a WireGuard ([guía](docs/atajo-ios.md))

Las cotizaciones se obtienen opcionalmente vía **Finnhub**, **EODHD**, **Yahoo Finance** y **Alpha Vantage** (basta con dejar los archivos de clave vacíos para funcionar sin ellas).

---

## Quick start — Docker (recomendado)

**Requisitos:** Docker + Docker Compose.

```bash
git clone https://github.com/FranciscoFdez05/PorfolioManager.git
cd PorfolioManager
./docker-setup
```

`docker-setup` deja el stack listo en un solo paso: comprueba Docker, crea `.env` a partir de `.env.example` si no existe, genera la `SECRET_KEY`, pide usuario y contraseña la primera vez (guarda el hash, nunca la contraseña), lee el puerto de `config.ini` y lanza `docker compose up -d --build`. Solo imprime la URL cuando el healthcheck confirma que la aplicación está lista. Puedes pasarle argumentos extra de `docker compose up`, por ejemplo `./docker-setup --force-recreate`.

Ejecuta el script con tu usuario normal, **sin `sudo`**. Si Docker exige permisos,
añade una vez tu usuario al grupo `docker` con `sudo usermod -aG docker "$USER"`
y vuelve a iniciar sesión.

No hace falta tener Python instalado en el servidor: si no lo encuentra, usa la propia imagen base para generar la clave y el hash.

| Acceso | URL |
|---|---|
| Misma máquina | `http://localhost:5000` |
| Red local | `http://<IP_DEL_SERVIDOR>:5000` |

El contenedor publica el puerto en todas las interfaces del host, así que cualquier dispositivo de la misma red llega poniendo la IP del servidor y el puerto. Si no responde desde otro equipo, casi siempre es el firewall del host: hay que abrir ese puerto (por ejemplo `sudo ufw allow 5000/tcp`).

El puerto por defecto es `5000`, y para cambiarlo pon `PORT` en `.env` (ver [Configuración](#configuración)). `docker-setup` resuelve el valor con la misma capa que usa la aplicación —entorno, luego `config.ini`, luego el defecto— y lo exporta antes de levantar el stack, de modo que `docker-compose.yml`, `entrypoint.sh` y el healthcheck no puedan desincronizarse.

```bash
# Ver logs en tiempo real
docker logs -f PorfolioManager

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

**Requisitos:** Python 3.11 o superior (CI prueba 3.11, 3.12 y 3.13).

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

## Configuración

Hay **dos sitios** y no dan lo mismo. Esta es la parte que más problemas da al actualizar, así que va antes que nada:

| | `config.ini` | `.env` |
|---|---|---|
| Qué es | Los **valores de fábrica** | La configuración de **esta** instalación |
| ¿Va en git? | Sí, se distribuye con el código | No, está en `.gitignore` |
| ¿Sobrevive a un `git pull`? | **No** — se actualiza con el código | Sí |
| Para qué sirve | Leerlo: documenta cada opción y su rango | Cambiar lo que quieras cambiar |

**En producción, edita `.env`.** Los 45 ajustes tienen su variable de entorno equivalente, y el comentario de cada opción en `config.ini` te dice cuál es:

```ini
; Peticiones de escritura (POST/PUT/PATCH/DELETE) por IP y minuto. 0 desactiva el límite.
; [60] · env ESCRITURAS_POR_MINUTO
escrituras_por_minuto = 60
```

Ese `· env ESCRITURAS_POR_MINUTO` es el nombre que va en `.env`:

```bash
ESCRITURAS_POR_MINUTO=120
```

Si editas `config.ini` en el servidor, el siguiente `git pull` te dará un conflicto justo en mitad de la actualización. `docker-update.sh` lo comprueba antes de empezar y te avisa en vez de dejarte a medias.

### Prioridad

```
variable de entorno  →  config.ini  →  valor por defecto del código
```

La resuelve `core/settings.py`, que además valida rangos y avisa en el log de los valores dudosos al arrancar. Un ajuste que falte en `config.ini` no rompe nada: cae al valor por defecto del código, y por eso una versión nueva puede añadir opciones sin que tengas que tocar tu configuración.

### Qué hay en cada sitio

| Sección | Para qué |
|---|---|
| `[server]` | Puerto, host, modo debug |
| `[gunicorn]` | Workers, hilos, timeouts |
| `[rutas]` | Dónde viven `data/`, `logs/` y `API/` (en Docker las fijan los volúmenes) |
| `[seguridad]` | CSP, límites de escritura, sesión |
| `[backups]` | Copias a conservar y timeouts de SQLite |
| `[atajo]` | Endpoints del Atajo de iOS y redes permitidas |
| `[mercado]` | Proveedores, caducidad de cotizaciones, peticiones en paralelo |

Los secretos (`SECRET_KEY`, credenciales, claves de API) van **solo** en `.env` o en `API/*.key`, nunca en `config.ini`.

---

## Actualizar

```bash
./docker-update.sh
```

Hace la actualización entera y la comprueba:

1. Avisa si has editado `config.ini` (ver [Configuración](#configuración)) antes de tocar nada.
2. `git pull` y te enseña las novedades de la versión nueva desde el [CHANGELOG](CHANGELOG.md).
3. Construye la imagen **etiquetada con la versión** y levanta el stack.
4. Espera a que `/api/health` responda. No es un «¿está arriba el contenedor?»: ese endpoint consulta la base de datos y devuelve 503 si falla.
5. Si no responde en 90 segundos, **vuelve solo a la versión anterior** y te enseña el log.

Con `--sin-pull` se salta el paso 2, para cuando ya has traído el código a mano.

### Qué versión estoy corriendo

```bash
curl -s http://localhost:5000/api/health
```

```json
{ "ok": true, "estado": "ok", "version": "1.0.0" }
```

Con la sesión abierta añade el detalle: esquema de la base, portfolio activo, tamaño y tiempo en marcha.

### Volver atrás

Depende de si la versión tocaba el esquema, y el CHANGELOG lo dice en cada entrada.

**Si no lo tocaba** — basta con la imagen anterior, los datos no han cambiado:

```bash
git checkout v1.0.0
PORTFOLIO_VERSION=1.0.0 docker compose up -d --no-build
```

**Si lo subía** — los datos ya están migrados, así que hay que restaurar también el fichero. Antes de migrar, la aplicación deja una copia identificable y **fuera de la rotación de backups**:

```
data/backups/<portfolio>_pre-esquema-1-a-2_2026-08-25_193000.db
```

```bash
docker compose down
cp data/backups/principal_pre-esquema-1-a-2_*.db data/portfolios/principal.db
rm -f data/portfolios/principal.db-wal data/portfolios/principal.db-shm
git checkout v1.0.0
PORTFOLIO_VERSION=1.0.0 docker compose up -d --no-build
```

> Los `-wal` y `-shm` hay que borrarlos: un WAL de la versión nueva reaplicado sobre la base restaurada la corrompería.

### Cómo funcionan las migraciones

El esquema lleva su número en `PRAGMA user_version`. Al abrir cada fichero, `core/db.py` compara ese número con el que espera el código:

- **Igual** — no hace nada. Es el caso normal y no cuesta ni una consulta de más.
- **Menor** — guarda la copia previa y aplica los pasos que falten, en orden.
- **Mayor** (una base creada por una versión posterior, típicamente al restaurar un backup) — la abre sin tocarla y lo avisa en el log, en vez de intentar a ciegas un `ALTER TABLE` sobre un esquema que no conoce.

Las migraciones son solo hacia delante. La vuelta atrás es restaurar el fichero, que es justo para lo que está la copia previa.

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
docker compose exec -u appuser porfoliomanager python tools/generar_clave_movimientos.py

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
docker logs --tail=20 PorfolioManager | grep red_local
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

## Ventas y fiscalidad (España)

El cálculo de ganancias y pérdidas patrimoniales vive en el servidor, no en el navegador. Está partido en tres piezas porque envejecen a ritmos distintos: la aritmética de los lotes no caduca, la normativa cambia con cada reforma y "qué cuenta como adquisición" depende de cómo guarda los datos esta aplicación.

| Pieza | Qué resuelve |
|---|---|
| `core/fifo.py` | Reparto en lotes en `Decimal`, puro y determinista. Las comisiones **suman** al valor de adquisición y **restan** al de transmisión (art. 35 LIRPF). |
| `core/fiscal_es.py` | Escala de la base del ahorro por ejercicio (art. 66), regla de los dos meses o de antiaplicación (art. 33.5.f/g) y compensación del saldo negativo con arrastre a los cuatro ejercicios siguientes (art. 49.1.b). |
| `stores/ventas_fifo.py` | Línea temporal de cada activo: qué filas de la ficha, de las operaciones de cripto y de la tabla de ventas adquieren y cuáles transmiten. |

El FIFO recorre **toda** la historia del activo, no solo las ventas del año abierto en pantalla — que era el error de fondo del cálculo anterior en el navegador: dos ejercicios distintos consumían los mismos lotes y el coste de adquisición salía duplicado. Las minusvalías ya no se recortan a cero, y vender más de lo que hay en cartera (o apuntar la misma venta en la ficha *y* en la tabla de ventas) sale como **incidencia** en vez de tragarse en silencio.

### Informe de la Renta

Cada ejercicio se descarga desde la pantalla de Ventas en dos formatos del mismo cálculo:

| Formato | Ruta | Para qué |
|---|---|---|
| CSV | `/api/ventas/<año>/informe.csv` | Abrirlo en una hoja de cálculo y contrastarlo con la información fiscal que remite el bróker |
| HTML imprimible | `/api/ventas/<año>/informe.html` | *Imprimir → Guardar como PDF*, sin meter una dependencia de generación de PDF en la imagen Docker |

El informe nombra los **conceptos** ("saldo neto de ganancias y pérdidas patrimoniales a integrar en la base del ahorro"), no números de casilla: la numeración del modelo 100 cambia de un ejercicio a otro, y una casilla equivocada en un documento que se va a copiar a Renta Web es peor que no dar ninguna.

> **Fuera de alcance, y advertido dentro del propio informe:** compensación con rendimientos del capital mobiliario (el 25 % del art. 49.1), exención por reinversión y coeficientes de abatimiento de la DT 9ª.

---

## Rentabilidad, riesgo y comparación con índices

En la pestaña de **Métricas**, calculadas por el servidor (`core/rentabilidad.py`) sobre el histórico de snapshots:

| Medida | Qué cuenta |
|---|---|
| **TWR** (acumulada y anualizada) | Encadena el rendimiento de cada subperiodo quitándole el flujo: mide *la cartera*, sin que las aportaciones la distorsionen. Es la cifra comparable contra un índice. |
| **XIRR** | La TIR de los flujos reales con sus fechas: mide *tu dinero*. Si aportaste fuerte justo antes de una subida, la XIRR sube y la TWR no. |
| **Máximo drawdown** y **volatilidad** | Se calculan sobre el índice TWR, no sobre el valor en euros: una retirada de 5.000 € hunde el valor sin que se haya perdido nada, y saldría como una caída del 30 % que nunca existió. |

Hacen falta varios días de histórico para que salgan; hasta entonces la tarjeta lo avisa. La respuesta incluye además la **cobertura** del año, para saber con cuántos huecos se está midiendo. El endpoint es `/api/portfolio/rentabilidad`, y acepta `value`/`invested` para clavar el último punto con lo que hay en pantalla: los snapshots se guardan cada pocos minutos y sin eso las KPIs no cuadrarían con las de arriba.

**Comparación con un índice** — el gráfico de evolución superpone una serie de referencia a elegir: S&P 500, MSCI World, Nasdaq 100, Euro Stoxx 50, IBEX 35 o Bitcoin. Se compara contra el índice TWR de la cartera, no contra su valor en euros: la línea del portfolio no debe subir solo porque se haya aportado. Los cierres se piden a **Yahoo Finance** (el único proveedor conectado que sirve series largas sin clave) y se guardan en la tabla `benchmark_prices`, porque el pasado no cambia y sin caché cada visita a Métricas volvería a bajar años de cotizaciones.

---

## Efecto activo y efecto divisa

Un activo comprado en dólares mostraba un único número de rendimiento en euros, y ese número mezclaba dos cosas que no tienen nada que ver: lo que hizo el activo y lo que hizo el dólar. La ficha del activo ahora lo separa:

```
resultado total = V₁·r₁ − V₀·r₀
efecto activo   = (V₁ − V₀)·r₀     ← el activo, al tipo de cambio del día de la compra
efecto divisa   = V₁·(r₁ − r₀)     ← la divisa, sobre la posición que hay hoy
```

Los dos suman exactamente el total, así que el desglose no contradice a la cifra que ya se venía mostrando. En los activos en euros la línea no aparece: no hay nada que separar.

**Tipos de cambio históricos.** Hace falta el cambio **del día de cada operación**, y ese dato no estaba en ninguna parte: las operaciones guardan importe y divisa, pero el tipo al que se cruzaron se perdía. Se reconstruye pidiendo series diarias a Yahoo Finance (`USDEUR=X`) y se cachea en la tabla `fx_rates` de cada portfolio — en SQLite y no en memoria, para que un reinicio no signifique volver a gastar la cuota. Un tipo de una fecha pasada no cambia nunca, así que no caduca.

En **Ajustes → Tipos de cambio históricos** se ve cuántas operaciones están pendientes de tipo y se rellenan por tandas (una cartera con años de historia son cientos de peticiones; pedirlas de una vez acabaría en timeout). Para los sábados, domingos y festivos —cuando el mercado de divisas cierra— se usa el último cierre anterior y se anota cuál se usó: decirlo es preferible a interpolar un tipo que nunca existió.

---

## Histórico del portfolio

Los puntos de evolución los programaba un `setInterval` del navegador: una semana sin abrir la web era una semana sin histórico, y desde que la rentabilidad anual se calcula con Modified Dietz sobre esos puntos, cada hueco degrada la métrica.

Ahora hay un **hilo en el servidor** (`admin/snapshot_scheduler.py`) que hace el mismo trabajo, con el mismo intervalo de Ajustes y contra la misma función de escritura, de modo que los dos caminos no pueden divergir. Valora la cartera sin navegador de por medio (`stores/valoracion.py`) reutilizando el FIFO del servidor para la posición viva y el mismo despacho de cotizaciones que `/api/market/quote` (`stores/market_data.py`).

No se duplican puntos: el hueco horario lo reclama quien llegue primero, y el servidor espera un margen de gracia por si hay una pestaña abierta que ya tiene los precios en pantalla, para no pedir las cotizaciones dos veces.

```ini
[mercado]
snapshot_servidor = true                  ; env MERCADO_SNAPSHOT_SERVIDOR
snapshot_servidor_gracia_segundos = 120   ; env MERCADO_SNAPSHOT_GRACIA
snapshot_intervalo_minimo_segundos = 60   ; suelo, el intervalo real se elige en Ajustes
```

El intervalo y el alcance (solo el portfolio activo o todos) se eligen en **Ajustes → Evolución del portfolio**. Con `snapshot_servidor = false` el histórico vuelve a depender del navegador.

---

## Base de datos y backups

- **BD activa:** `data/portfolios/<id>.db` (una por portfolio; `data/portfolio.db` es solo el fichero heredado de versiones anteriores)
- **Backups automáticos diarios:** `data/backups/auto/` — se conservan los últimos 14
- **Backups manuales:** `data/backups/` (ZIP con todos los portfolios, ajustes y preferencias)
- **Copias previas a una restauración:** `data/pre_restore/<fecha>/` — se crean solas antes de sobrescribir nada, por si restauras el backup equivocado

Al arrancar se verifica la integridad de la BD activa (`integrity_check` + `foreign_key_check`). Si falla, se intenta reparar y, si no es posible, se restaura desde el backup automático válido más reciente.

El esquema se actualiza solo. Lleva su número en `PRAGMA user_version`, y antes de subirlo se guarda una copia identificable y **exenta de la rotación** — `data/backups/<portfolio>_pre-esquema-N-a-M_*.db` — que es el punto de retorno si una actualización sale mal. El detalle está en [Actualizar](#actualizar).

Dentro de la BD del portfolio hay dos tablas que son **caché y no datos del usuario** — `fx_rates` (tipos de cambio históricos) y `benchmark_prices` (cierres de los índices). Se pueden borrar sin perder nada: se vuelven a bajar, a costa de gastar cuota del proveedor. Los `portfolio_snapshots`, en cambio, no se reconstruyen, así que el purgado desde Ajustes vuelca antes una copia en JSON a `data/pre_restore/`.

Backup manual rápido (con el servidor parado):

```bash
cp data/portfolios/principal.db data/portfolios/principal.db.bak
```

---

## Seguridad

Todo lo que decide si una petición entra o no está recogido en `core/seguridad_app.py`, montado sobre Flask con `instalar(app)`. Estaba suelto en `server.py` como una sucesión de `@app.before_request`, y eso lo dejaba **fuera del alcance de los tests**: importar `server` escribe sobre los datos reales, así que la suite tiene prohibido importarlo y los cinco controles que filtran cada petición eran justo lo único que nadie comprobaba.

El orden de registro importa:

1. **CSRF** — barato, y rechaza antes de tocar nada (`403`).
2. **Tope de cuerpo** — corta los cuerpos enormes antes de leerlos (`413`). `[server] max_cuerpo_mb`, con un tope aparte para importaciones y restauraciones.
3. **Límite de escrituras** — cuenta solo lo que va a llegar a la vista (`429` con `Retry-After`).
4. **Sesión** — el último, para que un `401` no revele si el endpoint existía o si el token era válido.
5. **Cabeceras de respuesta** — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` (cámara, micrófono, geolocalización y pagos cerrados) y CSP.

### Límite de peticiones de escritura

El login ya tenía bloqueo por intentos fallidos, pero era el único freno: una sesión válida podía lanzar miles de `POST` contra `/api/restore` o `/api/backup`, y cada uno abre conexiones, copia ficheros `.db` y hace checkpoint del WAL. Es un contador, no un antifraude — solo pretende que un bucle accidental no tumbe el servidor. La ventana es deslizante (un contador por intervalo fijo dejaría pasar el doble a caballo entre dos intervalos) y vive en memoria del proceso, así que con varios workers de Gunicorn el tope efectivo se multiplica por ese número; se ha preferido eso a añadir Redis a un despliegue que hoy es un contenedor y un fichero SQLite.

```ini
[seguridad]
escrituras_por_minuto = 120         ; 0 desactiva el límite
escrituras_pesadas_por_hora = 30    ; backup, restauración e importación
```

### Content-Security-Policy

`core/csp.py`, activable con `[seguridad] csp_activada` y probable sin levantar el servidor:

- **`script-src` cerrado a `'self'` y con nonce, no `'unsafe-inline'`.** `index.html` lleva un único script en línea (el que aplica el tema guardado antes de pintar, para que no haya destello blanco al cargar); con `'unsafe-inline'` la directiva no protegería de nada. **No hay ningún origen externo**: Chart.js se sirve desde `js/vendor/`, así que `csp_origenes_scripts` viene vacío. Ese ajuste sigue existiendo por si añades una librería externa a conciencia, pero vaciarlo es lo que hace que un HTML inyectado no pueda traerse código de fuera — y de paso, que la aplicación funcione sin internet.
- **`style-src` sí admite `'unsafe-inline'`**: el HTML usa atributos `style=` y varios módulos posicionan tooltips con `el.style.…`. El riesgo que cubre quitarlo (exfiltración por CSS) es mucho menor que el de un script.
- **`connect-src 'self'`**: todas las llamadas a proveedores las hace el servidor. Si el frontend llamara alguna vez directamente a una API externa, esta directiva lo delataría.
- **`frame-src` con `www.tradingview.com`**: la única excepción a `default-src 'self'`. El modal de gráfico de un activo incrusta el widget de TradingView; sin la directiva el navegador bloquea el iframe y pinta su propia página de error, que no menciona la CSP.

---

## Stack

| Capa | Tecnología |
|---|---|
| Backend | Python 3.11+ · Flask · Gunicorn |
| Base de datos | SQLite (WAL), esquema versionado |
| Frontend | HTML + CSS + JavaScript, sin frameworks ni empaquetado |
| Gráficos | Chart.js, servido en local desde `js/vendor/` |
| Despliegue | Docker · Docker Compose |
| Calidad | pytest · coverage · ruff · vitest · eslint · prettier |

---

## Desarrollo

**Backend**

```bash
pip install -r requirements-dev.txt

pytest                      # suite completa
pytest -m "not network"     # lo que corre en CI
pytest --cov --cov-report=term-missing   # cobertura por módulo
ruff check .                # lint
ruff check . --fix          # correcciones automáticas
```

**Frontend** — no hay empaquetado: `js/` se sirve tal cual con etiquetas `<script>`, así que `package.json` solo trae linter, formateador y las pruebas.

```bash
npm ci

npm run lint          # eslint sobre js/
npm run lint:fix
npm run format        # prettier sobre js/ y css/
npm run format:check
npm test              # vitest sobre js/core/
npm run test:watch
npm run test:coverage
```

Las pruebas del frontend viven en `tests-js/` y corren sobre jsdom. Los módulos no exportan nada —declaran funciones en el ámbito global de la página—, así que `tests-js/cargar.js` reproduce lo que hace el navegador con una etiqueta `<script>` y evalúa el fuente en el contexto global. La alternativa era reescribirlos a módulos ESM para poder importarlos, pero entonces las pruebas no estarían ejercitando el código que se sirve.

El linter no es cosmético aquí: `js/cartera/assets.js` pasa de 4.800 líneas y `js/analisis/metricas.js` de 4.400, y sin él un nombre mal escrito o una variable que ya no existe solo se ve cuando el usuario abre esa pantalla. La configuración (`eslint.config.js`) tiene en cuenta que los módulos comparten el ámbito global de la página, que es lo que hace útil a `no-undef`.

La configuración de pytest, ruff y coverage está en `pyproject.toml`. Los tests **nunca tocan `data/`**: usan una BD temporal vía `set_active_db_path()` y no importan `server`, porque ese módulo inicializa los portfolios reales al importarse. Para probar la capa HTTP, `tests/conftest.py` ofrece `crear_app` y `cliente_autenticado`, que montan una app mínima con los blueprints que interesen y la capa de `core/seguridad_app.py` encima — así se puede comprobar de verdad que un `POST` sin token CSRF recibe `403` o que `/api/restore` exige sesión.

El umbral de cobertura (`fail_under = 60`) **no es una meta, es un trinquete**: sirve para que un PR no baje la cobertura sin que nadie se dé cuenta, y sube cuando sube ella. Ese número es del proyecto entero y mezcla un cliente HTTP con el cálculo de la declaración de la renta, así que hay un segundo umbral, del 90 %, solo para los módulos donde un error no da un fallo sino una cifra equivocada: `fifo`, `fiscal_es`, `informe_renta`, `pnl_divisa`, `rentabilidad` y `dinero`.

Dos pruebas merecen mención porque no comprueban comportamiento sino invariantes, y son las que sostienen decisiones que de otro modo se pierden:

- `tests/test_frontera_dinero.py` recorre el AST para exigir que los módulos de importes no llamen a `float()` fuera de la serialización. El dinero se calcula en `Decimal` de principio a fin y esta prueba es lo que impide que vuelva a colarse.
- `tests-js/globales.test.js` comprueba que ningún nombre se declare en dos ficheros de `js/` —los 27 scripts comparten un solo ámbito y el último cargado machaca al anterior— y que `csrf.js` y `api.js` sigan cargándose antes que el resto.

### Integración continua

`.github/workflows/ci.yml` corre cuatro trabajos:

| Trabajo | Qué hace |
|---|---|
| `test` | ruff + pytest con cobertura en Python 3.11/3.12/3.13, umbral aparte para los módulos de cálculo, y publica `coverage.xml` como artefacto |
| `frontend` | `npm ci` + eslint + prettier + vitest, los tres bloqueantes |
| `auditoria` | `pip-audit` sobre las dependencias de producción y de desarrollo, en modo informativo: un aviso publicado hoy no debe bloquear un PR que no lo introdujo |
| `docker` | comprueba que la imagen construye |

`.github/dependabot.yml` abre los PR de actualización (pip, npm, GitHub Actions y Docker), agrupando los cambios menores y de parche en uno solo por semana y dejando los mayores sueltos, que esos sí hay que leerlos.

### Publicar una versión

La versión vive en **`python/core/version.py`** y de ahí la lee `/api/health`. `pyproject.toml`, `package.json` y el CHANGELOG tienen que decir lo mismo; `tests/test_version.py` falla si alguno se queda atrás, que es el olvido típico porque no rompe nada al ejecutar.

En un solo commit:

1. Subir `__version__` en `python/core/version.py`, `pyproject.toml` y `package.json`.
2. Añadir la sección al `CHANGELOG.md`, encabezando el fichero, con su línea **«Esquema de base de datos:»** — es lo que le dice a quien actualiza si podrá deshacerlo volviendo a la imagen anterior o tendrá que restaurar el fichero.
3. Si el cambio toca el esquema, subir `ESQUEMA_VERSION` en `core/db.py` y registrar el paso con `@_migracion(N)`. Los pasos han de ser idempotentes: una base puede tener aplicada parte de uno posterior, porque antes de existir el contador todos se ejecutaban en cada arranque.

Después:

```bash
pytest -m "not network" && npm test
git tag -a v1.1.0 -m "1.1.0"
git push && git push --tags
```

La etiqueta importa: es lo que permite a quien tenga esa versión desplegada volver a ella con `git checkout v1.1.0`.

### Qué número subir

| | Cuándo |
|---|---|
| **MAYOR** | La actualización pide intervención manual: mover ficheros, reconfigurar, o una migración que no se deshace restaurando el backup previo |
| **MENOR** | Funcionalidad nueva. Puede subir el esquema; la migración se aplica sola |
| **PARCHE** | Correcciones. No toca el esquema |

### Estructura del proyecto

```
python/
  server.py          arranque de Flask y rutas estáticas
  core/              infraestructura: paths, db, errors, validation, secret_store,
                     seguridad_app, csp, rate_limit; y el cálculo puro:
                     fifo, fiscal_es, informe_renta, rentabilidad, pnl_divisa
  stores/            acceso a datos y sanitización por dominio; además
                     ventas_fifo, valoracion, market_data, fx_historico, benchmark
  providers/         clientes de cotizaciones + http/text comunes + api_stats
  admin/             portfolios, backups, credenciales y snapshot_scheduler
  routes/            un blueprint por área de la API

js/
  core/              csrf, api, dom, app-core, shared-utils
  cartera/           assets, portfolios, private-market, planes
  finanzas/          gastos, ingresos, ahorro, ventas, dividendos, intereses, bonos
  cripto/            stablecoins, operaciones, transacciones, conversiones,
                     staking, earn, trading-journal
  analisis/          metricas, seguimiento, heatmap, herramientas
  ajustes/           ajustes

html/                fragmentos de página, con las mismas carpetas que js/
                     (+ sesion/ para login, setup y el overlay de ajustes)
css/                 variables, base, components, themes
                     + pages/ con una hoja por pantalla
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
| `core/seguridad_app.py` | CSRF, sesión, tope de cuerpo, límite de escrituras y cabeceras de respuesta, montados con `instalar(app)` sobre cualquier Flask — también sobre la app mínima que construyen los tests. Ver [Seguridad](#seguridad). |
| `core/csp.py` + `core/rate_limit.py` | Content-Security-Policy con nonce y ventana deslizante de escrituras por IP. Aparte de `seguridad_app` para poder afirmar en un test qué contienen exactamente. |
| `core/fifo.py` + `core/fiscal_es.py` + `core/informe_renta.py` | Aritmética de lotes, normativa española y salidas CSV/HTML del ejercicio. La aritmética no caduca y la normativa cambia con cada reforma: por eso están separadas. Ver [Ventas y fiscalidad](#ventas-y-fiscalidad-españa). |
| `core/rentabilidad.py` + `core/pnl_divisa.py` | TWR, XIRR, drawdown y volatilidad sobre los snapshots; y el reparto del resultado entre efecto activo y efecto divisa. Módulos puros: reciben listas y devuelven números, sin Flask ni SQLite. |
| `stores/market_data.py` | Punto único de despacho de cotizaciones por proveedor. El `if provider ==` vivía dentro de `/api/market/quote`, así que añadir un proveedor arreglaba la pantalla y dejaba el histórico valorando con precios viejos. |
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
