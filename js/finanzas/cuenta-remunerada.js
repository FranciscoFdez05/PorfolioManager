// ===== MI DINERO › CUENTA REMUNERADA =====
// Vista de lo que entra en cada cuenta remunerada sin ser una aportación del
// usuario: los intereses que paga la cuenta y los dividendos que se cobran en
// ella. Gráfico acumulado del año a la izquierda y tabla de movimientos a la
// derecha. Es de solo lectura: los intereses se apuntan en Bolsa e Inversión ›
// Cuenta Remunerada (intereses.js) y los dividendos en su ventana. Las
// funciones de cálculo son puras para poder probarlas sin DOM ni Chart.js.

const crDiaMs = 86400000
const crColorLinea = "#3a7bd5"
const crColorArea = "rgba(58, 123, 213, 0.12)"

let crGraficoInstancia = null

/**
 * Convierte una fecha de la app a milisegundos (medianoche local).
 *
 * Intereses y dividendos se apuntan a mano, así que conviven varios formatos:
 * "dd-mm-aaaa", "aaaa-mm-dd" y, en filas antiguas, "mm-aaaa" (se toma el día 1).
 * Vale cualquier separador entre "-", "/" y ".".
 *
 * Args:
 *     fecha: texto de la fecha.
 *
 * Returns:
 *     El instante en ms, o null si la fecha no se puede leer o no existe
 *     (31-02-2026 no pasa a 03-03-2026).
 */
function crFechaATiempo(fecha) {
    const partes = String(fecha || "")
        .trim()
        .split(/[-/.]/)
    if (partes.length < 2 || partes.length > 3 || partes.some((p) => !/^\d+$/.test(p))) return null

    let dia, mes, anio
    if (partes.length === 2) {
        ;[mes, anio] = partes.map(Number)
        dia = 1
    } else if (partes[0].length === 4) {
        ;[anio, mes, dia] = partes.map(Number)
    } else {
        ;[dia, mes, anio] = partes.map(Number)
    }

    const fechaJs = new Date(anio, mes - 1, dia)
    const valida = fechaJs.getFullYear() === anio && fechaJs.getMonth() === mes - 1 && fechaJs.getDate() === dia
    return valida && anio >= 1000 ? fechaJs.getTime() : null
}

/**
 * Cuenta de «Cuentas» a la que va un dividendo.
 *
 * Misma regla que la ventana de Dividendos: la que trae apuntada si sigue
 * existiendo y, si no, la primera cuenta marcada como cobradora de dividendos.
 *
 * Args:
 *     row: fila de /api/dividendos.
 *     cuentasApp: cuentas de /api/cuentas ({ id, dividendos }).
 *
 * Returns:
 *     El id de la cuenta, o "" si no hay ninguna.
 */
function crCuentaDeDividendo(row, cuentasApp) {
    if (row?.cuenta && cuentasApp.some((c) => c.id === row.cuenta)) return row.cuenta
    return cuentasApp.find((c) => c.dividendos)?.id || ""
}

/**
 * Lista de lo que suma a una cuenta remunerada: intereses netos y dividendos.
 *
 * Args:
 *     opciones.interesRows: filas de intereses de la cuenta remunerada
 *         ({ fecha, acumulado, impuestos }); `acumulado` es el bruto.
 *     opciones.dividendoRows: todas las filas de /api/dividendos.
 *     opciones.cuentaId: id en «Cuentas» de la cuenta remunerada, o "" si es
 *         de las antiguas sin cuenta (entonces no recibe dividendos).
 *     opciones.cuentasApp: cuentas de /api/cuentas.
 *     opciones.tasas: Map moneda -> tasa a euros; una moneda que falta cuenta
 *         como 1 para no perder el movimiento.
 *
 * Returns:
 *     Movimientos { t, fecha, anio, tipo, concepto, importe, indice } con fecha
 *     legible, ordenados de más antiguo a más reciente. `indice` es la posición
 *     de la fila de intereses (para editarla) o null en los dividendos.
 *
 * Example:
 *     construirMovimientosCuenta({ interesRows: [{ fecha: "01-11-2026", acumulado: "5,60 €" }],
 *         dividendoRows: [], cuentaId: "tr", cuentasApp: [], tasas: new Map() })
 *     // [{ tipo: "interes", concepto: "Cuenta remunerada", importe: 5.6, ... }]
 */
