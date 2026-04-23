const SALES_TAX_BRACKETS = [
    { key: "tramo1", limit: 6000, rate: 0.19 },
    { key: "tramo2", limit: 50000, rate: 0.21 },
    { key: "tramo3", limit: 200000, rate: 0.23 },
    { key: "tramo4", limit: 300000, rate: 0.27 },
    { key: "tramo5", limit: Number.POSITIVE_INFINITY, rate: 0.28 }
]

let currentVentasData = { rows: [] }
let ventasAutosaveTimeout = null
let ventasPersistenceBound = false
let ventasAssets = []
let ventasAssetDetails = new Map()
let ventasYears = []
let currentVentasYear = null
let ventasModalKeyHandler = null

function escapeVentasHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

async function loadVentasIndex() {
    const response = await fetch("/api/ventas")

    if (!response.ok) {
        throw new Error("No se pudieron cargar las ventas")
    }

    return await response.json()
}

async function loadVentasYear(year) {
    const response = await fetch(`/api/ventas/${year}`)

    if (!response.ok) {
        throw new Error("No se pudo cargar el año de ventas")
    }

    return await response.json()
}

async function createVentasYear(year) {
    const response = await fetch("/api/ventas", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ year })
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

async function saveVentasData(year, payload, options = {}) {
    const response = await fetch(`/api/ventas/${year}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        keepalive: Boolean(options.keepalive)
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
}

async function deleteVentasYearRequest(year) {
    const response = await fetch(`/api/ventas/${year}`, {
        method: "DELETE"
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

async function loadVentasAssets() {
    const response = await fetch("/api/activos")

    if (!response.ok) {
        throw new Error("No se pudieron cargar los activos")
    }

    const payload = await response.json()
    ventasAssets = Array.isArray(payload?.assets) ? payload.assets : []

    const details = await Promise.all(
        ventasAssets.map(async (asset) => {
            const assetResponse = await fetch(`/api/activos/${asset.id}`)

            if (!assetResponse.ok) {
                return null
            }

            return await assetResponse.json()
        })
    )

    ventasAssetDetails = new Map()
    details.filter(Boolean).forEach((asset) => {
        ventasAssetDetails.set(asset.id, asset)
    })
}

async function initVentasLogic() {
    const [ventasIndex] = await Promise.all([
        loadVentasIndex(),
        loadVentasAssets()
    ])

    ventasYears = Array.isArray(ventasIndex?.years) ? ventasIndex.years : []
    currentVentasYear = ventasYears[0] || "2026"
    const ventasPayload = await loadVentasYear(currentVentasYear)

    currentVentasData = {
        year: ventasPayload?.year || currentVentasYear,
        rows: Array.isArray(ventasPayload?.rows) ? ventasPayload.rows.map(normalizeVentaRow) : []
    }

    bindVentasPersistenceGuards()
    window.flushPendingPageChanges = flushVentasPendingChanges
    renderVentasYearButtons()
    renderVentasTable()
    bindVentasEvents()
}

function bindVentasEvents() {
    const ventasBody = document.getElementById("ventasBody")
    const addYearButton = document.getElementById("addVentasYearBtn")
    const deleteYearButton = document.getElementById("deleteVentasYearBtn")
    const addButton = document.getElementById("addVentaRowBtn")
    const saveButton = document.getElementById("saveVentasBtn")
    if (ventasBody && !ventasBody.dataset.bound) {
        ventasBody.dataset.bound = "true"
        ventasBody.addEventListener("click", handleVentasActionClick)
    }

    if (addYearButton && !addYearButton.dataset.bound) {
        addYearButton.dataset.bound = "true"
        addYearButton.addEventListener("click", async () => {
            const suggestedYear = String(new Date().getFullYear())
            const year = prompt("Escribe el nuevo año (YYYY)", suggestedYear)?.trim()

            if (!year) {
                return
            }

            try {
                await persistVentasData()
                await createVentasYear(year)
                ventasYears = (await loadVentasIndex()).years || []
                await renderVentasYear(year)
            } catch (error) {
                console.error(error)
                alert("No se pudo crear el año.")
            }
        })
    }

    if (deleteYearButton && !deleteYearButton.dataset.bound) {
        deleteYearButton.dataset.bound = "true"
        deleteYearButton.addEventListener("click", () => {
            openConfirmModal({
                title: "Eliminar año",
                message: `Vas a eliminar el año ${currentVentasYear}. ¿Quieres continuar?`,
                confirmLabel: "Eliminar",
                confirmSide: "right",
                onConfirm: async () => {
                    openConfirmModal({
                        title: "Segunda verificación",
                        message: `Esta acción borrará definitivamente el año ${currentVentasYear}. ¿Confirmas que quieres eliminarlo?`,
                        confirmLabel: "Eliminar",
                        confirmSide: "left",
                        onConfirm: async () => {
                            const response = await deleteVentasYearRequest(currentVentasYear)
                            ventasYears = Array.isArray(response.years) ? response.years : (await loadVentasIndex()).years || []
                            await renderVentasYear(ventasYears[0] || "2026")
                        }
                    })
                }
            })
        })
    }

    if (addButton && !addButton.dataset.bound) {
        addButton.dataset.bound = "true"
        addButton.addEventListener("click", () => {
            openVentasModal(-1)
        })
    }

    if (saveButton && !saveButton.dataset.bound) {
        saveButton.dataset.bound = "true"
        saveButton.addEventListener("click", async () => {
            try {
                await persistVentasData()
                alert(`Datos guardados en ventas/ventas${currentVentasYear}.json`)
            } catch (error) {
                console.error(error)
                alert("No se pudieron guardar las ventas.")
            }
        })
    }

}

function closeVentasModal() {
    document.getElementById("ventasModalOverlay")?.remove()

    if (ventasModalKeyHandler) {
        document.removeEventListener("keydown", ventasModalKeyHandler)
        ventasModalKeyHandler = null
    }
}

function buildVentasAssetOptions(selectedAssetId) {
    const selectedId = String(selectedAssetId || "")
    const hasSelectedAsset = ventasAssets.some((asset) => asset.id === selectedId)
    const currentLabel = selectedId && !hasSelectedAsset ? getVentasAssetName(selectedId) || selectedId : ""

    return `
        <option value="">Selecciona activo</option>
        ${currentLabel ? `<option value="${escapeVentasHtml(selectedId)}" selected>${escapeVentasHtml(currentLabel)}</option>` : ""}
        ${ventasAssets.map((asset) => `<option value="${escapeVentasHtml(asset.id)}"${asset.id === selectedId ? " selected" : ""}>${escapeVentasHtml(asset.name)}</option>`).join("")}
    `
}

function openVentasModal(rowIndex = -1) {
    closeVentasModal()

    const rows = currentVentasData.rows || []
    const isEdit = rowIndex >= 0
    const rowData = isEdit ? { ...rows[rowIndex] } : createEmptyVentaRow()

    const overlay = document.createElement("div")
    overlay.id = "ventasModalOverlay"
    overlay.className = "modalOverlay"

    const modal = document.createElement("div")
    modal.className = "assetModal ventasCreateModal"
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.innerHTML = `
        <h3 class="assetModalTitle">${isEdit ? "Editar venta" : "Añadir venta"}</h3>
        <label class="assetModalLabel" for="ventaFechaInput">Fecha venta</label>
        <input id="ventaFechaInput" class="assetModalInput" type="text" value="${escapeVentasHtml(rowData.fecha || "")}" placeholder="dd-mm-aaaa">
        <label class="assetModalLabel" for="ventaActivoInput">Activo</label>
        <select id="ventaActivoInput" class="assetModalSelect">
            ${buildVentasAssetOptions(rowData.assetId || "")}
        </select>
        <label class="assetModalLabel" for="ventaCantidadInput">Cantidad</label>
        <input id="ventaCantidadInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeVentasHtml(formatVentasNumber(rowData.cantidad) || "")}" placeholder="0">
        <label class="assetModalLabel" for="ventaValorInput">Valor de venta</label>
        <input id="ventaValorInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeVentasHtml(formatVentasMoney(rowData.valorVenta) || "")}" placeholder="0,00">
        <p class="gastosCreateModalFeedback hidden" id="ventasModalFeedback"></p>
        <div class="assetModalActions ventasModalActions">
            <button type="button" class="secondaryButton" id="ventasModalCancelBtn">Cancelar</button>
            <button type="button" class="primaryButton" id="ventasModalSaveBtn" data-no-autohide="true">Guardar</button>
        </div>
    `

    const setFeedback = (message = "", isError = false) => {
        const node = modal.querySelector("#ventasModalFeedback")
        if (!node) return
        node.textContent = message
        node.classList.toggle("hidden", !message)
        node.classList.toggle("error", Boolean(message && isError))
    }

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeVentasModal()
    })

    modal.querySelector("#ventasModalCancelBtn")?.addEventListener("click", closeVentasModal)
    modal.querySelector("#ventasModalSaveBtn")?.addEventListener("click", async () => {
        const fecha = modal.querySelector("#ventaFechaInput")?.value.trim() || ""
        const assetId = modal.querySelector("#ventaActivoInput")?.value.trim() || ""
        const cantidadRaw = modal.querySelector("#ventaCantidadInput")?.value.trim() || ""
        const valorVentaRaw = modal.querySelector("#ventaValorInput")?.value.trim() || ""
        const cantidad = cantidadRaw ? formatVentasNumber(cantidadRaw) : ""
        const valorVenta = valorVentaRaw ? stripCurrencyText(formatVentasMoney(valorVentaRaw)) : ""

        if (!fecha && !assetId && !cantidad && !valorVenta) {
            setFeedback("Introduce al menos un dato.", true)
            return
        }

        const nextRow = normalizeVentaRow({
            id: rowData.id,
            fecha,
            assetId,
            activo: getVentasAssetName(assetId),
            cantidad,
            valorVenta
        })

        if (isEdit) {
            currentVentasData.rows[rowIndex] = nextRow
        } else {
            currentVentasData.rows.push(nextRow)
        }

        try {
            renderVentasTable()
            await persistVentasData()
            closeVentasModal()
        } catch (error) {
            console.error(error)
            setFeedback("No se pudo guardar.", true)
        }
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    ventasModalKeyHandler = (event) => {
        if (event.key === "Escape") closeVentasModal()
    }
    document.addEventListener("keydown", ventasModalKeyHandler)

    modal.querySelector("input, select")?.focus()
}

async function renderVentasYear(year) {
    const payload = await loadVentasYear(year)
    currentVentasYear = payload?.year || year
    currentVentasData = {
        year: currentVentasYear,
        rows: Array.isArray(payload?.rows) ? payload.rows.map(normalizeVentaRow) : []
    }
    renderVentasYearButtons()
    renderVentasTable()
}

function renderVentasYearButtons() {
    const list = document.getElementById("ventasYearList")

    if (!list) {
        return
    }

    list.innerHTML = ""

    ventasYears.forEach((year) => {
        const button = document.createElement("button")
        button.type = "button"
        button.className = `gastosYearBtn${year === currentVentasYear ? " active" : ""}`
        button.textContent = year
        button.addEventListener("click", async () => {
            await persistVentasData()
            await renderVentasYear(year)
        })
        list.appendChild(button)
    })
}

function createEmptyVentaRow() {
    return normalizeVentaRow({
        id: `venta-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        fecha: "",
        assetId: "",
        activo: "",
        cantidad: "",
        valorVenta: ""
    })
}

