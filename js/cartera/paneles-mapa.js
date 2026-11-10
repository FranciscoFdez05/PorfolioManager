// Activos > Paneles: widget del mapa de calor.
//
// Trozo de js/cartera/paneles.js. Comparte con el resto de paneles-*.js el
// ámbito global y se carga detrás de paneles.js, en el orden de index.html.

// ── Widget: mapa de calor ───────────────────────────────────────────────────

/**
 * Los dos mapas comparten el dibujo y se diferencian en la pregunta: el de la
 * cuenta es «cómo va mi dinero» (tamaño por posición, euros movidos, «desde la
 * compra»); el de mercado, «cómo se mueven los activos» (todos del mismo
 * tamaño, con su precio, y admite lo que no está en la cartera).
 */
function pnDefectosMapa(w) {
    const mercado = w.tipo === "mapaMercado"
    return {
        mercado,
        tamano: mercado ? "igual" : "valor",
        eur: !mercado,
        precio: mercado,
        periodos: mercado ? PN_PERIODOS.filter((p) => p.valor !== "todo") : PN_PERIODOS
    }
}

/** Si las baldosas del mapa se rotulan con el nombre del activo (por defecto) o con su símbolo. */
function pnRotuloPorNombre(cfg) {
    return pnOpcion(cfg, "etiqueta", ["nombre", "simbolo"], "nombre") === "nombre"
}

function pnPeriodoMapa(w) {
    return pnOpcion(
        w.cfg,
        "periodo",
        pnDefectosMapa(w).periodos.map((p) => p.valor),
        "dia"
    )
}

function pnPintarMapa(w, cuerpo, ctrls) {
    const turno = pnTurno(w)
    const cfg = w.cfg
    const def = pnDefectosMapa(w)
    const periodo = pnPeriodoMapa(w)
    const tamano = pnOpcion(cfg, "tamano", ["valor", "igual"], def.tamano)
    const forma = pnFormaMapa(cfg)

    ctrls.innerHTML = ""
    const chipActivos = document.createElement("button")
    chipActivos.type = "button"
    chipActivos.className = "pnChip"
    const textoChip = () => pnTextoFiltro(cfg, def.mercado ? "Seguimiento" : "Toda la cartera")
    chipActivos.innerHTML = `<span>${escapeHtml(textoChip())}</span><span class="pnChipFlecha">▾</span>`
    pnControlCabecera(chipActivos, "Activos", (ancla) =>
        pnSelectorActivos(ancla, {
            opciones: pnOpcionesMapa(cfg, def.mercado),
            textoVacio: def.mercado ? "la lista de Seguimiento" : "toda la cartera",
            seleccion: pnLista(cfg, "activos"),
            alCambiar: (ids) => {
                if (ids.length) cfg.activos = ids
                else delete cfg.activos
                pnGuardar()
                // El selector sigue abierto: se repinta el mapa y el texto del
                // chip, no la cabecera entera (cerraría el menú).
                clearTimeout(_pnTimers.get(w.id))
                _pnTimers.set(
                    w.id,
                    setTimeout(() => {
                        pnDibujarMapa(w, cuerpo)
                        chipActivos.querySelector("span").textContent = textoChip()
                        pnRefrescarCabeceraAjustes(w)
                    }, 120)
                )
            }
        })
    )
    ctrls.appendChild(chipActivos)
    pnChip(
        ctrls,
        def.periodos.find((p) => p.valor === periodo).texto,
        def.periodos,
        periodo,
        (v) => {
            if (v === "dia") delete cfg.periodo
            else cfg.periodo = v
            pnGuardar()
            pnPintarWidget(w)
        },
        "Periodo"
    )
    pnChip(
        ctrls,
        PN_FORMAS_MAPA.find((f) => f.valor === forma).texto,
        PN_FORMAS_MAPA,
        forma,
        (v) => {
            if (v === "rejilla") delete cfg.forma
            else cfg.forma = v
            pnGuardar()
            pnPintarWidget(w)
        },
        "Forma"
    )
    pnBotonPrecarga(w, ctrls)
    // En la rejilla todas las casillas son iguales: el tamaño no aplica.
    if (forma === "treemap") {
        pnChip(
            ctrls,
            tamano === "igual" ? "Mismo tamaño" : "Por valor",
            [
                { valor: "valor", texto: "Tamaño por valor de la posición" },
                { valor: "igual", texto: "Todos del mismo tamaño" }
            ],
            tamano,
            (v) => {
                if (v === def.tamano) delete cfg.tamano
                else cfg.tamano = v
                pnGuardar()
                pnPintarWidget(w)
            },
            "Tamaño"
        )
    }

    const leyenda = pnSi(cfg, "leyenda", false)
    cuerpo.innerHTML = `<div class="pnMapa${leyenda ? " pnConLeyenda" : ""}"></div>${
        leyenda ? `<div class="pnMapaLeyenda"><span></span><i></i><span></span></div>` : ""
    }`
    const lienzo = cuerpo.querySelector(".pnMapa")
    pnBindMapa(lienzo)

    const dibujar = () => pnDibujarMapa(w, cuerpo)
    if (periodo !== "dia" && periodo !== "todo" && !_pnHist[periodo]) {
        lienzo.innerHTML = `<div class="pnVacio">Cargando histórico…</div>`
        pnHistorico(periodo).then(() => {
            if (!pnVigente(w, turno)) return
            dibujar()
            pnObservarTamano(w, cuerpo, dibujar)
        })
        return
    }
    dibujar()
    pnObservarTamano(w, cuerpo, dibujar)
}

