// Gráfico de la ficha del activo: lo que se pinta según la vista y la unidad, los
// cortes de la línea y cómo se agrupan los puntos de compra y venta.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { cargarScript } from "./cargar.js"

const punto = (ts, valor, coste, precio) => ({ ts, valor, coste, precio })
const operacion = (tipo, indice, extra = {}) => ({
    tipo,
    indice,
    fecha: "01-01-2026",
    cantidad: 1,
    precio: 10,
    divisa: "EUR",
    ...extra
})

function datos(puntos, operaciones = [], segundosHueco = 1000) {
    return { puntos, operaciones, segundosHueco, operacionesSinPunto: 0 }
}

beforeAll(() => {
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cartera/assets-grafico.js")
})

describe("valor de cada punto", () => {
    const serie = [punto(100, 200, 100, 20), punto(200, 300, 150, 25)]

    it("en precio y euros es el precio por participación", () => {
        const { linea } = window.assetGraficoSeries(datos(serie), "precio", "eur")
        expect(linea.map((p) => p.y)).toEqual([20, 25])
    })

    it("en precio y % es la variación desde el primer precio del periodo", () => {
        const { linea } = window.assetGraficoSeries(datos(serie), "precio", "pct")
        expect(linea.map((p) => p.y)).toEqual([0, 25])
    })

    it("en posición y euros es el valor menos el coste", () => {
        const { linea } = window.assetGraficoSeries(datos(serie), "posicion", "eur")
        expect(linea.map((p) => p.y)).toEqual([100, 150])
    })

    it("en posición y % es la ganancia sobre el coste de ese momento", () => {
        const { linea } = window.assetGraficoSeries(datos(serie), "posicion", "pct")
        expect(linea.map((p) => p.y)).toEqual([100, 100])
    })

    it("sin coste no inventa un porcentaje y sin precio deja el hueco", () => {
        const puntos = [punto(100, 200, 0, null), punto(200, 300, 0, 25)]
        expect(window.assetGraficoSeries(datos(puntos), "posicion", "pct").linea[0].y).toBeNull()
        expect(window.assetGraficoSeries(datos(puntos), "precio", "eur").linea[0].y).toBeNull()
    })

    it("el % de precio parte del primer precio conocido, no del primer punto", () => {
        const puntos = [punto(100, 200, 0, null), punto(200, 300, 0, 20), punto(300, 300, 0, 30)]
        const { linea } = window.assetGraficoSeries(datos(puntos), "precio", "pct")
        expect(linea.map((p) => p.y)).toEqual([null, 0, 50])
    })
})

describe("línea", () => {
    it("se corta en un hueco mayor que el permitido y no en uno menor", () => {
        const puntos = [punto(100, 1, 1, 1), punto(500, 1, 1, 1), punto(5000, 1, 1, 1)]
        const { linea } = window.assetGraficoSeries(datos(puntos), "precio", "eur")
        expect(linea.map((p) => p.y)).toEqual([1, 1, null, 1])
    })

    it("encuentra los extremos y el último valor ignorando los cortes", () => {
        const puntos = [punto(100, 1, 1, 10), punto(200, 1, 1, 5), punto(5000, 1, 1, 8)]
        const { extremos, ultimo } = window.assetGraficoSeries(datos(puntos), "precio", "eur")
        expect(extremos.maximo.y).toBe(10)
        expect(extremos.minimo.y).toBe(5)
        expect(ultimo.y).toBe(8)
    })
})

describe("eje horizontal", () => {
    it("abarca solo los puntos con valor en esa vista", () => {
        const puntos = [punto(100, 200, 100, null), punto(200, 300, 150, 25), punto(300, 300, 150, 26)]
        expect(window.assetGraficoSeries(datos(puntos), "precio", "eur").limitesX).toEqual({ min: 200, max: 300 })
        expect(window.assetGraficoSeries(datos(puntos), "posicion", "eur").limitesX).toEqual({ min: 100, max: 300 })
    })

    it("un punto suelto antes del trazo no estira el eje ni cuenta como extremo", () => {
        const puntos = [
            punto(100, 1, 1, 90),
            punto(200, 1, 1, null),
            punto(300, 1, 1, 20),
            punto(400, 1, 1, 25)
        ]
        const series = window.assetGraficoSeries(datos(puntos), "precio", "eur")
        expect(series.limitesX).toEqual({ min: 300, max: 400 })
        expect(series.extremos.maximo.y).toBe(25)
    })

    it("el % de precio tampoco parte de un punto suelto", () => {
        const puntos = [
            punto(100, 1, 1, 90),
            punto(200, 1, 1, null),
            punto(300, 1, 1, 20),
            punto(400, 1, 1, 25)
        ]
        const { linea } = window.assetGraficoSeries(datos(puntos), "precio", "pct")
        expect(linea.map((p) => p.y)).toEqual([350, null, 0, 25])
    })

    it("con un único punto suelto ese es el inicio", () => {
        const puntos = [punto(100, 1, 1, null), punto(200, 1, 1, 20), punto(300, 1, 1, null)]
        expect(window.assetGraficoSeries(datos(puntos), "precio", "eur").limitesX).toEqual({ min: 200, max: 200 })
    })

    it("no tiene límites si no hay nada que pintar", () => {
        const puntos = [punto(100, 200, 100, null)]
        expect(window.assetGraficoSeries(datos(puntos), "precio", "eur").limitesX).toBeNull()
    })

    it("escribe la hora, el día o el mes según el tramo visible", () => {
        const ts = Date.UTC(2026, 9, 15, 12) / 1000
        const dia = 86400
        const conHora = window.assetGraficoFormatearEje(ts, dia)
        const conDia = window.assetGraficoFormatearEje(ts, 30 * dia)
        const conMes = window.assetGraficoFormatearEje(ts, 365 * dia)
        expect(conHora).toMatch(/\d{2}:\d{2}/)
        expect(conDia).toContain("15")
        expect(conMes).toContain("26")
        expect(conMes).not.toContain("15")
    })
})

