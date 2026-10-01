FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app

RUN apt-get update && apt-get install -y --no-install-recommends gosu \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -r appgroup \
 && useradd -r -g appgroup appuser \
 && mkdir -p /app/data /app/logs /app/API /home/appuser \
 && chmod +x /app/entrypoint.sh

# Solo documentativo: el puerto real sale de [server] port en config.ini y lo
# aplican entrypoint.sh (dentro) y docker-compose.yml (en el mapeo).
EXPOSE 5000

ENTRYPOINT ["/app/entrypoint.sh"]
