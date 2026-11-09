// Cripto > Seguimiento: libreta de direcciones.
//
// Trozo de js/cripto/wallets-seguimiento.js. Comparte con el resto de wallets-seguimiento-*.js el
// ámbito global y se carga detrás de wallets-seguimiento.js, en el orden de index.html.

// ── Libreta de direcciones ────────────────────────────────────────────────────
// Qué contrapartes son del usuario y cómo se llaman. Se guarda en el servidor
// (cifrada con las wallets) porque decide el tipo de los movimientos también
// en los avisos y en Transacciones; aquí se marca y se repinta.

const WALLETS_SEG_SENTIDOS = new Set(["enviada", "recibida"])

function walletsSegDireccionManual(red, direccion) {
    return (walletsEstado.direcciones || []).find((d) => d.red === red && d.direccion === direccion) || null
}

function walletsSegContraparteHtml(mov, wallet) {
    if (!wallet || !mov.contraparte || !WALLETS_SEG_SENTIDOS.has(mov.sentido || mov.tipo)) return ""
    const manual = walletsSegDireccionManual(wallet.red, mov.contraparteClave)
    const estado = manual
        ? manual.propia
            ? "Marcada como tuya"
            : "Marcada como ajena"
        : mov.contraparteEnlazada
          ? `De tu wallet enlazada «${mov.contraparteApodo}»`
          : "Sin identificar"
    const boton = (propia, texto) =>
        `<button type="button" class="${manual?.propia === propia ? "primaryButton" : "cancelButton"} walletsSegContraMarcarBtn" data-propia="${propia}">${texto}</button>`
    return `
        <section class="walletsSegContraparte" aria-labelledby="walletsSegContraTitulo">
            <h4 id="walletsSegContraTitulo" class="walletsSegContraTitulo">${walletsSegContraTitulo(mov)}</h4>
            <p class="walletsSegMovEstado">${escapeHtml(estado)}</p>
            <p class="walletsSegDato">Las direcciones marcadas como tuyas clasifican todos sus movimientos como «${escapeHtml(WALLETS_SEG_TIPOS.entre_wallet)}» en Seguimiento, en los avisos y en Transacciones. Si eres quien recibe, también asumes la comisión de la red.</p>
            <label class="walletsSegContraApodo">
                <span>Apodo</span>
                <input type="text" class="assetRowModalInput walletsSegContraApodoInput" maxlength="60" autocomplete="off"
                    placeholder="Ej: Exodus, Binance, Mamá" value="${escapeHtml(manual?.apodo || "")}">
            </label>
            <div class="walletsSegContraBotones">
                ${boton(true, "Es mía")}
                ${boton(false, "Es ajena")}
                ${manual ? `<button type="button" class="cancelButton walletsSegContraQuitarBtn">Quitar marca</button>` : ""}
            </div>
        </section>`
}

// La comisión que se propone descontar. En Bitcoin la de la red es la de todo el
// lote del exchange, y en un token se paga en otra moneda: ahí la escribe el usuario.
// Si el origen también es suyo, la comisión es suya aunque sea Bitcoin: ya no hay lote ajeno.
function walletsSegComisionPropuesta(mov, wallet) {
    const leida = mov.comisionMarcada || mov.comisionLeida || mov.comision
    if (leida) return leida
    return !mov.contrato && (wallet.red !== "btc" || walletsSegOrigenEsPropio(mov)) ? mov.comisionTx || "" : ""
}

// Refleja lo guardado: marcada solo si la dirección ya es tuya. Darla de alta afecta a
// todos sus movimientos y puede ser la de un exchange, así que hay que pedirlo.
function walletsSegMarcarOtraPorDefecto(mov) {
    return mov.contraparteMarca === "propia"
}

// La comisión ya guardada en la marca, no la del campo: cambiar la casilla no debe
// aplicar lo que se esté escribiendo en él.
function walletsSegComisionGuardada(mov, wallet) {
    const guardada = walletsSegAdmiteComisionExchange(mov, wallet) ? mov.comisionExchange : mov.comisionMarcada
    return guardada || ""
}

/**
 * Guarda el cambio de la casilla en una transacción que ya es «Entre mis wallets».
 *
 * Sin esa marca la casilla es solo una elección para el botón que se pulse: no hay
 * nada que actualizar. Si el servidor rechaza el cambio, vuelve a como estaba.
 *
 * @param {object} mov Movimiento abierto en la ventana.
 * @param {object|undefined} wallet Wallet del movimiento.
 * @returns {void}
 */
function walletsSegEnlazarCasillaOtra(mov, wallet) {
    if (!wallet || mov.marcaMovimiento !== "propia") return
    const casilla = document.querySelector("#walletsSegMovOverlay .walletsSegMarcaMovOtra")
    casilla?.addEventListener("change", async () => {
        casilla.disabled = true
        const valorComision = walletsSegComisionGuardada(mov, wallet)
        if (await marcarMovimientoSeguimiento(mov, wallet, true, { valorComision })) return
        casilla.checked = !casilla.checked
        casilla.disabled = false
    })
}

// Las direcciones que «Entre mis wallets» da por propias: la de la wallet siempre,
// la otra si la casilla sigue marcada (si no hay casilla, ya es de una wallet enlazada).
function walletsSegDireccionesDeMarca(mov, propia, marcarOtra) {
    if (propia !== true) return []
    return [mov.propia, marcarOtra ? mov.contraparte : ""].filter(Boolean)
}

// Lo recibido de un exchange: el coste real es lo que salió de allí menos lo que llegó.
function walletsSegAdmiteComisionExchange(mov, wallet) {
    return Boolean(wallet) && wallet.propia !== false && (mov.sentido || mov.tipo) === "recibida"
}

function walletsSegComisionCampoHtml(mov, etiqueta, placeholder, valor, soloLectura = false) {
    return `
        <label class="walletsSegContraApodo">
            <span>${escapeHtml(etiqueta)} (${escapeHtml(mov.simbolo)})</span>
            <input type="text" inputmode="decimal" class="assetRowModalInput walletsSegMarcaMovComision" maxlength="40" autocomplete="off"
                placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(valor)}"${soloLectura ? " readonly" : ""}>
        </label>`
}

// La parte de la red que se descuenta en un recibo. En Bitcoin con origen ajeno es
// la de todo el lote del exchange, y en un token se paga en otra moneda: no suma.
function walletsSegComisionRedQueCuenta(mov, wallet, origenPropio = walletsSegOrigenEsPropio(mov)) {
    const leida = mov.comisionLeida ?? mov.comision ?? ""
    if (leida) return leida
    return !mov.contrato && (wallet.red !== "btc" || origenPropio) ? mov.comisionTx || "" : ""
}

// Lo que se envía al marcar. Si hay total del exchange, el servidor usa ese; la de red
// solo queda si el campo se vacía.
function walletsSegComisionesDeMarca(mov, wallet, valorCampo, marcarOtra) {
    if (!walletsSegAdmiteComisionExchange(mov, wallet)) return { comision: valorCampo, comisionExchange: "" }
    const origenPropio = walletsSegOrigenEsPropio(mov) || (marcarOtra && Boolean(mov.contraparte))
    return { comision: walletsSegComisionRedQueCuenta(mov, wallet, origenPropio), comisionExchange: valorCampo }
}

// Vacío solo vale si ya había una que quitar; un número ilegible nunca.
function walletsSegComisionExchangeEsAplicable(texto, mov) {
    const limpio = String(texto).trim().replace(",", ".")
    const numero = Number(limpio)
    if (!Number.isFinite(numero) || numero < 0) return false
    return numero > 0 || Boolean(mov.comisionExchange)
}

function aplicarComisionExchange(mov, wallet) {
    const valor = document.querySelector("#walletsSegMovOverlay .walletsSegMarcaMovComision")?.value || ""
    if (!walletsSegComisionExchangeEsAplicable(valor, mov)) {
        showToast("Indica la comisión del exchange: tiene que ser mayor que cero", { type: "error" })
        return
    }
    marcarMovimientoSeguimiento(mov, wallet, true)
}

