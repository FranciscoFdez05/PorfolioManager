// Cripto > Seguimiento: detalle de un seguimiento, gráfico y ventana de un movimiento.
//
// Trozo de js/cripto/wallets-seguimiento.js. Comparte con el resto de wallets-seguimiento-*.js el
// ámbito global y se carga detrás de wallets-seguimiento.js, en el orden de index.html.

// ── Detalle de un seguimiento ─────────────────────────────────────────────────

function abrirDetalleSeguimiento(clave) {
    const anterior = walletsSegDetalle
    const leido = walletsSegLeidos.get(clave)
    // Con una lectura suya aún en marcha se retoma ese estado: uno nuevo
    // empezaría otra lectura de lo mismo y la primera se perdería.
    walletsSegDetalle = walletsSegEnCurso.get(clave) || {
        clave,
        historiales: leido?.historiales || {},
        historialFecha: leido?.historialFecha || "",
        utxos: leido?.utxos,
        tokens: leido?.tokens,
        persistente: leido?.persistente || false,
        guardadoTraido: leido?.guardadoTraido || false,
        cargando: false,
        lecturas: 0
    }
    Object.assign(walletsSegDetalle, {
        filtro: anterior?.filtro || "todos",
        fechaDesde: anterior?.fechaDesde || "",
        fechaHasta: anterior?.fechaHasta || "",
        // Red elegida en Movimientos ("" = todas). No pasa de un seguimiento a
        // otro: cada uno tiene sus redes.
        red: "",
        pestana: anterior?.pestana || walletsSegPestanaGuardada()
    })
    renderWalletsSeguimiento()
    document.getElementById("walletsSegDetalle")?.scrollIntoView({ block: "start" })
    if (!walletsSegDetalle.guardadoTraido) walletsSegTraerGuardado(walletsSegDetalle)
    const fecha = walletsSegDetalle.historialFecha
    if (!fecha || walletsSegCaducada(walletsSegDetalle, fecha)) cargarHistorialDetalle("nuevos")
}

// Sin nada guardado en el servidor, volver a leer una página dejaría sin el resto
// de lo cargado: entonces lo que hay en memoria no caduca.
function walletsSegCaducada(estado, fecha) {
    return estado.persistente && Date.now() - new Date(fecha).getTime() >= WALLETS_SEG_FRESCO_MS
}

