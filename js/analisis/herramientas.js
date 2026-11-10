// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _herramientasChart = null
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _hDivChart = null
let _hPrecioMedioCount = 0

// Colores del gráfico según el tema activo: los mismos tonos que la paleta de
// css/themes/claro.css y css/themes/oscuro.css. Chart.js pinta en un canvas y
// necesita el valor ya resuelto, no un var(--…).
function hChartTheme() {
    const tema = document.documentElement.getAttribute("data-theme")
    if (tema === "light") return { text: "#0f172a", muted: "#64748b", grid: "#e2e8f0" }
    if (tema === "black") return { text: "#f0f0f4", muted: "#88889a", grid: "#222228" }
    return { text: "#ccd6f6", muted: "#94a3b8", grid: "#1e2d45" }
}

async function initHerramientasLogic() {
    window.flushPendingPageChanges = null
    _hActivosCache = null

    // Las referencias históricas que fija el usuario se guardan, así que hay que
    // reflejarlas en las etiquetas al abrir la página.
    hRatioAplicarHistoricoLabels()
    hOroBtcAplicarRefLabels()

    // Los editores de las referencias se abrían con onclick="…" en el HTML, y
    // la CSP (script-src sin 'unsafe-inline') bloquea esos manejadores: los
    // botones no hacían nada. Se enganchan aquí, como el resto.
    document.getElementById("hRatioEditHistBtn")?.addEventListener("click", hRatioAbrirEditor)
    document.getElementById("hRatioGuardarHistBtn")?.addEventListener("click", hRatioGuardarHistorico)
    document.getElementById("hRatioCancelarHistBtn")?.addEventListener("click", hRatioCerrarEditor)
    document.getElementById("hOroBtcEditHistBtn")?.addEventListener("click", hOroBtcAbrirEditor)
    document.getElementById("hOroBtcGuardarRefBtn")?.addEventListener("click", hOroBtcGuardarRef)
    document.getElementById("hOroBtcCancelarRefBtn")?.addEventListener("click", hOroBtcCerrarEditor)

    // ── Navegación, reinicio y Enter ───────────────────────────────
    // Por delegación y no botón a botón: las herramientas que el usuario deja
    // en html/analisis/herramientas-extra/ se montan después de esto, y con un
    // listener por elemento se quedaban sin pestaña ni botón de reinicio.
    hConectarPagina()

    // ── Interés Compuesto ──────────────────────────────────────────
    document.getElementById("hIntCalcBtn")?.addEventListener("click", hCalcInteresCompuesto)

    // ── Rentabilidad ───────────────────────────────────────────────
    document.getElementById("hRentCalcBtn")?.addEventListener("click", hCalcRentabilidad)

    // ── CAGR ───────────────────────────────────────────────────────
    document.getElementById("hCagrCalcBtn")?.addEventListener("click", hCalcCagr)

    // ── Regla del 72 ───────────────────────────────────────────────
    document.getElementById("hR72TasaBtn")?.addEventListener("click", () => {
        const tasa = parseFloat(document.getElementById("hR72Tasa").value) || 0
        if (tasa <= 0) return
        document.getElementById("hR72TasaAnos").textContent = (72 / tasa).toFixed(1) + " años"
        document.getElementById("hR72TasaResults").classList.remove("hidden")
    })
    document.getElementById("hR72AnosBtn")?.addEventListener("click", () => {
        const anos = parseFloat(document.getElementById("hR72Anos").value) || 0
        if (anos <= 0) return
        document.getElementById("hR72AnosTasa").textContent = (72 / anos).toFixed(2) + " %"
        document.getElementById("hR72AnosResults").classList.remove("hidden")
    })

    // ── Precio Medio ───────────────────────────────────────────────
    hInitPrecioMedio()
    document.getElementById("hPrecioAddRow")?.addEventListener("click", hAddPrecioMedioRow)
    document.getElementById("hPrecioCalcBtn")?.addEventListener("click", hCalcPrecioMedio)
    document.getElementById("hPrecioCargarBtn")?.addEventListener("click", hPrecioCargarCompras)

    // ── Rebalanceo ─────────────────────────────────────────────────
    document.getElementById("hRebCargarBtn")?.addEventListener("click", hRebCargarCartera)
    document.getElementById("hRebCalcBtn")?.addEventListener("click", hRebCalcular)

    // ── Simular venta ──────────────────────────────────────────────
    hSvPreparar()
    document.getElementById("hSvCalcBtn")?.addEventListener("click", hSvCalcular)

    // Los selectores de activo de las dos herramientas que leen la cartera.
    // En segundo plano: si la API tarda o falla, el resto de la página ya está.
    hCargarSelectoresDeActivos()

    // ── Rent. Dividendo ────────────────────────────────────────────
    document.getElementById("hDivLoadBtn")?.addEventListener("click", hLoadDividendos)
    document.getElementById("hYieldCalcBtn")?.addEventListener("click", hCalcYield)

    // ── Ratio Oro / Plata ──────────────────────────────────────────
    document.getElementById("hRatioLoadBtn")?.addEventListener("click", hRatioLoadPrecios)
    document.getElementById("hRatioCalcBtn")?.addEventListener("click", hCalcRatioOroPlata)

    // ── Oro / Bitcoin ───────────────────────────────────────────────
    document.getElementById("hOroBtcLoadBtn")?.addEventListener("click", hOroBtcLoadPrecios)
    document.getElementById("hOroBtcCalcBtn")?.addEventListener("click", hCalcOroBtc)

    // ── Capitalización objetivo ────────────────────────────────────
    hCapIniciar()

    // ── Oro y plata ────────────────────────────────────────────────
    hMetIniciar()

    // ── Comparador de divisas ──────────────────────────────────────
    hFxIniciar()

    // ── Herramientas añadidas por el usuario ───────────────────────
    // Lo último: si falla, las de serie ya están montadas y funcionando.
    await hCargarHerramientasExtra()
}