function walletsSegComisionExchangeBotonHtml(fija) {
    return fija
        ? `<button type="button" class="cancelButton walletsSegComisionExchangeEditarBtn">Editar</button>`
        : `<button type="button" class="primaryButton walletsSegComisionExchangeBtn">Aplicar comisión</button>`
}

// Sin repintar la ventana: se perdería lo que haya en la casilla y el apodo sin guardar.
function editarComisionExchange() {
    const overlay = document.getElementById("walletsSegMovOverlay")
    const campo = overlay?.querySelector(".walletsSegMarcaMovComision")
    const boton = overlay?.querySelector(".walletsSegComisionExchangeEditarBtn")
    if (!campo || !boton) return
    campo.readOnly = false
    boton.outerHTML = walletsSegComisionExchangeBotonHtml(false)
    campo.focus()
    campo.select()
}

// Resta exacta de dos decimales en texto: con Number, los 18 decimales de ETH se redondean.
// Vacía si alguno no es un decimal o si la parte es mayor que el total.
function walletsSegRestoDecimal(total, parte) {
    const patron = /^\d+(\.\d+)?$/
    if (!patron.test(total) || !patron.test(parte)) return ""
    const decimalesDe = (valor) => valor.split(".")[1]?.length || 0
    const decimales = Math.max(decimalesDe(total), decimalesDe(parte))
    const escalado = (valor) => {
        const [entero, fraccion = ""] = valor.split(".")
        return BigInt(entero + fraccion.padEnd(decimales, "0"))
    }
    const resto = escalado(total) - escalado(parte)
    if (resto < 0n) return ""
    const digitos = resto.toString().padStart(decimales + 1, "0")
    return decimales ? `${digitos.slice(0, -decimales)}.${digitos.slice(-decimales)}` : digitos
}

function walletsSegComisionRepartoHtml(mov, simbolo, redQueCuenta) {
    const resto = redQueCuenta && mov.comisionExchange ? walletsSegRestoDecimal(mov.comisionExchange, redQueCuenta) : ""
    if (!resto) return ""
    const importe = (valor) => escapeHtml(`${walletsSegCantidadExacta(valor)} ${simbolo}`.trim())
    return `<p class="walletsSegDato walletsSegComisionReparto">Resto del exchange: <strong>${importe(resto)}</strong> · Total restado: <strong>${importe(mov.comisionExchange)}</strong></p>`
}

function walletsSegComisionRedDelApartadoHtml(mov, wallet) {
    if (!mov.comisionTx) return ""
    const simbolo = walletsSegRed(wallet)?.simbolo || ""
    const cuenta = walletsSegComisionRedQueCuenta(mov, wallet)
    const nota = cuenta ? "Va dentro del total del exchange" : "La pagó el remitente; no se suma"
    return `<p class="walletsSegDato walletsSegComisionRedFija">Comisión de red: <strong>${escapeHtml(`${walletsSegCantidadExacta(mov.comisionTx)} ${simbolo}`.trim())}</strong> · ${nota}</p>
            ${walletsSegComisionRepartoHtml(mov, simbolo, cuenta)}`
}

/**
 * Pinta el apartado para indicar lo que cobró el exchange por una retirada.
 *
 * La comisión de la red se enseña aparte y no se edita; va dentro del total que
 * indica el exchange. El campo es el mismo que leen los botones de la clasificación:
 * solo hay uno en la ventana. Una comisión ya aplicada queda en solo lectura hasta
 * pulsar «Editar»; se mantiene el campo para que esos botones sigan leyendo su valor.
 *
 * @param {object} mov Movimiento con la libreta aplicada.
 * @param {object|undefined} wallet Wallet del movimiento.
 * @returns {string} El HTML del apartado; vacío si el movimiento no es un recibo propio.
 */
function walletsSegComisionExchangeHtml(mov, wallet) {
    if (!walletsSegAdmiteComisionExchange(mov, wallet)) return ""
    const fija = Boolean(mov.comisionExchange)
    return `
        <section class="walletsSegContraparte walletsSegComisionExchange" aria-labelledby="walletsSegComisionExchangeTitulo">
            <h4 id="walletsSegComisionExchangeTitulo" class="walletsSegContraTitulo">Comisión del exchange</h4>
            <p class="walletsSegDato">Si retiraste de un exchange, indica la comisión que te muestra: lo retirado menos lo enviado. La aplicación la reparte entre la comisión de red y el resto del exchange, y resta de la posición ese total. La transacción queda como «Entre mis wallets».</p>
            ${walletsSegComisionRedDelApartadoHtml(mov, wallet)}
            <div class="walletsSegComisionExchangeFila">
                ${walletsSegComisionCampoHtml(mov, "Comisión del exchange", "Ej: 0,000018", mov.comisionExchange || "", fija)}
                ${walletsSegComisionExchangeBotonHtml(fija)}
            </div>
        </section>`
}

function walletsSegMarcaMovimientoHtml(mov, wallet) {
    const sentido = mov.sentido || mov.tipo
    if (!wallet || wallet.propia === false || !WALLETS_SEG_SENTIDOS.has(sentido)) return ""
    const marca = mov.marcaMovimiento || ""
    const boton = (propia, texto, activo) =>
        `<button type="button" class="${activo ? "primaryButton" : "cancelButton"} walletsSegMarcaMovBtn" data-propia="${propia}">${texto}</button>`
    const avisoBtc =
        wallet.red === "btc"
            ? `<p class="walletsSegDato">En Bitcoin, clasifícala así solo si todo el importe sigue siendo tuyo. Si parte del envío es el cambio a una dirección sin enlazar, la cantidad no será exacta: enlaza esa wallet con su xpub.</p>`
            : ""
    const avisoPendiente = walletsSegEsPendiente(mov)
        ? `<p class="walletsSegAlerta">Pendiente de verificar: todavía no cuenta en la posición. «Entrada real» la suma; «Entre mis wallets» no.</p>`
        : ""
    const textoSentido = walletsSegEsPendiente(mov) ? "Entrada real" : WALLETS_SEG_TIPOS[sentido]
    const casillaDirecciones =
        mov.contraparte && !mov.contraparteEnlazada
            ? `<label class="walletsSegMarcaMovDirecciones">
                <input type="checkbox" class="walletsSegMarcaMovOtra"${walletsSegMarcarOtraPorDefecto(mov) ? " checked" : ""}>
                <span>Marcar también la otra dirección como mía</span>
                <span class="walletsSegDato">Márcala solo si es tuya, no si pertenece a un exchange. Si queda como tuya, todos sus movimientos, pasados y futuros, contarán como «entre wallets» sin verificación y asumirás su comisión de red.</span>
            </label>`
            : ""
    return `
        <section class="walletsSegContraparte" aria-labelledby="walletsSegMarcaMovTitulo">
            <h4 id="walletsSegMarcaMovTitulo" class="walletsSegContraTitulo">Clasificación de la transacción</h4>
            ${avisoPendiente}
            <p class="walletsSegDato">Usa «Entre mis wallets» si mueves fondos entre direcciones tuyas o retiras de un exchange a tu wallet: la cantidad no vuelve a sumar a la posición y solo se descuenta la comisión.</p>
            ${avisoBtc}
            ${walletsSegAdmiteComisionExchange(mov, wallet) ? "" : walletsSegComisionCampoHtml(mov, "Comisión a descontar", "Importe de la comisión", walletsSegComisionPropuesta(mov, wallet))}
            ${casillaDirecciones}
            <div class="walletsSegContraBotones">
                ${boton("true", "Entre mis wallets", marca === "propia")}
                ${boton("false", escapeHtml(textoSentido), marca === "ajena")}
                ${marca ? boton("quitar", "Quitar marca", false) : ""}
            </div>
        </section>`
}

