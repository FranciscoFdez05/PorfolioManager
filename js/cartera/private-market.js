let _pmCurrentFilter = "all"
let _pmSearch = ""

// Las filas viven aquí y no en las celdas de la tabla: con las compras de una
// misma inversión agrupadas bajo una fila de totales, el DOM ya no es una
// copia fiel de los datos y leerlo devolvería los totales como si fueran filas.
let _pmRows = []

// Grupos desplegados, por clave de grupo. Sobrevive a los repintados para que
// añadir o editar una compra no pliegue lo que el usuario tenía abierto.
const _pmDesplegados = new Set()

// Misma clave y formato que bindTableSort, para conservar el orden que ya
// tuviera guardado el usuario de antes de agrupar.
const _PM_SORT_STORAGE_KEY = "tableSort_pm"
let _pmOrden = { key: null, dir: "desc" }

const _PM_TIPO_LABELS = {
    pe: "Private Equity",
    vc: "Venture Capital",
    credito: "Crédito Privado",
    inmobiliario: "Inmobiliario",
    infraestructura: "Infraestructura",
    otros: "Otros"
}

const _PM_CURRENCY_SYMBOLS_BASE = { EUR: "EUR €", USD: "USD $", GBP: "GBP £", CHF: "CHF ₣", JPY: "JPY ¥" }

function _pmGetCurrencySymbols() {
    const codes = window._fiatCurrencies?.length ? window._fiatCurrencies : Object.keys(_PM_CURRENCY_SYMBOLS_BASE)
    const result = {}
    codes.forEach((c) => {
        result[c] = _PM_CURRENCY_SYMBOLS_BASE[c] || c
    })
    return result
}

async function loadPrivateMarketData() {
    const resp = await fetch("/api/privatemarket")
        .then((r) => r.json())
        .catch(() => ({ rows: [] }))
    return { rows: Array.isArray(resp.rows) ? resp.rows : [] }
}

async function savePrivateMarketData() {
    const rows = _pmCollectRows()
    const res = await fetch("/api/privatemarket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows })
    })
    if (!res.ok) throw new Error(`Private Market: HTTP ${res.status}`)
}

function _pmCollectRows() {
    return _pmRows.map((row) => ({ ...row }))
}

function _pmCalcTvpi(llamado, distribuido, valorActual) {
    if (llamado <= 0) return null
    return (distribuido + valorActual) / llamado
}

const _pmFmtPct = (valor) => (valor === null ? "—" : valor.toFixed(1).replace(".", ",") + " %")
const _pmFmtX = (valor) => (valor === null ? "—" : valor.toFixed(2) + "x")

/**
 * Convierte una fecha dd-mm-aaaa en un número ordenable.
 *
 * @param {string} texto Fecha tal y como se teclea en el popup.
 * @returns {number} Milisegundos, o -Infinity si no es una fecha válida, para
 *     que las filas sin fecha queden al principio en orden ascendente.
 */
function _pmFechaOrden(texto) {
    const partes = String(texto || "")
        .trim()
        .match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/)
    if (!partes) return -Infinity
    const anio = partes[3].length === 2 ? 2000 + Number(partes[3]) : Number(partes[3])
    return new Date(anio, Number(partes[2]) - 1, Number(partes[1])).getTime()
}

/**
 * Celdas de las columnas de importes e indicadores (de "Comprometido" a
 * "Rend. %"), comunes a una compra suelta y a la fila de totales de un grupo.
 *
 * @param {{comprometido: number, llamado: number, distribuido: number, valorActual: number}} importes
 * @param {string[]} textos Texto a mostrar en las cuatro columnas de importe.
 * @returns {Object[]} Especificación de celda: text o html, cls y sort.
 */
function _pmCeldasImportes(importes, textos) {
    const { comprometido, llamado, distribuido, valorActual } = importes
    const neto = distribuido + valorActual - llamado
    const tvpi = _pmCalcTvpi(llamado, distribuido, valorActual)
    const pendiente = Math.max(0, comprometido - llamado)
    const pctLlamado = comprometido > 0 ? (llamado / comprometido) * 100 : null
    const dpi = llamado > 0 ? distribuido / llamado : null
    const rvpi = llamado > 0 ? valorActual / llamado : null
    const rendPct = llamado > 0 ? (neto / llamado) * 100 : null
    const sinValor = (valor) => (valor === null ? -Infinity : valor)

    return [
        { text: textos[0], sort: comprometido },
        { text: textos[1], sort: llamado },
        { text: textos[2], sort: distribuido },
        { text: textos[3], sort: valorActual },
        { text: formatEuro(neto), cls: neto >= 0 ? "pmNetoPos" : "pmNetoNeg", sort: neto },
        { text: _pmFmtX(tvpi), sort: sinValor(tvpi) },
        { text: formatEuro(pendiente), sort: pendiente },
        { text: _pmFmtPct(pctLlamado), sort: sinValor(pctLlamado) },
        { text: _pmFmtX(dpi), sort: sinValor(dpi) },
        { text: _pmFmtX(rvpi), sort: sinValor(rvpi) },
        {
            text: _pmFmtPct(rendPct),
            cls: rendPct === null ? undefined : rendPct >= 0 ? "pmNetoPos" : "pmNetoNeg",
            sort: sinValor(rendPct)
        }
    ]
}

