// escapeHtml y el resto de utilidades de DOM viven ahora en js/dom.js, que se
// carga antes que este fichero.

const exchangeRateCache = new Map()
let externalVentasRowsCache = []
let externalTransaccionesRowsCache = []
let externalOperacionesRowsCache = []
let currentAssetPersistedOperationRows = []
let currentAssetPersistedConversionRows = []
let _assetDisplayRows = []
let _assetSortKey = null
let _assetSortDir = "asc"
let _sidebarFilter = "portfolio"
let _editingAsset = null
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

function openDeleteTypeConfirm(assetName, onConfirmed) {
    const overlay = document.getElementById("deleteTypeOverlay")
    const msg = document.getElementById("deleteTypeMsg")
    const input = document.getElementById("deleteTypeInput")
    const cancelBtn = document.getElementById("deleteTypeCancelBtn")
    const okBtn = document.getElementById("deleteTypeOkBtn")
    if (!overlay || !input) return

    const expected = assetName.toUpperCase()
    msg.textContent = `Escribe "${expected}" para confirmar la eliminación definitiva.`
    input.value = ""
    input.style.borderColor = ""
    overlay.classList.remove("hidden")
    setTimeout(() => input.focus(), 50)

    function doConfirm() {
        if (input.value.trim() !== expected) {
            input.style.borderColor = "var(--danger, #e74c3c)"
            input.focus()
            return
        }
        overlay.classList.add("hidden")
        cleanup()
        onConfirmed()
    }

    function doCancel() {
        overlay.classList.add("hidden")
        cleanup()
    }

    function onKey(e) {
        if (e.key === "Enter") doConfirm()
        if (e.key === "Escape") doCancel()
    }

    function cleanup() {
        okBtn.removeEventListener("click", doConfirm)
        cancelBtn.removeEventListener("click", doCancel)
        input.removeEventListener("keydown", onKey)
        input.style.borderColor = ""
    }

    okBtn.addEventListener("click", doConfirm)
    cancelBtn.addEventListener("click", doCancel)
    input.addEventListener("keydown", onKey)
}

async function createAssetOnServer(
    name,
    type,
    marketSymbol = "",
    marketProvider = "finnhub",
    color = "",
    tvSymbol = ""
) {
    const response = await fetch("/api/activos", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ name, type, marketSymbol, marketProvider, finnhubSymbol: marketSymbol, color, tvSymbol })
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
    const summary = await buildOverviewRow(asset)
    const pnlBruto = summary.netoActual - summary.invertidoBruto

    if (detSymbol) {
        detSymbol.textContent = asset.symbol || "---"
    }

    if (detName) {
        detName.textContent = asset.name || "Activo"
    }

    if (detPrice) {
        const displayPrice = await getAssetDisplayPriceValue(asset)
        detPrice.textContent = formatMoney(displayPrice, asset.currency || "EUR")
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
        detFees.textContent = isCryptoAssetType(asset.type)
            ? formatAssetCommissionValue(summary.comisionesCripto)
            : formatMoney(summary.comisiones, summary.currency)
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

    renderAssetCompletedOperationsSection(asset)
    renderAssetVentasSection(asset)
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
                <td>${row.fechaOperacion || ""}</td>
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

function renderAssetVentasSection(asset) {
    const section = document.getElementById("assetVentasSection")
    const tabBtn = document.getElementById("ventasTabBtn")

    if (!section) return

    const rows = getAssetVentasRows(asset)

    if (tabBtn) {
        tabBtn.classList.remove("hidden")
        tabBtn.textContent = rows.length ? `Ventas (${rows.length})` : "Ventas"
    }

    if (!rows.length) {
        // Sin botón propio: la acción es la de la barra de pestañas, para no
        // tener dos "Añadir venta" a la vez.
        section.innerHTML = `
            <div class="assetVentasEmpty">
                <p class="assetVentasEmptyText">No hay ventas registradas para este activo.</p>
            </div>
        `
        return
    }

    const rowsHtml = rows
        .map((row) => {
            const cantidad = row.cantidad ? parseLooseNumber(row.cantidad) : null
            const cantidadFmt =
                cantidad !== null
                    ? cantidad.toLocaleString("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: 8 })
                    : ""
            return `
            <tr>
                <td>${escapeHtml(row.fecha || "")}</td>
                <td>${escapeHtml(cantidadFmt)}</td>
                <td class="rowTotal">${row.valorCompra ? formatMoney(parseLooseNumber(row.valorCompra), "EUR") : ""}</td>
                <td>${row.valorVenta ? formatMoney(parseLooseNumber(row.valorVenta), "EUR") : ""}</td>
                <td class="rowTotal">${row.bruto ? formatMoney(parseLooseNumber(row.bruto), "EUR") : ""}</td>
                <td class="rowTotal">${row.dineroDeclarar ? formatMoney(parseLooseNumber(row.dineroDeclarar), "EUR") : ""}</td>
                <td class="rowTotal">${row.totalPagar ? formatMoney(parseLooseNumber(row.totalPagar), "EUR") : ""}</td>
                <td class="rowTotal">${row.neto ? formatMoney(parseLooseNumber(row.neto), "EUR") : ""}</td>
            </tr>
        `
        })
        .join("")

    section.innerHTML = `
        <div class="assetTableWrapper">
            <table class="assetOperationsTable assetVentasTable">
                <thead>
                    <tr>
                        <th class="mThSort" data-sortkey="0">Fecha<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="1">Cantidad<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="2">Precio compra (FIFO)<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="3">Valor venta<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="4">Bruto<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="5">A declarar<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="6">Impuestos<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="7">Neto<span class="mSortArrow"></span></th>
                    </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        </div>
    `
    bindTableSort(section.querySelector("table"), "assetVentas")
}

function openAssetAddVentaModal(asset) {
    document.getElementById("assetAddVentaModalOverlay")?.remove()

    const assetName = asset.name || asset.id || ""
    const today = new Date()
    const dd = String(today.getDate()).padStart(2, "0")
    const mm = String(today.getMonth() + 1).padStart(2, "0")
    const yyyy = today.getFullYear()
    const todayStr = `${dd}-${mm}-${yyyy}`

    const overlay = document.createElement("div")
    overlay.id = "assetAddVentaModalOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"

    const modal = document.createElement("div")
    modal.className = "assetModal assetRowModal"

    const title = document.createElement("h3")
    title.className = "assetModalTitle assetRowModalTitle"
    title.textContent = `Añadir venta · ${assetName}`

    const fields = document.createElement("div")
    fields.className = "assetRowModalFields"
    fields.innerHTML = `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Fecha</label>
            <input id="avModalFecha" class="assetRowModalInput" type="text" value="${todayStr}" placeholder="dd-mm-aaaa">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Cantidad</label>
            <input id="avModalCantidad" class="assetRowModalInput" type="text" inputmode="decimal" placeholder="0">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Valor de venta (€)</label>
            <input id="avModalValorVenta" class="assetRowModalInput" type="text" inputmode="decimal" placeholder="0.00">
        </div>
        <div id="avModalFeedback" class="assetRowModalFeedback" style="display:none"></div>
    `

    const footer = document.createElement("div")
    footer.className = "assetRowModalFooter"
    footer.innerHTML = `
        <button type="button" id="assetAddVentaCancelBtn" class="cancelButton assetRowModalCancelBtn">Cancelar</button>
        <button type="button" id="assetAddVentaSaveBtn" class="primaryButton assetRowModalSaveBtn">Guardar venta</button>
    `

    modal.appendChild(title)
    modal.appendChild(fields)
    modal.appendChild(footer)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    const close = () => overlay.remove()
    footer.querySelector("#assetAddVentaCancelBtn").addEventListener("click", close)
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close()
    })

    const saveBtn = footer.querySelector("#assetAddVentaSaveBtn")
    const fechaInput = fields.querySelector("#avModalFecha")
    const cantidadInput = fields.querySelector("#avModalCantidad")
    const valorVentaInput = fields.querySelector("#avModalValorVenta")
    const feedback = fields.querySelector("#avModalFeedback")

    saveBtn.addEventListener("click", async () => {
        const fecha = fechaInput.value.trim()
        const cantidad = cantidadInput.value.trim()
        const valorVenta = valorVentaInput.value.trim()

        if (!fecha || !cantidad || !valorVenta) {
            feedback.textContent = "Fecha, cantidad y valor de venta son obligatorios."
            feedback.style.display = "block"
            return
        }

        saveBtn.disabled = true
        saveBtn.textContent = "Guardando..."

        try {
            await saveNewVentaFromAsset(asset, fecha, cantidad, valorVenta)
            close()
            await loadVentasRowsForAssets()
            renderAssetVentasSection(asset)
            if (document.querySelector('.assetTabPanel[data-tab="ventas"]')) {
                setActiveAssetTab("ventas")
            }
        } catch (err) {
            feedback.textContent = `Error al guardar: ${err.message}`
            feedback.style.display = "block"
            saveBtn.disabled = false
            saveBtn.textContent = "Guardar venta"
        }
    })

    fechaInput.focus()
}

async function saveNewVentaFromAsset(asset, fecha, cantidad, valorVenta) {
    const yearMatch = fecha.match(/(\d{4})$/)
    const year = yearMatch ? yearMatch[1] : String(new Date().getFullYear())

    let yearData = null
    const yearRes = await fetch(`/api/ventas/${year}`)
    if (yearRes.ok) {
        yearData = await yearRes.json()
    } else {
        const createRes = await fetch("/api/ventas", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ year })
        })
        if (!createRes.ok) throw new Error("No se pudo crear el año de ventas")
        yearData = (await createRes.json()).data || { year, rows: [] }
    }

    const existingRows = Array.isArray(yearData?.rows) ? yearData.rows : []
    const newRow = {
        id: `venta-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        fecha,
        assetId: String(asset.id || ""),
        activo: String(asset.name || asset.id || ""),
        cantidad: String(cantidad),
        valorVenta: String(valorVenta),
        valorCompra: "",
        dineroDeclarar: "",
        bruto: "",
        neto: "",
        totalPagar: ""
    }

    const saveRes = await fetch(`/api/ventas/${year}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year, rows: [...existingRows, newRow] })
    })

    if (!saveRes.ok) {
        const text = await saveRes.text()
        throw new Error(`HTTP ${saveRes.status}: ${text}`)
    }
}

// Un activo desaparece del sidebar por dos vías distintas: la lista de ocultos
// de Ajustes (preferencia del portfolio, por id) o el flag `hidden` del propio
// activo, que se marca con "Ocultar" en la página de Activos. Las dos tienen
// que afectar igual a la lista y a la ficha de detalle de abajo, así que la
// decisión vive en un único sitio.
function getSidebarHiddenIds() {
    if (window._viewAllPortfolios) return new Set()
    return window._hiddenAssets instanceof Set ? window._hiddenAssets : new Set()
}

function isAssetHiddenInSidebar(asset, hiddenIds = getSidebarHiddenIds()) {
    if (!asset) return false
    return Boolean(asset.hidden) || hiddenIds.has(asset.id)
}

// Los mismos activos que acaban pintados como botones en el sidebar: ocultos
// fuera y, además, el filtro Portfolio/Watchlist activo. La ficha de abajo se
// alimenta de esta lista, así que nunca puede mostrar algo que no esté arriba.
function getSidebarVisibleAssets(assets) {
    const hiddenIds = getSidebarHiddenIds()
    let visible = (Array.isArray(assets) ? assets : []).filter((a) => !isAssetHiddenInSidebar(a, hiddenIds))

    if (_sidebarFilter === "portfolio") {
        visible = visible.filter((a) => a.hasRows)
    } else if (_sidebarFilter === "watchlist") {
        visible = visible.filter((a) => !a.hasRows)
    }

    return visible
}

async function renderAssetsList(assets) {
    const assetsList = document.getElementById("assetsList")

    if (!assetsList) {
        return
    }

    const staleMs = (window._settingsStaleHours ?? 24) > 0 ? (window._settingsStaleHours ?? 24) * 3600 * 1000 : Infinity
    const now = Date.now()
    const visible = getSidebarVisibleAssets(assets)
    const fragment = document.createDocumentFragment()

    for (const asset of visible) {
        const isStale =
            staleMs < Infinity && asset.lastUpdated ? now - new Date(asset.lastUpdated).getTime() > staleMs : false
        const portfolioBadge =
            window._viewAllPortfolios && asset.portfolioName
                ? `<span class="assetPortfolioBadge">${escapeHtml(asset.portfolioName)}</span>`
                : ""
        try {
            const displayPrice = await getAssetDisplayPriceValue(asset)
            const displayCurrency = asset.currency || "EUR"
            const changePctStr = String(asset.change || "").trim()
            const changePct = parseLooseNumber(changePctStr.replace(/%/g, "")) || 0
            const changeAbs = Math.abs((displayPrice * changePct) / 100)
            const changeSign = changePct < 0 ? "−" : changePct > 0 ? "+" : ""
            const changeClass = changePct < 0 ? "negative" : changePct > 0 ? "positive" : ""
            const changeMoneyStr = changePctStr ? `${changeSign}${formatMoney(changeAbs, displayCurrency)}` : "—"
            const button = document.createElement("button")
            button.className = `assetBtn${asset.id === currentAssetId ? " selected" : ""}${isStale ? " stale" : ""}`
            button.dataset.assetId = asset.id
            button.dataset.assetOrder = String(asset.order ?? 0)
            button.dataset.tvSymbol = asset.tvSymbol || ""
            button.dataset.marketSymbol = asset.marketSymbol || asset.finnhubSymbol || ""
            button.dataset.marketProvider = asset.marketProvider || ""
            button.dataset.assetSymbol = asset.symbol || ""
            button.dataset.assetName = asset.name || ""
            button.draggable = !window._viewAllPortfolios
            button.innerHTML = `
                <span class="assetBtnName">${escapeHtml(asset.name || asset.symbol || "Activo")}${portfolioBadge}</span>
                <span class="assetBtnPrice">${formatMoney(displayPrice, displayCurrency)}</span>
                <span class="assetBtnChange ${changeClass}">${changeMoneyStr}</span>
                <span class="assetBtnChangePct ${changeClass}">${changePctStr || "—"}</span>
            `
            fragment.appendChild(button)
        } catch (error) {
            console.error(
                `No se pudo renderizar el precio del activo ${asset.name || asset.symbol || asset.id}:`,
                error
            )
            const fallbackPrice = parseLooseNumber(asset.price || "") || 0
            const fallbackCurrency = asset.currency || "EUR"
            const changePctStr = String(asset.change || "").trim()
            const changePct = parseLooseNumber(changePctStr.replace(/%/g, "")) || 0
            const changeAbs = Math.abs((fallbackPrice * changePct) / 100)
            const changeSign = changePct < 0 ? "−" : changePct > 0 ? "+" : ""
            const changeClass = changePct < 0 ? "negative" : changePct > 0 ? "positive" : ""
            const changeMoneyStr = changePctStr ? `${changeSign}${formatMoney(changeAbs, fallbackCurrency)}` : "—"
            const button = document.createElement("button")
            button.className = `assetBtn${asset.id === currentAssetId ? " selected" : ""}${isStale ? " stale" : ""}`
            button.dataset.assetId = asset.id
            button.dataset.assetOrder = String(asset.order ?? 0)
            button.dataset.tvSymbol = asset.tvSymbol || ""
            button.dataset.marketSymbol = asset.marketSymbol || asset.finnhubSymbol || ""
            button.dataset.marketProvider = asset.marketProvider || ""
            button.dataset.assetSymbol = asset.symbol || ""
            button.dataset.assetName = asset.name || ""
            button.draggable = !window._viewAllPortfolios
            button.innerHTML = `
                <span class="assetBtnName">${escapeHtml(asset.name || asset.symbol || "Activo")}${portfolioBadge}</span>
                <span class="assetBtnPrice">${formatMoney(fallbackPrice, fallbackCurrency)}</span>
                <span class="assetBtnChange ${changeClass}">${changeMoneyStr}</span>
                <span class="assetBtnChangePct ${changeClass}">${changePctStr || "—"}</span>
            `
            fragment.appendChild(button)
        }
    }

    if (_sidebarFilter === "watchlist" && !window._viewAllPortfolios) {
        const pid = window._activePortfolioId || "default"
        let customSeg = []
        try {
            customSeg = JSON.parse(localStorage.getItem(`seguimientoList_${pid}`) || "[]")
        } catch {}
        const dbIds = new Set(visible.map((a) => a.id))
        const dbNames = new Set(visible.map((a) => (a.name || "").toLowerCase()))
        for (const item of customSeg) {
            const nombre = (item.nombre || item.ticker || "").trim()
            if (!nombre) continue
            const slugId =
                nombre
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-|-$/g, "") || "activo"
            if (dbIds.has(slugId) || dbNames.has(nombre.toLowerCase())) continue
            const btn = document.createElement("button")
            btn.className = "assetBtn assetBtnSegCustom"
            btn.dataset.assetId = ""
            btn.dataset.assetName = nombre
            btn.dataset.tvSymbol = item.tvSymbol || ""
            btn.dataset.marketSymbol = item.ticker || ""
            btn.dataset.marketProvider = item.marketProvider || ""
            btn.dataset.assetSymbol = item.ticker || ""
            btn.dataset.segSlugId = slugId
            btn.dataset.segTipo = item.tipo || "acciones"
            btn.draggable = false
            btn.innerHTML = `
                <span class="assetBtnName">${escapeHtml(nombre)}</span>
                <span class="assetBtnPrice">—</span>
                <span class="assetBtnChange">—</span>
                <span class="assetBtnChangePct">—</span>
            `
            fragment.appendChild(btn)
        }
    }

    assetsList.innerHTML = ""
    assetsList.appendChild(fragment)

    initAssetSelector([...assetsList.querySelectorAll(".assetBtn:not(.assetBtnSegCustom)")])
    assetsList.querySelectorAll(".assetBtnSegCustom").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const nombre = btn.dataset.assetName || ""
            const slugId = btn.dataset.segSlugId || ""
            const ticker = btn.dataset.marketSymbol || ""
            const tvSym = btn.dataset.tvSymbol || ""
            const tipo = btn.dataset.segTipo || "acciones"
            const provider = btn.dataset.marketProvider || "finnhub"
            if (!nombre) return
            let assetId = slugId
            try {
                const checkRes = await fetch(`/api/activos/${encodeURIComponent(slugId)}`)
                if (!checkRes.ok) {
                    const createRes = await fetch("/api/activos", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            name: nombre,
                            type: tipo,
                            marketSymbol: ticker,
                            marketProvider: provider,
                            tvSymbol: tvSym
                        })
                    })
                    if (createRes.ok) {
                        const d = await createRes.json()
                        assetId = d.asset?.id || slugId
                    }
                }
                currentAssetId = assetId
                const assetData = await loadAssetData(assetId)
                await updateAssetDetail(assetData)
                await renderAssetsList(await loadAssetsList())
                if (tvSym) openTVChartModal(tvSym, nombre)
            } catch (err) {
                console.error("Error abriendo activo de watchlist:", err)
            }
        })
    })
    if (!window._viewAllPortfolios) initAssetDragAndDrop(assetsList)
}

// Deja la ficha inferior en blanco: ningún activo es "el principal", así que
// mientras no se elija uno la tarjeta muestra los valores por defecto.
function resetAssetDetailView() {
    currentAssetId = null

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

    if (detSymbol) {
        detSymbol.textContent = "---"
    }

    if (detName) {
        detName.textContent = "Selecciona un activo"
    }

    if (detPrice) {
        detPrice.textContent = "0,00 €"
    }

    if (detChange) {
        detChange.textContent = "---"
        detChange.classList.remove("negative")
    }

    if (detType) {
        detType.textContent = "---"
    }

    if (detPosition) {
        detPosition.textContent = "0"
    }

    if (detInvested) {
        detInvested.textContent = "0,00 €"
    }

    if (detPnL) {
        detPnL.textContent = "0,00 €"
        detPnL.classList.remove("negative")
    }

    if (detAvgPrice) {
        detAvgPrice.textContent = "0,00 €"
    }

    if (detFees) {
        detFees.textContent = "0,00 €"
    }

    if (detStatus) {
        detStatus.textContent = "Sin datos de mercado"
    }

    if (detFinnhub) {
        detFinnhub.textContent = "Ticker mercado: ---"
    }
}