// El tipo de un movimiento: su marca manda sobre la de su dirección, como en
// wallets_libreta.clasificarMovimiento() en el servidor.
function walletsSegTipoEfectivo(sentido, marcaMovimiento, contraparteMarca) {
    if (!WALLETS_SEG_SENTIDOS.has(sentido)) return sentido
    if (marcaMovimiento) return marcaMovimiento === "propia" ? "entre_wallet" : sentido
    return contraparteMarca === "propia" ? "entre_wallet" : sentido
}

function walletsSegConMarca(mov, marca) {
    const sentido = mov.sentido || mov.tipo
    const comisionLeida = mov.comisionLeida ?? mov.comision ?? ""
    const marcaMovimiento = !marca ? "" : marca.propia ? "propia" : "ajena"
    const comisionMarcada = marca?.propia ? marca.comision : ""
    Object.assign(mov, { sentido, marcaMovimiento })
    Object.assign(mov, {
        comisionLeida,
        comisionMarcada,
        comisionExchange: marca?.propia ? marca.comisionExchange || "" : "",
        comision: comisionMarcada || comisionLeida || walletsSegComisionDeOrigenPropio(mov),
        tipo: walletsSegTipoEfectivo(sentido, marcaMovimiento, mov.contraparteMarca),
        // La marca es la verificación. Al quitarla, el servidor decide al volver a cargar.
        pendiente: marca ? false : mov.pendiente
    })
}

// Repinta sin volver a leer la red: la misma transacción puede estar en las dos
// wallets propias que la movieron.
function walletsSegAplicarMarca(mov, red, marca) {
    const aplicar = (otro) => {
        if (otro.hash === mov.hash && (otro.contrato || "") === (mov.contrato || "")) walletsSegConMarca(otro, marca)
    }
    for (const wallet of walletsEstado.wallets) {
        if (wallet.red === red) (wallet.recientes || []).forEach(aplicar)
    }
    for (const [walletId, historial] of Object.entries(walletsSegDetalle?.historiales || {})) {
        const wallet = walletsEstado.wallets.find((w) => w.id === walletId)
        if (wallet?.red === red) historial.movimientos.forEach(aplicar)
    }
    walletsSegConMarca(mov, marca)
}

async function marcarMovimientoSeguimiento(mov, wallet, propia, { valorComision } = {}) {
    const valorCampo =
        valorComision ?? (document.querySelector("#walletsSegMovOverlay .walletsSegMarcaMovComision")?.value || "")
    const marcarOtra = document.querySelector("#walletsSegMovOverlay .walletsSegMarcaMovOtra")?.checked ?? true
    let datos
    try {
        datos = await walletsPost(`/api/wallets/${encodeURIComponent(wallet.id)}/movimientos/marcar`, {
            hash: mov.hash,
            contrato: mov.contrato || "",
            simbolo: mov.simbolo,
            sentido: mov.sentido || mov.tipo,
            propia,
            ...walletsSegComisionesDeMarca(mov, wallet, valorCampo, marcarOtra),
            comisionLeida: mov.comisionLeida ?? mov.comision ?? "",
            direcciones: walletsSegDireccionesDeMarca(mov, propia, marcarOtra)
        })
    } catch (error) {
        showToast(error.message || "No se pudo marcar la transacción", { type: "error" })
        return false
    }
    walletsSegAplicarLibretaDeMarca(wallet.red, datos, mov)
    walletsSegAplicarMarca(mov, wallet.red, datos.marca)
    await walletsSegRepintarTrasMarcar()
    abrirMovimientoSeguimiento(mov)
    if (datos.avisoReetiquetado) {
        showToast(datos.avisoReetiquetado, { type: "error", duration: 8000 })
        return true
    }
    showToast(walletsSegTextoMarcada(datos), { type: "success" })
    return true
}

// La marca puede haber dado de alta o sacado direcciones de la libreta.
function walletsSegAplicarLibretaDeMarca(red, datos, movAbierto) {
    if (!datos.efectivas) return
    walletsEstado.direcciones = datos.direcciones || []
    walletsEstado.direccionesEnlazadas = datos.direccionesEnlazadas || []
    for (const [direccion, efectiva] of Object.entries(datos.efectivas))
        walletsSegAplicarLibreta(red, direccion, efectiva, movAbierto)
}

// La ventana también se abre desde Transacciones: cada página repinta solo si está
// en pantalla, y allí las filas las ha cambiado el servidor.
async function walletsSegRepintarTrasMarcar() {
    if (document.getElementById("walletsSegPropias")) renderWalletsSeguimiento()
    if (typeof recargarTransaccionesDesdeServidor !== "function") return
    try {
        await recargarTransaccionesDesdeServidor()
    } catch (error) {
        showError("No se pudieron recargar las transacciones", error)
    }
}

function walletsSegTextoMarcada(datos) {
    if (datos.reetiquetadas) return "Transacción marcada y actualizada en Transacciones"
    if (datos.importadas) return "Transacción verificada e importada a Transacciones"
    if (datos.porSincronizar) return "Transacción verificada: pulsa «Sincronizar» para importarla a Transacciones"
    return "Transacción marcada"
}

function walletsSegContraTitulo(mov) {
    return (mov.sentido || mov.tipo) === "enviada" ? "Dirección de destino" : "Dirección de origen"
}

async function marcarContraparteMovimiento(mov, wallet, propia) {
    const apodo = document.querySelector("#walletsSegMovOverlay .walletsSegContraApodoInput")?.value || ""
    const datos = await guardarDireccionLibreta(
        "/api/wallets/direcciones/guardar",
        {
            red: wallet.red,
            direccion: mov.contraparte,
            apodo,
            propia
        },
        mov
    )
    if (datos) abrirMovimientoSeguimiento(mov)
}

async function olvidarContraparteMovimiento(mov, wallet) {
    const datos = await guardarDireccionLibreta(
        "/api/wallets/direcciones/olvidar",
        {
            red: wallet.red,
            direccion: mov.contraparteClave || mov.contraparte
        },
        mov
    )
    if (datos) abrirMovimientoSeguimiento(mov)
}

// Repinta sin volver a leer la red: aplica a los movimientos ya leídos de esa
// dirección lo mismo que wallets_libreta.anotar() en el servidor. `movAbierto` es el de
// la ventana: desde Transacciones puede venir de un historial que no está en estas listas.
function walletsSegAplicarLibreta(red, direccion, efectiva, movAbierto) {
    const aplicar = (mov) => {
        if (mov.contraparteClave !== direccion) return
        const sentido = mov.sentido || mov.tipo
        Object.assign(mov, {
            sentido,
            tipo: walletsSegTipoEfectivo(sentido, mov.marcaMovimiento, efectiva?.marca),
            contraparteApodo: efectiva?.apodo || "",
            contraparteMarca: efectiva?.marca || "",
            contraparteEnlazada: Boolean(efectiva?.enlazada)
        })
        mov.comision =
            mov.comisionMarcada || (mov.comisionLeida ?? mov.comision ?? "") || walletsSegComisionDeOrigenPropio(mov)
    }
    for (const wallet of walletsEstado.wallets) {
        if (wallet.red === red) (wallet.recientes || []).forEach(aplicar)
    }
    for (const [walletId, historial] of Object.entries(walletsSegDetalle?.historiales || {})) {
        const wallet = walletsEstado.wallets.find((w) => w.id === walletId)
        if (wallet?.red === red) historial.movimientos.forEach(aplicar)
    }
    if (movAbierto) aplicar(movAbierto)
}

async function guardarDireccionLibreta(url, cuerpo, movAbierto) {
    let datos
    try {
        datos = await walletsPost(url, cuerpo)
    } catch (error) {
        showToast(error.message || "No se pudo guardar la dirección", { type: "error" })
        return null
    }
    walletsEstado.direcciones = datos.direcciones || []
    walletsEstado.direccionesEnlazadas = datos.direccionesEnlazadas || []
    walletsSegAplicarLibreta(datos.red, datos.direccion, datos.efectiva, movAbierto)
    await walletsSegRepintarTrasMarcar()
    renderLibretaSeguimiento()
    if (datos.avisoReetiquetado) {
        showToast(datos.avisoReetiquetado, { type: "error", duration: 8000 })
    } else {
        const extra = datos.reetiquetadas ? ` · ${datos.reetiquetadas} movimientos actualizados en Transacciones` : ""
        showToast(`Dirección guardada${extra}`, { type: "success" })
    }
    return datos
}

