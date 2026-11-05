// Detalle de una fila de Transacciones: las filas no guardan direcciones ni
// contrato, así que hay que encontrar su movimiento en las wallets sin confundirlo
// con otro de la misma transacción.
import { beforeAll, describe, expect, it, vi } from "vitest"

import { cargarScript } from "./cargar.js"

const NATIVA = { id: "w-eth", seguimiento: "Ledger", assetId: "ethereum", recientes: [] }
const OTRA = { id: "w-otra", seguimiento: "Trezor", assetId: "ethereum", recientes: [] }
const FILA = { assetId: "ethereum", assetName: "Ethereum", hashTransaccion: "0xABC", walletDesde: "0xfuera", walletDestino: "Ledger" }
const ETH = { hash: "0xabc", simbolo: "ETH", contrato: "" }
const USDC = { hash: "0xabc", simbolo: "USDC", contrato: "0xusdc" }

const buscar = (fila, wallets, movimientos) =>
    window.buscarMovimientoDeFila(fila, wallets, (wallet) => movimientos[wallet.id] || [])

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cripto/transacciones.js")
})

describe("buscar el movimiento de una fila", () => {
    it("lo encuentra por hash sin distinguir mayúsculas", () => {
        expect(buscar(FILA, [NATIVA], { "w-eth": [ETH] })).toEqual({ mov: ETH, wallet: NATIVA })
    })

    it("no confunde la fila de la moneda con el token de la misma transacción", () => {
        expect(buscar(FILA, [NATIVA], { "w-eth": [USDC] })).toBeNull()
        expect(buscar(FILA, [NATIVA], { "w-eth": [USDC, ETH] }).mov).toBe(ETH)
    })

    it("encuentra un token por su símbolo", () => {
        const fila = { ...FILA, assetId: "stablecoin-USDC", assetName: "USDC" }
        expect(buscar(fila, [NATIVA], { "w-eth": [ETH, USDC] }).mov).toBe(USDC)
    })

    it("prefiere la wallet que nombra la fila si la transacción está en las dos", () => {
        const encontrado = buscar(FILA, [OTRA, NATIVA], { "w-otra": [ETH], "w-eth": [{ ...ETH }] })
        expect(encontrado.wallet).toBe(NATIVA)
    })

    it("sin hash o sin coincidencia no hay movimiento", () => {
        expect(buscar({ ...FILA, hashTransaccion: "" }, [NATIVA], { "w-eth": [ETH] })).toBeNull()
        expect(buscar({ ...FILA, hashTransaccion: "0xotro" }, [NATIVA], { "w-eth": [ETH] })).toBeNull()
    })
})

describe("orden de la tabla al repintar", () => {
    const FILAS = [
        { id: "a", assetId: "bitcoin", fechaOperacion: "01-01-2026" },
        { id: "b", assetId: "bitcoin", fechaOperacion: "03-01-2026" },
        { id: "c", assetId: "bitcoin", fechaOperacion: "02-01-2026" }
    ]
    const ordenVisible = () => [...document.querySelectorAll("#transaccionesBody tr")].map((tr) => tr.dataset.transaccionId)

    it("conserva el orden elegido cuando las filas vuelven del servidor", () => {
        document.body.innerHTML = `<table>
            <thead><tr><th></th><th class="mThSort" data-sortkey="1">Fecha<span class="mSortArrow"></span></th></tr></thead>
            <tbody id="transaccionesBody"></tbody>
        </table>`
        localStorage.setItem("tableSort_transacciones", JSON.stringify({ key: "1", dir: "desc" }))
        window.__filas = { rows: FILAS }
        window.__activos = [{ id: "bitcoin", name: "Bitcoin" }]
        window.eval("currentTransaccionesData = window.__filas; transaccionesCryptoAssets = window.__activos")

        window.renderTransaccionesTable()
        expect(ordenVisible()).toEqual(["b", "c", "a"])

        window.renderTransaccionesTable()
        expect(ordenVisible()).toEqual(["b", "c", "a"])

        localStorage.removeItem("tableSort_transacciones")
        document.body.innerHTML = ""
    })
})

describe("clic en la celda del hash", () => {
    const pulsarHash = (hash) => {
        const copiar = vi.fn().mockResolvedValue()
        Object.defineProperty(navigator, "clipboard", { value: { writeText: copiar }, configurable: true })
        const tabla = document.createElement("table")
        tabla.innerHTML = `<tr data-transaccion-id="sin-datos"><td class="transaccionHashCell" data-full-value="${hash}">${hash}</td></tr>`
        window.handleTransaccionesClick({ target: tabla.querySelector("td") })
        return copiar
    }

    it("copia el hash completo", () => {
        expect(pulsarHash("0xABC")).toHaveBeenCalledWith("0xABC")
    })

    it("sin hash no copia nada", () => {
        expect(pulsarHash("")).not.toHaveBeenCalled()
    })
})

describe("comisión de las filas importadas", () => {
    const SIN_COMISION = { id: "wallet-1", walletTipo: "entre_wallet", comisionRed: "" }

    it("solo pide completar una fila importada, entre wallets y sin comisión", () => {
        expect(window.transaccionesFaltaComision([SIN_COMISION])).toBe(true)
        expect(window.transaccionesFaltaComision([{ ...SIN_COMISION, comisionRed: "0" }])).toBe(false)
        expect(window.transaccionesFaltaComision([{ ...SIN_COMISION, id: "manual" }])).toBe(false)
        expect(window.transaccionesFaltaComision([{ ...SIN_COMISION, walletTipo: "recibida" }])).toBe(false)
        expect(window.transaccionesFaltaComision(undefined)).toBe(false)
    })

    it("sin nada que completar no llama al servidor", async () => {
        const llamada = vi.spyOn(window, "fetch")
        expect(await window.completarComisionesDeTransacciones([])).toBe(false)
        expect(llamada).not.toHaveBeenCalled()
        llamada.mockRestore()
    })

    it("avisa de que hay que releer solo si cambió alguna", async () => {
        const responder = (completadas) =>
            vi.spyOn(window, "fetch").mockResolvedValueOnce({ ok: true, json: async () => ({ completadas }) })
        responder(1)
        expect(await window.completarComisionesDeTransacciones([SIN_COMISION])).toBe(true)
        responder(0)
        expect(await window.completarComisionesDeTransacciones([SIN_COMISION])).toBe(false)
        vi.restoreAllMocks()
    })

    it("un fallo no impide ver la tabla", async () => {
        const aviso = vi.spyOn(console, "warn").mockImplementation(() => {})
        vi.spyOn(window, "fetch").mockRejectedValueOnce(new Error("sin red"))
        expect(await window.completarComisionesDeTransacciones([SIN_COMISION])).toBe(false)
        expect(aviso).toHaveBeenCalled()
        vi.restoreAllMocks()
    })
})

describe("recargar tras un cambio en el servidor", () => {
    it("refresca la posición de Activos aunque la tabla no esté en pantalla", async () => {
        window.currentAssetId = "bitcoin"
        window.refreshAssetsSidebar = vi.fn().mockResolvedValue()

        await window.recargarTransaccionesDesdeServidor()

        expect(window.refreshAssetsSidebar).toHaveBeenCalledWith("bitcoin", false)
    })
})

describe("nombre de la wallet en la fila", () => {
    it("las filas importadas llevan el nombre del seguimiento", () => {
        expect(window.transaccionNombraWallet(NATIVA, FILA)).toBe(true)
        expect(window.transaccionNombraWallet(OTRA, FILA)).toBe(false)
    })
})
