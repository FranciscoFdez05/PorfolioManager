let _herramientasChart = null
let _hDivChart = null
let _hPrecioMedioCount = 0

// Colores del gráfico según el tema activo. Las variables de :root no sirven
// aquí: los temas claro y negro no las redefinen, sobrescriben clases (ver el
// bloque de Herramientas al final de css/themes.css), así que leerlas
// devolvía siempre la paleta oscura y en el tema claro la rejilla salía azul
// marino y la leyenda casi invisible.
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
    let activos = []
    try {
        activos = await hActivos()
    } catch (error) {
        console.error(error)
        return
    }

    const visibles = activos
        .filter((a) => !a.hidden)
        .sort((a, b) => (a.name || "").localeCompare(b.name || "", "es"))

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

// ── Rebalanceo ─────────────────────────────────────────────────────────────
// Agrupa la cartera por tipo de activo y dice qué mover para volver al reparto
// objetivo. Con aportación, el ajuste es solo a base de comprar: vender tiene
// coste fiscal y comisiones, así que no se propone si se puede evitar.

let _hRebTipos = []

async function hRebCargarCartera() {
    const boton = document.getElementById("hRebCargarBtn")
    const aviso = document.getElementById("hRebMsg")
    if (!boton || !aviso) return

    boton.disabled = true
    aviso.textContent = "Cargando…"
    aviso.className = "hPrecargaMsg"

    try {
        const [activos, rendimientoResp] = await Promise.all([hActivos(), fetch("/api/activos/rendimiento-batch")])
        if (!rendimientoResp.ok) throw new Error("rendimiento-batch")
        const rendimiento = await rendimientoResp.json()

        const porTipo = {}
        let incompletos = 0
        activos.forEach((activo) => {
            const dato = rendimiento[activo.id]
            if (!dato) return
            // El valor viene en la moneda del activo; el desglose por divisa lo
            // trae además en euros. Sin conversión disponible se usa el original
            // y se avisa, que es mejor que dejar el activo fuera del reparto.
            const divisa = dato.divisa
            let valor = Number(dato.netoActual) || 0
            if (divisa && divisa.completo) {
                valor = parseFloat(divisa.valorEur) || 0
            } else if (divisa && divisa.moneda && divisa.moneda !== "EUR") {
                incompletos++
            }
            if (valor <= 0) return
            const tipo = activo.type || "otros"
            porTipo[tipo] = (porTipo[tipo] || 0) + valor
        })

        const total = Object.values(porTipo).reduce((a, b) => a + b, 0)
        if (total <= 0) {
            aviso.textContent = "No hay posiciones con valor en la cartera."
            aviso.className = "hPrecargaMsg hRatioFuenteWarn"
            return
        }

        _hRebTipos = Object.entries(porTipo)
            .map(([tipo, valor]) => ({ tipo, etiqueta: hEtiquetaTipo(tipo), valor, peso: (valor / total) * 100 }))
            .sort((a, b) => b.valor - a.valor)

        hRebPintarTabla()
        aviso.textContent =
            `Cartera de ${formatEuro(total)} en ${_hRebTipos.length} tipo${_hRebTipos.length === 1 ? "" : "s"}.` +
            (incompletos ? ` ${incompletos} activo(s) sin tipo de cambio: van en su moneda.` : "")
        aviso.className = "hPrecargaMsg" + (incompletos ? " hRatioFuenteWarn" : " hRatioFuenteOk")
    } catch (error) {
        console.error(error)
        aviso.textContent = "No se pudo leer la cartera."
        aviso.className = "hPrecargaMsg hRatioFuenteWarn"
    } finally {
        boton.disabled = false
    }
}

function hRebPintarTabla() {
    const cuerpo = document.getElementById("hRebBody")
    if (!cuerpo) return
    cuerpo.innerHTML = ""

    _hRebTipos.forEach((fila, indice) => {
        const tr = document.createElement("tr")
        tr.innerHTML = `
            <td class="hRebTipo"></td>
            <td class="hRebValor"></td>
            <td class="hRebPeso"></td>
            <td><input type="number" class="hPrecioInput hRebObjetivo" min="0" max="100" step="0.1"></td>
            <td class="hRebDesv">---</td>
            <td class="hRebAccion">---</td>
        `
        tr.querySelector(".hRebTipo").textContent = fila.etiqueta
        tr.querySelector(".hRebValor").textContent = formatEuro(fila.valor)
        tr.querySelector(".hRebPeso").textContent = fila.peso.toFixed(1) + " %"
        // El objetivo arranca en el peso actual: así solo hay que tocar lo que
        // se quiere cambiar, y la suma ya vale 100.
        const objetivo = tr.querySelector(".hRebObjetivo")
        objetivo.value = fila.peso.toFixed(1)
        objetivo.dataset.indice = indice
        objetivo.addEventListener("input", hRebActualizarSuma)
        cuerpo.appendChild(tr)
    })

    hRebActualizarSuma()
}

function hRebObjetivos() {
    return Array.from(document.querySelectorAll(".hRebObjetivo")).map((input) => parseFloat(input.value) || 0)
}

