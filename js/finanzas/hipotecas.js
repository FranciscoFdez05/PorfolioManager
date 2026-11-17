// Ventana «Hipotecas»: listado, métricas, gráfico, Euríbor y amortizaciones.
//
// El cálculo lo hace el servidor (core/hipotecas.py): cada hipoteca llega con su
// `calculo` (resumen y cuadro). Aquí solo se pinta y se editan los datos de
// entrada; al guardar, el servidor devuelve el listado recalculado.

let _hipotecas = []
let _hipotecaIdSeleccionada = ""
let _hipotecasChart = null

async function hipotecasCargar() {
    const [respuesta] = await Promise.all([fetch("/api/hipotecas"), cargarCuentasDinero()])
    if (!respuesta.ok) throw new Error(await prestamoMensajeError(respuesta))
    const datos = await respuesta.json()
    _hipotecas = Array.isArray(datos.rows) ? datos.rows : []
}

// Guarda el listado completo. Los datos de entrada se reenvían sin `calculo`:
// es una salida del servidor y no debe volver como si fuera dato.
async function hipotecasGuardar(filas) {
    const cuerpo = filas.map(({ calculo, ...entrada }) => entrada)
    const respuesta = await fetch("/api/hipotecas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: cuerpo })
    })
    if (!respuesta.ok) throw new Error(await prestamoMensajeError(respuesta))
    const datos = await respuesta.json()
    _hipotecas = Array.isArray(datos.rows) ? datos.rows : []
}

async function hipotecasGuardarYPintar(filas, idASeleccionar) {
    try {
        await hipotecasGuardar(filas)
    } catch (error) {
        showError("No se pudo guardar la hipoteca", error)
        return false
    }
    if (idASeleccionar) _hipotecaIdSeleccionada = idASeleccionar
    hipotecasPintar()
    return true
}

function hipotecaActual() {
    return _hipotecas.find((h) => h.id === _hipotecaIdSeleccionada) || _hipotecas[0] || null
}

function hipotecasPintar() {
    const vacio = document.getElementById("hipotecasEmptyMsg")
    const contenido = document.getElementById("hipotecasContenido")
    const selector = document.getElementById("hipotecasSelector")
    if (!selector || !contenido) return

    const hayHipotecas = _hipotecas.length > 0
    vacio?.classList.toggle("hidden", hayHipotecas)
    contenido.classList.toggle("hidden", !hayHipotecas)
    selector.classList.toggle("hidden", !hayHipotecas)
    document.getElementById("hipotecasEditBtn")?.classList.toggle("hidden", !hayHipotecas)
    document.getElementById("hipotecasDeleteBtn")?.classList.toggle("hidden", !hayHipotecas)
    if (!hayHipotecas) {
        hipotecasDestruirGrafico()
        return
    }

    const actual = hipotecaActual()
    _hipotecaIdSeleccionada = actual.id
    selector.innerHTML = _hipotecas
        .map(
            (h) =>
                `<option value="${escapeAttr(h.id)}"${h.id === actual.id ? " selected" : ""}>${escapeHtml(h.alias)}</option>`
        )
        .join("")

    hipotecasPintarTotales()
    hipotecasPintarDetalle(actual)
}

function hipotecasPintarTotales() {
    const contenedor = document.getElementById("hipotecasTotales")
    if (!contenedor) return
    const conResumen = _hipotecas.filter((h) => h.calculo?.resumen)
    if (conResumen.length < 2) {
        contenedor.innerHTML = ""
        return
    }
    const suma = (clave) => conResumen.reduce((total, h) => total + h.calculo.resumen[clave], 0)
    contenedor.innerHTML = [
        prestamoTarjeta(
            "Deuda total pendiente",
            formatEuro(suma("capitalPendiente")),
            `${conResumen.length} hipotecas`
        ),
        prestamoTarjeta("Cuotas mensuales", formatEuro(suma("cuotaActual"))),
        prestamoTarjeta("Intereses pendientes", formatEuro(suma("interesesPendientes")))
    ].join("")
}

