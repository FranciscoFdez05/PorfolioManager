// Gráficas de la ventana Cuentas: rangos, recorte de la serie y miniatura.
//
// Lo delicado es el arranque de cada rango: si la cuenta ya tenía dinero antes,
// la línea tiene que empezar en el primer día del rango con ese saldo, y ese
// punto de arranque no puede contar como entrada ni salida del periodo.
import { beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

const t = (anio, mes, dia) => new Date(anio, mes - 1, dia).getTime()

beforeAll(() => {
    cargarScript("js/finanzas/cuentas-graficos.js")
})

describe("cntNormalizarSerie", () => {
    it("pasa fechas ISO a medianoche local y los importes a números", () => {
        const serie = cntNormalizarSerie([{ fecha: "2026-03-05", entradas: "10.50", salidas: "0.00", saldo: "-2.25" }])

        expect(serie).toEqual([{ t: t(2026, 3, 5), entradas: 10.5, salidas: 0, saldo: -2.25 }])
    })

    it("tolera que no llegue nada", () => {
        expect(cntNormalizarSerie(undefined)).toEqual([])
    })
})

describe("cntInicioRango", () => {
    const hoy = new Date(2026, 10, 9, 15, 39)

    it("YTD empieza el 1 de enero", () => {
        expect(cntInicioRango("YTD", hoy)).toBe(t(2026, 1, 1))
    })

    it("Todo no tiene inicio", () => {
        expect(cntInicioRango("TODO", hoy)).toBeNull()
    })

    it("resta meses desde la medianoche de hoy", () => {
        expect(cntInicioRango("1M", hoy)).toBe(t(2026, 10, 9))
        expect(cntInicioRango("6M", hoy)).toBe(t(2026, 5, 9))
        expect(cntInicioRango("1A", hoy)).toBe(t(2025, 11, 9))
    })

    it("a final de mes se queda en el último día del mes de destino", () => {
        expect(cntInicioRango("1M", new Date(2026, 2, 31))).toBe(t(2026, 2, 28))
    })

    it("una clave desconocida vale como YTD", () => {
        expect(cntInicioRango("XX", hoy)).toBe(t(2026, 1, 1))
        expect(cntRangoValido("XX")).toBe("YTD")
    })
})

describe("cntPuntosEnRango y cntFlujosEnRango", () => {
    const serie = [
        { t: t(2025, 12, 30), entradas: 0, salidas: 0, saldo: 100 },
        { t: t(2025, 12, 31), entradas: 50, salidas: 0, saldo: 150 },
        { t: t(2026, 2, 10), entradas: 0, salidas: 30, saldo: 120 },
        { t: t(2026, 3, 1), entradas: 20, salidas: 5, saldo: 135 }
    ]

    it("arranca el rango con el saldo que había antes, sin flujos", () => {
        const puntos = cntPuntosEnRango(serie, t(2026, 1, 1))

        expect(puntos[0]).toEqual({ t: t(2026, 1, 1), entradas: 0, salidas: 0, saldo: 150 })
        expect(puntos.slice(1)).toEqual(serie.slice(2))
    })

    it("no duplica el arranque si ya hay un punto ese día", () => {
        expect(cntPuntosEnRango(serie, t(2026, 2, 10))).toEqual(serie.slice(2))
    })

    it("sin inicio devuelve toda la serie", () => {
        expect(cntPuntosEnRango(serie, null)).toEqual(serie)
    })

    it("una cuenta que empieza dentro del rango no se inventa saldo anterior", () => {
        expect(cntPuntosEnRango(serie, t(2025, 1, 1))).toEqual(serie)
    })

    it("suma solo lo que entra y sale dentro del rango", () => {
        expect(cntFlujosEnRango(serie, t(2026, 1, 1))).toEqual({ entradas: 20, salidas: 35 })
        expect(cntFlujosEnRango(serie, null)).toEqual({ entradas: 70, salidas: 35 })
    })
})

describe("cntFlujosPorMes", () => {
    it("agrupa por mes en orden y omite los meses sin movimientos", () => {
        const meses = cntFlujosPorMes([
            { t: t(2026, 3, 1), entradas: 20, salidas: 5, saldo: 0 },
            { t: t(2026, 1, 1), entradas: 0, salidas: 0, saldo: 0 },
            { t: t(2026, 2, 10), entradas: 0, salidas: 30, saldo: 0 },
            { t: t(2026, 3, 15), entradas: 1, salidas: 0, saldo: 0 }
        ])

        expect(meses).toEqual([
            { clave: "2026-02", t: t(2026, 2, 1), entradas: 0, salidas: 30 },
            { clave: "2026-03", t: t(2026, 3, 1), entradas: 21, salidas: 5 }
        ])
    })
})

describe("cntTrazadoMini", () => {
    it("dibuja escalones: el saldo se mantiene hasta el día del cambio", () => {
        const d = cntTrazadoMini(
            [
                { t: 0, saldo: 0 },
                { t: 50, saldo: 10 },
                { t: 100, saldo: 5 }
            ],
            100,
            20,
            0
        )

        expect(d).toBe("M0,20H50V0H100V10")
    })

    it("un saldo plano va a media altura y un solo punto ocupa todo el ancho", () => {
        expect(cntTrazadoMini([{ t: 0, saldo: 7 }], 100, 20)).toBe("M0,10H100")
    })

    it("sin puntos no hay trazado", () => {
        expect(cntTrazadoMini([], 100, 20)).toBe("")
    })
})

describe("cntMarcasEje", () => {
    it("en tramos largos pone las marcas el día 1 de cada mes", () => {
        const marcas = cntMarcasEje(t(2026, 1, 1), t(2026, 11, 9))

        expect(marcas[0]).toBe(t(2026, 1, 1))
        expect(marcas).toHaveLength(11)
        expect(marcas.every((m) => new Date(m).getDate() === 1)).toBe(true)
    })

    it("si el tramo no empieza el día 1, la primera marca es el mes siguiente", () => {
        expect(cntMarcasEje(t(2025, 11, 9), t(2026, 11, 9))[0]).toBe(t(2025, 12, 1))
    })

    it("con muchos años espacia las marcas sin pasar del máximo", () => {
        const marcas = cntMarcasEje(t(2018, 3, 5), t(2026, 11, 9))

        expect(marcas.length).toBeLessThanOrEqual(12)
        expect(marcas.every((m) => new Date(m).getMonth() % 3 === 0)).toBe(true)
    })

    it("en tramos cortos marca cada pocos días desde el inicio", () => {
        const marcas = cntMarcasEje(t(2026, 10, 9), t(2026, 11, 9))

        expect(marcas[0]).toBe(t(2026, 10, 9))
        expect(marcas.length).toBeLessThanOrEqual(13)
        expect(marcas[marcas.length - 1]).toBeLessThanOrEqual(t(2026, 11, 9))
    })
})

describe("cntVariacion", () => {
    it("da la diferencia entre el último y el primer saldo y su porcentaje", () => {
        expect(cntVariacion([{ saldo: 200 }, { saldo: 150 }, { saldo: 250 }])).toEqual({ absoluta: 50, porcentaje: 25 })
    })

    it("sin saldo de partida positivo no hay porcentaje", () => {
        expect(cntVariacion([{ saldo: 0 }, { saldo: 30 }])).toEqual({ absoluta: 30, porcentaje: null })
        expect(cntVariacion([{ saldo: -10 }, { saldo: 5 }]).porcentaje).toBeNull()
    })

    it("sin puntos no varía", () => {
        expect(cntVariacion([])).toEqual({ absoluta: 0, porcentaje: null })
    })
})

describe("cntAreaMini", () => {
    it("cierra el trazado por abajo hasta el inicio", () => {
        expect(cntAreaMini("M0,20H50V0H100V10", 20)).toBe("M0,20H50V0H100V10V20H0Z")
    })

    it("sin trazado no hay área", () => {
        expect(cntAreaMini("", 20)).toBe("")
    })
})

describe("cntEuroCorto", () => {
    it("abrevia los miles y deja enteros los importes normales", () => {
        expect(cntEuroCorto(1500)).toMatch(/^1,5\smil €$/)
        expect(cntEuroCorto(250)).toBe("250 €")
    })

    it("conserva los céntimos en importes pequeños", () => {
        expect(cntEuroCorto(0.5)).toBe("0,50 €")
    })
})

describe("cntSerieTotal", () => {
    const p = (t, saldo, entradas = 0, salidas = 0) => ({ t, entradas, salidas, saldo })

    it("suma en cada día el último saldo conocido de cada cuenta", () => {
        const a = [p(1, 100), p(3, 150, 50)]
        const b = [p(2, 10), p(4, 0, 0, 10)]

        expect(cntSerieTotal([a, b])).toEqual([p(1, 110), p(2, 110), p(3, 160, 50), p(4, 150, 0, 10)])
    })

    it("antes de su primer punto una cuenta aporta su saldo de partida", () => {
        expect(cntSerieTotal([[p(1, 5)], [p(3, 20), p(4, 25, 5)]])).toEqual([p(1, 25), p(3, 25), p(4, 30, 5)])
    })

    it("ignora las cuentas sin puntos", () => {
        expect(cntSerieTotal([[], [p(1, 7)]])).toEqual([p(1, 7)])
        expect(cntSerieTotal([])).toEqual([])
    })
})

describe("cntAgruparPartes", () => {
    const parte = (etiqueta, valor) => ({ etiqueta, valor, color: "#000" })

    it("deja las más grandes y suma el resto en «Otras»", () => {
        const partes = [1, 7, 3, 9, 5, 2, 8].map((v) => parte(`c${v}`, v))

        const agrupadas = cntAgruparPartes(partes, 3)

        expect(agrupadas.map((p) => p.etiqueta)).toEqual(["c9", "c8", "c7", "Otras (4)"])
        expect(agrupadas[3].valor).toBe(11)
    })

    it("no agrupa una sola porción sobrante ni las que no son positivas", () => {
        const partes = [parte("a", 5), parte("b", 4), parte("c", 0), parte("d", -3), parte("e", 1)]

        expect(cntAgruparPartes(partes, 2).map((p) => p.etiqueta)).toEqual(["a", "b", "e"])
    })
})

describe("cntPorcentajeTexto", () => {
    it("no enseña 0,0 % para una porción que existe", () => {
        expect(cntPorcentajeTexto(0.01, 291)).toBe("<0,1 %")
        expect(cntPorcentajeTexto(33.1, 291)).toBe("11,4 %")
    })

    it("sin total o sin parte es 0 %", () => {
        expect(cntPorcentajeTexto(5, 0)).toBe("0 %")
        expect(cntPorcentajeTexto(0, 10)).toBe("0 %")
    })
})

describe("cntFechaIso", () => {
    it("da la fecha local en aaaa-mm-dd", () => {
        expect(cntFechaIso(t(2026, 1, 5))).toBe("2026-01-05")
        expect(cntFechaIso(t(2025, 11, 30))).toBe("2025-11-30")
    })
})
