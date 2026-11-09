// Cripto > Seguimiento: visores de UTXOs (Bitcoin) y de tokens (Ethereum y BNB).
//
// Trozo de js/cripto/wallets-seguimiento.js. Comparte con el resto de wallets-seguimiento-*.js el
// ámbito global y se carga detrás de wallets-seguimiento.js, en el orden de index.html.

// ── Visor de UTXOs (Bitcoin) ──────────────────────────────────────────────────
// Treemap de las salidas sin gastar de las wallets BTC del seguimiento: el área
// de cada bloque es su importe y el color, su antigüedad. Se lee bajo demanda
// porque con una xpub supone una llamada por dirección derivada.

async function cargarUtxosDetalle() {
    const estado = walletsSegDetalle
    const grupo = estado && walletsSegGrupo(estado.clave)
    if (!grupo || walletsSegVisorLeyendo(estado.utxos)) return
    const lectura = { lista: [], alturaActual: 0, errores: [] }
    estado.utxos = walletsSegVisorAlEmpezar(estado.utxos, lectura)
    walletsSegEmpezarLectura(estado)
    renderDetalleSeguimiento()
    const wallets = grupo.wallets.filter((w) => w.red === "btc")
    const progreso = iniciarProgreso("Leyendo UTXOs", wallets.length)
    try {
        await walletsSegLeerUtxos(estado, lectura, wallets, progreso)
    } finally {
        progreso.terminar()
    }
    if (!walletsSegTerminarLectura(estado)) return
    lectura.lista.sort((a, b) => b.satoshis - a.satoshis)
    estado.utxos = walletsSegVisorAlTerminar(estado.utxos, lectura)
    walletsSegGuardarLeido(estado)
    if (walletsSegDetalle === estado) renderDetalleSeguimiento()
}

async function walletsSegLeerUtxos(estado, lectura, wallets, progreso) {
    // Una a una, como el historial: Esplora pública limita las ráfagas.
    for (const wallet of wallets) {
        progreso.paso(walletsNombreCompleto(wallet))
        try {
            const datos = await walletsPeticionConReintentos(
                `/api/wallets/${encodeURIComponent(wallet.id)}/utxos`,
                walletsSegAvisoReintento(progreso, wallet)
            )
            if (!walletsSegLecturaVigente(estado)) return
            lectura.lista.push(...(datos.utxos || []).map((utxo) => ({ ...utxo, walletId: wallet.id })))
            lectura.alturaActual = Math.max(lectura.alturaActual, Number(datos.alturaActual) || 0)
        } catch (error) {
            if (!walletsSegLecturaVigente(estado)) return
            lectura.errores.push(`${wallet.alias}: ${error.message || "no se pudieron leer los UTXOs"}`)
            lectura.lista.push(...estado.utxos.lista.filter((utxo) => utxo.walletId === wallet.id))
            lectura.alturaActual = Math.max(lectura.alturaActual, Number(estado.utxos.alturaActual) || 0)
        }
    }
}

function walletsSegConfirmaciones(utxo, alturaActual) {
    return utxo.altura == null || !alturaActual ? 0 : Math.max(1, alturaActual - utxo.altura + 1)
}

function walletsSegEdadUtxo(utxo, alturaActual) {
    if (utxo.altura == null) return WALLETS_SEG_UTXO_EDADES[0]
    const confirmaciones = walletsSegConfirmaciones(utxo, alturaActual)
    return (
        WALLETS_SEG_UTXO_EDADES.find((edad) => edad.hasta && confirmaciones <= edad.hasta) ||
        WALLETS_SEG_UTXO_EDADES.at(-1)
    )
}

