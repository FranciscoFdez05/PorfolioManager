# Atajo de iOS: registrar ingresos y gastos desde el Centro de Control

Este documento describe cómo montar el Atajo que apunta contra los endpoints de
`python/routes/movimientos.py`. El Atajo no contiene ninguna categoría ni ningún
dato de negocio: todo lo que el usuario elige de una lista sale de la base de
datos en el momento de ejecutarlo.

Esto es un añadido: la web app sigue dando de alta gastos e ingresos igual que
siempre. El Atajo escribe en las mismas tablas (`gastos_rows` / `ingresos_rows`),
así que lo apuntado desde el móvil aparece en la pestaña de Gastos o Ingresos sin
nada más. Se puede desactivar por completo con `activado = false` sin que la web
se entere.

## La vía corta: que lo genere el servidor

**Ajustes > API > Atajo de iOS** hace todo esto por ti:

- Dice de un vistazo si falta algo —la clave de firma, sobre todo, que es lo que
  falla casi siempre— en vez de tener que buscarlo en el log.
- **Genera la clave** con un botón, sin entrar por SSH.
- **Prueba** el camino entero sin escribir en la base de datos, y señala el
  primer paso que falla.
- **Descarga el atajo ya montado**, con la dirección de tu servidor dentro.

El fichero se genera sin firmar —firmarlo exige las claves de Apple—, así que
iOS solo lo acepta con *Ajustes > Atajos > Permitir atajos no fiables*, un
interruptor que además no aparece hasta que has ejecutado algún atajo alguna
vez. Si tu iPhone lo rechaza, o si prefieres entender cada acción antes de
usarla, el resto de este documento es la misma receta a mano: son exactamente
las mismas acciones y en el mismo orden.

El atajo generado **no lleva la clave de firma**, pero sí un **token de acceso**
(`X-Atajo-Token`) que manda en todas sus llamadas. Sin él, cualquier equipo de
tu red podía pedirle a `/api/preparar` una firma válida y apuntar movimientos:
la firma no probaba quién escribía. El token se deriva de la clave, así que:

- **el fichero `.shortcut` es un secreto**: guárdalo como una contraseña;
- **regenerar la clave lo revoca**: el atajo instalado deja de funcionar y hay
  que volver a descargarlo (es lo que hay que hacer si pierdes el iPhone).

Para montarlo a mano, el valor sale en Ajustes › API › Atajo de iOS ›
*Montarlo a mano* › **Mostrar**.

## Configuración

Todos los ajustes están en la sección `[atajo]` de `config.ini`:

```ini
[atajo]
activado = true
redes_permitidas = 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12
tolerancia_segundos = 60
max_texto_firma = 8192
fichero_clave = API/movimientos.key
```

La clave de firma no va ahí: `config.ini` está versionado en git. Se guarda en
el fichero que indique `fichero_clave`, dentro de `API/` —ignorado por git y
cifrado en reposo con `SECRET_KEY`, igual que las claves de los proveedores de
cotizaciones.

Cada ajuste admite un override por variable de entorno con prioridad sobre el
fichero (`MOVIMIENTOS_ACTIVADO`, `MOVIMIENTOS_REDES_PERMITIDAS`,
`MOVIMIENTOS_TOLERANCIA_SEGUNDOS`, `MOVIMIENTOS_MAX_TEXTO_FIRMA`,
`MOVIMIENTOS_FICHERO_CLAVE`, `MOVIMIENTOS_SECRET_KEY`), pensado para ajustes
puntuales en Docker o en pruebas, no para el uso normal.

`config.ini` se relee cuando cambia su fecha de modificación, así que cambiar un
rango no obliga a reiniciar el servidor.

## Antes de empezar

1. Genera la clave de firma:

   ```
   python tools/generar_clave_movimientos.py
   ```

2. Comprueba que `redes_permitidas` cubre tu wifi y el `Address` de tu interfaz
   `wg0` de WireGuard. De fábrica cubre cualquier red privada (192.168.x, 10.x y
   172.16-31.x); estréchalo si quieres una subred o una IP concreta.

3. Comprueba desde un equipo de la LAN (con el token de Ajustes › API):

   ```
   curl -H "X-Atajo-Token: <token>" http://192.168.1.X:5000/api/categorias
   ```

   Debe responder 200 con las categorías. Si responde 403, la IP de origen no
   cae dentro de los rangos configurados; si responde 401, falta el token o no
   es el actual; si responde 404, `activado` está en `false`.

## Los endpoints

