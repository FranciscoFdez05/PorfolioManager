// Activos > Paneles: widgets de cartera, favoritos, rendimiento, distribución, resumen y notas.
//
// Trozo de js/cartera/paneles.js. Comparte con el resto de paneles-*.js el
// ámbito global y se carga detrás de paneles.js, en el orden de index.html.

// ── Widget: tu cartera ──────────────────────────────────────────────────────

const PN_COLUMNAS_CARTERA = [
    { clave: "nombre", texto: "Instrumento", izquierda: true },
    { clave: "participaciones", texto: "Posición" },
    { clave: "precio", texto: "Último precio" },
    { clave: "precioMedio", texto: "Precio medio" },
    { clave: "dia", texto: "Hoy" },
    { clave: "hoyEur", texto: "Hoy €", dinero: true },
    { clave: "netoEur", texto: "Valor", dinero: true },
    { clave: "invertidoEur", texto: "Invertido", dinero: true },
    { clave: "rendEur", texto: "Rend. €", dinero: true },
    { clave: "rendPct", texto: "Rend. %" },
    { clave: "peso", texto: "Peso" }
]

// Columnas que se ven en una tabla sin elegir ninguna: las de siempre.
const PN_COLUMNAS_DEFECTO = [
    "participaciones",
    "precio",
    "dia",
    "netoEur",
    "invertidoEur",
    "rendEur",
    "rendPct",
    "peso"
]

