// Escala y navegación al estilo TradingView en los gráficos de línea.
//
// Plugin global de Chart.js que añade a todo gráfico de línea con eje Y numérico:
//
//   - Arrastrar el eje Y hacia arriba estira la línea (menos rango visible) y hacia
//     abajo la comprime (más rango).
//   - Arrastrar el eje X (las fechas) hacia la izquierda estira el tiempo (se ven
//     menos meses) y hacia la derecha lo comprime. El borde derecho queda fijo, como
//     en TradingView, para no perder de vista lo más reciente.
//   - Arrastrar dentro del gráfico lo desplaza: arriba y abajo en precio, a los lados
//     en el tiempo.
//   - Doble clic en un eje devuelve ese eje a la escala automática; el botón «AUTO»
//     de la esquina y el botón «Centrar» de arriba a la derecha devuelven los dos.
//   - Botón «LOG» en la esquina para alternar entre escala lineal y logarítmica. Solo
//     sale cuando todos los valores son positivos: con un cero o un negativo (vistas
//     en %, ganancias y pérdidas) la escala logarítmica no tiene sentido.
//
// El eje X solo se mueve si es numérico (lineal o de tiempo); en uno de categorías
// (meses como etiquetas) solo funciona el eje Y. Arrastrar dentro del gráfico es cosa
// del ratón: con el dedo se dejaría de poder hacer scroll de la página.
//
// La elección de LOG se recuerda por gráfico (id del canvas) con setChartPref; los
// rangos movidos a mano no, igual que en TradingView, donde cambiar de símbolo vuelve
// a «auto». Un gráfico se excluye con `options.plugins.escalaPrecio: false`.

const ESCALA_PRECIO_ID = "escalaPrecio"
// Píxeles de arrastre que multiplican o dividen el rango visible por e (~2,7). Con
// menos el eje salta demasiado con un movimiento corto de ratón.
const ESCALA_PRECIO_SENSIBILIDAD = 200
// Píxeles que hay que mover el ratón dentro del gráfico para que cuente como arrastre
// y no como clic: los gráficos con onClick siguen respondiendo a un clic normal.
const ESCALA_PRECIO_UMBRAL_ARRASTRE = 4
// Por debajo de este ancho del eje no caben los botones sin pisar las marcas.
const ESCALA_PRECIO_ANCHO_MINIMO = 30
const ESCALA_PRECIO_ALTO_BOTON = 16
// Botón «Centrar» de arriba a la derecha: alto y separación del borde del área.
const ESCALA_PRECIO_ALTO_CENTRAR = 22
const ESCALA_PRECIO_MARGEN_CENTRAR = 6
const ESCALA_PRECIO_PREFIJO_PREF = "escalaLog:"
const ESCALA_PRECIO_TIPOS_X = new Set(["linear", "time", "timeseries"])

/**
 * Nuevo rango del eje tras arrastrar, manteniendo fijo el centro.
 *
 * En escala logarítmica el centro y el estiramiento se calculan sobre log10 para
 * que el resultado sea simétrico en pantalla.
 *
 * Args:
 *     min: Valor más bajo visible al empezar el arrastre.
 *     max: Valor más alto visible al empezar el arrastre.
 *     desplazamiento: Píxeles movidos en vertical; positivo es hacia abajo.
 *     logaritmica: Si el eje es logarítmico.
 *
 * Returns:
 *     `{ min, max }` del nuevo rango, o null si el rango de partida no es válido.
 *
 * Example:
 *     escalaPrecioRango(50, 70, 0, false)  // { min: 50, max: 70 }
 */
function escalaPrecioRango(min, max, desplazamiento, logaritmica) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null
    if (logaritmica && min <= 0) return null
    const transformar = logaritmica ? Math.log10 : (valor) => valor
    const deshacer = logaritmica ? (valor) => 10 ** valor : (valor) => valor
    const inferior = transformar(min)
    const superior = transformar(max)
    const centro = (inferior + superior) / 2
    const mitad = ((superior - inferior) / 2) * Math.exp(desplazamiento / ESCALA_PRECIO_SENSIBILIDAD)
    return { min: deshacer(centro - mitad), max: deshacer(centro + mitad) }
}

