// escapeHtml y el resto de utilidades de DOM viven ahora en js/dom.js, que se
// carga antes que este fichero.

const exchangeRateCache = new Map()
let externalVentasRowsCache = []
let externalTransaccionesRowsCache = []
let externalOperacionesRowsCache = []
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let currentAssetPersistedOperationRows = []
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let currentAssetPersistedConversionRows = []
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _assetDisplayRows = []
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _assetSortKey = null
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _assetSortDir = "asc"
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _sidebarFilter = "portfolio"
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _editingAsset = null
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let assetAutosaveTimeout = null

const ASSET_COLOR_PALETTE = [
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
    "#26c6da",
    "#66bb6a",
    "#ef5350",
    "#ab47bc",
    "#ffa726"
]

function _cpHsvToRgb(h, s, v) {
    const i = Math.floor(h / 60) % 6
    const f = h / 60 - Math.floor(h / 60)
    const p = v * (1 - s),
        q = v * (1 - f * s),
        t = v * (1 - (1 - f) * s)
    const [r, g, b] = [
        [v, t, p],
        [q, v, p],
        [p, v, t],
        [p, q, v],
        [t, p, v],
        [v, p, q]
    ][i]
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
}

function _cpRgbToHex(r, g, b) {
    return "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")
}

function _cpHexToHsv(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex)
    if (!m) return null
    const n = parseInt(m[1], 16)
    const r = (n >> 16) / 255,
        g = ((n >> 8) & 0xff) / 255,
        b = (n & 0xff) / 255
    const max = Math.max(r, g, b),
        min = Math.min(r, g, b),
        d = max - min
    let h = 0
    if (d) {
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60
        else if (max === g) h = ((b - r) / d + 2) * 60
        else h = ((r - g) / d + 4) * 60
    }
    return [h, max ? d / max : 0, max]
}

function setupColorPickerToggle(toggleId, pickerId) {
    const toggle = document.getElementById(toggleId)
    const picker = document.getElementById(pickerId)
    if (!toggle || !picker) return
    toggle.addEventListener("click", () => {
        const collapsed = picker.classList.contains("cpCollapsed")
        picker.classList.toggle("cpCollapsed", !collapsed)
        toggle.classList.toggle("open", collapsed)
    })
}

