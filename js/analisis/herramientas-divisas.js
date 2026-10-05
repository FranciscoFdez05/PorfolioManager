// ===== HERRAMIENTAS › COMPARADOR DE DIVISAS =====
// Cotización de un par de divisas y su evolución. Dar la vuelta al par no pide
// nada al servidor: se invierte la serie que ya está en pantalla (1/x). Los
// nombres llevan el prefijo hFx para no chocar con los de las demás
// herramientas, que comparten el ámbito global.

const H_FX_PERIODOS = {
    "1D": "1 día",
    "1S": "1 semana",
    "1M": "1 mes",
    "3M": "3 meses",
    "6M": "6 meses",
    "1A": "1 año"
}
const H_FX_STORAGE_KEY = "hFxPar"

let _hFxChart = null
let _hFxDatos = null
let _hFxRango = "1M"
let _hFxToken = 0
let _hFxListo = false
// Mientras el código fija los desplegables no hay que reaccionar a su "change":
// se pide una sola vez, cuando ya están los dos valores.
let _hFxSilencio = false

function hFxIniciar() {
    // La página se vuelve a montar cada vez que se abre: el gráfico y el estado
    // de la visita anterior pertenecen a un DOM que ya no existe.
    try {
        _hFxChart?.destroy()
    } catch {
        /* el canvas ya no está */
    }
    _hFxChart = null
    _hFxDatos = null
    _hFxListo = false
    _hFxSilencio = false
    _hFxToken++

    const base = document.getElementById("hFxBase")
    const quote = document.getElementById("hFxQuote")
    if (!base || !quote) return

    ;[base, quote].forEach((select) =>
        select.addEventListener("change", () => {
            if (_hFxSilencio) return
            hFxGuardarPar()
            hFxCargar()
        })
    )
    document.getElementById("hFxSwap")?.addEventListener("click", hFxIntercambiar)
    document.getElementById("hFxCantidad")?.addEventListener("input", hFxRenderConversion)
    document.getElementById("hFxRangos")?.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-rango]")
        if (btn) hFxElegirRango(btn.dataset.rango)
    })
    document.getElementById("hFxVariaciones")?.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-rango]")
        if (btn) hFxElegirRango(btn.dataset.rango)
    })
}

// Se llama al abrir la herramienta, no al cargar la página: la lista de divisas
// sale de un servicio externo y no hay motivo para pedirla a quien nunca la usa.
async function hFxAlAbrir() {
    if (_hFxListo) {
        _hFxChart?.resize()
        return
    }
    try {
        await hFxCargarDivisas()
    } catch (error) {
        hFxEstado(error?.message || "No se pudo cargar la lista de divisas.", true)
        return
    }
    _hFxListo = true
    hFxCargar()
}

async function hFxCargarDivisas() {
    const datos = await Api.get("/api/divisas")
    const divisas = Array.isArray(datos?.divisas) ? datos.divisas : []
    if (!divisas.length) throw new Error("No hay divisas disponibles.")

    const base = document.getElementById("hFxBase")
    const quote = document.getElementById("hFxQuote")
    ;[base, quote].forEach((select) => {
        select.innerHTML = ""
        divisas.forEach(({ code, name }) => {
            const opcion = document.createElement("option")
            opcion.value = code
            opcion.textContent = name && name !== code ? `${code} · ${name}` : code
            select.appendChild(opcion)
        })
    })

    const codigos = divisas.map((d) => d.code)
    const guardado = hFxLeerPar()
    const propia = String(window._monedaBase || "EUR").toUpperCase()
    const origen = codigos.includes(guardado?.base) ? guardado.base : codigos.includes(propia) ? propia : codigos[0]
    let destino = codigos.includes(guardado?.quote)
        ? guardado.quote
        : codigos.find((c) => c !== origen && c === (origen === "USD" ? "EUR" : "USD")) ||
          codigos.find((c) => c !== origen)
    if (origen === destino) destino = codigos.find((c) => c !== origen)
    hFxFijarSelect(base, origen)
    hFxFijarSelect(quote, destino)
}

// Fijar el valor y avisar con "change" es lo que hace que el desplegable
// personalizado de la app repinte su etiqueta.
function hFxFijarSelect(select, valor) {
    _hFxSilencio = true
    try {
        select.value = valor
        select.dispatchEvent(new Event("change"))
    } finally {
        _hFxSilencio = false
    }
}

