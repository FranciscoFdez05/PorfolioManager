// Pruebas de los cálculos de la página Ahorro (js/finanzas/ahorro-calculos.js).
//
// Todo lo que enseña la página se deriva de los datos de Gastos e Ingresos:
// un fallo aquí no rompe nada visible, da una cifra creíble y equivocada. Se
// cubren los totales del mes (mensualidades y recurrentes incluidos), las
// comparativas que cruzan de año, el presupuesto en % y en €, el acumulado y
// la proyección, la racha y las observaciones.
import { beforeAll, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/ahorro-calculos.js")
})

const C = () => AhorroCalculos

function anioIngresos(porMes, recurrentes = []) {
    const months = {}
    for (const [mes, cantidades] of Object.entries(porMes)) {
        months[mes] = { rows: cantidades.map((cantidad) => ({ cantidad: String(cantidad) })) }
    }
    return { months, recurrentes }
}

function anioGastos(porMes, mensualidades = []) {
    const months = {}
    for (const [mes, filas] of Object.entries(porMes)) {
        months[mes] = { rows: filas.map(([tipo, cantidad]) => ({ tipo, cantidad: String(cantidad) })) }
    }
    return { months, mensualidades, gastosTipos: [] }
}

describe("totales del mes", () => {
    it("suma movimientos sueltos y recurrentes en los ingresos", () => {
        const datos = anioIngresos({ marzo: [1000, "250,50"] }, [{ meses: { marzo: "300" } }])
        expect(C().ingresosDelMes(datos, "marzo")).toBeCloseTo(1550.5)
        expect(C().ingresosDelMes(null, "marzo")).toBe(0)
    })

    it("agrupa los gastos por categoría y mete las mensualidades en «Mensualidades»", () => {
        const datos = anioGastos(
            {
                marzo: [
                    ["Casa", 600],
                    ["  ", 20],
                    ["mensualidades", 5],
                    ["Ocio", 0]
                ]
            },
            [{ meses: { marzo: "15" } }]
        )
        expect(C().gastosPorCategoriaDelMes(datos, "marzo")).toEqual({
            Casa: 600,
            "Sin categoría": 20,
            Mensualidades: 20
        })
    })

    it("un mes sin ingresos tiene tasa null, no 0 %", () => {
        const resumen = C().resumenMes(null, anioGastos({ enero: [["Casa", 100]] }), "enero")
        expect(resumen.tasa).toBeNull()
        expect(resumen.ahorro).toBe(-100)
        expect(resumen.tieneDatos).toBe(true)
    })
})

describe("categorías marcadas como inversión", () => {
    const ingresos = anioIngresos({ marzo: [2000] })
    const gastos = anioGastos({
        marzo: [
            ["Casa", 800],
            ["Fondos", 500],
            ["fondos ", 100]
        ]
    })
    const marcadas = { categoriasInversion: ["Fondos"] }

    it("sin categorías marcadas (por defecto) todo es gasto", () => {
        const resumen = C().resumenMes(ingresos, gastos, "marzo")
        expect(resumen.gastos).toBe(1400)
        expect(resumen.inversion).toBe(0)
    })

    it("lo marcado no cuenta ni como gasto ni como ahorro, sin distinguir mayúsculas ni tildes", () => {
        const resumen = C().resumenMes(ingresos, gastos, "marzo", marcadas)
        expect(resumen.gastos).toBe(800)
        expect(resumen.inversion).toBe(600)
        // 2000 - 800 de gasto - 600 invertidos: lo que queda en cuenta.
        expect(resumen.ahorro).toBe(600)
        expect(resumen.tasa).toBe(30)
        expect(resumen.categorias).toEqual({ Casa: 800 })
        expect(C().detectorDeInversion(["Inversión"])("INVERSION")).toBe(true)
    })

    it("una mensualidad de una categoría marcada es inversión, no «Mensualidades»", () => {
        const conAportacion = anioGastos({ marzo: [["Casa", 800]] }, [
            { categoria: "Fondos", meses: { marzo: "250" } },
            { categoria: "Streaming", meses: { marzo: "15" } }
        ])
        const resumen = C().resumenMes(ingresos, conAportacion, "marzo", marcadas)
        expect(resumen.inversion).toBe(250)
        expect(resumen.categorias).toEqual({ Casa: 800, Mensualidades: 15 })
    })

    it("un mes con solo inversión tiene datos y suma en los acumulados", () => {
        const soloInversion = anioGastos({ abril: [["Fondos", 300]] })
        expect(C().resumenMes(null, soloInversion, "abril", marcadas).tieneDatos).toBe(true)
        const serie = C().serieAnual({ 2026: ingresos }, { 2026: gastos }, "2026", marcadas)
        expect(C().sumarResumenes(serie).inversion).toBe(600)
    })

    it("la observación dice cuánto se invirtió", () => {
        const resumen = C().resumenMes(ingresos, gastos, "marzo", marcadas)
        const textos = C()
            .generarObservaciones({ resumen, filas: [], objetivo: 30, etiquetaPrevio: "febrero" })
            .map((o) => o.texto)
        expect(textos).toContain("Has invertido 600,00 € (el 30 % de tus ingresos).")
    })
})

