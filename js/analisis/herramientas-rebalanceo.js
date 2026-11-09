// Análisis > Herramientas: rebalanceo y simulación de venta.
//
// Trozo de js/analisis/herramientas.js. Comparte con el resto de herramientas-*.js el
// ámbito global y se carga detrás de herramientas.js, en el orden de index.html.

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
        textos.push(
            `Se compensan ${importe(s.compensadoAnteriores)} de pérdidas de ejercicios anteriores, y por eso el tipo efectivo baja.`
        )
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
