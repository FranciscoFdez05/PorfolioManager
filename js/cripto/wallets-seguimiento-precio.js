// Cripto > Seguimiento: ticker de precio de un token.
//
// Trozo de js/cripto/wallets-seguimiento.js. Comparte con el resto de wallets-seguimiento-*.js el
// ámbito global y se carga detrás de wallets-seguimiento.js, en el orden de index.html.

// ── Ticker de precio de un token ──────────────────────────────────────────────
// Para los tokens sin activo en Activos. Se guarda en el servidor, que lo usa
// para el valor del visor y para la lista «Seguimiento» de la Watchlist.

// `buscar` envuelve en una función a los buscadores de js/cartera/assets-ficha.js
// para resolverlos al usarlos, no al cargar este archivo.
const WALLETS_SEG_PROVEEDORES_PRECIO = {
    tradingview: {
        nombre: "TradingView",
        ejemplo: "BINANCE:PEPEUSDT",
        buscar: (datos) => handleTradingViewSearch(datos)
    },
    finnhub: { nombre: "Finnhub", ejemplo: "BINANCE:PEPEUSDT", buscar: (datos) => handleFinnhubSearch(datos) },
    eodhd: { nombre: "EODHD", ejemplo: "PEPE-USD.CC", buscar: (datos) => handleEodhdSearch(datos) },
    yahoo: { nombre: "Yahoo Finance", ejemplo: "PEPE24478-USD", buscar: (datos) => handleYahooSearch(datos) },
    alphavantage: { nombre: "Alpha Vantage", ejemplo: "", buscar: (datos) => handleAlphaVantageSearch(datos) }
}

function abrirPrecioToken({ red: redClave, contrato, simbolo }) {
    abrirVentanaTicker({
        titulo: `Ticker de precio de ${simbolo}`,
        texto: `Contrato ${contrato}. Con este ticker se calcula su valor y se cotiza en la lista «Seguimiento» de la Watchlist.`,
        simbolo,
        actual: walletsSegPrecioToken({ contrato }, redClave),
        guardarTicker: (proveedor, ticker) =>
            guardarPrecioToken("/api/wallets/tokens/precio", { red: redClave, contrato, proveedor, ticker }, false)
    })
}

// Ventana de proveedor y ticker, compartida con la Watchlist (js/analisis/seguimiento.js).
// `guardarTicker(proveedor, ticker)` devuelve el mensaje de error, o "" si se guardó.
// `simbolo` es lo que se busca mientras el campo del ticker esté vacío.
function abrirVentanaTicker({ titulo, texto, simbolo = "", actual, guardarTicker }) {
    document.getElementById("walletsSegPrecioOverlay")?.remove()
    // El orden y el de por defecto (el primero, TradingView) los manda el servidor.
    const claves = walletsEstado.proveedoresPrecio || Object.keys(WALLETS_SEG_PROVEEDORES_PRECIO)
    const proveedor = actual?.proveedor || claves[0]
    const opciones = claves
        .map(
            (clave) =>
                `<option value="${escapeHtml(clave)}"${clave === proveedor ? " selected" : ""}>${escapeHtml(WALLETS_SEG_PROVEEDORES_PRECIO[clave]?.nombre || clave)}</option>`
        )
        .join("")
    const overlay = document.createElement("div")
    overlay.id = "walletsSegPrecioOverlay"
    overlay.className = "modalOverlay"
    overlay.innerHTML = `
        <div class="assetModal" role="dialog" aria-modal="true" aria-labelledby="walletsSegPrecioTitulo">
            <h3 class="assetModalTitle" id="walletsSegPrecioTitulo">${escapeHtml(titulo)}</h3>
            <p class="assetModalHint">${escapeHtml(texto)}</p>
            <label class="assetModalLabel" for="walletsSegPrecioProveedor">Proveedor</label>
            <select id="walletsSegPrecioProveedor" class="assetModalSelect">${opciones}</select>
            <label class="assetModalLabel" for="walletsSegPrecioTicker">Ticker</label>
            <input id="walletsSegPrecioTicker" class="assetModalInput" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(actual?.ticker || "")}">
            <div class="assetSearchActions">
                <button type="button" class="secondaryButton" id="walletsSegPrecioBuscar"></button>
            </div>
            <div class="assetSearchFeedback hidden" id="walletsSegPrecioFeedback"></div>
            <div class="assetSearchResults hidden" id="walletsSegPrecioResultados"></div>
            <p class="gastosCreateModalFeedback hidden" id="walletsSegPrecioError"></p>
            <div class="assetModalActions">
                <button type="button" class="cancelButton" id="walletsSegPrecioCancelar">Cancelar</button>
                <button type="button" class="primaryButton" id="walletsSegPrecioGuardar" data-no-autohide="true">Guardar</button>
            </div>
        </div>`
    const select = overlay.querySelector("#walletsSegPrecioProveedor")
    const input = overlay.querySelector("#walletsSegPrecioTicker")
    const errorEl = overlay.querySelector("#walletsSegPrecioError")
    const guardar = overlay.querySelector("#walletsSegPrecioGuardar")
    const ponerEjemplo = () => {
        const ejemplo = WALLETS_SEG_PROVEEDORES_PRECIO[select.value]?.ejemplo
        input.placeholder = ejemplo ? `Ej: ${ejemplo}` : "Ticker en ese proveedor"
    }
    const cerrar = () => overlay.remove()
    const confirmar = async () => {
        const ticker = input.value.trim()
        if (!ticker) {
            errorEl.textContent = "Escribe el ticker."
            errorEl.classList.remove("hidden")
            return
        }
        guardar.disabled = true
        // El servidor comprueba que cotiza antes de guardarlo: el error se queda en la ventana.
        const error = await guardarTicker(select.value, ticker)
        guardar.disabled = false
        if (error) {
            errorEl.textContent = error
            errorEl.classList.remove("hidden")
            return
        }
        cerrar()
    }
    select.addEventListener("change", ponerEjemplo)
    overlay.querySelector("#walletsSegPrecioCancelar").addEventListener("click", cerrar)
    guardar.addEventListener("click", confirmar)
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") confirmar()
        if (event.key === "Escape") cerrar()
    })
    ponerEjemplo()
    activarBusquedaTicker(overlay, simbolo)
    document.body.appendChild(overlay)
    input.focus()
}

