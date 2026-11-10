// Panel de alertas: barra con filtros, formulario plegable y lista.
//
// Lo usan la página «Alertas > Todas las alertas» (todas las alertas, con
// filtros) y la pestaña «Alertas» de la ficha de cada activo (con el activo ya
// fijado). Un solo componente para los dos sitios: crear una alerta desde la
// ficha o desde el menú es exactamente lo mismo.
//
// Junta dos fuentes del servidor:
//   * /api/alertas — alertas de precio (sube a / baja a / variación del día),
//     que saltan una sola vez (stores/alertas_store.py).
//   * /api/alertas-reglas — el resto de tipos, que siguen vigilando después de
//     avisar (stores/reglas_alerta_store.py). El catálogo de tipos llega del
//     servidor y decide qué campos pide el formulario y qué valores admite.
//
// Aquí solo hay presentación: textos cortos, iconos y orden de los tipos.

const alertasGruposOrden = ["Precio", "Movimiento", "Posición", "Cotización", "Cartera"]
const alertasUnidadTexto = { "%": "%", EUR: "€" }
let alertasPanelContador = 0

const alertasIconoGrupo = {
    Precio: "iconoGraficoLinea",
    Movimiento: "iconoUmbral",
    Posición: "iconoBillete",
    Cotización: "iconoReloj",
    Cartera: "iconoPortfolio"
}

// Nombre corto del tipo en el selector y explicación de una línea debajo.
const alertasTextoTipo = {
    "precio:sube_a": ["Sube a", "Avisa una vez cuando el precio llega al valor o lo supera."],
    "precio:baja_a": ["Baja a", "Avisa una vez cuando el precio llega al valor o baja de él."],
    "precio:var_dia": [
        "Variación del día",
        "Avisa una vez cuando el activo se mueve en el día ese %, al alza o a la baja."
    ],
    "regla:caida": [
        "Caída brusca",
        "Avisa si cae ese % en menos del tiempo elegido, medido desde el máximo de ese tramo."
    ],
    "regla:subida": [
        "Subida brusca",
        "Avisa si sube ese % en menos del tiempo elegido, medido desde el mínimo de ese tramo."
    ],
    "regla:rentabilidad": [
        "Rentabilidad",
        "Avisa cuando tu posición gana o pierde ese % o esos euros, con comisiones. Repite solo si vuelve a cruzarlo."
    ],
    "regla:precio_medio": [
        "Precio medio",
        "Avisa cuando el precio se aleja ese % de tu precio medio de compra. Repite solo si vuelve a cruzarlo."
    ],
    "regla:sin_cotizacion": [
        "Sin cotización",
        "Avisa si no se puede cotizar durante ese tiempo: sin precio, sus otras alertas no pueden saltar."
    ],
    "regla:cartera_valor": ["Valor total", "Avisa cuando el valor de la cartera, en euros, cruza ese importe."],
    "regla:cartera_caida": ["Caída de la cartera", "Avisa si el valor total cae ese % en menos del tiempo elegido."],
    "regla:peso": ["Peso de un activo", "Avisa cuando un activo pasa a pesar más de ese % del valor de la cartera."]
}

function alertasTiempo(minutos) {
    return minutos >= 60 ? `${minutos / 60} h` : `${minutos} min`
}

function alertasFecha(segundos) {
    if (!segundos) return ""
    return new Date(segundos * 1000).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })
}

// El servidor guarda los números con punto decimal; la interfaz los enseña con coma.
function alertasNumeroTexto(texto) {
    return String(texto ?? "").replace(".", ",")
}

// Un precio legible, con los mismos decimales que el aviso de Telegram: dos, o
// hasta seis si vale menos de 1 (cripto barata).
function alertasPrecioLegible(texto) {
    const numero = Number(texto)
    if (texto === "" || texto == null || !Number.isFinite(numero)) return alertasNumeroTexto(texto)
    const decimales = Math.abs(numero) >= 1 ? 2 : 6
    return numero.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: decimales })
}

function alertasEtiquetaActivo(activo) {
    if (!activo) return ""
    return activo.symbol && activo.symbol !== activo.name ? `${activo.name} (${activo.symbol})` : activo.name
}

