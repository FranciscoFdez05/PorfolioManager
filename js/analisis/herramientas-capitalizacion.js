// Análisis > Herramientas: capitalización objetivo.
//
// Trozo de js/analisis/herramientas.js. Comparte con el resto de herramientas-*.js el
// ámbito global y se carga detrás de herramientas.js, en el orden de index.html.

// ── Capitalización objetivo ────────────────────────────────────────────────
// Precio, suministro y capitalización salen del scanner de TradingView para el
// ticker que elige el usuario. Lo que no publica (el oro no tiene
// capitalización) se pide a mano: aquí no hay tablas de activos ni cifras fijas.

let _hCapActivo = null // { ticker, nombre, divisa } del activo cuyo precio se estudia
let _hCapRefs = [] // [{ nombre, ticker|null, divisa, capital }]

// Referencias que siempre están, escritas en el código a propósito: son con lo
// que casi cualquier capitalización se compara, y no hace falta buscarlas cada
// vez. El usuario añade las suyas aparte (se guardan en _hCapRefs).
//   · Bitcoin: la capitalización la publica TradingView, se pide en vivo.
//   · Oro: nadie publica su capitalización, así que se calcula como las onzas
//     que se han extraído en toda la historia por el precio de la onza (también
//     en vivo). ~216.265 toneladas (World Gold Council, 2023) son ~6.953 millones
//     de onzas troy; es una estimación y crece un 1 % al año aproximadamente.
const H_CAP_ORO_ONZAS = 6.953e9
const H_CAP_REFS_FIJAS = [
    { id: "bitcoin", nombre: "Bitcoin", ticker: "BITSTAMP:BTCUSD", origen: "Capitalización en vivo de TradingView" },
    {
        id: "oro",
        nombre: "Oro",
        ticker: "TVC:GOLD",
        onzas: H_CAP_ORO_ONZAS,
        origen: "Todo el oro extraído (~216.000 t, World Gold Council 2023) × precio de la onza en vivo"
    }
]
function hCapEsFija(ticker) {
    return Boolean(ticker) && H_CAP_REFS_FIJAS.some((ref) => ref.ticker === String(ticker).toUpperCase())
}

const H_CAP_FIJAS_CADUCIDAD_MS = 5 * 60 * 1000
let _hCapFijas = [] // las de arriba más lo que se ha cargado: divisa, capital y estado
let _hCapFijasHora = 0

function hCapIniciar() {
    _hCapActivo = null
    const guardadas = Array.isArray(getChartPref("hCapRefs")) ? getChartPref("hCapRefs") : []
    // Una referencia guardada que ahora es una de las fijas (Bitcoin, por
    // ejemplo, que antes había que buscar) se quita: saldría dos veces.
    _hCapRefs = guardadas.filter((ref) => !hCapEsFija(ref.ticker))
    if (_hCapRefs.length !== guardadas.length) setChartPref("hCapRefs", _hCapRefs)
    _hCapFijas = H_CAP_REFS_FIJAS.map((ref) => ({ ...ref, divisa: "USD", capital: 0, estado: "cargando" }))
    _hCapFijasHora = 0
    hCapRenderRefs()
    hCapPonerDivisa("")
    // En segundo plano: la página no espera a TradingView para abrirse.
    hCapCargarFijas()

    document
        .getElementById("hCapBuscarBtn")
        ?.addEventListener("click", () => hCapBuscar("hCapBuscarInput", "hCapResultados", hCapElegirActivo))
    document
        .getElementById("hCapRefBuscarBtn")
        ?.addEventListener("click", () => hCapBuscar("hCapRefBuscarInput", "hCapRefResultados", hCapAnadirRef))
    document.getElementById("hCapRefManualBtn")?.addEventListener("click", hCapAnadirRefManual)
    document.getElementById("hCapCalcBtn")?.addEventListener("click", hCapCalcular)

    // En estos campos Enter busca o añade: el Enter global pulsaría Calcular.
    ;[
        ["hCapBuscarInput", "hCapBuscarBtn"],
        ["hCapRefBuscarInput", "hCapRefBuscarBtn"],
        ["hCapRefNombre", "hCapRefManualBtn"],
        ["hCapRefCapital", "hCapRefManualBtn"]
    ].forEach(([inputId, btnId]) => {
        document.getElementById(inputId)?.addEventListener("keydown", (e) => {
            if (e.key !== "Enter") return
            e.stopPropagation()
            document.getElementById(btnId)?.click()
        })
    })
}