// Búsqueda de la libreta: se conserva al cerrarla y volver a abrirla.
let walletsSegDirBusqueda = ""
// Direcciones completas de las wallets enlazadas, por id. Solo mientras la
// libreta está abierta: al cerrarla o al pulsar «Ocultar» se pierden y verlas
// otra vez exige la contraseña, como en «Editar seguimiento».
const walletsSegDirCompletas = new Map()
// Saldos consultados de las direcciones marcadas a mano, por «red:dirección».
// En memoria y no en el servidor: esas direcciones no se vigilan.
const walletsSegDirSaldos = new Map()
// Id de la wallet enlazada cuyo apodo se está editando en su fila.
let walletsSegDirEditando = ""
// Fila con el formulario de seguimiento abierto: el id de la wallet si es una
// enlazada que se mueve, o «red:dirección» si es una marcada que se vincula.
let walletsSegDirVinculando = ""
// Id de la wallet enlazada con el formulario de sacarla del seguimiento abierto.
let walletsSegDirSacando = ""
// Clave de la fila desplegada. Solo una a la vez: el detalle es alto y la lista,
// un cajón con scroll en el que varias abiertas harían perder de vista las demás.
let walletsSegDirAbierta = ""

// Trazos de 24x24; el color y el tamaño los pone el CSS del botón.
const WALLETS_SEG_DIR_ICONOS = {
    ver: "M5 12h14M13 6l6 6-6 6",
    mover: "M7 4v14M3 14l4 4 4-4M17 20V6M13 10l4-4 4 4",
    editar: "M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4",
    sacar: "M14 4h5v16h-5M10 8l-4 4 4 4M6 12h9",
    vincular: "M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1",
    cambiar: "M4 8h13M13 4l4 4-4 4M20 16H7M11 12l-4 4 4 4",
    quitar: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
    leer: "M20 11a8 8 0 0 0-14-4L4 9M4 4v5h5M4 13a8 8 0 0 0 14 4l2-2M20 20v-5h-5"
}

/**
 * Pinta un botón de acción de la libreta.
 *
 * @param {{clase: string, icono: string, texto: string, datos?: string, variante?: string}} opciones
 *     `clase` es la que busca el manejador de clics, `datos` son atributos ya
 *     escapados y `variante` («principal» o «peligro») marca su peso visual.
 * @returns {string} El HTML del botón.
 */
function walletsSegDirBotonHtml({ clase, icono, texto, datos = "", variante = "" }) {
    const claseVariante = variante ? ` walletsSegDirAccion-${variante}` : ""
    return `<button type="button" class="walletsSegDirAccion${claseVariante} ${clase}" ${datos}>
            <svg class="walletsSegDirIcono" viewBox="0 0 24 24" aria-hidden="true"><path d="${WALLETS_SEG_DIR_ICONOS[icono]}"></path></svg>
            <span>${escapeHtml(texto)}</span>
        </button>`
}

function walletsSegDirEntradas() {
    const manuales = (walletsEstado.direcciones || []).map((d) => ({ ...d, enlazada: false, texto: d.direccion }))
    const enlazadas = (walletsEstado.direccionesEnlazadas || []).map((d) => {
        // Una xpub o una clave pública aporta varias filas con el mismo walletId.
        const clave = d.clave || d.walletId
        return {
            red: d.red,
            apodo: d.apodo,
            propia: true,
            enlazada: true,
            derivada: Boolean(d.derivada),
            walletId: d.walletId,
            clave,
            completa: walletsSegDirCompletas.has(clave),
            texto: walletsSegDirCompletas.get(clave) || d.valorEnmascarado
        }
    })
    return [...manuales, ...enlazadas]
}

function walletsSegDirClaveSaldo(red, direccion) {
    return `${red}:${direccion}`
}

// El saldo guardado de la wallet enlazada (el que lee la vigilancia) más los
// tokens ya leídos en el detalle, sin las imitaciones.
function walletsSegDirSaldoEnlazadaHtml(entrada) {
    const wallet = walletsEstado.wallets.find((w) => w.id === entrada.walletId)
    if (!wallet?.saldoFecha) return `<span class="walletsSegDirSaldo walletsSegDato">Saldo sin leer todavía</span>`
    const simbolo = walletsSegRed(wallet)?.simbolo || wallet.red
    const partes = [`${walletsSegNumero(wallet.saldo || "0")} ${simbolo}`]
    for (const token of walletsSegTokensLeidos.get(wallet.id) || []) {
        if (!parseLooseNumber(token.cantidad) || walletsSegEstadoToken(token, wallet.red) === "imitacion") continue
        partes.push(`${walletsSegNumero(token.cantidad)} ${token.simbolo}`)
    }
    const euros = walletsSegEuros(wallet.valorEur)
    return `
        <span class="walletsSegDirSaldo" title="Leído ${escapeHtml(walletsSegFecha(wallet.saldoFecha))}">
            <strong>${escapeHtml(partes.join(" · "))}</strong>${euros ? ` <span class="walletsSegDato">≈ ${escapeHtml(euros)}</span>` : ""}
        </span>`
}

function walletsSegDirSaldoManualHtml(entrada, datosBoton) {
    const leido = walletsSegDirSaldos.get(walletsSegDirClaveSaldo(entrada.red, entrada.direccion))
    if (leido?.cargando) return `<span class="walletsSegDirSaldo walletsSegDato">Leyendo el saldo…</span>`
    if (!leido) {
        return `<span class="walletsSegDirSaldo">${walletsSegDirBotonHtml({ clase: "walletsSegDirSaldoBtn", icono: "leer", texto: "Ver saldo", datos: datosBoton })}</span>`
    }
    return `
        <span class="walletsSegDirSaldo" title="Leído ${escapeHtml(walletsSegFecha(leido.fecha))}">
            <strong>${escapeHtml(`${walletsSegNumero(leido.saldo)} ${leido.simbolo}`)}</strong>
            ${walletsSegDirBotonHtml({ clase: "walletsSegDirSaldoBtn", icono: "leer", texto: "Volver a leer", datos: datosBoton })}
        </span>`
}

// El importe de la fila plegada: solo la moneda de la red, los tokens van en el detalle.
function walletsSegDirImporteHtml(entrada) {
    const pintar = (cantidad, euros = "") => `
        <span class="walletsSegDirImporte">
            <strong>${escapeHtml(cantidad)}</strong>
            ${euros ? `<span class="walletsSegDato">≈ ${escapeHtml(euros)}</span>` : ""}
        </span>`
    const aparte = (texto) => `<span class="walletsSegDirImporte walletsSegDato">${escapeHtml(texto)}</span>`
    if (entrada.derivada) return aparte("Dentro de su wallet")
    if (entrada.enlazada) {
        const wallet = walletsEstado.wallets.find((w) => w.id === entrada.walletId)
        if (!wallet?.saldoFecha) return aparte("Sin leer")
        const simbolo = walletsSegRed(wallet)?.simbolo || wallet.red
        return pintar(`${walletsSegNumero(wallet.saldo || "0")} ${simbolo}`, walletsSegEuros(wallet.valorEur))
    }
    const leido = walletsSegDirSaldos.get(walletsSegDirClaveSaldo(entrada.red, entrada.direccion))
    if (leido?.cargando) return aparte("Leyendo…")
    return leido ? pintar(`${walletsSegNumero(leido.saldo)} ${leido.simbolo}`) : ""
}

function walletsSegDirValorHtml(entrada) {
    if (entrada.enlazada && !entrada.completa) {
        return `<span class="walletsSegMovValor" title="Enmascarada: «Ver completas» la muestra con la contraseña">${escapeHtml(entrada.texto)}</span>`
    }
    return `<code class="walletsSegCopiable walletsSegMovValor" data-full-value="${escapeHtml(entrada.texto)}" title="Haz clic para copiarla">${escapeHtml(entrada.texto)}</code>`
}

