// ===== CUENTAS DE AHORRO =====
// Dinero apartado de la cuenta bancaria. Los movimientos son filas normales de
// Gastos (aportación) e Ingresos (retirada) con la categoría reservada
// AHORRO_TIPO_RESERVADO; esta ventana las lee de /api/cuenta-ahorro. La cuenta
// principal usa la categoría tal cual y las demás la llevan de prefijo.

const CUENTA_AHORRO_MONTH_KEYS = [
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
const CUENTA_AHORRO_MONTH_LABELS = ["E", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"]
// Meses que se promedian para estimar cuándo se alcanza el objetivo.
const CUENTA_AHORRO_MESES_RITMO = 6

let cuentaAhorroYear = null
let cuentaAhorroYears = []
let cuentaAhorroTab = "movimientos"
let cuentaAhorroCuenta = ""
let cuentaAhorroNombres = []
let cuentaAhorroMovs = []
let cuentaAhorroRemuneradas = []
let cuentaAhorroDividendos = []
let cuentaAhorroDivEur = []
let cuentaAhorroConfig = { cuentas: [] }
let cuentaAhorroBanco = { ingresos: 0, gastos: 0 }
let cuentaAhorroChartData = null
// Orden de cada tabla; se mantiene al cambiar de año, de cuenta o de pestaña.
const cuentaAhorroSort = {
    movimientos: { key: "fecha", dir: "desc" },
    rendimientos: { key: "fecha", dir: "desc" }
}

async function initCuentaAhorroLogic() {
    try {
        const [movs, gasYears, ingYears, settings, intereses, dividendos] = await Promise.all([
            Api.get("/api/cuenta-ahorro"),
            Api.get("/api/gastos").catch(() => ({ years: [] })),
            Api.get("/api/ingresos").catch(() => ({ years: [] })),
            Api.get("/api/settings").catch(() => ({})),
            Api.get("/api/intereses").catch(() => ({ cuentas: [] })),
            Api.get("/api/dividendos").catch(() => ({ rows: [] }))
        ])

        applyCuentaAhorroData(movs)
        cuentaAhorroRemuneradas = Array.isArray(intereses?.cuentas) ? intereses.cuentas : []
        cuentaAhorroDividendos = Array.isArray(dividendos?.rows) ? dividendos.rows : []
        cuentaAhorroConfig = normalizeCuentaAhorroConfig(settings?.cuentaAhorroConfig)

        const thisYear = String(new Date().getFullYear())
        const years = new Set([
            thisYear,
            String(Number(thisYear) + 1),
            ...(gasYears?.years || []),
            ...(ingYears?.years || []),
            ...cuentaAhorroMovs.map((m) => m.year)
        ])
        cuentaAhorroYears = [...years].sort()
        cuentaAhorroYear = cuentaAhorroYears.includes(cuentaAhorroYear) ? cuentaAhorroYear : thisYear
        cuentaAhorroTab = "movimientos"

        bindCuentaAhorroEvents()
        await refreshCuentaAhorro()
    } catch (error) {
        console.error("Error inicializando la cuenta de ahorro:", error)
        showError("No se pudo cargar la cuenta de ahorro", error)
    }
}

// ── Cuentas y configuración ──────────────────────────────────────────────

function applyCuentaAhorroData(data) {
    cuentaAhorroMovs = Array.isArray(data?.movimientos) ? data.movimientos : []
    cuentaAhorroNombres = Array.isArray(data?.cuentas) ? data.cuentas : []
    if (!getCuentaAhorroNombres().some((n) => sameCuentaAhorro(n, cuentaAhorroCuenta))) cuentaAhorroCuenta = ""
}

function sameCuentaAhorro(a, b) {
    return String(a || "").toLowerCase() === String(b || "").toLowerCase()
}

// La cuenta principal ("") y después las demás.
function getCuentaAhorroNombres() {
    return ["", ...cuentaAhorroNombres]
}

function getCuentaAhorroLabel(nombre) {
    return nombre || "Cuenta de ahorro"
}

function emptyCuentaAhorroCfg(nombre = "") {
    return {
        nombre,
        remuneradas: [],
        incluirDividendos: false,
        objetivo: "",
        recurrente: { activa: false, importe: "", dia: 1, desde: "" }
    }
}

function normalizeCuentaAhorroCfg(raw, nombre) {
    const base = emptyCuentaAhorroCfg(nombre)
    const rec = raw?.recurrente || {}
    return {
        nombre,
        remuneradas: Array.isArray(raw?.remuneradas) ? raw.remuneradas.map(String) : [],
        incluirDividendos: Boolean(raw?.incluirDividendos),
        objetivo: String(raw?.objetivo || ""),
        recurrente: {
            activa: Boolean(rec.activa),
            importe: String(rec.importe || ""),
            dia: Number(rec.dia) || base.recurrente.dia,
            desde: String(rec.desde || "")
        }
    }
}

// Acepta la forma antigua (una cuenta con cuentasRemuneradas / incluirDividendos).
function normalizeCuentaAhorroConfig(raw) {
    const entradas = Array.isArray(raw?.cuentas)
        ? raw.cuentas
        : [{ nombre: "", remuneradas: raw?.cuentasRemuneradas, incluirDividendos: raw?.incluirDividendos }]
    return { cuentas: entradas.map((e) => normalizeCuentaAhorroCfg(e, String(e?.nombre || ""))) }
}

function getCuentaAhorroCfg(nombre = cuentaAhorroCuenta) {
    const found = cuentaAhorroConfig.cuentas.find((c) => sameCuentaAhorro(c.nombre, nombre))
    return found || emptyCuentaAhorroCfg(nombre)
}

function setCuentaAhorroCfg(cfg) {
    const index = cuentaAhorroConfig.cuentas.findIndex((c) => sameCuentaAhorro(c.nombre, cfg.nombre))
    if (index >= 0) cuentaAhorroConfig.cuentas[index] = cfg
    else cuentaAhorroConfig.cuentas.push(cfg)
}

async function saveCuentaAhorroConfig() {
    await Api.post("/api/settings", { cuentaAhorroConfig })
}

function getCuentaAhorroMovs() {
    return cuentaAhorroMovs.filter((m) => sameCuentaAhorro(m.cuenta, cuentaAhorroCuenta))
}

// ── Datos ────────────────────────────────────────────────────────────────

async function loadCuentaAhorroBanco(year) {
    const sumYear = (data, recurrentesKey) => {
        if (!data) return 0
        let total = 0
        CUENTA_AHORRO_MONTH_KEYS.forEach((month) => {
            ;(data.months?.[month]?.rows || []).forEach((row) => {
                total += parseEuroNumber(row.cantidad || "")
            })
            ;(data[recurrentesKey] || []).forEach((row) => {
                total += parseEuroNumber(row.meses?.[month] || "")
            })
        })
        return total
    }

    const [ingresos, gastos] = await Promise.all([
        Api.get(`/api/ingresos/${encodeURIComponent(year)}`).catch(() => null),
        Api.get(`/api/gastos/${encodeURIComponent(year)}`).catch(() => null)
    ])
    cuentaAhorroBanco = {
        ingresos: sumYear(ingresos, "recurrentes"),
        gastos: sumYear(gastos, "mensualidades")
    }
}

const _cuentaAhorroRates = new Map()

function getCuentaAhorroRateToEur(from) {
    const code = String(from || "EUR").toUpperCase()
    if (code === "EUR") return Promise.resolve(1)
    if (!_cuentaAhorroRates.has(code)) {
        _cuentaAhorroRates.set(
            code,
            Api.get(`/api/exchange-rate?from=${encodeURIComponent(code)}&to=EUR`)
                .then((data) => (data?.ok && data.rate ? Number(data.rate) : 1))
                .catch(() => 1)
        )
    }
    return _cuentaAhorroRates.get(code)
}

// Los dividendos se cobran en cualquier divisa; la cuenta de ahorro es en euros.
async function loadCuentaAhorroDividendos() {
    if (!getCuentaAhorroCfg().incluirDividendos) {
        cuentaAhorroDivEur = []
        return
    }

    cuentaAhorroDivEur = await Promise.all(
        cuentaAhorroDividendos.map(async (row) => {
            const rate = await getCuentaAhorroRateToEur(row.monedaTotal)
            return { row, importe: (parseLooseNumber(row.total || "") ?? 0) * rate }
        })
    )
}

function splitCuentaAhorroFecha(fecha) {
    const parts = splitDividendoFecha(fecha)
    const month = Number(parts?.mes)
    if (!parts || !/^\d{4}$/.test(parts.anio) || !(month >= 1 && month <= 12)) return null
    return { year: parts.anio, month: month - 1, day: Number(parts.dia) || 0 }
}

function parseCuentaAhorroSortKey(fecha) {
    const p = splitCuentaAhorroFecha(fecha)
    return p ? new Date(Number(p.year), p.month, p.day || 1).getTime() : 0
}

// Cuentas remuneradas que cuentan para la cuenta seleccionada.
function getCuentaAhorroRemuneradasVinculadas() {
    const ids = getCuentaAhorroCfg().remuneradas
    return cuentaAhorroRemuneradas.filter((cuenta) => ids.includes(cuenta.id))
}

// Todo lo que entra o sale de la cuenta seleccionada, con su año y mes.
function buildCuentaAhorroFlows() {
    const flows = []

    getCuentaAhorroMovs().forEach((m) => {
        const month = CUENTA_AHORRO_MONTH_KEYS.indexOf(m.month)
        if (month < 0) return
        const sign = m.kind === "retiro" ? -1 : 1
        flows.push({
            type: "aporte",
            year: m.year,
            month,
            importe: sign * parseEuroNumber(m.cantidad || "")
        })
    })

    getCuentaAhorroRemuneradasVinculadas().forEach((cuenta) => {
        ;(cuenta.rows || []).forEach((row) => {
            const p = splitCuentaAhorroFecha(row.fecha)
            if (!p) return
            flows.push({
                type: "remunerada",
                year: p.year,
                month: p.month,
                importe: parseEuroNumber(row.acumulado || "") - parseEuroNumber(row.impuestos || "")
            })
        })
    })

    cuentaAhorroDivEur.forEach(({ row, importe }) => {
        const p = splitCuentaAhorroFecha(row.fecha)
        if (!p) return
        flows.push({ type: "dividendo", year: p.year, month: p.month, importe })
    })

    return flows
}

// ── Pintado ──────────────────────────────────────────────────────────────

async function refreshCuentaAhorro() {
    await Promise.all([loadCuentaAhorroBanco(cuentaAhorroYear), loadCuentaAhorroDividendos()])
    renderCuentaAhorroCuentas()
    renderCuentaAhorroYears()
    renderCuentaAhorroTabs()
    renderCuentaAhorroTable()
    renderCuentaAhorroSummary()
}

function renderCuentaAhorroCuentas() {
    const bar = document.getElementById("cuentaAhorroCuentas")
    if (bar) {
        const nombres = getCuentaAhorroNombres()
        bar.hidden = nombres.length < 2
        bar.innerHTML = ""
        nombres.forEach((nombre) => {
            const btn = document.createElement("button")
            btn.type = "button"
            btn.className = `gastosYearBtn${sameCuentaAhorro(nombre, cuentaAhorroCuenta) ? " active" : ""}`
            btn.textContent = getCuentaAhorroLabel(nombre)
            btn.addEventListener("click", async () => {
                cuentaAhorroCuenta = nombre
                await refreshCuentaAhorro()
            })
            bar.appendChild(btn)
        })
    }

    // Renombrar y eliminar no valen para la cuenta principal.
    const principal = cuentaAhorroCuenta === ""
    ;["cuentaAhorroRenameBtn", "cuentaAhorroDeleteBtn"].forEach((id) => {
        const btn = document.getElementById(id)
        if (btn) btn.style.display = principal ? "none" : ""
    })
}

function renderCuentaAhorroYears() {
    const list = document.getElementById("cuentaAhorroYearList")
    if (!list) return
    list.innerHTML = ""
    cuentaAhorroYears.forEach((year) => {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = `gastosYearBtn${year === cuentaAhorroYear ? " active" : ""}`
        btn.textContent = year
        btn.addEventListener("click", async () => {
            cuentaAhorroYear = year
            await refreshCuentaAhorro()
        })
        list.appendChild(btn)
    })
}

function renderCuentaAhorroTabs() {
    document.querySelectorAll("[data-cuenta-ahorro-tab]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.cuentaAhorroTab === cuentaAhorroTab)
    })
    const actions = document.getElementById("cuentaAhorroActions")
    if (actions) actions.classList.toggle("hidden", cuentaAhorroTab !== "movimientos")
}

function formatCuentaAhorroSigned(value) {
    return (value > 0 ? "+" : "") + formatEuro(value)
}

function getCuentaAhorroMovimientosDelAnio() {
    return getCuentaAhorroMovs()
        .filter((m) => m.year === cuentaAhorroYear)
        .sort((a, b) => parseCuentaAhorroSortKey(b.fecha) - parseCuentaAhorroSortKey(a.fecha) || b.id - a.id)
}

// Cabecera con columnas ordenables: la activa lleva una flecha con el sentido.
function buildCuentaAhorroHead(columnas, extra = "") {
    const sort = cuentaAhorroSort[cuentaAhorroTab]
    const celdas = columnas
        .map(({ key, label, num }) => {
            const activa = sort.key === key
            const flecha = activa ? (sort.dir === "asc" ? "▲" : "▼") : ""
            return `<th class="mThSort${activa ? " mThActive" : ""}${num ? " numCol" : ""}" data-cuenta-ahorro-sort="${key}" title="Ordenar por ${label.toLowerCase()}">${label}<span class="mSortArrow">${flecha}</span></th>`
        })
        .join("")
    return `<tr>${celdas}${extra}</tr>`
}

function sortCuentaAhorroRows(rows, valores) {
    const { key, dir } = cuentaAhorroSort[cuentaAhorroTab]
    const valor = valores[key]
    const signo = dir === "asc" ? 1 : -1
    return [...rows].sort((a, b) => {
        const x = valor(a)
        const y = valor(b)
        const cmp = typeof x === "string" ? x.localeCompare(y, "es", { sensitivity: "base" }) : x - y
        // Con valores iguales, el más reciente va primero salga el orden que salga.
        return cmp * signo || parseCuentaAhorroSortKey(b.fecha) - parseCuentaAhorroSortKey(a.fecha)
    })
}

function toggleCuentaAhorroSort(key) {
    const sort = cuentaAhorroSort[cuentaAhorroTab]
    if (sort.key === key) sort.dir = sort.dir === "asc" ? "desc" : "asc"
    else {
        sort.key = key
        sort.dir = key === "fecha" || key === "cantidad" ? "desc" : "asc"
    }
    renderCuentaAhorroTable()
}

function renderCuentaAhorroTable() {
    const head = document.getElementById("cuentaAhorroHead")
    const body = document.getElementById("cuentaAhorroBody")
    const empty = document.getElementById("cuentaAhorroEmpty")
    if (!head || !body || !empty) return

    // Sin filas solo se ve el aviso: ni cabecera ni marco de tabla.
    const syncEmpty = (isEmpty) =>
        empty.closest(".cuentaAhorroTableWrapper")?.classList.toggle("cuentaAhorroVacio", isEmpty)

    if (cuentaAhorroTab === "movimientos") {
        head.innerHTML = buildCuentaAhorroHead(
            [
                { key: "fecha", label: "Fecha" },
                { key: "nombre", label: "Concepto" },
                { key: "tipo", label: "Tipo" },
                { key: "cantidad", label: "Cantidad", num: true }
            ],
            '<th class="rowActionHeader"></th>'
        )

        const rows = sortCuentaAhorroRows(getCuentaAhorroMovimientosDelAnio(), {
            fecha: (m) => parseCuentaAhorroSortKey(m.fecha),
            nombre: (m) => m.nombre || "",
            tipo: (m) => m.kind,
            cantidad: (m) => (m.kind === "retiro" ? -1 : 1) * parseEuroNumber(m.cantidad || "")
        })

        body.innerHTML = rows
            .map((m) => {
                const retiro = m.kind === "retiro"
                const importe = parseEuroNumber(m.cantidad || "")
                return `
                    <tr class="movDetailRow" data-kind="${m.kind}" data-id="${m.id}" data-fecha="${escapeGastosHtml(m.fecha)}" data-cantidad="${escapeGastosHtml(m.cantidad)}" data-nombre="${escapeGastosHtml(m.nombre)}" data-nota="${escapeGastosHtml(m.nota)}">
                        <td>${escapeGastosHtml(m.fecha)}</td>
                        <td title="${escapeGastosHtml(m.nota)}">${escapeGastosHtml(m.nombre)}</td>
                        <td>${retiro ? "Retirada" : "Ingreso"}</td>
                        <td class="numCell ${retiro ? "cuentaAhorroNeg" : "cuentaAhorroPos"}">${formatCuentaAhorroSigned(retiro ? -importe : importe)}</td>
                        <td class="rowActionsCell">
                            <div class="rowMenu">
                                <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                                <div class="rowMenuDropdown">
                                    <button type="button" class="rowMenuItem" data-cuenta-ahorro-edit>Editar</button>
                                    <hr>
                                    <button type="button" class="rowMenuItem rowMenuItemDanger" data-cuenta-ahorro-delete>Eliminar</button>
                                </div>
                            </div>
                        </td>
                    </tr>`
            })
            .join("")

        empty.textContent = `No hay movimientos de la cuenta de ahorro en ${cuentaAhorroYear}.`
        empty.classList.toggle("hidden", rows.length > 0)
        syncEmpty(rows.length === 0)
        return
    }

    head.innerHTML = buildCuentaAhorroHead([
        { key: "fecha", label: "Fecha" },
        { key: "origen", label: "Origen" },
        { key: "cantidad", label: "Cantidad", num: true }
    ])

    const rows = []
    getCuentaAhorroRemuneradasVinculadas().forEach((cuenta) => {
        ;(cuenta.rows || []).forEach((row) => {
            if (splitCuentaAhorroFecha(row.fecha)?.year !== cuentaAhorroYear) return
            rows.push({
                fecha: row.fecha,
                origen: cuenta.nombre || "Cuenta remunerada",
                importe: parseEuroNumber(row.acumulado || "") - parseEuroNumber(row.impuestos || "")
            })
        })
    })
    cuentaAhorroDivEur.forEach(({ row, importe }) => {
        if (splitCuentaAhorroFecha(row.fecha)?.year !== cuentaAhorroYear) return
        rows.push({ fecha: row.fecha, origen: `Dividendo · ${row.instrumento || "—"}`, importe })
    })
    const ordenadas = sortCuentaAhorroRows(rows, {
        fecha: (r) => parseCuentaAhorroSortKey(r.fecha),
        origen: (r) => r.origen,
        cantidad: (r) => r.importe
    })

    body.innerHTML = ordenadas
        .map(
            (r) => `
                <tr class="movDetailRow">
                    <td>${escapeGastosHtml(r.fecha)}</td>
                    <td>${escapeGastosHtml(r.origen)}</td>
                    <td class="numCell cuentaAhorroPos">${formatCuentaAhorroSigned(r.importe)}</td>
                </tr>`
        )
        .join("")

    const cfg = getCuentaAhorroCfg()
    const sinVincular = cfg.remuneradas.length === 0 && !cfg.incluirDividendos
    empty.textContent = sinVincular
        ? "No hay cuentas vinculadas. Elígelas en ··· › Configurar cuenta."
        : `No hay ingresos de cuenta remunerada ni dividendos en ${cuentaAhorroYear}.`
    empty.classList.toggle("hidden", rows.length > 0)
    syncEmpty(rows.length === 0)
}

function renderCuentaAhorroSummary() {
    const set = (id, text) => {
        const node = document.getElementById(id)
        if (node) node.textContent = text
    }
    const show = (id, visible) => document.getElementById(id)?.classList.toggle("hidden", !visible)
    const year = Number(cuentaAhorroYear)
    const cfg = getCuentaAhorroCfg()

    const bancoYear = document.getElementById("cuentaAhorroBancoYear")
    if (bancoYear) bancoYear.textContent = cuentaAhorroYear

    const balance = cuentaAhorroBanco.ingresos - cuentaAhorroBanco.gastos
    set("cuentaAhorroIngresos", formatEuro(cuentaAhorroBanco.ingresos))
    set("cuentaAhorroGastos", formatEuro(cuentaAhorroBanco.gastos))
    set("cuentaAhorroBalance", formatEuro(balance))
    const balanceNode = document.getElementById("cuentaAhorroBalance")
    balanceNode?.classList.toggle("cuentaAhorroPos", balance >= 0)
    balanceNode?.classList.toggle("cuentaAhorroNeg", balance < 0)

    const flows = buildCuentaAhorroFlows()
    const sum = (list) => list.reduce((acc, f) => acc + f.importe, 0)
    const hastaAnio = flows.filter((f) => Number(f.year) <= year)
    const delAnio = flows.filter((f) => Number(f.year) === year)

    const saldo = sum(hastaAnio.filter((f) => f.type === "aporte"))
    const anadido = sum(delAnio.filter((f) => f.type === "aporte" && f.importe > 0))
    const retirado = -sum(delAnio.filter((f) => f.type === "aporte" && f.importe < 0))
    const remunerada = sum(delAnio.filter((f) => f.type === "remunerada"))
    const dividendos = sum(delAnio.filter((f) => f.type === "dividendo"))
    const rendimientos = sum(hastaAnio.filter((f) => f.type !== "aporte"))
    // La cifra principal es todo lo que hay: aportaciones netas más lo que han
    // rendido las cuentas vinculadas.
    const total = saldo + rendimientos

    set("cuentaAhorroTitulo", getCuentaAhorroLabel(cuentaAhorroCuenta))
    set("cuentaAhorroSaldo", formatEuro(total))
    set("cuentaAhorroAnadidoLabel", `Añadido en ${cuentaAhorroYear}`)
    set("cuentaAhorroAnadido", formatCuentaAhorroSigned(anadido))
    set("cuentaAhorroRetirado", formatEuro(-retirado))
    show("cuentaAhorroRetiradoRow", retirado > 0)
    set("cuentaAhorroRemunerada", formatCuentaAhorroSigned(remunerada))
    set("cuentaAhorroDividendos", formatCuentaAhorroSigned(dividendos))
    show("cuentaAhorroDividendosRow", cfg.incluirDividendos)

    renderCuentaAhorroObjetivo(cfg, total, flows, year)
    renderCuentaAhorroChart(flows, year)
}

// Barra de progreso hacia el objetivo y una estimación de cuándo se alcanza.
function renderCuentaAhorroObjetivo(cfg, total, flows, year) {
    const box = document.getElementById("cuentaAhorroObjetivo")
    if (!box) return

    const objetivo = parseEuroNumber(cfg.objetivo)
    box.hidden = !(objetivo > 0)
    if (!(objetivo > 0)) return

    const pct = Math.max(0, Math.min(100, (total / objetivo) * 100))
    document.getElementById("cuentaAhorroObjetivoTexto").textContent = `Objetivo: ${formatEuro(objetivo)}`
    document.getElementById("cuentaAhorroObjetivoPct").textContent = `${Math.floor((total / objetivo) * 100)}%`
    const barra = document.getElementById("cuentaAhorroBarra")
    barra.style.width = `${pct}%`
    barra.classList.toggle("cuentaAhorroBarraCompleta", total >= objetivo)

    const nota = document.getElementById("cuentaAhorroObjetivoNota")
    if (total >= objetivo) {
        nota.textContent = "Objetivo alcanzado."
        return
    }

    const falta = objetivo - total
    // La estimación mira hacia delante desde hoy: en otro año no tiene sentido.
    if (year !== new Date().getFullYear()) {
        nota.textContent = `Faltan ${formatEuro(falta)}.`
        return
    }

    const now = new Date()
    const mesesAtras = (f) => (now.getFullYear() - Number(f.year)) * 12 + (now.getMonth() - f.month)
    const reciente = flows.filter(
        (f) => f.type === "aporte" && mesesAtras(f) >= 0 && mesesAtras(f) < CUENTA_AHORRO_MESES_RITMO
    )
    const ritmo = reciente.reduce((acc, f) => acc + f.importe, 0) / CUENTA_AHORRO_MESES_RITMO

    if (!(ritmo > 0)) {
        nota.textContent = `Faltan ${formatEuro(falta)}. Sin aportaciones recientes para estimar cuándo.`
        return
    }

    const meses = Math.ceil(falta / ritmo)
    const fecha = new Date(now.getFullYear(), now.getMonth() + meses, 1).toLocaleDateString(
        window._numLocale || "es-ES",
        { month: "long", year: "numeric" }
    )
    nota.textContent =
        `Faltan ${formatEuro(falta)}. Al ritmo de ${formatEuro(ritmo)} al mes ` +
        `(media de los últimos ${CUENTA_AHORRO_MESES_RITMO} meses) llegarás en ${meses} ${meses === 1 ? "mes" : "meses"} (${fecha}).`
}

// Saldo con rendimientos y lo aportado al cierre de cada mes del año seleccionado.
function renderCuentaAhorroChart(flows, year) {
    const svg = document.getElementById("cuentaAhorroChart")
    if (!svg) return

    const now = new Date()
    const lastMonth = year < now.getFullYear() ? 11 : year === now.getFullYear() ? now.getMonth() : -1
    const upTo = (i, filter) =>
        flows
            .filter((f) => filter(f) && (Number(f.year) < year || (Number(f.year) === year && f.month <= i)))
            .reduce((acc, f) => acc + f.importe, 0)

    const added = CUENTA_AHORRO_MONTH_KEYS.map((_, i) =>
        flows.filter((f) => Number(f.year) === year && f.month === i).reduce((acc, f) => acc + f.importe, 0)
    )
    const values = CUENTA_AHORRO_MONTH_KEYS.map((_, i) => (i > lastMonth ? null : upTo(i, () => true)))
    const aportado = CUENTA_AHORRO_MONTH_KEYS.map((_, i) =>
        i > lastMonth ? null : upTo(i, (f) => f.type === "aporte")
    )

    const W = 300
    const H = 110
    const padX = 8
    const top = 8
    const bottom = 20
    const known = [...values, ...aportado].filter((v) => v !== null)
    const min = Math.min(...known, 0)
    const max = Math.max(...known, 0)
    const span = max - min || 1
    const x = (i) => padX + (i * (W - padX * 2)) / 11
    const y = (v) => top + (1 - (v - min) / span) * (H - top - bottom)

    cuentaAhorroChartData = { values, aportado, added, W, padX, x }

    const labels = CUENTA_AHORRO_MONTH_LABELS.map(
        (l, i) =>
            `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="cuentaAhorroChartLabel">${l}</text>`
    ).join("")

    if (!known.length || known.every((v) => v === 0)) {
        svg.innerHTML = `${labels}<text x="${W / 2}" y="${(H - bottom) / 2 + 4}" text-anchor="middle" class="cuentaAhorroChartLabel">Sin datos</text>`
        return
    }

    const toPoints = (serie) =>
        serie
            .map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
            .filter(Boolean)
            .join(" ")

    const points = values.map((v, i) => (v === null ? null : [x(i), y(v)])).filter(Boolean)
    const base = (H - bottom).toFixed(1)
    const area = `${points[0][0].toFixed(1)},${base} ${toPoints(values)} ${points[points.length - 1][0].toFixed(1)},${base}`
    const dots = values
        .map((v, i) =>
            v === null
                ? ""
                : `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" class="cuentaAhorroChartDot" data-i="${i}"></circle>`
        )
        .join("")

    svg.innerHTML = `
        <line class="cuentaAhorroChartGuide" id="cuentaAhorroGuide" x1="0" x2="0" y1="${top}" y2="${H - bottom}" visibility="hidden"></line>
        <polygon points="${area}" class="cuentaAhorroChartArea"></polygon>
        <polyline points="${toPoints(aportado)}" class="cuentaAhorroChartLineAportado" fill="none"></polyline>
        <polyline points="${toPoints(values)}" class="cuentaAhorroChartLine" fill="none"></polyline>
        ${dots}${labels}`
}

// ── Acciones ─────────────────────────────────────────────────────────────

async function reloadCuentaAhorroMovs() {
    applyCuentaAhorroData(await Api.get("/api/cuenta-ahorro"))
}

// Con `edit` (los datos de la fila) el modal edita ese movimiento en vez de crear uno.
function openCuentaAhorroMovimientoModal(edit = null) {
    const retiro = edit?.kind === "retiro"
    openGastosCreateModal({
        title: edit ? "Editar movimiento" : `Añadir movimiento · ${getCuentaAhorroLabel(cuentaAhorroCuenta)}`,
        bodyHtml: `
            <label class="assetModalLabel" for="cuentaAhorroMovKind">Operación</label>
            <select id="cuentaAhorroMovKind" class="assetModalSelect">
                <option value="ingreso"${retiro ? "" : " selected"}>Ingresar en la cuenta de ahorro (sale de la cuenta bancaria)</option>
                <option value="retiro"${retiro ? " selected" : ""}>Retirar de la cuenta de ahorro (entra en la cuenta bancaria)</option>
            </select>

            <label class="assetModalLabel" for="cuentaAhorroMovFecha">Fecha</label>
            <input id="cuentaAhorroMovFecha" class="assetModalInput" type="text" value="${escapeGastosHtml(edit?.fecha || todayDateString())}" placeholder="dd-mm-aaaa">

            <label class="assetModalLabel" for="cuentaAhorroMovNombre">Concepto <span class="assetModalLabelHint">opcional</span></label>
            <input id="cuentaAhorroMovNombre" class="assetModalInput" type="text" maxlength="120" value="${escapeGastosHtml(edit?.nombre || "")}" placeholder="Ej: Ahorro de octubre">

            <label class="assetModalLabel" for="cuentaAhorroMovCantidad">Cantidad</label>
            <input id="cuentaAhorroMovCantidad" class="assetModalInput" type="text" inputmode="decimal" value="${escapeGastosHtml(edit?.cantidad || "")}" placeholder="0,00">

            <label class="assetModalLabel" for="cuentaAhorroMovNota">Nota <span class="assetModalLabelHint">opcional</span></label>
            <textarea id="cuentaAhorroMovNota" class="assetModalInput movNotaInput" rows="2" maxlength="300">${escapeGastosHtml(edit?.nota || "")}</textarea>
        `,
        submitLabel: "Guardar",
        onSubmit: async ({ getValue, setFeedback }) => {
            const campos = {
                fecha: getValue("cuentaAhorroMovFecha").trim(),
                nombre: getValue("cuentaAhorroMovNombre").trim(),
                cantidad: getValue("cuentaAhorroMovCantidad").trim(),
                nota: getValue("cuentaAhorroMovNota").trim()
            }
            const kind = getValue("cuentaAhorroMovKind")

            try {
                const res = edit
                    ? await Api.post("/api/cuenta-ahorro/movimientos/editar", {
                          ...campos,
                          kind: edit.kind,
                          id: Number(edit.id),
                          fechaOriginal: edit.fecha,
                          cantidadOriginal: edit.cantidad,
                          kindNuevo: kind
                      })
                    : await Api.post("/api/cuenta-ahorro/movimientos", {
                          ...campos,
                          kind,
                          cuenta: cuentaAhorroCuenta
                      })

                await reloadCuentaAhorroMovs()
                const year = res?.movimiento?.year
                if (year && !cuentaAhorroYears.includes(year)) {
                    cuentaAhorroYears = [...cuentaAhorroYears, year].sort()
                }
                if (year) cuentaAhorroYear = year
                cuentaAhorroTab = "movimientos"
                await refreshCuentaAhorro()
                return true
            } catch (error) {
                setFeedback(error?.message || "No se pudo guardar el movimiento.", true)
                return false
            }
        }
    })
}

function deleteCuentaAhorroMovimiento(row) {
    openConfirmModal({
        title: "Eliminar movimiento",
        message: "Se borrará también de Gastos o de Ingresos, donde está registrado. No se puede deshacer.",
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            try {
                await Api.post("/api/cuenta-ahorro/movimientos/eliminar", {
                    kind: row.dataset.kind,
                    id: Number(row.dataset.id),
                    fecha: row.dataset.fecha,
                    cantidad: row.dataset.cantidad
                })
            } catch (error) {
                showError("No se pudo eliminar el movimiento", error)
            }
            await reloadCuentaAhorroMovs()
            await refreshCuentaAhorro()
        }
    })
}

