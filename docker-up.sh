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
    if grep -q "^$1=" .env; then
        awk -v k="$1" -v v="$2" \
            'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' .env > .env.tmp
        mv .env.tmp .env
    else
        printf '%s=%s\n' "$1" "$2" >> .env
    fi
}

# ── 1. .env ───────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
    cp .env.example .env
    chmod 600 .env 2>/dev/null || true
    echo "Creado .env a partir de .env.example."
fi

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

# IP de la LAN, para no tener que buscarla a mano en el servidor.
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$LAN_IP" ] || LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')
[ -n "$LAN_IP" ] || LAN_IP="<IP_DEL_SERVIDOR>"

echo
echo "Portfolio levantado:"
echo "  Esta máquina : http://localhost:$PORT"
echo "  Red local    : http://$LAN_IP:$PORT"
