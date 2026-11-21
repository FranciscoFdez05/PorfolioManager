// Comparar activos: alineado de varias series, métricas, lista de activos y listas guardadas.
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/analisis/herramientas-comparador.js")
})

const dia = (y, m, d) => Date.UTC(y, m - 1, d) / 1000

describe("hCmpAlinear", () => {
    it("solo deja los días con cierre en todas las series", () => {
        const a = [
            [dia(2024, 1, 5), 100],
            [dia(2024, 1, 6), 101], // sábado: solo cotiza A
            [dia(2024, 1, 8), 102]
        ]
        const b = [
            [dia(2024, 1, 8), 20],
            [dia(2024, 1, 5), 10]
        ]
        const c = [
            [dia(2024, 1, 5), 1],
            [dia(2024, 1, 8), 2],
            [dia(2024, 1, 9), 3]
        ]

        const r = hCmpAlinear([a, b, c])

        expect(r.dias).toEqual(["2024-01-05", "2024-01-08"])
        expect(r.cierres).toEqual([
            [100, 102],
            [10, 20],
            [1, 2]
        ])
    })

    it("descarta cierres no positivos y devuelve vacío sin días comunes", () => {
        const r = hCmpAlinear([[[dia(2024, 1, 5), 0]], [[dia(2024, 1, 5), 10]]])

        expect(r.dias).toEqual([])
        expect(r.cierres).toEqual([[], []])
    })

    it("acepta marcas en milisegundos", () => {
        const ms = Date.UTC(2024, 0, 5)
        expect(hCmpAlinear([[[ms, 1]], [[ms / 1000, 2]]]).dias).toEqual(["2024-01-05"])
    })
})

describe("hCmpRecortar", () => {
    it("cuenta los meses desde el último dato y 0 deja todo", () => {
        const ts = [2023, 2024, 2025].map((y) => Date.UTC(y, 5, 1))
        const datos = { dias: ["a", "b", "c"], ts, cierres: [[1, 2, 3]] }

        expect(hCmpRecortar(datos, 12).cierres).toEqual([[2, 3]])
        expect(hCmpRecortar(datos, 0)).toBe(datos)
    })
})

describe("hCmpVariacion", () => {
    it("mide cada cierre frente al primero", () => {
        expect(hCmpVariacion([50, 75, 25])).toEqual([0, 50, -50])
    })
})

describe("hCmpEstadisticas", () => {
    it("calcula rentabilidad, CAGR y caída máxima", () => {
        const ts = [Date.UTC(2020, 0, 1), Date.UTC(2021, 0, 1), Date.UTC(2022, 0, 1)]
        const e = hCmpEstadisticas([100, 50, 121], ts)

        expect(e.rentabilidad).toBeCloseTo(0.21)
        // 1,21 en dos años = 10 % anual.
        expect(e.cagr).toBeCloseTo(0.1, 3)
        expect(e.caidaMaxima).toBeCloseTo(-0.5)
        expect(e.volatilidad).toBeGreaterThan(0)
    })

    it("no anualiza con menos de un año", () => {
        const ts = [Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1)]
        expect(hCmpEstadisticas([100, 110], ts).cagr).toBeNull()
    })

    it("devuelve null con menos de dos cierres", () => {
        expect(hCmpEstadisticas([100], [0])).toBeNull()
    })
})

describe("hCmpCorrelacion", () => {
    it("vale 1 con series que se mueven igual y -1 con opuestas", () => {
        const a = [100, 110, 99, 120, 108]
        const doble = a.map((x) => x * 2)
        const opuesta = [100, 90, 101, 80, 92]

        expect(hCmpCorrelacion(a, doble)).toBeCloseTo(1)
        expect(hCmpCorrelacion(a, opuesta)).toBeLessThan(-0.9)
    })

    it("es null si una serie no varía o no hay datos", () => {
        expect(hCmpCorrelacion([1, 1, 1, 1], [1, 2, 3, 4])).toBeNull()
        expect(hCmpCorrelacion([1, 2], [3, 4])).toBeNull()
    })
})

