// Precarga de las vistas previas de velas (js/core/mapa-dia.js).
//
// Con la opción «Precargar» del mapa de Paneles se piden en segundo plano las
// velas de todos los activos, una detrás de otra. Se comprueba que no se piden
// repetidas ni las que ya están en caché, que una precarga nueva cancela la
// anterior y que el progreso solo lo avisa la vigente. Va en un fichero aparte
// porque la caché de velas es estado del módulo.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { cargarScript } from "./cargar.js"

let pedidos = []

beforeAll(() => {
    window.escapeAttr = (s) => String(s)
    cargarScript("js/core/i18n.js")
    cargarScript("js/core/mapa-dia.js")
})

beforeEach(() => {
    pedidos = []
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url) => {
            const simbolo = new URL(url, "http://x").searchParams.get("symbol")
            pedidos.push(simbolo)
            return {
                ok: true,
                json: async () => ({ ok: true, simbolo, divisa: "EUR", velas: [[1, 1, 2, 1, 2], [2, 2, 3, 2, 3]] })
            }
        })
    )
})

function simbolos(n, prefijo = "NYSE:P") {
    return Array.from({ length: n }, (_, i) => `${prefijo}${i}`)
}

describe("precarga de vistas previas", () => {
    it("pide las velas de todos, sin repetir ni contar huecos", async () => {
        const lista = simbolos(10)
        await mapaDiaPrecargarTv([...lista, lista[0], undefined, ""])

        expect(pedidos).toEqual(lista)
    })

    it("repetirla con los mismos símbolos no vuelve a pedirlos mientras sigan en caché", async () => {
        await mapaDiaPrecargarTv(simbolos(10))

        expect(pedidos).toEqual([])
    })

    it("una precarga nueva cancela la que estaba en curso", async () => {
        const primera = mapaDiaPrecargarTv(simbolos(20, "NYSE:A"))
        await mapaDiaPrecargarTv(simbolos(2, "NYSE:B"))
        await primera

        expect(pedidos.filter((s) => s.startsWith("NYSE:A")).length).toBeLessThan(20)
    })

    it("avisa del progreso de cero al total, sin contar repetidos ni huecos", async () => {
        const avisos = []
        await mapaDiaPrecargarTv(["NYSE:C0", "NYSE:C1", "NYSE:C0", "", "NYSE:C2"], (hechos, total) =>
            avisos.push([hechos, total])
        )

        expect(avisos).toEqual([
            [0, 3],
            [1, 3],
            [2, 3],
            [3, 3]
        ])
    })

    it("una precarga cancelada deja de avisar", async () => {
        const avisosPrimera = []
        const primera = mapaDiaPrecargarTv(simbolos(10, "NYSE:D"), (hechos) => avisosPrimera.push(hechos))
        await mapaDiaPrecargarTv(simbolos(1, "NYSE:E"))
        await primera

        // Solo llegó el aviso inicial: la nueva la canceló antes de acabar ninguna.
        expect(avisosPrimera).toEqual([0])
    })

    it("sin símbolos avisa de un total de cero", async () => {
        const avisos = []
        await mapaDiaPrecargarTv([], (hechos, total) => avisos.push([hechos, total]))

        expect(avisos).toEqual([[0, 0]])
    })
})
