// Análisis > Herramientas: herramientas que el usuario crea desde la propia página.
//
// Trozo de js/analisis/herramientas.js. Comparte con el resto de herramientas-*.js el
// ámbito global y se carga detrás de herramientas.js, en el orden de index.html.
//
// Son la versión sin código de las de html/analisis/herramientas-extra/: un
// formulario describe los campos de entrada y los resultados (cada uno con una
// fórmula), el servidor lo guarda en ajustes.json (python/stores/herramientas_propias.py)
// y aquí se convierte en un panel con las mismas clases que las de serie. Las
// fórmulas las calcula herramientas-formula.js, nunca eval.
//
// Viven en la categoría «Propias», junto a las de fichero. La última pestaña de
// esa categoría es siempre «+ Nueva herramienta», cuyo panel es el editor: así
// la categoría nunca está vacía y, sin herramientas, abrirla lleva directo a
// crear la primera.

const H_PROPIA_API = "/api/herramientas-propias"
const H_PROPIA_EDITOR = "toolPropiaEditor"
const H_PROPIA_CLAVE_VALIDA = /^[A-Za-z_][A-Za-z0-9_]{0,23}$/
const H_PROPIA_FORMATOS = [
    ["numero", "Número"],
    ["moneda", "Moneda"],
    ["porcentaje", "Porcentaje"]
]

let _hPropias = []
// Herramienta que se está editando; null mientras el editor crea una nueva.
let _hPropiaEditando = null

// ── Carga y montaje ────────────────────────────────────────────────────────