async function refreshAssetsSidebar(selectedAssetId = currentAssetId, renderTable = false) {
    try {
        await loadVentasRowsForAssets()
        await loadTransaccionesRowsForAssets()
        await loadOperacionesRowsForAssets()
        const assets = await loadAssetsList()
        await renderAssetsList(assets)
        await refreshTopPortfolioMetrics(assets)
        await refreshTopDividendosIntereses()
        await refreshOverviewIfVisible()

        // La ficha de abajo solo puede mostrar activos que estén en la lista: si
        // el seleccionado se acaba de ocultar (o aún no hay ninguno elegido) cae
        // al primero visible, y solo se queda en blanco si la lista está vacía.
        const visibleAssets = getSidebarVisibleAssets(assets)
        const selectedAsset = visibleAssets.find((asset) => asset.id === selectedAssetId) || visibleAssets[0]

        if (!selectedAsset) {
            resetAssetDetailView()
            await renderAssetsList(assets)
            return
        }

        currentAssetId = selectedAsset.id
        await renderAssetsList(assets)

        const fullAsset = await loadAssetData(selectedAsset.id)
        await updateAssetDetail(fullAsset)

        if (renderTable) {
            renderAssetTablePage(fullAsset)
        }
    } catch (error) {
        console.error("Error refrescando activos:", error)
    }
}

async function selectAsset(assetId) {
    if (!assetId) {
        return
    }

    currentAssetId = assetId
    const assetData = await loadAssetData(assetId)
    await updateAssetDetail(assetData)
    await renderAssetsList(await loadAssetsList())
    renderAssetTablePage(assetData)
}

async function refreshOverviewIfVisible() {
    if (document.getElementById("overviewTableBody")) {
        await renderVistaGeneralTable()
    }
}

function initAssetDragAndDrop(assetsList) {
    const assetButtons = [...assetsList.querySelectorAll(".assetBtn:not(.assetBtnSegCustom)")]

    assetButtons.forEach((button) => {
        if (!button.draggable) {
            return
        }

        button.addEventListener("dragstart", (event) => {
            draggedAssetId = button.dataset.assetId || null

            if (!draggedAssetId) {
                return
            }

            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "move"
                event.dataTransfer.setData("text/plain", draggedAssetId)
            }

            // El estilo de hueco se aplica tras generar la imagen de arrastre
            requestAnimationFrame(() => button.classList.add("dragging"))
        })

        button.addEventListener("dragend", () => {
            const wasDropped = assetsList.dataset.dragDropped === "true"
            delete assetsList.dataset.dragDropped
            button.classList.remove("dragging")
            draggedAssetId = null

            if (!wasDropped) {
                // Arrastre cancelado: se restaura el orden real desde el servidor
                refreshAssetsSidebar(currentAssetId, false).catch((error) => console.error(error))
            }
        })
    })

    if (assetsList.dataset.dragBound === "true") {
        return
    }

    assetsList.dataset.dragBound = "true"

    assetsList.addEventListener("dragover", (event) => {
        const dragged = assetsList.querySelector(".assetBtn.dragging")

        if (!draggedAssetId || !dragged) {
            return
        }

        event.preventDefault()

        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "move"
        }

        moveDraggedAssetPreview(assetsList, dragged, findAssetListDropReference(assetsList, dragged, event.clientY))
    })

    assetsList.addEventListener("drop", async (event) => {
        const dragged = assetsList.querySelector(".assetBtn.dragging")

        if (!draggedAssetId || !dragged) {
            return
        }

        event.preventDefault()
        assetsList.dataset.dragDropped = "true"

        const movedAssetId = draggedAssetId

        try {
            await commitAssetOrderFromDom(assetsList, ".assetBtn:not(.assetBtnSegCustom)", movedAssetId)
            await refreshAssetsSidebar(currentAssetId, false)
        } catch (error) {
            console.error(error)
            alert("No se pudo reordenar el activo.")
            await refreshAssetsSidebar(currentAssetId, false).catch(() => {})
        }
    })
}

// Devuelve el elemento delante del cual debe colocarse el activo arrastrado (null = al final)
function findAssetListDropReference(assetsList, dragged, pointerY) {
    const buttons = [...assetsList.querySelectorAll(".assetBtn:not(.assetBtnSegCustom)")].filter(
        (button) => button !== dragged && button.dataset.assetId
    )

    for (const button of buttons) {
        const rect = button.getBoundingClientRect()

        if (pointerY < rect.top + rect.height / 2) {
            return button
        }
    }

    return assetsList.querySelector(".assetBtnSegCustom")
}

// Reubica en vivo el elemento arrastrado para que se vea dónde va a quedar
function moveDraggedAssetPreview(container, dragged, reference) {
    if (reference === dragged) {
        return
    }

    if (!reference) {
        if (container.lastElementChild !== dragged) {
            container.appendChild(dragged)
        }

        return
    }

    if (reference.previousElementSibling !== dragged) {
        container.insertBefore(dragged, reference)
    }
}

// Traslada el orden visible del DOM al orden completo de activos y lo guarda
async function commitAssetOrderFromDom(container, selector, movedAssetId) {
    const visibleIds = [...container.querySelectorAll(selector)]
        .map((element) => element.dataset.assetId)
        .filter(Boolean)
    const movedIndex = visibleIds.indexOf(movedAssetId)

    if (movedIndex === -1) {
        throw new Error("No se encontró el activo para reordenar")
    }

    const previousId = movedIndex > 0 ? visibleIds[movedIndex - 1] : null
    const nextId = movedIndex < visibleIds.length - 1 ? visibleIds[movedIndex + 1] : null

    const assets = await loadAssetsList()
    const orderedIds = assets.map((asset) => asset.id)
    const sourceIndex = orderedIds.indexOf(movedAssetId)

    if (sourceIndex === -1) {
        throw new Error("No se encontró el activo para reordenar")
    }

    orderedIds.splice(sourceIndex, 1)

    let insertIndex = orderedIds.length

    if (previousId && orderedIds.indexOf(previousId) !== -1) {
        insertIndex = orderedIds.indexOf(previousId) + 1
    } else if (nextId && orderedIds.indexOf(nextId) !== -1) {
        insertIndex = orderedIds.indexOf(nextId)
    } else if (!previousId) {
        insertIndex = 0
    }

    orderedIds.splice(insertIndex, 0, movedAssetId)
    await saveAssetOrderOnServer(orderedIds)
}

function buildAssetTypeLabel(assetType) {
    const labels = {
        cripto: "Cripto",
        acciones: "Acciones",
        etfs: "ETFs",
        comoditis: "Comoditis"
    }

    return labels[assetType] || assetType
}

function createAssetSymbolFromName(name) {
    return (
        String(name || "")
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "")
            .slice(0, 24) || "ACTIVO"
    )
}

function formatPercent(value) {
    return (
        new Intl.NumberFormat("es-ES", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(value) + " %"
    )
}

function formatCellPercentValue(value) {
    const numericValue = parseLooseNumber(value)

    if (numericValue === null) {
        return String(value || "").trim()
    }

    return formatPercent(numericValue)
}

// Desglose activo/divisa de la ficha abierta.
//
// El P&L de arriba está en la moneda del activo y no cambia. Esto añade
// debajo, en euros, cuánto de ese resultado viene del activo y cuánto del
// tipo de cambio: para un activo en dólares el número agregado mezcla los dos
// y no hay forma de leerlo. Lo calcula el servidor (/api/activos/rendimiento-batch),
// que es quien tiene el tipo de cambio del día de cada compra.
let _divisaBatchCache = null

async function fetchDivisaBatch({ forzar = false } = {}) {
    if (_divisaBatchCache && !forzar) {
        return _divisaBatchCache
    }
    try {
        const res = await fetch("/api/activos/rendimiento-batch")
        _divisaBatchCache = res.ok ? await res.json() : {}
    } catch {
        // Un fallo aquí no puede impedir que se vea la ficha: el desglose es
        // información adicional, no el dato principal de la pantalla.
        _divisaBatchCache = {}
    }
    return _divisaBatchCache
}

async function renderAssetDivisaBreakdown(assetId) {
    const contenedor = document.getElementById("assetStatDivisa")
    if (!contenedor) return

    const datos = (await fetchDivisaBatch())[assetId]?.divisa
    // Un activo en euros no tiene efecto divisa que separar: la línea sobra.
    if (!datos || datos.moneda === "EUR") {
        contenedor.classList.add("hidden")
        contenedor.innerHTML = ""
        return
    }

    const activo = Number(datos.efectoActivo)
    const divisa = Number(datos.efectoDivisa)
    const signo = (v) => (v >= 0 ? "+" : "")
    const clase = (v) => (v > 0 ? "assetStatPositive" : v < 0 ? "assetStatNegative" : "")

    // El aviso importa: sin el tipo de cambio del día de cada compra, el
    // reparto entre los dos efectos es una aproximación y presentarlo como
    // exacto sería peor que no darlo.
    const aviso = datos.completo
        ? ""
        : `<span class="assetStatDivisaAviso" title="Faltan tipos de cambio históricos de algunas compras. Complétalos desde Ajustes → Tipos de cambio.">aprox.</span>`

    contenedor.classList.remove("hidden")
    contenedor.innerHTML = `
        <span class="assetStatDivisaItem">
            <span class="assetStatDivisaLabel">Activo</span>
            <span class="${clase(activo)}">${signo(activo)}${formatMoney(activo, "EUR")}</span>
        </span>
        <span class="assetStatDivisaItem">
            <span class="assetStatDivisaLabel">Divisa (${escapeHtml(datos.moneda)})</span>
            <span class="${clase(divisa)}">${signo(divisa)}${formatMoney(divisa, "EUR")}</span>
        </span>
        ${aviso}
    `
}

function calculateYieldPercent(invertidoNeto, rendimiento) {
    if (!invertidoNeto) {
        return 0
    }

    return (rendimiento / invertidoNeto) * 100
}

function createEmptyTopMetrics() {
    return {
        totalCuenta: 0,
        invertido: 0,
        rendimiento: 0,
        tipos: {
            cripto: { netoActual: 0, invertido: 0, rendimiento: 0 },
            acciones: { netoActual: 0, invertido: 0, rendimiento: 0 },
            etfs: { netoActual: 0, invertido: 0, rendimiento: 0 },
            comoditis: { netoActual: 0, invertido: 0, rendimiento: 0 }
        }
    }
}

function updateTopMetricElement(elementId, value, colorize = false) {
    const element = document.getElementById(elementId)
    if (!element) return
    element.textContent = value
    if (colorize) {
        const isNegative = value.trim().startsWith("-")
        const num = parseFloat(value.replace(/[^0-9.,-]/g, "").replace(",", "."))
        const isZero = isNaN(num) || num === 0
        element.classList.toggle("metricPositive", !isNegative && !isZero)
        element.classList.toggle("metricNegative", isNegative)
    } else {
        element.classList.remove("metricPositive", "metricNegative")
    }
}

function applyTopPortfolioMetrics(metrics) {
    updateTopMetricElement("topTotalCuenta", formatEuro(metrics.totalCuenta))
    updateTopMetricElement(
        "topPorcentajeCuenta",
        formatPercent(calculateYieldPercent(metrics.invertido, metrics.rendimiento)),
        true
    )
    updateTopMetricElement("topInvertido", formatEuro(metrics.invertido))
    updateTopMetricElement("topRendimientoEuros", formatEuro(metrics.rendimiento))
    const numActivosEl = document.getElementById("topNumActivos")
    if (numActivosEl && metrics.numActivos !== undefined) numActivosEl.textContent = metrics.numActivos

    updateTopMetricElement(
        "topPorcentajeCripto",
        formatPercent(calculateYieldPercent(metrics.tipos.cripto.invertido, metrics.tipos.cripto.rendimiento)),
        true
    )
    updateTopMetricElement("topEurosCripto", formatEuro(metrics.tipos.cripto.netoActual))
    updateTopMetricElement(
        "topPorcentajeAcciones",
        formatPercent(calculateYieldPercent(metrics.tipos.acciones.invertido, metrics.tipos.acciones.rendimiento)),
        true
    )
    updateTopMetricElement("topEurosAcciones", formatEuro(metrics.tipos.acciones.netoActual))
    updateTopMetricElement(
        "topPorcentajeEtf",
        formatPercent(calculateYieldPercent(metrics.tipos.etfs.invertido, metrics.tipos.etfs.rendimiento)),
        true
    )
    updateTopMetricElement("topEurosEtf", formatEuro(metrics.tipos.etfs.netoActual))
    updateTopMetricElement(
        "topPorcentajeComoditis",
        formatPercent(calculateYieldPercent(metrics.tipos.comoditis.invertido, metrics.tipos.comoditis.rendimiento)),
        true
    )
    updateTopMetricElement("topEurosComoditis", formatEuro(metrics.tipos.comoditis.netoActual))
    if (typeof applyTopMetricsVisibility === "function") applyTopMetricsVisibility()
}

async function refreshTopPortfolioMetrics(assets = null) {
    const baseAssets = Array.isArray(assets) ? assets : await loadAssetsList()

    if (!baseAssets.length) {
        applyTopPortfolioMetrics(createEmptyTopMetrics())
        return
    }

    const metrics = createEmptyTopMetrics()
    const fullAssets = await Promise.all(baseAssets.map((asset) => loadAssetData(asset.id)))
    const metricResults = await Promise.allSettled(
        fullAssets.map(async (asset) => {
            const summary = await buildOverviewRow(asset)
            const euroMetrics = await buildSummaryMetricsInEuros(summary)

            return { summary, euroMetrics, assetId: asset.id }
        })
    )
    metricResults
        .filter((r) => r.status === "rejected")
        .forEach((r) => console.error("Error calculando métricas de activo:", r.reason))
    const metricSummaries = metricResults.filter((r) => r.status === "fulfilled").map((r) => r.value)

    metricSummaries.forEach(({ summary, euroMetrics }) => {
        metrics.totalCuenta += euroMetrics.netoActualEur
        metrics.invertido += euroMetrics.invertidoBrutoEur
        metrics.rendimiento += euroMetrics.rendimientoEur

        if (metrics.tipos[summary.assetType]) {
            metrics.tipos[summary.assetType].netoActual += euroMetrics.netoActualEur
            metrics.tipos[summary.assetType].invertido += euroMetrics.invertidoBrutoEur
            metrics.tipos[summary.assetType].rendimiento += euroMetrics.rendimientoEur
        }
    })

    metrics.numActivos = baseAssets.length
    window._lastPortfolioMetrics = { totalCuenta: metrics.totalCuenta, invertido: metrics.invertido }
    window._assetsSnapshotData = metricSummaries
        .filter((r) => r.euroMetrics.netoActualEur > 0)
        .map((r) => ({
            id: r.assetId,
            netoEur: r.euroMetrics.netoActualEur,
            costEur: r.euroMetrics.invertidoBrutoEur || 0
        }))
    applyTopPortfolioMetrics(metrics)
}

let _ovShowHidden = false

async function initVistaGeneralLogic() {
    const filtersContainer = document.getElementById("overviewFilters")
    const refreshOverviewMarketButton = document.getElementById("refreshOverviewMarketBtn")
    const showHiddenBtn = document.getElementById("overviewShowHiddenBtn")
    const exportOverviewBtn = document.getElementById("downloadOverviewCsvBtn")

    if (showHiddenBtn && !showHiddenBtn.dataset.bound) {
        showHiddenBtn.dataset.bound = "true"
        showHiddenBtn.classList.toggle("active", _ovShowHidden)
        showHiddenBtn.addEventListener("click", () => {
            _ovShowHidden = !_ovShowHidden
            showHiddenBtn.classList.toggle("active", _ovShowHidden)
            renderVistaGeneralTable()
        })
    }

    if (filtersContainer && !filtersContainer.dataset.bound) {
        filtersContainer.dataset.bound = "true"
        filtersContainer.addEventListener("change", (e) => {
            const changed = e.target
            const todosInput = filtersContainer.querySelector('input[value="todos"]')
            const individualInputs = [
                ...filtersContainer.querySelectorAll('input[type="checkbox"]:not([value="todos"])')
            ]

            if (changed.value === "todos") {
                // Todos siempre activa todo (no se puede desmarcar directamente)
                changed.checked = true
                individualInputs.forEach((cb) => {
                    cb.checked = true
                })
            } else if (todosInput?.checked) {
                // Había Todos activo → selección exclusiva del pulsado
                todosInput.checked = false
                individualInputs.forEach((cb) => {
                    cb.checked = cb === changed
                })
                changed.checked = true
            } else {
                // Toggle individual normal; si todos marcados → activar Todos
                if (todosInput) {
                    todosInput.checked = individualInputs.every((cb) => cb.checked)
                }
            }
            renderVistaGeneralTable()
        })
    }

    if (refreshOverviewMarketButton && !refreshOverviewMarketButton.dataset.bound) {
        refreshOverviewMarketButton.dataset.bound = "true"
        refreshOverviewMarketButton.addEventListener("click", async () => {
            await refreshOverviewMarketData(refreshOverviewMarketButton)
        })
    }

    if (exportOverviewBtn && !exportOverviewBtn.dataset.bound) {
        exportOverviewBtn.dataset.bound = "true"
        exportOverviewBtn.addEventListener("click", downloadVistaGeneralCsv)
    }

    await renderVistaGeneralTable()
}

async function refreshOverviewMarketData(buttonElement = null) {
    const originalLabel = buttonElement?.textContent || ""

    if (buttonElement) {
        buttonElement.disabled = true
        buttonElement.textContent = "Actualizando..."
    }

    try {
        const assets = await loadAssetsList()
        const assetsWithTicker = assets.filter((asset) =>
            String(asset.marketSymbol || asset.finnhubSymbol || "").trim()
        )

        for (const asset of assetsWithTicker) {
            try {
                await refreshAssetMarketDataOnServer(asset.id)
            } catch (error) {
                console.error(`No se pudo actualizar ${asset.name || asset.symbol || asset.id}:`, error)
            }
        }

        await refreshAssetsSidebar(currentAssetId, false)
        await renderVistaGeneralTable()
        if (typeof segRefreshCustomPrices === "function") {
            try {
                await segRefreshCustomPrices()
            } catch {}
        }
        if (typeof refreshOperationsTickerPrices === "function") {
            try {
                await refreshOperationsTickerPrices()
            } catch {}
        }
    } finally {
        if (buttonElement) {
            buttonElement.disabled = false
            buttonElement.textContent = originalLabel
        }
    }
}

function initSidebarFilterBar() {
    const bar = document.getElementById("sidebarFilterBar")
    if (!bar || bar.dataset.bound) return
    bar.dataset.bound = "true"
    bar.addEventListener("click", async (e) => {
        const btn = e.target.closest(".sidebarFilterBtn")
        if (!btn) return
        _sidebarFilter = btn.dataset.filter
        bar.querySelectorAll(".sidebarFilterBtn").forEach((b) => b.classList.toggle("active", b === btn))
        const assets = await loadAssetsList()
        await renderAssetsList(assets)
    })
    bar.style.display = window._viewAllPortfolios ? "none" : ""
}

function initSidebarRefreshButton(buttonElement) {
    if (!buttonElement || buttonElement.dataset.bound) {
        return
    }

    buttonElement.dataset.bound = "true"
    buttonElement.addEventListener("click", async () => {
        await refreshOverviewMarketData(buttonElement)
    })
}

function getSelectedOverviewTypes() {
    const todosInput = document.querySelector('#overviewFilters input[value="todos"]')
    if (todosInput?.checked) return ["cripto", "acciones", "etfs", "comoditis"]
    return [...document.querySelectorAll('#overviewFilters input[type="checkbox"]:checked')]
        .map((input) => input.value)
        .filter((v) => v !== "todos")
}

function parseParticipationNumber(value) {
    const cleanValue = String(value || "")
        .replace(/\s/g, "")
        .replace(/\./g, "")
        .replace(",", ".")

    const parsedValue = parseFloat(cleanValue)
    return Number.isNaN(parsedValue) ? 0 : parsedValue
}

function getCryptoRowCommissionCrypto(row = {}) {
    return row.comisionesCripto ?? row.comisionesSatoshis ?? row.comisiones ?? ""
}

function getCryptoRowCommissionFiat(row = {}) {
    return row.comisionesFiat ?? ""
}

function deriveAssetBaseSymbolFromData(assetOrDataset = {}) {
    const marketSymbol = String(
        assetOrDataset.marketSymbol ||
            assetOrDataset.finnhubSymbol ||
            assetOrDataset.assetMarketSymbol ||
            assetOrDataset.assetFinnhubSymbol ||
            ""
    )
        .trim()
        .toUpperCase()
    const fallbackSymbol = String(
        assetOrDataset.symbol || assetOrDataset.assetSymbol || assetOrDataset.name || assetOrDataset.assetName || ""
    )
        .trim()
        .toUpperCase()

    if (marketSymbol.includes(":")) {
        const symbolPart = marketSymbol.split(":").pop() || ""
        const basePart = symbolPart.split("/")[0].split("-")[0].split("_")[0] || ""
        const stablecoinSuffixes = [
            "USDT",
            "USDC",
            "BUSD",
            "DAI",
            "FDUSD",
            "PYUSD",
            "TUSD",
            "USDE",
            "EURC",
            "USD",
            "EUR"
        ]

        for (const suffix of stablecoinSuffixes) {
            if (basePart.endsWith(suffix)) {
                return basePart.slice(0, -suffix.length) || fallbackSymbol
            }
        }

        return basePart || fallbackSymbol
    }

    if (marketSymbol.includes("/")) {
        return marketSymbol.split("/")[0] || fallbackSymbol
    }

    return fallbackSymbol
}

function getConvertedInOperationLabel(baseSymbol) {
    return `Convertidos a ${baseSymbol}`
}

function getConvertedOutOperationLabel(baseSymbol) {
    return `${baseSymbol} convertidos`
}

function isConvertedOutOperationType(operationType = "") {
    const normalized = String(operationType || "")
        .trim()
        .toLowerCase()
    return normalized.includes(" convertidos") || normalized === "convertidos"
}

function isConvertedInOperationType(operationType = "") {
    const normalized = String(operationType || "")
        .trim()
        .toLowerCase()
    return normalized.includes("convertidos a")
}

function createConversionRowId() {
    return `conversion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeAssetConversionTypeLabel(value, assetData = {}) {
    const baseSymbol = deriveAssetBaseSymbolFromData(assetData)
    const convertedInLabel = getConvertedInOperationLabel(baseSymbol)
    const convertedOutLabel = getConvertedOutOperationLabel(baseSymbol)
    const normalizedValue = String(value || "")
        .trim()
        .toLowerCase()

    if (normalizedValue === convertedOutLabel.toLowerCase() || isConvertedOutOperationType(normalizedValue)) {
        return convertedOutLabel
    }

    return convertedInLabel
}

function getPrimaryAssetRows(asset = {}) {
    return Array.isArray(asset.rows)
        ? asset.rows.filter((row) => {
              const operationType = String(row?.tipoOperacion || "").trim()
              return !isConvertedInOperationType(operationType) && !isConvertedOutOperationType(operationType)
          })
        : []
}

function getAssetConversionRows(asset = {}) {
    const explicitRows = Array.isArray(asset.conversionRows) ? asset.conversionRows : []
    const legacyRows = Array.isArray(asset.rows)
        ? asset.rows
              .filter((row) => {
                  const operationType = String(row?.tipoOperacion || "").trim()
                  return isConvertedInOperationType(operationType) || isConvertedOutOperationType(operationType)
              })
              .map((row, index) => ({
                  id: createConversionRowId(),
                  fecha: String(row.fechaOperacion || "").trim(),
                  par: String(row.par || "").trim(),
                  tipo: normalizeAssetConversionTypeLabel(row.tipoOperacion || "", asset),
                  cantidad: String(row.participaciones || "").trim(),
                  legacyOrder: index
              }))
        : []

    const mergedRows = [...explicitRows, ...legacyRows]
    const uniqueRows = []
    const seenKeys = new Set()

    mergedRows.forEach((row, index) => {
        const normalizedRow = {
            id: String(row.id || createConversionRowId()).trim() || createConversionRowId(),
            fecha: String(row.fecha || row.fechaOperacion || "").trim(),
            par: String(row.par || "").trim(),
            tipo: normalizeAssetConversionTypeLabel(row.tipo || row.tipoOperacion || "", asset),
            cantidad: String(row.cantidad || row.participaciones || "").trim(),
            sortIndex: index
        }
        const dedupeKey = [normalizedRow.fecha, normalizedRow.par, normalizedRow.tipo, normalizedRow.cantidad].join("|")

        if (seenKeys.has(dedupeKey)) {
            return
        }

        seenKeys.add(dedupeKey)
        uniqueRows.push(normalizedRow)
    })

    uniqueRows.sort((left, right) => {
        const leftDate = parseAssetOperationDate(left.fecha)
        const rightDate = parseAssetOperationDate(right.fecha)

        if (leftDate === rightDate) {
            return (left.sortIndex || 0) - (right.sortIndex || 0)
        }

        return leftDate - rightDate
    })

    return uniqueRows.map(({ sortIndex, ...row }) => row)
}

function parseAssetOperationDate(value) {
    const text = String(value || "").trim()

    if (!text) {
        return Number.POSITIVE_INFINITY
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return new Date(`${text}T00:00:00`).getTime()
    }

    const match = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/)

    if (!match) {
        return Number.POSITIVE_INFINITY
    }

    const [, day, month, year] = match
    return new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00`).getTime()
}

