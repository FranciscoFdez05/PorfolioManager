// Análisis > Herramientas: herramientas añadidas por el usuario y reinicio.
//
// Trozo de js/analisis/herramientas.js. Comparte con el resto de herramientas-*.js el
// ámbito global y se carga detrás de herramientas.js, en el orden de index.html.

// ── Herramientas añadidas por el usuario ───────────────────────────────────
// Cada fichero .html de html/analisis/herramientas-extra/ es una herramienta
// más. El servidor los descubre y los lista en /api/herramientas-extra (ver
// python/routes/herramientas.py); aquí se les pone la pestaña y la cabecera
// —con el mismo aspecto que las de serie— y se inyecta el cuerpo tal cual.
// La guía para escribir una está en docs/herramientas-extra.md.

const _herramientasExtraInit = {}
const _herramientasExtraScripts = new Set()

/**
 * La llama el .js de cada herramienta para engancharse a su panel:
 *
 *     registrarHerramienta("mi-herramienta", (panel) => { ... })
 *
 * Se guarda además de ejecutarse porque el panel se construye de nuevo cada vez
 * que se entra en la página, mientras que el script solo se descarga la primera.
 */
function registrarHerramienta(id, iniciar) {
    if (typeof iniciar !== "function") return
    _herramientasExtraInit[id] = iniciar
    hIniciarHerramientaExtra(id)
}

function hIniciarHerramientaExtra(id) {
    const panel = document.getElementById(`toolExtra-${id}`)
    const iniciar = _herramientasExtraInit[id]
    if (!panel || !iniciar || panel.dataset.iniciada === "1") return

    panel.dataset.iniciada = "1"
    try {
        iniciar(panel)
    } catch (error) {
        // Una herramienta rota no puede llevarse por delante el resto de la
        // página: se queda su panel puesto y sin funcionar, y el motivo sale
        // por consola.
        console.error(`La herramienta «${id}» falló al iniciarse:`, error)
    }
}

async function hCargarHerramientasExtra() {
    let lista
    try {
        const respuesta = await fetch("/api/herramientas-extra")
        if (!respuesta.ok) return
        lista = (await respuesta.json()).herramientas || []
    } catch (error) {
        console.error("No se pudieron listar las herramientas añadidas:", error)
        return
    }

    for (const herramienta of lista) {
        try {
            await hMontarHerramientaExtra(herramienta)
        } catch (error) {
            console.error(`No se pudo montar la herramienta «${herramienta.id}»:`, error)
        }
    }
}

async function hMontarHerramientaExtra(herramienta) {
    const nav = document.querySelector(".herramientasNav")
    const contenido = document.getElementById("herramientasContent")
    if (!nav || !contenido) return

    const respuesta = await fetch(herramienta.html, { cache: "no-store" })
    if (!respuesta.ok) throw new Error(`no se pudo leer ${herramienta.html}`)
    const cuerpo = await respuesta.text()

    const panel = document.createElement("div")
    panel.className = "herramientaPanel hidden"
    panel.id = `toolExtra-${herramienta.id}`
    panel.append(hCabeceraHerramientaExtra(herramienta))

    // El cuerpo va tal cual lo escribió el usuario; el título y la descripción
    // como texto, que salen de los metadatos y no tienen por qué ser HTML.
    const marco = document.createElement("div")
    marco.className = "herramientaBody" + (herramienta.disposicion === "completo" ? " herramientaBodyFull" : "")
    marco.innerHTML = cuerpo
    panel.append(marco)
    contenido.appendChild(panel)

    const boton = document.createElement("button")
    // Nace escondida: solo se ve al abrir su categoría.
    boton.className = "herramientaBtn hidden"
    boton.dataset.panel = panel.id
    boton.dataset.cat = CATEGORIA_EXTRAS
    boton.textContent = herramienta.titulo
    hCategoriaDeExtras(nav).appendChild(boton)

    if (!herramienta.js) return

    if (_herramientasExtraScripts.has(herramienta.js)) {
        // Ya se descargó en una visita anterior: basta con volver a engancharlo
        // al panel nuevo.
        hIniciarHerramientaExtra(herramienta.id)
        return
    }

    _herramientasExtraScripts.add(herramienta.js)
    await new Promise((resolve) => {
        const script = document.createElement("script")
        script.src = herramienta.js
        script.onload = resolve
        script.onerror = () => {
            console.error(`No se pudo cargar ${herramienta.js}`)
            resolve()
        }
        document.body.appendChild(script)
    })
}

// Las añadidas por el usuario tienen su propia categoría, que se crea con la
// primera: sin herramientas propias no debe aparecer una pestaña vacía.
const CATEGORIA_EXTRAS = "propias"

function hCategoriaDeExtras(nav) {
    const categorias = nav.querySelector(".herramientaCategorias")
    if (categorias && !categorias.querySelector(`[data-cat="${CATEGORIA_EXTRAS}"]`)) {
        const boton = document.createElement("button")
        boton.className = "herramientaCatBtn"
        boton.dataset.cat = CATEGORIA_EXTRAS
        boton.textContent = "Propias"
        categorias.appendChild(boton)
    }
    return nav.querySelector(".herramientaLista")
}

function hCabeceraHerramientaExtra(herramienta) {
    const cabecera = document.createElement("div")
    cabecera.className = "hPanelHead"

    const texto = document.createElement("div")
    texto.className = "hPanelHeadText"

    const titulo = document.createElement("h3")
    titulo.className = "herramientaPanelTitle"
    titulo.textContent = herramienta.titulo
    texto.appendChild(titulo)

    if (herramienta.descripcion) {
        const descripcion = document.createElement("p")
        descripcion.className = "hPanelDesc"
        descripcion.textContent = herramienta.descripcion
        texto.appendChild(descripcion)
    }
    cabecera.appendChild(texto)

    return cabecera
}

// ── Reset ──────────────────────────────────────────────────────────────────

function hResetPanel(panelId) {
    const panel = document.getElementById(panelId)
    if (!panel) return
    panel.querySelectorAll("input[type='number']").forEach((inp) => {
        inp.value = inp.defaultValue
    })
    panel.querySelectorAll(".herramientaResults").forEach((el) => el.classList.add("hidden"))

    if (panelId === "toolCapitalizacion") hCapReiniciar()
    if (panelId === "toolInteres" && _herramientasChart) {
        _herramientasChart.destroy()
        _herramientasChart = null
    }
    if (panelId === "toolPrecioMedio") {
        hInitPrecioMedio()
        const msg = document.getElementById("hPrecioCargarMsg")
        if (msg) msg.textContent = ""
    }
    if (panelId === "toolRebalanceo") {
        _hRebTipos = []
        const cuerpo = document.getElementById("hRebBody")
        if (cuerpo) cuerpo.innerHTML = ""
        const msg = document.getElementById("hRebMsg")
        if (msg) msg.textContent = "Pulsa «Cargar mi cartera» para traer tus posiciones actuales."
        const suma = document.getElementById("hRebSumaMsg")
        if (suma) suma.textContent = ""
    }
    if (panelId === "toolSimularVenta") {
        const lotes = document.getElementById("hSvLotes")
        if (lotes) lotes.innerHTML = ""
        document.getElementById("hSvAviso")?.classList.add("hidden")
        const disponible = document.getElementById("hSvDisponible")
        if (disponible) disponible.textContent = ""
        hSvPreparar()
    }
    if (panelId === "toolRentDividendo") {
        if (_hDivChart) {
            _hDivChart.destroy()
            _hDivChart = null
        }
        const tbody = document.getElementById("hDivTableBody")
        if (tbody) tbody.innerHTML = ""
    }
}
