// Ajustes: api.
//
// Panel de la pantalla de Ajustes separado de js/ajustes/ajustes.js. Antes todo
// vivía dentro de initAjustesLogic, una sola función de ~3.900 líneas; cada
// panel es ahora una función que initAjustesLogic llama en el mismo orden de
// siempre. Su código no ha cambiado: las funciones internas siguen anidadas.
// Claves de API de los proveedores de cotizaciones.
function _initAjustesClaves(settings) {
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

    // El listado solo trae la máscara y una huella: el valor se pide al pulsar
    // el ojo y no se guarda en ningún sitio, así que al ocultarla se olvida.
    // Antes venían todas las claves enteras con el listado y quedaban en la
    // memoria de la pestaña cada vez que se abría Ajustes.
    async function _alternarClave(proveedor, clave, valorEl, btn) {
        const visible = btn.dataset.visible !== "1"
        let texto = clave.vista
        if (visible) {
            try {
                const res = await fetch("/api/settings/apikey/ver", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ proveedor, huella: clave.huella })
                })
                const data = await res.json()
                if (!data.ok) {
                    showMsg(_mensajesClaves[proveedor], data.error || "No se pudo mostrar la clave", "error")
                    return
                }
                texto = data.clave
            } catch {
                showMsg(_mensajesClaves[proveedor], "Error de red", "error")
                return
            }
        }
        valorEl.textContent = texto
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
            message: `Vas a eliminar la clave ${clave.vista} de ${nombre}.${aviso} Esta acción no se puede deshacer.`,
            confirmLabel: "Eliminar",
            requireText: clave.vista,
            onConfirm: async () => {
                fila.style.opacity = "0.4"
                try {
                    const res = await fetch("/api/settings/apikey", {
                        method: "DELETE",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ proveedor, huella: clave.huella })
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
            ojo.addEventListener("click", () => _alternarClave(proveedor, clave, valor, ojo))

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
}

// Uso y estado de las APIs y tipos de cambio.
function _initAjustesEstadoApis() {
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
        totalRow.innerHTML = `<span class="ajustesApiStatsProvider">Total</span><span class="ajustesApiStatsCount">${escapeHtml(data.total)}</span>`
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

    async function togglePausaApi(proveedor, boton) {
        boton.disabled = true
        try {
            const res = await fetch("/api/settings/apis-pausadas", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ proveedor: proveedor.id, pausada: !proveedor.pausada })
            })
            const data = await res.json()
            if (!data.ok) throw new Error(data.error || "")
            // El estado cacheado se reetiqueta en el servidor: no gasta cuota.
            await loadApiEstado()
        } catch (error) {
            boton.disabled = false
            showMsg(apiEstadoMsg, error.message || "No se pudo cambiar", "error")
        }
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

            if (p.pausable) {
                const pausa = document.createElement("button")
                pausa.type = "button"
                pausa.className = "ajustesApiPausaBtn"
                pausa.textContent = p.pausada ? "Reanudar" : "Pausar"
                pausa.title = p.pausada
                    ? `Volver a pedir cotizaciones a ${p.nombre}`
                    : `Dejar de pedir cotizaciones a ${p.nombre} (sus claves se conservan)`
                pausa.addEventListener("click", () => togglePausaApi(p, pausa))
                row.appendChild(pausa)
            }
            if (p.pausada) row.classList.add("pausada")
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

    // --- Tipos de cambio ---
    // Los que usa la aplicación al convertir, del mismo servicio y en el mismo
    // orden (Frankfurter y, si falla, open.er-api.com). Sirve para ver si
    // responde y de qué día es el dato: Frankfurter publica la referencia del
    // BCE una vez por día hábil, así que el número no cambia de minuto a minuto.
    const cambioBaseSel = document.getElementById("ajustesCambioBase")
    const cambioListEl = document.getElementById("ajustesCambioList")
    const cambioBtn = document.getElementById("ajustesCambioBtn")
    const cambioMsg = document.getElementById("ajustesCambioMsg")
    const cambioAuto = document.getElementById("ajustesCambioAuto")
    let cambioTimer = null

    const _formatoTipo = (rate) =>
        Number(rate).toLocaleString("es-ES", { minimumFractionDigits: 4, maximumFractionDigits: 6 })

    function _fechaDato(fecha) {
        // Frankfurter da "2026-09-25"; open.er-api.com una fecha HTTP completa.
        const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(fecha) ? `${fecha}T00:00:00` : fecha)
        return Number.isNaN(d.getTime()) ? fecha : d.toLocaleDateString("es-ES")
    }

    async function loadCambioBases() {
        if (!cambioBaseSel) return
        let divisas = []
        try {
            const res = await fetch("/api/divisas")
            const data = await res.json()
            divisas = data.divisas || []
        } catch {
            // Sin lista no hay de dónde elegir: se sigue con la moneda base.
        }
        const preferida = String(window._monedaBase || "").toUpperCase()
        if (preferida && !divisas.some((d) => d.code === preferida))
            divisas.unshift({ code: preferida, name: preferida })
        cambioBaseSel.innerHTML = ""
        divisas.forEach(({ code, name }) => {
            const opt = document.createElement("option")
            opt.value = code
            opt.textContent = name && name !== code ? `${code} · ${name}` : code
            cambioBaseSel.appendChild(opt)
        })
        if (preferida) cambioBaseSel.value = preferida
        // El desplegable de Ajustes se construyó con el <select> aún vacío y
        // solo refresca su etiqueta con "change"; lanzarlo pediría los tipos dos
        // veces al abrir, así que se pone a mano.
        const etiqueta = cambioBaseSel.closest(".ajustesDropWrapper")?.querySelector(".ajustesDropLabel")
        if (etiqueta) etiqueta.textContent = cambioBaseSel.options[cambioBaseSel.selectedIndex]?.text || ""
    }

    function renderCambios(data) {
        cambioListEl.innerHTML = ""
        ;(data.cambios || []).forEach((c) => {
            const row = document.createElement("div")
            row.className = "ajustesApiEstadoRow"

            const nombre = document.createElement("span")
            nombre.className = "ajustesApiEstadoProvider"
            nombre.textContent = `${c.code} · ${c.name}`
            nombre.title = `1 ${data.base} = ${_formatoTipo(c.rate)} ${c.code}`

            const tipo = document.createElement("span")
            tipo.className = "ajustesApiEstadoBadge ok"
            tipo.textContent = _formatoTipo(c.rate)

            row.appendChild(nombre)
            row.appendChild(tipo)
            cambioListEl.appendChild(row)
        })

        const comprobado = new Date(data.comprobado)
        const hora = Number.isNaN(comprobado.getTime()) ? "" : comprobado.toLocaleTimeString("es-ES")
        const pie = document.createElement("div")
        pie.className = "ajustesApiEstadoPie"
        pie.textContent =
            `${data.fuente} · dato del ${_fechaDato(data.fecha)} · respondió en ${data.ms} ms` +
            (hora ? ` · comprobado a las ${hora}` : "")
        cambioListEl.appendChild(pie)
    }

    async function loadCambios({ manual = false, inicial = false } = {}) {
        if (!cambioListEl) return
        // Con Ajustes cerrado no se gasta la petición del refresco automático.
        if (!manual && !inicial && !cambioListEl.offsetParent) return
        const base = cambioBaseSel?.value || window._monedaBase || ""
        if (cambioBtn) cambioBtn.disabled = true
        if (manual) showMsg(cambioMsg, "Comprobando…", "")
        try {
            const res = await fetch(`/api/divisas/cambio?base=${encodeURIComponent(base)}`)
            const data = await res.json()
            if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`)
            renderCambios(data)
            if (manual) showMsg(cambioMsg, "Funciona", "ok")
        } catch (error) {
            cambioListEl.innerHTML = ""
            const row = document.createElement("div")
            row.className = "ajustesApiEstadoRow"
            const nombre = document.createElement("span")
            nombre.className = "ajustesApiEstadoProvider"
            nombre.textContent = "Servicio de cambio"
            const badge = document.createElement("span")
            badge.className = "ajustesApiEstadoBadge caido"
            badge.textContent = "No responde"
            row.title = error.message
            row.appendChild(nombre)
            row.appendChild(badge)
            cambioListEl.appendChild(row)
            if (manual) showMsg(cambioMsg, error.message || "Error al comprobar", "error")
        } finally {
            if (cambioBtn) cambioBtn.disabled = false
        }
    }

    cambioBtn?.addEventListener("click", () => loadCambios({ manual: true }))
    cambioBaseSel?.addEventListener("change", () => loadCambios({ manual: true }))
    cambioAuto?.addEventListener("change", () => {
        clearInterval(cambioTimer)
        cambioTimer = cambioAuto.checked ? setInterval(() => loadCambios(), 60_000) : null
    })
    loadCambioBases().then(() => loadCambios({ inicial: true }))
}
