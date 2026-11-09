// ===== MOVIMIENTOS ENTRE CUENTAS =====
// La tabla de transferencias de Mi dinero › Movimientos: filtros por año y por
// cuenta, búsqueda, y a la derecha el total, las comisiones del periodo y una
// tarjeta por cuenta con lo que entró y salió en lo que se está viendo.
// Alta, edición y borrado son los mismos modales de la ventana Cuentas
// (cuentas.js): aquí solo se les pasa cómo refrescar esta página al guardar.
// Prefijo «mvc» para no chocar con el resto de páginas, que comparten el
// ámbito global.

let mvcCuentas = []
let mvcTransferencias = []
// "" es «todos los años» y «todas las cuentas».
let mvcYear = ""
let mvcCuenta = ""
const mvcSort = { key: "fecha", dir: "desc" }

const MVC_COLUMNAS = [
    { key: "fecha", label: "Fecha" },
    { key: "origen", label: "Origen" },
    { key: "destino", label: "Destino" },
    { key: "concepto", label: "Concepto" },
    { key: "cantidad", label: "Cantidad", num: true },
    { key: "comision", label: "Comisión", num: true }
]

// Valor por el que se ordena cada columna: fechas e importes como números para
// que «10-01» no quede antes que «9-01» ni «1.000» antes que «90».
const MVC_VALOR_ORDEN = {
    fecha: (t) => cntFechaClave(t.fecha),
    origen: (t) => t.origen_nombre || "",
    destino: (t) => t.destino_nombre || "",
    concepto: (t) => t.concepto || "",
    cantidad: (t) => parseEuroNumber(t.cantidad),
    comision: (t) => parseEuroNumber(t.comision)
}

/**
 * Años con transferencias, más el actual aunque esté vacío, ordenados de menor
 * a mayor.
 * @param {Array<{year: string}>} transferencias
 * @param {Date} [hoy]
 * @returns {string[]}
 */
function mvcAniosDisponibles(transferencias, hoy = new Date()) {
    const actual = String(hoy.getFullYear())
    return [...new Set([actual, ...transferencias.map((t) => t.year).filter(Boolean)])].sort()
}

/**
 * Transferencias del año y de la cuenta elegidos. Una cuenta casa tanto si es
 * el origen como si es el destino.
 * @param {Array<object>} transferencias
 * @param {{year?: string, cuenta?: string}} filtro Vacío es «todos».
 * @returns {Array<object>}
 */
function mvcFiltrar(transferencias, { year = "", cuenta = "" } = {}) {
    return transferencias.filter(
        (t) => (!year || t.year === year) && (!cuenta || t.origen === cuenta || t.destino === cuenta)
    )
}

/**
 * Copia ordenada por la columna pedida. A igualdad, la más reciente primero y,
 * dentro del mismo día, la última apuntada, para que el orden sea estable
 * entre repintados.
 * @param {Array<object>} transferencias
 * @param {{key: string, dir: "asc"|"desc"}} sort
 * @returns {Array<object>}
 */
function mvcOrdenar(transferencias, { key, dir }) {
    const valor = MVC_VALOR_ORDEN[key] || MVC_VALOR_ORDEN.fecha
    const signo = dir === "asc" ? 1 : -1
    return [...transferencias].sort((a, b) => {
        const x = valor(a)
        const y = valor(b)
        const cmp = typeof x === "string" ? x.localeCompare(y, "es", { sensitivity: "base" }) : x - y
        return cmp * signo || cntFechaClave(b.fecha) - cntFechaClave(a.fecha) || b.id - a.id
    })
}

/**
 * Lo que entró, salió y se pagó en comisiones en una cuenta dentro de las
 * transferencias dadas. La comisión la paga siempre el origen y va aparte de
 * la salida, igual que en el saldo de la cuenta.
 * @param {Array<object>} transferencias
 * @param {string} cuentaId
 * @returns {{entradas: number, salidas: number, comisiones: number, numero: number}}
 */
function mvcResumenCuenta(transferencias, cuentaId) {
    return transferencias.reduce(
        (acc, t) => {
            if (t.destino === cuentaId) acc.entradas += parseEuroNumber(t.cantidad)
            if (t.origen === cuentaId) {
                acc.salidas += parseEuroNumber(t.cantidad)
                acc.comisiones += parseEuroNumber(t.comision)
            }
            if (t.origen === cuentaId || t.destino === cuentaId) acc.numero += 1
            return acc
        },
        { entradas: 0, salidas: 0, comisiones: 0, numero: 0 }
    )
}

