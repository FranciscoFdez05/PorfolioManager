// Cableado de la pantalla de planes.
//
// El cálculo lo cubre planes.test.js; lo que falta comprobar es lo otro que
// puede romper una pantalla sin que salte nada: que los identificadores del
// fragmento HTML sean los que busca el JavaScript. Aquí no hay compilador que
// avise —`document.getElementById("planesGrid")` devuelve `null` y la página se
// queda en blanco—, así que la prueba carga el HTML real de
// `html/cartera/activos.html` y ejercita `initPlanesLogic()` sobre él.
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { cargarScript } from "./cargar.js"

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const PLAN = {
    id: "plan-1",
    nombre: "Bitcoin a 120k",
    symbol: "BTC",
    ticker: "BTC-USD",
    marketProvider: "yahoo",
    direccion: "Largo",
    currency: "EUR",
    precioEntrada: "100",
    precioSalida: "150",
    stopLoss: "90",
    capital: "1000",
    horizonte: "Largo",
    estado: "En curso",
    notas: "Comprar en tramos",
    fechaObjetivo: ""
}

const DCA = {
    id: "dca-1",
    nombre: "World mensual",
    symbol: "IWDA",
    ticker: "",
    marketProvider: "",
    currency: "EUR",
    importe: "300",
    frecuencia: "Mensual",
    fechaInicio: "15-01-2026",
    fechaFin: "",
    aportesObjetivo: "24",
    precioMaximo: "",
    estado: "Activo",
    notas: ""
}

/** Respuestas de /api/planes y /api/dca, y captura de lo que se guarda.
 *
 * Las filas se copian en cada respuesta porque varias pruebas las modifican
 * para simular una edición; sin la copia, una prueba llegaría a la siguiente
 * con el plan ya cambiado. */
function fetchFalso(guardados) {
    return vi.fn((url, opciones) => {
        if (opciones?.method === "POST") {
            guardados.push({ url, body: JSON.parse(opciones.body) })
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
        }
        if (String(url).startsWith("/api/planes")) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [{ ...PLAN }] }) })
        }
        if (String(url).startsWith("/api/dca")) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [{ ...DCA }] }) })
        }
        // Cotizaciones y tipos de cambio: sin red, el resto tiene que aguantar.
        return Promise.resolve({ ok: false, json: () => Promise.resolve({ ok: false }) })
    })
}

let guardados = []

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cartera/assets.js")
    cargarScript("js/cartera/planes.js")
})

beforeEach(async () => {
    guardados = []
    document.body.innerHTML = readFileSync(join(RAIZ, "html/cartera/activos.html"), "utf-8")
    localStorage.clear()
    _planesQuoteCache.clear()
    _activosAllAssets = []
    globalThis.fetch = fetchFalso(guardados)

    await initPlanesLogic()
})

afterEach(() => {
    document.getElementById("planModalOverlay")?.remove()
})

describe("las tres categorías", () => {
    it("arranca en Activos y esconde las otras dos", () => {
        expect(document.getElementById("avCatPanelActivos").classList.contains("hidden")).toBe(false)
        expect(document.getElementById("avCatPanelPlanes").classList.contains("hidden")).toBe(true)
        expect(document.getElementById("avCatPanelDca").classList.contains("hidden")).toBe(true)
    })

    it("la pestaña cambia de panel y marca la activa", () => {
        document.querySelector('.avCatTab[data-cat="planes"]').click()

        expect(document.getElementById("avCatPanelActivos").classList.contains("hidden")).toBe(true)
        expect(document.getElementById("avCatPanelPlanes").classList.contains("hidden")).toBe(false)
        expect(document.querySelector(".avCatTabActive").dataset.cat).toBe("planes")
    })

    it("recuerda la categoría entre visitas a la página", async () => {
        document.querySelector('.avCatTab[data-cat="dca"]').click()
        expect(localStorage.getItem("activosCategoria")).toBe("dca")

        // Segunda entrada en la página: el fragmento se vuelve a insertar.
        document.body.innerHTML = readFileSync(join(RAIZ, "html/cartera/activos.html"), "utf-8")
        await initPlanesLogic()

        expect(document.getElementById("avCatPanelDca").classList.contains("hidden")).toBe(false)
    })
})

