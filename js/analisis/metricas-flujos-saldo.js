// Análisis > Métricas: evolución del saldo durante el mes.
//
// Trozo de js/analisis/metricas-flujos.js. Comparte con el resto de metricas-flujos-*.js el
// ámbito global y se carga detrás de metricas-flujos.js, en el orden de index.html.

// ── evolución del saldo durante el mes ─────────────────────────────────────

// eslint-disable-next-line prefer-const -- se reasigna desde metricas-init.js
let _mSaldoMesSaldos = {}
let _mSaldoMesPeticion = 0

// Día a día, de la cuenta elegida o de todas juntas. Arranca en el saldo con el
// que la cuenta entra en el mes (todo lo anterior, no solo este mes), suma cada
// ingreso y resta cada gasto en su fecha; recurrentes y mensualidades van en su
// día de cobro (el 1 si no tienen). Lo que se cobra o paga con otra cuenta solo
// cuenta en esa cuenta. Entre todas, una transferencia no mueve nada (solo su
// comisión): el dinero cambia de cuenta, no sale.
const M_CUENTA_BANCO = "banco"

function mCuentaDeMovimiento(cuenta) {
    const existe = window._cuentasDinero.some((c) => c.id === cuenta)
    return cuenta && existe ? cuenta : M_CUENTA_BANCO
}

