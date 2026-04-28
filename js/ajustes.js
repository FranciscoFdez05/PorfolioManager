async function initAjustesLogic() {
    let settings = {}
    try {
        const res = await fetch("/api/settings")
        const data = await res.json()
        if (data.ok) settings = data
    } catch { /* ignore */ }

    // --- API Keys ---
    const finnhubInput      = document.getElementById("ajustesFinnhubKey")
    const eodhdInput        = document.getElementById("ajustesEodhdKeys")
    const finnhubStatus     = document.getElementById("ajustesFinnhubStatus")
    const eodhdStatus       = document.getElementById("ajustesEodhdStatus")
    const guardarFinnhubBtn = document.getElementById("ajustesGuardarFinnhubBtn")
    const guardarEodhdBtn   = document.getElementById("ajustesGuardarEodhdBtn")
    const finnhubMsg        = document.getElementById("ajustesFinnhubMsg")
    const eodhdMsg          = document.getElementById("ajustesEodhdMsg")

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
    setKeyStatus(eodhdStatus,   settings.eodhdKeyCount   ?? (settings.eodhdKeys  ? 1 : 0))

    document.querySelectorAll(".ajustesToggleBtn").forEach((btn) => {
        btn.addEventListener("click", () => {
            const input = document.getElementById(btn.dataset.target)
            if (!input) return
            input.type = input.type === "password" ? "text" : "password"
        })
    })

    async function saveApiKey(fieldName, value, input, statusEl, msgEl, btn) {
        const trimmed = value.trim()
        if (!trimmed) {
            showMsg(msgEl, "Escribe una clave para añadir", "error")
            return
        }
        btn.disabled = true
        showMsg(msgEl, "Guardando…", "")
        try {
            const res  = await fetch("/api/settings/apikey", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ [fieldName]: trimmed })
            })
            const data = await res.json()
            if (data.ok) {
                const count = fieldName === "finnhubKey" ? data.finnhubKeys : data.eodhdKeys
                showMsg(msgEl, "Añadida", "ok")
                setKeyStatus(statusEl, count ?? 1)
                input.value = ""
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
            saveApiKey("finnhubKey", finnhubInput?.value || "", finnhubInput, finnhubStatus, finnhubMsg, guardarFinnhubBtn)
        )
    }

    if (guardarEodhdBtn) {
        guardarEodhdBtn.addEventListener("click", () =>
            saveApiKey("eodhdKeys", eodhdInput?.value || "", eodhdInput, eodhdStatus, eodhdMsg, guardarEodhdBtn)
        )
    }

    // --- Auto-backup ---
    const autoBackupSel = document.getElementById("ajustesAutoBackup")
    const guardarFreqBtn = document.getElementById("ajustesGuardarBackupFreqBtn")
    const backupFreqMsg  = document.getElementById("ajustesBackupFreqMsg")

    if (autoBackupSel) autoBackupSel.value = String(settings.autoBackupDays ?? 0)

    if (guardarFreqBtn) {
        guardarFreqBtn.addEventListener("click", async () => {
            guardarFreqBtn.disabled = true
            showMsg(backupFreqMsg, "Guardando…", "")
            try {
                const res  = await fetch("/api/settings", {
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

    // --- Umbral cotizaciones ---
    const staleSel     = document.getElementById("ajustesStaleHours")
    const guardarStaleBtn = document.getElementById("ajustesGuardarStaleBtn")
    const staleMsg     = document.getElementById("ajustesStaleMsg")

    if (staleSel) staleSel.value = String(settings.staleHours ?? 24)

    if (guardarStaleBtn) {
        guardarStaleBtn.addEventListener("click", async () => {
            guardarStaleBtn.disabled = true
            showMsg(staleMsg, "Guardando…", "")
            try {
                const hours = Number(staleSel?.value ?? 24)
                const res   = await fetch("/api/settings", {
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
    const hiddenSet    = new Set(settings.hiddenAssets || [])

    async function renderHiddenAssets() {
        if (!hiddenListEl) return
        try {
            const res    = await fetch("/api/activos")
            const data   = await res.json()
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
    const crearBtn  = document.getElementById("ajustesCrearBackupBtn")
    const backupMsg = document.getElementById("ajustesBackupMsg")
    const listEl    = document.getElementById("ajustesBackupList")

    async function loadBackupList() {
        if (!listEl) return
        listEl.innerHTML = '<span class="ajustesBackupEmpty">Cargando…</span>'
        try {
            const res  = await fetch("/api/backups")
            const data = await res.json()
            renderBackups(data.backups || [])
        } catch {
            listEl.innerHTML = '<span class="ajustesBackupEmpty">Error al cargar</span>'
        }
    }

    function renderBackups(backups) {
        if (!listEl) return
        if (!backups.length) {
            listEl.innerHTML = '<span class="ajustesBackupEmpty">No hay backups disponibles</span>'
            return
        }
        listEl.innerHTML = ""
        backups.forEach((filename) => {
            const item  = document.createElement("div")
            item.className = "ajustesBackupItem"
            const label = document.createElement("span")
            label.className = "ajustesBackupName"
            // "portfolio_DD-MM-YYYY_HH-MM-SS.db" → "DD-MM-YYYY HH:MM:SS"
            const display = filename
                .replace("portfolio_", "")
                .replace(".db", "")
                .replace(/_(\d{2})-(\d{2})-(\d{2})$/, " $1:$2:$3")
            label.textContent = display
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
        const displayName = filename.replace("portfolio_", "").replace(".db", "").replace(/_(\d{2})-(\d{2})-(\d{2})$/, " $1:$2:$3")
        openConfirmModal({
            title: "Eliminar backup",
            message: `¿Eliminar la copia "${displayName}"? Esta acción no se puede deshacer.`,
            confirmLabel: "Eliminar",
            onConfirm: async () => {
                itemEl.style.opacity = "0.4"
                try {
                    const res  = await fetch(`/api/backups/${encodeURIComponent(filename)}`, { method: "DELETE" })
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
        const displayName = filename.replace("portfolio_", "").replace(".db", "").replace(/_(\d{2})-(\d{2})-(\d{2})$/, " $1:$2:$3")
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
            const res  = await fetch("/api/restore", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename })
            })
            const data = await res.json()
            if (data.ok) {
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
                const res  = await fetch("/api/backup", { method: "POST" })
                const data = await res.json()
                if (data.ok) {
                    showMsg(backupMsg, `Creado: ${data.filename}`, "ok")
                    renderBackups(data.backups || [])
                } else {
                    showMsg(backupMsg, "Error al crear backup", "error")
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
    const apiStatsListEl     = document.getElementById("ajustesApiStatsList")
    const refreshApiStatsBtn = document.getElementById("ajustesRefreshApiStatsBtn")

    async function loadApiStats() {
        if (!apiStatsListEl) return
        try {
            const res  = await fetch("/api/stats/api-calls")
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

    // --- Tema ---
    initAjustesTema()

    // --- Drag & lock ---
    initAjustesDragLock()
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

function initAjustesDragLock() {
    const layout   = document.getElementById("ajustesLayout")
    const colLeft  = document.getElementById("ajustesColLeft")
    const colRight = document.getElementById("ajustesColRight")
    if (!layout || !colLeft || !colRight) return

    const LOCKS_KEY = "ajustesLocksV2"
    const ORDER_KEY = "ajustesOrderV2"

    // Load persisted locks (per section id)
    let locks = {}
    try { locks = JSON.parse(localStorage.getItem(LOCKS_KEY) || "{}") } catch { locks = {} }

    // Apply saved column order
    const savedOrder = JSON.parse(localStorage.getItem(ORDER_KEY) || "null")
    if (savedOrder && savedOrder.left && savedOrder.right) {
        savedOrder.left.forEach((id) => {
            const el = layout.querySelector(`[data-ajuste-id="${id}"]`)
            if (el) colLeft.appendChild(el)
        })
        savedOrder.right.forEach((id) => {
            const el = layout.querySelector(`[data-ajuste-id="${id}"]`)
            if (el) colRight.appendChild(el)
        })
    }

    function saveOrder() {
        const left  = [...colLeft.querySelectorAll(".ajustesSection")].map((s) => s.dataset.ajusteId)
        const right = [...colRight.querySelectorAll(".ajustesSection")].map((s) => s.dataset.ajusteId)
        localStorage.setItem(ORDER_KEY, JSON.stringify({ left, right }))
    }

    function isLocked(sec) {
        return locks[sec.dataset.ajusteId] !== false
    }

    function applySection(sec) {
        const locked = isLocked(sec)
        const btn = sec.querySelector(".ajustesLockBtn")
        sec.draggable = !locked
        sec.classList.toggle("ajustesUnlocked", !locked)
        if (btn) btn.textContent = locked ? "🔒" : "🔓"
    }

    layout.querySelectorAll(".ajustesSection").forEach(applySection)

    // Toggle individual lock on click
    layout.addEventListener("click", (e) => {
        if (!e.target.classList.contains("ajustesLockBtn")) return
        const sec = e.target.closest(".ajustesSection")
        if (!sec) return
        const id = sec.dataset.ajusteId
        locks[id] = !isLocked(sec)   // flip
        localStorage.setItem(LOCKS_KEY, JSON.stringify(locks))
        applySection(sec)
    })

    // Drag & drop (cross-column)
    let dragSrc = null

    layout.addEventListener("dragstart", (e) => {
        const sec = e.target.closest(".ajustesSection")
        if (!sec || isLocked(sec)) return
        dragSrc = sec
        sec.classList.add("ajustesDragging")
        e.dataTransfer.effectAllowed = "move"
    })

    // Allow drop on both columns and their sections
    ;[colLeft, colRight].forEach((col) => {
        col.addEventListener("dragover", (e) => {
            if (!dragSrc) return
            e.preventDefault()
            e.dataTransfer.dropEffect = "move"

            const target = e.target.closest(".ajustesSection")
            if (target && target !== dragSrc) {
                const rect  = target.getBoundingClientRect()
                const after = e.clientY > rect.top + rect.height / 2
                col.insertBefore(dragSrc, after ? target.nextSibling : target)
            } else if (!target) {
                // Dropped onto empty col area — append
                col.appendChild(dragSrc)
            }
        })
    })

    layout.addEventListener("dragend", () => {
        if (dragSrc) dragSrc.classList.remove("ajustesDragging")
        dragSrc = null
        saveOrder()
    })
}

function showMsg(el, text, type) {
    if (!el) return
    el.textContent = text
    el.className = "ajustesStatusMsg" + (type ? " " + type : "")
    if (type === "ok" || type === "error") {
        setTimeout(() => { if (el) el.textContent = "" }, 3000)
    }
}
