// ===== CUENTAS =====
// Dónde está el dinero: la cuenta bancaria de Gastos e Ingresos, las cuentas de
// ahorro, los exchanges, los brokers… Mover dinero de una a otra es una
// transferencia, no un gasto ni un ingreso, y por eso vive aquí y no en Gastos.
// Los prefijos «cnt» evitan chocar con los nombres de las demás páginas, que
// comparten el ámbito global.

let cntCuentas = []
let cntTransferencias = []
let cntTipos = []
// `{id: [{fecha, entradas, salidas, saldo}]}` de /api/cuentas/historico, o null
// si no se pudo cargar: las tarjetas se enseñan igual, sin la miniatura.
let cntHistorico = null
let cntGraficaLateral = null
// Gastos por categoría ya pedidos, por fecha de inicio: cambiar de pestaña o de
// periodo y volver no repite la petición. Se vacía al recargar los datos.
let cntGastosCache = {}
// Sube con cada pintado de la tarjeta: una respuesta que llega tarde (de otra
// pestaña u otro periodo) se descarta.
let cntLateralTurno = 0

async function initCuentasLogic() {
    try {
        await cntRecargar()
        cntBind()
        cntRender()
    } catch (error) {
        console.error("Error inicializando las cuentas:", error)
        showError("No se pudieron cargar las cuentas", error)
    }
}

async function cntRecargar() {
    const [cuentas, transferencias, historico] = await Promise.all([
        Api.get("/api/cuentas"),
        Api.get("/api/transferencias"),
        // El histórico es un extra: si falla, la página sigue sirviendo.
        Api.get("/api/cuentas/historico").catch((error) => {
            console.error("Error cargando el histórico de saldos:", error)
            return null
        })
    ])
    cntCuentas = Array.isArray(cuentas?.cuentas) ? cuentas.cuentas : []
    cntTipos = Array.isArray(cuentas?.tipos) ? cuentas.tipos : []
    cntTransferencias = Array.isArray(transferencias?.transferencias) ? transferencias.transferencias : []
    cntHistorico = historico?.cuentas && typeof historico.cuentas === "object" ? historico.cuentas : null
    cntGastosCache = {}
    // Los desplegables de Gastos e Ingresos leen esta misma lista.
    window._cuentasDinero = cntCuentas
}

function cntNombre(id) {
    return cntCuentas.find((c) => c.id === id)?.nombre || id
}

function cntRender() {
    cntRenderCuentas()
    cntRenderLateral()
    cntRefrescarPanel()
}

// ── Cuentas ──────────────────────────────────────────────────────────────

function cntSigned(valor) {
    return (valor > 0 ? "+" : "") + formatEuro(valor)
}

function cntRenderCuentas() {
    const lista = document.getElementById("cuentasLista")
    const total = document.getElementById("cuentasTotal")
    if (!lista) return

    const suma = cntCuentas.reduce((acc, c) => acc + parseEuroNumber(c.saldo), 0)
    if (total) total.textContent = formatEuro(suma)

    // Las comisiones van por su lado: no son entradas ni salidas de ninguna cuenta.
    const comisiones = cntCuentas.reduce((acc, c) => acc + parseEuroNumber(c.comisiones), 0)
    const totalComisiones = document.getElementById("cuentasComisiones")
    if (totalComisiones) totalComisiones.textContent = formatEuro(comisiones)

    const numero = document.getElementById("cuentasNumero")
    if (numero) numero.textContent = String(cntCuentas.length)

    // La variación del total es la suma de la de cada cuenta en lo que va de año.
    const variaciones = new Map(cntCuentas.map((c) => [c.id, cntVariacionYtd(c.id)]))
    const variacionTotal = document.getElementById("cuentasVariacion")
    if (variacionTotal) {
        const absoluta = [...variaciones.values()].reduce((acc, v) => acc + (v?.absoluta || 0), 0)
        variacionTotal.textContent = cntHistorico ? cntSigned(absoluta) : "—"
        variacionTotal.classList.toggle("cuentasPos", Boolean(cntHistorico) && absoluta > 0)
        variacionTotal.classList.toggle("cuentasNeg", Boolean(cntHistorico) && absoluta < 0)
    }

    lista.innerHTML = cntCuentas
        .map((c, indice) => {
            const saldo = parseEuroNumber(c.saldo)
            const peso = suma > 0 && saldo > 0 ? (saldo / suma) * 100 : 0
            return `
                <div class="cntCuenta" data-cuenta="${escapeGastosHtml(c.id)}" draggable="true" title="Ver el detalle de la cuenta. Arrastra para reordenar">
                    <div class="cntCuentaCab">
                        <span class="cntCuentaPunto" style="background:${CNT_PALETA[indice % CNT_PALETA.length]}" aria-hidden="true"></span>
                        <span class="cntCuentaNombre">${escapeGastosHtml(c.nombre)}</span>
                        <div class="rowMenu">
                            <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                            <div class="rowMenuDropdown">
                                <button type="button" class="rowMenuItem" data-cnt-editar-cuenta>Editar</button>
                                ${c.ahorro ? '<button type="button" class="rowMenuItem" data-cnt-abrir-ahorro>Abrir cuenta de ahorro</button>' : ""}
                                ${c.protegida ? "" : '<hr><button type="button" class="rowMenuItem rowMenuItemDanger" data-cnt-eliminar-cuenta>Eliminar</button>'}
                            </div>
                        </div>
                    </div>
                    <div class="cntCuentaEtiquetas">${cntEtiquetasHtml(c)}</div>
                    <div class="cntCuentaSaldo ${saldo < 0 ? "cuentasNeg" : ""}">${formatEuro(saldo)}</div>
                    ${cntVariacionTexto(variaciones.get(c.id))}
                    ${cntMiniatura(c)}
                    <div class="cntCuentaPie">
                        <span>${peso ? `${peso.toFixed(1).replace(".", ",")} % del total` : "&nbsp;"}</span>
                        <span class="cntCuentaPieRango">YTD</span>
                    </div>
                </div>`
        })
        .join("")
}