function hCapReiniciar() {
    _hCapActivo = null
    hCapPonerDivisa("")
    document.getElementById("hCapActivoMsg").textContent = ""
    document.getElementById("hCapRefMsg").textContent = ""
    ;["hCapResultados", "hCapRefResultados"].forEach((id) => {
        const lista = document.getElementById(id)
        lista.classList.add("hidden")
        lista.replaceChildren()
    })
    ;["hCapBuscarInput", "hCapRefBuscarInput", "hCapRefNombre"].forEach((id) => {
        document.getElementById(id).value = ""
    })
    // Las referencias son una preferencia guardada: reiniciar no las borra, pero
    // el reinicio de inputs de la página sí les vacía el campo.
    hCapRenderRefs()
}

function hCapPonerDivisa(divisa) {
    document.querySelectorAll(".hCapDivisa").forEach((el) => {
        el.textContent = divisa || "divisa"
    })
}

function hCapMensaje(id, texto, tipo) {
    const el = document.getElementById(id)
    el.textContent = texto
    el.className = "hRatioFuenteMsg" + (tipo === "ok" ? " hRatioFuenteOk" : tipo === "aviso" ? " hRatioFuenteWarn" : "")
}

function hCapNota(texto) {
    return Object.assign(document.createElement("div"), { className: "hCapNota", textContent: texto })
}

async function hCapBuscar(inputId, listaId, alElegir) {
    const texto = document.getElementById(inputId).value.trim()
    const lista = document.getElementById(listaId)
    if (!texto) return

    lista.classList.remove("hidden")
    lista.replaceChildren(hCapNota("Buscando..."))

    let resultados
    try {
        const res = await fetch(`/api/tradingview/search?q=${encodeURIComponent(texto)}`)
        const data = await res.json()
        if (!data.ok) throw new Error(data.error)
        resultados = data.results || []
    } catch (error) {
        lista.replaceChildren(hCapNota(error.message || "No se pudo buscar."))
        return
    }

    if (resultados.length === 0) {
        lista.replaceChildren(hCapNota("Sin resultados."))
        return
    }

    lista.replaceChildren(
        ...resultados.map((r) => {
            const btn = document.createElement("button")
            btn.type = "button"
            btn.className = "hCapResultado"
            const simbolo = document.createElement("strong")
            simbolo.textContent = r.symbol
            const desc = document.createElement("span")
            desc.textContent = r.description
            btn.append(simbolo, desc)
            btn.addEventListener("click", () => {
                lista.classList.add("hidden")
                lista.replaceChildren()
                alElegir(r)
            })
            return btn
        })
    )
}

async function hCapConsultar(ticker) {
    const res = await fetch(`/api/herramientas/capitalizacion?ticker=${encodeURIComponent(ticker)}`)
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || "No se pudo consultar el activo.")
    return data
}

async function hCapElegirActivo(resultado) {
    hCapMensaje("hCapActivoMsg", "Cargando " + resultado.symbol + "...")
    try {
        const d = await hCapConsultar(resultado.symbol)
        _hCapActivo = {
            ticker: d.ticker,
            nombre: d.nombre || resultado.description,
            divisa: d.divisa || resultado.currency || ""
        }
        hCapPonerDivisa(_hCapActivo.divisa)
        document.getElementById("hCapPrecio").value = d.precio
        document.getElementById("hCapSuministro").value = d.suministro || ""

        const partes = [`${_hCapActivo.nombre} (${d.ticker})`]
        if (!d.suministro) partes.push("TradingView no publica su suministro: introdúcelo a mano")
        hCapMensaje("hCapActivoMsg", partes.join("  ·  "), d.suministro ? "ok" : "aviso")
    } catch (error) {
        hCapMensaje("hCapActivoMsg", error.message, "aviso")
    }
}

