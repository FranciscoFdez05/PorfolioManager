let conversionesSelectedAssetId = null
let conversionesCurrentAsset = null
let conversionesAutosaveTimeout = null

async function initConversionesLogic() {
    const assetSelect = document.getElementById("conversionesAssetSelect")
    const addRowButton = document.getElementById("addConversionRowBtn")
    const saveButton = document.getElementById("saveConversionesBtn")
    const body = document.getElementById("conversionesBody")
    const assets = await loadAssetsList()

    if (!assetSelect || !body) {
        return
    }

    const cryptoAssets = assets.filter((a) => a.type === "cripto")
    renderConversionesAssetOptions(cryptoAssets)
    const firstId = cryptoAssets[0]?.id || ""
    conversionesSelectedAssetId = (currentAssetId && cryptoAssets.find((a) => a.id === currentAssetId))
        ? currentAssetId
        : firstId

    if (conversionesSelectedAssetId) {
        assetSelect.value = conversionesSelectedAssetId
        await loadConversionesAsset(conversionesSelectedAssetId)
    } else {
        renderConversionesSelectedAsset(null)
        body.innerHTML = ""
    }

    if (!assetSelect.dataset.bound) {
        assetSelect.dataset.bound = "true"
        assetSelect.addEventListener("change", async () => {
            await flushConversionesPendingChanges()
            conversionesSelectedAssetId = assetSelect.value
            await loadConversionesAsset(conversionesSelectedAssetId)
        })
    }

    if (addRowButton && !addRowButton.dataset.bound) {
        addRowButton.dataset.bound = "true"
        addRowButton.addEventListener("click", () => {
            openConversiónRowModal("")
        })
    }

    if (saveButton && !saveButton.dataset.bound) {
        saveButton.dataset.bound = "true"
        saveButton.addEventListener("click", async () => {
            await saveConversionesData(false)
            alert("Conversiones guardadas en el JSON del activo")
        })
    }

    if (!body.dataset.bound) {
        body.dataset.bound = "true"
        body.addEventListener("input", scheduleConversionesAutosave)
        body.addEventListener("change", scheduleConversionesAutosave)
        body.addEventListener("click", (event) => {
            const editButton = event.target.closest(".conversionRowEditBtn")
            if (editButton) {
                openConversiónRowModal(editButton.dataset.rowId)
                return
            }

            const deleteButton = event.target.closest(".conversionRowDeleteBtn")
            if (deleteButton) {
                const row = deleteButton.closest("tr[data-row-id]")
                if (!row) return
                openConfirmModal({
                    title: "Eliminar fila",
                    message: "¿Quieres eliminar esta conversión?",
                    confirmLabel: "Eliminar",
                    onConfirm: () => {
                        row.remove()
                        scheduleConversionesAutosave()
                    }
                })
            }
        })
    }

    window.flushPendingPageChanges = flushConversionesPendingChanges
}

function renderConversionesAssetOptions(assets) {
    const assetSelect = document.getElementById("conversionesAssetSelect")

    if (!assetSelect) {
        return
    }

    if (!assets.length) {
        assetSelect.innerHTML = `<option value="">Sin activos cripto</option>`
        return
    }

    assetSelect.innerHTML = assets.map((asset) => `
        <option value="${asset.id}">${asset.name}</option>
    `).join("")
}

function renderConversionesSelectedAsset(asset) {
    const container = document.getElementById("conversionesSelectedAsset")

    if (!container) {
        return
    }

    if (!asset) {
        container.innerHTML = `
            <div class="toolsSelectedLabel">Conversiones</div>
            <div class="toolsSelectedValue">Selecciona un activo</div>
        `
        return
    }

    const baseSymbol = deriveAssetBaseSymbolFromData(asset)

    container.innerHTML = `
        <div class="toolsSelectedLabel">Conversiones del activo</div>
        <div class="toolsSelectedValue">${asset.name}</div>
        <div class="toolsSelectedMeta">${baseSymbol} convertidos / Convertidos a ${baseSymbol}</div>
    `
}

