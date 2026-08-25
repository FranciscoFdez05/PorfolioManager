// Pruebas de js/core/api.js.
//
// Este módulo existe para tres cosas que antes no hacía nadie: llevar al login
// cuando la sesión caduca, cortar las peticiones que se cuelgan y sacar un
// mensaje legible del cuerpo de error del backend. Las tres son difíciles de
// provocar a mano —hay que caducar una sesión, tirar la red, o hacer que el
// servidor devuelva un 500— y por eso justamente merecen prueba automática.
//
// El módulo es un IIFE que envuelve `window.fetch`, así que cada suite lo
// vuelve a cargar sobre un `fetch` falso: el envoltorio se aplica una vez por
// carga y encadenarlo entre pruebas daría redirecciones fantasma.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cargarScript } from "./cargar.js"

/** Respuesta mínima con la superficie de `Response` que usa api.js. */
function respuesta({ status = 200, body = "", headers = {} } = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: (nombre) => headers[nombre] ?? null },
        text: () => Promise.resolve(body),
        json: () => Promise.resolve(JSON.parse(body))
    }
}

let destinos
// api.js **sustituye** window.fetch por su envoltorio, así que después de
// cargarlo `window.fetch` ya no es el doble: hay que quedarse con la
// referencia para poder programar respuestas y contar llamadas.
let fetchFalso

beforeEach(() => {
    vi.useFakeTimers()

    // jsdom no navega: se sustituye `location` por un objeto que solo apunta a
    // dónde se habría ido, que es lo que las pruebas quieren comprobar.
    destinos = []
    delete window.location
    window.location = {
        pathname: "/",
        search: "",
        href: "http://localhost/",
        origin: "http://localhost",
        assign: (url) => destinos.push(url)
    }

    // jsdom no trae fetch; api.js lo envuelve, así que tiene que existir antes.
    fetchFalso = vi.fn()
    window.fetch = fetchFalso
    cargarScript("js/core/api.js")
})

afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe("respuestas correctas", () => {
    it("devuelve el JSON ya parseado", async () => {
        fetchFalso.mockResolvedValue(respuesta({ body: '{"ok":true,"total":3}' }))

        await expect(Api.get("/api/cosas")).resolves.toEqual({ ok: true, total: 3 })
    })

    it("un 204 sin cuerpo devuelve null en vez de reventar", async () => {
        fetchFalso.mockResolvedValue(respuesta({ status: 204 }))

        await expect(Api.del("/api/cosa/1")).resolves.toBeNull()
    })

    it("serializa el cuerpo a JSON y pone el Content-Type", async () => {
        fetchFalso.mockResolvedValue(respuesta({ body: "{}" }))

        await Api.post("/api/cosas", { nombre: "x" })

        const [, init] = fetchFalso.mock.calls[0]
        expect(init.method).toBe("POST")
        expect(init.body).toBe('{"nombre":"x"}')
        expect(init.headers["Content-Type"]).toBe("application/json")
    })

    it("un FormData se envía tal cual, sin Content-Type propio", () => {
        // Ponerlo a mano rompe el boundary que calcula el navegador.
        fetchFalso.mockResolvedValue(respuesta({ body: "{}" }))
        const datos = new FormData()

        return Api.post("/api/import", datos).then(() => {
            const [, init] = fetchFalso.mock.calls[0]
            expect(init.body).toBe(datos)
            expect(init.headers["Content-Type"]).toBeUndefined()
        })
    })
})

describe("sesión caducada", () => {
    it("un 401 lleva al login conservando la página actual", async () => {
        window.location.pathname = "/analisis"
        window.location.search = "?year=2026"
        fetchFalso.mockResolvedValue(respuesta({ status: 401 }))

        await expect(Api.get("/api/metricas")).rejects.toMatchObject({ status: 401 })

        expect(destinos).toHaveLength(1)
        expect(destinos[0]).toBe("/login?next=" + encodeURIComponent("/analisis?year=2026"))
    })

    it("varias peticiones en vuelo redirigen una sola vez", async () => {
        // La pantalla principal lanza una decena de llamadas a la vez: sin el
        // cerrojo, cada 401 disparaba su propia navegación.
        fetchFalso.mockResolvedValue(respuesta({ status: 401 }))

        await Promise.allSettled([Api.get("/api/a"), Api.get("/api/b"), Api.get("/api/c")])

        expect(destinos).toHaveLength(1)
    })
})