function hipotecasPintarDetalle(hipoteca) {
    const errorEl = document.getElementById("hipotecasError")
    const calculo = hipoteca.calculo || {}
    const hayCalculo = Boolean(calculo.resumen)

    if (errorEl) {
        errorEl.textContent = hayCalculo
            ? ""
            : `No se puede calcular esta hipoteca: ${calculo.error || "datos incompletos"}`
        errorEl.classList.toggle("hidden", hayCalculo)
    }
    document.getElementById("hipotecasPanelEuribor")?.classList.toggle("hidden", hipoteca.tipo !== "variable")

    if (!hayCalculo) {
        document.getElementById("hipotecasMetricas").innerHTML = ""
        document.getElementById("hipotecasCuadroBody").innerHTML = ""
        hipotecasDestruirGrafico()
    } else {
        hipotecasPintarMetricas(hipoteca, calculo.resumen)
        hipotecasPintarGrafico(calculo.cuadro)
        hipotecasPintarCuadro(calculo.cuadro)
    }
    hipotecasPintarEuribor(hipoteca)
    hipotecasPintarAmortizaciones(hipoteca)
}

function hipotecasPintarMetricas(hipoteca, resumen) {
    const barra = document.getElementById("hipotecasBarra")
    const porcentaje = Math.min(100, Math.max(0, resumen.porcentajeAmortizado))
    if (barra) barra.style.width = `${porcentaje}%`
    document.getElementById("hipotecasProgresoTexto").textContent =
        `${prestamoFormatoPorcentaje(resumen.porcentajeAmortizado)} amortizado · ${resumen.cuotasPagadas} de ${resumen.totalCuotas} cuotas`
    document.getElementById("hipotecasProgresoFin").textContent = resumen.liquidado
        ? "Hipoteca liquidada"
        : `Fin: ${prestamoFormatoFecha(resumen.fechaFin)} · quedan ${prestamoFormatoPlazo(resumen.cuotasRestantes)}`

    const etiquetaTipo = hipoteca.tipo === "variable" ? "Tipo actual" : "TIN"
    const tarjetas = [
        prestamoTarjeta(
            "Cuota actual",
            formatEuro(resumen.cuotaActual),
            resumen.proximaFecha ? `Próxima: ${prestamoFormatoFecha(resumen.proximaFecha)}` : ""
        ),
        prestamoTarjeta(
            etiquetaTipo,
            prestamoFormatoPorcentaje(resumen.tipoActual),
            hipoteca.tipo === "variable" ? "Euríbor + diferencial" : ""
        ),
        prestamoTarjeta("Capital pendiente", formatEuro(resumen.capitalPendiente)),
        prestamoTarjeta("Capital amortizado", formatEuro(resumen.capitalAmortizado)),
        prestamoTarjeta("Intereses pagados", formatEuro(resumen.interesesPagados)),
        prestamoTarjeta("Intereses pendientes", formatEuro(resumen.interesesPendientes)),
        prestamoTarjeta("Intereses totales", formatEuro(resumen.interesesTotales)),
        prestamoTarjeta(
            "Coste total",
            formatEuro(resumen.costeTotal),
            `Capital inicial ${formatEuro(parseEuroNumber(hipoteca.capital))}`
        ),
        prestamoTarjeta(
            "Cuotas restantes",
            String(resumen.cuotasRestantes),
            prestamoFormatoPlazo(resumen.cuotasRestantes)
        )
    ]
    if (resumen.ahorroIntereses > 0) {
        tarjetas.push(
            prestamoTarjeta(
                "Ahorro por amortizar",
                formatEuro(resumen.ahorroIntereses),
                "Intereses evitados",
                "positivo"
            )
        )
    }
    document.getElementById("hipotecasMetricas").innerHTML = tarjetas.join("")
}

