// Lo leído en el detalle de un seguimiento sigue ahí al volver a entrar.
//
// Abrir enseña lo guardado en el servidor con su fecha mientras se buscan los
// movimientos nuevos, sin vaciar lo que se ve, y un fallo de la red no se lo lleva.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runInThisContext } from "node:vm"

import { cargarModulo, cargarScript } from "./cargar.js"

const global = (expresion) => runInThisContext(expresion)

const GRUPOS = [{ clave: "trezor", nombre: "Trezor", wallets: [{ id: "w1", alias: "Trezor", red: "btc" }] }]
const FECHA = "2026-11-01T10:00:00+00:00"
const MINUTOS = 60 * 1000

function movimiento(hash) {
    return { hash, fecha: FECHA, simbolo: "BTC", cantidad: "1", tipo: "recibida" }
}

function guardado(cambios = {}) {
    return {
        ok: true,
        disponible: true,
        lecturas: {
            w1: {
                movimientos: { movimientos: [movimiento("viejo")], limite: 300, maximo: 1000, agotado: false, fecha: FECHA },
                utxos: { utxos: [{ txid: "t", satoshis: 5, walletId: "w1" }], alturaActual: 7, fecha: FECHA },
                tokens: { tokens: [{ simbolo: "USDT", contrato: "0xa" }], sinLeer: 2, tokensPublicos: [], fecha: FECHA },
                ...cambios
            }
        }
    }
}

const vaciarCola = () => new Promise((resolver) => setTimeout(resolver, 0))

let pendientes

function responder(datos) {
    pendientes.shift().resolver(datos)
}

function fallar(error) {
    pendientes.shift().rechazar(error)
}

function ponerGuardado(datos) {
    window.fetch = vi.fn(async () => ({ ok: true, json: async () => datos }))
}

beforeAll(() => {
    cargarScript("js/cripto/wallets.js")
    cargarModulo("js/cripto/wallets-seguimiento.js")
})

beforeEach(() => {
    pendientes = []
    global("walletsSegLeidos.clear(); walletsSegEnCurso.clear(); walletsSegTokensLeidos.clear(); walletsSegDetalle = null")
    window.walletsGruposSeguimiento = () => GRUPOS
    window.walletsNombreCompleto = (wallet) => wallet.alias
    window.renderWalletsSeguimiento = vi.fn()
    window.renderDetalleSeguimiento = vi.fn()
    window.iniciarProgreso = vi.fn(() => ({ paso: vi.fn(), terminar: vi.fn(), detalle: vi.fn() }))
    window.walletsPeticion = vi.fn((url) => new Promise((resolver, rechazar) => pendientes.push({ url, resolver, rechazar })))
    Element.prototype.scrollIntoView = vi.fn()
    localStorage.clear()
})

describe("lecturas guardadas del detalle", () => {
    it("enseña lo guardado con su fecha mientras busca lo nuevo", async () => {
        ponerGuardado(guardado())

        window.abrirDetalleSeguimiento("trezor")
        await vaciarCola()

        const estado = global("walletsSegDetalle")
        expect(estado.cargando).toBe(true)
        expect(estado.historiales.w1.movimientos.map((m) => m.hash)).toEqual(["viejo"])
        expect(estado.historiales.w1.movimientos[0].walletId).toBe("w1")
        expect(estado.historialFecha).toBe(FECHA)
        expect(pendientes[0].url).toContain("/api/wallets/w1/movimientos?limite=100")
        expect(pendientes[0].url).not.toContain("reiniciar")
    })

    it("lo nuevo sustituye a lo guardado sin perder cuántos había cargados", async () => {
        ponerGuardado(guardado())
        window.abrirDetalleSeguimiento("trezor")
        await vaciarCola()

        responder({ movimientos: [movimiento("nuevo"), movimiento("viejo")], limite: 300, maximo: 1000, agotado: false, guardado: true })
        await vaciarCola()

        const historial = global("walletsSegDetalle").historiales.w1
        expect(historial.movimientos.map((m) => m.hash)).toEqual(["nuevo", "viejo"])
        expect(historial.limite).toBe(300)
        expect(global("walletsSegDetalle").historialFecha).not.toBe(FECHA)
    })

    it("si llega antes la red, lo guardado no la pisa", async () => {
        let soltarGuardado
        window.fetch = vi.fn(
            () =>
                new Promise((resolver) => {
                    soltarGuardado = () => resolver({ ok: true, json: async () => guardado() })
                })
        )
        window.abrirDetalleSeguimiento("trezor")
        responder({ movimientos: [movimiento("nuevo")], limite: 100, maximo: 1000, agotado: false, guardado: true })
        await vaciarCola()

        soltarGuardado()
        await vaciarCola()

        expect(global("walletsSegDetalle").historiales.w1.movimientos.map((m) => m.hash)).toEqual(["nuevo"])
    })

    it("si falla la red lo guardado se queda, con su fecha y el error a la vista", async () => {
        ponerGuardado(guardado())
        window.abrirDetalleSeguimiento("trezor")
        await vaciarCola()

        fallar(Object.assign(new Error("red caída"), { status: 400 }))
        await vaciarCola()

        const estado = global("walletsSegDetalle")
        expect(estado.historiales.w1.movimientos.map((m) => m.hash)).toEqual(["viejo"])
        expect(estado.historiales.w1.error).toContain("red caída")
        expect(estado.historialFecha).toBe(FECHA)
    })

    it("sin nada guardado se lee como siempre", async () => {
        ponerGuardado({ ok: true, disponible: true, lecturas: {} })
        window.abrirDetalleSeguimiento("trezor")
        await vaciarCola()

        responder({ movimientos: [movimiento("h1")], limite: 100, maximo: 1000, agotado: false, guardado: true })
        await vaciarCola()

        expect(global("walletsSegDetalle").historiales.w1.movimientos).toHaveLength(1)
    })

    it("si el servidor no contesta lo guardado, se lee igual de la red", async () => {
        window.fetch = vi.fn(async () => ({ ok: false, status: 500 }))
        window.abrirDetalleSeguimiento("trezor")
        await vaciarCola()

        expect(pendientes).toHaveLength(1)
    })

    it("volver a leer pide sustituir y no vacía lo que se ve", async () => {
        ponerGuardado(guardado())
        window.abrirDetalleSeguimiento("trezor")
        await vaciarCola()
        responder({ movimientos: [movimiento("viejo")], limite: 300, maximo: 1000, agotado: false, guardado: true })
        await vaciarCola()

        window.releerHistorialDetalle()

        expect(pendientes[0].url).toContain("limite=300&reiniciar=1")
        expect(global("walletsSegDetalle").historiales.w1.movimientos).toHaveLength(1)
    })

    it("cargar más pide la página siguiente", async () => {
        ponerGuardado(guardado())
        window.abrirDetalleSeguimiento("trezor")
        await vaciarCola()
        responder({ movimientos: [movimiento("viejo")], limite: 300, maximo: 1000, agotado: false, guardado: true })
        await vaciarCola()

        window.cargarHistorialDetalle()

        expect(pendientes[0].url).toContain("limite=400")
        expect(pendientes[0].url).not.toContain("reiniciar")
    })
})