// Squarified treemap (Bruls, Huizing y van Wijk): llena el rectángulo por filas
// eligiendo cuántos bloques caben en cada una para que queden lo más cuadrados
// posible, que es lo que deja comparar tamaños a ojo. `pesos` va de mayor a menor.
function walletsSegTreemap(pesos, ancho, alto) {
    const total = pesos.reduce((suma, peso) => suma + peso, 0)
    if (!total || ancho <= 0 || alto <= 0) return []
    const escala = (ancho * alto) / total
    const rects = []
    const libre = { x: 0, y: 0, ancho, alto }
    let fila = []
    const peorProporcion = (areas, lado) => {
        const suma = areas.reduce((s, a) => s + a, 0)
        return Math.max(
            (lado * lado * Math.max(...areas)) / (suma * suma),
            (suma * suma) / (lado * lado * Math.min(...areas))
        )
    }
    const colocarFila = () => {
        const suma = fila.reduce((s, a) => s + a, 0)
        // La fila se apoya en el lado corto del hueco libre y avanza por el largo.
        const vertical = libre.ancho >= libre.alto
        const grosor = suma / (vertical ? libre.alto : libre.ancho)
        let avance = 0
        for (const area of fila) {
            const largo = area / grosor
            rects.push(
                vertical
                    ? { x: libre.x, y: libre.y + avance, ancho: grosor, alto: largo }
                    : { x: libre.x + avance, y: libre.y, ancho: largo, alto: grosor }
            )
            avance += largo
        }
        if (vertical) {
            libre.x += grosor
            libre.ancho -= grosor
        } else {
            libre.y += grosor
            libre.alto -= grosor
        }
        fila = []
    }
    for (const area of pesos.map((peso) => peso * escala)) {
        const lado = Math.min(libre.ancho, libre.alto)
        if (fila.length && peorProporcion([...fila, area], lado) > peorProporcion(fila, lado)) colocarFila()
        fila.push(area)
    }
    if (fila.length) colocarFila()
    return rects
}

// Los UTXOs que se dibujan uno a uno y el resto juntos en un bloque «Otros»: un
// polvo de miles de salidas serían miles de nodos invisibles por diminutos.
function walletsSegBloquesUtxo(lista) {
    const total = lista.reduce((suma, utxo) => suma + utxo.satoshis, 0)
    const visibles = lista
        .filter((utxo) => utxo.satoshis > 0 && utxo.satoshis >= total * WALLETS_SEG_UTXO_FRACCION_MINIMA)
        .slice(0, WALLETS_SEG_UTXO_MAX_BLOQUES)
    const restoSats = total - visibles.reduce((suma, utxo) => suma + utxo.satoshis, 0)
    const resto = lista.length - visibles.length
    const bloques = visibles.map((utxo, indice) => ({ utxo, indice, peso: utxo.satoshis }))
    if (resto) {
        // Con su área real podría no verse: se agranda hasta un mínimo y se dice.
        const peso = Math.max(restoSats, total * WALLETS_SEG_UTXO_FRACCION_OTROS)
        bloques.push({ otros: { cantidad: resto, satoshis: restoSats, ampliado: peso > restoSats }, peso })
        bloques.sort((a, b) => b.peso - a.peso)
    }
    return { visibles, bloques }
}

function walletsSegSatsABtc(satoshis) {
    return walletsSegNumero(satoshis / 1e8)
}

function walletsSegBloqueUtxoHtml(bloque, rect, ancho, alto, alturaActual) {
    const posicion = `left:${(rect.x / ancho) * 100}%;top:${(rect.y / alto) * 100}%;width:${(rect.ancho / ancho) * 100}%;height:${(rect.alto / alto) * 100}%`
    const conTexto = rect.ancho >= WALLETS_SEG_UTXO_ETIQUETA.ancho && rect.alto >= WALLETS_SEG_UTXO_ETIQUETA.alto
    const conBloque = conTexto && rect.alto >= WALLETS_SEG_UTXO_ETIQUETA.altoDoble
    if (bloque.otros) {
        const { cantidad, satoshis, ampliado } = bloque.otros
        const titulo = `${cantidad} UTXOs pequeños: ${walletsSegSatsABtc(satoshis)} BTC${ampliado ? " (área ampliada para que se vea)" : ""}`
        return `<div class="walletsSegUtxo walletsSegUtxoOtros" style="${posicion}" title="${escapeHtml(titulo)}">${
            conTexto ? `<strong>+${cantidad}</strong>${conBloque ? "<span>pequeños</span>" : ""}` : ""
        }</div>`
    }
    const { utxo, indice } = bloque
    const edad = walletsSegEdadUtxo(utxo, alturaActual)
    const bloqueTexto = utxo.altura == null ? "sin confirmar" : `bloque ${utxo.altura.toLocaleString("es-ES")}`
    const titulo = `${walletsSegCantidadExacta(utxo.cantidad)} BTC · ${bloqueTexto} · ${edad.texto}`
    return `<button type="button" class="walletsSegUtxo walletsSegUtxo-${edad.clave}" style="${posicion}" data-indice="${indice}" title="${escapeHtml(titulo)}" aria-label="${escapeHtml(titulo)}">${
        conTexto
            ? `<strong>${walletsSegNumero(utxo.cantidad)}</strong>${conBloque ? `<span>${escapeHtml(bloqueTexto)}</span>` : ""}`
            : ""
    }</button>`
}

