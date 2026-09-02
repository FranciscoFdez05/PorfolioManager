// Pruebas de la aritmética de las mensualidades (js/finanzas/gastos.js).
//
// Nada de lo que se ve en la pantalla de Mensualidades está guardado: el coste
// mensual, el próximo cobro y los días del calendario se derivan cada vez de
// los importes por mes. Un fallo aquí no da un error, da un número creíble y
// equivocado —que es justo lo que pasaba con las pausadas, sumando al coste
// mensual un cargo que ya no se cobra.
//
// Los tres comportamientos que cubre este fichero:
//
//   1. **Pausar.** Vaciar los cargos que quedan por delante sin tocar los que ya
//      pasaron por el banco, y devolverlos al reactivar sin descolocar el ritmo
//      de una trimestral.
//   2. **El día por mes.** La excepción manda sobre el día por defecto, y el 31
//      se recorta al último día del mes en vez de saltar al mes siguiente.
//   3. **El próximo cobro.** Con días distintos por mes, el siguiente cargo no
//      es el del mes siguiente por orden, sino el de la fecha más cercana.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    // El orden es el de index.html: gastos.js usa parseEuroNumber, formatEuro y
    // formatCellEuroValue de shared-utils.js.
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/gastos.js")
})

// Todo lo que decide "qué queda por delante" mira al reloj, así que las pruebas
// lo fijan: 15 de junio de 2026.
const HOY = new Date(2026, 5, 15, 10, 30)

beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(HOY)
    currentGastosYear = "2026"
    currentGastosData = { mensualidades: [] }
})

const MESES = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"
]

/** Una mensualidad con el mismo importe en todos los meses del año. */
function mensualidad(campos = {}) {
    return normalizeMensualidad({
        nombre: "Servicio",
        importe: "10,00 €",
        frecuencia: "mensual",
        diaCobro: "2",
        activa: true,
        meses: Object.fromEntries(MESES.map((mes) => [mes, "10,00 €"])),
        ...campos
    })
}

const mesesConCargo = (row) => MESES.filter((mes) => row.meses[mes])

describe("coste de una mensualidad pausada", () => {
    it("no cuenta en el coste mensual", () => {
        // El motivo de todo esto: una pausada sumaba sus 10 € al total como si
        // se siguiera cobrando.
        expect(getMensualidadMonthlyCost(mensualidad({ activa: false }))).toBe(0)
    })

    it("una activa sigue costando su cargo repartido por la frecuencia", () => {
        const trimestral = mensualidad({ importe: "30,00 €", frecuencia: "trimestral" })
        expect(getMensualidadMonthlyCost(trimestral)).toBeCloseTo(10, 6)
    })

    it("el coste anual sí cuenta lo que se cobró antes de pausarse", () => {
        // Es dinero que salió de la cuenta: borrarlo del año sería mentir sobre
        // el gasto de enero a junio, cuyo cargo salió el día 2.
        const pausada = pauseMensualidad(mensualidad())
        expect(getMensualidadAnnualCost(pausada)).toBeCloseTo(60, 6)
    })
})

describe("pauseMensualidad", () => {
    it("vacía los meses que quedan por delante y respeta los pasados", () => {
        // Hoy es 15 de junio y el cargo es el día 2: el de junio ya se cobró.
        const pausada = pauseMensualidad(mensualidad())
        expect(mesesConCargo(pausada)).toEqual(["enero", "febrero", "marzo", "abril", "mayo", "junio"])
        expect(pausada.activa).toBe(false)
    })

    it("el cargo del mes en curso se borra si aún no ha llegado su día", () => {
        const pausada = pauseMensualidad(mensualidad({ diaCobro: "28" }))
        expect(mesesConCargo(pausada)).toEqual(["enero", "febrero", "marzo", "abril", "mayo"])
    })

    it("tiene en cuenta el día propio del mes en curso, no el general", () => {
        // El día 2 ya pasó, pero junio se cobra el 28: aún no ha salido.
        const pausada = pauseMensualidad(mensualidad({ diasCobro: { junio: "28" } }))
        expect(mesesConCargo(pausada)).not.toContain("junio")
    })

    it("en un año ya cerrado no borra nada", () => {
        currentGastosYear = "2025"
        expect(mesesConCargo(pauseMensualidad(mensualidad()))).toHaveLength(12)
    })

    it("en un año futuro no deja ningún cargo", () => {
        currentGastosYear = "2027"
        expect(mesesConCargo(pauseMensualidad(mensualidad()))).toEqual([])
    })
})