describe("comparativas", () => {
    it("el mes anterior a enero es diciembre del año anterior", () => {
        expect(C().mesAnterior("2026", "enero")).toEqual({ anio: "2025", mes: "diciembre" })
        expect(C().mesAnterior("2026", "marzo")).toEqual({ anio: "2026", mes: "febrero" })
    })

    it("ultimosMeses cruza de año y devuelve orden cronológico", () => {
        const ingresos = { 2025: anioIngresos({ diciembre: [900] }), 2026: anioIngresos({ enero: [1000] }) }
        const serie = C().ultimosMeses(ingresos, {}, "2026", "febrero", 3)
        expect(serie.map((r) => `${r.mes}-${r.anio}`)).toEqual(["diciembre-2025", "enero-2026", "febrero-2026"])
        expect(serie.map((r) => r.ingresos)).toEqual([900, 1000, 0])
    })

    it("la variación no da porcentaje si el valor previo es cero", () => {
        expect(C().variacion(150, 100)).toEqual({ diferencia: 50, porcentaje: 50 })
        expect(C().variacion(80, -100).porcentaje).toBe(180)
        expect(C().variacion(50, 0)).toEqual({ diferencia: 50, porcentaje: null })
    })
})

describe("presupuesto", () => {
    const config = {
        objetivoAhorro: 20,
        presupuesto: { Ocio: 10, Casa: 30 },
        presupuestoEur: { Casa: 500, Transporte: 100 }
    }

    it("el importe fijo manda sobre el porcentaje y se multiplica por los meses", () => {
        expect(C().presupuestoDe(config, "Casa", 2000, 1)).toEqual({ modo: "eur", valor: 500, importe: 500 })
        expect(C().presupuestoDe(config, "Casa", 24000, 12).importe).toBe(6000)
        expect(C().presupuestoDe(config, "Ocio", 2000, 1)).toEqual({ modo: "pct", valor: 10, importe: 200 })
        expect(C().presupuestoDe(config, "Viajes", 2000, 1)).toBeNull()
    })

    it("sin ingresos un presupuesto en % vale 0, no negativo", () => {
        expect(C().presupuestoDe(config, "Ocio", -300, 1).importe).toBe(0)
    })

    it("las filas incluyen categorías presupuestadas sin gasto y marcan el estado", () => {
        const resumen = C().resumenMes(
            anioIngresos({ mayo: [2000] }),
            anioGastos({
                mayo: [
                    ["Casa", 520],
                    ["Ocio", 185],
                    ["Regalos", 40]
                ]
            }),
            "mayo"
        )
        const previo = C().resumenMes(anioIngresos({ abril: [2000] }), anioGastos({ abril: [["Casa", 500]] }), "abril")
        const filas = C().filasPresupuesto(resumen, previo, config)
        const porNombre = Object.fromEntries(filas.map((f) => [f.categoria, f]))

        expect(filas.map((f) => f.categoria)).toEqual(["Casa", "Ocio", "Regalos", "Transporte"])
        expect(porNombre.Casa.estado).toBe("excedido")
        expect(porNombre.Casa.disponible).toBe(-20)
        expect(porNombre.Ocio.estado).toBe("cerca")
        expect(porNombre.Regalos.estado).toBe("sinPresupuesto")
        expect(porNombre.Transporte).toMatchObject({ gastado: 0, estado: "ok", disponible: 100 })
        expect(porNombre.Casa.variacion).toEqual({ diferencia: 20, porcentaje: 4 })
        expect(porNombre.Ocio.variacion.porcentaje).toBeNull()
    })

    it("sin periodo previo con datos no hay variación por categoría", () => {
        const resumen = C().resumenMes(anioIngresos({ mayo: [1000] }), anioGastos({ mayo: [["Casa", 100]] }), "mayo")
        const vacio = C().resumenMes(null, null, "abril")
        expect(C().filasPresupuesto(resumen, vacio, {})[0].variacion).toBeNull()
    })
})