function hRebActualizarSuma() {
    const aviso = document.getElementById("hRebSumaMsg")
    if (!aviso) return
    const suma = hRebObjetivos().reduce((a, b) => a + b, 0)
    const desviada = Math.abs(suma - 100) > 0.5
    aviso.textContent = `Suma de objetivos: ${suma.toFixed(1)} %` + (desviada ? " — tiene que sumar 100 %" : "")
    aviso.className = "hPrecargaMsg" + (desviada ? " hRatioFuenteWarn" : " hRatioFuenteOk")
}

function hRebCalcular() {
    if (!_hRebTipos.length) return

    const objetivos = hRebObjetivos()
    const suma = objetivos.reduce((a, b) => a + b, 0)
    if (Math.abs(suma - 100) > 0.5) {
        hRebActualizarSuma()
        return
    }

    const aportacion = Math.max(0, parseFloat(document.getElementById("hRebAportacion").value) || 0)
    const total = _hRebTipos.reduce((acumulado, fila) => acumulado + fila.valor, 0)
    const totalFinal = total + aportacion

    const deltas = _hRebTipos.map((fila, i) => (totalFinal * objetivos[i]) / 100 - fila.valor)

    let acciones = deltas
    if (aportacion > 0) {
        // Solo comprar: se reparte la aportación entre los tipos que están por
        // debajo, en proporción a lo que les falta. Si sobra dinero, el resto va
        // según el objetivo.
        const faltas = deltas.map((d) => Math.max(0, d))
        const faltaTotal = faltas.reduce((a, b) => a + b, 0)
        if (faltaTotal <= aportacion && faltaTotal > 0) {
            const sobra = aportacion - faltaTotal
            acciones = faltas.map((f, i) => f + (sobra * objetivos[i]) / 100)
        } else if (faltaTotal > 0) {
            acciones = faltas.map((f) => (f / faltaTotal) * aportacion)
        } else {
            acciones = objetivos.map((o) => (aportacion * o) / 100)
        }
    }

    const filas = document.querySelectorAll("#hRebBody tr")
    let mayorDesviacion = 0
    let aMover = 0

    _hRebTipos.forEach((fila, i) => {
        const tr = filas[i]
        if (!tr) return
        const desviacion = fila.peso - objetivos[i]
        if (Math.abs(desviacion) > Math.abs(mayorDesviacion)) mayorDesviacion = desviacion

        const celdaDesv = tr.querySelector(".hRebDesv")
        celdaDesv.textContent = (desviacion >= 0 ? "+" : "") + desviacion.toFixed(1) + " p.p."
        celdaDesv.className = "hRebDesv " + (Math.abs(desviacion) < 0.5 ? "" : desviacion > 0 ? "hDivNeg" : "hDivPos")

        const accion = acciones[i]
        const celdaAccion = tr.querySelector(".hRebAccion")
        if (Math.abs(accion) < 1) {
            celdaAccion.textContent = "—"
            celdaAccion.className = "hRebAccion"
        } else if (accion > 0) {
            celdaAccion.textContent = "Comprar " + formatEuro(accion)
            celdaAccion.className = "hRebAccion hDivPos"
            aMover += accion
        } else {
            celdaAccion.textContent = "Vender " + formatEuro(-accion)
            celdaAccion.className = "hRebAccion hDivNeg"
            aMover += -accion
        }
    })

    document.getElementById("hRebTotal").textContent = formatEuro(totalFinal)
    document.getElementById("hRebMover").textContent = formatEuro(aportacion > 0 ? aportacion : aMover / 2)
    const maxDesv = document.getElementById("hRebMaxDesv")
    maxDesv.textContent = (mayorDesviacion >= 0 ? "+" : "") + mayorDesviacion.toFixed(1) + " p.p."
    maxDesv.className = "hResultValue " + (Math.abs(mayorDesviacion) < 1 ? "hResultPositive" : "hResultNegative")

    const nota = document.getElementById("hRebNota")
    if (Math.abs(mayorDesviacion) < 1) {
        nota.textContent = "La cartera está en su objetivo: ninguna desviación llega a un punto porcentual."
        nota.className = "hRatioInterpretacion hRatioInfoPos"
    } else if (aportacion > 0) {
        nota.textContent = `Con ${formatEuro(aportacion)} de aportación se corrige sin vender nada, así que no hay peaje fiscal ni comisiones de venta.`
        nota.className = "hRatioInterpretacion hRatioInfoPos"
    } else {
        nota.textContent =
            "Vender para rebalancear tributa: pasa la venta por «Simular venta» antes de decidir, " +
            "o mira cuánta aportación haría falta para corregirlo comprando."
        nota.className = "hRatioInterpretacion hRatioInfoNeg"
    }

    document.getElementById("hRebResults").classList.remove("hidden")
}

// ── Simular venta ──────────────────────────────────────────────────────────
// El cálculo entero lo hace el servidor (/api/herramientas/simular-venta), que
// reutiliza el mismo FIFO y la misma normativa que la pantalla de Ventas. Aquí
// solo se recogen los datos y se pinta la respuesta.

