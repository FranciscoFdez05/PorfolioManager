// Varias lecturas del detalle de seguimientos a la vez.
//
// Leer los movimientos de un seguimiento con muchas wallets son minutos. Antes,
// pasar a otro seguimiento mientras tanto cortaba la lectura y tiraba lo leído;
// ahora cada una termina por su cuenta y deja el resultado guardado. Volver al
// seguimiento a mitad retoma esa misma lectura en vez de empezar otra, y pedir
// a la red lo último («Actualizar») sí descarta la que estaba en marcha.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runInThisContext } from "node:vm"

import { cargarModulo, cargarScript } from "./cargar.js"

// Las variables de primer nivel del script (let/const) no cuelgan de window:
// solo se ven desde otro script del mismo contexto.
const global = (expresion) => runInThisContext(expresion)

const GRUPOS = [
    { clave: "satoshi", nombre: "Satoshi", wallets: [{ id: "s1", alias: "Bloque 1", red: "btc" }] },
    { clave: "binance", nombre: "Binance", wallets: [{ id: "b1", alias: "Binance BTC 1", red: "btc" }] }
]

let pendientes

function responder(walletId, datos) {
    const indice = pendientes.findIndex((p) => p.url.includes(`/api/wallets/${walletId}/`))
    const [peticion] = pendientes.splice(indice, 1)
    peticion.resolver(datos)
}

const PAGINA = { movimientos: [{ id: "tx1", fecha: "2026-11-03T10:00:00Z" }], limite: 50, maximo: 50 }

// Deja correr las continuaciones de las promesas ya resueltas.
const vaciarCola = () => new Promise((resolver) => setTimeout(resolver, 0))

beforeAll(() => {
    cargarScript("js/cripto/wallets.js")
    cargarModulo("js/cripto/wallets-seguimiento.js")
})

beforeEach(() => {
    pendientes = []
    global("walletsSegLeidos.clear(); walletsSegEnCurso.clear(); walletsSegDetalle = null")
    window.walletsGruposSeguimiento = () => GRUPOS
    window.walletsNombreCompleto = (wallet) => wallet.alias
    window.renderWalletsSeguimiento = vi.fn()
    window.renderDetalleSeguimiento = vi.fn()
    window.iniciarProgreso = vi.fn(() => ({ paso: vi.fn(), terminar: vi.fn() }))
    window.walletsPeticion = vi.fn(
        (url) => new Promise((resolver) => pendientes.push({ url, resolver }))
    )
    Element.prototype.scrollIntoView = vi.fn()
})

describe("lecturas del detalle de seguimientos", () => {
    it("pasar a otro seguimiento no corta la lectura del anterior", async () => {
        window.abrirDetalleSeguimiento("satoshi")
        window.abrirDetalleSeguimiento("binance")
        expect(pendientes.map((p) => p.url)).toEqual([
            expect.stringContaining("/api/wallets/s1/"),
            expect.stringContaining("/api/wallets/b1/")
        ])

        responder("s1", PAGINA)
        await vaciarCola()

        const leido = global("walletsSegLeidos.get('satoshi')")
        expect(leido.historialFecha).not.toBe("")
        expect(leido.historiales.s1.movimientos).toHaveLength(1)
        expect(global("walletsSegEnCurso.has('satoshi')")).toBe(false)
        // Binance sigue leyendo y es el que se ve.
        expect(global("walletsSegDetalle.clave")).toBe("binance")
        expect(global("walletsSegEnCurso.has('binance')")).toBe(true)
    })

    it("volver a un seguimiento a mitad de lectura retoma esa lectura", async () => {
        window.abrirDetalleSeguimiento("satoshi")
        const estado = global("walletsSegDetalle")
        window.abrirDetalleSeguimiento("binance")
        window.abrirDetalleSeguimiento("satoshi")

        expect(global("walletsSegDetalle")).toBe(estado)
        expect(window.walletsPeticion).toHaveBeenCalledTimes(2)

        responder("s1", PAGINA)
        await vaciarCola()
        expect(estado.cargando).toBe(false)
        expect(window.renderDetalleSeguimiento).toHaveBeenCalled()
    })

    it("actualizar desde la red descarta la lectura que estaba en marcha", async () => {
        window.abrirDetalleSeguimiento("satoshi")
        const viejo = global("walletsSegDetalle")
        window.walletsSegReabrirDetalleSi(["s1"])
        const nuevo = global("walletsSegDetalle")
        expect(nuevo).not.toBe(viejo)

        // Contesta primero la lectura vieja: no debe guardarse.
        const [peticionVieja] = pendientes.splice(0, 1)
        peticionVieja.resolver({ ...PAGINA, movimientos: [{ id: "viejo" }] })
        await vaciarCola()
        expect(global("walletsSegLeidos.has('satoshi')")).toBe(false)

        responder("s1", PAGINA)
        await vaciarCola()
        expect(global("walletsSegLeidos.get('satoshi')").historiales.s1.movimientos[0].id).toBe("tx1")
    })
})
