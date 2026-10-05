// ===== CUENTAS =====
// Dónde está el dinero: la cuenta bancaria de Gastos e Ingresos, las cuentas de
// ahorro, los exchanges, los brokers… Mover dinero de una a otra es una
// transferencia, no un gasto ni un ingreso, y por eso vive aquí y no en Gastos.
// Los prefijos «cnt» evitan chocar con los nombres de las demás páginas, que
// comparten el ámbito global.

let cntYear = ""
let cntYears = []
let cntCuentas = []
let cntTransferencias = []
let cntTipos = []
let cntFiltro = ""
const cntSort = { key: "fecha", dir: "desc" }

async function initCuentasLogic() {
    try {
        await cntRecargar()

        const thisYear = String(new Date().getFullYear())
        cntYears = [...new Set([thisYear, ...cntTransferencias.map((t) => t.year).filter(Boolean)])].sort()
        // «» es «todos los años»: con pocas transferencias es lo más cómodo.
        if (cntYear !== "" && !cntYears.includes(cntYear)) cntYear = thisYear
        cntFiltro = ""

        cntBind()
        cntRender()
    } catch (error) {
        console.error("Error inicializando las cuentas:", error)
        showError("No se pudieron cargar las cuentas", error)
    }
}

async function cntRecargar() {
    const [cuentas, transferencias] = await Promise.all([Api.get("/api/cuentas"), Api.get("/api/transferencias")])
    cntCuentas = Array.isArray(cuentas?.cuentas) ? cuentas.cuentas : []
    cntTipos = Array.isArray(cuentas?.tipos) ? cuentas.tipos : []
    cntTransferencias = Array.isArray(transferencias?.transferencias) ? transferencias.transferencias : []
    // Los desplegables de Gastos e Ingresos leen esta misma lista.
    window._cuentasDinero = cntCuentas
}

function cntNombre(id) {
    return cntCuentas.find((c) => c.id === id)?.nombre || id
}

function cntRender() {
    cntRenderYears()
    cntRenderCuentas()
    cntRenderTabla()
}

// ── Cuentas ──────────────────────────────────────────────────────────────

function cntSigned(valor) {
    return (valor > 0 ? "+" : "") + formatEuro(valor)
}

function cntRenderCuentas() {
    const lista = document.getElementById("cuentasLista")
    const total = document.getElementById("cuentasTotal")
    if (!lista) return

    const suma = cntCuentas.reduce((acc, c) => acc + parseEuroNumber(c.saldo), 0)
    if (total) total.textContent = formatEuro(suma)

    lista.innerHTML = cntCuentas
        .map((c) => {
            const saldo = parseEuroNumber(c.saldo)
            const entradas = parseEuroNumber(c.entradas)
            const salidas = parseEuroNumber(c.salidas)
            const inicial = parseEuroNumber(c.saldo_inicial)
            const activa = c.id === cntFiltro
            return `
                <div class="cntCuenta${activa ? " activa" : ""}" data-cuenta="${escapeGastosHtml(c.id)}" title="Ver solo los movimientos de esta cuenta">
                    <div class="cntCuentaCab">
                        <span class="cntCuentaNombre">${escapeGastosHtml(c.nombre)}</span>
                        <span class="cntTipo cntTipo-${escapeGastosHtml(c.tipo)}">${escapeGastosHtml(c.tipo_etiqueta || c.tipo)}</span>
                        <div class="rowMenu">
                            <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                            <div class="rowMenuDropdown">
                                <button type="button" class="rowMenuItem" data-cnt-editar-cuenta>Editar</button>
                                ${c.tipo === "ahorro" ? '<button type="button" class="rowMenuItem" data-cnt-abrir-ahorro>Abrir cuenta de ahorro</button>' : ""}
                                ${c.protegida ? "" : '<hr><button type="button" class="rowMenuItem rowMenuItemDanger" data-cnt-eliminar-cuenta>Eliminar</button>'}
                            </div>
                        </div>
                    </div>
                    <div class="cntCuentaSaldo ${saldo < 0 ? "cuentasNeg" : ""}">${formatEuro(saldo)}</div>
                    <div class="cntCuentaDetalle">
                        <span class="cuentasPos">${cntSigned(entradas)}</span>
                        <span class="cuentasNeg">${formatEuro(-salidas)}</span>
                        ${inicial ? `<span>Saldo inicial ${formatEuro(inicial)}</span>` : ""}
                    </div>
                </div>`
        })
        .join("")
}