describe("puntos de compra y venta", () => {
    const serie = [punto(100, 200, 100, 20), punto(200, 300, 150, 25)]

    it("separa las compras de las ventas y los coloca sobre la línea", () => {
        const series = window.assetGraficoSeries(
            datos(serie, [operacion("compra", 0), operacion("venta", 1)]),
            "precio",
            "eur"
        )
        expect(series.compras).toHaveLength(1)
        expect(series.compras[0]).toMatchObject({ x: 100, y: 20, indiceLinea: 0 })
        expect(series.ventas[0]).toMatchObject({ x: 200, y: 25, indiceLinea: 1 })
    })

    it("varias compras del mismo punto comparten marca", () => {
        const series = window.assetGraficoSeries(
            datos(serie, [operacion("compra", 0), operacion("compra", 0, { cantidad: 2 })]),
            "precio",
            "eur"
        )
        expect(series.compras).toHaveLength(1)
        expect(series.compras[0].operaciones).toHaveLength(2)
    })

    it("la marca sigue siendo la del punto correcto tras un corte de la línea", () => {
        const puntos = [punto(100, 1, 1, 1), punto(5000, 2, 1, 2)]
        const series = window.assetGraficoSeries(datos(puntos, [operacion("venta", 1)]), "precio", "eur")
        expect(series.linea[series.ventas[0].indiceLinea].y).toBe(2)
    })

    it("en la vista de precio la marca sale al precio de la operación, no al de la línea", () => {
        const series = window.assetGraficoSeries(
            datos(serie, [operacion("compra", 1, { precioEur: 22 })]),
            "precio",
            "eur"
        )
        expect(series.compras[0]).toMatchObject({ x: 200, y: 22, indiceLinea: 1 })
    })

    it("con la línea de TradingView la marca va sobre la línea aunque se pagara otro precio", () => {
        const series = window.assetGraficoSeries(
            { ...datos(serie, [operacion("compra", 1, { precioEur: 22 })]), conVelas: true },
            "precio",
            "eur"
        )
        expect(series.compras[0]).toMatchObject({ x: 200, y: 25, indiceLinea: 1 })
        expect(series.compras[0].operaciones[0].precioEur).toBe(22)
    })

    it("en precio y % la marca usa la misma base que la línea", () => {
        const series = window.assetGraficoSeries(
            datos(serie, [operacion("compra", 1, { precioEur: 22 })]),
            "precio",
            "pct"
        )
        expect(series.compras[0].y).toBeCloseTo(10)
    })

    it("en la vista de posición la marca sigue sobre la línea", () => {
        const series = window.assetGraficoSeries(
            datos(serie, [operacion("compra", 1, { precioEur: 22 })]),
            "posicion",
            "eur"
        )
        expect(series.compras[0].y).toBe(150)
    })

    it("sin precio en euros la marca se apoya en la línea", () => {
        const series = window.assetGraficoSeries(
            datos(serie, [operacion("compra", 1, { precioEur: null })]),
            "precio",
            "eur"
        )
        expect(series.compras[0].y).toBe(25)
    })

    it("dos compras del mismo punto a precios distintos no comparten marca", () => {
        const series = window.assetGraficoSeries(
            datos(serie, [operacion("compra", 1, { precioEur: 22 }), operacion("compra", 1, { precioEur: 24 })]),
            "precio",
            "eur"
        )
        expect(series.compras.map((marca) => marca.y)).toEqual([22, 24])
    })

    it("sin valor en esa vista no pinta la marca, pero la cuenta para avisar", () => {
        const puntos = [punto(100, 1, 1, null), punto(200, 2, 1, 2)]
        const series = window.assetGraficoSeries(datos(puntos, [operacion("compra", 0)]), "precio", "eur")
        expect(series.compras).toHaveLength(0)
        expect(series.operacionesSinValor).toBe(1)
    })
})

describe("nota al pie", () => {
    const serie = { operacionesSinValor: 0 }

    it("dice desde cuándo hay histórico y cuántas operaciones faltan", () => {
        const texto = window.assetGraficoTextoNota(
            { inicioHistorico: 1779000000, operacionesSinPunto: 2 },
            serie,
            "precio",
            "EUR"
        )
        expect(texto).toContain("Histórico disponible desde")
        expect(texto).toContain("2 operaciones")
    })

    it("avisa de los euros solo si el activo está en otra divisa", () => {
        const enEuros = window.assetGraficoTextoNota({ operacionesSinPunto: 0 }, serie, "precio", "EUR")
        const enDolares = window.assetGraficoTextoNota({ operacionesSinPunto: 0 }, serie, "precio", "USD")
        expect(enEuros).toBe("")
        expect(enDolares).toContain("en euros")
    })

    it("en la vista de posición aclara que lo vendido no suma", () => {
        const texto = window.assetGraficoTextoNota({ operacionesSinPunto: 0 }, serie, "posicion", "EUR")
        expect(texto).toContain("Lo ya vendido no suma")
    })

    it("con velas dice de dónde sale la línea en lugar del inicio del histórico", () => {
        const texto = window.assetGraficoTextoNota(
            { conVelas: true, inicioHistorico: 1779000000, operacionesSinPunto: 0 },
            serie,
            "precio",
            "EUR"
        )
        expect(texto).toBe("La línea sale de la cotización de TradingView.")
    })

    it("con velas, en la vista de posición avisa de que no descuenta comisiones", () => {
        const texto = window.assetGraficoTextoNota({ conVelas: true, operacionesSinPunto: 0 }, serie, "posicion", "EUR")
        expect(texto).toContain("no descuenta comisiones")
    })
})

