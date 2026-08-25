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