// Variación de la cuenta desde el 1 de enero, o null sin histórico.
function cntVariacionYtd(cuentaId) {
    if (!cntHistorico) return null
    return cntVariacion(cntPuntosEnRango(cntSerieDe(cuentaId), cntInicioRango("YTD")))
}

function cntVariacionTexto(variacion, sufijo = "en el año") {
    if (!variacion) return '<div class="cntCuentaVariacion">&nbsp;</div>'
    const { absoluta, porcentaje } = variacion
    const clase = absoluta > 0 ? "cuentasPos" : absoluta < 0 ? "cuentasNeg" : ""
    const pct = porcentaje === null ? "" : ` (${porcentaje > 0 ? "+" : ""}${porcentaje.toFixed(1).replace(".", ",")} %)`
    return `<div class="cntCuentaVariacion"><span class="${clase}">${cntSigned(absoluta)}${pct}</span> ${escapeGastosHtml(sufijo)}</div>`
}

// Miniatura del saldo en lo que va de año, siempre YTD como en el boceto: el
// rango se elige en la gráfica ampliada.
function cntMiniatura(cuenta) {
    const ancho = 240
    const alto = 56
    const trazado = cntHistorico
        ? cntTrazadoMini(cntPuntosEnRango(cntSerieDe(cuenta.id), cntInicioRango("YTD")), ancho, alto)
        : ""
    return `
        <div class="cntCuentaMini">
            ${
                trazado
                    ? `<svg viewBox="0 0 ${ancho} ${alto}" preserveAspectRatio="none" aria-hidden="true">
                        <path class="cntMiniArea" d="${cntAreaMini(trazado, alto)}"></path>
                        <path class="cntMiniLinea" d="${trazado}"></path>
                    </svg>`
                    : '<span class="cntCuentaMiniVacia">Sin histórico</span>'
            }
            <button type="button" class="cntCuentaAmpliar" data-cnt-ampliar title="Ampliar la gráfica" aria-label="Ampliar la gráfica de ${escapeGastosHtml(cuenta.nombre)}">
                <span class="icono iconoAmpliar" aria-hidden="true"></span>
            </button>
        </div>`
}

// ── Tarjeta de la derecha ───────────────────────────────────────────────
// Un selector cambia entre el reparto del dinero por cuenta, los gastos por
// categoría del periodo y la evolución del total. Los dos últimos comparten
// periodo; el reparto es el de hoy.

const CNT_VISTAS_LATERAL = [
    { clave: "reparto", etiqueta: "Reparto", titulo: "Reparto por cuenta" },
    { clave: "gastos", etiqueta: "Gastos", titulo: "Gastos por categoría" },
    { clave: "evolucion", etiqueta: "Evolución", titulo: "Evolución del total" }
]
const CNT_VISTA_LATERAL_PREF = "cuentasLateralVista"

function cntRangoTotal() {
    return cntRangoValido(getChartPref(CNT_RANGO_TOTAL_PREF, CNT_RANGO_DEFECTO))
}

function cntVistaLateral() {
    const guardada = getChartPref(CNT_VISTA_LATERAL_PREF, "reparto")
    return CNT_VISTAS_LATERAL.some((v) => v.clave === guardada) ? guardada : "reparto"
}

function cntPeriodoTexto(rango) {
    return CNT_RANGOS.find((r) => r.clave === rango)?.periodo || "el periodo"
}

