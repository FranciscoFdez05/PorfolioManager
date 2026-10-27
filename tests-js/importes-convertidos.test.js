// Los importes que guarda el cambio de divisa (texto canónico, punto decimal y
// hasta ocho decimales) se leen igual en el navegador que en el servidor
// (auditoría D): «89.381» es 89,381 y no 89 381.
import { beforeAll, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

const CASOS = [
    ["89.381", 89.381],
    ["893.81", 893.81],
    ["1000", 1000],
    ["0.00011135", 0.00011135],
    ["1234.56789012", 1234.56789012],
    ["100.33", 100.33]
]

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
})

describe("importes canónicos del cambio de divisa", () => {
    it.each(CASOS)("el navegador lee %s como %f", (texto, esperado) => {
        expect(parseLooseNumber(texto)).toBeCloseTo(esperado, 10)
        expect(parseEuroNumber(texto)).toBeCloseTo(esperado, 10)
    })
})