function hSvPreparar() {
    const fecha = document.getElementById("hSvFecha")
    if (fecha && !fecha.value) {
        const hoy = new Date()
        const dd = String(hoy.getDate()).padStart(2, "0")
        const mm = String(hoy.getMonth() + 1).padStart(2, "0")
        fecha.value = `${dd}-${mm}-${hoy.getFullYear()}`
    }

    const select = document.getElementById("hSvActivo")
    if (select && !select._hSvEnganchado) {
        select._hSvEnganchado = true
        select.addEventListener("change", hSvActivoElegido)
    }
}

async function hSvActivoElegido() {
    const select = document.getElementById("hSvActivo")
    const precio = document.getElementById("hSvPrecio")
    if (!select || !precio || !select.value) return

    const activo = (await hActivos()).find((a) => a.id === select.value)
    if (!activo) return

    // El precio de venta más probable es el de mercado guardado.
    const actual = parseEuroNumber(String(activo.price || "0"))
    if (actual > 0) precio.value = actual

    // Las cifras salen en la moneda del activo, no siempre en euros.
    const moneda = (activo.currency || "EUR").toUpperCase()
    const simbolo = moneda === "EUR" ? "€" : moneda
    document.querySelectorAll("#toolSimularVenta .hSvMoneda").forEach((el) => {
        el.textContent = simbolo
    })
}

async function hSvCalcular() {
    const select = document.getElementById("hSvActivo")
    const aviso = document.getElementById("hSvAviso")
    const disponible = document.getElementById("hSvDisponible")
    if (!select) return

    if (!select.value) {
        disponible.textContent = "Elige antes un activo."
        disponible.className = "hPrecargaMsg hRatioFuenteWarn"
        return
    }

    const parametros = new URLSearchParams({
        activo: select.value,
        cantidad: document.getElementById("hSvCantidad").value || "0",
        precio: document.getElementById("hSvPrecio").value || "0",
        comision: document.getElementById("hSvComision").value || "0",
        fecha: document.getElementById("hSvFecha").value || ""
    })

    let datos
    try {
        const respuesta = await fetch(`/api/herramientas/simular-venta?${parametros}`)
        datos = await respuesta.json()
        if (!respuesta.ok || !datos.ok) {
            disponible.textContent = datos.error || "No se pudo calcular la venta."
            disponible.className = "hPrecargaMsg hRatioFuenteWarn"
            return
        }
    } catch (error) {
        console.error(error)
        disponible.textContent = "No se pudo calcular la venta."
        disponible.className = "hPrecargaMsg hRatioFuenteWarn"
        return
    }

    const s = datos.simulacion
    const moneda = document.querySelector("#toolSimularVenta .hSvMoneda")?.textContent || "€"
    const importe = (valor) => formatEuro(parseFloat(valor) || 0).replace("€", moneda)

    disponible.textContent = `Tienes ${parseFloat(s.disponible).toLocaleString("es-ES", { maximumFractionDigits: 8 })} uds.`
    disponible.className = "hPrecargaMsg"

    document.getElementById("hSvNeto").textContent = importe(s.neto)
    document.getElementById("hSvCuota").textContent = importe(s.cuota)
    document.getElementById("hSvBruto").textContent = importe(s.valorTransmision)
    document.getElementById("hSvCoste").textContent = importe(s.costeAdquisicion)
    document.getElementById("hSvTipo").textContent = (parseFloat(s.tipoEfectivo) || 0).toFixed(2) + " %"

    const ganancia = parseFloat(s.ganancia) || 0
    const celdaGanancia = document.getElementById("hSvGanancia")
    celdaGanancia.textContent = importe(s.ganancia)
    celdaGanancia.className = "hResultValue " + (ganancia >= 0 ? "hResultPositive" : "hResultNegative")

    const lotes = document.getElementById("hSvLotes")
    lotes.innerHTML = ""
    ;(s.lotes || []).forEach((lote) => {
        const tr = document.createElement("tr")
        tr.innerHTML = "<td></td><td></td><td></td><td></td>"
        const celdas = tr.querySelectorAll("td")
        celdas[0].textContent = lote.fecha
        celdas[1].textContent = parseFloat(lote.cantidad).toLocaleString("es-ES", { maximumFractionDigits: 8 })
        celdas[2].textContent = importe(lote.costeUnitario)
        celdas[3].textContent = importe(lote.coste)
        lotes.appendChild(tr)
    })

    // Avisos: primero lo que impide fiarse del número, luego la norma que lo
    // cambia, y si no hay nada de eso, la compensación que lo abarata.
    const textos = []
    let tono = "hRatioInfoNeg"
    if (s.mensaje) {
        textos.push(s.mensaje)
    } else if (s.notaAntiaplicacion) {
        textos.push(
            `${s.notaAntiaplicacion} La pérdida no computa ahora (${importe(s.perdidaNoComputable)}): ` +
            "se suma al coste de las participaciones recompradas y saldrá cuando las vendas."
        )
    } else if (parseFloat(s.compensadoAnteriores) > 0) {
        textos.push(`Se compensan ${importe(s.compensadoAnteriores)} de pérdidas de ejercicios anteriores, y por eso el tipo efectivo baja.`)
        tono = "hRatioInfoPos"
    }

    if (textos.length) {
        aviso.textContent = textos.join(" ")
        aviso.className = "hRatioInterpretacion " + tono
        aviso.classList.remove("hidden")
    } else {
        aviso.classList.add("hidden")
    }

    document.getElementById("hSvResults").classList.remove("hidden")
}

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
    let lista = []
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

