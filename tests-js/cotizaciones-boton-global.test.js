// Botón «Actualizar cotizaciones» de la Vista general.
//
// La carga y el refresco automáticos aceptan la caché de cotizaciones del
// servidor; este botón es la acción explícita que pide precio nuevo de todo.
// Lo que no puede cambiar: no manda `usarCache`, queda deshabilitado mientras
// dura (un segundo clic gastaría la cuota dos veces), no pide los activos sin
// ticker y al acabar dice cuántos se actualizaron y cuántos fallaron.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarModulo, cargarScript } from "./cargar.js"

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..")

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/app-core.js")
    cargarModulo("js/cartera/assets.js")
})

const activos = [
    { id: "a1", name: "Uno", marketSymbol: "AAA", type: "acciones" },
    { id: "a2", name: "Dos", marketSymbol: "BBB", type: "etfs" },
    { id: "a3", name: "Tres", marketSymbol: "CCC", type: "cripto" },
    { id: "a4", name: "Sin ticker", marketSymbol: "", type: "acciones" }
]

let peticiones
let soltar
let boton

function respuesta(cuerpo, estado = 200) {
    return Promise.resolve(new Response(JSON.stringify(cuerpo), { status: estado }))
}

beforeEach(() => {
    peticiones = []
    soltar = null
    _falloApiPorActivo.clear()
    window._viewAllPortfolios = false
    globalThis.refreshAssetsSidebar = vi.fn()
    globalThis.renderVistaGeneralTable = vi.fn()
    let liberar
    const barrera = new Promise((r) => (liberar = r))
    soltar = liberar
    globalThis.fetch = vi.fn(async (url, init) => {
        if (url === "/api/activos") return respuesta({ assets: activos })
        const m = String(url).match(/^\/api\/activos\/([^/]+)\/refresh-market-data$/)
        if (!m) return respuesta({})
        peticiones.push({ id: m[1], init })
        await barrera
        return m[1] === "a3"
            ? respuesta({ ok: false, error: "Los proveedores de este activo están pausados (Ajustes > API)" }, 400)
            : respuesta({ ok: true })
    })
    vi.spyOn(window, "showToast")
    vi.spyOn(console, "error").mockImplementation(() => {})

    document.body.innerHTML = readFileSync(resolve(RAIZ, "html/cartera/vista-general.html"), "utf-8")
    boton = document.getElementById("refreshOverviewMarketBtn")
})

afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ""
})

const texto = () => boton.querySelector(".overviewRefreshTexto").textContent

describe("botón «Actualizar cotizaciones»", () => {
    it("está en la Vista general y el clic llega a refreshOverviewMarketData", async () => {
        expect(boton).not.toBeNull()
        await initVistaGeneralLogic()

        boton.click()
        await vi.waitFor(() => expect(peticiones).toHaveLength(3))
        expect(boton.disabled).toBe(true)
        soltar()
        await vi.waitFor(() => expect(boton.disabled).toBe(false))
    })

    it("fuerza precio nuevo: no manda usarCache al servidor", async () => {
        const enMarcha = refreshOverviewMarketData(boton)
        await vi.waitFor(() => expect(peticiones).toHaveLength(3))
        soltar()
        await enMarcha

        for (const { init } of peticiones) {
            expect(init.method).toBe("POST")
            expect(init.body).toBeUndefined()
        }
    })

    it("queda deshabilitado y en estado de carga mientras dura la petición", async () => {
        const enMarcha = refreshOverviewMarketData(boton)
        await vi.waitFor(() => expect(peticiones).toHaveLength(3))

        expect(boton.disabled).toBe(true)
        expect(boton.getAttribute("aria-busy")).toBe("true")
        expect(texto()).toBe("Actualizando...")
        // El icono sigue: solo cambia el texto.
        expect(boton.querySelector(".iconoRecargar")).not.toBeNull()

        soltar()
        await enMarcha

        expect(boton.disabled).toBe(false)
        expect(boton.hasAttribute("aria-busy")).toBe(false)
        expect(texto()).toBe("Actualizar cotizaciones")
    })

    it("no pide los activos sin ticker", async () => {
        const enMarcha = refreshOverviewMarketData(boton)
        await vi.waitFor(() => expect(peticiones).toHaveLength(3))
        soltar()
        await enMarcha

        expect(peticiones.map((p) => p.id).sort()).toEqual(["a1", "a2", "a3"])
    })

    it("avisa de cuántos se actualizaron, cuántos fallaron y cuántos no tienen ticker", async () => {
        const enMarcha = refreshOverviewMarketData(boton)
        await vi.waitFor(() => expect(peticiones).toHaveLength(3))
        soltar()
        await enMarcha

        expect(window.showToast).toHaveBeenCalledTimes(1)
        const [mensaje, opciones] = window.showToast.mock.calls[0]
        expect(mensaje).toContain("2 de 3")
        expect(mensaje).toContain("1 ha fallado")
        expect(mensaje).toContain("1 activo sin ticker")
        expect(opciones).toEqual({ type: "warning" })
        // El proveedor pausado no se consulta; su motivo queda para la barra lateral.
        expect(_falloApiPorActivo.get("a3")).toContain("pausados")
    })

    it("se rehabilita aunque falle la carga de la lista", async () => {
        globalThis.fetch = vi.fn(() => Promise.reject(new Error("sin red")))

        await expect(refreshOverviewMarketData(boton)).rejects.toThrow()
        expect(boton.disabled).toBe(false)
        expect(texto()).toBe("Actualizar cotizaciones")
    })
})

describe("refresco automático (sin botón)", () => {
    it("sigue aceptando la caché del servidor y no avisa", async () => {
        const enMarcha = refreshOverviewMarketData(null, { maxEdadSegundos: 300 })
        await vi.waitFor(() => expect(peticiones).toHaveLength(3))
        soltar()
        await enMarcha

        for (const { init } of peticiones) {
            expect(JSON.parse(init.body)).toEqual({ usarCache: true, maxEdadSegundos: 300 })
        }
        expect(window.showToast).not.toHaveBeenCalled()
    })
})

describe("resumenActualizacionCotizaciones", () => {
    it("todo bien: éxito", () => {
        expect(resumenActualizacionCotizaciones({ actualizados: 4, fallidos: 0, sinTicker: 0 })).toEqual({
            mensaje: "Cotizaciones actualizadas: 4 de 4.",
            tipo: "success"
        })
    })

    it("todos fallan: error, en plural", () => {
        const aviso = resumenActualizacionCotizaciones({ actualizados: 0, fallidos: 3, sinTicker: 2 })
        expect(aviso.tipo).toBe("error")
        expect(aviso.mensaje).toContain("3 han fallado")
        expect(aviso.mensaje).toContain("2 activos sin ticker no se piden")
    })

    it("ningún activo con ticker: lo dice en vez de dar 0 de 0", () => {
        const aviso = resumenActualizacionCotizaciones({ actualizados: 0, fallidos: 0, sinTicker: 5 })
        expect(aviso.tipo).toBe("info")
        expect(aviso.mensaje).not.toContain("0 de 0")
    })
})
