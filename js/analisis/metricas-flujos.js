// Métricas: gastos, posiciones principales, ingresos, intereses, comparativa y saldo del mes.
//
// Separado de js/analisis/metricas.js, que pasaba de 6.000 líneas. Es código
// de nivel superior que comparte el ámbito global con el resto de trozos
// (index.html los carga seguidos y en este orden); no ha cambiado.

// ── gastos ─────────────────────────────────────────────────────────────────

// Returns false for future months of the current year (mensualidades not yet "active")
function isMensualidadMonthActive(yearData, monthKey) {
    const dataYear = Number(yearData?.year)
    const now = new Date()
    if (dataYear !== now.getFullYear()) return dataYear < now.getFullYear()
    return M_GASTOS_KEYS.indexOf(monthKey) <= now.getMonth()
}

function mComputeGastosData(yearData) {
    const totalMes = Object.fromEntries(M_GASTOS_KEYS.map((k) => [k, 0]))
    const totalTipo = {}
    let totalMensualidades = 0
    let totalMovimientos = 0

    ;(yearData?.mensualidades || []).forEach((m) => {
        M_GASTOS_KEYS.forEach((k) => {
            if (!isMensualidadMonthActive(yearData, k)) return
            const val = parseEuroNumber(m.meses?.[k] || "")
            totalMes[k] += val
            totalMensualidades += val
            if (val > 0) totalTipo["Mensualidades"] = (totalTipo["Mensualidades"] || 0) + val
        })
    })

    Object.entries(yearData?.months || {}).forEach(([monthKey, monthData]) => {
        ;(monthData?.rows || []).forEach((row) => {
            const val = parseEuroNumber(row.cantidad || "")
            totalMes[monthKey] = (totalMes[monthKey] || 0) + val
            totalMovimientos += val
            const tipo = (row.tipo || "Sin tipo").trim()
            totalTipo[tipo] = (totalTipo[tipo] || 0) + val
        })
    })

    return { totalMes, totalTipo, totalMensualidades, totalMovimientos }
}

function mRenderGastos(yearsList, yearData) {
    const section = document.getElementById("mSectionGastos")
    const gastosKpiRow = document.querySelector(".metricasKpiRow[data-mcat='gastos']")
    if (!yearsList.length || !yearData) {
        if (section) section.classList.add("hidden")
        if (gastosKpiRow) gastosKpiRow.style.display = "none"
        return
    }
    if (section) section.classList.remove("hidden")
    if (gastosKpiRow) gastosKpiRow.style.display = ""

    const { totalMes, totalTipo, totalMensualidades, totalMovimientos } = mComputeGastosData(yearData)
    const totalGeneral = totalMensualidades + totalMovimientos

    mSetKpi("mkpiGastosTotal", formatEuro(totalGeneral))
    mSetKpi("mkpiGastosMensualidades", formatEuro(totalMensualidades))
    mSetKpi("mkpiGastosMovimientos", formatEuro(totalMovimientos))

    // Year toggle
    const yearToggle = document.getElementById("mGastosYearToggle")
    if (yearToggle) {
        if (!yearToggle.dataset.bound) {
            yearToggle.dataset.bound = "true"
            yearToggle.innerHTML = yearsList
                .map(
                    (y) =>
                        `<button class="mToggleBtn${String(y) === String(yearData.year) ? " active" : ""}" data-gastosyear="${y}">${y}</button>`
                )
                .join("")
            yearToggle.addEventListener("click", async (e) => {
                const btn = e.target.closest("[data-gastosyear]")
                if (!btn) return
                yearToggle.querySelectorAll(".mToggleBtn").forEach((b) => b.classList.remove("active"))
                btn.classList.add("active")
                _metricasGastosMonth = "all"
                setChartPref("metricasGastosMonth", _metricasGastosMonth)
                setChartPref("metricasGastosYear", btn.dataset.gastosyear)
                const newData = await fetch(`/api/gastos/${btn.dataset.gastosyear}`)
                    .then((r) => r.json())
                    .catch(() => null)
                if (newData) {
                    _metricasPayload.gastosYearData = newData
                    const monthToggle = document.getElementById("mGastosMonthToggle")
                    if (monthToggle) {
                        monthToggle.dataset.bound = ""
                        monthToggle.innerHTML = ""
                    }
                    mRenderGastos(yearsList, newData)
                    mRenderComparativa(_metricasPayload.ingresosYearData, newData)
                }
            })
        } else {
            yearToggle
                .querySelectorAll(".mToggleBtn")
                .forEach((b) => b.classList.toggle("active", b.dataset.gastosyear === String(yearData.year)))
        }
    }

    // Month toggle
    const monthToggle = document.getElementById("mGastosMonthToggle")
    if (monthToggle && !monthToggle.dataset.bound) {
        monthToggle.dataset.bound = "true"
        const allBtn = `<button class="mToggleBtn${_metricasGastosMonth === "all" ? " active" : ""}" data-gastosmonth="all">Todos</button>`
        const monthBtns = M_GASTOS_KEYS.map(
            (k, i) =>
                `<button class="mToggleBtn${_metricasGastosMonth === k ? " active" : ""}" data-gastosmonth="${k}">${M_GASTOS_LABELS[i]}</button>`
        ).join("")
        monthToggle.innerHTML = allBtn + monthBtns
        monthToggle.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-gastosmonth]")
            if (!btn) return
            monthToggle.querySelectorAll(".mToggleBtn").forEach((b) => b.classList.remove("active"))
            btn.classList.add("active")
            _metricasGastosMonth = btn.dataset.gastosmonth
            setChartPref("metricasGastosMonth", _metricasGastosMonth)
            mRenderGastosCharts(yearData, totalMes, totalTipo)
        })
    } else if (monthToggle) {
        monthToggle
            .querySelectorAll(".mToggleBtn")
            .forEach((b) => b.classList.toggle("active", b.dataset.gastosmonth === _metricasGastosMonth))
    }

    mRenderGastosCharts(yearData, totalMes, totalTipo)
}

