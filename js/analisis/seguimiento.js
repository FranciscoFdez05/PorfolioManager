const AV_SEG_TYPE_COLORS = {
    cripto: "#f7931a",
    acciones: "#3a7bd5",
    etfs: "#2ecc71",
    comoditis: "#e0c068",
    indices: "#e8618c"
}
const AV_SEG_TYPE_LABELS = {
    cripto: "Cripto",
    acciones: "Acciones",
    etfs: "ETFs",
    comoditis: "Comoditis",
    indices: "Índices"
}

// Orígenes de la watchlist: se ve uno cada vez, el primero por defecto.
// «seguimiento» es la lista que elige el usuario (activos del portfolio y nuevos)
// y «wallets», la cripto de sus wallets.
const SEG_SOURCES = ["portfolio", "operaciones", "nuevos", "seguimiento", "wallets"]

// «Añadir activo» da de alta lo que lista la pestaña abierta. Operaciones y
// Wallets salen de otras pantallas: ahí el botón se desactiva y dice dónde ir.
const SEG_ALTA_POR_FUENTE = { portfolio: "activo", nuevos: "nuevo", seguimiento: "elegir" }
const SEG_ALTA_EN_OTRA_PANTALLA = {
    operaciones: "Las operaciones se añaden en Cripto › Operaciones",
    wallets: "Las wallets se añaden en Cripto › Seguimiento"
}

/**
 * Qué abre «Añadir activo» en una pestaña de la Watchlist.
 *
 * @param {string} fuente Pestaña (`SEG_SOURCES`).
 * @returns {{alta: string|null, aviso: string}} `alta` es "activo" (alta en el
 *     portfolio), "nuevo" (activo nuevo de Seguimiento), "elegir" (el selector)
 *     o null si en esa pestaña no se añade nada; `aviso`, el porqué.
 */
function segAltaDeFuente(fuente) {
    return { alta: SEG_ALTA_POR_FUENTE[fuente] || null, aviso: SEG_ALTA_EN_OTRA_PANTALLA[fuente] || "" }
}

/**
 * Activa o desactiva «Añadir activo» según la pestaña abierta.
 *
 * @param {HTMLButtonElement|null} boton El botón de la Watchlist.
 */
function segSyncAddBtn(boton) {
    if (!boton) return
    const { alta, aviso } = segAltaDeFuente(_segFilterSrc)
    boton.disabled = !alta
    boton.title = aviso
}

// Un activo creado desde la pestaña Portfolio tiene que salir en ella sin recargar.
window.addEventListener("app:activo-creado", async () => {
    if (!document.getElementById("seguimientoAddBtn")) return
    try {
        const resp = await fetch("/api/activos")
        if (!resp.ok) return
        const data = await resp.json()
        segMergeAndRender(data.assets || data || [])
    } catch (error) {
        console.error("Watchlist: no se pudo recargar la lista de activos", error)
    }
})

let _segAllItems = []
let _segFilterType = "all"
let _segFilterSrc = SEG_SOURCES[0]
let _segSearch = ""
let _segViewMode = localStorage.getItem("whitelistViewMode") || "cards"

function _segPid() {
    return window._activePortfolioId || "default"
}

// Lista propia, ocultos y símbolos retocados son datos del portfolio: viven en sus
// preferencias del servidor, que es lo que entra en las copias de seguridad, y
// aquí solo hay una copia en memoria que carga loadGlobalSettings.
function _segDatos() {
    if (!window._seguimientoDatos) window._seguimientoDatos = { lista: [], ocultos: [], overrides: {}, orden: [] }
    return window._seguimientoDatos
}

let _segGuardadoEnCola = Promise.resolve()
let _segDatosSustituidos = false

// Tras restaurar, lo que hay en memoria ya no es lo de la base y no debe volver a ella.
window.addEventListener("app:datos-restaurados", () => {
    _segDatosSustituidos = true
})

// En cola: dos cambios seguidos no pueden llegar al servidor en orden inverso.
function _segGuardar(campos) {
    if (_segDatosSustituidos) return
    _segGuardadoEnCola = _segGuardadoEnCola
        .then(async () => {
            const res = await fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(campos)
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
        })
        .catch((error) => {
            console.error("Error al guardar el seguimiento:", error)
            window.showToast?.("No se ha podido guardar el seguimiento", { type: "error" })
        })
}

// Agrupa por portfolio las claves `seguimiento*` que quedan en este navegador. Las
// de antes de separar por portfolio (sin sufijo o con "default") van al activo.
function segAgruparLocal(entradas, pidActivo) {
    const CAMPOS = { List: "seguimientoLista", Hidden: "seguimientoOcultos", Overrides: "seguimientoOverrides" }
    const portfolios = {}
    const claves = {}
    entradas.forEach(([clave, crudo]) => {
        const coincide = /^seguimiento(List|Hidden|Overrides)(?:_(.+))?$/.exec(clave)
        if (!coincide) return
        const pid = !coincide[2] || coincide[2] === "default" ? pidActivo : coincide[2]
        let valor
        try {
            valor = JSON.parse(crudo)
        } catch {
            // Ilegible: no hay nada que subir, y borrarlo no arregla nada.
            return
        }
        portfolios[pid] = portfolios[pid] || {}
        const campo = CAMPOS[coincide[1]]
        if (coincide[1] === "Overrides") {
            portfolios[pid][campo] = { ...valor, ...(portfolios[pid][campo] || {}) }
        } else {
            portfolios[pid][campo] = [...(portfolios[pid][campo] || []), ...(Array.isArray(valor) ? valor : [])]
        }
        claves[pid] = [...(claves[pid] || []), clave]
    })
    return { portfolios, claves }
}

// Sube al servidor lo que aún esté en el navegador y solo entonces lo borra de él:
// si falla, se reintenta en la siguiente carga y no se ha perdido nada.
async function segMigrarAlServidor(pidActivo) {
    let entradas
    try {
        entradas = Object.keys(localStorage).map((clave) => [clave, localStorage.getItem(clave)])
    } catch {
        return
    }
    const { portfolios, claves } = segAgruparLocal(entradas, pidActivo)
    if (!Object.keys(portfolios).length) return
    try {
        const res = await fetch("/api/settings/seguimiento/migrar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ portfolios })
        })
        const data = await res.json()
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
        data.migrados.forEach((pid) => (claves[pid] || []).forEach((clave) => localStorage.removeItem(clave)))
        window._seguimientoDatos = {
            lista: data.seguimientoLista,
            ocultos: data.seguimientoOcultos,
            overrides: data.seguimientoOverrides,
            orden: data.seguimientoOrden ?? []
        }
    } catch (error) {
        console.error("Error al migrar el seguimiento al servidor:", error)
    }
}
window.segMigrarAlServidor = segMigrarAlServidor

// Copia: quien la pide la modifica antes de guardarla, y no debe tocar la de memoria.
function segLoadCustomItems() {
    return JSON.parse(JSON.stringify(_segDatos().lista))
}
function segSaveCustomItems(items) {
    _segDatos().lista = items
    _segGuardar({ seguimientoLista: items })
}

function segFilteredItems() {
    return _segAllItems.filter((item) => {
        const matchType = _segFilterType === "all" || _segFilterType.includes(item.type)
        const matchSrc =
            (_segFilterSrc === "portfolio" && item._fromPortfolio && !item._isWatchOnly) ||
            (_segFilterSrc === "operaciones" && item._fromOperaciones) ||
            (_segFilterSrc === "nuevos" &&
                !item._fromWallets &&
                !item._refActivo &&
                ((!item._fromPortfolio && !item._fromOperaciones) || item._isWatchOnly)) ||
            (_segFilterSrc === "seguimiento" && item._seguido) ||
            (_segFilterSrc === "wallets" && item._fromWallets)
        const q = _segSearch.toLowerCase()
        const matchSearch =
            !q ||
            (item.name || "").toLowerCase().includes(q) ||
            (item.symbol || "").toLowerCase().includes(q) ||
            (item.ticker || "").toLowerCase().includes(q)
        return matchType && matchSrc && matchSearch
    })
}

function segOrigenTexto(item) {
    if (item._fromWallets) return item.sospechoso ? "Wallets · sospechoso" : "Wallets"
    if (item._refActivo) return "Portfolio"
    return item._fromPortfolio && !item._isWatchOnly ? "Portfolio" : "Nuevo"
}

// formatMoney redondea a 2 decimales: una memecoin saldría a 0,00.
function segFormatoPrecio(valor, currency) {
    if (valor === 0 || Math.abs(valor) >= 0.01) return formatMoney(valor, currency)
    const numero = new Intl.NumberFormat(_nl(), { maximumSignificantDigits: 4 }).format(valor)
    return `${numero} ${currencySuffix(currency)}`
}