// Lo guardado en el servidor, sin tocar la red. Va sin reintentos: es una lectura
// local, y si falla solo se tarda más en ver los datos.
async function walletsSegPedirGuardado(clave) {
    const respuesta = await fetch(`/api/wallets/seguimientos/lecturas?clave=${encodeURIComponent(clave)}`)
    if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`)
    return respuesta.json()
}

async function walletsSegTraerGuardado(estado) {
    try {
        walletsSegAplicarGuardado(estado, await walletsSegPedirGuardado(estado.clave))
    } catch (error) {
        console.debug("[wallets] Sin lecturas guardadas:", error.message)
        return
    }
    if (walletsSegDetalle !== estado) return
    walletsSegGuardarLeido(estado)
    renderDetalleSeguimiento()
    walletsSegRefrescarPestana(estado)
}

function walletsSegAplicarGuardado(estado, datos) {
    estado.persistente = Boolean(datos.disponible)
    estado.guardadoTraido = true
    const wallets = walletsSegGrupo(estado.clave)?.wallets || []
    const lecturas = wallets.map((wallet) => [wallet.id, datos.lecturas?.[wallet.id]]).filter(([, lectura]) => lectura)
    walletsSegAplicarHistorialGuardado(estado, lecturas)
    if (!estado.utxos || estado.utxos.cargando)
        estado.utxos = walletsSegUtxosGuardados(estado.utxos, lecturas) || estado.utxos
    if (!estado.tokens || estado.tokens.cargando)
        estado.tokens = walletsSegTokensGuardados(estado.tokens, lecturas) || estado.tokens
}

// La más antigua: de las demás wallets se sabe algo más nuevo, pero la fecha que
// se enseña no puede prometer que todo esté tan al día.
function walletsSegFechaMasAntigua(fechas) {
    return fechas.filter(Boolean).sort()[0] || ""
}

function walletsSegAplicarHistorialGuardado(estado, lecturas) {
    const fechas = []
    for (const [walletId, lectura] of lecturas) {
        const guardado = lectura.movimientos
        if (!guardado) continue
        walletsSegAnotarPublicos(guardado.tokensPublicos)
        fechas.push(guardado.fecha)
        const historial = walletsSegHistorialDe(estado, walletId)
        // Ya ha contestado la red, y su respuesta incluye lo guardado.
        if (historial.limite) continue
        Object.assign(historial, {
            movimientos: guardado.movimientos.map((mov) => ({ ...mov, walletId })),
            limite: guardado.limite,
            maximo: guardado.maximo,
            agotado: guardado.agotado
        })
    }
    if (!estado.historialFecha) estado.historialFecha = walletsSegFechaMasAntigua(fechas)
}

function walletsSegUtxosGuardados(visor, lecturas) {
    const secciones = lecturas.filter(([, lectura]) => lectura.utxos)
    if (!secciones.length) return null
    return {
        lista: secciones
            .flatMap(([walletId, lectura]) => lectura.utxos.utxos.map((utxo) => ({ ...utxo, walletId })))
            .sort((a, b) => b.satoshis - a.satoshis),
        alturaActual: Math.max(...secciones.map(([, lectura]) => Number(lectura.utxos.alturaActual) || 0)),
        errores: [],
        fecha: walletsSegFechaMasAntigua(secciones.map(([, lectura]) => lectura.utxos.fecha)),
        cargando: false,
        actualizando: Boolean(visor?.cargando)
    }
}

function walletsSegTokensGuardados(visor, lecturas) {
    const secciones = lecturas.filter(([, lectura]) => lectura.tokens)
    if (!secciones.length) return null
    const lista = []
    for (const [walletId, lectura] of secciones) {
        const tokens = lectura.tokens.tokens.map((token) => ({ ...token, walletId }))
        walletsSegAnotarPublicos(lectura.tokens.tokensPublicos)
        walletsSegTokensLeidos.set(walletId, tokens)
        lista.push(...tokens)
    }
    return {
        lista,
        sinLeer: secciones.reduce((suma, [, lectura]) => suma + (Number(lectura.tokens.sinLeer) || 0), 0),
        errores: [],
        fecha: walletsSegFechaMasAntigua(secciones.map(([, lectura]) => lectura.tokens.fecha)),
        cargando: false,
        actualizando: Boolean(visor?.cargando)
    }
}

// La pestaña recordada puede ser Tokens o UTXOs: lo guardado ya se ve y toca ponerlo al día.
function walletsSegRefrescarPestana(estado) {
    const grupo = walletsSegGrupo(estado.clave)
    if (!grupo) return
    const pestana = walletsSegPestanaActiva(estado, grupo)
    if (pestana === "tokens" && walletsSegVisorCaducado(estado, estado.tokens)) cargarTokensDetalle()
    if (pestana === "utxos" && walletsSegVisorCaducado(estado, estado.utxos)) cargarUtxosDetalle()
}

function walletsSegVisorLeyendo(visor) {
    return Boolean(visor?.cargando || visor?.actualizando)
}

function walletsSegVisorCaducado(estado, visor) {
    return Boolean(visor?.fecha) && !walletsSegVisorLeyendo(visor) && walletsSegCaducada(estado, visor.fecha)
}

// Con algo que enseñar se sigue enseñando mientras llega lo nuevo: la lectura se
// acumula aparte y lo sustituye de golpe al terminar.
function walletsSegVisorAlEmpezar(visor, lectura) {
    return visor?.lista.length ? { ...visor, actualizando: true } : { ...lectura, cargando: true }
}

// Si alguna wallet ha fallado sigue con sus datos anteriores, y la fecha no puede
// decir que todo se acaba de leer.
function walletsSegVisorAlTerminar(visor, lectura) {
    const fecha = lectura.errores.length && visor?.fecha ? visor.fecha : new Date().toISOString()
    return { ...lectura, fecha, cargando: false, actualizando: false }
}

function walletsSegEmpezarLectura(estado) {
    estado.lecturas += 1
    walletsSegEnCurso.set(estado.clave, estado)
}

// False si el estado se descartó mientras se leía (se volvió a pedir a la red
// lo último): lo que traiga esta lectura ya no vale.
function walletsSegLecturaVigente(estado) {
    return walletsSegEnCurso.get(estado.clave) === estado
}

// Devuelve si lo leído se puede guardar.
function walletsSegTerminarLectura(estado) {
    estado.lecturas -= 1
    if (!walletsSegLecturaVigente(estado)) return false
    if (!estado.lecturas) walletsSegEnCurso.delete(estado.clave)
    return true
}

// Se llama solo al terminar una lectura: si se descarta a mitad, lo leído a
// medias no se guarda y la próxima vez se lee entero.
function walletsSegGuardarLeido(estado) {
    walletsSegLeidos.set(estado.clave, {
        historiales: estado.historiales,
        historialFecha: estado.historialFecha,
        persistente: estado.persistente,
        guardadoTraido: estado.guardadoTraido,
        utxos: estado.utxos?.cargando ? walletsSegLeidos.get(estado.clave)?.utxos : estado.utxos,
        tokens: estado.tokens?.cargando ? walletsSegLeidos.get(estado.clave)?.tokens : estado.tokens
    })
}

// Hora de la última lectura de la red, junto al botón que la repite.
function walletsSegConsultadoHtml(fecha, boton) {
    const texto = fecha ? `<span>Última consulta: ${escapeHtml(walletsSegFecha(fecha))}</span>` : ""
    return `<span class="walletsSegConsultado">${texto}${boton}</span>`
}

// Va encima de los datos, a la vista: la del pie queda debajo de toda la tabla.
function walletsSegCargadoHtml(fecha, leyendo, textoLeyendo) {
    if (!fecha) return ""
    return `<p class="assetModalHint">Cargado el ${escapeHtml(walletsSegFecha(fecha))}${leyendo ? ` · ${escapeHtml(textoLeyendo)}` : ""}</p>`
}

function walletsSegPestanaGuardada() {
    try {
        return localStorage.getItem(WALLETS_SEG_PESTANA_KEY) || "movimientos"
    } catch {
        return "movimientos"
    }
}

// La guardada puede no existir en este seguimiento (p. ej. UTXOs en uno sin Bitcoin).
function walletsSegPestanaActiva(estado, grupo) {
    const disponibles = WALLETS_SEG_PESTANAS.filter((pestana) => pestana.disponible(grupo))
    return disponibles.some((pestana) => pestana.clave === estado.pestana) ? estado.pestana : "movimientos"
}

// Tokens y UTXOs se leen al abrir su pestaña: elegirla ya es pedirlos.
function cambiarPestanaSeguimiento(clave) {
    const estado = walletsSegDetalle
    if (!estado || !WALLETS_SEG_PESTANAS.some((pestana) => pestana.clave === clave)) return
    estado.pestana = clave
    try {
        localStorage.setItem(WALLETS_SEG_PESTANA_KEY, clave)
    } catch {
        // Sin localStorage la pestaña cambia igual, solo que no se recuerda.
    }
    const leerTokens = !estado.tokens || walletsSegVisorCaducado(estado, estado.tokens)
    if (clave === "tokens" && leerTokens && walletsSegGrupoConTokens(walletsSegGrupo(estado.clave)))
        cargarTokensDetalle()
    else if (clave === "utxos" && (!estado.utxos || walletsSegVisorCaducado(estado, estado.utxos))) cargarUtxosDetalle()
    else renderDetalleSeguimiento()
}

function walletsSegDerivadasDe(grupo) {
    const ids = new Set(grupo.wallets.map((wallet) => wallet.id))
    return (walletsEstado.direccionesEnlazadas || []).filter((d) => d.derivada && ids.has(d.walletId))
}

function walletsSegPestanasHtml(estado, grupo, activa, movimientos) {
    const contadores = {
        movimientos: movimientos.length,
        direcciones: grupo.wallets.length + walletsSegDerivadasDe(grupo).length,
        tokens: walletsSegContadorTokens(estado, grupo),
        utxos: estado.utxos && !estado.utxos.cargando ? estado.utxos.lista.length : null
    }
    const botones = WALLETS_SEG_PESTANAS.filter((pestana) => pestana.disponible(grupo)).map((pestana) => {
        const elegida = pestana.clave === activa
        const contador = contadores[pestana.clave]
        return `<button type="button" role="tab" class="walletsSegPestana${elegida ? " activo" : ""}" data-pestana="${pestana.clave}" aria-selected="${elegida}">${escapeHtml(pestana.nombre)}${
            contador == null ? "" : `<span class="walletsSegContador">${contador.toLocaleString("es-ES")}</span>`
        }</button>`
    })
    return `<div class="walletsSegPestanas" role="tablist" aria-label="Secciones del seguimiento">${botones.join("")}</div>`
}

// Redes distintas del seguimiento, en el orden de sus wallets.
function walletsSegClavesRedes(grupo) {
    return [...new Set(grupo.wallets.map((wallet) => wallet.red))]
}

// El seguimiento reducido a las wallets de la red elegida en Movimientos; sin
// elegir, o si la elegida ya no está en él, el seguimiento entero.
function walletsSegGrupoVisible(estado, grupo) {
    if (!estado.red || !grupo.wallets.some((wallet) => wallet.red === estado.red)) return grupo
    return { ...grupo, wallets: grupo.wallets.filter((wallet) => wallet.red === estado.red) }
}

// Solo con varias redes: cada una tiene su moneda y sus cifras no se suman.
function walletsSegRedesSelectorHtml(estado, grupo, todos) {
    const redes = walletsSegClavesRedes(grupo)
    if (redes.length < 2) return ""
    const redDe = new Map(grupo.wallets.map((wallet) => [wallet.id, wallet.red]))
    const elegida = walletsSegGrupoVisible(estado, grupo) === grupo ? "" : estado.red
    const boton = (clave, texto, titulo, cuantos) =>
        `<button type="button" class="walletsSegFiltro walletsSegRedBtn${elegida === clave ? " activo" : ""}" data-red="${escapeHtml(clave)}" aria-pressed="${elegida === clave}" title="${escapeHtml(titulo)}">${escapeHtml(texto)} (${cuantos.toLocaleString("es-ES")})</button>`
    const botones = redes.map((clave) => {
        const red = walletsEstado.redes.find((r) => r.clave === clave)
        const cuantos = todos.filter((mov) => redDe.get(mov.walletId) === clave).length
        const texto = red ? `${red.nombre} · ${red.simbolo}` : clave
        return boton(clave, texto, `Ver solo los movimientos de ${red?.nombre || clave}`, cuantos)
    })
    return `<div class="walletsSegFiltros" role="group" aria-label="Moneda">${boton("", "Todas", "Ver los movimientos de todas las redes", todos.length)}${botones.join("")}</div>`
}

function cambiarRedSeguimiento(clave) {
    if (!walletsSegDetalle) return
    walletsSegDetalle.red = clave
    renderDetalleSeguimiento()
}

function walletsSegPanelMovimientosHtml(estado, grupo, movimientos, tarjetasStats, todos) {
    return `
        ${walletsSegRedesSelectorHtml(estado, grupo, todos)}
        <div class="walletsSegStats">
            ${tarjetasStats.map(([clave, valor]) => `<div class="walletsSegStat"><span>${escapeHtml(clave)}</span><strong>${escapeHtml(valor)}</strong></div>`).join("")}
        </div>
        <p class="assetModalHint">Las cifras son de los movimientos leídos y solo de la moneda nativa de cada red; los tokens se ven en su pestaña.</p>
        <h3 class="walletsSegSeccion">Historial</h3>
        ${movimientos.length ? walletsSegCargadoHtml(estado.historialFecha, estado.cargando, "Buscando movimientos nuevos…") : ""}
        ${movimientos.length ? walletsSegFechasHtml(estado) : ""}
        <div id="walletsSegHistorial">${walletsSegHistorialHtml(estado, walletsSegGrupoVisible(estado, grupo), movimientos)}</div>`
}

function cerrarDetalleSeguimiento() {
    walletsSegDetalle = null
    renderWalletsSeguimiento()
}

function navegarDetalleSeguimiento(direccion) {
    const ordenados = walletsSegOrdenados()
    const posicion = ordenados.findIndex((grupo) => grupo.clave === walletsSegDetalle?.clave)
    const destino = ordenados[posicion + direccion]
    if (destino) abrirDetalleSeguimiento(destino.clave)
}

function walletsSegHistorialDe(estado, walletId) {
    if (!estado.historiales[walletId]) {
        estado.historiales[walletId] = { movimientos: [], limite: 0, maximo: null, agotado: false, error: "" }
    }
    return estado.historiales[walletId]
}

// Lo que se pide a la red según lo que se quiera: lo más antiguo («mas», la página
// siguiente), lo más reciente («nuevos», una página que el servidor junta con lo
// guardado) o sustituir lo guardado («releer», sin perder cuántos había cargados).
function walletsSegUrlHistorial(walletId, historial, modo) {
    const limites = {
        mas: historial.limite + WALLETS_SEG_PAGINA,
        nuevos: WALLETS_SEG_PAGINA,
        releer: Math.max(historial.limite, WALLETS_SEG_PAGINA)
    }
    return `/api/wallets/${encodeURIComponent(walletId)}/movimientos?limite=${limites[modo]}${modo === "releer" ? "&reiniciar=1" : ""}`
}

// Por defecto, la página siguiente de cada wallet que aún tenga más.
async function cargarHistorialDetalle(modo = "mas") {
    const estado = walletsSegDetalle
    const grupo = estado && walletsSegGrupo(estado.clave)
    if (!grupo || estado.cargando) return
    // «Cargar más» con una red elegida solo pide las wallets de esa red.
    const visibles = walletsSegGrupoVisible(estado, grupo).wallets
    const pendientes =
        modo === "mas" ? visibles.filter((wallet) => !walletsSegHistorialDe(estado, wallet.id).agotado) : visibles
    if (!pendientes.length) return
    estado.cargando = true
    walletsSegEmpezarLectura(estado)
    renderDetalleSeguimiento()
    const progreso = iniciarProgreso("Leyendo movimientos", pendientes.length)
    try {
        await walletsSegLeerHistoriales(estado, pendientes, progreso, modo)
    } finally {
        progreso.terminar()
        estado.cargando = false
    }
    if (!walletsSegTerminarLectura(estado)) return
    // Con un fallo sigue lo anterior de esa wallet: su fecha no es la de ahora.
    const conFallo = pendientes.some((wallet) => walletsSegHistorialDe(estado, wallet.id).error)
    if (!conFallo || !estado.historialFecha) estado.historialFecha = new Date().toISOString()
    walletsSegGuardarLeido(estado)
    if (walletsSegDetalle === estado) renderDetalleSeguimiento()
}

// Sustituye lo guardado por lo que diga la red ahora: limpia lo que esta haya
// descartado. Lo anterior se sigue viendo hasta que llegue, y se queda si falla.
function releerHistorialDetalle() {
    cargarHistorialDetalle("releer")
}

function walletsSegAvisoReintento(progreso, wallet) {
    return (intento) =>
        progreso.detalle(
            `${walletsNombreCompleto(wallet)} · reintentando (${intento} de ${WALLETS_REINTENTOS_MS.length})`
        )
}

async function walletsSegLeerHistoriales(estado, pendientes, progreso, modo) {
    // Una a una: en paralelo, las APIs públicas (Solana, Etherscan) limitan enseguida.
    for (const wallet of pendientes) {
        progreso.paso(walletsNombreCompleto(wallet))
        const historial = walletsSegHistorialDe(estado, wallet.id)
        const anteriores = historial.movimientos.length
        historial.error = ""
        try {
            const datos = await walletsPeticionConReintentos(
                walletsSegUrlHistorial(wallet.id, historial, modo),
                walletsSegAvisoReintento(progreso, wallet)
            )
            // Se descartó el estado mientras se leía (se pidió a la red lo último): la respuesta ya no vale.
            walletsSegAnotarPublicos(datos.tokensPublicos)
            if (!walletsSegLecturaVigente(estado)) return
            historial.movimientos = (datos.movimientos || []).map((mov) => ({ ...mov, walletId: wallet.id }))
            historial.limite = datos.limite
            historial.maximo = datos.maximo
            estado.persistente = Boolean(datos.guardado)
            // Algunas redes descartan transacciones que no mueven la moneda, así que
            // devolver menos de lo pedido no prueba que no haya más: lo prueba que
            // pedir más no traiga nada nuevo. Lo sabe el servidor por lo guardado;
            // sin nada guardado, solo se ve aquí.
            const sinMas = modo === "mas" && historial.movimientos.length <= anteriores
            historial.agotado = sinMas || (datos.agotado ?? datos.limite >= datos.maximo)
        } catch (error) {
            if (!walletsSegLecturaVigente(estado)) return
            historial.error = `${wallet.alias}: ${error.message || "no se pudo leer el historial"}`
        }
    }
}

function walletsSegEstadisticas(movimientos, grupo) {
    const simboloDe = new Map(grupo.wallets.map((wallet) => [wallet.id, walletsSegRed(wallet)?.simbolo || ""]))
    const nativos = movimientos.filter((mov) => !mov.contrato && mov.simbolo === simboloDe.get(mov.walletId))
    const porSimbolo = new Map()
    for (const mov of nativos) {
        if (!porSimbolo.has(mov.simbolo)) porSimbolo.set(mov.simbolo, { recibido: 0, enviado: 0, comisiones: 0 })
        const totales = porSimbolo.get(mov.simbolo)
        const cantidad = parseLooseNumber(mov.cantidad) || 0
        if (mov.tipo === "recibida") totales.recibido += cantidad
        if (mov.tipo === "enviada") totales.enviado += cantidad
        totales.comisiones += parseLooseNumber(mov.comision) || 0
    }
    const fechas = movimientos
        .map((mov) => mov.fecha)
        .filter(Boolean)
        .sort()
    return { porSimbolo, desde: fechas[0] || "", hasta: fechas[fechas.length - 1] || "" }
}

// Día local (AAAA-MM-DD) de una fecha ISO: el input de fecha trabaja en hora
// local y la red devuelve UTC, así que comparar el texto ISO desplazaría los
// movimientos de madrugada al día anterior.
function walletsSegDiaLocal(iso) {
    const fecha = new Date(iso)
    if (!iso || Number.isNaN(fecha.getTime())) return ""
    const mes = String(fecha.getMonth() + 1).padStart(2, "0")
    const dia = String(fecha.getDate()).padStart(2, "0")
    return `${fecha.getFullYear()}-${mes}-${dia}`
}

function walletsSegHoy() {
    return walletsSegDiaLocal(new Date().toISOString())
}

function walletsSegEnRango(movimientos, desde, hasta) {
    if (!desde && !hasta) return movimientos
    return movimientos.filter((mov) => {
        const dia = walletsSegDiaLocal(mov.fecha)
        if (!dia) return false
        return (!desde || dia >= desde) && (!hasta || dia <= hasta)
    })
}

// Abre el calendario propio (shared-utils.js) en lugar del nativo, que no admite CSS.
function walletsSegBotonCalendarioHtml(extremo) {
    return `<button type="button" class="walletsSegFechaBtn" aria-label="Elegir fecha ${extremo}" aria-haspopup="dialog" aria-expanded="false" title="Abrir calendario"><span class="icono iconoCalendario" aria-hidden="true"></span></button>`
}

function walletsSegFechasHtml(estado) {
    const desde = escapeHtml(estado.fechaDesde)
    const hasta = escapeHtml(estado.fechaHasta)
    const conFechas = Boolean(desde || hasta)
    // No hay movimientos futuros: el calendario apaga lo posterior a hoy.
    const hoy = walletsSegHoy()
    return `
        <div class="walletsSegFechas">
            <div class="walletsSegRango${conFechas ? " activo" : ""}" role="group" aria-label="Filtrar por fecha">
                <label class="walletsSegRangoCampo">
                    <span>Desde</span>
                    <input type="date" class="walletsSegFechaInput${desde ? "" : " vacio"}" data-campo="fechaDesde" value="${desde}" max="${hasta || hoy}">
                    ${walletsSegBotonCalendarioHtml("desde")}
                </label>
                <span class="walletsSegRangoSep" aria-hidden="true">→</span>
                <label class="walletsSegRangoCampo">
                    <span>Hasta</span>
                    <input type="date" class="walletsSegFechaInput${hasta ? "" : " vacio"}" data-campo="fechaHasta" value="${hasta}" max="${hoy}"${desde ? ` min="${desde}"` : ""}>
                    ${walletsSegBotonCalendarioHtml("hasta")}
                </label>
                <button type="button" class="walletsSegFechasQuitarBtn${conFechas ? "" : " hidden"}" aria-label="Quitar fechas" title="Quitar fechas">
                    <span class="icono iconoCerrar" aria-hidden="true"></span>
                </button>
            </div>
            <span class="walletsSegFechasNota">Busca entre los movimientos leídos; para ir más atrás, «Cargar más».</span>
        </div>`
}

function walletsSegFiltrar(movimientos, filtro) {
    if (filtro === "tokens") return movimientos.filter((mov) => mov.contrato)
    if (filtro === "imitaciones") {
        return movimientos.filter((mov) => walletsSegEstadoToken(mov, walletsSegRedDeMovimiento(mov)) === "imitacion")
    }
    if (filtro === "todos") return movimientos
    return movimientos.filter((mov) => mov.tipo === filtro)
}

// La comisión que pagó la wallet, o si la pagó el otro lado, la de la
// transacción atenuada: se ve pero no suma en las estadísticas.
function walletsSegComisionHtml(mov, simbolo) {
    if (mov.comision) return `${walletsSegNumero(mov.comision)} ${escapeHtml(simbolo)}`
    if (!mov.comisionTx) return ""
    return `<span class="walletsSegComisionAjena" title="${escapeHtml(walletsSegComisionDetalle(mov, simbolo).nota)}">${walletsSegNumero(mov.comisionTx)} ${escapeHtml(simbolo)}</span>`
}

// La contraparte con apodo se enseña por el apodo; la dirección sigue en el
// título y se copia igual.
function walletsSegDireccionHtml(direccion, propia, apodo = "", marca = "") {
    const titulo = propia ? `Dirección de esta wallet: ${direccion}` : apodo ? `${apodo} · ${direccion}` : direccion
    const clases = ["walletsSegCopiable", propia ? "walletsSegDirPropia" : "", apodo ? "walletsSegDirApodada" : ""]
    if (marca) clases.push(`walletsSegDir-${marca}`)
    return `<td class="${clases.filter(Boolean).join(" ")}" data-full-value="${escapeHtml(direccion || "")}" title="${escapeHtml(titulo || "")}">${escapeHtml(apodo || walletsSegAbreviar(direccion))}</td>`
}

function walletsSegFilaHistorialHtml(mov, wallet, varias, indice) {
    const red = wallet ? walletsSegRed(wallet) : null
    const signo = mov.tipo === "enviada" ? "−" : mov.tipo === "recibida" ? "+" : ""
    const enlace = red?.explorador ? red.explorador.replace("{hash}", encodeURIComponent(mov.hash)) : ""
    // `sentido` es el que leyó la red: aunque la libreta lo convierta en «entre
    // propias», dice cuál de las dos direcciones envió.
    const sentido = mov.sentido || mov.tipo
    const contraparte = walletsSegDireccionHtml(mov.contraparte, false, mov.contraparteApodo, mov.contraparteMarca)
    const origen = sentido === "recibida" ? contraparte : walletsSegDireccionHtml(mov.propia, true)
    const destino = sentido === "enviada" ? contraparte : walletsSegDireccionHtml(mov.propia, true)
    return `
        <tr class="walletsSegMov-${escapeHtml(mov.tipo)} walletsSegFilaMov" data-indice="${indice}" title="Haz clic para ver el movimiento completo">
            <td>${escapeHtml(walletsSegFecha(mov.fecha))}</td>
            ${varias ? `<td>${escapeHtml(wallet?.alias || "")}</td>` : ""}
            <td>${escapeHtml(walletsSegTextoTipo(mov))}</td>
            <td class="walletsSegMovCantidad">${signo}${walletsSegNumero(mov.cantidad)} ${escapeHtml(mov.simbolo)}</td>
            <td>${wallet ? walletsSegTokenHtml(mov, wallet.red, false) : ""}</td>
            <td>${walletsSegComisionHtml(mov, red?.simbolo || "")}</td>
            ${origen}
            ${destino}
            <td class="walletsSegCopiable" data-full-value="${escapeHtml(mov.hash)}" title="Haz clic para copiar el hash completo">${escapeHtml(walletsSegAbreviar(mov.hash))}</td>
            <td>${enlace ? `<a href="${escapeHtml(enlace)}" target="_blank" rel="noopener noreferrer" title="Abre la transacción en el explorador de bloques">Ver ↗</a>` : ""}</td>
            <td class="rowActionsCell">${wallet ? walletsSegMenuTokenHtml(mov, wallet.red) : ""}</td>
        </tr>`
}

function walletsSegHistorialHtml(estado, grupo, movimientos) {
    const historiales = grupo.wallets.map((wallet) => walletsSegHistorialDe(estado, wallet.id))
    const errores = historiales.map((historial) => historial.error).filter(Boolean)
    const avisoErrores = errores.length ? `<p class="ajustesAviso">${escapeHtml(errores.join(" · "))}</p>` : ""
    if (!movimientos.length) {
        if (estado.cargando) return `<p class="overviewEmpty">Leyendo el historial de la red…</p>`
        return avisoErrores || `<p class="overviewEmpty">Este seguimiento no tiene movimientos.</p>`
    }
    const varias = grupo.wallets.length > 1
    const porId = new Map(grupo.wallets.map((wallet) => [wallet.id, wallet]))
    const enRango = walletsSegEnRango(movimientos, estado.fechaDesde, estado.fechaHasta)
    const visibles = walletsSegFiltrar(enRango, estado.filtro)
    // Cada fila lleva su posición aquí: un mismo hash puede tener varios
    // movimientos (la moneda y un token), así que no sirve para encontrarla.
    estado.visibles = visibles
    const filtros = WALLETS_SEG_FILTROS.map((f) => {
        const cuantos = walletsSegFiltrar(enRango, f.valor).length
        if (f.valor !== "todos" && !cuantos) return ""
        return `<button type="button" class="walletsSegFiltro${estado.filtro === f.valor ? " activo" : ""}" data-filtro="${f.valor}">${f.texto} (${cuantos})</button>`
    }).join("")
    const agotados = historiales.every((historial) => historial.agotado)
    const enElTope = historiales.some((historial) => historial.maximo && historial.limite >= historial.maximo)
    const pie = estado.cargando
        ? "Leyendo…"
        : agotados
          ? enElTope
              ? `Tope de ${historiales[0].maximo} movimientos por wallet ([wallets] max_historial en config.ini).`
              : "No hay más movimientos."
          : `<button type="button" class="cancelButton walletsSegMasBtn">Cargar ${WALLETS_SEG_PAGINA} más</button>`
    const releer = estado.cargando
        ? ""
        : `<button type="button" class="cancelButton walletsSegReleerBtn">Volver a leer</button>`
    return `
        <div class="walletsSegFiltros">
            ${filtros}
            <button type="button" class="cancelButton walletsSegGrafoBtn" title="Dibuja por qué direcciones ha pasado el dinero de los movimientos que se ven en la tabla">Ver en gráfico</button>
        </div>
        <div class="operationsTableWrapper walletsSegTabla">
            <table class="operationsTable">
                <thead>
                    <tr><th>Fecha</th>${varias ? "<th>Wallet</th>" : ""}<th>Tipo</th><th class="walletsSegThCantidad">Cantidad</th><th>Token</th><th>Comisión</th><th>Origen</th><th>Destino</th><th>Hash</th><th></th><th></th></tr>
                </thead>
                <tbody>${visibles.map((mov, indice) => walletsSegFilaHistorialHtml(mov, porId.get(mov.walletId), varias, indice)).join("")}</tbody>
            </table>
        </div>
        ${avisoErrores}
        <div class="walletsSegMas">
            <span>Mostrando ${visibles.length} de ${movimientos.length} movimientos leídos</span>
            ${walletsSegConsultadoHtml(estado.historialFecha, `${pie}${releer}`)}
        </div>`
}

// ── Gráfico de movimientos ────────────────────────────────────────────────────
// El mismo grafo de Cuentas (js/core/flujos-grafo.js), con una bolita por
// dirección. Dibuja lo que enseña la tabla (filtro y fechas) y una sola moneda
// o token cada vez: las cantidades van en unidades y no se pueden sumar entre sí.

// La dirección de la wallet se nombra por su alias, igual que el servidor nombra
// una contraparte que es otra wallet enlazada: así A → B casa desde los dos
// historiales. La ajena, por su apodo de la libreta o por la dirección entera,
// que el grafo abrevia y enseña completa al pasar el ratón.
function walletsSegExtremosGrafo(mov, wallet) {
    const sentido = mov.sentido || mov.tipo
    const propia = wallet?.alias || mov.propia
    const contraparte = mov.contraparteApodo || mov.contraparte
    if (sentido === "recibida") return { origen: contraparte, destino: propia }
    if (sentido === "enviada") return { origen: propia, destino: contraparte }
    // Entre direcciones de la misma wallet (el cambio de una xpub): no sale de ella.
    return null
}

function walletsSegActivosGrafo(movimientos, porId, conImitaciones) {
    const activos = new Map()
    for (const mov of movimientos) {
        const wallet = porId.get(mov.walletId)
        if (!wallet || (!conImitaciones && walletsSegEstadoToken(mov, wallet.red) === "imitacion")) continue
        const clave = `${wallet.red}\u0000${mov.contrato || mov.simbolo}`
        if (!activos.has(clave)) {
            const red = walletsSegRed(wallet)
            activos.set(clave, { clave, simbolo: mov.simbolo, red: red?.nombre || wallet.red, movimientos: [] })
        }
        activos.get(clave).movimientos.push(mov)
    }
    return [...activos.values()].sort((a, b) => b.movimientos.length - a.movimientos.length)
}

// Un movimiento entre dos wallets del mismo seguimiento llega dos veces, una
// desde cada historial: se cuenta una sola.
function walletsSegFlujosGrafo(movimientos, porId) {
    const vistos = new Set()
    const flujos = []
    for (const mov of movimientos) {
        const extremos = walletsSegExtremosGrafo(mov, porId.get(mov.walletId))
        if (!extremos) continue
        const clave = [mov.hash, mov.contrato, mov.simbolo, extremos.origen, extremos.destino, mov.cantidad].join(
            "\u0000"
        )
        if (vistos.has(clave)) continue
        vistos.add(clave)
        flujos.push({ ...extremos, cantidad: parseLooseNumber(mov.cantidad) ?? 0 })
    }
    return flujos
}

function abrirGrafoSeguimiento() {
    const estado = walletsSegDetalle
    const grupo = estado && walletsSegGrupo(estado.clave)
    if (!grupo) return
    const porId = new Map(grupo.wallets.map((wallet) => [wallet.id, wallet]))
    // Las imitaciones solo ensucian el dibujo con direcciones señuelo; se ven si
    // es lo que se ha filtrado a propósito.
    const activos = walletsSegActivosGrafo(estado.visibles || [], porId, estado.filtro === "imitaciones")
    if (!activos.length) {
        abrirGrafoActivoSeguimiento(grupo, null, porId)
        return
    }
    if (activos.length === 1) {
        abrirGrafoActivoSeguimiento(grupo, activos[0], porId)
        return
    }
    abrirElegirActivoGrafo(activos, (activo) => abrirGrafoActivoSeguimiento(grupo, activo, porId))
}

function abrirGrafoActivoSeguimiento(grupo, activo, porId) {
    const simbolo = activo?.simbolo || ""
    const movimientos = activo?.movimientos || []
    const partes = [grupo.nombre]
    if (activo) partes.push(activo.red, `${movimientos.length} movimiento${movimientos.length === 1 ? "" : "s"} leídos`)
    abrirGrafoFlujos({
        titulo: activo ? `Movimientos de ${simbolo}` : "Movimientos",
        subtitulo: partes.join(" · "),
        movimientos: walletsSegFlujosGrafo(movimientos, porId),
        formato: (n) =>
            `${n.toLocaleString("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: 8 })} ${simbolo}`.trim(),
        vacio: "No hay movimientos entre direcciones distintas con este filtro."
    })
}

