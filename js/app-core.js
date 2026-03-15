document.addEventListener("DOMContentLoaded", async () => {
    const toggleButton = document.getElementById("togglePanel")
    const sideWrapper = document.getElementById("sideWrapper")
    const navButtons = document.querySelectorAll(".navBtn")
    const contentArea = document.getElementById("dynamicContent")
    const addAssetButton = document.getElementById("addAssetBtn")
    const assetModalOverlay = document.getElementById("assetModalOverlay")
    const confirmAssetModalButton = document.getElementById("confirmAssetModalBtn")
    const cancelAssetModalButton = document.getElementById("cancelAssetModalBtn")
    const assetNameInput = document.getElementById("assetNameInput")
    const assetTypeSelect = document.getElementById("assetTypeSelect")
    const confirmModalOverlay = document.getElementById("confirmModalOverlay")
    const confirmModalAcceptButton = document.getElementById("confirmModalAcceptBtn")
    const confirmModalCancelButton = document.getElementById("confirmModalCancelBtn")

    initSidePanel(toggleButton, sideWrapper)
    initNavigation(navButtons, contentArea)
    initAddAssetButton(addAssetButton, assetModalOverlay, assetNameInput, assetTypeSelect)
    initAssetModal(assetModalOverlay, confirmAssetModalButton, cancelAssetModalButton, assetNameInput, assetTypeSelect)
    initConfirmModal(confirmModalOverlay, confirmModalAcceptButton, confirmModalCancelButton)
    await refreshAssetsSidebar()

    loadPage("vistaGeneral")
})

let dividendosAutosaveTimeout = null
let assetAutosaveTimeout = null
let currentAssetId = null
let assetModalState = null
let confirmModalState = null
let draggedAssetId = null

function initSidePanel(toggleButton, sideWrapper) {
    if (!toggleButton || !sideWrapper) {
        return
    }

    toggleButton.addEventListener("click", () => {
        sideWrapper.classList.toggle("collapsed")
        toggleButton.innerHTML = sideWrapper.classList.contains("collapsed") ? "◀" : "▶"
    })
}

function clearNavSelection() {
    document.querySelectorAll(".navBtn").forEach((button) => {
        button.classList.remove("active")
    })
}

function initAssetSelector(assetButtons) {
    if (!assetButtons.length) {
        return
    }

    assetButtons.forEach((button) => {
        button.addEventListener("click", async () => {
            clearNavSelection()
            await selectAsset(button.dataset.assetId || "")
        })
    })
}

function initNavigation(navButtons, contentArea) {
    navButtons.forEach((button) => {
        button.addEventListener("click", () => {
            navButtons.forEach((item) => item.classList.remove("active"))
            button.classList.add("active")

            const page = button.dataset.page
            loadPage(page, contentArea)
        })
    })
}

async function loadPage(page, contentArea = document.getElementById("dynamicContent")) {
    if (!contentArea) {
        return
    }

    try {
        const response = await fetch(`./html/${page}.html`)

        if (!response.ok) {
            throw new Error(`No se pudo cargar ${page}.html`)
        }

        const htmlContent = await response.text()
        contentArea.innerHTML = htmlContent

        if (page === "vistaGeneral") {
            await initVistaGeneralLogic()
        } else if (page === "intereses") {
            await initInteresesLogic()
        } else if (page === "dividendos") {
            await initDividendosLogic()
        }
    } catch (error) {
        console.error(error)
        contentArea.innerHTML = `<div class="pageError">Error de carga: no se pudo abrir ${page}.html</div>`
    }
}

async function initInteresesLogic() {
    await renderInteresesTable()

    const interesesBody = document.getElementById("interesesBody")
    const addRowButton = document.getElementById("addRowBtn")
    const exportJsonButton = document.getElementById("exportJsonBtn")
    const importJsonButton = document.getElementById("importJsonBtn")
    const saveInteresesButton = document.getElementById("saveInteresesBtn")

    if (interesesBody) {
        interesesBody.addEventListener("input", () => {
            updateTotals()
        })

        interesesBody.addEventListener("click", handleRowDeleteClick)
        interesesBody.addEventListener("focus", handleCellFocus, true)
        interesesBody.addEventListener("blur", handleCellBlur, true)
    }

    if (addRowButton) {
        addRowButton.addEventListener("click", () => {
            addNewInteresesRow()
        })
    }

    if (exportJsonButton) {
        exportJsonButton.addEventListener("click", () => {
            exportInteresesJson()
        })
    }

    if (importJsonButton) {
        importJsonButton.addEventListener("click", () => {
            importInteresesJson()
        })
    }

    if (saveInteresesButton) {
        saveInteresesButton.addEventListener("click", async () => {
            try {
                await saveInteresesDataToServer()
                alert("Datos guardados en data/intereses.json")
            } catch (error) {
                alert("Error al guardar: " + error.message)
            }
        })
    }

}




function handleCellFocus(event) {
    const cell = event.target

    if (cell.tagName !== "TD") {
        return
    }

    const tableBody = cell.closest('tbody')
    const columnIndex = cell.cellIndex

    if (tableBody.id === 'interesesBody') {
        if (columnIndex === 1 || columnIndex === 2 || columnIndex === 3) {
            const value = parseEuroNumber(cell.textContent)

            if (cell.textContent.trim() !== "") {
                cell.textContent = normalizeNumberForEdit(value)
            }
        }
    } else if (tableBody.id === 'dividendosBody') {
        if (columnIndex === 3) {
            const value = parseDollarNumber(cell.textContent)

            if (cell.textContent.trim() !== "") {
                cell.textContent = normalizeNumberForEdit(value)
            }
        }

        if (columnIndex === 4 || columnIndex === 5) {
            const value = parseEuroNumber(cell.textContent)

            if (cell.textContent.trim() !== "") {
                cell.textContent = normalizeNumberForEdit(value)
            }
        }
    } else if (tableBody.id === 'assetOperationsBody') {
        if (columnIndex === 3 || columnIndex === 4 || columnIndex === 5) {
            const value = parseEuroNumber(cell.textContent)

            if (cell.textContent.trim() !== "") {
                cell.textContent = normalizeNumberForEdit(value)
            }
        }
    }
}