function walletsSegResumenUtxosHtml(lista) {
    const total = lista.reduce((suma, utxo) => suma + utxo.satoshis, 0)
    const tarjetas = [
        ["UTXOs", lista.length.toLocaleString("es-ES")],
        ["Total", `${walletsSegSatsABtc(total)} BTC`],
        ["Mayor", lista.length ? `${walletsSegSatsABtc(lista[0].satoshis)} BTC` : "—"],
        ["Menor", lista.length ? `${lista.at(-1).satoshis.toLocaleString("es-ES")} sat` : "—"],
        [
            `Polvo (< ${WALLETS_SEG_UTXO_POLVO.toLocaleString("es-ES")} sat)`,
            String(lista.filter((u) => u.satoshis < WALLETS_SEG_UTXO_POLVO).length)
        ],
        ["Sin confirmar", String(lista.filter((u) => u.altura == null).length)]
    ]
    return `<div class="walletsSegStats">${tarjetas
        .map(
            ([clave, valor]) =>
                `<div class="walletsSegStat"><span>${escapeHtml(clave)}</span><strong>${escapeHtml(valor)}</strong></div>`
        )
        .join("")}</div>`
}

function walletsSegLeyendaUtxosHtml() {
    return `<ul class="walletsSegUtxoLeyenda">${WALLETS_SEG_UTXO_EDADES.map(
        (edad) =>
            `<li><span class="walletsSegUtxoMuestra walletsSegUtxo-${edad.clave}" aria-hidden="true"></span>${escapeHtml(edad.texto)}</li>`
    ).join("")}</ul>`
}

function walletsSegUtxosHtml(estado, grupo, anchoDisponible) {
    if (!grupo.wallets.some((wallet) => wallet.red === "btc")) return ""
    const utxos = estado.utxos
    const cabecera = `<h3 class="walletsSegSeccion">UTXOs</h3>`
    if (!utxos) {
        return `${cabecera}
            <p class="assetModalHint">Las salidas sin gastar de las wallets de Bitcoin de este seguimiento, cada una como un bloque de tamaño proporcional a su importe.</p>
            <button type="button" class="cancelButton walletsSegUtxosCargarBtn">Ver UTXOs</button>`
    }
    const errores = utxos.errores.map((error) => `<p class="ajustesAviso">${escapeHtml(error)}</p>`).join("")
    if (utxos.cargando) return `${cabecera}<p class="assetModalHint">Leyendo los UTXOs de la red…</p>`
    const recargar = walletsSegConsultadoHtml(
        utxos.fecha,
        utxos.actualizando
            ? "Leyendo…"
            : `<button type="button" class="cancelButton walletsSegUtxosCargarBtn">Volver a leer</button>`
    )
    if (!utxos.lista.length) {
        const vacio = utxos.errores.length ? "" : `<p class="overviewEmpty">No queda ninguna salida sin gastar.</p>`
        return `${cabecera}${errores}${vacio}${recargar}`
    }
    // Se maqueta con el ancho real para que las etiquetas quepan en su bloque;
    // oculto (ancho 0) se usa uno razonable y los porcentajes lo reescalan.
    const ancho = anchoDisponible > 0 ? anchoDisponible : WALLETS_SEG_UTXO_ANCHO_DEFECTO
    const alto = Math.round(
        Math.min(WALLETS_SEG_UTXO_ALTO.maximo, Math.max(WALLETS_SEG_UTXO_ALTO.minimo, ancho * 0.45))
    )
    const { visibles, bloques } = walletsSegBloquesUtxo(utxos.lista)
    estado.utxos.visibles = visibles
    const rects = walletsSegTreemap(
        bloques.map((bloque) => bloque.peso),
        ancho,
        alto
    )
    return `${cabecera}
        ${walletsSegCargadoHtml(utxos.fecha, utxos.actualizando, "Buscando cambios…")}
        ${errores}
        ${walletsSegResumenUtxosHtml(utxos.lista)}
        <div class="walletsSegUtxoMapa" style="aspect-ratio:${ancho} / ${alto}" role="group" aria-label="Mapa de UTXOs">
            ${bloques.map((bloque, i) => walletsSegBloqueUtxoHtml(bloque, rects[i], ancho, alto, utxos.alturaActual)).join("")}
        </div>
        <div class="walletsSegUtxoPie">${walletsSegLeyendaUtxosHtml()}${recargar}</div>`
}

