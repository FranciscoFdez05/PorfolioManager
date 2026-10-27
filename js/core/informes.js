// Informes en PDF: el del portfolio (menú ··· de la Vista general) y el de
// finanzas (menús ··· de Gastos, Ingresos, Cuentas y Cuenta remunerada, que
// sacan todos el mismo informe).
//
// Se maqueta en HTML, html2canvas lo fotografía y jsPDF lo parte en hojas A4 y
// lo descarga directamente, sin pasar por el diálogo de imprimir (las dos
// librerías están en js/vendor/). Los gráficos son SVG dibujados aquí, no los
// canvas de Chart.js, que llevan el fondo oscuro de la app.
//
// Las cifras salen de las mismas funciones que pintan la Vista general y
// Métricas (buildOverviewRow, mComputeGastosData…), para que el informe cuadre
// con lo que se ve en pantalla.

const INF_MESES = [
    "Enero",
    "Febrero",
    "Marzo",
    "Abril",
    "Mayo",
    "Junio",
    "Julio",
    "Agosto",
    "Septiembre",
    "Octubre",
    "Noviembre",
    "Diciembre"
]

// Colores de las categorías de gastos e ingresos, que no tienen uno propio.
const INF_PALETA = [
    "#3a7bd5",
    "#f7931a",
    "#2ecc71",
    "#e74c3c",
    "#9b59b6",
    "#1abc9c",
    "#e67e22",
    "#00bcd4",
    "#8bc34a",
    "#ff5722",
    "#e91e63",
    "#673ab7",
    "#607d8b",
    "#f39c12",
    "#795548",
    "#26c6da"
]

// ── utilidades ─────────────────────────────────────────────────────────────

const infEsc = (valor) => escapeHtml(valor)

async function infGet(url, fallback) {
    try {
        const res = await fetch(url)
        return res.ok ? await res.json() : fallback
    } catch {
        return fallback
    }
}

// Fechas de la app: "dd-mm-aaaa", "dd-mm-aa" o "aaaa-mm-dd".
function infFecha(texto) {
    const p = String(texto || "")
        .trim()
        .split(/[-/.]/)
    if (p.length !== 3 || p.some((x) => !/^\d+$/.test(x))) return null
    const [d, m, y] = p[0].length === 4 ? [p[2], p[1], p[0]] : p
    const anio = y.length <= 2 ? 2000 + Number(y) : Number(y)
    return { anio, mes: Number(m), dia: Number(d), orden: anio * 10000 + Number(m) * 100 + Number(d) }
}

const infAnio = (texto) => infFecha(texto)?.anio ?? null

const infSigno = (v) => (v > 0 ? "+" : "")
const infClase = (v) => (v > 0 ? "infPos" : v < 0 ? "infNeg" : "")
const infEur = (v) => formatEuro(v || 0)
const infEurSigno = (v) => `<span class="${infClase(v)}">${infSigno(v)}${infEur(v)}</span>`
const infPct = (v) => (Number.isFinite(v) ? `${v.toFixed(2).replace(".", ",")} %` : "—")
const infPctSigno = (v) => (Number.isFinite(v) ? `<span class="${infClase(v)}">${infSigno(v)}${infPct(v)}</span>` : "—")

function infHoy() {
    return new Date().toLocaleString("es-ES", { dateStyle: "long", timeStyle: "short" })
}

// ── piezas de maquetación ──────────────────────────────────────────────────

function infCabecera(titulo, subtitulo) {
    return `
        <header class="infCabecera">
            <div>
                <h1>${infEsc(titulo)}</h1>
                <p>${infEsc(subtitulo)}</p>
            </div>
            <div class="infCabeceraFecha">Generado el ${infEsc(infHoy())}</div>
        </header>`
}

function infKpis(items) {
    return `<div class="infKpis">${items
        .map(
            (k) => `
            <div class="infKpi">
                <span class="infKpiLabel">${infEsc(k.label)}</span>
                <span class="infKpiValor">${k.valor}</span>
                ${k.nota ? `<span class="infKpiNota">${k.nota}</span>` : ""}
            </div>`
        )
        .join("")}</div>`
}

function infSeccion(titulo, contenido, nota = "") {
    if (!contenido) return ""
    return `
        <section class="infSeccion">
            <h2>${infEsc(titulo)}</h2>
            ${nota ? `<p class="infNota">${nota}</p>` : ""}
            ${contenido}
        </section>`
}

// columnas: [{ label, num }] — `num` alinea a la derecha. filas: celdas ya en HTML.
function infTabla(columnas, filas, totales = null) {
    if (!filas.length) return ""
    const th = columnas.map((c) => `<th${c.num ? ' class="num"' : ""}>${infEsc(c.label)}</th>`).join("")
    const fila = (celdas, cls = "") =>
        `<tr${cls ? ` class="${cls}"` : ""}>${celdas
            .map((celda, i) => `<td${columnas[i]?.num ? ' class="num"' : ""}>${celda ?? ""}</td>`)
            .join("")}</tr>`
    return `
        <table class="infTabla">
            <thead><tr>${th}</tr></thead>
            <tbody>${filas.map((f) => fila(f)).join("")}</tbody>
            ${totales ? `<tfoot>${fila(totales, "infTotal")}</tfoot>` : ""}
        </table>`
}

