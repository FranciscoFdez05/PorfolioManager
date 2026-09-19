// Pruebas de la nota de un gasto o ingreso del mes (js/finanzas/gastos.js y
// js/finanzas/ingresos.js).
//
// La nota no tiene columna en la tabla: viaja escondida en la fila y solo se
// ve al pulsar el movimiento, en un detalle con la fecha, el concepto, el tipo
// y la cantidad. Lo que se comprueba aquí es justo lo que se rompería sin
// darse cuenta:
//
//   1. **Que no se pierda.** La tabla se vuelve a leer desde el DOM antes de
//      guardar; si la fila no llevara la nota, cada guardado la borraría.
//   2. **Que no se vea en la tabla.** Es lo que pide la pantalla: la nota es
//      un detalle, no una columna.
//   3. **Que la fila abra el detalle y el menú «···» no.** Los dos comparten el
//      mismo manejador de clics.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..")

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/gastos.js")
    cargarScript("js/finanzas/ingresos.js")
})

const FILA = { fecha: "11-08-2026", nombre: "Steam", tipo: "Compras", cantidad: "8,88 €", nota: "Oferta de verano" }

/** Las dos pantallas comparten forma; esto es lo que cambia entre una y otra. */
const PANTALLAS = {
    gastos: {
        html: "html/finanzas/gastos.html",
        pagina: "gastosPage",
        cuerpo: "gastosMovementsBody",
        construir: (row, i) => buildGastoMovementRow(row, i),
        manejador: (e) => handleGastosMovementActionClick(e),
        sincronizar: () => syncGastosDataFromTables(),
        datos: () => currentGastosData,
        preparar: () => {
            currentGastosData = { months: { agosto: { rows: [{ ...FILA }] } } }
            currentGastosMonth = "agosto"
            currentGastosView = "month"
            _gastosDataLoaded = true
            sharedGastosTypes = ["Compras"]
        },
        detalle: "gastosDetailModalOverlay",
        formulario: "gastosCreateModalOverlay",
        campoNota: "gastosMovimientoNota",
        titulo: "Detalle del gasto"
    },
    ingresos: {
        html: "html/finanzas/ingresos.html",
        pagina: "ingresosPage",
        cuerpo: "ingresosMovementsBody",
        construir: (row, i) => buildIngresoMovementRow(row, i),
        manejador: (e) => handleIngresosMovementActionClick(e),
        sincronizar: () => syncIngresosDataFromTables(),
        datos: () => currentIngresosData,
        preparar: () => {
            currentIngresosData = { months: { agosto: { rows: [{ ...FILA }] } } }
            currentIngresosMonth = "agosto"
            currentIngresosView = "month"
            _ingresosDataLoaded = true
            sharedIngresosTypes = ["Compras"]
        },
        detalle: "ingresosDetailModalOverlay",
        formulario: "ingresosCreateModalOverlay",
        campoNota: "ingresosMovimientoNota",
        titulo: "Detalle del ingreso"
    }
}

describe.each(Object.entries(PANTALLAS))("nota de un movimiento en %s", (nombre, pantalla) => {
    let cuerpo

    beforeEach(() => {
        document.body.innerHTML = `
            <section class="${pantalla.pagina}">
                <table><tbody id="${pantalla.cuerpo}"></tbody></table>
            </section>
        `
        pantalla.preparar()
        cuerpo = document.getElementById(pantalla.cuerpo)
        cuerpo.addEventListener("click", pantalla.manejador)
        cuerpo.appendChild(pantalla.construir(FILA, 0))
    })

    afterEach(() => {
        document.getElementById(pantalla.detalle)?.remove()
        document.getElementById(pantalla.formulario)?.remove()
    })

    it("la cabecera de la tabla dice Concepto, no Nombre", () => {
        const html = readFileSync(resolve(RAIZ, pantalla.html), "utf-8")
        expect(html).toMatch(/data-sortkey="1">Concepto</)
        expect(html).not.toMatch(/data-sortkey="1">Nombre</)
    })

    it("la fila lleva la nota pero no la enseña", () => {
        const fila = cuerpo.querySelector("tr")
        expect(fila.dataset.nota).toBe("Oferta de verano")
        expect(fila.textContent).not.toContain("Oferta de verano")
    })

    it("releer la tabla antes de guardar conserva la nota", () => {
        pantalla.sincronizar()
        expect(pantalla.datos().months.agosto.rows[0].nota).toBe("Oferta de verano")
    })

    it("pulsar la fila abre el detalle con todos los datos y la nota", () => {
        cuerpo.querySelector('[data-field="nombre"]').dispatchEvent(new MouseEvent("click", { bubbles: true }))

        const detalle = document.getElementById(pantalla.detalle)
        expect(detalle).not.toBeNull()
        expect(detalle.textContent).toContain(pantalla.titulo)
        for (const dato of ["11-08-2026", "Steam", "Compras", "8,88 €", "Oferta de verano"]) {
            expect(detalle.textContent).toContain(dato)
        }
    })

    it("un movimiento sin nota lo dice en vez de dejar el hueco", () => {
        cuerpo.innerHTML = ""
        cuerpo.appendChild(pantalla.construir({ ...FILA, nota: "" }, 0))
        cuerpo.querySelector('[data-field="fecha"]').dispatchEvent(new MouseEvent("click", { bubbles: true }))

        expect(document.getElementById(pantalla.detalle).textContent).toContain("Sin nota")
    })

    it("pulsar el menú «···» de la fila no abre el detalle", () => {
        cuerpo.querySelector(".rowMenuTrigger").dispatchEvent(new MouseEvent("click", { bubbles: true }))
        expect(document.getElementById(pantalla.detalle)).toBeNull()
    })

    it("Editar desde el detalle abre el formulario con la nota rellena", () => {
        cuerpo.querySelector('[data-field="tipo"]').dispatchEvent(new MouseEvent("click", { bubbles: true }))
        document.querySelector(`#${pantalla.detalle} .primaryButton`).click()

        expect(document.getElementById(pantalla.detalle)).toBeNull()
        const campo = document.getElementById(pantalla.campoNota)
        expect(campo?.tagName).toBe("TEXTAREA")
        expect(campo.value).toBe("Oferta de verano")
    })

    it("el detalle se cierra con Escape", () => {
        cuerpo.querySelector('[data-field="cantidad"]').dispatchEvent(new MouseEvent("click", { bubbles: true }))
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
        expect(document.getElementById(pantalla.detalle)).toBeNull()
    })
})
