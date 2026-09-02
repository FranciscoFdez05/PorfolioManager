#!/usr/bin/env sh
# Levanta el stack listo para usarse desde cualquier dispositivo de la LAN.
#
# Se encarga de las tres cosas que hay que hacer antes de "docker compose up":
#   1. Crear .env (a partir de .env.example) si aún no existe.
#   2. Generar SECRET_KEY y, en el primer arranque, las credenciales de acceso.
#   3. Leer el puerto de config.ini y exportarlo como PORT, para que el mapeo
#      host:contenedor de docker-compose.yml coincida siempre con el valor real
#      que usa la app.
#
# Uso: ./docker-up.sh [args extra para docker compose up]
set -e
cd "$(dirname "$0")"

# Este script escribe .env y Docker monta data/, logs/ y API/ desde este
# directorio. Ejecutarlo con sudo deja esos ficheros como root y el siguiente
# arranque normal falla al crear .env.tmp. Docker no necesita sudo cuando el
# usuario pertenece al grupo docker.
if [ "$(id -u)" -eq 0 ]; then
    echo "ERROR: no ejecutes docker-up.sh con sudo." >&2
    echo "       Haría que .env y los datos quedasen propiedad de root." >&2
    echo "       Ejecútalo como tu usuario normal: ./docker-up.sh" >&2
    exit 1
fi

PERMISSION_CHECK=".docker-up-permission-test.$$"
if ! (umask 077 && : > "$PERMISSION_CHECK") 2>/dev/null; then
    echo "ERROR: no se puede escribir en $(pwd)." >&2
    echo "       El directorio puede estar montado como solo lectura o tener" >&2
    echo "       permisos/ACL que impiden escribir al usuario $(id -un)." >&2
    echo "       Comprueba con: touch \"$PERMISSION_CHECK\"" >&2
    echo "       Si fue ejecutado antes con sudo, repara los permisos con:" >&2
    echo "       sudo chown -R \"$(id -un):$(id -gn)\" \"$(pwd)\"" >&2
    exit 1
fi
rm -f "$PERMISSION_CHECK"

if [ -e .env ] && { [ ! -r .env ] || [ ! -w .env ]; }; then
    echo "ERROR: no tienes permiso para leer o actualizar .env." >&2
    echo "       Repara los permisos una sola vez con:" >&2
    echo "       sudo chown \"$(id -un):$(id -gn)\" .env" >&2
    exit 1
fi

# Dar un error accionable antes de modificar .env o empezar una construcción
# larga. `docker compose` requiere Docker Compose v2, integrado en Docker
# Desktop/Engine moderno.
if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: no se ha encontrado Docker en el PATH." >&2
    echo "       Instala Docker Desktop (Windows/macOS) o Docker Engine con Compose v2 (Linux)." >&2
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    echo "ERROR: Docker no está disponible." >&2
    echo "       Inicia Docker Desktop o comprueba que tu usuario tiene acceso al daemon Docker." >&2
    exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
    echo "ERROR: falta Docker Compose v2 (el comando 'docker compose')." >&2
    exit 1
fi

# ── Intérprete Python ─────────────────────────────────────────────────────────
# Se usa para leer config.ini y generar clave/hash. Si el servidor no tiene
# Python instalado se tira de la propia imagen base, que ya hace falta para
# construir el contenedor: así el script no añade ningún requisito nuevo.
if command -v python3 >/dev/null 2>&1; then
    PY_CMD="python3"
elif command -v python >/dev/null 2>&1; then
    PY_CMD="python"
else
    PY_CMD=""
fi

run_py() {
    if [ -n "$PY_CMD" ]; then
        "$PY_CMD" -c "$1"
    else
        docker run --rm -e PW -v "$PWD:/w" -w /w python:3.12-slim python -c "$1"
    fi
}

run_py_file() {
    # Igual que run_py pero ejecutando un script del repositorio, con sus
    # argumentos. Se usa para leer la configuración con la misma capa que la app.
    script="$1"
    shift
    if [ -n "$PY_CMD" ]; then
        "$PY_CMD" "$script" "$@"
    else
        docker run --rm -v "$PWD:/w" -w /w python:3.12-slim python "$script" "$@"
    fi
}

