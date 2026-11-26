// Canjes de valores por fusión, absorción o canje (Tesla por SpaceX, por
// ejemplo). Se registran desde el menú ··· de la ficha de un activo y se
// listan, editan y borran en la página de Ventas, que es donde se declaran.
//
// El navegador no calcula nada: el servidor (`/api/canjes`, `core/canjes.py`)
// decide qué lotes se traspasan, con qué coste y fecha, y qué se declara. Aquí
// solo se recogen los datos de hecho del canje, se enseña la previsualización
// que devuelve el servidor antes de guardar y se listan los canjes del ejercicio
// abierto con el resultado que ya viene calculado en `/api/ventas/<año>`.

let ventasCanjeModalKeyHandler = null

const VENTAS_CANJE_REGIMENES = {
    neutral: {
        etiqueta: "Régimen especial (neutral)",
        ayuda: "Art. 81 LIS: el canje no tributa. Los títulos recibidos conservan el coste y la fecha de adquisición de cada lote entregado. La compensación en dinero rebaja ese coste; los picos se declaran como una venta."
    },
    gravado: {
        etiqueta: "Régimen general (permuta)",
        ayuda: "Art. 37.1.h LIRPF: se transmiten los títulos entregados por el valor de mercado de lo recibido, con ganancia o pérdida por FIFO, y los nuevos se adquieren por ese valor con la fecha del canje."
    }
}

async function fetchVentasCanjes() {
    const response = await fetch("/api/canjes")
    if (!response.ok) {
        throw new Error("No se pudieron cargar los canjes")
    }
    const data = await response.json()
    return Array.isArray(data?.rows) ? data.rows : []
}

async function enviarVentasCanje(url, method, cuerpo) {
    const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo)
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`)
    }
    return data
}

function bindVentasCanjes() {
    const contenedor = document.getElementById("ventasCanjes")
    if (contenedor && !contenedor.dataset.bound) {
        contenedor.dataset.bound = "true"
        contenedor.addEventListener("click", handleVentasCanjesClick)
    }
}

function handleVentasCanjesClick(event) {
    const editar = event.target.closest(".ventasCanjeEditBtn")
    if (editar) {
        openVentasCanjeModal(editar.dataset.canjeId)
        return
    }
    const borrar = event.target.closest(".ventasCanjeDeleteBtn")
    if (borrar) {
        confirmarBorradoVentasCanje(borrar.dataset.canjeId, borrar.dataset.concepto || "")
    }
}

function confirmarBorradoVentasCanje(canjeId, concepto) {
    openConfirmModal({
        title: "Eliminar canje",
        message: `Vas a eliminar el canje ${concepto}. Los títulos volverán al activo entregado y el coste FIFO de las ventas posteriores se recalculará.`,
        confirmLabel: "Eliminar",
        confirmSide: "right",
        onConfirm: async () => {
            const response = await fetch(`/api/canjes/${encodeURIComponent(canjeId)}`, { method: "DELETE" })
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`)
            }
            await recargarVentasTrasCanje(currentVentasYear)
        }
    })
}

// Un canje en régimen general o con picos declara en el ejercicio de su fecha.
// Si ese ejercicio no existe aún se crea, porque si no el resultado no saldría
// en ninguna pantalla ni en el informe.
async function recargarVentasTrasCanje(anio) {
    const anioTexto = String(anio || currentVentasYear)
    // La lista de ejercicios incluye el actual aunque no esté guardado, así que
    // no sirve para saber si existe: se intenta crear y un 409 es que ya estaba.
    try {
        await createVentasYear(anioTexto)
    } catch (error) {
        if (!String(error?.message || "").startsWith("HTTP 409")) throw error
    }
    ventasYears = (await loadVentasIndex()).years || []
    if (document.getElementById("ventasBody")) {
        await renderVentasYear(anioTexto)
    }
    // El canje mueve títulos de un activo a otro: la barra lateral, las cifras
    // de cabecera y la ficha abierta tienen que volver a pedir la cartera.
    if (typeof refreshAssetsSidebar === "function") {
        await refreshAssetsSidebar()
    }
    if (document.getElementById("assetMenuBtn") && currentAssetId) {
        const activo = await loadAssetData(currentAssetId)
        if (activo) {
            await updateAssetDetail(activo)
            renderAssetTablePage(activo)
        }
    }
}