function downloadCuentaAhorroCsv() {
    const rows = getCuentaAhorroMovimientosDelAnio().map((m) => {
        const importe = parseEuroNumber(m.cantidad || "")
        return {
            Fecha: m.fecha,
            Concepto: m.nombre,
            Tipo: m.kind === "retiro" ? "Retirada" : "Ingreso",
            Cantidad: m.kind === "retiro" ? -importe : importe,
            Nota: m.nota || ""
        }
    })
    const cuenta = (cuentaAhorroCuenta || "principal").toLowerCase().replace(/[^a-z0-9áéíóúñü]+/gi, "-")
    downloadCsvFile(`cuenta-ahorro-${cuenta}-${cuentaAhorroYear}.csv`, rows)
}

// Casilla con aspecto de tarjeta. `bloqueadaPor` explica por qué no se puede marcar.
function buildCuentaAhorroCheck({ attrs, checked, label, bloqueadaPor = "" }) {
    return `
        <label class="cuentaAhorroCheck${bloqueadaPor ? " cuentaAhorroCheckBloqueada" : ""}">
            <input type="checkbox" ${attrs} ${checked ? "checked" : ""} ${bloqueadaPor ? "disabled" : ""}>
            <span>${escapeGastosHtml(label)}</span>
            ${bloqueadaPor ? `<small>Ya cuenta en «${escapeGastosHtml(bloqueadaPor)}»</small>` : ""}
        </label>`
}

