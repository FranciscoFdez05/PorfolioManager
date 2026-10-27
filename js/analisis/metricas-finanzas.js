// Métricas: histórico de ingresos, vencimientos de renta fija/bonos y mercado
// privado.
//
// Mismo ámbito global que el resto de trozos de Métricas (index.html los carga
// seguidos): usa mCreateChart, mAxisX, intYear, _CUENTA_COLORS… y lo llama
// mRenderAll. Todo sale de los datos que ya trae buildMetricasPayload.

const M_FIN_TIPO_RF = {
    if: { label: "Interés fijo", color: "#00bcd4" },
    gubernamental: { label: "Gubernamental", color: "#9b59b6" },
    corporativo: { label: "Corporativo", color: "#c39bd3" }
}

const M_FIN_ORIGEN_COLORS = {
    dividendos: "#2ecc71",
    cuentas: "#3a7bd5",
    bonos: "#9b59b6",
    rentaFija: "#00bcd4"
}

const M_FIN_PM_SERIES = [
    { key: "llamado", label: "Llamado", color: "#3a7bd5" },
    { key: "distribuido", label: "Distribuido", color: "#2ecc71" },
    { key: "valorActual", label: "Valor actual", color: "#a78bfa" }
]

const M_FIN_DIA_MS = 24 * 60 * 60 * 1000

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Convierte una fecha "dd-mm-aaaa" de la app en Date (medianoche local).
 *
 * @param {string} fecha Fecha tal como la guardan las tablas.
 * @returns {Date|null} La fecha, o null si está vacía o mal formada.
 */
function mFinFecha(fecha) {
    const partes = String(fecha || "").split("-")
    if (partes.length !== 3) return null
    const dia = parseInt(partes[0], 10)
    const mes = mParseEsMonth(partes[1]) || parseInt(partes[1], 10)
    const anio = mParseShortYear(partes[2])
    if (!dia || !mes || !anio || mes < 1 || mes > 12) return null
    return new Date(anio, mes - 1, dia)
}

/**
 * Lee un porcentaje guardado como texto ("2,78%", "3.1 %").
 *
 * @param {string} valor Texto del porcentaje.
 * @returns {number|null} El número, o null si no hay uno válido.
 */
function mFinPct(valor) {
    const limpio = String(valor || "")
        .replace("%", "")
        .replace(",", ".")
        .trim()
    if (!limpio) return null
    const numero = parseFloat(limpio)
    return Number.isFinite(numero) ? numero : null
}

function mFinNeto(row) {
    return parseEuroNumber(row.interesAcumulado || "") - parseEuroNumber(row.impuestos || "")
}

function mFinFmtPct(valor) {
    return `${valor.toFixed(2).replace(".", ",")} %`
}

function mFinFmtX(valor) {
    return valor === null ? "—" : `${valor.toFixed(2).replace(".", ",")}x`
}

function mFinFmtFecha(fecha) {
    if (!fecha) return "—"
    const dd = String(fecha.getDate()).padStart(2, "0")
    const mm = String(fecha.getMonth() + 1).padStart(2, "0")
    return `${dd}-${mm}-${fecha.getFullYear()}`
}

function mFinHoy() {
    const ahora = new Date()
    return new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate())
}

function mFinBadge(texto, color) {
    return `<span class="mTypeBadge" style="background:${color}22;color:${color};border-color:${color}44">${escapeHtml(texto)}</span>`
}

function mFinMostrarSeccion(id, visible) {
    document.getElementById(id)?.classList.toggle("hidden", !visible)
}

function mFinEjeEuros() {
    return { ...mAxisY(), ticks: { color: "#ccd6f6", callback: (v) => formatEuro(v) } }
}

// ── histórico de ingresos ──────────────────────────────────────────────────

