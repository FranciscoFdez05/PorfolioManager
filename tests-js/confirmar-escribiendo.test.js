// Confirmar un borrado escribiendo el nombre.
//
// Lo que hay que asegurar no es el aspecto del diálogo, sino que no se pueda
// borrar sin que lo tecleado cuadre: el botón nace apagado, el clic se ignora
// aunque llegue por otra vía, y —lo que más duele si se rompe— el estado de un
// diálogo no puede sobrevivir al siguiente, ni dejando el campo a medias ni
// dejando el botón bloqueado en un diálogo que no pide nada.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarScript } from "./cargar.js"

function montarDom() {
    document.body.innerHTML = `
        <div class="modalOverlay hidden" id="confirmModalOverlay">
            <div class="assetModal">
                <h3 id="confirmModalTitle"></h3>
                <p id="confirmModalMessage"></p>
                <div class="confirmTypeBox hidden" id="confirmModalTypeBox">
                    <label for="confirmModalTypeInput">Escribe <b id="confirmModalTypeName"></b> para confirmar</label>
                    <input id="confirmModalTypeInput" type="text">
                </div>
                <div class="assetModalActions confirmModalActions">
                    <button id="confirmModalAcceptBtn" class="dangerButton"></button>
                    <button id="confirmModalCancelBtn" class="cancelButton"></button>
                </div>
            </div>
        </div>
        <div id="dynamicContent"></div>`

    initConfirmModal(
        document.getElementById("confirmModalOverlay"),
        document.getElementById("confirmModalAcceptBtn"),
        document.getElementById("confirmModalCancelBtn")
    )
}

const campo = () => document.getElementById("confirmModalTypeInput")
const aceptar = () => document.getElementById("confirmModalAcceptBtn")
const caja = () => document.getElementById("confirmModalTypeBox")

function teclear(texto) {
    campo().value = texto
    campo().dispatchEvent(new Event("input", { bubbles: true }))
}

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/app-core.js")
    cargarScript("js/cartera/assets.js")
})

beforeEach(() => {
    montarDom()
})

describe("sin requireText", () => {
    it("el diálogo se queda como siempre: sin campo y con el botón activo", () => {
        openConfirmModal({ title: "Eliminar fila", message: "¿Seguro?", onConfirm: () => {} })

        expect(caja().classList.contains("hidden")).toBe(true)
        expect(aceptar().disabled).toBe(false)
    })

    it("confirma al primer clic", async () => {
        const alConfirmar = vi.fn()
        openConfirmModal({ message: "¿Seguro?", onConfirm: alConfirmar })

        aceptar().click()
        await vi.waitFor(() => expect(alConfirmar).toHaveBeenCalledTimes(1))
    })
})

describe("con requireText", () => {
    beforeEach(() => {
        openConfirmModal({
            title: "Eliminar activo",
            message: "Vas a eliminar Bitcoin.",
            confirmLabel: "Eliminar",
            requireText: "Bitcoin",
            onConfirm: vi.fn()
        })
    })

    it("enseña el campo con el nombre que hay que escribir y apaga el botón", () => {
        expect(caja().classList.contains("hidden")).toBe(false)
        expect(document.getElementById("confirmModalTypeName").textContent).toBe("Bitcoin")
        expect(aceptar().disabled).toBe(true)
        expect(campo().value).toBe("")
    })

    it("enciende el botón cuando lo tecleado cuadra y lo vuelve a apagar si deja de cuadrar", () => {
        teclear("Bitc")
        expect(aceptar().disabled).toBe(true)

        teclear("Bitcoin")
        expect(aceptar().disabled).toBe(false)

        teclear("Bitcoins")
        expect(aceptar().disabled).toBe(true)
    })

    it("no distingue mayúsculas ni espacios de más: es una pausa, no un dictado", () => {
        teclear("  bitcoin  ")
        expect(aceptar().disabled).toBe(false)
    })

    it("un nombre parecido no vale", () => {
        teclear("Bitcoin Cash")
        expect(aceptar().disabled).toBe(true)
    })
})

describe("no se puede borrar sin que cuadre", () => {
    it("el clic en Eliminar no hace nada mientras el texto no coincida", async () => {
        const alConfirmar = vi.fn()
        openConfirmModal({ message: "Vas a eliminar Bitcoin.", requireText: "Bitcoin", onConfirm: alConfirmar })

        teclear("otra cosa")
        aceptar().click()
        await new Promise((r) => setTimeout(r, 0))

        expect(alConfirmar).not.toHaveBeenCalled()
        // Y el diálogo sigue abierto, no se cierra a medias.
        expect(document.getElementById("confirmModalOverlay").classList.contains("hidden")).toBe(false)
    })

    it("confirma cuando cuadra", async () => {
        const alConfirmar = vi.fn()
        openConfirmModal({ message: "Vas a eliminar Bitcoin.", requireText: "Bitcoin", onConfirm: alConfirmar })

        teclear("Bitcoin")
        aceptar().click()

        await vi.waitFor(() => expect(alConfirmar).toHaveBeenCalledTimes(1))
        expect(document.getElementById("confirmModalOverlay").classList.contains("hidden")).toBe(true)
    })

    it("Enter en el campo confirma solo si cuadra", async () => {
        const alConfirmar = vi.fn()
        openConfirmModal({ message: "Vas a eliminar Bitcoin.", requireText: "Bitcoin", onConfirm: alConfirmar })

        teclear("nada")
        campo().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
        await new Promise((r) => setTimeout(r, 0))
        expect(alConfirmar).not.toHaveBeenCalled()

        teclear("Bitcoin")
        campo().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
        await vi.waitFor(() => expect(alConfirmar).toHaveBeenCalledTimes(1))
    })
})

describe("el estado no se filtra entre diálogos", () => {
    it("cancelar deja limpio el siguiente diálogo que no pide nada", () => {
        openConfirmModal({ message: "Vas a eliminar Bitcoin.", requireText: "Bitcoin", onConfirm: () => {} })
        teclear("Bit")
        document.getElementById("confirmModalCancelBtn").click()

        openConfirmModal({ message: "¿Seguro?", onConfirm: () => {} })

        expect(caja().classList.contains("hidden")).toBe(true)
        expect(aceptar().disabled).toBe(false)
        expect(campo().value).toBe("")
    })

    it("un diálogo con nombre tras otro no hereda lo tecleado", () => {
        openConfirmModal({ message: "Vas a eliminar Bitcoin.", requireText: "Bitcoin", onConfirm: () => {} })
        teclear("Bitcoin")
        expect(aceptar().disabled).toBe(false)

        document.getElementById("confirmModalCancelBtn").click()
        openConfirmModal({ message: "Vas a eliminar Oro.", requireText: "Oro", onConfirm: () => {} })

        expect(campo().value).toBe("")
        expect(aceptar().disabled).toBe(true)
    })

    it("tras confirmar, el diálogo siguiente vuelve a pedir el nombre", async () => {
        const alConfirmar = vi.fn()
        openConfirmModal({ message: "Vas a eliminar Bitcoin.", requireText: "Bitcoin", onConfirm: alConfirmar })
        teclear("Bitcoin")
        aceptar().click()
        await vi.waitFor(() => expect(alConfirmar).toHaveBeenCalled())

        openConfirmModal({ message: "Vas a eliminar Bitcoin.", requireText: "Bitcoin", onConfirm: () => {} })
        expect(aceptar().disabled).toBe(true)
    })
})