function segBuildCard(item) {
    const color = AV_SEG_TYPE_COLORS[item.type] || "#888"
    const typeLabel = AV_SEG_TYPE_LABELS[item.type] || item.type || ""
    const price = parseLooseNumber(item.price || "") || 0
    const currency = item.currency || "EUR"
    const provider = String(item.marketProvider || "").toUpperCase()
    const ticker = item.marketSymbol || item.finnhubSymbol || item.ticker || ""

    const changePctStr = String(item.change || "").trim()
    const changePct = parseLooseNumber(changePctStr.replace(/%/g, "")) || 0
    const changeAbs = price > 0 ? Math.abs((price * changePct) / 100) : 0
    const changeSign = changePct < 0 ? "−" : changePct > 0 ? "+" : ""
    const changeClass = changePct < 0 ? "avNeg" : changePct > 0 ? "avPos" : ""
    const changeMoneyStr = changePctStr ? `${changeSign}${segFormatoPrecio(changeAbs, currency)}` : "—"
    const changePctDisp = changePctStr || "—"

    let lastUpdatedStr = "—"
    if (item.lastUpdated) {
        const d = new Date(item.lastUpdated)
        if (!isNaN(d)) {
            const hh = String(d.getHours()).padStart(2, "0")
            const mm = String(d.getMinutes()).padStart(2, "0")
            const dd = String(d.getDate()).padStart(2, "0")
            const mo = String(d.getMonth() + 1).padStart(2, "0")
            lastUpdatedStr = `${dd}/${mo} ${hh}:${mm}`
        }
    }

    const sid = escapeHtml(item._segId || "")
    const hideOrDeleteItem = item._refActivo
        ? segQuitarSeguidoHtml(sid)
        : item._isWatchOnly
          ? `<button type="button" class="rowMenuItem rowMenuItemDanger avActionBtn avDeleteBtn segWatchDeleteBtn" data-seg-id="${sid}">Eliminar</button>`
          : item._fromPortfolio || item._fromOperaciones
            ? `<button type="button" class="rowMenuItem avActionBtn segHideBtn" data-seg-id="${sid}">Ocultar</button>`
            : `<button type="button" class="rowMenuItem rowMenuItemDanger avActionBtn avDeleteBtn segRemoveBtn" data-seg-id="${sid}">Eliminar</button>`
    // Lo de las wallets se gestiona en Cripto › Seguimiento: aquí solo se le pone ticker, no se edita ni se quita.
    const actionBtns = item._fromWallets
        ? segWalletMenuHtml(item)
        : `
        <div class="rowMenu">
            <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
            <div class="rowMenuDropdown">
                ${item._refActivo ? "" : `<button type="button" class="rowMenuItem avActionBtn avEditBtn segEditBtn" data-seg-id="${sid}">Editar</button><hr>`}
                ${hideOrDeleteItem}
            </div>
        </div>`

    const card = document.createElement("div")
    card.className = "avCard"
    card.dataset.segId = item._segId || item.id || ""

    card.innerHTML = `
        <div class="avCardTop">
            <span class="avBadge" style="background:${color}22;color:${color};border-color:${color}44">${escapeHtml(typeLabel)}</span>
            <div class="avCardActions">${actionBtns}</div>
        </div>
        <div class="avCardSymbol">${escapeHtml(item.symbol || item.name || "")}</div>
        <div class="avCardName">${escapeHtml(item.name || item.symbol || "Activo")}</div>
        <div class="avCardPrice">${price > 0 ? segFormatoPrecio(price, currency) : "—"}</div>
        <div class="avCardTicker">${escapeHtml(provider || ticker || (item._fromPortfolio || item._fromWallets ? "Sin ticker" : "Sin datos en vivo"))}</div>
        <div class="avCardMetrics">
            <div class="avMetricItem">
                <span class="avMetricLabel">Cambio día</span>
                <span class="avMetricValue ${changeClass}">${changeMoneyStr}</span>
            </div>
            <div class="avMetricItem">
                <span class="avMetricLabel">Cambio %</span>
                <span class="avMetricValue ${changeClass}">${changePctDisp}</span>
            </div>
            <div class="avMetricItem">
                <span class="avMetricLabel">Ticker</span>
                <span class="avMetricValue">${escapeHtml(ticker || "—")}</span>
            </div>
            <div class="avMetricItem">
                <span class="avMetricLabel">Origen</span>
                <span class="avMetricValue">${segOrigenTexto(item)}</span>
            </div>
        </div>
        <div class="avCardUpdated">Actualizado: ${lastUpdatedStr}</div>
        <div class="avCardBar" style="background:${color}"></div>
    `

    return card
}

function segRenderTable(filtered) {
    const tbody = document.getElementById("seguimientoTableBody")
    const tableEmptyEl = document.getElementById("seguimientoTableEmpty")
    const tableWrap = document.getElementById("seguimientoTableWrap")
    if (!tbody) return

    tbody.innerHTML = ""

    if (!filtered.length) {
        if (tableWrap) tableWrap.classList.add("hidden")
        if (tableEmptyEl) tableEmptyEl.classList.remove("hidden")
        return
    }

    if (tableWrap) tableWrap.classList.remove("hidden")
    if (tableEmptyEl) tableEmptyEl.classList.add("hidden")
    function buildTableRow(item) {
        const rank = filtered.indexOf(item) + 1
        const color = AV_SEG_TYPE_COLORS[item.type] || "#888"
        const typeLabel = AV_SEG_TYPE_LABELS[item.type] || item.type || ""
        const price = parseLooseNumber(item.price || "") || 0
        const currency = item.currency || "EUR"
        const provider = String(item.marketProvider || "").toUpperCase()
        const ticker = item.marketSymbol || item.finnhubSymbol || item.ticker || "—"
        const changePctStr = String(item.change || "").trim()
        const changePct = parseLooseNumber(changePctStr.replace(/%/g, "")) || 0
        const changeAbs = price > 0 ? Math.abs((price * changePct) / 100) : 0
        const changeSign = changePct < 0 ? "−" : changePct > 0 ? "+" : ""
        const changeClass = changePct < 0 ? "avNeg" : changePct > 0 ? "avPos" : ""
        const changeMoneyStr = changePctStr ? `${changeSign}${segFormatoPrecio(changeAbs, currency)}` : "—"
        const changePctDisp = changePctStr || "—"
        const tsid = escapeHtml(item._segId || "")
        const tHideOrDelItem = item._refActivo
            ? segQuitarSeguidoHtml(tsid)
            : item._isWatchOnly
              ? `<button class="rowMenuItem rowMenuItemDanger avActionBtn avDeleteBtn segWatchDeleteBtn" data-seg-id="${tsid}">Eliminar</button>`
              : item._fromPortfolio || item._fromOperaciones
                ? `<button class="rowMenuItem avActionBtn segHideBtn" data-seg-id="${tsid}">Ocultar</button>`
                : `<button class="rowMenuItem rowMenuItemDanger avActionBtn avDeleteBtn segRemoveBtn" data-seg-id="${tsid}">Eliminar</button>`
        const removeCell = item._fromWallets
            ? segWalletMenuHtml(item)
            : `
            <div class="rowMenu">
                <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                <div class="rowMenuDropdown">
                    ${item._refActivo ? "" : `<button class="rowMenuItem avActionBtn avEditBtn segEditBtn" data-seg-id="${tsid}">Editar</button><hr>`}
                    ${tHideOrDelItem}
                </div>
            </div>`
        return `<tr class="avTableRow" data-seg-id="${escapeHtml(item._segId || "")}">
            <td class="mTdRank">${rank}</td>
            <td><span class="avBadge" style="background:${color}22;color:${color};border-color:${color}44">${escapeHtml(typeLabel)}</span></td>
            <td class="avTrName">${escapeHtml(item.name || item.symbol || "—")}</td>
            <td class="avTrProvider">${escapeHtml(ticker)}</td>
            <td class="avTrPrice">${price > 0 ? segFormatoPrecio(price, currency) : "—"}</td>
            <td class="avTrRend ${changeClass}">${changeMoneyStr}</td>
            <td class="avTrRend ${changeClass}">${changePctDisp}</td>
            <td class="avTrProvider">${escapeHtml(provider || "—")}</td>
            <td class="avTrActions">${removeCell}</td>
        </tr>`
    }

    const portfolioGroup = filtered.filter((i) => (i._fromPortfolio && !i._isWatchOnly) || i._fromOperaciones)
    const customGroup = filtered.filter((i) => (!i._fromPortfolio && !i._fromOperaciones) || i._isWatchOnly)
    const showSections = portfolioGroup.length > 0 && customGroup.length > 0

    if (showSections) {
        const colSpan = 9
        tbody.innerHTML =
            `<tr class="segTableSectionRow"><td colspan="${colSpan}" class="segTableSectionHeader">Portfolio &amp; Operaciones</td></tr>` +
            portfolioGroup.map(buildTableRow).join("") +
            `<tr class="segTableSectionRow"><td colspan="${colSpan}" class="segTableSectionHeader">Lista de seguimiento</td></tr>` +
            customGroup.map(buildTableRow).join("")
    } else {
        tbody.innerHTML = filtered.map(buildTableRow).join("")
    }

    tbody.querySelectorAll(".segHideBtn").forEach((btn) => {
        btn.addEventListener("click", () => segHideItem(btn.dataset.segId))
    })
    tbody.querySelectorAll(".segRemoveBtn").forEach((btn) => {
        btn.addEventListener("click", () => segRemoveItem(btn.dataset.segId))
    })
    tbody.querySelectorAll(".segWatchDeleteBtn").forEach((btn) => {
        btn.addEventListener("click", () => segDeleteWatchAsset(btn.dataset.segId))
    })

    tbody.querySelectorAll(".segEditBtn").forEach((btn) => {
        btn.addEventListener("click", () => segOpenEditModal(btn.dataset.segId))
    })
    segWireWalletMenu(tbody)

    tbody.querySelectorAll(".avTableRow").forEach((row) => {
        row.addEventListener("click", (e) => {
            if (e.target.closest(".avTrActions")) return
            const segId = row.dataset.segId
            const item = _segAllItems.find((i) => i._segId === segId)
            if (!item) return
            const tvSym =
                typeof buildTVSymbol === "function"
                    ? buildTVSymbol(item)
                    : item.tvSymbol || item.marketSymbol || item.ticker || ""
            if (tvSym && typeof openTVChartModal === "function") openTVChartModal(tvSym, item.name || item.symbol)
        })
    })
    const t = tbody.closest("table")
    bindTableSort(t, "seguimientoTableOrder")
    if (t._reSort) t._reSort()
}

function segLoadHidden() {
    return new Set(_segDatos().ocultos)
}
function segSaveHidden(set) {
    _segDatos().ocultos = [...set]
    _segGuardar({ seguimientoOcultos: [...set] })
}

