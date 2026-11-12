// Minigráfico del día de los mapas de calor.
//
// Lo que importa es que la línea se vaya completando: el eje es el día entero,
// así que a media mañana la línea tiene que acabar hacia la mitad izquierda, y
// no estirarse hasta el borde como si el día hubiera terminado.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { cargarScript } from "./cargar.js"

const INICIO = 1_000_000
const FIN = INICIO + 86400
const HUECO = 7200

function coordenadas(d) {
    return [...d.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])])
}

beforeAll(() => {
    window.escapeAttr = (s) => String(s)
    cargarScript("js/core/mapa-dia.js")
})

describe("mapaDiaTrazado", () => {
    it("coloca los puntos sobre el día entero y acaba en la hora del último", () => {
        const puntos = [
            [INICIO, 10],
            [INICIO + 21600, 12]
        ]
        const { linea } = mapaDiaTrazado(puntos, INICIO, FIN, HUECO)
        const [primero, ultimo] = coordenadas(linea)

        expect(primero[0]).toBe(0)
        expect(ultimo[0]).toBe(250)
        // El mínimo abajo y el máximo arriba, con margen para el trazo.
        expect(primero[1]).toBe(92)
        expect(ultimo[1]).toBe(8)
    })

    it("corta la línea donde faltan datos", () => {
        const puntos = [
            [INICIO, 10],
            [INICIO + 600, 11],
            [INICIO + 600 + HUECO + 1, 12],
            [INICIO + 1200 + HUECO + 1, 13]
        ]
        const { linea, area } = mapaDiaTrazado(puntos, INICIO, FIN, HUECO)

        expect(linea.match(/M/g)).toHaveLength(2)
        expect(area.match(/Z/g)).toHaveLength(2)
    })

    it("un día plano va por el centro", () => {
        const { linea } = mapaDiaTrazado(
            [
                [INICIO, 5],
                [INICIO + 600, 5]
            ],
            INICIO,
            FIN,
            HUECO
        )

        expect(coordenadas(linea).map((p) => p[1])).toEqual([50, 50])
    })

    it("un punto aislado tras un hueco no deja un relleno vacío", () => {
        const { area } = mapaDiaTrazado(
            [
                [INICIO, 1],
                [INICIO + 600, 2],
                [INICIO + 600 + HUECO + 1, 3]
            ],
            INICIO,
            FIN,
            HUECO
        )

        expect(area.match(/Z/g)).toHaveLength(1)
    })
})

describe("mapaDiaSvg", () => {
    it("sin dos puntos no pinta nada", () => {
        const datos = { inicio: INICIO, fin: FIN, segundosHueco: HUECO }

        expect(mapaDiaSvg(undefined, datos)).toBe("")
        expect(mapaDiaSvg([[INICIO, 1]], datos)).toBe("")
    })

    it("fuera de «Hoy» une los puntos separados por un hueco; en «Hoy» lo corta", () => {
        const datos = { inicio: INICIO, fin: FIN, segundosHueco: HUECO }
        const puntos = [
            [INICIO, 1],
            [INICIO + 10, 2],
            [INICIO + HUECO * 5, 3],
            [INICIO + HUECO * 5 + 10, 2]
        ]
        const trazos = (svg) => svg.match(/class="mapaDiaTrazo" d="([^"]*)"/)[1].match(/M/g).length

        expect(trazos(mapaDiaSvg(puntos, datos, { inicio: INICIO, fin: FIN }))).toBe(2)
        expect(trazos(mapaDiaSvg(puntos, datos, { inicio: INICIO, fin: FIN, dias: true }))).toBe(1)
    })
})