function walletsSegUtxoDatosHtml(utxo, wallet, alturaActual) {
    const confirmaciones = walletsSegConfirmaciones(utxo, alturaActual)
    const filas = [
        [
            "Importe",
            `<strong>${walletsSegCantidadExacta(utxo.cantidad)} BTC</strong> <span class="walletsSegDato">${utxo.satoshis.toLocaleString("es-ES")} sat</span>`
        ],
        ["Wallet", escapeHtml(wallet?.alias || "—")],
        ["Dirección", `<code>${escapeHtml(utxo.direccion || "—")}</code>`],
        ["Transacción", walletsSegValorCopiableHtml(utxo.txid)],
        ["Salida", escapeHtml(String(utxo.vout))],
        [
            "Bloque",
            escapeHtml(utxo.altura == null ? "Sin confirmar (en la mempool)" : utxo.altura.toLocaleString("es-ES"))
        ],
        ["Fecha", escapeHtml(walletsSegFechaCompleta(utxo.fecha))],
        ["Confirmaciones", escapeHtml(confirmaciones ? confirmaciones.toLocaleString("es-ES") : "0")],
        ["Antigüedad", escapeHtml(walletsSegEdadUtxo(utxo, alturaActual).texto)]
    ]
    return filas.map(([clave, valor]) => `<div><dt>${escapeHtml(clave)}</dt><dd>${valor}</dd></div>`).join("")
}

// Misma ventana que la de un movimiento (mismo id): la cierran las mismas funciones.
function abrirUtxoSeguimiento(utxo) {
    if (!utxo || !walletsSegDetalle?.utxos) return
    cerrarMovimientoSeguimiento()
    const wallet = walletsEstado.wallets.find((w) => w.id === utxo.walletId)
    const red = wallet ? walletsSegRed(wallet) : null
    const enlace = red?.explorador ? red.explorador.replace("{hash}", encodeURIComponent(utxo.txid)) : ""
    const overlay = document.createElement("div")
    overlay.id = "walletsSegMovOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"
    overlay.innerHTML = `
        <div class="assetModal assetRowModal walletsSegMovModal" role="dialog" aria-modal="true" aria-labelledby="walletsSegUtxoTitulo">
            <h3 id="walletsSegUtxoTitulo" class="assetModalTitle assetRowModalTitle">UTXO de ${escapeHtml(walletsSegNumero(utxo.cantidad))} BTC</h3>
            <div class="assetRowModalFields">
                <dl class="walletsSegMovDatos">${walletsSegUtxoDatosHtml(utxo, wallet, walletsSegDetalle.utxos.alturaActual)}</dl>
            </div>
            <div class="assetRowModalFooter">
                ${enlace ? `<a class="secondaryButton walletsSegMovExplorador" href="${escapeHtml(enlace)}" target="_blank" rel="noopener noreferrer">Ver en el explorador ↗</a>` : ""}
                <button type="button" class="primaryButton walletsSegMovCerrarBtn">Cerrar</button>
            </div>
        </div>`
    document.body.appendChild(overlay)
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay || event.target.closest(".walletsSegMovCerrarBtn")) {
            cerrarMovimientoSeguimiento()
            return
        }
        const copiable = event.target.closest(".walletsSegCopiable")
        if (copiable && typeof copyHashTransaccionToClipboard === "function") copyHashTransaccionToClipboard(copiable)
    })
    document.addEventListener("keydown", walletsSegTeclaMovimiento)
    overlay.querySelector(".walletsSegMovCerrarBtn").focus()
}

