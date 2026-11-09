// Caché en memoria de las lecturas a la API.
//
// Al cambiar de ventana, cada página vuelve a pedir datos que la anterior
// acababa de descargar (/api/activos, /api/cuentas, /api/operaciones…): ida y
// vuelta al servidor y consultas a SQLite repetidas para obtener lo mismo.
// Este módulo guarda esas respuestas unos segundos y las sirve desde memoria.
//
// Reglas, por orden de importancia:
//
//   1. Solo se cachean GET de las rutas de RUTAS_CACHEABLES: datos que viven
//      en la BD y que solo cambian con una escritura. Es una lista blanca a
//      propósito: un endpoint nuevo, una cotización o el sondeo de una
//      actualización nunca se cachean por descuido.
//   2. Cualquier escritura (POST/PUT/PATCH/DELETE a /api) vacía la caché
//      entera, al empezar y al terminar. Vaciarla solo al empezar dejaría
//      guardar una lectura lanzada mientras la escritura estaba en curso, que
//      puede traer el estado de antes.
//   3. TTL corto (TTL_MS): acota lo desfasado que puede verse un dato cambiado
//      fuera de esta pestaña (otra pestaña, el worker de snapshots).
//   4. Una lectura igual a otra que sigue en vuelo se engancha a esa en vez de
//      repetirla (Transacciones pedía dos veces el mismo /api/activos-lote).
//   5. `cache: "no-store"` o `cache: "reload"` en la llamada, o
//      `Cache-Control: no-store` en la respuesta, saltan la caché.
//
// Debe cargarse DESPUÉS de api.js: envuelve el fetch ya envuelto, de modo que
// lo que se guarda es una respuesta que ya pasó por el control de sesión y
// timeouts, y Api.request (que llama al fetch global) también se beneficia.
;(function () {
    "use strict"

    const TTL_MS = 30000
    // Las respuestas pesan pocos KB; el tope solo evita crecer sin límite si
    // una página pide muchas URL distintas (p. ej. una por año o por rango).
    const MAX_ENTRADAS = 150

    const RUTAS_CACHEABLES = [
        /^\/api\/activos$/,
        /^\/api\/activos-lote$/,
        /^\/api\/cuentas$/,
        /^\/api\/cuentas\/(historico|saldos-mes)$/,
        /^\/api\/cuenta-ahorro$/,
        /^\/api\/transferencias$/,
        /^\/api\/operaciones$/,
        /^\/api\/transacciones$/,
        /^\/api\/stablecoins$/,
        /^\/api\/ventas(\/\d{4})?$/,
        /^\/api\/(gastos|ingresos)(\/(\d{4}|todos))?$/,
        /^\/api\/(gastos|ingresos)-tipos$/,
        /^\/api\/(intereses|dividendos)$/,
        /^\/api\/(bonos|rentafija|privatemarket)$/,
        /^\/api\/(trading|staking|earn)$/,
        /^\/api\/planes-cartera$/,
        /^\/api\/metricas\/inversiones$/,
        /^\/api\/portfolio\/history(\/by-type)?$/,
        /^\/api\/portfolio\/rentabilidad$/,
        /^\/api\/settings$/
    ]

    const METODOS_LECTURA = { GET: 1, HEAD: 1 }

    // url → { creada, promesa }. La promesa resuelve a la respuesta ya leída
    // ({ cuerpo, status, statusText, cabeceras }) para poder fabricar una
    // Response nueva en cada acierto: el cuerpo de una Response solo se puede
    // leer una vez.
    const entradas = new Map()
    // Sube con cada escritura. Una lectura solo se guarda si al terminar sigue
    // en la misma generación que cuando empezó (regla 2).
    let generacion = 0

    const fetchSiguiente = window.fetch.bind(window)

    function urlDe(input) {
        return typeof input === "string" ? input : (input && input.url) || String(input || "")
    }

    function metodoDe(input, init) {
        return ((init && init.method) || (input && input.method) || "GET").toUpperCase()
    }

    function destinoApi(url) {
        try {
            const destino = new URL(url, window.location.href)
            if (destino.origin !== window.location.origin) return null
            return destino.pathname.indexOf("/api/") === 0 ? destino : null
        } catch {
            return null
        }
    }

    function esCacheable(destino, init) {
        const modo = init && init.cache
        if (modo === "no-store" || modo === "reload") return false
        return RUTAS_CACHEABLES.some((patron) => patron.test(destino.pathname))
    }

    function vaciar() {
        generacion++
        entradas.clear()
    }

    function vigente(entrada) {
        return entrada && Date.now() - entrada.creada < TTL_MS
    }

    function guardar(clave, entrada) {
        entradas.delete(clave)
        entradas.set(clave, entrada)
        // Map conserva el orden de inserción: la primera es la más antigua.
        while (entradas.size > MAX_ENTRADAS) entradas.delete(entradas.keys().next().value)
    }

    function respuestaDesde(guardada) {
        return new Response(guardada.cuerpo, {
            status: guardada.status,
            statusText: guardada.statusText,
            headers: guardada.cabeceras
        })
    }

    /**
     * Rechaza en cuanto se aborte `signal` sin cancelar la petición compartida.
     *
     * Varias llamadas pueden estar enganchadas a la misma lectura; si quien la
     * lanzó cambia de página y aborta, las demás deben seguir recibiéndola.
     */
    function conSenal(promesa, signal) {
        if (!signal) return promesa
        if (signal.aborted) return Promise.reject(signal.reason || new DOMException("Aborted", "AbortError"))
        return new Promise(function (resolve, reject) {
            function alAbortar() {
                reject(signal.reason || new DOMException("Aborted", "AbortError"))
            }
            signal.addEventListener("abort", alAbortar, { once: true })
            promesa.then(
                function (valor) {
                    signal.removeEventListener("abort", alAbortar)
                    resolve(valor)
                },
                function (error) {
                    signal.removeEventListener("abort", alAbortar)
                    reject(error)
                }
            )
        })
    }

    function esGuardable(respuesta) {
        const cacheControl = (respuesta.headers.get("Cache-Control") || "").toLowerCase()
        return respuesta.status === 200 && cacheControl.indexOf("no-store") === -1
    }

    /**
     * Lanza la lectura, la deja en la caché y devuelve la Response de quien la pidió.
     *
     * `entrada.promesa` resuelve a la respuesta leída, o a null si no se puede
     * guardar (un error, un no-store): en ese caso quien estuviera enganchado
     * repite la petición por su cuenta, porque ese cuerpo es de quien la lanzó.
     */
    function leerYGuardar(clave, input, init) {
        const generacionInicial = generacion
        // La petición compartida no lleva la señal de quien la lanzó (ver
        // conSenal); el corte por tiempo lo sigue poniendo api.js.
        const initCompartido = init ? Object.assign({}, init, { signal: undefined }) : undefined
        const respuesta = fetchSiguiente(input, initCompartido)
        const entrada = { creada: Date.now(), promesa: null }

        entrada.promesa = respuesta.then(function (r) {
            if (!esGuardable(r)) return null
            return r.arrayBuffer().then(function (cuerpo) {
                return {
                    cuerpo: cuerpo,
                    status: r.status,
                    statusText: r.statusText,
                    cabeceras: Array.from(r.headers.entries())
                }
            })
        })

        // Lo que no se puede reutilizar sale de la caché: un fallo, una
        // respuesta no guardable o una lectura que cruzó una escritura.
        entrada.promesa.then(
            function (guardada) {
                if (entradas.get(clave) !== entrada) return
                if (!guardada || generacion !== generacionInicial) entradas.delete(clave)
            },
            function () {
                if (entradas.get(clave) === entrada) entradas.delete(clave)
            }
        )

        if (generacion === generacionInicial) guardar(clave, entrada)

        return respuesta.then(function (r) {
            return esGuardable(r) ? entrada.promesa.then(respuestaDesde) : r
        })
    }

    function engancharA(entrada, input, init) {
        return entrada.promesa.then(function (guardada) {
            return guardada ? respuestaDesde(guardada) : fetchSiguiente(input, init)
        })
    }

    window.fetch = function (input, init) {
        const destino = destinoApi(urlDe(input))
        if (!destino) return fetchSiguiente(input, init)

        const metodo = metodoDe(input, init)
        if (!METODOS_LECTURA[metodo]) {
            vaciar()
            const resultado = fetchSiguiente(input, init)
            resultado.then(vaciar, vaciar)
            return resultado
        }

        if (metodo !== "GET" || !esCacheable(destino, init)) return fetchSiguiente(input, init)

        const clave = destino.pathname + destino.search
        const entrada = entradas.get(clave)
        const signal = init && init.signal
        if (vigente(entrada)) return conSenal(engancharA(entrada, input, init), signal)
        return conSenal(leerYGuardar(clave, input, init), signal)
    }

    window.CacheApi = {
        vaciar: vaciar,
        TTL_MS: TTL_MS
    }
})()
