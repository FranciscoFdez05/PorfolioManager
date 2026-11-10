/**
 * Cálculos de la página Ahorro.
 *
 * Todo lo que se ve en la página (totales, comparativas, presupuesto por
 * categoría, acumulado, proyección y observaciones) se deriva aquí de los
 * datos de Ingresos y Gastos tal cual los devuelve la API. Nada de este
 * fichero toca el DOM: js/finanzas/ahorro.js pinta lo que esto calcula, y las
 * pruebas (tests-js/ahorro-calculos.test.js) lo ejercitan sin navegador.
 *
 * Depende de parseEuroNumber, formatEuro y _nl de js/core/shared-utils.js.
 *
 * Convenciones:
 *   - Un "resumen" es { ingresos, gastos, ahorro, inversion, tasa, categorias,
 *     meses, tieneDatos }. `tasa` es null cuando no hay ingresos: un 0 % sería
 *     un dato falso, no la ausencia de dato.
 *   - Las categorías que el usuario marca como inversión
 *     (`opciones.categoriasInversion`, de ahorroConfig) son dinero apartado,
 *     no gastado: salen de `gastos` y `categorias`, van a `inversion` y quedan
 *     dentro de `ahorro`. No hay ninguna categoría fija: son las suyas.
 *   - Los meses se identifican por su clave en español y minúsculas, que es
 *     como los guardan Gastos e Ingresos ("enero".."diciembre").
 */
