const AHORRO_MONTHS = [
    { key: "enero", label: "Ene" },
    { key: "febrero", label: "Feb" },
    { key: "marzo", label: "Mar" },
    { key: "abril", label: "Abr" },
    { key: "mayo", label: "May" },
    { key: "junio", label: "Jun" },
    { key: "julio", label: "Jul" },
    { key: "agosto", label: "Ago" },
    { key: "septiembre", label: "Sep" },
    { key: "octubre", label: "Oct" },
    { key: "noviembre", label: "Nov" },
    { key: "diciembre", label: "Dic" }
]

let ahorroCurrentYear = null
let ahorroCurrentMonth = null
let ahorroAvailableYears = []
let ahorroIngresosData = null
let ahorroGastosData = null
let ahorroConfig = { objetivoAhorro: 30, presupuesto: {} }
let ahorroConfigModalKeyHandler = null

async function initAhorroLogic() {
    try {
        const [ingRes, gasRes, sttRes] = await Promise.all([
            fetch("/api/ingresos"),
            fetch("/api/gastos"),
            fetch("/api/settings")
        ])
        const ingYears = ingRes.ok ? (await ingRes.json()).years || [] : []
        const gasYears = gasRes.ok ? (await gasRes.json()).years || [] : []
        const settings = sttRes.ok ? await sttRes.json() : {}

        ahorroConfig = settings.ahorroConfig || { objetivoAhorro: 30, presupuesto: {} }
        if (!ahorroConfig.presupuesto) ahorroConfig.presupuesto = {}

        const allYears = [...new Set([...ingYears, ...gasYears])].sort()
        ahorroAvailableYears = allYears.length ? allYears : [String(new Date().getFullYear())]

        const currentYear = String(new Date().getFullYear())
        ahorroCurrentYear = ahorroAvailableYears.includes(currentYear)
            ? currentYear
            : ahorroAvailableYears[ahorroAvailableYears.length - 1]

        ahorroCurrentMonth = AHORRO_MONTHS[new Date().getMonth()].key

        await renderAhorroYear(ahorroCurrentYear)
        bindAhorroEvents()
    } catch (err) {
        console.error("Error inicializando ahorro:", err)
    }
}

async function renderAhorroYear(year) {
    const [ingRes, gasRes] = await Promise.all([
        fetch(`/api/ingresos/${year}`).catch(() => null),
        fetch(`/api/gastos/${year}`).catch(() => null)
    ])
    ahorroIngresosData = ingRes && ingRes.ok ? await ingRes.json() : null
    ahorroGastosData = gasRes && gasRes.ok ? await gasRes.json() : null

    renderAhorroYearList()
    renderAhorroMonthTabs()
    renderAhorroView()
}

function renderAhorroYearList() {
    const list = document.getElementById("ahorroYearList")
    if (!list) return
    list.innerHTML = ""
    ahorroAvailableYears.forEach((year) => {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = `ahorroYearBtn${year === ahorroCurrentYear ? " active" : ""}`
        btn.textContent = year
        btn.addEventListener("click", async () => {
            ahorroCurrentYear = year
            await renderAhorroYear(year)
        })
        list.appendChild(btn)
    })
}

function renderAhorroMonthTabs() {
    const tabs = document.getElementById("ahorroMonthTabs")
    if (!tabs) return
    tabs.innerHTML = ""
    AHORRO_MONTHS.forEach((m) => {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = `ahorroMonthTab${m.key === ahorroCurrentMonth ? " active" : ""}`
        btn.textContent = m.label
        btn.addEventListener("click", () => {
            ahorroCurrentMonth = m.key
            renderAhorroMonthTabs()
            renderAhorroView()
        })
        tabs.appendChild(btn)
    })
}

function calcMonthIngresos(month) {
    if (!ahorroIngresosData) return 0
    const rows = ahorroIngresosData.months?.[month]?.rows || []
    const recurrentes = ahorroIngresosData.recurrentes || []
    const rowsTotal = rows.reduce((s, r) => s + parseEuroNumber(r.cantidad || ""), 0)
    const recTotal = recurrentes.reduce((s, r) => s + parseEuroNumber(r.meses?.[month] || ""), 0)
    return rowsTotal + recTotal
}

