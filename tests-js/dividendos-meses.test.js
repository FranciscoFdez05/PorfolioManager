// La separación por meses de la pantalla de Dividendos (js/finanzas/dividendos.js).
//
// El mes de cada dividendo no está guardado en ningún sitio: se deduce de la
// fecha de cobro cada vez que se pinta la tabla. Eso es lo que permite que las
// filas que ya estaban en producción se coloquen en su mes sin migrar el
// fichero de datos, y es también lo que hace que un fallo aquí no dé un error:
// da una tabla creíble con las filas en el mes equivocado, o un mes que parece
// vacío porque su fecha no se supo leer.
//
// Lo que cubre este fichero:
//
//   1. **Leer la fecha.** dd-mm-aaaa es lo que escribe el modal, pero el campo
//      es texto libre y en el fichero puede haber mm-aaaa o ISO.
//   2. **Agrupar.** La vista del año abre un bloque por mes, en orden y con las
//      filas ordenadas por día dentro de cada uno.
//   3. **Filtrar.** Abrir un mes deja solo sus filas, y el índice que llevan
//      los botones de editar y eliminar sigue apuntando a la fila real.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarScript } from "./cargar.js"

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..")

beforeAll(() => {
    // El orden es el de index.html: dividendos.js usa escapeHtml,
    // formatShareQuantity, formatCellMoneyValue y formatMoney de shared-utils.
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/dividendos.js")
})

beforeEach(() => {
    // Los totales piden el cambio de divisa al backend; aquí no hay backend.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, rate: 1 }) })))
    document.body.innerHTML = readFileSync(resolve(RAIZ, "html/finanzas/dividendos.html"), "utf-8")
    _allDividendosRows = []
    currentDividendosYear = "2026"
    currentDividendosMonth = null
})

function dividendo(fecha, instrumento, total = "1,00 €") {
    return { fecha, instrumento, acciones: "1", dividendoAccion: "1,00 $", impuestos: "0,10 €", total }
}

const textos = (selector) => [...document.querySelectorAll(selector)].map((n) => n.textContent.trim())

/** Instrumento de cada fila de datos, en el orden en que se ven. */
const instrumentosVisibles = () =>
    [...document.querySelectorAll("#dividendosBody tr:not(.tableGroupRow)")].map((tr) =>
        tr.querySelector('[data-field="instrumento"]').textContent.trim()
    )

describe("el mes sale de la fecha de cobro", () => {
    it("lee el formato que escribe el modal (dd-mm-aaaa)", () => {
        expect(parseDividendoMonth("12-02-2026")).toBe("02")
        expect(parseDividendoYear("12-02-2026")).toBe("2026")
    })

    it("lee una fecha sin día (mm-aaaa)", () => {
        expect(parseDividendoMonth("07-2026")).toBe("07")
        expect(parseDividendoYear("07-2026")).toBe("2026")
    })

    it("lee una fecha en ISO sin confundir el año con el día", () => {
        expect(parseDividendoMonth("2026-03-11")).toBe("03")
        expect(parseDividendoYear("2026-03-11")).toBe("2026")
    })

    it("no inventa un mes cuando la fecha no se puede leer", () => {
        expect(parseDividendoMonth("")).toBeNull()
        expect(parseDividendoMonth("pendiente")).toBeNull()
        expect(parseDividendoMonth("00-2026")).toBeNull()
        expect(parseDividendoMonth("15-13-2026")).toBeNull()
    })
})