/**
 * Botón de la cabecera que activa o desactiva la precarga de las vistas previas
 * y, mientras está activa, enseña cuántas lleva cargadas (`pnProgresoPrecarga`).
 *
 * Es un botón suelto y no un desplegable con `_cab`: la misma opción ya está
 * en los ajustes del widget como casilla, y repetirla allí sería un duplicado.
 *
 * @param {object} w Widget del mapa.
 * @param {HTMLElement} ctrls Contenedor de los controles de la cabecera.
 */
function pnBotonPrecarga(w, ctrls) {
    const activa = pnSi(w.cfg, "precargaTv", false)
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "pnChip pnPrecargaBtn"
    btn.setAttribute("aria-pressed", String(activa))
    btn.title = activa
        ? "Quitar la precarga: el gráfico se cargará al pasar el cursor"
        : "Cargar ya todos los gráficos de vista previa (más memoria)"
    btn.innerHTML = `<i class="pnPrecargaBarra"></i><span class="pnPrecargaTexto">Precargar</span>`
    btn.addEventListener("click", () => {
        if (activa) delete w.cfg.precargaTv
        else w.cfg.precargaTv = true
        pnGuardar()
        pnPintarWidget(w)
    })
    ctrls.appendChild(btn)
}

/**
 * Pinta en el botón de precarga del widget cuántas vistas previas van listas.
 * Se busca el botón cada vez porque la cabecera se repinta por su cuenta.
 *
 * @param {object} w Widget del mapa.
 * @param {number} hechos Vistas previas ya cargadas.
 * @param {number} total Vistas previas que hay que cargar.
 */
function pnProgresoPrecarga(w, hechos, total) {
    const btn = pnWidgetEl(w)?.querySelector(".pnPrecargaBtn")
    if (!btn) return
    const acabada = hechos >= total
    btn.classList.toggle("pnPrecargando", !acabada)
    btn.querySelector(".pnPrecargaBarra").style.width = total ? `${(hechos / total) * 100}%` : "0"
    btn.querySelector(".pnPrecargaTexto").textContent = !total
        ? "Precargar"
        : acabada
          ? `Precargados ${total}`
          : `Precargando ${hechos}/${total}`
}

function pnFormaMapa(cfg) {
    return pnOpcion(
        cfg,
        "forma",
        PN_FORMAS_MAPA.map((f) => f.valor),
        "rejilla"
    )
}