Con la firma exigida (lo recomendado), **todos** piden además el token en la
cabecera `X-Atajo-Token`. Si desactivas la firma en Ajustes, tampoco se pide el
token y la red de origen queda como única barrera.

| Endpoint | Protección | Para qué lo usa el Atajo |
|---|---|---|
| `GET /api/portfolios-lista` | IP + token | Elegir a qué base de datos van los datos |
| `GET /api/categorias` | IP + token | Rellenar la lista de categorías en tiempo de ejecución |
| `GET /api/cuentas-lista` | IP + token | Elegir con qué cuenta se paga o en cuál se cobra (Santander, Revolut, Trade Republic…) |
| `POST /api/preparar` | IP + token | Construir el cuerpo JSON y firmarlo, para que el Atajo no escriba JSON a mano |
| `POST /api/firmar` | IP + token | Firmar un texto ya construido (alternativa de bajo nivel) |
| `POST /api/movimiento` | IP + token + firma HMAC | Guardar el movimiento |

## Varias bases de datos

La app admite varios portfolios (`data/portfolios/<id>.db`) y cada uno tiene sus
propias categorías y movimientos, así que el Atajo tiene que decir a cuál
escribe:

- `GET /api/portfolios-lista` devuelve `{"portfolios": [{"id", "nombre",
  "activo"}], "activo": "<id>"}`. Como las categorías, se pide en tiempo de
  ejecución: si creas un portfolio nuevo desde la web, aparece solo en el Atajo.
- `GET /api/categorias?portfolio=<id-o-nombre>` lee las categorías de esa base de datos
  y devuelve también `cuentas` (ver «Elegir la cuenta»).
- `POST /api/movimiento` acepta `"portfolio": "<id-o-nombre>"` **dentro del JSON**, no en
  la query string, para que quede cubierto por la firma: si viajara fuera,
  cualquiera podría redirigir el movimiento a otra base de datos sin invalidar
  el HMAC.

Si se omite el campo se usa el portfolio activo, así que un Atajo hecho antes de
esto sigue funcionando igual.

Internamente cada petición abre su portfolio con `core.db.open_db_at()`, que es
una conexión de usar y tirar. No se usa `set_active_db_path()` porque esa
función cambia una variable global del proceso: le cambiaría la base de datos
por debajo a la sesión web que estuviera abierta en ese momento.

`POST /api/firmar` acepta `{"cuerpo": "<json>"}` y devuelve
`{"firma": "...", "timestamp": "..."}`: el servidor pone su propio reloj, así
que el Atajo no tiene que calcular ningún epoch ni preocuparse por el desfase
con la ventana de 60 segundos.

## Pasos del Atajo

Sustituye `192.168.1.X:5000` por la IP y el puerto reales de tu servidor. Por
WireGuard usarás la IP del túnel, no la de la LAN.

**Cada «Obtener contenido de la URL» lleva la cabecera `X-Atajo-Token`** con el
token de Ajustes › API (despliega *Mostrar más* en la acción para ver las
cabeceras). En los pasos de abajo no se repite.

**0. El bloque que va después de cada llamada al servidor**

Atajos no trata un 403 o un 404 como un error: «Obtener contenido de la URL»
devuelve el JSON del fallo como si nada, «Obtener valor del diccionario» no
encuentra la clave y sale vacío, y **«Elegir de la lista» con una lista vacía
no pregunta nada y sigue**. Sin esto, con el filtro de red rechazando al móvil
el atajo se saltaba la base de datos y la categoría, pedía concepto e importe,
mandaba un cuerpo vacío y terminaba con «Apuntado» sin haber apuntado nada.

Así que después de cada llamada, y antes de usar lo que devuelve, va esto:

- **Establecer variable** `respuesta` (la respuesta entera)
- **Obtener valor del diccionario** → la clave que se espera, en `respuesta`
- **Establecer variable** `opciones` (o el nombre que toque en ese paso)
- **Si** `opciones` *no tiene ningún valor*
  - **Obtener valor del diccionario** → clave `error`, en `respuesta`
  - **Mostrar alerta** con ese valor como mensaje
  - **Detener este atajo**
- **Fin de Si**

En los pasos de abajo aparece resumido como *«comprobar y parar si falta»*.
El atajo que genera el panel lo lleva ya puesto.

**1. Elegir la base de datos**

Va primero, antes del menú de tipo: así todo el bloque queda fuera de las ramas
y no hay riesgo de meter acciones dentro de una por error.