function getRowGrossAmount(row, assetType = "") {
    const capitalInvertidoBruto = parseLooseNumber(row.capitalInvertidoBruto || "")
    return capitalInvertidoBruto || 0
}

function getRowTotalCostForLot(row, assetType = "") {
    const capitalInvertidoBruto = parseLooseNumber(row.capitalInvertidoBruto || "")
    if (capitalInvertidoBruto !== null && capitalInvertidoBruto > 0) {
        return capitalInvertidoBruto
    }
    const participaciones = parseParticipationNumber(row.participaciones)
    if (participaciones > 0) {
        const precioParticipacion = parseLooseNumber(row.precioParticipacion || "")
        if (precioParticipacion !== null && precioParticipacion > 0) {
            return precioParticipacion * participaciones
        }
    }
    return 0
}

async function convertCryptoRowMoneyToAssetCurrency(amount, row, assetCurrency) {
    const numericAmount = Number(amount) || 0
    const sourceCurrency = normalizeAssetRowCurrency(row?.currency, assetCurrency)
    return await convertAmountForDisplay(numericAmount, sourceCurrency, assetCurrency)
}

async function buildRemainingAssetLots(asset, targetCurrency = asset?.currency || "EUR") {
    const rows = [...getPrimaryAssetRows(asset)]
    const conversionRows = getAssetConversionRows(asset)
    const completedOperationsImpact = getCompletedOperationsCryptoImpact(asset)
    const transaccionesImpact = getTransaccionesCryptoImpact(asset)
    const ventasRows = getAssetVentasRows(asset)

    const lots = []
    const timelineEvents = []

    for (const row of rows) {
        timelineEvents.push({
            kind: "assetRow",
            date: parseAssetOperationDate(row.fechaOperacion || ""),
            row
        })
    }

    for (const operationRow of completedOperationsImpact.rows) {
        timelineEvents.push({
            kind: "operacion",
            date: parseAssetOperationDate(
                operationRow.fechaApertura || operationRow.fecha || operationRow.fechaCierre || ""
            ),
            row: operationRow
        })
    }

    for (const ventaRow of ventasRows) {
        timelineEvents.push({
            kind: "ventaExterna",
            date: parseAssetOperationDate(ventaRow.fecha || ""),
            row: ventaRow
        })
    }

    for (const transaccionRow of transaccionesImpact.rows) {
        timelineEvents.push({
            kind: "transaccion",
            date: parseAssetOperationDate(transaccionRow.fechaOperacion || ""),
            row: transaccionRow
        })
    }

    for (const conversionRow of conversionRows) {
        timelineEvents.push({
            kind: "conversion",
            date: parseAssetOperationDate(conversionRow.fecha || ""),
            row: conversionRow
        })
    }

    timelineEvents.sort((left, right) => left.date - right.date)

    for (const event of timelineEvents) {
        if (event.kind === "assetRow") {
            const row = event.row
            const operationType = String(row.tipoOperacion || "")
                .trim()
                .toLowerCase()
            const participaciones = parseParticipationNumber(row.participaciones)
            const cryptoCommission = isCryptoAssetType(asset.type)
                ? Math.max(0, parseLooseNumber(getCryptoRowCommissionCrypto(row)) || 0)
                : 0

            if (participaciones <= 0) {
                continue
            }

            if (operationType.includes("venta")) {
                consumeAssetLots(lots, participaciones + cryptoCommission)
                continue
            }

            const netParticipaciones = Math.max(0, participaciones - cryptoCommission)

            if (netParticipaciones <= 0) {
                continue
            }

            let totalCost = getRowTotalCostForLot(row, asset.type)

            if (isCryptoAssetType(asset.type)) {
                totalCost = await convertCryptoRowMoneyToAssetCurrency(totalCost, row, targetCurrency)
            }

            lots.push({
                remaining: netParticipaciones,
                priceQuantity: netParticipaciones,
                unitCost: netParticipaciones > 0 ? totalCost / netParticipaciones : 0,
                displayUnitPrice: netParticipaciones > 0 ? totalCost / netParticipaciones : 0,
                totalCost
            })
            continue
        }

        if (event.kind === "operacion") {
            const operationRow = event.row
            const operationType = String(operationRow.orden || "")
                .trim()
                .toLowerCase()
            const quantity = parseLooseNumber(operationRow.cantidad || "") || 0
            const cryptoCommission = Math.max(
                0,
                parseLooseNumber(operationRow.comisionesCripto || operationRow.comisiones || "") || 0
            )

            if (quantity <= 0) {
                continue
            }

            if (operationType === "venta") {
                consumeAssetLots(lots, quantity + cryptoCommission)
                continue
            }

            const netParticipaciones = Math.max(0, quantity - cryptoCommission)

            if (netParticipaciones <= 0) {
                continue
            }

            const totalCost = await convertAmountForDisplay(
                parseLooseNumber(operationRow.total || "") || 0,
                normalizeCurrencyCode(operationRow.currency || operationRow.precioCurrency || targetCurrency),
                targetCurrency
            )
            const executionPrice = await convertAmountForDisplay(
                parseLooseNumber(operationRow.precioOrden || "") || 0,
                normalizeCurrencyCode(operationRow.precioCurrency || operationRow.currency || targetCurrency),
                targetCurrency
            )

            lots.push({
                remaining: netParticipaciones,
                priceQuantity: quantity,
                unitCost: netParticipaciones > 0 ? totalCost / netParticipaciones : 0,
                displayUnitPrice: executionPrice,
                totalCost
            })
            continue
        }

        if (event.kind === "ventaExterna") {
            const quantity = parseLooseNumber(event.row.cantidad || "") || 0

            if (quantity > 0) {
                consumeAssetLots(lots, quantity)
            }
            continue
        }

        if (event.kind === "transaccion") {
            const transaccionRow = event.row
            const walletType = String(transaccionRow.walletTipo || "")
                .trim()
                .toLowerCase()
            const quantity = parseLooseNumber(transaccionRow.total || "") || 0
            const networkFee = Math.max(0, parseLooseNumber(transaccionRow.comisionRed || "") || 0)

            if (quantity <= 0) {
                continue
            }

            if (walletType === "entre_wallet") {
                if (networkFee > 0) consumeAssetLots(lots, networkFee)
                continue
            }

            if (walletType === "enviada") {
                consumeAssetLots(lots, quantity + networkFee)
                continue
            }

            if (walletType === "recibida") {
                lots.push({
                    remaining: quantity,
                    priceQuantity: quantity,
                    unitCost: 0,
                    displayUnitPrice: 0,
                    totalCost: 0
                })
            }
            continue
        }

        if (event.kind === "conversion") {
            const conversionRow = event.row
            const quantity = parseLooseNumber(conversionRow.cantidad || "") || 0
            const conversionType = String(conversionRow.tipo || "").trim()

            if (quantity <= 0) {
                continue
            }

            if (isConvertedOutOperationType(conversionType)) {
                consumeAssetLots(lots, quantity)
                continue
            }

            lots.push({
                remaining: quantity,
                priceQuantity: quantity,
                unitCost: 0,
                displayUnitPrice: 0,
                totalCost: 0
            })
        }
    }

    return lots
}

function consumeAssetLots(lots, quantityToSell) {
    let remainingToSell = quantityToSell

    for (const lot of lots) {
        if (remainingToSell <= 0) {
            break
        }

        const quantityFromLot = Math.min(lot.remaining, remainingToSell)

        if (quantityFromLot <= 0) {
            continue
        }

        lot.remaining -= quantityFromLot
        if (typeof lot.priceQuantity === "number") {
            lot.priceQuantity = Math.max(0, lot.priceQuantity - quantityFromLot)
        }
        remainingToSell -= quantityFromLot
    }
}

async function buildOverviewRow(asset) {
    const rows = Array.isArray(asset.rows) ? asset.rows : []
    const isCrypto = isCryptoAssetType(asset.type)
    // El activo tiene una sola moneda: precio, invertido y rendimiento van en
    // ella. Las compras anotadas en otra moneda se convierten al agregarlas.
    const assetCurrency = normalizeCurrencyCode(asset.currency || "EUR")
    const remainingLots = await buildRemainingAssetLots(asset, assetCurrency)
    const rawParticipaciones = remainingLots.reduce((total, lot) => total + lot.remaining, 0)
    const completedOperationsImpact = getCompletedOperationsCryptoImpact(asset)
    const transaccionesImpact = getTransaccionesCryptoImpact(asset)
    const participacionesSinTransacciones = Math.max(0, rawParticipaciones)
    const participaciones = participacionesSinTransacciones
    const invertidoBruto = remainingLots.reduce((total, lot) => total + lot.remaining * lot.unitCost, 0)
    const comisionesCripto = isCrypto
        ? rows.reduce((total, row) => total + (parseLooseNumber(getCryptoRowCommissionCrypto(row)) || 0), 0) +
          completedOperationsImpact.commissionTotal +
          transaccionesImpact.commissionTotal
        : 0
    const comisionesFiat = isCrypto
        ? (
              await Promise.all(
                  rows.map(async (row) => {
                      const feeAmount = parseLooseNumber(getCryptoRowCommissionFiat(row)) || 0
                      return await convertCryptoRowMoneyToAssetCurrency(feeAmount, row, assetCurrency)
                  })
              )
          ).reduce((total, value) => total + value, 0)
        : rows.reduce((total, row) => total + (parseLooseNumber(row.comisiones || "") || 0), 0)
    const invertidoNeto = invertidoBruto - comisionesFiat
    const valorActual = parseLooseNumber(asset.price || "") || 0
    const netoActual = participaciones * valorActual
    const promedioCompra = participaciones > 0 ? invertidoNeto / participaciones : 0
    const rendimiento = netoActual - invertidoNeto

    return {
        nombre: asset.name || asset.symbol || "Activo",
        tipo: buildAssetTypeLabel(asset.type),
        assetType: asset.type,
        participacionesSinTransacciones,
        participaciones,
        promedioCompra,
        valorActual,
        currency: assetCurrency,
        invertidoBruto,
        comisiones: comisionesFiat,
        comisionesFiat,
        comisionesCripto,
        invertidoNeto,
        netoActual,
        rendimiento
    }
}

let _ovSortKey = "sidebarOrder"
let _ovSortDir = "asc"
let _ovRows = []

function downloadVistaGeneralCsv() {
    if (!Array.isArray(_ovRows) || !_ovRows.length) {
        alert("No hay activos para exportar.")
        return
    }

    const rows = _ovRows.map((row) => ({
        Nombre: row.nombre || "",
        Tipo: row.tipo || "",
        Posición: row.participaciones ?? "",
        "P. medio": row.promedioCompra ?? "",
        "Valor actual": row.overviewCurrentPrice ?? row.valorActual ?? "",
        "Inv. bruto": row.invertidoBruto ?? "",
        "Comis.": row.comisionesFiat ?? row.comisiones ?? "",
        "Inv. neto": row.invertidoNeto ?? "",
        "Neto actual": row.overviewCurrentValue ?? "",
        "Rend. €": row.overviewYieldValue ?? row.rendimiento ?? "",
        "Rend. %":
            row.invertidoBruto > 0 ? ((row.overviewYieldValue ?? row.rendimiento ?? 0) / row.invertidoBruto) * 100 : ""
    }))

    const filename = `vista-general-${new Date().toISOString().slice(0, 10)}.csv`
    const exported = downloadCsvFile(filename, rows)
    if (!exported) {
        alert("No hay activos para exportar.")
    }
}

function _ovSortRows(rows) {
    return [...rows].sort((a, b) => {
        let va = a[_ovSortKey] ?? 0
        let vb = b[_ovSortKey] ?? 0
        if (typeof va === "string") va = va.toLowerCase()
        if (typeof vb === "string") vb = vb.toLowerCase()
        if (va < vb) return _ovSortDir === "asc" ? -1 : 1
        if (va > vb) return _ovSortDir === "asc" ? 1 : -1
        return 0
    })
}

function _ovUpdateSortArrows() {
    document.querySelectorAll("#overviewTable .mThSort").forEach((th) => {
        const arrow = th.querySelector(".mSortArrow")
        if (!arrow) return
        if (th.dataset.sortkey === _ovSortKey) {
            arrow.textContent = _ovSortDir === "asc" ? " ▲" : " ▼"
            th.classList.add("mThActive")
        } else {
            arrow.textContent = ""
            th.classList.remove("mThActive")
        }
    })
}

function _ovBindSort() {
    document.querySelectorAll("#overviewTable .mThSort").forEach((th) => {
        th.addEventListener("click", () => {
            const key = th.dataset.sortkey
            if (_ovSortKey === key) {
                _ovSortDir = _ovSortDir === "asc" ? "desc" : "asc"
            } else {
                _ovSortKey = key
                _ovSortDir = key === "sidebarOrder" || key === "nombre" ? "asc" : "desc"
            }
            renderOverviewRows(_ovRows)
        })
    })
}

