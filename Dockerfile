FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app

# Directorios esperados por la app (si no se montan como volumen)
RUN mkdir -p /app/data /app/logs

EXPOSE 5000

# Flask app: python/server.py (no es un paquete); arrancamos desde /app/python
CMD ["gunicorn", "--chdir", "python", "--bind", "0.0.0.0:5000", "--workers", "2", "--threads", "4", "--timeout", "120", "server:app"]