function cntLateral() {
    return {
        tarjeta: document.getElementById("cuentasLateral"),
        pestanas: document.getElementById("cuentasLateralTabs"),
        titulo: document.getElementById("cuentasLateralTitulo"),
        subtitulo: document.getElementById("cuentasLateralSub"),
        rangos: document.getElementById("cuentasTotalRangos"),
        canvas: document.getElementById("cuentasTotalGrafica"),
        centro: document.getElementById("cuentasLateralCentro"),
        leyenda: document.getElementById("cuentasLateralLeyenda"),
        vacio: document.getElementById("cuentasTotalVacio")
    }
}

function cntRenderLateral() {
    cntGraficaLateral?.destroy()
    cntGraficaLateral = null
    cntLateralTurno += 1
    const el = cntLateral()
    if (!el.tarjeta) return
    const vista = cntVistaLateral()
    const rango = cntRangoTotal()

    el.tarjeta.classList.toggle("cntLateralCircular", vista !== "evolucion")
    if (el.pestanas) {
        el.pestanas.innerHTML = cntSegmento(
            CNT_VISTAS_LATERAL.map((v) => [v.clave, v.etiqueta]),
            vista,
            "data-cnt-lateral",
            "Gráfico"
        )
    }
    if (el.titulo) el.titulo.textContent = CNT_VISTAS_LATERAL.find((v) => v.clave === vista).titulo
    if (el.rangos) {
        el.rangos.hidden = vista === "reparto"
        el.rangos.innerHTML = cntSegmento(
            CNT_RANGOS.map((r) => [r.clave, r.etiqueta]),
            rango,
            "data-cnt-total-rango",
            "Periodo"
        )
    }
    if (el.subtitulo) el.subtitulo.innerHTML = ""
    if (el.leyenda) el.leyenda.innerHTML = ""
    if (el.centro) el.centro.hidden = true
    cntLateralEstado(el, false, "")

    if (vista === "reparto") cntLateralReparto(el)
    else if (vista === "gastos") cntLateralGastos(el, rango, cntLateralTurno)
    else cntLateralEvolucion(el, rango)
}

// Con gráfica se ve la caja; sin ella, el aviso.
function cntLateralEstado(el, hayGrafica, aviso) {
    el.canvas?.closest(".cntGraficaCaja")?.classList.toggle("hidden", !hayGrafica)
    if (el.vacio) {
        el.vacio.textContent = aviso
        el.vacio.classList.toggle("hidden", hayGrafica || !aviso)
    }
}

function cntLateralReparto(el) {
    const partes = cntAgruparPartes(
        cntCuentas.map((c, i) => ({
            etiqueta: c.nombre,
            valor: parseEuroNumber(c.saldo),
            color: CNT_PALETA[i % CNT_PALETA.length]
        }))
    )
    if (el.subtitulo) el.subtitulo.textContent = "Saldo de hoy de cada cuenta"
    cntLateralDonut(el, partes, "No hay saldo positivo que repartir.")
}

async function cntLateralGastos(el, rango, turno) {
    const desde = cntInicioRango(rango)
    const clave = desde === null ? "" : cntFechaIso(desde)
    cntLateralEstado(el, false, "Cargando…")
    let categorias = cntGastosCache[clave]
    if (!categorias) {
        try {
            const datos = await Api.get(`/api/cuentas/gastos-categorias${clave ? `?desde=${clave}` : ""}`)
            categorias = Array.isArray(datos?.categorias) ? datos.categorias : []
            cntGastosCache[clave] = categorias
        } catch (error) {
            console.error("Error cargando los gastos por categoría:", error)
            if (turno === cntLateralTurno) cntLateralEstado(el, false, "No se pudieron cargar los gastos.")
            return
        }
    }
    // Mientras llegaba la respuesta se ha cambiado de pestaña o de periodo.
    if (turno !== cntLateralTurno) return

    const partes = cntAgruparPartes(
        categorias.map((c, i) => ({
            etiqueta: c.categoria,
            valor: Number(c.importe),
            color: CNT_PALETA[i % CNT_PALETA.length]
        }))
    )
    const total = partes.reduce((suma, p) => suma + p.valor, 0)
    if (el.subtitulo && total > 0) {
        el.subtitulo.innerHTML = `<span class="cuentasNeg">${formatEuro(total)}</span> gastados en ${escapeGastosHtml(cntPeriodoTexto(rango))}`
    }
    cntLateralDonut(el, partes, `No hay gastos en ${cntPeriodoTexto(rango)}.`)
}

