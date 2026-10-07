// ── Settings Overlay ──────────────────────────────────────────────────────────

let _sttInited = false

async function openSettingsModal() {
    const overlay = document.getElementById("sttOverlay")
    if (!overlay) return
    overlay.classList.remove("hidden")

    if (!_sttInited) {
        _sttInited = true
        _initSttShell()
        await initAjustesLogic()
    } else {
        try {
            const res = await fetch("/api/settings")
            const data = await res.json()
            if (data.ok) {
                _syncModulosChecked(data.modulosConfig ?? {})
                _syncTopMetricsChecked(data.topMetricsConfig ?? {})
            }
        } catch {
            /* ignore */
        }
    }
}

function closeSettingsModal() {
    const overlay = document.getElementById("sttOverlay")
    if (!overlay) return
    overlay.classList.add("hidden")
}

function _initSttShell() {
    // Close button
    document.getElementById("sttCloseBtn")?.addEventListener("click", closeSettingsModal)

    // Escape key
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !document.getElementById("sttOverlay")?.classList.contains("hidden")) {
            closeSettingsModal()
        }
    })

    // Tab switching
    document.querySelectorAll(".sttNavBtn").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".sttNavBtn").forEach((b) => b.classList.remove("active"))
            document.querySelectorAll(".sttPage").forEach((p) => p.classList.remove("active"))
            btn.classList.add("active")
            const page = document.getElementById("sttPage-" + btn.dataset.stt)
            if (page) {
                page.classList.add("active")
                _balancearAlMostrar(page)
            }
        })
    })

    // Section drag-to-reorder
    document.querySelectorAll(".sttPage").forEach(_initSectionDrag)
    _balancearAlMostrar(document.querySelector(".sttPage.active"))

    // Prevent "no-drop" cursor when hovering gaps/title inside the overlay
    document.getElementById("sttOverlay")?.addEventListener("dragover", (e) => {
        if (_dragSrc) e.preventDefault()
    })
}

function _sectionTitle(el) {
    return el.querySelector(".ajustesSectionTitle")?.textContent?.trim() || ""
}

function _saveSectionOrder(pageEl) {
    const data = [...pageEl.querySelectorAll(":scope > .sttCol")].map((col) =>
        [...col.querySelectorAll(":scope > .ajustesSection")].map(_sectionTitle).filter(Boolean)
    )
    localStorage.setItem(_ORDER_KEY + pageEl.id, JSON.stringify(data))
}

// La clave lleva versión: el orden guardado por el reparto antiguo (mitad y
// mitad por número de bloques) dejaba una columna mucho más larga que la otra, y
// al respetarlo se seguirían viendo esos huecos. Cualquier arrastre nuevo se
// guarda con la clave actual.
const _ORDER_KEY = "sttSectionOrder2-"

// Reparto por defecto de una página: los bloques siguen en el orden del HTML
// —que los agrupa por tema— y se cortan en el punto que deja las dos columnas
// con la altura más parecida, para que no quede un hueco al pie de una de ellas.
// Solo se puede medir con la página visible, así que se hace al mostrarla; si el
// usuario ya la ha ordenado a mano, no se toca.
function _balancearPagina(pageEl) {
    if (!pageEl || localStorage.getItem(_ORDER_KEY + pageEl.id)) return
    const cols = [...pageEl.querySelectorAll(":scope > .sttCol")]
    if (cols.length !== 2) return
    const secciones = cols.flatMap((c) => [...c.querySelectorAll(":scope > .ajustesSection")])
    const alturas = secciones.map((s) => s.offsetHeight)
    if (!alturas.length || alturas.some((h) => h <= 0)) return

    const total = alturas.reduce((a, b) => a + b, 0)
    let acumulado = 0
    let corte = 0
    let mejor = Infinity
    for (let k = 0; k <= alturas.length; k++) {
        const dif = Math.abs(acumulado - (total - acumulado))
        if (dif < mejor) {
            mejor = dif
            corte = k
        }
        acumulado += alturas[k] || 0
    }
    secciones.forEach((s, i) => (i < corte ? cols[0] : cols[1]).appendChild(s))
}