/**
 * Suma de las comisiones de las transferencias dadas.
 * @param {Array<object>} transferencias
 * @returns {number}
 */
function mvcTotalComisiones(transferencias) {
    return transferencias.reduce((suma, t) => suma + parseEuroNumber(t.comision), 0)
}

// ── Carga ────────────────────────────────────────────────────────────────

async function initMovimientosCuentasLogic() {
    try {
        await mvcRecargar()
        mvcBind()
        mvcRender()
    } catch (error) {
        console.error("Error inicializando los movimientos entre cuentas:", error)
        showError("No se pudieron cargar los movimientos", error)
    }
}

async function mvcRecargar() {
    const [cuentas, transferencias] = await Promise.all([Api.get("/api/cuentas"), Api.get("/api/transferencias")])
    mvcCuentas = Array.isArray(cuentas?.cuentas) ? cuentas.cuentas : []
    mvcTransferencias = Array.isArray(transferencias?.transferencias) ? transferencias.transferencias : []
    // Los modales de cuentas.js leen estas listas para los desplegables.
    cntCuentas = mvcCuentas
    cntTransferencias = mvcTransferencias
    window._cuentasDinero = mvcCuentas

    // Un filtro que ya no existe (cuenta borrada, año sin datos) vuelve a «todos».
    if (mvcYear && !mvcAniosDisponibles(mvcTransferencias).includes(mvcYear)) mvcYear = ""
    if (mvcCuenta && !mvcCuentas.some((c) => c.id === mvcCuenta)) mvcCuenta = ""
}

// Lo que se pasa a los modales de cuentas.js para que refresquen esta página.
async function mvcRefrescar() {
    await mvcRecargar()
    mvcRender()
}

function mvcVisibles() {
    return mvcFiltrar(mvcTransferencias, { year: mvcYear, cuenta: mvcCuenta })
}

// ── Pintado ──────────────────────────────────────────────────────────────

function mvcRender() {
    mvcRenderYears()
    mvcRenderChips()
    mvcRenderTabla()
    mvcRenderLateral()
}

// Crea un botón de filtro con el estilo de las tiras de años de la app.
function mvcBotonFiltro(etiqueta, activo, alPulsar) {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = `interesesYearBtn${activo ? " active" : ""}`
    btn.textContent = etiqueta
    btn.addEventListener("click", alPulsar)
    return btn
}

function mvcRenderYears() {
    const list = document.getElementById("mvcYearList")
    if (!list) return
    // Como en Intereses: el más reciente a la izquierda, tras «Todos».
    const opciones = [["", "Todos"], ...[...mvcAniosDisponibles(mvcTransferencias)].reverse().map((y) => [y, y])]
    list.replaceChildren(
        ...opciones.map(([valor, etiqueta]) =>
            mvcBotonFiltro(etiqueta, valor === mvcYear, () => {
                mvcYear = valor
                mvcRender()
            })
        )
    )
    refrescarTiraPestanas(list)
}

function mvcRenderChips() {
    const list = document.getElementById("mvcCuentaList")
    if (!list) return
    // Pulsar la cuenta ya elegida la quita: así no hace falta un «Todas».
    list.replaceChildren(
        ...mvcCuentas.map((c) => mvcBotonFiltro(c.nombre, c.id === mvcCuenta, () => mvcAlternarCuenta(c.id)))
    )
    refrescarTiraPestanas(list)
}

function mvcAlternarCuenta(cuentaId) {
    mvcCuenta = mvcCuenta === cuentaId ? "" : cuentaId
    mvcRender()
}

function mvcHead() {
    const celdas = MVC_COLUMNAS.map(({ key, label, num }) => {
        const activa = mvcSort.key === key
        const flecha = activa ? (mvcSort.dir === "asc" ? "▲" : "▼") : ""
        return `<th class="mThSort${activa ? " mThActive" : ""}${num ? " numCol" : ""}" data-mvc-sort="${key}" title="Ordenar por ${label.toLowerCase()}">${label}<span class="mSortArrow">${flecha}</span></th>`
    }).join("")
    return `<tr>${celdas}<th class="rowActionHeader"></th></tr>`
}

