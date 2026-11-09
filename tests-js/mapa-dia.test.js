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
