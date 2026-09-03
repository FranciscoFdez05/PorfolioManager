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

## [1.3.1] — 2026-09-03

Ajustes gana un panel que dice **si los proveedores de cotizaciones responden**.
Cuando un activo se queda con el precio de ayer, el sidebar lo apaga pero no
explica por qué: hasta ahora había que abrir los logs del contenedor para saber
si se había agotado la cuota, si la clave ya no valía o si el servicio estaba
caído.

**Esquema de base de datos:** no se toca. Sigue en la versión 4, así que deshacer
esta actualización es volver a la imagen anterior, sin tocar los datos.

### Añadido

- **Estado de las APIs**, en Ajustes › API, encima del contador de peticiones.
  Una fila por proveedor —Finnhub, EODHD, Alpha Vantage, Yahoo Finance y el tipo
  de cambio— con lo que hay que hacer en cada caso, que es lo que el contador de
  llamadas no podía decir: **Operativa** (con el tiempo de respuesta al lado,
  que es lo que distingue «va bien» de «va bien pero tarda cuatro segundos»),
  **Sin clave**, **Clave rechazada**, **Cuota agotada** o **No responde**. El
  código HTTP concreto queda en el título de la fila.

  Cuota agotada y clave rechazada salen en ámbar y no en rojo a propósito: el
  servicio responde, es la cuenta la que no da más, y es lo único de los cinco
  casos que se arregla desde esta misma pantalla.

  Alpha Vantage necesita mirar el cuerpo de la respuesta: devuelve **200 con una
  nota** cuando se acaba el límite diario, así que juzgando por el código HTTP
  saldría «Operativa» justo en el caso que este panel existe para detectar.

  Los cinco se comprueban a la vez, con seis segundos de espera: en serie serían
  cinco timeouts encadenados —medio minuto largo con todo caído— y aquí hay
  alguien mirando la pantalla.

  **El sondeo gasta cuota de verdad**, así que cuenta en «Peticiones API hoy» y
  el resultado se guarda un minuto: refrescar en bucle no puede acabar siendo el
  motivo de que se agote la cuota. Por eso el panel dice de cuándo es el dato en
  vez de fingir que se acaba de comprobar, y solo «Comprobar ahora» fuerza una
  comprobación nueva. Sin clave configurada no se llama al proveedor: sería
  gastar una petición para obtener un 401 previsible, que además se leería como
  «clave rechazada» cuando lo que hay es un hueco.

  El endpoint (`GET /api/stats/api-estado`) exige sesión como el resto: sondear
  sin ella sería una forma gratuita de gastarle la cuota a otro.

[1.3.1]: https://github.com/FranciscoFdez05/PorfolioManager/releases/tag/v1.3.1

---

## [1.3.0] — 2026-09-03

La pantalla de **Mensualidades** deja de mentir sobre lo que cuestan las
suscripciones y pasa a poder mirarse como un calendario del año. Y se arregla
que editar un activo fallara siempre, borrando de paso su histórico de compras.

**Esquema de base de datos:** sube a la versión **4** (venía de la 3). La
migración añade una columna a `mensualidades` y se aplica sola al arrancar;
antes de tocarla se guarda `data/backups/<portfolio>_pre-esquema-3-a-4_*.db`,
exento de rotación. Volver atrás es levantar la imagen anterior y restaurar ese fichero.

### Corregido

- **Una mensualidad pausada seguía sumando su coste mensual.** La fila decía
  «Pausada» y a la vez ponía 10,00 € en la columna de coste mensual, que además
  entraba en el total de la tabla: el resumen contaba como gasto fijo lo que se
  había dejado de pagar. Ahora el coste mensual de una pausada es «—» y queda
  fuera del total, y pausar vacía los cargos de los meses que quedan por
  delante —respetando el del mes en curso si su día ya pasó—. Como la tabla
  anual, Métricas y Ahorro leen esos importes por mes, los tres se corrigen con
  ello. Reactivar los devuelve desde el mes en curso, siguiendo el ritmo de la
  frecuencia para que una trimestral no se descoloque.
- El coste anual sí sigue contando lo que una pausada cobró antes de pararse:
  es dinero que salió de la cuenta y borrarlo del año falsearía el gasto de los
  meses en que estuvo activa.