async function hCapCargarFijas() {
    const fijas = _hCapFijas
    await Promise.all(
        fijas.map(async (ref) => {
            try {
                const d = await hCapConsultar(ref.ticker)
                ref.divisa = d.divisa || "USD"
                ref.capital = ref.onzas ? d.precio * ref.onzas : d.capitalizacion || 0
                ref.estado = ref.capital > 0 ? "ok" : "error"
            } catch {
                ref.capital = 0
                ref.estado = "error"
            }
        })
    )
    // Si mientras tanto se reabrió la página, estas son las de una visita vieja.
    if (fijas !== _hCapFijas) return
    _hCapFijasHora = Date.now()
    hCapRenderRefs()
}

// Las referencias que vienen de una búsqueda guardaron la capitalización de ese
// día: al calcular se vuelve a pedir, salvo las que el usuario escribió a mano.
async function hCapRefrescarPropias() {
    await Promise.all(
        _hCapRefs
            .filter((ref) => ref.ticker && !ref.manual)
            .map(async (ref) => {
                try {
                    const d = await hCapConsultar(ref.ticker)
                    if (d.capitalizacion > 0) {
                        ref.capital = d.capitalizacion
                        ref.divisa = d.divisa || ref.divisa
                    }
                } catch {
                    /* sin red: se queda con el valor guardado */
                }
            })
    )
    hCapGuardarRefs()
    hCapRenderRefs()
}

function hCapGuardarRefs() {
    setChartPref("hCapRefs", _hCapRefs)
}

async function hCapAnadirRef(resultado) {
    if (hCapEsFija(resultado.symbol)) {
        hCapMensaje("hCapRefMsg", "Esa ya está entre las referencias fijas.", "aviso")
        return
    }
    hCapMensaje("hCapRefMsg", "Cargando " + resultado.symbol + "...")
    try {
        const d = await hCapConsultar(resultado.symbol)
        _hCapRefs = _hCapRefs.filter((r) => r.ticker !== d.ticker)
        _hCapRefs.push({
            nombre: d.nombre || resultado.description,
            ticker: d.ticker,
            divisa: d.divisa || "USD",
            capital: d.capitalizacion || 0
        })
        hCapGuardarRefs()
        hCapRenderRefs()
        hCapMensaje(
            "hCapRefMsg",
            d.capitalizacion
                ? ""
                : "TradingView no publica la capitalización de ese activo: escríbela a mano en su fila.",
            d.capitalizacion ? "" : "aviso"
        )
    } catch (error) {
        hCapMensaje("hCapRefMsg", error.message, "aviso")
    }
}

function hCapAnadirRefManual() {
    const nombre = document.getElementById("hCapRefNombre").value.trim()
    const capital = parseFloat(document.getElementById("hCapRefCapital").value) || 0
    if (!nombre || capital <= 0) {
        hCapMensaje("hCapRefMsg", "Indica un nombre y una capitalización mayor que cero.", "aviso")
        return
    }
    _hCapRefs.push({ nombre, ticker: null, divisa: window._monedaBase || "EUR", capital })
    hCapGuardarRefs()
    hCapRenderRefs()
    document.getElementById("hCapRefNombre").value = ""
    document.getElementById("hCapRefCapital").value = ""
    hCapMensaje("hCapRefMsg", "")
}

