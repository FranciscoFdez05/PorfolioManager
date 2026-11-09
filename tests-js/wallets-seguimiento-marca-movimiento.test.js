// Detalle de un movimiento: una transacción se marca «entre mis wallets» para que
// lo comprado en un exchange y pasado a la wallet no cuente dos veces. La comisión
// se propone donde la de la red sirve (no en Bitcoin ni en tokens).
import { runInThisContext } from "node:vm"

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarModulo, cargarScript } from "./cargar.js"

const PROPIA_ETH = { id: "w-eth", red: "eth", propia: true }
const PROPIA_BTC = { id: "w-btc", red: "btc", propia: true }
const AJENA = { id: "w-otra", red: "eth", propia: false }
const RECIBIDA = { hash: "0xabc", simbolo: "ETH", tipo: "recibida", sentido: "recibida", comision: "", comisionLeida: "", comisionTx: "0.00002" }

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cripto/wallets.js")
    cargarModulo("js/cripto/wallets-seguimiento.js")
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

    it("la casilla solo sale marcada si la otra dirección ya es propia", () => {
        const html = (mov) => window.walletsSegMarcaMovimientoHtml(mov, PROPIA_ETH)
        expect(html(MOV)).not.toMatch(/walletsSegMarcaMovOtra" checked/)
        expect(html({ ...MOV, contraparteMarca: "propia" })).toMatch(/walletsSegMarcaMovOtra" checked/)
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

    it("no pone pegas si el origen está marcado como tuyo: una dirección de exchange puede serlo", () => {
        const conOrigenPropio = html({ contraparteMarca: "propia" })
        expect(conOrigenPropio).toContain("Aplicar comisión")
        expect(conOrigenPropio).not.toContain("marcada como tuya")
    })

    it("la comisión de red se enseña fija y el campo del exchange sale vacío para escribir", () => {
        const conOrigenPropio = html({ contraparteMarca: "propia", comisionTx: "0.00000413" })
        expect(conOrigenPropio).toContain("Comisión de red")
        expect(conOrigenPropio).toContain("Va dentro del total del exchange")
        document.body.innerHTML = conOrigenPropio
        const campo = document.querySelector(".walletsSegMarcaMovComision")
        expect(campo.value).toBe("")
        expect(campo.readOnly).toBe(false)
        document.body.innerHTML = ""
    })

    it("el campo trae lo ya indicado del exchange, no el total", () => {
        document.body.innerHTML = html({ comisionMarcada: "0.00001413", comisionExchange: "0.00001" })
        expect(document.querySelector(".walletsSegMarcaMovComision").value).toBe("0.00001")
        document.body.innerHTML = ""
    })

    it("sin comisión aplicada el campo se escribe y el botón aplica", () => {
        document.body.innerHTML = html()
        expect(document.querySelector(".walletsSegMarcaMovComision").readOnly).toBe(false)
        expect(document.querySelector(".walletsSegComisionExchangeBtn").textContent).toBe("Aplicar comisión")
        expect(document.querySelector(".walletsSegComisionExchangeEditarBtn")).toBeNull()
        document.body.innerHTML = ""
    })

    it("una comisión aplicada queda fija y solo se ofrece editarla", () => {
        document.body.innerHTML = html({ comisionExchange: "0.000018" })
        expect(document.querySelector(".walletsSegMarcaMovComision").readOnly).toBe(true)
        expect(document.querySelector(".walletsSegComisionExchangeEditarBtn").textContent).toBe("Editar")
        expect(document.querySelector(".walletsSegComisionExchangeBtn")).toBeNull()
        document.body.innerHTML = ""
    })

    it("«Editar» abre el campo con su valor y vuelve a ofrecer aplicar", () => {
        document.body.innerHTML = `<div id="walletsSegMovOverlay">${html({ comisionExchange: "0.000018" })}</div>`

        window.editarComisionExchange()

        const campo = document.querySelector(".walletsSegMarcaMovComision")
        expect(campo.readOnly).toBe(false)
        expect(campo.value).toBe("0.000018")
        expect(document.activeElement).toBe(campo)
        expect(document.querySelector(".walletsSegComisionExchangeBtn").textContent).toBe("Aplicar comisión")
        expect(document.querySelector(".walletsSegComisionExchangeEditarBtn")).toBeNull()
        document.body.innerHTML = ""
    })

    it("en Bitcoin con origen ajeno la de red no se suma: es la de todo el lote", () => {
        expect(html()).toContain("no se suma")
    })

    it("sin comisión de red leída no enseña esa línea", () => {
        expect(html({ comisionTx: "" })).not.toContain("Comisión de red")
    })

    it("al marcar envía la de red como base y lo escrito como comisión del exchange", () => {
        const mov = { ...RECIBIDA, simbolo: "BTC", contraparte: "bc1otra", contraparteMarca: "propia" }
        expect(window.walletsSegComisionesDeMarca(mov, PROPIA_BTC, "0.00001", true)).toEqual({ comision: "0.00002", comisionExchange: "0.00001" })
    })

    it("con origen ajeno en Bitcoin la base va vacía, salvo si se marca también la otra dirección", () => {
        const mov = { ...RECIBIDA, simbolo: "BTC", contraparte: "bc1otra" }
        expect(window.walletsSegComisionesDeMarca(mov, PROPIA_BTC, "0.00001", false)).toEqual({ comision: "", comisionExchange: "0.00001" })
        expect(window.walletsSegComisionesDeMarca(mov, PROPIA_BTC, "0.00001", true).comision).toBe("0.00002")
    })

    it("un token no suma la de red, que se paga en otra moneda", () => {
        const mov = { ...RECIBIDA, simbolo: "USDC", contrato: "0xusdc" }
        expect(window.walletsSegComisionesDeMarca(mov, PROPIA_ETH, "2", false)).toEqual({ comision: "", comisionExchange: "2" })
    })

    it("un envío manda su campo como comisión, sin parte de exchange", () => {
        const mov = { ...RECIBIDA, tipo: "enviada", sentido: "enviada" }
        expect(window.walletsSegComisionesDeMarca(mov, PROPIA_ETH, "0.5", true)).toEqual({ comision: "0.5", comisionExchange: "" })
    })

    it.each(["", "   ", "0", "0,000", "abc", "-1", "Infinity"])("sin comisión previa no aplica %j", (valor) => {
        expect(window.walletsSegComisionExchangeEsAplicable(valor, RECIBIDA)).toBe(false)
    })

    it.each(["0.00000413", "0,000018", " 1 "])("aplica %j", (valor) => {
        expect(window.walletsSegComisionExchangeEsAplicable(valor, RECIBIDA)).toBe(true)
    })

    it("con una comisión previa, vaciar el campo la quita; un texto ilegible sigue sin valer", () => {
        const mov = { ...RECIBIDA, comisionExchange: "0.00001" }
        expect(window.walletsSegComisionExchangeEsAplicable("", mov)).toBe(true)
        expect(window.walletsSegComisionExchangeEsAplicable("abc", mov)).toBe(false)
    })

    it("el detalle enseña el total del exchange, con la de red dentro", () => {
        const { importe, nota } = window.walletsSegComisionDetalle(
            { ...RECIBIDA, tipo: "entre_wallet", simbolo: "BTC", comisionTx: "0.00000413", comisionMarcada: "0.00001", comisionExchange: "0.00001", contraparteMarca: "propia" },
            "BTC"
        )
        expect(importe).toBe("0,00001 BTC")
        expect(nota).toContain("Total del exchange")
    })

    it("reparte el total con decimales exactos: red + resto del exchange", () => {
        expect(window.walletsSegRestoDecimal("0.00035", "0.000011551996827")).toBe("0.000338448003173")
        expect(window.walletsSegRestoDecimal("0.00035", "0.000007553883834")).toBe("0.000342446116166")
        expect(window.walletsSegRestoDecimal("2", "1")).toBe("1")
    })

    it("no reparte si la de red supera el total o un valor no es un decimal", () => {
        expect(window.walletsSegRestoDecimal("0.00001", "0.00002")).toBe("")
        expect(window.walletsSegRestoDecimal("abc", "0.1")).toBe("")
    })

    it("el apartado enseña el resto y el total restado", () => {
        const apartado = window.walletsSegComisionExchangeHtml(
            { ...RECIBIDA, simbolo: "ETH", propia: "0xmia", contraparte: "0xotra", contraparteMarca: "propia", comisionTx: "0.000011551996827", comisionMarcada: "0.00035", comisionExchange: "0.00035" },
            PROPIA_ETH
        )
        expect(apartado).toContain("Resto del exchange: <strong>0,000338448003173")
        expect(apartado).toContain("Total restado: <strong>0,00035")
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

describe("casilla de la otra dirección", () => {
    const WALLET = { id: "w-sol", red: "sol", propia: true }
    const MOV_SOL = {
        hash: "tx1",
        simbolo: "SOL",
        tipo: "recibida",
        sentido: "recibida",
        comision: "",
        comisionLeida: "",
        comisionTx: "0.00001",
        propia: "Mia1",
        contraparte: "Otra1",
        contraparteClave: "Otra1",
        contraparteMarca: ""
    }
    const MARCA = { propia: true, comision: "0.00001", comisionExchange: "0.0064" }
    const respuesta = (efectiva) => ({ marca: MARCA, efectivas: { Otra1: efectiva } })
    const casilla = () => document.querySelector("#walletsSegMovOverlay .walletsSegMarcaMovOtra")
    const cuerpoEnviado = () => window.walletsPost.mock.calls[0][1]
    // Un movimiento fuera de los recientes, como los que Transacciones lee del historial.
    const abrir = (extra = {}) => {
        const mov = { ...MOV_SOL, ...extra }
        window.abrirMovimientoSeguimiento({ ...mov, walletId: WALLET.id })
    }
    const movAbierto = (extra = {}) => ({ ...MOV_SOL, walletId: WALLET.id, ...extra })

    beforeEach(() => {
        // Es un `let` del script: no cuelga de window.
        runInThisContext(`walletsEstado.wallets = ${JSON.stringify([WALLET])}`)
        window.showToast = vi.fn()
        window.walletsPost = vi.fn()
    })

    afterEach(() => {
        window.cerrarMovimientoSeguimiento()
    })

    it("«Aplicar comisión» respeta la casilla marcada", async () => {
        const mov = movAbierto()
        window.walletsPost.mockResolvedValue(respuesta({ apodo: "", marca: "propia", enlazada: false }))
        window.abrirMovimientoSeguimiento(mov)
        casilla().checked = true
        document.querySelector(".walletsSegMarcaMovComision").value = "0.0064"
        document.querySelector(".walletsSegComisionExchangeBtn").click()
        await vi.waitFor(() => expect(casilla().checked).toBe(true))

        expect(cuerpoEnviado().direcciones).toEqual(["Mia1", "Otra1"])
        expect(mov.contraparteMarca).toBe("propia")
    })

    it("«Aplicar comisión» con la casilla sin marcar no da de alta la otra dirección", async () => {
        window.walletsPost.mockResolvedValue({ marca: MARCA })
        abrir()
        document.querySelector(".walletsSegMarcaMovComision").value = "0.0064"
        document.querySelector(".walletsSegComisionExchangeBtn").click()
        await vi.waitFor(() => expect(window.walletsPost).toHaveBeenCalled())

        expect(cuerpoEnviado().direcciones).toEqual(["Mia1"])
    })

    it("en una transacción ya marcada, cambiarla se guarda sin pulsar nada más", async () => {
        const mov = movAbierto({ marcaMovimiento: "propia", comisionExchange: "0.0064", comisionMarcada: "0.0064" })
        window.walletsPost.mockResolvedValue(respuesta({ apodo: "", marca: "propia", enlazada: false }))
        window.abrirMovimientoSeguimiento(mov)
        document.querySelector(".walletsSegMarcaMovComision").value = "9"
        casilla().click()
        await vi.waitFor(() => expect(mov.contraparteMarca).toBe("propia"))

        expect(cuerpoEnviado().direcciones).toEqual(["Mia1", "Otra1"])
        expect(cuerpoEnviado().comisionExchange).toBe("0.0064")
        await vi.waitFor(() => expect(casilla().checked).toBe(true))
    })

    it("sin marca todavía, cambiarla no guarda nada", () => {
        abrir()
        casilla().click()

        expect(window.walletsPost).not.toHaveBeenCalled()
    })

    it("si el servidor rechaza el cambio, vuelve a como estaba", async () => {
        window.walletsPost.mockRejectedValue(new Error("fallo"))
        window.abrirMovimientoSeguimiento(movAbierto({ marcaMovimiento: "propia", comisionExchange: "0.0064" }))
        const elemento = casilla()
        elemento.click()
        await vi.waitFor(() => expect(elemento.disabled).toBe(false))

        expect(elemento.checked).toBe(false)
    })

    it("«Es mía» actualiza también el movimiento abierto fuera de los recientes", async () => {
        const mov = movAbierto()
        window.walletsPost.mockResolvedValue({ red: "sol", direccion: "Otra1", efectiva: { apodo: "", marca: "propia", enlazada: false } })
        window.abrirMovimientoSeguimiento(mov)
        document.querySelector('.walletsSegContraMarcarBtn[data-propia="true"]').click()
        await vi.waitFor(() => expect(casilla().checked).toBe(true))

        expect(mov.contraparteMarca).toBe("propia")
    })
})

describe("cierre de la ventana de detalle", () => {
    const abrir = () => {
        window.walletsSegMontarVentanaMovimiento(
            { titulo: "Detalle", tipo: "recibida", resumenHtml: "", datosHtml: "", seccionesHtml: "" },
            () => {}
        )
        return document.getElementById("walletsSegMovOverlay")
    }

    it("pinchar fuera de la ventana no la cierra", () => {
        abrir().click()

        expect(document.getElementById("walletsSegMovOverlay")).not.toBeNull()
        window.cerrarMovimientoSeguimiento()
    })

    it("el botón Cerrar la cierra", () => {
        abrir().querySelector(".walletsSegMovCerrarBtn").click()

        expect(document.getElementById("walletsSegMovOverlay")).toBeNull()
    })

    it("Escape la cierra", () => {
        abrir()
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))

        expect(document.getElementById("walletsSegMovOverlay")).toBeNull()
    })
})
