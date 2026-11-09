// Activos > Paneles: las piezas que no dependen de la pantalla.
//
// La pantalla se prueba a mano y con capturas; aquí van las funciones por las
// que entra lo que no controla la aplicación —lo guardado en el servidor, un
// fichero importado que pudo editar cualquiera, los tickers que devuelve
// TradingView, los textos de variación de cada proveedor— y las que deciden qué
// activos ve cada widget. Un fallo en ellas no se ve como un error: se ve como
// un panel que se queda vacío o enseña otra cosa.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { cargarModulo, cargarScript } from "./cargar.js"

beforeAll(() => {
    // Chart.js lo carga la página desde vendor; paneles.js solo lo usa al pintar.
    globalThis.Chart = class {}
    // jsdom no trae CSS.escape (los navegadores, sí).
    globalThis.CSS ??= { escape: (t) => String(t).replace(/["\\]/g, "\\$&") }
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/analisis/heatmap.js")
    cargarScript("js/analisis/sentimiento.js")
    cargarModulo("js/cartera/paneles.js")
})

const activo = (id, extra = {}) => ({
    id,
    nombre: id.toUpperCase(),
    simbolo: id.toUpperCase(),
    tipo: "acciones",
    currency: "EUR",
    precio: 10,
    dia: 1,
    netoEur: 100,
    invertidoEur: 80,
    conPosicion: true,
    oculto: false,
    tv: "NASDAQ:" + id.toUpperCase(),
    ...extra
})

function datos(activos) {
    _pnDatos = { activos, porId: new Map(activos.map((a) => [a.id, a])) }
}

beforeEach(() => {
    localStorage.clear()
    datos([])
})

describe("pnNormalizarConfig: lo que llega del servidor", () => {
    it.each([null, undefined, "texto", 42, [], { paneles: "no" }])("no revienta con %p", (raw) => {
        expect(pnNormalizarConfig(raw)).toEqual({ paneles: [], activo: "" })
    })

    it("descarta widgets de tipos que no conoce y paneles sin id", () => {
        const cfg = pnNormalizarConfig({
            paneles: [
                { id: "p1", nombre: "A", widgets: [{ id: "w1", tipo: "mapa" }, { id: "w2", tipo: "fantasma" }, null] },
                { nombre: "sin id", widgets: [] },
                null
            ]
        })
        expect(cfg.paneles).toHaveLength(1)
        expect(cfg.paneles[0].widgets.map((w) => w.id)).toEqual(["w1"])
        expect(cfg.activo).toBe("p1")
    })

    it("dos widgets con el mismo id no se pintan como uno: el repetido se quita", () => {
        const cfg = pnNormalizarConfig({
            paneles: [
                {
                    id: "p1",
                    widgets: [
                        { id: "w1", tipo: "mapa" },
                        { id: "w1", tipo: "notas" }
                    ]
                }
            ]
        })
        expect(cfg.paneles[0].widgets.map((w) => w.tipo)).toEqual(["mapa"])
    })

    it("no comparte objetos con lo que recibe", () => {
        const raw = {
            paneles: [{ id: "p1", cfg: { fila: "44" }, widgets: [{ id: "w1", tipo: "mapa", cfg: { a: 1 } }] }]
        }
        const cfg = pnNormalizarConfig(raw)
        cfg.paneles[0].widgets[0].cfg.a = 2
        cfg.paneles[0].cfg.fila = "72"
        expect(raw.paneles[0].widgets[0].cfg.a).toBe(1)
        expect(raw.paneles[0].cfg.fila).toBe("44")
    })
})

describe("pnPanelImportado: un fichero que pudo editar cualquiera", () => {
    const importar = (p) => pnPanelImportado(p, [], { referencias: 0, encontradas: 0 })

    it("una clave __proto__ no cambia el prototipo de las opciones", () => {
        const fichero = JSON.parse(
            '{"nombre":"X","cfg":{"__proto__":["a"]},"widgets":[{"tipo":"notas","w":4,"h":4,"cfg":{"__proto__":["x"],"constructor":"y","texto":"hola"}}]}'
        )
        const panel = importar(fichero)
        const cfg = panel.widgets[0].cfg
        expect(Object.getPrototypeOf(cfg)).toBe(Object.prototype)
        expect(Object.getPrototypeOf(panel.cfg)).toBe(Object.prototype)
        expect(Object.keys(cfg)).toEqual(["texto"])
    })

    it("se queda en 24 widgets y recorta el nombre", () => {
        const panel = importar({
            nombre: "x".repeat(200),
            widgets: Array.from({ length: 40 }, () => ({ tipo: "notas" }))
        })
        expect(panel.widgets).toHaveLength(24)
        expect(panel.nombre).toHaveLength(60)
    })

    it("da ids nuevos y distintos a cada widget", () => {
        const panel = importar({ widgets: [{ tipo: "notas" }, { tipo: "notas" }, { tipo: "notas" }] })
        expect(new Set(panel.widgets.map((w) => w.id)).size).toBe(3)
    })

    it("de las listas solo pasan textos", () => {
        const panel = importar({ widgets: [{ tipo: "cartera", cfg: { columnas: ["peso", 3, { a: 1 }, null] } }] })
        expect(panel.widgets[0].cfg.columnas).toEqual(["peso"])
    })

    it("un número infinito o un objeto en las opciones no entra", () => {
        const panel = importar({ widgets: [{ tipo: "notas", w: "4", h: 1e309, cfg: { a: { b: 1 }, n: 1e309 } }] })
        expect(panel.widgets[0].cfg).toEqual({})
        expect(Number.isFinite(panel.widgets[0].h)).toBe(true)
    })

    it("conserva los tamaños con fracciones, redondeados al paso fino de la rejilla", () => {
        const panel = importar({ widgets: [{ tipo: "notas", w: 4.5, h: 3.26 }] })
        expect(panel.widgets[0].w).toBe(4.5)
        expect(panel.widgets[0].h).toBe(3.25)
    })
})

describe("pnAplicarTamano: tamaño libre en la rejilla fina", () => {
    const aplicar = (w, h) => {
        const el = document.createElement("div")
        const widget = { tipo: "notas", w, h }
        pnAplicarTamano(el, widget)
        return { el, widget }
    }

    it("un tamaño con fracciones ocupa sus pistas exactas", () => {
        const { el, widget } = aplicar(4.5, 3.25)
        expect(widget).toMatchObject({ w: 4.5, h: 3.25 })
        expect(el.style.gridColumn).toBe("span 108")
        expect(el.style.gridRow).toBe("span 78")
        expect(el.style.getPropertyValue("--pn-h")).toBe("78")
    })

    it("se acota al mínimo del tipo y al ancho de la rejilla", () => {
        const { widget } = aplicar(40, 0.5)
        expect(widget.w).toBe(12)
        expect(widget.h).toBe(2)
    })

    it("sin tamaño válido cae al de fábrica", () => {
        const { widget } = aplicar("x", NaN)
        expect(widget).toMatchObject({ w: 4, h: 4 })
    })
})

describe("tickers sueltos", () => {
    it("un «|» en el nombre no rompe el id", () => {
        const id = pnIdTicker({ symbol: "nasdaq:amd", description: "A|M|D Inc.", type: "stock" })
        expect(id.split("|")).toHaveLength(4)
        const t = pnTickerDesdeId(id)
        expect(t.tv).toBe("NASDAQ:AMD")
        expect(t.simbolo).toBe("AMD")
        expect(t.tipo).toBe("acciones")
    })

    it("el id cabe en lo que guarda el servidor (120 caracteres)", () => {
        const id = pnIdTicker({ symbol: "X".repeat(80), description: "Y".repeat(200), type: "stock" })
        expect(id.length).toBeLessThanOrEqual(120)
    })

    it.each(["tk|", "tk", "tk||nombre|acciones"])("un id roto (%s) no se convierte en un activo", (id) => {
        expect(pnTickerDesdeId(id)).toBeNull()
    })
})

describe("pnResolverRef: emparejar los activos de quien importa", () => {
    const candidatos = [activo("apple", { tv: "NASDAQ:AAPL", simbolo: "AAPL", nombre: "Apple Inc." })]

    it("por símbolo de TradingView, sin distinguir mayúsculas ni espacios", () => {
        expect(pnResolverRef({ tv: "nasdaq:aapl" }, candidatos)).toBe("apple")
    })

    it("por nombre cuando no hay símbolo", () => {
        expect(pnResolverRef({ nombre: "apple inc." }, candidatos)).toBe("apple")
    })

    it("un ticker sin equivalente se queda como ticker", () => {
        expect(pnResolverRef({ tv: "NYSE:X", ticker: "tk|NYSE:X|X|acciones" }, candidatos)).toBe("tk|NYSE:X|X|acciones")
    })

    it.each([null, "apple", 3, {}, { ticker: "javascript:alert(1)" }])("con %p no empareja nada", (ref) => {
        expect(pnResolverRef(ref, candidatos)).toBeNull()
    })
})

describe("textos de variación de los proveedores", () => {
    it.each([
        ["+1,23%", 1.23],
        ["-0,50 %", -0.5],
        ["2.5", 2.5],
        ["−3,10%", -3.1],
        ["+1.234,56%", 1234.56],
        ["1234.5", 1234.5],
        ["", null],
        [null, null],
        ["N/D", null]
    ])("%p → %p", (texto, esperado) => {
        expect(pnPorcentaje(texto)).toBe(esperado)
    })
})

describe("formato", () => {
    it("un -0,001 % no sale como «−0,00 %» ni en rojo", () => {
        expect(pnPct(-0.001)).toBe("0,00 %")
        expect(pnClaseSigno(-0.001)).toBe("")
    })

    it("sin dato es un guion", () => {
        expect(pnPct(null)).toBe("—")
        expect(pnPct(NaN)).toBe("—")
    })
})

describe("pnActivosDelWidget: qué activos ve cada widget", () => {
    beforeEach(() => {
        datos([
            activo("a"),
            activo("b", { oculto: true }),
            activo("c", { tipo: "cripto" }),
            activo("d", { conPosicion: false, netoEur: 0 })
        ])
    })

    it("sin elegir: la cartera sin ocultos", () => {
        expect(pnActivosDelWidget({}).map((a) => a.id)).toEqual(["a", "c"])
    })

    it("los ocultos entran si se piden", () => {
        expect(pnActivosDelWidget({ ocultos: true }).map((a) => a.id)).toEqual(["a", "b", "c"])
    })

    it("elegido a mano entra aunque esté oculto, y en el orden elegido", () => {
        expect(pnActivosDelWidget({ activos: ["c", "b"] }).map((a) => a.id)).toEqual(["c", "b"])
    })

    it("un activo elegido que ya no existe se ignora", () => {
        expect(pnActivosDelWidget({ activos: ["borrado", "a"] }).map((a) => a.id)).toEqual(["a"])
    })

    it("filtra por tipo", () => {
        expect(pnActivosDelWidget({ tipos: ["cripto"] }).map((a) => a.id)).toEqual(["c"])
    })

    it("sin posiciones abiertas, también los que solo se siguen", () => {
        expect(pnActivosDelWidget({}, { soloPosiciones: false }).map((a) => a.id)).toEqual(["a", "c", "d"])
    })
})

describe("opciones guardadas raras", () => {
    it("una opción con nombre de propiedad del prototipo no se toma por válida", () => {
        expect(pnOpcion({}, "toString", ["a"], "a")).toBe("a")
        expect(pnSi({}, "constructor", true)).toBe(true)
        expect(pnLista({ activos: "no es lista" }, "activos")).toEqual([])
    })

    it("el mapa de mercado no admite «desde la compra»", () => {
        expect(pnPeriodoMapa({ tipo: "mapaMercado", cfg: { periodo: "todo" } })).toBe("dia")
        expect(pnPeriodoMapa({ tipo: "mapa", cfg: { periodo: "todo" } })).toBe("todo")
    })
})

describe("guardado", () => {
    let llamadas
    beforeEach(() => {
        llamadas = []
        globalThis.fetch = async (url, opciones) => {
            llamadas.push({ url, opciones })
            return { ok: true, json: async () => ({ ok: true }) }
        }
        _pnSucio = false
        _pnConfig = { paneles: [], activo: "" }
    })

    it("al salir sin haber cambiado nada no se manda nada (no pisa otra pestaña)", async () => {
        await pnGuardarYa()
        expect(llamadas).toHaveLength(0)
    })

    it("con un cambio pendiente se manda una vez", async () => {
        pnGuardar()
        await pnGuardarYa()
        await pnGuardarYa()
        expect(llamadas).toHaveLength(1)
        expect(JSON.parse(llamadas[0].opciones.body)).toHaveProperty("panelesConfig")
    })

    it("si falla queda pendiente para el siguiente intento", async () => {
        globalThis.fetch = async () => ({ ok: false, status: 500 })
        pnGuardar()
        await pnGuardarYa()
        expect(_pnSucio).toBe(true)
    })

    it("los guardados salen en el orden en que se pidieron", async () => {
        const orden = []
        let soltar
        globalThis.fetch = async (_url, opciones) => {
            const n = JSON.parse(opciones.body).panelesConfig.activo
            if (n === "primero") await new Promise((r) => (soltar = r))
            orden.push(n)
            return { ok: true }
        }
        _pnConfig = { paneles: [], activo: "primero" }
        pnGuardar()
        const a = pnGuardarYa()
        _pnConfig = { paneles: [], activo: "segundo" }
        pnGuardar()
        const b = pnGuardarYa()
        await new Promise((r) => setTimeout(r, 10))
        soltar()
        await Promise.all([a, b])
        expect(orden).toEqual(["primero", "segundo"])
    })
})

describe("turnos de pintado", () => {
    it("una respuesta de una pintada anterior ya no vale", () => {
        const w = { id: "wTurno", tipo: "notas", cfg: {} }
        document.body.innerHTML = `<article class="pnWidget" data-widget="wTurno"><div class="pnWCtrls"></div><div class="pnWBody"></div></article>`
        _pnDatos = { activos: [], porId: new Map() }
        pnPintarWidget(w)
        const viejo = pnTurno(w)
        pnPintarWidget(w)
        expect(pnVigente(w, viejo)).toBe(false)
        expect(pnVigente(w, pnTurno(w))).toBe(true)
    })

    it("un widget que ya no está en pantalla no es vigente", () => {
        const w = { id: "wQuitado", tipo: "notas", cfg: {} }
        document.body.innerHTML = ""
        expect(pnVigente(w, pnTurno(w))).toBe(false)
    })
})

describe("mapa en rejilla", () => {
    it("elige las columnas que dan casillas más grandes sin bajar del ancho mínimo", () => {
        // 36 casillas en 1200×600: 6 columnas de 200×100, como la rejilla de referencia.
        expect(pnRejillaColumnas(36, 1200, 600)).toBe(6)
        // Un solo activo ocupa todo el ancho.
        expect(pnRejillaColumnas(1, 800, 400)).toBe(1)
        // En un lienzo estrecho nunca baja de PN_REJILLA_ANCHO_MIN por casilla.
        const cols = pnRejillaColumnas(40, 500, 300)
        expect(500 / cols).toBeGreaterThanOrEqual(PN_REJILLA_ANCHO_MIN)
        // Muchos activos en un widget estrecho: no caben sin desplazar, y aun así
        // reparte en columnas en vez de una sola de casillas estiradas.
        expect(pnRejillaColumnas(32, 900, 670)).toBe(5)
    })

    it("ordena como el selector: por secciones y, dentro, como la lista", () => {
        const posicion = pnOrdenSelector([
            { id: "btc", conPosicion: true },
            { id: "sinPos", conPosicion: false },
            { id: "eth", conPosicion: true },
            { id: "wl:x", watchlist: true },
            { id: "tk|A", ticker: true },
            // Repetido (el widget añade sus activos detrás de la lista): manda el primero.
            { id: "btc", conPosicion: true }
        ])
        expect([...posicion.keys()]).toEqual(["btc", "eth", "sinPos", "wl:x", "tk|A"])
    })

    it("rotula con el nombre del activo salvo que se elija el símbolo", () => {
        expect(pnRotuloPorNombre({})).toBe(true)
        expect(pnRotuloPorNombre({ etiqueta: "simbolo" })).toBe(false)
        expect(pnRotuloPorNombre({ etiqueta: "otra" })).toBe(true)
    })

    it("la forma por defecto es la rejilla y solo admite las conocidas", () => {
        expect(pnFormaMapa({})).toBe("rejilla")
        expect(pnFormaMapa({ forma: "treemap" })).toBe("treemap")
        expect(pnFormaMapa({ forma: "otra" })).toBe("rejilla")
    })

    function casilla(precio) {
        const el = document.createElement("div")
        el.innerHTML = `<span class="pnRjExt" data-ext="max"></span><span class="pnRjExt" data-ext="min"></span>`
        el._pn = { precio, currency: "EUR" }
        return el
    }

    it("lleva el máximo y el mínimo de la línea a la escala del precio", () => {
        // La línea va de 50 a 40 y acaba en 45; el precio mostrado es 90.
        const el = casilla(90)
        pnRejillaExtremos(el, [
            [1, 50],
            [2, 40],
            [3, 45]
        ])
        const [max, min] = el.querySelectorAll(".pnRjExt")
        expect(max.textContent).toBe(`H ${hmFormatPrice(100, "EUR")}`)
        expect(min.textContent).toBe(`L ${hmFormatPrice(80, "EUR")}`)
        expect(max.classList.contains("pnRjCerca")).toBe(false)
    })

    it("resalta el extremo que está tocando el precio", () => {
        // La línea acaba en su mínimo: el precio está en el mínimo del día.
        const el = casilla(30)
        pnRejillaExtremos(el, [
            [1, 50],
            [2, 45]
        ])
        const min = el.querySelector('[data-ext="min"]')
        const max = el.querySelector('[data-ext="max"]')
        expect(min.textContent).toBe(`L ${hmFormatPrice(30, "EUR")}`)
        expect(min.classList.contains("pnRjCerca")).toBe(true)
        expect(max.classList.contains("pnRjCerca")).toBe(false)
    })

    it("sin serie deja los huecos vacíos", () => {
        const el = casilla(10)
        el.querySelector(".pnRjExt").textContent = "viejo"
        pnRejillaExtremos(el, undefined)
        expect([...el.querySelectorAll(".pnRjExt")].every((h) => h.textContent === "")).toBe(true)
    })
})

describe("mapa de mercado: la lista de Seguimiento", () => {
    beforeEach(() => {
        datos([activo("btc", { tipo: "cripto" }), activo("aapl"), activo("oculto", { oculto: true })])
        // segLoadCustomItems y buildTVSymbol los ponen seguimiento.js y assets.js, que esta prueba no carga.
        globalThis.segLoadCustomItems = () => [
            { _segId: "seguir_aapl", assetId: "aapl", nombre: "Apple" },
            { _segId: "custom_1", nombre: "Nvidia", ticker: "NVDA", tipo: "acciones" },
            { _segId: "seguir_borrado", assetId: "borrado" }
        ]
        globalThis.buildTVSymbol = (a) => a.marketSymbol || ""
    })

    afterEach(() => {
        delete globalThis.segLoadCustomItems
        delete globalThis.buildTVSymbol
    })

    it("sigue el orden de la lista y dice de dónde sale cada activo", () => {
        const seguidos = pnActivosSeguimiento()

        expect(seguidos.map((a) => [a.id, a.origen])).toEqual([
            ["aapl", "Portfolio"],
            ["wl:custom_1", "Nuevo"]
        ])
        expect(seguidos.every((a) => pnGrupoSelector(a) === "Seguimiento")).toBe(true)
        // Copias: el activo de la cartera no queda marcado como seguido.
        expect(_pnDatos.porId.get("aapl").seguido).toBeUndefined()
    })

    it("sin activos elegidos, el mapa de mercado parte de Seguimiento", () => {
        const items = pnActivosDelWidget({}, { soloPosiciones: false, porDefecto: pnActivosSeguimiento() })
        expect(items.map((a) => a.id)).toEqual(["aapl", "wl:custom_1"])

        const elegidos = pnActivosDelWidget(
            { activos: ["btc"] },
            { soloPosiciones: false, porDefecto: pnActivosSeguimiento() }
        )
        expect(elegidos.map((a) => a.id)).toEqual(["btc"])
    })

    it("el selector del de mercado empieza por Seguimiento y no repite", () => {
        const opciones = pnOpcionesMapa({}, true)
        const ids = opciones.map((a) => a.id)

        expect(ids.slice(0, 2)).toEqual(["aapl", "wl:custom_1"])
        expect(new Set(ids).size).toBe(ids.length)
        expect(ids).toContain("btc")
        expect(ids).not.toContain("oculto")
        // El de la cuenta no cambia.
        expect(pnOpcionesMapa({}, false).some((a) => a.seguido)).toBe(false)
    })
})
