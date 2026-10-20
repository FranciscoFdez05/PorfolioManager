#!/usr/bin/env sh
# Vigilante del host: recoge la señal que deja Ajustes y actualiza.
#
# El botón «Actualizar» de la aplicación no puede ejecutar docker-update.sh —el
# contenedor no tiene Docker, ni el repositorio, y el script pararía y
# recrearía el contenedor que lo está ejecutando, matándolo justo antes de la
# comprobación de arranque y del retroceso automático—. Lo que hace es dejar un
# fichero en data/tmp/. Este script, que corre EN EL HOST cada pocos segundos,
# lo recoge y lanza la actualización de verdad, desde fuera.
#
# Instalación: ver README.md de este directorio.
#
# Uso:  portfolio-actualizador.sh [ruta-del-proyecto]
set -e

PROYECTO="${1:-${PM_PROYECTO:-$(cd "$(dirname "$0")/../.." && pwd)}}"
cd "$PROYECTO"

# El volumen de datos puede estar fuera del proyecto: es el mismo que monta
# docker-compose, así que la señal aparece donde diga esta variable.
DATOS="./data"
if [ -f .env ]; then
    configurado=$(sed -n 's/^PORTFOLIO_HOST_DATA_DIR=//p' .env | head -n 1)
    [ -n "$configurado" ] && DATOS="$configurado"
fi

SENAL="$DATOS/tmp/actualizacion.solicitada"
ESTADO="$DATOS/tmp/actualizacion.estado"
REGISTRO="./logs/actualizacion.log"
CERROJO="$DATOS/tmp/actualizacion.lock"
# docker-update.sh deja aquí la fase en curso: es la barra de progreso de Ajustes.
FASE="$DATOS/tmp/actualizacion.fase"

escribir_json() {
    # $1 estado · $2 código · $3 detalle ya escapado. Se escribe en un temporal y se
    # renombra: la aplicación lee este fichero cada pocos segundos y no puede
    # pillarlo a medias. Si algo falla aquí no es motivo para dejar de actualizar.
    mkdir -p "$(dirname "$ESTADO")" 2>/dev/null || return 0
    # mktemp y no "$ESTADO.tmp.$$": data/tmp lo escribe también el contenedor, y
    # un nombre predecible le dejaría plantar un enlace simbólico que el host,
    # al hacer `>`, seguiría hasta un fichero suyo. mktemp crea el fichero en
    # exclusiva y falla si ya existe.
    temporal=$(mktemp "$ESTADO.tmp.XXXXXX" 2>/dev/null) || return 0
    # mktemp crea el fichero en 0600 y mv lo conserva: la aplicación corre con
    # otro usuario cuando PUID no coincide con el del host y no podría leerlo.
    chmod 644 "$temporal" 2>/dev/null || true
    {
        printf '{\n'
        printf '  "estado": "%s",\n' "$1"
        printf '  "momento": "%s",\n' "$(date -Is)"
        printf '  "codigo": %s,\n' "$2"
        printf '  "detalle": "%s"\n' "$3"
        printf '}\n'
    } > "$temporal" 2>/dev/null && mv -f "$temporal" "$ESTADO" 2>/dev/null || rm -f "$temporal" 2>/dev/null
    return 0
}

# Constancia de vida: la pantalla de Ajustes avisa de que el vigilante «no da
# señales» mientras no exista el fichero de estado, y sin esto no aparecería hasta
# la primera actualización. Solo se crea si falta, para no pisar un ok/fallo real.
if [ ! -f "$ESTADO" ]; then
    escribir_json "inactivo" 0 "Vigilante instalado, sin actualizaciones pedidas"
fi

[ -f "$SENAL" ] || exit 0

# El cerrojo guarda el pid de quien lo tiene. Si ese proceso ya no existe (el
# host se reinició a mitad, o systemd lo mató con SIGKILL y el `trap` no corrió)
# o el cerrojo tiene más de MINUTOS_CERROJO minutos (más que el TimeoutStartSec
# del servicio, y a prueba de que el pid lo haya reutilizado otro proceso tras
# un reinicio), está obsoleto: sin esto, un cerrojo huérfano dejaba el botón
# «Actualizar» sin efecto para siempre, porque el directorio vive en el volumen.
MINUTOS_CERROJO=35

