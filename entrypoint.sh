#!/bin/sh
set -e

# Directorios de datos DENTRO del contenedor. Se leen del entorno porque son los
# mismos valores que ve la aplicación (docker-compose.yml los fija), y así no
# hay dos listas de rutas que puedan separarse.
DATA_DIR="${PORTFOLIO_DATA_DIR:-/app/data}"
LOGS_DIR="${PORTFOLIO_LOGS_DIR:-/app/logs}"
API_DIR="${PORTFOLIO_API_DIR:-/app/API}"

# Subdirectorios que la aplicación crea a demanda. Se adelantan aquí, todavía
# como root, para que el chown de más abajo los alcance: si los creaba el
# proceso ya sin privilegios sobre un volumen ajeno, fallaba justo al guardar.
#
# El `|| true` no es descuido: con un volumen montado de solo lectura, `set -e`
# cortaba aquí con el «mkdir: Read-only file system» del sistema y sin ninguna
# de las indicaciones de más abajo. Quien decide si se puede trabajar es la
# prueba de escritura, que sí explica qué ha pasado y qué hacer.
mkdir -p \
    "$DATA_DIR/portfolios" \
    "$DATA_DIR/JSON" \
    "$DATA_DIR/backups/auto" \
    "$DATA_DIR/tmp" \
    "$LOGS_DIR" \
    "$API_DIR" 2>/dev/null || true

# ── Usuario con el que corre la aplicación ────────────────────────────────────
# En Windows el servidor es el dueño de la carpeta del proyecto y escribir en
# data/ nunca es un problema. En Linux, data/, logs/ y API/ son volúmenes
# montados desde el host y conservan **su** propietario: un uid de sistema
# creado dentro de la imagen no tiene por qué poder escribir en ellos, y el
# resultado es una aplicación que se ve y se navega pero no guarda nada.
#
# Por eso el proceso adopta el uid/gid del dueño del volumen de datos (o el
# PUID/PGID que se indique en .env). Además de arreglar la escritura, deja los
# ficheros que crea el contenedor como propiedad del usuario del host, que
# puede seguir haciendo copias o mirando el directorio sin sudo.
uid_volumen=$(stat -c '%u' "$DATA_DIR" 2>/dev/null || echo 0)
gid_volumen=$(stat -c '%g' "$DATA_DIR" 2>/dev/null || echo 0)

# El 0 no se adopta: sería ejecutar la aplicación como root, que es justo lo
# que evita el usuario sin privilegios. Pasa cuando Docker crea él mismo el
# directorio del bind mount porque no existía en el host.
[ -n "$PUID" ] || { [ "$uid_volumen" != "0" ] && PUID="$uid_volumen"; } || true
[ -n "$PGID" ] || { [ "$gid_volumen" != "0" ] && PGID="$gid_volumen"; } || true
PUID="${PUID:-$(id -u appuser)}"
PGID="${PGID:-$(id -g appuser)}"

if [ "$PGID" != "$(id -g appuser)" ]; then
    groupmod -o -g "$PGID" appgroup 2>/dev/null \
        || echo "AVISO: no se pudo ajustar el gid del grupo a $PGID." >&2
fi
if [ "$PUID" != "$(id -u appuser)" ]; then
    usermod -o -u "$PUID" appuser 2>/dev/null \
        || echo "AVISO: no se pudo ajustar el uid del usuario a $PUID." >&2
fi

# El directorio personal de appuser. gosu fija HOME leyendo /etc/passwd, y ahí
# pone /home/appuser aunque nadie lo haya creado: gunicorn 26 arrancaba su
# «control server» dentro y dejaba un «Control server error: Permission denied:
# '/home/appuser'» en cada arranque. La aplicación funcionaba igual, pero es un
# ERROR en el log que no lo es, y de esos son los que tapan a los de verdad.
mkdir -p /home/appuser 2>/dev/null || true
chown "$PUID:$PGID" /home/appuser 2>/dev/null || true

