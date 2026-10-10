// Métricas: arranque de la pantalla, apartados sin datos y métricas de trading.
//
// Separado de js/analisis/metricas.js, que pasaba de 6.000 líneas. Es código
// de nivel superior que comparte el ámbito global con el resto de trozos
// (index.html los carga seguidos y en este orden); no ha cambiado.

// ── main init ──────────────────────────────────────────────────────────────

// ── ocultado de apartados sin datos ────────────────────────────────────────
//
// La página monta todos los apartados siempre y cada render decide si enseña un
// aviso de "no hay datos". Con una cartera recién creada eso deja una pantalla
// llena de tarjetas vacías, así que después de pintar se hace una pasada que
// esconde lo que no tiene nada que enseñar.
//
// La pasada solo añade "hidden", nunca lo quita: los apartados que ya se ocultan
// por su propia lógica (trading sin operaciones, renta fija sin filas…) deben
// quedarse como están.

// Secciones que viven del histórico de snapshots y ya deciden solas cuándo
// esconderse. Las dos de evolución porque se piden por rango después de esta
// pasada (si se ocultaran por "no tener gráfico todavía" desaparecerían aunque
// sí hubiera histórico), y la de riesgo porque su gráfico de drawdown es todo
// ceros mientras la cartera esté en máximos, que es un dato, no un hueco.
const _M_SECCIONES_ASINCRONAS = new Set(["mSectionEvolucion", "mSectionEvolucionTipos", "mSectionRiesgo"])

function _mChartConDatos(canvas) {
    const chart = _metricasCharts[canvas?.id]
    if (!chart) return false

    return (chart.data?.datasets || []).some((ds) =>
        (ds.data || []).some((punto) => {
            const valor = punto && typeof punto === "object" ? (punto.y ?? punto.v ?? punto.r) : punto
            const numero = Number(valor)
            return Number.isFinite(numero) && numero !== 0
        })
    )
}

function _mContenedorConDatos(el) {
    const canvases = [...el.querySelectorAll("canvas")]
    const hayTabla = Boolean(el.querySelector("table"))

    // Sin gráficos ni tablas no hay forma de medirlo: se deja visible.
    if (!canvases.length && !hayTabla) {
        return true
    }

    return el.querySelectorAll("tbody tr").length > 0 || canvases.some(_mChartConDatos)
}

// "---", "0,00 €", "0,00 %" o "0" son la forma que tiene la página de decir que
// no hay dato, así que una fila donde todo sea eso no aporta nada.
function _mValorKpiVacio(texto) {
    // Se busca el número dentro del texto en vez de limpiar símbolos uno a uno:
    // los KPIs llevan sufijos de todo tipo ("1,25x" del TVPI, "3 ops"…) y con un
    // replace se acababa colando un NaN que contaba como dato.
    const numero = String(texto || "").match(/-?\d[\d.,]*/)
    if (!numero) {
        return true
    }

    return Number(numero[0].replace(/\./g, "").replace(",", ".")) === 0
}

function _mElementoVisible(el) {
    return !el.classList.contains("hidden") && el.style.display !== "none"
}

function _mCategoriaConContenido(cat) {
    const elementos = document.querySelectorAll(
        `.metricasSection[data-mcat="${cat}"], .metricasKpiRow[data-mcat="${cat}"]`
    )
    return [...elementos].some(_mElementoVisible)
}

