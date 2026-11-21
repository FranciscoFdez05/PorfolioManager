// Análisis > Herramientas: simular una compra.
//
// Trozo de js/analisis/herramientas.js. Comparte con el resto de herramientas-*.js el
// ámbito global y se carga detrás de herramientas.js, en el orden de index.html.
//
// Dice cómo quedaría una posición si se compra más (o se abre): unidades que
// entran, precio medio nuevo, peso en la cartera y rentabilidad latente. No
// guarda nada.
//
// Dos modos. En el automático la posición, el precio de mercado y el valor de
// la cartera salen de lo guardado, y basta con poner lo que se invierte: las
// unidades son importe / precio de compra. En el manual se escribe todo, para
// un activo que no está en la cartera o para probar con otras cifras.
//
// El precio medio es el de la ficha del activo (invertido neto / unidades), así
// que el «antes» coincide con lo que se ve en Activos.

// A partir de este peso tras la compra se avisa de concentración. Es una
// referencia habitual de diversificación, no una norma.
const H_SC_PESO_CONCENTRACION = 0.2

let _hScModo = "auto"
let _hScCartera = null
// Tabla de reparto: «cartera» (peso de cada activo) o «activo» (peso de cada
// compra dentro del activo simulado).
let _hScVista = "cartera"
// Lo último calculado, para repintar la tabla al cambiar de vista sin recalcular.
let _hScUltimo = null
// Compras guardadas por activo: una petición por activo y visita a la página.
let _hScCompras = new Map()

// ── Cálculo ────────────────────────────────────────────────────────────────

/**
 * Unidades que se compran con un importe a un precio dado.
 *
 * @param {number} importe Lo que se invierte, en la moneda del precio.
 * @param {number} precio Precio de compra por unidad.
 * @returns {number} Las unidades, o NaN si alguno de los dos no es positivo.
 */
function hScUnidades(importe, precio) {
    return importe > 0 && precio > 0 ? importe / precio : NaN
}

/**
 * Cómo queda la posición, y su peso en la cartera, tras una compra.
 *
 * Importes de la posición en la moneda del activo; el peso se mide en euros
 * con `fx` (euros por unidad de esa moneda). El dinero de la compra se toma
 * como aportación nueva: la cartera crece en lo que valen a mercado las
 * unidades compradas.
 *
 * @param {{unidades?: number, invertido?: number, precioMercado?: number,
 *     precioCompra: number, unidadesCompra: number, fx?: number,
 *     totalCarteraEur?: number}} datos `unidades` e `invertido` son la posición
 *     actual (cero si no la hay). `totalCarteraEur` es el valor de toda la
 *     cartera, incluida esta posición. Sin precio de mercado se valora al de
 *     compra.
 * @returns {object|null} Las cifras antes y después, o null si los datos no
 *     permiten calcular.
 *
 * @example
 * // 10 uds a 100 €, se compran 10 más a 80 €: el medio baja a 90 €.
 * hScCalcular({ unidades: 10, invertido: 1000, precioMercado: 80,
 *     precioCompra: 80, unidadesCompra: 10, totalCarteraEur: 5000 }).medioDespues
 */
