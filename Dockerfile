FROM python:3.15.2-slim@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Lo que no depende del código va antes de COPY . : así un cambio en python/ o
# js/ reutiliza estas capas en vez de volver a instalar gosu con apt.
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -r appgroup \
 && useradd -r -g appgroup appuser \
 && mkdir -p /app/data /app/logs /app/API /home/appuser

# requirements.txt es el lock (versiones exactas y hashes, generado desde
# requirements.in con pip-compile): --require-hashes hace que un paquete que no
# coincida byte a byte con el que se fijó no se instale.
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r /app/requirements.txt

COPY . /app

RUN chmod +x /app/entrypoint.sh

# Solo documentativo: el puerto real sale de [server] port en config.ini y lo
# aplican entrypoint.sh (dentro) y docker-compose.yml (en el mapeo).
EXPOSE 5080

ENTRYPOINT ["/app/entrypoint.sh"]
