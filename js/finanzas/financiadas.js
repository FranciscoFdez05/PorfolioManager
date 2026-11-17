// Ventana «Compras financiadas»: cuotas, próximos cobros y detalle de cada compra.
//
// El cálculo lo hace el servidor (core/financiaciones.py): cada compra llega con
// su `calculo`. Aquí se pinta y se editan los datos de entrada. Cada compra se
// cobra como una mensualidad (stores/financiaciones_mensualidades.py), así que
// la cuenta y el día de cobro que se eligen aquí son los que descuentan.

let _financiadas = []

// Ventana de «Próximos cobros»: lo que se va a cargar en este plazo.
const FINANCIADAS_DIAS_PROXIMOS = 45
const FINANCIADAS_MAX_PROXIMOS = 8

async function financiadasCargar() {
    const [respuesta] = await Promise.all([fetch("/api/financiaciones"), cargarCuentasDinero()])
    if (!respuesta.ok) throw new Error(await prestamoMensajeError(respuesta))
    const datos = await respuesta.json()
    _financiadas = Array.isArray(datos.rows) ? datos.rows : []
}

// Guarda el listado completo; `calculo` es salida del servidor y no se reenvía.
async function financiadasGuardar(filas) {
    const cuerpo = filas.map(({ calculo, ...entrada }) => entrada)
    const respuesta = await fetch("/api/financiaciones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: cuerpo })
    })
    if (!respuesta.ok) throw new Error(await prestamoMensajeError(respuesta))
    const datos = await respuesta.json()
    _financiadas = Array.isArray(datos.rows) ? datos.rows : []
}

async function financiadasGuardarYPintar(filas) {
    try {
        await financiadasGuardar(filas)
    } catch (error) {
        showError("No se pudo guardar la compra", error)
        return false
    }
    financiadasPintar()
    return true
}

function financiadasPendiente(resumen) {
    return resumen.capitalPendiente + resumen.interesesPendientes
}

function financiadasVisibles() {
    const mostrarTodas = document.getElementById("financiadasMostrarLiquidadas")?.checked
    return _financiadas.filter((c) => mostrarTodas || !c.calculo?.resumen?.liquidado)
}

function financiadasActivas() {
    return _financiadas.filter((c) => c.calculo?.resumen && !c.calculo.resumen.liquidado)
}

// Primer cobro que aún no ha ocurrido, o null si la compra está liquidada.
function financiadasProximoCobro(compra) {
    return (compra.calculo?.cuadro || []).find((recibo) => !recibo.pagado) || null
}

function financiadasDiasHasta(iso) {
    const hoy = new Date()
    hoy.setHours(0, 0, 0, 0)
    const destino = new Date(`${iso}T00:00:00`)
    return Math.round((destino - hoy) / 86400000)
}

function financiadasTextoDias(dias) {
    if (dias <= 0) return "hoy"
    return dias === 1 ? "mañana" : `en ${dias} d`
}

function financiadasPintar() {
    const cuerpo = document.getElementById("financiadasBody")
    if (!cuerpo) return

    const visibles = financiadasVisibles()
    document.getElementById("financiadasEmptyMsg")?.classList.toggle("hidden", visibles.length > 0)
    // Se oculta el panel entero: solo con la tabla escondida quedaba un recuadro vacío.
    document.getElementById("financiadasPanel")?.classList.toggle("hidden", visibles.length === 0)

    cuerpo.innerHTML = visibles.map(financiadasFila).join("")
    cuerpo
        .querySelectorAll("[data-editar]")
        .forEach((boton) =>
            boton.addEventListener("click", () =>
                financiadasAbrirFormulario(_financiadas.find((c) => c.id === boton.dataset.editar))
            )
        )
    cuerpo
        .querySelectorAll("[data-eliminar]")
        .forEach((boton) => boton.addEventListener("click", () => financiadasConfirmarBorrado(boton.dataset.eliminar)))
    cuerpo.querySelectorAll("tr[data-detalle]").forEach((fila) =>
        fila.addEventListener("click", (evento) => {
            if (evento.target.closest(".acciones")) return
            financiadasAbrirDetalle(fila.dataset.detalle)
        })
    )
    const activas = financiadasActivas()
    financiadasPintarTotales(activas)
    financiadasPintarProximos(activas)
}

