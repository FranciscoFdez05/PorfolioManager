// Pruebas de la aritmética de js/cartera/planes.js.
//
// Un plan no guarda ningún número calculado: lo que se ve en la tarjeta —lo que
// falta para el objetivo, cuántos aportes llevas— se deriva del precio de hoy
// cada vez que se pinta. Eso quiere decir que un fallo aquí no da un error: da
// un número equivocado, que es exactamente lo que el linter no puede ver.
//
// Los dos casos que más se pueden torcer, y por los que existe este fichero:
//
//   1. **El plan a medio escribir.** Sin precio de mercado, sin capital o con
//      una entrada a cero hay que dejar el hueco en blanco, no rellenarlo con
//      un cero que se lee como un dato bueno.
//   2. **El calendario mensual.** Un plan empezado un día 31 tiene que caer en
//      el último día de febrero y volver al 31 en marzo. Sumando periodos de 30
//      días, ni las fechas ni el número de aportes cuadran.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
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

describe("dcaFechaAporte", () => {
    const enero31 = new Date(2026, 0, 31)

    it("el aporte 0 es el propio día de inicio", () => {
        expect(dcaFechaAporte(enero31, "Mensual", 0)).toEqual(new Date(2026, 0, 31))
    })

    it("un plan mensual empezado el 31 cae al último día de febrero", () => {
        expect(dcaFechaAporte(enero31, "Mensual", 1)).toEqual(new Date(2026, 1, 28))
    })

    it("y vuelve al 31 en marzo, en vez de quedarse en el 28", () => {
        // Esto es lo que se pierde al ir sumando periodos uno a uno: el recorte
        // de febrero se arrastraría a todos los meses siguientes.
        expect(dcaFechaAporte(enero31, "Mensual", 2)).toEqual(new Date(2026, 2, 31))
    })

    it("respeta el 29 de febrero de un año bisiesto", () => {
        expect(dcaFechaAporte(new Date(2024, 0, 31), "Mensual", 1)).toEqual(new Date(2024, 1, 29))
    })

    it("suma doce meses exactos al cabo de un año", () => {
        expect(dcaFechaAporte(new Date(2026, 5, 15), "Mensual", 12)).toEqual(new Date(2027, 5, 15))
    })

    it.each([
        ["Semanal", 3, new Date(2026, 0, 22)],
        ["Quincenal", 2, new Date(2026, 0, 29)],
        ["Trimestral", 2, new Date(2026, 6, 1)]
    ])("calcula la periodicidad %s", (frecuencia, indice, esperada) => {
        expect(dcaFechaAporte(new Date(2026, 0, 1), frecuencia, indice)).toEqual(esperada)
    })
})

