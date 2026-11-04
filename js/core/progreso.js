// Barra de progreso flotante, abajo a la derecha, para lecturas que tardan
// (wallets que se leen una a una, sincronizaciones…).
//
//   const progreso = iniciarProgreso("Actualizando «Ledger»", wallets.length)
//   for (const wallet of wallets) {
//       progreso.paso(wallet.alias)   // lo que se empieza a leer ahora
//       await leer(wallet)
//   }
//   progreso.terminar()
//
// Con total 0 o 1 la barra es indeterminada: no hay pasos que contar. Varias
// lecturas a la vez se apilan, cada una con su barra. Los avisos (showToast)
// suben para no quedar debajo.
;(function () {
    "use strict"

    let host = null

    function asegurarHost() {
        if (host && document.body.contains(host)) return host
        host = document.createElement("div")
        host.className = "progresoHost"
        host.setAttribute("aria-live", "polite")
        document.body.appendChild(host)
        // La altura del panel la usa el CSS para subir los avisos por encima.
        new ResizeObserver(function () {
            const alto = host.childElementCount ? host.offsetHeight + 8 : 0
            document.documentElement.style.setProperty("--progresoAlto", alto + "px")
        }).observe(host)
        return host
    }

    function formatoRestante(segundos) {
        if (segundos < 60) return "quedan ~" + Math.max(1, Math.round(segundos)) + " s"
        return "quedan ~" + Math.round(segundos / 60) + " min"
    }

    function iniciarProgreso(titulo, total) {
        const pasos = Math.max(0, Number(total) || 0)
        const indeterminado = pasos <= 1
        const inicio = Date.now()
        let hechos = -1
        let cerrado = false

        const caja = document.createElement("div")
        caja.className = "progresoItem" + (indeterminado ? " progresoItem-indeterminado" : "")
        caja.innerHTML =
            '<div class="progresoCabecera"><span class="progresoTitulo"></span><span class="progresoCuenta"></span></div>' +
            '<div class="progresoBarra" role="progressbar" aria-valuemin="0"><span class="progresoRelleno"></span></div>' +
            '<div class="progresoDetalle"></div>'
        // textContent, nunca innerHTML: el título y el detalle llevan nombres del usuario.
        caja.querySelector(".progresoTitulo").textContent = String(titulo || "Leyendo…")
        const barra = caja.querySelector(".progresoBarra")
        barra.setAttribute("aria-label", String(titulo || "Leyendo…"))
        if (!indeterminado) barra.setAttribute("aria-valuemax", String(pasos))
        asegurarHost().appendChild(caja)

        function pintar(detalle) {
            caja.querySelector(".progresoDetalle").textContent = detalle ? String(detalle) : ""
            if (indeterminado) return
            const completados = Math.max(0, hechos)
            caja.querySelector(".progresoRelleno").style.width = (completados / pasos) * 100 + "%"
            barra.setAttribute("aria-valuenow", String(completados))
            // El tiempo que falta sale del ritmo de lo ya leído; antes del primero no hay ritmo.
            const restante = completados ? ((Date.now() - inicio) / completados) * (pasos - completados) : null
            caja.querySelector(".progresoCuenta").textContent =
                Math.min(completados + 1, pasos) +
                " de " +
                pasos +
                (restante ? " · " + formatoRestante(restante / 1000) : "")
        }

        pintar("")
        return {
            /** Marca el paso anterior como hecho y anuncia el que empieza. */
            paso: function (detalle) {
                if (cerrado) return
                hechos += 1
                pintar(detalle)
            },
            /** Cambia el texto del paso en curso sin darlo por hecho (p. ej. un reintento). */
            detalle: function (detalle) {
                if (cerrado) return
                pintar(detalle)
            },
            /** Quita la barra. Se puede llamar más de una vez. */
            terminar: function () {
                if (cerrado) return
                cerrado = true
                caja.remove()
                if (host && !host.childElementCount) document.documentElement.style.setProperty("--progresoAlto", "0px")
            }
        }
    }

    window.iniciarProgreso = iniciarProgreso
})()
