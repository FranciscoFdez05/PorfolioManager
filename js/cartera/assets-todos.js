// Ficha del activo: pestaña «Todos» (filas, gráficos) y ventas desde la ficha.
//
// Separado de js/cartera/assets.js, que pasaba de 6.000 líneas. Es código
// de nivel superior que comparte el ámbito global con el resto de trozos
// (index.html los carga seguidos y en este orden); no ha cambiado.

const ASSET_TODOS_ORIGENES = {
    spot: { etiqueta: "Compra spot", clase: "todosOrigenSpot" },
    operacion: { etiqueta: "Operación spot", clase: "todosOrigenOperacion" }
}

function buildAssetTodosRows(asset) {
    const currency = normalizeCurrencyCode(asset?.currency || "EUR")
    const assetType = asset?.type || "cripto"
    const filas = []

    getPrimaryAssetRows(asset).forEach((row) => {
        const rowCurrency = normalizeAssetRowCurrency(row.currency, currency)
        filas.push({
            origen: "spot",
            fecha: row.fechaOperacion || "",
            tipo: row.tipoOperacion || "Compra",
            participaciones: formatAssetParticipationValue(row.participaciones, assetType),
            precio: formatCellMoneyValue(
                row.precioParticipacion,
                getAssetTableMoneyCurrency(assetType, "precioParticipacion", currency, rowCurrency)
            ),
            importe: formatCellMoneyValue(
                row.capitalInvertidoBruto,
                getAssetTableMoneyCurrency(assetType, "capitalInvertidoBruto", currency, rowCurrency)
            ),
            comisiones: formatCellMoneyValue(
                getCryptoRowCommissionFiat(row),
                getAssetTableMoneyCurrency(assetType, "comisionesFiat", currency, rowCurrency)
            )
        })
    })

    const completadas = getCompletedOperationsCryptoImpact(asset)
    ;(completadas.rows || []).forEach((row) => {
        filas.push({
            origen: "operacion",
            fecha: row.fechaApertura || "",
            tipo: row.orden || "",
            participaciones: formatOperationsQuantity(row.cantidad),
            precio: formatOperationsMoney(row.precioOrden, row.precioCurrency || currency),
            importe: formatOperationsMoney(row.total, row.currency || currency),
            comisiones: formatOperationsMoney(row.comisionesFiat, "EUR")
        })
    })

    // Más reciente arriba. Las filas sin fecha legible se van al final en vez de
    // colarse en el año 1970.
    return filas.sort((a, b) => {
        const fechaA = parseAssetOperationDate(a.fecha)
        const fechaB = parseAssetOperationDate(b.fecha)
        if (!Number.isFinite(fechaA)) return Number.isFinite(fechaB) ? 1 : 0
        if (!Number.isFinite(fechaB)) return -1
        return fechaB - fechaA
    })
}

