// Cripto > Seguimiento: todas las wallets del seguimiento a la vez.
//
// Trozo de js/cripto/wallets-seguimiento.js. Comparte con el resto de wallets-seguimiento-*.js el
// ámbito global y se carga detrás de wallets-seguimiento.js, en el orden de index.html.

// ── Todas las wallets del seguimiento a la vez ────────────────────────────────

// Un atajo cuenta como encendido en el grupo solo si lo está en todas sus wallets.
function walletsSegAtajoEnTodas(grupo, atajo) {
    return grupo.wallets.every(
        (wallet) => wallet.avisos && walletsSegAtajoActivo(atajo, walletsSegConfigAvisos(wallet))
    )
}

// Primera fila de la lista: lo que se toca aquí se aplica a todas las wallets.
// El mínimo «Desde» no está: va en la moneda de cada red y no se puede compartir.
function walletsSegTodasDetalleHtml(grupo) {
    if (grupo.wallets.length < 2) return ""
    const clave = escapeHtml(grupo.clave)
    const conAvisos = grupo.wallets.filter((wallet) => wallet.avisos).length
    const todas = conAvisos === grupo.wallets.length
    const atajos = WALLETS_SEG_ATAJOS.map(([atajo, nombre, ayuda]) => {
        const activo = walletsSegAtajoEnTodas(grupo, atajo)
        return `<button type="button" class="walletsSegFiltro walletsSegAtajoTodasBtn${activo ? " activo" : ""}" data-seguimiento="${clave}" data-atajo="${atajo}" aria-pressed="${activo}" title="${escapeHtml(`${ayuda}, en todas las wallets`)}">${escapeHtml(nombre)}</button>`
    }).join("")
    return `
        <li class="walletsSegMiembro walletsSegMiembroFila walletsSegMiembroTodas">
            <div>
                <strong>Todas las wallets</strong>
                <span class="walletsSegDato">Lo que cambies en esta fila se aplica a las ${grupo.wallets.length} wallets de abajo</span>
            </div>
            <div class="walletsSegAvisos">
                <div class="ajustesSwitchRow">
                    <div class="ajustesSwitchLabel">Avisos por Telegram <span class="walletsSegDato">(${conAvisos} de ${grupo.wallets.length})</span></div>
                    <label class="ajustesSwitch">
                        <input type="checkbox" class="walletsSegAvisosTodasCheck" data-seguimiento="${clave}"${todas ? " checked" : ""} aria-label="Avisos por Telegram en todas las wallets">
                        <span class="ajustesSwitchTrack"></span>
                    </label>
                </div>
                <div class="walletsSegAtajos" role="group" aria-label="Avisos de seguridad en todas las wallets">${atajos}</div>
            </div>
            <div class="walletsSegTarjetaAcciones">
                <button type="button" class="cancelButton walletsSegActualizarGrupoBtn" data-seguimiento="${clave}">Actualizar todas</button>
            </div>
        </li>`
}

// Una sola petición para todo el seguimiento: «avisosConfigCambios» solo toca
// esas claves y deja el resto de la config de cada wallet como estaba.
async function walletsSegAvisosEnTodas(clave, cuerpo, control) {
    control.disabled = true
    try {
        const { wallets } = await walletsPost("/api/wallets/seguimientos/avisos", { clave, ...cuerpo })
        for (const guardada of wallets) {
            const wallet = walletsEstado.wallets.find((w) => w.id === guardada.id)
            if (wallet) Object.assign(wallet, guardada)
        }
        renderDetalleSeguimiento()
        return true
    } catch (error) {
        showToast(error.message || "No se pudo guardar", { type: "error" })
        if (control.isConnected) control.disabled = false
        return false
    }
}

async function cambiarAvisosTodas(interruptor) {
    const encender = interruptor.checked
    const hecho = await walletsSegAvisosEnTodas(interruptor.dataset.seguimiento, { avisos: encender }, interruptor)
    if (hecho) showToast(encender ? "Avisos activados en todas" : "Avisos desactivados en todas", { type: "success" })
    else if (interruptor.isConnected) interruptor.checked = !encender
}