// ── Visor de tokens (Ethereum y BNB) ──────────────────────────────────────────
// Saldo actual de cada token ERC-20/BEP-20 de las wallets del seguimiento, con
// su estado y el activo de Activos al que corresponde (cripto, stablecoin o
// ETF tokenizado). Bajo demanda: Etherscan gratuito pide una llamada por token.

const WALLETS_SEG_TIPOS_ACTIVO = { cripto: "Cripto", etfs: "ETF", stablecoin: "Stablecoin" }

function walletsSegRedConTokens(wallet) {
    return Boolean(walletsSegRed(wallet)?.visorTokens)
}

function walletsSegGrupoConTokens(grupo) {
    return Boolean(grupo?.wallets.some(walletsSegRedConTokens))
}

// Filas de la moneda propia de cada wallet. Salen del saldo guardado (el que
// leen la vigilancia y «Actualizar»), no de una lectura nueva: así no cuestan
// llamadas a la red y cuadran con la cabecera y la pestaña Direcciones.
function walletsSegContadorTokens(estado, grupo) {
    if (walletsSegGrupoConTokens(grupo) && (!estado.tokens || estado.tokens.cargando)) return null
    return grupo.wallets.length + (estado.tokens?.lista.length || 0)
}

function walletsSegActivoNativaHtml(wallet) {
    const activo = walletsActivosCripto().find((asset) => asset.id === wallet.assetId)
    if (!activo) return `<span class="walletsSegDato">—</span>`
    return `<span title="Cripto de Activos enlazada a la wallet">${escapeHtml(activo.name || activo.id)} <span class="mTypeBadge">Cripto</span></span>`
}

function walletsSegFilaNativaHtml(wallet, varias) {
    const red = walletsSegRed(wallet)
    const simbolo = red?.simbolo || wallet.red
    const euros = walletsSegEuros(wallet.valorEur)
    const saldo = wallet.saldoFecha
        ? `<td class="walletsSegMovCantidad" title="${escapeHtml(`${walletsSegCantidadExacta(wallet.saldo || "0")} · leído ${walletsSegFecha(wallet.saldoFecha)}`)}">${walletsSegNumero(wallet.saldo || "0")}</td>`
        : `<td class="walletsSegMovCantidad walletsSegDato" title="Pulsa «Actualizar» para leer su saldo">Sin leer</td>`
    return `
        <tr>
            <td><strong>${escapeHtml(simbolo)}</strong> <span class="walletsSegDato">${escapeHtml(red?.nombre || wallet.red)}</span></td>
            ${varias ? `<td>${escapeHtml(wallet.alias)}</td>` : ""}
            ${saldo}
            <td><span class="walletsSegToken walletsSegToken-nativa"><span class="walletsSegTokenEstado">Moneda de la red</span></span></td>
            <td>${walletsSegActivoNativaHtml(wallet)}</td>
            <td class="walletsSegMovCantidad">${euros ? `≈ ${escapeHtml(euros)}` : "—"}</td>
            <td>${escapeHtml(walletsSegFecha(wallet.ultimoMovimiento))}</td>
            <td></td>
        </tr>`
}

