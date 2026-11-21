// Equivalencias: lo que se puede comprobar sin red ni gráfico.
//
// Si la equivalencia o el eje común estuvieran mal, la tabla diría que 10 EUR
// son una cantidad de bitcoin que no es, o el tooltip mezclaría precios de
// instantes distintos.
import { beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/analisis/herramientas-divisas.js")
    cargarScript("js/analisis/herramientas-equivalencias.js")
})

describe("hEqCantidades", () => {
    const precios = new Map([
        ["EUR", 1],
        ["USD", 0.9],
        ["BITSTAMP:BTCUSD", 50000]
    ])

    it("reparte el valor del ancla entre todos los de la lista", () => {
        const cantidades = hEqCantidades(precios, { id: "EUR", cantidad: 10 })

        expect(cantidades.get("EUR")).toBe(10)
        expect(cantidades.get("USD")).toBeCloseTo(11.1111, 4)
        expect(cantidades.get("BITSTAMP:BTCUSD")).toBeCloseTo(0.0002, 10)
    })

    it("funciona igual con cualquier fila como ancla", () => {
        const cantidades = hEqCantidades(precios, { id: "BITSTAMP:BTCUSD", cantidad: 1 })

        expect(cantidades.get("EUR")).toBe(50000)
        expect(cantidades.get("USD")).toBeCloseTo(55555.56, 2)
    })

    it("sin precio del ancla no inventa equivalencias, pero conserva lo escrito", () => {
        const cantidades = hEqCantidades(precios, { id: "NASDAQ:NADA", cantidad: 3 })

        expect(cantidades.get("NASDAQ:NADA")).toBe(3)
        expect(cantidades.get("EUR")).toBeNull()
    })

    it("sin ancla todo queda vacío", () => {
        expect([...hEqCantidades(precios, null).values()]).toEqual([null, null, null])
    })
})

describe("hEqAlinear", () => {
    it("pone todas las series en los mismos instantes con el último valor conocido", () => {
        const cripto = [
            { ts: 1, close: 10 },
            { ts: 2, close: 11 },
            { ts: 3, close: 12 }
        ]
        // La acción no cotiza en el instante 2 (fin de semana).
        const accion = [
            { ts: 1, close: 100 },
            { ts: 3, close: 103 }
        ]

        const { tiempos, valores } = hEqAlinear([cripto, accion])

        expect(tiempos).toEqual([1, 2, 3])
        expect(valores[0]).toEqual([10, 11, 12])
        expect(valores[1]).toEqual([100, 100, 103])
    })

    it("antes del primer punto de una serie no hay valor", () => {
        const { valores } = hEqAlinear([
            [
                { ts: 1, close: 1 },
                { ts: 2, close: 2 }
            ],
            [{ ts: 2, close: 5 }]
        ])

        expect(valores[1]).toEqual([null, 5])
    })
})

describe("hEqRendimiento", () => {
    it("mide cada punto contra el primero con valor", () => {
        const rendimiento = hEqRendimiento([null, 100, 110, 90])

        expect(rendimiento[0]).toBeNull()
        expect(rendimiento[1]).toBe(0)
        expect(rendimiento[2]).toBeCloseTo(10, 10)
        expect(rendimiento[3]).toBeCloseTo(-10, 10)
    })
})

describe("variaciones", () => {
    const elemento = {
        puntos: [
            { ts: 1, close: 80 },
            { ts: 2, close: 100 }
        ],
        actual: { ts: 2, close: 100 },
        referencias: [{ rango: "1D", ts: 1, close: 125 }]
    }

    it("la del rango va del primer punto al último", () => {
        expect(hEqVariacionRango(elemento)).toBeCloseTo(25, 10)
    })

    it("la de un periodo sale de su referencia, y si no hay, null", () => {
        expect(hEqVariacionPeriodo(elemento, "1D")).toBeCloseTo(-20, 10)
        expect(hEqVariacionPeriodo(elemento, "1A")).toBeNull()
    })
})

describe("hEqItemDeActivo", () => {
    const resolver = (activo) => activo.tvSymbol

    it("usa el ticker que da el resolvedor, en mayúsculas, y el nombre del activo", () => {
        expect(hEqItemDeActivo({ name: "Apple", tvSymbol: "nasdaq:aapl" }, resolver)).toEqual({
            tipo: "activo",
            id: "NASDAQ:AAPL",
            nombre: "Apple"
        })
    })

    it("acepta tickers sin bolsa y con caracteres de futuros o clases", () => {
        expect(hEqItemDeActivo({ name: "Oro", tvSymbol: "COMEX:GC1!" }, resolver).id).toBe("COMEX:GC1!")
        expect(hEqItemDeActivo({ name: "Berkshire", tvSymbol: "NYSE:BRK.B" }, resolver).id).toBe("NYSE:BRK.B")
        expect(hEqItemDeActivo({ name: "BTC", tvSymbol: "BTCUSD" }, resolver).id).toBe("BTCUSD")
    })

    it("descarta los activos sin ticker o con uno que el servidor rechazaría", () => {
        expect(hEqItemDeActivo({ name: "Piso" }, resolver)).toBeNull()
        expect(hEqItemDeActivo({ name: "Raro", tvSymbol: "MI FONDO" }, resolver)).toBeNull()
    })

    it("no toma el nombre por ticker cuando el activo no tiene ningún símbolo", () => {
        const porNombre = (activo) => String(activo.symbol || activo.name).toUpperCase()

        expect(hEqItemDeActivo({ name: "Piso" }, porNombre)).toBeNull()
        expect(hEqItemDeActivo({ name: "Apple", symbol: "AAPL" }, porNombre).id).toBe("AAPL")
    })

    it("si el resolvedor falla, el activo se descarta sin romper la lista", () => {
        const roto = () => {
            throw new Error("sin datos")
        }
        expect(hEqItemDeActivo({ name: "X" }, roto)).toBeNull()
    })
})