describe("mapaDiaPintarEn", () => {
    let lienzo

    function celda(id, ancho, alto) {
        const el = document.createElement("div")
        el.dataset.serieId = id
        Object.defineProperty(el, "offsetWidth", { value: ancho })
        Object.defineProperty(el, "offsetHeight", { value: alto })
        el.innerHTML = "<span>ID</span>"
        lienzo.appendChild(el)
        return el
    }

    beforeEach(() => {
        lienzo = document.createElement("div")
    })

    it("solo en las baldosas con sitio y con serie, y sin duplicar al repintar", () => {
        const datos = {
            inicio: INICIO,
            fin: FIN,
            segundosHueco: HUECO,
            series: {
                a: [
                    [INICIO, 1],
                    [INICIO + 3600, 2]
                ],
                b: [
                    [INICIO, 1],
                    [INICIO + 3600, 2]
                ],
                // Diez minutos de snapshots: el servidor acaba de arrancar.
                corta: [
                    [INICIO, 1],
                    [INICIO + 600, 2]
                ]
            }
        }
        const grande = celda("a", 120, 90)
        const pequena = celda("b", 30, 20)
        const sinSerie = celda("c", 120, 90)
        const corta = celda("corta", 120, 90)
        const vistos = []
        lienzo._mapaDiaAlPintar = (el, puntos) => vistos.push([el.dataset.serieId, puntos?.length ?? 0])

        mapaDiaPintarEn(lienzo, datos)
        mapaDiaPintarEn(lienzo, datos)

        expect(grande.querySelectorAll(".mapaDiaLinea")).toHaveLength(1)
        expect(pequena.querySelector(".mapaDiaLinea")).toBeNull()
        expect(sinSerie.querySelector(".mapaDiaLinea")).toBeNull()
        // Una serie de pocos minutos no se pinta ni da máximo y mínimo.
        expect(corta.querySelector(".mapaDiaLinea")).toBeNull()
        expect(vistos.slice(0, 4)).toEqual([
            ["a", 2],
            ["b", 2],
            ["c", 0],
            ["corta", 0]
        ])
    })
})

// Hora local de un día fijo, en segundos: el eje rotula horas locales.
function local(h, m = 0) {
    return new Date(2026, 10, 10, h, m).getTime() / 1000
}

/** Serie cada 30 min entre `desde` y `hasta` (horas) con el precio que dé `precio(h)`. */
function serie(desde, hasta, precio) {
    const puntos = []
    for (let h = desde; h <= hasta; h += 0.5) puntos.push([local(Math.floor(h), (h % 1) * 60), precio(h)])
    return puntos
}

describe("mapaDiaSesion", () => {
    const DIA = { inicio: local(0), fin: local(24) }
    // Bolsa de 9:00 a 17:30: plano de madrugada y por la tarde, se mueve entre medias.
    const enSesion = (h) => (h <= 9 ? 100 : h >= 17.5 ? 107 : 100 + (h - 9) * (h % 1 ? 0.6 : 1))

    const ABIERTO = { ...DIA, cerrado: false, plano: false }

    it("recorta el mercado cerrado a los dos lados y lo marca cerrado", () => {
        const ventana = mapaDiaSesion(serie(0, 23, enSesion), DIA.inicio, DIA.fin)

        expect(ventana).toEqual({ inicio: local(9), fin: local(17, 30), cerrado: true, plano: false })
    })

    it("con la sesión abierta, la ventana llega hasta el último punto", () => {
        const ventana = mapaDiaSesion(serie(0, 12, enSesion), DIA.inicio, DIA.fin)

        expect(ventana).toEqual({ inicio: local(9), fin: local(12), cerrado: false, plano: false })
    })

    it("si los datos empiezan con la sesión ya abierta, la ventana empieza en el primero", () => {
        const ventana = mapaDiaSesion(serie(15.5, 23, enSesion), DIA.inicio, DIA.fin)

        expect(ventana).toEqual({ inicio: local(15, 30), fin: local(17, 30), cerrado: true, plano: false })
    })

    it("un tramo plano de una hora en plena sesión no se toma por un cierre", () => {
        const puntos = serie(10, 16, (h) => (h >= 11 && h <= 12 ? 50 : 50 + h))

        expect(mapaDiaSesion(puntos, DIA.inicio, DIA.fin)).toEqual(ABIERTO)
    })

    it("lo que cotiza todo el día conserva el día entero", () => {
        const cripto = serie(0, 23, (h) => 100 + Math.sin(h))

        expect(mapaDiaSesion(cripto, DIA.inicio, DIA.fin)).toEqual(ABIERTO)
    })

    it("un tramo plano corto no se toma por el mercado cerrado", () => {
        const puntos = serie(8.5, 12, (h) => (h < 9 ? 100 : 100 + h))

        expect(mapaDiaSesion(puntos, DIA.inicio, DIA.fin)).toEqual(ABIERTO)
    })

    it("sin moverse en todo el día es mercado cerrado, sin recortar", () => {
        expect(mapaDiaSesion(serie(0, 23, () => 5), DIA.inicio, DIA.fin)).toEqual({ ...DIA, cerrado: true, plano: true })
        expect(mapaDiaSesion(undefined, DIA.inicio, DIA.fin)).toEqual(ABIERTO)
    })

    it("el tiempo con el servidor parado no cuenta como mercado cerrado", () => {
        // Mismo precio antes y después de 11 h sin snapshots; luego se mueve.
        const puntos = [
            [local(0, 19), 126.76],
            [local(0, 20), 126.76],
            [local(11, 30), 126.76],
            [local(11, 40), 126.9],
            [local(11, 50), 127.1]
        ]

        expect(mapaDiaSesion(puntos, DIA.inicio, DIA.fin, HUECO)).toEqual(ABIERTO)
    })

    it("plano poco rato tras arrancar el servidor todavía no es cerrado", () => {
        const puntos = [
            [local(11, 30), 5],
            [local(11, 40), 5],
            [local(12), 5]
        ]

        expect(mapaDiaSesion(puntos, DIA.inicio, DIA.fin, HUECO)).toEqual({ ...DIA, cerrado: false, plano: true })
    })
})