function renderOverviewRows(rows) {
    _ovRows = rows
    const tableBody = document.getElementById("overviewTableBody")
    const emptyState = document.getElementById("overviewEmptyState")

    if (!tableBody) {
        return
    }

    tableBody.innerHTML = ""

    if (!rows.length) {
        if (emptyState) {
            emptyState.classList.remove("hidden")
        }
        return
    }

    if (emptyState) {
        emptyState.classList.add("hidden")
    }

    const OV_TYPE_COLORS = { cripto: "#f7931a", acciones: "#3a7bd5", etfs: "#2ecc71", comoditis: "#e0c068" }
    const sorted = _ovSortRows(rows)

    sorted.forEach((row, idx) => {
        const tr = document.createElement("tr")
        if (row._isOculto) tr.classList.add("overviewTrHidden")
        const yieldVal = row.overviewYieldValue ?? 0
        const rClass = yieldVal >= 0 ? "mCellPos" : "mCellNeg"
        const sign = yieldVal >= 0 ? "+" : ""
        const overviewCommissions = formatMoney(row.comisionesFiat ?? row.comisiones, row.currency)
        const typeColor = OV_TYPE_COLORS[row.assetType] || "#888"
        const typeBadge = `<span class="mTypeBadge" style="background:${typeColor}22;color:${typeColor};border-color:${typeColor}44">${row.tipo}</span>`
        const yieldEur = formatMoney(yieldVal, row.currency)
        const yieldPct = row.invertidoBruto > 0 ? sign + ((yieldVal / row.invertidoBruto) * 100).toFixed(2) + " %" : "—"

        tr.innerHTML = `
            <td class="mTdRank">${idx + 1}</td>
            <td class="mTdName">${escapeHtml(row.nombre)}</td>
            <td>${typeBadge}</td>
            <td>${formatAssetParticipationValue(row.participaciones, row.assetType)}</td>
            <td>${formatMoney(row.promedioCompra, row.currency)}</td>
            <td><strong>${formatMoney(row.overviewCurrentPrice ?? row.valorActual, row.currency)}</strong></td>
            <td>${formatMoney(row.invertidoBruto, row.currency)}</td>
            <td>${overviewCommissions}</td>
            <td>${formatMoney(row.invertidoNeto, row.currency)}</td>
            <td>${formatMoney(row.overviewCurrentValue, row.currency)}</td>
            <td class="${rClass}">${sign}${yieldEur}</td>
            <td class="${rClass}">${yieldPct}</td>
        `

        if (row.id) {
            tr.style.cursor = "pointer"
            tr.addEventListener("click", async () => {
                clearNavSelection()
                await selectAsset(row.id)
            })
        }

        tableBody.appendChild(tr)
    })

    _ovUpdateSortArrows()
}

async function renderVistaGeneralTable() {
    const tableBody = document.getElementById("overviewTableBody")

    if (!tableBody) {
        return
    }

    _ovSortKey = "sidebarOrder"
    _ovSortDir = "asc"

    try {
        const assets = await loadAssetsList()
        const selectedTypes = new Set(getSelectedOverviewTypes())

        if (!selectedTypes.size) {
            renderOverviewRows([])
            return
        }

        const loadResults = await Promise.allSettled(assets.map((asset) => loadAssetData(asset.id)))
        loadResults
            .filter((r) => r.status === "rejected")
            .forEach((r) => console.error("Error cargando datos de activo:", r.reason))
        const fullAssets = loadResults.filter((r) => r.status === "fulfilled").map((r) => r.value)

        const results = await Promise.allSettled(
            fullAssets.filter((asset) => selectedTypes.has(asset.type)).map((asset) => buildOverviewDisplayRow(asset))
        )
        results
            .filter((r) => r.status === "rejected")
            .forEach((r) => console.error("Error procesando activo en vista general:", r.reason))
        const allRows = results.filter((r) => r.status === "fulfilled").map((r) => r.value)

        const rows = allRows
            .map((r) => ({
                ...r,
                _isOculto: r.hidden || (r.participaciones === 0 && r.invertidoBruto === 0)
            }))
            .filter((r) => _ovShowHidden || !r._isOculto)

        renderOverviewRows(rows)
        _ovBindSort()
    } catch (error) {
        console.error("Error cargando vista general:", error)
        renderOverviewRows([])
    }
}

function _assetSortRows(rows) {
    if (!_assetSortKey) return rows.map((r, i) => ({ ...r, _origIdx: i }))
    return rows
        .map((r, i) => ({ ...r, _origIdx: i }))
        .sort((a, b) => {
            let va = a[_assetSortKey] ?? ""
            let vb = b[_assetSortKey] ?? ""
            const na = parseFloat(String(va).replace(/\./g, "").replace(",", "."))
            const nb = parseFloat(String(vb).replace(/\./g, "").replace(",", "."))
            if (!isNaN(na) && !isNaN(nb)) {
                va = na
                vb = nb
            } else {
                va = String(va).toLowerCase()
                vb = String(vb).toLowerCase()
            }
            if (va < vb) return _assetSortDir === "asc" ? -1 : 1
            if (va > vb) return _assetSortDir === "asc" ? 1 : -1
            return 0
        })
}

function _assetUpdateSortArrows() {
    document.querySelectorAll(".assetOperationsTable .mThSort").forEach((th) => {
        const arrow = th.querySelector(".mSortArrow")
        if (!arrow) return
        if (th.dataset.sortkey === _assetSortKey) {
            arrow.textContent = _assetSortDir === "asc" ? " ▲" : " ▼"
            th.classList.add("mThActive")
        } else {
            arrow.textContent = ""
            th.classList.remove("mThActive")
        }
    })
}

function _assetBindSort(assetId) {
    document.querySelectorAll(".assetOperationsTable .mThSort").forEach((th) => {
        th.addEventListener("click", () => {
            const key = th.dataset.sortkey
            if (_assetSortKey === key) {
                _assetSortDir = _assetSortDir === "asc" ? "desc" : "asc"
            } else {
                _assetSortKey = key
                _assetSortDir = "asc"
            }
            try {
                localStorage.setItem(`tableSort_${assetId}`, JSON.stringify({ key: _assetSortKey, dir: _assetSortDir }))
            } catch {}
            renderAssetRows(_assetDisplayRows)
        })
    })
}

function renderAssetTablePage(asset) {
    const contentArea = document.getElementById("dynamicContent")
    const primaryRows = getPrimaryAssetRows(asset)
    const conversionRows = getAssetConversionRows(asset)
    const currentCurrency = String(asset.currency || "EUR")
        .trim()
        .toUpperCase()
    const targetCurrency = currentCurrency === "EUR" ? "USD" : "EUR"
    const isCrypto = isCryptoAssetType(asset.type)
    const isEtf =
        String(asset.type || "")
            .trim()
            .toLowerCase() === "etfs"

    try {
        const _saved = JSON.parse(localStorage.getItem(`tableSort_${asset.id}`))
        _assetSortKey = _saved?.key ?? null
        _assetSortDir = _saved?.dir ?? "asc"
    } catch {
        _assetSortKey = null
        _assetSortDir = "asc"
    }

    if (!contentArea) {
        return
    }

    contentArea.innerHTML = `
        <section class="assetTablePage" data-asset-id="${escapeHtml(asset.id)}" data-asset-type="${escapeHtml(asset.type)}" data-asset-name="${escapeHtml(asset.name)}" data-asset-symbol="${escapeHtml(asset.symbol)}" data-asset-price="${escapeHtml(asset.price || "0,00")}" data-asset-currency="${escapeHtml(asset.currency || "EUR")}" data-asset-change="${escapeHtml(asset.change || "+0,00%")}" data-asset-status="${escapeHtml(asset.status || "Mercado abierto")}" data-asset-last-updated="${escapeHtml(asset.lastUpdated || "")}" data-asset-market-provider="${escapeHtml(asset.marketProvider || inferMarketProviderFromSymbol(asset.marketSymbol || asset.finnhubSymbol || ""))}" data-asset-market-symbol="${escapeHtml(asset.marketSymbol || asset.finnhubSymbol || "")}" data-asset-finnhub-symbol="${escapeHtml(asset.finnhubSymbol || "")}" data-asset-color="${escapeHtml(asset.color || "")}" data-asset-tv-symbol="${escapeHtml(asset.tvSymbol || "")}">
            <div class="assetPageHeader">
                <div class="assetHeaderLeft">
                    <div class="assetTitleRow">
                        <h1 class="assetPageTitle">${escapeHtml(asset.name || asset.symbol)}</h1>
                    </div>
                    <div class="assetPageSubtitle">${escapeHtml(asset.name)} · ${buildAssetTypeLabel(asset.type)}</div>
                    <div class="assetValueRow">
                        <span class="assetValueAmount" id="assetStatNetoActual">—</span>
                    </div>
                </div>
                <div class="assetStatsPanel" id="assetStatsPanel">
                    <div class="assetStatCard">
                        <span class="assetStatLabel">Cantidad</span>
                        <span class="assetStatValue" id="assetStatCantidad">—</span>
                    </div>
                    <div class="assetStatCard">
                        <span class="assetStatLabel">Precio medio de compra</span>
                        <span class="assetStatValue" id="assetStatPrecioMedio">—</span>
                    </div>
                    <div class="assetStatCard">
                        <span class="assetStatLabel">Capital invertido</span>
                        <span class="assetStatValue" id="assetStatInvertido">—</span>
                    </div>
                    <div class="assetStatCard">
                        <span class="assetStatLabel">Ganancia / Pérdida Total</span>
                        <div class="assetStatValueRow">
                            <span class="assetStatValue" id="assetStatPnL">—</span>
                            <span class="assetStatSub" id="assetStatPnLPct">—</span>
                        </div>
                        <!-- Desglose activo/divisa. Solo aparece si el activo
                             está en otra moneda: para uno en euros el efecto
                             divisa es cero y la línea sería ruido. -->
                        <div class="assetStatDivisa hidden" id="assetStatDivisa"></div>
                    </div>
                </div>
                <div class="assetHeaderRight">
                    <button id="addAssetRowBtn" class="primaryButton assetAddRowHeaderBtn"><span class="assetBtnIcon">+</span> Añadir compra</button>
                    <div class="assetHeaderMenu">
                        <button id="assetMenuBtn" class="assetMenuTrigger" type="button" aria-label="Más opciones">⋯</button>
                        <div class="assetMenuDropdown" id="assetMenuDropdown">
                            <button id="refreshAssetMarketBtn" class="assetMenuItem assetMenuItemRefresh" type="button">
                                <span class="assetMenuIcon">↻</span>
                                <span class="assetMenuText">Actualizar cotización <span class="assetBtnProvider">(${String(asset.marketProvider || inferMarketProviderFromSymbol(asset.marketSymbol || asset.finnhubSymbol || "")).toUpperCase()})</span></span>
                            </button>
                            <button id="editAssetNameBtn" class="assetMenuItem" type="button">
                                <span class="assetMenuIcon">✎</span>
                                <span class="assetMenuText">Editar nombre del activo</span>
                            </button>
                            <div class="assetMenuCurrencyRow" id="assetCurrencyRow">
                                <span class="assetMenuCurrencyLabel"><span class="assetMenuIcon">¤</span>Moneda del activo</span>
                                <span class="assetMenuCurrencyBtns">
                                    ${["EUR", "USD", "GBP"].map((c) => `<button class="assetCurrBtn${normalizeCurrencyCode(asset.currency || "EUR") === c ? " active" : ""}" data-currency="${c}">${c}</button>`).join("")}
                                </span>
                            </div>
                            <div class="assetMenuSep"></div>
                            <button id="deleteAssetBtn" class="assetMenuItem assetMenuItemDanger" type="button">
                                <span class="assetMenuIcon">🗑</span>
                                <span class="assetMenuText">Eliminar activo</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <div class="assetTabsContainer">
                <div class="assetTabsNav">
                    <button class="assetTabBtn assetTabActive" data-tab="spot">Compras spot</button>
                    <button class="assetTabBtn hidden" id="completadasTabBtn" data-tab="completadas">Operaciones Spot</button>
                    <button class="assetTabBtn hidden" id="transaccionesTabBtn" data-tab="transacciones">Transacciones</button>
                    <button class="assetTabBtn" id="ventasTabBtn" data-tab="ventas">Ventas</button>
                    <button class="assetTabsNavAction hidden" id="assetAddVentaNavBtn" type="button"><span class="assetBtnIcon">+</span> Añadir venta</button>
                </div>
                <div class="assetTabPanel" data-tab="spot">
                    <div class="assetTableWrapper">
                        <table class="assetOperationsTable">
                            <thead>
                                <tr>
                                    <th class="mThSort" data-sortkey="fechaOperacion">Fecha operación<span class="mSortArrow"></span></th>
                                    <th class="mThSort" data-sortkey="tipoOperacion">Tipo de operación<span class="mSortArrow"></span></th>
                                    ${isCrypto ? '<th class="mThSort" data-sortkey="exchange">Exchange<span class="mSortArrow"></span></th>' : ""}
                                    <th class="mThSort" data-sortkey="participaciones">Participaciones<span class="mSortArrow"></span></th>
                                    <th class="mThSort" data-sortkey="precioParticipacion">Precio Participación<span class="mSortArrow"></span></th>
                                    ${isCrypto ? '<th class="mThSort" data-sortkey="currency">Moneda fiat<span class="mSortArrow"></span></th>' : ""}
                                    <th class="mThSort" data-sortkey="capitalInvertidoBruto">Invertido bruto<span class="mSortArrow"></span></th>
                                    ${isEtf ? '<th class="mThSort" data-sortkey="costeAnual">Coste Anual<span class="mSortArrow"></span></th>' : ""}
                                    ${isCrypto ? '<th class="mThSort" data-sortkey="comisionesCripto">Comisiones cripto<span class="mSortArrow"></span></th><th class="mThSort" data-sortkey="comisionesFiat">Comisiones fiat<span class="mSortArrow"></span></th>' : '<th class="mThSort" data-sortkey="comisiones">Comisiones<span class="mSortArrow"></span></th>'}
                                    <th class="mThSort" data-sortkey="capitalInvertidoNeto">Invertido neto<span class="mSortArrow"></span></th>
                                    <th class="rowActionsHeader"></th>
                                </tr>
                            </thead>
                            <tbody id="assetOperationsBody"></tbody>
                        </table>
                    </div>
                </div>
                <div class="assetTabPanel hidden" data-tab="completadas">
                    <div id="assetCompletedOperationsSection"></div>
                </div>
                <div class="assetTabPanel hidden" data-tab="transacciones">
                    <div id="assetTransaccionesSection"></div>
                </div>
                <div class="assetTabPanel hidden" data-tab="ventas">
                    <div id="assetVentasSection"></div>
                </div>
            </div>
        </section>
    `

    currentAssetPersistedOperationRows = Array.isArray(asset.operationRows) ? asset.operationRows : []
    currentAssetPersistedConversionRows = conversionRows
    renderAssetRows(primaryRows)
    renderAssetCompletedOperationsSection(asset)
    renderAssetTransaccionesSection(asset)
    renderAssetVentasSection(asset)
    setupAssetTabs(asset)
    _assetBindSort(asset.id)
    initAssetTableLogic(asset)

    const titleEl = document.querySelector(".assetPageTitle")
    if (titleEl) {
        titleEl.addEventListener("click", () => {
            openTVChartModal(buildTVSymbol(asset), asset.symbol || asset.name)
        })
    }
}

// Las acciones de cada pestaña viven en la propia barra de pestañas, no dentro
// del panel: así no abren una franja vacía sobre la tabla y quedan a la altura
// de "Añadir compra" de la cabecera.
function setActiveAssetTab(tab) {
    document.querySelectorAll(".assetTabBtn").forEach((b) => {
        b.classList.toggle("assetTabActive", b.dataset.tab === tab)
    })
    document.querySelectorAll(".assetTabPanel[data-tab]").forEach((p) => {
        p.classList.toggle("hidden", p.dataset.tab !== tab)
    })
    document.getElementById("assetAddVentaNavBtn")?.classList.toggle("hidden", tab !== "ventas")
}

function setupAssetTabs(asset) {
    const nav = document.querySelector(".assetTabsNav")
    if (!nav) return

    nav.addEventListener("click", (e) => {
        const btn = e.target.closest(".assetTabBtn")
        if (!btn || btn.classList.contains("hidden")) return
        setActiveAssetTab(btn.dataset.tab)
    })

    nav.querySelector("#assetAddVentaNavBtn")?.addEventListener("click", () => openAssetAddVentaModal(asset))
}

function renderAssetRows(rows) {
    _assetDisplayRows = Array.isArray(rows) ? [...rows] : []
    const assetOperationsBody = document.getElementById("assetOperationsBody")
    const assetPage = document.querySelector(".assetTablePage")
    const assetCurrency = assetPage?.dataset.assetCurrency || "EUR"
    const assetType = assetPage?.dataset.assetType || "acciones"
    const isCrypto = isCryptoAssetType(assetType)
    const isEtf =
        String(assetType || "")
            .trim()
            .toLowerCase() === "etfs"

    if (!assetOperationsBody) {
        return
    }

    assetOperationsBody.innerHTML = ""

    const sortedRows = _assetSortRows(_assetDisplayRows)
    sortedRows.forEach((rowData) => {
        const index = rowData._origIdx
        const rowElement = document.createElement("tr")
        const rowCurrency = normalizeAssetRowCurrency(rowData.currency, assetCurrency)
        const cryptoCommissionValue = parseLooseNumber(getCryptoRowCommissionCrypto(rowData))
            ? formatAssetCommissionValue(getCryptoRowCommissionCrypto(rowData))
            : ""
        const cryptoFiatCommissionValue = formatCellMoneyValue(
            getCryptoRowCommissionFiat(rowData),
            getAssetTableMoneyCurrency(assetType, "comisionesFiat", assetCurrency, rowCurrency)
        )
        const moneyMono = (val, field) =>
            formatCellMoneyValue(val, getAssetTableMoneyCurrency(assetType, field, assetCurrency, rowCurrency))
        rowElement.innerHTML = `
            <td data-field="fechaOperacion">${escapeHtml(rowData.fechaOperacion || "")}</td>
            <td data-field="tipoOperacion">${escapeHtml(rowData.tipoOperacion || "Compra")}</td>
            ${isCrypto ? `<td data-field="exchange">${escapeHtml(rowData.exchange || "")}</td>` : ""}
            <td data-field="participaciones">${formatAssetParticipationValue(rowData.participaciones, assetType)}</td>
            <td data-field="precioParticipacion">${moneyMono(rowData.precioParticipacion, "precioParticipacion")}</td>
            ${isCrypto ? `<td data-field="currency">${escapeHtml(rowCurrency)}</td>` : ""}
            <td data-field="capitalInvertidoBruto">${moneyMono(rowData.capitalInvertidoBruto, "capitalInvertidoBruto")}</td>
            ${isEtf ? `<td data-field="costeAnual">${formatCellPercentValue(rowData.costeAnual)}</td>` : ""}
            ${
                isCrypto
                    ? `<td data-field="comisionesCripto">${cryptoCommissionValue}</td><td data-field="comisionesFiat">${cryptoFiatCommissionValue}</td>`
                    : `<td data-field="comisiones">${moneyMono(rowData.comisiones, "comisiones")}</td>`
            }
            <td class="rowTotal">${formatMoney(0, getAssetTableMoneyCurrency(assetType, "capitalInvertidoNeto", assetCurrency, rowCurrency))}</td>
            <td class="rowActionsCell">
                <div class="rowMenu">
                    <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                    <div class="rowMenuDropdown">
                        <button type="button" class="rowMenuItem assetRowEditBtn avActionBtn avEditBtn" data-row-index="${index}">Editar</button>
                        <hr>
                        <button type="button" class="rowMenuItem rowMenuItemDanger assetRowDeleteBtn avActionBtn avDeleteBtn" data-row-index="${index}">Eliminar</button>
                    </div>
                </div>
            </td>
        `
        assetOperationsBody.appendChild(rowElement)
    })
    _assetUpdateSortArrows()

    updateAssetTableTotals()
}

function collectAssetRowsFromTable() {
    return _assetDisplayRows
}

function isPlaceholderValue(value, placeholders = []) {
    return placeholders.includes((value || "").trim().toLowerCase())
}

