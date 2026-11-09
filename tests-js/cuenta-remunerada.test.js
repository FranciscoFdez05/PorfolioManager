// Mi dinero › Cuenta remunerada (js/finanzas/cuenta-remunerada.js).
//
// Lo que entra en la cuenta sin ser una aportación son los intereses netos de
// la propia cuenta y los dividendos cobrados en ella. Lo que cubre este fichero:
//
//   1. **Fechas.** Los formatos que conviven en los datos se leen y las fechas
//      imposibles no se cuelan como otro día.
//   2. **Movimientos.** Cada dividendo va a la cuenta que trae apuntada o a la
//      cobradora por defecto, con su moneda pasada a euros.
//   3. **Serie acumulada.** Empieza en 0 el 1 de enero, agrupa por día y no se
//      alarga más allá de hoy en el año en curso.
//   4. **Pintado.** La tabla sigue a la cuenta y al año, con el más reciente
//      arriba, y la cuenta elegida se conserva al volver a la página.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { beforeAll, beforeEach, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..")

beforeAll(() => {
    // Las pestañas las desplaza app-core.js, que no se carga aquí.
    globalThis.refrescarTiraPestanas = () => {}
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/cuenta-remunerada.js")
})

beforeEach(() => {
    document.body.innerHTML = readFileSync(resolve(RAIZ, "html/finanzas/cuenta-remunerada.html"), "utf-8")
    crCuentaId = null
    crAnio = null
    crDividendos = []
    crCuentasApp = []
    crTasas = new Map()
})

const interes = (fecha, acumulado, impuestos = "0,00") => ({ fecha, acumulado, impuestos })
const dividendo = (fecha, instrumento, total, cuenta = "", monedaTotal = "EUR") => ({
    fecha,
    instrumento,
    total,
    cuenta,
    monedaTotal
})
const cuentasApp = [
    { id: "tr", nombre: "Trade Republic", dividendos: true },
    { id: "rev", nombre: "Revolut", dividendos: false }
]

const movimientosDe = (opciones) =>
    construirMovimientosCuenta({
        interesRows: [],
        dividendoRows: [],
        cuentaId: "tr",
        cuentasApp,
        tasas: new Map(),
        ...opciones
    })

describe("fechas", () => {
    it("lee dd-mm-aaaa, aaaa-mm-dd y mm-aaaa", () => {
        expect(crFechaATiempo("02-11-2026")).toBe(new Date(2026, 10, 2).getTime())
        expect(crFechaATiempo("2026-11-02")).toBe(new Date(2026, 10, 2).getTime())
        expect(crFechaATiempo("11-2026")).toBe(new Date(2026, 10, 1).getTime())
        expect(crFechaATiempo("02/11/2026")).toBe(new Date(2026, 10, 2).getTime())
    })

    it("rechaza fechas ilegibles o imposibles", () => {
        expect(crFechaATiempo("")).toBeNull()
        expect(crFechaATiempo("pendiente")).toBeNull()
        expect(crFechaATiempo("31-02-2026")).toBeNull()
        expect(crFechaATiempo("01-13-2026")).toBeNull()
        expect(crFechaATiempo("01-11-26")).toBeNull()
    })
})

describe("movimientos de la cuenta", () => {
    it("los intereses suman el neto (bruto menos impuestos) y guardan su índice", () => {
        const [m] = movimientosDe({ interesRows: [interes("01-11-2026", "7,00 €", "1,40 €")] })
        expect(m).toMatchObject({ tipo: "interes", concepto: "Cuenta remunerada", indice: 0, anio: "2026" })
        expect(m.importe).toBeCloseTo(5.6)
    })

    it("solo entran los dividendos cobrados en la cuenta", () => {
        const movs = movimientosDe({
            dividendoRows: [
                dividendo("02-11-2026", "Coca-Cola", "10", "tr"),
                dividendo("03-11-2026", "Apple", "4", "rev")
            ]
        })
        expect(movs.map((m) => m.concepto)).toEqual(["Dividendo: Coca-Cola"])
        expect(movs[0].indice).toBeNull()
    })

    it("un dividendo sin cuenta (o con una borrada) va a la cobradora por defecto", () => {
        const filas = [dividendo("02-11-2026", "KO", "10"), dividendo("03-11-2026", "PEP", "5", "borrada")]
        expect(movimientosDe({ dividendoRows: filas })).toHaveLength(2)
        expect(movimientosDe({ dividendoRows: filas, cuentaId: "rev" })).toHaveLength(0)
    })

    it("una cuenta remunerada antigua sin cuenta enlazada no recibe dividendos", () => {
        expect(movimientosDe({ cuentaId: "", dividendoRows: [dividendo("02-11-2026", "KO", "10")] })).toHaveLength(0)
    })

    it("pasa a euros los dividendos en otra moneda", () => {
        const [m] = movimientosDe({
            dividendoRows: [dividendo("02-11-2026", "KO", "10", "tr", "usd")],
            tasas: new Map([["USD", 0.9]])
        })
        expect(m.importe).toBeCloseTo(9)
    })

    it("deja fuera las filas sin fecha legible y ordena por fecha", () => {
        const movs = movimientosDe({
            interesRows: [interes("05-03-2026", "1"), interes("", "9"), interes("01-01-2026", "2")],
            dividendoRows: [dividendo("01-02-2026", "KO", "3", "tr")]
        })
        expect(movs.map((m) => m.importe)).toEqual([2, 3, 1])
    })
})