function normalizeVentaRow(row = {}) {
    const assetId = String(row.assetId || getVentasAssetIdByName(row.activo) || "")
    const activo = String(row.activo || getVentasAssetName(assetId) || "")

    return {
        id: String(row.id || `venta-${Date.now()}`),
        fecha: String(row.fecha || ""),
        assetId,
        activo,
        cantidad: String(row.cantidad || ""),
        valorVenta: String(row.valorVenta || row.precioVenta || row.valor_venta || "")
    }
}

function getVentasAssetIdByName(assetName) {
    const normalizedName = String(assetName || "").trim().toLowerCase()
    const asset = ventasAssets.find((item) => item.name.trim().toLowerCase() === normalizedName || item.symbol.trim().toLowerCase() === normalizedName)
    return asset?.id || ""
}

function getVentasAssetName(assetId) {
    const asset = ventasAssets.find((item) => item.id === assetId)
    return asset?.name || ""
}

function parseSalesDate(value) {
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

function buildBaseAssetLots(assetId) {
    const asset = ventasAssetDetails.get(assetId)

    if (!asset) {
        return []
    }

    const rows = Array.isArray(asset.rows) ? [...asset.rows] : []
    rows.sort((left, right) => parseSalesDate(left.fechaOperacion) - parseSalesDate(right.fechaOperacion))

    const lots = []

    rows.forEach((row) => {
        const operationType = String(row.tipoOperacion || "").trim().toLowerCase()
        const quantity = parseLooseNumber(row.participaciones)

        if (!quantity || quantity <= 0) {
            return
        }

        if (operationType === "compra") {
            const assetType = String(asset.type || "").trim().toLowerCase()
            const grossInvested = parseLooseNumber(row.capitalInvertidoBruto)
            const commissions = parseLooseNumber(row.comisiones)
            const fallbackPrice = parseLooseNumber(row.precioParticipacion)
            const usesExplicitUnitPrice = assetType !== "cripto"
            const priceBasedCost = fallbackPrice !== null ? (fallbackPrice * quantity) + (commissions || 0) : null
            const grossBasedCost = grossInvested !== null ? grossInvested + (commissions || 0) : null
            const totalCost = usesExplicitUnitPrice
                ? (priceBasedCost ?? grossBasedCost ?? 0)
                : (grossBasedCost ?? priceBasedCost ?? 0)

            lots.push({
                date: parseSalesDate(row.fechaOperacion),
                remaining: quantity,
                totalCost,
                unitCost: quantity > 0 ? totalCost / quantity : 0
            })
            return
        }

        if (operationType === "venta") {
            consumeLots(lots, quantity)
        }
    })

    return lots
}

function consumeLots(lots, quantityToSell) {
    let remainingToSell = quantityToSell
    let totalCost = 0
    const availableBeforeSale = lots.reduce((sum, lot) => sum + lot.remaining, 0)

    for (const lot of lots) {
        if (remainingToSell <= 0) {
            break
        }

        const quantityFromLot = Math.min(lot.remaining, remainingToSell)

        if (quantityFromLot <= 0) {
            continue
        }

        totalCost += quantityFromLot * lot.unitCost
        lot.remaining -= quantityFromLot
        remainingToSell -= quantityFromLot
    }

    return {
        availableBeforeSale,
        totalCost,
        remainingToSell
    }
}

function buildVentasComputedMap(rows) {
    const computedMap = new Map()
    const lotsByAsset = new Map()

    ventasAssets.forEach((asset) => {
        lotsByAsset.set(asset.id, buildBaseAssetLots(asset.id))
    })

    const indexedRows = rows.map((row, index) => ({ row, index }))
    indexedRows.sort((left, right) => {
        const dateDiff = parseSalesDate(left.row.fecha) - parseSalesDate(right.row.fecha)
        return dateDiff !== 0 ? dateDiff : left.index - right.index
    })

    indexedRows.forEach(({ row, index }) => {
        const computed = getVentaComputedValues(row, lotsByAsset)
        computedMap.set(index, computed)
    })

    return computedMap
}

function getVentaComputedValues(row, lotsByAsset) {
    const quantity = parseLooseNumber(row.cantidad)
    const salePrice = parseLooseNumber(row.valorVenta)
    const hasCoreValues = row.assetId || quantity !== null || salePrice !== null

    if (!hasCoreValues) {
        return createEmptyVentasComputed()
    }

    if (!row.assetId || quantity === null || quantity <= 0) {
        return createEmptyVentasComputed()
    }

    const assetLots = lotsByAsset.get(row.assetId)

    if (!assetLots) {
        return createEmptyVentasComputed()
    }

    const { availableBeforeSale, totalCost, remainingToSell } = consumeLots(assetLots, quantity)

    if (remainingToSell > 0) {
        return {
            ...createEmptyVentasComputed(),
            stockDisponible: availableBeforeSale,
            valorCompra: totalCost > 0 ? totalCost / (quantity - remainingToSell) : null,
            bruto: salePrice === null ? null : quantity * salePrice
        }
    }

    const averagePurchasePrice = quantity > 0 ? totalCost / quantity : 0
    const bruto = salePrice === null ? null : quantity * salePrice
    const dineroDeclarar = bruto === null ? null : Math.max(bruto - totalCost, 0)
    const tramoTaxes = dineroDeclarar === null
        ? { tramo1: null, tramo2: null, tramo3: null, tramo4: null, tramo5: null }
        : splitAmountAcrossBrackets(dineroDeclarar)
    const totalPagar = dineroDeclarar === null
        ? null
        : Object.values(tramoTaxes).reduce((sum, value) => sum + value, 0)
    const neto = bruto === null || totalPagar === null ? null : bruto - totalPagar

    return {
        stockDisponible: availableBeforeSale,
        valorCompra: averagePurchasePrice,
        dineroDeclarar,
        tramo1: tramoTaxes.tramo1,
        tramo2: tramoTaxes.tramo2,
        tramo3: tramoTaxes.tramo3,
        tramo4: tramoTaxes.tramo4,
        tramo5: tramoTaxes.tramo5,
        totalPagar,
        bruto,
        neto
    }
}

function createEmptyVentasComputed() {
    return {
        stockDisponible: null,
        valorCompra: null,
        dineroDeclarar: null,
        tramo1: null,
        tramo2: null,
        tramo3: null,
        tramo4: null,
        tramo5: null,
        totalPagar: null,
        bruto: null,
        neto: null
    }
}

function splitAmountAcrossBrackets(amount) {
    const taxes = {
        tramo1: 0,
        tramo2: 0,
        tramo3: 0,
        tramo4: 0,
        tramo5: 0
    }

    let remaining = Math.max(amount || 0, 0)
    let previousLimit = 0

    SALES_TAX_BRACKETS.forEach((bracket) => {
        if (remaining <= 0) {
            return
        }

        const taxableBase = bracket.limit === Number.POSITIVE_INFINITY
            ? remaining
            : Math.min(remaining, bracket.limit - previousLimit)

        taxes[bracket.key] = taxableBase * bracket.rate
        remaining -= taxableBase
        previousLimit = bracket.limit
    })

    return taxes
}

function renderVentasTable() {
    const ventasBody = document.getElementById("ventasBody")

    if (!ventasBody) {
        return
    }

    ventasBody.innerHTML = ""

    const rows = currentVentasData.rows || []

    if (!rows.length) {
        const emptyRow = document.createElement("tr")
        emptyRow.innerHTML = `
            <td colspan="15" class="operationsEmptyCell">Todavía no hay ventas registradas.</td>
        `
        ventasBody.appendChild(emptyRow)
        return
    }

    const computedMap = buildVentasComputedMap(rows)

    rows.forEach((row, index) => {
        ventasBody.appendChild(buildVentaRow(row, computedMap.get(index) || createEmptyVentasComputed(), index))
    })
}

function buildVentaRow(row, computed, index) {
    const tr = document.createElement("tr")
    tr.dataset.ventaId = row.id
    tr.dataset.fecha = String(row.fecha || "")
    tr.dataset.assetId = String(row.assetId || "")
    tr.dataset.activo = String(row.activo || "")
    tr.dataset.cantidad = String(row.cantidad || "")
    tr.dataset.valorVenta = String(row.valorVenta || "")
    tr.innerHTML = `
        <td data-field="fecha">${row.fecha || ""}</td>
        <td data-field="assetName">${getVentasAssetName(row.assetId) || row.activo || ""}</td>
        <td data-field="cantidad">${formatVentasNumber(row.cantidad)}</td>
        <td class="rowTotal" data-field="valorCompra">${formatVentasMoney(computed.valorCompra)}</td>
        <td data-field="valorVenta">${formatVentasMoney(row.valorVenta)}</td>
        <td class="rowTotal" data-field="dineroDeclarar">${formatVentasTaxColumn(computed.dineroDeclarar)}</td>
        <td class="rowTotal" data-field="tramo1">${formatVentasTaxColumn(computed.tramo1)}</td>
        <td class="rowTotal" data-field="tramo2">${formatVentasTaxColumn(computed.tramo2)}</td>
        <td class="rowTotal" data-field="tramo3">${formatVentasTaxColumn(computed.tramo3)}</td>
        <td class="rowTotal" data-field="tramo4">${formatVentasTaxColumn(computed.tramo4)}</td>
        <td class="rowTotal" data-field="tramo5">${formatVentasTaxColumn(computed.tramo5)}</td>
        <td class="rowTotal" data-field="totalPagar">${formatVentasTaxColumn(computed.totalPagar)}</td>
        <td class="rowTotal" data-field="bruto">${formatVentasMoney(computed.bruto)}</td>
        <td class="rowTotal" data-field="neto">${formatVentasMoney(computed.neto)}</td>
        <td class="rowActionsCell">
            <button type="button" class="assetRowEditBtn ventasRowEditBtn" data-row-index="${index}" title="Editar fila">✎</button>
            <button type="button" class="assetRowDeleteBtn ventasRowDeleteBtn" data-row-index="${index}" title="Eliminar fila">✕</button>
        </td>
    `
    return tr
}

function buildVentasAssetSelect(selectedAssetId) {
    const selectedId = String(selectedAssetId || "")
    const hasSelectedAsset = ventasAssets.some((asset) => asset.id === selectedId)
    const currentLabel = selectedId && !hasSelectedAsset ? getVentasAssetName(selectedId) || selectedId : ""

    return `
        <select class="operationsSelect" data-field="assetId">
            <option value="">Selecciona activo</option>
            ${currentLabel ? `<option value="${selectedId}" selected>${currentLabel}</option>` : ""}
            ${ventasAssets.map((asset) => `<option value="${asset.id}"${asset.id === selectedId ? " selected" : ""}>${asset.name}</option>`).join("")}
        </select>
    `
}

function formatVentasNumber(value) {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null || String(value || "").trim() === "") {
        return ""
    }

    return parsedValue.toLocaleString("es-ES", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 8
    })
}

