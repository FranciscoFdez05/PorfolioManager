function handleCellBlur(event) {
    const cell = event.target

    if (cell.tagName !== "TD") {
        return
    }

    const tableBody = cell.closest('tbody')
    const columnIndex = cell.cellIndex

    if (tableBody?.id === "interesesBody" && (columnIndex === 2 || columnIndex === 3 || columnIndex === 4)) {
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

        if (columnIndex === 3) {
            const value = parseLooseNumber(cell.textContent)

            if (hasText) {
                cell.textContent = formatAssetParticipationValue(value)
            }
        }

        if (columnIndex === 4 || columnIndex === 5 || columnIndex === 6) {
            const value = parseEuroNumber(cell.textContent)

            if (hasText) {
                cell.textContent = formatEuro(value)
            }
        }

        updateAssetTableTotals()
    }
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

    rows.forEach((rowData) => {
        const rowElement = document.createElement("tr")

        rowElement.innerHTML = `
            <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
            <td contenteditable="true">${rowData.fecha || ""}</td>
            <td contenteditable="true">${formatCellEuroValue(rowData.saldoPromedio)}</td>
            <td contenteditable="true">${formatCellEuroValue(rowData.acumulado)}</td>
            <td contenteditable="true">${formatCellEuroValue(rowData.impuestos)}</td>
            <td class="rowTotal">0,00 €</td>
        `

        interesesBody.appendChild(rowElement)
    })

    updateTotals()
}

function collectInteresesDataFromTable() {
    const rowElements = [...document.querySelectorAll("#interesesBody tr")]

    const rows = rowElements.map((rowElement) => {
        const cells = rowElement.querySelectorAll("td")

        return {
            fecha: cells[1]?.textContent.trim() || "",
            saldoPromedio: cells[2]?.textContent.trim() || "",
            acumulado: cells[3]?.textContent.trim() || "",
            impuestos: cells[4]?.textContent.trim() || ""
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
        const acumulado = parseEuroNumber(cells[3]?.textContent || "")
        const impuestos = parseEuroNumber(cells[4]?.textContent || "")
        const rowTotal = acumulado - impuestos

        if (cells[5]) {
            cells[5].textContent = formatEuro(rowTotal)
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
    const interesesBody = document.getElementById("interesesBody")

    if (!interesesBody) {
        return
    }

    const rowElement = document.createElement("tr")

    rowElement.innerHTML = `
        <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
        <td contenteditable="true">nuevo-mes</td>
        <td contenteditable="true"></td>
        <td contenteditable="true"></td>
        <td contenteditable="true"></td>
        <td class="rowTotal">0,00 €</td>
    `

    interesesBody.appendChild(rowElement)
    updateTotals()
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