describe("ingresos sobre los que se aplican los %", () => {
    it("un periodo cerrado usa sus ingresos reales aunque la media sea mayor", () => {
        expect(C().ingresosParaPresupuesto(525, null, 795)).toEqual({ importe: 525, conMedia: false })
    })

    it("el mes en curso a medio cobrar cuenta con la media", () => {
        expect(C().ingresosParaPresupuesto(525, 525, 795)).toEqual({ importe: 795, conMedia: true })
    })

    it("si en el mes en curso ya se ha cobrado más que la media, manda lo cobrado", () => {
        expect(C().ingresosParaPresupuesto(1200, 1200, 795)).toEqual({ importe: 1200, conMedia: false })
    })

    it("en la vista anual solo se sustituye el mes en curso", () => {
        // Enero a octubre: 7950 cobrados; noviembre, 525 de 795 de media.
        const base = C().ingresosParaPresupuesto(7950 + 525, 525, 795)
        expect(base.importe).toBeCloseTo(7950 + 795)
        expect(base.conMedia).toBe(true)
    })

    it("sin media (año sin datos) no cambia nada", () => {
        expect(C().ingresosParaPresupuesto(0, 0, 0)).toEqual({ importe: 0, conMedia: false })
    })

    it("las filas aplican los % a la base indicada y no a los ingresos del mes", () => {
        // Caso real: 10 % para Mensualidades, 71,96 € cargados el día 1 y solo
        // 525 € cobrados el día 10. Con 525 salía «excedido» (52,50 €).
        const resumen = C().resumenMes(
            anioIngresos({ noviembre: [525] }),
            anioGastos({ noviembre: [] }, [{ meses: { noviembre: "71,96" } }]),
            "noviembre"
        )
        const config = { presupuesto: { Mensualidades: 10 }, presupuestoEur: {} }
        const [conMes] = C().filasPresupuesto(resumen, null, config)
        const [conMedia] = C().filasPresupuesto(resumen, null, config, 794.97)

        expect(conMes.presupuesto.importe).toBeCloseTo(52.5)
        expect(conMes.estado).toBe("excedido")
        expect(conMedia.presupuesto.importe).toBeCloseTo(79.497)
        expect(conMedia.estado).toBe("cerca")
    })
})