// Búsqueda con previsualización de la ventana del ticker: mismas tarjetas de precio
// y variación que al añadir un activo. Va con botón y no al teclear porque cada
// búsqueda gasta cuota del proveedor.
function activarBusquedaTicker(overlay, simbolo) {
    const select = overlay.querySelector("#walletsSegPrecioProveedor")
    const input = overlay.querySelector("#walletsSegPrecioTicker")
    const boton = overlay.querySelector("#walletsSegPrecioBuscar")
    const feedback = overlay.querySelector("#walletsSegPrecioFeedback")
    const resultados = overlay.querySelector("#walletsSegPrecioResultados")
    const errorEl = overlay.querySelector("#walletsSegPrecioError")
    const nombreProveedor = () => WALLETS_SEG_PROVEEDORES_PRECIO[select.value]?.nombre || select.value
    const ponerBoton = () => {
        boton.textContent = `Buscar ${nombreProveedor()}`
    }
    const limpiar = () => {
        setAssetSearchFeedback(feedback, "")
        renderMarketSearchResults(resultados, [], () => {})
    }
    // La tarjeta elegida se queda a la vista: es la previsualización de lo que se va
    // a guardar. El cambio de proveedor va primero porque su evento limpia la búsqueda.
    const elegir = (resultado) => {
        const proveedor = String(resultado.provider || "")
            .trim()
            .toLowerCase()
        if (proveedor && proveedor !== select.value && WALLETS_SEG_PROVEEDORES_PRECIO[proveedor]) {
            select.value = proveedor
            select.dispatchEvent(new Event("change", { bubbles: true }))
        }
        input.value = resultado.symbol
        errorEl.classList.add("hidden")
        const sinCotizacion = String(resultado.price || "").trim() === ""
        const aviso = sinCotizacion ? " — sin cotización disponible" : ""
        setAssetSearchFeedback(
            feedback,
            `Ticker seleccionado (${nombreProveedor()}): ${resultado.symbol}${aviso}`,
            sinCotizacion
        )
        renderMarketSearchResults(resultados, [resultado], elegir)
    }
    const buscar = async () => {
        boton.disabled = true
        try {
            await WALLETS_SEG_PROVEEDORES_PRECIO[select.value]?.buscar?.({
                query: input.value.trim() || simbolo,
                assetType: "cripto",
                feedbackElement: feedback,
                resultsElement: resultados,
                onSelect: elegir
            })
        } finally {
            boton.disabled = false
        }
    }
    select.addEventListener("change", () => {
        ponerBoton()
        limpiar()
    })
    // Lo que se ve debajo deja de corresponder al ticker en cuanto se edita a mano.
    input.addEventListener("input", limpiar)
    boton.addEventListener("click", buscar)
    ponerBoton()
}

// Devuelve el mensaje de error, o "" si se guardó. Con los tokens ya leídos se
// vuelven a leer: el valor en euros lo calcula el servidor con el ticker.
// `avisar`: sacar el error como toast (la ventana del ticker lo enseña dentro).
async function guardarPrecioToken(url, cuerpo, avisar = true) {
    try {
        walletsSegAplicarTokens(await walletsPost(url, cuerpo))
    } catch (error) {
        const mensaje = error.message || "No se pudo guardar el ticker"
        if (avisar) showToast(mensaje, { type: "error" })
        return mensaje
    }
    renderWalletsSeguimiento()
    if (walletsSegDetalle?.tokens && !walletsSegDetalle.tokens.cargando) cargarTokensDetalle()
    return ""
}
