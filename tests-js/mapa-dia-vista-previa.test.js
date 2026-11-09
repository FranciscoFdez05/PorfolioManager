// Vista previa de TradingView de los mapas de calor (js/core/mapa-dia.js).
//
// Cada iframe de TradingView tarda ~1 s en arrancar aunque su código esté en
// caché. Lo que se comprueba aquí es que no se recrean: volver a una baldosa ya
// vista reutiliza su iframe, hay un tope de iframes vivos y el precalentado
// solo carga uno. Va en un fichero aparte porque la reserva de iframes es
// estado del módulo y estas pruebas necesitan empezar con ella vacía.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    window.escapeAttr = (s) => String(s)
    cargarScript("js/core/mapa-dia.js")
})

afterEach(() => {
    vi.useRealTimers()
})

function baldosa() {
    const celda = document.createElement("div")
    document.body.appendChild(celda)
    return celda
}

function marcos() {
    return [...document.querySelectorAll("#mapaDiaTv iframe")]
}

function activo() {
    return marcos().filter((f) => f.classList.contains("mapaDiaTvActivo"))
}

/** Pasa el ratón por una baldosa y deja correr el retardo de apertura. */
function pasar(simbolo) {
    mapaDiaMostrarTv(baldosa(), simbolo)
    vi.advanceTimersByTime(1000)
}

describe("vista previa", () => {
    it("el precalentado carga un iframe oculto, solo si no hay ninguno", () => {
        vi.useFakeTimers()
        delete window.requestIdleCallback

        mapaDiaPrecalentarTv("NASDAQ:AAPL")
        mapaDiaPrecalentarTv("NASDAQ:MSFT")
        vi.advanceTimersByTime(2000)

        expect(marcos()).toHaveLength(1)
        expect(marcos()[0].src).toContain("NASDAQ%3AAAPL")
        expect(activo()).toHaveLength(0)
        expect(document.getElementById("mapaDiaTv").classList.contains("mapaDiaTvVisible")).toBe(false)
    })

    it("al pasar por el activo precalentado se usa ese mismo iframe", () => {
        vi.useFakeTimers()
        const precalentado = marcos()[0]

        pasar("NASDAQ:AAPL")

        expect(marcos()).toHaveLength(1)
        expect(activo()).toEqual([precalentado])
        expect(document.getElementById("mapaDiaTv").classList.contains("mapaDiaTvVisible")).toBe(true)
    })

    it("volver a una baldosa ya vista no crea otro iframe", () => {
        vi.useFakeTimers()
        pasar("NASDAQ:MSFT")
        const msft = activo()[0]
        mapaDiaOcultarTv()
        pasar("NASDAQ:AAPL")
        mapaDiaOcultarTv()
        pasar("NASDAQ:MSFT")

        expect(marcos()).toHaveLength(2)
        expect(activo()).toEqual([msft])
    })

    it("con el sandbox puesto desde el principio", () => {
        marcos().forEach((f) => expect(f.getAttribute("sandbox")).toContain("allow-scripts"))
    })

    it("no pasa del tope y descarta el que hace más tiempo que no se usa", () => {
        vi.useFakeTimers()
        // Orden de uso ahora: AAPL, MSFT. Se usa AAPL para que MSFT sea el más antiguo.
        pasar("NASDAQ:AAPL")
        for (let i = 0; i < MAPA_DIA_TV_MAX_MARCOS; i++) pasar(`NYSE:T${i}`)

        expect(marcos()).toHaveLength(MAPA_DIA_TV_MAX_MARCOS)
        const fuentes = marcos().map((f) => f.src)
        expect(fuentes.some((s) => s.includes("MSFT"))).toBe(false)
        expect(fuentes.some((s) => s.includes("AAPL"))).toBe(false)
        expect(activo()).toHaveLength(1)
        expect(activo()[0].src).toContain(`NYSE%3AT${MAPA_DIA_TV_MAX_MARCOS - 1}`)
    })

    it("cruzar baldosas de pasada no carga nada", () => {
        vi.useFakeTimers()
        const antes = marcos().length
        mapaDiaOcultarTv()
        mapaDiaMostrarTv(baldosa(), "NYSE:PASO1")
        vi.advanceTimersByTime(50)
        mapaDiaMostrarTv(baldosa(), "NYSE:PASO2")
        vi.advanceTimersByTime(50)
        mapaDiaOcultarTv()
        vi.advanceTimersByTime(1000)

        expect(marcos()).toHaveLength(antes)
    })
})