/**
 * Nuevo rango del eje de tiempo tras arrastrarlo, con el borde derecho fijo.
 *
 * Args:
 *     min: Inicio visible al empezar el arrastre.
 *     max: Final visible al empezar el arrastre.
 *     desplazamiento: Píxeles movidos en horizontal; positivo es hacia la derecha,
 *         que comprime (se ven más días), y negativo hacia la izquierda, que estira.
 *
 * Returns:
 *     `{ min, max }` del nuevo rango, o null si el rango de partida no es válido.
 *
 * Example:
 *     escalaPrecioRangoTiempo(0, 100, 0)  // { min: 0, max: 100 }
 */
function escalaPrecioRangoTiempo(min, max, desplazamiento) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null
    const ancho = (max - min) * Math.exp(desplazamiento / ESCALA_PRECIO_SENSIBILIDAD)
    return { min: max - ancho, max }
}

/**
 * Desplaza un rango sin cambiar su tamaño.
 *
 * Args:
 *     min: Valor más bajo visible al empezar el arrastre.
 *     max: Valor más alto visible al empezar el arrastre.
 *     fraccion: Cuánto se mueve, como fracción del rango visible; positivo sube los
 *         valores.
 *     logaritmica: Si el eje es logarítmico; entonces se desplaza sobre log10.
 *
 * Returns:
 *     `{ min, max }` desplazado, o null si el rango de partida no es válido.
 *
 * Example:
 *     escalaPrecioDesplazar(50, 70, 0.5, false)  // { min: 60, max: 80 }
 */
function escalaPrecioDesplazar(min, max, fraccion, logaritmica) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || !Number.isFinite(fraccion)) return null
    if (logaritmica) {
        if (min <= 0) return null
        const delta = (Math.log10(max) - Math.log10(min)) * fraccion
        return { min: min * 10 ** delta, max: max * 10 ** delta }
    }
    const delta = (max - min) * fraccion
    return { min: min + delta, max: max + delta }
}

/**
 * Corrige un rango para que su centro no salga de la extensión de los datos.
 *
 * Así, por mucho que se desplace el gráfico, siempre queda algo de línea a la vista.
 *
 * Args:
 *     rango: `{ min, max }` propuesto.
 *     extension: `{ min, max }` con los datos, o null si no se conoce.
 *
 * Returns:
 *     El rango, movido lo justo para que su centro caiga dentro de la extensión.
 */
function escalaPrecioLimitar(rango, extension) {
    if (!rango || !extension) return rango
    const centro = (rango.min + rango.max) / 2
    const limitado = Math.min(Math.max(centro, extension.min), extension.max)
    const delta = limitado - centro
    return { min: rango.min + delta, max: rango.max + delta }
}

/**
 * Primer y último valor X de los datasets.
 *
 * Un gráfico puede cargar datos fuera de lo que encuadra al empezar (el histórico
 * anterior a un rango) para verlos al alejar: el desplazamiento tiene que poder
 * llegar hasta ellos, no quedarse en el encuadre inicial.
 *
 * Args:
 *     datasets: Datasets del gráfico (`chart.data.datasets`), con datos `{ x, y }`.
 *
 * Returns:
 *     `{ min, max }`, o null si ningún dato tiene una X numérica.
 *
 * Example:
 *     escalaPrecioExtensionX([{ data: [{ x: 5, y: 1 }, { x: 2, y: 3 }] }])  // { min: 2, max: 5 }
 */
function escalaPrecioExtensionX(datasets) {
    let min = Infinity
    let max = -Infinity
    for (const dataset of datasets || []) {
        for (const dato of dataset?.data || []) {
            const x = dato?.x
            if (typeof x !== "number" || !Number.isFinite(x)) continue
            if (x < min) min = x
            if (x > max) max = x
        }
    }
    return min <= max ? { min, max } : null
}

/**
 * Indica si todos los valores Y de los datasets son positivos.
 *
 * Acepta datos como números sueltos o como objetos `{ x, y }`; los huecos (null,
 * NaN) se ignoran porque Chart.js tampoco los pinta.
 *
 * Args:
 *     datasets: Datasets del gráfico (`chart.data.datasets`).
 *
 * Returns:
 *     true si hay al menos un valor y ninguno es cero o negativo.
 */
function escalaPrecioDatosPositivos(datasets) {
    let alguno = false
    for (const dataset of datasets || []) {
        if (dataset?.hidden) continue
        for (const dato of dataset?.data || []) {
            const valor = typeof dato === "number" ? dato : dato?.y
            if (typeof valor !== "number" || !Number.isFinite(valor)) continue
            if (valor <= 0) return false
            alguno = true
        }
    }
    return alguno
}

