# Política de seguridad

## Versiones con soporte

| Versión | Soporte |
|---|---|
| 1.0.x | Sí |
| < 1.0 | No |

## Cómo informar de una vulnerabilidad

**No abras una issue pública.** Usa el aviso privado de GitHub:

**[Security → Report a vulnerability](https://github.com/FranciscoFdez05/PorfolioManager/security/advisories/new)**

Cuenta qué has encontrado, cómo reproducirlo y qué versión usas (`GET /api/health` la devuelve). Respondo en cuanto pueda; esto es un proyecto personal y no hay ningún acuerdo de plazos detrás.

## Qué cuenta como vulnerabilidad aquí

La aplicación está pensada para correr **en una red local o detrás de una VPN**, con un único usuario. Ese modelo de amenazas es lo que decide qué es un fallo y qué es una consecuencia de cómo se despliega.

**Sí lo es:**

- Saltarse la autenticación o el CSRF.
- Que un endpoint sirva ficheros fuera de la lista blanca de estáticos: `.env`, `data/`, `API/*.key` o el código fuente.
- Inyección SQL, XSS o escapado de rutas.
- Que una clave de API o la contraseña acaben en claro en disco o en el log.
- Saltarse el filtro de IP o la firma HMAC de los endpoints del Atajo de iOS.

**No lo es:**

- **Exponer la aplicación directamente a internet.** No está pensada para eso: no hay segundo factor ni aislamiento entre usuarios. Ponla detrás de una VPN. (Que se pueda servir por HTTPS no cambia esto: el TLS evita que la contraseña viaje en claro, no sustituye a lo demás.)
- Que alguien con acceso al servidor lea la base de datos. SQLite no está cifrado en reposo; eso lo resuelve el cifrado del disco.
- Que `SECRET_KEY` esté en `.env` en claro. Es la raíz de la que se derivan las demás claves y tiene que estar disponible al arrancar sin intervención.
- Denegación de servicio por fuerza bruta contra tu propia LAN.

## Lo que la aplicación ya hace

- Contraseña guardada como hash `pbkdf2:sha256`, nunca en claro.
- HTTPS que se activa desde la propia aplicación (Ajustes › Seguridad › HTTPS): emite el certificado, marca las cookies como `Secure`, emite `Strict-Transport-Security` y deja el puerto hablando solo TLS, sin reiniciar nada. El certificado de la CA se descarga desde el mismo panel para instalarlo en cada aparato. Sin activarlo, la contraseña del login y la cookie de sesión viajan en claro por la LAN. Ver «HTTPS» en el README.
- `API/*.key` cifradas en reposo con Fernet, con clave derivada de `SECRET_KEY`. Las que estuvieran en texto plano se convierten solas al arrancar.
- CSRF por doble cookie en toda petición que modifique estado.
- CSP con nonce y `script-src` cerrado a `'self'`: sin CDN, sin `unsafe-inline` para scripts.
- Límite de escrituras por IP, con un tope aparte para backup, restauración e importación.
- Todo el contenido estático pasa por un único manejador con lista blanca de extensiones y bloqueo de segmentos ocultos y de `..`.
- Los endpoints del Atajo de iOS se autentican por IP de origen más firma HMAC, y se pueden desactivar del todo.

## Si crees que tus datos han quedado expuestos

1. Cambia `SECRET_KEY` en `.env`. **Ojo:** eso invalida `auth.dat` y las `API/*.key` cifradas; tendrás que volver a crear las credenciales y a introducir las claves.
2. Revoca y regenera las claves de API en el panel de cada proveedor.
3. Revisa `logs/` por si el incidente dejó rastro.

### Rotar la `SECRET_KEY`, paso a paso

El orden importa: en cuanto la clave cambia, **lo que estaba cifrado con la vieja no se recupera**. Con ella se cifran `data/auth.dat`, las `API/*.key` de los proveedores y `API/movimientos.key` (la firma del Atajo de iOS).

1. **Copia las claves de API que estés usando.** Ajustes › API las enseña completas. Después del cambio ya no hay forma de leerlas.

2. **Regenera el hash de tu contraseña actual.** Al no poder descifrar `auth.dat`, el login cae a `LOGIN_USERNAME` y `LOGIN_PASSWORD_HASH` del `.env` (`python/routes/auth.py`), que son los del primer arranque: si cambiaste la contraseña desde Ajustes, volverías a la anterior sin que nada lo diga. Así no queda en el historial del shell:

   ```bash
   read -rsp "Contraseña: " PW; echo
   docker exec -i -e PW="$PW" PorfolioManager python -c "import os; from werkzeug.security import generate_password_hash; print(generate_password_hash(os.environ['PW'], method='pbkdf2:sha256:600000'))"
   unset PW
   ```

   Las iteraciones tienen que ser las de `[seguridad] hash_iteraciones` en `config.ini`. Sin Docker, el mismo `python -c` con el intérprete del entorno virtual.

3. **Genera la clave nueva:** `openssl rand -hex 32`.

4. **Edita `.env`:** `SECRET_KEY` con ese valor y `LOGIN_PASSWORD_HASH` con el hash del paso 2.

5. **Aparta lo que va a quedar indescifrable.** Moverlo, no borrarlo, hasta comprobar que todo funciona:

   ```bash
   mv data/auth.dat data/auth.dat.bak
   mkdir -p API/viejas && mv API/*.key API/viejas/
   ```

   `auth.dat` se vuelve a crear en el primer arranque con el usuario y el hash del `.env`.

6. **Levanta el stack con `./docker-up.sh`.** Tiene que ser un `up` y no un `restart`: el `.env` se lee al **crear** el contenedor, así que reiniciarlo seguiría usando la clave vieja.

7. **Rehaz lo cifrado.** Vuelve a introducir las claves en Ajustes › API y, si usas el Atajo de iOS, regenera la suya y actualiza el Atajo con el valor nuevo:

   ```bash
   docker exec -it PorfolioManager python tools/generar_clave_movimientos.py
   ```

8. **Vuelve a iniciar sesión.** Las sesiones abiertas quedan invalidadas, que es parte de lo que se busca al rotar.

Cuando todo responda —precios actualizándose y, si lo usas, el Atajo enviando—, borra `data/auth.dat.bak` y `API/viejas/`.
