// Analizador de fórmulas de las herramientas propias: precedencia, funciones y errores.
import { beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/analisis/herramientas-formula.js")
})

const calcular = (texto, valores = {}) => hFormulaEvaluar(hFormulaCompilar(texto).arbol, valores)

describe("hFormulaCompilar + hFormulaEvaluar", () => {
    it("respeta la precedencia de operadores y los paréntesis", () => {
        expect(calcular("2 + 3 * 4")).toBe(14)
        expect(calcular("(2 + 3) * 4")).toBe(20)
        expect(calcular("10 - 4 - 3")).toBe(3)
        expect(calcular("100 / 10 / 2")).toBe(5)
    })

    it("la potencia asocia por la derecha y el signo va después", () => {
        expect(calcular("2 ^ 3 ^ 2")).toBe(512)
        expect(calcular("-2 ^ 2")).toBe(-4)
        expect(calcular("2 ^ -1")).toBe(0.5)
        expect(calcular("--3")).toBe(3)
    })

    it("lee decimales y notación científica", () => {
        expect(calcular(".5 + 1.25")).toBe(1.75)
        expect(calcular("1e3")).toBe(1000)
    })

    it("sustituye los campos por su valor", () => {
        expect(calcular("gasto / (tasa / 100)", { gasto: 24000, tasa: 4 })).toBe(600000)
        expect(calcular("capital * (1 + r / 100) ^ anos", { capital: 1000, r: 10, anos: 2 })).toBeCloseTo(1210)
    })

    it("conoce las funciones de la lista", () => {
        expect(calcular("max(1, 5, 3)")).toBe(5)
        expect(calcular("min(a, 0)", { a: -2 })).toBe(-2)
        expect(calcular("sqrt(16) + abs(-1)")).toBe(5)
        expect(calcular("round(1.005, 2)")).toBe(1.01)
        expect(calcular("round(2.5)")).toBe(3)
        expect(calcular("log(1000) + ln(exp(2))")).toBeCloseTo(5)
        expect(calcular("pow(2, 10)")).toBe(1024)
    })

    it("devuelve los campos que usa", () => {
        expect([...hFormulaCompilar("a + max(b, c) * a").variables].sort()).toEqual(["a", "b", "c"])
    })

    it("una división entre cero da Infinity en vez de lanzar", () => {
        expect(calcular("1 / 0")).toBe(Infinity)
        expect(Number.isNaN(calcular("sqrt(-1)"))).toBe(true)
    })
})

describe("errores", () => {
    it.each([
        ["", "vacía"],
        ["2 +", "acaba antes de tiempo"],
        ["(2 + 3", "Se esperaba «)»"],
        ["2 3", "Sobra «3»"],
        ["2 # 3", "Carácter no válido «#»"],
        ["foo(1)", "«foo» no existe"],
        ["pow(1)", "argumentos"],
        ["alert(1)", "«alert» no existe"],
        ["alert('x')", "Carácter no válido «'»"],
        ["constructor", null]
    ])("«%s»", (texto, mensaje) => {
        if (mensaje === null) {
            // Un nombre de propiedad de Object no puede colarse como campo.
            expect(() => calcular(texto, {})).toThrow(HFormulaError)
            return
        }
        expect(() => hFormulaCompilar(texto)).toThrow(mensaje)
    })

    it("indica en qué carácter está el fallo", () => {
        expect(() => hFormulaCompilar("1 + * 2")).toThrow("carácter 5")
    })
})

describe("hFormulaProblema", () => {
    it("acepta una fórmula correcta con campos existentes", () => {
        expect(hFormulaProblema("a * 2", ["a"])).toBeNull()
    })

    it("avisa de un campo que no existe", () => {
        expect(hFormulaProblema("a * b", ["a"])).toBe("El campo «b» no existe")
    })

    it("devuelve el error de sintaxis como texto", () => {
        expect(hFormulaProblema("a *", ["a"])).toMatch(/acaba antes de tiempo/)
    })
})