function hScCalcular({
    unidades = 0,
    invertido = 0,
    precioMercado = NaN,
    precioCompra,
    unidadesCompra,
    fx = 1,
    totalCarteraEur = 0
}) {
    if (!(precioCompra > 0) || !(unidadesCompra > 0) || !(fx > 0)) return null
    if (!(unidades >= 0) || !(invertido >= 0) || !(totalCarteraEur >= 0)) return null

    const mercado = precioMercado > 0 ? precioMercado : precioCompra
    const importe = unidadesCompra * precioCompra
    const unidadesDespues = unidades + unidadesCompra
    const invertidoDespues = invertido + importe
    const valorAntes = unidades * mercado
    const valorDespues = unidadesDespues * mercado
    // La cartera no puede valer menos que la propia posición: en el modo manual
    // se escribe a mano y un total menor daría pesos por encima del 100 %.
    const totalAntesEur = Math.max(totalCarteraEur, valorAntes * fx)
    const totalDespuesEur = totalAntesEur + unidadesCompra * mercado * fx
    const medioAntes = unidades > 0 && invertido > 0 ? invertido / unidades : null
    const medioDespues = invertidoDespues / unidadesDespues

    return {
        importe,
        unidadesDespues,
        invertidoDespues,
        medioAntes,
        medioDespues,
        variacionMedio: medioAntes ? medioDespues / medioAntes - 1 : null,
        // Lo que supone esta compra dentro de la posición resultante.
        pesoCompraCoste: importe / invertidoDespues,
        pesoCompraUnidades: unidadesCompra / unidadesDespues,
        valorAntes,
        valorDespues,
        rentAntes: unidades > 0 ? valorAntes - invertido : null,
        rentAntesPct: invertido > 0 ? valorAntes / invertido - 1 : null,
        rentDespues: valorDespues - invertidoDespues,
        rentDespuesPct: valorDespues / invertidoDespues - 1,
        pesoAntes: totalAntesEur > 0 ? (valorAntes * fx) / totalAntesEur : 0,
        pesoDespues: (valorDespues * fx) / totalDespuesEur,
        totalAntesEur,
        totalDespuesEur
    }
}

/**
 * Peso de cada posición antes y después de sumar valor a una de ellas.
 *
 * @param {Array<{id: string, nombre: string, valorEur: number}>} posiciones
 * @param {string} idSimulado La posición que recibe la compra.
 * @param {number} valorExtraEur Lo que vale a mercado lo comprado, en euros.
 * @returns {Array<{id: string, nombre: string, antes: number, despues: number,
 *     simulado: boolean}>} Ordenadas por peso final, sin las que no pesan nada.
 */
function hScRepartos(posiciones, idSimulado, valorExtraEur) {
    const total = posiciones.reduce((suma, p) => suma + p.valorEur, 0)
    const totalDespues = total + valorExtraEur
    if (!(totalDespues > 0)) return []

    return posiciones
        .map((p) => {
            const simulado = p.id === idSimulado
            return {
                id: p.id,
                nombre: p.nombre,
                antes: total > 0 ? p.valorEur / total : 0,
                despues: (p.valorEur + (simulado ? valorExtraEur : 0)) / totalDespues,
                simulado
            }
        })
        .filter((fila) => fila.antes > 0 || fila.despues > 0)
        .sort((a, b) => b.despues - a.despues)
}

/**
 * Peso de cada compra del activo, por coste, antes y después de la simulada.
 *
 * @param {Array<{precio: number, cantidad: number}>} compras Las ya hechas.
 * @param {{precio: number, cantidad: number}} nueva La que se simula.
 * @returns {Array<{etiqueta: string, precio: number, cantidad: number,
 *     antes: number, despues: number, simulado: boolean}>} La simulada
 *     primero, para que se vea aunque la tabla tenga scroll; luego las demás
 *     en el orden recibido.
 */
function hScRepartoCompras(compras, nueva) {
    const coste = (compra) => compra.precio * compra.cantidad
    const totalAntes = compras.reduce((suma, compra) => suma + coste(compra), 0)
    const totalDespues = totalAntes + coste(nueva)
    if (!(totalDespues > 0)) return []

    const filas = compras.map((compra, indice) => ({
        etiqueta: `Compra ${indice + 1}`,
        precio: compra.precio,
        cantidad: compra.cantidad,
        antes: totalAntes > 0 ? coste(compra) / totalAntes : 0,
        despues: coste(compra) / totalDespues,
        simulado: false
    }))
    filas.unshift({
        etiqueta: "Esta compra",
        precio: nueva.precio,
        cantidad: nueva.cantidad,
        antes: 0,
        despues: coste(nueva) / totalDespues,
        simulado: true
    })
    return filas
}

