// Wallets desde los modales de Nuevo y Editar activo, cuando el activo es cripto.
//
// Reutiliza las líneas de la ventana de enlazar (wallets.js) con dos diferencias:
// son siempre propias, porque el activo es de la cartera del usuario, y la cripto
// no se elige, porque es este activo. Como en esa ventana, el valor nunca vuelve
// del servidor y el campo se vacía al enviarlo o al cerrar el modal.
const WALLETS_ACTIVO_MAX_NOMBRE = 60
// Lo que puede seguir al símbolo en un par sin separador: BTCUSDT, BTCEUR… Con un
// margen más largo, SOLVUSDT se tomaría por Solana.
const WALLETS_ACTIVO_LARGOS_DIVISA = new Set([3, 4])

// Cada apertura invalida la carga anterior: si el modal se cierra o se vuelve a
// abrir mientras llega la respuesta, esa respuesta ya no debe pintarse.
let walletsActivoTurno = 0
// El `change` que dispara walletsFijarSelect no es una elección del usuario.
let walletsActivoProponiendo = false

/**
 * Red que corresponde a un activo, comparándolo con las redes del servidor.
 *
 * @param {Array<{clave: string, nombre: string, simbolo: string}>} redes Redes soportadas.
 * @param {string} nombre Nombre del activo.
 * @param {string} ticker Ticker de mercado, como «BINANCE:BTCUSDT» o «BTC-USD».
 * @returns {string} Clave de la red, o "" si no hay ninguna clara (un token como USDT).
 */
function walletsActivoRedSugerida(redes, nombre, ticker) {
    const normalizar = (texto) =>
        String(texto || "")
            .trim()
            .toUpperCase()
    const nombreActivo = normalizar(nombre)
    const base = normalizar(ticker)
        .split(":")
        .pop()
        .split(/[-/_.=]/)[0]
    const porNombre = redes.find((red) => [normalizar(red.nombre), normalizar(red.simbolo)].includes(nombreActivo))
    if (porNombre) return porNombre.clave
    const porTicker = redes.find((red) => {
        const simbolo = normalizar(red.simbolo)
        if (!base.startsWith(simbolo)) return false
        return base === simbolo || WALLETS_ACTIVO_LARGOS_DIVISA.has(base.length - simbolo.length)
    })
    return porTicker?.clave || ""
}

function walletsActivoDeLaCartera(assetId) {
    if (!assetId) return []
    return walletsEstado.wallets.filter((wallet) => wallet.assetId === assetId && wallet.propia !== false)
}

function walletsActivoListaHtml(wallets) {
    if (!wallets.length) return ""
    const nombreRed = (clave) => walletsEstado.redes.find((red) => red.clave === clave)?.nombre || clave
    const filas = wallets
        .map(
            (wallet) => `
            <li>
                <strong>${escapeHtml(walletsNombreCompleto(wallet))}</strong>
                <span>${escapeHtml(nombreRed(wallet.red))} · ${walletsTipoCorto(wallet.tipo)} · <code>${escapeHtml(wallet.valorEnmascarado)}</code></span>
            </li>`
        )
        .join("")
    return `
        <ul class="walletsActivoLista">${filas}</ul>
        <p class="assetModalHint">Para quitarlas, ve a Cripto › Seguimiento.</p>`
}

function walletsActivoFormularioHtml(wallets) {
    return `
        <div class="walletsActivoColumnas">
            <div class="walletsActivoColumna">
                ${walletsActivoListaHtml(wallets)}
                <label class="assetRowModalLabel">Nombre del seguimiento
                    <input class="assetRowModalInput walletsActivoSeguimiento" type="text" maxlength="${WALLETS_ACTIVO_MAX_NOMBRE}" placeholder="Por defecto, el nombre del activo" autocomplete="off" value="${escapeHtml(wallets[0]?.seguimiento || "")}">
                </label>
                <p class="assetModalHint">Solo lectura: nunca pegues una clave privada ni tu frase semilla. Se guardan cifradas como wallets propias y las verás en Cripto › Seguimiento.</p>
            </div>
            <div class="walletsActivoColumna">
                <ul class="walletsFilas walletsActivoFilas">${walletsFilaHtml({ conActivo: false })}</ul>
                <button type="button" class="cancelButton walletsAnadirFilaBtn walletsActivoAnadirBtn">+ Añadir otra wallet</button>
                <label class="assetRowModalLabel walletsActivoEtherscan hidden">Clave de API de Etherscan (gratuita para ETH; BNB requiere plan de pago o NodeReal, en Ajustes › API)
                    <input class="assetRowModalInput walletsActivoEtherscanValor" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
                </label>
            </div>
        </div>`
}