env_get() {
    # Valor de una clave en .env (vacío si no está)
    [ -f .env ] || return 0
    sed -n "s/^$1=//p" .env | head -n 1
}

env_set() {
    # Sustituye la clave si existe, la añade al final si no. Se escribe en un
    # temporal y se renombra para no dejar el .env a medias si algo falla.
    # Docker Compose interpreta `$NOMBRE` en los valores de .env. Los hashes
    # PBKDF2 llevan `$` como separador, por lo que hay que duplicarlo para que
    # llegue literal al contenedor. El awk conserva los `$$` ya escapados para
    # que ejecutar este script más de una vez sea seguro.
    valor=$(printf '%s' "$2" | awk '
        {
            salida = ""
            for (i = 1; i <= length($0); i++) {
                caracter = substr($0, i, 1)
                if (caracter == "$") {
                    siguiente = substr($0, i + 1, 1)
                    if (siguiente == "$") {
                        salida = salida "$$"
                        i++
                    } else {
                        salida = salida "$$"
                    }
                } else {
                    salida = salida caracter
                }
            }
            print salida
        }')
    if grep -q "^$1=" .env; then
        awk -v k="$1" -v v="$valor" \
            'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' .env > .env.tmp
        mv .env.tmp .env
    else
        printf '%s=%s\n' "$1" "$valor" >> .env
    fi
}

migrar_hash_login() {
    # Corrige los .env creados por versiones anteriores, que guardaban el
    # hash como `pbkdf2:...$salt$hash`. Compose tomaba salt y hash por nombres
    # de variables y podía impedir que la aplicación arrancase correctamente.
    hash=$(env_get LOGIN_PASSWORD_HASH)
    [ -n "$hash" ] || return 0
    env_set LOGIN_PASSWORD_HASH "$hash"
}

# ── 1. .env ───────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
    cp .env.example .env
    chmod 600 .env 2>/dev/null || true
    echo "Creado .env a partir de .env.example."
fi

# Debe hacerse antes de consultar las credenciales o de invocar Compose.
migrar_hash_login

# ── 2. SECRET_KEY ─────────────────────────────────────────────────────────────
# Cifra auth.dat y las claves de API en reposo: si cambia, esos ficheros dejan
# de poder descifrarse. Por eso solo se genera cuando falta o sigue siendo el
# placeholder del ejemplo, nunca se regenera sobre una instalación ya en uso.
SECRET_KEY=$(env_get SECRET_KEY)
case "$SECRET_KEY" in
    ""|cambia_esto_por_una_clave_aleatoria_larga)
        if [ -f data/auth.dat ]; then
            echo "AVISO: no hay SECRET_KEY pero sí data/auth.dat. Al generar una" >&2
            echo "       clave nueva las credenciales guardadas y las claves de API" >&2
            echo "       cifradas dejarán de poder leerse." >&2
        fi
        SECRET_KEY=$(run_py "import secrets; print(secrets.token_hex(32))")
        env_set SECRET_KEY "$SECRET_KEY"
        echo "SECRET_KEY generada."
        ;;
esac

