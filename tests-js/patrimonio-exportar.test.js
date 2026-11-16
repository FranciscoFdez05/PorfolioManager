// Pruebas de las piezas nuevas del frontend: Patrimonio (js/finanzas/patrimonio.js),
// el selector de exportación CSV (js/ajustes/ajustes-exportar-csv.js) y la tabla
// del simulador de hipotecas (js/finanzas/hipotecas.js).
//
// El cálculo vive en el servidor; aquí se comprueba lo que decide el cliente:
// qué filas se pintan, que el texto del usuario se escape y que el enlace de
// descarga no apunte a una URL que dará un 400.
import { beforeAll, beforeEach, describe, expect, it } from "vitest"

import { cargarScript } from "./cargar.js"

beforeAll(() => {
    cargarScript("js/core/dom.js")
    cargarScript("js/core/shared-utils.js")
    cargarScript("js/finanzas/prestamos-comun.js")
    cargarScript("js/finanzas/patrimonio.js")
    cargarScript("js/finanzas/hipotecas.js")
    cargarScript("js/ajustes/ajustes-exportar-csv.js")
})

const lado = (grupos) => ({
    total: grupos.reduce((suma, [, partidas]) => suma + partidas.reduce((s2, p) => s2 + p.importe, 0), 0),
    grupos: grupos.map(([grupo, partidas]) => ({
        grupo,
        total: partidas.reduce((suma, p) => suma + p.importe, 0),
        partidas
    }))
})

const paginaPatrimonio = () => {
    document.body.innerHTML = `<div id="patrimonioTotales"></div><p id="patrimonioAvisos" class="hidden"></p>
        <div id="patrimonioBarraActivos"></div><ul id="patrimonioLeyendaActivos"></ul>
        <div id="patrimonioBarraPasivos"></div><ul id="patrimonioLeyendaPasivos"></ul>
        <span id="patrimonioActivosTotal"></span><div id="patrimonioActivosLista"></div>
        <span id="patrimonioPasivosTotal"></span><div id="patrimonioPasivosLista"></div>
        <p id="patrimonioPasivosVacio" class="hidden"></p>`
}