function alertasRellenarSelect(select, opciones, valorPrevio = "") {
    if (!select) return
    select.innerHTML = opciones
        .map(([valor, texto]) => `<option value="${escapeHtml(String(valor))}">${escapeHtml(texto)}</option>`)
        .join("")
    const previo = String(valorPrevio ?? "")
    if (opciones.some(([valor]) => String(valor) === previo)) select.value = previo
}

function alertasIcono(grupo) {
    return `<span class="alFilaIcono alFilaIcono--${alertasGruposOrden.indexOf(grupo)}"><span class="icono ${alertasIconoGrupo[grupo] || "iconoAviso"}" aria-hidden="true"></span></span>`
}

// ── Modelo ──────────────────────────────────────────────────────────────────

// Tipos que ofrece el formulario. Las alertas de precio se adaptan a la misma
// forma que el catálogo de reglas para tratarlas igual al pintar el formulario.
function alertasTiposDelPanel(datos, conActivoFijo) {
    const precio = Object.entries(datos.condiciones || {}).map(([clave, etiqueta]) => ({
        id: `precio:${clave}`,
        fuente: "precio",
        clave,
        etiqueta,
        grupo: "Precio",
        ambito: "activoObligatorio",
        unidades: [],
        sentidos: {},
        ventanas: [],
        etiquetaVentana: "",
        usaValor: true
    }))
    const reglas = (datos.tipos || [])
        .filter((tipo) => !conActivoFijo || tipo.ambito === "activo")
        .map((tipo) => ({ ...tipo, id: `regla:${tipo.clave}`, fuente: "regla" }))
    return [...precio, ...reglas]
}

// Frase corta de una regla: «Cae 5 % en menos de 1 h», «Pérdida ≥ 500,00 €»…
function alertasFraseRegla(regla, tipo) {
    const unidad = alertasUnidadTexto[regla.unidad] || regla.unidad
    const valor = `${regla.unidad === "EUR" ? alertasPrecioLegible(regla.valor) : alertasNumeroTexto(regla.valor)} ${unidad}`
    const ventana = alertasTiempo(regla.ventanaMin)
    const arriba = regla.sentido === "arriba"
    switch (regla.tipo) {
        case "caida":
            return `Cae ${valor} en menos de ${ventana}`
        case "subida":
            return `Sube ${valor} en menos de ${ventana}`
        case "rentabilidad":
            return `${arriba ? "Ganancia" : "Pérdida"} ≥ ${valor}`
        case "precio_medio":
            return `${valor} ${arriba ? "por encima" : "por debajo"} de tu precio medio`
        case "sin_cotizacion":
            return `Sin cotización durante más de ${ventana}`
        case "cartera_valor":
            return `Valor de la cartera ${arriba ? "≥" : "≤"} ${valor}`
        case "cartera_caida":
            return `La cartera cae ${valor} en menos de ${ventana}`
        case "peso":
            return `Pesa más del ${valor} de la cartera`
        default:
            return tipo.etiqueta
    }
}

function alertasFrasePrecio(alerta, moneda) {
    if (alerta.condicion === "var_dia") return `Se mueve ±${alertasNumeroTexto(alerta.valor)} % en el día`
    const signo = alerta.condicion === "sube_a" ? "≥" : "≤"
    return `Precio ${signo} ${alertasPrecioLegible(alerta.valor)} ${moneda}`.trim()
}

function alertasAmbitoRegla(regla, tipo) {
    if (tipo.ambito === "cartera") return "Cartera"
    if (!regla.assetId) return "Todos los activos en cartera"
    return alertasEtiquetaActivo({ name: regla.activoNombre || regla.assetId, symbol: regla.activoSimbolo })
}