function _pmImportesDe(rowData) {
    return {
        comprometido: parseEuroNumber(rowData.comprometido || ""),
        llamado: parseEuroNumber(rowData.llamado || ""),
        distribuido: parseEuroNumber(rowData.distribuido || ""),
        valorActual: parseEuroNumber(rowData.valorActual || "")
    }
}

function _pmCeldaTipo(tipo) {
    const etiqueta = _PM_TIPO_LABELS[tipo] || tipo
    return {
        html: `<span class="pmTipoPill pmTipoPill--${escapeHtml(tipo)}">${escapeHtml(etiqueta)}</span>`,
        sort: etiqueta.toLowerCase()
    }
}

function _pmCeldaMoneda(currency) {
    const etiqueta = _pmGetCurrencySymbols()[currency] || currency
    return { text: etiqueta, sort: etiqueta.toLowerCase() }
}

/**
 * Celdas de una compra. Dentro de un grupo, la columna "Nombre" muestra el
 * número de compra en vez de repetir el nombre de la inversión.
 *
 * @param {Object} rowData Fila guardada.
 * @param {number|null} numeroCompra Posición por fecha dentro del grupo, o
 *     null si la inversión tiene una sola compra.
 * @returns {Object[]} Especificación de las 17 celdas de datos.
 */
function _pmCeldasFila(rowData, numeroCompra) {
    const nombre = rowData.nombre || ""
    const nota = rowData.nota || ""
    const celdaNombre =
        numeroCompra === null
            ? { text: nombre, sort: nombre.toLowerCase() }
            : {
                  html: `<div class="pmCeldaCompra"><span>Compra ${numeroCompra}</span>${nota ? `<span class="pmGrupoSub">${escapeHtml(nota)}</span>` : ""}</div>`,
                  sort: numeroCompra
              }

    return [
        { text: rowData.fecha || "", sort: _pmFechaOrden(rowData.fecha) },
        _pmCeldaTipo(rowData.tipo || "pe"),
        celdaNombre,
        { text: rowData.gestor || "", sort: String(rowData.gestor || "").toLowerCase() },
        { text: rowData.vintage || "", sort: String(rowData.vintage || "") },
        _pmCeldaMoneda(rowData.currency || "EUR"),
        ..._pmCeldasImportes(_pmImportesDe(rowData), [
            rowData.comprometido || "",
            rowData.llamado || "",
            rowData.distribuido || "",
            rowData.valorActual || ""
        ])
    ]
}

/**
 * Celdas de la fila de totales de un grupo: la fecha de la primera compra, la
 * suma de los importes y los indicadores calculados sobre esa suma (no la
 * media de los de cada compra, que pesaría igual una compra pequeña que una
 * grande).
 *
 * @param {{filas: Object[]}} grupo Grupo con sus compras ordenadas por fecha.
 * @returns {Object[]} Especificación de las 17 celdas de datos.
 */
function _pmCeldasGrupo(grupo) {
    const datos = grupo.filas.map((fila) => fila.datos)
    const primera = datos[0]
    const primeroConValor = (campo) => datos.find((row) => String(row[campo] || "").trim())?.[campo] || ""
    const importes = datos.map(_pmImportesDe).reduce(
        (suma, actual) => ({
            comprometido: suma.comprometido + actual.comprometido,
            llamado: suma.llamado + actual.llamado,
            distribuido: suma.distribuido + actual.distribuido,
            valorActual: suma.valorActual + actual.valorActual
        }),
        { comprometido: 0, llamado: 0, distribuido: 0, valorActual: 0 }
    )
    const nombre = primera.nombre || ""
    const gestor = primeroConValor("gestor")
    const vintage = primeroConValor("vintage")

    return [
        { text: primera.fecha || "", sort: _pmFechaOrden(primera.fecha) },
        _pmCeldaTipo(primera.tipo || "pe"),
        {
            html: `<div class="pmCeldaGrupo"><span class="pmChevron" aria-hidden="true"></span><span class="pmGrupoNombre">${escapeHtml(nombre)}</span><span class="pmGrupoSub">${datos.length} compras</span></div>`,
            sort: nombre.toLowerCase()
        },
        { text: gestor, sort: gestor.toLowerCase() },
        { text: vintage, sort: vintage },
        _pmCeldaMoneda(primera.currency || "EUR"),
        ..._pmCeldasImportes(importes, [
            formatEuro(importes.comprometido),
            formatEuro(importes.llamado),
            formatEuro(importes.distribuido),
            formatEuro(importes.valorActual)
        ])
    ]
}

