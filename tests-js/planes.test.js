// Pruebas de la aritmética de js/cartera/planes.js.
//
// Un plan no guarda ningún número calculado: lo que se ve en la tarjeta —lo que
// falta para el objetivo, cuántos aportes llevas— se deriva del precio de hoy
// cada vez que se pinta. Eso quiere decir que un fallo aquí no da un error: da
// un número equivocado, que es exactamente lo que el linter no puede ver.
//
// El caso que más se puede torcer, y por el que existe este fichero: **el plan a
// medio escribir**. Sin precio de mercado, sin capital o con una entrada a cero
// hay que dejar el hueco en blanco, no rellenarlo con un cero que se lee como un
// dato bueno.
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    // El orden es el de index.html: planes.js usa `escapeHtml` de dom.js,
    // `parseLooseNumber` de shared-utils.js y `parseAssetOperationDate` de
    // assets.js.
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cartera/assets.js")
    cargarScript("js/cartera/planes.js")
})

beforeEach(() => {
    _planesAsset = null
})

/** El precio sale del activo cuya ficha está abierta, y de ningún otro sitio. */
function conActivoA(precioActual) {
    _planesAsset = { id: "a", name: "Activo", symbol: "TEST", price: precioActual, currency: "EUR" }
}

const PLAN = {
    id: "p",
    assetId: "a",
    precioEntrada: "100",
    precioSalida: "150",
    capital: "1000"
}

describe("planCalcular", () => {
    const c = (campos = {}, precio = "120") => {
        conActivoA(precio)
        return planCalcular({ ...PLAN, ...campos })
    }

    it("dice cuánto tiene que subir el precio para llegar al objetivo", () => {
        // De 120 a 150 hay un 25 %: es el dato que preside la tarjeta.
        expect(c().hastaObjetivo).toBeCloseTo(25, 6)
    })

    it("dice cuánto tiene que caer para volver a la zona de entrada", () => {
        expect(c().hastaEntrada).toBeCloseTo(-16.666666, 4)
    })

    it("mide el recorrido desde la entrada, no desde el precio de hoy", () => {
        // El plan no cambia porque el precio se mueva: de 100 a 150 se gana un
        // 50 %, valga hoy lo que valga.
        expect(c().recorrido).toBeCloseTo(50, 6)
    })

    it("traduce el plan a dinero con el capital previsto", () => {
        expect(c().unidades).toBeCloseTo(10, 6)
        expect(c().beneficio).toBeCloseTo(500, 6)
    })

    it("sitúa el precio en el recorrido que va de la entrada al objetivo", () => {
        // De 100 a 150 hay 50; el precio está en 120, a un 40 % del camino.
        expect(c().progreso).toBeCloseTo(40, 6)
    })

    it.each([
        ["120", ""],
        ["100", "entrada"],
        ["95", "entrada"],
        ["150", "objetivo"],
        ["160", "objetivo"]
    ])("con el precio en %s avisa de «%s»", (precio, esperado) => {
        expect(c({}, precio).aviso).toBe(esperado)
    })

    it("un objetivo por debajo de la entrada sale en negativo, no del revés", () => {
        // Aquí no hay cortos: un plan así está mal escrito, y verlo en rojo es
        // justo lo que hace falta para corregirlo.
        expect(c({ precioSalida: "70" }).recorrido).toBeCloseTo(-30, 6)
        expect(c({ precioSalida: "70" }).beneficio).toBeCloseTo(-300, 6)
    })
})

describe("planCalcular · datos incompletos", () => {
    it("sin precio actual no se inventa ningún porcentaje", () => {
        _planesAsset = { id: "a", price: "", currency: "EUR" }
        const c = planCalcular(PLAN)

        expect(c.actual).toBeNull()
        expect(c.hastaObjetivo).toBeNull()
        expect(c.aviso).toBe("")
        // Lo que no depende del precio sí se calcula: el plan se puede evaluar
        // antes de tener cotización.
        expect(c.recorrido).toBeCloseTo(50, 6)
    })

    it("sin ficha abierta no hay precio ni moneda que suponer", () => {
        const c = planCalcular(PLAN)

        expect(c.actual).toBeNull()
        expect(c.currency).toBe("EUR")
    })

    it("un precio de entrada de cero no da un recorrido del 0 %", () => {
        conActivoA("120")
        const c = planCalcular({ ...PLAN, precioEntrada: "0" })

        expect(c.recorrido).toBeNull()
        expect(c.unidades).toBeNull()
        expect(c.beneficio).toBeNull()
    })

    it("sin capital no hay beneficio potencial que estimar", () => {
        conActivoA("120")
        const c = planCalcular({ ...PLAN, capital: "" })

        expect(c.unidades).toBeNull()
        expect(c.beneficio).toBeNull()
        expect(c.recorrido).toBeCloseTo(50, 6)
    })

    it("lee los importes en formato español", () => {
        conActivoA("120")
        expect(planCalcular({ ...PLAN, precioEntrada: "1.234,50" }).entrada).toBeCloseTo(1234.5, 6)
    })

    it("toma la moneda del activo, no la del plan", () => {
        // El plan guarda la moneda con la que se creó; la que manda es la del
        // activo, porque es la del precio con el que se está comparando.
        _planesAsset = { id: "a", price: "120", currency: "USD" }
        expect(planCalcular({ ...PLAN, currency: "EUR" }).currency).toBe("USD")
    })
})
