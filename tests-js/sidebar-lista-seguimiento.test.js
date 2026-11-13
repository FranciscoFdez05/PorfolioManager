// Barra lateral de Activos: filtro «Listas» con las listas de Seguimiento.
//
// Con una lista elegida, la barra enseña los activos de esa lista (los del
// portfolio por su `assetId`); si la lista ya no existe, vuelve a Portfolio.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { cargarModulo, cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/app-core.js")
    cargarModulo("js/cartera/assets.js")
    cargarScript("js/analisis/seguimiento.js")
    cargarScript("js/analisis/seguimiento-listas.js")
})

const ACTIVOS = [
    { id: "btc", name: "Bitcoin", hasRows: true },
    { id: "aapl", name: "Apple", hasRows: true },
    { id: "gold", name: "Gold", hasRows: false }
]

beforeEach(() => {
    window._viewAllPortfolios = false
    window._seguimientoDatos = {
        lista: [
            { _segId: "s1", assetId: "gold" },
            { _segId: "s2", assetId: "btc" },
            { _segId: "s3", nombre: "Brent", ticker: "TVC:UKOIL" }
        ],
        ocultos: [],
        overrides: {},
        orden: [],
        listas: { l1: { nombre: "Materias", ids: ["s1", "s3"] } }
    }
    _sidebarFilter = "lista"
    _sidebarLista = "l1"
})

afterEach(() => {
    _sidebarFilter = "portfolio"
    _sidebarLista = ""
})

describe("getSidebarListaEntradas", () => {
    it("da las entradas de la lista, con activos del portfolio y nuevos", () => {
        expect(getSidebarListaEntradas().map((e) => e._segId)).toEqual(["s1", "s3"])
    })

    it("da null sin lista elegida o si ya no existe", () => {
        _sidebarLista = ""
        expect(getSidebarListaEntradas()).toBeNull()
        _sidebarLista = "borrada"
        expect(getSidebarListaEntradas()).toBeNull()
    })
})

describe("getSidebarVisibleAssets con una lista", () => {
    it("solo deja los activos de la lista, tengan o no posición", () => {
        expect(getSidebarVisibleAssets(ACTIVOS).map((a) => a.id)).toEqual(["gold"])
    })

    it("con una lista borrada se comporta como Portfolio", () => {
        _sidebarLista = "borrada"
        expect(getSidebarVisibleAssets(ACTIVOS).map((a) => a.id)).toEqual(["btc", "aapl"])
    })

    it("los filtros Portfolio y Watchlist no cambian", () => {
        _sidebarFilter = "portfolio"
        expect(getSidebarVisibleAssets(ACTIVOS).map((a) => a.id)).toEqual(["btc", "aapl"])
        _sidebarFilter = "watchlist"
        expect(getSidebarVisibleAssets(ACTIVOS).map((a) => a.id)).toEqual(["gold"])
    })
})

describe("sidebarActualizarListas", () => {
    beforeEach(() => {
        document.body.innerHTML = `<div id="sidebarFilterBar"><button id="sidebarListaBtn"></button></div>`
    })

    it("enseña en el desplegable el nombre de la lista elegida", () => {
        expect(sidebarActualizarListas()).toBe(false)
        expect(document.getElementById("sidebarListaBtn").textContent).toBe("Materias ▾")
    })

    it("vuelve a Portfolio si la lista elegida se borró", () => {
        window._seguimientoDatos.listas = {}
        expect(sidebarActualizarListas()).toBe(true)
        expect(_sidebarFilter).toBe("portfolio")
        expect(document.getElementById("sidebarListaBtn").textContent).toBe("Portfolio ▾")
    })

    it("sin lista elegida dice Portfolio", () => {
        _sidebarFilter = "portfolio"
        _sidebarLista = ""
        expect(sidebarActualizarListas()).toBe(false)
        expect(document.getElementById("sidebarListaBtn").textContent).toBe("Portfolio ▾")
    })
})