// Gráfico circular con su leyenda: cada nombre lleva al lado su % y su importe.
// items: [{ label, valor, color }]. Los valores negativos no caben en un
// circular: se dejan fuera del dibujo pero siguen en la leyenda.
function infDonut(items, { titulo = "", columnasLeyenda = 1 } = {}) {
    const datos = items.filter((i) => Number.isFinite(i.valor) && i.valor !== 0)
    const total = datos.reduce((s, i) => s + Math.max(0, i.valor), 0)
    if (!datos.length || total <= 0) return ""

    const R = 80
    const r = 50
    const c = 90
    let angulo = -Math.PI / 2
    const punto = (radio, a) => `${(c + radio * Math.cos(a)).toFixed(3)} ${(c + radio * Math.sin(a)).toFixed(3)}`
    const porciones = datos
        .filter((i) => i.valor > 0)
        .map((i) => {
            const fraccion = i.valor / total
            // Un único sector del 100 % no se puede dibujar como arco: es un anillo.
            if (fraccion >= 0.9999) {
                return `<circle cx="${c}" cy="${c}" r="${(R + r) / 2}" fill="none" stroke="${i.color}" stroke-width="${R - r}"/>`
            }
            const inicio = angulo
            const fin = angulo + fraccion * Math.PI * 2
            angulo = fin
            const grande = fin - inicio > Math.PI ? 1 : 0
            return `<path d="M ${punto(R, inicio)} A ${R} ${R} 0 ${grande} 1 ${punto(R, fin)} L ${punto(r, fin)} A ${r} ${r} 0 ${grande} 0 ${punto(r, inicio)} Z" fill="${i.color}" stroke="#fff" stroke-width="1"/>`
        })
        .join("")

    const leyenda = datos
        .map(
            (i) => `
            <div class="infLeyendaItem">
                <span class="infMuestra" style="background:${i.color}"></span>
                <span class="infLeyendaNombre">${infEsc(i.label)}</span>
                <span class="infLeyendaPct">${i.valor > 0 ? infPct((i.valor / total) * 100) : "—"}</span>
                <span class="infLeyendaValor">${infEur(i.valor)}</span>
            </div>`
        )
        .join("")

    return `
        <div class="infGrafico">
            ${titulo ? `<h3>${infEsc(titulo)}</h3>` : ""}
            <div class="infDonut">
                <svg viewBox="0 0 180 180" width="120" height="120" role="img" aria-label="${infEsc(titulo)}">
                    ${porciones}
                    <text x="${c}" y="${c - 4}" text-anchor="middle" fill="#64748b" font-size="9" font-family="Segoe UI, Roboto, Arial, sans-serif">Total</text>
                    <text x="${c}" y="${c + 12}" text-anchor="middle" fill="#0f172a" font-size="11" font-weight="700" font-family="Segoe UI, Roboto, Arial, sans-serif">${infEsc(infEur(total))}</text>
                </svg>
                <div class="infLeyenda" style="--inf-cols:${columnasLeyenda}">${leyenda}</div>
            </div>
        </div>`
}

// Dos circulares en la misma fila solo si sus leyendas caben a la altura del
// dibujo; si una es más larga, el de al lado dejaría un hueco en blanco debajo,
// así que cada uno va en su fila y la leyenda larga se reparte en columnas.
const INF_LEYENDA_CORTA = 8

function infFilaDonuts(graficos) {
    const contar = (items) => items.filter((i) => Number.isFinite(i.valor) && i.valor !== 0).length
    const apilados = graficos.some((g) => contar(g.items) > INF_LEYENDA_CORTA)
    const html = graficos
        .map((g) => {
            const n = contar(g.items)
            const columnasLeyenda = !apilados ? 1 : n > 40 ? 3 : n > INF_LEYENDA_CORTA ? 2 : 1
            return infDonut(g.items, { titulo: g.titulo, columnasLeyenda })
        })
        .join("")
    return `<div class="infGraficosFila${apilados ? " infGraficosApilados" : ""}">${html}</div>`
}

// Barras agrupadas por mes (p. ej. ingresos frente a gastos).
// series: [{ label, color, valores: [12] }]
function infBarrasMensuales(series) {
    const max = Math.max(0, ...series.flatMap((s) => s.valores))
    if (max <= 0) return ""
    const ancho = 720
    const alto = 200
    const base = alto - 22
    const grupo = ancho / 12
    const barra = Math.min(18, (grupo - 10) / series.length)
    const rects = INF_MESES.map((mes, m) => {
        const x0 = m * grupo + (grupo - barra * series.length) / 2
        const barras = series
            .map((s, i) => {
                const v = Math.max(0, s.valores[m] || 0)
                const h = (v / max) * (base - 10)
                return `<rect x="${(x0 + i * barra).toFixed(1)}" y="${(base - h).toFixed(1)}" width="${(barra - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${s.color}"/>`
            })
            .join("")
        return `${barras}<text x="${(m * grupo + grupo / 2).toFixed(1)}" y="${alto - 6}" text-anchor="middle" fill="#64748b" font-size="11" font-family="Segoe UI, Roboto, Arial, sans-serif">${mes.slice(0, 3)}</text>`
    }).join("")
    const leyenda = series
        .map(
            (s) =>
                `<span class="infLeyendaItem"><span class="infMuestra" style="background:${s.color}"></span>${infEsc(s.label)}</span>`
        )
        .join("")
    return `
        <div class="infGrafico">
            <svg viewBox="0 0 ${ancho} ${alto}" width="100%" role="img" aria-label="Evolución mensual">
                <line x1="0" y1="${base}" x2="${ancho}" y2="${base}" stroke="#cbd5e1" stroke-width="1"/>
                ${rects}
            </svg>
            <div class="infLeyendaLinea">${leyenda}</div>
        </div>`
}

// ── PDF ────────────────────────────────────────────────────────────────────

// A4 en milímetros. El contenedor se maqueta al ancho útil de la hoja a 96 ppp
// para que el texto salga al tamaño en puntos que dice informes.css.
const INF_PAGINA = { ancho: 210, alto: 297, margenX: 10, margenY: 12, pie: 6 }
const INF_PX_POR_MM = 96 / 25.4
const INF_ESCALA = 2

// Bloques que no se deben partir entre hojas. Un corte solo puede caer en un
// hueco que no esté dentro de ninguno de ellos.
const INF_BLOQUES = ".infCabecera, .infKpis, .infGrafico, .infTabla tr, .infNota, .infPie, h2, h3"
// Bloques tras los que no se corta, para que un título no se quede solo al pie.
const INF_TITULOS = "h2, h3, .infNota, .infTabla thead tr"

// Alturas (en px del contenedor) donde se puede cortar la hoja.
function infPuntosDeCorte(contenedor) {
    const origen = contenedor.getBoundingClientRect().top
    const bloques = [...contenedor.querySelectorAll(INF_BLOQUES)].map((el) => {
        const r = el.getBoundingClientRect()
        return { arriba: r.top - origen, abajo: r.bottom - origen, titulo: el.matches(INF_TITULOS) }
    })
    const dentro = (y) => bloques.some((b) => y > b.arriba + 0.5 && y < b.abajo - 0.5)
    // Lo último que acaba por encima del corte es un título: el corte lo dejaría solo.
    const trasTitulo = (y) => {
        const previo = bloques
            .filter((b) => b.abajo <= y + 0.5)
            .reduce((a, b) => (!a || b.abajo > a.abajo ? b : a), null)
        return Boolean(previo?.titulo)
    }
    const candidatos = bloques.flatMap((b) => [b.arriba, b.abajo])
    return [...new Set(candidatos.map((y) => Math.round(y)))]
        .filter((y) => !dentro(y) && !trasTitulo(y))
        .sort((a, b) => a - b)
}

// Reparte el alto total en hojas: cada una acaba en el último corte que cabe.
// Si un bloque no cabe en una hoja entera, se corta donde se acabe la hoja.
function infRepartirHojas(altoTotal, altoHoja, cortes) {
    const hojas = []
    let y = 0
    while (y < altoTotal - 1) {
        const limite = y + altoHoja
        if (limite >= altoTotal) {
            hojas.push([y, altoTotal])
            break
        }
        const corte = cortes.filter((c) => c > y + altoHoja * 0.3 && c <= limite).pop() ?? limite
        hojas.push([y, corte])
        y = corte
    }
    return hojas
}