// Como el atajo de una wallet: encenderlo enciende también los avisos; apagarlo no.
async function cambiarAtajoTodas(boton) {
    const grupo = walletsSegGrupo(boton.dataset.seguimiento)
    if (!grupo) return
    const atajo = boton.dataset.atajo
    const encender = !walletsSegAtajoEnTodas(grupo, atajo)
    const config =
        atajo === "despierta"
            ? { despiertaDias: encender ? WALLETS_DESPIERTA_DIAS : 0 }
            : encender
              ? WALLETS_SOSPECHOSOS_TODOS
              : WALLETS_SOSPECHOSOS_NINGUNO
    const nombre = boton.textContent
    const cuerpo = { ...(encender ? { avisos: true } : {}), avisosConfigCambios: config }
    if (await walletsSegAvisosEnTodas(grupo.clave, cuerpo, boton)) {
        showToast(`${nombre}: ${encender ? "activado" : "desactivado"} en todas`, { type: "success" })
    }
}

// Una wallet del seguimiento con sus avisos y sus acciones.
// Sin saldoFecha la wallet no se ha leído nunca (p. ej. falló la lectura al
// enlazarla): «—» se confundía con un saldo vacío.
function walletsSegSaldoMiembroHtml(wallet, red) {
    if (!wallet.saldoFecha) {
        return `<strong class="walletsSegDato" title="Pulsa «Actualizar» para leer su saldo">Sin leer</strong>`
    }
    return `<strong>${walletsSegNumero(wallet.saldo || "0")} ${escapeHtml(red?.simbolo || "")}</strong>`
}

function walletsSegMiembroDetalleHtml(wallet) {
    const red = walletsSegRed(wallet)
    const id = escapeHtml(wallet.id)
    const valorEur = walletsSegEuros(wallet.valorEur)
    const activo = walletsActivosCripto().find((asset) => asset.id === wallet.assetId)
    // Fila compacta dentro de la ficha: los datos secundarios van en el title
    // para no ocupar una línea por cada uno.
    const detalle = [
        `Cripto en Activos: ${activo?.name || "Ninguna"}`,
        `Enlazada el ${walletsSegFecha(wallet.creada)}`,
        `Saldo leído: ${walletsSegFecha(wallet.saldoFecha)}`,
        ...(wallet.propia === false ? [] : [`Última importación: ${walletsSegFecha(wallet.ultimaSincronizacion)}`])
    ].join("\n")
    return `
        <li class="walletsSegMiembro walletsSegMiembroFila">
            <div title="${escapeHtml(detalle)}">
                <strong>${escapeHtml(wallet.alias)}</strong>
                <span class="walletsSegDato">${escapeHtml(red?.nombre || wallet.red)} · ${walletsTipoLargo(wallet.tipo)} · <code>${escapeHtml(wallet.valorEnmascarado)}</code></span>
            </div>
            <div class="walletsSegMiembroSaldo">
                ${walletsSegSaldoMiembroHtml(wallet, red)}
                ${valorEur ? `<span>≈ ${escapeHtml(valorEur)}</span>` : ""}
                ${wallet.sinPrecio ? `<span class="walletsSegDato" title="${WALLETS_SEG_SIN_PRECIO}">Sin precio</span>` : ""}
            </div>
            ${walletsSegAlertasHtml([wallet])}
            <div class="walletsSegAvisos">
                <div class="ajustesSwitchRow">
                    <div class="ajustesSwitchLabel">Avisos por Telegram</div>
                    <label class="ajustesSwitch">
                        <input type="checkbox" class="walletsSegAvisosCheck" data-wallet-id="${id}"${wallet.avisos ? " checked" : ""}>
                        <span class="ajustesSwitchTrack"></span>
                    </label>
                </div>
                <label class="walletsSegUmbral">
                    Desde
                    <input type="text" inputmode="decimal" class="assetRowModalInput walletsSegUmbralInput" data-wallet-id="${id}" value="${escapeHtml(wallet.umbralAviso || "")}" placeholder="cualquier cantidad">
                    ${escapeHtml(red?.simbolo || "")}
                </label>
                ${walletsSegAtajosAvisosHtml(wallet)}
            </div>
            <div class="walletsSegTarjetaAcciones">
                <button type="button" class="cancelButton walletsSegActualizarUnaBtn" data-wallet-id="${id}">Actualizar</button>
                ${wallet.propia === false ? "" : `<button type="button" class="primaryButton walletsSincronizarBtn" data-wallet-id="${id}" title="Importa sus movimientos a Cripto › Transacciones">Sincronizar</button>`}
                <button type="button" class="dangerButton walletsDesenlazarBtn" data-wallet-id="${id}">Desenlazar</button>
            </div>
        </li>`
}

