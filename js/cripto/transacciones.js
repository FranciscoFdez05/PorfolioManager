let currentTransaccionesData = { rows: [] }
let transaccionesAutosaveTimeout = null
let transaccionesPersistenceBound = false
// Solo se guarda al ocultar o cerrar la pestaña si hubo cambios locales: sin
// esta marca, una pestaña con la lista vieja pisaba lo guardado desde otro sitio.
let transaccionesHasPendingChanges = false
// Revisión que el servidor tenía al cargar o guardar por última vez, y copia de
// las filas de entonces: la base de la fusión si otro sitio guarda antes.
let transaccionesRevision = null
let transaccionesBaseRows = []
let transaccionesCryptoAssets = []
// Criptos visibles en la tabla; null es «Todos».
let transaccionesFilter = null
let transaccionesPersistChain = Promise.resolve()
// Lo que el detalle de una fila necesita de las wallets, leído solo al abrir la
// primera: la mayoría de visitas a esta página no lo usan.
let transaccionesWalletsCargadas = false
const transaccionesHistoriales = new Map()
let transaccionesAbriendoDetalle = false
// Filas importadas que el servidor no deja borrar: aún hay una wallet propia en su red.
let transaccionesFilasProtegidas = null
const TRANSACCIONES_LIMITE_HISTORIAL = 500
// Ninguna dirección de las redes admitidas baja de aquí: un nombre corto no se abrevia.
const TRANSACCIONES_LARGO_MINIMO_DIRECCION = 25
const TRANSACCION_WALLET_OPTIONS = [
    { value: "entre_wallet", label: "Entre wallet" },
    { value: "recibida", label: "Recibida" },
    { value: "enviada", label: "Enviada" },
    // Importada y sin verificar: se ve aquí, pero no suma a la posición.
    { value: "pendiente", label: "Pendiente de verificar" }
]

async function loadTransaccionesData() {
    const response = await fetch("/api/transacciones?conProteccion=1")

    if (!response.ok) {
        throw new Error("No se pudieron cargar las transacciones")
    }

    const datos = await response.json()
    transaccionesFilasProtegidas = new Set(datos.filasProtegidas || [])
    return datos
}

async function saveTransaccionesData(payload, options = {}) {
    const response = await fetch("/api/transacciones", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        keepalive: Boolean(options.keepalive)
    })

    if (!response.ok) {
        const errorText = await response.text()
        const error = new Error(`HTTP ${response.status}: ${errorText}`)
        error.status = response.status
        throw error
    }
    return await response.json().catch(() => null)
}

function transaccionesFaltaComision(rows = []) {
    return rows.some(
        (row) =>
            String(row?.id || "").startsWith("wallet-") &&
            normalizeTransaccionWalletTipo(row?.walletTipo) === "entre_wallet" &&
            !String(row?.comisionRed || "").trim()
    )
}

/**
 * Pide al servidor la comisión de las filas importadas que deberían tenerla.
 *
 * Un fallo no impide ver la tabla: la fila sigue como estaba y se reintenta al volver.
 *
 * @param {Array<object>} rows Filas recién leídas.
 * @returns {Promise<boolean>} Si ha cambiado alguna y hay que releerlas.
 */
async function completarComisionesDeTransacciones(rows) {
    if (!transaccionesFaltaComision(rows)) return false
    try {
        const response = await fetch("/api/wallets/transacciones/completar-comisiones", { method: "POST" })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const datos = await response.json()
        return Number(datos?.completadas) > 0
    } catch (error) {
        console.warn("No se pudieron completar las comisiones de las transacciones.", error)
        return false
    }
}

async function initTransaccionesLogic() {
    transaccionesWalletsCargadas = false
    transaccionesHistoriales.clear()
    currentTransaccionesData = await loadTransaccionesData()
    if (await completarComisionesDeTransacciones(currentTransaccionesData?.rows)) {
        currentTransaccionesData = await loadTransaccionesData()
        // La comisión baja la posición, y Activos tiene su propia copia de las filas.
        await refreshAssetsSidebar(currentAssetId, false)
    }
    transaccionesRevision = Number.isInteger(currentTransaccionesData?.revision)
        ? currentTransaccionesData.revision
        : null
    transaccionesBaseRows = JSON.parse(JSON.stringify(currentTransaccionesData?.rows || []))
    await loadTransaccionesCryptoAssets()
    bindTransaccionesPersistenceGuards()
    window.flushPendingPageChanges = flushTransaccionesPendingChanges
    renderTransaccionesAssetMenu()
    renderTransaccionesTable()
    bindTransaccionesEvents()
    // Sincronizar cambia las wallets después de releer las filas: hay que repintar.
    window.alCambiarWallets = () => renderTransaccionesTable()
    cargarWalletsDeLaTabla()
}

/**
 * Lee las wallets y repinta la tabla con sus direcciones.
 *
 * No se espera: `/api/wallets` calcula precios y la tabla no debe tardar por ello.
 * Un fallo deja a la vista los nombres guardados en las filas.
 *
 * @returns {Promise<void>}
 */
async function cargarWalletsDeLaTabla() {
    if (!(currentTransaccionesData?.rows || []).some(transaccionEsImportada)) return
    try {
        await asegurarWalletsDeTransacciones()
        renderTransaccionesTable()
    } catch (error) {
        console.warn("No se pudieron leer las direcciones de las wallets.", error)
    }
}