function initColorPicker(pickerId, inputId, selectedColor, badgeId = null) {
    const container = document.getElementById(pickerId)
    const input = document.getElementById(inputId)
    if (!container || !input) return

    const CW = 280,
        CH = 175

    container.innerHTML = `
        <canvas class="cpCanvas" width="${CW}" height="${CH}"></canvas>
        <div class="cpHuebar"><input type="range" class="cpHueSlider" min="0" max="359" step="1" value="0"></div>
        <div class="cpHexRow">
            <span class="cpPreview"></span>
            <span class="cpHash">#</span>
            <input class="cpHexInput" type="text" maxlength="6" autocomplete="off" spellcheck="false">
            <button type="button" class="cpRandomBtn" title="Color aleatorio">&#9684;</button>
        </div>
    `

    const canvas = container.querySelector(".cpCanvas")
    const ctx = canvas.getContext("2d")
    const hueSlider = container.querySelector(".cpHueSlider")
    const preview = container.querySelector(".cpPreview")
    const hexInput = container.querySelector(".cpHexInput")

    const parsed = _cpHexToHsv(selectedColor || "")
    let h = parsed ? parsed[0] : 210
    let s = parsed ? parsed[1] : 0.68
    let v = parsed ? parsed[2] : 0.83

    function draw() {
        const gH = ctx.createLinearGradient(0, 0, CW, 0)
        gH.addColorStop(0, "#fff")
        gH.addColorStop(1, `hsl(${h},100%,50%)`)
        ctx.fillStyle = gH
        ctx.fillRect(0, 0, CW, CH)

        const gV = ctx.createLinearGradient(0, 0, 0, CH)
        gV.addColorStop(0, "rgba(0,0,0,0)")
        gV.addColorStop(1, "rgba(0,0,0,1)")
        ctx.fillStyle = gV
        ctx.fillRect(0, 0, CW, CH)

        const cx = s * CW,
            cy = (1 - v) * CH
        ctx.beginPath()
        ctx.arc(cx, cy, 7, 0, Math.PI * 2)
        ctx.strokeStyle = "rgba(0,0,0,0.5)"
        ctx.lineWidth = 2.5
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(cx, cy, 6, 0, Math.PI * 2)
        ctx.strokeStyle = "#fff"
        ctx.lineWidth = 2
        ctx.stroke()
    }

    function sync() {
        const [r, g, b] = _cpHsvToRgb(h, s, v)
        const hex = _cpRgbToHex(r, g, b)
        input.value = hex
        preview.style.backgroundColor = hex
        hexInput.value = hex.slice(1).toUpperCase()
        if (badgeId) {
            const badge = document.getElementById(badgeId)
            if (badge) badge.style.backgroundColor = hex
        }
    }

    function pickXY(clientX, clientY) {
        const rect = canvas.getBoundingClientRect()
        s = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
        v = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height))
        draw()
        sync()
    }

    canvas.addEventListener("pointerdown", (e) => {
        canvas.setPointerCapture(e.pointerId)
        pickXY(e.clientX, e.clientY)
    })
    canvas.addEventListener("pointermove", (e) => {
        if (e.buttons === 1) pickXY(e.clientX, e.clientY)
    })

    hueSlider.value = Math.round(h)
    hueSlider.addEventListener("input", () => {
        h = Number(hueSlider.value)
        draw()
        sync()
    })

    hexInput.addEventListener("input", () => {
        const val = hexInput.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 6)
        if (hexInput.value !== val) hexInput.value = val
        if (val.length === 6) {
            const p = _cpHexToHsv("#" + val)
            if (p) {
                ;[h, s, v] = p
                hueSlider.value = Math.round(h)
                draw()
            }
            input.value = "#" + val
            preview.style.backgroundColor = "#" + val
        }
    })

    const randomBtn = container.querySelector(".cpRandomBtn")
    if (randomBtn) {
        randomBtn.addEventListener("click", () => {
            h = Math.random() * 360
            s = 0.55 + Math.random() * 0.4
            v = 0.65 + Math.random() * 0.3
            hueSlider.value = Math.round(h)
            draw()
            sync()
        })
    }

    draw()
    sync()
}

async function fetchExchangeRateOnServer(sourceCurrency, targetCurrency) {
    const source = normalizeCurrencyCode(sourceCurrency)
    const target = normalizeCurrencyCode(targetCurrency)

    if (source === target) {
        return 1
    }

    const cacheKey = `${source}->${target}`

    if (!exchangeRateCache.has(cacheKey)) {
        const requestPromise = (async () => {
            const response = await fetch(
                `/api/exchange-rate?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`
            )

            if (!response.ok) {
                const errorText = await response.text()
                throw new Error(`HTTP ${response.status}: ${errorText}`)
            }

            const data = await response.json()
            const rate = Number(data.rate)

            if (!Number.isFinite(rate) || rate <= 0) {
                throw new Error("Tipo de cambio inválido")
            }

            return rate
        })()

        exchangeRateCache.set(cacheKey, requestPromise)
    }

    try {
        return await exchangeRateCache.get(cacheKey)
    } catch (error) {
        exchangeRateCache.delete(cacheKey)
        throw error
    }
}

async function convertAmountForDisplay(amount, sourceCurrency, targetCurrency) {
    const numericAmount = Number(amount) || 0
    const source = normalizeCurrencyCode(sourceCurrency)
    const target = normalizeCurrencyCode(targetCurrency)

    if (source === target) {
        return numericAmount
    }

    const rate = await fetchExchangeRateOnServer(source, target)
    return numericAmount * rate
}

async function getAssetDisplayPriceValue(asset) {
    const rawPrice = parseLooseNumber(asset?.price || "0") || 0
    return rawPrice
}

async function buildOverviewDisplayRow(asset) {
    const row = await buildOverviewRow(asset)
    const netoActualDisplay = row.netoActual
    const currentPriceDisplay = row.valorActual
    const rendimientoDisplay = netoActualDisplay - row.invertidoBruto
    const yieldPctVal = row.invertidoBruto > 0 ? (rendimientoDisplay / row.invertidoBruto) * 100 : 0

    return {
        ...row,
        id: asset.id,
        sidebarOrder: asset.order ?? 0,
        hidden: asset.hidden ?? false,
        overviewCurrentPrice: currentPriceDisplay,
        overviewCurrentValue: netoActualDisplay,
        overviewYieldValue: rendimientoDisplay,
        yieldPctVal
    }
}