function pnPintarCartera(w, cuerpo, ctrls) {
    const cfg = w.cfg
    const orden = PN_COLUMNAS_CARTERA.some((c) => c.clave === cfg.orden) ? cfg.orden : "netoEur"
    const dir = cfg.dir === "asc" ? 1 : -1
    const elegidas = pnLista(cfg, "columnas")
    const columnas = PN_COLUMNAS_CARTERA.filter(
        (c) => c.clave === "nombre" || (elegidas.length ? elegidas : PN_COLUMNAS_DEFECTO).includes(c.clave)
    )
    const detalle = pnSi(cfg, "detalle")

    ctrls.innerHTML = ""
    const tipos = pnLista(cfg, "tipos")
    pnChip(
        ctrls,
        pnTextoFiltro(cfg, "Todos los tipos"),
        [
            { valor: "", texto: "Todos los tipos" },
            ...PN_TIPOS_ACTIVO.map((t) => ({ ...t, marcado: tipos.includes(t.valor) }))
        ],
        tipos.length ? null : "",
        (v) => {
            const nueva = !v ? [] : tipos.includes(v) ? tipos.filter((t) => t !== v) : [...tipos, v]
            if (nueva.length) cfg.tipos = nueva
            else delete cfg.tipos
            pnGuardar()
            pnPintarWidget(w)
        },
        "Tipos"
    )

    // El peso es sobre toda la cartera, no sobre lo filtrado: «un 8 % de lo
    // que tengo», que es lo que se pregunta al mirar esa columna.
    const totalCartera = pnPosiciones().reduce((s, a) => s + a.netoEur, 0)
    const filas = pnActivosDelWidget(cfg)
        .map((a) => ({ ...a, peso: totalCartera > 0 ? (a.netoEur / totalCartera) * 100 : 0 }))
        .sort((a, b) => {
            const va = a[orden]
            const vb = b[orden]
            if (typeof va === "string") return va.localeCompare(vb) * dir
            return ((va ?? -Infinity) - (vb ?? -Infinity)) * dir
        })

    if (!filas.length) {
        cuerpo.innerHTML = `<div class="pnVacio">No hay posiciones abiertas con estos filtros</div>`
        return
    }

    const suma = (k) => filas.reduce((s, a) => s + (a[k] || 0), 0)
    const totValor = suma("netoEur")
    const totInv = suma("invertidoEur")
    const totRend = totValor - totInv
    const totHoy = suma("hoyEur")
    const totPeso = suma("peso")

    const celda = (a, c) => {
        switch (c.clave) {
            case "nombre":
                return `<td class="pnTdNombre"><div><span class="pnPunto" style="background:${escapeAttr(pnColorActivo(a))}"></span><span><b>${escapeHtml(a.nombre)}</b>${
                    detalle
                        ? `<small>${escapeHtml(buildAssetTypeLabel(a.tipo))} · ${escapeHtml(a.simbolo || "")}</small>`
                        : ""
                }</span></div></td>`
            case "participaciones":
                return `<td class="pnMoney">${escapeHtml(formatShareQuantity(a.participaciones))}</td>`
            case "precio":
                return `<td>${escapeHtml(pnPrecio(a))}</td>`
            case "precioMedio":
                return `<td class="pnMoney">${a.precioMedio > 0 ? escapeHtml(hmFormatPrice(a.precioMedio, a.currency)) : "—"}</td>`
            case "dia":
                return `<td class="${pnClaseSigno(a.dia)}">${pnPct(a.dia)}</td>`
            case "hoyEur":
                return `<td class="pnMoney ${pnClaseSigno(a.hoyEur)}">${a.hoyEur === null ? "—" : pnEurFirmado(a.hoyEur)}</td>`
            case "netoEur":
                return `<td class="pnMoney"><b>${pnEur(a.netoEur)}</b></td>`
            case "invertidoEur":
                return `<td class="pnMoney">${pnEur(a.invertidoEur)}</td>`
            case "rendEur":
                return `<td class="pnMoney ${pnClaseSigno(a.rendEur)}">${pnEurFirmado(a.rendEur)}</td>`
            case "rendPct":
                return `<td class="${pnClaseSigno(a.rendPct)}">${pnPct(a.rendPct)}</td>`
            case "peso":
                return `<td><span class="pnPeso"><span style="width:${Math.min(100, a.peso).toFixed(1)}%"></span></span>${pnPct(a.peso, false)}</td>`
        }
        return "<td></td>"
    }

    const pieCelda = (c) => {
        switch (c.clave) {
            case "nombre":
                return `<td class="pnIzq">${filas.length} posiciones</td>`
            case "hoyEur":
                return `<td class="pnMoney ${pnClaseSigno(totHoy)}">${pnEurFirmado(totHoy)}</td>`
            case "dia": {
                const base = totValor - totHoy
                return `<td class="${pnClaseSigno(totHoy)}">${base > 0 ? pnPct((totHoy / base) * 100) : "—"}</td>`
            }
            case "netoEur":
                return `<td class="pnMoney"><b>${pnEur(totValor)}</b></td>`
            case "invertidoEur":
                return `<td class="pnMoney">${pnEur(totInv)}</td>`
            case "rendEur":
                return `<td class="pnMoney ${pnClaseSigno(totRend)}">${pnEurFirmado(totRend)}</td>`
            case "rendPct":
                return `<td class="${pnClaseSigno(totRend)}">${totInv > 0 ? pnPct((totRend / totInv) * 100) : "—"}</td>`
            case "peso":
                return `<td>${pnPct(totPeso, false)}</td>`
        }
        return "<td></td>"
    }

    cuerpo.innerHTML = `
        <div class="pnTablaWrap">
            <table class="pnTabla${pnSi(cfg, "compacta", false) ? " pnCompacta" : ""}">
                <thead><tr>${columnas
                    .map(
                        (c) =>
                            `<th data-orden="${c.clave}" class="${c.izquierda ? "pnIzq" : ""}${c.clave === orden ? " pnOrdenado" : ""}">${escapeHtml(c.texto)}${
                                c.clave === orden ? (dir > 0 ? " ▲" : " ▼") : ""
                            }</th>`
                    )
                    .join("")}</tr></thead>
                <tbody>${filas
                    .map(
                        (a) => `<tr data-activo="${escapeAttr(a.id)}">${columnas.map((c) => celda(a, c)).join("")}</tr>`
                    )
                    .join("")}</tbody>
                ${pnSi(cfg, "totales") ? `<tfoot><tr>${columnas.map(pieCelda).join("")}</tr></tfoot>` : ""}
            </table>
        </div>`

    cuerpo.querySelector("thead").addEventListener("click", (e) => {
        const th = e.target.closest("th[data-orden]")
        if (!th) return
        if (cfg.orden === th.dataset.orden || (!cfg.orden && th.dataset.orden === "netoEur")) {
            cfg.dir = cfg.dir === "asc" ? "desc" : "asc"
        } else {
            cfg.orden = th.dataset.orden
            cfg.dir = th.dataset.orden === "nombre" ? "asc" : "desc"
        }
        pnGuardar()
        pnPintarWidget(w)
    })
    cuerpo.querySelector("tbody").addEventListener("click", (e) => {
        const tr = e.target.closest("tr[data-activo]")
        if (tr) pnSeleccionarActivo(tr.dataset.activo)
    })
}

