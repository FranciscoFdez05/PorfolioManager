// Pruebas de js/core/fusion-anual.js.
//
// Es lo que hace la pestaña de Gastos o Ingresos cuando el servidor rechaza su
// guardado con un 409 (el año cambió desde que lo cargó). Un fallo aquí no se ve
// en pantalla: se ve en un gasto que desaparece o que aparece dos veces.
import { beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/fusion-anual.js")
})

const fila = (nombre, cantidad = "10,00 €", extra = {}) => ({
    fecha: "01-10-2026",
    nombre,
    tipo: "Comida",
    cantidad,
    nota: "",
    cuenta: "",
    ...extra
})

const anio = (filas, extra = {}) => ({
    year: "2026",
    gastosTipos: ["Comida"],
    mensualidades: [],
    months: { octubre: { rows: filas } },
    ...extra
})

describe("fusionarAnioTresVias", () => {
    it("conserva lo que entró por el Atajo y lo que editó la pestaña", () => {
        const base = anio([fila("Pan")])
        const local = anio([fila("Pan"), fila("Cena", "30,00 €")]) // la pestaña añade una
        const servidor = anio([fila("Pan"), fila("Café", "1,50 €")], { revision: 3 }) // el Atajo añadió otra

        const fusion = window.fusionarAnioTresVias(base, local, servidor, "mensualidades", "gastosTipos")

        expect(fusion.months.octubre.rows.map((f) => f.nombre).sort()).toEqual(["Café", "Cena", "Pan"])
        expect(fusion.revision).toBe(3)
    })

    it("aplica sobre el servidor lo que la pestaña quitó o editó", () => {
        const base = anio([fila("Pan"), fila("Error")])
        const local = anio([fila("Pan", "12,00 €")]) // borra «Error» y corrige el importe de «Pan»
        const servidor = anio([fila("Pan"), fila("Error"), fila("Café")])

        const fusion = window.fusionarAnioTresVias(base, local, servidor, "mensualidades", "gastosTipos")
        const filas = fusion.months.octubre.rows

        expect(filas.map((f) => f.nombre).sort()).toEqual(["Café", "Pan"])
        expect(filas.find((f) => f.nombre === "Pan").cantidad).toBe("12,00 €")
    })

    it("no deshace un renombrado de categoría hecho en el servidor", () => {
        const base = anio([fila("Pan")])
        const local = anio([fila("Pan")]) // la pestaña no tocó esa fila
        const servidor = anio([fila("Pan", "10,00 €", { tipo: "Alimentación" })])

        const fusion = window.fusionarAnioTresVias(base, local, servidor, "mensualidades", "gastosTipos")

        expect(fusion.months.octubre.rows).toEqual([fila("Pan", "10,00 €", { tipo: "Alimentación" })])
    })

    it("cuenta las filas repetidas: dos cafés iguales son dos gastos", () => {
        const base = anio([fila("Café")])
        const local = anio([fila("Café"), fila("Café")])
        const servidor = anio([fila("Café")])

        const fusion = window.fusionarAnioTresVias(base, local, servidor, "mensualidades", "gastosTipos")

        expect(fusion.months.octubre.rows).toHaveLength(2)
    })

    it("compara el importe por su valor, no por cómo está escrito", () => {
        // La tabla devuelve «10,00 €» y el servidor puede tener «10,0 €»: es la misma fila.
        const base = anio([fila("Pan", "10,0 €")])
        const local = anio([fila("Pan", "10,00 €")])
        const servidor = anio([fila("Pan", "10,0 €")])

        const fusion = window.fusionarAnioTresVias(base, local, servidor, "mensualidades", "gastosTipos")

        expect(fusion.months.octubre.rows).toHaveLength(1)
    })
})