// ── Cartera ────────────────────────────────────────────────────────────────

/**
 * Euros por unidad de `moneda`, o null si no se puede saber.
 *
 * @param {string} moneda Código ISO de la divisa.
 * @returns {Promise<number|null>}
 */
async function hScTipoEur(moneda) {
    if (!moneda || moneda === "EUR") return 1
    // Vive en js/cartera/assets.js, que cachea por par. Si algún día no está, se
    // trata como tipo desconocido en vez de romper la herramienta.
    if (typeof fetchExchangeRateOnServer !== "function") return null
    try {
        return await fetchExchangeRateOnServer(moneda, "EUR")
    } catch (error) {
        console.warn(`Sin tipo de cambio ${moneda}->EUR`, error)
        return null
    }
}

/**
 * Posiciones de la cartera con su valor en euros. Una carga por visita.
 *
 * @returns {Promise<{totalEur: number, sinCambio: number,
 *     posiciones: Map<string, object>}>}
 * @throws {Error} Si no se pueden leer los activos o su rendimiento.
 */
async function hScCargarCartera() {
    if (_hScCartera) return _hScCartera

    const [activos, respuesta] = await Promise.all([hActivos(), fetch("/api/activos/rendimiento-batch")])
    if (!respuesta.ok) throw new Error("rendimiento-batch")
    const rendimiento = await respuesta.json()

    const posiciones = new Map()
    let totalEur = 0
    let sinCambio = 0

    for (const activo of activos) {
        const dato = rendimiento[activo.id] || {}
        const moneda = (activo.currency || "EUR").toUpperCase()
        const netoActual = Number(dato.netoActual) || 0
        let fx = moneda === "EUR" ? 1 : null
        // El tipo implícito en el desglose del servidor es el mismo con el que
        // se valora la cartera: así peso y total cuadran entre sí.
        if (fx === null && dato.divisa?.completo && netoActual > 0) {
            fx = (parseFloat(dato.divisa.valorEur) || 0) / netoActual || null
        }
        if (fx === null && netoActual > 0) fx = await hScTipoEur(moneda)

        let valorEur = netoActual * (fx || 1)
        if (netoActual > 0 && !fx) {
            // Mejor dentro en su moneda, y avisado, que fuera del total.
            sinCambio++
            valorEur = netoActual
        }
        totalEur += valorEur

        const unidades = Math.max(0, Number(dato.participaciones) || 0)
        const precioMedio = Number(dato.precioMedio) || 0
        posiciones.set(activo.id, {
            id: activo.id,
            nombre: activo.name || activo.symbol || activo.id,
            moneda,
            precioMercado: parseEuroNumber(String(activo.price || "0")),
            unidades,
            // Del medio sin redondear y no de `invertidoNeto`, que llega en
            // céntimos: en cripto ese redondeo descuadraba el medio con la ficha.
            invertido: precioMedio > 0 ? precioMedio * unidades : Math.max(0, Number(dato.invertidoNeto) || 0),
            valorEur,
            fx
        })
    }

    _hScCartera = { totalEur, sinCambio, posiciones }
    return _hScCartera
}

// ── Formato ────────────────────────────────────────────────────────────────

function hScMensaje(id, texto, aviso = false) {
    const el = document.getElementById(id)
    if (!el) return
    el.textContent = texto
    el.className = "hPrecargaMsg" + (aviso ? " hRatioFuenteWarn" : "")
}

function hScUds(valor) {
    return valor.toLocaleString(_nl(), { maximumFractionDigits: 8 })
}

