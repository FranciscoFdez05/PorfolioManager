// Ventana «Microcréditos»: vencimientos, coste real y TAE equivalente de los
// préstamos pequeños y de corta duración.
//
// El cálculo lo hace el servidor (core/microcreditos.py): cada microcrédito llega
// con su `calculo`. Aquí se pinta y se editan los datos de entrada. Hay dos
// modos: «unico» (se devuelve de una vez al vencimiento, con comisión) y
// «cuotas» (cuotas mensuales a tipo fijo). Cada pago se cobra como una
// mensualidad (stores/deudas_mensualidades.py): la cuenta, el día y la categoría
// que se eligen aquí son los que descuentan en Gastos y cuentan en Ahorro.

let _microcreditos = []

// Ventana de «Próximos vencimientos»: lo que hay que devolver en este plazo.
const microcreditosDiasProximos = 45
const microcreditosMaxProximos = 8

const microcreditosEtiquetaEstado = { activo: "Activo", vencido: "Vencido", devuelto: "Devuelto" }

async function microcreditosCargar() {
    const [respuesta] = await Promise.all([fetch("/api/microcreditos"), cargarCuentasDinero()])
    if (!respuesta.ok) throw new Error(await prestamoMensajeError(respuesta))
    const datos = await respuesta.json()
    _microcreditos = Array.isArray(datos.rows) ? datos.rows : []
}

// Guarda el listado completo; `calculo` es salida del servidor y no se reenvía.
async function microcreditosGuardar(filas) {
    const cuerpo = filas.map(microcreditosEntrada)
    const respuesta = await fetch("/api/microcreditos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: cuerpo })
    })
    if (!respuesta.ok) throw new Error(await prestamoMensajeError(respuesta))
    const datos = await respuesta.json()
    _microcreditos = Array.isArray(datos.rows) ? datos.rows : []
}

async function microcreditosGuardarYPintar(filas) {
    try {
        await microcreditosGuardar(filas)
    } catch (error) {
        showError("No se pudo guardar el microcrédito", error)
        return false
    }
    microcreditosPintar()
    return true
}

// Quita `calculo` y deja solo los datos de entrada.
function microcreditosEntrada(microcredito) {
    const { calculo, ...entrada } = microcredito
    return entrada
}

function microcreditosResumen(microcredito) {
    return microcredito.calculo?.resumen || null
}

function microcreditosVisibles() {
    const mostrarTodos = document.getElementById("microcreditosMostrarDevueltos")?.checked
    return _microcreditos.filter((m) => mostrarTodos || !microcreditosResumen(m)?.liquidado)
}

function microcreditosPendientes() {
    return _microcreditos.filter((m) => {
        const resumen = microcreditosResumen(m)
        return resumen && !resumen.liquidado
    })
}

function microcreditosTextoDias(dias) {
    if (dias < 0) return `hace ${-dias} d`
    if (dias === 0) return "hoy"
    return dias === 1 ? "mañana" : `en ${dias} d`
}

function microcreditosBadge(estado) {
    return `<span class="microcreditosBadge ${escapeAttr(estado)}">${escapeHtml(microcreditosEtiquetaEstado[estado] || estado)}</span>`
}

function microcreditosChipsHtml(microcredito) {
    const resumen = microcreditosResumen(microcredito)
    const modo = microcredito.modo === "cuotas" ? `${microcredito.cuotas} cuotas` : "Pago único"
    const plazo =
        resumen && resumen.plazoDias != null ? `<span class="microcreditosChip">${resumen.plazoDias} días</span>` : ""
    return `<span class="microcreditosChip">${escapeHtml(modo)}</span>${plazo}`
}