- **Editar un activo fallaba siempre**, dijeras lo que dijeras: cambiar el color
  respondía «No se pudo actualizar el nombre del activo». El guardado sí llegaba
  al servidor; lo que reventaba era la línea siguiente, al cerrar el diálogo,
  contra tres variables que habían quedado declaradas `const` en
  `js/core/app-core.js` y que asigna `js/cartera/assets.js`. Como el ámbito
  global de la página es uno solo pero el linter analiza fichero a fichero, el
  `--fix` de un `prefer-const` las convirtió en constantes sin que nada avisara
  hasta la ejecución. Con ellas se habían roto también **crear un activo** y
  **reordenarlos arrastrando**, con el mismo síntoma: la acción se hacía y la
  pantalla decía que no.
- **Editar la cabecera de un activo borraba sus compras.** Guardar reescribe el
  activo entero, y al editar desde la vista de Activos se enviaba un activo sin
  filas —se leían de una tabla que no está en pantalla—, así que cambiar el
  color se llevaba por delante todo el histórico y respondía «ok». Ahora la
  edición parte del activo completo, y el servidor conserva las compras y las
  conversiones que no vengan en el cuerpo. Mandar una lista vacía sí las vacía:
  es como se borra la última fila desde la tabla.
- El aviso de una edición fallida **dice qué ha fallado**: habla de los cambios
  del activo en vez de solo del nombre, repite el motivo que dio el servidor y
  sale en el propio formulario, que se queda abierto para corregir, en lugar de
  en un `alert` que lo tapaba.

### Seguridad

- **Un `portfolios.json` manipulado dentro de un ZIP importado podía sacar la
  base de datos activa del volumen de datos.** De su campo `active` sale el
  nombre del fichero `.db` que se abre al arrancar, y no se validaba: un valor
  como `../../../../tmp/principal` desviaba la base activa fuera de `data/`, se
  persistía —así que el desvío se repetía en cada arranque— y las copias de
  seguridad seguían mirando `data/portfolios/`, quedándose sin los datos vivos.
  Los `.db` y las preferencias del ZIP ya se filtraban por nombre; faltaba el
  índice, y hacía falta desde que «Importar ZIP» acepta un archivo que no ha
  generado esta instalación.

  Se cierra en los dos sitios: al restaurar se rechaza el índice cuyo `active`
  —o el `id` de cualquier portfolio listado— no sea un identificador admisible,
  y se dice en la lista de entradas ignoradas en vez de restaurar a medias en
  silencio; y al arrancar, `init_portfolios` pasa el id por la misma
  comprobación que ya usaban borrar y cambiar de portfolio, que era justo la que
  no se estaba aplicando ahí. Lo segundo protege también a un fichero que ya
  estuviera en disco.

### Añadido

- **Una prueba que carga la página entera.** El fallo de la edición de activos
  no lo podía ver ningún linter: analiza fichero a fichero, y estos scripts
  comparten un único ámbito global. `tests-js/pagina-completa.test.js` carga los
  29 módulos de `js/` en el orden de `index.html` y comprueba lo que solo existe
  con todos juntos: que la página cargue —dos declaraciones del mismo nombre en
  ficheros distintos matan el segundo script entero— y que las globales que un
  módulo declara y otro asigna se puedan seguir escribiendo.
- **Día de cobro distinto según el mes.** Hasta ahora una mensualidad tenía un
  único día para todo el año, y eso no es lo que hace el banco: el cargo se
  mueve con los festivos o al cambiar la forma de pago. En el formulario, cada
  mes lleva su propio recuadro de día junto al importe; el que se deje vacío
  usa el día de renovación general. La tabla avisa de cuántos meses se salen de
  la norma y el próximo cobro ya se calcula con el día real de cada mes.
- **Calendario de cobros del año.** Junto a «Tabla», en la propia pantalla de
  Mensualidades, con los doce meses a la vez: cada día cobrado se marca con su
  importe, distinguiendo lo ya pasado de lo que queda por venir, y al pulsarlo
  se abre el detalle de qué suscripciones se cobraron ese día. Sin ningún día
  seleccionado, el panel resume el año —cobrado, por cobrar y los siguientes
  cargos—. Respeta el buscador y los filtros de la tabla, y «Descargar CSV»
  baja desde aquí un cargo por línea con su fecha, para cuadrarlo con el banco.