// Desde la ficha de un activo: si tiene títulos, es el que se entrega (Tesla);
// si no, el que se recibe (SpaceX recién creado). Los dos se pueden cambiar.
async function openVentasCanjeDesdeActivo(assetId) {
    let titulos = 0
    try {
        await loadVentasRowsForAssets()
        const activo = await loadAssetData(assetId)
        const lotes = activo ? await buildRemainingAssetLots(activo, activo.currency || "EUR") : []
        titulos = lotes.reduce((total, lote) => total + lote.remaining, 0)
    } catch (error) {
        console.error(error)
    }
    await openVentasCanjeModal("", titulos > 0 ? { activoOrigen: assetId } : { activoDestino: assetId })
}

function renderVentasCanjes() {
    const contenedor = document.getElementById("ventasCanjes")
    if (!contenedor) return

    const canjes = Array.isArray(currentVentasData.canjes) ? currentVentasData.canjes : []
    if (!canjes.length) {
        contenedor.innerHTML = ""
        contenedor.classList.add("hidden")
        return
    }

    contenedor.classList.remove("hidden")
    contenedor.innerHTML = `
        <h4 class="ventasResumenTitulo">Canjes de valores · ejercicio ${escapeVentasHtml(currentVentasYear)}</h4>
        <div class="ventasCanjesTablaWrapper">
            <table class="operationsTable ventasCanjesTabla">
                <thead>
                    <tr>
                        <th>Fecha</th>
                        <th>Canje</th>
                        <th>Régimen</th>
                        <th>Entregados</th>
                        <th>Recibidos</th>
                        <th title="Valor fiscal que heredan los títulos recibidos (régimen neutral).">Coste traspasado</th>
                        <th title="Ganancia o pérdida que declara el canje: la entrega en régimen general y los picos.">A declarar</th>
                        <th class="rowActionHeader"></th>
                    </tr>
                </thead>
                <tbody>${canjes.map(buildVentasCanjeRow).join("")}</tbody>
            </table>
        </div>
    `
}

function buildVentasCanjeRow(canje) {
    const declarar = (canje.transmisiones || []).reduce(
        (total, fila) => total + (parseLooseNumber(fila.dineroDeclarar) || 0),
        0
    )
    const hayTransmisiones = (canje.transmisiones || []).length > 0
    const regimen = VENTAS_CANJE_REGIMENES[canje.regimen]?.etiqueta || canje.regimen || ""
    const titulo = canje.incidencia
        ? ` class="ventasRowIncidencia" title="${escapeVentasHtml(canje.mensaje || "")}"`
        : ""
    return `
        <tr${titulo}>
            <td>${escapeVentasHtml(canje.fecha || "")}${canje.incidencia ? ' <span class="ventasIncidenciaMarca" title="Revisa este canje">!</span>' : ""}</td>
            <td title="${escapeVentasHtml(describirLotesCanje(canje.lotes))}">${escapeVentasHtml(canje.concepto || "")}</td>
            <td>${escapeVentasHtml(regimen)}</td>
            <td>${formatVentasNumber(canje.entregadas)}</td>
            <td>${formatVentasNumber(canje.recibidas)}${parseLooseNumber(canje.picosCantidad) ? ` + ${formatVentasNumber(canje.picosCantidad)} en efectivo` : ""}</td>
            <td class="rowTotal">${formatVentasMoney(canje.costeTraspasado)}</td>
            <td class="rowTotal">${hayTransmisiones ? formatVentasTaxColumn(String(declarar)) : "- €"}</td>
            <td class="rowActionsCell">
                <div class="rowMenu">
                    <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                    <div class="rowMenuDropdown">
                        <button type="button" class="rowMenuItem ventasCanjeEditBtn" data-canje-id="${escapeVentasHtml(canje.id)}">Editar</button>
                        <hr>
                        <button type="button" class="rowMenuItem rowMenuItemDanger ventasCanjeDeleteBtn" data-canje-id="${escapeVentasHtml(canje.id)}" data-concepto="${escapeVentasHtml(canje.concepto || "")}">Eliminar</button>
                    </div>
                </div>
            </td>
        </tr>
    `
}