function financiadasPintarTotales(activas) {
    const contenedor = document.getElementById("financiadasTotales")
    if (!contenedor) return
    if (!_financiadas.length) {
        contenedor.innerHTML = ""
        return
    }
    const suma = (calcular) => activas.reduce((total, c) => total + calcular(c.calculo.resumen), 0)
    const fines = activas.map((c) => c.calculo.resumen.fechaFin).sort()
    const proximos = activas
        .map((c) => ({ compra: c, cobro: financiadasProximoCobro(c) }))
        .filter((p) => p.cobro)
        .sort((a, b) => a.cobro.fechaCobro.localeCompare(b.cobro.fechaCobro))
    const primero = proximos[0]
    const totalPagado = _financiadas.reduce((total, c) => total + (c.calculo?.resumen?.totalPagado || 0), 0)

    contenedor.innerHTML = [
        prestamoTarjeta(
            "Compras activas",
            String(activas.length),
            `${_financiadas.length - activas.length} liquidadas`
        ),
        prestamoTarjeta("Cuota mensual conjunta", formatEuro(suma((r) => r.cuotaActual))),
        prestamoTarjeta(
            "Próximo cobro",
            primero ? prestamoFormatoFecha(primero.cobro.fechaCobro) : "—",
            primero ? `${primero.compra.articulo} · ${formatEuro(primero.cobro.cuota + primero.cobro.extra)}` : ""
        ),
        prestamoTarjeta("Pendiente de pagar", formatEuro(suma(financiadasPendiente))),
        prestamoTarjeta("Ya pagado", formatEuro(totalPagado), "entrada y cuotas, hasta hoy"),
        prestamoTarjeta("Intereses pendientes", formatEuro(suma((r) => r.interesesPendientes))),
        prestamoTarjeta("Última cuota", fines.length ? prestamoFormatoFecha(fines[fines.length - 1]) : "—")
    ].join("")
}

// Cuotas que se van a cobrar en las próximas semanas, de todas las compras, para
// ver de un vistazo qué sale del banco y de qué cuenta.
function financiadasPintarProximos(activas) {
    const contenedor = document.getElementById("financiadasProximos")
    if (!contenedor) return

    const cobros = []
    activas.forEach((compra) => {
        compra.calculo.cuadro
            .filter((recibo) => !recibo.pagado && financiadasDiasHasta(recibo.fechaCobro) <= FINANCIADAS_DIAS_PROXIMOS)
            .forEach((recibo) => cobros.push({ compra, recibo }))
    })
    cobros.sort((a, b) => a.recibo.fechaCobro.localeCompare(b.recibo.fechaCobro))

    contenedor.classList.toggle("hidden", cobros.length === 0)
    if (!cobros.length) {
        contenedor.innerHTML = ""
        return
    }

    const total = cobros.reduce((suma, { recibo }) => suma + recibo.cuota + recibo.extra, 0)
    const lista = cobros.slice(0, FINANCIADAS_MAX_PROXIMOS)
    contenedor.innerHTML = `
        <div class="financiadasProximosCabecera">
            <span class="financiadasProximosTitulo">Próximos cobros</span>
            <span class="financiadasProximosTotal">${cobros.length} en ${FINANCIADAS_DIAS_PROXIMOS} días · ${escapeHtml(formatEuro(total))}</span>
        </div>
        <ul class="financiadasProximosLista">
            ${lista
                .map(({ compra, recibo }) => {
                    const dias = financiadasDiasHasta(recibo.fechaCobro)
                    return `<li class="financiadasProximosItem">
                        <span class="financiadasProximosFecha">${escapeHtml(prestamoFormatoFecha(recibo.fechaCobro))}<small>${escapeHtml(financiadasTextoDias(dias))}</small></span>
                        <span class="financiadasProximosNombre">${escapeHtml(compra.articulo)}<small>cuota ${recibo.numero} de ${compra.calculo.resumen.totalCuotas} · ${escapeHtml(nombreDeCuenta(compra.cuenta))}</small></span>
                        <span class="financiadasProximosImporte">${escapeHtml(formatEuro(recibo.cuota + recibo.extra))}</span>
                    </li>`
                })
                .join("")}
        </ul>`
}