async function loadTransaccionesCryptoAssets() {
    const assets = await loadAssetsList()
    const cryptoAssets = assets
        .filter(
            (asset) =>
                String(asset?.type || "")
                    .trim()
                    .toLowerCase() === "cripto"
        )
        .sort((firstAsset, secondAsset) => {
            const firstOrder = Number.isFinite(Number(firstAsset?.order))
                ? Number(firstAsset.order)
                : Number.MAX_SAFE_INTEGER
            const secondOrder = Number.isFinite(Number(secondAsset?.order))
                ? Number(secondAsset.order)
                : Number.MAX_SAFE_INTEGER

            if (firstOrder !== secondOrder) {
                return firstOrder - secondOrder
            }

            return String(firstAsset?.name || "").localeCompare(String(secondAsset?.name || ""), "es")
        })

    const stablecoinAssets = []

    if (typeof loadStablecoinsData === "function") {
        try {
            const stablecoinsPayload = await loadStablecoinsData()
            const enabledSymbols = Array.isArray(stablecoinsPayload?.enabledSymbols)
                ? stablecoinsPayload.enabledSymbols
                : []

            enabledSymbols
                .map((symbol) =>
                    String(symbol || "")
                        .trim()
                        .toUpperCase()
                        .replace(/[^A-Z0-9]/g, "")
                )
                .filter(Boolean)
                .forEach((symbol) => {
                    stablecoinAssets.push({
                        id: `stablecoin-${symbol}`,
                        name: symbol,
                        symbol,
                        type: "stablecoin"
                    })
                })
        } catch (error) {
            console.warn("No se pudieron cargar las stablecoins para transacciones.", error)
        }
    }

    transaccionesCryptoAssets = [...cryptoAssets, ...stablecoinAssets]

    // Un filtro guardado de una visita anterior puede apuntar a una cripto que
    // ya no existe: se descarta y, si no queda ninguna, se vuelve a «Todos».
    if (transaccionesFilter) {
        const assetIds = new Set(transaccionesCryptoAssets.map((asset) => asset.id))
        transaccionesFilter = new Set([...transaccionesFilter].filter((id) => assetIds.has(id)))
        if (!transaccionesFilter.size) transaccionesFilter = null
    }
}

function bindTransaccionesEvents() {
    const body = document.getElementById("transaccionesBody")
    const saveButton = document.getElementById("saveTransaccionesBtn")
    const filtersEl = document.getElementById("transaccionesAssetMenu")
    if (filtersEl && !filtersEl.dataset.bound) {
        filtersEl.dataset.bound = "true"
        filtersEl.addEventListener("change", handleTransaccionesFilterChange)
    }

    if (body && !body.dataset.bound) {
        body.dataset.bound = "true"
        body.addEventListener("click", handleTransaccionesClick)
        body.addEventListener("click", handleTransaccionesDeleteClick)
    }

    const syncButton = document.getElementById("transaccionesSincronizarBtn")
    if (syncButton && !syncButton.dataset.bound) {
        syncButton.dataset.bound = "true"
        syncButton.addEventListener("click", () => sincronizarWalletsPropias(syncButton))
    }

    const menuTrigger = document.querySelector("#transaccionesActionsMenu .pageActionsMenuTrigger")
    const menu = document.getElementById("transaccionesActionsDropdown")
    if (menuTrigger && menu && !menu.dataset.bound) {
        menu.dataset.bound = "true"
        menuTrigger.addEventListener("click", (event) => {
            event.stopPropagation()
            menu.classList.toggle("open")
        })
        menu.addEventListener("click", () => menu.classList.remove("open"))
        // Como en Cuentas: el listener del documento se retira solo cuando el
        // menú ya no está en pantalla.
        const cerrar = () => {
            if (!menu.isConnected) {
                document.removeEventListener("click", cerrar)
                return
            }
            menu.classList.remove("open")
        }
        document.addEventListener("click", cerrar)
        document.getElementById("transaccionesGrafoBtn")?.addEventListener("click", abrirGrafoTransacciones)
        document.getElementById("transaccionesWalletsBtn")?.addEventListener("click", abrirWalletsEnlazadas)
    }

    if (saveButton && !saveButton.dataset.bound) {
        saveButton.dataset.bound = "true"
        saveButton.addEventListener("click", async () => {
            try {
                await persistTransaccionesData()
                alert("Datos guardados en data/transacciones.json")
            } catch (error) {
                console.error(error)
                alert("No se pudieron guardar las transacciones.")
            }
        })
    }
}

// Las filas importadas salen de la blockchain: de ellas solo se edita la nota. El
// servidor lo impone igualmente (protegerFilasImportadas en core/wallets_sync.py).
function esTransaccionImportada(row) {
    return String(row?.id || "").startsWith("wallet-")
}

function esTransaccionEliminable(row) {
    return !esTransaccionImportada(row) || !transaccionesFilasProtegidas?.has(row.id)
}

function getTransaccionAsset(assetId) {
    return transaccionesCryptoAssets.find((asset) => asset.id === assetId) || null
}

// Color del activo tal y como está en Activos, ajustado para que se lea sobre el
// tema (un activo casi negro desaparecía en el tema oscuro). Las stablecoins no
// tienen ficha de activo y van todas en el mismo rosa que en su página.
function getTransaccionAssetColor(asset) {
    return colorLegibleEnTema(asset?.color || (asset?.type === "stablecoin" ? "#f472b6" : "#8899bb"))
}

function getVisibleTransaccionesRows() {
    const rows = currentTransaccionesData.rows || []
    return transaccionesFilter ? rows.filter((row) => transaccionesFilter.has(row.assetId)) : rows
}

function buildTransaccionesFilterChip(value, text, color, checked) {
    const label = document.createElement("label")
    label.className = "overviewFilterOption transaccionesFilterChip"
    label.style.setProperty("--chipColor", color)
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(value)}"${checked ? " checked" : ""}><span>${escapeHtml(text)}</span>`
    return label
}