function mOcultarApartadosSinDatos() {
    document.querySelectorAll(".metricasSection").forEach((seccion) => {
        if (_M_SECCIONES_ASINCRONAS.has(seccion.id)) {
            return
        }

        const tarjetas = [...seccion.querySelectorAll(".metricasChartCard")]
        tarjetas.forEach((tarjeta) => {
            if (!_mContenedorConDatos(tarjeta)) tarjeta.classList.add("hidden")
        })

        const medibles = tarjetas.length ? tarjetas : [seccion]
        if (medibles.every((el) => !_mContenedorConDatos(el))) {
            seccion.classList.add("hidden")
        }
    })

    // Grupos de KPIs que se rellenan por JS y se quedan sin tarjetas.
    document.querySelectorAll(".metricasKpiGroup").forEach((grupo) => {
        const cards = grupo.querySelector(".metricasKpiCards")
        if (!cards || cards.children.length) {
            return
        }

        grupo.classList.add("hidden")
        const separador = grupo.previousElementSibling
        if (separador?.classList.contains("metricasKpiGroupSep")) {
            separador.classList.add("hidden")
        }
    })

    // Separadores verticales que se quedan colgando entre grupos ocultos.
    document.querySelectorAll(".metricasKpiGroupSep").forEach((sep) => {
        const anterior = sep.previousElementSibling
        const siguiente = sep.nextElementSibling
        if (!anterior || !siguiente || !_mElementoVisible(anterior) || !_mElementoVisible(siguiente)) {
            sep.classList.add("hidden")
        }
    })

    // Filas de KPIs en las que todo vale cero o "---". Solo cuentan los grupos
    // que siguen visibles: los que la propia página ya ha escondido por no tener
    // datos no deben mantener viva la fila entera.
    document.querySelectorAll(".metricasKpiRow[data-mcat]").forEach((fila) => {
        const grupos = [...fila.querySelectorAll(".metricasKpiGroup")]
        const visibles = grupos.length ? grupos.filter(_mElementoVisible) : [fila]
        const valores = visibles.flatMap((grupo) => [...grupo.querySelectorAll(".mkpiValue")])

        if (!valores.length || valores.every((el) => _mValorKpiVacio(el.textContent))) {
            fila.classList.add("hidden")
        }
    })

    // Y por último la categoría entera: si no queda nada visible dentro, sobran
    // su separador y su pestaña del filtro superior.
    document.querySelectorAll(".metricasCatDivider[data-mcat]").forEach((divisor) => {
        if (!_mCategoriaConContenido(divisor.dataset.mcat)) {
            divisor.classList.add("hidden")
        }
    })

    document.querySelectorAll(".mNavTab[data-mcat]").forEach((pestana) => {
        const cats = pestana.dataset.mcat.split(",").map((cat) => cat.trim())
        if (cats[0] !== "todo" && !cats.some(_mCategoriaConContenido)) {
            pestana.classList.add("hidden")
        }
    })
}

function mRenderAll(payload) {
    const {
        summaries,
        dividendos,
        bonos,
        rentaFija,
        gastosYearsList,
        gastosYearData,
        ingresosYearsList,
        ingresosYearData,
        tradingRows,
        snapshotHistory,
        inversiones
    } = payload
    const b = bonos || [],
        rf = rentaFija || []
    mRenderDistTipos(summaries, _metricasDisplayType, b, rf, _metricasDistMetric)
    mRenderDistActivos(summaries, _metricasDisplayType, b, rf, _metricasDistMetric)
    mRenderRendTipos(summaries)
    mRenderRendActivos(summaries)
    const colorMap = Object.fromEntries(summaries.map((s) => [s.name, s.color]).filter(([, c]) => c))
    mRenderDividendos(dividendos, colorMap)
    mRenderDivMensual(dividendos, colorMap)
    mRenderInteresesSection(payload.intereses, payload.cuentasRemuneradas)
    mRenderInvertidoPeriodo(inversiones || { byMonth: {}, byYear: {} })
    mRenderPasivosCharts(dividendos, payload.intereses || [])
    mRenderBonosTipos(b)
    mRenderBonosInst(b)
    mRenderRentaFijaTipos(rf)
    mRenderRentaFijaInst(rf)
    mRenderGastos(gastosYearsList || [], gastosYearData || null)
    mRenderIngresos(ingresosYearData || null)
    mRenderIngresosSection(ingresosYearsList || [], ingresosYearData || null)
    mRenderComparativa(ingresosYearData || null, gastosYearData || null)
    mRenderSaldoMes(ingresosYearsList || [], ingresosYearData || null, gastosYearData || null)
    mRenderTopTable(summaries)
    mRenderTrading(tradingRows || [])
    const liveValue = summaries.reduce((s, a) => s + a.netoActualEur, 0)
    const liveInvested = summaries.reduce((s, a) => s + a.invertidoEur, 0)
    mRenderConcentracion(summaries)
    mRenderRentabilidadAnual(snapshotHistory || [], liveValue, liveInvested, payload.rentabilidad?.cobertura || {})
    mRenderRiesgo(payload.rentabilidad)
    mRenderAhorro(
        ingresosYearData || null,
        gastosYearData || null,
        payload.ahorroConfig || { objetivoAhorro: 30, presupuesto: {} }
    )
    mRenderAnual(payload.anualData || [])

    const gastosEmpty = !gastosYearsList?.length || !gastosYearData
    const ingresosEmpty = !ingresosYearsList?.length || !ingresosYearData
    const gastosIngresosTab = document.querySelector(".mNavTab[data-mcat='gastos,ingresos']")
    if (gastosIngresosTab) gastosIngresosTab.classList.toggle("hidden", gastosEmpty && ingresosEmpty)
    const tradingTab = document.querySelector(".mNavTab[data-mcat='trading']")
    if (tradingTab) tradingTab.classList.toggle("hidden", !(tradingRows && tradingRows.length))

    // Sin ningún snapshot guardado no hay histórico que graficar en ningún
    // rango, así que las dos secciones de evolución sobran enteras.
    if (!snapshotHistory?.length) {
        _M_SECCIONES_ASINCRONAS.forEach((id) => document.getElementById(id)?.classList.add("hidden"))
    }
}

