// Seguimiento: listas con nombre, subconjuntos de la lista de seguimiento que
// los mapas de Paneles pueden elegir.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/analisis/seguimiento.js")
    cargarScript("js/analisis/seguimiento-listas.js")
})

beforeEach(() => {
    window._seguimientoDatos = { lista: [], ocultos: [], overrides: {}, orden: [], listas: {} }
    window._segOperacionesItems = []
    window._segWalletItems = []
    window.fetch = vi.fn(() => Promise.resolve({ ok: true }))
    _segFilterLista = ""
    _segFilterType = "all"
    _segFilterSrc = "all"
    _segSearch = ""
})

describe("segListasLeer", () => {
    it("sin listas guardadas devuelve una lista vacía", () => {
        expect(segListasLeer()).toEqual([])
    })

    it("tolera datos sin el campo de listas (perfil anterior)", () => {
        window._seguimientoDatos = { lista: [], ocultos: [], overrides: {}, orden: [] }
        expect(segListasLeer()).toEqual([])
    })

    it("devuelve copias que no tocan lo guardado", () => {
        window._seguimientoDatos.listas = { a: { nombre: "Cripto", ids: ["x"] } }
        segListasLeer()[0].ids.push("y")
        expect(window._seguimientoDatos.listas.a.ids).toEqual(["x"])
    })
})

describe("segListaCrear", () => {
    it("crea listas con nombre que no se repite y las guarda en el servidor", async () => {
        const primera = segListaCrear()
        const segunda = segListaCrear()
        await _segGuardadoEnCola

        expect(primera).not.toBe(segunda)
        expect(segListasLeer().map((l) => l.nombre)).toEqual(["Lista 1", "Lista 2"])
        const [url, opciones] = window.fetch.mock.calls.at(-1)
        expect(url).toBe("/api/settings")
        expect(Object.keys(JSON.parse(opciones.body).seguimientoListas)).toEqual([primera, segunda])
    })

    it("la primera, con activos ya en Seguimiento, se llama Seguimiento y los lleva todos", () => {
        window._seguimientoDatos.lista = [
            { _segId: "s1", assetId: "a" },
            { _segId: "s2", nombre: "Brent" }
        ]
        segListaCrear()

        expect(segListasLeer().map((l) => [l.nombre, l.ids])).toEqual([["Seguimiento", ["s1", "s2"]]])
    })

    it("las siguientes nacen vacías aunque haya activos", () => {
        window._seguimientoDatos.lista = [{ _segId: "s1", assetId: "a" }]
        segListaCrear()
        segListaCrear()

        expect(segListasLeer().map((l) => [l.nombre, l.ids.length])).toEqual([
            ["Seguimiento", 1],
            ["Lista 2", 0]
        ])
    })

    it("el nombre de partida se puede cambiar", () => {
        window._seguimientoDatos.lista = [{ _segId: "s1", assetId: "a" }]
        const id = segListaCrear()
        segListaRenombrar(id, "Mis valores")

        expect(segListasLeer()[0]).toMatchObject({ nombre: "Mis valores", ids: ["s1"] })
    })

    it("no repite un nombre ya usado aunque falte un número", () => {
        window._seguimientoDatos.listas = { a: { nombre: "lista 2", ids: [] } }
        segListaCrear()
        expect(segListasLeer().map((l) => l.nombre)).toEqual(["lista 2", "Lista 3"])
    })
})

describe("segListaRenombrar", () => {
    beforeEach(() => {
        window._seguimientoDatos.listas = { a: { nombre: "Cripto", ids: [] } }
    })

    it("cambia el nombre y recorta espacios", () => {
        expect(segListaRenombrar("a", "  Dividendos ")).toBe(true)
        expect(segListasLeer()[0].nombre).toBe("Dividendos")
    })

    it("ignora un nombre vacío, igual al actual o de una lista que no existe", () => {
        expect(segListaRenombrar("a", "   ")).toBe(false)
        expect(segListaRenombrar("a", "Cripto")).toBe(false)
        expect(segListaRenombrar("zz", "Otro")).toBe(false)
        expect(segListasLeer()[0].nombre).toBe("Cripto")
    })
})

describe("segListaAlternar y segListaBorrar", () => {
    beforeEach(() => {
        window._seguimientoDatos.listas = { a: { nombre: "Cripto", ids: ["x"] } }
    })

    it("añade un activo una sola vez y lo quita", () => {
        segListaAlternar("a", "y", true)
        segListaAlternar("a", "y", true)
        expect(segListasLeer()[0].ids).toEqual(["x", "y"])

        segListaAlternar("a", "x", false)
        expect(segListasLeer()[0].ids).toEqual(["y"])
    })

    it("no hace nada con una lista que no existe", () => {
        segListaAlternar("zz", "y", true)
        expect(segListasLeer()).toHaveLength(1)
    })

    it("marca o desmarca varios a la vez sin repetir", () => {
        segListaAlternarVarios("a", ["x", "y", "z"], true)
        expect(segListasLeer()[0].ids).toEqual(["x", "y", "z"])

        segListaAlternarVarios("a", ["x", "z"], false)
        expect(segListasLeer()[0].ids).toEqual(["y"])
    })

    it("borrar quita la lista", () => {
        segListaBorrar("a")
        expect(segListasLeer()).toEqual([])
    })
})