# ── 3. Credenciales de acceso ─────────────────────────────────────────────────
# Sin ellas el contenedor arranca pero no deja entrar a nadie, así que se piden
# aquí en el primer arranque. El hash es pbkdf2:sha256 en el mismo formato que
# genera werkzeug, que es quien lo verifica luego en el login.
if [ -z "$(env_get LOGIN_PASSWORD_HASH)" ] && [ ! -f data/auth.dat ]; then
    if [ -t 0 ]; then
        printf 'Usuario de acceso [admin]: '
        read -r LOGIN_USER
        [ -n "$LOGIN_USER" ] || LOGIN_USER="admin"

        stty -echo 2>/dev/null || true
        printf 'Contraseña: '
        read -r PW
        printf '\nRepite la contraseña: '
        read -r PW2
        stty echo 2>/dev/null || true
        printf '\n'

        if [ -z "$PW" ] || [ "$PW" != "$PW2" ]; then
            echo "Las contraseñas no coinciden (o está vacía). No se han configurado" >&2
            echo "credenciales; vuelve a ejecutar ./docker-up.sh." >&2
            exit 1
        fi

        # Las iteraciones salen de [seguridad] hash_iteraciones, para que el
        # hash del primer arranque use el mismo coste que los que genere luego
        # la aplicación al cambiar la contraseña desde Ajustes.
        ITERACIONES=$(run_py_file tools/leer_ajuste.py seguridad.hash_iteraciones) || ITERACIONES=""
        [ -n "$ITERACIONES" ] || ITERACIONES=600000

        export PW ITERACIONES
        HASH=$(run_py "
import hashlib, os, secrets
pw = os.environ['PW'].encode()
salt = secrets.token_hex(8)
it = int(os.environ['ITERACIONES'])
print('pbkdf2:sha256:%d\$%s\$%s' % (
    it, salt, hashlib.pbkdf2_hmac('sha256', pw, salt.encode(), it).hex()))
")
        unset PW PW2
        env_set LOGIN_USERNAME "$LOGIN_USER"
        env_set LOGIN_PASSWORD_HASH "$HASH"
        echo "Credenciales guardadas en .env (podrás cambiarlas desde Ajustes)."
    else
        echo "AVISO: LOGIN_PASSWORD_HASH está vacío y no hay terminal interactiva," >&2
        echo "       así que nadie podrá iniciar sesión. Ejecuta ./docker-up.sh" >&2
        echo "       desde una terminal, o rellena el valor a mano en .env." >&2
    fi
fi

# ── 4. Puerto ─────────────────────────────────────────────────────────────────
# Se lee con la misma capa de configuración que usa la aplicación
# (tools/leer_ajuste.py), no con un configparser aparte: así el puerto del mapeo
# de Docker respeta la prioridad entorno → config.ini → defecto y queda validado
# igual que dentro del contenedor.
PORT=$(run_py_file tools/leer_ajuste.py server.port) || PORT=""
[ -n "$PORT" ] || PORT=5000
export PORT

# ── 5. Arranque ───────────────────────────────────────────────────────────────
docker compose up -d --build "$@"

# `up -d` termina cuando crea el contenedor, no cuando la aplicación puede
# atender peticiones. Esperar el healthcheck evita dar una URL como correcta si
# gunicorn, la base de datos o la configuración han fallado al iniciar.
SERVICIO=porfoliomanager
CONTENEDOR=$(docker compose ps -q "$SERVICIO")
if [ -z "$CONTENEDOR" ]; then
    echo "ERROR: Docker Compose no creó el contenedor $SERVICIO." >&2
    docker compose logs --tail=100 "$SERVICIO" >&2 || true
    exit 1
fi

INTENTOS=24
while [ "$INTENTOS" -gt 0 ]; do
    ESTADO=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTENEDOR" 2>/dev/null || true)
    case "$ESTADO" in
        healthy|running)
            break
            ;;
        unhealthy|exited|dead)
            echo "ERROR: el contenedor no ha arrancado correctamente (estado: $ESTADO)." >&2
            docker compose logs --tail=100 "$SERVICIO" >&2 || true
            exit 1
            ;;
    esac
    INTENTOS=$((INTENTOS - 1))
    sleep 5
done

if [ "$INTENTOS" -eq 0 ]; then
    echo "ERROR: el contenedor no ha superado la comprobación de salud a tiempo." >&2
    docker compose logs --tail=100 "$SERVICIO" >&2 || true
    exit 1
fi

# IP de la LAN, para no tener que buscarla a mano en el servidor.
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$LAN_IP" ] || LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')
[ -n "$LAN_IP" ] || LAN_IP="<IP_DEL_SERVIDOR>"

echo
echo "PorfolioManager levantado:"
echo "  Esta máquina : http://localhost:$PORT"
echo "  Red local    : http://$LAN_IP:$PORT"
