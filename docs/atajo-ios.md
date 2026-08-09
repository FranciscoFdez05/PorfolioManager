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

## Configuración

Todos los ajustes están en la sección `[atajo]` de `config.ini`:

```ini
[atajo]
activado = true
redes_permitidas = 192.168.1.0/24, 10.0.0.0/24
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

2. Ajusta `redes_permitidas` en `config.ini` al `Address` real de tu interfaz
   `wg0` de WireGuard.

3. Comprueba desde un equipo de la LAN:

   ```
   curl http://192.168.1.X:5000/api/categorias
   ```

   Debe responder 200 con las categorías. Si responde 403, la IP de origen no
   cae dentro de los rangos configurados; si responde 404, `activado` está en
   `false`.

## Los cuatro endpoints

| Endpoint | Protección | Para qué lo usa el Atajo |
|---|---|---|
| `GET /api/portfolios-lista` | IP | Elegir a qué base de datos van los datos |
| `GET /api/categorias` | IP | Rellenar la lista de categorías en tiempo de ejecución |
| `POST /api/preparar` | IP | Construir el cuerpo JSON y firmarlo, para que el Atajo no escriba JSON a mano |
| `POST /api/firmar` | IP | Firmar un texto ya construido (alternativa de bajo nivel) |
| `POST /api/movimiento` | IP + firma HMAC | Guardar el movimiento |

## Varias bases de datos

La app admite varios portfolios (`data/portfolios/<id>.db`) y cada uno tiene sus
propias categorías y movimientos, así que el Atajo tiene que decir a cuál
escribe:

- `GET /api/portfolios-lista` devuelve `{"portfolios": [{"id", "nombre",
  "activo"}], "activo": "<id>"}`. Como las categorías, se pide en tiempo de
  ejecución: si creas un portfolio nuevo desde la web, aparece solo en el Atajo.
- `GET /api/categorias?portfolio=<id-o-nombre>` lee las categorías de esa base de datos.
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

**1. Elegir la base de datos**

Va primero, antes del menú de tipo: así todo el bloque queda fuera de las ramas
y no hay riesgo de meter acciones dentro de una por error.

- **Obtener contenido de la URL**
  - URL: `http://192.168.1.X:5000/api/portfolios-lista`
  - Método: `GET`
- **Obtener valor del diccionario** → clave `nombres`
- **Elegir de la lista**
- **Establecer variable** `bbdd`

Cuatro acciones y ya está: los endpoints aceptan tanto el id (`test2`) como el
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
- **Obtener valor del diccionario** → clave `lista`
- **Elegir de la lista** → **Establecer variable** `categoria`

`?tipo=` hace que el servidor devuelva además `lista` con solo las categorías de
ese tipo. Así el Atajo no necesita un segundo «Obtener valor del diccionario»
usando una variable como clave, que era la acción más frágil de montar a mano:
ahora todas las claves se teclean y las variables solo aparecen en la URL.

Un `tipo` mal escrito devuelve 400 en vez de una lista vacía, a propósito: vacío
haría que «Elegir de la lista» se saltara en silencio y el fallo aparecería dos
pasos más abajo.

Este es el punto clave del diseño: la lista sale de `gastos_tipos` /
`ingresos_tipos`, así que una categoría añadida desde la web app aparece sola en
el Atajo sin tocar nada.

**4. Pedir concepto e importe**

- **Pedir entrada** (Texto), «¿Concepto?» → **Establecer variable** `nombre`
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
    `tipo`, `categoria`, `nombre`, `importe`, `fecha` y `portfolio`, cada uno
    con su variable como valor
- **Establecer variable** `preparado`
- **Obtener valor del diccionario** → clave `cuerpo`, en `preparado`
  → **Establecer variable** `envio`
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
  - Cuerpo de la solicitud: `Archivo` → variable `envio`

«Archivo» es lo que envía el texto crudo sin que Atajos lo reinterprete. Con la
opción `JSON` el cuerpo se reserializa y la firma falla con 401.

**9. Confirmar**

- **Obtener valor del diccionario** → clave `movimiento.cantidad`
- **Mostrar notificación** con ese valor, para ver de un vistazo que se guardó.

## Ponerlo en el Centro de Control

En iOS 18 o posterior: Centro de Control → botón `+` arriba a la izquierda →
**Añadir un control** → busca *Atajo* → elige este. También puedes asignarlo al
botón de Acción (Ajustes → Botón de Acción → Atajo).

## Qué responde el servidor cuando algo falla

| Código | Motivo | Dónde mirar |
|---|---|---|
| 404 | La función está apagada | `[atajo] activado` en `config.ini` |
| 403 | La IP de origen no está en los rangos permitidos | La propia respuesta trae el campo `ip` con la dirección que ve el servidor: añádela a `[atajo] redes_permitidas` |
| 401 | Firma inválida, ausente, o timestamp fuera de ventana | El cuerpo enviado no es idéntico al firmado (paso 8: tiene que ir como *Archivo*) |
| 503 | No hay clave de firma | Ejecuta `python tools/generar_clave_movimientos.py` |
| 404 | Portfolio inexistente | El `id` enviado no está en `/api/portfolios-lista` |
| 400 | JSON mal formado o campos inválidos | Comillas o barras invertidas en el concepto; `tipo` que no es `gasto`/`ingreso`; importe cero o negativo |

El mensaje concreto viene en el campo `error` de la respuesta, así que si algo
no cuadra, muestra el contenido de la última petición en una notificación.

> **`/api/movimiento` no se puede probar desde el navegador.** Solo acepta POST,
> y la barra de direcciones hace GET: siempre responderá error, aunque todo esté
> bien configurado. Para comprobar la instalación usa `/api/categorias`, que sí
> es GET.
>
> Ojo a la diferencia entre los dos 404 posibles: si la respuesta trae
> `requestId`, es Flask diciendo que la ruta no existe (código antiguo, falta
> reiniciar el servidor). Si no lo trae, es el 404 de `activado = false`.

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
