// Cómo se lee un importe escrito como texto. Es el mismo criterio que aplica el
// servidor en `python/core/dinero.py` (`aDecimal`), y tests-js/shared-utils
// comprueba las dos mitades contra la misma tabla de entradas
// (tests-js/importes-casos.json, que pytest también recorre):
//
//   * Un punto es SIEMPRE el separador decimal: "1.234" son mil doscientos
//     treinta y cuatro milésimas, no mil doscientos treinta y cuatro. Antes el
//     navegador lo leía como miles y el servidor como decimal, así que "0.001"
//     BTC se veía como 1 BTC en pantalla y valía 0,001 en todos los cálculos
//     del servidor.
//   * Si hay coma, la coma es el decimal y los puntos son de miles
//     ("1.234,56"). Es el formato español en el que están guardados los
//     importes antiguos.
//   * Con coma y punto a la vez, el que va el último es el decimal: "1,234.56"
//     (lo que escribe o pinta un locale en-US) también se lee bien. Eso solo
//     lo hace el navegador; el servidor recibe el importe ya en canónico (ver
//     `toCanonicalNumber`).
//   * Un número con más de un separador decimal ("1.234.567", "1,2,3") es
//     ilegible: no se adivina.
//
// El espacio de miles (NBSP, U+202F) y los símbolos de divisa se descartan
// antes de mirar nada.
const SIMBOLOS_IMPORTE = /[€$£¥₿¢₽₩₹%]|(?:EUR|USD|GBP|CHF|JPY|CAD|AUD|BTC|ETH|SATS?)/gi
const NUMERO_CANONICO = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/

// Cuentas de dinero: la bancaria (la de Gastos e Ingresos, y la de siempre), las
// de ahorro, los exchanges, los brokers… Gastos e Ingresos las piden para elegir
// con qué cuenta se paga un gasto o en cuál se cobra un ingreso; la bancaria es
// la de por defecto y en las filas se guarda como el vacío.
window._cuentasDinero = window._cuentasDinero || []

async function cargarCuentasDinero() {
    try {
        const datos = await Api.get("/api/cuentas")
        window._cuentasDinero = Array.isArray(datos?.cuentas) ? datos.cuentas : []
    } catch (error) {
        // Sin la lista el popup sigue funcionando con la cuenta bancaria.
        console.error("No se pudieron cargar las cuentas:", error)
    }
    return window._cuentasDinero
}

// La cuenta bancaria se puede renombrar: su nombre sale de la lista, no está escrito aquí.
function nombreDeCuentaBancaria() {
    return window._cuentasDinero.find((cuenta) => cuenta.id === "banco")?.nombre || "Cuenta bancaria"
}

function nombreDeCuenta(id) {
    if (!id) return nombreDeCuentaBancaria()
    return window._cuentasDinero.find((cuenta) => cuenta.id === id)?.nombre || id
}

// Selector «Cuenta» de los popups: la bancaria primero y vacía, después las demás.
function construirSelectorCuenta(selectId, actual = "") {
    const esc = escapeHtml
    const opciones = window._cuentasDinero
        .filter((cuenta) => cuenta.id !== "banco")
        .map((cuenta) => {
            const etiqueta = `${cuenta.nombre} (${cuenta.tipo_etiqueta || cuenta.tipo})`
            return `<option value="${esc(cuenta.id)}"${cuenta.id === actual ? " selected" : ""}>${esc(etiqueta)}</option>`
        })
        .join("")
    return `<select id="${selectId}" class="assetModalSelect"><option value=""${actual ? "" : " selected"}>${esc(nombreDeCuentaBancaria())}</option>${opciones}</select>`
}

// Texto con un único separador decimal (".") listo para Number(), o con más de
// uno si el original era ilegible: quien lo usa lo descarta con `tieneUnSoloPunto`.
function normalizeDecimalSeparators(text) {
    const ultimaComa = text.lastIndexOf(",")
    if (ultimaComa === -1) {
        return text
    }
    if (ultimaComa > text.lastIndexOf(".")) {
        return text.replaceAll(".", "").replaceAll(",", ".")
    }
    return text.replaceAll(",", "")
}

function tieneUnSoloPunto(text) {
    return text.split(".").length <= 2
}

function parseEuroNumber(value) {
    if (!value) {
        return 0
    }

    const cleanValue = normalizeDecimalSeparators(value.toString().replaceAll("€", "").replaceAll(/\s/g, ""))
    if (!tieneUnSoloPunto(cleanValue)) {
        return 0
    }

    const parsedValue = parseFloat(cleanValue)
    return Number.isNaN(parsedValue) ? 0 : parsedValue
}

function parseDollarNumber(value) {
    if (!value) {
        return 0
    }

    const cleanValue = normalizeDecimalSeparators(value.toString().replaceAll("$", "").replaceAll(/\s/g, ""))
    if (!tieneUnSoloPunto(cleanValue)) {
        return 0
    }

    const parsedValue = parseFloat(cleanValue)
    return Number.isNaN(parsedValue) ? 0 : parsedValue
}

// Espejo estricto de `dinero.aDecimal`: el importe como texto canónico (punto
// decimal, sin miles ni símbolos) o null si no se puede leer. A diferencia de
// parseEuroNumber, que perdona ("12abc" da 12) porque sus llamadores acumulan
// el resultado, esta no adivina: un importe ilegible tiene que verse.
function parseDecimalStrict(value) {
    if (value === null || value === undefined) {
        return null
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? String(value) : null
    }
    const texto = String(value).replaceAll(/\s/g, "").replaceAll(SIMBOLOS_IMPORTE, "")
    if (!texto) {
        return null
    }
    const limpio = normalizeDecimalSeparators(texto)
    return NUMERO_CANONICO.test(limpio) ? limpio : null
}

// Separador decimal del locale activo ("," en es-ES y fr-FR, "." en en-US).
function separadorDecimalDelLocale() {
    try {
        const partes = new Intl.NumberFormat(_nl()).formatToParts(1.1)
        return partes.find((parte) => parte.type === "decimal")?.value || ","
    } catch {
        return ","
    }
}

// Lo que el navegador manda al servidor al guardar un importe tecleado: formato
// canónico (punto decimal, sin separador de miles ni símbolos). El servidor lo
// lee con `dinero.aDecimal`, que no sabe de locales: "1,234.56" tecleado en
// en-US se leería allí como 1,23456. Con el locale activo en punto decimal, la
// coma seguida de grupos de tres cifras ("1,234") es separador de miles.
// Lo que no se entiende se devuelve tal cual (recortado) para que lo valide el
// servidor y no se pierda lo tecleado.
function toCanonicalNumber(value) {
    const original = String(value ?? "").trim()
    if (!original) {
        return ""
    }
    let texto = original.replaceAll(/\s/g, "").replaceAll(SIMBOLOS_IMPORTE, "")
    if (separadorDecimalDelLocale() === "." && /^[+-]?\d{1,3}(,\d{3})+(\.\d*)?$/.test(texto)) {
        texto = texto.replaceAll(",", "")
    }
    const canonico = parseDecimalStrict(texto)
    return canonico === null ? original : canonico.replace(/^\+/, "")
}

function _nl() {
    return window._numLocale || "es-ES"
}

