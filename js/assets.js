async function loadAssetsList() {
    const response = await fetch("/api/activos")

    if (!response.ok) {
        throw new Error("No se pudo cargar la lista de activos")
    }

    const data = await response.json()
    return Array.isArray(data.assets) ? data.assets : []
}

async function loadAssetData(assetId) {
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

async function createAssetOnServer(name, type, finnhubSymbol = "") {
    const response = await fetch("/api/activos", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ name, type, finnhubSymbol })
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
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

async function searchFinnhubSymbolOnServer(query) {
    const response = await fetch(`/api/finnhub/search?q=${encodeURIComponent(query)}`)

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

function updateAssetDetail(asset) {
    const detSymbol = document.getElementById("detSymbol")
    const detName = document.getElementById("detName")
    const detPrice = document.getElementById("detPrice")
    const detChange = document.getElementById("detChange")
    const detStatus = document.getElementById("detStatus")
    const detFinnhub = document.getElementById("detFinnhub")

    if (detSymbol) {
        detSymbol.textContent = asset.symbol || "---"
    }

    if (detName) {
        detName.textContent = asset.name || "Activo"
    }

    if (detPrice) {
        detPrice.textContent = formatMoney(parseLooseNumber(asset.price || "0") || 0, asset.currency || "EUR")
    }

    if (detChange) {
        const changeValue = String(asset.change || "---").trim()
        detChange.textContent = `Cambio: ${changeValue}`
        detChange.classList.toggle("negative", changeValue.startsWith("-"))
    }

    if (detStatus) {
        detStatus.textContent = asset.status || "Sin datos de mercado"
    }

    if (detFinnhub) {
        detFinnhub.textContent = `Ticker Finnhub: ${asset.finnhubSymbol || "---"}`
    }
}

function renderAssetsList(assets) {
    const assetsList = document.getElementById("assetsList")

    if (!assetsList) {
        return
    }

    assetsList.innerHTML = ""

    assets.forEach((asset) => {
        const button = document.createElement("button")
        button.className = `assetBtn${asset.id === currentAssetId ? " selected" : ""}`
        button.dataset.assetId = asset.id
        button.dataset.assetOrder = String(asset.order ?? 0)
        button.draggable = true
        button.innerHTML = `
            <span class="assetBtnMain">
                <span class="assetBtnSymbol">${asset.symbol || asset.name}</span>
                <span class="assetBtnName">${asset.name || asset.symbol || "Activo"}</span>
            </span>
            <span class="assetBtnPrice">${formatMoney(parseLooseNumber(asset.price || "0") || 0, asset.currency || "EUR")}</span>
        `
        assetsList.appendChild(button)
    })

    initAssetSelector([...assetsList.querySelectorAll(".assetBtn")])
    initAssetDragAndDrop(assetsList)
}

async function refreshAssetsSidebar(selectedAssetId = currentAssetId, renderTable = false) {
    try {
        const assets = await loadAssetsList()
        renderAssetsList(assets)
        await refreshTopPortfolioMetrics(assets)
        await refreshOverviewIfVisible()

        if (!assets.length) {
            currentAssetId = null
            const detSymbol = document.getElementById("detSymbol")
            const detName = document.getElementById("detName")
            const detPrice = document.getElementById("detPrice")
            const detChange = document.getElementById("detChange")
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

            if (detStatus) {
                detStatus.textContent = "Sin datos de mercado"
            }

            if (detFinnhub) {
                detFinnhub.textContent = "Ticker Finnhub: ---"
            }

            return
        }

        const assetIdToSelect = selectedAssetId || assets[0].id
        currentAssetId = assetIdToSelect
        renderAssetsList(assets)

        const selectedAsset = assets.find((asset) => asset.id === assetIdToSelect) || assets[0]
        const fullAsset = await loadAssetData(selectedAsset.id)
        updateAssetDetail(fullAsset)

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
    updateAssetDetail(assetData)
    renderAssetsList(await loadAssetsList())
    renderAssetTablePage(assetData)
}

async function refreshOverviewIfVisible() {
    if (document.getElementById("overviewTableBody")) {
        await renderVistaGeneralTable()
    }
}

function initAssetDragAndDrop(assetsList) {
    const assetButtons = [...assetsList.querySelectorAll(".assetBtn")]

    assetButtons.forEach((button) => {
        button.addEventListener("dragstart", (event) => {
            draggedAssetId = button.dataset.assetId || null
            button.classList.add("dragging")

            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "move"
                event.dataTransfer.setData("text/plain", draggedAssetId || "")
            }
        })

        button.addEventListener("dragend", () => {
            button.classList.remove("dragging")
            clearAssetDragState()
            draggedAssetId = null
        })

        button.addEventListener("dragover", (event) => {
            if (!draggedAssetId || draggedAssetId === button.dataset.assetId) {
                return
            }

            event.preventDefault()
            button.classList.add("dragOver")
        })

        button.addEventListener("dragleave", () => {
            button.classList.remove("dragOver")
        })

        button.addEventListener("drop", async (event) => {
            event.preventDefault()

            const targetAssetId = button.dataset.assetId || ""

            button.classList.remove("dragOver")

            if (!draggedAssetId || !targetAssetId || draggedAssetId === targetAssetId) {
                return
            }

            try {
                await handleAssetDropReorder(draggedAssetId, targetAssetId, event.clientY)
            } catch (error) {
                console.error(error)
                alert("No se pudo reordenar el activo.")
            } finally {
                clearAssetDragState()
                draggedAssetId = null
            }
        })
    })

    if (!assetsList.dataset.dragBound) {
        assetsList.dataset.dragBound = "true"
        assetsList.addEventListener("dragover", (event) => {
            if (!draggedAssetId) {
                return
            }

            event.preventDefault()
        })
    }
}

function clearAssetDragState() {
    document.querySelectorAll(".assetBtn.dragOver, .assetBtn.dragging").forEach((button) => {
        button.classList.remove("dragOver", "dragging")
    })
}

async function handleAssetDropReorder(sourceAssetId, targetAssetId, pointerY) {
    const assets = await loadAssetsList()
    const orderedIds = assets.map((asset) => asset.id)
    const sourceIndex = orderedIds.indexOf(sourceAssetId)
    const targetIndex = orderedIds.indexOf(targetAssetId)

    if (sourceIndex === -1 || targetIndex === -1) {
        throw new Error("No se encontró el activo para reordenar")
    }

    orderedIds.splice(sourceIndex, 1)

    const targetButton = document.querySelector(`.assetBtn[data-asset-id="${targetAssetId}"]`)
    const targetRect = targetButton?.getBoundingClientRect()
    const insertAfterTarget = Boolean(targetRect && pointerY > targetRect.top + (targetRect.height / 2))
    let insertIndex = targetIndex

    if (insertAfterTarget) {
        insertIndex += 1
    }

    if (sourceIndex < targetIndex) {
        insertIndex -= 1
    }

    orderedIds.splice(Math.max(0, insertIndex), 0, sourceAssetId)
    await saveAssetOrderOnServer(orderedIds)
    await refreshAssetsSidebar(currentAssetId, false)
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

function formatPercent(value) {
    return new Intl.NumberFormat("es-ES", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(value) + " %"
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
            cripto: { netoActual: 0, invertidoNeto: 0, rendimiento: 0 },
            acciones: { netoActual: 0, invertidoNeto: 0, rendimiento: 0 },
            etfs: { netoActual: 0, invertidoNeto: 0, rendimiento: 0 },
            comoditis: { netoActual: 0, invertidoNeto: 0, rendimiento: 0 }
        }
    }
}

function updateTopMetricElement(elementId, value) {
    const element = document.getElementById(elementId)

    if (element) {
        element.textContent = value
    }
}

function applyTopPortfolioMetrics(metrics) {
    updateTopMetricElement("topTotalCuenta", formatEuro(metrics.totalCuenta))
    updateTopMetricElement("topPorcentajeCuenta", formatPercent(calculateYieldPercent(metrics.invertido, metrics.rendimiento)))
    updateTopMetricElement("topInvertido", formatEuro(metrics.invertido))

    updateTopMetricElement("topPorcentajeCripto", formatPercent(calculateYieldPercent(metrics.tipos.cripto.invertidoNeto, metrics.tipos.cripto.rendimiento)))
    updateTopMetricElement("topEurosCripto", formatEuro(metrics.tipos.cripto.invertidoNeto))
    updateTopMetricElement("topPorcentajeAcciones", formatPercent(calculateYieldPercent(metrics.tipos.acciones.invertidoNeto, metrics.tipos.acciones.rendimiento)))
    updateTopMetricElement("topEurosAcciones", formatEuro(metrics.tipos.acciones.invertidoNeto))
    updateTopMetricElement("topPorcentajeEtf", formatPercent(calculateYieldPercent(metrics.tipos.etfs.invertidoNeto, metrics.tipos.etfs.rendimiento)))
    updateTopMetricElement("topEurosEtf", formatEuro(metrics.tipos.etfs.invertidoNeto))
    updateTopMetricElement("topPorcentajeComoditis", formatPercent(calculateYieldPercent(metrics.tipos.comoditis.invertidoNeto, metrics.tipos.comoditis.rendimiento)))
    updateTopMetricElement("topEurosComoditis", formatEuro(metrics.tipos.comoditis.invertidoNeto))
}

async function refreshTopPortfolioMetrics(assets = null) {
    const baseAssets = Array.isArray(assets) ? assets : await loadAssetsList()

    if (!baseAssets.length) {
        applyTopPortfolioMetrics(createEmptyTopMetrics())
        return
    }

    const metrics = createEmptyTopMetrics()
    const fullAssets = await Promise.all(baseAssets.map((asset) => loadAssetData(asset.id)))

    fullAssets.forEach((asset) => {
        const summary = buildOverviewRow(asset)
        metrics.totalCuenta += summary.netoActual
        metrics.invertido += summary.invertidoNeto
        metrics.rendimiento += summary.rendimiento

        if (metrics.tipos[summary.assetType]) {
            metrics.tipos[summary.assetType].netoActual += summary.netoActual
            metrics.tipos[summary.assetType].invertidoNeto += summary.invertidoNeto
            metrics.tipos[summary.assetType].rendimiento += summary.rendimiento
        }
    })

    applyTopPortfolioMetrics(metrics)
}

async function initVistaGeneralLogic() {
    const filtersContainer = document.getElementById("overviewFilters")

    if (filtersContainer && !filtersContainer.dataset.bound) {
        filtersContainer.dataset.bound = "true"
        filtersContainer.addEventListener("change", () => {
            renderVistaGeneralTable()
        })
    }

    await renderVistaGeneralTable()
}

function getSelectedOverviewTypes() {
    return [...document.querySelectorAll('#overviewFilters input[type="checkbox"]:checked')].map((input) => input.value)
}

function parseParticipationNumber(value) {
    const cleanValue = String(value || "")
        .replace(/\s/g, "")
        .replace(/\./g, "")
        .replace(",", ".")

    const parsedValue = parseFloat(cleanValue)
    return Number.isNaN(parsedValue) ? 0 : parsedValue
}

function getSignedParticipation(row) {
    const participaciones = parseParticipationNumber(row.participaciones)
    const operationType = (row.tipoOperacion || "").trim().toLowerCase()

    if (operationType.includes("venta")) {
        return participaciones * -1
    }

    return participaciones
}

function buildOverviewRow(asset) {
    const rows = Array.isArray(asset.rows) ? asset.rows : []
    const participaciones = rows.reduce((total, row) => total + getSignedParticipation(row), 0)
    const invertidoBruto = rows.reduce((total, row) => total + (parseLooseNumber(row.capitalInvertidoBruto || "") || 0), 0)
    const comisiones = rows.reduce((total, row) => total + (parseLooseNumber(row.comisiones || "") || 0), 0)
    const invertidoNeto = invertidoBruto - comisiones
    const valorActual = parseLooseNumber(asset.price || "") || 0
    const netoActual = participaciones * valorActual
    const promedioCompra = participaciones > 0 ? invertidoBruto / participaciones : 0
    const rendimiento = netoActual - invertidoNeto

    return {
        nombre: asset.name || asset.symbol || "Activo",
        tipo: buildAssetTypeLabel(asset.type),
        assetType: asset.type,
        participaciones,
        promedioCompra,
        valorActual,
        currency: asset.currency || "EUR",
        invertidoBruto,
        comisiones,
        invertidoNeto,
        netoActual,
        rendimiento
    }
}

function renderOverviewRows(rows) {
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

    rows.forEach((row) => {
        const tr = document.createElement("tr")
        const profitClass = row.rendimiento >= 0 ? "overviewProfitPositive" : "overviewProfitNegative"

        tr.innerHTML = `
            <td>${row.nombre}</td>
            <td>${row.tipo}</td>
            <td class="overviewNumericCell">${normalizeNumberForEdit(row.participaciones.toFixed(6))}</td>
            <td class="overviewNumericCell">${formatMoney(row.promedioCompra, row.currency)}</td>
            <td class="overviewNumericCell overviewCurrentPriceCell">${formatMoney(row.valorActual, row.currency)}</td>
            <td class="overviewNumericCell">${formatMoney(row.invertidoBruto, row.currency)}</td>
            <td class="overviewNumericCell">${formatMoney(row.comisiones, row.currency)}</td>
            <td class="overviewNumericCell">${formatMoney(row.invertidoNeto, row.currency)}</td>
            <td class="overviewNumericCell">${formatMoney(row.netoActual, row.currency)}</td>
            <td class="overviewNumericCell ${profitClass}">${formatMoney(row.rendimiento, row.currency)}</td>
        `

        tableBody.appendChild(tr)
    })
}

async function renderVistaGeneralTable() {
    const tableBody = document.getElementById("overviewTableBody")

    if (!tableBody) {
        return
    }

    try {
        const assets = await loadAssetsList()
        const selectedTypes = new Set(getSelectedOverviewTypes())

        if (!selectedTypes.size) {
            renderOverviewRows([])
            return
        }

        const fullAssets = await Promise.all(assets.map((asset) => loadAssetData(asset.id)))
        const rows = fullAssets
            .filter((asset) => selectedTypes.has(asset.type))
            .map((asset) => buildOverviewRow(asset))

        renderOverviewRows(rows)
    } catch (error) {
        console.error("Error cargando vista general:", error)
    }
}

function renderAssetTablePage(asset) {
    const contentArea = document.getElementById("dynamicContent")

    if (!contentArea) {
        return
    }

    contentArea.innerHTML = `
        <section class="assetTablePage" data-asset-id="${asset.id}" data-asset-type="${asset.type}" data-asset-name="${asset.name}" data-asset-symbol="${asset.symbol}" data-asset-price="${asset.price || "0,00"}" data-asset-currency="${asset.currency || "USD"}" data-asset-change="${asset.change || "+0,00%"}" data-asset-status="${asset.status || "Mercado abierto"}" data-asset-finnhub-symbol="${asset.finnhubSymbol || ""}">
            <div class="assetPageHeader">
                <div>
                    <h1 class="assetPageTitle">${asset.symbol || asset.name}</h1>
                    <div class="assetPageSubtitle">${asset.name} · ${buildAssetTypeLabel(asset.type)}</div>
                </div>
                <div class="assetMarketPanel">
                    <label class="assetModalLabel" for="assetFinnhubSymbolInput">Ticker Finnhub</label>
                    <input id="assetFinnhubSymbolInput" class="assetModalInput assetInlineInput" type="text" value="${asset.finnhubSymbol || ""}" placeholder="Ej: MSFT o BINANCE:BTCUSDT">
                    <div class="assetSearchActions">
                        <button id="searchCurrentAssetTickerBtn" class="secondaryButton" type="button">Buscar ticker</button>
                    </div>
                    <div id="currentAssetSearchFeedback" class="assetSearchFeedback hidden"></div>
                    <div id="currentAssetSearchResults" class="assetSearchResults hidden"></div>
                    <div class="assetQuoteSummary">
                        <span>Precio: ${formatMoney(parseLooseNumber(asset.price || "0") || 0, asset.currency || "EUR")}</span>
                        <span>Cambio: ${asset.change || "+0,00%"}</span>
                        <span>Divisa: ${asset.currency || "EUR"}</span>
                        <span>Estado: ${asset.status || "Sin actualizar"}</span>
                    </div>
                </div>
            </div>

            <div class="assetTableWrapper">
                <table class="assetOperationsTable">
                    <thead>
                        <tr>
                            <th class="rowActionHeader"></th>
                            <th>Fecha operación</th>
                            <th>Tipo de operación</th>
                            <th>Participaciones</th>
                            <th>Precio Participación</th>
                            <th>Capital Invertido bruto</th>
                            <th>Comisiones</th>
                            <th>Capital Invertido neto</th>
                        </tr>
                    </thead>
                    <tbody id="assetOperationsBody"></tbody>
                </table>
            </div>

            <div class="assetActions">
                <button id="refreshAssetMarketBtn" class="primaryButton">Actualizar cotización</button>
                <button id="addAssetRowBtn" class="primaryButton">Añadir fila</button>
                <button id="saveAssetBtn" class="secondaryButton">Guardar JSON</button>
                <button id="deleteAssetBtn" class="dangerButton">Eliminar activo</button>
            </div>
        </section>
    `

    renderAssetRows(asset.rows || [])
    initAssetTableLogic(asset)
}

function renderAssetRows(rows) {
    const assetOperationsBody = document.getElementById("assetOperationsBody")
    const assetPage = document.querySelector(".assetTablePage")
    const assetCurrency = assetPage?.dataset.assetCurrency || "EUR"

    if (!assetOperationsBody) {
        return
    }

    assetOperationsBody.innerHTML = ""

    rows.forEach((rowData) => {
        const rowElement = document.createElement("tr")
        rowElement.innerHTML = `
            <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
            <td contenteditable="true">${rowData.fechaOperacion || ""}</td>
            <td contenteditable="true">${rowData.tipoOperacion || "Compra"}</td>
            <td contenteditable="true">${rowData.participaciones || ""}</td>
            <td contenteditable="true">${formatCellMoneyValue(rowData.precioParticipacion, assetCurrency)}</td>
            <td contenteditable="true">${formatCellMoneyValue(rowData.capitalInvertidoBruto, assetCurrency)}</td>
            <td contenteditable="true">${formatCellMoneyValue(rowData.comisiones, assetCurrency)}</td>
            <td class="rowTotal">${formatMoney(0, assetCurrency)}</td>
        `
        assetOperationsBody.appendChild(rowElement)
    })

    updateAssetTableTotals()
}

function collectAssetRowsFromTable() {
    const rowElements = [...document.querySelectorAll("#assetOperationsBody tr")]

    return rowElements.map((rowElement) => {
        const cells = rowElement.querySelectorAll("td")

        return {
            fechaOperacion: cells[1]?.textContent.trim() || "",
            tipoOperacion: cells[2]?.textContent.trim() || "",
            participaciones: cells[3]?.textContent.trim() || "",
            precioParticipacion: cells[4]?.textContent.trim() || "",
            capitalInvertidoBruto: cells[5]?.textContent.trim() || "",
            comisiones: cells[6]?.textContent.trim() || ""
        }
    })
}

function isPlaceholderValue(value, placeholders = []) {
    return placeholders.includes((value || "").trim().toLowerCase())
}

function isEmptyInteresesRow(rowElement) {
    const cells = rowElement.querySelectorAll("td")
    const fecha = cells[1]?.textContent.trim() || ""
    const saldoPromedio = parseEuroNumber(cells[2]?.textContent || "")
    const acumulado = parseEuroNumber(cells[3]?.textContent || "")
    const impuestos = parseEuroNumber(cells[4]?.textContent || "")

    return (!fecha || isPlaceholderValue(fecha, ["nuevo-mes"])) &&
        saldoPromedio === 0 &&
        acumulado === 0 &&
        impuestos === 0
}

function isEmptyDividendosRow(rowElement) {
    const cells = rowElement.querySelectorAll("td")
    const fecha = cells[1]?.textContent.trim() || ""
    const instrumento = cells[2]?.textContent.trim() || ""
    const acciones = parseFloat((cells[3]?.textContent || "0").replace(",", ".")) || 0
    const dividendoAccion = parseDollarNumber(cells[4]?.textContent || "")
    const impuestos = parseEuroNumber(cells[5]?.textContent || "")
    const total = parseEuroNumber(cells[6]?.textContent || "")

    return (!fecha || isPlaceholderValue(fecha, ["nueva-fecha"])) &&
        (!instrumento || isPlaceholderValue(instrumento, ["instrumento"])) &&
        acciones === 0 &&
        dividendoAccion === 0 &&
        impuestos === 0 &&
        total === 0
}

function isEmptyAssetRow(rowElement) {
    const cells = rowElement.querySelectorAll("td")
    const fechaOperacion = cells[1]?.textContent.trim() || ""
    const tipoOperacion = cells[2]?.textContent.trim() || ""
    const participaciones = parseFloat((cells[3]?.textContent || "0").replace(",", ".")) || 0
    const precioParticipacion = parseEuroNumber(cells[4]?.textContent || "")
    const capitalInvertidoBruto = parseEuroNumber(cells[5]?.textContent || "")
    const comisiones = parseEuroNumber(cells[6]?.textContent || "")

    return !fechaOperacion &&
        (!tipoOperacion || isPlaceholderValue(tipoOperacion, ["compra"])) &&
        participaciones === 0 &&
        precioParticipacion === 0 &&
        capitalInvertidoBruto === 0 &&
        comisiones === 0
}

function handleRowDeleteClick(event) {
    const deleteButton = event.target.closest(".rowDeleteBtn")

    if (!deleteButton) {
        return
    }

    const rowElement = deleteButton.closest("tr")
    const tableBody = rowElement?.closest("tbody")

    if (!rowElement || !tableBody) {
        return
    }

    let isEmptyRow = false

    if (tableBody.id === "interesesBody") {
        isEmptyRow = isEmptyInteresesRow(rowElement)
    } else if (tableBody.id === "dividendosBody") {
        isEmptyRow = isEmptyDividendosRow(rowElement)
    } else if (tableBody.id === "assetOperationsBody") {
        isEmptyRow = isEmptyAssetRow(rowElement)
    }

    const removeRow = () => {
        rowElement.remove()

        if (tableBody.id === "interesesBody") {
            updateTotals()
            return
        }

        if (tableBody.id === "dividendosBody") {
            updateDividendosTotals()
            scheduleDividendosAutosave()
            return
        }

        if (tableBody.id === "assetOperationsBody") {
            updateAssetTableTotals()
            scheduleAssetAutosave()
        }
    }

    if (isEmptyRow) {
        removeRow()
        return
    }

    openConfirmModal({
        title: "Eliminar fila",
        message: "Esta fila tiene contenido. ¿Quieres eliminarla?",
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            removeRow()
        }
    })
}

function buildCurrentAssetPayload() {
    const assetPage = document.querySelector(".assetTablePage")
    const finnhubSymbolInput = document.getElementById("assetFinnhubSymbolInput")

    return {
        id: currentAssetId,
        name: assetPage?.dataset.assetName || document.getElementById("detName")?.textContent.trim() || "Activo",
        symbol: assetPage?.dataset.assetSymbol || document.getElementById("detSymbol")?.textContent.trim() || "ACTIVO",
        finnhubSymbol: (finnhubSymbolInput?.value || assetPage?.dataset.assetFinnhubSymbol || "").trim().toUpperCase(),
        type: assetPage?.dataset.assetType || "cripto",
        price: assetPage?.dataset.assetPrice || "0,00",
        currency: assetPage?.dataset.assetCurrency || "USD",
        change: assetPage?.dataset.assetChange || "+0,00%",
        status: assetPage?.dataset.assetStatus || "Mercado abierto",
        order: Number(document.querySelector(`.assetBtn[data-asset-id="${currentAssetId}"]`)?.dataset.assetOrder || 0),
        rows: collectAssetRowsFromTable()
    }
}

function updateAssetTableTotals() {
    const rowElements = document.querySelectorAll("#assetOperationsBody tr")
    const assetCurrency = document.querySelector(".assetTablePage")?.dataset.assetCurrency || "EUR"

    rowElements.forEach((rowElement) => {
        const cells = rowElement.querySelectorAll("td")
        const bruto = parseLooseNumber(cells[5]?.textContent || "") || 0
        const comisiones = parseLooseNumber(cells[6]?.textContent || "") || 0
        const neto = bruto - comisiones

        if (cells[7]) {
            cells[7].textContent = formatMoney(neto, assetCurrency)
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

function renderFinnhubSearchResults(container, results, onSelect) {
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
        button.innerHTML = `
            <span class="assetSearchResultTitle">${result.symbol}</span>
            <span class="assetSearchResultSubtitle">${result.description}</span>
            <span class="assetSearchResultMeta">${result.type || "market"}</span>
        `
        button.addEventListener("click", () => {
            onSelect(result)
        })
        container.appendChild(button)
    })

    container.classList.remove("hidden")
}

async function handleFinnhubSearch({ query, feedbackElement, resultsElement, onSelect }) {
    const normalizedQuery = String(query || "").trim()

    if (!normalizedQuery) {
        setAssetSearchFeedback(feedbackElement, "Escribe el nombre o ticker del activo.", true)
        renderFinnhubSearchResults(resultsElement, [], onSelect)
        return
    }

    setAssetSearchFeedback(feedbackElement, "Buscando en Finnhub...")

    try {
        const response = await searchFinnhubSymbolOnServer(normalizedQuery)
        const results = Array.isArray(response.results) ? response.results : []

        if (!results.length) {
            setAssetSearchFeedback(feedbackElement, "No se encontraron resultados para esa búsqueda.", true)
            renderFinnhubSearchResults(resultsElement, [], onSelect)
            return
        }

        setAssetSearchFeedback(feedbackElement, "Selecciona el ticker correcto.")
        renderFinnhubSearchResults(resultsElement, results, onSelect)
    } catch (error) {
        console.error(error)
        setAssetSearchFeedback(feedbackElement, "No se pudo consultar Finnhub. Revisa la API key.", true)
        renderFinnhubSearchResults(resultsElement, [], onSelect)
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
        updateAssetDetail(response.asset)
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

function addNewAssetRow() {
    const assetOperationsBody = document.getElementById("assetOperationsBody")
    const assetCurrency = document.querySelector(".assetTablePage")?.dataset.assetCurrency || "EUR"

    if (!assetOperationsBody) {
        return
    }

    const rowElement = document.createElement("tr")
    rowElement.innerHTML = `
        <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
        <td contenteditable="true"></td>
        <td contenteditable="true">Compra</td>
        <td contenteditable="true"></td>
        <td contenteditable="true"></td>
        <td contenteditable="true"></td>
        <td contenteditable="true"></td>
        <td class="rowTotal">${formatMoney(0, assetCurrency)}</td>
    `

    assetOperationsBody.appendChild(rowElement)
    updateAssetTableTotals()
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
            console.error("Error en autoguardado del activo:", error)
        }
    }, 500)
}

function initAssetTableLogic(asset) {
    currentAssetId = asset.id

    const assetOperationsBody = document.getElementById("assetOperationsBody")
    const addAssetRowButton = document.getElementById("addAssetRowBtn")
    const refreshAssetMarketButton = document.getElementById("refreshAssetMarketBtn")
    const saveAssetButton = document.getElementById("saveAssetBtn")
    const deleteAssetButton = document.getElementById("deleteAssetBtn")
    const assetFinnhubSymbolInput = document.getElementById("assetFinnhubSymbolInput")
    const searchCurrentAssetTickerButton = document.getElementById("searchCurrentAssetTickerBtn")
    const currentAssetSearchFeedback = document.getElementById("currentAssetSearchFeedback")
    const currentAssetSearchResults = document.getElementById("currentAssetSearchResults")

    if (assetOperationsBody) {
        assetOperationsBody.addEventListener("input", () => {
            updateAssetTableTotals()
            scheduleAssetAutosave()
        })

        assetOperationsBody.addEventListener("click", handleRowDeleteClick)
        assetOperationsBody.addEventListener("focus", handleCellFocus, true)
        assetOperationsBody.addEventListener("blur", (event) => {
            handleCellBlur(event)
            scheduleAssetAutosave()
        }, true)
    }

    if (assetFinnhubSymbolInput) {
        assetFinnhubSymbolInput.addEventListener("input", () => {
            scheduleAssetAutosave()
        })

        assetFinnhubSymbolInput.addEventListener("blur", async () => {
            assetFinnhubSymbolInput.value = assetFinnhubSymbolInput.value.trim().toUpperCase()
            scheduleAssetAutosave()
        })
    }

    if (addAssetRowButton) {
        addAssetRowButton.addEventListener("click", () => {
            addNewAssetRow()
            scheduleAssetAutosave()
        })
    }

    if (refreshAssetMarketButton) {
        refreshAssetMarketButton.addEventListener("click", async () => {
            await refreshCurrentAssetMarketData()
        })
    }

    if (searchCurrentAssetTickerButton) {
        searchCurrentAssetTickerButton.addEventListener("click", async () => {
            await handleFinnhubSearch({
                query: assetFinnhubSymbolInput?.value || asset.name || asset.symbol || "",
                feedbackElement: currentAssetSearchFeedback,
                resultsElement: currentAssetSearchResults,
                onSelect: (result) => {
                    if (assetFinnhubSymbolInput) {
                        assetFinnhubSymbolInput.value = result.symbol
                    }

                    setAssetSearchFeedback(currentAssetSearchFeedback, `Ticker seleccionado: ${result.symbol}. Actualizando cotización...`)
                    renderFinnhubSearchResults(currentAssetSearchResults, [], () => {})
                    refreshCurrentAssetMarketData({
                        feedbackElement: currentAssetSearchFeedback,
                        successMessage: `Cotización actualizada con ${result.symbol}.`
                    })
                }
            })
        })
    }

    if (saveAssetButton) {
        saveAssetButton.addEventListener("click", async () => {
            await saveAssetDataToServer(buildCurrentAssetPayload())
            await refreshAssetsSidebar(currentAssetId, false)
            alert("JSON del activo guardado")
        })
    }

    if (deleteAssetButton) {
        deleteAssetButton.addEventListener("click", () => {
            const rows = collectAssetRowsFromTable()
            const hasContent = rows.some((row) => {
                return row.fechaOperacion.trim() !== "" ||
                    !isPlaceholderValue(row.tipoOperacion, ["", "compra"]) ||
                    row.participaciones.trim() !== "" ||
                    parseEuroNumber(row.precioParticipacion) !== 0 ||
                    parseEuroNumber(row.capitalInvertidoBruto) !== 0 ||
                    parseEuroNumber(row.comisiones) !== 0
            })

            openConfirmModal({
                title: "Eliminar activo",
                message: hasContent
                    ? "Este activo tiene contenido guardado. ¿Quieres eliminarlo igualmente?"
                    : "¿Quieres eliminar este activo?",
                confirmLabel: "Eliminar",
                confirmSide: "right",
                onConfirm: async () => {
                    openConfirmModal({
                        title: "Segunda verificación",
                        message: "Esta acción eliminará el activo de forma definitiva. ¿Confirmas que quieres borrarlo?",
                        confirmLabel: "Eliminar",
                        confirmSide: "left",
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
                }
            })
        })
    }
}

function openAssetModal() {
    const assetModalOverlay = document.getElementById("assetModalOverlay")
    const assetNameInput = document.getElementById("assetNameInput")
    const assetTypeSelect = document.getElementById("assetTypeSelect")
    const assetTickerInput = document.getElementById("assetTickerInput")
    const assetSearchFeedback = document.getElementById("assetSearchFeedback")
    const assetSearchResults = document.getElementById("assetSearchResults")

    if (!assetModalOverlay || !assetNameInput || !assetTypeSelect || !assetTickerInput || !assetSearchFeedback || !assetSearchResults) {
        return
    }

    assetNameInput.value = ""
    assetTypeSelect.value = "cripto"
    assetTickerInput.value = ""
    setAssetSearchFeedback(assetSearchFeedback, "")
    renderFinnhubSearchResults(assetSearchResults, [], () => {})
    assetModalOverlay.classList.remove("hidden")
    assetModalState = { isOpen: true }
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

function openConfirmModal({ title = "Confirmar acción", message = "¿Seguro que quieres continuar?", confirmLabel = "Confirmar", onConfirm, confirmSide = "left" }) {
    const confirmModalOverlay = document.getElementById("confirmModalOverlay")
    const confirmModalTitle = document.getElementById("confirmModalTitle")
    const confirmModalMessage = document.getElementById("confirmModalMessage")
    const confirmModalAcceptButton = document.getElementById("confirmModalAcceptBtn")
    const confirmModalActions = document.querySelector(".confirmModalActions")

    if (!confirmModalOverlay || !confirmModalTitle || !confirmModalMessage || !confirmModalAcceptButton || !confirmModalActions) {
        return
    }

    confirmModalTitle.textContent = title
    confirmModalMessage.textContent = message
    confirmModalAcceptButton.textContent = confirmLabel
    confirmModalActions.classList.toggle("confirmPrimaryRight", confirmSide === "right")
    confirmModalOverlay.classList.remove("hidden")
    confirmModalState = { onConfirm }
}

function closeConfirmModal() {
    const confirmModalOverlay = document.getElementById("confirmModalOverlay")

    if (!confirmModalOverlay) {
        return
    }

    confirmModalOverlay.classList.add("hidden")
    document.querySelector(".confirmModalActions")?.classList.remove("confirmPrimaryRight")
    confirmModalState = null
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
}

async function submitAssetModal() {
    const assetNameInput = document.getElementById("assetNameInput")
    const assetTypeSelect = document.getElementById("assetTypeSelect")
    const assetTickerInput = document.getElementById("assetTickerInput")

    if (!assetNameInput || !assetTypeSelect || !assetTickerInput) {
        return
    }

    const name = assetNameInput.value.trim()
    const type = assetTypeSelect.value.trim()
    const finnhubSymbol = assetTickerInput.value.trim().toUpperCase()

    if (!name) {
        assetNameInput.focus()
        return
    }

    try {
        const response = await createAssetOnServer(name, type, finnhubSymbol)
        const createdAsset = response.asset
        closeAssetModal()
        currentAssetId = createdAsset.id
        await refreshAssetsSidebar(createdAsset.id, true)
    } catch (error) {
        console.error(error)
        alert("No se pudo crear el activo.")
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

function initAssetModal(assetModalOverlay, confirmAssetModalButton, cancelAssetModalButton, assetNameInput, assetTypeSelect, assetTickerInput, searchAssetTickerButton) {
    const assetSearchFeedback = document.getElementById("assetSearchFeedback")
    const assetSearchResults = document.getElementById("assetSearchResults")

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

    if (assetModalOverlay) {
        assetModalOverlay.addEventListener("click", (event) => {
            if (event.target === assetModalOverlay) {
                closeAssetModal()
            }
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

    if (searchAssetTickerButton) {
        searchAssetTickerButton.addEventListener("click", async () => {
            await handleFinnhubSearch({
                query: assetTickerInput?.value || assetNameInput?.value || "",
                feedbackElement: assetSearchFeedback,
                resultsElement: assetSearchResults,
                onSelect: (result) => {
                    if (assetTickerInput) {
                        assetTickerInput.value = result.symbol
                    }

                    if (assetNameInput && !assetNameInput.value.trim()) {
                        assetNameInput.value = result.description
                    }

                    setAssetSearchFeedback(assetSearchFeedback, `Ticker seleccionado: ${result.symbol}`)
                    renderFinnhubSearchResults(assetSearchResults, [], () => {})
                }
            })
        })
    }

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && assetModalState?.isOpen) {
            closeAssetModal()
            return
        }

        if (event.key === "Escape" && confirmModalState) {
            closeConfirmModal()
        }
    })
}