function walletsActivoFilas(bloque) {
    return [...bloque.querySelectorAll(".walletsFila")]
}

function walletsActivoFilasConValor(bloque) {
    if (!bloque || bloque.classList.contains("hidden")) return []
    return walletsActivoFilas(bloque).filter((fila) => walletsDatosFila(fila).valor)
}

function walletsActivoActualizarEtherscan(bloque) {
    const hace = walletsActivoFilas(bloque).some((fila) =>
        WALLETS_REDES_ETHERSCAN.has(fila.querySelector(".walletsFilaRed")?.value)
    )
    bloque
        .querySelector(".walletsActivoEtherscan")
        ?.classList.toggle("hidden", !hace || walletsEstado.hayClaveEtherscan)
}

function walletsActivoAnadirFila(bloque) {
    const lista = bloque.querySelector(".walletsActivoFilas")
    const anterior = walletsActivoFilas(bloque).pop()
    lista.insertAdjacentHTML("beforeend", walletsFilaHtml({ conActivo: false }))
    const fila = walletsActivoFilas(bloque).pop()
    if (anterior) {
        fila.querySelector(".walletsFilaRed").value = anterior.querySelector(".walletsFilaRed").value
        fila.dataset.redElegida = anterior.dataset.redElegida || ""
    }
    actualizarFilaWallet(fila)
    walletsActivoActualizarEtherscan(bloque)
    fila.querySelector(".walletsFilaValor")?.focus()
}

// Siempre queda una línea: quitar la última solo la vacía.
function walletsActivoQuitarFila(bloque, fila) {
    if (walletsActivoFilas(bloque).length > 1) {
        fila.remove()
    } else {
        fila.querySelectorAll("input").forEach((campo) => {
            campo.value = ""
        })
        walletsMarcarErrorFila(fila, "")
    }
    walletsActivoActualizarEtherscan(bloque)
}

function walletsActivoEnlazarEventos(bloque) {
    bloque.querySelector(".walletsActivoAnadirBtn").addEventListener("click", () => walletsActivoAnadirFila(bloque))
    const lista = bloque.querySelector(".walletsActivoFilas")
    lista.addEventListener("change", (event) => {
        const fila = event.target.closest(".walletsFila")
        if (!fila || !event.target.classList.contains("walletsFilaRed")) return
        if (!walletsActivoProponiendo) fila.dataset.redElegida = "si"
        actualizarFilaWallet(fila)
        walletsActivoActualizarEtherscan(bloque)
    })
    lista.addEventListener("click", (event) => {
        const quitar = event.target.closest(".walletsFilaQuitarBtn")
        if (quitar) walletsActivoQuitarFila(bloque, quitar.closest(".walletsFila"))
    })
}

/**
 * Propone la red de las líneas según el activo, sin pisar la que haya elegido el usuario.
 *
 * @param {string} bloqueId Id del contenedor del bloque.
 * @param {string} nombre Nombre del activo.
 * @param {string} ticker Ticker de mercado.
 */
function walletsActivoProponerRed(bloqueId, nombre, ticker) {
    const bloque = document.getElementById(bloqueId)
    if (!bloque) return
    const red = walletsActivoRedSugerida(walletsEstado.redes, nombre, ticker)
    if (!red) return
    walletsActivoProponiendo = true
    try {
        walletsActivoFilas(bloque)
            .filter((fila) => !fila.dataset.redElegida)
            .forEach((fila) => walletsFijarSelect(fila.querySelector(".walletsFilaRed"), red))
    } finally {
        walletsActivoProponiendo = false
    }
}