async function loadConversionesAsset(assetId) {
    if (!assetId) {
        return
    }

    conversionesCurrentAsset = await loadAssetData(assetId)
    currentAssetId = assetId
    renderConversionesSelectedAsset(conversionesCurrentAsset)
    renderConversionesRows(getAssetConversionRows(conversionesCurrentAsset), conversionesCurrentAsset)
}

function renderConversionesRows(rows, asset) {
    const body = document.getElementById("conversionesBody")

    if (!body) {
        return
    }

    body.innerHTML = ""
    const conversionesEmptyEl = document.getElementById("conversionesEmptyMsg")

    if (!rows.length) {
        if (conversionesEmptyEl) conversionesEmptyEl.classList.remove("hidden")
        renderConversionesStats([], asset)
        return
    }

    if (conversionesEmptyEl) conversionesEmptyEl.classList.add("hidden")

    rows.forEach((row) => {
        body.appendChild(buildConversionesRowElement(row, asset))
    })
    bindTableSort(body.closest("table"), "conversiones")
    renderConversionesStats(rows, asset)
}

function buildConversionesRowElement(row = {}, asset = conversionesCurrentAsset) {
    const rowElement = document.createElement("tr")
    rowElement.dataset.rowId = String(row.id || createConversionRowId())

    const baseSymbol = deriveAssetBaseSymbolFromData(asset)
    const convertedInLabel = getConvertedInOperationLabel(baseSymbol)
    const isIn = row.tipo
        ? String(row.tipo).toLowerCase() === convertedInLabel.toLowerCase()
        : true
    const tipoBadgeClass = row.tipo
        ? (isIn ? "cvTipoBadge cvTipoBadgeIn" : "cvTipoBadge cvTipoBadgeOut")
        : "cvTipoBadge"

    rowElement.innerHTML = `
        <td data-field="fecha">${row.fecha || ""}</td>
        <td data-field="par">${row.par || ""}</td>
        <td data-field="tipo" data-value="${row.tipo || ""}"><span class="${tipoBadgeClass}">${row.tipo || ""}</span></td>
        <td data-field="cantidad">${formatAssetParticipationValue(row.cantidad || "", "cripto")}</td>
        <td class="rowActionsCell">
            <div class="rowMenu">
                <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                <div class="rowMenuDropdown">
                    <button type="button" class="rowMenuItem assetRowEditBtn conversionRowEditBtn avActionBtn avEditBtn" data-row-id="${rowElement.dataset.rowId}">Editar</button>
                    <hr>
                    <button type="button" class="rowMenuItem rowMenuItemDanger assetRowDeleteBtn conversionRowDeleteBtn avActionBtn avDeleteBtn" data-row-id="${rowElement.dataset.rowId}">Eliminar</button>
                </div>
            </div>
        </td>
    `

    return rowElement
}

function renderConversionesStats(rows, asset) {
    const statsRow = document.getElementById("cvStatsRow")
    if (!statsRow) return

    if (!rows.length || !asset) {
        statsRow.classList.add("hidden")
        return
    }

    statsRow.classList.remove("hidden")

    const baseSymbol = deriveAssetBaseSymbolFromData(asset)
    const convertedInLabel = getConvertedInOperationLabel(baseSymbol)

    let totalIn = 0
    let totalOut = 0

    rows.forEach((row) => {
        const qty = parseLooseNumber(row.cantidad || "") || 0
        if (String(row.tipo || "").toLowerCase() === convertedInLabel.toLowerCase()) {
            totalIn += qty
        } else {
            totalOut += qty
        }
    })

    const net = totalIn - totalOut
    const fmt = (n) => formatAssetParticipationValue(String(n), "cripto")

    const totalEl = document.getElementById("cvStatTotal")
    const inEl = document.getElementById("cvStatIn")
    const outEl = document.getElementById("cvStatOut")
    const netEl = document.getElementById("cvStatNet")

    if (totalEl) totalEl.textContent = rows.length
    if (inEl) inEl.textContent = fmt(totalIn)
    if (outEl) outEl.textContent = fmt(totalOut)
    if (netEl) {
        netEl.textContent = (net >= 0 ? "+" : "−") + fmt(Math.abs(net))
        netEl.className = "cvStatValue" + (net >= 0 ? " cvStatPos" : " cvStatNeg")
    }
}

