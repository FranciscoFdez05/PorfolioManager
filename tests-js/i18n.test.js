// Pruebas de js/core/i18n.js y de los diccionarios de js/locales/.
//
// Además del comportamiento de t() y aplicarI18n(), aquí se vigilan las dos
// formas en que la traducción se estropea sin que nada falle a la vista:
//   1. Un diccionario se queda sin una clave que el otro sí tiene (el inglés se
//      queda atrás y esos textos salen en español).
//   2. El texto en español escrito en index.html deja de coincidir con el del
//      diccionario, y la interfaz en español cambia al aplicar la traducción.
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { cargarScript } from "./cargar.js"

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const atributos = ["title", "placeholder", "aria-label", "alt"]

beforeAll(() => {
    cargarScript("js/locales/es.js")
    cargarScript("js/locales/en.js")
    cargarScript("js/core/i18n.js")
})

beforeEach(() => {
    establecerIdioma("es")
})

afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    document.body.innerHTML = ""
})

/** Rutas "a.b.c" de todas las hojas de un diccionario anidado. */
function clavesDe(diccionario, prefijo = "") {
    return Object.entries(diccionario).flatMap(([clave, valor]) => {
        const ruta = prefijo ? `${prefijo}.${clave}` : clave
        const esPlural = valor && typeof valor === "object" && "other" in valor
        return valor && typeof valor === "object" && !esPlural ? clavesDe(valor, ruta) : [ruta]
    })
}

function scriptsDeLaAplicacion(directorio = join(raiz, "js"), encontrados = []) {
    for (const entrada of readdirSync(directorio)) {
        const ruta = join(directorio, entrada)
        if (statSync(ruta).isDirectory()) {
            if (entrada !== "vendor") scriptsDeLaAplicacion(ruta, encontrados)
        } else if (entrada.endsWith(".js")) {
            encontrados.push(ruta)
        }
    }
    return encontrados
}

describe("t()", () => {
    it("devuelve el texto del idioma activo", () => {
        expect(t("comun.guardado")).toBe("Guardado")
        establecerIdioma("en")
        expect(t("comun.guardado")).toBe("Saved")
    })

    it("cae al español si la clave falta en el idioma activo", () => {
        window.i18nDiccionarios.es.prueba = { soloEs: "Solo en español" }
        establecerIdioma("en")

        expect(t("prueba.soloEs")).toBe("Solo en español")
        delete window.i18nDiccionarios.es.prueba
    })

    it("devuelve la clave y avisa si no existe en ningún idioma", () => {
        const aviso = vi.spyOn(console, "warn").mockImplementation(() => {})

        expect(t("no.existe")).toBe("no.existe")
        expect(aviso).toHaveBeenCalledOnce()
    })

    it("sustituye los marcadores y deja a la vista los que no tienen valor", () => {
        window.i18nDiccionarios.es.prueba = { saludo: "Hola {nombre}, tienes {n} avisos de {quien}" }

        expect(t("prueba.saludo", { nombre: "Ana", n: 0 })).toBe("Hola Ana, tienes 0 avisos de {quien}")
        delete window.i18nDiccionarios.es.prueba
    })

    it("elige la forma plural con count según el idioma", () => {
        window.i18nDiccionarios.es.prueba = { meses: { one: "{count} mes", other: "{count} meses" } }
        window.i18nDiccionarios.en.prueba = { meses: { one: "{count} month", other: "{count} months" } }

        expect(t("prueba.meses", { count: 1 })).toBe("1 mes")
        expect(t("prueba.meses", { count: 0 })).toBe("0 meses")
        establecerIdioma("en")
        expect(t("prueba.meses", { count: 1 })).toBe("1 month")
        expect(t("prueba.meses", { count: 3 })).toBe("3 months")
        delete window.i18nDiccionarios.es.prueba
        delete window.i18nDiccionarios.en.prueba
    })
})