// Una cuenta remunerada o los dividendos solo pueden contar en una cuenta de
// ahorro: en dos se sumarían dos veces.
function findCuentaAhorroOtraCon(predicado) {
    const otra = cuentaAhorroConfig.cuentas.find((c) => !sameCuentaAhorro(c.nombre, cuentaAhorroCuenta) && predicado(c))
    return otra ? getCuentaAhorroLabel(otra.nombre) : ""
}

// El servidor guarda los importes con punto ("12000.00"); en pantalla, como se escriben.
function toCuentaAhorroInput(valor) {
    return String(valor || "")
        .replace(".", ",")
        .replace(/,00$/, "")
}

function openCuentaAhorroConfigModal() {
    const cfg = getCuentaAhorroCfg()
    const lista = cuentaAhorroRemuneradas.length
        ? cuentaAhorroRemuneradas
              .map((c) =>
                  buildCuentaAhorroCheck({
                      attrs: `data-cuenta-id="${escapeGastosHtml(c.id)}"`,
                      checked: cfg.remuneradas.includes(c.id),
                      label: c.nombre || "Cuenta remunerada",
                      bloqueadaPor: findCuentaAhorroOtraCon((o) => o.remuneradas.includes(c.id))
                  })
              )
              .join("")
        : `<p class="cuentaAhorroHint">Todavía no hay cuentas remuneradas. Créalas en Finanzas › Cuenta Remunerada.</p>`

    const rec = cfg.recurrente

    openGastosCreateModal({
        title: `Configurar · ${getCuentaAhorroLabel(cuentaAhorroCuenta)}`,
        modalClass: "cuentaAhorroConfigModal",
        bodyHtml: `
            <p class="assetModalLabel">Objetivo de ahorro</p>
            <input id="cuentaAhorroCfgObjetivo" class="assetModalInput" type="text" inputmode="decimal" value="${escapeGastosHtml(toCuentaAhorroInput(cfg.objetivo))}" placeholder="Sin objetivo (€)">

            <p class="assetModalLabel">Aportación mensual automática</p>
            ${buildCuentaAhorroCheck({ attrs: 'id="cuentaAhorroCfgRecActiva"', checked: rec.activa, label: "Ingresar una cantidad fija cada mes" })}
            <div class="cuentaAhorroRecCampos">
                <label class="assetModalLabel" for="cuentaAhorroCfgRecImporte">Cantidad</label>
                <input id="cuentaAhorroCfgRecImporte" class="assetModalInput" type="text" inputmode="decimal" value="${escapeGastosHtml(toCuentaAhorroInput(rec.importe))}" placeholder="0,00">
                <label class="assetModalLabel" for="cuentaAhorroCfgRecDia">Día del mes</label>
                <input id="cuentaAhorroCfgRecDia" class="assetModalInput" type="number" min="1" max="31" value="${Number(rec.dia) || 1}">
            </div>
            <p class="cuentaAhorroHint">Se registra sola en Gastos al abrir esta ventana, desde el mes en que la activas. Si borras una, no vuelve a crearse.</p>

            <p class="assetModalLabel">Cuentas remuneradas</p>
            ${lista}
            <p class="assetModalLabel">Dividendos</p>
            ${buildCuentaAhorroCheck({
                attrs: 'id="cuentaAhorroCfgDividendos"',
                checked: cfg.incluirDividendos,
                label: "Incluir los dividendos de mis activos",
                bloqueadaPor: findCuentaAhorroOtraCon((o) => o.incluirDividendos)
            })}
        `,
        submitLabel: "Guardar",
        onSubmit: async ({ modal, setFeedback }) => {
            const activa = Boolean(modal.querySelector("#cuentaAhorroCfgRecActiva")?.checked)
            const importe = modal.querySelector("#cuentaAhorroCfgRecImporte")?.value.trim() || ""
            if (activa && !(parseEuroNumber(importe) > 0)) {
                setFeedback("Indica la cantidad de la aportación mensual.", true)
                return false
            }

            const now = new Date()
            const mesActual = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
            const dia = Math.max(1, Math.min(31, Number(modal.querySelector("#cuentaAhorroCfgRecDia")?.value) || 1))

            const next = {
                nombre: cuentaAhorroCuenta,
                objetivo: modal.querySelector("#cuentaAhorroCfgObjetivo")?.value.trim() || "",
                remuneradas: [...modal.querySelectorAll("[data-cuenta-id]:checked")].map((i) => i.dataset.cuentaId),
                incluirDividendos: Boolean(modal.querySelector("#cuentaAhorroCfgDividendos")?.checked),
                recurrente: {
                    activa,
                    importe,
                    dia,
                    // Al activarla (o reactivarla) empieza este mes: no rellena el pasado.
                    desde: activa && (!rec.activa || !rec.desde) ? mesActual : rec.desde
                }
            }

            try {
                setCuentaAhorroCfg(next)
                await saveCuentaAhorroConfig()
                // Abrir la lista es lo que crea las aportaciones automáticas.
                await reloadCuentaAhorroMovs()
            } catch (error) {
                setCuentaAhorroCfg(cfg)
                setFeedback(error?.message || "No se pudo guardar la configuración.", true)
                return false
            }

            await refreshCuentaAhorro()
            return true
        }
    })
}

