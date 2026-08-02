// Protección CSRF (double-submit cookie).
//
// El servidor guarda un token en la sesión firmada y lo replica en la cookie
// csrf_token. Aquí se envuelve window.fetch para reenviarlo en la cabecera
// X-CSRF-Token en toda petición que modifique estado. Se hace de forma
// centralizada porque la aplicación tiene más de 160 llamadas a fetch()
// repartidas por los módulos y añadir la cabecera en cada una sería frágil.
//
// Este fichero debe cargarse ANTES que cualquier otro script que use fetch.
(function () {
    "use strict";

    var SAFE_METHODS = { GET: 1, HEAD: 1, OPTIONS: 1, TRACE: 1 };

    function readCsrfToken() {
        var match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
        return match ? decodeURIComponent(match[1]) : "";
    }

    function isSameOrigin(url) {
        try {
            return new URL(url, window.location.href).origin === window.location.origin;
        } catch (e) {
            // URL relativa que no se puede parsear: se trata como propia
            return true;
        }
    }

    var originalFetch = window.fetch.bind(window);

    window.fetch = function (input, init) {
        init = init || {};
        var url = typeof input === "string" ? input : (input && input.url) || "";
        var method = (init.method || (input && input.method) || "GET").toUpperCase();

        // Nunca adjuntar el token a destinos externos: se filtraría a terceros
        if (SAFE_METHODS[method] || !isSameOrigin(url)) {
            return originalFetch(input, init);
        }

        var token = readCsrfToken();
        if (token) {
            var headers = new Headers(init.headers || (input && input.headers) || {});
            headers.set("X-CSRF-Token", token);
            init = Object.assign({}, init, { headers: headers });
        }
        return originalFetch(input, init);
    };
})();