function cntLateralEvolucion(el, rango) {
    const puntos = cntHistorico
        ? cntPuntosEnRango(cntSerieTotal(cntCuentas.map((c) => cntSerieDe(c.id))), cntInicioRango(rango))
        : []
    if (el.subtitulo && puntos.length) {
        el.subtitulo.innerHTML = cntVariacionTexto(cntVariacion(puntos), `en ${cntPeriodoTexto(rango)}`)
    }
    // La caja se enseña antes de pintar: oculta mide 0 de ancho y el eje
    // calcularía sus marcas como si cupieran todas.
    cntLateralEstado(el, true, "")
    cntGraficaLateral = cntPintarSaldo(el.canvas, puntos)
    cntLateralEstado(
        el,
        Boolean(cntGraficaLateral),
        cntHistorico ? "Todavía no hay movimientos que dibujar." : "No se pudo cargar el histórico de saldos."
    )
}

// Donut con el total en el hueco y una leyenda con importe y porcentaje.
function cntLateralDonut(el, partes, aviso) {
    const total = partes.reduce((suma, p) => suma + p.valor, 0)
    cntLateralEstado(el, true, "")
    cntGraficaLateral = cntPintarDonut(el.canvas, partes, (parte) => cntCentroDonut(el, parte, total))
    cntLateralEstado(el, Boolean(cntGraficaLateral), aviso)
    if (!cntGraficaLateral) return
    if (el.centro) el.centro.hidden = false
    cntCentroDonut(el, null, total)
    cntRenderLeyenda(el, partes, total)
}

// El centro del donut: el total o, con una porción señalada, esa porción.
function cntCentroDonut(el, parte, total) {
    if (!el.centro) return
    el.centro.querySelector(".cntDonutCentroValor").textContent = formatEuro(parte ? parte.valor : total)
    const titulo = el.centro.querySelector(".cntDonutCentroTitulo")
    titulo.textContent = parte ? parte.etiqueta : "Total"
    titulo.title = parte ? parte.etiqueta : ""
    el.centro.querySelector(".cntDonutCentroPct").textContent = parte ? cntPorcentajeTexto(parte.valor, total) : ""
    el.leyenda
        ?.querySelectorAll(".cntLeyendaFila")
        .forEach((fila) => fila.classList.toggle("activa", Boolean(parte) && fila.dataset.etiqueta === parte.etiqueta))
}

// Pasar por una fila de la leyenda resalta su porción, como pasar por el donut.
function cntRenderLeyenda(el, partes, total) {
    if (!el.leyenda) return
    el.leyenda.innerHTML = partes
        .map(
            (p) => `
                <li class="cntLeyendaFila" data-etiqueta="${escapeGastosHtml(p.etiqueta)}">
                    <span class="cntLeyendaColor" style="background:${escapeGastosHtml(p.color)}"></span>
                    <span class="cntLeyendaNombre">${escapeGastosHtml(p.etiqueta)}</span>
                    <span class="cntLeyendaValor">${formatEuro(p.valor)}</span>
                    <span class="cntLeyendaPct">${cntPorcentajeTexto(p.valor, total)}</span>
                </li>`
        )
        .join("")
    // Propiedades y no addEventListener: la leyenda se repinta en cada render
    // y así no se acumulan manejadores.
    el.leyenda.onmouseover = (event) => {
        const fila = event.target.closest(".cntLeyendaFila")
        if (!fila) return
        const parte = partes.find((p) => p.etiqueta === fila.dataset.etiqueta) || null
        cntResaltarPorcion(cntGraficaLateral, parte ? parte.etiqueta : null)
        cntCentroDonut(el, parte, total)
    }
    el.leyenda.onmouseleave = () => {
        cntResaltarPorcion(cntGraficaLateral, null)
        cntCentroDonut(el, null, total)
    }
}

