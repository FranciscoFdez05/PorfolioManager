// Carpeta de html/ en la que vive el fragmento de cada página. Los ficheros
// están agrupados por dominio (igual que js/), así que la ruta ya no se puede
// derivar solo del nombre. Cualquier página que falte aquí se busca en la raíz
// de html/, de modo que añadir una página nueva sin tocar este mapa sigue
// funcionando mientras el fichero esté en html/.
const _PAGE_DIRS = {
    activos: "cartera",
    vistaGeneral: "cartera",
    privateMarket: "cartera",

    gastos: "finanzas",
    ingresos: "finanzas",
    ahorro: "finanzas",
    ventas: "finanzas",
    dividendos: "finanzas",
    intereses: "finanzas",
    bonos: "finanzas",
    rentaFija: "finanzas",
    operacionesBolsa: "finanzas",

    stablecoins: "cripto",
    operaciones: "cripto",
    transacciones: "cripto",
    conversiones: "cripto",
    Staking: "cripto",
    Earn: "cripto",
    Trading: "cripto",

    metricas: "analisis",
    seguimiento: "analisis",
    heatmap: "analisis",
    herramientas: "analisis",

    ajustes: "sesion"
}

function pageHtmlPath(page) {
    const dir = _PAGE_DIRS[page]
    return dir ? `./html/${dir}/${page}.html` : `./html/${page}.html`
}

// ── Preferencias de visualización de los gráficos ─────────────────────────
// Rango, modo, año, mes o filtro que el usuario elige en cada gráfico. Se
// guardan en un único objeto de localStorage para que la vista se conserve al
// recargar o al volver a la página, en lugar de reiniciarse al valor por
// defecto. Quien lee una preferencia debe validarla contra las opciones reales
// disponibles (los años, por ejemplo, cambian según los datos).
const _CHART_PREFS_KEY = "chartViewPrefs"
let _chartPrefsCache = null

function _chartPrefsAll() {
    if (!_chartPrefsCache) {
        try {
            _chartPrefsCache = JSON.parse(localStorage.getItem(_CHART_PREFS_KEY)) || {}
        } catch {
            _chartPrefsCache = {}
        }
    }
    return _chartPrefsCache
}

function getChartPref(key, fallback = null) {
    const value = _chartPrefsAll()[key]
    return value === undefined || value === null ? fallback : value
}

function setChartPref(key, value) {
    const prefs = _chartPrefsAll()
    if (value === undefined || value === null) delete prefs[key]
    else prefs[key] = value
    try {
        localStorage.setItem(_CHART_PREFS_KEY, JSON.stringify(prefs))
    } catch {}
}

window.getChartPref = getChartPref
window.setChartPref = setChartPref

const _MODULE_PAGES = {
    panelSuperior: [],
    vistaGeneral: ["vistaGeneral"],
    activos: ["activos", "seguimiento", "heatmap"],
    gastos: ["gastos", "ingresos"],
    finanzas: ["intereses", "dividendos", "bonos", "ventas", "privateMarket", "operacionesBolsa"],
    cripto: ["stablecoins", "operaciones", "transacciones", "conversiones", "Trading", "Staking", "Earn"],
    herramientas: ["herramientas"],
    metricas: ["metricas"]
}

const _TOP_METRICS_DEFAULT_HIDDEN = new Set([
    "topInvertido",
    "topNumActivos",
    "topStaking",
    "topGastosAnio",
    "topIngresosAnio",
    "topTradingPnL",
    "topMercadoPrivado"
])

function applyTopMetricsVisibility() {
    const cfg = window._topMetricsConfig || {}
    document.querySelectorAll(".metricBox[data-metric]").forEach((box) => {
        const id = box.dataset.metric
        const visible = id in cfg ? cfg[id] : !_TOP_METRICS_DEFAULT_HIDDEN.has(id)
        box.classList.toggle("metricHidden", !visible)
    })
}

function moduloDePagina(page) {
    return Object.keys(_MODULE_PAGES).find((mod) => _MODULE_PAGES[mod].includes(page))
}

function paginaVisible(page) {
    const mod = moduloDePagina(page)
    // Las páginas sin módulo (ajustes) siempre están disponibles.
    return !mod || (window._modulosConfig || {})[mod] !== false
}

// Primera pestaña activa según el orden de la barra de navegación. Se usa al
// arrancar y al apagar el módulo de la página que se está viendo: si "Vista
// general" está desactivada la app tiene que abrir otra cosa, no quedarse en
// una página que ya no se puede alcanzar desde el menú.
function primeraPaginaVisible() {
    const botones = document.querySelectorAll(".navButtons [data-page]")

    for (const boton of botones) {
        const page = boton.dataset.page
        if (page !== "ajustes" && paginaVisible(page)) {
            return page
        }
    }

    return null
}

function activarBotonNav(page) {
    document.querySelectorAll(".navBtn").forEach((item) => item.classList.remove("active"))
    document.querySelectorAll(".navDropdownBtn").forEach((item) => item.classList.remove("active"))

    const boton = document.querySelector(`.navButtons [data-page="${page}"]`)
    if (!boton) {
        return
    }

    boton.classList.add("active")
    boton.closest(".navDropdown")?.querySelector(".navDropdownBtn")?.classList.add("active")
}

function applyModulesVisibility() {
    const cfg = window._modulosConfig || {}
    for (const mod of Object.keys(_MODULE_PAGES)) {
        const enabled = cfg[mod] !== false
        document.querySelectorAll(`[data-module="${mod}"]`).forEach((el) => {
            el.style.display = enabled ? "" : "none"
        })
    }

    // Si se acaba de apagar el módulo de la página abierta, hay que moverse.
    const actual = window._paginaActual
    if (actual && !paginaVisible(actual)) {
        const destino = primeraPaginaVisible()
        if (destino) {
            activarBotonNav(destino)
            loadPage(destino)
        }
    }
}