function segHideItem(segId) {
    if (!segId.startsWith("portfolio_")) return
    const hidden = segLoadHidden()
    hidden.add(segId)
    segSaveHidden(hidden)
    segMergeAndRender(window._segPortfolioAssets || [])
    segUpdateHiddenBtn()
}

function segUnhideItem(segId) {
    const hidden = segLoadHidden()
    hidden.delete(segId)
    segSaveHidden(hidden)
    segMergeAndRender(window._segPortfolioAssets || [])
    segUpdateHiddenBtn()
}

function segUpdateHiddenBtn() {
    const btn = document.getElementById("segHiddenBtn")
    const badge = document.getElementById("segHiddenCount")
    if (!btn) return
    const hidden = segLoadHidden()
    const count = [...hidden].filter((id) => id.startsWith("portfolio_")).length
    btn.style.display = ""
    if (badge) {
        badge.textContent = count
        badge.classList.toggle("hidden", count === 0)
    }
}

function segOpenHiddenModal() {
    const overlay = document.getElementById("segHiddenModalOverlay")
    const list = document.getElementById("segHiddenList")
    if (!overlay || !list) return

    const hidden = segLoadHidden()
    const hiddenIds = [...hidden].filter((id) => id.startsWith("portfolio_"))
    const assets = window._segPortfolioAssets || []

    if (hiddenIds.length === 0) {
        list.innerHTML = `<p style="color:var(--text-secondary);font-size:0.9em;text-align:center;padding:16px 0">No hay activos ocultos.</p>`
    } else {
        list.innerHTML = hiddenIds
            .map((segId) => {
                const assetId = segId.replace("portfolio_", "")
                const asset = assets.find((a) => a.id === assetId)
                const name = asset?.name || assetId
                const type = asset?.type || ""
                const color = AV_SEG_TYPE_COLORS[type] || "#888"
                const label = AV_SEG_TYPE_LABELS[type] || type
                return `<div class="segHiddenItem" data-seg-id="${escapeHtml(segId)}">
                <span class="avBadge" style="background:${color}22;color:${color};border-color:${color}44;font-size:0.75em">${escapeHtml(label)}</span>
                <span class="segHiddenItemName">${escapeHtml(name)}</span>
                <button class="primaryButton segUnhideBtn" data-seg-id="${escapeHtml(segId)}" type="button" style="margin-left:auto;padding:4px 12px;font-size:0.82em">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>Mostrar
                </button>
            </div>`
            })
            .join("")

        list.querySelectorAll(".segUnhideBtn").forEach((btn) => {
            btn.addEventListener("click", () => {
                segUnhideItem(btn.dataset.segId)
                segOpenHiddenModal()
            })
        })
    }

    overlay.classList.remove("hidden")
}

// Un activo del portfolio en Seguimiento no se edita aquí (se edita en Activos):
// su menú solo ofrece sacarlo de la lista.
function segQuitarSeguidoHtml(sid) {
    return `<button type="button" class="rowMenuItem avActionBtn segRemoveBtn" data-seg-id="${sid}">Quitar de Seguimiento</button>`
}

function segQuitarDeLista(segId) {
    segSaveCustomItems(segLoadCustomItems().filter((c) => c._segId !== segId))
    segMergeAndRender(window._segPortfolioAssets || [])
}

function segRemoveItem(segId) {
    if (segId.startsWith("portfolio_") || segId.startsWith("operacion_")) return

    const item = _segAllItems.find((i) => i._segId === segId)
    // Sacar un activo del portfolio de Seguimiento no lo borra: se deshace
    // volviendo a añadirlo, así que no se pide escribir su nombre.
    if (item?._refActivo) {
        segQuitarDeLista(segId)
        return
    }
    const itemName = item?.name || item?.symbol || segId

    openConfirmModal({
        title: "Eliminar activo",
        message: `Vas a eliminar "${itemName}" de la watchlist. Esto no se puede deshacer.`,
        confirmLabel: "Eliminar",
        confirmSide: "right",
        requireText: itemName,
        onConfirm: () => segQuitarDeLista(segId)
    })
}

async function segDeleteWatchAsset(segId) {
    const item = _segAllItems.find((i) => i._segId === segId)
    const itemName = item?.name || item?.symbol || segId
    const assetId = segId.startsWith("portfolio_") ? segId.slice("portfolio_".length) : segId

    openConfirmModal({
        title: "Eliminar activo",
        message: `Vas a eliminar "${itemName}" del portfolio y de la watchlist: sus compras, operaciones y planes se borran con él. Esto no se puede deshacer.`,
        confirmLabel: "Eliminar",
        confirmSide: "right",
        requireText: itemName,
        onConfirm: async () => {
            try {
                const resp = await fetch(`/api/activos/${encodeURIComponent(assetId)}`, { method: "DELETE" })
                if (!resp.ok) throw new Error(await resp.text())
                if (typeof refreshAssetsSidebar === "function") await refreshAssetsSidebar()
                segMergeAndRender((window._segPortfolioAssets || []).filter((a) => String(a.id) !== String(assetId)))
            } catch (e) {
                alert(`Error al eliminar: ${e.message}`)
            }
        }
    })
}

function segRenderGrid() {
    const grid = document.getElementById("seguimientoGrid")
    const tableWrap = document.getElementById("seguimientoTableWrap")
    const count = document.getElementById("seguimientoCount")
    if (!grid) return

    const filtered = segFilteredItems()
    if (count) count.textContent = `${filtered.length} activo${filtered.length !== 1 ? "s" : ""}`

    if (_segViewMode === "table") {
        grid.classList.add("hidden")
        tableWrap?.classList.remove("hidden")
        segRenderTable(filtered)
        return
    }

    grid.classList.remove("hidden")
    tableWrap?.classList.add("hidden")
    const tableEmptyEl = document.getElementById("seguimientoTableEmpty")
    if (tableEmptyEl) tableEmptyEl.classList.add("hidden")
    const gridEmptyEl = document.getElementById("seguimientoGridEmpty")

    grid.innerHTML = ""

    if (filtered.length === 0) {
        if (gridEmptyEl) gridEmptyEl.classList.remove("hidden")
        return
    }

    if (gridEmptyEl) gridEmptyEl.classList.add("hidden")

    function wireCard(card, item) {
        card.querySelectorAll(".segHideBtn").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation()
                segHideItem(btn.dataset.segId)
            })
        })
        card.querySelectorAll(".segRemoveBtn").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation()
                segRemoveItem(btn.dataset.segId)
            })
        })
        card.querySelectorAll(".segWatchDeleteBtn").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation()
                segDeleteWatchAsset(btn.dataset.segId)
            })
        })
        card.querySelectorAll(".segEditBtn").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation()
                segOpenEditModal(btn.dataset.segId)
            })
        })
        segWireWalletMenu(card)
        card.draggable = true
        card.addEventListener("click", (e) => {
            if (e.target.closest(".segRemoveBtn") || e.target.closest(".segEditBtn") || e.target.closest(".rowMenu"))
                return
            const tvSym =
                typeof buildTVSymbol === "function"
                    ? buildTVSymbol(item)
                    : item.tvSymbol || item.marketSymbol || item.ticker || ""
            if (tvSym && typeof openTVChartModal === "function") openTVChartModal(tvSym, item.name || item.symbol)
        })
        return card
    }

    const portfolioGroup = filtered.filter((i) => (i._fromPortfolio && !i._isWatchOnly) || i._fromOperaciones)
    const customGroup = filtered.filter((i) => (!i._fromPortfolio && !i._fromOperaciones) || i._isWatchOnly)
    const showSections = portfolioGroup.length > 0 && customGroup.length > 0

    if (showSections) {
        const hPort = document.createElement("div")
        hPort.className = "segSectionHeader"
        hPort.textContent = "Portfolio & Operaciones"
        grid.appendChild(hPort)
        portfolioGroup.forEach((item) => grid.appendChild(wireCard(segBuildCard(item), item)))

        const hCustom = document.createElement("div")
        hCustom.className = "segSectionHeader"
        hCustom.textContent = "Lista de seguimiento"
        grid.appendChild(hCustom)
        customGroup.forEach((item) => grid.appendChild(wireCard(segBuildCard(item), item)))
    } else {
        filtered.forEach((item) => grid.appendChild(wireCard(segBuildCard(item), item)))
    }
    segInitDragDrop(grid)
}

/**
 * Ordena los elementos según el orden guardado al arrastrar las tarjetas.
 *
 * Lo que no está en el orden (activos nuevos, o todo si nunca se ha arrastrado)
 * va detrás, en el orden de siempre: el sort es estable.
 *
 * @param {Array<object>} items Elementos con `_segId`.
 * @param {Array<string>} orden `_segId` en el orden elegido.
 * @returns {Array<object>} Copia ordenada.
 */
function segAplicarOrden(items, orden) {
    const posicion = new Map((orden || []).map((segId, indice) => [segId, indice]))
    const clave = (item) => posicion.get(item._segId) ?? Infinity
    return [...items].sort((a, b) => clave(a) - clave(b))
}

/**
 * Lleva el orden de las tarjetas visibles al orden completo.
 *
 * Con un filtro activo solo se ve una parte: las visibles se reparten, en su
 * nuevo orden, por los huecos que ya ocupaban, y las demás no se mueven.
 *
 * @param {Array<string>} ordenCompleto `_segId` de todos los elementos, en el orden actual.
 * @param {Array<string>} visibles `_segId` de las tarjetas visibles, en el orden del DOM.
 * @returns {Array<string>} El orden completo nuevo.
 * @example
 * segFusionarOrden(["a", "b", "c", "d"], ["d", "b"]) // ["a", "d", "c", "b"]
 */
function segFusionarOrden(ordenCompleto, visibles) {
    const enVista = new Set(visibles)
    const cola = visibles.filter((segId) => ordenCompleto.includes(segId))
    return ordenCompleto.map((segId) => (enVista.has(segId) ? cola.shift() : segId))
}