- Los dos primeros recuadros del resumen dejan de ser el mismo número dividido:
  **«Coste mensual»** es lo que se cobra ahora (sin las pausadas) y **«Coste del
  año»**, los cargos de todo el año con su media mensual al lado.

[1.3.0]: https://github.com/FranciscoFdez05/PorfolioManager/releases/tag/v1.3.0

---

## [1.2.0] — 2026-09-02

**Esquema de base de datos:** no se toca. Sigue en la versión 3, así que deshacer
esta actualización es volver a la imagen anterior, sin tocar los datos.

### Corregido

- **Importar una copia de seguridad desde «Importar ZIP» no restauraba nada** y
  decía que sí. Buscaba el `.db` en la raíz del zip, que es donde lo pone el
  export de una sola cartera; una copia de seguridad los guarda bajo
  `portfolios/`, así que no encontraba ninguno, restauraba solo los ajustes y
  respondía «importado correctamente». Ahora reconoce el formato y lo restaura
  con el mismo código que Ajustes → Restaurar, copia previa incluida.
- **«Importar portfolio» solo aceptaba el `.db` suelto.** Al elegir el ZIP que
  genera «Exportar ZIP» —de la propia aplicación— contestaba «no es una base de
  datos SQLite válida». Ahora saca la base del zip; si el zip trae varias
  carteras, dice cuáles y manda a Restaurar, que es lo que las recupera todas.
- Un ZIP sin nada reconocible ya no responde «ok»: se rechaza diciendo qué
  ficheros valen.
- La importación avisa cuando ha sido **parcial**, en vez de darla por buena, y
  recarga la página al terminar: lo que había en pantalla ya no eran los datos
  de la base.

### Añadido

- **La versión se ve en la interfaz**, al final de la barra de pestañas, en
  pequeño y apagada. Saber qué hay desplegado obligaba a abrir `/api/health` o a
  mirar el log del contenedor, justo cuando uno quiere confirmar de un vistazo
  que la actualización ha entrado. La sustituye el servidor al servir la página,
  igual que el nonce de CSP: sin una petición extra en cada carga y sin el hueco
  visible mientras llegaba la respuesta.

[1.2.0]: https://github.com/FranciscoFdez05/PorfolioManager/releases/tag/v1.2.0

---

## [1.1.1] — 2026-09-02

Correcciones de la ejecución en Docker sobre Linux. En el equipo de desarrollo
la aplicación es **un** proceso que además es dueño de la carpeta del proyecto;
en el servidor son **dos workers** de gunicorn escribiendo en volúmenes montados
desde el host, con el propietario y los permisos del host. Todo lo que sigue
solo se manifiesta en el segundo caso, y el síntoma era siempre parecido: la
aplicación arranca, se ve y se navega —leer no necesita permiso de escritura—
pero no guarda.

**Esquema de base de datos:** no se toca. Sigue en la versión 3, así que deshacer
esta actualización es volver a la imagen anterior, sin tocar los datos.

### Corregido

- **No se podía crear ninguna copia de seguridad, ni guardar los ajustes ni las
  claves de API.** El contenedor corría con un usuario de sistema creado dentro
  de la imagen, que no tiene por qué poder escribir en un volumen que pertenece
  al usuario del host. Ahora adopta el uid/gid del dueño del volumen de datos —o
  el `PUID`/`PGID` de `.env`—, así que escribe con permiso y lo que crea sigue
  siendo del usuario del servidor, que puede copiar `data/` sin `sudo`.
- **El error no decía qué pasaba.** «Error al crear backup» tapaba por igual un
  problema de permisos, un disco lleno, un sistema de ficheros de solo lectura y
  una base de datos bloqueada. Los fallos de disco se traducen ahora a su causa
  y al siguiente paso, y la traza completa va al log.
- **Temporales que aparecían como portfolios.** Las copias, exportaciones e
  importaciones dejaban ficheros `.db` a medio escribir dentro de
  `data/portfolios/`, que es donde el proyecto busca los portfolios con
  `glob("*.db")`: una importación en curso podía acabar dentro de un backup como
  si fuera una cartera más. Ahora van a `data/tmp` y no los recoge ningún
  listado.
