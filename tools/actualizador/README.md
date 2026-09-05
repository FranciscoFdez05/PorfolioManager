# Actualizar desde Ajustes

El botón **Ajustes › Datos › Actualizar la aplicación** no actualiza nada por sí
mismo: deja una señal en `data/tmp/actualizacion.solicitada`. Quien actualiza es
este vigilante, que corre **en el host** y ejecuta `docker-update.sh` con todas
sus garantías.

## Por qué no lo hace la aplicación directamente

Tres motivos, y ninguno se arregla con más código dentro del contenedor:

1. **No hay Docker dentro.** Solo están montados `data/`, `logs/` y `API/`: ni
   el socket ni el CLI.
2. **No hay repositorio dentro.** El código va horneado en la imagen; el
   `git pull` necesita el checkout del host.
3. **El script se cargaría a quien lo ejecuta.** `docker-update.sh` para y
   recrea el contenedor de la aplicación. Lanzado desde dentro, el proceso
   muere a mitad —justo antes de la comprobación de `/api/health` y del
   retroceso automático—, que es precisamente lo que hace que actualizar sea
   seguro.

La alternativa habitual es montar el socket de Docker en el contenedor, pero eso
equivale a dar root del host a la aplicación web. Esto no le da ningún
privilegio nuevo: solo puede escribir un fichero en un volumen que ya escribía.

**Aun así, quien pueda escribir ese fichero puede provocar una reconstrucción y
un reinicio.** El endpoint exige sesión, como el resto.

## Instalación

Suponiendo el proyecto en `/opt/PorfolioManager` y el usuario `francisco`:

```bash
cd /opt/PorfolioManager
chmod +x tools/actualizador/portfolio-actualizador.sh

# Ajusta User=, WorkingDirectory= y ExecStart= a tu ruta y tu usuario
sudo cp tools/actualizador/portfolio-actualizador.service /etc/systemd/system/
sudo cp tools/actualizador/portfolio-actualizador.timer   /etc/systemd/system/
sudo nano /etc/systemd/system/portfolio-actualizador.service

sudo systemctl daemon-reload
sudo systemctl enable --now portfolio-actualizador.timer
```

El usuario del `User=` tiene que poder ejecutar `docker` sin contraseña (estar en
el grupo `docker`), que es lo mismo que hace falta para lanzar `docker-update.sh`
a mano.

Comprobar que está vivo:

```bash
systemctl list-timers portfolio-actualizador.timer
```

## Sin systemd

El script no depende de systemd: es una pasada que mira si hay señal y termina.
Vale cualquier cosa que lo llame cada poco. Con cron, cada minuto:

```cron
* * * * * /opt/PorfolioManager/tools/actualizador/portfolio-actualizador.sh
```

O un bucle en un `tmux`, si el servidor no tiene ni cron:

```bash
while true; do ./tools/actualizador/portfolio-actualizador.sh; sleep 30; done
```

## Cómo saber si está funcionando

La pantalla de Ajustes lo dice: mientras el vigilante no haya escrito nunca
`data/tmp/actualizacion.estado`, el panel avisa de que **no da señales de vida** y
te recuerda que la actualización sigue siendo `./docker-update.sh` por SSH. Eso
es a propósito: un botón que deja la señal y se queda girando para siempre es
peor que no tener botón.

El registro completo de cada actualización queda en `logs/actualizacion.log`.

## Qué hace exactamente

1. ¿Existe `data/tmp/actualizacion.solicitada`? Si no, sale sin hacer nada.
2. Coge un cerrojo (`mkdir`, que es atómico) para que dos pasadas no lancen dos
   compilaciones a la vez.
3. **Borra la señal antes de empezar.** Si se borrara al terminar, un corte de
   luz a mitad la volvería a disparar sola en el siguiente arranque.
4. Escribe `estado: en_marcha` y ejecuta `./docker-update.sh`, volcándolo todo a
   `logs/actualizacion.log`.
5. Escribe el resultado (`ok` o `fallo`, con el código y la cola del registro).
   Para entonces el contenedor ya se ha reiniciado, así que ese fichero es lo
   único que le va a llegar a la pantalla.
