// Ajustes: general.
//
// Panel de la pantalla de Ajustes separado de js/ajustes/ajustes.js. Antes todo
// vivía dentro de initAjustesLogic, una sola función de ~3.900 líneas; cada
// panel es ahora una función que initAjustesLogic llama en el mismo orden de
// siempre. Su código no ha cambiado: las funciones internas siguen anidadas.
// Copias automáticas, divisas, refresco de precios, snapshots y activos ocultos.
function _initAjustesGeneral(settings, _fiatCurrencies) {
    // --- Auto-backup ---
    const autoBackupSel = document.getElementById("ajustesAutoBackup")
    const guardarFreqBtn = document.getElementById("ajustesGuardarBackupFreqBtn")
    const backupFreqMsg = document.getElementById("ajustesBackupFreqMsg")

    if (autoBackupSel) setSelect(autoBackupSel, settings.autoBackupDays ?? 0)

    const backupClavesChk = document.getElementById("ajustesBackupClaves")
    if (backupClavesChk) backupClavesChk.checked = !!settings.backupIncluirClaves

    if (guardarFreqBtn) {
        guardarFreqBtn.addEventListener("click", async () => {
            guardarFreqBtn.disabled = true
            showMsg(backupFreqMsg, "Guardando…", "")
            try {
                const res = await fetch("/api/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        autoBackupDays: Number(autoBackupSel?.value || 0),
                        backupIncluirClaves: !!backupClavesChk?.checked
                    })
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

    // --- Contraseña de las claves en las copias ---
    const bkPwdInput = document.getElementById("ajustesBackupContrasena")
    const bkPwdFijarBtn = document.getElementById("ajustesBackupContrasenaFijarBtn")
    const bkPwdQuitarBtn = document.getElementById("ajustesBackupContrasenaQuitarBtn")
    const bkPwdEstado = document.getElementById("ajustesBackupContrasenaEstado")
    const bkPwdMsg = document.getElementById("ajustesBackupContrasenaMsg")
    const bkPwdVerBtn = document.getElementById("ajustesBackupContrasenaVerBtn")
    let bkPwdTemporizador = null

    // La contraseña revelada se borra del campo a los 30 s: no se queda en pantalla.
    function ocultarContrasenaCopias() {
        clearTimeout(bkPwdTemporizador)
        if (!bkPwdInput) return
        bkPwdInput.value = ""
        if (bkPwdInput.type === "text") document.querySelector('[data-target="ajustesBackupContrasena"]')?.click()
    }

    function pintarContrasenaCopias(configurada) {
        if (bkPwdEstado) bkPwdEstado.textContent = configurada ? "· configurada" : "· sin definir (se usa la de la web)"
        if (bkPwdQuitarBtn) bkPwdQuitarBtn.hidden = !configurada
        if (bkPwdVerBtn) bkPwdVerBtn.hidden = !configurada
        if (bkPwdFijarBtn) bkPwdFijarBtn.textContent = configurada ? "Cambiar" : "Fijar"
    }
    pintarContrasenaCopias(!!settings.backupContrasena)

    async function enviarContrasenaCopias(metodo, cuerpo, okTexto) {
        if (bkPwdFijarBtn) bkPwdFijarBtn.disabled = true
        if (bkPwdQuitarBtn) bkPwdQuitarBtn.disabled = true
        showMsg(bkPwdMsg, "Guardando…", "")
        try {
            const res = await fetch("/api/backup/contrasena", {
                method: metodo,
                headers: { "Content-Type": "application/json" },
                body: cuerpo ? JSON.stringify(cuerpo) : undefined
            })
            const data = await res.json()
            if (data.ok) {
                pintarContrasenaCopias(!!data.configurada)
                ocultarContrasenaCopias()
            }
            showMsg(bkPwdMsg, data.ok ? okTexto : data.error || "Error", data.ok ? "ok" : "error")
        } catch {
            showMsg(bkPwdMsg, "Error de red", "error")
        } finally {
            if (bkPwdFijarBtn) bkPwdFijarBtn.disabled = false
            if (bkPwdQuitarBtn) bkPwdQuitarBtn.disabled = false
        }
    }

    if (bkPwdFijarBtn) {
        bkPwdFijarBtn.addEventListener("click", () =>
            enviarContrasenaCopias("POST", { contrasena: bkPwdInput?.value || "" }, "Contraseña guardada")
        )
    }
    if (bkPwdVerBtn) {
        bkPwdVerBtn.addEventListener("click", () => {
            _abrirModalContrasena({
                titulo: "Ver la contraseña de las copias",
                texto: "Escribe tu contraseña de acceso a la web para ver la contraseña guardada.",
                botones: [
                    { etiqueta: "Cancelar", clase: "cancelButton", valor: "cancelar" },
                    { etiqueta: "Mostrar", clase: "primaryButton", valor: "con", principal: true, necesitaContrasena: true }
                ],
                onCerrar: async (valor, contrasenaWeb) => {
                    if (valor !== "con") return
                    showMsg(bkPwdMsg, "Comprobando…", "")
                    try {
                        const res = await fetch("/api/backup/contrasena/ver", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ currentPassword: contrasenaWeb })
                        })
                        const data = await res.json()
                        if (!data.ok) {
                            showMsg(bkPwdMsg, data.error || "No se pudo mostrar", "error")
                            return
                        }
                        ocultarContrasenaCopias()
                        bkPwdInput.value = data.contrasena
                        if (bkPwdInput.type === "password") document.querySelector('[data-target="ajustesBackupContrasena"]')?.click()
                        bkPwdTemporizador = setTimeout(ocultarContrasenaCopias, 30000)
                        showMsg(bkPwdMsg, "Visible 30 s", "ok")
                    } catch {
                        showMsg(bkPwdMsg, "Error de red", "error")
                    }
                }
            })
        })
    }

    if (bkPwdQuitarBtn) {
        bkPwdQuitarBtn.addEventListener("click", () =>
            enviarContrasenaCopias("DELETE", null, "Contraseña quitada: se usará la de la web")
        )
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
            sel.innerHTML = _divisas
                .map(
                    (c) =>
                        `<option value="${escapeHtml(c.code)}">${escapeHtml(c.code)} — ${escapeHtml(c.name)}</option>`
                )
                .join("")
            sel.value = _divisas.find((c) => c.code === current) ? current : _divisas[0]?.code || "EUR"
            wrapper.querySelector(".ajustesDropLabel").textContent = sel.options[sel.selectedIndex]?.text || sel.value
        } else {
            sel.innerHTML = _divisas
                .map(
                    (c) =>
                        `<option value="${escapeHtml(c.code)}">${escapeHtml(c.code)} — ${escapeHtml(c.name)}</option>`
                )
                .join("")
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
}

// Densidad, rotación, decimales, horario de mercado e inactividad.
function _initAjustesApariencia(settings) {
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
}
