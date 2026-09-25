// Pantalla de Planes de inversión (menú superior › Planes).
//
// Lo que se comprueba es lo que no avisa si se rompe: que la tabla pinta los
// activos del plan con sus totales calculados a partir de las operaciones
// reales, que al desplegar un activo salen sus operaciones con el porcentaje
// de cada compra y si está realizada, que el popup de crear plan guarda antes
// las operaciones nuevas y después el plan que las referencia, y que archivar
// saca el plan del selector sin borrarlo.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { cargarScript } from "./cargar.js"

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const ACTIVOS = [
    { id: "bitcoin", name: "Bitcoin", symbol: "BTC", type: "cripto", currency: "EUR" },
    { id: "sp500", name: "S&P 500", symbol: "SPY", type: "etfs", currency: "USD" },
    { id: "oro", name: "Oro", symbol: "XAU", type: "comoditis", currency: "EUR" }
]

const OPERACIONES = [
    {
        id: "op-btc-1",
        assetId: "bitcoin",
        orden: "Compra",
        precioOrden: "50000",
        cantidad: "0,004",
        total: "200",
        currency: "EUR",
        estado: "Activo",
        fechaApertura: "01-09-2026",
        par: "BTC/EUR"
    },
    {
        id: "op-btc-2",
        assetId: "bitcoin",
        orden: "Compra",
        precioOrden: "60000",
        cantidad: "0,005",
        total: "300",
        currency: "EUR",
        estado: "Activo",
        fechaApertura: "02-09-2026",
        par: "BTC/EUR"
    },
    {
        id: "op-btc-3",
        assetId: "bitcoin",
        orden: "Compra",
        precioOrden: "70000",
        cantidad: "",
        total: "500",
        currency: "EUR",
        estado: "Completado",
        fechaApertura: "03-09-2026",
        par: "BTC/EUR"
    },
    {
        id: "op-btc-x",
        assetId: "bitcoin",
        orden: "Compra",
        precioOrden: "10000",
        cantidad: "1",
        total: "10000",
        currency: "EUR",
        estado: "Cancelado",
        fechaApertura: "",
        par: "BTC/EUR"
    },
    {
        id: "op-sp-1",
        assetId: "sp500",
        orden: "Compra",
        precioOrden: "500",
        cantidad: "4",
        total: "2000",
        currency: "USD",
        estado: "Activo",
        fechaApertura: "",
        par: "SPY/USD"
    },
    // Abierta pero de otro activo: no puede vincularse a Bitcoin.
    {
        id: "op-oro-1",
        assetId: "oro",
        orden: "Venta",
        precioOrden: "3000",
        cantidad: "1",
        total: "3000",
        currency: "EUR",
        estado: "Activo",
        fechaApertura: "",
        par: "XAU/EUR"
    }
]

const PLAN = {
    id: "plan-1",
    nombre: "Acumular en 2026",
    archivado: false,
    activos: [
        { assetId: "bitcoin", operaciones: ["op-btc-1", "op-btc-2", "op-btc-3", "op-btc-x"] },
        { assetId: "sp500", operaciones: ["op-sp-1"] }
    ]
}

const PLAN_ARCHIVADO = { id: "plan-2", nombre: "Viejo", archivado: true, activos: [] }

let guardados = []
let planesServidor = []

function respuesta(cuerpo) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve(cuerpo) })
}

function fetchFalso() {
    return vi.fn((url, opciones) => {
        const ruta = String(url)
        if (opciones?.method === "POST") {
            guardados.push({ url: ruta, body: JSON.parse(opciones.body) })
            return respuesta({ ok: true })
        }
        if (ruta.startsWith("/api/planes-cartera"))
            return respuesta({ rows: planesServidor.map((p) => structuredClone(p)) })
        if (ruta.startsWith("/api/activos")) return respuesta({ assets: ACTIVOS })
        if (ruta.startsWith("/api/operaciones")) return respuesta({ rows: OPERACIONES.map((op) => ({ ...op })) })
        // USD → EUR a 0,5 para que el efecto de la conversión se vea a simple vista.
        if (ruta.startsWith("/api/exchange-rate?source=USD")) return respuesta({ rate: 0.5 })
        return Promise.resolve({ ok: false, json: () => Promise.resolve({ ok: false }) })
    })
}