function pnEscalaMapa(cfg, periodo) {
    const escala = pnOpcion(cfg, "escala", ["auto", "1", "3", "10", "25", "50"], "auto")
    return escala === "auto" ? PN_ESCALA[periodo] : Number(escala)
}

function pnDibujarMapa(w, cuerpo) {
    const lienzo = cuerpo.querySelector(".pnMapa")
    if (!lienzo) return
    const cfg = w.cfg
    const periodo = pnPeriodoMapa(w)
    const def = pnDefectosMapa(w)
    const rejilla = pnFormaMapa(cfg) === "rejilla"
    // La rejilla no reparte por valor: entra también lo que no tiene posición.
    const igual = rejilla || pnOpcion(cfg, "tamano", ["valor", "igual"], def.tamano) === "igual"
    const agrupar = pnOpcion(cfg, "agrupar", ["no", "tipo", "divisa"], "no")
    const hist = _pnHist[periodo]?.data || {}
    const escala = pnEscalaMapa(cfg, periodo)

    const leyenda = cuerpo.querySelector(".pnMapaLeyenda")
    if (leyenda) {
        const [min, max] = leyenda.querySelectorAll("span")
        min.textContent = `−${escala} %`
        max.textContent = `+${escala} %`
    }

    // El de mercado, sin activos elegidos, enseña la lista de Seguimiento de la Watchlist.
    let items = pnActivosDelWidget(cfg, {
        soloPosiciones: false,
        porDefecto: def.mercado ? pnActivosSeguimiento() : null
    })
    if (!def.mercado && !pnLista(cfg, "activos").length) items = items.filter((a) => a.conPosicion)
    // Por valor, lo que no tiene posición no tiene tamaño: se queda fuera y se
    // avisa, en vez de pintar una baldosa con un tamaño inventado.
    const sinPosicion = igual ? 0 : items.filter((a) => !(a.netoEur > 0.01)).length
    if (!igual) items = items.filter((a) => a.netoEur > 0.01)

    if (!items.length) {
        lienzo.innerHTML = `<div class="pnVacio">${
            sinPosicion
                ? "Los activos elegidos no tienen posición: cambia a «Mismo tamaño»"
                : def.mercado
                  ? pnLista(cfg, "activos").length
                      ? "Ninguno de los activos elegidos es de este tipo"
                      : "No hay activos en Seguimiento: añádelos en Activos › Watchlist o elígelos en «Seguimiento»"
                  : "No hay activos para mostrar"
        }</div>`
        return
    }

    const W = lienzo.clientWidth || 400
    const H = lienzo.clientHeight || 300
    const total = items.reduce((s, a) => s + (igual ? 1 : a.netoEur), 0)

    const enriquecidos = items.map((a) => {
        let valor
        if (periodo === "dia") valor = a.dia
        else if (periodo === "todo") valor = a.invertidoEur > 0 ? a.rendPct : null
        else valor = hist[a.id] ?? null
        const hay = valor !== null && valor !== undefined && Number.isFinite(valor)
        const peso = (igual ? 1 : a.netoEur) / total
        return {
            ...a,
            valor: hay ? valor : null,
            peso,
            mov: hay && a.netoEur > 0 ? hmMovimiento(a.netoEur, valor) : null
        }
    })

    lienzo.innerHTML = ""
    lienzo.classList.toggle("pnMapaRejilla", rejilla)
    // Con la precarga, todas las vistas previas se cargan en segundo plano; sin
    // ella se cancela la que hubiera en curso y el tope de iframes vuelve al normal.
    if (pnSi(cfg, "precargaTv", false)) {
        mapaDiaPrecargarTv(
            enriquecidos.map((a) => a.tv),
            (hechos, total) => pnProgresoPrecarga(w, hechos, total)
        )
    } else {
        mapaDiaPrecargarTv([])
        mapaDiaPrecalentarTv(enriquecidos.find((a) => a.tv)?.tv)
    }

    // «Desde la compra» no es una ventana de tiempo común a todos: sin línea.
    const periodoLinea = periodo === "todo" ? null : periodo
    if (rejilla) {
        pnRejilla(lienzo, enriquecidos, cfg, periodo, escala, def, agrupar)
        mapaDiaActivar(lienzo, periodoLinea, (celda, puntos, ventana) => {
            pnRejillaExtremos(celda, puntos)
            pnRejillaEje(celda, ventana)
            const cerrado = celda.querySelector(".pnRjCerrado")
            if (cerrado) cerrado.textContent = ventana?.cerrado ? "Cerrado" : ""
        })
        return
    }
    lienzo.removeAttribute("style")

    if (agrupar === "no") {
        pnBaldosas(lienzo, enriquecidos, { x: 0, y: 0, w: W, h: H }, cfg, periodo, escala, def)
        mapaDiaActivar(lienzo, periodoLinea)
        return
    }

    // Agrupado: primero se reparte el lienzo entre los grupos y luego cada
    // grupo entre sus activos. Cada grupo lleva una franja con su nombre y su
    // variación media ponderada por peso.
    const claveGrupo = (a) => (agrupar === "tipo" ? a.tipo : a.currency || "EUR")
    const nombreGrupo = (k) => (agrupar === "tipo" ? buildAssetTypeLabel(k) : k)
    const grupos = new Map()
    enriquecidos.forEach((a) => {
        const k = claveGrupo(a)
        if (!grupos.has(k)) grupos.set(k, [])
        grupos.get(k).push(a)
    })
    const lista = [...grupos].map(([k, miembros]) => {
        const peso = miembros.reduce((s, a) => s + a.peso, 0)
        const conValor = miembros.filter((a) => a.valor !== null)
        const pesoValor = conValor.reduce((s, a) => s + a.peso, 0)
        const media = pesoValor > 0 ? conValor.reduce((s, a) => s + a.valor * a.peso, 0) / pesoValor : null
        return { id: k, nombre: nombreGrupo(k), miembros, peso, media, area: peso * W * H }
    })
    lista.sort((a, b) => b.area - a.area)

    hmSquarify(lista, 0, 0, W, H).forEach((g) => {
        const franja = g.h > 46 && g.w > 50 ? 16 : 0
        if (franja) {
            const cab = document.createElement("div")
            cab.className = "pnGrupo"
            cab.style.cssText = `left:${g.x + 2}px;top:${g.y}px;width:${Math.max(g.w - 4, 0)}px`
            cab.innerHTML = `<span>${escapeHtml(g.nombre)}</span>${
                g.media !== null ? `<b class="${pnClaseSigno(g.media)}">${pnPct(g.media)}</b>` : ""
            }`
            lienzo.appendChild(cab)
        }
        pnBaldosas(lienzo, g.miembros, { x: g.x, y: g.y + franja, w: g.w, h: g.h - franja }, cfg, periodo, escala, def)
    })
    mapaDiaActivar(lienzo, periodoLinea)
}