// ── Widget: favoritos ───────────────────────────────────────────────────────

function pnPintarFavoritos(w, cuerpo, ctrls) {
    const cfg = w.cfg

    ctrls.innerHTML = ""
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "pnChip"
    btn.innerHTML = `<span>${pnLista(cfg, "activos").length ? "Editar lista" : "Elegir activos"}</span><span class="pnChipFlecha">▾</span>`
    pnControlCabecera(btn, "Activos", (ancla) =>
        pnSelectorActivos(ancla, {
            opciones: pnTodosLosActivos().filter((a) => !a.oculto || cfg.ocultos === true),
            seleccion: pnLista(cfg, "activos"),
            alCambiar: (ids) => {
                if (ids.length) cfg.activos = ids
                else delete cfg.activos
                pnGuardar()
                pnListaFavoritos(w, cuerpo)
            }
        })
    )
    ctrls.appendChild(btn)
    pnListaFavoritos(w, cuerpo)
}

function pnListaFavoritos(w, cuerpo) {
    const cfg = w.cfg
    // Sin lista propia: todo lo de la cartera que no esté oculto, también lo
    // que solo se sigue (activos sin compras), en el orden de la barra lateral.
    const items = pnActivosDelWidget(cfg, { soloPosiciones: false })
    const orden = pnOpcion(cfg, "orden", ["manual", "sube", "baja", "nombre"], "manual")
    const dia = (a) => (Number.isFinite(a.dia) ? a.dia : null)
    if (orden === "sube") items.sort((a, b) => (dia(b) ?? -Infinity) - (dia(a) ?? -Infinity))
    if (orden === "baja") items.sort((a, b) => (dia(a) ?? Infinity) - (dia(b) ?? Infinity))
    if (orden === "nombre") items.sort((a, b) => a.nombre.localeCompare(b.nombre))

    if (!items.length) {
        cuerpo.innerHTML = `<div class="pnVacio">Pulsa «Elegir activos» para montar tu lista</div>`
        return
    }
    const verPrecio = pnSi(cfg, "precio")
    const verVar = pnSi(cfg, "variacion")
    const verPos = pnSi(cfg, "posicion", false)
    const verLogo = pnSi(cfg, "logo")

    cuerpo.innerHTML = `<div class="pnLista${pnSi(cfg, "compacta", false) ? " pnCompacta" : ""}">${items
        .map(
            (a) => `
            <button type="button" class="pnFila" data-activo="${escapeAttr(a.id)}">
                ${verLogo ? `<span class="pnFilaLogo" style="background:${escapeAttr(pnColorActivo(a))}">${escapeHtml(String(a.simbolo || a.nombre).slice(0, 1))}</span>` : ""}
                <span class="pnFilaNombre"><b>${escapeHtml(a.nombre)}</b><small>${escapeHtml(a.simbolo || "")}</small></span>
                ${verPos && a.netoEur > 0 ? `<span class="pnFilaPrecio pnMoney"><b>${pnEur(a.netoEur)}</b><small class="${pnClaseSigno(a.rendEur)}">${pnPct(a.rendPct)}</small></span>` : ""}
                ${
                    verPrecio || verVar
                        ? `<span class="pnFilaPrecio">${verPrecio ? `<b>${escapeHtml(pnPrecio(a))}</b>` : ""}${
                              verVar ? `<small class="${pnClaseSigno(a.dia)}">${pnPct(a.dia)}</small>` : ""
                          }</span>`
                        : ""
                }
            </button>`
        )
        .join("")}</div>`
    cuerpo.querySelector(".pnLista").addEventListener("click", (e) => {
        const fila = e.target.closest(".pnFila")
        if (fila) pnSeleccionarActivo(fila.dataset.activo)
    })
}