describe("dcaCalcular", () => {
    const PLAN_DCA = {
        id: "d",
        assetId: "a",
        estado: "Activo",
        importe: "300",
        frecuencia: "Mensual",
        fechaInicio: "15-01-2026"
    }

    function conFecha(hoy, campos = {}) {
        conActivoA("")
        vi.useFakeTimers()
        vi.setSystemTime(hoy)
        try {
            return dcaCalcular({ ...PLAN_DCA, ...campos })
        } finally {
            vi.useRealTimers()
        }
    }

    it("cuenta los aportes ya vencidos y anuncia el siguiente", () => {
        const c = conFecha(new Date(2026, 2, 20, 12))

        // 15 de enero, 15 de febrero y 15 de marzo ya han pasado.
        expect(c.realizados).toBe(3)
        expect(c.proximo).toEqual(new Date(2026, 3, 15))
        expect(c.diasParaProximo).toBe(26)
        expect(c.invertido).toBeCloseTo(900, 6)
    })

    it("el aporte del propio día cuenta como hecho", () => {
        expect(conFecha(new Date(2026, 0, 15, 9)).realizados).toBe(1)
    })

    it("un plan que aún no ha empezado no lleva ninguno", () => {
        const c = conFecha(new Date(2025, 11, 1))

        expect(c.realizados).toBe(0)
        expect(c.proximo).toEqual(new Date(2026, 0, 15))
    })

    it("un plan pausado no anuncia el siguiente aporte", () => {
        const c = conFecha(new Date(2026, 2, 20), { estado: "Pausado" })

        expect(c.proximo).toBeNull()
        // Lo que llevaba hecho sí se conserva: es información, no una previsión.
        expect(c.realizados).toBe(3)
    })

    it("el objetivo de aportes cierra el plan y llena la barra", () => {
        const c = conFecha(new Date(2026, 5, 20), { aportesObjetivo: "3" })

        expect(c.realizados).toBe(3)
        expect(c.proximo).toBeNull()
        expect(c.progreso).toBeCloseTo(100, 6)
        expect(c.planificado).toBeCloseTo(900, 6)
    })

    it("la fecha de fin también corta el calendario", () => {
        const c = conFecha(new Date(2026, 5, 20), { fechaFin: "28-02-2026" })

        expect(c.realizados).toBe(2)
        expect(c.proximo).toBeNull()
    })

    it.each([
        ["Semanal", (300 * 52) / 12],
        ["Quincenal", (300 * 26) / 12],
        ["Mensual", 300],
        ["Trimestral", 100]
    ])("expresa un plan %s en dinero al mes", (frecuencia, esperado) => {
        // Sin esta equivalencia no hay forma de comparar un plan semanal con uno
        // trimestral, ni de sumarlos en el resumen de la pestaña.
        expect(conFecha(new Date(2026, 2, 20), { frecuencia }).equivalenteMensual).toBeCloseTo(esperado, 6)
    })

    it("sin fecha de inicio no cuenta ningún aporte", () => {
        const c = conFecha(new Date(2026, 2, 20), { fechaInicio: "" })

        expect(c.realizados).toBe(0)
        expect(c.proximo).toBeNull()
    })

    it("avisa cuando el precio del activo supera el máximo de compra", () => {
        conActivoA("140")
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 2, 20))
        try {
            expect(dcaCalcular({ ...PLAN_DCA, precioMaximo: "120" }).porEncimaDelMaximo).toBe(true)
            expect(dcaCalcular({ ...PLAN_DCA, precioMaximo: "150" }).porEncimaDelMaximo).toBe(false)
        } finally {
            vi.useRealTimers()
        }
    })
})

describe("dcaProximosAportes", () => {
    function proximos(campos, hoy, cuantos) {
        conActivoA("")
        vi.useFakeTimers()
        vi.setSystemTime(hoy)
        try {
            return dcaProximosAportes(
                {
                    id: "d",
                    assetId: "a",
                    estado: "Activo",
                    importe: "300",
                    frecuencia: "Mensual",
                    fechaInicio: "15-01-2026",
                    ...campos
                },
                cuantos
            )
        } finally {
            vi.useRealTimers()
        }
    }

    it("empieza por el primer aporte pendiente y acumula el total invertido", () => {
        const filas = proximos({}, new Date(2026, 2, 20), 3)

        expect(filas.map((f) => f.numero)).toEqual([4, 5, 6])
        expect(filas[0].fecha).toEqual(new Date(2026, 3, 15))
        // El acumulado incluye lo ya aportado: es el total al que se llega, no
        // lo que queda por meter.
        expect(filas[0].acumulado).toBeCloseTo(1200, 6)
    })

    it("no pasa del número de aportes objetivo", () => {
        expect(proximos({ aportesObjetivo: "5" }, new Date(2026, 2, 20), 12)).toHaveLength(2)
    })

    it("no pasa de la fecha de fin", () => {
        expect(proximos({ fechaFin: "30-06-2026" }, new Date(2026, 2, 20), 12)).toHaveLength(3)
    })

    it("sin importe no hay calendario que enseñar", () => {
        expect(proximos({ importe: "" }, new Date(2026, 2, 20), 12)).toEqual([])
    })
})
