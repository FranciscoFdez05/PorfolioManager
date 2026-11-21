// Herramientas propias: nombres de fórmula, formato de resultados y lectura del editor.
import { beforeAll, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/analisis/herramientas-formula.js")
    cargarScript("js/analisis/herramientas-propias.js")
})

describe("hPropiaClaveDesde", () => {
    it("pasa la etiqueta a camelCase sin acentos ni símbolos", () => {
        expect(hPropiaClaveDesde("Gasto anual (€)")).toBe("gastoAnual")
        expect(hPropiaClaveDesde("Años de inversión")).toBe("anosDeInversion")
    })

    it("no empieza por número y respeta el tope", () => {
        expect(hPropiaClaveDesde("3 meses")).toBe("c3Meses")
        expect(hPropiaClaveDesde("a ".repeat(40)).length).toBeLessThanOrEqual(24)
        expect(hPropiaClaveDesde("")).toBe("")
    })
})

describe("hPropiaFormatear", () => {
    it("número y porcentaje con los decimales pedidos y el sufijo", () => {
        window._numLocale = "es-ES"
        expect(hPropiaFormatear(1234.5, { formato: "numero", decimales: 1, sufijo: "años" })).toBe("1234,5 años")
        expect(hPropiaFormatear(4, { formato: "porcentaje", decimales: 2, sufijo: "" })).toBe("4,00 %")
    })

    it("moneda en la moneda base", () => {
        window._monedaBase = "EUR"
        expect(hPropiaFormatear(600000, { formato: "moneda", decimales: 0, sufijo: "" })).toMatch(/600\.000 €/)
    })
})

describe("hPropiaLeerEditor", () => {
    function editor() {
        document.body.innerHTML = ""
        const panel = hPanelEditorPropia()
        document.body.appendChild(panel)
        return panel
    }

    function rellenar(panel, { titulo = "Regla", clave = "gasto", formula = "gasto * 25" } = {}) {
        panel.querySelector("#hPropiaTitulo").value = titulo
        const [etiqueta, claveInput] = panel.querySelectorAll("#hPropiaCampos tr input")
        etiqueta.value = "Gasto"
        claveInput.value = clave
        const [etiquetaRes, formulaInput] = panel.querySelectorAll("#hPropiaResultados tr input")
        etiquetaRes.value = "Capital"
        formulaInput.value = formula
    }

    it("devuelve los datos listos para enviar", () => {
        const panel = editor()
        hPropiaEditorPreparar(null)
        rellenar(panel)

        const { datos, error } = hPropiaLeerEditor(panel)

        expect(error).toBeUndefined()
        expect(datos.titulo).toBe("Regla")
        expect(datos.campos).toEqual([{ etiqueta: "Gasto", clave: "gasto", unidad: "", defecto: 0 }])
        expect(datos.resultados[0]).toMatchObject({
            etiqueta: "Capital",
            formula: "gasto * 25",
            formato: "numero",
            destacado: true
        })
    })

    it.each([
        [{ titulo: "" }, "título"],
        [{ clave: "1a" }, "no es válido"],
        [{ formula: "gasto *" }, "Resultado 1"],
        [{ formula: "otro * 2" }, "«otro» no existe"]
    ])("rechaza %o", (cambios, mensaje) => {
        const panel = editor()
        hPropiaEditorPreparar(null)
        rellenar(panel, cambios)

        expect(hPropiaLeerEditor(panel).error).toContain(mensaje)
    })

    it("al editar carga la herramienta y la etiqueta no pisa el nombre ya puesto", () => {
        const panel = editor()
        hPropiaEditorPreparar({
            id: "a1",
            titulo: "X",
            descripcion: "",
            campos: [{ clave: "base", etiqueta: "Base", unidad: "€", defecto: 10 }],
            resultados: [
                {
                    etiqueta: "Doble",
                    formula: "base * 2",
                    formato: "moneda",
                    decimales: 2,
                    sufijo: "",
                    destacado: false
                }
            ]
        })

        const [etiqueta, clave] = panel.querySelectorAll("#hPropiaCampos tr input")
        etiqueta.value = "Otra cosa"
        etiqueta.dispatchEvent(new Event("input"))

        expect(clave.value).toBe("base")
        expect(panel.querySelector("#hPropiaEditorTitulo").textContent).toBe("Editar «X»")
        expect(hPropiaLeerEditor(panel).datos.resultados[0].formato).toBe("moneda")
    })
})