// ── Widget: tu rendimiento ──────────────────────────────────────────────────

function pnPintarRendimiento(w, cuerpo, ctrls) {
    const turno = pnTurno(w)
    const cfg = w.cfg
    const rango = pnOpcion(
        cfg,
        "rango",
        PN_RANGOS.map((r) => r.valor),
        "3M"
    )
    const ganancia = cfg.modo === "ganancia"
    const verInvertido = !ganancia && pnSi(cfg, "invertido")
    const relleno = pnSi(cfg, "relleno")
    const cabecera = pnSi(cfg, "cabecera")

    ctrls.innerHTML = ""
    pnSegmentado(
        ctrls,
        PN_RANGOS,
        rango,
        (v) => {
            if (v === "3M") delete cfg.rango
            else cfg.rango = v
            pnGuardar()
            pnPintarWidget(w)
        },
        "Rango"
    )

    cuerpo.innerHTML = `
        <div class="pnRend">
            <div class="pnRendCab"${cabecera ? "" : " hidden"}>
                <span class="pnRendValor pnMoney">—</span>
                <span class="pnRendCambio pnMoney"></span>
            </div>
            <div class="pnRendLienzo"><canvas></canvas></div>
        </div>`

    fetch(`/api/portfolio/history?range=${encodeURIComponent(rango)}`)
        .then((r) => r.json())
        .then((data) => {
            if (!pnVigente(w, turno)) return
            let puntos = Array.isArray(data.data) ? data.data : []

            // El último punto es el valor de ahora mismo, para que la línea
            // acabe donde dicen los demás widgets (los snapshots son periódicos).
            const pos = pnPosiciones()
            const vivo = pos.reduce((s, a) => s + a.netoEur, 0)
            const invVivo = pos.reduce((s, a) => s + a.invertidoEur, 0)
            const ahora = Math.floor(Date.now() / 1000)
            if (pos.length) {
                const ultimo = puntos[puntos.length - 1]
                const punto = { ts: ahora, v: vivo, i: invVivo }
                puntos = ultimo && ahora - ultimo.ts < 120 ? [...puntos.slice(0, -1), punto] : [...puntos, punto]
            }

            const cab = cuerpo.querySelector(".pnRendCab")
            cab.querySelector(".pnRendValor").textContent = ganancia
                ? pnEurFirmado(vivo - invVivo)
                : pnEur(vivo || puntos[puntos.length - 1]?.v || 0)

            if (puntos.length < 2) {
                cuerpo.querySelector(".pnRendLienzo").innerHTML =
                    `<div class="pnVacio">Aún no hay historial para este periodo</div>`
                return
            }

            // Lo que ha ganado la cartera en el periodo, sin contar lo que se ha
            // metido o sacado: la diferencia de las ganancias, no de los valores.
            const primero = puntos[0]
            const ultimo = puntos[puntos.length - 1]
            const cambioEur = ultimo.v - ultimo.i - (primero.v - primero.i)
            const base = primero.v > 0 ? primero.v : primero.i
            const cambio = cab.querySelector(".pnRendCambio")
            cambio.className = "pnRendCambio pnMoney " + pnClaseSigno(cambioEur)
            cambio.textContent = `${pnEurFirmado(cambioEur)} (${base > 0 ? pnPct((cambioEur / base) * 100) : "—"}) · ${
                PN_RANGOS.find((r) => r.valor === rango).texto
            }`

            const acento = pnVarCss("--accent", "#3b82f6")
            const tenue = pnVarCss("--text-dim", "#64748b")
            const rejilla = pnVarCss("--border-soft", "#1e2d45")
            const fecha = (ts) => {
                const d = new Date(ts * 1000)
                return rango === "1M" || rango === "3M"
                    ? d.toLocaleDateString(_nl(), { day: "numeric", month: "short" })
                    : d.toLocaleDateString(_nl(), { month: "short", year: "2-digit" })
            }
            const canvas = cuerpo.querySelector("canvas")
            const ctx = canvas.getContext("2d")
            const degradado = ctx.createLinearGradient(0, 0, 0, canvas.parentElement.clientHeight || 200)
            const hex = /^#[0-9a-f]{6}$/i.test(acento) ? acento : "#3b82f6"
            degradado.addColorStop(0, hex + "55")
            degradado.addColorStop(1, hex + "00")

            const datasets = [
                {
                    label: ganancia ? "Ganancia" : "Valor",
                    data: puntos.map((p) => (ganancia ? p.v - p.i : p.v)),
                    borderColor: acento,
                    backgroundColor: degradado,
                    fill: relleno,
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.25
                }
            ]
            if (verInvertido) {
                datasets.push({
                    label: "Invertido",
                    data: puntos.map((p) => p.i),
                    borderColor: tenue,
                    borderDash: [4, 4],
                    borderWidth: 1.25,
                    pointRadius: 0,
                    fill: false
                })
            }

            const chart = new Chart(canvas, {
                type: "line",
                data: { labels: puntos.map((p) => fecha(p.ts)), datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    interaction: { mode: "index", intersect: false },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: (c) =>
                                    `${c.dataset.label}: ${ganancia ? pnEurFirmado(c.parsed.y) : pnEur(c.parsed.y)}`
                            }
                        }
                    },
                    scales: {
                        x: { ticks: { color: tenue, maxTicksLimit: 6, maxRotation: 0 }, grid: { display: false } },
                        y: {
                            position: "right",
                            ticks: {
                                color: tenue,
                                maxTicksLimit: 5,
                                callback: (v) => new Intl.NumberFormat(_nl(), { notation: "compact" }).format(v) + " €"
                            },
                            grid: { color: rejilla }
                        }
                    }
                }
            })
            _pnCharts.set(w.id, chart)
        })
        .catch((error) => {
            console.error("Paneles: historial", error)
            cuerpo.querySelector(".pnRendLienzo").innerHTML =
                `<div class="pnVacio">No se pudo cargar el historial</div>`
        })
}