function microcreditosPintar() {
    const cuerpo = document.getElementById("microcreditosBody")
    if (!cuerpo) return

    const visibles = microcreditosVisibles()
    document.getElementById("microcreditosEmptyMsg")?.classList.toggle("hidden", visibles.length > 0)
    // Se oculta el panel entero: solo con la tabla escondida quedaba un recuadro vacío.
    document.getElementById("microcreditosPanel")?.classList.toggle("hidden", visibles.length === 0)

    cuerpo.innerHTML = visibles.map(microcreditosFila).join("")
    cuerpo
        .querySelectorAll("[data-editar]")
        .forEach((boton) =>
            boton.addEventListener("click", () =>
                microcreditosAbrirFormulario(_microcreditos.find((m) => m.id === boton.dataset.editar))
            )
        )
    cuerpo
        .querySelectorAll("[data-eliminar]")
        .forEach((boton) =>
            boton.addEventListener("click", () => microcreditosConfirmarBorrado(boton.dataset.eliminar))
        )
    cuerpo
        .querySelectorAll("[data-devolver]")
        .forEach((boton) => boton.addEventListener("click", () => microcreditosMarcarDevuelto(boton.dataset.devolver)))
    cuerpo.querySelectorAll("tr[data-detalle]").forEach((fila) =>
        fila.addEventListener("click", (evento) => {
            if (evento.target.closest(".acciones")) return
            microcreditosAbrirDetalle(fila.dataset.detalle)
        })
    )
    const pendientes = microcreditosPendientes()
    microcreditosPintarTotales(pendientes)
    microcreditosPintarProximos(pendientes)
}

function microcreditosPintarTotales(pendientes) {
    const contenedor = document.getElementById("microcreditosTotales")
    if (!contenedor) return
    if (!_microcreditos.length) {
        contenedor.innerHTML = ""
        return
    }
    const suma = (campo) => pendientes.reduce((total, m) => total + (microcreditosResumen(m)[campo] || 0), 0)
    const vencidos = pendientes.filter((m) => microcreditosResumen(m).estado === "vencido")
    const proximos = pendientes
        .filter((m) => microcreditosResumen(m).proximaFecha)
        .sort((a, b) => microcreditosResumen(a).proximaFecha.localeCompare(microcreditosResumen(b).proximaFecha))
    const primero = proximos[0]
    const resumenPrimero = primero ? microcreditosResumen(primero) : null
    const costeTotal = _microcreditos.reduce((total, m) => total + (microcreditosResumen(m)?.coste || 0), 0)

    contenedor.innerHTML = [
        prestamoTarjeta("Activos", String(pendientes.length), `${_microcreditos.length - pendientes.length} devueltos`),
        prestamoTarjeta("Pendiente de devolver", formatEuro(suma("pendiente"))),
        prestamoTarjeta(
            "Próximo vencimiento",
            resumenPrimero ? prestamoFormatoFecha(resumenPrimero.proximaFecha) : "—",
            resumenPrimero ? `${primero.nombre} · ${formatEuro(resumenPrimero.proximoImporte)}` : ""
        ),
        prestamoTarjeta(
            "Vencidos sin devolver",
            String(vencidos.length),
            vencidos.length
                ? formatEuro(vencidos.reduce((total, m) => total + microcreditosResumen(m).pendiente, 0))
                : "ninguno",
            vencidos.length ? "negativo" : ""
        ),
        prestamoTarjeta("Coste total", formatEuro(costeTotal), "comisiones e intereses, todos los créditos")
    ].join("")
}

// Lo que vence en las próximas semanas (o ya venció), para verlo de un vistazo.
function microcreditosPintarProximos(pendientes) {
    const contenedor = document.getElementById("microcreditosProximos")
    if (!contenedor) return

    const avisos = pendientes
        .filter(
            (m) =>
                microcreditosResumen(m).proximaFecha &&
                microcreditosResumen(m).diasRestantes <= microcreditosDiasProximos
        )
        .sort((a, b) => microcreditosResumen(a).proximaFecha.localeCompare(microcreditosResumen(b).proximaFecha))

    contenedor.classList.toggle("hidden", avisos.length === 0)
    if (!avisos.length) {
        contenedor.innerHTML = ""
        return
    }

    const total = avisos.reduce((suma, m) => suma + microcreditosResumen(m).proximoImporte, 0)
    contenedor.innerHTML = `
        <div class="microcreditosProximosCabecera">
            <span class="microcreditosProximosTitulo">Próximos vencimientos</span>
            <span class="microcreditosProximosTotal">${avisos.length} en ${microcreditosDiasProximos} días · ${escapeHtml(formatEuro(total))}</span>
        </div>
        <ul class="microcreditosProximosLista">
            ${avisos
                .slice(0, microcreditosMaxProximos)
                .map((m) => {
                    const resumen = microcreditosResumen(m)
                    const detalle = m.modo === "cuotas" ? "próxima cuota" : "devolución total"
                    return `<li class="microcreditosProximosItem ${resumen.estado === "vencido" ? "vencido" : ""}">
                        <span class="microcreditosProximosFecha">${escapeHtml(prestamoFormatoFecha(resumen.proximaFecha))}<small>${escapeHtml(microcreditosTextoDias(resumen.diasRestantes))}</small></span>
                        <span class="microcreditosProximosNombre">${escapeHtml(m.nombre)}<small>${escapeHtml(detalle)}</small></span>
                        <span class="microcreditosProximosImporte">${escapeHtml(formatEuro(resumen.proximoImporte))}</span>
                    </li>`
                })
                .join("")}
        </ul>`
}

