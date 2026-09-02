// La página entera cargada de una vez, en el orden de index.html.
//
// El resto de pruebas cargan dos o tres módulos sueltos, y así no se ve lo que
// solo existe cuando están todos: estos scripts son clásicos, comparten un
// único ámbito global, y ahí caben fallos que ningún linter puede ver porque
// analiza fichero a fichero.
//
// El que dio origen a esto: `editAssetModalState` se declaraba `const` en
// js/core/app-core.js y la asignaba js/cartera/assets.js. No falla al cargar
// —falla al ejecutarse—, así que editar un activo reventaba con un
// «Assignment to constant variable» que el `catch` de turno traducía a «No se
// pudo actualizar el nombre del activo». Con él se habían roto también crear un
// activo y reordenarlos arrastrando.
//
// Lo que vigila este fichero, para toda función o variable que se añada después:
//
//   1. **Que la página cargue.** Dos declaraciones del mismo nombre en ficheros
//      distintos son un SyntaxError que mata el segundo script entero, y la
//      pantalla se queda a medias sin que nadie lo note en desarrollo.
//   2. **Que las globales compartidas se puedan escribir.** Son el puente entre
//      módulos, y el linter propone `const` para todas ellas.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { beforeAll, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** Los scripts propios que index.html carga, en su orden y sin los de vendor. */
function scriptsDeLaPagina() {
    const index = readFileSync(resolve(RAIZ, "index.html"), "utf-8")
    return [...index.matchAll(/src="(js\/[^"]+)"/g)]
        .map((m) => m[1].split("?")[0])
        .filter((src) => !src.includes("/vendor/"))
}

let fallo = null

beforeAll(() => {
    // Chart.js se carga del CDN en la página; aquí basta con que exista.
    globalThis.Chart = class {
        destroy() {}
        update() {}
    }

    try {
        scriptsDeLaPagina().forEach(cargarScript)
    } catch (error) {
        fallo = error
    }
})

describe("cargar la página entera", () => {
    it("no lanza ningún error", () => {
        // Un nombre declarado dos veces en ficheros distintos aparece aquí como
        // «Identifier 'x' has already been declared».
        expect(fallo).toBeNull()
    })

    it("carga los 29 módulos de js/", () => {
        expect(scriptsDeLaPagina().length).toBeGreaterThan(25)
    })
})

describe("globales que un módulo declara y otro asigna", () => {
    // Si alguna vuelve a ser `const`, esto es un TypeError. Es la comprobación
    // que ESLint no puede hacer, y por eso su declaración lleva un
    // `eslint-disable prefer-const` que explica por qué.
    it.each([
        ["currentAssetId", () => (currentAssetId = "x"), () => currentAssetId],
        ["assetModalState", () => (assetModalState = { isOpen: true }), () => assetModalState],
        ["confirmModalState", () => (confirmModalState = { onConfirm: null }), () => confirmModalState],
        ["editAssetModalState", () => (editAssetModalState = { isOpen: true }), () => editAssetModalState],
        ["draggedAssetId", () => (draggedAssetId = "x"), () => draggedAssetId]
    ])("%s se puede reasignar entre módulos", (_nombre, asignar, leer) => {
        expect(asignar).not.toThrow()
        expect(leer()).toBeTruthy()
    })
})

describe("diálogos de activo", () => {
    // Abrir y cerrar es donde vivía el fallo: las dos operaciones escriben la
    // global de estado, y ninguna prueba las tocaba.
    it("el diálogo de crear activo se abre y se cierra", () => {
        document.body.innerHTML = `
            <div id="assetModalOverlay" class="hidden"></div>
            <input id="assetNameInput">
            <select id="assetTypeSelect"><option value="cripto">Cripto</option></select>
            <input id="assetTickerInput">
            <div id="assetSearchFeedback"></div>
            <div id="assetSearchResults"></div>
        `

        expect(() => openAssetModal()).not.toThrow()
        expect(assetModalState).toEqual({ isOpen: true })

        expect(() => closeAssetModal()).not.toThrow()
        expect(document.getElementById("assetModalOverlay").classList.contains("hidden")).toBe(true)
        expect(assetModalState).toBeNull()
    })

    it("el diálogo de editar activo se abre y se cierra", () => {
        document.body.innerHTML = `
            <div id="editAssetModalOverlay" class="hidden"></div>
            <input id="editAssetNameInput">
            <input id="editAssetTickerInput">
            <input id="editAssetColorInput">
            <input id="editAssetTVTickerInput">
            <div id="editAssetSearchFeedback"></div>
            <div id="editAssetSearchResults"></div>
        `
        currentAssetId = "xrp"

        expect(() => openEditAssetModal({ name: "XRP", color: "#000000" })).not.toThrow()
        expect(editAssetModalState).toEqual({ isOpen: true })

        expect(() => closeEditAssetModal()).not.toThrow()
        expect(editAssetModalState).toBeNull()
    })
})