function hFxLeerPar() {
    try {
        return JSON.parse(localStorage.getItem(H_FX_STORAGE_KEY))
    } catch {
        return null
    }
}

function hFxGuardarPar() {
    try {
        localStorage.setItem(
            H_FX_STORAGE_KEY,
            JSON.stringify({
                base: document.getElementById("hFxBase")?.value,
                quote: document.getElementById("hFxQuote")?.value
            })
        )
    } catch {
        /* sin almacenamiento: la próxima vez se parte del valor por defecto */
    }
}

// ── Datos ────────────────────────────────────────────────────────────────

async function hFxCargar() {
    const base = document.getElementById("hFxBase")?.value
    const quote = document.getElementById("hFxQuote")?.value
    if (!base || !quote) return

    const token = ++_hFxToken
    if (base === quote) {
        _hFxDatos = null
        hFxLimpiar()
        hFxEstado("Elige dos divisas distintas.", true)
        return
    }

    hFxEstado("Cargando…")
    try {
        const datos = await Api.get(
            `/api/divisas/historico?base=${encodeURIComponent(base)}&quote=${encodeURIComponent(quote)}&rango=${_hFxRango}`
        )
        // Si mientras tanto se cambió de par o de periodo, esta respuesta ya no vale.
        if (token !== _hFxToken) return
        _hFxDatos = datos
        hFxEstado("")
        hFxRender()
    } catch (error) {
        if (token !== _hFxToken) return
        _hFxDatos = null
        hFxLimpiar()
        hFxEstado(error?.message || "No se pudo cargar el histórico de ese par.", true)
    }
}

function hFxElegirRango(rango) {
    if (!rango || rango === _hFxRango) return
    _hFxRango = rango
    document.querySelectorAll("#hFxRangos [data-rango]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.rango === rango)
    })
    hFxCargar()
}

function hFxInvertirDatos(datos) {
    const invertir = (punto) => ({ ...punto, close: 1 / punto.close })
    return {
        ...datos,
        base: datos.quote,
        quote: datos.base,
        puntos: datos.puntos.map(invertir),
        actual: invertir(datos.actual),
        referencias: datos.referencias.map(invertir)
    }
}

// Dar la vuelta al par: se cambian los dos desplegables y la serie se invierte
// aquí mismo, sin pedirla otra vez.
function hFxIntercambiar() {
    const base = document.getElementById("hFxBase")
    const quote = document.getElementById("hFxQuote")
    if (!base || !quote || !base.value || !quote.value) return

    const vieja = { base: base.value, quote: quote.value }
    const coincide = _hFxDatos && _hFxDatos.base === vieja.base && _hFxDatos.quote === vieja.quote

    // Cualquier petición en vuelo era del par anterior.
    _hFxToken++
    hFxFijarSelect(base, vieja.quote)
    hFxFijarSelect(quote, vieja.base)
    hFxGuardarPar()

    if (coincide) {
        _hFxDatos = hFxInvertirDatos(_hFxDatos)
        hFxRender()
    } else {
        hFxCargar()
    }
}

// ── Pintado ──────────────────────────────────────────────────────────────

function hFxEstado(texto, esError = false) {
    const nodo = document.getElementById("hFxEstado")
    if (!nodo) return
    nodo.textContent = texto
    nodo.classList.toggle("hFxEstadoError", Boolean(texto && esError))
    nodo.classList.toggle("hFxEstadoVisible", Boolean(texto))
}

function hFxLocale() {
    return window._numLocale || "es-ES"
}

// Menos decimales cuanto mayor es la cotización: 1,0842 pero 156,324 y 0,00642.
function hFxDecimales(valor) {
    return valor >= 100 ? 3 : valor >= 1 ? 4 : 5
}

function hFxNumero(valor, decimales = hFxDecimales(valor)) {
    return new Intl.NumberFormat(hFxLocale(), {
        minimumFractionDigits: decimales,
        maximumFractionDigits: decimales
    }).format(valor)
}

// Diferencia entre dos cotizaciones, con signo y con los decimales de la
// cotización de referencia (0,0034 sobre 1,08; 0,512 sobre 158).
function hFxDiferencia(valor, referencia) {
    return (valor > 0 ? "+" : valor < 0 ? "-" : "") + hFxNumero(Math.abs(valor), hFxDecimales(referencia))
}

// Importe en dinero (2 decimales) con signo.
function hFxDinero(valor) {
    const texto = new Intl.NumberFormat(hFxLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
        Math.abs(valor)
    )
    return (valor > 0 ? "+" : valor < 0 ? "-" : "") + texto
}