// Arrastrar y soltar como las tarjetas de Activos: la tarjeta se coloca en vivo
// en el hueco donde caerá; al soltar se guarda el orden y, si se cancela, vuelve.
function cntBindOrden(lista) {
    if (!lista) return
    let origen = null
    let soltada = false

    lista.addEventListener("dragstart", (event) => {
        origen = event.target.closest?.(".cntCuenta") || null
        if (!origen) return
        soltada = false
        event.dataTransfer.effectAllowed = "move"
        event.dataTransfer.setData("text/plain", origen.dataset.cuenta)
        // El estilo de hueco se aplica tras generar la imagen de arrastre.
        const tarjeta = origen
        requestAnimationFrame(() => tarjeta.classList.add("arrastrando"))
    })

    lista.addEventListener("dragend", () => {
        origen?.classList.remove("arrastrando")
        origen = null
        if (!soltada) cntRenderCuentas()
        soltada = false
    })

    lista.addEventListener("dragover", (event) => {
        if (!origen) return
        event.preventDefault()
        event.dataTransfer.dropEffect = "move"
        // Las tarjetas van en rejilla: se suelta delante de la primera que, en
        // orden de lectura, queda por debajo del cursor o a su derecha en la
        // misma fila.
        const siguiente = [...lista.querySelectorAll(".cntCuenta")]
            .filter((c) => c !== origen)
            .find((c) => {
                const caja = c.getBoundingClientRect()
                if (event.clientY < caja.top) return true
                return event.clientY <= caja.bottom && event.clientX < caja.left + caja.width / 2
            })
        moveDraggedAssetPreview(lista, origen, siguiente || null)
    })

    lista.addEventListener("drop", async (event) => {
        if (!origen) return
        event.preventDefault()
        soltada = true
        const ids = [...lista.querySelectorAll(".cntCuenta")].map((el) => el.dataset.cuenta)
        if (ids.join("|") === cntCuentas.map((c) => c.id).join("|")) return
        try {
            await Api.put("/api/cuentas/orden", { ids })
            cntCuentas = ids.map((id) => cntCuentas.find((c) => c.id === id)).filter(Boolean)
            window._cuentasDinero = cntCuentas
        } catch (error) {
            showError("No se pudo guardar el orden de las cuentas", error)
            cntRenderCuentas()
        }
    })
}

/**
 * Las etiquetas de una cuenta como chapas, la principal primero.
 * @param {{tipo: string, tipo_etiqueta?: string, etiquetas?: string[], etiquetas_nombres?: string[]}} cuenta
 * @returns {string} HTML.
 */
function cntEtiquetasHtml(cuenta) {
    const ids = Array.isArray(cuenta.etiquetas) && cuenta.etiquetas.length ? cuenta.etiquetas : [cuenta.tipo]
    const nombres = Array.isArray(cuenta.etiquetas_nombres) ? cuenta.etiquetas_nombres : []
    return ids
        .map((id, i) => {
            const nombre =
                nombres[i] || (i === 0 && cuenta.tipo_etiqueta) || cntTipos.find((t) => t.id === id)?.nombre || id
            return `<span class="cntTipo cntTipo-${escapeGastosHtml(id)}">${escapeGastosHtml(nombre)}</span>`
        })
        .join("")
}

// Las etiquetas son solo para identificar la cuenta: se marcan todas las que
// apliquen. Una cuenta nueva empieza como exchange, como antes.
function cntEtiquetasOpciones(cuenta) {
    const marcadas = new Set(cuenta?.etiquetas?.length ? cuenta.etiquetas : [cuenta?.tipo || "exchange"])
    return cntTipos
        .map(
            (t) => `
                <label class="cntEtiquetaOpcion">
                    <input type="checkbox" value="${escapeGastosHtml(t.id)}"${marcadas.has(t.id) ? " checked" : ""}>
                    <span class="cntTipo cntTipo-${escapeGastosHtml(t.id)}">${escapeGastosHtml(t.nombre)}</span>
                </label>`
        )
        .join("")
}

/**
 * Reparte las etiquetas marcadas entre el tipo (la principal, que la base de
 * datos necesita) y las extra. Se conserva el tipo que ya tenía la cuenta si
 * sigue marcado, para que no cambie sin querer; si no, la primera marcada.
 * @param {string[]} marcadas Ids de tipo, en el orden del modal.
 * @param {string} [tipoActual]
 * @returns {{tipo: string, etiquetas: string[]}|null} null si no hay ninguna.
 */
function cntRepartirEtiquetas(marcadas, tipoActual = "") {
    if (!marcadas.length) return null
    const tipo = marcadas.includes(tipoActual) ? tipoActual : marcadas[0]
    return { tipo, etiquetas: marcadas.filter((id) => id !== tipo) }
}

