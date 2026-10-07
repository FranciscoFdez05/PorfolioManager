// Modales compartidos (confirmar escribiendo, editar activo) y modo de la barra lateral.
//
// Separado de js/cartera/assets.js, que pasaba de 6.000 líneas. Es código
// de nivel superior que comparte el ámbito global con el resto de trozos
// (index.html los carga seguidos y en este orden); no ha cambiado.

// ── Confirmación escribiendo el nombre ───────────────────────────────────────
//
// Los borrados que se llevan otras cosas por delante —un activo con sus
// compras, un año entero, una cuenta— piden teclear el nombre de lo que se
// borra en vez de un simple "Sí, eliminar". Es el mismo trato que ya recibía
// borrar un portfolio, y por el mismo motivo: no hay papelera, así que la única
// defensa es que el gesto no se pueda hacer sin querer.
//
// Se compara sin distinguir mayúsculas ni espacios de más: lo que se busca es
// una pausa para leer qué se está borrando, no un examen de mecanografía. Un
// `requireText` vacío deja el diálogo exactamente como estaba.
function _confirmTextoNormalizado(valor) {
    return String(valor ?? "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
}

function _confirmTextoCoincide() {
    const exigido = confirmModalState?.requireText
    if (!exigido) return true
    const campo = document.getElementById("confirmModalTypeInput")
    return _confirmTextoNormalizado(campo?.value) === _confirmTextoNormalizado(exigido)
}

/** Enciende el botón de confirmar solo cuando lo tecleado cuadra. */
function _confirmSincronizarBoton() {
    const boton = document.getElementById("confirmModalAcceptBtn")
    if (boton) boton.disabled = !_confirmTextoCoincide()
}

function openConfirmModal({
    title = "Confirmar acción",
    message = "¿Seguro que quieres continuar?",
    confirmLabel = "Confirmar",
    onConfirm,
    confirmSide = "left",
    requireText = ""
}) {
    const confirmModalOverlay = document.getElementById("confirmModalOverlay")
    const confirmModalTitle = document.getElementById("confirmModalTitle")
    const confirmModalMessage = document.getElementById("confirmModalMessage")
    const confirmModalAcceptButton = document.getElementById("confirmModalAcceptBtn")
    const confirmModalActions = document.querySelector(".confirmModalActions")

    if (
        !confirmModalOverlay ||
        !confirmModalTitle ||
        !confirmModalMessage ||
        !confirmModalAcceptButton ||
        !confirmModalActions
    ) {
        return
    }

    confirmModalTitle.textContent = title
    confirmModalMessage.textContent = message
    confirmModalAcceptButton.textContent = confirmLabel
    confirmModalActions.classList.toggle("confirmPrimaryRight", confirmSide === "right")

    const exigido = String(requireText || "").trim()
    const caja = document.getElementById("confirmModalTypeBox")
    const campo = document.getElementById("confirmModalTypeInput")
    const nombre = document.getElementById("confirmModalTypeName")

    if (caja && campo && nombre) {
        caja.classList.toggle("hidden", !exigido)
        nombre.textContent = exigido
        campo.value = ""
    }

    confirmModalOverlay.classList.remove("hidden")
    alignConfirmModalToContent()
    confirmModalState = { onConfirm, requireText: exigido }
    _confirmSincronizarBoton()

    if (exigido) campo?.focus()
}

function closeConfirmModal() {
    const confirmModalOverlay = document.getElementById("confirmModalOverlay")

    if (!confirmModalOverlay) {
        return
    }

    confirmModalOverlay.classList.add("hidden")
    confirmModalOverlay.style.padding = ""
    document.querySelector(".confirmModalActions")?.classList.remove("confirmPrimaryRight")
    document.getElementById("confirmModalCancelBtn")?.classList.remove("hidden")

    // El campo se limpia y el botón se rehabilita aquí: si el estado de un
    // diálogo sobreviviera al cierre, el siguiente saldría bloqueado sin decir
    // por qué.
    document.getElementById("confirmModalTypeBox")?.classList.add("hidden")
    const campo = document.getElementById("confirmModalTypeInput")
    if (campo) campo.value = ""
    const aceptar = document.getElementById("confirmModalAcceptBtn")
    if (aceptar) aceptar.disabled = false

    confirmModalState = null
}

function showAlert(message, title = "Aviso") {
    const cancelBtn = document.getElementById("confirmModalCancelBtn")
    if (cancelBtn) cancelBtn.classList.add("hidden")
    openConfirmModal({
        title,
        message,
        confirmLabel: "Aceptar",
        confirmSide: "right",
        onConfirm: null
    })
}

function initConfirmModal(confirmModalOverlay, confirmModalAcceptButton, confirmModalCancelButton) {
    const campoConfirmacion = document.getElementById("confirmModalTypeInput")

    if (campoConfirmacion) {
        campoConfirmacion.addEventListener("input", _confirmSincronizarBoton)
        campoConfirmacion.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            if (_confirmTextoCoincide()) confirmModalAcceptButton?.click()
        })
    }

    if (confirmModalAcceptButton) {
        confirmModalAcceptButton.addEventListener("click", async () => {
            // Además del botón apagado: el clic puede llegar por teclado o por
            // un script, y lo que no se puede es borrar sin que cuadre.
            if (!_confirmTextoCoincide()) return

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
    }

    window.addEventListener("resize", alignConfirmModalToContent)
}

async function submitAssetModal() {
    const assetNameInput = document.getElementById("assetNameInput")
    const assetTypeSelect = document.getElementById("assetTypeSelect")
    const assetTickerInput = document.getElementById("assetTickerInput")
    const assetSearchFeedback = document.getElementById("assetSearchFeedback")

    if (!assetNameInput || !assetTypeSelect || !assetTickerInput || !assetSearchFeedback) {
        return
    }

    const name = assetNameInput.value.trim()
    const type = assetTypeSelect.value.trim()
    const marketSymbol = assetTickerInput.value.trim().toUpperCase()
    const explicitProvider = assetTickerInput.dataset.marketProvider
    const marketProvider = explicitProvider || inferMarketProviderFromSymbol(marketSymbol, "finnhub")
    const color = document.getElementById("assetColorInput")?.value || ASSET_COLOR_PALETTE[0]
    const tvSymbol = decodeTVTicker(document.getElementById("assetTVTickerInput")?.value)
    const costeAnual = type === "etfs" ? document.getElementById("assetCosteAnualInput")?.value.trim() || "" : ""

    if (!name) {
        setAssetSearchFeedback(assetSearchFeedback, "Introduce el nombre del activo.", true)
        assetNameInput.focus()
        return
    }

    if (!type) {
        setAssetSearchFeedback(assetSearchFeedback, "Selecciona el tipo de activo.", true)
        assetTypeSelect.focus()
        return
    }

    if (!marketSymbol) {
        setAssetSearchFeedback(assetSearchFeedback, "Introduce o selecciona el ticker de mercado.", true)
        assetTickerInput.focus()
        return
    }

    try {
        setAssetSearchFeedback(assetSearchFeedback, "")
        const response = await createAssetOnServer(
            name,
            type,
            marketSymbol,
            marketProvider,
            color,
            tvSymbol,
            costeAnual
        )
        const createdAsset = response.asset
        closeAssetModal()
        currentAssetId = createdAsset.id
        await refreshAssetsSidebar(createdAsset.id, true)
    } catch (error) {
        console.error(error)
        const detail = error?.serverMessage ? ` ${error.serverMessage}.` : ""
        setAssetSearchFeedback(assetSearchFeedback, `No se pudo crear el activo.${detail}`, true)
    }
}

// La edición toca nombre, ticker, color y ticker de TradingView; el aviso decía
// siempre «no se pudo actualizar el nombre», así que quien cambiaba el color leía
// un error sobre algo que no había tocado. Además va al hueco de mensajes del
// propio modal —que sigue abierto— en vez de a un `alert` que tapa el formulario
// y obliga a empezar de nuevo. Del servidor se aprovecha su mensaje: es el que
// distingue un ticker inválido de una sesión caducada.
function reportEditAssetError(error) {
    console.error(error)

    const detalle = extractApiErrorMessage(error)
    const mensaje = `No se pudieron guardar los cambios del activo.${detalle ? ` ${detalle}` : ""}`
    const feedback = document.getElementById("editAssetSearchFeedback")

    if (feedback) {
        setAssetSearchFeedback(feedback, mensaje, true)
        return
    }

    alert(mensaje)
}

function initEditAssetModal() {
    const editAssetNameInput = document.getElementById("editAssetNameInput")
    const editAssetTickerInput = document.getElementById("editAssetTickerInput")
    const confirmEditAssetModalButton = document.getElementById("confirmEditAssetModalBtn")
    const cancelEditAssetModalButton = document.getElementById("cancelEditAssetModalBtn")
    const editSearchFinnhubButton = document.getElementById("editSearchAssetTickerFinnhubBtn")
    const editSearchEodhdButton = document.getElementById("editSearchAssetTickerEodhdBtn")
    const editSearchYahooButton = document.getElementById("editSearchAssetTickerYahooBtn")
    const editSearchAlphaVantageButton = document.getElementById("editSearchAssetTickerAlphaVantageBtn")
    const editSearchTradingViewButton = document.getElementById("editSearchAssetTickerTradingViewBtn")
    const editAssetSearchFeedback = document.getElementById("editAssetSearchFeedback")
    const editAssetSearchResults = document.getElementById("editAssetSearchResults")

    if (confirmEditAssetModalButton) {
        confirmEditAssetModalButton.addEventListener("click", async () => {
            try {
                await submitEditAssetModal()
            } catch (error) {
                reportEditAssetError(error)
            }
        })
    }

    if (cancelEditAssetModalButton) {
        cancelEditAssetModalButton.addEventListener("click", () => {
            closeEditAssetModal()
        })
    }

    // El buscador ordena según el tipo de activo (una materia prima antes que un
    // contrato perpetuo de un exchange de cripto, un fondo antes que una
    // acción...). En el alta lo da el selector de tipo; aquí, el activo editado.
    const editingAssetType = () =>
        _editingAsset?.type || document.querySelector(".assetTablePage")?.dataset.assetType || ""

    const editConvertCurrencyToggle = document.getElementById("editAssetConvertCurrencyToggle")
    const editConvertCurrencySelect = document.getElementById("editAssetConvertCurrencySelect")
    if (editConvertCurrencyToggle && editConvertCurrencySelect) {
        editConvertCurrencyToggle.addEventListener("change", () => {
            editConvertCurrencySelect.classList.toggle("hidden", !editConvertCurrencyToggle.checked)
        })
    }

    if (editAssetNameInput) {
        editAssetNameInput.addEventListener("keydown", async (event) => {
            if (event.key === "Enter") {
                event.preventDefault()

                try {
                    await submitEditAssetModal()
                } catch (error) {
                    reportEditAssetError(error)
                }
            }
        })
    }

    const runEditTickerSelection = (result, providerName) => {
        if (editAssetTickerInput) {
            editAssetTickerInput.value = result.symbol
            editAssetTickerInput.dataset.marketProvider = String(result.provider || providerName)
                .trim()
                .toLowerCase()
            reorderProviderSearchButtons("editAssetSearchActions", editAssetTickerInput.dataset.marketProvider)
        }
        const sinCotizacion = String(result.price || "").trim() === ""
        const mensaje = sinCotizacion
            ? `Ticker seleccionado (${providerName}): ${result.symbol} — sin cotización disponible, el precio no se actualizará solo`
            : `Ticker seleccionado (${providerName}): ${result.symbol}`
        setAssetSearchFeedback(editAssetSearchFeedback, mensaje, sinCotizacion)
        renderMarketSearchResults(editAssetSearchResults, [], () => {})
    }

    if (editSearchFinnhubButton) {
        editSearchFinnhubButton.addEventListener("click", async () => {
            const typedTicker = editAssetTickerInput?.value.trim() || ""
            const typedName = editAssetNameInput?.value.trim() || ""
            const searchQuery = typedTicker || typedName

            await handleFinnhubSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: editingAssetType(),
                feedbackElement: editAssetSearchFeedback,
                resultsElement: editAssetSearchResults,
                onSelect: (result) => runEditTickerSelection(result, "Finnhub")
            })
        })
    }

    if (editSearchEodhdButton) {
        editSearchEodhdButton.addEventListener("click", async () => {
            const typedTicker = editAssetTickerInput?.value.trim() || ""
            const typedName = editAssetNameInput?.value.trim() || ""
            const searchQuery = typedTicker || typedName

            await handleEodhdSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: editingAssetType(),
                feedbackElement: editAssetSearchFeedback,
                resultsElement: editAssetSearchResults,
                onSelect: (result) => runEditTickerSelection(result, "EODHD")
            })
        })
    }

    if (editSearchYahooButton) {
        editSearchYahooButton.addEventListener("click", async () => {
            const typedTicker = editAssetTickerInput?.value.trim() || ""
            const typedName = editAssetNameInput?.value.trim() || ""
            const searchQuery = typedTicker || typedName

            await handleYahooSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: editingAssetType(),
                feedbackElement: editAssetSearchFeedback,
                resultsElement: editAssetSearchResults,
                onSelect: (result) => runEditTickerSelection(result, "Yahoo Finance")
            })
        })
    }

    if (editSearchAlphaVantageButton) {
        editSearchAlphaVantageButton.addEventListener("click", async () => {
            const typedTicker = editAssetTickerInput?.value.trim() || ""
            const typedName = editAssetNameInput?.value.trim() || ""
            const searchQuery = typedTicker || typedName

            await handleAlphaVantageSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: editingAssetType(),
                feedbackElement: editAssetSearchFeedback,
                resultsElement: editAssetSearchResults,
                onSelect: (result) => runEditTickerSelection(result, "Alpha Vantage")
            })
        })
    }

    if (editSearchTradingViewButton) {
        editSearchTradingViewButton.addEventListener("click", async () => {
            const typedTicker = editAssetTickerInput?.value.trim() || ""
            const typedName = editAssetNameInput?.value.trim() || ""
            const searchQuery = typedTicker || typedName

            await handleTradingViewSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: editingAssetType(),
                feedbackElement: editAssetSearchFeedback,
                resultsElement: editAssetSearchResults,
                onSelect: (result) => runEditTickerSelection(result, "TradingView")
            })
        })
    }
}