/**
 * Carga las wallets y pinta el bloque. Un fallo aquí no impide crear ni editar el activo.
 *
 * @param {string} bloqueId Id del contenedor del bloque.
 * @param {{assetId?: string, nombre?: string, ticker?: string}} [activo] Activo que se edita; vacío si es nuevo.
 * @returns {Promise<void>}
 */
async function walletsActivoAbrir(bloqueId, { assetId = "", nombre = "", ticker = "" } = {}) {
    const bloque = document.getElementById(bloqueId)
    if (!bloque) return
    bloque.innerHTML = ""
    const turno = ++walletsActivoTurno
    try {
        walletsEstado = await walletsPeticion("/api/wallets")
    } catch (error) {
        if (turno !== walletsActivoTurno) return
        console.error(error)
        bloque.innerHTML = `<p class="assetModalHint">No se pudieron cargar las wallets: se pueden enlazar luego desde Cripto › Seguimiento.</p>`
        return
    }
    if (turno !== walletsActivoTurno) return
    const wallets = walletsActivoDeLaCartera(assetId)
    const cuerpo = walletsEstado.cifradoDisponible
        ? walletsActivoFormularioHtml(wallets)
        : `${walletsActivoListaHtml(wallets)}<p class="ajustesAviso">Falta una SECRET_KEY aleatoria de al menos 32 caracteres en .env: las wallets propias se guardan cifradas con ella.</p>`
    bloque.innerHTML = `
        <details class="walletsActivoDetalle"${wallets.length ? " open" : ""}>
            <summary class="assetModalLabel">
                <span class="walletsActivoTitulo">Direcciones o claves públicas para seguimiento</span>
                <span class="assetModalLabelHint">(${wallets.length ? `${wallets.length} enlazada${wallets.length === 1 ? "" : "s"}` : "opcional"})</span>
                <span class="walletsActivoFlecha" aria-hidden="true">▼</span>
            </summary>
            <div class="walletsActivoCuerpo">${cuerpo}</div>
        </details>`
    if (!walletsEstado.cifradoDisponible) return
    walletsActivoEnlazarEventos(bloque)
    walletsActivoFilas(bloque).forEach(actualizarFilaWallet)
    walletsActivoProponerRed(bloqueId, nombre, ticker)
    walletsActivoActualizarEtherscan(bloque)
}

/**
 * Enseña u oculta el bloque según el tipo de activo.
 *
 * @param {string} bloqueId Id del contenedor del bloque.
 * @param {boolean} visible Si el activo es cripto.
 */
function walletsActivoMostrar(bloqueId, visible) {
    document.getElementById(bloqueId)?.classList.toggle("hidden", !visible)
}

/**
 * Quita el bloque del modal: lo pegado no se queda en la página al cerrar.
 *
 * @param {string} bloqueId Id del contenedor del bloque.
 */
function walletsActivoVaciar(bloqueId) {
    walletsActivoTurno += 1
    const bloque = document.getElementById(bloqueId)
    if (bloque) bloque.innerHTML = ""
}

function walletsActivoSeguimiento(bloque, nombreActivo) {
    const escrito = bloque.querySelector(".walletsActivoSeguimiento")?.value.trim()
    return (
        escrito ||
        String(nombreActivo || "")
            .slice(0, WALLETS_ACTIVO_MAX_NOMBRE)
            .trim()
    )
}

/**
 * Comprueba las líneas escritas sin guardar nada y marca en cada una su error.
 *
 * @param {string} bloqueId Id del contenedor del bloque.
 * @param {string} nombreActivo Nombre del seguimiento si no se ha escrito otro.
 * @returns {Promise<boolean>} true si se puede seguir: no hay líneas o todas valen.
 */
