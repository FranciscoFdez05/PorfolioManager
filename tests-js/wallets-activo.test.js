// Wallets desde Nuevo y Editar activo: siempre propias y asociadas al activo. Lo
// delicado es no crear nada si una línea no vale y no dejar lo pegado en la página.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runInThisContext } from "node:vm"

import { cargarScript } from "./cargar.js"

const global = (expresion) => runInThisContext(expresion)

const REDES = [
    { clave: "btc", nombre: "Bitcoin", simbolo: "BTC", admiteXpub: true, admiteClavePublica: true },
    { clave: "eth", nombre: "Ethereum", simbolo: "ETH", admiteXpub: false, admiteClavePublica: true },
    { clave: "bnb", nombre: "BNB Smart Chain", simbolo: "BNB", admiteXpub: false, admiteClavePublica: true },
    { clave: "sol", nombre: "Solana", simbolo: "SOL", admiteXpub: false, admiteClavePublica: false }
]
const LEDGER = {
    id: "w-1",
    alias: "Bitcoin",
    red: "btc",
    tipo: "xpub",
    valorEnmascarado: "zpub6rFR…tZYs",
    assetId: "bitcoin",
    propia: true,
    seguimiento: "Ledger",
    seguimientoClave: "ledger"
}
const AJENA = {
    ...LEDGER,
    id: "w-2",
    alias: "Ballena",
    propia: false,
    seguimiento: "Ballena",
    seguimientoClave: "ballena"
}

function respuesta(cuerpo, status = 200) {
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(cuerpo) })
}

// Simula el servidor y deja en `llamadas` lo que se le ha mandado.
function servidor({
    wallets = [],
    cifradoDisponible = true,
    errores = [],
    fallaAlta = false,
    hayClaveEtherscan = true
} = {}) {
    const llamadas = []
    window.fetch = vi.fn((url, opciones) => {
        const cuerpo = opciones?.body ? JSON.parse(opciones.body) : null
        llamadas.push({ url, cuerpo })
        if (url === "/api/wallets" && !cuerpo) {
            return respuesta({ wallets, redes: REDES, cifradoDisponible, hayClaveEtherscan })
        }
        if (url === "/api/wallets/validar-propias") return respuesta({ ok: true, errores })
        if (url === "/api/wallets" && fallaAlta)
            return respuesta({ ok: false, error: "Esa wallet ya está enlazada" }, 400)
        if (url === "/api/wallets")
            return respuesta({ ok: true, wallet: { id: `n-${llamadas.length}`, red: cuerpo.red } })
        return respuesta({ ok: true })
    })
    return llamadas
}

function escribir(indice, valor) {
    document.querySelectorAll("#bloque .walletsFilaValor")[indice].value = valor
}

const altas = (llamadas) => llamadas.filter((l) => l.url === "/api/wallets" && l.cuerpo)

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cripto/wallets.js")
    cargarScript("js/cartera/assets-wallets.js")
})

beforeEach(() => {
    document.body.innerHTML = `<div id="bloque" class="walletsActivoBloque"></div>`
    window.showToast = vi.fn()
    runInThisContext("showToast = window.showToast")
})

describe("walletsActivoRedSugerida", () => {
    const sugerida = (nombre, ticker = "") => window.walletsActivoRedSugerida(REDES, nombre, ticker)

    it.each([
        ["Bitcoin", "", "btc"],
        ["ethereum", "", "eth"],
        ["BNB", "", "bnb"],
        ["BNB Smart Chain", "", "bnb"],
        ["Mi cripto", "BINANCE:BTCUSDT", "btc"],
        ["Mi cripto", "BTC-USD", "btc"],
        ["Mi cripto", "ETHEUR", "eth"],
        ["Mi cripto", "SOL", "sol"]
    ])("%s con ticker «%s» es %s", (nombre, ticker, clave) => {
        expect(sugerida(nombre, ticker)).toBe(clave)
    })

    it.each([
        ["Tether", "USDTUSD"],
        ["Solv", "BINANCE:SOLVUSDT"],
        ["", ""]
    ])("%s con ticker «%s» no tiene red clara", (nombre, ticker) => {
        expect(sugerida(nombre, ticker)).toBe("")
    })
})