function calcMonthGastosByTipo(month) {
    if (!ahorroGastosData) return {}
    const rows = ahorroGastosData.months?.[month]?.rows || []
    const totals = {}
    rows.forEach((row) => {
        const tipo = (row.tipo || "Sin categoría").trim() || "Sin categoría"
        totals[tipo] = (totals[tipo] || 0) + parseEuroNumber(row.cantidad || "")
    })
    return totals
}

function calcMonthGastosTotal(month) {
    if (!ahorroGastosData) return 0
    const rows = ahorroGastosData.months?.[month]?.rows || []
    const mensualidades = ahorroGastosData.mensualidades || []
    const rowsTotal = rows.reduce((s, r) => s + parseEuroNumber(r.cantidad || ""), 0)
    const mensTotal = mensualidades.reduce((s, m) => s + parseEuroNumber(m.meses?.[month] || ""), 0)
    return rowsTotal + mensTotal
}

function renderAhorroView() {
    const month = ahorroCurrentMonth
    const totalIngresos = calcMonthIngresos(month)
    const totalGastos = calcMonthGastosTotal(month)
    const ahorroReal = totalIngresos - totalGastos
    const tasaAhorro = totalIngresos > 0 ? (ahorroReal / totalIngresos) * 100 : 0
    const gastosByTipo = calcMonthGastosByTipo(month)

    renderAhorroKpis(totalIngresos, totalGastos, ahorroReal, tasaAhorro)
    renderAhorroObjetivo(totalIngresos, ahorroReal, tasaAhorro)
    renderAhorroCategorias(gastosByTipo, totalIngresos)
    renderAhorroDonut(gastosByTipo, totalGastos)
    renderAhorroSplitDonut(totalIngresos, totalGastos, ahorroReal, tasaAhorro)
}

function renderAhorroKpis(totalIngresos, totalGastos, ahorroReal, tasaAhorro) {
    const pct = (v, total) => (total > 0 ? ((v / total) * 100).toFixed(1) + "%" : "---")

    const ingVal = document.getElementById("ahorroKpiIngresosVal")
    const ingresosSub = document.getElementById("ahorroKpiIngresosSub")
    const gasVal = document.getElementById("ahorroKpiGastosVal")
    const gasSub = document.getElementById("ahorroKpiGastosSub")
    const ahVal = document.getElementById("ahorroKpiAhorroVal")
    const ahSub = document.getElementById("ahorroKpiAhorroSub")
    const tasaVal = document.getElementById("ahorroKpiTasaVal")
    const tasaSub = document.getElementById("ahorroKpiTasaSub")
    if (!ingVal) return

    ingVal.textContent = formatEuro(totalIngresos)
    ingresosSub.textContent = "del mes"

    gasVal.textContent = formatEuro(totalGastos)
    gasSub.textContent = totalIngresos > 0 ? pct(totalGastos, totalIngresos) + " de los ingresos" : "del mes"

    ahVal.textContent = formatEuro(ahorroReal)
    ahVal.classList.toggle("ahorroKpiPos", ahorroReal >= 0)
    ahVal.classList.toggle("ahorroKpiNeg", ahorroReal < 0)
    ahSub.textContent = ahorroReal >= 0 ? "guardado este mes" : "déficit este mes"

    const obj = Number(ahorroConfig.objetivoAhorro) || 30
    tasaVal.textContent = tasaAhorro.toFixed(1) + "%"
    tasaVal.classList.toggle("ahorroKpiPos", tasaAhorro >= obj)
    tasaVal.classList.toggle("ahorroKpiNeg", totalIngresos > 0 && tasaAhorro < obj)

    const diff = tasaAhorro - obj
    if (totalIngresos === 0) {
        tasaSub.textContent = "sin datos de ingresos"
    } else if (diff >= 0) {
        tasaSub.textContent = `+${diff.toFixed(1)} pp sobre el objetivo`
    } else {
        tasaSub.textContent = `${diff.toFixed(1)} pp bajo el objetivo`
    }
}