// html2canvas y jsPDF pesan unos 200 KB comprimidos y solo hacen falta al
// exportar un PDF: se descargan la primera vez, no en cada carga de la página.
// La CSP los admite sin nonce porque script-src incluye 'self'.
const INF_LIBRERIAS_PDF = ["js/vendor/html2canvas-pro.min.js?v=2.4.5", "js/vendor/jspdf.umd.min.js?v=4.2.1"]
let infLibreriasPdf = null

function infCargarScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement("script")
        script.src = src
        script.onload = resolve
        script.onerror = () => reject(new Error(`No se pudo cargar ${src}`))
        document.head.appendChild(script)
    })
}

// Una sola descarga aunque se pida el PDF dos veces seguidas; si falla se
// olvida la promesa para que el siguiente intento vuelva a probar.
function infCargarLibreriasPdf() {
    if (typeof html2canvas === "function" && window.jspdf?.jsPDF) return Promise.resolve()
    if (!infLibreriasPdf) {
        infLibreriasPdf = Promise.all(INF_LIBRERIAS_PDF.map(infCargarScript)).catch((error) => {
            infLibreriasPdf = null
            throw error
        })
    }
    return infLibreriasPdf
}

// Devuelve el control al navegador para que repinte (el aviso de progreso) y
// atienda la interfaz. Cada hoja pasa por una conversión a PNG de cientos de
// ms y, encadenadas sin respiro, dejaban la página congelada varios segundos.
// setTimeout y no requestAnimationFrame: este último no se dispara con la
// pestaña en segundo plano y el informe se quedaría parado a medias.
function infCederHilo() {
    return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Pinta el informe fuera de la pantalla, lo pasa a imagen y descarga el PDF.
 *
 * @param {string} html Contenido del informe ya maquetado.
 * @param {string} nombreArchivo Nombre del PDF, sin extensión.
 * @param {((texto: string) => void) | null} alProgresar Recibe el texto del
 *     paso en curso («Generando informe… página 3 de 6»).
 */
async function infDescargarPdf(html, nombreArchivo, alProgresar = null) {
    try {
        await infCargarLibreriasPdf()
    } catch (error) {
        console.error(error)
    }
    if (typeof html2canvas !== "function" || !window.jspdf?.jsPDF) {
        throw new Error("No se han cargado las librerías del PDF (js/vendor/)")
    }
    const P = INF_PAGINA
    const anchoUtil = P.ancho - 2 * P.margenX
    const altoUtil = P.alto - 2 * P.margenY - P.pie

    document.getElementById("informeImprimible")?.remove()
    const contenedor = document.createElement("div")
    contenedor.id = "informeImprimible"
    contenedor.style.width = `${Math.round(anchoUtil * INF_PX_POR_MM)}px`
    contenedor.innerHTML = html
    document.body.appendChild(contenedor)

    try {
        await document.fonts?.ready
        // html2canvas es un único bloque largo: el aviso tiene que verse antes.
        alProgresar?.("Generando informe… preparando las páginas")
        await infCederHilo()
        const cortes = infPuntosDeCorte(contenedor)
        const lienzo = await html2canvas(contenedor, {
            scale: INF_ESCALA,
            backgroundColor: "#ffffff",
            logging: false
        })

        // px del contenedor → mm de la hoja
        const mmPorPx = anchoUtil / contenedor.offsetWidth
        const hojas = infRepartirHojas(contenedor.offsetHeight, altoUtil / mmPorPx, cortes)

        const pdf = new window.jspdf.jsPDF({ unit: "mm", format: "a4", compress: true })
        pdf.setProperties({ title: nombreArchivo, creator: "PortfolioManager" })
        const trozo = document.createElement("canvas")
        const ctx = trozo.getContext("2d")

        for (const [i, [desde, hasta]] of hojas.entries()) {
            alProgresar?.(`Generando informe… página ${i + 1} de ${hojas.length}`)
            await infCederHilo()
            if (i > 0) pdf.addPage()
            const y0 = Math.round(desde * INF_ESCALA)
            const alto = Math.max(1, Math.round(hasta * INF_ESCALA) - y0)
            trozo.width = lienzo.width
            trozo.height = alto
            ctx.fillStyle = "#ffffff"
            ctx.fillRect(0, 0, trozo.width, trozo.height)
            ctx.drawImage(lienzo, 0, y0, lienzo.width, alto, 0, 0, lienzo.width, alto)
            pdf.addImage(
                trozo,
                "PNG",
                P.margenX,
                P.margenY,
                anchoUtil,
                (alto / INF_ESCALA) * mmPorPx,
                undefined,
                "FAST"
            )

            pdf.setFontSize(7)
            pdf.setTextColor(148, 163, 184)
            pdf.text(nombreArchivo, P.margenX, P.alto - P.margenY + 2)
            pdf.text(`${i + 1} / ${hojas.length}`, P.ancho - P.margenX, P.alto - P.margenY + 2, { align: "right" })
        }

        pdf.save(`${nombreArchivo}.pdf`)
    } finally {
        contenedor.remove()
    }
}

// Envuelve la generación: el botón dice que está trabajando (cargar todos los
// activos tarda) y un fallo se avisa en vez de quedarse en la consola.
// El botón queda deshabilitado mientras dura (dos informes a la vez se pisarían
// el contenedor #informeImprimible) y un aviso dice por qué hoja va: el botón
// vive en un menú ··· que se cierra al pulsarlo, así que su texto no lo ve nadie.
async function infGenerar(boton, generar) {
    if (boton?.dataset.generando) return
    const textoOriginal = boton?.textContent || ""
    if (boton) {
        boton.dataset.generando = "true"
        boton.disabled = true
        boton.textContent = "Generando informe…"
    }
    const aviso = infAbrirAvisoProgreso("Generando informe…")
    const alProgresar = (texto) => {
        if (aviso) aviso.textContent = texto
    }
    document.documentElement.style.cursor = "progress"
    try {
        await generar(alProgresar)
    } catch (error) {
        console.error("No se pudo generar el informe:", error)
        alert("No se pudo generar el informe. Revisa la consola para más detalles.")
    } finally {
        aviso?.remove()
        document.documentElement.style.cursor = ""
        if (boton) {
            delete boton.dataset.generando
            boton.disabled = false
            boton.textContent = textoOriginal
        }
    }
}

// Un aviso de los de siempre (showToast) que no se cierra solo: lo quita
// infGenerar al acabar. La duración es solo una red por si algo se colgara.
const INF_AVISO_MAX_MS = 5 * 60 * 1000

function infAbrirAvisoProgreso(texto) {
    if (typeof showToast !== "function") return null
    return showToast(texto, { duration: INF_AVISO_MAX_MS })
}

// ── informe del portfolio ──────────────────────────────────────────────────

const INF_TIPOS = ["cripto", "acciones", "etfs", "comoditis"]

async function infDatosPortfolio() {
    const assets = await loadAssetsList()
    const cargados = await Promise.allSettled(assets.map((a) => loadAssetData(a.id)))
    const completos = cargados.filter((r) => r.status === "fulfilled").map((r) => r.value)

    const resultados = await Promise.allSettled(
        completos.map(async (asset) => {
            const fila = await buildOverviewDisplayRow(asset)
            const eur = await buildSummaryMetricsInEuros(fila)
            return { ...fila, color: asset.color || "", eur }
        })
    )
    const filas = resultados.filter((r) => r.status === "fulfilled").map((r) => r.value)

    const [divData, intData, bonosData, rfData, ventas] = await Promise.all([
        infGet("/api/dividendos", { rows: [] }),
        infGet("/api/intereses", { cuentas: [] }),
        infGet("/api/bonos", { rows: [] }),
        infGet("/api/rentafija", { rows: [] }),
        loadVentasRowsForAssets().catch(() => [])
    ])

    return {
        // Activos en cartera: los que tienen posición o, sin ella, valor.
        activos: filas.filter((f) => f.participaciones > 0 || f.eur.netoActualEur > 0),
        dividendos: Array.isArray(divData?.rows) ? divData.rows : [],
        cuentasRemuneradas: Array.isArray(intData?.cuentas) ? intData.cuentas : [],
        rentaFija: [
            ...(Array.isArray(bonosData?.rows) ? bonosData.rows : []).map((r) => ({ ...r, _origen: "Bono" })),
            ...(Array.isArray(rfData?.rows) ? rfData.rows : []).map((r) => ({ ...r, _origen: "Renta fija" }))
        ],
        ventas: (Array.isArray(ventas) ? ventas : []).filter((v) => !v.incidencia)
    }
}

function infInteresNetoRF(r) {
    return parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || "")
}

