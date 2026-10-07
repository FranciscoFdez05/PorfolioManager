// Ficha del activo: tabla de movimientos, búsqueda de símbolos y edición.
//
// Separado de js/cartera/assets.js, que pasaba de 6.000 líneas. Es código
// de nivel superior que comparte el ámbito global con el resto de trozos
// (index.html los carga seguidos y en este orden); no ha cambiado.

function renderAssetTablePage(asset) {
    const contentArea = document.getElementById("dynamicContent")
    const primaryRows = getPrimaryAssetRows(asset)
    const conversionRows = getAssetConversionRows(asset)
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
        <section class="assetTablePage" data-asset-id="${escapeHtml(asset.id)}" data-asset-type="${escapeHtml(asset.type)}" data-asset-name="${escapeHtml(asset.name)}" data-asset-symbol="${escapeHtml(asset.symbol)}" data-asset-price="${escapeHtml(asset.price || "0,00")}" data-asset-currency="${escapeHtml(asset.currency || "EUR")}" data-asset-change="${escapeHtml(asset.change || "+0,00%")}" data-asset-status="${escapeHtml(asset.status || "Mercado abierto")}" data-asset-last-updated="${escapeHtml(asset.lastUpdated || "")}" data-asset-market-provider="${escapeHtml(asset.marketProvider || inferMarketProviderFromSymbol(asset.marketSymbol || asset.finnhubSymbol || ""))}" data-asset-market-symbol="${escapeHtml(asset.marketSymbol || asset.finnhubSymbol || "")}" data-asset-finnhub-symbol="${escapeHtml(asset.finnhubSymbol || "")}" data-asset-color="${escapeHtml(asset.color || "")}" data-asset-tv-symbol="${escapeHtml(asset.tvSymbol || "")}" data-asset-convert-currency="${escapeHtml(asset.convertCurrency || "")}" data-asset-coste-anual="${escapeHtml(asset.costeAnual || "")}">
            <div class="assetPageHeader">
                <div class="assetHeaderLeft">
                    <div class="assetTitleRow">
                        <h1 class="assetPageTitle">${escapeHtml(asset.name || asset.symbol)}</h1>
                    </div>
                    <div class="assetPageSubtitle">${escapeHtml(asset.name)} · ${buildAssetTypeLabel(asset.type)}</div>
                    <div class="assetValueRow">
                        <span class="assetValueAmount" id="assetStatPrecioActual">—</span>
                    </div>
                </div>
                <div class="assetStatsPanel${isEtf ? " assetStatsPanelEtf" : ""}" id="assetStatsPanel">
                    <div class="assetStatCard">
                        <span class="assetStatLabel">Valor actual</span>
                        <span class="assetStatValue" id="assetStatNetoActual">—</span>
                    </div>
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
                    ${
                        isEtf
                            ? `<div class="assetStatCard">
                        <span class="assetStatLabel">Coste anual</span>
                        <span class="assetStatValue" id="assetStatCosteAnual">${
                            String(asset.costeAnual || "").trim() ? formatCellPercentValue(asset.costeAnual) : "—"
                        }</span>
                    </div>`
                            : ""
                    }
                    <div class="assetStatCard assetStatCardPnL">
                        <span class="assetStatLabel">Ganancia / Pérdida Total</span>
                        <div class="assetStatValueRow">
                            <span class="assetStatValue" id="assetStatPnL">—</span>
                            <span class="assetStatSub" id="assetStatPnLPct">—</span>
                            <!-- Desglose activo/divisa. Solo aparece si el activo
                                 está en otra moneda: para uno en euros el efecto
                                 divisa es cero y la línea sería ruido. Va dentro
                                 de la misma fila que el importe para que la
                                 tarjeta crezca a lo ancho y no a lo alto. -->
                            <div class="assetStatDivisa hidden" id="assetStatDivisa"></div>
                        </div>
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

            <div class="assetTodosLayout" id="assetTodosLayout">
            <div class="assetTabsContainer">
                <div class="assetTabsNav">
                    <button class="assetTabBtn assetTabActive" id="todosTabBtn" data-tab="todos">Todos</button>
                    <button class="assetTabBtn" id="spotTabBtn" data-tab="spot">Compras spot</button>
                    <button class="assetTabBtn hidden" id="completadasTabBtn" data-tab="completadas">Operaciones Spot</button>
                    <button class="assetTabBtn hidden" id="transaccionesTabBtn" data-tab="transacciones">Transacciones</button>
                    <button class="assetTabBtn" id="ventasTabBtn" data-tab="ventas">Ventas</button>
                    <button class="assetTabBtn" id="planesTabBtn" data-tab="planes">Planes</button>
                    <button class="assetTabBtn" id="alertasTabBtn" data-tab="alertas">Alertas</button>
                    <button class="assetTabsNavAction hidden" id="assetAddVentaNavBtn" type="button"><span class="assetBtnIcon">+</span> Añadir venta</button>
                    <button class="assetTabsNavAction hidden" id="assetAddPlanNavBtn" type="button"><span class="assetBtnIcon">+</span> Nuevo plan</button>
                </div>
                <div class="assetTabPanel" data-tab="todos">
                    <div id="assetTodosSection"></div>
                </div>
                <div class="assetTabPanel hidden" data-tab="spot">
                    <div class="assetTableWrapper">
                        <table class="assetOperationsTable">
                            <thead>
                                <tr>
                                    <th class="mThSort" data-sortkey="fechaOperacion">Fecha operación<span class="mSortArrow"></span></th>
                                    <th class="mThSort" data-sortkey="tipoOperacion">Tipo de operación<span class="mSortArrow"></span></th>
                                    <th class="mThSort" data-sortkey="participaciones">Participaciones<span class="mSortArrow"></span></th>
                                    <th class="mThSort" data-sortkey="precioParticipacion">Precio Participación<span class="mSortArrow"></span></th>
                                    ${isCrypto ? '<th class="mThSort" data-sortkey="currency">Moneda fiat<span class="mSortArrow"></span></th>' : ""}
                                    <th class="mThSort" data-sortkey="capitalInvertidoBruto">Invertido bruto<span class="mSortArrow"></span></th>
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
                <div class="assetTabPanel hidden" data-tab="planes">
                    <div id="assetPlanesSection"></div>
                </div>
                <div class="assetTabPanel hidden" data-tab="alertas">
                    <div id="assetAlertasSection"></div>
                </div>
            </div>
            <aside class="todosChartsCol" id="assetTodosChartsCol"></aside>
            </div>
        </section>
    `

    currentAssetPersistedOperationRows = Array.isArray(asset.operationRows) ? asset.operationRows : []
    currentAssetPersistedConversionRows = conversionRows
    renderAssetRows(primaryRows)
    renderAssetCompletedOperationsSection(asset)
    renderAssetTransaccionesSection(asset)
    renderAssetVentasSection(asset)
    renderAssetTodosSection(asset)
    setupAssetTabs(asset)
    _assetBindSort(asset.id)
    initAssetTableLogic(asset)

    // Planes de inversión: lo que se piensa hacer con ESTE activo. Van
    // después de pintar la ficha porque sus tarjetas leen de ella el precio
    // actual, y sin `await` porque nada de lo de arriba depende de ellas.
    initAssetPlanesLogic(asset)

    // Alertas de precio de ESTE activo: van aparte de los planes porque no
    // dependen de la ficha (solo del id) y se comprueban en el servidor.
    initAssetAlertasLogic(asset)

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
    document.getElementById("assetAddPlanNavBtn")?.classList.toggle("hidden", tab !== "planes")
    // Los gráficos son de "Todos". En las demás pestañas no solo se esconden:
    // el recuadro recupera el ancho completo, que si no queda un hueco de 340 px
    // reservado para una columna que no está.
    document.getElementById("assetTodosChartsCol")?.classList.toggle("hidden", tab !== "todos")
    document.getElementById("assetTodosLayout")?.classList.toggle("assetTodosLayoutFull", tab !== "todos")
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
    nav.querySelector("#assetAddPlanNavBtn")?.addEventListener("click", () => planAbrirEditor())
}

// Una fila recién añadida está en blanco hasta que se rellena. No cuenta como
// compra —ni para el contador de la pestaña ni para preguntar antes de borrarla—
// porque todavía no dice nada.
function isEmptyAssetRow(row) {
    return !row || (!row.fechaOperacion && !row.participaciones && !row.capitalInvertidoBruto)
}

function updateAssetSpotTabCount() {
    const tabBtn = document.getElementById("spotTabBtn")
    if (!tabBtn) return

    const cuenta = _assetDisplayRows.filter((row) => !isEmptyAssetRow(row)).length
    tabBtn.textContent = cuenta ? `Compras spot (${cuenta})` : "Compras spot"
}

function renderAssetRows(rows) {
    _assetDisplayRows = Array.isArray(rows) ? [...rows] : []
    updateAssetSpotTabCount()
    const assetOperationsBody = document.getElementById("assetOperationsBody")
    const assetPage = document.querySelector(".assetTablePage")
    const assetCurrency = assetPage?.dataset.assetCurrency || "EUR"
    const assetType = assetPage?.dataset.assetType || "acciones"
    const isCrypto = isCryptoAssetType(assetType)

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
            <td data-field="participaciones">${formatAssetParticipationValue(rowData.participaciones, assetType)}</td>
            <td data-field="precioParticipacion">${moneyMono(rowData.precioParticipacion, "precioParticipacion")}</td>
            ${isCrypto ? `<td data-field="currency">${escapeHtml(rowCurrency)}</td>` : ""}
            <td data-field="capitalInvertidoBruto">${moneyMono(rowData.capitalInvertidoBruto, "capitalInvertidoBruto")}</td>
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
        convertCurrency: assetPage?.dataset.assetConvertCurrency || "",
        costeAnual: assetPage?.dataset.assetCosteAnual || "",
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

    rowElements.forEach((rowElement) => {
        const rowCurrency = getAssetRowCurrency(rowElement, assetCurrency)
        const rowData = {
            participaciones: rowElement.querySelector('[data-field="participaciones"]')?.textContent || "",
            precioParticipacion: rowElement.querySelector('[data-field="precioParticipacion"]')?.textContent || "",
            capitalInvertidoBruto: rowElement.querySelector('[data-field="capitalInvertidoBruto"]')?.textContent || ""
        }
        const bruto = getRowGrossAmount(rowData)
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

// Pone primero, dentro de la fila de botones "Buscar X", el proveedor que ya
// tiene el activo (al editar) o el que se acaba de elegir en una búsqueda: es
// el que de verdad se va a usar para cotizar, así que es el más probable que
// vuelva a hacer falta si el usuario busca otra vez. Usa `order` en vez de
// mover los nodos para que sea trivial de revertir (basta con volver a
// llamarla con otro proveedor, o con "tradingview" para el orden de fábrica).
function reorderProviderSearchButtons(containerId, preferredProvider) {
    const container = document.getElementById(containerId)
    if (!container) return

    container.querySelectorAll("[data-provider]").forEach((button) => {
        button.style.order = button.dataset.provider === preferredProvider ? "-1" : ""
    })
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

async function handleTradingViewSearch({
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

    setAssetSearchFeedback(feedbackElement, "Buscando ticker en TradingView...")

    try {
        const response = await searchTradingViewSymbolOnServer(normalizedQuery, { assetName, assetType })
        const results = Array.isArray(response.results) ? response.results : []

        if (!results.length) {
            setAssetSearchFeedback(
                feedbackElement,
                "No se encontraron resultados en TradingView para esa búsqueda.",
                true
            )
            renderMarketSearchResults(resultsElement, [], onSelect)
            return
        }

        setAssetSearchFeedback(feedbackElement, "Selecciona el ticker correcto de TradingView.")
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

// Las divisas del selector salen del servidor (las que admite el activo y el
// servicio de cambio sabe convertir hoy), no de una lista en el HTML. La que ya
// estuviera elegida se conserva aunque no venga en la respuesta.
async function fillConvertCurrencyOptions(select, selected) {
    let divisas = []
    try {
        const response = await fetch("/api/divisas")
        if (response.ok) divisas = (await response.json()).divisas || []
    } catch (error) {
        console.error(error)
    }

    if (selected && !divisas.some((divisa) => divisa.code === selected)) {
        divisas.push({ code: selected, name: selected })
    }

    select.innerHTML = ""
    divisas.forEach(({ code, name }) => {
        const option = document.createElement("option")
        option.value = code
        option.textContent = name && name !== code ? `${code} · ${name}` : code
        select.appendChild(option)
    })
    if (selected) select.value = selected
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
    // Solo para decidir qué botón "Buscar X" sale primero: el proveedor que ya
    // usa el activo para cotizar. No se guarda en el dataset del input, que
    // `submitEditAssetModal` deja vacío a propósito hasta que el usuario elija
    // uno de verdad (si no, "providerChanged" saltaría sin haber tocado nada).
    const preferredProvider =
        assetData?.marketProvider ||
        assetPage?.dataset.assetMarketProvider ||
        inferMarketProviderFromSymbol(currentTicker)

    if (!editAssetModalOverlay || !editAssetNameInput) {
        return
    }

    editAssetNameInput.value = currentName
    if (editAssetTickerInput) {
        editAssetTickerInput.value = currentTicker
        delete editAssetTickerInput.dataset.marketProvider
    }
    reorderProviderSearchButtons("editAssetSearchActions", preferredProvider)
    const currentConvertCurrency = assetData?.convertCurrency || assetPage?.dataset.assetConvertCurrency || ""
    const editAssetType = String(assetData?.type || assetPage?.dataset.assetType || "").toLowerCase()
    document.getElementById("editAssetCosteAnualField")?.classList.toggle("hidden", editAssetType !== "etfs")
    const editCosteAnualInput = document.getElementById("editAssetCosteAnualInput")
    if (editCosteAnualInput) {
        editCosteAnualInput.value = assetData?.costeAnual ?? assetPage?.dataset.assetCosteAnual ?? ""
    }
    const editConvertCurrencyToggle = document.getElementById("editAssetConvertCurrencyToggle")
    const editConvertCurrencySelect = document.getElementById("editAssetConvertCurrencySelect")
    if (editConvertCurrencyToggle && editConvertCurrencySelect) {
        editConvertCurrencyToggle.checked = !!currentConvertCurrency
        editConvertCurrencySelect.classList.toggle("hidden", !currentConvertCurrency)
        // Sin divisa fijada todavía, el selector parte de la que ya tiene el activo.
        const assetCurrency = String(assetData?.currency || assetPage?.dataset.assetCurrency || "").toUpperCase()
        fillConvertCurrencyOptions(editConvertCurrencySelect, currentConvertCurrency || assetCurrency)
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

// Base sobre la que se guarda una edición del activo.
//
// El guardado reescribe el activo entero, y el modal solo edita cinco campos
// de cabecera: nombre, ticker, color, ticker de TradingView y la divisa de
// conversión de la cotización. Todo lo demás —operaciones, conversiones,
// precio— tiene que viajar intacto o el guardado lo borra.
// `buildCurrentAssetPayload` saca las filas de la tabla de
// operaciones, así que solo sirve con esa tabla en pantalla: desde la vista de
// Activos, sin ella, devolvía un activo sin filas y cambiar el color se llevaba
// por delante todo el historial de compras.
async function buildEditAssetPayload() {
    if (_editingAsset) {
        // Viene de la vista de Activos: es la copia completa que dio el servidor.
        return { ..._editingAsset }
    }

    if (document.getElementById("assetOperationsBody")) {
        // La tabla está delante: refleja también lo editado y aún sin guardar.
        return buildCurrentAssetPayload()
    }

    return await loadAssetData(currentAssetId)
}

async function submitEditAssetModal() {
    if (!currentAssetId) {
        return
    }

    const editAssetNameInput = document.getElementById("editAssetNameInput")

    if (!editAssetNameInput) {
        return
    }

    const payload = await buildEditAssetPayload()
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
    const convertCurrencyToggle = document.getElementById("editAssetConvertCurrencyToggle")
    const convertCurrencySelect = document.getElementById("editAssetConvertCurrencySelect")
    const newConvertCurrency = convertCurrencyToggle?.checked ? convertCurrencySelect?.value || "" : ""
    const newCosteAnual =
        String(payload.type || "").toLowerCase() === "etfs"
            ? document.getElementById("editAssetCosteAnualInput")?.value.trim() || ""
            : payload.costeAnual || ""

    if (!trimmedName) {
        editAssetNameInput.focus()
        return
    }

    if (
        trimmedName === currentName &&
        newColor === (payload.color || "") &&
        newTicker === currentTicker &&
        !providerChanged &&
        newTVTicker === (payload.tvSymbol || "") &&
        newConvertCurrency === (payload.convertCurrency || "") &&
        newCosteAnual === (payload.costeAnual || "")
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
    payload.convertCurrency = newConvertCurrency
    payload.costeAnual = newCosteAnual
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

    // La divisa elegida en el interruptor pasa a ser la del activo entero, no
    // solo la del precio: lo invertido está en la divisa del activo y el
    // rendimiento resta uno de otro sin convertir. Se hace con la misma ruta
    // que el menú «Moneda del activo», que convierte precio y compras a la vez.
    const currentCurrency = String(payload.currency || "EUR").toUpperCase()
    const currencyChanged = !!newConvertCurrency && newConvertCurrency !== currentCurrency
    if (currencyChanged) {
        await changeAssetCurrencyOnServer(currentAssetId, newConvertCurrency)
    }

    // Con un ticker nuevo, el precio guardado todavía es el del anterior (otro
    // proveedor, a veces otra divisa) hasta el siguiente refresco. Se pide ya,
    // convertido a la divisa del activo. Si el proveedor falla no se deshace la
    // edición: queda guardada y el precio se actualizará en el próximo refresco.
    const tickerChanged = newTicker !== currentTicker || providerChanged
    if (tickerChanged) {
        try {
            await refreshAssetMarketDataOnServer(currentAssetId)
        } catch (error) {
            console.error(error)
        }
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
                marketProvider: updatedAsset.marketProvider,
                tvSymbol: updatedAsset.tvSymbol,
                convertCurrency: updatedAsset.convertCurrency,
                costeAnual: updatedAsset.costeAnual,
                price: updatedAsset.price,
                currency: updatedAsset.currency,
                change: updatedAsset.change,
                lastUpdated: updatedAsset.lastUpdated
            }
        avRender()
        // Valor y rendimiento de la lista salen del precio: con otro precio u
        // otra divisa, los de antes ya no valen.
        if (tickerChanged || currencyChanged) avLoadMetrics()
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
    const isCrypto = isCryptoAssetType(assetType)
    const isEdit = rowIndex >= 0
    const rowData = isEdit ? { ..._assetDisplayRows[rowIndex] } : {}
    const tipoVal = rowData.tipoOperacion || "Compra"

    const fieldsHtml = `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Fecha operación</label>
            <input id="arModalFecha" class="assetRowModalInput" type="text" value="${escapeAttr(rowData.fechaOperacion || "")}" placeholder="dd-mm-aaaa">
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
            <input id="arModalExchange" class="assetRowModalInput" type="text" value="${escapeAttr(rowData.exchange || "")}">
        </div>`
                : ""
        }
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Participaciones</label>
            <input id="arModalParticipaciones" class="assetRowModalInput" type="text" inputmode="decimal" value="${escapeAttr(rowData.participaciones || "")}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Precio participación</label>
            <input id="arModalPrecio" class="assetRowModalInput" type="text" inputmode="decimal" value="${escapeAttr(rowData.precioParticipacion || "")}">
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
            <input id="arModalCapital" class="assetRowModalInput" type="text" inputmode="decimal" value="${escapeAttr(rowData.capitalInvertidoBruto || "")}">
        </div>
        ${
            isCrypto
                ? `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Comisiones cripto</label>
            <input id="arModalComisionesCripto" class="assetRowModalInput" type="text" inputmode="decimal" value="${escapeAttr(rowData.comisionesCripto || rowData.comisionesSatoshis || "")}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Comisiones fiat</label>
            <input id="arModalComisionesFiat" class="assetRowModalInput" type="text" inputmode="decimal" value="${escapeAttr(rowData.comisionesFiat || "")}">
        </div>`
                : `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Comisiones</label>
            <input id="arModalComisiones" class="assetRowModalInput" type="text" inputmode="decimal" value="${escapeAttr(rowData.comisiones || "")}">
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
    refreshAssetHeaderStats(buildCurrentAssetPayload())
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

    refreshAssetHeaderStats(asset)

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

                if (isEmptyAssetRow(row)) {
                    _assetDisplayRows.splice(idx, 1)
                    renderAssetRows(_assetDisplayRows)
                    scheduleAssetAutosave()
                    refreshAssetHeaderStats(buildCurrentAssetPayload())
                } else {
                    openConfirmModal({
                        title: "Eliminar fila",
                        message: "Esta fila tiene contenido. ¿Quieres eliminarla?",
                        confirmLabel: "Eliminar",
                        onConfirm: async () => {
                            _assetDisplayRows.splice(idx, 1)
                            renderAssetRows(_assetDisplayRows)
                            scheduleAssetAutosave()
                            refreshAssetHeaderStats(buildCurrentAssetPayload())
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
                reportEditAssetError(error)
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

            // El nombre sale de la propia ficha abierta y solo después de la
            // lista de Activos: esa lista está vacía si no se ha pasado por esa
            // página, y entonces el diálogo pedía teclear el identificador
            // ("s-p-500") en vez del nombre que se está viendo.
            const detailAssetName =
                document.querySelector(".assetTablePage")?.dataset.assetName ||
                _activosAllAssets.find((a) => a.id === currentAssetId)?.name ||
                currentAssetId
            openConfirmModal({
                title: "Eliminar activo",
                message: hasContent
                    ? `"${detailAssetName}" tiene contenido guardado: sus compras, operaciones y planes se borran con él. Esto no se puede deshacer.`
                    : `Vas a eliminar "${detailAssetName}". Esto no se puede deshacer.`,
                confirmLabel: "Eliminar",
                confirmSide: "right",
                requireText: detailAssetName,
                onConfirm: async () => {
                    await deleteAssetOnServer(currentAssetId)
                    currentAssetId = null
                    const contentArea = document.getElementById("dynamicContent")
                    if (contentArea) {
                        contentArea.innerHTML = `<div class="placeholderPage">Activo eliminado.</div>`
                    }
                    await refreshAssetsSidebar(null, false)
                }
            })
        })
    }
}

function refreshAssetHeaderStats(asset) {
    buildOverviewRow(asset).then((summary) => {
        if (document.querySelector(".assetTablePage")?.dataset.assetId !== asset.id) return
        const currency = summary.currency
        const pnl = summary.rendimiento
        const pnlPct = summary.invertidoNeto > 0 ? (pnl / summary.invertidoNeto) * 100 : 0
        const netoEl = document.getElementById("assetStatNetoActual")
        const cantidadEl = document.getElementById("assetStatCantidad")
        const precioMedioEl = document.getElementById("assetStatPrecioMedio")
        const precioActualEl = document.getElementById("assetStatPrecioActual")
        const invertidoEl = document.getElementById("assetStatInvertido")
        const pnlEl = document.getElementById("assetStatPnL")
        const pnlPctEl = document.getElementById("assetStatPnLPct")
        if (netoEl) netoEl.textContent = formatMoney(summary.netoActual, currency)
        if (cantidadEl) cantidadEl.textContent = formatAssetParticipationValue(summary.participaciones, asset.type)
        if (precioMedioEl) precioMedioEl.textContent = formatMoney(summary.promedioCompra, currency)
        if (precioActualEl) precioActualEl.textContent = formatMoney(summary.valorActual, currency)
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

// El coste anual (TER) es del fondo, no de cada compra: solo se pide al dar de
// alta un ETF y el resto de tipos de activo no lo enseñan.
function syncAssetCosteAnualField() {
    const isEtf = document.getElementById("assetTypeSelect")?.value === "etfs"
    document.getElementById("assetCosteAnualField")?.classList.toggle("hidden", !isEtf)
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
    const costeAnualInput = document.getElementById("assetCosteAnualInput")
    if (costeAnualInput) costeAnualInput.value = ""
    syncAssetCosteAnualField()
    reorderProviderSearchButtons("assetSearchActions", "tradingview")
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

    // Con Ajustes abierto, #dynamicContent está detrás de un panel que ocupa la
    // pantalla entera: alinearse con él deja el diálogo descentrado respecto a
    // lo único que se ve. Ahí el marco visible es la ventana.
    const ajustes = document.getElementById("sttOverlay")
    if (ajustes && !ajustes.classList.contains("hidden")) {
        confirmModalOverlay.style.padding = ""
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
