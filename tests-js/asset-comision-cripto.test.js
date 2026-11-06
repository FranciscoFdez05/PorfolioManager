// La cripto perdida en comisiones tiene que salir en «Comisiones» y en el bruto
// sin mover el neto, y el reparto por origen tiene que sumar la cantidad en cartera.
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { runInThisContext } from "node:vm"

import { cargarModulo, cargarScript } from "./cargar.js"

const COMISION_RED = 0.00002213

const compra = (fecha, cantidad, importe, comisionFiat) => ({
    fechaOperacion: fecha,
    tipoOperacion: "Compra",
    participaciones: String(cantidad),
    precioParticipacion: String((importe - comisionFiat) / cantidad),
    currency: "EUR",
    capitalInvertidoBruto: String(importe),
    comisionesFiat: String(comisionFiat)
})

const ACTIVO = {
    id: "bitcoin",
    name: "Bitcoin",
    symbol: "BTC",
    type: "cripto",
    price: "68000",
    currency: "EUR",
    rows: [compra("01-09-2026", 0.002, 130, 0.5), compra("01-10-2026", 0.001, 70, 0.25)],
    operationRows: []
}

const entreWallets = {
    assetId: "bitcoin",
    fechaOperacion: "01-11-2026",
    walletTipo: "entre_wallet",
    total: "0.0029",
    comisionRed: String(COMISION_RED)
}

const fijarTransacciones = (filas) => {
    window.__filasPrueba = filas
    runInThisContext("externalTransaccionesRowsCache = window.__filasPrueba")
}

const fijarVentas = (filas) => {
    window.__filasPrueba = filas
    runInThisContext("externalVentasRowsCache = window.__filasPrueba")
}

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarModulo("js/cartera/assets.js")
    cargarScript("js/cripto/operaciones.js")
})

afterEach(() => {
    fijarTransacciones([])
    fijarVentas([])
})

describe("resumen del activo con comisiones cripto", () => {
    it("sin comisión de red, el bruto y las comisiones siguen igual", async () => {
        const resumen = await buildOverviewRow(ACTIVO)

        expect(resumen.invertidoBrutoVisible).toBeCloseTo(200, 8)
        expect(resumen.comisiones).toBeCloseTo(0.75, 8)
        expect(resumen.invertidoNeto).toBeCloseTo(199.25, 8)
    })

    it("la cripto perdida suma a comisiones y al bruto, y el neto no cambia", async () => {
        const sinComision = await buildOverviewRow(ACTIVO)
        fijarTransacciones([entreWallets])

        const resumen = await buildOverviewRow(ACTIVO)
        const costeEsperado = COMISION_RED * (130 / 0.002)

        expect(resumen.costeComisionesCripto).toBeCloseTo(costeEsperado, 8)
        expect(resumen.comisiones).toBeCloseTo(0.75 + costeEsperado, 8)
        expect(resumen.invertidoBrutoVisible).toBeCloseTo(200, 8)
        expect(resumen.invertidoBrutoVisible - resumen.comisiones).toBeCloseTo(resumen.invertidoNeto, 8)
        expect(resumen.invertidoBruto).toBeCloseTo(200 - costeEsperado, 8)
        expect(resumen.invertidoNeto).toBeCloseTo(sinComision.invertidoNeto - costeEsperado, 8)
        expect(resumen.participaciones).toBeCloseTo(0.003 - COMISION_RED, 10)
    })

    it("en un envío, solo la comisión cuenta como pérdida", async () => {
        fijarTransacciones([{ ...entreWallets, walletTipo: "enviada", total: "0.001" }])

        const resumen = await buildOverviewRow(ACTIVO)

        expect(resumen.costeComisionesCripto).toBeCloseTo(COMISION_RED * (130 / 0.002), 8)
        expect(resumen.participaciones).toBeCloseTo(0.002 - COMISION_RED, 10)
    })

    it("una transacción sin comisión no apunta coste", async () => {
        fijarTransacciones([{ ...entreWallets, comisionRed: "" }])

        expect((await buildOverviewRow(ACTIVO)).costeComisionesCripto).toBe(0)
    })

    // Un bruto mayor que cero dejaría visible en la Vista general un activo vaciado.
    it("sin posición, la comisión no deja bruto colgando", async () => {
        fijarTransacciones([{ ...entreWallets, walletTipo: "enviada", total: String(0.003 - COMISION_RED) }])

        const resumen = await buildOverviewRow(ACTIVO)

        expect(resumen.participaciones).toBeCloseTo(0, 10)
        expect(resumen.invertidoBrutoVisible).toBeCloseTo(0, 8)
        expect(resumen.comisiones).toBeGreaterThan(0.75)
    })
})

describe("cripto gastada en comisiones en el panel", () => {
    it("enseña la cantidad con su símbolo en minúsculas", () => {
        expect(buildComisionCriptoTexto(ACTIVO, COMISION_RED)).toBe("0,00002213 btc")
    })

    it("sin comisiones cripto no enseña nada", () => {
        expect(buildComisionCriptoTexto(ACTIVO, 0)).toBe("")
    })

    it("un activo que no es cripto no enseña nada", () => {
        expect(buildComisionCriptoTexto({ ...ACTIVO, type: "acciones" }, COMISION_RED)).toBe("")
    })

    it("oculta el elemento cuando no hay texto y lo enseña cuando lo hay", () => {
        document.body.innerHTML = '<span id="detFeesCripto" hidden></span>'
        const elemento = document.getElementById("detFeesCripto")

        pintarComisionCripto("0,00002213 BTC")
        expect(elemento.hidden).toBe(false)
        expect(elemento.textContent).toBe("0,00002213 BTC")

        pintarComisionCripto("")
        expect(elemento.hidden).toBe(true)
    })
})