function renderTransaccionesAssetMenu() {
    const menu = document.getElementById("transaccionesAssetMenu")

    if (!menu) {
        return
    }

    menu.innerHTML = ""

    if (!transaccionesCryptoAssets.length) {
        refrescarTiraPestanas(menu)
        return
    }

    const todosMode = !transaccionesFilter
    menu.appendChild(buildTransaccionesFilterChip("todos", "Todos", "#8899bb", todosMode))
    transaccionesCryptoAssets.forEach((asset, index) => {
        // Separador entre las criptos y las stablecoins, que van al final de la lista.
        const anterior = transaccionesCryptoAssets[index - 1]
        if (asset.type === "stablecoin" && anterior && anterior.type !== "stablecoin") {
            const separador = document.createElement("div")
            separador.className = "filtersDivider"
            menu.appendChild(separador)
        }
        menu.appendChild(
            buildTransaccionesFilterChip(
                asset.id,
                asset.name || asset.symbol || asset.id,
                getTransaccionAssetColor(asset),
                todosMode || transaccionesFilter.has(asset.id)
            )
        )
    })
    refrescarTiraPestanas(menu)
}

// Mismo criterio que el resto de filtros de la app: desde «Todos», pulsar una
// cripto deja solo esa; luego se suman o quitan; sin ninguna (o con todas)
// vuelve a «Todos».
function handleTransaccionesFilterChange(event) {
    const input = event.target.closest("input")
    if (!input) return

    const value = input.value
    if (value === "todos") {
        transaccionesFilter = null
    } else if (!transaccionesFilter) {
        transaccionesFilter = new Set([value])
    } else {
        if (transaccionesFilter.has(value)) transaccionesFilter.delete(value)
        else transaccionesFilter.add(value)
        if (!transaccionesFilter.size || transaccionesFilter.size === transaccionesCryptoAssets.length) {
            transaccionesFilter = null
        }
    }

    renderTransaccionesAssetMenu()
    renderTransaccionesTable()
}

function renderTransaccionesTable() {
    const body = document.getElementById("transaccionesBody")

    if (!body) {
        return
    }

    body.innerHTML = ""

    const tableWrapper = document.getElementById("transaccionesTableWrapper")
    const noAssetEl = document.getElementById("transaccionesNoAssetMsg")
    const transaccionesEmptyEl = document.getElementById("transaccionesEmptyMsg")

    if (!transaccionesCryptoAssets.length) {
        if (tableWrapper) tableWrapper.classList.add("hidden")
        if (noAssetEl) noAssetEl.classList.remove("hidden")
        if (transaccionesEmptyEl) transaccionesEmptyEl.classList.add("hidden")
        return
    }

    if (noAssetEl) noAssetEl.classList.add("hidden")

    const rows = getVisibleTransaccionesRows()

    if (!rows.length) {
        if (tableWrapper) tableWrapper.classList.add("hidden")
        if (transaccionesEmptyEl) transaccionesEmptyEl.classList.remove("hidden")
        return
    }
    if (tableWrapper) tableWrapper.classList.remove("hidden")
    if (transaccionesEmptyEl) transaccionesEmptyEl.classList.add("hidden")

    rows.forEach((row) => {
        body.appendChild(buildTransaccionRow(row))
    })

    bindTableSort(body.closest("table"), "transacciones")
}

function normalizeHashTransaccionValue(value) {
    return String(value || "").trim()
}

function formatHashTransaccionDisplay(value) {
    const normalizedValue = normalizeHashTransaccionValue(value)

    if (!normalizedValue) {
        return ""
    }

    if (normalizedValue.length <= 14) {
        return normalizedValue
    }

    return `${normalizedValue.slice(0, 6)}...${normalizedValue.slice(-6)}`
}

function normalizeTransaccionWalletTipo(value) {
    const normalizedValue = String(value || "")
        .trim()
        .toLowerCase()

    if (normalizedValue === "recibida") {
        return "recibida"
    }

    if (normalizedValue === "enviada" || normalizedValue === "no_mia") {
        return "enviada"
    }

    if (normalizedValue === "pendiente") {
        return "pendiente"
    }

    return "entre_wallet"
}

/**
 * Pinta las acciones del menú ··· de una fila.
 *
 * Una fila importada no tiene «Editar» completo: su comisión y su clasificación se
 * cambian en el detalle, y «Eliminar» solo sale si el servidor va a aceptarlo.
 *
 * @param {object} row Fila de la tabla.
 * @returns {string} El HTML de las acciones.
 */
function transaccionAccionesHtml(row) {
    const id = escapeHtml(row.id)
    const claseItem = "rowMenuItem assetRowEditBtn avActionBtn avEditBtn"
    const editar = esTransaccionImportada(row)
        ? `<button type="button" class="${claseItem} transaccionRowDetalleBtn" data-row-id="${id}">Comisión y clasificación</button>
                    <button type="button" class="${claseItem} transaccionRowEditBtn" data-row-id="${id}">Editar nota</button>`
        : `<button type="button" class="${claseItem} transaccionRowEditBtn" data-row-id="${id}">Editar</button>`
    if (!esTransaccionEliminable(row)) return editar
    return `${editar}
                    <hr>
                    <button type="button" class="rowMenuItem rowMenuItemDanger assetRowDeleteBtn transaccionRowDeleteBtn avActionBtn avDeleteBtn" data-row-id="${id}">Eliminar</button>`
}

function transaccionEsImportada(row) {
    return String(row?.id || "").startsWith("wallet-")
}

/**
 * Abrevia una dirección con el formato de `enmascarar` del servidor.
 *
 * @param {string} valor Dirección, o el texto que tenga la fila.
 * @returns {string} La dirección abreviada; un nombre o un texto corto, tal cual.
 */
function abreviarDireccionTransaccion(valor) {
    if (valor.length < TRANSACCIONES_LARGO_MINIMO_DIRECCION || /\s/.test(valor)) return valor
    return `${valor.slice(0, 8)}…${valor.slice(-4)}`
}