function openCuentaAhorroNombreModal({ title, valor = "", onSubmit }) {
    openGastosCreateModal({
        title,
        bodyHtml: `
            <label class="assetModalLabel" for="cuentaAhorroNombreInput">Nombre de la cuenta</label>
            <input id="cuentaAhorroNombreInput" class="assetModalInput" type="text" maxlength="60" value="${escapeGastosHtml(valor)}" placeholder="Ej: Viaje, Coche, Emergencias">
        `,
        submitLabel: "Guardar",
        onSubmit: async ({ getValue, setFeedback }) => {
            const nombre = getValue("cuentaAhorroNombreInput").trim()
            if (!nombre) {
                setFeedback("Escribe un nombre para la cuenta.", true)
                return false
            }
            try {
                await onSubmit(nombre)
                return true
            } catch (error) {
                setFeedback(error?.message || "No se pudo guardar la cuenta.", true)
                return false
            }
        }
    })
}

function addCuentaAhorro() {
    openCuentaAhorroNombreModal({
        title: "Nueva cuenta de ahorro",
        onSubmit: async (nombre) => {
            const res = await Api.post("/api/cuenta-ahorro/cuentas", { nombre })
            await reloadCuentaAhorroMovs()
            cuentaAhorroCuenta = res?.nombre || nombre
            await refreshCuentaAhorro()
        }
    })
}