/**
 * Datos de partida para añadir una compra a la misma inversión: se copia lo
 * que la identifica y se dejan los importes vacíos, porque cada compra es un
 * tramo nuevo con su propia fecha y su propio capital.
 *
 * @param {Object} rowData Fila de la inversión a la que se añade la compra.
 * @returns {Object} Fila nueva sin importes, con la fecha de hoy.
 */
function _pmPlantillaReinversion(rowData) {
    return {
        fecha: todayDateString(),
        tipo: rowData.tipo || "pe",
        nombre: rowData.nombre || "",
        gestor: rowData.gestor || "",
        vintage: rowData.vintage || "",
        currency: rowData.currency || "EUR"
    }
}

/**
 * Clave que agrupa las compras de una misma inversión: el nombre, sin
 * distinguir mayúsculas ni espacios de los extremos, y la moneda, porque
 * sumar importes en monedas distintas daría un total sin sentido.
 *
 * @param {Object} rowData Fila guardada.
 * @param {number} index Posición de la fila; las que no tienen nombre no se
 *     agrupan con nada y usan su posición como clave.
 * @returns {string} Clave del grupo.
 */
function _pmClaveGrupo(rowData, index) {
    const nombre = String(rowData.nombre || "")
        .trim()
        .toLowerCase()
    if (!nombre) return `#${index}`
    return `${nombre}|${rowData.currency || "EUR"}`
}

function _pmFilaVisible(rowData) {
    const tipo = rowData.tipo || ""
    const tipoMatches =
        _pmCurrentFilter === "all" ||
        (Array.isArray(_pmCurrentFilter) ? _pmCurrentFilter.includes(tipo) : tipo === _pmCurrentFilter)
    const query = _pmSearch.trim().toLowerCase()
    const searchMatches = !query || `${rowData.nombre || ""} ${rowData.gestor || ""}`.toLowerCase().includes(query)
    return tipoMatches && searchMatches
}

/**
 * Agrupa las filas visibles por inversión, en el orden en que aparece la
 * primera compra de cada una, con las compras de cada grupo por fecha.
 *
 * @returns {{clave: string, filas: {datos: Object, index: number, numero: number}[]}[]}
 */
function _pmAgrupar() {
    const grupos = new Map()
    _pmRows.forEach((datos, index) => {
        if (!_pmFilaVisible(datos)) return
        const clave = _pmClaveGrupo(datos, index)
        if (!grupos.has(clave)) grupos.set(clave, { clave, filas: [] })
        grupos.get(clave).filas.push({ datos, index })
    })

    return [...grupos.values()].map((grupo) => {
        // sort es estable: dos compras con la misma fecha (o sin fecha)
        // conservan el orden en que se añadieron.
        grupo.filas.sort((a, b) => _pmFechaOrden(a.datos.fecha) - _pmFechaOrden(b.datos.fecha))
        grupo.filas.forEach((fila, posicion) => {
            fila.numero = posicion + 1
        })
        return grupo
    })
}

function _pmComparar(a, b) {
    const key = Number(_pmOrden.key)
    const av = a[key]?.sort
    const bv = b[key]?.sort
    const resultado =
        typeof av === "string" || typeof bv === "string"
            ? String(av ?? "").localeCompare(String(bv ?? ""), "es")
            : (av ?? -Infinity) < (bv ?? -Infinity)
              ? -1
              : (av ?? -Infinity) > (bv ?? -Infinity)
                ? 1
                : 0
    return _pmOrden.dir === "asc" ? resultado : -resultado
}

function _pmBuildMenu(items) {
    const actionCell = document.createElement("td")
    actionCell.className = "rowActionsCell"
    actionCell.innerHTML = `
        <div class="rowMenu">
            <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
            <div class="rowMenuDropdown"></div>
        </div>
    `
    const dropdown = actionCell.querySelector(".rowMenuDropdown")
    items.forEach(({ label, danger, onClick }) => {
        if (danger) dropdown.appendChild(document.createElement("hr"))
        const button = document.createElement("button")
        button.type = "button"
        button.className = `rowMenuItem avActionBtn${danger ? " rowMenuItemDanger" : ""}`
        button.textContent = label
        button.addEventListener("click", onClick)
        dropdown.appendChild(button)
    })
    return actionCell
}