function cntTipoOptions(actual = "exchange") {
    return cntTipos
        .map(
            (t) =>
                `<option value="${escapeGastosHtml(t.id)}"${t.id === actual ? " selected" : ""}>${escapeGastosHtml(t.nombre)}</option>`
        )
        .join("")
}

// Sin `cuenta` crea una; con ella, edita el nombre y el saldo inicial (el tipo
// no se cambia: una cuenta de ahorro que pasara a exchange saldría de su ventana).
function cntAbrirModalCuenta(cuenta = null) {
    openGastosCreateModal({
        title: cuenta ? "Editar cuenta" : "Nueva cuenta",
        bodyHtml: `
            <label class="assetModalLabel" for="cntCuentaNombre">Nombre</label>
            <input id="cntCuentaNombre" class="assetModalInput" type="text" maxlength="60" value="${escapeGastosHtml(cuenta?.nombre || "")}" placeholder="Ej: Binance, Degiro, Cuenta nómina">

            <label class="assetModalLabel" for="cntCuentaTipo">Tipo</label>
            <select id="cntCuentaTipo" class="assetModalSelect"${cuenta ? " disabled" : ""}>${cntTipoOptions(cuenta?.tipo || "exchange")}</select>

            <label class="assetModalLabel" for="cntCuentaSaldo">Saldo inicial <span class="assetModalLabelHint">opcional</span></label>
            <input id="cntCuentaSaldo" class="assetModalInput" type="text" inputmode="decimal" value="${escapeGastosHtml(cuenta ? cntSaldoInicialTexto(cuenta) : "")}" placeholder="0,00">
            <p class="cuentasHint">Lo que ya había en la cuenta antes de empezar a apuntar movimientos. Las cuentas de ahorro aparecen también en la ventana Cuenta de ahorro.</p>
        `,
        submitLabel: "Guardar",
        onSubmit: async ({ getValue, setFeedback }) => {
            const cuerpo = {
                nombre: getValue("cntCuentaNombre").trim(),
                saldoInicial: getValue("cntCuentaSaldo").trim()
            }
            try {
                if (cuenta) await Api.put(`/api/cuentas/${encodeURIComponent(cuenta.id)}`, cuerpo)
                else await Api.post("/api/cuentas", { ...cuerpo, tipo: getValue("cntCuentaTipo") })
                await cntRecargar()
                cntRender()
                return true
            } catch (error) {
                setFeedback(error?.message || "No se pudo guardar la cuenta.", true)
                return false
            }
        }
    })
}

function cntSaldoInicialTexto(cuenta) {
    return String(cuenta.saldo_inicial || "")
        .replace(".", ",")
        .replace(/,00$/, "")
}

function cntEliminarCuenta(cuenta) {
    openConfirmModal({
        title: "Eliminar cuenta",
        message: `Vas a eliminar la cuenta «${cuenta.nombre}». Solo se puede si no tiene movimientos.`,
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            try {
                await Api.del(`/api/cuentas/${encodeURIComponent(cuenta.id)}`)
                if (cntFiltro === cuenta.id) cntFiltro = ""
            } catch (error) {
                showError("No se pudo eliminar la cuenta", error)
            }
            await cntRecargar()
            cntRender()
        }
    })
}

// ── Transferencias ───────────────────────────────────────────────────────

