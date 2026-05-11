document.addEventListener("DOMContentLoaded", () => {
    initPortfolioSwitcher()
})

async function initPortfolioSwitcher() {
    const listEl       = document.getElementById("portfolioList")
    const currentName  = document.getElementById("portfolioCurrentName")
    const newBtn       = document.getElementById("portfolioNewBtn")
    const importBtn    = document.getElementById("portfolioImportBtn")

    // Modal crear/renombrar
    const modalOverlay = document.getElementById("portfolioModalOverlay")
    const modalTitle   = document.getElementById("portfolioModalTitle")
    const nameInput    = document.getElementById("portfolioNameInput")
    const cancelBtn    = document.getElementById("cancelPortfolioModalBtn")
    const confirmBtn   = document.getElementById("confirmPortfolioModalBtn")

    // Modal importar
    const importOverlay    = document.getElementById("portfolioImportModalOverlay")
    const importNameInput  = document.getElementById("portfolioImportName")
    const importFileInput  = document.getElementById("portfolioImportFile")
    const importStatus     = document.getElementById("portfolioImportStatus")
    const cancelImportBtn  = document.getElementById("cancelPortfolioImportBtn")
    const confirmImportBtn = document.getElementById("confirmPortfolioImportBtn")

    // Modal confirm genérico
    const pConfirmOverlay = document.getElementById("pConfirmOverlay")
    const pConfirmTitle   = document.getElementById("pConfirmTitle")
    const pConfirmMsg     = document.getElementById("pConfirmMsg")
    const pConfirmCancel  = document.getElementById("pConfirmCancel")
    const pConfirmOk      = document.getElementById("pConfirmOk")

    // Modal eliminar (3 pasos)
    const pDeleteOverlay   = document.getElementById("pDeleteOverlay")
    const pDelStep1        = document.getElementById("pDelStep1")
    const pDelStep2        = document.getElementById("pDelStep2")
    const pDelStep3        = document.getElementById("pDelStep3")
    const pDelName1        = document.getElementById("pDelName1")
    const pDelNameConfirm  = document.getElementById("pDelNameConfirm")
    const pDelNameInput    = document.getElementById("pDelNameInput")
    const pDelConfirmFinal = document.getElementById("pDelConfirmFinal")

    let allPortfolios  = []
    let activeId       = ""
    let renameTargetId = null

    // ── Confirm modal (Promise) ──────────────────────────
    function portfolioConfirm(title, msg, okLabel = "Confirmar", danger = false) {
        return new Promise(resolve => {
            pConfirmTitle.textContent = title
            pConfirmMsg.innerHTML    = msg
            pConfirmOk.textContent   = okLabel
            pConfirmOk.className     = danger ? "dangerButton" : "primaryButton"
            pConfirmOk.dataset.noAutohide = "true"
            pConfirmOverlay.classList.remove("hidden")

            function cleanup(result) {
                pConfirmOverlay.classList.add("hidden")
                pConfirmOk.removeEventListener("click", onOk)
                pConfirmCancel.removeEventListener("click", onCancel)
                pConfirmOverlay.removeEventListener("click", onBg)
                resolve(result)
            }
            const onOk     = () => cleanup(true)
            const onCancel = () => cleanup(false)
            const onBg     = e => { if (e.target === pConfirmOverlay) cleanup(false) }

            pConfirmOk.addEventListener("click", onOk)
            pConfirmCancel.addEventListener("click", onCancel)
            pConfirmOverlay.addEventListener("click", onBg)
        })
    }

    // ── Delete 3-step (Promise) ──────────────────────────
    function portfolioDelete(portfolioName) {
        return new Promise(resolve => {
            pDelName1.textContent       = portfolioName
            pDelNameConfirm.textContent = portfolioName
            pDelNameInput.value         = ""
            pDelConfirmFinal.disabled   = true

            pDelStep1.classList.remove("hidden")
            pDelStep2.classList.add("hidden")
            pDelStep3.classList.add("hidden")
            pDeleteOverlay.classList.remove("hidden")

            function closeDelete(result) {
                pDeleteOverlay.classList.add("hidden")
                pDelNameInput.removeEventListener("input", onInput)
                resolve(result)
            }

            // Paso 1 → 2
            const onNext1   = () => { pDelStep1.classList.add("hidden"); pDelStep2.classList.remove("hidden") }
            const onCancel1 = () => closeDelete(false)
            document.getElementById("pDelNext1").onclick   = onNext1
            document.getElementById("pDelCancel1").onclick = onCancel1

            // Paso 2 → 3
            const onNext2   = () => { pDelStep2.classList.add("hidden"); pDelStep3.classList.remove("hidden"); pDelNameInput.focus() }
            const onCancel2 = () => closeDelete(false)
            document.getElementById("pDelNext2").onclick   = onNext2
            document.getElementById("pDelCancel2").onclick = onCancel2

            // Paso 3 — validar nombre
            const onInput = () => {
                pDelConfirmFinal.disabled = pDelNameInput.value.trim() !== portfolioName
            }
            pDelNameInput.addEventListener("input", onInput)

            pDelConfirmFinal.onclick = () => {
                if (pDelNameInput.value.trim() === portfolioName) closeDelete(true)
            }
            document.getElementById("pDelCancel3").onclick = () => closeDelete(false)

            pDeleteOverlay.onclick = e => { if (e.target === pDeleteOverlay) closeDelete(false) }
        })
    }

    // ── Carga de portfolios ──────────────────────────────
    async function loadPortfolios() {
        try {
            const res  = await fetch("/api/portfolios")
            const data = await res.json()
            if (!data.ok) return
            allPortfolios = data.portfolios
            activeId      = data.active
            window._activePortfolioId = activeId
            if (window._viewAllPortfolios && allPortfolios.length >= 2) {
                if (currentName) currentName.textContent = "Todos"
            } else {
                if (window._viewAllPortfolios) {
                    localStorage.removeItem("viewAllPortfolios")
                    window._viewAllPortfolios = false
                }
                const active  = allPortfolios.find(p => p.id === activeId)
                if (currentName) currentName.textContent = active ? active.name : "Portfolio"
            }
            renderList()
        } catch (_) {}
    }

    function renderList() {
        if (!listEl) return
        listEl.innerHTML = ""

        // Opción "Todos" cuando hay 2 o más portfolios
        if (allPortfolios.length >= 2) {
            const todosRow = document.createElement("div")
            todosRow.className = "portfolioMenuItem portfolioMenuItemTodos" + (window._viewAllPortfolios ? " portfolioMenuItemActive" : "")
            const todosSpan = document.createElement("span")
            todosSpan.className = "portfolioMenuItemName"
            todosSpan.textContent = "Todos los portfolios"
            todosSpan.style.cursor = "pointer"
            todosSpan.addEventListener("click", () => {
                closeMenu()
                localStorage.setItem("viewAllPortfolios", "1")
                window.location.reload()
            })
            todosRow.appendChild(todosSpan)
            listEl.appendChild(todosRow)
        }

        allPortfolios.forEach(p => {
            const isActive = !window._viewAllPortfolios && p.id === activeId
            const row = document.createElement("div")
            row.className = "portfolioMenuItem" + (isActive ? " portfolioMenuItemActive" : "")

            const nameSpan = document.createElement("span")
            nameSpan.className = "portfolioMenuItemName"
            nameSpan.textContent = p.name

            const actions = document.createElement("span")
            actions.className = "portfolioMenuItemActions"

            // Exportar
            const expBtn = document.createElement("button")
            expBtn.className = "portfolioActionBtn"
            expBtn.title = "Exportar"
            expBtn.textContent = "⬇️"
            expBtn.addEventListener("click", e => {
                e.stopPropagation()
                window.location.href = `/api/portfolios/${p.id}/export`
            })
            actions.appendChild(expBtn)

            // Renombrar
            const renBtn = document.createElement("button")
            renBtn.className = "portfolioActionBtn"
            renBtn.title = "Renombrar"
            renBtn.textContent = "✏️"
            renBtn.addEventListener("click", e => {
                e.stopPropagation()
                closeMenu()
                openModal("rename", p.id, p.name)
            })
            actions.appendChild(renBtn)

            // Eliminar (solo portfolios no activos)
            if (p.id !== activeId) {
                const delBtn = document.createElement("button")
                delBtn.className = "portfolioActionBtn portfolioDeleteBtn"
                delBtn.title = "Eliminar"
                delBtn.textContent = "🗑"
                delBtn.addEventListener("click", async e => {
                    e.stopPropagation()
                    closeMenu()
                    const confirmed = await portfolioDelete(p.name)
                    if (!confirmed) return
                    await deletePortfolio(p.id)
                })
                actions.appendChild(delBtn)
            }

            row.append(nameSpan, actions)

            if (!isActive) {
                nameSpan.style.cursor = "pointer"
                nameSpan.addEventListener("click", async () => {
                    closeMenu()
                    localStorage.removeItem("viewAllPortfolios")
                    window._viewAllPortfolios = false
                    await switchPortfolio(p.id)
                })
            }

            listEl.appendChild(row)
        })
    }

    function closeMenu() {
        const menu = document.getElementById("portfolioSwitcherMenu")
        if (menu) menu.classList.remove("open")
    }

    async function switchPortfolio(pid) {
        try {
            const res  = await fetch("/api/portfolios/switch", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: pid }),
            })
            const data = await res.json()
            if (data.ok) {
                window.location.reload()
            } else {
                await portfolioConfirm("Error", data.error || "Error al cambiar portfolio", "Aceptar")
            }
        } catch (_) {
            await portfolioConfirm("Error", "Error de conexión al cambiar portfolio", "Aceptar")
        }
    }

    async function deletePortfolio(pid) {
        try {
            const res  = await fetch(`/api/portfolios/${pid}`, { method: "DELETE" })
            const data = await res.json()
            if (!data.ok) await portfolioConfirm("Error", data.error || "Error al eliminar", "Aceptar")
            await loadPortfolios()
        } catch (_) {}
    }

    // ── Modal crear / renombrar ──────────────────────────
    function openModal(mode, pid = null, currentVal = "") {
        renameTargetId = pid
        modalTitle.textContent = mode === "rename" ? "Renombrar portfolio" : "Nuevo portfolio"
        confirmBtn.textContent = mode === "rename" ? "Guardar" : "Crear"
        nameInput.value        = mode === "rename" ? currentVal : ""
        confirmBtn.style.display = ""
        modalOverlay.classList.remove("hidden")
        nameInput.focus()
    }

    function closeModal() {
        modalOverlay.classList.add("hidden")
        nameInput.value = ""
        renameTargetId  = null
    }

    if (newBtn)    newBtn.addEventListener("click",   e => { e.stopPropagation(); closeMenu(); openModal("create") })
    if (cancelBtn) cancelBtn.addEventListener("click", closeModal)
    if (modalOverlay) modalOverlay.addEventListener("click", e => { if (e.target === modalOverlay) closeModal() })
    if (nameInput) nameInput.addEventListener("keydown", e => {
        if (e.key === "Enter")  confirmBtn.click()
        if (e.key === "Escape") closeModal()
    })

    if (confirmBtn) {
        confirmBtn.addEventListener("click", async () => {
            const name = nameInput.value.trim()
            if (!name) return

            if (renameTargetId) {
                try {
                    const res  = await fetch(`/api/portfolios/${renameTargetId}/rename`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name }),
                    })
                    const data = await res.json()
                    if (data.ok) { closeModal(); await loadPortfolios() }
                    else await portfolioConfirm("Error", data.error || "Error al renombrar", "Aceptar")
                } catch (_) {}
            } else {
                try {
                    const res  = await fetch("/api/portfolios", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name }),
                    })
                    const data = await res.json()
                    if (data.ok) {
                        closeModal()
                        const ok = await portfolioConfirm(
                            "Portfolio creado",
                            `Portfolio <strong>${name}</strong> creado. ¿Cambiar a él ahora?`,
                            "Cambiar ahora"
                        )
                        if (ok) await switchPortfolio(data.id)
                        else await loadPortfolios()
                    } else {
                        await portfolioConfirm("Error", data.error || "Error al crear", "Aceptar")
                    }
                } catch (_) {}
            }
        })
    }

    // ── Modal importar ───────────────────────────────────
    if (importBtn) {
        importBtn.addEventListener("click", e => {
            e.stopPropagation()
            closeMenu()
            importNameInput.value = ""
            importFileInput.value = ""
            importStatus.textContent = ""
            importStatus.classList.add("hidden")
            importOverlay.classList.remove("hidden")
            importNameInput.focus()
        })
    }

    function closeImportModal() {
        importOverlay.classList.add("hidden")
        importNameInput.value = ""
        importFileInput.value = ""
        importStatus.textContent = ""
        importStatus.classList.add("hidden")
    }

    if (cancelImportBtn) cancelImportBtn.addEventListener("click", closeImportModal)
    if (importOverlay)   importOverlay.addEventListener("click", e => { if (e.target === importOverlay) closeImportModal() })

    if (importFileInput) {
        importFileInput.addEventListener("change", () => {
            const file = importFileInput.files[0]
            if (file && !importNameInput.value.trim())
                importNameInput.value = file.name.replace(/\.db$/i, "").replace(/_/g, " ")
        })
    }

    if (confirmImportBtn) {
        confirmImportBtn.addEventListener("click", async () => {
            const name = importNameInput.value.trim()
            const file = importFileInput.files[0]
            if (!name) { importNameInput.focus(); return }
            if (!file) {
                importStatus.textContent = "Selecciona un fichero .db"
                importStatus.classList.remove("hidden")
                return
            }

            confirmImportBtn.disabled    = true
            importStatus.textContent     = "Importando..."
            importStatus.classList.remove("hidden")

            try {
                const fd = new FormData()
                fd.append("name", name)
                fd.append("file", file)
                const res  = await fetch("/api/portfolios/import", { method: "POST", body: fd })
                const data = await res.json()
                if (data.ok) {
                    closeImportModal()
                    const ok = await portfolioConfirm(
                        "Portfolio importado",
                        `Portfolio <strong>${name}</strong> importado correctamente. ¿Cambiar a él ahora?`,
                        "Cambiar ahora"
                    )
                    if (ok) await switchPortfolio(data.id)
                    else await loadPortfolios()
                } else {
                    importStatus.textContent = "Error: " + (data.error || "")
                }
            } catch (_) {
                importStatus.textContent = "Error de conexión"
            } finally {
                confirmImportBtn.disabled = false
            }
        })
    }

    await loadPortfolios()
}
