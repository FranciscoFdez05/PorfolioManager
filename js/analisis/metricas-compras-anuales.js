// Métricas: resumen anual de activos (qué se compró cada año y cómo rinde hoy lo que queda).
//
// Las cifras las calcula el servidor (/api/metricas/compras-anuales) con el mismo
// FIFO de posición que la ficha del activo; aquí solo se pintan. Comparte el
// ámbito global con el resto de trozos de Métricas (index.html los carga seguidos).

const M_COMPRAS_COLOR_COSTE = "#3a7bd5"
const M_COMPRAS_COLOR_VALOR = "#f7931a"
const M_COMPRAS_COLOR_POS = "#2ecc71"
const M_COMPRAS_COLOR_NEG = "#e74c3c"

// Año elegido en el selector. Null hasta el primer render, que lo toma de las
// preferencias guardadas y lo valida contra los años que haya.
let _metricasComprasAnio = null
// Último resumen recibido: el selector lo necesita para repintar el año sin
// volver a pedir nada al servidor.
let _mComprasAnualesData = null

/**
 * Pinta la sección «Resumen anual de activos».
 *
 * @param {{anios: Array<object>, sinTipo: Array<string>}|null} data Respuesta de
 *     /api/metricas/compras-anuales, o null si la petición falló.
 */
function mRenderComprasAnuales(data) {
    const section = document.getElementById("mSectionComprasAnuales")
    const anios = Array.isArray(data?.anios) ? data.anios : []
    _mComprasAnualesData = data
    if (!anios.length) {
        section?.classList.add("hidden")
        return
    }
    section?.classList.remove("hidden")

    const disponibles = anios.map((a) => String(a.anio))
    const preferido = _metricasComprasAnio ?? getChartPref("metricasComprasAnio", null)
    _metricasComprasAnio = disponibles.includes(String(preferido)) ? String(preferido) : disponibles[0]

    mPintarSelectorComprasAnio(disponibles)
    mPintarGraficosComprasAnuales(anios)
    mPintarComprasDelAnio(anios.find((a) => String(a.anio) === _metricasComprasAnio))
    mPintarNotaComprasAnuales(data.sinTipo || [])
}

function mPintarSelectorComprasAnio(disponibles) {
    const toggle = document.getElementById("mComprasYearToggle")
    if (!toggle) return
    toggle.innerHTML = disponibles
        .map(
            (y) =>
                `<button class="mToggleBtn${y === _metricasComprasAnio ? " active" : ""}" data-comprasyr="${y}">${y}</button>`
        )
        .join("")
    if (toggle.dataset.bound) return
    toggle.dataset.bound = "true"
    toggle.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-comprasyr]")
        if (!btn) return
        toggle.querySelectorAll(".mToggleBtn").forEach((b) => b.classList.toggle("active", b === btn))
        _metricasComprasAnio = btn.dataset.comprasyr
        setChartPref("metricasComprasAnio", _metricasComprasAnio)
        const anios = _mComprasAnualesData?.anios || []
        mPintarComprasDelAnio(anios.find((a) => String(a.anio) === _metricasComprasAnio))
    })
}

function mEtiquetaAnioCompras(anio) {
    return String(anio) === String(new Date().getFullYear()) ? `${anio} (YTD)` : String(anio)
}