function formatEuro(value) {
    return (
        new Intl.NumberFormat(_nl(), {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(value) + " €"
    )
}

function normalizeCurrencyCode(currency) {
    const normalized = String(currency || "EUR")
        .trim()
        .toUpperCase()

    if (!normalized) {
        return "EUR"
    }

    if (
        ["USD", "USDT", "USDC", "BUSD", "DAI", "FDUSD", "PYUSD", "TUSD", "USDE"].includes(normalized) ||
        normalized.endsWith("USD")
    ) {
        return "USD"
    }

    if (["EUR", "EURC"].includes(normalized) || normalized.endsWith("EUR")) {
        return "EUR"
    }

    return normalized || "EUR"
}

// Sufijo con el que se muestra cada divisa. Fuera de `formatMoneyWithDecimals`
// para que cualquier formateador con sus propias reglas de decimales pueda
// usarlo sin copiar el mapa: el mapa de calor tiene las suyas (0, 2 o 4
// decimales según la magnitud) y estaba enseñando los precios sin divisa.
const SUFIJO_DIVISA = {
    EUR: "€",
    USD: "$",
    GBP: "GBP",
    CHF: "CHF",
    JPY: "JPY",
    SEK: "SEK"
}

function currencySuffix(currency) {
    const normalized = normalizeCurrencyCode(currency)
    return SUFIJO_DIVISA[normalized] || normalized
}

// Luminancia relativa (WCAG) de un color [r, g, b] en 0-255.
function _luminanciaColor(rgb) {
    const [r, g, b] = rgb.map((canal) => {
        const c = canal / 255
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// Devuelve un color que se lea sobre el fondo del tema actual a partir del que
// eligió el usuario (p. ej. el de un activo). Si es demasiado oscuro para un tema
// oscuro, o demasiado claro para el claro, lo acerca al blanco o al negro lo
// justo para llegar al mínimo; los que ya se leen bien salen tal cual. Siempre
// devuelve #rrggbb, así que se le puede añadir un sufijo de opacidad ("22").
function colorLegibleEnTema(color) {
    const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || "").trim())
    if (!match) return color

    const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1]
    const original = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
    const temaClaro = document.documentElement.getAttribute("data-theme") === "light"
    // Por debajo de 0,15 de luminancia un color se pierde en el fondo oscuro, y
    // por encima de 0,45 en el claro. Si hay que corregirlo, no basta con
    // dejarlo en el límite (se seguía viendo apagado): se lleva hasta 0,3 y 0,35,
    // con margen. Los colores que ya se leen no se tocan.
    const luminancia = _luminanciaColor(original)
    if (temaClaro ? luminancia <= 0.45 : luminancia >= 0.15) return `#${hex.toLowerCase()}`
    const suficiente = (rgb) => (temaClaro ? _luminanciaColor(rgb) <= 0.35 : _luminanciaColor(rgb) >= 0.3)
    const destino = temaClaro ? 0 : 255

    let ajustado = original
    for (let mezcla = 0.05; !suficiente(ajustado) && mezcla <= 1; mezcla += 0.05) {
        ajustado = original.map((canal) => Math.round(canal + (destino - canal) * mezcla))
    }

    return `#${ajustado.map((canal) => canal.toString(16).padStart(2, "0")).join("")}`
}

function formatMoneyWithDecimals(value, currency = "EUR", decimals = 2) {
    const formattedNumber = new Intl.NumberFormat(_nl(), {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    }).format(value)

    return `${formattedNumber} ${currencySuffix(currency)}`
}

function formatMoney(value, currency = "EUR") {
    return formatMoneyWithDecimals(value, currency, 2)
}

function formatCellMoneyValue(value, currency = "EUR") {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null || String(value).trim() === "") {
        return ""
    }

    return formatMoney(parsedValue, currency)
}

function stripCurrencyText(value) {
    return String(value ?? "")
        .replace(/[€$]/g, "")
        .replace(/\b(?:USD|EUR|GBP|CHF|JPY|SEK|USDT|USDC|BUSD)\b/gi, "")
        .trim()
}

function getCurrentAssetCurrency() {
    return document.querySelector(".assetTablePage")?.dataset.assetCurrency || "EUR"
}

function normalizeAssetRowCurrency(currency, fallback = "EUR") {
    const normalized = String(currency || fallback)
        .trim()
        .toUpperCase()
    return normalized === "USD" ? "USD" : "EUR"
}

function getAssetRowCurrency(rowOrCell, fallback = getCurrentAssetCurrency()) {
    const rowElement = rowOrCell?.closest ? rowOrCell.closest("tr") : null
    const explicitCurrency =
        rowElement?.querySelector('select[data-field="currency"]')?.value ||
        rowElement?.querySelector('td[data-field="currency"]')?.textContent?.trim()
    return normalizeAssetRowCurrency(explicitCurrency, fallback)
}

function formatShareQuantity(value, maxDecimals = 6) {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null || String(value ?? "").trim() === "") {
        return ""
    }

    return parsedValue.toLocaleString(_nl(), {
        minimumFractionDigits: 0,
        maximumFractionDigits: maxDecimals
    })
}

function getAssetParticipationDecimals(assetType) {
    const normalizedType = String(assetType || "")
        .trim()
        .toLowerCase()

    if (normalizedType === "cripto" || normalizedType === "comoditis") {
        return 8
    }

    if (normalizedType === "acciones" || normalizedType === "etfs") {
        return 6
    }

    return 6
}

function getCurrentAssetType() {
    return document.querySelector(".assetTablePage")?.dataset.assetType || "acciones"
}

function formatAssetParticipationValue(value, assetType = getCurrentAssetType()) {
    return formatShareQuantity(value, getAssetParticipationDecimals(assetType))
}

function formatCellEuroValue(value) {
    const parsedValue = parseEuroNumber(value)

    if (!value || String(value).trim() === "") {
        return ""
    }

    return formatEuro(parsedValue)
}

async function initDividendosLogic() {
    await renderDividendosTable()

    const dividendosBody = document.getElementById("dividendosBody")
    const addRowButton = document.getElementById("addRowDividendoBtn")
    const saveDividendosButton = document.getElementById("saveDividendosBtn")

    if (dividendosBody && !dividendosBody.dataset.bound) {
        dividendosBody.dataset.bound = "true"
        dividendosBody.addEventListener("click", handleDividendosRowActionClick)
    }

    if (addRowButton && !addRowButton.dataset.bound) {
        addRowButton.dataset.bound = "true"
        addRowButton.addEventListener("click", () => {
            addNewDividendosRow()
        })
    }

    if (saveDividendosButton && !saveDividendosButton.dataset.bound) {
        saveDividendosButton.dataset.bound = "true"
        saveDividendosButton.addEventListener("click", async () => {
            try {
                await saveDividendosDataToServer()
                alert("Datos guardados en data/dividendos.json")
            } catch (error) {
                alert("Error al guardar: " + error.message)
            }
        })
    }

    initCalendarioDividendosButton()

    const addYearBtn = document.getElementById("addDividendosYearBtn")
    if (addYearBtn && !addYearBtn.dataset.bound) {
        addYearBtn.dataset.bound = "true"
        addYearBtn.addEventListener("click", () => {
            closeDividendosMenu()
            addDividendosYear()
        })
    }

    const deleteYearBtn = document.getElementById("deleteDividendosYearBtn")
    if (deleteYearBtn && !deleteYearBtn.dataset.bound) {
        deleteYearBtn.dataset.bound = "true"
        deleteYearBtn.addEventListener("click", () => {
            closeDividendosMenu()
            deleteCurrentDividendosYear()
        })
    }

    const divMenuBtn = document.getElementById("dividendosMenuBtn")
    const divMenuDrop = document.getElementById("dividendosMenuDropdown")
    if (divMenuBtn && divMenuDrop && !divMenuBtn.dataset.bound) {
        divMenuBtn.dataset.bound = "true"
        divMenuBtn.addEventListener("click", (e) => {
            e.stopPropagation()
            divMenuDrop.classList.toggle("hidden")
        })
    }

    const dividendosTable = document.querySelector(".dividendosTable")
    if (dividendosTable) bindTableSort(dividendosTable, "dividendos")
}

