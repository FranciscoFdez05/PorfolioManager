// Ajustes > Módulos: qué página se abre al arrancar.
//
// La preferencia llega del servidor y puede no corresponder ya al estado de los
// módulos (copia restaurada, módulo apagado en otra versión). Un fallo aquí no se
// ve como un error, sino como una aplicación que arranca en blanco.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

const MENU = `
    <div class="navButtons">
        <button class="navBtn" data-page="vistaGeneral" data-module="vistaGeneral">Vista general</button>
        <div class="navDropdown" data-module="cripto">
            <button class="navBtn navDropdownItem" data-page="stablecoins">Stablecoins</button>
            <button class="navBtn navDropdownItem" data-page="operaciones">Operaciones</button>
        </div>
        <button class="navBtn" data-page="metricas" data-module="metricas">Métricas</button>
        <button class="navBtn" data-page="ajustes">Ajustes</button>
    </div>`

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/app-core.js")
})

beforeEach(() => {
    document.body.innerHTML = MENU
    window._modulosConfig = {}
    window._moduloPrincipal = ""
})

describe("menú real de index.html", () => {
    // Una página del menú que falte en _MODULE_PAGES no se apaga con su módulo y
    // sigue contando como visible, aunque ya no se pueda llegar a ella.
    it("cada página pertenece en _MODULE_PAGES al módulo que la contiene", () => {
        const html = readFileSync(resolve(process.cwd(), "index.html"), "utf-8")
        const indice = new DOMParser().parseFromString(html, "text/html")
        const botones = [...indice.querySelectorAll(".navButtons [data-page]")]
        const conModulo = botones.filter((boton) => boton.dataset.page !== "ajustes")

        expect(conModulo.length).toBeGreaterThan(0)
        for (const boton of conModulo) {
            const contenedor = boton.closest("[data-module]")?.dataset.module
            expect([boton.dataset.page, moduloDePagina(boton.dataset.page)]).toEqual([boton.dataset.page, contenedor])
        }
    })
})

describe("paginaDeInicio", () => {
    it("sin elección abre la primera página del menú", () => {
        expect(paginaDeInicio()).toBe("vistaGeneral")
        expect(moduloPrincipalEfectivo()).toBe("vistaGeneral")
    })

    it("abre la primera página, en el orden del menú, del módulo elegido", () => {
        window._moduloPrincipal = "cripto"
        expect(paginaDeInicio()).toBe("stablecoins")
    })

    it("si el módulo elegido está apagado cae al primero visible", () => {
        window._moduloPrincipal = "cripto"
        window._modulosConfig = { cripto: false, vistaGeneral: false }
        expect(moduloPrincipalEfectivo()).toBe("metricas")
        expect(paginaDeInicio()).toBe("metricas")
    })

    it.each(["moduloFantasma", "panelSuperior"])("ignora el valor no válido %s", (valor) => {
        window._moduloPrincipal = valor
        expect(paginaDeInicio()).toBe("vistaGeneral")
    })

    it("sin ningún módulo encendido no propone página", () => {
        window._modulosConfig = { vistaGeneral: false, cripto: false, metricas: false }
        expect(moduloPrincipalEfectivo()).toBeNull()
        expect(paginaDeInicio()).toBeNull()
    })
})