async function hCargarHerramientasPropias() {
    const nav = document.querySelector(".herramientasNav")
    const contenido = document.getElementById("herramientasContent")
    if (!nav || !contenido) return

    // Crea «Propias» aunque no haya ninguna: es donde está el botón de crear.
    const lista = hCategoriaDeExtras(nav)
    lista.appendChild(hBotonEditorPropia())
    contenido.appendChild(hPanelEditorPropia())
    hPropiaEditorPreparar(null)

    try {
        const respuesta = await fetch(H_PROPIA_API, { cache: "no-store" })
        if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`)
        _hPropias = (await respuesta.json()).herramientas || []
    } catch (error) {
        console.error("No se pudieron cargar las herramientas propias:", error)
        _hPropias = []
    }
    hPropiasPintar()
}

/** Quita y vuelve a montar todas las herramientas propias, delante del botón de crear. */
function hPropiasPintar() {
    document.querySelectorAll("[data-propia]").forEach((el) => el.remove())
    const contenido = document.getElementById("herramientasContent")
    const botonEditor = document.querySelector(`.herramientaBtn[data-panel="${H_PROPIA_EDITOR}"]`)
    if (!contenido || !botonEditor) return

    const categoriaAbierta = botonEditor
        .closest(".herramientasNav")
        ?.querySelector(`.herramientaCatBtn[data-cat="${CATEGORIA_EXTRAS}"]`)
        ?.classList.contains("active")

    for (const herramienta of _hPropias) {
        let panel
        try {
            panel = hPanelPropia(herramienta)
        } catch (error) {
            // Una herramienta mal guardada no puede llevarse por delante el resto.
            console.error(`No se pudo montar la herramienta «${herramienta.titulo}»:`, error)
            continue
        }
        contenido.appendChild(panel)

        const boton = document.createElement("button")
        boton.className = "herramientaBtn" + (categoriaAbierta ? "" : " hidden")
        boton.dataset.panel = panel.id
        boton.dataset.cat = CATEGORIA_EXTRAS
        boton.dataset.propia = herramienta.id
        boton.textContent = herramienta.titulo
        botonEditor.before(boton)
    }
}

function hPropiaPanelId(id) {
    return `toolPropia-${id}`
}

/** Abre la pestaña de la herramienta `id`, o la del editor si no se pasa. */
function hPropiaAbrir(id) {
    const panelId = id ? hPropiaPanelId(id) : H_PROPIA_EDITOR
    const boton = document.querySelector(`.herramientaBtn[data-panel="${panelId}"]`)
    if (boton) hAbrirHerramienta(boton)
}

// ── Panel de una herramienta ───────────────────────────────────────────────

/**
 * Panel con los campos a la izquierda y los resultados a la derecha.
 *
 * Todo el texto del usuario entra con textContent: título, etiquetas y
 * unidades nunca se interpretan como HTML.
 */
function hPanelPropia(herramienta) {
    const panel = document.createElement("div")
    panel.className = "herramientaPanel hidden"
    panel.id = hPropiaPanelId(herramienta.id)
    panel.dataset.propia = herramienta.id

    const cabecera = hCabeceraHerramientaExtra(herramienta)
    cabecera.appendChild(hAccionesPropia(herramienta))
    panel.appendChild(cabecera)

    const cuerpo = document.createElement("div")
    cuerpo.className = "herramientaBody"
    const entradas = hEntradasPropia(herramienta)
    const resultados = hResultadosPropia(herramienta)
    cuerpo.append(entradas.tarjeta, resultados.columna)
    panel.appendChild(cuerpo)

    entradas.calcular.addEventListener("click", () => hCalcularPropia(herramienta, entradas.inputs, resultados))
    return panel
}

function hAccionesPropia(herramienta) {
    const acciones = document.createElement("div")
    acciones.className = "hPanelActions"

    const editar = hBotonPropia("Editar", "herramientaSecBtn", () => {
        hPropiaEditorPreparar(herramienta)
        hPropiaAbrir(null)
    })
    const borrar = hBotonPropia("Borrar", "herramientaSecBtn", () => hBorrarPropia(herramienta))
    acciones.append(editar, borrar)
    return acciones
}

function hEntradasPropia(herramienta) {
    const tarjeta = document.createElement("div")
    tarjeta.className = "hCard herramientaInputs"
    tarjeta.appendChild(hDivTexto("hCardTitle", "Parámetros"))

    const inputs = {}
    for (const campo of herramienta.campos) {
        const id = `hp-${herramienta.id}-${campo.clave}`
        const fila = document.createElement("div")
        fila.className = "herramientaField"

        const etiqueta = document.createElement("label")
        etiqueta.htmlFor = id
        etiqueta.textContent = campo.etiqueta

        const marco = document.createElement("div")
        marco.className = "hInputWrap"
        const input = document.createElement("input")
        input.type = "number"
        input.id = id
        input.step = "any"
        // Como atributo y no como propiedad: el botón Reiniciar de la página
        // vuelve a `defaultValue`, que es el atributo.
        input.setAttribute("value", String(campo.defecto))
        marco.appendChild(input)
        if (campo.unidad) marco.appendChild(hSpanTexto("hInputUnit", campo.unidad))

        fila.append(etiqueta, marco)
        tarjeta.appendChild(fila)
        inputs[campo.clave] = input
    }

    const botones = document.createElement("div")
    botones.className = "hBtnRow"
    const calcular = hBotonPropia("Calcular", "herramientaCalcBtn")
    botones.append(calcular, hBotonPropia("Reiniciar", "herramientaResetBtn"))
    tarjeta.appendChild(botones)

    return { tarjeta, inputs, calcular }
}

function hResultadosPropia(herramienta) {
    const columna = document.createElement("div")
    columna.className = "hResultsCol"

    const bloque = document.createElement("div")
    bloque.className = "herramientaResults hidden"
    const rejilla = document.createElement("div")
    rejilla.className = "herramientaResultGrid"
    bloque.appendChild(rejilla)

    const celdas = herramienta.resultados.map((resultado) => {
        const tarjeta = document.createElement("div")
        tarjeta.className = "herramientaResultCard" + (resultado.destacado ? " hResultCardAccent" : "")
        const valor = hDivTexto("hResultValue", "---")
        tarjeta.append(hDivTexto("hResultLabel", resultado.etiqueta), valor)
        rejilla.appendChild(tarjeta)
        return { resultado, valor, compilada: hPropiaCompilar(resultado.formula) }
    })

    const aviso = document.createElement("div")
    aviso.className = "hPlaceholder"
    const texto = document.createElement("p")
    texto.append("Rellena los campos y pulsa ")
    const fuerte = document.createElement("strong")
    fuerte.textContent = "Calcular"
    texto.append(fuerte, ".")
    aviso.appendChild(texto)

    columna.append(bloque, aviso)
    return { columna, bloque, celdas }
}

/** Árbol de la fórmula, o el error si no se puede analizar. Se compila una vez por montaje. */
function hPropiaCompilar(formula) {
    try {
        return { arbol: hFormulaCompilar(formula).arbol }
    } catch (error) {
        return { error: error instanceof HFormulaError ? error.message : String(error) }
    }
}

function hCalcularPropia(herramienta, inputs, resultados) {
    const valores = {}
    for (const [clave, input] of Object.entries(inputs)) {
        valores[clave] = parseFloat(input.value) || 0
    }

    for (const { resultado, valor, compilada } of resultados.celdas) {
        let numero = NaN
        let problema = compilada.error || ""
        if (!problema) {
            try {
                numero = hFormulaEvaluar(compilada.arbol, valores)
            } catch (error) {
                problema = error.message
            }
        }
        if (!problema && !Number.isFinite(numero)) problema = "No se puede calcular con estos valores"

        valor.textContent = problema ? "—" : hPropiaFormatear(numero, resultado)
        valor.title = problema
        valor.classList.toggle("hResultNegative", !problema && numero < 0)
    }
    resultados.bloque.classList.remove("hidden")
}

/**
 * Texto de un resultado según su formato.
 *
 * El porcentaje se pinta tal cual sale de la fórmula: 4 es «4 %», no «400 %».
 * Así lo que se escribe en la fórmula es lo que se lee en pantalla.
 *
 * @param {number} valor
 * @param {{formato: string, decimales: number, sufijo: string}} resultado
 * @returns {string}
 */
function hPropiaFormatear(valor, resultado) {
    const decimales = Number.isInteger(resultado.decimales) ? resultado.decimales : 2
    let texto
    if (resultado.formato === "moneda") {
        texto = formatMoneyWithDecimals(valor, window._monedaBase || "EUR", decimales)
    } else {
        texto = new Intl.NumberFormat(window._numLocale || "es-ES", {
            minimumFractionDigits: decimales,
            maximumFractionDigits: decimales
        }).format(valor)
        if (resultado.formato === "porcentaje") texto += " %"
    }
    return resultado.sufijo ? `${texto} ${resultado.sufijo}` : texto
}

// ── Editor ─────────────────────────────────────────────────────────────────

function hBotonEditorPropia() {
    const boton = document.createElement("button")
    boton.className = "herramientaBtn herramientaBtnNueva hidden"
    boton.dataset.panel = H_PROPIA_EDITOR
    boton.dataset.cat = CATEGORIA_EXTRAS
    boton.textContent = "+ Nueva herramienta"
    // Pulsarlo siempre empieza una nueva; editar una existente llega por su
    // botón «Editar», que abre este mismo panel sin pasar por aquí.
    boton.addEventListener("click", () => hPropiaEditorPreparar(null))
    return boton
}

function hPanelEditorPropia() {
    const panel = document.createElement("div")
    panel.className = "herramientaPanel hidden"
    panel.id = H_PROPIA_EDITOR

    const cabecera = document.createElement("div")
    cabecera.className = "hPanelHead"
    const texto = document.createElement("div")
    texto.className = "hPanelHeadText"
    const titulo = document.createElement("h3")
    titulo.className = "herramientaPanelTitle"
    titulo.id = "hPropiaEditorTitulo"
    texto.append(
        titulo,
        hParrafo(
            "hPanelDesc",
            "Define los datos que se piden y cómo se calcula cada resultado. Se guarda para todos los portfolios."
        )
    )
    cabecera.appendChild(texto)

    const tarjeta = document.createElement("div")
    tarjeta.className = "hCard hPropiaEditor"
    tarjeta.append(
        hDivTexto("hCardTitle", "Datos"),
        hCampoTextoEditor("hPropiaTitulo", "Título", 60),
        hCampoTextoEditor("hPropiaDescripcion", "Descripción (opcional)", 200),

        hDivTexto("hCardTitle", "Campos"),
        hParrafo(
            "hPrecargaMsg",
            "Lo que el usuario rellena. El nombre en la fórmula es como lo usas en los resultados: empieza por letra y lleva solo letras sin acentos, números o guion bajo."
        ),
        hTablaEditor("hPropiaCampos", ["Etiqueta", "Nombre en la fórmula", "Unidad", "Por defecto", ""]),
        hBotonPropia("+ Añadir campo", "herramientaSecBtn", () => hFilaCampoEditor()),

        hDivTexto("hCardTitle", "Resultados"),
        hParrafo(
            "hPrecargaMsg",
            "Operaciones + − * / ^ y paréntesis. Funciones: min, max, abs, round, sqrt, pow, ln, log, exp, floor, ceil. Decimales con punto y argumentos separados por coma: max(gasto, 0.5). En porcentaje se pinta el valor tal cual: para 4 %, la fórmula debe dar 4."
        ),
        hTablaEditor("hPropiaResultados", ["Etiqueta", "Fórmula", "Formato", "Decimales", "Sufijo", "Destacado", ""]),
        hBotonPropia("+ Añadir resultado", "herramientaSecBtn", () => hFilaResultadoEditor())
    )

    const error = document.createElement("p")
    error.className = "hPropiaError"
    error.id = "hPropiaError"
    error.setAttribute("role", "alert")

    const botones = document.createElement("div")
    botones.className = "hBtnRow"
    const guardar = hBotonPropia("Guardar", "herramientaCalcBtn", hGuardarPropia)
    // Sin esto, la aplicación esconde todo botón «Guardar» (shared-utils.js).
    guardar.dataset.noAutohide = "true"
    guardar.id = "hPropiaGuardarBtn"
    botones.append(guardar, hBotonPropia("Cancelar", "herramientaSecBtn", hCancelarEditorPropia))
    tarjeta.append(error, botones)

    const cuerpo = document.createElement("div")
    cuerpo.className = "herramientaBody herramientaBodyFull"
    cuerpo.appendChild(tarjeta)
    panel.append(cabecera, cuerpo)
    return panel
}

/** Rellena el editor con `herramienta`, o lo deja listo para una nueva si es null. */
function hPropiaEditorPreparar(herramienta) {
    _hPropiaEditando = herramienta
    const titulo = document.getElementById("hPropiaEditorTitulo")
    if (!titulo) return

    titulo.textContent = herramienta ? `Editar «${herramienta.titulo}»` : "Nueva herramienta"
    document.getElementById("hPropiaTitulo").value = herramienta?.titulo || ""
    document.getElementById("hPropiaDescripcion").value = herramienta?.descripcion || ""
    document.getElementById("hPropiaError").textContent = ""

    document.getElementById("hPropiaCampos").replaceChildren()
    document.getElementById("hPropiaResultados").replaceChildren()
    const campos = herramienta?.campos?.length ? herramienta.campos : [{}]
    const resultados = herramienta?.resultados?.length ? herramienta.resultados : [{ destacado: true }]
    campos.forEach((campo) => hFilaCampoEditor(campo))
    resultados.forEach((resultado) => hFilaResultadoEditor(resultado))
}

function hFilaCampoEditor(campo = {}) {
    const fila = document.createElement("tr")
    const etiqueta = hInputEditor("text", "hPropiaTexto", campo.etiqueta, "Gasto anual", 60)
    const clave = hInputEditor("text", "hPropiaTexto hPropiaClave", campo.clave, "gastoAnual", 24)
    const unidad = hInputEditor("text", "hPropiaTexto hPropiaCorto", campo.unidad, "€", 12)
    const defecto = hInputEditor("number", "hPrecioInput", campo.defecto ?? 0)
    defecto.step = "any"

    // Mientras no se toque a mano, el nombre en la fórmula sigue a la etiqueta.
    clave.dataset.auto = campo.clave ? "0" : "1"
    etiqueta.addEventListener("input", () => {
        if (clave.dataset.auto === "1") clave.value = hPropiaClaveDesde(etiqueta.value)
    })
    clave.addEventListener("input", () => {
        clave.dataset.auto = "0"
    })

    hAnadirFilaEditor("hPropiaCampos", fila, [etiqueta, clave, unidad, defecto])
}

function hFilaResultadoEditor(resultado = {}) {
    const fila = document.createElement("tr")
    const etiqueta = hInputEditor("text", "hPropiaTexto", resultado.etiqueta, "Capital necesario", 60)
    const formula = hInputEditor(
        "text",
        "hPropiaTexto hPropiaFormula",
        resultado.formula,
        "gastoAnual / (tasa / 100)",
        300
    )
    formula.spellcheck = false

    const formato = document.createElement("select")
    formato.className = "hPropiaSelect"
    for (const [valor, texto] of H_PROPIA_FORMATOS) formato.add(new Option(texto, valor))
    formato.value = resultado.formato || "numero"

    const decimales = hInputEditor("number", "hPrecioInput hPropiaCorto", resultado.decimales ?? 2)
    decimales.min = "0"
    decimales.max = "6"
    decimales.step = "1"
    const sufijo = hInputEditor("text", "hPropiaTexto hPropiaCorto", resultado.sufijo, "/ mes", 12)

    const destacado = document.createElement("input")
    destacado.type = "checkbox"
    destacado.checked = resultado.destacado === true
    destacado.setAttribute("aria-label", "Destacado")

    hAnadirFilaEditor("hPropiaResultados", fila, [etiqueta, formula, formato, decimales, sufijo, destacado])
}

function hAnadirFilaEditor(tbodyId, fila, controles) {
    for (const control of controles) {
        const celda = document.createElement("td")
        celda.appendChild(control)
        fila.appendChild(celda)
    }
    const quitar = document.createElement("button")
    quitar.type = "button"
    quitar.className = "hPrecioDeleteBtn"
    quitar.title = "Quitar"
    quitar.setAttribute("aria-label", "Quitar")
    quitar.innerHTML = iconoHtml("Borrar")
    quitar.addEventListener("click", () => fila.remove())
    const celda = document.createElement("td")
    celda.appendChild(quitar)
    fila.appendChild(celda)
    document.getElementById(tbodyId).appendChild(fila)
}

/**
 * Nombre de fórmula a partir de una etiqueta: «Gasto anual (€)» → «gastoAnual».
 *
 * @param {string} etiqueta
 * @returns {string}
 */
function hPropiaClaveDesde(etiqueta) {
    const palabras = String(etiqueta || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^A-Za-z0-9]+/g, " ")
        .trim()
        .split(" ")
        .filter(Boolean)
    const clave = palabras
        .map((p, i) => (i === 0 ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()))
        .join("")
        .slice(0, 24)
    return /^[0-9]/.test(clave) ? `c${clave}`.slice(0, 24) : clave
}

/**
 * Lee el editor y comprueba lo que el servidor no puede: que cada fórmula se
 * entienda y use solo campos de la herramienta.
 *
 * @param {HTMLElement} raiz Panel del editor.
 * @returns {{datos?: object, error?: string}}
 */
function hPropiaLeerEditor(raiz) {
    const valor = (el) => el.value.trim()
    const datos = {
        titulo: valor(raiz.querySelector("#hPropiaTitulo")),
        descripcion: valor(raiz.querySelector("#hPropiaDescripcion")),
        campos: [...raiz.querySelectorAll("#hPropiaCampos tr")].map((fila) => {
            const [etiqueta, clave, unidad, defecto] = fila.querySelectorAll("input")
            return {
                etiqueta: valor(etiqueta),
                clave: valor(clave),
                unidad: valor(unidad),
                defecto: parseFloat(defecto.value) || 0
            }
        }),
        resultados: [...raiz.querySelectorAll("#hPropiaResultados tr")].map((fila) => {
            const [etiqueta, formula, decimales, sufijo, destacado] = fila.querySelectorAll("input")
            const decimalesLeidos = parseInt(decimales.value, 10)
            return {
                etiqueta: valor(etiqueta),
                formula: valor(formula),
                formato: fila.querySelector("select").value,
                decimales: Number.isInteger(decimalesLeidos) ? decimalesLeidos : 2,
                sufijo: valor(sufijo),
                destacado: destacado.checked
            }
        })
    }

    if (!datos.titulo) return { error: "Ponle un título." }
    if (!datos.campos.length) return { error: "Añade al menos un campo." }
    if (!datos.resultados.length) return { error: "Añade al menos un resultado." }

    const claves = new Set()
    for (const [i, campo] of datos.campos.entries()) {
        if (!campo.etiqueta) return { error: `Campo ${i + 1}: falta la etiqueta.` }
        if (!H_PROPIA_CLAVE_VALIDA.test(campo.clave)) {
            return { error: `Campo ${i + 1}: el nombre en la fórmula no es válido.` }
        }
        if (claves.has(campo.clave)) return { error: `Campo ${i + 1}: el nombre «${campo.clave}» está repetido.` }
        claves.add(campo.clave)
    }
    for (const [i, resultado] of datos.resultados.entries()) {
        if (!resultado.etiqueta) return { error: `Resultado ${i + 1}: falta la etiqueta.` }
        const problema = hFormulaProblema(resultado.formula, claves)
        if (problema) return { error: `Resultado ${i + 1}: ${problema}.` }
        if (resultado.decimales < 0 || resultado.decimales > 6) {
            return { error: `Resultado ${i + 1}: los decimales van de 0 a 6.` }
        }
    }
    return { datos }
}

async function hGuardarPropia() {
    const panel = document.getElementById(H_PROPIA_EDITOR)
    const aviso = document.getElementById("hPropiaError")
    const { datos, error } = hPropiaLeerEditor(panel)
    if (error) {
        aviso.textContent = error
        return
    }

    const editando = _hPropiaEditando
    const url = editando ? `${H_PROPIA_API}/${encodeURIComponent(editando.id)}` : H_PROPIA_API
    const boton = document.getElementById("hPropiaGuardarBtn")
    boton.disabled = true
    aviso.textContent = ""
    try {
        const respuesta = await fetch(url, {
            method: editando ? "PUT" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(datos)
        })
        const cuerpo = await respuesta.json().catch(() => ({}))
        if (!respuesta.ok || !cuerpo.ok) {
            aviso.textContent = cuerpo.error || "No se pudo guardar la herramienta."
            return
        }
        const guardada = cuerpo.herramienta
        _hPropias = editando ? _hPropias.map((h) => (h.id === guardada.id ? guardada : h)) : [..._hPropias, guardada]
        hPropiasPintar()
        hPropiaEditorPreparar(null)
        hPropiaAbrir(guardada.id)
        window.showToast?.(editando ? "Herramienta actualizada" : "Herramienta creada", { type: "success" })
    } catch (fallo) {
        console.error("No se pudo guardar la herramienta:", fallo)
        aviso.textContent = "No se pudo conectar con el servidor."
    } finally {
        boton.disabled = false
    }
}

function hCancelarEditorPropia() {
    const editando = _hPropiaEditando
    hPropiaEditorPreparar(null)
    if (editando) hPropiaAbrir(editando.id)
    else if (_hPropias.length) hPropiaAbrir(_hPropias[0].id)
}

async function hBorrarPropia(herramienta) {
    if (!window.confirm(`¿Borrar la herramienta «${herramienta.titulo}»? No se puede deshacer.`)) return
    try {
        const respuesta = await fetch(`${H_PROPIA_API}/${encodeURIComponent(herramienta.id)}`, { method: "DELETE" })
        const cuerpo = await respuesta.json().catch(() => ({}))
        // 404: ya la había borrado otra pestaña; el resultado es el mismo.
        if (!respuesta.ok && respuesta.status !== 404) {
            window.showToast?.(cuerpo.error || "No se pudo borrar la herramienta", { type: "error" })
            return
        }
    } catch (error) {
        console.error("No se pudo borrar la herramienta:", error)
        window.showToast?.("No se pudo conectar con el servidor", { type: "error" })
        return
    }
    _hPropias = _hPropias.filter((h) => h.id !== herramienta.id)
    if (_hPropiaEditando?.id === herramienta.id) hPropiaEditorPreparar(null)
    hPropiasPintar()
    hAbrirCategoria(CATEGORIA_EXTRAS)
}

// ── Piezas de DOM ──────────────────────────────────────────────────────────

function hBotonPropia(texto, clase, alPulsar) {
    const boton = document.createElement("button")
    boton.type = "button"
    boton.className = clase
    boton.textContent = texto
    if (alPulsar) boton.addEventListener("click", alPulsar)
    return boton
}

function hDivTexto(clase, texto) {
    const div = document.createElement("div")
    div.className = clase
    div.textContent = texto
    return div
}

function hSpanTexto(clase, texto) {
    const span = document.createElement("span")
    span.className = clase
    span.textContent = texto
    return span
}

function hParrafo(clase, texto) {
    const p = document.createElement("p")
    p.className = clase
    p.textContent = texto
    return p
}

function hInputEditor(tipo, clase, valor, ejemplo, maximo) {
    const input = document.createElement("input")
    input.type = tipo
    input.className = clase
    input.value = valor ?? ""
    if (ejemplo) input.placeholder = ejemplo
    if (maximo) input.maxLength = maximo
    return input
}

function hCampoTextoEditor(id, etiqueta, maximo) {
    const fila = document.createElement("div")
    fila.className = "herramientaField hPropiaDato"
    const label = document.createElement("label")
    label.htmlFor = id
    label.textContent = etiqueta
    const input = hInputEditor("text", "", "", "", maximo)
    input.id = id
    fila.append(label, input)
    return fila
}

function hTablaEditor(tbodyId, cabeceras) {
    const marco = document.createElement("div")
    marco.className = "hTableWrap"
    const tabla = document.createElement("table")
    tabla.className = "hPrecioMedioTable hPropiaTabla"
    const fila = tabla.createTHead().insertRow()
    for (const texto of cabeceras) {
        const th = document.createElement("th")
        th.textContent = texto
        fila.appendChild(th)
    }
    const cuerpo = tabla.createTBody()
    cuerpo.id = tbodyId
    marco.appendChild(tabla)
    return marco
}