// Tarjeta delante de la que se suelta la arrastrada (null = al final), como en Activos.
function segFindDropReference(grid, dragged, pointerX, pointerY) {
    const cards = [...grid.querySelectorAll(".avCard")].filter((card) => card !== dragged && card.dataset.segId)
    for (const card of cards) {
        const rect = card.getBoundingClientRect()
        if (pointerY > rect.bottom) continue
        if (pointerY < rect.top || pointerX < rect.left + rect.width / 2) return card
    }
    return null
}

function segGuardarOrdenDesdeDom(grid) {
    const visibles = [...grid.querySelectorAll(".avCard")].map((card) => card.dataset.segId).filter(Boolean)
    const orden = segFusionarOrden(
        _segAllItems.map((item) => item._segId),
        visibles
    )
    _segDatos().orden = orden
    _segGuardar({ seguimientoOrden: orden })
    _segAllItems = segAplicarOrden(_segAllItems, orden)
}

// Arrastrar tarjetas para reordenarlas, con la misma mecánica que la cuadrícula de Activos.
function segInitDragDrop(grid) {
    if (grid.dataset.dragBound === "true") return
    grid.dataset.dragBound = "true"

    let arrastradaId = null
    let soltada = false

    grid.addEventListener("dragstart", (e) => {
        const card = e.target.closest(".avCard")
        if (!card?.dataset.segId) return
        arrastradaId = card.dataset.segId
        soltada = false
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move"
            e.dataTransfer.setData("text/plain", arrastradaId)
        }
        // El estilo de hueco va después de que el navegador genere la imagen de arrastre.
        requestAnimationFrame(() => card.classList.add("avDragging"))
    })

    grid.addEventListener("dragend", () => {
        grid.querySelector(".avCard.avDragging")?.classList.remove("avDragging")
        arrastradaId = null
        // Cancelado: se vuelve al orden real.
        if (!soltada) segRenderGrid()
        soltada = false
    })

    grid.addEventListener("dragover", (e) => {
        const dragged = grid.querySelector(".avCard.avDragging")
        if (!arrastradaId || !dragged) return
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
        moveDraggedAssetPreview(grid, dragged, segFindDropReference(grid, dragged, e.clientX, e.clientY))
    })

    grid.addEventListener("drop", (e) => {
        if (!arrastradaId || !grid.querySelector(".avCard.avDragging")) return
        e.preventDefault()
        soltada = true
        segGuardarOrdenDesdeDom(grid)
        segRenderGrid()
    })
}

/**
 * Entrada de Seguimiento que apunta a un activo del portfolio, con sus datos al día.
 *
 * Se guarda solo el id (`assetId`): el precio, el ticker y el nombre salen del
 * activo cada vez, igual que en la pestaña Portfolio, con los retoques de ticker
 * que tenga ese activo.
 *
 * @param {object} entrada Entrada de la lista con `_segId` y `assetId`.
 * @param {Array<object>} portfolioAssets Activos del portfolio.
 * @param {object} overrides Retoques por `portfolio_<id>`.
 * @returns {object|null} El elemento, o null si el activo ya no existe.
 */
function segItemReferencia(entrada, portfolioAssets, overrides) {
    const asset = portfolioAssets.find((a) => String(a.id) === String(entrada.assetId))
    if (!asset) return null
    const ov = overrides[`portfolio_${asset.id}`] || {}
    return {
        ...asset,
        _segId: entrada._segId,
        _seguido: true,
        _refActivo: true,
        // No cuenta como de Portfolio ni de Operaciones: ya sale en esas pestañas por su cuenta.
        _fromPortfolio: false,
        _fromOperaciones: false,
        _isWatchOnly: false,
        tvSymbol: ov.tvSymbol ?? (asset.tvSymbol || ""),
        marketProvider: ov.marketProvider ?? (asset.marketProvider || ""),
        marketSymbol: ov.ticker ?? (asset.marketSymbol || asset.finnhubSymbol || "")
    }
}

function segMergeAndRender(portfolioAssets) {
    window._segPortfolioAssets = portfolioAssets
    const customs = segLoadCustomItems()
    // La lista guarda los dos tipos de entrada: activos nuevos (nombre y ticker
    // propios) y referencias a activos del portfolio (solo `assetId`).
    const propios = customs.filter((c) => !c.assetId)
    const portfolioKeys = new Set([
        ...portfolioAssets.map((a) => (a.name || "").toLowerCase()).filter(Boolean),
        ...portfolioAssets.map((a) => (a.symbol || "").toLowerCase()).filter(Boolean)
    ])

    const customItems = propios
        .filter(
            (c) =>
                !portfolioKeys.has((c.nombre || "").toLowerCase()) && !portfolioKeys.has((c.ticker || "").toLowerCase())
        )
        .map((c) => ({
            _segId: c._segId,
            name: c.nombre,
            symbol: c.ticker || c.nombre,
            ticker: c.ticker || "",
            marketSymbol: c.ticker || "",
            marketProvider: c.marketProvider || "",
            tvSymbol: c.tvSymbol || "",
            type: c.tipo || "acciones",
            notas: c.notas || "",
            price: c.price || "",
            currency: c.currency || "EUR",
            change: c.change || "",
            lastUpdated: c.lastUpdated || null,
            _seguido: true,
            _fromPortfolio: false
        }))

    const hidden = segLoadHidden()
    const overrides = _segDatos().overrides

    const portfolioItems = portfolioAssets
        .filter((a) => !hidden.has(`portfolio_${a.id}`))
        .map((a) => {
            const segId = `portfolio_${a.id}`
            const ov = overrides[segId] || {}
            return {
                ...a,
                _segId: segId,
                _fromPortfolio: true,
                _isWatchOnly: !a.hasRows,
                tvSymbol: ov.tvSymbol ?? (a.tvSymbol || ""),
                marketProvider: ov.marketProvider ?? (a.marketProvider || ""),
                marketSymbol: ov.ticker ?? (a.marketSymbol || a.finnhubSymbol || "")
            }
        })

    const operacionesItems = (window._segOperacionesItems || []).filter((item) => !hidden.has(item._segId))

    // Seguimiento enseña la lista en el orden en que se fue añadiendo, mezclando
    // los dos tipos de entrada.
    const propiosPorId = new Map(customItems.map((item) => [item._segId, item]))
    const seguidos = customs
        .map((c) => (c.assetId ? segItemReferencia(c, portfolioAssets, overrides) : propiosPorId.get(c._segId)))
        .filter(Boolean)

    _segAllItems = segAplicarOrden(
        [...portfolioItems, ...operacionesItems, ...seguidos, ...(window._segWalletItems || [])],
        _segDatos().orden
    )
    segRenderGrid()
    segUpdateHiddenBtn()
}

async function segRefreshCustomPrices() {
    const customs = segLoadCustomItems()
    let updated = false
    for (const item of customs) {
        if (!item.ticker) continue
        try {
            const params = new URLSearchParams({ symbol: item.ticker })
            if (item.marketProvider) params.set("provider", item.marketProvider)
            const resp = await fetch(`/api/market/quote?${params}`)
            if (!resp.ok) continue
            const data = await resp.json()
            if (!data.ok || !data.price) continue
            item.price = String(data.price)
            item.change = String(data.change ?? "")
            item.currency = data.currency || "EUR"
            item.lastUpdated = data.lastUpdated || new Date().toISOString()
            updated = true
        } catch {
            /* ignore individual failures */
        }
    }
    if (updated) {
        segSaveCustomItems(customs)
        segMergeAndRender(window._segPortfolioAssets || [])
    }
}

// Lista «Seguimiento»: la cripto de las wallets (python/core/wallets_watchlist.py).
// Cada entrada se cotiza con el ticker puesto a mano en Cripto › Seguimiento o,
// si no tiene, con el activo de Activos que le corresponde.
async function segLoadWalletItems(portfolioAssets) {
    try {
        const resp = await fetch("/api/wallets/watchlist")
        if (!resp.ok) return []
        const data = await resp.json()
        return (data.entradas || []).map((entrada) => segWalletItem(entrada, portfolioAssets))
    } catch {
        // Sin wallets legibles la lista sale vacía; el resto de la watchlist no se resiente.
        return []
    }
}

function segWalletItem(entrada, portfolioAssets) {
    const base = {
        _segId: `wallet_${entrada.id}`,
        _fromWallets: true,
        _fromPortfolio: false,
        _fromOperaciones: false,
        _red: entrada.red,
        _redNombre: entrada.redNombre,
        _contrato: entrada.contrato,
        // Un mismo símbolo puede estar en dos redes: el token lleva la suya en el nombre.
        name: entrada.tipo === "token" ? `${entrada.nombre} · ${entrada.redNombre}` : entrada.nombre,
        symbol: entrada.simbolo,
        type: "cripto",
        sospechoso: Boolean(entrada.sospechoso),
        ticker: "",
        marketSymbol: "",
        marketProvider: "",
        tvSymbol: "",
        price: "",
        currency: "EUR",
        change: "",
        lastUpdated: null
    }
    if (entrada.ticker) {
        return {
            ...base,
            ticker: entrada.ticker,
            marketSymbol: entrada.ticker,
            marketProvider: entrada.proveedor,
            tvSymbol: entrada.proveedor === "tradingview" ? entrada.ticker : "",
            _quoteTicker: true
        }
    }
    const asset = entrada.assetId ? portfolioAssets.find((a) => String(a.id) === entrada.assetId) : null
    if (!asset) return base
    return {
        ...base,
        ticker: asset.marketSymbol || asset.finnhubSymbol || "",
        marketSymbol: asset.marketSymbol || asset.finnhubSymbol || "",
        marketProvider: asset.marketProvider || "",
        tvSymbol: asset.tvSymbol || "",
        price: String(asset.price || ""),
        currency: asset.currency || "EUR",
        change: String(asset.change || ""),
        lastUpdated: asset.lastUpdated || null
    }
}