describe("vista del año", () => {
    it("abre un bloque por mes, en orden y con el número de cobros", () => {
        _allDividendosRows = [
            dividendo("11-03-2026", "Chevron"),
            dividendo("12-02-2026", "Apple"),
            dividendo("12-03-2026", "Microsoft")
        ]

        renderFilteredDividendos()

        expect(textos(".dividendosGroupName")).toEqual(["Febrero", "Marzo"])
        expect(textos(".dividendosGroupMeta")).toEqual(["1 cobro", "2 cobros"])
    })

    it("ordena las filas por día dentro de su mes", () => {
        _allDividendosRows = [
            dividendo("17-03-2026", "McDonald's"),
            dividendo("01-04-2026", "NVIDIA"),
            dividendo("11-03-2026", "Chevron")
        ]

        renderFilteredDividendos()

        expect(instrumentosVisibles()).toEqual(["Chevron", "McDonald's", "NVIDIA"])
    })

    it("deja las filas sin fecha legible en su propio bloque, al final", () => {
        // Antes se perdían de vista: sin año que las filtrara no aparecían por
        // ningún lado. Ahora tienen bloque propio mientras se corrige la fecha.
        _allDividendosRows = [dividendo("", "Sin apuntar"), dividendo("12-02-2026", "Apple")]
        currentDividendosYear = null

        renderFilteredDividendos()

        expect(textos(".dividendosGroupName")).toEqual(["Febrero", "Sin fecha"])
        expect(instrumentosVisibles()).toEqual(["Apple", "Sin apuntar"])
    })

    it("solo cuenta las filas del año que se está viendo", () => {
        _allDividendosRows = [dividendo("12-02-2025", "Apple"), dividendo("12-02-2026", "Apple")]

        renderFilteredDividendos()

        expect(textos(".dividendosGroupMeta")).toEqual(["1 cobro"])
    })
})

describe("un mes abierto", () => {
    beforeEach(() => {
        _allDividendosRows = [
            dividendo("12-02-2026", "Apple"),
            dividendo("11-03-2026", "Chevron"),
            dividendo("12-03-2026", "Microsoft")
        ]
    })

    it("deja solo las filas de ese mes y quita los separadores", () => {
        currentDividendosMonth = "03"
        renderFilteredDividendos()

        expect(instrumentosVisibles()).toEqual(["Chevron", "Microsoft"])
        expect(document.querySelectorAll(".tableGroupRow")).toHaveLength(0)
        expect(document.getElementById("dividendosMonthHeader").textContent).toContain("Marzo 2026")
    })

    it("editar y eliminar siguen apuntando a la fila real", () => {
        currentDividendosMonth = "03"
        renderFilteredDividendos()

        // Microsoft es la tercera fila del fichero aunque sea la segunda que se
        // ve: el índice que llevan los botones es el de _allDividendosRows.
        const microsoft = [...document.querySelectorAll("#dividendosBody tr")][1]
        expect(microsoft.querySelector(".dividendosRowEditBtn").dataset.globalIndex).toBe("2")
        expect(_allDividendosRows[2].instrumento).toBe("Microsoft")
    })

    it("avisa cuando el mes no tiene cobros, sin esconder dónde estás", () => {
        currentDividendosMonth = "08"
        renderFilteredDividendos()

        expect(document.getElementById("dividendosEmptyMsg").classList.contains("hidden")).toBe(false)
        expect(document.getElementById("dividendosEmptyMsg").textContent).toBe("No hay dividendos en agosto de 2026.")
        expect(document.getElementById("dividendosMonthHeader").classList.contains("hidden")).toBe(false)
    })
})

describe("pestañas de mes", () => {
    beforeEach(() => {
        _allDividendosRows = [dividendo("12-02-2026", "Apple"), dividendo("11-03-2026", "Chevron")]
    })

    it("apaga los meses sin cobros en el año que se está viendo", () => {
        renderFilteredDividendos()

        const apagados = [...document.querySelectorAll(".dividendosMonthTabEmpty")].map((b) => b.textContent)
        expect(apagados).not.toContain("Febrero")
        expect(apagados).not.toContain("Marzo")
        expect(apagados).toHaveLength(10)
    })

    it("pulsar el mes abierto vuelve a la vista del año", () => {
        renderFilteredDividendos()
        const marzo = [...document.querySelectorAll(".dividendosMonthTab")][2]

        marzo.click()
        expect(currentDividendosMonth).toBe("03")

        document.querySelectorAll(".dividendosMonthTab")[2].click()
        expect(currentDividendosMonth).toBeNull()
        expect(textos(".dividendosGroupName")).toEqual(["Febrero", "Marzo"])
    })
})