function mComputeSaldoMesSeries(ingresosYearData, gastosYearData, year, monthKey, cuentaSel, saldosMes) {
    const monthIdx = M_GASTOS_KEYS.indexOf(monthKey)
    const daysInMonth = new Date(Number(year), monthIdx + 1, 0).getDate()
    const todas = cuentaSel === "all"
    const esDeLaCuenta = (cuenta) => todas || mCuentaDeMovimiento(cuenta) === cuentaSel

    const ids = todas ? Object.keys(saldosMes) : [cuentaSel]
    const startBalance = ids.reduce((suma, id) => suma + parseEuroNumber(saldosMes[id]?.inicial || ""), 0)

    const deltaPorDia = Array(daysInMonth + 1).fill(0)
    const movs = Array.from({ length: daysInMonth + 1 }, () => [])
    const dayOf = (fecha) => {
        const d = parseInt(String(fecha || "").split("-")[0], 10)
        return d >= 1 && d <= daysInMonth ? d : 1
    }
    const diaCobro = (dia) => Math.min(Number(normalizeMensualidadDia(dia)) || 1, daysInMonth)
    const anotar = (d, nombre, importe) => {
        deltaPorDia[d] += importe
        movs[d].push({ nombre, importe })
    }

    ;(ingresosYearData?.recurrentes || []).forEach((r) => {
        const val = parseEuroNumber(r.meses?.[monthKey] || "")
        if (val <= 0 || !esDeLaCuenta(r.cuentasCobro?.[monthKey] || r.cuenta)) return
        anotar(diaCobro(r.diaCobro), r.nombre || "Ingreso recurrente", val)
    })
    ;(ingresosYearData?.months?.[monthKey]?.rows || []).forEach((row) => {
        const val = parseEuroNumber(row.cantidad || "")
        if (val <= 0 || !esDeLaCuenta(row.cuenta)) return
        anotar(dayOf(row.fecha), row.nombre || row.tipo || "Ingreso", val)
    })

    ;(gastosYearData?.mensualidades || []).forEach((m) => {
        const val = parseEuroNumber(m.meses?.[monthKey] || "")
        if (val <= 0 || !esDeLaCuenta(m.cuentasCobro?.[monthKey] || m.cuenta)) return
        anotar(diaCobro(getMensualidadDiaMes(m, monthKey)), m.nombre || "Mensualidad", -val)
    })
    ;(gastosYearData?.months?.[monthKey]?.rows || []).forEach((row) => {
        const val = parseEuroNumber(row.cantidad || "")
        if (val <= 0 || !esDeLaCuenta(row.cuenta)) return
        anotar(dayOf(row.fecha), row.nombre || row.tipo || "Gasto", -val)
    })

    _metricasTransferencias.forEach((t) => {
        if (t.year !== String(year) || t.month !== monthKey) return
        const val = parseEuroNumber(t.cantidad || "")
        if (val <= 0) return
        const d = dayOf(t.fecha)
        const comision = parseEuroNumber(t.comision || "")

        if (!todas && t.destino === cuentaSel) {
            anotar(d, t.concepto || `Transferencia desde ${nombreDeCuenta(t.origen)}`, val)
        }
        if (!todas && t.origen === cuentaSel) {
            anotar(d, t.concepto || `Transferencia a ${nombreDeCuenta(t.destino)}`, -val)
        }
        // La comisión sale de la cuenta de origen además de la cantidad.
        if (comision > 0 && (todas || t.origen === cuentaSel)) {
            anotar(d, `Comisión${t.concepto ? " · " + t.concepto : ""}`, -comision)
        }
    })

    // Intereses y dividendos no tienen día en la cuenta: se anotan al cierre del mes.
    const rendimientos = ids.reduce((suma, id) => suma + parseEuroNumber(saldosMes[id]?.rendimientos || ""), 0)
    if (rendimientos) anotar(daysInMonth, "Intereses y dividendos", rendimientos)

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

// Saldos con los que cada cuenta entra en el mes; se piden una vez por mes.
async function mCargarSaldosMes(year, monthKey) {
    const clave = `${year}-${monthKey}`
    if (!_mSaldoMesSaldos[clave]) {
        const datos = await fetch(`/api/cuentas/saldos-mes?year=${year}&month=${monthKey}`)
            .then((r) => r.json())
            .catch(() => null)
        _mSaldoMesSaldos[clave] = datos?.cuentas || {}
    }
    return _mSaldoMesSaldos[clave]
}

async function mRenderSaldoMesChart(ingresosYearData, gastosYearData, year, monthKey) {
    const peticion = ++_mSaldoMesPeticion
    const saldosMes = await mCargarSaldosMes(year, monthKey)
    // Si mientras tanto se ha cambiado de mes o de cuenta, esta respuesta ya no vale.
    if (peticion !== _mSaldoMesPeticion) return

    const { dayLabels, balances, startBalance, movimientos } = mComputeSaldoMesSeries(
        ingresosYearData,
        gastosYearData,
        year,
        monthKey,
        _metricasSaldoMesCuenta,
        saldosMes
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

function mRenderSaldoMesCuentaToggle() {
    const toggle = document.getElementById("mSaldoMesCuentaToggle")
    if (!toggle) return
    const cuentas = window._cuentasDinero
    // Con una sola cuenta no hay nada que elegir.
    toggle.classList.toggle("hidden", cuentas.length < 2)
    if (_metricasSaldoMesCuenta !== "all" && !cuentas.some((c) => c.id === _metricasSaldoMesCuenta)) {
        _metricasSaldoMesCuenta = "all"
    }
    if (!toggle.dataset.bound) {
        toggle.dataset.bound = "true"
        toggle.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-saldomescuenta]")
            if (!btn) return
            _metricasSaldoMesCuenta = btn.dataset.saldomescuenta
            setChartPref("metricasSaldoMesCuenta", _metricasSaldoMesCuenta)
            mRenderSaldoMesCuentaToggle()
            mRenderSaldoMesChart(
                _mSaldoMesCache?.ingresosYearData,
                _mSaldoMesCache?.gastosYearData,
                _mSaldoMesCache?.ingresosYearData?.year,
                _metricasSaldoMesMonth
            )
        })
    }
    toggle.innerHTML = [{ id: "all", nombre: "Todas" }, ...cuentas]
        .map(
            (c) =>
                `<button class="mToggleBtn${c.id === _metricasSaldoMesCuenta ? " active" : ""}" data-saldomescuenta="${escapeHtml(c.id)}">${escapeHtml(c.nombre)}</button>`
        )
        .join("")
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

    mRenderSaldoMesCuentaToggle()

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