function formatVentasMoney(value) {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null || String(value || "").trim() === "") {
        return ""
    }

    return formatMoney(parsedValue, "EUR")
}

function formatVentasTaxColumn(value) {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null) {
        return ""
    }

    if (parsedValue === 0) {
        return "- €"
    }

    return formatMoney(parsedValue, "EUR")
}

function handleVentasActionClick(event) {
    const editButton = event.target.closest(".ventasRowEditBtn")
    if (editButton) {
        openVentasModal(Number(editButton.dataset.rowIndex))
        return
    }

    const deleteButton = event.target.closest(".ventasRowDeleteBtn")
    if (!deleteButton) {
        return
    }

    const rowIndex = Number(deleteButton.dataset.rowIndex)
    const row = currentVentasData.rows?.[rowIndex]
    const isEmpty = !row || (!row.fecha && !row.assetId && parseLooseNumber(row.cantidad || "") === null && parseLooseNumber(row.valorVenta || "") === null)

    const removeRow = async () => {
        currentVentasData.rows.splice(rowIndex, 1)
        renderVentasTable()
        await persistVentasData()
    }

    if (isEmpty) {
        removeRow().catch((error) => {
            console.error(error)
            alert("No se pudo eliminar la fila.")
        })
        return
    }

    openConfirmModal({
        title: "Eliminar fila",
        message: "Esta fila tiene contenido. ¿Quieres eliminarla?",
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            try {
                await removeRow()
            } catch (error) {
                console.error(error)
                alert("No se pudo eliminar la fila.")
            }
        }
    })
}