function renameCuentaAhorro() {
    if (!cuentaAhorroCuenta) return
    const actual = cuentaAhorroCuenta
    openCuentaAhorroNombreModal({
        title: "Renombrar cuenta",
        valor: actual,
        onSubmit: async (nombre) => {
            const res = await Api.post("/api/cuenta-ahorro/cuentas/renombrar", { de: actual, a: nombre })
            const nuevo = res?.nombre || nombre

            const cfg = getCuentaAhorroCfg(actual)
            cuentaAhorroConfig.cuentas = cuentaAhorroConfig.cuentas.filter((c) => !sameCuentaAhorro(c.nombre, actual))
            setCuentaAhorroCfg({ ...cfg, nombre: nuevo })
            await saveCuentaAhorroConfig()

            cuentaAhorroCuenta = nuevo
            await reloadCuentaAhorroMovs()
            await refreshCuentaAhorro()
        }
    })
}

function deleteCuentaAhorro() {
    if (!cuentaAhorroCuenta) return
    const nombre = cuentaAhorroCuenta
    openConfirmModal({
        title: "Eliminar cuenta",
        message: `Vas a eliminar la cuenta «${nombre}». Solo se puede si no tiene movimientos.`,
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            try {
                await Api.post("/api/cuenta-ahorro/cuentas/eliminar", { nombre })
            } catch (error) {
                showError("No se pudo eliminar la cuenta", error)
                return
            }

            cuentaAhorroConfig.cuentas = cuentaAhorroConfig.cuentas.filter((c) => !sameCuentaAhorro(c.nombre, nombre))
            try {
                await saveCuentaAhorroConfig()
            } catch (error) {
                showError("La cuenta se eliminó, pero no se pudo limpiar su configuración", error)
            }

            cuentaAhorroCuenta = ""
            await reloadCuentaAhorroMovs()
            await refreshCuentaAhorro()
        }
    })
}