# El chown ya no es fatal. Con `set -e` a secas, un volumen que no admite
# cambios de propietario (NFS con root_squash, SMB, un disco montado con uid
# fijo) mataba el contenedor en esta línea sin explicar nada; y si el volumen ya
# pertenece a $PUID:$PGID —el caso normal— el chown no hacía falta para empezar.
# Lo que decide si se puede trabajar es la prueba de escritura de más abajo.
if ! chown -R "$PUID:$PGID" "$DATA_DIR" "$LOGS_DIR" "$API_DIR" 2>/dev/null; then
    echo "AVISO: no se ha podido cambiar el propietario de los volúmenes montados." >&2
    echo "       Se continúa; lo que importa es si se puede escribir en ellos." >&2
fi

# ── Prueba de escritura real ──────────────────────────────────────────────────
# No se usa `test -w`: consulta los bits de permiso y acierta poco justo en los
# casos que hay que detectar (montajes de solo lectura, ACL, cuotas). Se crea y
# se borra un fichero con el mismo usuario con el que va a correr gunicorn, que
# es exactamente lo que hará la aplicación al guardar un backup o los ajustes.
puede_escribir() {
    testigo="$1/.escritura-$$"
    gosu appuser sh -c "touch '$testigo' && rm -f '$testigo'" 2>/dev/null
}

explicar_permisos() {
    echo "       El contenedor corre como uid=$PUID gid=$PGID y el volumen montado" >&2
    echo "       no le deja escribir. Desde la carpeta del proyecto en el host:" >&2
    echo "           sudo chown -R $PUID:$PGID data logs API" >&2
    echo "       o fija en .env el usuario con el que quieras que escriba:" >&2
    echo '           PUID=$(id -u)  PGID=$(id -g)   (ejecútalo para ver los tuyos)' >&2
    echo "       Si data/ está en una carpeta de red (NFS, SMB) o en un disco" >&2
    echo "       NTFS/exFAT, muévelo a un disco local: SQLite necesita bloqueos" >&2
    echo "       POSIX que ahí no funcionan." >&2
}

for directorio in "$DATA_DIR" "$DATA_DIR/portfolios" "$DATA_DIR/JSON" \
                  "$DATA_DIR/backups" "$DATA_DIR/tmp"; do
    if ! puede_escribir "$directorio"; then
        echo "ERROR: no se puede escribir en $directorio." >&2
        explicar_permisos
        echo "       Se aborta el arranque: la aplicación se vería bien pero no" >&2
        echo "       guardaría nada (ni backups, ni ajustes, ni operaciones)." >&2
        exit 1
    fi
done

# Estos dos no impiden usar la aplicación, así que solo se avisa: sin logs se
# pierde el registro, y sin API/ no se pueden guardar las claves desde Ajustes.
for directorio in "$LOGS_DIR" "$API_DIR"; do
    if ! puede_escribir "$directorio"; then
        echo "AVISO: no se puede escribir en $directorio." >&2
        explicar_permisos
    fi
done

# Los parámetros de gunicorn salen de la sección [gunicorn] de config.ini (o de
# sus variables de entorno), igual que el resto de ajustes. leer_ajuste.py ya
# aplica prioridad y rangos; si algo falla, se usa el valor de reserva de la
# derecha para no dejar el contenedor sin arrancar por un config mal escrito.
ajuste() {
    valor=$(python /app/tools/leer_ajuste.py "$1" 2>/dev/null) || valor=""
    [ -n "$valor" ] && echo "$valor" || echo "$2"
}

PORT=$(ajuste server.port "${PORT:-5000}")
WORKERS=$(ajuste gunicorn.workers 2)
THREADS=$(ajuste gunicorn.threads 4)
TIMEOUT=$(ajuste gunicorn.timeout 120)
KEEP_ALIVE=$(ajuste gunicorn.keep_alive 5)

echo "Arrancando gunicorn: puerto=$PORT workers=$WORKERS threads=$THREADS timeout=$TIMEOUT usuario=$PUID:$PGID"

exec gosu appuser gunicorn \
  --chdir /app/python \
  --bind 0.0.0.0:"$PORT" \
  --worker-class gthread \
  --worker-tmp-dir /tmp \
  --workers "$WORKERS" \
  --threads "$THREADS" \
  --timeout "$TIMEOUT" \
  --keep-alive "$KEEP_ALIVE" \
  server:app
