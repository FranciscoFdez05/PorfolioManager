// Invariantes del ámbito global del frontend.
//
// La aplicación no se empaqueta: los 27 ficheros de js/ son scripts clásicos
// que comparten un único ámbito global y se cargan por orden desde index.html.
// Eso deja dos formas de romper una pantalla sin que salte nada:
//
//   1. **Colisión de nombres.** Dos ficheros declaran la misma función y el
//      último que se carga machaca al anterior, de modo que un módulo acaba
//      ejecutando el código de otro. Ha pasado: `getOperationStablecoinSymbol`
//      estaba definida en stablecoins.js y en operaciones.js con criterios
//      distintos, y las llamadas de stablecoins.js usaban la de operaciones.js
//      sin que nada lo indicara.
//   2. **Orden de carga.** csrf.js envuelve `fetch` para añadir la cabecera
//      CSRF y api.js lo vuelve a envolver para tratar el 401. Un módulo que se
//      cargue antes que ellos y llame a fetch al evaluarse se salta las dos
//      cosas.
//
// Migrar a módulos ESM eliminaría ambos problemas de raíz, pero es un cambio de
// 29.000 líneas. Estas comprobaciones cubren las dos consecuencias concretas
// mientras tanto, y cuestan un segundo.
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** Todos los .js de la aplicación, sin las librerías de terceros. */
function scriptsDeLaAplicacion(directorio = join(RAIZ, "js"), encontrados = []) {
    for (const entrada of readdirSync(directorio)) {
        const ruta = join(directorio, entrada)
        if (statSync(ruta).isDirectory()) {
            if (entrada !== "vendor") scriptsDeLaAplicacion(ruta, encontrados)
        } else if (entrada.endsWith(".js")) {
            encontrados.push(ruta)
        }
    }
    return encontrados
}

function rutaRelativa(ruta) {
    return ruta.slice(RAIZ.length + 1).replaceAll("\\", "/")
}

/** Declaraciones de primer nivel (columna 0) de un fichero. */
function declaracionesGlobales(ruta) {
    const fuente = readFileSync(ruta, "utf-8")
    const nombres = []
    for (const coincidencia of fuente.matchAll(/^(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=)/gm)) {
        nombres.push(coincidencia[1] || coincidencia[2])
    }
    return nombres
}

describe("ámbito global compartido", () => {
    it("ningún nombre se declara en dos ficheros", () => {
        const porNombre = new Map()

        for (const ruta of scriptsDeLaAplicacion()) {
            for (const nombre of declaracionesGlobales(ruta)) {
                if (!porNombre.has(nombre)) porNombre.set(nombre, new Set())
                porNombre.get(nombre).add(rutaRelativa(ruta))
            }
        }

        const colisiones = [...porNombre.entries()]
            .filter(([, ficheros]) => ficheros.size > 1)
            .map(([nombre, ficheros]) => `${nombre}: ${[...ficheros].join(" y ")}`)

        expect(colisiones, "el último fichero cargado machacaría al anterior").toEqual([])
    })
})

describe("orden de carga de index.html", () => {
    const html = readFileSync(join(RAIZ, "index.html"), "utf-8")
    const scripts = [...html.matchAll(/<script[^>]+src="([^"?]+)/g)].map((m) => m[1])

    it("csrf.js va antes que cualquier otro script propio", () => {
        // Envuelve fetch para la cabecera CSRF: lo que se cargue antes queda
        // fuera de esa protección.
        const propios = scripts.filter((s) => s.startsWith("js/") && !s.startsWith("js/vendor/"))
        expect(propios[0]).toBe("js/core/csrf.js")
    })

    it("api.js va después de csrf.js y antes que el resto", () => {
        // El propio api.js lo documenta: "debe cargarse DESPUÉS de csrf.js
        // (que envuelve fetch para la cabecera CSRF) y ANTES del resto".
        const indiceCsrf = scripts.indexOf("js/core/csrf.js")
        const indiceApi = scripts.indexOf("js/core/api.js")

        expect(indiceCsrf).toBeGreaterThanOrEqual(0)
        expect(indiceApi).toBeGreaterThan(indiceCsrf)

        const posteriores = scripts.filter(
            (s) => s.startsWith("js/") && !s.startsWith("js/vendor/") && !s.startsWith("js/core/")
        )
        for (const script of posteriores) {
            expect(scripts.indexOf(script)).toBeGreaterThan(indiceApi)
        }
    })

    it("todos los scripts de index.html existen en el repositorio", () => {
        // Una ruta mal escrita da un 404 silencioso: la pantalla que dependa de
        // ese fichero simplemente no responde, sin ningún error visible.
        const ausentes = scripts.filter((src) => {
            try {
                return !statSync(join(RAIZ, src)).isFile()
            } catch {
                return true
            }
        })
        expect(ausentes).toEqual([])
    })

    it("ningún script se carga dos veces", () => {
        const repetidos = scripts.filter((s, i) => scripts.indexOf(s) !== i)
        expect(repetidos).toEqual([])
    })
})
