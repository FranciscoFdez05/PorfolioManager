// Esta página ya no calcula nada fiscal. El coste FIFO, la ganancia, los
// tramos y la cuota los devuelve el servidor (`/api/ventas`), que es quien
// tiene el histórico completo de todos los ejercicios. Antes se calculaban
// aquí con los datos del año abierto en pantalla, y eso hacía imposible un
// FIFO correcto: los lotes ya consumidos por ventas de otros años volvían a
// estar disponibles. Lo único que se manda al guardar son los datos de hecho
// de cada venta.

let currentVentasData = { rows: [], resumen: null, incidencias: [] }
// Copia de lo último que se leyó o se guardó en el servidor, solo con los datos
// de hecho de cada venta. Ante un 409 (el ejercicio cambió desde otro sitio) es
// la base de la fusión: ver core/fusion-anual.js.
let ventasBaseFilas = []
let ventasPersistenceBound = false
let ventasAssets = []
let ventasYears = []
let currentVentasYear = null
let ventasModalKeyHandler = null

function escapeVentasHtml(value) {
    // Alias del escapeHtml común (js/core/dom.js). Había una copia por
    // módulo y no todas escapaban las comillas, que es lo que importa en
    // un atributo value="…".
    return escapeHtml(value)
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
        error.status = response.status
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

// El servidor devuelve los ejercicios de más antiguo a más reciente: abrir el
// primero dejaba la pantalla en el más viejo. Se abre el año en curso si
// existe y, si no, el más reciente.
function chooseDefaultVentasYear(years) {
    const actual = String(new Date().getFullYear())
    const lista = Array.isArray(years) ? years.map(String) : []
    return lista.includes(actual) ? actual : lista[lista.length - 1] || actual
}

async function initVentasLogic() {
    const [ventasIndex] = await Promise.all([loadVentasIndex(), loadVentasAssets()])

    ventasYears = Array.isArray(ventasIndex?.years) ? ventasIndex.years : []
    currentVentasYear = chooseDefaultVentasYear(ventasYears)
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
        incidencias: Array.isArray(payload?.incidencias) ? payload.incidencias : [],
        revision: Number.isInteger(payload?.revision) ? payload.revision : null
    }
    ventasBaseFilas = currentVentasData.rows.map(filaDeHechoVenta)
}

// Lo que identifica una venta a efectos de la fusión: los datos de hecho. El
// nombre del activo es una etiqueta que resuelve el servidor y no cuenta.
function filaDeHechoVenta(row) {
    return {
        id: row.id,
        fecha: row.fecha,
        assetId: row.assetId,
        cantidad: row.cantidad,
        valorVenta: row.valorVenta,
        comisionVenta: row.comisionVenta
    }
}

// Fusión a tres bandas tras un 409: lo que el usuario cambió respecto a la
// copia que cargó, aplicado sobre lo que hay ahora en el servidor.
async function fusionarVentasTrasConflicto(payload) {
    const servidor = await loadVentasYear(payload.year)
    const filas = fusionarListaTresVias(
        ventasBaseFilas,
        payload.rows.map(filaDeHechoVenta),
        (servidor.rows || []).map((row) => filaDeHechoVenta(normalizeVentaRow(row))),
        claveEstableAnual
    )
    const respuesta = await saveVentasData(payload.year, {
        year: payload.year,
        rows: filas,
        revision: servidor.revision
    })
    if (typeof showToast === "function") {
        showToast(
            "Este ejercicio había cambiado desde otro sitio (otra pestaña, otro dispositivo). Se han combinado los cambios.",
            {
                type: "warning"
            }
        )
    }
    return respuesta
}

function closeVentasMenu() {
    document.getElementById("ventasMenuDropdown")?.classList.add("hidden")
}