describe("búsqueda por fecha", () => {
    const ts = (iso) => new Date(`${iso}T12:00:00`).getTime() / 1000
    const puntos = [punto(ts("2026-01-10"), 1, 1, 10), punto(ts("2026-02-10"), 2, 1, 11), punto(ts("2026-03-10"), 3, 1, 12)]
    const operaciones = [operacion("compra", 0), operacion("venta", 2)]

    it("sin fechas devuelve los datos tal cual", () => {
        const original = datos(puntos, operaciones)
        expect(window.assetGraficoRecortar(original, { desde: "", hasta: "" })).toBe(original)
    })

    it("recorta por los dos extremos, incluyendo el día de cada uno", () => {
        const recortado = window.assetGraficoRecortar(datos(puntos, operaciones), {
            desde: "2026-02-10",
            hasta: "2026-03-10"
        })
        expect(recortado.puntos).toHaveLength(2)
    })

    it("admite una sola fecha", () => {
        expect(window.assetGraficoRecortar(datos(puntos), { desde: "2026-02-01", hasta: "" }).puntos).toHaveLength(2)
        expect(window.assetGraficoRecortar(datos(puntos), { desde: "", hasta: "2026-02-01" }).puntos).toHaveLength(1)
    })

    it("reajusta el índice de las operaciones y descarta las de fuera", () => {
        const recortado = window.assetGraficoRecortar(datos(puntos, operaciones), {
            desde: "2026-02-01",
            hasta: ""
        })
        expect(recortado.operaciones).toHaveLength(1)
        expect(recortado.operaciones[0]).toMatchObject({ tipo: "venta", indice: 1 })
    })

    it("con las fechas cruzadas no queda nada", () => {
        const recortado = window.assetGraficoRecortar(datos(puntos, operaciones), {
            desde: "2026-03-01",
            hasta: "2026-01-01"
        })
        expect(recortado.puntos).toEqual([])
        expect(recortado.operaciones).toEqual([])
    })
})

describe("histórico anterior al rango", () => {
    // «Todo» con velas diarias y el rango desde ts 400 (con un hueco menor que el de «Todo»).
    const contexto = {
        rango: "TODO",
        conVelas: true,
        segundosHueco: 700,
        puntos: [punto(100, 0, 0, 8), punto(200, 0, 0, 9), punto(300, 0, 0, 10), punto(400, 0, 0, 11)],
        operaciones: [operacion("compra", 1), operacion("compra", 3)]
    }
    const rango = {
        ...datos([punto(400, 0, 0, 11), punto(450, 0, 0, 12), punto(500, 0, 0, 22)], [operacion("venta", 2)], 60),
        rango: "YTD",
        conVelas: true
    }

    it("pone delante lo anterior y reajusta el índice de las operaciones", () => {
        const unidos = window.assetGraficoUnirContexto(rango, contexto)
        expect(unidos.puntos.map((p) => p.ts)).toEqual([100, 200, 300, 400, 450, 500])
        expect(unidos.inicioDetalle).toBe(400)
        // La compra del punto 3 de «Todo» ya está en el rango: no se repite.
        expect(unidos.operaciones.map((op) => [op.tipo, op.indice])).toEqual([
            ["compra", 1],
            ["venta", 5]
        ])
    })

    it("sin contexto, en «Todo» o con otro origen de datos no añade nada", () => {
        expect(window.assetGraficoUnirContexto(rango, null)).toBe(rango)
        expect(window.assetGraficoUnirContexto({ ...rango, rango: "TODO" }, contexto).puntos).toHaveLength(3)
        expect(window.assetGraficoUnirContexto(rango, { ...contexto, conVelas: false }).puntos).toHaveLength(3)
    })

    it("el % y los límites salen del rango, pero se pinta también lo anterior", () => {
        const unidos = window.assetGraficoUnirContexto(rango, contexto)
        const encuadre = window.assetGraficoEncuadre(unidos, { desde: "", hasta: "" })
        const series = window.assetGraficoSeries(unidos, "precio", "pct", encuadre)
        expect(series.linea.filter((p) => Number.isFinite(p.y))).toHaveLength(6)
        expect(series.limitesX).toEqual({ min: 400, max: 500 })
        expect(series.ultimo.y).toBeCloseTo(100)
        expect(series.extremos.minimo.y).toBe(0)
        expect(series.compras).toHaveLength(1)
        expect(series.comprasVisibles).toHaveLength(0)
        expect(series.ventasVisibles).toHaveLength(1)
    })

    it("lo anterior se une con el hueco de «Todo» y el rango con el suyo", () => {
        const unidos = window.assetGraficoUnirContexto(rango, contexto)
        const { linea } = window.assetGraficoSeries(unidos, "precio", "eur", { min: 400, max: Infinity })
        // 100 s entre velas diarias no corta (hueco 700); 50 s en el rango tampoco (60).
        expect(linea.some((p) => p.y === null)).toBe(false)
    })

    it("en los rangos intradía con velas no mezcla las diarias de «Todo»", () => {
        // Las anteriores ya llegan del servidor con la misma resolución.
        const intradia = { ...rango, rango: "30D" }
        expect(window.assetGraficoUnirContexto(intradia, contexto)).toBe(intradia)
        // Sin velas (snapshots, línea) sí se añaden.
        const sinVelas = { ...intradia, conVelas: false }
        expect(window.assetGraficoUnirContexto(sinVelas, { ...contexto, conVelas: false }).puntos).toHaveLength(6)
    })

    it("encuadra desde el inicio del rango aunque haya puntos anteriores", () => {
        const conPrevios = { ...rango, rango: "30D", inicioRango: 450 }
        const encuadre = window.assetGraficoEncuadre(conPrevios, { desde: "", hasta: "" })
        expect(encuadre).toEqual({ min: 450, max: Infinity })
        const series = window.assetGraficoSeries(conPrevios, "precio", "eur", encuadre)
        expect(series.limitesX).toEqual({ min: 450, max: 500 })
        expect(series.linea).toHaveLength(3)
        // En «Todo» el inicio es 0 y no encuadra nada.
        expect(window.assetGraficoEncuadre({ ...rango, inicioRango: 0 }, { desde: "", hasta: "" }).min).toBe(-Infinity)
    })

    it("con temporalidad encuadra las últimas velas y deja el resto para alejar", () => {
        const vela = (ts) => ({ ...punto(ts, 0, 0, 10), apertura: 10, maximo: 11, minimo: 9 })
        const muchas = Array.from({ length: 400 }, (_valor, indice) => vela(1000 + indice * 60))
        // Un punto de operación entre velas no cuenta como vela.
        const conOperacion = [...muchas.slice(0, 300), punto(1000 + 299 * 60 + 30, 0, 0, 10), ...muchas.slice(300)]
        const encuadre = window.assetGraficoEncuadre({ ...datos(conOperacion), temporalidad: "1h" }, { desde: "", hasta: "" })
        expect(encuadre.min).toBe(muchas[400 - 150].ts)
        // Con menos velas que el encuadre se ven todas.
        expect(window.assetGraficoEncuadre({ ...datos(muchas.slice(0, 20)), temporalidad: "1h" }, { desde: "", hasta: "" }).min).toBe(
            -Infinity
        )
    })

    it("con fechas encuadra esas fechas", () => {
        const encuadre = window.assetGraficoEncuadre(rango, { desde: "2026-02-10", hasta: "" })
        expect(encuadre.min).toBe(new Date("2026-02-10T00:00:00").getTime() / 1000)
        expect(encuadre.max).toBe(Infinity)
    })
})

