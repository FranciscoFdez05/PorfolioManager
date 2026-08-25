// Esta página ya no calcula nada fiscal. El coste FIFO, la ganancia, los
// tramos y la cuota los devuelve el servidor (`/api/ventas`), que es quien
// tiene el histórico completo de todos los ejercicios. Antes se calculaban
// aquí con los datos del año abierto en pantalla, y eso hacía imposible un
// FIFO correcto: los lotes ya consumidos por ventas de otros años volvían a
// estar disponibles. Lo único que se manda al guardar son los datos de hecho
// de cada venta.

let currentVentasData = { rows: [], resumen: null, incidencias: [] }
let ventasPersistenceBound = false
let ventasAssets = []
let ventasYears = []
let currentVentasYear = null
let ventasModalKeyHandler = null

function escapeVentasHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

async function loadVentasIndex() {
    const response = await fetch("/api/ventas")

    if (!response.ok) {
        throw new Error("No se pudieron cargar las ventas")
    }

    return await response.json()
}

async function loadVentasYear(year) {
    const response = await fetch(`/api/ventas/${year}`)

    if (!response.ok) {
        throw new Error("No se pudo cargar el año de ventas")
    }

    return await response.json()
}

async function createVentasYear(year) {
    const response = await fetch("/api/ventas", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ year })
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

