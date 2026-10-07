// Ajustes: copias.
//
// Panel de la pantalla de Ajustes separado de js/ajustes/ajustes.js. Antes todo
// vivía dentro de initAjustesLogic, una sola función de ~3.900 líneas; cada
// panel es ahora una función que initAjustesLogic llama en el mismo orden de
// siempre. Su código no ha cambiado: las funciones internas siguen anidadas.
// Lista de copias de seguridad: crear, restaurar y borrar.
function _initAjustesCopias() {
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
            .replace(/_auto$/, "")
            .replace(/_(\d{2})-(\d{2})-(\d{2})$/, " $1:$2:$3")
        return isZip ? base : `${base} (legacy)`
    }

    // Las copias del scheduler llevan `_auto` en el nombre: mismo zip que las
    // manuales, pero conviene que en la lista se vea cual es cual.
    function _esBackupAutomatico(filename) {
        return /_auto\.zip$/.test(filename)
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
            if (_esBackupAutomatico(filename)) {
                const tag = document.createElement("span")
                tag.className = "ajustesBackupTag"
                tag.textContent = "auto"
                label.appendChild(tag)
            }
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
            message: `Vas a eliminar la copia "${displayName}". Esta acción no se puede deshacer.`,
            confirmLabel: "Eliminar",
            requireText: displayName,
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

    // La copia lleva las claves de API cifradas con la contraseña de la web y la
    // actual ya no las abre (se cambió después de hacerla): se pide la de
    // entonces y se reenvía. El servidor no ha tocado nada todavía.
    function _pedirContrasenaRestore(filename, btn, error) {
        showMsg(backupMsg, "", "")
        _abrirModalContrasena({
            titulo: "Las claves de API van con contraseña",
            texto:
                "Esta copia lleva las claves de API cifradas con la contraseña de las copias (o, si no " +
                "había, la de la web) que había al crearla. Escríbela para restaurarlas, o restaura el " +
                "resto sin las claves.",
            error: error || "",
            botones: [
                { etiqueta: "Cancelar", clase: "cancelButton", valor: "cancelar" },
                { etiqueta: "Restaurar sin las claves", clase: "cancelButton", valor: "sin" },
                {
                    etiqueta: "Restaurar",
                    clase: "primaryButton",
                    valor: "con",
                    principal: true,
                    necesitaContrasena: true
                }
            ],
            onCerrar: (valor, contrasena) => {
                if (valor === "cancelar") {
                    showMsg(backupMsg, "Restauración cancelada", "")
                    return
                }
                _doRestore(filename, btn, valor === "con" ? { contrasena } : { sinClaves: true })
            }
        })
    }

    async function _doRestore(filename, btn, extra = {}) {
        btn.disabled = true
        showMsg(backupMsg, "Restaurando…", "")
        try {
            const res = await fetch("/api/restore", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename, ...extra })
            })
            const data = await res.json()
            if (!data.ok && data.necesitaContrasena) {
                btn.disabled = false
                _pedirContrasenaRestore(filename, btn, extra.contrasena ? data.error : "")
                return
            }
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
}

// Exportar e importar datos (JSON / ZIP) y purgar snapshots.
function _initAjustesDatos() {
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

    function _exportarZip(contrasena) {
        const date = new Date().toISOString().slice(0, 10)
        _doExport("/api/export/zip", `portfolio-export-${date}.zip`, exportZipBtn, {
            ui: _volcarUi(),
            incluirClaves: !!exportClavesChk?.checked,
            contrasena: contrasena || ""
        })
    }

    if (exportZipBtn) {
        exportZipBtn.addEventListener("click", () => {
            // Sin claves dentro no hay nada que proteger: se descarga sin más.
            if (!exportClavesChk?.checked) {
                _exportarZip("")
                return
            }
            _abrirModalContrasena({
                titulo: "Proteger las claves de API",
                texto:
                    "El ZIP va a llevar tus claves de los proveedores y la del Atajo. Con contraseña " +
                    "van cifradas y se pedirá al importar; sin ella, van en claro y el archivo es un secreto. " +
                    "Si la olvidas, el resto del ZIP se puede importar igual, pero las claves no.",
                repetir: true,
                botones: [
                    { etiqueta: "Cancelar", clase: "cancelButton", valor: "cancelar" },
                    { etiqueta: "Sin contraseña", clase: "cancelButton", valor: "sin" },
                    {
                        etiqueta: "Con contraseña",
                        clase: "primaryButton",
                        valor: "con",
                        principal: true,
                        necesitaContrasena: true
                    }
                ],
                onCerrar: (valor, contrasena) => {
                    if (valor === "cancelar") return
                    _exportarZip(valor === "con" ? contrasena : "")
                }
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
        // Las claves que escribe la aplicación son identificadores
        // (`portfolioTheme`, `seguimientoList_<id>`…). Un ZIP de otra persona
        // podría traer cualquier cosa; lo que no tenga esa forma no se escribe.
        const CLAVE_VALIDA = /^[A-Za-z][\w.:-]{0,127}$/
        try {
            Object.entries(ui).forEach(([clave, valor]) => {
                if (typeof valor === "string" && CLAVE_VALIDA.test(clave)) {
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

    // Las claves del ZIP están protegidas: se pide la contraseña y se vuelve
    // a mandar el mismo fichero con ella. El servidor no ha tocado nada aún.
    function _pedirContrasenaImport(url, file, btn, error) {
        showMsg(importMsg, "", "")
        _abrirModalContrasena({
            titulo: "Las claves de API van con contraseña",
            texto:
                "Este ZIP lleva las claves de API cifradas con la contraseña que se puso al exportar. " +
                "Escríbela para restaurarlas, o importa el resto sin ellas.",
            error: error || "",
            botones: [
                { etiqueta: "Cancelar", clase: "cancelButton", valor: "cancelar" },
                { etiqueta: "Importar sin las claves", clase: "cancelButton", valor: "sin" },
                {
                    etiqueta: "Importar",
                    clase: "primaryButton",
                    valor: "con",
                    principal: true,
                    necesitaContrasena: true
                }
            ],
            onCerrar: (valor, contrasena) => {
                if (valor === "cancelar") {
                    showMsg(importMsg, "Importación cancelada", "")
                    return
                }
                _doImport(url, file, btn, valor === "con" ? { contrasena } : { sinClaves: "1" })
            }
        })
    }

    async function _doImport(url, file, btn, extra = {}) {
        btn.disabled = true
        showMsg(importMsg, "Importando…", "")
        try {
            const form = new FormData()
            form.append("file", file)
            Object.entries(extra).forEach(([clave, valor]) => form.append(clave, valor))
            const res = await fetch(url, { method: "POST", body: form })
            const data = await res.json()
            if (!data.ok && data.necesitaContrasena) {
                _pedirContrasenaImport(url, file, btn, extra.contrasena ? data.error : "")
                return
            }
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
}
