// Tolerancia a fallos del frontend: el refresco y el snapshot automáticos no
// deben dejar rechazos sin capturar ni solaparse, y los botones de Seguimiento
// de wallets tienen que volver a su estado si algo falla a mitad.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { cargarModulo, cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/app-core.js")
    cargarScript("js/cripto/wallets.js")
    cargarModulo("js/cripto/wallets-seguimiento.js")
})

afterEach(() => {
    applyAutoRefresh(0)
    applySnapshotSchedule(0)
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe("refresco automático", () => {
    it("un fallo se captura y la siguiente vuelta sigue funcionando", async () => {
        vi.useFakeTimers()
        vi.spyOn(console, "error").mockImplementation(() => {})
        const llamadas = vi.fn().mockRejectedValue(new Error("red caída"))
        globalThis.refreshAssetsSidebar = llamadas

        applyAutoRefresh(1)
        await vi.advanceTimersByTimeAsync(60_000 * 3)

        expect(llamadas.mock.calls.length).toBeGreaterThanOrEqual(2)
    })

    it("una vuelta lenta no se solapa con la siguiente", async () => {
        vi.useFakeTimers()
        const llamadas = vi.fn(() => new Promise(() => {}))
        globalThis.refreshAssetsSidebar = llamadas

        applyAutoRefresh(1)
        await vi.advanceTimersByTimeAsync(60_000 * 4)

        expect(llamadas).toHaveBeenCalledTimes(1)
    })
})

describe("Seguimiento de wallets", () => {
    function montar() {
        const boton = document.createElement("button")
        boton.textContent = "Actualizar"
        document.body.appendChild(boton)
        globalThis.walletsSegGrupo = () => ({ clave: "g", nombre: "G", wallets: [{ id: "w1" }], propia: true })
        globalThis.walletsSegActualizarLista = async () => []
        globalThis.walletsSegReabrirDetalleSi = () => {}
        globalThis.showToast = vi.fn()
        return boton
    }

    it("si falla la recarga, el botón de actualizar vuelve a su estado", async () => {
        const boton = montar()
        globalThis.cargarWalletsSeguimiento = async () => {
            throw new Error("render roto")
        }

        await actualizarSeguimiento("g", boton)

        expect(boton.disabled).toBe(false)
        expect(boton.textContent).toBe("Actualizar")
        expect(globalThis.showToast).toHaveBeenCalled()
    })

    it("si falla la recarga, sincronizar cierra el progreso y reactiva el botón", async () => {
        const boton = montar()
        boton.textContent = "Sincronizar"
        globalThis.walletsPost = async () => ({ anadidas: 0 })
        globalThis.cargarWalletsSeguimiento = async () => {
            throw new Error("render roto")
        }
        const terminar = vi.fn()
        globalThis.iniciarProgreso = () => ({ paso: () => {}, terminar })

        await sincronizarSeguimiento("g", boton)

        expect(terminar).toHaveBeenCalled()
        expect(boton.disabled).toBe(false)
        expect(boton.textContent).toBe("Sincronizar")
    })

    it("si falla la recarga, actualizar todas reactiva su botón", async () => {
        montar()
        const boton = document.createElement("button")
        boton.id = "walletsSegActualizarBtn"
        document.body.appendChild(boton)
        globalThis.walletsEstado = { wallets: [] }
        globalThis.cargarWalletsSeguimiento = async () => {
            throw new Error("render roto")
        }

        await actualizarTodasSeguimiento()

        expect(boton.disabled).toBe(false)
    })
})