function describirLotesCanje(lotes) {
    if (!Array.isArray(lotes) || !lotes.length) return ""
    return (
        "Lotes recibidos:\n" +
        lotes
            .map(
                (lote) =>
                    `${formatVentasNumber(lote.cantidad)} ud. adquiridas el ${lote.fechaAdquisicion}, coste ${formatVentasMoney(lote.coste)}`
            )
            .join("\n")
    )
}

function closeVentasCanjeModal() {
    document.getElementById("ventasCanjeModalOverlay")?.remove()
    if (ventasCanjeModalKeyHandler) {
        document.removeEventListener("keydown", ventasCanjeModalKeyHandler)
        ventasCanjeModalKeyHandler = null
    }
}

async function openVentasCanjeModal(canjeId = "", inicial = {}) {
    closeVentasCanjeModal()

    // Fuera de la página de Ventas la lista de activos del desplegable no está
    // cargada todavía.
    if (!ventasAssets.length) {
        try {
            await loadVentasAssets()
        } catch (error) {
            console.error(error)
            alert("No se pudieron cargar los activos.")
            return
        }
    }

    let canje = { ...inicial }
    if (canjeId) {
        try {
            canje = (await fetchVentasCanjes()).find((fila) => fila.id === canjeId) || {}
        } catch (error) {
            console.error(error)
            alert("No se pudo cargar el canje.")
            return
        }
    }

    const overlay = document.createElement("div")
    overlay.id = "ventasCanjeModalOverlay"
    overlay.className = "modalOverlay"
    const modal = document.createElement("div")
    modal.className = "assetModal ventasCreateModal ventasCanjeModal"
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.innerHTML = plantillaVentasCanjeModal(canje)
    // Los desplegables los monta solos el montaje automático de la app
    // (shared-utils.js). Añadirles además el buscador dejaba dos superpuestos.
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
    bindVentasCanjeModal(modal, canje)

    ventasCanjeModalKeyHandler = (event) => {
        if (event.key === "Escape") closeVentasCanjeModal()
    }
    document.addEventListener("keydown", ventasCanjeModalKeyHandler)
    modal.querySelector("input")?.focus()
}

