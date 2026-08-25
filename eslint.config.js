// Configuración de ESLint.
//
// El frontend no se empaqueta: index.html carga una treintena de <script> y
// todos comparten el ámbito global de la página. Eso condiciona la
// configuración entera:
//
//   * `sourceType: "script"` — no hay import/export. Declararlo como módulo
//     haría que ESLint tratase cada fichero como su propio ámbito y marcara
//     como no definida cualquier función que viva en otro (947 falsos
//     positivos, medidos).
//   * Las funciones y constantes de nivel superior de un fichero son visibles
//     desde todos los demás. Para que `no-undef` sirva de algo hay que
//     declarárselas a ESLint, y mantener esa lista a mano en un proyecto de
//     40.000 líneas de JS sería una fuente de ruido permanente: se extraen del
//     propio código al cargar la configuración (ver `globalesDelProyecto`).
//
// Reglas: solo las que atrapan errores reales (`no-undef`, `no-unused-vars`,
// `no-dupe-keys`…). Nada de estilo — de eso se ocupa Prettier, y mezclarlos
// llena el informe de ruido que nadie lee.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import js from "@eslint/js"
import globals from "globals"

const RAIZ = path.dirname(fileURLToPath(import.meta.url))

// Declaraciones en la primera columna, es decir, las que quedan en el ámbito
// global de la página. Todo lo que esté indentado vive dentro de una función o
// de un IIFE y no es visible desde otro fichero, así que no entra.
const DECLARACION_GLOBAL = /^(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/

// Los módulos que sí se encapsulan en un IIFE (js/core/dom.js, js/core/api.js,
// js/analisis/seguimiento.js…) publican su API con `window.nombre = …`. Esos
// nombres no crean ninguna declaración léxica, así que —al revés que los
// anteriores— también hay que dárselos al fichero que los define: dentro de él
// se usan igual, sin el prefijo `window.`.
const EXPORTACION_WINDOW = /^\s*window\.([A-Za-z_$][\w$]*)\s*=/

/** Nombres que un fichero deja en el ámbito global de la página. */
function globalesDeFichero(ruta) {
    const lexicos = []
    const publicados = []
    for (const linea of fs.readFileSync(ruta, "utf8").split("\n")) {
        const declarado = DECLARACION_GLOBAL.exec(linea)
        if (declarado) lexicos.push(declarado[1])
        const publicado = EXPORTACION_WINDOW.exec(linea)
        if (publicado) publicados.push(publicado[1])
    }
    return { lexicos, publicados }
}

function ficherosJs(directorio) {
    return fs
        .readdirSync(directorio, { withFileTypes: true })
        .flatMap((entrada) => {
            const ruta = path.join(directorio, entrada.name)
            if (entrada.isDirectory()) return ficherosJs(ruta)
            return entrada.name.endsWith(".js") ? [ruta] : []
        })
}

// Un bloque de configuración por fichero, cada uno con los globales que
// aportan **los demás**. Incluir los propios haría que ESLint viera cada
// `function x()` como la redeclaración de un global (1.150 falsos positivos,
// medidos) y cada asignación a una variable propia como escritura sobre un
// global de solo lectura.
const globalesPorFichero = new Map(
    ficherosJs(path.join(RAIZ, "js")).map((ruta) => [ruta, globalesDeFichero(ruta)])
)

function globalesAjenos(rutaPropia) {
    const nombres = new Set()
    for (const [ruta, { lexicos, publicados }] of globalesPorFichero) {
        if (ruta === rutaPropia) {
            // Del propio fichero solo entra lo que publica en `window` sin
            // declararlo además con let/const/function: eso ya lo ve ESLint por
            // sí mismo, y anunciárselo dos veces lo convertiría en no-redeclare.
            const propios = new Set(lexicos)
            for (const nombre of publicados) {
                if (!propios.has(nombre)) nombres.add(nombre)
            }
            continue
        }
        // Lo publicado en `window` es visible desde todas partes; las
        // declaraciones léxicas, también, por el ámbito global compartido.
        for (const nombre of publicados) nombres.add(nombre)
        for (const nombre of lexicos) nombres.add(nombre)
    }
    // "writable": entre módulos sí se reasignan variables de estado
    // (`currentAssetId`, cachés compartidas…). Marcarlos de solo lectura
    // convertiría un patrón deliberado en 379 errores.
    return Object.fromEntries([...nombres].map((nombre) => [nombre, "writable"]))
}

const reglas = {
    // ── Lo que de verdad rompe en runtime ───────────────────────────
    // El motivo principal de montar esto: una función renombrada a
    // medias o un nombre mal escrito hoy solo se ve cuando el usuario
    // abre esa pantalla concreta.
    "no-undef": "error",
    // Aviso, no error: en 40.000 líneas retrofitadas hay una treintena de
    // variables calculadas y nunca usadas. Algunas son restos de un refactor y
    // otras pueden ser un cálculo que se dejó de pintar por error, así que
    // interesa verlas en el informe; bloquear cada PR por ellas solo llevaría a
    // silenciar la regla.
    "no-unused-vars": [
        "warn",
        {
            // `vars: "local"` es imprescindible aquí: las funciones de
            // nivel superior las llama el HTML (onclick, initXxx) o
            // cualquier otro <script>, y desde este fichero no tienen
            // ninguna referencia visible. Marcarlas daría un centenar
            // de falsos positivos.
            vars: "local",
            // Un argumento sin usar suele ser la firma de un callback,
            // no un olvido: `(event, indice)` cuando solo hace falta el
            // segundo.
            args: "after-used",
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
            caughtErrorsIgnorePattern: "^_"
        }
    ],
    "no-dupe-keys": "error",
    "no-dupe-args": "error",
    "no-dupe-else-if": "error",
    "no-duplicate-case": "error",
    "no-unreachable": "error",
    "no-fallthrough": "error",
    "no-self-assign": "error",
    "no-constant-condition": ["error", { checkLoops: false }],
    // `if (x = 1)` cuando se quería `==`. Los paréntesis explícitos
    // dejan pasar los casos en que la asignación sí es intencionada.
    "no-cond-assign": ["error", "except-parens"],
    "no-sparse-arrays": "error",
    "use-isnan": "error",
    "valid-typeof": "error",
    "no-async-promise-executor": "error",

    // ── Prácticas que aquí sí importan ──────────────────────────────
    // El HTML se construye con innerHTML en muchos sitios; eval y
    // similares no tienen ninguna justificación, y además la CSP los
    // bloquea en el navegador desde core/csp.py.
    "no-eval": "error",
    "no-implied-eval": "error",
    "no-new-func": "error",
    "no-script-url": "error",
    "no-var": "warn",
    "prefer-const": "warn",
    eqeqeq: ["warn", "smart"],

    // ── Ruido que no aporta en este código ──────────────────────────
    // console.warn/error se usan a propósito para los fallos de red que
    // no deben interrumpir la pantalla.
    "no-console": "off",
    "no-empty": ["error", { allowEmptyCatch: true }]
}

export default [
    {
        // js/vendor/ son librerías de terceros minificadas: no se editan aquí,
        // así que lintarlas solo produce miles de avisos que nadie puede arreglar.
        ignores: ["node_modules/**", "data/**", "logs/**", "API/**", "js/vendor/**"]
    },
    js.configs.recommended,
    ...[...globalesPorFichero.keys()].map((ruta) => ({
        files: [path.relative(RAIZ, ruta).split(path.sep).join("/")],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "script",
            globals: {
                ...globals.browser,
                // Chart.js se carga desde el CDN en index.html.
                Chart: "readonly",
                ...globalesAjenos(ruta)
            }
        },
        rules: reglas
    }))
]