// Las listas (copias, proveedores…) se rellenan después de abrir la página y
// cambian su altura: se vuelve a repartir una vez pasado ese primer momento.
function _balancearAlMostrar(pageEl) {
    if (!pageEl) return
    requestAnimationFrame(() => _balancearPagina(pageEl))
    setTimeout(() => {
        if (pageEl.classList.contains("active")) _balancearPagina(pageEl)
    }, 700)
}

let _dragSrc = null
let _dragHome = null
let _dragDropped = false

const _HANDLE_SVG = `<svg viewBox="0 0 10 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="2.5" cy="2" r="1.5"/><circle cx="7.5" cy="2" r="1.5"/><circle cx="2.5" cy="8" r="1.5"/><circle cx="7.5" cy="8" r="1.5"/><circle cx="2.5" cy="14" r="1.5"/><circle cx="7.5" cy="14" r="1.5"/></svg>`

function _buildPageColumns(pageEl) {
    const sections = [...pageEl.querySelectorAll(":scope > .ajustesSection")]
    const byTitle = new Map(sections.map((s) => [_sectionTitle(s), s]))

    const col0 = document.createElement("div")
    col0.className = "sttCol"
    const col1 = document.createElement("div")
    col1.className = "sttCol"

    const raw = localStorage.getItem(_ORDER_KEY + pageEl.id)
    if (raw) {
        try {
            const data = JSON.parse(raw)
            if (Array.isArray(data[0])) {
                const placed = new Set()
                ;[data[0] || [], data[1] || []].forEach((titles, ci) => {
                    const col = ci === 0 ? col0 : col1
                    titles.forEach((t) => {
                        const s = byTitle.get(t)
                        if (s && !placed.has(t)) {
                            col.appendChild(s)
                            placed.add(t)
                        }
                    })
                })
                sections
                    .filter((s) => !placed.has(_sectionTitle(s)))
                    .forEach((s, i) => (i % 2 === 0 ? col0 : col1).appendChild(s))
                pageEl.appendChild(col0)
                pageEl.appendChild(col1)
                return
            }
        } catch {
            /* ignore */
        }
    }

    const mid = Math.ceil(sections.length / 2)
    sections.forEach((s, i) => (i < mid ? col0 : col1).appendChild(s))
    pageEl.appendChild(col0)
    pageEl.appendChild(col1)
}

function _initColDrag(colEl, pageEl) {
    colEl.querySelectorAll(":scope > .ajustesSection").forEach((sec) => {
        const header = sec.querySelector(".ajustesSectionHeader")
        if (!header || header.querySelector(".ajustesDragHandle")) return

        const handle = document.createElement("button")
        handle.type = "button"
        handle.className = "ajustesDragHandle"
        handle.title = "Arrastrar para reordenar"
        handle.innerHTML = _HANDLE_SVG
        header.appendChild(handle)

        sec.setAttribute("draggable", "false")
        handle.addEventListener("mousedown", () => sec.setAttribute("draggable", "true"))
        handle.addEventListener("mouseup", () => sec.setAttribute("draggable", "false"))

        sec.addEventListener("dragstart", (e) => {
            _dragSrc = sec
            _dragDropped = false
            _dragHome = { parent: sec.parentElement, next: sec.nextElementSibling }
            e.dataTransfer.effectAllowed = "move"
            requestAnimationFrame(() => sec.classList.add("ajustesDragging"))
        })

        sec.addEventListener("dragend", () => {
            sec.setAttribute("draggable", "false")
            sec.classList.remove("ajustesDragging")
            // Arrastre cancelado: el panel vuelve a su sitio
            if (!_dragDropped && _dragHome) _dragHome.parent.insertBefore(sec, _dragHome.next)
            _dragSrc = null
            _dragHome = null
        })
    })

    colEl.addEventListener("dragover", (e) => {
        if (!_dragSrc) return
        e.preventDefault()
        e.dataTransfer.dropEffect = "move"

        // El propio panel hace de previsión: se coloca en vivo en el hueco donde caerá.
        const others = [...colEl.querySelectorAll(":scope > .ajustesSection")].filter((s) => s !== _dragSrc)
        const reference = others.find((s) => {
            const rect = s.getBoundingClientRect()
            return e.clientY < rect.top + rect.height / 2
        })
        moveDraggedAssetPreview(colEl, _dragSrc, reference || null)
    })

    colEl.addEventListener("drop", (e) => {
        if (!_dragSrc) return
        e.preventDefault()
        _dragDropped = true
        _saveSectionOrder(pageEl)
    })
}