function plantillaVentasCanjeModal(canje) {
    const valor = (clave) => escapeVentasHtml(formatVentasNumberInput(canje[clave]) || "")
    const regimen = canje.regimen || "neutral"
    const opcionesRegimen = Object.entries(VENTAS_CANJE_REGIMENES)
        .map(
            ([clave, dato]) =>
                `<option value="${clave}"${clave === regimen ? " selected" : ""}>${escapeVentasHtml(dato.etiqueta)}</option>`
        )
        .join("")
    return `
        <h3 class="assetModalTitle">${canje.id ? "Editar canje de valores" : "Registrar fusión o canje"}</h3>
        <div class="ventasCanjeGrid">
            <div class="ventasCanjeCampo">
                <label class="assetModalLabel" for="canjeOrigenInput">Activo entregado</label>
                <select id="canjeOrigenInput" class="assetModalSelect">${buildVentasAssetOptions(canje.activoOrigen || "")}</select>
            </div>
            <div class="ventasCanjeCampo">
                <label class="assetModalLabel" for="canjeDestinoInput">Activo recibido</label>
                <select id="canjeDestinoInput" class="assetModalSelect">${buildVentasAssetOptions(canje.activoDestino || "")}</select>
                <p class="assetModalHint">Si aún no existe, créalo antes en Cartera.</p>
            </div>
            <div class="ventasCanjeCampo">
                <label class="assetModalLabel" for="canjeFechaInput">Fecha del canje</label>
                <input id="canjeFechaInput" class="assetModalInput" type="text" value="${escapeVentasHtml(canje.fecha || "")}" placeholder="dd-mm-aaaa">
            </div>
            <div class="ventasCanjeCampo">
                <div class="ventasCanjeEtiquetaAyuda">
                    <label class="assetModalLabel" for="canjeRegimenInput">Régimen fiscal</label>
                    <button type="button" class="ventasCanjeAyudaBtn" id="canjeRegimenAyudaBtn" aria-expanded="false"
                        aria-controls="canjeRegimenInfo" title="Diferencias entre régimen neutral y permuta">?</button>
                </div>
                <select id="canjeRegimenInput" class="assetModalSelect">${opcionesRegimen}</select>
            </div>
            <div class="ventasCanjeAncho">
                <p class="assetModalHint" id="canjeRegimenAyuda"></p>
                ${plantillaAyudaRegimenes()}
            </div>
            <div class="ventasCanjeCampo">
                <label class="assetModalLabel" for="canjeEntregadasInput">Títulos entregados</label>
                <input id="canjeEntregadasInput" class="assetModalInput" type="text" inputmode="decimal" value="${valor("cantidadEntregada")}" placeholder="0">
            </div>
            <div class="ventasCanjeCampo">
                <label class="assetModalLabel" for="canjeRecibidasInput">Títulos recibidos (enteros)</label>
                <input id="canjeRecibidasInput" class="assetModalInput" type="text" inputmode="decimal" value="${valor("cantidadRecibida")}" placeholder="0">
            </div>
            <div class="ventasCanjeCampo">
                <label class="assetModalLabel" for="canjePicosInput">Fracción liquidada en efectivo (picos)</label>
                <input id="canjePicosInput" class="assetModalInput" type="text" inputmode="decimal" value="${valor("picosCantidad")}" placeholder="0">
            </div>
            <div class="ventasCanjeCampo">
                <label class="assetModalLabel" for="canjePicosImporteInput">Efectivo cobrado por los picos</label>
                <input id="canjePicosImporteInput" class="assetModalInput" type="text" inputmode="decimal" value="${valor("picosImporte")}" placeholder="0,00">
            </div>
            <div class="ventasCanjeCampo">
                <label class="assetModalLabel" for="canjeCompensacionInput">Compensación en dinero</label>
                <input id="canjeCompensacionInput" class="assetModalInput" type="text" inputmode="decimal" value="${valor("compensacion")}" placeholder="0,00">
            </div>
            <div class="ventasCanjeCampo">
                <label class="assetModalLabel" for="canjeValorInput">Valor de mercado de lo recibido</label>
                <input id="canjeValorInput" class="assetModalInput" type="text" inputmode="decimal" value="${valor("valorMercado")}" placeholder="0,00">
                <p class="assetModalHint">Obligatorio en permuta: es el valor de transmisión.</p>
            </div>
            <div class="ventasCanjeCampo">
                <label class="assetModalLabel" for="canjeMonedaInput">Moneda de los importes</label>
                <input id="canjeMonedaInput" class="assetModalInput" type="text" maxlength="3" value="${escapeVentasHtml(canje.moneda || "")}" placeholder="EUR">
            </div>
            <div class="ventasCanjeCampo">
                <label class="assetModalLabel" for="canjeFxInput">Tipo de cambio a euros (1 unidad = x €)</label>
                <input id="canjeFxInput" class="assetModalInput" type="text" inputmode="decimal" value="${valor("fxRate")}" placeholder="Solo si no es EUR">
            </div>
            <div class="ventasCanjeAncho">
                <label class="assetModalLabel" for="canjeNotaInput">Nota (folleto, comunicación del bróker…)</label>
                <input id="canjeNotaInput" class="assetModalInput" type="text" maxlength="500" value="${escapeVentasHtml(canje.nota || "")}">
            </div>
        </div>
        <div class="ventasCanjePrevia hidden" id="canjePrevia"></div>
        <p class="gastosCreateModalFeedback hidden" id="canjeModalFeedback"></p>
        <div class="assetModalActions ventasModalActions">
            <button type="button" class="cancelButton" id="canjeModalCancelBtn">Cancelar</button>
            <button type="button" class="cancelButton" id="canjeModalPreviewBtn">Previsualizar</button>
            <button type="button" class="primaryButton" id="canjeModalSaveBtn" data-no-autohide="true">Guardar</button>
        </div>
    `
}