// El servidor rechaza con 400 y un `details` por fila cuando hay datos que no
// puede colocar en la línea temporal (fecha ilegible, cantidad cero, activo
// borrado). Se convierte en un Error con el detalle legible para poder
// enseñarlo en el modal en vez de un "no se pudo guardar" a secas.
async function saveVentasData(year, payload, options = {}) {
    const response = await fetch(`/api/ventas/${year}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        keepalive: Boolean(options.keepalive)
    })

    const data = await response.json().catch(() => null)

    if (!response.ok) {
        const detalle = Array.isArray(data?.details)
            ? data.details.map((item) => `Fila ${item.fila}: ${item.mensaje}`).join("\n")
            : ""
        const error = new Error(data?.error || `HTTP ${response.status}`)
        error.detalle = detalle
        throw error
    }

    return data
}

async function deleteVentasYearRequest(year) {
    const response = await fetch(`/api/ventas/${year}`, {
        method: "DELETE"
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

// Solo hacen falta el id y el nombre de cada activo, para el desplegable. La
// versión anterior descargaba además la ficha completa de todos los activos
// (una petición por activo) para reconstruir los lotes en el navegador.
async function loadVentasAssets() {
    const response = await fetch("/api/activos")

    if (!response.ok) {
        throw new Error("No se pudieron cargar los activos")
    }

    const payload = await response.json()
    ventasAssets = Array.isArray(payload?.assets) ? payload.assets : []
}

async function initVentasLogic() {
    const [ventasIndex] = await Promise.all([loadVentasIndex(), loadVentasAssets()])

    ventasYears = Array.isArray(ventasIndex?.years) ? ventasIndex.years : []
    currentVentasYear = ventasYears[0] || "2026"
    applyVentasPayload(await loadVentasYear(currentVentasYear))

    bindVentasPersistenceGuards()
    window.flushPendingPageChanges = flushVentasPendingChanges
    renderVentasYearButtons()
    renderVentasTable()
    bindVentasEvents()

    const ventasTable = document.getElementById("ventasBody")?.closest("table")
    if (ventasTable) bindTableSort(ventasTable, "ventas")
}

function applyVentasPayload(payload) {
    currentVentasYear = payload?.year || currentVentasYear
    currentVentasData = {
        year: currentVentasYear,
        rows: Array.isArray(payload?.rows) ? payload.rows.map(normalizeVentaRow) : [],
        resumen: payload?.resumen || null,
        incidencias: Array.isArray(payload?.incidencias) ? payload.incidencias : []
    }
}

function bindVentasEvents() {
    const ventasBody = document.getElementById("ventasBody")
    const addYearButton = document.getElementById("addVentasYearBtn")
    const deleteYearButton = document.getElementById("deleteVentasYearBtn")
    const addButton = document.getElementById("addVentaRowBtn")
    const saveButton = document.getElementById("saveVentasBtn")
    if (ventasBody && !ventasBody.dataset.bound) {
        ventasBody.dataset.bound = "true"
        ventasBody.addEventListener("click", handleVentasActionClick)
    }

    if (addYearButton && !addYearButton.dataset.bound) {
        addYearButton.dataset.bound = "true"
        addYearButton.addEventListener("click", async () => {
            const suggestedYear = String(new Date().getFullYear())
            const year = prompt("Escribe el nuevo año (YYYY)", suggestedYear)?.trim()

            if (!year) {
                return
            }

            try {
                await persistVentasData()
                await createVentasYear(year)
                ventasYears = (await loadVentasIndex()).years || []
                await renderVentasYear(year)
            } catch (error) {
                console.error(error)
                alert("No se pudo crear el año.")
            }
        })
    }

    if (deleteYearButton && !deleteYearButton.dataset.bound) {
        deleteYearButton.dataset.bound = "true"
        deleteYearButton.addEventListener("click", () => {
            openConfirmModal({
                title: "Eliminar año",
                message: `Vas a eliminar el año ${currentVentasYear}. ¿Quieres continuar?`,
                confirmLabel: "Eliminar",
                confirmSide: "right",
                onConfirm: async () => {
                    openConfirmModal({
                        title: "Segunda verificación",
                        message: `Esta acción borrará definitivamente el año ${currentVentasYear}. Las ventas de ese ejercicio dejarán de consumir lotes, así que el coste FIFO de los años siguientes se recalculará. ¿Confirmas?`,
                        confirmLabel: "Eliminar",
                        confirmSide: "left",
                        onConfirm: async () => {
                            const response = await deleteVentasYearRequest(currentVentasYear)
                            ventasYears = Array.isArray(response.years)
                                ? response.years
                                : (await loadVentasIndex()).years || []
                            await renderVentasYear(ventasYears[0] || "2026")
                        }
                    })
                }
            })
        })
    }

    if (addButton && !addButton.dataset.bound) {
        addButton.dataset.bound = "true"
        addButton.addEventListener("click", () => {
            openVentasModal(-1)
        })
    }

    if (saveButton && !saveButton.dataset.bound) {
        saveButton.dataset.bound = "true"
        saveButton.addEventListener("click", async () => {
            try {
                await persistVentasData()
                alert(`Ventas de ${currentVentasYear} guardadas.`)
            } catch (error) {
                console.error(error)
                alert(error.detalle || "No se pudieron guardar las ventas.")
            }
        })
    }
}

function closeVentasModal() {
    document.getElementById("ventasModalOverlay")?.remove()

    if (ventasModalKeyHandler) {
        document.removeEventListener("keydown", ventasModalKeyHandler)
        ventasModalKeyHandler = null
    }
}

function buildVentasAssetOptions(selectedAssetId) {
    const selectedId = String(selectedAssetId || "")
    const hasSelectedAsset = ventasAssets.some((asset) => asset.id === selectedId)
    const currentLabel = selectedId && !hasSelectedAsset ? getVentasAssetName(selectedId) || selectedId : ""

    return `
        <option value="">Selecciona activo</option>
        ${currentLabel ? `<option value="${escapeVentasHtml(selectedId)}" selected>${escapeVentasHtml(currentLabel)}</option>` : ""}
        ${ventasAssets.map((asset) => `<option value="${escapeVentasHtml(asset.id)}"${asset.id === selectedId ? " selected" : ""}>${escapeVentasHtml(asset.name)}</option>`).join("")}
    `
}

function openVentasModal(rowIndex = -1) {
    closeVentasModal()

    const rows = currentVentasData.rows || []
    const isEdit = rowIndex >= 0
    const rowData = isEdit ? { ...rows[rowIndex] } : createEmptyVentaRow()

    const overlay = document.createElement("div")
    overlay.id = "ventasModalOverlay"
    overlay.className = "modalOverlay"

    const modal = document.createElement("div")
    modal.className = "assetModal ventasCreateModal"
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.innerHTML = `
        <h3 class="assetModalTitle">${isEdit ? "Editar venta" : "Añadir venta"}</h3>
        <label class="assetModalLabel" for="ventaFechaInput">Fecha venta</label>
        <input id="ventaFechaInput" class="assetModalInput" type="text" value="${escapeVentasHtml(rowData.fecha || "")}" placeholder="dd-mm-aaaa">
        <label class="assetModalLabel" for="ventaActivoInput">Activo</label>
        <select id="ventaActivoInput" class="assetModalSelect">
            ${buildVentasAssetOptions(rowData.assetId || "")}
        </select>
        <label class="assetModalLabel" for="ventaCantidadInput">Cantidad</label>
        <input id="ventaCantidadInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeVentasHtml(formatVentasNumber(rowData.cantidad) || "")}" placeholder="0">
        <label class="assetModalLabel" for="ventaValorInput">Valor de venta (por unidad)</label>
        <input id="ventaValorInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeVentasHtml(formatVentasMoney(rowData.valorVenta) || "")}" placeholder="0,00">
        <label class="assetModalLabel" for="ventaComisionInput">Comisión de la venta</label>
        <input id="ventaComisionInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeVentasHtml(formatVentasMoney(rowData.comisionVenta) || "")}" placeholder="0,00">
        <p class="assetModalHint">Los gastos de la venta minoran el valor de transmisión (art. 35.2 LIRPF).</p>
        <p class="gastosCreateModalFeedback hidden" id="ventasModalFeedback"></p>
        <div class="assetModalActions ventasModalActions">
            <button type="button" class="cancelButton" id="ventasModalCancelBtn">Cancelar</button>
            <button type="button" class="primaryButton" id="ventasModalSaveBtn" data-no-autohide="true">Guardar</button>
        </div>
    `

    initSearchableSelect(modal.querySelector("#ventaActivoInput"))

    const setFeedback = (message = "", isError = false) => {
        const node = modal.querySelector("#ventasModalFeedback")
        if (!node) return
        node.textContent = message
        node.classList.toggle("hidden", !message)
        node.classList.toggle("error", Boolean(message && isError))
    }

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            // closeVentasModal() // Deshabilitado para evitar cierre accidental
        }
    })

    modal.querySelector("#ventasModalCancelBtn")?.addEventListener("click", closeVentasModal)
    modal.querySelector("#ventasModalSaveBtn")?.addEventListener("click", async () => {
        const fecha = modal.querySelector("#ventaFechaInput")?.value.trim() || ""
        const assetId = modal.querySelector("#ventaActivoInput")?.value.trim() || ""
        const cantidadRaw = modal.querySelector("#ventaCantidadInput")?.value.trim() || ""
        const valorVentaRaw = modal.querySelector("#ventaValorInput")?.value.trim() || ""
        const comisionRaw = modal.querySelector("#ventaComisionInput")?.value.trim() || ""
        const cantidad = cantidadRaw ? formatVentasNumber(cantidadRaw) : ""
        const valorVenta = valorVentaRaw ? stripCurrencyText(formatVentasMoney(valorVentaRaw)) : ""
        const comisionVenta = comisionRaw ? stripCurrencyText(formatVentasMoney(comisionRaw)) : ""

        // El servidor valida de verdad; aquí solo se evita el viaje inútil.
        if (!fecha || !assetId || !cantidad || !valorVenta) {
            setFeedback("Fecha, activo, cantidad y valor de venta son obligatorios.", true)
            return
        }

        const nextRow = normalizeVentaRow({
            id: rowData.id,
            fecha,
            assetId,
            activo: getVentasAssetName(assetId),
            cantidad,
            valorVenta,
            comisionVenta
        })

        const previas = currentVentasData.rows.map((row) => ({ ...row }))

        if (isEdit) {
            currentVentasData.rows[rowIndex] = nextRow
        } else {
            currentVentasData.rows.push(nextRow)
        }

        try {
            await persistVentasData()
            renderVentasTable()
            closeVentasModal()
        } catch (error) {
            console.error(error)
            // El guardado se rechazó entero, así que la fila tampoco puede
            // quedarse en pantalla: se deshace el cambio local.
            currentVentasData.rows = previas
            setFeedback(error.detalle || error.message || "No se pudo guardar.", true)
        }
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    ventasModalKeyHandler = (event) => {
        if (event.key === "Escape") closeVentasModal()
    }
    document.addEventListener("keydown", ventasModalKeyHandler)

    modal.querySelector("input, select")?.focus()
}

async function renderVentasYear(year) {
    applyVentasPayload(await loadVentasYear(year))
    renderVentasYearButtons()
    renderVentasTable()
}

function renderVentasYearButtons() {
    const list = document.getElementById("ventasYearList")

    if (!list) {
        return
    }

    list.innerHTML = ""

    ventasYears.forEach((year) => {
        const button = document.createElement("button")
        button.type = "button"
        button.className = `gastosYearBtn${year === currentVentasYear ? " active" : ""}`
        button.textContent = year
        button.addEventListener("click", async () => {
            try {
                // El guardado puede rechazarse si alguna fila del año actual
                // tiene datos imposibles; cambiar de año entonces las perdería.
                await persistVentasData()
            } catch (error) {
                console.error(error)
                alert(error.detalle || "No se pudo guardar el año actual, así que no se cambia de ejercicio.")
                return
            }
            await renderVentasYear(year)
        })
        list.appendChild(button)
    })
}

function createEmptyVentaRow() {
    return normalizeVentaRow({
        id: `venta-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        fecha: "",
        assetId: "",
        activo: "",
        cantidad: "",
        valorVenta: "",
        comisionVenta: ""
    })
}