function mvcFila(t) {
    const comision = parseEuroNumber(t.comision)
    return `
        <tr class="movDetailRow" data-id="${escapeGastosHtml(t.id)}">
            <td>${escapeGastosHtml(t.fecha)}</td>
            <td>${escapeGastosHtml(t.origen_nombre)}</td>
            <td>${escapeGastosHtml(t.destino_nombre)}</td>
            <td title="${escapeGastosHtml(t.nota)}">${t.concepto ? escapeGastosHtml(t.concepto) : '<span class="cuentasSinConcepto">Sin concepto</span>'}</td>
            <td class="numCell">${formatEuro(parseEuroNumber(t.cantidad))}</td>
            <td class="numCell">${comision > 0 ? `<span class="cuentasNeg">${formatEuro(comision)}</span>` : '<span class="cuentasSinConcepto">—</span>'}</td>
            <td class="rowActionsCell">
                <div class="rowMenu">
                    <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                    <div class="rowMenuDropdown">
                        <button type="button" class="rowMenuItem" data-mvc-editar>Editar</button>
                        <hr>
                        <button type="button" class="rowMenuItem rowMenuItemDanger" data-mvc-eliminar>Eliminar</button>
                    </div>
                </div>
            </td>
        </tr>`
}

function mvcTextoVacio() {
    if (mvcCuenta) return "No hay transferencias con esta cuenta en el periodo."
    if (mvcYear) return `No hay transferencias en ${mvcYear}.`
    return "Todavía no hay transferencias."
}

function mvcRenderTabla() {
    const head = document.getElementById("mvcHead")
    const body = document.getElementById("mvcBody")
    const empty = document.getElementById("mvcEmpty")
    if (!head || !body || !empty) return

    const filas = mvcOrdenar(mvcVisibles(), mvcSort)
    head.innerHTML = mvcHead()
    body.innerHTML = filas.map(mvcFila).join("")

    empty.textContent = mvcTextoVacio()
    empty.classList.toggle("hidden", filas.length > 0)
    empty.closest(".mvcTableWrapper")?.classList.toggle("mvcVacio", filas.length === 0)
}

function mvcRenderLateral() {
    const total = document.getElementById("mvcTotal")
    if (total) total.textContent = formatEuro(mvcCuentas.reduce((acc, c) => acc + parseEuroNumber(c.saldo), 0))

    // Las del periodo visible, no las de siempre: para el total histórico ya
    // está la ventana Cuentas.
    const comisiones = document.getElementById("mvcComisiones")
    if (comisiones) comisiones.textContent = formatEuro(mvcTotalComisiones(mvcVisibles()))

    const lista = document.getElementById("mvcCuentas")
    if (!lista) return
    // Las tarjetas resumen el año elegido en todas las cuentas, no solo en la
    // filtrada: si no, al elegir una las demás saldrían siempre a cero.
    const delAnio = mvcFiltrar(mvcTransferencias, { year: mvcYear })
    lista.innerHTML = mvcCuentas.map((c) => mvcTarjeta(c, mvcResumenCuenta(delAnio, c.id))).join("")
}

function mvcTarjeta(cuenta, resumen) {
    const saldo = parseEuroNumber(cuenta.saldo)
    const activa = cuenta.id === mvcCuenta
    const periodo = mvcYear || "todos los años"
    const movimientos = resumen.numero
        ? `<div class="mvcCuentaDetalle" title="Transferencias de ${escapeGastosHtml(periodo)}">
                <span class="cuentasPos">+${formatEuro(resumen.entradas)}</span>
                <span class="cuentasNeg">${formatEuro(-resumen.salidas)}</span>
                ${resumen.comisiones ? `<span class="cuentasNeg" title="Comisiones pagadas por esta cuenta">Com. ${formatEuro(-resumen.comisiones)}</span>` : ""}
           </div>`
        : `<div class="mvcCuentaDetalle"><span class="cuentasSinConcepto">Sin transferencias en ${escapeGastosHtml(periodo)}</span></div>`
    return `
        <button type="button" class="mvcCuenta${activa ? " activa" : ""}" data-mvc-cuenta="${escapeGastosHtml(cuenta.id)}" aria-pressed="${activa}" title="${activa ? "Ver todas las cuentas" : "Ver solo las transferencias de esta cuenta"}">
            <span class="mvcCuentaCab">
                <span class="mvcCuentaNombre">${escapeGastosHtml(cuenta.nombre)}</span>
                <span class="cntTipo cntTipo-${escapeGastosHtml(cuenta.tipo)}">${escapeGastosHtml(cuenta.tipo_etiqueta || cuenta.tipo)}</span>
            </span>
            <span class="mvcCuentaSaldo${saldo < 0 ? " cuentasNeg" : ""}">${formatEuro(saldo)}</span>
            ${movimientos}
        </button>`
}