function mRenderGastosCharts(yearData, totalMes, totalTipo) {
    _mGastosChartsCache = { yearData, totalMes, totalTipo }
    const mesTitle = document.getElementById("mGastosMesTitle")
    const tipoTitle = document.getElementById("mGastosTipoTitle")
    const mesWrap = document.getElementById("mChartGastosMesWrap")

    // Left chart: always annual monthly totals, fixed label
    if (mesTitle) mesTitle.textContent = "Tabla Gastos"
    if (mesWrap) mesWrap.style.height = "300px"

    const mesValues = M_GASTOS_KEYS.map((k) => totalMes[k] || 0)
    const mesColors = M_GASTOS_LABELS.map((_, i) => M_PALETTE[i % M_PALETTE.length])
    mCreateChart("mChartGastosMes", {
        type: "bar",
        data: {
            labels: M_GASTOS_LABELS,
            datasets: [
                {
                    label: "Gastos (€)",
                    data: mesValues,
                    backgroundColor: mesColors.map((c) => c + "bb"),
                    borderColor: mesColors,
                    borderWidth: 1,
                    borderRadius: 4
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => ` ${formatEuro(c.raw)}` } }
            },
            scales: { x: mAxisY(11), y: mAxisX() }
        }
    })

    mRenderGastosTiposKpi(totalTipo)

    // Right chart: by month selection
    if (_metricasGastosMonth === "all") {
        if (tipoTitle) tipoTitle.textContent = "Por tipo (anual)"
        mRenderGastosTipoChart(totalTipo)
    } else {
        const monthIdx = M_GASTOS_KEYS.indexOf(_metricasGastosMonth)
        const monthName = M_GASTOS_LABELS[monthIdx] || _metricasGastosMonth
        if (tipoTitle) tipoTitle.textContent = `Por tipo — ${monthName}`

        const monthTipo = {}
        ;(yearData?.months?.[_metricasGastosMonth]?.rows || []).forEach((r) => {
            const val = parseEuroNumber(r.cantidad || "")
            const tipo = (r.tipo || "Sin tipo").trim()
            if (val > 0) monthTipo[tipo] = (monthTipo[tipo] || 0) + val
        })
        const mensTotal = isMensualidadMonthActive(yearData, _metricasGastosMonth)
            ? (yearData?.mensualidades || []).reduce(
                  (s, m) => s + parseEuroNumber(m.meses?.[_metricasGastosMonth] || ""),
                  0
              )
            : 0
        if (mensTotal > 0) monthTipo["Mensualidades"] = (monthTipo["Mensualidades"] || 0) + mensTotal

        mRenderGastosTipoChart(monthTipo)
    }

    mEqualizeChartRowHeights()
}

const M_GASTOS_TIPO_PALETTE = [
    "#e74c3c", // rojo
    "#3498db", // azul claro
    "#2ecc71", // verde
    "#f1c40f", // amarillo
    "#9b59b6", // morado
    "#ff6b35", // naranja
    "#1abc9c", // turquesa
    "#e91e63", // rosa/magenta
    "#00bcd4", // cyan
    "#8bc34a", // verde lima
    "#1a5276", // azul oscuro
    "#a04000" // marrón naranja
]

const M_GASTOS_TIPO_FIXED = {
    compras: "#00bcd4",
    mensualidades: "#3498db",
    "comidas/cenas": "#2ecc71",
    comidas: "#2ecc71",
    gasoil: "#ff6b35",
    otros: "#9b59b6",
    cafe: "#795548",
    café: "#795548"
}

function mGastosTipoColor(label) {
    const key = String(label)
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
    if (M_GASTOS_TIPO_FIXED[key]) return M_GASTOS_TIPO_FIXED[key]
    let hash = 0
    for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) & 0xfffff
    return M_GASTOS_TIPO_PALETTE[hash % M_GASTOS_TIPO_PALETTE.length]
}