function financiadasChips(compra) {
    const chips = []
    if (compra.categoria) chips.push(compra.categoria)
    chips.push(nombreDeCuenta(compra.cuenta))
    return chips.map((texto) => `<span class="financiadasChip">${escapeHtml(texto)}</span>`).join("")
}

function financiadasFila(compra) {
    const resumen = compra.calculo?.resumen
    const acciones = `<td class="acciones">
        <button type="button" class="hipotecasLinkBtn" data-editar="${escapeAttr(compra.id)}">Editar</button>
        <button type="button" class="hipotecasLinkBtn" data-eliminar="${escapeAttr(compra.id)}">Eliminar</button></td>`
    if (!resumen) {
        return `<tr><td>${escapeHtml(compra.articulo)}</td><td colspan="9">${escapeHtml(compra.calculo?.error || "No se puede calcular")}</td>${acciones}</tr>`
    }
    const progreso = Math.min(100, Math.max(0, resumen.progreso))
    const proximo = financiadasProximoCobro(compra)
    const textoProximo = proximo
        ? `${prestamoFormatoFecha(proximo.fechaCobro)}<span class="financiadasSub">${escapeHtml(financiadasTextoDias(financiadasDiasHasta(proximo.fechaCobro)))}</span>`
        : "—"
    return `<tr class="financiadasFila ${resumen.liquidado ? "pagado" : ""}" data-detalle="${escapeAttr(compra.id)}" title="Ver detalle y calendario de cuotas">
        <td>${escapeHtml(compra.articulo)}<span class="financiadasChips">${financiadasChips(compra)}</span></td>
        <td>${formatEuro(parseEuroNumber(compra.precio))}</td>
        <td>${formatEuro(resumen.cuotaActual)}</td>
        <td>${resumen.cuotasPagadas} / ${resumen.totalCuotas}</td>
        <td>${resumen.sinIntereses ? "Sin intereses" : prestamoFormatoPorcentaje(compra.tin)}</td>
        <td>${textoProximo}</td>
        <td>${prestamoFormatoFecha(resumen.fechaFin)}</td>
        <td>${resumen.liquidado ? "Liquidada" : prestamoFormatoPlazo(resumen.cuotasRestantes)}</td>
        <td>${formatEuro(financiadasPendiente(resumen))}</td>
        <td><div class="hipotecasBarra financiadasBarra" title="${prestamoFormatoPorcentaje(progreso)}"><div class="hipotecasBarraRelleno" style="width:${progreso}%"></div></div></td>
        ${acciones}</tr>`
}

// Quita `calculo` y deja solo los datos de entrada de una compra.
function financiadasEntrada(compra) {
    const { calculo, ...entrada } = compra
    return entrada
}