// ── Qué hace pulsar un activo de la barra lateral ────────────────────────────
//
// Dos modos, y el conmutador de la barra elige: abrir la ficha del activo —la
// ventana de siempre, donde además se puede tocar— o abrir solo su gráfico en
// el diálogo centrado, para mirar precios sin salir de donde estabas.
//
// El gráfico va en el diálogo grande y no incrustado en la propia barra: en
// una columna de 300px un gráfico de velas con sus ejes no se lee.
const _SIDEBAR_MODO_KEY = "sidebarAssetMode"

// Activo que se está enseñando en el panel.
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _sidebarAssetActual = null

function getSidebarAssetMode() {
    try {
        return localStorage.getItem(_SIDEBAR_MODO_KEY) === "grafico" ? "grafico" : "activo"
    } catch {
        return "activo"
    }
}

/** Abre el gráfico de un activo, o dice por qué no puede. */
function abrirGraficoDeActivo(asset) {
    if (!asset) return

    // Hay que mirar el ticker y no lo que devuelve buildTVSymbol: cuando el
    // activo no tiene ninguno, esa función cae al nombre en mayúsculas ("SIN
    // TICKER") y el widget abriría un símbolo que no existe en TradingView.
    const tieneTicker = Boolean(
        String(asset.tvSymbol || "").trim() || String(asset.marketSymbol || asset.finnhubSymbol || "").trim()
    )
    const simbolo = tieneTicker ? buildTVSymbol(asset) : ""

    if (!simbolo) {
        showToast("Este activo no tiene ticker de mercado con el que abrir el gráfico", { type: "warning" })
        return
    }

    openTVChartModal(simbolo, asset.name || asset.symbol || simbolo)
}