// Comparación de los dos regímenes, plegada tras el botón «?». Es estática: no
// depende de los datos del canje.
function plantillaAyudaRegimenes() {
    const filas = [
        [
            "¿Tributa el canje?",
            "No. No hay ganancia ni pérdida ese año.",
            "Sí. Ganancia o pérdida de las acciones entregadas, ese año."
        ],
        [
            "Valor de transmisión",
            "No hay: no se transmite a efectos fiscales.",
            "Valor de mercado de las acciones recibidas más el efectivo cobrado."
        ],
        ["Coste de las acciones nuevas", "El de las entregadas, lote a lote.", "Su valor de mercado el día del canje."],
        ["Fecha de compra de las nuevas", "La original de cada lote entregado.", "La del canje."],
        [
            "Venta posterior (FIFO)",
            "Salen primero las de la compra original más antigua.",
            "Salen como compradas el día del canje."
        ],
        ["Compensación en dinero", "Rebaja el coste de las acciones nuevas.", "Suma al valor de transmisión."],
        ["Picos en efectivo", "Se declaran como una venta.", "Suman al valor de transmisión."],
        ["Norma", "Art. 81 LIS (régimen especial de fusiones).", "Art. 37.1.h LIRPF (permuta)."]
    ]
    return `
        <div class="ventasCanjeAyuda hidden" id="canjeRegimenInfo">
            <table class="ventasCanjeAyudaTabla">
                <thead><tr><th></th><th>Neutral</th><th>Permuta</th></tr></thead>
                <tbody>${filas
                    .map(
                        ([concepto, neutral, permuta]) =>
                            `<tr><th scope="row">${escapeVentasHtml(concepto)}</th><td>${escapeVentasHtml(neutral)}</td><td>${escapeVentasHtml(permuta)}</td></tr>`
                    )
                    .join("")}</tbody>
            </table>
            <p class="assetModalHint">
                Una fusión suele acogerse al régimen neutral, y la entidad lo indica en la información del canje.
                Entre sociedades de fuera de la UE (dos estadounidenses, por ejemplo), poder acogerse depende de la
                doctrina de la DGT para esa operación. Si no se acoge, es una permuta.
            </p>
        </div>
    `
}

function leerVentasCanjeModal(modal) {
    const texto = (selector) => modal.querySelector(selector)?.value.trim() || ""
    const numero = (selector) => toCanonicalNumber(texto(selector))
    return {
        fecha: texto("#canjeFechaInput"),
        activoOrigen: texto("#canjeOrigenInput"),
        activoDestino: texto("#canjeDestinoInput"),
        regimen: texto("#canjeRegimenInput") || "neutral",
        cantidadEntregada: numero("#canjeEntregadasInput"),
        cantidadRecibida: numero("#canjeRecibidasInput"),
        picosCantidad: numero("#canjePicosInput"),
        picosImporte: numero("#canjePicosImporteInput"),
        compensacion: numero("#canjeCompensacionInput"),
        valorMercado: numero("#canjeValorInput"),
        moneda: texto("#canjeMonedaInput").toUpperCase(),
        fxRate: numero("#canjeFxInput"),
        nota: texto("#canjeNotaInput")
    }
}