// Solo las que tienen ticker propio: las asociadas a un activo ya traen su precio.
// En memoria, sin localStorage: se piden cada vez que se abre la watchlist.
async function segRefreshWalletPrices() {
    let updated = false
    for (const item of window._segWalletItems || []) {
        if (!item._quoteTicker) continue
        if (await segCotizarWalletItem(item)) updated = true
    }
    if (updated) segMergeAndRender(window._segPortfolioAssets || [])
}

// Devuelve si ha traído precio.
async function segCotizarWalletItem(item) {
    try {
        const params = new URLSearchParams({ symbol: item.ticker, provider: item.marketProvider })
        const resp = await fetch(`/api/market/quote?${params}`)
        if (!resp.ok) return false
        const data = await resp.json()
        if (!data.ok || !data.price) return false
        // Número, no texto: String(1e-7) da "1e-7", que parseLooseNumber no sabe leer.
        item.price = data.currentPrice ?? String(data.price)
        item.change = String(data.change ?? "")
        item.currency = data.currency || "EUR"
        item.lastUpdated = data.lastUpdated || new Date().toISOString()
        return true
    } catch {
        /* una cotización que falla deja el resto como está */
        return false
    }
}

// Menú ··· de una entrada de las wallets: solo el ticker con el que se cotiza.
function segWalletMenuHtml(item) {
    const sid = escapeHtml(item._segId)
    const quitar = item._quoteTicker
        ? `<button type="button" class="rowMenuItem avActionBtn segWalletTickerQuitarBtn" data-seg-id="${sid}">Quitar ticker de precio</button>`
        : ""
    return `
        <div class="rowMenu">
            <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
            <div class="rowMenuDropdown">
                <button type="button" class="rowMenuItem avActionBtn segWalletTickerBtn" data-seg-id="${sid}">${item._quoteTicker ? "Cambiar" : "Poner"} ticker de precio</button>
                ${quitar}
            </div>
        </div>`
}

function segWireWalletMenu(raiz) {
    raiz.querySelectorAll(".segWalletTickerBtn").forEach((btn) => {
        btn.addEventListener("click", () => segAbrirTickerWallet(btn.dataset.segId))
    })
    raiz.querySelectorAll(".segWalletTickerQuitarBtn").forEach((btn) => {
        btn.addEventListener("click", () => segQuitarTickerWallet(btn.dataset.segId))
    })
}

function segWalletItemPorId(segId) {
    return (window._segWalletItems || []).find((item) => item._segId === segId)
}

function segAbrirTickerWallet(segId) {
    const item = segWalletItemPorId(segId)
    if (!item) return
    abrirVentanaTicker({
        titulo: `Ticker de precio de ${item.symbol}`,
        texto: `${item._contrato ? `Contrato ${item._contrato}` : `Moneda de ${item._redNombre}`}. Con este ticker se cotiza en esta lista.`,
        simbolo: item.symbol,
        actual: item._quoteTicker ? { proveedor: item.marketProvider, ticker: item.ticker } : null,
        guardarTicker: (proveedor, ticker) =>
            segEnviarTickerWallet(item, "/api/wallets/tokens/precio", { proveedor, ticker })
    })
}

async function segQuitarTickerWallet(segId) {
    const item = segWalletItemPorId(segId)
    if (!item) return
    const error = await segEnviarTickerWallet(item, "/api/wallets/tokens/precio/quitar")
    if (error) showToast(error, { type: "error" })
}

// Devuelve el mensaje de error, o "" si se guardó.
async function segEnviarTickerWallet(item, url, datos = {}) {
    try {
        await walletsPost(url, { red: item._red, contrato: item._contrato, ...datos })
    } catch (error) {
        return error.message || "No se pudo guardar el ticker"
    }
    await segRecargarWalletItem(item._segId)
    return ""
}

// Solo la entrada que ha cambiado: volver a cotizar todas gastaría cuota de la
// API en cada cambio y dejaría los demás precios en blanco mientras tanto.
async function segRecargarWalletItem(segId) {
    const assets = window._segPortfolioAssets || []
    const nuevo = (await segLoadWalletItems(assets)).find((item) => item._segId === segId)
    if (!nuevo) return
    if (nuevo._quoteTicker) await segCotizarWalletItem(nuevo)
    window._segWalletItems = window._segWalletItems.map((item) => (item._segId === segId ? nuevo : item))
    segMergeAndRender(assets)
}

// El filtro guardado antes de ser de una sola opción era "all" o una lista.
/**
 * Añade a la lista referencias a activos del portfolio, sin repetir los que ya estén.
 *
 * @param {Array<object>} lista Lista actual (no se modifica).
 * @param {Array<string>} ids Ids de los activos elegidos, en el orden en que se añaden.
 * @param {Array<object>} portfolioAssets Activos del portfolio, para el nombre y el tipo.
 * @returns {Array<object>} La lista nueva.
 */
function segAnadirReferencias(lista, ids, portfolioAssets) {
    const yaSeguidos = new Set(lista.filter((c) => c.assetId).map((c) => String(c.assetId)))
    const nuevas = ids
        .map(String)
        .filter((id) => !yaSeguidos.has(id))
        .map((id) => {
            const asset = portfolioAssets.find((a) => String(a.id) === id)
            // El nombre y el tipo solo identifican la entrada en la copia guardada;
            // lo que se enseña sale siempre del activo.
            return { _segId: `seguir_${id}`, assetId: id, nombre: asset?.name || id, tipo: asset?.type || "" }
        })
    return [...lista, ...nuevas]
}

/** Ids marcados en la lista del paso «Activo del portfolio». */
function segMarcadosEn(contenedor) {
    return new Set(
        [...(contenedor?.querySelectorAll("input[type=checkbox]:checked:not(:disabled)") || [])].map((cb) => cb.value)
    )
}

/**
 * Lista de activos del portfolio para añadir a Seguimiento, filtrada por nombre o
 * ticker. Los que ya están en Seguimiento salen marcados y sin poder tocarse.
 *
 * @param {HTMLElement} contenedor Donde se pinta.
 * @param {string} consulta Texto del buscador.
 * @param {Set<string>} marcados Ids marcados antes de filtrar, para no perderlos.
 */
function segPintarExistentes(contenedor, consulta, marcados) {
    if (!contenedor) return
    const q = String(consulta || "")
        .trim()
        .toLowerCase()
    const yaSeguidos = new Set(
        segLoadCustomItems()
            .filter((c) => c.assetId)
            .map((c) => String(c.assetId))
    )
    const activos = (window._segPortfolioAssets || []).filter((a) => {
        if (!q) return true
        const ticker = a.marketSymbol || a.finnhubSymbol || a.ticker || ""
        return [a.name, a.symbol, ticker].some((t) =>
            String(t || "")
                .toLowerCase()
                .includes(q)
        )
    })
    if (!activos.length) {
        contenedor.innerHTML = `<p class="segAddVacio">${q ? "Ningún activo coincide" : "No hay activos en el portfolio"}</p>`
        return
    }
    contenedor.innerHTML = activos
        .map((a) => {
            const id = String(a.id)
            const seguido = yaSeguidos.has(id)
            const color = AV_SEG_TYPE_COLORS[a.type] || "#888"
            const tipo = AV_SEG_TYPE_LABELS[a.type] || a.type || ""
            const ticker = a.marketSymbol || a.finnhubSymbol || a.ticker || ""
            return `<label class="segAddFila${seguido ? " segAddFilaSeguida" : ""}">
                <input type="checkbox" value="${escapeHtml(id)}"${seguido || marcados.has(id) ? " checked" : ""}${seguido ? " disabled" : ""}>
                <span class="avBadge" style="background:${color}22;color:${color};border-color:${color}44">${escapeHtml(tipo)}</span>
                <span class="segAddFilaNombre">${escapeHtml(a.name || a.symbol || id)}</span>
                <span class="segAddFilaTicker">${seguido ? "Ya en Seguimiento" : escapeHtml(ticker)}</span>
            </label>`
        })
        .join("")
}

function segParseSavedSource(saved) {
    const valor = Array.isArray(saved) ? saved[0] : saved
    return SEG_SOURCES.includes(valor) ? valor : SEG_SOURCES[0]
}