describe("días con operaciones para el calendario", () => {
    it("agrupa los tipos por día en formato ISO", () => {
        const dias = window.assetGraficoDiasConOperaciones([
            operacion("compra", 0, { fecha: "05-03-2026" }),
            operacion("venta", 1, { fecha: "05-03-2026" }),
            operacion("compra", 2, { fecha: "07-03-2026" })
        ])
        expect([...dias.get("2026-03-05")].sort()).toEqual(["compra", "venta"])
        expect([...dias.get("2026-03-07")]).toEqual(["compra"])
        expect(dias.size).toBe(2)
    })

    it("ignora fechas ilegibles y listas vacías", () => {
        expect(window.assetGraficoDiasConOperaciones([operacion("compra", 0, { fecha: "" })]).size).toBe(0)
        expect(window.assetGraficoDiasConOperaciones(undefined).size).toBe(0)
    })
})

describe("velas japonesas", () => {
    const conVela = (ts, apertura, maximo, minimo, cierre) => ({ ...punto(ts, 1, 1, cierre), apertura, maximo, minimo })

    it("cada punto de TradingView lleva su vela en euros", () => {
        const { linea } = window.assetGraficoSeries(datos([conVela(100, 9, 12, 8, 10), conVela(200, 10, 11, 9, 9.5)]), "precio", "eur")
        expect(linea[0].vela).toEqual({ apertura: 9, maximo: 12, minimo: 8, cierre: 10 })
    })

    it("en % la vela se refiere al primer cierre, como la línea", () => {
        const { linea } = window.assetGraficoSeries(datos([conVela(100, 9, 12, 8, 10), conVela(200, 10, 11, 9, 11)]), "precio", "pct")
        expect(linea[1].vela.apertura).toBeCloseTo(0)
        expect(linea[1].vela.maximo).toBeCloseTo(10)
        expect(linea[1].vela.cierre).toBeCloseTo(10)
    })

    it("no hay velas en la vista de posición ni en puntos sin apertura", () => {
        const puntos = [conVela(100, 9, 12, 8, 10), punto(200, 1, 1, 10)]
        expect(window.assetGraficoSeries(datos(puntos), "posicion", "eur").linea[0].vela).toBeUndefined()
        expect(window.assetGraficoSeries(datos(puntos), "precio", "eur").linea[1].vela).toBeUndefined()
    })

    it("los extremos con velas son los de las mechas", () => {
        const { extremosVelas } = window.assetGraficoSeries(
            datos([conVela(100, 9, 12, 8, 10), conVela(200, 10, 15, 7, 11)]),
            "precio",
            "eur"
        )
        expect(extremosVelas).toEqual({ maximo: { x: 200, y: 15 }, minimo: { x: 200, y: 7 } })
    })

    it("solo se usan con la vista de precio y datos de TradingView", () => {
        expect(window.assetGraficoUsaVelas({ conVelas: true }, "precio", "velas")).toBe(true)
        expect(window.assetGraficoUsaVelas({ conVelas: false }, "precio", "velas")).toBe(false)
        expect(window.assetGraficoUsaVelas({ conVelas: true }, "posicion", "velas")).toBe(false)
        expect(window.assetGraficoUsaVelas({ conVelas: true }, "precio", "linea")).toBe(false)
    })

    it("el cuerpo ocupa parte del menor hueco, con tope y mínimo", () => {
        expect(window.assetGraficoAnchoVela([0, 10, 30])).toBeCloseTo(7)
        expect(window.assetGraficoAnchoVela([0, 100])).toBe(14)
        expect(window.assetGraficoAnchoVela([0, 0.5, 1])).toBe(1)
        expect(window.assetGraficoAnchoVela([50])).toBe(14)
    })

    it("la marca de una operación va a la vela de su día, aunque la vela abra a otra hora", () => {
        const ts = (iso) => new Date(iso).getTime() / 1000
        // Vela de bolsa que abre a las 15:30 y operación a mediodía, sin vela propia.
        const puntos = [
            conVela(ts("2026-03-09T15:30:00"), 9, 11, 8, 10),
            punto(ts("2026-03-10T12:00:00"), 1, 1, 10),
            conVela(ts("2026-03-10T15:30:00"), 10, 12, 9, 11),
            conVela(ts("2026-03-11T15:30:00"), 11, 12, 10, 11)
        ]
        const series = window.assetGraficoSeries(datos(puntos, [operacion("compra", 1)], 100000), "precio", "eur")
        expect(series.linea[1].xVela).toBe(ts("2026-03-10T15:30:00"))
        expect(series.compras[0].xVela).toBe(ts("2026-03-10T15:30:00"))
        expect(window.assetGraficoEnVela(series.compras[0]).x).toBe(ts("2026-03-10T15:30:00"))
    })

    it("en rangos intradía la operación va a la vela más cercana de su día", () => {
        const ts = (iso) => new Date(iso).getTime() / 1000
        const puntos = [
            conVela(ts("2026-03-10T11:00:00"), 9, 11, 8, 10),
            conVela(ts("2026-03-10T11:30:00"), 9, 11, 8, 10),
            punto(ts("2026-03-10T12:00:00"), 1, 1, 10),
            conVela(ts("2026-03-10T13:00:00"), 9, 11, 8, 10)
        ]
        const { linea } = window.assetGraficoSeries(datos(puntos, [], 100000), "precio", "eur")
        expect(linea[2].xVela).toBe(ts("2026-03-10T11:30:00"))
    })

    it("sin vela ese día la marca se queda donde estaba", () => {
        const ts = (iso) => new Date(iso).getTime() / 1000
        const puntos = [conVela(ts("2026-03-09T15:30:00"), 9, 11, 8, 10), punto(ts("2026-03-10T12:00:00"), 1, 1, 10)]
        const series = window.assetGraficoSeries(datos(puntos, [operacion("compra", 1)], 100000), "precio", "eur")
        expect(series.compras[0].xVela).toBeUndefined()
        expect(window.assetGraficoEnVela(series.compras[0])).toBe(series.compras[0])
    })

    it("la nota dice que las velas salen de TradingView", () => {
        const serie = { operacionesSinValor: 0 }
        const texto = window.assetGraficoTextoNota({ conVelas: true, operacionesSinPunto: 0 }, serie, "precio", "EUR", true)
        expect(texto).toBe("Las velas salen de la cotización de TradingView.")
    })

    it("el tooltip de una vela da apertura, máximo, mínimo y cierre", () => {
        const contexto = { datasetIndex: 0, raw: { y: 10, vela: { apertura: 9, maximo: 12, minimo: 8, cierre: 10 } } }
        const lineas = window.assetGraficoEtiquetasTooltip(contexto, "precio", "eur", true)
        expect(lineas.map((linea) => linea.split(":")[0])).toEqual(["Apertura", "Máximo", "Mínimo", "Cierre"])
    })
})