function infHtmlPortfolio(datos) {
    const { activos, dividendos, cuentasRemuneradas, rentaFija, ventas } = datos
    const anioActual = new Date().getFullYear()

    const totalValor = activos.reduce((s, a) => s + a.eur.netoActualEur, 0)
    const totalInvertido = activos.reduce((s, a) => s + a.eur.invertidoBrutoEur, 0)
    const totalRend = totalValor - totalInvertido
    const rentaFijaInvertido = rentaFija.reduce((s, r) => s + parseEuroNumber(r.invertido || ""), 0)
    const rentaFijaInteres = rentaFija.reduce((s, r) => s + infInteresNetoRF(r), 0)

    const filasIntereses = cuentasRemuneradas.flatMap((c) =>
        (Array.isArray(c.rows) ? c.rows : []).map((r) => ({
            cuenta: c.nombre || "Cuenta",
            fecha: r.fecha,
            bruto: parseEuroNumber(r.acumulado || ""),
            impuestos: parseEuroNumber(r.impuestos || "")
        }))
    )
    const interesesNetos = filasIntereses.reduce((s, r) => s + r.bruto - r.impuestos, 0)
    const dividendosTotal = dividendos.reduce((s, r) => s + parseEuroNumber(r.total || ""), 0)
    const dividendosAnio = dividendos
        .filter((r) => infAnio(r.fecha) === anioActual)
        .reduce((s, r) => s + parseEuroNumber(r.total || ""), 0)
    const ganancia = (v) => parseLooseNumber(v.dineroDeclarar) || 0
    const coste = (v) => parseLooseNumber(v.costeAdquisicion ?? v.valorCompra) || 0
    const realizado = ventas.reduce((s, v) => s + ganancia(v), 0)

    const kpis = infKpis([
        { label: "Valor de la cartera", valor: infEur(totalValor) },
        { label: "Invertido", valor: infEur(totalInvertido) },
        {
            label: "Rendimiento latente",
            valor: infEurSigno(totalRend),
            nota: infPctSigno(totalInvertido > 0 ? (totalRend / totalInvertido) * 100 : NaN)
        },
        { label: "Beneficio realizado", valor: infEurSigno(realizado), nota: "Ventas (FIFO)" },
        {
            label: "Dividendos cobrados",
            valor: infEur(dividendosTotal),
            nota: `${anioActual}: ${infEur(dividendosAnio)}`
        },
        { label: "Intereses netos", valor: infEur(interesesNetos), nota: "Cuentas remuneradas" },
        {
            label: "Renta fija",
            valor: infEur(rentaFijaInvertido),
            nota: rentaFija.length ? `Intereses netos ${infEur(rentaFijaInteres)}` : ""
        },
        { label: "Activos en cartera", valor: String(activos.length) }
    ])

    // Distribución: la misma que Métricas › Distribución del Portfolio (valor actual).
    const porTipo = [
        ...INF_TIPOS.map((t) => ({
            label: M_TYPE_LABELS[t],
            valor: activos.filter((a) => a.assetType === t).reduce((s, a) => s + a.eur.netoActualEur, 0),
            color: M_TYPE_COLORS[t]
        })),
        { label: "Renta Fija", valor: rentaFijaInvertido, color: M_TYPE_COLORS.rentaFija }
    ]
    const porActivo = [
        ...activos.map((a) => ({ label: a.nombre, valor: a.eur.netoActualEur, color: a.color })),
        ...rentaFija.map((r) => ({ label: r.instrumento || r._origen, valor: parseEuroNumber(r.invertido || "") }))
    ]
        .sort((a, b) => b.valor - a.valor)
        .map((item, i) => ({ ...item, color: item.color || M_PALETTE[i % M_PALETTE.length] }))

    const graficos = infFilaDonuts([
        { items: porTipo, titulo: "Por tipo de activo" },
        { items: porActivo, titulo: "Por activo individual" }
    ])

    // Resumen por tipo.
    const filasTipo = INF_TIPOS.map((t) => {
        const grupo = activos.filter((a) => a.assetType === t)
        if (!grupo.length) return null
        const valor = grupo.reduce((s, a) => s + a.eur.netoActualEur, 0)
        const inv = grupo.reduce((s, a) => s + a.eur.invertidoBrutoEur, 0)
        return [
            infEsc(M_TYPE_LABELS[t]),
            String(grupo.length),
            infEur(inv),
            infEur(valor),
            infEurSigno(valor - inv),
            infPctSigno(inv > 0 ? ((valor - inv) / inv) * 100 : NaN),
            infPct(totalValor > 0 ? (valor / totalValor) * 100 : 0)
        ]
    }).filter(Boolean)
    const tablaTipos = infTabla(
        [
            { label: "Tipo" },
            { label: "Activos", num: true },
            { label: "Invertido", num: true },
            { label: "Valor actual", num: true },
            { label: "Rendimiento", num: true },
            { label: "Rend. %", num: true },
            { label: "Peso", num: true }
        ],
        filasTipo,
        [
            "Total",
            String(activos.length),
            infEur(totalInvertido),
            infEur(totalValor),
            infEurSigno(totalRend),
            infPctSigno(totalInvertido > 0 ? (totalRend / totalInvertido) * 100 : NaN),
            "100,00 %"
        ]
    )

    // Posiciones: importes en la moneda de cada activo, como en la Vista general.
    const ordenados = [...activos].sort((a, b) => b.eur.netoActualEur - a.eur.netoActualEur)
    const tablaPosiciones = infTabla(
        [
            { label: "Activo" },
            { label: "Tipo" },
            { label: "Posición", num: true },
            { label: "Precio medio", num: true },
            { label: "Precio actual", num: true },
            { label: "Inv. bruta", num: true },
            { label: "Comisiones", num: true },
            { label: "Valor actual", num: true },
            { label: "Rendimiento", num: true },
            { label: "Rend. %", num: true },
            { label: "Peso", num: true }
        ],
        ordenados.map((a) => {
            const rend = a.overviewYieldValue ?? 0
            return [
                `<strong>${infEsc(a.nombre)}</strong>`,
                infEsc(a.tipo),
                formatAssetParticipationValue(a.participaciones, a.assetType),
                formatMoney(a.promedioCompra, a.currency),
                formatMoney(a.overviewCurrentPrice ?? a.valorActual, a.currency),
                formatMoney(a.invertidoBruto, a.currency),
                formatMoney(a.comisionesFiat ?? a.comisiones, a.currency),
                formatMoney(a.overviewCurrentValue, a.currency),
                `<span class="${infClase(rend)}">${infSigno(rend)}${formatMoney(rend, a.currency)}</span>`,
                infPctSigno(a.invertidoBruto > 0 ? (rend / a.invertidoBruto) * 100 : NaN),
                infPct(totalValor > 0 ? (a.eur.netoActualEur / totalValor) * 100 : 0)
            ]
        })
    )

    // Renta fija.
    const tablaRentaFija = infTabla(
        [
            { label: "Instrumento" },
            { label: "Clase" },
            { label: "Fecha" },
            { label: "Vencimiento" },
            { label: "Rentabilidad", num: true },
            { label: "Invertido", num: true },
            { label: "Interés neto", num: true }
        ],
        rentaFija.map((r) => [
            infEsc(r.instrumento || "—"),
            infEsc(r._origen),
            infEsc(r.fecha || ""),
            infEsc(r.vencimiento || ""),
            infEsc(r.rentabilidad || ""),
            infEur(parseEuroNumber(r.invertido || "")),
            infEurSigno(infInteresNetoRF(r))
        ]),
        ["Total", "", "", "", "", infEur(rentaFijaInvertido), infEurSigno(rentaFijaInteres)]
    )

    // Dividendos: resumen por año, por activo y detalle del año en curso.
    const divAnios = {}
    const divActivos = {}
    dividendos.forEach((r) => {
        const anio = infAnio(r.fecha) ?? "Sin fecha"
        const total = parseEuroNumber(r.total || "")
        const imp = parseEuroNumber(r.impuestos || "")
        divAnios[anio] ||= { n: 0, total: 0, impuestos: 0 }
        divAnios[anio].n += 1
        divAnios[anio].total += total
        divAnios[anio].impuestos += imp
        const nombre = r.instrumento || "Sin nombre"
        divActivos[nombre] ||= { n: 0, total: 0 }
        divActivos[nombre].n += 1
        divActivos[nombre].total += total
    })
    const tablaDivAnios = infTabla(
        [
            { label: "Año" },
            { label: "Cobros", num: true },
            { label: "Impuestos", num: true },
            { label: "Total", num: true }
        ],
        Object.entries(divAnios)
            .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
            .map(([anio, d]) => [infEsc(anio), String(d.n), infEur(d.impuestos), infEur(d.total)]),
        [
            "Total",
            String(dividendos.length),
            infEur(Object.values(divAnios).reduce((s, d) => s + d.impuestos, 0)),
            infEur(dividendosTotal)
        ]
    )
    const tablaDivActivos = infTabla(
        [
            { label: "Activo" },
            { label: "Cobros", num: true },
            { label: "Total", num: true },
            { label: "% del total", num: true }
        ],
        Object.entries(divActivos)
            .sort((a, b) => b[1].total - a[1].total)
            .map(([nombre, d]) => [
                infEsc(nombre),
                String(d.n),
                infEur(d.total),
                infPct(dividendosTotal > 0 ? (d.total / dividendosTotal) * 100 : 0)
            ])
    )
    const divDelAnio = dividendos
        .filter((r) => infAnio(r.fecha) === anioActual)
        .sort((a, b) => (infFecha(a.fecha)?.orden || 0) - (infFecha(b.fecha)?.orden || 0))
    const tablaDivDetalle = infTabla(
        [
            { label: "Fecha" },
            { label: "Activo" },
            { label: "Acciones", num: true },
            { label: "Dividendo/acción", num: true },
            { label: "Impuestos", num: true },
            { label: "Total", num: true }
        ],
        divDelAnio.map((r) => [
            infEsc(r.fecha || ""),
            infEsc(r.instrumento || ""),
            infEsc(r.acciones || ""),
            infEsc(r.dividendoAccion || ""),
            infEsc(r.impuestos || ""),
            infEsc(r.total || "")
        ]),
        ["Total", "", "", "", "", infEur(dividendosAnio)]
    )
    const dividendosHtml = dividendos.length
        ? `<div class="infDosColumnas">${tablaDivAnios}${tablaDivActivos}</div>${
              tablaDivDetalle ? `<h3>Cobros de ${anioActual}</h3>${tablaDivDetalle}` : ""
          }`
        : ""

    // Intereses de las cuentas remuneradas.
    const intCuentas = {}
    filasIntereses.forEach((r) => {
        intCuentas[r.cuenta] ||= { bruto: 0, impuestos: 0, n: 0 }
        intCuentas[r.cuenta].bruto += r.bruto
        intCuentas[r.cuenta].impuestos += r.impuestos
        intCuentas[r.cuenta].n += 1
    })
    const intBruto = filasIntereses.reduce((s, r) => s + r.bruto, 0)
    const intImp = filasIntereses.reduce((s, r) => s + r.impuestos, 0)
    const tablaIntereses = infTabla(
        [
            { label: "Cuenta" },
            { label: "Liquidaciones", num: true },
            { label: "Bruto", num: true },
            { label: "Impuestos", num: true },
            { label: "Neto", num: true }
        ],
        Object.entries(intCuentas).map(([nombre, d]) => [
            infEsc(nombre),
            String(d.n),
            infEur(d.bruto),
            infEur(d.impuestos),
            infEur(d.bruto - d.impuestos)
        ]),
        ["Total", String(filasIntereses.length), infEur(intBruto), infEur(intImp), infEur(interesesNetos)]
    )

    // Ventas realizadas.
    const ventasAnios = {}
    ventas.forEach((v) => {
        const anio = infAnio(v.fecha) ?? "Sin fecha"
        ventasAnios[anio] ||= { n: 0, valor: 0, coste: 0, ganancia: 0 }
        ventasAnios[anio].n += 1
        ventasAnios[anio].valor += parseLooseNumber(v.valorVenta) || 0
        ventasAnios[anio].coste += coste(v)
        ventasAnios[anio].ganancia += ganancia(v)
    })
    const tablaVentasAnios = infTabla(
        [
            { label: "Año" },
            { label: "Ventas", num: true },
            { label: "Valor de venta", num: true },
            { label: "Coste de adquisición", num: true },
            { label: "Ganancia / pérdida", num: true }
        ],
        Object.entries(ventasAnios)
            .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
            .map(([anio, d]) => [infEsc(anio), String(d.n), infEur(d.valor), infEur(d.coste), infEurSigno(d.ganancia)])
    )
    const ventasDelAnio = ventas
        .filter((v) => infAnio(v.fecha) === anioActual)
        .sort((a, b) => (infFecha(a.fecha)?.orden || 0) - (infFecha(b.fecha)?.orden || 0))
    const tablaVentasDetalle = infTabla(
        [
            { label: "Fecha" },
            { label: "Activo" },
            { label: "Cantidad", num: true },
            { label: "Valor de venta", num: true },
            { label: "Coste", num: true },
            { label: "Ganancia / pérdida", num: true }
        ],
        ventasDelAnio.map((v) => [
            infEsc(v.fecha || ""),
            infEsc(v.activo || ""),
            infEsc(v.cantidad || ""),
            infEur(parseLooseNumber(v.valorVenta) || 0),
            infEur(coste(v)),
            infEurSigno(ganancia(v))
        ])
    )
    const ventasHtml = ventas.length
        ? `${tablaVentasAnios}${tablaVentasDetalle ? `<h3>Ventas de ${anioActual}</h3>${tablaVentasDetalle}` : ""}`
        : ""

    const nombrePortfolio = window._viewAllPortfolios
        ? "Todos los portfolios"
        : document.getElementById("portfolioCurrentName")?.textContent?.trim() || "Portfolio"

    return `
        ${infCabecera("Informe del portfolio", nombrePortfolio)}
        ${kpis}
        ${infSeccion("Distribución del portfolio", graficos, "Por valor actual en euros. La renta fija cuenta por lo invertido.")}
        ${infSeccion("Resumen por tipo de activo", tablaTipos)}
        ${infSeccion("Posiciones", tablaPosiciones, "Importes en la moneda de cada activo; el peso, sobre el valor en euros.")}
        ${infSeccion("Renta fija", tablaRentaFija)}
        ${infSeccion("Dividendos", dividendosHtml)}
        ${infSeccion("Intereses de cuentas remuneradas", tablaIntereses)}
        ${infSeccion("Beneficio realizado (ventas)", ventasHtml, "Ganancia o pérdida patrimonial calculada por FIFO.")}
        <footer class="infPie">PortfolioManager · Las cotizaciones son las últimas guardadas al generar el informe.</footer>`
}