async function initSeguimientoLogic() {
    const addBtn = document.getElementById("seguimientoAddBtn")
    const searchInput = document.getElementById("seguimientoSearch")
    const searchBox = document.getElementById("seguimientoSearchBox")
    const searchBtn = document.getElementById("seguimientoSearchBtn")
    const modalOverlay = document.getElementById("seguimientoModalOverlay")
    const confirmBtn = document.getElementById("seguimientoConfirmBtn")
    const cancelBtn = document.getElementById("seguimientoCancelBtn")
    const nombreInput = document.getElementById("seguimientoNombreInput")
    const typeSelect = document.getElementById("seguimientoTypeSelect")
    const tickerInput = document.getElementById("seguimientoTickerInput")
    const tvTickerInput = document.getElementById("seguimientoTVTickerInput")
    const hiddenBtn = document.getElementById("segHiddenBtn")
    const hiddenModalOverlay = document.getElementById("segHiddenModalOverlay")
    const hiddenCloseBtn = document.getElementById("segHiddenCloseBtn")

    const filtersEl = document.getElementById("seguimientoFilters")
    const srcFiltersEl = document.getElementById("seguimientoSourceFilters")
    const viewToggle = document.getElementById("seguimientoViewToggle")
    const segTradingViewBtn = document.getElementById("segSearchTradingViewBtn")
    const segFinnhubBtn = document.getElementById("segSearchFinnhubBtn")
    const segEodhdBtn = document.getElementById("segSearchEodhdBtn")
    const segYahooBtn = document.getElementById("segSearchYahooBtn")
    const segAlphaVantageBtn = document.getElementById("segSearchAlphaVantageBtn")
    const segSearchFeedback = document.getElementById("segSearchFeedback")
    const segSearchResults = document.getElementById("segSearchResults")

    // cargar activos del portfolio
    let portfolioAssets = []
    try {
        const resp = await fetch("/api/activos")
        if (resp.ok) {
            const data = await resp.json()
            portfolioAssets = data.assets || data || []
        }
    } catch {
        /* sin conexión */
    }

    // cargar operaciones y construir items únicos por activo
    try {
        const opResp = await fetch("/api/operaciones")
        if (opResp.ok) {
            const opData = await opResp.json()
            const opRows = opData.rows || []
            const seenAssetIds = new Set()
            window._segOperacionesItems = opRows
                .filter((row) => {
                    if (!row.assetId || seenAssetIds.has(row.assetId)) return false
                    seenAssetIds.add(row.assetId)
                    return true
                })
                .flatMap((row) => {
                    const asset = portfolioAssets.find((a) => a.id === row.assetId)
                    if (!asset) return []
                    return [
                        {
                            _segId: `operacion_${asset.id}`,
                            _fromOperaciones: true,
                            _fromPortfolio: false,
                            name: asset.name || asset.symbol || row.activo || "",
                            symbol: asset.symbol || asset.name || row.activo || "",
                            ticker: asset.marketSymbol || asset.finnhubSymbol || row.ticker || "",
                            marketSymbol: asset.marketSymbol || asset.finnhubSymbol || row.ticker || "",
                            marketProvider: asset.marketProvider || row.marketProvider || "finnhub",
                            tvSymbol: asset.tvSymbol || row.tvSymbol || "",
                            type: asset.type || "cripto",
                            price: String(asset.price || ""),
                            currency: asset.currency || "EUR",
                            change: String(asset.change || ""),
                            lastUpdated: asset.lastUpdated || null
                        }
                    ]
                })
        }
    } catch {
        window._segOperacionesItems = []
    }

    window._segWalletItems = await segLoadWalletItems(portfolioAssets)

    // restaurar filtros guardados
    const _pid = _segPid()
    try {
        const st = localStorage.getItem(`seguimientoFilterType_${_pid}`)
        const ss = localStorage.getItem(`seguimientoFilterSrc_${_pid}`)
        if (st) _segFilterType = JSON.parse(st)
        if (ss) _segFilterSrc = segParseSavedSource(JSON.parse(ss))
    } catch {
        /* ignorar */
    }

    // inicializar vista guardada
    viewToggle?.querySelectorAll(".avViewBtn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.view === _segViewMode)
    })

    segMergeAndRender(portfolioAssets)
    segRefreshCustomPrices()
    segRefreshWalletPrices()

    hiddenBtn?.addEventListener("click", segOpenHiddenModal)
    hiddenCloseBtn?.addEventListener("click", () => hiddenModalOverlay?.classList.add("hidden"))

    const updateSegFilterLabel = () => {
        const btn = document.getElementById("seguimientoFilterDropBtn")
        if (!btn) return
        const filtersEl2 = document.getElementById("seguimientoFilters")
        const srcFiltersEl2 = document.getElementById("seguimientoSourceFilters")
        const typeTodos = filtersEl2?.querySelector('[data-type="all"] input')
        const srcTodos = srcFiltersEl2?.querySelector('[data-source="all"] input')
        const typeParts = typeTodos?.checked
            ? []
            : [...(filtersEl2?.querySelectorAll('.activosFilterBtn:not([data-type="all"]) input') || [])]
                  .filter((cb) => cb.checked)
                  .map((cb) => cb.closest(".activosFilterBtn").querySelector("span").textContent)
        const srcParts = srcTodos?.checked
            ? []
            : [...(srcFiltersEl2?.querySelectorAll('.activosFilterBtn:not([data-source="all"]) input') || [])]
                  .filter((cb) => cb.checked)
                  .map((cb) => cb.closest(".activosFilterBtn").querySelector("span").textContent)
        const parts = [...typeParts, ...srcParts]
        btn.textContent = (parts.length ? parts.join(", ") : "Todos") + " ▾"
    }

    // filtros de tipo
    if (filtersEl) {
        const todosTInput = filtersEl.querySelector('[data-type="all"] input')
        const getTypeIndividuals = () => [
            ...filtersEl.querySelectorAll('.activosFilterBtn:not([data-type="all"]) input')
        ]
        const syncTypeState = () => {
            if (todosTInput?.checked) {
                _segFilterType = "all"
            } else {
                const sel = getTypeIndividuals()
                    .filter((cb) => cb.checked)
                    .map((cb) => cb.closest(".activosFilterBtn").dataset.type)
                _segFilterType = sel.length ? sel : "all"
                if (!sel.length && todosTInput) todosTInput.checked = true
            }
            localStorage.setItem(`seguimientoFilterType_${_segPid()}`, JSON.stringify(_segFilterType))
            updateSegFilterLabel()
        }
        if (_segFilterType === "all") {
            if (todosTInput) todosTInput.checked = true
            getTypeIndividuals().forEach((cb) => {
                cb.checked = true
            })
        } else {
            if (todosTInput) todosTInput.checked = false
            getTypeIndividuals().forEach((cb) => {
                cb.checked = _segFilterType.includes(cb.closest(".activosFilterBtn").dataset.type)
            })
        }
        if (!filtersEl.dataset.bound) {
            filtersEl.dataset.bound = "true"
            filtersEl.addEventListener("change", (e) => {
                const changed = e.target
                if (changed === todosTInput) {
                    changed.checked = true
                    getTypeIndividuals().forEach((cb) => {
                        cb.checked = true
                    })
                } else if (todosTInput?.checked) {
                    todosTInput.checked = false
                    getTypeIndividuals().forEach((cb) => {
                        cb.checked = cb === changed
                    })
                    changed.checked = true
                } else {
                    if (todosTInput) todosTInput.checked = getTypeIndividuals().every((cb) => cb.checked)
                }
                syncTypeState()
                segRenderGrid()
            })
        }
    }

    // filtros de fuente (portfolio / operaciones / nuevos / seguimiento): uno cada vez
    if (srcFiltersEl) {
        const getSrcInputs = () => [...srcFiltersEl.querySelectorAll(".activosFilterBtn input")]
        const marcarSrc = () => {
            getSrcInputs().forEach((cb) => {
                cb.checked = cb.closest(".activosFilterBtn").dataset.source === _segFilterSrc
            })
        }
        marcarSrc()
        if (!srcFiltersEl.dataset.bound) {
            srcFiltersEl.dataset.bound = "true"
            srcFiltersEl.addEventListener("change", (e) => {
                // Pulsar el que ya está elegido no lo apaga: siempre hay uno.
                _segFilterSrc = e.target.closest(".activosFilterBtn")?.dataset.source || _segFilterSrc
                marcarSrc()
                localStorage.setItem(`seguimientoFilterSrc_${_segPid()}`, JSON.stringify(_segFilterSrc))
                updateSegFilterLabel()
                segSyncAddBtn(addBtn)
                segRenderGrid()
            })
        }
    }

    updateSegFilterLabel()
    segSyncAddBtn(addBtn)

    // toggle vista cards / tabla
    viewToggle?.addEventListener("click", (e) => {
        const btn = e.target.closest(".avViewBtn")
        if (!btn) return
        viewToggle.querySelectorAll(".avViewBtn").forEach((b) => b.classList.remove("active"))
        btn.classList.add("active")
        _segViewMode = btn.dataset.view
        localStorage.setItem("whitelistViewMode", _segViewMode)
        segRenderGrid()
    })

    // búsqueda
    searchInput?.addEventListener("input", () => {
        _segSearch = searchInput.value
        segRenderGrid()
    })
    searchBtn?.addEventListener("click", () => {
        const abrir = searchInput.hidden
        searchInput.hidden = !abrir
        searchBox.classList.toggle("open", abrir)
        if (abrir) {
            searchInput.focus()
        } else {
            searchInput.value = ""
            _segSearch = ""
            segRenderGrid()
        }
    })
    searchInput?.addEventListener("keydown", (e) => {
        if (e.key === "Escape") searchBtn.click()
    })

    // autocomplete
    const suggestionsBox = document.getElementById("seguimientoNombreSuggestions")
    let _activeSugIdx = -1

    function segShowSuggestions(query) {
        if (!suggestionsBox) return
        const q = query.toLowerCase().trim()
        if (!q) {
            suggestionsBox.classList.add("hidden")
            suggestionsBox.innerHTML = ""
            return
        }

        const matches = portfolioAssets
            .filter((a) => {
                const name = (a.name || "").toLowerCase()
                const symbol = (a.symbol || "").toLowerCase()
                const ticker = (a.ticker || a.marketSymbol || a.finnhubSymbol || "").toLowerCase()
                return name.includes(q) || symbol.includes(q) || ticker.includes(q)
            })
            .slice(0, 8)

        if (matches.length === 0) {
            suggestionsBox.classList.add("hidden")
            suggestionsBox.innerHTML = ""
            return
        }

        suggestionsBox.innerHTML = matches
            .map((a, i) => {
                const ticker = a.marketSymbol || a.finnhubSymbol || a.ticker || ""
                const tipo = AV_SEG_TYPE_LABELS[a.type] || a.type || ""
                const color = AV_SEG_TYPE_COLORS[a.type] || "#888"
                return `<div class="segSuggestionItem" data-idx="${i}" data-name="${escapeHtml(a.name || a.symbol || "")}" data-ticker="${escapeHtml(ticker)}" data-tipo="${escapeHtml(a.type || "acciones")}">
                <span class="segSuggBadge" style="background:${color}22;color:${color};border-color:${color}44">${escapeHtml(tipo)}</span>
                <span class="segSuggName">${escapeHtml(a.name || a.symbol || "")}</span>
                ${ticker ? `<span class="segSuggTicker">${escapeHtml(ticker)}</span>` : ""}
            </div>`
            })
            .join("")

        _activeSugIdx = -1
        suggestionsBox.classList.remove("hidden")

        suggestionsBox.querySelectorAll(".segSuggestionItem").forEach((el) => {
            el.addEventListener("mousedown", (e) => {
                e.preventDefault()
                segApplySuggestion(el)
            })
        })
    }

    function segApplySuggestion(el) {
        if (!el) return
        nombreInput.value = el.dataset.name || ""
        tickerInput.value = el.dataset.ticker || ""
        if (typeSelect && el.dataset.tipo) {
            typeSelect.value = el.dataset.tipo
            typeSelect.dispatchEvent(new Event("change", { bubbles: true }))
        }
        suggestionsBox.classList.add("hidden")
        suggestionsBox.innerHTML = ""
        tickerInput.focus()
    }

    function segHideSuggestions() {
        suggestionsBox?.classList.add("hidden")
        suggestionsBox && (suggestionsBox.innerHTML = "")
        _activeSugIdx = -1
    }

    nombreInput?.addEventListener("input", () => segShowSuggestions(nombreInput.value))
    nombreInput?.addEventListener("keydown", (e) => {
        const items = suggestionsBox?.querySelectorAll(".segSuggestionItem")
        if (!items || items.length === 0) {
            if (e.key === "Enter") confirmBtn?.click()
            if (e.key === "Escape") closeModal()
            return
        }
        if (e.key === "ArrowDown") {
            e.preventDefault()
            _activeSugIdx = Math.min(_activeSugIdx + 1, items.length - 1)
            items.forEach((el, i) => el.classList.toggle("active", i === _activeSugIdx))
        } else if (e.key === "ArrowUp") {
            e.preventDefault()
            _activeSugIdx = Math.max(_activeSugIdx - 1, -1)
            items.forEach((el, i) => el.classList.toggle("active", i === _activeSugIdx))
        } else if (e.key === "Enter") {
            e.preventDefault()
            if (_activeSugIdx >= 0 && items[_activeSugIdx]) segApplySuggestion(items[_activeSugIdx])
            else if (suggestionsBox?.classList.contains("hidden")) confirmBtn?.click()
            else segHideSuggestions()
        } else if (e.key === "Escape") {
            if (!suggestionsBox?.classList.contains("hidden")) segHideSuggestions()
            else closeModal()
        }
    })
    nombreInput?.addEventListener("blur", () => setTimeout(segHideSuggestions, 150))

    // modal
    function segClearSearch() {
        if (segSearchFeedback) segSearchFeedback.classList.add("hidden")
        if (segSearchResults) {
            segSearchResults.classList.add("hidden")
            segSearchResults.innerHTML = ""
        }
    }

    // El modal tiene tres pasos: elegir qué añadir, elegir activos del portfolio o
    // dar de alta uno nuevo (el formulario de siempre).
    const pasos = {
        elegir: document.getElementById("segAddPasoElegir"),
        existente: document.getElementById("segAddPasoExistente"),
        nuevo: document.getElementById("segAddPasoNuevo")
    }
    const existenteBuscar = document.getElementById("segAddExistenteBuscar")
    const existenteLista = document.getElementById("segAddExistenteLista")
    const existenteConfirmBtn = document.getElementById("segAddExistenteConfirmBtn")

    function mostrarPaso(paso) {
        Object.entries(pasos).forEach(([nombre, el]) => el?.classList.toggle("hidden", nombre !== paso))
        if (paso === "nuevo") nombreInput?.focus()
        if (paso === "existente") {
            if (existenteBuscar) existenteBuscar.value = ""
            segPintarExistentes(existenteLista, "", new Set())
            existenteBuscar?.focus()
        }
    }

    function abrirAlta() {
        const { alta } = segAltaDeFuente(_segFilterSrc)
        if (alta === "activo") openAssetModal()
        else if (alta) openModal(alta)
    }

    function openModal(paso = "elegir") {
        if (!modalOverlay) return
        // Abierto desde Nuevos no hay selector al que volver.
        pasos.nuevo?.querySelector('[data-seg-paso="elegir"]')?.classList.toggle("hidden", paso === "nuevo")
        const titulo = modalOverlay.querySelector(".assetModalTitle")
        if (titulo) titulo.textContent = paso === "nuevo" ? "Añadir a Nuevos" : "Añadir a Seguimiento"
        nombreInput.value = ""
        tickerInput.value = ""
        if (typeSelect) {
            typeSelect.value = ""
            typeSelect.dispatchEvent(new Event("change", { bubbles: true }))
        }
        if (tvTickerInput) tvTickerInput.value = ""
        delete tickerInput?.dataset.marketProvider
        segHideSuggestions()
        segClearSearch()
        modalOverlay.classList.remove("hidden")
        mostrarPaso(paso)
    }

    modalOverlay?.addEventListener("click", (e) => {
        const opcion = e.target.closest("[data-seg-paso]")
        if (opcion) mostrarPaso(opcion.dataset.segPaso)
        if (e.target.closest("[data-seg-cerrar]")) closeModal()
    })

    existenteBuscar?.addEventListener("input", () => {
        segPintarExistentes(existenteLista, existenteBuscar.value, segMarcadosEn(existenteLista))
    })
    existenteBuscar?.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeModal()
    })

    existenteConfirmBtn?.addEventListener("click", () => {
        const ids = [...segMarcadosEn(existenteLista)]
        if (!ids.length) {
            existenteBuscar?.focus()
            return
        }
        segSaveCustomItems(segAnadirReferencias(segLoadCustomItems(), ids, portfolioAssets))
        closeModal()
        segMergeAndRender(portfolioAssets)
        if (_segFilterSrc !== "seguimiento") {
            window.showToast?.(
                ids.length === 1 ? "Añadido a Seguimiento" : `${ids.length} activos añadidos a Seguimiento`,
                { type: "success" }
            )
        }
    })
    function closeModal() {
        segHideSuggestions()
        segClearSearch()
        modalOverlay?.classList.add("hidden")
    }

    addBtn?.addEventListener("click", abrirAlta)
    cancelBtn?.addEventListener("click", closeModal)
    tickerInput?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") confirmBtn?.click()
        if (e.key === "Escape") closeModal()
    })

    // búsqueda de ticker en proveedores externos
    const segTickerSelected = (result, providerName) => {
        if (tickerInput) {
            tickerInput.value = result.symbol
            tickerInput.dataset.marketProvider = String(result.provider || providerName)
                .trim()
                .toLowerCase()
        }
        if (nombreInput && !nombreInput.value.trim()) nombreInput.value = result.description || ""
        autorrellenarTipoActivo(typeSelect, result)
        const sinTipo = !typeSelect?.value
        if (typeof setAssetSearchFeedback === "function")
            setAssetSearchFeedback(
                segSearchFeedback,
                sinTipo
                    ? `Ticker seleccionado (${providerName}): ${result.symbol} — no se ha podido detectar el tipo, elígelo en «Tipo»`
                    : `Ticker seleccionado (${providerName}): ${result.symbol}`,
                sinTipo
            )
        if (typeof renderMarketSearchResults === "function") renderMarketSearchResults(segSearchResults, [], () => {})
    }

    segTradingViewBtn?.addEventListener("click", async () => {
        if (typeof handleTradingViewSearch !== "function") return
        const query = nombreInput?.value.trim() || tickerInput?.value.trim() || ""
        await handleTradingViewSearch({
            query,
            assetName: nombreInput?.value.trim() || "",
            assetType: typeSelect?.value || "",
            feedbackElement: segSearchFeedback,
            resultsElement: segSearchResults,
            onSelect: (r) => segTickerSelected(r, "TradingView")
        })
    })

    segFinnhubBtn?.addEventListener("click", async () => {
        if (typeof handleFinnhubSearch !== "function") return
        const query = nombreInput?.value.trim() || tickerInput?.value.trim() || ""
        await handleFinnhubSearch({
            query,
            assetName: nombreInput?.value.trim() || "",
            assetType: typeSelect?.value || "",
            feedbackElement: segSearchFeedback,
            resultsElement: segSearchResults,
            onSelect: (r) => segTickerSelected(r, "Finnhub")
        })
    })

    segEodhdBtn?.addEventListener("click", async () => {
        if (typeof handleEodhdSearch !== "function") return
        const query = nombreInput?.value.trim() || tickerInput?.value.trim() || ""
        await handleEodhdSearch({
            query,
            assetName: nombreInput?.value.trim() || "",
            assetType: typeSelect?.value || "",
            feedbackElement: segSearchFeedback,
            resultsElement: segSearchResults,
            onSelect: (r) => segTickerSelected(r, "EODHD")
        })
    })

    segYahooBtn?.addEventListener("click", async () => {
        if (typeof handleYahooSearch !== "function") return
        const query = nombreInput?.value.trim() || tickerInput?.value.trim() || ""
        await handleYahooSearch({
            query,
            assetName: nombreInput?.value.trim() || "",
            assetType: typeSelect?.value || "",
            feedbackElement: segSearchFeedback,
            resultsElement: segSearchResults,
            onSelect: (r) => segTickerSelected(r, "Yahoo Finance")
        })
    })

    segAlphaVantageBtn?.addEventListener("click", async () => {
        if (typeof handleAlphaVantageSearch !== "function") return
        const query = nombreInput?.value.trim() || tickerInput?.value.trim() || ""
        await handleAlphaVantageSearch({
            query,
            assetName: nombreInput?.value.trim() || "",
            assetType: typeSelect?.value || "",
            feedbackElement: segSearchFeedback,
            resultsElement: segSearchResults,
            onSelect: (r) => segTickerSelected(r, "Alpha Vantage")
        })
    })

    confirmBtn?.addEventListener("click", () => {
        const nombre = nombreInput?.value.trim()
        if (!nombre) {
            nombreInput?.focus()
            return
        }
        // "Detectar automáticamente" sin ticker elegido, o con uno cuyo tipo
        // no se pudo saber: no se guarda un tipo inventado, se pide.
        if (!typeSelect?.value) {
            setAssetSearchFeedback?.(segSearchFeedback, "No se ha podido detectar el tipo: elígelo en «Tipo».", true)
            typeSelect?.closest(".csWrapper")?.querySelector(".csTrigger")?.focus()
            return
        }
        const customs = segLoadCustomItems()
        customs.push({
            _segId: `custom_${Date.now()}`,
            nombre,
            ticker: tickerInput?.value.trim() || "",
            marketProvider: tickerInput?.dataset.marketProvider || "",
            tvSymbol: tvTickerInput?.value.trim() || "",
            tipo: typeSelect.value,
            notas: ""
        })
        segSaveCustomItems(customs)
        closeModal()
        segMergeAndRender(portfolioAssets)
        // Sin esto el activo nuevo no tiene precio hasta la próxima carga de la página.
        segRefreshCustomPrices()
    })

    // ── Modal de edición ─────────────────────────────────────────────────────
    const editOverlay = document.getElementById("segEditModalOverlay")
    const editNombreInput = document.getElementById("segEditNombreInput")
    const editTypeSelect = document.getElementById("segEditTypeSelect")
    const editTickerInput = document.getElementById("segEditTickerInput")
    const editTVInput = document.getElementById("segEditTVTickerInput")
    const editFeedback = document.getElementById("segEditSearchFeedback")
    const editResults = document.getElementById("segEditSearchResults")
    const editCancelBtn = document.getElementById("segEditCancelBtn")
    const editConfirmBtn = document.getElementById("segEditConfirmBtn")
    let _editingSegId = null

    function segClearEditSearch() {
        if (editFeedback) editFeedback.classList.add("hidden")
        if (editResults) {
            editResults.classList.add("hidden")
            editResults.innerHTML = ""
        }
    }

    const editModalTitle = document.getElementById("segEditModalTitle")
    const editPortfolioNote = document.getElementById("segEditPortfolioNotice")
    const editCustomForm = document.getElementById("segEditCustomForm")

    window.segOpenEditModal = function (segId) {
        if (!editOverlay) return
        const allItem = _segAllItems.find((i) => i._segId === segId)
        if (!allItem) return
        _editingSegId = segId

        segClearEditSearch()

        if (allItem._fromPortfolio || allItem._fromOperaciones) {
            if (editModalTitle) editModalTitle.textContent = allItem.name || allItem.symbol || "Activo del portfolio"
            if (editPortfolioNote) editPortfolioNote.classList.remove("hidden")
            if (editCustomForm) editCustomForm.classList.add("hidden")
            if (editConfirmBtn) {
                editConfirmBtn.removeAttribute("style")
                editConfirmBtn.classList.remove("hidden")
            }
            const rawTV = allItem.tvSymbol || ""
            if (editTVInput) editTVInput.value = typeof decodeTVTicker === "function" ? decodeTVTicker(rawTV) : rawTV
        } else {
            const customs = segLoadCustomItems()
            const item = customs.find((c) => c._segId === segId)
            if (!item) return
            if (editModalTitle) editModalTitle.textContent = "Editar activo"
            if (editPortfolioNote) editPortfolioNote.classList.add("hidden")
            if (editCustomForm) editCustomForm.classList.remove("hidden")
            if (editConfirmBtn) {
                editConfirmBtn.removeAttribute("style")
                editConfirmBtn.classList.remove("hidden")
            }

            editNombreInput.value = item.nombre || ""
            if (editTypeSelect) {
                editTypeSelect.value = item.tipo || "acciones"
                editTypeSelect.dispatchEvent(new Event("change", { bubbles: true }))
            }
            editTickerInput.value = item.ticker || ""
            delete editTickerInput.dataset.marketProvider
            if (item.marketProvider) editTickerInput.dataset.marketProvider = item.marketProvider
            const rawTV2 = item.tvSymbol || ""
            if (editTVInput) editTVInput.value = typeof decodeTVTicker === "function" ? decodeTVTicker(rawTV2) : rawTV2
        }

        editOverlay.classList.remove("hidden")
        if (!allItem._fromPortfolio) editNombreInput.focus()
    }

    editCancelBtn?.addEventListener("click", () => {
        _editingSegId = null
        segClearEditSearch()
        editOverlay?.classList.add("hidden")
    })

    editConfirmBtn?.addEventListener("click", () => {
        if (!_editingSegId) return
        const allItem = _segAllItems.find((i) => i._segId === _editingSegId)

        if (allItem?._fromPortfolio || allItem?._fromOperaciones) {
            const tvVal = editTVInput?.value.trim() || ""
            const overrides = _segDatos().overrides
            overrides[_editingSegId] = { ...(overrides[_editingSegId] || {}), tvSymbol: tvVal }
            _segGuardar({ seguimientoOverrides: overrides })
            _editingSegId = null
            editOverlay?.classList.add("hidden")
            segMergeAndRender(portfolioAssets)
            return
        }

        const nombre = editNombreInput?.value.trim()
        if (!nombre) {
            editNombreInput?.focus()
            return
        }

        const customs = segLoadCustomItems()
        const idx = customs.findIndex((c) => c._segId === _editingSegId)
        if (idx < 0) return
        const anterior = customs[idx]
        customs[idx] = {
            ...anterior,
            nombre,
            ticker: editTickerInput?.value.trim() || "",
            marketProvider: editTickerInput?.dataset.marketProvider || anterior.marketProvider || "",
            tvSymbol: editTVInput?.value.trim() || "",
            tipo: editTypeSelect?.value || "acciones"
        }
        const cotizacionCambia =
            customs[idx].ticker !== (anterior.ticker || "") ||
            customs[idx].marketProvider !== (anterior.marketProvider || "")
        // El precio guardado era del ticker anterior: si el nuevo no cotiza, mejor "—" que un precio ajeno.
        if (cotizacionCambia) Object.assign(customs[idx], { price: "", change: "", lastUpdated: null })
        segSaveCustomItems(customs)

        _editingSegId = null
        segClearEditSearch()
        editOverlay?.classList.add("hidden")
        segMergeAndRender(portfolioAssets)
        segRefreshCustomPrices()
    })

    const editTickerSelected = (result, providerName) => {
        if (editTickerInput) {
            editTickerInput.value = result.symbol
            editTickerInput.dataset.marketProvider = String(result.provider || providerName)
                .trim()
                .toLowerCase()
        }
        if (editNombreInput && !editNombreInput.value.trim()) editNombreInput.value = result.description || ""
        if (typeof setAssetSearchFeedback === "function")
            setAssetSearchFeedback(editFeedback, `Ticker seleccionado (${providerName}): ${result.symbol}`)
        if (typeof renderMarketSearchResults === "function") renderMarketSearchResults(editResults, [], () => {})
    }

    document.getElementById("segEditSearchTradingViewBtn")?.addEventListener("click", async () => {
        if (typeof handleTradingViewSearch !== "function") return
        await handleTradingViewSearch({
            query: editNombreInput?.value.trim() || editTickerInput?.value.trim() || "",
            assetName: editNombreInput?.value.trim() || "",
            assetType: editTypeSelect?.value || "",
            feedbackElement: editFeedback,
            resultsElement: editResults,
            onSelect: (r) => editTickerSelected(r, "TradingView")
        })
    })

    document.getElementById("segEditSearchFinnhubBtn")?.addEventListener("click", async () => {
        if (typeof handleFinnhubSearch !== "function") return
        await handleFinnhubSearch({
            query: editNombreInput?.value.trim() || editTickerInput?.value.trim() || "",
            assetName: editNombreInput?.value.trim() || "",
            assetType: editTypeSelect?.value || "",
            feedbackElement: editFeedback,
            resultsElement: editResults,
            onSelect: (r) => editTickerSelected(r, "Finnhub")
        })
    })

    document.getElementById("segEditSearchEodhdBtn")?.addEventListener("click", async () => {
        if (typeof handleEodhdSearch !== "function") return
        await handleEodhdSearch({
            query: editNombreInput?.value.trim() || editTickerInput?.value.trim() || "",
            assetName: editNombreInput?.value.trim() || "",
            assetType: editTypeSelect?.value || "",
            feedbackElement: editFeedback,
            resultsElement: editResults,
            onSelect: (r) => editTickerSelected(r, "EODHD")
        })
    })

    document.getElementById("segEditSearchYahooBtn")?.addEventListener("click", async () => {
        if (typeof handleYahooSearch !== "function") return
        await handleYahooSearch({
            query: editNombreInput?.value.trim() || editTickerInput?.value.trim() || "",
            assetName: editNombreInput?.value.trim() || "",
            assetType: editTypeSelect?.value || "",
            feedbackElement: editFeedback,
            resultsElement: editResults,
            onSelect: (r) => editTickerSelected(r, "Yahoo Finance")
        })
    })

    document.getElementById("segEditSearchAlphaVantageBtn")?.addEventListener("click", async () => {
        if (typeof handleAlphaVantageSearch !== "function") return
        await handleAlphaVantageSearch({
            query: editNombreInput?.value.trim() || editTickerInput?.value.trim() || "",
            assetName: editNombreInput?.value.trim() || "",
            assetType: editTypeSelect?.value || "",
            feedbackElement: editFeedback,
            resultsElement: editResults,
            onSelect: (r) => editTickerSelected(r, "Alpha Vantage")
        })
    })
}
