// Barra lateral de activos: lista, avisos de API, arrastrar para reordenar.
//
// Separado de js/cartera/assets.js, que pasaba de 6.000 líneas. Es código
// de nivel superior que comparte el ámbito global con el resto de trozos
// (index.html los carga seguidos y en este orden); no ha cambiado.

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

// Qué activos ha fallado el proveedor en el último intento, y con qué mensaje.
// El bucle de actualización se lo tragaba en la consola, así que un precio
// congelado por una clave caducada se veía igual que uno congelado por ser
// sábado: los dos, un número quieto sin ninguna explicación.
const _falloApiPorActivo = new Map()

function _mensajeDeFalloApi(error) {
    const texto = String(error?.message || error || "").trim()

    // refreshAssetMarketDataOnServer lanza `HTTP 503: {"ok": false, "error": …}`.
    // Interesa el motivo de dentro, que es el que dice si es la clave, la cuota
    // o el proveedor; el código HTTP no le dice nada a nadie.
    const inicioJson = texto.indexOf("{")

    if (inicioJson !== -1) {
        try {
            const datos = JSON.parse(texto.slice(inicioJson))
            if (datos?.error) {
                return String(datos.error)
            }
        } catch {
            /* no era JSON: se usa el texto tal cual */
        }
    }

    return texto || "El proveedor no respondió"
}

function _avisoDePausa(motivo, tipos) {
    const cuando = motivo === "fin de semana" ? "es fin de semana" : "está fuera del horario de mercado (22:00–8:00)"
    const vuelve = motivo === "fin de semana" ? "el lunes a las 8:00" : "a las 8:00"
    const nombres = {
        acciones: "acciones",
        etfs: "ETF",
        comoditis: "comodities",
        cripto: "cripto"
    }
    const afectados = tipos.map((tipo) => nombres[tipo] || tipo).join(", ")

    return `Precios en pausa: ${cuando}. No se piden cotizaciones de ${afectados} hasta ${vuelve}.`
}

function _crearBotonDeActivo(asset, displayPrice, displayCurrency, { isStale, enPausa, falloApi }) {
    const portfolioBadge =
        window._viewAllPortfolios && asset.portfolioName
            ? `<span class="assetPortfolioBadge">${escapeHtml(asset.portfolioName)}</span>`
            : ""
    const {
        changePctStr,
        changeClass,
        moneyStr: changeMoneyStr
    } = buildChangeMoneyDisplay(asset, displayPrice, displayCurrency)

    // El ⚠ solo marca fallos del proveedor. Un precio parado por la pausa no es
    // un problema —lo ha pedido el usuario en Ajustes—, así que se queda en
    // gris: si la pausa también pintase advertencias, el aviso dejaría de
    // significar «esto hay que mirarlo» cada fin de semana.
    const aviso = falloApi ? `<span class="assetBtnAviso" aria-hidden="true">⚠</span>` : ""

    const button = document.createElement("button")
    button.className = [
        "assetBtn",
        asset.id === currentAssetId ? "selected" : "",
        isStale ? "stale" : "",
        enPausa ? "pausado" : "",
        falloApi ? "falloApi" : ""
    ]
        .filter(Boolean)
        .join(" ")

    if (falloApi) {
        button.title = `No se pudo actualizar: ${falloApi}`
    } else if (enPausa) {
        button.title = _avisoDePausa(motivoPausaMercado(), [asset.type || ""])
    }

    button.dataset.assetId = asset.id
    button.dataset.assetOrder = String(asset.order ?? 0)
    button.dataset.tvSymbol = asset.tvSymbol || ""
    button.dataset.marketSymbol = asset.marketSymbol || asset.finnhubSymbol || ""
    button.dataset.marketProvider = asset.marketProvider || ""
    button.dataset.assetSymbol = asset.symbol || ""
    button.dataset.assetName = asset.name || ""
    button.draggable = !window._viewAllPortfolios
    button.innerHTML = `
                <span class="assetBtnName">${escapeHtml(asset.name || asset.symbol || "Activo")}${portfolioBadge}${aviso}</span>
                <span class="assetBtnPrice">${formatMoney(displayPrice, displayCurrency)}</span>
                <span class="assetBtnChange ${changeClass}">${changeMoneyStr}</span>
                <span class="assetBtnChangePct ${changeClass}">${changePctStr || "—"}</span>
            `

    return button
}