async function _postSnapshot() {
    const m = window._lastPortfolioMetrics
    if (!m) return
    const payload = { total_value: m.totalCuenta, total_invested: m.invertido }
    const hmData = window._hmData || window._assetsSnapshotData
    if (Array.isArray(hmData) && hmData.length) {
        payload.assets = hmData
            .filter((d) => d.netoEur > 0)
            .map((d) => ({ id: d.id, v: d.netoEur, c: d.costEur ?? d.invertidoEur ?? 0 }))
    }
    await fetch("/api/portfolio/snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    }).catch(() => {})
}

document.addEventListener("DOMContentLoaded", async () => {
    const toggleButton = document.getElementById("togglePanel")
    const sideWrapper = document.getElementById("sideWrapper")
    const navButtons = document.querySelectorAll(".navBtn")
    const contentArea = document.getElementById("dynamicContent")
    const addAssetButton = document.getElementById("addAssetBtn")
    const refreshSidebarMarketButton = document.getElementById("refreshSidebarMarketBtn")
    const assetModalOverlay = document.getElementById("assetModalOverlay")
    const confirmAssetModalButton = document.getElementById("confirmAssetModalBtn")
    const cancelAssetModalButton = document.getElementById("cancelAssetModalBtn")
    const assetNameInput = document.getElementById("assetNameInput")
    const assetTypeSelect = document.getElementById("assetTypeSelect")
    const assetTickerInput = document.getElementById("assetTickerInput")
    const searchAssetTickerFinnhubButton = document.getElementById("searchAssetTickerFinnhubBtn")
    const searchAssetTickerEodhdButton = document.getElementById("searchAssetTickerEodhdBtn")
    const searchAssetTickerYahooButton = document.getElementById("searchAssetTickerYahooBtn")
    const searchAssetTickerAlphaVantageButton = document.getElementById("searchAssetTickerAlphaVantageBtn")
    const confirmModalOverlay = document.getElementById("confirmModalOverlay")
    const confirmModalAcceptButton = document.getElementById("confirmModalAcceptBtn")
    const confirmModalCancelButton = document.getElementById("confirmModalCancelBtn")

    initSidePanel(toggleButton, sideWrapper)
    initNavigation(navButtons, contentArea)
    initResizeHandles()
    initAddAssetButton(addAssetButton, assetModalOverlay, assetNameInput, assetTypeSelect, assetTickerInput)
    initSidebarRefreshButton(refreshSidebarMarketButton)
    initSidebarFilterBar()
    initAssetModal(
        assetModalOverlay,
        confirmAssetModalButton,
        cancelAssetModalButton,
        assetNameInput,
        assetTypeSelect,
        assetTickerInput,
        searchAssetTickerFinnhubButton,
        searchAssetTickerEodhdButton,
        searchAssetTickerYahooButton,
        searchAssetTickerAlphaVantageButton
    )
    initConfirmModal(confirmModalOverlay, confirmModalAcceptButton, confirmModalCancelButton)
    applyDensidadSidebar(localStorage.getItem("portfolioDensity") || "normal")
    await loadGlobalSettings()
    applyTopMetricsVisibility()
    applyModulesVisibility()
    applySidebarState(sideWrapper, toggleButton)
    await refreshAssetsSidebar()
    await refreshTopDividendosIntereses()

    initMoneyToggle()
    applyAssetRotation()

    const paginaInicial = primeraPaginaVisible()
    if (paginaInicial) {
        activarBotonNav(paginaInicial)
        loadPage(paginaInicial)
    }

    refreshOverviewMarketData().then(() => {
        _postSnapshot()
    })
})

async function loadGlobalSettings() {
    try {
        const res = await fetch("/api/settings")
        const data = await res.json()
        if (data.ok) {
            window._settingsStaleHours = data.staleHours ?? 24
            window._hiddenAssets = new Set(data.hiddenAssets || [])
            window._metricasDisplayType = data.metricasDisplayType ?? "doughnut"
            window._metricasDistMetric = data.metricasDistMetric ?? "netoActualEur"
            window._metricasComparativaExcluded = data.comparativaExcluded ?? []
            window._gastosHiddenTipos = data.gastosHiddenTipos ?? []
            window._gastosHiddenMensualidades = data.gastosHiddenMensualidades ?? []
            window._gastosMostrarPausadas = data.gastosMostrarPausadas ?? false
            window._metricasActivosHidden = data.metricasActivosHidden ?? []
            window._metricasSectionsCollapsed = data.metricasSectionsCollapsed ?? []
            window._topMetricsConfig = data.topMetricsConfig ?? {}
            window._modulosConfig = data.modulosConfig ?? {}
            window._sidebarCollapsed = data.sidebarCollapsed ?? false
            window._monedaBase = data.monedaBase ?? "EUR"
            window._fiatCurrencies = (data.fiatCurrencies || []).map((c) => c.code).filter(Boolean)
            if (!window._fiatCurrencies.length) window._fiatCurrencies = ["EUR", "USD", "GBP", "CHF", "JPY"]
            window._autoRefreshMinutes = data.autoRefreshMinutes ?? 0
            window._snapshotMinutes = data.snapshotMinutes ?? 60
            window._snapshotAlcance = data.snapshotAlcance ?? "activo"
            window._soloHorarioMercado = data.soloHorarioMercado ?? false
            window._soloMercadoTipos = data.soloMercadoTipos ?? ["acciones", "etfs", "comoditis"]
            window._bloqueoInactividad = data.bloqueoInactividad ?? 0
            window._precioDecimales_acciones = data.precioDecimalesAcciones ?? 2
            window._precioDecimales_etfs = data.precioDecimalesEtf ?? 2
            window._precioDecimales_comoditis = data.precioDecimalesComoditis ?? 2
            window._precioDecimales_cripto = data.precioDecimalesCripto ?? 4
            window._numLocale = data.numLocale ?? "es-ES"
            window._dateFormat = data.dateFormat ?? "DD/MM/YYYY"
            applyAutoRefresh(window._autoRefreshMinutes)
            applySnapshotSchedule(window._snapshotMinutes)
            applyBloqueoInactividad(window._bloqueoInactividad)
        }
    } catch {
        window._settingsStaleHours = 24
        window._hiddenAssets = new Set()
        window._metricasDisplayType = "doughnut"
        window._metricasDistMetric = "netoActualEur"
        window._metricasComparativaExcluded = []
        window._gastosHiddenTipos = []
        window._gastosHiddenMensualidades = []
        window._gastosMostrarPausadas = false
        window._metricasActivosHidden = []
        window._metricasSectionsCollapsed = []
        window._sidebarCollapsed = false
        window._monedaBase = "EUR"
        window._fiatCurrencies = ["EUR", "USD", "GBP", "CHF", "JPY"]
        window._autoRefreshMinutes = 0
        window._snapshotMinutes = 60
        window._snapshotAlcance = "activo"
        window._soloHorarioMercado = false
        window._soloMercadoTipos = ["acciones", "etfs", "comoditis"]
        window._bloqueoInactividad = 0
        window._precioDecimales_acciones = 2
        window._precioDecimales_etfs = 2
        window._precioDecimales_comoditis = 2
        window._precioDecimales_cripto = 4
        window._numLocale = "es-ES"
        window._dateFormat = "DD/MM/YYYY"
        window._modulosConfig = {}
    }
}

let _autoRefreshTimer = null
let _autoRefreshInitTimer = null
function applyAutoRefresh(minutes) {
    if (_autoRefreshTimer) {
        clearInterval(_autoRefreshTimer)
        _autoRefreshTimer = null
    }
    if (_autoRefreshInitTimer) {
        clearTimeout(_autoRefreshInitTimer)
        _autoRefreshInitTimer = null
    }
    if (!minutes || minutes <= 0) return

    const intervalMs = minutes * 60 * 1000

    function _mercadoEstaAbierto() {
        const now = new Date()
        const day = now.getDay()
        const hour = now.getHours()
        if (day === 0 || day === 6) return false
        return hour >= 8 && hour < 22
    }

    async function doRefresh() {
        if (window._soloHorarioMercado && !_mercadoEstaAbierto()) {
            const tipos = window._soloMercadoTipos ?? ["acciones", "etfs", "comoditis"]
            if (tipos.length > 0) return
        }
        await refreshAssetsSidebar()
        await refreshOverviewMarketData()
    }

    const nowMs = Date.now()
    const delayMs = Math.ceil(nowMs / intervalMs) * intervalMs - nowMs
    _autoRefreshInitTimer = setTimeout(() => {
        doRefresh()
        _autoRefreshTimer = setInterval(doRefresh, intervalMs)
    }, delayMs)
}

let _snapshotTimer = null
let _snapshotInitTimer = null
function applySnapshotSchedule(minutes) {
    if (_snapshotTimer) {
        clearInterval(_snapshotTimer)
        _snapshotTimer = null
    }
    if (_snapshotInitTimer) {
        clearTimeout(_snapshotInitTimer)
        _snapshotInitTimer = null
    }
    if (!minutes || minutes <= 0) return

    const intervalMs = minutes * 60 * 1000

    async function doSnapshot() {
        await _postSnapshot()
        if (typeof mRenderEvolucion === "function") {
            const activeBtn = document.querySelector(".mEvolucionRangeBtn.active")
            mRenderEvolucion(activeBtn ? activeBtn.dataset.range : "1D")
        }
        if (typeof mRenderEvolucionTipos === "function") {
            const activeRangeBtn = document.querySelector(".mEvolucionTiposRangeBtn.active")
            mRenderEvolucionTipos(
                activeRangeBtn ? activeRangeBtn.dataset.range : getChartPref("evolucionTiposRange", "1D"),
                getChartPref("evolucionTiposMode", "eur")
            )
        }
    }

    // Esperar al próximo límite alineado al reloj (XX:00, XX:15, XX:30…)
    const nowMs = Date.now()
    const delayMs = Math.ceil(nowMs / intervalMs) * intervalMs - nowMs
    _snapshotInitTimer = setTimeout(() => {
        doSnapshot()
        _snapshotTimer = setInterval(doSnapshot, intervalMs)
    }, delayMs)
}

function initSearchableSelect(selectEl) {
    if (!selectEl) return
    const allOptions = Array.from(selectEl.options)
        .filter((o) => o.value !== "")
        .map((o) => ({ value: o.value, text: o.text }))

    // Wrapper replaces the select in the DOM
    const wrapper = document.createElement("div")
    wrapper.className = "searchableSelectWrap"
    selectEl.parentNode.insertBefore(wrapper, selectEl)
    selectEl.style.display = "none"
    wrapper.appendChild(selectEl)

    // Trigger div — looks like a <select>
    const trigger = document.createElement("div")
    trigger.className = "searchableSelectTrigger"
    trigger.tabIndex = 0
    wrapper.appendChild(trigger)

    const triggerText = document.createElement("span")
    triggerText.className = "searchableSelectValue"
    trigger.appendChild(triggerText)

    // Dropdown panel — hidden by default via inline style
    const panel = document.createElement("div")
    panel.className = "searchableSelectPanel"
    panel.style.cssText = "display:none;position:absolute;top:calc(100% + 3px);left:0;right:0;z-index:9999;"
    wrapper.appendChild(panel)

    // Search input inside the panel
    const searchInput = document.createElement("input")
    searchInput.type = "text"
    searchInput.className = "searchableSelectSearch"
    searchInput.placeholder = "Buscar…"
    searchInput.autocomplete = "off"
    searchInput.spellcheck = false
    panel.appendChild(searchInput)

    // List inside the panel
    const list = document.createElement("div")
    list.className = "searchableSelectList"
    panel.appendChild(list)

    // --- Helpers ---
    function getSelectedText() {
        const cur = allOptions.find((o) => o.value === selectEl.value)
        return cur ? cur.text : ""
    }

    function updateTrigger() {
        const text = getSelectedText()
        triggerText.textContent = text
        triggerText.classList.toggle("empty", !text)
    }

    function renderList(q) {
        const lower = q.toLowerCase()
        const filtered = q ? allOptions.filter((o) => o.text.toLowerCase().includes(lower)) : allOptions
        list.innerHTML = ""
        filtered.forEach((o) => {
            const item = document.createElement("div")
            item.className = "searchableSelectItem" + (o.value === selectEl.value ? " active" : "")
            item.textContent = o.text
            item.dataset.value = o.value
            list.appendChild(item)
        })
    }

    function openPanel() {
        panel.style.display = "block"
        wrapper.classList.add("ssOpen")
        searchInput.value = ""
        renderList("")
        searchInput.focus()
        requestAnimationFrame(() => {
            const active = list.querySelector(".active")
            if (active) active.scrollIntoView({ block: "nearest" })
        })
    }

    function closePanel() {
        panel.style.display = "none"
        wrapper.classList.remove("ssOpen")
        searchInput.value = ""
    }

    function pickOption(value) {
        selectEl.value = value
        selectEl.dispatchEvent(new Event("change"))
        updateTrigger()
        closePanel()
    }

    // --- Init ---
    updateTrigger()

    // --- Events ---
    trigger.addEventListener("click", () => (wrapper.classList.contains("ssOpen") ? closePanel() : openPanel()))
    trigger.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            openPanel()
        }
        if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
            openPanel()
            searchInput.value = e.key
            renderList(searchInput.value)
            e.preventDefault()
        }
    })

    searchInput.addEventListener("input", () => renderList(searchInput.value))

    list.addEventListener("mousedown", (e) => {
        const item = e.target.closest(".searchableSelectItem")
        if (!item) return
        e.preventDefault()
        pickOption(item.dataset.value)
    })

    searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            e.stopPropagation()
            closePanel()
            trigger.focus()
        }
    })

    document.addEventListener(
        "mousedown",
        (e) => {
            if (!wrapper.contains(e.target)) closePanel()
        },
        true
    )
}

