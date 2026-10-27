let conversionesSelectedAssetId = null
let conversionesCurrentAsset = null
let conversionesAutosaveTimeout = null
let conversionesCryptoAssets = []

const CV_AYUDA_VALOR =
    "Valor de mercado en el momento de la conversión; necesario para el informe de la renta. En una salida es el valor al que se transmite lo entregado (sale como permuta); en una entrada es el coste de adquisición de lo recibido."

async function initConversionesLogic() {
    const assetMenu = document.getElementById("conversionesAssetMenu")
    const addRowButton = document.getElementById("addConversionRowBtn")
    const saveButton = document.getElementById("saveConversionesBtn")
    const body = document.getElementById("conversionesBody")
    const assets = await loadAssetsList()

    if (!assetMenu || !body) {
        return
    }

    conversionesCryptoAssets = assets.filter((a) => a.type === "cripto")
    const firstId = conversionesCryptoAssets[0]?.id || ""
    conversionesSelectedAssetId =
        currentAssetId && conversionesCryptoAssets.find((a) => a.id === currentAssetId) ? currentAssetId : firstId
    renderConversionesAssetMenu()

    if (conversionesSelectedAssetId) {
        await loadConversionesAsset(conversionesSelectedAssetId)
    } else {
        renderConversionesSinActivos()
    }

    if (!assetMenu.dataset.bound) {
        assetMenu.dataset.bound = "true"
        assetMenu.addEventListener("change", async (event) => {
            const input = event.target.closest("input")
            if (!input || input.value === conversionesSelectedAssetId) return
            await flushConversionesPendingChanges()
            conversionesSelectedAssetId = input.value
            renderConversionesAssetMenu()
            await loadConversionesAsset(conversionesSelectedAssetId)
        })
    }


    const filtroButton = document.getElementById("cvFiltroSinValorBtn")
    if (filtroButton && !filtroButton.dataset.bound) {
        filtroButton.dataset.bound = "true"
        filtroButton.addEventListener("click", () => {
            body.classList.toggle("cvSoloSinValor")
            refrescarConversionesSinValor()
        })
    }

    if (addRowButton && !addRowButton.dataset.bound) {
        addRowButton.dataset.bound = "true"
        addRowButton.addEventListener("click", () => {
            if (!conversionesCurrentAsset) return
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

// Un botón por cripto con su color de Activos, como en Transacciones. Aquí se
// elige una sola: las conversiones se guardan dentro de la ficha de cada activo.
function renderConversionesAssetMenu() {
    const menu = document.getElementById("conversionesAssetMenu")
    const addButton = document.getElementById("addConversionRowBtn")

    if (!menu) {
        return
    }

    menu.innerHTML = ""
    if (addButton) addButton.disabled = !conversionesCryptoAssets.length

    conversionesCryptoAssets.forEach((asset) => {
        const label = document.createElement("label")
        label.className = "overviewFilterOption transaccionesFilterChip"
        label.style.setProperty("--chipColor", colorLegibleEnTema(asset.color || "#8899bb"))
        const checked = asset.id === conversionesSelectedAssetId ? " checked" : ""
        label.innerHTML = `<input type="radio" name="conversionesAsset" value="${escapeHtml(asset.id)}"${checked}><span>${escapeHtml(asset.name || asset.id)}</span>`
        menu.appendChild(label)
    })
    refrescarTiraPestanas(menu)
}

function renderConversionesSinActivos() {
    document.getElementById("conversionesBody")?.replaceChildren()
    document.getElementById("conversionesTableWrapper")?.classList.add("hidden")
    document.getElementById("conversionesEmptyMsg")?.classList.add("hidden")
    document.getElementById("conversionesNoAssetMsg")?.classList.remove("hidden")
    renderConversionesStats([], null)
}

async function loadConversionesAsset(assetId) {
    if (!assetId) {
        return
    }

    conversionesCurrentAsset = await loadAssetData(assetId)
    currentAssetId = assetId
    renderConversionesRows(getAssetConversionRows(conversionesCurrentAsset), conversionesCurrentAsset)
}

function renderConversionesRows(rows, asset) {
    const body = document.getElementById("conversionesBody")

    if (!body) {
        return
    }

    body.innerHTML = ""
    const conversionesEmptyEl = document.getElementById("conversionesEmptyMsg")
    const tableWrapper = document.getElementById("conversionesTableWrapper")
    document.getElementById("conversionesNoAssetMsg")?.classList.add("hidden")

    if (!rows.length) {
        if (conversionesEmptyEl) conversionesEmptyEl.classList.remove("hidden")
        if (tableWrapper) tableWrapper.classList.add("hidden")
        renderConversionesStats([], asset)
        return
    }

    if (conversionesEmptyEl) conversionesEmptyEl.classList.add("hidden")
    if (tableWrapper) tableWrapper.classList.remove("hidden")

    rows.forEach((row) => {
        body.appendChild(buildConversionesRowElement(row, asset))
    })
    bindTableSort(body.closest("table"), "conversiones")
    renderConversionesStats(rows, asset)
    refrescarConversionesSinValor()
}

// Valor de mercado en euros de una conversión, que el usuario teclea. Devuelve
// `{ ok, valor }` con el valor en texto canónico ("" si está vacío); no es ok un
// texto ilegible ni un importe negativo, igual que en el servidor.
function parseConversionValorEur(texto) {
    const original = String(texto ?? "").trim()
    if (!original) {
        return { ok: true, valor: "" }
    }
    const numero = parseLooseNumber(original)
    if (numero === null || numero < 0) {
        return { ok: false, valor: "" }
    }
    return { ok: true, valor: toCanonicalNumber(original) }
}

// Marca visible de las conversiones sin valor: cuenta cuántas faltan en el botón
// de la barra, que además filtra la tabla para completarlas. Sin pendientes el
// botón se oculta y el filtro se apaga.
function refrescarConversionesSinValor() {
    const body = document.getElementById("conversionesBody")
    const boton = document.getElementById("cvFiltroSinValorBtn")
    if (!body || !boton) return

    const pendientes = body.querySelectorAll("tr.cvFilaSinValor").length
    if (!pendientes) body.classList.remove("cvSoloSinValor")
    const filtrando = body.classList.contains("cvSoloSinValor")
    boton.classList.toggle("hidden", !pendientes)
    boton.classList.toggle("cvFiltroActivo", filtrando)
    boton.setAttribute("aria-pressed", String(filtrando))
    boton.textContent = filtrando
        ? `Mostrar todas (${pendientes} sin valor)`
        : `${pendientes} sin valor en euros`
}

// Símbolo base de una cripto de la lista de Activos (BTC, ETH...), el mismo
// con el que se escriben el par y el tipo de cada conversión.
function getConversionAssetSymbol(asset) {
    return deriveAssetBaseSymbolFromData(asset || {})
}

function findConversionAssetBySymbol(symbol) {
    const buscado = String(symbol || "")
        .trim()
        .toUpperCase()
    return conversionesCryptoAssets.find((asset) => getConversionAssetSymbol(asset) === buscado) || null
}

function isConversionEntrada(row, asset) {
    return String(row.tipo || "").toLowerCase() === getConvertedInOperationLabel(getConversionAssetSymbol(asset)).toLowerCase()
}

function formatConversionQuantity(value) {
    return formatAssetParticipationValue(String(value ?? ""), "cripto")
}

// Precio de cambio con las cifras que importan, como en los extractos de los
// exchanges: «1 BTC = 35,07 ETH». Seis cifras significativas bastan para cubrir
// desde 52,42 XRP hasta 0,0000123 BTC sin una cola de ceros.
function formatConversionRate(value) {
    return value.toLocaleString("es-ES", { maximumSignificantDigits: 6 })
}

// Una fila como en el historial de conversiones de un exchange: qué se vendió,
// qué se compró y a qué precio, en los dos sentidos. En una entrada se vende la
// contraparte y se compra la cripto de la ficha; en una salida, al revés. Las
// cantidades tal cual van en data-value para leerlas al guardar, sin signo ni
// símbolo.
function buildConversionesRowElement(row = {}, asset = conversionesCurrentAsset) {
    const rowElement = document.createElement("tr")
    rowElement.dataset.rowId = String(row.id || createConversionRowId())

    const simbolo = getConversionAssetSymbol(asset)
    const entrada = isConversionEntrada(row, asset)
    const contraparteSimbolo = String(row.par || "").split("/")[1] || ""
    const contraparte = findConversionAssetBySymbol(contraparteSimbolo)
    const color = colorLegibleEnTema(contraparte?.color || "#8899bb")
    const cantidad = String(row.cantidad || "").trim()
    const cantidadContraparte = String(row.cantidadContraparte || "").trim()
    const valorEur = String(row.valorEur || "").trim()
    rowElement.classList.toggle("cvFilaSinValor", !valorEur)

    const celdaCantidad = (campo, valor, sym, clase, signo) =>
        `<td data-field="${campo}" data-value="${escapeHtml(valor)}" class="${clase}">${
            valor ? `${signo}${formatConversionQuantity(valor)} <span class="cvSimbolo">${escapeHtml(sym)}</span>` : "—"
        }</td>`
    const celdaPropia = celdaCantidad("cantidad", cantidad, simbolo, entrada ? "cvCantidadIn" : "cvCantidadOut", entrada ? "+" : "−")
    const celdaContraparte = celdaCantidad(
        "cantidadContraparte",
        cantidadContraparte,
        contraparteSimbolo,
        entrada ? "cvCantidadOut" : "cvCantidadIn",
        entrada ? "−" : "+"
    )

    const propia = parseLooseNumber(cantidad) || 0
    const otra = parseLooseNumber(cantidadContraparte) || 0
    // Como en los extractos de los exchanges, el par se escribe «lo que se
    // vende + lo que se compra» (ETHBTC) y el precio es el de lo vendido.
    const [vende, compra] = entrada ? [contraparteSimbolo, simbolo] : [simbolo, contraparteSimbolo]
    const [cantVende, cantCompra] = entrada ? [otra, propia] : [propia, otra]
    const hayPrecio = cantVende > 0 && cantCompra > 0 && contraparteSimbolo
    const precio = hayPrecio
        ? `1 ${escapeHtml(vende)} = ${formatConversionRate(cantCompra / cantVende)} ${escapeHtml(compra)}`
        : "—"
    const precioInverso = hayPrecio
        ? `1 ${escapeHtml(compra)} = ${formatConversionRate(cantVende / cantCompra)} ${escapeHtml(vende)}`
        : "—"
    // Valor de lo convertido al precio de hoy de la cripto de la ficha: orienta
    // sobre el tamaño de cada conversión. No es el valor en la fecha de la
    // conversión, que no se guarda.
    const precioHoy = parseEuroNumber(asset?.price || "")
    const monedaActivo = normalizeCurrencyCode(asset?.currency || "EUR")
    const valorHoy = propia > 0 && precioHoy > 0 ? formatMoney(propia * precioHoy, monedaActivo) : "—"

    rowElement.innerHTML = `
        <td data-field="fecha">${escapeHtml(row.fecha)}</td>
        <td data-field="tipo" data-value="${escapeHtml(row.tipo)}" title="${escapeHtml(row.tipo)}">
            <span class="cvTipoBadge ${entrada ? "cvTipoBadgeIn" : "cvTipoBadgeOut"}">${entrada ? "↓ Entrada" : "↑ Salida"}</span>
        </td>
        <td data-field="par" data-value="${escapeHtml(row.par)}" title="${escapeHtml(row.par)}">${
            contraparteSimbolo
                ? `<span class="cvParTexto">${escapeHtml(vende)}${escapeHtml(compra)}</span>
                   <span class="mTypeBadge cvParContraparte" style="background:${color}22;color:${color};border-color:${color}44">${escapeHtml(contraparte?.name || contraparteSimbolo)}</span>`
                : "—"
        }</td>
        ${entrada ? celdaContraparte : celdaPropia}
        ${entrada ? celdaPropia : celdaContraparte}
        <td class="cvPrecio">${precio}</td>
        <td class="cvPrecioInverso">${precioInverso}</td>
        <td data-field="comision" data-value="${escapeHtml(row.comision || "")}" data-moneda="${escapeHtml(row.comisionMoneda || "")}" class="cvComision">${
            parseLooseNumber(row.comision || "")
                ? `${formatConversionQuantity(row.comision)} <span class="cvSimbolo">${escapeHtml(row.comisionMoneda || "")}</span>`
                : "—"
        }</td>
        <td data-field="valorEur" data-value="${escapeHtml(valorEur)}" class="cvValorEur">${
            valorEur
                ? formatMoney(parseLooseNumber(valorEur) || 0, "EUR")
                : `<span class="cvSinValor" title="${escapeHtml(CV_AYUDA_VALOR)}">Falta valor</span>`
        }</td>
        <td class="cvValorHoy">${valorHoy}</td>
        <td class="rowActionsCell">
            <div class="rowMenu">
                <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                <div class="rowMenuDropdown">
                    <button type="button" class="rowMenuItem assetRowEditBtn conversionRowEditBtn avActionBtn avEditBtn" data-row-id="${escapeHtml(rowElement.dataset.rowId)}">Editar</button>
                    <hr>
                    <button type="button" class="rowMenuItem rowMenuItemDanger assetRowDeleteBtn conversionRowDeleteBtn avActionBtn avDeleteBtn" data-row-id="${escapeHtml(rowElement.dataset.rowId)}">Eliminar</button>
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
    const fmt = (n) => `${formatConversionQuantity(n)} ${baseSymbol}`

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
    refrescarConversionesSinValor()
}

function collectConversionesRows() {
    return [...document.querySelectorAll("#conversionesBody tr")]
        .map((rowElement) => ({
            id: rowElement.dataset.rowId || createConversionRowId(),
            fecha: rowElement.querySelector('[data-field="fecha"]')?.textContent.trim() || "",
            par: rowElement.querySelector('[data-field="par"]')?.dataset.value?.trim() || "",
            tipo:
                rowElement.querySelector('[data-field="tipo"]')?.dataset.value ||
                getConvertedInOperationLabel(deriveAssetBaseSymbolFromData(conversionesCurrentAsset || {})),
            // La celda muestra signo y símbolo; la cantidad tal cual va en data-value.
            cantidad: rowElement.querySelector('[data-field="cantidad"]')?.dataset.value?.trim() || "",
            cantidadContraparte:
                rowElement.querySelector('[data-field="cantidadContraparte"]')?.dataset.value?.trim() || "",
            comision: rowElement.querySelector('[data-field="comision"]')?.dataset.value?.trim() || "",
            comisionMoneda: rowElement.querySelector('[data-field="comision"]')?.dataset.moneda?.trim() || "",
            valorEur: rowElement.querySelector('[data-field="valorEur"]')?.dataset.value?.trim() || ""
        }))
        .filter((row) => {
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
    const rowData = isEdit
        ? {
              fecha: rowElement.querySelector('[data-field="fecha"]')?.textContent.trim() || "",
              par: rowElement.querySelector('[data-field="par"]')?.dataset.value?.trim() || "",
              tipo: rowElement.querySelector('[data-field="tipo"]')?.dataset.value || "",
              cantidad: rowElement.querySelector('[data-field="cantidad"]')?.dataset.value || "",
              cantidadContraparte:
                  rowElement.querySelector('[data-field="cantidadContraparte"]')?.dataset.value || "",
              comision: rowElement.querySelector('[data-field="comision"]')?.dataset.value || "",
              comisionMoneda: rowElement.querySelector('[data-field="comision"]')?.dataset.moneda || "",
              valorEur: rowElement.querySelector('[data-field="valorEur"]')?.dataset.value || ""
          }
        : {
              fecha: "",
              par: "",
              tipo: "",
              cantidad: "",
              cantidadContraparte: "",
              comision: "",
              comisionMoneda: "",
              valorEur: ""
          }

    const baseSymbol = deriveAssetBaseSymbolFromData(asset)
    const convertedInLabel = getConvertedInOperationLabel(baseSymbol)
    const convertedOutLabel = getConvertedOutOperationLabel(baseSymbol)
    const tipoNorm = String(rowData.tipo || "")
        .trim()
        .toLowerCase()
    const selectedTipo = tipoNorm === convertedOutLabel.toLowerCase() ? convertedOutLabel : convertedInLabel

    // Una conversión cambia unas criptos de la cartera por otras, así que la
    // contraparte solo puede ser otra cripto de Activos. Si una fila antigua
    // trae una que ya no está, se conserva como opción para no perderla.
    const contraparteActual = String(rowData.par || "").split("/")[1] || ""
    const contrapartes = conversionesCryptoAssets
        .filter((otro) => getConversionAssetSymbol(otro) !== baseSymbol)
        .map((otro) => ({ simbolo: getConversionAssetSymbol(otro), nombre: otro.name || getConversionAssetSymbol(otro) }))
    if (contraparteActual && !contrapartes.some((c) => c.simbolo === contraparteActual.toUpperCase())) {
        contrapartes.unshift({ simbolo: contraparteActual, nombre: contraparteActual })
    }
    const contraparteOptions = contrapartes
        .map(
            (c) =>
                `<option value="${escapeHtml(c.simbolo)}"${c.simbolo.toUpperCase() === contraparteActual.toUpperCase() ? " selected" : ""}>${escapeHtml(c.nombre)} (${escapeHtml(c.simbolo)})</option>`
        )
        .join("")

    const fieldsHtml = `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Fecha</label>
            <input id="cvModalFecha" class="assetRowModalInput" type="text" value="${escapeHtml(rowData.fecha)}" placeholder="dd-mm-aaaa">
        </div>
        <input type="hidden" id="cvModalTipo" value="${escapeHtml(selectedTipo)}">
        <div class="cvSwap">
            <div class="cvSwapFila" id="cvSwapVendes">
                <span class="cvSwapEtiqueta">Vendes</span>
            </div>
            <button type="button" class="cvSwapInvertir" id="cvSwapInvertir" title="Invertir: vender lo que compras">⇅</button>
            <div class="cvSwapFila" id="cvSwapCompras">
                <span class="cvSwapEtiqueta">Compras</span>
            </div>
        </div>
        <div class="cvSwapComision">
            <span class="cvSwapEtiqueta">Comisión <em>(opcional)</em></span>
            <div class="cvSwapLinea">
                <input id="cvModalComision" class="cvSwapCantidad cvSwapCantidadPeque" type="text" inputmode="decimal" value="${escapeHtml(rowData.comision)}" placeholder="0,00">
                <select id="cvModalComisionMoneda" class="assetRowModalSelect cvSwapSelect"></select>
            </div>
        </div>
        <div class="cvSwapComision">
            <span class="cvSwapEtiqueta">Valor en euros de ${escapeHtml(baseSymbol)} <em>(opcional)</em></span>
            <div class="cvSwapLinea">
                <input id="cvModalValorEur" class="cvSwapCantidad cvSwapCantidadPeque" type="text" inputmode="decimal" value="${escapeHtml(rowData.valorEur)}" placeholder="0,00">
                <span class="cvSwapMoneda">EUR</span>
            </div>
            <small class="cvAyuda">${escapeHtml(CV_AYUDA_VALOR)}</small>
            <small class="cvError hidden" id="cvModalValorEurError" role="alert">Escribe un importe válido en euros, sin negativos.</small>
        </div>
        <div class="cvSwapResumen" id="cvModalPrecioPrevio"></div>
    `

    // Los dos lados del intercambio son siempre los mismos nodos (la cripto de
    // la ficha y la contraparte); invertir solo los cambia de fila, así no se
    // pierde lo escrito ni el desplegable ya montado.
    const ladoPropio = document.createElement("div")
    ladoPropio.className = "cvSwapLinea"
    ladoPropio.innerHTML = `
        <input id="cvModalCantidad" class="cvSwapCantidad" type="text" inputmode="decimal" value="${escapeHtml(rowData.cantidad)}" placeholder="0,00">
        <span class="cvSwapMoneda">${escapeHtml(baseSymbol)}</span>
    `
    const ladoContraparte = document.createElement("div")
    ladoContraparte.className = "cvSwapLinea"
    ladoContraparte.innerHTML = `
        <input id="cvModalCantidadContraparte" class="cvSwapCantidad" type="text" inputmode="decimal" value="${escapeHtml(rowData.cantidadContraparte)}" placeholder="0,00">
        <select id="cvModalContraparte" class="assetRowModalSelect cvSwapSelect">
            ${contraparteOptions || `<option value="">Sin otras criptos en Activos</option>`}
        </select>
    `

    const overlay = document.createElement("div")
    overlay.id = "conversionRowModalOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"
    overlay.dataset.rowId = rowId || ""

    const modal = document.createElement("div")
    modal.className = "assetModal assetRowModal cvModal"

    const titleEl = document.createElement("h3")
    titleEl.className = "assetModalTitle assetRowModalTitle"
    titleEl.textContent = isEdit ? "Editar conversión" : "Añadir conversión"

    const fields = document.createElement("div")
    fields.className = "assetRowModalFields"
    fields.innerHTML = fieldsHtml

    // Entrada: se vende la contraparte y se compra la cripto de la ficha.
    // Salida: al revés.
    let entrada = selectedTipo === convertedInLabel
    const colocarLados = () => {
        fields.querySelector("#cvSwapVendes").appendChild(entrada ? ladoContraparte : ladoPropio)
        fields.querySelector("#cvSwapCompras").appendChild(entrada ? ladoPropio : ladoContraparte)
        fields.querySelector("#cvModalTipo").value = entrada ? convertedInLabel : convertedOutLabel
    }
    colocarLados()

    const footer = document.createElement("div")
    footer.className = "assetRowModalFooter"
    footer.innerHTML = `
        ${isEdit ? `<button type="button" id="cvRowModalDeleteBtn" class="dangerButton assetRowModalDeleteBtn">Eliminar</button>` : ""}
        <button type="button" id="cvRowModalCancelBtn" class="cancelButton">Cancelar</button>
        <button type="button" id="cvRowModalSaveBtn" class="primaryButton" data-no-autohide="true">Guardar</button>
    `

    // Resumen bajo el intercambio, como en los extractos de los exchanges: par,
    // precio y precio inverso con lo que se lleva escrito.
    const actualizarPrecioPrevio = () => {
        const destino = fields.querySelector("#cvModalPrecioPrevio")
        const contra = fields.querySelector("#cvModalContraparte")?.value || ""
        const propia = parseLooseNumber(fields.querySelector("#cvModalCantidad")?.value || "") || 0
        const otra = parseLooseNumber(fields.querySelector("#cvModalCantidadContraparte")?.value || "") || 0
        if (!destino) return
        const [vende, compra] = entrada ? [contra, baseSymbol] : [baseSymbol, contra]
        const [cantVende, cantCompra] = entrada ? [otra, propia] : [propia, otra]
        const fila = (etiqueta, valor) =>
            `<div class="cvSwapResumenFila"><span>${etiqueta}</span><strong>${valor}</strong></div>`
        destino.innerHTML =
            fila("Par", contra ? `${escapeHtml(vende)}${escapeHtml(compra)}` : "—") +
            fila(
                "Precio",
                cantVende > 0 && cantCompra > 0
                    ? `1 ${escapeHtml(vende)} = ${formatConversionRate(cantCompra / cantVende)} ${escapeHtml(compra)}`
                    : "—"
            ) +
            fila(
                "Precio inverso",
                cantVende > 0 && cantCompra > 0
                    ? `1 ${escapeHtml(compra)} = ${formatConversionRate(cantVende / cantCompra)} ${escapeHtml(vende)}`
                    : "—"
            )
    }

    // La comisión se cobra en una de las dos criptos del par o en la moneda del
    // usuario. Mientras no se elija a mano, se propone la cripto que se vende,
    // que es como la cobran los exchanges, y sigue a la contraparte y al ⇅. Al
    // editar se respeta la guardada.
    const monedaBase = normalizeCurrencyCode(window._monedaBase || "EUR")
    let comisionMonedaElegida = String(rowData.comisionMoneda || "").toUpperCase()
    let comisionMonedaManual = Boolean(comisionMonedaElegida)
    const actualizarMonedasComision = () => {
        const select = fields.querySelector("#cvModalComisionMoneda")
        if (!select) return
        const contra = fields.querySelector("#cvModalContraparte")?.value || ""
        const [vende, compra] = entrada ? [contra, baseSymbol] : [baseSymbol, contra]
        const opciones = [...new Set([vende, compra, monedaBase].filter(Boolean))]
        if (comisionMonedaElegida && !opciones.includes(comisionMonedaElegida)) opciones.push(comisionMonedaElegida)
        const elegida =
            comisionMonedaManual && opciones.includes(comisionMonedaElegida) ? comisionMonedaElegida : opciones[0]
        select.innerHTML = opciones
            .map((m) => `<option value="${escapeHtml(m)}"${m === elegida ? " selected" : ""}>${escapeHtml(m)}</option>`)
            .join("")
        comisionMonedaElegida = elegida
    }
    actualizarMonedasComision()
    fields.querySelector("#cvModalComisionMoneda")?.addEventListener("change", (event) => {
        comisionMonedaElegida = event.target.value
        comisionMonedaManual = true
    })

    fields.querySelector("#cvSwapInvertir").addEventListener("click", () => {
        entrada = !entrada
        colocarLados()
        actualizarMonedasComision()
        actualizarPrecioPrevio()
    })
    fields.querySelector("#cvModalContraparte")?.addEventListener("change", () => {
        actualizarMonedasComision()
        actualizarPrecioPrevio()
    })
    fields.querySelector("#cvModalCantidad")?.addEventListener("input", actualizarPrecioPrevio)
    fields.querySelector("#cvModalCantidadContraparte")?.addEventListener("input", actualizarPrecioPrevio)
    actualizarPrecioPrevio()

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
    const body = document.getElementById("conversionesBody")

    if (!body || !conversionesCurrentAsset) {
        closeConversiónRowModal()
        return
    }

    const valorEur = parseConversionValorEur(g("cvModalValorEur"))
    const errorValor = document.getElementById("cvModalValorEurError")
    errorValor?.classList.toggle("hidden", valorEur.ok)
    if (!valorEur.ok) {
        document.getElementById("cvModalValorEur")?.focus()
        return
    }

    const contraparte = g("cvModalContraparte")
    const nuevaFila = buildConversionesRowElement(
        {
            id: rowId || createConversionRowId(),
            fecha: g("cvModalFecha"),
            par: contraparte ? `${getConversionAssetSymbol(conversionesCurrentAsset)}/${contraparte}` : "",
            tipo: g("cvModalTipo"),
            cantidad: g("cvModalCantidad"),
            cantidadContraparte: g("cvModalCantidadContraparte"),
            comision: g("cvModalComision"),
            comisionMoneda: parseLooseNumber(g("cvModalComision")) ? g("cvModalComisionMoneda") : "",
            valorEur: valorEur.valor
        },
        conversionesCurrentAsset
    )

    const rowElement = body.querySelector(`tr[data-row-id="${rowId}"]`)
    if (rowElement) {
        rowElement.replaceWith(nuevaFila)
    } else {
        body.appendChild(nuevaFila)
    }

    document.getElementById("conversionesTableWrapper")?.classList.remove("hidden")
    document.getElementById("conversionesEmptyMsg")?.classList.add("hidden")
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
        operationRows: Array.isArray(conversionesCurrentAsset.operationRows)
            ? conversionesCurrentAsset.operationRows
            : [],
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
