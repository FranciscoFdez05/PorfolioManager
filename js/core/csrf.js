// Protección CSRF (double-submit cookie).
//
// El servidor guarda un token en la sesión firmada y lo replica en la cookie
// csrf_token. Aquí se envuelve window.fetch para reenviarlo en la cabecera
// X-CSRF-Token en toda petición que modifique estado. Se hace de forma
// centralizada porque la aplicación tiene más de 160 llamadas a fetch()
// repartidas por los módulos y añadir la cabecera en cada una sería frágil.
//
// Este fichero debe cargarse ANTES que cualquier otro script que use fetch.
;(function () {
    "use strict"

    const SAFE_METHODS = { GET: 1, HEAD: 1, OPTIONS: 1, TRACE: 1 }

    function readCookie(name) {
        const match = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"))
        return match ? decodeURIComponent(match[1]) : ""
    }

    // Por el puerto HTTP que convive con el HTTPS, el servidor emite la cookie
    // como csrf_token_http (ver SUFIJO_COOKIE_HTTP en core/seguridad_app.py).
    // Por https:// también se ve esa cookie, que no lleva Secure, así que solo
    // se mira en claro.
    function readCsrfToken() {
        if (window.location.protocol === "http:") {
            return readCookie("csrf_token_http") || readCookie("csrf_token")
        }
        return readCookie("csrf_token")
    }

    function isSameOrigin(url) {
        try {
            return new URL(url, window.location.href).origin === window.location.origin
        } catch {
            // URL relativa que no se puede parsear: se trata como propia
            return true
        }
    }

    const originalFetch = window.fetch.bind(window)

    window.fetch = function (input, init) {
        init = init || {}
        const url = typeof input === "string" ? input : (input && input.url) || ""
        const method = (init.method || (input && input.method) || "GET").toUpperCase()

        // Nunca adjuntar el token a destinos externos: se filtraría a terceros
        if (SAFE_METHODS[method] || !isSameOrigin(url)) {
            return originalFetch(input, init)
        }

        const token = readCsrfToken()
        if (token) {
            const headers = new Headers(init.headers || (input && input.headers) || {})
            headers.set("X-CSRF-Token", token)
            init = Object.assign({}, init, { headers: headers })
        }
        return originalFetch(input, init)
    }
})()