function initSidebarAssetMode() {
    const barra = document.getElementById("sidebarAssetMode")
    if (!barra || barra.dataset.bound) return
    barra.dataset.bound = "true"

    const sincronizar = () => {
        const modo = getSidebarAssetMode()
        barra.querySelectorAll(".sidebarFilterBtn").forEach((boton) => {
            boton.classList.toggle("active", boton.dataset.modo === modo)
        })
    }

    barra.addEventListener("click", (evento) => {
        const boton = evento.target.closest(".sidebarFilterBtn")
        if (!boton) return
        try {
            localStorage.setItem(_SIDEBAR_MODO_KEY, boton.dataset.modo)
        } catch {
            /* sin persistencia, el modo dura lo que la sesión */
        }
        sincronizar()
    })

    sincronizar()
}

function initAssetModal(
    assetModalOverlay,
    confirmAssetModalButton,
    cancelAssetModalButton,
    assetNameInput,
    assetTypeSelect,
    assetTickerInput,
    searchAssetTickerFinnhubButton,
    searchAssetTickerEodhdButton,
    searchAssetTickerYahooButton,
    searchAssetTickerAlphaVantageButton,
    searchAssetTickerTradingViewButton
) {
    const assetSearchFeedback = document.getElementById("assetSearchFeedback")
    const assetSearchResults = document.getElementById("assetSearchResults")
    initEditAssetModal()

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

    assetTypeSelect?.addEventListener("change", syncAssetCosteAnualField)

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

    const runTickerSelection = (result, providerName) => {
        if (assetTickerInput) {
            assetTickerInput.value = result.symbol
            assetTickerInput.dataset.marketProvider = String(result.provider || providerName)
                .trim()
                .toLowerCase()
            reorderProviderSearchButtons("assetSearchActions", assetTickerInput.dataset.marketProvider)
        }

        if (assetNameInput && !assetNameInput.value.trim()) {
            assetNameInput.value = result.description
        }

        const sinCotizacion = String(result.price || "").trim() === ""
        const mensaje = sinCotizacion
            ? `Ticker seleccionado (${providerName}): ${result.symbol} — sin cotización disponible, el precio no se actualizará solo`
            : `Ticker seleccionado (${providerName}): ${result.symbol}`
        setAssetSearchFeedback(assetSearchFeedback, mensaje, sinCotizacion)
        renderMarketSearchResults(assetSearchResults, [], () => {})
    }

    if (searchAssetTickerFinnhubButton) {
        searchAssetTickerFinnhubButton.addEventListener("click", async () => {
            const typedTicker = assetTickerInput?.value.trim() || ""
            const typedName = assetNameInput?.value.trim() || ""
            const searchQuery = typedName || typedTicker

            await handleFinnhubSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: assetTypeSelect?.value || "",
                feedbackElement: assetSearchFeedback,
                resultsElement: assetSearchResults,
                onSelect: (result) => runTickerSelection(result, "Finnhub")
            })
        })
    }

    if (searchAssetTickerEodhdButton) {
        searchAssetTickerEodhdButton.addEventListener("click", async () => {
            const typedTicker = assetTickerInput?.value.trim() || ""
            const typedName = assetNameInput?.value.trim() || ""
            const searchQuery = typedName || typedTicker

            await handleEodhdSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: assetTypeSelect?.value || "",
                feedbackElement: assetSearchFeedback,
                resultsElement: assetSearchResults,
                onSelect: (result) => runTickerSelection(result, "EODHD")
            })
        })
    }

    if (searchAssetTickerYahooButton) {
        searchAssetTickerYahooButton.addEventListener("click", async () => {
            const typedTicker = assetTickerInput?.value.trim() || ""
            const typedName = assetNameInput?.value.trim() || ""
            const searchQuery = typedName || typedTicker

            await handleYahooSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: assetTypeSelect?.value || "",
                feedbackElement: assetSearchFeedback,
                resultsElement: assetSearchResults,
                onSelect: (result) => runTickerSelection(result, "Yahoo Finance")
            })
        })
    }

    if (searchAssetTickerAlphaVantageButton) {
        searchAssetTickerAlphaVantageButton.addEventListener("click", async () => {
            const typedTicker = assetTickerInput?.value.trim() || ""
            const typedName = assetNameInput?.value.trim() || ""
            const searchQuery = typedName || typedTicker

            await handleAlphaVantageSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: assetTypeSelect?.value || "",
                feedbackElement: assetSearchFeedback,
                resultsElement: assetSearchResults,
                onSelect: (result) => runTickerSelection(result, "Alpha Vantage")
            })
        })
    }

    if (searchAssetTickerTradingViewButton) {
        searchAssetTickerTradingViewButton.addEventListener("click", async () => {
            const typedTicker = assetTickerInput?.value.trim() || ""
            const typedName = assetNameInput?.value.trim() || ""
            const searchQuery = typedName || typedTicker

            await handleTradingViewSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: assetTypeSelect?.value || "",
                feedbackElement: assetSearchFeedback,
                resultsElement: assetSearchResults,
                onSelect: (result) => runTickerSelection(result, "TradingView")
            })
        })
    }

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && assetModalState?.isOpen) {
            closeAssetModal()
            return
        }

        if (event.key === "Escape" && editAssetModalState?.isOpen) {
            closeEditAssetModal()
            return
        }

        if (event.key === "Escape" && confirmModalState) {
            closeConfirmModal()
        }
    })
}