describe("resumeMensualidad", () => {
    it("devuelve los cargos desde el mes en curso", () => {
        const vuelta = resumeMensualidad(pauseMensualidad(mensualidad()))
        expect(mesesConCargo(vuelta)).toHaveLength(12)
        expect(vuelta.activa).toBe(true)
    })

    it("no descoloca una trimestral: sigue el ritmo del primer cargo del año", () => {
        // Cargos en enero, abril, julio y octubre. Al pausar en junio se van
        // julio y octubre; al reactivar tienen que volver esos dos y no agosto.
        const trimestral = mensualidad({
            frecuencia: "trimestral",
            importe: "30,00 €",
            meses: Object.fromEntries(
                MESES.map((mes, indice) => [mes, indice % 3 === 0 ? "30,00 €" : ""])
            )
        })

        const vuelta = resumeMensualidad(pauseMensualidad(trimestral))

        expect(mesesConCargo(vuelta)).toEqual(["enero", "abril", "julio", "octubre"])
    })

    it("sin importe guardado usa el del último cargo cobrado", () => {
        // El precio subió a mitad de año: lo que vuelve es el precio nuevo.
        const conSubida = mensualidad({
            importe: "",
            meses: Object.fromEntries(
                MESES.map((mes, indice) => [mes, indice < 3 ? "10,00 €" : "12,00 €"])
            )
        })

        const vuelta = resumeMensualidad(pauseMensualidad(conSubida))

        expect(vuelta.meses.diciembre).toBe("12,00 €")
    })
})

describe("día de cobro por mes", () => {
    it("la excepción del mes manda sobre el día general", () => {
        const row = mensualidad({ diasCobro: { marzo: "5" } })
        expect(getMensualidadDiaMes(row, "marzo")).toBe("5")
        expect(getMensualidadDiaMes(row, "abril")).toBe("2")
    })

    it("un día imposible se descarta y se usa el general", () => {
        expect(getMensualidadDiaMes(mensualidad({ diasCobro: { marzo: "45" } }), "marzo")).toBe("2")
    })

    it("el 31 se cobra el último día del mes, no en el siguiente", () => {
        const row = mensualidad({ diaCobro: "31" })
        const febrero = getMensualidadCargos(row).find((cargo) => cargo.key === "febrero")
        expect(febrero.date.getMonth()).toBe(1)
        expect(febrero.date.getDate()).toBe(28)
    })

    it("sin ningún día definido el cargo queda marcado como sin día", () => {
        const cargos = getMensualidadCargos(mensualidad({ diaCobro: "" }))
        expect(cargos.every((cargo) => cargo.sinDia)).toBe(true)
    })

    it("normalizeMensualidadDias acepta el JSON con el que llega de la base", () => {
        expect(normalizeMensualidadDias('{"marzo":"5"}')).toEqual({ marzo: "5" })
        expect(normalizeMensualidadDias("no es json")).toEqual({})
    })
})

describe("próximo cobro", () => {
    it("es el primer cargo que aún no ha pasado", () => {
        const next = getMensualidadNextCharge(mensualidad())
        expect(next.isPast).toBe(false)
        expect(next.date).toEqual(new Date(2026, 6, 2))
    })

    it("cuenta el día propio del mes, no el general", () => {
        // Junio se cobra el 20 y hoy es 15: el siguiente cargo es este, no julio.
        const next = getMensualidadNextCharge(mensualidad({ diasCobro: { junio: "20" } }))
        expect(next.date).toEqual(new Date(2026, 5, 20))
        expect(next.daysLeft).toBe(5)
    })

    it("de un año ya pasado avisa de que no queda nada por delante", () => {
        currentGastosYear = "2025"
        expect(getMensualidadNextCharge(mensualidad()).isPast).toBe(true)
    })

    it("sin ningún cargo no hay próxima renovación", () => {
        expect(getMensualidadNextCharge(mensualidad({ meses: {} }))).toBeNull()
    })
})

describe("cargos del año para el calendario", () => {
    beforeEach(() => {
        currentGastosData = {
            mensualidades: [
                mensualidad({ nombre: "Claude", importe: "22,00 €", diaCobro: "2" }),
                mensualidad({
                    nombre: "Proton",
                    importe: "19,99 €",
                    diaCobro: "5",
                    diasCobro: { marzo: "2" }
                })
            ]
        }
    })

    it("saca un cargo por mes y servicio, ordenados por fecha", () => {
        const cargos = getMensualidadesCargosDelAno()

        expect(cargos).toHaveLength(24)
        expect(cargos.slice(0, 2).map((cargo) => cargo.nombre)).toEqual(["Claude", "Proton"])
        expect(cargos.every((cargo, i) => i === 0 || cargos[i - 1].date <= cargo.date)).toBe(true)
    })

    it("dos servicios que caen el mismo día comparten fecha", () => {
        // En marzo Proton se cobra el 2, igual que Claude.
        const marzo = getMensualidadesCargosDelAno().filter((cargo) => cargo.monthKey === "marzo")
        expect(marzo.map((cargo) => cargo.date.getDate())).toEqual([2, 2])
    })

    it("respeta el filtro de la pantalla", () => {
        mensualidadesFilter = "activas"
        currentGastosData.mensualidades[1] = { ...currentGastosData.mensualidades[1], activa: false }

        const nombres = new Set(getMensualidadesCargosDelAno().map((cargo) => cargo.nombre))

        expect([...nombres]).toEqual(["Claude"])
        mensualidadesFilter = "todas"
    })
})