function liveUpdateConversionesStats() {
    if (!conversionesCurrentAsset) return
    const rows = collectConversionesRows()
    renderConversionesStats(rows, conversionesCurrentAsset)
}

function collectConversionesRows() {
    return [...document.querySelectorAll("#conversionesBody tr")].map((rowElement) => ({
        id: rowElement.dataset.rowId || createConversionRowId(),
        fecha: rowElement.querySelector('[data-field="fecha"]')?.textContent.trim() || "",
        par: rowElement.querySelector('[data-field="par"]')?.textContent.trim() || "",
        tipo: rowElement.querySelector('[data-field="tipo"]')?.dataset.value || getConvertedInOperationLabel(deriveAssetBaseSymbolFromData(conversionesCurrentAsset || {})),
        cantidad: rowElement.querySelector('[data-field="cantidad"]')?.textContent.trim() || ""
    })).filter((row) => {
        const quantity = parseLooseNumber(row.cantidad || "") || 0
        return row.fecha || row.par || quantity > 0
    })
}

function scheduleConversionesAutosave() {
    liveUpdateConversionesStats()
    clearTimeout(conversionesAutosaveTimeout)
    conversionesAutosaveTimeout = setTimeout(() => {
        saveConversionesData(true).catch((error) => {
            showError("No se pudieron guardar las conversiones", error)
        })
    }, 500)
}

async function flushConversionesPendingChanges() {
    clearTimeout(conversionesAutosaveTimeout)

    if (conversionesCurrentAsset) {
        await saveConversionesData(true)
    }
}

function openConversiónRowModal(rowId) {
    document.getElementById("conversionRowModalOverlay")?.remove()

    const rowElement = document.querySelector(`#conversionesBody tr[data-row-id="${rowId}"]`)
    const isEdit = Boolean(rowElement)
    const asset = conversionesCurrentAsset || {}
    const rowData = isEdit ? {
        fecha: rowElement.querySelector('[data-field="fecha"]')?.textContent.trim() || "",
        par: rowElement.querySelector('[data-field="par"]')?.textContent.trim() || "",
        tipo: rowElement.querySelector('[data-field="tipo"]')?.dataset.value || "",
        cantidad: rowElement.querySelector('[data-field="cantidad"]')?.textContent.trim() || ""
    } : { fecha: "", par: "", tipo: "", cantidad: "" }

    const baseSymbol = deriveAssetBaseSymbolFromData(asset)
    const convertedInLabel = getConvertedInOperationLabel(baseSymbol)
    const convertedOutLabel = getConvertedOutOperationLabel(baseSymbol)
    const tipoNorm = String(rowData.tipo || "").trim().toLowerCase()
    const selectedTipo = tipoNorm === convertedOutLabel.toLowerCase() ? convertedOutLabel : convertedInLabel

    const fieldsHtml = `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Fecha</label>
            <input id="cvModalFecha" class="assetRowModalInput" type="text" value="${rowData.fecha}" placeholder="dd-mm-aaaa">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Par</label>
            <input id="cvModalPar" class="assetRowModalInput" type="text" value="${rowData.par}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Tipo</label>
            <select id="cvModalTipo" class="assetRowModalSelect">
                <option value="${convertedInLabel}"${selectedTipo === convertedInLabel ? " selected" : ""}>${convertedInLabel} (Comprar)</option>
                <option value="${convertedOutLabel}"${selectedTipo === convertedOutLabel ? " selected" : ""}>${convertedOutLabel} (Vender)</option>
            </select>
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Cantidad</label>
            <input id="cvModalCantidad" class="assetRowModalInput" type="text" inputmode="decimal" value="${rowData.cantidad}">
        </div>
    `

    const overlay = document.createElement("div")
    overlay.id = "conversionRowModalOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"
    overlay.dataset.rowId = rowId || ""

    const modal = document.createElement("div")
    modal.className = "assetModal assetRowModal"

    const titleEl = document.createElement("h3")
    titleEl.className = "assetModalTitle assetRowModalTitle"
    titleEl.textContent = isEdit ? "Editar conversión" : "Añadir conversión"

    const fields = document.createElement("div")
    fields.className = "assetRowModalFields"
    fields.innerHTML = fieldsHtml

    const footer = document.createElement("div")
    footer.className = "assetRowModalFooter"
    footer.innerHTML = `
        ${isEdit ? `<button type="button" id="cvRowModalDeleteBtn" class="dangerButton assetRowModalDeleteBtn">Eliminar</button>` : ""}
        <button type="button" id="cvRowModalCancelBtn" class="cancelButton">Cancelar</button>
        <button type="button" id="cvRowModalSaveBtn" class="primaryButton" data-no-autohide="true">Guardar</button>
    `

    footer.querySelector("#cvRowModalSaveBtn").addEventListener("click", saveConversiónRowFromModal)
    footer.querySelector("#cvRowModalCancelBtn").addEventListener("click", closeConversiónRowModal)

    if (isEdit) {
        footer.querySelector("#cvRowModalDeleteBtn").addEventListener("click", () => {
            openConfirmModal({
                title: "Eliminar fila",
                message: "¿Quieres eliminar esta conversión?",
                confirmLabel: "Eliminar",
                onConfirm: () => {
                    rowElement.remove()
                    scheduleConversionesAutosave()
                }
            })
            closeConversiónRowModal()
        })
    }

    modal.appendChild(titleEl)
    modal.appendChild(fields)
    modal.appendChild(footer)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
}