describe("errores del servidor", () => {
    it("saca el mensaje y el requestId del cuerpo del backend", async () => {
        fetchFalso.mockResolvedValue(
            respuesta({
                status: 400,
                body: '{"ok":false,"error":"La fecha es obligatoria","requestId":"abc123","field":"fecha"}'
            })
        )

        await expect(Api.post("/api/ventas", {})).rejects.toMatchObject({
            message: "La fecha es obligatoria",
            requestId: "abc123",
            field: "fecha",
            status: 400
        })
    })

    it("un cuerpo que no es JSON no rompe el manejo de errores", async () => {
        // Un proxy por delante puede devolver una página HTML de error.
        fetchFalso.mockResolvedValue(respuesta({ status: 502, body: "<html>Bad Gateway</html>" }))

        const error = await Api.post("/api/cosas", {}).catch((e) => e)
        expect(error.status).toBe(502)
        expect(error.message).toContain("Bad Gateway")
    })

    it("describeError añade la referencia para poder buscarla en el log", async () => {
        fetchFalso.mockResolvedValue(respuesta({ status: 500, body: '{"error":"Fallo interno","requestId":"xyz789"}' }))

        const error = await Api.get("/api/cosas", { retries: 0 }).catch((e) => e)
        expect(Api.describeError(error)).toBe("Fallo interno (ref. xyz789)")
    })

    it("una respuesta correcta con cuerpo ilegible se rechaza con un mensaje claro", async () => {
        fetchFalso.mockResolvedValue(respuesta({ body: "{no es json" }))

        await expect(Api.get("/api/cosas")).rejects.toMatchObject({
            message: "El servidor devolvió una respuesta no válida"
        })
    })
})

describe("peticiones colgadas", () => {
    it("una petición que no responde se corta y avisa", async () => {
        fetchFalso.mockImplementation(
            (_url, init) =>
                new Promise((_resolve, reject) => {
                    init.signal.addEventListener("abort", () => {
                        const error = new Error("abortada")
                        error.name = "AbortError"
                        reject(error)
                    })
                })
        )

        const promesa = Api.get("/api/lento", { timeout: 100, retries: 0 }).catch((e) => e)
        await vi.advanceTimersByTimeAsync(150)

        const error = await promesa
        expect(error.isTimeout).toBe(true)
        expect(error.message).toBe("La petición ha tardado demasiado")
    })

    it("una cancelación deliberada de quien llama no se disfraza de timeout", async () => {
        // Cambiar de pantalla cancela sus peticiones: eso no es un error que
        // haya que enseñarle a nadie.
        const controlador = new AbortController()
        fetchFalso.mockImplementation(
            (_url, init) =>
                new Promise((_resolve, reject) => {
                    init.signal.addEventListener("abort", () => {
                        const error = new Error("abortada")
                        error.name = "AbortError"
                        reject(error)
                    })
                })
        )

        const promesa = Api.get("/api/lento", { signal: controlador.signal }).catch((e) => e)
        controlador.abort()

        const error = await promesa
        expect(error.name).toBe("AbortError")
        expect(error.isTimeout).toBeUndefined()
    })
})

describe("reintentos", () => {
    it("un 503 se reintenta y la segunda respuesta vale", async () => {
        fetchFalso
            .mockResolvedValueOnce(respuesta({ status: 503 }))
            .mockResolvedValueOnce(respuesta({ body: '{"ok":true}' }))

        const promesa = Api.get("/api/cosas")
        await vi.advanceTimersByTimeAsync(1000)

        await expect(promesa).resolves.toEqual({ ok: true })
        expect(fetchFalso).toHaveBeenCalledTimes(2)
    })

    it("un POST no se reintenta nunca", async () => {
        // Repetirlo duplicaría la fila que acaba de crear.
        fetchFalso.mockResolvedValue(respuesta({ status: 503 }))

        const promesa = Api.post("/api/ventas", {}).catch((e) => e)
        await vi.advanceTimersByTimeAsync(5000)
        await promesa

        expect(fetchFalso).toHaveBeenCalledTimes(1)
    })

    it("un 400 no se reintenta: la petición no va a mejorar", async () => {
        fetchFalso.mockResolvedValue(respuesta({ status: 400, body: '{"error":"mal"}' }))

        const promesa = Api.get("/api/cosas").catch((e) => e)
        await vi.advanceTimersByTimeAsync(5000)
        await promesa

        expect(fetchFalso).toHaveBeenCalledTimes(1)
    })
})

describe("red de seguridad sobre fetch() directo", () => {
    it("un 401 en una llamada suelta a /api/ también lleva al login", async () => {
        // Los módulos antiguos llaman a fetch() sin pasar por Api.
        fetchFalso.mockResolvedValue(respuesta({ status: 401 }))

        await window.fetch("/api/gastos")

        expect(destinos).toHaveLength(1)
    })

    it("un 401 fuera de /api/ no redirige", async () => {
        fetchFalso.mockResolvedValue(respuesta({ status: 401 }))

        await window.fetch("/otra/cosa")

        expect(destinos).toHaveLength(0)
    })
})