// Sin `cuenta` crea una; con ella, edita el nombre, las etiquetas, el saldo
// inicial y si cobra los dividendos. Que sea remunerada o
// de ahorro se decide en sus ventanas, eligiendo allí esta cuenta.
function cntAbrirModalCuenta(cuenta = null) {
    openGastosCreateModal({
        title: cuenta ? "Editar cuenta" : "Nueva cuenta",
        modalClass: "gastosCreateModalWide mensFormModal",
        bodyHtml: `
            <div class="mensFormGrid">
                <div class="gastosCreateModalField mensFormFieldWide">
                    <label class="assetModalLabel" for="cntCuentaNombre">Nombre</label>
                    <input id="cntCuentaNombre" class="assetModalInput" type="text" maxlength="60" value="${escapeGastosHtml(cuenta?.nombre || "")}" placeholder="Ej: Binance, Degiro, Cuenta nómina">
                </div>
                <div class="gastosCreateModalField mensFormFieldWide">
                    <span class="assetModalLabel">Etiquetas</span>
                    <div class="cntEtiquetasElegir" id="cntCuentaEtiquetas">${cntEtiquetasOpciones(cuenta)}</div>
                    <p class="cuentasHint">Marca todas las que encajen, como un banco que también es broker. Son solo para identificar la cuenta.</p>
                </div>
                <div class="gastosCreateModalField mensFormFieldWide">
                    <label class="assetModalLabel" for="cntCuentaSaldo">Saldo inicial <span class="assetModalLabelHint">opcional</span></label>
                    <input id="cntCuentaSaldo" class="assetModalInput" type="text" inputmode="decimal" value="${escapeGastosHtml(cuenta ? cntSaldoInicialTexto(cuenta) : "")}" placeholder="0,00">
                </div>
                <p class="cuentasHint mensFormFieldWide">Lo que ya había en la cuenta antes de empezar a apuntar movimientos. Las cuentas de ahorro aparecen también en la ventana Cuenta de ahorro.</p>
                <div class="gastosCreateModalField">
                    <label class="assetModalLabel">Cuenta remunerada</label>
                    <label class="cuentaAhorroCheck">
                        <input id="cntCuentaRemunerada" type="checkbox"${cuenta?.remunerada ? " checked" : ""}>
                        <span>Esta cuenta es remunerada</span>
                    </label>
                    <p class="cuentasHint">Sus intereses (Finanzas › Cuenta Remunerada) se suman al saldo. Al desmarcarla se conservan los intereses apuntados, sin vincular.</p>
                </div>
                <div class="gastosCreateModalField">
                    <label class="assetModalLabel">Dividendos</label>
                    <label class="cuentaAhorroCheck">
                        <input id="cntCuentaDividendos" type="checkbox"${cuenta?.dividendos ? " checked" : ""}>
                        <span>Cobrar en esta cuenta los dividendos de mis activos</span>
                    </label>
                    <p class="cuentasHint">Se suman al saldo de la cuenta, pasados a euros.</p>
                </div>
            </div>
        `,
        submitLabel: "Guardar",
        onSubmit: async ({ modal, getValue, setFeedback }) => {
            const etiquetas = cntRepartirEtiquetas(
                [...modal.querySelectorAll(".cntEtiquetaOpcion input:checked")].map((casilla) => casilla.value),
                cuenta?.tipo
            )
            if (!etiquetas) {
                setFeedback("Marca al menos una etiqueta.", true)
                return false
            }
            const cuerpo = {
                nombre: getValue("cntCuentaNombre").trim(),
                saldoInicial: getValue("cntCuentaSaldo").trim(),
                dividendos: Boolean(modal.querySelector("#cntCuentaDividendos")?.checked),
                ...etiquetas
            }
            const remunerada = Boolean(modal.querySelector("#cntCuentaRemunerada")?.checked)
            try {
                if (cuenta) {
                    if (remunerada && !cuenta.remunerada) cuerpo.remunerada = await cntCrearRemunerada(cuerpo.nombre)
                    else if (!remunerada && cuenta.remunerada) cuerpo.remunerada = ""
                    await Api.put(`/api/cuentas/${encodeURIComponent(cuenta.id)}`, cuerpo)
                } else {
                    if (remunerada) cuerpo.remunerada = await cntCrearRemunerada(cuerpo.nombre)
                    await Api.post("/api/cuentas", cuerpo)
                }
                await cntRecargar()
                cntRender()
                return true
            } catch (error) {
                setFeedback(error?.message || "No se pudo guardar la cuenta.", true)
                return false
            }
        }
    })
}

// Da de alta una remunerada sin vincular (con el nombre de la cuenta) y devuelve
// su id; el vínculo lo hace luego el guardado de la cuenta.
async function cntCrearRemunerada(nombre) {
    const data = await Api.get("/api/intereses")
    const cuentas = Array.isArray(data?.cuentas) ? data.cuentas : []
    const id = "cuenta-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    await Api.post("/api/intereses", { cuentas: [...cuentas, { id, nombre, cuenta: "", rows: [] }] })
    return id
}

function cntSaldoInicialTexto(cuenta) {
    return String(cuenta.saldo_inicial || "")
        .replace(".", ",")
        .replace(/,00$/, "")
}

function cntEliminarCuenta(cuenta) {
    openConfirmModal({
        title: "Eliminar cuenta",
        message: `Vas a eliminar la cuenta «${cuenta.nombre}». Solo se puede si no tiene movimientos. Esto no se puede deshacer.`,
        confirmLabel: "Eliminar",
        requireText: cuenta.nombre,
        onConfirm: async () => {
            try {
                await Api.del(`/api/cuentas/${encodeURIComponent(cuenta.id)}`)
            } catch (error) {
                showError("No se pudo eliminar la cuenta", error)
            }
            await cntRecargar()
            cntRender()
        }
    })
}

