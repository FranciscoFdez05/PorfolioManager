// Activos > Paneles: widgets de TradingView.
//
// Trozo de js/cartera/paneles.js. Comparte con el resto de paneles-*.js el
// ámbito global y se carga detrás de paneles.js, en el orden de index.html.

// ── Widget: gráfico de TradingView ──────────────────────────────────────────

function pnTvUrl(simbolo, cfg) {
    const claro = document.documentElement.getAttribute("data-theme") === "light"
    const zona = pnOpcion(cfg, "zona", ["local", "exchange", "utc"], "local")
    const p = new URLSearchParams({
        symbol: simbolo,
        interval: pnOpcion(
            cfg,
            "intervalo",
            PN_INTERVALOS.map((i) => i.valor),
            "D"
        ),
        theme: claro ? "light" : "dark",
        style: pnOpcion(cfg, "estilo", ["1", "9", "8", "0", "2", "3"], "1"),
        locale: "es",
        timezone:
            zona === "utc"
                ? "Etc/UTC"
                : zona === "exchange"
                  ? "exchange"
                  : Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC",
        // Con guion bajo: widgetembed ignora en silencio las variantes sin él
        // (hidesidetoolbar, hidevolume…), comprobado contra TradingView.
        hide_side_toolbar: pnSi(cfg, "herramientas", false) ? "0" : "1",
        hide_top_toolbar: pnSi(cfg, "barraSuperior") ? "0" : "1",
        hide_volume: pnSi(cfg, "volumen") ? "0" : "1",
        symboledit: "1",
        saveimage: "0",
        // Los indicadores van como objetos {id}: la lista de textos la acepta
        // pero falla con «cannot_get_metainfo» y no pinta ninguno.
        studies: JSON.stringify(
            pnLista(cfg, "estudios")
                .filter((s) => PN_ESTUDIOS.some((e) => e.valor === s))
                .map((id) => ({ id }))
        ),
        toolbarbg: claro ? "f1f5f9" : "111827"
    })
    return `https://www.tradingview.com/widgetembed/?${p.toString()}`
}

function pnPintarGrafico(w, cuerpo, ctrls) {
    const cfg = w.cfg
    const intervalo = pnOpcion(
        cfg,
        "intervalo",
        PN_INTERVALOS.map((i) => i.valor),
        "D"
    )
    // Sin activo elegido, el de más peso de la cartera.
    const porDefecto = [...pnPosiciones()].sort((a, b) => b.netoEur - a.netoEur)[0]
    const activo = pnBuscarActivo(cfg.activo) || porDefecto || null

    ctrls.innerHTML = ""
    pnChipActivo(ctrls, w, activo)

    pnSegmentado(
        ctrls,
        PN_INTERVALOS,
        intervalo,
        (v) => {
            if (v === "D") delete cfg.intervalo
            else cfg.intervalo = v
            pnGuardar()
            pnPintarWidget(w)
        },
        "Intervalo"
    )

    if (!activo?.tv) {
        cuerpo.innerHTML = `<div class="pnVacio">Elige un activo para ver su gráfico</div>`
        return
    }
    cuerpo.innerHTML = `
        <iframe class="pnIframe" src="${escapeAttr(pnTvUrl(activo.tv, cfg))}" frameborder="0" allowtransparency="true" scrolling="no" allowfullscreen
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            referrerpolicy="no-referrer" title="${escapeAttr("Gráfico de " + activo.nombre)}"></iframe>`
}