function _pmBuildTr(celdas, actionCell) {
    const tr = document.createElement("tr")
    celdas.forEach(({ text, html, cls }) => {
        const td = document.createElement("td")
        if (html) td.innerHTML = html
        else td.textContent = text
        if (cls) td.classList.add(cls)
        tr.appendChild(td)
    })
    tr.appendChild(actionCell)
    return tr
}

function _pmBuildRow(rowData, index, numeroCompra = null, celdas = _pmCeldasFila(rowData, numeroCompra)) {
    const actionCell = _pmBuildMenu([
        { label: "Editar", onClick: () => _pmOpenEditModal(index) },
        { label: "Añadir compra", onClick: () => _pmOpenEditModal(-1, _pmPlantillaReinversion(rowData)) },
        {
            label: "Eliminar",
            danger: true,
            onClick: () => {
                // Una inversión recién añadida puede no tener nombre todavía; entonces
                // no hay nada que teclear y el diálogo se queda en el de siempre.
                const nombreInversion = String(rowData.nombre || "").trim()
                openConfirmModal({
                    title: "Eliminar inversión",
                    message: nombreInversion
                        ? `Vas a eliminar la inversión "${nombreInversion}" y todo su historial. Esto no se puede deshacer.`
                        : "¿Quieres eliminar esta inversión?",
                    confirmLabel: "Eliminar",
                    requireText: nombreInversion,
                    onConfirm: async () => {
                        _pmRows.splice(index, 1)
                        _pmRender()
                        await savePrivateMarketData()
                    }
                })
            }
        }
    ])

    const tr = _pmBuildTr(celdas, actionCell)
    tr.dataset.tipo = rowData.tipo || "pe"
    if (numeroCompra !== null) tr.classList.add("pmCompraRow")
    return tr
}

function _pmBuildGrupoRow(grupo, celdas, abierto) {
    const primera = grupo.filas[0].datos
    const actionCell = _pmBuildMenu([
        { label: "Añadir compra", onClick: () => _pmOpenEditModal(-1, _pmPlantillaReinversion(primera)) }
    ])
    const tr = _pmBuildTr(celdas, actionCell)
    tr.classList.add("pmGrupoRow")
    tr.classList.toggle("pmGrupoRowOpen", abierto)
    tr.dataset.tipo = primera.tipo || "pe"
    tr.addEventListener("click", (event) => {
        if (event.target.closest(".rowActionsCell")) return
        if (_pmDesplegados.has(grupo.clave)) _pmDesplegados.delete(grupo.clave)
        else _pmDesplegados.add(grupo.clave)
        _pmRenderBody()
    })
    return tr
}

function _pmRenderBody() {
    const tbody = document.getElementById("pmBody")
    if (!tbody) return

    const ordenar = _pmOrden.key !== null
    const entradas = _pmAgrupar().map((grupo) => {
        const celdas = grupo.filas.length > 1 ? _pmCeldasGrupo(grupo) : _pmCeldasFila(grupo.filas[0].datos, null)
        const filas = grupo.filas.map((fila) => ({ ...fila, celdas: _pmCeldasFila(fila.datos, fila.numero) }))
        if (ordenar) filas.sort((a, b) => _pmComparar(a.celdas, b.celdas))
        return { grupo, celdas, filas }
    })
    if (ordenar) entradas.sort((a, b) => _pmComparar(a.celdas, b.celdas))

    tbody.innerHTML = ""
    entradas.forEach(({ grupo, celdas, filas }) => {
        if (filas.length === 1) {
            tbody.appendChild(_pmBuildRow(filas[0].datos, filas[0].index, null, celdas))
            return
        }
        const abierto = _pmDesplegados.has(grupo.clave)
        tbody.appendChild(_pmBuildGrupoRow(grupo, celdas, abierto))
        if (!abierto) return
        filas.forEach((fila) => tbody.appendChild(_pmBuildRow(fila.datos, fila.index, fila.numero, fila.celdas)))
    })
    _pmSyncSortArrows()
}

function _pmRender() {
    _pmRenderBody()
    _pmUpdateTotals()
}

function renderPrivateMarketTable(data) {
    _pmRows = Array.isArray(data?.rows) ? data.rows.map((row) => ({ ...row })) : []
    _pmRender()
}