function montarPagina() {
    const html = readFileSync(resolve(RAIZ, "html/cartera/planesInversion.html"), "utf-8")
    document.body.innerHTML = `
        <div class="modalOverlay hidden" id="confirmModalOverlay">
            <div><h3 id="confirmModalTitle"></h3><p id="confirmModalMessage"></p>
            <div class="confirmModalActions"><button id="confirmModalCancelBtn"></button><button id="confirmModalAcceptBtn"></button></div></div>
        </div>
        <div id="dynamicContent">${html}</div>`
}

function textos(selector) {
    return [...document.querySelectorAll(selector)].map((el) => el.textContent.replace(/\s+/g, " ").trim())
}

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/core/app-core.js")
    cargarScript("js/cartera/assets.js")
    cargarScript("js/cartera/planes-inversion.js")
})

beforeEach(async () => {
    guardados = []
    planesServidor = [PLAN, PLAN_ARCHIVADO]
    localStorage.clear()
    globalThis.fetch = fetchFalso()
    // jsdom no dibuja: la gráfica no debe impedir que el resto se pinte.
    globalThis.Chart = undefined
    montarPagina()
    await initPlanesInversionLogic()
})

afterEach(() => {
    document.getElementById("pinvEditorOverlay")?.remove()
    document.getElementById("pinvArchivoOverlay")?.remove()
})

describe("selector de planes", () => {
    it("lista solo los planes sin archivar y abre el primero", () => {
        expect(textos(".pinvPlanTab")).toEqual(["Acumular en 2026"])
        expect(document.querySelector(".pinvPlanTab.active").dataset.planId).toBe("plan-1")
        expect(document.querySelector(".pinvPlanNombre").textContent).toBe("Acumular en 2026")
    })

    it("recuerda el plan elegido entre visitas", () => {
        expect(JSON.parse(localStorage.getItem("chartViewPrefs")).pinvPlan).toBe("plan-1")
    })
})