describe("mapaDiaMarcasEje", () => {
    it("el día entero da las marcas de siempre", () => {
        const marcas = mapaDiaMarcasEje(local(0), local(24))

        expect(marcas.map((m) => m.texto)).toEqual(["06:00", "12:00", "18:00"])
        expect(marcas.map((m) => Math.round(m.pos))).toEqual([25, 50, 75])
    })

    it("una sesión lleva horas en punto dentro de ella y lejos de los bordes", () => {
        const marcas = mapaDiaMarcasEje(local(9), local(17, 30))

        expect(marcas.map((m) => m.texto)).toEqual(["12:00", "15:00"])
        marcas.forEach((m) => expect(m.pos).toBeGreaterThan(8))
    })

    it("sin duración no hay marcas", () => {
        expect(mapaDiaMarcasEje(local(9), local(9))).toEqual([])
    })
})

describe("mapaDiaPintarEn con horario de mercado", () => {
    it("pasa al pintar solo los puntos de la sesión y su ventana", () => {
        const lienzo = document.createElement("div")
        const el = document.createElement("div")
        el.dataset.serieId = "accion"
        lienzo.appendChild(el)
        const puntos = serie(0, 23, (h) => (h <= 9 ? 100 : h >= 17.5 ? 107 : 100 + (h - 9)))
        let recibido
        lienzo._mapaDiaAlPintar = (_el, p, ventana) => (recibido = { p, ventana })

        mapaDiaPintarEn(lienzo, { inicio: local(0), fin: local(24), segundosHueco: HUECO, series: { accion: puntos } })

        expect(recibido.ventana).toMatchObject({ inicio: local(9), fin: local(17, 30), cerrado: true })
        expect(recibido.p[0][0]).toBe(local(9))
        expect(recibido.p[recibido.p.length - 1][0]).toBe(local(17, 30))
    })

    it("con el mercado cerrado todo el día no pinta línea ni pasa puntos", () => {
        const lienzo = document.createElement("div")
        const el = document.createElement("div")
        el.dataset.serieId = "cerrada"
        Object.defineProperty(el, "offsetWidth", { value: 200 })
        Object.defineProperty(el, "offsetHeight", { value: 150 })
        lienzo.appendChild(el)
        let recibido
        lienzo._mapaDiaAlPintar = (_el, p, ventana) => (recibido = { p, ventana })

        mapaDiaPintarEn(lienzo, {
            inicio: local(0),
            fin: local(24),
            segundosHueco: HUECO,
            series: { cerrada: serie(0, 12, () => 47.3) }
        })

        expect(recibido.p).toBeUndefined()
        expect(recibido.ventana.cerrado).toBe(true)
        expect(el.querySelector(".mapaDiaLinea")).toBeNull()
    })
})

describe("mapaDiaCargar", () => {
    it("dos mapas a la vez hacen una sola petición", async () => {
        const respuesta = { ok: true, inicio: INICIO, fin: FIN, series: {} }
        const fetchFalso = vi.fn().mockResolvedValue({ ok: true, json: async () => respuesta })
        vi.stubGlobal("fetch", fetchFalso)

        const [a, b] = await Promise.all([mapaDiaCargar(), mapaDiaCargar()])
        await mapaDiaCargar()

        expect(a).toBe(respuesta)
        expect(b).toBe(respuesta)
        expect(fetchFalso).toHaveBeenCalledTimes(1)
        vi.unstubAllGlobals()
    })
})