function hipotecasDestruirGrafico() {
    if (_hipotecasChart) {
        _hipotecasChart.destroy()
        _hipotecasChart = null
    }
}

function hipotecasPintarGrafico(cuadro) {
    hipotecasDestruirGrafico()
    const lienzo = document.getElementById("hipotecasChart")
    if (!lienzo || typeof Chart === "undefined") return

    const porAnio = prestamoAgruparPorAnio(cuadro)
    const anios = [...porAnio.keys()]
    const tema = prestamoTemaGrafico()
    const eje = (posicion) => ({
        position: posicion,
        ticks: { color: tema.muted, font: { size: 11 }, callback: (v) => formatEuro(v) },
        grid: { color: tema.grid, drawOnChartArea: posicion === "left" }
    })

    _hipotecasChart = new Chart(lienzo, {
        data: {
            labels: anios,
            datasets: [
                {
                    type: "bar",
                    label: "Capital",
                    data: anios.map((a) => porAnio.get(a).capital),
                    backgroundColor: "#3498db",
                    stack: "pago",
                    yAxisID: "y"
                },
                {
                    type: "bar",
                    label: "Intereses",
                    data: anios.map((a) => porAnio.get(a).interes),
                    backgroundColor: "#e0c068",
                    stack: "pago",
                    yAxisID: "y"
                },
                {
                    type: "line",
                    label: "Capital pendiente",
                    data: anios.map((a) => porAnio.get(a).pendiente),
                    borderColor: "#2ecc71",
                    backgroundColor: "#2ecc7120",
                    tension: 0.3,
                    pointRadius: 2,
                    yAxisID: "y1"
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            plugins: {
                legend: { labels: { color: tema.text, font: { size: 12 }, padding: 12 } },
                tooltip: { callbacks: { label: (c) => `  ${c.dataset.label}: ${formatEuro(c.raw)}` } }
            },
            scales: {
                x: { stacked: true, ticks: { color: tema.muted, font: { size: 11 } }, grid: { color: tema.grid } },
                y: { ...eje("left"), stacked: true },
                y1: eje("right")
            }
        }
    })
}

function hipotecasPintarCuadro(cuadro) {
    const cuerpo = document.getElementById("hipotecasCuadroBody")
    if (!cuerpo) return
    cuerpo.innerHTML = cuadro
        .map(
            (r) => `<tr class="${r.pagado ? "pagado" : ""}">
                <td>${r.numero}</td><td>${prestamoFormatoFecha(r.fecha)}</td><td>${prestamoFormatoPorcentaje(r.tipo)}</td>
                <td>${formatEuro(r.cuota)}</td><td>${formatEuro(r.interes)}</td><td>${formatEuro(r.capital)}</td>
                <td>${r.extra ? formatEuro(r.extra) : ""}</td><td>${formatEuro(r.pendiente)}</td></tr>`
        )
        .join("")
    hipotecasCentrarCuadro(cuerpo)
}

// Deja a la vista las últimas cuotas pagadas y, debajo, la próxima y las futuras.
// Se recalcula en cada pintado, así que avanza solo al pasar los meses.
const HIPOTECAS_CUOTAS_PASADAS_VISIBLES = 3

function hipotecasCentrarCuadro(cuerpo) {
    const filas = [...cuerpo.rows]
    const primeraPendiente = filas.findIndex((fila) => !fila.classList.contains("pagado"))
    // Liquidada: se muestran las últimas; sin cuotas pagadas se queda arriba.
    const indiceProxima = primeraPendiente === -1 ? filas.length : primeraPendiente
    const filaInicio = filas[Math.max(0, indiceProxima - HIPOTECAS_CUOTAS_PASADAS_VISIBLES)]
    const contenedor = cuerpo.closest(".hipotecasCuadroWrapper")
    if (!filaInicio || !contenedor) return

    requestAnimationFrame(() => {
        const cabecera = contenedor.querySelector("thead")?.offsetHeight || 0
        const desplazamiento = filaInicio.getBoundingClientRect().top - contenedor.getBoundingClientRect().top
        contenedor.scrollTop += desplazamiento - cabecera
    })
}

function hipotecasPintarEuribor(hipoteca) {
    const cuerpo = document.getElementById("hipotecasEuriborBody")
    const vacio = document.getElementById("hipotecasEuriborVacio")
    if (!cuerpo) return
    const filas = hipoteca.euribor || []
    vacio?.classList.toggle("hidden", filas.length > 0)
    cuerpo.innerHTML = filas
        .map(
            (fila, indice) => `<tr>
                <td>${prestamoFormatoFecha(fila.fecha)}</td><td>${prestamoFormatoPorcentaje(fila.valor)}</td>
                <td class="acciones"><button type="button" class="hipotecasLinkBtn" data-quitar-euribor="${indice}">Quitar</button></td></tr>`
        )
        .join("")
    cuerpo
        .querySelectorAll("[data-quitar-euribor]")
        .forEach((boton) =>
            boton.addEventListener("click", () =>
                hipotecasQuitarDeLista("euribor", Number(boton.dataset.quitarEuribor))
            )
        )
}

function hipotecasPintarAmortizaciones(hipoteca) {
    const cuerpo = document.getElementById("hipotecasAmortBody")
    const vacio = document.getElementById("hipotecasAmortVacio")
    if (!cuerpo) return
    const filas = hipoteca.amortizaciones || []
    vacio?.classList.toggle("hidden", filas.length > 0)
    cuerpo.innerHTML = filas
        .map(
            (fila, indice) => `<tr>
                <td>${prestamoFormatoFecha(fila.fecha)}</td><td>${formatEuro(parseEuroNumber(fila.importe))}</td>
                <td>${fila.modo === "cuota" ? "Reduce la cuota" : "Reduce el plazo"}</td>
                <td class="acciones"><button type="button" class="hipotecasLinkBtn" data-quitar-amort="${indice}">Quitar</button></td></tr>`
        )
        .join("")
    cuerpo
        .querySelectorAll("[data-quitar-amort]")
        .forEach((boton) =>
            boton.addEventListener("click", () =>
                hipotecasQuitarDeLista("amortizaciones", Number(boton.dataset.quitarAmort))
            )
        )
}

async function hipotecasQuitarDeLista(clave, indice) {
    const actual = hipotecaActual()
    if (!actual) return
    const nueva = { ...actual, [clave]: actual[clave].filter((_, i) => i !== indice) }
    await hipotecasGuardarYPintar(_hipotecas.map((h) => (h.id === actual.id ? nueva : h)))
}

// Modal genérico: construye el overlay, enlaza Cancelar/Guardar y deja que
// `alGuardar` devuelva true para cerrar o false para dejarlo abierto.
function hipotecasAbrirModal(titulo, camposHtml, alGuardar) {
    const overlay = document.createElement("div")
    overlay.className = "modalOverlay"
    overlay.style.zIndex = "20000"
    const modal = document.createElement("div")
    modal.className = "assetModal"
    modal.innerHTML = `
        <h3 class="assetModalTitle">${escapeHtml(titulo)}</h3>
        ${camposHtml}
        <div class="assetModalActions">
            <button type="button" data-accion="cancelar" class="cancelButton">Cancelar</button>
            <button type="button" data-accion="guardar" class="primaryButton" data-no-autohide="true">Guardar</button>
        </div>`
    const cerrar = () => overlay.remove()
    modal.querySelector('[data-accion="cancelar"]').addEventListener("click", cerrar)
    modal.querySelector('[data-accion="guardar"]').addEventListener("click", async () => {
        if (await alGuardar(modal)) cerrar()
    })
    ponerModalEnDosColumnas(modal)
    prestamoActivarCalendarios(modal)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
    return modal
}

function hipotecasValor(modal, id) {
    return modal.querySelector(`#${id}`).value.trim()
}

function hipotecasAbrirFormulario(hipoteca = null) {
    const datos = hipoteca || { tipo: "fija", revisionMeses: 12 }
    const campo = (id, etiqueta, valor, extra = "") =>
        `<label class="assetModalLabel" for="${id}">${etiqueta}</label><input id="${id}" class="assetModalInput" type="text" value="${escapeAttr(valor ?? "")}" ${extra}>`
    const modal = hipotecasAbrirModal(
        hipoteca ? "Editar hipoteca" : "Nueva hipoteca",
        `
        ${campo("hipAlias", "Nombre", datos.alias, 'placeholder="Ej: Vivienda habitual"')}
        <label class="assetModalLabel" for="hipTipo">Tipo</label>
        <select id="hipTipo" class="assetModalSelect">
            <option value="fija"${datos.tipo === "fija" ? " selected" : ""}>Plazo fijo</option>
            <option value="variable"${datos.tipo === "variable" ? " selected" : ""}>Plazo variable</option>
        </select>
        ${campo("hipCapital", "Capital prestado (€)", datos.capital, 'inputmode="decimal" placeholder="200000"')}
        <label class="assetModalLabel" for="hipFecha">Fecha de inicio</label>
        <input id="hipFecha" class="assetModalInput" type="date" value="${escapeAttr(datos.fechaInicio || "")}">
        ${campo("hipPlazo", "Plazo (meses)", datos.plazoMeses, 'inputmode="numeric" placeholder="360"')}
        ${campo("hipTin", "TIN / tipo inicial (%)", datos.tin, 'inputmode="decimal" placeholder="3,00"')}
        ${campo("hipDif", "Diferencial (%) — variable", datos.diferencial, 'inputmode="decimal" placeholder="0,99"')}
        <label class="assetModalLabel" for="hipRevision">Revisión — variable</label>
        <select id="hipRevision" class="assetModalSelect">
            <option value="12"${Number(datos.revisionMeses) === 12 ? " selected" : ""}>Anual</option>
            <option value="6"${Number(datos.revisionMeses) === 6 ? " selected" : ""}>Semestral</option>
        </select>
        <label class="assetModalLabel" for="hipCuenta">Cuenta de cobro</label>
        ${construirSelectorCuenta("hipCuenta", datos.cuenta || "")}
        ${campo("hipDiaCobro", "Día de cobro (vacío = el del inicio)", datos.diaCobro, 'inputmode="numeric" placeholder="1-31"')}
        ${campo("hipCategoria", "Categoría", datos.categoria, 'list="hipCategoriasLista" placeholder="Ej: Vivienda"')}
        <datalist id="hipCategoriasLista">${[...new Set(_hipotecas.map((h) => h.categoria).filter(Boolean))].map((c) => `<option value="${escapeAttr(c)}">`).join("")}</datalist>
        ${campo("hipNota", "Nota", datos.nota)}`,
        async (m) => {
            const tipo = hipotecasValor(m, "hipTipo")
            const nueva = {
                id: hipoteca?.id || "",
                alias: hipotecasValor(m, "hipAlias"),
                tipo,
                capital: hipotecasValor(m, "hipCapital"),
                fechaInicio: hipotecasValor(m, "hipFecha"),
                plazoMeses: hipotecasValor(m, "hipPlazo"),
                tin: hipotecasValor(m, "hipTin"),
                diferencial: tipo === "variable" ? hipotecasValor(m, "hipDif") : "0",
                revisionMeses: Number(hipotecasValor(m, "hipRevision")),
                euribor: hipoteca?.euribor || [],
                amortizaciones: hipoteca?.amortizaciones || [],
                cuenta: hipotecasValor(m, "hipCuenta"),
                diaCobro: hipotecasValor(m, "hipDiaCobro"),
                categoria: hipotecasValor(m, "hipCategoria"),
                nota: hipotecasValor(m, "hipNota")
            }
            const lista = hipoteca ? _hipotecas.map((h) => (h.id === hipoteca.id ? nueva : h)) : [..._hipotecas, nueva]
            const antes = new Set(_hipotecas.map((h) => h.id))
            const guardada = await hipotecasGuardarYPintar(lista, hipoteca?.id)
            if (guardada && !hipoteca) {
                // Una hipoteca nueva nace sin id: se selecciona la que no estaba antes.
                const alta = _hipotecas.find((h) => !antes.has(h.id))
                if (alta) {
                    _hipotecaIdSeleccionada = alta.id
                    hipotecasPintar()
                }
            }
            return guardada
        }
    )
    const alternarVariable = () => {
        const esVariable = modal.querySelector("#hipTipo").value === "variable"
        ;["hipDif", "hipRevision"].forEach((id) => {
            const control = modal.querySelector(`#${id}`)
            control.disabled = !esVariable
            control.closest(".modalCampo")?.classList.toggle("hidden", !esVariable)
        })
    }
    modal.querySelector("#hipTipo").addEventListener("change", alternarVariable)
    alternarVariable()
}

function hipotecasAbrirEuribor() {
    const actual = hipotecaActual()
    if (!actual) return
    hipotecasAbrirModal(
        "Nueva revisión de Euríbor",
        `<label class="assetModalLabel" for="eurFecha">Fecha de la revisión</label>
         <input id="eurFecha" class="assetModalInput" type="date">
         <label class="assetModalLabel" for="eurValor">Euríbor aplicado (%)</label>
         <input id="eurValor" class="assetModalInput" type="text" inputmode="decimal" placeholder="2,50">`,
        async (m) => {
            const nueva = {
                ...actual,
                euribor: [
                    ...actual.euribor,
                    { fecha: hipotecasValor(m, "eurFecha"), valor: hipotecasValor(m, "eurValor") }
                ]
            }
            return hipotecasGuardarYPintar(_hipotecas.map((h) => (h.id === actual.id ? nueva : h)))
        }
    )
}

function hipotecasAbrirAmortizacion() {
    const actual = hipotecaActual()
    if (!actual) return
    hipotecasAbrirModal(
        "Nueva amortización anticipada",
        `<label class="assetModalLabel" for="amFecha">Fecha</label>
         <input id="amFecha" class="assetModalInput" type="date">
         <label class="assetModalLabel" for="amImporte">Importe (€)</label>
         <input id="amImporte" class="assetModalInput" type="text" inputmode="decimal" placeholder="10000">
         <label class="assetModalLabel" for="amModo">Efecto</label>
         <select id="amModo" class="assetModalSelect">
             <option value="plazo">Reducir el plazo (mantiene la cuota)</option>
             <option value="cuota">Reducir la cuota (mantiene el plazo)</option>
         </select>`,
        async (m) => {
            const nueva = {
                ...actual,
                amortizaciones: [
                    ...actual.amortizaciones,
                    {
                        fecha: hipotecasValor(m, "amFecha"),
                        importe: hipotecasValor(m, "amImporte"),
                        modo: hipotecasValor(m, "amModo")
                    }
                ]
            }
            return hipotecasGuardarYPintar(_hipotecas.map((h) => (h.id === actual.id ? nueva : h)))
        }
    )
}

function hipotecasConfirmarBorrado() {
    const actual = hipotecaActual()
    if (!actual) return
    openConfirmModal({
        title: "Eliminar hipoteca",
        message: `¿Quieres eliminar «${actual.alias}» con sus revisiones y amortizaciones? También se quitan sus cuotas de Mensualidades.`,
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            _hipotecaIdSeleccionada = ""
            await hipotecasGuardarYPintar(_hipotecas.filter((h) => h.id !== actual.id))
        }
    })
}

// Simulación: consulta al servidor el efecto de un pago anticipado hipotético
// sobre la hipoteca seleccionada. No guarda nada.
function hipotecasSimuladorLimpiar() {
    document.getElementById("hipotecasSimuladorTabla")?.classList.add("hidden")
    const errorEl = document.getElementById("hipotecasSimuladorError")
    errorEl?.classList.add("hidden")
}

function hipotecasSimuladorFilas(r) {
    const { actual, plazo, cuota } = r
    const ahorro = (e) => formatEuro(e.ahorroIntereses)
    const fila = (titulo, celdas) =>
        `<tr><td>${escapeHtml(titulo)}</td>${celdas.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`
    return [
        fila(
            "Cuota tras el pago",
            [actual, plazo, cuota].map((e) => formatEuro(e.cuotaTrasElPago))
        ),
        fila(
            "Cuotas restantes",
            [actual, plazo, cuota].map((e) => prestamoFormatoPlazo(e.cuotasRestantes))
        ),
        fila(
            "Fecha de fin",
            [actual, plazo, cuota].map((e) => prestamoFormatoFecha(e.fechaFin))
        ),
        fila(
            "Intereses pendientes",
            [actual, plazo, cuota].map((e) => formatEuro(e.interesesPendientes))
        ),
        fila("Intereses ahorrados", ["", ahorro(plazo), ahorro(cuota)]),
        fila("Meses ahorrados", ["", String(plazo.mesesAhorrados), String(cuota.mesesAhorrados)])
    ].join("")
}

async function hipotecasSimular(evento) {
    evento.preventDefault()
    const actual = hipotecaActual()
    const errorEl = document.getElementById("hipotecasSimuladorError")
    const tabla = document.getElementById("hipotecasSimuladorTabla")
    if (!actual || !errorEl || !tabla) return
    errorEl.classList.add("hidden")
    try {
        const respuesta = await fetch(`/api/hipotecas/${encodeURIComponent(actual.id)}/simulacion`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                importe: hipotecasValor(document, "hipSimImporte"),
                fecha: hipotecasValor(document, "hipSimFecha")
            })
        })
        if (!respuesta.ok) throw new Error(await prestamoMensajeError(respuesta))
        document.getElementById("hipotecasSimuladorBody").innerHTML = hipotecasSimuladorFilas(await respuesta.json())
        tabla.classList.remove("hidden")
    } catch (error) {
        tabla.classList.add("hidden")
        errorEl.textContent = error.message
        errorEl.classList.remove("hidden")
    }
}

