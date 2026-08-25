// Capa única de acceso a la API.
//
// La aplicación tenía ~165 llamadas a fetch() repartidas por los módulos, cada
// una con su propio manejo de errores (o sin ninguno). Los problemas reales que
// resuelve este fichero:
//
//   1. Sesión caducada. El backend responde 401 a /api/*, pero ningún módulo lo
//      trataba: el `response.json()` posterior fallaba con un error de sintaxis
//      y la pantalla se quedaba a medias sin decir nada. Ahora cualquier 401
//      lleva al login conservando la página en la que estabas.
//   2. Peticiones colgadas. Sin timeout, una llamada que no responde deja el
//      spinner girando indefinidamente.
//   3. Errores del servidor ilegibles. El backend ya devuelve
//      {ok:false, error, requestId}; aquí se extrae ese mensaje y se expone en
//      ApiError.message, con el requestId para poder buscarlo en los logs.
//
// Debe cargarse DESPUÉS de csrf.js (que envuelve fetch para la cabecera CSRF) y
// ANTES del resto de módulos.
;(function () {
    "use strict"

    const DEFAULT_TIMEOUT_MS = 20000
    // Solo se reintentan peticiones idempotentes: repetir un POST podría
    // duplicar filas.
    const IDEMPOTENT_METHODS = { GET: 1, HEAD: 1 }
    const RETRYABLE_STATUS = { 502: 1, 503: 1, 504: 1 }
    const DEFAULT_RETRIES = 1

    let redirectingToLogin = false

    function ApiError(message, options) {
        options = options || {}
        const error = Error.call(this, message)
        this.name = "ApiError"
        this.message = message
        this.stack = error.stack
        this.status = options.status || 0
        this.requestId = options.requestId || ""
        this.payload = options.payload || null
        this.field = options.field || ""
        // Distingue "no hay red / no respondió" de "el servidor dijo que no",
        // que es lo que decide si merece la pena reintentar o avisar al usuario.
        this.isNetwork = !!options.isNetwork
        this.isTimeout = !!options.isTimeout
    }
    ApiError.prototype = Object.create(Error.prototype)
    ApiError.prototype.constructor = ApiError

    function goToLogin() {
        if (redirectingToLogin) return
        redirectingToLogin = true
        const next = encodeURIComponent(window.location.pathname + window.location.search)
        window.location.assign("/login?next=" + next)
    }

    function sleep(ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms)
        })
    }

    // El cuerpo de error puede ser JSON (lo normal desde la capa de errores del
    // backend) o HTML (un proxy intermedio, por ejemplo). Nunca debe hacer que
    // el manejo de errores falle a su vez.
    function readErrorBody(response) {
        return response
            .text()
            .then(function (text) {
                if (!text) return null
                try {
                    return JSON.parse(text)
                } catch {
                    return { error: text.slice(0, 200) }
                }
            })
            .catch(function () {
                return null
            })
    }

    function buildHttpError(response, body) {
        const message = (body && (body.error || body.message)) || "Error " + response.status + " del servidor"
        return new ApiError(message, {
            status: response.status,
            requestId: (body && body.requestId) || response.headers.get("X-Request-Id") || "",
            payload: body,
            field: (body && body.field) || ""
        })
    }

    function request(url, options) {
        options = options || {}
        const method = (options.method || "GET").toUpperCase()
        const timeout = options.timeout != null ? options.timeout : DEFAULT_TIMEOUT_MS
        const retries = options.retries != null ? options.retries : IDEMPOTENT_METHODS[method] ? DEFAULT_RETRIES : 0

        const init = { method: method, headers: {} }
        Object.keys(options.headers || {}).forEach(function (key) {
            init.headers[key] = options.headers[key]
        })

        if (options.body !== undefined && options.body !== null) {
            if (options.body instanceof FormData || typeof options.body === "string") {
                init.body = options.body
            } else {
                init.headers["Content-Type"] = "application/json"
                init.body = JSON.stringify(options.body)
            }
        }

        function attempt(remaining, delay) {
            const controller = new AbortController()
            let timedOut = false
            const timer = setTimeout(function () {
                timedOut = true
                controller.abort()
            }, timeout)

            // Si quien llama trae su propio signal (p. ej. para cancelar al
            // cambiar de página), se encadena con el del timeout.
            if (options.signal) {
                if (options.signal.aborted) controller.abort()
                else
                    options.signal.addEventListener("abort", function () {
                        controller.abort()
                    })
            }
            init.signal = controller.signal

            return fetch(url, init).then(
                function (response) {
                    clearTimeout(timer)

                    if (response.status === 401) {
                        goToLogin()
                        throw new ApiError("Sesión caducada", { status: 401 })
                    }

                    if (!response.ok) {
                        if (RETRYABLE_STATUS[response.status] && remaining > 0) {
                            return sleep(delay).then(function () {
                                return attempt(remaining - 1, delay * 2)
                            })
                        }
                        return readErrorBody(response).then(function (body) {
                            throw buildHttpError(response, body)
                        })
                    }

                    if (response.status === 204 || options.raw) {
                        return options.raw ? response : null
                    }

                    return response.text().then(function (text) {
                        if (!text) return null
                        try {
                            return JSON.parse(text)
                        } catch {
                            throw new ApiError("El servidor devolvió una respuesta no válida", {
                                status: response.status,
                                requestId: response.headers.get("X-Request-Id") || ""
                            })
                        }
                    })
                },
                function (error) {
                    clearTimeout(timer)

                    if (error instanceof ApiError) throw error

                    const aborted = error && error.name === "AbortError"
                    if (aborted && !timedOut) {
                        throw error // cancelación deliberada de quien llama
                    }

                    if (remaining > 0) {
                        return sleep(delay).then(function () {
                            return attempt(remaining - 1, delay * 2)
                        })
                    }

                    throw new ApiError(
                        timedOut ? "La petición ha tardado demasiado" : "No se pudo conectar con el servidor",
                        { isNetwork: !timedOut, isTimeout: timedOut }
                    )
                }
            )
        }

        return attempt(retries, 400)
    }

    const Api = {
        ApiError: ApiError,
        request: request,
        get: function (url, options) {
            return request(url, Object.assign({}, options, { method: "GET" }))
        },
        post: function (url, body, options) {
            return request(url, Object.assign({}, options, { method: "POST", body: body }))
        },
        put: function (url, body, options) {
            return request(url, Object.assign({}, options, { method: "PUT", body: body }))
        },
        del: function (url, options) {
            return request(url, Object.assign({}, options, { method: "DELETE" }))
        },
        // Mensaje presentable para el usuario a partir de cualquier excepción.
        describeError: function (error) {
            if (!error) return "Error desconocido"
            if (error instanceof ApiError) {
                return error.requestId ? error.message + " (ref. " + error.requestId + ")" : error.message
            }
            return error.message || String(error)
        }
    }

    window.Api = Api
    window.ApiError = ApiError

    // ── Red de seguridad para el código que aún llama a fetch() directamente ──
    // Los módulos existentes hacen `fetch("/api/…")` sin comprobar el 401. Sin
    // esto, una sesión caducada les rompe el `.json()` con un error opaco.
    // Interceptar aquí cubre las ~165 llamadas de una vez.
    const wrappedFetch = window.fetch.bind(window)
    window.fetch = function (input, init) {
        return wrappedFetch(input, init).then(function (response) {
            if (response.status === 401) {
                const url = typeof input === "string" ? input : (input && input.url) || ""
                if (url.indexOf("/api/") !== -1) goToLogin()
            }
            return response
        })
    }
})()