function microcreditosFila(microcredito) {
    const resumen = microcreditosResumen(microcredito)
    const puedeDevolver = microcredito.modo === "unico" && resumen && !resumen.liquidado
    const acciones = `<td class="acciones">
        ${puedeDevolver ? `<button type="button" class="hipotecasLinkBtn" data-devolver="${escapeAttr(microcredito.id)}">Marcar devuelto</button>` : ""}
        <button type="button" class="hipotecasLinkBtn" data-editar="${escapeAttr(microcredito.id)}">Editar</button>
        <button type="button" class="hipotecasLinkBtn" data-eliminar="${escapeAttr(microcredito.id)}">Eliminar</button></td>`
    if (!resumen) {
        return `<tr><td>${escapeHtml(microcredito.nombre)}</td><td colspan="8">${escapeHtml(microcredito.calculo?.error || "No se puede calcular")}</td>${acciones}</tr>`
    }
    const progreso = Math.min(100, Math.max(0, resumen.progreso))
    const sub = resumen.liquidado
        ? ""
        : `<span class="microcreditosSub">${escapeHtml(microcreditosTextoDias(resumen.diasRestantes))}</span>`
    return `<tr class="microcreditosFila ${resumen.liquidado ? "pagado" : ""}" data-detalle="${escapeAttr(microcredito.id)}" title="Ver detalle">
        <td>${escapeHtml(microcredito.nombre)}<span class="microcreditosChips">${microcreditosChipsHtml(microcredito)}</span></td>
        <td>${formatEuro(resumen.importe)}</td>
        <td>${formatEuro(resumen.coste)}</td>
        <td>${resumen.tae == null ? "—" : prestamoFormatoPorcentaje(resumen.tae)}</td>
        <td>${prestamoFormatoFecha(resumen.fechaVencimiento)}${sub}</td>
        <td>${microcreditosBadge(resumen.estado)}</td>
        <td>${formatEuro(resumen.pendiente)}</td>
        <td><div class="hipotecasBarra microcreditosBarra" title="${prestamoFormatoPorcentaje(progreso)}"><div class="hipotecasBarraRelleno" style="width:${progreso}%"></div></div></td>
        ${acciones}</tr>`
}

async function microcreditosMarcarDevuelto(id) {
    const hoy = new Date().toISOString().slice(0, 10)
    await microcreditosGuardarYPintar(
        _microcreditos.map((m) =>
            m.id === id ? { ...microcreditosEntrada(m), devuelto: true, fechaDevolucion: hoy } : m
        )
    )
}