function renderAssetTodosSection(asset) {
    const section = document.getElementById("assetTodosSection")
    const tabBtn = document.getElementById("todosTabBtn")

    if (!section) return

    const filas = buildAssetTodosRows(asset)

    if (tabBtn) {
        tabBtn.classList.remove("hidden")
        tabBtn.textContent = filas.length ? `Todos (${filas.length})` : "Todos"
    }

    if (!filas.length) {
        // Sin filas no hay nada que repartir, y los quesitos del activo
        // anterior se quedarían colgando de unos canvas que ya no existen.
        destroyAssetTodosCharts()
        const columnaVacia = document.getElementById("assetTodosChartsCol")
        if (columnaVacia) columnaVacia.innerHTML = ""
        section.innerHTML = `
            <div class="assetVentasEmpty">
                <p class="assetVentasEmptyText">Este activo todavía no tiene compras ni operaciones.</p>
            </div>
        `
        return
    }

    const rowsHtml = filas
        .map((fila) => {
            const origen = ASSET_TODOS_ORIGENES[fila.origen] || { etiqueta: fila.origen, clase: "" }
            const tipo = String(fila.tipo || "").trim()
            const tipoClass = tipo.toLowerCase() === "venta" ? "opRowVenta" : "opRowCompra"
            return `
            <tr>
                <td class="todosColOrigen"><span class="todosOrigenBadge ${origen.clase}">${escapeHtml(origen.etiqueta)}</span></td>
                <td class="todosColFecha">${escapeHtml(fila.fecha || "")}</td>
                <td class="todosColTipo ${tipoClass}">${escapeHtml(tipo)}</td>
                <td class="todosColNum todosColParticipaciones">${fila.participaciones || ""}</td>
                <td class="todosColNum todosColPrecio">${fila.precio || ""}</td>
                <td class="todosColNum todosColImporte">${fila.importe || ""}</td>
                <td class="todosColNum todosColComisiones">${fila.comisiones || ""}</td>
            </tr>
        `
        })
        .join("")

    section.innerHTML = `
        <div class="assetTableWrapper">
            <table class="assetOperationsTable assetTodosTable">
                <thead>
                    <tr>
                        <th class="mThSort todosColOrigen" data-sortkey="0">Origen<span class="mSortArrow"></span></th>
                        <th class="mThSort todosColFecha" data-sortkey="1">Fecha<span class="mSortArrow"></span></th>
                        <th class="mThSort todosColTipo" data-sortkey="2">Tipo<span class="mSortArrow"></span></th>
                        <th class="mThSort todosColNum todosColParticipaciones" data-sortkey="3">Participaciones<span class="mSortArrow"></span></th>
                        <th class="mThSort todosColNum todosColPrecio" data-sortkey="4">Precio<span class="mSortArrow"></span></th>
                        <th class="mThSort todosColNum todosColImporte" data-sortkey="5">Importe<span class="mSortArrow"></span></th>
                        <th class="mThSort todosColNum todosColComisiones" data-sortkey="6">Comisiones<span class="mSortArrow"></span></th>
                    </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        </div>
    `
    bindTableSort(section.querySelector("table"), "assetTodos")
    applyAssetTodosGrid()
    renderAssetTodosChartsColumn(asset)
}

// Los quesitos viven fuera del recuadro de la tabla, en su propia columna al
// lado: dentro alargaban el panel muy por debajo de la última fila. Siguen
// siendo cosa de "Todos", así que la columna se esconde al cambiar de pestaña.
function renderAssetTodosChartsColumn(asset) {
    const columna = document.getElementById("assetTodosChartsCol")
    if (!columna) return

    columna.innerHTML = `
        ${buildAssetTodosChartCard("todosChartOrigen", "Participaciones por origen", "De dónde sale lo que hay ahora en cartera.")}
        ${buildAssetTodosChartCard("todosChartVentas", "Ventas y ganancias realizadas", "En qué se reparte el dinero de lo ya vendido.")}
        ${buildAssetTodosChartCard("todosChartAnios", "Capital invertido por año", "Cuánto entró en el activo cada año.")}
    `

    // El oyente va en la columna y no en cada botón: el HTML de dentro se rehace
    // entero en cada repintado y así no hay que volver a engancharlos.
    if (!columna.dataset.plegadoListo) {
        columna.addEventListener("click", (evento) => {
            const boton = evento.target.closest("[data-chart-toggle]")
            if (boton) toggleAssetTodosChartCard(boton.dataset.chartToggle)
        })
        columna.dataset.plegadoListo = "1"
    }

    renderAssetTodosCharts(asset)
}

// Rejilla de ajuste de la pestaña "Todos". Dibuja en blanco el borde de cada
// celda para ver dónde empieza y acaba cada columna mientras se cuadran anchos
// y alineaciones; una vez encajadas se apaga y la tabla queda limpia. Se maneja
// desde la consola: todosGrid() la enciende o apaga y todosGrid(false) la apaga
// siempre. La preferencia se guarda para que aguante los repintados y recargas.
const ASSET_TODOS_GRID_KEY = "assetTodosGrid"

function isAssetTodosGridOn() {
    try {
        return localStorage.getItem(ASSET_TODOS_GRID_KEY) === "1"
    } catch {
        return false
    }
}

function applyAssetTodosGrid() {
    document.body.classList.toggle("todosGridDebug", isAssetTodosGridOn())
}

function toggleAssetTodosGrid(on) {
    const activa = on === undefined ? !isAssetTodosGridOn() : Boolean(on)
    try {
        localStorage.setItem(ASSET_TODOS_GRID_KEY, activa ? "1" : "0")
    } catch {
        // Sin localStorage la rejilla vale igual, solo que no sobrevive a una recarga.
    }
    document.body.classList.toggle("todosGridDebug", activa)
    return activa
}

window.todosGrid = toggleAssetTodosGrid