describe("patrimonio", () => {
    beforeEach(paginaPatrimonio)

    it("el porcentaje solo existe con un total positivo", () => {
        expect(patrimonioPorcentaje(25, 100)).toBe(25)
        expect(patrimonioPorcentaje(25, 0)).toBe(0)
        expect(patrimonioPorcentaje(25, -10)).toBe(0)
    })

    it("traduce el grupo y deja tal cual uno desconocido", () => {
        expect(patrimonioEtiqueta("rentaFija")).toBe("Renta fija y bonos")
        expect(patrimonioEtiqueta("otro")).toBe("otro")
        expect(patrimonioColor("cuentas")).toBe("patrimonioColor1")
        expect(patrimonioColor("otro")).toBe("patrimonioColor6")
    })

    it("no pinta los grupos sin partidas y ordena las partidas de mayor a menor", () => {
        patrimonioPintarLado(
            "patrimonioActivosLista",
            "patrimonioActivosTotal",
            lado([["inversiones", []], ["cuentas", [{ nombre: "Pequeña", importe: 10 }, { nombre: "Grande", importe: 90 }]]])
        )
        const html = document.getElementById("patrimonioActivosLista").innerHTML
        expect(html).toContain("Cuentas")
        expect(html).not.toContain("Inversiones")
        expect(html.indexOf("Grande")).toBeLessThan(html.indexOf("Pequeña"))
    })

    it("resume en una línea las partidas a cero y no les da fila propia", () => {
        patrimonioPintarLado(
            "patrimonioActivosLista",
            "patrimonioActivosTotal",
            lado([["cuentas", [{ nombre: "Con saldo", importe: 50 }, { nombre: "Vacía A", importe: 0 }, { nombre: "Vacía B", importe: 0 }]]])
        )
        const lista = document.getElementById("patrimonioActivosLista")
        expect(lista.querySelectorAll(".patrimonioPartida")).toHaveLength(1)
        expect(lista.querySelector(".patrimonioCeros").textContent).toBe("2 partidas a cero")
        expect(lista.querySelector(".patrimonioCeros").getAttribute("title")).toBe("Vacía A, Vacía B")
    })

    it("escapa el nombre de una partida", () => {
        patrimonioPintarLado(
            "patrimonioActivosLista",
            "patrimonioActivosTotal",
            lado([["cuentas", [{ nombre: "<img src=x onerror=1>", importe: 5 }]]])
        )
        const lista = document.getElementById("patrimonioActivosLista")
        // El texto se escapa: no nace ningún elemento y el nombre se ve como texto.
        expect(lista.querySelector("img")).toBeNull()
        expect(lista.querySelector(".patrimonioPartidaNombre").textContent).toBe("<img src=x onerror=1>")
    })

    it("la barra reparte por importes positivos y un descubierto no resta espacio", () => {
        patrimonioPintarBarra(
            "patrimonioBarraActivos",
            "patrimonioLeyendaActivos",
            lado([
                ["inversiones", [{ nombre: "A", importe: 75 }]],
                ["cuentas", [{ nombre: "B", importe: 25 }, { nombre: "Descubierto", importe: -500 }]],
                ["rentaFija", [{ nombre: "C", importe: 0 }]]
            ])
        )
        const segmentos = [...document.querySelectorAll("#patrimonioBarraActivos .patrimonioSegmento")]
        // El descubierto no cuenta: cuentas pesa 25 de 100, y rentaFija (0) no ocupa barra.
        expect(segmentos.map((s) => s.style.width)).toEqual(["75%", "25%"])
        expect(document.querySelectorAll("#patrimonioLeyendaActivos li")).toHaveLength(3)
    })

    it("una partida negativa va sin porcentaje ni barra y las positivas no pasan del 100 %", () => {
        patrimonioPintarLado(
            "patrimonioActivosLista",
            "patrimonioActivosTotal",
            lado([["cuentas", [{ nombre: "Con saldo", importe: 100 }, { nombre: "Descubierto", importe: -40 }]]])
        )
        const filas = [...document.querySelectorAll("#patrimonioActivosLista .patrimonioPartida")]
        const descubierto = filas.find((f) => f.textContent.includes("Descubierto"))
        expect(descubierto.classList.contains("negativa")).toBe(true)
        expect(descubierto.querySelector(".patrimonioPartidaPct").textContent).toBe("")
        expect(descubierto.querySelector(".patrimonioPartidaBarra span").style.width).toBe("0%")
        const conSaldo = filas.find((f) => f.textContent.includes("Con saldo"))
        expect(conSaldo.querySelector(".patrimonioPartidaPct").textContent).toContain("100,00")
    })

    it("sin datos la barra lo dice en vez de quedarse vacía", () => {
        patrimonioPintarBarra("patrimonioBarraPasivos", "patrimonioLeyendaPasivos", lado([]))
        expect(document.getElementById("patrimonioBarraPasivos").textContent).toContain("Sin datos")
    })

    it("pinta las cuatro tarjetas, el endeudamiento y los avisos", () => {
        patrimonioPintar({
            neto: 300,
            activos: lado([["cuentas", [{ nombre: "A", importe: 500 }]]]),
            pasivos: lado([["hipotecas", [{ nombre: "Casa", importe: 200 }]]]),
            avisos: ["Casa: datos incompletos"]
        })
        expect(document.querySelectorAll("#patrimonioTotales .patrimonioCard")).toHaveLength(4)
        expect(document.querySelector(".patrimonioCardNeto").classList.contains("positivo")).toBe(true)
        expect(document.getElementById("patrimonioTotales").textContent).toContain("40,00")
        expect(document.getElementById("patrimonioAvisos").classList.contains("hidden")).toBe(false)
        expect(document.getElementById("patrimonioAvisos").textContent).toContain("Casa: datos incompletos")
        expect(document.getElementById("patrimonioPasivosVacio").classList.contains("hidden")).toBe(true)
    })

    it("sin deudas se muestra el aviso de que no hay y el endeudamiento es cero", () => {
        patrimonioPintar({
            neto: 500,
            activos: lado([["cuentas", [{ nombre: "A", importe: 500 }]]]),
            pasivos: lado([]),
            avisos: []
        })
        expect(document.getElementById("patrimonioPasivosVacio").classList.contains("hidden")).toBe(false)
        expect(document.getElementById("patrimonioTotales").textContent).toContain("0,00")
    })

    it("sin activos el endeudamiento no se inventa", () => {
        patrimonioPintar({ neto: -50, activos: lado([]), pasivos: lado([["hipotecas", [{ nombre: "Casa", importe: 50 }]]]), avisos: [] })
        expect(document.querySelector(".patrimonioCardNeto").classList.contains("negativo")).toBe(true)
        expect(document.getElementById("patrimonioTotales").textContent).toContain("—")
    })
})