function transaccionWalletsConNombre(nombre) {
    const clave = nombre.toLowerCase()
    const wallets = typeof walletsEstado === "undefined" ? [] : walletsEstado.wallets
    return wallets.filter(
        (wallet) =>
            wallet.propia !== false &&
            (wallet.seguimientoClave === clave || String(wallet.alias || "").toLowerCase() === clave)
    )
}

/**
 * La dirección de la wallet propia que una fila importada guarda por su nombre.
 *
 * El movimiento dice la dirección exacta, pero solo se guardan los recientes de
 * cada wallet. Para los anteriores vale la wallet de ese activo si no hay duda:
 * con varias, se deja el nombre antes que enseñar una dirección que no es.
 *
 * @param {string} nombre Nombre que guarda la fila en origen o destino.
 * @param {object} row Fila de Transacciones.
 * @returns {string} Dirección completa o enmascarada; vacío si no se sabe cuál es.
 */
function direccionPropiaDeFila(nombre, row) {
    if (!transaccionEsImportada(row)) return ""
    const wallets = transaccionWalletsConNombre(nombre)
    const direccion = buscarMovimientoDeFila(row, wallets, (wallet) => wallet.recientes || [])?.mov.propia
    if (direccion) return direccion
    const candidatas = wallets.length === 1 ? wallets : wallets.filter((wallet) => wallet.assetId === row.assetId)
    return candidatas.length === 1 ? candidatas[0].valorEnmascarado || "" : ""
}

function transaccionCeldaWalletHtml(valor, row) {
    const texto = String(valor || "").trim()
    const direccion = texto ? direccionPropiaDeFila(texto, row) : ""
    const titulo = direccion ? `${texto}: ${direccion}` : texto
    return `<td title="${escapeHtml(titulo)}">${escapeHtml(abreviarDireccionTransaccion(direccion || texto))}</td>`
}

function buildTransaccionRow(row) {
    const tr = document.createElement("tr")
    const hashTransaccion = normalizeHashTransaccionValue(row.hashTransaccion || row.walletOrigen || "")
    const walletLabel =
        TRANSACCION_WALLET_OPTIONS.find((o) => o.value === normalizeTransaccionWalletTipo(row.walletTipo))?.label ||
        row.walletTipo ||
        ""
    const asset = getTransaccionAsset(row.assetId)
    const assetColor = getTransaccionAssetColor(asset)
    const assetName = asset?.name || row.assetName || ""
    tr.dataset.transaccionId = row.id
    tr.innerHTML = `
        <td><span class="mTypeBadge" style="background:${assetColor}22;color:${assetColor};border-color:${assetColor}44">${escapeHtml(assetName)}</span></td>
        <td>${escapeHtml(row.fechaOperacion)}</td>
        <td>${formatTransaccionesNumber(row.total)}</td>
        <td>${formatTransaccionesNumber(row.comisionRed)}</td>
        <td>${walletLabel}</td>
        ${transaccionCeldaWalletHtml(row.walletDesde, row)}
        ${transaccionCeldaWalletHtml(row.walletDestino, row)}
        <td class="transaccionHashCell" data-full-value="${escapeHtml(hashTransaccion)}" title="Haz clic para copiar el hash completo">${escapeHtml(formatHashTransaccionDisplay(hashTransaccion))}</td>
        <td>${escapeHtml(row.nota || "")}</td>
        <td class="rowActionsCell">
            <div class="rowMenu">
                <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                <div class="rowMenuDropdown">
                    ${transaccionAccionesHtml(row)}
                </div>
            </div>
        </td>
    `
    return tr
}

function formatTransaccionesNumber(value) {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null || String(value || "").trim() === "") {
        return ""
    }

    return parsedValue.toLocaleString("es-ES", {
        minimumFractionDigits: 8,
        maximumFractionDigits: 8
    })
}

async function copyHashTransaccionToClipboard(cell) {
    const fullHash = normalizeHashTransaccionValue(cell?.dataset?.fullValue || cell?.textContent || "")

    if (!fullHash) {
        return
    }

    try {
        await navigator.clipboard.writeText(fullHash)
        cell.classList.add("copied")
        cell.title = "Hash copiado"
        window.clearTimeout(Number(cell.dataset.copyTimeoutId || 0))
        cell.dataset.copyTimeoutId = String(
            window.setTimeout(() => {
                cell.classList.remove("copied")
                cell.title = "Haz clic para copiar el hash completo"
            }, 1200)
        )
    } catch (error) {
        console.error("No se pudo copiar el hash:", error)
    }
}

function handleTransaccionesDeleteClick(event) {
    const detalleButton = event.target.closest(".transaccionRowDetalleBtn")
    if (detalleButton) {
        abrirDetalleTransaccion(detalleButton.dataset.rowId)
        return
    }

    const editButton = event.target.closest(".transaccionRowEditBtn")
    if (editButton) {
        openTransaccionRowModal(editButton.dataset.rowId)
        return
    }

    const deleteButton = event.target.closest(".transaccionRowDeleteBtn")
    if (!deleteButton) return

    const rowId = deleteButton.dataset.rowId
    if (!rowId) return

    openConfirmModal({
        title: "Eliminar fila",
        message: "¿Quieres eliminar esta transacción?",
        confirmLabel: "Eliminar",
        onConfirm: () => {
            currentTransaccionesData.rows = (currentTransaccionesData.rows || []).filter((item) => item.id !== rowId)
            renderTransaccionesTable()
            scheduleTransaccionesAutosave()
        }
    })
}

function handleTransaccionesClick(event) {
    // Sin hash no hay nada que copiar: esa celda abre el detalle como el resto de la fila.
    const hashCell = event.target.closest('.transaccionHashCell:not([data-full-value=""])')

    if (!hashCell) {
        // El desplegable ··· está dentro de la fila: un clic en él no la abre.
        const fila = event.target.closest("tr[data-transaccion-id]")
        if (fila && !event.target.closest(".rowActionsCell")) abrirDetalleTransaccion(fila.dataset.transaccionId)
        return
    }

    copyHashTransaccionToClipboard(hashCell)
}