/**
 * Decide si el plugin actúa sobre un gráfico ya construido.
 *
 * Args:
 *     chart: Instancia de Chart.js.
 *
 * Returns:
 *     true si es un gráfico de línea horizontal con eje Y numérico visible.
 */
function escalaPrecioAplica(chart) {
    const eje = chart.scales?.y
    return (
        chart.config.type === "line" &&
        chart.options?.indexAxis !== "y" &&
        Boolean(eje) &&
        eje.options?.display !== false &&
        (eje.type === "linear" || eje.type === "logarithmic")
    )
}

/**
 * Decide si el eje X del gráfico se puede estirar y desplazar.
 *
 * Args:
 *     chart: Instancia de Chart.js a la que ya se aplica el plugin.
 *
 * Returns:
 *     true si el eje X es numérico (lineal o de tiempo) y está visible.
 */
function escalaPrecioAplicaX(chart) {
    const eje = chart.scales?.x
    return Boolean(eje) && eje.options?.display !== false && ESCALA_PRECIO_TIPOS_X.has(eje.type)
}

if (typeof Chart !== "undefined") {
    const estados = new WeakMap()

    const configEje = (chart, id) => {
        const opciones = chart.config.options
        opciones.scales = opciones.scales || {}
        opciones.scales[id] = opciones.scales[id] || {}
        return opciones.scales[id]
    }

    const clavePreferencia = (chart) => (chart.canvas?.id ? ESCALA_PRECIO_PREFIJO_PREF + chart.canvas.id : "")

    const ejeALaIzquierda = (chart) => chart.scales.y.position === "left"

    const hayRangoManual = (estado) => Boolean(estado.originales.x || estado.originales.y)

    // Zona del eje Y dentro del alto del área de dibujo, donde se arrastra.
    const enEjeY = (chart, punto) => {
        const { chartArea } = chart
        if (punto.y < chartArea.top || punto.y > chartArea.bottom) return false
        return ejeALaIzquierda(chart) ? punto.x < chartArea.left : punto.x > chartArea.right
    }

    // Zona del eje X (las fechas) bajo el área de dibujo.
    const enEjeX = (chart, punto) => {
        const { chartArea } = chart
        return (
            escalaPrecioAplicaX(chart) &&
            punto.y > chartArea.bottom &&
            punto.x >= chartArea.left &&
            punto.x <= chartArea.right
        )
    }

    const enArea = (chart, punto) => {
        const { chartArea } = chart
        return (
            punto.x >= chartArea.left &&
            punto.x <= chartArea.right &&
            punto.y >= chartArea.top &&
            punto.y <= chartArea.bottom
        )
    }

    const botonEn = (estado, punto) =>
        estado.botones.find(
            (boton) =>
                punto.x >= boton.x &&
                punto.x <= boton.x + boton.ancho &&
                punto.y >= boton.y &&
                punto.y <= boton.y + boton.alto
        )

    const posicion = (chart, evento) => Chart.helpers.getRelativePosition(evento, chart)

    // Guarda lo que el eje traía de serie antes de fijar el rango a mano, para poder
    // devolvérselo tal cual al volver a «auto». En X guarda además la extensión de los
    // datos, que es la que se ve en automático, para no dejar desplazar fuera de ella.
    const guardarOriginal = (chart, estado, id) => {
        if (estado.originales[id]) return
        const eje = configEje(chart, id)
        const escala = chart.scales[id]
        // En X, también lo cargado fuera del encuadre inicial.
        const datos = id === "x" ? escalaPrecioExtensionX(chart.data.datasets) : null
        estado.originales[id] = {
            min: eje.min,
            max: eje.max,
            grace: eje.grace,
            includeBounds: eje.ticks?.includeBounds,
            extension: {
                min: Math.min(escala.min, datos?.min ?? Infinity),
                max: Math.max(escala.max, datos?.max ?? -Infinity)
            }
        }
    }

    const restaurarPropiedad = (destino, clave, valor) => {
        if (valor === undefined) delete destino[clave]
        else destino[clave] = valor
    }

    const quitarRangoManual = (chart, estado, id) => {
        const original = estado.originales[id]
        if (!original) return
        const eje = configEje(chart, id)
        restaurarPropiedad(eje, "min", original.min)
        restaurarPropiedad(eje, "max", original.max)
        restaurarPropiedad(eje, "grace", original.grace)
        if (eje.ticks) restaurarPropiedad(eje.ticks, "includeBounds", original.includeBounds)
        delete estado.originales[id]
    }

    // Fija el rango de un eje sin redibujar: quien llama hace un único update al final.
    const fijarRango = (chart, estado, id, rango) => {
        if (!rango) return
        guardarOriginal(chart, estado, id)
        const eje = configEje(chart, id)
        eje.min = rango.min
        eje.max = rango.max
        // Con el rango fijado, el margen extra y las marcas en los bordes sobran:
        // los bordes casi nunca son cifras ni fechas redondas.
        eje.grace = 0
        eje.ticks = eje.ticks || {}
        eje.ticks.includeBounds = false
    }

    const ponerTipo = (chart, logaritmica) => {
        configEje(chart, "y").type = logaritmica ? "logarithmic" : "linear"
    }

    const alternarLog = (chart, estado) => {
        estado.log = !estado.log
        const clave = clavePreferencia(chart)
        if (clave && typeof setChartPref === "function") setChartPref(clave, estado.log || null)
        // El rango estirado en una escala no significa lo mismo en la otra.
        quitarRangoManual(chart, estado, "y")
        ponerTipo(chart, estado.log)
        chart.update()
    }

    const volverAAuto = (chart, estado, ids) => {
        ids.forEach((id) => quitarRangoManual(chart, estado, id))
        chart.update("none")
    }

    const ponerCursor = (chart, estado, cursor) => {
        if (estado.cursor === cursor) return
        if (estado.cursor === null) estado.cursorPrevio = chart.canvas.style.cursor
        chart.canvas.style.cursor = cursor ?? estado.cursorPrevio
        estado.cursor = cursor
    }

    const rangoDe = (escala) => ({ min: escala.min, max: escala.max })

    // Qué arrastre empieza en ese punto, o null si ninguno.
    const tipoDeArrastre = (chart, punto, evento) => {
        if (enEjeY(chart, punto)) return "ejeY"
        if (enEjeX(chart, punto)) return "ejeX"
        if (evento.pointerType !== "touch" && enArea(chart, punto)) return "mover"
        return null
    }

    const alPulsar = (chart, estado, evento) => {
        if (evento.button !== 0 || !escalaPrecioAplica(chart)) return
        const punto = posicion(chart, evento)
        const boton = botonEn(estado, punto)
        if (boton) {
            evento.preventDefault()
            // «Centrar» y «AUTO» desaparecen al pulsarlos: cuando llegue el clic ya no
            // habrá botón en ese punto, así que se marca ahora para que no siga.
            estado.ignorarClic = true
            if (boton.accion === "log") alternarLog(chart, estado)
            else volverAAuto(chart, estado, ["x", "y"])
            return
        }
        const tipo = tipoDeArrastre(chart, punto, evento)
        if (!tipo) return
        evento.preventDefault()
        estado.arrastre = {
            tipo,
            x: punto.x,
            y: punto.y,
            rangoY: rangoDe(chart.scales.y),
            rangoX: escalaPrecioAplicaX(chart) ? rangoDe(chart.scales.x) : null,
            log: chart.scales.y.type === "logarithmic",
            // Dentro del gráfico no cuenta como arrastre hasta pasar el umbral.
            activo: tipo !== "mover",
            pointerId: evento.pointerId
        }
        if (estado.arrastre.activo) chart.canvas.setPointerCapture?.(evento.pointerId)
    }

    // Desplaza lo que se ve: arriba y abajo en precio, a los lados en tiempo.
    const mover = (chart, estado, dx, dy) => {
        const { rangoY, rangoX, log } = estado.arrastre
        const { chartArea } = chart
        const alto = chartArea.bottom - chartArea.top
        const ancho = chartArea.right - chartArea.left
        if (alto > 0) fijarRango(chart, estado, "y", escalaPrecioDesplazar(rangoY.min, rangoY.max, dy / alto, log))
        if (rangoX && ancho > 0) {
            const rango = escalaPrecioDesplazar(rangoX.min, rangoX.max, -dx / ancho, false)
            fijarRango(chart, estado, "x", escalaPrecioLimitar(rango, estado.originales.x?.extension ?? rangoX))
        }
    }

    const continuarArrastre = (chart, estado, punto) => {
        const arrastre = estado.arrastre
        const dx = punto.x - arrastre.x
        const dy = punto.y - arrastre.y
        if (!arrastre.activo) {
            if (Math.hypot(dx, dy) < ESCALA_PRECIO_UMBRAL_ARRASTRE) return
            arrastre.activo = true
            chart.canvas.setPointerCapture?.(arrastre.pointerId)
            ponerCursor(chart, estado, "grabbing")
        }
        if (arrastre.tipo === "ejeY") {
            fijarRango(
                chart,
                estado,
                "y",
                escalaPrecioRango(arrastre.rangoY.min, arrastre.rangoY.max, dy, arrastre.log)
            )
        } else if (arrastre.tipo === "ejeX") {
            fijarRango(chart, estado, "x", escalaPrecioRangoTiempo(arrastre.rangoX.min, arrastre.rangoX.max, dx))
        } else {
            mover(chart, estado, dx, dy)
        }
        chart.update("none")
    }

    const alMover = (chart, estado, evento) => {
        if (!escalaPrecioAplica(chart)) return
        const punto = posicion(chart, evento)
        if (estado.arrastre) {
            continuarArrastre(chart, estado, punto)
            return
        }
        if (botonEn(estado, punto)) ponerCursor(chart, estado, "pointer")
        else if (enEjeY(chart, punto)) ponerCursor(chart, estado, "ns-resize")
        else if (enEjeX(chart, punto)) ponerCursor(chart, estado, "ew-resize")
        else ponerCursor(chart, estado, null)
    }

    const alSoltar = (chart, estado, evento) => {
        const arrastre = estado.arrastre
        if (!arrastre) return
        estado.arrastre = null
        // El clic que llega justo después de arrastrar no debe abrir nada.
        estado.ignorarClic = arrastre.activo
        if (arrastre.activo) {
            chart.canvas.releasePointerCapture?.(evento.pointerId)
            ponerCursor(chart, estado, null)
        }
    }

    const alDobleClic = (chart, estado, evento) => {
        if (!escalaPrecioAplica(chart)) return
        const punto = posicion(chart, evento)
        if (enEjeY(chart, punto)) volverAAuto(chart, estado, ["y"])
        else if (enEjeX(chart, punto)) volverAAuto(chart, estado, ["x"])
    }

    // Que pulsar un botón o un eje, o soltar tras arrastrar, no dispare además el
    // onClick del gráfico (abrir un detalle, filtrar...). En captura, para adelantarse
    // al listener de Chart.js.
    const alClic = (chart, estado, evento) => {
        const ignorar = estado.ignorarClic
        estado.ignorarClic = false
        if (!escalaPrecioAplica(chart)) return
        const punto = posicion(chart, evento)
        if (ignorar || botonEn(estado, punto) || enEjeY(chart, punto) || enEjeX(chart, punto)) {
            evento.stopImmediatePropagation()
        }
    }

    const colorVariable = (chart, variable, defecto) =>
        getComputedStyle(chart.canvas).getPropertyValue(variable).trim() || defecto

    const dibujarBoton = (ctx, boton, activo, colores) => {
        if (activo) {
            ctx.globalAlpha = 0.15
            ctx.fillStyle = colores.activo
            ctx.fillRect(boton.x, boton.y, boton.ancho, boton.alto)
            ctx.globalAlpha = 1
        }
        ctx.fillStyle = activo ? colores.activo : colores.texto
        ctx.fillText(boton.texto, boton.x + boton.ancho / 2, boton.y + boton.alto / 2 + 0.5)
    }

    const textoCentrar = () => (typeof t === "function" ? t("comun.centrarGrafico") : "Centrar")

    // Botón «Centrar» arriba a la derecha del área de dibujo. Solo sale con el gráfico
    // movido o estirado: en automático ya está centrado y estorbaría sobre la línea.
    const dibujarBotonCentrar = (chart, estado, colores) => {
        if (!hayRangoManual(estado)) return
        const { ctx, chartArea } = chart
        ctx.save()
        ctx.font = "bold 11px sans-serif"
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"
        const texto = textoCentrar()
        const ancho = ctx.measureText(texto).width + 16
        const alto = ESCALA_PRECIO_ALTO_CENTRAR
        const boton = {
            accion: "centrar",
            texto,
            x: chartArea.right - ancho - ESCALA_PRECIO_MARGEN_CENTRAR,
            y: chartArea.top + ESCALA_PRECIO_MARGEN_CENTRAR,
            ancho,
            alto
        }
        if (boton.x < chartArea.left) {
            ctx.restore()
            return
        }
        ctx.fillStyle = colores.fondo || colorVariable(chart, "--bg-panel", "#0f172a")
        ctx.strokeStyle = colores.texto
        ctx.lineWidth = 1
        ctx.beginPath()
        // roundRect no existe en navegadores de antes de 2023.
        if (ctx.roundRect) ctx.roundRect(boton.x + 0.5, boton.y + 0.5, ancho, alto, 4)
        else ctx.rect(boton.x + 0.5, boton.y + 0.5, ancho, alto)
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = colores.texto
        ctx.fillText(texto, boton.x + ancho / 2 + 0.5, boton.y + alto / 2 + 1)
        ctx.restore()
        estado.botones.push(boton)
    }

    const coloresBotones = (chart) => ({
        texto: colorVariable(chart, "--text-muted", "#8a94a6"),
        activo: colorVariable(chart, "--accent", "#3b82f6"),
        fondo: colorVariable(chart, "--bg-panel", "")
    })

    const dibujarBotones = (chart, estado) => {
        estado.botones = []
        const colores = coloresBotones(chart)
        dibujarBotonCentrar(chart, estado, colores)
        dibujarBotonesEsquina(chart, estado, colores)
    }

    // Botones en la esquina entre el eje Y y el eje X, como «log» y «auto» en TradingView.
    const dibujarBotonesEsquina = (chart, estado, colores) => {
        const { ctx, chartArea } = chart
        const izquierda = ejeALaIzquierda(chart)
        const anchoEje = izquierda ? chartArea.left : chart.width - chartArea.right
        if (anchoEje < ESCALA_PRECIO_ANCHO_MINIMO || chart.height - chartArea.bottom < ESCALA_PRECIO_ALTO_BOTON + 2)
            return

        const lista = []
        if (hayRangoManual(estado)) lista.push({ accion: "auto", texto: "AUTO", activo: false })
        if (estado.log || estado.logPosible) lista.push({ accion: "log", texto: "LOG", activo: estado.log })
        if (!lista.length) return

        const enEsquina = []
        ctx.save()
        ctx.font = "bold 10px sans-serif"
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"
        const y = chartArea.bottom + 2
        let x = izquierda ? 2 : chart.width - 2
        // Se colocan desde el borde exterior hacia dentro.
        const orden = izquierda ? lista : [...lista].reverse()
        orden.forEach((item) => {
            const ancho = ctx.measureText(item.texto).width + 8
            enEsquina.push({ ...item, x: izquierda ? x : x - ancho, y, ancho, alto: ESCALA_PRECIO_ALTO_BOTON })
            x = izquierda ? x + ancho + 2 : x - ancho - 2
        })
        // Con el eje estrecho, la última fecha del eje X invade la esquina: el fondo la
        // tapa entera, también por debajo de los botones, para que no asome a medias.
        if (colores.fondo) {
            const inicio = Math.min(...enEsquina.map((boton) => boton.x)) - 2
            const fin = Math.max(...enEsquina.map((boton) => boton.x + boton.ancho)) + 2
            const abajo = Math.max(y + ESCALA_PRECIO_ALTO_BOTON, chart.scales.x?.bottom ?? 0)
            ctx.fillStyle = colores.fondo
            ctx.fillRect(inicio, chartArea.bottom + 1, fin - inicio, abajo - chartArea.bottom - 1)
        }
        enEsquina.forEach((boton) => dibujarBoton(ctx, boton, boton.activo, colores))
        ctx.restore()
        estado.botones.push(...enEsquina)
    }

    /**
     * Caja del botón «Centrar» en el último dibujo del gráfico.
     *
     * Sirve para que un gráfico ponga sus propios botones a su izquierda sin pisarlo.
     * Está al día en el afterDraw de los plugins del gráfico, que Chart.js ejecuta
     * después de los globales como este.
     *
     * Args:
     *     chart: Instancia de Chart.js.
     *
     * Returns:
     *     `{ x, y, ancho, alto }` en píxeles del lienzo, o null si el botón no sale.
     */
    window.escalaPrecioBotonCentrar = (chart) =>
        estados.get(chart)?.botones.find((boton) => boton.accion === "centrar") ?? null

    Chart.register({
        id: ESCALA_PRECIO_ID,
        // Antes de construir las escalas: aquí todavía se puede cambiar el tipo del eje
        // sin redibujar, así que la preferencia LOG guardada sale ya en el primer pintado.
        beforeInit(chart) {
            // Solo líneas: crear `scales.y` en un circular o un radar le añadiría un eje.
            if (chart.config.type !== "line") return
            const eje = configEje(chart, "y")
            const tipoOriginal = eje.type || "linear"
            const estado = {
                log: false,
                logPosible: false,
                // Solo los ejes que nacen lineales tienen botón LOG: los que ya son
                // logarítmicos (estacionales) traen su propio selector.
                admiteLog: tipoOriginal === "linear",
                originales: {},
                arrastre: null,
                ignorarClic: false,
                recortado: false,
                botones: [],
                cursor: null,
                cursorPrevio: "",
                listeners: []
            }
            estados.set(chart, estado)
            const clave = clavePreferencia(chart)
            const guardada = clave && typeof getChartPref === "function" ? getChartPref(clave, false) : false
            if (
                estado.admiteLog &&
                guardada &&
                !eje.stacked &&
                escalaPrecioDatosPositivos(chart.config.data?.datasets)
            ) {
                estado.log = true
                ponerTipo(chart, true)
            }
        },
        afterInit(chart) {
            const estado = estados.get(chart)
            if (!estado) return
            const canvas = chart.canvas
            // Chart.js deja `chart.canvas` a null antes de avisar de afterDestroy: sin
            // guardarlo, los listeners seguirían en el canvas y fallarían al mover el
            // ratón sobre el gráfico nuevo que se pinte en él.
            estado.canvas = canvas
            const escuchar = (tipo, manejador, opciones) => {
                const envoltorio = (evento) => manejador(chart, estado, evento)
                canvas.addEventListener(tipo, envoltorio, opciones)
                estado.listeners.push([tipo, envoltorio, opciones])
            }
            escuchar("pointerdown", alPulsar)
            escuchar("pointermove", alMover)
            escuchar("pointerup", alSoltar)
            escuchar("pointercancel", alSoltar)
            escuchar("dblclick", alDobleClic)
            escuchar("click", alClic, { capture: true })
            escuchar("pointerleave", (grafico, est) => {
                if (!est.arrastre) ponerCursor(grafico, est, null)
            })
        },
        afterUpdate(chart) {
            const estado = estados.get(chart)
            if (!estado || !escalaPrecioAplica(chart)) return
            const positivos = escalaPrecioDatosPositivos(chart.data.datasets)
            estado.logPosible = estado.admiteLog && !chart.scales.y.options.stacked && positivos
            // Llegan datos nuevos con ceros o negativos: la escala log dejaría la línea
            // sin pintar, así que se vuelve a lineal sin olvidar la preferencia.
            if (estado.log && !positivos) {
                estado.log = false
                quitarRangoManual(chart, estado, "y")
                ponerTipo(chart, false)
                chart.update()
            }
        },
        // Con un rango movido a mano hay datos fuera del área, y los datasets con
        // `clip: false` (las marcas de compra y venta) se pintarían encima de los ejes.
        beforeDatasetsDraw(chart) {
            const estado = estados.get(chart)
            if (!estado || !hayRangoManual(estado)) return
            const { ctx, chartArea } = chart
            ctx.save()
            ctx.beginPath()
            ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top)
            ctx.clip()
            estado.recortado = true
        },
        afterDatasetsDraw(chart) {
            const estado = estados.get(chart)
            if (!estado?.recortado) return
            chart.ctx.restore()
            estado.recortado = false
        },
        afterDraw(chart) {
            const estado = estados.get(chart)
            if (!estado) return
            if (!escalaPrecioAplica(chart)) {
                estado.botones = []
                return
            }
            dibujarBotones(chart, estado)
        },
        afterDestroy(chart) {
            const estado = estados.get(chart)
            if (!estado) return
            estado.listeners.forEach(([tipo, manejador, opciones]) =>
                estado.canvas?.removeEventListener(tipo, manejador, opciones)
            )
            estados.delete(chart)
        }
    })
}