describe("hEqNormalizarGuardado", () => {
    const USD = { tipo: "divisa", id: "USD", nombre: "Dólar" }
    const BTC = { tipo: "activo", id: "BITSTAMP:BTCUSD", nombre: "Bitcoin" }

    it("la primera vez crea «Mi lista» con la moneda base", () => {
        const estado = hEqNormalizarGuardado(null, "EUR")

        expect(estado.listas).toHaveLength(1)
        expect(estado.listas[0].nombre).toBe("Mi lista")
        expect(estado.listas[0].items.map((i) => i.id)).toEqual(["EUR"])
        expect(estado.activa).toBe(estado.listas[0].id)
        expect(estado.rango).toBe("1M")
    })

    it("convierte la lista única del formato anterior sin perder nada", () => {
        const antiguo = {
            items: [USD, BTC],
            ancla: { id: "BITSTAMP:BTCUSD", cantidad: 2 },
            seleccion: "USD",
            rango: "6M"
        }

        const estado = hEqNormalizarGuardado(antiguo, "EUR")

        expect(estado.listas).toHaveLength(1)
        expect(estado.listas[0]).toMatchObject({
            nombre: "Mi lista",
            ancla: { id: "BITSTAMP:BTCUSD", cantidad: 2 },
            seleccion: "USD"
        })
        expect(estado.listas[0].items).toEqual([USD, BTC])
        expect(estado.rango).toBe("6M")
    })

    it("conserva varias listas y cuál estaba abierta", () => {
        const estado = hEqNormalizarGuardado(
            {
                listas: [
                    { id: "a", nombre: "Cripto", items: [BTC] },
                    { id: "b", nombre: "Divisas", items: [USD] }
                ],
                activa: "b",
                rango: "5A"
            },
            "EUR"
        )

        expect(estado.listas.map((l) => l.nombre)).toEqual(["Cripto", "Divisas"])
        expect(estado.activa).toBe("b")
        expect(estado.rango).toBe("5A")
    })

    it("una lista vacía se queda vacía, sin inventarle elementos", () => {
        const lista = hEqNormalizarGuardado({ listas: [{ id: "a", nombre: "Nueva", items: [] }] }, "EUR").listas[0]

        expect(lista.items).toEqual([])
        expect(lista.ancla).toBeNull()
        expect(lista.seleccion).toBeNull()
    })

    it("descarta lo que no vale: elementos raros, ancla de otro, activa y rango inexistentes", () => {
        const estado = hEqNormalizarGuardado(
            {
                listas: [
                    {
                        id: "a",
                        nombre: "  ",
                        items: [USD, { tipo: "otro", id: "X" }, null],
                        ancla: { id: "NO", cantidad: 5 }
                    }
                ],
                activa: "zz",
                rango: "9X"
            },
            "EUR"
        )

        const lista = estado.listas[0]
        expect(lista.nombre).toBe("Lista 1")
        expect(lista.items).toEqual([USD])
        expect(lista.ancla).toEqual({ id: "USD", cantidad: 100 })
        expect(estado.activa).toBe("a")
        expect(estado.rango).toBe("1M")
    })

    it("dos listas con el mismo id dejan de compartirlo", () => {
        const { listas } = hEqNormalizarGuardado(
            {
                listas: [
                    { id: "a", nombre: "Uno" },
                    { id: "a", nombre: "Dos" }
                ]
            },
            "EUR"
        )

        expect(new Set(listas.map((l) => l.id)).size).toBe(2)
    })
})

describe("hEqNombreLibre", () => {
    it("propone el siguiente número que no esté usado", () => {
        expect(hEqNombreLibre([{ nombre: "Mi lista" }])).toBe("Lista 2")
        expect(hEqNombreLibre([{ nombre: "Lista 2" }, { nombre: "Cripto" }])).toBe("Lista 3")
        expect(hEqNombreLibre([{ nombre: "Lista 2" }])).toBe("Lista 3")
    })
})

describe("cantidades escritas y mostradas", () => {
    it("lee coma decimal y separador de miles", () => {
        expect(hEqLeerCantidad("10,5")).toBe(10.5)
        expect(hEqLeerCantidad("10.971,25")).toBe(10971.25)
        expect(hEqLeerCantidad("")).toBeNull()
    })

    it("muestra las cifras que importan, sea cual sea el tamaño", () => {
        expect(hEqFormatoCantidad(0.000190123)).toBe("0,000190123")
        expect(hEqFormatoCantidad(10.97125)).toBe("10,9713")
        expect(hEqFormatoCantidad(1234567.891)).toBe("1.234.567,89")
        expect(hEqFormatoCantidad(null)).toBe("")
    })
})
