// Coste de una operación spot completada al volcarla en el activo.
//
// El "Total" de Operaciones se teclea a mano y unas veces lleva la comisión en
// € dentro y otras no (aquí sí: 65000 × 0,00460385 + 0,45 = 299,70). Por eso el
// bruto es precio × cantidad + comisión, el neto precio × cantidad y el precio
// medio el de ejecución. El Total solo cuenta si no hay precio. Se fija aquí
// porque ya se cambió de criterio dos veces.
import { beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

const OPERACION = {
    id: "op-1",
    assetId: "bitcoin",
    fechaApertura: "31-08-2026",
    par: "BTC/EUR",
    orden: "Compra",
    precioOrden: "65000",
    precioCurrency: "EUR",
    cantidad: "0,00460385",
    comisionesCripto: "",
    comisionesFiat: "0,45",
    total: "299,70",
    currency: "EUR",
    estado: "Completado",
    fechaCierre: "15-09-2026"
}

const ACTIVO = {
    id: "bitcoin",
    name: "Bitcoin",
    symbol: "BTC",
    type: "cripto",
    price: "68000",
    currency: "EUR",
    rows: [],
    operationRows: [OPERACION]
}

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cartera/assets.js")
})

describe("operación spot completada", () => {
    it("valora el lote a precio × cantidad y el precio medio queda en el de ejecución", async () => {
        const fila = await buildOverviewRow({ ...ACTIVO })

        expect(fila.invertidoBruto).toBeCloseTo(65000 * 0.00460385 + 0.45, 2)
        expect(fila.comisionesFiat).toBeCloseTo(0.45, 2)
        expect(fila.invertidoNeto).toBeCloseTo(65000 * 0.00460385, 2)
        expect(fila.participaciones).toBeCloseTo(0.00460385, 8)
        expect(fila.promedioCompra).toBeCloseTo(65000, 2)
    })

    it("sin precio recurre al Total más la comisión", async () => {
        const fila = await buildOverviewRow({
            ...ACTIVO,
            operationRows: [{ ...OPERACION, precioOrden: "" }]
        })

        expect(fila.invertidoBruto).toBeCloseTo(299.7 + 0.45, 2)
        expect(fila.invertidoNeto).toBeCloseTo(299.7, 2)
    })
})