function applySidebarState(sideWrapper, toggleButton) {
    if (!sideWrapper || !toggleButton) return
    if (window._sidebarCollapsed) {
        sideWrapper.classList.add("collapsed")
        toggleButton.innerHTML = "◀"
    }
}

const dividendosAutosaveTimeout = null
let currentAssetId = null
const assetModalState = null
const confirmModalState = null
const editAssetModalState = null
const draggedAssetId = null
const PAGE_HTML_VERSION = "20260826b"

window._viewAllPortfolios = localStorage.getItem("viewAllPortfolios") === "1"

function initSidePanel(toggleButton, sideWrapper) {
    if (!toggleButton || !sideWrapper) {
        return
    }

    toggleButton.addEventListener("click", () => {
        sideWrapper.classList.toggle("collapsed")
        const collapsed = sideWrapper.classList.contains("collapsed")
        toggleButton.innerHTML = collapsed ? "◀" : "▶"
        window._sidebarCollapsed = collapsed
        fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sidebarCollapsed: collapsed })
        }).catch(() => {})
    })

    sideWrapper.addEventListener("transitionend", (e) => {
        if (e.propertyName === "width" && typeof window._resizeChartsOnSidebarChange === "function") {
            window._resizeChartsOnSidebarChange()
        }
    })
}