function closeDividendosMenu() {
    const d = document.getElementById("dividendosMenuDropdown")
    if (d) d.classList.add("hidden")
}

document.addEventListener("click", (e) => {
    if (!e.target.closest("#dividendosMenuBtn") && !e.target.closest("#dividendosMenuDropdown")) {
        closeDividendosMenu()
    }
})

document.addEventListener("keydown", (event) => {
    // `target` puede ser el propio document (un keydown sin foco), que no tiene `closest`.
    const editableCell = event.target.closest?.('td[contenteditable="true"]')
    if (!editableCell || event.key !== "Enter") {
        return
    }

    event.preventDefault()
    editableCell.blur()
})

function isDividendosPerShareCell(cell) {
    if (!cell) {
        return false
    }

    const row = cell.parentElement
    const table = cell.closest("table")
    const headerRow = table ? table.querySelector("thead tr") : null
    const columnIndex = row ? Array.from(row.children).indexOf(cell) : -1
    const headerCell = headerRow && columnIndex >= 0 ? headerRow.children[columnIndex] : null
    const headerText = (headerCell?.textContent || "").trim().toLowerCase()
    return headerText === "dividendos / acción"
}

function isDividendosActionsCell(cell) {
    if (!cell) {
        return false
    }

    const row = cell.parentElement
    const table = cell.closest("table")
    const headerRow = table ? table.querySelector("thead tr") : null
    const columnIndex = row ? Array.from(row.children).indexOf(cell) : -1
    const headerCell = headerRow && columnIndex >= 0 ? headerRow.children[columnIndex] : null
    const headerText = (headerCell?.textContent || "").trim().toLowerCase()
    return headerText === "acciones"
}

function isDividendosEuroCell(cell) {
    if (!cell) {
        return false
    }

    const row = cell.parentElement
    const table = cell.closest("table")
    const headerRow = table ? table.querySelector("thead tr") : null
    const columnIndex = row ? Array.from(row.children).indexOf(cell) : -1
    const headerCell = headerRow && columnIndex >= 0 ? headerRow.children[columnIndex] : null
    const headerText = (headerCell?.textContent || "").trim().toLowerCase()
    return headerText === "impuestos" || headerText === "total"
}

function getTableHeaderText(cell) {
    if (!cell) {
        return ""
    }

    const row = cell.parentElement
    const table = cell.closest("table")
    const headerRow = table ? table.querySelector("thead tr") : null
    const columnIndex = row ? Array.from(row.children).indexOf(cell) : -1
    const headerCell = headerRow && columnIndex >= 0 ? headerRow.children[columnIndex] : null
    return (headerCell?.textContent || "").trim().toLowerCase()
}

function isAssetParticipationsCell(cell) {
    return cell?.dataset?.field === "participaciones" || getTableHeaderText(cell) === "participaciones"
}

function isAssetCommissionsCell(cell) {
    return (
        cell?.dataset?.field === "comisiones" ||
        cell?.dataset?.field === "comisionesFiat" ||
        getTableHeaderText(cell) === "comisiones" ||
        getTableHeaderText(cell) === "comisiones fiat"
    )
}

function isAssetCryptoCommissionsCell(cell) {
    return (
        cell?.dataset?.field === "comisionesSatoshis" ||
        cell?.dataset?.field === "comisionesCripto" ||
        getTableHeaderText(cell) === "comisiones cripto"
    )
}

function isCryptoAssetType(assetType) {
    return (
        String(assetType || "")
            .trim()
            .toLowerCase() === "cripto"
    )
}

function getAssetTableMoneyCurrency(assetType, fieldName, assetCurrency = "EUR", rowCurrency = "") {
    if (
        isCryptoAssetType(assetType) &&
        [
            "precioParticipacion",
            "capitalInvertidoBruto",
            "comisiones",
            "comisionesFiat",
            "capitalInvertidoNeto"
        ].includes(fieldName)
    ) {
        return normalizeAssetRowCurrency(rowCurrency, assetCurrency)
    }

    return assetCurrency
}

function formatSatoshis(value) {
    const parsed = parseLooseNumber(value)

    if (parsed === null) {
        return ""
    }

    return parsed.toLocaleString(_nl(), {
        minimumFractionDigits: 8,
        maximumFractionDigits: 8
    })
}

function formatCellSatoshisValue(value) {
    const parsed = parseLooseNumber(value)

    if (parsed === null || String(value ?? "").trim() === "") {
        return (0).toLocaleString(_nl(), { minimumFractionDigits: 8, maximumFractionDigits: 8 })
    }

    return formatSatoshis(parsed)
}

// Sin parámetro de divisa: los dos llamadores formatean comisiones en cripto,
// que se muestran como cantidad y sin símbolo. El argumento estaba declarado y
// no lo usaba ni la función ni ninguna llamada.
function formatAssetCommissionValue(value) {
    const parsed = parseLooseNumber(value)

    if (parsed === null || String(value ?? "").trim() === "") {
        return (0).toLocaleString(_nl(), { minimumFractionDigits: 8, maximumFractionDigits: 8 })
    }

    return parsed.toLocaleString(_nl(), {
        minimumFractionDigits: 8,
        maximumFractionDigits: 12
    })
}

function parseLooseNumber(value) {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null
    }

    const text = String(value ?? "")
        .replace(/[^\d,.-]/g, "")
        .trim()
    if (!text) {
        return null
    }

    // El mismo criterio que parseEuroNumber: los dos parsers leen las mismas
    // columnas y discrepaban entre ellos ("1234.56" daba 1234,56 aquí y
    // 123.456 allí), así que el resultado dependía de cuál tocara esa pantalla.
    const normalizado = normalizeDecimalSeparators(text)
    if (!tieneUnSoloPunto(normalizado)) {
        return null
    }
    const parsed = Number(normalizado)
    return Number.isFinite(parsed) ? parsed : null
}

function formatDollarSafe(value) {
    const parsed = parseLooseNumber(value)
    if (parsed === null) {
        return ""
    }

    return `${parsed.toLocaleString(_nl(), {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })} $`
}

function formatEuroSafe(value) {
    const parsed = parseLooseNumber(value)
    if (parsed === null) {
        return ""
    }

    return `${parsed.toLocaleString(_nl(), {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })} €`
}

document.addEventListener("focusin", (event) => {
    const cell = event.target.closest('td[contenteditable="true"]')
    if (isAssetParticipationsCell(cell) || isAssetCommissionsCell(cell)) {
        queueMicrotask(() => {
            const strippedText = stripCurrencyText(cell.textContent || "")
            cell.textContent = strippedText
        })
        return
    }

    if (!isDividendosPerShareCell(cell)) {
        if (isDividendosActionsCell(cell) || isDividendosEuroCell(cell)) {
            queueMicrotask(() => {
                cell.textContent = stripCurrencyText(cell.textContent || "")
            })
        }
        return
    }

    queueMicrotask(() => {
        const parsed = parseLooseNumber(cell.textContent)
        cell.textContent = parsed === null ? "" : String(parsed).replace(".", ",")
    })
})