function abrirElegirActivoGrafo(activos, alElegir) {
    cerrarElegirActivoGrafo()
    const overlay = document.createElement("div")
    overlay.id = "walletsSegGrafoActivoOverlay"
    overlay.className = "modalOverlay"
    overlay.innerHTML = `
        <div class="assetModal walletsSegGrafoActivoModal" role="dialog" aria-modal="true" aria-labelledby="walletsSegGrafoActivoTitulo">
            <h3 class="assetModalTitle" id="walletsSegGrafoActivoTitulo">¿De qué moneda?</h3>
            <p class="assetModalHint">El gráfico suma cantidades, así que dibuja una moneda o token cada vez.</p>
            <div class="walletsSegGrafoActivos">
                ${activos
                    .map(
                        (activo, indice) =>
                            `<button type="button" class="cancelButton" data-indice="${indice}">${escapeHtml(activo.simbolo)} · ${escapeHtml(activo.red)} <span class="walletsSegDato">(${activo.movimientos.length})</span></button>`
                    )
                    .join("")}
            </div>
            <div class="assetModalActions">
                <button type="button" class="cancelButton" data-cerrar>Cancelar</button>
            </div>
        </div>`
    overlay.addEventListener("click", (event) => {
        const boton = event.target.closest("[data-indice]")
        if (boton) {
            cerrarElegirActivoGrafo()
            alElegir(activos[Number(boton.dataset.indice)])
            return
        }
        if (event.target === overlay || event.target.closest("[data-cerrar]")) cerrarElegirActivoGrafo()
    })
    document.addEventListener("keydown", walletsSegTeclaElegirActivo)
    document.body.appendChild(overlay)
}

