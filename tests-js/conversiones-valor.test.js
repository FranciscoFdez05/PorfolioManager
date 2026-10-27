// Valor de mercado en euros de las conversiones (js/cripto/conversiones.js).
//
// Convertir una cripto en otra es una permuta y su ganancia sale del valor en
// euros en ese momento. La aplicación no puede reconstruirlo: lo teclea el
// usuario en el formulario. Aquí se cubre el campo, su validación (vacío vale;
// ilegible o negativo, no) y la marca de las conversiones que aún no lo tienen,
// que además filtra la tabla.
import { runInThisContext } from "node:vm"

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarModulo, cargarScript } from "./cargar.js"

const ACTIVO = { id: "bitcoin", name: "Bitcoin", symbol: "BTC", marketSymbol: "BINANCE:BTCUSDT", type: "cripto" }

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/fusion-anual.js")
    cargarScript("js/core/app-core.js")
    cargarModulo("js/cartera/assets.js")
    cargarScript("js/cripto/conversiones.js")
})

beforeEach(() => {
    document.body.innerHTML = `
        <button id="cvFiltroSinValorBtn" class="hidden" type="button"></button>
        <table><tbody id="conversionesBody"></tbody></table>`
    runInThisContext(`conversionesCurrentAsset = ${JSON.stringify(ACTIVO)}; conversionesCryptoAssets = [${JSON.stringify(ACTIVO)}]`)
    globalThis.scheduleConversionesAutosave = vi.fn()
})

const fila = (extra = {}) => ({
    id: "c1",
    fecha: "10-01-2026",
    par: "BTC/ETH",
    tipo: "BTC convertidos",
    cantidad: "0,01",
    cantidadContraparte: "0,34",
    ...extra
})

const pintar = (...filas) => {
    const body = document.getElementById("conversionesBody")
    body.replaceChildren(...filas.map((f) => buildConversionesRowElement(f, ACTIVO)))
    return body
}

describe("validación del valor en euros", () => {
    it.each([
        ["", true, ""],
        ["   ", true, ""],
        ["150", true, "150"],
        ["1.234,5", true, "1234.5"],
        ["0", true, "0"],
        ["-5", false, ""],
        ["abc", false, ""]
    ])("%j -> ok %s", (texto, ok, valor) => {
        expect(parseConversionValorEur(texto)).toEqual({ ok, valor })
    })
})

describe("marca de las conversiones sin valor", () => {
    it("una conversión sin valor lleva la marca y la clase para filtrar", () => {
        const body = pintar(fila())

        expect(body.querySelector("tr").classList.contains("cvFilaSinValor")).toBe(true)
        expect(body.querySelector(".cvSinValor").textContent).toBe("Falta valor")
        expect(body.querySelector(".cvSinValor").title).toContain("informe de la renta")
    })

    it("una conversión con valor lo enseña en euros y no lleva marca", () => {
        const body = pintar(fila({ valorEur: "150" }))

        expect(body.querySelector("tr").classList.contains("cvFilaSinValor")).toBe(false)
        expect(body.querySelector(".cvSinValor")).toBeNull()
        expect(body.querySelector('[data-field="valorEur"]').dataset.value).toBe("150")
        expect(body.querySelector(".cvValorEur").textContent).toContain("150")
    })

    it("el valor tecleado se recoge al guardar la tabla", () => {
        pintar(fila({ valorEur: "150" }), fila({ id: "c2" }))

        const filas = collectConversionesRows()

        expect(filas.map((f) => f.valorEur)).toEqual(["150", ""])
    })

    it("el botón cuenta las pendientes, filtra y se oculta al completarlas", () => {
        const body = pintar(fila(), fila({ id: "c2", valorEur: "80" }), fila({ id: "c3" }))
        const boton = document.getElementById("cvFiltroSinValorBtn")

        refrescarConversionesSinValor()
        expect(boton.classList.contains("hidden")).toBe(false)
        expect(boton.textContent).toBe("2 sin valor en euros")

        // El clic del botón (enlazado en initConversionesLogic) alterna esta clase.
        body.classList.toggle("cvSoloSinValor")
        refrescarConversionesSinValor()
        expect(body.classList.contains("cvSoloSinValor")).toBe(true)
        expect(boton.getAttribute("aria-pressed")).toBe("true")
        expect(boton.textContent).toBe("Mostrar todas (2 sin valor)")

        body.replaceChildren(buildConversionesRowElement(fila({ id: "c2", valorEur: "80" }), ACTIVO))
        refrescarConversionesSinValor()
        expect(boton.classList.contains("hidden")).toBe(true)
        expect(body.classList.contains("cvSoloSinValor")).toBe(false)
    })
})

describe("formulario de conversión", () => {
    const abrir = () => {
        openConversiónRowModal("")
        return document.getElementById("conversionRowModalOverlay")
    }

    it("tiene el campo opcional con su ayuda", () => {
        const overlay = abrir()

        expect(overlay.querySelector("#cvModalValorEur")).not.toBeNull()
        expect(overlay.textContent).toContain("Valor en euros")
        expect(overlay.textContent).toContain(
            "Valor de mercado en el momento de la conversión; necesario para el informe de la renta."
        )
    })

    it("un valor negativo o ilegible avisa y no guarda", () => {
        const overlay = abrir()
        overlay.querySelector("#cvModalCantidad").value = "0,01"
        overlay.querySelector("#cvModalValorEur").value = "-5"

        saveConversiónRowFromModal()

        expect(document.getElementById("cvModalValorEurError").classList.contains("hidden")).toBe(false)
        expect(document.getElementById("conversionRowModalOverlay")).not.toBeNull()
        expect(document.querySelectorAll("#conversionesBody tr")).toHaveLength(0)
    })

    it("un valor válido se guarda en canónico y la fila ya no lleva marca", () => {
        const overlay = abrir()
        overlay.querySelector("#cvModalCantidad").value = "0,01"
        overlay.querySelector("#cvModalValorEur").value = "1.234,5"

        saveConversiónRowFromModal()

        const celda = document.querySelector('#conversionesBody [data-field="valorEur"]')
        expect(celda.dataset.value).toBe("1234.5")
        expect(document.querySelector("#conversionesBody .cvSinValor")).toBeNull()
        expect(scheduleConversionesAutosave).toHaveBeenCalled()
    })

    it("vacío es válido: la fila se guarda con la marca de pendiente", () => {
        const overlay = abrir()
        overlay.querySelector("#cvModalCantidad").value = "0,01"

        saveConversiónRowFromModal()

        expect(document.querySelector("#conversionesBody .cvSinValor")).not.toBeNull()
    })
})