function bindVentasCanjeModal(modal, canje) {
    const setFeedback = (message = "", isError = false) => {
        const node = modal.querySelector("#canjeModalFeedback")
        if (!node) return
        node.textContent = message
        node.classList.toggle("hidden", !message)
        node.classList.toggle("error", Boolean(message && isError))
    }

    const actualizarRegimen = () => {
        const regimen = modal.querySelector("#canjeRegimenInput")?.value || "neutral"
        const ayuda = modal.querySelector("#canjeRegimenAyuda")
        if (ayuda) ayuda.textContent = VENTAS_CANJE_REGIMENES[regimen]?.ayuda || ""
    }
    // La moneda por defecto es la del activo recibido, que es en la que suele
    // liquidar el bróker la compensación y los picos.
    const sugerirMoneda = () => {
        const campo = modal.querySelector("#canjeMonedaInput")
        const destino = modal.querySelector("#canjeDestinoInput")?.value || ""
        if (campo && !campo.value.trim() && destino) campo.value = getVentasAssetCurrency(destino)
    }
    actualizarRegimen()
    sugerirMoneda()
    modal.querySelector("#canjeRegimenAyudaBtn")?.addEventListener("click", (event) => {
        const info = modal.querySelector("#canjeRegimenInfo")
        if (!info) return
        const abierta = info.classList.toggle("hidden") === false
        event.currentTarget.setAttribute("aria-expanded", String(abierta))
        event.currentTarget.classList.toggle("active", abierta)
    })
    modal.querySelector("#canjeRegimenInput")?.addEventListener("change", actualizarRegimen)
    modal.querySelector("#canjeDestinoInput")?.addEventListener("change", sugerirMoneda)

    modal.querySelector("#canjeModalCancelBtn")?.addEventListener("click", closeVentasCanjeModal)
    modal.querySelector("#canjeModalPreviewBtn")?.addEventListener("click", async () => {
        setFeedback("")
        try {
            const datos = { ...leerVentasCanjeModal(modal), id: canje.id || "" }
            const respuesta = await enviarVentasCanje("/api/canjes/previsualizar", "POST", datos)
            pintarVentasCanjePrevia(modal, respuesta.previsualizacion)
        } catch (error) {
            setFeedback(error.message || "No se pudo previsualizar.", true)
        }
    })
    modal.querySelector("#canjeModalSaveBtn")?.addEventListener("click", async () => {
        setFeedback("")
        const datos = leerVentasCanjeModal(modal)
        try {
            const url = canje.id ? `/api/canjes/${encodeURIComponent(canje.id)}` : "/api/canjes"
            const respuesta = await enviarVentasCanje(url, canje.id ? "PUT" : "POST", datos)
            closeVentasCanjeModal()
            const anio = (String(respuesta?.canje?.fecha || datos.fecha).match(/(\d{4})\s*$/) || [])[1]
            await recargarVentasTrasCanje(anio || currentVentasYear)
        } catch (error) {
            setFeedback(error.message || "No se pudo guardar.", true)
        }
    })
}

function pintarVentasCanjePrevia(modal, previa) {
    const contenedor = modal.querySelector("#canjePrevia")
    if (!contenedor) return
    if (!previa) {
        contenedor.innerHTML = ""
        contenedor.classList.add("hidden")
        return
    }

    const lotes = (previa.lotes || [])
        .map(
            (lote) => `<li>
                <span>${escapeVentasHtml(lote.fechaAdquisicion)}</span>
                <span>${formatVentasNumber(lote.cantidad)} ud.</span>
                <span>${formatVentasMoney(lote.coste)}</span>
            </li>`
        )
        .join("")
    const transmisiones = (previa.transmisiones || [])
        .map(
            (fila) => `<li>
                <span>${escapeVentasHtml(fila.fecha)}</span>
                <span>${formatVentasNumber(fila.cantidad)} ud. de ${escapeVentasHtml(fila.activo)}</span>
                <span>${formatVentasTaxColumn(fila.dineroDeclarar)}</span>
            </li>`
        )
        .join("")

    contenedor.classList.remove("hidden")
    contenedor.innerHTML = `
        ${previa.incidencia ? `<p class="gastosCreateModalFeedback error">${escapeVentasHtml(previa.mensaje || "Revisa los datos del canje.")}</p>` : ""}
        <span class="ventasArrastresTitulo">Lotes que recibe ${escapeVentasHtml(previa.destino || "")}</span>
        ${lotes ? `<ul class="ventasArrastresLista ventasCanjeLista">${lotes}</ul>` : '<p class="assetModalHint">Ningún lote.</p>'}
        <span class="ventasArrastresTitulo">A declarar en el ejercicio</span>
        ${transmisiones ? `<ul class="ventasArrastresLista ventasCanjeLista">${transmisiones}</ul>` : '<p class="assetModalHint">Nada: el canje no genera renta.</p>'}
    `
}