function renderAhorroObjetivo(totalIngresos, ahorroReal, tasaAhorro) {
    const obj = Number(ahorroConfig.objetivoAhorro) || 30
    const pctEl = document.getElementById("ahorroObjetivoPct")
    const fill = document.getElementById("ahorroObjetivoFill")
    const target = document.getElementById("ahorroObjetivoTarget")
    const meta = document.getElementById("ahorroObjetivoMeta")
    if (!pctEl) return

    pctEl.textContent = obj + "% objetivo"

    fill.classList.remove("ahorroObjetivoFillPos", "ahorroObjetivoFillNeg")

    if (totalIngresos === 0) {
        fill.style.width = "0%"
        fill.style.left = ""
        fill.style.right = ""
        fill.innerHTML = ""
        target.style.left = "66%"
    } else if (tasaAhorro >= 0) {
        const maxPct = Math.max(obj * 1.5, tasaAhorro + 5, 10)
        const fillW = Math.min((tasaAhorro / maxPct) * 100, 100)
        const tgtW = Math.min((obj / maxPct) * 100, 100)
        fill.style.width = fillW + "%"
        fill.style.left = ""
        fill.style.right = ""
        fill.classList.add("ahorroObjetivoFillPos")
        fill.innerHTML = `<span class="ahorroObjetivoFillLabel">${tasaAhorro.toFixed(1)}%</span>`
        target.style.left = tgtW + "%"
    } else {
        // Negativo: más déficit → barra MÁS PEQUEÑA (proporcional inversa al objetivo)
        const tgtW = Math.min((obj / Math.max(obj * 1.5, 10)) * 100, 100)
        const fillW = Math.max(2, 30 - (Math.abs(tasaAhorro) / Math.max(obj, 5)) * 30)
        fill.style.width = fillW + "%"
        fill.style.left = ""
        fill.style.right = ""
        fill.classList.add("ahorroObjetivoFillNeg")
        fill.innerHTML = `<span class="ahorroObjetivoFillLabel" style="right:auto;left:8px">${tasaAhorro.toFixed(1)}%</span>`
        target.style.left = tgtW + "%"
    }
    target.innerHTML = `<span class="ahorroObjetivoTargetLabel">${obj}% objetivo</span>`

    const objetivoEur = totalIngresos * (obj / 100)
    const diff = ahorroReal - objetivoEur
    if (totalIngresos === 0) {
        meta.textContent = "No hay ingresos registrados este mes."
        meta.className = "ahorroObjetivoMeta"
    } else if (ahorroReal >= objetivoEur) {
        meta.innerHTML = `Objetivo: ${formatEuro(objetivoEur)} — Ahorro real: <strong>${formatEuro(ahorroReal)}</strong> — Superas en <strong class="ahorroPos">+${formatEuro(diff)}</strong>`
        meta.className = "ahorroObjetivoMeta"
    } else {
        meta.innerHTML = `Objetivo: ${formatEuro(objetivoEur)} — Ahorro real: <strong>${formatEuro(ahorroReal)}</strong> — Te faltan <strong class="ahorroNeg">${formatEuro(Math.abs(diff))}</strong>`
        meta.className = "ahorroObjetivoMeta"
    }
}

function _buildDonutSvg(slices, cx, cy, R, r, centerHtml) {
    const ptc = (angle, radius) => ({
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle)
    })
    let paths = ""
    slices.forEach((s) => {
        const o1 = ptc(s.startAngle, R),
            o2 = ptc(s.endAngle, R)
        const i1 = ptc(s.startAngle, r),
            i2 = ptc(s.endAngle, r)
        const lg = s.span > Math.PI ? 1 : 0
        paths += `<path d="M${o1.x} ${o1.y} A${R} ${R} 0 ${lg} 1 ${o2.x} ${o2.y} L${i2.x} ${i2.y} A${r} ${r} 0 ${lg} 0 ${i1.x} ${i1.y}Z" fill="${s.color}"/>`
        if (s.pct >= 0.05) {
            const mid = s.startAngle + s.span / 2
            const lp = ptc(mid, (R + r) / 2)
            paths += `<text x="${lp.x}" y="${lp.y}" text-anchor="middle" dominant-baseline="middle" fill="white" font-size="7.5" font-weight="700" font-family="inherit">${(s.pct * 100).toFixed(0)}%</text>`
        }
    })
    slices.forEach((s) => {
        const p1 = ptc(s.startAngle, r - 1),
            p2 = ptc(s.startAngle, R + 1)
        paths += `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="var(--bg-elevated)" stroke-width="1.5"/>`
    })
    return paths + centerHtml
}

function _buildSlices(items, totalVal, colors) {
    let angle = -Math.PI / 2
    return items.map((item, i) => {
        const pct = totalVal > 0 ? item.value / totalVal : 0
        const span = pct * 2 * Math.PI
        const s = { ...item, pct, span, startAngle: angle, endAngle: angle + span, color: colors[i % colors.length] }
        angle += span
        return s
    })
}