// Conserva los campos calculados que vengan del servidor, pero nunca los
// inventa: si no están, la fila se pinta vacía hasta el siguiente guardado.
function normalizeVentaRow(row = {}) {
    const assetId = String(row.assetId || getVentasAssetIdByName(row.activo) || "")
    const activo = String(row.activo || getVentasAssetName(assetId) || "")

    return {
        ...row,
        id: String(row.id || `venta-${Date.now()}`),
        fecha: String(row.fecha || ""),
        assetId,
        activo,
        cantidad: String(row.cantidad || ""),
        valorVenta: String(row.valorVenta || ""),
        comisionVenta: String(row.comisionVenta || "")
    }
}

function getVentasAssetIdByName(assetName) {
    const normalizedName = String(assetName || "")
        .trim()
        .toLowerCase()
    const asset = ventasAssets.find(
        (item) =>
            item.name.trim().toLowerCase() === normalizedName || item.symbol.trim().toLowerCase() === normalizedName
    )
    return asset?.id || ""
}

function getVentasAssetName(assetId) {
    const asset = ventasAssets.find((item) => item.id === assetId)
    return asset?.name || ""
}

function renderVentasTable() {
    const ventasBody = document.getElementById("ventasBody")

    if (!ventasBody) {
        return
    }

    ventasBody.innerHTML = ""

    const rows = currentVentasData.rows || []

    const ventasEmptyEl = document.getElementById("ventasEmptyMsg")
    const ventasTableWrapper = document.getElementById("ventasTableWrapper")
    if (!rows.length) {
        if (ventasEmptyEl) ventasEmptyEl.classList.remove("hidden")
        if (ventasTableWrapper) ventasTableWrapper.classList.add("hidden")
        renderVentasResumen()
        return
    }
    if (ventasEmptyEl) ventasEmptyEl.classList.add("hidden")
    if (ventasTableWrapper) ventasTableWrapper.classList.remove("hidden")

    rows.forEach((row, index) => {
        ventasBody.appendChild(buildVentaRow(row, index))
    })

    renderVentasResumen()
}

