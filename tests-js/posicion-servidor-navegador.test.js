// El navegador y el servidor tienen que contar las mismas participaciones.
//
// Mismo caso que lee tests/test_correcciones_auditoria2.py: una cartera cripto
// con compras y ventas de la ficha, operaciones (una con fecha ilegible),
// ventas, transacciones y conversiones. Si esta cifra cambia, hay que cambiar
// también la reconstrucción del servidor (stores/rendimiento_activo.py).
import { beforeAll, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { cargarModulo, cargarScript } from "./cargar.js"

const CASO = JSON.parse(
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "posicion-casos.json"), "utf-8")
)

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/fusion-anual.js")
    cargarScript("js/core/app-core.js")
    cargarModulo("js/cartera/assets.js")
})

describe("participaciones del navegador", () => {
    it("dan la cantidad que espera el caso compartido con el servidor", async () => {
        globalThis.fetch = vi.fn(async (url) => {
            const ruta = String(url)
            if (ruta.startsWith("/api/exchange-rate")) {
                const consulta = new URL(ruta, "http://x").searchParams
                const usd = Number(CASO.tipoUsdEur)
                const origen = consulta.get("source")
                const destino = consulta.get("target")
                const rate = origen === destino ? 1 : origen === "USD" ? usd : 1 / usd
                return new Response(JSON.stringify({ rate }), { status: 200 })
            }
            const cuerpo = ruta.startsWith("/api/ventas")
                ? { rows: CASO.ventas }
                : ruta.startsWith("/api/transacciones")
                  ? { rows: CASO.transacciones }
                  : { rows: [] }
            return new Response(JSON.stringify(cuerpo), { status: 200 })
        })
        await loadVentasRowsForAssets()
        await loadTransaccionesRowsForAssets()
        setExternalOperacionesRowsForAssets([])

        const lotes = await buildRemainingAssetLots(CASO.asset, "EUR")
        const cantidad = lotes.reduce((total, lote) => total + lote.remaining, 0)

        expect(cantidad).toBeCloseTo(Number(CASO.cantidadEsperada), 8)
    })

    it("dan el mismo invertido, bruto y neto, que el servidor", async () => {
        globalThis.fetch = vi.fn(async (url) => {
            const ruta = String(url)
            if (ruta.startsWith("/api/exchange-rate")) {
                const consulta = new URL(ruta, "http://x").searchParams
                const usd = Number(CASO.tipoUsdEur)
                const origen = consulta.get("source")
                const destino = consulta.get("target")
                const rate = origen === destino ? 1 : origen === "USD" ? usd : 1 / usd
                return new Response(JSON.stringify({ rate }), { status: 200 })
            }
            const cuerpo = ruta.startsWith("/api/ventas")
                ? { rows: CASO.ventas }
                : ruta.startsWith("/api/transacciones")
                  ? { rows: CASO.transacciones }
                  : { rows: [] }
            return new Response(JSON.stringify(cuerpo), { status: 200 })
        })
        await loadVentasRowsForAssets()
        await loadTransaccionesRowsForAssets()
        setExternalOperacionesRowsForAssets([])

        const fila = await buildOverviewRow(CASO.asset)
        const euros = await buildSummaryMetricsInEuros(fila)

        expect(fila.invertidoBruto).toBeCloseTo(Number(CASO.invertidoBrutoEsperado), 5)
        expect(fila.invertidoNeto).toBeCloseTo(Number(CASO.invertidoNetoEsperado), 5)
        // La lista, la barra superior y el histórico usan el neto, como la ficha.
        expect(euros.invertidoEur).toBeCloseTo(Number(CASO.invertidoNetoEsperado), 5)
        expect(euros.invertidoBrutoEur).toBeCloseTo(Number(CASO.invertidoNetoEsperado), 5)
    })
})

describe("invertido neto de un activo no cripto", () => {
    it("descuenta las comisiones de la ficha y las de Operaciones, como el servidor", async () => {
        globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ rows: [], rate: 1 }), { status: 200 }))
        await loadVentasRowsForAssets()
        await loadTransaccionesRowsForAssets()
        setExternalOperacionesRowsForAssets([])

        const fila = await buildOverviewRow(CASO.acciones.asset)

        expect(fila.invertidoBruto).toBeCloseTo(Number(CASO.acciones.invertidoBrutoEsperado), 5)
        expect(fila.invertidoNeto).toBeCloseTo(Number(CASO.acciones.invertidoNetoEsperado), 5)
        expect(fila.comisionesFiat).toBeCloseTo(3.5, 5)
    })
})
