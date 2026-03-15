async function loadDividendosData() {
    try {
        const response = await fetch("/api/dividendos")

        if (!response.ok) {
            throw new Error("No se pudo cargar /api/dividendos")
        }

        return await response.json()
    } catch (error) {
        console.error("Error cargando dividendos desde el backend:", error)
        return { rows: [] }
    }
}

async function renderDividendosTable() {
    const dividendosBody = document.getElementById("dividendosBody")

    if (!dividendosBody) {
        return
    }

    const dividendosData = await loadDividendosData()
    renderDividendosRowsFromData(dividendosData)
}

function renderDividendosRowsFromData(dividendosData) {
    const dividendosBody = document.getElementById("dividendosBody")

    if (!dividendosBody) {
        return
    }

    dividendosBody.innerHTML = ""

    const rows = Array.isArray(dividendosData?.rows) ? dividendosData.rows : []

    rows.forEach((rowData) => {
        const rowElement = document.createElement("tr")

        rowElement.innerHTML = `
            <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
            <td contenteditable="true">${rowData.fecha || ""}</td>
            <td contenteditable="true">${rowData.instrumento || ""}</td>
            <td contenteditable="true">${rowData.acciones || ""}</td>
            <td contenteditable="true">${formatCellDollarValue(rowData.dividendoAccion)}</td>
            <td contenteditable="true">${formatCellEuroValue(rowData.impuestos)}</td>
            <td contenteditable="true" class="rowTotal">${formatCellEuroValue(rowData.total)}</td>
        `

        dividendosBody.appendChild(rowElement)
    })

    updateDividendosTotals()
}

function collectDividendosDataFromTable() {
    const rowElements = [...document.querySelectorAll("#dividendosBody tr")]

    const rows = rowElements.map((rowElement) => {
        const cells = rowElement.querySelectorAll("td")

        return {
            fecha: cells[1]?.textContent.trim() || "",
            instrumento: cells[2]?.textContent.trim() || "",
            acciones: cells[3]?.textContent.trim() || "",
            dividendoAccion: cells[4]?.textContent.trim() || "",
            impuestos: cells[5]?.textContent.trim() || "",
            total: cells[6]?.textContent.trim() || ""
        }
    })

    return { rows }
}

async function saveDividendosDataToServer() {
    const data = collectDividendosDataFromTable()

    const response = await fetch("/api/dividendos", {
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

function updateDividendosTotals() {
    const dividendosBody = document.getElementById("dividendosBody")

    if (!dividendosBody) {
        return
    }

    let totalNeto = 0
    let totalImpuestos = 0

    const rowElements = dividendosBody.querySelectorAll("tr")

    rowElements.forEach((rowElement) => {
        const cells = rowElement.querySelectorAll("td")
        const impuestos = parseEuroNumber(cells[5]?.textContent || "")
        const rowTotal = parseEuroNumber(cells[6]?.textContent || "")

        totalNeto += rowTotal
        totalImpuestos += impuestos
    })

    const totalResumen = document.getElementById("totalDividendosResumen")
    const impuestosResumen = document.getElementById("impuestosDividendosResumen")
    const topTotalDividendos = document.getElementById("topTotalDividendos")

    if (totalResumen) {
        totalResumen.textContent = formatEuro(totalNeto)
    }

    if (impuestosResumen) {
        impuestosResumen.textContent = formatEuro(totalImpuestos)
    }

    if (topTotalDividendos) {
        topTotalDividendos.textContent = formatEuro(totalNeto)
    }
}

function addNewDividendosRow() {
    const dividendosBody = document.getElementById("dividendosBody")

    if (!dividendosBody) {
        return
    }

    const rowElement = document.createElement("tr")

    rowElement.innerHTML = `
        <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
        <td contenteditable="true">nueva-fecha</td>
        <td contenteditable="true">instrumento</td>
        <td contenteditable="true"></td>
        <td contenteditable="true"></td>
        <td contenteditable="true"></td>
        <td contenteditable="true" class="rowTotal"></td>
    `

    dividendosBody.appendChild(rowElement)
    updateDividendosTotals()
}

function exportDividendosJson() {
    const data = collectDividendosDataFromTable()
    const dataString = JSON.stringify(data, null, 2)
    const dataBlob = new Blob([dataString], { type: "application/json" })
    const dataUrl = URL.createObjectURL(dataBlob)
    const downloadLink = document.createElement("a")

    downloadLink.href = dataUrl
    downloadLink.download = "dividendos.json"
    document.body.appendChild(downloadLink)
    downloadLink.click()
    document.body.removeChild(downloadLink)

    URL.revokeObjectURL(dataUrl)
}

function scheduleDividendosAutosave() {
    clearTimeout(dividendosAutosaveTimeout)

    dividendosAutosaveTimeout = setTimeout(async () => {
        try {
            await saveDividendosDataToServer()
        } catch (error) {
            console.error("Error en autoguardado de dividendos:", error)
        }
    }, 500)
}

function importDividendosJson() {
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

            renderDividendosRowsFromData(parsedData)
            await saveDividendosDataToServer()
            alert("JSON importado y guardado en data/dividendos.json")
        } catch (error) {
            console.error(error)
            alert("No se pudo importar el JSON.")
        }
    })

    inputFile.click()
}