// El apodo de una enlazada es el nombre de su seguimiento: editarlo lo renombra.
function walletsSegDirApodoEnlazadaHtml(entrada) {
    return `
        <form class="walletsSegDirApodoForm" data-wallet-id="${escapeHtml(entrada.walletId)}">
            <input type="text" class="assetRowModalInput walletsSegDirApodoInput" maxlength="60" autocomplete="off"
                aria-label="Nombre del seguimiento" value="${escapeHtml(entrada.apodo)}">
            <button type="submit" class="primaryButton" data-no-autohide="true">Guardar</button>
            <button type="button" class="cancelButton walletsSegDirApodoCancelarBtn">Cancelar</button>
            <p class="walletsSegDato">Cambia el nombre del seguimiento «${escapeHtml(entrada.apodo)}» y de todas sus wallets.</p>
        </form>`
}

function walletsSegDirClaveVinculo(entrada) {
    return entrada.enlazada ? entrada.walletId : walletsSegDirClaveSaldo(entrada.red, entrada.texto)
}

// Los seguimientos a los que puede ir una dirección propia: el servidor no deja
// mezclarla con ajenas, así que esos ni se sugieren.
function walletsSegDirSugerenciasHtml(claveActual = "") {
    return walletsGruposSeguimiento()
        .filter((grupo) => grupo.propia && grupo.clave !== claveActual)
        .map((grupo) => `<option value="${escapeHtml(grupo.nombre)}"></option>`)
        .join("")
}

function walletsSegDirSelectorActivoHtml(red) {
    const sugerido = walletsActivoSugerido(red)
    const opciones = walletsActivosCripto().map(
        (asset) =>
            `<option value="${escapeHtml(asset.id)}"${asset.id === sugerido ? " selected" : ""}>${escapeHtml(asset.name || asset.symbol || asset.id)}</option>`
    )
    return `
        <select class="assetRowModalSelect walletsSegDirVinculoActivo" name="assetId" aria-label="Cripto en Activos">
            <option value="">Elige la cripto de Activos</option>
            ${opciones.join("")}
        </select>`
}

function walletsSegDirVinculoHtml(entrada) {
    const wallet = entrada.enlazada ? walletsEstado.wallets.find((w) => w.id === entrada.walletId) : null
    const listaId = "walletsSegDirSeguimientos"
    return `
        <form class="walletsSegDirVinculoForm" data-red="${escapeHtml(entrada.red)}" ${
            entrada.enlazada
                ? `data-wallet-id="${escapeHtml(entrada.walletId)}"`
                : `data-direccion="${escapeHtml(entrada.texto)}"`
        }>
            <input type="text" class="assetRowModalInput walletsSegDirVinculoInput" name="seguimiento" maxlength="60" required autocomplete="off"
                list="${listaId}" aria-label="Seguimiento" placeholder="Seguimiento, nuevo o existente">
            <datalist id="${listaId}">${walletsSegDirSugerenciasHtml(wallet?.seguimientoClave)}</datalist>
            ${entrada.enlazada ? "" : walletsSegDirSelectorActivoHtml(entrada.red)}
            <button type="submit" class="primaryButton" data-no-autohide="true">${entrada.enlazada ? "Mover" : "Vincular"}</button>
            <button type="button" class="cancelButton walletsSegDirVinculoCancelarBtn">Cancelar</button>
            <p class="walletsSegDato">${
                entrada.enlazada
                    ? "Conserva sus lecturas y avisos."
                    : "Pasará a vigilarse y a sumar al total, y entrará en la Watchlist y en Sincronizar."
            }</p>
        </form>`
}

// Con contraseña porque la libreta enseña la dirección entera (ver routes/wallets.py).
function walletsSegDirSacarHtml(entrada) {
    return `
        <form class="walletsSegDirVinculoForm walletsSegDirSacarForm" data-wallet-id="${escapeHtml(entrada.walletId)}">
            <input type="password" class="assetRowModalInput" name="currentPassword" required autocomplete="current-password"
                aria-label="Contraseña de acceso a la web" placeholder="Contraseña de acceso a la web">
            <button type="submit" class="dangerButton" data-no-autohide="true">Sacar</button>
            <button type="button" class="cancelButton walletsSegDirVinculoCancelarBtn">Cancelar</button>
            <p class="walletsSegDato">Dejará de vigilarse y de sumar al total, y perderá sus lecturas y avisos. Seguirá en la libreta como dirección tuya, y lo ya importado se queda en Transacciones.</p>
        </form>`
}

function walletsSegDirAccionesHtml(entrada) {
    if (walletsSegDirVinculando && walletsSegDirVinculando === walletsSegDirClaveVinculo(entrada)) {
        return walletsSegDirVinculoHtml(entrada)
    }
    // Sale de su xpub o clave pública: se gestiona desde esa wallet, no suelta.
    if (entrada.derivada) {
        return `<div class="walletsSegDirAcciones">
                ${walletsSegDirBotonHtml({ clase: "walletsSegDirVerSeguimientoBtn", icono: "ver", texto: "Ver seguimiento", datos: `data-wallet-id="${escapeHtml(entrada.walletId)}"`, variante: "principal" })}
            </div>`
    }
    if (entrada.enlazada) {
        if (walletsSegDirSacando === entrada.walletId) return walletsSegDirSacarHtml(entrada)
        if (walletsSegDirEditando === entrada.walletId) return walletsSegDirApodoEnlazadaHtml(entrada)
        const datos = `data-wallet-id="${escapeHtml(entrada.walletId)}"`
        return `<div class="walletsSegDirAcciones">
                ${walletsSegDirBotonHtml({ clase: "walletsSegDirVerSeguimientoBtn", icono: "ver", texto: "Ver seguimiento", datos, variante: "principal" })}
                ${walletsSegDirBotonHtml({ clase: "walletsSegDirMoverBtn", icono: "mover", texto: "Cambiar de seguimiento", datos })}
                ${walletsSegDirBotonHtml({ clase: "walletsSegDirEditarEnlazadaBtn", icono: "editar", texto: "Editar apodo", datos })}
                ${walletsSegDirBotonHtml({ clase: "walletsSegDirSacarBtn", icono: "sacar", texto: "Sacar del seguimiento", datos, variante: "peligro" })}
            </div>`
    }
    const datos = `data-red="${escapeHtml(entrada.red)}" data-direccion="${escapeHtml(entrada.texto)}"`
    return `<div class="walletsSegDirAcciones">
                ${entrada.propia ? walletsSegDirBotonHtml({ clase: "walletsSegDirVincularBtn", icono: "vincular", texto: "Vincular a seguimiento", datos, variante: "principal" }) : ""}
                ${walletsSegDirBotonHtml({ clase: "walletsSegDirEditarBtn", icono: "editar", texto: "Editar", datos })}
                ${walletsSegDirBotonHtml({ clase: "walletsSegDirCambiarBtn", icono: "cambiar", texto: entrada.propia ? "Es ajena" : "Es mía", datos })}
                ${walletsSegDirBotonHtml({ clase: "walletsSegDirQuitarBtn", icono: "quitar", texto: "Quitar", datos, variante: "peligro" })}
            </div>`
}

// Identifica la fila en la lista: una xpub aporta varias con el mismo walletId.
function walletsSegDirClaveFila(entrada) {
    return entrada.enlazada ? entrada.clave || entrada.walletId : walletsSegDirClaveSaldo(entrada.red, entrada.texto)
}

// `tamano` («doble» o «ancho») es cuántas columnas de la rejilla ocupa el dato.
function walletsSegDirDatoHtml(etiqueta, valorHtml, tamano = "") {
    return `<div class="walletsSegDirDato${tamano ? ` walletsSegDirDato-${tamano}` : ""}"><dt>${escapeHtml(etiqueta)}</dt><dd>${valorHtml}</dd></div>`
}

