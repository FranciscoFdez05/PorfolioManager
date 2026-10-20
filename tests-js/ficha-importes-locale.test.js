// La tabla de la ficha de activo no relee el texto de pantalla.
//
// Con el locale en-US la celda enseña "2,469.12 €" y volver a leer ese texto
// daba 2,46912: los totales por fila salían mil veces menores. El valor
// canónico viaja en data-value y es de ahí de donde se lee.
import { afterEach, beforeAll, describe, expect, it } from "vitest"

import { cargarModulo, cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/fusion-anual.js")
    cargarScript("js/core/app-core.js")
    cargarModulo("js/cartera/assets.js")
})

afterEach(() => {
    window._numLocale = "es-ES"
    document.body.innerHTML = ""
})

function montarTabla() {
    document.body.innerHTML = `
        <section class="assetTablePage" data-asset-currency="EUR" data-asset-type="acciones">
            <table><tbody id="assetOperationsBody"></tbody></table>
        </section>`
}

const COMPRA = {
    fechaOperacion: "01-01-2026",
    tipoOperacion: "Compra",
    participaciones: "2",
    precioParticipacion: "1234.56",
    capitalInvertidoBruto: "2469.12",
    comisiones: "1.5"
}

describe("updateAssetTableTotals", () => {
    it.each(["es-ES", "en-US", "fr-FR"])("calcula el neto de la fila igual con el locale %s", (locale) => {
        window._numLocale = locale
        montarTabla()

        renderAssetRows([COMPRA])

        const total = document.querySelector(".rowTotal").textContent
        expect(parseEuroNumber(total.replaceAll(/[^\d.,-]/g, ""))).toBeCloseTo(2467.62, 2)
    })

    it("cada celda lleva su valor canónico", () => {
        window._numLocale = "en-US"
        montarTabla()

        renderAssetRows([COMPRA])

        const celda = (campo) => document.querySelector(`[data-field="${campo}"]`)
        expect(celda("participaciones").dataset.value).toBe("2")
        expect(celda("capitalInvertidoBruto").dataset.value).toBe("2469.12")
        expect(celda("comisiones").dataset.value).toBe("1.5")
        expect(celda("capitalInvertidoBruto").textContent).toContain("2,469.12")
    })

    it("un importe antiguo con la coma española sigue leyéndose bien", () => {
        montarTabla()

        renderAssetRows([{ ...COMPRA, capitalInvertidoBruto: "2.469,12", comisiones: "1,50" }])

        expect(document.querySelector('[data-field="capitalInvertidoBruto"]').dataset.value).toBe("2469.12")
        expect(document.querySelector('[data-field="comisiones"]').dataset.value).toBe("1.50")
    })
})