function pnMenuActivoGrafico(anchor, w) {
    const contenido = document.createElement("div")
    contenido.className = "pnSel"
    contenido.innerHTML = `
        <label class="pnSelBuscarCaja">${PN_LUPA}<input class="pnSelBuscar" type="search" placeholder="Buscar en tu cartera o en el mercado…" data-no-custom></label>
        <div class="pnSelLista"></div>`
    const buscar = contenido.querySelector(".pnSelBuscar")
    const lista = contenido.querySelector(".pnSelLista")
    const opciones = pnTodosLosActivos().filter((a) => a.tv && !a.oculto)
    let resultados = null
    let buscado = ""
    let timer = null

    const fila = (id, nombre, simbolo, tipo, activa) => `
        <button type="button" class="pnPopItem${activa ? " active" : ""}" data-valor="${escapeAttr(id)}">
            <span class="pnPunto" style="background:${escapeAttr(pnColorTipo(tipo))}"></span>
            <span class="pnSelNombre">${escapeHtml(nombre)}</span>
            <span class="pnSelSimbolo">${escapeHtml(simbolo)}</span>
        </button>`

    const pintar = () => {
        const q = buscar.value.trim()
        const ql = q.toLowerCase()
        const visibles = opciones.filter(
            (o) =>
                !ql ||
                o.nombre.toLowerCase().includes(ql) ||
                String(o.simbolo || "")
                    .toLowerCase()
                    .includes(ql)
        )
        let html = visibles.length ? `<div class="pnSelGrupo"><span>Tus activos</span></div>` : ""
        html += visibles.map((o) => fila(o.id, o.nombre, o.tv, o.tipo, o.id === w.cfg.activo)).join("")
        if (q.length >= 2) {
            html += `<div class="pnSelGrupo"><span>En el mercado</span></div>`
            if (resultados === "cargando" || buscado !== q) {
                html += `<div class="pnVacio">Buscando «${escapeHtml(q)}»…</div>`
            } else if (resultados.length) {
                html += resultados.map((r) => fila(r.id, r.nombre, r.simbolo, r.tipo, r.id === w.cfg.activo)).join("")
            } else {
                html += `<div class="pnVacio">TradingView no encuentra «${escapeHtml(q)}»</div>`
            }
            // Un símbolo escrito a mano, tal cual, por si la búsqueda no lo da.
            html += `<button type="button" class="pnPopItem pnSelLibre" data-valor="${escapeAttr("tv:" + q.toUpperCase())}">Abrir <b>${escapeHtml(q.toUpperCase())}</b> tal cual en TradingView</button>`
        }
        lista.innerHTML = html || `<div class="pnVacio">Escribe para buscar en el mercado</div>`
    }

    const elegir = (valor) => {
        pnCerrarMenu()
        w.cfg.activo = valor
        pnGuardar()
        pnPintarWidget(w)
    }
    lista.addEventListener("click", (e) => {
        const btn = e.target.closest(".pnPopItem")
        if (btn) elegir(btn.dataset.valor)
    })
    buscar.addEventListener("input", () => {
        const q = buscar.value.trim()
        clearTimeout(timer)
        pintar()
        if (q.length < 2) return
        // Se busca al dejar de escribir, no con cada letra.
        timer = setTimeout(async () => {
            buscado = q
            resultados = "cargando"
            const encontrados = await pnBuscarTickers(q)
            if (buscado !== q || buscar.value.trim() !== q) return
            resultados = encontrados || []
            pintar()
        }, 350)
    })
    buscar.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return
        const primero = lista.querySelector(".pnPopItem")
        if (primero) elegir(primero.dataset.valor)
    })
    pintar()
    pnMenu(anchor, [], null, { contenido, ancho: 360, clase: "pnPopSel" })
    setTimeout(() => buscar.focus(), 0)
}

// ── Widgets de TradingView embebidos ────────────────────────────────────────
//
// Instrumento, análisis técnico, ficha, perfil, noticias y calendario son los
// widgets públicos de TradingView. Se cargan por URL en un iframe (la
// configuración va en el fragmento, tras «#»), que es lo que permite la CSP:
// frame-src ya admite s.tradingview.com y no hace falta cargar su script.

const PN_EMBEBIDOS = {
    instrumento: "mini-symbol-overview",
    tecnico: "technical-analysis",
    ficha: "symbol-info",
    perfil: "symbol-profile",
    noticias: "timeline",
    calendario: "events"
}

const PN_RANGOS_INSTRUMENTO = [
    { valor: "1D", texto: "1D" },
    { valor: "1M", texto: "1M" },
    { valor: "3M", texto: "3M" },
    { valor: "12M", texto: "1A" },
    { valor: "60M", texto: "5A" },
    { valor: "ALL", texto: "Todo" }
]

