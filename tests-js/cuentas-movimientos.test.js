// Ventana Mi dinero › Movimientos (js/finanzas/cuentas-movimientos.js): filtros
// por año y cuenta, orden de la tabla y resumen por cuenta del lateral.
//
// Lo delicado es el resumen: la comisión la paga solo el origen y va aparte de
// la salida, y una cuenta tiene que contar tanto si envía como si recibe.
import { beforeAll, beforeEach, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/gastos.js")
    cargarScript("js/finanzas/dividendos.js")
    cargarScript("js/finanzas/cuentas.js")
    cargarScript("js/finanzas/cuentas-movimientos.js")
})

const TRANSFERENCIAS = [
    { id: 1, fecha: "05-01-2025", year: "2025", origen: "banco", destino: "tr", origen_nombre: "Santander", destino_nombre: "Trade Republic", cantidad: "100.00", comision: "0.00", concepto: "Aportación" },
    { id: 2, fecha: "10-03-2026", year: "2026", origen: "banco", destino: "revolut", origen_nombre: "Santander", destino_nombre: "Revolut", cantidad: "50.00", comision: "1.50", concepto: "" },
    { id: 3, fecha: "9-03-2026", year: "2026", origen: "revolut", destino: "tr", origen_nombre: "Revolut", destino_nombre: "Trade Republic", cantidad: "1000.00", comision: "0.99", concepto: "Broker" },
    { id: 4, fecha: "10-03-2026", year: "2026", origen: "tr", destino: "banco", origen_nombre: "Trade Republic", destino_nombre: "Santander", cantidad: "20.00", comision: "0.00", concepto: "Retirada" }
]

const ids = (lista) => lista.map((t) => t.id)

describe("mvcAniosDisponibles", () => {
    it("incluye el año actual aunque no tenga transferencias y ordena de menor a mayor", () => {
        expect(mvcAniosDisponibles(TRANSFERENCIAS, new Date(2027, 0, 1))).toEqual(["2025", "2026", "2027"])
    })

    it("sin transferencias queda solo el año actual", () => {
        expect(mvcAniosDisponibles([], new Date(2026, 10, 9))).toEqual(["2026"])
    })
})

describe("mvcFiltrar", () => {
    it("sin filtro devuelve todas", () => {
        expect(ids(mvcFiltrar(TRANSFERENCIAS))).toEqual([1, 2, 3, 4])
    })

    it("filtra por año", () => {
        expect(ids(mvcFiltrar(TRANSFERENCIAS, { year: "2025" }))).toEqual([1])
    })

    it("una cuenta casa como origen y como destino", () => {
        expect(ids(mvcFiltrar(TRANSFERENCIAS, { cuenta: "revolut" }))).toEqual([2, 3])
    })

    it("combina año y cuenta", () => {
        expect(ids(mvcFiltrar(TRANSFERENCIAS, { year: "2026", cuenta: "tr" }))).toEqual([3, 4])
    })
})

describe("mvcOrdenar", () => {
    it("por fecha descendente compara fechas, no texto, y desempata por la última apuntada", () => {
        expect(ids(mvcOrdenar(TRANSFERENCIAS, { key: "fecha", dir: "desc" }))).toEqual([4, 2, 3, 1])
    })

    it("por cantidad compara importes como números", () => {
        expect(ids(mvcOrdenar(TRANSFERENCIAS, { key: "cantidad", dir: "asc" }))).toEqual([4, 2, 1, 3])
    })

    it("por texto ordena alfabéticamente y, a igualdad, la más reciente primero", () => {
        expect(ids(mvcOrdenar(TRANSFERENCIAS, { key: "origen", dir: "asc" }))).toEqual([3, 2, 1, 4])
    })

    it("por texto ignora mayúsculas y acentos", () => {
        const lista = [
            { id: 1, fecha: "01-01-2026", concepto: "Ñu" },
            { id: 2, fecha: "01-01-2026", concepto: "ábaco" },
            { id: 3, fecha: "01-01-2026", concepto: "Banco" }
        ]
        expect(ids(mvcOrdenar(lista, { key: "concepto", dir: "asc" }))).toEqual([2, 3, 1])
    })

    it("no muta la lista recibida", () => {
        const copia = [...TRANSFERENCIAS]
        mvcOrdenar(TRANSFERENCIAS, { key: "cantidad", dir: "desc" })
        expect(TRANSFERENCIAS).toEqual(copia)
    })
})

