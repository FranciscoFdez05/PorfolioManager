/* Herramienta de ejemplo: regla del 4 %.
 *
 * El fichero se carga solo si existe y se llama igual que el .html. Todo lo que
 * tiene que hacer es registrarse: la aplicación llama a la función con el panel
 * ya montado, cada vez que se entra en la página Herramientas.
 *
 * Dentro se puede usar lo que la aplicación ya tiene cargado: formatEuro(),
 * parseEuroNumber(), getChartPref() / setChartPref(), Chart.js y fetch a /api/.
 */

registrarHerramienta("regla-del-4", (panel) => {
    // Buscar siempre dentro del panel y no con document.getElementById: así dos
    // herramientas que repitan un id no se pisan.
    const campo = (id) => parseFloat(panel.querySelector("#" + id).value) || 0
    const escribir = (id, texto) => {
        panel.querySelector("#" + id).textContent = texto
    }

    panel.querySelector("#r4CalcBtn").addEventListener("click", () => {
        const gastoAnual = campo("r4Gasto")
        const tasa = campo("r4Tasa") / 100
        const cartera = campo("r4Cartera")
        if (gastoAnual <= 0 || tasa <= 0) return

        const capital = gastoAnual / tasa
        const progreso = (cartera / capital) * 100

        escribir("r4Capital", formatEuro(capital))
        escribir("r4Renta", formatEuro((cartera * tasa) / 12) + " / mes")
        escribir("r4Progreso", progreso.toFixed(1) + " %")
        escribir("r4Falta", cartera >= capital ? "Objetivo cubierto" : formatEuro(capital - cartera))

        const nota = panel.querySelector("#r4Nota")
        nota.textContent =
            cartera >= capital
                ? `Con ${formatEuro(cartera)} y una retirada del ${(tasa * 100).toFixed(1)} % ya cubrirías ${formatEuro(gastoAnual)} al año.`
                : `Te faltan ${formatEuro(capital - cartera)}. La regla del 4 % sale de estudios sobre carteras estadounidenses a 30 años: es una referencia, no una garantía.`
        nota.className = "hRatioInterpretacion " + (cartera >= capital ? "hRatioInfoPos" : "hRatioInfoNeg")

        panel.querySelector("#r4Results").classList.remove("hidden")
    })
})
