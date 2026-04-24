function handleCellBlur(event) {
    const cell = event.target

    if (cell.tagName !== "TD") {
        return
    }

    const tableBody = cell.closest('tbody')
    const columnIndex = cell.cellIndex

    if (tableBody?.id === "interesesBody" && (columnIndex === 2 || columnIndex === 3)) {
        const value = parseEuroNumber(cell.textContent)
        const hasText = cell.textContent.trim() !== ""

        if (hasText) {
            cell.textContent = formatEuro(value)
        }

        updateTotals()
        return
    }

    if (tableBody?.id === "dividendosBody") {
        const hasText = cell.textContent.trim() !== ""

        if (columnIndex === 3) {
            const value = parseLooseNumber(cell.textContent)

            if (hasText) {
                cell.textContent = formatShareQuantity(value)
            }
        }

        if (columnIndex === 4 || columnIndex === 5) {
            const value = parseEuroNumber(cell.textContent)

            if (hasText) {
                cell.textContent = formatEuro(value)
            }
        }

        updateDividendosTotals()
        return
    }

    if (tableBody?.id === "assetOperationsBody") {
        const hasText = cell.textContent.trim() !== ""
        const fieldName = cell.dataset.field || ""
        const assetType = getCurrentAssetType()
        const assetCurrency = getCurrentAssetCurrency()
        const assetPriceCurrency = getCurrentAssetPriceCurrency()
        const rowCurrency = getAssetRowCurrency(cell, assetCurrency)

        if (fieldName === "participaciones") {
            const value = parseLooseNumber(cell.textContent)

            if (hasText) {
                cell.textContent = formatAssetParticipationValue(value)
            }
        }

        if (fieldName === "comisiones" && isCryptoAssetType(assetType)) {
            const value = parseLooseNumber(cell.textContent)

            if (hasText) {
                cell.textContent = formatAssetCommissionValue(value)
            }
        } else if (["precioParticipacion", "capitalInvertidoBruto", "comisiones", "comisionesFiat"].includes(fieldName)) {
            const moneyCurrency = getAssetTableMoneyCurrency(assetType, fieldName || "precioParticipacion", assetCurrency, assetPriceCurrency, rowCurrency)
            const value = moneyCurrency === "EUR"
                ? parseEuroNumber(cell.textContent)
                : parseDollarNumber(cell.textContent)

            if (hasText) {
                cell.textContent = (fieldName === "comisiones" || fieldName === "comisionesFiat")
                    ? formatAssetCommissionValue(value, moneyCurrency)
                    : formatMoney(value, moneyCurrency)
            }
        }

        if (fieldName === "comisionesSatoshis" || fieldName === "comisionesCripto") {
            const value = parseLooseNumber(cell.textContent)

            if (hasText) {
                cell.textContent = formatCellSatoshisValue(value)
            }
        }

        updateAssetTableTotals()
    }
}

let interesesModalKeyHandler = null

function escapeInteresesHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

function closeInteresesModal() {
    document.getElementById("interesesModalOverlay")?.remove()

    if (interesesModalKeyHandler) {
        document.removeEventListener("keydown", interesesModalKeyHandler)
        interesesModalKeyHandler = null
    }
}