function hScPct(fraccion, conSigno = false) {
    const texto = (fraccion * 100).toLocaleString(_nl(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return (conSigno && fraccion > 0 ? "+" : "") + texto + " %"
}

function hScImporte(valor, moneda) {
    // Precios de cripto por debajo del céntimo: con dos decimales saldrían a 0.
    const decimales = Math.abs(valor) > 0 && Math.abs(valor) < 1 ? 6 : 2
    return formatMoneyWithDecimals(valor, moneda, decimales)
}

function hScLeer(id) {
    const texto = document.getElementById(id)?.value ?? ""
    return texto.trim() === "" ? NaN : parseFloat(texto)
}

function hScEscribir(id, valor) {
    const input = document.getElementById(id)
    if (!input) return
    // Sin la cola de decimales del cociente, pero sin perder los de cripto.
    input.value = Number.isFinite(valor) && valor > 0 ? String(parseFloat(valor.toFixed(8))) : ""
}

// ── Panel ──────────────────────────────────────────────────────────────────

function hScIniciar() {
    _hScCartera = null
    _hScUltimo = null
    _hScCompras = new Map()
    hScCambiarModo("auto")

    document.getElementById("hScVistas")?.addEventListener("click", (e) => {
        const boton = e.target.closest("[data-vista]")
        if (boton) hScCambiarVista(boton.dataset.vista)
    })

    document.getElementById("hScModos")?.addEventListener("click", (e) => {
        const boton = e.target.closest("[data-modo]")
        if (boton) hScCambiarModo(boton.dataset.modo)
    })
    document.getElementById("hScActivo")?.addEventListener("change", hScActivoElegido)
    document.getElementById("hScImporte")?.addEventListener("input", hScActualizarEquivalencia)
    document.getElementById("hScPrecio")?.addEventListener("input", hScActualizarEquivalencia)

    // Manual: la cantidad sale de importe y precio, como en el automático, pero
    // también se puede escribir y entonces es el importe el que se recalcula.
    document.getElementById("hScMImporte")?.addEventListener("input", hScManualDesdeImporte)
    document.getElementById("hScMPrecio")?.addEventListener("input", hScManualDesdeImporte)
    document.getElementById("hScMCantidad")?.addEventListener("input", hScManualDesdeCantidad)
    document.getElementById("hScMCargarBtn")?.addEventListener("click", hScManualCargarTotal)

    document.getElementById("hScCalcBtn")?.addEventListener("click", hScCalcularPanel)
}

function hScReiniciar(panelId) {
    if (panelId !== "toolSimularCompra") return
    const select = document.getElementById("hScActivo")
    if (select) select.value = ""
    document.querySelectorAll("#toolSimularCompra .hScMoneda").forEach((el) => {
        el.textContent = "€"
    })
    ;["hScMsg", "hScEquivale", "hScPosicion", "hScMTotalMsg"].forEach((id) => hScMensaje(id, ""))
    _hScUltimo = null
    const reparto = document.getElementById("hScReparto")
    if (reparto) reparto.innerHTML = ""
    hScMensaje("hScRepartoMsg", "")
    document.getElementById("hScNota")?.classList.add("hidden")
}

function hScCambiarModo(modo) {
    _hScModo = modo === "manual" ? "manual" : "auto"
    document.querySelectorAll("#hScModos [data-modo]").forEach((boton) => {
        const activo = boton.dataset.modo === _hScModo
        boton.classList.toggle("active", activo)
        boton.setAttribute("aria-selected", String(activo))
    })
    document.getElementById("hScAuto")?.classList.toggle("hidden", _hScModo !== "auto")
    document.getElementById("hScManual")?.classList.toggle("hidden", _hScModo !== "manual")
    // Los resultados de un modo no describen lo que hay en el otro.
    document.getElementById("hScResults")?.classList.add("hidden")
    hScMensaje("hScMsg", "")
}

async function hScPosicionElegida() {
    const id = document.getElementById("hScActivo")?.value
    if (!id) return null
    const cartera = await hScCargarCartera()
    const posicion = cartera.posiciones.get(id)
    if (!posicion) return null
    // Un activo sin posición no tiene tipo de cambio en el desglose.
    if (posicion.fx === null) posicion.fx = await hScTipoEur(posicion.moneda)
    return posicion
}

async function hScActivoElegido() {
    hScMensaje("hScPosicion", "Cargando…")
    let posicion
    try {
        posicion = await hScPosicionElegida()
    } catch (error) {
        console.error(error)
        hScMensaje("hScPosicion", "No se pudo leer la cartera.", true)
        return
    }
    if (!posicion) {
        hScMensaje("hScPosicion", "")
        return
    }

    const simbolo = posicion.moneda === "EUR" ? "€" : posicion.moneda
    document.querySelectorAll("#hScAuto .hScMoneda").forEach((el) => {
        el.textContent = simbolo
    })
    // El precio de compra más probable es el de mercado guardado; se puede
    // cambiar para simular una orden limitada.
    hScEscribir("hScPrecio", posicion.precioMercado)

    if (posicion.unidades > 0) {
        const medio = posicion.invertido > 0 ? posicion.invertido / posicion.unidades : 0
        hScMensaje(
            "hScPosicion",
            `Tienes ${hScUds(posicion.unidades)} uds` +
                (medio > 0 ? ` a un precio medio de ${hScImporte(medio, posicion.moneda)}.` : ".")
        )
    } else {
        hScMensaje("hScPosicion", "No tienes posición: la compra la abriría.")
    }
    hScActualizarEquivalencia()
}

function hScActualizarEquivalencia() {
    const unidades = hScUnidades(hScLeer("hScImporte"), hScLeer("hScPrecio"))
    if (!Number.isFinite(unidades)) {
        hScMensaje("hScEquivale", "")
        return
    }
    const id = document.getElementById("hScActivo")?.value
    const posicion = id ? _hScCartera?.posiciones.get(id) : null
    let texto = `Equivale a ${hScUds(unidades)} uds.`
    if (posicion && posicion.moneda !== "EUR" && posicion.fx > 0) {
        texto += ` Unos ${formatEuro(hScLeer("hScImporte") * posicion.fx)}.`
    }
    hScMensaje("hScEquivale", texto)
}

function hScManualDesdeImporte() {
    const unidades = hScUnidades(hScLeer("hScMImporte"), hScLeer("hScMPrecio"))
    if (Number.isFinite(unidades)) hScEscribir("hScMCantidad", unidades)
}

function hScManualDesdeCantidad() {
    const cantidad = hScLeer("hScMCantidad")
    const precio = hScLeer("hScMPrecio")
    if (cantidad > 0 && precio > 0) hScEscribir("hScMImporte", cantidad * precio)
}

async function hScManualCargarTotal() {
    hScMensaje("hScMTotalMsg", "Cargando…")
    try {
        const cartera = await hScCargarCartera()
        const input = document.getElementById("hScMTotal")
        if (input) input.value = cartera.totalEur.toFixed(2)
        hScMensaje("hScMTotalMsg", `Valor de tu cartera: ${formatEuro(cartera.totalEur)}.`)
    } catch (error) {
        console.error(error)
        hScMensaje("hScMTotalMsg", "No se pudo leer la cartera.", true)
    }
}

async function hScDatosAuto() {
    let posicion
    try {
        posicion = await hScPosicionElegida()
    } catch (error) {
        console.error(error)
        return { error: "No se pudo leer la cartera." }
    }
    if (!posicion) return { error: "Elige antes un activo." }
    if (!(posicion.fx > 0)) {
        return { error: `No hay tipo de cambio de ${posicion.moneda} a EUR: no se puede medir el peso.` }
    }

    const precioCompra = hScLeer("hScPrecio")
    const unidadesCompra = hScUnidades(hScLeer("hScImporte"), precioCompra)
    if (!Number.isFinite(unidadesCompra)) return { error: "Pon lo que inviertes y un precio de compra mayor que cero." }

    return {
        posicion,
        moneda: posicion.moneda,
        entrada: {
            unidades: posicion.unidades,
            invertido: posicion.invertido,
            precioMercado: posicion.precioMercado,
            precioCompra,
            unidadesCompra,
            fx: posicion.fx,
            totalCarteraEur: _hScCartera.totalEur
        }
    }
}

function hScDatosManual() {
    const unidades = hScLeer("hScMUnidades") || 0
    const medio = hScLeer("hScMMedio") || 0
    if (unidades > 0 && !(medio > 0)) return { error: "Si ya tienes unidades, pon también su precio medio." }

    const precioCompra = hScLeer("hScMPrecio")
    const unidadesCompra = hScLeer("hScMCantidad")
    if (!(precioCompra > 0) || !(unidadesCompra > 0)) {
        return { error: "Pon el precio de compra y la cantidad (o lo que inviertes)." }
    }

    return {
        posicion: null,
        moneda: "EUR",
        entrada: {
            unidades,
            invertido: unidades * medio,
            precioMercado: hScLeer("hScMMercado"),
            precioCompra,
            unidadesCompra,
            fx: 1,
            totalCarteraEur: hScLeer("hScMTotal") || 0
        }
    }
}

async function hScCalcularPanel() {
    const datos = _hScModo === "auto" ? await hScDatosAuto() : hScDatosManual()
    if (datos.error) {
        hScMensaje("hScMsg", datos.error, true)
        return
    }
    const r = hScCalcular(datos.entrada)
    if (!r) {
        hScMensaje("hScMsg", "Revisa los datos: tienen que ser números positivos.", true)
        return
    }
    hScMensaje(
        "hScMsg",
        datos.posicion && _hScCartera.sinCambio
            ? `${_hScCartera.sinCambio} activo(s) sin tipo de cambio cuentan en su moneda: el peso es aproximado.`
            : "",
        Boolean(datos.posicion && _hScCartera.sinCambio)
    )

    hScPintar(r, datos)
    _hScUltimo = { posicion: datos.posicion, entrada: datos.entrada, r }
    hScPintarReparto()
    document.getElementById("hScResults")?.classList.remove("hidden")
}

function hScPintarTarjeta(idValor, idDetalle, valor, detalle, clase = "") {
    const el = document.getElementById(idValor)
    if (el) {
        el.textContent = valor
        el.className = "hResultValue" + (clase ? " " + clase : "")
    }
    const sub = document.getElementById(idDetalle)
    if (sub) sub.textContent = detalle
}

function hScPintar(r, { moneda, entrada }) {
    const dinero = (valor) => hScImporte(valor, moneda)
    const tono = (valor) => (valor >= 0 ? "hResultPositive" : "hResultNegative")

    hScPintarTarjeta(
        "hScUnidadesRes",
        "hScUnidadesSub",
        hScUds(entrada.unidadesCompra),
        `por ${dinero(r.importe)} a ${dinero(entrada.precioCompra)}`,
        "hResultPositive"
    )
    hScPintarTarjeta(
        "hScMedioRes",
        "hScMedioSub",
        dinero(r.medioDespues),
        r.medioAntes ? `antes ${dinero(r.medioAntes)} (${hScPct(r.variacionMedio, true)})` : "posición nueva"
    )
    hScPintarTarjeta(
        "hScPesoCompraRes",
        "hScPesoCompraSub",
        hScPct(r.pesoCompraCoste),
        `del invertido · ${hScPct(r.pesoCompraUnidades)} de las unidades`
    )
    hScPintarTarjeta(
        "hScPesoRes",
        "hScPesoSub",
        hScPct(r.pesoDespues),
        `antes ${hScPct(r.pesoAntes)}`,
        r.pesoDespues > H_SC_PESO_CONCENTRACION ? "hResultNegative" : ""
    )
    hScPintarTarjeta(
        "hScPosRes",
        "hScPosSub",
        `${hScUds(r.unidadesDespues)} uds`,
        `antes ${hScUds(entrada.unidades)} uds`
    )
    hScPintarTarjeta(
        "hScInvRes",
        "hScInvSub",
        dinero(r.invertidoDespues),
        `valor a mercado ${dinero(r.valorDespues)}`
    )
    hScPintarTarjeta(
        "hScRentRes",
        "hScRentSub",
        hScPct(r.rentDespuesPct, true),
        `${dinero(r.rentDespues)} · ` +
            (r.rentAntesPct === null ? "sin posición previa" : `antes ${hScPct(r.rentAntesPct, true)}`),
        tono(r.rentDespues)
    )
    hScPintarTarjeta("hScTotalRes", "hScTotalSub", formatEuro(r.totalDespuesEur), `antes ${formatEuro(r.totalAntesEur)}`)

    hScPintarNota(r, entrada)
}

function hScPintarNota(r, entrada) {
    const nota = document.getElementById("hScNota")
    if (!nota) return
    const textos = []
    let positiva = true

    if (r.medioAntes === null) {
        textos.push("Abres una posición nueva: el precio medio es el de esta compra.")
    } else if (entrada.precioCompra < r.medioAntes) {
        textos.push(`Compras por debajo de tu precio medio: lo bajas un ${hScPct(-r.variacionMedio)}.`)
    } else if (entrada.precioCompra > r.medioAntes) {
        textos.push(`Compras por encima de tu precio medio: lo subes un ${hScPct(r.variacionMedio)}.`)
        positiva = false
    }
    if (r.pesoDespues > H_SC_PESO_CONCENTRACION) {
        textos.push(
            `Tras la compra este activo pesa más del ${hScPct(H_SC_PESO_CONCENTRACION)} de la cartera: ` +
                "una caída suya se notaría mucho en el total."
        )
        positiva = false
    }

    nota.textContent = textos.join(" ")
    nota.className = "hRatioInterpretacion " + (positiva ? "hRatioInfoPos" : "hRatioInfoNeg")
    nota.classList.toggle("hidden", textos.length === 0)
}

function hScCambiarVista(vista) {
    _hScVista = vista === "activo" ? "activo" : "cartera"
    document.querySelectorAll("#hScVistas [data-vista]").forEach((boton) => {
        const activo = boton.dataset.vista === _hScVista
        boton.classList.toggle("active", activo)
        boton.setAttribute("aria-selected", String(activo))
    })
    hScPintarReparto()
}

async function hScComprasGuardadas(assetId) {
    // Se guarda la promesa y no el resultado: dos clics seguidos no piden dos
    // veces. Si falla, se olvida para poder reintentar.
    if (!_hScCompras.has(assetId)) {
        _hScCompras.set(
            assetId,
            hComprasDeActivo(assetId).catch((error) => {
                _hScCompras.delete(assetId)
                throw error
            })
        )
    }
    return _hScCompras.get(assetId)
}

function hScPintarFilas(cabeceras, filas) {
    const cabecera = document.getElementById("hScRepartoCab")
    const cuerpo = document.getElementById("hScReparto")
    if (!cabecera || !cuerpo) return
    cabecera.innerHTML = ""
    cabeceras.forEach((texto) => {
        const th = document.createElement("th")
        th.textContent = texto
        cabecera.appendChild(th)
    })
    cuerpo.innerHTML = ""
    filas.forEach(({ celdas, resaltada }) => {
        const tr = document.createElement("tr")
        celdas.forEach(({ texto, clase }, indice) => {
            const td = document.createElement("td")
            if (indice === 0 && resaltada) {
                const fuerte = document.createElement("strong")
                fuerte.textContent = texto
                td.appendChild(fuerte)
            } else {
                td.textContent = texto
            }
            if (clase) td.className = clase
            tr.appendChild(td)
        })
        cuerpo.appendChild(tr)
    })
}

function hScCeldaCambio(antes, despues) {
    const cambio = despues - antes
    return {
        texto: hScPct(cambio, true).replace("%", "p.p."),
        clase: Math.abs(cambio) < 0.00005 ? "" : cambio > 0 ? "hDivPos" : "hDivNeg"
    }
}

async function hScPintarReparto() {
    const bloque = document.getElementById("hScRepartoCard")
    const titulo = document.getElementById("hScRepartoTitulo")
    if (!bloque) return
    const posicion = _hScUltimo?.posicion
    // En el manual no se sabe a qué activo de la cartera corresponde la compra.
    bloque.classList.toggle("hidden", !posicion)
    hScMensaje("hScRepartoMsg", "")
    if (!posicion) return

    if (_hScVista === "cartera") {
        if (titulo) titulo.textContent = "Reparto de la cartera"
        hScPintarRepartoCartera()
    } else {
        if (titulo) titulo.textContent = `Reparto de ${posicion.nombre}`
        await hScPintarRepartoActivo()
    }
}

function hScPintarRepartoCartera() {
    const { posicion, r } = _hScUltimo
    const extraEur = r.totalDespuesEur - r.totalAntesEur
    const filas = hScRepartos([..._hScCartera.posiciones.values()], posicion.id, extraEur)
    hScPintarFilas(
        ["Activo", "Peso antes", "Peso después", "Cambio"],
        filas.map((fila) => ({
            resaltada: fila.simulado,
            celdas: [
                { texto: fila.nombre },
                { texto: hScPct(fila.antes) },
                { texto: hScPct(fila.despues) },
                hScCeldaCambio(fila.antes, fila.despues)
            ]
        }))
    )
}

async function hScPintarRepartoActivo() {
    const { posicion, entrada } = _hScUltimo
    const cabeceras = ["Compra", "Precio", "Cantidad", "Peso antes", "Peso después"]
    hScPintarFilas(cabeceras, [])
    hScMensaje("hScRepartoMsg", "Cargando compras…")

    let compras
    try {
        compras = await hScComprasGuardadas(posicion.id)
    } catch (error) {
        console.error(error)
        hScMensaje("hScRepartoMsg", "No se pudieron cargar las compras del activo.", true)
        return
    }
    // Mientras cargaba se pudo volver a «Cartera» o recalcular otro activo.
    if (_hScVista !== "activo" || _hScUltimo?.posicion?.id !== posicion.id) return

    const nueva = { precio: entrada.precioCompra, cantidad: entrada.unidadesCompra }
    const filas = hScRepartoCompras(compras, nueva)
    hScPintarFilas(
        cabeceras,
        filas.map((fila) => ({
            resaltada: fila.simulado,
            celdas: [
                { texto: fila.etiqueta },
                { texto: hScImporte(fila.precio, posicion.moneda) },
                { texto: hScUds(fila.cantidad) },
                { texto: fila.simulado ? "—" : hScPct(fila.antes) },
                { texto: hScPct(fila.despues), clase: fila.simulado ? "hDivPos" : "" }
            ]
        }))
    )

    // Las compras guardadas incluyen las de unidades que ya no están (vendidas,
    // enviadas): entonces los pesos son sobre todo lo comprado, no sobre lo vivo.
    const comprado = compras.reduce((suma, compra) => suma + compra.cantidad, 0)
    if (!compras.length) {
        hScMensaje("hScRepartoMsg", "No hay compras guardadas de este activo: esta sería la primera.")
    } else if (Math.abs(comprado - posicion.unidades) > Math.max(1e-8, posicion.unidades * 1e-6)) {
        hScMensaje(
            "hScRepartoMsg",
            `Compraste ${hScUds(comprado)} uds y te quedan ${hScUds(posicion.unidades)}: ` +
                "los pesos son sobre todo lo comprado, también lo ya vendido o enviado.",
            true
        )
    } else {
        hScMensaje("hScRepartoMsg", "Peso por coste: lo que pagaste en cada compra sobre el total invertido.")
    }
}