describe("serie acumulada", () => {
    const hoy = new Date(2026, 10, 9)

    it("empieza en 0 el 1 de enero, agrupa por día y acaba hoy en el año en curso", () => {
        const movs = movimientosDe({
            interesRows: [interes("01-11-2026", "5,60")],
            dividendoRows: [dividendo("01-11-2026", "KO", "10", "tr"), dividendo("02-03-2026", "PEP", "1", "tr")]
        })
        const puntos = acumularMovimientosAnio(movs, "2026", hoy)
        expect(puntos.map((p) => p.t)).toEqual([
            new Date(2026, 0, 1).getTime(),
            new Date(2026, 2, 2).getTime(),
            new Date(2026, 10, 1).getTime(),
            new Date(2026, 10, 9).getTime()
        ])
        expect(puntos.map((p) => p.y)).toEqual([0, 1, expect.closeTo(16.6), expect.closeTo(16.6)])
        expect(puntos[2].movimientos).toHaveLength(2)
    })

    it("un cobro el 1 de enero no se come el punto de partida en 0", () => {
        const puntos = acumularMovimientosAnio(
            movimientosDe({ interesRows: [interes("01-01-2025", "4")] }),
            "2025",
            hoy
        )
        expect(puntos.slice(0, 2).map((p) => [p.t, p.y])).toEqual([
            [new Date(2025, 0, 1).getTime(), 0],
            [new Date(2025, 0, 1).getTime(), 4]
        ])
    })

    it("un año pasado llega hasta el 31 de diciembre", () => {
        const puntos = acumularMovimientosAnio(
            movimientosDe({ interesRows: [interes("01-06-2025", "3")] }),
            "2025",
            hoy
        )
        expect(puntos.at(-1)).toMatchObject({ t: new Date(2025, 11, 31).getTime(), y: 3 })
    })

    it("un año sin movimientos no tiene serie", () => {
        expect(
            acumularMovimientosAnio(movimientosDe({ interesRows: [interes("01-06-2025", "3")] }), "2026", hoy)
        ).toEqual([])
    })
})

describe("pintado de la página", () => {
    const filasTabla = () =>
        [...document.querySelectorAll("#crBody tr")].map((tr) =>
            [...tr.cells].map((td) => td.textContent.trim().replace(/\s/g, " "))
        )
    const datos = {
        cuentas: [
            { id: "c1", nombre: "Trade Republic", cuenta: "tr", rows: [interes("01-11-2026", "5,60")] },
            { id: "c2", nombre: "Revolut", cuenta: "rev", rows: [interes("01-10-2025", "2")] }
        ]
    }

    beforeEach(() => {
        crDividendos = [dividendo("02-11-2026", "Coca-Cola", "10", "tr")]
        crCuentasApp = cuentasApp
        crMostrarDatos(datos)
        crBindEventos()
    })

    it("muestra intereses y dividendos del último año, el más reciente arriba", () => {
        expect(crAnio).toBe("2026")
        expect(filasTabla()).toEqual([
            ["02-11-2026", "Dividendo: Coca-Cola", "+10,00 €"],
            ["01-11-2026", "Cuenta remunerada", "+5,60 €"]
        ])
        expect(document.getElementById("crTotalAnio").textContent).toBe("+15,60 €")
        expect(document.getElementById("crEmptyMsg").classList.contains("hidden")).toBe(true)
    })

    it("pinta una pestaña por cuenta con la elegida activa", () => {
        const pestanas = [...document.querySelectorAll("#crCuentasList [data-cr-cuenta]")]
        expect(pestanas.map((b) => b.textContent)).toEqual(["Trade Republic", "Revolut"])
        expect(pestanas[0].classList.contains("active")).toBe(true)
    })

    it("al pulsar otra cuenta cambian los años y los movimientos", () => {
        document.querySelector('[data-cr-cuenta="c2"]').click()
        expect(crAnio).toBe("2025")
        expect([...document.querySelectorAll("#crYearList button")].map((b) => b.textContent)).toEqual(["2025"])
        expect(filasTabla()).toEqual([["01-10-2025", "Cuenta remunerada", "+2,00 €"]])
    })

    it("al volver a la página conserva la cuenta elegida", () => {
        crSeleccionarCuenta("c2")
        crMostrarDatos(datos)
        expect(crCuentaId).toBe("c2")
    })

    it("sin cuentas remuneradas avisa de dónde crearlas", () => {
        crCuentaId = null
        crMostrarDatos({ cuentas: [] })
        const aviso = document.getElementById("crEmptyMsg")
        expect(aviso.classList.contains("hidden")).toBe(false)
        expect(aviso.textContent).toContain("Bolsa e Inversión")
        expect(filasTabla()).toEqual([])
    })
})