// ── Navegación, reinicio y Enter ───────────────────────────────────────────

function hConectarPagina() {
    const pagina = document.querySelector(".herramientasPage")
    if (!pagina) return

    pagina.addEventListener("click", (e) => {
        const categoria = e.target.closest(".herramientaCatBtn")
        if (categoria) {
            hAbrirCategoria(categoria.dataset.cat)
            return
        }

        const pestana = e.target.closest(".herramientaBtn")
        if (pestana) {
            hAbrirHerramienta(pestana)
            return
        }

        const reinicio = e.target.closest(".herramientaResetBtn")
        if (reinicio) {
            // Sin data-panel, el panel que lo contiene: así una herramienta
            // añadida a mano no tiene que repetir su propio id en el botón.
            hResetPanel(reinicio.dataset.panel || reinicio.closest(".herramientaPanel")?.id)
        }
    })

    pagina.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.target.tagName !== "INPUT") return
        e.target.closest(".herramientaPanel")?.querySelector(".herramientaCalcBtn")?.click()
    })
}

function hAbrirCategoria(cat) {
    document.querySelectorAll(".herramientaCatBtn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.cat === cat)
    })

    let primera = null
    document.querySelectorAll(".herramientaLista .herramientaBtn").forEach((btn) => {
        const suya = btn.dataset.cat === cat
        btn.classList.toggle("hidden", !suya)
        if (suya && !primera) primera = btn
    })

    // Cambiar de categoría sin abrir nada dejaría el panel de la anterior
    // debajo de una fila que ya no lo contiene.
    if (primera) hAbrirHerramienta(primera)
}

function hAbrirHerramienta(btn) {
    document.querySelectorAll(".herramientaBtn").forEach((b) => b.classList.remove("active"))
    document.querySelectorAll(".herramientaPanel").forEach((p) => {
        p.classList.remove("active")
        p.classList.add("hidden")
    })
    btn.classList.add("active")

    // Las de serie derivan el id del panel de su data-tool; las añadidas por el
    // usuario lo llevan puesto en data-panel.
    const panelId = btn.dataset.panel || "tool" + btn.dataset.tool.charAt(0).toUpperCase() + btn.dataset.tool.slice(1)
    const panel = document.getElementById(panelId)
    if (panel) {
        panel.classList.remove("hidden")
        panel.classList.add("active")
    }

    if (btn.dataset.tool === "capitalizacion") {
        document.querySelectorAll(".hCapMonedaBase").forEach((el) => {
            el.textContent = window._monedaBase || "EUR"
        })
    }

    if (btn.dataset.tool === "divisas") hFxAlAbrir()

    if (btn.dataset.tool === "metales") hMetAlAbrir()

    if (btn.dataset.tool === "ratioOroBtc") {
        const mb = window._monedaBase || "EUR"
        document.querySelectorAll(".hOroBtcMonedaLabel").forEach((el) => {
            el.textContent = mb
        })
    }
}

// ── Activos de la cartera ──────────────────────────────────────────────────
// Los comparten el precio medio, el rebalanceo y la simulación de venta. Una
// sola petición por visita a la página.

let _hActivosCache = null

async function hActivos() {
    if (_hActivosCache) return _hActivosCache
    const respuesta = await fetch("/api/activos")
    if (!respuesta.ok) throw new Error("No se pudieron cargar los activos")
    _hActivosCache = (await respuesta.json()).assets || []
    return _hActivosCache
}

