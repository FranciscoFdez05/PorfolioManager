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

escribir_json() {
    # $1 estado · $2 código · $3 detalle ya escapado. Se escribe en un temporal y se
    # renombra: la aplicación lee este fichero cada pocos segundos y no puede
    # pillarlo a medias. Si algo falla aquí no es motivo para dejar de actualizar.
    mkdir -p "$(dirname "$ESTADO")" 2>/dev/null || return 0
    temporal="$ESTADO.tmp.$$"
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

# `mkdir` es atómico en POSIX: si otra pasada del temporizador ya está dentro,
# esta se va sin hacer nada en vez de lanzar dos compilaciones a la vez.
if ! mkdir "$CERROJO" 2>/dev/null; then
    exit 0
fi
trap 'rmdir "$CERROJO" 2>/dev/null || true' EXIT

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

{
    echo "───────────────────────────────────────────────────────────────"
    echo "$(date -Is)  Actualización solicitada desde Ajustes"
} >> "$REGISTRO"

codigo=0
./docker-update.sh >> "$REGISTRO" 2>&1 || codigo=$?

# El contenedor de la aplicación ya se ha reiniciado a estas alturas, así que
# este resultado es lo único que le va a llegar a la pantalla: la cola del
# registro es lo que permite entender un fallo sin entrar por SSH.
cola=$(tail -n 5 "$REGISTRO" 2>/dev/null || echo "")

if [ "$codigo" -eq 0 ]; then
    escribir_estado "ok" 0 "$cola"
else
    escribir_estado "fallo" "$codigo" "$cola"
fi

exit 0