function financiadasAbrirFormulario(compra = null) {
    const datos = compra || {}
    const campo = (id, etiqueta, valor, extra = "") =>
        `<label class="assetModalLabel" for="${id}">${etiqueta}</label><input id="${id}" class="assetModalInput" type="text" value="${escapeAttr(valor ?? "")}" ${extra}>`
    const categorias = [...new Set(_financiadas.map((c) => c.categoria).filter(Boolean))]

    const modal = hipotecasAbrirModal(
        compra ? "Editar compra" : "Nueva compra financiada",
        `
        ${campo("finArticulo", "Artículo", datos.articulo, 'placeholder="Ej: Portátil"')}
        ${campo("finPrecio", "Precio (€)", datos.precio, 'inputmode="decimal" placeholder="1200"')}
        ${campo("finEntrada", "Entrada (€)", datos.entrada, 'inputmode="decimal" placeholder="0"')}
        ${campo("finCuotas", "Nº de cuotas (meses)", datos.cuotas, 'inputmode="numeric" placeholder="12"')}
        ${campo("finTin", "TIN (%) — 0 si es sin intereses", datos.tin, 'inputmode="decimal" placeholder="0"')}
        <label class="assetModalLabel" for="finFecha">Fecha de inicio</label>
        <input id="finFecha" class="assetModalInput" type="date" value="${escapeAttr(datos.fechaInicio || "")}">
        <label class="assetModalLabel" for="finCuenta">Cuenta de cobro</label>
        ${construirSelectorCuenta("finCuenta", datos.cuenta || "")}
        ${campo("finDiaCobro", "Día de cobro (vacío = el del inicio)", datos.diaCobro, 'inputmode="numeric" placeholder="1-31"')}
        ${campo("finCategoria", "Categoría", datos.categoria, 'list="finCategoriasLista" placeholder="Ej: Tecnología"')}
        <datalist id="finCategoriasLista">${categorias.map((c) => `<option value="${escapeAttr(c)}">`).join("")}</datalist>
        ${campo("finNota", "Nota", datos.nota)}`,
        async (modalForm) => {
            const valor = (id) => hipotecasValor(modalForm, id)
            const nueva = {
                ...(compra ? financiadasEntrada(compra) : { amortizaciones: [] }),
                id: compra?.id || "",
                articulo: valor("finArticulo"),
                precio: valor("finPrecio"),
                entrada: valor("finEntrada") || "0",
                cuotas: valor("finCuotas"),
                tin: valor("finTin") || "0",
                fechaInicio: valor("finFecha"),
                cuenta: valor("finCuenta"),
                diaCobro: valor("finDiaCobro"),
                categoria: valor("finCategoria"),
                nota: valor("finNota")
            }
            const lista = compra ? _financiadas.map((c) => (c.id === compra.id ? nueva : c)) : [..._financiadas, nueva]
            return financiadasGuardarYPintar(lista)
        }
    )
    return modal
}

function financiadasConfirmarBorrado(id) {
    const compra = _financiadas.find((c) => c.id === id)
    if (!compra) return
    openConfirmModal({
        title: "Eliminar compra",
        message: `¿Quieres eliminar «${compra.articulo}»? También se quitan sus cuotas de Mensualidades.`,
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            await financiadasGuardarYPintar(_financiadas.filter((c) => c.id !== id))
        }
    })
}

// ── Detalle de una compra ───────────────────────────────────────────────────

function financiadasFilaCuadro(recibo, idProxima) {
    const clases = [recibo.pagado ? "pagado" : "", recibo.numero === idProxima ? "financiadasProxima" : ""]
        .filter(Boolean)
        .join(" ")
    const extra = recibo.extra
        ? `<span class="financiadasSub">+ ${escapeHtml(formatEuro(recibo.extra))} anticipado</span>`
        : ""
    const estado = recibo.pagado ? "Pagada" : recibo.numero === idProxima ? "Próxima" : "Pendiente"
    return `<tr class="${clases}">
        <td>${recibo.numero}</td>
        <td>${escapeHtml(prestamoFormatoFecha(recibo.fechaCobro))}</td>
        <td>${escapeHtml(formatEuro(recibo.cuota))}${extra}</td>
        <td>${escapeHtml(formatEuro(recibo.interes))}</td>
        <td>${escapeHtml(formatEuro(recibo.capital))}</td>
        <td>${escapeHtml(formatEuro(recibo.pendiente))}</td>
        <td>${estado}</td></tr>`
}