function walletsSegDerivadasHtml(grupo) {
    const derivadas = walletsSegDerivadasDe(grupo)
    if (!derivadas.length) return ""
    return `
        <section class="walletsSegDerivadas">
            <h3 class="walletsSegSeccion">Direcciones de sus claves públicas <span class="walletsSegContador">${derivadas.length.toLocaleString("es-ES")}</span></h3>
            <p class="walletsSegDato">Cuentan como tuyas: lo que se mueve entre ellas no es una entrada ni una salida de dinero. Salen enmascaradas; las completas están en el botón «Direcciones», con tu contraseña.</p>
            <ul class="walletsSegDerivadasLista">${derivadas
                .map(
                    (d) =>
                        `<li class="walletsSegDerivada"><span class="walletsSegDerivadaValor">${escapeHtml(d.valorEnmascarado)}</span></li>`
                )
                .join("")}</ul>
        </section>`
}

function walletsSegDireccionesHtml(grupo) {
    return `
        <h3 class="walletsSegSeccion">Direcciones</h3>
        <ul class="walletsSegMiembros walletsSegDirecciones">${walletsSegTodasDetalleHtml(grupo)}${grupo.wallets.map(walletsSegMiembroDetalleHtml).join("")}</ul>
        ${walletsSegDerivadasHtml(grupo)}`
}

function renderDetalleSeguimiento() {
    const contenedor = document.getElementById("walletsSegDetalle")
    const estado = walletsSegDetalle
    if (!contenedor || !estado) return
    const grupo = walletsSegGrupo(estado.clave)
    if (!grupo) return
    const ordenados = walletsSegOrdenados()
    const posicion = ordenados.findIndex((g) => g.clave === grupo.clave)
    const resumen = walletsSegResumenGrupo(grupo)
    const todos = walletsSegMovimientosDetalle(estado, grupo)
    const grupoVisible = walletsSegGrupoVisible(estado, grupo)
    const movimientos = grupoVisible === grupo ? todos : walletsSegMovimientosDetalle(estado, grupoVisible)
    const stats = walletsSegEstadisticas(movimientos, grupoVisible)
    const redes = [...new Set(grupo.wallets.map((wallet) => walletsSegRed(wallet)?.nombre || wallet.red))]
    const ficha = [
        ["Wallets", String(grupo.wallets.length)],
        ["Redes", redes.join(", ")],
        ["De quién es", grupo.propia ? "Mío" : "Ajeno (solo seguimiento)"],
        ["Saldo leído", walletsSegFecha(resumen.saldoFecha)],
        ["Último movimiento", walletsSegFecha(resumen.ultimoMovimiento)],
        ...(grupo.propia ? [["Última importación", walletsSegFecha(resumen.ultimaSincronizacion)]] : [])
    ]
    const tarjetasStats = [
        ["Movimientos leídos", String(movimientos.length)],
        ...[...stats.porSimbolo].flatMap(([simbolo, totales]) => [
            [`Recibido (${simbolo})`, walletsSegNumero(totales.recibido)],
            [`Enviado (${simbolo})`, walletsSegNumero(totales.enviado)],
            [`Comisiones (${simbolo})`, walletsSegNumero(totales.comisiones)]
        ]),
        ["Desde", walletsSegFecha(stats.desde)],
        ["Hasta", walletsSegFecha(stats.hasta)]
    ]
    const pestana = walletsSegPestanaActiva(estado, grupo)
    // El panel resta su relleno y borde: el mapa de UTXOs se maqueta con ese ancho.
    const panel =
        pestana === "tokens"
            ? walletsSegTokensVisorHtml(estado, grupo)
            : pestana === "utxos"
              ? walletsSegUtxosHtml(estado, grupo, contenedor.clientWidth - 34)
              : pestana === "direcciones"
                ? walletsSegDireccionesHtml(grupo)
                : walletsSegPanelMovimientosHtml(estado, grupo, movimientos, tarjetasStats, todos)

    contenedor.innerHTML = `
        <div class="walletsSegDetalleBarra">
            <button type="button" class="cancelButton walletsSegVolverBtn">← Todos los seguimientos</button>
            <div class="walletsSegNav">
                <button type="button" class="cancelButton walletsSegNavBtn" data-dir="-1"${posicion <= 0 ? " disabled" : ""}>‹ Anterior</button>
                <span>${posicion + 1} de ${ordenados.length}</span>
                <button type="button" class="cancelButton walletsSegNavBtn" data-dir="1"${posicion >= ordenados.length - 1 ? " disabled" : ""}>Siguiente ›</button>
            </div>
        </div>
        <article class="walletsSegTarjeta walletsSegFicha">
            <header class="walletsSegTarjetaCabecera">
                <div>
                    <h4>${escapeHtml(grupo.nombre)}</h4>
                    <span class="walletsSegDato">${escapeHtml(redes.join(" · "))}</span>
                </div>
                <span class="mTypeBadge">${grupo.propia ? "Mía" : "Ajena"}</span>
            </header>
            <div class="walletsSegSaldo">
                <strong>${escapeHtml(resumen.saldos || "—")}</strong>
                ${resumen.euros ? `<span>≈ ${escapeHtml(resumen.euros)}</span>` : ""}
            </div>
            <dl class="walletsSegFichaDatos">
                ${ficha.map(([clave, valor]) => `<div><dt>${escapeHtml(clave)}</dt><dd>${escapeHtml(valor)}</dd></div>`).join("")}
            </dl>
            <footer class="walletsSegTarjetaAcciones">${walletsSegAccionesGrupoHtml(grupo, false)}</footer>
        </article>
        ${walletsSegPestanasHtml(estado, grupo, pestana, todos)}
        <section class="walletsSegPanel" role="tabpanel">${panel}</section>`
}

