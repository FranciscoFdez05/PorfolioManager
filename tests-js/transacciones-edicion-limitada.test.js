// Edición de Transacciones: lo importado de la blockchain solo admite la nota, y su
// comisión del exchange y su clasificación se cambian desde el detalle.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarScript } from "./cargar.js"

const IMPORTADA = { id: "wallet-abc", assetId: "btc", assetName: "Bitcoin", total: "1", walletTipo: "entre_wallet", nota: "Importado de Ledger" }
const MANUAL = { id: "transaccion-1", assetId: "btc", assetName: "Bitcoin", total: "1", walletTipo: "recibida", nota: "" }

const respuestaGet = (filasProtegidas) =>
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [IMPORTADA, MANUAL], filasProtegidas }) }))

const textosMenu = (fila) => [...window.buildTransaccionRow(fila).querySelectorAll(".rowMenuItem")].map((b) => b.textContent)

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cripto/transacciones.js")
})

beforeEach(() => {
    document.body.innerHTML = ""
})

describe("menú de una fila", () => {
    it("una importada protegida no se edita entera ni se elimina", async () => {
        vi.stubGlobal("fetch", respuestaGet([IMPORTADA.id]))
        await window.loadTransaccionesData()

        expect(textosMenu(IMPORTADA)).toEqual(["Comisión y clasificación", "Editar nota"])
    })

    it("una importada sin wallet enlazada de su red se puede eliminar", async () => {
        vi.stubGlobal("fetch", respuestaGet([]))
        await window.loadTransaccionesData()

        expect(textosMenu(IMPORTADA)).toEqual(["Comisión y clasificación", "Editar nota", "Eliminar"])
    })

    it("una escrita a mano se sigue editando y eliminando", async () => {
        vi.stubGlobal("fetch", respuestaGet([IMPORTADA.id]))
        await window.loadTransaccionesData()

        expect(textosMenu(MANUAL)).toEqual(["Editar", "Eliminar"])
    })
})

describe("ventana de edición", () => {
    const cargarFilas = async () => {
        vi.stubGlobal("fetch", respuestaGet([IMPORTADA.id]))
        window.__filas = await window.loadTransaccionesData()
        window.eval("currentTransaccionesData = window.__filas")
    }

    it("en una importada el único campo es la nota", async () => {
        await cargarFilas()

        window.openTransaccionRowModal(IMPORTADA.id)

        const campos = [...document.querySelectorAll("#transaccionRowModalOverlay input, #transaccionRowModalOverlay select")]
        expect(campos.map((campo) => campo.id)).toEqual(["txModalNota"])
        expect(campos[0].value).toBe(IMPORTADA.nota)
        expect(document.getElementById("txRowModalDeleteBtn")).toBeNull()
    })

    it("en una escrita a mano están todos los campos", async () => {
        await cargarFilas()

        window.openTransaccionRowModal(MANUAL.id)

        expect(document.getElementById("txModalTotal")).not.toBeNull()
        expect(document.getElementById("txRowModalDeleteBtn")).not.toBeNull()
    })

    it("sin una fila que editar no se abre: ya no se añaden a mano", async () => {
        await cargarFilas()

        window.openTransaccionRowModal("")

        expect(document.getElementById("transaccionRowModalOverlay")).toBeNull()
    })

    it("el botón del detalle dice qué se puede editar", async () => {
        await cargarFilas()

        expect(window.textoEditarFilaTransaccion(IMPORTADA.id)).toBe("Editar nota")
        expect(window.textoEditarFilaTransaccion(MANUAL.id)).toBe("Editar")
    })
})