async function walletsActivoValidar(bloqueId, nombreActivo) {
    const bloque = document.getElementById(bloqueId)
    const filas = walletsActivoFilasConValor(bloque)
    if (!filas.length) return true
    filas.forEach((fila) => walletsMarcarErrorFila(fila, ""))
    try {
        const { errores } = await walletsPost("/api/wallets/validar-propias", {
            seguimiento: walletsActivoSeguimiento(bloque, nombreActivo),
            filas: filas.map((fila) => {
                const { red, tipo, valor } = walletsDatosFila(fila)
                return { red, tipo, valor }
            })
        })
        errores.forEach(({ indice, error }) => walletsMarcarErrorFila(filas[indice], error))
        // Plegado, el error no se vería y Confirmar parecería no hacer nada.
        if (errores.length) bloque.querySelector(".walletsActivoDetalle").open = true
        return !errores.length
    } catch (error) {
        showToast(error.message || "No se pudieron comprobar las wallets", { type: "error" })
        return false
    }
}

async function walletsActivoGuardarEtherscan(bloque, datos) {
    const campo = bloque.querySelector(".walletsActivoEtherscanValor")
    const clave = campo?.value.trim() || ""
    if (campo) campo.value = ""
    if (!clave || !datos.some(({ red }) => WALLETS_REDES_ETHERSCAN.has(red))) return
    try {
        await walletsPost("/api/wallets/etherscan", { clave })
    } catch (error) {
        showToast(error.message || "No se pudo guardar la clave de Etherscan", { type: "error" })
    }
}

/**
 * Enlaza como propias, asociadas al activo, las líneas escritas en el bloque.
 *
 * El activo ya está guardado cuando se llega aquí, así que un fallo se avisa pero
 * no lo deshace; lo normal es que no pase, porque antes se ha llamado a
 * `walletsActivoValidar`.
 *
 * @param {string} bloqueId Id del contenedor del bloque.
 * @param {string} assetId Activo al que quedan asociadas.
 * @param {string} nombreActivo Nombre del seguimiento si no se ha escrito otro.
 * @returns {Promise<void>}
 */
async function walletsActivoEnlazar(bloqueId, assetId, nombreActivo) {
    const bloque = document.getElementById(bloqueId)
    const filas = walletsActivoFilasConValor(bloque)
    if (!filas.length) return
    const seguimiento = walletsActivoSeguimiento(bloque, nombreActivo)
    const datos = filas.map(walletsDatosFila)
    // Vacío ya: un segundo clic en Confirmar no encuentra nada que enlazar.
    filas.forEach((fila) => {
        fila.querySelector(".walletsFilaValor").value = ""
    })
    await walletsActivoGuardarEtherscan(bloque, datos)

    const clave = seguimiento.split(/\s+/).join(" ").toLowerCase()
    const grupo = walletsGruposSeguimiento().find((candidato) => candidato.clave === clave)
    // Para numerar los nombres por defecto («Bitcoin 2») con las que se van creando.
    const enGrupo = { wallets: [...(grupo?.wallets || [])] }
    const nuevas = []
    const errores = []
    for (const dato of datos) {
        try {
            const { wallet } = await walletsPost("/api/wallets", {
                ...dato,
                alias: dato.alias || walletsAliasPorDefecto(enGrupo, dato.red),
                assetId,
                seguimiento,
                propia: true
            })
            enGrupo.wallets.push(wallet)
            nuevas.push(wallet.id)
        } catch (error) {
            errores.push(error.message || "No se pudo enlazar")
        }
    }
    walletsActivoAvisar(nuevas.length, errores, seguimiento)
    if (nuevas.length) avisarCambioWallets({ nuevas })
}

function walletsActivoAvisar(enlazadas, errores, seguimiento) {
    if (errores.length) {
        showToast(
            `${errores.length} wallet${errores.length === 1 ? "" : "s"} sin enlazar: ${errores[0]}. Añádelas desde Cripto › Seguimiento.`,
            {
                type: "error",
                duration: 8000
            }
        )
        return
    }
    const plural = enlazadas === 1 ? "" : "s"
    showToast(
        `${enlazadas} wallet${plural} enlazada${plural} en «${seguimiento}»: las verás en Cripto › Seguimiento.`,
        {
            type: "success"
        }
    )
}