document.addEventListener("focusout", (event) => {
    const cell = event.target.closest('td[contenteditable="true"]')
    if (isAssetParticipationsCell(cell)) {
        queueMicrotask(() => {
            const text = String(cell.textContent || "").trim()
            cell.textContent = formatAssetParticipationValue(text)
        })
        return
    }

    if (isAssetCryptoCommissionsCell(cell)) {
        queueMicrotask(() => {
            const text = String(cell.textContent || "").trim()
            cell.textContent = formatCellSatoshisValue(text)
        })
        return
    }

    if (isAssetCommissionsCell(cell)) {
        queueMicrotask(() => {
            const text = String(cell.textContent || "").trim()
            const currentCurrency = getAssetRowCurrency(cell, getCurrentAssetCurrency())
            cell.textContent = currentCurrency === "EUR" ? formatEuroSafe(text) : formatDollarSafe(text)
        })
        return
    }

    if (!isDividendosPerShareCell(cell)) {
        if (isDividendosActionsCell(cell)) {
            queueMicrotask(() => {
                cell.textContent = stripCurrencyText(cell.textContent || "")
            })
        } else if (isDividendosEuroCell(cell)) {
            queueMicrotask(() => {
                const text = String(cell.textContent || "").trim()
                cell.textContent = formatEuroSafe(text)
            })
        }
        return
    }

    queueMicrotask(() => {
        const text = String(cell.textContent || "").trim()
        cell.textContent = formatDollarSafe(text)
    })
})

let interesesAutosaveTimer = null
let suppressAutosaveAlert = false

const originalWindowAlert = window.alert.bind(window)
window.alert = (message) => {
    const text = String(message || "")
    if (suppressAutosaveAlert && text.toLowerCase().includes("datos guardados en data/intereses.json")) {
        suppressAutosaveAlert = false
        return
    }

    originalWindowAlert(message)
}

function runWithoutAlerts(callback) {
    suppressAutosaveAlert = true
    try {
        callback()
    } finally {
        window.setTimeout(() => {
            suppressAutosaveAlert = false
        }, 1500)
    }
}

function hideAutoSaveButtons() {
    // El observador de abajo sigue vivo mientras haya DOM; en las pruebas, el
    // jsdom se cierra antes que sus últimos avisos y `document` ya no existe.
    if (typeof document === "undefined") return

    document.querySelectorAll("button").forEach((button) => {
        if (button.textContent.trim().toLowerCase() === "guardar" && !button.dataset.noAutohide) {
            button.style.display = "none"
        }
    })
}

function isInteresesTableCell(element) {
    const cell = element?.closest?.("td")
    const table = cell?.closest?.("table")
    const headerText = (table?.querySelector?.("thead")?.textContent || "").toLowerCase()
    return headerText.includes("saldo promedio") && headerText.includes("acumulado")
}

function triggerInteresesAutosave() {
    const saveButton = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent.trim().toLowerCase() === "guardar"
    )

    if (saveButton) {
        runWithoutAlerts(() => {
            saveButton.click()
        })
    }
}

function scheduleInteresesAutosave(delay = 500) {
    window.clearTimeout(interesesAutosaveTimer)
    interesesAutosaveTimer = window.setTimeout(() => {
        triggerInteresesAutosave()
    }, delay)
}

document.addEventListener("focusout", (event) => {
    if (isInteresesTableCell(event.target)) {
        scheduleInteresesAutosave(300)
    }
})

document.addEventListener("DOMContentLoaded", () => {
    requestAnimationFrame(hideAutoSaveButtons)
})

new MutationObserver(() => {
    hideAutoSaveButtons()
}).observe(document.body, { childList: true, subtree: true })