// El resumen es la cifra que de verdad se declara: la escala del ahorro es
// anual y progresiva, así que la suma de las columnas de una fila sola no
// significa nada por sí misma.
function renderVentasResumen() {
    const contenedor = document.getElementById("ventasResumen")

    if (!contenedor) {
        return
    }

    const resumen = currentVentasData.resumen

    if (!resumen) {
        contenedor.innerHTML = ""
        contenedor.classList.add("hidden")
        return
    }

    contenedor.classList.remove("hidden")

    const dato = (etiqueta, valor, titulo = "") => `
        <div class="ventasResumenItem"${titulo ? ` title="${escapeVentasHtml(titulo)}"` : ""}>
            <span class="ventasResumenLabel">${escapeVentasHtml(etiqueta)}</span>
            <span class="ventasResumenValor">${formatVentasMoney(valor) || "- €"}</span>
        </div>
    `

    const opcionales = []

    if (parseLooseNumber(resumen.compensadoAnteriores)) {
        opcionales.push(
            dato(
                "Compensado de años anteriores",
                resumen.compensadoAnteriores,
                "Saldo negativo de ejercicios previos aplicado a la base de este año (art. 49.1.b LIRPF)."
            )
        )
    }
    if (parseLooseNumber(resumen.pendienteCompensar)) {
        opcionales.push(
            dato(
                "Pendiente de compensar",
                resumen.pendienteCompensar,
                "Saldo negativo que queda vivo para los próximos ejercicios (máximo cuatro)."
            )
        )
    }
    if (parseLooseNumber(resumen.perdidasNoComputables)) {
        opcionales.push(
            dato(
                "Pérdidas bloqueadas por recompra",
                resumen.perdidasNoComputables,
                "Minusvalías no computables este año por la regla de antiaplicación (art. 33.5 LIRPF). Se imputarán al transmitir los valores recomprados."
            )
        )
    }

    // Desglose de los saldos negativos que se arrastran. El total ya salía
    // arriba, pero para declarar hace falta saber de qué ejercicio viene cada
    // trozo: cada uno caduca por su cuenta a los cuatro años.
    const arrastres = Array.isArray(resumen.arrastres) ? resumen.arrastres : []
    const bloqueArrastres = arrastres.length
        ? `
        <div class="ventasArrastres">
            <span class="ventasArrastresTitulo">Saldos negativos pendientes por ejercicio</span>
            <ul class="ventasArrastresLista">
                ${arrastres
                    .map(
                        (a) => `<li>
                            <span>${escapeVentasHtml(a.anioOrigen)}</span>
                            <span>${formatVentasMoney(a.importe) || "- €"}</span>
                            <span class="ventasArrastreCaduca">aplicable hasta ${escapeVentasHtml(a.ultimoEjercicio)}</span>
                        </li>`
                    )
                    .join("")}
            </ul>
        </div>
    `
        : ""

    contenedor.innerHTML = `
        <h4 class="ventasResumenTitulo">Ejercicio ${escapeVentasHtml(resumen.year)} · base del ahorro</h4>
        <div class="ventasResumenGrid">
            ${dato("Ganancias", resumen.ganancias)}
            ${dato("Pérdidas", resumen.perdidas)}
            ${dato("Saldo", resumen.saldo)}
            ${dato("Base gravada", resumen.base)}
            ${dato("Cuota", resumen.cuota)}
            ${opcionales.join("")}
        </div>
        ${bloqueArrastres}
        <div class="ventasResumenAcciones">
            <a class="ventasInformeBtn" href="/api/ventas/${encodeURIComponent(resumen.year)}/informe.csv"
               download>Descargar CSV</a>
            <a class="ventasInformeBtn" href="/api/ventas/${encodeURIComponent(resumen.year)}/informe.html"
               target="_blank" rel="noopener">Informe imprimible</a>
        </div>
        <p class="ventasResumenNota">
            Cálculo por FIFO sobre el histórico completo. No contempla la compensación
            con rendimientos del capital mobiliario, la exención por reinversión ni los
            coeficientes de abatimiento anteriores a 1994.
        </p>
    `
}