function clearNavSelection() {
    document.querySelectorAll(".navBtn").forEach((button) => button.classList.remove("active"))
    document.querySelectorAll(".navDropdownBtn").forEach((button) => button.classList.remove("active"))
}

function initAssetSelector(assetButtons) {
    if (!assetButtons.length) {
        return
    }

    assetButtons.forEach((button) => {
        button.addEventListener("click", async () => {
            if (window._viewAllPortfolios) {
                const prefixedId = button.dataset.assetId || ""
                const sep = prefixedId.indexOf("__")
                if (sep >= 0) {
                    const pid = prefixedId.slice(0, sep)
                    localStorage.removeItem("viewAllPortfolios")
                    window._viewAllPortfolios = false
                    try {
                        const res = await fetch("/api/portfolios/switch", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ id: pid })
                        })
                        const data = await res.json()
                        if (data.ok) window.location.reload()
                    } catch (_) {}
                }
                return
            }
            const assetId = button.dataset.assetId || ""
            if (!assetId) return
            currentAssetId = assetId
            const assetData = await loadAssetData(assetId)
            await updateAssetDetail(assetData)
            await renderAssetsList(await loadAssetsList())
            restartAssetRotationBar()
            const assetForTV = {
                tvSymbol: button.dataset.tvSymbol || "",
                marketSymbol: button.dataset.marketSymbol || "",
                finnhubSymbol: button.dataset.marketSymbol || "",
                marketProvider: button.dataset.marketProvider || "",
                symbol: button.dataset.assetSymbol || "",
                name: button.dataset.assetName || ""
            }
            const tvSym = buildTVSymbol(assetForTV)
            if (tvSym) openTVChartModal(tvSym, button.dataset.assetName || button.dataset.assetSymbol || "")
        })
    })
}