describe("tabla de activos", () => {
    it("pinta una fila por activo con orden, cantidad, precio medio, invertido y % invertido", () => {
        const filas = document.querySelectorAll(".pinvAssetRow")
        expect(filas).toHaveLength(2)

        const btc = [...filas[0].querySelectorAll("td")].map((td) => td.textContent.replace(/\s+/g, " ").trim())
        expect(btc[0]).toBe("Compra")
        expect(btc[1]).toContain("Bitcoin")
        expect(btc[1]).toContain("4 operaciones")
        // La cancelada (1 BTC a 10.000) no cuenta ni en cantidad ni en importe.
        expect(btc[2]).toBe("0,009")
        // Precio medio ponderado solo con las que dicen cantidad: 500 € / 0,009.
        expect(btc[3]).toBe("55.555,56 €")
        expect(btc[4]).toBe("1000,00 €")
        // Realizada la de 500 € sobre 1.000 € planificados.
        expect(btc[5]).toContain("50 %")
        expect(btc[6]).toBe("1/3 realizadas")
    })

    it("convierte a euros los importes en otra divisa", () => {
        const sp = [...document.querySelectorAll(".pinvAssetRow")[1].querySelectorAll("td")]
        // 2.000 $ a 0,5 → 1.000 €.
        expect(sp[4].textContent.trim()).toBe("1000,00 €")
    })

    it("al pulsar un activo despliega sus operaciones con el % de cada compra y su estado", () => {
        document.querySelector('.pinvAssetRow[data-asset-id="bitcoin"]').click()

        const ops = document.querySelectorAll('.pinvOpRow[data-asset-id="bitcoin"]')
        expect(ops).toHaveLength(4)

        const primera = [...ops[0].querySelectorAll("td")].map((td) => td.textContent.replace(/\s+/g, " ").trim())
        expect(primera[0]).toBe("Compra")
        expect(primera[1]).toContain("01-09-2026")
        expect(primera[3]).toBe("50.000,00 €")
        expect(primera[4]).toBe("200,00 €")
        expect(primera[5]).toBe("20 %")
        expect(primera[6]).toBe("No realizada")

        expect(textos('.pinvOpRow[data-asset-id="bitcoin"] .pinvEstado')).toEqual([
            "No realizada",
            "No realizada",
            "Realizada",
            "Cancelada"
        ])
        expect(ops[3].classList.contains("pinvOpRow--cancelada")).toBe(true)

        // Segundo clic: se pliega.
        document.querySelector('.pinvAssetRow[data-asset-id="bitcoin"]').click()
        expect(document.querySelectorAll(".pinvOpRow")).toHaveLength(0)
    })

    it("la cabecera resume lo planificado y lo realizado del plan", () => {
        const kpis = textos(".pinvKpiValue")
        expect(kpis[0]).toBe("2000,00 €")
        expect(kpis[1]).toBe("500,00 €")
        expect(kpis[2]).toBe("25 %")
        expect(document.querySelector(".pinvChartPct").textContent).toBe("25 %")
    })

    it("las líneas del tooltip dicen qué se ha comprado y qué queda", () => {
        const calculo = pinvCalcularPlan(PLAN)
        expect(pinvLineasTooltip(calculo, true)).toEqual(["Bitcoin: 500,00 € (100 %)"])
        expect(pinvLineasTooltip(calculo, false)).toEqual(["Bitcoin: 500,00 € (33,3 %)", "S&P 500: 1000,00 € (66,7 %)"])
    })
})

describe("reparto por activo", () => {
    it("pinta una fila de leyenda por activo con su parte del plan", () => {
        expect(textos(".pinvRepartoNombre")).toEqual(["Bitcoin", "S&P 500"])
        expect(textos(".pinvRepartoValor")).toEqual(["1000,00 €", "1000,00 €"])
        expect(textos(".pinvRepartoFila .pinvLegendPct")).toEqual(["50 %", "50 %"])
        expect(document.querySelector(".pinvRepartoTotal").textContent).toBe("2000,00 €")
    })

    it("el porcentaje es sobre el total del plan", () => {
        // Bitcoin 200 € y S&P 500 dos mil dólares (1.000 € al cambio de la
        // prueba): 200 de 1.200 y 1.000 de 1.200.
        const plan = {
            id: "plan-x",
            nombre: "Pesos distintos",
            archivado: false,
            activos: [
                { assetId: "bitcoin", operaciones: ["op-btc-1"] },
                { assetId: "sp500", operaciones: ["op-sp-1"] }
            ]
        }

        pinvRenderReparto(pinvCalcularPlan(plan))

        expect(textos(".pinvRepartoFila .pinvLegendPct")).toEqual(["16,7 %", "83,3 %"])
    })

    it("cada activo tiene su color, y el propio del activo manda", () => {
        const calculo = pinvCalcularPlan(PLAN)
        expect(pinvColorReparto(calculo.activos[0], 0)).toBe(PINV_PALETA_REPARTO[0])
        expect(pinvColorReparto(calculo.activos[1], 1)).toBe(PINV_PALETA_REPARTO[1])
        expect(pinvColorReparto({ activo: { color: "#123456" } }, 0)).toBe("#123456")
    })

    it("el detalle del activo va en el title de la fila", () => {
        expect(document.querySelector(".pinvRepartoFila").getAttribute("title")).toBe(
            "Bitcoin: 500,00 € de 1000,00 € (50 % realizado)"
        )
    })

    it("sin plan no se enseña la tarjeta", () => {
        pinvRenderReparto(null)

        expect(document.getElementById("pinvRepartoCard").classList.contains("hidden")).toBe(true)
        expect(document.querySelectorAll(".pinvRepartoFila")).toHaveLength(0)
    })
})