function _renderAvisoDePausa(visible) {
    const contenedor = document.getElementById("assetsPausaAviso")

    if (!contenedor) {
        return
    }

    const motivo = motivoPausaMercado()
    const pausados = tiposEnPausa()
    const tiposVisibles = new Set(
        visible.map((asset) =>
            String(asset.type || "")
                .trim()
                .toLowerCase()
        )
    )
    const afectados = pausados.filter((tipo) => tiposVisibles.has(tipo))

    // Sin activos de un tipo pausado no hay nada que explicar: el aviso saldría
    // todos los fines de semana en una cartera que solo tiene cripto.
    if (!motivo || afectados.length === 0) {
        contenedor.hidden = true
        contenedor.textContent = ""
        return
    }

    const sigueVivo = [...tiposVisibles].some((tipo) => tipo && !pausados.includes(tipo))
    contenedor.hidden = false
    contenedor.textContent = _avisoDePausa(motivo, afectados) + (sigueVivo ? " El resto se sigue actualizando." : "")
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

    _renderAvisoDePausa(visible)

    for (const asset of visible) {
        const isStale =
            staleMs < Infinity && asset.lastUpdated ? now - new Date(asset.lastUpdated).getTime() > staleMs : false
        const displayCurrency = asset.currency || "EUR"
        let displayPrice

        try {
            displayPrice = await getAssetDisplayPriceValue(asset)
        } catch (error) {
            console.error(
                `No se pudo renderizar el precio del activo ${asset.name || asset.symbol || asset.id}:`,
                error
            )
            displayPrice = parseLooseNumber(asset.price || "") || 0
        }

        fragment.appendChild(
            _crearBotonDeActivo(asset, displayPrice, displayCurrency, {
                isStale,
                enPausa: tipoEnPausa(asset.type),
                falloApi: _falloApiPorActivo.get(asset.id) || ""
            })
        )
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

    // Comparar en un contenedor aparte, no ya insertado: montar el fragmento
    // directamente en assetsList y comparar después habría sido el mismo
    // reflujo que se quiere evitar. Se compara contra el innerHTML real de
    // assetsList (no contra una copia aparte en una variable de módulo):
    // si algo ajeno recrea ese nodo entre medias, una copia aparte podría
    // decir "no ha cambiado" sobre un DOM que en realidad está vacío.
    const contenedorTemporal = document.createElement("div")
    contenedorTemporal.appendChild(fragment)
    const htmlNuevo = contenedorTemporal.innerHTML

    if (htmlNuevo === assetsList.innerHTML) {
        // Nada distinto de lo ya pintado (caso normal del refresco periódico
        // cuando los precios no se han movido): no tocar el DOM, para no
        // perder el scroll ni el :hover ni repetir el rebind de abajo.
        return
    }

    assetsList.innerHTML = htmlNuevo

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
                // El activo de la watchlist acaba de nacer en la base de datos:
                // se abre su ficha, como cualquier otro del lateral.
                clearNavSelection()
                await selectAsset(assetId)
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

    const detChangeAbs = document.getElementById("detChangeAbs")
    if (detChangeAbs) {
        detChangeAbs.textContent = "0,00 €"
        detChangeAbs.classList.remove("negative")
    }

    const detWeight = document.getElementById("detWeight")
    if (detWeight) {
        detWeight.textContent = "---"
    }

    _sidebarAssetActual = null
}

async function refreshAssetsSidebar(selectedAssetId = currentAssetId, renderTable = false) {
    try {
        // Las tres primeras solo rellenan su propia caché de módulo
        // (externalVentasRowsCache y compañía) y loadAssetsList pide algo
        // distinto (/api/activos): no dependen entre sí, solo hace falta que
        // las cuatro terminen antes de renderAssetsList, que es quien las lee.
        const [, , , assets] = await Promise.all([
            loadVentasRowsForAssets(),
            loadTransaccionesRowsForAssets(),
            loadOperacionesRowsForAssets(),
            loadAssetsList()
        ])
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

async function selectAsset(assetId, { abrirFicha = true } = {}) {
    if (!assetId) {
        return
    }

    currentAssetId = assetId
    const assetData = await loadAssetData(assetId)
    await updateAssetDetail(assetData)
    await renderAssetsList(await loadAssetsList())

    if (abrirFicha) {
        renderAssetTablePage(assetData)
    }

    return assetData
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
