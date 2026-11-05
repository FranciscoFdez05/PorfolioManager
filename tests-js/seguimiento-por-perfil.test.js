// La lista de Análisis › Seguimiento es del perfil y vive en el servidor: es lo que
// la mete en las copias de seguridad. Lo que quedaba en el navegador se sube una
// vez, sin mezclar perfiles, y solo se borra de él si el servidor lo ha guardado.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => cargarScript("js/analisis/seguimiento.js"))

function respuestaOk(cuerpo) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(cuerpo) })
}

beforeEach(() => {
    localStorage.clear()
    window._seguimientoDatos = { lista: [], ocultos: [], overrides: {} }
})

describe("segAgruparLocal", () => {
    it("separa por perfil y deja las claves sin sufijo o con default en el activo", () => {
        const { portfolios, claves } = segAgruparLocal(
            [
                ["seguimientoList_uno", '[{"_segId":"a"}]'],
                ["seguimientoHidden_dos", '["portfolio_x"]'],
                ["seguimientoOverrides", '{"p":{"tvSymbol":"T"}}'],
                ["seguimientoList_default", '[{"_segId":"d"}]'],
                ["portfolioTheme", "black"],
                ["seguimientoFilterType_uno", '"all"']
            ],
            "uno"
        )
        expect(Object.keys(portfolios).sort()).toEqual(["dos", "uno"])
        expect(portfolios.uno.seguimientoLista).toEqual([{ _segId: "a" }, { _segId: "d" }])
        expect(portfolios.uno.seguimientoOverrides).toEqual({ p: { tvSymbol: "T" } })
        expect(portfolios.dos).toEqual({ seguimientoOcultos: ["portfolio_x"] })
        expect(claves.uno).not.toContain("seguimientoFilterType_uno")
    })

    it("ignora un valor ilegible sin marcarlo para borrar", () => {
        const { portfolios, claves } = segAgruparLocal([["seguimientoList_uno", "{roto"]], "uno")
        expect(portfolios).toEqual({})
        expect(claves).toEqual({})
    })
})

describe("segMigrarAlServidor", () => {
    it("sin nada en el navegador no llama al servidor", async () => {
        window.fetch = vi.fn()
        await segMigrarAlServidor("uno")
        expect(window.fetch).not.toHaveBeenCalled()
    })

    it("borra solo lo que el servidor confirma y actualiza la memoria", async () => {
        localStorage.setItem("seguimientoList_uno", '[{"_segId":"a"}]')
        localStorage.setItem("seguimientoList_borrado", '[{"_segId":"z"}]')
        window.fetch = vi.fn(() =>
            respuestaOk({
                ok: true,
                migrados: ["uno"],
                seguimientoLista: [{ _segId: "a" }],
                seguimientoOcultos: [],
                seguimientoOverrides: {}
            })
        )

        await segMigrarAlServidor("uno")

        expect(localStorage.getItem("seguimientoList_uno")).toBeNull()
        expect(localStorage.getItem("seguimientoList_borrado")).not.toBeNull()
        expect(segLoadCustomItems()).toEqual([{ _segId: "a" }])
    })

    it("si el servidor falla, el navegador conserva sus datos", async () => {
        localStorage.setItem("seguimientoList_uno", '[{"_segId":"a"}]')
        vi.spyOn(console, "error").mockImplementation(() => {})
        window.fetch = vi.fn(() =>
            Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false, error: "disco" }) })
        )

        await segMigrarAlServidor("uno")

        expect(localStorage.getItem("seguimientoList_uno")).not.toBeNull()
    })
})

describe("guardado", () => {
    it("modificar lo cargado no cambia la memoria hasta guardarlo", () => {
        window._seguimientoDatos.lista = [{ _segId: "a", price: "1" }]
        segLoadCustomItems()[0].price = "2"
        expect(window._seguimientoDatos.lista[0].price).toBe("1")
    })

    it("guarda en el perfil y no en localStorage, y tras restaurar deja de guardar", async () => {
        const llamadas = []
        window.fetch = vi.fn((url, opciones) => {
            llamadas.push([url, JSON.parse(opciones.body)])
            return respuestaOk({ ok: true })
        })

        segSaveCustomItems([{ _segId: "a" }])
        segSaveHidden(new Set(["portfolio_x"]))
        await new Promise((resuelve) => setTimeout(resuelve))

        expect(llamadas).toEqual([
            ["/api/settings", { seguimientoLista: [{ _segId: "a" }] }],
            ["/api/settings", { seguimientoOcultos: ["portfolio_x"] }]
        ])
        expect(Object.keys(localStorage)).toEqual([])

        window.dispatchEvent(new CustomEvent("app:datos-restaurados"))
        segSaveCustomItems([{ _segId: "viejo" }])
        await new Promise((resuelve) => setTimeout(resuelve))
        expect(llamadas).toHaveLength(2)
    })
})