function construirMovimientosCuenta({ interesRows, dividendoRows, cuentaId, cuentasApp, tasas }) {
    const movimientos = []

    ;(interesRows || []).forEach((row, indice) => {
        const t = crFechaATiempo(row.fecha)
        if (t === null) return
        movimientos.push({
            t,
            fecha: row.fecha,
            tipo: "interes",
            concepto: "Cuenta remunerada",
            importe: parseEuroNumber(row.acumulado) - parseEuroNumber(row.impuestos),
            indice
        })
    })

    if (cuentaId) {
        ;(dividendoRows || []).forEach((row) => {
            if (crCuentaDeDividendo(row, cuentasApp || []) !== cuentaId) return
            const t = crFechaATiempo(row.fecha)
            if (t === null) return
            const moneda = String(row.monedaTotal || "EUR").toUpperCase()
            const tasa = tasas?.get(moneda) ?? 1
            const instrumento = String(row.instrumento || "").trim()
            movimientos.push({
                t,
                fecha: row.fecha,
                tipo: "dividendo",
                concepto: instrumento ? `Dividendo: ${instrumento}` : "Dividendo",
                importe: (parseLooseNumber(row.total || "") ?? 0) * tasa,
                indice: null
            })
        })
    }

    movimientos.forEach((m) => {
        m.anio = String(new Date(m.t).getFullYear())
    })
    return movimientos.sort((a, b) => a.t - b.t)
}

/**
 * Años con movimientos, de más antiguo a más reciente.
 *
 * Args:
 *     movimientos: salida de construirMovimientosCuenta().
 *
 * Returns:
 *     Los años como texto ("2025").
 */
function crAniosDeMovimientos(movimientos) {
    return [...new Set(movimientos.map((m) => m.anio))].sort((a, b) => Number(a) - Number(b))
}

/**
 * Serie acumulada de un año para el gráfico.
 *
 * Empieza en 0 el 1 de enero y sube en cada día con movimientos (los del mismo
 * día van en un solo punto). Acaba el 31 de diciembre o, en el año en curso,
 * hoy: alargar la línea hasta diciembre daría a entender que ya se sabe lo que
 * queda por cobrar.
 *
 * Args:
 *     movimientos: movimientos de la cuenta (de cualquier año, ordenados).
 *     anio: año que se pinta.
 *     hoy: fecha de referencia para el año en curso.
 *
 * Returns:
 *     Puntos { t, y, movimientos } en orden; vacío si el año no tiene nada.
 */
function acumularMovimientosAnio(movimientos, anio, hoy = new Date()) {
    const delAnio = movimientos.filter((m) => m.anio === String(anio))
    if (!delAnio.length) return []

    const year = Number(anio)
    const inicio = new Date(year, 0, 1).getTime()
    const finAnio = new Date(year, 11, 31).getTime()
    const hoyDia = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()).getTime()
    const ultimo = delAnio[delAnio.length - 1].t
    const fin = Math.max(ultimo, Math.min(finAnio, hoyDia))

    const puntos = [{ t: inicio, y: 0, movimientos: [] }]
    let acumulado = 0
    delAnio.forEach((m) => {
        acumulado += m.importe
        const previo = puntos[puntos.length - 1]
        // El punto de partida no se fusiona aunque haya un cobro el 1 de enero:
        // la línea tiene que salir de 0 y subir ese mismo día.
        if (previo.t === m.t && previo.movimientos.length) {
            previo.y = acumulado
            previo.movimientos.push(m)
        } else {
            puntos.push({ t: m.t, y: acumulado, movimientos: [m] })
        }
    })
    if (fin > puntos[puntos.length - 1].t) puntos.push({ t: fin, y: acumulado, movimientos: [] })
    return puntos
}

// ----- Pintado -----

function crFechaCorta(t) {
    return new Date(t).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" })
}

/**
 * Importe con signo explícito, como se ve en la tabla: "+5,60 €".
 *
 * Args:
 *     importe: cantidad en euros (un dividendo corregido puede ser negativo).
 *
 * Returns:
 *     El importe formateado con "+" delante si no es negativo.
 */
function crImporteConSigno(importe) {
    return `${importe < 0 ? "" : "+"}${formatEuro(importe)}`
}

function crMarcasMeses(anio) {
    return Array.from({ length: 12 }, (_, mes) => new Date(Number(anio), mes, 1).getTime())
}

/**
 * Pinta (o repinta) el gráfico acumulado en el canvas.
 *
 * Args:
 *     canvas: el <canvas> de la página; si falta o no hay Chart.js no hace nada.
 *     puntos: salida de acumularMovimientosAnio().
 *     anio: año pintado, para fijar el eje de enero a diciembre.
 */