describe("vista ampliada", () => {
    function montar() {
        document.body.innerHTML = `
            <section id="assetGraficoSection">
                <div class="assetGrafico"><button id="assetGraficoAmpliar" aria-pressed="false"></button></div>
                <div class="assetGraficoFondo hidden" id="assetGraficoFondo"></div>
            </section>`
        window.assetGraficoRegistrarEscape()
        return {
            panel: document.querySelector("#assetGraficoSection .assetGrafico"),
            boton: document.getElementById("assetGraficoAmpliar"),
            fondo: document.getElementById("assetGraficoFondo")
        }
    }

    it("amplía y reduce el panel con su fondo y el estado del botón", () => {
        const { panel, boton, fondo } = montar()
        window.assetGraficoAmpliar(true)
        expect(panel.classList.contains("assetGraficoAmpliado")).toBe(true)
        expect(fondo.classList.contains("hidden")).toBe(false)
        expect(boton.getAttribute("aria-pressed")).toBe("true")
        expect(boton.title).toBe("Reducir gráfico")
        window.assetGraficoAmpliar(false)
        expect(panel.classList.contains("assetGraficoAmpliado")).toBe(false)
        expect(fondo.classList.contains("hidden")).toBe(true)
        expect(boton.getAttribute("aria-pressed")).toBe("false")
    })

    it("Escape la cierra", () => {
        const { panel } = montar()
        window.assetGraficoAmpliar(true)
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
        expect(panel.classList.contains("assetGraficoAmpliado")).toBe(false)
    })

    it("un Escape que ya ha usado otro (el calendario) no la cierra", () => {
        const { panel } = montar()
        window.assetGraficoAmpliar(true)
        const evento = new KeyboardEvent("keydown", { key: "Escape", cancelable: true })
        evento.preventDefault()
        document.dispatchEvent(evento)
        expect(panel.classList.contains("assetGraficoAmpliado")).toBe(true)
    })

    it("sin el esqueleto pintado no hace nada", () => {
        document.body.innerHTML = ""
        expect(() => window.assetGraficoAmpliar(true)).not.toThrow()
    })
})

