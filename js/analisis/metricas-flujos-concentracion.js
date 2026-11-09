// Análisis > Métricas: concentración de las 10 mayores posiciones.
//
// Trozo de js/analisis/metricas-flujos.js. Comparte con el resto de metricas-flujos-*.js el
// ámbito global y se carga detrás de metricas-flujos.js, en el orden de index.html.

// ── concentración top 10 ──────────────────────────────────────────────────

function mRenderConcentracion(summaries) {
    const positive = summaries.filter((a) => a.netoActualEur > 0)
    const total = positive.reduce((s, a) => s + a.netoActualEur, 0)
    if (!positive.length || total <= 0) return

    const sorted = [...positive].sort((a, b) => b.netoActualEur - a.netoActualEur).slice(0, 10)
    const labels = sorted.map((a) => a.name)
    const values = sorted.map((a) => parseFloat(((a.netoActualEur / total) * 100).toFixed(2)))
    const colors = sorted.map((a, i) => a.color || M_PALETTE[i % M_PALETTE.length])

    mCreateChart("mChartConcentracion", {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: "% Cartera",
                    data: values,
                    backgroundColor: colors.map((c) => c + "bb"),
                    borderColor: colors,
                    borderWidth: 1,
                    borderRadius: 4
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            indexAxis: "y",
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (c) =>
                            ` ${c.raw.toFixed(1).replace(".", ",")}%  —  ${formatEuro(sorted[c.dataIndex].netoActualEur)}`
                    }
                }
            },
            scales: {
                x: {
                    ...mAxisX(),
                    ticks: { color: "#8899bb", callback: (v) => v.toFixed(0) + "%" }
                },
                y: mAxisY(11)
            }
        }
    })
}
