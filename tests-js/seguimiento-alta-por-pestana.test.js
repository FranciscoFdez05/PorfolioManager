// Watchlist: «Añadir activo» da de alta lo que lista la pestaña abierta. En
// Operaciones y Wallets, que salen de otras pantallas, se desactiva y dice dónde ir.
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/analisis/seguimiento.js")
})

afterEach(() => {
    _segFilterSrc = "portfolio"
})

describe("segAltaDeFuente", () => {
    it.each([
        ["portfolio", "activo"],
        ["nuevos", "nuevo"],
        ["seguimiento", "elegir"]
    ])("en %s abre %s", (fuente, alta) => {
        expect(segAltaDeFuente(fuente)).toEqual({ alta, aviso: "" })
    })

    it.each(["operaciones", "wallets"])("en %s no añade nada y explica dónde se hace", (fuente) => {
        const { alta, aviso } = segAltaDeFuente(fuente)
        expect(alta).toBeNull()
        expect(aviso).toMatch(/Cripto ›/)
    })

    it("una pestaña desconocida no añade nada", () => {
        expect(segAltaDeFuente("otra")).toEqual({ alta: null, aviso: "" })
    })
})

describe("segSyncAddBtn", () => {
    it("desactiva el botón en Wallets y lo reactiva en Nuevos", () => {
        const boton = document.createElement("button")

        _segFilterSrc = "wallets"
        segSyncAddBtn(boton)
        expect(boton.disabled).toBe(true)
        expect(boton.title).toMatch(/wallets/)

        _segFilterSrc = "nuevos"
        segSyncAddBtn(boton)
        expect(boton.disabled).toBe(false)
        expect(boton.title).toBe("")
    })

    it("sin botón no falla", () => {
        expect(() => segSyncAddBtn(null)).not.toThrow()
    })
})