function initNavigation(navButtons, contentArea) {
    navButtons.forEach((button) => {
        button.addEventListener("click", () => {
            const page = button.dataset.page

            // Ajustes abre un overlay propio, sin cambiar de página
            if (page === "ajustes") {
                openSettingsModal()
                return
            }

            navButtons.forEach((item) => item.classList.remove("active"))
            document.querySelectorAll(".navDropdownBtn").forEach((b) => b.classList.remove("active"))
            button.classList.add("active")

            const parentMenu = button.closest(".navDropdown")
            if (parentMenu) {
                parentMenu.querySelector(".navDropdownBtn").classList.add("active")
                parentMenu.querySelector(".navDropdownMenu").classList.remove("open")
            }

            loadPage(page, contentArea)
        })
    })

    document.querySelectorAll(".navDropdownBtn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation()
            const menu = btn.nextElementSibling
            const isOpen = menu.classList.contains("open")
            document.querySelectorAll(".navDropdownMenu.open").forEach((m) => m.classList.remove("open"))
            document.querySelectorAll(".csMenu.csOpen").forEach((m) => {
                m.classList.remove("csOpen")
                m._csTrigger?.classList.remove("csOpen")
            })
            if (!isOpen) {
                const rect = btn.getBoundingClientRect()
                menu.style.top = rect.bottom + 4 + "px"
                menu.style.left = rect.left + "px"
                menu.style.minWidth = rect.width + "px"
                menu.classList.add("open")
            }
        })
    })

    // filterDrop — delegated, works for dynamically loaded pages
    document.addEventListener("click", (e) => {
        if (e.target.closest(".filterDropMenu")) {
            e.stopImmediatePropagation()
            return
        }
        const fBtn = e.target.closest(".filterDropBtn")
        if (fBtn) {
            e.stopImmediatePropagation()
            const drop = fBtn.closest(".filterDrop")
            const menu = drop?.querySelector(".filterDropMenu")
            if (!menu) return
            const isOpen = menu.classList.contains("open")
            document.querySelectorAll(".filterDropMenu.open").forEach((m) => m.classList.remove("open"))
            document.querySelectorAll(".navDropdownMenu.open").forEach((m) => m.classList.remove("open"))
            if (!isOpen) {
                const rect = fBtn.getBoundingClientRect()
                menu.style.top = rect.bottom + 4 + "px"
                menu.style.left = rect.left + "px"
                menu.classList.add("open")
            }
            return
        }
        document.querySelectorAll(".filterDropMenu.open").forEach((m) => m.classList.remove("open"))
    })

    document.addEventListener("click", () => {
        document.querySelectorAll(".navDropdownMenu.open").forEach((m) => m.classList.remove("open"))
        document.querySelectorAll(".rowMenuDropdown.open").forEach((m) => m.classList.remove("open"))
    })

    document.addEventListener("click", (e) => {
        const trigger = e.target.closest(".rowMenuTrigger")
        if (!trigger) return
        e.stopPropagation()
        const menu = trigger.nextElementSibling
        if (!menu?.classList.contains("rowMenuDropdown")) return
        const wasOpen = menu.classList.contains("open")
        document.querySelectorAll(".rowMenuDropdown.open").forEach((m) => {
            m.classList.remove("open")
            m.style.top = ""
            m.style.bottom = ""
            m.style.left = ""
            m.style.right = ""
        })
        if (!wasOpen) {
            const rect = trigger.getBoundingClientRect()
            const menuHeight = menu.offsetHeight || 90
            const spaceBelow = window.innerHeight - rect.bottom
            if (spaceBelow < menuHeight + 8) {
                menu.style.bottom = window.innerHeight - rect.top + 4 + "px"
                menu.style.top = "auto"
            } else {
                menu.style.top = rect.bottom + 4 + "px"
                menu.style.bottom = "auto"
            }
            menu.style.right = window.innerWidth - rect.right + "px"
            menu.style.left = "auto"
            menu.classList.add("open")
        }
    })

    const avTip = document.createElement("div")
    avTip.className = "avTooltip"
    document.body.appendChild(avTip)

    document.addEventListener(
        "mouseover",
        (e) => {
            const btn = e.target.closest(".avActionBtn")
            if (!btn) return
            if (btn.hasAttribute("title")) {
                btn.dataset.tip = btn.title
                btn.removeAttribute("title")
            }
            const label = btn.dataset.tip
            if (!label) return
            avTip.textContent = label
            const r = btn.getBoundingClientRect()
            avTip.style.left = r.left + r.width / 2 + "px"
            avTip.style.top = r.top - 8 + "px"
            avTip.classList.add("avTooltipVisible")
        },
        true
    )

    document.addEventListener(
        "mouseout",
        (e) => {
            if (!e.target.closest(".avActionBtn")) return
            avTip.classList.remove("avTooltipVisible")
        },
        true
    )
}

