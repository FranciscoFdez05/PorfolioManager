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

    renderConversionesAssetOptions(assets)
    conversionesSelectedAssetId = currentAssetId || assets[0]?.id || ""

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
            addConversionesRow()
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
            const deleteButton = event.target.closest(".rowDeleteBtn")

            if (!deleteButton) {
                return
            }

            deleteButton.closest("tr")?.remove()
            scheduleConversionesAutosave()
        })
    }

    window.flushPendingPageChanges = flushConversionesPendingChanges
}

function renderConversionesAssetOptions(assets) {
    const assetSelect = document.getElementById("conversionesAssetSelect")

    if (!assetSelect) {
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
    rows.forEach((row) => {
        body.appendChild(buildConversionesRowElement(row, asset))
    })
}

function buildConversionesRowElement(row = {}, asset = conversionesCurrentAsset) {
    const rowElement = document.createElement("tr")
    rowElement.dataset.rowId = String(row.id || createConversionRowId())

    rowElement.innerHTML = `
        <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
        <td contenteditable="true" data-field="fecha">${row.fecha || ""}</td>
        <td contenteditable="true" data-field="par">${row.par || ""}</td>
        <td>${buildAssetConversionTypeSelect(row.tipo || "", asset || {})}</td>
        <td contenteditable="true" data-field="cantidad">${formatAssetParticipationValue(row.cantidad || "", "cripto")}</td>
    `

    return rowElement
}

function addConversionesRow() {
    const body = document.getElementById("conversionesBody")

    if (!body || !conversionesCurrentAsset) {
        return
    }

    body.appendChild(buildConversionesRowElement({
        id: createConversionRowId(),
        fecha: "",
        par: "",
        tipo: getConvertedInOperationLabel(deriveAssetBaseSymbolFromData(conversionesCurrentAsset)),
        cantidad: ""
    }, conversionesCurrentAsset))

    scheduleConversionesAutosave()
}

function collectConversionesRows() {
    return [...document.querySelectorAll("#conversionesBody tr")].map((rowElement) => ({
        id: rowElement.dataset.rowId || createConversionRowId(),
        fecha: rowElement.querySelector('[data-field="fecha"]')?.textContent.trim() || "",
        par: rowElement.querySelector('[data-field="par"]')?.textContent.trim() || "",
        tipo: rowElement.querySelector('select[data-field="tipo"]')?.value || getConvertedInOperationLabel(deriveAssetBaseSymbolFromData(conversionesCurrentAsset || {})),
        cantidad: rowElement.querySelector('[data-field="cantidad"]')?.textContent.trim() || ""
    })).filter((row) => {
        const quantity = parseLooseNumber(row.cantidad || "") || 0
        return row.fecha || row.par || quantity > 0
    })
}

function scheduleConversionesAutosave() {
    clearTimeout(conversionesAutosaveTimeout)
    conversionesAutosaveTimeout = setTimeout(() => {
        saveConversionesData(true).catch((error) => {
            console.error("No se pudieron guardar las conversiones:", error)
        })
    }, 500)
}

async function flushConversionesPendingChanges() {
    clearTimeout(conversionesAutosaveTimeout)

    if (conversionesCurrentAsset) {
        await saveConversionesData(true)
    }
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
