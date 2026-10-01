// Alertas de precio de un activo: la pestaña «Alertas» de su ficha.
//
// Una alerta dice «avísame cuando este activo llegue a X». El servidor las
// comprueba cada pocos minutos aunque no haya ninguna pestaña abierta y avisa
// por Telegram (Ajustes > Telegram); ver stores/alertas_store.py. Aquí solo se
// crean, se pausan o reactivan y se borran.
//
// Salta una sola vez: al cumplirse queda marcada con la hora y el precio que la
// disparó, y hay que reactivarla para que vuelva a vigilar. Con un aviso que
// se repitiera en cada cruce, un precio que oscila alrededor del umbral
// llenaría el chat.

const ALERTAS_PRECIO_CONDICIONES = {
    sube_a: "Precio igual o superior a",
    baja_a: "Precio igual o inferior a",
    var_dia: "Variación del día (±%) igual o superior a"
}

let _alertasPrecioActivoId = ""
let _alertasPrecioAsset = null

function alertasPrecioDescribir(alerta) {
    const etiqueta = ALERTAS_PRECIO_CONDICIONES[alerta.condicion] || alerta.condicion
    const unidad = alerta.condicion === "var_dia" ? " %" : ` ${_alertasPrecioAsset?.currency || ""}`
    return `${etiqueta} ${alerta.valor.replace(".", ",")}${unidad}`
}

function alertasPrecioFecha(segundos) {
    if (!segundos) return ""
    return new Date(segundos * 1000).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })
}

function alertasPrecioMensaje(texto, esError = false) {
    const caja = document.getElementById("alertasPrecioMsg")
    if (!caja) return
    caja.textContent = texto || ""
    caja.classList.toggle("alertasPrecioMsgError", !!esError)
}

// La unidad del valor depende de la condición: un precio en la divisa del
// activo, o un porcentaje para la variación del día.
function alertasPrecioActualizarEtiquetaValor() {
    const etiqueta = document.getElementById("alertasPrecioEtiquetaValor")
    const condicion = document.getElementById("alertasPrecioCondicion")?.value
    if (!etiqueta) return
    etiqueta.textContent = condicion === "var_dia" ? "Variación (%)" : `Precio (${_alertasPrecioAsset?.currency || ""})`
}

function alertasPrecioActualizarPestana(activas) {
    const boton = document.getElementById("alertasTabBtn")
    if (boton) boton.textContent = activas ? `Alertas (${activas})` : "Alertas"
}

function alertasPrecioPintarLista(alertas) {
    const lista = document.getElementById("alertasPrecioLista")
    if (!lista) return

    alertasPrecioActualizarPestana(alertas.filter((a) => a.activa).length)

    if (!alertas.length) {
        lista.innerHTML = `
            <div class="alertasPrecioVacio">
                <strong>Sin alertas en este activo</strong>
                <span>Crea una arriba y te avisaremos por Telegram cuando llegue a ese precio.</span>
            </div>`
        return
    }

    lista.innerHTML = alertas
        .map((alerta) => {
            const saltada = !alerta.activa && alerta.disparada
            const estado = saltada ? "Saltó" : alerta.activa ? "Vigilando" : "En pausa"
            const claseEstado = saltada ? "saltada" : alerta.activa ? "activa" : "pausada"
            const detalle = saltada
                ? `${alertasPrecioFecha(alerta.disparada)} · con ${String(alerta.precioDisparo).replace(".", ",")} ${_alertasPrecioAsset?.currency || ""}`
                : `Creada el ${alertasPrecioFecha(alerta.creada)}`
            const nota = alerta.nota ? `<div class="alertasPrecioNota">${escapeHtml(alerta.nota)}</div>` : ""
            return `
                <div class="alertasPrecioItem alertasPrecioItem--${claseEstado}" data-alerta-id="${alerta.id}">
                    <span class="alertasPrecioPildora alertasPrecioPildora--${claseEstado}">${estado}</span>
                    <div class="alertasPrecioTexto">
                        <div class="alertasPrecioRegla">${escapeHtml(alertasPrecioDescribir(alerta))}</div>
                        <div class="alertasPrecioMeta">${escapeHtml(detalle)}</div>
                        ${nota}
                    </div>
                    <div class="alertasPrecioAcciones">
                        <button type="button" class="cancelButton alertasPrecioBtn" data-accion="${alerta.activa ? "pausar" : "activar"}">
                            ${alerta.activa ? "Pausar" : saltada ? "Reactivar" : "Activar"}
                        </button>
                        <button type="button" class="alertasPrecioBtn alertasPrecioBtnBorrar" data-accion="borrar">Borrar</button>
                    </div>
                </div>`
        })
        .join("")
}