// ── Detalle de una fila ───────────────────────────────────────────────────────
// La misma ventana que en Seguimiento (js/cripto/wallets-seguimiento.js). Las filas
// no guardan direcciones ni contrato: hay que encontrar su movimiento en las wallets.

// Una transacción puede mover varios tokens: cada fila es solo uno de sus movimientos.
function transaccionEsDeSuActivo(mov, wallet, row, asset) {
    if (!mov.contrato && wallet.assetId === row.assetId) return true
    const simbolo = String(mov.simbolo || "").toUpperCase()
    return (
        Boolean(simbolo) &&
        [asset?.symbol, asset?.name, row.assetName].some((n) => String(n || "").toUpperCase() === simbolo)
    )
}

// Si la transacción está en las dos wallets propias que la movieron, se prefiere
// la que nombra la fila: al importarla, su lado propio se rellena con el nombre
// del seguimiento, no con el alias de la wallet.
function transaccionNombraWallet(wallet, row) {
    return [row.walletDesde, row.walletDestino].includes(wallet.seguimiento)
}

function buscarMovimientoDeFila(row, wallets, movimientosDe) {
    const hash = normalizeHashTransaccionValue(row.hashTransaccion).toLowerCase()
    if (!hash) return null
    const asset = getTransaccionAsset(row.assetId)
    const encontrados = wallets.flatMap((wallet) =>
        movimientosDe(wallet)
            .filter(
                (mov) =>
                    String(mov.hash || "").toLowerCase() === hash && transaccionEsDeSuActivo(mov, wallet, row, asset)
            )
            .map((mov) => ({ mov, wallet }))
    )
    return encontrados.find(({ wallet }) => transaccionNombraWallet(wallet, row)) || encontrados[0] || null
}

async function asegurarWalletsDeTransacciones() {
    if (transaccionesWalletsCargadas) return
    walletsEstado = await walletsPeticion("/api/wallets")
    walletsSegAnotarPublicos(walletsEstado.tokensPublicos)
    transaccionesWalletsCargadas = true
}

// Lo que no está entre los recientes guardados hay que leerlo de la red, y solo de
// la wallet que nombra la fila: una xpub son decenas de llamadas.
async function leerHistorialesDeFila(row) {
    const wallets = walletsEstado.wallets.filter(
        (wallet) => transaccionNombraWallet(wallet, row) && !transaccionesHistoriales.has(wallet.id)
    )
    if (!wallets.length) return
    const progreso = iniciarProgreso("Buscando la transacción", wallets.length)
    try {
        for (const wallet of wallets) {
            progreso.paso(walletsNombreCompleto(wallet))
            const datos = await walletsPeticion(
                `/api/wallets/${encodeURIComponent(wallet.id)}/movimientos?limite=${TRANSACCIONES_LIMITE_HISTORIAL}`
            )
            walletsSegAnotarPublicos(datos.tokensPublicos)
            transaccionesHistoriales.set(wallet.id, datos.movimientos || [])
        }
    } finally {
        progreso.terminar()
    }
}

async function localizarMovimientoDeFila(row) {
    if (!normalizeHashTransaccionValue(row.hashTransaccion)) return null
    await asegurarWalletsDeTransacciones()
    const enRecientes = buscarMovimientoDeFila(row, walletsEstado.wallets, (wallet) => wallet.recientes || [])
    if (enRecientes) return enRecientes
    await leerHistorialesDeFila(row)
    return buscarMovimientoDeFila(row, walletsEstado.wallets, (wallet) => transaccionesHistoriales.get(wallet.id) || [])
}

function transaccionSimbolo(row) {
    const asset = getTransaccionAsset(row.assetId)
    return asset?.symbol || asset?.name || row.assetName || ""
}

function transaccionConSimbolo(valor, row) {
    const numero = formatTransaccionesNumber(valor)
    return numero ? `${numero} ${transaccionSimbolo(row)}`.trim() : "—"
}

function transaccionResumenHtml(row) {
    const tipo = normalizeTransaccionWalletTipo(row.walletTipo)
    const cabecera = walletsSegMovCabeceraHtml({
        tipo,
        etiqueta: TRANSACCION_WALLET_OPTIONS.find((o) => o.value === tipo)?.label || "Transacción",
        cantidad: transaccionConSimbolo(row.total, row),
        fecha: row.fechaOperacion || "—"
    })
    return `${cabecera}${walletsSegMovRutaHtml({ titulo: "Origen", valor: row.walletDesde }, { titulo: "Destino", valor: row.walletDestino })}`
}

function transaccionDatosHtml(row) {
    const asset = getTransaccionAsset(row.assetId)
    const filas = [
        ["Activo", escapeHtml(asset?.name || row.assetName || "—")],
        ["Comisión", escapeHtml(transaccionConSimbolo(row.comisionRed, row))],
        ["Hash", walletsSegValorCopiableHtml(normalizeHashTransaccionValue(row.hashTransaccion))],
        ...(row.nota ? [["Nota", escapeHtml(row.nota)]] : [])
    ]
    return filas.map(([clave, valor]) => `<div><dt>${escapeHtml(clave)}</dt><dd>${valor}</dd></div>`).join("")
}