function walletsSegMovimientosDetalle(estado, grupo) {
    return grupo.wallets
        .flatMap((wallet) => walletsSegHistorialDe(estado, wallet.id).movimientos)
        .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))
}

// Solo la tabla: si se repintara el detalle entero, el input de fecha perdería
// el foco a mitad de teclear (el navegador lanza «change» con cada parte válida).
function renderHistorialSeguimiento() {
    const contenedor = document.getElementById("walletsSegHistorial")
    const estado = walletsSegDetalle
    const grupo = estado && walletsSegGrupo(estado.clave)
    if (!contenedor || !grupo) return
    const grupoVisible = walletsSegGrupoVisible(estado, grupo)
    contenedor.innerHTML = walletsSegHistorialHtml(
        estado,
        grupoVisible,
        walletsSegMovimientosDetalle(estado, grupoVisible)
    )
}

function cambiarFechaSeguimiento(input) {
    if (!walletsSegDetalle) return
    walletsSegDetalle[input.dataset.campo] = input.value
    input.classList.toggle("vacio", !input.value)
    // Los límites del otro input y el botón de quitar se ajustan sin tocar el que se edita.
    const barra = input.closest(".walletsSegFechas")
    const otro = barra?.querySelector(`.walletsSegFechaInput:not([data-campo="${input.dataset.campo}"])`)
    // «Desde» acota el mínimo de «Hasta»; «Hasta» el máximo de «Desde», que sin él vuelve a ser hoy.
    if (otro && input.dataset.campo === "fechaDesde") otro.min = input.value
    if (otro && input.dataset.campo === "fechaHasta") otro.max = input.value || walletsSegHoy()
    const conFechas = Boolean(walletsSegDetalle.fechaDesde || walletsSegDetalle.fechaHasta)
    barra?.querySelector(".walletsSegRango")?.classList.toggle("activo", conFechas)
    barra?.querySelector(".walletsSegFechasQuitarBtn")?.classList.toggle("hidden", !conFechas)
    renderHistorialSeguimiento()
}

// Alt+↓ es el atajo del navegador para abrir el calendario nativo: abre el propio.
function manejarTeclaSeguimiento(event) {
    const input = event.target.closest(".walletsSegFechaInput")
    if (!input || !event.altKey || event.key !== "ArrowDown") return
    event.preventDefault()
    abrirCalendarioFecha(input, input.closest("label").querySelector(".walletsSegFechaBtn"))
}

