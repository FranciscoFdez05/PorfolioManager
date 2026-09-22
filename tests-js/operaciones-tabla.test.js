// Tabla de Operaciones: estado editable y grupos de año plegables.
//
// Dos cosas que se manejan desde la propia tabla y no tienen red detrás: el
// selector de la columna Estado, que cambia y guarda la operación sin abrir el
// modal de editar (y que sigue respetando el aviso de saldo de la stablecoin,
// que antes solo vivía en el modal), y las cabeceras «Completadas <año>», que
// pliegan sus filas y recuerdan cómo se dejaron.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { cargarScript } from "./cargar.js"

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const ACTIVOS = [
    { id: "ethereum", name: "Ethereum", symbol: "ETH", type: "cripto", price: "2400", currency: "EUR" },
    { id: "bitcoin", name: "Bitcoin", symbol: "BTC", type: "cripto", price: "75000", currency: "EUR" }
]

const OPERACIONES = [
    {
        id: "op-eth-1",
        assetId: "ethereum",
        activo: "Ethereum",
        fechaApertura: "12-05-2025",
        par: "ETH/USDT",
        orden: "Compra",
        precioOrden: "2610",
        cantidad: "0,4",
        comisionesFiat: "2,10",
        total: "1044",
        estado: "Activo",
        fechaCierre: "20-05-2025"
    },
    {
        id: "op-btc-1",
        assetId: "bitcoin",
        activo: "Bitcoin",
        fechaApertura: "20-01-2025",
        par: "BTC/EUR",
        orden: "Compra",
        precioOrden: "95400",
        cantidad: "0,05",
        comisionesFiat: "8",
        total: "4770",
        estado: "Completado",
        fechaCierre: "25-01-2025"
    },
    {
        id: "op-btc-2",
        assetId: "bitcoin",
        activo: "Bitcoin",
        fechaApertura: "11-11-2024",
        par: "BTC/EUR",
        orden: "Compra",
        precioOrden: "68000",
        cantidad: "0,02",
        comisionesFiat: "3,20",
        total: "1360",
        estado: "Completado",
        fechaCierre: "11-11-2024"
    }
]

let guardados = []
let stablecoins = { catalog: [], enabledSymbols: [], rows: [] }
let avisos = []

function respuesta(cuerpo) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve(cuerpo) })
}

function montarPagina() {
    const html = readFileSync(resolve(RAIZ, "html/cripto/operaciones.html"), "utf-8")
    document.body.innerHTML = `<div id="dynamicContent">${html}</div>`
}

function selectorEstado(rowId) {
    return document.querySelector(`tr[data-operation-id="${rowId}"] .operationsEstadoSelect`)
}

function cambiarEstado(rowId, estado) {
    const select = selectorEstado(rowId)
    select.value = estado
    select.dispatchEvent(new Event("change", { bubbles: true }))
}

function cabeceraAnio(anio) {
    return document.querySelector(`tr.operationsYearRow[data-year="${anio}"]`)
}

// Las filas de un año son las que van tras su cabecera hasta la siguiente.
function filasDelAnio(anio) {
    const filas = []
    let fila = cabeceraAnio(anio)?.nextElementSibling

    while (fila && !fila.classList.contains("tableGroupRow")) {
        filas.push(fila.dataset.operationId)
        fila = fila.nextElementSibling
    }

    return filas
}

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cripto/operaciones.js")
})

beforeEach(async () => {
    guardados = []
    avisos = []
    stablecoins = { catalog: [], enabledSymbols: [], rows: [] }
    localStorage.clear()
    globalThis.fetch = vi.fn((url, opciones) => {
        const ruta = String(url)
        if (opciones?.method === "POST") {
            guardados.push(JSON.parse(opciones.body))
            return respuesta({ ok: true })
        }
        if (ruta.startsWith("/api/operaciones")) return respuesta({ rows: OPERACIONES.map((op) => ({ ...op })) })
        if (ruta.startsWith("/api/activos")) return respuesta({ assets: ACTIVOS })
        return Promise.resolve({ ok: false, json: () => Promise.resolve({ ok: false }) })
    })
    // Las stablecoins y las transacciones las cargan otros módulos que aquí no
    // se sirven; basta con devolver lo que la página espera de ellos.
    globalThis.loadStablecoinsData = () => Promise.resolve(stablecoins)
    globalThis.loadTransaccionesData = () => Promise.resolve({ rows: [] })
    globalThis.openConfirmModal = ({ title, message }) => avisos.push({ title, message })
    montarPagina()
    await initOperacionesLogic()
})