function mNormTipo(s) {
    return String(s || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
}

function mRenderGastosTiposKpi(totalTipo) {
    const container = document.getElementById("mkpiGastosTiposCards")
    const group = document.getElementById("mkpiGroupGastosTipos")
    if (!container || !group) return

    const hidden = window._gastosHiddenTipos || []
    const entries = Object.entries(totalTipo || {})
        .filter(([tipo, v]) => v > 0 && !hidden.includes(mNormTipo(tipo)))
        .sort((a, b) => b[1] - a[1])

    if (!entries.length) {
        group.classList.add("hidden")
        return
    }
    group.classList.remove("hidden")
    container.innerHTML = entries
        .map(
            ([tipo, val]) =>
                `<div class="metricasKpiCard"><div class="mkpiLabel">${escapeMetricasHtml(tipo)}</div><div class="mkpiValue">${formatEuro(val)}</div></div>`
        )
        .join("")
}

function escapeMetricasHtml(s) {
    // Alias del escapeHtml común (js/core/dom.js). Había una copia por
    // módulo y no todas escapaban las comillas, que es lo que importa en
    // un atributo value="…".
    return escapeHtml(s)
}

function mRenderGastosTipoChart(tipoData) {
    const tipoEntries = Object.entries(tipoData)
        .filter(([k, v]) => v > 0 && !_metricasGastosTipoFilter.has(k))
        .sort((a, b) => b[1] - a[1])
    if (!tipoEntries.length) {
        mDestroyChart("mChartGastosTipo")
        return
    }
    const tipoLabels = tipoEntries.map(([k]) => k)
    const tipoValues = tipoEntries.map(([, v]) => v)
    const tipoColors = tipoLabels.map((label) => mGastosTipoColor(label))
    const tipoTotal = tipoValues.reduce((a, b) => a + b, 0)
    mCreateChart("mChartGastosTipo", {
        type: "doughnut",
        data: {
            labels: tipoLabels,
            datasets: [
                {
                    data: tipoValues,
                    backgroundColor: tipoColors,
                    borderColor: "#0b1120",
                    borderWidth: 2,
                    hoverOffset: 10
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            cutout: "55%",
            onClick: (_e, elements) => {
                if (!elements.length) return
                openGastosTipoPopup(tipoLabels[elements[0].index])
            },
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { ...M_CHART_DEFAULTS.plugins.legend, position: "bottom" },
                tooltip: { callbacks: { label: (c) => mGridTooltip(c.label, c.raw, tipoTotal) } }
            }
        }
    })
    const canvas = document.getElementById("mChartGastosTipo")
    if (canvas) canvas.style.cursor = "pointer"
}

function openGastosTipoPopup(tipoLabel) {
    const cache = _mGastosChartsCache
    if (!cache) return
    const { yearData } = cache
    const monthScope = _metricasGastosMonth === "all" ? M_GASTOS_KEYS : [_metricasGastosMonth]

    const rows = []
    if (tipoLabel === "Mensualidades") {
        ;(yearData?.mensualidades || []).forEach((m) => {
            monthScope.forEach((mk) => {
                if (!isMensualidadMonthActive(yearData, mk)) return
                const val = parseEuroNumber(m.meses?.[mk] || "")
                if (val > 0)
                    rows.push({
                        fecha: "—",
                        mes: M_GASTOS_LABELS[M_GASTOS_KEYS.indexOf(mk)] || mk,
                        nombre: m.nombre || "—",
                        cuenta: nombreDeCuenta(m.cuenta),
                        cantidad: val
                    })
            })
        })
    } else {
        monthScope.forEach((mk) => {
            ;(yearData?.months?.[mk]?.rows || []).forEach((r) => {
                if ((r.tipo || "Sin tipo").trim() === tipoLabel) {
                    rows.push({
                        fecha: r.fecha || "—",
                        mes: M_GASTOS_LABELS[M_GASTOS_KEYS.indexOf(mk)] || mk,
                        nombre: r.nombre || "—",
                        cuenta: nombreDeCuenta(r.cuenta),
                        cantidad: parseEuroNumber(r.cantidad || "")
                    })
                }
            })
        })
    }

    document.getElementById("gastosTipoPopup")?.remove()

    const mainContent = document.querySelector(".mainContent")
    if (!mainContent) return
    const rect = mainContent.getBoundingClientRect()
    const total = rows.reduce((s, r) => s + r.cantidad, 0)

    const tableRows = rows
        .map(
            (r) => `
        <tr data-nombre="${escapeHtml((r.nombre || "").toLowerCase())}" data-cantidad="${escapeHtml(r.cantidad)}">
            <td>${escapeHtml(r.fecha)}</td>
            <td>${escapeHtml(r.mes)}</td>
            <td>${escapeHtml(r.nombre)}</td>
            <td>${escapeGastosHtml(r.cuenta)}</td>
            <td style="text-align:right">${formatEuro(r.cantidad)}</td>
        </tr>`
        )
        .join("")

    const popupW = Math.round(rect.width * 0.92)
    const popupH = Math.round(rect.height * 0.82)
    const popupL = rect.left + Math.round((rect.width - popupW) / 2)
    const popupT = rect.top + Math.round((rect.height - popupH) / 2)

    const backdrop = document.createElement("div")
    backdrop.id = "gastosTipoBackdrop"
    backdrop.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:899;cursor:default;`

    const popup = document.createElement("div")
    popup.id = "gastosTipoPopup"
    popup.className = "gtPopup"
    popup.style.cssText = `position:fixed;top:${popupT}px;left:${popupL}px;width:${popupW}px;height:${popupH}px;z-index:900;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,0.6);`
    popup.innerHTML = `
        <div class="gtPopupHeader">
            <span class="gtPopupTitle">Gastos · ${escapeHtml(tipoLabel)}</span>
            <input type="text" id="gtPopupSearch" class="gtPopupSearch" placeholder="Buscar concepto...">
            <span class="gtPopupTotal" id="gtPopupTotalLabel">Total: ${formatEuro(total)} · ${escapeHtml(rows.length)} movimientos</span>
            <button class="gtPopupClose" id="gtPopupCloseBtn">✕</button>
        </div>
        <div class="gtPopupBody">
            <table class="overviewTable gtPopupTable" id="gtPopupTable">
                <colgroup>
                    <col style="width:130px">
                    <col style="width:80px">
                    <col>
                    <col style="width:170px">
                    <col style="width:110px">
                </colgroup>
                <thead>
                    <tr>
                        <th class="mThSort" data-sortkey="0">Fecha <span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="1">Mes <span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="2" style="text-align:left">Concepto <span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="3" style="text-align:left">Cuenta <span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="4" style="text-align:right">Importe <span class="mSortArrow"></span></th>
                    </tr>
                </thead>
                <tbody>${tableRows}
                    <tr class="gtTotalRow" id="gtTotalRow">
                        <td colspan="4"><strong>Total</strong></td>
                        <td style="text-align:right" id="gtTotalCell"><strong>${formatEuro(total)}</strong></td>
                    </tr>
                </tbody>
            </table>
        </div>`

    const closePopup = () => {
        backdrop.remove()
        popup.remove()
    }
    backdrop.addEventListener("click", closePopup)
    document.body.appendChild(backdrop)
    document.body.appendChild(popup)
    document.getElementById("gtPopupCloseBtn")?.addEventListener("click", closePopup)
    const table = document.getElementById("gtPopupTable")
    if (table) bindTableSort(table, "metricasGt")

    const searchInput = document.getElementById("gtPopupSearch")
    if (searchInput) {
        searchInput.addEventListener("input", () => {
            const q = searchInput.value.trim().toLowerCase()
            let filtTotal = 0,
                filtCount = 0
            table?.querySelectorAll("tbody tr:not(.gtTotalRow)").forEach((tr) => {
                const match = !q || (tr.dataset.nombre || "").includes(q)
                tr.style.display = match ? "" : "none"
                if (match) {
                    filtTotal += parseFloat(tr.dataset.cantidad) || 0
                    filtCount++
                }
            })
            document.getElementById("gtTotalCell").innerHTML = `<strong>${formatEuro(filtTotal)}</strong>`
            document.getElementById("gtPopupTotalLabel").textContent =
                `Total: ${formatEuro(filtTotal)} · ${filtCount} movimientos`
        })
        searchInput.focus()
    }
}

// ── top-positions table ────────────────────────────────────────────────────

function mSortSummaries(summaries) {
    const totalCuenta = summaries.reduce((s, a) => s + Math.max(0, a.netoActualEur), 0)

    const withDerived = summaries.map((a) => ({
        ...a,
        rendPct: a.invertidoEur > 0 ? (a.rendimientoEur / a.invertidoEur) * 100 : 0,
        cartPct: totalCuenta > 0 ? (Math.max(0, a.netoActualEur) / totalCuenta) * 100 : 0
    }))

    const key = _metricasSortKey
    const dir = _metricasSortDir === "asc" ? 1 : -1

    withDerived.sort((a, b) => {
        const isStr = key === "name" || key === "type"
        const va = isStr ? (a[key] || "").toLowerCase() : (a[key] ?? 0)
        const vb = isStr ? (b[key] || "").toLowerCase() : (b[key] ?? 0)
        if (va < vb) return -dir
        if (va > vb) return dir
        return 0
    })

    return withDerived
}

function mUpdateSortArrows() {
    document.querySelectorAll(".mThSort").forEach((th) => {
        const arrow = th.querySelector(".mSortArrow")
        if (!arrow) return
        if (th.dataset.sortkey === _metricasSortKey) {
            arrow.textContent = _metricasSortDir === "asc" ? " ▲" : " ▼"
            th.classList.add("mThActive")
        } else {
            arrow.textContent = ""
            th.classList.remove("mThActive")
        }
    })
}

function mRenderTopTable(summaries) {
    const tbody = document.getElementById("metricasTopBody")
    if (!tbody) return

    const rows = mSortSummaries(summaries)

    tbody.innerHTML = rows
        .map((a, idx) => {
            const rClass = a.rendimientoEur >= 0 ? "mCellPos" : "mCellNeg"
            const typeLabel = M_TYPE_LABELS[a.type] || a.type
            const typeColor = M_TYPE_COLORS[a.type] || "#888"

            return `
        <tr>
            <td class="mTdRank">${idx + 1}</td>
            <td class="mTdName">${escapeMetricasHtml(a.name)}</td>
            <td><span class="mTypeBadge" style="background:${typeColor}22;color:${typeColor};border-color:${typeColor}44">${typeLabel}</span></td>
            <td>${formatEuro(a.netoActualEur)}</td>
            <td>${formatEuro(a.invertidoEur)}</td>
            <td class="${rClass}">${formatEuro(a.rendimientoEur)}</td>
            <td class="${rClass}">${formatPercent(a.rendPct)}</td>
            <td>
                <div class="mCartBar">
                    <div class="mCartBarFill" style="width:${Math.min(100, a.cartPct).toFixed(1)}%"></div>
                    <span>${a.cartPct.toFixed(1)} %</span>
                </div>
            </td>
        </tr>`
        })
        .join("")

    mUpdateSortArrows()
}

function mBindTableSort(summaries) {
    document.querySelectorAll(".mThSort").forEach((th) => {
        th.addEventListener("click", () => {
            const key = th.dataset.sortkey
            if (_metricasSortKey === key) {
                _metricasSortDir = _metricasSortDir === "asc" ? "desc" : "asc"
            } else {
                _metricasSortKey = key
                _metricasSortDir = "desc"
            }
            setChartPref("metricasSortKey", _metricasSortKey)
            setChartPref("metricasSortDir", _metricasSortDir)
            mRenderTopTable(summaries)
        })
    })
}

function mRenderIngresos(ingresosYearData) {
    const group = document.querySelector(".mkpiGroupIngresosPersonales")
    if (!group) return

    if (!ingresosYearData) {
        mSetKpi("mkpiIngresosTotal", "---")
        mSetKpi("mkpiIngresosRecurrentes", "---")
        mSetKpi("mkpiIngresosMovimientos", "---")
        return
    }

    const M_ING_KEYS = [
        "enero",
        "febrero",
        "marzo",
        "abril",
        "mayo",
        "junio",
        "julio",
        "agosto",
        "septiembre",
        "octubre",
        "noviembre",
        "diciembre"
    ]

    const totalRecurrentes = (ingresosYearData.recurrentes || []).reduce(
        (s, row) => s + M_ING_KEYS.reduce((ms, k) => ms + parseEuroNumber(row.meses?.[k] || ""), 0),
        0
    )

    const totalMovimientos = Object.values(ingresosYearData.months || {}).reduce(
        (s, monthData) => s + (monthData?.rows || []).reduce((ms, row) => ms + parseEuroNumber(row.cantidad || ""), 0),
        0
    )

    mSetKpi("mkpiIngresosTotal", formatEuro(totalRecurrentes + totalMovimientos))
    mSetKpi("mkpiIngresosRecurrentes", formatEuro(totalRecurrentes))
    mSetKpi("mkpiIngresosMovimientos", formatEuro(totalMovimientos))
}

// ── ingresos charts ────────────────────────────────────────────────────────

const M_ING_KEYS = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre"
]
const M_ING_LABELS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]

function mComputeIngresosMonthly(ingresosYearData) {
    const totals = Object.fromEntries(M_ING_KEYS.map((k) => [k, 0]))
    ;(ingresosYearData?.recurrentes || []).forEach((row) => {
        M_ING_KEYS.forEach((k) => {
            totals[k] += parseEuroNumber(row.meses?.[k] || "")
        })
    })
    M_ING_KEYS.forEach((k) => {
        ;(ingresosYearData?.months?.[k]?.rows || []).forEach((row) => {
            totals[k] += parseEuroNumber(row.cantidad || "")
        })
    })
    return totals
}

function mComputeIngresosTipo(ingresosYearData, monthKey) {
    const totals = {}
    if (monthKey === "all") {
        ;(ingresosYearData?.recurrentes || []).forEach((row) => {
            const nombre = (row.nombre || "Recurrentes").trim()
            const sub = M_ING_KEYS.reduce((s, k) => s + parseEuroNumber(row.meses?.[k] || ""), 0)
            if (sub > 0) totals[nombre] = (totals[nombre] || 0) + sub
        })
        M_ING_KEYS.forEach((k) => {
            ;(ingresosYearData?.months?.[k]?.rows || []).forEach((row) => {
                const tipo = (row.tipo || "Sin tipo").trim()
                const val = parseEuroNumber(row.cantidad || "")
                if (val > 0) totals[tipo] = (totals[tipo] || 0) + val
            })
        })
    } else {
        ;(ingresosYearData?.recurrentes || []).forEach((row) => {
            const nombre = (row.nombre || "Recurrentes").trim()
            const val = parseEuroNumber(row.meses?.[monthKey] || "")
            if (val > 0) totals[nombre] = (totals[nombre] || 0) + val
        })
        ;(ingresosYearData?.months?.[monthKey]?.rows || []).forEach((row) => {
            const tipo = (row.tipo || "Sin tipo").trim()
            const val = parseEuroNumber(row.cantidad || "")
            if (val > 0) totals[tipo] = (totals[tipo] || 0) + val
        })
    }
    return totals
}

function mRenderIngresosCharts(ingresosYearData) {
    const totalMes = mComputeIngresosMonthly(ingresosYearData)
    const totalTipo = mComputeIngresosTipo(ingresosYearData, _metricasIngresosMonth)

    const mesWrap = document.getElementById("mChartIngresosMesWrap")
    if (mesWrap) mesWrap.style.height = "280px"

    const mesValues = M_ING_KEYS.map((k) => totalMes[k] || 0)
    const mesColors = M_ING_LABELS.map((_, i) => M_PALETTE[i % M_PALETTE.length])
    mCreateChart("mChartIngresosMes", {
        type: "bar",
        data: {
            labels: M_ING_LABELS,
            datasets: [
                {
                    label: "Ingresos (€)",
                    data: mesValues,
                    backgroundColor: mesColors.map((c) => c + "bb"),
                    borderColor: mesColors,
                    borderWidth: 1,
                    borderRadius: 4
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => ` ${formatEuro(c.raw)}` } }
            },
            scales: { x: mAxisY(11), y: mAxisX() }
        }
    })

    const tipoEntries = Object.entries(totalTipo).sort((a, b) => b[1] - a[1])
    if (tipoEntries.length) {
        const tipoLabels = tipoEntries.map(([k]) => k)
        const tipoValues = tipoEntries.map(([, v]) => v)
        const tipoColors = tipoLabels.map((_, i) => M_PALETTE[i % M_PALETTE.length])
        const tipoTotal = tipoValues.reduce((a, b) => a + b, 0)
        mCreateChart("mChartIngresosTipo", {
            type: "doughnut",
            data: {
                labels: tipoLabels,
                datasets: [
                    {
                        data: tipoValues,
                        backgroundColor: tipoColors,
                        borderColor: "#0b1120",
                        borderWidth: 2,
                        hoverOffset: 10
                    }
                ]
            },
            options: {
                ...M_CHART_DEFAULTS,
                cutout: "55%",
                plugins: {
                    ...M_CHART_DEFAULTS.plugins,
                    legend: { ...M_CHART_DEFAULTS.plugins.legend, position: "bottom" },
                    tooltip: { callbacks: { label: (c) => mGridTooltip(c.label, c.raw, tipoTotal) } }
                }
            }
        })
    } else {
        mDestroyChart("mChartIngresosTipo")
    }

    mEqualizeChartRowHeights()
}

function mRenderIngresosSection(ingresosYearsList, ingresosYearData) {
    const section = document.getElementById("mSectionIngresos")
    const ingresosKpiRow = document.querySelector(".metricasKpiRow[data-mcat='ingresos']")
    if (!ingresosYearsList.length || !ingresosYearData) {
        if (section) section.classList.add("hidden")
        if (ingresosKpiRow) ingresosKpiRow.style.display = "none"
        return
    }
    if (section) section.classList.remove("hidden")
    if (ingresosKpiRow) ingresosKpiRow.style.display = ""

    const yearToggle = document.getElementById("mIngresosYearToggle")
    if (yearToggle && !yearToggle.dataset.bound) {
        yearToggle.dataset.bound = "true"
        yearToggle.innerHTML = ingresosYearsList
            .map(
                (y) =>
                    `<button class="mToggleBtn${String(y) === String(ingresosYearData.year) ? " active" : ""}" data-ingresosyear="${y}">${y}</button>`
            )
            .join("")
        yearToggle.addEventListener("click", async (e) => {
            const btn = e.target.closest("[data-ingresosyear]")
            if (!btn) return
            yearToggle.querySelectorAll(".mToggleBtn").forEach((b) => b.classList.remove("active"))
            btn.classList.add("active")
            _metricasIngresosMonth = "all"
            setChartPref("metricasIngresosMonth", _metricasIngresosMonth)
            setChartPref("metricasIngresosYear", btn.dataset.ingresosyear)
            const newData = await fetch(`/api/ingresos/${btn.dataset.ingresosyear}`)
                .then((r) => r.json())
                .catch(() => null)
            if (newData) {
                _metricasPayload.ingresosYearData = newData
                const mt = document.getElementById("mIngresosMonthToggle")
                if (mt) {
                    mt.dataset.bound = ""
                    mt.innerHTML = ""
                }
                mRenderIngresosSection(ingresosYearsList, newData)
                mRenderComparativa(_metricasPayload.ingresosYearData, _metricasPayload.gastosYearData)
            }
        })
    } else if (yearToggle) {
        yearToggle
            .querySelectorAll(".mToggleBtn")
            .forEach((b) => b.classList.toggle("active", b.dataset.ingresosyear === String(ingresosYearData.year)))
    }

    const monthToggle = document.getElementById("mIngresosMonthToggle")
    const tipoTitle = document.getElementById("mIngresosTipoTitle")
    if (monthToggle && !monthToggle.dataset.bound) {
        monthToggle.dataset.bound = "true"
        const allBtn = `<button class="mToggleBtn${_metricasIngresosMonth === "all" ? " active" : ""}" data-ingresosmonth="all">Todos</button>`
        const monthBtns = M_ING_KEYS.map(
            (k, i) =>
                `<button class="mToggleBtn${_metricasIngresosMonth === k ? " active" : ""}" data-ingresosmonth="${k}">${M_ING_LABELS[i]}</button>`
        ).join("")
        monthToggle.innerHTML = allBtn + monthBtns
        monthToggle.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-ingresosmonth]")
            if (!btn) return
            monthToggle.querySelectorAll(".mToggleBtn").forEach((b) => b.classList.remove("active"))
            btn.classList.add("active")
            _metricasIngresosMonth = btn.dataset.ingresosmonth
            setChartPref("metricasIngresosMonth", _metricasIngresosMonth)
            if (tipoTitle)
                tipoTitle.textContent =
                    _metricasIngresosMonth === "all"
                        ? "Por tipo (anual)"
                        : `Por tipo — ${M_ING_LABELS[M_ING_KEYS.indexOf(_metricasIngresosMonth)] || _metricasIngresosMonth}`
            mRenderIngresosCharts(ingresosYearData)
        })
    } else if (monthToggle) {
        monthToggle
            .querySelectorAll(".mToggleBtn")
            .forEach((b) => b.classList.toggle("active", b.dataset.ingresosmonth === _metricasIngresosMonth))
    }

    if (tipoTitle)
        tipoTitle.textContent =
            _metricasIngresosMonth === "all"
                ? "Por tipo (anual)"
                : `Por tipo — ${M_ING_LABELS[M_ING_KEYS.indexOf(_metricasIngresosMonth)] || _metricasIngresosMonth}`
    mRenderIngresosCharts(ingresosYearData)
}

// ── intereses mensuales ────────────────────────────────────────────────────

let _metricasInteresesYear = getChartPref("metricasInteresesYear", null)

const _CUENTA_COLORS = [
    "#3a7bd5",
    "#2ecc71",
    "#e67e22",
    "#9b59b6",
    "#1abc9c",
    "#e74c3c",
    "#f39c12",
    "#00cec9",
    "#fd79a8",
    "#6c5ce7"
]

function intYear(fecha) {
    const p = String(fecha || "").split("-")
    const raw = p.length === 3 ? p[2] : p.length === 2 ? p[1] : null
    if (!raw) return null
    const yr = mParseShortYear(raw)
    return yr ? String(yr) : null
}
function intMonth(fecha) {
    const p = String(fecha || "").split("-")
    let s
    if (p.length === 3) s = p[1]
    else if (p.length === 2) s = p[0]
    else return -1
    const mon = mParseEsMonth(s) || parseInt(s)
    return mon >= 1 && mon <= 12 ? mon - 1 : -1
}

function mRenderInteresesSection(interesRows, cuentas) {
    const section = document.getElementById("mSectionIntereses")
    const rows = Array.isArray(interesRows) ? interesRows : []
    if (!rows.length) {
        if (section) section.classList.add("hidden")
        return
    }
    if (section) section.classList.remove("hidden")

    const years = [...new Set(rows.map((r) => intYear(r.fecha)).filter(Boolean))].sort((a, b) => Number(a) - Number(b))
    if (!_metricasInteresesYear || !years.includes(_metricasInteresesYear))
        _metricasInteresesYear = years[years.length - 1] || null

    const yearToggle = document.getElementById("mInteresesYearToggle")
    if (yearToggle) {
        yearToggle.innerHTML = years
            .map(
                (y) =>
                    `<button class="mToggleBtn${y === _metricasInteresesYear ? " active" : ""}" data-intano="${y}">${y}</button>`
            )
            .join("")
        if (!yearToggle.dataset.bound) {
            yearToggle.dataset.bound = "true"
            yearToggle.addEventListener("click", (e) => {
                const btn = e.target.closest("[data-intano]")
                if (!btn) return
                yearToggle.querySelectorAll(".mToggleBtn").forEach((b) => b.classList.remove("active"))
                btn.classList.add("active")
                _metricasInteresesYear = btn.dataset.intano
                setChartPref("metricasInteresesYear", _metricasInteresesYear)
                mDrawInteresesChart(cuentas, _metricasInteresesYear)
            })
        }
    }

    mDrawInteresesChart(cuentas, _metricasInteresesYear)
}

function mDrawInteresesChart(cuentas, year) {
    const labels = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]
    const cuentasList = Array.isArray(cuentas) && cuentas.length ? cuentas : []

    // Por mes: totales y desglose por cuenta
    const monthAcum = Array(12).fill(0)
    const monthNet = Array(12).fill(0)
    // desglose[mes] = [{ nombre, acum, neto }]
    const desglose = Array.from({ length: 12 }, () => [])

    cuentasList.forEach((cuenta) => {
        const cuentaRows = Array.isArray(cuenta.rows) ? cuenta.rows : []
        cuentaRows
            .filter((r) => intYear(r.fecha) === year)
            .forEach((r) => {
                const m = intMonth(r.fecha)
                if (m < 0 || m > 11) return
                const acum = parseEuroNumber(r.acumulado || "")
                const imp = parseEuroNumber(r.impuestos || "")
                const neto = acum - imp
                monthAcum[m] += acum
                monthNet[m] += neto
                const existing = desglose[m].find((d) => d.nombre === cuenta.nombre)
                if (existing) {
                    existing.acum += acum
                    existing.neto += neto
                } else desglose[m].push({ nombre: cuenta.nombre, acum, neto })
            })
    })

    const netColors = monthNet.map((v) => (v >= 0 ? "#2ecc71" : "#e74c3c"))

    mCreateChart("mChartIntereses", {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: "Acumulado",
                    data: monthAcum,
                    backgroundColor: "#3a7bd544",
                    borderColor: "#3a7bd5",
                    borderWidth: 1,
                    borderRadius: 4
                },
                {
                    label: "Neto",
                    data: monthNet,
                    backgroundColor: netColors.map((c) => c + "bb"),
                    borderColor: netColors,
                    borderWidth: 1,
                    borderRadius: 4
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                tooltip: {
                    callbacks: {
                        label: (c) => ` ${c.dataset.label}: ${formatEuro(c.raw)}`,
                        afterLabel: (c) => {
                            const mes = c.dataIndex
                            if (!desglose[mes] || !desglose[mes].length) return []
                            const isAcum = c.datasetIndex === 0
                            return desglose[mes].map((d) => `  · ${d.nombre}: ${formatEuro(isAcum ? d.acum : d.neto)}`)
                        }
                    }
                }
            },
            scales: { x: mAxisX(), y: mAxisY() }
        }
    })
}

// ── comparativa ingresos vs gastos ─────────────────────────────────────────

function mRenderComparativa(ingresosYearData, gastosYearData) {
    const section = document.getElementById("mSectionComparativa")
    if (!ingresosYearData && !gastosYearData) {
        if (section) section.classList.add("hidden")
        return
    }
    if (section) section.classList.remove("hidden")

    // Collect all tipos de gastos (movimientos rows)
    const tiposSet = new Set()
    Object.values(gastosYearData?.months || {}).forEach((monthData) => {
        ;(monthData?.rows || []).forEach((row) => {
            tiposSet.add((row.tipo || "Sin tipo").trim())
        })
    })
    const hasMensualidades = (gastosYearData?.mensualidades || []).length > 0
    if (hasMensualidades) tiposSet.add("Mensualidades")
    const allTipos = [...tiposSet].sort()

    // Render filter buttons — always rebuild so listener always sees current year data
    const filtrosEl = document.getElementById("mComparativaFiltros")
    if (filtrosEl) {
        filtrosEl.innerHTML = allTipos
            .map(
                (t) =>
                    `<label class="mActivosFilterBtn" data-cmp-tipo="${t}"><input type="checkbox"${_metricasComparativaExclude.has(t) ? "" : " checked"}><span>${t}</span></label>`
            )
            .join("")
        filtrosEl.onchange = (e) => {
            const input = e.target
            if (!input.matches('input[type="checkbox"]')) return
            const label = input.closest("[data-cmp-tipo]")
            if (!label) return
            const tipo = label.dataset.cmpTipo
            if (input.checked) {
                _metricasComparativaExclude.delete(tipo)
            } else {
                _metricasComparativaExclude.add(tipo)
            }
            mDrawComparativaChart(_metricasPayload.ingresosYearData, _metricasPayload.gastosYearData)
            fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ comparativaExcluded: [..._metricasComparativaExclude] })
            }).catch(() => {})
        }
    }

    mDrawComparativaChart(ingresosYearData, gastosYearData)
}

function mDrawComparativaChart(ingresosYearData, gastosYearData) {
    const ingMonthly = M_ING_KEYS.map((k) => {
        let t = 0
        ;(ingresosYearData?.recurrentes || []).forEach((r) => {
            t += parseEuroNumber(r.meses?.[k] || "")
        })
        ;(ingresosYearData?.months?.[k]?.rows || []).forEach((r) => {
            t += parseEuroNumber(r.cantidad || "")
        })
        return t
    })

    const gastosDetalle = M_GASTOS_KEYS.map((k) => {
        const detalle = {}
        if (!_metricasComparativaExclude.has("Mensualidades") && isMensualidadMonthActive(gastosYearData, k)) {
            const mens = (gastosYearData?.mensualidades || []).reduce(
                (s, r) => s + parseEuroNumber(r.meses?.[k] || ""),
                0
            )
            if (mens > 0) detalle["Mensualidades"] = mens
        }
        ;(gastosYearData?.months?.[k]?.rows || []).forEach((row) => {
            const tipo = (row.tipo || "Sin tipo").trim()
            if (!_metricasComparativaExclude.has(tipo)) {
                const val = parseEuroNumber(row.cantidad || "")
                if (val > 0) detalle[tipo] = (detalle[tipo] || 0) + val
            }
        })
        return detalle
    })

    const gastosMonthly = gastosDetalle.map((d) => Object.values(d).reduce((s, v) => s + v, 0))

    const balance = ingMonthly.map((ing, i) => ing - gastosMonthly[i])

    mDrawComparativaLineChart(ingMonthly, gastosMonthly)

    mCreateChart("mChartComparativa", {
        type: "bar",
        data: {
            labels: M_ING_LABELS,
            datasets: [
                {
                    label: "Ingresos",
                    data: ingMonthly,
                    backgroundColor: "#2ecc7188",
                    borderColor: "#2ecc71",
                    borderWidth: 1,
                    borderRadius: 4
                },
                {
                    label: "Gastos",
                    data: gastosMonthly,
                    backgroundColor: "#e74c3c88",
                    borderColor: "#e74c3c",
                    borderWidth: 1,
                    borderRadius: 4
                },
                {
                    label: "Balance",
                    data: balance,
                    backgroundColor: balance.map((v) => (v >= 0 ? "#3a7bd577" : "#e74c3c44")),
                    borderColor: balance.map((v) => (v >= 0 ? "#3a7bd5" : "#e74c3c")),
                    borderWidth: 1,
                    borderRadius: 4
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                tooltip: {
                    callbacks: {
                        label: (c) => ` ${c.dataset.label}: ${formatEuro(c.raw)}`,
                        afterLabel: (c) => {
                            if (c.dataset.label !== "Gastos") return []
                            return Object.entries(gastosDetalle[c.dataIndex])
                                .sort((a, b) => b[1] - a[1])
                                .map(([tipo, val]) => `  · ${tipo}: ${formatEuro(val)}`)
                        }
                    }
                }
            },
            scales: { x: mAxisX(), y: mAxisY() }
        }
    })
}

function mDrawComparativaLineChart(ingMonthly, gastosMonthly) {
    const labels = M_ING_LABELS

    // find max visible month (last month with any data)
    let lastIdx = -1
    for (let i = 0; i < 12; i++) {
        if (ingMonthly[i] > 0 || gastosMonthly[i] > 0) lastIdx = i
    }
    const visibleLabels = lastIdx >= 0 ? labels.slice(0, lastIdx + 1) : labels
    const visibleIngresos = lastIdx >= 0 ? ingMonthly.slice(0, lastIdx + 1) : ingMonthly
    const visibleGastos = lastIdx >= 0 ? gastosMonthly.slice(0, lastIdx + 1) : gastosMonthly

    mCreateChart("mChartComparativaLinea", {
        type: "line",
        data: {
            labels: visibleLabels,
            datasets: [
                {
                    label: "Ingresos",
                    data: visibleIngresos,
                    borderColor: "#2ecc71",
                    backgroundColor: "rgba(46,204,113,0.12)",
                    borderWidth: 2.5,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    pointBackgroundColor: "#2ecc71",
                    tension: 0.35,
                    fill: false
                },
                {
                    label: "Gastos",
                    data: visibleGastos,
                    borderColor: "#e74c3c",
                    backgroundColor: "rgba(231,76,60,0.12)",
                    borderWidth: 2.5,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    pointBackgroundColor: "#e74c3c",
                    tension: 0.35,
                    fill: false
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            interaction: { mode: "index", intersect: false },
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                tooltip: {
                    callbacks: {
                        label: (c) => ` ${c.dataset.label}: ${formatEuro(c.raw)}`,
                        afterBody: (items) => {
                            const ing = items.find((i) => i.dataset.label === "Ingresos")?.raw ?? 0
                            const gas = items.find((i) => i.dataset.label === "Gastos")?.raw ?? 0
                            const bal = ing - gas
                            return [`Balance: ${formatEuro(bal)}`]
                        }
                    }
                }
            },
            scales: {
                x: mAxisX(),
                y: {
                    ...mAxisY(),
                    ticks: {
                        color: "#8899bb",
                        callback: (v) => formatEuro(v)
                    }
                }
            }
        }
    })
}

// ── evolución del saldo durante el mes ─────────────────────────────────────

// Día a día: arranca en los ingresos recurrentes del mes, suma cada ingreso en
// su fecha y resta cada gasto en la suya; las mensualidades se restan en
// su día de cobro (el día 1 si no tiene).
function mComputeSaldoMesSeries(ingresosYearData, gastosYearData, year, monthKey) {
    const monthIdx = M_GASTOS_KEYS.indexOf(monthKey)
    const daysInMonth = new Date(Number(year), monthIdx + 1, 0).getDate()

    let startBalance = 0
    ;(ingresosYearData?.recurrentes || []).forEach((r) => {
        startBalance += parseEuroNumber(r.meses?.[monthKey] || "")
    })

    const deltaPorDia = Array(daysInMonth + 1).fill(0)
    const movs = Array.from({ length: daysInMonth + 1 }, () => [])
    const dayOf = (fecha) => {
        const d = parseInt(String(fecha || "").split("-")[0], 10)
        return d >= 1 && d <= daysInMonth ? d : 1
    }

    // Lo cobrado en otra cuenta (ahorro, exchange…) no entra en la cuenta bancaria.
    ;(ingresosYearData?.months?.[monthKey]?.rows || []).forEach((row) => {
        const val = parseEuroNumber(row.cantidad || "")
        if (val <= 0 || row.cuenta) return
        const d = dayOf(row.fecha)
        deltaPorDia[d] += val
        movs[d].push({ nombre: row.nombre || row.tipo || "Ingreso", importe: val })
    })

    if (isMensualidadMonthActive(gastosYearData, monthKey)) {
        ;(gastosYearData?.mensualidades || []).forEach((m) => {
            const val = parseEuroNumber(m.meses?.[monthKey] || "")
            if (val <= 0) return
            const d = Math.min(Number(getMensualidadDiaMes(m, monthKey)) || 1, daysInMonth)
            deltaPorDia[d] -= val
            movs[d].push({ nombre: m.nombre || "Mensualidad", importe: -val })
        })
    }
    ;(gastosYearData?.months?.[monthKey]?.rows || []).forEach((row) => {
        const val = parseEuroNumber(row.cantidad || "")
        if (val <= 0 || row.cuenta) return
        const d = dayOf(row.fecha)
        deltaPorDia[d] -= val
        movs[d].push({ nombre: row.nombre || row.tipo || "Gasto", importe: -val })
    })

    // Dinero que sale hacia otras cuentas, o que vuelve de ellas.
    _metricasTransferencias.forEach((t) => {
        if (t.year !== String(year) || t.month !== monthKey) return
        const val = parseEuroNumber(t.cantidad || "")
        if (val <= 0) return
        const signo = t.origen === "banco" ? -1 : t.destino === "banco" ? 1 : 0
        if (!signo) return
        const d = dayOf(t.fecha)
        deltaPorDia[d] += signo * val
        const otra = signo < 0 ? t.destino_nombre : t.origen_nombre
        movs[d].push({
            nombre: t.concepto || (signo < 0 ? `Transferencia a ${otra}` : `Transferencia desde ${otra}`),
            importe: signo * val
        })

        // La comisión sale de la cuenta de origen además de la cantidad.
        const comision = parseEuroNumber(t.comision || "")
        if (comision > 0 && t.origen === "banco") {
            deltaPorDia[d] -= comision
            movs[d].push({ nombre: `Comisión${t.concepto ? " · " + t.concepto : ""}`, importe: -comision })
        }
    })

    const dayLabels = ["Inicio"]
    const balances = [startBalance]
    const movimientos = [[]]
    let running = startBalance
    for (let d = 1; d <= daysInMonth; d++) {
        running += deltaPorDia[d]
        dayLabels.push(String(d))
        balances.push(running)
        movimientos.push(movs[d])
    }

    return { dayLabels, balances, startBalance, movimientos }
}

function mRenderSaldoMesChart(ingresosYearData, gastosYearData, year, monthKey) {
    const { dayLabels, balances, startBalance, movimientos } = mComputeSaldoMesSeries(
        ingresosYearData,
        gastosYearData,
        year,
        monthKey
    )

    const notaEl = document.getElementById("mSaldoMesNota")
    if (notaEl) {
        const finBalance = balances[balances.length - 1]
        notaEl.textContent = `Saldo inicial: ${formatEuro(startBalance)} · Saldo final: ${formatEuro(finBalance)}`
    }

    mCreateChart("mChartSaldoMes", {
        type: "line",
        data: {
            labels: dayLabels,
            datasets: [
                {
                    label: "Saldo",
                    data: balances,
                    cubicInterpolationMode: "monotone",
                    borderColor: "#3a7bd5",
                    backgroundColor: "rgba(58,123,213,0.14)",
                    borderWidth: 2.5,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    pointBackgroundColor: "#3a7bd5",
                    fill: true
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            interaction: { mode: "index", intersect: false },
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: (items) => (items[0].label === "Inicio" ? "Inicio de mes" : `Día ${items[0].label}`),
                        label: (c) => ` Saldo: ${formatEuro(c.raw)}`,
                        afterBody: (items) => {
                            const lista = movimientos[items[0].dataIndex] || []
                            if (!lista.length) return []
                            const lines = lista.map(
                                (m) => `${m.importe > 0 ? "+" : "−"} ${m.nombre}: ${formatEuro(Math.abs(m.importe))}`
                            )
                            return ["", ...lines]
                        }
                    }
                }
            },
            scales: {
                x: mAxisX(),
                y: { ...mAxisY(), ticks: { color: "#8899bb", callback: (v) => formatEuro(v) } }
            }
        }
    })
}

function mSaldoMesDefaultMonth(year) {
    const now = new Date()
    if (Number(year) === now.getFullYear()) return M_GASTOS_KEYS[now.getMonth()]
    return "enero"
}

function mRenderSaldoMes(ingresosYearsList, ingresosYearData, gastosYearData) {
    const section = document.getElementById("mSectionSaldoMes")
    if (!ingresosYearsList.length || !ingresosYearData) {
        if (section) section.classList.add("hidden")
        return
    }
    if (section) section.classList.remove("hidden")

    const year = ingresosYearData.year
    _mSaldoMesCache = { ingresosYearData, gastosYearData }

    if (!_metricasSaldoMesMonth || !M_GASTOS_KEYS.includes(_metricasSaldoMesMonth)) {
        _metricasSaldoMesMonth = mSaldoMesDefaultMonth(year)
    }

    const yearToggle = document.getElementById("mSaldoMesYearToggle")
    if (yearToggle && !yearToggle.dataset.bound) {
        yearToggle.dataset.bound = "true"
        yearToggle.innerHTML = ingresosYearsList
            .map(
                (y) =>
                    `<button class="mToggleBtn${String(y) === String(year) ? " active" : ""}" data-saldomesyear="${y}">${y}</button>`
            )
            .join("")
        yearToggle.addEventListener("click", async (e) => {
            const btn = e.target.closest("[data-saldomesyear]")
            if (!btn) return
            yearToggle.querySelectorAll(".mToggleBtn").forEach((b) => b.classList.remove("active"))
            btn.classList.add("active")
            const newYear = btn.dataset.saldomesyear
            _metricasSaldoMesMonth = mSaldoMesDefaultMonth(newYear)
            setChartPref("metricasSaldoMesMonth", _metricasSaldoMesMonth)
            const [newIng, newGas] = await Promise.all([
                fetch(`/api/ingresos/${newYear}`)
                    .then((r) => r.json())
                    .catch(() => null),
                fetch(`/api/gastos/${newYear}`)
                    .then((r) => r.json())
                    .catch(() => null)
            ])
            if (newIng) {
                const monthToggle = document.getElementById("mSaldoMesMonthToggle")
                if (monthToggle) {
                    monthToggle.dataset.bound = ""
                    monthToggle.innerHTML = ""
                }
                mRenderSaldoMes(ingresosYearsList, newIng, newGas)
            }
        })
    } else if (yearToggle) {
        yearToggle
            .querySelectorAll(".mToggleBtn")
            .forEach((b) => b.classList.toggle("active", b.dataset.saldomesyear === String(year)))
    }

    const monthToggle = document.getElementById("mSaldoMesMonthToggle")
    if (monthToggle && !monthToggle.dataset.bound) {
        monthToggle.dataset.bound = "true"
        monthToggle.innerHTML = M_GASTOS_KEYS.map(
            (k, i) =>
                `<button class="mToggleBtn${_metricasSaldoMesMonth === k ? " active" : ""}" data-saldomesmonth="${k}">${M_GASTOS_LABELS[i]}</button>`
        ).join("")
        monthToggle.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-saldomesmonth]")
            if (!btn) return
            monthToggle.querySelectorAll(".mToggleBtn").forEach((b) => b.classList.remove("active"))
            btn.classList.add("active")
            _metricasSaldoMesMonth = btn.dataset.saldomesmonth
            setChartPref("metricasSaldoMesMonth", _metricasSaldoMesMonth)
            mRenderSaldoMesChart(
                _mSaldoMesCache?.ingresosYearData,
                _mSaldoMesCache?.gastosYearData,
                _mSaldoMesCache?.ingresosYearData?.year,
                _metricasSaldoMesMonth
            )
        })
    } else if (monthToggle) {
        monthToggle
            .querySelectorAll(".mToggleBtn")
            .forEach((b) => b.classList.toggle("active", b.dataset.saldomesmonth === _metricasSaldoMesMonth))
    }

    mRenderSaldoMesChart(ingresosYearData, gastosYearData, year, _metricasSaldoMesMonth)
}

// ── concentración top 10 ──────────────────────────────────────────────────

function mRenderConcentracion(summaries) {
    const positive = summaries.filter((a) => a.netoActualEur > 0)
    const total = positive.reduce((s, a) => s + a.netoActualEur, 0)
    if (!positive.length || total <= 0) return

    const sorted = [...positive].sort((a, b) => b.netoActualEur - a.netoActualEur).slice(0, 10)
    const labels = sorted.map((a) => a.name)
    const values = sorted.map((a) => parseFloat(((a.netoActualEur / total) * 100).toFixed(2)))
    const colors = sorted.map((a, i) => a.color || M_PALETTE[i % M_PALETTE.length])

    mCreateChart("mChartConcentracion", {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: "% Cartera",
                    data: values,
                    backgroundColor: colors.map((c) => c + "bb"),
                    borderColor: colors,
                    borderWidth: 1,
                    borderRadius: 4
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            indexAxis: "y",
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (c) =>
                            ` ${c.raw.toFixed(1).replace(".", ",")}%  —  ${formatEuro(sorted[c.dataIndex].netoActualEur)}`
                    }
                }
            },
            scales: {
                x: {
                    ...mAxisX(),
                    ticks: { color: "#8899bb", callback: (v) => v.toFixed(0) + "%" }
                },
                y: mAxisY(11)
            }
        }
    })
}