async function manejarCambioSeguimiento(event) {
    const fecha = event.target.closest(".walletsSegFechaInput")
    if (fecha) {
        cambiarFechaSeguimiento(fecha)
        return
    }
    const avisosTodas = event.target.closest(".walletsSegAvisosTodasCheck")
    if (avisosTodas) {
        cambiarAvisosTodas(avisosTodas)
        return
    }
    const avisos = event.target.closest(".walletsSegAvisosCheck")
    const umbral = event.target.closest(".walletsSegUmbralInput")
    if (!avisos && !umbral) return
    const campo = avisos || umbral
    const cambios = avisos ? { avisos: avisos.checked } : { umbralAviso: umbral.value.trim() }
    try {
        const { wallet } = await walletsPost(
            `/api/wallets/${encodeURIComponent(campo.dataset.walletId)}/ajustes`,
            cambios
        )
        const indice = walletsEstado.wallets.findIndex((w) => w.id === wallet.id)
        if (indice >= 0) walletsEstado.wallets[indice] = { ...walletsEstado.wallets[indice], ...wallet }
        if (umbral) umbral.value = wallet.umbralAviso || ""
        if (avisos) walletsSegRepintarAtajos(avisos.closest(".walletsSegAvisos"), wallet)
        showToast(avisos ? (avisos.checked ? "Avisos activados" : "Avisos desactivados") : "Mínimo guardado", {
            type: "success"
        })
    } catch (error) {
        if (avisos) avisos.checked = !avisos.checked
        showToast(error.message || "No se pudo guardar", { type: "error" })
    }
}

// En el detalle de su seguimiento, el historial también se vuelve a leer desde el principio.
function walletsSegReabrirDetalleSi(walletIds) {
    const grupo = walletsSegDetalle && walletsSegGrupo(walletsSegDetalle.clave)
    if (!grupo || !grupo.wallets.some((wallet) => walletIds.includes(wallet.id))) return
    // Se acaba de pedir a la red lo último: lo guardado ya no vale.
    walletsSegLeidos.delete(grupo.clave)
    walletsSegEnCurso.delete(grupo.clave)
    abrirDetalleSeguimiento(grupo.clave)
}

async function actualizarWalletSeguimiento(walletId, boton = null) {
    if (boton) {
        boton.disabled = true
        boton.textContent = "Leyendo…"
    }
    const textoOriginal = boton?.textContent
    const wallet = walletsEstado.wallets.find((w) => w.id === walletId)
    const progreso = iniciarProgreso(`Leyendo «${wallet ? walletsNombreCompleto(wallet) : "wallet"}»`)
    try {
        await walletsPost(`/api/wallets/${encodeURIComponent(walletId)}/actualizar`)
        await cargarWalletsSeguimiento()
        walletsSegReabrirDetalleSi([walletId])
    } catch (error) {
        showToast(error.message || "No se pudo leer la wallet", { type: "error" })
        // El servidor ha guardado el motivo: la tarjeta lo enseña cuando el aviso se va.
        await cargarWalletsSeguimiento().catch(() => {})
        if (boton?.isConnected) {
            boton.disabled = false
            boton.textContent = textoOriginal
        }
    } finally {
        progreso.terminar()
    }
}

// Lee una a una las wallets dadas y devuelve los fallos, con el nombre de cada una.
// Una a una: en paralelo, las APIs públicas (Solana, Etherscan) limitan enseguida.
async function walletsSegActualizarLista(wallets, titulo = "Actualizando wallets") {
    const fallos = []
    const progreso = iniciarProgreso(titulo, wallets.length)
    try {
        for (const wallet of wallets) {
            progreso.paso(walletsNombreCompleto(wallet))
            try {
                await walletsPost(`/api/wallets/${encodeURIComponent(wallet.id)}/actualizar`)
            } catch (error) {
                fallos.push(`${walletsNombreCompleto(wallet)}: ${error.message}`)
            }
        }
    } finally {
        progreso.terminar()
    }
    return fallos
}

async function actualizarSeguimiento(clave, boton) {
    const grupo = walletsSegGrupo(clave)
    if (!grupo) return
    boton.disabled = true
    boton.textContent = "Leyendo…"
    try {
        const fallos = await walletsSegActualizarLista(grupo.wallets, `Actualizando «${grupo.nombre}»`)
        await cargarWalletsSeguimiento()
        walletsSegReabrirDetalleSi(grupo.wallets.map((wallet) => wallet.id))
        if (fallos.length) showToast(fallos.join(" · "), { type: "error", duration: 8000 })
    } catch (error) {
        showToast(error.message || "No se pudo actualizar el seguimiento", { type: "error" })
    } finally {
        if (boton.isConnected) {
            boton.disabled = false
            boton.textContent = "Actualizar"
        }
    }
}

async function actualizarTodasSeguimiento() {
    const boton = document.getElementById("walletsSegActualizarBtn")
    if (boton) boton.disabled = true
    try {
        const fallos = await walletsSegActualizarLista(walletsEstado.wallets, "Actualizando todas las wallets")
        await cargarWalletsSeguimiento()
        if (fallos.length) showToast(fallos.join(" · "), { type: "error", duration: 8000 })
        else showToast("Wallets actualizadas", { type: "success" })
    } catch (error) {
        showToast(error.message || "No se pudieron actualizar las wallets", { type: "error" })
    } finally {
        if (boton) boton.disabled = false
    }
}

