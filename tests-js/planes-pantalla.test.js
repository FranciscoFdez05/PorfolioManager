// Cableado de las pestañas de planes dentro de la ficha del activo.
//
// El cálculo lo cubre planes.test.js; lo que falta comprobar es lo otro que
// puede romper una pantalla sin que salte nada: que los identificadores que
// pinta `renderAssetTablePage()` (en assets.js) sean los que busca planes.js.
// Aquí no hay compilador que avise —`document.getElementById("planesGrid")`
// devuelve `null` y la pestaña se queda en blanco—, así que la prueba monta la
// ficha real de un activo y ejercita `initAssetPlanesLogic()` sobre ella.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { cargarScript } from "./cargar.js"

const ACTIVO = {
    id: "bitcoin",
    name: "Bitcoin",
    symbol: "BTC",
    type: "cripto",
    price: "120",
    currency: "EUR",
    marketProvider: "yahoo",
    marketSymbol: "BTC-USD",
    tvSymbol: ""
}

const PLAN = {
    id: "plan-1",
    assetId: "bitcoin",
    nombre: "Bitcoin a 150",
    symbol: "BTC",
    ticker: "BTC-USD",
    marketProvider: "yahoo",
    currency: "EUR",
    precioEntrada: "100",
    precioSalida: "150",
    capital: "1000",
    horizonte: "Largo",
    estado: "En curso",
    notas: "Comprar en tramos",
    fechaObjetivo: ""
}

// Plan de otro activo: no debe aparecer en esta ficha, pero sí volver íntegro
// al servidor en cuanto se guarde cualquier cosa desde aquí.
const PLAN_AJENO = { ...PLAN, id: "plan-2", assetId: "otro", nombre: "Oro a 5.000" }