function buildVentaRow(row, index) {
    const tr = document.createElement("tr")
    // Único dato que hace falta en el DOM: el id, para poder recuperar el
    // orden después de que el usuario ordene por una columna.
    tr.dataset.ventaId = row.id

    if (row.incidencia) {
        tr.classList.add("ventasRowIncidencia")
        tr.title = row.mensaje || ""
    }

    const avisos = []
    if (row.notaAntiaplicacion) avisos.push(row.notaAntiaplicacion)
    if (parseLooseNumber(row.perdidaDiferidaLiberada)) {
        avisos.push(
            `Incluye ${formatVentasMoney(row.perdidaDiferidaLiberada)} de pérdida aplazada que se imputa en esta venta.`
        )
    }

    tr.innerHTML = `
        <td data-field="fecha">${escapeVentasHtml(row.fecha || "")}${row.incidencia ? ' <span class="ventasIncidenciaMarca" title="Revisa esta fila">!</span>' : ""}</td>
        <td data-field="assetName">${escapeVentasHtml(getVentasAssetName(row.assetId) || row.activo || "")}</td>
        <td data-field="cantidad">${formatVentasNumber(row.cantidad)}</td>
        <td class="rowTotal" data-field="valorCompra" title="${escapeVentasHtml(describirLotes(row.lotes))}">${formatVentasMoney(row.valorCompra)}</td>
        <td data-field="valorVenta">${formatVentasMoney(row.valorVenta)}</td>
        <td data-field="comisionVenta">${formatVentasMoney(row.comisionVenta)}</td>
        <td class="rowTotal" data-field="dineroDeclarar"${avisos.length ? ` title="${escapeVentasHtml(avisos.join(" "))}"` : ""}>${formatVentasTaxColumn(row.dineroDeclarar)}${avisos.length ? " *" : ""}</td>
        <td class="rowTotal" data-field="tramo1">${formatVentasTaxColumn(row.tramo1)}</td>
        <td class="rowTotal" data-field="tramo2">${formatVentasTaxColumn(row.tramo2)}</td>
        <td class="rowTotal" data-field="tramo3">${formatVentasTaxColumn(row.tramo3)}</td>
        <td class="rowTotal" data-field="tramo4">${formatVentasTaxColumn(row.tramo4)}</td>
        <td class="rowTotal" data-field="tramo5">${formatVentasTaxColumn(row.tramo5)}</td>
        <td class="rowTotal" data-field="totalPagar">${formatVentasTaxColumn(row.totalPagar)}</td>
        <td class="rowTotal" data-field="bruto">${formatVentasMoney(row.bruto)}</td>
        <td class="rowTotal" data-field="neto">${formatVentasMoney(row.neto)}</td>
        <td class="rowActionsCell">
            <div class="rowMenu">
                <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                <div class="rowMenuDropdown">
                    <button type="button" class="rowMenuItem assetRowEditBtn ventasRowEditBtn avActionBtn avEditBtn" data-row-index="${index}">Editar</button>
                    <hr>
                    <button type="button" class="rowMenuItem rowMenuItemDanger assetRowDeleteBtn ventasRowDeleteBtn avActionBtn avDeleteBtn" data-row-index="${index}">Eliminar</button>
                </div>
            </div>
        </td>
    `
    return tr
}

