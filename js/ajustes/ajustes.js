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
            if (page) page.classList.add("active")
        })
    })

    // Section drag-to-reorder
    document.querySelectorAll(".sttPage").forEach(_initSectionDrag)

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
    localStorage.setItem("sttSectionOrder-" + pageEl.id, JSON.stringify(data))
}

const _dragPlaceholder = (() => {
    const el = document.createElement("div")
    el.className = "ajustesDragPlaceholder"
    return el
})()

let _dragSrc = null

const _HANDLE_SVG = `<svg viewBox="0 0 10 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="2.5" cy="2" r="1.5"/><circle cx="7.5" cy="2" r="1.5"/><circle cx="2.5" cy="8" r="1.5"/><circle cx="7.5" cy="8" r="1.5"/><circle cx="2.5" cy="14" r="1.5"/><circle cx="7.5" cy="14" r="1.5"/></svg>`

function _buildPageColumns(pageEl) {
    const sections = [...pageEl.querySelectorAll(":scope > .ajustesSection")]
    const byTitle = new Map(sections.map((s) => [_sectionTitle(s), s]))

    const col0 = document.createElement("div")
    col0.className = "sttCol"
    const col1 = document.createElement("div")
    col1.className = "sttCol"

    const raw = localStorage.getItem("sttSectionOrder-" + pageEl.id)
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
            e.dataTransfer.effectAllowed = "move"
            requestAnimationFrame(() => sec.classList.add("ajustesDragging"))
        })

        sec.addEventListener("dragend", () => {
            sec.setAttribute("draggable", "false")
            sec.classList.remove("ajustesDragging")
            _dragPlaceholder.remove()
            _dragSrc = null
        })
    })

    colEl.addEventListener("dragover", (e) => {
        if (!_dragSrc) return
        e.preventDefault()
        e.dataTransfer.dropEffect = "move"

        const target = e.target.closest(".ajustesSection")
        if (target && target !== _dragSrc && target.parentElement === colEl) {
            const rect = target.getBoundingClientRect()
            const before = e.clientY < rect.top + rect.height / 2
            if (before) target.before(_dragPlaceholder)
            else target.after(_dragPlaceholder)
        } else if (!target || target === _dragSrc) {
            const last = [...colEl.querySelectorAll(":scope > .ajustesSection")].filter((s) => s !== _dragSrc).pop()
            if (last) last.after(_dragPlaceholder)
            else colEl.prepend(_dragPlaceholder)
        }
    })

    colEl.addEventListener("drop", (e) => {
        if (!_dragSrc) return
        e.preventDefault()
        if (_dragPlaceholder.parentElement) {
            _dragPlaceholder.replaceWith(_dragSrc)
            _saveSectionOrder(pageEl)
        }
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
            .map((c) => `<option value="${c.code}">${c.code} — ${c.name}</option>`)
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

    // --- API Keys ---
    const finnhubInput = document.getElementById("ajustesFinnhubKey")
    const eodhdInput = document.getElementById("ajustesEodhdKeys")
    const alphaVantageInput = document.getElementById("ajustesAlphaVantageKeys")
    const finnhubStatus = document.getElementById("ajustesFinnhubStatus")
    const eodhdStatus = document.getElementById("ajustesEodhdStatus")
    const alphaVantageStatus = document.getElementById("ajustesAlphaVantageStatus")
    const guardarFinnhubBtn = document.getElementById("ajustesGuardarFinnhubBtn")
    const guardarEodhdBtn = document.getElementById("ajustesGuardarEodhdBtn")
    const guardarAlphaVantageBtn = document.getElementById("ajustesGuardarAlphaVantageBtn")
    const finnhubMsg = document.getElementById("ajustesFinnhubMsg")
    const eodhdMsg = document.getElementById("ajustesEodhdMsg")
    const alphaVantageMsg = document.getElementById("ajustesAlphaVantageMsg")

    function setKeyStatus(el, count) {
        if (!el) return
        if (count > 0) {
            el.textContent = `✓ ${count} clave${count > 1 ? "s" : ""}`
            el.className = "ajustesKeyStatus ok"
        } else {
            el.textContent = "✗ No configurada"
            el.className = "ajustesKeyStatus missing"
        }
    }
    setKeyStatus(finnhubStatus, settings.finnhubKeyCount ?? (settings.finnhubKey ? 1 : 0))
    setKeyStatus(eodhdStatus, settings.eodhdKeyCount ?? (settings.eodhdKeys ? 1 : 0))
    setKeyStatus(alphaVantageStatus, settings.alphaVantageKeyCount ?? 0)

    // --- Claves guardadas: enmascaradas, y visibles al pulsar el ojo ---
    // El panel solo decía cuántas claves había. Con varias configuradas —y con
    // el proveedor pasando a la siguiente cuando una se queda sin cuota— «2
    // claves» no permite saber cuáles son ni si la que está fallando sigue ahí.
    const _OJO_SVG =
        '<svg class="ajustesEyeShow" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6Z" stroke="currentColor" stroke-width="1.5"/>' +
        '<circle cx="10" cy="10" r="2.5" stroke="currentColor" stroke-width="1.5"/></svg>' +
        '<svg class="ajustesEyeHide" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:none">' +
        '<path d="M3 3l14 14M8.46 8.54A3 3 0 0 0 10 13a3 3 0 0 0 2.54-4.54M6.1 6.16C3.9 7.4 2 10 2 10s3 6 8 6c1.5 0 2.9-.4 4.1-1.1M12.7 5.4A8.2 8.2 0 0 0 10 4C5 4 2 10 2 10s.8 1.6 2.3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

    const _proveedoresClaves = {
        finnhub: { lista: document.getElementById("ajustesFinnhubKeyList"), estado: finnhubStatus },
        eodhd: { lista: document.getElementById("ajustesEodhdKeyList"), estado: eodhdStatus },
        alphavantage: { lista: document.getElementById("ajustesAlphaVantageKeyList"), estado: alphaVantageStatus }
    }

    function _pintarIconoOjo(btn, visible) {
        const eyeShow = btn.querySelector(".ajustesEyeShow")
        const eyeHide = btn.querySelector(".ajustesEyeHide")
        if (eyeShow) eyeShow.style.display = visible ? "none" : ""
        if (eyeHide) eyeHide.style.display = visible ? "" : "none"
    }

    // El listado ya trae el valor completo, así que el ojo no va al servidor:
    // esta instalación es una LAN cerrada de un solo usuario, y pedir el texto
    // aparte solo añadía una petición por pulsación sin proteger de nada que la
    // propia conexión no expusiera ya.
    function _alternarClave(clave, valorEl, btn) {
        const visible = btn.dataset.visible !== "1"
        valorEl.textContent = visible ? clave.clave : clave.vista
        valorEl.classList.toggle("revelada", visible)
        btn.dataset.visible = visible ? "1" : ""
        btn.title = visible ? "Ocultar" : "Mostrar"
        _pintarIconoOjo(btn, visible)
    }

    function _pintarClaves(proveedor, claves) {
        const destino = _proveedoresClaves[proveedor]
        if (!destino?.lista) return

        destino.lista.innerHTML = ""
        setKeyStatus(destino.estado, claves.length)

        claves.forEach((clave) => {
            const fila = document.createElement("div")
            fila.className = "ajustesKeyRow"

            // El número no es decorativo: es el orden en que el proveedor las
            // recorre cuando una se queda sin cuota, y el que nombra el panel
            // de estado al decir cuál de ellas ha respondido.
            const numero = document.createElement("span")
            numero.className = "ajustesKeyRowNum"
            numero.textContent = String(clave.indice + 1)

            const valor = document.createElement("code")
            valor.className = "ajustesKeyRowValue"
            valor.textContent = clave.vista

            const ojo = document.createElement("button")
            ojo.type = "button"
            ojo.className = "ajustesToggleBtn ajustesKeyRowEye"
            ojo.title = "Mostrar"
            ojo.innerHTML = _OJO_SVG
            ojo.addEventListener("click", () => _alternarClave(clave, valor, ojo))

            fila.append(numero, valor, ojo)
            destino.lista.appendChild(fila)
        })
    }

    async function cargarClaves() {
        try {
            const res = await fetch("/api/settings/apikeys")
            const data = await res.json()
            if (!data.ok) return
            Object.entries(data.proveedores || {}).forEach(([proveedor, claves]) => {
                _pintarClaves(proveedor, claves || [])
            })
        } catch {
            // Sin lista, el contador de claves de /api/settings sigue estando:
            // se pierde el detalle, no la pantalla.
        }
    }

    cargarClaves()

    const _keyCountMap = {
        finnhubKey: "finnhubKeys",
        eodhdKeys: "eodhdKeys",
        alphaVantageKeys: "alphaVantageKeys"
    }

    async function saveApiKey(fieldName, value, input, statusEl, msgEl, btn) {
        const trimmed = value.trim()
        if (!trimmed) {
            showMsg(msgEl, "Escribe una clave para añadir", "error")
            return
        }
        btn.disabled = true
        showMsg(msgEl, "Guardando…", "")
        try {
            const res = await fetch("/api/settings/apikey", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ [fieldName]: trimmed })
            })
            const data = await res.json()
            if (data.ok) {
                const countKey = _keyCountMap[fieldName]
                const count = countKey ? data[countKey] : 1
                showMsg(msgEl, "Añadida", "ok")
                setKeyStatus(statusEl, count ?? 1)
                input.value = ""
                cargarClaves()
            } else {
                showMsg(msgEl, "Error al guardar", "error")
            }
        } catch {
            showMsg(msgEl, "Error de red", "error")
        } finally {
            btn.disabled = false
        }
    }

    if (guardarFinnhubBtn) {
        guardarFinnhubBtn.addEventListener("click", () =>
            saveApiKey(
                "finnhubKey",
                finnhubInput?.value || "",
                finnhubInput,
                finnhubStatus,
                finnhubMsg,
                guardarFinnhubBtn
            )
        )
    }
    if (guardarEodhdBtn) {
        guardarEodhdBtn.addEventListener("click", () =>
            saveApiKey("eodhdKeys", eodhdInput?.value || "", eodhdInput, eodhdStatus, eodhdMsg, guardarEodhdBtn)
        )
    }
    if (guardarAlphaVantageBtn) {
        guardarAlphaVantageBtn.addEventListener("click", () =>
            saveApiKey(
                "alphaVantageKeys",
                alphaVantageInput?.value || "",
                alphaVantageInput,
                alphaVantageStatus,
                alphaVantageMsg,
                guardarAlphaVantageBtn
            )
        )
    }

    // --- Auto-backup ---
    const autoBackupSel = document.getElementById("ajustesAutoBackup")
    const guardarFreqBtn = document.getElementById("ajustesGuardarBackupFreqBtn")
    const backupFreqMsg = document.getElementById("ajustesBackupFreqMsg")

    function setSelect(sel, value) {
        if (!sel) return
        sel.value = String(value)
        sel.dispatchEvent(new Event("change", { bubbles: false }))
    }

    if (autoBackupSel) setSelect(autoBackupSel, settings.autoBackupDays ?? 0)

    if (guardarFreqBtn) {
        guardarFreqBtn.addEventListener("click", async () => {
            guardarFreqBtn.disabled = true
            showMsg(backupFreqMsg, "Guardando…", "")
            try {
                const res = await fetch("/api/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ autoBackupDays: Number(autoBackupSel?.value || 0) })
                })
                const data = await res.json()
                showMsg(backupFreqMsg, data.ok ? "Guardado" : "Error", data.ok ? "ok" : "error")
            } catch {
                showMsg(backupFreqMsg, "Error de red", "error")
            } finally {
                guardarFreqBtn.disabled = false
            }
        })
    }

    // --- Tipos de cambio históricos ---
    // El relleno va por lotes: una cartera con años de operaciones son cientos
    // de peticiones al proveedor, y pedirlas todas en una sola llamada acabaría
    // en timeout. Aquí se encadenan las tandas y se va enseñando el avance.
    const fxPendientesEl = document.getElementById("ajustesFxPendientes")
    const rellenarFxBtn = document.getElementById("ajustesRellenarFxBtn")
    const fxMsg = document.getElementById("ajustesFxMsg")

    async function refrescarFxPendientes() {
        if (!fxPendientesEl) return 0
        try {
            const res = await fetch("/api/fx/pendientes")
            const data = await res.json()
            const pendientes = Number(data.pendientes || 0)
            fxPendientesEl.textContent = pendientes === 0 ? "Ninguna" : String(pendientes)
            if (rellenarFxBtn) rellenarFxBtn.disabled = pendientes === 0
            return pendientes
        } catch {
            fxPendientesEl.textContent = "—"
            return 0
        }
    }

    refrescarFxPendientes()

    if (rellenarFxBtn) {
        rellenarFxBtn.addEventListener("click", async () => {
            rellenarFxBtn.disabled = true
            let resueltas = 0
            let fallidas = 0
            try {
                // Tope de tandas: si el proveedor deja de responder, `pendientes`
                // no bajaría nunca y esto sería un bucle infinito contra la red.
                for (let tanda = 0; tanda < 40; tanda++) {
                    showMsg(fxMsg, `Consultando tipos de cambio… (${resueltas} resueltas)`, "")
                    const res = await fetch("/api/fx/rellenar", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ limite: 100 })
                    })
                    const data = await res.json()
                    if (!data.ok) break
                    resueltas += Number(data.resueltas || 0)
                    fallidas = Number(data.fallidas || 0)
                    fxPendientesEl.textContent = String(data.pendientes ?? 0)
                    // Sin avance no tiene sentido insistir: lo que queda son
                    // fechas que el proveedor no cubre.
                    if (!Number(data.resueltas) || !Number(data.pendientes)) break
                }
                const pendientes = await refrescarFxPendientes()
                if (pendientes > 0 || fallidas > 0) {
                    showMsg(
                        fxMsg,
                        `${resueltas} resueltas. Quedan ${pendientes} sin tipo de cambio: ` +
                            "el proveedor no cubre esas fechas o no respondió. Vuelve a intentarlo más tarde.",
                        "error"
                    )
                } else {
                    showMsg(fxMsg, `Histórico completo (${resueltas} operaciones).`, "ok")
                }
            } catch {
                showMsg(fxMsg, "Error de red", "error")
            } finally {
                rellenarFxBtn.disabled = false
                refrescarFxPendientes()
            }
        })
    }

    // --- Moneda base ---
    const monedaBaseSel = document.getElementById("ajustesMonedaBase")
    const guardarMonedaBaseBtn = document.getElementById("ajustesGuardarMonedaBaseBtn")
    const monedaBaseMsg = document.getElementById("ajustesMonedaBaseMsg")

    if (monedaBaseSel) setSelect(monedaBaseSel, settings.monedaBase ?? "EUR")

    if (guardarMonedaBaseBtn) {
        guardarMonedaBaseBtn.addEventListener("click", async () => {
            guardarMonedaBaseBtn.disabled = true
            showMsg(monedaBaseMsg, "Guardando…", "")
            try {
                const moneda = monedaBaseSel?.value ?? "EUR"
                const res = await fetch("/api/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ monedaBase: moneda })
                })
                const data = await res.json()
                if (data.ok) {
                    window._monedaBase = moneda
                    showMsg(monedaBaseMsg, "Guardado", "ok")
                } else {
                    showMsg(monedaBaseMsg, "Error", "error")
                }
            } catch {
                showMsg(monedaBaseMsg, "Error de red", "error")
            } finally {
                guardarMonedaBaseBtn.disabled = false
            }
        })
    }

    // --- Divisas fiat ---
    const divisasListEl = document.getElementById("ajustesDivisasList")
    const divisaCodeInp = document.getElementById("ajustesDivisaCode")
    const divisaNameInp = document.getElementById("ajustesDivisaName")
    const divisaAddBtn = document.getElementById("ajustesDivisaAddBtn")
    const divisaMsg = document.getElementById("ajustesDivisaMsg")

    let _divisas = [..._fiatCurrencies]

    function _currentMonedaBase() {
        return monedaBaseSel?.value || settings.monedaBase || "EUR"
    }

    function _rebuildMonedaBaseSelect() {
        const sel = document.getElementById("ajustesMonedaBase")
        if (!sel) return
        const current = sel.value || _currentMonedaBase()
        const wrapper = sel.closest(".ajustesDropWrapper")
        if (wrapper) {
            sel.innerHTML = _divisas.map((c) => `<option value="${c.code}">${c.code} — ${c.name}</option>`).join("")
            sel.value = _divisas.find((c) => c.code === current) ? current : _divisas[0]?.code || "EUR"
            wrapper.querySelector(".ajustesDropLabel").textContent = sel.options[sel.selectedIndex]?.text || sel.value
        } else {
            sel.innerHTML = _divisas.map((c) => `<option value="${c.code}">${c.code} — ${c.name}</option>`).join("")
            sel.value = _divisas.find((c) => c.code === current) ? current : _divisas[0]?.code || "EUR"
        }
        window._fiatCurrencies = _divisas.map((c) => c.code)
    }

    async function _saveDivisas() {
        await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fiatCurrencies: _divisas })
        })
    }

    function _renderDivisas() {
        if (!divisasListEl) return
        if (_divisas.length === 0) {
            divisasListEl.innerHTML = `<div class="ajustesBackupEmpty" style="padding:10px 24px">Sin divisas configuradas</div>`
            return
        }
        const base = _currentMonedaBase()
        divisasListEl.innerHTML = ""
        _divisas.forEach((c) => {
            const row = document.createElement("div")
            row.className = "ajustesHiddenItem"
            const label = document.createElement("span")
            label.className = "ajustesHiddenName"
            label.textContent = `${c.code} — ${c.name}`
            const btn = document.createElement("button")
            btn.type = "button"
            btn.className = "ajustesDivisaRemove"
            btn.textContent = "Eliminar"
            btn.disabled = c.code === base
            btn.title = c.code === base ? "Es la moneda base, cambia la moneda base primero" : `Eliminar ${c.code}`
            btn.addEventListener("click", async () => {
                _divisas = _divisas.filter((x) => x.code !== c.code)
                _renderDivisas()
                _rebuildMonedaBaseSelect()
                await _saveDivisas()
                showMsg(divisaMsg, `${c.code} eliminada`, "ok")
            })
            row.appendChild(label)
            row.appendChild(btn)
            divisasListEl.appendChild(row)
        })
    }

    _renderDivisas()

    if (divisaAddBtn) {
        divisaAddBtn.addEventListener("click", async () => {
            const code = (divisaCodeInp?.value || "").trim().toUpperCase()
            const name = (divisaNameInp?.value || "").trim()
            if (!code || !name) {
                showMsg(divisaMsg, "Rellena el código y el nombre", "error")
                return
            }
            if (!/^[A-Z]{2,5}$/.test(code)) {
                showMsg(divisaMsg, "El código debe ser 2-5 letras (ej: SEK)", "error")
                return
            }
            if (_divisas.some((c) => c.code === code)) {
                showMsg(divisaMsg, `${code} ya existe`, "error")
                return
            }
            _divisas.push({ code, name })
            if (divisaCodeInp) divisaCodeInp.value = ""
            if (divisaNameInp) divisaNameInp.value = ""
            _renderDivisas()
            _rebuildMonedaBaseSelect()
            await _saveDivisas()
            showMsg(divisaMsg, `${code} añadida`, "ok")
        })
    }

    if (divisaCodeInp) {
        divisaCodeInp.addEventListener("input", () => {
            divisaCodeInp.value = divisaCodeInp.value.toUpperCase()
        })
        divisaCodeInp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") divisaAddBtn?.click()
        })
    }
    if (divisaNameInp) {
        divisaNameInp.addEventListener("keydown", (e) => {
            if (e.key === "Enter") divisaAddBtn?.click()
        })
    }

    // --- Actualización de precios ---
    const autoRefreshGrid = document.getElementById("ajustesRefreshGrid")
    const autoRefreshMsg = document.getElementById("ajustesAutoRefreshMsg")

    function setActiveRefreshBtn(minutes) {
        autoRefreshGrid?.querySelectorAll(".ajustesRefreshBtn").forEach((btn) => {
            btn.classList.toggle("active", Number(btn.dataset.minutes) === Number(minutes))
        })
    }

    setActiveRefreshBtn(window._autoRefreshMinutes ?? settings.autoRefreshMinutes ?? 0)

    autoRefreshGrid?.addEventListener("click", async (e) => {
        const btn = e.target.closest(".ajustesRefreshBtn")
        if (!btn) return
        const minutes = Number(btn.dataset.minutes)
        setActiveRefreshBtn(minutes)
        try {
            const res = await fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ autoRefreshMinutes: minutes })
            })
            const data = await res.json()
            if (data.ok) {
                window._autoRefreshMinutes = minutes
                applyAutoRefresh(minutes)
                showMsg(autoRefreshMsg, "Guardado", "ok")
            } else {
                showMsg(autoRefreshMsg, "Error", "error")
            }
        } catch {
            showMsg(autoRefreshMsg, "Error de red", "error")
        }
    })

    // --- Evolución del portfolio (snapshots) ---
    const snapshotGrid = document.getElementById("ajustesSnapshotGrid")
    const snapshotMsg = document.getElementById("ajustesSnapshotMsg")

    function setActiveSnapshotBtn(minutes) {
        snapshotGrid?.querySelectorAll(".ajustesRefreshBtn").forEach((btn) => {
            btn.classList.toggle("active", Number(btn.dataset.minutes) === Number(minutes))
        })
    }

    setActiveSnapshotBtn(window._snapshotMinutes ?? settings.snapshotMinutes ?? 60)

    snapshotGrid?.addEventListener("click", async (e) => {
        const btn = e.target.closest(".ajustesRefreshBtn")
        if (!btn) return
        const minutes = Number(btn.dataset.minutes)
        setActiveSnapshotBtn(minutes)
        try {
            const res = await fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ snapshotMinutes: minutes })
            })
            const data = await res.json()
            if (data.ok) {
                window._snapshotMinutes = minutes
                applySnapshotSchedule(minutes)
                showMsg(snapshotMsg, "Guardado", "ok")
            } else {
                showMsg(snapshotMsg, "Error", "error")
            }
        } catch {
            showMsg(snapshotMsg, "Error de red", "error")
        }
    })

    // Alcance del hilo de snapshots del servidor. Se guarda al cambiar el
    // select: es una preferencia de una sola opción y un botón "Guardar" solo
    // añadiría un paso que olvidar.
    const snapshotAlcanceSel = document.getElementById("ajustesSnapshotAlcance")
    const snapshotAlcanceMsg = document.getElementById("ajustesSnapshotAlcanceMsg")

    if (snapshotAlcanceSel) {
        snapshotAlcanceSel.value = window._snapshotAlcance ?? settings.snapshotAlcance ?? "activo"

        snapshotAlcanceSel.addEventListener("change", async () => {
            const alcance = snapshotAlcanceSel.value
            try {
                const res = await fetch("/api/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ snapshotAlcance: alcance })
                })
                const data = await res.json()
                if (data.ok) {
                    window._snapshotAlcance = alcance
                    showMsg(snapshotAlcanceMsg, "Guardado", "ok")
                } else {
                    showMsg(snapshotAlcanceMsg, "Error", "error")
                }
            } catch {
                showMsg(snapshotAlcanceMsg, "Error de red", "error")
            }
        })
    }

    // --- Umbral cotizaciones ---
    const staleSel = document.getElementById("ajustesStaleHours")
    const guardarStaleBtn = document.getElementById("ajustesGuardarStaleBtn")
    const staleMsg = document.getElementById("ajustesStaleMsg")

    if (staleSel) setSelect(staleSel, settings.staleHours ?? 24)

    if (guardarStaleBtn) {
        guardarStaleBtn.addEventListener("click", async () => {
            guardarStaleBtn.disabled = true
            showMsg(staleMsg, "Guardando…", "")
            try {
                const hours = Number(staleSel?.value ?? 24)
                const res = await fetch("/api/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ staleHours: hours })
                })
                const data = await res.json()
                if (data.ok) {
                    window._settingsStaleHours = hours
                    showMsg(staleMsg, "Guardado", "ok")
                } else {
                    showMsg(staleMsg, "Error", "error")
                }
            } catch {
                showMsg(staleMsg, "Error de red", "error")
            } finally {
                guardarStaleBtn.disabled = false
            }
        })
    }

    // --- Activos ocultos ---
    const hiddenListEl = document.getElementById("ajustesHiddenList")
    const hiddenSet = new Set(settings.hiddenAssets || [])

    async function renderHiddenAssets() {
        if (!hiddenListEl) return
        try {
            const res = await fetch("/api/activos")
            const data = await res.json()
            const activos = data.activos || []
            if (!activos.length) {
                hiddenListEl.innerHTML = '<span class="ajustesBackupEmpty">No hay activos</span>'
                return
            }
            hiddenListEl.innerHTML = ""
            activos.forEach((a) => {
                const row = document.createElement("div")
                row.className = "ajustesHiddenItem"
                const label = document.createElement("span")
                label.className = "ajustesHiddenName"
                label.textContent = `${a.symbol || a.name} — ${a.name}`
                const toggle = document.createElement("button")
                const isHidden = hiddenSet.has(a.id)
                toggle.className = "ajustesHiddenToggle" + (isHidden ? " hidden" : "")
                toggle.textContent = isHidden ? "Oculto" : "Visible"
                toggle.addEventListener("click", async () => {
                    if (hiddenSet.has(a.id)) {
                        hiddenSet.delete(a.id)
                        toggle.textContent = "Visible"
                        toggle.classList.remove("hidden")
                    } else {
                        hiddenSet.add(a.id)
                        toggle.textContent = "Oculto"
                        toggle.classList.add("hidden")
                    }
                    const ids = [...hiddenSet]
                    await fetch("/api/settings", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ hiddenAssets: ids })
                    })
                    window._hiddenAssets = new Set(ids)
                    await refreshAssetsSidebar()
                })
                row.appendChild(label)
                row.appendChild(toggle)
                hiddenListEl.appendChild(row)
            })
        } catch {
            hiddenListEl.innerHTML = '<span class="ajustesBackupEmpty">Error al cargar</span>'
        }
    }
    renderHiddenAssets()

    // --- Backups ---
    const crearBtn = document.getElementById("ajustesCrearBackupBtn")
    const backupMsg = document.getElementById("ajustesBackupMsg")
    const listEl = document.getElementById("ajustesBackupList")

    async function loadBackupList() {
        if (!listEl) return
        listEl.innerHTML = '<span class="ajustesBackupEmpty">Cargando…</span>'
        try {
            const res = await fetch("/api/backups")
            const data = await res.json()
            renderBackups(data.backups || [])
        } catch {
            listEl.innerHTML = '<span class="ajustesBackupEmpty">Error al cargar</span>'
        }
    }

    function _backupDisplayName(filename) {
        const isZip = filename.endsWith(".zip")
        const base = filename
            .replace(/^(backup|portfolio)_/, "")
            .replace(/\.(zip|db)$/, "")
            .replace(/_(\d{2})-(\d{2})-(\d{2})$/, " $1:$2:$3")
        return isZip ? base : `${base} (legacy)`
    }

    function renderBackups(backups) {
        if (!listEl) return
        if (!backups.length) {
            listEl.innerHTML = '<span class="ajustesBackupEmpty">No hay backups disponibles</span>'
            return
        }
        listEl.innerHTML = ""
        backups.forEach((filename) => {
            const item = document.createElement("div")
            item.className = "ajustesBackupItem"
            const label = document.createElement("span")
            label.className = "ajustesBackupName"
            label.textContent = _backupDisplayName(filename)
            const restoreBtn = document.createElement("button")
            restoreBtn.className = "ajustesRestoreBtn"
            restoreBtn.textContent = "Restaurar"
            restoreBtn.addEventListener("click", () => restoreBackup(filename, restoreBtn))
            const deleteBtn = document.createElement("button")
            deleteBtn.className = "ajustesDeleteBackupBtn"
            deleteBtn.textContent = "✕"
            deleteBtn.title = "Eliminar backup"
            deleteBtn.addEventListener("click", () => deleteBackup(filename, item))
            item.appendChild(label)
            item.appendChild(restoreBtn)
            item.appendChild(deleteBtn)
            listEl.appendChild(item)
        })
    }

    async function deleteBackup(filename, itemEl) {
        const displayName = _backupDisplayName(filename)
        openConfirmModal({
            title: "Eliminar backup",
            message: `¿Eliminar la copia "${displayName}"? Esta acción no se puede deshacer.`,
            confirmLabel: "Eliminar",
            onConfirm: async () => {
                itemEl.style.opacity = "0.4"
                try {
                    const res = await fetch(`/api/backups/${encodeURIComponent(filename)}`, { method: "DELETE" })
                    const data = await res.json()
                    if (data.ok) {
                        renderBackups(data.backups || [])
                    } else {
                        showMsg(backupMsg, data.error || "Error al eliminar", "error")
                        itemEl.style.opacity = ""
                    }
                } catch {
                    showMsg(backupMsg, "Error de red", "error")
                    itemEl.style.opacity = ""
                }
            }
        })
    }

    async function restoreBackup(filename, btn) {
        const displayName = _backupDisplayName(filename)
        openConfirmModal({
            title: "Restaurar backup",
            message: `¿Restaurar "${displayName}"? Se sobreescribirán todos los datos actuales.`,
            confirmLabel: "Restaurar",
            onConfirm: () => _doRestore(filename, btn)
        })
    }

    async function _doRestore(filename, btn) {
        btn.disabled = true
        showMsg(backupMsg, "Restaurando…", "")
        try {
            const res = await fetch("/api/restore", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename })
            })
            const data = await res.json()
            if (data.ok) {
                // El servidor puede haber saltado entradas dañadas del zip y
                // seguir adelante con el resto. Un "Restaurado" a secas después
                // de perder un portfolio sería el peor mensaje posible: aquí no
                // se recarga sola, para que el aviso se pueda leer.
                const ignorados = data.ignorados || []
                if (ignorados.length) {
                    showMsg(
                        backupMsg,
                        `Restauración parcial: ${ignorados.length} entrada(s) no se pudieron ` +
                            `recuperar (${ignorados.join("; ")}). Recarga la página cuando lo hayas revisado.`,
                        "error"
                    )
                    btn.disabled = false
                    return
                }
                showMsg(backupMsg, "Restaurado. Recargando…", "ok")
                setTimeout(() => window.location.reload(), 1500)
            } else {
                showMsg(backupMsg, data.error || "Error al restaurar", "error")
                btn.disabled = false
            }
        } catch {
            showMsg(backupMsg, "Error de red", "error")
            btn.disabled = false
        }
    }

    if (crearBtn) {
        crearBtn.addEventListener("click", async () => {
            crearBtn.disabled = true
            showMsg(backupMsg, "Creando backup…", "")
            try {
                const res = await fetch("/api/backup", { method: "POST" })
                const data = await res.json()
                if (data.ok) {
                    showMsg(backupMsg, `Creado: ${data.filename}`, "ok")
                    renderBackups(data.backups || [])
                } else {
                    // El servidor incluye el motivo (por ejemplo permisos del
                    // volumen Docker o un bloqueo de SQLite). Ocultarlo con un
                    // mensaje genérico hacía imposible distinguir ambos casos.
                    showMsg(backupMsg, data.error || "Error al crear backup", "error")
                }
            } catch {
                showMsg(backupMsg, "Error de red", "error")
            } finally {
                crearBtn.disabled = false
            }
        })
    }

    loadBackupList()

    // --- Peticiones API ---
    const apiStatsListEl = document.getElementById("ajustesApiStatsList")
    const refreshApiStatsBtn = document.getElementById("ajustesRefreshApiStatsBtn")

    async function loadApiStats() {
        if (!apiStatsListEl) return
        try {
            const res = await fetch("/api/stats/api-calls")
            const data = await res.json()
            if (!data.ok) throw new Error()
            renderApiStats(data)
        } catch {
            if (apiStatsListEl) apiStatsListEl.innerHTML = '<span class="ajustesBackupEmpty">Error al cargar</span>'
        }
    }

    function renderApiStats(data) {
        if (!apiStatsListEl) return
        const counts = data.counts || {}
        const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
        if (!entries.length) {
            apiStatsListEl.innerHTML = '<span class="ajustesBackupEmpty">Sin peticiones hoy</span>'
            return
        }
        apiStatsListEl.innerHTML = ""
        entries.forEach(([provider, count]) => {
            const row = document.createElement("div")
            row.className = "ajustesApiStatsRow"
            row.innerHTML = `<span class="ajustesApiStatsProvider">${provider}</span><span class="ajustesApiStatsCount">${count}</span>`
            apiStatsListEl.appendChild(row)
        })
        const totalRow = document.createElement("div")
        totalRow.className = "ajustesApiStatsRow ajustesApiStatsTotal"
        totalRow.innerHTML = `<span class="ajustesApiStatsProvider">Total</span><span class="ajustesApiStatsCount">${data.total}</span>`
        apiStatsListEl.appendChild(totalRow)
    }

    if (refreshApiStatsBtn) {
        refreshApiStatsBtn.addEventListener("click", loadApiStats)
    }
    loadApiStats()

    // --- Estado de las APIs ---
    // El sondeo consume cuota de los proveedores, así que la carga normal se
    // conforma con lo que el servidor tenga cacheado; solo el botón fuerza una
    // comprobación nueva.
    const apiEstadoListEl = document.getElementById("ajustesApiEstadoList")
    const refreshApiEstadoBtn = document.getElementById("ajustesRefreshApiEstadoBtn")
    const apiEstadoMsg = document.getElementById("ajustesApiEstadoMsg")

    async function loadApiEstado(forzar = false) {
        if (!apiEstadoListEl) return
        if (refreshApiEstadoBtn) refreshApiEstadoBtn.disabled = true
        if (forzar) showMsg(apiEstadoMsg, "Comprobando…", "")
        try {
            const res = await fetch(`/api/stats/api-estado${forzar ? "?forzar=1" : ""}`)
            const data = await res.json()
            if (!data.ok) throw new Error(data.error || "")
            renderApiEstado(data)
            if (forzar) showMsg(apiEstadoMsg, "Comprobado", "ok")
        } catch {
            apiEstadoListEl.innerHTML = '<span class="ajustesBackupEmpty">No se pudo comprobar el estado</span>'
            if (forzar) showMsg(apiEstadoMsg, "Error al comprobar", "error")
        } finally {
            if (refreshApiEstadoBtn) refreshApiEstadoBtn.disabled = false
        }
    }

    function _edadTexto(segundos) {
        if (!Number.isFinite(segundos) || segundos <= 1) return "ahora mismo"
        if (segundos < 60) return `hace ${segundos} s`
        const minutos = Math.round(segundos / 60)
        return `hace ${minutos} min`
    }

    function renderApiEstado(data) {
        const proveedores = data.proveedores || []
        apiEstadoListEl.innerHTML = ""
        if (!proveedores.length) {
            apiEstadoListEl.innerHTML = '<span class="ajustesBackupEmpty">Sin proveedores configurados</span>'
            return
        }
        proveedores.forEach((p) => {
            const row = document.createElement("div")
            row.className = "ajustesApiEstadoRow"
            // El detalle (HTTP 429, motivo del corte…) va en el title: en la
            // fila solo cabe la etiqueta, pero al diagnosticar hace falta.
            if (p.detalle) row.title = p.detalle

            const nombre = document.createElement("span")
            nombre.className = "ajustesApiEstadoProvider"
            nombre.textContent = p.nombre

            const badge = document.createElement("span")
            badge.className = `ajustesApiEstadoBadge ${p.estado || "error"}`
            badge.textContent = p.etiqueta || p.estado || "—"

            row.appendChild(nombre)
            // Los milisegundos son la diferencia entre "va bien" y "va bien
            // pero tarda cuatro segundos", que es lo que precede a una caída.
            if (p.estado === "ok" && p.ms) {
                const ms = document.createElement("span")
                ms.className = "ajustesApiEstadoMs"
                ms.textContent = `${p.ms} ms`
                row.appendChild(ms)
            }
            row.appendChild(badge)
            apiEstadoListEl.appendChild(row)
        })

        const pie = document.createElement("div")
        pie.className = "ajustesApiEstadoPie"
        pie.textContent = `Comprobado ${_edadTexto(data.edadSegundos)}`
        apiEstadoListEl.appendChild(pie)
    }

    if (refreshApiEstadoBtn) {
        refreshApiEstadoBtn.addEventListener("click", () => loadApiEstado(true))
    }
    loadApiEstado()

    // --- HTTPS ---
    // Enciende y apaga el TLS del proxy que hay delante. El botón hace tres
    // cosas seguidas —configurar el proxy, guardar el estado y cambiar la
    // política de las cookies— y luego el navegador tiene que saltar a https://,
    // porque el puerto es el mismo y a partir de ese momento ya no habla claro.
    const tlsEstadoEl = document.getElementById("ajustesTlsEstado")
    const tlsNombresEl = document.getElementById("ajustesTlsNombres")
    const tlsActivarBtn = document.getElementById("ajustesTlsActivarBtn")
    const tlsDesactivarBtn = document.getElementById("ajustesTlsDesactivarBtn")
    const tlsCaEl = document.getElementById("ajustesTlsCa")
    const tlsMsg = document.getElementById("ajustesTlsMsg")

    function _pintarTls(data) {
        if (!tlsEstadoEl) return

        let clase = "off"
        let texto = "<strong>Desactivado.</strong> La contraseña y la cookie de sesión viajan en claro."

        if (!data.proxyDisponible) {
            clase = "roto"
            texto =
                "<strong>El proxy no responde.</strong> Comprueba que el contenedor <code>caddy</code> está en marcha; sin él no se puede activar el HTTPS."
        } else if (data.gestionadoPorEntorno) {
            clase = "on"
            texto =
                "<strong>Activado por configuración del servidor</strong> (<code>HTTPS_ENABLED</code> en <code>.env</code>). Se cambia allí, no desde aquí."
        } else if (data.activado) {
            clase = "on"
            const lista = (data.nombres || []).join(", ")
            texto = `<strong>Activado</strong> para ${lista || "(sin nombres)"}.`
        }

        tlsEstadoEl.className = "ajustesTlsEstado " + clase
        tlsEstadoEl.innerHTML =
            '<span class="ajustesTlsPunto"></span><span class="ajustesTlsEstadoTexto">' + texto + "</span>"

        // Sin proxy o con el HTTPS impuesto por .env no hay nada que pulsar:
        // un botón que solo puede devolver un error es peor que ninguno.
        const editable = data.proxyDisponible && !data.gestionadoPorEntorno
        if (tlsNombresEl) {
            tlsNombresEl.disabled = !editable
            // Solo se rellena si el usuario no ha escrito nada: al recargar tras
            // guardar, machacar lo que tenga a medias sería perder su trabajo.
            if (!tlsNombresEl.value.trim()) {
                const sugerencia = (data.nombres || []).length
                    ? data.nombres.join(", ")
                    : data.nombreActual || location.hostname || ""
                tlsNombresEl.value = sugerencia
            }
        }
        if (tlsActivarBtn) {
            tlsActivarBtn.style.display = editable && !data.activado ? "" : "none"
            tlsActivarBtn.disabled = !editable
        }
        if (tlsDesactivarBtn) {
            tlsDesactivarBtn.style.display = editable && data.activado ? "" : "none"
        }
        if (tlsCaEl) {
            tlsCaEl.style.display = data.activado && data.proxyDisponible ? "" : "none"
        }
    }

    async function loadTls() {
        if (!tlsEstadoEl) return
        try {
            const res = await fetch("/api/tls")
            const data = await res.json()
            if (data.ok) _pintarTls(data)
        } catch {
            tlsEstadoEl.className = "ajustesTlsEstado roto"
            tlsEstadoEl.innerHTML =
                '<span class="ajustesTlsPunto"></span><span class="ajustesTlsEstadoTexto">No se ha podido consultar el estado.</span>'
        }
    }

    // Tras activar, la página actual está en http:// y el servidor ya solo
    // atiende TLS en ese mismo puerto: cualquier petición siguiente fallaría sin
    // explicar por qué. Se avisa y se salta sola, dando margen para leerlo.
    function _saltarAHttps(nombres) {
        // Se mantiene el host por el que ha entrado si está entre los nombres
        // del certificado; si no, se usa el primero, que sí lo está. Saltar a un
        // nombre que no cubre el certificado daría un aviso evitable.
        const actual = location.hostname
        const destino = nombres.includes(actual) ? actual : nombres[0]
        const url = `https://${destino}${location.port ? ":" + location.port : ""}${location.pathname}`

        const aviso = document.createElement("div")
        aviso.className = "ajustesTlsSaltando"
        aviso.innerHTML =
            `<strong>HTTPS activado.</strong> Esta página se va a recargar en <code>${url}</code>. ` +
            "El navegador avisará del certificado hasta que instales la CA: descárgala desde este mismo panel y sigue las instrucciones."
        tlsCaEl?.parentNode?.insertBefore(aviso, tlsCaEl)

        setTimeout(() => {
            location.replace(url)
        }, 6000)
    }

    async function _guardarTls(activado) {
        const nombres = (tlsNombresEl?.value || "")
            .split(/[\n,;]+/)
            .map((n) => n.trim())
            .filter(Boolean)

        if (activado && !nombres.length) {
            showMsg(tlsMsg, "Escribe al menos un nombre o IP", "error")
            return
        }

        if (tlsActivarBtn) tlsActivarBtn.disabled = true
        if (tlsDesactivarBtn) tlsDesactivarBtn.disabled = true
        showMsg(tlsMsg, activado ? "Emitiendo certificado…" : "Desactivando…", "")

        try {
            const res = await fetch("/api/tls", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ activado, nombres })
            })
            const data = await res.json()
            if (!data.ok) {
                showMsg(tlsMsg, data.error || "No se ha podido aplicar", "error")
                return
            }
            _pintarTls(data)
            showMsg(tlsMsg, activado ? "HTTPS activado" : "HTTPS desactivado", "ok")
            if (activado) _saltarAHttps(data.nombres)
        } catch {
            // Al activar, el proxy recarga su configuración mientras esta misma
            // petición está en vuelo: es posible que haya funcionado y que la
            // respuesta no llegue, porque el puerto ya solo habla TLS. Decir
            // «error de red» sería mentir la mitad de las veces, así que se
            // salta igualmente y que lo confirme el propio navegador.
            if (activado) {
                showMsg(tlsMsg, "Aplicado; comprobando por https…", "")
                _saltarAHttps(nombres)
            } else {
                showMsg(tlsMsg, "Error de red", "error")
            }
        } finally {
            if (tlsActivarBtn) tlsActivarBtn.disabled = false
            if (tlsDesactivarBtn) tlsDesactivarBtn.disabled = false
        }
    }

    if (tlsActivarBtn) tlsActivarBtn.addEventListener("click", () => _guardarTls(true))
    if (tlsDesactivarBtn) tlsDesactivarBtn.addEventListener("click", () => _guardarTls(false))
    loadTls()

    // --- Cambiar nombre de usuario ---
    const credUserCurrentPwd = document.getElementById("ajustesCredUserCurrentPwd")
    const credNewUser = document.getElementById("ajustesCredNewUser")
    const guardarCredUserBtn = document.getElementById("ajustesGuardarCredUserBtn")
    const credUserMsg = document.getElementById("ajustesCredUserMsg")

    if (guardarCredUserBtn) {
        guardarCredUserBtn.addEventListener("click", async () => {
            const currentPassword = credUserCurrentPwd?.value || ""
            const newUsername = credNewUser?.value.trim() || ""

            if (!currentPassword) {
                showMsg(credUserMsg, "Introduce la contraseña actual", "error")
                return
            }
            if (!newUsername) {
                showMsg(credUserMsg, "El usuario no puede estar vacío", "error")
                return
            }

            guardarCredUserBtn.disabled = true
            showMsg(credUserMsg, "Guardando…", "")
            try {
                const res = await fetch("/api/settings/credentials/username", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ currentPassword, newUsername })
                })
                const data = await res.json()
                if (data.ok) {
                    showMsg(credUserMsg, "Usuario actualizado", "ok")
                    if (credUserCurrentPwd) credUserCurrentPwd.value = ""
                    if (credNewUser) credNewUser.value = ""
                } else {
                    showMsg(credUserMsg, data.error || "Error al guardar", "error")
                }
            } catch {
                showMsg(credUserMsg, "Error de red", "error")
            } finally {
                guardarCredUserBtn.disabled = false
            }
        })
    }

    // --- Cambiar contraseña ---
    const credPwdCurrentPwd = document.getElementById("ajustesCredPwdCurrentPwd")
    const credNewPwd = document.getElementById("ajustesCredNewPwd")
    const credNewPwd2 = document.getElementById("ajustesCredNewPwd2")
    const guardarCredPwdBtn = document.getElementById("ajustesGuardarCredPwdBtn")
    const credPwdMsg = document.getElementById("ajustesCredPwdMsg")

    if (guardarCredPwdBtn) {
        guardarCredPwdBtn.addEventListener("click", async () => {
            const currentPassword = credPwdCurrentPwd?.value || ""
            const newPassword = credNewPwd?.value || ""
            const newPassword2 = credNewPwd2?.value || ""

            if (!currentPassword) {
                showMsg(credPwdMsg, "Introduce la contraseña actual", "error")
                return
            }
            if (!newPassword) {
                showMsg(credPwdMsg, "La nueva contraseña no puede estar vacía", "error")
                return
            }
            if (newPassword !== newPassword2) {
                showMsg(credPwdMsg, "Las contraseñas no coinciden", "error")
                return
            }

            guardarCredPwdBtn.disabled = true
            showMsg(credPwdMsg, "Guardando…", "")
            try {
                const res = await fetch("/api/settings/credentials/password", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ currentPassword, newPassword })
                })
                const data = await res.json()
                if (data.ok) {
                    showMsg(credPwdMsg, "Contraseña actualizada", "ok")
                    if (credPwdCurrentPwd) credPwdCurrentPwd.value = ""
                    if (credNewPwd) credNewPwd.value = ""
                    if (credNewPwd2) credNewPwd2.value = ""
                } else {
                    showMsg(credPwdMsg, data.error || "Error al guardar", "error")
                }
            } catch {
                showMsg(credPwdMsg, "Error de red", "error")
            } finally {
                guardarCredPwdBtn.disabled = false
            }
        })
    }

    // --- Densidad sidebar ---
    const densidadGrid = document.getElementById("ajustesDensidadGrid")
    const densidadMsg = document.getElementById("ajustesDensidadMsg")
    const _currentDensity = localStorage.getItem("portfolioDensity") || "normal"
    function setActiveDensidadBtn(val) {
        densidadGrid
            ?.querySelectorAll(".ajustesRefreshBtn")
            .forEach((b) => b.classList.toggle("active", b.dataset.density === val))
    }
    setActiveDensidadBtn(_currentDensity)
    densidadGrid?.addEventListener("click", (e) => {
        const btn = e.target.closest(".ajustesRefreshBtn")
        if (!btn) return
        const val = btn.dataset.density
        setActiveDensidadBtn(val)
        localStorage.setItem("portfolioDensity", val)
        applyDensidadSidebar(val)
        showMsg(densidadMsg, "Guardado", "ok")
    })

    // --- Rotación del detalle de activo ---
    const rotacionChk = document.getElementById("ajustesRotacionActiva")
    const rotacionGrid = document.getElementById("ajustesRotacionGrid")
    const rotacionMsg = document.getElementById("ajustesRotacionMsg")

    function setActiveRotacionBtn(val) {
        rotacionGrid
            ?.querySelectorAll(".ajustesRefreshBtn")
            .forEach((b) => b.classList.toggle("active", b.dataset.rotation === String(val)))
    }

    if (rotacionChk) {
        const rotacionActiva = localStorage.getItem("assetRotationEnabled") === "1"
        const rotacionSegundos = localStorage.getItem("assetRotationSeconds") || "10"
        rotacionChk.checked = rotacionActiva
        setActiveRotacionBtn(rotacionSegundos)
        rotacionGrid?.classList.toggle("ajustesDisabledGroup", !rotacionActiva)

        rotacionChk.addEventListener("change", () => {
            localStorage.setItem("assetRotationEnabled", rotacionChk.checked ? "1" : "0")
            rotacionGrid?.classList.toggle("ajustesDisabledGroup", !rotacionChk.checked)
            applyAssetRotation()
            showMsg(rotacionMsg, rotacionChk.checked ? "Rotación activada" : "Rotación desactivada", "ok")
        })
    }

    rotacionGrid?.addEventListener("click", (e) => {
        const btn = e.target.closest(".ajustesRefreshBtn")
        if (!btn) return
        const val = btn.dataset.rotation
        setActiveRotacionBtn(val)
        localStorage.setItem("assetRotationSeconds", val)
        applyAssetRotation()
        showMsg(rotacionMsg, `Cambio cada ${val} s`, "ok")
    })

    // --- Ocultar valores al inicio ---
    const ocultarInicioChk = document.getElementById("ajustesOcultarInicio")
    if (ocultarInicioChk) {
        ocultarInicioChk.checked = localStorage.getItem("portfolioOcultarInicio") === "1"
        ocultarInicioChk.addEventListener("change", () => {
            localStorage.setItem("portfolioOcultarInicio", ocultarInicioChk.checked ? "1" : "0")
        })
    }

    // --- Decimales por tipo de activo ---
    const decimalesMsg = document.getElementById("ajustesDecimalesMsg")
    const decimalesTipos = document.getElementById("ajustesDecimalesTipos")
    const _decKeyMap = {
        acciones: "precioDecimalesAcciones",
        etfs: "precioDecimalesEtf",
        comoditis: "precioDecimalesComoditis",
        cripto: "precioDecimalesCripto"
    }
    function initDecimalesTipo(grid) {
        const tipo = grid.dataset.tipo
        const key = _decKeyMap[tipo]
        if (!key) return
        const saved = settings[key] ?? 2
        grid.querySelectorAll(".ajustesRefreshBtn").forEach((b) =>
            b.classList.toggle("active", Number(b.dataset.dec) === saved)
        )
        grid.addEventListener("click", async (e) => {
            const btn = e.target.closest(".ajustesRefreshBtn")
            if (!btn) return
            const dec = Number(btn.dataset.dec)
            grid.querySelectorAll(".ajustesRefreshBtn").forEach((b) =>
                b.classList.toggle("active", Number(b.dataset.dec) === dec)
            )
            try {
                const res = await fetch("/api/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ [key]: dec })
                })
                const data = await res.json()
                if (data.ok) {
                    window[`_precioDecimales_${tipo}`] = dec
                    showMsg(decimalesMsg, "Guardado", "ok")
                } else {
                    showMsg(decimalesMsg, "Error", "error")
                }
            } catch {
                showMsg(decimalesMsg, "Error de red", "error")
            }
        })
    }
    decimalesTipos?.querySelectorAll(".ajustesRefreshGrid[data-tipo]").forEach(initDecimalesTipo)

    // --- Solo horario de mercado ---
    const soloMercadoChk = document.getElementById("ajustesSoloMercado")
    const soloMercadoMsg = document.getElementById("ajustesSoloMercadoMsg")
    const mercadoTiposEl = document.getElementById("ajustesMercadoTipos")
    const _savedTipos = settings.soloMercadoTipos ?? ["acciones", "etfs", "comoditis"]

    if (soloMercadoChk) {
        soloMercadoChk.checked = !!settings.soloHorarioMercado
    }

    // Init per-type checkboxes
    mercadoTiposEl?.querySelectorAll("input[data-tipo]").forEach((chk) => {
        chk.checked = _savedTipos.includes(chk.dataset.tipo)
    })

    async function _saveSoloMercado() {
        const enabled = soloMercadoChk?.checked ?? false
        const tipos = [...(mercadoTiposEl?.querySelectorAll("input[data-tipo]:checked") || [])].map(
            (c) => c.dataset.tipo
        )
        try {
            const res = await fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ soloHorarioMercado: enabled, soloMercadoTipos: tipos })
            })
            const data = await res.json()
            if (data.ok) {
                window._soloHorarioMercado = enabled
                window._soloMercadoTipos = tipos
                showMsg(soloMercadoMsg, "Guardado", "ok")
            } else {
                showMsg(soloMercadoMsg, "Error", "error")
            }
        } catch {
            showMsg(soloMercadoMsg, "Error de red", "error")
        }
    }

    soloMercadoChk?.addEventListener("change", _saveSoloMercado)
    mercadoTiposEl
        ?.querySelectorAll("input[data-tipo]")
        .forEach((chk) => chk.addEventListener("change", _saveSoloMercado))

    // --- Bloqueo por inactividad ---
    const bloqueoSel = document.getElementById("ajustesBloqueoInactividad")
    const guardarBloqueoBtn = document.getElementById("ajustesGuardarBloqueoBtn")
    const bloqueoMsg = document.getElementById("ajustesBloqueoMsg")
    if (bloqueoSel) setSelect(bloqueoSel, settings.bloqueoInactividad ?? 0)
    if (guardarBloqueoBtn) {
        guardarBloqueoBtn.addEventListener("click", async () => {
            guardarBloqueoBtn.disabled = true
            showMsg(bloqueoMsg, "Guardando…", "")
            try {
                const minutes = Number(bloqueoSel?.value ?? 0)
                const res = await fetch("/api/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ bloqueoInactividad: minutes })
                })
                const data = await res.json()
                if (data.ok) {
                    window._bloqueoInactividad = minutes
                    applyBloqueoInactividad(minutes)
                    showMsg(bloqueoMsg, "Guardado", "ok")
                } else {
                    showMsg(bloqueoMsg, "Error", "error")
                }
            } catch {
                showMsg(bloqueoMsg, "Error de red", "error")
            } finally {
                guardarBloqueoBtn.disabled = false
            }
        })
    }

    // --- Exportar datos JSON ---
    const exportJsonBtn = document.getElementById("ajustesExportJsonBtn")
    const exportZipBtn = document.getElementById("ajustesExportZipBtn")
    const exportMsg = document.getElementById("ajustesExportMsg")

    async function _doExport(url, filename, btn) {
        btn.disabled = true
        showMsg(exportMsg, "Preparando…", "")
        try {
            const res = await fetch(url)
            if (!res.ok) throw new Error()
            const blob = await res.blob()
            const a = document.createElement("a")
            a.href = URL.createObjectURL(blob)
            a.download = filename
            a.click()
            URL.revokeObjectURL(a.href)
            showMsg(exportMsg, "Descargado", "ok")
        } catch {
            showMsg(exportMsg, "Error al exportar", "error")
        } finally {
            btn.disabled = false
        }
    }

    if (exportJsonBtn) {
        exportJsonBtn.addEventListener("click", () => {
            const date = new Date().toISOString().slice(0, 10)
            _doExport("/api/export/json", `portfolio-export-${date}.json`, exportJsonBtn)
        })
    }
    if (exportZipBtn) {
        exportZipBtn.addEventListener("click", () => {
            const date = new Date().toISOString().slice(0, 10)
            _doExport("/api/export/zip", `portfolio-export-${date}.zip`, exportZipBtn)
        })
    }

    // --- Importar datos JSON / ZIP ---
    const importJsonBtn = document.getElementById("ajustesImportJsonBtn")
    const importZipBtn = document.getElementById("ajustesImportZipBtn")
    const importJsonInput = document.getElementById("ajustesImportJsonInput")
    const importZipInput = document.getElementById("ajustesImportZipInput")
    const importMsg = document.getElementById("ajustesImportMsg")

    async function _doImport(url, file, btn) {
        btn.disabled = true
        showMsg(importMsg, "Importando…", "")
        try {
            const form = new FormData()
            form.append("file", file)
            const res = await fetch(url, { method: "POST", body: form })
            const data = await res.json()
            if (data.ok) {
                // Una importación parcial no puede anunciarse como un éxito a
                // secas: el usuario tiene que saber qué no ha entrado. Mismo
                // criterio que al restaurar una copia de seguridad.
                const ignorados = data.ignorados || []
                if (ignorados.length) {
                    showMsg(
                        importMsg,
                        `Importación parcial: ${ignorados.length} entrada(s) no se pudieron ` +
                            `recuperar (${ignorados.join("; ")}). Recarga la página cuando lo hayas revisado.`,
                        "error"
                    )
                    return
                }
                // Los datos que hay en pantalla ya no son los de la base: se
                // recarga, igual que después de restaurar.
                showMsg(importMsg, "Importado correctamente. Recargando…", "ok")
                setTimeout(() => window.location.reload(), 1500)
            } else {
                showMsg(importMsg, data.error || "Error al importar", "error")
            }
        } catch {
            showMsg(importMsg, "Error de red", "error")
        } finally {
            btn.disabled = false
        }
    }

    if (importJsonBtn && importJsonInput) {
        importJsonBtn.addEventListener("click", () => importJsonInput.click())
        importJsonInput.addEventListener("change", () => {
            const file = importJsonInput.files[0]
            if (!file) return
            importJsonInput.value = ""
            openConfirmModal({
                title: "Importar JSON",
                message:
                    "Esto sobreescribirá todos los datos y configuración del portfolio activo con el contenido del archivo. ¿Continuar?",
                confirmLabel: "Importar",
                onConfirm: () => _doImport("/api/import/json", file, importJsonBtn)
            })
        })
    }

    if (importZipBtn && importZipInput) {
        importZipBtn.addEventListener("click", () => importZipInput.click())
        importZipInput.addEventListener("change", () => {
            const file = importZipInput.files[0]
            if (!file) return
            importZipInput.value = ""
            openConfirmModal({
                title: "Importar ZIP",
                message:
                    "Vale tanto un ZIP exportado (restaura la cartera activa) como una copia de seguridad " +
                    "(restaura todas las carteras y la configuración). Los datos actuales serán reemplazados " +
                    "y se guardará antes una copia del estado actual. ¿Continuar?",
                confirmLabel: "Importar",
                onConfirm: () => _doImport("/api/import/zip", file, importZipBtn)
            })
        })
    }

    // --- Purgar snapshots ---
    const purgeDaysSel = document.getElementById("ajustesPurgeDays")
    const purgeBtn = document.getElementById("ajustesPurgeBtn")
    const purgeMsg = document.getElementById("ajustesPurgeMsg")
    if (purgeBtn) {
        purgeBtn.addEventListener("click", () => {
            const days = Number(purgeDaysSel?.value ?? 0)
            if (days === 0) {
                showMsg(purgeMsg, "Selecciona un período para purgar", "error")
                return
            }
            const label = purgeDaysSel?.options[purgeDaysSel.selectedIndex]?.text || `${days} días`
            const message =
                days === -1
                    ? "¿Eliminar TODO el historial de snapshots? Se guardará una copia en data/pre_restore/ antes de borrar."
                    : `¿Eliminar todos los snapshots anteriores a ${label}? Esta acción no se puede deshacer.`
            openConfirmModal({
                title: "Purgar historial",
                message,
                confirmLabel: "Purgar",
                onConfirm: async () => {
                    purgeBtn.disabled = true
                    showMsg(purgeMsg, "Purgando…", "")
                    try {
                        // El borrado total exige confirmación explícita en el servidor
                        const payload = days === -1 ? { days, confirm: "BORRAR TODO" } : { days }
                        const res = await fetch("/api/snapshots/purge", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(payload)
                        })
                        const data = await res.json()
                        if (data.ok) {
                            showMsg(purgeMsg, `Eliminados ${data.deleted} snapshots`, "ok")
                        } else {
                            showMsg(purgeMsg, data.error || "Error al purgar", "error")
                        }
                    } catch {
                        showMsg(purgeMsg, "Error de red", "error")
                    } finally {
                        purgeBtn.disabled = false
                    }
                }
            })
        })
    }

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
