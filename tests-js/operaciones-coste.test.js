// Coste de una operación spot completada al volcarla en el activo.
//
// En Operaciones el "Total" va sin la comisión en €, así que el bruto es
// Total + comisión, la comisión cuenta en COMIS. y el neto se queda en el
// Total. Se fija aquí porque ya se cambió de criterio una vez.
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
    it("suma el Total y la comisión € al bruto y deja el neto en el Total", async () => {
        const fila = await buildOverviewRow({ ...ACTIVO })

        expect(fila.invertidoBruto).toBeCloseTo(300.15, 2)
        expect(fila.comisionesFiat).toBeCloseTo(0.45, 2)
        expect(fila.invertidoNeto).toBeCloseTo(299.7, 2)
        expect(fila.participaciones).toBeCloseTo(0.00460385, 8)
        expect(fila.promedioCompra).toBeCloseTo(299.7 / 0.00460385, 2)
    })

    it("sin Total recurre a precio × cantidad más la comisión", async () => {
        const fila = await buildOverviewRow({
            ...ACTIVO,
            operationRows: [{ ...OPERACION, total: "" }]
        })

        expect(fila.invertidoBruto).toBeCloseTo(65000 * 0.00460385 + 0.45, 2)
        expect(fila.invertidoNeto).toBeCloseTo(65000 * 0.00460385, 2)
    })
})