// ── Interés Compuesto ──────────────────────────────────────────────────────

function hCalcInteresCompuesto() {
    const P = parseFloat(document.getElementById("hIntCapital").value) || 0
    const pmt = parseFloat(document.getElementById("hIntAportacion").value) || 0
    const r = (parseFloat(document.getElementById("hIntTasa").value) || 0) / 100
    const t = parseInt(document.getElementById("hIntAnos").value) || 0
    if (t <= 0) return

    const rn = r / 12
    const yearlyData = []
    for (let y = 0; y <= t; y++) {
        const m = y * 12
        const cap = P * Math.pow(1 + rn, m)
        const aport = rn > 0 ? (pmt * (Math.pow(1 + rn, m) - 1)) / rn : pmt * m
        yearlyData.push({ year: y, total: cap + aport, aportado: P + pmt * m })
    }

    const final = yearlyData[t]
    const capitalFinal = final.total
    const totalAport = final.aportado
    const intereses = capitalFinal - totalAport
    const mult = totalAport > 0 ? (capitalFinal / totalAport).toFixed(2) + "x" : "---"

    document.getElementById("hIntCapitalFinal").textContent = formatEuro(capitalFinal)
    document.getElementById("hIntTotalAportado").textContent = formatEuro(totalAport)
    document.getElementById("hIntIntereses").textContent = formatEuro(intereses)
    document.getElementById("hIntMultiplicador").textContent = mult
    document.getElementById("hIntResults").classList.remove("hidden")

    if (_herramientasChart) {
        _herramientasChart.destroy()
        _herramientasChart = null
    }
    const ctx = document.getElementById("hIntChart")
    if (!ctx) return

    const tema = hChartTheme()
    _herramientasChart = new Chart(ctx, {
        type: "line",
        data: {
            labels: yearlyData.map((d) => "Año " + d.year),
            datasets: [
                {
                    label: "Capital total",
                    data: yearlyData.map((d) => d.total),
                    borderColor: "#2ecc71",
                    backgroundColor: "#2ecc7120",
                    fill: true,
                    tension: 0.3,
                    pointRadius: 2
                },
                {
                    label: "Total aportado",
                    data: yearlyData.map((d) => d.aportado),
                    borderColor: "#3498db",
                    backgroundColor: "#3498db20",
                    fill: true,
                    tension: 0.3,
                    pointRadius: 2
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            plugins: {
                legend: { labels: { color: tema.text, font: { size: 12 }, padding: 12 } },
                tooltip: { callbacks: { label: (c) => "  " + formatEuro(c.raw) } }
            },
            scales: {
                x: { ticks: { color: tema.muted, font: { size: 11 } }, grid: { color: tema.grid } },
                y: {
                    ticks: { color: tema.muted, font: { size: 11 }, callback: (v) => formatEuro(v) },
                    grid: { color: tema.grid }
                }
            }
        }
    })
}

// ── Rentabilidad ───────────────────────────────────────────────────────────

function hCalcRentabilidad() {
    const compra = parseFloat(document.getElementById("hRentCompra").value) || 0
    const venta = parseFloat(document.getElementById("hRentVenta").value) || 0
    const dividendos = parseFloat(document.getElementById("hRentDividendos").value) || 0
    const comisiones = parseFloat(document.getElementById("hRentComisiones").value) || 0
    const anos = parseFloat(document.getElementById("hRentAnos").value) || 1
    if (compra <= 0) return

    const pnl = venta - compra + dividendos - comisiones
    const rentTotal = (pnl / compra) * 100
    const rentAnual = (Math.pow(1 + pnl / compra, 1 / anos) - 1) * 100

    const set = (id, val, isEuro = false) => {
        const el = document.getElementById(id)
        el.textContent = isEuro ? formatEuro(val) : val.toFixed(2) + " %"
        el.className = "hResultValue " + (val >= 0 ? "hResultPositive" : "hResultNegative")
    }
    set("hRentPnL", pnl, true)
    set("hRentTotal", rentTotal)
    set("hRentAnualizada", rentAnual)
    document.getElementById("hRentResults").classList.remove("hidden")
}

// ── Precio Medio ───────────────────────────────────────────────────────────

function hInitPrecioMedio() {
    _hPrecioMedioCount = 0
    const tbody = document.getElementById("hPrecioMedioBody")
    if (!tbody) return
    tbody.innerHTML = ""
    hAddPrecioMedioRow()
    hAddPrecioMedioRow()
    hAddPrecioMedioRow()
}

function hAddPrecioMedioRow() {
    const tbody = document.getElementById("hPrecioMedioBody")
    if (!tbody) return
    _hPrecioMedioCount++
    const tr = document.createElement("tr")
    tr.innerHTML = `
        <td class="hPmNum">${_hPrecioMedioCount}</td>
        <td><input type="number" class="hPrecioInput" placeholder="0.00" step="0.01" min="0"></td>
        <td><input type="number" class="hPrecioInput" placeholder="1" step="0.0001" min="0"></td>
        <td class="hPmTotal">---</td>
        <td><button class="hPrecioDeleteBtn" title="Eliminar">✕</button></td>
    `
    tr.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", () => hUpdatePmRowTotal(tr)))
    tr.querySelector(".hPrecioDeleteBtn").addEventListener("click", () => {
        tr.remove()
        document.querySelectorAll("#hPrecioMedioBody tr").forEach((r, i) => {
            r.querySelector(".hPmNum").textContent = i + 1
        })
    })
    tbody.appendChild(tr)
}

function hUpdatePmRowTotal(tr) {
    const [pInp, qInp] = tr.querySelectorAll("input")
    const p = parseFloat(pInp.value) || 0
    const q = parseFloat(qInp.value) || 0
    tr.querySelector(".hPmTotal").textContent = p > 0 && q > 0 ? formatEuro(p * q) : "---"
}

function hCalcPrecioMedio() {
    let totalInv = 0,
        totalUnd = 0
    document.querySelectorAll("#hPrecioMedioBody tr").forEach((tr) => {
        const [pInp, qInp] = tr.querySelectorAll("input")
        totalInv += (parseFloat(pInp.value) || 0) * (parseFloat(qInp.value) || 0)
        totalUnd += parseFloat(qInp.value) || 0
    })
    const pm = totalUnd > 0 ? totalInv / totalUnd : 0
    document.getElementById("hPrecioMedioResult").textContent = formatEuro(pm)
    document.getElementById("hPrecioTotalInv").textContent = formatEuro(totalInv)
    document.getElementById("hPrecioTotalUnidades").textContent = totalUnd.toLocaleString("es-ES", {
        maximumFractionDigits: 8
    })
    document.getElementById("hPrecioResults").classList.remove("hidden")
}

// ── CAGR ───────────────────────────────────────────────────────────────────

function hCalcCagr() {
    const vi = parseFloat(document.getElementById("hCagrInicial").value) || 0
    const vf = parseFloat(document.getElementById("hCagrFinal").value) || 0
    const t = parseFloat(document.getElementById("hCagrAnos").value) || 1
    if (vi <= 0 || t <= 0) return

    const cagr = (Math.pow(vf / vi, 1 / t) - 1) * 100
    const crecTotal = ((vf - vi) / vi) * 100

    const setResult = (id, val) => {
        const el = document.getElementById(id)
        el.textContent = val.toFixed(2) + " %"
        el.className = "hResultValue " + (val >= 0 ? "hResultPositive" : "hResultNegative")
    }
    setResult("hCagrResult", cagr)
    setResult("hCagrCrecimiento", crecTotal)
    document.getElementById("hCagrResults").classList.remove("hidden")
}

// ── Rentabilidad Dividendo ─────────────────────────────────────────────────

async function hLoadDividendos() {
    const btn = document.getElementById("hDivLoadBtn")
    if (btn) btn.textContent = "Cargando..."

    try {
        const resp = await fetch("/api/dividendos")
        if (!resp.ok) throw new Error()
        const rows = await resp.json()

        const byInst = {}
        rows.forEach((r) => {
            const name = (r.instrumento || "Sin nombre").trim()
            if (!byInst[name]) byInst[name] = { count: 0, bruto: 0, retencion: 0, neto: 0 }
            byInst[name].count++
            byInst[name].bruto += parseEuroNumber(String(r.total || r.dividendo || "0"))
            byInst[name].retencion += parseEuroNumber(String(r.retencion || "0"))
            byInst[name].neto += parseEuroNumber(String(r.neto || "0"))
        })

        const sorted = Object.entries(byInst).sort((a, b) => b[1].neto - a[1].neto)

        // Tabla
        const tbody = document.getElementById("hDivTableBody")
        tbody.innerHTML = ""
        sorted.forEach(([name, d]) => {
            const tr = document.createElement("tr")
            tr.innerHTML = `
                <td class="hDivName">${name}</td>
                <td class="hDivNum">${d.count}</td>
                <td class="hDivNum">${formatEuro(d.bruto)}</td>
                <td class="hDivNum hDivNeg">${formatEuro(d.retencion)}</td>
                <td class="hDivNum hDivPos">${formatEuro(d.neto)}</td>
            `
            tbody.appendChild(tr)
        })

        // Gráfico
        if (_hDivChart) {
            _hDivChart.destroy()
            _hDivChart = null
        }
        const ctx = document.getElementById("hDivChart")
        if (ctx && sorted.length) {
            const labels = sorted.map(([n]) => n)
            const brutos = sorted.map(([, d]) => d.bruto)
            const netos = sorted.map(([, d]) => d.neto)
            const chartH = Math.max(200, sorted.length * 36)
            ctx.parentElement.style.height = chartH + "px"
            const tema = hChartTheme()

            _hDivChart = new Chart(ctx, {
                type: "bar",
                data: {
                    labels,
                    datasets: [
                        {
                            label: "Bruto",
                            data: brutos,
                            backgroundColor: "#3498db88",
                            borderColor: "#3498db",
                            borderWidth: 1,
                            borderRadius: 3
                        },
                        {
                            label: "Neto",
                            data: netos,
                            backgroundColor: "#2ecc7188",
                            borderColor: "#2ecc71",
                            borderWidth: 1,
                            borderRadius: 3
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    indexAxis: "y",
                    plugins: {
                        legend: { labels: { color: tema.text, font: { size: 12 }, padding: 12 } },
                        tooltip: { callbacks: { label: (c) => "  " + formatEuro(c.raw) } }
                    },
                    scales: {
                        x: {
                            ticks: { color: tema.muted, font: { size: 11 }, callback: (v) => formatEuro(v) },
                            grid: { color: tema.grid }
                        },
                        y: { ticks: { color: tema.text, font: { size: 12 } }, grid: { color: tema.grid } }
                    }
                }
            })
        }

        document.getElementById("hDivHistResults").classList.remove("hidden")
    } catch {
        if (btn) btn.textContent = "Error al cargar"
        return
    }

    if (btn) btn.textContent = "Actualizar"
}

// ── Ratio Oro / Plata ──────────────────────────────────────────────────────

const ORO_KEYWORDS = ["oro", "gold", "xau"]
const PLATA_KEYWORDS = ["plata", "silver", "xag"]

function _ratioMatchesMetal(asset, keywords) {
    const haystack = ((asset.name || "") + " " + (asset.symbol || "")).toLowerCase()
    return keywords.some((k) => haystack.includes(k))
}

async function hRatioLoadPrecios() {
    const btn = document.getElementById("hRatioLoadBtn")
    const msgEl = document.getElementById("hRatioFuenteMsg")
    btn.textContent = "Cargando..."
    btn.disabled = true
    msgEl.textContent = ""
    msgEl.className = "hRatioFuenteMsg"

    try {
        const res = await fetch("/api/activos")
        if (!res.ok) throw new Error()
        const { assets } = await res.json()

        const oroAsset = assets.find((a) => _ratioMatchesMetal(a, ORO_KEYWORDS))
        const plataAsset = assets.find((a) => _ratioMatchesMetal(a, PLATA_KEYWORDS))

        const msgs = []
        if (oroAsset) {
            const p = parseEuroNumber(oroAsset.price)
            if (p > 0) {
                document.getElementById("hRatioPrecioOro").value = p
                msgs.push(`Oro: ${oroAsset.name} → ${formatEuro(p)}`)
            }
        }
        if (plataAsset) {
            const p = parseEuroNumber(plataAsset.price)
            if (p > 0) {
                document.getElementById("hRatioPrecioPlata").value = p
                msgs.push(`Plata: ${plataAsset.name} → ${formatEuro(p)}`)
            }
        }

        if (msgs.length === 0) {
            msgEl.textContent = "No se encontraron activos de oro o plata en la cartera."
            msgEl.className = "hRatioFuenteMsg hRatioFuenteWarn"
        } else {
            msgEl.textContent = msgs.join("  ·  ")
            msgEl.className = "hRatioFuenteMsg hRatioFuenteOk"
            if (msgs.length === 2) hCalcRatioOroPlata()
        }
    } catch {
        msgEl.textContent = "Error al cargar los activos."
        msgEl.className = "hRatioFuenteMsg hRatioFuenteWarn"
    }

    btn.textContent = "Cargar precios guardados"
    btn.disabled = false
}

let _ratioHistorico = Number(getChartPref("hRatioHistorico", 60)) || 60

function hRatioAplicarHistoricoLabels() {
    const v = _ratioHistorico
    const label = document.getElementById("hRatioHistLabel")
    const labelResult = document.getElementById("hRatioHistLabelResult")
    const labelJusto = document.getElementById("hRatioHistLabelJusto")
    if (label) label.textContent = v
    if (labelResult) labelResult.textContent = v
    if (labelJusto) labelJusto.textContent = v
}

function hRatioAbrirEditor() {
    document.getElementById("hRatioHistInput").value = _ratioHistorico
    document.getElementById("hRatioEditorOverlay").classList.remove("hidden")
    document.getElementById("hRatioHistInput").focus()
}

function hRatioCerrarEditor() {
    document.getElementById("hRatioEditorOverlay").classList.add("hidden")
}

function hRatioGuardarHistorico() {
    const v = parseFloat(document.getElementById("hRatioHistInput").value)
    if (!v || v <= 0) return
    _ratioHistorico = v
    setChartPref("hRatioHistorico", v)
    hRatioAplicarHistoricoLabels()
    hRatioCerrarEditor()
    hCalcRatioOroPlata()
}

function hCalcRatioOroPlata() {
    const precioOro = parseFloat(document.getElementById("hRatioPrecioOro").value) || 0
    const precioPlata = parseFloat(document.getElementById("hRatioPrecioPlata").value) || 0
    if (precioOro <= 0 || precioPlata <= 0) return

    const ratio = precioOro / precioPlata
    const mediaHist = _ratioHistorico
    const difVsHist = ((ratio - mediaHist) / mediaHist) * 100
    const precioJusto = precioOro / mediaHist
    const plataNecesaria = ratio

    document.getElementById("hRatioValor").textContent = ratio.toFixed(2) + " oz"

    const vsEl = document.getElementById("hRatioVsHistorico")
    vsEl.textContent = (difVsHist >= 0 ? "+" : "") + difVsHist.toFixed(1) + "% vs media"
    vsEl.className = "hResultValue " + (difVsHist > 0 ? "hResultNegative" : "hResultPositive")

    document.getElementById("hRatioPrecioJusto").textContent = formatEuro(precioJusto) + "/oz"

    document.getElementById("hRatioPlataParaOro").textContent =
        plataNecesaria.toFixed(2) + " oz (" + formatEuro(plataNecesaria * precioPlata) + ")"

    const interp = document.getElementById("hRatioInterpretacion")
    if (ratio > mediaHist) {
        interp.textContent = `El ratio está por encima de la media histórica (${ratio.toFixed(0)} vs ${mediaHist}). La plata está relativamente barata frente al oro.`
        interp.className = "hRatioInterpretacion hRatioInfoPos"
    } else {
        interp.textContent = `El ratio está por debajo de la media histórica (${ratio.toFixed(0)} vs ${mediaHist}). La plata está relativamente cara frente al oro.`
        interp.className = "hRatioInterpretacion hRatioInfoNeg"
    }

    document.getElementById("hRatioResults").classList.remove("hidden")
}

// ── Yield Manual ───────────────────────────────────────────────────────────

function hCalcYield() {
    const precio = parseFloat(document.getElementById("hYieldPrecio").value) || 0
    const divAnual = parseFloat(document.getElementById("hYieldDiv").value) || 0
    const acciones = parseFloat(document.getElementById("hYieldAcciones").value) || 0
    const retencion = (parseFloat(document.getElementById("hYieldRetencion").value) || 0) / 100
    if (precio <= 0) return

    const yieldPct = (divAnual / precio) * 100
    const brutoAnual = divAnual * acciones
    const netoAnual = brutoAnual * (1 - retencion)
    const netoMensual = netoAnual / 12

    document.getElementById("hYieldPct").textContent = yieldPct.toFixed(2) + " %"
    document.getElementById("hYieldBruto").textContent = formatEuro(brutoAnual)
    document.getElementById("hYieldNeto").textContent = formatEuro(netoAnual)
    document.getElementById("hYieldMensual").textContent = formatEuro(netoMensual)
    document.getElementById("hYieldResults").classList.remove("hidden")
}

// ── Oro / Bitcoin ──────────────────────────────────────────────────────────

const BTC_KEYWORDS = ["bitcoin", "btc"]

let _oroBtcRef = Number(getChartPref("hOroBtcRef", 20)) || 20

function hOroBtcAplicarRefLabels() {
    const v = _oroBtcRef
    const label = document.getElementById("hOroBtcHistLabel")
    const labelResult = document.getElementById("hOroBtcHistLabelResult")
    const labelJusto = document.getElementById("hOroBtcHistLabelJusto")
    if (label) label.textContent = v
    if (labelResult) labelResult.textContent = v
    if (labelJusto) labelJusto.textContent = v
}

function hOroBtcAbrirEditor() {
    document.getElementById("hOroBtcHistInput").value = _oroBtcRef
    document.getElementById("hOroBtcEditorOverlay").classList.remove("hidden")
    document.getElementById("hOroBtcHistInput").focus()
}

function hOroBtcCerrarEditor() {
    document.getElementById("hOroBtcEditorOverlay").classList.add("hidden")
}

function hOroBtcGuardarRef() {
    const v = parseFloat(document.getElementById("hOroBtcHistInput").value)
    if (!v || v <= 0) return
    _oroBtcRef = v
    setChartPref("hOroBtcRef", v)
    hOroBtcAplicarRefLabels()
    hOroBtcCerrarEditor()
    hCalcOroBtc()
}

async function hOroBtcLoadPrecios() {
    const btn = document.getElementById("hOroBtcLoadBtn")
    const msgEl = document.getElementById("hOroBtcFuenteMsg")
    btn.textContent = "Cargando..."
    btn.disabled = true
    msgEl.textContent = ""
    msgEl.className = "hRatioFuenteMsg"

    try {
        const [activosRes] = await Promise.all([fetch("/api/activos")])
        if (!activosRes.ok) throw new Error()
        const { assets } = await activosRes.json()

        const oroAsset = assets.find((a) => _ratioMatchesMetal(a, ORO_KEYWORDS))
        const btcAsset = assets.find((a) => _ratioMatchesMetal(a, BTC_KEYWORDS))

        if (!oroAsset && !btcAsset) {
            msgEl.textContent = "No se encontraron activos de oro o Bitcoin en la cartera."
            msgEl.className = "hRatioFuenteMsg hRatioFuenteWarn"
            btn.textContent = "Cargar precios guardados"
            btn.disabled = false
            return
        }

        const monedaBase = window._monedaBase || "EUR"
        const msgs = []
        let precioOroFinal = 0
        let precioBtcFinal = 0

        // Precio oro → convertir a monedaBase si es necesario
        if (oroAsset) {
            let p = parseEuroNumber(oroAsset.price)
            const oroCurrency = (oroAsset.currency || "EUR").toUpperCase()
            if (p > 0) {
                if (oroCurrency !== monedaBase) {
                    const rateRes = await fetch(`/api/exchange-rate?from=${oroCurrency}&to=${monedaBase}`)
                    const rateData = await rateRes.json()
                    if (rateData.ok) p = p * rateData.rate
                }
                precioOroFinal = p
                document.getElementById("hOroBtcPrecioOro").value = p.toFixed(2)
                msgs.push(`Oro: ${oroAsset.name} → ${p.toFixed(2)} ${monedaBase} (original ${oroCurrency})`)
            }
        }

        // Precio BTC → convertir a monedaBase si es necesario
        if (btcAsset) {
            let p = parseEuroNumber(btcAsset.price)
            const btcCurrency = (btcAsset.currency || "USD").toUpperCase()
            if (p > 0) {
                if (btcCurrency !== monedaBase) {
                    const rateRes = await fetch(`/api/exchange-rate?from=${btcCurrency}&to=${monedaBase}`)
                    const rateData = await rateRes.json()
                    if (rateData.ok) p = p * rateData.rate
                }
                precioBtcFinal = p
                document.getElementById("hOroBtcPrecioBtc").value = p.toFixed(2)
                msgs.push(`Bitcoin: ${btcAsset.name} → ${p.toFixed(2)} ${monedaBase} (original ${btcCurrency})`)
            }
        }

        if (msgs.length === 0) {
            msgEl.textContent = "No se pudieron obtener los precios."
            msgEl.className = "hRatioFuenteMsg hRatioFuenteWarn"
        } else {
            msgEl.textContent = msgs.join("  ·  ")
            msgEl.className = "hRatioFuenteMsg hRatioFuenteOk"
            if (precioOroFinal > 0 && precioBtcFinal > 0) hCalcOroBtc()
        }
    } catch {
        msgEl.textContent = "Error al cargar los activos."
        msgEl.className = "hRatioFuenteMsg hRatioFuenteWarn"
    }

    btn.textContent = "Cargar precios guardados"
    btn.disabled = false
}

function hCalcOroBtc() {
    const precioOro = parseFloat(document.getElementById("hOroBtcPrecioOro").value) || 0
    const precioBtc = parseFloat(document.getElementById("hOroBtcPrecioBtc").value) || 0
    if (precioOro <= 0 || precioBtc <= 0) return

    const monedaBase = window._monedaBase || "EUR"
    const simbolo = monedaBase === "USD" ? "$" : "€"
    const fmt = (v) => simbolo + v.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

    const ratio = precioBtc / precioOro
    const ref = _oroBtcRef
    const difVsRef = ((ratio - ref) / ref) * 100
    const precioJusto = precioOro * ref
    const btcPorOz = precioOro / precioBtc

    document.getElementById("hOroBtcValor").textContent = ratio.toFixed(2) + " oz"

    const vsEl = document.getElementById("hOroBtcVsRef")
    vsEl.textContent = (difVsRef >= 0 ? "+" : "") + difVsRef.toFixed(1) + "% vs referencia"
    vsEl.className = "hResultValue " + (difVsRef > 0 ? "hResultNegative" : "hResultPositive")

    document.getElementById("hOroBtcPrecioJusto").textContent = fmt(precioJusto) + "/" + monedaBase

    document.getElementById("hOroBtcEquiv").textContent = btcPorOz.toFixed(6) + " BTC (" + fmt(precioOro) + ")"

    const interp = document.getElementById("hOroBtcInterpretacion")
    if (ratio > ref) {
        interp.textContent = `Bitcoin cotiza por encima de la referencia (${ratio.toFixed(1)} oz vs ${ref} oz de oro). Bitcoin está relativamente caro frente al oro.`
        interp.className = "hRatioInterpretacion hRatioInfoNeg"
    } else {
        interp.textContent = `Bitcoin cotiza por debajo de la referencia (${ratio.toFixed(1)} oz vs ${ref} oz de oro). Bitcoin está relativamente barato frente al oro.`
        interp.className = "hRatioInterpretacion hRatioInfoPos"
    }

    document.getElementById("hOroBtcResults").classList.remove("hidden")
}
