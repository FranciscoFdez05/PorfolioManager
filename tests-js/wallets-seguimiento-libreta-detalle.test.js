// Libreta de Cripto › Seguimiento: cada fila es un resumen que se despliega para
// enseñar el detalle y las acciones de esa dirección.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { runInThisContext } from "node:vm"

import { cargarModulo, cargarScript } from "./cargar.js"

const global = (expresion) => runInThisContext(expresion)

const DIRECCION = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/cripto/wallets.js")
    cargarModulo("js/cripto/wallets-seguimiento.js")
    // jsdom no implementa el scroll.
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
    const estado = global("walletsEstado")
    estado.redes = [{ clave: "btc", nombre: "Bitcoin", simbolo: "BTC" }]
    estado.direcciones = [{ red: "btc", direccion: DIRECCION, apodo: "Fría", propia: true }]
    estado.direccionesEnlazadas = [
        { walletId: "w-1", red: "btc", valorEnmascarado: "bc1qaaaa…1111", apodo: "Ledger" },
        { walletId: "w-2", red: "btc", valorEnmascarado: "bc1qbbbb…2222", apodo: "Trezor", clave: "w-2#0", derivada: true },
        { walletId: "w-2", red: "btc", valorEnmascarado: "bc1qcccc…3333", apodo: "Trezor", clave: "w-2#1", derivada: true }
    ]
    estado.wallets = [
        {
            id: "w-1",
            alias: "Ledger",
            red: "btc",
            tipo: "direccion",
            seguimiento: "Ledger",
            seguimientoClave: "ledger",
            propia: true,
            saldo: "0.5",
            saldoFecha: "2026-11-05T10:00:00Z",
            valorEur: "30000",
            avisos: true,
            ultimoError: "Esplora no responde",
            ultimoErrorFecha: "2026-11-05T11:00:00Z",
            recientes: [{ tipo: "enviada", cantidad: "0.1", simbolo: "BTC", fecha: "2026-11-04T09:00:00Z" }]
        },
        { id: "w-2", alias: "Trezor", red: "btc", tipo: "xpub", seguimiento: "Trezor", seguimientoClave: "trezor", propia: true, recientes: [] }
    ]
})

afterEach(() => {
    window.cerrarLibretaSeguimiento()
})

const filas = () => [...document.querySelectorAll("#walletsSegDirOverlay .walletsSegDirFila")]
const pulsarResumen = (indice) => filas()[indice].querySelector(".walletsSegDirResumen").click()

describe("fila plegada", () => {
    it("resume la dirección y el saldo sin enseñar las acciones", () => {
        window.abrirLibretaSeguimiento()
        const ledger = filas()[1]
        expect(ledger.textContent).toContain("Ledger")
        expect(ledger.textContent).toContain("0,5 BTC")
        expect(ledger.querySelector(".walletsSegDirDetalle")).toBeNull()
        expect(ledger.querySelector(".walletsSegDirResumen").getAttribute("aria-expanded")).toBe("false")
    })

    it("abrevia las direcciones marcadas a mano", () => {
        window.abrirLibretaSeguimiento()
        expect(filas()[0].querySelector(".walletsSegDirResumen").textContent).not.toContain(DIRECCION)
    })

    it("no anida botones dentro del resumen", () => {
        window.abrirLibretaSeguimiento()
        expect(document.querySelector(".walletsSegDirResumen button")).toBeNull()
    })

    it("no pinta importe en una marcada cuyo saldo aún no se ha consultado", () => {
        const entrada = window.walletsSegDirEntradas()[0]
        expect(window.walletsSegDirImporteHtml(entrada)).toBe("")
    })

    it("una wallet sin leer lo dice en vez de enseñar cero", () => {
        global("walletsEstado").wallets[0].saldoFecha = ""
        const enlazada = window.walletsSegDirEntradas()[1]
        expect(window.walletsSegDirImporteHtml(enlazada)).toContain("Sin leer")
    })
})