const AhorroCalculos = (() => {
    "use strict"

    const MESES = [
        { clave: "enero", corto: "Ene" },
        { clave: "febrero", corto: "Feb" },
        { clave: "marzo", corto: "Mar" },
        { clave: "abril", corto: "Abr" },
        { clave: "mayo", corto: "May" },
        { clave: "junio", corto: "Jun" },
        { clave: "julio", corto: "Jul" },
        { clave: "agosto", corto: "Ago" },
        { clave: "septiembre", corto: "Sep" },
        { clave: "octubre", corto: "Oct" },
        { clave: "noviembre", corto: "Nov" },
        { clave: "diciembre", corto: "Dic" }
    ]

    const SIN_CATEGORIA = "Sin categoría"
    // Mismo nombre que usan Gastos y Métricas para agrupar las mensualidades.
    const MENSUALIDADES = "Mensualidades"
    const OPCIONES_DEFECTO = Object.freeze({ categoriasInversion: [] })
    // Por debajo de medio céntimo un importe es ruido de coma flotante.
    const UMBRAL_CENTIMO = 0.005
    // Un presupuesto usado a partir de este porcentaje se marca como "cerca".
    const UMBRAL_CERCA_PCT = 90
    // Variaciones por categoría que no merecen una observación: evita frases
    // del tipo "Ocio sube 3 €".
    const VARIACION_MINIMA_EUR = 20
    const VARIACION_MINIMA_PCT = 10
    // Cuánto por encima de la media de 12 meses tiene que estar el gasto para avisar.
    const DESVIO_GASTO_MEDIA_PCT = 15
    const MAX_OBSERVACIONES = 6

    function sumar(lista, valorDe) {
        return lista.reduce((total, elemento) => total + valorDe(elemento), 0)
    }

    function importe(valor) {
        return parseEuroNumber(valor || "")
    }

    /**
     * Posición (0-11) de un mes a partir de su clave.
     * @param {string} clave Mes en minúsculas ("enero").
     * @returns {number} Índice, o -1 si la clave no es un mes.
     */
    function indiceDeMes(clave) {
        return MESES.findIndex((m) => m.clave === clave)
    }

    /**
     * Nombre del mes con la primera letra en mayúscula ("Noviembre").
     * @param {string} clave
     * @returns {string}
     */
    function nombreDeMes(clave) {
        return clave ? clave.charAt(0).toUpperCase() + clave.slice(1) : ""
    }

    /**
     * Ingresos de un mes: movimientos sueltos más ingresos recurrentes.
     * @param {object|null} datosAnio Respuesta de GET /api/ingresos/<año>.
     * @param {string} mes Clave del mes.
     * @returns {number}
     */
    function ingresosDelMes(datosAnio, mes) {
        if (!datosAnio) return 0
        const filas = datosAnio.months?.[mes]?.rows || []
        const recurrentes = datosAnio.recurrentes || []
        return sumar(filas, (f) => importe(f.cantidad)) + sumar(recurrentes, (r) => importe(r.meses?.[mes]))
    }

    /**
     * Clave de comparación de una categoría: sin tildes, mayúsculas ni espacios
     * extremos. Es el criterio con el que Gastos evita duplicados.
     * @param {string} texto
     * @returns {string}
     */
    function normalizarCategoria(texto) {
        return String(texto || "")
            .trim()
            .toLowerCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
    }

    /**
     * Función que dice si una categoría está marcada como inversión.
     * @param {string[]} [categoriasInversion] Nombres marcados por el usuario.
     * @returns {(categoria: string) => boolean}
     */
    function detectorDeInversion(categoriasInversion = []) {
        const claves = new Set(categoriasInversion.map(normalizarCategoria).filter(Boolean))
        return (categoria) => claves.size > 0 && claves.has(normalizarCategoria(categoria))
    }

    function nombreDeCategoria(tipo) {
        const limpio = String(tipo || "").trim()
        if (!limpio) return SIN_CATEGORIA
        // Un gasto suelto etiquetado "mensualidades" va con las mensualidades,
        // como en la tabla anual de Gastos.
        return limpio.toLowerCase() === MENSUALIDADES.toLowerCase() ? MENSUALIDADES : limpio
    }

    function quitarCeros(mapa) {
        for (const [clave, valor] of Object.entries(mapa)) {
            if (Math.abs(valor) < UMBRAL_CENTIMO) delete mapa[clave]
        }
        return mapa
    }

    /**
     * Gasto de un mes separado en categorías de gasto e inversión.
     *
     * Las mensualidades van juntas en «Mensualidades», como en Gastos, salvo
     * las de una categoría marcada como inversión (una aportación periódica).
     *
     * @param {object|null} datosAnio Respuesta de GET /api/gastos/<año>.
     * @param {string} mes Clave del mes.
     * @param {(categoria: string) => boolean} esInversion Ver detectorDeInversion.
     * @returns {{categorias: Object<string, number>, inversion: number}}
     */
    function desglosarGastosDelMes(datosAnio, mes, esInversion) {
        const categorias = {}
        let inversion = 0
        if (!datosAnio) return { categorias, inversion }
        const anadir = (categoria, valor) => {
            if (esInversion(categoria)) inversion += valor
            else categorias[categoria] = (categorias[categoria] || 0) + valor
        }
        for (const fila of datosAnio.months?.[mes]?.rows || []) {
            anadir(nombreDeCategoria(fila.tipo), importe(fila.cantidad))
        }
        for (const mensualidad of datosAnio.mensualidades || []) {
            const valor = importe(mensualidad.meses?.[mes])
            if (!valor) continue
            if (esInversion(mensualidad.categoria)) inversion += valor
            else anadir(MENSUALIDADES, valor)
        }
        return { categorias: quitarCeros(categorias), inversion }
    }

    /**
     * Gasto de un mes por categoría, mensualidades incluidas, sin apartar nada como inversión.
     * @param {object|null} datosAnio Respuesta de GET /api/gastos/<año>.
     * @param {string} mes Clave del mes.
     * @returns {Object<string, number>} Categoría → importe; sin categorías a cero.
     */
    function gastosPorCategoriaDelMes(datosAnio, mes) {
        return desglosarGastosDelMes(datosAnio, mes, () => false).categorias
    }

    /**
     * Construye un resumen a partir de sus totales.
     * @param {number} ingresos
     * @param {Object<string, number>} categorias Gasto por categoría (sin la inversión apartada).
     * @param {number} meses Meses que abarca el resumen.
     * @param {number} [inversion=0] Dinero llevado a categorías de inversión, que cuenta como ahorro.
     * @returns {object} Resumen (ver la cabecera del fichero).
     */
    function construirResumen(ingresos, categorias, meses, inversion = 0) {
        const gastos = sumar(Object.values(categorias), (v) => v)
        const ahorro = ingresos - gastos
        return {
            ingresos,
            gastos,
            ahorro,
            inversion,
            tasa: ingresos > UMBRAL_CENTIMO ? (ahorro / ingresos) * 100 : null,
            categorias,
            meses,
            tieneDatos:
                Math.abs(ingresos) >= UMBRAL_CENTIMO ||
                Math.abs(gastos) >= UMBRAL_CENTIMO ||
                Math.abs(inversion) >= UMBRAL_CENTIMO
        }
    }

    /**
     * Resumen de un mes concreto.
     * @param {object|null} datosIngresos Ingresos de ese año.
     * @param {object|null} datosGastos Gastos de ese año.
     * @param {string} mes Clave del mes.
     * @param {{categoriasInversion: string[]}} [opciones]
     * @returns {object}
     */
    function resumenMes(datosIngresos, datosGastos, mes, opciones = OPCIONES_DEFECTO) {
        const { categorias, inversion } = desglosarGastosDelMes(
            datosGastos,
            mes,
            detectorDeInversion(opciones.categoriasInversion)
        )
        return construirResumen(ingresosDelMes(datosIngresos, mes), categorias, 1, inversion)
    }

    /**
     * Suma varios resúmenes en uno (un año, un trimestre…).
     * @param {object[]} resumenes
     * @returns {object} Resumen con `meses` igual al número de resúmenes sumados.
     */
    function sumarResumenes(resumenes) {
        const categorias = {}
        for (const resumen of resumenes) {
            for (const [categoria, valor] of Object.entries(resumen.categorias)) {
                categorias[categoria] = (categorias[categoria] || 0) + valor
            }
        }
        return construirResumen(
            sumar(resumenes, (r) => r.ingresos),
            categorias,
            resumenes.length,
            sumar(resumenes, (r) => r.inversion || 0)
        )
    }

    /**
     * Los doce resúmenes mensuales de un año.
     * @param {Object<string, object>} ingresosPorAnio Año → datos de ingresos.
     * @param {Object<string, object>} gastosPorAnio Año → datos de gastos.
     * @param {string} anio
     * @param {{categoriasInversion: string[]}} [opciones]
     * @returns {object[]} Doce resúmenes, de enero a diciembre.
     */
    function serieAnual(ingresosPorAnio, gastosPorAnio, anio, opciones = OPCIONES_DEFECTO) {
        return MESES.map((m) => resumenMes(ingresosPorAnio?.[anio], gastosPorAnio?.[anio], m.clave, opciones))
    }

    /**
     * Meses de `anio` que ya han empezado a fecha `hoy`.
     * @param {string} anio
     * @param {Date} hoy
     * @returns {number} 12 en años pasados, 0 en años futuros.
     */
    function mesesTranscurridos(anio, hoy) {
        const numero = Number(anio)
        if (numero < hoy.getFullYear()) return 12
        if (numero > hoy.getFullYear()) return 0
        return hoy.getMonth() + 1
    }

    /**
     * Mes anterior, cruzando de año en enero.
     * @param {string} anio
     * @param {string} mes
     * @returns {{anio: string, mes: string}}
     */
    function mesAnterior(anio, mes) {
        const indice = indiceDeMes(mes)
        if (indice <= 0) return { anio: String(Number(anio) - 1), mes: MESES[11].clave }
        return { anio: String(anio), mes: MESES[indice - 1].clave }
    }

    /**
     * Los `cuantos` meses que terminan en (anio, mes), ambos incluidos, en orden cronológico.
     * @returns {Array<object>} Resúmenes con `anio` y `mes` añadidos.
     */
    function ultimosMeses(ingresosPorAnio, gastosPorAnio, anio, mes, cuantos, opciones = OPCIONES_DEFECTO) {
        const resultado = []
        let cursor = { anio: String(anio), mes }
        for (let i = 0; i < cuantos; i++) {
            const resumen = resumenMes(
                ingresosPorAnio?.[cursor.anio],
                gastosPorAnio?.[cursor.anio],
                cursor.mes,
                opciones
            )
            resultado.unshift({ ...resumen, anio: cursor.anio, mes: cursor.mes })
            cursor = mesAnterior(cursor.anio, cursor.mes)
        }
        return resultado
    }

    /**
     * Diferencia entre dos valores, en absoluto y en porcentaje.
     * @param {number} actual
     * @param {number} previo
     * @returns {{diferencia: number, porcentaje: number|null}} porcentaje es null si el previo es cero.
     */
    function variacion(actual, previo) {
        const diferencia = actual - previo
        const porcentaje = Math.abs(previo) >= UMBRAL_CENTIMO ? (diferencia / Math.abs(previo)) * 100 : null
        return { diferencia, porcentaje }
    }

    /**
     * Presupuesto de una categoría para un periodo.
     *
     * Un importe fijo en euros es mensual: en un periodo de varios meses se
     * multiplica por ellos. Un porcentaje se aplica a los ingresos del periodo.
     * Si una categoría trae los dos (configuración guardada a mano), manda el
     * importe fijo, igual que en el servidor.
     *
     * @param {object} config ahorroConfig de los ajustes.
     * @param {string} categoria
     * @param {number} ingresos Ingresos del periodo.
     * @param {number} meses Meses del periodo.
     * @returns {{modo: "eur"|"pct", valor: number, importe: number}|null} null si no tiene presupuesto.
     */
    function presupuestoDe(config, categoria, ingresos, meses) {
        const eur = Number(config?.presupuestoEur?.[categoria]) || 0
        if (eur > 0) return { modo: "eur", valor: eur, importe: eur * meses }
        const pct = Number(config?.presupuesto?.[categoria]) || 0
        if (pct > 0) return { modo: "pct", valor: pct, importe: (Math.max(ingresos, 0) * pct) / 100 }
        return null
    }

    function categoriasConPresupuesto(config) {
        const conValor = (mapa) => Object.keys(mapa || {}).filter((c) => Number(mapa[c]) > 0)
        return [...conValor(config?.presupuesto), ...conValor(config?.presupuestoEur)]
    }

    function estadoDePresupuesto(presupuesto, gastado) {
        if (!presupuesto) return "sinPresupuesto"
        if (gastado > presupuesto.importe + UMBRAL_CENTIMO) return "excedido"
        if (presupuesto.importe > 0 && (gastado / presupuesto.importe) * 100 >= UMBRAL_CERCA_PCT) return "cerca"
        return "ok"
    }

    /**
     * Filas de la tabla de presupuesto: una por categoría con gasto o con presupuesto.
     * @param {object} resumen Resumen del periodo.
     * @param {object|null} resumenPrevio Resumen del periodo con el que se compara.
     * @param {object} config ahorroConfig.
     * @returns {object[]} Ordenadas por gasto, de mayor a menor.
     */
    function filasPresupuesto(resumen, resumenPrevio, config) {
        const nombres = new Set([...Object.keys(resumen.categorias), ...categoriasConPresupuesto(config)])
        const filas = [...nombres].map((categoria) => {
            const gastado = resumen.categorias[categoria] || 0
            const presupuesto = presupuestoDe(config, categoria, resumen.ingresos, resumen.meses)
            const previo = resumenPrevio?.tieneDatos ? resumenPrevio.categorias[categoria] || 0 : null
            return {
                categoria,
                gastado,
                peso: resumen.gastos > UMBRAL_CENTIMO ? (gastado / resumen.gastos) * 100 : 0,
                presupuesto,
                disponible: presupuesto ? presupuesto.importe - gastado : null,
                usado: presupuesto && presupuesto.importe > 0 ? (gastado / presupuesto.importe) * 100 : null,
                estado: estadoDePresupuesto(presupuesto, gastado),
                previo,
                variacion: previo === null ? null : variacion(gastado, previo)
            }
        })
        return filas.sort((a, b) => b.gastado - a.gastado || a.categoria.localeCompare(b.categoria, "es"))
    }

    /**
     * Estadísticas de un año sobre sus meses transcurridos con datos.
     * @param {object[]} serie Los doce resúmenes del año.
     * @param {number} transcurridos Meses del año que cuentan (ver mesesTranscurridos).
     * @param {number} objetivo Objetivo de ahorro en %.
     * @returns {object} total, mediaMensual, mejor, peor, mesesConDatos y mesesObjetivo.
     */
    function estadisticasAnio(serie, transcurridos, objetivo) {
        const considerados = serie
            .slice(0, transcurridos)
            .map((resumen, indice) => ({ ...resumen, mes: MESES[indice].clave }))
            .filter((r) => r.tieneDatos)
        const total = sumarResumenes(considerados)
        const porAhorro = [...considerados].sort((a, b) => b.ahorro - a.ahorro)
        return {
            total,
            mediaMensual: considerados.length ? total.ahorro / considerados.length : null,
            mejor: porAhorro[0] || null,
            peor: porAhorro.length > 1 ? porAhorro[porAhorro.length - 1] : null,
            mesesConDatos: considerados.length,
            mesesObjetivo: considerados.filter((r) => r.tasa !== null && r.tasa >= objetivo).length
        }
    }

    /**
     * Ahorro previsto a 31 de diciembre si los meses que faltan siguen la media.
     *
     * Solo tiene sentido en el año en curso: en uno cerrado el total ya es
     * definitivo y en uno futuro no hay media de la que partir.
     *
     * @param {object} estadisticas Resultado de estadisticasAnio.
     * @param {number} transcurridos Meses transcurridos del año.
     * @returns {number|null}
     */
    function proyeccionFinDeAnio(estadisticas, transcurridos) {
        if (transcurridos <= 0 || transcurridos >= 12 || estadisticas.mediaMensual === null) return null
        return estadisticas.total.ahorro + estadisticas.mediaMensual * (12 - transcurridos)
    }

    /**
     * Meses seguidos, contando hacia atrás desde el último, que cumplen el objetivo.
     * @param {object[]} resumenes En orden cronológico.
     * @param {number} objetivo Objetivo de ahorro en %.
     * @returns {number}
     */
    function rachaObjetivo(resumenes, objetivo) {
        let racha = 0
        for (let i = resumenes.length - 1; i >= 0; i--) {
            const tasa = resumenes[i].tasa
            if (tasa === null || tasa < objetivo) break
            racha++
        }
        return racha
    }

    /**
     * Porcentaje con el formato numérico de la aplicación.
     * @param {number} valor
     * @param {number} [decimales=1]
     * @returns {string} Por ejemplo "12,5 %".
     */
    function formatearPct(valor, decimales = 1) {
        const formato = new Intl.NumberFormat(_nl(), {
            minimumFractionDigits: decimales,
            maximumFractionDigits: decimales
        })
        return `${formato.format(valor)} %`
    }

    function observacionObjetivo(resumen, objetivo) {
        if (resumen.tasa === null) {
            return resumen.gastos > UMBRAL_CENTIMO
                ? { tono: "neg", texto: `Hay ${formatEuro(resumen.gastos)} de gastos y ningún ingreso registrado.` }
                : null
        }
        const diferencia = resumen.tasa - objetivo
        if (diferencia >= 0) {
            return {
                tono: "pos",
                texto: `Has ahorrado el ${formatearPct(resumen.tasa)} de tus ingresos, ${formatearPct(diferencia)} por encima del objetivo.`
            }
        }
        const falta = (resumen.ingresos * objetivo) / 100 - resumen.ahorro
        return {
            tono: "neg",
            texto: `Te faltan ${formatEuro(falta)} para llegar al objetivo del ${formatearPct(objetivo, 0)}.`
        }
    }

    function observacionExcesos(filas) {
        const excedidas = filas.filter((f) => f.estado === "excedido").sort((a, b) => a.disponible - b.disponible)
        if (!excedidas.length) return null
        const detalle = excedidas
            .slice(0, 2)
            .map((f) => `${f.categoria} (+${formatEuro(-f.disponible)})`)
            .join(" y ")
        const resto = excedidas.length > 2 ? ` y ${excedidas.length - 2} más` : ""
        const plural = excedidas.length === 1 ? "una categoría" : `${excedidas.length} categorías`
        return { tono: "neg", texto: `Has superado el presupuesto en ${plural}: ${detalle}${resto}.` }
    }

    function esVariacionRelevante(fila) {
        const v = fila.variacion
        return (
            v &&
            Math.abs(v.diferencia) >= VARIACION_MINIMA_EUR &&
            (v.porcentaje === null || Math.abs(v.porcentaje) >= VARIACION_MINIMA_PCT)
        )
    }

    function textoVariacion(fila, verbo, etiquetaPrevio) {
        const v = fila.variacion
        const pct = v.porcentaje === null ? "" : ` (${v.porcentaje > 0 ? "+" : ""}${formatearPct(v.porcentaje, 0)})`
        return `${fila.categoria} ${verbo} ${formatEuro(Math.abs(v.diferencia))}${pct} respecto a ${etiquetaPrevio}.`
    }

    function observacionesVariacion(filas, etiquetaPrevio) {
        const relevantes = filas.filter(esVariacionRelevante)
        if (!relevantes.length) return []
        const porDiferencia = [...relevantes].sort((a, b) => b.variacion.diferencia - a.variacion.diferencia)
        const subida = porDiferencia[0]
        const bajada = porDiferencia[porDiferencia.length - 1]
        const resultado = []
        if (subida.variacion.diferencia > 0) {
            resultado.push({ tono: "neg", texto: textoVariacion(subida, "sube", etiquetaPrevio) })
        }
        if (bajada.variacion.diferencia < 0) {
            resultado.push({ tono: "pos", texto: textoVariacion(bajada, "baja", etiquetaPrevio) })
        }
        return resultado
    }

    function observacionMediaGastos(resumen, mediaGastos) {
        if (!mediaGastos || mediaGastos <= UMBRAL_CENTIMO || !resumen.tieneDatos) return null
        const desvio = ((resumen.gastos - mediaGastos) / mediaGastos) * 100
        if (desvio >= DESVIO_GASTO_MEDIA_PCT) {
            return {
                tono: "neg",
                texto: `Tus gastos están un ${formatearPct(desvio, 0)} por encima de tu media de los últimos 12 meses (${formatEuro(mediaGastos)}).`
            }
        }
        if (desvio <= -DESVIO_GASTO_MEDIA_PCT) {
            return {
                tono: "pos",
                texto: `Tus gastos están un ${formatearPct(-desvio, 0)} por debajo de tu media de los últimos 12 meses (${formatEuro(mediaGastos)}).`
            }
        }
        return null
    }

    function observacionConcentracion(filas) {
        const mayor = filas.find((f) => f.categoria !== SIN_CATEGORIA && f.gastado > 0)
        if (!mayor || mayor.peso < 35) return null
        return { tono: "info", texto: `${mayor.categoria} concentra el ${formatearPct(mayor.peso, 0)} de tu gasto.` }
    }

    function observacionInversion(resumen) {
        if (resumen.inversion <= UMBRAL_CENTIMO) return null
        const parte =
            resumen.ahorro > UMBRAL_CENTIMO
                ? ` (el ${formatearPct(Math.min((resumen.inversion / resumen.ahorro) * 100, 100), 0)} de lo ahorrado)`
                : ""
        return { tono: "info", texto: `Has invertido ${formatEuro(resumen.inversion)}${parte}.` }
    }

    function observacionSinCategoria(filas) {
        const sinCategoria = filas.find((f) => f.categoria === SIN_CATEGORIA)
        if (!sinCategoria || sinCategoria.gastado <= UMBRAL_CENTIMO) return null
        return {
            tono: "info",
            texto: `${formatEuro(sinCategoria.gastado)} de gasto no tiene categoría; asígnale una en Gastos para poder presupuestarlo.`
        }
    }

    /**
     * Frases que resumen el periodo en lenguaje natural.
     *
     * @param {object} contexto
     * @param {object} contexto.resumen Resumen del periodo.
     * @param {object[]} contexto.filas Filas de filasPresupuesto.
     * @param {number} contexto.objetivo Objetivo de ahorro en %.
     * @param {string} contexto.etiquetaPrevio Con qué se compara ("octubre", "2025").
     * @param {number} [contexto.racha] Meses seguidos cumpliendo el objetivo (vista mensual).
     * @param {number|null} [contexto.mediaGastos] Gasto medio de los 12 meses anteriores (vista mensual).
     * @param {object} [contexto.estadisticas] estadisticasAnio (vista anual).
     * @returns {Array<{tono: "pos"|"neg"|"info", texto: string}>}
     */
    function generarObservaciones(contexto) {
        const { resumen, filas, objetivo, etiquetaPrevio, racha, mediaGastos, estadisticas } = contexto
        if (!resumen.tieneDatos) return []
        const lista = [observacionObjetivo(resumen, objetivo), observacionInversion(resumen)]
        if (racha >= 2) {
            lista.push({ tono: "pos", texto: `Llevas ${racha} meses seguidos cumpliendo tu objetivo de ahorro.` })
        }
        if (estadisticas && estadisticas.mesesConDatos > 1) {
            lista.push({
                tono: "info",
                texto: `Has cumplido el objetivo en ${estadisticas.mesesObjetivo} de ${estadisticas.mesesConDatos} meses.`
            })
        }
        lista.push(observacionExcesos(filas))
        lista.push(...observacionesVariacion(filas, etiquetaPrevio))
        lista.push(observacionMediaGastos(resumen, mediaGastos))
        lista.push(observacionConcentracion(filas))
        lista.push(observacionSinCategoria(filas))
        return lista.filter(Boolean).slice(0, MAX_OBSERVACIONES)
    }

    return {
        MESES,
        SIN_CATEGORIA,
        MENSUALIDADES,
        detectorDeInversion,
        normalizarCategoria,
        indiceDeMes,
        nombreDeMes,
        ingresosDelMes,
        gastosPorCategoriaDelMes,
        resumenMes,
        sumarResumenes,
        serieAnual,
        mesesTranscurridos,
        mesAnterior,
        ultimosMeses,
        variacion,
        presupuestoDe,
        filasPresupuesto,
        estadisticasAnio,
        proyeccionFinDeAnio,
        rachaObjetivo,
        formatearPct,
        generarObservaciones
    }
})()