function mPintarGraficosComprasAnuales(anios) {
    // Del más antiguo al más reciente, que es como se lee un eje temporal.
    const cronologico = [...anios].reverse()
    const labels = cronologico.map((a) => mEtiquetaAnioCompras(a.anio))

    mCreateChart("mChartComprasAnualesValor", {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: "Coste en cartera",
                    data: cronologico.map((a) => a.costeVivo),
                    backgroundColor: M_COMPRAS_COLOR_COSTE + "aa",
                    borderColor: M_COMPRAS_COLOR_COSTE,
                    borderWidth: 1,
                    borderRadius: 4
                },
                {
                    label: "Valor actual",
                    data: cronologico.map((a) => a.valorActual),
                    backgroundColor: M_COMPRAS_COLOR_VALOR + "aa",
                    borderColor: M_COMPRAS_COLOR_VALOR,
                    borderWidth: 1,
                    borderRadius: 4
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${formatEuro(c.raw)}` } }
            },
            scales: { x: mAxisX(), y: { ...mAxisY(), ticks: { color: "#ccd6f6", callback: (v) => formatEuro(v) } } }
        }
    })

    // Un año vendido entero no tiene porcentaje: se deja el hueco en vez de un 0.
    const pcts = cronologico.map((a) => a.rendimientoPct)
    mCreateChart("mChartComprasAnualesRend", {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: "Rendimiento (%)",
                    data: pcts,
                    backgroundColor: pcts.map((v) => (v >= 0 ? M_COMPRAS_COLOR_POS : M_COMPRAS_COLOR_NEG) + "cc"),
                    borderColor: pcts.map((v) => (v >= 0 ? M_COMPRAS_COLOR_POS : M_COMPRAS_COLOR_NEG)),
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
                tooltip: {
                    callbacks: {
                        label: (c) => {
                            const anio = cronologico[c.dataIndex]
                            return ` ${formatPercent(c.raw)}  (${formatEuro(anio.rendimiento)})`
                        }
                    }
                }
            },
            scales: {
                x: mAxisX(),
                y: { ...mAxisY(), ticks: { color: "#ccd6f6", callback: (v) => formatPercent(v) } }
            }
        }
    })
}

function mClaseSigno(valor, positiva, negativa) {
    if (valor === null || valor === undefined || valor === 0) return ""
    return valor > 0 ? positiva : negativa
}

function mPintarComprasDelAnio(anio) {
    const label = document.getElementById("mkpiComprasAnioLabel")
    if (label) label.textContent = anio ? `Compras de ${anio.anio}` : "Compras del año"
    if (!anio) {
        ;["mkpiComprasInvertido", "mkpiComprasCosteVivo", "mkpiComprasValor", "mkpiComprasRend"].forEach((id) =>
            mSetKpi(id, "---")
        )
        const tbody = document.getElementById("mComprasTableBody")
        if (tbody) tbody.innerHTML = ""
        return
    }

    const nActivos = anio.numActivos
    mSetKpi("mkpiComprasInvertido", formatEuro(anio.comprado))
    mSetSub("mkpiComprasActivos", `${nActivos} ${nActivos === 1 ? "activo" : "activos"}`)
    mSetKpi("mkpiComprasCosteVivo", formatEuro(anio.costeVivo))
    mSetSub("mkpiComprasVendido", `${formatPercent(anio.pctVendido)} vendido`)
    mSetKpi("mkpiComprasValor", formatEuro(anio.valorActual))
    mSetKpi(
        "mkpiComprasRend",
        formatEuro(anio.rendimiento),
        mClaseSigno(anio.costeVivo > 0 ? anio.rendimiento : 0, "mPositive", "mNegative")
    )
    mSetSub(
        "mkpiComprasRendPct",
        anio.rendimientoPct === null ? "Vendido entero" : formatPercent(anio.rendimientoPct),
        mClaseSigno(anio.rendimientoPct, "mPositive", "mNegative")
    )

    mPintarTablaCompras(anio.activos || [])
}

function mPintarTablaCompras(activos) {
    const tbody = document.getElementById("mComprasTableBody")
    if (!tbody) return
    tbody.innerHTML = activos
        .map((a) => {
            const vivo = a.cantidadViva > 0
            const rClass = vivo ? mClaseSigno(a.rendimiento, "mCellPos", "mCellNeg") : ""
            const typeLabel = M_TYPE_LABELS[a.tipo] || a.tipo
            const typeColor = M_TYPE_COLORS[a.tipo] || "#888"
            return `
        <tr>
            <td class="mTdName">${escapeMetricasHtml(a.nombre)}</td>
            <td><span class="mTypeBadge" style="background:${typeColor}22;color:${typeColor};border-color:${typeColor}44">${escapeMetricasHtml(typeLabel)}</span></td>
            <td>${formatEuro(a.comprado)}</td>
            <td>${formatPercent(a.pctVendido)}</td>
            <td>${vivo ? formatEuro(a.costeVivo) : "---"}</td>
            <td>${vivo ? formatEuro(a.valorActual) : "---"}</td>
            <td class="${rClass}">${vivo ? formatEuro(a.rendimiento) : "---"}</td>
            <td class="${rClass}">${a.rendimientoPct === null ? "---" : formatPercent(a.rendimientoPct)}</td>
        </tr>`
        })
        .join("")
}

function mPintarNotaComprasAnuales(sinTipo) {
    const nota = document.getElementById("mComprasNota")
    if (!nota) return
    const avisoDivisa = sinTipo.length
        ? ` Sin tipo de cambio para ${sinTipo.join(", ")}: esos importes se suman sin convertir a euros.`
        : ""
    nota.textContent =
        "El rendimiento es el de lo que sigue en cartera de las compras de cada año, con el coste FIFO y " +
        "comisiones incluidas; lo vendido solo aparece como % vendido y su resultado está en Ventas." +
        avisoDivisa
    nota.classList.remove("hidden")
}
