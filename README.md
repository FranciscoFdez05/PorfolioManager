<p align="center">
  <img src="img/logo-192.png" alt="PorfolioManager" width="128">
</p>

<h1 align="center">PorfolioManager</h1>

<p align="center">
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/versi%C3%B3n-4.8.0-blue" alt="Versión 4.8.0"></a>
  <a href="https://github.com/FranciscoFdez05/PorfolioManager/actions/workflows/ci.yml"><img src="https://github.com/FranciscoFdez05/PorfolioManager/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/Python-3.11%20%7C%203.12%20%7C%203.13-3776AB" alt="Python 3.11 | 3.12 | 3.13">
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED" alt="Docker Compose">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPL--3.0-blue" alt="License: GPL-3.0"></a>
</p>

Aplicación web **autoalojada** para el seguimiento de una cartera de inversión personal. Todo se guarda en SQLite y corre en tu máquina o en un servidor doméstico con Docker. Las cotizaciones externas son opcionales: sin claves de API, los precios los introduces tú.

## Características

- **Cartera** — resumen, ficha por activo con precio medio, rendimiento y desglose entre efecto activo y efecto divisa, y planes de inversión.
- **Finanzas** — gastos, ingresos, mensualidades, cuentas de dinero, dividendos, renta fija y bonos.
- **Fiscalidad española** — ventas con FIFO, regla de los dos meses y compensación de pérdidas; informe anual en CSV y HTML.
- **Métricas** — TWR, XIRR, drawdown, volatilidad y comparación con índices.
- **Cripto** — stablecoins, operaciones, conversiones, staking y earn.
- **Operación** — backups automáticos, avisos y comandos por Telegram, HTTPS desde la propia aplicación y Atajo de iOS para apuntar gastos.

## Instalación

Con Docker:

```bash
git clone https://github.com/FranciscoFdez05/PorfolioManager.git
cd PorfolioManager
./docker-setup
```

Sin Docker (Python 3.11+):

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python python/server.py
```

La aplicación queda en `http://localhost:5000`.

## Documentación

La guía completa está en **[DOCUMENTACION.md](DOCUMENTACION.md)**: configuración, claves API, actualización y migraciones, backups, HTTPS, seguridad, Telegram, fiscalidad y desarrollo.

Otros documentos: [CHANGELOG](CHANGELOG.md) · [SECURITY](SECURITY.md) · [CONTRIBUTING](CONTRIBUTING.md) · [Atajo de iOS](docs/atajo-ios.md) · [Herramientas extra](docs/herramientas-extra.md)

## Stack

Python · Flask · Gunicorn · SQLite · JavaScript sin frameworks · Chart.js · Docker

## Licencia

[GPL-3.0](LICENSE)
