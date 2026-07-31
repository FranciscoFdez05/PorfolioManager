#!/bin/sh
set -e
# API/ está montado desde el host: sin este chown appuser no podría guardar las
# claves que se editan desde Ajustes.
chown -R appuser:appgroup /app/data /app/logs /app/API
exec gosu appuser gunicorn \
  --chdir /app/python \
  --bind 0.0.0.0:"${PORT:-5000}" \
  --worker-class gthread \
  --worker-tmp-dir /tmp \
  --workers 2 \
  --threads 4 \
  --timeout 120 \
  --keep-alive 5 \
  server:app