async function alertasPrecioCargar() {
    try {
        const res = await fetch(`/api/alertas?assetId=${encodeURIComponent(_alertasPrecioActivoId)}`)
        const datos = await res.json()
        if (!datos.ok) throw new Error(datos.error || "Error al cargar las alertas")
        alertasPrecioPintarLista(datos.alertas || [])
    } catch (error) {
        alertasPrecioMensaje(error.message || "No se pudieron cargar las alertas", true)
    }
}

async function alertasPrecioCrear(evento) {
    evento.preventDefault()
    const condicion = document.getElementById("alertasPrecioCondicion")?.value
    const valor = document.getElementById("alertasPrecioValor")?.value.trim()
    const nota = document.getElementById("alertasPrecioNotaInput")?.value.trim()

    if (!valor) {
        alertasPrecioMensaje("Indica el valor de la alerta", true)
        return
    }

    try {
        const res = await fetch("/api/alertas", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ assetId: _alertasPrecioActivoId, condicion, valor, nota })
        })
        const datos = await res.json()
        if (!datos.ok) throw new Error(datos.error || "No se pudo crear la alerta")
        document.getElementById("alertasPrecioValor").value = ""
        document.getElementById("alertasPrecioNotaInput").value = ""
        alertasPrecioMensaje("Alerta creada")
        await alertasPrecioCargar()
    } catch (error) {
        alertasPrecioMensaje(error.message || "Error de red", true)
    }
}

async function alertasPrecioManejarClick(evento) {
    const boton = evento.target.closest("button[data-accion]")
    const fila = evento.target.closest("[data-alerta-id]")
    if (!boton || !fila) return

    const id = fila.dataset.alertaId
    try {
        const accion = boton.dataset.accion
        const res =
            accion === "borrar"
                ? await fetch(`/api/alertas/${id}`, { method: "DELETE" })
                : await fetch(`/api/alertas/${id}/estado`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ activa: accion === "activar" })
                  })
        const datos = await res.json()
        if (!datos.ok) throw new Error(datos.error || "No se pudo actualizar la alerta")
        alertasPrecioMensaje("")
        await alertasPrecioCargar()
    } catch (error) {
        alertasPrecioMensaje(error.message || "Error de red", true)
    }
}

async function initAssetAlertasLogic(asset) {
    const seccion = document.getElementById("assetAlertasSection")
    if (!seccion) return

    _alertasPrecioActivoId = String(asset?.id || "")
    _alertasPrecioAsset = asset || null

    seccion.innerHTML = `
        <div class="alertasPrecioPanel">
            <form id="alertasPrecioForm" class="alertasPrecioForm" autocomplete="off">
                <div class="alertasPrecioCampoWrap alertasPrecioCampoCondicion">
                    <label class="alertasPrecioEtiqueta" for="alertasPrecioCondicion">Condición</label>
                    <select id="alertasPrecioCondicion" class="ajustesSelect alertasPrecioCampo">
                        ${Object.entries(ALERTAS_PRECIO_CONDICIONES)
                            .map(([clave, texto]) => `<option value="${clave}">${escapeHtml(texto)}</option>`)
                            .join("")}
                    </select>
                </div>
                <div class="alertasPrecioCampoWrap alertasPrecioCampoValor">
                    <label class="alertasPrecioEtiqueta" for="alertasPrecioValor" id="alertasPrecioEtiquetaValor"></label>
                    <input id="alertasPrecioValor" class="ajustesInput alertasPrecioCampo" type="text" inputmode="decimal" placeholder="0,00">
                </div>
                <div class="alertasPrecioCampoWrap alertasPrecioCampoNota">
                    <label class="alertasPrecioEtiqueta" for="alertasPrecioNotaInput">Nota (opcional)</label>
                    <input id="alertasPrecioNotaInput" class="ajustesInput alertasPrecioCampo" type="text" maxlength="200" placeholder="Para qué es esta alerta">
                </div>
                <button type="submit" class="primaryButton alertasPrecioAnadir"><span class="assetBtnIcon">+</span> Añadir alerta</button>
            </form>
            <div id="alertasPrecioMsg" class="alertasPrecioMsg" role="status"></div>
            <div id="alertasPrecioLista" class="alertasPrecioLista"></div>
        </div>`

    alertasPrecioActualizarEtiquetaValor()
    document.getElementById("alertasPrecioCondicion").addEventListener("change", alertasPrecioActualizarEtiquetaValor)
    document.getElementById("alertasPrecioForm").addEventListener("submit", alertasPrecioCrear)
    document.getElementById("alertasPrecioLista").addEventListener("click", alertasPrecioManejarClick)

    await alertasPrecioCargar()
}