function crPintarGrafico(canvas, puntos, anio) {
    if (crGraficoInstancia) {
        crGraficoInstancia.destroy()
        crGraficoInstancia = null
    }
    if (!canvas || typeof Chart === "undefined" || !puntos.length) return

    const estilos = getComputedStyle(canvas)
    const colorTexto = estilos.getPropertyValue("--text-muted").trim() || "#888"
    const colorRejilla = estilos.getPropertyValue("--border-soft").trim() || "rgba(128,128,128,0.2)"
    const year = Number(anio)
    const marcas = crMarcasMeses(year)

    crGraficoInstancia = new Chart(canvas, {
        type: "line",
        data: {
            datasets: [
                {
                    data: puntos.map((p) => ({ x: p.t, y: p.y })),
                    borderColor: crColorLinea,
                    backgroundColor: crColorArea,
                    borderWidth: 2,
                    fill: true,
                    // Tramos rectos: una curva suavizada se pasa de largo en los
                    // cobros grandes y dibuja bajadas que no han existido.
                    tension: 0,
                    pointRadius: puntos.map((p) => (p.movimientos.length ? 2.5 : 0)),
                    pointBackgroundColor: crColorLinea,
                    pointHoverRadius: 5,
                    pointHitRadius: 10
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { mode: "nearest", axis: "x", intersect: false },
            scales: {
                x: {
                    type: "linear",
                    min: new Date(year, 0, 1).getTime(),
                    max: new Date(year, 11, 31).getTime() + crDiaMs,
                    grid: { color: colorRejilla },
                    afterBuildTicks: (eje) => {
                        eje.ticks = marcas.map((value) => ({ value }))
                    },
                    ticks: {
                        color: colorTexto,
                        autoSkip: false,
                        maxRotation: 0,
                        callback: (valor) =>
                            new Date(valor).toLocaleDateString("es-ES", { month: "short" }).replace(".", "")
                    }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: colorRejilla },
                    ticks: { color: colorTexto, callback: (valor) => formatEuro(valor) }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: (items) => crFechaCorta(items[0].parsed.x),
                        label: (item) => ` Acumulado: ${formatEuro(item.parsed.y)}`,
                        afterLabel: (item) =>
                            (puntos[item.dataIndex]?.movimientos || []).map(
                                (m) => ` ${m.concepto}: ${crImporteConSigno(m.importe)}`
                            )
                    }
                }
            }
        }
    })
}

// ----- Página -----

// Cuentas remuneradas de /api/intereses ({ id, nombre, cuenta, rows }), la
// elegida y el año que se ve. Se conservan al volver a la página.
let crCuentas = []
let crCuentaId = null
let crAnio = null
// Lo que hace falta para sumar los dividendos: filas de /api/dividendos,
// cuentas de /api/cuentas y tasa a euros de cada moneda.
let crDividendos = []
let crCuentasApp = []
let crTasas = new Map()

/**
 * Cuentas de Finanzas › Cuentas, para saber en cuál cae cada dividendo.
 *
 * Returns:
 *     La lista de cuentas; vacía si falla (la página sigue con los intereses).
 */
async function crCargarCuentasApp() {
    try {
        const data = await Api.get("/api/cuentas")
        return Array.isArray(data?.cuentas) ? data.cuentas : []
    } catch (error) {
        console.error("Error cargando cuentas para la cuenta remunerada:", error)
        return []
    }
}

/**
 * Tasa a euros de cada moneda en que se cobran los dividendos.
 *
 * Se piden una vez por moneda al abrir la página (con la caché de
 * dividendos.js), no en cada repintado: así cambiar de año o de cuenta es
 * síncrono y no hay respuestas que lleguen tarde.
 *
 * Args:
 *     dividendos: filas de /api/dividendos.
 *
 * Returns:
 *     Map moneda -> tasa.
 */
async function crCargarTasas(dividendos) {
    const monedas = [...new Set(dividendos.map((r) => String(r.monedaTotal || "EUR").toUpperCase()))]
    const tasas = await Promise.all(monedas.map((moneda) => _getDivExchangeRate(moneda, "EUR")))
    return new Map(monedas.map((moneda, i) => [moneda, tasas[i]]))
}

function crCuentaActual() {
    return crCuentas.find((c) => c.id === crCuentaId) || null
}

function crMovimientosActuales() {
    const cuenta = crCuentaActual()
    if (!cuenta) return []
    return construirMovimientosCuenta({
        interesRows: Array.isArray(cuenta.rows) ? cuenta.rows : [],
        dividendoRows: crDividendos,
        cuentaId: cuenta.cuenta || "",
        cuentasApp: crCuentasApp,
        tasas: crTasas
    })
}

/**
 * Deja la página lista con los datos ya cargados: cuenta y año válidos y todo pintado.
 *
 * Args:
 *     data: respuesta de /api/intereses.
 */
function crMostrarDatos(data) {
    crCuentas = Array.isArray(data?.cuentas) ? data.cuentas : []
    if (!crCuentaActual()) crCuentaId = crCuentas[0]?.id ?? null
    crElegirAnioValido()
    crRender()
}