- **Temporales con el mismo nombre en los dos workers.** `portfolios.tmp`,
  `<portfolio>.repair.db` o `<backup>.tmp` eran el mismo fichero para todos los
  procesos, y los dos workers hacen ese trabajo a la vez al arrancar: lo que se
  renombraba sobre el destino podía ser la mezcla de dos escrituras. Cada
  temporal lleva ahora proceso, hilo y un aleatorio.
- **Migración del esquema por duplicado.** El bloqueo que impedía dos `ALTER
  TABLE` simultáneos era de hilos, no de procesos, así que no protegía de los
  dos workers. Los pasos de migración son idempotentes uno a uno, pero el que
  reconstruye tablas no es reentrante. Ahora se toma un bloqueo entre procesos y
  migra solo uno.
- **Copia automática hecha dos veces.** El hilo horario de copias corría en cada
  worker: los dos verificaban, copiaban y rotaban los mismos ficheros en
  paralelo. Ahora la hace el primero que llega y el otro se la salta.
- **El contador de llamadas a la API enseñaba la mitad.** Vivía en memoria de
  cada worker, así que Ajustes mostraba las de quien contestara la petición, y
  un número distinto en cada recarga. Con una cuota diaria por delante, eso
  llevaba a pasarse sin saberlo; el recuento es ahora único y compartido.
- **Restauración con escrituras a medias.** `ajustes.json`, las preferencias y
  `portfolios.json` se sobrescribían truncando el fichero antes de escribirlo:
  un corte a mitad dejaba un JSON inválido, que se lee en silencio como «sin
  ajustes». Ahora se escriben de forma atómica y con fsync.

### Añadido

- **`PUID`/`PGID` en `.env`** para fijar con qué usuario escribe el contenedor.
  Sin ellos adopta el dueño de `data/`, que es lo que deja preparado
  `docker-setup`.
- **Diagnóstico de almacenamiento.** Al arrancar se registra la ruta que ha
  resuelto la aplicación para cada directorio de datos y si puede escribir en
  ella; con la sesión iniciada, `GET /api/health` lo publica junto al uid/gid del
  proceso. Es lo primero que mirar cuando algo no se guarda.
- **El contenedor se niega a arrancar si no puede escribir en `data/`**, con el
  `chown` exacto que hay que ejecutar. Antes arrancaba y fallaba en cada
  guardado, que es mucho más difícil de diagnosticar.
- **CI que levanta el contenedor de verdad**: comprueba que responde, que crea
  la base de datos dentro del volumen del host y con su usuario, y que se niega
  a arrancar —explicando por qué— si el volumen es de solo lectura. Construir la
  imagen no detectaba nada de esto.
- 49 pruebas nuevas: escritura atómica, bloqueo entre procesos, detección de
  directorios no escribibles, traducción de los errores de disco y contador de
  API compartido.

### Cambiado

- `docker-setup` y `docker-update.sh` crean `data/`, `logs/` y `API/` con tu
  usuario antes de levantar el stack. Si no existen, los crea el demonio de
  Docker como `root` y ni el contenedor ni tú podéis escribir en ellos.
- `docker-update.sh` rechaza ejecutarse con `sudo`, igual que ya hacía
  `docker-up.sh`: con `sudo`, los datos acabarían siendo de `root`.
- `docker-update.sh` se reejecuta desde una copia en `/tmp`. Se actualiza a sí
  mismo: el `git pull` reemplaza el fichero que `sh` está leyendo y, con un
  tamaño distinto, las órdenes que quedaban por leer se descolocaban a mitad de
  la actualización.
- `docker-up.sh` etiqueta la imagen con la versión desde la primera
  instalación, no solo como `latest`. Sin eso, la primera actualización no
  tenía imagen anterior a la que volver si algo fallaba.
- `appuser` tiene directorio personal. `gosu` fija `HOME` leyendo
  `/etc/passwd`, y gunicorn 26 dejaba un `Control server error: Permission
  denied: '/home/appuser'` en cada arranque: un ERROR en el log que no lo era.
- El README anunciaba la 1.0.0 con el código en la 1.1.1. Puesto al día, con un
  test que ata el badge a `core/version.py` —como los que ya existían para
  `pyproject.toml`, `package.json` y este fichero— y una sección nueva para
  reinstalar desde cero.

[1.1.1]: https://github.com/FranciscoFdez05/PorfolioManager/releases/tag/v1.1.1

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