async function cargarTokensDetalle() {
    const estado = walletsSegDetalle
    const grupo = estado && walletsSegGrupo(estado.clave)
    if (!grupo || walletsSegVisorLeyendo(estado.tokens)) return
    const lectura = { lista: [], sinLeer: 0, errores: [] }
    estado.tokens = walletsSegVisorAlEmpezar(estado.tokens, lectura)
    walletsSegEmpezarLectura(estado)
    renderDetalleSeguimiento()
    const wallets = grupo.wallets.filter(walletsSegRedConTokens)
    const progreso = iniciarProgreso("Leyendo tokens", wallets.length)
    try {
        await walletsSegLeerTokens(estado, lectura, wallets, progreso)
    } finally {
        progreso.terminar()
    }
    if (!walletsSegTerminarLectura(estado)) return
    estado.tokens = walletsSegVisorAlTerminar(estado.tokens, lectura)
    walletsSegGuardarLeido(estado)
    if (walletsSegDetalle === estado) renderDetalleSeguimiento()
}

async function walletsSegLeerTokens(estado, lectura, wallets, progreso) {
    // Una a una, como el historial: Etherscan gratuito limita las ráfagas.
    for (const wallet of wallets) {
        progreso.paso(walletsNombreCompleto(wallet))
        try {
            const datos = await walletsPeticionConReintentos(
                `/api/wallets/${encodeURIComponent(wallet.id)}/tokens`,
                walletsSegAvisoReintento(progreso, wallet)
            )
            const leidos = (datos.tokens || []).map((token) => ({ ...token, walletId: wallet.id }))
            walletsSegAnotarPublicos(datos.tokensPublicos)
            walletsSegTokensLeidos.set(wallet.id, leidos)
            if (!walletsSegLecturaVigente(estado)) return
            lectura.lista.push(...leidos)
            lectura.sinLeer += Number(datos.sinLeer) || 0
        } catch (error) {
            if (!walletsSegLecturaVigente(estado)) return
            lectura.errores.push(`${wallet.alias}: ${error.message || "no se pudieron leer los tokens"}`)
            lectura.lista.push(...estado.tokens.lista.filter((token) => token.walletId === wallet.id))
        }
    }
}

// El estado se recalcula al pintar, no se toma el del servidor: así cambia en
// cuanto se verifica o se marca un contrato, sin volver a leer la red. Una
// imitación se llama como el activo, pero no es él: ni activo ni valor.
function walletsSegTokenVisible(token) {
    const red = walletsEstado.wallets.find((w) => w.id === token.walletId)?.red || ""
    const imitacion = walletsSegEstadoToken(token, red) === "imitacion"
    return { red, activo: imitacion ? null : token.activo, valorEur: imitacion ? "" : token.valorEur }
}

function walletsSegActivoTokenHtml(activo) {
    if (!activo) return `<span class="walletsSegDato">—</span>`
    const tipo = WALLETS_SEG_TIPOS_ACTIVO[activo.type] || activo.type
    const titulo =
        activo.type === "etfs"
            ? "ETF tokenizado asociado por su símbolo: el valor es aproximado, el emisor puede no seguir al ETF 1 a 1"
            : "Asociado por su símbolo"
    return `<span title="${escapeHtml(titulo)}">${escapeHtml(activo.name || activo.id)} <span class="mTypeBadge">${escapeHtml(tipo)}</span></span>`
}

// El ticker puesto a mano manda sobre el activo por símbolo, como en el servidor.
// Se toma de walletsEstado y no del token leído: así cambia en cuanto se guarda.
function walletsSegPrecioTokenHtml(token, red) {
    const precio = walletsSegEstadoToken(token, red) === "imitacion" ? null : walletsSegPrecioToken(token, red)
    if (!precio) return ""
    const proveedor = WALLETS_SEG_PROVEEDORES_PRECIO[precio.proveedor]?.nombre || precio.proveedor
    return `<span title="Ticker de precio puesto a mano">${escapeHtml(precio.ticker)} <span class="mTypeBadge">${escapeHtml(proveedor)}</span></span>`
}

