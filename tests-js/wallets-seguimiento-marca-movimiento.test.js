// Detalle de un movimiento: una transacción se marca «entre mis wallets» para que
// lo comprado en un exchange y pasado a la wallet no cuente dos veces. La comisión
// se propone donde la de la red sirve (no en Bitcoin ni en tokens).
import { beforeAll, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

const PROPIA_ETH = { id: "w-eth", red: "eth", propia: true }
const PROPIA_BTC = { id: "w-btc", red: "btc", propia: true }
const AJENA = { id: "w-otra", red: "eth", propia: false }
const RECIBIDA = { hash: "0xabc", simbolo: "ETH", tipo: "recibida", sentido: "recibida", comision: "", comisionLeida: "", comisionTx: "0.00002" }

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cripto/wallets.js")
    cargarScript("js/cripto/wallets-seguimiento.js")
})

describe("direcciones de la marca", () => {
    const MOV = { ...RECIBIDA, propia: "0xmia", contraparte: "0xotra" }

    it("«Entre mis wallets» da por propias las dos direcciones", () => {
        expect(window.walletsSegDireccionesDeMarca(MOV, true, true)).toEqual(["0xmia", "0xotra"])
    })

    it("con la casilla desmarcada no incluye la otra", () => {
        expect(window.walletsSegDireccionesDeMarca(MOV, true, false)).toEqual(["0xmia"])
    })

    it("marcar como recibida o quitar la marca no da ninguna", () => {
        expect(window.walletsSegDireccionesDeMarca(MOV, false, true)).toEqual([])
        expect(window.walletsSegDireccionesDeMarca(MOV, null, true)).toEqual([])
    })

    it("la casilla sale marcada salvo si la marca ya se hizo sin la otra", () => {
        const html = (mov) => window.walletsSegMarcaMovimientoHtml(mov, PROPIA_ETH)
        expect(html(MOV)).toMatch(/walletsSegMarcaMovOtra" checked/)
        expect(html({ ...MOV, marcaMovimiento: "propia" })).not.toMatch(/walletsSegMarcaMovOtra" checked/)
        expect(html({ ...MOV, marcaMovimiento: "propia", contraparteMarca: "propia" })).toMatch(/walletsSegMarcaMovOtra" checked/)
    })

    it("sin casilla si la otra ya es de una wallet enlazada", () => {
        const html = window.walletsSegMarcaMovimientoHtml({ ...MOV, contraparteEnlazada: true }, PROPIA_ETH)
        expect(html).not.toContain("walletsSegMarcaMovOtra")
    })
})

describe("comisión propuesta", () => {
    it("en ETH propone la de la red aunque la pagara el exchange", () => {
        expect(window.walletsSegComisionPropuesta(RECIBIDA, PROPIA_ETH)).toBe("0.00002")
    })

    it("en BTC sale vacía: es la de todo el lote del exchange", () => {
        expect(window.walletsSegComisionPropuesta({ ...RECIBIDA, simbolo: "BTC" }, PROPIA_BTC)).toBe("")
    })

    it("en BTC la propone si el origen también es tuyo", () => {
        expect(window.walletsSegComisionPropuesta({ ...RECIBIDA, simbolo: "BTC", contraparteMarca: "propia" }, PROPIA_BTC)).toBe("0.00002")
    })

    it("en BTC con varios orígenes no la propone: puede haber alguno ajeno", () => {
        const mov = { ...RECIBIDA, simbolo: "BTC", contraparteMarca: "propia", contrapartes: ["bc1a", "bc1b"] }
        expect(window.walletsSegComisionPropuesta(mov, PROPIA_BTC)).toBe("")
    })

    it("en un token sale vacía: la de la red se paga en otra moneda", () => {
        expect(window.walletsSegComisionPropuesta({ ...RECIBIDA, simbolo: "USDC", contrato: "0xusdc" }, PROPIA_ETH)).toBe("")
    })

    it("respeta la que el usuario ya puso y la que pagó esta wallet", () => {
        expect(window.walletsSegComisionPropuesta({ ...RECIBIDA, comisionMarcada: "0.0005" }, PROPIA_ETH)).toBe("0.0005")
        expect(window.walletsSegComisionPropuesta({ ...RECIBIDA, comisionLeida: "0.001" }, PROPIA_BTC)).toBe("0.001")
    })
})

describe("quién pagó la comisión", () => {
    const nota = (cambios) => window.walletsSegComisionDetalle({ ...RECIBIDA, ...cambios }, "BTC").nota

    it("entre wallets con origen propio la pagaste tú", () => {
        expect(nota({ tipo: "entre_wallet", comision: "0.00002", contraparteMarca: "propia" })).toContain("Pagada por ti")
        expect(nota({ tipo: "entre_wallet", comisionMarcada: "0.00002", contraparteMarca: "propia" })).toContain("Pagada por ti")
    })

    it("marcada sin el origen (un exchange) no se atribuye al usuario", () => {
        expect(nota({ tipo: "entre_wallet" })).toBe("Pagada en el origen; no se descuenta de la posición")
    })

    it("un recibo de un tercero la pagó el remitente", () => {
        expect(nota({})).toContain("Pagada por el remitente")
    })

    it("un envío la pagó esta wallet", () => {
        expect(nota({ tipo: "enviada", sentido: "enviada", comision: "0.001" })).toBe("Pagada por esta wallet")
    })

    it("la comisión escrita a mano se distingue", () => {
        expect(nota({ tipo: "entre_wallet", comisionMarcada: "0.5" })).toContain("Indicada por ti")
    })

    it("sin datos de la red no inventa nada", () => {
        expect(window.walletsSegComisionDetalle({ tipo: "recibida" }, "BTC")).toEqual({ importe: "", nota: "" })
    })

    it("repintar al marcar conserva la comisión si el origen es tuyo y la quita si es ajena", () => {
        const mov = { ...RECIBIDA, contraparteMarca: "propia" }

        window.walletsSegConMarca(mov, { propia: true, comision: "" })
        expect(mov.comision).toBe("0.00002")

        window.walletsSegConMarca(mov, { propia: false, comision: "" })
        expect(mov.comision).toBe("")
    })
})

describe("comisión del exchange", () => {
    const html = (cambios = {}, wallet = PROPIA_BTC) =>
        window.walletsSegComisionExchangeHtml({ ...RECIBIDA, simbolo: "BTC", propia: "bc1mia", contraparte: "bc1otra", ...cambios }, wallet)

    it("sale en los recibos de una wallet propia", () => {
        expect(html()).toContain("Comisión del exchange")
        expect(html()).toContain("Aplicar comisión")
    })

    it("no sale en un envío ni en una wallet ajena", () => {
        expect(html({ tipo: "enviada", sentido: "enviada" })).toBe("")
        expect(html({}, AJENA)).toBe("")
    })

    it("avisa si el origen sigue marcado como tuyo, salvo que sea una wallet enlazada", () => {
        expect(html({ contraparteMarca: "propia" })).toContain("marcada como tuya")
        expect(html({ contraparteMarca: "propia", contraparteEnlazada: true })).not.toContain("marcada como tuya")
        expect(html()).not.toContain("marcada como tuya")
    })

    it("en un recibo solo hay un campo de comisión, el de este apartado", () => {
        const mov = { ...RECIBIDA, simbolo: "BTC", contraparte: "bc1otra" }
        const conjunto = window.walletsSegComisionExchangeHtml(mov, PROPIA_BTC) + window.walletsSegMarcaMovimientoHtml(mov, PROPIA_BTC)
        expect(conjunto.match(/walletsSegMarcaMovComision/g)).toHaveLength(1)
    })

    it("un envío conserva su campo en la clasificación", () => {
        const html = window.walletsSegMarcaMovimientoHtml({ ...RECIBIDA, tipo: "enviada", sentido: "enviada" }, PROPIA_ETH)
        expect(html).toContain("Comisión a descontar")
    })

    it("una cantidad distinta de la de red se presenta como indicada por ti aunque el origen sea tuyo", () => {
        const { importe, nota } = window.walletsSegComisionDetalle(
            { ...RECIBIDA, tipo: "entre_wallet", simbolo: "BTC", comisionTx: "0.00000413", comisionMarcada: "0.000018", contraparteMarca: "propia" },
            "BTC"
        )
        expect(importe).toBe("0,000018 BTC")
        expect(nota).toContain("Indicada por ti")
    })
})

describe("ventana del movimiento", () => {
    it("enseña origen y destino con su dueño, y el importe en la cabecera", () => {
        const mov = { ...RECIBIDA, tipo: "entre_wallet", cantidad: "0.5", propia: "bc1mia", contraparte: "bc1otra", contraparteMarca: "propia", contraparteApodo: "Fría" }
        const html = window.walletsSegMovResumenHtml(mov, { ...PROPIA_BTC, alias: "Trezor" })

        expect(html).toContain("Entre direcciones propias")
        expect(html).toContain("0,5 ETH")
        expect(html.indexOf("bc1otra")).toBeLessThan(html.indexOf("bc1mia"))
        expect(html).toContain("Fría")
        expect(html).toContain("Trezor")
        expect(html).toContain("Esta wallet")
    })

    it("escapa lo que viene de fuera", () => {
        const mov = { ...RECIBIDA, cantidad: "1", simbolo: "<b>X", propia: "a", contraparte: "b", contraparteApodo: "<i>y" }
        const html = window.walletsSegMovResumenHtml(mov, PROPIA_ETH)

        expect(html).not.toContain("<b>X")
        expect(html).not.toContain("<i>y")
    })
})

describe("sección de la transacción", () => {
    it("no sale en una wallet ajena ni en un movimiento entre sus direcciones", () => {
        expect(window.walletsSegMarcaMovimientoHtml(RECIBIDA, AJENA)).toBe("")
        expect(window.walletsSegMarcaMovimientoHtml({ ...RECIBIDA, tipo: "entre_wallet", sentido: "entre_wallet" }, PROPIA_ETH)).toBe("")
    })

    it("ofrece entre mis wallets o lo que leyó la red", () => {
        const html = window.walletsSegMarcaMovimientoHtml(RECIBIDA, PROPIA_ETH)
        expect(html).toContain("Entre mis wallets")
        expect(html).toContain("Recibida")
        expect(html).not.toContain("Quitar marca")
    })

    it("con marca se puede quitar", () => {
        expect(window.walletsSegMarcaMovimientoHtml({ ...RECIBIDA, marcaMovimiento: "propia" }, PROPIA_ETH)).toContain("Quitar marca")
    })

    it("en Bitcoin avisa del cambio", () => {
        expect(window.walletsSegMarcaMovimientoHtml({ ...RECIBIDA, simbolo: "BTC" }, PROPIA_BTC)).toContain("xpub")
        expect(window.walletsSegMarcaMovimientoHtml(RECIBIDA, PROPIA_ETH)).not.toContain("xpub")
    })
})

describe("aplicar la marca", () => {
    it("entre mis wallets cambia el tipo y la comisión, y se deshace", () => {
        const mov = { ...RECIBIDA }

        window.walletsSegConMarca(mov, { propia: true, comision: "0.0005" })
        expect([mov.tipo, mov.sentido, mov.comision]).toEqual(["entre_wallet", "recibida", "0.0005"])

        window.walletsSegConMarca(mov, null)
        expect([mov.tipo, mov.comision, mov.marcaMovimiento]).toEqual(["recibida", "", ""])
    })

    it("la marca manda sobre la de su dirección", () => {
        const mov = { ...RECIBIDA, tipo: "entre_wallet", contraparteMarca: "propia" }

        window.walletsSegConMarca(mov, { propia: false, comision: "" })
        expect(mov.tipo).toBe("recibida")

        window.walletsSegConMarca(mov, null)
        expect(mov.tipo).toBe("entre_wallet")
    })
})

describe("entradas por verificar", () => {
    const PENDIENTE = { ...RECIBIDA, pendiente: true }

    it("una entrada pendiente se nombra como tal y pide elegir", () => {
        expect(window.walletsSegTextoTipo(PENDIENTE)).toBe("Pendiente de verificar")
        const html = window.walletsSegMarcaMovimientoHtml(PENDIENTE, PROPIA_ETH)
        expect(html).toContain("Pendiente de verificar")
        expect(html).toContain("Entrada real")
        expect(html).toContain("Entre mis wallets")
    })

    it("sin estar pendiente conserva su nombre", () => {
        expect(window.walletsSegTextoTipo(RECIBIDA)).toBe("Recibida")
        expect(window.walletsSegMarcaMovimientoHtml(RECIBIDA, PROPIA_ETH)).not.toContain("Pendiente de verificar")
    })

    it("deja de estar pendiente si su origen pasa a ser una dirección propia", () => {
        expect(window.walletsSegEsPendiente({ ...PENDIENTE, tipo: "entre_wallet" })).toBe(false)
    })

    it("marcarla es verificarla", () => {
        const mov = { ...PENDIENTE }

        window.walletsSegConMarca(mov, { propia: false, comision: "" })

        expect(mov.pendiente).toBe(false)
        expect(mov.tipo).toBe("recibida")
    })

    it("la tarjeta cuenta las pendientes y no las imitaciones", () => {
        const alertas = window.walletsSegAlertasLectura([{ red: "eth", recientes: [PENDIENTE, { ...PENDIENTE, hash: "0xdef" }, RECIBIDA] }])

        expect(alertas.join(" ")).toContain("2 entradas de dinero por verificar")
        expect(window.walletsSegAlertasLectura([{ red: "eth", recientes: [RECIBIDA] }])).toEqual([])
    })

    it("el aviso de la marca dice si se ha importado o falta sincronizar", () => {
        expect(window.walletsSegTextoMarcada({ importadas: 1 })).toContain("importada")
        expect(window.walletsSegTextoMarcada({ porSincronizar: true })).toContain("Sincronizar")
        expect(window.walletsSegTextoMarcada({})).toBe("Transacción marcada")
    })

    it("el resumen de sincronizar cuenta las que quedan por verificar", () => {
        const texto = window.walletsResumenSincronizacion({ anadidas: 0, pendientes: 2 })

        expect(texto).toContain("2 entradas por verificar")
    })
})