function bindVentasMenu() {
    const menuBtn = document.getElementById("ventasMenuBtn")
    const menuDropdown = document.getElementById("ventasMenuDropdown")
    if (!menuBtn || !menuDropdown || menuBtn.dataset.bound) return

    menuBtn.dataset.bound = "true"
    menuBtn.addEventListener("click", (event) => {
        event.stopPropagation()
        menuDropdown.classList.toggle("hidden")
    })
    // Cada visita a la página crea un botón nuevo; el listener del anterior se
    // desactiva solo al dejar de estar conectado al DOM.
    document.addEventListener("click", (event) => {
        if (!menuBtn.isConnected) return
        if (!event.target.closest("#ventasMenuBtn") && !event.target.closest("#ventasMenuDropdown")) {
            closeVentasMenu()
        }
    })
}

function bindVentasEvents() {
    const ventasBody = document.getElementById("ventasBody")
    const addYearButton = document.getElementById("addVentasYearBtn")
    const deleteYearButton = document.getElementById("deleteVentasYearBtn")
    const addButton = document.getElementById("addVentaRowBtn")
    const saveButton = document.getElementById("saveVentasBtn")
    bindVentasMenu()
    if (ventasBody && !ventasBody.dataset.bound) {
        ventasBody.dataset.bound = "true"
        ventasBody.addEventListener("click", handleVentasActionClick)
    }

    if (addYearButton && !addYearButton.dataset.bound) {
        addYearButton.dataset.bound = "true"
        addYearButton.addEventListener("click", async () => {
            closeVentasMenu()
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
            closeVentasMenu()
            openConfirmModal({
                title: "Eliminar año",
                message: `Vas a eliminar el año ${currentVentasYear}. Sus ventas dejarán de consumir lotes, así que el coste FIFO de los años siguientes se recalculará. Esto no se puede deshacer.`,
                confirmLabel: "Eliminar",
                confirmSide: "right",
                requireText: String(currentVentasYear),
                onConfirm: async () => {
                    const response = await deleteVentasYearRequest(currentVentasYear)
                    ventasYears = Array.isArray(response.years) ? response.years : (await loadVentasIndex()).years || []
                    await renderVentasYear(chooseDefaultVentasYear(ventasYears))
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
        <input id="ventaCantidadInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeVentasHtml(formatVentasNumberInput(rowData.cantidad) || "")}" placeholder="0">
        <label class="assetModalLabel" for="ventaValorInput">Valor de venta (por unidad)</label>
        <input id="ventaValorInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeVentasHtml(formatVentasMoney(rowData.valorVenta, getVentaRowCurrency(rowData)) || "")}" placeholder="0,00">
        <label class="assetModalLabel" for="ventaComisionInput">Comisión de la venta</label>
        <input id="ventaComisionInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeVentasHtml(formatVentasMoney(rowData.comisionVenta, getVentaRowCurrency(rowData)) || "")}" placeholder="0,00">
        <p class="assetModalHint" id="ventaMonedaHint"></p>
        <p class="assetModalHint">Los gastos de la venta minoran el valor de transmisión (art. 35.2 LIRPF).</p>
        <p class="gastosCreateModalFeedback hidden" id="ventasModalFeedback"></p>
        <div class="assetModalActions ventasModalActions">
            <button type="button" class="cancelButton" id="ventasModalCancelBtn">Cancelar</button>
            <button type="button" class="primaryButton" id="ventasModalSaveBtn" data-no-autohide="true">Guardar</button>
        </div>
    `

    initSearchableSelect(modal.querySelector("#ventaActivoInput"))

    // Valor y comisión se teclean en la divisa del activo; el resultado fiscal
    // se calcula en euros con el tipo de cambio de la fecha de cada operación.
    const actualizarMoneda = () => {
        const assetId = modal.querySelector("#ventaActivoInput")?.value.trim() || ""
        const hint = modal.querySelector("#ventaMonedaHint")
        if (hint) {
            hint.textContent = `Valor y comisión en ${getVentasAssetCurrency(assetId || rowData.assetId)}, la divisa del activo.`
        }
    }
    actualizarMoneda()
    modal.querySelector("#ventaActivoInput")?.addEventListener("change", actualizarMoneda)

    const setFeedback = (message = "", isError = false) => {
        const node = modal.querySelector("#ventasModalFeedback")
        if (!node) return
        node.textContent = message
        node.classList.toggle("hidden", !message)
        node.classList.toggle("error", Boolean(message && isError))
    }

    modal.querySelector("#ventasModalCancelBtn")?.addEventListener("click", closeVentasModal)
    modal.querySelector("#ventasModalSaveBtn")?.addEventListener("click", async () => {
        const fecha = modal.querySelector("#ventaFechaInput")?.value.trim() || ""
        const assetId = modal.querySelector("#ventaActivoInput")?.value.trim() || ""
        const cantidadRaw = modal.querySelector("#ventaCantidadInput")?.value.trim() || ""
        const valorVentaRaw = modal.querySelector("#ventaValorInput")?.value.trim() || ""
        const comisionRaw = modal.querySelector("#ventaComisionInput")?.value.trim() || ""
        // En formato canónico (punto decimal, sin miles): el servidor lo lee con
        // dinero.aDecimal. Antes se guardaba el texto con el formato de pantalla,
        // y "12.000" acciones (es-ES) valían 12 para el FIFO.
        const cantidad = toCanonicalNumber(cantidadRaw)
        const valorVenta = toCanonicalNumber(valorVentaRaw)
        const comisionVenta = toCanonicalNumber(comisionRaw)

        // El servidor valida de verdad; aquí solo se evita el viaje inútil.
        if (!fecha || !assetId || !cantidad || !valorVenta) {
            setFeedback("Fecha, activo, cantidad y valor de venta son obligatorios.", true)
            return
        }

        // Cada venta vive en el ejercicio de su fecha: decirlo aquí evita el
        // rechazo del servidor con un mensaje que no dice qué ejercicio abrir.
        const anioFecha = (fecha.match(/(\d{4})\s*$/) || fecha.match(/^(\d{4})/) || [])[1]
        if (anioFecha && anioFecha !== String(currentVentasYear)) {
            setFeedback(
                `La fecha es de ${anioFecha} y estás en el ejercicio ${currentVentasYear}: abre el ejercicio ${anioFecha} para añadirla.`,
                true
            )
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

    // El más reciente a la izquierda; ventasYears sigue en el orden del backend.
    ;[...ventasYears].reverse().forEach((year) => {
        const button = document.createElement("button")
        button.type = "button"
        button.className = `interesesYearBtn${year === currentVentasYear ? " active" : ""}`
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
    refrescarTiraPestanas(list)
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
        <td data-field="valorVenta">${formatVentasMoney(row.valorVenta, getVentaRowCurrency(row))}</td>
        <td data-field="comisionVenta">${formatVentasMoney(row.comisionVenta, getVentaRowCurrency(row))}</td>
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

// Para rellenar el campo de edición: sin separador de miles y con el decimal del
// locale activo, de modo que volver a leerlo con toCanonicalNumber da lo mismo.
function formatVentasNumberInput(value) {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null || String(value || "").trim() === "") {
        return ""
    }

    return parsedValue.toLocaleString(window._numLocale || "es-ES", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 8,
        useGrouping: false
    })
}

// El valor y la comisión de una venta están en la divisa del activo; el
// resultado fiscal (coste, ganancia, cuota) va siempre en euros.
function formatVentasMoney(value, currency = "EUR") {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null || String(value || "").trim() === "") {
        return ""
    }

    return formatMoney(parsedValue, currency)
}

function getVentasAssetCurrency(assetId) {
    const asset = ventasAssets.find((item) => item.id === assetId)
    return normalizeCurrencyCode(asset?.currency || "EUR")
}

function getVentaRowCurrency(row) {
    return normalizeCurrencyCode(row?.currency || getVentasAssetCurrency(row?.assetId))
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
        })),
        ...(Number.isInteger(currentVentasData.revision) ? { revision: currentVentasData.revision } : {})
    }

    let respuesta
    try {
        respuesta = await saveVentasData(currentVentasYear, payload, options)
    } catch (error) {
        // Con keepalive la página puede estar cerrándose: no hay tiempo de
        // fusionar. La revisión no avanza y en el servidor no se ha borrado nada.
        if (error?.status !== 409 || options.keepalive) {
            throw error
        }
        respuesta = await fusionarVentasTrasConflicto(payload)
    }

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