const PN_INTERVALOS_TECNICO = [
    { valor: "1m", texto: "1 minuto" },
    { valor: "5m", texto: "5 minutos" },
    { valor: "15m", texto: "15 minutos" },
    { valor: "1h", texto: "1 hora" },
    { valor: "4h", texto: "4 horas" },
    { valor: "1D", texto: "1 día" },
    { valor: "1W", texto: "1 semana" },
    { valor: "1M", texto: "1 mes" }
]

const PN_PAISES = [
    { valor: "us", texto: "EE. UU." },
    { valor: "eu", texto: "Eurozona" },
    { valor: "es", texto: "España" },
    { valor: "de", texto: "Alemania" },
    { valor: "fr", texto: "Francia" },
    { valor: "it", texto: "Italia" },
    { valor: "gb", texto: "Reino Unido" },
    { valor: "jp", texto: "Japón" },
    { valor: "cn", texto: "China" }
]

const PN_IMPORTANCIAS = [
    { valor: "-1,0,1", texto: "Todas" },
    { valor: "0,1", texto: "Media y alta" },
    { valor: "1", texto: "Solo alta" }
]

/** El activo de un widget que sigue a uno: el elegido o, si no, el de más peso. */
function pnActivoDeWidget(w) {
    const porDefecto = [...pnPosiciones()].sort((a, b) => b.netoEur - a.netoEur)[0]
    return pnBuscarActivo(w.cfg.activo) || porDefecto || null
}

function pnChipActivo(ctrls, w, activo) {
    const chip = document.createElement("button")
    chip.type = "button"
    chip.className = "pnChip pnChipActivo"
    chip.innerHTML = `<span>${escapeHtml(activo ? activo.nombre : "Elegir activo")}</span>${
        activo?.tv ? `<small>${escapeHtml(activo.tv)}</small>` : ""
    }<span class="pnChipFlecha">▾</span>`
    pnControlCabecera(chip, "Activo", (ancla) => pnMenuActivoGrafico(ancla, w))
    ctrls.appendChild(chip)
}