// ── Transferencias ───────────────────────────────────────────────────────

function cntFechaClave(fecha) {
    const p = splitDividendoFecha(fecha)
    return p ? new Date(Number(p.anio), Number(p.mes) - 1, Number(p.dia) || 1).getTime() : 0
}

function cntOpcionesCuenta(seleccionada) {
    return cntCuentas
        .map(
            (c) =>
                `<option value="${escapeGastosHtml(c.id)}"${c.id === seleccionada ? " selected" : ""}>${escapeGastosHtml(c.nombre)} (${escapeGastosHtml(c.tipo_etiqueta || c.tipo)})</option>`
        )
        .join("")
}

// Con `transferencia`, edita esa; sin ella, crea una nueva, saliendo de
// `origenPorDefecto` si se da (la cuenta abierta en su ventana). `alGuardar`
// repinta la página que lo abre; por defecto, esta.
function cntAbrirModalTransferencia(transferencia = null, origenPorDefecto = "", alGuardar = cntRecargarYPintar) {
    const origen = transferencia?.origen || origenPorDefecto || "banco"
    const destino = transferencia?.destino || cntCuentas.find((c) => c.id !== origen)?.id || "ahorro"

    openGastosCreateModal({
        title: transferencia ? "Editar transferencia" : "Nueva transferencia",
        // Dos columnas, como el modal de Mensualidades: en una sola no cabía sin scroll.
        modalClass: "gastosCreateModalWide mensFormModal",
        bodyHtml: `
            <div class="mensFormGrid">
                <div class="gastosCreateModalField">
                    <label class="assetModalLabel" for="cntTransOrigen">De la cuenta</label>
                    <select id="cntTransOrigen" class="assetModalSelect">${cntOpcionesCuenta(origen)}</select>
                </div>
                <div class="gastosCreateModalField">
                    <label class="assetModalLabel" for="cntTransDestino">A la cuenta</label>
                    <select id="cntTransDestino" class="assetModalSelect">${cntOpcionesCuenta(destino)}</select>
                </div>
                <div class="gastosCreateModalField">
                    <label class="assetModalLabel" for="cntTransFecha">Fecha</label>
                    <input id="cntTransFecha" class="assetModalInput" type="text" value="${escapeGastosHtml(transferencia?.fecha || todayDateString())}" placeholder="dd-mm-aaaa">
                </div>
                <div class="gastosCreateModalField">
                    <label class="assetModalLabel" for="cntTransCantidad">Cantidad</label>
                    <input id="cntTransCantidad" class="assetModalInput" type="text" inputmode="decimal" value="${escapeGastosHtml(transferencia?.cantidad || "")}" placeholder="0,00">
                </div>
                <div class="gastosCreateModalField">
                    <label class="assetModalLabel" for="cntTransComision">Comisión <span class="assetModalLabelHint">opcional · la paga el origen</span></label>
                    <input id="cntTransComision" class="assetModalInput" type="text" inputmode="decimal" value="${escapeGastosHtml(transferencia?.comision || "")}" placeholder="0,00">
                </div>
                <div class="gastosCreateModalField">
                    <label class="assetModalLabel" for="cntTransConcepto">Concepto <span class="assetModalLabelHint">opcional</span></label>
                    <input id="cntTransConcepto" class="assetModalInput" type="text" maxlength="120" value="${escapeGastosHtml(transferencia?.concepto || "")}" placeholder="Ej: Compra de cripto">
                </div>
                <div class="gastosCreateModalField mensFormFieldWide">
                    <label class="assetModalLabel" for="cntTransNota">Nota <span class="assetModalLabelHint">opcional</span></label>
                    <textarea id="cntTransNota" class="assetModalInput movNotaInput" rows="2" maxlength="300" placeholder="Opcional: motivo de la transferencia…">${escapeGastosHtml(transferencia?.nota || "")}</textarea>
                </div>
            </div>
            <p class="cuentasHint">Mover dinero entre tus cuentas no es un gasto ni un ingreso: no cuenta en Gastos, Ingresos ni en la tasa de ahorro. La comisión se suma a lo que sale de la cuenta de origen; la de destino recibe solo la cantidad.</p>
        `,
        submitLabel: "Guardar",
        onSubmit: async ({ getValue, setFeedback }) => {
            const cuerpo = {
                origen: getValue("cntTransOrigen"),
                destino: getValue("cntTransDestino"),
                fecha: getValue("cntTransFecha").trim(),
                cantidad: getValue("cntTransCantidad").trim(),
                comision: getValue("cntTransComision").trim(),
                concepto: getValue("cntTransConcepto").trim(),
                nota: getValue("cntTransNota").trim()
            }
            try {
                if (transferencia) await Api.put(`/api/transferencias/${transferencia.id}`, cuerpo)
                else await Api.post("/api/transferencias", cuerpo)
                await alGuardar()
                return true
            } catch (error) {
                setFeedback(error?.message || "No se pudo guardar la transferencia.", true)
                return false
            }
        }
    })
}