function stripVentasCurrencyOnFocus(event) {
    const editableMoneyCell = event.target.closest('[contenteditable="true"][data-field="valorVenta"]')

    if (!editableMoneyCell) {
        return
    }

    queueMicrotask(() => {
        editableMoneyCell.textContent = stripCurrencyText(editableMoneyCell.textContent || "")
    })
}

function syncVentasDataFromTable() {
    const bodyRows = [...document.querySelectorAll("#ventasBody tr[data-venta-id]")]

    currentVentasData.rows = bodyRows.map((rowElement) => {
        return normalizeVentaRow({
            id: rowElement.dataset.ventaId,
            fecha: rowElement.dataset.fecha || rowElement.querySelector('[data-field="fecha"]')?.textContent.trim() || "",
            assetId: rowElement.dataset.assetId || "",
            activo: rowElement.dataset.activo || getVentasAssetName(rowElement.dataset.assetId || ""),
            cantidad: rowElement.dataset.cantidad || rowElement.querySelector('[data-field="cantidad"]')?.textContent.trim() || "",
            valorVenta: stripCurrencyText(rowElement.dataset.valorVenta || rowElement.querySelector('[data-field="valorVenta"]')?.textContent || "") || ""
        })
    })
}

function serializeVentasMoney(value) {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null) {
        return ""
    }

    return parsedValue.toFixed(2).replace(".", ",")
}

