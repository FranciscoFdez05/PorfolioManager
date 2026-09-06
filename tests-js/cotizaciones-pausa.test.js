// Por qué un precio del sidebar no se mueve.
//
// Hay tres motivos y antes se veían los tres igual: un número quieto. Uno es
// que el dato ha pasado el umbral de Ajustes, otro que la actualización está
// pausada a propósito (fin de semana, o fuera del horario de mercado), y el
// tercero que el proveedor está fallando. Solo el último pide hacer algo, así
// que solo el último lleva ⚠; los otros dos se quedan en gris, y la pausa
// además dice en una línea por qué lo está.
//
// La otra mitad de estas pruebas es la pausa en sí: se aplica por tipo de
// activo, no al refresco entero, porque la cripto cotiza los domingos y el
// propio panel de Ajustes promete no pausarla.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/app-core.js")
    cargarScript("js/cartera/assets.js")
})

const ACCION = {
    id: "apple",
    name: "Apple",
    symbol: "AAPL",
    type: "acciones",
    price: "275,31",
    currency: "EUR",
    change: "-2,51%",
    hasRows: true,
    lastUpdated: new Date().toISOString()
}

const CRIPTO = {
    id: "xrp",
    name: "XRP",
    symbol: "XRP",
    type: "cripto",
    price: "1,22",
    currency: "EUR",
    change: "+0,69%",
    hasRows: true,
    lastUpdated: new Date().toISOString()
}

/** El sidebar, con el hueco del aviso que trae index.html. */
function montarSidebar() {
    document.body.innerHTML = `
        <div class="assetsPausaAviso" id="assetsPausaAviso" hidden></div>
        <div class="assetsList" id="assetsList"></div>
    `
}

const boton = (id) => document.querySelector(`.assetBtn[data-asset-id="${id}"]`)
const aviso = () => document.getElementById("assetsPausaAviso")

/** Un sábado a mediodía, un martes a las 3 de la mañana, un martes a mediodía. */
const SABADO = new Date("2026-09-05T12:00:00")
const MARTES_DE_MADRUGADA = new Date("2026-09-01T03:00:00")
const MARTES_LABORABLE = new Date("2026-09-01T12:00:00")

beforeEach(() => {
    vi.useFakeTimers()
    montarSidebar()
    _falloApiPorActivo.clear()
    _sidebarFilter = "portfolio"
    window._viewAllPortfolios = false
    window._hiddenAssets = new Set()
    window._settingsStaleHours = 0
    window._soloHorarioMercado = true
    window._soloMercadoTipos = ["acciones", "etfs", "comoditis"]
})

afterEach(() => {
    vi.useRealTimers()
})

describe("cuándo está pausada la actualización", () => {
    it("el fin de semana, con ese motivo", () => {
        vi.setSystemTime(SABADO)
        expect(motivoPausaMercado()).toBe("fin de semana")
    })

    it("fuera de horario entre semana", () => {
        vi.setSystemTime(MARTES_DE_MADRUGADA)
        expect(motivoPausaMercado()).toBe("fuera de horario")
    })

    it("con el mercado abierto, no", () => {
        vi.setSystemTime(MARTES_LABORABLE)
        expect(motivoPausaMercado()).toBe("")
    })

    it("la cripto no se pausa nunca: cotiza 24/7", () => {
        vi.setSystemTime(SABADO)
        expect(tipoEnPausa("acciones")).toBe(true)
        expect(tipoEnPausa("cripto")).toBe(false)
    })

    it("con el ajuste apagado no se pausa nada", () => {
        vi.setSystemTime(SABADO)
        window._soloHorarioMercado = false
        expect(tipoEnPausa("acciones")).toBe(false)
    })
})

describe("cómo se ve la pausa en el sidebar", () => {
    it("gris para lo pausado y color normal para la cripto", async () => {
        vi.setSystemTime(SABADO)
        await renderAssetsList([ACCION, CRIPTO])

        expect(boton("apple").className).toContain("pausado")
        expect(boton("xrp").className).not.toContain("pausado")
    })

    it("el aviso dice que es fin de semana y cuándo vuelve", async () => {
        vi.setSystemTime(SABADO)
        await renderAssetsList([ACCION, CRIPTO])

        expect(aviso().hidden).toBe(false)
        expect(aviso().textContent).toContain("fin de semana")
        expect(aviso().textContent).toContain("el lunes a las 8:00")
        expect(aviso().textContent).toContain("El resto se sigue actualizando.")
    })

    it("fuera de horario lo dice sin hablar del fin de semana", async () => {
        vi.setSystemTime(MARTES_DE_MADRUGADA)
        await renderAssetsList([ACCION])

        expect(aviso().textContent).toContain("fuera del horario de mercado")
        expect(aviso().textContent).not.toContain("fin de semana")
    })

    it("sin activos pausados no se avisa de nada", async () => {
        vi.setSystemTime(SABADO)
        await renderAssetsList([CRIPTO])

        expect(aviso().hidden).toBe(true)
    })

    it("con el mercado abierto tampoco", async () => {
        vi.setSystemTime(MARTES_LABORABLE)
        await renderAssetsList([ACCION, CRIPTO])

        expect(aviso().hidden).toBe(true)
        expect(boton("apple").className).not.toContain("pausado")
    })

    it("una pausa no lleva ⚠: no hay nada roto", async () => {
        vi.setSystemTime(SABADO)
        await renderAssetsList([ACCION])

        expect(boton("apple").querySelector(".assetBtnAviso")).toBeNull()
        expect(boton("apple").title).toContain("Precios en pausa")
    })
})

describe("cómo se ve un fallo del proveedor", () => {
    it("lleva ⚠ y el motivo que dio el proveedor", async () => {
        vi.setSystemTime(MARTES_LABORABLE)
        _falloApiPorActivo.set("apple", "Clave de API rechazada")
        await renderAssetsList([ACCION])

        expect(boton("apple").querySelector(".assetBtnAviso").textContent).toBe("⚠")
        expect(boton("apple").className).toContain("falloApi")
        expect(boton("apple").title).toContain("Clave de API rechazada")
    })

    it("el fallo manda sobre la pausa: si hay avería, se dice", async () => {
        vi.setSystemTime(SABADO)
        _falloApiPorActivo.set("apple", "Cuota agotada")
        await renderAssetsList([ACCION])

        expect(boton("apple").querySelector(".assetBtnAviso")).not.toBeNull()
        expect(boton("apple").title).toContain("Cuota agotada")
    })

    it("el mensaje sale del JSON del servidor, no del código HTTP", () => {
        const error = new Error('HTTP 503: {"ok": false, "error": "Finnhub: cuota agotada"}')
        expect(_mensajeDeFalloApi(error)).toBe("Finnhub: cuota agotada")
    })
})
