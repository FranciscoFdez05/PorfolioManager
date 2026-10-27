// Ventas: el valor y la comisión se muestran en la divisa del activo y el
// resultado fiscal en euros (auditoría B-15).
import { beforeAll, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/ventas.js")
})

describe("ejercicio por defecto de Ventas", () => {
    it("abre el año en curso si existe y, si no, el más reciente", () => {
        const actual = String(new Date().getFullYear())

        expect(chooseDefaultVentasYear(["2008", "2013", actual])).toBe(actual)
        expect(chooseDefaultVentasYear(["2008", "2013", "2014"])).toBe("2014")
        expect(chooseDefaultVentasYear([])).toBe(actual)
    })
})

describe("divisa de las ventas", () => {
    it("formatea con la divisa que se le pide y euros por defecto", () => {
        expect(formatVentasMoney("100", "USD")).toContain("$")
        expect(formatVentasMoney("100", "USD")).not.toContain("€")
        expect(formatVentasMoney("100")).toContain("€")
    })

    it("la divisa de una fila es la suya y, si no la tiene, la de su activo", () => {
        ventasAssets = [{ id: "aapl", name: "Apple", currency: "USD" }]

        expect(getVentaRowCurrency({ assetId: "aapl", currency: "GBP" })).toBe("GBP")
        expect(getVentaRowCurrency({ assetId: "aapl" })).toBe("USD")
        expect(getVentaRowCurrency({ assetId: "otro" })).toBe("EUR")
    })
})
