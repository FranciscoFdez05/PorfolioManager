// Análisis > Herramientas: calculadora de metales preciosos.
//
// Trozo de js/analisis/herramientas.js. Comparte con el resto de herramientas-*.js el
// ámbito global y se carga detrás de herramientas.js, en el orden de index.html.

// ── Metales preciosos ──────────────────────────────────────────────────────
// Valor de una cantidad de oro o plata en gramos, kilos u onzas. El precio del
// metal se cotiza siempre por onza troy (31,1034768 g, no la onza avoirdupois
// de 28,35 g), y por metal fino: una pieza de ley 750 (oro de 18 k) solo vale
// el 75 % de su peso.

const H_MET_GRAMOS_ONZA_TROY = 31.1034768
const H_MET_GRAMOS_POR_UNIDAD = { g: 1, kg: 1000, oz: H_MET_GRAMOS_ONZA_TROY }

// Los mismos tickers que ya usa la capitalización objetivo para el oro: TVC
// publica el contado en USD por onza troy.
const H_MET_METALES = {
    oro: { nombre: "Oro", ticker: "TVC:GOLD" },
    plata: { nombre: "Plata", ticker: "TVC:SILVER" }
}

// Purezas habituales de cada metal, de más a menos pura; la primera es la que
// se elige por defecto. `ley` en milésimas es lo que usa el cálculo, pero al
// usuario se le muestra en quilates o en porcentaje, que es como lo conoce.
// El metal de inversión (999,9) se valora al precio de la onza: la cotización
// ya se refiere a ese grado, así que cuenta como 1000.
const H_MET_PUREZAS = {
    oro: [
        { ley: 1000, texto: "24 k · puro (lingotes y monedas de inversión)" },
        { ley: 916.7, texto: "22 k · 91,7 % (monedas)" },
        { ley: 750, texto: "18 k · 75 % (joyería)" },
        { ley: 585, texto: "14 k · 58,5 %" },
        { ley: 375, texto: "9 k · 37,5 %" }
    ],
    plata: [
        { ley: 1000, texto: "Fina · 99,9 % (lingotes y monedas de inversión)" },
        { ley: 925, texto: "De ley · 92,5 % (joyería y cubertería)" },
        { ley: 900, texto: "90 % (monedas antiguas)" },
        { ley: 800, texto: "80 %" }
    ]
}

/**
 * Pasa una cantidad a gramos.
 *
 * @param {number} cantidad Cantidad en la unidad indicada.
 * @param {"g"|"kg"|"oz"} unidad Gramos, kilos u onzas troy.
 * @returns {number} Gramos, o NaN si la unidad no existe.
 */
function hMetAGramos(cantidad, unidad) {
    const factor = H_MET_GRAMOS_POR_UNIDAD[unidad]
    return factor ? cantidad * factor : NaN
}

/**
 * Valor del metal fino que contiene una cantidad.
 *
 * @param {{cantidad: number, unidad: string, ley: number, precioOnza: number}} datos
 *     Ley en milésimas (1000 = puro, 750 = 18 k) y precio por onza troy.
 * @returns {{gramosFinos: number, onzasFinas: number, precioGramo: number,
 *     precioKilo: number, valor: number} | null} null si algún dato no es válido.
 */
function hMetCalcularValor({ cantidad, unidad, ley, precioOnza }) {
    const gramos = hMetAGramos(cantidad, unidad)
    if (!(gramos > 0) || !(ley > 0) || ley > 1000 || !(precioOnza > 0)) return null

    const gramosFinos = gramos * (ley / 1000)
    const onzasFinas = gramosFinos / H_MET_GRAMOS_ONZA_TROY
    const precioGramo = precioOnza / H_MET_GRAMOS_ONZA_TROY
    return {
        gramosFinos,
        onzasFinas,
        precioGramo,
        precioKilo: precioGramo * 1000,
        valor: onzasFinas * precioOnza
    }
}

