# Portfolio Python

Aplicación web **local** para el seguimiento de una cartera de inversión personal. Sin dependencias cloud obligatorias: todo se guarda en **SQLite** y corre en tu máquina (o en cualquier servidor doméstico con Docker).

---

## Características

- **Vista General** — resumen del portfolio con tabla de activos y métricas clave
- **Activos** — ficha por activo: compras/aportes, precio medio y rendimiento
- **Gastos & Ingresos** — gastos por categoría, ingresos recurrentes y puntuales
- **Finanzas** — cuenta remunerada, dividendos, renta fija, bonos y ventas
- **Cripto** — stablecoins, operaciones, transacciones y conversiones
- **Earn / Staking / Trading** — módulos adicionales para rendimientos cripto
- **Métricas** — KPIs y gráficos interactivos
- **Herramientas** — utilidades varias
- **Ajustes** — claves API, caducidad de cotizaciones, backup/restauración y tema

Las cotizaciones se obtienen opcionalmente vía **Finnhub** y **EODHD** (basta con dejar los archivos de clave vacíos para funcionar sin ellas).

---

## Quick start — Docker (recomendado)

**Requisitos:** Docker + Docker Compose.

```bash
git clone https://github.com/FranciscoFdez05/PorfolioPython.git
cd PorfolioPython
docker compose up -d --build
```

| Acceso | URL |
|---|---|
| Misma máquina | `http://localhost:5000` |
| Red local | `http://<IP_DE_LA_MAQUINA>:5000` |

```bash
# Ver logs en tiempo real
docker compose logs -f portfolio

# Parar
docker compose down
```

### Volúmenes montados

| Directorio local | Ruta en contenedor | Uso |
|---|---|---|
| `data/` | `/app/data` | Base de datos SQLite + backups |
| `logs/` | `/app/logs` | Logs en disco |
| `API/` | `/app/API` (solo lectura) | Archivos de claves API |

---

## Quick start — Sin Docker

**Requisitos:** Python 3.10+

```bash
python -m venv .venv

# macOS / Linux
source .venv/bin/activate

# Windows
.venv\Scripts\activate

pip install -r requirements.txt
python python/server.py
```

Abre `http://localhost:5000`.

---

## Claves API (opcional)

Crea el directorio `API/` y coloca los archivos de clave (una clave por archivo, sin saltos de línea extra):

```
API/
├── finnhub.key
└── eodhd.key
```

Sin estos archivos la aplicación funciona igualmente; solo no obtendrá cotizaciones en tiempo real.

---

## Base de datos y backups

- **BD principal:** `data/portfolio.db`
- **Backups automáticos:** `data/backups/` (configurables desde Ajustes)

Backup manual rápido (con el servidor parado):

```bash
cp data/portfolio.db data/portfolio.db.bak
```

---

## Stack

| Capa | Tecnología |
|---|---|
| Backend | Python + Flask + Gunicorn |
| Base de datos | SQLite |
| Frontend | HTML + CSS + JavaScript (sin frameworks) |
| Despliegue | Docker / Docker Compose |

---

## Licencia

Consulta el archivo [LICENSE](LICENSE).