async function descargarInformePortfolio(boton = null) {
    await infGenerar(boton, async (alProgresar) => {
        const datos = await infDatosPortfolio()
        if (!datos.activos.length && !datos.dividendos.length) {
            alert("No hay activos para incluir en el informe.")
            return
        }
        await infDescargarPdf(
            infHtmlPortfolio(datos),
            `informe-portfolio-${new Date().toISOString().slice(0, 10)}`,
            alProgresar
        )
    })
}

// ── informe de finanzas ────────────────────────────────────────────────────

async function infDatosFinanzas(anio) {
    const [gastosAnios, ingresosAnios, cuentasData, transfData, intData, divData] = await Promise.all([
        infGet("/api/gastos", { years: [] }),
        infGet("/api/ingresos", { years: [] }),
        infGet("/api/cuentas", { cuentas: [] }),
        infGet("/api/transferencias", { transferencias: [] }),
        infGet("/api/intereses", { cuentas: [] }),
        infGet("/api/dividendos", { rows: [] })
    ])
    if (Array.isArray(cuentasData?.cuentas)) window._cuentasDinero = cuentasData.cuentas

    const listaGastos = (gastosAnios?.years || []).map(String)
    const listaIngresos = (ingresosAnios?.years || []).map(String)
    const anios = [...new Set([...listaGastos, ...listaIngresos])].sort()

    // mComputeGastosData necesita `year` para saber qué mensualidades ya se han cobrado.
    const cargarAnio = async (y) => {
        const [gastos, ingresos] = await Promise.all([
            listaGastos.includes(y) ? infGet(`/api/gastos/${encodeURIComponent(y)}`, null) : null,
            listaIngresos.includes(y) ? infGet(`/api/ingresos/${encodeURIComponent(y)}`, null) : null
        ])
        return {
            year: y,
            gastos: gastos ? { ...gastos, year: gastos.year ?? y } : null,
            ingresos: ingresos ? { ...ingresos, year: ingresos.year ?? y } : null
        }
    }
    const porAnio = await Promise.all(anios.map(cargarAnio))
    const actual = porAnio.find((d) => d.year === String(anio)) || (await cargarAnio(String(anio)))

    return {
        anio: String(anio),
        porAnio,
        gastos: actual.gastos,
        ingresos: actual.ingresos,
        cuentas: Array.isArray(cuentasData?.cuentas) ? cuentasData.cuentas : [],
        transferencias: Array.isArray(transfData?.transferencias) ? transfData.transferencias : [],
        cuentasRemuneradas: Array.isArray(intData?.cuentas) ? intData.cuentas : [],
        dividendos: Array.isArray(divData?.rows) ? divData.rows : []
    }
}