function financiadasHtmlAmortizaciones(compra) {
    const lista = compra.amortizaciones || []
    if (!lista.length) return '<p class="hipotecasVacio">Sin pagos anticipados.</p>'
    return `<ul class="financiadasAnticipados">${lista
        .map(
            (pago, posicion) => `<li>
            <span>${escapeHtml(prestamoFormatoFecha(pago.fecha))}</span>
            <span>${escapeHtml(formatEuro(parseEuroNumber(pago.importe)))}</span>
            <span class="financiadasSub">${pago.modo === "cuota" ? "baja la cuota" : "acorta el plazo"}</span>
            <button type="button" class="hipotecasLinkBtn" data-quitar-anticipado="${posicion}">Quitar</button></li>`
        )
        .join("")}</ul>`
}

function financiadasAbrirDetalle(id) {
    const compra = _financiadas.find((c) => c.id === id)
    const resumen = compra?.calculo?.resumen
    if (!resumen) return

    const proxima = financiadasProximoCobro(compra)
    const progreso = Math.min(100, Math.max(0, resumen.progreso))
    const tarjetas = [
        prestamoTarjeta("Precio", formatEuro(parseEuroNumber(compra.precio))),
        prestamoTarjeta("Entrada", formatEuro(parseEuroNumber(compra.entrada))),
        prestamoTarjeta("Financiado", formatEuro(resumen.financiado)),
        prestamoTarjeta("Cuota", formatEuro(resumen.cuotaActual)),
        prestamoTarjeta("Ya pagado", formatEuro(resumen.totalPagado)),
        prestamoTarjeta("Pendiente", formatEuro(financiadasPendiente(resumen))),
        prestamoTarjeta("Intereses totales", formatEuro(resumen.interesesTotales)),
        prestamoTarjeta("Coste total", formatEuro(resumen.totalAPagar))
    ]
    if (resumen.ahorroIntereses > 0) {
        tarjetas.push(
            prestamoTarjeta(
                "Intereses ahorrados",
                formatEuro(resumen.ahorroIntereses),
                "por pagos anticipados",
                "positivo"
            )
        )
    }

    const overlay = document.createElement("div")
    overlay.className = "modalOverlay"
    overlay.style.zIndex = "20000"
    const modal = document.createElement("div")
    modal.className = "assetModal financiadasDetalle"
    modal.innerHTML = `
        <h3 class="assetModalTitle">${escapeHtml(compra.articulo)}</h3>
        <div class="financiadasChips">${financiadasChips(compra)}
            <span class="financiadasChip">Cobro el día ${escapeHtml(String(compra.diaCobro || Number(compra.fechaInicio.slice(8))))}</span>
            <span class="financiadasChip">${resumen.sinIntereses ? "Sin intereses" : `TIN ${escapeHtml(prestamoFormatoPorcentaje(compra.tin))}`}</span>
        </div>
        ${compra.nota ? `<p class="hipotecasVacio">${escapeHtml(compra.nota)}</p>` : ""}
        <div class="hipotecasMetricas">${tarjetas.join("")}</div>
        <div class="financiadasProgresoTexto"><span>${resumen.cuotasPagadas} de ${resumen.totalCuotas} cuotas</span><span>${escapeHtml(resumen.liquidado ? "Liquidada" : prestamoFormatoPlazo(resumen.cuotasRestantes) + " restantes")}</span></div>
        <div class="hipotecasBarra"><div class="hipotecasBarraRelleno" style="width:${progreso}%"></div></div>

        <div class="financiadasSeccion">
            <h4>Pagos anticipados</h4>
            <button type="button" class="hipotecasLinkBtn" data-anticipar ${resumen.liquidado ? "disabled" : ""}>Añadir pago anticipado</button>
        </div>
        ${financiadasHtmlAmortizaciones(compra)}

        <h4 class="financiadasSeccionTitulo">Calendario de cuotas</h4>
        <div class="hipotecasCuadroWrapper">
            <table class="hipotecasTabla hipotecasCuadro">
                <thead><tr><th>Nº</th><th>Cobro</th><th>Cuota</th><th>Intereses</th><th>Capital</th><th>Pendiente</th><th>Estado</th></tr></thead>
                <tbody>${compra.calculo.cuadro.map((recibo) => financiadasFilaCuadro(recibo, proxima?.numero)).join("")}</tbody>
            </table>
        </div>
        <div class="assetModalActions">
            <button type="button" data-accion="cerrar" class="cancelButton">Cerrar</button>
        </div>`

    const cerrar = () => overlay.remove()
    overlay.addEventListener("click", (evento) => {
        if (evento.target === overlay) cerrar()
    })
    modal.querySelector('[data-accion="cerrar"]').addEventListener("click", cerrar)
    modal.querySelector("[data-anticipar]")?.addEventListener("click", () => financiadasAbrirAnticipado(compra, cerrar))
    modal.querySelectorAll("[data-quitar-anticipado]").forEach((boton) =>
        boton.addEventListener("click", async () => {
            const restantes = compra.amortizaciones.filter(
                (_, posicion) => posicion !== Number(boton.dataset.quitarAnticipado)
            )
            cerrar()
            if (
                await financiadasGuardarYPintar(
                    _financiadas.map((c) => (c.id === id ? { ...financiadasEntrada(c), amortizaciones: restantes } : c))
                )
            ) {
                financiadasAbrirDetalle(id)
            }
        })
    )
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
    // Un cuadro de 36 cuotas empezaría en la primera, ya pagada: se centra en la que toca.
    modal.querySelector(".financiadasProxima")?.scrollIntoView({ block: "center" })
}