describe("desplegar una fila", () => {
    it("enseña los datos, las alertas, los movimientos y las acciones de la wallet", () => {
        window.abrirLibretaSeguimiento()
        pulsarResumen(1)
        const detalle = filas()[1].querySelector(".walletsSegDirDetalle")
        expect(detalle.textContent).toContain("Dirección")
        expect(detalle.textContent).toContain("Avisos")
        expect(detalle.textContent).toContain("Activados")
        expect(detalle.textContent).toContain("Esplora no responde")
        expect(detalle.textContent).toContain("0,1 BTC")
        expect(detalle.textContent).toContain("Sacar del seguimiento")
        expect(filas()[1].querySelector(".walletsSegDirResumen").getAttribute("aria-expanded")).toBe("true")
    })

    it("en una marcada a mano enseña la dirección entera y copiable", () => {
        window.abrirLibretaSeguimiento()
        pulsarResumen(0)
        const copiable = filas()[0].querySelector(".walletsSegDirDetalle .walletsSegCopiable")
        expect(copiable.dataset.fullValue).toBe(DIRECCION)
    })

    it("la pestaña Direcciones lista enmascaradas solo las derivadas del seguimiento, con su número", () => {
        document.body.innerHTML = window.walletsSegDerivadasHtml({ wallets: [{ id: "w-2" }] })
        const valores = [...document.querySelectorAll(".walletsSegDerivadaValor")].map((nodo) => nodo.textContent)
        expect(valores).toEqual(["bc1qbbbb…2222", "bc1qcccc…3333"])
        expect(document.querySelector(".walletsSegDerivadas .walletsSegContador").textContent).toBe("2")
    })

    it("la pestaña Direcciones no pinta el apartado si el seguimiento no tiene derivadas", () => {
        expect(window.walletsSegDerivadasHtml({ wallets: [{ id: "w-1" }] })).toBe("")
    })

    it("dos direcciones derivadas de la misma wallet se despliegan por separado", () => {
        window.abrirLibretaSeguimiento()
        pulsarResumen(2)
        expect(filas()[2].querySelector(".walletsSegDirDetalle")).not.toBeNull()
        expect(filas()[3].querySelector(".walletsSegDirDetalle")).toBeNull()
    })

    it("solo deja una abierta y se pliega al volver a pulsarla", () => {
        window.abrirLibretaSeguimiento()
        pulsarResumen(0)
        pulsarResumen(1)
        expect(document.querySelectorAll(".walletsSegDirDetalle")).toHaveLength(1)
        expect(filas()[1].querySelector(".walletsSegDirDetalle")).not.toBeNull()
        pulsarResumen(1)
        expect(document.querySelectorAll(".walletsSegDirDetalle")).toHaveLength(0)
    })

    it("devuelve el foco al resumen pulsado tras repintar", () => {
        window.abrirLibretaSeguimiento()
        pulsarResumen(1)
        expect(document.activeElement).toBe(filas()[1].querySelector(".walletsSegDirResumen"))
    })

    it("sobrevive a la búsqueda mientras la fila siga en la lista", () => {
        window.abrirLibretaSeguimiento()
        pulsarResumen(1)
        const buscar = document.querySelector(".walletsSegDirBuscar")
        buscar.value = "Ledger"
        buscar.dispatchEvent(new window.Event("input", { bubbles: true }))
        expect(filas()).toHaveLength(1)
        expect(filas()[0].querySelector(".walletsSegDirDetalle")).not.toBeNull()
        buscar.value = ""
        buscar.dispatchEvent(new window.Event("input", { bubbles: true }))
    })

    it("al plegar descarta el formulario que estuviera a medias", () => {
        window.abrirLibretaSeguimiento()
        pulsarResumen(1)
        filas()[1].querySelector(".walletsSegDirSacarBtn").click()
        expect(filas()[1].querySelector(".walletsSegDirSacarForm")).not.toBeNull()
        pulsarResumen(1)
        pulsarResumen(1)
        expect(filas()[1].querySelector(".walletsSegDirSacarForm")).toBeNull()
        expect(filas()[1].querySelector(".walletsSegDirSacarBtn")).not.toBeNull()
    })

    it("no conserva la fila abierta al cerrar la ventana", () => {
        window.abrirLibretaSeguimiento()
        pulsarResumen(1)
        window.cerrarLibretaSeguimiento()
        window.abrirLibretaSeguimiento()
        expect(document.querySelectorAll(".walletsSegDirDetalle")).toHaveLength(0)
    })
})

describe("peso visual de las acciones", () => {
    it("marca la acción principal y la destructiva", () => {
        const enlazada = window.walletsSegDirEntradas()[1]
        const contenedor = document.createElement("div")
        contenedor.innerHTML = window.walletsSegDirAccionesHtml(enlazada)
        expect(contenedor.querySelector(".walletsSegDirVerSeguimientoBtn").classList).toContain("walletsSegDirAccion-principal")
        expect(contenedor.querySelector(".walletsSegDirSacarBtn").classList).toContain("walletsSegDirAccion-peligro")
    })

    it("escapa los datos del botón", () => {
        const html = window.walletsSegDirBotonHtml({ clase: "x", icono: "ver", texto: "<b>" })
        expect(html).toContain("&lt;b&gt;")
        expect(html).not.toContain("<b>")
    })
})