/** Reparte un rectángulo entre activos y pinta sus baldosas. */
function pnBaldosas(lienzo, items, caja, cfg, periodo, escala, def = {}) {
    if (caja.w < 2 || caja.h < 2 || !items.length) return
    const peso = items.reduce((s, a) => s + a.peso, 0) || 1
    const conArea = items
        .map((a) => ({ ...a, area: (a.peso / peso) * caja.w * caja.h }))
        .sort((a, b) => b.area - a.area)
    const rects = hmSquarify(conArea, caja.x, caja.y, caja.w, caja.h)
    const hueco = 2
    const porNombre = pnRotuloPorNombre(cfg)
    const verPct = pnSi(cfg, "pct")
    const verEur = pnSi(cfg, "eur", def.eur ?? true)
    const verPrecio = pnSi(cfg, "precio", def.precio ?? false)

    rects.forEach((r) => {
        const cw = Math.max(r.w - hueco, 2)
        const ch = Math.max(r.h - hueco, 2)
        const cel = document.createElement("div")
        cel.className = "pnCelda"
        cel.dataset.activo = r.id
        cel.dataset.serieId = r.id
        cel.style.cssText = `left:${r.x + hueco / 2}px;top:${r.y + hueco / 2}px;width:${cw}px;height:${ch}px;background:${pnColorMapa(r.valor, escala)}`
        cel._pn = { ...r, periodo }

        const rotulo = porNombre ? r.nombre : r.simbolo || r.nombre
        let html = ""
        if (cw >= 22 && ch >= 16) {
            html += `<span class="pnCeldaSimbolo" style="font-size:${hmFontSize(cw, ch, rotulo)}px">${escapeHtml(rotulo)}</span>`
        }
        let lineas = 0
        if (verPct && ch >= 38 && cw >= 44) {
            html += `<span class="pnCeldaPct">${r.valor === null ? "N/D" : (r.valor >= 0 ? "▲ " : "▼ ") + pnPct(Math.abs(r.valor), false)}</span>`
            lineas++
        }
        if (verEur && ch >= 54 + lineas * 16 && cw >= 70 && r.mov !== null) {
            html += `<span class="pnCeldaMov pnMoney">${pnEurFirmado(r.mov)}</span>`
            lineas++
        }
        if (verPrecio && ch >= 54 + lineas * 16 && cw >= 70 && r.precio > 0) {
            html += `<span class="pnCeldaMov">${escapeHtml(pnPrecio(r))}</span>`
        }
        cel.innerHTML = html
        lienzo.appendChild(cel)
    })
}