// Sin movimiento (una fila escrita a mano, o que ya no se encuentra en la red) no
// hay dirección que marcar: se enseña lo que dice la fila y se puede editar.
function abrirFilaSinMovimiento(row) {
    const asset = getTransaccionAsset(row.assetId)
    const tipo = normalizeTransaccionWalletTipo(row.walletTipo)
    walletsSegMontarVentanaMovimiento({
        titulo: `Transacción de ${asset?.name || row.assetName || "cripto"}`,
        tipo,
        resumenHtml: transaccionResumenHtml(row),
        datosHtml: transaccionDatosHtml(row),
        // La comisión del exchange se apunta en el movimiento: sin él no hay dónde.
        seccionesHtml: esTransaccionImportada(row)
            ? `<p class="walletsSegDato">No se ha podido leer este movimiento de la red. La comisión del exchange y la clasificación se podrán cambiar cuando se pueda leer.</p>`
            : "",
        filaTransaccion: row.id
    })
}

async function abrirDetalleTransaccion(rowId) {
    const row = (currentTransaccionesData.rows || []).find((r) => r.id === rowId)
    if (!row || transaccionesAbriendoDetalle) return
    transaccionesAbriendoDetalle = true
    try {
        // Marcar relee las filas del servidor: lo que quede por guardar se perdería.
        if (transaccionesHasPendingChanges) await persistTransaccionesData()
        const encontrado = await localizarMovimientoDeFila(row)
        if (!encontrado) {
            abrirFilaSinMovimiento(row)
            return
        }
        encontrado.mov.walletId = encontrado.wallet.id
        encontrado.mov.filaTransaccion = row.id
        abrirMovimientoSeguimiento(encontrado.mov)
    } catch (error) {
        // Sin red la fila se puede seguir viendo: solo falta lo que hay que leer.
        console.warn("No se pudo leer el movimiento de la transacción.", error)
        abrirFilaSinMovimiento(row)
    } finally {
        transaccionesAbriendoDetalle = false
    }
}

function syncTransaccionesDataFromTable() {
    // Table is display-only; data is managed directly in currentTransaccionesData.rows via the modal
}

function scheduleTransaccionesAutosave(delay = 500) {
    transaccionesHasPendingChanges = true
    window.clearTimeout(transaccionesAutosaveTimeout)
    transaccionesAutosaveTimeout = window.setTimeout(async () => {
        try {
            await persistTransaccionesData()
        } catch (error) {
            showError("No se pudieron guardar las transacciones", error, { persistent: true })
        }
    }, delay)
}

async function persistTransaccionesData(options = {}) {
    syncTransaccionesDataFromTable()
    window.clearTimeout(transaccionesAutosaveTimeout)
    const snapshot = {
        rows: (currentTransaccionesData.rows || []).map((row) => ({ ...row }))
    }

    transaccionesHasPendingChanges = false
    transaccionesPersistChain = transaccionesPersistChain
        .catch(() => {})
        .then(() =>
            saveTransaccionesData(
                {
                    ...snapshot,
                    ...(Number.isInteger(transaccionesRevision) ? { revision: transaccionesRevision } : {})
                },
                options
            )
        )

    try {
        let respuesta
        try {
            respuesta = await transaccionesPersistChain
        } catch (error) {
            // Con keepalive la página puede estar cerrándose: no hay tiempo de
            // fusionar, y en el servidor no se ha borrado nada.
            if (error?.status !== 409 || options.keepalive) throw error
            respuesta = await fusionarTransaccionesTrasConflicto(snapshot)
        }
        if (Number.isInteger(respuesta?.revision)) transaccionesRevision = respuesta.revision
        transaccionesBaseRows = JSON.parse(JSON.stringify(currentTransaccionesData.rows || []))
        if (respuesta?.conservadas > 0 && !options.keepalive) await avisarFilasConservadas()
    } catch (error) {
        transaccionesHasPendingChanges = true
        throw error
    }

    if (!options.keepalive) {
        await refreshAssetsSidebar(currentAssetId, false)
    }
}

// Esta pestaña creía poder borrarlas, pero entretanto se ha enlazado una wallet de
// su red: la tabla vuelve a lo que de verdad hay guardado.
async function avisarFilasConservadas() {
    await repintarTransaccionesDesdeServidor()
    showToast("No se ha eliminado: esa transacción sigue llegando de una wallet enlazada", { type: "error" })
}

// Otra pestaña u otro dispositivo guardó las transacciones entretanto: se
// aplican los cambios de esta pestaña (respecto a lo que cargó) sobre lo que hay.
async function fusionarTransaccionesTrasConflicto(snapshot) {
    const servidor = await loadTransaccionesData()
    const filasServidor = servidor.rows || []
    const { filas, descartadas } = resolverConflictosPorId(
        fusionarListaTresVias(transaccionesBaseRows, snapshot.rows, filasServidor, claveEstableAnual),
        filasServidor
    )
    currentTransaccionesData = { ...currentTransaccionesData, rows: filas }
    let respuesta
    try {
        respuesta = await saveTransaccionesData({ rows: filas, revision: servidor.revision })
    } catch (error) {
        // No se ha podido guardar: la pestaña vuelve a lo que hay en el servidor
        // para no enseñar como guardado lo que no lo está.
        currentTransaccionesData = { ...currentTransaccionesData, rows: filasServidor }
        transaccionesRevision = Number.isInteger(servidor.revision) ? servidor.revision : null
        transaccionesBaseRows = JSON.parse(JSON.stringify(filasServidor))
        renderTransaccionesTable()
        error.message = `No se han guardado tus cambios en las transacciones; se han recargado las del servidor. (${error.message})`
        throw error
    }
    renderTransaccionesTable()
    avisarFusion("las transacciones", descartadas.length)
    return respuesta
}

// Tras importar movimientos de una wallet (js/cripto/wallets.js) la tabla se
// relee entera: las filas nuevas las ha escrito el servidor.
async function recargarTransaccionesDesdeServidor() {
    if (document.getElementById("transaccionesBody")) await repintarTransaccionesDesdeServidor()
    // También fuera de esta página: la posición de Activos sale de su propia copia
    // de las filas, y una marca hecha desde Seguimiento le cambia la comisión.
    await refreshAssetsSidebar(currentAssetId, false)
}

