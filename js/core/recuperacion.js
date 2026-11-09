// Red de seguridad del frontend: errores no capturados y vuelta del servidor.
//
// Dos huecos que dejaban la pantalla bloqueada sin decir nada:
//
//   1. Una excepción o una promesa rechazada que ningún módulo captura solo
//      llegaba a la consola. Para el usuario, la pantalla simplemente dejaba
//      de reaccionar. Ahora se avisa (como mucho un aviso cada pocos segundos,
//      para no tapar la pantalla si el mismo fallo se repite en bucle).
//   2. Cuando el servidor se reinicia (el supervisor de la web lo hace solo si
//      deja de estar sano) o se va la red, la vista que estuviera cargándose
//      se quedaba en «Error de carga» hasta que alguien volviera a pulsar el
//      menú. Ahora se pregunta a /api/health con espera creciente y, en cuanto
//      responde, se vuelve a abrir la vista que había fallado.
//
// Debe cargarse después de dom.js (usa showToast).
;(function () {
    "use strict"

    const SEPARACION_AVISOS_MS = 10000
    const ESPERA_INICIAL_MS = 2000
    const ESPERA_MAXIMA_MS = 30000
    const TIMEOUT_SONDA_MS = 5000
    const ESTADOS_SERVIDOR_CAIDO = { 502: 1, 503: 1, 504: 1 }
    // Ruido conocido que no indica ningún fallo de la aplicación: el aviso del
    // ResizeObserver es benigno y «Script error.» viene de scripts de otro
    // origen (extensiones del navegador) sin ningún detalle utilizable.
    const MENSAJES_IGNORADOS = [/ResizeObserver loop/i, /^Script error\.?$/i]

    let ultimoAviso = 0
    let avisoSinConexion = null
    let esperandoServidor = false

    function mensajeDe(motivo) {
        if (motivo == null) return ""
        if (typeof motivo === "string") return motivo
        return String(motivo.message || motivo)
    }

    function esRuido(motivo) {
        // Una petición cancelada a propósito (cambio de página) no es un fallo.
        if (motivo && motivo.name === "AbortError") return true
        const texto = mensajeDe(motivo)
        return MENSAJES_IGNORADOS.some((patron) => patron.test(texto))
    }

    function esFalloDeServidor(motivo) {
        if (!motivo || typeof motivo !== "object") return false
        return !!(motivo.isNetwork || motivo.isTimeout || ESTADOS_SERVIDOR_CAIDO[motivo.status])
    }

    function avisar(mensaje, opciones) {
        if (typeof window.showToast !== "function") return
        const ahora = Date.now()
        if (ahora - ultimoAviso < SEPARACION_AVISOS_MS) return
        ultimoAviso = ahora
        window.showToast(mensaje, opciones)
    }

    function alFallar(motivo) {
        if (esRuido(motivo)) return
        console.error("Error no capturado:", motivo)
        if (esFalloDeServidor(motivo)) {
            esperarServidor()
            return
        }
        avisar("Algo ha fallado en esta pantalla. Si deja de responder, vuelve a abrirla desde el menú.", {
            type: "error"
        })
    }

    function mostrarSinConexion() {
        if (avisoSinConexion || typeof window.showToast !== "function") return
        // Un día de duración: se quita a mano en cuanto vuelve el servidor.
        avisoSinConexion = window.showToast("Sin conexión con el servidor. Se reintentará automáticamente.", {
            type: "warning",
            duration: 86400000
        })
    }

    function quitarSinConexion() {
        if (avisoSinConexion && avisoSinConexion.parentNode) avisoSinConexion.parentNode.removeChild(avisoSinConexion)
        avisoSinConexion = null
    }

    async function servidorResponde() {
        try {
            // fetch nativo con no-store: ni la caché del navegador ni cache-api.js
            // pueden contestar por el servidor.
            const respuesta = await window.fetch("/api/health", {
                cache: "no-store",
                signal: AbortSignal.timeout(TIMEOUT_SONDA_MS)
            })
            return respuesta.ok
        } catch {
            return false
        }
    }

    function vistaConError() {
        return !!document.querySelector("#dynamicContent .pageError")
    }

    function reabrirVista() {
        const pagina = window._paginaActual
        if (!pagina || typeof window.loadPage !== "function" || !vistaConError()) return
        Promise.resolve(window.loadPage(pagina)).catch((error) => console.error("Reapertura de la vista:", error))
    }

    function esperar(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }

    // Un solo bucle a la vez aunque fallen veinte peticiones seguidas. La
    // espera crece hasta 30 s para no martillear un servidor que está
    // arrancando (la reparación de la BD al iniciar puede tardar).
    async function esperarServidor() {
        if (esperandoServidor) return
        esperandoServidor = true
        let espera = ESPERA_INICIAL_MS
        let huboCaida = false
        try {
            while (!(await servidorResponde())) {
                huboCaida = true
                mostrarSinConexion()
                await esperar(espera)
                espera = Math.min(espera * 2, ESPERA_MAXIMA_MS)
            }
            if (avisoSinConexion) {
                quitarSinConexion()
                if (typeof window.showToast === "function") {
                    window.showToast("Conexión recuperada.", { type: "success" })
                }
            }
            // Solo si el servidor estuvo caído: si contesta a la primera, el
            // «Error de carga» es un fallo de la propia vista y reabrirla
            // repetiría el error en bucle.
            if (huboCaida) reabrirVista()
        } finally {
            esperandoServidor = false
        }
    }

    window.addEventListener("error", (evento) => alFallar(evento.error || evento.message))
    window.addEventListener("unhandledrejection", (evento) => alFallar(evento.reason))
    window.addEventListener("offline", mostrarSinConexion)
    window.addEventListener("online", esperarServidor)

    // loadPage (app-core.js) captura sus fallos y pinta «Error de carga» sin
    // propagarlos, así que no llegan a los manejadores de arriba. Se detecta
    // ese bloque al aparecer y se comprueba si la causa es el servidor.
    function vigilarErroresDeCarga() {
        const contenedor = document.getElementById("dynamicContent")
        if (!contenedor || typeof MutationObserver !== "function") return
        new MutationObserver(() => {
            if (vistaConError()) esperarServidor()
        }).observe(contenedor, { childList: true })
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", vigilarErroresDeCarga)
    else vigilarErroresDeCarga()

    window.Recuperacion = { esperarServidor, alFallar }
})()