// ── Trading metrics ────────────────────────────────────────────────────────

let _mTradingWinLossFilter = getChartPref("mTradingWinLossFilter", "todos")

function mParseTradingPct(value) {
    if (!value && value !== 0) return null
    const n = parseFloat(String(value).replace(",", ".").replace("%", ""))
    return isNaN(n) ? null : n
}

function mFmtTradingPct(value) {
    const n = mParseTradingPct(value)
    if (n === null) return "---"
    return (n >= 0 ? "+" : "") + n.toFixed(2).replace(".", ",") + "%"
}

function mRenderTrading(rows) {
    const tradingSections = ["mSectionTradingDireccion", "mSectionTradingWinLoss", "mSectionTradingRendimiento"]
    const tradingKpiRow = document.querySelector(".metricasKpiRow[data-mcat='trading']")
    const tradingDivider = document.querySelector(".metricasCatDivider[data-mcat='trading']")
    if (!rows.length) {
        tradingSections.forEach((id) => {
            const el = document.getElementById(id)
            if (el) el.classList.add("hidden")
        })
        if (tradingKpiRow) tradingKpiRow.style.display = "none"
        if (tradingDivider) tradingDivider.style.display = "none"
        return
    }
    tradingSections.forEach((id) => {
        const el = document.getElementById(id)
        if (el) el.classList.remove("hidden")
    })
    if (tradingKpiRow) tradingKpiRow.style.display = ""
    if (tradingDivider) tradingDivider.style.display = ""

    mRenderTradingDireccion(rows)
    mRenderTradingWinLoss(rows, _mTradingWinLossFilter)
    mRenderTradingRendimiento(rows)

    const wlFilterEl = document.getElementById("mTradingWinLossFilter")
    if (wlFilterEl && !wlFilterEl.dataset.bound) {
        wlFilterEl.dataset.bound = "true"
        // Marca el filtro guardado; si ya no existe, vuelve a "todos".
        const savedLabel = wlFilterEl.querySelector(`.mActivosFilterBtn[data-wlfilter="${_mTradingWinLossFilter}"]`)
        const savedInput = savedLabel?.querySelector("input")
        const todosInput = wlFilterEl.querySelector('input[value="todos"]')
        if (savedInput) savedInput.checked = true
        else {
            _mTradingWinLossFilter = "todos"
            if (todosInput) todosInput.checked = true
        }
        wlFilterEl.addEventListener("change", (e) => {
            const label = e.target.closest(".mActivosFilterBtn")
            if (!label) return
            _mTradingWinLossFilter = label.dataset.wlfilter
            setChartPref("mTradingWinLossFilter", _mTradingWinLossFilter)
            mRenderTradingWinLoss(rows, _mTradingWinLossFilter)
        })
    }
}

