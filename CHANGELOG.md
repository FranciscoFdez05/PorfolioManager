# Changelog

Todos los cambios reseñables de este proyecto.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el
versionado es [SemVer](https://semver.org/lang/es/), interpretado así (aquí no
hay API pública que romper, sino datos de usuario y un despliegue que se
actualiza en sitio):

- **MAYOR** — la actualización pide intervención manual.
- **MENOR** — funcionalidad nueva. Puede subir el esquema; la migración se
  aplica sola al arrancar.
- **PARCHE** — correcciones. No toca el esquema.

Cada versión indica **si toca el esquema de la base de datos**, porque es lo que
decide cómo se deshace la actualización:

- **No lo toca** → basta con volver a la imagen anterior.
- **Lo sube** → al migrar se guarda `data/backups/<portfolio>_pre-esquema-N-a-M_*.db`,
  exento de rotación. Volver atrás es levantar la imagen anterior y restaurar
  ese fichero.

---

## [1.1.0] — 2026-08-26

Planes de inversión y aportación periódica: la ficha de cada activo deja de
contar solo lo que se tiene y pasa a recoger también lo que se piensa hacer con
ello, en dos pestañas nuevas junto a «Compras spot» y «Ventas».

**Esquema de base de datos:** sube a la versión 3. Se crean dos tablas nuevas
—`planes_inversion` y `dca_planes`— sin tocar ninguna fila existente. La copia
previa `data/backups/<portfolio>_pre-esquema-N-a-3_*.db` queda exenta de
rotación. Quien haya probado la versión de desarrollo anterior a este cambio
migra del esquema 2 al 3: ahí sí se pierden los planes que no colgaran de ningún
activo de la cartera, porque ya no habría dónde consultarlos.

### Añadido

- **Planes de inversión.** Pestaña nueva en la ficha del activo: precio de
  entrada, precio de salida y capital frente al precio actual, con el porcentaje
  que falta para llegar a cada uno, el recorrido del plan, las unidades y el
  beneficio estimados, y la posición del precio de hoy entre la entrada y el
  objetivo. Un plan de inversión **no es una operativa de trading**: es una
  compra a plazo, así que no tiene dirección corta ni stop loss.
- **Planes DCA.** Segunda pestaña nueva: importe por aporte, periodicidad
  (semanal, quincenal, mensual o trimestral), fechas de inicio y fin y número de
  aportes objetivo. De ahí se derivan los aportes ya vencidos, el siguiente, lo
  aportado hasta hoy, el total planificado y la equivalencia mensual, que es lo
  que permite comparar un plan semanal con uno trimestral y sumarlos.
- **Calendario de aportes.** Ficha con los doce próximos aportes de un plan DCA:
  fecha, importe, acumulado y unidades estimadas al precio del día.
- **Aviso de zona.** La tarjeta marca cuándo el precio entra en la zona de compra
  o alcanza el objetivo; en un DCA, cuándo supera el precio máximo fijado.
- **Resumen de la pestaña** con el capital planificado y el beneficio potencial
  del activo, en su propia moneda y sin conversiones que sumar.
- Todo plan cuelga de un activo de la cartera, de donde toma el precio que ya
  está en pantalla: no gasta ni una petición más de cotización, y borrar el
  activo se lleva sus planes.
- `/api/planes` y `/api/dca`, con 17 pruebas nuevas de rutas, 41 del cálculo del
  frontend y 18 del cableado de la pantalla contra la ficha real del activo.

[1.1.0]: https://github.com/FranciscoFdez05/PorfolioManager/releases/tag/v1.1.0

---

## [1.0.0] — 2026-08-25

Primera versión publicada. Consolida el traslado del cálculo del navegador al
servidor, que es lo que hace que las cifras sean reproducibles y auditables.

**Esquema de base de datos:** versión 1 (la primera numerada; una base anterior
se migra sola al abrirla).

### Añadido

- **Fiscalidad española.** Motor FIFO por lotes en el servidor (art. 37.2
  LIRPF), regla de los dos meses (art. 33.5.f), compensación de saldos negativos
  a cuatro años (art. 49.1.b) e informe de la renta exportable a CSV y HTML.
- **Efecto divisa.** Cada operación guarda el tipo de cambio de su fecha, con
  caché histórica en la propia base. El resultado se desglosa entre efecto
  activo y efecto divisa en vez de mezclarlos en un solo número.
- **Valoración desde el servidor.** Un hilo guarda el histórico sin depender de
  que haya una pestaña abierta, con TWR encadenado, drawdown, volatilidad y
  comparación contra índices.
- **Multi-portfolio**, con backup, restauración e importación/exportación.
- **Alta rápida desde un Atajo de iOS** (`POST /api/movimiento`), autenticada
  por IP y firma HMAC.
- **`GET /api/health`**: comprueba la base activa de verdad y devuelve 503 si
  falla. Es lo que usa el healthcheck del contenedor.
- **`./docker-update.sh`**: actualiza comprobando salud y revierte solo si el
  arranque no responde.

### Seguridad

- CSP con nonce y `script-src` cerrado a `'self'`: Chart.js se sirve desde
  `js/vendor/` y la aplicación no depende de ningún CDN.
- Protección CSRF por doble cookie, límite de escrituras por IP y tope de cuerpo
  separado para importaciones.
- Claves de API cifradas en reposo (Fernet derivado de `SECRET_KEY`); las que
  vengan en texto plano se convierten solas al arrancar.
- Todo el contenido estático pasa por un único manejador con lista blanca de
  extensiones: `.env`, `data/`, `API/` y el código fuente no se sirven.

### Corregido

- **Importes cien veces mayores en el frontend.** `parseEuroNumber` descartaba
  todos los puntos, así que un importe en formato canónico (`1234.56`) se leía
  como `123456`. Los dos parsers del navegador usan ya el mismo criterio.
- **Conversión de importes unificada.** Había cinco implementaciones con cinco
  criterios; dos devolvían cero para el formato español en el que el propio
  esquema guarda los importes. Ahora hay una (`core/dinero.py`) y el cálculo es
  `Decimal` de principio a fin, con `float` solo al serializar.
- **Precios sin divisa en el mapa de calor:** un activo en dólares se veía igual
  que uno en euros.
- **Colisión de nombre entre módulos**: `getOperationStablecoinSymbol` estaba
  definida en dos ficheros con criterios distintos.

### Infraestructura

- CI con pruebas en Python 3.11–3.13, ESLint, Prettier, auditoría de
  dependencias y construcción de la imagen.
- 795 pruebas de Python y 83 del frontend. Umbral de cobertura del 90 % para los
  módulos de cálculo, aparte del global.
- Esquema versionado con `PRAGMA user_version` y copia previa a cada migración.

[1.0.0]: https://github.com/FranciscoFdez05/PorfolioManager/releases/tag/v1.0.0