function cntRenderYears() {
    const list = document.getElementById("cuentasYearList")
    if (!list) return
    list.innerHTML = ""
    ;[["", "Todos"], ...cntYears.map((y) => [y, y])].forEach(([valor, etiqueta]) => {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = `gastosYearBtn${valor === cntYear ? " active" : ""}`
        btn.textContent = etiqueta
        btn.addEventListener("click", () => {
            cntYear = valor
            cntRender()
        })
        list.appendChild(btn)
    })
}

function cntFechaClave(fecha) {
    const p = splitDividendoFecha(fecha)
    return p ? new Date(Number(p.anio), Number(p.mes) - 1, Number(p.dia) || 1).getTime() : 0
}

function cntTransferenciasVisibles() {
    return cntTransferencias.filter(
        (t) => (!cntYear || t.year === cntYear) && (!cntFiltro || t.origen === cntFiltro || t.destino === cntFiltro)
    )
}

function cntHead() {
    const columnas = [
        ["fecha", "Fecha"],
        ["origen", "Origen"],
        ["destino", "Destino"],
        ["concepto", "Concepto"],
        ["cantidad", "Cantidad", true]
    ]
    const celdas = columnas
        .map(([key, label, num]) => {
            const activa = cntSort.key === key
            const flecha = activa ? (cntSort.dir === "asc" ? "▲" : "▼") : ""
            return `<th class="mThSort${activa ? " mThActive" : ""}${num ? " numCol" : ""}" data-cnt-sort="${key}" title="Ordenar por ${label.toLowerCase()}">${label}<span class="mSortArrow">${flecha}</span></th>`
        })
        .join("")
    return `<tr>${celdas}<th class="rowActionHeader"></th></tr>`
}

function cntRenderTabla() {
    const head = document.getElementById("cuentasHead")
    const body = document.getElementById("cuentasBody")
    const empty = document.getElementById("cuentasEmpty")
    if (!head || !body || !empty) return

    head.innerHTML = cntHead()

    const valores = {
        fecha: (t) => cntFechaClave(t.fecha),
        origen: (t) => t.origen_nombre || "",
        destino: (t) => t.destino_nombre || "",
        concepto: (t) => t.concepto || "",
        cantidad: (t) => parseEuroNumber(t.cantidad)
    }
    const signo = cntSort.dir === "asc" ? 1 : -1
    const filas = [...cntTransferenciasVisibles()].sort((a, b) => {
        const x = valores[cntSort.key](a)
        const y = valores[cntSort.key](b)
        const cmp = typeof x === "string" ? x.localeCompare(y, "es", { sensitivity: "base" }) : x - y
        return cmp * signo || cntFechaClave(b.fecha) - cntFechaClave(a.fecha) || b.id - a.id
    })

    body.innerHTML = filas
        .map(
            (t) => `
                <tr class="movDetailRow" data-id="${t.id}">
                    <td>${escapeGastosHtml(t.fecha)}</td>
                    <td>${escapeGastosHtml(t.origen_nombre)}</td>
                    <td>${escapeGastosHtml(t.destino_nombre)}</td>
                    <td title="${escapeGastosHtml(t.nota)}">${t.concepto ? escapeGastosHtml(t.concepto) : '<span class="cuentasSinConcepto">Sin concepto</span>'}</td>
                    <td class="numCell">${formatEuro(parseEuroNumber(t.cantidad))}</td>
                    <td class="rowActionsCell">
                        <div class="rowMenu">
                            <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                            <div class="rowMenuDropdown">
                                <button type="button" class="rowMenuItem" data-cnt-editar>Editar</button>
                                <hr>
                                <button type="button" class="rowMenuItem rowMenuItemDanger" data-cnt-eliminar>Eliminar</button>
                            </div>
                        </div>
                    </td>
                </tr>`
        )
        .join("")

    empty.textContent = cntFiltro
        ? "No hay transferencias con esta cuenta en el periodo."
        : cntYear
          ? `No hay transferencias en ${cntYear}.`
          : "Todavía no hay transferencias."
    empty.classList.toggle("hidden", filas.length > 0)
    empty.closest(".cuentasTableWrapper")?.classList.toggle("cuentasVacio", filas.length === 0)

    const filtro = document.getElementById("cuentasFiltro")
    if (filtro) {
        filtro.hidden = !cntFiltro
        const nombre = document.getElementById("cuentasFiltroNombre")
        if (nombre) nombre.textContent = cntNombre(cntFiltro)
    }
}