function walletsSegTeclaElegirActivo(event) {
    if (event.key === "Escape") cerrarElegirActivoGrafo()
}

function cerrarElegirActivoGrafo() {
    document.getElementById("walletsSegGrafoActivoOverlay")?.remove()
    document.removeEventListener("keydown", walletsSegTeclaElegirActivo)
}

// ── Ventana de un movimiento ──────────────────────────────────────────────────
// Lo que la tabla abrevia, completo: direcciones, hash y contrato, con un clic
// para copiar cada uno.

function walletsSegFechaCompleta(iso) {
    if (!iso) return "—"
    const fecha = new Date(iso)
    return Number.isNaN(fecha.getTime())
        ? "—"
        : fecha.toLocaleString("es-ES", { dateStyle: "full", timeStyle: "medium" })
}

// El servidor manda las cantidades como texto decimal exacto («0.000120» ya
// sin ceros de sobra): se formatea el texto para no perder los decimales que
// un número de JavaScript redondearía en un token de 18.
function walletsSegCantidadExacta(valor) {
    const texto = String(valor ?? "").trim()
    const partes = /^-?(\d+)(?:\.(\d+))?$/.exec(texto)
    if (!partes) return walletsSegNumero(valor)
    const entera = partes[1].replace(/\B(?=(\d{3})+(?!\d))/g, ".")
    return partes[2] ? `${entera},${partes[2]}` : entera
}

