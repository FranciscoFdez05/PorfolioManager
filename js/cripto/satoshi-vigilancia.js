// Bloque «Todas sus monedas» dentro de la ficha de Satoshi Nakamoto en
// Carteras conocidas (js/cripto/carteras-conocidas.js).
//
// No es un seguimiento de wallets: el servidor (core/satoshi_vigilancia.py)
// parte de una foto de las ~22.000 monedas que minó Satoshi y mira cada bloque
// nuevo por si alguna se gasta. Aquí solo se enseña el saldo real, hasta dónde
// se ha mirado y las monedas movidas, y se enciende o apaga.
let satoshiEstado = null

// La ficha se repinta cada vez que se abre o cierra otra cartera del catálogo:
// se pinta lo ya leído y solo se vuelve a pedir al servidor al abrir la ventana.
function mostrarSatoshiVigilancia() {
    if (!document.getElementById("satoshiVigilancia")) return
    if (satoshiEstado) pintarSatoshiVigilancia()
    else cargarSatoshiVigilancia()
}

async function cargarSatoshiVigilancia() {
    const contenedor = document.getElementById("satoshiVigilancia")
    if (!contenedor) return
    try {
        satoshiEstado = await walletsPeticion("/api/wallets/satoshi")
    } catch (error) {
        satoshiEstado = { falta: error.message || "No se pudo leer la vigilancia de Satoshi" }
    }
    pintarSatoshiVigilancia()
}

function satoshiInterruptorHtml(campo, texto, activo, ayuda) {
    return `
        <div class="ajustesSwitchRow" title="${escapeHtml(ayuda)}">
            <div class="ajustesSwitchLabel">${escapeHtml(texto)}</div>
            <label class="ajustesSwitch">
                <input type="checkbox" class="satoshiCheck" data-campo="${campo}"${activo ? " checked" : ""} aria-label="${escapeHtml(texto)}">
                <span class="ajustesSwitchTrack"></span>
            </label>
        </div>`
}

function satoshiGastadasHtml(gastadas) {
    if (!gastadas.length) return `<p class="walletsSegDato">Ninguna moneda movida desde la foto.</p>`
    const filas = gastadas
        .map(
            (g) => `
            <li>
                Minada en el bloque ${walletsSegNumero(g.alturaOrigen)} · ${walletsSegNumero(g.satoshis / 1e8)} BTC ·
                movida en el bloque ${walletsSegNumero(g.alturaGasto)}
                <a href="https://mempool.space/tx/${escapeHtml(g.txGasto)}" target="_blank" rel="noopener noreferrer">ver ↗</a>
            </li>`
        )
        .join("")
    return `<h5 class="satoshiSubtitulo">Monedas movidas</h5><ul class="satoshiGastadas">${filas}</ul>`
}

function pintarSatoshiVigilancia() {
    const contenedor = document.getElementById("satoshiVigilancia")
    if (!contenedor || !satoshiEstado) return
    const e = satoshiEstado
    if (e.falta) {
        contenedor.innerHTML = `
            <h4 class="satoshiTitulo">Todas sus monedas</h4>
            <p class="walletsSegDato">${escapeHtml(e.falta)}</p>`
        return
    }
    const euros = walletsSegEuros(e.valorEur)
    const vigilancia = e.activo
        ? `Vigilado hasta el bloque ${walletsSegNumero(e.alturaRevisada)} · última revisión ${walletsSegFecha(e.ultimaRevision)}`
        : "Vigilancia apagada: no se miran los bloques nuevos."
    contenedor.innerHTML = `
        <div class="satoshiCabecera">
            <h4 class="satoshiTitulo">Todas sus monedas</h4>
            <span class="walletsSegDato">${walletsSegNumero(e.monedas)} monedas sin mover de las ${walletsSegNumero(e.monedasFoto)} de la foto (bloque ${walletsSegNumero(e.alturaFoto)})</span>
        </div>
        <div class="walletsSegSaldo">
            <strong>${walletsSegNumero(e.satoshis / 1e8)} BTC</strong>
            ${euros ? `<span>≈ ${escapeHtml(euros)}</span>` : ""}
        </div>
        <p class="walletsSegDato">${escapeHtml(vigilancia)}</p>
        ${e.error ? `<p class="ajustesAviso">Última revisión fallida: ${escapeHtml(e.error)}</p>` : ""}
        <div class="satoshiControles">
            ${satoshiInterruptorHtml("activo", "Vigilar bloques nuevos", e.activo, "Baja cada bloque nuevo de Bitcoin (unos 144 al día, ~210 MB) y mira si gasta alguna moneda de Satoshi")}
            ${satoshiInterruptorHtml("avisos", "Avisos por Telegram", e.avisos, "Avisa si se mueve alguna moneda de Satoshi. Hace falta también la categoría «Movimientos en las wallets» en Ajustes › Avisos")}
            <button type="button" class="cancelButton satoshiRevisarBtn">Revisar ahora</button>
        </div>
        ${satoshiGastadasHtml(e.gastadas || [])}`
}

async function cambiarSatoshiAjuste(interruptor) {
    interruptor.disabled = true
    try {
        satoshiEstado = await walletsPost("/api/wallets/satoshi/ajustes", {
            [interruptor.dataset.campo]: interruptor.checked
        })
        pintarSatoshiVigilancia()
    } catch (error) {
        interruptor.checked = !interruptor.checked
        showToast(error.message || "No se pudo guardar", { type: "error" })
    } finally {
        if (interruptor.isConnected) interruptor.disabled = false
    }
}

async function revisarSatoshiAhora(boton) {
    boton.disabled = true
    const progreso = iniciarProgreso("Revisando bloques nuevos de Bitcoin")
    try {
        satoshiEstado = await walletsPost("/api/wallets/satoshi/revisar")
        pintarSatoshiVigilancia()
        const encontradas = satoshiEstado.encontradas || 0
        showToast(
            encontradas
                ? `${encontradas} moneda${encontradas === 1 ? "" : "s"} de Satoshi movida${encontradas === 1 ? "" : "s"}`
                : `Revisado hasta el bloque ${walletsSegNumero(satoshiEstado.alturaRevisada)}: sin movimientos`,
            { type: encontradas ? "warning" : "success" }
        )
    } catch (error) {
        showToast(error.message || "No se pudieron revisar los bloques", { type: "error" })
    } finally {
        progreso.terminar()
        if (boton.isConnected) boton.disabled = false
    }
}

// La sección se repinta entera: por delegación no hay que volver a engancharla.
document.addEventListener("change", (event) => {
    const interruptor = event.target.closest("#satoshiVigilancia .satoshiCheck")
    if (interruptor) cambiarSatoshiAjuste(interruptor)
})
document.addEventListener("click", (event) => {
    const boton = event.target.closest("#satoshiVigilancia .satoshiRevisarBtn")
    if (boton) revisarSatoshiAhora(boton)
})