function buildCurrentAssetPayload() {
    const assetPage = document.querySelector(".assetTablePage")
    const marketSymbol = (assetPage?.dataset.assetMarketSymbol || assetPage?.dataset.assetFinnhubSymbol || "")
        .trim()
        .toUpperCase()
    const marketProvider = inferMarketProviderFromSymbol(
        marketSymbol,
        (assetPage?.dataset.assetMarketProvider || "finnhub").trim().toLowerCase()
    )

    return {
        id: currentAssetId,
        name: assetPage?.dataset.assetName || document.getElementById("detName")?.textContent.trim() || "Activo",
        symbol: assetPage?.dataset.assetSymbol || document.getElementById("detSymbol")?.textContent.trim() || "ACTIVO",
        marketProvider,
        marketSymbol,
        finnhubSymbol: marketSymbol,
        type: assetPage?.dataset.assetType || "cripto",
        price: assetPage?.dataset.assetPrice || "0,00",
        currency: assetPage?.dataset.assetCurrency || "EUR",
        change: assetPage?.dataset.assetChange || "+0,00%",
        status: assetPage?.dataset.assetStatus || "Mercado abierto",
        lastUpdated: assetPage?.dataset.assetLastUpdated || "",
        color: assetPage?.dataset.assetColor || "",
        tvSymbol: assetPage?.dataset.assetTvSymbol || "",
        operationRows: currentAssetPersistedOperationRows,
        conversionRows: currentAssetPersistedConversionRows,
        order: Number(document.querySelector(`.assetBtn[data-asset-id="${currentAssetId}"]`)?.dataset.assetOrder || 0),
        rows: collectAssetRowsFromTable()
    }
}

function updateAssetTableTotals() {
    const rowElements = document.querySelectorAll("#assetOperationsBody tr")
    const assetPage = document.querySelector(".assetTablePage")
    const assetCurrency = assetPage?.dataset.assetCurrency || "EUR"
    const assetType = assetPage?.dataset.assetType || "acciones"
    const isEtf =
        String(assetType || "")
            .trim()
            .toLowerCase() === "etfs"

    rowElements.forEach((rowElement) => {
        const rowCurrency = getAssetRowCurrency(rowElement, assetCurrency)
        const rowData = {
            participaciones: rowElement.querySelector('[data-field="participaciones"]')?.textContent || "",
            precioParticipacion: rowElement.querySelector('[data-field="precioParticipacion"]')?.textContent || "",
            capitalInvertidoBruto: rowElement.querySelector('[data-field="capitalInvertidoBruto"]')?.textContent || "",
            costeAnual: rowElement.querySelector('[data-field="costeAnual"]')?.textContent || ""
        }
        const bruto = getRowGrossAmount(rowData, assetType)
        const comisionesCell = rowElement.querySelector('[data-field="comisiones"], [data-field="comisionesFiat"]')
        const comisiones =
            parseLooseNumber(comisionesCell?.querySelector("input")?.value || comisionesCell?.textContent || "") || 0
        const neto = bruto - comisiones
        const rowTotalCell = rowElement.querySelector(".rowTotal")

        if (rowTotalCell) {
            rowTotalCell.textContent = formatMoney(
                neto,
                getAssetTableMoneyCurrency(assetType, "capitalInvertidoNeto", assetCurrency, rowCurrency)
            )
        }
    })
}

function setAssetSearchFeedback(container, message = "", isError = false) {
    if (!container) {
        return
    }

    if (!message) {
        container.textContent = ""
        container.classList.add("hidden")
        container.classList.remove("assetSearchError")
        return
    }

    container.textContent = message
    container.classList.remove("hidden")
    container.classList.toggle("assetSearchError", isError)
}

function inferMarketProviderFromSymbol(symbol, fallback = "finnhub") {
    const normalizedSymbol = String(symbol || "")
        .trim()
        .toUpperCase()
    const normalizedFallback = String(fallback || "finnhub")
        .trim()
        .toLowerCase()

    if (!normalizedSymbol) {
        return normalizedFallback || "finnhub"
    }

    if (normalizedSymbol.includes(":")) {
        return "finnhub"
    }

    const eodhdExchangeCodes = new Set([
        "XETRA",
        "PA",
        "LSE",
        "US",
        "SW",
        "AS",
        "MC",
        "MI",
        "DU",
        "BE",
        "F",
        "MU",
        "ST",
        "VI",
        "LS"
    ])

    if (normalizedSymbol.includes(".")) {
        const exchangeCode = normalizedSymbol.split(".").pop()

        if (eodhdExchangeCodes.has(exchangeCode)) {
            return "eodhd"
        }
    }

    return normalizedFallback || "finnhub"
}

function renderMarketSearchResults(container, results, onSelect) {
    if (!container) {
        return
    }

    container.innerHTML = ""

    if (!Array.isArray(results) || !results.length) {
        container.classList.add("hidden")
        return
    }

    results.forEach((result) => {
        const button = document.createElement("button")
        button.type = "button"
        button.className = "assetSearchResultBtn"
        const changeValue = String(result.change || "").trim()
        const hasQuote = String(result.price || "").trim() !== ""
        const quoteClass = changeValue.startsWith("-") ? "negative" : "positive"
        const displaySymbol = result.displaySymbol || result.symbol
        const providerLabel = String(result.provider || "")
            .trim()
            .toUpperCase()
        const metaLabel = [providerLabel, result.type || "market", result.exchange || ""].filter(Boolean).join(" · ")
        button.innerHTML = `
            <span class="assetSearchResultTitle">${escapeHtml(displaySymbol)}</span>
            <span class="assetSearchResultSubtitle">${escapeHtml(result.description)}</span>
            <span class="assetSearchResultMeta">${escapeHtml(metaLabel)}</span>
            ${
                hasQuote
                    ? `
                <span class="assetSearchResultQuoteRow">
                    <span class="assetSearchResultPrice">${escapeHtml(result.price)} ${escapeHtml(result.currency || "")}</span>
                    <span class="assetSearchResultChange ${quoteClass}">${escapeHtml(changeValue)}</span>
                </span>
            `
                    : `
                <span class="assetSearchResultQuoteEmpty">Sin cotizacion disponible</span>
            `
            }
        `
        button.addEventListener("click", () => {
            onSelect(result)
        })
        container.appendChild(button)
    })

    container.classList.remove("hidden")
}

async function handleFinnhubSearch({
    query,
    assetName = "",
    assetType = "",
    feedbackElement,
    resultsElement,
    onSelect
}) {
    const normalizedQuery = String(query || "").trim()

    if (!normalizedQuery) {
        setAssetSearchFeedback(feedbackElement, "Escribe el nombre o ticker del activo.", true)
        renderMarketSearchResults(resultsElement, [], onSelect)
        return
    }

    setAssetSearchFeedback(feedbackElement, "Buscando ticker en Finnhub...")

    try {
        const response = await searchFinnhubSymbolOnServer(normalizedQuery, { assetName, assetType })
        const results = Array.isArray(response.results) ? response.results : []

        if (!results.length) {
            setAssetSearchFeedback(feedbackElement, "No se encontraron resultados para esa búsqueda.", true)
            renderMarketSearchResults(resultsElement, [], onSelect)
            return
        }

        setAssetSearchFeedback(feedbackElement, "Selecciona el ticker correcto de Finnhub.")
        renderMarketSearchResults(resultsElement, results, onSelect)
    } catch (error) {
        console.error(error)
        setAssetSearchFeedback(feedbackElement, "No se pudo consultar Finnhub. Revisa la API key.", true)
        renderMarketSearchResults(resultsElement, [], onSelect)
    }
}

async function handleEodhdSearch({ query, assetName = "", assetType = "", feedbackElement, resultsElement, onSelect }) {
    const normalizedQuery = String(query || "").trim()

    if (!normalizedQuery) {
        setAssetSearchFeedback(feedbackElement, "Escribe el nombre o ticker del activo.", true)
        renderMarketSearchResults(resultsElement, [], onSelect)
        return
    }

    setAssetSearchFeedback(feedbackElement, "Buscando ticker en EODHD...")

    try {
        const response = await searchEodhdSymbolOnServer(normalizedQuery, { assetName, assetType })
        const results = Array.isArray(response.results) ? response.results : []

        if (!results.length) {
            setAssetSearchFeedback(feedbackElement, "No se encontraron resultados en EODHD para esa búsqueda.", true)
            renderMarketSearchResults(resultsElement, [], onSelect)
            return
        }

        setAssetSearchFeedback(feedbackElement, "Selecciona el ticker correcto de EODHD.")
        renderMarketSearchResults(resultsElement, results, onSelect)
    } catch (error) {
        console.error(error)
        setAssetSearchFeedback(feedbackElement, "No se pudo consultar EODHD. Revisa la API key.", true)
        renderMarketSearchResults(resultsElement, [], onSelect)
    }
}

async function handleYahooSearch({ query, assetName = "", assetType = "", feedbackElement, resultsElement, onSelect }) {
    const normalizedQuery = String(query || "").trim()

    if (!normalizedQuery) {
        setAssetSearchFeedback(feedbackElement, "Escribe el nombre o ticker del activo.", true)
        renderMarketSearchResults(resultsElement, [], onSelect)
        return
    }

    setAssetSearchFeedback(feedbackElement, "Buscando ticker en Yahoo Finance...")

    try {
        const response = await searchYahooSymbolOnServer(normalizedQuery, { assetName, assetType })
        const results = Array.isArray(response.results) ? response.results : []

        if (!results.length) {
            setAssetSearchFeedback(
                feedbackElement,
                "No se encontraron resultados en Yahoo Finance para esa búsqueda.",
                true
            )
            renderMarketSearchResults(resultsElement, [], onSelect)
            return
        }

        setAssetSearchFeedback(feedbackElement, "Selecciona el ticker correcto de Yahoo Finance.")
        renderMarketSearchResults(resultsElement, results, onSelect)
    } catch (error) {
        console.error(error)
        setAssetSearchFeedback(feedbackElement, extractApiErrorMessage(error), true)
        renderMarketSearchResults(resultsElement, [], onSelect)
    }
}

async function handleAlphaVantageSearch({
    query,
    assetName = "",
    assetType = "",
    feedbackElement,
    resultsElement,
    onSelect
}) {
    const normalizedQuery = String(query || "").trim()

    if (!normalizedQuery) {
        setAssetSearchFeedback(feedbackElement, "Escribe el nombre o ticker del activo.", true)
        renderMarketSearchResults(resultsElement, [], onSelect)
        return
    }

    setAssetSearchFeedback(feedbackElement, "Buscando ticker en Alpha Vantage...")

    try {
        const response = await searchAlphaVantageSymbolOnServer(normalizedQuery, { assetName, assetType })
        const results = Array.isArray(response.results) ? response.results : []

        if (!results.length) {
            setAssetSearchFeedback(
                feedbackElement,
                "No se encontraron resultados en Alpha Vantage para esa búsqueda.",
                true
            )
            renderMarketSearchResults(resultsElement, [], onSelect)
            return
        }

        setAssetSearchFeedback(feedbackElement, "Selecciona el ticker correcto de Alpha Vantage.")
        renderMarketSearchResults(resultsElement, results, onSelect)
    } catch (error) {
        console.error(error)
        setAssetSearchFeedback(feedbackElement, extractApiErrorMessage(error), true)
        renderMarketSearchResults(resultsElement, [], onSelect)
    }
}

async function refreshCurrentAssetMarketData({ feedbackElement = null, successMessage = "" } = {}) {
    if (!currentAssetId) {
        return
    }

    try {
        const payload = buildCurrentAssetPayload()
        await saveAssetDataToServer(payload)
        const response = await refreshAssetMarketDataOnServer(currentAssetId)
        await updateAssetDetail(response.asset)
        renderAssetTablePage(response.asset)
        await refreshAssetsSidebar(currentAssetId, false)

        if (feedbackElement && successMessage) {
            setAssetSearchFeedback(feedbackElement, successMessage)
        }
    } catch (error) {
        console.error(error)
        const errorMessage = extractApiErrorMessage(error)

        if (feedbackElement) {
            setAssetSearchFeedback(feedbackElement, errorMessage, true)
        } else {
            alert(errorMessage)
        }
    }
}

async function renameCurrentAsset() {
    openEditAssetModal()
}

function openEditAssetModal(assetData = null) {
    if (!currentAssetId) {
        return
    }

    _editingAsset = assetData

    const editAssetModalOverlay = document.getElementById("editAssetModalOverlay")
    const editAssetNameInput = document.getElementById("editAssetNameInput")
    const editAssetTickerInput = document.getElementById("editAssetTickerInput")
    const assetPage = document.querySelector(".assetTablePage")
    const currentName =
        assetData?.name || assetPage?.dataset.assetName || document.getElementById("detName")?.textContent.trim() || ""
    const currentColor = assetData?.color || assetPage?.dataset.assetColor || ""
    const currentTicker =
        assetData?.marketSymbol ||
        assetData?.finnhubSymbol ||
        assetPage?.dataset.assetMarketSymbol ||
        assetPage?.dataset.assetFinnhubSymbol ||
        ""

    if (!editAssetModalOverlay || !editAssetNameInput) {
        return
    }

    editAssetNameInput.value = currentName
    if (editAssetTickerInput) {
        editAssetTickerInput.value = currentTicker
        delete editAssetTickerInput.dataset.marketProvider
    }
    const editTVTickerInput = document.getElementById("editAssetTVTickerInput")
    if (editTVTickerInput)
        editTVTickerInput.value = decodeTVTicker(assetData?.tvSymbol || assetPage?.dataset.assetTvSymbol || "")
    const editAssetSearchFeedback = document.getElementById("editAssetSearchFeedback")
    const editAssetSearchResults = document.getElementById("editAssetSearchResults")
    setAssetSearchFeedback(editAssetSearchFeedback, "")
    renderMarketSearchResults(editAssetSearchResults, [], () => {})
    initColorPicker("editAssetColorPicker", "editAssetColorInput", currentColor, "editAssetColorBadge")
    setupColorPickerToggle("editAssetColorToggle", "editAssetColorPicker")
    editAssetModalOverlay.classList.remove("hidden")
    editAssetModalState = { isOpen: true }

    requestAnimationFrame(() => {
        editAssetNameInput.focus()
        editAssetNameInput.select()
    })
}

function closeEditAssetModal() {
    const editAssetModalOverlay = document.getElementById("editAssetModalOverlay")

    if (!editAssetModalOverlay) {
        return
    }

    editAssetModalOverlay.classList.add("hidden")
    editAssetModalState = null
}

async function submitEditAssetModal() {
    if (!currentAssetId) {
        return
    }

    const editAssetNameInput = document.getElementById("editAssetNameInput")

    if (!editAssetNameInput) {
        return
    }

    const payload = _editingAsset ? { ..._editingAsset } : buildCurrentAssetPayload()
    const currentName = String(payload.name || "").trim()
    const trimmedName = editAssetNameInput.value.trim()
    const newColor = document.getElementById("editAssetColorInput")?.value || ""
    const editTickerInput = document.getElementById("editAssetTickerInput")
    const newTicker = (editTickerInput?.value || "").trim().toUpperCase()
    const currentTicker = String(payload.marketSymbol || payload.finnhubSymbol || "")
        .trim()
        .toUpperCase()
    const explicitProvider = editTickerInput?.dataset.marketProvider
    const currentProvider = String(payload.marketProvider || "")
        .trim()
        .toLowerCase()
    const providerChanged = !!explicitProvider && explicitProvider !== currentProvider
    const newTVTicker = decodeTVTicker(document.getElementById("editAssetTVTickerInput")?.value)

    if (!trimmedName) {
        editAssetNameInput.focus()
        return
    }

    if (
        trimmedName === currentName &&
        newColor === (payload.color || "") &&
        newTicker === currentTicker &&
        !providerChanged &&
        newTVTicker === (payload.tvSymbol || "")
    ) {
        closeEditAssetModal()
        return
    }

    const currentSymbol = String(payload.symbol || "").trim()
    const generatedCurrentSymbol = createAssetSymbolFromName(currentName)

    payload.name = trimmedName
    payload.color = newColor
    payload.marketSymbol = newTicker
    payload.finnhubSymbol = newTicker
    payload.tvSymbol = newTVTicker
    if (explicitProvider) {
        payload.marketProvider = explicitProvider
    } else if (newTicker !== currentTicker) {
        payload.marketProvider = inferMarketProviderFromSymbol(newTicker, payload.marketProvider || "finnhub")
    }

    if (!currentSymbol || currentSymbol === generatedCurrentSymbol) {
        payload.symbol = createAssetSymbolFromName(trimmedName)
    }

    await saveAssetDataToServer(payload)
    if (currentName !== trimmedName && typeof renameCalendarioAsset === "function") {
        await renameCalendarioAsset(currentName, trimmedName)
    }
    const fromAvView = _editingAsset !== null
    closeEditAssetModal()
    const updatedAsset = await loadAssetData(currentAssetId)
    if (fromAvView) {
        const idx = _activosAllAssets.findIndex((a) => a.id === currentAssetId)
        if (idx >= 0)
            _activosAllAssets[idx] = {
                ..._activosAllAssets[idx],
                name: updatedAsset.name,
                color: updatedAsset.color,
                marketSymbol: updatedAsset.marketSymbol,
                finnhubSymbol: updatedAsset.finnhubSymbol,
                tvSymbol: updatedAsset.tvSymbol
            }
        avRender()
    } else {
        await updateAssetDetail(updatedAsset)
        renderAssetTablePage(updatedAsset)
    }
    await refreshAssetsSidebar(currentAssetId, false)
}

function scheduleAssetAutosave() {
    clearTimeout(assetAutosaveTimeout)

    assetAutosaveTimeout = setTimeout(async () => {
        if (!currentAssetId || !document.getElementById("assetOperationsBody")) {
            return
        }

        try {
            await saveAssetDataToServer(buildCurrentAssetPayload())
            await refreshAssetsSidebar(currentAssetId, false)
        } catch (error) {
            showError("No se pudo guardar el activo", error)
        }
    }, 500)
}