- **Obtener contenido de la URL**
  - URL: `http://192.168.1.X:5000/api/portfolios-lista`
  - Método: `GET`
- **Establecer variable** `respuesta`
- **Obtener valor del diccionario** → clave `nombres`, en `respuesta`
- **Establecer variable** `opciones` → *comprobar y parar si falta*
- **Elegir de la lista**, con `opciones` como entrada
- **Establecer variable** `bbdd`

Con el «Si» en medio, «Elegir de la lista» ya no puede tomar la lista de la
acción anterior: hay que ponerle `opciones` como entrada a mano.

Cuatro acciones más el bloque y ya está: los endpoints aceptan tanto el id (`test2`) como el
nombre visible (`Test2`, sin distinguir mayúsculas), así que el Atajo puede
mandar directamente lo que elija el usuario y no tiene que traducir nada. La
respuesta trae además `idPorNombre` y `portfolios` por si se quiere el id, pero
para el Atajo no hacen falta.

Si solo usas un portfolio puedes saltarte este paso y omitir el campo en el
JSON: el servidor escribirá en el activo.

**2. Elegir el tipo**

- **Elegir del menú** con dos opciones: `Gasto` e `Ingreso`.
- Dentro de la rama *Gasto*: **Texto** = `gasto` → **Establecer variable** `tipo`.
- Dentro de la rama *Ingreso*: **Texto** = `ingreso` → **Establecer variable** `tipo`.

El servidor pasa el valor a minúsculas antes de validarlo, así que `Gasto` con
mayúscula también vale.

**3. Pedir las categorías al servidor**

- **Obtener contenido de la URL**
  - URL: `http://192.168.1.X:5000/api/categorias?portfolio=` + variable `bbdd`
    + `&tipo=` + variable `clase`
  - Método: `GET`
- **Establecer variable** `respuesta`
- **Obtener valor del diccionario** → clave `cuentas`, en `respuesta`
- **Establecer variable** `opciones` → *comprobar y parar si falta*
- **Elegir de la lista**, con `opciones` como entrada («¿En qué cuenta?») →
  **Establecer variable** `cuenta`
- **Obtener valor del diccionario** → clave `lista`, en `respuesta`
- **Establecer variable** `opciones` → *comprobar y parar si falta*
- **Elegir de la lista**, con `opciones` como entrada → **Establecer variable** `categoria`

`cuentas` es la lista de cuentas de dinero: la primera es **Cuenta bancaria** (la
de siempre, y la que vale si no se manda nada) y después las demás que hayas
creado en **Gastos › Cuentas** (ahorro, exchange, broker…). Es la cuenta **con la
que se paga el gasto o en la que se cobra el ingreso**; la `categoria` es la de
siempre, se elija la cuenta que se elija.

`?tipo=` hace que el servidor devuelva además `lista` con solo las categorías de
ese tipo. Así el Atajo no necesita un segundo «Obtener valor del diccionario»
usando una variable como clave, que era la acción más frágil de montar a mano:
ahora todas las claves se teclean y las variables solo aparecen en la URL.

Un `tipo` mal escrito devuelve 400 en vez de una lista vacía, a propósito: así
el bloque de comprobación enseña el mensaje del servidor en vez de que «Elegir
de la lista» se salte en silencio.

Este es el punto clave del diseño: la lista sale de `gastos_tipos` /
`ingresos_tipos`, así que una categoría añadida desde la web app aparece sola en
el Atajo sin tocar nada.

**4. Pedir concepto e importe**

- **Pedir entrada** (Texto), «¿Concepto?» → **Establecer variable** `nombre`
  (puede quedarse vacío: el movimiento se apunta igual, con el concepto en blanco)
- **Pedir entrada** (Número), «¿Importe?» → **Establecer variable** `importe`

**5. Fecha de hoy**

- **Formatear fecha**: Fecha actual, formato personalizado `dd-MM-yyyy`
  → **Establecer variable** `fecha`

Sirve tanto `dd-MM-yyyy` (el formato que usa la web y el que sale natural aquí)
como `yyyy-MM-dd`. No son ambiguos entre sí: el año de cuatro cifras va delante
en uno y detrás en el otro, así que `09-08-2026` solo puede ser el 9 de agosto.

Si omites este paso y no mandas `fecha`, el servidor usa el día de hoy igualmente.

El mes y el año de la ficha los deduce el servidor de esa fecha: no hay que
elegirlos. Un gasto del 09-08-2026 entra en **agosto de 2026**, y si ese año no
existía aún en la pestaña de Gastos se crea solo.