function walletsSegValorCopiableHtml(valor, nota = "") {
    if (!valor) return "—"
    return `<code class="walletsSegCopiable walletsSegMovValor" data-full-value="${escapeHtml(valor)}" title="Haz clic para copiarlo">${escapeHtml(valor)}</code>${
        nota ? ` <span class="walletsSegDato">${escapeHtml(nota)}</span>` : ""
    }`
}

// ¿La comisión de la transacción es del usuario porque también envió él? Con varios
// orígenes solo el servidor lo sabe (y entonces ya manda `comision`): aquí, al repintar
// sin releer, se responde únicamente del caso de un origen.
function walletsSegOrigenEsPropio(mov) {
    return mov.contraparteMarca === "propia" && (mov.contrapartes || []).length <= 1
}

function walletsSegComisionDeOrigenPropio(mov) {
    const esRecibo = (mov.sentido || mov.tipo) === "recibida"
    return esRecibo && !mov.contrato && mov.marcaMovimiento !== "ajena" && walletsSegOrigenEsPropio(mov)
        ? mov.comisionTx || ""
        : ""
}

/**
 * Dice cuánto costó la transacción y quién lo pagó, según su clasificación actual.
 *
 * @param {object} mov Movimiento con la libreta aplicada.
 * @param {string} simbolo Moneda de la red, en la que se paga la comisión.
 * @returns {{importe: string, nota: string}} Importe con su moneda y quién lo pagó;
 *     ambos vacíos si la red no informa de la comisión.
 */