describe("detalle de cada compra y venta", () => {
    const compra = (extra = {}) => ({ tipo: "compra", fecha: "05-11-2026", cantidad: 2, precio: 10, divisa: "EUR", ...extra })

    it("el importe en euros sale del precio convertido por el servidor", () => {
        expect(window.assetGraficoImporteEur(compra({ precio: 12, divisa: "USD", precioEur: 11 }))).toBe(22)
    })

    it("sin precio convertido vale el propio si la operación es en euros", () => {
        expect(window.assetGraficoImporteEur(compra())).toBe(20)
    })

    it("sin precio convertido ni euros, o sin cantidad, no hay importe en euros", () => {
        expect(window.assetGraficoImporteEur(compra({ divisa: "USD" }))).toBeNull()
        expect(window.assetGraficoImporteEur(compra({ cantidad: 0 }))).toBeNull()
        expect(window.assetGraficoImporteEur(compra({ precio: null }))).toBeNull()
    })

    it("una compra da la operación, lo invertido y su peso sobre el total de la cartera", () => {
        const lineas = window.assetGraficoLineasOperacion(compra(), "acciones", 1000)
        expect(lineas).toHaveLength(3)
        expect(lineas[0]).toMatch(/^Compra: .+ a 10,00/)
        expect(lineas[1]).toMatch(/^Invertido: 20,00/)
        expect(lineas[2]).toBe("Peso en la cartera: 2,00 %")
    })

    it("una venta dice lo vendido", () => {
        const lineas = window.assetGraficoLineasOperacion(compra({ tipo: "venta" }), "acciones", 1000)
        expect(lineas[0]).toMatch(/^Venta: /)
        expect(lineas[1]).toMatch(/^Vendido: 20,00/)
    })

    it("sin total de la cartera no inventa el peso", () => {
        expect(window.assetGraficoLineasOperacion(compra(), "acciones", 0)).toHaveLength(2)
    })

    it("sin cambio a euros da el importe en su divisa y no el peso", () => {
        const lineas = window.assetGraficoLineasOperacion(compra({ divisa: "USD" }), "acciones", 1000)
        expect(lineas).toHaveLength(2)
        expect(lineas[1]).toMatch(/^Invertido: 20,00/)
        expect(lineas[1]).toMatch(/\$|USD/)
    })

    it("sin precio solo dice la cantidad", () => {
        const lineas = window.assetGraficoLineasOperacion(compra({ precio: null }), "acciones", 1000)
        expect(lineas).toHaveLength(1)
        expect(lineas[0]).not.toContain(" a ")
    })

    it("el tooltip de un punto lleva el detalle de cada operación que agrupa", () => {
        document.body.innerHTML = `<div class="assetTablePage" data-asset-type="acciones"></div>`
        window._lastPortfolioMetrics = { totalCuenta: 1000 }
        const contexto = { datasetIndex: 1, raw: { operaciones: [compra(), compra({ cantidad: 1 })] } }
        const lineas = window.assetGraficoEtiquetasTooltip(contexto, "precio", "eur")
        expect(lineas.filter((linea) => linea.startsWith("Peso en la cartera"))).toEqual([
            "Peso en la cartera: 2,00 %",
            "Peso en la cartera: 1,00 %"
        ])
        delete window._lastPortfolioMetrics
    })

    it("la clave de un punto no cambia con su altura ni su posición en la línea", () => {
        const operaciones = [compra()]
        const clave = window.assetGraficoClaveMarca({ operaciones, y: 10, indiceLinea: 3 })
        expect(window.assetGraficoClaveMarca({ operaciones, y: 0.5, indiceLinea: 7 })).toBe(clave)
        expect(window.assetGraficoClaveMarca({ operaciones: [compra({ cantidad: 3 })] })).not.toBe(clave)
    })
})