describe("tarjetas", () => {
    it("pinta un plan de inversión con lo que falta para el objetivo", () => {
        const tarjeta = document.querySelector("#planesGrid .planCard")

        expect(tarjeta).not.toBeNull()
        expect(tarjeta.dataset.planId).toBe("plan-1")
        expect(tarjeta.querySelector(".avCardName").textContent).toBe("Bitcoin a 120k")
        // Sin cotización no hay porcentaje que enseñar, pero la tarjeta se pinta
        // igual: el plan existe aunque el proveedor no responda.
        expect(tarjeta.querySelector(".planDestacadoLabel").textContent).toBe("Falta para el objetivo")
        expect(tarjeta.querySelector(".planDestacadoValor").textContent).toBe("—")
    })

    it("calcula el porcentaje en cuanto hay precio", async () => {
        _activosAllAssets = [{ id: "btc", name: "Bitcoin", price: "120", currency: "EUR" }]
        _planesRows[0].assetId = "btc"
        planesRender()

        const valor = document.querySelector("#planesGrid .planDestacadoValor")
        expect(valor.textContent).toContain("25,00")
        expect(valor.classList.contains("avPos")).toBe(true)
    })

    it("pinta un plan DCA con su próximo aporte", () => {
        const tarjeta = document.querySelector("#dcaGrid .planCard")

        expect(tarjeta.dataset.dcaId).toBe("dca-1")
        expect(tarjeta.querySelector(".planDestacadoLabel").textContent).toBe("Próximo aporte")
    })

    it("escapa el contenido que escribe el usuario", () => {
        _planesRows[0].nombre = '<img src=x onerror="robar()">'
        planesRender()

        const nombre = document.querySelector("#planesGrid .avCardName")
        expect(nombre.querySelector("img")).toBeNull()
        expect(nombre.textContent).toBe('<img src=x onerror="robar()">')
    })

    it("el contador refleja lo que hay en pantalla", () => {
        expect(document.getElementById("planesCount").textContent).toBe("1 plan")
    })
})

describe("filtros y búsqueda", () => {
    it("el filtro por estado esconde lo que no coincide", () => {
        document.querySelector('#planesEstadoFilters [data-estado="Cumplido"]').click()

        expect(document.querySelectorAll("#planesGrid .planCard")).toHaveLength(0)
        expect(document.getElementById("planesEmpty").classList.contains("hidden")).toBe(false)
    })

    it("la búsqueda mira nombre, símbolo, ticker y notas", () => {
        const buscador = document.getElementById("planesSearch")

        buscador.value = "tramos"
        buscador.dispatchEvent(new Event("input"))
        expect(document.querySelectorAll("#planesGrid .planCard")).toHaveLength(1)

        buscador.value = "nada de nada"
        buscador.dispatchEvent(new Event("input"))
        expect(document.querySelectorAll("#planesGrid .planCard")).toHaveLength(0)
    })
})

describe("edición", () => {
    it("el botón de alta abre la ficha vacía", () => {
        document.getElementById("planesAddBtn").click()

        expect(document.getElementById("planModalOverlay")).not.toBeNull()
        expect(document.getElementById("planFormNombre").value).toBe("")
        // Un plan nuevo no se puede borrar todavía.
        expect(document.getElementById("planModalDeleteBtn")).toBeNull()
    })

    it("editar trae los valores guardados y devuelve los nuevos al servidor", async () => {
        document.querySelector("#planesGrid .planEditBtn").click()
        expect(document.getElementById("planFormEntrada").value).toBe("100")

        document.getElementById("planFormSalida").value = "200"
        document.getElementById("planModalSaveBtn").click()
        await vi.waitFor(() => expect(guardados).toHaveLength(1))

        expect(guardados[0].url).toBe("/api/planes")
        expect(guardados[0].body.rows).toHaveLength(1)
        expect(guardados[0].body.rows[0].precioSalida).toBe("200")
        // Y la tarjeta ya enseña el plan nuevo, sin esperar a la respuesta.
        expect(document.getElementById("planModalOverlay")).toBeNull()
    })

    it("un plan sin nombre ni símbolo no se guarda", async () => {
        document.getElementById("planesAddBtn").click()
        document.getElementById("planModalSaveBtn").click()

        expect(guardados).toHaveLength(0)
        expect(document.getElementById("planModalOverlay")).not.toBeNull()
    })

    it("duplicar deja el original y añade una copia pendiente", async () => {
        document.querySelector("#planesGrid .planDuplicateBtn").click()
        await vi.waitFor(() => expect(guardados).toHaveLength(1))

        const filas = guardados[0].body.rows
        expect(filas).toHaveLength(2)
        expect(filas[1].nombre).toBe("Bitcoin a 120k (copia)")
        expect(filas[1].estado).toBe("Pendiente")
        expect(filas[1].id).not.toBe(filas[0].id)
    })

    it("cambiar estado avanza por el ciclo y lo guarda", async () => {
        document.querySelector("#planesGrid .planEstadoBtn").click()
        await vi.waitFor(() => expect(guardados).toHaveLength(1))

        expect(guardados[0].body.rows[0].estado).toBe("Cumplido")
    })
})

describe("calendario del plan DCA", () => {
    it("lista los próximos aportes con su acumulado", () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 2, 20))
        try {
            document.querySelector("#dcaGrid .dcaCalendarBtn").click()
        } finally {
            vi.useRealTimers()
        }

        const filas = document.querySelectorAll(".planCalendario tbody tr")
        expect(filas).toHaveLength(12)
        expect(filas[0].children[0].textContent).toBe("4")
        expect(filas[0].children[1].textContent).toBe("15-04-2026")
    })
})