function walletsSegComisionDetalle(mov, simbolo) {
    const entreWallets = mov.tipo === "entre_wallet"
    const importe = (valor, moneda) => `${walletsSegCantidadExacta(valor)} ${moneda}`.trim()
    const pagadaPorTi = "Pagada por ti: el origen y el destino son tuyos"
    if (mov.comisionMarcada && mov.comisionExchange) {
        return {
            importe: importe(mov.comisionMarcada, mov.simbolo),
            nota: "Total del exchange, con la comisión de red incluida; se descuenta de la posición"
        }
    }
    if (mov.comisionMarcada) {
        return {
            importe: importe(mov.comisionMarcada, mov.simbolo),
            // Otra cantidad que la de la red es lo que cobró el exchange, sea de quien sea el origen.
            nota:
                walletsSegOrigenEsPropio(mov) && Number(mov.comisionMarcada) === Number(mov.comisionTx)
                    ? pagadaPorTi
                    : "Indicada por ti; se descuenta de la posición"
        }
    }
    if (mov.comision)
        return { importe: importe(mov.comision, simbolo), nota: entreWallets ? pagadaPorTi : "Pagada por esta wallet" }
    if (mov.comisionTx) {
        return {
            importe: importe(mov.comisionTx, simbolo),
            nota: entreWallets
                ? "Pagada en el origen; no se descuenta de la posición"
                : "Pagada por el remitente; no se descuenta de la posición"
        }
    }
    return { importe: "", nota: "" }
}