// ── Acciones ─────────────────────────────────────────────────────────────

function mvcDescargarCsv() {
    const filas = mvcOrdenar(mvcVisibles(), mvcSort).map((t) => ({
        Fecha: t.fecha,
        Origen: t.origen_nombre,
        Destino: t.destino_nombre,
        Concepto: t.concepto,
        Cantidad: parseEuroNumber(t.cantidad),
        Comision: parseEuroNumber(t.comision),
        Nota: t.nota || ""
    }))
    const sufijo = [mvcYear, mvcCuenta].filter(Boolean).join("-")
    downloadCsvFile(`transferencias${sufijo ? "-" + sufijo : ""}.csv`, filas)
}

// Respeta el año y la cuenta elegidos, como la tabla. La comisión no se dibuja:
// no llega a ninguna cuenta.
function mvcAbrirGrafo() {
    const partes = [mvcYear || "Todos los años"]
    if (mvcCuenta) partes.push(`solo ${cntNombre(mvcCuenta)}`)
    abrirGrafoFlujos({
        titulo: "Movimientos entre cuentas",
        subtitulo: partes.join(" · "),
        movimientos: mvcVisibles().map((t) => ({
            origen: t.origen_nombre || cntNombre(t.origen),
            destino: t.destino_nombre || cntNombre(t.destino),
            cantidad: parseEuroNumber(t.cantidad)
        })),
        formato: formatEuro,
        vacio: "No hay transferencias en este periodo."
    })
}

function mvcBindMenu() {
    const trigger = document.querySelector("#mvcActionsMenu .pageActionsMenuTrigger")
    const menu = document.getElementById("mvcActionsDropdown")
    if (!trigger || !menu) return
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

function mvcCambiarOrden(key) {
    if (mvcSort.key === key) mvcSort.dir = mvcSort.dir === "asc" ? "desc" : "asc"
    else {
        mvcSort.key = key
        mvcSort.dir = key === "fecha" || key === "cantidad" || key === "comision" ? "desc" : "asc"
    }
    mvcRenderTabla()
}

function mvcBind() {
    mvcBindMenu()

    const on = (id, handler) => document.getElementById(id)?.addEventListener("click", handler)
    // La nueva sale de la cuenta filtrada, si hay una.
    on("mvcAddRowBtn", () => cntAbrirModalTransferencia(null, mvcCuenta, mvcRefrescar))
    on("mvcCsvBtn", mvcDescargarCsv)
    on("mvcGrafoBtn", mvcAbrirGrafo)
    // Con «Todos» el informe es del año en curso.
    on("mvcInformeBtn", (e) => descargarInformeFinanzas(mvcYear, e.currentTarget))

    document.getElementById("mvcHead")?.addEventListener("click", (event) => {
        const th = event.target.closest("[data-mvc-sort]")
        if (th) mvcCambiarOrden(th.dataset.mvcSort)
    })

    document.getElementById("mvcBody")?.addEventListener("click", (event) => {
        const fila = event.target.closest("tr")
        const transferencia = fila && mvcTransferencias.find((t) => String(t.id) === fila.dataset.id)
        if (!transferencia) return
        if (event.target.closest("[data-mvc-editar]")) cntAbrirModalTransferencia(transferencia, "", mvcRefrescar)
        else if (event.target.closest("[data-mvc-eliminar]")) cntEliminarTransferencia(transferencia, mvcRefrescar)
    })

    document.getElementById("mvcCuentas")?.addEventListener("click", (event) => {
        const tarjeta = event.target.closest("[data-mvc-cuenta]")
        if (tarjeta) mvcAlternarCuenta(tarjeta.dataset.mvcCuenta)
    })
}
