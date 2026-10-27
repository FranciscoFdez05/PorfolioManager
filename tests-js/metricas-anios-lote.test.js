// El resumen anual de Métricas pide los años en bloque, no uno a uno.
//
// Con veinte años de historia buildMetricasPayload lanzaba 40 peticiones
// (/api/gastos/<año> y /api/ingresos/<año>). Ahora salen dos
// (/api/gastos/todos y /api/ingresos/todos) más el año seleccionado, y solo si
// el servidor no trae un año se pide ese aparte.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarModulo, cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/app-core.js")
    cargarModulo("js/analisis/metricas.js")
})

const ANIOS = Array.from({ length: 20 }, (_, i) => String(2007 + i))
const payloadDe = (tipo, year) => ({ year, [`${tipo}Tipos`]: [], rows: [{ id: `${tipo}-${year}` }] })

let urls
let todosIncompleto

beforeEach(() => {
    urls = []
    todosIncompleto = false
    globalThis.loadAssetsList = vi.fn(async () => [])
    globalThis.loadAssetData = vi.fn()
    globalThis.cargarCuentasDinero = vi.fn(async () => {})
    window._cuentasDinero = [{ id: "banco" }]
    globalThis.fetch = vi.fn(async (url) => {
        urls.push(url)
        const json = (cuerpo) => new Response(JSON.stringify(cuerpo), { status: 200 })
        if (url === "/api/gastos" || url === "/api/ingresos") return json({ years: ANIOS })
        const todos = url.match(/^\/api\/(gastos|ingresos)\/todos$/)
        if (todos) {
            const anios = todosIncompleto ? ANIOS.slice(1) : ANIOS
            return json({ years: Object.fromEntries(anios.map((y) => [y, payloadDe(todos[1], y)])) })
        }
        const uno = url.match(/^\/api\/(gastos|ingresos)\/(\d{4})$/)
        if (uno) return json(payloadDe(uno[1], uno[2]))
        return json({ rows: [], data: [], cuentas: [], byMonth: {}, byYear: {} })
    })
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe("buildMetricasPayload: resumen anual", () => {
    it("no pide un año por petición: dos de bloque y solo el año seleccionado aparte", async () => {
        const payload = await buildMetricasPayload()

        const porAnio = urls.filter((u) => /^\/api\/(gastos|ingresos)\/\d{4}$/.test(u))
        expect(porAnio).toHaveLength(2)
        expect(urls).toContain("/api/gastos/todos")
        expect(urls).toContain("/api/ingresos/todos")
        expect(payload.anualData).toHaveLength(20)
        for (const { year, gastosData, ingresosData } of payload.anualData) {
            expect(gastosData.rows[0].id).toBe(`gastos-${year}`)
            expect(ingresosData.rows[0].id).toBe(`ingresos-${year}`)
        }
    })

    it("un año que el bloque no trae se pide aparte, como antes", async () => {
        todosIncompleto = true

        const payload = await buildMetricasPayload()

        const primero = payload.anualData.find((a) => a.year === 2007)
        expect(primero.gastosData.rows[0].id).toBe("gastos-2007")
        expect(urls.filter((u) => u === "/api/gastos/2007")).toHaveLength(1)
    })
})
