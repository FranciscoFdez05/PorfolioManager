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

    const _mensajesClaves = { finnhub: finnhubMsg, eodhd: eodhdMsg, alphavantage: alphaVantageMsg }

    const _NOMBRES_PROVEEDOR = { finnhub: "Finnhub", eodhd: "EODHD", alphavantage: "Alpha Vantage" }

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

    function _borrarClave(proveedor, clave, restantes, fila) {
        const nombre = _NOMBRES_PROVEEDOR[proveedor] || proveedor
        // Que sea la última importa: al quedarse sin claves el proveedor deja
        // de dar precios, y eso no se ve hasta el siguiente refresco.
        const aviso = restantes === 1 ? ` Es la única que queda, así que ${nombre} dejará de actualizar precios.` : ""

        openConfirmModal({
            title: "Eliminar clave",
            message: `¿Eliminar la clave ${clave.vista} de ${nombre}?${aviso} Esta acción no se puede deshacer.`,
            confirmLabel: "Eliminar",
            onConfirm: async () => {
                fila.style.opacity = "0.4"
                try {
                    const res = await fetch("/api/settings/apikey", {
                        method: "DELETE",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ proveedor, clave: clave.clave })
                    })
                    const data = await res.json()
                    if (data.ok) {
                        cargarClaves()
                    } else {
                        showMsg(_mensajesClaves[proveedor], data.error || "Error al eliminar", "error")
                        fila.style.opacity = ""
                    }
                } catch {
                    showMsg(_mensajesClaves[proveedor], "Error de red", "error")
                    fila.style.opacity = ""
                }
            }
        })
    }

    function _plural(n, singular, plural) {
        return `${n} ${n === 1 ? singular : plural}`
    }

    // Manda el fichero, que es lo que gestiona esta pantalla; la variable de
    // entorno es el respaldo cuando no hay ninguna guardada. El aviso está para
    // que nunca haya que adivinar cuál de los dos sitios está mandando.
    function _avisoDeOrigen(info) {
        let texto = ""

        if (info.origen === "entorno") {
            texto =
                `Estas claves salen de ${info.variable}, en el .env del servidor, porque ` +
                `API/${info.fichero} está vacío. En cuanto añadas una aquí, mandará la de aquí.`
        } else if (info.ignoradas) {
            texto =
                `${_plural(info.ignoradas, "clave configurada", "claves configuradas")} en ${info.variable} ` +
                `que no se están usando: manda lo que hay en esta lista. Puedes vaciar esa variable del .env.`
        }

        if (!texto) return null

        const aviso = document.createElement("div")
        aviso.className = "ajustesAviso"
        aviso.textContent = texto
        return aviso
    }

    function _pintarClaves(proveedor, info) {
        const destino = _proveedoresClaves[proveedor]
        if (!destino?.lista) return

        const claves = info.claves || []
        const delEntorno = info.origen === "entorno"

        destino.lista.innerHTML = ""
        setKeyStatus(destino.estado, claves.length)

        const aviso = _avisoDeOrigen(info)
        if (aviso) destino.lista.appendChild(aviso)

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

            // Una clave del entorno no vive en el fichero, así que no hay nada
            // que borrar: se quita del .env del servidor.
            if (!delEntorno) {
                const borrar = document.createElement("button")
                borrar.type = "button"
                borrar.className = "ajustesKeyRowDel"
                borrar.textContent = "✕"
                borrar.title = "Eliminar clave"
                borrar.addEventListener("click", () => _borrarClave(proveedor, clave, claves.length, fila))
                fila.appendChild(borrar)
            }

            destino.lista.appendChild(fila)
        })
    }

    async function cargarClaves() {
        try {
            const res = await fetch("/api/settings/apikeys")
            const data = await res.json()
            if (!data.ok) return
            Object.entries(data.proveedores || {}).forEach(([proveedor, info]) => {
                _pintarClaves(proveedor, info || {})
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
    // --- Atajo de iOS ---
    // El Atajo tenía todas sus piezas fuera de la vista: la clave en un fichero,
    // el interruptor y las redes en config.ini, y el diagnóstico solo en el log
    // del servidor. Cuando fallaba —y lo que falla casi siempre es que no hay
    // clave— la única forma de enterarse era entrar por SSH a leer los logs.
    const atajoEstadoEl = document.getElementById("ajustesAtajoEstado")
    const atajoDatosEl = document.getElementById("ajustesAtajoDatos")
    const atajoUrlEl = document.getElementById("ajustesAtajoUrl")
    const atajoRedesEl = document.getElementById("ajustesAtajoRedes")
    const atajoToleranciaEl = document.getElementById("ajustesAtajoTolerancia")
    const atajoDescargarBtn = document.getElementById("ajustesAtajoDescargarBtn")
    const atajoProbarBtn = document.getElementById("ajustesAtajoProbarBtn")
    const atajoClaveBtn = document.getElementById("ajustesAtajoClaveBtn")
    const atajoMsg = document.getElementById("ajustesAtajoMsg")
    const atajoPruebaRes = document.getElementById("ajustesAtajoPruebaRes")
    const atajoRecetaEl = document.getElementById("ajustesAtajoReceta")

    let _atajoHayClave = false

    function _pintarAtajo(data) {
        if (!atajoEstadoEl) return

        let clase = "on"
        let texto = "<strong>Listo.</strong> Descarga el atajo y ábrelo en el iPhone."

        if (!data.activado) {
            clase = "roto"
            texto =
                "<strong>Desactivado.</strong> <code>[atajo] activado = false</code> en <code>config.ini</code>: estos endpoints responden 404."
        } else if (!data.redes || !data.redes.length) {
            clase = "roto"
            texto =
                "<strong>Sin redes permitidas.</strong> <code>[atajo] redes_permitidas</code> está vacío, y vacío no significa «todas»: no se acepta a nadie."
        } else if (!data.clave || !data.clave.hay) {
            clase = "off"
            texto =
                data.clave && data.clave.origen === "ilegible"
                    ? `<strong>La clave no se puede leer.</strong> ${data.clave.detalle}`
                    : "<strong>Falta la clave de firma.</strong> Sin ella el servidor responde 503 y el Atajo no puede enviar nada. Se genera aquí mismo."
        } else if (data.clave.origen === "entorno") {
            texto = `<strong>Listo.</strong> La clave sale de <code>${data.clave.detalle}</code>, en el <code>.env</code> del servidor.`
        }

        atajoEstadoEl.className = "ajustesAtajoEstado " + clase
        atajoEstadoEl.innerHTML =
            '<span class="ajustesTlsPunto"></span><span class="ajustesTlsEstadoTexto">' + texto + "</span>"

        _atajoHayClave = !!(data.clave && data.clave.hay)

        if (atajoDatosEl) atajoDatosEl.hidden = false
        if (atajoUrlEl) atajoUrlEl.textContent = data.urlBase || "—"
        if (atajoRedesEl) atajoRedesEl.textContent = (data.redes || []).join(", ") || "ninguna"
        if (atajoToleranciaEl) atajoToleranciaEl.textContent = `±${data.tolerancia} s`

        if (atajoClaveBtn) {
            // Generar y regenerar son la misma llamada, pero no la misma
            // decisión: con una clave puesta, el botón tiene que decir que la
            // sustituye.
            atajoClaveBtn.textContent = _atajoHayClave ? "Regenerar clave" : "Generar clave"
        }
        // Descargar el atajo sin clave da un atajo que no va a poder enviar nada.
        if (atajoDescargarBtn) atajoDescargarBtn.classList.toggle("ajustesBtnApagado", !_atajoHayClave)

        _pintarRecetaAtajo(data.urlBase || "")
    }

    function _pintarRecetaAtajo(url) {
        if (!atajoRecetaEl) return

        // Las mismas acciones que lleva el fichero, por si iOS lo rechaza. Salen
        // de docs/atajo-ios.md, que es donde está el porqué de cada una.
        const pasos = [
            ["Obtener contenido de la URL", `${url}/api/portfolios-lista`, "GET"],
            ["Obtener valor del diccionario", "clave <code>nombres</code>", ""],
            ["Elegir de la lista", "→ Establecer variable <code>bbdd</code>", ""],
            [
                "Texto",
                "<code>gasto</code> e <code>ingreso</code> en dos líneas → Dividir texto → Elegir de la lista → variable <code>tipo</code>",
                ""
            ],
            [
                "Obtener contenido de la URL",
                `${url}/api/categorias?portfolio=<em>bbdd</em>&amp;tipo=<em>tipo</em>`,
                "GET"
            ],
            [
                "Obtener valor del diccionario",
                "clave <code>lista</code> → Elegir de la lista → variable <code>categoria</code>",
                ""
            ],
            [
                "Pedir entrada",
                "Texto «¿Concepto?» → variable <code>nombre</code>, y Número «¿Importe?» → variable <code>importe</code>",
                ""
            ],
            [
                "Obtener contenido de la URL",
                `${url}/api/preparar`,
                "POST · cuerpo JSON con tipo, categoria, nombre, importe y portfolio"
            ],
            [
                "Obtener valor del diccionario",
                "claves <code>cuerpo</code>, <code>firma</code> y <code>timestamp</code> → variables <code>envio</code>, <code>sello</code> y <code>marca</code>",
                ""
            ],
            [
                "Obtener contenido de la URL",
                `${url}/api/movimiento`,
                "POST · cabeceras X-Signature y X-Timestamp · cuerpo <strong>Archivo</strong> = envio"
            ]
        ]

        const filas = pasos
            .map(
                ([accion, detalle, extra]) =>
                    `<li><strong>${accion}</strong> — ${detalle}${extra ? ` <span class="ajustesAtajoExtra">${extra}</span>` : ""}</li>`
            )
            .join("")

        atajoRecetaEl.innerHTML =
            "<p>La fecha no se pregunta: la pone el servidor con el día en que llega la petición.</p>" +
            `<ol class="ajustesAtajoPasos">${filas}</ol>` +
            "<p>El cuerpo del último paso va como <strong>Archivo</strong>, no como JSON: con JSON, Atajos vuelve a serializar el texto, cambian los bytes y la firma falla con un 401 que parece un problema de clave sin serlo.</p>"
    }

    async function loadAtajo() {
        if (!atajoEstadoEl) return
        try {
            const res = await fetch("/api/atajo")
            const data = await res.json()
            if (data.ok) _pintarAtajo(data)
        } catch {
            atajoEstadoEl.className = "ajustesAtajoEstado roto"
            atajoEstadoEl.innerHTML =
                '<span class="ajustesTlsPunto"></span><span class="ajustesTlsEstadoTexto">No se ha podido consultar el estado.</span>'
        }
    }

    async function _generarClaveAtajo() {
        // Solo se pregunta al sustituir una que ya funciona, y se dice lo que
        // NO pasa, que es lo que se teme: no hay que rehacer el atajo del
        // iPhone, porque no guarda la clave.
        const aviso =
            "Vas a sustituir la clave de firma actual.\n\nNo hace falta rehacer el atajo del iPhone: no guarda la clave, se la pide al servidor en cada uso."
        if (_atajoHayClave && !window.confirm(aviso)) return

        if (atajoClaveBtn) atajoClaveBtn.disabled = true
        showMsg(atajoMsg, "Generando…", "")

        try {
            const res = await fetch("/api/atajo/clave", { method: "POST" })
            const data = await res.json()
            if (!data.ok) {
                showMsg(atajoMsg, data.error || "No se ha podido generar", "error")
                return
            }
            _pintarAtajo(data)
            showMsg(atajoMsg, `Clave escrita en ${data.fichero}`, "ok")
        } catch {
            showMsg(atajoMsg, "Error de red", "error")
        } finally {
            if (atajoClaveBtn) atajoClaveBtn.disabled = false
        }
    }

    function _filaPasoAtajo(paso) {
        const fila = document.createElement("div")
        fila.className = "ajustesTlsPruebaFila " + (paso.ok ? "ok" : "mal")

        const nombre = document.createElement("span")
        nombre.className = "ajustesTlsPruebaNombre"
        nombre.textContent = paso.paso
        fila.appendChild(nombre)

        const detalle = document.createElement("span")
        detalle.className = "ajustesTlsPruebaDetalle"
        // textContent: el detalle puede traer rutas y mensajes del servidor.
        detalle.textContent = paso.detalle || ""
        fila.appendChild(detalle)

        return fila
    }

    async function _probarAtajo() {
        if (atajoProbarBtn) atajoProbarBtn.disabled = true
        showMsg(atajoMsg, "Comprobando…", "")

        try {
            const res = await fetch("/api/atajo/prueba", { method: "POST" })
            const data = await res.json()

            if (atajoPruebaRes) {
                atajoPruebaRes.hidden = false
                atajoPruebaRes.textContent = ""
                ;(data.pasos || []).forEach((paso) => atajoPruebaRes.appendChild(_filaPasoAtajo(paso)))
            }

            showMsg(atajoMsg, data.ok ? "Todo listo" : "Hay algo sin configurar", data.ok ? "ok" : "error")
        } catch {
            showMsg(atajoMsg, "Error de red", "error")
        } finally {
            if (atajoProbarBtn) atajoProbarBtn.disabled = false
        }
    }

    if (atajoClaveBtn) atajoClaveBtn.addEventListener("click", _generarClaveAtajo)
    if (atajoProbarBtn) atajoProbarBtn.addEventListener("click", _probarAtajo)
    loadAtajo()

    // Enciende y apaga el TLS del proxy que hay delante, en dos pulsaciones que
    // no se pueden juntar. La segunda —activar— configura el proxy, guarda el
    // estado y cambia la política de las cookies, y después el navegador tiene
    // que saltar a https:// porque el puerto es el mismo y a partir de ese
    // momento ya no habla claro. Por eso la primera existe: emitir el
    // certificado sin tocar el esquema, para que dé tiempo a instalarlo en cada
    // aparato mientras esta misma página sigue siendo alcanzable.
    const tlsEstadoEl = document.getElementById("ajustesTlsEstado")
    const tlsNombresEl = document.getElementById("ajustesTlsNombres")
    const tlsAvisoNombreEl = document.getElementById("ajustesTlsAvisoNombre")
    const tlsPrepararBtn = document.getElementById("ajustesTlsPrepararBtn")
    const tlsActivarBtn = document.getElementById("ajustesTlsActivarBtn")
    const tlsDesactivarBtn = document.getElementById("ajustesTlsDesactivarBtn")
    const tlsCaEl = document.getElementById("ajustesTlsCa")
    const tlsPaso2El = document.getElementById("ajustesTlsPaso2")
    const tlsConfirmaEl = document.getElementById("ajustesTlsConfirma")
    const tlsActivarMsg = document.getElementById("ajustesTlsActivarMsg")
    const tlsMsg = document.getElementById("ajustesTlsMsg")
    const tlsGuiaEl = document.getElementById("ajustesTlsGuia")
    const tlsPruebaEl = document.getElementById("ajustesTlsPrueba")
    const tlsPruebaBtn = document.getElementById("ajustesTlsPruebaBtn")
    const tlsPruebaMsg = document.getElementById("ajustesTlsPruebaMsg")
    const tlsPruebaRes = document.getElementById("ajustesTlsPruebaRes")
    const tlsPruebaAparatoBtn = document.getElementById("ajustesTlsPruebaAparatoBtn")
    const tlsPruebaAparatoHint = document.getElementById("ajustesTlsPruebaAparatoHint")
    const tlsAparatoResEl = document.getElementById("ajustesTlsAparatoRes")
    const tlsConfianzaEl = document.getElementById("ajustesTlsConfianza")
    const tlsConfirmaFila = document.getElementById("ajustesTlsConfirmaFila")

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
        } else if (data.caDisponible) {
            // A medias, y decirlo importa: quien vuelve a esta pantalla después
            // de instalar el certificado en el móvil tiene que ver que lo que
            // queda es encenderlo, no volver a emitirlo.
            texto =
                "<strong>Desactivado, con el certificado ya emitido.</strong> Instálalo en cada aparato y enciéndelo aquí abajo; hasta entonces, la contraseña y la cookie de sesión siguen viajando en claro."
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
                // La sugerencia la calcula el servidor: incluye la IP del
                // servidor en la LAN, que desde el navegador no hay forma de
                // saber y es justo la que se olvida al emitir el certificado.
                const sugerencia = (data.nombres || []).length
                    ? data.nombres.join(", ")
                    : (data.nombresSugeridos || []).join(", ") || data.nombreActual || location.hostname || ""
                tlsNombresEl.value = sugerencia
            }
        }
        const cifrando = data.activado && data.proxyDisponible
        // Con la CA ya emitida, el paso que toca no es emitirla otra vez: es
        // instalarla y encender. La hay tras preparar y también si el HTTPS
        // estuvo puesto alguna vez, porque la raíz vive en el volumen de Caddy.
        const conCa = !!data.caDisponible
        if (tlsPrepararBtn) {
            tlsPrepararBtn.style.display = editable && !data.activado && !conCa ? "" : "none"
            tlsPrepararBtn.disabled = !editable
        }
        if (tlsDesactivarBtn) {
            tlsDesactivarBtn.style.display = editable && data.activado ? "" : "none"
        }
        // El bloque del certificado ya no espera a que haya HTTPS: aparecer solo
        // después era el problema —para descargarlo había que atravesar el aviso
        // que provocaba no tenerlo—, así que se enseña en cuanto existe algo que
        // descargar.
        if (tlsCaEl) {
            tlsCaEl.style.display = cifrando || conCa ? "" : "none"
        }
        // Y colgando de él, el segundo paso: encender. Solo mientras esté
        // apagado; con el HTTPS puesto, lo que se ofrece debajo es comprobarlo.
        if (tlsPaso2El) {
            tlsPaso2El.style.display = editable && !data.activado && conCa ? "" : "none"
        }
        _avisarSiTeDejasFuera()
        // La comprobación también se adelanta: sirve para el certificado ya
        // emitido, no solo para el HTTPS ya puesto. Era el orden equivocado
        // —comprobar después de apostarse la sesión es un diagnóstico, no una
        // comprobación—, y es lo que se viene a arreglar.
        if (tlsPruebaEl) {
            tlsPruebaEl.style.display = cifrando || conCa ? "" : "none"
        }
        _pintarPruebaAparato(data)
        // La guía explica cómo encenderlo: con el HTTPS ya puesto sobra, y lo
        // que hace falta entonces —instalar la CA, comprobar— sale justo debajo.
        if (tlsGuiaEl) {
            tlsGuiaEl.style.display = editable && !data.activado ? "" : "none"
        }
        // Un resultado de antes de apagar el HTTPS seguiría diciendo «todo
        // correcto» sobre una conexión que ya va en claro.
        if (tlsPruebaRes && !cifrando) tlsPruebaRes.hidden = true
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

    function _nombresEscritos() {
        return (tlsNombresEl?.value || "")
            .split(/[\n,;]+/)
            .map((n) => n.trim())
            .filter(Boolean)
    }

    // Misma limpieza que hace el servidor, para que el aviso de aquí abajo no
    // salte por un `https://` o un `:5000` que el certificado no ve.
    function _nombreLimpio(bruto) {
        return String(bruto)
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .split("/")[0]
            .split(":")[0]
            .replace(/\.$/, "")
    }

    // El fallo que se lleva por delante el acceso: emitir un certificado que no
    // cubre la dirección por la que estás entrando. Al saltar a https:// el
    // navegador corta, y esta pantalla —la única desde la que se arregla— queda
    // detrás del aviso. El servidor lo rechaza igualmente; esto lo dice antes,
    // que es cuando todavía es un renglón que falta y no un problema.
    function _avisarSiTeDejasFuera() {
        if (!tlsAvisoNombreEl) return

        const actual = _nombreLimpio(location.hostname)
        const escritos = _nombresEscritos().map(_nombreLimpio)
        // localhost y 127.0.0.1 los añade el servidor siempre, se escriban o no.
        const cubierto = !actual || actual === "localhost" || actual === "127.0.0.1" || escritos.includes(actual)

        tlsAvisoNombreEl.hidden = cubierto
        if (cubierto) return

        tlsAvisoNombreEl.textContent = ""
        const texto = document.createElement("span")
        texto.innerHTML =
            `Estás entrando por <code>${actual}</code> y no está en la lista. ` +
            "Tal y como está, al activar el HTTPS tu propio navegador rechazaría la conexión."
        tlsAvisoNombreEl.appendChild(texto)

        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = "ajustesTlsAvisoBtn"
        btn.textContent = `Añadir ${actual}`
        btn.addEventListener("click", () => {
            const lista = _nombresEscritos()
            lista.push(actual)
            if (tlsNombresEl) tlsNombresEl.value = lista.join(", ")
            _avisarSiTeDejasFuera()
        })
        tlsAvisoNombreEl.appendChild(btn)
    }

    // --- Paso 1: emitir el certificado ---
    // No enciende nada. El proxy sigue sirviendo en claro por el mismo puerto y
    // esta página sigue donde estaba; lo único que cambia es que a partir de
    // aquí ya hay una CA que descargar e instalar. Que sea un paso aparte es el
    // arreglo: emitir e instalar tienen que caber antes de que el navegador
    // empiece a exigir un certificado que todavía no conoce.
    async function _prepararTls() {
        const nombres = _nombresEscritos()
        if (!nombres.length) {
            showMsg(tlsMsg, "Escribe al menos un nombre o IP", "error")
            return
        }

        if (tlsPrepararBtn) tlsPrepararBtn.disabled = true
        showMsg(tlsMsg, "Emitiendo el certificado…", "")

        try {
            const res = await fetch("/api/tls/preparar", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ nombres })
            })
            const data = await res.json()
            if (!data.ok) {
                showMsg(tlsMsg, data.error || "No se ha podido emitir", "error")
                return
            }
            _pintarTls(data)
            showMsg(tlsMsg, "Certificado emitido. Descárgalo e instálalo.", "ok")
            // Lo que hay que hacer ahora está más abajo y el panel es largo: sin
            // esto, la respuesta al botón es un cambio fuera de la pantalla.
            tlsCaEl?.scrollIntoView({ behavior: "smooth", block: "nearest" })
        } catch {
            // Aquí un error de red es un error de red y nada más: a diferencia
            // de activar, esta petición no toca el esquema por el que ha venido.
            showMsg(tlsMsg, "Error de red", "error")
        } finally {
            if (tlsPrepararBtn) tlsPrepararBtn.disabled = false
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
            "Si algún aparato avisa del certificado, es que ahí falta por instalar: el enlace para descargarlo sigue en este mismo panel."
        tlsPaso2El?.appendChild(aviso)

        setTimeout(() => {
            location.replace(url)
        }, 6000)
    }

    // --- Paso 2: encender ---
    async function _guardarTls(activado) {
        const nombres = _nombresEscritos()
        const msg = activado ? tlsActivarMsg : tlsMsg

        if (activado && !nombres.length) {
            showMsg(msg, "Escribe al menos un nombre o IP", "error")
            return
        }

        if (tlsActivarBtn) tlsActivarBtn.disabled = true
        if (tlsDesactivarBtn) tlsDesactivarBtn.disabled = true
        showMsg(msg, activado ? "Activando…" : "Desactivando…", "")

        try {
            const res = await fetch("/api/tls", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ activado, nombres })
            })
            const data = await res.json()
            if (!data.ok) {
                showMsg(msg, data.error || "No se ha podido aplicar", "error")
                return
            }
            _pintarTls(data)
            showMsg(msg, activado ? "HTTPS activado" : "HTTPS desactivado", "ok")
            if (activado) _saltarAHttps(data.nombres)
        } catch {
            // Al activar, el proxy recarga su configuración mientras esta misma
            // petición está en vuelo: es posible que haya funcionado y que la
            // respuesta no llegue, porque el puerto ya solo habla TLS. Decir
            // «error de red» sería mentir la mitad de las veces, así que se
            // salta igualmente y que lo confirme el propio navegador.
            if (activado) {
                showMsg(msg, "Aplicado; comprobando por https…", "")
                _saltarAHttps(nombres)
            } else {
                showMsg(msg, "Error de red", "error")
            }
        } finally {
            _permitirActivar()
            if (tlsDesactivarBtn) tlsDesactivarBtn.disabled = false
        }
    }

    // --- Comprobar el certificado ---
    // El estado de arriba solo repite lo que se pidió. Esto abre una conexión de
    // verdad contra el proxy por cada nombre declarado y valida el certificado
    // contra la CA que el usuario se descarga aquí mismo, que es la diferencia
    // entre «quedó guardado el interruptor» y «el navegador va a dejar de avisar».

    // --- Probar en este aparato ---
    // La única pregunta que el servidor no puede contestar: ¿se fía ESTE
    // navegador del certificado? Nadie más que él lo sabe. Se le da una página
    // servida con el mismo certificado en el puerto de comprobación: si carga,
    // la CA está bien instalada aquí; si avisa, avisaría igual con el HTTPS
    // puesto —y se ha averiguado sin ponerlo—.
    // --- Comprobar en este aparato ---
    // La única pregunta que el servidor no puede contestar: ¿se fía ESTE
    // navegador del certificado? Antes se resolvía abriendo una pestaña y
    // mirando, o sea pidiéndole al usuario que interpretara un aviso. Ahora la
    // hace el propio panel: si el fetch a la página de comprobación resuelve,
    // el navegador ha validado el certificado; si no se fía, el fetch falla.
    // No queda nada que creerse.
    //
    // El puerto de comprobación no sobrevive a un reinicio —al arrancar se
    // reaplica el estado guardado, y con el HTTPS apagado ahí no hay TLS—, así
    // que primero se le pide al servidor que lo levante. Sin eso, «conexión
    // rechazada» se confundiría con «no me fío», que manda a arreglar lo que no
    // está roto.
    let _aparatoDeConfianza = false

    async function _asegurarPuertoDePrueba() {
        try {
            const res = await fetch("/api/tls/comprobacion", { method: "POST" })
            const data = await res.json()
            return { ok: !!data.listo, error: data.error }
        } catch {
            return { ok: false, error: "No se ha podido hablar con el servidor" }
        }
    }

    function _urlDeComprobacion(puerto) {
        return puerto ? `https://${location.hostname}:${puerto}/` : ""
    }

    function _pintarAparato(estado, detalle, url) {
        if (!tlsAparatoResEl) return
        tlsAparatoResEl.hidden = false
        tlsAparatoResEl.className = "ajustesTlsAparatoRes " + estado
        tlsAparatoResEl.innerHTML = detalle
        if (estado === "mal" && url) {
            // El fetch no distingue «no me fío» de «no llego»: los dos fallan
            // igual. El navegador sí lo dice, con todas sus letras, si se abre
            // la página a mano; así que se ofrece.
            const enlace = document.createElement("a")
            enlace.className = "ajustesTlsAparatoEnlace"
            enlace.href = url
            enlace.target = "_blank"
            enlace.rel = "noopener"
            enlace.textContent = "Abrirla en otra pestaña para ver el motivo"
            tlsAparatoResEl.appendChild(document.createElement("br"))
            tlsAparatoResEl.appendChild(enlace)
        }
    }

    function _permitirActivar() {
        if (!tlsActivarBtn) return
        tlsActivarBtn.disabled = !(_aparatoDeConfianza || tlsConfirmaEl?.checked)

        // Comprobado de verdad, la casilla sobra: era el sustituto de esto.
        if (tlsConfirmaFila) tlsConfirmaFila.hidden = _aparatoDeConfianza
        if (tlsConfianzaEl) {
            tlsConfianzaEl.hidden = !_aparatoDeConfianza
            tlsConfianzaEl.innerHTML = _aparatoDeConfianza
                ? "<strong>Este aparato se fía del certificado.</strong> Si entras también desde el móvil o desde otro equipo, instálalo allí antes de encender: aquí solo se ha comprobado este."
                : ""
        }
    }

    async function _comprobarEnEsteAparato() {
        if (!tlsPruebaAparatoBtn) return
        const url = _urlDeComprobacion(tlsPruebaAparatoBtn.dataset.puerto)
        if (!url) return

        tlsPruebaAparatoBtn.disabled = true
        showMsg(tlsPruebaMsg, "Comprobando en este aparato…", "")

        try {
            const puerto = await _asegurarPuertoDePrueba()
            if (!puerto.ok) {
                showMsg(tlsPruebaMsg, "Sin comprobar", "error")
                _pintarAparato("mal", puerto.error || "No se ha podido levantar el puerto de comprobación", "")
                return
            }

            try {
                // cache: no-store para que no conteste un resultado viejo: lo
                // que se mide es el apretón de manos de ahora mismo.
                await fetch(url, { cache: "no-store" })
                _aparatoDeConfianza = true
                showMsg(tlsPruebaMsg, "Este aparato se fía", "ok")
                _pintarAparato(
                    "ok",
                    "<strong>El certificado funciona en este aparato.</strong> El navegador lo ha validado sin un solo aviso: " +
                        "con el HTTPS puesto entrarás igual que ahora.",
                    url
                )
            } catch {
                _aparatoDeConfianza = false
                showMsg(tlsPruebaMsg, "Este aparato no lo acepta", "error")
                _pintarAparato(
                    "mal",
                    "<strong>Este aparato no acepta el certificado.</strong> O no está instalado aquí —en Windows tiene que " +
                        "quedar en «Entidades de certificación raíz de confianza», no en «Personal»—, o no se llega al puerto " +
                        "de comprobación. Si activas el HTTPS ahora, este navegador te sacaría el aviso.",
                    url
                )
            }
        } finally {
            tlsPruebaAparatoBtn.disabled = false
            _permitirActivar()
        }
    }

    function _pintarPruebaAparato(data) {
        const puerto = data.puertoPrueba
        const hayCertificado = !!data.caDisponible || !!data.activado
        const url = puerto && hayCertificado ? _urlDeComprobacion(puerto) : ""

        if (tlsPruebaAparatoBtn) {
            tlsPruebaAparatoBtn.dataset.puerto = url ? puerto : ""
            tlsPruebaAparatoBtn.style.display = url ? "" : "none"
        }
        if (tlsPruebaAparatoHint) {
            tlsPruebaAparatoHint.innerHTML = url
                ? `Pide <code>${url}</code> desde este mismo navegador: una página servida con el mismo certificado ` +
                  "que servirá el HTTPS. Es la comprobación que el servidor no puede hacer por ti, y hay que repetirla " +
                  "en cada aparato desde el que entres."
                : ""
        }
        // Un «se fía» de antes de tocar los nombres ya no vale para nada.
        if (!url) {
            _aparatoDeConfianza = false
            if (tlsAparatoResEl) tlsAparatoResEl.hidden = true
        }
        _permitirActivar()
    }

    function _filaPrueba(r) {
        const fila = document.createElement("div")
        fila.className = "ajustesTlsPruebaFila " + (r.ok ? "ok" : "mal")

        const nombre = document.createElement("span")
        nombre.className = "ajustesTlsPruebaNombre"
        // textContent y no innerHTML: estos nombres los escribe el usuario.
        nombre.textContent = r.nombre
        fila.appendChild(nombre)

        const detalle = document.createElement("span")
        detalle.className = "ajustesTlsPruebaDetalle"
        if (!r.ok) {
            detalle.textContent = r.error || "No se ha podido comprobar"
        } else if (r.dias === null || r.dias === undefined) {
            detalle.textContent = "Certificado válido"
        } else {
            detalle.textContent = `Certificado válido, caduca en ${r.dias} días (${r.caduca})`
        }
        fila.appendChild(detalle)

        return fila
    }

    function _pintarPrueba(data) {
        if (!tlsPruebaRes) return
        tlsPruebaRes.hidden = false
        tlsPruebaRes.textContent = ""

        if (data.error) {
            tlsPruebaRes.className = "ajustesTlsPruebaRes roto"
            tlsPruebaRes.textContent = data.error
            return
        }

        tlsPruebaRes.className = "ajustesTlsPruebaRes"

        // Qué se ha comprobado exactamente. Sin esto, un «todo correcto» antes
        // de activar se lee como «ya está cifrado», que es justo lo que no es.
        if (data.modo === "previo") {
            const pie = document.createElement("div")
            pie.className = "ajustesTlsPruebaDetalle"
            pie.textContent = `Comprobado en el puerto ${data.puerto}, sobre el certificado que servirá el HTTPS. Todavía no está activado.`
            tlsPruebaRes.appendChild(pie)
        }
        ;(data.nombres || []).forEach((r) => tlsPruebaRes.appendChild(_filaPrueba(r)))
    }

    async function _probarTls() {
        if (!tlsPruebaBtn) return
        tlsPruebaBtn.disabled = true
        showMsg(tlsPruebaMsg, "Comprobando…", "")

        try {
            const res = await fetch("/api/tls/prueba")
            const data = await res.json()
            if (!data.ok) {
                showMsg(tlsPruebaMsg, data.error || "No se ha podido comprobar", "error")
                return
            }

            _pintarPrueba(data)

            const fallan = (data.nombres || []).filter((r) => !r.ok).length
            if (data.error) {
                showMsg(tlsPruebaMsg, "Sin comprobar", "error")
            } else if (fallan) {
                // En plural o en singular, pero siempre con el número: es lo que
                // dice cuántos aparatos van a seguir viendo el aviso.
                showMsg(tlsPruebaMsg, fallan === 1 ? "1 nombre sin cubrir" : `${fallan} nombres sin cubrir`, "error")
            } else if (data.modo === "previo") {
                // Aquí «correcto» solo cubre la mitad del problema: el
                // certificado está bien, pero que un aparato se fíe de él lo
                // dice el propio aparato, con el botón de al lado.
                showMsg(tlsPruebaMsg, "El certificado está bien emitido", "ok")
            } else {
                showMsg(tlsPruebaMsg, "Todo correcto", "ok")
            }
        } catch {
            showMsg(tlsPruebaMsg, "Error de red", "error")
        } finally {
            tlsPruebaBtn.disabled = false
        }
    }

    if (tlsNombresEl) tlsNombresEl.addEventListener("input", _avisarSiTeDejasFuera)
    if (tlsPruebaBtn) tlsPruebaBtn.addEventListener("click", _probarTls)
    if (tlsPruebaAparatoBtn) tlsPruebaAparatoBtn.addEventListener("click", _comprobarEnEsteAparato)
    if (tlsPrepararBtn) tlsPrepararBtn.addEventListener("click", _prepararTls)
    if (tlsActivarBtn) tlsActivarBtn.addEventListener("click", () => _guardarTls(true))
    if (tlsDesactivarBtn) tlsDesactivarBtn.addEventListener("click", () => _guardarTls(false))
    // El botón de activar no se habilita hasta que se marca que el certificado
    // ya está instalado. Es la única pulsación de este panel que puede dejar a
    // alguien fuera, y basta una casilla para que no se dé por accidente.
    if (tlsConfirmaEl) {
        tlsConfirmaEl.addEventListener("change", _permitirActivar)
    }
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

    // --- Actualizar la aplicación ---
    // El botón no actualiza: deja una señal en data/tmp/ que recoge un
    // vigilante del host (tools/actualizador/). No puede hacer más —dentro del
    // contenedor no hay Docker ni repositorio, y docker-update.sh recrea el
    // contenedor que lo ejecutaría, matándolo antes del retroceso automático—.
    const updateBtn = document.getElementById("ajustesUpdateBtn")
    const updateCheckBtn = document.getElementById("ajustesUpdateCheckBtn")
    const updateVersionEl = document.getElementById("ajustesUpdateVersion")
    const updatePublicadaFila = document.getElementById("ajustesUpdatePublicadaFila")
    const updatePublicadaEl = document.getElementById("ajustesUpdatePublicada")
    const updateEtiquetaEl = document.getElementById("ajustesUpdateEtiqueta")
    const updateBtnTextoEl = document.getElementById("ajustesUpdateBtnTexto")
    const updateAvisoEl = document.getElementById("ajustesUpdateAviso")
    const updateMsg = document.getElementById("ajustesUpdateMsg")

    let _versionAlPedir = null
    let _sondeoUpdate = null
    // Última versión publicada conocida: la usa el modal de confirmación para
    // decir a qué se va a actualizar en vez de «a la versión nueva».
    let _versionPublicada = null
    // true / false / null (no se ha podido saber), tal cual lo dice el servidor.
    let _hayVersionNueva = null

    function _pintarAvisoUpdate(texto) {
        if (!updateAvisoEl) return
        updateAvisoEl.textContent = texto || ""
        updateAvisoEl.hidden = !texto
    }

    // Qué versión hay publicada en GitHub. La comprobación es solo eso, una
    // lectura: quien actualiza sigue siendo el vigilante del host. Sirve para no
    // pagar dos minutos de reinicio cuando no hay nada que traer.
    function _pintarRemota(remota) {
        if (!updatePublicadaFila) return

        _versionPublicada = null
        _hayVersionNueva = null

        if (!remota || !remota.activo) {
            updatePublicadaFila.hidden = true
            return
        }

        updatePublicadaFila.hidden = false

        if (!remota.publicada) {
            // Sin dato y con error: se dice, en vez de dejar un guion mudo que
            // se confunde con «no hay versión nueva».
            updatePublicadaEl.textContent = "no se pudo comprobar"
            updatePublicadaFila.title = remota.error || ""
            updateEtiquetaEl.hidden = true
            return
        }

        updatePublicadaEl.textContent = remota.publicada
        _versionPublicada = remota.publicada
        // Con error y dato a la vez, el dato es el de la última comprobación
        // que sí funcionó: se enseña, pero diciendo de cuándo es.
        updatePublicadaFila.title = remota.error
            ? `${remota.error}. Último dato del ${new Date(remota.comprobado).toLocaleString()}`
            : ""

        if (remota.hayNueva === null || remota.hayNueva === undefined) {
            updateEtiquetaEl.hidden = true
            return
        }

        _hayVersionNueva = Boolean(remota.hayNueva)
        updateEtiquetaEl.hidden = false
        updateEtiquetaEl.textContent = remota.hayNueva ? "Hay actualización" : "Al día"
        updateEtiquetaEl.classList.toggle("hayNueva", Boolean(remota.hayNueva))
    }

    function _pintarUpdate(datos) {
        if (updateVersionEl) updateVersionEl.textContent = datos.version || "—"
        _pintarRemota(datos.remota)

        if (updateBtnTextoEl) {
            updateBtnTextoEl.textContent =
                _hayVersionNueva && _versionPublicada ? `Actualizar a la ${_versionPublicada}` : "Actualizar ahora"
        }

        if (!datos.vigilanteVisto) {
            // Sin vigilante instalado, la señal se queda ahí para siempre. Un
            // botón que gira sin fin es peor que decir que no está montado.
            _pintarAvisoUpdate(
                "El vigilante del servidor no da señales de vida: no ha informado de ninguna " +
                    "actualización todavía. Mientras no esté instalado (ver tools/actualizador/), " +
                    "este botón deja la petición y nadie la recoge; hay que actualizar con " +
                    "./docker-update.sh por SSH."
            )
        } else if (datos.enMarcha) {
            _pintarAvisoUpdate("")
        } else if (datos.ultimo?.estado === "fallo") {
            _pintarAvisoUpdate(
                `La última actualización falló (código ${datos.ultimo.codigo}). La versión anterior ` +
                    `sigue en marcha. Detalle: ${datos.ultimo.detalle || "sin detalle"}`
            )
        } else {
            _pintarAvisoUpdate("")
        }

        if (updateBtn) updateBtn.disabled = Boolean(datos.enMarcha)
        if (updateCheckBtn) updateCheckBtn.disabled = Boolean(datos.enMarcha)
        if (datos.enMarcha) showMsg(updateMsg, "Actualizando… la aplicación se reiniciará", "")
    }

    async function _consultarUpdate() {
        try {
            const res = await fetch("/api/actualizacion")
            const datos = await res.json()
            if (datos.ok) _pintarUpdate(datos)
            return datos
        } catch {
            // Durante la actualización el contenedor se para: que la petición
            // falle es la señal de que va en serio, no un error que contar.
            return null
        }
    }

    function _sondearUpdate() {
        if (_sondeoUpdate) clearInterval(_sondeoUpdate)
        _sondeoUpdate = setInterval(async () => {
            const datos = await _consultarUpdate()
            if (!datos) {
                showMsg(updateMsg, "Reiniciando… esperando a que vuelva", "")
                return
            }
            if (datos.version && _versionAlPedir && datos.version !== _versionAlPedir) {
                clearInterval(_sondeoUpdate)
                _sondeoUpdate = null
                showMsg(updateMsg, `Actualizada a la ${datos.version}. Recarga la página.`, "ok")
                return
            }
            if (datos.ultimo?.estado === "fallo") {
                clearInterval(_sondeoUpdate)
                _sondeoUpdate = null
                showMsg(updateMsg, "La actualización falló; sigue la versión anterior", "error")
            }
        }, 5000)
    }

    // Comprobar a mano. La respuesta de GitHub se guarda unas horas, así que sin
    // esto habría que esperar a que caducara para ver una versión recién
    // publicada; y el botón es además la forma de ver si la comprobación va.
    if (updateCheckBtn) {
        updateCheckBtn.addEventListener("click", async () => {
            updateCheckBtn.disabled = true
            showMsg(updateMsg, "Comprobando…", "")
            try {
                const res = await fetch("/api/actualizacion?refrescar=1")
                const datos = await res.json()
                if (!datos.ok) {
                    showMsg(updateMsg, "No se pudo comprobar", "error")
                    return
                }
                _pintarUpdate(datos)
                const remota = datos.remota
                if (!remota?.activo) {
                    showMsg(updateMsg, "La comprobación de versión está desactivada", "")
                } else if (remota.error && !remota.publicada) {
                    showMsg(updateMsg, remota.error, "error")
                } else if (remota.hayNueva) {
                    showMsg(updateMsg, `Hay una versión nueva: la ${remota.publicada}`, "ok")
                } else if (remota.hayNueva === false) {
                    showMsg(updateMsg, "Estás en la última versión publicada", "ok")
                } else {
                    showMsg(updateMsg, "No se pudo comparar la versión publicada", "")
                }
            } catch {
                showMsg(updateMsg, "Error de red", "error")
            } finally {
                // Salvo que la respuesta haya dicho que hay una actualización en
                // marcha: entonces este botón se queda apagado como el otro.
                updateCheckBtn.disabled = Boolean(updateBtn?.disabled)
            }
        })
    }

    function _mensajeConfirmacion() {
        const comun =
            "La aplicación se reiniciará: estarás un par de minutos sin servicio. Si la " +
            "versión nueva no arranca, el servidor vuelve solo a la anterior."

        if (_hayVersionNueva === true) {
            return `Se instalará la ${_versionPublicada}. ${comun} ¿Continuar?`
        }
        if (_hayVersionNueva === false) {
            // Reconstruir la misma versión es legítimo —cambiar .env, rehacer
            // una imagen corrupta— pero que nadie lo haga creyendo que trae algo.
            return (
                `Ya estás en la última publicada (${_versionPublicada}): se volverá a construir ` +
                `la misma versión, sin novedades. ${comun} ¿Continuar?`
            )
        }
        return `Se descargará y construirá la versión nueva. ${comun} ¿Continuar?`
    }

    if (updateBtn) {
        updateBtn.addEventListener("click", () => {
            openConfirmModal({
                title: "Actualizar la aplicación",
                message: _mensajeConfirmacion(),
                confirmLabel: "Actualizar",
                onConfirm: async () => {
                    updateBtn.disabled = true
                    showMsg(updateMsg, "Solicitando…", "")
                    try {
                        const res = await fetch("/api/actualizacion", { method: "POST" })
                        const datos = await res.json()
                        if (!datos.ok) {
                            showMsg(updateMsg, datos.error || "No se pudo solicitar", "error")
                            updateBtn.disabled = false
                            return
                        }
                        _versionAlPedir = datos.version
                        showMsg(updateMsg, "Lanzada. Esperando a que el servidor la recoja…", "")
                        _sondearUpdate()
                    } catch {
                        showMsg(updateMsg, "Error de red", "error")
                        updateBtn.disabled = false
                    }
                }
            })
        })
    }

    _consultarUpdate()

    // --- Exportar datos JSON ---
    const exportJsonBtn = document.getElementById("ajustesExportJsonBtn")
    const exportZipBtn = document.getElementById("ajustesExportZipBtn")
    const exportMsg = document.getElementById("ajustesExportMsg")
    const exportClavesChk = document.getElementById("ajustesExportClaves")

    // El orden de las tarjetas de Ajustes, el de cada tabla y los modos de
    // visualización viven en el navegador, así que el servidor no puede
    // meterlos en el ZIP por su cuenta: se los mandamos al exportar.
    function _volcarUi() {
        const volcado = {}
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const clave = localStorage.key(i)
                if (clave) volcado[clave] = localStorage.getItem(clave)
            }
        } catch {
            // Modo privado o almacenamiento bloqueado. El export sigue
            // adelante sin esta parte: perder la copia entera por no poder
            // leer una preferencia sería un mal negocio.
        }
        return volcado
    }

    async function _doExport(url, filename, btn, cuerpo) {
        btn.disabled = true
        showMsg(exportMsg, "Preparando…", "")
        try {
            const res = await fetch(
                url,
                cuerpo
                    ? {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(cuerpo)
                      }
                    : undefined
            )
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
            _doExport("/api/export/zip", `portfolio-export-${date}.zip`, exportZipBtn, {
                ui: _volcarUi(),
                incluirClaves: !!exportClavesChk?.checked
            })
        })
    }

    // --- Importar datos JSON / ZIP ---
    const importJsonBtn = document.getElementById("ajustesImportJsonBtn")
    const importZipBtn = document.getElementById("ajustesImportZipBtn")
    const importJsonInput = document.getElementById("ajustesImportJsonInput")
    const importZipInput = document.getElementById("ajustesImportZipInput")
    const importMsg = document.getElementById("ajustesImportMsg")

    function _restaurarUi(ui) {
        if (!ui || typeof ui !== "object") return 0
        let escritas = 0
        try {
            Object.entries(ui).forEach(([clave, valor]) => {
                if (typeof valor === "string") {
                    localStorage.setItem(clave, valor)
                    escritas++
                }
            })
        } catch {
            // Almacenamiento lleno o bloqueado: los datos ya se han importado,
            // que es lo que importa. Las preferencias se vuelven a poner solas
            // según se usa la aplicación.
        }
        return escritas
    }

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
                // Las preferencias de interfaz no las guarda el servidor: las
                // devuelve para que las escriba quien las usa.
                const restauradas = _restaurarUi(data.ui)

                // Los datos que hay en pantalla ya no son los de la base: se
                // recarga, igual que después de restaurar.
                const extra = restauradas ? ` y ${restauradas} preferencia(s) de interfaz` : ""
                showMsg(importMsg, `Importado correctamente${extra}. Recargando…`, "ok")
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