**6. Preparar y firmar el movimiento**

- **Obtener contenido de la URL**
  - URL: `http://192.168.1.X:5000/api/preparar`
  - Método: `POST`
  - Cuerpo de la solicitud: `JSON`, con un campo de tipo Texto por dato:
    `tipo`, `categoria`, `cuenta`, `nombre`, `importe`, `fecha` y `portfolio`,
    cada uno con su variable como valor (`cuenta` es opcional: sin él, la
    cuenta bancaria)
- **Establecer variable** `preparado`
- **Obtener valor del diccionario** → clave `cuerpo`, en `preparado`
  → **Establecer variable** `envio` → *comprobar y parar si falta* (aquí la
  respuesta es `preparado`)
- **Obtener valor del diccionario** → clave `firma`, en `preparado`
  → **Establecer variable** `sello`
- **Obtener valor del diccionario** → clave `timestamp`, en `preparado`
  → **Establecer variable** `marca`

Aquí el Atajo manda un diccionario nativo, no un JSON tecleado. El servidor lo
serializa de forma canónica, firma esos bytes exactos y devuelve las tres cosas
que hacen falta. Como serializa y firma el mismo proceso, los bytes coinciden
por construcción.

Eso elimina de golpe tres problemas del JSON escrito a mano: las comillas dobles
en el concepto ya no rompen nada, un importe con coma decimal se acepta, y no
hay forma de que una llave mal cerrada produzca un 400.

El cuerpo se genera en ASCII puro (los acentos viajan como `\uXXXX`), así que
tampoco puede haber discrepancias de codificación entre lo firmado y lo enviado.

**7. (Alternativa) Construirlo a mano**

Si prefieres montar el JSON tú, `POST /api/firmar` acepta
`{"cuerpo": "<json>"}` y devuelve `firma` y `timestamp`. Es la vía de bajo nivel
y exige que el texto enviado luego sea idéntico byte a byte.

**8. Enviar el movimiento**

- **Obtener contenido de la URL**
  - URL: `http://192.168.1.X:5000/api/movimiento`
  - Método: `POST`
  - Cabeceras:
    - `Content-Type` = `application/json`
    - `X-Timestamp` = variable `marca`
    - `X-Signature` = variable `sello`
    - `X-Atajo-Token` = el token
  - Cuerpo de la solicitud: `Archivo` → variable `envio`

«Archivo» es lo que envía el texto crudo sin que Atajos lo reinterprete. Con la
opción `JSON` el cuerpo se reserializa y la firma falla con 401.

**9. Confirmar**

- **Establecer variable** `resultado`
- **Obtener valor del diccionario** → clave `movimiento.cantidad`, en `resultado`
- **Establecer variable** `cantidad` → *comprobar y parar si falta* (la
  respuesta es `resultado`)
- **Mostrar notificación** «Apuntado» con el concepto y el importe.

La notificación solo llega si la respuesta trae el movimiento creado. Antes se
mostraba siempre, y un 401 de firma o un 403 del filtro de red terminaban en
«Apuntado» con la base de datos intacta.

## Ponerlo en el Centro de Control

En iOS 18 o posterior: Centro de Control → botón `+` arriba a la izquierda →
**Añadir un control** → busca *Atajo* → elige este. También puedes asignarlo al
botón de Acción (Ajustes → Botón de Acción → Atajo).

## Qué responde el servidor cuando algo falla

| Código | Motivo | Dónde mirar |
|---|---|---|
| 404 | La función está apagada | `[atajo] activado` en `config.ini` |
| 403 | La IP de origen no está en los rangos permitidos | La propia respuesta trae el campo `ip` con la dirección que ve el servidor, y Ajustes › API › Atajo de iOS la lista en el paso 2 con un botón que la permite (o su subred) al momento |
| 403 | «La dirección … no está reconocida» | El Atajo usa un nombre de host (por ejemplo `nas.casa` o un dominio de DuckDNS) por el que todavía no se ha entrado a la aplicación. Abre la web con esa misma dirección e inicia sesión una vez: el nombre queda admitido. Las IPs y `localhost` valen siempre |
| 401 | «Este Atajo no lleva el token» o «El token del Atajo no es válido» | Atajo anterior a la versión con token, o clave regenerada desde entonces. Vuelve a descargarlo desde Ajustes › API |
| 401 | Firma inválida, ausente, o timestamp fuera de ventana | El cuerpo enviado no es idéntico al firmado (paso 8: tiene que ir como *Archivo*) |
| 401 | «Petición repetida» | Cada petición firmada vale una sola vez. Vuelve a lanzar el Atajo, que firma de nuevo |
| 503 | No hay clave de firma | Ejecuta `python tools/generar_clave_movimientos.py` |
| 404 | Portfolio inexistente | El `id` enviado no está en `/api/portfolios-lista` |
| 400 | JSON mal formado o campos inválidos | Comillas o barras invertidas en el concepto; `tipo` que no es `gasto`/`ingreso`; importe cero o negativo; `cuenta` que no existe (el mensaje dice cuáles valen) |