function renderAhorroDonut(gastosByTipo, totalGastos) {
    const svg = document.getElementById("ahorroDonutSvg")
    const legend = document.getElementById("ahorroDonutLegend")
    const sub = document.getElementById("ahorroDonutSubtitle")
    if (!svg || !legend) return

    const allGastos = { ...gastosByTipo }
    const categTotal = Object.values(allGastos).reduce((s, v) => s + v, 0)
    const mensRest = totalGastos - categTotal
    if (mensRest > 0.01) allGastos["Mensualidades"] = mensRest

    const tipos = Object.keys(allGastos).sort((a, b) => allGastos[b] - allGastos[a])

    if (tipos.length === 0 || totalGastos === 0) {
        svg.innerHTML = `<circle cx="90" cy="90" r="58" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="24"/>
            <text x="90" y="97" text-anchor="middle" fill="var(--text-muted)" font-size="10" font-family="inherit">Sin gastos</text>`
        legend.innerHTML = ""
        if (sub) sub.textContent = ""
        return
    }

    const COLORS = [
        "#60a5fa",
        "#f472b6",
        "#34d399",
        "#fbbf24",
        "#a78bfa",
        "#fb923c",
        "#22d3ee",
        "#f87171",
        "#4ade80",
        "#e879f9",
        "#38bdf8",
        "#facc15"
    ]
    const slices = _buildSlices(
        tipos.map((t) => ({ tipo: t, value: allGastos[t] })),
        totalGastos,
        COLORS
    )
    const center = `<text x="90" y="85" text-anchor="middle" fill="var(--text-primary)" font-size="12" font-weight="700" font-family="inherit">${formatEuro(totalGastos)}</text>
        <text x="90" y="100" text-anchor="middle" fill="var(--text-muted)" font-size="8.5" font-family="inherit">total gastos</text>`
    svg.innerHTML = _buildDonutSvg(slices, 90, 90, 70, 46, center)

    const monthLabel = AHORRO_MONTHS.find((m) => m.key === ahorroCurrentMonth)?.label || ""
    if (sub) sub.textContent = `${monthLabel} ${ahorroCurrentYear} · ${tipos.length} cat.`

    legend.innerHTML = slices
        .map(
            (s) => `
        <div class="ahorroDonutLegendRow">
            <span class="ahorroDonutLegendDot" style="background:${s.color}"></span>
            <span class="ahorroDonutLegendName">${escapeAhorroHtml(s.tipo)}</span>
            <span class="ahorroDonutLegendPct">${(s.pct * 100).toFixed(1)}%</span>
            <span class="ahorroDonutLegendVal">${formatEuro(s.value)}</span>
        </div>
    `
        )
        .join("")
}

function renderAhorroSplitDonut(totalIngresos, totalGastos, ahorroReal, tasaAhorro) {
    const svg = document.getElementById("ahorroSplitSvg")
    const legend = document.getElementById("ahorroSplitLegend")
    const sub = document.getElementById("ahorroSplitSubtitle")
    if (!svg || !legend) return

    const obj = Number(ahorroConfig.objetivoAhorro) || 30

    if (totalIngresos === 0) {
        svg.innerHTML = `<circle cx="90" cy="90" r="58" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="24"/>
            <text x="90" y="97" text-anchor="middle" fill="var(--text-muted)" font-size="10" font-family="inherit">Sin datos</text>`
        legend.innerHTML = ""
        if (sub) sub.textContent = ""
        return
    }

    const segments =
        ahorroReal >= 0
            ? [
                  { label: "Gastos", value: totalGastos },
                  { label: "Ahorro", value: ahorroReal }
              ]
            : [
                  { label: "Gastos", value: totalIngresos },
                  { label: "Déficit", value: Math.abs(ahorroReal) }
              ]

    const total = segments.reduce((s, x) => s + x.value, 0)
    const COLORS = ahorroReal >= 0 ? ["#f87171", "#4ade80"] : ["#f87171", "#dc2626"]
    const slices = _buildSlices(segments, total, COLORS)

    const centerVal = tasaAhorro.toFixed(1) + "%"
    const centerColor = tasaAhorro >= obj ? "#4ade80" : tasaAhorro >= 0 ? "#fbbf24" : "#f87171"
    const center = `<text x="90" y="85" text-anchor="middle" fill="${centerColor}" font-size="16" font-weight="700" font-family="inherit">${centerVal}</text>
        <text x="90" y="101" text-anchor="middle" fill="var(--text-muted)" font-size="8.5" font-family="inherit">tasa ahorro</text>`
    svg.innerHTML = _buildDonutSvg(slices, 90, 90, 70, 46, center)

    const monthLabel = AHORRO_MONTHS.find((m) => m.key === ahorroCurrentMonth)?.label || ""
    if (sub) sub.textContent = `${monthLabel} ${ahorroCurrentYear} · obj ${obj}%`

    legend.innerHTML = slices
        .map(
            (s) => `
        <div class="ahorroDonutLegendRow">
            <span class="ahorroDonutLegendDot" style="background:${s.color}"></span>
            <span class="ahorroDonutLegendName">${escapeAhorroHtml(s.label)}</span>
            <span class="ahorroDonutLegendPct">${(s.pct * 100).toFixed(1)}%</span>
            <span class="ahorroDonutLegendVal">${formatEuro(s.value)}</span>
        </div>
    `
        )
        .join("")
}