// Importa a Transacciones todas las wallets de un seguimiento propio, una a una.
async function sincronizarSeguimiento(clave, boton) {
    const grupo = walletsSegGrupo(clave)
    if (!grupo?.propia) return
    boton.disabled = true
    boton.textContent = "Sincronizando…"
    const total = { anadidas: 0, yaImportadas: 0, pendientes: 0, sinActivo: {} }
    const truncadas = []
    const fallos = []
    const progreso = iniciarProgreso(`Sincronizando «${grupo.nombre}»`, grupo.wallets.length)
    try {
        for (const wallet of grupo.wallets) {
            progreso.paso(walletsNombreCompleto(wallet))
            try {
                const resultado = await walletsPost(`/api/wallets/${encodeURIComponent(wallet.id)}/sincronizar`)
                total.anadidas += resultado.anadidas || 0
                total.yaImportadas += resultado.yaImportadas || 0
                total.pendientes += resultado.pendientes || 0
                if (resultado.truncada) truncadas.push(walletsAvisoTruncada(resultado, walletsNombreCompleto(wallet)))
                for (const [simbolo, n] of Object.entries(resultado.sinActivo || {})) {
                    total.sinActivo[simbolo] = (total.sinActivo[simbolo] || 0) + n
                }
            } catch (error) {
                fallos.push(`${walletsNombreCompleto(wallet)}: ${error.message}`)
            }
        }
        progreso.terminar()
        await cargarWalletsSeguimiento()
        // Lo importado de las que sí funcionaron se cuenta aunque otra fallase.
        if (fallos.length < grupo.wallets.length) {
            showToast(walletsResumenSincronizacion(total), { type: "success", duration: 6000 })
        }
        if (truncadas.length) showToast(truncadas.join(" · "), { type: "warning", duration: 12000 })
        if (fallos.length) showToast(fallos.join(" · "), { type: "error", duration: 8000 })
    } catch (error) {
        showToast(error.message || "No se pudo sincronizar el seguimiento", { type: "error" })
    } finally {
        progreso.terminar()
        if (boton.isConnected) {
            boton.disabled = false
            boton.textContent = "Sincronizar"
        }
    }
}

// Desenlaza de golpe todas las wallets del seguimiento; al quedarse sin ellas,
// renderWalletsSeguimiento() vuelve sola a la lista si se estaba viendo su detalle.
function confirmarDejarSeguimiento(clave) {
    const grupo = walletsSegGrupo(clave)
    if (!grupo) return
    const numero = grupo.wallets.length
    const wallets = `${numero} wallet${numero === 1 ? "" : "s"}`
    openConfirmModal({
        title: grupo.propia ? "Desenlazar seguimiento" : "Dejar de seguir",
        message: grupo.propia
            ? `Se desenlazarán las ${wallets} de «${grupo.nombre}». Las transacciones ya importadas se quedan en la tabla.`
            : `Se dejarán de seguir las ${wallets} de «${grupo.nombre}». Podrás volver a seguirla desde Carteras conocidas o enlazándola otra vez.`,
        confirmLabel: grupo.propia ? "Desenlazar" : "Dejar de seguir",
        onConfirm: async () => {
            try {
                const resultado = await walletsPost("/api/wallets/seguimientos/eliminar", { clave })
                await cargarWalletsSeguimiento()
                showToast(`«${grupo.nombre}» quitado (${resultado.quitadas} wallets)`, { type: "success" })
                if (resultado.avisoReetiquetado) showToast(resultado.avisoReetiquetado, { type: "warning" })
            } catch (error) {
                showToast(error.message || "No se pudo quitar el seguimiento", { type: "error" })
            }
        }
    })
}

async function guardarIntervaloSeguimiento(event) {
    const minutos = Number(event.target.value)
    try {
        await walletsPost("/api/wallets/vigilancia", { minutos })
        walletsEstado.vigilanciaMinutos = minutos
        showToast(minutos ? "Intervalo de revisión guardado" : "Revisión automática desactivada", { type: "success" })
    } catch (error) {
        showToast(error.message || "No se pudo guardar el intervalo", { type: "error" })
        renderIntervaloSeguimiento()
    }
}