describe("hCmpTickerDeResultado", () => {
    it("sin buildTVSymbol deja el ticker tal cual en mayúsculas", () => {
        expect(hCmpTickerDeResultado({ symbol: "nasdaq:nvda" }, "tradingview")).toBe("NASDAQ:NVDA")
        expect(hCmpTickerDeResultado({ symbol: "" }, "finnhub")).toBe("")
    })

    it("traduce con buildTVSymbol usando el proveedor del resultado", () => {
        globalThis.buildTVSymbol = (a) => `${a.marketProvider}|${a.marketSymbol}`
        try {
            expect(hCmpTickerDeResultado({ symbol: "AMD.US", provider: "eodhd" }, "finnhub")).toBe("EODHD|AMD.US")
        } finally {
            delete globalThis.buildTVSymbol
        }
    })
})

// La lista activa tal como queda guardada en el navegador.
const guardadaActiva = () => {
    const { activa, listas } = JSON.parse(localStorage.getItem("hCmpListas"))
    return listas.find((l) => l.id === activa)
}

// Página mínima y una sola lista vacía, como al abrir la herramienta la primera vez.
const empezar = () => {
    document.body.innerHTML = `
        <div id="hCmpListasFila">
            <button id="hCmpListaNuevaBtn"></button>
            <select id="hCmpListaSelect"></select>
            <input id="hCmpListaNombre">
            <button id="hCmpListaRenombrarBtn"></button>
            <button id="hCmpListaBorrarBtn"></button>
        </div>
        <ul id="hCmpLista"></ul><span id="hCmpMsg"></span><span id="hCmpContador"></span>`
    hCmpConectarListas()
    localStorage.clear()
    _hCmpDatos = null
    _hCmpListaActiva = ""
    _hCmpListas = [{ id: "l1", nombre: "Mi comparación", series: [] }]
    hCmpActivarLista("l1")
}

describe("hCmpAnadir", () => {
    beforeEach(empezar)

    it("añade, normaliza y no repite", () => {
        expect(hCmpAnadir("nasdaq:nvda", "NVIDIA")).toBe(true)
        expect(hCmpAnadir("NASDAQ:NVDA", "Otra vez")).toBe(false)

        expect(_hCmpLista.map((s) => s.ticker)).toEqual(["NASDAQ:NVDA"])
        expect(document.querySelectorAll("#hCmpLista li")).toHaveLength(1)
        expect(guardadaActiva().series[0].ticker).toBe("NASDAQ:NVDA")
    })

    it("rechaza lo que no tiene forma de ticker", () => {
        expect(hCmpAnadir("NVIDIA CORP", "x")).toBe(false)
        expect(document.getElementById("hCmpMsg").textContent).toContain("no tiene forma de ticker")
    })

    it("no pasa del máximo y da colores distintos", () => {
        for (let i = 0; i < 10; i++) hCmpAnadir(`T${i}`, `T${i}`)

        expect(_hCmpLista).toHaveLength(8)
        expect(new Set(_hCmpLista.map((s) => s.color)).size).toBe(8)
    })

    it("quitar actualiza la lista guardada", () => {
        hCmpAnadir("AMD", "AMD")
        hCmpAnadir("NVDA", "NVDA")
        hCmpQuitar("AMD")

        expect(guardadaActiva().series.map((s) => s.ticker)).toEqual(["NVDA"])
    })
})

describe("hCmpLeerListas", () => {
    beforeEach(() => localStorage.clear())

    it("sin nada guardado da una lista vacía activa", () => {
        const { listas, activa } = hCmpLeerListas()

        expect(listas).toHaveLength(1)
        expect(listas[0].series).toEqual([])
        expect(activa).toBe(listas[0].id)
    })

    it("migra la lista única de antes a la primera lista", () => {
        localStorage.setItem("hCmpLista", JSON.stringify([{ ticker: "AMD", nombre: "AMD", color: "#f00" }]))

        const { listas } = hCmpLeerListas()

        expect(listas).toHaveLength(1)
        expect(listas[0].series.map((s) => s.ticker)).toEqual(["AMD"])
    })

    it("descarta tickers no válidos o repetidos y corrige una activa que no existe", () => {
        localStorage.setItem(
            "hCmpListas",
            JSON.stringify({
                activa: "nope",
                listas: [
                    {
                        id: "a",
                        nombre: "Semis",
                        series: [{ ticker: "AMD" }, { ticker: "AMD" }, { ticker: "mal ticker" }]
                    }
                ]
            })
        )

        const { listas, activa } = hCmpLeerListas()

        expect(listas[0].series.map((s) => s.ticker)).toEqual(["AMD"])
        expect(activa).toBe("a")
    })

    it("con datos corruptos empieza de cero", () => {
        localStorage.setItem("hCmpListas", "{no es json")
        expect(hCmpLeerListas().listas).toHaveLength(1)
    })
})

