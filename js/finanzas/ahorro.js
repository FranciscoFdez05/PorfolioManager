/**
 * Página Ahorro: resumen del mes o del año, evolución mensual, presupuesto por
 * categoría, distribución del gasto y observaciones.
 *
 * Este fichero solo pinta y atiende eventos. Los números salen de
 * AhorroCalculos (js/finanzas/ahorro-calculos.js), que no toca el DOM.
 *
 * Datos: GET /api/ingresos/todos y /api/gastos/todos (todos los años en una
 * petición, necesarios para comparar enero con diciembre del año anterior y
 * para la media de 12 meses) y ahorroConfig de /api/settings:
 *   { objetivoAhorro: %, presupuesto: {categoría: %}, presupuestoEur: {categoría: €/mes},
 *     categoriasInversion: [categorías que no cuentan ni como gasto ni como ahorro] }
 */

// Colores por categoría, en orden de gasto. Sin rojo ni verde: en esta página
// esos dos significan "mal" y "bien".
const AHORRO_PALETA = [
    "#3b82f6",
    "#f59e0b",
    "#8b5cf6",
    "#06b6d4",
    "#ec4899",
    "#84cc16",
    "#f97316",
    "#6366f1",
    "#14b8a6",
    "#eab308",
    "#a855f7",
    "#0ea5e9"
]
// Categorías que caben en el donut; el resto se agrupa en "Otras".
const AHORRO_DONUT_MAX = 7
const AHORRO_MESES_MEDIA = 12
// Meses hacia atrás en los que se busca la racha de objetivo cumplido.
const AHORRO_MESES_RACHA = 36
// A partir de cuántas categorías la ventana de presupuesto muestra el buscador.
const AHORRO_BUSCADOR_DESDE = 7
const AHORRO_CONFIG_DEFECTO = Object.freeze({
    objetivoAhorro: 30,
    presupuesto: {},
    presupuestoEur: {},
    categoriasInversion: []
})

const AHORRO_ICONOS = {
    ingresos:
        '<svg viewBox="0 0 20 20" fill="none"><path d="M10 16V4M5.5 8.5 10 4l4.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    gastos: '<svg viewBox="0 0 20 20" fill="none"><path d="M10 4v12M14.5 11.5 10 16l-4.5-4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    acumulado:
        '<svg viewBox="0 0 20 20" fill="none"><path d="M3 15.5h14M5 12.5V9.5M8.5 12.5v-5M12 12.5V8M15.5 12.5v-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    prevision:
        '<svg viewBox="0 0 20 20" fill="none"><path d="M3 14.5 7.5 10l3 3L17 6.5M12.5 6.5H17V11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    objetivo:
        '<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="6.5" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="10" r="2.5" stroke="currentColor" stroke-width="1.5"/></svg>',
    bombilla:
        '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M7.5 14.5h5M8.25 17h3.5M10 2.75a5 5 0 0 0-3 9c.6.45 1 1.1 1 1.85v.9h4v-.9c0-.75.4-1.4 1-1.85a5 5 0 0 0-3-9Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    sube: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 2 9 7.5H1z" fill="currentColor"/></svg>',
    baja: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 8 1 2.5h8z" fill="currentColor"/></svg>'
}

const ahorroEstado = {
    ingresosPorAnio: {},
    gastosPorAnio: {},
    anios: [],
    anio: null,
    // Clave del mes elegido; null es la vista del año completo.
    mes: null,
    config: { ...AHORRO_CONFIG_DEFECTO },
    filtro: "todas",
    grafico: null,
    vista: null
}
let ahorroConfigModalKeyHandler = null

// ── Carga ────────────────────────────────────────────────────────────────

/**
 * Punto de entrada de la página (lo llama app-core.js al abrirla).
 * @returns {Promise<void>}
 */
async function initAhorroLogic() {
    try {
        const [ingresos, gastos, ajustes] = await Promise.all([
            ahorroPedirJson("/api/ingresos/todos"),
            ahorroPedirJson("/api/gastos/todos"),
            ahorroPedirJson("/api/settings")
        ])
        ahorroEstado.ingresosPorAnio = ingresos?.years || {}
        ahorroEstado.gastosPorAnio = gastos?.years || {}
        ahorroEstado.config = ahorroNormalizarConfig(ajustes?.ahorroConfig)
        ahorroEstado.anios = ahorroAniosDisponibles()
        ahorroElegirPeriodoInicial()
        ahorroMostrarError(
            ingresos && gastos
                ? ""
                : "No se pudieron cargar todos los ingresos y gastos: las cifras pueden estar incompletas."
        )
        ahorroBindEvents()
        ahorroRender()
    } catch (err) {
        console.error("Error inicializando ahorro:", err)
        ahorroMostrarError("No se pudo cargar la página de ahorro.")
    }
}

async function ahorroPedirJson(url) {
    try {
        const respuesta = await fetch(url)
        return respuesta.ok ? await respuesta.json() : null
    } catch (err) {
        console.error(`Ahorro: no se pudo leer ${url}`, err)
        return null
    }
}

/**
 * Completa una ahorroConfig guardada con los campos que le falten.
 * @param {object|undefined} config
 * @returns {{objetivoAhorro: number, presupuesto: object, presupuestoEur: object, categoriasInversion: string[]}}
 */
function ahorroNormalizarConfig(config) {
    const objetivo = Number(config?.objetivoAhorro)
    return {
        objetivoAhorro: Number.isFinite(objetivo) ? objetivo : AHORRO_CONFIG_DEFECTO.objetivoAhorro,
        presupuesto: { ...(config?.presupuesto || {}) },
        presupuestoEur: { ...(config?.presupuestoEur || {}) },
        categoriasInversion: Array.isArray(config?.categoriasInversion) ? [...config.categoriasInversion] : []
    }
}

function ahorroOpciones() {
    return { categoriasInversion: ahorroEstado.config.categoriasInversion }
}

// Opciones sin nada marcado como inversión: para medias y listas en las que
// toda categoría debe aparecer como gasto.
const AHORRO_OPCIONES_SIN_INVERSION = Object.freeze({ categoriasInversion: [] })

function ahorroSerie(anio) {
    return AhorroCalculos.serieAnual(ahorroEstado.ingresosPorAnio, ahorroEstado.gastosPorAnio, anio, ahorroOpciones())
}

/**
 * Años del selector: exactamente los que existen en Gastos o en Ingresos (los
 * que se crean allí con «Añadir año»), del más reciente al más antiguo, sin
 * huecos inventados. Sin ninguno, el año en curso, para que la página no
 * quede vacía.
 * @returns {string[]}
 */
function ahorroAniosDisponibles() {
    const anios = new Set(
        [...Object.keys(ahorroEstado.ingresosPorAnio), ...Object.keys(ahorroEstado.gastosPorAnio)].filter((a) =>
            /^\d{4}$/.test(a)
        )
    )
    if (!anios.size) anios.add(String(new Date().getFullYear()))
    return [...anios].sort((a, b) => Number(b) - Number(a))
}

// Conserva el periodo al volver a la página; si ya no existe, va al mes en curso.
function ahorroElegirPeriodoInicial() {
    const { anios } = ahorroEstado
    if (!anios.includes(ahorroEstado.anio)) {
        const actual = String(new Date().getFullYear())
        ahorroEstado.anio = anios.includes(actual) ? actual : anios[0]
        ahorroEstado.mes = ahorroMesPorDefecto(ahorroEstado.anio)
    }
}

/**
 * Mes que se abre al elegir un año: el actual en el año en curso y, en otro
 * año, el último con datos.
 * @param {string} anio
 * @returns {string}
 */
function ahorroMesPorDefecto(anio) {
    const C = AhorroCalculos
    const hoy = new Date()
    if (Number(anio) === hoy.getFullYear()) return C.MESES[hoy.getMonth()].clave
    const serie = ahorroSerie(anio)
    for (let i = serie.length - 1; i >= 0; i--) {
        if (serie[i].tieneDatos) return C.MESES[i].clave
    }
    return C.MESES[11].clave
}

function ahorroObjetivo() {
    return Number(ahorroEstado.config.objetivoAhorro) || 0
}

// ── Modelo de la vista ───────────────────────────────────────────────────

/**
 * Reúne todo lo que se pinta para el periodo elegido.
 * @returns {object}
 */
function ahorroCalcularVista() {
    const C = AhorroCalculos
    const { anio, mes, config } = ahorroEstado
    const objetivo = ahorroObjetivo()
    const serie = ahorroSerie(anio)
    const transcurridos = C.mesesTranscurridos(anio, new Date())
    const estadisticas = C.estadisticasAnio(serie, transcurridos, objetivo)
    const base = {
        anio,
        mes,
        objetivo,
        serie,
        transcurridos,
        estadisticas,
        proyeccion: C.proyeccionFinDeAnio(estadisticas, transcurridos)
    }
    const periodo = mes ? ahorroPeriodoMes(base) : ahorroPeriodoAnio(base)
    const ingresosPresupuesto = ahorroIngresosPresupuesto(base, periodo.resumen)
    const filas = C.filasPresupuesto(
        periodo.resumen,
        periodo.resumenPrevio,
        ahorroConfigSinInversion(config),
        ingresosPresupuesto.importe
    )
    const observaciones = C.generarObservaciones({
        resumen: periodo.resumen,
        filas,
        objetivo,
        etiquetaPrevio: periodo.etiquetaPrevio,
        racha: periodo.racha,
        mediaGastos: periodo.mediaGastos,
        estadisticas: mes ? null : estadisticas
    })
    return {
        ...base,
        ...periodo,
        filas,
        ingresosPresupuesto,
        observaciones,
        colores: ahorroColoresPorCategoria(filas)
    }
}

/**
 * Ingresos a los que se aplican los presupuestos en % del periodo elegido: si
 * el periodo incluye el mes en curso, ese mes cuenta al menos con los ingresos
 * medios del año (ver AhorroCalculos.ingresosParaPresupuesto). Es la misma
 * media que enseña la ventana de presupuesto, para que «≈ 79,50 €» allí sea lo
 * que luego sale en la tabla.
 * @param {{anio: string, mes: string|null, serie: object[], transcurridos: number}} base
 * @param {object} resumen Resumen del periodo.
 * @returns {{importe: number, conMedia: boolean}}
 */
function ahorroIngresosPresupuesto({ anio, mes, serie, transcurridos }, resumen) {
    const C = AhorroCalculos
    const enCurso = Number(anio) === new Date().getFullYear() && transcurridos > 0 ? transcurridos - 1 : -1
    const incluyeMesEnCurso = enCurso >= 0 && (mes === null || C.indiceDeMes(mes) === enCurso)
    if (!incluyeMesEnCurso) return C.ingresosParaPresupuesto(resumen.ingresos, null, 0)
    return C.ingresosParaPresupuesto(resumen.ingresos, serie[enCurso].ingresos, ahorroMediasDelAnio().ingresos)
}