function renderAhorroCategorias(gastosByTipo, totalIngresos) {
    const list = document.getElementById("ahorroPresupuestoList")
    const hint = document.getElementById("ahorroPresupuestoHint")
    if (!list) return

    const presupuestoTipos = Object.keys(ahorroConfig.presupuesto || {}).filter(
        (t) => Number(ahorroConfig.presupuesto[t]) > 0
    )
    const tipos = [...new Set([...Object.keys(gastosByTipo), ...presupuestoTipos])].sort(
        (a, b) => (gastosByTipo[b] || 0) - (gastosByTipo[a] || 0)
    )

    if (tipos.length === 0 && totalIngresos === 0) {
        list.innerHTML = ""
        const emptyDiv = document.createElement("div")
        emptyDiv.className = "ahorroEmptyState"
        emptyDiv.innerHTML =
            "<p>No hay datos de ingresos ni gastos para este mes.</p><p>Añade movimientos en los módulos <strong>Ingresos</strong> y <strong>Gastos</strong>.</p>"
        list.appendChild(emptyDiv)
        if (hint) hint.textContent = ""
        return
    }

    const gastosConTipo = tipos.filter((t) => t !== "Sin categoría")
    const gastosSinTipo = gastosByTipo["Sin categoría"] || 0

    const totalPresupuestado = gastosConTipo.reduce((s, t) => {
        return s + (Number(ahorroConfig.presupuesto?.[t]) || 0)
    }, 0)
    if (hint)
        hint.textContent =
            totalPresupuestado > 0
                ? `${totalPresupuestado.toFixed(0)}% presupuestado de ${totalIngresos > 0 ? formatEuro(totalIngresos) : "los ingresos"}`
                : ""

    list.innerHTML = ""

    tipos.forEach((tipo) => {
        const realEur = gastosByTipo[tipo] || 0
        const realPct = totalIngresos > 0 ? (realEur / totalIngresos) * 100 : 0
        const objPct = Number(ahorroConfig.presupuesto?.[tipo]) || 0
        const objEur = totalIngresos * (objPct / 100)
        const hasObj = objPct > 0

        const maxForBar = hasObj ? Math.max(objPct, realPct, 1) : Math.max(realPct, 1)
        const fillPct = Math.min((realPct / maxForBar) * 100, 120)
        const tgtPct = hasObj ? Math.min((objPct / maxForBar) * 100, 100) : null
        const overBudget = hasObj && realEur > objEur * 1.001

        const row = document.createElement("div")
        row.className = `ahorroCategoriaRow${overBudget ? " ahorroCatOver" : ""}`
        row.dataset.tipo = tipo

        const targetLine = tgtPct !== null ? `<div class="ahorroCatTargetLine" style="left:${tgtPct}%"></div>` : ""

        const objBadge = hasObj
            ? `<span class="ahorroCatObjBadge${overBudget ? " over" : ""}">Obj: ${objPct.toFixed(0)}% · ${formatEuro(objEur)}</span>`
            : `<span class="ahorroCatObjBadgeEmpty">Sin objetivo</span>`

        const excesoEur = overBudget ? realEur - objEur : 0

        const statusBadge = overBudget
            ? `<span class="ahorroCatStatus over">⚠ Excedido en ${formatEuro(excesoEur)}</span>`
            : hasObj
              ? `<span class="ahorroCatStatus ok">✓ Dentro</span>`
              : ""

        row.innerHTML = `
            <div class="ahorroCatTop">
                <div class="ahorroCatName">
                    <span class="ahorroCatTipoLabel">${escapeAhorroHtml(tipo)}</span>
                    ${statusBadge}
                </div>
                <div class="ahorroCatNums">
                    ${objBadge}
                    <span class="ahorroCatReal">Real: ${formatEuro(realEur)} <span class="ahorroCatRealPct">(${realPct.toFixed(1)}%)</span></span>
                </div>
            </div>
            <div class="ahorroCatBarTrack">
                <div class="ahorroCatBarFill${overBudget ? " over" : hasObj ? " ok" : ""}" style="width:${Math.min(fillPct, 100)}%">
                    <span class="ahorroCatBarLabel">${realPct.toFixed(1)}%</span>
                </div>
                ${targetLine}
            </div>
        `
        list.appendChild(row)
    })

    if (gastosSinTipo > 0) {
        const noteLine = document.createElement("p")
        noteLine.className = "ahorroSinTipoNote"
        noteLine.textContent = `${formatEuro(gastosSinTipo)} en gastos sin categoría no se muestran arriba.`
        list.appendChild(noteLine)
    }
}