cerrojo_obsoleto() {
    if [ -f "$CERROJO/pid" ]; then
        pid=$(cat "$CERROJO/pid" 2>/dev/null)
        case "$pid" in
            ''|*[!0-9]*) return 0 ;;
        esac
        kill -0 "$pid" 2>/dev/null || return 0
        [ -n "$(find "$CERROJO/pid" -mmin "+$MINUTOS_CERROJO" 2>/dev/null)" ]
        return
    fi
    # Sin pid: otra pasada acaba de crear el directorio y aún no lo ha escrito.
    # Se le da un minuto de margen antes de darlo por abandonado.
    [ -n "$(find "$CERROJO" -maxdepth 0 -mmin +1 2>/dev/null)" ]
}

# `mkdir` es atómico en POSIX: si otra pasada del temporizador ya está dentro,
# esta se va sin hacer nada en vez de lanzar dos compilaciones a la vez.
if ! mkdir "$CERROJO" 2>/dev/null; then
    cerrojo_obsoleto || exit 0
    # mv y no rm: es atómico, así que de dos pasadas que lo vean obsoleto a la
    # vez solo una se lo lleva, y la otra no borra el cerrojo recién creado.
    mv "$CERROJO" "$CERROJO.obsoleto.$$" 2>/dev/null || exit 0
    rm -rf "$CERROJO.obsoleto.$$"
    mkdir "$CERROJO" 2>/dev/null || exit 0
fi
echo "$$" > "$CERROJO/pid"
trap 'rm -rf "$CERROJO"' EXIT

# Consumir la señal ANTES de empezar. Si se borrara al terminar, una
# actualización que deje el host sin batería a mitad volvería a dispararse sola
# en el siguiente arranque, sin que nadie lo haya pedido.
rm -f "$SENAL"

escribir_estado() {
    # $1 estado · $2 código de salida · $3 detalle (una línea)
    # La salida de docker-update.sh lleva colores ANSI (ESC[1;36m…): sin quitarlos,
    # el ESC se cuela en el JSON, que no admite caracteres de control, y la
    # aplicación descarta el fichero entero como si el vigilante no existiera.
    esc=$(printf '\033')
    detalle=$(printf '%s' "$3" | sed "s/${esc}\[[0-9;]*[A-Za-z]//g" | tr '\n\r\t' '   ' | tr -d '\000-\037\177' \
        | sed 's/\\/\\\\/g; s/"/\\"/g' | cut -c1-500)
    escribir_json "$1" "$2" "$detalle"
}

mkdir -p "$(dirname "$REGISTRO")"
escribir_estado "en_marcha" 0 "Actualización lanzada desde Ajustes"

# logs/ también lo monta el contenedor con escritura. Si alguien con acceso a él
# convirtiera el registro en un enlace simbólico, este script (que corre en el
# host con permisos de Docker) escribiría en el destino del enlace. Se quita el
# enlace y el registro se abre una sola vez en el descriptor 3: cambiar después
# la ruta ya no afecta a lo que se escribe.
[ -L "$REGISTRO" ] && rm -f "$REGISTRO"
exec 3>> "$REGISTRO"

# Copia privada de la salida, fuera de los volúmenes compartidos: la cola que
# llega a Ajustes sale de aquí y no de releer el registro, que en ese momento
# podría apuntar a cualquier fichero del host y acabaría expuesto en pantalla.
SALIDA=$(mktemp)
CODIGO=$(mktemp)
trap 'rm -f "$SALIDA" "$CODIGO"; rm -rf "$CERROJO"' EXIT

{
    echo "───────────────────────────────────────────────────────────────"
    echo "$(date -Is)  Actualización solicitada desde Ajustes"
} >&3

# La fase de la actualización anterior no puede pasar por la de esta.
rm -f "$FASE"
# En sh POSIX una tubería devuelve el código del último comando (tee), así que
# el de docker-update.sh se guarda aparte.
{
    codigo=0
    PM_FASE_ARCHIVO="$FASE" ./docker-update.sh 2>&1 || codigo=$?
    echo "$codigo" > "$CODIGO"
} | tee "$SALIDA" >&3
codigo=$(cat "$CODIGO" 2>/dev/null)
[ -n "$codigo" ] || codigo=1

# El contenedor de la aplicación ya se ha reiniciado a estas alturas, así que
# este resultado es lo único que le va a llegar a la pantalla: la cola del
# registro es lo que permite entender un fallo sin entrar por SSH.
cola=$(tail -n 5 "$SALIDA" 2>/dev/null || echo "")

if [ "$codigo" -eq 0 ]; then
    escribir_estado "ok" 0 "$cola"
else
    escribir_estado "fallo" "$codigo" "$cola"
fi

exit 0
