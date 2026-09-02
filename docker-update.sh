#!/usr/bin/env sh
# Actualiza la instalación en marcha y la deja comprobada.
#
# La actualización a mano era `git pull && ./docker-up.sh`, con tres cosas que
# solo se descubrían tarde:
#
#   1. `config.ini` está versionado y va dentro de la imagen. Si lo has editado
#      en el servidor, el pull da un conflicto en mitad de la actualización.
#      Aquí se comprueba ANTES de tocar nada y se explica que lo que hay que
#      editar en producción es `.env`.
#   2. Nada verificaba que la versión nueva arrancase. El contenedor se quedaba
#      arriba con `restart: unless-stopped` reiniciándose en bucle, y te
#      enterabas al abrir la web. Aquí se espera a que `/api/health` responda,
#      que es una comprobación de verdad: consulta la base de datos.
#   3. `docker compose build` sin etiqueta deja solo la imagen nueva, así que
#      volver atrás era reconstruir desde el código anterior, varios minutos con
#      la base de datos ya migrada. Ahora cada versión queda etiquetada y la
#      vuelta atrás es inmediata.
#
# Si el arranque no responde, se vuelve solo a la imagen anterior. Lo que este
# script NO deshace es la migración del esquema: para eso está la copia
# `data/backups/<portfolio>_pre-esquema-N-a-M_*.db`, cuya ruta se imprime.
#
# Uso: ./docker-update.sh [--sin-pull]
set -e
cd "$(dirname "$0")"

SIN_PULL=0
[ "$1" = "--sin-pull" ] && SIN_PULL=1

SERVICIO="porfoliomanager"
ESPERA_SALUD=90   # segundos que se le dan a la versión nueva para responder

# ── Intérprete Python ─────────────────────────────────────────────────────────
# Mismo criterio que docker-up.sh: si el servidor no lo tiene, se usa la imagen
# base, que hace falta igualmente para construir el contenedor.
if command -v python3 >/dev/null 2>&1; then
    PY_CMD="python3"
elif command -v python >/dev/null 2>&1; then
    PY_CMD="python"
else
    PY_CMD=""
fi

run_py_file() {
    script="$1"
    shift
    if [ -n "$PY_CMD" ]; then
        "$PY_CMD" "$script" "$@"
    else
        docker run --rm -v "$PWD:/w" -w /w python:3.12-slim python "$script" "$@"
    fi
}

version_del_codigo() {
    sed -n 's/^__version__ = "\(.*\)"/\1/p' python/core/version.py | head -n 1
}

aviso()  { printf '\n\033[33m%s\033[0m\n' "$*"; }
error()  { printf '\n\033[31m%s\033[0m\n' "$*" >&2; }
paso()   { printf '\n\033[36m── %s\033[0m\n' "$*"; }

# ── 1. Comprobaciones previas ─────────────────────────────────────────────────
paso "Comprobando el estado local"

if [ ! -f .env ]; then
    error "No hay .env. Esto es una instalación nueva: usa ./docker-up.sh."
    exit 1
fi

# `config.ini` se distribuye con el código y viaja dentro de la imagen, así que
# editarlo en el servidor choca con cada actualización. Todos los ajustes tienen
# variable de entorno equivalente, y ese es el canal que sobrevive a los pulls.
if [ "$SIN_PULL" -eq 0 ] && ! git diff --quiet -- config.ini 2>/dev/null; then
    error "config.ini tiene cambios locales y el pull chocaría con ellos."
    cat <<'FIN'

  config.ini son los valores de fábrica y se actualizan con el código. Para
  configurar esta instalación usa .env: los 45 ajustes tienen su variable de
  entorno, y .env no se versiona, así que sobrevive a las actualizaciones.

  Cada opción de config.ini lleva su nombre de variable en el comentario de
  encima, en la línea que empieza por «· env».

  Para ver qué has cambiado:      git diff config.ini
  Para descartarlo y actualizar:  git checkout -- config.ini && ./docker-update.sh

FIN
    exit 1
fi