// ── Widget: distribución ────────────────────────────────────────────────────

function pnPintarDistribucion(w, cuerpo, ctrls) {
    const cfg = w.cfg
    const por = pnOpcion(cfg, "por", ["tipo", "activo", "divisa"], "tipo")
    const forma = pnOpcion(cfg, "forma", ["anillo", "tarta", "barras"], "anillo")
    const maximo = Number(pnOpcion(cfg, "maximo", ["0", "5", "8", "12"], "0"))
    const verLeyenda = pnSi(cfg, "leyenda")
    const verImportes = pnSi(cfg, "importes", false)

    ctrls.innerHTML = ""
    pnSegmentado(
        ctrls,
        [
            { valor: "tipo", texto: "Tipo" },
            { valor: "activo", texto: "Activo" },
            { valor: "divisa", texto: "Divisa" }
        ],
        por,
        (v) => {
            if (v === "tipo") delete cfg.por
            else cfg.por = v
            pnGuardar()
            pnPintarWidget(w)
        },
        "Agrupar por"
    )

    const pos = pnActivosDelWidget(cfg)
    const total = pos.reduce((s, a) => s + a.netoEur, 0)
    if (!pos.length || total <= 0) {
        cuerpo.innerHTML = `<div class="pnVacio">No hay posiciones abiertas con estos filtros</div>`
        return
    }

    let partes
    if (por === "activo") {
        partes = pos.map((a) => ({ nombre: a.nombre, valor: a.netoEur, color: pnColorActivo(a), id: a.id }))
    } else {
        const clave = (a) => (por === "tipo" ? a.tipo : a.currency || "EUR")
        const grupos = new Map()
        pos.forEach((a) => grupos.set(clave(a), (grupos.get(clave(a)) || 0) + a.netoEur))
        partes = [...grupos].map(([k, valor]) => ({
            nombre: por === "tipo" ? buildAssetTypeLabel(k) : k,
            valor,
            color:
                por === "tipo" ? pnColorTipo(k) : typeof mPaletteForName === "function" ? mPaletteForName(k) : "#64748b"
        }))
    }
    partes.sort((a, b) => b.valor - a.valor)
    if (maximo && partes.length > maximo) {
        const resto = partes.slice(maximo - 1)
        partes = [
            ...partes.slice(0, maximo - 1),
            { nombre: `Otros (${resto.length})`, valor: resto.reduce((s, p) => s + p.valor, 0), color: "#64748b" }
        ]
    }

    const leyenda = verLeyenda
        ? `<div class="pnDistLeyenda">${partes
              .map(
                  (p) => `<div class="pnDistFila"${p.id ? ` data-activo="${escapeAttr(p.id)}"` : ""}>
                    <span class="pnPunto" style="background:${escapeAttr(p.color)}"></span>
                    <span class="pnDistNombre">${escapeHtml(p.nombre)}</span>
                    ${verImportes ? `<span class="pnDistPct pnMoney">${pnEur(p.valor)}</span>` : ""}
                    <span class="pnDistPct">${pnPct((p.valor / total) * 100, false)}</span>
                </div>`
              )
              .join("")}</div>`
        : ""

    if (forma === "barras") {
        const mayor = partes[0].valor
        cuerpo.innerHTML = `<div class="pnBarras">${partes
            .map(
                (p) => `<div class="pnBarra"${p.id ? ` data-activo="${escapeAttr(p.id)}"` : ""}>
                    <span class="pnBarraNombre">${escapeHtml(p.nombre)}</span>
                    <span class="pnBarraPista"><span style="width:${((p.valor / mayor) * 100).toFixed(1)}%;background:${escapeAttr(p.color)}"></span></span>
                    <span class="pnDistPct">${verImportes ? `<span class="pnMoney">${pnEur(p.valor)}</span> · ` : ""}${pnPct((p.valor / total) * 100, false)}</span>
                </div>`
            )
            .join("")}</div>`
    } else {
        cuerpo.innerHTML = `
            <div class="pnDist${verLeyenda ? "" : " pnSinLeyenda"}">
                <div class="pnDistLienzo"><canvas></canvas>${
                    forma === "anillo"
                        ? `<div class="pnDistCentro"><small>Total</small><b class="pnMoney">${pnEur(total)}</b></div>`
                        : ""
                }</div>
                ${leyenda}
            </div>`

        const chart = new Chart(cuerpo.querySelector("canvas"), {
            type: "doughnut",
            data: {
                labels: partes.map((p) => p.nombre),
                datasets: [
                    {
                        data: partes.map((p) => p.valor),
                        backgroundColor: partes.map((p) => p.color),
                        borderColor: pnVarCss("--bg-panel", "#0f1724"),
                        borderWidth: 2
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                cutout: forma === "anillo" ? "68%" : 0,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (c) => `${c.label}: ${pnEur(c.parsed)} (${pnPct((c.parsed / total) * 100, false)})`
                        }
                    }
                }
            }
        })
        _pnCharts.set(w.id, chart)
    }

    cuerpo.addEventListener("click", (e) => {
        const fila = e.target.closest("[data-activo]")
        if (fila) pnSeleccionarActivo(fila.dataset.activo)
    })
}