function pnPintarEmbebido(w, cuerpo, ctrls) {
    const turno = pnTurno(w)
    const cfg = w.cfg
    const claro = document.documentElement.getAttribute("data-theme") === "light"
    const base = {
        width: "100%",
        height: "100%",
        colorTheme: claro ? "light" : "dark",
        isTransparent: true,
        autosize: true
    }
    const delActivo = w.tipo !== "calendario" && !(w.tipo === "noticias" && cfg.modo !== "activo")
    // Las noticias de este widget no existen en español: con locale=es falla
    // con «Algo ha ido mal». En inglés cargan.
    let locale = "es"

    ctrls.innerHTML = ""
    const activo = delActivo ? pnActivoDeWidget(w) : null
    if (delActivo) pnChipActivo(ctrls, w, activo)

    const cambiar = (clave, defecto) => (v) => {
        if (v === defecto) delete cfg[clave]
        else cfg[clave] = v
        pnGuardar()
        pnPintarWidget(w)
    }

    let config
    switch (w.tipo) {
        case "instrumento": {
            const rango = pnOpcion(
                cfg,
                "rango",
                PN_RANGOS_INSTRUMENTO.map((r) => r.valor),
                "12M"
            )
            pnSegmentado(ctrls, PN_RANGOS_INSTRUMENTO, rango, cambiar("rango", "12M"), "Rango")
            config = { ...base, symbol: activo?.tv, dateRange: rango, chartOnly: !pnSi(cfg, "cabecera") }
            break
        }
        case "tecnico": {
            const intervalo = pnOpcion(
                cfg,
                "intervalo",
                PN_INTERVALOS_TECNICO.map((i) => i.valor),
                "1D"
            )
            pnChip(
                ctrls,
                PN_INTERVALOS_TECNICO.find((i) => i.valor === intervalo).texto,
                PN_INTERVALOS_TECNICO,
                intervalo,
                cambiar("intervalo", "1D"),
                "Intervalo"
            )
            config = {
                ...base,
                symbol: activo?.tv,
                interval: intervalo,
                showIntervalTabs: pnSi(cfg, "pestanas"),
                displayMode: pnOpcion(cfg, "detalle", ["single", "multiple"], "single")
            }
            break
        }
        case "ficha":
        case "perfil":
            config = { ...base, symbol: activo?.tv }
            break
        case "noticias": {
            const modo = pnOpcion(cfg, "modo", ["general", "activo"], "general")
            ctrls.insertBefore(document.createElement("span"), ctrls.firstChild).remove()
            pnSegmentado(
                ctrls,
                [
                    { valor: "general", texto: "Mercado" },
                    { valor: "activo", texto: "Del activo" }
                ],
                modo,
                cambiar("modo", "general"),
                "Noticias"
            )
            locale = "en"
            config = {
                ...base,
                feedMode: modo === "activo" ? "symbol" : "all_symbols",
                ...(modo === "activo" ? { symbol: activo?.tv } : {}),
                displayMode: pnSi(cfg, "compacta", false) ? "compact" : "regular"
            }
            break
        }
        case "calendario": {
            const importancia = pnOpcion(
                cfg,
                "importancia",
                PN_IMPORTANCIAS.map((i) => i.valor),
                "-1,0,1"
            )
            pnChip(
                ctrls,
                PN_IMPORTANCIAS.find((i) => i.valor === importancia).texto,
                PN_IMPORTANCIAS,
                importancia,
                cambiar("importancia", "-1,0,1"),
                "Importancia"
            )
            const paises = pnLista(cfg, "paises").filter((p) => PN_PAISES.some((x) => x.valor === p))
            config = {
                ...base,
                importanceFilter: importancia,
                countryFilter: (paises.length ? paises : PN_PAISES.map((p) => p.valor)).join(",")
            }
            break
        }
    }

    if (delActivo && !activo?.tv) {
        cuerpo.innerHTML = `<div class="pnVacio">Elige un activo</div>`
        return
    }
    const montar = (cfgFinal) => {
        // El símbolo va también en la consulta, como lo pone el script
        // oficial: la ficha y el perfil solo lo leen de ahí y, si falta,
        // enseñan Apple sin avisar.
        const consulta = new URLSearchParams({ locale })
        if (cfgFinal.symbol) consulta.set("symbol", cfgFinal.symbol)
        const url = `https://s.tradingview.com/embed-widget/${PN_EMBEBIDOS[w.tipo]}/?${consulta}#${encodeURIComponent(JSON.stringify(cfgFinal))}`
        cuerpo.innerHTML = `
        <iframe class="pnIframe pnIframeWidget" src="${escapeAttr(url)}" frameborder="0" allowtransparency="true" scrolling="no"
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            referrerpolicy="no-referrer" title="${escapeAttr(PN_TIPOS[w.tipo].nombre)}"></iframe>`
    }

    // La ficha y el perfil necesitan el símbolo con su mercado: con «NVDA» a
    // secas TradingView no da error, enseña Apple. Se busca el mercado una vez.
    if ((w.tipo === "ficha" || w.tipo === "perfil") && !String(activo.tv).includes(":")) {
        cuerpo.innerHTML = `<div class="pnVacio">Buscando ${escapeHtml(activo.tv)}…</div>`
        pnSimboloConMercado(activo.tv).then((completo) => {
            if (!pnVigente(w, turno)) return
            if (completo) montar({ ...config, symbol: completo })
            else
                cuerpo.innerHTML = `<div class="pnVacio">TradingView no encuentra el mercado de «${escapeHtml(activo.tv)}». Elige el activo con su mercado (por ejemplo NASDAQ:${escapeHtml(activo.tv)}).</div>`
        })
        return
    }
    montar(config)
}

const _pnSimbolosCompletos = new Map()

/**
 * «NVDA» → «NASDAQ:NVDA», con la búsqueda de TradingView: el primer resultado
 * cuyo símbolo sea exactamente ese. Sin coincidencia exacta, null: mejor
 * avisar que enseñar otra empresa.
 */
async function pnSimboloConMercado(simbolo) {
    const clave = String(simbolo).toUpperCase()
    if (_pnSimbolosCompletos.has(clave)) return _pnSimbolosCompletos.get(clave)
    const resultados = (await pnBuscarTickers(clave)) || []
    const exacto = resultados.find((r) => r.simbolo.split(":").pop() === clave)
    const completo = exacto ? exacto.simbolo : null
    _pnSimbolosCompletos.set(clave, completo)
    return completo
}