function walletsSegComisionFilaHtml({ importe, nota }) {
    if (!importe) return "—"
    return `<strong class="walletsSegMovComision">${escapeHtml(importe)}</strong> <span class="walletsSegDato">${escapeHtml(nota)}</span>`
}

/**
 * Pinta la cabecera de la ventana: lo primero que se lee es qué pasó y por cuánto.
 *
 * @param {{tipo: string, etiqueta: string, cantidad: string, fecha: string}} datos
 *     `tipo` elige el color; los demás son texto sin escapar.
 * @returns {string} El HTML de la cabecera.
 */
function walletsSegMovCabeceraHtml({ tipo, etiqueta, cantidad, fecha }) {
    return `
        <div class="walletsSegMovCabecera walletsSegMov-${escapeHtml(tipo)}">
            <span class="walletsSegMovTipoEtiqueta">${escapeHtml(etiqueta)}</span>
            <strong class="walletsSegMovCantidad">${escapeHtml(cantidad)}</strong>
            <span class="walletsSegDato">${escapeHtml(fecha)}</span>
        </div>`
}

function walletsSegMovExtremoHtml({ titulo, nombre = "", valor, etiqueta = "" }) {
    return `
        <div class="walletsSegMovExtremo">
            <span class="walletsSegMovExtremoTitulo">${escapeHtml(titulo)}${etiqueta ? `<span class="walletsSegMovExtremoEtiqueta">${escapeHtml(etiqueta)}</span>` : ""}</span>
            ${nombre ? `<span class="walletsSegMovExtremoNombre">${escapeHtml(nombre)}</span>` : ""}
            ${walletsSegValorCopiableHtml(valor)}
        </div>`
}

function walletsSegMovRutaHtml(origen, destino) {
    return `
        <div class="walletsSegMovRuta">
            ${walletsSegMovExtremoHtml(origen)}
            <svg class="walletsSegMovRutaFlecha" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>
            ${walletsSegMovExtremoHtml(destino)}
        </div>`
}

function walletsSegMovExtremoPropio(titulo, valor, wallet) {
    return { titulo, nombre: wallet?.alias || "", valor, etiqueta: "Esta wallet" }
}

function walletsSegMovExtremoContraparte(titulo, mov) {
    const propia = mov.contraparteMarca === "propia"
    const etiqueta = mov.contraparteEnlazada
        ? "Tuya · enlazada"
        : propia
          ? "Tuya"
          : mov.contraparteMarca
            ? "Ajena"
            : "Sin identificar"
    return {
        titulo,
        nombre: mov.contraparteApodo || (propia ? "Dirección propia" : "Dirección externa"),
        valor: mov.contraparte,
        etiqueta
    }
}

function walletsSegMovResumenHtml(mov, wallet) {
    const signo = mov.tipo === "enviada" ? "−" : mov.tipo === "recibida" ? "+" : ""
    const sentido = mov.sentido || mov.tipo
    const origen =
        sentido === "recibida"
            ? walletsSegMovExtremoContraparte("Origen", mov)
            : walletsSegMovExtremoPropio("Origen", mov.propia, wallet)
    const destino =
        sentido === "enviada"
            ? walletsSegMovExtremoContraparte("Destino", mov)
            : walletsSegMovExtremoPropio("Destino", mov.propia, wallet)
    const cabecera = walletsSegMovCabeceraHtml({
        tipo: walletsSegEsPendiente(mov) ? "pendiente" : mov.tipo,
        etiqueta: walletsSegTextoTipo(mov) || "Movimiento",
        cantidad: `${signo}${walletsSegCantidadExacta(mov.cantidad)} ${mov.simbolo}`,
        fecha: walletsSegFechaCompleta(mov.fecha)
    })
    return `${cabecera}${walletsSegMovRutaHtml(origen, destino)}`
}