describe("idioma activo", () => {
    it("ignora un idioma sin diccionario", () => {
        expect(establecerIdioma("fr")).toBe(false)
        expect(idiomaActual()).toBe("es")
    })

    it("al cambiar lo recuerda y marca <html lang>", () => {
        expect(establecerIdioma("en")).toBe(true)

        expect(localStorage.getItem("portfolioIdioma")).toBe("en")
        expect(document.documentElement.lang).toBe("en")
        expect(establecerIdioma("en")).toBe(false)
    })

    it("uiLocale da el locale de fechas de cada idioma", () => {
        expect(uiLocale()).toBe("es-ES")
        establecerIdioma("en")
        expect(uiLocale()).toBe("en-GB")
    })
})

describe("aplicarI18n()", () => {
    it("traduce texto y atributos sin interpretar HTML", () => {
        window.i18nDiccionarios.en.prueba = { html: "<b>negrita</b>" }
        document.body.innerHTML = `
            <span id="a" data-i18n="comun.guardado">Guardado</span>
            <input id="b" data-i18n-placeholder="comun.error" placeholder="Error">
            <button id="c" data-i18n-aria-label="menu.ajustes" aria-label="Ajustes"></button>
            <span id="d" data-i18n="prueba.html"></span>`
        establecerIdioma("en")

        aplicarI18n(document.body)

        expect(document.getElementById("a").textContent).toBe("Saved")
        expect(document.getElementById("b").placeholder).toBe("Error")
        expect(document.getElementById("c").getAttribute("aria-label")).toBe("Settings")
        expect(document.getElementById("d").children).toHaveLength(0)
        expect(document.getElementById("d").textContent).toBe("<b>negrita</b>")
        delete window.i18nDiccionarios.en.prueba
    })

    it("actualiza data-tip si tooltips.js ya se llevó el title", () => {
        document.body.innerHTML = `<button id="b" data-tip="Ajustes" data-i18n-title="menu.ajustes"></button>`
        establecerIdioma("en")

        aplicarI18n(document.body)

        const boton = document.getElementById("b")
        expect(boton.dataset.tip).toBe("Settings")
        expect(boton.hasAttribute("title")).toBe(false)
    })
})

describe("diccionarios", () => {
    it("español e inglés tienen las mismas claves", () => {
        const es = clavesDe(window.i18nDiccionarios.es).sort()
        const en = clavesDe(window.i18nDiccionarios.en).sort()

        expect(en.filter((clave) => !es.includes(clave))).toEqual([])
        expect(es.filter((clave) => !en.includes(clave))).toEqual([])
    })

    it("toda clave usada con t() en js/ existe en español", () => {
        const es = new Set(clavesDe(window.i18nDiccionarios.es))
        const faltan = []
        for (const ruta of scriptsDeLaAplicacion()) {
            const fuente = readFileSync(ruta, "utf-8")
            for (const [, clave] of fuente.matchAll(/\bt\(\s*"([\w.]+)"/g)) {
                if (!es.has(clave)) faltan.push(`${ruta.slice(raiz.length + 1)}: ${clave}`)
            }
        }

        expect(faltan).toEqual([])
    })

    it("el texto de index.html coincide con el diccionario español", () => {
        const html = readFileSync(join(raiz, "index.html"), "utf-8")
        const documento = new DOMParser().parseFromString(html, "text/html")
        const distintos = []

        documento.querySelectorAll("[data-i18n]").forEach((el) => {
            let texto = el.textContent.replace(/\s+/g, " ").trim()
            // La flecha de los desplegables la pone etiquetarDesplegables().
            if (el.classList.contains("navDropdownBtn")) texto = texto.replace(/ ▾$/, "")
            const esperado = t(el.dataset.i18n)
            if (texto !== esperado) distintos.push(`${el.dataset.i18n}: "${texto}" ≠ "${esperado}"`)
        })
        for (const atributo of atributos) {
            documento.querySelectorAll(`[data-i18n-${atributo}]`).forEach((el) => {
                const clave = el.getAttribute(`data-i18n-${atributo}`)
                const texto = el.getAttribute(atributo)
                if (texto !== t(clave)) distintos.push(`${clave} (${atributo}): "${texto}" ≠ "${t(clave)}"`)
            })
        }

        expect(distintos).toEqual([])
    })
})