function _pmUpdateTotals() {
    let totalComprometido = 0,
        totalLlamado = 0,
        totalDistribuido = 0,
        totalValorActual = 0

    _pmRows.forEach((row) => {
        const importes = _pmImportesDe(row)
        totalComprometido += importes.comprometido
        totalLlamado += importes.llamado
        totalDistribuido += importes.distribuido
        totalValorActual += importes.valorActual
    })

    const totalNeto = totalDistribuido + totalValorActual - totalLlamado
    const tvpi = totalLlamado > 0 ? (totalDistribuido + totalValorActual) / totalLlamado : null
    const dpi = totalLlamado > 0 ? totalDistribuido / totalLlamado : null
    const rvpi = totalLlamado > 0 ? totalValorActual / totalLlamado : null

    const set = (id, val) => {
        const el = document.getElementById(id)
        if (el) el.textContent = val
    }
    set("pmTotalComprometido", formatEuro(totalComprometido))
    set("pmTotalLlamado", formatEuro(totalLlamado))
    set("pmTotalDistribuido", formatEuro(totalDistribuido))
    set("pmTotalValorActual", formatEuro(totalValorActual))
    set("pmTotalNeto", formatEuro(totalNeto))
    set("pmTvpi", tvpi !== null ? tvpi.toFixed(2) + "x" : "—")
    set("pmDpi", dpi !== null ? dpi.toFixed(2) + "x" : "—")
    set("pmRvpi", rvpi !== null ? rvpi.toFixed(2) + "x" : "—")

    const emptyEl = document.getElementById("pmEmptyMsg")
    const wrapperEl = document.getElementById("pmTableWrapper")
    if (emptyEl) emptyEl.classList.toggle("hidden", _pmRows.length > 0)
    if (wrapperEl) wrapperEl.classList.toggle("hidden", _pmRows.length === 0)
}

function _pmSyncSortArrows() {
    document.querySelectorAll("#pmTableWrapper th.mThSort").forEach((th) => {
        const arrow = th.querySelector(".mSortArrow")
        const activo = th.dataset.sortkey === String(_pmOrden.key)
        th.classList.toggle("mThActive", activo)
        if (arrow) arrow.textContent = activo ? (_pmOrden.dir === "asc" ? " ▲" : " ▼") : ""
    })
}

/**
 * Ordenación propia en lugar de bindTableSort: aquella reordena filas sueltas
 * del DOM y separaría las compras de su fila de totales. Esta ordena los
 * grupos entre sí y las compras dentro de cada grupo.
 */
function _pmBindSort() {
    const table = document.querySelector("#pmTableWrapper table")
    if (!table) return

    try {
        const saved = JSON.parse(localStorage.getItem(_PM_SORT_STORAGE_KEY))
        _pmOrden = { key: saved?.key ?? null, dir: saved?.dir ?? "desc" }
    } catch {
        _pmOrden = { key: null, dir: "desc" }
    }

    if (table.dataset.pmSortBound) return
    table.dataset.pmSortBound = "true"
    table.querySelectorAll("th.mThSort").forEach((th) => {
        th.addEventListener("click", () => {
            const key = th.dataset.sortkey
            _pmOrden =
                _pmOrden.key === key ? { key, dir: _pmOrden.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }
            try {
                localStorage.setItem(_PM_SORT_STORAGE_KEY, JSON.stringify(_pmOrden))
            } catch {
                // Sin almacenamiento (modo privado) el orden vale solo para esta visita.
            }
            _pmRenderBody()
        })
    })
}

function _pmBindSearch() {
    const searchInput = document.getElementById("pmSearch")
    const searchBox = document.getElementById("pmSearchBox")
    const searchBtn = document.getElementById("pmSearchBtn")
    if (!searchInput || !searchBtn) return

    _pmSearch = ""
    searchBtn.addEventListener("click", () => {
        const opening = searchInput.hidden
        searchInput.hidden = !opening
        searchBox?.classList.toggle("open", opening)
        if (opening) {
            searchInput.focus()
            return
        }
        searchInput.value = ""
        _pmSearch = ""
        _pmApplyFilter(_pmCurrentFilter)
    })
    searchInput.addEventListener("input", () => {
        _pmSearch = searchInput.value
        _pmApplyFilter(_pmCurrentFilter)
    })
    searchInput.addEventListener("keydown", (event) => {
        if (event.key === "Escape") searchBtn.click()
    })
}

function _pmApplyFilter(tipo) {
    _pmCurrentFilter = tipo
    _pmRenderBody()
}

/**
 * Inversiones ya registradas, una por grupo y ordenadas por nombre, para el
 * desplegable del campo "Nombre".
 *
 * @returns {Object[]} La primera fila guardada de cada inversión.
 */
function _pmInversionesExistentes() {
    const porGrupo = new Map()
    _pmRows.forEach((row, index) => {
        if (!String(row.nombre || "").trim()) return
        const clave = _pmClaveGrupo(row, index)
        if (!porGrupo.has(clave)) porGrupo.set(clave, row)
    })
    return [...porGrupo.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, "es"))
}

/**
 * Convierte el campo "Nombre" del popup en un desplegable editable: lista las
 * inversiones que ya existen (filtradas por lo que se teclea) y deja escribir
 * una nueva. Elegir una existente rellena tipo, gestor, vintage y moneda, para
 * que la compra caiga en el mismo grupo sin teclearlos otra vez.
 *
 * El menú se crea al abrirse y se quita al cerrarse: cuelga de body (como los
 * de _buildCustomSelect, para que el scroll del popup no lo recorte) y así no
 * queda huérfano si el popup se cierra con el menú abierto.
 *
 * @param {HTMLElement} modal Popup ya montado en dos columnas.
 */
