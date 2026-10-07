// Carga un script clásico de js/ dentro del jsdom de la prueba.
//
// Los módulos del frontend no exportan nada: declaran funciones en el ámbito
// global y algunos se envuelven en una IIFE que asigna a `window.…`. Para
// probarlos hay que reproducir lo que hace el navegador con una etiqueta
// <script>, que es exactamente lo que hace `runInThisContext`: evaluar el
// fuente en el contexto global actual, de modo que las declaraciones de
// función de primer nivel queden accesibles.
//
// La alternativa era reescribir los módulos a ESM para poder importarlos, pero
// entonces las pruebas no estarían ejercitando el código que se sirve.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runInThisContext } from "node:vm"

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export function cargarScript(rutaRelativa) {
    const ruta = resolve(RAIZ, rutaRelativa)
    const fuente = readFileSync(ruta, "utf-8")
    runInThisContext(fuente, { filename: ruta })
}

/**
 * Carga un fichero junto con los trozos en que se dividió.
 *
 * assets.js, metricas.js y ajustes.js se partieron en varios ficheros que
 * comparten el ámbito global. Una prueba que cargue solo uno se queda sin las
 * funciones de los demás. Los trozos se sacan de index.html, que es quien
 * manda: son los scripts seguidos de la misma carpeta que rodean al pedido,
 * cargados en el mismo orden que en el navegador.
 */
export function cargarModulo(rutaRelativa) {
    const html = readFileSync(resolve(RAIZ, "index.html"), "utf-8")
    const scripts = [...html.matchAll(/<script[^>]+src="([^"?]+)/g)].map((m) => m[1])
    const carpeta = (ruta) => ruta.slice(0, ruta.lastIndexOf("/"))
    const indice = scripts.indexOf(rutaRelativa)
    if (indice === -1) throw new Error(`${rutaRelativa} no está en index.html`)

    let desde = indice
    while (desde > 0 && carpeta(scripts[desde - 1]) === carpeta(rutaRelativa)) desde--
    let hasta = indice
    while (hasta + 1 < scripts.length && carpeta(scripts[hasta + 1]) === carpeta(rutaRelativa)) hasta++

    const base = rutaRelativa.slice(carpeta(rutaRelativa).length + 1).replace(/\.js$/, "")
    const trozos = scripts
        .slice(desde, hasta + 1)
        .filter(
            (s) => s === rutaRelativa || s.includes(`/${base}-`) || TROZOS_CON_OTRO_NOMBRE[rutaRelativa]?.includes(s)
        )
    trozos.forEach(cargarScript)
}

// Trozos cuyo nombre no empieza por el del fichero del que salieron.
const TROZOS_CON_OTRO_NOMBRE = {
    "js/cartera/assets.js": ["js/cartera/activos-pagina.js"]
}