function _initSectionDrag(pageEl) {
    _buildPageColumns(pageEl)
    pageEl.querySelectorAll(":scope > .sttCol").forEach((col) => _initColDrag(col, pageEl))
}

// ── Inline custom select for settings overlay ─────────────────────────────────

function _buildInlineSelect(sel) {
    if (sel._inlineInit) return
    sel._inlineInit = true
    sel._csInit = true

    const wrapper = document.createElement("div")
    wrapper.className = "ajustesDropWrapper"

    const trigger = document.createElement("button")
    trigger.type = "button"
    trigger.className = "ajustesDropTrigger"

    const labelEl = document.createElement("span")
    labelEl.className = "ajustesDropLabel"

    const arrowEl = document.createElement("span")
    arrowEl.className = "ajustesDropArrow"
    arrowEl.textContent = "▾"

    trigger.appendChild(labelEl)
    trigger.appendChild(arrowEl)

    const menu = document.createElement("div")
    menu.className = "ajustesDropMenu"
    menu.style.display = "none"

    wrapper.appendChild(trigger)
    wrapper.appendChild(menu)

    sel.parentNode.insertBefore(wrapper, sel)
    wrapper.appendChild(sel)
    sel.style.display = "none"

    function syncLabel() {
        const opt = sel.options[sel.selectedIndex]
        labelEl.textContent = opt ? opt.text : ""
    }

    function buildOptions() {
        menu.innerHTML = ""
        Array.from(sel.options).forEach((opt) => {
            const btn = document.createElement("button")
            btn.type = "button"
            btn.className = "ajustesDropOption" + (opt.value === sel.value ? " active" : "")
            btn.textContent = opt.text
            btn.addEventListener("click", () => {
                sel.value = opt.value
                sel.dispatchEvent(new Event("change", { bubbles: true }))
                syncLabel()
                close()
            })
            menu.appendChild(btn)
        })
    }

    function open() {
        buildOptions()
        menu.style.display = "flex"
        trigger.classList.add("open")
    }

    function close() {
        menu.style.display = "none"
        trigger.classList.remove("open")
    }

    trigger.addEventListener("click", (e) => {
        e.stopPropagation()
        const isOpen = menu.style.display !== "none"
        document.querySelectorAll(".ajustesDropMenu").forEach((m) => {
            m.style.display = "none"
            m.previousElementSibling?.classList.remove("open")
        })
        if (!isOpen) open()
    })

    document.addEventListener("click", close)

    sel.addEventListener("change", syncLabel)

    syncLabel()
}

// ── Settings Logic ────────────────────────────────────────────────────────────