function bindAhorroEvents() {
    const configBtn = document.getElementById("ahorroConfigBtn")
    if (configBtn && !configBtn.dataset.bound) {
        configBtn.dataset.bound = "true"
        configBtn.addEventListener("click", openAhorroConfigModal)
    }
}

function escapeAhorroHtml(v) {
    return String(v || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

function openAhorroConfigModal() {
    document.getElementById("ahorroConfigModalOverlay")?.remove()
    if (ahorroConfigModalKeyHandler) {
        document.removeEventListener("keydown", ahorroConfigModalKeyHandler)
        ahorroConfigModalKeyHandler = null
    }

    const month = ahorroCurrentMonth
    const gastosByTipo = calcMonthGastosByTipo(month)
    const tipos = Object.keys(gastosByTipo)
        .filter((t) => t !== "Sin categoría")
        .sort()

    const tiposFromGastos = ahorroGastosData?.gastosTipos || []
    const allTipos = [...new Set([...tipos, ...tiposFromGastos])].sort()

    const tiposRows = allTipos
        .map((tipo) => {
            const current = Number(ahorroConfig.presupuesto?.[tipo]) || ""
            const realEur = gastosByTipo[tipo] || 0
            const realHint = realEur > 0 ? ` (real: ${formatEuro(realEur)})` : ""
            return `
            <div class="ahorroModalTipoRow">
                <label class="ahorroModalTipoLabel" for="ahorroPres-${escapeAhorroHtml(tipo)}">${escapeAhorroHtml(tipo)}${realHint}</label>
                <div class="ahorroModalTipoInputWrap">
                    <input id="ahorroPres-${escapeAhorroHtml(tipo)}" class="ahorroModalInput" type="number" min="0" max="100" step="0.5"
                        value="${current}" placeholder="0" data-tipo="${escapeAhorroHtml(tipo)}">
                    <span class="ahorroModalPctSuffix">%</span>
                </div>
            </div>
        `
        })
        .join("")

    const overlay = document.createElement("div")
    overlay.id = "ahorroConfigModalOverlay"
    overlay.className = "modalOverlay"

    overlay.innerHTML = `
        <div class="assetModal ahorroConfigModal" role="dialog" aria-modal="true">
            <h3 class="assetModalTitle">Configurar presupuesto</h3>

            <div class="ahorroModalSection">
                <label class="ahorroModalSectionLabel">Objetivo de ahorro mensual</label>
                <div class="ahorroModalTipoInputWrap">
                    <input id="ahorroObjetivoInput" class="ahorroModalInput" type="number" min="0" max="100" step="1"
                        value="${Number(ahorroConfig.objetivoAhorro) || 30}" placeholder="30">
                    <span class="ahorroModalPctSuffix">%</span>
                </div>
                <p class="ahorroModalHint">Porcentaje de los ingresos que quieres guardar cada mes.</p>
            </div>

            ${
                allTipos.length > 0
                    ? `
            <div class="ahorroModalSection">
                <label class="ahorroModalSectionLabel">% objetivo por categoría de gasto</label>
                <p class="ahorroModalHint">Indica qué porcentaje de tus ingresos quieres destinar a cada categoría. Deja en 0 si no quieres establecer objetivo.</p>
                <div class="ahorroModalTiposList">
                    ${tiposRows}
                </div>
            </div>
            `
                    : `<p class="ahorroModalHint ahorroModalNoTipos">Añade gastos con categorías para configurar el presupuesto por tipo.</p>`
            }

            <p class="ahorroModalTotalPct" id="ahorroModalTotalPct"></p>
            <p class="ahorroModalFeedback hidden" id="ahorroModalFeedback"></p>

            <div class="assetModalActions">
                <button type="button" class="cancelButton" id="ahorroModalCancelBtn">Cancelar</button>
                <button type="button" class="primaryButton" id="ahorroModalSaveBtn" data-no-autohide="true">Guardar</button>
            </div>
        </div>
    `

    document.body.appendChild(overlay)

    overlay.querySelector("#ahorroModalCancelBtn").addEventListener("click", closeAhorroConfigModal)
    overlay.querySelector("#ahorroModalSaveBtn").addEventListener("click", saveAhorroConfig)

    overlay.querySelectorAll("#ahorroObjetivoInput, .ahorroModalInput[data-tipo]").forEach((input) => {
        input.addEventListener("input", updateAhorroModalTotalPct)
    })
    updateAhorroModalTotalPct()

    ahorroConfigModalKeyHandler = (e) => {
        if (e.key === "Escape") closeAhorroConfigModal()
    }
    document.addEventListener("keydown", ahorroConfigModalKeyHandler)
}

function calcAhorroModalTotalPct() {
    const objVal = parseFloat(document.getElementById("ahorroObjetivoInput")?.value) || 0
    let categoriasPct = 0
    document.querySelectorAll(".ahorroModalInput[data-tipo]").forEach((input) => {
        categoriasPct += parseFloat(input.value) || 0
    })
    return objVal + categoriasPct
}

function updateAhorroModalTotalPct() {
    const el = document.getElementById("ahorroModalTotalPct")
    if (!el) return
    const total = calcAhorroModalTotalPct()
    el.textContent = `Total asignado: ${total.toFixed(1)}% de 100%`
    el.classList.toggle("over", total > 100)
}

function closeAhorroConfigModal() {
    document.getElementById("ahorroConfigModalOverlay")?.remove()
    if (ahorroConfigModalKeyHandler) {
        document.removeEventListener("keydown", ahorroConfigModalKeyHandler)
        ahorroConfigModalKeyHandler = null
    }
}

async function saveAhorroConfig() {
    const feedback = document.getElementById("ahorroModalFeedback")
    const setFeedback = (msg, isErr = false) => {
        if (!feedback) return
        feedback.textContent = msg
        feedback.classList.toggle("hidden", !msg)
        feedback.classList.toggle("error", isErr && Boolean(msg))
    }

    const objInput = document.getElementById("ahorroObjetivoInput")
    const objVal = parseFloat(objInput?.value ?? "30")
    if (isNaN(objVal) || objVal < 0 || objVal > 100) {
        setFeedback("El objetivo de ahorro debe estar entre 0 y 100.", true)
        return
    }

    const presupuesto = {}
    document.querySelectorAll(".ahorroModalInput[data-tipo]").forEach((input) => {
        const tipo = input.dataset.tipo
        const val = parseFloat(input.value)
        if (tipo && !isNaN(val) && val > 0) {
            presupuesto[tipo] = Math.min(100, Math.max(0, val))
        }
    })

    const totalAsignado = calcAhorroModalTotalPct()
    if (totalAsignado > 100) {
        setFeedback(
            `El objetivo de ahorro más los objetivos por categoría no pueden superar el 100% (actual: ${totalAsignado.toFixed(1)}%).`,
            true
        )
        return
    }

    const newConfig = { objetivoAhorro: objVal, presupuesto }

    try {
        const res = await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ahorroConfig: newConfig })
        })
        if (!res.ok) throw new Error("HTTP " + res.status)
        ahorroConfig = newConfig
        closeAhorroConfigModal()
        renderAhorroView()
    } catch (err) {
        console.error(err)
        setFeedback("No se pudo guardar la configuración.", true)
    }
}
