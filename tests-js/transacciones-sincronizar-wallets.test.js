// Botón «Sincronizar» de Transacciones: importa todas las wallets propias. Lo
// delicado es que una wallet caída no pare a las demás ni oculte lo ya importado.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runInThisContext } from "node:vm"

import { cargarScript } from "./cargar.js"

const wallet = (id, seguimiento, propia = true) => ({
    id,
    alias: seguimiento,
    propia,
    seguimiento,
    seguimientoClave: seguimiento.toLowerCase()
})
const LEDGER = wallet("w-1", "Ledger")
const TREZOR = wallet("w-2", "Trezor")
const AJENA = wallet("w-3", "Ballena", false)

function respuesta(cuerpo, status = 200) {
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(cuerpo) })
}

// Simula el servidor: `resultados` es lo que responde cada wallet (o un error) y
// `orden` guarda todo lo ocurrido, para comprobar la secuencia.
function servidor(wallets, resultados = {}, orden = []) {
    window.fetch = vi.fn((url) => {
        if (url === "/api/wallets") return respuesta({ wallets })
        orden.push(url)
        const resultado = resultados[url.split("/")[3]]
        if (resultado?.error) return respuesta({ ok: false, error: resultado.error }, 502)
        return respuesta({ ok: true, anadidas: 0, yaImportadas: 0, sinActivo: {}, ...resultado })
    })
    return orden
}

const urlDe = (id) => `/api/wallets/${id}/sincronizar`
const toasts = (tipo) => window.showToast.mock.calls.filter(([, opciones]) => opciones?.type === tipo)

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cripto/wallets.js")
})

let boton

beforeEach(() => {
    document.body.innerHTML = `<button id="sync">Sincronizar</button>`
    boton = document.getElementById("sync")
    window.showToast = vi.fn()
    window.iniciarProgreso = vi.fn(() => ({ paso: vi.fn(), terminar: vi.fn() }))
    window.flushTransaccionesPendingChanges = vi.fn(() => Promise.resolve())
    window.recargarTransaccionesDesdeServidor = vi.fn(() => Promise.resolve())
    runInThisContext(`
        showToast = window.showToast
        flushTransaccionesPendingChanges = window.flushTransaccionesPendingChanges
        recargarTransaccionesDesdeServidor = window.recargarTransaccionesDesdeServidor
    `)
})

describe("sincronizarWalletsPropias", () => {
    it("importa solo las propias, en orden, y suma lo de todas", async () => {
        const orden = servidor([LEDGER, AJENA, TREZOR], {
            "w-1": { anadidas: 1, yaImportadas: 5, sinActivo: { USDT: 1 } },
            "w-2": { anadidas: 2, yaImportadas: 1, pendientes: 1, sinActivo: { USDT: 2 } }
        })

        await window.sincronizarWalletsPropias(boton)

        expect(orden).toEqual([urlDe("w-1"), urlDe("w-2")])
        expect(toasts("success")).toHaveLength(1)
        const texto = toasts("success")[0][0]
        expect(texto).toContain("3 movimientos nuevos")
        expect(texto).toContain("6 ya estaban")
        expect(texto).toContain("1 entrada por verificar")
        expect(texto).toContain("USDT (3)")
    })

    it("guarda lo pendiente antes de importar y relee la tabla una sola vez", async () => {
        const orden = []
        window.flushTransaccionesPendingChanges.mockImplementation(() => {
            orden.push("guardar")
            return Promise.resolve()
        })
        window.recargarTransaccionesDesdeServidor.mockImplementation(() => {
            orden.push("releer")
            return Promise.resolve()
        })
        servidor([LEDGER, TREZOR], {}, orden)

        await window.sincronizarWalletsPropias(boton)

        expect(orden).toEqual(["guardar", urlDe("w-1"), urlDe("w-2"), "releer"])
    })

    it("no importa nada si no se ha podido guardar lo pendiente", async () => {
        window.flushTransaccionesPendingChanges.mockRejectedValue(new Error("Sin conexión"))
        const orden = servidor([LEDGER])

        await window.sincronizarWalletsPropias(boton)

        expect(orden).toEqual([])
        expect(toasts("error")[0][0]).toBe("Sin conexión")
        expect(boton.disabled).toBe(false)
    })

    it("una wallet que falla no para a las demás y se cuenta lo importado", async () => {
        const orden = servidor([LEDGER, TREZOR], {
            "w-1": { error: "La red no responde" },
            "w-2": { anadidas: 1 }
        })

        await window.sincronizarWalletsPropias(boton)

        expect(orden).toEqual([urlDe("w-1"), urlDe("w-2")])
        expect(toasts("success")[0][0]).toContain("1 movimiento nuevo")
        expect(toasts("error")[0][0]).toBe("Ledger: La red no responde")
        expect(window.recargarTransaccionesDesdeServidor).toHaveBeenCalledOnce()
    })

    it("si fallan todas no da nada por importado", async () => {
        servidor([LEDGER, TREZOR], { "w-1": { error: "Caída" }, "w-2": { error: "Caída" } })

        await window.sincronizarWalletsPropias(boton)

        expect(toasts("success")).toHaveLength(0)
        expect(toasts("error")[0][0]).toBe("Ledger: Caída · Trezor: Caída")
    })

    it("avisa de una importación limitada nombrando la wallet", async () => {
        servidor([LEDGER], { "w-1": { truncada: true, limite: 500, desde: "01-01-2026" } })

        await window.sincronizarWalletsPropias(boton)

        expect(toasts("warning")[0][0]).toContain("Ledger: solo se han leído los últimos 500")
    })

    it("sin wallets propias lo dice y no llama a sincronizar", async () => {
        const orden = servidor([AJENA])

        await window.sincronizarWalletsPropias(boton)

        expect(orden).toEqual([])
        expect(toasts("warning")[0][0]).toContain("No hay wallets propias")
        expect(boton.disabled).toBe(false)
    })

    it("desactiva el botón mientras dura y luego lo deja como estaba", async () => {
        let durante
        servidor([LEDGER])
        const fetchServidor = window.fetch
        window.fetch = vi.fn((url) => {
            if (url === urlDe("w-1")) durante = { disabled: boton.disabled, texto: boton.textContent }
            return fetchServidor(url)
        })

        await window.sincronizarWalletsPropias(boton)

        expect(durante).toEqual({ disabled: true, texto: "Sincronizando…" })
        expect(boton.disabled).toBe(false)
        expect(boton.textContent).toBe("Sincronizar")
    })
})
