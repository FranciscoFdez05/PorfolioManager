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

/**
 * Lo apuntado en un mes en las categorías que el usuario marcó como inversión
 * (ahorroConfig.categoriasInversion), que la tasa de ahorro trata como dinero
 * apartado y no como gasto: mismo criterio que la página Ahorro
 * (AhorroCalculos.detectorDeInversion). Las mensualidades de meses futuros no
 * cuentan, igual que en mComputeGastosData, para restar solo lo que allí se sumó.
 * @param {object|null} yearData Gastos del año.
 * @param {string} monthKey Mes en minúsculas.
 * @param {object} [ahorroConfig] ahorroConfig de los ajustes.
 * @returns {number}
 */
function mInversionDelMes(yearData, monthKey, ahorroConfig) {
    const categorias = ahorroConfig?.categoriasInversion
    if (!yearData || !Array.isArray(categorias) || !categorias.length) return 0
    const esInversion = AhorroCalculos.detectorDeInversion(categorias)
    let total = 0
    ;(yearData.months?.[monthKey]?.rows || []).forEach((row) => {
        if (esInversion(row.tipo)) total += parseEuroNumber(row.cantidad || "")
    })
    if (isMensualidadMonthActive(yearData, monthKey)) {
        ;(yearData.mensualidades || []).forEach((m) => {
            if (esInversion(m.categoria)) total += parseEuroNumber(m.meses?.[monthKey] || "")
        })
    }
    return total
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
        mRenderDonutLeyenda("mChartGastosTipo", [], [], [], 0)
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
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => mGridTooltip(c.label, c.raw, tipoTotal) } }
            }
        }
    })
    mRenderDonutLeyenda("mChartGastosTipo", tipoLabels, tipoColors, tipoValues, tipoTotal)
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
            <button class="gtPopupClose" id="gtPopupCloseBtn" title="Cerrar" aria-label="Cerrar">${iconoHtml("Cerrar")}</button>
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