// Una categoría marcada como inversión no es gasto: si tenía un presupuesto de
// antes de marcarla, se ignora sin borrarlo de la configuración.
function ahorroConfigSinInversion(config) {
    if (!config.categoriasInversion.length) return config
    const sinInversion = (mapa) => Object.fromEntries(Object.entries(mapa).filter(([c]) => !ahorroEsInversion(c)))
    return {
        ...config,
        presupuesto: sinInversion(config.presupuesto),
        presupuestoEur: sinInversion(config.presupuestoEur)
    }
}

function ahorroEsInversion(categoria) {
    return AhorroCalculos.detectorDeInversion(ahorroEstado.config.categoriasInversion)(categoria)
}

function ahorroMedia(lista, valorDe) {
    return lista.length ? lista.reduce((s, x) => s + valorDe(x), 0) / lista.length : null
}

function ahorroPeriodoMes({ anio, mes, serie, objetivo }) {
    const C = AhorroCalculos
    const { ingresosPorAnio, gastosPorAnio } = ahorroEstado
    const anterior = C.mesAnterior(anio, mes)
    const historico = C.ultimosMeses(ingresosPorAnio, gastosPorAnio, anio, mes, AHORRO_MESES_RACHA, ahorroOpciones())
    const previos = historico.slice(-(AHORRO_MESES_MEDIA + 1), -1).filter((r) => r.tieneDatos)
    return {
        resumen: serie[C.indiceDeMes(mes)],
        resumenPrevio: historico[historico.length - 2],
        etiquetaPeriodo: `${C.nombreDeMes(mes)} ${anio}`,
        etiquetaPrevio: anterior.anio === String(anio) ? anterior.mes : `${anterior.mes} de ${anterior.anio}`,
        etiquetaCortaPrevio: anterior.anio === String(anio) ? anterior.mes : `${anterior.mes} ${anterior.anio}`,
        mediaGastos: ahorroMedia(previos, (r) => r.gastos),
        mediaAhorro: ahorroMedia(previos, (r) => r.ahorro),
        racha: C.rachaObjetivo(historico, objetivo)
    }
}

// La vista anual del año en curso abarca hasta el mes actual y se compara con
// los mismos meses del año anterior: comparar diez meses con doce no dice nada.
function ahorroPeriodoAnio({ anio, serie, transcurridos }) {
    const C = AhorroCalculos
    const meses = transcurridos > 0 ? transcurridos : 12
    const anioPrevio = String(Number(anio) - 1)
    const seriePrevia = ahorroSerie(anioPrevio)
    const tramo = (a) => (meses < 12 ? `${C.MESES[0].corto}–${C.MESES[meses - 1].corto} ${a}` : String(a))
    return {
        resumen: C.sumarResumenes(serie.slice(0, meses)),
        resumenPrevio: C.sumarResumenes(seriePrevia.slice(0, meses)),
        etiquetaPeriodo: meses < 12 ? `${anio} hasta ${C.MESES[meses - 1].clave}` : `Año ${anio}`,
        etiquetaPrevio: tramo(anioPrevio),
        etiquetaCortaPrevio: tramo(anioPrevio),
        mediaGastos: null,
        mediaAhorro: null,
        racha: 0
    }
}

function ahorroColoresPorCategoria(filas) {
    const colores = {}
    filas.forEach((fila, i) => {
        colores[fila.categoria] = AHORRO_PALETA[i % AHORRO_PALETA.length]
    })
    return colores
}

// ── Pintado ──────────────────────────────────────────────────────────────

function ahorroRender() {
    if (!document.getElementById("ahorroHero")) return
    const vista = ahorroCalcularVista()
    ahorroEstado.vista = vista
    ahorroPintarCabecera(vista)
    ahorroPintarAnios()
    ahorroPintarMeses(vista)
    ahorroPintarHero(vista)
    ahorroPintarKpis(vista)
    ahorroPintarEvolucion(vista)
    ahorroPintarResumenAnual(vista)
    ahorroPintarPresupuesto(vista)
    ahorroPintarDistribucion(vista)
    ahorroPintarObservaciones(vista)
}

function ahorroSetText(id, texto) {
    const el = document.getElementById(id)
    if (el) el.textContent = texto
}

function ahorroMostrarError(mensaje) {
    const el = document.getElementById("ahorroLoadError")
    if (!el) return
    el.textContent = mensaje
    el.classList.toggle("hidden", !mensaje)
}

function ahorroPct(valor, decimales = 1) {
    return AhorroCalculos.formatearPct(valor, decimales)
}

function ahorroTono(valor) {
    if (valor > 0.005) return "pos"
    if (valor < -0.005) return "neg"
    return ""
}

function ahorroPlural(n, singular, plural) {
    return `${n} ${n === 1 ? singular : plural}`
}

/**
 * Píldora con la variación de un importe.
 * @param {{diferencia: number, porcentaje: number|null}|null} v
 * @param {string} contexto Con qué se compara ("vs octubre").
 * @param {boolean} mejorSiSube false para gastos: subir es malo.
 * @param {boolean} [enEuros=false] Mostrar la diferencia en € en vez de en %.
 * @returns {string} HTML, vacío si no hay variación que mostrar.
 */
function ahorroChipHtml(v, contexto, mejorSiSube, enEuros = false) {
    if (!v) return ""
    const sube = v.diferencia > 0.005
    const baja = v.diferencia < -0.005
    const tono = !sube && !baja ? "neutro" : sube === mejorSiSube ? "pos" : "neg"
    const signo = sube ? "+" : baja ? "−" : ""
    const cifra =
        enEuros || v.porcentaje === null ? formatEuro(Math.abs(v.diferencia)) : ahorroPct(Math.abs(v.porcentaje), 0)
    const flecha = sube ? AHORRO_ICONOS.sube : baja ? AHORRO_ICONOS.baja : ""
    const titulo = `${v.diferencia >= 0 ? "+" : "−"}${formatEuro(Math.abs(v.diferencia))} ${contexto}`
    return `<span class="ahorroChip ${tono}" title="${escapeHtml(titulo)}">${flecha}${signo}${cifra}<span class="ahorroChipCtx">${escapeHtml(contexto)}</span></span>`
}

function ahorroPintarCabecera(vista) {
    ahorroSetText("ahorroTitulo", vista.etiquetaPeriodo)
    ahorroSetText(
        "ahorroSubtitulo",
        vista.resumenPrevio?.tieneDatos
            ? `Comparado con ${vista.etiquetaPrevio}`
            : `Sin datos de ${vista.etiquetaPrevio} para comparar`
    )
}

function ahorroPintarAnios() {
    const lista = document.getElementById("ahorroYearList")
    if (!lista) return
    lista.innerHTML = ""
    // Un año creado en Gastos o Ingresos pero aún sin movimientos sale apagado.
    const conMovimientos = new Set(
        ahorroEstado.anios.filter((anio) => ahorroSerie(anio).some((resumen) => resumen.tieneDatos))
    )
    ahorroEstado.anios.forEach((anio) => {
        const boton = document.createElement("button")
        boton.type = "button"
        const activo = anio === ahorroEstado.anio
        boton.className = `ahorroYearBtn${activo ? " active" : ""}${conMovimientos.has(anio) ? "" : " sinDatos"}`
        boton.setAttribute("aria-pressed", String(activo))
        if (!conMovimientos.has(anio)) boton.title = "Año sin movimientos todavía"
        boton.textContent = anio
        boton.addEventListener("click", () => ahorroSeleccionarAnio(anio))
        lista.appendChild(boton)
    })
    lista.querySelector(".ahorroYearBtn.active")?.scrollIntoView({ block: "nearest", inline: "nearest" })
}

function ahorroPintarMeses(vista) {
    const pestanas = document.getElementById("ahorroMonthTabs")
    if (!pestanas) return
    pestanas.innerHTML = ""
    const crear = ({ largo, corto, clave, clases = "", titulo = "" }) => {
        const boton = document.createElement("button")
        boton.type = "button"
        const activo = clave === ahorroEstado.mes
        boton.className = `ahorroMonthTab${clases}${activo ? " active" : ""}`
        boton.setAttribute("aria-pressed", String(activo))
        if (titulo) boton.setAttribute("aria-label", titulo)
        // Nombre completo y abreviatura: el CSS enseña uno u otro según el ancho.
        boton.innerHTML = `<span class="ahorroTabLargo">${escapeHtml(largo)}</span><span class="ahorroTabCorto">${escapeHtml(corto)}</span>`
        boton.addEventListener("click", () => ahorroSeleccionarMes(clave))
        pestanas.appendChild(boton)
    }
    crear({
        largo: `Año ${vista.anio}`,
        corto: String(vista.anio),
        clave: null,
        clases: " ahorroMonthTabAnio",
        titulo: `Año ${vista.anio} completo`
    })
    AhorroCalculos.MESES.forEach((m, i) => {
        const futuro = ahorroEsMesFuturo(vista, i)
        crear({
            largo: AhorroCalculos.nombreDeMes(m.clave),
            corto: m.corto,
            clave: m.clave,
            clases: `${vista.serie[i].tieneDatos ? " conDatos" : ""}${futuro ? " futuro" : ""}`,
            titulo: `${AhorroCalculos.nombreDeMes(m.clave)} ${vista.anio}${futuro ? ", aún no empezado" : ""}`
        })
    })
}

// En el año en curso, los meses que no han empezado. Un año futuro entero se
// trata como planificación y se enseña tal cual.
function ahorroEsMesFuturo(vista, indice) {
    return vista.transcurridos > 0 && vista.transcurridos < 12 && indice >= vista.transcurridos
}