function walletsSegFilaTokenHtml(token, wallet, varias) {
    const { red, activo, valorEur } = walletsSegTokenVisible(token)
    const euros = walletsSegEuros(valorEur)
    return `
        <tr>
            <td><strong>${escapeHtml(token.simbolo)}</strong>${token.nombre ? ` <span class="walletsSegDato">${escapeHtml(token.nombre)}</span>` : ""}</td>
            ${varias ? `<td>${escapeHtml(wallet?.alias || "")}</td>` : ""}
            <td class="walletsSegMovCantidad" title="${escapeHtml(walletsSegCantidadExacta(token.cantidad))}">${walletsSegNumero(token.cantidad)}</td>
            <td>${walletsSegTokenHtml(token, red, false)}</td>
            <td>${walletsSegPrecioTokenHtml(token, red) || walletsSegActivoTokenHtml(activo)}</td>
            <td class="walletsSegMovCantidad">${euros ? `≈ ${escapeHtml(euros)}` : "—"}</td>
            <td>${escapeHtml(walletsSegFecha(token.ultimoMovimiento))}</td>
            <td class="rowActionsCell">${walletsSegMenuTokenHtml(token, red, true)}</td>
        </tr>`
}

function walletsSegTokensVisorHtml(estado, grupo) {
    const conTokens = walletsSegGrupoConTokens(grupo)
    const tokens = estado.tokens
    const cabecera = `<h3 class="walletsSegSeccion">Tokens</h3>`
    if (conTokens && !tokens) {
        return `${cabecera}
            <p class="assetModalHint">La moneda propia de cada wallet y el saldo actual de cada token de las wallets de Ethereum y BNB de este seguimiento, con la cripto, stablecoin o ETF tokenizado de Activos que le corresponde por su símbolo.</p>
            <button type="button" class="cancelButton walletsSegTokensCargarBtn">Ver tokens</button>`
    }
    if (tokens?.cargando) return `${cabecera}<p class="assetModalHint">Leyendo los saldos de los tokens…</p>`
    const lista = tokens?.lista || []
    const errores = (tokens?.errores || []).map((error) => `<p class="ajustesAviso">${escapeHtml(error)}</p>`).join("")
    const recargar = conTokens
        ? walletsSegConsultadoHtml(
              tokens.fecha,
              tokens.actualizando
                  ? "Leyendo…"
                  : `<button type="button" class="cancelButton walletsSegTokensCargarBtn">Volver a leer</button>`
          )
        : ""
    const varias = grupo.wallets.length > 1
    const porId = new Map(grupo.wallets.map((wallet) => [wallet.id, wallet]))
    const visibles = lista.map((token) => ({ token, ...walletsSegTokenVisible(token) }))
    const total = [
        ...grupo.wallets.map((wallet) => wallet.valorEur),
        ...visibles.map(({ valorEur }) => valorEur)
    ].reduce((suma, valorEur) => suma + (parseLooseNumber(valorEur) || 0), 0)
    const tarjetas = [
        ["Monedas de red", String(grupo.wallets.length)],
        ["Tokens con saldo", String(visibles.length)],
        ["Asociados a Activos", String(visibles.filter(({ activo }) => activo).length)],
        ["ETFs tokenizados", String(visibles.filter(({ activo }) => activo?.type === "etfs").length)],
        [
            "Imitaciones",
            String(visibles.filter(({ token, red }) => walletsSegEstadoToken(token, red) === "imitacion").length)
        ],
        ["Valor con precio", walletsSegEuros(total) || "—"]
    ]
    const sinLeer = tokens?.sinLeer
        ? `<p class="assetModalHint">Quedan ${tokens.sinLeer} tokens sin leer: el tope es [wallets] max_tokens_visor en config.ini.</p>`
        : ""
    return `${cabecera}
        ${walletsSegCargadoHtml(tokens?.fecha, tokens?.actualizando, "Buscando cambios…")}
        ${errores}
        <div class="walletsSegStats">${tarjetas
            .map(
                ([clave, valor]) =>
                    `<div class="walletsSegStat"><span>${escapeHtml(clave)}</span><strong>${escapeHtml(valor)}</strong></div>`
            )
            .join("")}</div>
        <div class="operationsTableWrapper walletsSegTabla">
            <table class="operationsTable">
                <thead>
                    <tr><th>Token</th>${varias ? "<th>Wallet</th>" : ""}<th>Saldo</th><th>Estado</th><th>En Activos</th><th>Valor</th><th>Último movimiento</th><th></th></tr>
                </thead>
                <tbody>${grupo.wallets.map((wallet) => walletsSegFilaNativaHtml(wallet, varias)).join("")}${lista.map((token) => walletsSegFilaTokenHtml(token, porId.get(token.walletId), varias)).join("")}</tbody>
            </table>
        </div>
        ${sinLeer}
        <div class="walletsSegUtxoPie">${recargar}</div>`
}