/**
 * Pinta la sección "Histórico de ingresos": dividendos y cuentas por año, el
 * origen de los ingresos pasivos y las tablas por cuenta y por pagador.
 *
 * @param {Object[]} dividendos Filas de /api/dividendos.
 * @param {Object[]} cuentas Cuentas remuneradas con sus filas de intereses.
 * @param {Object[]} bonos Filas de /api/bonos.
 * @param {Object[]} rentaFija Filas de /api/rentafija.
 */
function mRenderIngresosHistorico(dividendos, cuentas, bonos, rentaFija) {
    const hayIntereses = cuentas.some((c) => (c.rows || []).length)
    mFinMostrarSeccion("mSectionIngresosHistorico", dividendos.length > 0 || hayIntereses)
    if (!dividendos.length && !hayIntereses) return

    mDrawDivAnual(dividendos)
    mDrawInteresesAnual(cuentas)
    mDrawPasivosOrigen(dividendos, cuentas, bonos, rentaFija)
    mRenderCuentasResumen(cuentas)
    mRenderDivPagadores(dividendos)
}

function mFinSumaPorAnio(rows, valorDe) {
    const porAnio = {}
    rows.forEach((r) => {
        const anio = intYear(r.fecha)
        if (anio) porAnio[anio] = (porAnio[anio] || 0) + valorDe(r)
    })
    return porAnio
}