describe("detalles fijados al pulsar un punto", () => {
    const marca = (cantidad) => ({
        x: new Date("2026-11-05T12:00:00").getTime() / 1000,
        y: 10,
        operaciones: [{ tipo: "compra", fecha: "05-11-2026", cantidad, precio: 10, divisa: "EUR" }]
    })

    function montar() {
        document.body.innerHTML = `
            <div class="assetTablePage" data-asset-type="acciones"></div>
            <div id="assetGraficoLienzo">
                <canvas id="assetGraficoCanvas"></canvas>
                <div id="assetGraficoFichas"></div>
                <button id="assetGraficoOcultarFichas" class="hidden"></button>
            </div>`
    }

    // Chart.js no funciona en jsdom: basta lo que leen las funciones del gráfico.
    function graficoFalso(compras, ventas = []) {
        const datasets = [{ data: [] }, { data: compras.map((c) => c.marca) }, { data: ventas.map((v) => v.marca) }]
        const metas = [{ data: [] }, { data: compras.map((c) => c.px) }, { data: ventas.map((v) => v.px) }]
        return {
            canvas: document.getElementById("assetGraficoCanvas"),
            width: 560,
            height: 340,
            chartArea: { left: 0, right: 500, top: 0, bottom: 300 },
            data: { datasets },
            getDatasetMeta: (indice) => metas[indice],
            update: vi.fn()
        }
    }

    const plugin = () => window.assetGraficoPluginFijadas(() => "05 nov 2026")
    const fichas = () => [...document.querySelectorAll(".assetGraficoFicha")]
    const boton = () => document.getElementById("assetGraficoOcultarFichas")

    beforeEach(() => {
        montar()
        window.assetGraficoOcultarFijadas()
    })

    it("solo coge un punto cercano en las dos direcciones", () => {
        const chart = graficoFalso([{ marca: marca(1), px: { x: 100, y: 100 } }])
        expect(window.assetGraficoMarcaEn(chart, 105, 105)).toBe(chart.data.datasets[1].data[0])
        expect(window.assetGraficoMarcaEn(chart, 100, 200)).toBeNull()
        expect(window.assetGraficoMarcaEn(chart, 200, 100)).toBeNull()
    })

    it("de dos puntos a tiro coge el más cercano, sea compra o venta", () => {
        const chart = graficoFalso([{ marca: marca(1), px: { x: 100, y: 100 } }], [{ marca: marca(2), px: { x: 108, y: 100 } }])
        expect(window.assetGraficoMarcaEn(chart, 106, 100)).toBe(chart.data.datasets[2].data[0])
    })

    it("pulsar un punto fija su detalle y saca el botón para ocultarlo", () => {
        const chart = graficoFalso([{ marca: marca(1), px: { x: 100, y: 100 } }])
        window.assetGraficoAlternarFijada(chart, { x: 100, y: 100 })
        expect(chart.update).toHaveBeenCalled()
        plugin().afterDraw(chart)
        expect(fichas()).toHaveLength(1)
        expect(fichas()[0].querySelector("strong").textContent).toBe("05 nov 2026")
        expect(fichas()[0].textContent).toContain("Invertido")
        expect(fichas()[0].style.left).toBe("114px")
        expect(boton().classList.contains("hidden")).toBe(false)
    })

    it("se pueden fijar varios a la vez y volver a pulsar uno lo suelta", () => {
        const chart = graficoFalso([
            { marca: marca(1), px: { x: 100, y: 100 } },
            { marca: marca(2), px: { x: 300, y: 100 } }
        ])
        window.assetGraficoAlternarFijada(chart, { x: 100, y: 100 })
        window.assetGraficoAlternarFijada(chart, { x: 300, y: 100 })
        plugin().afterDraw(chart)
        expect(fichas()).toHaveLength(2)
        window.assetGraficoAlternarFijada(chart, { x: 100, y: 100 })
        plugin().afterDraw(chart)
        expect(fichas()).toHaveLength(1)
        window.assetGraficoAlternarFijada(chart, { x: 300, y: 100 })
        plugin().afterDraw(chart)
        expect(fichas()).toHaveLength(0)
        expect(boton().classList.contains("hidden")).toBe(true)
    })

    it("pulsar fuera de los puntos no fija nada", () => {
        const chart = graficoFalso([{ marca: marca(1), px: { x: 100, y: 100 } }])
        window.assetGraficoAlternarFijada(chart, { x: 250, y: 250 })
        expect(chart.update).not.toHaveBeenCalled()
        plugin().afterDraw(chart)
        expect(fichas()).toHaveLength(0)
    })

    it("el botón los oculta todos", () => {
        const chart = graficoFalso([
            { marca: marca(1), px: { x: 100, y: 100 } },
            { marca: marca(2), px: { x: 300, y: 100 } }
        ])
        window.assetGraficoAlternarFijada(chart, { x: 100, y: 100 })
        window.assetGraficoAlternarFijada(chart, { x: 300, y: 100 })
        plugin().afterDraw(chart)
        window.assetGraficoOcultarFijadas()
        expect(fichas()).toHaveLength(0)
        expect(boton().classList.contains("hidden")).toBe(true)
        plugin().afterDraw(chart)
        expect(fichas()).toHaveLength(0)
    })

    it("un detalle fijado sobrevive a un gráfico nuevo con el mismo punto", () => {
        const chart = graficoFalso([{ marca: marca(1), px: { x: 100, y: 100 } }])
        window.assetGraficoAlternarFijada(chart, { x: 100, y: 100 })
        plugin().afterDraw(chart)
        window.assetGraficoQuitarFichas()
        expect(fichas()).toHaveLength(0)
        // Otra vista: el mismo punto a otra altura.
        const otro = graficoFalso([{ marca: { ...marca(1), y: 0.5 }, px: { x: 100, y: 250 } }])
        plugin().afterDraw(otro)
        expect(fichas()).toHaveLength(1)
    })

    it("la ficha de un punto que queda fuera del área se esconde", () => {
        const chart = graficoFalso([{ marca: marca(1), px: { x: 100, y: 100 } }])
        window.assetGraficoAlternarFijada(chart, { x: 100, y: 100 })
        chart.getDatasetMeta(1).data[0].x = 600
        plugin().afterDraw(chart)
        expect(fichas()[0].classList.contains("hidden")).toBe(true)
    })

    it("el botón va arriba a la derecha y, si sale «Centrar», a su izquierda", () => {
        const chart = graficoFalso([{ marca: marca(1), px: { x: 100, y: 100 } }])
        window.assetGraficoAlternarFijada(chart, { x: 100, y: 100 })
        plugin().afterDraw(chart)
        expect(boton().style.left).toBe("494px")
        expect(boton().style.top).toBe("6px")
        globalThis.escalaPrecioBotonCentrar = () => ({ x: 420, y: 6, ancho: 74, alto: 22 })
        try {
            plugin().afterDraw(chart)
            expect(boton().style.left).toBe("414px")
        } finally {
            delete globalThis.escalaPrecioBotonCentrar
        }
    })
})

