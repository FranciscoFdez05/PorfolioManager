// Pruebas del reparto de un gasto fraccionado (js/finanzas/gastos.js).
//
// Un pago de 90 € entre tres cuesta 90 € a la cuenta que paga y 30 € a la
// categoría. Se registra en dos filas de gasto y un ingreso por persona que
// devuelve; si el reparto se calcula mal, el saldo de las cuentas o la
// categoría quedan descuadrados sin ningún error visible.
import { beforeAll, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/gastos.js")
})

const BASE = { fecha: "05-03-2026", nombre: "Cena", tipo: "Comidas", cuenta: "santander", nota: "" }

describe("calcularRepartoFraccionado", () => {
    it("tu parte es el total menos lo devuelto", () => {
        const reparto = calcularRepartoFraccionado("90", ["30", "30"])
        expect(reparto).toEqual({ parte: 3000, devuelto: 6000, total: 9000 })
    })

    it("no arrastra error de coma flotante con céntimos", () => {
        const reparto = calcularRepartoFraccionado("100", ["33,33", "33,33"])
        expect(reparto.parte).toBe(3334)
    })

    it("rechaza un total vacío o cero", () => {
        expect(calcularRepartoFraccionado("", ["10"]).error).toBeTruthy()
        expect(calcularRepartoFraccionado("0", ["10"]).error).toBeTruthy()
    })

    it("rechaza no tener ninguna devolución con importe", () => {
        expect(calcularRepartoFraccionado("90", []).error).toBeTruthy()
        expect(calcularRepartoFraccionado("90", ["", "0"]).error).toBeTruthy()
    })

    it("rechaza devolver más de lo pagado", () => {
        expect(calcularRepartoFraccionado("90", ["60", "40"]).error).toBeTruthy()
    })

    it("admite que te devuelvan todo", () => {
        expect(calcularRepartoFraccionado("90", ["90"]).parte).toBe(0)
    })
})

describe("emparejar la parte propia con la de otros", () => {
    const generar = (extra = {}) =>
        construirFilasFraccionado({
            ...BASE,
            ...extra,
            total: "90",
            devoluciones: [{ cantidad: "60", cuenta: "revolut" }]
        })

    it("encuentra la fila de otros de una fila propia y oculta solo esa", () => {
        const { gastos } = generar()
        const filas = [{ fecha: "01-03-2026", nombre: "Otro", tipo: "Comidas", cantidad: "5,00 €", cuenta: "" }, ...gastos]

        expect(buscarFilaParteOtros(filas, filas[1])).toBe(2)
        expect(buscarFilaParteOtros(filas, filas[0])).toBe(-1)
        expect([...indicesParteOtrosOcultas(filas)]).toEqual([2])
    })

    it("una fila de otros sin fila propia no se oculta", () => {
        const { gastos } = generar()
        expect(indicesParteOtrosOcultas([gastos[1]]).size).toBe(0)
    })

    it("no empareja con otra cena de otra fecha", () => {
        const a = generar()
        const b = generar({ fecha: "06-03-2026" })
        const filas = [a.gastos[0], b.gastos[0], b.gastos[1]]
        expect(buscarFilaParteOtros(filas, filas[0])).toBe(-1)
        expect(buscarFilaParteOtros(filas, filas[1])).toBe(2)
    })

    it("guarda el nombre de quien devuelve y lo recupera al editar", () => {
        const { ingresos } = construirFilasFraccionado({
            ...BASE,
            total: "90",
            devoluciones: [
                { nombre: "Parte Antonio", cantidad: "30", cuenta: "revolut" },
                { nombre: "", cantidad: "30", cuenta: "" }
            ]
        })

        expect(ingresos[0].nombre).toBe("Devolución: Cena (Parte Antonio)")
        expect(ingresos[1].nombre).toBe("Devolución: Cena")
        expect(personaDeDevolucion(ingresos[0], "Cena")).toBe("Parte Antonio")
        expect(personaDeDevolucion(ingresos[1], "Cena")).toBe("")
        expect(ingresos.every((i) => esDevolucionDe(i, "05-03-2026", "Cena"))).toBe(true)
    })

    it("un concepto que empieza igual no se confunde con otro", () => {
        const ingreso = { tipo: TIPO_GASTO_FRACCIONADO, fecha: "05-03-2026", nombre: "Devolución: Cena de cumple (Pedro)" }
        expect(esDevolucionDe(ingreso, "05-03-2026", "Cena")).toBe(false)
        expect(esDevolucionDe(ingreso, "05-03-2026", "Cena de cumple")).toBe(true)
    })

    it("quita los paréntesis del nombre para poder leerlo de vuelta", () => {
        expect(nombreDevolucion("Cena", "Ana (prima)")).toBe("Devolución: Cena (Ana prima)")
    })

    it("reconoce las devoluciones de un gasto por concepto y fecha", () => {
        const { ingresos } = generar()
        expect(esDevolucionDe(ingresos[0], "05-03-2026", "Cena")).toBe(true)
        expect(esDevolucionDe(ingresos[0], "06-03-2026", "Cena")).toBe(false)
        expect(esDevolucionDe({ ...ingresos[0], tipo: "Nómina" }, "05-03-2026", "Cena")).toBe(false)
    })
})

