// Precarga de las vistas previas de TradingView (js/core/mapa-dia.js).
//
// Con la opción «Precargar» del mapa de Paneles se cargan en segundo plano los
// iframes de todos los activos, uno detrás de otro. Se comprueba que caben
// todos aunque pasen del tope normal, que no se duplican, que una precarga
// nueva cancela la anterior y que al quitarla el tope vuelve al de siempre. Va
// en un fichero aparte porque la reserva de iframes es estado del módulo.
import { beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    window.escapeAttr = (s) => String(s)
    // Sin requestIdleCallback la espera es un setTimeout corto; jsdom no carga
    // los iframes externos, así que se simula su `load` al crearlos.
    delete window.requestIdleCallback
    cargarScript("js/core/mapa-dia.js")
    new MutationObserver((cambios) =>
        cambios.forEach((c) =>
            c.addedNodes.forEach((n) => {
                if (n.tagName === "IFRAME") setTimeout(() => n.dispatchEvent(new Event("load")), 0)
            })
        )
    ).observe(document.body, { childList: true, subtree: true })
})

function marcos() {
    return [...document.querySelectorAll("#mapaDiaTv iframe")]
}

function simbolos(n, prefijo = "NYSE:P") {
    return Array.from({ length: n }, (_, i) => `${prefijo}${i}`)
}

describe("precarga de vistas previas", () => {
    it("carga todas aunque pasen del tope normal, sin repetir ni contar huecos", async () => {
        const lista = simbolos(MAPA_DIA_TV_MAX_MARCOS + 4)
        await mapaDiaPrecargarTv([...lista, lista[0], undefined, ""])

        expect(marcos()).toHaveLength(lista.length)
        lista.forEach((s) => expect(marcos().some((f) => f.src.includes(encodeURIComponent(s)))).toBe(true))
        // Ninguna se enseña: solo quedan cargadas.
        expect(marcos().filter((f) => f.classList.contains("mapaDiaTvActivo"))).toHaveLength(0)
    })

    it("repetirla con los mismos símbolos no crea iframes nuevos", async () => {
        const antes = marcos()
        await mapaDiaPrecargarTv(simbolos(MAPA_DIA_TV_MAX_MARCOS + 4))

        expect(marcos()).toEqual(antes)
    })

    it("una precarga nueva cancela la que estaba en curso", async () => {
        const primera = mapaDiaPrecargarTv(simbolos(20, "NYSE:A"))
        await mapaDiaPrecargarTv(simbolos(2, "NYSE:B"))
        await primera

        expect(marcos().filter((f) => f.src.includes("NYSE%3AA")).length).toBeLessThan(20)
    })

    it("sin símbolos vuelve al tope de siempre y deja las más recientes", async () => {
        await mapaDiaPrecargarTv([])

        expect(marcos()).toHaveLength(MAPA_DIA_TV_MAX_MARCOS)
        // Las dos de la última precarga son las más recientes: siguen ahí.
        expect(marcos().filter((f) => f.src.includes("NYSE%3AB"))).toHaveLength(2)
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

        // Solo llegó el aviso inicial: la nueva la canceló antes de cargar ninguna.
        expect(avisosPrimera).toEqual([0])
    })

    it("sin símbolos avisa de un total de cero", async () => {
        const avisos = []
        await mapaDiaPrecargarTv([], (hechos, total) => avisos.push([hechos, total]))

        expect(avisos).toEqual([[0, 0]])
    })
})