function mDrawDivAnual(dividendos) {
    const porAnio = mFinSumaPorAnio(dividendos, (r) => parseEuroNumber(r.total || ""))
    const anios = Object.keys(porAnio).sort((a, b) => Number(a) - Number(b))
    const anioActual = String(new Date().getFullYear())
    const valores = anios.map((a) => Number(porAnio[a].toFixed(2)))
    // El año en curso está a medias: compararlo con un año completo daría una
    // caída que no es real, así que no lleva variación.
    const variacion = anios.map((a, i) => {
        const previo = i > 0 ? porAnio[anios[i - 1]] : 0
        if (a === anioActual || !(previo > 0)) return null
        return Number((((porAnio[a] - previo) / previo) * 100).toFixed(1))
    })

    mCreateChart("mChartDivAnual", {
        type: "bar",
        data: {
            labels: anios.map((a) => (a === anioActual ? `${a} (YTD)` : a)),
            datasets: [
                {
                    type: "bar",
                    label: "Dividendos netos",
                    data: valores,
                    backgroundColor: "#2ecc71bb",
                    borderColor: "#2ecc71",
                    borderWidth: 1,
                    borderRadius: 4,
                    yAxisID: "y"
                },
                {
                    type: "line",
                    label: "Variación anual",
                    data: variacion,
                    borderColor: "#f39c12",
                    backgroundColor: "#f39c12",
                    pointRadius: 3,
                    tension: 0.3,
                    spanGaps: false,
                    yAxisID: "y1"
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { ...M_CHART_DEFAULTS.plugins.legend, position: "bottom" },
                tooltip: {
                    callbacks: {
                        label: (c) =>
                            c.dataset.yAxisID === "y1"
                                ? ` ${c.raw >= 0 ? "+" : ""}${String(c.raw).replace(".", ",")} %`
                                : ` ${formatEuro(c.raw)}`
                    }
                }
            },
            scales: {
                x: mAxisX(),
                y: mFinEjeEuros(),
                y1: {
                    position: "right",
                    grid: { display: false },
                    ticks: { color: "#f39c12", callback: (v) => `${v} %` }
                }
            }
        }
    })
}

function mDrawInteresesAnual(cuentas) {
    const conFilas = cuentas.filter((c) => (c.rows || []).length)
    const porCuenta = conFilas.map((c) => mFinSumaPorAnio(c.rows, mFinNetoInteres))
    const anios = [...new Set(porCuenta.flatMap((m) => Object.keys(m)))].sort((a, b) => Number(a) - Number(b))
    const anioActual = String(new Date().getFullYear())

    mCreateChart("mChartInteresesAnual", {
        type: "bar",
        data: {
            labels: anios.map((a) => (a === anioActual ? `${a} (YTD)` : a)),
            datasets: conFilas.map((c, i) => {
                const color = _CUENTA_COLORS[i % _CUENTA_COLORS.length]
                return {
                    label: c.nombre || "Cuenta",
                    data: anios.map((a) => Number((porCuenta[i][a] || 0).toFixed(2))),
                    backgroundColor: color + "bb",
                    borderColor: color,
                    borderWidth: 1,
                    borderRadius: 4
                }
            })
        },
        options: {
            ...M_CHART_DEFAULTS,
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { ...M_CHART_DEFAULTS.plugins.legend, position: "bottom" },
                tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${formatEuro(c.raw)}` } }
            },
            scales: { x: { ...mAxisX(), stacked: true }, y: { ...mFinEjeEuros(), stacked: true } }
        }
    })
}

function mFinNetoInteres(row) {
    return parseEuroNumber(row.acumulado || "") - parseEuroNumber(row.impuestos || "")
}

function mDrawPasivosOrigen(dividendos, cuentas, bonos, rentaFija) {
    // Las mismas cuatro fuentes que suma la KPI "Total pasivos".
    const origenes = [
        {
            label: "Dividendos",
            key: "dividendos",
            valor: dividendos.reduce((s, r) => s + parseEuroNumber(r.total || ""), 0)
        },
        {
            label: "Cuentas remuneradas",
            key: "cuentas",
            valor: cuentas.reduce((s, c) => s + (c.rows || []).reduce((t, r) => t + mFinNetoInteres(r), 0), 0)
        },
        { label: "Bonos", key: "bonos", valor: bonos.reduce((s, r) => s + mFinNeto(r), 0) },
        { label: "Renta fija", key: "rentaFija", valor: rentaFija.reduce((s, r) => s + mFinNeto(r), 0) }
    ].filter((o) => o.valor > 0)
    const total = origenes.reduce((s, o) => s + o.valor, 0)
    const labels = origenes.map((o) => o.label)
    const values = origenes.map((o) => Number(o.valor.toFixed(2)))
    const colors = origenes.map((o) => M_FIN_ORIGEN_COLORS[o.key] + "cc")

    mCreateChart("mChartPasivosOrigen", {
        type: "doughnut",
        data: {
            labels,
            datasets: [
                {
                    data: values,
                    backgroundColor: colors,
                    borderColor: "#0b1120",
                    borderWidth: 3,
                    hoverOffset: 10
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            cutout: "60%",
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => mGridTooltip(c.label, c.raw, total) } }
            }
        }
    })
    mRenderDonutLeyenda("mChartPasivosOrigen", labels, colors, values, total)
}

function mRenderCuentasResumen(cuentas) {
    const body = document.getElementById("mCuentasResumenBody")
    const foot = document.getElementById("mCuentasResumenFoot")
    if (!body) return

    const filas = cuentas
        .filter((c) => (c.rows || []).length)
        .map((c) => {
            const bruto = c.rows.reduce((s, r) => s + parseEuroNumber(r.acumulado || ""), 0)
            const impuestos = c.rows.reduce((s, r) => s + parseEuroNumber(r.impuestos || ""), 0)
            return { nombre: c.nombre || "Cuenta", meses: c.rows.length, bruto, impuestos, neto: bruto - impuestos }
        })
        .sort((a, b) => b.neto - a.neto)

    const fila = (f, nombre) => `
        <tr>
            <td class="mTdName">${nombre}</td>
            <td>${f.meses}</td>
            <td>${formatEuro(f.bruto)}</td>
            <td>${formatEuro(f.impuestos)}</td>
            <td class="mCellPos">${formatEuro(f.neto)}</td>
            <td>${formatEuro(f.meses ? f.neto / f.meses : 0)}</td>
        </tr>`

    body.innerHTML = filas.map((f) => fila(f, escapeHtml(f.nombre))).join("")

    if (foot) {
        const total = filas.reduce(
            (t, f) => ({
                meses: t.meses + f.meses,
                bruto: t.bruto + f.bruto,
                impuestos: t.impuestos + f.impuestos,
                neto: t.neto + f.neto
            }),
            { meses: 0, bruto: 0, impuestos: 0, neto: 0 }
        )
        foot.innerHTML = filas.length > 1 ? fila(total, "Total") : ""
    }
}

function mRenderDivPagadores(dividendos) {
    const body = document.getElementById("mDivPagadoresBody")
    if (!body) return

    // Se comparan los dos últimos años completos: el actual va a medias.
    const anio = new Date().getFullYear() - 1
    const anioPrevio = anio - 1
    const cabeceraAnio = document.getElementById("mDivPagadoresAnio")
    const cabeceraPrevio = document.getElementById("mDivPagadoresAnioPrev")
    if (cabeceraAnio) cabeceraAnio.textContent = String(anio)
    if (cabeceraPrevio) cabeceraPrevio.textContent = String(anioPrevio)

    const porInstrumento = new Map()
    dividendos.forEach((r) => {
        const nombre = r.instrumento || "Sin nombre"
        const neto = parseEuroNumber(r.total || "")
        const actual = porInstrumento.get(nombre) || { cobros: 0, total: 0, anio: 0, previo: 0 }
        const anioFila = Number(intYear(r.fecha))
        actual.cobros += 1
        actual.total += neto
        if (anioFila === anio) actual.anio += neto
        if (anioFila === anioPrevio) actual.previo += neto
        porInstrumento.set(nombre, actual)
    })

    const totalGeneral = [...porInstrumento.values()].reduce((s, v) => s + v.total, 0)
    body.innerHTML = [...porInstrumento.entries()]
        .sort((a, b) => b[1].total - a[1].total)
        .map(([nombre, v]) => {
            const variacion = v.previo > 0 ? ((v.anio - v.previo) / v.previo) * 100 : null
            const clsVar = variacion === null ? "" : variacion >= 0 ? "mCellPos" : "mCellNeg"
            const textoVar = variacion === null ? "—" : `${variacion >= 0 ? "+" : ""}${mFinFmtPct(variacion)}`
            const peso = totalGeneral > 0 ? (v.total / totalGeneral) * 100 : 0
            return `
        <tr>
            <td class="mTdName">${escapeHtml(nombre)}</td>
            <td>${v.cobros}</td>
            <td>${formatEuro(v.total)}</td>
            <td>${mFinBarra(peso, mFinFmtPct(peso))}</td>
            <td>${v.previo ? formatEuro(v.previo) : "—"}</td>
            <td>${v.anio ? formatEuro(v.anio) : "—"}</td>
            <td class="${clsVar}">${textoVar}</td>
        </tr>`
        })
        .join("")
}

function mFinBarra(porcentaje, texto, color = "#3a7bd5") {
    const ancho = Math.max(0, Math.min(100, porcentaje))
    return `<div class="mCartBar"><div class="mCartBarFill" style="width:${(ancho * 0.6).toFixed(1)}px;background:${color}"></div><span>${texto}</span></div>`
}

// ── vencimientos de renta fija y bonos ─────────────────────────────────────

function mFinPosicionesRf(bonos, rentaFija) {
    const desde = (rows, campoRentab) =>
        rows.map((r) => {
            const tipo = M_FIN_TIPO_RF[r.tipo] || { label: r.tipo || "Otro", color: "#607d8b" }
            return {
                nombre: r.instrumento || "Sin nombre",
                tipo,
                invertido: parseEuroNumber(r.invertido || ""),
                rentab: mFinPct(r[campoRentab]),
                vencimiento: mFinFecha(r.vencimiento),
                neto: mFinNeto(r)
            }
        })
    return [...desde(rentaFija, "rentabilidad"), ...desde(bonos, "cupon")]
}

/**
 * Pinta la sección de vencimientos: KPIs del capital vivo, capital que vence
 * por año y la tabla de posiciones ordenada por vencimiento.
 *
 * Una posición sin fecha de vencimiento cuenta como viva (cuentas a la vista,
 * fondos monetarios) pero no entra en el calendario.
 *
 * @param {Object[]} bonos Filas de /api/bonos.
 * @param {Object[]} rentaFija Filas de /api/rentafija.
 */
function mRenderVencimientos(bonos, rentaFija) {
    const posiciones = mFinPosicionesRf(bonos, rentaFija)
    mFinMostrarSeccion("mSectionVencimientos", posiciones.length > 0)
    if (!posiciones.length) return

    const hoy = mFinHoy()
    const vivas = posiciones.filter((p) => !p.vencimiento || p.vencimiento >= hoy)
    mRenderVencimientosKpis(vivas)
    mDrawVencimientos(vivas.filter((p) => p.vencimiento))
    mRenderVencimientosTabla(posiciones, hoy)
}

function mRenderVencimientosKpis(vivas) {
    const capital = vivas.reduce((s, p) => s + p.invertido, 0)
    const conRentab = vivas.filter((p) => p.rentab !== null && p.invertido > 0)
    const baseRentab = conRentab.reduce((s, p) => s + p.invertido, 0)
    const interesAnual = conRentab.reduce((s, p) => s + (p.invertido * p.rentab) / 100, 0)
    const proxima = vivas.filter((p) => p.vencimiento).sort((a, b) => a.vencimiento - b.vencimiento)[0]

    mSetKpi("mkpiRfCapitalVivo", formatEuro(capital))
    mSetKpi("mkpiRfRentMedia", baseRentab > 0 ? mFinFmtPct((interesAnual / baseRentab) * 100) : "---")
    mSetKpi("mkpiRfInteresAnual", formatEuro(interesAnual), interesAnual > 0 ? "mPositive" : "")
    mSetKpi("mkpiRfProximo", proxima ? mFinFmtFecha(proxima.vencimiento) : "---")
    const proximoEl = document.getElementById("mkpiRfProximo")
    if (proximoEl) proximoEl.title = proxima ? proxima.nombre : ""
}

function mDrawVencimientos(conFecha) {
    const anios = conFecha.map((p) => p.vencimiento.getFullYear())
    const desde = new Date().getFullYear()
    const hasta = anios.length ? Math.max(...anios) : desde
    const etiquetas = []
    for (let a = desde; a <= hasta; a++) etiquetas.push(String(a))

    const tipos = Object.values(M_FIN_TIPO_RF)
    mCreateChart("mChartVencimientos", {
        type: "bar",
        data: {
            labels: etiquetas,
            datasets: tipos.map((tipo) => ({
                label: tipo.label,
                data: etiquetas.map((a) =>
                    Number(
                        conFecha
                            .filter((p) => p.tipo === tipo && String(p.vencimiento.getFullYear()) === a)
                            .reduce((s, p) => s + p.invertido, 0)
                            .toFixed(2)
                    )
                ),
                backgroundColor: tipo.color + "bb",
                borderColor: tipo.color,
                borderWidth: 1,
                borderRadius: 4
            }))
        },
        options: {
            ...M_CHART_DEFAULTS,
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { ...M_CHART_DEFAULTS.plugins.legend, position: "bottom" },
                tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${formatEuro(c.raw)}` } }
            },
            scales: { x: { ...mAxisX(), stacked: true }, y: { ...mFinEjeEuros(), stacked: true } }
        }
    })
}