function downloadCsvFile(filename, rows, headers = null) {
    if (!Array.isArray(rows) || !rows.length) {
        return false
    }

    const csvHeaders = Array.isArray(headers) && headers.length ? headers : Object.keys(rows[0] || {})

    const escapeCsvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`
    const normalizeRowValue = (value) => {
        if (typeof value === "number") {
            return Number.isFinite(value) ? value.toFixed(2) : String(value)
        }
        return value ?? ""
    }

    const csvBody = rows.map((row) =>
        csvHeaders.map((header) => escapeCsvCell(normalizeRowValue(row[header]))).join(",")
    )
    const csv = [csvHeaders.map((header) => escapeCsvCell(header)).join(","), ...csvBody].join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    return true
}

// ── Generic table sort ──────────────────────────────────────────────────────

function bindTableSort(table, storageKey) {
    if (!table || table._sortBound) return
    table._sortBound = true

    const lsKey = storageKey ? `tableSort_${storageKey}` : null
    let saved = null
    if (lsKey) {
        try {
            saved = JSON.parse(localStorage.getItem(lsKey))
        } catch {}
    }

    let currentKey = saved?.key ?? null
    let currentDir = saved?.dir ?? "desc"

    function persist() {
        if (!lsKey) return
        try {
            localStorage.setItem(lsKey, JSON.stringify({ key: currentKey, dir: currentDir }))
        } catch {}
    }

    function cellText(row, colIdx) {
        const cell = row.cells[colIdx]
        if (!cell) return ""
        const sel = cell.querySelector("select")
        if (sel) return sel.value
        return cell.textContent.trim()
    }

    function toComparable(text) {
        const dm = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/)
        if (dm) {
            const y = dm[3].length === 2 ? 2000 + +dm[3] : +dm[3]
            return new Date(y, +dm[2] - 1, +dm[1]).getTime()
        }
        const n = parseFloat(
            text
                .replace(/\./g, "")
                .replace(",", ".")
                .replace(/[^\d.-]/g, "")
        )
        if (!isNaN(n)) return n
        return text.toLowerCase()
    }

    // Las tablas que se dividen en secciones (por año, por ejemplo) meten filas
    // de cabecera con .tableGroupRow. Cada cabecera abre un grupo y la
    // ordenación se aplica dentro de él, para que ordenar no desmonte la
    // división. Sin cabeceras hay un único grupo: la tabla entera.
    function groupRows(tbody) {
        const groups = [{ header: null, rows: [] }]

        for (const row of tbody.querySelectorAll("tr")) {
            if (row.classList.contains("tableGroupRow")) {
                groups.push({ header: row, rows: [] })
            } else {
                groups[groups.length - 1].rows.push(row)
            }
        }

        return groups
    }

    function doSort() {
        if (currentKey === null) return
        const tbody = table.querySelector("tbody")
        if (!tbody) return
        const colIdx = Number(currentKey)
        const compare = (a, b) => {
            const av = toComparable(cellText(a, colIdx))
            const bv = toComparable(cellText(b, colIdx))
            if (av < bv) return currentDir === "asc" ? -1 : 1
            if (av > bv) return currentDir === "asc" ? 1 : -1
            return 0
        }

        groupRows(tbody).forEach((group) => {
            group.rows.sort(compare)
            if (group.header) tbody.appendChild(group.header)
            group.rows.forEach((row) => tbody.appendChild(row))
        })

        syncArrows()
    }

    function syncArrows() {
        table.querySelectorAll("th.mThSort").forEach((th) => {
            const arrow = th.querySelector(".mSortArrow")
            if (!arrow) return
            if (th.dataset.sortkey === String(currentKey)) {
                arrow.textContent = currentDir === "asc" ? " ▲" : " ▼"
                th.classList.add("mThActive")
            } else {
                arrow.textContent = ""
                th.classList.remove("mThActive")
            }
        })
    }

    table.querySelectorAll("th.mThSort").forEach((th) => {
        th.addEventListener("click", () => {
            const key = th.dataset.sortkey
            if (currentKey === key) {
                currentDir = currentDir === "asc" ? "desc" : "asc"
            } else {
                currentKey = key
                currentDir = "desc"
            }
            persist()
            doSort()
        })
    })

    table._reSort = doSort
    if (currentKey !== null) doSort()
}

// ── Alineación automática de columnas de dinero / numéricas ─────────────────

// Importes ("1.234,56 €"), porcentajes ("+4,01 %") y cantidades ("0,00466667",
// "0,00010000 BTC"). Las fechas ("05-08-2026") no encajan a propósito.
const NUMERIC_TABLE_CELL_PATTERN =
    /^[\u2248~]?\s*[-+]?\s*[\u20ac$]?\s*\d[\d.\u00a0\u202f ]*(?:,\d+)?\s*(?:%|\u20ac|\$|[A-Z]{2,6})?$/

function getNumericTableCellText(cell) {
    const field = cell.querySelector("input, textarea")

    if (field) {
        return String(field.value || "").trim()
    }

    if (cell.querySelector("select, button, a")) {
        return ""
    }

    // Celdas con varias líneas (importe + detalle): decide la primera.
    return (cell.firstElementChild || cell).textContent.trim()
}

function refreshTableNumericAlignment(table) {
    if (!table) {
        return
    }

    const headerRows = table.tHead ? Array.from(table.tHead.rows) : []
    const headerRow = headerRows[headerRows.length - 1] || null
    const headerCells = headerRow ? Array.from(headerRow.cells) : []
    const headerUsable = headerCells.length > 0 && !headerCells.some((cell) => cell.colSpan > 1)
    const bodyRows = Array.from(table.tBodies).flatMap((tbody) => Array.from(tbody.rows))
    // La fila de totales del pie es una fila de datos más: sin ella, un tfoot
    // con las mismas columnas que el cuerpo se quedaba alineado a la izquierda.
    const footRows = table.tFoot ? Array.from(table.tFoot.rows) : []
    const columnCount = headerUsable ? headerCells.length : (bodyRows[0] || footRows[0])?.cells.length || 0

    if (!columnCount) {
        return
    }

    const dataRows = [...bodyRows, ...footRows].filter(
        (row) => row.cells.length === columnCount && !Array.from(row.cells).some((cell) => cell.colSpan > 1)
    )

    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        let filledCells = 0
        let numericCells = 0

        dataRows.forEach((row) => {
            const text = getNumericTableCellText(row.cells[columnIndex])

            if (!text) {
                return
            }

            filledCells += 1

            if (NUMERIC_TABLE_CELL_PATTERN.test(text)) {
                numericCells += 1
            }
        })

        const isNumericColumn = numericCells > 0 && numericCells >= filledCells * 0.6

        if (headerUsable) {
            headerCells[columnIndex].classList.toggle("numCol", isNumericColumn)
        }

        dataRows.forEach((row) => {
            row.cells[columnIndex].classList.toggle("numCell", isNumericColumn)
        })
    }
}

function refreshNumericTableAlignment(root = document) {
    root.querySelectorAll?.("table").forEach(refreshTableNumericAlignment)
}

let numericAlignmentScheduled = false

function scheduleNumericTableAlignment() {
    if (numericAlignmentScheduled) {
        return
    }

    numericAlignmentScheduled = true
    requestAnimationFrame(() => {
        numericAlignmentScheduled = false
        refreshNumericTableAlignment()
    })
}

// Solo observamos childList: las clases que añadimos son mutaciones de
// atributo, así que el observer no se dispara a sí mismo.
new MutationObserver((mutations) => {
    const touchesTable = mutations.some(
        (mutation) =>
            mutation.target.closest?.("table") ||
            Array.from(mutation.addedNodes).some(
                (node) =>
                    node.nodeType === 1 &&
                    (node.matches?.("table, thead, tbody, tr, td, th") || node.querySelector?.("table"))
            )
    )

    if (touchesTable) {
        scheduleNumericTableAlignment()
    }
}).observe(document.body, { childList: true, subtree: true })

document.addEventListener("DOMContentLoaded", scheduleNumericTableAlignment)
scheduleNumericTableAlignment()

// ── Custom select dropdown ──────────────────────────────────────────────────

function _buildCustomSelect(select) {
    if (select._csInit) return
    select._csInit = true

    const wrapper = document.createElement("div")
    wrapper.className = "csWrapper"

    const trigger = document.createElement("div")
    trigger.className = "csTrigger"

    const label = document.createElement("span")
    label.className = "csLabel"

    const arrow = document.createElement("span")
    arrow.className = "csArrow"
    arrow.textContent = "▾"

    trigger.appendChild(label)
    trigger.appendChild(arrow)

    const menu = document.createElement("div")
    menu.className = "csMenu csBodyMenu"
    menu.style.zIndex = "100000"
    menu.style.display = "none"

    menu.style.position = "fixed"
    document.body.appendChild(menu)

    select.parentNode.insertBefore(wrapper, select)
    wrapper.appendChild(select)
    wrapper.appendChild(trigger)
    select.style.display = "none"
    trigger.tabIndex = 0

    function positionMenu() {
        const rect = trigger.getBoundingClientRect()
        const left = Math.round(rect.left)
        const width = Math.round(rect.width)
        const bottom = Math.round(rect.bottom)
        const top = Math.round(rect.top)

        menu.style.position = "fixed"
        menu.style.left = left + "px"
        menu.style.width = Math.max(width, 150) + "px"

        const previousVisibility = menu.style.visibility
        const previousDisplay = menu.style.display

        menu.style.visibility = "hidden"
        menu.style.display = "flex"
        const menuH = Math.min(menu.scrollHeight, 220)
        menu.style.visibility = previousVisibility
        menu.style.display = previousDisplay

        const spaceBelow = window.innerHeight - bottom - 8
        if (spaceBelow < menuH && top >= menuH) {
            menu.style.top = top - menuH + "px"
        } else {
            menu.style.top = bottom + "px"
        }
    }

    function closeMenu() {
        menu.classList.remove("csOpen")
        menu.style.display = "none"
        trigger.classList.remove("csOpen")
        menu.querySelectorAll(".csOption.csActive").forEach((o) => o.classList.remove("csActive"))
    }

    function chooseOption(opt) {
        // Una opción deshabilitada se enseña (dice por qué no vale), pero no se elige.
        if (opt.disabled) return
        select.value = opt.value
        select.dispatchEvent(new Event("change", { bubbles: true }))
        syncLabel()
        syncOptions()
        closeMenu()
    }

    function syncOptions() {
        menu.innerHTML = ""
        Array.from(select.options).forEach((opt) => {
            if (!opt.value && !opt.text.trim()) return
            const item = document.createElement("div")
            item.className = "csOption" + (opt.selected ? " csSelected" : "") + (opt.disabled ? " csDisabled" : "")
            item.dataset.val = opt.value
            item.textContent = opt.text
            item.addEventListener("mousedown", (e) => {
                e.preventDefault()
                chooseOption(opt)
            })
            menu.appendChild(item)
        })
    }

    function syncLabel() {
        const sel = select.options[select.selectedIndex]
        label.textContent = sel ? sel.text : ""
    }

    syncOptions()
    syncLabel()

    trigger.addEventListener("click", (e) => {
        e.stopPropagation()
        const isOpen = menu.classList.contains("csOpen")
        document.querySelectorAll(".csMenu.csOpen").forEach((m) => {
            m.classList.remove("csOpen")
            m.style.display = "none"
            m._csTrigger?.classList.remove("csOpen")
        })
        if (!isOpen) {
            syncOptions()
            positionMenu()
            menu.classList.add("csOpen")
            menu.style.display = "flex"
            trigger.classList.add("csOpen")
        }
    })

    menu._csTrigger = trigger

    let searchBuffer = ""
    let searchTimer = null

    function clearActive() {
        menu.querySelectorAll(".csOption.csActive").forEach((o) => o.classList.remove("csActive"))
    }

    function jumpToSearch() {
        if (!searchBuffer) return
        const options = Array.from(menu.querySelectorAll(".csOption"))
        const match = options.find((o) => o.textContent.trim().toLowerCase().startsWith(searchBuffer))
        if (!match) return
        clearActive()
        match.classList.add("csActive")
        match.scrollIntoView({ block: "nearest" })
    }

    trigger.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            if (!menu.classList.contains("csOpen")) {
                trigger.click()
                return
            }
            const active = menu.querySelector(".csOption.csActive")
            if (active) {
                const opt = Array.from(select.options).find((o) => o.value === active.dataset.val)
                if (opt) chooseOption(opt)
            }
            return
        }
        if (e.key === "Escape") {
            closeMenu()
            return
        }
        if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) {
            e.preventDefault()
            if (!menu.classList.contains("csOpen")) {
                trigger.click()
            }
            clearTimeout(searchTimer)
            searchBuffer += e.key.toLowerCase()
            jumpToSearch()
            searchTimer = setTimeout(() => {
                searchBuffer = ""
            }, 800)
        }
    })

    document.addEventListener("click", closeMenu)
    document.addEventListener(
        "scroll",
        (e) => {
            if (!menu.contains(e.target)) closeMenu()
        },
        true
    )

    select.addEventListener("change", () => {
        syncLabel()
        syncOptions()
    })

    new MutationObserver(() => {
        syncOptions()
        syncLabel()
    }).observe(select, { childList: true })
}

// Pasa a dos columnas un popup hecho de etiquetas y campos sueltos (assetModal):
// agrupa cada etiqueta con el campo que la sigue y los mete en una rejilla.
// Lo que no es pareja etiqueta-campo (avisos, botones) se queda fuera, debajo.
// Hay que llamarlo antes de añadir el popup al documento, para que los
// desplegables y el botón "Hoy" se monten ya dentro de su casilla.
function ponerModalEnDosColumnas(modal) {
    const labels = [...modal.children].filter((el) => el.matches("label.assetModalLabel"))
    if (!labels.length) return

    const grid = document.createElement("div")
    grid.className = "modalCampos"
    labels[0].before(grid)

    labels.forEach((label) => {
        const control = label.nextElementSibling
        const campo = document.createElement("div")
        campo.className = "modalCampo"
        campo.appendChild(label)
        if (control?.matches("input, select, textarea")) campo.appendChild(control)
        grid.appendChild(campo)
    })

    modal.classList.add("modalDosColumnas")
}

// Scroll lateral arrastrando con el ratón, como la barra de filtros de Vista
// general. Hasta 5px de movimiento cuenta como clic normal; después, el soltar
// no llega como clic a lo que haya debajo (un botón de borrar, por ejemplo).
// `obtenerObjetivo` sirve cuando lo que se desplaza es una parte del contenedor
// que se vuelve a pintar a menudo: se escucha en el contenedor, que no cambia,
// y se busca la parte desplazable en cada arrastre.
function activarArrastreHorizontal(contenedor, obtenerObjetivo = () => contenedor) {
    if (!contenedor || contenedor.dataset.arrastreBound) return
    contenedor.dataset.arrastreBound = "true"

    let inicioX = 0
    let inicioScroll = 0
    let pulsado = false
    let movido = false
    let objetivo = null

    contenedor.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest("input, select, textarea")) return
        objetivo = obtenerObjetivo()
        if (!objetivo) return
        pulsado = true
        movido = false
        inicioX = event.clientX
        inicioScroll = objetivo.scrollLeft
    })
    // En window para no perder el arrastre si el puntero sale del contenedor;
    // se ignora en cuanto el contenedor deja de estar en la página.
    window.addEventListener("pointermove", (event) => {
        if (!pulsado || !contenedor.isConnected) return
        const desplazamiento = event.clientX - inicioX
        if (!movido && Math.abs(desplazamiento) < 5) return
        movido = true
        contenedor.classList.add("dragging")
        objetivo.scrollLeft = inicioScroll - desplazamiento
    })
    window.addEventListener("pointerup", () => {
        pulsado = false
        contenedor.classList.remove("dragging")
    })
    contenedor.addEventListener(
        "click",
        (event) => {
            if (!movido) return
            movido = false
            event.preventDefault()
            event.stopPropagation()
        },
        true
    )
}

// Orden de las barras de años: el año en curso siempre el primero (a la
// izquierda) y detrás el resto, del más reciente al más antiguo, para que los
// años viejos se vayan al scroll lateral en vez de empujar al actual.
function ordenarAniosRecientesPrimero(anios, anioEnCurso = new Date().getFullYear()) {
    const enCurso = String(anioEnCurso)
    return [...anios].sort((a, b) => {
        if (String(a) === enCurso) return -1
        if (String(b) === enCurso) return 1
        return Number(b) - Number(a)
    })
}

// Desplaza solo, despacio y sin pausas lo que no cabe, como una cinta continua:
// detrás del último elemento vuelve a aparecer el primero. Para eso duplica una
// vez el contenido (la copia va marcada y oculta a lectores de pantalla) y, al
// llegar al final de la primera vuelta, resta su ancho: el salto no se nota
// porque en ese punto se ve exactamente lo mismo. Se detiene mientras el ratón
// está encima (para leer o arrastrar) y no hace nada si todo cabe o si el
// sistema pide reducir animaciones. Se apaga solo cuando el contenedor sale de
// la página. `obtenerObjetivo` funciona igual que en activarArrastreHorizontal;
// si el objetivo se repinta, el nuevo se duplica en el siguiente fotograma.
function activarDesplazamientoAutomatico(contenedor, obtenerObjetivo = () => contenedor) {
    if (!contenedor || contenedor.dataset.autoScrollBound) return
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    contenedor.dataset.autoScrollBound = "true"

    const pixelesPorSegundo = 22
    let encima = false
    let posicion = null
    let anterior = null

    contenedor.addEventListener("pointerenter", () => {
        encima = true
    })
    contenedor.addEventListener("pointerleave", () => {
        encima = false
        // Al soltar, sigue desde donde lo haya dejado el usuario.
        posicion = null
    })

    // Ancho de una vuelta: de dónde empieza el primer elemento a dónde empieza
    // su copia, así incluye el hueco entre el último y el primero.
    const anchoVuelta = (objetivo) => {
        const primero = objetivo.firstElementChild
        const primeraCopia = objetivo.querySelector(":scope > [data-copia-cinta]")
        return primero && primeraCopia ? primeraCopia.offsetLeft - primero.offsetLeft : 0
    }

    const duplicar = (objetivo) => {
        const originales = [...objetivo.children]
        originales.forEach((hijo) => {
            const copia = hijo.cloneNode(true)
            copia.dataset.copiaCinta = "true"
            copia.setAttribute("aria-hidden", "true")
            objetivo.appendChild(copia)
        })
        objetivo.dataset.cintaDuplicada = "true"
    }

    const paso = (ahora) => {
        if (!contenedor.isConnected) return
        const transcurrido = anterior === null ? 0 : Math.min(0.1, (ahora - anterior) / 1000)
        anterior = ahora
        const objetivo = obtenerObjetivo()

        if (objetivo && !objetivo.dataset.cintaDuplicada && objetivo.scrollWidth > objetivo.clientWidth) {
            duplicar(objetivo)
            posicion = null
        }

        const vuelta = objetivo?.dataset.cintaDuplicada ? anchoVuelta(objetivo) : 0
        if (vuelta > 0 && !encima) {
            // La posición se lleva aparte porque scrollLeft redondea y, a esta
            // velocidad, se quedaría parado; además sobrevive a que se repinte.
            if (posicion === null) posicion = objetivo.scrollLeft % vuelta
            posicion += pixelesPorSegundo * transcurrido
            if (posicion >= vuelta) posicion -= vuelta
            objetivo.scrollLeft = posicion
        }

        requestAnimationFrame(paso)
    }

    requestAnimationFrame(paso)
}

// Menú «···» de acciones de una página (botón + desplegable .interesesMenuDropdown
// con la clase `hidden`). Se cierra al elegir una opción y al pulsar fuera; el
// listener del documento se retira solo cuando el menú ya no está en pantalla.
function activarMenuAcciones(boton, menu) {
    if (!boton || !menu || boton.dataset.menuBound) return
    boton.dataset.menuBound = "true"
    boton.addEventListener("click", (event) => {
        event.stopPropagation()
        menu.classList.toggle("hidden")
    })
    menu.addEventListener("click", () => menu.classList.add("hidden"))
    const cerrar = (event) => {
        if (!menu.isConnected) {
            document.removeEventListener("click", cerrar)
            return
        }
        if (!menu.contains(event.target)) menu.classList.add("hidden")
    }
    document.addEventListener("click", cerrar)
}

// Lupa de búsqueda de las tablas. Es declarativa: basta con poner en la página
//   <div class="overviewSearch tablaBusqueda" data-busca-en="#ventasBody"> … </div>
// (botón + input oculto, como la de Vista general) y el observador de abajo la
// activa. Filtra por el texto visible de cada fila de los tbody indicados (se
// admiten varios separados por comas) y vuelve a filtrar cuando la tabla se
// repinta, porque casi todas las páginas regeneran el tbody entero. Oculta con
// una clase propia para no pisar los filtros de cada página, que usan
// style.display o sus propias clases.
function _filtrarTablaBusqueda(caja) {
    const consulta = (caja.querySelector("input")?.value || "").trim().toLowerCase()
    document.querySelectorAll(caja.dataset.buscaEn).forEach((tbody) => {
        ;[...tbody.rows].forEach((fila) => {
            const coincide = !consulta || fila.textContent.toLowerCase().includes(consulta)
            fila.classList.toggle("filaOcultaBusqueda", !coincide)
        })
    })
    _filtrarAniosBusqueda(caja, consulta)
}

// Barra de años que va junto a la lupa: en todas las páginas es una hermana
// suya con id terminado en "YearList".
function _barraAniosDeBusqueda(caja) {
    return caja.parentElement?.querySelector('[id$="YearList"]') || null
}

// La tabla solo tiene las filas del año elegido, así que buscar "2015" desde
// 2023 no encontraba nada. Con una consulta numérica se dejan en la barra los
// años que la contienen y, si coincide entera con uno, se salta a él; el
// repintado de la tabla vuelve a pasar por aquí y ya lo encuentra activo.
// Una consulta de texto no oculta años: buscar un activo no tiene que vaciar
// la barra.
function _filtrarAniosBusqueda(caja, consulta) {
    const barra = _barraAniosDeBusqueda(caja)
    if (!barra) return

    const esAnio = /^\d{1,4}$/.test(consulta)
    let exacto = null
    ;[...barra.children].forEach((boton) => {
        const texto = boton.textContent.trim()
        // Lo que no es un año (botones de añadir, "Todo") se queda siempre.
        if (!/^\d{4}$/.test(texto)) return
        boton.classList.toggle("anioOcultoBusqueda", esAnio && !texto.includes(consulta))
        if (esAnio && texto === consulta) exacto = boton
    })

    // En Gastos e Ingresos pulsar el año ya activo cambia de vista: solo se
    // pulsa si no lo está.
    if (exacto && !exacto.classList.contains("active")) {
        exacto.click()
        return
    }
    barra.querySelector(".active:not(.anioOcultoBusqueda)")?.scrollIntoView({ block: "nearest", inline: "nearest" })
    // Ocultar años cambia lo que sobra: el evento hace que la tira recalcule
    // su difuminado (initScrollLateral lo escucha).
    barra.dispatchEvent(new Event("scroll"))
}

function _activarBusquedaTabla(caja) {
    if (caja.dataset.busquedaBound) return
    caja.dataset.busquedaBound = "true"

    const boton = caja.querySelector(".overviewSearchBtn")
    const input = caja.querySelector("input")
    if (!boton || !input) return

    boton.addEventListener("click", () => {
        const abrir = input.hidden
        input.hidden = !abrir
        caja.classList.toggle("open", abrir)
        if (abrir) {
            input.focus()
            return
        }
        input.value = ""
        _filtrarTablaBusqueda(caja)
    })
    input.addEventListener("input", () => _filtrarTablaBusqueda(caja))
    input.addEventListener("keydown", (event) => {
        if (event.key === "Escape") boton.click()
    })

    // Solo hace falta volver a filtrar si hay algo escrito; con la consulta
    // vacía las filas nuevas ya salen visibles.
    const alRepintar = new MutationObserver(() => {
        if (input.value.trim()) _filtrarTablaBusqueda(caja)
    })
    document.querySelectorAll(caja.dataset.buscaEn).forEach((tbody) => alRepintar.observe(tbody, { childList: true }))
    // La barra de años también se rehace entera y perdería los ocultos.
    const barra = _barraAniosDeBusqueda(caja)
    if (barra) alRepintar.observe(barra, { childList: true })
}

// Tiras con scroll lateral que no montan su propio arrastre: la navegación y,
// en pantallas estrechas, las pestañas de mes y los selectores de Métricas.
// Los contenedores no cambian durante la visita (solo su contenido), así que
// basta con engancharlos una vez al aparecer.
const _SELECTOR_TIRAS_ARRASTRABLES = ".tabs, .gastosMonthTabs, .ingresosMonthTabs, .ahorroMonthTabs, .dividendosMonthTabs, .mToggleGroup"

function _activarArrastreTiras(raiz) {
    if (raiz.matches?.(_SELECTOR_TIRAS_ARRASTRABLES)) activarArrastreHorizontal(raiz)
    raiz.querySelectorAll?.(_SELECTOR_TIRAS_ARRASTRABLES).forEach((tira) => activarArrastreHorizontal(tira))
}

// Las fechas se teclean a mano en formato dd-mm-aaaa en todos los popups. Para
// no escribir la de hoy una y otra vez, cada campo de fecha recibe un botón
// "Hoy" que la rellena. Se detectan por el placeholder, común a todos ellos.
const _DATE_INPUT_PLACEHOLDER = /^dd[-/]mm[-/](aaaa|yyyy)$/i

function todayDateString() {
    const now = new Date()
    const day = String(now.getDate()).padStart(2, "0")
    const month = String(now.getMonth() + 1).padStart(2, "0")
    return `${day}-${month}-${now.getFullYear()}`
}

function _buildDateTodayButton(input) {
    if (input.dataset.todayBtn === "1") return
    if (!_DATE_INPUT_PLACEHOLDER.test((input.getAttribute("placeholder") || "").trim())) return
    if (!input.parentNode) return

    input.dataset.todayBtn = "1"

    const wrap = document.createElement("div")
    wrap.className = "dateFieldWrap"
    input.parentNode.insertBefore(wrap, input)
    wrap.appendChild(input)

    const button = document.createElement("button")
    button.type = "button"
    button.className = "dateTodayBtn"
    button.textContent = "Hoy"
    button.title = "Poner la fecha de hoy"
    button.tabIndex = -1
    button.addEventListener("click", () => {
        input.value = todayDateString()
        input.dispatchEvent(new Event("input", { bubbles: true }))
        input.dispatchEvent(new Event("change", { bubbles: true }))
        input.focus()
    })

    wrap.appendChild(button)
}

new MutationObserver((mutations) => {
    for (const m of mutations) {
        for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue
            if (node.tagName === "SELECT" && !node.hasAttribute("data-no-custom")) _buildCustomSelect(node)
            node.querySelectorAll?.("select:not([data-no-custom])").forEach(_buildCustomSelect)
            if (node.tagName === "INPUT") _buildDateTodayButton(node)
            node.querySelectorAll?.("input[placeholder]").forEach(_buildDateTodayButton)
            if (node.matches?.(".tablaBusqueda[data-busca-en]")) _activarBusquedaTabla(node)
            node.querySelectorAll?.(".tablaBusqueda[data-busca-en]").forEach(_activarBusquedaTabla)
            _activarArrastreTiras(node)
        }
    }
}).observe(document.body, { childList: true, subtree: true })

document.querySelectorAll("select:not([data-no-custom])").forEach(_buildCustomSelect)
document.querySelectorAll("input[placeholder]").forEach(_buildDateTodayButton)
_activarArrastreTiras(document)

// ── Distribución en donut ──────────────────────────────────────────────────
// Usada por los meses de Gastos e Ingresos: un anillo con el reparto de un total
// y, debajo, la leyenda con el importe y el porcentaje de cada parte.

const DISTRIBUCION_COLORES = [
    "#60a5fa",
    "#34d399",
    "#fbbf24",
    "#f87171",
    "#c084fc",
    "#22d3ee",
    "#fb923c",
    "#a3e635",
    "#f472b6",
    "#94a3b8"
]
// Cuántas partes se enseñan por separado; el resto se junta en «Otros».
const DISTRIBUCION_MAX_PARTES = 7

// Suma los importes de las filas por la clave que dé `claveFn`.
function agruparImportes(filas, claveFn) {
    const totales = new Map()
    ;(filas || []).forEach((fila) => {
        const importe = parseEuroNumber(fila.cantidad || "")
        if (!(importe > 0)) return
        const clave = String(claveFn(fila) || "").trim() || "Sin tipo"
        totales.set(clave, (totales.get(clave) || 0) + importe)
    })
    return [...totales].map(([label, value]) => ({ label, value }))
}

function buildDistribucionHtml(titulo, partes, textoVacio = "Sin movimientos este mes") {
    const esc = escapeHtml
    const cabecera = `<div class="movResumenTitulo">${esc(titulo)}</div>`

    const ordenadas = (partes || []).filter((p) => p.value > 0).sort((a, b) => b.value - a.value)
    const total = ordenadas.reduce((acc, p) => acc + p.value, 0)
    if (!(total > 0))
        return `<div class="movResumenCard">${cabecera}<p class="movResumenVacio">${esc(textoVacio)}</p></div>`

    let visibles = ordenadas
    if (ordenadas.length > DISTRIBUCION_MAX_PARTES) {
        const resto = ordenadas.slice(DISTRIBUCION_MAX_PARTES - 1)
        visibles = [
            ...ordenadas.slice(0, DISTRIBUCION_MAX_PARTES - 1),
            { label: `Otros (${resto.length})`, value: resto.reduce((acc, p) => acc + p.value, 0) }
        ]
    }

    const radio = 44
    const circunferencia = 2 * Math.PI * radio
    let acumulado = 0
    const porcentaje = (valor) => `${((valor / total) * 100).toFixed(1).replace(".", ",")}%`

    const segmentos = visibles
        .map((parte, i) => {
            const largo = (parte.value / total) * circunferencia
            const color = DISTRIBUCION_COLORES[i % DISTRIBUCION_COLORES.length]
            const circulo = `<circle cx="60" cy="60" r="${radio}" fill="none" stroke="${color}" stroke-width="18" stroke-dasharray="${largo.toFixed(2)} ${(circunferencia - largo).toFixed(2)}" stroke-dashoffset="${(-acumulado).toFixed(2)}" transform="rotate(-90 60 60)"><title>${esc(parte.label)}: ${formatEuro(parte.value)} (${porcentaje(parte.value)})</title></circle>`
            acumulado += largo
            return circulo
        })
        .join("")

    const leyenda = visibles
        .map(
            (parte, i) => `
                <li>
                    <span class="movLeyendaPunto" style="background:${DISTRIBUCION_COLORES[i % DISTRIBUCION_COLORES.length]}"></span>
                    <span class="movLeyendaNombre" title="${esc(parte.label)}">${esc(parte.label)}</span>
                    <span class="movLeyendaImporte">${formatEuro(parte.value)}</span>
                    <span class="movLeyendaPct">${porcentaje(parte.value)}</span>
                </li>`
        )
        .join("")

    return `
        <div class="movResumenCard">
            ${cabecera}
            <svg class="movDonut" viewBox="0 0 120 120" role="img" aria-label="${esc(titulo)}">
                ${segmentos}
                <text x="60" y="58" text-anchor="middle" class="movDonutTotal">${formatEuro(total)}</text>
                <text x="60" y="72" text-anchor="middle" class="movDonutEtiqueta">total</text>
            </svg>
            <ul class="movLeyenda">${leyenda}</ul>
        </div>`
}

// Iconos de la interfaz: archivos en img/icons/ pintados por css/components/iconos.css
// (una clase por imagen, "iconoAjustes", "iconoOjoTachado"…). Se usan en vez de
// emojis porque un emoji se ve distinto en cada sistema y no sigue el color del
// tema. `nombre` es la parte tras "icono": crearIcono("Ojo") → .iconoOjo.
// Decorativos: el texto accesible va en el title/aria-label del botón que los lleva.
function iconoHtml(nombre, clasesExtra = "") {
    const extra = clasesExtra ? ` ${clasesExtra}` : ""
    return `<span class="icono icono${nombre}${extra}" aria-hidden="true"></span>`
}

function crearIcono(nombre) {
    const icono = document.createElement("span")
    icono.className = `icono icono${nombre}`
    icono.setAttribute("aria-hidden", "true")
    return icono
}