/** Respuesta de /api/planes y captura de lo que se guarda.
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
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ rows: [{ ...PLAN }, { ...PLAN_AJENO }] })
            })
        }
        // Tipos de cambio y demás: sin red, la pestaña tiene que aguantar.
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
    document.body.innerHTML = '<div id="dynamicContent"></div>'
    localStorage.clear()
    globalThis.fetch = fetchFalso(guardados)

    // Las listas se piden una sola vez por sesión; cada prueba parte de cero.
    _planesCargados = false
    _planesRows = []

    renderAssetTablePage({ ...ACTIVO })
    await initAssetPlanesLogic({ ...ACTIVO })
})

afterEach(() => {
    document.getElementById("planModalOverlay")?.remove()
})

describe("pestañas de la ficha", () => {
    it("la ficha abre en Compras spot y esconde la de planes", () => {
        expect(document.querySelector('.assetTabPanel[data-tab="spot"]').classList.contains("hidden")).toBe(false)
        expect(document.querySelector('.assetTabPanel[data-tab="planes"]').classList.contains("hidden")).toBe(true)
    })

    it("la pestaña de Planes cambia de panel y saca su botón de alta", () => {
        document.getElementById("planesTabBtn").click()

        expect(document.querySelector('.assetTabPanel[data-tab="planes"]').classList.contains("hidden")).toBe(false)
        expect(document.getElementById("assetAddPlanNavBtn").classList.contains("hidden")).toBe(false)
    })

    it("la pestaña lleva en el rótulo cuántos planes tiene el activo", () => {
        expect(document.getElementById("planesTabBtn").textContent).toBe("Planes (1)")
    })
})

describe("tarjetas", () => {
    it("solo enseña los planes de este activo", () => {
        const tarjetas = document.querySelectorAll("#planesGrid .planCard")

        expect(tarjetas).toHaveLength(1)
        expect(tarjetas[0].dataset.planId).toBe("plan-1")
        expect(tarjetas[0].querySelector(".avCardName").textContent).toBe("Bitcoin a 150")
    })

    it("calcula lo que falta para el objetivo con el precio del activo", () => {
        // El activo vale 120 y el objetivo está en 150: un 25 % por encima.
        const valor = document.querySelector("#planesGrid .planDestacadoValor")

        expect(valor.textContent).toContain("25,00")
        expect(valor.classList.contains("avPos")).toBe(true)
    })

    it("un plan de inversión no enseña nada de trading", () => {
        const tarjeta = document.querySelector("#planesGrid .planCard")
        const etiquetas = [...tarjeta.querySelectorAll(".avMetricLabel")].map((e) => e.textContent)

        expect(etiquetas).not.toContain("Stop")
        expect(etiquetas).not.toContain("Ratio B/R")
        expect(etiquetas).not.toContain("Riesgo")
        expect(tarjeta.querySelector(".planDirBadge")).toBeNull()
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

describe("filtro por estado", () => {
    it("esconde lo que no coincide", () => {
        document.querySelector('#planesEstadoFilters [data-estado="Cumplido"]').click()

        expect(document.querySelectorAll("#planesGrid .planCard")).toHaveLength(0)
        expect(document.getElementById("planesEmpty").classList.contains("hidden")).toBe(false)
    })

    it("y «Todos» los devuelve", () => {
        document.querySelector('#planesEstadoFilters [data-estado="Cumplido"]').click()
        document.querySelector('#planesEstadoFilters [data-estado="all"]').click()

        expect(document.querySelectorAll("#planesGrid .planCard")).toHaveLength(1)
    })
})

describe("edición", () => {
    it("el botón de alta abre la ficha vacía y sin campos de activo", () => {
        document.getElementById("assetAddPlanNavBtn").click()

        expect(document.getElementById("planModalOverlay")).not.toBeNull()
        expect(document.getElementById("planFormNombre").value).toBe("")
        // El activo lo pone la ficha, no un desplegable ni un ticker a mano.
        expect(document.getElementById("planFormAssetId")).toBeNull()
        expect(document.getElementById("planFormTicker")).toBeNull()
        expect(document.getElementById("planFormStop")).toBeNull()
        expect(document.getElementById("planFormDireccion")).toBeNull()
        // Un plan nuevo no se puede borrar todavía.
        expect(document.getElementById("planModalDeleteBtn")).toBeNull()
    })

    it("un plan nuevo cuelga del activo de la ficha", async () => {
        document.getElementById("assetAddPlanNavBtn").click()
        document.getElementById("planFormSalida").value = "200"
        document.getElementById("planModalSaveBtn").click()
        await vi.waitFor(() => expect(guardados).toHaveLength(1))

        const nuevo = guardados[0].body.rows.at(-1)
        expect(nuevo.assetId).toBe("bitcoin")
        expect(nuevo.symbol).toBe("BTC")
        expect(nuevo.currency).toBe("EUR")
        // Sin nombre se queda con el del activo, que es mejor que "Plan".
        expect(nuevo.nombre).toBe("Bitcoin")
    })

    it("editar trae los valores guardados y devuelve los nuevos al servidor", async () => {
        document.querySelector("#planesGrid .planEditBtn").click()
        expect(document.getElementById("planFormEntrada").value).toBe("100")

        document.getElementById("planFormSalida").value = "200"
        document.getElementById("planModalSaveBtn").click()
        await vi.waitFor(() => expect(guardados).toHaveLength(1))

        expect(guardados[0].url).toBe("/api/planes")
        expect(guardados[0].body.rows[0].precioSalida).toBe("200")
        // Y la tarjeta ya enseña el plan nuevo, sin esperar a la respuesta.
        expect(document.getElementById("planModalOverlay")).toBeNull()
    })

    it("guardar devuelve también los planes de los demás activos", async () => {
        // El servidor reemplaza la lista entera: si se enviara solo lo de esta
        // ficha, guardar aquí borraría los planes de todos los demás activos.
        document.querySelector("#planesGrid .planEditBtn").click()
        document.getElementById("planModalSaveBtn").click()
        await vi.waitFor(() => expect(guardados).toHaveLength(1))

        expect(guardados[0].body.rows.map((f) => f.id)).toEqual(["plan-1", "plan-2"])
    })

    it("duplicar deja el original y añade una copia pendiente", async () => {
        document.querySelector("#planesGrid .planDuplicateBtn").click()
        await vi.waitFor(() => expect(guardados).toHaveLength(1))

        const filas = guardados[0].body.rows
        expect(filas).toHaveLength(3)
        expect(filas[1].nombre).toBe("Bitcoin a 150 (copia)")
        expect(filas[1].estado).toBe("Pendiente")
        expect(filas[1].id).not.toBe(filas[0].id)
        // Y en pantalla ya son dos.
        expect(document.querySelectorAll("#planesGrid .planCard")).toHaveLength(2)
    })

    it("cambiar estado avanza por el ciclo y lo guarda", async () => {
        document.querySelector("#planesGrid .planEstadoBtn").click()
        await vi.waitFor(() => expect(guardados).toHaveLength(1))

        expect(guardados[0].body.rows[0].estado).toBe("Cumplido")
    })
})