async function buildSummaryMetricsInEuros(summary) {
    const baseCurrency = summary.currency
    const invertidoBrutoEur = await convertAmountForDisplay(summary.invertidoBruto, baseCurrency, "EUR")
    const netoActualEur = await convertAmountForDisplay(summary.netoActual, baseCurrency, "EUR")
    const rendimientoEur = netoActualEur - invertidoBrutoEur

    return {
        netoActualEur,
        invertidoBrutoEur,
        rendimientoEur
    }
}

async function loadAssetsList() {
    if (window._viewAllPortfolios) {
        const response = await fetch("/api/portfolios/all-assets")
        if (!response.ok) throw new Error("No se pudo cargar activos de todos los portfolios")
        const data = await response.json()
        return Array.isArray(data.assets) ? data.assets : []
    }
    const response = await fetch("/api/activos")

    if (!response.ok) {
        throw new Error("No se pudo cargar la lista de activos")
    }

    const data = await response.json()
    return Array.isArray(data.assets) ? data.assets : []
}

async function loadAssetData(assetId) {
    if (window._viewAllPortfolios && String(assetId).includes("__")) {
        const sep = assetId.indexOf("__")
        const pid = assetId.slice(0, sep)
        const origId = assetId.slice(sep + 2)
        const response = await fetch(`/api/portfolios/${encodeURIComponent(pid)}/activo/${encodeURIComponent(origId)}`)
        if (!response.ok) throw new Error("No se pudo cargar el activo")
        return await response.json()
    }
    const response = await fetch(`/api/activos/${assetId}`)

    if (!response.ok) {
        throw new Error("No se pudo cargar el activo")
    }

    return await response.json()
}