describe("exportar CSV", () => {
    beforeEach(() => {
        document.body.innerHTML = `<select id="ajustesExportarModulo">
                <option value="gastos">g</option><option value="dividendos">d</option></select>
            <select id="ajustesExportarAnio"></select><a id="ajustesExportarCsvBtn" href="#"></a>`
    })

    it("los módulos por año llevan ?anio= y los demás no", () => {
        expect(exportarCsvUrl("gastos", "2026")).toBe("/api/exportar/gastos.csv?anio=2026")
        expect(exportarCsvUrl("dividendos", "2026")).toBe("/api/exportar/dividendos.csv")
    })

    it("sin año válido el enlace queda deshabilitado", () => {
        _initAjustesExportarCsv()
        const anio = document.getElementById("ajustesExportarAnio")
        const enlace = document.getElementById("ajustesExportarCsvBtn")

        anio.value = "20"
        anio.dispatchEvent(new Event("change"))
        expect(enlace.getAttribute("aria-disabled")).toBe("true")

        const anioPrevio = String(new Date().getFullYear() - 1)
        anio.value = anioPrevio
        anio.dispatchEvent(new Event("change"))
        expect(enlace.getAttribute("aria-disabled")).toBe("false")
        expect(enlace.getAttribute("href")).toBe(`/api/exportar/gastos.csv?anio=${anioPrevio}`)
    })

    it("un módulo sin año oculta el campo y no lo exige", () => {
        _initAjustesExportarCsv()
        const select = document.getElementById("ajustesExportarModulo")
        select.value = "dividendos"
        select.dispatchEvent(new Event("change"))

        const anio = document.getElementById("ajustesExportarAnio")
        const caja = anio.closest(".csWrapper") || anio
        expect(caja.classList.contains("hidden")).toBe(true)
        expect(document.getElementById("ajustesExportarCsvBtn").getAttribute("aria-disabled")).toBe("false")
    })
})

describe("simulador de hipotecas", () => {
    const escenario = (cambios) => ({
        cuotaTrasElPago: 800,
        cuotasRestantes: 120,
        fechaFin: "2036-01-01",
        interesesPendientes: 1000,
        ahorroIntereses: 0,
        mesesAhorrados: 0,
        ...cambios
    })

    it("compara los tres escenarios y deja vacío el ahorro del actual", () => {
        const html = hipotecasSimuladorFilas({
            actual: escenario({}),
            plazo: escenario({ cuotasRestantes: 100, ahorroIntereses: 250, mesesAhorrados: 20 }),
            cuota: escenario({ cuotaTrasElPago: 700, ahorroIntereses: 90 })
        })
        document.body.innerHTML = `<table><tbody>${html}</tbody></table>`
        const filas = [...document.querySelectorAll("tr")].map((tr) => [...tr.children].map((td) => td.textContent))

        expect(filas).toHaveLength(6)
        expect(filas[4][0]).toBe("Intereses ahorrados")
        expect(filas[4][1]).toBe("")
        expect(filas[5].slice(2)).toEqual(["20", "0"])
    })
})
