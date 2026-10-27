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
        telegramStatus.replaceChildren(
            crearIcono(configurado ? "Ok" : "Error"),
            configurado ? " Configurado" : " No configurado"
        )
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

    // Con la verificación en dos pasos activa, el bot es el segundo factor y
    // cambiarlo pide la contraseña más un código enviado al chat actual o la
    // frase de recuperación. El bloque se crea aquí en vez de en index.html y
    // solo aparece cuando el servidor contesta que hace falta.
    const verificacion = crearBloqueVerificacion()

    function crearCampo(id, etiquetaTexto, control, extra) {
        const campo = document.createElement("div")
        campo.className = "ajustesField"
        const etiqueta = document.createElement("label")
        etiqueta.className = "ajustesLabel"
        etiqueta.htmlFor = id
        etiqueta.textContent = etiquetaTexto
        control.id = id
        control.classList.add("ajustesInput")
        if (extra) {
            const fila = document.createElement("div")
            fila.className = "ajustesInputRow"
            fila.append(control, extra)
            campo.append(etiqueta, fila)
        } else {
            campo.append(etiqueta, control)
        }
        return campo
    }

    function crearBloqueVerificacion() {
        const acciones = guardarTelegramBtn?.closest(".ajustesActions")
        if (!acciones) return null

        const password = document.createElement("input")
        password.type = "password"
        password.autocomplete = "current-password"
        password.placeholder = "Contraseña actual…"

        const codigo = document.createElement("input")
        codigo.type = "text"
        codigo.inputMode = "numeric"
        codigo.maxLength = 8
        codigo.autocomplete = "one-time-code"
        codigo.placeholder = "123456"

        const enviarCodigoBtn = document.createElement("button")
        enviarCodigoBtn.type = "button"
        enviarCodigoBtn.className = "ajustesSecondaryBtn"
        enviarCodigoBtn.textContent = "Enviar código"

        const frase = document.createElement("textarea")
        frase.classList.add("ajustes2faTextarea")
        frase.autocomplete = "off"
        frase.setAttribute("autocapitalize", "none")
        frase.spellcheck = false

        const bloque = document.createElement("div")
        bloque.className = "ajustes2faBloque"
        bloque.hidden = true
        bloque.append(
            crearCampo("ajustesTelegramPwd2fa", "Contraseña actual", password),
            crearCampo("ajustesTelegramCodigo2fa", "Código enviado al chat actual", codigo, enviarCodigoBtn),
            crearCampo("ajustesTelegramFrase2fa", "O, si el bot actual ya no funciona, la frase de recuperación", frase)
        )
        acciones.before(bloque)

        enviarCodigoBtn.addEventListener("click", async () => {
            enviarCodigoBtn.disabled = true
            try {
                const res = await fetch("/api/settings/telegram/codigo", { method: "POST" })
                const data = await res.json()
                showMsg(
                    telegramMsg,
                    data.ok ? "Código enviado al chat actual" : data.error || "No se pudo enviar",
                    data.ok ? "ok" : "error"
                )
            } catch {
                showMsg(telegramMsg, "Error de red", "error")
            } finally {
                enviarCodigoBtn.disabled = false
            }
        })

        return {
            bloque,
            datos() {
                if (bloque.hidden) return {}
                return { currentPassword: password.value, codigo: codigo.value.trim(), frase: frase.value }
            },
            mostrar() {
                bloque.hidden = false
            },
            ocultar() {
                password.value = ""
                codigo.value = ""
                frase.value = ""
                bloque.hidden = true
            }
        }
    }

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
                body: JSON.stringify({ token, chatId, ...(verificacion?.datos() || {}) })
            })
            const data = await res.json()
            if (data.ok) {
                setTelegramStatus(true)
                verificacion?.ocultar()
            } else if (data.requiereVerificacion) {
                verificacion?.mostrar()
            }
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