// La traza de lotes es lo que hace defendible el FIFO ante una comprobación:
// de qué compras concretas salió el coste de esta venta.
function describirLotes(lotes) {
    if (!Array.isArray(lotes) || !lotes.length) {
        return ""
    }

    return (
        "Lotes consumidos (FIFO):\n" +
        lotes
            .map(
                (lote) =>
                    `${formatVentasNumber(lote.cantidad)} ud. de la compra de ${lote.fecha} a ${formatVentasMoney(lote.costeUnitario)} = ${formatVentasMoney(lote.coste)}`
            )
            .join("\n")
    )
}

function formatVentasNumber(value) {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null || String(value || "").trim() === "") {
        return ""
    }

    return parsedValue.toLocaleString("es-ES", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 8
    })
}

function formatVentasMoney(value) {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null || String(value || "").trim() === "") {
        return ""
    }

    return formatMoney(parsedValue, "EUR")
}

function formatVentasTaxColumn(value) {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null) {
        return ""
    }

    if (parsedValue === 0) {
        return "- €"
    }

    return formatMoney(parsedValue, "EUR")
}

function handleVentasActionClick(event) {
    const editButton = event.target.closest(".ventasRowEditBtn")
    if (editButton) {
        openVentasModal(Number(editButton.dataset.rowIndex))
        return
    }

    const deleteButton = event.target.closest(".ventasRowDeleteBtn")
    if (!deleteButton) {
        return
    }

    const rowIndex = Number(deleteButton.dataset.rowIndex)
    const row = currentVentasData.rows?.[rowIndex]
    const isEmpty =
        !row ||
        (!row.fecha &&
            !row.assetId &&
            parseLooseNumber(row.cantidad || "") === null &&
            parseLooseNumber(row.valorVenta || "") === null)

    const removeRow = async () => {
        currentVentasData.rows.splice(rowIndex, 1)
        await persistVentasData()
        renderVentasTable()
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
        message:
            "Esta fila tiene contenido. Al borrarla, sus participaciones vuelven a la cartera y el coste FIFO de las ventas posteriores se recalculará. ¿Quieres eliminarla?",
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            try {
                await removeRow()
            } catch (error) {
                console.error(error)
                alert(error.detalle || "No se pudo eliminar la fila.")
            }
        }
    })
}