describe("mvcResumenCuenta", () => {
    it("suma entradas y salidas, y la comisión solo cuando la cuenta es el origen", () => {
        expect(mvcResumenCuenta(TRANSFERENCIAS, "revolut")).toEqual({ entradas: 50, salidas: 1000, comisiones: 0.99, numero: 2 })
        expect(mvcResumenCuenta(TRANSFERENCIAS, "tr")).toEqual({ entradas: 1100, salidas: 20, comisiones: 0, numero: 3 })
    })

    it("una cuenta sin transferencias queda a cero", () => {
        expect(mvcResumenCuenta(TRANSFERENCIAS, "metalico")).toEqual({ entradas: 0, salidas: 0, comisiones: 0, numero: 0 })
    })
})

describe("mvcTotalComisiones", () => {
    it("suma las comisiones del periodo", () => {
        expect(mvcTotalComisiones(mvcFiltrar(TRANSFERENCIAS, { year: "2026" }))).toBeCloseTo(2.49)
        expect(mvcTotalComisiones([])).toBe(0)
    })
})

describe("pintado de la tabla y el lateral", () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="mvcYearList"></div><div id="mvcCuentaList"></div>
            <div class="mvcTableWrapper"><table><thead id="mvcHead"></thead><tbody id="mvcBody"></tbody></table><p id="mvcEmpty"></p></div>
            <div id="mvcTotal"></div><div id="mvcComisiones"></div><div id="mvcCuentas"></div>`
        mvcCuentas = [
            { id: "banco", nombre: "Santander", tipo: "banco", saldo: "200.00" },
            { id: "revolut", nombre: "Revolut", tipo: "banco", saldo: "100.00" },
            { id: "tr", nombre: "Trade Republic", tipo: "broker", saldo: "0.00" }
        ]
        mvcTransferencias = TRANSFERENCIAS
        mvcYear = "2026"
        mvcCuenta = ""
    })

    it("pinta solo las filas del año y el aviso de vacío oculto", () => {
        mvcRenderTabla()
        expect([...document.querySelectorAll("#mvcBody tr")].map((tr) => tr.dataset.id)).toEqual(["4", "2", "3"])
        expect(document.getElementById("mvcEmpty").classList.contains("hidden")).toBe(true)
    })

    it("sin filas enseña el aviso del filtro activo", () => {
        mvcYear = "2024"
        mvcRenderTabla()
        expect(document.getElementById("mvcBody").children).toHaveLength(0)
        expect(document.getElementById("mvcEmpty").textContent).toBe("No hay transferencias en 2024.")
    })

    it("el lateral marca la cuenta filtrada y las comisiones son las del filtro", () => {
        mvcCuenta = "revolut"
        mvcRenderLateral()
        const activas = [...document.querySelectorAll(".mvcCuenta.activa")].map((el) => el.dataset.mvcCuenta)
        expect(activas).toEqual(["revolut"])
        expect(document.querySelectorAll(".mvcCuenta")).toHaveLength(3)
        expect(parseEuroNumber(document.getElementById("mvcComisiones").textContent)).toBeCloseTo(2.49)
    })

    it("escapa los nombres de las cuentas", () => {
        mvcCuentas = [{ id: "x", nombre: "<img src=x onerror=alert(1)>", tipo: "banco", saldo: "0" }]
        mvcRenderLateral()
        expect(document.querySelector("#mvcCuentas img")).toBeNull()
    })
})