function bindCuentaAhorroEvents() {
    const menuTrigger = document.querySelector("#cuentaAhorroActionsMenu .pageActionsMenuTrigger")
    const menuDropdown = document.getElementById("cuentaAhorroActionsDropdown")
    if (menuTrigger && menuDropdown) {
        menuTrigger.addEventListener("click", (e) => {
            e.stopPropagation()
            menuDropdown.classList.toggle("open")
        })
        menuDropdown.addEventListener("click", () => menuDropdown.classList.remove("open"))
        // El listener es del documento, que sobrevive a la página: se retira solo
        // en cuanto el menú ya no está en pantalla.
        const closeOnOutsideClick = () => {
            if (!menuDropdown.isConnected) {
                document.removeEventListener("click", closeOnOutsideClick)
                return
            }
            menuDropdown.classList.remove("open")
        }
        document.addEventListener("click", closeOnOutsideClick)
    }

    const on = (id, handler) => document.getElementById(id)?.addEventListener("click", handler)
    on("cuentaAhorroAddBtn", () => openCuentaAhorroMovimientoModal())
    on("cuentaAhorroAddRowBtn", () => openCuentaAhorroMovimientoModal())
    on("cuentaAhorroConfigBtn", openCuentaAhorroConfigModal)
    on("cuentaAhorroCsvBtn", downloadCuentaAhorroCsv)
    on("cuentaAhorroNewAccountBtn", addCuentaAhorro)
    on("cuentaAhorroRenameBtn", renameCuentaAhorro)
    on("cuentaAhorroDeleteBtn", deleteCuentaAhorro)

    document.querySelectorAll("[data-cuenta-ahorro-tab]").forEach((btn) => {
        btn.addEventListener("click", () => {
            cuentaAhorroTab = btn.dataset.cuentaAhorroTab
            renderCuentaAhorroTabs()
            renderCuentaAhorroTable()
        })
    })

    bindCuentaAhorroChartHover()

    // La cabecera se vuelve a pintar al cambiar de pestaña: el evento va en el <thead>.
    document.getElementById("cuentaAhorroHead")?.addEventListener("click", (event) => {
        const th = event.target.closest("[data-cuenta-ahorro-sort]")
        if (th) toggleCuentaAhorroSort(th.dataset.cuentaAhorroSort)
    })

    document.getElementById("cuentaAhorroBody")?.addEventListener("click", (event) => {
        const row = event.target.closest("tr")
        if (!row) return
        if (event.target.closest("[data-cuenta-ahorro-edit]")) openCuentaAhorroMovimientoModal({ ...row.dataset })
        else if (event.target.closest("[data-cuenta-ahorro-delete]")) deleteCuentaAhorroMovimiento(row)
    })
}

