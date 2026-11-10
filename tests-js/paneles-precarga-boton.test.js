// Botón «Precargar» del mapa de Paneles (js/cartera/paneles-mapa.js).
//
// Activa o quita la precarga de las vistas previas de TradingView y, mientras
// carga, enseña cuántas lleva. Se carga solo el trozo del mapa con lo que usa
// del resto de paneles-*.js simulado: el widget, guardar y repintar.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { cargarScript } from "./cargar.js"

let widgetEl

beforeAll(() => {
    window.pnSi = (cfg, clave, defecto = true) => (typeof cfg[clave] === "boolean" ? cfg[clave] : defecto)
    window.pnWidgetEl = () => widgetEl
    window.pnGuardar = vi.fn()
    window.pnPintarWidget = vi.fn()
    cargarScript("js/cartera/paneles-mapa.js")
})

beforeEach(() => {
    document.body.innerHTML = `<div class="pnW"><div class="pnWCtrls"></div></div>`
    widgetEl = document.querySelector(".pnW")
    window.pnGuardar.mockClear()
    window.pnPintarWidget.mockClear()
})

function pintar(cfg = {}) {
    const w = { id: "w1", cfg }
    pnBotonPrecarga(w, widgetEl.querySelector(".pnWCtrls"))
    return { w, btn: widgetEl.querySelector(".pnPrecargaBtn") }
}

describe("botón de precarga", () => {
    it("sin precarga sale sin pulsar y al pulsarlo la activa", () => {
        const { w, btn } = pintar()

        expect(btn.getAttribute("aria-pressed")).toBe("false")
        expect(btn.textContent).toBe("Precargar")
        btn.click()
        expect(w.cfg.precargaTv).toBe(true)
        expect(window.pnGuardar).toHaveBeenCalledOnce()
        expect(window.pnPintarWidget).toHaveBeenCalledWith(w)
    })

    it("con precarga sale pulsado y al pulsarlo la quita", () => {
        const { w, btn } = pintar({ precargaTv: true })

        expect(btn.getAttribute("aria-pressed")).toBe("true")
        btn.click()
        expect("precargaTv" in w.cfg).toBe(false)
    })

    it("enseña el progreso con su barra y al acabar el total", () => {
        const { w, btn } = pintar({ precargaTv: true })
        const barra = btn.querySelector(".pnPrecargaBarra")

        pnProgresoPrecarga(w, 3, 12)
        expect(btn.textContent).toBe("Precargando 3/12")
        expect(btn.classList.contains("pnPrecargando")).toBe(true)
        expect(barra.style.width).toBe("25%")

        pnProgresoPrecarga(w, 12, 12)
        expect(btn.textContent).toBe("Precargados 12")
        expect(btn.classList.contains("pnPrecargando")).toBe(false)
    })

    it("sin gráficos que cargar no pinta contador", () => {
        const { w, btn } = pintar({ precargaTv: true })

        pnProgresoPrecarga(w, 0, 0)
        expect(btn.textContent).toBe("Precargar")
        expect(btn.classList.contains("pnPrecargando")).toBe(false)
    })

    it("sin el widget en pantalla no falla", () => {
        const { w } = pintar()
        widgetEl = null

        expect(() => pnProgresoPrecarga(w, 1, 2)).not.toThrow()
    })
})