function financiadasAbrirAnticipado(compra, cerrarDetalle) {
    const hoy = new Date().toISOString().slice(0, 10)
    hipotecasAbrirModal(
        "Pago anticipado",
        `
        <label class="assetModalLabel" for="finAntFecha">Fecha</label>
        <input id="finAntFecha" class="assetModalInput" type="date" value="${hoy}">
        <label class="assetModalLabel" for="finAntImporte">Importe (€)</label>
        <input id="finAntImporte" class="assetModalInput" type="text" inputmode="decimal" placeholder="300">
        <label class="assetModalLabel" for="finAntModo">Efecto</label>
        <select id="finAntModo" class="assetModalSelect">
            <option value="plazo">Acortar el plazo (misma cuota)</option>
            <option value="cuota">Bajar la cuota (mismo plazo)</option>
        </select>`,
        async (modal) => {
            const pago = {
                fecha: hipotecasValor(modal, "finAntFecha"),
                importe: hipotecasValor(modal, "finAntImporte"),
                modo: hipotecasValor(modal, "finAntModo")
            }
            const lista = _financiadas.map((c) =>
                c.id === compra.id
                    ? { ...financiadasEntrada(c), amortizaciones: [...(c.amortizaciones || []), pago] }
                    : c
            )
            if (!(await financiadasGuardarYPintar(lista))) return false
            cerrarDetalle()
            financiadasAbrirDetalle(compra.id)
            return true
        }
    )
}

async function initFinanciadasLogic() {
    window.flushPendingPageChanges = null
    try {
        await financiadasCargar()
    } catch (error) {
        _financiadas = []
        showError("No se pudieron cargar las compras financiadas", error)
    }
    financiadasPintar()

    document.getElementById("financiadasAddBtn")?.addEventListener("click", () => financiadasAbrirFormulario())
    document.getElementById("financiadasMostrarLiquidadas")?.addEventListener("change", financiadasPintar)
}
