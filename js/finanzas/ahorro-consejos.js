/**
 * Consejos de presupuesto de la página Ahorro (la lamparita de la ventana
 * «Objetivo y presupuesto»).
 *
 * Son pautas genéricas, iguales para cualquier usuario: no miran los nombres
 * de sus categorías ni proponen valores para ellas. Cada uno decide a mano qué
 * porcentaje pone en las suyas. Lo único personal es la equivalencia en euros
 * sobre sus ingresos medios y el aviso si su objetivo de ahorro queda por
 * debajo de la regla 50/30/20.
 *
 * Nada de este fichero toca el DOM: js/finanzas/ahorro.js pinta el resultado y
 * tests-js/ahorro-consejos.test.js lo prueba sin navegador.
 *
 * Depende de AhorroCalculos (js/finanzas/ahorro-calculos.js).
 */
const AhorroConsejos = (() => {
    "use strict"

    // Regla 50/30/20, en % de los ingresos netos.
    const GRUPOS = Object.freeze([
        { tipo: "necesidad", titulo: "Necesidades", tope: 50 },
        { tipo: "deseo", titulo: "Deseos", tope: 30 }
    ])
    const AHORRO_RECOMENDADO = 20

    /** Pautas orientativas por tipo de gasto, en % de los ingresos netos mensuales. */
    const PAUTAS = Object.freeze([
        { nombre: "Vivienda", ejemplos: "alquiler o hipoteca, comunidad, IBI", tipo: "necesidad", min: 20, max: 30 },
        { nombre: "Suministros", ejemplos: "luz, agua, gas, internet, móvil", tipo: "necesidad", min: 3, max: 8 },
        {
            nombre: "Mensualidades y suscripciones",
            ejemplos: "cuotas, gimnasio, plataformas",
            tipo: "necesidad",
            min: 3,
            max: 8
        },
        { nombre: "Compras y alimentación", ejemplos: "supermercado, droguería", tipo: "necesidad", min: 8, max: 15 },
        {
            nombre: "Transporte",
            ejemplos: "combustible, coche, transporte público",
            tipo: "necesidad",
            min: 5,
            max: 15
        },
        { nombre: "Seguros", ejemplos: "hogar, coche, salud", tipo: "necesidad", min: 2, max: 5 },
        { nombre: "Salud", ejemplos: "farmacia, dentista, óptica", tipo: "necesidad", min: 1, max: 5 },
        { nombre: "Comer fuera", ejemplos: "restaurantes, comidas y cenas", tipo: "deseo", min: 3, max: 10 },
        { nombre: "Cafés y caprichos", ejemplos: "cafés, snacks, pequeños gastos", tipo: "deseo", min: 1, max: 5 },
        { nombre: "Ocio", ejemplos: "salidas, viajes, aficiones", tipo: "deseo", min: 3, max: 10 },
        { nombre: "Ropa", ejemplos: "ropa y calzado", tipo: "deseo", min: 2, max: 5 },
        { nombre: "Regalos", ejemplos: "cumpleaños, fiestas", tipo: "deseo", min: 1, max: 3 },
        { nombre: "Otros", ejemplos: "imprevistos y varios", tipo: "deseo", min: 1, max: 5 }
    ])

    function avisoObjetivo(objetivo) {
        const pct = (valor) => AhorroCalculos.formatearPct(valor, 0)
        if (!Number.isFinite(objetivo)) return null
        if (objetivo < AHORRO_RECOMENDADO) {
            return {
                tono: "neg",
                texto: `Tu objetivo de ahorro (${pct(objetivo)}) está por debajo del ${pct(AHORRO_RECOMENDADO)} que propone la regla 50/30/20.`
            }
        }
        return { tono: "pos", texto: `Tu objetivo de ahorro (${pct(objetivo)}) cumple la regla 50/30/20.` }
    }

    /**
     * Pautas agrupadas en necesidades y deseos, con su equivalencia en euros.
     *
     * @param {object} datos
     * @param {number} datos.ingresos Ingresos medios mensuales (0 si no hay datos).
     * @param {number} datos.objetivo Objetivo de ahorro en % (puede ser NaN si el campo está vacío).
     * @returns {{grupos: Array<{tipo: string, titulo: string, tope: number, topeEur: number|null,
     *     pautas: Array<object>}>, aviso: {tono: string, texto: string}|null}}
     *     Cada pauta trae nombre, ejemplos, min, max y minEur/maxEur (null sin ingresos).
     * @example
     *   consejos({ ingresos: 1000, objetivo: 30 }).grupos[0].pautas[0].maxEur // 300
     */
    function consejos({ ingresos, objetivo }) {
        const conIngresos = ingresos > 0
        const aEur = (pct) => (conIngresos ? (ingresos * pct) / 100 : null)
        return {
            grupos: GRUPOS.map((grupo) => ({
                ...grupo,
                topeEur: aEur(grupo.tope),
                pautas: PAUTAS.filter((p) => p.tipo === grupo.tipo).map((p) => ({
                    ...p,
                    minEur: aEur(p.min),
                    maxEur: aEur(p.max)
                }))
            })),
            aviso: avisoObjetivo(objetivo)
        }
    }

    return { PAUTAS, AHORRO_RECOMENDADO, consejos }
})()