function openAssetRowModal(rowIndex) {
    document.getElementById("assetRowModalOverlay")?.remove()

    const assetPage = document.querySelector(".assetTablePage")
    const assetType = assetPage?.dataset.assetType || "acciones"
    const assetCurrency = assetPage?.dataset.assetCurrency || "EUR"
    const isCrypto = isCryptoAssetType(assetType)
    const isEtf =
        String(assetType || "")
            .trim()
            .toLowerCase() === "etfs"
    const isEdit = rowIndex >= 0
    const rowData = isEdit ? { ..._assetDisplayRows[rowIndex] } : {}
    const tipoVal = rowData.tipoOperacion || "Compra"

    const fieldsHtml = `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Fecha operación</label>
            <input id="arModalFecha" class="assetRowModalInput" type="text" value="${rowData.fechaOperacion || ""}" placeholder="dd-mm-aaaa">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Tipo de operación</label>
            <select id="arModalTipo" class="assetRowModalSelect">
                <option value="Compra"${tipoVal === "Compra" ? " selected" : ""}>Compra</option>
                <option value="Venta"${tipoVal === "Venta" ? " selected" : ""}>Venta</option>
            </select>
        </div>
        ${
            isCrypto
                ? `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Exchange</label>
            <input id="arModalExchange" class="assetRowModalInput" type="text" value="${rowData.exchange || ""}">
        </div>`
                : ""
        }
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Participaciones</label>
            <input id="arModalParticipaciones" class="assetRowModalInput" type="text" inputmode="decimal" value="${rowData.participaciones || ""}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Precio participación</label>
            <input id="arModalPrecio" class="assetRowModalInput" type="text" inputmode="decimal" value="${rowData.precioParticipacion || ""}">
        </div>
        ${
            isCrypto
                ? `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Moneda fiat</label>
            <select id="arModalCurrency" class="assetRowModalSelect">
                <option value="EUR"${(rowData.currency || "EUR") === "EUR" ? " selected" : ""}>EUR</option>
                <option value="USD"${(rowData.currency || "EUR") === "USD" ? " selected" : ""}>USD</option>
            </select>
        </div>`
                : ""
        }
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Capital invertido bruto</label>
            <input id="arModalCapital" class="assetRowModalInput" type="text" inputmode="decimal" value="${rowData.capitalInvertidoBruto || ""}">
        </div>
        ${
            isEtf
                ? `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Coste anual (%)</label>
            <input id="arModalCosteAnual" class="assetRowModalInput" type="text" inputmode="decimal" value="${rowData.costeAnual || ""}">
        </div>`
                : ""
        }
        ${
            isCrypto
                ? `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Comisiones cripto</label>
            <input id="arModalComisionesCripto" class="assetRowModalInput" type="text" inputmode="decimal" value="${rowData.comisionesCripto || rowData.comisionesSatoshis || ""}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Comisiones fiat</label>
            <input id="arModalComisionesFiat" class="assetRowModalInput" type="text" inputmode="decimal" value="${rowData.comisionesFiat || ""}">
        </div>`
                : `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Comisiones</label>
            <input id="arModalComisiones" class="assetRowModalInput" type="text" inputmode="decimal" value="${rowData.comisiones || ""}">
        </div>`
        }
    `

    const overlay = document.createElement("div")
    overlay.id = "assetRowModalOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"
    overlay.dataset.rowIndex = isEdit ? String(rowIndex) : "-1"

    const modal = document.createElement("div")
    modal.className = "assetModal assetRowModal"

    const title = document.createElement("h3")
    title.className = "assetModalTitle assetRowModalTitle"
    title.textContent = isEdit ? "Editar operación" : "Añadir operación"

    const fields = document.createElement("div")
    fields.className = "assetRowModalFields"
    fields.innerHTML = fieldsHtml

    const footer = document.createElement("div")
    footer.className = "assetRowModalFooter"
    footer.innerHTML = `
        ${isEdit ? `<button type="button" id="assetRowModalDeleteBtn" class="dangerButton assetRowModalDeleteBtn">Eliminar</button>` : ""}
        <button type="button" id="assetRowModalCancelBtn" class="cancelButton assetRowModalCancelBtn">Cancelar</button>
        <button type="button" id="assetRowModalSaveBtn" data-no-autohide="true" class="primaryButton assetRowModalSaveBtn">Guardar</button>
    `

    footer.querySelector("#assetRowModalSaveBtn").addEventListener("click", saveAssetRowFromModal)
    footer.querySelector("#assetRowModalCancelBtn").addEventListener("click", closeAssetRowModal)

    if (isEdit) {
        footer.querySelector("#assetRowModalDeleteBtn").addEventListener("click", () => {
            openConfirmModal({
                title: "Eliminar fila",
                message: "¿Quieres eliminar esta operación?",
                confirmLabel: "Eliminar",
                onConfirm: async () => {
                    _assetDisplayRows.splice(rowIndex, 1)
                    renderAssetRows(_assetDisplayRows)
                    scheduleAssetAutosave()
                }
            })
            closeAssetRowModal()
        })
    }

    modal.appendChild(title)
    modal.appendChild(fields)
    modal.appendChild(footer)
    overlay.appendChild(modal)

    document.body.appendChild(overlay)
}

function closeAssetRowModal() {
    document.getElementById("assetRowModalOverlay")?.remove()
}

async function saveAssetRowFromModal() {
    const overlay = document.getElementById("assetRowModalOverlay")
    const assetPage = document.querySelector(".assetTablePage")
    const assetType = assetPage?.dataset.assetType || "acciones"
    const assetCurrency = assetPage?.dataset.assetCurrency || "EUR"
    const isCrypto = isCryptoAssetType(assetType)
    const isEtf =
        String(assetType || "")
            .trim()
            .toLowerCase() === "etfs"
    const rowIndex = Number(overlay?.dataset.rowIndex ?? -1)

    const g = (id) => document.getElementById(id)?.value.trim() || ""

    const rowData = {
        fechaOperacion: g("arModalFecha"),
        tipoOperacion: g("arModalTipo") || "Compra",
        exchange: isCrypto ? g("arModalExchange") : "",
        currency: isCrypto ? g("arModalCurrency") || assetCurrency : assetCurrency,
        participaciones: g("arModalParticipaciones"),
        precioParticipacion: g("arModalPrecio"),
        capitalInvertidoBruto: g("arModalCapital"),
        costeAnual: isEtf ? g("arModalCosteAnual") : "",
        comisiones: !isCrypto ? g("arModalComisiones") : "",
        comisionesFiat: isCrypto ? g("arModalComisionesFiat") : "",
        comisionesCripto: isCrypto ? g("arModalComisionesCripto") : "",
        comisionesSatoshis: isCrypto ? g("arModalComisionesCripto") : ""
    }

    if (rowIndex >= 0) {
        _assetDisplayRows[rowIndex] = rowData
    } else {
        _assetDisplayRows.push(rowData)
    }

    renderAssetRows(_assetDisplayRows)
    closeAssetRowModal()
    scheduleAssetAutosave()
}

function initAssetTableLogic(asset) {
    currentAssetId = asset.id

    const assetOperationsBody = document.getElementById("assetOperationsBody")
    const addAssetRowButton = document.getElementById("addAssetRowBtn")
    const refreshAssetMarketButton = document.getElementById("refreshAssetMarketBtn")
    const editAssetNameButton = document.getElementById("editAssetNameBtn")
    const deleteAssetButton = document.getElementById("deleteAssetBtn")
    const assetMenuBtn = document.getElementById("assetMenuBtn")
    const assetMenuDropdown = document.getElementById("assetMenuDropdown")

    if (assetMenuBtn && assetMenuDropdown) {
        assetMenuBtn.addEventListener("click", (e) => {
            e.stopPropagation()
            const isOpen = assetMenuDropdown.classList.contains("open")
            assetMenuDropdown.classList.toggle("open", !isOpen)
            assetMenuBtn.classList.toggle("active", !isOpen)
        })
        assetMenuDropdown.addEventListener("click", () => {
            assetMenuDropdown.classList.remove("open")
            assetMenuBtn.classList.remove("active")
        })
        document.addEventListener("click", (e) => {
            if (!assetMenuBtn.contains(e.target) && !assetMenuDropdown.contains(e.target)) {
                assetMenuDropdown.classList.remove("open")
                assetMenuBtn.classList.remove("active")
            }
        })
    }

    document.querySelectorAll("#assetCurrencyRow .assetCurrBtn").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
            e.stopPropagation()
            const currency = btn.dataset.currency
            if (!currentAssetId) return
            btn.disabled = true

            try {
                // Guardar antes: el servidor convierte a partir de lo que hay
                // almacenado, así que la tabla en pantalla debe estar volcada.
                await saveAssetDataToServer(buildCurrentAssetPayload())
                await changeAssetCurrencyOnServer(currentAssetId, currency)
            } catch (error) {
                console.error(error)
                alert(extractApiErrorMessage(error))
                btn.disabled = false
                return
            }

            btn.disabled = false
            document.querySelectorAll("#assetCurrencyRow .assetCurrBtn").forEach((b) => {
                b.classList.toggle("active", b.dataset.currency === currency)
            })
            setTimeout(() => {
                document.getElementById("assetMenuDropdown")?.classList.remove("open")
                document.getElementById("assetMenuBtn")?.classList.remove("active")
            }, 350)
            const freshAsset = await loadAssetData(currentAssetId)
            if (freshAsset) {
                await updateAssetDetail(freshAsset)
                renderAssetTablePage(freshAsset)
                await refreshAssetsSidebar(currentAssetId, false)
            }
        })
    })

    buildOverviewRow(asset).then((summary) => {
        if (document.querySelector(".assetTablePage")?.dataset.assetId !== asset.id) return
        const currency = summary.currency
        const pnl = summary.rendimiento
        const pnlPct = summary.invertidoNeto > 0 ? (pnl / summary.invertidoNeto) * 100 : 0
        const netoEl = document.getElementById("assetStatNetoActual")
        const cantidadEl = document.getElementById("assetStatCantidad")
        const precioMedioEl = document.getElementById("assetStatPrecioMedio")
        const invertidoEl = document.getElementById("assetStatInvertido")
        const pnlEl = document.getElementById("assetStatPnL")
        const pnlPctEl = document.getElementById("assetStatPnLPct")
        if (netoEl) netoEl.textContent = formatMoney(summary.netoActual, currency)
        if (cantidadEl) cantidadEl.textContent = formatAssetParticipationValue(summary.participaciones, asset.type)
        if (precioMedioEl) precioMedioEl.textContent = formatMoney(summary.promedioCompra, currency)
        if (invertidoEl) invertidoEl.textContent = formatMoney(summary.invertidoNeto, currency)
        if (pnlEl) {
            pnlEl.textContent = (pnl >= 0 ? "+" : "") + formatMoney(pnl, currency)
            pnlEl.classList.toggle("assetStatPositive", pnl > 0)
            pnlEl.classList.toggle("assetStatNegative", pnl < 0)
        }
        if (pnlPctEl) {
            pnlPctEl.textContent = (pnlPct >= 0 ? "▲ " : "▼ ") + Math.abs(pnlPct).toFixed(2) + "%"
            pnlPctEl.classList.toggle("assetStatPositive", pnlPct > 0)
            pnlPctEl.classList.toggle("assetStatNegative", pnlPct < 0)
        }
        renderAssetDivisaBreakdown(asset.id)
    })

    if (assetOperationsBody) {
        assetOperationsBody.addEventListener("click", (event) => {
            const editBtn = event.target.closest(".assetRowEditBtn")
            const deleteBtn = event.target.closest(".assetRowDeleteBtn")

            if (editBtn) {
                const idx = Number(editBtn.dataset.rowIndex)
                openAssetRowModal(idx)
                return
            }

            if (deleteBtn) {
                const idx = Number(deleteBtn.dataset.rowIndex)
                const row = _assetDisplayRows[idx]
                const isEmpty = !row || (!row.fechaOperacion && !row.participaciones && !row.capitalInvertidoBruto)

                if (isEmpty) {
                    _assetDisplayRows.splice(idx, 1)
                    renderAssetRows(_assetDisplayRows)
                    scheduleAssetAutosave()
                } else {
                    openConfirmModal({
                        title: "Eliminar fila",
                        message: "Esta fila tiene contenido. ¿Quieres eliminarla?",
                        confirmLabel: "Eliminar",
                        onConfirm: async () => {
                            _assetDisplayRows.splice(idx, 1)
                            renderAssetRows(_assetDisplayRows)
                            scheduleAssetAutosave()
                        }
                    })
                }
            }
        })
    }

    if (addAssetRowButton) {
        addAssetRowButton.addEventListener("click", () => {
            openAssetRowModal(-1)
        })
    }

    if (refreshAssetMarketButton) {
        refreshAssetMarketButton.addEventListener("click", async () => {
            await refreshCurrentAssetMarketData()
        })
    }

    if (editAssetNameButton) {
        editAssetNameButton.addEventListener("click", async () => {
            try {
                await renameCurrentAsset()
            } catch (error) {
                console.error(error)
                alert("No se pudo actualizar el nombre del activo.")
            }
        })
    }

    if (deleteAssetButton) {
        deleteAssetButton.addEventListener("click", () => {
            const rows = collectAssetRowsFromTable()
            const hasContent = rows.some((row) => {
                return (
                    row.fechaOperacion.trim() !== "" ||
                    !isPlaceholderValue(row.tipoOperacion, ["", "compra"]) ||
                    row.exchange.trim() !== "" ||
                    row.participaciones.trim() !== "" ||
                    parseLooseNumber(row.precioParticipacion) !== 0 ||
                    parseLooseNumber(row.capitalInvertidoBruto) !== 0 ||
                    parseLooseNumber(row.comisiones) !== 0 ||
                    parseLooseNumber(row.comisionesFiat) !== 0 ||
                    parseLooseNumber(row.comisionesCripto) !== 0
                )
            })

            const detailAssetName = _activosAllAssets.find((a) => a.id === currentAssetId)?.name || currentAssetId
            openConfirmModal({
                title: "Eliminar activo",
                message: hasContent
                    ? `"${detailAssetName}" tiene contenido guardado. ¿Quieres eliminarlo igualmente?`
                    : `¿Quieres eliminar "${detailAssetName}"?`,
                confirmLabel: "Sí, eliminar",
                confirmSide: "right",
                onConfirm: () => {
                    openConfirmModal({
                        title: "¿Estás seguro?",
                        message: `Esta acción eliminará "${detailAssetName}" de forma definitiva y no se puede deshacer.`,
                        confirmLabel: "Sí, estoy seguro",
                        confirmSide: "right",
                        onConfirm: () => {
                            openDeleteTypeConfirm(detailAssetName, async () => {
                                await deleteAssetOnServer(currentAssetId)
                                currentAssetId = null
                                const contentArea = document.getElementById("dynamicContent")
                                if (contentArea) {
                                    contentArea.innerHTML = `<div class="placeholderPage">Activo eliminado.</div>`
                                }
                                await refreshAssetsSidebar(null, false)
                            })
                        }
                    })
                }
            })
        })
    }
}

function initAssetTypeCustomSelect() {
    const select = document.getElementById("assetTypeSelect")
    if (!select || select._assetCsInit) return
    select._assetCsInit = true

    const wrapper = select.parentNode
    select.style.display = "none"

    const trigger = document.createElement("div")
    trigger.className = "csTrigger assetModalCsTrigger"

    const label = document.createElement("span")
    label.className = "csLabel"

    const arrow = document.createElement("span")
    arrow.className = "csArrow"
    arrow.textContent = "▾"

    trigger.appendChild(label)
    trigger.appendChild(arrow)
    wrapper.insertBefore(trigger, select.nextSibling)

    const menu = document.createElement("div")
    menu.className = "csMenu"
    document.body.appendChild(menu)

    function syncLabel() {
        const opt = select.options[select.selectedIndex]
        label.textContent = opt ? opt.text : ""
    }

    function buildOptions() {
        menu.innerHTML = ""
        Array.from(select.options).forEach((opt) => {
            const item = document.createElement("div")
            item.className = "csOption" + (opt.selected ? " csSelected" : "")
            item.textContent = opt.text
            item.addEventListener("mousedown", (e) => {
                e.preventDefault()
                select.value = opt.value
                select.dispatchEvent(new Event("change", { bubbles: true }))
                syncLabel()
                closeMenu()
            })
            menu.appendChild(item)
        })
    }

    function closeMenu() {
        menu.classList.remove("csOpen")
        trigger.classList.remove("csOpen")
    }

    function openMenu() {
        buildOptions()
        const rect = trigger.getBoundingClientRect()
        menu.style.position = "fixed"
        menu.style.left = Math.round(rect.left) + "px"
        menu.style.width = Math.round(rect.width) + "px"
        menu.style.visibility = "hidden"
        menu.style.display = "flex"
        const menuH = Math.min(menu.scrollHeight, 220)
        menu.style.visibility = ""
        menu.style.display = ""
        const spaceBelow = window.innerHeight - rect.bottom - 8
        menu.style.top =
            spaceBelow >= menuH || rect.top < menuH
                ? Math.round(rect.bottom) + "px"
                : Math.round(rect.top - menuH) + "px"
        menu.classList.add("csOpen")
        trigger.classList.add("csOpen")
    }

    trigger.addEventListener("click", (e) => {
        e.stopPropagation()
        if (menu.classList.contains("csOpen")) {
            closeMenu()
        } else {
            openMenu()
        }
    })

    document.addEventListener("click", closeMenu)

    select.addEventListener("change", () => {
        syncLabel()
        buildOptions()
    })

    syncLabel()
    buildOptions()
}

function openAssetModal() {
    const assetModalOverlay = document.getElementById("assetModalOverlay")
    const assetNameInput = document.getElementById("assetNameInput")
    const assetTypeSelect = document.getElementById("assetTypeSelect")
    const assetTickerInput = document.getElementById("assetTickerInput")
    const assetSearchFeedback = document.getElementById("assetSearchFeedback")
    const assetSearchResults = document.getElementById("assetSearchResults")

    if (
        !assetModalOverlay ||
        !assetNameInput ||
        !assetTypeSelect ||
        !assetTickerInput ||
        !assetSearchFeedback ||
        !assetSearchResults
    ) {
        return
    }

    assetNameInput.value = ""
    assetTypeSelect.value = "cripto"
    assetTypeSelect.dispatchEvent(new Event("change", { bubbles: true }))
    assetTickerInput.value = ""
    assetTickerInput.dataset.marketProvider = ""
    const tvTickerInput = document.getElementById("assetTVTickerInput")
    if (tvTickerInput) tvTickerInput.value = ""
    setAssetSearchFeedback(assetSearchFeedback, "")
    renderMarketSearchResults(assetSearchResults, [], () => {})
    initColorPicker("assetColorPicker", "assetColorInput", ASSET_COLOR_PALETTE[0], "assetColorBadge")
    setupColorPickerToggle("assetColorToggle", "assetColorPicker")
    assetModalOverlay.classList.remove("hidden")
    assetModalState = { isOpen: true }
    requestAnimationFrame(() => initAssetTypeCustomSelect())

    queueMicrotask(() => {
        assetTypeSelect.dispatchEvent(new Event("change", { bubbles: true }))
    })

    assetNameInput.focus()
}

function closeAssetModal() {
    const assetModalOverlay = document.getElementById("assetModalOverlay")

    if (!assetModalOverlay) {
        return
    }

    assetModalOverlay.classList.add("hidden")
    assetModalState = null
}

// Centra el diálogo sobre el área de contenido (#dynamicContent) manteniendo el fondo a pantalla completa.
function alignConfirmModalToContent() {
    const confirmModalOverlay = document.getElementById("confirmModalOverlay")
    const contentArea = document.getElementById("dynamicContent")

    if (!confirmModalOverlay || confirmModalOverlay.classList.contains("hidden")) {
        return
    }

    if (!contentArea) {
        confirmModalOverlay.style.padding = ""
        return
    }

    const rect = contentArea.getBoundingClientRect()

    if (rect.width <= 0 || rect.height <= 0) {
        confirmModalOverlay.style.padding = ""
        return
    }

    const top = Math.max(0, rect.top)
    const right = Math.max(0, window.innerWidth - rect.right)
    const bottom = Math.max(0, window.innerHeight - rect.bottom)
    const left = Math.max(0, rect.left)

    confirmModalOverlay.style.padding = `${top}px ${right}px ${bottom}px ${left}px`
}

function openConfirmModal({
    title = "Confirmar acción",
    message = "¿Seguro que quieres continuar?",
    confirmLabel = "Confirmar",
    onConfirm,
    confirmSide = "left"
}) {
    const confirmModalOverlay = document.getElementById("confirmModalOverlay")
    const confirmModalTitle = document.getElementById("confirmModalTitle")
    const confirmModalMessage = document.getElementById("confirmModalMessage")
    const confirmModalAcceptButton = document.getElementById("confirmModalAcceptBtn")
    const confirmModalActions = document.querySelector(".confirmModalActions")

    if (
        !confirmModalOverlay ||
        !confirmModalTitle ||
        !confirmModalMessage ||
        !confirmModalAcceptButton ||
        !confirmModalActions
    ) {
        return
    }

    confirmModalTitle.textContent = title
    confirmModalMessage.textContent = message
    confirmModalAcceptButton.textContent = confirmLabel
    confirmModalActions.classList.toggle("confirmPrimaryRight", confirmSide === "right")
    confirmModalOverlay.classList.remove("hidden")
    alignConfirmModalToContent()
    confirmModalState = { onConfirm }
}

function closeConfirmModal() {
    const confirmModalOverlay = document.getElementById("confirmModalOverlay")

    if (!confirmModalOverlay) {
        return
    }

    confirmModalOverlay.classList.add("hidden")
    confirmModalOverlay.style.padding = ""
    document.querySelector(".confirmModalActions")?.classList.remove("confirmPrimaryRight")
    document.getElementById("confirmModalCancelBtn")?.classList.remove("hidden")
    confirmModalState = null
}

