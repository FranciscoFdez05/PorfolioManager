// Pruebas de la detección del tipo de activo a partir de un resultado de
// búsqueda (js/core/shared-utils.js): "Detectar automáticamente" en los
// desplegables de tipo de Añadir activo y de Seguimiento.
import { beforeAll, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
})

function crearSelect(valor = "") {
    const select = document.createElement("select")
    select.innerHTML = `
        <option value="">Detectar automáticamente</option>
        <option value="acciones">Acciones</option>
        <option value="etfs">ETFs</option>
        <option value="cripto">Cripto</option>
        <option value="comoditis">Comoditis</option>
        <option value="indices">Índices</option>`
    select.value = valor
    return select
}

describe("detectarTipoActivo", () => {
    it.each([
        ["stock", "acciones"],
        ["Common Stock", "acciones"],
        ["ETP", "etfs"],
        ["etf", "etfs"],
        ["fund", "etfs"],
        ["crypto", "cripto"],
        ["Cryptocurrency", "cripto"],
        ["commodity", "comoditis"],
        ["futures", "comoditis"],
        ["index", "indices"],
        ["INDEX", "indices"]
    ])("traduce %s a %s", (tipoApi, esperado) => {
        expect(detectarTipoActivo({ type: tipoApi })).toBe(esperado)
    })

    it.each(["forex", "bond", "perpetuo", "market", "", undefined])("no adivina con %s", (tipoApi) => {
        expect(detectarTipoActivo({ type: tipoApi })).toBe("")
    })

    it("aguanta un resultado nulo", () => {
        expect(detectarTipoActivo(null)).toBe("")
    })
})

describe("autorrellenarTipoActivo", () => {
    it("rellena el tipo y avisa con change cuando está en Detectar", () => {
        const select = crearSelect("")
        let cambios = 0
        select.addEventListener("change", () => cambios++)

        expect(autorrellenarTipoActivo(select, { type: "index" })).toBe(true)
        expect(select.value).toBe("indices")
        expect(cambios).toBe(1)
    })

    it("respeta el tipo elegido a mano", () => {
        const select = crearSelect("etfs")
        expect(autorrellenarTipoActivo(select, { type: "stock" })).toBe(false)
        expect(select.value).toBe("etfs")
    })

    it("se queda en Detectar si no se puede saber el tipo", () => {
        const select = crearSelect("")
        expect(autorrellenarTipoActivo(select, { type: "forex" })).toBe(false)
        expect(select.value).toBe("")
    })

    it("no elige un tipo que el desplegable no ofrece", () => {
        const select = crearSelect("")
        select.querySelector('option[value="indices"]').remove()
        expect(autorrellenarTipoActivo(select, { type: "index" })).toBe(false)
        expect(select.value).toBe("")
    })

    it("aguanta que no haya desplegable", () => {
        expect(autorrellenarTipoActivo(null, { type: "stock" })).toBe(false)
    })
})