function scheduleVentasAutosave(delay = 500) {
    window.clearTimeout(ventasAutosaveTimeout)
    ventasAutosaveTimeout = window.setTimeout(async () => {
        try {
            await persistVentasData()
        } catch (error) {
            console.error("Error en autoguardado de ventas:", error)
        }
    }, delay)
}

async function persistVentasData(options = {}) {
    syncVentasDataFromTable()
    const computedMap = buildVentasComputedMap(currentVentasData.rows)

    currentVentasData.rows = currentVentasData.rows.map((row, index) => {
        const computed = computedMap.get(index) || createEmptyVentasComputed()

        return {
            ...row,
            activo: getVentasAssetName(row.assetId),
            valorCompra: serializeVentasMoney(computed.valorCompra),
            dineroDeclarar: serializeVentasMoney(computed.dineroDeclarar),
            tramo1: serializeVentasMoney(computed.tramo1),
            tramo2: serializeVentasMoney(computed.tramo2),
            tramo3: serializeVentasMoney(computed.tramo3),
            tramo4: serializeVentasMoney(computed.tramo4),
            tramo5: serializeVentasMoney(computed.tramo5),
            totalPagar: serializeVentasMoney(computed.totalPagar),
            bruto: serializeVentasMoney(computed.bruto),
            neto: serializeVentasMoney(computed.neto)
        }
    })

    currentVentasData.year = currentVentasYear

    window.clearTimeout(ventasAutosaveTimeout)
    await saveVentasData(currentVentasYear, currentVentasData, options)

    if (!options.keepalive) {
        await refreshAssetsSidebar(currentAssetId, false)
    }
}

