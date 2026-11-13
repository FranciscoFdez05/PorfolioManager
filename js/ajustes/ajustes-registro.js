// Ajustes: registro interno.
//
// Muestra si el registro en archivo está activo, si el proceso corre en Docker y
// las últimas líneas del log de la web o del worker (los errores del navegador
// entran en el de la web). Las líneas se piden al abrir la pestaña y al recargar;
// no hay sondeo para no cargar el servidor.
function _initAjustesRegistro() {
    const estadoEl = document.getElementById("ajustesRegistroEstado")
    const logEl = document.getElementById("ajustesRegistroLog")
    const procesoEl = document.getElementById("ajustesRegistroProceso")
    const nivelEl = document.getElementById("ajustesRegistroNivel")
    const recargarBtn = document.getElementById("ajustesRegistroRecargar")
    const copiarBtn = document.getElementById("ajustesRegistroCopiar")
    const pestana = document.querySelector('.sttNavBtn[data-stt="registro"]')
    if (!estadoEl || !logEl || !procesoEl || !nivelEl) return

    const NOMBRES = { web: "Web", worker: "Worker" }

    function formatearTamano(bytes) {
        if (bytes < 1024) return `${bytes} B`
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }

    function formatearFecha(segundos) {
        return segundos ? new Date(segundos * 1000).toLocaleString("es-ES") : "sin actividad"
    }

    function pintarEstado(datos) {
        const lineas = []
        lineas.push(
            datos.habilitado
                ? `Registro en archivo: ${datos.activo ? "activo" : "habilitado pero no activo (no se puede escribir en la carpeta de logs)"}`
                : "Registro en archivo: desactivado (registros.archivo = false)"
        )
        lineas.push(`Entorno: ${datos.docker ? "Docker" : "local"} · nivel ${datos.nivel} · proceso ${datos.proceso || "ninguno"} (pid ${datos.pid})`)
        datos.archivos.forEach((archivo) => {
            lineas.push(
                archivo.existe
                    ? `${NOMBRES[archivo.proceso]}: ${formatearTamano(archivo.bytes)} · última escritura ${formatearFecha(archivo.modificado)}`
                    : `${NOMBRES[archivo.proceso]}: sin archivo todavía`
            )
        })
        estadoEl.textContent = lineas.join("\n")
    }

    async function cargarEstado() {
        try {
            const respuesta = await fetch("/api/registro/estado")
            const datos = await respuesta.json()
            if (!respuesta.ok || !datos.ok) throw new Error(datos.error || `HTTP ${respuesta.status}`)
            pintarEstado(datos)
        } catch (error) {
            estadoEl.textContent = `No se pudo leer el estado: ${error.message}`
        }
    }

    async function cargarLog() {
        logEl.textContent = "Cargando…"
        const params = new URLSearchParams({ lineas: "400", nivel: nivelEl.value })
        try {
            const respuesta = await fetch(`/api/registro/${encodeURIComponent(procesoEl.value)}?${params}`)
            const datos = await respuesta.json()
            if (!respuesta.ok || !datos.ok) throw new Error(datos.error || `HTTP ${respuesta.status}`)
            logEl.textContent = datos.lineas.length ? datos.lineas.join("\n") : "Sin líneas todavía."
            logEl.scrollTop = logEl.scrollHeight
        } catch (error) {
            logEl.textContent = `No se pudo leer el log: ${error.message}`
        }
    }

    function recargar() {
        cargarEstado()
        cargarLog()
    }

    async function copiar() {
        try {
            await navigator.clipboard.writeText(logEl.textContent)
            copiarBtn.textContent = "Copiado"
        } catch {
            copiarBtn.textContent = "No se pudo copiar"
        }
        setTimeout(() => {
            copiarBtn.textContent = "Copiar"
        }, 1500)
    }

    pestana?.addEventListener("click", recargar)
    recargarBtn?.addEventListener("click", recargar)
    copiarBtn?.addEventListener("click", copiar)
    procesoEl.addEventListener("change", cargarLog)
    nivelEl.addEventListener("change", cargarLog)
}