describe("acumulado, proyección y racha", () => {
    // Enero a abril con datos; mayo en adelante vacío.
    const ingresos = { 2026: anioIngresos({ enero: [2000], febrero: [2000], marzo: [2000], abril: [2000] }) }
    const gastos = {
        2026: anioGastos({
            enero: [["Casa", 1000]],
            febrero: [["Casa", 1600]],
            marzo: [["Casa", 1400]],
            abril: [["Casa", 1200]]
        })
    }

    it("mesesTranscurridos depende de si el año es pasado, actual o futuro", () => {
        const hoy = new Date(2026, 3, 15)
        expect(C().mesesTranscurridos("2025", hoy)).toBe(12)
        expect(C().mesesTranscurridos("2026", hoy)).toBe(4)
        expect(C().mesesTranscurridos("2027", hoy)).toBe(0)
    })

    it("las estadísticas solo cuentan meses transcurridos con datos", () => {
        const serie = C().serieAnual(ingresos, gastos, "2026")
        const e = C().estadisticasAnio(serie, 4, 30)
        expect(e.mesesConDatos).toBe(4)
        expect(e.total.ahorro).toBe(2800)
        expect(e.mediaMensual).toBe(700)
        expect(e.mejor.mes).toBe("enero")
        expect(e.peor.mes).toBe("febrero")
        // Enero 50 %, febrero 20 %, marzo 30 %, abril 40 %: tres llegan al 30 %.
        expect(e.mesesObjetivo).toBe(3)
    })

    it("un ingreso recurrente ya apuntado en meses futuros no cuenta en el acumulado", () => {
        const conFuturo = { 2026: anioIngresos({}, [{ meses: { enero: "1000", diciembre: "1000" } }]) }
        const serie = C().serieAnual(conFuturo, {}, "2026")
        expect(C().estadisticasAnio(serie, 4, 30).total.ingresos).toBe(1000)
    })

    it("la proyección solo existe en el año en curso", () => {
        const e = C().estadisticasAnio(C().serieAnual(ingresos, gastos, "2026"), 4, 30)
        expect(C().proyeccionFinDeAnio(e, 4)).toBe(2800 + 700 * 8)
        expect(C().proyeccionFinDeAnio(e, 12)).toBeNull()
        expect(C().proyeccionFinDeAnio(e, 0)).toBeNull()
    })

    it("la racha cuenta hacia atrás y se corta en un mes sin ingresos o bajo el objetivo", () => {
        const r = (tasa) => ({ tasa })
        expect(C().rachaObjetivo([r(10), r(35), r(40)], 30)).toBe(2)
        expect(C().rachaObjetivo([r(35), r(null), r(40)], 30)).toBe(1)
        expect(C().rachaObjetivo([r(35), r(20)], 30)).toBe(0)
    })

    it("sumarResumenes conserva el número de meses para escalar los importes fijos", () => {
        const serie = C().serieAnual(ingresos, gastos, "2026")
        const total = C().sumarResumenes(serie.slice(0, 4))
        expect(total.meses).toBe(4)
        expect(total.categorias.Casa).toBe(5200)
        expect(total.tasa).toBeCloseTo(35)
    })
})

describe("observaciones", () => {
    const config = { presupuesto: {}, presupuestoEur: { Casa: 500 } }

    function contexto(gastosMayo, gastosAbril, extra = {}) {
        const resumen = C().resumenMes(anioIngresos({ mayo: [2000] }), anioGastos({ mayo: gastosMayo }), "mayo")
        const previo = C().resumenMes(anioIngresos({ abril: [2000] }), anioGastos({ abril: gastosAbril }), "abril")
        const filas = C().filasPresupuesto(resumen, previo, config)
        return { resumen, filas, objetivo: 30, etiquetaPrevio: "abril", ...extra }
    }

    it("avisa de lo que falta para el objetivo, del exceso y de la mayor subida", () => {
        const textos = C()
            .generarObservaciones(
                contexto(
                    [
                        ["Casa", 600],
                        ["Ocio", 900]
                    ],
                    [
                        ["Casa", 500],
                        ["Ocio", 300]
                    ]
                )
            )
            .map((o) => o.texto)
        // 2000 de ingresos y 1500 de gastos: 500 ahorrados de los 600 del objetivo.
        expect(textos[0]).toBe("Te faltan 100,00 € para llegar al objetivo del 30 %.")
        expect(textos).toContain("Has superado el presupuesto en una categoría: Casa (+100,00 €).")
        expect(textos.some((t) => t.startsWith("Ocio sube 600,00 € (+200 %) respecto a abril"))).toBe(true)
    })

    it("felicita la racha y no comenta variaciones pequeñas", () => {
        const obs = C().generarObservaciones(contexto([["Casa", 400]], [["Casa", 390]], { racha: 3 }))
        expect(obs[0].tono).toBe("pos")
        expect(obs.map((o) => o.texto)).toContain("Llevas 3 meses seguidos cumpliendo tu objetivo de ahorro.")
        expect(obs.some((o) => o.texto.includes("sube"))).toBe(false)
    })

    it("compara el gasto con la media de 12 meses", () => {
        const obs = C().generarObservaciones(contexto([["Casa", 400]], [], { mediaGastos: 300 }))
        expect(obs.map((o) => o.texto)).toContain(
            "Tus gastos están un 33 % por encima de tu media de los últimos 12 meses (300,00 €)."
        )
    })

    it("un periodo sin datos no genera observaciones", () => {
        const resumen = C().resumenMes(null, null, "mayo")
        expect(C().generarObservaciones({ resumen, filas: [], objetivo: 30, etiquetaPrevio: "abril" })).toEqual([])
    })
})
