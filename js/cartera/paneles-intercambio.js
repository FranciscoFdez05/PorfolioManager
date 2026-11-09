// Activos > Paneles: exportar e importar paneles.
//
// Trozo de js/cartera/paneles.js. Comparte con el resto de paneles-*.js el
// ámbito global y se carga detrás de paneles.js, en el orden de index.html.

// ── Exportar e importar ─────────────────────────────────────────────────────
//
// Un panel exportado tiene que servirle a otra persona con *sus* datos, así
// que el fichero no lleva ids de activos (son de esta instalación: el
// «bitcoin» de uno puede ser el «btc» de otro) ni ningún importe. Cada activo
// que nombra un widget va como referencia —símbolo de TradingView, ticker y
// nombre— y al importar se busca entre los activos de quien importa. Lo que
// no tenga se queda fuera de su mapa o sus favoritos; el gráfico, en cambio,
// abre igualmente el mismo símbolo de TradingView, que no depende de la cartera.

const PN_FORMATO_EXPORT = "porfoliomanager-paneles"

function pnMenuCompartir(anchor) {
    const panel = pnPanelActivo()
    const items = []
    if (panel?.widgets.length) items.push({ valor: "uno", texto: `Exportar «${panel.nombre}»` })
    if (_pnConfig.paneles.some((p) => p.widgets.length))
        items.push({ valor: "todos", texto: "Exportar todos los paneles" })
    if (items.length) items.push({ separador: true })
    items.push({ valor: "importar", texto: "Importar paneles desde un fichero…" })

    pnMenu(
        anchor,
        items,
        (accion) => {
            if (accion === "importar") document.getElementById("pnImportarInput")?.click()
            else pnExportar(accion === "uno" ? [panel] : _pnConfig.paneles.filter((p) => p.widgets.length))
        },
        { alinear: "derecha" }
    )
}

function pnRefPortable(id) {
    const a = pnBuscarActivo(id)
    if (!a) return null
    const ref = { tv: a.tv || "", simbolo: a.simbolo || "", nombre: a.nombre || "" }
    // Un ticker suelto no depende de la cartera de nadie: viaja tal cual.
    if (String(id).startsWith("tk|")) ref.ticker = id
    return ref
}

function pnCfgExportable(w) {
    const cfg = { ...w.cfg }
    if (cfg.activo) {
        const ref = pnRefPortable(cfg.activo)
        if (ref) cfg.activo = ref
        else delete cfg.activo
    }
    if (Array.isArray(cfg.activos)) cfg.activos = cfg.activos.map(pnRefPortable).filter(Boolean)
    return cfg
}