function hFxPorcentaje(valor) {
    const texto = new Intl.NumberFormat(hFxLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
        valor
    )
    return `${valor > 0 ? "+" : ""}${texto}%`
}

function hFxClaseVariacion(valor) {
    return valor > 0 ? "hFxPos" : valor < 0 ? "hFxNeg" : ""
}

function hFxLimpiar() {
    try {
        _hFxChart?.destroy()
    } catch {
        /* ya destruido */
    }
    _hFxChart = null
    ;["hFxRateMain", "hFxRateInv", "hFxRateFecha", "hFxConvertido"].forEach((id) => {
        const nodo = document.getElementById(id)
        if (nodo) nodo.textContent = id === "hFxRateMain" || id === "hFxConvertido" ? "---" : ""
    })
    ;["hFxStats", "hFxVariaciones"].forEach((id) => {
        const nodo = document.getElementById(id)
        if (nodo) nodo.innerHTML = ""
    })
}

function hFxRender() {
    if (!_hFxDatos) return
    hFxRenderTasa()
    hFxRenderConversion()
    hFxRenderGrafico()
    hFxRenderStats()
    hFxRenderVariaciones()
}

function hFxRenderTasa() {
    const { base, quote, actual } = _hFxDatos
    const principal = document.getElementById("hFxRateMain")
    const inversa = document.getElementById("hFxRateInv")
    const fecha = document.getElementById("hFxRateFecha")
    if (principal) principal.textContent = `1 ${base} = ${hFxNumero(actual.close)} ${quote}`
    if (inversa) inversa.textContent = `1 ${quote} = ${hFxNumero(1 / actual.close)} ${base}`
    if (fecha) {
        fecha.textContent = `Último cierre: ${new Date(actual.ts * 1000).toLocaleString(hFxLocale(), {
            dateStyle: "medium",
            timeStyle: "short"
        })}`
    }
}

