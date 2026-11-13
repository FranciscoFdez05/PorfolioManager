// Pruebas de los desplegables personalizados y del arrastre horizontal
// (js/core/shared-utils.js).
//
// Lo que se vigila es que no se acumulen listeners: cada select añadía los
// suyos a document y nunca los quitaba, y cada visita a una página dejaba
// handlers que retenían el DOM ya descartado.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
})

afterEach(() => {
    document.body.innerHTML = ""
})

function crearSelect(opciones = ["a", "b", "c"]) {
    const select = document.createElement("select")
    opciones.forEach((valor) => {
        const opt = document.createElement("option")
        opt.value = valor
        opt.textContent = valor
        select.appendChild(opt)
    })
    const contenedor = document.createElement("div")
    contenedor.appendChild(select)
    document.body.appendChild(contenedor)
    window._buildCustomSelect(select)
    return select
}

const menuDe = (select) =>
    [...document.querySelectorAll(".csBodyMenu")].find(
        (m) => m._csTrigger === select.parentNode.querySelector(".csTrigger")
    )
const abrir = (select) => select.parentNode.querySelector(".csTrigger").click()

describe("selects personalizados", () => {
    it("registran un solo par de listeners en document por muchos selects que haya", () => {
        const espia = vi.spyOn(document, "addEventListener")
        for (let i = 0; i < 25; i++) crearSelect()
        const clicks = espia.mock.calls.filter(([tipo]) => tipo === "click")
        const scrolls = espia.mock.calls.filter(([tipo]) => tipo === "scroll")
        // El global se registra como mucho una vez en toda la vida del modulo.
        expect(clicks.length).toBeLessThanOrEqual(1)
        expect(scrolls.length).toBeLessThanOrEqual(1)
        espia.mockRestore()
    })

    it("no añaden listeners a document en los selects siguientes", () => {
        crearSelect()
        const espia = vi.spyOn(document, "addEventListener")
        crearSelect()
        crearSelect()
        expect(espia).not.toHaveBeenCalled()
        espia.mockRestore()
    })

    it("abre el menu al pulsar el trigger y lo cierra con un clic fuera", () => {
        const select = crearSelect()
        const menu = menuDe(select)
        abrir(select)
        expect(menu.classList.contains("csOpen")).toBe(true)
        expect(menu.style.display).toBe("flex")
        document.body.click()
        expect(menu.classList.contains("csOpen")).toBe(false)
        expect(menu.style.display).toBe("none")
    })

    it("cierra el menu abierto al hacer scroll fuera de el pero no dentro", () => {
        const select = crearSelect()
        const menu = menuDe(select)
        abrir(select)
        menu.firstElementChild.dispatchEvent(new Event("scroll"))
        expect(menu.classList.contains("csOpen")).toBe(true)
        document.body.dispatchEvent(new Event("scroll"))
        expect(menu.classList.contains("csOpen")).toBe(false)
    })

    it("elige una opcion con mousedown, actualiza el valor y cierra", () => {
        const select = crearSelect()
        const menu = menuDe(select)
        abrir(select)
        menu.children[2].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
        expect(select.value).toBe("c")
        expect(menu.classList.contains("csOpen")).toBe(false)
        expect(select.parentNode.querySelector(".csLabel").textContent).toBe("c")
    })

    it("un clic fuera no toca un menu que no es de select (combo con csOpen fijo)", () => {
        const combo = document.createElement("div")
        combo.className = "csMenu csBodyMenu csOpen pmComboMenu"
        document.body.appendChild(combo)
        crearSelect()
        document.body.click()
        expect(combo.classList.contains("csOpen")).toBe(true)
    })

    it("retira el menu huerfano cuando su select ya no esta en la pagina", () => {
        const primero = crearSelect()
        const menuPrimero = menuDe(primero)
        expect(menuPrimero.isConnected).toBe(true)
        primero.parentNode.parentNode.remove()
        crearSelect()
        expect(menuPrimero.isConnected).toBe(false)
    })

    it("vuelve a colgar el menu en body si se retiro y el select sigue vivo", () => {
        const select = crearSelect()
        const menu = menuDe(select)
        const contenedor = select.parentNode.parentNode
        contenedor.remove()
        crearSelect()
        expect(menu.isConnected).toBe(false)
        document.body.appendChild(contenedor)
        abrir(select)
        expect(menu.isConnected).toBe(true)
        expect(menu.classList.contains("csOpen")).toBe(true)
    })

    it("no construye dos veces el mismo select", () => {
        const select = crearSelect()
        window._buildCustomSelect(select)
        expect(document.querySelectorAll(".csTrigger").length).toBe(1)
        expect(document.querySelectorAll(".csBodyMenu").length).toBe(1)
    })
})

describe("activarArrastreHorizontal", () => {
    function montar() {
        const contenedor = document.createElement("div")
        document.body.appendChild(contenedor)
        window.activarArrastreHorizontal(contenedor)
        return contenedor
    }
    const evento = (tipo, x) => {
        const e = new Event(tipo, { bubbles: true })
        e.clientX = x
        e.button = 0
        return e
    }

    it("no deja listeners en window hasta que empieza un arrastre", () => {
        const espia = vi.spyOn(window, "addEventListener")
        montar()
        montar()
        expect(espia.mock.calls.filter(([tipo]) => tipo === "pointermove" || tipo === "pointerup")).toHaveLength(0)
        espia.mockRestore()
    })

    it("pone los listeners al pulsar y los quita al soltar", () => {
        const contenedor = montar()
        const alta = vi.spyOn(window, "addEventListener")
        const baja = vi.spyOn(window, "removeEventListener")
        contenedor.dispatchEvent(evento("pointerdown", 100))
        expect(alta.mock.calls.map(([tipo]) => tipo).sort()).toEqual(["pointermove", "pointerup"])
        window.dispatchEvent(evento("pointerup", 100))
        expect(baja.mock.calls.map(([tipo]) => tipo).sort()).toEqual(["pointermove", "pointerup"])
        alta.mockRestore()
        baja.mockRestore()
    })

    it("desplaza el contenedor al arrastrar mas de 5px y ignora movimientos menores", () => {
        const contenedor = montar()
        contenedor.scrollLeft = 50
        contenedor.dispatchEvent(evento("pointerdown", 100))
        window.dispatchEvent(evento("pointermove", 103))
        expect(contenedor.scrollLeft).toBe(50)
        expect(contenedor.classList.contains("dragging")).toBe(false)
        window.dispatchEvent(evento("pointermove", 80))
        expect(contenedor.scrollLeft).toBe(70)
        expect(contenedor.classList.contains("dragging")).toBe(true)
        window.dispatchEvent(evento("pointerup", 80))
        expect(contenedor.classList.contains("dragging")).toBe(false)
    })

    it("tras soltar, mover el puntero ya no desplaza nada", () => {
        const contenedor = montar()
        contenedor.scrollLeft = 10
        contenedor.dispatchEvent(evento("pointerdown", 100))
        window.dispatchEvent(evento("pointerup", 100))
        window.dispatchEvent(evento("pointermove", 20))
        expect(contenedor.scrollLeft).toBe(10)
    })
})
