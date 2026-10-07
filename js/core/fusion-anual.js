// Fusión a tres bandas de un año de Gastos o Ingresos.
//
// La pestaña carga un año entero y, al guardar, manda el año entero: el servidor
// sustituye todas sus filas por las recibidas. Si entretanto entró una fila por
// otro camino (el Atajo del iPhone, otra pestaña, otro dispositivo) o se renombró
// una categoría, ese guardado la borraba sin que nadie se enterase.
//
// Ahora el servidor lleva una revisión por año y rechaza con 409 el guardado
// hecho sobre una copia antigua. Entonces el navegador:
//
//   1. calcula qué ha cambiado la pestaña respecto a lo que cargó (la «base»):
//      filas que ha quitado y filas que ha añadido (editar una fila es quitar la
//      vieja y añadir la nueva);
//   2. aplica esos cambios sobre lo que hay ahora en el servidor;
//   3. repite el guardado con la revisión nueva.
//
// Así se conservan a la vez lo que entró por otro lado y lo que el usuario
// acaba de editar. Las filas no tienen identificador estable, así que se
// comparan por contenido y como multiconjunto: dos gastos iguales el mismo día
// son dos filas, no una.
;(function () {
    // Una fila se identifica por su contenido. El importe se normaliza a número
    // porque la tabla lo devuelve con el formato de pantalla y el servidor con el
    // que se guardó; sin esto, toda fila parecería editada.
    function claveFilaAnual(fila) {
        const importe = typeof parseEuroNumber === "function" ? parseEuroNumber(fila?.cantidad ?? "") : NaN
        return [
            fila?.fecha,
            fila?.nombre,
            fila?.tipo,
            Number.isFinite(importe) ? importe.toFixed(2) : fila?.cantidad,
            fila?.nota,
            fila?.cuenta
        ]
            .map((valor) => String(valor ?? "").trim())
            .join("\u0001")
    }

    // JSON con las claves ordenadas a todos los niveles, para comparar
    // mensualidades y recurrentes (que llevan un objeto `meses` dentro).
    function claveEstable(valor) {
        if (Array.isArray(valor)) return `[${valor.map(claveEstable).join(",")}]`
        if (valor && typeof valor === "object") {
            return `{${Object.keys(valor)
                .sort()
                .map((k) => `${JSON.stringify(k)}:${claveEstable(valor[k])}`)
                .join(",")}}`
        }
        return JSON.stringify(valor ?? null)
    }

    function contar(lista, clave) {
        const cuentas = new Map()
        ;(Array.isArray(lista) ? lista : []).forEach((elemento) => {
            const k = clave(elemento)
            cuentas.set(k, (cuentas.get(k) || 0) + 1)
        })
        return cuentas
    }

    /** servidor − (base − local) + (local − base), como multiconjuntos. */
    function fusionarListaTresVias(base, local, servidor, clave) {
        const enBase = contar(base, clave)
        const enLocal = contar(local, clave)

        const quitar = new Map()
        enBase.forEach((n, k) => {
            const quitadas = n - (enLocal.get(k) || 0)
            if (quitadas > 0) quitar.set(k, quitadas)
        })

        const resultado = []
        ;(Array.isArray(servidor) ? servidor : []).forEach((elemento) => {
            const k = clave(elemento)
            const pendientes = quitar.get(k) || 0
            if (pendientes > 0) {
                quitar.set(k, pendientes - 1)
                return
            }
            resultado.push(elemento)
        })

        const yaEnBase = new Map(enBase)
        ;(Array.isArray(local) ? local : []).forEach((elemento) => {
            const k = clave(elemento)
            const disponibles = yaEnBase.get(k) || 0
            if (disponibles > 0) {
                yaEnBase.set(k, disponibles - 1)
                return
            }
            resultado.push(elemento)
        })

        return resultado
    }

    /**
     * Año fusionado. `recurrentes` es "mensualidades" (gastos) o "recurrentes"
     * (ingresos); `tipos`, "gastosTipos" o "ingresosTipos". La revisión del
     * resultado es la del servidor, que es contra la que se va a guardar.
     */
    function fusionarAnioTresVias(base, local, servidor, recurrentes, tipos) {
        const resultado = { ...(servidor || {}) }
        const meses = new Set([...Object.keys(servidor?.months || {}), ...Object.keys(local?.months || {})])

        resultado.months = {}
        meses.forEach((mes) => {
            resultado.months[mes] = {
                ...(servidor?.months?.[mes] || {}),
                rows: fusionarListaTresVias(
                    base?.months?.[mes]?.rows,
                    local?.months?.[mes]?.rows,
                    servidor?.months?.[mes]?.rows,
                    claveFilaAnual
                )
            }
        })

        resultado[recurrentes] = fusionarListaTresVias(
            base?.[recurrentes],
            local?.[recurrentes],
            servidor?.[recurrentes],
            claveEstable
        )

        const etiquetas = [...(servidor?.[tipos] || []), ...(local?.[tipos] || [])]
        resultado[tipos] = etiquetas.filter(
            (etiqueta, i) =>
                etiquetas.findIndex((otra) => String(otra).toLowerCase() === String(etiqueta).toLowerCase()) === i
        )

        return resultado
    }

    function clonarDatosAnuales(datos) {
        return datos == null ? null : JSON.parse(JSON.stringify(datos))
    }

    window.fusionarListaTresVias = fusionarListaTresVias
    window.fusionarAnioTresVias = fusionarAnioTresVias
    window.clonarDatosAnuales = clonarDatosAnuales
})()
