// Activos > Paneles: sentimiento de mercado.
//
// Trozo de js/cartera/paneles.js. Comparte con el resto de paneles-*.js el
// ámbito global y se carga detrás de paneles.js, en el orden de index.html.

// ── Sentimiento de mercado ──────────────────────────────────────────────────
//
// Los mismos datos que Activos > Sentimiento (/api/market/pulse): miedo y
// codicia, amplitud, índices, sectores y los rankings del escáner. Se piden una
// vez por visita y los comparten todos los widgets; ↻ los vuelve a pedir. Las
// filas y tarjetas se pintan con las mismas funciones de sentimiento.js, así
// que se ven igual que en esa página.

let _pnPulso = null
const _pnUniversos = {}

function pnCargarPulso() {
    if (!_pnPulso) {
        _pnPulso = fetch("/api/market/pulse")
            .then((r) => r.json())
            .then((d) => (d.ok ? d : Promise.reject(new Error(d.error || "Sin datos"))))
            .catch((error) => {
                _pnPulso = null
                throw error
            })
    }
    return _pnPulso
}

function pnCargarUniverso(clave) {
    if (clave === "sp500") return pnCargarPulso().then((d) => smSectoresToUniverseRows(d.snapshot?.sectores))
    if (!_pnUniversos[clave]) {
        _pnUniversos[clave] = fetch(`/api/market/pulse/universe?type=${encodeURIComponent(clave)}`)
            .then((r) => r.json())
            .then((d) => (d.ok ? d.items || [] : Promise.reject(new Error(d.error || "Sin datos"))))
            .catch((error) => {
                delete _pnUniversos[clave]
                throw error
            })
    }
    return _pnUniversos[clave]
}

function pnOlvidarPulso() {
    _pnPulso = null
    Object.keys(_pnUniversos).forEach((k) => delete _pnUniversos[k])
}

/** Pinta cuando llegan los datos, si el widget sigue en pantalla. */
function pnConPulso(w, cuerpo, pintar, cargar = pnCargarPulso) {
    const turno = pnTurno(w)
    cuerpo.innerHTML = `<div class="pnVacio">Cargando…</div>`
    cargar()
        .then((datos) => {
            if (pnVigente(w, turno)) pintar(datos)
        })
        .catch((error) => {
            if (pnVigente(w, turno))
                cuerpo.innerHTML = `<div class="pnVacio">No se pudieron cargar los datos: ${escapeHtml(error.message)}</div>`
        })
}

function pnCambiarOpcion(w, clave, defecto) {
    return (v) => {
        if (v === defecto) delete w.cfg[clave]
        else w.cfg[clave] = v
        pnGuardar()
        pnPintarWidget(w)
    }
}

const PN_RANGOS_FG = [
    { valor: "1M", texto: "1M", dias: 30 },
    { valor: "3M", texto: "3M", dias: 90 },
    { valor: "6M", texto: "6M", dias: 180 },
    { valor: "1A", texto: "1A", dias: 365 }
]

/** Semicírculo de miedo y codicia: los tramos de color y la aguja. */
function pnIndicadorFgSvg(valor) {
    const punto = (v, r) => {
        const a = Math.PI - (v / 100) * Math.PI
        return [100 + r * Math.cos(a), 100 - r * Math.sin(a)]
    }
    // Los mismos cortes que colorean la página de Sentimiento.
    const tramos = [
        [0, 24],
        [25, 44],
        [45, 55],
        [56, 75],
        [76, 100]
    ]
    const arcos = tramos
        .map(([desde, hasta]) => {
            const [x1, y1] = punto(desde + 0.8, 80)
            const [x2, y2] = punto(hasta - 0.8, 80)
            return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A80 80 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${smFgZoneColor((desde + hasta) / 2)}" />`
        })
        .join("")
    const [nx, ny] = punto(valor, 64)
    return `<svg class="pnFgArco" viewBox="0 0 200 112" aria-hidden="true">
        <g fill="none" stroke-width="14">${arcos}</g>
        <line x1="100" y1="100" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" class="pnFgAguja" />
        <circle cx="100" cy="100" r="6" class="pnFgEje" />
    </svg>`
}