function mFinTiempoRestante(vencimiento, hoy) {
    if (!vencimiento) return { texto: "Sin fecha", cls: "" }
    const dias = Math.round((vencimiento - hoy) / M_FIN_DIA_MS)
    if (dias < 0) return { texto: "Vencido", cls: "mFinVencido" }
    if (dias < 60) return { texto: `${dias} días`, cls: dias <= 30 ? "mFinVencePronto" : "" }
    if (dias < 730) return { texto: `${Math.round(dias / 30.44)} meses`, cls: "" }
    return { texto: `${(dias / 365.25).toFixed(1).replace(".", ",")} años`, cls: "" }
}

function mFinOrdenVencimiento(a, b, hoy) {
    // Primero las vivas por fecha, luego las que no tienen fecha y al final
    // las vencidas, de la más reciente a la más antigua.
    const grupo = (p) => (!p.vencimiento ? 1 : p.vencimiento >= hoy ? 0 : 2)
    const diferencia = grupo(a) - grupo(b)
    if (diferencia) return diferencia
    if (!a.vencimiento) return a.nombre.localeCompare(b.nombre)
    return grupo(a) === 2 ? b.vencimiento - a.vencimiento : a.vencimiento - b.vencimiento
}

function mRenderVencimientosTabla(posiciones, hoy) {
    const body = document.getElementById("mVencimientosBody")
    if (!body) return

    body.innerHTML = [...posiciones]
        .sort((a, b) => mFinOrdenVencimiento(a, b, hoy))
        .map((p) => {
            const restante = mFinTiempoRestante(p.vencimiento, hoy)
            return `
        <tr class="${restante.cls === "mFinVencido" ? "mFinFilaApagada" : ""}">
            <td class="mTdName">${escapeHtml(p.nombre)}</td>
            <td>${mFinBadge(p.tipo.label, p.tipo.color)}</td>
            <td>${formatEuro(p.invertido)}</td>
            <td>${p.rentab !== null ? mFinFmtPct(p.rentab) : "—"}</td>
            <td>${mFinFmtFecha(p.vencimiento)}</td>
            <td class="${restante.cls}">${restante.texto}</td>
            <td class="${p.neto >= 0 ? "mCellPos" : "mCellNeg"}">${formatEuro(p.neto)}</td>
        </tr>`
        })
        .join("")
}