// Las enmascaradas avisan a la vista de cómo verlas: en la fila plegada no se copia.
function walletsSegDirDireccionDetalleHtml(entrada) {
    const pista =
        entrada.enlazada && !entrada.completa
            ? `<span class="walletsSegDato">Enmascarada: «Ver completas» la muestra con la contraseña</span>`
            : `<span class="walletsSegDato">Haz clic para copiarla</span>`
    return `${walletsSegDirValorHtml(entrada)}${pista}`
}

// Red, apodo y seguimiento ya están en el resumen de la fila: aquí solo lo que falta.
function walletsSegDirDatosEnlazadaHtml(entrada, wallet) {
    // El saldo guardado es el de toda la xpub o clave, no el de esta dirección.
    const saldo = entrada.derivada
        ? `<span class="walletsSegDirSaldo walletsSegDato">Su saldo cuenta en el de la wallet</span>`
        : walletsSegDirSaldoEnlazadaHtml(entrada)
    const base = [
        walletsSegDirDatoHtml(
            entrada.derivada ? "Dirección derivada" : "Dirección",
            walletsSegDirDireccionDetalleHtml(entrada),
            "doble"
        ),
        walletsSegDirDatoHtml("Saldo", saldo)
    ]
    if (!wallet) return base.join("")
    return [
        ...base,
        walletsSegDirDatoHtml("Wallet", escapeHtml(wallet.alias)),
        walletsSegDirDatoHtml("Tipo", escapeHtml(walletsTipoLargo(wallet.tipo))),
        walletsSegDirDatoHtml("Cripto en Activos", walletsSegActivoNativaHtml(wallet)),
        walletsSegDirDatoHtml("Último movimiento", escapeHtml(walletsSegFecha(wallet.ultimoMovimiento))),
        walletsSegDirDatoHtml("Saldo leído", escapeHtml(walletsSegFecha(wallet.saldoFecha))),
        walletsSegDirDatoHtml("Avisos", wallet.avisos ? "Activados" : "Desactivados"),
        walletsSegDirDatoHtml("Enlazada", escapeHtml(walletsSegFecha(wallet.creada))),
        walletsSegDirDatoHtml("Última importación", escapeHtml(walletsSegFecha(wallet.ultimaSincronizacion)))
    ].join("")
}

function walletsSegDirDatosManualHtml(entrada) {
    const datosBoton = `data-red="${escapeHtml(entrada.red)}" data-direccion="${escapeHtml(entrada.texto)}"`
    return [
        walletsSegDirDatoHtml("Dirección", walletsSegDirDireccionDetalleHtml(entrada), "doble"),
        walletsSegDirDatoHtml("Saldo", walletsSegDirSaldoManualHtml(entrada, datosBoton)),
        walletsSegDirDatoHtml(
            "Qué hace",
            entrada.propia
                ? "Clasifica movimientos como propios. No se vigila ni suma al total hasta vincularla."
                : "Solo pone nombre a la contraparte en el historial y los avisos.",
            "ancho"
        )
    ].join("")
}

// Lo leído por la vigilancia, de la wallet entera aunque la fila sea una derivada.
function walletsSegDirActividadHtml(entrada, wallet) {
    if (!wallet) return ""
    const titulo = entrada.derivada ? "Últimos movimientos de toda la wallet" : "Últimos movimientos"
    return `
        <section class="walletsSegDirActividad">
            <h4 class="walletsSegDirSubtitulo">${titulo}</h4>
            ${walletsSegMovimientosHtml({ wallets: [wallet] })}
        </section>`
}

// Alertas arriba y acciones antes que los movimientos: el cajón de la lista es
// bajo y lo que se lee o se pulsa primero no debe exigir scroll.
function walletsSegDirDetalleHtml(entrada) {
    const wallet = entrada.enlazada ? walletsEstado.wallets.find((w) => w.id === entrada.walletId) : null
    const datos = entrada.enlazada
        ? walletsSegDirDatosEnlazadaHtml(entrada, wallet)
        : walletsSegDirDatosManualHtml(entrada)
    return `
        <div class="walletsSegDirDetalle">
            ${wallet ? walletsSegAlertasHtml([wallet]) : ""}
            <dl class="walletsSegDirDatos">${datos}</dl>
            ${walletsSegDirAccionesHtml(entrada)}
            ${walletsSegDirActividadHtml(entrada, wallet)}
        </div>`
}

function walletsSegDirMarcasHtml(entrada) {
    const titular = `<span class="walletsSegDirMarca walletsSegDirMarca-${entrada.propia ? "propia" : "ajena"}">${entrada.propia ? "Mía" : "Ajena"}</span>`
    if (entrada.derivada)
        return `${titular}<span class="walletsSegDirMarca" title="Dirección de una xpub o clave pública enlazada">De su clave pública</span>`
    if (entrada.enlazada) return `${titular}<span class="walletsSegDirMarca">En seguimiento</span>`
    if (entrada.propia)
        return `${titular}<span class="walletsSegDirMarca" title="Solo clasifica movimientos: no se vigila ni suma al total hasta vincularla">Sin seguimiento</span>`
    return titular
}

function walletsSegDirFilaHtml(entrada) {
    const red = walletsEstado.redes.find((r) => r.clave === entrada.red)
    const nombreRed = red?.nombre || entrada.red
    const clave = walletsSegDirClaveFila(entrada)
    const abierta = walletsSegDirAbierta === clave
    // Plegada se abrevia para que la fila no salte de línea; «Ver completas» manda.
    const direccion = entrada.completa ? entrada.texto : walletsSegAbreviar(entrada.texto)
    return `
        <li class="walletsSegDirFila${abierta ? " walletsSegDirFila-abierta" : ""}">
            <button type="button" class="walletsSegDirResumen" data-clave="${escapeHtml(clave)}" aria-expanded="${abierta}">
                <span class="walletsSegDirSimbolo">${escapeHtml(red?.simbolo || entrada.red)}</span>
                <span class="walletsSegDirIdentidad">
                    <span class="walletsSegDirCabecera">
                        <strong class="walletsSegDirApodo">${escapeHtml(entrada.apodo || "Sin apodo")}</strong>
                        ${walletsSegDirMarcasHtml(entrada)}
                    </span>
                    <span class="walletsSegDirLinea">
                        <span class="walletsSegDirLineaDireccion">${escapeHtml(direccion)}</span>
                        <span aria-hidden="true">·</span>
                        <span>${escapeHtml(nombreRed)}</span>
                    </span>
                </span>
                ${walletsSegDirImporteHtml(entrada)}
                <span class="walletsSegDirFlecha" aria-hidden="true"></span>
            </button>
            ${abierta ? walletsSegDirDetalleHtml(entrada) : ""}
        </li>`
}

// Pliega o despliega una fila. Los formularios a medias se descartan: al repintar
// reaparecerían en una fila que el usuario ya ha dejado atrás.
function alternarFilaLibreta(clave, overlay) {
    walletsSegDirAbierta = walletsSegDirAbierta === clave ? "" : clave
    walletsSegDirEditando = ""
    walletsSegDirVinculando = ""
    walletsSegDirSacando = ""
    renderLibretaSeguimiento()
    // Repintar destruye el botón pulsado: sin esto el teclado volvería al principio.
    const boton = [...overlay.querySelectorAll(".walletsSegDirResumen")].find((b) => b.dataset.clave === clave)
    if (!boton) return
    boton.focus({ preventScroll: true })
    boton.closest(".walletsSegDirFila").scrollIntoView({ block: "nearest" })
}

function renderLibretaSeguimiento() {
    const lista = document.querySelector("#walletsSegDirOverlay .walletsSegDirLista")
    if (!lista) return
    const busqueda = walletsSegDirBusqueda.trim().toLowerCase()
    const entradas = walletsSegDirEntradas().filter(
        (entrada) => !busqueda || `${entrada.apodo} ${entrada.texto}`.toLowerCase().includes(busqueda)
    )
    lista.innerHTML = entradas.length
        ? entradas.map(walletsSegDirFilaHtml).join("")
        : `<li class="walletsSegDirVacia">${busqueda ? "Ninguna dirección coincide con la búsqueda." : "Aún no has marcado ninguna dirección."}</li>`
    const verBtn = document.querySelector("#walletsSegDirOverlay .walletsSegDirVerBtn")
    if (verBtn) {
        verBtn.classList.toggle("hidden", !(walletsEstado.direccionesEnlazadas || []).length)
        verBtn.textContent = walletsSegDirCompletas.size ? "Ocultar" : "Ver completas"
    }
}