function hCapRenderRefs() {
    const lista = document.getElementById("hCapRefLista")
    if (!lista) return

    const grupo = (texto) =>
        Object.assign(document.createElement("div"), { className: "hCapRefGrupo", textContent: texto })

    const filasFijas = _hCapFijas.map((ref) => {
        const fila = document.createElement("div")
        fila.className = "hCapRef hCapRefFija"
        fila.title = ref.origen

        const info = document.createElement("div")
        info.className = "hCapRefInfo"
        const nombre = document.createElement("span")
        nombre.className = "hCapRefNombre"
        nombre.textContent = ref.nombre
        const etiqueta = document.createElement("small")
        etiqueta.textContent =
            ref.estado === "ok" ? "En vivo" : ref.estado === "cargando" ? "Consultando…" : "No disponible ahora"
        info.append(nombre, etiqueta)

        const valor = document.createElement("span")
        valor.className = "hCapRefValor" + (ref.estado === "error" ? " hCapRefSinDato" : "")
        valor.textContent =
            ref.estado === "cargando" ? "…" : ref.estado === "error" ? "Sin dato" : hCapFmt(ref.capital, ref.divisa)
        if (ref.estado === "ok") valor.title = hCapFmtCompleto(ref.capital, ref.divisa)

        fila.append(info, valor)
        return fila
    })

    const propias = _hCapRefs.map((ref, i) => {
        const completa = ref.capital > 0
        const fila = document.createElement("div")
        fila.className = "hCapRef hCapRefPropia" + (completa ? "" : " hCapRefIncompleta")

        const info = document.createElement("div")
        info.className = "hCapRefInfo"
        const nombre = document.createElement("span")
        nombre.className = "hCapRefNombre"
        nombre.textContent = ref.nombre
        nombre.title = ref.nombre
        const etiqueta = document.createElement("small")
        etiqueta.textContent = ref.ticker
            ? ref.ticker + (ref.manual ? " · valor escrito a mano" : " · se actualiza al calcular")
            : "Capitalización manual"
        info.append(nombre, etiqueta)

        const quitar = document.createElement("button")
        quitar.type = "button"
        quitar.className = "hCapQuitar"
        quitar.setAttribute("aria-label", "Quitar " + ref.nombre)
        quitar.title = "Quitar"
        quitar.textContent = "×"
        quitar.addEventListener("click", () => {
            _hCapRefs.splice(i, 1)
            hCapGuardarRefs()
            hCapRenderRefs()
        })

        const campo = document.createElement("div")
        campo.className = "hCapRefCampo"
        const capital = document.createElement("input")
        capital.type = "number"
        capital.min = "0"
        capital.step = "any"
        capital.value = ref.capital || ""
        capital.placeholder = "Capitalización"
        capital.setAttribute("aria-label", "Capitalización de " + ref.nombre)
        capital.addEventListener("change", () => {
            ref.capital = parseFloat(capital.value) || 0
            // Lo escrito a mano manda: al calcular no se pisa con el dato en vivo.
            ref.manual = true
            hCapGuardarRefs()
            hCapRenderRefs()
        })
        const divisa = document.createElement("span")
        divisa.className = "hCapRefDivisa"
        divisa.textContent = ref.divisa
        campo.append(capital, divisa)

        fila.append(info, quitar, campo)
        if (!completa) {
            const aviso = document.createElement("small")
            aviso.className = "hCapRefAviso"
            aviso.textContent = "Sin capitalización: escríbela para que cuente en la comparación."
            fila.append(aviso)
        }
        return fila
    })

    lista.replaceChildren(
        grupo("Siempre presentes"),
        ...filasFijas,
        ...(propias.length
            ? [grupo("Añadidas por ti"), ...propias]
            : [hCapNota("Añade más abajo las que quieras comparar.")])
    )
}

function hCapFmt(valor, divisa) {
    try {
        return new Intl.NumberFormat("es-ES", {
            style: "currency",
            currency: divisa,
            notation: "compact",
            maximumFractionDigits: 2
        }).format(valor)
    } catch {
        return valor.toLocaleString("es-ES", { maximumFractionDigits: 0 }) + " " + divisa
    }
}

function hCapFmtCompleto(valor, divisa) {
    return valor.toLocaleString("es-ES", { maximumFractionDigits: 0 }) + " " + divisa
}

async function hCapTipoCambio(origen, destino) {
    if (!origen || origen === destino) return 1
    const res = await fetch(`/api/exchange-rate?from=${origen}&to=${destino}`)
    const data = await res.json()
    return data.ok ? data.rate : null
}

