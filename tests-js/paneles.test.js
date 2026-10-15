// Activos > Paneles: las piezas que no dependen de la pantalla.
//
// La pantalla se prueba a mano y con capturas; aquí van las funciones por las
// que entra lo que no controla la aplicación —lo guardado en el servidor, un
// fichero importado que pudo editar cualquiera, los tickers que devuelve
// TradingView, los textos de variación de cada proveedor— y las que deciden qué
// activos ve cada widget. Un fallo en ellas no se ve como un error: se ve como
// un panel que se queda vacío o enseña otra cosa.
import { beforeAll, beforeEach, describe, expect, it } from "vitest"
import { cargarScript } from "./cargar.js"

beforeAll(() => {
    // Chart.js lo carga la página desde vendor; paneles.js solo lo usa al pintar.
    globalThis.Chart = class {}
    // jsdom no trae CSS.escape (los navegadores, sí).
    globalThis.CSS ??= { escape: (t) => String(t).replace(/["\\]/g, "\\$&") }
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/analisis/heatmap.js")
    cargarScript("js/analisis/sentimiento.js")
    cargarScript("js/cartera/paneles.js")
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