async function repintarTransaccionesDesdeServidor() {
    // Una marca o una dirección nueva dejan desfasado lo leído para el detalle.
    transaccionesHistoriales.clear()
    currentTransaccionesData = await loadTransaccionesData()
    transaccionesRevision = Number.isInteger(currentTransaccionesData?.revision)
        ? currentTransaccionesData.revision
        : null
    transaccionesBaseRows = JSON.parse(JSON.stringify(currentTransaccionesData?.rows || []))
    transaccionesHasPendingChanges = false
    renderTransaccionesAssetMenu()
    renderTransaccionesTable()
}

async function flushTransaccionesPendingChanges() {
    if (!document.getElementById("transaccionesBody") || !transaccionesHasPendingChanges) {
        return
    }

    await persistTransaccionesData({ keepalive: true })
}

function bindTransaccionesPersistenceGuards() {
    if (transaccionesPersistenceBound) {
        return
    }

    transaccionesPersistenceBound = true

    window.addEventListener("beforeunload", () => {
        if (!document.getElementById("transaccionesBody") || !transaccionesHasPendingChanges) {
            return
        }

        persistTransaccionesData({ keepalive: true }).catch((error) => {
            console.error("Error al guardar transacciones al cerrar la ventana:", error)
        })
    })

    document.addEventListener("visibilitychange", () => {
        if (
            document.visibilityState !== "hidden" ||
            !document.getElementById("transaccionesBody") ||
            !transaccionesHasPendingChanges
        ) {
            return
        }

        persistTransaccionesData({ keepalive: true }).catch((error) => {
            console.error("Error al guardar transacciones al cambiar de ventana:", error)
        })
    })
}

// El texto del botón que lleva, desde el detalle, al formulario de esa fila.
function textoEditarFilaTransaccion(rowId) {
    const row = (currentTransaccionesData.rows || []).find((r) => r.id === rowId)
    return esTransaccionImportada(row) ? "Editar nota" : "Editar"
}

/**
 * Abre la ventana de la única parte editable de una fila importada: su nota.
 *
 * @param {object} row Fila importada de la blockchain.
 */
function openTransaccionNotaModal(row) {
    const overlay = document.createElement("div")
    overlay.id = "transaccionRowModalOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"
    overlay.innerHTML = `
        <div class="assetModal assetRowModal">
            <h3 class="assetModalTitle assetRowModalTitle">Editar nota</h3>
            <div class="assetRowModalFields">
                <p class="walletsSegDato">Los datos de esta transacción vienen de la blockchain y no se editan.</p>
                <div class="assetRowModalField">
                    <label class="assetRowModalLabel" for="txModalNota">Nota</label>
                    <input id="txModalNota" class="assetRowModalInput" type="text" placeholder="Opcional: motivo del envío…" value="${escapeHtml(row.nota || "")}">
                </div>
            </div>
            <div class="assetRowModalFooter">
                <button type="button" id="txRowModalCancelBtn" class="cancelButton">Cancelar</button>
                <button type="button" id="txRowModalSaveBtn" class="primaryButton" data-no-autohide="true">Guardar</button>
            </div>
        </div>`
    overlay.querySelector("#txRowModalCancelBtn").addEventListener("click", closeTransaccionRowModal)
    overlay.querySelector("#txRowModalSaveBtn").addEventListener("click", () => {
        row.nota = overlay.querySelector("#txModalNota").value.trim()
        renderTransaccionesTable()
        scheduleTransaccionesAutosave()
        closeTransaccionRowModal()
    })
    document.body.appendChild(overlay)
    overlay.querySelector("#txModalNota").focus()
}

