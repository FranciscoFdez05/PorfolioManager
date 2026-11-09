// HTML de las ventanas guardado en memoria.
//
// loadPage pedía el fragmento HTML de la ventana en cada cambio. Aunque el
// servidor contesta 304 si no cambió, es un viaje de ida y vuelta que bloquea
// todo lo demás: la ventana no empieza a pedir sus datos hasta tener su HTML.
//
// Guardarlo durante la vida de la pestaña es seguro: el HTML solo cambia al
// desplegar una versión nueva, y en ese caso los scripts de esta pestaña
// también son los viejos; mezclar HTML nuevo con JS viejo sería peor. Al
// recargar (o tras una actualización, que recarga) se vuelve a pedir todo.
//
// precargar() descarga los fragmentos de las demás ventanas cuando el
// navegador está libre, de uno en uno para no quitarle conexiones a la
// ventana que se está usando, y así la primera visita también es inmediata.
;(function () {
    "use strict"

    // url → Promise<string>
    const fragmentos = new Map()

    /**
     * Devuelve el HTML de `url`, descargándolo solo la primera vez.
     *
     * Un fallo no se guarda: el siguiente intento vuelve al servidor.
     */
    function obtener(url) {
        const guardado = fragmentos.get(url)
        if (guardado) return guardado

        const promesa = fetch(url).then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status + " al pedir " + url)
            return response.text()
        })
        fragmentos.set(url, promesa)
        promesa.catch(function () {
            if (fragmentos.get(url) === promesa) fragmentos.delete(url)
        })
        return promesa
    }

    function cuandoEsteLibre(tarea) {
        if (typeof window.requestIdleCallback === "function") {
            window.requestIdleCallback(tarea, { timeout: 5000 })
        } else {
            setTimeout(tarea, 1000)
        }
    }

    /**
     * Descarga en segundo plano los fragmentos que aún no estén en memoria.
     *
     * Los errores se ignoran a propósito: es una optimización, y si un
     * fragmento falla aquí, loadPage lo pedirá y mostrará el error al abrirlo.
     */
    function precargar(urls) {
        const pendientes = urls.filter(function (url) {
            return !fragmentos.has(url)
        })

        function siguiente() {
            const url = pendientes.shift()
            if (!url) return
            obtener(url)
                .catch(function () {})
                .then(function () {
                    cuandoEsteLibre(siguiente)
                })
        }

        cuandoEsteLibre(siguiente)
    }

    window.CachePaginas = {
        obtener: obtener,
        precargar: precargar
    }
})()