function cntOpcionesCuenta(seleccionada) {
    return cntCuentas
        .map(
            (c) =>
                `<option value="${escapeGastosHtml(c.id)}"${c.id === seleccionada ? " selected" : ""}>${escapeGastosHtml(c.nombre)} (${escapeGastosHtml(c.tipo_etiqueta || c.tipo)})</option>`
        )
        .join("")
}

// Con `transferencia`, edita esa; sin ella, crea una nueva.
function cntAbrirModalTransferencia(transferencia = null) {
    const origen = transferencia?.origen || cntFiltro || "banco"
    const destino = transferencia?.destino || cntCuentas.find((c) => c.id !== origen)?.id || "ahorro"

    openGastosCreateModal({
        title: transferencia ? "Editar transferencia" : "Nueva transferencia",
        bodyHtml: `
            <label class="assetModalLabel" for="cntTransOrigen">De la cuenta</label>
            <select id="cntTransOrigen" class="assetModalSelect">${cntOpcionesCuenta(origen)}</select>

            <label class="assetModalLabel" for="cntTransDestino">A la cuenta</label>
            <select id="cntTransDestino" class="assetModalSelect">${cntOpcionesCuenta(destino)}</select>

            <label class="assetModalLabel" for="cntTransFecha">Fecha</label>
            <input id="cntTransFecha" class="assetModalInput" type="text" value="${escapeGastosHtml(transferencia?.fecha || todayDateString())}" placeholder="dd-mm-aaaa">

            <label class="assetModalLabel" for="cntTransCantidad">Cantidad</label>
            <input id="cntTransCantidad" class="assetModalInput" type="text" inputmode="decimal" value="${escapeGastosHtml(transferencia?.cantidad || "")}" placeholder="0,00">

            <label class="assetModalLabel" for="cntTransConcepto">Concepto <span class="assetModalLabelHint">opcional</span></label>
            <input id="cntTransConcepto" class="assetModalInput" type="text" maxlength="120" value="${escapeGastosHtml(transferencia?.concepto || "")}" placeholder="Ej: Compra de cripto">

            <label class="assetModalLabel" for="cntTransNota">Nota <span class="assetModalLabelHint">opcional</span></label>
            <textarea id="cntTransNota" class="assetModalInput movNotaInput" rows="2" maxlength="300">${escapeGastosHtml(transferencia?.nota || "")}</textarea>
            <p class="cuentasHint">Mover dinero entre tus cuentas no es un gasto ni un ingreso: no cuenta en Gastos, Ingresos ni en la tasa de ahorro.</p>
        `,
        submitLabel: "Guardar",
        onSubmit: async ({ getValue, setFeedback }) => {
            const cuerpo = {
                origen: getValue("cntTransOrigen"),
                destino: getValue("cntTransDestino"),
                fecha: getValue("cntTransFecha").trim(),
                cantidad: getValue("cntTransCantidad").trim(),
                concepto: getValue("cntTransConcepto").trim(),
                nota: getValue("cntTransNota").trim()
            }
            try {
                const res = transferencia
                    ? await Api.put(`/api/transferencias/${transferencia.id}`, cuerpo)
                    : await Api.post("/api/transferencias", cuerpo)
                await cntRecargar()
                const year = res?.transferencia?.year
                if (year && !cntYears.includes(year)) cntYears = [...cntYears, year].sort()
                // Se enseña lo que acaba de guardarse, aunque fuera de otro año.
                if (year && cntYear && cntYear !== year) cntYear = year
                cntRender()
                return true
            } catch (error) {
                setFeedback(error?.message || "No se pudo guardar la transferencia.", true)
                return false
            }
        }
    })
}