function pnPintarMiedoCodicia(w, cuerpo, ctrls) {
    const cfg = w.cfg
    const vista = pnOpcion(cfg, "vista", ["completo", "indicador", "historial"], "completo")
    const rango = PN_RANGOS_FG.find((r) => r.valor === cfg.rango) || PN_RANGOS_FG[1]
    const conHistorial = vista !== "indicador"

    ctrls.innerHTML = ""
    if (conHistorial) pnSegmentado(ctrls, PN_RANGOS_FG, rango.valor, pnCambiarOpcion(w, "rango", "3M"), "Rango")

    pnConPulso(w, cuerpo, (d) => {
        const fg = d.fearGreed
        const historia = Array.isArray(d.fearGreedHistory) ? d.fearGreedHistory : []
        let html = `<div class="pnFg pnFg-${vista}">`
        if (vista !== "historial") {
            if (fg) {
                const valor = Math.max(0, Math.min(100, Number(fg.valor)))
                const color = smFgZoneColor(valor)
                html += `<div class="pnFgIndicador">
                    ${pnIndicadorFgSvg(valor)}
                    <b style="color:${color};text-shadow:0 0 22px ${color}77">${valor}</b>
                    <span>${escapeHtml(smFearGreedLabel(fg.clasificacion))}</span>
                </div>`
            } else {
                html += `<div class="pnVacio">Sin dato de miedo y codicia</div>`
            }
        }
        if (conHistorial && pnSi(cfg, "datos") && historia.length) {
            html += `<div class="smFgStatsStrip pnFgDatos">${smFgStatsStripHtml(historia)}</div>`
        }
        if (conHistorial) {
            html += historia.length
                ? `<div class="pnFgLienzo"><canvas></canvas></div>`
                : `<div class="pnVacio">Sin historial</div>`
        }
        cuerpo.innerHTML = html + "</div>"

        if (!conHistorial || !historia.length) return
        // La fuente da el más reciente primero; el gráfico va en orden de fechas.
        const tramo = historia.slice(0, rango.dias).reverse()
        const valores = tramo.map((p) => p.valor)
        const tenue = pnVarCss("--text-dim", "#64748b")
        const chart = new Chart(cuerpo.querySelector("canvas"), {
            type: "line",
            data: {
                labels: tramo.map((p) => smFgDateLabel(p.timestamp)),
                datasets: [
                    {
                        data: valores,
                        borderWidth: 2,
                        pointRadius: 0,
                        tension: 0.25,
                        fill: true,
                        backgroundColor: smFgAreaGradient(smFgZoneColor(valores[valores.length - 1])),
                        segment: { borderColor: (c) => smFgZoneColor((c.p0.parsed.y + c.p1.parsed.y) / 2) }
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: "index", intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (c) => ` ${c.parsed.y} · ${smFearGreedLabel(tramo[c.dataIndex]?.clasificacion)}`
                        }
                    }
                },
                scales: {
                    x: { ticks: { color: tenue, maxTicksLimit: 5, maxRotation: 0 }, grid: { display: false } },
                    y: {
                        min: 0,
                        max: 100,
                        position: "right",
                        ticks: { color: tenue, stepSize: 25 },
                        grid: { color: pnVarCss("--border-soft", "#1e2d45") }
                    }
                }
            }
        })
        _pnCharts.set(w.id, chart)
    })
}