function walletsSegMovimientoHtml(mov, wallet) {
    const red = wallet ? walletsSegRed(wallet) : null
    const estadoToken = wallet ? walletsSegEstadoToken(mov, wallet.red) : ""
    const filas = [
        ["Wallet", escapeHtml([wallet?.alias, red?.nombre || wallet?.red].filter(Boolean).join(" · ") || "—")],
        [
            "Activo",
            mov.contrato
                ? `${escapeHtml(mov.simbolo)} · ${escapeHtml(WALLETS_SEG_ESTADOS_TOKEN[estadoToken]?.texto || "Token")}`
                : `${escapeHtml(mov.simbolo)} · moneda de la red`
        ],
        ...(mov.contrato ? [["Contrato", walletsSegValorCopiableHtml(mov.contrato)]] : []),
        ["Comisión", walletsSegComisionFilaHtml(walletsSegComisionDetalle(mov, red?.simbolo || ""))],
        ["Hash", walletsSegValorCopiableHtml(mov.hash)],
        ...(mov.nota ? [["Nota", escapeHtml(mov.nota)]] : [])
    ]
    return filas.map(([clave, valor]) => `<div><dt>${escapeHtml(clave)}</dt><dd>${valor}</dd></div>`).join("")
}

// La ventana común: la usan el movimiento leído de la red y, en Transacciones, las
// filas de las que no hay movimiento (js/cripto/transacciones.js). `filaTransaccion`
// añade «Editar» para llegar al formulario de esa fila.
function walletsSegMontarVentanaMovimiento(
    { titulo, tipo, resumenHtml = "", datosHtml, seccionesHtml = "", enlace = "", filaTransaccion = "" },
    alPulsar = () => {}
) {
    cerrarMovimientoSeguimiento()
    const overlay = document.createElement("div")
    overlay.id = "walletsSegMovOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"
    overlay.innerHTML = `
        <div class="assetModal assetRowModal walletsSegMovModal" role="dialog" aria-modal="true" aria-labelledby="walletsSegMovTitulo">
            <h3 id="walletsSegMovTitulo" class="assetModalTitle assetRowModalTitle">${escapeHtml(titulo)}</h3>
            <div class="assetRowModalFields">
                ${resumenHtml}
                <dl class="walletsSegMovDatos walletsSegMov-${escapeHtml(tipo)}">${datosHtml}</dl>
                ${seccionesHtml.trim() ? `<div class="walletsSegMovSecciones">${seccionesHtml}</div>` : ""}
            </div>
            <div class="assetRowModalFooter">
                ${enlace ? `<a class="secondaryButton walletsSegMovExplorador" href="${escapeHtml(enlace)}" target="_blank" rel="noopener noreferrer">Ver en el explorador ↗</a>` : ""}
                ${filaTransaccion ? `<button type="button" class="cancelButton walletsSegMovEditarBtn">${escapeHtml(textoEditarFilaTransaccion(filaTransaccion))}</button>` : ""}
                <button type="button" class="primaryButton walletsSegMovCerrarBtn">Cerrar</button>
            </div>
        </div>`
    document.body.appendChild(overlay)

    overlay.addEventListener("click", (event) => {
        // Solo cierra el botón (o Escape): la ventana tiene campos y pinchar fuera
        // sin querer perdía lo escrito.
        if (event.target.closest(".walletsSegMovCerrarBtn")) {
            cerrarMovimientoSeguimiento()
            return
        }
        if (event.target.closest(".walletsSegMovEditarBtn")) {
            cerrarMovimientoSeguimiento()
            openTransaccionRowModal(filaTransaccion)
            return
        }
        const copiable = event.target.closest(".walletsSegCopiable")
        if (copiable && typeof copyHashTransaccionToClipboard === "function") {
            copyHashTransaccionToClipboard(copiable)
            return
        }
        alPulsar(event)
    })
    // En document y no en la ventana: al pulsar un valor para copiarlo el foco
    // vuelve al body y la ventana ya no recibiría la tecla.
    document.addEventListener("keydown", walletsSegTeclaMovimiento)
    overlay.querySelector(".walletsSegMovCerrarBtn").focus()
}

function abrirMovimientoSeguimiento(mov) {
    if (!mov) return
    const wallet = walletsEstado.wallets.find((w) => w.id === mov.walletId)
    const red = wallet ? walletsSegRed(wallet) : null
    const enlace = red?.explorador && mov.hash ? red.explorador.replace("{hash}", encodeURIComponent(mov.hash)) : ""
    const ventana = {
        titulo: `Detalle de la transacción de ${mov.simbolo}`,
        tipo: mov.tipo,
        resumenHtml: walletsSegMovResumenHtml(mov, wallet),
        datosHtml: walletsSegMovimientoHtml(mov, wallet),
        seccionesHtml: `${walletsSegComisionExchangeHtml(mov, wallet)}${walletsSegMarcaMovimientoHtml(mov, wallet)}${walletsSegContraparteHtml(mov, wallet)}`,
        enlace,
        filaTransaccion: mov.filaTransaccion || ""
    }
    walletsSegMontarVentanaMovimiento(ventana, (event) => {
        if (event.target.closest(".walletsSegComisionExchangeBtn") && wallet) {
            aplicarComisionExchange(mov, wallet)
            return
        }
        if (event.target.closest(".walletsSegComisionExchangeEditarBtn")) {
            editarComisionExchange()
            return
        }
        const marcarMovimiento = event.target.closest(".walletsSegMarcaMovBtn")
        if (marcarMovimiento && wallet) {
            const { propia } = marcarMovimiento.dataset
            marcarMovimientoSeguimiento(mov, wallet, propia === "quitar" ? null : propia === "true")
            return
        }
        const marcar = event.target.closest(".walletsSegContraMarcarBtn")
        if (marcar && wallet) {
            marcarContraparteMovimiento(mov, wallet, marcar.dataset.propia === "true")
            return
        }
        if (event.target.closest(".walletsSegContraQuitarBtn") && wallet) {
            olvidarContraparteMovimiento(mov, wallet)
        }
    })
    walletsSegEnlazarCasillaOtra(mov, wallet)
}

function walletsSegTeclaMovimiento(event) {
    if (event.key === "Escape") cerrarMovimientoSeguimiento()
}

function cerrarMovimientoSeguimiento() {
    document.removeEventListener("keydown", walletsSegTeclaMovimiento)
    document.getElementById("walletsSegMovOverlay")?.remove()
}