// ── mercado privado ────────────────────────────────────────────────────────

function mFinFondosPm(privateMarket) {
    return privateMarket.map((r) => {
        const comprometido = parseEuroNumber(r.comprometido || "")
        const llamado = parseEuroNumber(r.llamado || "")
        const distribuido = parseEuroNumber(r.distribuido || "")
        const valorActual = parseEuroNumber(r.valorActual || "")
        return {
            nombre: r.nombre || "Fondo",
            tipo: r.tipo || "otros",
            gestor: r.gestor || "",
            vintage: String(r.vintage || "").trim(),
            comprometido,
            llamado,
            distribuido,
            valorActual,
            tvpi: llamado > 0 ? (distribuido + valorActual) / llamado : null,
            dpi: llamado > 0 ? distribuido / llamado : null
        }
    })
}

function mFinTipoPmLabel(tipo) {
    // Las etiquetas viven en la página de Private Market; si no estuviera
    // cargada se enseña el código tal cual.
    const etiquetas = typeof _PM_TIPO_LABELS === "object" ? _PM_TIPO_LABELS : {}
    return etiquetas[tipo] || tipo
}

/**
 * Pinta la sección de mercado privado: compromiso pendiente, gráfico por
 * vintage, reparto por tipo y la tabla por fondo.
 *
 * @param {Object[]} privateMarket Filas de /api/privatemarket.
 */