/**
 * Cuántas columnas dan a la rejilla las casillas más grandes con la proporción
 * de `PN_REJILLA_ASPECTO`, sin bajar del ancho mínimo.
 *
 * @param {number} n Número de casillas.
 * @param {number} ancho Ancho del lienzo.
 * @param {number} alto Alto del lienzo.
 * @returns {number} Columnas, al menos una.
 */
function pnRejillaColumnas(n, ancho, alto) {
    let mejor = 1
    let mejorLado = -1
    for (let cols = 1; cols <= n; cols++) {
        const cw = ancho / cols
        if (cols > 1 && cw < PN_REJILLA_ANCHO_MIN) break
        const ch = Math.max(alto / Math.ceil(n / cols), PN_REJILLA_ALTO_MIN)
        // El ancho de la casilla más grande con esa proporción que cabe.
        const lado = Math.min(cw, ch * PN_REJILLA_ASPECTO)
        // A igualdad, más columnas: cuando no caben y el alto se queda en el
        // mínimo, todas empatan, y la primera era una sola columna de casillas
        // estiradas a lo ancho.
        if (lado >= mejorLado) {
            mejorLado = lado
            mejor = cols
        }
    }
    return mejor
}

/**
 * El mapa en rejilla: una casilla igual por activo con su símbolo, el precio, la
 * variación del periodo y, en «Hoy», la línea del día con su máximo y su mínimo
 * (los escribe `pnRejillaExtremos` cuando llega la serie).
 */