async function initHipotecasLogic() {
    window.flushPendingPageChanges = null
    _hipotecaIdSeleccionada = ""
    hipotecasDestruirGrafico()
    try {
        await hipotecasCargar()
    } catch (error) {
        _hipotecas = []
        showError("No se pudieron cargar las hipotecas", error)
    }
    hipotecasPintar()

    document.getElementById("hipotecasSelector")?.addEventListener("change", (evento) => {
        _hipotecaIdSeleccionada = evento.target.value
        hipotecasSimuladorLimpiar()
        hipotecasPintar()
    })
    document.getElementById("hipotecasAddBtn")?.addEventListener("click", () => hipotecasAbrirFormulario())
    document
        .getElementById("hipotecasEditBtn")
        ?.addEventListener("click", () => hipotecasAbrirFormulario(hipotecaActual()))
    document.getElementById("hipotecasDeleteBtn")?.addEventListener("click", hipotecasConfirmarBorrado)
    document.getElementById("hipotecasAddEuriborBtn")?.addEventListener("click", hipotecasAbrirEuribor)
    document.getElementById("hipotecasAddAmortBtn")?.addEventListener("click", hipotecasAbrirAmortizacion)
    const simuladorForm = document.getElementById("hipotecasSimuladorForm")
    simuladorForm?.addEventListener("submit", hipotecasSimular)
    if (simuladorForm) prestamoActivarCalendarios(simuladorForm)
}
