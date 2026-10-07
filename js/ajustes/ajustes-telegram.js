// Ajustes: telegram.
//
// Panel de la pantalla de Ajustes separado de js/ajustes/ajustes.js. Antes todo
// vivía dentro de initAjustesLogic, una sola función de ~3.900 líneas; cada
// panel es ahora una función que initAjustesLogic llama en el mismo orden de
// siempre. Su código no ha cambiado: las funciones internas siguen anidadas.
// Bot de Telegram: token, chat y qué avisos se mandan.
function _initAjustesTelegram() {
    // --- Telegram ---
    const telegramTokenInput = document.getElementById("ajustesTelegramToken")
    const telegramChatIdInput = document.getElementById("ajustesTelegramChatId")
    const telegramStatus = document.getElementById("ajustesTelegramStatus")
    const telegramMsg = document.getElementById("ajustesTelegramMsg")
    const guardarTelegramBtn = document.getElementById("ajustesGuardarTelegramBtn")
    const probarTelegramBtn = document.getElementById("ajustesProbarTelegramBtn")
    const borrarTelegramBtn = document.getElementById("ajustesBorrarTelegramBtn")

    function setTelegramStatus(configurado) {
        if (!telegramStatus) return
        telegramStatus.textContent = configurado ? "✓ Configurado" : "✗ No configurado"
        telegramStatus.className = "ajustesKeyStatus " + (configurado ? "ok" : "missing")
    }

    async function cargarTelegram() {
        try {
            const res = await fetch("/api/settings/telegram")
            const data = await res.json()
            if (!data.ok) return
            setTelegramStatus(data.configurado)
            // El servidor ya no manda el token, solo su máscara: el campo queda
            // vacío y guardar así conserva el que hay. Para cambiarlo, se escribe.
            if (telegramTokenInput) {
                telegramTokenInput.value = ""
                telegramTokenInput.placeholder = data.hayToken
                    ? `${data.tokenVista} (guardado; escribe otro para cambiarlo)`
                    : "123456789:AA…"
                telegramTokenInput.dataset.hayToken = data.hayToken ? "true" : ""
            }
            if (telegramChatIdInput) telegramChatIdInput.value = data.chatId || ""
            pintarAvisosTelegram(data.avisos || [], data.resumenHora)
        } catch {
            /* ignore */
        }
    }

    // Qué tipos de aviso se mandan. Cada interruptor guarda por su cuenta, sin
    // botón: es una preferencia, no un dato que se pueda dejar a medias como el
    // token. Se manda el conjunto entero, que es lo que el servidor guarda.
    const telegramAvisosBox = document.getElementById("ajustesTelegramAvisos")
    const telegramAvisosMsg = document.getElementById("ajustesTelegramAvisosMsg")
    const telegramResumenHora = document.getElementById("ajustesTelegramResumenHora")

    async function guardarAvisosTelegram() {
        const avisos = {}
        telegramAvisosBox?.querySelectorAll("input[data-aviso]").forEach((input) => {
            avisos[input.dataset.aviso] = input.checked
        })
        const resumenHora = Number(telegramResumenHora?.value || 21)
        try {
            const res = await fetch("/api/settings/telegram/avisos", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ avisos, resumenHora })
            })
            const data = await res.json()
            showMsg(
                telegramAvisosMsg,
                data.ok ? "Guardado" : data.error || "Error al guardar",
                data.ok ? "ok" : "error"
            )
        } catch {
            showMsg(telegramAvisosMsg, "Error de red", "error")
        }
    }

    function pintarAvisosTelegram(avisos, resumenHora) {
        if (telegramAvisosBox) {
            telegramAvisosBox.replaceChildren(
                ...avisos.map((aviso) => {
                    const fila = document.createElement("div")
                    fila.className = "ajustesSwitchRow"

                    const etiqueta = document.createElement("div")
                    etiqueta.className = "ajustesSwitchLabel"
                    etiqueta.textContent = aviso.titulo

                    const interruptor = document.createElement("label")
                    interruptor.className = "ajustesSwitch"
                    const input = document.createElement("input")
                    input.type = "checkbox"
                    input.checked = !!aviso.activo
                    input.dataset.aviso = aviso.clave
                    input.addEventListener("change", guardarAvisosTelegram)
                    const pista = document.createElement("span")
                    pista.className = "ajustesSwitchTrack"
                    interruptor.append(input, pista)

                    fila.append(etiqueta, interruptor)
                    return fila
                })
            )
        }

        if (telegramResumenHora && !telegramResumenHora.options.length) {
            for (let hora = 0; hora < 24; hora++) {
                telegramResumenHora.add(new Option(`${String(hora).padStart(2, "0")}:00`, String(hora)))
            }
            telegramResumenHora.addEventListener("change", guardarAvisosTelegram)
        }
        if (telegramResumenHora && Number.isInteger(resumenHora)) {
            telegramResumenHora.value = String(resumenHora)
        }
    }

    cargarTelegram()

    // Guarda lo que haya en los campos. La usan tanto el botón "Guardar" como
    // "Enviar prueba": probar sin haber guardado antes es justo lo que se
    // esperaría de un botón que dice "enviar", así que prueba guarda primero
    // en vez de devolver "falta configurar" con los datos ya escritos delante.
    async function guardarTelegram() {
        const token = (telegramTokenInput?.value || "").trim()
        const chatId = (telegramChatIdInput?.value || "").trim()
        const hayGuardado = Boolean(telegramTokenInput?.dataset.hayToken)
        if ((!token && !hayGuardado) || !chatId) {
            return { ok: false, error: "Rellena el token y el ID de chat" }
        }
        try {
            const res = await fetch("/api/settings/telegram", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token, chatId })
            })
            const data = await res.json()
            if (data.ok) setTelegramStatus(true)
            return data
        } catch {
            return { ok: false, error: "Error de red" }
        }
    }

    if (guardarTelegramBtn) {
        guardarTelegramBtn.addEventListener("click", async () => {
            guardarTelegramBtn.disabled = true
            showMsg(telegramMsg, "Guardando…", "")
            const data = await guardarTelegram()
            showMsg(telegramMsg, data.ok ? "Guardado" : data.error || "Error al guardar", data.ok ? "ok" : "error")
            guardarTelegramBtn.disabled = false
        })
    }

    if (probarTelegramBtn) {
        probarTelegramBtn.addEventListener("click", async () => {
            probarTelegramBtn.disabled = true
            showMsg(telegramMsg, "Enviando…", "")
            try {
                // Si ya estaba configurado esto no cambia nada (mismo token y
                // chatId); si no, deja guardado lo que se acaba de escribir.
                const guardado = await guardarTelegram()
                if (!guardado.ok) {
                    showMsg(telegramMsg, guardado.error || "Error al guardar", "error")
                    return
                }
                const res = await fetch("/api/settings/telegram/prueba", { method: "POST" })
                const data = await res.json()
                showMsg(
                    telegramMsg,
                    data.ok ? "Mensaje enviado" : data.error || "Error al enviar",
                    data.ok ? "ok" : "error"
                )
            } catch {
                showMsg(telegramMsg, "Error de red", "error")
            } finally {
                probarTelegramBtn.disabled = false
            }
        })
    }

    if (borrarTelegramBtn) {
        borrarTelegramBtn.addEventListener("click", () => {
            openConfirmModal({
                title: "Quitar Telegram",
                message: "Se dejarán de enviar avisos por Telegram. Puedes volver a configurarlo cuando quieras.",
                confirmLabel: "Quitar",
                onConfirm: async () => {
                    try {
                        const res = await fetch("/api/settings/telegram", { method: "DELETE" })
                        const data = await res.json()
                        if (data.ok) {
                            if (telegramTokenInput) telegramTokenInput.value = ""
                            if (telegramChatIdInput) telegramChatIdInput.value = ""
                            setTelegramStatus(false)
                            showMsg(telegramMsg, "Eliminado", "ok")
                        } else {
                            showMsg(telegramMsg, data.error || "Error al eliminar", "error")
                        }
                    } catch {
                        showMsg(telegramMsg, "Error de red", "error")
                    }
                }
            })
        })
    }
}