function pnPintarAmplitud(w, cuerpo, ctrls) {
    ctrls.innerHTML = ""
    pnConPulso(w, cuerpo, (d) => {
        const b = d.breadth
        if (!b || !b.total) {
            cuerpo.innerHTML = `<div class="pnVacio">Sin datos de amplitud ahora mismo</div>`
            return
        }
        const pct = (b.subidas / b.total) * 100
        const color = pct >= 60 ? "#4ade80" : pct <= 40 ? "#f87171" : "#cbd5e1"
        const filas = [
            { texto: "Suben", valor: b.subidas, cls: "smLegendPos" },
            { texto: "Bajan", valor: b.bajadas, cls: "smLegendNeg" },
            { texto: "Planas", valor: b.planas, cls: "smLegendNd" }
        ]
        cuerpo.innerHTML = `
            <div class="pnAmplitud">
                <div class="pnDistLienzo"><canvas></canvas>
                    <div class="pnDistCentro"><b style="color:${color};font-size:1.3rem">${Math.round(pct)}%</b><small>suben</small></div>
                </div>
                <div class="pnAmplitudTexto">
                    <b>${escapeHtml(smBreadthLabel(b.subidas, b.bajadas, b.total))}</b>
                    ${
                        pnSi(w.cfg, "leyenda")
                            ? filas
                                  .map(
                                      (f) =>
                                          `<div class="smLegendRow"><span class="smLegendDot ${f.cls}"></span><span>${f.texto}</span><span class="smLegendCount">${f.valor}</span></div>`
                                  )
                                  .join("")
                            : ""
                    }
                    <small>${b.total} valores</small>
                </div>
            </div>`
        const chart = new Chart(cuerpo.querySelector("canvas"), {
            type: "doughnut",
            data: {
                labels: filas.map((f) => f.texto),
                datasets: [
                    {
                        data: filas.map((f) => f.valor),
                        backgroundColor: ["#2ecc71", "#e74c3c", "#64748b"],
                        borderColor: pnVarCss("--bg-panel", "#0f1724"),
                        borderWidth: 2,
                        spacing: 2
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                cutout: "72%",
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: { label: (c) => ` ${c.label}: ${c.raw} (${((c.raw / b.total) * 100).toFixed(1)} %)` }
                    }
                }
            }
        })
        _pnCharts.set(w.id, chart)
    })
}

function pnPintarIndices(w, cuerpo, ctrls) {
    ctrls.innerHTML = ""
    const elegidos = pnLista(w.cfg, "grupos")
    pnConPulso(w, cuerpo, (d) => {
        const indices = Array.isArray(d.snapshot?.indices) ? d.snapshot.indices : []
        const porClave = new Map(indices.map((i) => [i.key, i]))
        const html = SM_INDEX_GROUPS.filter((g) => !elegidos.length || elegidos.includes(g.label))
            .map((g) => {
                const tarjetas = g.keys
                    .map((k) => porClave.get(k))
                    .filter(Boolean)
                    .map(smIndexCardHtml)
                    .join("")
                return tarjetas
                    ? `<div class="smIndexGroup"><span class="smIndexGroupLabel">${escapeHtml(g.label)}</span><div class="smIndexCards">${tarjetas}</div></div>`
                    : ""
            })
            .join("")
        cuerpo.innerHTML = `<div class="pnIndices">${html || `<div class="pnVacio">Sin datos de índices ahora mismo</div>`}</div>`
        cuerpo.querySelector(".pnIndices").addEventListener("click", (e) => {
            const tarjeta = e.target.closest(".smIndexCard")
            if (tarjeta?.dataset.symbol) pnSeleccionarActivo("tv:" + tarjeta.dataset.symbol)
        })
    })
}

const PN_UNIVERSOS = [
    { valor: "sp500", texto: "S&P 500" },
    { valor: "nasdaq100", texto: "Nasdaq 100" },
    { valor: "cripto", texto: "Cripto" }
]

