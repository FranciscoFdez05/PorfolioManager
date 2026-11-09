// Etiquetas de una cuenta: se marcan todas las que encajen y la principal (el
// tipo que necesita la base de datos) sale sola, sin cambiar si no hace falta.
import { beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/finanzas/cuentas.js")
})

describe("cntRepartirEtiquetas", () => {
    it("conserva el tipo que ya tenía la cuenta si sigue marcado", () => {
        expect(cntRepartirEtiquetas(["banco", "exchange", "broker"], "broker")).toEqual({
            tipo: "broker",
            etiquetas: ["banco", "exchange"]
        })
    })

    it("si el tipo de antes se ha desmarcado, la principal es la primera marcada", () => {
        expect(cntRepartirEtiquetas(["exchange", "broker"], "banco")).toEqual({
            tipo: "exchange",
            etiquetas: ["broker"]
        })
    })

    it("una cuenta nueva toma la primera marcada", () => {
        expect(cntRepartirEtiquetas(["ahorro"])).toEqual({ tipo: "ahorro", etiquetas: [] })
    })

    it("sin ninguna marcada no hay reparto posible", () => {
        expect(cntRepartirEtiquetas([], "banco")).toBeNull()
    })
})
