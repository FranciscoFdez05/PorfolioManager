[🇪🇸 Español](README-ESP.md) | [🇬🇧 English](../README.md)

<p align="center">
  <img src="../img/logo-192.png" alt="PorfolioManager" width="128">
</p>

<h1 align="center">PorfolioManager</h1>

<p align="center">
  <a href="../CHANGELOG.md"><img src="https://img.shields.io/badge/versi%C3%B3n-4.9.0-blue" alt="Versión"></a>
  <a href="https://github.com/FranciscoFdez05/PorfolioManager/actions/workflows/ci.yml"><img src="https://github.com/FranciscoFdez05/PorfolioManager/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/Python-3.11%20%7C%203.12%20%7C%203.13-3776AB" alt="Python">
  <img src="https://img.shields.io/badge/Docker-Compose-2496ED" alt="Docker">
  <a href="../LICENSE"><img src="https://img.shields.io/badge/Licencia-GPL--3.0-blue" alt="Licencia"></a>
</p>

---

Aplicación web **autoalojada** para el seguimiento de una cartera de inversión personal. Todo se guarda en SQLite y corre en tu máquina o en un servidor doméstico con Docker.

Las cotizaciones externas son opcionales: sin claves de API, los precios los introduces tú. La interfaz está en español.

## ✨ Características ✨

- **Cartera**: resumen, ficha por activo con precio medio, rendimiento y desglose entre efecto activo y efecto divisa, y planes de inversión.
- **Finanzas**: gastos, ingresos, mensualidades, cuentas de dinero, dividendos, renta fija y bonos.
- **Fiscalidad española**: ventas con FIFO, regla de los dos meses y compensación de pérdidas; informe anual en CSV y HTML.
- **Métricas**: TWR, XIRR, drawdown, volatilidad y comparación con índices.
- **Cripto**: stablecoins, operaciones, conversiones, staking y earn.
- **Operación**: backups automáticos, avisos y comandos por Telegram, verificación en dos pasos opcional con código por Telegram, HTTPS desde la propia aplicación y Atajo de iOS para apuntar gastos desde el móvil.
- **Actualización segura**: `docker-update.sh` comprueba que la versión nueva responde en `/api/health` y vuelve a la imagen anterior si no lo hace.

## 🖥️ Requisitos

| Para | Necesitas |
|---|---|
| **Usarlo** | Docker con Compose v2 (recomendado un servidor Linux), o Python 3.11+ sin Docker |
| **Desarrollar** | Python 3.11+ (la CI prueba 3.11, 3.12 y 3.13) y Node.js 20 para el linter y los tests del frontend |

## 📦 Guía de instalación ⚙️

### Opción 1: Docker (recomendada)

```bash
git clone https://github.com/FranciscoFdez05/PorfolioManager.git
cd PorfolioManager
./docker-setup   # crea .env, genera SECRET_KEY, pide credenciales y puerto, levanta el stack
```

Ejecútalo con tu usuario normal, sin `sudo`. La aplicación queda en `http://localhost:5050` (o `http://<IP_DEL_SERVIDOR>:5050` desde otro equipo de la red local). Los datos se guardan en `data/`, `logs/` y `API/`.

> [!WARNING]
> De serie la aplicación se sirve por HTTP plano, así que la contraseña y la cookie de sesión viajan sin cifrar. Antes de usarla desde otro dispositivo, activa HTTPS en **Ajustes › Seguridad › HTTPS**. Consulta [SECURITY.md](../SECURITY.md).

Para actualizar una instalación existente:

```bash
./docker-update.sh              # git pull, build, arranque y comprobación, con vuelta atrás automática
./docker-update.sh --sin-pull   # igual, sin git pull
```

### Opción 2: desde el código fuente

```bash
git clone https://github.com/FranciscoFdez05/PorfolioManager.git
cd PorfolioManager
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python python/server.py   # http://localhost:5050
```

### Variables de entorno

Los secretos van en `.env` (copia `.env.example`; `./docker-setup` lo hace por ti). El resto de ajustes están en `config.ini`.

| Variable | Descripción | Obligatoria | Por defecto |
|---|---|---|---|
| `SECRET_KEY` | Firma las sesiones y cifra en reposo las claves de API y las credenciales | Sí | La genera `docker-setup` |
| `LOGIN_USERNAME` | Usuario inicial, solo se usa en el primer arranque | Sí | `admin` |
| `LOGIN_PASSWORD_HASH` | Hash de la contraseña inicial (lo genera `docker-setup`) | Sí | vacío |
| `FINNHUB_API_KEY`, `EODHD_API_KEYS`, `ALPHA_VANTAGE_API_KEYS` | Claves de datos de mercado; lo normal es ponerlas en Ajustes › API | No | vacío |
| `TZ` | Zona horaria del contenedor (logs y backups) | No | `Europe/Madrid` |
| `PORT` | Puerto HTTP; sobrescribe `config.ini` | No | `5050` |
| `PUID` / `PGID` | Usuario y grupo con los que escribe el contenedor (Linux) | No | Los fija `docker-setup` |

## 📋 Guía de uso 🕹️

1. Abre `http://localhost:5050` e inicia sesión con las credenciales que elegiste en `docker-setup`.
   En el primer arranque `docker-setup` pregunta cómo crear la cuenta: **1** desde la web, **2** desde la terminal, **3** cerrar. Si te equivocas, vuelve a preguntar. Con la opción web imprime la dirección de `/setup` y un código de verificación de un solo uso (también en `data/tmp/alta-inicial.txt` y en el log del contenedor), para que nadie más de la red pueda quedarse con la cuenta antes que tú.
2. Añade tus activos y operaciones. Sin claves de API, introduce los precios a mano.
3. Opcionalmente, añade claves de Finnhub, EODHD o Alpha Vantage en **Ajustes › API** para tener cotizaciones automáticas.
4. Activa HTTPS en **Ajustes › Seguridad › HTTPS** si entras desde otros dispositivos.
5. Opcionalmente, configura Telegram en **Ajustes › Telegram** (avisos y comandos como `/estado`, `/cartera`, `/backup`).
6. Con Telegram funcionando, puedes activar la verificación en dos pasos en **Ajustes › Cuenta**: cada inicio de sesión pide un código que manda el bot, y una frase de recuperación de 6, 12 o 24 palabras te deja entrar si pierdes el acceso a Telegram.

```bash
docker logs -f PorfolioManager   # ver los logs en tiempo real
docker compose down              # parar el stack
```

Documentación adicional:

- [DOCUMENTACION.md](../DOCUMENTACION.md): guía completa (configuración, claves API, backups, HTTPS, Telegram, fiscalidad, desarrollo).
- [CHANGELOG.md](../CHANGELOG.md), [SECURITY.md](../SECURITY.md), [CONTRIBUTING.md](../CONTRIBUTING.md)
- [Atajo de iOS](atajo-ios.md) y [herramientas propias](herramientas-extra.md)
- [Vigilante de actualización](../tools/actualizador/README.md) para actualizar desde Ajustes

## 🤝 Contribuciones 🤝

1. Haz un fork del repositorio.
2. Crea una rama: `git checkout -b feature/nueva-funcionalidad`.
3. Comprueba que `pytest -m "not network"`, `ruff check .` y `npm test` pasan correctamente.
4. Haz commit y abre un Pull Request.

## 📜 Licencia

📄 Este proyecto está licenciado bajo la Licencia GPL-3.0. Consulta el archivo [`LICENSE`](../LICENSE) para más detalles.

---

<p align="center">
  Desarrollado con ❤️ por <a href="https://github.com/FranciscoFdez05">Francisco</a>
</p>
