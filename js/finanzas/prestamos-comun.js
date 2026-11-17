// Utilidades compartidas por Hipotecas y Compras financiadas: formato de
// porcentajes, fechas y plazos, y las tarjetas de métricas. Es código de nivel
// superior que comparte ámbito global con el resto de scripts; por eso todo
// lleva el prefijo `prestamo`.

function prestamoFormatoPorcentaje(valor) {
    return (
        new Intl.NumberFormat(_nl(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
            Number(valor) || 0
        ) + " %"
    )
}

function prestamoFormatoFecha(iso) {
    const partes = String(iso || "").split("-")
    if (partes.length !== 3) return ""
    return `${partes[2]}/${partes[1]}/${partes[0]}`
}

// «8 años y 3 meses», «5 meses», «Liquidada». Se pinta en español porque es lo
// que se lee de un vistazo; los cálculos usan siempre meses enteros.
function prestamoFormatoPlazo(meses) {
    const total = Math.max(0, Math.round(Number(meses) || 0))
    if (total === 0) return "Liquidado"
    const anios = Math.floor(total / 12)
    const resto = total % 12
    const partesTexto = []
    if (anios) partesTexto.push(`${anios} ${anios === 1 ? "año" : "años"}`)
    if (resto) partesTexto.push(`${resto} ${resto === 1 ? "mes" : "meses"}`)
    return partesTexto.join(" y ")
}

// Tarjeta de métrica. `valor` y `nota` se escapan: nada de lo que llega aquí se
// inserta como HTML.
function prestamoTarjeta(etiqueta, valor, nota = "", clase = "") {
    const notaHtml = nota ? `<span class="hipotecasCardNota">${escapeHtml(nota)}</span>` : ""
    return `<div class="hipotecasCard"><span class="hipotecasCardLabel">${escapeHtml(etiqueta)}</span><span class="hipotecasCardValor ${clase}">${escapeHtml(valor)}</span>${notaHtml}</div>`
}

// Mensaje de error de una respuesta de la API, o el genérico si no trae cuerpo.
async function prestamoMensajeError(respuesta) {
    try {
        const cuerpo = await respuesta.json()
        return cuerpo.error || cuerpo.message || `Error ${respuesta.status}`
    } catch {
        return `Error ${respuesta.status}`
    }
}

// Suma los recibos por año natural: un gráfico con 360 barras mensuales no se
// lee, y el año es la unidad en la que se piensa una hipoteca.
function prestamoAgruparPorAnio(cuadro) {
    const porAnio = new Map()
    cuadro.forEach((recibo) => {
        const anio = recibo.fecha.slice(0, 4)
        const acumulado = porAnio.get(anio) || { interes: 0, capital: 0, pendiente: 0 }
        acumulado.interes += recibo.interes
        acumulado.capital += recibo.capital + recibo.extra
        acumulado.pendiente = recibo.pendiente
        porAnio.set(anio, acumulado)
    })
    return porAnio
}

function prestamoTemaGrafico() {
    return typeof hChartTheme === "function" ? hChartTheme() : { text: "#ccd6f6", muted: "#94a3b8", grid: "#1e2d45" }
}

// Sustituye el calendario nativo de los <input type="date"> de un modal por el de
// la aplicación (abrirCalendarioFecha), igual que los filtros de fecha de
// Seguimiento. Se llama después de ponerModalEnDosColumnas: el input se envuelve
// donde esté en ese momento, y el botón del calendario va dentro del campo.
function prestamoActivarCalendarios(modal) {
    modal.querySelectorAll('input[type="date"]').forEach((input) => {
        if (input.parentElement?.classList.contains("prestamoFechaWrap")) return
        const envoltorio = document.createElement("div")
        envoltorio.className = "prestamoFechaWrap"
        input.before(envoltorio)
        envoltorio.appendChild(input)

        const boton = document.createElement("button")
        boton.type = "button"
        boton.className = "prestamoFechaBtn"
        boton.setAttribute("aria-label", "Abrir calendario")
        boton.setAttribute("aria-haspopup", "dialog")
        boton.setAttribute("aria-expanded", "false")
        boton.title = "Abrir calendario"
        boton.innerHTML = '<span class="icono iconoCalendario" aria-hidden="true"></span>'
        boton.addEventListener("click", () => abrirCalendarioFecha(input, boton))
        envoltorio.appendChild(boton)

        // Sin fecha el navegador pinta «dd/mm/aaaa» en el color del texto: se apaga
        // para que no parezca un valor puesto.
        const marcarVacio = () => input.classList.toggle("vacio", !input.value)
        input.addEventListener("input", marcarVacio)
        input.addEventListener("change", marcarVacio)
        marcarVacio()
    })
}