function openTransaccionRowModal(rowId) {
    document.getElementById("transaccionRowModalOverlay")?.remove()

    const rowIndex = (currentTransaccionesData.rows || []).findIndex((r) => r.id === rowId)
    if (rowIndex < 0) return
    if (esTransaccionImportada(currentTransaccionesData.rows[rowIndex])) {
        openTransaccionNotaModal(currentTransaccionesData.rows[rowIndex])
        return
    }
    const rowData = { ...currentTransaccionesData.rows[rowIndex] }

    const walletOptions = TRANSACCION_WALLET_OPTIONS.map(
        (opt) =>
            `<option value="${escapeHtml(opt.value)}"${rowData.walletTipo === opt.value ? " selected" : ""}>${escapeHtml(opt.label)}</option>`
    ).join("")

    const assetOptions = transaccionesCryptoAssets
        .map(
            (asset) =>
                `<option value="${escapeHtml(asset.id)}"${asset.id === rowData.assetId ? " selected" : ""}>${escapeHtml(asset.name || asset.symbol || asset.id)}</option>`
        )
        .join("")

    const fieldsHtml = `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Cripto</label>
            <select id="txModalAsset" class="assetRowModalSelect">
                ${assetOptions}
            </select>
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Fecha operación</label>
            <input id="txModalFecha" class="assetRowModalInput" type="text" value="${escapeHtml(rowData.fechaOperacion)}" placeholder="dd-mm-aaaa">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Total cripto</label>
            <input id="txModalTotal" class="assetRowModalInput" type="text" inputmode="decimal" placeholder="0,05" value="${escapeHtml(rowData.total)}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Comisión (de red o del exchange)</label>
            <input id="txModalComision" class="assetRowModalInput" type="text" inputmode="decimal" placeholder="0,0001" value="${escapeHtml(rowData.comisionRed)}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Wallet</label>
            <select id="txModalWalletTipo" class="assetRowModalSelect">
                ${walletOptions}
            </select>
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Wallet origen</label>
            <input id="txModalWalletDesde" class="assetRowModalInput" type="text" value="${escapeHtml(rowData.walletDesde || "")}" placeholder="Ej: Binance">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Wallet destino</label>
            <input id="txModalWalletDestino" class="assetRowModalInput" type="text" placeholder="Ej: Ledger" value="${escapeHtml(rowData.walletDestino)}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Hash transacción</label>
            <input id="txModalHash" class="assetRowModalInput" type="text" placeholder="Ej: 0x3f5e…a91c" value="${escapeHtml(rowData.hashTransaccion)}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Nota</label>
            <input id="txModalNota" class="assetRowModalInput" type="text" placeholder="Opcional: motivo del envío…" value="${escapeHtml(rowData.nota)}">
        </div>
    `

    const overlay = document.createElement("div")
    overlay.id = "transaccionRowModalOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"
    overlay.dataset.rowId = rowId || ""

    const modal = document.createElement("div")
    modal.className = "assetModal assetRowModal modalDosColumnas"

    const titleEl = document.createElement("h3")
    titleEl.className = "assetModalTitle assetRowModalTitle"
    titleEl.textContent = "Editar transacción"

    const fields = document.createElement("div")
    fields.className = "assetRowModalFields"
    fields.innerHTML = fieldsHtml

    const footer = document.createElement("div")
    footer.className = "assetRowModalFooter"
    footer.innerHTML = `
        <button type="button" id="txRowModalDeleteBtn" class="dangerButton assetRowModalDeleteBtn">Eliminar</button>
        <button type="button" id="txRowModalCancelBtn" class="cancelButton">Cancelar</button>
        <button type="button" id="txRowModalSaveBtn" class="primaryButton" data-no-autohide="true">Guardar</button>
    `

    footer.querySelector("#txRowModalSaveBtn").addEventListener("click", saveTransaccionRowFromModal)
    footer.querySelector("#txRowModalCancelBtn").addEventListener("click", closeTransaccionRowModal)

    footer.querySelector("#txRowModalDeleteBtn").addEventListener("click", () => {
        openConfirmModal({
            title: "Eliminar fila",
            message: "¿Quieres eliminar esta transacción?",
            confirmLabel: "Eliminar",
            onConfirm: () => {
                currentTransaccionesData.rows = (currentTransaccionesData.rows || []).filter((r) => r.id !== rowId)
                renderTransaccionesTable()
                scheduleTransaccionesAutosave()
            }
        })
        closeTransaccionRowModal()
    })

    modal.appendChild(titleEl)
    modal.appendChild(fields)
    modal.appendChild(footer)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
}

// Gráfico de la moneda seleccionada: no se mezclan monedas porque las cantidades
// van en unidades, así que hace falta tener una sola cripto en el filtro. Sin
// wallet indicada, lo recibido viene de «Externa» y lo enviado va a «Externa»;
// el resto queda como «Sin indicar».
function abrirGrafoTransacciones() {
    const asset = transaccionesFilter?.size === 1 ? getTransaccionAsset([...transaccionesFilter][0]) : null
    if (!asset) {
        openConfirmModal({
            title: "Ver movimientos en gráfico",
            message: "Deja seleccionada una sola cripto en los filtros para ver el gráfico de sus movimientos.",
            confirmLabel: "OK"
        })
        return
    }
    const simbolo = String(asset.symbol || asset.name || "").trim()
    const filas = getVisibleTransaccionesRows()
    const sinOrigen = filas.some(
        (row) => !String(row.walletDesde || "").trim() && normalizeTransaccionWalletTipo(row.walletTipo) !== "recibida"
    )
    const movimientos = filas.map((row) => {
        const tipo = normalizeTransaccionWalletTipo(row.walletTipo)
        const origen = String(row.walletDesde || "").trim() || (tipo === "recibida" ? "Externa" : "Sin indicar")
        const destino = String(row.walletDestino || "").trim() || (tipo === "enviada" ? "Externa" : "Sin indicar")
        return { origen, destino, cantidad: parseLooseNumber(row.total) ?? 0 }
    })
    abrirGrafoFlujos({
        titulo: `Movimientos de ${asset.name || simbolo}`,
        subtitulo: sinOrigen
            ? "Hay transacciones sin wallet de origen: salen de «Sin indicar». Edítalas para que salgan de su wallet."
            : `${filas.length} transacción${filas.length === 1 ? "" : "es"}`,
        movimientos,
        formato: (n) =>
            `${n.toLocaleString("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: 8 })} ${simbolo}`.trim(),
        vacio: `No hay transacciones de ${asset.name || simbolo} entre dos wallets distintas.`
    })
}

function closeTransaccionRowModal() {
    document.getElementById("transaccionRowModalOverlay")?.remove()
}

function saveTransaccionRowFromModal() {
    const overlay = document.getElementById("transaccionRowModalOverlay")
    const rowId = overlay?.dataset.rowId || ""
    const rowIndex = (currentTransaccionesData.rows || []).findIndex((r) => r.id === rowId)
    if (rowIndex < 0) return
    const g = (id) => document.getElementById(id)?.value ?? ""
    const selectedAsset = getTransaccionAsset(g("txModalAsset"))

    const rowData = {
        id: rowId,
        assetId: selectedAsset?.id || "",
        assetName: selectedAsset?.name || "",
        fechaOperacion: g("txModalFecha"),
        total: g("txModalTotal"),
        comisionRed: g("txModalComision"),
        walletTipo: normalizeTransaccionWalletTipo(g("txModalWalletTipo")),
        walletDesde: g("txModalWalletDesde").trim(),
        walletDestino: g("txModalWalletDestino"),
        hashTransaccion: normalizeHashTransaccionValue(g("txModalHash")),
        nota: g("txModalNota")
    }

    currentTransaccionesData.rows[rowIndex] = rowData

    renderTransaccionesAssetMenu()
    renderTransaccionesTable()
    scheduleTransaccionesAutosave()
    closeTransaccionRowModal()
}