// Mantiene el año elegido si la cuenta tiene movimientos en él; si no, el último.
function crElegirAnioValido() {
    const anios = crAniosDeMovimientos(crMovimientosActuales())
    if (!anios.includes(crAnio)) crAnio = anios.at(-1) ?? null
}

function crSeleccionarCuenta(id) {
    crCuentaId = id
    crAnio = null
    crElegirAnioValido()
    crRender()
}

function crSeleccionarAnio(anio) {
    crAnio = anio
    crRender()
}

function crRenderCuentas() {
    const list = document.getElementById("crCuentasList")
    if (!list) return
    list.innerHTML = crCuentas
        .map(
            (c) =>
                `<button type="button" class="cuentaItem${c.id === crCuentaId ? " active" : ""}" data-cr-cuenta="${escapeHtml(c.id)}"><span class="cuentaItemName">${escapeHtml(c.nombre)}</span></button>`
        )
        .join("")
    refrescarTiraPestanas(list)
}

function crRenderAnios(anios) {
    const list = document.getElementById("crYearList")
    if (!list) return
    // El más reciente a la izquierda, como en el resto de barras de años.
    list.innerHTML = [...anios]
        .reverse()
        .map(
            (anio) =>
                `<button type="button" class="interesesYearBtn${anio === crAnio ? " active" : ""}" data-cr-anio="${escapeHtml(anio)}">${escapeHtml(anio)}</button>`
        )
        .join("")
    refrescarTiraPestanas(list)
}

/**
 * Tabla de la derecha: un movimiento por fila, el más reciente arriba.
 *
 * Args:
 *     tbody: cuerpo de la tabla.
 *     movimientos: movimientos del año elegido, en orden cronológico.
 */
function crRenderTabla(tbody, movimientos) {
    tbody.innerHTML = [...movimientos]
        .reverse()
        .map((m) => {
            const signo = m.importe < 0 ? " crImporteNeg" : ""
            return `<tr>
                <td class="crMovimientoFecha">${escapeHtml(m.fecha)}</td>
                <td class="crMovimientoConcepto" title="${escapeHtml(m.concepto)}">${escapeHtml(m.concepto)}</td>
                <td class="crMovimientoImporte${signo}">${crImporteConSigno(m.importe)}</td>
            </tr>`
        })
        .join("")
}

function crRender() {
    const tbody = document.getElementById("crBody")
    if (!tbody) return

    const movimientos = crMovimientosActuales()
    const delAnio = movimientos.filter((m) => m.anio === crAnio)

    crRenderCuentas()
    crRenderAnios(crAniosDeMovimientos(movimientos))
    crRenderTabla(tbody, delAnio)

    const vacio = document.getElementById("crEmptyMsg")
    if (vacio) {
        vacio.textContent = crCuentas.length
            ? "Sin intereses ni dividendos en este año."
            : "No hay cuentas remuneradas. Añádelas en Bolsa e Inversión › Cuenta Remunerada."
        vacio.classList.toggle("hidden", delAnio.length > 0)
    }

    const total = delAnio.reduce((acc, m) => acc + m.importe, 0)
    const totalAnio = document.getElementById("crTotalAnio")
    if (totalAnio) totalAnio.textContent = delAnio.length ? crImporteConSigno(total) : ""

    crPintarGrafico(document.getElementById("crGrafico"), acumularMovimientosAnio(movimientos, crAnio), crAnio)
}

function crBindEventos() {
    const cuentas = document.getElementById("crCuentasList")
    if (cuentas && !cuentas.dataset.bound) {
        cuentas.dataset.bound = "true"
        cuentas.addEventListener("click", (e) => {
            const boton = e.target.closest("[data-cr-cuenta]")
            if (boton) crSeleccionarCuenta(boton.dataset.crCuenta)
        })
    }

    const anios = document.getElementById("crYearList")
    if (anios && !anios.dataset.bound) {
        anios.dataset.bound = "true"
        anios.addEventListener("click", (e) => {
            const boton = e.target.closest("[data-cr-anio]")
            if (boton) crSeleccionarAnio(boton.dataset.crAnio)
        })
    }
}

/**
 * Entrada de la página (la llama loadPage en app-core.js).
 */
async function initCuentaRemuneradaLogic() {
    crBindEventos()
    const [data, dividendos, cuentasApp] = await Promise.all([
        loadInteresesData(),
        loadDividendosData(),
        crCargarCuentasApp()
    ])
    crDividendos = Array.isArray(dividendos?.rows) ? dividendos.rows : []
    crCuentasApp = cuentasApp
    crTasas = await crCargarTasas(crDividendos)
    crMostrarDatos(data)
}