describe("cuándo se buscan los nuevos", () => {
    async function abrirYTerminar(guardadoServidor = true) {
        ponerGuardado(guardado())
        window.abrirDetalleSeguimiento("trezor")
        await vaciarCola()
        responder({ movimientos: [movimiento("viejo")], limite: 300, maximo: 1000, agotado: false, guardado: guardadoServidor })
        await vaciarCola()
        window.cerrarDetalleSeguimiento()
    }

    it("no vuelve a pedir lo leído hace menos de dos minutos", async () => {
        await abrirYTerminar()
        window.walletsPeticion.mockClear()

        window.abrirDetalleSeguimiento("trezor")

        expect(window.walletsPeticion).not.toHaveBeenCalled()
    })

    it("pasados dos minutos busca lo nuevo enseñando lo que había", async () => {
        await abrirYTerminar()
        global("walletsSegLeidos").get("trezor").historialFecha = new Date(Date.now() - 3 * MINUTOS).toISOString()
        window.walletsPeticion.mockClear()

        window.abrirDetalleSeguimiento("trezor")

        expect(window.walletsPeticion).toHaveBeenCalledTimes(1)
        expect(global("walletsSegDetalle").historiales.w1.movimientos).toHaveLength(1)
    })

    it("si el servidor no puede guardar, lo de memoria no caduca: una página dejaría sin el resto", async () => {
        await abrirYTerminar(false)
        global("walletsSegLeidos").get("trezor").historialFecha = new Date(Date.now() - 3 * MINUTOS).toISOString()
        window.walletsPeticion.mockClear()

        window.abrirDetalleSeguimiento("trezor")

        expect(window.walletsPeticion).not.toHaveBeenCalled()
    })
})

describe("UTXOs y tokens guardados", () => {
    it("se ven sin pedirlos a la red y dejan los tokens para las tarjetas", async () => {
        ponerGuardado(guardado())
        window.abrirDetalleSeguimiento("trezor")
        await vaciarCola()

        const estado = global("walletsSegDetalle")
        expect(estado.utxos.lista).toHaveLength(1)
        expect(estado.utxos.alturaActual).toBe(7)
        expect(estado.utxos.fecha).toBe(FECHA)
        expect(estado.tokens.sinLeer).toBe(2)
        expect(global("walletsSegTokensLeidos").get("w1")[0].walletId).toBe("w1")
    })

    it("al actualizar se siguen viendo y se sustituyen al terminar", async () => {
        ponerGuardado(guardado())
        window.abrirDetalleSeguimiento("trezor")
        await vaciarCola()
        pendientes.length = 0

        const carga = window.cargarUtxosDetalle()
        const estado = global("walletsSegDetalle")
        expect(estado.utxos.actualizando).toBe(true)
        expect(estado.utxos.lista.map((u) => u.txid)).toEqual(["t"])

        responder({ utxos: [{ txid: "n", satoshis: 9 }], alturaActual: 8 })
        await carga

        expect(estado.utxos.actualizando).toBe(false)
        expect(estado.utxos.lista.map((u) => u.txid)).toEqual(["n"])
        expect(estado.utxos.fecha).not.toBe(FECHA)
    })

    it("si la lectura falla se quedan, con su fecha", async () => {
        const conWallet = guardado({
            utxos: { utxos: [{ txid: "t", satoshis: 5 }], alturaActual: 7, fecha: FECHA }
        })
        ponerGuardado(conWallet)
        window.abrirDetalleSeguimiento("trezor")
        await vaciarCola()
        pendientes.length = 0

        const carga = window.cargarUtxosDetalle()
        fallar(Object.assign(new Error("red caída"), { status: 400 }))
        await carga

        const utxos = global("walletsSegDetalle").utxos
        expect(utxos.lista.map((u) => u.txid)).toEqual(["t"])
        expect(utxos.alturaActual).toBe(7)
        expect(utxos.fecha).toBe(FECHA)
        expect(utxos.errores[0]).toContain("red caída")
    })
})