describe("historial de una cuenta", () => {
    const movimiento = (campos) => ({ origen: "gasto", fecha: "13-11-2026", ...campos })
    const propio = movimiento({ id: 1, nombre: "Tokio", contraparte: "Comidas/Cenas", cantidad: "21,20 €" })
    const otros = movimiento({ id: 2, nombre: "Tokio (parte de otros)", contraparte: "Pagos fraccionados", cantidad: "48,00 €" })
    const devolucion = { origen: "ingreso", fecha: "13-11-2026", nombre: "Devolución: Tokio (miguel)", cantidad: "23,00 €" }

    it("junta tu parte y la de otros en un solo pago con el total", () => {
        const resultado = unirGastosFraccionados([otros, propio, devolucion])

        expect(resultado).toHaveLength(2)
        expect(resultado[0]).toMatchObject({ nombre: "Tokio", contraparte: "Comidas/Cenas", fraccionado: true })
        expect(parseEuroNumber(resultado[0].cantidad)).toBe(69.2)
        expect(resultado[1]).toBe(devolucion)
    })

    it("no toca un gasto normal ni una fila de otros sin pareja", () => {
        const normal = movimiento({ id: 3, nombre: "Steam", contraparte: "Compras", cantidad: "10,00 €" })
        expect(unirGastosFraccionados([normal, otros])).toEqual([normal, otros])
    })

    it("no junta con un gasto de otra fecha", () => {
        const otroDia = { ...propio, fecha: "14-11-2026" }
        expect(unirGastosFraccionados([otroDia, otros])).toHaveLength(2)
    })

    it("no modifica los movimientos de entrada", () => {
        const entrada = [propio, otros]
        unirGastosFraccionados(entrada)
        expect(entrada).toEqual([propio, otros])
        expect(propio.fraccionado).toBeUndefined()
    })
})

describe("detalle de las devoluciones", () => {
    it("lista cada devolución con su nombre, cuenta e importe", () => {
        const html = htmlDevolucionesDetalle([
            { nombre: "Parte Antonio", cantidad: "30,00 €", cuenta: "" },
            { nombre: "", cantidad: "30,00 €", cuenta: "efectivo" }
        ])
        expect(html).toContain("Devoluciones (2)")
        expect(html).toContain("Parte Antonio")
        expect(html).toContain("Sin nombre")
    })

    it("escapa el nombre para que no inyecte HTML", () => {
        const html = htmlDevolucionesDetalle([{ nombre: "<b>x</b>", cantidad: "1,00 €", cuenta: "" }])
        expect(html).not.toContain("<b>x</b>")
    })

    it("avisa cuando no hay ingresos de devoluciones", () => {
        expect(htmlDevolucionesDetalle([])).toContain("Sin ingresos de devoluciones")
    })
})

describe("construirFilasFraccionado", () => {
    it("genera tu parte, lo adelantado y un ingreso por persona", () => {
        const filas = construirFilasFraccionado({
            ...BASE,
            total: "90",
            devoluciones: [
                { cantidad: "30", cuenta: "revolut" },
                { cantidad: "30", cuenta: "efectivo" }
            ]
        })

        expect(filas.gastos).toHaveLength(2)
        expect(filas.gastos[0]).toMatchObject({ tipo: "Comidas", cuenta: "santander" })
        expect(parseEuroNumber(filas.gastos[0].cantidad)).toBe(30)
        expect(filas.gastos[1]).toMatchObject({ tipo: TIPO_GASTO_FRACCIONADO, cuenta: "santander" })
        expect(parseEuroNumber(filas.gastos[1].cantidad)).toBe(60)

        expect(filas.ingresos.map((i) => i.cuenta)).toEqual(["revolut", "efectivo"])
        expect(filas.ingresos.every((i) => i.tipo === TIPO_GASTO_FRACCIONADO)).toBe(true)
    })

    it("el saldo cuadra: lo que sale de la cuenta es tu parte más lo adelantado", () => {
        const filas = construirFilasFraccionado({
            ...BASE,
            total: "90",
            devoluciones: [{ cantidad: "30", cuenta: "" }, { cantidad: "30", cuenta: "" }]
        })
        const salido = filas.gastos.reduce((suma, fila) => suma + parseEuroNumber(fila.cantidad), 0)
        expect(salido).toBe(90)
    })

    it("sin parte propia la fila de la categoría se crea a cero", () => {
        const filas = construirFilasFraccionado({
            ...BASE,
            total: "50",
            devoluciones: [{ cantidad: "50", cuenta: "revolut" }]
        })
        expect(filas.gastos).toHaveLength(2)
        expect(parseEuroNumber(filas.gastos[0].cantidad)).toBe(0)
        expect(filas.gastos[0].tipo).toBe("Comidas")
    })

    it("ignora las devoluciones sin importe", () => {
        const filas = construirFilasFraccionado({
            ...BASE,
            total: "90",
            devoluciones: [{ cantidad: "30", cuenta: "revolut" }, { cantidad: "", cuenta: "efectivo" }]
        })
        expect(filas.ingresos).toHaveLength(1)
    })

    it("devuelve el error del reparto en vez de filas", () => {
        const filas = construirFilasFraccionado({ ...BASE, total: "10", devoluciones: [{ cantidad: "20", cuenta: "" }] })
        expect(filas.error).toBeTruthy()
        expect(filas.gastos).toBeUndefined()
    })
})