function microcreditosAbrirFormulario(microcredito = null) {
    const datos = microcredito || { modo: "unico" }
    const campo = (id, etiqueta, valor, extra = "") =>
        `<label class="assetModalLabel" for="${id}">${etiqueta}</label><input id="${id}" class="assetModalInput" type="text" value="${escapeAttr(valor ?? "")}" ${extra}>`
    const fecha = (id, etiqueta, valor) =>
        `<label class="assetModalLabel" for="${id}">${etiqueta}</label><input id="${id}" class="assetModalInput" type="date" value="${escapeAttr(valor || "")}">`

    return hipotecasAbrirModal(
        microcredito ? "Editar microcrédito" : "Nuevo microcrédito",
        `
        ${campo("mcNombre", "Entidad o nombre", datos.nombre, 'placeholder="Ej: Crédito rápido"')}
        <label class="assetModalLabel" for="mcModo">Modalidad</label>
        <select id="mcModo" class="assetModalSelect">
            <option value="unico"${datos.modo !== "cuotas" ? " selected" : ""}>Pago único</option>
            <option value="cuotas"${datos.modo === "cuotas" ? " selected" : ""}>En cuotas mensuales</option>
        </select>
        ${campo("mcImporte", "Importe recibido (€)", datos.importe, 'inputmode="decimal" placeholder="300"')}
        ${fecha("mcInicio", "Fecha de concesión", datos.fechaInicio)}
        ${campo("mcComision", "Comisión total (€) — pago único", datos.modo === "unico" ? datos.comision : "", 'inputmode="decimal" placeholder="45"')}
        ${fecha("mcVencimiento", "Vencimiento — pago único", datos.fechaVencimiento)}
        ${campo("mcCuotas", "Nº de cuotas (meses) — en cuotas", datos.cuotas || "", 'inputmode="numeric" placeholder="6"')}
        ${campo("mcTin", "TIN (%) — en cuotas", datos.modo === "cuotas" ? datos.tin : "", 'inputmode="decimal" placeholder="0"')}
        <label class="assetModalLabel" for="mcDevuelto">Devolución — pago único</label>
        <select id="mcDevuelto" class="assetModalSelect">
            <option value="no"${datos.devuelto ? "" : " selected"}>Pendiente de devolver</option>
            <option value="si"${datos.devuelto ? " selected" : ""}>Ya devuelto</option>
        </select>
        ${fecha("mcDevolucion", "Fecha de devolución — si ya devuelto", datos.fechaDevolucion)}
        <label class="assetModalLabel" for="mcCuenta">Cuenta de cobro</label>
        ${construirSelectorCuenta("mcCuenta", datos.cuenta || "")}
        ${campo("mcDiaCobro", "Día de cobro — en cuotas (vacío = el de la concesión)", datos.diaCobro, 'inputmode="numeric" placeholder="1-31"')}
        ${campo("mcCategoria", "Categoría", datos.categoria, 'list="mcCategoriasLista" placeholder="Ej: Deudas"')}
        <datalist id="mcCategoriasLista">${[...new Set(_microcreditos.map((m) => m.categoria).filter(Boolean))].map((c) => `<option value="${escapeAttr(c)}">`).join("")}</datalist>
        ${campo("mcNota", "Nota", datos.nota)}`,
        async (modal) => {
            const valor = (id) => hipotecasValor(modal, id)
            const nuevo = {
                id: microcredito?.id || "",
                nombre: valor("mcNombre"),
                modo: valor("mcModo"),
                importe: valor("mcImporte"),
                fechaInicio: valor("mcInicio"),
                comision: valor("mcComision") || "0",
                fechaVencimiento: valor("mcVencimiento"),
                cuotas: valor("mcCuotas"),
                tin: valor("mcTin") || "0",
                devuelto: valor("mcDevuelto") === "si",
                fechaDevolucion: valor("mcDevolucion"),
                cuenta: valor("mcCuenta"),
                diaCobro: valor("mcDiaCobro"),
                categoria: valor("mcCategoria"),
                nota: valor("mcNota")
            }
            const lista = microcredito
                ? _microcreditos.map((m) => (m.id === microcredito.id ? nuevo : m))
                : [..._microcreditos, nuevo]
            return microcreditosGuardarYPintar(lista)
        }
    )
}

function microcreditosConfirmarBorrado(id) {
    const microcredito = _microcreditos.find((m) => m.id === id)
    if (!microcredito) return
    openConfirmModal({
        title: "Eliminar microcrédito",
        message: `¿Quieres eliminar «${microcredito.nombre}»? También se quitan sus pagos de Mensualidades.`,
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            await microcreditosGuardarYPintar(_microcreditos.filter((m) => m.id !== id))
        }
    })
}

// ── Detalle ─────────────────────────────────────────────────────────────────

function microcreditosFilaCuadro(recibo, numeroProxima) {
    const clases = [recibo.pagado ? "pagado" : "", recibo.numero === numeroProxima ? "microcreditosProxima" : ""]
        .filter(Boolean)
        .join(" ")
    const estado = recibo.pagado ? "Pagada" : recibo.numero === numeroProxima ? "Próxima" : "Pendiente"
    return `<tr class="${clases}">
        <td>${recibo.numero}</td>
        <td>${escapeHtml(prestamoFormatoFecha(recibo.fecha))}</td>
        <td>${escapeHtml(formatEuro(recibo.cuota))}</td>
        <td>${escapeHtml(formatEuro(recibo.interes))}</td>
        <td>${escapeHtml(formatEuro(recibo.capital))}</td>
        <td>${escapeHtml(formatEuro(recibo.pendiente))}</td>
        <td>${estado}</td></tr>`
}

