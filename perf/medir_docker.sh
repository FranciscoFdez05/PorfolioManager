#!/bin/sh
# Métricas de Docker: tiempo de build, tamaño de imagen, tiempo de arranque
# hasta healthy y uso de CPU/RAM en reposo y bajo carga.
#
# Se ejecuta en el servidor, desde la raíz del proyecto:
#     sh perf/medir_docker.sh [segundosDeCarga]
#
# Construye con otra etiqueta (porfoliomanager:perf) y arranca un contenedor
# aparte (porfoliomanager-perf, puerto 5099) sobre una COPIA de data/ en un
# directorio temporal: no toca el stack en marcha ni sus volúmenes. Al acabar
# borra el contenedor y la copia; la imagen se queda para comparar.
set -eu

segundosCarga="${1:-20}"
etiqueta="porfoliomanager:perf"
nombre="porfoliomanager-perf"
puerto=5099
tmp=$(mktemp -d)
trap 'docker rm -f "$nombre" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT

echo "== Build (sin caché) =="
inicio=$(date +%s.%N)
docker build --no-cache -q -t "$etiqueta" . >/dev/null
fin=$(date +%s.%N)
echo "segundosBuildSinCache=$(echo "$fin - $inicio" | bc)"

echo "== Build (con caché, tras tocar un .py) =="
touch python/server.py
inicio=$(date +%s.%N)
docker build -q -t "$etiqueta" . >/dev/null
fin=$(date +%s.%N)
echo "segundosBuildConCache=$(echo "$fin - $inicio" | bc)"

echo "== Tamaño de imagen =="
docker image inspect "$etiqueta" --format 'bytesImagen={{.Size}}'
docker history --no-trunc --format '{{.Size}}\t{{.CreatedBy}}' "$etiqueta" | head -8

echo "== Arranque =="
mkdir -p "$tmp/data/portfolios" "$tmp/data/JSON" "$tmp/logs" "$tmp/API"
cp data/portfolios/*.db "$tmp/data/portfolios/" 2>/dev/null || true
cp data/JSON/*.json "$tmp/data/JSON/" 2>/dev/null || true
cp data/portfolios.json "$tmp/data/" 2>/dev/null || true
inicio=$(date +%s.%N)
docker run -d --name "$nombre" -p "$puerto:5000" \
  -e PORT=5000 -e PROXY_FIX_HOPS=0 -e MERCADO_SNAPSHOT_SERVIDOR=false -e ACTUALIZACION_COMPROBAR=false \
  -e SECRET_KEY="perf-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" \
  -v "$tmp/data:/app/data" -v "$tmp/logs:/app/logs" -v "$tmp/API:/app/API" \
  "$etiqueta" >/dev/null
until curl -fs "http://127.0.0.1:$puerto/api/health" >/dev/null 2>&1; do sleep 0.1; done
fin=$(date +%s.%N)
echo "segundosHastaHealth=$(echo "$fin - $inicio" | bc)"

echo "== Reposo (5 s) =="
sleep 5
docker stats --no-stream --format 'reposo cpu={{.CPUPerc}} mem={{.MemUsage}}' "$nombre"

echo "== Bajo carga ($segundosCarga s contra /api/health y estáticos) =="
fin=$(( $(date +%s) + segundosCarga ))
( while [ "$(date +%s)" -lt "$fin" ]; do
    curl -s -o /dev/null "http://127.0.0.1:$puerto/js/core/app-core.js" -H 'Accept-Encoding: gzip'
  done ) &
( while [ "$(date +%s)" -lt "$fin" ]; do
    curl -s -o /dev/null "http://127.0.0.1:$puerto/css/components.css" -H 'Accept-Encoding: gzip'
  done ) &
sleep $(( segundosCarga / 2 ))
docker stats --no-stream --format 'carga cpu={{.CPUPerc}} mem={{.MemUsage}}' "$nombre"
wait