// Una fila común para alertas de precio y reglas: es lo que pintan la lista y
// lo que filtran los filtros.
function alertasFilasDe(datos, activosPorId) {
    const tiposPorClave = Object.fromEntries((datos.tipos || []).map((tipo) => [tipo.clave, tipo]))

    const precio = (datos.alertasPrecio || []).map((alerta) => {
        const activo = activosPorId.get(alerta.assetId)
        const moneda = activo?.currency || ""
        const saltada = !alerta.activa && alerta.disparada
        return {
            fuente: "precio",
            id: alerta.id,
            grupo: "Precio",
            assetId: alerta.assetId,
            activa: alerta.activa,
            estado: saltada ? "saltada" : alerta.activa ? "activa" : "pausada",
            ambito: activo ? alertasEtiquetaActivo(activo) : alerta.assetId,
            titulo: alertasFrasePrecio(alerta, moneda),
            meta: saltada
                ? `Saltó el ${alertasFecha(alerta.disparada)} con ${alertasPrecioLegible(alerta.precioDisparo)} ${moneda}`
                : "Avisa una vez",
            nota: alerta.nota
        }
    })

    const reglas = (datos.reglas || [])
        .filter((regla) => tiposPorClave[regla.tipo])
        .map((regla) => {
            const tipo = tiposPorClave[regla.tipo]
            return {
                fuente: "regla",
                id: regla.id,
                grupo: tipo.grupo,
                assetId: regla.assetId,
                activa: regla.activa,
                estado: regla.activa ? "activa" : "pausada",
                ambito: alertasAmbitoRegla(regla, tipo),
                titulo: alertasFraseRegla(regla, tipo),
                meta: `Sin repetir durante ${alertasTiempo(regla.enfriamientoMin)}`,
                nota: regla.nota
            }
        })

    // Las activas primero, y dentro de cada estado en el orden de los grupos.
    const ordenGrupo = (fila) => alertasGruposOrden.indexOf(fila.grupo)
    return [...precio, ...reglas].sort((a, b) => b.activa - a.activa || ordenGrupo(a) - ordenGrupo(b))
}

const alertasTextoEstado = { activa: "Vigilando", pausada: "En pausa", saltada: "Saltó" }

function alertasPintarFila(fila, conAmbito) {
    const titulo = conAmbito
        ? `<span class="alFilaAmbito">${escapeHtml(fila.ambito)}</span><span class="alFilaSeparador">·</span>${escapeHtml(fila.titulo)}`
        : escapeHtml(fila.titulo)
    const meta = [fila.grupo, fila.meta].filter(Boolean).join(" · ")
    return `
        <div class="alFila alFila--${fila.estado}" data-fuente="${fila.fuente}" data-alerta-id="${escapeHtml(String(fila.id))}">
            ${alertasIcono(fila.grupo)}
            <div class="alFilaTexto">
                <div class="alFilaTitulo">${titulo}</div>
                <div class="alFilaMeta">${escapeHtml(meta)}${fila.nota ? ` · <em>${escapeHtml(fila.nota)}</em>` : ""}</div>
            </div>
            <span class="alFilaEstado alFilaEstado--${fila.estado}">${alertasTextoEstado[fila.estado]}</span>
            <label class="ajustesSwitch alFilaSwitch" title="${fila.activa ? "Pausar" : "Activar"}">
                <input type="checkbox" data-accion="estado" ${fila.activa ? "checked" : ""} aria-label="${fila.activa ? "Pausar" : "Activar"} la alerta">
                <span class="ajustesSwitchTrack"></span>
            </label>
            <button type="button" class="alFilaBorrar" data-accion="borrar" title="Borrar" aria-label="Borrar la alerta">
                <span class="icono iconoBorrar" aria-hidden="true"></span>
            </button>
        </div>`
}

// Atajos del estado vacío: las alertas que más se suelen querer, con el
// formulario ya relleno para revisarlas antes de crearlas.
function alertasSugerencias(conActivoFijo) {
    const sugerencias = [
        { texto: "Caída del 5 % en menos de 1 h", tipo: "regla:caida", valor: "5", ventana: 60 },
        { texto: "Pérdida del 20 % en la posición", tipo: "regla:rentabilidad", sentido: "abajo", valor: "20" },
        { texto: "10 % por debajo del precio medio", tipo: "regla:precio_medio", sentido: "abajo", valor: "10" }
    ]
    if (!conActivoFijo) {
        sugerencias.push({
            texto: "La cartera cae un 3 % en 24 h",
            tipo: "regla:cartera_caida",
            valor: "3",
            ventana: 1440
        })
    }
    return sugerencias
}