function pnRejilla(lienzo, items, cfg, periodo, escala, def, agrupar) {
    const W = lienzo.clientWidth || 400
    const H = lienzo.clientHeight || 300
    // En el orden del selector de activos, que es el de la lista de Activos y la
    // Watchlist; agrupado, cada grupo seguido. Los tickers sueltos no están en la
    // lista: van al final, en el orden en que se eligieron.
    const posicion = pnOrdenSelector([...pnOpcionesMapa(cfg, def.mercado), ...items])
    const grupo = (a) => (agrupar === "tipo" ? a.tipo : agrupar === "divisa" ? a.currency || "EUR" : "")
    const ordenados = [...items].sort(
        (a, b) => String(grupo(a)).localeCompare(String(grupo(b))) || posicion.get(a.id) - posicion.get(b.id)
    )
    const cols = pnRejillaColumnas(ordenados.length, W, H)
    const filas = Math.ceil(ordenados.length / cols)
    const altoFila = Math.max(Math.floor((H - PN_REJILLA_HUECO * (filas - 1)) / filas), PN_REJILLA_ALTO_MIN)
    const anchoCasilla = (W - PN_REJILLA_HUECO * (cols - 1)) / cols
    const cuerpoPrecio = Math.round(Math.min(Math.max(anchoCasilla * 0.11, 15), 28))
    const porNombre = pnRotuloPorNombre(cfg)
    const verPct = pnSi(cfg, "pct")
    const verEur = pnSi(cfg, "eur", def.eur ?? true)
    // Fuera de «Hoy» los rótulos son fechas y los pone pnRejillaEje al llegar la serie.
    const eje =
        periodo === "dia"
            ? `<div class="pnRjEje" aria-hidden="true"><span style="left:25%">06:00</span><span style="left:50%">12:00</span><span style="left:75%">18:00</span></div>`
            : periodo !== "todo"
              ? `<div class="pnRjEje" aria-hidden="true"></div>`
              : ""

    lienzo.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`
    lienzo.style.gridAutoRows = `${altoFila}px`
    lienzo.style.gap = `${PN_REJILLA_HUECO}px`

    ordenados.forEach((r) => {
        const cel = document.createElement("div")
        cel.className = "pnCelda pnRejillaCelda"
        cel.dataset.activo = r.id
        cel.dataset.serieId = r.id
        cel.style.background = pnColorMapa(r.valor, escala)
        cel._pn = { ...r, periodo }

        const rotulo = porNombre ? r.nombre : r.simbolo || r.nombre
        const pct = verPct ? `<span class="pnRjPct">${r.valor === null ? "N/D" : pnPct(r.valor)}</span>` : ""
        const mov = verEur && r.mov !== null ? `<span class="pnRjMov pnMoney">${pnEurFirmado(r.mov)}</span>` : ""
        cel.innerHTML = `
            <div class="pnRjCab">
                <div class="pnRjIzq">
                    <span class="pnRjSimbolo">${escapeHtml(rotulo)}</span>
                    <span class="pnRjPrecio" style="font-size:${cuerpoPrecio}px">${escapeHtml(pnPrecio(r))}</span>
                    ${mov}
                </div>
                <div class="pnRjDer">${pct}<span class="pnRjCerrado"></span><span class="pnRjExt" data-ext="max"></span><span class="pnRjExt" data-ext="min"></span></div>
            </div>${eje}`
        lienzo.appendChild(cel)
    })
}

/**
 * Máximo y mínimo del día de una casilla de la rejilla, sacados de su línea.
 *
 * La línea va en euros (o es el valor de la posición si no se pudo saber el
 * precio por participación), así que no se escribe tal cual: se lleva a la
 * divisa del precio de la casilla con la proporción entre cada extremo y el
 * último punto, que pasa a ser el precio actual.
 *
 * @param {HTMLElement} celda Casilla con `_pn`.
 * @param {Array<[number, number]>|undefined} puntos Serie del día.
 */
function pnRejillaExtremos(celda, puntos) {
    const d = celda._pn
    const huecos = celda.querySelectorAll(".pnRjExt")
    huecos.forEach((h) => {
        h.textContent = ""
        h.classList.remove("pnRjCerca")
    })
    if (!d || !(d.precio > 0) || !Array.isArray(puntos) || puntos.length < 2) return
    const valores = puntos.map((p) => p[1])
    const ultimo = valores[valores.length - 1]
    if (!(ultimo > 0)) return
    const extremos = {
        max: (d.precio * Math.max(...valores)) / ultimo,
        min: (d.precio * Math.min(...valores)) / ultimo
    }
    huecos.forEach((h) => {
        const valor = extremos[h.dataset.ext]
        h.textContent = `${h.dataset.ext === "max" ? "H" : "L"} ${hmFormatPrice(valor, d.currency)}`
        h.classList.toggle("pnRjCerca", Math.abs(d.precio - valor) / d.precio <= PN_REJILLA_CERCA_EXTREMO)
    })
}

/**
 * Rótulos horarios del eje de una casilla de la rejilla para la ventana de su
 * línea: el día entero o, con horario de mercado, solo la sesión.
 *
 * @param {HTMLElement} celda Casilla de la rejilla.
 * @param {{inicio: number, fin: number}|undefined} ventana Ventana de `mapaDiaSesion`.
 */
function pnRejillaEje(celda, ventana) {
    const eje = celda.querySelector(".pnRjEje")
    if (!eje || !ventana) return
    const marcas = ventana.dias ? mapaDiaMarcasFecha : mapaDiaMarcasEje
    eje.innerHTML = marcas(ventana.inicio, ventana.fin)
        .map((m) => `<span style="left:${m.pos.toFixed(2)}%">${escapeHtml(m.texto)}</span>`)
        .join("")
}

function pnColorMapa(pct, escala) {
    if (pct === null || pct === undefined || Math.abs(pct) < escala / 250) return hmNeutralColor()
    const t = Math.min(Math.abs(pct) / escala, 1)
    return pct > 0 ? hmBlend("#a5d6a7", "#43a047", "#1b5e20", t) : hmBlend("#ef9a9a", "#e53935", "#b71c1c", t)
}

function pnBindMapa(lienzo) {
    lienzo.addEventListener("mousemove", (e) => {
        const tip = hmGetTooltip()
        const celda = e.target.closest(".pnCelda")
        const d = celda?._pn
        if (!d) {
            tip.classList.remove("hmTooltipVisible")
            mapaDiaOcultarTv()
            return
        }
        // Con símbolo de TradingView, la vista previa de su gráfico ocupa el
        // lugar del tooltip, igual que en el mapa de Análisis.
        if (d.tv) {
            tip.classList.remove("hmTooltipVisible")
            mapaDiaMostrarTv(celda, d.tv)
            return
        }
        mapaDiaOcultarTv()
        const fila = (l, v, cls = "", dinero = false) =>
            `<span class="hmTipLabel">${l}</span><span class="hmTipVal ${dinero ? "hmTipMoneyVal" : ""} ${cls}">${v}</span>`
        const cls = d.valor === null ? "" : d.valor < 0 ? "hmTipNeg" : d.valor > 0 ? "hmTipPos" : ""
        const periodo = PN_PERIODOS.find((p) => p.valor === d.periodo)?.texto || ""
        tip.innerHTML = `
            <div class="hmTipName">${escapeHtml(d.nombre)}</div>
            <div class="hmTipDivider"></div>
            <div class="hmTipGrid">
                ${d.precio > 0 ? fila("Precio", pnPrecio(d)) : ""}
                ${fila(periodo, d.valor === null ? "sin dato" : pnPct(d.valor), cls)}
                ${d.mov !== null ? fila("Movimiento", pnEurFirmado(d.mov), cls, true) : ""}
                ${d.netoEur > 0 ? fila("Valor", pnEur(d.netoEur), "", true) : ""}
                ${d.invertidoEur > 0 ? fila("Rendimiento", `${pnEurFirmado(d.rendEur)} (${pnPct(d.rendPct)})`, pnClaseSigno(d.rendEur).replace("pn", "hmTip"), true) : ""}
                ${fila("Peso", pnPct(d.peso * 100, false))}
            </div>`
        tip.classList.add("hmTooltipVisible")
        const r = tip.getBoundingClientRect()
        let x = e.clientX + 12
        let y = e.clientY + 12
        if (x + r.width > window.innerWidth - 4) x = e.clientX - r.width - 12
        if (y + r.height > window.innerHeight - 4) y = e.clientY - r.height - 12
        tip.style.left = Math.max(4, x) + "px"
        tip.style.top = Math.max(4, y) + "px"
    })
    lienzo.addEventListener("mouseleave", () => {
        hmGetTooltip().classList.remove("hmTooltipVisible")
        mapaDiaOcultarTv()
    })
    lienzo.addEventListener("click", (e) => {
        const d = e.target.closest(".pnCelda")?._pn
        if (!d) return
        hmGetTooltip().classList.remove("hmTooltipVisible")
        mapaDiaOcultarTv()
        pnSeleccionarActivo(d.id)
    })
}