function pnPintarSectores(w, cuerpo, ctrls) {
    const cfg = w.cfg
    const universo = pnOpcion(
        cfg,
        "universo",
        PN_UNIVERSOS.map((u) => u.valor),
        "sp500"
    )
    ctrls.innerHTML = ""
    pnSegmentado(ctrls, PN_UNIVERSOS, universo, pnCambiarOpcion(w, "universo", "sp500"), "Universo")

    pnConPulso(
        w,
        cuerpo,
        (filas) => {
            const validas = (filas || []).filter((f) => f.size > 0)
            if (!validas.length) {
                cuerpo.innerHTML = `<div class="pnVacio">Sin datos ahora mismo</div>`
                return
            }
            cuerpo.innerHTML = `<div class="pnMapa"></div>`
            const lienzo = cuerpo.querySelector(".pnMapa")
            pnBindMapa(lienzo)
            const total = validas.reduce((s, f) => s + f.size, 0)
            const items = validas.map((f) => ({
                id: "tv:" + f.symbol,
                nombre: f.primary || f.symbol,
                simbolo: String(f.symbol || "")
                    .split(":")
                    .pop(),
                valor: Number.isFinite(f.change) ? f.change : null,
                peso: f.size / total,
                precio: Number(f.price) || 0,
                currency: f.currency || "USD",
                netoEur: 0,
                invertidoEur: 0,
                mov: null
            }))
            // Los sectores del S&P 500 se leen por su nombre («Tecnología»);
            // las acciones y las monedas, por su símbolo.
            const rotulo = cfg.etiqueta || (universo === "sp500" ? "nombre" : "simbolo")
            const dibujar = () => {
                lienzo.innerHTML = ""
                pnBaldosas(
                    lienzo,
                    items,
                    { x: 0, y: 0, w: lienzo.clientWidth || 400, h: lienzo.clientHeight || 300 },
                    { etiqueta: rotulo },
                    "dia",
                    SM_UNIVERSE_SCALE[universo] || 3,
                    { eur: false, precio: false }
                )
            }
            dibujar()
            pnObservarTamano(w, cuerpo, dibujar)
        },
        () => pnCargarUniverso(universo)
    )
}

const PN_LISTAS_ESCANER = [
    { valor: "suben", texto: "Más suben" },
    { valor: "bajan", texto: "Más bajan" },
    { valor: "sobrecompra", texto: "RSI sobrecompra" },
    { valor: "sobreventa", texto: "RSI sobreventa" },
    { valor: "volumen", texto: "Volumen inusual" }
]

function pnPintarEscaner(w, cuerpo, ctrls) {
    const lista = pnOpcion(
        w.cfg,
        "lista",
        PN_LISTAS_ESCANER.map((l) => l.valor),
        "suben"
    )
    ctrls.innerHTML = ""
    pnChip(
        ctrls,
        PN_LISTAS_ESCANER.find((l) => l.valor === lista).texto,
        PN_LISTAS_ESCANER,
        lista,
        pnCambiarOpcion(w, "lista", "suben"),
        "Lista"
    )

    pnConPulso(w, cuerpo, (d) => {
        const fuentes = {
            suben: [d.movers?.subidas, smMoverRowHtml],
            bajan: [d.movers?.bajadas, smMoverRowHtml],
            sobrecompra: [d.rsi?.sobrecompra, smRsiRowHtml],
            sobreventa: [d.rsi?.sobreventa, smRsiRowHtml],
            volumen: [d.unusualVolume, smVolumeRowHtml]
        }
        const [filas, fila] = fuentes[lista]
        const html = (filas || [])
            .map((f, i) => `<div class="pnEscFila" data-activo="${escapeAttr("tv:" + f.ticker)}">${fila(f, i)}</div>`)
            .join("")
        cuerpo.innerHTML = `<div class="pnEscaner">${html || `<div class="pnVacio">Sin datos ahora mismo</div>`}</div>`
        cuerpo.querySelector(".pnEscaner").addEventListener("click", (e) => {
            const f = e.target.closest("[data-activo]")
            if (f) pnSeleccionarActivo(f.dataset.activo)
        })
    })
}