El mensaje concreto viene en el campo `error` de la respuesta, y es el que
enseña la alerta del atajo cuando se para. Si el atajo **pide concepto e
importe sin haber preguntado antes la base de datos ni la categoría**, es una
versión anterior sin las comprobaciones: las dos listas llegaron vacías porque
el servidor rechazó las llamadas (casi siempre un 403 del filtro de red o un
404 por `activado = false`) y Atajos se las saltó sin decir nada. Descarga el
atajo otra vez desde **Ajustes > API** y usa **Probar** en ese mismo panel: dice
con qué IP te ve el servidor y si pasa el filtro.

> **`/api/movimiento` no se puede probar desde el navegador.** Solo acepta POST,
> y la barra de direcciones hace GET: siempre responderá error, aunque todo esté
> bien configurado. Para comprobar la instalación usa `/api/categorias`, que sí
> es GET.
>
> Ojo a la diferencia entre los dos 404 posibles: si la respuesta trae
> `requestId`, es Flask diciendo que la ruta no existe (código antiguo, falta
> reiniciar el servidor). Si no lo trae, es el 404 de `activado = false`.

## Elegir la cuenta: con cuál se paga o en cuál se cobra

Cada gasto o ingreso va a una **cuenta**. Por defecto es la **cuenta bancaria**,
que es donde está todo lo apuntado hasta ahora. Pero puede ser cualquiera de las
que tengas en **Gastos › Cuentas**: una cuenta de ahorro, un exchange, un broker u
otra cuenta bancaria. El movimiento sigue siendo un gasto (o un ingreso) de su
categoría y cuenta en Gastos, Ingresos y las métricas igual que siempre; lo que
cambia es **de qué cuenta sale o en cuál entra el dinero**:

- un **gasto** pagado con la cuenta de ahorro baja el saldo de esa cuenta de
  ahorro, no el del banco;
- un **ingreso** cobrado en un exchange sube el saldo de ese exchange.

> Mover dinero de una cuenta a otra (del banco al exchange, del banco al ahorro…)
> **no es un gasto ni un ingreso**: es una *transferencia*, y se apunta en la web,
> en Gastos › Cuentas. El Atajo apunta gastos e ingresos.

### Qué manda el Atajo

Un campo más en el cuerpo de `/api/preparar`, llamado **`cuenta`**, con el
**nombre** de la cuenta tal como la devuelve el servidor (no distingue mayúsculas;
también vale el identificador):

| Valor de `cuenta` | A dónde va |
|---|---|
| (vacío o sin el campo) | Cuenta bancaria |
| `Cuenta bancaria` | Cuenta bancaria |
| `Cuenta de ahorro` | La cuenta de ahorro principal |
| `Binance` (o el nombre que tengas) | Esa cuenta |

No hace falta escribir ninguno a mano. Hay dos sitios de donde sacar la lista, los
dos por filtro de red local y sin sesión:

- **`GET /api/cuentas-lista?portfolio=<bbdd>`**: la dirección pensada para esto.
  Devuelve las cuentas que tengas dadas de alta en la web (Gastos › Cuentas):

  ```json
  {
    "cuentas": [{ "id": "banco", "nombre": "Santander", "tipo": "banco", "tipo_etiqueta": "Banco" }, …],
    "nombres": ["Santander", "Cuenta de ahorro", "Revolut", "Trade Republic"],
    "idPorNombre": { "Santander": "banco", "Trade Republic": "ahorro-trade-republic", … },
    "predeterminada": "Santander"
  }
  ```

  La clave que se usa en el Atajo es **`nombres`**, con la cuenta bancaria siempre
  la primera. Es la misma forma que `/api/portfolios-lista`.
- **`GET /api/categorias`**: trae la misma lista en su clave **`cuentas`**, por si
  prefieres no hacer una petición más (es lo que usa el Atajo que genera la app).

