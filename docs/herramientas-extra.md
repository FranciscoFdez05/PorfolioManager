# Añadir tus propias herramientas

La página **Herramientas** lee la carpeta `html/analisis/herramientas-extra/`.
Cada fichero `.html` que dejes ahí es una calculadora más: aparece en la
categoría **Propias** de la barra, con el mismo aspecto que las de serie. Esa
categoría sale sola en cuanto hay una herramienta tuya. No hay nada que
registrar ni ningún fichero de la aplicación que tocar, así que tus herramientas
sobreviven a las actualizaciones.

Tienes un ejemplo completo en esa misma carpeta: `regla-del-4.html` y
`regla-del-4.js`. Si no lo quieres, bórralo y su pestaña desaparece.

## Lo mínimo

1. Crea `html/analisis/herramientas-extra/mi-herramienta.html`.
2. Recarga la página en el navegador.

El nombre del fichero es el identificador, así que va en minúsculas y solo con
letras, números, guiones o guiones bajos (`precio-objetivo.html` vale,
`Precio Objetivo.html` no: se ignora y queda avisado en el log del servidor).

## Metadatos

Un comentario al principio del fichero rellena la cabecera del panel. Los dos
campos son opcionales; sin `titulo` se usa el nombre del fichero.

```html
<!-- herramienta
titulo: Poder adquisitivo
descripcion: Lo que valdrán tus euros dentro de unos años.
-->
```

Hay un tercer campo, `disposicion: completo`, para las herramientas que
necesitan todo el ancho (una tabla, por ejemplo) en lugar de las dos columnas
de parámetros y resultados.

## El cuerpo

En el fichero va **solo el cuerpo** del panel: el título y la descripción los
pinta la aplicación a partir de los metadatos. Reutiliza estas
clases y tu herramienta se verá como el resto, incluidos los temas claro y
negro:

| Clase | Para qué |
|---|---|
| `hCard herramientaInputs` | La tarjeta de la izquierda, con los campos |
| `hCardTitle` | Título pequeño dentro de una tarjeta |
| `herramientaField` + `hInputWrap` + `hInputUnit` | Campo con etiqueta y unidad (€, %, años) dentro del recuadro |
| `hBtnRow` + `herramientaCalcBtn` / `herramientaResetBtn` | Fila de botones. El de reiniciar funciona solo: vuelve a los valores por defecto y esconde los resultados |
| `hResultsCol` | La columna de la derecha |
| `herramientaResults hidden` | Bloque de resultados. Quítale `hidden` al calcular |
| `herramientaResultGrid` + `herramientaResultCard` | Rejilla de tarjetas de resultado; añade `hResultCardAccent` a la principal |
| `hResultLabel` / `hResultValue` | Etiqueta y cifra. `hResultPositive` y `hResultNegative` las pintan de verde o rojo |
| `hPlaceholder` | Aviso de «pulsa Calcular» mientras no hay resultados. Se esconde solo |

## La lógica

Si existe un `.js` con el mismo nombre, se carga con la herramienta. Solo tiene
que registrarse:

```js
registrarHerramienta("mi-herramienta", (panel) => {
    panel.querySelector("#miBoton").addEventListener("click", () => {
        const importe = parseFloat(panel.querySelector("#miImporte").value) || 0
        panel.querySelector("#miResultado").textContent = formatEuro(importe * 2)
        panel.querySelector("#misResultados").classList.remove("hidden")
    })
})
```

El primer argumento es el nombre del fichero, sin extensión. La función recibe
el panel ya montado y la aplicación la vuelve a llamar cada vez que entras en
la página, así que engancha ahí los listeners.

Busca los elementos dentro de `panel` (como arriba) y no con
`document.getElementById`: así dos herramientas que repitan un id no se pisan.

Puedes usar lo que la aplicación ya tiene cargado: `formatEuro()`,
`parseEuroNumber()`, `getChartPref()` / `setChartPref()` para recordar ajustes,
Chart.js y `fetch("/api/…")` para leer tus datos (`/api/activos`,
`/api/operaciones`, `/api/dividendos`…).

Dos límites que conviene saber:

- **El `<script>` en línea dentro del `.html` no se ejecuta.** La política de
  seguridad de la página (CSP) solo admite ficheros `.js` propios, que es justo
  para lo que está el fichero hermano.
- **Para escribir en la API** (POST, PUT, DELETE) hace falta la cabecera
  `X-CSRF-Token` con el valor de la cookie `csrf_token`. Para leer, no.

## Si algo no sale

- La categoría «Propias» no aparece → mira el nombre del fichero y el log del servidor.
- Aparece pero está vacía o no calcula → consola del navegador (F12). Un error
  dentro de tu herramienta se registra ahí y no tumba el resto de la página.
- Cambias el fichero y no ves el cambio → recarga con Ctrl+F5.

## Cómo funciona por dentro

El navegador no puede listar una carpeta, así que el servidor la recorre y
publica el índice en `GET /api/herramientas-extra`
([`python/routes/herramientas.py`](../python/routes/herramientas.py)). El
frontend monta con eso las pestañas y los paneles
([`js/analisis/herramientas.js`](../js/analisis/herramientas.js), sección
«Herramientas añadidas por el usuario»).

Los ficheros se ejecutan dentro de la página, con el mismo acceso que el resto
de la aplicación: trátalos como código tuyo, no pegues ahí nada que no hayas
leído.
