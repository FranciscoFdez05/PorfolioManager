// Pruebas de js/core/shared-utils.js.
//
// Es el módulo que usan todos los demás para leer y pintar importes, y hasta
// ahora no lo comprobaba nada: ESLint detecta un nombre mal escrito, pero no
// que un total salga cien veces mayor. Ese fallo existía de verdad —
// `parseEuroNumber("1234.56")` devolvía 123456— y estas pruebas son las que lo
// destaparon.
//
// El criterio de las tablas de abajo es el mismo que aplica el servidor en
// `python/core/dinero.py`. Que las dos mitades del proyecto lean los importes
// igual no se puede comprobar automáticamente desde aquí, así que se deja
// escrito en los dos sitios.
import { beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/shared-utils.js")
})

describe("parseEuroNumber", () => {
    it.each([
        // Formato español, que es como el esquema guarda los importes.
        ["1.234,56", 1234.56],
        ["0,1", 0.1],
        ["-1.234,56", -1234.56],
        ["83,58 €", 83.58],
        ["1.234.567,89", 1234567.89],
        // Miles sin decimales: el punto agrupa de tres en tres.
        ["1.234", 1234],
        ["1.234.567", 1234567],
        // Formato canónico, el que serializan el motor FIFO y los snapshots.
        // Este es el caso que estaba roto: devolvía 123456.
        ["1234.56", 1234.56],
        ["0.5", 0.5],
        ["-12.75", -12.75],
        // Sin separadores.
        ["1234", 1234],
        ["-12", -12]
    ])("lee %j como %f", (entrada, esperado) => {
        expect(parseEuroNumber(entrada)).toBe(esperado)
    })

    it("un importe canónico ya no se multiplica por cien", () => {
        // La regresión concreta: mientras se descartaban todos los puntos, un
        // total de 1.234,56 € que llegara serializado se pintaba como 123.456 €.
        expect(parseEuroNumber("1234.56")).toBe(1234.56)
        expect(parseEuroNumber("1234.56")).not.toBe(123456)
    })

    it.each([[""], [null], [undefined], [0]])("devuelve 0 para %j", (entrada) => {
        expect(parseEuroNumber(entrada)).toBe(0)
    })

    it("devuelve 0 y no NaN ante un texto ilegible", () => {
        // Los 118 sitios que lo llaman acumulan el resultado con `+`; un NaN
        // ahí convierte el total entero en NaN y la pantalla queda en blanco.
        expect(parseEuroNumber("abc")).toBe(0)
    })

    it("acepta los espacios de miles que escribe el navegador", () => {
        // NBSP (U+00A0) y espacio fino irrompible (U+202F).
        expect(parseEuroNumber("1 234,56")).toBe(1234.56)
        expect(parseEuroNumber("1 234,56")).toBe(1234.56)
    })
})

describe("parseDollarNumber", () => {
    it("aplica el mismo criterio que la versión en euros", () => {
        expect(parseDollarNumber("1.234,56")).toBe(1234.56)
        expect(parseDollarNumber("1234.56")).toBe(1234.56)
        expect(parseDollarNumber("$83,58")).toBe(83.58)
    })
})

describe("parseLooseNumber", () => {
    it.each([
        ["1.234,56", 1234.56],
        ["1234.56", 1234.56],
        ["1.234", 1234],
        ["12,5%", 12.5],
        ["83,58 €", 83.58],
        [42, 42]
    ])("lee %j como %f", (entrada, esperado) => {
        expect(parseLooseNumber(entrada)).toBe(esperado)
    })

    it.each([[""], [null], [undefined], ["-"], ["abc"]])(
        "devuelve null para %j, y quien llama decide",
        (entrada) => {
            expect(parseLooseNumber(entrada)).toBeNull()
        }
    )

    it("coincide con parseEuroNumber en las columnas que leen los dos", () => {
        // Discrepaban: "1234.56" daba 1234,56 en uno y 123.456 en el otro, así
        // que el número dependía de qué pantalla lo pintara.
        for (const entrada of ["1.234,56", "1234.56", "1.234", "0,1", "83,58 €"]) {
            expect(parseLooseNumber(entrada)).toBe(parseEuroNumber(entrada))
        }
    })

    it("rechaza los no finitos en vez de propagarlos", () => {
        expect(parseLooseNumber(Number.NaN)).toBeNull()
        expect(parseLooseNumber(Number.POSITIVE_INFINITY)).toBeNull()
    })
})

describe("ida y vuelta entre formato y lectura", () => {
    it.each([0, 0.1, 1234.56, -99.99, 1234567.89])(
        "formatEuro(%f) se vuelve a leer igual",
        (valor) => {
            expect(parseEuroNumber(formatEuro(valor))).toBeCloseTo(valor, 2)
        }
    )
})

describe("formatEuro", () => {
    it("usa coma decimal y el símbolo detrás", () => {
        expect(formatEuro(1234.5)).toBe("1234,50 €")
    })

    it("siempre deja dos decimales", () => {
        expect(formatEuro(7)).toBe("7,00 €")
        expect(formatEuro(0)).toBe("0,00 €")
    })

    it("redondea a dos decimales", () => {
        expect(formatEuro(1.005)).toMatch(/^1,0[01] €$/)
    })
})

describe("normalizeCurrencyCode", () => {
    it.each([
        ["USDT", "USD"],
        ["USDC", "USD"],
        ["DAI", "USD"],
        ["EURC", "EUR"],
        ["usd", "USD"],
        ["", "EUR"]
    ])("normaliza %j a %j", (entrada, esperado) => {
        expect(normalizeCurrencyCode(entrada)).toBe(esperado)
    })

    it("las stablecoins cuentan como su divisa de referencia", () => {
        // Si no, una posición en USDT se valoraría como un activo cripto
        // cualquiera en vez de como dólares.
        expect(normalizeCurrencyCode("BUSD")).toBe("USD")
        expect(normalizeCurrencyCode("FDUSD")).toBe("USD")
    })
})

describe("formatMoney", () => {
    it("cambia el símbolo según la divisa", () => {
        expect(formatMoney(1234.5, "EUR")).toContain("€")
        expect(formatMoney(1234.5, "USD")).toContain("$")
    })

    it("mantiene los dos decimales en cualquier divisa", () => {
        expect(formatMoney(7, "USD")).toMatch(/^7,00/)
    })
})

describe("cantidades de participaciones y satoshis", () => {
    it("formatShareQuantity no arrastra más de seis decimales", () => {
        expect(formatShareQuantity(1.23456789)).toBe("1,234568")
    })

    it("formatShareQuantity no inventa decimales en un entero", () => {
        expect(formatShareQuantity(3)).toBe("3")
    })

    it("formatSatoshis conserva los ocho decimales de la unidad mínima", () => {
        // Recortar aquí redondearía a cero las posiciones pequeñas en cripto.
        expect(formatSatoshis(0.00012345)).toBe("0,00012345")
    })
})

describe("stripCurrencyText", () => {
    it("deja el número sin el símbolo", () => {
        expect(stripCurrencyText("1.234,56 €").trim()).toBe("1.234,56")
        expect(stripCurrencyText("1.234,56 $").trim()).toBe("1.234,56")
    })
})