function showAlert(message, title = "Aviso") {
    const cancelBtn = document.getElementById("confirmModalCancelBtn")
    if (cancelBtn) cancelBtn.classList.add("hidden")
    openConfirmModal({
        title,
        message,
        confirmLabel: "Aceptar",
        confirmSide: "right",
        onConfirm: null
    })
}

function initConfirmModal(confirmModalOverlay, confirmModalAcceptButton, confirmModalCancelButton) {
    if (confirmModalAcceptButton) {
        confirmModalAcceptButton.addEventListener("click", async () => {
            const onConfirm = confirmModalState?.onConfirm
            closeConfirmModal()

            if (onConfirm) {
                await onConfirm()
            }
        })
    }

    if (confirmModalCancelButton) {
        confirmModalCancelButton.addEventListener("click", () => {
            closeConfirmModal()
        })
    }

    if (confirmModalOverlay) {
        confirmModalOverlay.addEventListener("click", (event) => {
            if (event.target === confirmModalOverlay) {
                closeConfirmModal()
            }
        })
    }

    window.addEventListener("resize", alignConfirmModalToContent)
}

async function submitAssetModal() {
    const assetNameInput = document.getElementById("assetNameInput")
    const assetTypeSelect = document.getElementById("assetTypeSelect")
    const assetTickerInput = document.getElementById("assetTickerInput")
    const assetSearchFeedback = document.getElementById("assetSearchFeedback")

    if (!assetNameInput || !assetTypeSelect || !assetTickerInput || !assetSearchFeedback) {
        return
    }

    const name = assetNameInput.value.trim()
    const type = assetTypeSelect.value.trim()
    const marketSymbol = assetTickerInput.value.trim().toUpperCase()
    const explicitProvider = assetTickerInput.dataset.marketProvider
    const marketProvider = explicitProvider || inferMarketProviderFromSymbol(marketSymbol, "finnhub")
    const color = document.getElementById("assetColorInput")?.value || ASSET_COLOR_PALETTE[0]
    const tvSymbol = decodeTVTicker(document.getElementById("assetTVTickerInput")?.value)

    if (!name) {
        setAssetSearchFeedback(assetSearchFeedback, "Introduce el nombre del activo.", true)
        assetNameInput.focus()
        return
    }

    if (!type) {
        setAssetSearchFeedback(assetSearchFeedback, "Selecciona el tipo de activo.", true)
        assetTypeSelect.focus()
        return
    }

    if (!marketSymbol) {
        setAssetSearchFeedback(assetSearchFeedback, "Introduce o selecciona el ticker de mercado.", true)
        assetTickerInput.focus()
        return
    }

    try {
        setAssetSearchFeedback(assetSearchFeedback, "")
        const response = await createAssetOnServer(name, type, marketSymbol, marketProvider, color, tvSymbol)
        const createdAsset = response.asset
        closeAssetModal()
        currentAssetId = createdAsset.id
        await refreshAssetsSidebar(createdAsset.id, true)
    } catch (error) {
        console.error(error)
        const detail = error?.serverMessage ? ` ${error.serverMessage}.` : ""
        setAssetSearchFeedback(assetSearchFeedback, `No se pudo crear el activo.${detail}`, true)
    }
}

function initEditAssetModal() {
    const editAssetModalOverlay = document.getElementById("editAssetModalOverlay")
    const editAssetNameInput = document.getElementById("editAssetNameInput")
    const editAssetTickerInput = document.getElementById("editAssetTickerInput")
    const confirmEditAssetModalButton = document.getElementById("confirmEditAssetModalBtn")
    const cancelEditAssetModalButton = document.getElementById("cancelEditAssetModalBtn")
    const editSearchFinnhubButton = document.getElementById("editSearchAssetTickerFinnhubBtn")
    const editSearchEodhdButton = document.getElementById("editSearchAssetTickerEodhdBtn")
    const editSearchYahooButton = document.getElementById("editSearchAssetTickerYahooBtn")
    const editSearchAlphaVantageButton = document.getElementById("editSearchAssetTickerAlphaVantageBtn")
    const editAssetSearchFeedback = document.getElementById("editAssetSearchFeedback")
    const editAssetSearchResults = document.getElementById("editAssetSearchResults")

    if (confirmEditAssetModalButton) {
        confirmEditAssetModalButton.addEventListener("click", async () => {
            try {
                await submitEditAssetModal()
            } catch (error) {
                console.error(error)
                alert("No se pudo actualizar el nombre del activo.")
            }
        })
    }

    if (cancelEditAssetModalButton) {
        cancelEditAssetModalButton.addEventListener("click", () => {
            closeEditAssetModal()
        })
    }

    if (editAssetNameInput) {
        editAssetNameInput.addEventListener("keydown", async (event) => {
            if (event.key === "Enter") {
                event.preventDefault()

                try {
                    await submitEditAssetModal()
                } catch (error) {
                    console.error(error)
                    alert("No se pudo actualizar el nombre del activo.")
                }
            }
        })
    }

    const runEditTickerSelection = (result, providerName) => {
        if (editAssetTickerInput) {
            editAssetTickerInput.value = result.symbol
            editAssetTickerInput.dataset.marketProvider = String(result.provider || providerName)
                .trim()
                .toLowerCase()
        }
        setAssetSearchFeedback(editAssetSearchFeedback, `Ticker seleccionado (${providerName}): ${result.symbol}`)
        renderMarketSearchResults(editAssetSearchResults, [], () => {})
    }

    if (editSearchFinnhubButton) {
        editSearchFinnhubButton.addEventListener("click", async () => {
            const typedTicker = editAssetTickerInput?.value.trim() || ""
            const typedName = editAssetNameInput?.value.trim() || ""
            const searchQuery = typedTicker || typedName

            await handleFinnhubSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: "",
                feedbackElement: editAssetSearchFeedback,
                resultsElement: editAssetSearchResults,
                onSelect: (result) => runEditTickerSelection(result, "Finnhub")
            })
        })
    }

    if (editSearchEodhdButton) {
        editSearchEodhdButton.addEventListener("click", async () => {
            const typedTicker = editAssetTickerInput?.value.trim() || ""
            const typedName = editAssetNameInput?.value.trim() || ""
            const searchQuery = typedTicker || typedName

            await handleEodhdSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: "",
                feedbackElement: editAssetSearchFeedback,
                resultsElement: editAssetSearchResults,
                onSelect: (result) => runEditTickerSelection(result, "EODHD")
            })
        })
    }

    if (editSearchYahooButton) {
        editSearchYahooButton.addEventListener("click", async () => {
            const typedTicker = editAssetTickerInput?.value.trim() || ""
            const typedName = editAssetNameInput?.value.trim() || ""
            const searchQuery = typedTicker || typedName

            await handleYahooSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: "",
                feedbackElement: editAssetSearchFeedback,
                resultsElement: editAssetSearchResults,
                onSelect: (result) => runEditTickerSelection(result, "Yahoo Finance")
            })
        })
    }

    if (editSearchAlphaVantageButton) {
        editSearchAlphaVantageButton.addEventListener("click", async () => {
            const typedTicker = editAssetTickerInput?.value.trim() || ""
            const typedName = editAssetNameInput?.value.trim() || ""
            const searchQuery = typedTicker || typedName

            await handleAlphaVantageSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: "",
                feedbackElement: editAssetSearchFeedback,
                resultsElement: editAssetSearchResults,
                onSelect: (result) => runEditTickerSelection(result, "Alpha Vantage")
            })
        })
    }
}

function initAddAssetButton(addAssetButton) {
    if (!addAssetButton) {
        return
    }

    addAssetButton.addEventListener("click", () => {
        openAssetModal()
    })
}

function initAssetModal(
    assetModalOverlay,
    confirmAssetModalButton,
    cancelAssetModalButton,
    assetNameInput,
    assetTypeSelect,
    assetTickerInput,
    searchAssetTickerFinnhubButton,
    searchAssetTickerEodhdButton,
    searchAssetTickerYahooButton,
    searchAssetTickerAlphaVantageButton
) {
    const assetSearchFeedback = document.getElementById("assetSearchFeedback")
    const assetSearchResults = document.getElementById("assetSearchResults")
    initEditAssetModal()

    if (confirmAssetModalButton) {
        confirmAssetModalButton.addEventListener("click", async () => {
            await submitAssetModal()
        })
    }

    if (cancelAssetModalButton) {
        cancelAssetModalButton.addEventListener("click", () => {
            closeAssetModal()
        })
    }

    if (assetNameInput) {
        assetNameInput.addEventListener("keydown", async (event) => {
            if (event.key === "Enter") {
                event.preventDefault()
                await submitAssetModal()
            }
        })
    }

    if (assetTypeSelect) {
        assetTypeSelect.addEventListener("keydown", async (event) => {
            if (event.key === "Enter") {
                event.preventDefault()
                await submitAssetModal()
            }
        })
    }

    if (assetTickerInput) {
        assetTickerInput.addEventListener("keydown", async (event) => {
            if (event.key === "Enter") {
                event.preventDefault()
                await submitAssetModal()
            }
        })
    }

    const runTickerSelection = (result, providerName) => {
        if (assetTickerInput) {
            assetTickerInput.value = result.symbol
            assetTickerInput.dataset.marketProvider = String(result.provider || providerName)
                .trim()
                .toLowerCase()
        }

        if (assetNameInput && !assetNameInput.value.trim()) {
            assetNameInput.value = result.description
        }

        setAssetSearchFeedback(assetSearchFeedback, `Ticker seleccionado (${providerName}): ${result.symbol}`)
        renderMarketSearchResults(assetSearchResults, [], () => {})
    }

    if (searchAssetTickerFinnhubButton) {
        searchAssetTickerFinnhubButton.addEventListener("click", async () => {
            const typedTicker = assetTickerInput?.value.trim() || ""
            const typedName = assetNameInput?.value.trim() || ""
            const searchQuery = typedName || typedTicker

            await handleFinnhubSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: assetTypeSelect?.value || "",
                feedbackElement: assetSearchFeedback,
                resultsElement: assetSearchResults,
                onSelect: (result) => runTickerSelection(result, "Finnhub")
            })
        })
    }

    if (searchAssetTickerEodhdButton) {
        searchAssetTickerEodhdButton.addEventListener("click", async () => {
            const typedTicker = assetTickerInput?.value.trim() || ""
            const typedName = assetNameInput?.value.trim() || ""
            const searchQuery = typedName || typedTicker

            await handleEodhdSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: assetTypeSelect?.value || "",
                feedbackElement: assetSearchFeedback,
                resultsElement: assetSearchResults,
                onSelect: (result) => runTickerSelection(result, "EODHD")
            })
        })
    }

    if (searchAssetTickerYahooButton) {
        searchAssetTickerYahooButton.addEventListener("click", async () => {
            const typedTicker = assetTickerInput?.value.trim() || ""
            const typedName = assetNameInput?.value.trim() || ""
            const searchQuery = typedName || typedTicker

            await handleYahooSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: assetTypeSelect?.value || "",
                feedbackElement: assetSearchFeedback,
                resultsElement: assetSearchResults,
                onSelect: (result) => runTickerSelection(result, "Yahoo Finance")
            })
        })
    }

    if (searchAssetTickerAlphaVantageButton) {
        searchAssetTickerAlphaVantageButton.addEventListener("click", async () => {
            const typedTicker = assetTickerInput?.value.trim() || ""
            const typedName = assetNameInput?.value.trim() || ""
            const searchQuery = typedName || typedTicker

            await handleAlphaVantageSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: assetTypeSelect?.value || "",
                feedbackElement: assetSearchFeedback,
                resultsElement: assetSearchResults,
                onSelect: (result) => runTickerSelection(result, "Alpha Vantage")
            })
        })
    }

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && assetModalState?.isOpen) {
            closeAssetModal()
            return
        }

        if (event.key === "Escape" && editAssetModalState?.isOpen) {
            closeEditAssetModal()
            return
        }

        if (event.key === "Escape" && confirmModalState) {
            closeConfirmModal()
        }
    })
}

// ── Página Activos ─────────────────────────────────────────────────────────

const AV_TYPE_COLORS = {
    cripto: "#f7931a",
    acciones: "#3a7bd5",
    etfs: "#2ecc71",
    comoditis: "#e0c068"
}
const AV_TYPE_LABELS = {
    cripto: "Cripto",
    acciones: "Acciones",
    etfs: "ETFs",
    comoditis: "Comoditis"
}

let _activosAllAssets = []
let _activosFilterType = "all"
let _activosSearch = ""
let _activosViewMode = localStorage.getItem("activosViewMode") || "cards"
let _activosShowHidden = false

function avIsOculto(a) {
    return a.hidden || ((a.invertidoNeto ?? 1) === 0 && (a.rendimiento ?? 0) === 0)
}

function avFilteredAssets() {
    return _activosAllAssets.filter((a) => {
        if (avIsOculto(a) && !_activosShowHidden) return false
        const matchType = _activosFilterType === "all" || _activosFilterType.includes(a.type)
        const q = _activosSearch.toLowerCase()
        const matchSearch = !q || (a.name || "").toLowerCase().includes(q) || (a.symbol || "").toLowerCase().includes(q)
        return matchType && matchSearch
    })
}

async function avToggleAssetHidden(assetId) {
    const asset = _activosAllAssets.find((a) => a.id === assetId)
    if (!asset) return
    asset.hidden = !asset.hidden
    try {
        const full = await loadAssetData(assetId)
        full.hidden = asset.hidden
        await saveAssetDataToServer(full)
    } catch (err) {
        asset.hidden = !asset.hidden
        console.error("Error guardando estado oculto:", err)
        return
    }
    avRender()
    // El sidebar lee el mismo flag: se repinta ya para no arrastrar el activo
    // oculto en la lista ni en la ficha de detalle hasta la siguiente carga.
    await refreshAssetsSidebar()
}

function avBuildCard(asset) {
    const color = AV_TYPE_COLORS[asset.type] || "#888"
    const typeLabel = AV_TYPE_LABELS[asset.type] || asset.type || ""
    const price = parseLooseNumber(asset.price || "") || 0
    const currency = asset.currency || "EUR"
    const provider = String(
        asset.marketProvider || inferMarketProviderFromSymbol(asset.marketSymbol || asset.finnhubSymbol || "") || ""
    ).toUpperCase()
    const ticker = asset.marketSymbol || asset.finnhubSymbol || ""

    const m = asset._metrics
    const hasM = !!m
    const rClass = hasM ? (m.rendimientoEur >= 0 ? "avPos" : "avNeg") : ""
    const rendSign = hasM ? (m.rendimientoEur >= 0 ? "+" : "") : ""
    const avgPriceStr = hasM && m.promedioCompra > 0 ? formatMoney(m.promedioCompra, m.currency || currency) : "—"

    let lastUpdatedStr = "—"
    if (asset.lastUpdated) {
        const d = new Date(asset.lastUpdated)
        if (!isNaN(d)) {
            const hh = String(d.getHours()).padStart(2, "0")
            const mm = String(d.getMinutes()).padStart(2, "0")
            const dd = String(d.getDate()).padStart(2, "0")
            const mo = String(d.getMonth() + 1).padStart(2, "0")
            lastUpdatedStr = `${dd}/${mo} ${hh}:${mm}`
        }
    }

    const card = document.createElement("div")
    card.className = `avCard${avIsOculto(asset) ? " avHidden" : ""}`
    card.dataset.assetId = asset.id
    card.style.setProperty("--av-color", color)
    card.draggable = true

    const assetColor = asset.color || ""
    card.innerHTML = `
        <div class="avCardTop">
            <span class="avBadge" style="background:${color}22;color:${color};border-color:${color}44">${typeLabel}</span>
            <div class="avCardActions">
                ${assetColor ? `<span class="avColorDot" style="background:${assetColor};--dot-color:${assetColor}" title="Color del activo"></span>` : ""}
                <div class="rowMenu">
                    <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                    <div class="rowMenuDropdown">
                        <button type="button" class="rowMenuItem avActionBtn avEditBtn" data-asset-id="${asset.id}">Editar</button>
                        <button type="button" class="rowMenuItem avActionBtn avHideBtn" data-asset-id="${asset.id}">${asset.hidden ? "Mostrar" : "Ocultar"}</button>
                        <hr>
                        <button type="button" class="rowMenuItem rowMenuItemDanger avActionBtn avDeleteBtn" data-asset-id="${asset.id}">Eliminar</button>
                    </div>
                </div>
            </div>
        </div>
        <div class="avCardSymbol">${escapeHtml(asset.symbol || asset.name)}</div>
        <div class="avCardName">${escapeHtml(asset.name || asset.symbol || "Activo")}</div>
        <div class="avCardPrice">${formatMoney(price, currency)}</div>
        <div class="avCardTicker">${provider || "Sin ticker"}</div>
        <div class="avCardMetrics">
            <div class="avMetricItem">
                <span class="avMetricLabel">Posición</span>
                <span class="avMetricValue">${hasM ? formatShareQuantity(m.participaciones) : "—"}</span>
            </div>
            <div class="avMetricItem">
                <span class="avMetricLabel">Valor actual</span>
                <span class="avMetricValue">${hasM ? formatEuro(m.netoActualEur) : "—"}</span>
            </div>
            <div class="avMetricItem">
                <span class="avMetricLabel">P. medio compra</span>
                <span class="avMetricValue">${avgPriceStr}</span>
            </div>
            <div class="avMetricItem">
                <span class="avMetricLabel">Rendimiento</span>
                <span class="avMetricValue ${rClass}">${hasM ? rendSign + formatEuro(m.rendimientoEur) + (m.invertidoEur > 0 ? "<br><small>" + rendSign + ((m.rendimientoEur / m.invertidoEur) * 100).toFixed(2) + " %</small>" : "") : "—"}</span>
            </div>
        </div>
        <div class="avCardUpdated">Actualizado: ${lastUpdatedStr}</div>
        <div class="avCardBar" style="background:${color}"></div>
    `

    return card
}

function avRenderGrid() {
    const grid = document.getElementById("activosGrid")
    const count = document.getElementById("activosCount")
    if (!grid) return

    const filtered = avFilteredAssets()
    if (count) count.textContent = `${filtered.length} activo${filtered.length !== 1 ? "s" : ""}`

    const activosGridEmpty = document.getElementById("activosGridEmpty")
    grid.innerHTML = ""

    if (!filtered.length) {
        if (activosGridEmpty) activosGridEmpty.classList.remove("hidden")
        return
    }

    if (activosGridEmpty) activosGridEmpty.classList.add("hidden")
    const frag = document.createDocumentFragment()
    filtered.forEach((a) => frag.appendChild(avBuildCard(a)))
    grid.appendChild(frag)
}