// ── Componente ──────────────────────────────────────────────────────────────

function alertasPanelHtml(p, asset) {
    const campo = (clave, etiqueta, control, clase = "") => `
        <div class="alCampo ${clase}" data-campo="${clave}">
            <label class="alCampoEtiqueta" for="${p}${clave}" id="${p}${clave}Etiqueta">${etiqueta}</label>
            ${control}
        </div>`
    const select = (clave) => `<select id="${p}${clave}" class="ajustesSelect alCampoControl"></select>`
    const filtroActivo = asset
        ? ""
        : `<span class="alPanelFiltroActivo" id="${p}FiltroActivoCaja"><select id="${p}FiltroActivo" class="ajustesSelect alCampoControl" aria-label="Filtrar por activo"></select></span>`
    return `
        <div class="alPanel${asset ? " alPanel--ficha" : ""}">
            <div class="alPanelBarra">
                <div class="mToggleGroup alPanelFiltros" id="${p}Filtros" role="group" aria-label="Filtrar por tipo"></div>
                ${filtroActivo}
                <button type="button" class="primaryButton alPanelNueva" id="${p}Nueva">+ Nueva alerta</button>
            </div>

            <form id="${p}Form" class="alPanelForm" autocomplete="off" hidden>
                <div class="alPanelFormCabecera">
                    <span class="alPanelFormTitulo">Nueva alerta${asset ? ` · ${escapeHtml(alertasEtiquetaActivo(asset))}` : ""}</span>
                    <button type="button" class="alPanelCerrar" id="${p}Cerrar" aria-label="Cerrar"><span class="icono iconoCerrar" aria-hidden="true"></span></button>
                </div>
                <div class="alPanelTipos" id="${p}Tipos"></div>
                <p class="alPanelAyuda" id="${p}Ayuda"></p>
                <div class="alPanelCampos">
                    ${campo("Activo", "Activo", select("Activo"), "alCampoAncho")}
                    ${campo("Sentido", "Condición", select("Sentido"))}
                    ${campo("Valor", "Valor", `<input id="${p}Valor" class="ajustesInput alCampoControl" type="text" inputmode="decimal" placeholder="0,00">`)}
                    ${campo("Unidad", "En", select("Unidad"))}
                    ${campo("Ventana", "En menos de", select("Ventana"))}
                    ${campo("Enfriamiento", "No repetir durante", select("Enfriamiento"))}
                    ${campo("Nota", "Nota", `<input id="${p}Nota" class="ajustesInput alCampoControl" type="text" maxlength="200" placeholder="Opcional">`, "alCampoAncho")}
                </div>
                <div class="alPanelFormPie">
                    <button type="button" class="secondaryButton" id="${p}Cancelar">Cancelar</button>
                    <button type="submit" class="primaryButton">Crear alerta</button>
                </div>
            </form>

            <div id="${p}Lista" class="alPanelLista"></div>
        </div>`
}

/**
 * Monta el panel de alertas en `contenedor`.
 *
 * @param {HTMLElement} contenedor Donde se pinta el panel.
 * @param {object} opciones
 * @param {object|null} opciones.asset Activo fijo (pestaña de la ficha) o null (página central).
 * @param {(activas: number) => void} [opciones.alCambiar] Se llama tras cada carga con las alertas activas.
 */