async function initAjustesLogic() {
    let settings = {}
    try {
        const res = await fetch("/api/settings")
        const data = await res.json()
        if (data.ok) settings = data
    } catch {
        /* ignore */
    }

    // --- Populate monedaBase select from fiatCurrencies ---
    const _fiatCurrencies = settings.fiatCurrencies || [
        { code: "EUR", name: "Euro" },
        { code: "USD", name: "Dólar estadounidense" },
        { code: "GBP", name: "Libra esterlina" },
        { code: "CHF", name: "Franco suizo" },
        { code: "JPY", name: "Yen japonés" }
    ]
    window._fiatCurrencies = _fiatCurrencies.map((c) => c.code)
    const _monedaBaseSel0 = document.getElementById("ajustesMonedaBase")
    if (_monedaBaseSel0) {
        _monedaBaseSel0.innerHTML = _fiatCurrencies
            .map((c) => `<option value="${escapeHtml(c.code)}">${escapeHtml(c.code)} — ${escapeHtml(c.name)}</option>`)
            .join("")
    }

    document.querySelectorAll("#sttOverlay .ajustesSelect").forEach(_buildInlineSelect)

    // --- Toggle eye buttons (show/hide password) ---
    document.querySelectorAll(".ajustesToggleBtn").forEach((btn) => {
        btn.addEventListener("click", () => {
            const input = document.getElementById(btn.dataset.target)
            if (!input) return
            const showing = input.type === "password"
            input.type = showing ? "text" : "password"
            const eyeShow = btn.querySelector(".ajustesEyeShow")
            const eyeHide = btn.querySelector(".ajustesEyeHide")
            if (eyeShow) eyeShow.style.display = showing ? "none" : ""
            if (eyeHide) eyeHide.style.display = showing ? "" : "none"
        })
    })

    // Cada panel vive en su propio fichero (js/ajustes/ajustes-*.js).
    _initAjustesClaves(settings)
    _initAjustesTelegram()
    _initAjustesGeneral(settings, _fiatCurrencies)
    _initAjustesCopias()
    _initAjustesEstadoApis()
    _initAjustesAtajoHttps()
    _initAjustesCredenciales()
    _initAjustesApariencia(settings)
    _initAjustesActualizacion()
    _initAjustesDatos()

    // --- Formato de números ---
    const numLocaleGrid = document.getElementById("ajustesNumLocaleGrid")
    const numLocaleMsg = document.getElementById("ajustesNumLocaleMsg")

    function setActiveNumLocaleBtn(val) {
        numLocaleGrid
            ?.querySelectorAll(".ajustesRefreshBtn")
            .forEach((b) => b.classList.toggle("active", b.dataset.locale === val))
    }
    setActiveNumLocaleBtn(settings.numLocale ?? "es-ES")

    numLocaleGrid?.addEventListener("click", async (e) => {
        const btn = e.target.closest(".ajustesRefreshBtn")
        if (!btn) return
        const locale = btn.dataset.locale
        setActiveNumLocaleBtn(locale)
        try {
            const res = await fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ numLocale: locale })
            })
            const data = await res.json()
            if (data.ok) {
                window._numLocale = locale
                showMsg(numLocaleMsg, "Guardado", "ok")
            } else {
                showMsg(numLocaleMsg, "Error", "error")
            }
        } catch {
            showMsg(numLocaleMsg, "Error de red", "error")
        }
    })

    // --- Formato de fecha ---
    const dateFmtGrid = document.getElementById("ajustesDateFmtGrid")
    const dateFmtMsg = document.getElementById("ajustesDateFmtMsg")

    function setActiveDateFmtBtn(val) {
        dateFmtGrid
            ?.querySelectorAll(".ajustesRefreshBtn")
            .forEach((b) => b.classList.toggle("active", b.dataset.fmt === val))
    }
    setActiveDateFmtBtn(settings.dateFormat ?? "DD/MM/YYYY")

    dateFmtGrid?.addEventListener("click", async (e) => {
        const btn = e.target.closest(".ajustesRefreshBtn")
        if (!btn) return
        const fmt = btn.dataset.fmt
        setActiveDateFmtBtn(fmt)
        try {
            const res = await fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dateFormat: fmt })
            })
            const data = await res.json()
            if (data.ok) {
                window._dateFormat = fmt
                showMsg(dateFmtMsg, "Guardado", "ok")
            } else {
                showMsg(dateFmtMsg, "Error", "error")
            }
        } catch {
            showMsg(dateFmtMsg, "Error de red", "error")
        }
    })

    // --- Límite de backups ---
    const maxBackupsSel = document.getElementById("ajustesMaxBackups")
    const guardarMaxBackupsBtn = document.getElementById("ajustesGuardarMaxBackupsBtn")
    const maxBackupsMsg = document.getElementById("ajustesMaxBackupsMsg")

    if (maxBackupsSel) setSelect(maxBackupsSel, settings.maxBackups ?? 0)

    if (guardarMaxBackupsBtn) {
        guardarMaxBackupsBtn.addEventListener("click", async () => {
            guardarMaxBackupsBtn.disabled = true
            showMsg(maxBackupsMsg, "Guardando…", "")
            try {
                const res = await fetch("/api/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ maxBackups: Number(maxBackupsSel?.value ?? 0) })
                })
                const data = await res.json()
                showMsg(maxBackupsMsg, data.ok ? "Guardado" : "Error", data.ok ? "ok" : "error")
            } catch {
                showMsg(maxBackupsMsg, "Error de red", "error")
            } finally {
                guardarMaxBackupsBtn.disabled = false
            }
        })
    }

    // --- Tema ---
    initAjustesTema()

    // --- Módulos ---
    _initModulosToggles(settings)

    // --- Métricas del panel superior ---
    _initTopMetricsToggles(settings)
}