function avBuildTableRow(asset) {
    const color = AV_TYPE_COLORS[asset.type] || "#888"
    const typeLabel = AV_TYPE_LABELS[asset.type] || asset.type || ""
    const price = parseLooseNumber(asset.price || "") || 0
    const currency = asset.currency || "EUR"
    const provider = String(
        asset.marketProvider || inferMarketProviderFromSymbol(asset.marketSymbol || asset.finnhubSymbol || "") || ""
    ).toUpperCase()

    const m = asset._metrics
    const hasM = !!m
    const rClass = hasM ? (m.rendimientoEur >= 0 ? "avPos" : "avNeg") : ""
    const rendSign = hasM ? (m.rendimientoEur >= 0 ? "+" : "") : ""
    const avgPriceStr = hasM && m.promedioCompra > 0 ? formatMoney(m.promedioCompra, m.currency || currency) : "—"

    let lastUpdatedStr = "—"
    if (asset.lastUpdated) {
        const d = new Date(asset.lastUpdated)
        if (!isNaN(d)) {
            const hh = String(d.getHours()).padStart(2, "0")
            const mm = String(d.getMinutes()).padStart(2, "0")
            const dd = String(d.getDate()).padStart(2, "0")
            const mo = String(d.getMonth() + 1).padStart(2, "0")
            lastUpdatedStr = `${dd}/${mo} ${hh}:${mm}`
        }
    }

    const rendStr = hasM
        ? m.invertidoEur > 0
            ? rendSign +
              formatEuro(m.rendimientoEur) +
              " <small>" +
              rendSign +
              ((m.rendimientoEur / m.invertidoEur) * 100).toFixed(2) +
              " %</small>"
            : rendSign + formatEuro(m.rendimientoEur)
        : "—"

    const tr = document.createElement("tr")
    tr.className = `avTableRow${avIsOculto(asset) ? " avHidden" : ""}`
    tr.dataset.assetId = asset.id
    tr.innerHTML = `
        <td><span class="avBadge" style="background:${color}22;color:${color};border-color:${color}44">${typeLabel}</span></td>
        <td class="avTrName">${asset.color ? `<span class="avColorDot avTrColorDot" style="background:${asset.color}" title="Color del activo"></span>` : ""}${escapeHtml(asset.name || asset.symbol || "Activo")}</td>
        <td class="avTrPrice">${formatMoney(price, currency)}</td>
        <td class="avTrProvider">${escapeHtml(provider || "—")}</td>
        <td class="avTrPos">${hasM ? formatShareQuantity(m.participaciones) : "—"}</td>
        <td class="avTrValor">${hasM ? formatEuro(m.netoActualEur) : "—"}</td>
        <td class="avTrAvg">${avgPriceStr}</td>
        <td class="avTrRend ${rClass}">${rendStr}</td>
        <td class="avTrUpdated">${lastUpdatedStr}</td>
        <td class="avTrActions">
            <div class="rowMenu">
                <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                <div class="rowMenuDropdown">
                    <button type="button" class="rowMenuItem avActionBtn avEditBtn" data-asset-id="${asset.id}">Editar</button>
                    <button type="button" class="rowMenuItem avActionBtn avHideBtn" data-asset-id="${asset.id}">${asset.hidden ? "Mostrar" : "Ocultar"}</button>
                    <hr>
                    <button type="button" class="rowMenuItem rowMenuItemDanger avActionBtn avDeleteBtn" data-asset-id="${asset.id}">Eliminar</button>
                </div>
            </div>
        </td>
    `
    return tr
}

function avRenderTable() {
    const tbody = document.getElementById("activosTableBody")
    const count = document.getElementById("activosCount")
    if (!tbody) return

    const filtered = avFilteredAssets()
    if (count) count.textContent = `${filtered.length} activo${filtered.length !== 1 ? "s" : ""}`

    const activosTableEmpty = document.getElementById("activosTableEmpty")
    const activosTableWrap = document.getElementById("activosTableWrap")
    tbody.innerHTML = ""

    if (!filtered.length) {
        if (activosTableEmpty) activosTableEmpty.classList.remove("hidden")
        if (activosTableWrap) activosTableWrap.classList.add("hidden")
        return
    }

    if (activosTableEmpty) activosTableEmpty.classList.add("hidden")
    if (activosTableWrap) activosTableWrap.classList.remove("hidden")
    const frag = document.createDocumentFragment()
    filtered.forEach((a) => frag.appendChild(avBuildTableRow(a)))
    tbody.appendChild(frag)
    const t = tbody.closest("table")
    bindTableSort(t, "activosTable")
    if (t._reSort) t._reSort()
}

function avRender() {
    const gridEl = document.getElementById("activosGrid")
    const tableWrap = document.getElementById("activosTableWrap")
    if (_activosViewMode === "table") {
        if (gridEl) gridEl.classList.add("hidden")
        if (tableWrap) tableWrap.classList.remove("hidden")
        avRenderTable()
    } else {
        if (tableWrap) tableWrap.classList.add("hidden")
        const activosTableEmpty = document.getElementById("activosTableEmpty")
        if (activosTableEmpty) activosTableEmpty.classList.add("hidden")
        if (gridEl) gridEl.classList.remove("hidden")
        avRenderGrid()
    }
}

async function avHandleCardClick(event) {
    const deleteBtn = event.target.closest(".avDeleteBtn")
    if (deleteBtn) {
        const id = deleteBtn.dataset.assetId
        const asset = _activosAllAssets.find((a) => a.id === id)
        const assetName = asset?.name || id
        openConfirmModal({
            title: "Eliminar activo",
            message: `¿Quieres eliminar "${assetName}"?`,
            confirmLabel: "Sí, eliminar",
            confirmSide: "right",
            onConfirm: () => {
                openConfirmModal({
                    title: "¿Estás seguro?",
                    message: `Esta acción eliminará "${assetName}" de forma definitiva y no se puede deshacer.`,
                    confirmLabel: "Sí, estoy seguro",
                    confirmSide: "right",
                    onConfirm: () => {
                        openDeleteTypeConfirm(assetName, async () => {
                            await deleteAssetOnServer(id)
                            _activosAllAssets = _activosAllAssets.filter((a) => a.id !== id)
                            avRender()
                            await refreshAssetsSidebar()
                        })
                    }
                })
            }
        })
        return
    }

    const hideBtn = event.target.closest(".avHideBtn")
    if (hideBtn) {
        await avToggleAssetHidden(hideBtn.dataset.assetId)
        return
    }

    const editBtn = event.target.closest(".avEditBtn")
    if (editBtn) {
        const id = editBtn.dataset.assetId
        currentAssetId = id
        const fullAsset = await loadAssetData(id)
        openEditAssetModal(fullAsset)
        return
    }

    if (event.target.closest(".rowMenu")) return

    const card = event.target.closest(".avCard")
    if (card) {
        const asset = _activosAllAssets.find((a) => a.id === card.dataset.assetId)
        if (asset) openTVChartModal(buildTVSymbol(asset), asset.symbol || asset.name)
        return
    }

    const tableRow = event.target.closest(".avTableRow")
    if (tableRow && !event.target.closest(".avTrActions")) {
        const asset = _activosAllAssets.find((a) => a.id === tableRow.dataset.assetId)
        if (asset) openTVChartModal(buildTVSymbol(asset), asset.symbol || asset.name)
    }
}

function decodeTVTicker(raw) {
    const s = (raw || "").trim()
    if (!s) return ""
    try {
        return decodeURIComponent(s)
    } catch (e) {
        return s
    }
}

function buildTVSymbol(asset) {
    if (asset.tvSymbol && String(asset.tvSymbol).trim()) return decodeTVTicker(String(asset.tvSymbol).trim())

    const mSym = String(asset.marketSymbol || asset.finnhubSymbol || "").trim()
    const uSym = String(asset.symbol || asset.name || "")
        .trim()
        .toUpperCase()
    const provider = String(asset.marketProvider || inferMarketProviderFromSymbol(mSym)).toLowerCase()
    const upper = mSym.toUpperCase()

    if (provider === "yahoo") {
        // Futuros de Yahoo → TradingView
        const yFutures = {
            "GC=F": "COMEX:GC1!",
            "SI=F": "COMEX:SI1!",
            "CL=F": "NYMEX:CL1!",
            "NG=F": "NYMEX:NG1!",
            "HG=F": "COMEX:HG1!",
            "PL=F": "NYMEX:PL1!",
            "PA=F": "NYMEX:PA1!",
            "ZC=F": "CBOT:ZC1!",
            "ZW=F": "CBOT:ZW1!",
            "ES=F": "CME:ES1!",
            "NQ=F": "CME:NQ1!",
            "YM=F": "CBOT:YM1!"
        }
        if (yFutures[upper]) return yFutures[upper]
        // Crypto Yahoo: BTC-USD → BTCUSD
        if (upper.endsWith("-USD")) return upper.replace("-USD", "USD")
        if (upper.endsWith("-EUR")) return upper.replace("-EUR", "EUR")
        if (upper.endsWith("-USDT")) return upper.replace("-USDT", "USDT")
        return mSym || uSym
    }

    if (provider === "eodhd" && mSym.includes(".")) {
        const parts = mSym.split(".")
        const sym = parts[0]
        const exchange = parts[parts.length - 1].toUpperCase()
        // Crypto EODHD: BTC-USD.CC → BTCUSD
        if (exchange === "CC") return sym.replace(/-USD$/, "USD").replace(/-EUR$/, "EUR").replace(/-/, "")
        const tvEx = {
            US: "",
            XETRA: "XETRA",
            PA: "EURONEXT",
            LSE: "LSE",
            SW: "SIX",
            AS: "EURONEXT",
            MC: "BME",
            MI: "MIL",
            F: "FWB",
            DU: "XETRA",
            BE: "XETRA"
        }
        const ex = tvEx[exchange]
        if (ex === "") return sym
        if (ex) return `${ex}:${sym}`
        return sym
    }

    if (provider === "finnhub") {
        // Finnhub ya usa formato EXCHANGE:SYMBOL o solo SYMBOL
        if (mSym.includes(":")) return mSym
        return mSym || uSym
    }

    return uSym
}

function buildTVIframeUrl(tvSymbol) {
    const isLight = document.documentElement.getAttribute("data-theme") === "light"
    const theme = isLight ? "light" : "dark"
    const toolbarbg = isLight ? "f1f5f9" : "111827"
    const p = new URLSearchParams({
        symbol: tvSymbol,
        interval: "D",
        theme,
        style: "1",
        locale: "es",
        hidesidetoolbar: "0",
        symboledit: "1",
        saveimage: "1",
        range: "12M",
        toolbarbg
    })
    return `https://www.tradingview.com/widgetembed/?${p.toString()}`
}

function openTVChartModal(tvSymbol, displayName) {
    const existing = document.getElementById("tvChartOverlay")
    if (existing) existing.remove()

    const overlay = document.createElement("div")
    overlay.id = "tvChartOverlay"
    overlay.className = "tvChartOverlay"

    overlay.innerHTML = `
        <div class="tvChartModal">
            <div class="tvChartModalHeader">
                <span class="tvChartModalTitle">${escapeHtml(displayName || tvSymbol)}</span>
                <span class="tvChartModalSym">${escapeHtml(tvSymbol)}</span>
                <div class="tvChartHeaderSpacer"></div>
                <button type="button" class="tvChartCloseBtn" title="Cerrar">✕</button>
            </div>
            <div class="tvChartIframeWrap">
                <iframe src="${buildTVIframeUrl(tvSymbol)}" frameborder="0" allowtransparency="true" scrolling="no" allowfullscreen></iframe>
            </div>
        </div>
    `

    overlay.addEventListener("click", (e) => {
        if (e.target.closest(".tvChartCloseBtn")) overlay.remove()
    })

    document.addEventListener("keydown", function onEsc(e) {
        if (e.key === "Escape") {
            overlay.remove()
            document.removeEventListener("keydown", onEsc)
        }
    })

    document.body.appendChild(overlay)
}

async function initActivosPageLogic() {
    _activosAllAssets = await loadAssetsList()
    _activosFilterType = "all"
    _activosSearch = ""
    _activosShowHidden = false

    const showHiddenBtn = document.getElementById("activosShowHiddenBtn")
    if (showHiddenBtn) {
        showHiddenBtn.classList.toggle("active", _activosShowHidden)
        showHiddenBtn.addEventListener("click", () => {
            _activosShowHidden = !_activosShowHidden
            showHiddenBtn.classList.toggle("active", _activosShowHidden)
            avRender()
        })
    }

    const viewToggle = document.getElementById("avViewToggle")
    if (viewToggle) {
        viewToggle.querySelectorAll(".avViewBtn").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.view === _activosViewMode)
        })
        viewToggle.addEventListener("click", (e) => {
            const btn = e.target.closest(".avViewBtn")
            if (!btn) return
            _activosViewMode = btn.dataset.view
            localStorage.setItem("activosViewMode", _activosViewMode)
            viewToggle.querySelectorAll(".avViewBtn").forEach((b) => b.classList.toggle("active", b === btn))
            avRender()
        })
    }

    avRender()

    const grid = document.getElementById("activosGrid")
    if (grid) grid.addEventListener("click", avHandleCardClick)

    const tableWrap = document.getElementById("activosTableWrap")
    if (tableWrap) tableWrap.addEventListener("click", avHandleCardClick)

    const filters = document.getElementById("activosFilters")
    if (filters) {
        const todosInput = filters.querySelector('[data-type="all"] input')
        const getIndividuals = () => [...filters.querySelectorAll('.activosFilterBtn:not([data-type="all"]) input')]
        const updateFilterLabel = () => {
            const btn = document.getElementById("activosFilterDropBtn")
            if (!btn) return
            if (todosInput?.checked) {
                btn.textContent = "Todos ▾"
            } else {
                const sel = getIndividuals()
                    .filter((cb) => cb.checked)
                    .map((cb) => cb.closest(".activosFilterBtn").querySelector("span").textContent)
                btn.textContent = (sel.join(", ") || "Todos") + " ▾"
            }
        }
        const syncFilterState = () => {
            if (todosInput?.checked) {
                _activosFilterType = "all"
            } else {
                const sel = getIndividuals()
                    .filter((cb) => cb.checked)
                    .map((cb) => cb.closest(".activosFilterBtn").dataset.type)
                _activosFilterType = sel.length ? sel : "all"
                if (!sel.length && todosInput) todosInput.checked = true
            }
            updateFilterLabel()
        }
        // reset to Todos on each init
        if (todosInput) todosInput.checked = true
        getIndividuals().forEach((cb) => {
            cb.checked = true
        })
        updateFilterLabel()
        if (!filters.dataset.bound) {
            filters.dataset.bound = "true"
            filters.addEventListener("change", (e) => {
                const changed = e.target
                if (changed === todosInput) {
                    changed.checked = true
                    getIndividuals().forEach((cb) => {
                        cb.checked = true
                    })
                } else if (todosInput?.checked) {
                    todosInput.checked = false
                    getIndividuals().forEach((cb) => {
                        cb.checked = cb === changed
                    })
                    changed.checked = true
                } else {
                    if (todosInput) todosInput.checked = getIndividuals().every((cb) => cb.checked)
                }
                syncFilterState()
                avRender()
            })
        }
    }

    const search = document.getElementById("activosSearch")
    if (search) {
        search.addEventListener("input", () => {
            _activosSearch = search.value.trim()
            avRender()
        })
    }

    avLoadMetrics()

    const addBtn = document.getElementById("activosAddBtn")
    if (addBtn) addBtn.addEventListener("click", () => openAssetModal())

    avInitDragDrop()
}

function avInitDragDrop() {
    const grid = document.getElementById("activosGrid")
    if (!grid || grid.dataset.dragBound === "true") return
    grid.dataset.dragBound = "true"

    let avDraggedId = null
    let avDropped = false

    grid.addEventListener("dragstart", (e) => {
        const card = e.target.closest(".avCard")
        if (!card || !card.dataset.assetId) return
        avDraggedId = card.dataset.assetId
        draggedAssetId = avDraggedId
        avDropped = false
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move"
            e.dataTransfer.setData("text/plain", avDraggedId)
        }
        // El estilo de hueco se aplica tras generar la imagen de arrastre
        requestAnimationFrame(() => card.classList.add("avDragging"))
    })

    grid.addEventListener("dragend", (e) => {
        const card = e.target.closest(".avCard")
        if (card) card.classList.remove("avDragging")
        avDraggedId = null
        draggedAssetId = null
        // Arrastre cancelado: se restaura el orden real
        if (!avDropped) avRenderGrid()
        avDropped = false
    })

    grid.addEventListener("dragover", (e) => {
        const dragged = grid.querySelector(".avCard.avDragging")
        if (!avDraggedId || !dragged) return
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
        moveDraggedAssetPreview(grid, dragged, avFindDropReference(grid, dragged, e.clientX, e.clientY))
    })

    grid.addEventListener("drop", async (e) => {
        const dragged = grid.querySelector(".avCard.avDragging")
        if (!avDraggedId || !dragged) return
        e.preventDefault()
        avDropped = true
        const movedAssetId = avDraggedId
        try {
            await commitAssetOrderFromDom(grid, ".avCard", movedAssetId)
            const metricsById = new Map(_activosAllAssets.map((a) => [a.id, a._metrics]))
            _activosAllAssets = await loadAssetsList()
            _activosAllAssets.forEach((a) => {
                const metrics = metricsById.get(a.id)
                if (metrics) a._metrics = metrics
            })
            avRender()
            avLoadMetrics()
        } catch (err) {
            console.error("avDrop error", err)
            avRenderGrid()
        }
    })
}

// Devuelve la tarjeta delante de la cual debe colocarse la arrastrada (null = al final)
function avFindDropReference(grid, dragged, pointerX, pointerY) {
    const cards = [...grid.querySelectorAll(".avCard")].filter((card) => card !== dragged && card.dataset.assetId)

    for (const card of cards) {
        const rect = card.getBoundingClientRect()

        if (pointerY > rect.bottom) continue
        if (pointerY < rect.top || pointerX < rect.left + rect.width / 2) return card
    }

    return null
}

async function avLoadMetrics() {
    const baseAssets = _activosAllAssets
    if (!baseAssets.length) return

    await Promise.all(
        baseAssets.map(async (asset) => {
            try {
                const full = await loadAssetData(asset.id)
                const row = await buildOverviewRow(full)
                const euros = await buildSummaryMetricsInEuros(row)

                const m = {
                    participaciones: row.participaciones,
                    promedioCompra: row.promedioCompra,
                    currency: row.currency,
                    netoActualEur: euros.netoActualEur,
                    invertidoEur: euros.invertidoBrutoEur,
                    rendimientoEur: euros.rendimientoEur
                }
                asset._metrics = m

                const rClass = m.rendimientoEur >= 0 ? "avPos" : "avNeg"
                const sign = m.rendimientoEur >= 0 ? "+" : ""
                const rendStr =
                    m.invertidoEur > 0
                        ? sign +
                          formatEuro(m.rendimientoEur) +
                          "<br><small>" +
                          sign +
                          ((m.rendimientoEur / m.invertidoEur) * 100).toFixed(2) +
                          " %</small>"
                        : sign + formatEuro(m.rendimientoEur)

                const cardEl = document.querySelector(`.avCard[data-asset-id="${asset.id}"]`)
                if (cardEl) {
                    const vals = cardEl.querySelectorAll(".avMetricValue")
                    if (vals.length >= 4) {
                        vals[0].textContent = formatShareQuantity(m.participaciones)
                        vals[1].textContent = formatEuro(m.netoActualEur)
                        vals[2].textContent = m.promedioCompra > 0 ? formatMoney(m.promedioCompra, m.currency) : "—"
                        vals[3].innerHTML = rendStr
                        vals[3].className = "avMetricValue " + rClass
                    }
                }

                const trEl = document.querySelector(`.avTableRow[data-asset-id="${asset.id}"]`)
                if (trEl) {
                    const rendTrStr =
                        m.invertidoEur > 0
                            ? sign +
                              formatEuro(m.rendimientoEur) +
                              " <small>" +
                              sign +
                              ((m.rendimientoEur / m.invertidoEur) * 100).toFixed(2) +
                              " %</small>"
                            : sign + formatEuro(m.rendimientoEur)
                    const avgStr = m.promedioCompra > 0 ? formatMoney(m.promedioCompra, m.currency) : "—"
                    const posEl = trEl.querySelector(".avTrPos")
                    const valEl = trEl.querySelector(".avTrValor")
                    const avgEl = trEl.querySelector(".avTrAvg")
                    const rendEl = trEl.querySelector(".avTrRend")
                    if (posEl) posEl.textContent = formatShareQuantity(m.participaciones)
                    if (valEl) valEl.textContent = formatEuro(m.netoActualEur)
                    if (avgEl) avgEl.textContent = avgStr
                    if (rendEl) {
                        rendEl.innerHTML = rendTrStr
                        rendEl.className = "avTrRend " + rClass
                    }
                }
            } catch (e) {
                console.error("avLoadMetrics error", asset.id, e)
            }
        })
    )
}