function mRenderPrivateMarket(privateMarket) {
    const fondos = mFinFondosPm(privateMarket)
    mFinMostrarSeccion("mSectionPrivateMarket", fondos.length > 0)
    if (!fondos.length) return

    const comprometido = fondos.reduce((s, f) => s + f.comprometido, 0)
    const llamado = fondos.reduce((s, f) => s + f.llamado, 0)
    // Lo pendiente se calcula fondo a fondo: un fondo que ha llamado de más
    // no compensa lo que le falta por llamar a otro.
    const pendiente = fondos.reduce((s, f) => s + Math.max(0, f.comprometido - f.llamado), 0)
    mSetKpi("mkpiPmComprometido", formatEuro(comprometido))
    mSetKpi("mkpiPmPendiente", formatEuro(pendiente))
    mSetKpi("mkpiPmPctLlamado", comprometido > 0 ? mFinFmtPct((llamado / comprometido) * 100) : "---")
    mSetKpi("mkpiPmFondos", String(fondos.length))

    mDrawPmVintage(fondos)
    const coloresTipo = mDrawPmTipos(fondos)
    mRenderPmTabla(fondos, coloresTipo)
}

function mDrawPmVintage(fondos) {
    const vintages = [...new Set(fondos.map((f) => f.vintage || "Sin vintage"))].sort()
    mCreateChart("mChartPmVintage", {
        type: "bar",
        data: {
            labels: vintages,
            datasets: M_FIN_PM_SERIES.map((serie) => ({
                label: serie.label,
                data: vintages.map((v) =>
                    Number(
                        fondos
                            .filter((f) => (f.vintage || "Sin vintage") === v)
                            .reduce((s, f) => s + f[serie.key], 0)
                            .toFixed(2)
                    )
                ),
                backgroundColor: serie.color + "bb",
                borderColor: serie.color,
                borderWidth: 1,
                borderRadius: 4
            }))
        },
        options: {
            ...M_CHART_DEFAULTS,
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { ...M_CHART_DEFAULTS.plugins.legend, position: "bottom" },
                tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${formatEuro(c.raw)}` } }
            },
            scales: { x: mAxisX(), y: mFinEjeEuros() }
        }
    })
}

function mDrawPmTipos(fondos) {
    const porTipo = {}
    fondos.forEach((f) => {
        porTipo[f.tipo] = (porTipo[f.tipo] || 0) + Math.max(0, f.valorActual)
    })
    const tipos = Object.entries(porTipo).sort((a, b) => b[1] - a[1])
    const total = tipos.reduce((s, [, v]) => s + v, 0)
    const coloresTipo = Object.fromEntries(tipos.map(([tipo], i) => [tipo, M_PALETTE[i % M_PALETTE.length]]))

    const labels = tipos.map(([tipo]) => mFinTipoPmLabel(tipo))
    const values = tipos.map(([, v]) => Number(v.toFixed(2)))
    const colors = tipos.map(([tipo]) => coloresTipo[tipo] + "cc")

    mCreateChart("mChartPmTipos", {
        type: "doughnut",
        data: {
            labels,
            datasets: [
                {
                    data: values,
                    backgroundColor: colors,
                    borderColor: "#0b1120",
                    borderWidth: 3,
                    hoverOffset: 10
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            cutout: "60%",
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => mGridTooltip(c.label, c.raw, total) } }
            }
        }
    })
    mRenderDonutLeyenda("mChartPmTipos", labels, colors, values, total)
    return coloresTipo
}

function mRenderPmTabla(fondos, coloresTipo) {
    const body = document.getElementById("mPmFondosBody")
    if (!body) return

    body.innerHTML = [...fondos]
        .sort((a, b) => b.vintage.localeCompare(a.vintage) || a.nombre.localeCompare(b.nombre))
        .map((f) => {
            const pctLlamado = f.comprometido > 0 ? (f.llamado / f.comprometido) * 100 : 0
            // Un fondo sin valor actual no sale en el donut: color neutro.
            const color = coloresTipo[f.tipo] || "#607d8b"
            const clsTvpi = f.tvpi === null ? "" : f.tvpi >= 1 ? "mCellPos" : "mCellNeg"
            return `
        <tr>
            <td class="mTdName">${escapeHtml(f.nombre)}</td>
            <td>${mFinBadge(mFinTipoPmLabel(f.tipo), color)}</td>
            <td class="mFinTexto">${escapeHtml(f.gestor) || "—"}</td>
            <td>${escapeHtml(f.vintage) || "—"}</td>
            <td>${formatEuro(f.comprometido)}</td>
            <td>${mFinBarra(pctLlamado, `${formatEuro(f.llamado)} · ${Math.round(pctLlamado)} %`)}</td>
            <td>${formatEuro(f.distribuido)}</td>
            <td>${formatEuro(f.valorActual)}</td>
            <td class="${clsTvpi}">${mFinFmtX(f.tvpi)}</td>
            <td>${mFinFmtX(f.dpi)}</td>
        </tr>`
        })
        .join("")
}