async function loadPage(page, contentArea = document.getElementById("dynamicContent")) {
    if (!contentArea) {
        return
    }

    window._paginaActual = page

    try {
        if (typeof window._hmResizeCleanup === "function") {
            window._hmResizeCleanup()
            window._hmResizeCleanup = null
        }

        if (typeof window.flushPendingPageChanges === "function") {
            try {
                await window.flushPendingPageChanges()
            } catch (flushError) {
                console.error("No se pudieron guardar los cambios pendientes antes de cambiar de página:", flushError)
            } finally {
                window.flushPendingPageChanges = null
            }
        }

        const response = await fetch(`${pageHtmlPath(page)}?v=${PAGE_HTML_VERSION}`, {
            cache: "no-store"
        })

        if (!response.ok) {
            throw new Error(`No se pudo cargar ${page}.html`)
        }

        const htmlContent = await response.text()
        document.querySelectorAll(".csBodyMenu").forEach((m) => m.remove())
        contentArea.innerHTML = htmlContent

        const mainContent = document.querySelector(".mainContent")
        if (mainContent) {
            const gridPages = ["activos", "seguimiento"]
            mainContent.classList.toggle("gridPageActive", gridPages.includes(page))
        }

        if (page === "vistaGeneral") {
            await initVistaGeneralLogic()
        } else if (page === "intereses") {
            await initInteresesLogic()
        } else if (page === "dividendos") {
            await initDividendosLogic()
        } else if (page === "gastos") {
            await initGastosLogic()
        } else if (page === "ingresos") {
            await initIngresosLogic()
        } else if (page === "ventas") {
            await initVentasLogic()
        } else if (page === "stablecoins") {
            await initStablecoinsLogic()
        } else if (page === "transacciones") {
            await initTransaccionesLogic()
        } else if (page === "operaciones") {
            await initOperacionesLogic()
        } else if (page === "operacionesBolsa") {
            await initOperacionesBolsaLogic()
        } else if (page === "Trading") {
            await initTradingJournalLogic()
        } else if (page === "Staking") {
            await initStakingLogic()
        } else if (page === "Earn") {
            await initEarnLogic()
        } else if (page === "conversiones") {
            await initConversionesLogic()
        } else if (page === "herramientas") {
            await initHerramientasLogic()
        } else if (page === "bonos") {
            await initBonosLogic()
        } else if (page === "metricas") {
            await initMetricasLogic()
        } else if (page === "activos") {
            await initActivosPageLogic()
        } else if (page === "heatmap") {
            await initHeatmapLogic()
        } else if (page === "seguimiento") {
            await initSeguimientoLogic()
        } else if (page === "privateMarket") {
            await initPrivateMarketLogic()
        } else if (page === "ahorro") {
            await initAhorroLogic()
        }
    } catch (error) {
        console.error(error)
        const details = error instanceof Error ? error.message : "Error desconocido"
        contentArea.innerHTML = `<div class="pageError">Error de carga: no se pudo abrir ${page}.html<br><small>${details}</small></div>`
    }
}

async function initInteresesLogic() {
    currentInteresesYear = null
    await renderInteresesTable()

    const interesesBody = document.getElementById("interesesBody")
    const addRowButton = document.getElementById("addRowBtn")
    const addYearButton = document.getElementById("addInteresesYearBtn")
    const deleteYearButton = document.getElementById("deleteInteresesYearBtn")

    if (interesesBody && !interesesBody.dataset.bound) {
        interesesBody.dataset.bound = "true"
        interesesBody.addEventListener("click", handleInteresesRowActionClick)
    }

    if (addRowButton && !addRowButton.dataset.bound) {
        addRowButton.dataset.bound = "true"
        addRowButton.addEventListener("click", () => addNewInteresesRow())
    }

    if (addYearButton && !addYearButton.dataset.bound) {
        addYearButton.dataset.bound = "true"
        addYearButton.addEventListener("click", () => {
            closeInteresesMenu()
            addInteresesYear()
        })
    }

    if (deleteYearButton && !deleteYearButton.dataset.bound) {
        deleteYearButton.dataset.bound = "true"
        deleteYearButton.addEventListener("click", () => {
            closeInteresesMenu()
            deleteCurrentInteresesYear()
        })
    }

    const menuBtn = document.getElementById("interesesMenuBtn")
    const menuDrop = document.getElementById("interesesMenuDropdown")
    if (menuBtn && menuDrop && !menuBtn.dataset.bound) {
        menuBtn.dataset.bound = "true"
        menuBtn.addEventListener("click", (e) => {
            e.stopPropagation()
            menuDrop.classList.toggle("hidden")
        })
    }

    bindCuentasSidebarActions()

    const interesesTable = document.querySelector(".interesesTable")
    if (interesesTable) bindTableSort(interesesTable, "intereses")
}

function closeInteresesMenu() {
    const d = document.getElementById("interesesMenuDropdown")
    if (d) d.classList.add("hidden")
}

document.addEventListener("click", (e) => {
    if (
        !e.target.closest("#interesesMenuWrapper") &&
        !e.target.closest("#interesesMenuBtn") &&
        !e.target.closest("#interesesMenuDropdown")
    ) {
        closeInteresesMenu()
    }
})