function setSelect(sel, value) {
    if (!sel) return
    sel.value = String(value)
    sel.dispatchEvent(new Event("change", { bubbles: false }))
}

// Popup de contraseña, compartido por exportar (ponerla) e importar
// (pedirla). Va por encima del panel de Ajustes (z-index 9000), que es
// desde donde se abre. `botones` es una lista de {etiqueta, clase, valor}:
// al pulsar uno se llama a onCerrar(valor, contrasena) con lo tecleado.
function _abrirModalContrasena({ titulo, texto, repetir = false, error = "", botones, onCerrar }) {
    document.getElementById("ajustesPassModalOverlay")?.remove()

    const overlay = document.createElement("div")
    overlay.id = "ajustesPassModalOverlay"
    overlay.className = "modalOverlay ajustesPassModalOverlay"

    const modal = document.createElement("div")
    modal.className = "assetModal ajustesPassModal"
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.innerHTML = `
        <h3 class="assetModalTitle">${titulo}</h3>
        <p class="ajustesPassModalText">${texto}</p>
        <label class="assetModalLabel" for="ajustesPassInput">Contraseña</label>
        <input id="ajustesPassInput" class="assetModalInput" type="password" autocomplete="new-password" spellcheck="false">
        ${
            repetir
                ? `<label class="assetModalLabel" for="ajustesPassRepeat">Repite la contraseña</label>
                   <input id="ajustesPassRepeat" class="assetModalInput" type="password" autocomplete="new-password" spellcheck="false">`
                : ""
        }
        <p class="ajustesPassModalError${error ? "" : " hidden"}" id="ajustesPassError">${error}</p>
        <div class="assetModalActions ajustesPassModalActions">
            ${botones
                .map(
                    (b, i) =>
                        `<button type="button" class="${escapeHtml(b.clase)}" data-pass-btn="${i}" data-no-autohide="true">${escapeHtml(b.etiqueta)}</button>`
                )
                .join("")}
        </div>
    `

    const input = modal.querySelector("#ajustesPassInput")
    const repeat = modal.querySelector("#ajustesPassRepeat")
    const errorEl = modal.querySelector("#ajustesPassError")
    const cerrar = () => {
        overlay.remove()
        document.removeEventListener("keydown", onKey)
    }
    const mostrarError = (msg) => {
        errorEl.textContent = msg
        errorEl.classList.remove("hidden")
    }
    const elegir = (indice) => {
        const boton = botones[indice]
        const contrasena = input.value
        if (boton.necesitaContrasena) {
            if (!contrasena) {
                mostrarError("Escribe una contraseña, o elige seguir sin ella.")
                input.focus()
                return
            }
            if (repeat && repeat.value !== contrasena) {
                mostrarError("Las dos contraseñas no coinciden.")
                repeat.focus()
                return
            }
        }
        cerrar()
        onCerrar(boton.valor, contrasena)
    }
    const onKey = (event) => {
        if (event.key === "Escape") {
            cerrar()
            onCerrar("cancelar", "")
        }
    }

    modal.querySelectorAll("[data-pass-btn]").forEach((btn) => {
        btn.addEventListener("click", () => elegir(Number(btn.dataset.passBtn)))
    })
    // Enter en el campo equivale al botón principal.
    ;[input, repeat].filter(Boolean).forEach((campo) => {
        campo.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault()
                elegir(botones.findIndex((b) => b.principal))
            }
        })
    })
    document.addEventListener("keydown", onKey)

    overlay.appendChild(modal)
    document.body.appendChild(overlay)
    input.focus()
}