async function crearPanelAlertas(contenedor, { asset = null, alCambiar = null } = {}) {
    alertasPanelContador += 1
    const p = `alp${alertasPanelContador}`
    const estado = { datos: {}, tipos: [], activos: [], activosPorId: new Map(), tipoId: "", grupo: "" }
    const el = (clave) => document.getElementById(`${p}${clave}`)
    const mostrar = (clave, visible) => {
        const envoltorio = contenedor.querySelector(`[data-campo="${clave}"]`)
        if (envoltorio) envoltorio.hidden = !visible
    }
    const avisar = (texto, tipo = "success") => window.showToast?.(texto, { type: tipo })

    contenedor.innerHTML = alertasPanelHtml(p, asset)

    const tipoActual = () => estado.tipos.find((tipo) => tipo.id === estado.tipoId) || estado.tipos[0]

    function unidadActual(tipo) {
        if (tipo.fuente === "precio") {
            if (tipo.clave === "var_dia") return "%"
            return estado.activosPorId.get(asset?.id || el("Activo")?.value)?.currency || ""
        }
        const unidad = tipo.unidades.length > 1 ? el("Unidad")?.value : tipo.unidades[0]
        return alertasUnidadTexto[unidad] || unidad || ""
    }

    function actualizarEtiquetaValor() {
        const tipo = tipoActual()
        const etiqueta = el("ValorEtiqueta")
        const unidad = tipo ? unidadActual(tipo) : ""
        if (etiqueta) etiqueta.textContent = unidad ? `Valor (${unidad})` : "Valor"
    }

    function pintarTipos() {
        const porGrupo = alertasGruposOrden
            .map((grupo) => [grupo, estado.tipos.filter((t) => t.grupo === grupo)])
            .filter(([, tipos]) => tipos.length)
        el("Tipos").innerHTML = porGrupo
            .map(
                ([grupo, tipos]) => `
                <div class="alPanelTiposGrupo">
                    <span class="alPanelTiposNombre">${escapeHtml(grupo)}</span>
                    <div class="alPanelTiposBotones">
                        ${tipos
                            .map(
                                (t) =>
                                    `<button type="button" class="alPanelTipo" data-tipo="${escapeHtml(t.id)}" aria-pressed="${t.id === estado.tipoId}">${escapeHtml(alertasTextoTipo[t.id]?.[0] || t.etiqueta)}</button>`
                            )
                            .join("")}
                    </div>
                </div>`
            )
            .join("")
    }

    function elegirTipo(tipoId) {
        estado.tipoId = tipoId
        el("Tipos")
            .querySelectorAll(".alPanelTipo")
            .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tipo === tipoId)))
        actualizarCampos()
    }

    function actualizarCampos() {
        const tipo = tipoActual()
        if (!tipo) return
        const esRegla = tipo.fuente === "regla"

        const pideActivo = !asset && tipo.ambito !== "cartera"
        mostrar("Activo", pideActivo)
        if (pideActivo) {
            const opciones = estado.activos.map((a) => [a.id, alertasEtiquetaActivo(a)])
            if (esRegla) opciones.unshift(["", "Todos los activos en cartera"])
            alertasRellenarSelect(el("Activo"), opciones, el("Activo").value)
        }

        const sentidos = Object.entries(tipo.sentidos || {})
        // Con un solo sentido (peso: «supera el») no hay nada que elegir.
        mostrar("Sentido", sentidos.length > 1)
        alertasRellenarSelect(el("Sentido"), sentidos, el("Sentido").value)

        mostrar("Unidad", tipo.unidades.length > 1)
        alertasRellenarSelect(
            el("Unidad"),
            tipo.unidades.map((u) => [u, alertasUnidadTexto[u] || u]),
            el("Unidad").value
        )

        mostrar("Valor", tipo.usaValor)
        mostrar("Ventana", tipo.ventanas.length > 0)
        if (tipo.ventanas.length) {
            el("VentanaEtiqueta").textContent = tipo.etiquetaVentana
            alertasRellenarSelect(
                el("Ventana"),
                tipo.ventanas.map((m) => [m, alertasTiempo(m)]),
                el("Ventana").value || (tipo.ventanas.includes(60) ? 60 : tipo.ventanas[0])
            )
        }
        mostrar("Enfriamiento", esRegla)

        el("Ayuda").textContent = alertasTextoTipo[tipo.id]?.[1] || ""
        actualizarEtiquetaValor()
    }

    function abrirFormulario(sugerencia = null) {
        el("Form").hidden = false
        el("Nueva").hidden = true
        if (sugerencia && estado.tipos.some((t) => t.id === sugerencia.tipo)) {
            elegirTipo(sugerencia.tipo)
            if (sugerencia.sentido) el("Sentido").value = sugerencia.sentido
            if (sugerencia.ventana) el("Ventana").value = String(sugerencia.ventana)
            if (!asset && el("Activo").options.length && sugerencia.tipo.startsWith("regla:")) el("Activo").value = ""
            el("Valor").value = sugerencia.valor || ""
            ;[el("Sentido"), el("Ventana"), el("Activo")].forEach((s) => s.dispatchEvent(new Event("change")))
        }
        el("Valor").focus()
    }

    function cerrarFormulario() {
        el("Form").hidden = true
        el("Nueva").hidden = false
        el("Valor").value = ""
        el("Nota").value = ""
    }

    function pintarFiltros(filas) {
        const cuenta = (grupo) => filas.filter((f) => !grupo || f.grupo === grupo).length
        const grupos = ["", ...alertasGruposOrden.filter((g) => cuenta(g))]
        if (estado.grupo && !grupos.includes(estado.grupo)) estado.grupo = ""
        const filtros = el("Filtros")
        filtros.hidden = filas.length === 0
        filtros.innerHTML = grupos
            .map(
                (g) =>
                    `<button type="button" class="mToggleBtn${g === estado.grupo ? " active" : ""}" data-grupo="${escapeHtml(g)}">${escapeHtml(g || "Todas")} <span class="alPanelCuenta">${cuenta(g)}</span></button>`
            )
            .join("")

        const filtroActivo = el("FiltroActivo")
        if (filtroActivo) {
            // Se oculta la caja y no el <select>: el desplegable propio de la app
            // (.csWrapper) vive a su lado y seguiría a la vista.
            el("FiltroActivoCaja").hidden = filas.length === 0
            alertasRellenarSelect(
                filtroActivo,
                [
                    ["", "Todos los activos"],
                    ["*general*", "Generales y de cartera"],
                    ...estado.activos.map((a) => [a.id, alertasEtiquetaActivo(a)])
                ],
                filtroActivo.value
            )
        }
    }

    function pintarLista() {
        const lista = el("Lista")
        const todas = alertasFilasDe(estado.datos, estado.activosPorId)
        alCambiar?.(todas.filter((f) => f.activa).length)
        pintarFiltros(todas)

        if (!todas.length) {
            lista.innerHTML = `
                <div class="alPanelVacio">
                    <strong>${asset ? "Este activo no tiene alertas" : "Aún no tienes alertas"}</strong>
                    <span>Te avisaremos por Telegram aunque la web esté cerrada. Empieza por una de estas:</span>
                    <div class="alPanelSugerencias">
                        ${alertasSugerencias(!!asset)
                            .map(
                                (s, i) =>
                                    `<button type="button" class="alPanelSugerencia" data-sugerencia="${i}">${escapeHtml(s.texto)}</button>`
                            )
                            .join("")}
                    </div>
                </div>`
            return
        }

        const activo = el("FiltroActivo")?.value || ""
        let filas = estado.grupo ? todas.filter((f) => f.grupo === estado.grupo) : todas
        if (activo === "*general*") filas = filas.filter((f) => !f.assetId)
        else if (activo) filas = filas.filter((f) => f.assetId === activo)

        lista.innerHTML = filas.length
            ? filas.map((f) => alertasPintarFila(f, !asset || !f.assetId)).join("")
            : `<div class="alPanelVacio alPanelVacio--filtro">Ninguna alerta con este filtro.</div>`
    }

    async function cargar({ completa = false } = {}) {
        try {
            const consulta = asset ? `?assetId=${encodeURIComponent(asset.id)}` : ""
            const [precio, reglas, activos] = await Promise.all([
                Api.get(`/api/alertas${consulta}`),
                Api.get(`/api/alertas-reglas${consulta}`),
                completa && !asset ? Api.get("/api/alertas/activos") : Promise.resolve(null)
            ])
            estado.datos = {
                condiciones: precio.condiciones || {},
                alertasPrecio: precio.alertas || [],
                tipos: reglas.tipos || [],
                reglas: reglas.reglas || [],
                enfriamientos: reglas.enfriamientos || []
            }
            if (completa) {
                estado.activos = asset ? [asset] : activos?.activos || []
                estado.activosPorId = new Map(estado.activos.map((a) => [a.id, a]))
                estado.tipos = alertasTiposDelPanel(estado.datos, !!asset)
                estado.tipoId = estado.tipos.find((t) => t.id === "regla:caida")?.id || estado.tipos[0]?.id
                pintarTipos()
                alertasRellenarSelect(
                    el("Enfriamiento"),
                    estado.datos.enfriamientos.map((m) => [m, alertasTiempo(m)]),
                    240
                )
                actualizarCampos()
            }
            pintarLista()
        } catch (error) {
            avisar(Api.describeError(error), "error")
        }
    }

    async function crear(evento) {
        evento.preventDefault()
        const tipo = tipoActual()
        const assetId = asset?.id || (tipo.ambito === "cartera" ? "" : el("Activo")?.value || "")
        const valor = el("Valor").value.trim()
        const nota = el("Nota").value.trim()

        if (tipo.usaValor && !valor) {
            avisar("Indica el valor de la alerta", "warning")
            el("Valor").focus()
            return
        }
        if (tipo.fuente === "precio" && !assetId) {
            avisar("Elige un activo con símbolo de mercado", "warning")
            return
        }

        try {
            if (tipo.fuente === "precio") {
                await Api.post("/api/alertas", { assetId, condicion: tipo.clave, valor, nota })
            } else {
                await Api.post("/api/alertas-reglas", {
                    tipo: tipo.clave,
                    assetId,
                    sentido: el("Sentido").value || "",
                    unidad: tipo.unidades.length > 1 ? el("Unidad").value : "",
                    valor: tipo.usaValor ? valor : "",
                    ventanaMin: tipo.ventanas.length ? Number(el("Ventana").value) : 0,
                    enfriamientoMin: Number(el("Enfriamiento").value),
                    nota
                })
            }
            cerrarFormulario()
            avisar("Alerta creada")
            await cargar()
        } catch (error) {
            avisar(Api.describeError(error), "error")
        }
    }

    async function accionFila(evento) {
        const control = evento.target.closest("[data-accion]")
        const fila = evento.target.closest("[data-alerta-id]")
        if (!control || !fila) return

        const base = fila.dataset.fuente === "precio" ? "/api/alertas" : "/api/alertas-reglas"
        const id = encodeURIComponent(fila.dataset.alertaId)
        try {
            if (control.dataset.accion === "borrar") {
                if (!window.confirm("¿Borrar esta alerta?")) return
                await Api.del(`${base}/${id}`)
                avisar("Alerta borrada")
            } else {
                await Api.post(`${base}/${id}/estado`, { activa: control.checked })
            }
            await cargar()
        } catch (error) {
            avisar(Api.describeError(error), "error")
            await cargar()
        }
    }

    el("Form").addEventListener("submit", crear)
    el("Nueva").addEventListener("click", () => abrirFormulario())
    el("Cerrar").addEventListener("click", cerrarFormulario)
    el("Cancelar").addEventListener("click", cerrarFormulario)
    el("Tipos").addEventListener("click", (evento) => {
        const boton = evento.target.closest("[data-tipo]")
        if (boton) elegirTipo(boton.dataset.tipo)
    })
    el("Activo").addEventListener("change", actualizarEtiquetaValor)
    el("Unidad").addEventListener("change", actualizarEtiquetaValor)
    el("Filtros").addEventListener("click", (evento) => {
        const boton = evento.target.closest("[data-grupo]")
        if (!boton) return
        estado.grupo = boton.dataset.grupo
        pintarLista()
    })
    el("FiltroActivo")?.addEventListener("change", pintarLista)
    el("Lista").addEventListener("change", accionFila)
    el("Lista").addEventListener("click", (evento) => {
        const sugerencia = evento.target.closest("[data-sugerencia]")
        if (sugerencia) {
            abrirFormulario(alertasSugerencias(!!asset)[Number(sugerencia.dataset.sugerencia)])
            return
        }
        if (evento.target.closest("[data-accion='borrar']")) accionFila(evento)
    })

    await cargar({ completa: true })
}