function microcreditosTarjetasDetalle(microcredito, resumen) {
    const tarjetas = [
        prestamoTarjeta("Importe recibido", formatEuro(resumen.importe)),
        prestamoTarjeta("Coste", formatEuro(resumen.coste), microcredito.modo === "cuotas" ? "intereses" : "comisión"),
        prestamoTarjeta("Total a devolver", formatEuro(resumen.totalAPagar)),
        prestamoTarjeta("Devuelto", formatEuro(resumen.pagado)),
        prestamoTarjeta("Pendiente", formatEuro(resumen.pendiente)),
        prestamoTarjeta("TAE equivalente", resumen.tae == null ? "—" : prestamoFormatoPorcentaje(resumen.tae))
    ]
    if (microcredito.modo === "cuotas") {
        tarjetas.splice(2, 0, prestamoTarjeta("Cuota mensual", formatEuro(resumen.cuotaMensual)))
    } else {
        tarjetas.push(prestamoTarjeta("Plazo", `${resumen.plazoDias} días`))
    }
    return tarjetas.join("")
}

function microcreditosAbrirDetalle(id) {
    const microcredito = _microcreditos.find((m) => m.id === id)
    const resumen = microcredito && microcreditosResumen(microcredito)
    if (!resumen) return

    const progreso = Math.min(100, Math.max(0, resumen.progreso))
    const cuadro = microcredito.calculo.cuadro
    const proxima = cuadro.find((recibo) => !recibo.pagado)
    const textoProgreso =
        microcredito.modo === "cuotas"
            ? `${resumen.cuotasPagadas} de ${resumen.totalCuotas} cuotas`
            : resumen.liquidado
              ? "Devuelto"
              : `${prestamoFormatoFecha(microcredito.fechaInicio)} a ${prestamoFormatoFecha(resumen.fechaVencimiento)}`
    const textoEstado = resumen.liquidado ? "Liquidado" : microcreditosTextoDias(resumen.diasRestantes)

    const overlay = document.createElement("div")
    overlay.className = "modalOverlay"
    overlay.style.zIndex = "20000"
    const modal = document.createElement("div")
    modal.className = "assetModal microcreditosDetalle"
    modal.innerHTML = `
        <h3 class="assetModalTitle">${escapeHtml(microcredito.nombre)}</h3>
        <div class="microcreditosChips">${microcreditosBadge(resumen.estado)}${microcreditosChipsHtml(microcredito)}</div>
        ${microcredito.nota ? `<p class="hipotecasVacio">${escapeHtml(microcredito.nota)}</p>` : ""}
        <div class="hipotecasMetricas">${microcreditosTarjetasDetalle(microcredito, resumen)}</div>
        <div class="microcreditosProgresoTexto"><span>${escapeHtml(textoProgreso)}</span><span>${escapeHtml(textoEstado)}</span></div>
        <div class="hipotecasBarra"><div class="hipotecasBarraRelleno" style="width:${progreso}%"></div></div>
        ${
            cuadro.length
                ? `<h4 class="microcreditosSeccionTitulo">Calendario de cuotas</h4>
        <div class="hipotecasCuadroWrapper">
            <table class="hipotecasTabla hipotecasCuadro">
                <thead><tr><th>Nº</th><th>Fecha</th><th>Cuota</th><th>Intereses</th><th>Capital</th><th>Pendiente</th><th>Estado</th></tr></thead>
                <tbody>${cuadro.map((recibo) => microcreditosFilaCuadro(recibo, proxima?.numero)).join("")}</tbody>
            </table>
        </div>`
                : ""
        }
        <div class="assetModalActions">
            <button type="button" data-accion="cerrar" class="cancelButton">Cerrar</button>
        </div>`

    const cerrar = () => overlay.remove()
    overlay.addEventListener("click", (evento) => {
        if (evento.target === overlay) cerrar()
    })
    modal.querySelector('[data-accion="cerrar"]').addEventListener("click", cerrar)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
    modal.querySelector(".microcreditosProxima")?.scrollIntoView({ block: "center" })
}

async function initMicrocreditosLogic() {
    window.flushPendingPageChanges = null
    try {
        await microcreditosCargar()
    } catch (error) {
        _microcreditos = []
        showError("No se pudieron cargar los microcréditos", error)
    }
    microcreditosPintar()

    document.getElementById("microcreditosAddBtn")?.addEventListener("click", () => microcreditosAbrirFormulario())
    document.getElementById("microcreditosMostrarDevueltos")?.addEventListener("change", microcreditosPintar)
}