function pnExportar(paneles) {
    if (!paneles.length) return
    const datos = {
        formato: PN_FORMATO_EXPORT,
        version: 1,
        exportado: new Date().toISOString(),
        paneles: paneles.map((p) => ({
            nombre: p.nombre,
            cfg: { ...(p.cfg || {}) },
            widgets: p.widgets.map((w) => ({ tipo: w.tipo, w: w.w, h: w.h, cfg: pnCfgExportable(w) }))
        }))
    }
    const base = paneles.length === 1 ? paneles[0].nombre : "paneles"
    const slug =
        base
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "panel"
    const blob = new Blob([JSON.stringify(datos, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const enlace = document.createElement("a")
    enlace.href = url
    enlace.download = `${paneles.length === 1 ? "panel-" : ""}${slug}.json`
    document.body.appendChild(enlace)
    enlace.click()
    enlace.remove()
    URL.revokeObjectURL(url)
    window.showToast?.(
        paneles.length === 1 ? `Panel «${paneles[0].nombre}» exportado` : `${paneles.length} paneles exportados`,
        { type: "success" }
    )
}

/**
 * El activo de quien importa que corresponde a una referencia exportada: por
 * símbolo de TradingView, si no por ticker y si no por nombre. Con el texto
 * normalizado (mayúsculas, sin espacios) para no fallar por un detalle.
 */
function pnResolverRef(ref, candidatos) {
    if (!ref || typeof ref !== "object") return null
    const norma = (v) =>
        String(v || "")
            .toUpperCase()
            .replace(/\s+/g, "")
    for (const campo of ["tv", "simbolo", "nombre"]) {
        const buscado = norma(ref[campo])
        if (!buscado) continue
        const hallado = candidatos.find((a) => norma(a[campo]) === buscado)
        if (hallado) return hallado.id
    }
    // Sin equivalente en la cartera, el ticker suelto (si lo era).
    if (typeof ref.ticker === "string" && ref.ticker.startsWith("tk|")) return ref.ticker.slice(0, 120)
    return null
}

/** Un tamaño importado: un número finito o 0 (que luego cae al de fábrica). */
function pnEnteroFinito(v) {
    const n = Number(v)
    return Number.isFinite(n) ? pnRedondearTamano(n) : 0
}

/** Un panel del fichero, con ids nuevos y los activos de quien importa. */
function pnPanelImportado(p, candidatos, cuenta) {
    const widgets = p.widgets
        .filter((w) => w && PN_TIPOS[w.tipo])
        .slice(0, 24)
        .map((w) => {
            const origen = w.cfg && typeof w.cfg === "object" ? w.cfg : {}
            // Solo opciones planas, como las que admite el servidor. Los activos
            // se resuelven aparte, contra la cartera de quien importa.
            const cfg = pnOpcionesPlanas(origen)
            delete cfg.activos
            if (origen.activo && typeof origen.activo === "object") {
                cuenta.referencias++
                const id = pnResolverRef(origen.activo, candidatos)
                if (id) {
                    cuenta.encontradas++
                    cfg.activo = id
                } else if (origen.activo.tv) {
                    // Sin el activo en la cartera, el mismo símbolo de TradingView.
                    cfg.activo = "tv:" + String(origen.activo.tv).slice(0, 100)
                }
            }
            if (Array.isArray(origen.activos)) {
                const ids = []
                origen.activos.forEach((ref) => {
                    cuenta.referencias++
                    const id = pnResolverRef(ref, candidatos)
                    if (id && !ids.includes(id)) {
                        cuenta.encontradas++
                        ids.push(id)
                    }
                })
                cfg.activos = ids
            }
            return { id: pnNuevoId("w"), tipo: w.tipo, w: pnEnteroFinito(w.w), h: pnEnteroFinito(w.h), cfg }
        })
    const cfg = pnOpcionesPlanas(p.cfg, { listas: false })
    return { id: pnNuevoId("p"), nombre: String(p.nombre || "Panel importado").slice(0, 60), cfg, widgets }
}

async function pnImportarFichero(fichero) {
    if (fichero.size > 1024 * 1024) {
        window.showToast?.("El fichero es demasiado grande para ser un panel exportado", { type: "error" })
        return
    }
    let datos
    try {
        datos = JSON.parse(await fichero.text())
    } catch {
        window.showToast?.("El fichero no es un JSON válido", { type: "error" })
        return
    }
    if (datos?.formato !== PN_FORMATO_EXPORT || !Array.isArray(datos.paneles)) {
        window.showToast?.("Este fichero no es un panel exportado desde Paneles", { type: "error" })
        return
    }

    if (!_pnDatos) await pnCargarDatos()
    const candidatos = pnTodosLosActivos()
    const cuenta = { referencias: 0, encontradas: 0 }
    const importados = datos.paneles
        .filter((p) => p && Array.isArray(p.widgets))
        .map((p) => pnPanelImportado(p, candidatos, cuenta))
        .filter((p) => p.widgets.length)

    if (!importados.length) {
        window.showToast?.("El fichero no trae ningún panel con widgets", { type: "warning" })
        return
    }

    // Si se importa desde la galería de un panel recién creado y vacío, el
    // importado ocupa su sitio en vez de dejar una pestaña vacía detrás.
    const actual = pnPanelActivo()
    if (actual && !actual.widgets.length) _pnConfig.paneles.splice(_pnConfig.paneles.indexOf(actual), 1)

    const entran = importados.slice(0, Math.max(0, 20 - _pnConfig.paneles.length))
    if (!entran.length) {
        window.showToast?.("Ya tienes 20 paneles: borra alguno para importar", { type: "warning" })
        pnRenderTabs()
        return
    }
    const nombres = new Set(_pnConfig.paneles.map((p) => p.nombre))
    entran.forEach((p) => {
        if (nombres.has(p.nombre)) p.nombre = `${p.nombre} (importado)`.slice(0, 60)
        nombres.add(p.nombre)
    })
    _pnConfig.paneles.push(...entran)
    _pnConfig.activo = entran[0].id
    _pnGaleria = false
    pnGuardar()
    pnRenderTabs()
    pnRenderCuerpo()

    const partes = [
        entran.length === 1 ? `Panel «${entran[0].nombre}» importado` : `${entran.length} paneles importados`
    ]
    if (cuenta.referencias)
        partes.push(`${cuenta.encontradas} de ${cuenta.referencias} activos encontrados en tu cartera`)
    if (entran.length < importados.length) partes.push(`${importados.length - entran.length} no caben (máximo 20)`)
    window.showToast?.(partes.join(" · "), {
        type: cuenta.encontradas < cuenta.referencias ? "warning" : "success",
        duration: 7000
    })
}

/** El panel activo (o uno nuevo si no hay) para meterle widgets. */
function pnPanelParaEditar(nombre) {
    let panel = pnPanelActivo()
    if (!panel) {
        panel = { id: pnNuevoId("p"), nombre: nombre || "Mi panel", widgets: [] }
        _pnConfig.paneles.push(panel)
        _pnConfig.activo = panel.id
    }
    return panel
}

function pnAplicarPlantilla(plantilla) {
    if (!plantilla) return
    const panel = pnPanelParaEditar(plantilla.nombre)
    if (panel.nombre === "Nuevo panel" && plantilla.widgets.length) panel.nombre = plantilla.nombre
    panel.widgets = plantilla.widgets.map(([tipo, w, h, cfg]) => ({
        id: pnNuevoId("w"),
        tipo,
        w,
        h,
        cfg: { ...(cfg || {}) }
    }))
    _pnGaleria = false
    pnGuardar()
    pnRenderTabs()
    pnRenderCuerpo()
}

function pnAnadirWidget(tipo) {
    const t = PN_TIPOS[tipo]
    if (!t) return
    const panel = pnPanelParaEditar(t.nombre)
    if (!pnCabeWidget(panel)) return
    const widget = { id: pnNuevoId("w"), tipo, w: t.w, h: t.h, cfg: {} }
    panel.widgets.push(widget)
    pnGuardar()
    pnRenderTabs()
    // Con el panel ya en pantalla se añade solo el nuevo: repintarlo entero
    // recargaría los gráficos de TradingView que ya estaban.
    const grid = document.getElementById("pnGrid")
    if (grid && !_pnGaleria) {
        grid.appendChild(pnCrearWidget(widget))
        pnPintarWidget(widget)
    } else {
        _pnGaleria = false
        pnRenderCuerpo()
    }
    document
        .querySelector(`.pnWidget[data-widget="${widget.id}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" })
}

function pnMenuAnadirWidget(anchor) {
    const items = []
    Object.entries(PN_GRUPOS).forEach(([grupo, titulo]) => {
        items.push({ cabecera: titulo })
        Object.entries(PN_TIPOS)
            .filter(([, t]) => t.grupo === grupo)
            .forEach(([tipo, t]) =>
                items.push({
                    valor: tipo,
                    html: `<span class="pnMenuIcono">${PN_ICONOS[tipo]}</span><span class="pnMenuTexto"><b>${escapeHtml(t.nombre)}</b><small>${escapeHtml(t.desc)}</small></span>`
                })
            )
    })
    pnMenu(anchor, items, pnAnadirWidget, { ancho: 300, alinear: "derecha" })
}