// La tabla se puede reordenar pulsando en una cabecera, y ese orden es el que
// se guarda. Solo se reordena: los valores salen de `currentVentasData.rows`,
// no del DOM. Leerlos del DOM —como hacía la versión anterior— perdía la fila
// que acababa de añadirse por el modal, porque todavía no estaba pintada.
function syncVentasDataFromTable() {
    const posiciones = new Map()
    document.querySelectorAll("#ventasBody tr[data-venta-id]").forEach((elemento, indice) => {
        posiciones.set(elemento.dataset.ventaId, indice)
    })

    if (!posiciones.size) {
        return
    }

    currentVentasData.rows = currentVentasData.rows
        .map((row, indice) => ({
            row,
            // Las filas todavía sin pintar se quedan al final, en su orden.
            posicion: posiciones.has(row.id) ? posiciones.get(row.id) : posiciones.size + indice
        }))
        .sort((izquierda, derecha) => izquierda.posicion - derecha.posicion)
        .map(({ row }) => row)
}

async function persistVentasData(options = {}) {
    syncVentasDataFromTable()

    const payload = {
        year: currentVentasYear,
        rows: currentVentasData.rows.map((row) => ({
            id: row.id,
            fecha: row.fecha,
            assetId: row.assetId,
            activo: getVentasAssetName(row.assetId),
            cantidad: row.cantidad,
            valorVenta: row.valorVenta,
            comisionVenta: row.comisionVenta
        }))
    }

    const respuesta = await saveVentasData(currentVentasYear, payload, options)

    if (respuesta?.rows) {
        applyVentasPayload(respuesta)
    }

    if (!options.keepalive) {
        await refreshAssetsSidebar(currentAssetId, false)
    }

    return respuesta
}

async function flushVentasPendingChanges() {
    if (!document.getElementById("ventasBody")) {
        return
    }

    await persistVentasData({ keepalive: true })
}

function bindVentasPersistenceGuards() {
    if (ventasPersistenceBound) {
        return
    }

    ventasPersistenceBound = true

    window.addEventListener("beforeunload", () => {
        if (!document.getElementById("ventasBody")) {
            return
        }

        persistVentasData({ keepalive: true }).catch((error) => {
            console.error("Error al guardar ventas al cerrar la ventana:", error)
        })
    })

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "hidden" || !document.getElementById("ventasBody")) {
            return
        }

        persistVentasData({ keepalive: true }).catch((error) => {
            console.error("Error al guardar ventas al cambiar de ventana:", error)
        })
    })
}