function initAjustesTema() {
    const grid = document.getElementById("ajustesTemaGrid")
    if (!grid) return

    const current = localStorage.getItem("portfolioTheme") || "default"

    function applyTheme(theme) {
        if (theme === "default") {
            document.documentElement.removeAttribute("data-theme")
        } else {
            document.documentElement.setAttribute("data-theme", theme)
        }
        localStorage.setItem("portfolioTheme", theme)
        grid.querySelectorAll(".ajustesTemaBtn").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.theme === theme)
        })
        fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ theme })
        }).catch(() => {})
    }

    applyTheme(current)

    grid.addEventListener("click", (e) => {
        const btn = e.target.closest(".ajustesTemaBtn")
        if (!btn) return
        applyTheme(btn.dataset.theme)
    })
}

function showMsg(el, text, type) {
    if (!el) return
    el.textContent = text
    el.className = "ajustesStatusMsg" + (type ? " " + type : "")
    if (type === "ok" || type === "error") {
        setTimeout(() => {
            if (el) el.textContent = ""
        }, 3000)
    }
}

function _initTopMetricsToggles(settings) {
    const ALL_TOP_METRICS = [
        // Portfolio
        { id: "topTotalCuenta", label: "Total Cuenta", group: "Portfolio" },
        { id: "topPorcentajeCuenta", label: "% Rendimiento", group: "Portfolio" },
        { id: "topRendimientoEuros", label: "Rendimiento €", group: "Portfolio" },
        { id: "topInvertido", label: "Capital Invertido", group: "Portfolio" },
        { id: "topNumActivos", label: "Nº Activos", group: "Portfolio" },
        // Por tipo
        { id: "topPorcentajeAcciones", label: "% Acciones", group: "Por tipo" },
        { id: "topEurosAcciones", label: "€ Acciones", group: "Por tipo" },
        { id: "topPorcentajeEtf", label: "% ETF", group: "Por tipo" },
        { id: "topEurosEtf", label: "€ ETF", group: "Por tipo" },
        { id: "topPorcentajeComoditis", label: "% Comoditis", group: "Por tipo" },
        { id: "topEurosComoditis", label: "€ Comoditis", group: "Por tipo" },
        { id: "topPorcentajeCripto", label: "% Cripto", group: "Por tipo" },
        { id: "topEurosCripto", label: "€ Cripto", group: "Por tipo" },
        // Finanzas
        { id: "topTotalDividendos", label: "€ Dividendos", group: "Finanzas" },
        { id: "topTotalInteres", label: "€ C. Remunerada", group: "Finanzas" },
        { id: "topTotalRentaFija", label: "€ Renta Fija", group: "Finanzas" },
        { id: "topStaking", label: "Staking €", group: "Finanzas" },
        { id: "topMercadoPrivado", label: "Mercado Privado", group: "Finanzas" },
        // Operaciones
        { id: "topGastosAnio", label: "Gastos (año)", group: "Operaciones" },
        { id: "topIngresosAnio", label: "Ingresos (año)", group: "Operaciones" },
        { id: "topTradingPnL", label: "Trading P&L", group: "Operaciones" }
    ]

    const cfg = settings?.topMetricsConfig ?? window._topMetricsConfig ?? {}
    window._topMetricsConfig = cfg
    applyTopMetricsVisibility()

    function _isVisible(id) {
        return id in cfg ? cfg[id] : !_TOP_METRICS_DEFAULT_HIDDEN.has(id)
    }

    const container = document.getElementById("ajustesTopMetricsList")
    if (!container) return
    container.innerHTML = ""

    let currentGroup = null
    ALL_TOP_METRICS.forEach(({ id, label, group }, idx) => {
        if (group !== currentGroup) {
            currentGroup = group
            if (idx > 0) {
                const sep = document.createElement("div")
                sep.className = "ajustesSectionDivider"
                container.appendChild(sep)
            }
            const groupLabel = document.createElement("div")
            groupLabel.className = "ajustesTopMetricGroup"
            groupLabel.textContent = group
            container.appendChild(groupLabel)
        }

        const row = document.createElement("div")
        row.className = "ajustesSwitchRow"

        const labelDiv = document.createElement("div")
        labelDiv.className = "ajustesSwitchLabel"
        labelDiv.textContent = label

        const switchLabel = document.createElement("label")
        switchLabel.className = "ajustesSwitch"

        const chk = document.createElement("input")
        chk.type = "checkbox"
        chk.dataset.metricId = id
        chk.checked = _isVisible(id)
        chk.addEventListener("change", () => {
            const updated = Object.assign({}, window._topMetricsConfig || {})
            updated[id] = chk.checked
            window._topMetricsConfig = updated
            applyTopMetricsVisibility()
            fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ topMetricsConfig: updated })
            }).catch(() => {})
        })

        const track = document.createElement("span")
        track.className = "ajustesSwitchTrack"

        switchLabel.appendChild(chk)
        switchLabel.appendChild(track)
        row.appendChild(labelDiv)
        row.appendChild(switchLabel)
        container.appendChild(row)

        if (idx < ALL_TOP_METRICS.length - 1 && ALL_TOP_METRICS[idx + 1].group === group) {
            const div = document.createElement("div")
            div.className = "ajustesSectionDivider"
            container.appendChild(div)
        }
    })
}

