#!/bin/sh
set -e
chown -R appuser:appgroup /app/data /app/logs
exec gosu appuser gunicorn \
  --chdir /app/python \
  --bind 0.0.0.0:5000 \
  --worker-class gthread \
  --worker-tmp-dir /tmp \
  --workers 2 \
  --threads 4 \
  --timeout 120 \
  --keep-alive 5 \
  server:app
