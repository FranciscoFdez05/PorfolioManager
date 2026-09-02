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

- **Exponer la aplicación directamente a internet.** No está pensada para eso: no hay TLS propio, ni segundo factor, ni aislamiento entre usuarios. Ponla detrás de una VPN.
- Que alguien con acceso al servidor lea la base de datos. SQLite no está cifrado en reposo; eso lo resuelve el cifrado del disco.
- Que `SECRET_KEY` esté en `.env` en claro. Es la raíz de la que se derivan las demás claves y tiene que estar disponible al arrancar sin intervención.
- Denegación de servicio por fuerza bruta contra tu propia LAN.

## Lo que la aplicación ya hace

- Contraseña guardada como hash `pbkdf2:sha256`, nunca en claro.
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
