# Librerías de terceros

Se sirven desde aquí y no desde un CDN por tres motivos:

1. **La aplicación es local.** Con Chart.js en jsdelivr, un portátil sin
   internet abría el portfolio pero sin un solo gráfico.
2. **Cierra el CSP.** Mientras hubiera un `<script src="https://…">`,
   `script-src` tenía que permitir ese dominio (`csp_origenes_scripts` en
   `config.ini`). Con la librería en local la política queda en `'self'`, que
   es la única forma de que un HTML inyectado no pueda traerse código de fuera.
3. **Cadena de suministro.** Un CDN comprometido ejecutaría código con la
   sesión del usuario abierta. `integrity=` lo detectaría, pero jsdelivr sirve
   estos ficheros regenerados y desaconseja SRI sobre ellos; tener el fichero
   fijado en el repositorio es más fuerte que un hash sobre algo remoto.

## Inventario

| Fichero | Versión | Origen |
|---|---|---|
| `chart.umd.min.js` | 4.4.4 | `https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js` |

## Cómo actualizar

```sh
curl -sSL -o js/vendor/chart.umd.min.js \
  "https://cdn.jsdelivr.net/npm/chart.js@<version>/dist/chart.umd.min.js"
```

Después actualiza la tabla de arriba y el `?v=` de la etiqueta `<script>` en
`index.html`: es lo único que invalida la caché del navegador para este fichero
(a diferencia del resto de `js/`, que el servidor envía con `no-store`).

`tests/test_vendor.py` comprueba que el fichero existe, que la versión declarada
en esta tabla es la que dice el propio fichero y que `index.html` no ha vuelto a
apuntar a un CDN.