// ── Widget: resumen ─────────────────────────────────────────────────────────

function pnPintarResumen(w, cuerpo, ctrls) {
    const cfg = w.cfg
    ctrls.innerHTML = ""
    const pos = pnActivosDelWidget(cfg)
    if (!pos.length) {
        cuerpo.innerHTML = `<div class="pnVacio">No hay posiciones abiertas con estos filtros</div>`
        return
    }
    const bloques = pnLista(cfg, "bloques").length ? pnLista(cfg, "bloques") : ["total", "kpis", "movers"]
    const cuantos = Number(pnOpcion(cfg, "cuantos", ["3", "5", "10"], "3"))
    const filtrado = pnLista(cfg, "activos").length || pnLista(cfg, "tipos").length

    const valor = pos.reduce((s, a) => s + a.netoEur, 0)
    const invertido = pos.reduce((s, a) => s + a.invertidoEur, 0)
    const rend = valor - invertido
    const hoy = pos.reduce((s, a) => s + (a.hoyEur || 0), 0)
    const baseHoy = valor - hoy

    const conDia = pos.filter((a) => a.dia !== null && Number.isFinite(a.dia)).sort((a, b) => b.dia - a.dia)
    const suben = conDia.filter((a) => a.dia > 0).slice(0, cuantos)
    const bajan = conDia
        .filter((a) => a.dia < 0)
        .reverse()
        .slice(0, cuantos)

    const mover = (a) => `
        <button type="button" class="pnMover" data-activo="${escapeAttr(a.id)}">
            <span class="pnMoverNombre">${escapeHtml(a.nombre)}</span>
            <span class="${pnClaseSigno(a.dia)}">${pnPct(a.dia)}</span>
        </button>`

    cuerpo.innerHTML = `
        <div class="pnResumen">
            ${
                bloques.includes("total")
                    ? `<div class="pnResumenTotal">
                <small>${filtrado ? `Valor · ${escapeHtml(pnTextoFiltro(cfg))}` : "Valor de la cartera"}</small>
                <b class="pnMoney">${pnEur(valor)}</b>
                <span class="pnMoney ${pnClaseSigno(hoy)}">${pnEurFirmado(hoy)} (${baseHoy > 0 ? pnPct((hoy / baseHoy) * 100) : "—"}) hoy</span>
            </div>`
                    : ""
            }
            ${
                bloques.includes("kpis")
                    ? `<div class="pnKpis">
                <div class="pnKpi"><small>Invertido</small><b class="pnMoney">${pnEur(invertido)}</b></div>
                <div class="pnKpi"><small>Rendimiento</small><b class="pnMoney ${pnClaseSigno(rend)}">${pnEurFirmado(rend)}</b><span class="${pnClaseSigno(rend)}">${invertido > 0 ? pnPct((rend / invertido) * 100) : "—"}</span></div>
            </div>`
                    : ""
            }
            ${
                bloques.includes("movers")
                    ? `<div class="pnMovers">
                <div><small>Suben hoy</small>${suben.map(mover).join("") || `<span class="pnTenue">—</span>`}</div>
                <div><small>Bajan hoy</small>${bajan.map(mover).join("") || `<span class="pnTenue">—</span>`}</div>
            </div>`
                    : ""
            }
        </div>`
    cuerpo.querySelector(".pnResumen").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-activo]")
        if (btn) pnSeleccionarActivo(btn.dataset.activo)
    })
}