describe("mapaDiaCargar por periodo", () => {
    it("pide cada periodo con su parámetro y no mezcla las cachés", async () => {
        const semana = { ok: true, periodo: "semana", inicio: INICIO, fin: FIN, series: {} }
        const fetchFalso = vi.fn().mockResolvedValue({ ok: true, json: async () => semana })
        vi.stubGlobal("fetch", fetchFalso)

        const datos = await mapaDiaCargar("semana")
        await mapaDiaCargar("semana")

        expect(datos).toBe(semana)
        expect(fetchFalso).toHaveBeenCalledTimes(1)
        expect(fetchFalso.mock.calls[0][0]).toBe("/api/activos-serie-dia?periodo=semana")
        vi.unstubAllGlobals()
    })
})

describe("mapaDiaPintarEn fuera de «Hoy»", () => {
    it("pinta la serie entera, sin recortar sesión ni exigir cobertura", () => {
        const lienzo = document.createElement("div")
        const el = document.createElement("div")
        el.dataset.serieId = "accion"
        Object.defineProperty(el, "offsetWidth", { value: 160 })
        Object.defineProperty(el, "offsetHeight", { value: 100 })
        lienzo.appendChild(el)
        // Plana por la noche y con solo diez minutos de datos: en «Hoy» se recortaría o descartaría.
        const puntos = [
            [INICIO, 5],
            [INICIO + 300, 5],
            [INICIO + 600, 6]
        ]
        let recibido = null
        lienzo._mapaDiaAlPintar = (_c, p, ventana) => (recibido = { p, ventana })

        mapaDiaPintarEn(lienzo, {
            periodo: "semana",
            inicio: INICIO - 6 * 86400,
            fin: FIN,
            segundosHueco: 86400,
            series: { accion: puntos }
        })

        expect(recibido.p).toEqual(puntos)
        expect(recibido.ventana).toMatchObject({ inicio: INICIO - 6 * 86400, fin: FIN, cerrado: false, dias: true })
        expect(el.querySelector(".mapaDiaLinea")).not.toBeNull()
    })
})

describe("mapaDiaSesionVelas", () => {
    const DIA = { inicio: local(0), fin: local(24) }
    const velas = (desde, hasta) => serie(desde, hasta, (h) => 100 + h)

    it("la cripto, con velas desde medianoche y hasta ahora, conserva el día entero", () => {
        expect(mapaDiaSesionVelas(velas(0, 15), DIA.inicio, DIA.fin, local(15, 5))).toEqual({ ...DIA, cerrado: false, plano: false })
    })

    it("con la sesión abierta, el eje va de la primera vela a la última", () => {
        expect(mapaDiaSesionVelas(velas(15.5, 18), DIA.inicio, DIA.fin, local(18, 10))).toEqual({
            inicio: local(15, 30),
            fin: local(18),
            cerrado: false,
            plano: false
        })
    })

    it("sin velas desde hace rato, el mercado está cerrado", () => {
        expect(mapaDiaSesionVelas(velas(15.5, 22), DIA.inicio, DIA.fin, local(23, 50))).toMatchObject({
            inicio: local(15, 30),
            fin: local(22),
            cerrado: true
        })
    })

    it("sin ninguna vela hoy, cerrado todo el día", () => {
        expect(mapaDiaSesionVelas([], DIA.inicio, DIA.fin, local(12))).toEqual({ ...DIA, cerrado: true, plano: true })
    })
})