describe("listas", () => {
    beforeEach(empezar)

    it("el desplegable tiene una opción por lista con su número de activos", () => {
        hCmpAnadir("AMD", "AMD")
        _hCmpListas.push({ id: "l2", nombre: "Semis", series: [] })
        hCmpPintarListas()

        const select = document.getElementById("hCmpListaSelect")
        expect([...select.options].map((o) => o.textContent)).toEqual(["Mi comparación (1)", "Semis (0)"])
        expect(select.value).toBe("l1")
    })

    it("con una sola lista, borrar está desactivado", () => {
        expect(document.getElementById("hCmpListaBorrarBtn").disabled).toBe(true)
    })

    it("crear deja la nueva activa, vacía y con el nombre abierto; la anterior conserva sus activos", () => {
        hCmpAnadir("AMD", "AMD")
        hCmpAnadir("NVDA", "NVDA")
        _hCmpDatos = null

        document.getElementById("hCmpListaNuevaBtn").click()

        expect(_hCmpListas.map((l) => l.nombre)).toEqual(["Mi comparación", "Lista 2"])
        expect(_hCmpLista).toEqual([])
        expect(_hCmpListas[0].series.map((s) => s.ticker)).toEqual(["AMD", "NVDA"])
        expect(guardadaActiva().nombre).toBe("Lista 2")
        expect(document.getElementById("hCmpListasFila").classList.contains("renombrando")).toBe(true)
        expect(document.getElementById("hCmpListaNombre").value).toBe("Lista 2")
    })

    it("elegir otra lista en el desplegable carga sus activos", () => {
        _hCmpListas.push({ id: "l2", nombre: "Semis", series: [{ ticker: "INTC", nombre: "INTC", color: "#fff" }] })
        hCmpPintarListas()

        const select = document.getElementById("hCmpListaSelect")
        select.value = "l2"
        select.dispatchEvent(new Event("change"))

        expect(_hCmpLista.map((s) => s.ticker)).toEqual(["INTC"])
        expect(_hCmpListaActiva).toBe("l2")
    })

    it("renombrar en el campo: Enter guarda y Escape deja el nombre", () => {
        const campo = document.getElementById("hCmpListaNombre")

        hCmpEditarNombre()
        campo.value = "Semis"
        campo.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }))
        expect(guardadaActiva().nombre).toBe("Semis")
        expect(document.getElementById("hCmpListasFila").classList.contains("renombrando")).toBe(false)

        hCmpEditarNombre()
        campo.value = "Otra"
        campo.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
        expect(guardadaActiva().nombre).toBe("Semis")
    })

    it("hCmpNombreLibre salta los nombres ya usados", () => {
        expect(hCmpNombreLibre([{ nombre: "A" }, { nombre: "lista 3" }])).toBe("Lista 4")
    })

    it("renombrar ignora un nombre vacío y recorta los espacios", () => {
        expect(hCmpRenombrarLista("l1", "   ")).toBe(false)
        expect(hCmpRenombrarLista("l1", "  Semis  ")).toBe(true)

        expect(guardadaActiva().nombre).toBe("Semis")
    })

    it("no borra la única lista y al borrar la activa pasa a la de al lado", () => {
        expect(hCmpBorrarLista("l1")).toBe(false)

        _hCmpListas.push({ id: "l2", nombre: "B", series: [] }, { id: "l3", nombre: "C", series: [] })
        hCmpActivarLista("l2")
        expect(hCmpBorrarLista("l2")).toBe(true)

        expect(_hCmpListas.map((l) => l.id)).toEqual(["l1", "l3"])
        expect(_hCmpListaActiva).toBe("l3")
    })
})