// ── Widget: notas ───────────────────────────────────────────────────────────

function pnPintarNotas(w, cuerpo, ctrls) {
    ctrls.innerHTML = ""
    const letra = pnOpcion(w.cfg, "letra", ["s", "m", "l"], "m")
    cuerpo.innerHTML = `<textarea class="pnNotas pnLetra-${letra}${pnSi(w.cfg, "mono", false) ? " pnMono" : ""}" maxlength="5000" placeholder="Ideas, niveles a vigilar, recordatorios…"></textarea>`
    const area = cuerpo.querySelector("textarea")
    area.value = w.cfg.texto || ""
    area.addEventListener("input", () => {
        w.cfg.texto = area.value
        pnGuardar()
    })
}

// Ajustes de los widgets de mercado e información. Va al final porque usa las
// listas de opciones de sus widgets (rangos, intervalos, países), declaradas
// más arriba con `const`: antes de ellas, la carga del fichero se cortaba aquí.
const PN_CAMPO_VINCULAR = {
    clave: "vincular",
    tipo: "check",
    etiqueta: "Enlazado con el panel",
    ayuda: "Al pulsar un activo en otro widget, se abre aquí.",
    defecto: true
}

Object.assign(PN_AJUSTES, {
    // El mapa de mercado: las mismas opciones con otros valores por defecto
    // (baldosas iguales, precio en vez de euros) y sin «desde la compra».
    mapaMercado: PN_AJUSTES.mapa.map((seccion) => ({
        ...seccion,
        campos: seccion.campos.map((c) => {
            if (c.clave === "activos")
                return {
                    ...c,
                    ayuda: "Sin elegir ninguno, los de la lista Seguimiento de Activos › Watchlist. Escribe en el buscador para añadir cualquier ticker del mercado."
                }
            if (c.clave === "periodo") return { ...c, opciones: PN_PERIODOS.filter((p) => p.valor !== "todo") }
            if (c.clave === "tamano") return { ...c, defecto: "igual" }
            if (c.clave === "eur") return { ...c, defecto: false }
            if (c.clave === "precio") return { ...c, defecto: true }
            if (c.clave === "invertido") return { ...c, defecto: true }
            return c
        })
    })),
    instrumento: [
        {
            titulo: "Instrumento",
            campos: [
                { clave: "rango", tipo: "seg", etiqueta: "Periodo", opciones: PN_RANGOS_INSTRUMENTO, defecto: "12M" },
                { clave: "cabecera", tipo: "check", etiqueta: "Precio y variación encima", defecto: true },
                PN_CAMPO_VINCULAR
            ]
        }
    ],
    tecnico: [
        {
            titulo: "Análisis técnico",
            campos: [
                {
                    clave: "intervalo",
                    tipo: "seg",
                    etiqueta: "Intervalo",
                    opciones: PN_INTERVALOS_TECNICO,
                    defecto: "1D"
                },
                {
                    clave: "detalle",
                    tipo: "seg",
                    etiqueta: "Indicadores",
                    opciones: [
                        { valor: "single", texto: "Solo el resumen" },
                        { valor: "multiple", texto: "Osciladores y medias" }
                    ],
                    defecto: "single"
                },
                { clave: "pestanas", tipo: "check", etiqueta: "Pestañas de intervalo", defecto: true },
                PN_CAMPO_VINCULAR
            ]
        }
    ],
    ficha: [{ titulo: "Ficha", campos: [PN_CAMPO_VINCULAR] }],
    perfil: [{ titulo: "Perfil", campos: [PN_CAMPO_VINCULAR] }],
    noticias: [
        {
            titulo: "Noticias",
            campos: [
                {
                    clave: "modo",
                    tipo: "seg",
                    etiqueta: "Qué noticias",
                    ayuda: "Vienen en inglés: TradingView no ofrece este widget en español.",
                    opciones: [
                        { valor: "general", texto: "Del mercado" },
                        { valor: "activo", texto: "Del activo" }
                    ],
                    defecto: "general"
                },
                { clave: "compacta", tipo: "check", etiqueta: "Solo titulares", defecto: false },
                { ...PN_CAMPO_VINCULAR, ayuda: "Con «Del activo», sigue al activo que se pulse en otro widget." }
            ]
        }
    ],
    calendario: [
        {
            titulo: "Calendario",
            campos: [
                {
                    clave: "importancia",
                    tipo: "seg",
                    etiqueta: "Importancia",
                    opciones: PN_IMPORTANCIAS,
                    defecto: "-1,0,1"
                },
                {
                    clave: "paises",
                    tipo: "multi",
                    etiqueta: "Países",
                    ayuda: "Sin marcar ninguno se muestran todos los de la lista.",
                    opciones: PN_PAISES
                }
            ]
        }
    ]
})