La lista se refresca sola al crear o renombrar una cuenta en la web. `/api/cuentas`,
a secas, es la de la web y exige sesión iniciada: un Atajo no puede usarla.

### Añadir la elección de cuenta a un Atajo que ya tienes

Los Atajos instalados siguen funcionando sin tocar nada —apuntan a la cuenta
bancaria—, así que esto solo hace falta si quieres poder elegir otra. Es descargar
el Atajo nuevo desde **Ajustes > API > Atajo de iOS**, o añadirle tres acciones y
un campo a mano:

1. En la app **Atajos**, abre el atajo y pulsa **Editar**.
2. Busca el bloque que pide las categorías: **Obtener contenido de la URL**
   (`…/api/categorias?portfolio=…`) seguido de **Establecer variable** `respuesta`.
3. Justo **debajo** de ese **Establecer variable** `respuesta`, añade (con la
   variante de la nota de abajo si prefieres `/api/cuentas-lista`):
   - **Obtener valor del diccionario** → *Obtener* **Valor** de la clave
     `cuentas`, en la variable `respuesta`.
   - **Establecer variable** `opciones`.
   - **Elegir de la lista**, con la variable `opciones` como entrada. En
     *Solicitar* escribe «¿En qué cuenta?».
   - **Establecer variable** `cuenta`.

   Si quieres la misma protección que el resto del atajo, pon entre
   `opciones` y «Elegir de la lista» el bloque de comprobación (**Si**
   `opciones` **no tiene valor** → **Mostrar alerta** con el error →
   **Detener este atajo**), igual que en los demás pasos.
4. Más abajo, en **Obtener contenido de la URL** de `…/api/preparar`, en
   **Cuerpo de la solicitud** (tipo *JSON*) pulsa **Añadir nuevo campo**:
   *Texto*, clave `cuenta`, y como valor la variable `cuenta`.
5. Pulsa **OK** y ejecuta el atajo: ahora pregunta «¿En qué cuenta?» con
   «Cuenta bancaria» la primera.

**Variante con `/api/cuentas-lista`.** En vez de leer `cuentas` de `respuesta`, haz
tu propia petición antes de elegir:

1. **Obtener contenido de la URL** → `http://192.168.1.X:5000/api/cuentas-lista?portfolio=`
   + variable `bbdd`, método `GET`.
2. **Obtener valor del diccionario** → clave `nombres`, en esa respuesta →
   **Establecer variable** `opciones` (con el bloque de comprobación si quieres).
3. **Elegir de la lista** con `opciones` → **Establecer variable** `cuenta`, y el
   campo `cuenta` del paso 4 igual que arriba.

Detalles que conviene saber:

- **El valor viaja tal cual lo elegiste** de la lista. No lo escribas a mano: un
  texto que no sea una cuenta (por ejemplo «Mi hucha») devuelve 400 con la lista de
  las que valen.
- Si **renombras una cuenta** en la web, el atajo no hay que tocarlo: la lista se
  pide en cada ejecución.

### Un atajo solo para una cuenta

Si siempre pagas con la misma cuenta, es más cómodo duplicar el atajo
(*Duplicar* en la biblioteca de Atajos) y fijar la cuenta en lugar de preguntarla:

1. Borra las acciones «¿En qué cuenta?» y la variable `cuenta`.
2. En el campo `cuenta` del cuerpo de `/api/preparar`, escribe el nombre de la
   cuenta directamente, por ejemplo `Cuenta de ahorro`.

### Comprobarlo

Desde cualquier navegador de la LAN, `http://192.168.1.X:5000/api/categorias`
debe devolver la clave `cuentas`. Tras ejecutar el atajo, el movimiento aparece en
Gastos o en Ingresos, en su mes, con una etiqueta con el nombre de la cuenta si no
es la bancaria; y en la ventana de esa cuenta (por ejemplo Gastos › Cuenta de
ahorro) como un movimiento más.

## Limitaciones conocidas

- **Comillas dobles y barras invertidas en el concepto** rompen el JSON
  construido a mano y el servidor devuelve 400. Atajos no tiene una acción de
  escapado JSON; lo práctico es no usarlos.
- **`/api/firmar` es un oráculo de firma** protegido solo por IP. Cualquier
  dispositivo que alcance tu LAN o tu túnel puede firmar lo que quiera: el HMAC
  te protege de terceros en la red, no de alguien ya dentro de ella.
- **Las categorías nuevas se dan de alta solas.** Si escribes una categoría con
  una errata desde el Atajo, queda en el catálogo hasta que la borres desde
  Ajustes de la web app.
