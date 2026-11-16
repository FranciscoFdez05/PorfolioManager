// Ajustes: exportar datos a CSV.
//
// Un selector de módulo y, para gastos e ingresos, el año. El botón es un
// enlace de descarga a /api/exportar/<módulo>.csv: el servidor genera el
// fichero y el navegador lo baja, sin pasar por JavaScript.

const EXPORTAR_CSV_POR_ANIO = new Set(["gastos", "ingresos"])
// Años anteriores al actual que ofrece el desplegable.
const EXPORTAR_CSV_ANIOS_ATRAS = 10

function exportarCsvUrl(modulo, anio) {
    const base = `/api/exportar/${encodeURIComponent(modulo)}.csv`
    return EXPORTAR_CSV_POR_ANIO.has(modulo) ? `${base}?anio=${encodeURIComponent(anio)}` : base
}

function _initAjustesExportarCsv() {
    const selectModulo = document.getElementById("ajustesExportarModulo")
    const inputAnio = document.getElementById("ajustesExportarAnio")
    const enlace = document.getElementById("ajustesExportarCsvBtn")
    if (!selectModulo || !inputAnio || !enlace) return

    // El desplegable propio envuelve al select, que va siempre oculto: hay que
    // ocultar la envoltura, no el select.
    const cajaAnio = inputAnio.closest(".csWrapper") || inputAnio

    const actualizar = () => {
        const porAnio = EXPORTAR_CSV_POR_ANIO.has(selectModulo.value)
        cajaAnio.classList.toggle("hidden", !porAnio)
        const anioValido = /^\d{4}$/.test(inputAnio.value.trim())
        // Sin año válido el enlace no apunta a ninguna parte: pulsarlo daría un 400.
        const deshabilitado = porAnio && !anioValido
        enlace.setAttribute("aria-disabled", String(deshabilitado))
        enlace.classList.toggle("disabled", deshabilitado)
        enlace.href = deshabilitado ? "#" : exportarCsvUrl(selectModulo.value, inputAnio.value.trim())
    }

    const anioActual = new Date().getFullYear()
    for (let anio = anioActual; anio >= anioActual - EXPORTAR_CSV_ANIOS_ATRAS; anio--) {
        inputAnio.add(new Option(String(anio), String(anio)))
    }
    inputAnio.value = String(anioActual)
    selectModulo.addEventListener("change", actualizar)
    inputAnio.addEventListener("change", actualizar)
    enlace.addEventListener("click", (evento) => {
        if (enlace.getAttribute("aria-disabled") === "true") evento.preventDefault()
    })
    actualizar()
}