function hEtiquetaTipo(tipo) {
    // La de la página de Activos, para que un tipo se llame igual en toda la
    // aplicación. Si algún día deja de existir, el propio tipo sirve.
    return typeof buildAssetTypeLabel === "function" ? buildAssetTypeLabel(tipo) : tipo
}

async function hCargarSelectoresDeActivos() {
    let activos
    try {
        activos = await hActivos()
    } catch (error) {
        console.error(error)
        return
    }

    const visibles = activos.filter((a) => !a.hidden).sort((a, b) => (a.name || "").localeCompare(b.name || "", "es"))

    document.querySelectorAll("#hPrecioActivo, #hSvActivo").forEach((select) => {
        // La primera opción es el texto de «sin elegir» y se queda.
        while (select.options.length > 1) select.remove(1)
        visibles.forEach((activo) => {
            const opcion = document.createElement("option")
            opcion.value = activo.id
            opcion.textContent = `${activo.name}${activo.symbol ? " · " + activo.symbol : ""}`
            select.appendChild(opcion)
        })
    })
}

// ── Precio medio: traerse las compras ya guardadas ─────────────────────────
// Las compras de la ficha viven en /api/activos/<id>; las de cripto, en las
// operaciones. Se leen las dos fuentes porque un activo puede tener de ambas.

async function hComprasDeActivo(assetId) {
    const compras = []

    const respuesta = await fetch(`/api/activos/${encodeURIComponent(assetId)}`)
    if (respuesta.ok) {
        const ficha = await respuesta.json()
        ;(ficha.rows || []).forEach((fila) => {
            if (String(fila.tipoOperacion || "").toLowerCase() !== "compra") return
            const cantidad = parseEuroNumber(String(fila.participaciones || "0"))
            if (cantidad <= 0) return
            // En cripto se apunta el importe total y no el precio unitario, así
            // que se deduce cuando falta.
            let precio = parseEuroNumber(String(fila.precioParticipacion || "0"))
            if (precio <= 0) {
                const bruto = parseEuroNumber(String(fila.capitalInvertidoBruto || "0"))
                precio = bruto > 0 ? bruto / cantidad : 0
            }
            if (precio > 0) compras.push({ precio, cantidad })
        })
    }

    const opsResp = await fetch("/api/operaciones")
    if (opsResp.ok) {
        const { rows } = await opsResp.json()
        ;(rows || []).forEach((fila) => {
            if (fila.assetId !== assetId) return
            if (String(fila.orden || "").toLowerCase() !== "compra") return
            if (String(fila.estado || "").toLowerCase() !== "completado") return
            const cantidad = parseEuroNumber(String(fila.cantidad || "0"))
            if (cantidad <= 0) return
            let precio = parseEuroNumber(String(fila.precioOrden || "0"))
            if (precio <= 0) {
                const total = parseEuroNumber(String(fila.total || "0"))
                precio = total > 0 ? total / cantidad : 0
            }
            if (precio > 0) compras.push({ precio, cantidad })
        })
    }

    return compras
}

async function hPrecioCargarCompras() {
    const select = document.getElementById("hPrecioActivo")
    const aviso = document.getElementById("hPrecioCargarMsg")
    const boton = document.getElementById("hPrecioCargarBtn")
    if (!select || !aviso) return

    if (!select.value) {
        aviso.textContent = "Elige antes un activo."
        aviso.className = "hPrecargaMsg hRatioFuenteWarn"
        return
    }

    boton.disabled = true
    aviso.textContent = "Cargando…"
    aviso.className = "hPrecargaMsg"

    try {
        const compras = await hComprasDeActivo(select.value)
        if (!compras.length) {
            aviso.textContent = "Ese activo no tiene compras guardadas."
            aviso.className = "hPrecargaMsg hRatioFuenteWarn"
            return
        }

        const cuerpo = document.getElementById("hPrecioMedioBody")
        cuerpo.innerHTML = ""
        _hPrecioMedioCount = 0
        compras.forEach((compra) => {
            hAddPrecioMedioRow()
            const fila = cuerpo.lastElementChild
            const [precio, cantidad] = fila.querySelectorAll("input")
            precio.value = compra.precio
            cantidad.value = compra.cantidad
            hUpdatePmRowTotal(fila)
        })

        aviso.textContent = `${compras.length} compra${compras.length === 1 ? "" : "s"} cargada${compras.length === 1 ? "" : "s"}.`
        aviso.className = "hPrecargaMsg hRatioFuenteOk"
        hCalcPrecioMedio()
    } catch (error) {
        console.error(error)
        aviso.textContent = "No se pudieron cargar las compras."
        aviso.className = "hPrecargaMsg hRatioFuenteWarn"
    } finally {
        boton.disabled = false
    }
}