// Atajos de un clic para los avisos de seguridad, sin abrir la ventana de avisos.
// Encendido = alguno de los sospechosos activo (o días de despierta puestos).
const WALLETS_SEG_ATAJOS = [
    ["sospechosos", "Sospechosos", "Envío a dirección nueva, vaciado, polvo y ráfaga de envíos"],
    ["despierta", "Despierta", `Si se mueve tras ${WALLETS_DESPIERTA_DIAS} días quieta`]
]

function walletsSegConfigAvisos(wallet) {
    return { ...WALLETS_AVISOS_DEFECTO, ...(wallet.avisosConfig || {}) }
}

function walletsSegAtajoActivo(atajo, config) {
    if (atajo === "despierta") return Boolean(Number(config.despiertaDias))
    return WALLETS_AVISOS_SOSPECHOSOS.some(([campo]) => config[campo])
}

function walletsSegAtajosAvisosHtml(wallet) {
    const config = walletsSegConfigAvisos(wallet)
    return `
        <div class="walletsSegAtajos" role="group" aria-label="Avisos de seguridad">
            ${WALLETS_SEG_ATAJOS.map(([atajo, nombre, ayuda]) => {
                const activo = Boolean(wallet.avisos) && walletsSegAtajoActivo(atajo, config)
                return `<button type="button" class="walletsSegFiltro walletsSegAtajoBtn${activo ? " activo" : ""}" data-wallet-id="${escapeHtml(wallet.id)}" data-atajo="${atajo}" aria-pressed="${activo}" title="${escapeHtml(ayuda)}">${escapeHtml(nombre)}</button>`
            }).join("")}
        </div>`
}

// Encender un atajo enciende también los avisos de la wallet: es la vía rápida.
function walletsSegCambiosAtajo(wallet, atajo) {
    const config = walletsSegConfigAvisos(wallet)
    const encender = !wallet.avisos || !walletsSegAtajoActivo(atajo, config)
    if (atajo === "despierta") config.despiertaDias = encender ? WALLETS_DESPIERTA_DIAS : 0
    else Object.assign(config, encender ? WALLETS_SOSPECHOSOS_TODOS : WALLETS_SOSPECHOSOS_NINGUNO)
    return { ...(encender ? { avisos: true } : {}), avisosConfig: config }
}

async function cambiarAtajoAvisos(boton) {
    const wallet = walletsEstado.wallets.find((w) => w.id === boton.dataset.walletId)
    if (!wallet) return
    boton.disabled = true
    try {
        const { wallet: guardada } = await walletsPost(
            `/api/wallets/${encodeURIComponent(wallet.id)}/ajustes`,
            walletsSegCambiosAtajo(wallet, boton.dataset.atajo)
        )
        Object.assign(wallet, guardada)
        const fila = boton.closest(".walletsSegAvisos")
        const interruptor = fila?.querySelector(".walletsSegAvisosCheck")
        if (interruptor) interruptor.checked = Boolean(wallet.avisos)
        walletsSegRepintarAtajos(fila, wallet)
        const activo = walletsSegAtajoActivo(boton.dataset.atajo, walletsSegConfigAvisos(wallet))
        showToast(`${boton.textContent}: ${activo ? "activado" : "desactivado"}`, { type: "success" })
    } catch (error) {
        showToast(error.message || "No se pudo guardar", { type: "error" })
    } finally {
        if (boton.isConnected) boton.disabled = false
    }
}

function walletsSegRepintarAtajos(fila, wallet) {
    const atajos = fila?.querySelector(".walletsSegAtajos")
    if (atajos) atajos.outerHTML = walletsSegAtajosAvisosHtml(wallet)
}