async function saveAssetDataToServer(assetData) {
    const response = await fetch(`/api/activos/${assetData.id}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(assetData)
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
}

async function deleteAssetOnServer(assetId) {
    const response = await fetch(`/api/activos/${assetId}`, {
        method: "DELETE"
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
}

async function createAssetOnServer(
    name,
    type,
    marketSymbol = "",
    marketProvider = "finnhub",
    color = "",
    tvSymbol = "",
    costeAnual = ""
) {
    const response = await fetch("/api/activos", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            name,
            type,
            marketSymbol,
            marketProvider,
            finnhubSymbol: marketSymbol,
            color,
            tvSymbol,
            costeAnual
        })
    })

    if (!response.ok) {
        const errorText = await response.text()
        let serverMessage = ""

        try {
            serverMessage = JSON.parse(errorText)?.error || ""
        } catch {
            serverMessage = ""
        }

        const error = new Error(serverMessage || `HTTP ${response.status}: ${errorText}`)
        error.serverMessage = serverMessage
        throw error
    }

    return await response.json()
}

async function loadVentasRowsForAssets() {
    const response = await fetch("/api/ventas")

    if (!response.ok) {
        throw new Error("No se pudo cargar la lista de ventas")
    }

    const data = await response.json()
    externalVentasRowsCache = Array.isArray(data?.rows) ? data.rows : []
    return externalVentasRowsCache
}

async function loadTransaccionesRowsForAssets() {
    const response = await fetch("/api/transacciones")

    if (!response.ok) {
        throw new Error("No se pudo cargar la lista de transacciones")
    }

    const data = await response.json()
    externalTransaccionesRowsCache = Array.isArray(data?.rows) ? data.rows : []
    return externalTransaccionesRowsCache
}

async function loadOperacionesRowsForAssets() {
    const response = await fetch("/api/operaciones")

    if (!response.ok) {
        throw new Error("No se pudieron cargar las operaciones para activos")
    }

    const data = await response.json()
    externalOperacionesRowsCache = Array.isArray(data?.rows) ? data.rows : []
    return externalOperacionesRowsCache
}

function setExternalOperacionesRowsForAssets(rows) {
    externalOperacionesRowsCache = Array.isArray(rows) ? rows : []
}

async function refreshSelectedAssetFromExternalData() {
    const assets = await loadAssetsList()
    await renderAssetsList(assets)
    await refreshTopPortfolioMetrics(assets)
    await refreshOverviewIfVisible()

    const visibleAssets = getSidebarVisibleAssets(assets)
    const selectedAssetId =
        document.querySelector(".assetBtn.selected")?.dataset.assetId ||
        (visibleAssets.some((a) => a.id === currentAssetId) ? currentAssetId : "") ||
        visibleAssets[0]?.id ||
        ""

    if (!selectedAssetId) {
        resetAssetDetailView()
        return
    }

    currentAssetId = selectedAssetId
    const fullAsset = await loadAssetData(selectedAssetId)
    await updateAssetDetail(fullAsset)
}

function getCompletedOperationsCryptoImpact(asset) {
    const assetId = String(asset?.id || "").trim()
    const persistedRows = Array.isArray(asset?.operationRows) ? asset.operationRows : []
    const liveRows = Array.isArray(externalOperacionesRowsCache) ? externalOperacionesRowsCache : []
    const sourceRows = [
        ...persistedRows.filter((row) => String(row.assetId || "").trim() === assetId),
        ...liveRows.filter((row) => String(row.assetId || "").trim() === assetId)
    ].reduce((rows, row) => {
        const rowId = String(row.id || "").trim()
        const existingIndex = rowId ? rows.findIndex((item) => String(item.id || "").trim() === rowId) : -1

        if (existingIndex >= 0) {
            rows[existingIndex] = row
        } else {
            rows.push(row)
        }

        return rows
    }, [])

    const completedRows = sourceRows.filter(
        (row) =>
            String(row.estado || "")
                .trim()
                .toLowerCase() === "completado"
    )

    const summary = completedRows.reduce(
        (summary, row) => {
            const quantity = parseLooseNumber(row.cantidad || "") || 0
            const commission = parseLooseNumber(row.comisionesCripto || row.comisiones || "") || 0
            const operationType = String(row.orden || "")
                .trim()
                .toLowerCase()

            if (quantity <= 0) {
                return summary
            }

            if (operationType === "venta") {
                summary.quantityDelta -= quantity + commission
                summary.commissionTotal += commission
                return summary
            }

            if (operationType === "compra") {
                summary.quantityDelta += Math.max(0, quantity - commission)
                summary.commissionTotal += commission
                return summary
            }

            return summary
        },
        { quantityDelta: 0, commissionTotal: 0 }
    )

    return {
        ...summary,
        rows: completedRows.sort((left, right) => {
            const leftDate = parseAssetOperationDate(left.fechaApertura || left.fecha || left.fechaCierre || "")
            const rightDate = parseAssetOperationDate(right.fechaApertura || right.fecha || right.fechaCierre || "")
            return leftDate - rightDate
        })
    }
}

function getTransaccionesCryptoImpact(asset) {
    const assetId = String(asset?.id || "").trim()
    const sourceRows = Array.isArray(externalTransaccionesRowsCache)
        ? externalTransaccionesRowsCache.filter((row) => String(row?.assetId || "").trim() === assetId)
        : []

    const summary = sourceRows.reduce(
        (accumulator, row) => {
            const walletType = String(row?.walletTipo || "")
                .trim()
                .toLowerCase()
            const quantity = parseLooseNumber(row?.total || "") || 0
            const networkFee = Math.max(0, parseLooseNumber(row?.comisionRed || "") || 0)

            if (quantity <= 0) {
                return accumulator
            }

            if (walletType === "recibida") {
                accumulator.quantityDelta += quantity
                return accumulator
            }

            if (walletType === "enviada") {
                accumulator.quantityDelta -= quantity + networkFee
                accumulator.commissionTotal += networkFee
                return accumulator
            }

            if (walletType === "entre_wallet") {
                accumulator.quantityDelta -= networkFee
                accumulator.commissionTotal += networkFee
                return accumulator
            }

            return accumulator
        },
        { quantityDelta: 0, commissionTotal: 0 }
    )

    return {
        ...summary,
        rows: sourceRows
    }
}

function getAssetVentasRows(asset) {
    const assetId = String(asset?.id || "").trim()

    return Array.isArray(externalVentasRowsCache)
        ? externalVentasRowsCache
              .filter((row) => String(row?.assetId || "").trim() === assetId)
              .sort(
                  (left, right) =>
                      parseAssetOperationDate(left.fecha || "") - parseAssetOperationDate(right.fecha || "")
              )
        : []
}

async function refreshAssetMarketDataOnServer(assetId) {
    const response = await fetch(`/api/activos/${assetId}/refresh-market-data`, {
        method: "POST"
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

async function changeAssetCurrencyOnServer(assetId, currency) {
    const response = await fetch(`/api/activos/${assetId}/currency`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ currency })
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

async function searchFinnhubSymbolOnServer(query, { assetName = "", assetType = "" } = {}) {
    const params = new URLSearchParams({
        q: query
    })

    if (assetName) {
        params.set("assetName", assetName)
    }

    if (assetType) {
        params.set("assetType", assetType)
    }

    const response = await fetch(`/api/market/search?${params.toString()}`)

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

async function searchEodhdSymbolOnServer(query, { assetName = "", assetType = "" } = {}) {
    const params = new URLSearchParams({
        q: query
    })

    if (assetName) {
        params.set("assetName", assetName)
    }

    if (assetType) {
        params.set("assetType", assetType)
    }

    const response = await fetch(`/api/eodhd/search?${params.toString()}`)

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

async function searchYahooSymbolOnServer(query, { assetName = "", assetType = "" } = {}) {
    const params = new URLSearchParams({
        q: query
    })

    if (assetName) {
        params.set("assetName", assetName)
    }

    if (assetType) {
        params.set("assetType", assetType)
    }

    const response = await fetch(`/api/yahoo/search?${params.toString()}`)

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

async function searchAlphaVantageSymbolOnServer(query, { assetName = "", assetType = "" } = {}) {
    const params = new URLSearchParams({ q: query })

    if (assetName) params.set("assetName", assetName)
    if (assetType) params.set("assetType", assetType)

    const response = await fetch(`/api/alphavantage/search?${params.toString()}`)

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

async function searchTradingViewSymbolOnServer(query, { assetName = "", assetType = "" } = {}) {
    const params = new URLSearchParams({ q: query })

    if (assetName) params.set("assetName", assetName)
    if (assetType) params.set("assetType", assetType)

    const response = await fetch(`/api/tradingview/search?${params.toString()}`)

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

function extractApiErrorMessage(error) {
    const rawMessage = String(error?.message || "Error desconocido")
    const jsonStart = rawMessage.indexOf("{")

    if (jsonStart === -1) {
        return rawMessage
    }

    try {
        const payload = JSON.parse(rawMessage.slice(jsonStart))
        return payload.error || rawMessage
    } catch {
        return rawMessage
    }
}

function formatAssetLastUpdated(value) {
    const normalizedValue = String(value || "").trim()

    if (!normalizedValue) {
        return "Sin datos de mercado"
    }

    const date = new Date(normalizedValue)

    if (Number.isNaN(date.getTime())) {
        return "Sin datos de mercado"
    }

    return `Actualizado: ${date.toLocaleString("es-ES", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    })}`
}

async function saveAssetOrderOnServer(orderedAssetIds) {
    const response = await fetch("/api/activos/reorder", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ orderedAssetIds })
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

// Compartido entre la fila del sidebar y la ficha inferior: misma cuenta,
// mismo signo, para que "Var. hoy" no cuente una historia distinta de la lista.
function buildChangeMoneyDisplay(asset, displayPrice, currency) {
    const changePctStr = String(asset?.change || "").trim()
    const changePct = parseLooseNumber(changePctStr.replace(/%/g, "")) || 0
    const changeAbs = Math.abs((displayPrice * changePct) / 100)
    const changeSign = changePct < 0 ? "−" : changePct > 0 ? "+" : ""
    const changeClass = changePct < 0 ? "negative" : changePct > 0 ? "positive" : ""
    const moneyStr = changePctStr ? `${changeSign}${formatMoney(changeAbs, currency)}` : "—"
    return { changePctStr, changePct, changeClass, moneyStr }
}

async function updateAssetDetail(asset) {
    const detSymbol = document.getElementById("detSymbol")
    const detName = document.getElementById("detName")
    const detPrice = document.getElementById("detPrice")
    const detChange = document.getElementById("detChange")
    const detType = document.getElementById("detType")
    const detPosition = document.getElementById("detPosition")
    const detInvested = document.getElementById("detInvested")
    const detPnL = document.getElementById("detPnL")
    const detAvgPrice = document.getElementById("detAvgPrice")
    const detFees = document.getElementById("detFees")
    const detStatus = document.getElementById("detStatus")
    const detFinnhub = document.getElementById("detFinnhub")
    const detChangeAbs = document.getElementById("detChangeAbs")
    const detWeight = document.getElementById("detWeight")
    const summary = await buildOverviewRow(asset)
    const pnlBruto = summary.netoActual - summary.invertidoBruto
    const displayPrice = await getAssetDisplayPriceValue(asset)
    const displayCurrency = asset.currency || "EUR"

    if (detSymbol) {
        detSymbol.textContent = asset.symbol || "---"
    }

    if (detName) {
        detName.textContent = asset.name || "Activo"
    }

    if (detPrice) {
        detPrice.textContent = formatMoney(displayPrice, displayCurrency)
    }

    if (detChange) {
        const yieldPercent = calculateYieldPercent(summary.invertidoBruto, pnlBruto)
        detChange.textContent = `Rendimiento: ${formatPercent(yieldPercent)}`
        detChange.classList.toggle("negative", yieldPercent < 0)
    }

    if (detType) {
        detType.textContent = buildAssetTypeLabel(asset.type)
    }

    if (detPosition) {
        detPosition.textContent = formatAssetParticipationValue(
            summary.participacionesSinTransacciones ?? summary.participaciones,
            asset.type
        )
    }

    if (detInvested) {
        detInvested.textContent = formatMoney(summary.invertidoBruto, summary.currency)
    }

    if (detPnL) {
        detPnL.textContent = formatMoney(pnlBruto, summary.currency)
        detPnL.classList.toggle("negative", pnlBruto < 0)
    }

    if (detAvgPrice) {
        detAvgPrice.textContent = formatMoney(summary.promedioCompra, summary.currency)
    }

    if (detFees) {
        detFees.textContent = formatMoney(summary.comisiones, summary.currency)
    }

    if (detStatus) {
        detStatus.textContent = formatAssetLastUpdated(asset.lastUpdated)
    }

    if (detFinnhub) {
        const marketProvider = String(
            asset.marketProvider || inferMarketProviderFromSymbol(asset.marketSymbol || asset.finnhubSymbol || "")
        ).toUpperCase()
        const marketSymbol = asset.marketSymbol || asset.finnhubSymbol || "---"
        detFinnhub.textContent = `Ticker mercado: ${marketSymbol} · API: ${marketProvider}`
    }

    if (detChangeAbs) {
        const { moneyStr, changeClass } = buildChangeMoneyDisplay(asset, displayPrice, displayCurrency)
        detChangeAbs.textContent = moneyStr
        detChangeAbs.classList.toggle("negative", changeClass === "negative")
    }

    if (detWeight) {
        const totalCuenta = window._lastPortfolioMetrics?.totalCuenta || 0
        if (totalCuenta > 0) {
            const euroMetrics = await buildSummaryMetricsInEuros(summary)
            detWeight.textContent = formatPercent((euroMetrics.netoActualEur / totalCuenta) * 100)
        } else {
            detWeight.textContent = "---"
        }
    }

    _sidebarAssetActual = asset

    renderAssetCompletedOperationsSection(asset)
    renderAssetVentasSection(asset)
    renderAssetTodosSection(asset)
}

function renderAssetCompletedOperationsSection(asset) {
    const section = document.getElementById("assetCompletedOperationsSection")
    const tabBtn = document.getElementById("completadasTabBtn")

    if (!section) return

    const completedOps = getCompletedOperationsCryptoImpact(asset)
    const rows = completedOps.rows || []

    if (!rows.length) {
        section.innerHTML = ""
        if (tabBtn) tabBtn.classList.add("hidden")
        return
    }

    if (tabBtn) {
        tabBtn.classList.remove("hidden")
        tabBtn.textContent = `Operaciones Spot (${rows.length})`
    }

    const currency = normalizeCurrencyCode(asset.currency || "EUR")

    const rowsHtml = rows
        .map((row) => {
            const orden = String(row.orden || "").trim()
            const ordenClass = orden.toLowerCase() === "venta" ? "opRowVenta" : "opRowCompra"
            return `
            <tr>
                <td>${escapeHtml(row.fechaApertura || "")}</td>
                <td>${escapeHtml(row.par || "")}</td>
                <td class="${ordenClass}">${escapeHtml(orden)}</td>
                <td>${formatOperationsMoney(row.precioOrden, row.precioCurrency || currency)}</td>
                <td>${formatOperationsQuantity(row.cantidad)}</td>
                <td data-field="comisionesCripto">${formatOperationsQuantity(row.comisionesCripto)}</td>
                <td data-field="comisionesFiat">${formatOperationsMoney(row.comisionesFiat, "EUR")}</td>
                <td>${formatOperationsMoney(row.total, row.currency || currency)}</td>
                <td>${escapeHtml(row.estado || "")}</td>
                <td>${escapeHtml(row.fechaCierre || "")}</td>
            </tr>
        `
        })
        .join("")

    section.innerHTML = `
        <div class="assetTableWrapper">
            <table class="assetOperationsTable assetCompletedOpsTable">
                <thead>
                    <tr>
                        <th class="mThSort" data-sortkey="0">Fecha apertura<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="1">Par<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="2">Orden<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="3">Precio orden<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="4">Cantidad<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="5">Comisiones cripto<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="6">Comisiones €<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="7">Total<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="8">Estado<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="9">Fecha cierre<span class="mSortArrow"></span></th>
                    </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        </div>
    `
    bindTableSort(section.querySelector("table"), "completedOps")
}

function renderAssetTransaccionesSection(asset) {
    const section = document.getElementById("assetTransaccionesSection")
    const tabBtn = document.getElementById("transaccionesTabBtn")

    if (!section) return

    const impact = getTransaccionesCryptoImpact(asset)
    const rows = impact.rows || []

    if (!rows.length) {
        section.innerHTML = ""
        if (tabBtn) tabBtn.classList.add("hidden")
        return
    }

    if (tabBtn) {
        tabBtn.classList.remove("hidden")
        tabBtn.textContent = `Transacciones (${rows.length})`
    }

    const walletLabels = { entre_wallet: "Entre wallet", recibida: "Recibida", enviada: "Enviada" }

    const rowsHtml = rows
        .map((row) => {
            const walletTipo = String(row.walletTipo || "")
                .trim()
                .toLowerCase()
            const walletLabel = walletLabels[walletTipo] || escapeHtml(row.walletTipo || "")
            const hash = String(row.hashTransaccion || row.walletOrigen || "").trim()
            const hashDisplay = hash.length > 12 ? hash.slice(0, 8) + "…" + hash.slice(-4) : hash
            return `
            <tr>
                <td>${escapeHtml(row.fechaOperacion || "")}</td>
                <td>${formatTransaccionesNumber(row.total)}</td>
                <td>${formatTransaccionesNumber(row.comisionRed)}</td>
                <td>${walletLabel}</td>
                <td>${escapeHtml(row.walletDestino || "")}</td>
                <td class="transaccionHashCell" title="${escapeHtml(hash)}">${escapeHtml(hashDisplay)}</td>
                <td>${escapeHtml(row.nota || "")}</td>
            </tr>
        `
        })
        .join("")

    section.innerHTML = `
        <div class="assetTableWrapper">
            <table class="assetOperationsTable assetTransaccionesTable">
                <thead>
                    <tr>
                        <th class="mThSort" data-sortkey="0">Fecha<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="1">Total<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="2">Comisión red<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="3">Tipo<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="4">Wallet destino<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="5">Hash<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="6">Nota<span class="mSortArrow"></span></th>
                    </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        </div>
    `
    bindTableSort(section.querySelector("table"), "assetTransacciones")
}

// Pestaña "Todos": las procedencias de un mismo activo en una sola tabla
// ordenada por fecha, con una columna que dice de dónde sale cada fila. Es solo
// una vista: no recalcula nada ni añade nada a los totales, que siguen saliendo
// de sus tablas de origen. Es la pestaña con la que se abre la ficha y está
// siempre visible, aunque el activo solo tenga un origen o ninguna fila.
