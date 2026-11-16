// Análisis técnico de la pestaña "Mercado": medidor, indicadores de calidad,
// recuentos de señales y popup de datos técnicos.
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/analisis/fundamentales.js")
    cargarScript("js/cartera/assets-mercado.js")
})

afterEach(() => {
    document.body.innerHTML = ""
})

const stats = {
    close: 100,
    currency: "EUR",
    "Recommend.All": -0.3,
    "Recommend.MA": -0.6,
    "Recommend.Other": 0.2,
    RSI: 25,
    "Stoch.K": 50,
    CCI20: 150,
    ADX: 30,
    AO: -1,
    Mom: 2,
    "MACD.macd": -3,
    "MACD.signal": -1,
    SMA20: 110,
    EMA20: 90,
    SMA50: 120,
    SMA200: 100,
    price_52_week_high: 150,
    price_52_week_low: 50,
    "BB.upper": 120,
    "BB.lower": 80,
    ATR: 2
}

describe("mkTecOsciladores y mkTecMedias", () => {
    it("aplica las zonas de cada oscilador", () => {
        const accion = Object.fromEntries(mkTecOsciladores(stats).map((f) => [f.nombre, f.accion]))

        expect(accion["Índice de fuerza relativa (14)"]).toBe("Compra")
        expect(accion["Estocástico %K (14, 3, 3)"]).toBe("Neutral")
        expect(accion["Índice del canal de materias primas (20)"]).toBe("Venta")
        expect(accion["Nivel MACD (12, 26)"]).toBe("Venta")
        expect(accion["Índice direccional medio (14)"]).toBeNull()
    })

    it("una media por encima del precio vende y por debajo compra", () => {
        const accion = Object.fromEntries(mkTecMedias(stats).map((f) => [f.nombre, f.accion]))

        expect(accion["Media móvil simple (20)"]).toBe("Venta")
        expect(accion["Media móvil exponencial (20)"]).toBe("Compra")
        expect(accion["Media móvil simple (200)"]).toBe("Neutral")
    })

    it("sin dato no hay señal", () => {
        const filas = mkTecMedias({ close: 100 })

        expect(filas.every((f) => f.valor === null && f.accion === null)).toBe(true)
        expect(mkTecRecuento(filas)).toEqual({ venta: 0, neutral: 0, compra: 0 })
    })
})

describe("mkTecRecuento", () => {
    it("cuenta cada señal y deja fuera las filas sin ella", () => {
        const filas = [{ accion: "Compra" }, { accion: "Compra" }, { accion: "Venta" }, { accion: "Neutral" }, { accion: null }]

        expect(mkTecRecuento(filas)).toEqual({ venta: 1, neutral: 1, compra: 2 })
    })
})

describe("mkQualityCol", () => {
    const filas = (texto) => {
        const div = document.createElement("div")
        div.innerHTML = texto
        return Object.fromEntries([...div.querySelectorAll(".fnDetailLine")].map((f) => [f.children[0].textContent, f.children[1].textContent]))
    }

    it("calcula la posición en el rango, %B, ATR y cruce de medias", () => {
        const c = filas(mkQualityCol(stats))

        expect(c["Posición en el rango de 52 sem."]).toBe("50,0 %")
        expect(c["Bollinger %B / anchura"]).toContain("50,0 %")
        expect(c["ATR / precio"]).toBe("2,00 %")
        expect(c["Media 50 vs. 200"]).toContain("Alcista")
        expect(c["Fuerza de tendencia (ADX)"]).toContain("30,0")
    })

    it("omite las filas cuyo dato no existe", () => {
        const c = filas(mkQualityCol({ close: 100 }))

        expect(c["Bollinger %B / anchura"]).toBeUndefined()
        expect(c["Posición en el rango de 52 sem."]).toBeUndefined()
    })
})

describe("mkPivotsCol", () => {
    it("pinta los niveles que hay y nada si no hay ninguno", () => {
        const html = mkPivotsCol({ close: 50, "Pivot.M.Classic.Middle": 55, "Pivot.M.Classic.R1": 60 }, "EUR")

        expect(html).toContain("Resistencia R1")
        expect(html).not.toContain("Soporte S1")
        expect(mkPivotsCol({ close: 50 }, "EUR").trim()).toBe("")
    })
})

describe("mkGaugeCol", () => {
    it("sin valoración global no pinta nada", () => {
        expect(mkGaugeCol({}).trim()).toBe("")
    })
})

describe("popup de datos técnicos", () => {
    it("se abre desde el medidor, enseña tablas y se cierra con Escape", () => {
        document.body.innerHTML = `<div id="assetMercadoSection">${mkBuildHtml({ isCrypto: false, stats }, { name: "Bitcoin", currency: "EUR" })}</div>`

        document.querySelector("[data-mk-tecnico]").click()
        const overlay = document.getElementById("mkTecOverlay")

        expect(overlay.classList.contains("hidden")).toBe(false)
        expect(overlay.textContent).toContain("Bitcoin · Datos técnicos")
        expect(overlay.querySelectorAll(".mkTecTabla tbody tr").length).toBe(21)

        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
        expect(overlay.classList.contains("hidden")).toBe(true)
    })
})

describe("Niveles clave", () => {
    const anio = new Date().getFullYear()
    const filas = (texto) => {
        const div = document.createElement("div")
        div.innerHTML = texto
        return Object.fromEntries([...div.querySelectorAll(".fnDetailLine")].map((f) => [f.children[0].textContent, f.children[1].textContent]))
    }

    it("pinta mínimo histórico y de 1 mes, y omite lo que falta", () => {
        const c = filas(mkLevelsCol({ close: 50, "Low.All": 10, "Low.1M": 45 }, "EUR", ""))

        expect(c["Mínimo histórico"]).toContain("10")
        expect(c["Mínimo 1 mes"]).toContain("45")
        expect(c["Máximo 1 mes"]).toBeUndefined()
        expect(c[`Máximo ${anio} (cierre)`]).toBeUndefined()
    })

    it("con ticker reserva las filas del año en curso", () => {
        const c = filas(mkLevelsCol({ close: 50 }, "EUR", "NASDAQ:AAPL"))

        expect(c[`Máximo ${anio} (cierre)`]).toBe("—")
        expect(c[`Mínimo ${anio} (cierre)`]).toBe("—")
    })

    it("rellena con los cierres del año actual y descarta los de otros años", async () => {
        const ts = (a, m) => Math.floor(new Date(a, m, 15).getTime() / 1000)
        globalThis.detMkObtenerSerie = async () => [[ts(anio - 1, 5), 999], [ts(anio, 0), 40], [ts(anio, 1), 70], [ts(anio, 2), 55]]
        const seccion = document.createElement("div")
        seccion.innerHTML = mkLevelsCol({ close: 50 }, "EUR", "NASDAQ:AAPL")

        await mkLevelsFillYear(seccion, "NASDAQ:AAPL", 50, "EUR")
        delete globalThis.detMkObtenerSerie

        expect(seccion.querySelector('[data-mk-anual="max"] span:last-child').textContent).toContain("70")
        expect(seccion.querySelector('[data-mk-anual="min"] span:last-child').textContent).toContain("40")
    })
})