async function hCapCalcular() {
    const precio = parseFloat(document.getElementById("hCapPrecio").value) || 0
    const suministro = parseFloat(document.getElementById("hCapSuministro").value) || 0
    const objetivo = parseFloat(document.getElementById("hCapObjetivo").value) || 0
    const divisa = (_hCapActivo?.divisa || "").toUpperCase()

    if (!_hCapActivo || !divisa) {
        hCapMensaje("hCapActivoMsg", "Busca primero un activo para saber en qué divisa cotiza.", "aviso")
        return
    }
    // El precio actual puede ser cero (un activo sin cotización todavía): solo
    // se pierde lo que se mide contra él, el multiplicador y la subida.
    if (suministro <= 0 || objetivo <= 0) {
        hCapMensaje("hCapActivoMsg", "El suministro y el precio objetivo tienen que ser mayores que cero.", "aviso")
        return
    }
    hCapMensaje("hCapActivoMsg", "")

    const necesaria = objetivo * suministro
    const actual = precio * suministro
    const multiplicador = precio > 0 ? objetivo / precio : null
    const subida = multiplicador === null ? null : (multiplicador - 1) * 100

    const necesariaEl = document.getElementById("hCapNecesaria")
    necesariaEl.textContent = hCapFmt(necesaria, divisa)
    necesariaEl.title = hCapFmtCompleto(necesaria, divisa)
    const actualEl = document.getElementById("hCapActual")
    actualEl.textContent = hCapFmt(actual, divisa)
    actualEl.title = hCapFmtCompleto(actual, divisa)
    const subidaEl = document.getElementById("hCapSubida")
    subidaEl.textContent =
        subida === null
            ? "—"
            : (subida >= 0 ? "+" : "") + subida.toLocaleString("es-ES", { maximumFractionDigits: 1 }) + " %"
    subidaEl.className = "hResultValue " + (subida === null ? "" : subida >= 0 ? "hResultPositive" : "hResultNegative")
    document.getElementById("hCapMultiplicador").textContent =
        multiplicador === null ? "—" : "×" + multiplicador.toLocaleString("es-ES", { maximumFractionDigits: 2 })

    // Las fijas se piden en vivo; si llevan rato cargadas se refrescan.
    if (Date.now() - _hCapFijasHora > H_CAP_FIJAS_CADUCIDAD_MS)
        await Promise.all([hCapCargarFijas(), hCapRefrescarPropias()])
    const sinDato = _hCapFijas.filter((ref) => ref.estado === "error").map((ref) => ref.nombre)

    // Cada referencia se lleva a la divisa del activo antes de compararlas.
    const filas = []
    const sinConvertir = []
    for (const ref of [..._hCapFijas, ..._hCapRefs]) {
        if (!(ref.capital > 0)) continue
        let tipo
        try {
            tipo = await hCapTipoCambio(ref.divisa, divisa)
        } catch {
            tipo = null
        }
        if (tipo === null) {
            sinConvertir.push(ref.nombre)
            continue
        }
        const capitalRef = ref.capital * tipo
        filas.push({ nombre: ref.nombre, capitalRef, veces: necesaria / capitalRef })
    }

    document.getElementById("hCapComparativa").replaceChildren(
        ...filas.map((f) => {
            const fila = document.createElement("div")
            fila.className = "hCapComp"
            const nombre = document.createElement("span")
            nombre.textContent = f.nombre
            nombre.title = hCapFmtCompleto(f.capitalRef, divisa)
            const veces = document.createElement("strong")
            veces.textContent = f.veces.toLocaleString("es-ES", { maximumFractionDigits: 2 }) + " veces"
            const detalle = document.createElement("small")
            detalle.textContent =
                (f.veces >= 1 ? "supera su capitalización (" : "queda por debajo de su capitalización (") +
                hCapFmt(f.capitalRef, divisa) +
                ")"
            fila.append(nombre, veces, detalle)
            return fila
        })
    )

    const avisos = []
    if (sinDato.length) avisos.push("Sin dato en vivo de: " + sinDato.join(", ") + ".")
    if (sinConvertir.length) avisos.push("Sin tipo de cambio para: " + sinConvertir.join(", ") + ".")
    const interp = document.getElementById("hCapInterpretacion")
    interp.textContent =
        `Para que 1 ${_hCapActivo.nombre} valga ${objetivo.toLocaleString("es-ES", { maximumFractionDigits: 6 })} ${divisa} con el suministro actual, ` +
        `su capitalización debería ser ${hCapFmt(necesaria, divisa)}. Supone que el suministro no cambia.` +
        (avisos.length ? " " + avisos.join(" ") : "")
    interp.className = "hRatioInterpretacion hRatioInfoPos"

    document.getElementById("hCapResults").classList.remove("hidden")
}