function cntEliminarTransferencia(transferencia) {
    openConfirmModal({
        title: "Eliminar transferencia",
        message: "El dinero vuelve a su cuenta de origen. No se puede deshacer.",
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            try {
                await Api.del(`/api/transferencias/${transferencia.id}`)
            } catch (error) {
                showError("No se pudo eliminar la transferencia", error)
            }
            await cntRecargar()
            cntRender()
        }
    })
}

function cntDescargarCsv() {
    const filas = cntTransferenciasVisibles().map((t) => ({
        Fecha: t.fecha,
        Origen: t.origen_nombre,
        Destino: t.destino_nombre,
        Concepto: t.concepto,
        Cantidad: parseEuroNumber(t.cantidad),
        Nota: t.nota || ""
    }))
    downloadCsvFile(`transferencias${cntYear ? "-" + cntYear : ""}.csv`, filas)
}

function cntBind() {
    const trigger = document.querySelector("#cuentasActionsMenu .pageActionsMenuTrigger")
    const menu = document.getElementById("cuentasActionsDropdown")
    if (trigger && menu) {
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

    const on = (id, handler) => document.getElementById(id)?.addEventListener("click", handler)
    on("cuentasNuevaTransferenciaBtn", () => cntAbrirModalTransferencia())
    on("cuentasAddRowBtn", () => cntAbrirModalTransferencia())
    on("cuentasNuevaCuentaBtn", () => cntAbrirModalCuenta())
    on("cuentasCsvBtn", cntDescargarCsv)
    on("cuentasFiltroQuitar", () => {
        cntFiltro = ""
        cntRender()
    })

    document.getElementById("cuentasHead")?.addEventListener("click", (event) => {
        const th = event.target.closest("[data-cnt-sort]")
        if (!th) return
        const key = th.dataset.cntSort
        if (cntSort.key === key) cntSort.dir = cntSort.dir === "asc" ? "desc" : "asc"
        else {
            cntSort.key = key
            cntSort.dir = key === "fecha" || key === "cantidad" ? "desc" : "asc"
        }
        cntRenderTabla()
    })

    document.getElementById("cuentasBody")?.addEventListener("click", (event) => {
        const fila = event.target.closest("tr")
        const transferencia = fila && cntTransferencias.find((t) => String(t.id) === fila.dataset.id)
        if (!transferencia) return
        if (event.target.closest("[data-cnt-editar]")) cntAbrirModalTransferencia(transferencia)
        else if (event.target.closest("[data-cnt-eliminar]")) cntEliminarTransferencia(transferencia)
    })

    document.getElementById("cuentasLista")?.addEventListener("click", (event) => {
        const tarjeta = event.target.closest("[data-cuenta]")
        const cuenta = tarjeta && cntCuentas.find((c) => c.id === tarjeta.dataset.cuenta)
        if (!cuenta) return
        if (event.target.closest("[data-cnt-editar-cuenta]")) return cntAbrirModalCuenta(cuenta)
        if (event.target.closest("[data-cnt-eliminar-cuenta]")) return cntEliminarCuenta(cuenta)
        if (event.target.closest("[data-cnt-abrir-ahorro]")) {
            document.querySelector('[data-page="cuentaAhorro"]')?.click()
            return
        }
        // Pulsar la tarjeta (fuera de su menú) filtra la tabla por esa cuenta.
        if (event.target.closest(".rowMenu")) return
        cntFiltro = cntFiltro === cuenta.id ? "" : cuenta.id
        cntRender()
    })
}