VERSION_ANTERIOR=$(version_del_codigo)
[ -n "$VERSION_ANTERIOR" ] || VERSION_ANTERIOR="desconocida"
echo "Versión instalada: $VERSION_ANTERIOR"

# ── 2. Traer los cambios ──────────────────────────────────────────────────────
if [ "$SIN_PULL" -eq 0 ]; then
    paso "Descargando la versión nueva"
    git pull --ff-only
fi

VERSION_NUEVA=$(version_del_codigo)
[ -n "$VERSION_NUEVA" ] || VERSION_NUEVA="desconocida"

if [ "$VERSION_NUEVA" = "$VERSION_ANTERIOR" ]; then
    aviso "Ya estabas en la $VERSION_NUEVA. Se reconstruye igualmente."
else
    echo "Actualizando: $VERSION_ANTERIOR → $VERSION_NUEVA"
    if [ -f CHANGELOG.md ]; then
        paso "Novedades de la $VERSION_NUEVA"
        awk '/^## \[/{n++} n==1{print} n==2{exit}' CHANGELOG.md
    fi
fi

# ── 3. Puerto ─────────────────────────────────────────────────────────────────
# Igual que en docker-up.sh: con la misma capa de configuración que la app, para
# que el mapeo de Docker y el puerto real no puedan desincronizarse.
PORT=$(run_py_file tools/leer_ajuste.py server.port) || PORT=""
[ -n "$PORT" ] || PORT=5000
export PORT
export PORTFOLIO_VERSION="$VERSION_NUEVA"

# ── 4. Construir y levantar ───────────────────────────────────────────────────
paso "Construyendo la imagen $VERSION_NUEVA"
docker compose build

paso "Levantando"
docker compose up -d

# ── 5. Comprobar que arranca de verdad ────────────────────────────────────────
# /api/health consulta la base de datos activa y devuelve 503 si falla, así que
# esperar aquí distingue «el contenedor está arriba» de «la aplicación funciona».
paso "Esperando a que responda (hasta ${ESPERA_SALUD}s)"

sano=0
i=0
while [ "$i" -lt "$ESPERA_SALUD" ]; do
    if curl -fsS "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
        sano=1
        break
    fi
    i=$((i + 1))
    printf '.'
    sleep 1
done
printf '\n'

if [ "$sano" -eq 1 ]; then
    paso "Actualización correcta"
    curl -fsS "http://localhost:${PORT}/api/health" 2>/dev/null || true
    printf '\n\nVersión %s en marcha en el puerto %s.\n' "$VERSION_NUEVA" "$PORT"
    exit 0
fi

# ── 6. Vuelta atrás ───────────────────────────────────────────────────────────
error "La versión $VERSION_NUEVA no responde tras ${ESPERA_SALUD}s. Volviendo atrás."

echo
echo "Últimas líneas del log:"
docker compose logs --tail 40 "$SERVICIO" 2>&1 || true

if [ "$VERSION_ANTERIOR" != "desconocida" ] \
   && docker image inspect "porfoliomanager:${VERSION_ANTERIOR}" >/dev/null 2>&1; then
    paso "Levantando de nuevo la $VERSION_ANTERIOR"
    PORTFOLIO_VERSION="$VERSION_ANTERIOR" docker compose up -d --no-build
    aviso "Se ha vuelto a la $VERSION_ANTERIOR. El código del repositorio SÍ está actualizado:
para dejarlo también como estaba, ejecuta  git checkout v${VERSION_ANTERIOR}"
else
    error "No hay imagen etiquetada de la $VERSION_ANTERIOR; no se puede volver sola."
fi

cat <<'FIN'

  Si la versión nueva llegó a migrar el esquema, los datos ya están migrados y
  volver a la imagen anterior no basta. La copia previa a la migración está en:

      data/backups/<portfolio>_pre-esquema-N-a-M_*.db

  Esa copia no entra en la rotación de backups, así que sigue ahí. Para
  restaurarla, para el contenedor y sustituye el fichero de data/portfolios/.

FIN
exit 1