async function flushVentasPendingChanges() {
    if (!document.getElementById("ventasBody")) {
        return
    }

    await persistVentasData({ keepalive: true })
}

function bindVentasPersistenceGuards() {
    if (ventasPersistenceBound) {
        return
    }

    ventasPersistenceBound = true

    window.addEventListener("beforeunload", () => {
        if (!document.getElementById("ventasBody")) {
            return
        }

        persistVentasData({ keepalive: true }).catch((error) => {
            console.error("Error al guardar ventas al cerrar la ventana:", error)
        })
    })

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "hidden" || !document.getElementById("ventasBody")) {
            return
        }

        persistVentasData({ keepalive: true }).catch((error) => {
            console.error("Error al guardar ventas al cambiar de ventana:", error)
        })
    })
}

function exportVentasJson() {
    syncVentasDataFromTable()
    downloadJsonFile(`ventas-${currentVentasYear}.json`, currentVentasData)
}

function importVentasJson() {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = "application/json,.json"
    input.addEventListener("change", async () => {
        const file = input.files?.[0]

        if (!file) {
            return
        }

        const text = await file.text()
        const payload = JSON.parse(text)
        const rows = Array.isArray(payload.rows) ? payload.rows : []
        currentVentasData.year = currentVentasYear
        currentVentasData.rows = rows.map(normalizeVentaRow)
        renderVentasTable()
        scheduleVentasAutosave()
    })

    input.click()
}