function closeConversiónRowModal() {
    document.getElementById("conversionRowModalOverlay")?.remove()
}

function saveConversiónRowFromModal() {
    const overlay = document.getElementById("conversionRowModalOverlay")
    const rowId = overlay?.dataset.rowId || ""
    const g = (id) => document.getElementById(id)?.value ?? ""

    const rowElement = document.querySelector(`#conversionesBody tr[data-row-id="${rowId}"]`)

    if (rowElement) {
        const fechaCell = rowElement.querySelector('[data-field="fecha"]')
        const parCell = rowElement.querySelector('[data-field="par"]')
        const tipoCell = rowElement.querySelector('[data-field="tipo"]')
        const cantidadCell = rowElement.querySelector('[data-field="cantidad"]')
        if (fechaCell) fechaCell.textContent = g("cvModalFecha")
        if (parCell) parCell.textContent = g("cvModalPar")
        if (tipoCell) {
            const newTipo = g("cvModalTipo")
            tipoCell.dataset.value = newTipo
            const baseSymbol = deriveAssetBaseSymbolFromData(conversionesCurrentAsset || {})
            const convertedInLabel = getConvertedInOperationLabel(baseSymbol)
            const isIn = newTipo.toLowerCase() === convertedInLabel.toLowerCase()
            const badgeClass = newTipo ? (isIn ? "cvTipoBadge cvTipoBadgeIn" : "cvTipoBadge cvTipoBadgeOut") : "cvTipoBadge"
            tipoCell.innerHTML = `<span class="${badgeClass}">${newTipo}</span>`
        }
        if (cantidadCell) cantidadCell.textContent = g("cvModalCantidad")
    } else {
        const body = document.getElementById("conversionesBody")
        if (body && conversionesCurrentAsset) {
            body.appendChild(buildConversionesRowElement({
                id: rowId || createConversionRowId(),
                fecha: g("cvModalFecha"),
                par: g("cvModalPar"),
                tipo: g("cvModalTipo"),
                cantidad: g("cvModalCantidad")
            }, conversionesCurrentAsset))
        }
    }

    scheduleConversionesAutosave()
    closeConversiónRowModal()
}

async function saveConversionesData(silent = false) {
    if (!conversionesCurrentAsset) {
        return
    }

    const payload = {
        ...conversionesCurrentAsset,
        rows: getPrimaryAssetRows(conversionesCurrentAsset),
        operationRows: Array.isArray(conversionesCurrentAsset.operationRows) ? conversionesCurrentAsset.operationRows : [],
        conversionRows: collectConversionesRows()
    }

    await saveAssetDataToServer(payload)
    conversionesCurrentAsset = await loadAssetData(payload.id)
    currentAssetPersistedConversionRows = getAssetConversionRows(conversionesCurrentAsset)

    if (!silent) {
        renderConversionesRows(currentAssetPersistedConversionRows, conversionesCurrentAsset)
    }

    await refreshAssetsSidebar(payload.id, false)
}
