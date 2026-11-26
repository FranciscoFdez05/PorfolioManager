// Pruebas del «Resumen anual de activos» de Métricas (js/analisis/metricas-compras-anuales.js).
//
// Las cifras vienen hechas del servidor; aquí se comprueba lo que decide el
// navegador: cuándo se esconde la sección, qué año queda elegido, qué enseña la
// tabla de un año vendido entero y que el selector repinta sin pedir nada.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarModulo, cargarScript } from "./cargar.js"

const HTML = `
<div class="metricasSection" id="mSectionComprasAnuales">
    <div id="mComprasYearToggle"></div>
    <span id="mkpiComprasAnioLabel"></span>
    <div id="mkpiComprasInvertido"></div><div id="mkpiComprasActivos"></div>
    <div id="mkpiComprasCosteVivo"></div><div id="mkpiComprasVendido"></div>
    <div id="mkpiComprasValor"></div>
    <div id="mkpiComprasRend"></div><div id="mkpiComprasRendPct"></div>
    <table><tbody id="mComprasTableBody"></tbody></table>
    <div class="mChartNota hidden" id="mComprasNota"></div>
</div>`

const anio = (n, extra = {}) => ({
    anio: n,
    comprado: 1000,
    costeVivo: 500,
    valorActual: 750,
    rendimiento: 250,
    rendimientoPct: 50,
    pctVendido: 50,
    numActivos: 1,
    activos: [
        {
            id: "apple",
            nombre: "Apple <b>",
            tipo: "acciones",
            cantidadComprada: 10,
            cantidadViva: 5,
            comprado: 1000,
            costeVivo: 500,
            valorActual: 750,
            rendimiento: 250,
            rendimientoPct: 50,
            pctVendido: 50
        }
    ],
    ...extra
})

const vendidoEntero = {
    id: "tesla",
    nombre: "Tesla",
    tipo: "acciones",
    cantidadComprada: 2,
    cantidadViva: 0,
    comprado: 400,
    costeVivo: 0,
    valorActual: 0,
    rendimiento: 0,
    rendimientoPct: null,
    pctVendido: 100
}

let preferencias

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/app-core.js")
    cargarModulo("js/analisis/metricas.js")
    // Vive en js/cartera/assets-sidebar.js, que arrastra media barra lateral;
    // basta con la misma salida para leer las celdas.
    globalThis.formatPercent = (valor) => `${Number(valor).toFixed(2).replace(".", ",")} %`
})

beforeEach(() => {
    document.body.innerHTML = HTML
    preferencias = {}
    globalThis.getChartPref = (clave, porDefecto) => preferencias[clave] ?? porDefecto
    globalThis.setChartPref = (clave, valor) => {
        preferencias[clave] = valor
    }
    globalThis.mCreateChart = vi.fn()
    _metricasComprasAnio = null
})

describe("mRenderComprasAnuales", () => {
    it("esconde la sección si no hay compras o la petición falló", () => {
        mRenderComprasAnuales({ anios: [], sinTipo: [] })
        expect(document.getElementById("mSectionComprasAnuales").classList.contains("hidden")).toBe(true)

        document.body.innerHTML = HTML
        mRenderComprasAnuales(null)
        expect(document.getElementById("mSectionComprasAnuales").classList.contains("hidden")).toBe(true)
        expect(mCreateChart).not.toHaveBeenCalled()
    })

    it("elige el año más reciente y pinta su tabla escapando el nombre", () => {
        mRenderComprasAnuales({ anios: [anio(2025), anio(2024)], sinTipo: [] })

        expect(document.getElementById("mkpiComprasAnioLabel").textContent).toBe("Compras de 2025")
        const botones = [...document.querySelectorAll("#mComprasYearToggle button")]
        expect(botones.map((b) => b.textContent)).toEqual(["2025", "2024"])
        expect(botones[0].classList.contains("active")).toBe(true)
        const filas = document.querySelectorAll("#mComprasTableBody tr")
        expect(filas).toHaveLength(1)
        expect(filas[0].innerHTML).toContain("Apple &lt;b&gt;")
        expect(mCreateChart).toHaveBeenCalledTimes(2)
    })

    it("respeta el año guardado si existe y lo descarta si no", () => {
        preferencias.metricasComprasAnio = "2024"
        mRenderComprasAnuales({ anios: [anio(2025), anio(2024)], sinTipo: [] })
        expect(_metricasComprasAnio).toBe("2024")

        _metricasComprasAnio = null
        preferencias.metricasComprasAnio = "1999"
        mRenderComprasAnuales({ anios: [anio(2025), anio(2024)], sinTipo: [] })
        expect(_metricasComprasAnio).toBe("2025")
    })

    it("el selector cambia de año, lo guarda y no repinta los gráficos", () => {
        mRenderComprasAnuales({ anios: [anio(2025), anio(2024, { numActivos: 2 })], sinTipo: [] })
        mCreateChart.mockClear()

        document.querySelector('[data-comprasyr="2024"]').click()

        expect(_metricasComprasAnio).toBe("2024")
        expect(preferencias.metricasComprasAnio).toBe("2024")
        expect(document.getElementById("mkpiComprasActivos").textContent).toBe("2 activos")
        expect(mCreateChart).not.toHaveBeenCalled()
    })

    it("un activo vendido entero no enseña coste, valor ni porcentaje", () => {
        mRenderComprasAnuales({
            anios: [anio(2024, { activos: [vendidoEntero], rendimientoPct: null, costeVivo: 0 })],
            sinTipo: []
        })

        const celdas = [...document.querySelectorAll("#mComprasTableBody td")].map((td) => td.textContent.trim())
        expect(celdas.slice(4)).toEqual(["---", "---", "---", "---"])
        expect(document.getElementById("mkpiComprasRendPct").textContent).toBe("Vendido entero")
    })

    it("avisa de las divisas sin tipo de cambio", () => {
        mRenderComprasAnuales({ anios: [anio(2024)], sinTipo: ["USD"] })

        const nota = document.getElementById("mComprasNota")
        expect(nota.classList.contains("hidden")).toBe(false)
        expect(nota.textContent).toContain("USD")
    })
})