describe("walletsActivoAbrir", () => {
    it("pinta las líneas sin selector de cripto ni de dueño, con la red del activo", async () => {
        servidor()
        await window.walletsActivoAbrir("bloque", { nombre: "Ethereum" })

        expect(document.querySelector("#bloque .walletsFilaActivo")).toBeNull()
        expect(document.querySelector("#bloque #walletsPropia")).toBeNull()
        expect(document.querySelector("#bloque .walletsFilaRed").value).toBe("eth")
    })

    it("al editar enseña solo las propias de este activo, enmascaradas, y hereda su seguimiento", async () => {
        servidor({ wallets: [LEDGER, AJENA, { ...LEDGER, id: "w-3", assetId: "otro", alias: "Otra" }] })
        await window.walletsActivoAbrir("bloque", { assetId: "bitcoin", nombre: "Bitcoin" })

        const filas = document.querySelectorAll("#bloque .walletsActivoLista li")
        expect(filas).toHaveLength(1)
        expect(filas[0].textContent).toContain("zpub6rFR…tZYs")
        expect(document.querySelector("#bloque .walletsActivoSeguimiento").value).toBe("Ledger")
        expect(document.querySelector("#bloque details").open).toBe(true)
    })

    it("sin SECRET_KEY avisa y no ofrece el formulario", async () => {
        servidor({ cifradoDisponible: false })
        await window.walletsActivoAbrir("bloque")

        expect(document.querySelector("#bloque .walletsFila")).toBeNull()
        expect(document.getElementById("bloque").textContent).toContain("SECRET_KEY")
    })

    it("si no carga, lo dice sin lanzar: el activo se puede crear igual", async () => {
        window.fetch = vi.fn(() => respuesta({ ok: false, error: "fallo" }, 500))
        await expect(window.walletsActivoAbrir("bloque")).resolves.toBeUndefined()

        expect(document.getElementById("bloque").textContent).toContain("Seguimiento")
    })

    it("una respuesta tardía no repinta un modal ya cerrado", async () => {
        servidor()
        const carga = window.walletsActivoAbrir("bloque")
        window.walletsActivoVaciar("bloque")
        await carga

        expect(document.getElementById("bloque").innerHTML).toBe("")
    })
})

describe("walletsActivoProponerRed", () => {
    it("no pisa la red que ha elegido el usuario", async () => {
        servidor()
        await window.walletsActivoAbrir("bloque")
        const red = document.querySelector("#bloque .walletsFilaRed")
        red.value = "sol"
        red.dispatchEvent(new Event("change", { bubbles: true }))

        window.walletsActivoProponerRed("bloque", "Ethereum", "")

        expect(red.value).toBe("sol")
    })

    it("cambia la propuesta mientras no se haya elegido", async () => {
        servidor()
        await window.walletsActivoAbrir("bloque")

        window.walletsActivoProponerRed("bloque", "Bitcoin", "")
        window.walletsActivoProponerRed("bloque", "Solana", "")

        expect(document.querySelector("#bloque .walletsFilaRed").value).toBe("sol")
    })
})

describe("walletsActivoValidar", () => {
    it("sin líneas escritas no llama al servidor", async () => {
        const llamadas = servidor()
        await window.walletsActivoAbrir("bloque")
        llamadas.length = 0

        expect(await window.walletsActivoValidar("bloque", "Bitcoin")).toBe(true)
        expect(llamadas).toEqual([])
    })

    it("oculto (el activo ya no es cripto) ignora lo escrito", async () => {
        const llamadas = servidor()
        await window.walletsActivoAbrir("bloque")
        escribir(0, "algo")
        window.walletsActivoMostrar("bloque", false)
        llamadas.length = 0

        expect(await window.walletsActivoValidar("bloque", "Apple")).toBe(true)
        expect(llamadas).toEqual([])
    })

    it("marca el error en su línea, despliega el bloque y conserva lo pegado para corregirlo", async () => {
        servidor({ errores: [{ indice: 0, error: "No vale" }] })
        await window.walletsActivoAbrir("bloque")
        escribir(0, "malo")

        expect(await window.walletsActivoValidar("bloque", "Bitcoin")).toBe(false)
        expect(document.querySelector("#bloque .walletsFilaError").textContent).toBe("No vale")
        expect(document.querySelector("#bloque details").open).toBe(true)
        expect(document.querySelector("#bloque .walletsFilaValor").value).toBe("malo")
    })

    it("si el servidor falla no deja seguir", async () => {
        servidor()
        await window.walletsActivoAbrir("bloque")
        escribir(0, "algo")
        window.fetch = vi.fn(() => respuesta({ ok: false, error: "SECRET_KEY" }, 409))

        expect(await window.walletsActivoValidar("bloque", "Bitcoin")).toBe(false)
        expect(window.showToast).toHaveBeenCalled()
    })
})