function ahorroPintarHero(vista) {
    const { resumen, resumenPrevio, objetivo } = vista
    ahorroSetText("ahorroHeroLabel", vista.mes ? `Ahorro de ${vista.mes}` : `Ahorro ${vista.etiquetaPeriodo}`)

    const valor = document.getElementById("ahorroHeroValue")
    if (valor) {
        valor.textContent = resumen.tieneDatos ? formatEuro(resumen.ahorro) : "Sin datos"
        valor.classList.toggle("ahorroKpiPos", resumen.tieneDatos && resumen.ahorro >= 0)
        valor.classList.toggle("ahorroKpiNeg", resumen.tieneDatos && resumen.ahorro < 0)
    }

    const desglose = document.getElementById("ahorroHeroDesglose")
    if (desglose) {
        // Lo invertido no entra en el ahorro (que es lo que queda en cuenta):
        // se enseña aparte para que no parezca que ha desaparecido.
        const hayInversion = resumen.inversion > 0.005
        desglose.classList.toggle("hidden", !hayInversion)
        desglose.innerHTML = hayInversion
            ? `<span><span class="ahorroDot ahorroDotInversion"></span>Además has invertido <strong>${formatEuro(resumen.inversion)}</strong> (no cuenta como gasto ni como ahorro)</span>`
            : ""
    }

    const deltas = document.getElementById("ahorroHeroDeltas")
    if (deltas) {
        const C = AhorroCalculos
        const chips = []
        if (resumen.tieneDatos && resumenPrevio?.tieneDatos) {
            chips.push(
                ahorroChipHtml(
                    C.variacion(resumen.ahorro, resumenPrevio.ahorro),
                    `vs ${vista.etiquetaCortaPrevio}`,
                    true,
                    true
                )
            )
        }
        if (resumen.tieneDatos && vista.mediaAhorro !== null) {
            chips.push(
                ahorroChipHtml(
                    C.variacion(resumen.ahorro, vista.mediaAhorro),
                    `vs media de ${AHORRO_MESES_MEDIA} meses`,
                    true,
                    true
                )
            )
        }
        deltas.innerHTML = chips.join("")
    }

    ahorroPintarMeta(resumen, objetivo)
    ahorroPintarGauge(resumen, objetivo)
}

function ahorroPintarMeta(resumen, objetivo) {
    const relleno = document.getElementById("ahorroMetaFill")
    const texto = document.getElementById("ahorroMetaText")
    if (!relleno || !texto) return
    relleno.classList.remove("pos", "neg", "parcial")

    if (resumen.ingresos <= 0.005) {
        relleno.style.width = "0%"
        texto.textContent = "Sin ingresos registrados: no se puede medir el objetivo."
        return
    }
    const objetivoEur = (resumen.ingresos * objetivo) / 100
    const cumplido = resumen.ahorro >= objetivoEur
    const progreso = objetivoEur > 0 ? Math.min(Math.max(resumen.ahorro / objetivoEur, 0), 1) * 100 : 100
    relleno.style.width = `${progreso}%`
    relleno.classList.add(cumplido ? "pos" : resumen.ahorro < 0 ? "neg" : "parcial")

    const meta = `objetivo del ${ahorroPct(objetivo, 0)} de los ingresos (${formatEuro(objetivoEur)})`
    texto.innerHTML = cumplido
        ? `Superas el ${escapeHtml(meta)} en <strong class="ahorroPos">${formatEuro(resumen.ahorro - objetivoEur)}</strong>`
        : `Te faltan <strong class="ahorroNeg">${formatEuro(objetivoEur - resumen.ahorro)}</strong> para el ${escapeHtml(meta)}`
}

/**
 * Medidor semicircular de la tasa de ahorro con una marca en el objetivo.
 * La escala llega al doble del objetivo (mínimo 50 %) para que la marca quede
 * hacia el centro y se vea tanto quedarse corto como pasarse.
 */
function ahorroPintarGauge(resumen, objetivo) {
    const svg = document.getElementById("ahorroGaugeSvg")
    const pie = document.getElementById("ahorroGaugeCaption")
    if (!svg) return
    const maximo = Math.min(100, Math.max(50, objetivo * 2))
    const tasa = resumen.tasa
    const fraccion = tasa === null ? 0 : Math.min(Math.max(tasa, 0), maximo) / maximo
    const tono = tasa === null ? "" : tasa >= objetivo ? "pos" : tasa >= 0 ? "parcial" : "neg"

    const radio = 80
    const punto = (f, r) => {
        const angulo = Math.PI * (1 - f)
        return { x: 100 + r * Math.cos(angulo), y: 100 - r * Math.sin(angulo) }
    }
    const fObjetivo = Math.min(objetivo, maximo) / maximo
    const m1 = punto(fObjetivo, radio - 13)
    const m2 = punto(fObjetivo, radio + 13)
    const arco = `M20 100 A${radio} ${radio} 0 0 1 180 100`
    const valor = tasa === null ? "—" : ahorroPct(tasa)

    svg.innerHTML = `
        <title id="ahorroGaugeTitle">Tasa de ahorro ${escapeHtml(valor)}, objetivo ${escapeHtml(ahorroPct(objetivo, 0))}</title>
        <path class="ahorroGaugeTrack" d="${arco}" pathLength="100"/>
        <path class="ahorroGaugeValue ${tono}" d="${arco}" pathLength="100" stroke-dasharray="${(fraccion * 100).toFixed(2)} 100"/>
        <line class="ahorroGaugeMarker" x1="${m1.x.toFixed(1)}" y1="${m1.y.toFixed(1)}" x2="${m2.x.toFixed(1)}" y2="${m2.y.toFixed(1)}"/>
        <text class="ahorroGaugeValueText ${tono}" x="100" y="86" text-anchor="middle">${escapeHtml(valor)}</text>
        <text class="ahorroGaugeLabel" x="100" y="104" text-anchor="middle">tasa de ahorro</text>
        <text class="ahorroGaugeScale" x="20" y="116" text-anchor="middle">0</text>
        <text class="ahorroGaugeScale" x="180" y="116" text-anchor="middle">${maximo}</text>
    `
    if (pie) pie.textContent = ahorroTextoGauge(tasa, objetivo)
}

function ahorroTextoGauge(tasa, objetivo) {
    const meta = `objetivo del ${ahorroPct(objetivo, 0)}`
    if (tasa === null) return `Sin ingresos · ${meta}`
    if (tasa >= objetivo) return `${ahorroPct(tasa - objetivo)} por encima del ${meta}`
    return `${ahorroPct(objetivo - tasa)} por debajo del ${meta}`
}

function ahorroKpiHtml({ icono, clase, etiqueta, valor, tono = "", chip = "", detalle = "" }) {
    return `
        <div class="ahorroKpiCard">
            <div class="ahorroKpiHead">
                <span class="ahorroKpiIcon ${clase}" aria-hidden="true">${icono}</span>
                <span class="ahorroKpiLabel">${escapeHtml(etiqueta)}</span>
            </div>
            <span class="ahorroKpiValue ${tono ? (tono === "pos" ? "ahorroKpiPos" : "ahorroKpiNeg") : ""}">${escapeHtml(valor)}</span>
            <div class="ahorroKpiFoot">${chip}<span class="ahorroKpiSub">${escapeHtml(detalle)}</span></div>
        </div>`
}

function ahorroDetalleGastos(resumen) {
    const partes = []
    if (resumen.ingresos > 0.005) partes.push(`${ahorroPct((resumen.gastos / resumen.ingresos) * 100)} de los ingresos`)
    if (resumen.inversion > 0.005) partes.push(`sin ${formatEuro(resumen.inversion)} invertidos`)
    return partes.join(" · ")
}

function ahorroPintarKpis(vista) {
    const grid = document.getElementById("ahorroKpiGrid")
    if (!grid) return
    const C = AhorroCalculos
    const { resumen, resumenPrevio, estadisticas, proyeccion, anio } = vista
    const comparar = resumenPrevio?.tieneDatos && resumen.tieneDatos
    const contexto = `vs ${vista.etiquetaCortaPrevio}`
    const tarjetas = [
        {
            icono: AHORRO_ICONOS.ingresos,
            clase: "ingresos",
            etiqueta: "Ingresos",
            valor: formatEuro(resumen.ingresos),
            chip: comparar ? ahorroChipHtml(C.variacion(resumen.ingresos, resumenPrevio.ingresos), contexto, true) : "",
            detalle: comparar ? "" : vista.mes ? "en el mes" : "en el periodo"
        },
        {
            icono: AHORRO_ICONOS.gastos,
            clase: "gastos",
            etiqueta: "Gastos",
            valor: formatEuro(resumen.gastos),
            chip: comparar ? ahorroChipHtml(C.variacion(resumen.gastos, resumenPrevio.gastos), contexto, false) : "",
            detalle: ahorroDetalleGastos(resumen)
        }
    ]

    if (vista.mes) {
        const total = estadisticas.total
        tarjetas.push({
            icono: AHORRO_ICONOS.acumulado,
            clase: "acumulado",
            etiqueta: `Acumulado ${anio}`,
            valor: estadisticas.mesesConDatos ? formatEuro(total.ahorro) : "—",
            tono: estadisticas.mesesConDatos ? ahorroTono(total.ahorro) : "",
            detalle: estadisticas.mesesConDatos
                ? `${total.tasa === null ? "sin ingresos" : `tasa ${ahorroPct(total.tasa)}`} · ${ahorroPlural(estadisticas.mesesConDatos, "mes", "meses")}`
                : "sin meses con datos"
        })
    } else {
        tarjetas.push({
            icono: AHORRO_ICONOS.acumulado,
            clase: "acumulado",
            etiqueta: "Media mensual",
            valor: estadisticas.mediaMensual === null ? "—" : formatEuro(estadisticas.mediaMensual),
            tono: estadisticas.mediaMensual === null ? "" : ahorroTono(estadisticas.mediaMensual),
            detalle: `${ahorroPlural(estadisticas.mesesConDatos, "mes", "meses")} con datos`
        })
    }

    if (proyeccion !== null) {
        tarjetas.push({
            icono: AHORRO_ICONOS.prevision,
            clase: "prevision",
            etiqueta: "Previsión a diciembre",
            valor: formatEuro(proyeccion),
            tono: ahorroTono(proyeccion),
            detalle: "si se mantiene tu media mensual"
        })
    } else {
        tarjetas.push({
            icono: AHORRO_ICONOS.objetivo,
            clase: "objetivo",
            etiqueta: "Meses en objetivo",
            valor: estadisticas.mesesConDatos ? `${estadisticas.mesesObjetivo} de ${estadisticas.mesesConDatos}` : "—",
            detalle: `ahorrando al menos el ${ahorroPct(vista.objetivo, 0)}`
        })
    }
    grid.innerHTML = tarjetas.map(ahorroKpiHtml).join("")
}

// ── Gráfico de evolución (Chart.js) ──────────────────────────────────────
//
// Un solo eje en euros: barras de ingresos y gastos, línea del ahorro (que
// baja de cero en los meses con déficit, en el mismo cero que las barras) y
// línea discontinua del ahorro objetivo de cada mes. La tasa va en el tooltip:
// un segundo eje en % con su propio cero desalineado no se entendía.