function abrirLibretaSeguimiento() {
    cerrarLibretaSeguimiento()
    const redes = walletsEstado.redes
        .map((red) => `<option value="${escapeHtml(red.clave)}">${escapeHtml(red.nombre)}</option>`)
        .join("")
    const overlay = document.createElement("div")
    overlay.id = "walletsSegDirOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"
    overlay.innerHTML = `
        <div class="assetModal assetRowModal walletsSegDirModal" role="dialog" aria-modal="true" aria-labelledby="walletsSegDirTitulo">
            <h3 id="walletsSegDirTitulo" class="assetModalTitle assetRowModalTitle">Direcciones</h3>
            <p class="walletsSegDato">Marca qué direcciones son tuyas y cuáles ajenas, y ponles un apodo. Lo enviado a una tuya o recibido de ella cuenta como «${escapeHtml(WALLETS_SEG_TIPOS.entre_wallet)}» en el historial, en los avisos y en Transacciones. Las direcciones de tus wallets enlazadas ya cuentan como tuyas. Vincula una dirección tuya a un seguimiento para vigilarla y sumar su saldo al total.</p>
            <form class="walletsSegDirForm">
                <select class="assetRowModalSelect" name="red" aria-label="Red">${redes}</select>
                <input class="assetRowModalInput" name="direccion" placeholder="Dirección" aria-label="Dirección" required autocomplete="off" spellcheck="false">
                <input class="assetRowModalInput" name="apodo" placeholder="Apodo (opcional)" aria-label="Apodo" maxlength="60" autocomplete="off">
                <select class="assetRowModalSelect" name="propia" aria-label="De quién es">
                    <option value="true">Mía</option>
                    <option value="false">Ajena</option>
                </select>
                <button type="submit" class="primaryButton" data-no-autohide="true">Guardar</button>
            </form>
            <div class="walletsSegDirHerramientas">
                <input type="search" class="assetRowModalInput walletsSegDirBuscar" placeholder="Buscar por apodo o dirección" aria-label="Buscar por apodo o dirección" value="${escapeHtml(walletsSegDirBusqueda)}">
                <button type="button" class="cancelButton walletsSegDirVerBtn">Ver completas</button>
            </div>
            <form class="walletsVerCompletas walletsSegDirVerForm hidden">
                <input class="assetRowModalInput walletsSegDirVerClave" type="password" autocomplete="current-password" aria-label="Contraseña de acceso a la web" placeholder="Contraseña de acceso a la web">
                <button type="submit" class="primaryButton" data-no-autohide="true">Mostrar</button>
            </form>
            <ul class="walletsSegDirLista"></ul>
            <div class="assetRowModalFooter">
                <button type="button" class="primaryButton walletsSegDirCerrarBtn">Cerrar</button>
            </div>
        </div>`
    document.body.appendChild(overlay)
    renderLibretaSeguimiento()

    const form = overlay.querySelector(".walletsSegDirForm")
    form.addEventListener("submit", async (event) => {
        event.preventDefault()
        const datos = await guardarDireccionLibreta("/api/wallets/direcciones/guardar", {
            red: form.elements.red.value,
            direccion: form.elements.direccion.value,
            apodo: form.elements.apodo.value,
            propia: form.elements.propia.value === "true"
        })
        if (datos) form.reset()
    })
    overlay.querySelector(".walletsSegDirBuscar").addEventListener("input", (event) => {
        walletsSegDirBusqueda = event.target.value
        renderLibretaSeguimiento()
    })
    overlay.querySelector(".walletsSegDirVerForm").addEventListener("submit", (event) => {
        event.preventDefault()
        mostrarDireccionesCompletas(event.target)
    })
    // Delegado: el formulario del apodo se crea y se destruye con cada repintado.
    overlay.querySelector(".walletsSegDirLista").addEventListener("submit", (event) => {
        if (event.target.classList.contains("walletsSegDirSacarForm")) {
            event.preventDefault()
            sacarDeSeguimiento(event.target)
            return
        }
        if (event.target.classList.contains("walletsSegDirVinculoForm")) {
            event.preventDefault()
            guardarVinculoDireccion(event.target)
            return
        }
        if (!event.target.classList.contains("walletsSegDirApodoForm")) return
        event.preventDefault()
        guardarApodoEnlazada(event.target)
    })
    overlay.addEventListener("click", (event) => manejarClickLibreta(event, overlay, form))
    document.addEventListener("keydown", walletsSegTeclaLibreta)
    form.elements.direccion.focus()
}

function alternarDireccionesCompletas(overlay) {
    if (walletsSegDirCompletas.size) {
        walletsSegDirCompletas.clear()
        renderLibretaSeguimiento()
        return
    }
    const formulario = overlay.querySelector(".walletsSegDirVerForm")
    formulario.classList.toggle("hidden")
    if (!formulario.classList.contains("hidden")) formulario.querySelector(".walletsSegDirVerClave").focus()
}

async function mostrarDireccionesCompletas(formulario) {
    const campo = formulario.querySelector(".walletsSegDirVerClave")
    const contrasena = campo.value
    if (!contrasena) {
        showToast("Escribe la contraseña de acceso a la web", { type: "error" })
        return
    }
    const enviar = formulario.querySelector("button[type=submit]")
    enviar.disabled = true
    try {
        const { valores } = await walletsPost("/api/wallets/direcciones/ver-completas", { currentPassword: contrasena })
        for (const [walletId, valor] of Object.entries(valores || {})) walletsSegDirCompletas.set(walletId, valor)
        formulario.classList.add("hidden")
        renderLibretaSeguimiento()
    } catch (error) {
        showToast(error.message || "No se pudieron mostrar", { type: "error" })
    } finally {
        // La contraseña no se queda en el campo ni aunque falle.
        campo.value = ""
        if (enviar.isConnected) enviar.disabled = false
    }
}

async function leerSaldoDireccion(red, direccion) {
    const clave = walletsSegDirClaveSaldo(red, direccion)
    walletsSegDirSaldos.set(clave, { cargando: true })
    renderLibretaSeguimiento()
    try {
        const datos = await walletsPost("/api/wallets/direcciones/saldo", { red, direccion })
        walletsSegDirSaldos.set(clave, { saldo: datos.saldo, simbolo: datos.simbolo, fecha: new Date().toISOString() })
    } catch (error) {
        walletsSegDirSaldos.delete(clave)
        showToast(error.message || "No se pudo leer el saldo", { type: "error" })
    }
    renderLibretaSeguimiento()
}

async function guardarApodoEnlazada(formulario) {
    const wallet = walletsEstado.wallets.find((w) => w.id === formulario.dataset.walletId)
    const nombre = formulario.querySelector(".walletsSegDirApodoInput").value.trim()
    if (!wallet) return
    if (!nombre) {
        showToast("Pon el nombre del seguimiento", { type: "error" })
        return
    }
    if (nombre === wallet.seguimiento) {
        walletsSegDirEditando = ""
        renderLibretaSeguimiento()
        return
    }
    formulario.querySelectorAll("button").forEach((boton) => (boton.disabled = true))
    try {
        const { wallets } = await walletsPost("/api/wallets/seguimientos/renombrar", {
            clave: wallet.seguimientoClave,
            nombre
        })
        walletsSegDirEditando = ""
        await walletsSegAlCambiar({ renombrado: { de: wallet.seguimientoClave, a: wallets[0]?.seguimientoClave } })
        showToast("Apodo guardado", { type: "success" })
    } catch (error) {
        showToast(error.message || "No se pudo cambiar el apodo", { type: "error" })
    }
    renderLibretaSeguimiento()
}