describe("walletsActivoEnlazar", () => {
    it("enlaza cada línea como propia, con el activo y el seguimiento del activo", async () => {
        const llamadas = servidor()
        await window.walletsActivoAbrir("bloque", { nombre: "Bitcoin" })
        window.walletsActivoAnadirFila(document.getElementById("bloque"))
        escribir(0, "direccion-1")
        escribir(1, "direccion-2")

        await window.walletsActivoEnlazar("bloque", "bitcoin", "Bitcoin")

        expect(altas(llamadas).map((l) => l.cuerpo)).toEqual([
            expect.objectContaining({
                valor: "direccion-1",
                assetId: "bitcoin",
                propia: true,
                seguimiento: "Bitcoin",
                alias: "Bitcoin",
                red: "btc"
            }),
            expect.objectContaining({
                valor: "direccion-2",
                assetId: "bitcoin",
                propia: true,
                seguimiento: "Bitcoin",
                alias: "Bitcoin 2",
                red: "btc"
            })
        ])
    })

    it("vacía los campos en cuanto envía: un segundo Confirmar no repite el alta", async () => {
        const llamadas = servidor()
        await window.walletsActivoAbrir("bloque")
        escribir(0, "direccion-1")

        await Promise.all([
            window.walletsActivoEnlazar("bloque", "bitcoin", "Bitcoin"),
            window.walletsActivoEnlazar("bloque", "bitcoin", "Bitcoin")
        ])

        expect(altas(llamadas)).toHaveLength(1)
        expect(document.querySelector("#bloque .walletsFilaValor").value).toBe("")
    })

    it("un fallo se avisa y no lanza: el activo ya está guardado", async () => {
        servidor({ fallaAlta: true })
        await window.walletsActivoAbrir("bloque")
        escribir(0, "direccion-1")

        await expect(window.walletsActivoEnlazar("bloque", "bitcoin", "Bitcoin")).resolves.toBeUndefined()

        expect(window.showToast.mock.calls[0][0]).toContain("Esa wallet ya está enlazada")
        expect(window.showToast.mock.calls[0][1].type).toBe("error")
    })

    it("la clave de Etherscan solo se pide y se manda si hace falta", async () => {
        const llamadas = servidor({ hayClaveEtherscan: false })
        await window.walletsActivoAbrir("bloque", { nombre: "Ethereum" })
        expect(document.querySelector("#bloque .walletsActivoEtherscan").classList.contains("hidden")).toBe(false)
        escribir(0, "0xabc")
        document.querySelector("#bloque .walletsActivoEtherscanValor").value = "clave"

        await window.walletsActivoEnlazar("bloque", "ethereum", "Ethereum")

        expect(llamadas.find((l) => l.url === "/api/wallets/etherscan").cuerpo).toEqual({ clave: "clave" })
    })
})

describe("walletsActivoVaciar", () => {
    it("no deja lo pegado en la página al cerrar", async () => {
        servidor()
        await window.walletsActivoAbrir("bloque")
        escribir(0, "direccion-1")

        window.walletsActivoVaciar("bloque")

        expect(document.getElementById("bloque").innerHTML).toBe("")
        expect(global("walletsActivoTurno")).toBeGreaterThan(0)
    })
})