describe("segListaIds", () => {
    it("da null si la lista no existe, para volver a Seguimiento entero", () => {
        expect(segListaIds("zz")).toBeNull()
        expect(segListaIds("")).toBeNull()
    })

    it("da los activos de la lista", () => {
        window._seguimientoDatos.listas = { a: { nombre: "Cripto", ids: ["x", "y"] } }
        expect([...segListaIds("a")]).toEqual(["x", "y"])
    })
})

describe("añadir activos con una lista elegida", () => {
    beforeEach(() => {
        window._seguimientoDatos.listas = { a: { nombre: "Cripto", ids: ["x"] } }
    })

    it("con una lista elegida manda la pestaña de Seguimiento; sin ella, la fuente", () => {
        _segFilterSrc = "wallets"
        expect(segFuenteEfectiva()).toBe("wallets")

        _segFilterLista = "a"
        expect(segFuenteEfectiva()).toBe("seguimiento")
        const boton = document.createElement("button")
        segSyncAddBtn(boton)
        expect(boton.disabled).toBe(false)
    })

    it("los activos nuevos entran en la lista elegida", () => {
        _segFilterLista = "a"
        segListaAnadirALaElegida(["y", "z"])
        expect(segListasLeer()[0].ids).toEqual(["x", "y", "z"])
    })

    it("sin lista elegida no se toca ninguna", () => {
        segListaAnadirALaElegida(["y"])
        expect(segListasLeer()[0].ids).toEqual(["x"])
    })
})

describe("filtro de la página por lista", () => {
    const ACTIVOS = [
        { id: "bitcoin", name: "Bitcoin", symbol: "BTC", type: "cripto", price: "1", hasRows: true },
        { id: "apple", name: "Apple", symbol: "AAPL", type: "acciones", price: "1", hasRows: true }
    ]

    beforeEach(() => {
        window._seguimientoDatos.lista = [
            { _segId: "ref_1", assetId: "bitcoin" },
            { _segId: "ref_2", assetId: "apple" }
        ]
        window._seguimientoDatos.listas = { a: { nombre: "Cripto", ids: ["ref_1"] } }
        document.body.innerHTML = `<div id="seguimientoGrid"></div>`
        segMergeAndRender(ACTIVOS)
    })

    it("sin lista elegida manda la fuente", () => {
        _segFilterSrc = "seguimiento"
        expect(segFilteredItems().map((i) => i._segId)).toContain("ref_2")
    })

    it("con una lista solo salen sus activos de Seguimiento, sea cual sea la fuente", () => {
        _segFilterLista = "a"
        _segFilterSrc = "portfolio"
        expect(segFilteredItems().map((i) => i._segId)).toEqual(["ref_1"])
    })
})

describe("segArrastrarScroll", () => {
    const evento = (tipo, x) => new MouseEvent(tipo, { clientX: x, clientY: 0, button: 0, bubbles: true })

    it("arrastrar mueve el scroll lateral y el soltar no cuenta como clic", () => {
        document.body.innerHTML = `<div class="segFiltrosScroll"><button id="f">Filtro</button></div>`
        const scroller = document.querySelector(".segFiltrosScroll")
        const filtro = document.getElementById("f")
        scroller.scrollLeft = 100
        let clics = 0
        filtro.addEventListener("click", () => clics++)
        segArrastrarScroll(scroller)

        filtro.dispatchEvent(evento("pointerdown", 200))
        window.dispatchEvent(evento("pointermove", 150))
        expect(scroller.scrollLeft).toBe(150)
        expect(scroller.classList.contains("dragging")).toBe(true)

        window.dispatchEvent(evento("pointerup", 150))
        expect(scroller.classList.contains("dragging")).toBe(false)
        filtro.dispatchEvent(new MouseEvent("click", { bubbles: true }))
        expect(clics).toBe(0)

        // Un clic normal después sí llega.
        filtro.dispatchEvent(new MouseEvent("click", { bubbles: true }))
        expect(clics).toBe(1)
    })

    it("un movimiento pequeño no es un arrastre", () => {
        document.body.innerHTML = `<div class="segFiltrosScroll"><button id="f">Filtro</button></div>`
        const scroller = document.querySelector(".segFiltrosScroll")
        scroller.scrollLeft = 100
        segArrastrarScroll(scroller)

        scroller.dispatchEvent(evento("pointerdown", 200))
        window.dispatchEvent(evento("pointermove", 197))
        window.dispatchEvent(evento("pointerup", 197))

        expect(scroller.scrollLeft).toBe(100)
    })
})

describe("segMarcarFuentes", () => {
    beforeEach(() => {
        document.body.innerHTML = `<div id="seguimientoSourceFilters">
            <label class="activosFilterBtn" data-source="portfolio"><input type="checkbox"></label>
            <label class="activosFilterBtn" data-source="operaciones"><input type="checkbox"></label>
        </div>`
        _segFilterSrc = "operaciones"
    })

    const marcadas = () => [...document.querySelectorAll("input")].map((i) => i.checked)

    it("sin lista elegida marca la fuente activa", () => {
        segMarcarFuentes()
        expect(marcadas()).toEqual([false, true])
    })

    it("con una lista elegida no marca ninguna: lista y fuente se excluyen", () => {
        _segFilterLista = "a"
        segMarcarFuentes()
        expect(marcadas()).toEqual([false, false])
    })
})

describe("fuentes de la Watchlist", () => {
    it("Seguimiento y Nuevos ya no son pestañas", () => {
        expect(SEG_SOURCES).toEqual(["portfolio", "operaciones", "wallets"])
        expect(segParseSavedSource("nuevos")).toBe("portfolio")
        expect(segParseSavedSource("seguimiento")).toBe("portfolio")
    })
})