function openInteresesModal(rowIndex = -1) {
    closeInteresesModal()

    const rows = collectInteresesDataFromTable().rows
    const isEdit = rowIndex >= 0
    const rowData = isEdit ? { ...rows[rowIndex] } : {}

    const overlay = document.createElement("div")
    overlay.id = "interesesModalOverlay"
    overlay.className = "modalOverlay"

    const modal = document.createElement("div")
    modal.className = "assetModal interesesCreateModal"
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.innerHTML = `
        <h3 class="assetModalTitle">${isEdit ? "Editar interés" : "Añadir interés"}</h3>
        <label class="assetModalLabel" for="interesFechaInput">Fecha</label>
        <input id="interesFechaInput" class="assetModalInput" type="text" value="${escapeInteresesHtml(rowData.fecha || "")}" placeholder="dd-mm-aaaa">
        <label class="assetModalLabel" for="interesAcumuladoInput">Acumulado</label>
        <input id="interesAcumuladoInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeInteresesHtml(rowData.acumulado || "")}" placeholder="0,00">
        <label class="assetModalLabel" for="interesImpuestosInput">Impuestos</label>
        <input id="interesImpuestosInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeInteresesHtml(rowData.impuestos || "")}" placeholder="0,00">
        <p class="gastosCreateModalFeedback hidden" id="interesesModalFeedback"></p>
        <div class="assetModalActions interesesModalActions">
            <button type="button" class="cancelButton" id="interesesModalCancelBtn">Cancelar</button>
            <button type="button" class="primaryButton" id="interesesModalSaveBtn" data-no-autohide="true">Guardar</button>
        </div>
    `

    const feedback = () => modal.querySelector("#interesesModalFeedback")
    const setFeedback = (message = "", isError = false) => {
        const node = feedback()
        if (!node) return
        node.textContent = message
        node.classList.toggle("hidden", !message)
        node.classList.toggle("error", Boolean(message && isError))
    }

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            // closeInteresesModal() // Deshabilitado para evitar cierre accidental
        }
    })

    modal.querySelector("#interesesModalCancelBtn")?.addEventListener("click", closeInteresesModal)
    modal.querySelector("#interesesModalSaveBtn")?.addEventListener("click", async () => {
        const fecha = modal.querySelector("#interesFechaInput")?.value.trim() || ""
        const acumuladoRaw = modal.querySelector("#interesAcumuladoInput")?.value.trim() || ""
        const impuestosRaw = modal.querySelector("#interesImpuestosInput")?.value.trim() || ""
        const acumulado = acumuladoRaw ? formatCellEuroValue(acumuladoRaw) : ""
        const impuestos = impuestosRaw ? formatCellEuroValue(impuestosRaw) : ""

        if (!fecha && !acumulado && !impuestos) {
            setFeedback("Introduce al menos un dato.", true)
            return
        }

        const nextRows = [...rows]
        const nextRow = { fecha, acumulado, impuestos }

        if (isEdit) {
            nextRows[rowIndex] = nextRow
        } else {
            nextRows.push(nextRow)
        }

        try {
            renderRowsFromData({ rows: nextRows })
            await saveInteresesDataToServer()
            closeInteresesModal()
        } catch (error) {
            console.error(error)
            setFeedback("No se pudo guardar.", true)
        }
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    interesesModalKeyHandler = (event) => {
        if (event.key === "Escape") closeInteresesModal()
    }
    document.addEventListener("keydown", interesesModalKeyHandler)

    modal.querySelector("input")?.focus()
}

async function loadInteresesData() {
    try {
        const response = await fetch("/api/intereses")

        if (!response.ok) {
            throw new Error("No se pudo cargar /api/intereses")
        }

        return await response.json()
    } catch (error) {
        console.error("Error cargando intereses desde el backend:", error)
        return { rows: [] }
    }
}

async function renderInteresesTable() {
    const interesesBody = document.getElementById("interesesBody")

    if (!interesesBody) {
        return
    }

    const interesesData = await loadInteresesData()
    renderRowsFromData(interesesData)
}

function renderRowsFromData(interesesData) {
    const interesesBody = document.getElementById("interesesBody")

    if (!interesesBody) {
        return
    }

    interesesBody.innerHTML = ""

    const rows = Array.isArray(interesesData?.rows) ? interesesData.rows : []

    rows.forEach((rowData, index) => {
        const rowElement = document.createElement("tr")
        rowElement.dataset.rowIndex = String(index)
        rowElement.dataset.fecha = String(rowData.fecha || "")
        rowElement.dataset.acumulado = String(rowData.acumulado || "")
        rowElement.dataset.impuestos = String(rowData.impuestos || "")

        rowElement.innerHTML = `
            <td data-field="fecha">${rowData.fecha || ""}</td>
            <td data-field="acumulado">${formatCellEuroValue(rowData.acumulado)}</td>
            <td data-field="impuestos">${formatCellEuroValue(rowData.impuestos)}</td>
            <td class="rowTotal">0,00 €</td>
            <td class="rowActionsCell">
                <button type="button" class="assetRowEditBtn interesesRowEditBtn" data-row-index="${index}" title="Editar fila">✎</button>
                <button type="button" class="assetRowDeleteBtn interesesRowDeleteBtn" data-row-index="${index}" title="Eliminar fila">✕</button>
            </td>
        `

        interesesBody.appendChild(rowElement)
    })

    updateTotals()
}

function collectInteresesDataFromTable() {
    const rowElements = [...document.querySelectorAll("#interesesBody tr")]

    const rows = rowElements.map((rowElement) => {
        return {
            fecha: rowElement.dataset.fecha || rowElement.querySelector('[data-field="fecha"]')?.textContent.trim() || "",
            acumulado: rowElement.dataset.acumulado || rowElement.querySelector('[data-field="acumulado"]')?.textContent.trim() || "",
            impuestos: rowElement.dataset.impuestos || rowElement.querySelector('[data-field="impuestos"]')?.textContent.trim() || ""
        }
    })

    return { rows }
}

async function saveInteresesDataToServer() {
    const data = collectInteresesDataFromTable()

    const response = await fetch("/api/intereses", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
}

function updateTotals() {
    const interesesBody = document.getElementById("interesesBody")

    if (!interesesBody) {
        return
    }

    let totalNeto = 0
    let totalImpuestos = 0

    const rowElements = interesesBody.querySelectorAll("tr")

    rowElements.forEach((rowElement) => {
        const cells = rowElement.querySelectorAll("td")
        const acumulado = parseEuroNumber(cells[1]?.textContent || "")
        const impuestos = parseEuroNumber(cells[2]?.textContent || "")
        const rowTotal = acumulado - impuestos

        if (cells[3]) {
            cells[3].textContent = formatEuro(rowTotal)
        }

        totalNeto += rowTotal
        totalImpuestos += impuestos
    })

    const totalResumen = document.getElementById("totalResumen")
    const impuestosResumen = document.getElementById("impuestosResumen")
    const topTotalInteres = document.getElementById("topTotalInteres")

    if (totalResumen) {
        totalResumen.textContent = formatEuro(totalNeto)
    }

    if (impuestosResumen) {
        impuestosResumen.textContent = formatEuro(totalImpuestos)
    }

    if (topTotalInteres) {
        topTotalInteres.textContent = formatEuro(totalNeto)
    }
}

function addNewInteresesRow() {
    openInteresesModal(-1)
}

function handleInteresesRowActionClick(event) {
    const editButton = event.target.closest(".interesesRowEditBtn")
    if (editButton) {
        openInteresesModal(Number(editButton.dataset.rowIndex))
        return
    }

    const deleteButton = event.target.closest(".interesesRowDeleteBtn")
    if (!deleteButton) {
        return
    }

    const rowIndex = Number(deleteButton.dataset.rowIndex)
    const rows = collectInteresesDataFromTable().rows
    const row = rows[rowIndex]
    const isEmpty = !row || (!row.fecha && parseEuroNumber(row.acumulado || "") === 0 && parseEuroNumber(row.impuestos || "") === 0)

    const removeRow = async () => {
        rows.splice(rowIndex, 1)
        renderRowsFromData({ rows })
        await saveInteresesDataToServer()
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

function exportInteresesJson() {
    const data = collectInteresesDataFromTable()
    const dataString = JSON.stringify(data, null, 2)
    const dataBlob = new Blob([dataString], { type: "application/json" })
    const dataUrl = URL.createObjectURL(dataBlob)
    const downloadLink = document.createElement("a")

    downloadLink.href = dataUrl
    downloadLink.download = "intereses.json"
    document.body.appendChild(downloadLink)
    downloadLink.click()
    document.body.removeChild(downloadLink)

    URL.revokeObjectURL(dataUrl)
}

function importInteresesJson() {
    const inputFile = document.createElement("input")
    inputFile.type = "file"
    inputFile.accept = ".json,application/json"

    inputFile.addEventListener("change", async (event) => {
        const file = event.target.files?.[0]

        if (!file) {
            return
        }

        try {
            const fileText = await file.text()
            const parsedData = JSON.parse(fileText)

            if (!parsedData || !Array.isArray(parsedData.rows)) {
                alert("El JSON no tiene el formato esperado. Debe contener { rows: [...] }")
                return
            }

            renderRowsFromData(parsedData)
            await saveInteresesDataToServer()
            alert("JSON importado y guardado en data/intereses.json")
        } catch (error) {
            console.error(error)
            alert("No se pudo importar el JSON.")
        }
    })

    inputFile.click()
}

