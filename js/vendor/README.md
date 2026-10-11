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

| Fichero | Versión | Origen | SHA-256 |
|---|---|---|---|
| `chart.umd.min.js` | 4.5.1 | `package/dist/chart.umd.min.js` del paquete npm `chart.js@4.5.1` (integridad del registro `sha512-GIjfiT9dbmHRiYi6Nl2yFCq7kkwdkp1W/lp2J99rX0yo9tgJGn3lKQATztIjb5tVtevcBtIdICNWqlq5+E8/Pw==`) | `48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a` |
| `html2canvas-pro.min.js` | 2.4.5 | `package/dist/html2canvas-pro.min.js` del paquete npm `html2canvas-pro@2.4.5` (integridad del registro `sha512-aeAwXx+Tt+i3ci0PJffMJVyxr0FJzuz44SkB7j/2Mh6Mjb7/+OeMhms56wK4j72zzKlKthoxSMzd883Lr0PcCA==`) | `83de413ad498bdedb4cbc6ede80f8d349b52ce728131db16e134dbe1ced95c97` |
| `jspdf.umd.min.js` | 4.2.1 | `package/dist/jspdf.umd.min.js` del paquete npm `jspdf@4.2.1` (integridad del registro `sha512-YyAXyvnmjTbR4bHQRLzex3CuINCDlQnBqoSYyjJwTP2x9jDLuKDzy7aKUl0hgx3uhcl7xzg32agn5vlie6HIlQ==`) | `e6551fcdc32f09d6853b2c5126d18d01d9447e0da618a41a11ebeee0f6c20d54` |

`html2canvas-pro` y `jspdf` solo los usan los informes en PDF (`js/core/informes.js`):
el primero pasa el informe maquetado en HTML a imagen y el segundo lo reparte en hojas A4
y lo descarga. Se usa `html2canvas-pro` y no `html2canvas` porque el original lleva sin
publicar desde 2022.

## Cómo actualizar

Desde el paquete publicado en npm y no desde el CDN: `npm pack` comprueba el
fichero descargado contra la integridad que publica el registro, y el CDN sirve
una copia regenerada sobre la que no hay nada que comprobar.

```sh
cd "$(mktemp -d)"
npm view chart.js version dist.integrity        # versión e integridad publicadas
npm pack chart.js@<version>                      # descarga y verifica el .tgz
tar -xzf chart.js-<version>.tgz
cp package/dist/chart.umd.min.js <proyecto>/js/vendor/chart.umd.min.js
sha256sum <proyecto>/js/vendor/chart.umd.min.js
```

Después actualiza la tabla de arriba (versión, integridad y SHA-256) y el `?v=`
de la etiqueta `<script>` en `index.html`: es lo único que invalida la caché del
navegador para este fichero (el servidor lo envía con caché de un año).

`tests/test_csp.py` comprueba que el fichero existe, que la versión declarada
en esta tabla es la que dice el propio fichero, que `index.html` la pide con ese
`?v=` y que no ha vuelto a apuntar a un CDN.
