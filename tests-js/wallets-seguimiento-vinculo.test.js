// Libreta de Cripto › Seguimiento: una dirección «mía» se vincula a un seguimiento
// y una enlazada se mueve o vuelve a la libreta. Solo se sugieren los seguimientos
// propios: el servidor rechaza mezclar propias con ajenas.
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { runInThisContext } from "node:vm"

import { cargarScript } from "./cargar.js"

const global = (expresion) => runInThisContext(expresion)

const DIRECCION = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
const MANUAL_MIA = { red: "btc", apodo: "Fría", propia: true, enlazada: false, texto: DIRECCION, direccion: DIRECCION }
const MANUAL_AJENA = { ...MANUAL_MIA, propia: false }
const ENLAZADA = { red: "btc", apodo: "Ledger", propia: true, enlazada: true, walletId: "w-1", texto: "bc1q…f3t4" }

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cripto/wallets.js")
    cargarScript("js/cripto/wallets-seguimiento.js")
})

beforeEach(() => {
    const estado = global("walletsEstado")
    estado.redes = [{ clave: "btc", nombre: "Bitcoin", simbolo: "BTC" }]
    estado.wallets = [
        { id: "w-1", alias: "Ledger", red: "btc", seguimiento: "Ledger", seguimientoClave: "ledger", propia: true },
        { id: "w-2", alias: "Trezor", red: "btc", seguimiento: "Trezor", seguimientoClave: "trezor", propia: true },
        { id: "w-3", alias: "Ballena", red: "btc", seguimiento: "Ballena", seguimientoClave: "ballena", propia: false }
    ]
})

describe("acciones de la libreta", () => {
    it("solo una dirección mía se puede vincular", () => {
        expect(window.walletsSegDirAccionesHtml(MANUAL_MIA)).toContain("Vincular a seguimiento")
        expect(window.walletsSegDirAccionesHtml(MANUAL_AJENA)).not.toContain("Vincular a seguimiento")
    })

    it("una enlazada se puede ver, mover y sacar del seguimiento", () => {
        const html = window.walletsSegDirAccionesHtml(ENLAZADA)
        expect(html).toContain("Ver seguimiento")
        expect(html).toContain("Cambiar de seguimiento")
        expect(html).toContain("Sacar del seguimiento")
        expect(html).not.toContain("Vincular a seguimiento")
    })

    it("la clave de la fila distingue la dirección marcada de la wallet enlazada", () => {
        expect(window.walletsSegDirClaveVinculo(MANUAL_MIA)).toBe(`btc:${DIRECCION}`)
        expect(window.walletsSegDirClaveVinculo(ENLAZADA)).toBe("w-1")
    })
})

describe("seguimientos sugeridos", () => {
    it("no ofrece los de wallets ajenas", () => {
        const html = window.walletsSegDirSugerenciasHtml()
        expect(html).toContain('value="Ledger"')
        expect(html).toContain('value="Trezor"')
        expect(html).not.toContain("Ballena")
    })

    it("al mover no ofrece el seguimiento en el que ya está", () => {
        const html = window.walletsSegDirSugerenciasHtml("ledger")
        expect(html).not.toContain("Ledger")
        expect(html).toContain("Trezor")
    })
})

describe("formulario de vinculación", () => {
    it("pide la cripto al vincular una dirección marcada", () => {
        const html = window.walletsSegDirVinculoHtml(MANUAL_MIA)
        expect(html).toContain('name="assetId"')
        expect(html).toContain(`data-direccion="${DIRECCION}"`)
        expect(html).toContain("Vincular")
    })

    it("sacar del seguimiento pide la contraseña y no lleva la dirección", () => {
        const html = window.walletsSegDirSacarHtml(ENLAZADA)
        expect(html).toContain('type="password"')
        expect(html).toContain('name="currentPassword"')
        expect(html).not.toContain("data-direccion")
    })

    it("al mover una enlazada no pide la cripto ni lleva su dirección", () => {
        const html = window.walletsSegDirVinculoHtml(ENLAZADA)
        expect(html).not.toContain('name="assetId"')
        expect(html).toContain('data-wallet-id="w-1"')
        expect(html).not.toContain("data-direccion")
        expect(html).toContain("Mover")
    })
})