function walletsSegDirToastVinculo(texto, datos) {
    if (datos.avisoReetiquetado) {
        showToast(datos.avisoReetiquetado, { type: "error", duration: 8000 })
        return
    }
    const extra = datos.reetiquetadas ? ` · ${datos.reetiquetadas} movimientos actualizados en Transacciones` : ""
    showToast(`${texto}${extra}`, { type: "success" })
}

// Vincula una dirección marcada o mueve una enlazada. Lo escrito se conserva si
// falla, para corregir el nombre sin volver a abrir el formulario.
async function guardarVinculoDireccion(formulario) {
    const { red, direccion, walletId } = formulario.dataset
    const seguimiento = formulario.elements.seguimiento.value.trim()
    const assetId = formulario.elements.assetId?.value
    if (!seguimiento || (!walletId && !assetId)) {
        showToast(seguimiento ? "Elige la cripto de Activos" : "Pon el nombre del seguimiento", { type: "error" })
        return
    }
    formulario.querySelectorAll("button").forEach((boton) => (boton.disabled = true))
    let datos
    try {
        datos = walletId
            ? await walletsPost(`/api/wallets/${encodeURIComponent(walletId)}/seguimiento`, { seguimiento })
            : await walletsPost("/api/wallets/direcciones/vincular", { red, direccion, assetId, seguimiento })
    } catch (error) {
        showToast(error.message || "No se pudo guardar", { type: "error" })
        formulario.querySelectorAll("button").forEach((boton) => (boton.disabled = false))
        return
    }
    walletsSegDirVinculando = ""
    if (!walletId) walletsSegDirSaldos.delete(walletsSegDirClaveSaldo(red, direccion))
    await cargarWalletsSeguimiento()
    renderLibretaSeguimiento()
    walletsSegDirToastVinculo(`Dirección en «${datos.wallet.seguimiento}»`, datos)
    if (walletId) return
    await actualizarWalletSeguimiento(datos.wallet.id)
    renderLibretaSeguimiento()
}

async function sacarDeSeguimiento(formulario) {
    const campo = formulario.elements.currentPassword
    const contrasena = campo.value
    if (!contrasena) {
        showToast("Escribe la contraseña de acceso a la web", { type: "error" })
        return
    }
    const botones = formulario.querySelectorAll("button")
    botones.forEach((boton) => (boton.disabled = true))
    try {
        const datos = await walletsPost(`/api/wallets/${encodeURIComponent(formulario.dataset.walletId)}/a-libreta`, {
            currentPassword: contrasena
        })
        walletsSegDirSacando = ""
        await cargarWalletsSeguimiento()
        renderLibretaSeguimiento()
        walletsSegDirToastVinculo("Dirección devuelta a la libreta", datos)
    } catch (error) {
        showToast(error.message || "No se pudo sacar del seguimiento", { type: "error" })
        botones.forEach((boton) => (boton.disabled = false))
    } finally {
        // La contraseña no se queda en el campo ni aunque falle.
        campo.value = ""
    }
}

// Las acciones que relacionan una fila con su seguimiento. Devuelve si había alguna.
function manejarClickVinculoLibreta(event, overlay) {
    const vincular = event.target.closest(".walletsSegDirVincularBtn")
    const mover = event.target.closest(".walletsSegDirMoverBtn")
    if (vincular || mover) {
        walletsSegDirEditando = ""
        walletsSegDirSacando = ""
        walletsSegDirVinculando = vincular
            ? walletsSegDirClaveSaldo(vincular.dataset.red, vincular.dataset.direccion)
            : mover.dataset.walletId
        renderLibretaSeguimiento()
        overlay.querySelector(".walletsSegDirVinculoInput")?.focus()
        return true
    }
    if (event.target.closest(".walletsSegDirVinculoCancelarBtn")) {
        walletsSegDirVinculando = ""
        walletsSegDirSacando = ""
        renderLibretaSeguimiento()
        return true
    }
    const ver = event.target.closest(".walletsSegDirVerSeguimientoBtn")
    if (ver) {
        const clave = walletsEstado.wallets.find((w) => w.id === ver.dataset.walletId)?.seguimientoClave
        cerrarLibretaSeguimiento()
        if (clave) abrirDetalleSeguimiento(clave)
        return true
    }
    const sacar = event.target.closest(".walletsSegDirSacarBtn")
    if (sacar) {
        walletsSegDirEditando = ""
        walletsSegDirVinculando = ""
        walletsSegDirSacando = sacar.dataset.walletId
        renderLibretaSeguimiento()
        overlay.querySelector(".walletsSegDirSacarForm input")?.focus()
        return true
    }
    return false
}

function manejarClickLibreta(event, overlay, form) {
    if (event.target === overlay || event.target.closest(".walletsSegDirCerrarBtn")) {
        cerrarLibretaSeguimiento()
        return
    }
    if (event.target.closest(".walletsSegDirVerBtn")) {
        alternarDireccionesCompletas(overlay)
        return
    }
    const resumen = event.target.closest(".walletsSegDirResumen")
    if (resumen) {
        alternarFilaLibreta(resumen.dataset.clave, overlay)
        return
    }
    if (manejarClickVinculoLibreta(event, overlay)) return
    const editarEnlazada = event.target.closest(".walletsSegDirEditarEnlazadaBtn")
    if (editarEnlazada) {
        walletsSegDirVinculando = ""
        walletsSegDirSacando = ""
        walletsSegDirEditando = editarEnlazada.dataset.walletId
        renderLibretaSeguimiento()
        overlay.querySelector(".walletsSegDirApodoInput")?.focus()
        return
    }
    if (event.target.closest(".walletsSegDirApodoCancelarBtn")) {
        walletsSegDirEditando = ""
        renderLibretaSeguimiento()
        return
    }
    const verSaldo = event.target.closest(".walletsSegDirSaldoBtn")
    if (verSaldo) {
        leerSaldoDireccion(verSaldo.dataset.red, verSaldo.dataset.direccion)
        return
    }
    const boton = event.target.closest("[data-direccion]")
    const entrada = boton && walletsSegDireccionManual(boton.dataset.red, boton.dataset.direccion)
    if (entrada && boton.classList.contains("walletsSegDirEditarBtn")) {
        form.elements.red.value = entrada.red
        form.elements.direccion.value = entrada.direccion
        form.elements.apodo.value = entrada.apodo
        form.elements.propia.value = String(entrada.propia)
        form.elements.apodo.focus()
        return
    }
    if (entrada && boton.classList.contains("walletsSegDirCambiarBtn")) {
        guardarDireccionLibreta("/api/wallets/direcciones/guardar", { ...entrada, propia: !entrada.propia })
        return
    }
    if (entrada && boton.classList.contains("walletsSegDirQuitarBtn")) {
        guardarDireccionLibreta("/api/wallets/direcciones/olvidar", { red: entrada.red, direccion: entrada.direccion })
        return
    }
    const copiable = event.target.closest(".walletsSegCopiable")
    if (copiable && typeof copyHashTransaccionToClipboard === "function") copyHashTransaccionToClipboard(copiable)
}

function walletsSegTeclaLibreta(event) {
    if (event.key !== "Escape") return
    // Escape en el apodo que se edita cancela la edición, no cierra la libreta.
    if (walletsSegDirEditando && event.target.closest?.(".walletsSegDirApodoForm")) {
        walletsSegDirEditando = ""
        renderLibretaSeguimiento()
        return
    }
    if (event.target.closest?.(".walletsSegDirVinculoForm")) {
        walletsSegDirVinculando = ""
        walletsSegDirSacando = ""
        renderLibretaSeguimiento()
        return
    }
    cerrarLibretaSeguimiento()
}

function cerrarLibretaSeguimiento() {
    document.removeEventListener("keydown", walletsSegTeclaLibreta)
    document.getElementById("walletsSegDirOverlay")?.remove()
    walletsSegDirCompletas.clear()
    walletsSegDirEditando = ""
    walletsSegDirVinculando = ""
    walletsSegDirSacando = ""
    walletsSegDirAbierta = ""
}