/**
 * Cantidad de metal que se compra con un importe, en la unidad indicada.
 *
 * Es la inversa de hMetCalcularValor: el importe paga metal fino, y con una ley
 * menor de 1000 la pieza tiene que pesar más para contenerlo (1000 EUR de oro
 * de 18 k son más gramos que 1000 EUR de oro puro).
 *
 * @param {{importe: number, unidad: string, ley: number, precioOnza: number}} datos
 *     Importe en la moneda del precio, ley en milésimas y precio por onza troy.
 * @returns {{cantidad: number, gramosFinos: number, onzasFinas: number,
 *     precioGramo: number, precioKilo: number, valor: number} | null}
 *     Cantidad bruta en la unidad pedida más el desglose de hMetCalcularValor,
 *     o null si algún dato no es válido.
 *
 * @example
 * hMetCalcularCantidad({ importe: 2500, unidad: "oz", ley: 1000, precioOnza: 2500 }).cantidad // 1
 */
function hMetCalcularCantidad({ importe, unidad, ley, precioOnza }) {
    const factor = H_MET_GRAMOS_POR_UNIDAD[unidad]
    if (!factor || !(importe > 0) || !(ley > 0) || ley > 1000 || !(precioOnza > 0)) return null

    const gramosFinos = (importe / precioOnza) * H_MET_GRAMOS_ONZA_TROY
    const cantidad = gramosFinos / (ley / 1000) / factor
    return { cantidad, ...hMetCalcularValor({ cantidad, unidad, ley, precioOnza }) }
}

// Campo que manda en el cálculo: el último que escribió el usuario. El otro se
// rellena con el resultado; recalcular desde él cambiaría lo que acaba de escribir
// por un valor redondeado.
let _hMetOrigen = "peso"
// Cambiar de metal con una consulta en vuelo: la respuesta del anterior ya no vale.
let _hMetToken = 0

function hMetIniciar() {
    _hMetOrigen = "peso"
    _hMetToken++

    document.getElementById("hMetCargarBtn")?.addEventListener("click", hMetCargarPrecio)
    document.getElementById("hMetCantidad")?.addEventListener("input", () => {
        _hMetOrigen = "peso"
        hMetCalcular()
    })
    document.getElementById("hMetImporte")?.addEventListener("input", () => {
        _hMetOrigen = "importe"
        hMetCalcular()
    })
    document.getElementById("hMetPrecio")?.addEventListener("input", hMetCalcular)
    ;["hMetUnidad", "hMetPureza"].forEach((id) => document.getElementById(id)?.addEventListener("change", hMetCalcular))
    // Cambiar de metal deja el precio del otro en el campo: se vacía para no
    // calcular plata a precio de oro, y se pide el del nuevo.
    document.getElementById("hMetMetal")?.addEventListener("change", () => {
        hMetRellenarPurezas()
        document.getElementById("hMetPrecio").value = ""
        hMetCalcular()
        hMetCargarPrecio()
    })
    hMetRellenarPurezas()
}

// Opciones de pureza del metal elegido, con la más pura seleccionada: una
// pureza de oro (18 k) no tiene sentido para la plata.
function hMetRellenarPurezas() {
    const select = document.getElementById("hMetPureza")
    const purezas = H_MET_PUREZAS[document.getElementById("hMetMetal")?.value]
    if (!select || !purezas) return

    select.innerHTML = ""
    purezas.forEach(({ ley, texto }) => {
        const opcion = document.createElement("option")
        opcion.value = String(ley)
        opcion.textContent = texto
        select.appendChild(opcion)
    })
    select.value = String(purezas[0].ley)
    // El desplegable personalizado de la app repinta su etiqueta con "change".
    select.dispatchEvent(new Event("change"))
}

function hMetMoneda() {
    return String(window._monedaBase || "EUR").toUpperCase()
}

// Se llama al abrir la herramienta: el precio se pide entonces y no al cargar la
// página, para no consultar TradingView a quien nunca la usa. Si ya hay precio
// (cargado o escrito a mano) se respeta.
function hMetAlAbrir() {
    const moneda = hMetMoneda()
    document.querySelectorAll(".hMetMonedaLabel").forEach((el) => {
        el.textContent = moneda
    })
    if (!document.getElementById("hMetPrecio")?.value) hMetCargarPrecio()
}

// Tras el botón Reiniciar, que ya devolvió los campos a su valor inicial y por
// tanto dejó el precio vacío.
function hMetReiniciar() {
    _hMetOrigen = "peso"
    hMetMensaje("", "")
    hMetRellenarPurezas()
    hMetCargarPrecio()
}