describe("mapaDiaPintarEn con velas de TradingView", () => {
    function lienzoCon(id, tv) {
        const lienzo = document.createElement("div")
        const el = document.createElement("div")
        el.dataset.serieId = id
        if (tv) el.dataset.tv = tv
        Object.defineProperty(el, "offsetWidth", { value: 200 })
        Object.defineProperty(el, "offsetHeight", { value: 150 })
        lienzo.appendChild(el)
        lienzo._mapaDiaAlPintar = (_el, p, ventana) => (lienzo.recibido = { p, ventana })
        return { lienzo, el }
    }

    it("usa las velas del ticker antes que los snapshots y recorta a la ventana", () => {
        const { lienzo, el } = lienzoCon("wl:custom_1", "TVC:UKOIL")
        const ayer = [local(0) - 600, 1]
        const deHoy = serie(0, 1, (h) => 90 + h)

        mapaDiaPintarEn(
            lienzo,
            { periodo: "semana", inicio: local(0), fin: local(24), series: { "wl:custom_1": serie(0, 5, () => 1) } },
            { "TVC:UKOIL": [ayer, ...deHoy] }
        )

        expect(lienzo.recibido.p).toEqual(deHoy)
        expect(lienzo.recibido.ventana.velas).toBe(true)
        expect(el.querySelector(".mapaDiaLinea")).not.toBeNull()
    })

    it("sin velas del ticker vuelve a los snapshots", () => {
        const { lienzo } = lienzoCon("accion", "XETR:NQSE")
        const snapshots = serie(0, 5, (h) => 10 + h)

        mapaDiaPintarEn(
            lienzo,
            { periodo: "semana", inicio: local(0), fin: local(24), series: { accion: snapshots } },
            { "OTRO:TICKER": serie(0, 5, () => 1) }
        )

        expect(lienzo.recibido.p).toEqual(snapshots)
        expect(lienzo.recibido.ventana.velas).toBeUndefined()
    })

    it("en «Hoy», sin velas de hoy, pasa el mercado como cerrado y no pinta línea", () => {
        const { lienzo, el } = lienzoCon("indice", "SP:SPX")

        mapaDiaPintarEn(
            lienzo,
            { periodo: "dia", inicio: local(0), fin: local(24), segundosHueco: HUECO, series: {} },
            { "SP:SPX": [[local(0) - 3600, 7500], [local(0) - 1800, 7510]] }
        )

        expect(lienzo.recibido.p).toBeUndefined()
        expect(lienzo.recibido.ventana).toMatchObject({ cerrado: true, plano: true })
        expect(el.querySelector(".mapaDiaLinea")).toBeNull()
    })
})

describe("mapaDiaCargarVelas", () => {
    it("pide los tickers que faltan, recuerda los que no tienen velas y no repite", async () => {
        const respuesta = { ok: true, periodo: "ytd", series: { "SP:SPX": [[1, 2], [3, 4]] } }
        const fetchFalso = vi.fn().mockResolvedValue({ ok: true, json: async () => respuesta })
        vi.stubGlobal("fetch", fetchFalso)

        const velas = await mapaDiaCargarVelas("ytd", ["SP:SPX", "FOO:NOPE", "SP:SPX"])
        const otraVez = await mapaDiaCargarVelas("ytd", ["SP:SPX", "FOO:NOPE"])

        expect(velas).toEqual({ "SP:SPX": [[1, 2], [3, 4]] })
        expect(otraVez).toEqual(velas)
        expect(fetchFalso).toHaveBeenCalledTimes(1)
        const url = new URL(fetchFalso.mock.calls[0][0], "http://x")
        expect(url.pathname).toBe("/api/market/series")
        expect(url.searchParams.get("symbols")).toBe("SP:SPX,FOO:NOPE")
        expect(url.searchParams.get("periodo")).toBe("ytd")
        vi.unstubAllGlobals()
    })

    it("si la petición falla devuelve vacío sin romper", async () => {
        vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("red")))
        const consola = vi.spyOn(console, "error").mockImplementation(() => {})

        expect(await mapaDiaCargarVelas("anyo", ["SP:SPX"])).toEqual({})
        consola.mockRestore()
        vi.unstubAllGlobals()
    })
})

describe("mapaDiaMarcasFecha", () => {
    it("tres fechas en medianoches, lejos de los bordes", () => {
        const fin = local(15)
        const inicio = fin - 30 * 86400
        const marcas = mapaDiaMarcasFecha(inicio, fin)

        expect(marcas).toHaveLength(3)
        marcas.forEach((m) => {
            expect(m.pos).toBeGreaterThan(8)
            expect(m.pos).toBeLessThan(92)
            expect(m.texto).toMatch(/^\d{1,2} \S+$/)
        })
    })

    it("sin duración no hay marcas", () => {
        expect(mapaDiaMarcasFecha(local(9), local(9))).toEqual([])
    })
})
