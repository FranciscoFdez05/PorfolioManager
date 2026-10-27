// Dietz usa el mismo flujo por tramo que la TWR y la XIRR del servidor
// (auditoría B-24): el dinero que entró o salió de verdad, no la variación del
// invertido, que al vender solo baja el coste de lo vendido.
import { beforeAll, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    // El fichero lee preferencias de gráficos al cargarse (viven en metricas.js,
    // que no hace falta para probar el cálculo).
    globalThis.getChartPref = (_clave, porDefecto) => porDefecto
    cargarScript("js/analisis/metricas-rentabilidad.js")
})

const punto = (ts, i, f) => ({ ts, v: 0, i, f })

describe("flujo de un tramo para Dietz", () => {
    it("suma los flujos guardados de los snapshots del tramo", () => {
        const inicio = punto(100, 1000, 0)
        const snaps = [inicio, punto(200, 1500, 500), punto(300, 1500, 0), punto(400, 900, -1500)]

        const tramo = mFlujoDelTramo(snaps, inicio, snaps[3])

        // Lo cobrado en la venta (1.500), no los 600 que baja el invertido.
        expect(tramo).toEqual({ flujo: -1000, estimado: false })
    })

    it("si a algún snapshot del tramo le falta el flujo, estima con el invertido y lo marca", () => {
        const inicio = punto(100, 1000, null)
        const snaps = [inicio, punto(200, 1500, 500), punto(300, 1800, null)]

        const tramo = mFlujoDelTramo(snaps, inicio, snaps[2])

        expect(tramo).toEqual({ flujo: 800, estimado: true })
    })

    it("hasta el valor en vivo, el trozo desde el último snapshot se estima", () => {
        const inicio = punto(100, 1000, null)
        const snaps = [inicio, punto(200, 1500, 500)]

        expect(mFlujoDelTramo(snaps, inicio, { v: 0, i: 1700 })).toEqual({ flujo: 700, estimado: true })
        expect(mFlujoDelTramo(snaps, inicio, { v: 0, i: 1500 })).toEqual({ flujo: 500, estimado: false })
    })
})