function _pmBindNombreCombo(modal) {
    const input = modal.querySelector("#pmNombreInput")
    if (!input?.parentNode) return

    const wrap = document.createElement("div")
    wrap.className = "pmComboWrap"
    input.parentNode.insertBefore(wrap, input)
    wrap.appendChild(input)
    input.setAttribute("autocomplete", "off")
    input.setAttribute("role", "combobox")
    input.setAttribute("aria-expanded", "false")

    const arrow = document.createElement("button")
    arrow.type = "button"
    arrow.className = "pmComboArrow"
    arrow.tabIndex = -1
    arrow.setAttribute("aria-label", "Ver inversiones existentes")
    arrow.textContent = "▾"
    wrap.appendChild(arrow)

    let menu = null
    let opciones = []
    let activa = -1

    const rellenarDesde = (row) => {
        input.value = row.nombre || ""
        modal.querySelector("#pmGestorInput").value = row.gestor || ""
        modal.querySelector("#pmVintageInput").value = row.vintage || ""
        ;[
            ["#pmTipoSelect", row.tipo || "pe"],
            ["#pmCurrencySelect", row.currency || "EUR"]
        ].forEach(([selector, valor]) => {
            const select = modal.querySelector(selector)
            if (!select || ![...select.options].some((opt) => opt.value === valor)) return
            select.value = valor
            select.dispatchEvent(new Event("change", { bubbles: true }))
        })
    }

    const cerrar = () => {
        menu?.remove()
        menu = null
        activa = -1
        wrap.classList.remove("pmComboOpen")
        input.setAttribute("aria-expanded", "false")
    }

    const marcarActiva = (indice) => {
        if (!menu || !opciones.length) return
        activa = (indice + opciones.length) % opciones.length
        menu.querySelectorAll(".csOption").forEach((item, i) => item.classList.toggle("csActive", i === activa))
        menu.children[activa]?.scrollIntoView({ block: "nearest" })
    }

    const posicionar = () => {
        const rect = input.getBoundingClientRect()
        menu.style.left = `${Math.round(rect.left)}px`
        menu.style.width = `${Math.round(rect.width)}px`
        const alto = Math.min(menu.scrollHeight, 220)
        const cabeDebajo = window.innerHeight - rect.bottom - 8 >= alto
        menu.style.top = `${Math.round(cabeDebajo || rect.top < alto ? rect.bottom + 4 : rect.top - alto - 4)}px`
    }

    const abrir = () => {
        const texto = input.value.trim()
        const consulta = texto.toLowerCase()
        const existentes = _pmInversionesExistentes()
        const coincide = existentes.some((row) => row.nombre.trim().toLowerCase() === consulta)
        const filtradas = consulta
            ? existentes.filter((row) => `${row.nombre} ${row.gestor || ""}`.toLowerCase().includes(consulta))
            : existentes

        opciones = [
            texto && !coincide
                ? { nueva: true, label: `Añadir "${texto}" como inversión nueva` }
                : !texto
                  ? { nueva: true, label: "Escribe para añadir una inversión nueva" }
                  : null,
            ...filtradas.map((row) => ({ row }))
        ].filter(Boolean)

        if (!menu) {
            menu = document.createElement("div")
            menu.className = "csMenu csBodyMenu csOpen pmComboMenu"
            menu.style.zIndex = "100000"
            document.body.appendChild(menu)
        }
        menu.innerHTML = ""
        opciones.forEach((opcion, i) => {
            const item = document.createElement("div")
            item.className = `csOption${opcion.nueva ? " pmComboNueva" : ""}`
            if (opcion.nueva) {
                item.textContent = opcion.label
            } else {
                const tipo = _PM_TIPO_LABELS[opcion.row.tipo] || opcion.row.tipo || ""
                const detalle = [tipo, opcion.row.gestor, opcion.row.currency].filter(Boolean).join(" · ")
                item.innerHTML = `<span>${escapeHtml(opcion.row.nombre)}</span><span class="pmComboDetalle">${escapeHtml(detalle)}</span>`
            }
            // mousedown y no click: con click el input pierde el foco antes y
            // el blur cierra el menú sin que la opción llegue a elegirse.
            item.addEventListener("mousedown", (event) => {
                event.preventDefault()
                elegir(i)
            })
            menu.appendChild(item)
        })
        wrap.classList.add("pmComboOpen")
        input.setAttribute("aria-expanded", "true")
        posicionar()
    }

    const elegir = (indice) => {
        const opcion = opciones[indice]
        if (!opcion) return
        if (opcion.nueva) {
            // Inversión nueva: se queda lo tecleado y se sigue escribiendo.
            cerrar()
            input.focus()
            return
        }
        rellenarDesde(opcion.row)
        cerrar()
    }

    input.addEventListener("focus", abrir)
    input.addEventListener("input", abrir)
    input.addEventListener("blur", cerrar)
    arrow.addEventListener("mousedown", (event) => {
        // Sin preventDefault el botón se lleva el foco y el blur cierra el menú.
        event.preventDefault()
        if (menu) {
            cerrar()
            return
        }
        if (document.activeElement === input) abrir()
        else input.focus()
    })
    input.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault()
            if (!menu) abrir()
            marcarActiva(activa + (event.key === "ArrowDown" ? 1 : -1))
        } else if (event.key === "Enter" && menu && activa >= 0) {
            event.preventDefault()
            elegir(activa)
        } else if (event.key === "Escape" && menu) {
            // Que el Escape cierre solo el menú y no el popup entero.
            event.stopPropagation()
            cerrar()
        }
    })
}