function hMetMensaje(texto, tipo) {
    const el = document.getElementById("hMetFuenteMsg")
    if (!el) return
    el.textContent = texto
    el.className = "hRatioFuenteMsg" + (tipo === "ok" ? " hRatioFuenteOk" : tipo === "aviso" ? " hRatioFuenteWarn" : "")
}

async function hMetCargarPrecio() {
    const metal = H_MET_METALES[document.getElementById("hMetMetal").value]
    const btn = document.getElementById("hMetCargarBtn")
    const moneda = hMetMoneda()
    if (!metal || !btn) return

    const token = ++_hMetToken
    btn.disabled = true
    hMetMensaje("Consultando " + metal.nombre.toLowerCase() + "...", "")
    try {
        const d = await hCapConsultar(metal.ticker)
        const divisa = String(d.divisa || "USD").toUpperCase()
        let precio = d.precio
        if (divisa !== moneda) {
            const res = await fetch(
                `/api/exchange-rate?from=${encodeURIComponent(divisa)}&to=${encodeURIComponent(moneda)}`
            )
            const cambio = await res.json()
            if (!cambio.ok) throw new Error(cambio.error || `No se pudo convertir de ${divisa} a ${moneda}.`)
            precio *= cambio.rate
        }
        if (token !== _hMetToken) return
        document.getElementById("hMetPrecio").value = precio.toFixed(2)
        hMetMensaje(
            `${metal.nombre} (${metal.ticker}): ${d.precio.toFixed(2)} ${divisa}/oz` +
                (divisa !== moneda ? ` → ${precio.toFixed(2)} ${moneda}/oz` : ""),
            "ok"
        )
        hMetCalcular()
    } catch (error) {
        if (token === _hMetToken) hMetMensaje(error?.message || "No se pudo obtener el precio.", "aviso")
    } finally {
        if (token === _hMetToken) btn.disabled = false
    }
}

// Calcula desde el campo que manda (_hMetOrigen) y rellena el otro: peso →
// importe o importe → peso. Sin datos suficientes vacía el campo derivado y
// oculta los resultados en vez de dejar los de un cálculo anterior.
function hMetCalcular() {
    const leer = (id) => parseFloat(document.getElementById(id).value)
    const datos = {
        unidad: document.getElementById("hMetUnidad").value,
        ley: leer("hMetPureza"),
        precioOnza: leer("hMetPrecio")
    }
    const desdeImporte = _hMetOrigen === "importe"
    const resultado = desdeImporte
        ? hMetCalcularCantidad({ ...datos, importe: leer("hMetImporte") })
        : hMetCalcularValor({ ...datos, cantidad: leer("hMetCantidad") })

    const derivado = document.getElementById(desdeImporte ? "hMetCantidad" : "hMetImporte")
    const resultados = document.getElementById("hMetResults")
    if (!resultado) {
        derivado.value = ""
        resultados.classList.add("hidden")
        return
    }
    // Seis cifras significativas: 0,0278 kg o 277,778 g, sin arrastrar decimales
    // de coma flotante al campo.
    derivado.value = desdeImporte ? String(Number(resultado.cantidad.toPrecision(6))) : resultado.valor.toFixed(2)

    const moneda = hMetMoneda()
    const dinero = (valor) =>
        valor.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " " + moneda
    const numero = (valor, decimales) =>
        valor.toLocaleString("es-ES", { minimumFractionDigits: decimales, maximumFractionDigits: decimales })

    document.getElementById("hMetValor").textContent = dinero(resultado.valor)
    document.getElementById("hMetOnzas").textContent = numero(resultado.onzasFinas, 4) + " oz"
    document.getElementById("hMetGramos").textContent = numero(resultado.gramosFinos, 2) + " g"
    document.getElementById("hMetPrecioGramo").textContent = dinero(resultado.precioGramo) + "/g"
    // Con una pureza menor, aclarar por qué el valor no es peso × precio.
    const pureza =
        datos.ley < 1000
            ? `La pieza tiene un ${(datos.ley / 10).toLocaleString("es-ES", { maximumFractionDigits: 1 })} % de metal puro y solo esa parte tiene valor.  ·  `
            : ""
    document.getElementById("hMetNota").textContent =
        pureza +
        `Metal puro: 1 oz troy = ${dinero(resultado.precioGramo * H_MET_GRAMOS_ONZA_TROY)}` +
        `  ·  1 kg = ${dinero(resultado.precioKilo)}`
    resultados.classList.remove("hidden")
}