function mRenderTradingDireccion(rows) {
    const longs = rows.filter((r) => r.direccion === "LONG")
    const shorts = rows.filter((r) => r.direccion === "SHORT")

    mCreateChart("mChartTradingDireccion", {
        type: "doughnut",
        data: {
            labels: ["LONG", "SHORT"],
            datasets: [
                {
                    data: [longs.length, shorts.length],
                    backgroundColor: ["#2ecc71", "#e74c3c"],
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
                legend: { ...M_CHART_DEFAULTS.plugins.legend, position: "bottom" },
                tooltip: {
                    callbacks: {
                        label: (c) =>
                            ` ${c.raw} trades (${rows.length > 0 ? ((c.raw / rows.length) * 100).toFixed(1) : 0}%)`
                    }
                }
            }
        }
    })

    const statsEl = document.getElementById("mTradingDireccionStats")
    if (!statsEl) return

    function dirStats(subset, label) {
        const profits = subset.filter((r) => r.resultado === "PROFIT")
        const wr = subset.length > 0 ? ((profits.length / subset.length) * 100).toFixed(1) : "0.0"
        const ganMedia =
            subset.length > 0
                ? (subset.reduce((s, r) => s + (mParseTradingPct(r.ganancia) || 0), 0) / subset.length).toFixed(2)
                : "0.00"
        const roiMedia =
            subset.length > 0
                ? (subset.reduce((s, r) => s + (mParseTradingPct(r.roi) || 0), 0) / subset.length).toFixed(1)
                : "0.0"
        return `
            <tr>
                <td><span class="tradingDirBadge tradingDir${label}" style="font-size:12px">${label}</span></td>
                <td>${escapeHtml(subset.length)}</td>
                <td class="${parseFloat(wr) >= 50 ? "tradingPos" : "tradingNeg"}">${wr}%</td>
                <td class="${parseFloat(ganMedia) >= 0 ? "tradingPos" : "tradingNeg"}">${mFmtTradingPct(ganMedia)}</td>
                <td class="${parseFloat(roiMedia) >= 0 ? "tradingPos" : "tradingNeg"}">${parseFloat(roiMedia) >= 0 ? "+" : ""}${roiMedia.replace(".", ",")}%</td>
            </tr>
        `
    }

    statsEl.innerHTML = `
        <table class="mTradingTable">
            <thead>
                <tr>
                    <th>Dirección</th>
                    <th>Trades</th>
                    <th>Win Rate</th>
                    <th>Gan. media</th>
                    <th>ROI medio</th>
                </tr>
            </thead>
            <tbody>
                ${dirStats(longs, "LONG")}
                ${dirStats(shorts, "SHORT")}
            </tbody>
        </table>
    `
}

function mRenderTradingWinLoss(rows, filter = "todos") {
    const filtered =
        filter === "LONG"
            ? rows.filter((r) => r.direccion === "LONG")
            : filter === "SHORT"
              ? rows.filter((r) => r.direccion === "SHORT")
              : rows

    const profits = filtered.filter((r) => r.resultado === "PROFIT").length
    const perdidas = filtered.filter((r) => r.resultado === "PÉRDIDA").length

    mCreateChart("mChartTradingWinLoss", {
        type: "doughnut",
        data: {
            labels: ["Aciertos", "Fallos"],
            datasets: [
                {
                    data: [profits, perdidas],
                    backgroundColor: ["#2ecc71cc", "#e74c3ccc"],
                    borderColor: ["#2ecc71", "#e74c3c"],
                    borderWidth: 2,
                    hoverOffset: 10
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            cutout: "58%",
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { ...M_CHART_DEFAULTS.plugins.legend, position: "bottom" },
                tooltip: {
                    callbacks: {
                        label: (c) =>
                            ` ${c.raw} (${filtered.length > 0 ? ((c.raw / filtered.length) * 100).toFixed(1) : 0}%)`
                    }
                }
            }
        }
    })

    const mediaEl = document.getElementById("mTradingMediaTable")
    if (!mediaEl) return

    const profitRows = filtered.filter((r) => r.resultado === "PROFIT")
    const perdidaRows = filtered.filter((r) => r.resultado === "PÉRDIDA")

    const avgGanProfit = profitRows.length
        ? profitRows.reduce((s, r) => s + (mParseTradingPct(r.ganancia) || 0), 0) / profitRows.length
        : 0
    const avgGanLoss = perdidaRows.length
        ? perdidaRows.reduce((s, r) => s + (mParseTradingPct(r.ganancia) || 0), 0) / perdidaRows.length
        : 0
    const avgRoiProfit = profitRows.length
        ? profitRows.reduce((s, r) => s + (mParseTradingPct(r.roi) || 0), 0) / profitRows.length
        : 0
    const avgRoiLoss = perdidaRows.length
        ? perdidaRows.reduce((s, r) => s + (mParseTradingPct(r.roi) || 0), 0) / perdidaRows.length
        : 0

    mediaEl.innerHTML = `
        <table class="mTradingTable">
            <thead>
                <tr>
                    <th>Resultado</th>
                    <th>Trades</th>
                    <th>Gan. media</th>
                    <th>ROI medio</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><span class="tradingResultBadge tradingProfit" style="font-size:12px">PROFIT</span></td>
                    <td>${escapeHtml(profitRows.length)}</td>
                    <td class="tradingPos">${mFmtTradingPct(avgGanProfit)}</td>
                    <td class="tradingPos">${avgRoiProfit >= 0 ? "+" : ""}${avgRoiProfit.toFixed(1).replace(".", ",")}%</td>
                </tr>
                <tr>
                    <td><span class="tradingResultBadge tradingPerdida" style="font-size:12px">PÉRDIDA</span></td>
                    <td>${escapeHtml(perdidaRows.length)}</td>
                    <td class="tradingNeg">${mFmtTradingPct(avgGanLoss)}</td>
                    <td class="tradingNeg">${avgRoiLoss >= 0 ? "+" : ""}${avgRoiLoss.toFixed(1).replace(".", ",")}%</td>
                </tr>
            </tbody>
        </table>
    `
}

function mRenderTradingRendimiento(rows) {
    const sorted = [...rows].sort((a, b) => {
        const da = String(a.fecha || "")
            .split(/[-/]/)
            .reverse()
            .join("")
        const db = String(b.fecha || "")
            .split(/[-/]/)
            .reverse()
            .join("")
        return da.localeCompare(db)
    })

    let acumulado = 0
    const labels = []
    const data = []

    sorted.forEach((r, i) => {
        const val = mParseTradingPct(r.ganancia) || 0
        acumulado += val
        labels.push(r.fecha || `#${i + 1}`)
        data.push(parseFloat(acumulado.toFixed(4)))
    })

    const positiveColor = "#2ecc71"
    const negativeColor = "#e74c3c"

    mCreateChart("mChartTradingRendimiento", {
        type: "line",
        data: {
            labels,
            datasets: [
                {
                    label: "Rendimiento neto acumulado (%)",
                    data,
                    borderColor: positiveColor,
                    backgroundColor: "rgba(46,204,113,0.08)",
                    borderWidth: 2,
                    pointRadius: data.length > 50 ? 0 : 3,
                    pointHoverRadius: 5,
                    tension: 0.35,
                    fill: true,
                    segment: {
                        borderColor: (ctx) => (ctx.p1.parsed.y >= 0 ? positiveColor : negativeColor)
                    }
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (c) => ` ${c.raw >= 0 ? "+" : ""}${c.raw.toFixed(2).replace(".", ",")}%`
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color: "#8899bb", maxTicksLimit: 12, maxRotation: 45 },
                    grid: { color: "rgba(255,255,255,0.06)" }
                },
                y: {
                    ticks: {
                        color: "#ccd6f6",
                        callback: (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + "%"
                    },
                    grid: { color: "rgba(255,255,255,0.06)" }
                }
            }
        }
    })
}

// ──────────────────────────────────────────────────────────────────────────

async function initMetricasLogic() {
    Object.values(_metricasCharts).forEach((c) => c?.destroy())
    _metricasCharts = {}
    _metricasDisplayType = window._metricasDisplayType ?? "doughnut"
    _metricasDistMetric = window._metricasDistMetric ?? "netoActualEur"
    // Selecciones del usuario: se recuperan de las preferencias guardadas. Cada
    // sección valida después el año/mes contra los que existan en sus datos.
    _metricasGastosMonth = getChartPref("metricasGastosMonth", "all")
    _metricasIngresosMonth = getChartPref("metricasIngresosMonth", "all")
    _metricasSaldoMesMonth = getChartPref("metricasSaldoMesMonth", null)
    _metricasSaldoMesCuenta = getChartPref("metricasSaldoMesCuenta", "all")
    _mSaldoMesSaldos = {}
    _metricasInteresesYear = getChartPref("metricasInteresesYear", null)
    _metricasDivMensualYear = getChartPref("metricasDivMensualYear", null)
    _metricasDivYear = getChartPref("metricasDivYear", null)
    _metricasInvertidoYear = getChartPref("metricasInvertidoYear", null)
    _metricasPasivosYear = getChartPref("metricasPasivosYear", null)
    _metricasSortKey = getChartPref("metricasSortKey", "netoActualEur")
    _metricasSortDir = getChartPref("metricasSortDir", "desc")
    const _divYearToggle = document.getElementById("mDivYearToggle")
    if (_divYearToggle) _divYearToggle.dataset.bound = ""
    const _allActivosTypes = ["cripto", "acciones", "etfs", "comoditis", "rentaFija"]
    const _savedHidden = window._metricasActivosHidden || []
    _metricasActivosFilter = new Set(_allActivosTypes.filter((t) => !_savedHidden.includes(t)))
    _metricasGastosTipoFilter = new Set()
    _metricasComparativaExclude = new Set(window._metricasComparativaExcluded || [])
    _metricasSectionsCollapsed = new Set(window._metricasSectionsCollapsed || [])
    _mGastosChartsCache = null
    _mSaldoMesCache = null
    _metricasPayload = null

    const loading = document.getElementById("metricasLoading")

    try {
        _metricasPayload = await buildMetricasPayload()
        if (loading) loading.classList.add("hidden")

        mUpdateKpis(_metricasPayload)
        mRenderAll(_metricasPayload)
        mBindTableSort(_metricasPayload.summaries)
        mOcultarApartadosSinDatos()
        mInitEvolucion()
        mInitEvolucionTipos()

        const _allTypes = ["cripto", "acciones", "etfs", "comoditis", "rentaFija"]
        const _todosBtn = document.querySelector(".mActivosFilterBtn[data-atype='todos']")
        const _specificBtns = [...document.querySelectorAll(".mActivosFilterBtn[data-atype]:not([data-atype='todos'])")]

        function _mIsTodosMode() {
            return _allTypes.every((t) => _metricasActivosFilter.has(t))
        }

        function _mActivosApplyVisual() {
            const todosMode = _mIsTodosMode()
            const todosInput = _todosBtn?.querySelector("input")
            if (todosInput) todosInput.checked = todosMode
            _specificBtns.forEach((b) => {
                const inp = b.querySelector("input")
                if (inp) inp.checked = !todosMode && _metricasActivosFilter.has(b.dataset.atype)
            })
        }

        function _mActivosSave() {
            const hidden = _allTypes.filter((t) => !_metricasActivosFilter.has(t))
            window._metricasActivosHidden = hidden
            fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ metricasActivosHidden: hidden })
            }).catch(() => {})
        }

        function _mActivosRender() {
            mRenderDistActivos(
                _metricasPayload.summaries,
                _metricasDisplayType,
                _metricasPayload.bonos || [],
                _metricasPayload.rentaFija || [],
                _metricasDistMetric
            )
        }

        _mActivosApplyVisual()

        if (_todosBtn) {
            const todosInput = _todosBtn.querySelector("input")
            if (todosInput) {
                todosInput.addEventListener("change", () => {
                    _allTypes.forEach((t) => _metricasActivosFilter.add(t))
                    _mActivosApplyVisual()
                    _mActivosSave()
                    _mActivosRender()
                })
            }
        }

        _specificBtns.forEach((btn) => {
            const inp = btn.querySelector("input")
            if (inp) {
                inp.addEventListener("change", () => {
                    const tipo = btn.dataset.atype
                    if (_mIsTodosMode()) {
                        _metricasActivosFilter.clear()
                        _metricasActivosFilter.add(tipo)
                    } else if (!inp.checked) {
                        _metricasActivosFilter.delete(tipo)
                        if (_metricasActivosFilter.size === 0) _allTypes.forEach((t) => _metricasActivosFilter.add(t))
                    } else {
                        _metricasActivosFilter.add(tipo)
                    }
                    _mActivosApplyVisual()
                    _mActivosSave()
                    _mActivosRender()
                })
            }
        })

        const toggleBtns = document.querySelectorAll(".mToggleBtn[data-charttype]")
        toggleBtns.forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.charttype === _metricasDisplayType)
            btn.addEventListener("click", () => {
                toggleBtns.forEach((b) => b.classList.remove("active"))
                btn.classList.add("active")
                _metricasDisplayType = btn.dataset.charttype
                window._metricasDisplayType = _metricasDisplayType
                fetch("/api/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ metricasDisplayType: _metricasDisplayType })
                })
                mRenderDistTipos(
                    _metricasPayload.summaries,
                    _metricasDisplayType,
                    _metricasPayload.bonos || [],
                    _metricasPayload.rentaFija || [],
                    _metricasDistMetric
                )
                mRenderDistActivos(
                    _metricasPayload.summaries,
                    _metricasDisplayType,
                    _metricasPayload.bonos || [],
                    _metricasPayload.rentaFija || [],
                    _metricasDistMetric
                )
            })
        })

        const metricBtns = document.querySelectorAll(".mDistMetricBtn")
        metricBtns.forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.metric === _metricasDistMetric)
            btn.addEventListener("click", () => {
                metricBtns.forEach((b) => b.classList.remove("active"))
                btn.classList.add("active")
                _metricasDistMetric = btn.dataset.metric
                window._metricasDistMetric = _metricasDistMetric
                fetch("/api/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ metricasDistMetric: _metricasDistMetric })
                })
                mRenderDistTipos(
                    _metricasPayload.summaries,
                    _metricasDisplayType,
                    _metricasPayload.bonos || [],
                    _metricasPayload.rentaFija || [],
                    _metricasDistMetric
                )
                mRenderDistActivos(
                    _metricasPayload.summaries,
                    _metricasDisplayType,
                    _metricasPayload.bonos || [],
                    _metricasPayload.rentaFija || [],
                    _metricasDistMetric
                )
            })
        })

        // ── nav tabs (single-select) ─────────────────────────────────────
        const navTabsContainer = document.querySelector(".mNavTabs")
        const todoInput = navTabsContainer?.querySelector('.mNavTab[data-mcat="todo"] input')
        let _mActiveCats = new Set()

        function mSaveNavCat(mcat) {
            setChartPref("metricasNavCat", mcat || null)
        }

        function mApplyNavFilter() {
            document
                .querySelectorAll(
                    ".metricasSection[data-mcat], .metricasKpiRow[data-mcat], .metricasCatDivider[data-mcat]"
                )
                .forEach((el) => {
                    const elCat = el.dataset.mcat
                    const catMatch = _mActiveCats.size === 0 || [..._mActiveCats].some((c) => elCat === c)
                    el.style.display = catMatch ? "" : "none"
                })
        }

        navTabsContainer?.addEventListener("change", (e) => {
            const input = e.target
            if (!input.matches('input[type="checkbox"]')) return
            const tab = input.closest(".mNavTab")
            if (!tab) return
            const mcat = tab.dataset.mcat
            const allInputs = navTabsContainer.querySelectorAll(".mNavTab input")
            if (mcat === "todo") {
                if (!input.checked) input.checked = true
                _mActiveCats.clear()
                allInputs.forEach((i) => {
                    if (i !== input) i.checked = false
                })
                mSaveNavCat(null)
                mApplyNavFilter()
            } else if (input.checked) {
                allInputs.forEach((i) => {
                    if (i !== input) i.checked = false
                })
                _mActiveCats = new Set(mcat.split(",").map((s) => s.trim()))
                mSaveNavCat(mcat)
                mApplyNavFilter()
                // scroll to first visible KPI row of this category
                const firstCat = mcat.split(",")[0].trim()
                const target =
                    document.querySelector(`.metricasKpiRow[data-mcat="${mcat}"]`) ||
                    document.querySelector(`.metricasKpiRow[data-mcat="${firstCat}"]`)
                const scrollEl = document.querySelector(".mainContent")
                if (target && scrollEl) {
                    const navH = document.querySelector(".mNavBar")?.offsetHeight || 60
                    const top =
                        target.getBoundingClientRect().top -
                        scrollEl.getBoundingClientRect().top +
                        scrollEl.scrollTop -
                        navH -
                        8
                    scrollEl.scrollTo({ top, behavior: "smooth" })
                }
            } else {
                if (todoInput) todoInput.checked = true
                _mActiveCats.clear()
                mSaveNavCat(null)
                mApplyNavFilter()
            }
        })

        // Restaurar la categoría que el usuario dejó seleccionada (sin scroll:
        // al entrar en la página se empieza arriba).
        const _savedNavCat = getChartPref("metricasNavCat", null)
        const _savedNavTab = _savedNavCat
            ? navTabsContainer?.querySelector(`.mNavTab[data-mcat="${_savedNavCat}"] input`)
            : null
        if (_savedNavTab) {
            navTabsContainer.querySelectorAll(".mNavTab input").forEach((i) => {
                i.checked = i === _savedNavTab
            })
            _mActiveCats = new Set(_savedNavCat.split(",").map((s) => s.trim()))
            mApplyNavFilter()
        } else if (_savedNavCat) {
            mSaveNavCat(null)
        }

        // ── section collapse ────────────────────────────────────────────────
        function _mSectionContentEls(sec) {
            return [...sec.children].filter((c) => !c.classList.contains("metricasSectionHeader"))
        }
        function _mApplySectionCollapse(sec, collapsed) {
            _mSectionContentEls(sec).forEach((el) => el.classList.toggle("mSectionBodyHidden", collapsed))
            sec.querySelector(".metricasSectionTitle")?.classList.toggle("mSectionCollapsed", collapsed)
        }
        function _mSaveSectionsCollapsed() {
            window._metricasSectionsCollapsed = [..._metricasSectionsCollapsed]
            fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ metricasSectionsCollapsed: [..._metricasSectionsCollapsed] })
            }).catch(() => {})
        }
        document.querySelectorAll(".metricasSection[id]").forEach((sec) => {
            _mApplySectionCollapse(sec, _metricasSectionsCollapsed.has(sec.id))
            const title = sec.querySelector(".metricasSectionTitle")
            if (!title || title._mCollapseListened) return
            title._mCollapseListened = true
            title.addEventListener("click", () => {
                const nowCollapsed = !_metricasSectionsCollapsed.has(sec.id)
                if (nowCollapsed) _metricasSectionsCollapsed.add(sec.id)
                else _metricasSectionsCollapsed.delete(sec.id)
                _mApplySectionCollapse(sec, nowCollapsed)
                _mSaveSectionsCollapsed()
            })
        })
    } catch (err) {
        console.error("Error cargando métricas:", err)
        if (loading) loading.textContent = "Error al cargar los datos."
    }
}