describe("fichas fijadas sin pisarse", () => {
    const caja = (left, top, alto = 40, extra = {}) => ({ left, top, ancho: 100, alto, min: 0, max: 500, ...extra })
    const pisan = (a, b) =>
        a.left < b.left + b.ancho && b.left < a.left + a.ancho && a.top < b.top + b.alto && b.top < a.top + a.alto

    it("una ficha libre se queda junto a su punto", () => {
        const [sola] = window.assetGraficoRepartirFichas([caja(0, 120)], 6)
        expect(sola.top).toBe(120)
    })

    it("dos que se pisan se separan lo justo y la de arriba no se mueve", () => {
        const [a, b] = window.assetGraficoRepartirFichas([caja(0, 100), caja(50, 110)], 6)
        expect(a.top).toBe(100)
        expect(b.top).toBe(146)
    })

    it("si no cabe debajo se pone encima", () => {
        const [a, b] = window.assetGraficoRepartirFichas([caja(0, 440, 40, { max: 460 }), caja(50, 450, 40, { max: 460 })], 6)
        expect(pisan(a, b)).toBe(false)
        expect(Math.max(a.top, b.top)).toBeLessThanOrEqual(460)
    })

    it("con varias apiladas ninguna pisa a otra", () => {
        const cajas = window.assetGraficoRepartirFichas([caja(0, 200, 90), caja(30, 210, 50), caja(60, 190, 70), caja(10, 205, 30)], 6)
        cajas.forEach((a, i) => cajas.slice(i + 1).forEach((b) => expect(pisan(a, b)).toBe(false)))
        cajas.forEach((c) => expect(c.top).toBeGreaterThanOrEqual(0))
    })

    it("dos a la misma altura pero lejos en horizontal no se mueven", () => {
        const [a, b] = window.assetGraficoRepartirFichas([caja(0, 100), caja(300, 100)], 6)
        expect([a.top, b.top]).toEqual([100, 100])
    })

    it("sin hueco en vertical se pasa al otro lado de su punto", () => {
        const [, b] = window.assetGraficoRepartirFichas(
            [caja(0, 0, 40, { max: 0 }), caja(50, 0, 40, { max: 0, lados: [50, 200] })],
            6
        )
        expect(b.left).toBe(200)
        expect(b.top).toBe(0)
    })

    it("con poco que mover prefiere seguir en su lado y, con mucho, cambiar", () => {
        const [, cerca] = window.assetGraficoRepartirFichas([caja(0, 100), caja(50, 130, 40, { lados: [50, 200] })], 6)
        expect([cerca.left, cerca.top]).toEqual([50, 146])
        const [, lejos] = window.assetGraficoRepartirFichas([caja(0, 100), caja(50, 100, 40, { lados: [50, 200] })], 6)
        expect([lejos.left, lejos.top]).toEqual([200, 100])
    })

    it("no tapa los obstáculos, como los botones de arriba", () => {
        const botones = { left: 0, top: 6, ancho: 150, alto: 22 }
        const [a] = window.assetGraficoRepartirFichas([caja(20, 0)], 6, [botones])
        expect(pisan(a, botones)).toBe(false)
        expect(a.top).toBe(34)
    })

    it("sin ningún hueco libre va donde menos pisa", () => {
        const [a, b] = window.assetGraficoRepartirFichas(
            [caja(0, 0, 40, { max: 30 }), caja(0, 0, 40, { max: 30, lados: [0, 60] })],
            6
        )
        expect(a.top).toBe(0)
        expect(b.left).toBe(60)
    })
})

describe("cifras del eje vertical", () => {
    const pasos = (marcas, transformar = (v) => v) =>
        marcas.slice(1).map((valor, indice) => transformar(valor) - transformar(marcas[indice]))

    it("en lineal pone un paso redondo y constante", () => {
        expect(window.assetGraficoMarcasEjeY(0, 100, 220, false)).toEqual([20, 40, 60, 80, 100])
        const marcas = window.assetGraficoMarcasEjeY(43047, 90000, 480, false)
        expect(new Set(pasos(marcas)).size).toBe(1)
        expect(marcas.length).toBeGreaterThanOrEqual(8)
    })

    it("más alto, más cifras", () => {
        const bajo = window.assetGraficoMarcasEjeY(43047, 90000, 250, true)
        const alto = window.assetGraficoMarcasEjeY(43047, 90000, 500, true)
        expect(alto.length).toBeGreaterThan(bajo.length)
    })

    it("en LOG las cifras quedan a casi la misma distancia en pantalla y son redondas", () => {
        const marcas = window.assetGraficoMarcasEjeY(43047, 90000, 480, true)
        expect(marcas.length).toBeGreaterThanOrEqual(8)
        const saltos = pasos(marcas, Math.log10)
        expect(Math.max(...saltos) / Math.min(...saltos)).toBeLessThan(1.6)
        marcas.forEach((valor) => expect(valor % 100).toBe(0))
    })

    it("todas dentro del eje, ordenadas y sin repetir", () => {
        ;[
            [43047, 90000, 480, true],
            [57000, 58000, 480, true],
            [-12.5, 8.3, 300, false],
            [0.0012, 0.0019, 400, true]
        ].forEach(([min, max, alto, log]) => {
            const marcas = window.assetGraficoMarcasEjeY(min, max, alto, log)
            expect(marcas.length).toBeGreaterThanOrEqual(2)
            marcas.forEach((valor) => expect(valor >= min && valor <= max).toBe(true))
            pasos(marcas).forEach((salto) => expect(salto).toBeGreaterThan(0))
        })
    })

    it("no escribe cifras pegadas al borde de abajo, donde están las fechas y AUTO / LOG", () => {
        // 50.000 cae en el mismo borde inferior: se la salta.
        const marcas = window.assetGraficoMarcasEjeY(50000, 90000, 480, true)
        expect(marcas[0]).toBeGreaterThan(50000)
        expect(window.assetGraficoMarcasEjeY(0, 100, 220, false)).not.toContain(0)
    })

    it("con valores no positivos en LOG cae a lineal y sin rango no da nada", () => {
        expect(window.assetGraficoMarcasEjeY(-5, 5, 220, true)).toEqual([-4, -2, 0, 2, 4])
        expect(window.assetGraficoMarcasEjeY(5, 5, 220, false)).toEqual([])
    })
})

describe("margen a la derecha de la última vela", () => {
    it("deja un hueco proporcional al tramo visible cuando se ve el último dato", () => {
        expect(window.assetGraficoMaxConMargen({ min: 0, max: 1000 }, 1000)).toBe(1100)
    })

    it("no lo deja si el tramo acaba antes del último dato", () => {
        expect(window.assetGraficoMaxConMargen({ min: 0, max: 1000 }, 2000)).toBe(1000)
    })

    it("sin dato final conocido deja el eje como está", () => {
        expect(window.assetGraficoMaxConMargen({ min: 0, max: 1000 }, undefined)).toBe(1000)
    })
})