describe("crear un plan", () => {
    it("el popup ofrece solo los activos que no están ya en el plan", () => {
        document.getElementById("pinvCrearBtn").click()
        const selector = document.getElementById("pinvEditorSelector")
        expect([...selector.options].map((o) => o.value)).toEqual(["", "bitcoin", "oro", "sp500"])

        selector.value = "bitcoin"
        selector.dispatchEvent(new Event("change", { bubbles: true }))

        expect([...selector.options].map((o) => o.value)).toEqual(["", "oro", "sp500"])
        expect(textos(".pinvEditorActivoNombre")).toEqual(["Bitcoin"])
    })

    it("al elegir un activo se abre con sus operaciones abiertas para vincular", () => {
        document.getElementById("pinvCrearBtn").click()
        const selector = document.getElementById("pinvEditorSelector")
        selector.value = "bitcoin"
        selector.dispatchEvent(new Event("change", { bubbles: true }))

        // Las dos abiertas de Bitcoin; ni la completada, ni la cancelada, ni la de Oro.
        const casillas = [...document.querySelectorAll(".pinvOpCheck input[data-op-id]")]
        expect(casillas.map((c) => c.dataset.opId)).toEqual(["op-btc-1", "op-btc-2"])
        expect(casillas.every((c) => !c.checked)).toBe(true)
    })

    it("guarda primero las operaciones nuevas en Operaciones y después el plan", async () => {
        document.getElementById("pinvCrearBtn").click()
        document.getElementById("pinvEditorNombre").value = "Plan nuevo"

        const selector = document.getElementById("pinvEditorSelector")
        selector.value = "bitcoin"
        selector.dispatchEvent(new Event("change", { bubbles: true }))

        // Vincular una abierta…
        const casilla = document.querySelector('input[data-op-id="op-btc-1"]')
        casilla.checked = true
        casilla.dispatchEvent(new Event("change", { bubbles: true }))

        // …y crear una nueva con precio y total: la cantidad sale sola.
        const form = document.querySelector(".pinvNuevaForm")
        form.querySelector('[data-campo="precio"]').value = "80.000"
        form.querySelector('[data-campo="total"]').value = "400"
        form.querySelector(".pinvNuevaAddBtn").click()

        // La fecha es la de hoy, que pone el formulario por defecto.
        expect(textos(".pinvOpNueva .pinvOpCheckTexto")[0]).toMatch(
            /^Compra · 0,005 BTC · a 80\.000,00 € · 400,00 € · \d{2}-\d{2}-\d{4}$/
        )
        expect(document.querySelector(".pinvEditorActivoResumen").textContent).toBe("2 operaciones · 600,00 €")

        document.getElementById("pinvEditorSaveBtn").click()
        await vi.waitFor(() => expect(guardados).toHaveLength(2))

        expect(guardados[0].url).toBe("/api/operaciones")
        const nueva = guardados[0].body.rows.at(-1)
        expect(guardados[0].body.rows).toHaveLength(OPERACIONES.length + 1)
        expect(nueva).toMatchObject({
            assetId: "bitcoin",
            activo: "Bitcoin",
            orden: "Compra",
            precioOrden: "80000",
            cantidad: "0,005",
            total: "400",
            currency: "EUR",
            par: "BTC/EUR",
            estado: "Activo"
        })

        expect(guardados[1].url).toBe("/api/planes-cartera")
        const planes = guardados[1].body.rows
        expect(planes.map((p) => p.nombre)).toEqual(["Acumular en 2026", "Viejo", "Plan nuevo"])
        expect(planes[2].activos).toEqual([{ assetId: "bitcoin", operaciones: ["op-btc-1", nueva.id] }])

        // La pantalla se queda en el plan recién creado.
        expect(document.querySelector(".pinvPlanTab.active").textContent).toBe("Plan nuevo")
        expect(document.getElementById("pinvEditorOverlay")).toBeNull()
    })

    it("sin nombre no guarda nada", async () => {
        document.getElementById("pinvCrearBtn").click()
        document.getElementById("pinvEditorSaveBtn").click()
        await new Promise((r) => setTimeout(r, 0))
        expect(guardados).toHaveLength(0)
        expect(document.getElementById("pinvEditorOverlay")).not.toBeNull()
    })

    it("cancelar el popup no crea operaciones", () => {
        document.getElementById("pinvCrearBtn").click()
        const selector = document.getElementById("pinvEditorSelector")
        selector.value = "oro"
        selector.dispatchEvent(new Event("change", { bubbles: true }))
        const form = document.querySelector(".pinvNuevaForm")
        form.querySelector('[data-campo="precio"]').value = "3000"
        form.querySelector('[data-campo="cantidad"]').value = "1"
        form.querySelector(".pinvNuevaAddBtn").click()

        document.getElementById("pinvEditorCancelBtn").click()
        expect(guardados).toHaveLength(0)
        expect(document.getElementById("pinvEditorOverlay")).toBeNull()
    })
})