function _pmOpenEditModal(rowIndex = -1, plantilla = null) {
    const isEdit = rowIndex >= 0
    const rowData = isEdit ? _pmRows[rowIndex] : plantilla || {}
    const modalTitle = isEdit
        ? "Editar inversión"
        : plantilla
          ? `Añadir compra a ${plantilla.nombre || "la inversión"}`
          : "Nueva inversión"

    const overlay = document.createElement("div")
    overlay.className = "modalOverlay"
    overlay.style.zIndex = "20000"

    const currencyOptions = Object.entries(_pmGetCurrencySymbols())
        .map(
            ([code, label]) =>
                `<option value="${code}"${(rowData.currency || "EUR") === code ? " selected" : ""}>${label}</option>`
        )
        .join("")

    const tipoOptions = Object.entries(_PM_TIPO_LABELS)
        .map(
            ([val, label]) =>
                `<option value="${val}"${(rowData.tipo || "pe") === val ? " selected" : ""}>${label}</option>`
        )
        .join("")

    const modal = document.createElement("div")
    modal.className = "assetModal"
    modal.innerHTML = `
        <h3 class="assetModalTitle">${escapeHtml(modalTitle)}</h3>

        <label class="assetModalLabel" for="pmFechaInput">Fecha de entrada</label>
        <input id="pmFechaInput" class="assetModalInput" type="text" value="${escapeHtml(rowData.fecha)}" placeholder="dd-mm-aaaa">

        <label class="assetModalLabel" for="pmTipoSelect">Tipo</label>
        <select id="pmTipoSelect" class="assetModalSelect">${tipoOptions}</select>

        <label class="assetModalLabel" for="pmNombreInput">Nombre del fondo / inversión</label>
        <input id="pmNombreInput" class="assetModalInput" type="text" value="${escapeHtml(rowData.nombre)}" placeholder="Ej: Carlyle Partners VII">

        <label class="assetModalLabel" for="pmGestorInput">Gestor / GP</label>
        <input id="pmGestorInput" class="assetModalInput" type="text" value="${escapeHtml(rowData.gestor)}" placeholder="Ej: The Carlyle Group">

        <label class="assetModalLabel" for="pmVintageInput">Vintage (año)</label>
        <input id="pmVintageInput" class="assetModalInput" type="text" value="${escapeHtml(rowData.vintage)}" placeholder="Ej: 2023">

        <label class="assetModalLabel" for="pmCurrencySelect">Moneda</label>
        <select id="pmCurrencySelect" class="assetModalSelect">${currencyOptions}</select>

        <label class="assetModalLabel" for="pmComprometidoInput">Capital comprometido</label>
        <input id="pmComprometidoInput" class="assetModalInput" type="text" inputmode="decimal" value="${rowData.comprometido ? formatCellEuroValue(rowData.comprometido) : ""}" placeholder="0,00">

        <label class="assetModalLabel" for="pmLlamadoInput">Capital llamado (invertido)</label>
        <input id="pmLlamadoInput" class="assetModalInput" type="text" inputmode="decimal" value="${rowData.llamado ? formatCellEuroValue(rowData.llamado) : ""}" placeholder="0,00">

        <label class="assetModalLabel" for="pmDistribuidoInput">Distribuido (retornado)</label>
        <input id="pmDistribuidoInput" class="assetModalInput" type="text" inputmode="decimal" value="${rowData.distribuido ? formatCellEuroValue(rowData.distribuido) : ""}" placeholder="0,00">

        <label class="assetModalLabel" for="pmValorActualInput">Valor actual (NAV)</label>
        <input id="pmValorActualInput" class="assetModalInput" type="text" inputmode="decimal" value="${rowData.valorActual ? formatCellEuroValue(rowData.valorActual) : ""}" placeholder="0,00">

        <label class="assetModalLabel" for="pmNotaInput">Nota</label>
        <input id="pmNotaInput" class="assetModalInput" type="text" value="${escapeHtml(rowData.nota)}" placeholder="Opcional">

        <div class="assetModalActions">
            <button type="button" id="pmModalCancelBtn" class="cancelButton">Cancelar</button>
            <button type="button" id="pmModalSaveBtn" class="primaryButton" data-no-autohide="true">Guardar</button>
        </div>
    `

    const closeModal = () => overlay.remove()
    modal.querySelector("#pmModalCancelBtn").addEventListener("click", closeModal)
    modal.querySelector("#pmModalSaveBtn").addEventListener("click", async () => {
        const fecha = modal.querySelector("#pmFechaInput").value.trim()
        const tipo = modal.querySelector("#pmTipoSelect").value
        const nombre = modal.querySelector("#pmNombreInput").value.trim()
        const gestor = modal.querySelector("#pmGestorInput").value.trim()
        const vintage = modal.querySelector("#pmVintageInput").value.trim()
        const currency = modal.querySelector("#pmCurrencySelect").value
        const comprometidoRaw = modal.querySelector("#pmComprometidoInput").value.trim()
        const llamadoRaw = modal.querySelector("#pmLlamadoInput").value.trim()
        const distribuidoRaw = modal.querySelector("#pmDistribuidoInput").value.trim()
        const valorActualRaw = modal.querySelector("#pmValorActualInput").value.trim()
        const nota = modal.querySelector("#pmNotaInput").value.trim()

        const comprometido = comprometidoRaw ? formatCellEuroValue(comprometidoRaw) : ""
        const llamado = llamadoRaw ? formatCellEuroValue(llamadoRaw) : ""
        const distribuido = distribuidoRaw ? formatCellEuroValue(distribuidoRaw) : ""
        const valorActual = valorActualRaw ? formatCellEuroValue(valorActualRaw) : ""

        const newRow = {
            fecha,
            tipo,
            nombre,
            gestor,
            vintage,
            currency,
            comprometido,
            llamado,
            distribuido,
            valorActual,
            nota
        }

        if (isEdit) {
            _pmRows[rowIndex] = newRow
        } else {
            _pmRows.push(newRow)
        }

        // La compra recién añadida, a la vista: si va a un grupo, se despliega.
        if (plantilla) _pmDesplegados.add(_pmClaveGrupo(newRow, _pmRows.length - 1))

        _pmRender()
        await savePrivateMarketData()
        closeModal()
    })

    ponerModalEnDosColumnas(modal)
    _pmBindNombreCombo(modal)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
}