function infTotalesAnio(gastos, ingresos) {
    const g = mComputeGastosData(gastos)
    const ingMes = mComputeIngresosMonthly(ingresos)
    return {
        gastosMes: M_GASTOS_KEYS.map((k) => g.totalMes[k] || 0),
        ingresosMes: M_ING_KEYS.map((k) => ingMes[k] || 0),
        gastosTipo: g.totalTipo,
        totalMensualidades: g.totalMensualidades
    }
}

function infHtmlFinanzas(datos) {
    const { anio, porAnio, gastos, ingresos, cuentas, transferencias, cuentasRemuneradas, dividendos } = datos
    const anioNum = Number(anio)
    const t = infTotalesAnio(gastos, ingresos)
    const totalGastos = t.gastosMes.reduce((s, v) => s + v, 0)
    const totalIngresos = t.ingresosMes.reduce((s, v) => s + v, 0)
    const ahorro = totalIngresos - totalGastos
    const tasa = totalIngresos > 0 ? (ahorro / totalIngresos) * 100 : NaN

    const saldoCuentas = cuentas.reduce((s, c) => s + parseEuroNumber(c.saldo), 0)
    const filasIntereses = cuentasRemuneradas.flatMap((c) =>
        (Array.isArray(c.rows) ? c.rows : [])
            .filter((r) => infAnio(r.fecha) === anioNum)
            .map((r) => ({
                cuenta: c.nombre || "Cuenta",
                fecha: r.fecha,
                bruto: parseEuroNumber(r.acumulado || ""),
                impuestos: parseEuroNumber(r.impuestos || "")
            }))
    )
    const interesesNetos = filasIntereses.reduce((s, r) => s + r.bruto - r.impuestos, 0)
    const dividendosAnio = dividendos
        .filter((r) => infAnio(r.fecha) === anioNum)
        .reduce((s, r) => s + parseEuroNumber(r.total || ""), 0)
    const transfAnio = transferencias
        .filter((tr) => String(tr.year || infAnio(tr.fecha) || "") === anio)
        .sort((a, b) => (infFecha(a.fecha)?.orden || 0) - (infFecha(b.fecha)?.orden || 0))

    const kpis = infKpis([
        { label: "Ingresos", valor: `<span class="infPos">${infEur(totalIngresos)}</span>` },
        { label: "Gastos", valor: `<span class="infNeg">${infEur(totalGastos)}</span>` },
        { label: "Ahorro", valor: infEurSigno(ahorro), nota: `Tasa de ahorro ${infPct(tasa)}` },
        { label: "Mensualidades", valor: infEur(t.totalMensualidades) },
        { label: "Saldo en cuentas", valor: infEur(saldoCuentas), nota: "A día de hoy" },
        { label: "Intereses netos", valor: infEur(interesesNetos), nota: "Cuentas remuneradas" },
        { label: "Dividendos", valor: infEur(dividendosAnio) },
        { label: "Transferencias", valor: String(transfAnio.length) }
    ])

    // Mes a mes.
    const grafMeses = infBarrasMensuales([
        { label: "Ingresos", color: "#2ecc71", valores: t.ingresosMes },
        { label: "Gastos", color: "#e74c3c", valores: t.gastosMes }
    ])
    const tablaMeses = infTabla(
        [
            { label: "Mes" },
            { label: "Ingresos", num: true },
            { label: "Gastos", num: true },
            { label: "Ahorro", num: true },
            { label: "Tasa de ahorro", num: true }
        ],
        INF_MESES.map((mes, i) => {
            const ing = t.ingresosMes[i]
            const gas = t.gastosMes[i]
            return [
                mes,
                infEur(ing),
                infEur(gas),
                infEurSigno(ing - gas),
                ing > 0 ? infPct(((ing - gas) / ing) * 100) : "—"
            ]
        }),
        ["Total", infEur(totalIngresos), infEur(totalGastos), infEurSigno(ahorro), infPct(tasa)]
    )

    // Categorías.
    const aItems = (mapa) =>
        Object.entries(mapa)
            .filter(([, v]) => v > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([label, valor], i) => ({ label, valor, color: INF_PALETA[i % INF_PALETA.length] }))
    const graficosCategorias = infFilaDonuts([
        { items: aItems(t.gastosTipo), titulo: "Gastos por categoría" },
        { items: aItems(mComputeIngresosTipo(ingresos, "all")), titulo: "Ingresos por categoría" }
    ])

    // Mensualidades y recurrentes.
    const sumaMeses = (row) => M_GASTOS_KEYS.reduce((s, k) => s + parseEuroNumber(row.meses?.[k] || ""), 0)
    const mensualidades = (gastos?.mensualidades || []).filter((m) => m.nombre || sumaMeses(m))
    const tablaMensualidades = infTabla(
        [
            { label: "Servicio" },
            { label: "Estado" },
            { label: "Meses con cargo", num: true },
            { label: `Total ${anio}`, num: true }
        ],
        mensualidades
            .sort((a, b) => sumaMeses(b) - sumaMeses(a))
            .map((m) => [
                infEsc(m.nombre || "—"),
                m.activa === false ? "Pausada" : "Activa",
                String(M_GASTOS_KEYS.filter((k) => parseEuroNumber(m.meses?.[k] || "") > 0).length),
                infEur(sumaMeses(m))
            ]),
        ["Total", "", "", infEur(mensualidades.reduce((s, m) => s + sumaMeses(m), 0))]
    )
    const recurrentes = (ingresos?.recurrentes || []).filter((r) => r.nombre || sumaMeses(r))
    const tablaRecurrentes = infTabla(
        [{ label: "Concepto" }, { label: "Categoría" }, { label: `Total ${anio}`, num: true }],
        recurrentes
            .sort((a, b) => sumaMeses(b) - sumaMeses(a))
            .map((r) => [infEsc(r.nombre || "—"), infEsc(r.categoria || ""), infEur(sumaMeses(r))]),
        ["Total", "", infEur(recurrentes.reduce((s, r) => s + sumaMeses(r), 0))]
    )

    // Cuentas.
    const tablaCuentas = infTabla(
        [
            { label: "Cuenta" },
            { label: "Tipo" },
            { label: "Saldo inicial", num: true },
            { label: "Entradas", num: true },
            { label: "Salidas", num: true },
            { label: "Comisiones", num: true },
            { label: "Intereses", num: true },
            { label: "Dividendos", num: true },
            { label: "Saldo", num: true }
        ],
        cuentas.map((c) => [
            `<strong>${infEsc(c.nombre)}</strong>`,
            infEsc(c.tipo_etiqueta || c.tipo || ""),
            infEur(parseEuroNumber(c.saldo_inicial)),
            infEur(parseEuroNumber(c.entradas)),
            infEur(-parseEuroNumber(c.salidas)),
            infEur(-parseEuroNumber(c.comisiones)),
            infEur(parseEuroNumber(c.intereses)),
            infEur(parseEuroNumber(c.dividendos_cobrados)),
            `<strong>${infEur(parseEuroNumber(c.saldo))}</strong>`
        ]),
        ["Total", "", "", "", "", "", "", "", `<strong>${infEur(saldoCuentas)}</strong>`]
    )

    // Cuenta remunerada.
    const intCuentas = {}
    filasIntereses.forEach((r) => {
        intCuentas[r.cuenta] ||= { bruto: 0, impuestos: 0, n: 0 }
        intCuentas[r.cuenta].bruto += r.bruto
        intCuentas[r.cuenta].impuestos += r.impuestos
        intCuentas[r.cuenta].n += 1
    })
    const tablaIntereses = infTabla(
        [
            { label: "Cuenta" },
            { label: "Liquidaciones", num: true },
            { label: "Bruto", num: true },
            { label: "Impuestos", num: true },
            { label: "Neto", num: true }
        ],
        Object.entries(intCuentas).map(([nombre, d]) => [
            infEsc(nombre),
            String(d.n),
            infEur(d.bruto),
            infEur(d.impuestos),
            infEur(d.bruto - d.impuestos)
        ]),
        [
            "Total",
            String(filasIntereses.length),
            infEur(filasIntereses.reduce((s, r) => s + r.bruto, 0)),
            infEur(filasIntereses.reduce((s, r) => s + r.impuestos, 0)),
            infEur(interesesNetos)
        ]
    )

    // Transferencias entre cuentas.
    const tablaTransferencias = infTabla(
        [
            { label: "Fecha" },
            { label: "Origen" },
            { label: "Destino" },
            { label: "Concepto" },
            { label: "Cantidad", num: true },
            { label: "Comisión", num: true }
        ],
        transfAnio.map((tr) => [
            infEsc(tr.fecha || ""),
            infEsc(tr.origen_nombre || ""),
            infEsc(tr.destino_nombre || ""),
            infEsc(tr.concepto || ""),
            infEur(parseEuroNumber(tr.cantidad)),
            parseEuroNumber(tr.comision) ? infEur(parseEuroNumber(tr.comision)) : ""
        ]),
        [
            "Total",
            "",
            "",
            "",
            infEur(transfAnio.reduce((s, tr) => s + parseEuroNumber(tr.cantidad), 0)),
            infEur(transfAnio.reduce((s, tr) => s + parseEuroNumber(tr.comision), 0))
        ]
    )

    // Detalle de movimientos.
    const movimientos = (datosAnio, normalizar) =>
        M_GASTOS_KEYS.flatMap((k) => datosAnio?.months?.[k]?.rows || [])
            .filter((r) => r.fecha || r.nombre || parseEuroNumber(r.cantidad || ""))
            .sort((a, b) => (infFecha(a.fecha)?.orden || 0) - (infFecha(b.fecha)?.orden || 0))
            .map((r) => [
                infEsc(r.fecha || ""),
                infEsc(r.nombre || ""),
                infEsc(normalizar(r.tipo || "")),
                infEsc(nombreDeCuenta(r.cuenta || "")),
                infEur(parseEuroNumber(r.cantidad || ""))
            ])
    const colsMov = [
        { label: "Fecha" },
        { label: "Concepto" },
        { label: "Categoría" },
        { label: "Cuenta" },
        { label: "Importe", num: true }
    ]
    const movGastos = movimientos(gastos, normalizeGastoTipo)
    const movIngresos = movimientos(ingresos, normalizeIngresoTipo)
    const tablaMovGastos = infTabla(colsMov, movGastos, [
        "Total",
        "",
        "",
        "",
        infEur(totalGastos - t.totalMensualidades)
    ])
    const totalRecurrentes = (ingresos?.recurrentes || []).reduce((s, r) => s + sumaMeses(r), 0)
    const tablaMovIngresos = infTabla(colsMov, movIngresos, [
        "Total",
        "",
        "",
        "",
        infEur(totalIngresos - totalRecurrentes)
    ])

    // Resumen de todos los años.
    const resumenAnios = porAnio
        .map((d) => {
            const r = infTotalesAnio(d.gastos, d.ingresos)
            const ing = r.ingresosMes.reduce((s, v) => s + v, 0)
            const gas = r.gastosMes.reduce((s, v) => s + v, 0)
            return { year: d.year, ing, gas }
        })
        .filter((r) => r.ing || r.gas)
        .reverse()
    const tablaAnios =
        resumenAnios.length > 1
            ? infTabla(
                  [
                      { label: "Año" },
                      { label: "Ingresos", num: true },
                      { label: "Gastos", num: true },
                      { label: "Ahorro", num: true },
                      { label: "Tasa de ahorro", num: true }
                  ],
                  resumenAnios.map((r) => [
                      infEsc(r.year),
                      infEur(r.ing),
                      infEur(r.gas),
                      infEurSigno(r.ing - r.gas),
                      r.ing > 0 ? infPct(((r.ing - r.gas) / r.ing) * 100) : "—"
                  ])
              )
            : ""

    return `
        ${infCabecera(`Informe de finanzas ${anio}`, "Ingresos, gastos, cuentas y movimientos")}
        ${kpis}
        ${infSeccion("Evolución mensual", grafMeses + tablaMeses)}
        ${infSeccion("Reparto por categorías", graficosCategorias)}
        ${infSeccion("Mensualidades", tablaMensualidades, "Solo cuentan los meses ya cobrados.")}
        ${infSeccion("Ingresos recurrentes", tablaRecurrentes)}
        ${infSeccion("Cuentas", tablaCuentas, "Saldos a día de hoy.")}
        ${infSeccion("Cuenta remunerada", tablaIntereses)}
        ${infSeccion("Transferencias entre cuentas", tablaTransferencias)}
        ${infSeccion("Gastos del año", tablaMovGastos, "Movimientos sueltos; las mensualidades van en su apartado.")}
        ${infSeccion("Ingresos del año", tablaMovIngresos, "Movimientos sueltos; los recurrentes van en su apartado.")}
        ${infSeccion("Resumen por años", tablaAnios)}
        <footer class="infPie">PortfolioManager · Informe de finanzas del año ${infEsc(anio)}.</footer>`
}

async function descargarInformeFinanzas(anio, boton = null) {
    await infGenerar(boton, async (alProgresar) => {
        const year = String(anio || new Date().getFullYear())
        const datos = await infDatosFinanzas(year)
        await infDescargarPdf(infHtmlFinanzas(datos), `informe-finanzas-${year}`, alProgresar)
    })
}
