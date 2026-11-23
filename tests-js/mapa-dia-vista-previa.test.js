// Vista previa de velas de los mapas de calor (js/core/mapa-dia.js).
//
// Sustituye al gráfico incrustado de TradingView, que en bolsas como Xetra solo
// daba datos al cierre del día. Se comprueba que pinta la vela de hoy con su
// OHLC y su variación, que no pide dos veces las mismas velas, que cruzar
// baldosas de pasada no pide nada y que una respuesta tardía no pisa la vista
// previa de otro símbolo. Va en un fichero aparte porque la caché de velas es
// estado del módulo.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { cargarScript } from "./cargar.js"

// Viernes: cierre 124,32. Hoy: abre 131,70 y va por 149,28 (+20,08 %).
const VELAS = [
    [1_800_000_000, 139.32, 143.82, 123.4, 124.32],
    [1_800_259_200, 131.7, 150.94, 122.14, 149.28]
]

let pedidos = []

beforeAll(() => {
    window.escapeAttr = (s) => String(s)
    cargarScript("js/core/i18n.js")
    cargarScript("js/core/mapa-dia.js")
})

beforeEach(() => {
    pedidos = []
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url) => {
            const simbolo = new URL(url, "http://x").searchParams.get("symbol")
            pedidos.push(simbolo)
            const velas = simbolo === "FOO:NADA" ? [] : VELAS
            return { ok: true, json: async () => ({ ok: true, simbolo, divisa: velas.length ? "EUR" : null, velas }) }
        })
    )
})

afterEach(() => {
    vi.useRealTimers()
    mapaDiaOcultarTv()
})

function baldosa() {
    const celda = document.createElement("div")
    document.body.appendChild(celda)
    return celda
}

function caja() {
    return document.getElementById("mapaDiaTv")
}

/** Pasa el ratón por una baldosa, deja correr el retardo y espera a las velas. */
async function pasar(simbolo) {
    vi.useFakeTimers()
    mapaDiaMostrarTv(baldosa(), simbolo)
    vi.advanceTimersByTime(1000)
    vi.useRealTimers()
    await new Promise((r) => setTimeout(r, 0))
}

describe("vista previa de velas", () => {
    it("pinta las velas con el OHLC de hoy y la variación sobre el cierre anterior", async () => {
        await pasar("XETR:NVD")

        expect(caja().classList.contains("mapaDiaTvVisible")).toBe(true)
        expect(caja().querySelector(".mapaDiaTvSimbolo").textContent).toBe("XETR:NVD · EUR")
        const ohlc = caja().querySelector(".mapaDiaTvOhlc").textContent
        expect(ohlc).toContain("149,28")
        expect(ohlc).toContain("+20,08 %")
        expect(caja().querySelectorAll(".mapaDiaTvSvg g.mapaDiaTvSube, .mapaDiaTvSvg g.mapaDiaTvBaja")).toHaveLength(
            VELAS.length
        )
        expect(caja().querySelector("iframe")).toBeNull()
    })

    it("volver a un símbolo ya visto no vuelve a pedir sus velas", async () => {
        await pasar("XETR:SAP")
        mapaDiaOcultarTv()
        await pasar("XETR:SAP")

        expect(pedidos).toEqual(["XETR:SAP"])
    })

    it("sin velas avisa en vez de dibujar", async () => {
        await pasar("FOO:NADA")

        expect(caja().querySelector(".mapaDiaTvSvg")).toBeNull()
        expect(caja().querySelector(".mapaDiaTvAviso").textContent).toBe("Sin velas para este símbolo")
    })

    it("el símbolo va como texto, no como HTML", async () => {
        await pasar("<img src=x>")

        expect(caja().querySelector("img")).toBeNull()
    })

    it("cruzar baldosas de pasada no pide nada", () => {
        vi.useFakeTimers()
        mapaDiaMostrarTv(baldosa(), "NYSE:PASO1")
        vi.advanceTimersByTime(50)
        mapaDiaMostrarTv(baldosa(), "NYSE:PASO2")
        vi.advanceTimersByTime(50)
        mapaDiaOcultarTv()
        vi.advanceTimersByTime(1000)

        expect(pedidos).toEqual([])
    })

    it("una respuesta tardía no pisa la vista previa de otro símbolo", async () => {
        let soltar
        fetch.mockImplementationOnce(
            (url) =>
                new Promise((r) => {
                    soltar = () =>
                        r({
                            ok: true,
                            json: async () => ({ ok: true, simbolo: "NYSE:LENTO", divisa: "USD", velas: VELAS })
                        })
                })
        )
        await pasar("NYSE:LENTO")
        expect(caja().querySelector(".mapaDiaTvAviso").textContent).toBe("Cargando velas…")
        mapaDiaOcultarTv()
        await pasar("NYSE:RAPIDO")
        soltar()
        await new Promise((r) => setTimeout(r, 0))

        expect(caja().querySelector(".mapaDiaTvSimbolo").textContent).toBe("NYSE:RAPIDO · EUR")
    })

    it("el precalentado pide las velas de un símbolo una sola vez", () => {
        vi.useFakeTimers()
        delete window.requestIdleCallback

        mapaDiaPrecalentarTv("NASDAQ:AAPL")
        vi.advanceTimersByTime(2000)
        mapaDiaPrecalentarTv("NASDAQ:AAPL")
        vi.advanceTimersByTime(2000)

        expect(pedidos).toEqual(["NASDAQ:AAPL"])
    })
})

describe("mapaDiaMarcasPrecio", () => {
    it("da valores redondos dentro del rango", () => {
        expect(mapaDiaMarcasPrecio(118, 162)).toEqual([120, 130, 140, 150, 160])
    })
})