async function refreshTopDividendosIntereses() {
    const _MONTH_KEYS = [
        "enero",
        "febrero",
        "marzo",
        "abril",
        "mayo",
        "junio",
        "julio",
        "agosto",
        "septiembre",
        "octubre",
        "noviembre",
        "diciembre"
    ]
    try {
        const year = new Date().getFullYear().toString()
        const [
            interesesData,
            dividendosData,
            bonosResp,
            rfResp,
            gastosData,
            ingresosData,
            tradingData,
            stakingData,
            pmData
        ] = await Promise.all([
            loadInteresesData(),
            loadDividendosData(),
            fetch("/api/bonos")
                .then((r) => r.json())
                .catch(() => ({ rows: [] })),
            fetch("/api/rentafija")
                .then((r) => r.json())
                .catch(() => ({ rows: [] })),
            fetch(`/api/gastos/${year}`)
                .then((r) => r.json())
                .catch(() => null),
            fetch(`/api/ingresos/${year}`)
                .then((r) => r.json())
                .catch(() => null),
            fetch("/api/trading")
                .then((r) => r.json())
                .catch(() => ({ rows: [] })),
            fetch("/api/staking")
                .then((r) => r.json())
                .catch(() => ({ rows: [] })),
            fetch("/api/privatemarket")
                .then((r) => r.json())
                .catch(() => ({ rows: [] }))
        ])

        const allInteresesRows = (Array.isArray(interesesData?.cuentas) ? interesesData.cuentas : []).flatMap((c) =>
            Array.isArray(c.rows) ? c.rows : []
        )
        const totalInteres = allInteresesRows.reduce(
            (sum, row) => sum + (parseEuroNumber(row.acumulado) - parseEuroNumber(row.impuestos)),
            0
        )

        const totalDividendos = (Array.isArray(dividendosData?.rows) ? dividendosData.rows : []).reduce(
            (sum, row) => sum + parseEuroNumber(row.total),
            0
        )

        const totalBonos = (Array.isArray(bonosResp?.rows) ? bonosResp.rows : []).reduce(
            (sum, r) => sum + parseEuroNumber(r.interesAcumulado) - parseEuroNumber(r.impuestos),
            0
        )

        const totalRentaFija = (Array.isArray(rfResp?.rows) ? rfResp.rows : []).reduce(
            (sum, r) => sum + parseEuroNumber(r.interesAcumulado) - parseEuroNumber(r.impuestos),
            0
        )

        let totalGastos = 0
        if (gastosData?.months) {
            _MONTH_KEYS.forEach((m) => {
                ;(gastosData.months[m]?.rows || []).forEach((r) => {
                    totalGastos += parseEuroNumber(r.cantidad || "")
                })
            })
        }

        let totalIngresos = 0
        if (ingresosData?.months) {
            _MONTH_KEYS.forEach((m) => {
                ;(ingresosData.months[m]?.rows || []).forEach((r) => {
                    totalIngresos += parseEuroNumber(r.cantidad || "")
                })
            })
        }

        let totalTradingPnL = 0
        ;(tradingData?.rows || []).forEach((r) => {
            const val = parseFloat(
                String(r.ganancia_neta || "")
                    .replace(",", ".")
                    .trim()
            )
            if (!isNaN(val) && (r.capital_currency || "EUR") === "EUR") totalTradingPnL += val
        })

        let totalStaking = 0
        ;(stakingData?.rows || []).forEach((r) => {
            const qty = parseFloat(String(r.cantidad || "").replace(",", "."))
            const precio = parseEuroNumber(r.precio || "")
            if (!isNaN(qty)) totalStaking += qty * precio
        })

        const totalMercadoPrivado = (Array.isArray(pmData?.rows) ? pmData.rows : []).reduce(
            (sum, r) => sum + parseEuroNumber(r.valorActual || ""),
            0
        )

        const set = (id, val) => {
            const el = document.getElementById(id)
            if (el) el.textContent = val
        }
        set("topTotalInteres", formatEuro(totalInteres))
        set("topTotalDividendos", formatEuro(totalDividendos))
        set("topTotalRentaFija", formatEuro(totalBonos + totalRentaFija))
        set("topGastosAnio", formatEuro(totalGastos))
        set("topIngresosAnio", formatEuro(totalIngresos))
        set("topTradingPnL", (totalTradingPnL >= 0 ? "+" : "") + formatEuro(totalTradingPnL))
        set("topStaking", formatEuro(totalStaking))
        set("topMercadoPrivado", formatEuro(totalMercadoPrivado))
        applyTopMetricsVisibility()
    } catch (error) {
        console.error("Error actualizando métricas de dividendos/intereses:", error)
    }
}

function initResizeHandles() {
    const SIDE_MIN = 220
    const SIDE_MAX = 600
    const DETAIL_MIN = 80
    const DETAIL_MAX = 520

    const sideWrapper = document.getElementById("sideWrapper")
    const sideHandle = document.getElementById("sideResizeHandle")
    const detailView = document.getElementById("assetDetailView")
    const detailHandle = document.getElementById("detailResizeHandle")
    const sidePanel = document.getElementById("sidePanel")

    if (sideWrapper && sideHandle) {
        let startX,
            startW,
            rafId = null

        sideHandle.addEventListener("mousedown", (e) => {
            e.preventDefault()
            startX = e.clientX
            startW = sideWrapper.getBoundingClientRect().width
            sideHandle.classList.add("dragging")
            sideWrapper.classList.add("is-resizing")
            document.body.style.cursor = "col-resize"
            document.body.style.userSelect = "none"

            function onMove(e) {
                if (rafId) return
                rafId = requestAnimationFrame(() => {
                    const delta = startX - e.clientX
                    const newW = Math.min(SIDE_MAX, Math.max(SIDE_MIN, startW + delta))
                    sideWrapper.style.width = newW + "px"
                    sideWrapper.style.minWidth = newW + "px"
                    document.documentElement.style.setProperty("--sidebar-width", newW + "px")
                    rafId = null
                })
            }

            function onUp() {
                if (rafId) {
                    cancelAnimationFrame(rafId)
                    rafId = null
                }
                sideHandle.classList.remove("dragging")
                sideWrapper.classList.remove("is-resizing")
                document.body.style.cursor = ""
                document.body.style.userSelect = ""
                document.removeEventListener("mousemove", onMove)
                document.removeEventListener("mouseup", onUp)
            }

            document.addEventListener("mousemove", onMove)
            document.addEventListener("mouseup", onUp)
        })
    }

    if (detailView && detailHandle && sidePanel) {
        let startY, startH

        detailHandle.addEventListener("mousedown", (e) => {
            e.preventDefault()
            startY = e.clientY
            startH = detailView.getBoundingClientRect().height
            detailHandle.classList.add("dragging")
            document.body.style.cursor = "row-resize"
            document.body.style.userSelect = "none"

            function onMove(e) {
                const delta = startY - e.clientY
                const newH = Math.min(DETAIL_MAX, Math.max(DETAIL_MIN, startH + delta))
                detailView.style.flex = `0 0 ${newH}px`
            }

            function onUp() {
                detailHandle.classList.remove("dragging")
                document.body.style.cursor = ""
                document.body.style.userSelect = ""
                document.removeEventListener("mousemove", onMove)
                document.removeEventListener("mouseup", onUp)
            }

            document.addEventListener("mousemove", onMove)
            document.addEventListener("mouseup", onUp)
        })
    }
}