// ── Gráficos de la pestaña "Todos" ──
// Tres quesitos al lado de la tabla. Cada uno contesta algo que la tabla tiene
// pero no enseña de un vistazo: de dónde salen las participaciones, en qué se
// reparte el dinero de lo ya vendido y cuánto entró en el activo cada año. Los
// tres son repartos de un total, que es para lo único que sirve un gráfico
// circular; cuando no hay nada que repartir la tarjeta lo dice con una frase en
// vez de dibujar un círculo vacío.
//
// Los colores están comprobados contra el fondo oscuro para que se distingan
// también con daltonismo: verde, azul y naranja para los repartos por concepto,
// y una rampa de azules para los años, que son una escala y no categorías
// sueltas (un arcoíris por año no diría nada del orden).
const ASSET_TODOS_CHART_COLORS = { verde: "#2e9e6b", azul: "#3a7bd5", naranja: "#d95926" }
const ASSET_TODOS_YEAR_RAMP = [
    [29, 79, 143],
    [142, 192, 234]
]

let _assetTodosCharts = {}
let _assetTodosChartsToken = 0

// Cada tarjeta se puede plegar por su título y se queda plegada: la columna es
// alta y no siempre interesan los tres quesitos a la vez. Lo plegado se guarda
// para que aguante los repintados y el cambio de activo, que rehacen el HTML de
// la columna entera.
const ASSET_TODOS_CHARTS_COLLAPSED_KEY = "assetTodosChartsPlegados"

function getAssetTodosCollapsedCharts() {
    try {
        const guardado = JSON.parse(localStorage.getItem(ASSET_TODOS_CHARTS_COLLAPSED_KEY) || "[]")
        return new Set(Array.isArray(guardado) ? guardado.map(String) : [])
    } catch {
        return new Set()
    }
}

function setAssetTodosChartCollapsed(id, plegada) {
    const plegadas = getAssetTodosCollapsedCharts()

    if (plegada) {
        plegadas.add(id)
    } else {
        plegadas.delete(id)
    }

    try {
        localStorage.setItem(ASSET_TODOS_CHARTS_COLLAPSED_KEY, JSON.stringify([...plegadas]))
    } catch {
        // Sin localStorage se pliega igual, solo que no dura hasta la próxima visita.
    }
}

function buildAssetTodosChartCard(id, titulo, pie) {
    const plegada = getAssetTodosCollapsedCharts().has(id)

    return `
        <article class="todosChartCard${plegada ? " todosChartCardPlegada" : ""}" data-chart="${id}">
            <h4 class="todosChartHeading">
                <button type="button" class="todosChartToggle" data-chart-toggle="${id}" aria-expanded="${plegada ? "false" : "true"}" aria-controls="${id}Body">
                    <span class="todosChartTitle">${escapeHtml(titulo)}</span>
                    <span class="todosChartChevron" aria-hidden="true">▾</span>
                </button>
            </h4>
            <div class="todosChartBody" id="${id}Body">
                <div class="todosChartBox" id="${id}Box"><canvas id="${id}"></canvas></div>
                <p class="todosChartFoot" id="${id}Foot">${escapeHtml(pie)}</p>
            </div>
        </article>
    `
}

// Un quesito dibujado dentro de una tarjeta plegada nace con el lienzo a cero,
// así que al desplegar hay que decirle que vuelva a medirse.
function toggleAssetTodosChartCard(id) {
    const tarjeta = document.querySelector(`.todosChartCard[data-chart="${id}"]`)
    const boton = tarjeta?.querySelector(".todosChartToggle")
    if (!tarjeta) return

    const plegada = tarjeta.classList.toggle("todosChartCardPlegada")
    if (boton) boton.setAttribute("aria-expanded", plegada ? "false" : "true")
    setAssetTodosChartCollapsed(id, plegada)

    if (!plegada) _assetTodosCharts[id]?.resize()
}

function destroyAssetTodosCharts() {
    Object.values(_assetTodosCharts).forEach((chart) => chart.destroy())
    _assetTodosCharts = {}
}

function setAssetTodosChartFoot(id, texto) {
    const pie = document.getElementById(`${id}Foot`)
    if (pie) pie.textContent = texto
}

function setAssetTodosChartEmpty(id, mensaje) {
    const caja = document.getElementById(`${id}Box`)
    if (caja) caja.innerHTML = `<p class="todosChartEmpty">${escapeHtml(mensaje)}</p>`
}

