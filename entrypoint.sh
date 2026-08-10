#!/bin/sh
set -e
# API/ está montado desde el host: sin este chown appuser no podría guardar las
# claves que se editan desde Ajustes.
chown -R appuser:appgroup /app/data /app/logs /app/API

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

echo "Arrancando gunicorn: puerto=$PORT workers=$WORKERS threads=$THREADS timeout=$TIMEOUT"

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