function cntEliminarTransferencia(transferencia, alGuardar = cntRecargarYPintar) {
    openConfirmModal({
        title: "Eliminar transferencia",
        message: "El dinero vuelve a su cuenta de origen. No se puede deshacer.",
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            try {
                await Api.del(`/api/transferencias/${transferencia.id}`)
            } catch (error) {
                showError("No se pudo eliminar la transferencia", error)
            }
            await alGuardar()
        }
    })
}

// Refresco por defecto de los modales de transferencia: el de esta página.
async function cntRecargarYPintar() {
    await cntRecargar()
    cntRender()
}

function cntDescargarCsv() {
    const filas = cntTransferencias.map((t) => ({
        Fecha: t.fecha,
        Origen: t.origen_nombre,
        Destino: t.destino_nombre,
        Concepto: t.concepto,
        Cantidad: parseEuroNumber(t.cantidad),
        Comision: parseEuroNumber(t.comision),
        Nota: t.nota || ""
    }))
    downloadCsvFile("transferencias.csv", filas)
}

// Todas las transferencias, de todos los años. La comisión no se dibuja: no
// llega a ninguna cuenta.
function cntAbrirGrafo() {
    abrirGrafoFlujos({
        titulo: "Movimientos entre cuentas",
        subtitulo: "Todos los años",
        movimientos: cntTransferencias.map((t) => ({
            origen: t.origen_nombre || cntNombre(t.origen),
            destino: t.destino_nombre || cntNombre(t.destino),
            cantidad: parseEuroNumber(t.cantidad)
        })),
        formato: formatEuro,
        vacio: "No hay transferencias en este periodo."
    })
}

function cntBind() {
    const trigger = document.querySelector("#cuentasActionsMenu .pageActionsMenuTrigger")
    const menu = document.getElementById("cuentasActionsDropdown")
    if (trigger && menu) {
        trigger.addEventListener("click", (e) => {
            e.stopPropagation()
            menu.classList.toggle("open")
        })
        menu.addEventListener("click", () => menu.classList.remove("open"))
        // El listener es del documento, que sobrevive a la página: se retira solo
        // en cuanto el menú ya no está en pantalla.
        const cerrar = () => {
            if (!menu.isConnected) {
                document.removeEventListener("click", cerrar)
                return
            }
            menu.classList.remove("open")
        }
        document.addEventListener("click", cerrar)
    }

    const on = (id, handler) => document.getElementById(id)?.addEventListener("click", handler)
    on("cuentasNuevaCuentaBtn", () => cntAbrirModalCuenta())
    on("cuentasCsvBtn", cntDescargarCsv)
    on("cuentasGrafoBtn", cntAbrirGrafo)
    // Sin año elegido el informe es del año en curso.
    on("cuentasInformeBtn", (e) => descargarInformeFinanzas("", e.currentTarget))

    document.getElementById("cuentasLateral")?.addEventListener("click", (event) => {
        const vista = event.target.closest("[data-cnt-lateral]")
        const rango = event.target.closest("[data-cnt-total-rango]")
        if (vista) setChartPref(CNT_VISTA_LATERAL_PREF, vista.dataset.cntLateral)
        else if (rango) setChartPref(CNT_RANGO_TOTAL_PREF, rango.dataset.cntTotalRango)
        else return
        cntRenderLateral()
    })

    cntBindOrden(document.getElementById("cuentasLista"))

    document.getElementById("cuentasLista")?.addEventListener("click", (event) => {
        const tarjeta = event.target.closest("[data-cuenta]")
        const cuenta = tarjeta && cntCuentas.find((c) => c.id === tarjeta.dataset.cuenta)
        if (!cuenta) return
        if (event.target.closest("[data-cnt-editar-cuenta]")) return cntAbrirModalCuenta(cuenta)
        if (event.target.closest("[data-cnt-eliminar-cuenta]")) return cntEliminarCuenta(cuenta)
        if (event.target.closest("[data-cnt-abrir-ahorro]")) {
            document.querySelector('[data-page="cuentaAhorro"]')?.click()
            return
        }
        if (event.target.closest(".rowMenu")) return
        if (event.target.closest("[data-cnt-ampliar]")) return cntAbrirPanel("graficos", cuenta.id)
        // Pulsar la tarjeta (fuera de su menú) abre el detalle de la cuenta.
        cntAbrirPanel("resumen", cuenta.id)
    })
}