async function initPrivateMarketLogic() {
    _pmCurrentFilter = "all"
    _pmBindSearch()
    _pmBindSort()

    const data = await loadPrivateMarketData()
    renderPrivateMarketTable(data)

    document.getElementById("pmAddBtn")?.addEventListener("click", () => _pmOpenEditModal())

    document.getElementById("savePmBtn")?.addEventListener("click", async () => {
        try {
            await savePrivateMarketData()
        } catch (err) {
            console.error(err)
        }
    })

    const filtersEl = document.getElementById("pmFilters")
    if (filtersEl) {
        const todosInput = filtersEl.querySelector('[data-tipo="all"] input')
        const getIndividuals = () => [...filtersEl.querySelectorAll('.pmFilterBtn:not([data-tipo="all"]) input')]
        const syncAndApply = () => {
            if (todosInput?.checked) {
                _pmApplyFilter("all")
            } else {
                const sel = getIndividuals()
                    .filter((cb) => cb.checked)
                    .map((cb) => cb.closest(".pmFilterBtn").dataset.tipo)
                if (!sel.length && todosInput) todosInput.checked = true
                _pmApplyFilter(sel.length ? sel : "all")
            }
        }
        if (todosInput) todosInput.checked = true
        getIndividuals().forEach((cb) => {
            cb.checked = true
        })
        if (!filtersEl.dataset.bound) {
            filtersEl.dataset.bound = "true"
            filtersEl.addEventListener("change", (e) => {
                const changed = e.target
                if (changed === todosInput) {
                    changed.checked = true
                    getIndividuals().forEach((cb) => {
                        cb.checked = true
                    })
                } else if (todosInput?.checked) {
                    todosInput.checked = false
                    getIndividuals().forEach((cb) => {
                        cb.checked = cb === changed
                    })
                    changed.checked = true
                } else {
                    if (todosInput) todosInput.checked = getIndividuals().every((cb) => cb.checked)
                }
                syncAndApply()
            })
        }
    }
}