// Solo entran las porciones con valor positivo: un quesito no sabe dibujar un
// saldo negativo, y una porción a cero deja en la leyenda una etiqueta que no
// se corresponde con nada. Devuelve el total repartido, o 0 si no había nada
// que dibujar.
function createAssetTodosDonut(id, partes, formatValue) {
    const caja = document.getElementById(`${id}Box`)
    const canvas = document.getElementById(id)

    if (!caja || !canvas || typeof Chart === "undefined") return 0

    const datos = partes.filter((parte) => Number.isFinite(parte.valor) && parte.valor > 0)
    const total = datos.reduce((suma, parte) => suma + parte.valor, 0)

    if (!datos.length || total <= 0) return 0

    // El borde de las porciones va del color de fondo de la tarjeta para que
    // quede un hueco real entre ellas; se lee del tema en curso, que la app
    // tiene claro y oscuro.
    const estilos = getComputedStyle(caja)

    _assetTodosCharts[id] = new Chart(canvas, {
        type: "doughnut",
        data: {
            labels: datos.map((parte) => parte.etiqueta),
            datasets: [
                {
                    data: datos.map((parte) => parte.valor),
                    backgroundColor: datos.map((parte) => parte.color),
                    borderColor: estilos.backgroundColor,
                    borderWidth: 2,
                    hoverOffset: 8
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 400 },
            cutout: "62%",
            layout: { padding: 2 },
            plugins: {
                legend: {
                    position: "bottom",
                    labels: {
                        color: estilos.color,
                        font: { size: 11 },
                        padding: 10,
                        boxWidth: 10,
                        usePointStyle: true,
                        pointStyle: "circle"
                    }
                },
                tooltip: {
                    callbacks: {
                        label: (contexto) => {
                            const porcentaje = ((contexto.raw / total) * 100).toFixed(1).replace(".", ",")
                            return ` ${formatValue(contexto.raw)}  (${porcentaje} %)`
                        }
                    }
                }
            }
        }
    })

    return total
}

function buildAssetTodosOrigenPartes(asset) {
    const spot = getPrimaryAssetRows(asset).reduce((total, row) => {
        const cantidad = parseLooseNumber(row.participaciones) || 0
        const esVenta =
            String(row.tipoOperacion || "")
                .trim()
                .toLowerCase() === "venta"
        return total + (esVenta ? -cantidad : cantidad)
    }, 0)

    return [
        { etiqueta: "Compras spot", valor: spot, color: ASSET_TODOS_CHART_COLORS.verde },
        {
            etiqueta: "Operaciones spot",
            valor: getCompletedOperationsCryptoImpact(asset).quantityDelta || 0,
            color: ASSET_TODOS_CHART_COLORS.azul
        },
        {
            etiqueta: "Transacciones",
            valor: getTransaccionesCryptoImpact(asset).quantityDelta || 0,
            color: ASSET_TODOS_CHART_COLORS.naranja
        }
    ]
}

// Lo vendido se reparte en tres: lo que costó comprarlo, lo que se lleva
// Hacienda y lo que queda limpio. Si el conjunto de ventas sale en pérdidas ese
// reparto no existe —no hay ganancia que trocear—, así que se enseña el otro:
// cuánto del dinero puesto se recuperó y cuánto se quedó por el camino.
function buildAssetTodosVentasPartes(asset) {
    const rows = getAssetVentasRows(asset)
    const suma = (campo) => rows.reduce((total, row) => total + (parseLooseNumber(row[campo]) || 0), 0)
    const coste = suma("costeAdquisicion")
    const ganancia = suma("dineroDeclarar")
    const impuestos = suma("totalPagar")
    const vendido = suma("bruto")
    const cuenta = `${rows.length} venta${rows.length === 1 ? "" : "s"}`

    if (ganancia < 0) {
        return {
            partes: [
                { etiqueta: "Recuperado", valor: vendido, color: ASSET_TODOS_CHART_COLORS.azul },
                { etiqueta: "Pérdida", valor: -ganancia, color: ASSET_TODOS_CHART_COLORS.naranja }
            ],
            pie: `${cuenta} · ${formatMoney(vendido, "EUR")} recuperados de ${formatMoney(coste, "EUR")}`
        }
    }

    return {
        partes: [
            { etiqueta: "Coste de compra", valor: coste, color: ASSET_TODOS_CHART_COLORS.azul },
            { etiqueta: "Ganancia neta", valor: ganancia - impuestos, color: ASSET_TODOS_CHART_COLORS.verde },
            { etiqueta: "Impuestos", valor: impuestos, color: ASSET_TODOS_CHART_COLORS.naranja }
        ],
        pie: `${cuenta} · ${formatMoney(vendido, "EUR")} vendidos`
    }
}

function assetTodosYearOf(fecha) {
    const marca = parseAssetOperationDate(fecha)
    return Number.isFinite(marca) ? String(new Date(marca).getFullYear()) : ""
}

// Del azul oscuro al claro, del año más antiguo al más reciente: la rampa se
// lee como una línea de tiempo aunque las porciones estén en círculo.
function assetTodosYearColor(indice, total) {
    if (total <= 1) return ASSET_TODOS_CHART_COLORS.azul

    const paso = indice / (total - 1)
    const [desde, hasta] = ASSET_TODOS_YEAR_RAMP
    const canales = desde.map((valor, i) => Math.round(valor + (hasta[i] - valor) * paso))
    return `rgb(${canales.join(", ")})`
}

// Las compras pueden estar anotadas en otra moneda que el activo, así que cada
// importe pasa por el cambio antes de sumarse: mezclar euros con dólares en el
// mismo quesito daría un reparto inventado.
async function buildAssetTodosAniosPartes(asset) {
    const assetCurrency = normalizeCurrencyCode(asset?.currency || "EUR")
    const compras = []

    getPrimaryAssetRows(asset).forEach((row) => {
        const esVenta =
            String(row.tipoOperacion || "")
                .trim()
                .toLowerCase() === "venta"
        if (esVenta) return

        compras.push({
            anio: assetTodosYearOf(row.fechaOperacion),
            importe: parseLooseNumber(row.capitalInvertidoBruto) || 0,
            currency: normalizeAssetRowCurrency(row.currency, assetCurrency)
        })
    })

    getCompletedOperationsCryptoImpact(asset).rows.forEach((row) => {
        const esCompra =
            String(row.orden || "")
                .trim()
                .toLowerCase() === "compra"
        if (!esCompra) return

        compras.push({
            anio: assetTodosYearOf(row.fechaApertura || row.fecha),
            importe: parseLooseNumber(row.total) || 0,
            currency: normalizeCurrencyCode(row.currency || assetCurrency)
        })
    })

    const convertidas = await Promise.all(
        compras
            .filter((compra) => compra.anio && compra.importe > 0)
            .map(async (compra) => ({
                anio: compra.anio,
                importe: await convertAmountForDisplay(compra.importe, compra.currency, assetCurrency)
            }))
    )

    const porAnio = new Map()
    convertidas.forEach((compra) => {
        porAnio.set(compra.anio, (porAnio.get(compra.anio) || 0) + compra.importe)
    })

    const anios = [...porAnio.keys()].sort()
    return anios.map((anio, indice) => ({
        etiqueta: anio,
        valor: porAnio.get(anio),
        color: assetTodosYearColor(indice, anios.length)
    }))
}

async function renderAssetTodosCharts(asset) {
    destroyAssetTodosCharts()

    const token = ++_assetTodosChartsToken
    const assetType = asset?.type || "cripto"
    const assetCurrency = normalizeCurrencyCode(asset?.currency || "EUR")

    const totalOrigen = createAssetTodosDonut("todosChartOrigen", buildAssetTodosOrigenPartes(asset), (valor) =>
        formatAssetParticipationValue(valor, assetType)
    )
    if (totalOrigen > 0) {
        setAssetTodosChartFoot("todosChartOrigen", `Total: ${formatAssetParticipationValue(totalOrigen, assetType)}`)
    } else {
        setAssetTodosChartEmpty("todosChartOrigen", "Todavía no hay participaciones que repartir.")
        setAssetTodosChartFoot("todosChartOrigen", "")
    }

    const ventas = buildAssetTodosVentasPartes(asset)
    if (createAssetTodosDonut("todosChartVentas", ventas.partes, (valor) => formatMoney(valor, "EUR")) > 0) {
        setAssetTodosChartFoot("todosChartVentas", ventas.pie)
    } else {
        setAssetTodosChartEmpty("todosChartVentas", "No hay ventas registradas de este activo.")
        setAssetTodosChartFoot("todosChartVentas", "")
    }

    let anios = []
    try {
        anios = await buildAssetTodosAniosPartes(asset)
    } catch (error) {
        console.error("No se pudo repartir el capital invertido por año", error)
    }

    // Entre la espera del cambio de divisa y ahora la ficha puede haberse
    // repintado —otro activo, o el mismo recargado—; si el turno ya no es el
    // nuestro, los canvas que hay ahí abajo son de otro dibujo.
    if (token !== _assetTodosChartsToken) return

    const totalAnios = createAssetTodosDonut("todosChartAnios", anios, (valor) => formatMoney(valor, assetCurrency))
    if (totalAnios > 0) {
        setAssetTodosChartFoot("todosChartAnios", `Total: ${formatMoney(totalAnios, assetCurrency)}`)
    } else {
        setAssetTodosChartEmpty("todosChartAnios", "Sin compras con fecha para repartir por año.")
        setAssetTodosChartFoot("todosChartAnios", "")
    }
}

function renderAssetVentasSection(asset) {
    const section = document.getElementById("assetVentasSection")
    const tabBtn = document.getElementById("ventasTabBtn")

    if (!section) return

    const rows = getAssetVentasRows(asset)

    if (tabBtn) {
        tabBtn.classList.remove("hidden")
        tabBtn.textContent = rows.length ? `Ventas (${rows.length})` : "Ventas"
    }

    if (!rows.length) {
        // Sin botón propio: la acción es la de la barra de pestañas, para no
        // tener dos "Añadir venta" a la vez.
        section.innerHTML = `
            <div class="assetVentasEmpty">
                <p class="assetVentasEmptyText">No hay ventas registradas para este activo.</p>
            </div>
        `
        return
    }

    const rowsHtml = rows
        .map((row) => {
            const cantidad = row.cantidad ? parseLooseNumber(row.cantidad) : null
            const cantidadFmt =
                cantidad !== null
                    ? cantidad.toLocaleString("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: 8 })
                    : ""
            return `
            <tr>
                <td>${escapeHtml(row.fecha || "")}</td>
                <td>${escapeHtml(cantidadFmt)}</td>
                <td class="rowTotal">${row.valorCompra ? formatMoney(parseLooseNumber(row.valorCompra), "EUR") : ""}</td>
                <td>${row.valorVenta ? formatMoney(parseLooseNumber(row.valorVenta), "EUR") : ""}</td>
                <td class="rowTotal">${row.bruto ? formatMoney(parseLooseNumber(row.bruto), "EUR") : ""}</td>
                <td class="rowTotal">${row.dineroDeclarar ? formatMoney(parseLooseNumber(row.dineroDeclarar), "EUR") : ""}</td>
                <td class="rowTotal">${row.totalPagar ? formatMoney(parseLooseNumber(row.totalPagar), "EUR") : ""}</td>
                <td class="rowTotal">${row.neto ? formatMoney(parseLooseNumber(row.neto), "EUR") : ""}</td>
            </tr>
        `
        })
        .join("")

    section.innerHTML = `
        <div class="assetTableWrapper">
            <table class="assetOperationsTable assetVentasTable">
                <thead>
                    <tr>
                        <th class="mThSort" data-sortkey="0">Fecha<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="1">Cantidad<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="2">Precio compra (FIFO)<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="3">Valor venta<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="4">Bruto<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="5">A declarar<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="6">Impuestos<span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="7">Neto<span class="mSortArrow"></span></th>
                    </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
            </table>
        </div>
    `
    bindTableSort(section.querySelector("table"), "assetVentas")
}

function openAssetAddVentaModal(asset) {
    document.getElementById("assetAddVentaModalOverlay")?.remove()

    const assetName = asset.name || asset.id || ""
    const today = new Date()
    const dd = String(today.getDate()).padStart(2, "0")
    const mm = String(today.getMonth() + 1).padStart(2, "0")
    const yyyy = today.getFullYear()
    const todayStr = `${dd}-${mm}-${yyyy}`

    const overlay = document.createElement("div")
    overlay.id = "assetAddVentaModalOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"

    const modal = document.createElement("div")
    modal.className = "assetModal assetRowModal"

    const title = document.createElement("h3")
    title.className = "assetModalTitle assetRowModalTitle"
    title.textContent = `Añadir venta · ${assetName}`

    const fields = document.createElement("div")
    fields.className = "assetRowModalFields"
    fields.innerHTML = `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Fecha</label>
            <input id="avModalFecha" class="assetRowModalInput" type="text" value="${todayStr}" placeholder="dd-mm-aaaa">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Cantidad</label>
            <input id="avModalCantidad" class="assetRowModalInput" type="text" inputmode="decimal" placeholder="0">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Valor de venta (€)</label>
            <input id="avModalValorVenta" class="assetRowModalInput" type="text" inputmode="decimal" placeholder="0.00">
        </div>
        <div id="avModalFeedback" class="assetRowModalFeedback" style="display:none"></div>
    `

    const footer = document.createElement("div")
    footer.className = "assetRowModalFooter"
    footer.innerHTML = `
        <button type="button" id="assetAddVentaCancelBtn" class="cancelButton assetRowModalCancelBtn">Cancelar</button>
        <button type="button" id="assetAddVentaSaveBtn" class="primaryButton assetRowModalSaveBtn">Guardar venta</button>
    `

    modal.appendChild(title)
    modal.appendChild(fields)
    modal.appendChild(footer)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    const close = () => overlay.remove()
    footer.querySelector("#assetAddVentaCancelBtn").addEventListener("click", close)

    const saveBtn = footer.querySelector("#assetAddVentaSaveBtn")
    const fechaInput = fields.querySelector("#avModalFecha")
    const cantidadInput = fields.querySelector("#avModalCantidad")
    const valorVentaInput = fields.querySelector("#avModalValorVenta")
    const feedback = fields.querySelector("#avModalFeedback")

    saveBtn.addEventListener("click", async () => {
        const fecha = fechaInput.value.trim()
        const cantidad = cantidadInput.value.trim()
        const valorVenta = valorVentaInput.value.trim()

        if (!fecha || !cantidad || !valorVenta) {
            feedback.textContent = "Fecha, cantidad y valor de venta son obligatorios."
            feedback.style.display = "block"
            return
        }

        saveBtn.disabled = true
        saveBtn.textContent = "Guardando..."

        try {
            await saveNewVentaFromAsset(asset, fecha, cantidad, valorVenta)
            close()
            await loadVentasRowsForAssets()
            renderAssetVentasSection(asset)
            if (document.querySelector('.assetTabPanel[data-tab="ventas"]')) {
                setActiveAssetTab("ventas")
            }
        } catch (err) {
            feedback.textContent = `Error al guardar: ${err.message}`
            feedback.style.display = "block"
            saveBtn.disabled = false
            saveBtn.textContent = "Guardar venta"
        }
    })

    fechaInput.focus()
}

async function saveNewVentaFromAsset(asset, fecha, cantidad, valorVenta) {
    const yearMatch = fecha.match(/(\d{4})$/)
    const year = yearMatch ? yearMatch[1] : String(new Date().getFullYear())

    let yearData = null
    const yearRes = await fetch(`/api/ventas/${year}`)
    if (yearRes.ok) {
        yearData = await yearRes.json()
    } else {
        const createRes = await fetch("/api/ventas", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ year })
        })
        if (!createRes.ok) throw new Error("No se pudo crear el año de ventas")
        yearData = (await createRes.json()).data || { year, rows: [] }
    }

    const existingRows = Array.isArray(yearData?.rows) ? yearData.rows : []
    const newRow = {
        id: `venta-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        fecha,
        assetId: String(asset.id || ""),
        activo: String(asset.name || asset.id || ""),
        cantidad: String(cantidad),
        valorVenta: String(valorVenta),
        valorCompra: "",
        dineroDeclarar: "",
        bruto: "",
        neto: "",
        totalPagar: ""
    }

    const saveRes = await fetch(`/api/ventas/${year}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year, rows: [...existingRows, newRow] })
    })

    if (!saveRes.ok) {
        const text = await saveRes.text()
        throw new Error(`HTTP ${saveRes.status}: ${text}`)
    }
}

// Un activo desaparece del sidebar por dos vías distintas: la lista de ocultos
// de Ajustes (preferencia del portfolio, por id) o el flag `hidden` del propio
// activo, que se marca con "Ocultar" en la página de Activos. Las dos tienen
// que afectar igual a la lista y a la ficha de detalle de abajo, así que la
// decisión vive en un único sitio.