function ahorroColoresGrafica(elemento) {
    const estilos = getComputedStyle(elemento)
    const variable = (nombre, defecto) => estilos.getPropertyValue(nombre).trim() || defecto
    return {
        ingresos: variable("--color-pos-bright", "#4ade80"),
        gastos: variable("--color-neg-bright", "#f87171"),
        ahorro: variable("--accent", "#3b82f6"),
        texto: variable("--text-muted", "#9a9aa8"),
        textoFuerte: variable("--text-bright", "#ffffff"),
        rejilla: variable("--border-soft", "rgba(128,128,128,0.2)"),
        fondo: variable("--bg-elevated", "#1e1e22"),
        borde: variable("--border-mid", "rgba(128,128,128,0.4)")
    }
}

/**
 * Añade transparencia a un color #rgb o #rrggbb; otros formatos se devuelven igual.
 * @param {string} color
 * @param {number} alfa 0-1.
 * @returns {string}
 */
function ahorroConAlfa(color, alfa) {
    let hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1]
    if (!hex) return color
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join("")
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
    return `rgba(${r}, ${g}, ${b}, ${alfa})`
}

function ahorroEuroCorto(valor) {
    const absoluto = Math.abs(valor)
    const opciones = absoluto >= 1000 ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: 0 }
    return `${new Intl.NumberFormat(_nl(), opciones).format(valor)} €`
}

// Líneas del tooltip para un mes: todo lo que antes había que leer en dos ejes.
function ahorroLineasTooltip(resumen, objetivo) {
    const lineas = [`Ingresos: ${formatEuro(resumen.ingresos)}`, `Gastos: ${formatEuro(resumen.gastos)}`]
    if (resumen.inversion > 0.005) lineas.push(`Invertido: ${formatEuro(resumen.inversion)}`)
    lineas.push(`Ahorro: ${formatEuro(resumen.ahorro)}`)
    if (resumen.tasa !== null) {
        lineas.push(`Tasa: ${ahorroPct(resumen.tasa)} (objetivo ${ahorroPct(objetivo, 0)})`)
    }
    return lineas
}