const _MODULOS_MAP = {
    moduloPanelSuperior: "panelSuperior",
    moduloVistaGeneral: "vistaGeneral",
    moduloActivos: "activos",
    moduloGastos: "gastos",
    moduloFinanzas: "finanzas",
    moduloCripto: "cripto",
    moduloPlanes: "planes",
    moduloHerramientas: "herramientas",
    moduloMetricas: "metricas"
}

function _syncModulosChecked(cfg) {
    window._modulosConfig = cfg
    for (const [id, mod] of Object.entries(_MODULOS_MAP)) {
        const chk = document.getElementById(id)
        if (chk) chk.checked = cfg[mod] !== false
    }
}

function _syncTopMetricsChecked(cfg) {
    window._topMetricsConfig = cfg
    applyTopMetricsVisibility()
    const container = document.getElementById("ajustesTopMetricsList")
    if (!container) return
    container.querySelectorAll("input[type=checkbox]").forEach((chk) => {
        const id = chk.dataset.metricId
        if (!id) return
        chk.checked = id in cfg ? cfg[id] : !_TOP_METRICS_DEFAULT_HIDDEN.has(id)
    })
}

function _initModulosToggles(settings) {
    const cfg = settings?.modulosConfig ?? window._modulosConfig ?? {}
    _syncModulosChecked(cfg)

    for (const [id, mod] of Object.entries(_MODULOS_MAP)) {
        const chk = document.getElementById(id)
        if (!chk) continue
        chk.addEventListener("change", () => {
            window._modulosConfig = window._modulosConfig || {}
            window._modulosConfig[mod] = chk.checked
            applyModulesVisibility()
            fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ modulosConfig: window._modulosConfig })
            }).catch(() => {})
        })
    }
}