describe("participaciones por origen", () => {
    const totalDe = (partes) => sumarAssetTodosPosicion(partes)

    it("añade una porción con la cripto perdida, igual a la del panel", async () => {
        fijarTransacciones([entreWallets])

        const partes = await buildAssetTodosOrigenPartes(ACTIVO)
        const comisiones = partes.find((parte) => parte.etiqueta === "Comisiones")

        expect(comisiones.valor).toBeCloseTo(COMISION_RED, 12)
        expect(comisiones.color).toBe("#e5484d")
    })

    it("sin comisiones cripto la porción queda a cero y el quesito la descarta", async () => {
        const partes = await buildAssetTodosOrigenPartes(ACTIVO)

        expect(partes.find((parte) => parte.etiqueta === "Comisiones").valor).toBe(0)
    })

    it("el pie da la cantidad en cartera y aparte las comisiones", async () => {
        fijarTransacciones([entreWallets])

        const pie = buildAssetTodosOrigenPie(ACTIVO, await buildAssetTodosOrigenPartes(ACTIVO))

        expect(pie).toBe("Total: 0,00297787 · Comisiones: 0,00002213 btc")
    })

    it("sin comisiones el pie solo da el total", async () => {
        const pie = buildAssetTodosOrigenPie(ACTIVO, await buildAssetTodosOrigenPartes(ACTIVO))

        expect(pie).toBe("Total: 0,003")
    })

    it("descuenta la comisión de red y coincide con la cantidad", async () => {
        fijarTransacciones([entreWallets])

        const partes = await buildAssetTodosOrigenPartes(ACTIVO)
        const resumen = await buildOverviewRow(ACTIVO)

        expect(totalDe(partes)).toBeCloseTo(resumen.participaciones, 12)
    })

    it("descuenta también las ventas, por FIFO", async () => {
        fijarVentas([{ assetId: "bitcoin", fecha: "02-11-2026", cantidad: "0.0005" }])

        const partes = await buildAssetTodosOrigenPartes(ACTIVO)

        expect(totalDe(partes)).toBeCloseTo(0.0025, 12)
    })

    it("lo recibido por transacción va en su propia porción", async () => {
        fijarTransacciones([{ ...entreWallets, walletTipo: "recibida", total: "0.001", comisionRed: "" }])

        const partes = await buildAssetTodosOrigenPartes(ACTIVO)

        expect(partes.find((parte) => parte.etiqueta === "Recibidas").valor).toBeCloseTo(0.001, 12)
        expect(partes.find((parte) => parte.etiqueta === "Recibidas").color).toBe("#d9a520")
        expect(partes.find((parte) => parte.etiqueta === "Conversiones").valor).toBe(0)
        expect(totalDe(partes)).toBeCloseTo(0.004, 12)
    })

    it("lo convertido va en una porción distinta de lo recibido", async () => {
        fijarTransacciones([{ ...entreWallets, walletTipo: "recibida", total: "0.001", comisionRed: "" }])
        const conversion = { fecha: "03-11-2026", par: "BTC/ETH", tipo: "Convertidos a BTC", cantidad: "0.0005" }

        const partes = await buildAssetTodosOrigenPartes({ ...ACTIVO, conversionRows: [conversion] })

        expect(partes.find((parte) => parte.etiqueta === "Recibidas").valor).toBeCloseTo(0.001, 12)
        expect(partes.find((parte) => parte.etiqueta === "Conversiones").valor).toBeCloseTo(0.0005, 12)
        expect(totalDe(partes)).toBeCloseTo(0.0045, 12)
    })
})

describe("filas de la pestaña Todos", () => {
    it("incluye la transacción, con la comisión en cripto y sin importe", () => {
        fijarTransacciones([entreWallets])

        const filas = buildAssetTodosRows(ACTIVO)
        const fila = filas.find((candidata) => candidata.origen === "transaccion")

        expect(filas).toHaveLength(3)
        expect(fila.tipo).toBe("Entre wallet")
        expect(fila.importe).toBe("")
        expect(fila.comisiones).toContain("btc")
    })

    it("una transacción sin comisión deja la celda vacía", () => {
        fijarTransacciones([{ ...entreWallets, comisionRed: "" }])

        const fila = buildAssetTodosRows(ACTIVO).find((candidata) => candidata.origen === "transaccion")

        expect(fila.comisiones).toBe("")
    })

    const origenVisibleDe = (transaccion) => {
        fijarTransacciones([transaccion])
        return buildAssetTodosRows(ACTIVO).find((candidata) => candidata.origen === "transaccion").origenVisible
    }

    it("lo recibido se rotula como recibida", () => {
        expect(origenVisibleDe({ ...entreWallets, walletTipo: "recibida", comisionRed: "" })).toBe("recibida")
        expect(ASSET_TODOS_ORIGENES.recibida.etiqueta).toBe("Recibida")
    })

    it("un movimiento entre wallets con comisión se rotula como comisión de transacción", () => {
        expect(origenVisibleDe(entreWallets)).toBe("comisionTransaccion")
        expect(ASSET_TODOS_ORIGENES.comisionTransaccion.etiqueta).toBe("Com. transacción")
    })

    it("un movimiento entre wallets sin comisión sigue siendo una transacción", () => {
        expect(origenVisibleDe({ ...entreWallets, comisionRed: "" })).toBe("transaccion")
        expect(origenVisibleDe({ ...entreWallets, comisionRed: "0" })).toBe("transaccion")
    })

    // La cantidad enviada sale de la cartera: la comisión no es lo principal de la fila.
    it("un envío con comisión sigue siendo una transacción", () => {
        expect(origenVisibleDe({ ...entreWallets, walletTipo: "enviada" })).toBe("transaccion")
    })
})
