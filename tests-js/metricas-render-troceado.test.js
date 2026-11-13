// Pruebas del montaje troceado de Métricas (js/analisis/metricas-init.js).
//
// mRenderAll pintaba las 42 gráficas en una sola tarea de 300-400 ms. Ahora
// cede el hilo cuando lleva más de un presupuesto de tiempo y se puede
// cancelar al salir de la página. Los mRender* se sustituyen por espías: lo que
// se comprueba es el orden, la cesión del hilo y la cancelación, no las gráficas.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarScript } from "./cargar.js"

const NOMBRES = [
    "mRenderDistTipos",
    "mRenderDistActivos",
    "mRenderRendTipos",
    "mRenderRendActivos",
    "mRenderDividendos",
    "mRenderDivMensual",
    "mRenderInteresesSection",
    "mRenderInvertidoPeriodo",
    "mRenderPasivosCharts",
    "mRenderBonosTipos",
    "mRenderBonosInst",
    "mRenderRentaFijaTipos",
    "mRenderRentaFijaInst",
    "mRenderIngresosHistorico",
    "mRenderVencimientos",
    "mRenderPrivateMarket",
    "mRenderGastos",
    "mRenderIngresos",
    "mRenderIngresosSection",
    "mRenderComparativa",
    "mRenderSaldoMes",
    "mRenderTopTable",
    "mRenderTrading",
    "mRenderConcentracion",
    "mRenderRentabilidadAnual",
    "mRenderRiesgo",
    "mRenderAhorro",
    "mRenderAnual"
]

let llamadas = []

const payload = () => ({
    summaries: [{ name: "A", color: "#fff", netoActualEur: 10, invertidoEur: 5 }],
    dividendos: [],
    snapshotHistory: [{}],
    tradingRows: []
})

beforeAll(() => {
    globalThis.getChartPref = (_clave, porDefecto) => porDefecto
    globalThis._metricasDisplayType = "doughnut"
    globalThis._metricasDistMetric = "netoActualEur"
    globalThis._M_SECCIONES_DE_SNAPSHOTS = []
    cargarScript("js/analisis/metricas-init.js")
})

beforeEach(() => {
    llamadas = []
    NOMBRES.forEach((nombre) => {
        globalThis[nombre] = vi.fn(() => llamadas.push(nombre))
    })
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe("mRenderAll", () => {
    it("ejecuta todos los apartados en orden y devuelve true", async () => {
        expect(await mRenderAll(payload())).toBe(true)
        expect(llamadas).toEqual(NOMBRES)
    })

    it("no cede el hilo si los pasos caben en el presupuesto", async () => {
        const espia = vi.spyOn(globalThis, "setTimeout")
        await mRenderAll(payload())
        expect(espia).not.toHaveBeenCalled()
    })

    it("cede el hilo entre pasos cuando se agota el presupuesto", async () => {
        let reloj = 0
        vi.spyOn(performance, "now").mockImplementation(() => (reloj += M_PRESUPUESTO_TAREA_MS + 1))
        const espia = vi.spyOn(globalThis, "setTimeout")
        expect(await mRenderAll(payload())).toBe(true)
        expect(espia).toHaveBeenCalledTimes(NOMBRES.length)
        expect(llamadas).toEqual(NOMBRES)
    })

    it("se detiene y devuelve false si se cancela mientras cede el hilo", async () => {
        vi.spyOn(performance, "now").mockImplementation(() => 1e9 + llamadas.length * 100)
        const render = mRenderAll(payload())
        // El primer paso ya corrió de forma síncrona y el render está cediendo.
        expect(llamadas).toEqual([NOMBRES[0]])
        mCancelarRender()
        expect(await render).toBe(false)
        expect(llamadas).toEqual([NOMBRES[0]])
    })

    it("un render nuevo deja sin efecto al anterior", async () => {
        vi.spyOn(performance, "now").mockImplementation(() => 1e9 + llamadas.length * 100)
        const primero = mRenderAll(payload())
        const segundo = mRenderAll(payload())
        expect(await primero).toBe(false)
        expect(await segundo).toBe(true)
    })
})