function hFxRenderConversion() {
    const unidad = document.getElementById("hFxCantidadUnit")
    const resultado = document.getElementById("hFxConvertido")
    if (!_hFxDatos || !resultado) return

    const { base, quote, actual } = _hFxDatos
    if (unidad) unidad.textContent = base

    const cantidad = parseFloat(document.getElementById("hFxCantidad")?.value)
    if (!Number.isFinite(cantidad)) {
        resultado.textContent = "---"
        return
    }
    const formato = (v) =>
        new Intl.NumberFormat(hFxLocale(), { maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(v)
    resultado.textContent = `${formato(cantidad)} ${base} = ${formato(cantidad * actual.close)} ${quote}`
    hFxRenderVariaciones()
}

function hFxEtiqueta(ts, rango, largo = false) {
    const fecha = new Date(ts * 1000)
    const locale = hFxLocale()
    if (rango === "1D") {
        return fecha.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
    }
    if (rango === "1S") {
        return largo
            ? fecha.toLocaleString(locale, {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit"
              })
            : fecha.toLocaleDateString(locale, { weekday: "short", day: "numeric" })
    }
    if (rango === "1A" || rango === "5A" || rango === "6M") {
        return largo
            ? fecha.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" })
            : fecha.toLocaleDateString(locale, { month: "short", year: "2-digit" })
    }
    return largo
        ? fecha.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" })
        : fecha.toLocaleDateString(locale, { day: "numeric", month: "short" })
}

function hFxRenderGrafico() {
    const canvas = document.getElementById("hFxChart")
    if (!canvas || typeof Chart === "undefined") return

    const { puntos, rango } = _hFxDatos
    const valores = puntos.map((p) => p.close)
    // Verde si el periodo termina por encima de donde empezó, rojo si no.
    const sube = valores[valores.length - 1] >= valores[0]
    const color = sube ? "#34d399" : "#f87171"
    const tema = hChartTheme()

    try {
        _hFxChart?.destroy()
    } catch {
        /* ya destruido */
    }

    _hFxChart = new Chart(canvas, {
        type: "line",
        data: {
            labels: puntos.map((p) => hFxEtiqueta(p.ts, rango)),
            datasets: [
                {
                    data: valores,
                    borderColor: color,
                    backgroundColor: `${color}22`,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    tension: 0.2,
                    fill: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 250 },
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: (items) => hFxEtiqueta(puntos[items[0].dataIndex].ts, rango, true),
                        label: (item) => {
                            const valor = item.parsed.y
                            const linea = (texto, desde) =>
                                `${texto}: ${hFxDiferencia(valor - desde, valor)} (${hFxPorcentaje((valor / desde - 1) * 100)})`
                            const lineas = [`${_hFxDatos.base}/${_hFxDatos.quote}: ${hFxNumero(valor)}`]
                            lineas.push(linea("Desde el inicio", valores[0]))
                            if (item.dataIndex > 0)
                                lineas.push(linea("Frente al anterior", valores[item.dataIndex - 1]))
                            return lineas
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: tema.muted, maxTicksLimit: 7, maxRotation: 0, autoSkip: true }
                },
                y: {
                    grid: { color: tema.grid },
                    ticks: { color: tema.muted, callback: (v) => hFxNumero(Number(v)) }
                }
            }
        }
    })
}

function hFxRenderStats() {
    const nodo = document.getElementById("hFxStats")
    if (!nodo) return

    const { puntos, rango } = _hFxDatos
    const valores = puntos.map((p) => p.close)
    const primero = valores[0]
    const ultimo = valores[valores.length - 1]
    const iMin = valores.indexOf(Math.min(...valores))
    const iMax = valores.indexOf(Math.max(...valores))
    const media = valores.reduce((a, b) => a + b, 0) / valores.length
    const cambio = ultimo - primero
    const porcentaje = (ultimo / primero - 1) * 100
    const amplitud = valores[iMax] - valores[iMin]

    const dato = (etiqueta, valor, clase = "", detalle = "") =>
        `<div class="hFxStat"><span class="hFxStatLabel">${etiqueta}</span><span class="hFxStatValue ${clase}">${valor}</span>${
            detalle ? `<span class="hFxStatDetalle">${detalle}</span>` : ""
        }</div>`

    nodo.innerHTML =
        dato("Apertura", hFxNumero(primero), "", hFxEtiqueta(puntos[0].ts, rango, true)) +
        dato("Actual", hFxNumero(ultimo), "", hFxEtiqueta(puntos[puntos.length - 1].ts, rango, true)) +
        dato("Cambio", hFxDiferencia(cambio, ultimo), hFxClaseVariacion(cambio), hFxPorcentaje(porcentaje)) +
        dato("Mínimo", hFxNumero(valores[iMin]), "", hFxEtiqueta(puntos[iMin].ts, rango, true)) +
        dato("Máximo", hFxNumero(valores[iMax]), "", hFxEtiqueta(puntos[iMax].ts, rango, true)) +
        dato(
            "Amplitud",
            hFxNumero(amplitud, hFxDecimales(ultimo)),
            "",
            hFxPorcentaje((amplitud / valores[iMin]) * 100).replace("+", "")
        ) +
        dato("Media", hFxNumero(media))
}

function hFxRenderVariaciones() {
    const nodo = document.getElementById("hFxVariaciones")
    if (!nodo) return

    const { base, quote, actual, referencias } = _hFxDatos
    const cantidad = parseFloat(document.getElementById("hFxCantidad")?.value)
    const formato = new Intl.NumberFormat(hFxLocale(), { maximumFractionDigits: 2 })

    nodo.innerHTML = referencias
        .filter((r) => H_FX_PERIODOS[r.rango])
        .map((r) => {
            const diferencia = actual.close - r.close
            const variacion = (actual.close / r.close - 1) * 100
            const clase = hFxClaseVariacion(variacion)
            // Lo que supone para la cantidad del conversor: cuánto más (o menos)
            // se recibe hoy por ella que en esa fecha.
            const efecto =
                Number.isFinite(cantidad) && cantidad > 0
                    ? `<span class="hFxVarEfecto ${clase}">${formato.format(cantidad)} ${base}: ${hFxDinero(cantidad * diferencia)} ${quote}</span>`
                    : ""
            return `
                <button type="button" class="hFxVar${r.rango === _hFxRango ? " active" : ""}" data-rango="${r.rango}" title="Ver ${H_FX_PERIODOS[r.rango]} en el gráfico">
                    <span class="hFxVarLabel">${H_FX_PERIODOS[r.rango]}</span>
                    <span class="hFxVarPct ${clase}">${hFxPorcentaje(variacion)}</span>
                    <span class="hFxVarDif ${clase}">${hFxDiferencia(diferencia, actual.close)} ${quote}</span>
                    ${efecto}
                    <span class="hFxVarRef">desde ${hFxNumero(r.close)}</span>
                </button>`
        })
        .join("")
}
