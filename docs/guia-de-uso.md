# Guía de uso

Cómo se usa cada parte de la aplicación. La instalación y la configuración del servidor están en el [README](README-ESP.md) y en [DOCUMENTACION.md](../DOCUMENTACION.md).

## Índice

- [Primeros pasos](#primeros-pasos)
- [Módulos del menú](#módulos-del-menú)
- [Gráfico de un activo](#gráfico-de-un-activo)
- [Mi dinero](#mi-dinero)
- [Cripto: wallets enlazadas](#cripto-wallets-enlazadas)
  - [Enlazar una wallet](#enlazar-una-wallet)
  - [Seguimientos](#seguimientos)
  - [Detalle de un seguimiento](#detalle-de-un-seguimiento)
  - [Wallets ajenas y carteras conocidas](#wallets-ajenas-y-carteras-conocidas)
  - [Avisos por Telegram](#avisos-por-telegram)
  - [Libreta de direcciones](#libreta-de-direcciones)
  - [Movimientos entre wallets propias](#movimientos-entre-wallets-propias)
  - [Filas importadas y comisiones](#filas-importadas-y-comisiones)
  - [Tokens: verificados e imitaciones](#tokens-verificados-e-imitaciones)
  - [Precio de tokens y Watchlist](#precio-de-tokens-y-watchlist)
  - [Copias de seguridad](#copias-de-seguridad-de-las-wallets)
  - [Límites y avisos de la tarjeta](#límites-y-avisos-de-la-tarjeta)
  - [Dónde se guarda cada cosa](#dónde-se-guarda-cada-cosa)
  - [Configuración (`[wallets]`)](#configuración-wallets)

---

## Primeros pasos

1. **Crea la cuenta.** En el primer arranque `docker-setup` pregunta cómo: **1** desde la web, **2** desde la terminal, **3** cerrar (si te equivocas, vuelve a preguntar). Con la opción web imprime la dirección de `/setup` y un código de un solo uso, que también queda en `data/tmp/alta-inicial.txt` y en el log del contenedor, para que nadie más de la red se quede con la cuenta antes que tú.
2. **Entra** en `http://localhost:5050` con esas credenciales.
3. **Añade activos y operaciones.** Sin claves de API, los precios se introducen a mano.
4. **Cotizaciones automáticas (opcional):** claves de Finnhub, EODHD o Alpha Vantage en **Ajustes › API**.
5. **HTTPS:** actívalo en **Ajustes › Seguridad › HTTPS** si entras desde otros dispositivos.
6. **Telegram (opcional):** en **Ajustes › Telegram**, para avisos y comandos como `/estado`, `/cartera` o `/backup`.
7. **Verificación en dos pasos:** con Telegram funcionando, en **Ajustes › Cuenta**. Cada inicio de sesión pide un código que manda el bot; una frase de recuperación de 6, 12 o 24 palabras te deja entrar si pierdes Telegram.

## Módulos del menú

**Ajustes › Módulos** elige qué módulos salen en el menú y cuál se abre al iniciar (columna **Principal**, guardada por portfolio).

- El módulo principal no se puede ocultar hasta elegir otro.
- La barra de métricas superior tiene su propio interruptor en la misma pantalla.

## Gráfico de un activo

La ficha de cada activo tiene una pestaña **Gráfico** con dos vistas:

| Vista | Qué enseña | Unidades |
| --- | --- | --- |
| **Precio** | Precio por participación | Euros o % de variación del periodo |
| **Mi posición** | Ganancia o pérdida de lo que sigue en cartera | Euros o % sobre su coste |

- Puntos **verdes** = compras, **rojos** = ventas. Al pasar el cursor se ven la fecha, el valor y el detalle de cada operación.
- En **Precio**, cada punto sale al precio de su operación y, como las operaciones no tienen hora, en el momento de ese día cuyo precio guardado más se le acerca.
- Rangos: **1 D**, **7 D**, **30 D**, **YTD** (desde el 1 de enero), **1 A** y **Todo**. El eje de tiempo se ajusta al tramo con datos.

Limitaciones:

- Los datos salen solo de las valoraciones que guarda la propia aplicación (`asset_snapshots`), sin llamar a proveedores externos. El gráfico empieza en la primera valoración guardada y los importes van en euros.
- Las operaciones anteriores a esa valoración no tienen punto; la nota del gráfico dice cuántas quedan fuera.
- El precio se reconstruye a partir del valor y el coste de la posición, así que queda en blanco donde el coste guardado no coincide con ninguna posición que haya tenido el activo.

## Mi dinero

### Métricas

Las métricas de gastos e ingresos sin las del resto de la cartera: KPIs, gráficos por mes y por tipo (con el total en el centro del anillo), comparativa mensual y saldo del mes. Pulsar una porción de los anillos de **Gastos** o **Ingresos** abre la tabla con los movimientos de esa categoría, con buscador y total. La página **Métricas** de la barra principal sigue mostrándolo todo, con el filtro **Gastos & Ingresos**.

### Cuentas

Una tarjeta por cuenta con su tipo, su saldo y una miniatura del saldo en lo que va de año; a la derecha, el reparto del dinero por cuenta y por tipo.

- **Icono de ampliar:** gráfica del saldo con rangos **1 mes**, **3 meses**, **6 meses**, **1 año**, **YTD** y **Todo**.
- **Pulsar la tarjeta:** detalle con lo que entró y salió en el periodo elegido y tres accesos:
  - **Ingresos/Gastos**: lo apuntado en Gastos e Ingresos con esa cuenta, con buscador y filtros por tipo, año y mes.
  - **Movimientos**: sus transferencias, que se crean, editan y borran desde ahí.
  - **Gráficos**: el saldo y las entradas y salidas de cada mes.

El histórico se calcula día a día (`GET /api/cuentas/historico`):

| Apunte | Día en que cuenta |
| --- | --- |
| Gastos, ingresos y transferencias | El de su fecha |
| Mensualidades e ingresos recurrentes | El día 1 de su mes |
| Intereses y dividendos | El de su fecha, o el día 1 si solo tienen mes |
| Apuntes del mes en curso con fecha posterior a hoy | Hoy (igual que en el saldo) |

### Movimientos

Todas las transferencias entre cuentas, con filtros por año y por cuenta, búsqueda, el total y las comisiones del periodo y una tarjeta por cuenta con lo que entró y salió. Se crean, editan y borran con las mismas ventanas que en Cuentas.

### Cuenta remunerada

Lo que gana cada cuenta remunerada sin ser una aportación tuya (intereses y dividendos cobrados en ella), con el acumulado del año y la lista de movimientos. Es de solo lectura: los intereses se apuntan en **Bolsa e Inversión › Cuenta Remunerada** y los dividendos en su ventana.

## Cripto: wallets enlazadas

Importa los movimientos de tus wallets leyendo la blockchain y vigila wallets ajenas. Requisitos:

- Una `SECRET_KEY` aleatoria de al menos 32 caracteres (sin ella no se pueden enlazar wallets propias).
- **Nunca pegues una clave privada ni una frase semilla.** La aplicación las rechaza.

### Enlazar una wallet

1. Abre **Cripto › Transacciones › ··· › Wallets enlazadas**.
2. Pega lo que quieras enlazar (el formato se detecta solo):
   - una dirección pública;
   - en Bitcoin, una xpub/ypub/zpub;
   - en Bitcoin, Ethereum y BNB, una clave pública.
3. Pulsa **Sincronizar**.

Otras formas:

- **Sincronizar** en el mismo menú **···** sincroniza todas tus wallets propias a la vez.
- Desde un activo cripto, en **Nuevo activo** o **Editar activo**: una o varias direcciones o claves públicas quedan enlazadas como propias, asociadas a ese activo y agrupadas en un seguimiento con su nombre. Si una línea no vale, no se crea nada.

En la tabla de Transacciones, origen y destino salen como direcciones abreviadas con el nombre de la wallet al pasar el ratón; si un movimiento antiguo podría ser de varias de tus wallets, se deja el nombre. Los movimientos se importan con el nombre de su seguimiento.

### Seguimientos

**Cripto › Seguimiento** agrupa las wallets enlazadas. Un seguimiento puede reunir varias direcciones, xpub o claves públicas, aunque sean de redes distintas (las cuentas de un Ledger, o todas las wallets de una persona a la que sigues). Su tarjeta enseña el saldo conjunto, el valor en euros y los últimos movimientos.

- Las wallets de un seguimiento son **todas tuyas o todas ajenas**.
- **Añadir wallet** en la tarjeta, o elegir un seguimiento existente al enlazar, para sumar más.
- **Editar**: renombra el seguimiento, cambia el nombre o la cripto de cada wallet, quita wallets y añade direcciones o claves públicas nuevas de una vez. La red y la dirección de una wallet ya enlazada no se cambian: se quita y se añade la nueva.
- **Dejar de seguir** (**Desenlazar todas** en los propios), en el detalle, desenlaza todas sus wallets a la vez; lo ya importado se queda.
- Una clave pública de Bitcoin cuenta también sus salidas P2PK (monedas pagadas a la clave a pelo, como los 50 BTC de recompensa de los primeros bloques), leídas de Esplora por el hash del script.
- Mientras se leen wallets (actualizar una, un seguimiento o todas, sincronizar, historial, UTXOs o tokens), una barra abajo a la derecha enseña cuántas faltan, cuál se lee y cuánto queda más o menos.

### Detalle de un seguimiento

Al pulsar un seguimiento se abre su detalle:

- Cada wallet con sus avisos y sus acciones, y los totales.
- **Historial** de todas las wallets juntas, de 100 en 100, con filtros y enlace al explorador de bloques.
- **Ver en gráfico**: dibuja los movimientos que enseña la tabla (mismo filtro y fechas) como el grafo de Cuentas. Una bolita por dirección (con el alias de su wallet o el apodo de la libreta) y una flecha por cada origen → destino, tan gruesa como lo movido, de una moneda o token cada vez. Las imitaciones se dejan fuera salvo con su filtro.
- **Visor de UTXOs** (wallets de Bitcoin, propias o ajenas): cada salida sin gastar es un bloque de un treemap, con el tamaño de su importe y el color de su antigüedad; las que siguen sin confirmar salen rayadas. Al pulsar una se ven su transacción, salida, dirección, altura de bloque y confirmaciones.
- **Visor de tokens** (wallets de Ethereum y BNB): lee bajo demanda, de la API elegida para esa red, el saldo actual de cada token ERC-20/BEP-20, con el estado de su contrato y la cripto, stablecoin activada o **ETF tokenizado** de Activos que le corresponde por símbolo, valorado en euros al precio de ese activo (aproximado en los ETF tokenizados; las imitaciones no tienen activo ni valor). Con Etherscan es una llamada por token, hasta `max_tokens_visor`.
- Botones **Sospechosos** y **Despierta** junto al interruptor de avisos de cada wallet: los encienden o apagan de un clic (y encienden los avisos de la wallet).
- Fila **Todas las wallets**: hace lo mismo con todas a la vez (avisos por Telegram, **Sospechosos**, **Despierta** y **Actualizar todas**) sin tocar el resto de ajustes de cada una.
- Flechas para pasar al seguimiento anterior o siguiente.

**Lecturas guardadas.** Lo que lee el detalle (historial, tokens y UTXOs) se guarda por wallet, cifrado con `SECRET_KEY`. Al volver a abrir un seguimiento se ve al momento con su fecha de carga mientras se buscan los movimientos nuevos, salvo que la última lectura en esa pestaña del navegador tenga menos de 2 minutos.

- Un fallo de la red conserva lo guardado.
- **Volver a leer** lo sustituye.
- Desenlazar una wallet lo borra.
- Sin una `SECRET_KEY` válida no se guarda nada.

### Wallets ajenas y carteras conocidas

Puedes seguir wallets de otros: solo se vigilan, no se importan ni suman a tu total, y se pueden seguir sin `SECRET_KEY`.

**Carteras conocidas…** (menú **⋯** junto a **Enlazar wallet**) busca en un catálogo de wallets públicas incluido en la aplicación, por nombre, alias, categoría o dirección. Incluye, entre otras:

- exchanges como Binance, Coinbase, Bitvavo, Kraken, OKX o Bybit en Bitcoin, Ethereum, BNB, Solana y XRP;
- la dirección del bloque génesis y las claves públicas de los primeros bloques de Satoshi;
- Vitalik Buterin, Donald Trump y World Liberty Financial;
- los fondos de Mt. Gox, del Gobierno de EE. UU. y de El Salvador;
- Tether, fondos y más.

Uso:

1. Marca qué direcciones seguir (una por red de entrada; las que ya sigues salen atenuadas).
2. **Seguir las marcadas** abre la ventana de enlazar con ellas como seguimiento ajeno, listo para enlazar.

El catálogo es `python/core/datos/carteras_conocidas.json`, copiado una vez de las listas de prueba de reservas de los exchanges, de eth-labels y de otras fuentes públicas (cada entrada dice de cuál sale). La aplicación nunca lo descarga. Desde la misma ventana puedes añadir entradas propias, editar cualquiera (tu versión sustituye a la de serie hasta que pulses **Restaurar**) u ocultarlas. `tools/comprobar_carteras_conocidas.py` lista las direcciones del catálogo vacías o ilegibles, para revisarlas a mano.

#### Las monedas de Satoshi

La ficha **Satoshi Nakamoto** lleva un bloque **Todas sus monedas** con el saldo real de Satoshi (~1,1 M BTC). Parte de una foto de las ~22.000 monedas que minó (bloques Patoshi) que siguen sin gastar, en `python/core/datos/satoshi_monedas.csv.gz`, que se regenera con `tools/generar_satoshi_monedas.py` (por Electrum, despacio a propósito para que los servidores públicos no bloqueen la IP).

- **Vigilar bloques nuevos**: el servidor baja cada bloque nuevo de Bitcoin (unos 144 al día, ~210 MB) del Esplora de `esplora_url`, mira si gasta alguna de esas monedas y la descuenta del saldo.
- **Avisos por Telegram**: avisa cuando eso pasa.
- **Revisar ahora**: revisa en el momento los bloques que falten.

### Avisos por Telegram

Elige cada cuánto se revisan las wallets en segundo plano (de 5 minutos a una vez al día; 15 por defecto) y activa los avisos wallet a wallet, si quieres solo a partir de una cantidad mínima. En **Ajustes › Telegram** tiene que estar activada también la categoría «Movimientos en las wallets».

El botón **Avisos Telegram**, al enlazar o en **Editar** (para todo el seguimiento), abre una ventana movible. Arriba hay perfiles de un clic:

| Perfil | Qué activa |
| --- | --- |
| **Todo** | Todos los movimientos |
| **Seguridad** | Envíos, movimientos sospechosos y aviso si la wallet despierta tras 90 días |
| **Solo grandes** | Movimientos de 1.000 € o más y wallets vaciadas |

Opciones de la ventana:

- **Qué movimientos avisan:** recibidas, enviadas, entre direcciones propias, tokens.
- **Mínimo** en moneda o en euros.
- **Despierta:** aviso cuando una wallet vuelve a moverse tras N días quieta.
- **Movimientos sospechosos**, que avisan aunque los filtros de arriba no dejen pasar el movimiento:
  - envío a una dirección que no está en la libreta ni en los movimientos leídos;
  - wallet que queda con el 10 % del saldo o menos tras un envío;
  - polvo de menos de 1 € o tokens de valor cero;
  - dirección que imita a una conocida (mismo principio y final: el truco del envenenamiento de direcciones);
  - 3 envíos o más entre dos revisiones;
  - **Tokens imitación**.
- En **Más opciones** (plegado):
  - aviso cuando el saldo baja o sube de un límite;
  - agrupar los avisos de cada revisión en un mensaje y máximo de mensajes por revisión;
  - horas de silencio (hora del servidor, `TZ`); lo que llega en ellas se manda junto al acabar.

Los avisos de tokens usan la misma decisión por contrato que el historial y la importación: un token de un contrato verificado dice «token verificado», y uno de un contrato marcado (o detectado) como imitación nunca avisa como movimiento normal, tampoco cuando vuelve a llegar más adelante. Solo avisa como sospechoso con **Tokens imitación** encendido o si viene de una dirección parecida.

### Libreta de direcciones

El botón **Direcciones** abre tu libreta: marca direcciones como tuyas o ajenas, ponles apodo y búscalas por apodo o por dirección.

- Cada fila es un resumen; al pulsarla despliega la dirección, los datos leídos, las alertas, los últimos movimientos y las acciones.
- **Saldo:** las de wallets enlazadas enseñan el último saldo leído (más los tokens ya leídos en el detalle) y su valor en euros. Las marcadas a mano leen el saldo de su moneda nativa al pulsar **Ver saldo** (no se guarda).
- Las enlazadas salen enmascaradas. **Ver completas** enseña las direcciones completas tras pedir la contraseña de acceso a la web; se vuelven a ocultar con **Ocultar** o al cerrar la ventana.

Acciones:

| Acción | Qué hace |
| --- | --- |
| **Vincular a seguimiento** | Convierte una dirección marcada como tuya en wallet de un seguimiento, nuevo o existente: desde entonces se vigila, el saldo de su moneda suma al total y entra en la Watchlist y en **Sincronizar** |
| **Cambiar de seguimiento** | Pasa una dirección enlazada a otro seguimiento conservando sus lecturas y avisos |
| **Sacar del seguimiento** | Tras pedir la contraseña de acceso, la devuelve a la libreta como tuya y pierde lecturas y avisos |
| **Editar apodo** | En una wallet enlazada, renombra su seguimiento |
| **Es mía** / **Es ajena** | Desde la ventana de un movimiento, marca la contraparte |

Las filas ya importadas a Transacciones con esa contraparte se reetiquetan al marcarla, al quitar la marca y al enlazar o desenlazar una wallet propia.

### Movimientos entre wallets propias

Un movimiento hacia o desde una dirección tuya cuenta como **entre wallets propias** en el historial, en los avisos y en Transacciones (en vez de enviada o recibida), y la contraparte se ve por su apodo.

- Las direcciones de tus wallets propias enlazadas cuentan como tuyas sin marcarlas: todas las de una clave pública y las ya usadas de una xpub, que se descubren en cada lectura y salen en **Direcciones**. Una marca manual manda sobre eso.
- Una transacción solo es entre wallets propias si **todas** sus contrapartes son tuyas.

**El dinero que entra de terceros hay que verificarlo a mano.** Sale como **Pendiente de verificar** en el seguimiento y no se importa ni suma a la posición hasta que abres el movimiento y eliges **Entrada real** o **Entre mis wallets**. Las filas importadas como recibidas antes de existir esto, y las importadas a las que les quitas la verificación, siguen en **Cripto › Transacciones** como **Pendiente de verificar** y no cuentan.

En el detalle de un movimiento, una sola transacción de una wallet tuya se puede marcar **Entre mis wallets** o como recibida/enviada, diga lo que diga su dirección. Así, lo que compraste en un exchange y retiraste a tu wallet no vuelve a sumar a la posición y solo se descuenta su comisión.

- **Entre mis wallets** añade también las dos direcciones a **Direcciones** como tuyas. **Desmarca la de la otra dirección si es de un exchange**: si no, todos sus movimientos, pasados y futuros, cuentan como entre wallets propias sin verificarlos.
- Al quitar la marca salen las direcciones que añadió, salvo que otra marca las siga necesitando o les hayas puesto apodo.

### Filas importadas y comisiones

Pulsar una fila en **Cripto › Transacciones** abre la ventana del movimiento; si no se encuentra (una fila escrita a mano o que la red ya no devuelve), enseña los datos de la fila.

- Las filas importadas vienen de la blockchain y están **bloqueadas**, también en el servidor. Su menú solo ofrece **Comisión y clasificación** y **Editar nota**.
- **Eliminar** solo aparece si ya no queda una wallet propia enlazada de esa red; con una enlazada, la fila borrada volvería en la siguiente sincronización.
- Ya no se añaden filas a mano. Las escritas a mano que ya existan se pueden editar o borrar.

Comisiones de red:

- **Sincronizar** importa lo que tu wallet pagó en comisiones sin mover la moneda (enviar un token, aprobaciones, swaps y transacciones fallidas en ETH, BNB, SOL y XRP) como una fila **Entre wallet** que solo descuenta la comisión de la posición de esa moneda.
- Un recibo desde una dirección tuya descuenta la comisión de su transacción, salvo en Bitcoin y en tokens.
- En ETH, BNB, SOL y XRP la comisión se propone de la red y se puede cambiar; en Bitcoin y en tokens la escribes tú.
- En Bitcoin, márcala solo si todo lo movido sigue siendo tuyo: el cambio a una dirección sin enlazar hace que la cantidad no sea exacta. Enlaza esa wallet con su xpub.

### Tokens: verificados e imitaciones

Los tokens de Ethereum y BNB (ERC-20/BEP-20, memecoins incluidas) se importan a la cripto de Activos o a la stablecoin activada con su mismo símbolo. Si no hay ninguna, se avisa y no se importan.

Como cualquiera puede crear un token con cualquier símbolo, la columna **Token** del historial enseña el contrato de cada uno (enlace a Etherscan/BscScan y un punto de color por contrato) y su estado:

| Estado | Significado |
| --- | --- |
| **Sin verificar** | Se importa por su símbolo |
| **Verificado** | Contrato auténtico, confirmado por ti o por las listas públicas |
| **Imitación** | No se importa; el filtro **Imitaciones** los reúne |

Las acciones de cada token están en el menú **···** al final de su fila (**Ver ↗** queda fuera), y cada opción actúa sobre el contrato de su propia fila aunque cambies el filtro o las fechas.

**Reconocimiento automático.** Un contrato que aparece en las listas públicas de Uniswap o CoinGecko sale ya como **Verificado**, y los demás contratos con su símbolo en esa red, como imitación (también al importar). Las listas se descargan enteras una vez al día, así que ningún tercero ve qué tokens tienes. Se configuran en `listas_tokens`; vacío desactiva el reconocimiento.

**Tu decisión manda** sobre las listas y sobre las reglas:

| Acción | Efecto |
| --- | --- |
| **Verificar** | Marca el contrato auténtico (compruébalo antes en el explorador o en la web del proyecto). Cualquier otro contrato con ese símbolo en esa red pasa a imitación y deja de importarse. La confirmación enseña el contrato completo y avisa de señales de copia: otros contratos con el mismo símbolo entre los movimientos leídos, caracteres raros en el símbolo o un token que solo has recibido |
| **Quitar** | Deshace **Verificar** |
| **Confirmar** | Ancla un contrato verificado por las listas, aunque las listas cambien |
| **Es imitación** | Marca como spam un token (deja de importarse) |
| **No es imitación** | Desmiente una imitación detectada; se importa por su símbolo, como uno sin verificar |
| **Deshacer** | Vuelve a la detección automática |
| **Es sospechoso** / **No es sospechoso** | Etiqueta ámbar **Sospechoso** solo para ti (en el historial y en el visor de tokens); no cambia el estado ni lo que se importa |

Casos especiales:

- Los símbolos se comparan sin acentos ni marcas: un token que se llama como la moneda de la red (un «ETH» falso, o «ĖŢḤ») se detecta como imitación y, aunque lo marques como no imitación, nunca se suma a la moneda de la red.
- Un movimiento de la moneda propia de una red (BTC, ETH, BNB, SOL o XRP) sale como **BTC real · moneda de la red**: no tiene contrato, así que no puede ser una imitación.
- Los tokens SPL de Solana y las divisas emitidas del XRP Ledger no se leen, así que nunca aparecen como esa moneda.

### Precio de tokens y Watchlist

En el visor de tokens, un token sin activo asociado ofrece **Poner ticker de precio**:

1. Elige el proveedor (TradingView por defecto, Finnhub, EODHD, Yahoo Finance o Alpha Vantage).
2. Escribe el ticker (p. ej. `BINANCE:PEPEUSDT`) o búscalo con **Buscar**, que previsualiza el precio y la variación diaria de cada resultado como al añadir un activo.
3. Se comprueba contra el proveedor antes de guardarlo.

Desde entonces valora el token en euros, también por encima de un activo asociado por símbolo, y se cambia o se quita desde el mismo menú.

La lista **Seguimiento** de la Watchlist enseña la moneda de cada red que sigues y cada token visto en tus wallets (sin las imitaciones), cotizados con su ticker o con su activo. De cada token solo se recuerdan contrato y símbolo, nunca saldos, cifrados junto a las wallets y hasta 2.000. El menú **···** de cada fila o tarjeta tiene también **Poner ticker de precio**, que ahí vale además para la moneda de cada red (ese ticker solo la cotiza en esa lista). Los filtros de origen de la Watchlist (**Portfolio**, **Operaciones**, **Nuevos**, **Seguimiento**) enseñan uno cada vez.

### Copias de seguridad de las wallets

- Las copias llevan siempre las wallets enlazadas (wallets, libreta, marcas, tokens y lo que añadas al catálogo) dentro del paquete cifrado, protegidas con la contraseña de las copias o, si no la hay, con la de acceso a la web.
- **Incluir las claves de API en las copias**, en **Ajustes**, decide solo sobre las claves de API.
- Una exportación manual solo lleva las wallets si tiene contraseña.
- Al restaurar se vuelven a cifrar con la `SECRET_KEY` de este servidor, y la primera revisión de cada wallet solo memoriza lo que hay, sin avisos.

### Límites y avisos de la tarjeta

- No hay límite de wallets enlazadas, pero cada una es una consulta más en cada revisión: el tope real son los límites gratuitos de las APIs (Etherscan, Solana).
- Las wallets ajenas se revisan como mucho cada `ajenas_cada_minutos` (6 horas por defecto), sea cual sea el intervalo elegido.
- **Sincronizar** avisa si llega a `max_movimientos`, porque lo anterior se queda fuera de Transacciones.
- El total solo cuenta la moneda de cada red, no los tokens. Su precio sale del ticker puesto en **Análisis › Seguimiento**, del activo de la wallet o de una cripto con el símbolo de la red en el portfolio activo; sin ninguno, un mínimo en euros no filtra los avisos.

La tarjeta de un seguimiento avisa cuando:

- fallan las revisiones de fondo (y dice por qué);
- entre dos revisiones hubo más movimientos de los que se pueden leer (cada una lee 25 y, si ninguno es conocido, hasta 200);
- hay avisos sospechosos sin entregar (se reintentan en la siguiente revisión).

### Dónde se guarda cada cosa

| Ruta | Contenido | Notas |
| --- | --- | --- |
| `API/wallets.key` | Wallets propias y libreta de direcciones | Cifrado con `SECRET_KEY` |
| `API/wallets_ajenas.json` | Wallets ajenas que sigues | Sin cifrar (son direcciones públicas de otros), fuera de git. Las que estuvieran en `wallets.key` pasan aquí en el siguiente guardado |
| `API/wallets_lecturas/` | Historial, tokens y UTXOs leídos por wallet | Cifrado con `SECRET_KEY`; fuera de git y de las copias, porque se regenera leyendo la red |
| `API/carteras.key` | Tus cambios al catálogo de carteras conocidas | Cifrado con la misma `SECRET_KEY` que las wallets |
| `API/satoshi_vigilancia.json` | Estado de la vigilancia de las monedas de Satoshi | Fuera de git |
| `python/core/datos/carteras_conocidas.json` | Catálogo de carteras conocidas de serie | Incluido en el proyecto |
| `python/core/datos/satoshi_monedas.csv.gz` | Foto de las monedas de Satoshi sin gastar | Incluido en el proyecto |

Los tokens verificados y marcados y los tokens vistos se guardan cifrados junto a las wallets.

### Configuración (`[wallets]`)

Sección `[wallets]` de `config.ini`. Cada clave tiene su variable de entorno equivalente, indicada en el propio `config.ini`.

| Clave | Por defecto | Para qué |
| --- | --- | --- |
| `esplora_url` | `https://mempool.space/api` | API Esplora de Bitcoin (puede ser tu nodo) |
| `esplora_url_respaldo` | `https://blockstream.info/api` | Se usa si la principal no conecta, responde 5xx o limita; tras un fallo se va directo a ella unos minutos. Para no usar respaldo, pon la misma URL que en `esplora_url` |
| `solana_rpc_url` | `https://api.mainnet-beta.solana.com` | RPC de Solana |
| `xrpl_rpc_url` | `https://s1.ripple.com:51234/` | RPC de XRP Ledger |
| `ajenas_cada_minutos` | `360` | Intervalo mínimo de revisión de las wallets ajenas |
| `max_movimientos` | `200` | Movimientos más recientes leídos por wallet en cada sincronización |
| `max_tokens_visor` | `40` | Tokens cuyo saldo lee el visor de tokens |
| `plazo_segundos` | `75` | Tiempo máximo de una sincronización |
| `plazo_vigilancia_segundos` | `300` | Tiempo máximo de la lectura de una wallet en segundo plano (`WALLETS_PLAZO_VIGILANCIA_SEGUNDOS`) |
| `listas_tokens` | Uniswap y CoinGecko | Listas públicas de tokens; vacío desactiva el reconocimiento automático |

El resto de claves (`esplora_intervalo_segundos`, `gap_limit`, `max_historial`, `listas_tokens_horas`) están comentadas en `config.ini`.
