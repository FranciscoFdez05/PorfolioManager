// Pestaña "Todos" de la ficha del activo.
//
// Las dos procedencias que junta —compras spot y operaciones spot completadas—
// salen de sitios distintos del código. Lo que se comprueba aquí es esa costura,
// que es donde una fila se queda fuera sin que nada falle.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { cargarScript } from "./cargar.js"

const COMPRA = {
    fechaOperacion: "10-02-2026",
    tipoOperacion: "Compra",
    exchange: "Binance",
    participaciones: "0,005",
    precioParticipacion: "60000",
    currency: "EUR",
    capitalInvertidoBruto: "300",
    comisionesCripto: "0,00001",
    comisionesFiat: "1,50"
}

const OPERACION = {
    id: "op-1",
    assetId: "bitcoin",
    fechaApertura: "12-02-2026",
    par: "BTC/EUR",
    orden: "Compra",
    precioOrden: "61000",
    cantidad: "0,002",
    comisionesCripto: "0,000005",
    comisionesFiat: "0,80",
    total: "122",
    estado: "Completado",
    fechaCierre: "12-02-2026"
}

const ACTIVO = {
    id: "bitcoin",
    name: "Bitcoin",
    symbol: "BTC",
    type: "cripto",
    price: "66000",
    currency: "EUR",
    marketProvider: "yahoo",
    marketSymbol: "BTC-USD",
    tvSymbol: "",
    rows: [COMPRA],
    operationRows: [OPERACION]
}

function fetchFalso() {
    return vi.fn((url, opciones) => {
        if (opciones?.method === "POST") {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
        }
        if (String(url).startsWith("/api/planes")) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [] }) })
        }
        return Promise.resolve({ ok: false, json: () => Promise.resolve({ ok: false }) })
    })
}

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cartera/assets.js")
    cargarScript("js/cripto/operaciones.js")
    cargarScript("js/cartera/planes.js")
})

/** Monta la ficha del activo y espera a que lleguen los planes. */
async function montar(activo = ACTIVO) {
    document.body.innerHTML = '<div id="dynamicContent"></div>'
    localStorage.clear()
    globalThis.fetch = fetchFalso()
    _planesCargados = false
    _planesRows = []

    renderAssetTablePage({ ...activo })
    await initAssetPlanesLogic({ ...activo })
}

function origenesPintados() {
    return [...document.querySelectorAll("#assetTodosSection tbody tr")].map((fila) =>
        fila.querySelector(".todosOrigenBadge").textContent.trim()
    )
}

beforeEach(async () => {
    await montar()
})

describe("orden de las pestañas", () => {
    it("Todos va la primera, a la izquierda de Compras spot", () => {
        const pestanas = [...document.querySelectorAll(".assetTabsNav .assetTabBtn")].map((b) => b.dataset.tab)

        expect(pestanas[0]).toBe("todos")
        expect(pestanas[1]).toBe("spot")
    })

    // Abrir en Todos sería abrir en una pestaña que a veces no está.
    it("la ficha sigue abriendo en Compras spot", () => {
        expect(document.querySelector(".assetTabBtn.assetTabActive").dataset.tab).toBe("spot")
        expect(document.querySelector('.assetTabPanel[data-tab="todos"]').classList.contains("hidden")).toBe(true)
    })
})

describe("compras spot", () => {
    it("ya no lleva columna de exchange", () => {
        const cabeceras = [...document.querySelectorAll('.assetTabPanel[data-tab="spot"] thead th')].map((th) =>
            th.textContent.trim()
        )

        expect(cabeceras).not.toContain("Exchange")
        expect(cabeceras).toContain("Moneda fiat")
    })
})

describe("pestaña Todos", () => {
    it("junta los dos orígenes y los ordena de más reciente a más antiguo", () => {
        expect(origenesPintados()).toEqual(["Operación spot", "Compra spot"])
    })

    it("cuenta las filas en el rótulo de la pestaña", () => {
        expect(document.getElementById("todosTabBtn").textContent).toBe("Todos (2)")
        expect(document.getElementById("todosTabBtn").classList.contains("hidden")).toBe(false)
    })

    it("se esconde cuando el activo solo tiene compras spot", async () => {
        await montar({ ...ACTIVO, operationRows: [] })

        expect(document.getElementById("todosTabBtn").classList.contains("hidden")).toBe(true)
        expect(document.getElementById("assetTodosSection").innerHTML).toBe("")
    })
})
