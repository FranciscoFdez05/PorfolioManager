// Pruebas del índice de cada fila en la tabla del mes de gastos e ingresos
// (js/finanzas/gastos.js y js/finanzas/ingresos.js).
//
// La tabla se pinta ordenada por fecha, pero Editar y Eliminar buscan la fila
// por su índice en los datos tal como están guardados, que pueden no estar
// ordenados. Si la fila llevara el índice del orden pintado, el «···» de una
// fila abriría o borraría otra.
import { beforeAll, beforeEach, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/gastos.js")
    cargarScript("js/finanzas/ingresos.js")
})

// Guardadas fuera de orden a propósito: el orden pintado es Cobuco, Vaxto, Steam.
const FILAS = [
    { fecha: "26-04-2026", nombre: "Steam", tipo: "Compras", cantidad: "31,25 €" },
    { fecha: "07-04-2026", nombre: "Vaxto", tipo: "Compras", cantidad: "22,55 €" },
    { fecha: "02-04-2026", nombre: "Cobuco", tipo: "Compras", cantidad: "40,00 €" }
]

const PANTALLAS = {
    gastos: {
        cuerpo: "gastosMovementsBody",
        pintar: () => renderGastosMonthTable(),
        manejador: (e) => handleGastosMovementActionClick(e),
        datos: () => currentGastosData,
        preparar: () => {
            currentGastosData = { months: { abril: { rows: FILAS.map((fila) => ({ ...fila })) } } }
            currentGastosMonth = "abril"
            currentGastosView = "month"
            _gastosDataLoaded = true
            sharedGastosTypes = ["Compras"]
        },
        editarBtn: ".gastosRowEditBtn",
        campoNombre: "gastosMovimientoNombre",
        formulario: "gastosCreateModalOverlay"
    },
    ingresos: {
        cuerpo: "ingresosMovementsBody",
        pintar: () => renderIngresosMonthTable(),
        manejador: (e) => handleIngresosMovementActionClick(e),
        datos: () => currentIngresosData,
        preparar: () => {
            currentIngresosData = { months: { abril: { rows: FILAS.map((fila) => ({ ...fila })) } } }
            currentIngresosMonth = "abril"
            currentIngresosView = "month"
            _ingresosDataLoaded = true
            sharedIngresosTypes = ["Compras"]
        },
        editarBtn: ".ingresosRowEditBtn",
        campoNombre: "ingresosMovimientoNombre",
        formulario: "ingresosCreateModalOverlay"
    }
}

describe.each(Object.entries(PANTALLAS))("índice de las filas del mes en %s", (nombre, pantalla) => {
    let cuerpo

    beforeEach(() => {
        document.body.innerHTML = `<table><tbody id="${pantalla.cuerpo}"></tbody></table>`
        pantalla.preparar()
        cuerpo = document.getElementById(pantalla.cuerpo)
        cuerpo.addEventListener("click", pantalla.manejador)
        pantalla.pintar()
    })

    it("pinta las filas ordenadas por fecha", () => {
        const nombres = [...cuerpo.querySelectorAll("tr.movDetailRow")].map((tr) => tr.dataset.nombre)
        expect(nombres).toEqual(["Cobuco", "Vaxto", "Steam"])
    })

    it("cada fila apunta a su propio movimiento en los datos guardados", () => {
        const filasDatos = pantalla.datos().months.abril.rows
        for (const tr of cuerpo.querySelectorAll("tr.movDetailRow")) {
            expect(filasDatos[Number(tr.dataset.rowIndex)].nombre).toBe(tr.dataset.nombre)
        }
    })

    it("Editar en el «···» de una fila abre el formulario de esa fila", () => {
        for (const tr of cuerpo.querySelectorAll("tr.movDetailRow")) {
            tr.querySelector(pantalla.editarBtn).click()
            expect(document.getElementById(pantalla.campoNombre).value).toBe(tr.dataset.nombre)
            document.getElementById(pantalla.formulario)?.remove()
        }
    })
})