describe("selector de estado en la tabla", () => {
    it("pinta los tres estados con el actual elegido", () => {
        const select = selectorEstado("op-eth-1")

        expect([...select.options].map((o) => o.value)).toEqual(["Activo", "Completado", "Cancelado"])
        expect(select.value).toBe("Activo")
        expect(select.className).toContain("is-activo")
    })

    it("al completar una operación la lleva a su grupo de año y la guarda", async () => {
        expect(filasDelAnio("2025")).toEqual(["op-btc-1"])

        cambiarEstado("op-eth-1", "Completado")

        expect(filasDelAnio("2025")).toContain("op-eth-1")
        expect(selectorEstado("op-eth-1").className).toContain("is-completado")

        await vi.waitFor(() => expect(guardados).toHaveLength(1))
        expect(guardados[0].rows.find((row) => row.id === "op-eth-1").estado).toBe("Completado")
    })

    it("al cancelar deja la fila cancelada sin preguntar y el menú pasa a Eliminar", async () => {
        cambiarEstado("op-eth-1", "Cancelado")

        expect(avisos).toHaveLength(0)
        expect(selectorEstado("op-eth-1").value).toBe("Cancelado")

        const fila = document.querySelector('tr[data-operation-id="op-eth-1"]')
        expect(fila.querySelector(".operacionRowDeleteBtn").textContent).toBe("Eliminar")

        await vi.waitFor(() => expect(guardados).toHaveLength(1))
        expect(guardados[0].rows.find((row) => row.id === "op-eth-1").estado).toBe("Cancelado")
    })

    it("no deja reactivar una compra sin saldo en la stablecoin", async () => {
        stablecoins = {
            catalog: [{ symbol: "USDT", marketSymbol: "USDT" }],
            enabledSymbols: ["USDT"],
            rows: [{ id: "st-1", stablecoinSymbol: "USDT", tipo: "Compra", cantidad: "100", total: "100" }]
        }
        montarPagina()
        await initOperacionesLogic()

        cambiarEstado("op-eth-1", "Completado")
        await vi.waitFor(() => expect(guardados).toHaveLength(1))

        cambiarEstado("op-eth-1", "Activo")

        expect(avisos).toHaveLength(1)
        expect(avisos[0].title).toBe("Saldo insuficiente")
        expect(avisos[0].message).toContain("USDT")
        expect(selectorEstado("op-eth-1").value).toBe("Completado")
        expect(currentOperationsData.rows.find((row) => row.id === "op-eth-1").estado).toBe("Completado")
    })
})

describe("grupos de año plegables", () => {
    it("pliega solo el año pulsado y deja el resto de la tabla como estaba", () => {
        expect(filasDelAnio("2025")).toEqual(["op-btc-1"])

        cabeceraAnio("2025").querySelector(".operationsYearToggle").click()

        expect(filasDelAnio("2025")).toEqual([])
        expect(cabeceraAnio("2025").classList.contains("operationsYearRowCollapsed")).toBe(true)
        expect(cabeceraAnio("2025").querySelector(".operationsYearToggle").getAttribute("aria-expanded")).toBe("false")
        // La cabecera sigue diciendo cuántas hay debajo y el otro año no se toca.
        expect(cabeceraAnio("2025").textContent).toContain("Completadas 2025 · 1 operación")
        expect(filasDelAnio("2024")).toEqual(["op-btc-2"])
        expect(document.querySelector('tr[data-operation-id="op-eth-1"]')).not.toBeNull()
    })

    it("vuelve a desplegarlo al pulsar otra vez", () => {
        cabeceraAnio("2024").querySelector(".operationsYearToggle").click()
        cabeceraAnio("2024").click()

        expect(filasDelAnio("2024")).toEqual(["op-btc-2"])
        expect(cabeceraAnio("2024").classList.contains("operationsYearRowCollapsed")).toBe(false)
    })

    it("recuerda los años plegados en la siguiente visita", async () => {
        cabeceraAnio("2024").click()
        expect(JSON.parse(localStorage.getItem("operationsCollapsedYears"))).toEqual(["2024"])

        montarPagina()
        await initOperacionesLogic()

        expect(filasDelAnio("2024")).toEqual([])
        expect(filasDelAnio("2025")).toEqual(["op-btc-1"])
    })
})