describe("pintado del calendario", () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="mensTableWrapper"></div>
            <div id="mensCalendar" class="hidden"></div>
        `
        mensCalendarSelection = null
        currentGastosData = {
            mensualidades: [
                mensualidad({ nombre: "Claude", importe: "22,00 €", diaCobro: "2" }),
                mensualidad({ nombre: "Proton", importe: "19,99 €", diaCobro: "5" })
            ]
        }
    })

    const calendario = () => document.getElementById("mensCalendar")

    it("pinta los doce meses del año", () => {
        renderMensualidadesCalendar()
        expect(calendario().querySelectorAll(".mensCalMonth")).toHaveLength(12)
    })

    it("marca como cobrado lo pasado y como próximo lo que queda", () => {
        renderMensualidadesCalendar()

        // Enero ya pasó; diciembre no.
        const meses = calendario().querySelectorAll(".mensCalMonth")
        expect(meses[0].querySelectorAll(".mensCalDayPast").length).toBe(2)
        expect(meses[0].querySelectorAll(".mensCalDayNext").length).toBe(0)
        expect(meses[11].querySelectorAll(".mensCalDayNext").length).toBe(2)
    })

    it("sin día elegido el panel resume el año", () => {
        renderMensualidadesCalendar()
        expect(calendario().querySelector(".mensCalSideTitle").textContent).toContain("24 cargos")
    })

    it("con un día elegido detalla qué se cobró ese día", () => {
        // 2 de julio: solo Claude, que se cobra el día 2.
        mensCalendarSelection = "6-2"
        renderMensualidadesCalendar()

        const panel = calendario().querySelector(".mensCalSide")
        expect(panel.querySelector(".mensCalSideTitle").textContent).toBe("2 de julio")
        expect(panel.querySelector(".mensCalSideLabel").textContent).toBe("Previsto")
        expect([...panel.querySelectorAll(".mensCalSideName")].map((n) => n.textContent)).toEqual(["Claude"])
    })

    it("un día ya pasado se marca como cobrado", () => {
        mensCalendarSelection = "0-2"
        renderMensualidadesCalendar()
        expect(calendario().querySelector(".mensCalSideLabel").textContent).toBe("Cobrado")
    })

    it("sin ninguna mensualidad lo dice en vez de dejar el hueco vacío", () => {
        currentGastosData = { mensualidades: [] }
        renderMensualidadesCalendar()
        expect(calendario().querySelector(".mensCalEmpty").textContent).toContain("Aún no hay mensualidades")
    })

    it("renderMensualidadesList enseña el calendario y esconde la tabla", () => {
        mensualidadesTab = "calendario"
        renderMensualidadesList()

        expect(calendario().classList.contains("hidden")).toBe(false)
        expect(document.getElementById("mensTableWrapper").classList.contains("hidden")).toBe(true)

        mensualidadesTab = "tabla"
    })
})

describe("pintado de la tabla", () => {
    beforeEach(() => {
        document.body.innerHTML = '<table><tbody id="mensTableBody"></tbody><tfoot id="mensTableFoot"></tfoot></table>'
        currentGastosData = {
            mensualidades: [
                mensualidad({ nombre: "Claude", importe: "22,00 €" }),
                pauseMensualidad(mensualidad({ nombre: "Office", importe: "10,00 €" }))
            ]
        }
    })

    const celdas = (fila) => [...fila.querySelectorAll("td")].map((td) => td.textContent.trim())

    it("la pausada no enseña coste mensual", () => {
        renderMensualidadesTable()

        const filas = document.querySelectorAll("#mensTableBody tr")
        expect(celdas(filas[0])[5]).toBe("22,00 €")
        expect(celdas(filas[1])[5]).toBe("—")
        expect(filas[1].classList.contains("mensRowPaused")).toBe(true)
    })

    it("el total mensual solo suma lo activo y lo dice", () => {
        renderMensualidadesTable()

        const pie = document.querySelector("#mensTableFoot tr")
        expect(celdas(pie)[1]).toBe("22,00 €")
        expect(celdas(pie)[0]).toContain("1 pausada, fuera del coste mensual")
    })

    it("avisa de los meses con un día de cobro distinto", () => {
        currentGastosData.mensualidades = [mensualidad({ nombre: "Proton", diasCobro: { marzo: "5", julio: "9" } })]
        renderMensualidadesTable()

        const renovacion = document.querySelector("#mensTableBody tr td:nth-child(4)")
        expect(renovacion.textContent).toContain("Día 2")
        expect(renovacion.textContent).toContain("2 meses aparte")
        expect(renovacion.querySelector("span").title).toBe("Marzo: día 5 · Julio: día 9")
    })
})