function ahorroConfigEvolucion(vista, colores) {
    const indiceElegido = vista.mes ? AhorroCalculos.indiceDeMes(vista.mes) : -1
    const conDato = (i) => !ahorroEsMesFuturo(vista, i) && vista.serie[i].tieneDatos
    const serieDe = (valorDe) => vista.serie.map((r, i) => (conDato(i) ? valorDe(r) : null))
    // Con un mes elegido, el resto de barras se apagan para que destaque.
    const alfa = (i) => (indiceElegido === -1 || i === indiceElegido ? 0.9 : 0.35)
    const barra = (etiqueta, color, valores) => ({
        type: "bar",
        label: etiqueta,
        data: valores,
        backgroundColor: valores.map((_v, i) => ahorroConAlfa(color, alfa(i))),
        borderRadius: 4,
        maxBarThickness: 26,
        order: 2
    })
    const ahorros = serieDe((r) => r.ahorro)
    const colorPunto = ahorros.map((v) => (v !== null && v < 0 ? colores.gastos : colores.ahorro))

    return {
        data: {
            labels: AhorroCalculos.MESES.map((m) => m.corto),
            datasets: [
                barra(
                    "Ingresos",
                    colores.ingresos,
                    serieDe((r) => r.ingresos)
                ),
                barra(
                    "Gastos",
                    colores.gastos,
                    serieDe((r) => r.gastos)
                ),
                {
                    type: "line",
                    label: "Ahorro",
                    data: ahorros,
                    borderColor: colores.ahorro,
                    backgroundColor: colores.ahorro,
                    borderWidth: 2.5,
                    cubicInterpolationMode: "monotone",
                    spanGaps: true,
                    pointRadius: ahorros.map((_v, i) => (i === indiceElegido ? 6 : 4)),
                    pointHoverRadius: 7,
                    pointBackgroundColor: colorPunto,
                    pointBorderColor: colores.fondo,
                    pointBorderWidth: 2,
                    order: 1
                },
                {
                    type: "line",
                    label: "Objetivo",
                    data: serieDe((r) => (r.ingresos * vista.objetivo) / 100),
                    borderColor: colores.texto,
                    borderWidth: 1.5,
                    borderDash: [5, 4],
                    stepped: "middle",
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    order: 0
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { mode: "index", intersect: false },
            onClick: (evento, _elementos, grafico) => {
                const puntos = grafico.getElementsAtEventForMode(evento, "index", { intersect: false }, false)
                if (puntos.length) ahorroSeleccionarMes(AhorroCalculos.MESES[puntos[0].index].clave)
            },
            onHover: (evento, elementos) => {
                evento.native.target.style.cursor = elementos.length ? "pointer" : "default"
            },
            scales: {
                x: {
                    grid: { display: false },
                    border: { color: colores.rejilla },
                    ticks: { color: colores.texto, font: { size: 11 } }
                },
                y: {
                    grace: "6%",
                    grid: {
                        // La línea del cero, más marcada: separa ahorro de déficit.
                        color: (ctx) => (ctx.tick?.value === 0 ? colores.borde : colores.rejilla),
                        drawTicks: false
                    },
                    border: { display: false },
                    ticks: {
                        color: colores.texto,
                        font: { size: 11 },
                        padding: 8,
                        maxTicksLimit: 7,
                        callback: ahorroEuroCorto
                    }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: colores.fondo,
                    borderColor: colores.borde,
                    borderWidth: 1,
                    titleColor: colores.textoFuerte,
                    bodyColor: colores.textoFuerte,
                    padding: 10,
                    cornerRadius: 8,
                    displayColors: false,
                    // Un tooltip por mes, montado a mano: con el filtro por
                    // serie, un mes sin datos dejaba la lista vacía y el título
                    // fallaba al leer items[0] (tooltip en blanco y error).
                    filter: (_item, indice) => indice === 0,
                    callbacks: {
                        title: (items) => {
                            const indice = items[0]?.dataIndex
                            return indice === undefined
                                ? ""
                                : `${AhorroCalculos.nombreDeMes(AhorroCalculos.MESES[indice].clave)} ${vista.anio}`
                        },
                        label: (item) => {
                            const resumen = vista.serie[item.dataIndex]
                            return conDato(item.dataIndex) ? ahorroLineasTooltip(resumen, vista.objetivo) : "Sin datos"
                        }
                    }
                }
            }
        }
    }
}

function ahorroPintarEvolucion(vista) {
    const lienzo = document.getElementById("ahorroEvolucionChart")
    if (!lienzo || typeof Chart === "undefined") return
    ahorroSetText(
        "ahorroEvolucionSub",
        vista.mes ? "Pulsa un mes para verlo en detalle" : `${vista.anio} · pulsa un mes para verlo en detalle`
    )
    const config = ahorroConfigEvolucion(vista, ahorroColoresGrafica(lienzo))
    const grafico = ahorroEstado.grafico
    // Al cambiar de mes se actualiza el gráfico existente: recrearlo repetiría
    // la animación de entrada en cada clic.
    if (grafico && grafico.canvas === lienzo) {
        grafico.data = config.data
        grafico.options = config.options
        grafico.update()
        return
    }
    grafico?.destroy()
    ahorroEstado.grafico = new Chart(lienzo, { type: "bar", ...config })
}

// ── Resumen anual ────────────────────────────────────────────────────────

function ahorroPintarResumenAnual(vista) {
    const lista = document.getElementById("ahorroStatList")
    if (!lista) return
    const C = AhorroCalculos
    const { estadisticas: e, transcurridos, proyeccion } = vista
    ahorroSetText("ahorroAnioTitulo", `Resumen de ${vista.anio}`)
    const tramo =
        transcurridos > 0 && transcurridos < 12 ? `Enero a ${C.MESES[transcurridos - 1].clave}` : "Año completo"
    ahorroSetText("ahorroAnioSub", `${tramo} · ${ahorroPlural(e.mesesConDatos, "mes", "meses")} con datos`)

    if (!e.mesesConDatos) {
        lista.innerHTML = `<p class="ahorroEmpty">No hay ingresos ni gastos registrados en ${escapeHtml(vista.anio)}.</p>`
        return
    }
    const mesConImporte = (r) => (r ? `${C.nombreDeMes(r.mes)} · ${formatEuro(r.ahorro)}` : "—")
    const filas = [
        ["Ahorro acumulado", formatEuro(e.total.ahorro), ahorroTono(e.total.ahorro)],
        ["Tasa de ahorro", e.total.tasa === null ? "—" : ahorroPct(e.total.tasa), ""],
        ["Ingresos", formatEuro(e.total.ingresos), ""],
        ["Gastos", formatEuro(e.total.gastos), ""]
    ]
    if (e.total.inversion > 0.005) filas.push(["Invertido", formatEuro(e.total.inversion), ""])
    filas.push(
        ["Media mensual", formatEuro(e.mediaMensual), ahorroTono(e.mediaMensual)],
        ["Mejor mes", mesConImporte(e.mejor), ""],
        ["Peor mes", mesConImporte(e.peor), ""],
        ["Meses en objetivo", `${e.mesesObjetivo} de ${e.mesesConDatos}`, ""]
    )
    if (proyeccion !== null) filas.push(["Previsión a diciembre", formatEuro(proyeccion), ahorroTono(proyeccion)])
    lista.innerHTML = filas
        .map(
            ([etiqueta, valor, tono]) =>
                `<div class="ahorroStat"><dt>${escapeHtml(etiqueta)}</dt><dd class="${tono}">${escapeHtml(valor)}</dd></div>`
        )
        .join("")
}

// ── Presupuesto por categoría ────────────────────────────────────────────

function ahorroFiltrarFilas(filas, filtro) {
    if (filtro === "presupuesto") return filas.filter((f) => f.presupuesto)
    if (filtro === "excedidas") return filas.filter((f) => f.estado === "excedido")
    return filas
}

function ahorroCeldaPresupuesto(fila, mensual, conMedia) {
    const p = fila.presupuesto
    if (!p) return `<span class="ahorroNum ahorroMuted">—</span><span class="ahorroNumSub">sin definir</span>`
    const pct = ahorroPct(p.valor, p.valor % 1 ? 1 : 0)
    const sobreMedia = p.modo === "pct" && conMedia
    let detalle = `${pct} de los ingresos`
    if (p.modo === "eur") detalle = mensual ? "importe fijo" : `${formatEuro(p.valor)} al mes`
    else if (sobreMedia && mensual) detalle = `${pct} de los ingresos medios`
    const titulo = sobreMedia
        ? ' title="El mes en curso aún no tiene todos sus ingresos: se calcula con los ingresos medios del año"'
        : ""
    return `<span class="ahorroNum"${titulo}>${formatEuro(p.importe)}</span><span class="ahorroNumSub"${titulo}>${escapeHtml(detalle)}</span>`
}

function ahorroCeldaDisponible(fila) {
    if (fila.disponible === null) return `<span class="ahorroNum ahorroMuted">—</span>`
    const etiquetas = {
        excedido: "Excedido",
        cerca: `Usado ${ahorroPct(fila.usado, 0)}`,
        ok: fila.usado === null ? "Dentro" : `Usado ${ahorroPct(fila.usado, 0)}`
    }
    const signo = fila.disponible < 0 ? "−" : ""
    return `<span class="ahorroNum ${fila.disponible < 0 ? "ahorroNeg" : ""}">${signo}${formatEuro(Math.abs(fila.disponible))}</span>
        <span class="ahorroEstado ${fila.estado}">${escapeHtml(etiquetas[fila.estado])}</span>`
}

function ahorroFilaHtml(fila, vista, contexto) {
    const color = vista.colores[fila.categoria] || "var(--text-dim)"
    // La barra muestra lo consumido del presupuesto; sin presupuesto, el peso en el gasto.
    const ancho = fila.usado !== null ? Math.min(fila.usado, 100) : Math.min(Math.max(fila.peso, 0), 100)
    const barra = fila.presupuesto ? fila.estado : "peso"
    return `
        <tr class="ahorroFila ${fila.estado}">
            <td>
                <div class="ahorroCatCell">
                    <span class="ahorroDot" style="background:${color}"></span>
                    <div class="ahorroCatInfo">
                        <span class="ahorroCatNombre" title="${escapeHtml(fila.categoria)}">${escapeHtml(fila.categoria)}</span>
                        <div class="ahorroBar"><span class="ahorroBarFill ${barra}" style="width:${ancho.toFixed(1)}%"></span></div>
                    </div>
                </div>
            </td>
            <td class="num"><span class="ahorroNum">${formatEuro(fila.gastado)}</span><span class="ahorroNumSub">${ahorroPct(fila.peso)} del gasto</span></td>
            <td class="num">${ahorroCeldaPresupuesto(fila, Boolean(vista.mes), vista.ingresosPresupuesto.conMedia)}</td>
            <td class="num">${ahorroCeldaDisponible(fila)}</td>
            <td class="num">${fila.variacion ? ahorroChipHtml(fila.variacion, contexto, false) : '<span class="ahorroMuted">—</span>'}</td>
        </tr>`
}

function ahorroPieTablaHtml(vista) {
    const C = AhorroCalculos
    const conPresupuesto = vista.filas.filter((f) => f.presupuesto)
    const presupuestado = conPresupuesto.reduce((s, f) => s + f.presupuesto.importe, 0)
    const gastadoPresupuestado = conPresupuesto.reduce((s, f) => s + f.gastado, 0)
    const disponible = presupuestado - gastadoPresupuestado
    const variacion = vista.resumenPrevio?.tieneDatos
        ? C.variacion(vista.resumen.gastos, vista.resumenPrevio.gastos)
        : null
    return `
        <tr>
            <th scope="row">Total</th>
            <td class="num"><span class="ahorroNum">${formatEuro(vista.resumen.gastos)}</span></td>
            <td class="num"><span class="ahorroNum">${conPresupuesto.length ? formatEuro(presupuestado) : "—"}</span></td>
            <td class="num"><span class="ahorroNum ${disponible < 0 ? "ahorroNeg" : ""}">${conPresupuesto.length ? `${disponible < 0 ? "−" : ""}${formatEuro(Math.abs(disponible))}` : "—"}</span></td>
            <td class="num">${variacion ? ahorroChipHtml(variacion, "", false) : ""}</td>
        </tr>`
}

function ahorroPintarPresupuesto(vista) {
    const contenedor = document.getElementById("ahorroPresupuestoBody")
    if (!contenedor) return
    const conPresupuesto = vista.filas.filter((f) => f.presupuesto)
    const excedidas = conPresupuesto.filter((f) => f.estado === "excedido").length
    ahorroSetText(
        "ahorroPresupuestoSub",
        conPresupuesto.length
            ? `${ahorroPlural(conPresupuesto.length, "categoría", "categorías")} con presupuesto · ${excedidas ? `${excedidas} excedida${excedidas === 1 ? "" : "s"}` : "ninguna excedida"}`
            : "Aún no has definido presupuestos: pulsa «Presupuesto» para hacerlo"
    )
    document.querySelectorAll("#ahorroFiltros .ahorroFiltro").forEach((boton) => {
        const activo = boton.dataset.filtro === ahorroEstado.filtro
        boton.classList.toggle("active", activo)
        boton.setAttribute("aria-pressed", String(activo))
    })

    const filas = ahorroFiltrarFilas(vista.filas, ahorroEstado.filtro)
    if (!filas.length) {
        const mensajes = {
            todas: "No hay gastos en este periodo.",
            presupuesto: "Ninguna categoría tiene presupuesto.",
            excedidas: "Ninguna categoría supera su presupuesto."
        }
        contenedor.innerHTML = `<p class="ahorroEmpty">${mensajes[ahorroEstado.filtro] || mensajes.todas}</p>`
        return
    }
    const contexto = `vs ${vista.etiquetaCortaPrevio}`
    contenedor.innerHTML = `
        <table class="ahorroTabla">
            <thead>
                <tr>
                    <th scope="col">Categoría</th>
                    <th scope="col" class="num">Gastado</th>
                    <th scope="col" class="num">Presupuesto</th>
                    <th scope="col" class="num">Disponible</th>
                    <th scope="col" class="num">${escapeHtml(contexto)}</th>
                </tr>
            </thead>
            <tbody>${filas.map((f) => ahorroFilaHtml(f, vista, contexto)).join("")}</tbody>
            <tfoot>${ahorroPieTablaHtml(vista)}</tfoot>
        </table>`
}

// ── Distribución del gasto (donut SVG) ───────────────────────────────────

function ahorroSegmentosDonut(vista) {
    const positivas = vista.filas.filter((f) => f.gastado > 0.005)
    const visibles = positivas.slice(0, AHORRO_DONUT_MAX)
    const resto = positivas.slice(AHORRO_DONUT_MAX)
    const segmentos = visibles.map((f) => ({
        nombre: f.categoria,
        valor: f.gastado,
        color: vista.colores[f.categoria]
    }))
    if (resto.length) {
        segmentos.push({
            nombre: `Otras (${resto.length})`,
            valor: resto.reduce((s, f) => s + f.gastado, 0),
            color: "var(--text-dim)"
        })
    }
    const total = segmentos.reduce((s, x) => s + x.valor, 0)
    let angulo = -Math.PI / 2
    return segmentos.map((s) => {
        const fraccion = total > 0 ? s.valor / total : 0
        const segmento = { ...s, fraccion, inicio: angulo, fin: angulo + fraccion * 2 * Math.PI }
        angulo = segmento.fin
        return segmento
    })
}

function ahorroDonutPathsSvg(segmentos) {
    const cx = 90
    const cy = 90
    const exterior = 78
    const interior = 54
    const punto = (a, r) => `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`
    return segmentos
        .map((s) => {
            // Un único segmento del 100 % es un arco degenerado: se dibuja como anillo.
            if (s.fraccion >= 0.9999) {
                return `<circle cx="${cx}" cy="${cy}" r="${(exterior + interior) / 2}" fill="none" style="stroke:${s.color}" stroke-width="${exterior - interior}"/>`
            }
            const grande = s.fin - s.inicio > Math.PI ? 1 : 0
            return `<path class="ahorroDonutSlice" style="fill:${s.color}" d="M${punto(s.inicio, exterior)} A${exterior} ${exterior} 0 ${grande} 1 ${punto(s.fin, exterior)} L${punto(s.fin, interior)} A${interior} ${interior} 0 ${grande} 0 ${punto(s.inicio, interior)}Z"><title>${escapeHtml(s.nombre)}: ${formatEuro(s.valor)}</title></path>`
        })
        .join("")
}

function ahorroPintarDistribucion(vista) {
    const svg = document.getElementById("ahorroDonutSvg")
    const leyenda = document.getElementById("ahorroDonutLegend")
    if (!svg || !leyenda) return
    const segmentos = ahorroSegmentosDonut(vista)
    ahorroSetText("ahorroDonutSub", segmentos.length ? vista.etiquetaPeriodo : "")

    if (!segmentos.length) {
        svg.innerHTML = `<circle class="ahorroDonutEmpty" cx="90" cy="90" r="66" fill="none" stroke-width="24"/>
            <text class="ahorroDonutCenterSub" x="90" y="94" text-anchor="middle">Sin gastos</text>`
        leyenda.innerHTML = ""
        return
    }
    svg.innerHTML = `${ahorroDonutPathsSvg(segmentos)}
        <text class="ahorroDonutCenter" x="90" y="88" text-anchor="middle">${escapeHtml(formatEuro(vista.resumen.gastos))}</text>
        <text class="ahorroDonutCenterSub" x="90" y="104" text-anchor="middle">gasto total</text>`
    leyenda.innerHTML = segmentos
        .map(
            (s) => `
        <div class="ahorroDonutLegendRow">
            <span class="ahorroDot" style="background:${s.color}"></span>
            <span class="ahorroDonutLegendName" title="${escapeHtml(s.nombre)}">${escapeHtml(s.nombre)}</span>
            <span class="ahorroDonutLegendVal">${formatEuro(s.valor)}</span>
            <span class="ahorroDonutLegendPct">${ahorroPct(s.fraccion * 100)}</span>
        </div>`
        )
        .join("")
}

// ── Observaciones ────────────────────────────────────────────────────────

function ahorroPintarObservaciones(vista) {
    const lista = document.getElementById("ahorroInsights")
    if (!lista) return
    if (!vista.observaciones.length) {
        lista.innerHTML = `<li class="ahorroInsight info"><span class="ahorroInsightDot"></span><span>Sin datos suficientes en este periodo.</span></li>`
        return
    }
    lista.innerHTML = vista.observaciones
        .map(
            (o) =>
                `<li class="ahorroInsight ${o.tono}"><span class="ahorroInsightDot" aria-hidden="true"></span><span>${escapeHtml(o.texto)}</span></li>`
        )
        .join("")
}

// ── Eventos ──────────────────────────────────────────────────────────────

function ahorroSeleccionarAnio(anio) {
    if (anio === ahorroEstado.anio) return
    ahorroEstado.anio = anio
    // La vista anual se conserva al cambiar de año; un mes, no: el mismo mes
    // de otro año puede no tener datos.
    if (ahorroEstado.mes !== null) ahorroEstado.mes = ahorroMesPorDefecto(anio)
    ahorroRender()
}

function ahorroSeleccionarMes(clave) {
    if (clave === ahorroEstado.mes) return
    ahorroEstado.mes = clave
    ahorroRender()
}

function ahorroBindEvents() {
    const botonConfig = document.getElementById("ahorroConfigBtn")
    if (botonConfig && !botonConfig.dataset.bound) {
        botonConfig.dataset.bound = "true"
        botonConfig.addEventListener("click", openAhorroConfigModal)
    }
    const listaAnios = document.getElementById("ahorroYearList")
    if (listaAnios && !listaAnios.dataset.bound) {
        listaAnios.dataset.bound = "true"
        activarArrastreHorizontal(listaAnios)
    }
    const filtros = document.getElementById("ahorroFiltros")
    if (filtros && !filtros.dataset.bound) {
        filtros.dataset.bound = "true"
        filtros.addEventListener("click", (evento) => {
            const boton = evento.target.closest(".ahorroFiltro")
            if (!boton || boton.dataset.filtro === ahorroEstado.filtro) return
            ahorroEstado.filtro = boton.dataset.filtro
            if (ahorroEstado.vista) ahorroPintarPresupuesto(ahorroEstado.vista)
        })
    }
}

// ── Ventana de objetivo y presupuesto ────────────────────────────────────

/**
 * Categorías de gasto que se pueden presupuestar o marcar como inversión: las
 * del catálogo de Gastos, las usadas en movimientos y mensualidades del año
 * elegido y las que ya tienen presupuesto o marca (aunque hoy no aparezcan).
 * Son siempre las del usuario: no hay ninguna categoría fija.
 * @returns {string[]} Ordenadas alfabéticamente, una por categoría aunque cambien tildes o mayúsculas.
 */
function ahorroCategoriasConfigurables() {
    const C = AhorroCalculos
    const { gastosPorAnio, anio, config } = ahorroEstado
    const nombres = new Map()
    const anadir = (nombre) => {
        const limpio = String(nombre || "").trim()
        const clave = C.normalizarCategoria(limpio)
        if (limpio && !nombres.has(clave)) nombres.set(clave, limpio)
    }
    // El catálogo es común a todos los años; cualquiera de ellos lo trae.
    Object.values(gastosPorAnio).forEach((datos) => (datos?.gastosTipos || []).forEach(anadir))
    ;[...Object.keys(config.presupuesto), ...Object.keys(config.presupuestoEur), ...config.categoriasInversion].forEach(
        anadir
    )
    const datos = gastosPorAnio[anio]
    ;(datos?.mensualidades || []).forEach((m) => anadir(m.categoria))
    if ((datos?.mensualidades || []).length) anadir(C.MENSUALIDADES)
    for (const resumen of C.serieAnual(
        ahorroEstado.ingresosPorAnio,
        gastosPorAnio,
        anio,
        AHORRO_OPCIONES_SIN_INVERSION
    )) {
        Object.keys(resumen.categorias).forEach(anadir)
    }
    nombres.delete(C.normalizarCategoria(C.SIN_CATEGORIA))
    return [...nombres.values()].sort((a, b) => a.localeCompare(b, "es"))
}

/**
 * Medias mensuales del año elegido (sobre los meses con datos): ingresos y
 * gasto por categoría, con las de inversión incluidas como una categoría más.
 * @returns {{ingresos: number, porCategoria: Object<string, number>, mesesConDatos: number}}
 */
function ahorroMediasDelAnio() {
    const C = AhorroCalculos
    const { anio } = ahorroEstado
    const transcurridos = C.mesesTranscurridos(anio, new Date())
    const serie = C.serieAnual(
        ahorroEstado.ingresosPorAnio,
        ahorroEstado.gastosPorAnio,
        anio,
        AHORRO_OPCIONES_SIN_INVERSION
    )
    const meses = serie.slice(0, transcurridos > 0 ? transcurridos : 12).filter((r) => r.tieneDatos)
    const porCategoria = {}
    for (const r of meses) {
        for (const [c, v] of Object.entries(r.categorias)) porCategoria[c] = (porCategoria[c] || 0) + v
    }
    Object.keys(porCategoria).forEach((c) => {
        porCategoria[c] /= meses.length
    })
    return {
        ingresos: meses.length ? meses.reduce((s, r) => s + r.ingresos, 0) / meses.length : 0,
        porCategoria,
        mesesConDatos: meses.length
    }
}

function ahorroRedondearEur(valor) {
    return Math.round(valor)
}

function ahorroFilaConfigHtml(categoria, medias) {
    const { config } = ahorroEstado
    const eur = Number(config.presupuestoEur[categoria]) || 0
    const pct = Number(config.presupuesto[categoria]) || 0
    const modo = eur > 0 ? "eur" : "pct"
    const valor = modo === "eur" ? eur : pct || ""
    const media = medias.porCategoria[categoria] || 0
    const nombre = escapeHtml(categoria)
    // «bloqueada» (marcada como inversión) la pone ahorroActualizarModal al abrir y al marcar.
    return `
        <div class="ahorroCfgFila" data-categoria="${nombre}" data-modo="${modo}" data-media="${media.toFixed(2)}">
            <div class="ahorroCfgNombre">
                <span class="ahorroCfgCategoria" title="${nombre}">${nombre}</span>
                <span class="ahorroCfgEtiqueta">Inversión</span>
            </div>
            <span class="ahorroCfgMedia">${media > 0 ? formatEuro(media) : '<span class="ahorroMuted">—</span>'}</span>
            <div class="ahorroModoSwitch" role="group" aria-label="Tipo de presupuesto de ${nombre}">
                <button type="button" class="ahorroModoBtn${modo === "pct" ? " active" : ""}" data-modo="pct" aria-pressed="${modo === "pct"}" title="Porcentaje de los ingresos del mes">%</button>
                <button type="button" class="ahorroModoBtn${modo === "eur" ? " active" : ""}" data-modo="eur" aria-pressed="${modo === "eur"}" title="Importe fijo al mes">€</button>
            </div>
            <div class="ahorroCfgInput">
                <input class="ahorroModalInput" type="number" min="0" step="${modo === "eur" ? "1" : "0.5"}" ${modo === "pct" ? 'max="100"' : ""}
                    value="${valor}" placeholder="Sin límite" aria-label="Presupuesto de ${nombre}">
                <span class="ahorroModalPctSuffix">${modo === "eur" ? "€" : "%"}</span>
            </div>
            <span class="ahorroCfgEquivale" aria-live="polite"></span>
            <button type="button" class="ahorroCfgMediaBtn" ${media > 0 ? "" : "disabled"} title="Poner como presupuesto el gasto medio mensual">Usar media</button>
            <p class="ahorroCfgNotaInversion">Marcada como inversión: no cuenta como gasto ni como ahorro y no lleva presupuesto.</p>
        </div>`
}

// ── Categorías de inversión ──
// En la ventana principal solo se ve la elección; cambiarla exige abrir una
// segunda ventana y pulsar «Aplicar» (y después «Guardar»), para que no se
// cambie por un clic despistado. La elección pendiente vive aquí hasta guardar.
let ahorroModalInversion = []

// Resumen de solo lectura en la ventana principal, con el botón para cambiarla.
function ahorroResumenInversionHtml() {
    return `
        <section class="ahorroCfgBloque ahorroCfgInversionResumen">
            <div>
                <span class="ahorroModalSectionLabel">Categoría de inversión</span>
                <p class="ahorroModalHint">Lo que apuntes en ella no cuenta como gasto ni como ahorro, aquí y en Métricas.</p>
            </div>
            <div class="ahorroCfgInversionActual" id="ahorroCfgInversionActual"></div>
            <button type="button" class="ahorroCfgAccion" id="ahorroCfgInversionCambiar">Cambiar…</button>
        </section>`
}

function ahorroPintarInversionActual() {
    const contenedor = document.getElementById("ahorroCfgInversionActual")
    if (!contenedor) return
    contenedor.innerHTML = ahorroModalInversion.length
        ? ahorroModalInversion.map((c) => `<span class="ahorroCfgInversionNombre">${escapeHtml(c)}</span>`).join("")
        : '<span class="ahorroMuted">Ninguna: todo cuenta como gasto</span>'
}

/**
 * Segunda ventana con todas las categorías de gasto para elegir las de
 * inversión. Los cambios solo pasan a la ventana principal con «Aplicar».
 * @param {string[]} categorias Categorías disponibles (ahorroCategoriasConfigurables).
 */
function ahorroAbrirSelectorInversion(categorias) {
    ahorroCerrarSelectorInversion()
    const esInversion = AhorroCalculos.detectorDeInversion(ahorroModalInversion)
    const casillas = categorias
        .map((categoria) => {
            const nombre = escapeHtml(categoria)
            return `<label class="ahorroCfgChip">
                <input type="checkbox" value="${nombre}" ${esInversion(categoria) ? "checked" : ""}>
                <span>${nombre}</span>
            </label>`
        })
        .join("")
    const sub = document.createElement("div")
    sub.id = "ahorroInversionSubOverlay"
    sub.className = "modalOverlay ahorroSubOverlay"
    sub.innerHTML = `
        <div class="assetModal ahorroSubModal" role="dialog" aria-modal="true" aria-labelledby="ahorroSubTitulo">
            <h3 class="assetModalTitle" id="ahorroSubTitulo">Categoría de inversión</h3>
            <p class="ahorroModalHint">Elige las categorías de Gastos en las que apartas dinero para invertir (fondos, broker, plan de pensiones…). No cambia nada en Gastos: solo cómo se cuentan aquí y en Métricas.</p>
            ${
                categorias.length
                    ? `<div class="ahorroCfgChips" id="ahorroCfgInversion" role="group" aria-label="Categorías de inversión">${casillas}</div>`
                    : '<p class="ahorroModalHint ahorroModalNoTipos">Aún no hay categorías de gasto.</p>'
            }
            <div class="assetModalActions">
                <button type="button" class="cancelButton" id="ahorroSubCancelar">Cancelar</button>
                <button type="button" class="primaryButton" id="ahorroSubAplicar" data-no-autohide="true">Aplicar</button>
            </div>
        </div>`
    document.body.appendChild(sub)
    sub.addEventListener("click", (evento) => {
        if (evento.target === sub || evento.target.closest("#ahorroSubCancelar")) ahorroCerrarSelectorInversion()
        else if (evento.target.closest("#ahorroSubAplicar")) ahorroAplicarSelectorInversion()
    })
    sub.querySelector("#ahorroCfgInversion input")?.focus()
}

function ahorroAplicarSelectorInversion() {
    ahorroModalInversion = [...document.querySelectorAll("#ahorroCfgInversion input:checked")].map((c) => c.value)
    ahorroCerrarSelectorInversion()
    ahorroPintarInversionActual()
    ahorroActualizarModal()
}

function ahorroCerrarSelectorInversion() {
    document.getElementById("ahorroInversionSubOverlay")?.remove()
}

function ahorroModalHtml(categorias, medias) {
    const conBuscador = categorias.length >= AHORRO_BUSCADOR_DESDE
    const baseMedias = medias.mesesConDatos
        ? `Medias de ${ahorroEstado.anio} (${ahorroPlural(medias.mesesConDatos, "mes", "meses")} con datos) · ingresos medios ${formatEuro(medias.ingresos)}/mes`
        : `Sin datos en ${ahorroEstado.anio} para calcular medias`
    return `
        <div class="assetModal ahorroConfigModal" role="dialog" aria-modal="true" aria-labelledby="ahorroConfigTitulo">
            <header class="ahorroCfgCabecera">
                <h3 class="assetModalTitle" id="ahorroConfigTitulo">Objetivo y presupuesto</h3>
                <p class="ahorroModalHint">${escapeHtml(baseMedias)}</p>
            </header>

            <div class="ahorroCfgCuerpo">
                <section class="ahorroCfgBloque ahorroCfgObjetivo">
                    <div>
                        <label class="ahorroModalSectionLabel" for="ahorroObjetivoInput">Objetivo de ahorro</label>
                        <p class="ahorroModalHint">Porcentaje de tus ingresos que quieres guardar cada mes.</p>
                    </div>
                    <div class="ahorroCfgInput">
                        <input id="ahorroObjetivoInput" class="ahorroModalInput" type="number" min="0" max="100" step="1"
                            value="${ahorroObjetivo()}" placeholder="30">
                        <span class="ahorroModalPctSuffix">%</span>
                    </div>
                    <span class="ahorroCfgEquivale" id="ahorroObjetivoEquivale"></span>
                </section>

                ${ahorroResumenInversionHtml()}

                <section class="ahorroCfgBloque">
                    <div class="ahorroCfgReparto">
                        <div class="ahorroCfgRepartoBarra" id="ahorroRepartoBarra" aria-hidden="true"></div>
                        <div class="ahorroCfgRepartoLeyenda" id="ahorroRepartoLeyenda"></div>
                    </div>
                </section>

                <section class="ahorroCfgBloque">
                    <div class="ahorroCfgHerramientas">
                        <span class="ahorroModalSectionLabel">Presupuesto por categoría</span>
                        <div class="ahorroCfgAcciones">
                            ${conBuscador ? '<input type="search" class="ahorroCfgBuscar" id="ahorroCfgBuscar" placeholder="Buscar categoría" aria-label="Buscar categoría">' : ""}
                            ${categorias.length ? ahorroBotonConsejosHtml() : ""}
                            <button type="button" class="ahorroCfgAccion" id="ahorroCfgRellenar" title="Pone la media mensual en las categorías sin presupuesto">Rellenar vacías con la media</button>
                            <button type="button" class="ahorroCfgAccion" id="ahorroCfgLimpiar">Quitar todos</button>
                        </div>
                    </div>
                    <div class="ahorroConsejos" id="ahorroConsejosPanel" hidden></div>
                    ${
                        categorias.length
                            ? `<div class="ahorroCfgTabla">
                        <div class="ahorroCfgFila ahorroCfgCabeceraFila" aria-hidden="true">
                            <span>Categoría</span><span>Media/mes</span><span>Tipo</span><span>Presupuesto</span><span>Equivale a</span><span></span>
                        </div>
                        <div class="ahorroCfgFilas" id="ahorroCfgFilas">${categorias.map((c) => ahorroFilaConfigHtml(c, medias)).join("")}</div>
                    </div>`
                            : `<p class="ahorroModalHint ahorroModalNoTipos">Añade gastos con categoría en Gastos para poder presupuestarlos.</p>`
                    }
                </section>
            </div>

            <footer class="ahorroCfgPie">
                <div class="ahorroModalTotales" id="ahorroModalTotales"></div>
                <p class="ahorroModalFeedback hidden" id="ahorroModalFeedback" role="alert"></p>
                <div class="assetModalActions">
                    <button type="button" class="cancelButton" id="ahorroModalCancelBtn">Cancelar</button>
                    <button type="button" class="primaryButton" id="ahorroModalSaveBtn" data-no-autohide="true">Guardar</button>
                </div>
            </footer>
        </div>`
}

function openAhorroConfigModal() {
    closeAhorroConfigModal()
    const categorias = ahorroCategoriasConfigurables()
    const medias = ahorroMediasDelAnio()
    const overlay = document.createElement("div")
    overlay.id = "ahorroConfigModalOverlay"
    overlay.className = "modalOverlay"
    overlay.innerHTML = ahorroModalHtml(categorias, medias)
    overlay.dataset.ingresosMedios = String(medias.ingresos)
    document.body.appendChild(overlay)
    ahorroModalInversion = [...ahorroEstado.config.categoriasInversion]
    ahorroPintarInversionActual()

    overlay.querySelector("#ahorroModalCancelBtn").addEventListener("click", closeAhorroConfigModal)
    overlay.querySelector("#ahorroModalSaveBtn").addEventListener("click", ahorroGuardarConfig)
    overlay
        .querySelector("#ahorroCfgInversionCambiar")
        .addEventListener("click", () => ahorroAbrirSelectorInversion(categorias))
    overlay.addEventListener("input", (evento) => {
        if (evento.target.id === "ahorroCfgBuscar") ahorroFiltrarModal(evento.target.value)
        else ahorroActualizarModal()
    })
    overlay.addEventListener("click", (evento) => ahorroClickModal(evento, overlay, medias.ingresos))
    ahorroActualizarModal()

    // Escape cierra primero la ventana de inversión, si está abierta, y solo después la principal.
    ahorroConfigModalKeyHandler = (evento) => {
        if (evento.key !== "Escape") return
        if (document.getElementById("ahorroInversionSubOverlay")) ahorroCerrarSelectorInversion()
        else closeAhorroConfigModal()
    }
    document.addEventListener("keydown", ahorroConfigModalKeyHandler)
    overlay.querySelector("#ahorroObjetivoInput")?.focus()
}

function ahorroClickModal(evento, overlay, ingresosMedios) {
    // Clic en el fondo, fuera de la ventana: cerrar.
    if (evento.target === overlay) {
        closeAhorroConfigModal()
        return
    }
    const fila = evento.target.closest(".ahorroCfgFila")
    const modo = evento.target.closest(".ahorroModoBtn")
    if (modo) {
        ahorroCambiarModo(fila, modo.dataset.modo, ingresosMedios)
        return
    }
    if (evento.target.closest(".ahorroCfgMediaBtn") && fila) {
        ahorroUsarMedia(fila)
        ahorroActualizarModal()
        return
    }
    if (ahorroClickConsejos(evento)) return
    if (evento.target.closest("#ahorroCfgRellenar")) {
        ahorroFilasEditables().forEach((f) => {
            if (!(parseFloat(f.querySelector(".ahorroModalInput").value) > 0)) ahorroUsarMedia(f)
        })
        ahorroActualizarModal()
        return
    }
    if (evento.target.closest("#ahorroCfgLimpiar")) {
        ahorroFilasEditables().forEach((f) => {
            f.querySelector(".ahorroModalInput").value = ""
        })
        ahorroActualizarModal()
    }
}

// Categorías de inversión elegidas en la ventana (aún sin guardar).
function ahorroInversionMarcadaEnModal() {
    return ahorroModalInversion
}

// Filas que llevan presupuesto: todas salvo las marcadas como inversión.
function ahorroFilasEditables() {
    const esInversion = AhorroCalculos.detectorDeInversion(ahorroInversionMarcadaEnModal())
    return [...document.querySelectorAll("#ahorroCfgFilas .ahorroCfgFila")].filter(
        (f) => !esInversion(f.dataset.categoria)
    )
}

function ahorroUsarMedia(fila) {
    const media = parseFloat(fila.dataset.media)
    if (!(media > 0)) return
    if (fila.dataset.modo !== "eur") ahorroCambiarModo(fila, "eur", 0)
    fila.querySelector(".ahorroModalInput").value = ahorroRedondearEur(media)
}

function ahorroFiltrarModal(texto) {
    const consulta = AhorroCalculos.normalizarCategoria(texto)
    document.querySelectorAll("#ahorroCfgFilas .ahorroCfgFila").forEach((fila) => {
        const coincide = !consulta || AhorroCalculos.normalizarCategoria(fila.dataset.categoria).includes(consulta)
        fila.classList.toggle("oculta", !coincide)
    })
}

/**
 * Cambia una categoría entre % y €, convirtiendo el valor con los ingresos
 * medios del año para que no se interprete 20 % como 20 €.
 */
function ahorroCambiarModo(fila, modo, ingresosMedios) {
    if (!fila || fila.dataset.modo === modo) return
    const input = fila.querySelector(".ahorroModalInput")
    const actual = parseFloat(input.value)
    let convertido = ""
    if (Number.isFinite(actual) && actual > 0 && ingresosMedios > 0) {
        convertido =
            modo === "eur"
                ? ahorroRedondearEur((actual * ingresosMedios) / 100)
                : Math.min(100, Math.round((actual / ingresosMedios) * 100 * 2) / 2)
    }
    fila.dataset.modo = modo
    fila.querySelectorAll(".ahorroModoBtn").forEach((b) => {
        const activo = b.dataset.modo === modo
        b.classList.toggle("active", activo)
        b.setAttribute("aria-pressed", String(activo))
    })
    input.step = modo === "eur" ? "1" : "0.5"
    if (modo === "pct") input.max = "100"
    else input.removeAttribute("max")
    input.value = convertido
    fila.querySelector(".ahorroModalPctSuffix").textContent = modo === "eur" ? "€" : "%"
    ahorroActualizarModal()
}

/**
 * Lee el formulario de la ventana.
 * @returns {{objetivo: number, presupuesto: object, presupuestoEur: object, categoriasInversion: string[]}}
 */
function ahorroLeerModal() {
    const objetivo = parseFloat(document.getElementById("ahorroObjetivoInput")?.value)
    const categoriasInversion = ahorroInversionMarcadaEnModal()
    const presupuesto = {}
    const presupuestoEur = {}
    ahorroFilasEditables().forEach((fila) => {
        const valor = parseFloat(fila.querySelector(".ahorroModalInput").value)
        if (!Number.isFinite(valor) || valor <= 0) return
        if (fila.dataset.modo === "eur") presupuestoEur[fila.dataset.categoria] = Math.round(valor * 100) / 100
        else presupuesto[fila.dataset.categoria] = Math.min(100, valor)
    })
    return { objetivo, presupuesto, presupuestoEur, categoriasInversion }
}

function ahorroSumaPct({ objetivo, presupuesto }) {
    return (Number.isFinite(objetivo) ? objetivo : 0) + Object.values(presupuesto).reduce((s, v) => s + v, 0)
}

// Repinta todo lo que depende de los campos: equivalencias por fila,
// filas marcadas como inversión, barra de reparto y totales.
function ahorroActualizarModal() {
    const overlay = document.getElementById("ahorroConfigModalOverlay")
    if (!overlay) return
    const ingresosMedios = Number(overlay.dataset.ingresosMedios) || 0
    const datos = ahorroLeerModal()
    const esInversion = AhorroCalculos.detectorDeInversion(datos.categoriasInversion)

    document.querySelectorAll("#ahorroCfgFilas .ahorroCfgFila").forEach((fila) => {
        fila.classList.toggle("bloqueada", esInversion(fila.dataset.categoria))
        const valor = parseFloat(fila.querySelector(".ahorroModalInput").value)
        const equivale = fila.querySelector(".ahorroCfgEquivale")
        if (!(valor > 0) || !(ingresosMedios > 0)) equivale.textContent = ""
        else if (fila.dataset.modo === "eur") equivale.textContent = `≈ ${ahorroPct((valor / ingresosMedios) * 100)}`
        else equivale.textContent = `≈ ${formatEuro((valor * ingresosMedios) / 100)}`
    })

    const objetivoEquivale = document.getElementById("ahorroObjetivoEquivale")
    if (objetivoEquivale) {
        objetivoEquivale.textContent =
            ingresosMedios > 0 && Number.isFinite(datos.objetivo)
                ? `≈ ${formatEuro((datos.objetivo * ingresosMedios) / 100)} al mes`
                : ""
    }
    ahorroPintarReparto(datos, ingresosMedios)
    ahorroPintarConsejos(datos, ingresosMedios)
}

// ── Consejos (lamparita) ──
// Pautas genéricas de AhorroConsejos: no tocan ni leen las categorías del
// usuario, que pone sus porcentajes a mano. Se repintan con cada cambio porque
// el aviso depende del objetivo escrito en la ventana.

function ahorroBotonConsejosHtml() {
    return `<button type="button" class="ahorroCfgAccion ahorroConsejosBtn" id="ahorroCfgConsejos"
        aria-expanded="false" aria-controls="ahorroConsejosPanel"
        title="Pautas orientativas de reparto de los ingresos">${AHORRO_ICONOS.bombilla}<span>Consejos</span></button>`
}

/**
 * Abre o cierra el panel de consejos si el clic era en su botón.
 * @param {MouseEvent} evento
 * @returns {boolean} true si el clic era del botón de consejos.
 */
function ahorroClickConsejos(evento) {
    const boton = evento.target.closest("#ahorroCfgConsejos")
    if (!boton) return false
    const panel = document.getElementById("ahorroConsejosPanel")
    const abrir = panel.hidden
    panel.hidden = !abrir
    boton.classList.toggle("active", abrir)
    boton.setAttribute("aria-expanded", String(abrir))
    ahorroActualizarModal()
    return true
}

function ahorroRangoEur(pauta) {
    if (pauta.minEur === null) return ""
    return `${formatEuro(pauta.minEur)} – ${formatEuro(pauta.maxEur)}`
}

function ahorroConsejoFilaHtml(pauta) {
    return `
        <div class="ahorroConsejoFila">
            <div class="ahorroConsejoNombre">
                <span class="ahorroConsejoTipo">${escapeHtml(pauta.nombre)}</span>
                <span class="ahorroConsejoPauta">${escapeHtml(pauta.ejemplos)}</span>
            </div>
            <span class="ahorroConsejoEur">${escapeHtml(ahorroRangoEur(pauta))}</span>
            <span class="ahorroConsejoValor">${pauta.min}–${pauta.max} %</span>
        </div>`
}

function ahorroConsejoGrupoHtml(grupo) {
    const tope = grupo.topeEur === null ? "" : ` · ${formatEuro(grupo.topeEur)}`
    return `
        <div class="ahorroConsejosGrupo">
            <span class="ahorroModalSectionLabel">${escapeHtml(grupo.titulo)} · hasta ${grupo.tope} %${escapeHtml(tope)}</span>
            <div class="ahorroConsejosLista">${grupo.pautas.map(ahorroConsejoFilaHtml).join("")}</div>
        </div>`
}

function ahorroPintarConsejos(datos, ingresosMedios) {
    const panel = document.getElementById("ahorroConsejosPanel")
    if (!panel || panel.hidden) return
    const { grupos, aviso } = AhorroConsejos.consejos({ ingresos: ingresosMedios, objetivo: datos.objetivo })
    const base =
        ingresosMedios > 0 ? ` Los euros son sobre tus ingresos medios (${formatEuro(ingresosMedios)}/mes).` : ""
    const avisoHtml = aviso
        ? `<ul class="ahorroConsejosAvisos"><li class="ahorroInsight ${aviso.tono}"><span class="ahorroInsightDot" aria-hidden="true"></span><span>${escapeHtml(aviso.texto)}</span></li></ul>`
        : ""
    panel.innerHTML = `
        <div class="ahorroConsejosCabecera">
            <span class="ahorroConsejosIcono">${AHORRO_ICONOS.bombilla}</span>
            <div>
                <span class="ahorroConsejosTitulo">Cómo repartir los ingresos</span>
                <p class="ahorroModalHint">Pautas orientativas según la regla 50/30/20: 50 % para necesidades, 30 % para deseos y 20 % para ahorro. Úsalas como referencia y pon tú el porcentaje de cada categoría en la tabla.${escapeHtml(base)}</p>
            </div>
        </div>
        ${avisoHtml}
        ${grupos.map(ahorroConsejoGrupoHtml).join("")}`
}

/**
 * Barra de cómo se reparten los ingresos medios: objetivo de ahorro,
 * presupuestos y lo que queda sin asignar (o lo que sobra, en rojo).
 */
function ahorroPintarReparto(datos, ingresosMedios) {
    const barra = document.getElementById("ahorroRepartoBarra")
    const leyenda = document.getElementById("ahorroRepartoLeyenda")
    const totales = document.getElementById("ahorroModalTotales")
    const pctObjetivo = Number.isFinite(datos.objetivo) ? datos.objetivo : 0
    const pctPorcentajes = Object.values(datos.presupuesto).reduce((s, v) => s + v, 0)
    const fijos = Object.values(datos.presupuestoEur).reduce((s, v) => s + v, 0)
    const pctFijos = ingresosMedios > 0 ? (fijos / ingresosMedios) * 100 : 0
    const asignado = pctObjetivo + pctPorcentajes + pctFijos
    const libre = Math.max(0, 100 - asignado)
    const escala = Math.max(100, asignado)
    const tramo = (clase, pct) =>
        pct > 0 ? `<span class="${clase}" style="width:${((pct / escala) * 100).toFixed(2)}%"></span>` : ""

    if (barra) {
        barra.innerHTML =
            tramo("objetivo", pctObjetivo) + tramo("presupuesto", pctPorcentajes + pctFijos) + tramo("libre", libre)
        barra.classList.toggle("excedido", asignado > 100)
    }
    if (leyenda) {
        const eur = (pct) => (ingresosMedios > 0 ? ` · ${formatEuro((pct * ingresosMedios) / 100)}` : "")
        leyenda.innerHTML = `
            <span><span class="ahorroDot objetivo"></span>Ahorro ${ahorroPct(pctObjetivo, 0)}${eur(pctObjetivo)}</span>
            <span><span class="ahorroDot presupuesto"></span>Presupuestos ${ahorroPct(pctPorcentajes + pctFijos, 0)}${eur(pctPorcentajes + pctFijos)}</span>
            <span class="${asignado > 100 ? "ahorroNeg" : ""}"><span class="ahorroDot libre"></span>${asignado > 100 ? `Te pasas ${ahorroPct(asignado - 100, 0)}` : `Sin asignar ${ahorroPct(libre, 0)}${eur(libre)}`}</span>`
    }
    if (totales) {
        const sumaPct = ahorroSumaPct(datos)
        totales.innerHTML =
            sumaPct > 100
                ? `<span class="over">El objetivo más los porcentajes suman ${ahorroPct(sumaPct)}: no pueden pasar del 100 %.</span>`
                : asignado > 100
                  ? `<span class="warn">Con los importes fijos superas tus ingresos medios del año.</span>`
                  : ""
    }
}

function closeAhorroConfigModal() {
    ahorroCerrarSelectorInversion()
    document.getElementById("ahorroConfigModalOverlay")?.remove()
    if (ahorroConfigModalKeyHandler) {
        document.removeEventListener("keydown", ahorroConfigModalKeyHandler)
        ahorroConfigModalKeyHandler = null
    }
}

async function ahorroGuardarConfig() {
    const feedback = document.getElementById("ahorroModalFeedback")
    const avisar = (mensaje) => {
        if (!feedback) return
        feedback.textContent = mensaje
        feedback.classList.toggle("hidden", !mensaje)
        feedback.classList.toggle("error", Boolean(mensaje))
    }
    const datos = ahorroLeerModal()
    if (!Number.isFinite(datos.objetivo) || datos.objetivo < 0 || datos.objetivo > 100) {
        avisar("El objetivo de ahorro debe estar entre 0 y 100.")
        return
    }
    const suma = ahorroSumaPct(datos)
    if (suma > 100) {
        avisar(`El objetivo más los porcentajes por categoría no pueden pasar del 100 % (ahora: ${ahorroPct(suma)}).`)
        return
    }

    const nueva = {
        objetivoAhorro: datos.objetivo,
        presupuesto: datos.presupuesto,
        presupuestoEur: datos.presupuestoEur,
        categoriasInversion: datos.categoriasInversion
    }
    const boton = document.getElementById("ahorroModalSaveBtn")
    if (boton) boton.disabled = true
    try {
        const respuesta = await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ahorroConfig: nueva })
        })
        if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`)
        ahorroEstado.config = ahorroNormalizarConfig(nueva)
        closeAhorroConfigModal()
        ahorroRender()
    } catch (err) {
        console.error("No se pudo guardar la configuración de ahorro:", err)
        avisar("No se pudo guardar la configuración.")
        if (boton) boton.disabled = false
    }
}