function initMoneyToggle() {
    const btn = document.getElementById("toggleMoneyBtn")
    if (!btn) return

    const ocultarAlInicio = localStorage.getItem("portfolioOcultarInicio") === "1"
    const hidden = ocultarAlInicio || localStorage.getItem("moneyHidden") === "1"

    if (hidden) {
        document.body.classList.add("money-hidden")
        btn.classList.add("money-hidden-active")
        btn.title = "Mostrar valores"
        btn.textContent = "🙈"
        if (ocultarAlInicio) localStorage.setItem("moneyHidden", "1")
    }
    btn.addEventListener("click", () => {
        const isHidden = document.body.classList.toggle("money-hidden")
        btn.classList.toggle("money-hidden-active", isHidden)
        btn.title = isHidden ? "Mostrar valores" : "Ocultar valores"
        btn.textContent = isHidden ? "🙈" : "👁"
        localStorage.setItem("moneyHidden", isHidden ? "1" : "0")
    })
}

function applyDensidadSidebar(val) {
    if (val === "compact") {
        document.documentElement.dataset.density = "compact"
    } else {
        delete document.documentElement.dataset.density
    }
}

/* --- Rotación automática del detalle de activo --- */
let _assetRotationTimer = null
let _assetRotationBusy = false
let _assetRotationBound = false

function getAssetRotationConfig() {
    const seconds = Number(localStorage.getItem("assetRotationSeconds"))
    return {
        enabled: localStorage.getItem("assetRotationEnabled") === "1",
        seconds: Number.isFinite(seconds) && seconds >= 3 ? seconds : 10
    }
}

function applyAssetRotation() {
    const { enabled, seconds } = getAssetRotationConfig()

    if (_assetRotationTimer) {
        clearInterval(_assetRotationTimer)
        _assetRotationTimer = null
    }

    document.body.classList.toggle("asset-rotation-on", enabled)
    document.documentElement.style.setProperty("--rotation-duration", `${seconds}s`)

    if (!enabled) {
        document.body.classList.remove("asset-rotation-paused")
        return
    }

    initAssetRotationPause()
    restartAssetRotationBar()
    _assetRotationTimer = setInterval(() => {
        rotateAssetDetailStep().catch((error) => console.error("Rotación de activos:", error))
    }, seconds * 1000)
}

function initAssetRotationPause() {
    if (_assetRotationBound) return
    _assetRotationBound = true

    const sidePanel = document.getElementById("sidePanel")
    if (!sidePanel) return

    sidePanel.addEventListener("mouseenter", () => document.body.classList.add("asset-rotation-paused"))
    sidePanel.addEventListener("mouseleave", () => document.body.classList.remove("asset-rotation-paused"))
}

function isAssetRotationBlocked() {
    if (document.hidden) return true
    if (document.body.classList.contains("asset-rotation-paused")) return true
    if (document.getElementById("sideWrapper")?.classList.contains("collapsed")) return true
    if (document.querySelector(".modalOverlay:not(.hidden)")) return true
    // La ficha de un activo trabaja sobre currentAssetId: no lo cambiamos bajo los pies del usuario.
    if (document.querySelector(".assetTablePage")) return true
    return false
}

function restartAssetRotationBar() {
    const bar = document.getElementById("detailRotationBar")?.firstElementChild
    if (!bar) return
    bar.style.animation = "none"
    void bar.offsetWidth
    bar.style.animation = ""
}

async function rotateAssetDetailStep() {
    const blocked = isAssetRotationBlocked()
    document.body.classList.toggle("asset-rotation-halted", blocked)
    if (_assetRotationBusy || blocked) return

    const buttons = [...document.querySelectorAll("#assetsList .assetBtn:not(.assetBtnSegCustom)")].filter(
        (button) => button.dataset.assetId
    )

    if (buttons.length < 2) return

    const currentIndex = buttons.findIndex((button) => button.dataset.assetId === currentAssetId)
    const nextButton = buttons[(currentIndex + 1) % buttons.length]
    const nextAssetId = nextButton.dataset.assetId

    _assetRotationBusy = true
    try {
        const assetData = await loadAssetData(nextAssetId)
        currentAssetId = nextAssetId
        await updateAssetDetail(assetData)
        buttons.forEach((button) => button.classList.toggle("selected", button === nextButton))
        nextButton.scrollIntoView({ block: "nearest" })

        const detailView = document.getElementById("assetDetailView")
        if (detailView) {
            detailView.classList.remove("detailFadeIn")
            void detailView.offsetWidth
            detailView.classList.add("detailFadeIn")
        }
        restartAssetRotationBar()
    } finally {
        _assetRotationBusy = false
    }
}

let _inactivityTimer = null
function applyBloqueoInactividad(minutes) {
    if (_inactivityTimer) {
        clearTimeout(_inactivityTimer)
        _inactivityTimer = null
    }
    if (!minutes || minutes <= 0) return

    const ms = minutes * 60 * 1000
    const events = ["mousemove", "keydown", "click", "scroll", "touchstart"]

    function resetTimer() {
        if (_inactivityTimer) clearTimeout(_inactivityTimer)
        _inactivityTimer = setTimeout(() => {
            window.location.href = "/logout"
        }, ms)
    }

    events.forEach((ev) => document.addEventListener(ev, resetTimer, { passive: true }))
    resetTimer()
}