describe("editar un plan", () => {
    it("abre el popup con el nombre y los activos del plan, y sus operaciones marcadas", () => {
        document.querySelector('.pinvHeaderBtn[data-accion="editar"]').click()

        expect(document.getElementById("pinvEditorNombre").value).toBe("Acumular en 2026")
        expect(textos(".pinvEditorActivoNombre")).toEqual(["Bitcoin", "S&P 500"])

        document.querySelector('[data-toggle-activo="bitcoin"]').click()
        const marcadas = [...document.querySelectorAll(".pinvOpCheck input:checked")].map((c) => c.dataset.opId)
        expect(marcadas).toEqual(["op-btc-1", "op-btc-2", "op-btc-3", "op-btc-x"])
    })

    it("quitar un activo lo saca del plan al guardar", async () => {
        document.querySelector('.pinvHeaderBtn[data-accion="editar"]').click()
        document.querySelector('[data-quitar-activo="sp500"]').click()
        document.getElementById("pinvEditorSaveBtn").click()
        await vi.waitFor(() => expect(guardados).toHaveLength(1))

        // Sin operaciones nuevas no se toca Operaciones.
        expect(guardados[0].url).toBe("/api/planes-cartera")
        expect(guardados[0].body.rows[0].activos.map((a) => a.assetId)).toEqual(["bitcoin"])
        expect(document.querySelectorAll(".pinvAssetRow")).toHaveLength(1)
    })
})

describe("archivar", () => {
    it("el archivo lista activos y archivados, y archivar saca el plan del selector", async () => {
        document.getElementById("pinvArchivoBtn").click()
        expect(textos(".pinvArchivoNombre")).toEqual(["Acumular en 2026", "Viejo"])
        expect(textos("[data-archivo-accion]")).toEqual(["Archivar", "Eliminar", "Desarchivar", "Eliminar"])

        document.querySelector('.pinvArchivoFila[data-plan-id="plan-1"] [data-archivo-accion="archivar"]').click()
        await vi.waitFor(() => expect(guardados).toHaveLength(1))

        expect(guardados[0].body.rows.find((p) => p.id === "plan-1").archivado).toBe(true)
        expect(document.querySelector(".pinvSinPlanes")).not.toBeNull()
        expect(document.querySelectorAll(".pinvPlanTab")).toHaveLength(0)
    })

    it("desarchivar lo devuelve al selector", async () => {
        document.getElementById("pinvArchivoBtn").click()
        document.querySelector('.pinvArchivoFila[data-plan-id="plan-2"] [data-archivo-accion="desarchivar"]').click()
        await vi.waitFor(() => expect(guardados).toHaveLength(1))

        expect(textos(".pinvPlanTab")).toEqual(["Acumular en 2026", "Viejo"])
    })
})