// Al pasar el ratón por la gráfica: el mes más cercano, el saldo a final de ese
// mes, lo aportado, lo que han rendido y lo que se añadió (o retiró) durante él.
function bindCuentaAhorroChartHover() {
    const svg = document.getElementById("cuentaAhorroChart")
    const tip = document.getElementById("cuentaAhorroTooltip")
    if (!svg || !tip) return

    const hide = () => {
        tip.classList.add("hidden")
        document.getElementById("cuentaAhorroGuide")?.setAttribute("visibility", "hidden")
        svg.querySelectorAll(".cuentaAhorroChartDot.active").forEach((d) => d.classList.remove("active"))
    }

    svg.addEventListener("mouseleave", hide)
    svg.addEventListener("mousemove", (event) => {
        const data = cuentaAhorroChartData
        if (!data) return

        const rect = svg.getBoundingClientRect()
        const vx = ((event.clientX - rect.left) / rect.width) * data.W
        const step = (data.W - data.padX * 2) / 11
        const i = Math.max(0, Math.min(11, Math.round((vx - data.padX) / step)))
        if (data.values[i] === null) return hide()

        const guide = document.getElementById("cuentaAhorroGuide")
        guide?.setAttribute("x1", data.x(i))
        guide?.setAttribute("x2", data.x(i))
        guide?.setAttribute("visibility", "visible")
        svg.querySelectorAll(".cuentaAhorroChartDot").forEach((d) =>
            d.classList.toggle("active", Number(d.dataset.i) === i)
        )

        const delta = data.added[i]
        const rendimiento = data.values[i] - data.aportado[i]
        const mes = CUENTA_AHORRO_MONTH_KEYS[i]
        const cls = delta < 0 ? "cuentaAhorroNeg" : delta > 0 ? "cuentaAhorroPos" : ""
        tip.innerHTML = `
            <strong>${mes.charAt(0).toUpperCase() + mes.slice(1)} ${cuentaAhorroYear}</strong>
            <span>Saldo: ${formatEuro(data.values[i])}</span>
            <span>Aportado: ${formatEuro(data.aportado[i])}</span>
            <span>Rendimientos: ${formatCuentaAhorroSigned(rendimiento)}</span>
            <span class="${cls}">Añadido este mes: ${formatCuentaAhorroSigned(delta)}</span>`
        tip.classList.remove("hidden")

        const wrap = svg.parentElement.getBoundingClientRect()
        const px = rect.left - wrap.left + (data.x(i) / data.W) * rect.width
        tip.style.left = `${Math.max(0, Math.min(wrap.width - tip.offsetWidth, px - tip.offsetWidth / 2))}px`
    })
}
