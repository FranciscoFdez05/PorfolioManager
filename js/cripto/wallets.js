// Wallets enlazadas: la ventana de enlazar, compartida por Cripto > Transacciones
// (··· > Wallets enlazadas) y Cripto > Seguimiento.
//
// Enlaza una wallet en modo solo lectura —dirección, o xpub/ypub/zpub en
// Bitcoin—, propia o ajena. Las propias se pueden importar a Transacciones; las
// ajenas solo se siguen. El navegador nunca vuelve a ver el valor completo: el
// servidor lo guarda cifrado y solo devuelve una versión enmascarada, salvo en
// Editar seguimiento tras pedir la contraseña de acceso. El campo se vacía en
// cuanto se envía.
let walletsEstado = { wallets: [], redes: [], cifradoDisponible: false, hayClaveEtherscan: false }
// Criptos de Activos, para asociar la moneda de la wallet.
let walletsActivos = []
// "transacciones" lista las propias para sincronizarlas; "seguimiento" solo
// enseña el formulario, porque la página ya tiene sus tarjetas.
let walletsContexto = "transacciones"
// Clave del seguimiento al que se añade la wallet cuando se abre desde su tarjeta.
let walletsSeguimientoInicial = ""
const WALLETS_REDES_ETHERSCAN = new Set(["eth", "bnb"])

// Las wallets agrupadas por seguimiento, en el orden en que se enlazó la
// primera de cada uno. Todas las de un grupo son propias o todas ajenas: el
// servidor no deja mezclarlas.
function walletsGruposSeguimiento() {
    const grupos = new Map()
    for (const wallet of walletsEstado.wallets) {
        const clave = wallet.seguimientoClave
        if (!grupos.has(clave)) {
            grupos.set(clave, { clave, nombre: wallet.seguimiento, propia: wallet.propia !== false, wallets: [] })
        }
        grupos.get(clave).wallets.push(wallet)
    }
    return [...grupos.values()]
}

// «Ledger · Cuenta 2», o solo «Ledger» si la wallet se llama como su seguimiento.
function walletsNombreCompleto(wallet) {
    return wallet.seguimientoClave === String(wallet.alias || "").toLowerCase()
        ? wallet.seguimiento
        : `${wallet.seguimiento} · ${wallet.alias}`
}

// Seguimiento se registra aquí para repintarse cuando cambia algo desde la ventana.
function avisarCambioWallets(detalle = {}) {
    if (typeof window.alCambiarWallets === "function") window.alCambiarWallets(detalle)
}

async function cargarWalletsActivos() {
    const assets = typeof loadAssetsList === "function" ? await loadAssetsList() : []
    walletsActivos = (assets || []).filter(
        (asset) =>
            String(asset?.type || "")
                .trim()
                .toLowerCase() === "cripto"
    )
}

async function walletsPeticion(url, opciones = {}) {
    const response = await fetch(url, opciones)
    const datos = await response.json().catch(() => null)
    if (!response.ok || datos?.ok === false) {
        const error = new Error(datos?.error || `HTTP ${response.status}`)
        error.status = response.status
        throw error
    }
    return datos
}

// Esperas antes de cada reintento: una por intento extra.
const WALLETS_REINTENTOS_MS = [3000, 8000]

// Solo merece repetirse lo pasajero: tiempo agotado, red caída, límite de
// peticiones o fallo del servidor. Un 4xx (wallet borrada, dirección mala)
// daría lo mismo otra vez.
function walletsErrorPasajero(error) {
    if (error?.name === "TimeoutError" || error?.name === "TypeError") return true
    return error?.status === 429 || error?.status >= 500
}

/**
 * GET a la API que se repite sola si falla por algo pasajero.
 *
 * @param {string} url Ruta de la API.
 * @param {(intento: number) => void} [alReintentar] Aviso antes de cada reintento (1, 2…).
 * @returns {Promise<object>} El JSON de la respuesta.
 * @throws {Error} El último error, si se agotan los reintentos o no es pasajero.
 */
async function walletsPeticionConReintentos(url, alReintentar) {
    for (let intento = 0; ; intento++) {
        try {
            return await walletsPeticion(url)
        } catch (error) {
            if (intento >= WALLETS_REINTENTOS_MS.length || !walletsErrorPasajero(error)) throw error
            alReintentar?.(intento + 1)
            await new Promise((resolve) => setTimeout(resolve, WALLETS_REINTENTOS_MS[intento]))
        }
    }
}

function walletsPost(url, cuerpo) {
    return walletsPeticion(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo || {})
    })
}

async function abrirWalletsEnlazadas(contexto = "transacciones", seguimientoClave = "") {
    walletsContexto = contexto === "seguimiento" ? "seguimiento" : "transacciones"
    walletsSeguimientoInicial = seguimientoClave
    try {
        ;[walletsEstado] = await Promise.all([walletsPeticion("/api/wallets"), cargarWalletsActivos()])
    } catch (error) {
        showError("No se pudieron cargar las wallets enlazadas", error)
        return
    }
    renderWalletsModal()
}

function cerrarWalletsModal() {
    cerrarAvisosWallets()
    document.getElementById("walletsModalOverlay")?.remove()
}

// Solo las criptos de Activos: la moneda nativa de una wallet no es una stablecoin.
function walletsActivosCripto() {
    return walletsActivos
}

// Propuesta inicial de la cripto para una red; el usuario la puede cambiar.
function walletsActivoSugerido(red) {
    const datosRed = walletsEstado.redes.find((r) => r.clave === red)
    if (!datosRed) return ""
    const buscados = [datosRed.simbolo, datosRed.nombre].map((texto) => texto.toUpperCase())
    const encontrado = walletsActivosCripto().find((asset) => {
        const textos = [asset.symbol, asset.name].map((texto) => String(texto || "").toUpperCase())
        return textos.some((texto) => buscados.some((buscado) => texto.includes(buscado)))
    })
    return encontrado?.id || ""
}

function walletsFechaLegible(iso) {
    if (!iso) return "Nunca"
    const fecha = new Date(iso)
    return Number.isNaN(fecha.getTime()) ? iso : fecha.toLocaleString("es-ES")
}

// Nombre corto y largo de lo que se enlazó; también lo usa Seguimiento.
function walletsTipoCorto(tipo) {
    return tipo === "xpub" ? "xpub" : tipo === "clave" ? "clave pública" : "dirección"
}

function walletsTipoLargo(tipo) {
    return tipo === "xpub" ? "Clave pública extendida" : tipo === "clave" ? "Clave pública" : "Dirección"
}

function walletsListaHtml() {
    // Aquí solo las propias: las ajenas no se importan, se ven en Seguimiento.
    const propias = walletsEstado.wallets.filter((wallet) => wallet.propia !== false)
    if (!propias.length) {
        return `<p class="assetModalHint">Todavía no hay wallets propias enlazadas.</p>`
    }
    const nombreRed = (clave) => walletsEstado.redes.find((r) => r.clave === clave)?.nombre || clave
    const nombreActivo = (id) => walletsActivosCripto().find((asset) => asset.id === id)?.name || id
    return `<ul class="walletsLista">${propias
        .map(
            (wallet) => `
            <li class="walletsItem">
                <div class="walletsItemDatos">
                    <strong>${escapeHtml(walletsNombreCompleto(wallet))}</strong>
                    <span>${escapeHtml(nombreRed(wallet.red))} · ${walletsTipoCorto(wallet.tipo)} · <code>${escapeHtml(wallet.valorEnmascarado)}</code></span>
                    <span>Cripto: ${escapeHtml(nombreActivo(wallet.assetId))} · Última sincronización: ${escapeHtml(walletsFechaLegible(wallet.ultimaSincronizacion))}</span>
                </div>
                <div class="walletsItemAcciones">
                    <button type="button" class="primaryButton walletsSincronizarBtn" data-wallet-id="${escapeHtml(wallet.id)}">Sincronizar</button>
                    <button type="button" class="dangerButton walletsDesenlazarBtn" data-wallet-id="${escapeHtml(wallet.id)}">Desenlazar</button>
                </div>
            </li>`
        )
        .join("")}</ul>`
}

// Una línea de la lista de wallets por enlazar. Los ids no se repiten entre
// líneas: cada campo se busca por su clase dentro de la suya.
function walletsFilaHtml({ conActivo = true } = {}) {
    const redes = walletsEstado.redes
        .map(
            (red) =>
                `<option value="${escapeHtml(red.clave)}">${escapeHtml(red.nombre)} (${escapeHtml(red.simbolo)})</option>`
        )
        .join("")
    const activos = walletsActivosCripto()
        .map(
            (asset) =>
                `<option value="${escapeHtml(asset.id)}">${escapeHtml(asset.name || asset.symbol || asset.id)}</option>`
        )
        .join("")
    return `
        <li class="walletsFila">
            <select class="assetRowModalSelect walletsFilaRed" aria-label="Red">${redes}</select>
            <select class="assetRowModalSelect walletsFilaTipo" aria-label="Enlazar con" title="Con «Detectar» se reconoce si es una dirección, una xpub/ypub/zpub o una clave pública">
                <option value="auto">Detectar</option>
                <option value="xpub" data-requiere="admiteXpub">xpub/ypub/zpub (según el prefijo)</option>
                <option value="xpub-p2wpkh" data-requiere="admiteXpub">xpub SegWit nativa (bc1q…)</option>
                <option value="xpub-p2sh-p2wpkh" data-requiere="admiteXpub">xpub SegWit compatible (3…)</option>
                <option value="xpub-p2tr" data-requiere="admiteXpub">xpub Taproot (bc1p…)</option>
                <option value="clave" data-requiere="admiteClavePublica">Clave pública (02…, 03…, 04…)</option>
            </select>
            <input class="assetRowModalInput walletsFilaValor" type="text" aria-label="Dirección o clave pública" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Dirección, xpub o clave pública">
            <input class="assetRowModalInput walletsFilaAlias" type="text" maxlength="60" aria-label="Nombre de esta wallet" placeholder="Nombre (opcional)" autocomplete="off">
            ${
                conActivo
                    ? `<select class="assetRowModalSelect walletsFilaActivo" aria-label="Cripto en Activos">
                <option value="">Sin cripto (sin €)</option>
                ${activos}
            </select>`
                    : ""
            }
            <button type="button" class="cancelButton walletsFilaQuitarBtn" title="Quitar esta línea" aria-label="Quitar esta línea">×</button>
            <p class="walletsFilaError hidden"></p>
        </li>`
}

function walletsFormularioHtml() {
    const seguimientos = walletsGruposSeguimiento()
        .map(
            (grupo) =>
                `<option value="${escapeHtml(grupo.clave)}"${grupo.clave === walletsSeguimientoInicial ? " selected" : ""}>${escapeHtml(grupo.nombre)} (${grupo.wallets.length} · ${grupo.propia ? "mía" : "ajena"})</option>`
        )
        .join("")
    return `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel" for="walletsSeguimiento">Seguimiento</label>
            <select id="walletsSeguimiento" class="assetRowModalSelect">
                <option value="">Nuevo seguimiento…</option>
                ${seguimientos}
            </select>
        </div>
        <div class="assetRowModalField" id="walletsSeguimientoNombreCampo">
            <label class="assetRowModalLabel" for="walletsSeguimientoNombre">Nombre del seguimiento</label>
            <input id="walletsSeguimientoNombre" class="assetRowModalInput" type="text" maxlength="60" placeholder="Ej: Ledger, Satoshi…" autocomplete="off">
        </div>
        <div class="assetRowModalField" id="walletsPropiaCampo">
            <label class="assetRowModalLabel" for="walletsPropia">De quién es</label>
            <select id="walletsPropia" class="assetRowModalSelect">
                <option value="si">Mía (se puede importar a Transacciones)</option>
                <option value="no">Ajena (solo seguimiento)</option>
            </select>
        </div>
        <div class="assetRowModalField">
            <span class="assetRowModalLabel">Avisos</span>
            <button type="button" id="walletsAvisosBtn" class="cancelButton walletsAvisosBtn" aria-haspopup="dialog">
                Avisos Telegram
                <span class="walletsAvisosEstado"></span>
            </button>
        </div>
        <div class="walletsCampoAncho walletsFilasBloque">
            <div class="walletsFilasCabecera" aria-hidden="true">
                <span>Red</span><span>Enlazar con</span><span>Dirección o clave pública</span><span>Nombre</span><span>Cripto en Activos</span><span></span>
            </div>
            <ul id="walletsFilas" class="walletsFilas">${walletsFilaHtml()}</ul>
            <button type="button" id="walletsAnadirFilaBtn" class="cancelButton walletsAnadirFilaBtn">+ Añadir otra wallet</button>
        </div>
        <div class="assetRowModalField walletsCampoAncho hidden" id="walletsEtherscanCampo">
            <label class="assetRowModalLabel" for="walletsEtherscan">Clave de API de Etherscan (gratuita para ETH; BNB requiere plan de pago o NodeReal, en Ajustes › API)</label>
            <input id="walletsEtherscan" class="assetRowModalInput" type="text" autocomplete="off" autocapitalize="off" spellcheck="false">
        </div>
    `
}

function renderWalletsModal() {
    cerrarWalletsModal()

    const overlay = document.createElement("div")
    overlay.id = "walletsModalOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"
    overlay.innerHTML = `
        <div class="assetModal assetRowModal modalDosColumnas walletsModal">
            <h3 class="assetModalTitle assetRowModalTitle">${walletsContexto === "seguimiento" ? "Enlazar wallets" : "Wallets enlazadas"}</h3>
            <div class="assetRowModalFields">
                <p class="ajustesAviso walletsCampoAncho">Solo lectura. Nunca pegues aquí una clave privada ni tu frase semilla: para ver los movimientos basta con la dirección o la xpub. Las tuyas se guardan cifradas en el servidor; las ajenas, sin cifrar, porque son direcciones públicas de otros. Aquí solo se muestran enmascaradas.</p>
                ${walletsEstado.cifradoDisponible ? "" : `<p class="ajustesAviso walletsCampoAncho">Falta una SECRET_KEY aleatoria de al menos 32 caracteres en .env. Hasta definirla solo se pueden seguir wallets ajenas: las tuyas se guardan cifradas con ella.</p>`}
                ${
                    walletsContexto === "seguimiento"
                        ? ""
                        : `<div id="walletsListaContenedor" class="walletsCampoAncho">${walletsListaHtml()}</div>
                <h4 class="walletsSubtitulo walletsCampoAncho">Enlazar otras wallets</h4>`
                }
                ${walletsFormularioHtml()}
                <p class="assetModalHint walletsCampoAncho">Un seguimiento agrupa varias wallets, una por línea, aunque sean de redes distintas: las cuentas de tu Ledger o las wallets de una misma persona. Para añadir más a uno que ya existe, elígelo arriba. Con «Detectar» se reconoce si es una dirección, una xpub/ypub/zpub o una clave pública. Con una xpub se exploran todas las direcciones de la cuenta; si tu wallet exporta «xpub» para una cuenta SegWit o Taproot y no salen movimientos, vuelve a enlazarla eligiendo su tipo de cuenta. En Bitcoin, con una clave pública se revisan sus direcciones Legacy, SegWit y Taproot; en Ethereum y BNB se convierte en su dirección 0x…. Puedes seguir también wallets ajenas (una ballena, un fondo…) pegando su dirección pública: solo se vigilan, no se importan ni suman a tu total. Los avisos por Telegram que elijas en «Avisos Telegram» valen para todas las wallets que enlaces ahora.</p>
            </div>
            <div class="assetRowModalFooter">
                <button type="button" id="walletsCerrarBtn" class="cancelButton">Cerrar</button>
                <button type="button" id="walletsEnlazarBtn" class="primaryButton" data-no-autohide="true">Enlazar</button>
            </div>
        </div>
    `
    document.body.appendChild(overlay)

    overlay.querySelector("#walletsCerrarBtn").addEventListener("click", cerrarWalletsModal)
    overlay.querySelector("#walletsEnlazarBtn").addEventListener("click", enlazarWalletsDesdeModal)
    overlay.querySelector("#walletsSeguimiento").addEventListener("change", actualizarCampoSeguimiento)
    overlay.querySelector("#walletsAnadirFilaBtn").addEventListener("click", anadirFilaWallet)
    overlay.querySelector("#walletsFilas").addEventListener("change", (event) => {
        const fila = event.target.closest(".walletsFila")
        if (fila && event.target.classList.contains("walletsFilaRed")) actualizarFilaWallet(fila)
    })
    overlay.querySelector("#walletsFilas").addEventListener("click", (event) => {
        const quitar = event.target.closest(".walletsFilaQuitarBtn")
        if (quitar) quitarFilaWallet(quitar.closest(".walletsFila"))
    })
    overlay.querySelector("#walletsListaContenedor")?.addEventListener("click", manejarClickListaWallets)
    overlay.querySelector("#walletsAvisosBtn").addEventListener("click", abrirAvisosWallets)
    overlay.querySelectorAll(".walletsFila").forEach(actualizarFilaWallet)
    actualizarCampoSeguimiento()
    walletsAvisosEnlace = walletsAvisosNuevos(null, "enlace")
    actualizarBotonAvisosWallets()
}

// ── Avisos de Telegram (al enlazar y al editar un seguimiento) ────────────────
// Ventana flotante encima de la de enlazar o editar, que sigue abierta y usable
// debajo: se arrastra por la cabecera para no tapar las líneas. Lo elegido vale
// para todas las wallets que se enlacen o, al editar, para todo el seguimiento.
// Los mismos valores por defecto que core/wallets_avisos.ConfigAvisos: avisan
// de todo, como antes de existir los tipos.
const WALLETS_AVISOS_DEFECTO = Object.freeze({
    recibidas: true,
    enviadas: true,
    internas: true,
    tokens: true,
    minimoEur: "",
    saldoMinimo: "",
    saldoMaximo: "",
    despiertaDias: 0,
    agrupar: false,
    maxPorRevision: 0,
    silencioDesde: "",
    silencioHasta: "",
    direccionNueva: false,
    vaciado: false,
    polvo: false,
    rafaga: false,
    imitaciones: false
})
// Mismo formato que acepta el servidor: sin signo, coma o punto decimal.
const WALLETS_UMBRAL_VALIDO = /^\d+([.,]\d+)?$/
const WALLETS_AVISOS_ENTEROS = { despiertaDias: 3650, maxPorRevision: 50 }
const WALLETS_AVISOS_NUMEROS = ["umbralAviso", "minimoEur", "saldoMinimo", "saldoMaximo"]
const WALLETS_AVISOS_TIPOS = [
    ["recibidas", "Recibidas"],
    ["enviadas", "Enviadas"],
    ["internas", "Entre direcciones propias"],
    ["tokens", "Tokens (ERC-20, BEP-20…)"]
]
// Los umbrales son los de core/wallets_avisos (FRACCION_VACIADO, MIN_RAFAGA, UMBRAL_POLVO_EUR).
const WALLETS_AVISOS_SOSPECHOSOS = [
    ["direccionNueva", "Envío a una dirección nueva", "Que no está en la libreta ni en los movimientos leídos"],
    ["vaciado", "Vaciado de la wallet", "Tras un envío queda el 10 % del saldo o menos"],
    ["polvo", "Polvo y direcciones parecidas", "Importes de menos de 1 € o direcciones que imitan a una conocida"],
    ["rafaga", "Ráfaga de envíos", "3 envíos o más entre dos revisiones"],
    [
        "imitaciones",
        "Tokens imitación",
        "De un contrato que marcaste como imitación o que se detecta como tal. Sin esto solo avisan si vienen de una dirección parecida"
    ]
]
const WALLETS_DESPIERTA_DIAS = 90
const WALLETS_SOSPECHOSOS_TODOS = Object.fromEntries(WALLETS_AVISOS_SOSPECHOSOS.map(([campo]) => [campo, true]))
const WALLETS_SOSPECHOSOS_NINGUNO = Object.fromEntries(WALLETS_AVISOS_SOSPECHOSOS.map(([campo]) => [campo, false]))
// Perfiles de un clic: solo tocan qué avisa, no el saldo ni la entrega.
// `umbral` es el mínimo en moneda (umbralAviso), que va fuera de la config.
const WALLETS_AVISOS_PERFILES = [
    {
        id: "todo",
        nombre: "Todo",
        ayuda: "Cada movimiento, lo sospechoso y si despierta",
        umbral: "",
        config: {
            recibidas: true,
            enviadas: true,
            internas: true,
            tokens: true,
            minimoEur: "",
            despiertaDias: WALLETS_DESPIERTA_DIAS,
            ...WALLETS_SOSPECHOSOS_TODOS
        }
    },
    {
        id: "seguridad",
        nombre: "Seguridad",
        ayuda: "Envíos, lo sospechoso y si despierta",
        umbral: "",
        config: {
            recibidas: false,
            enviadas: true,
            internas: false,
            tokens: false,
            minimoEur: "",
            despiertaDias: WALLETS_DESPIERTA_DIAS,
            ...WALLETS_SOSPECHOSOS_TODOS
        }
    },
    {
        id: "grandes",
        nombre: "Solo grandes",
        ayuda: "Movimientos de 1.000 € o más y vaciados",
        umbral: "",
        config: {
            recibidas: true,
            enviadas: true,
            internas: false,
            tokens: false,
            minimoEur: "1000",
            despiertaDias: 0,
            ...WALLETS_SOSPECHOSOS_NINGUNO,
            vaciado: true
        }
    }
]

// `ambito`: "enlace" (wallets nuevas) o "edicion" (todo un seguimiento).
// `mixto`: las wallets del seguimiento tenían avisos distintos. `cambiado`:
// se ha tocado algo, y solo entonces se guardan al editar.
let walletsAvisosEnlace = walletsAvisosNuevos(null, "enlace")

function walletsAvisosNuevos(wallet, ambito) {
    return {
        ambito,
        avisos: Boolean(wallet?.avisos),
        umbral: wallet?.umbralAviso || "",
        config: { ...WALLETS_AVISOS_DEFECTO, ...(wallet?.avisosConfig || {}) },
        mixto: false,
        cambiado: false
    }
}

// Parte de la primera wallet que avisa; si no avisa ninguna, de la primera.
function walletsAvisosDeGrupo(grupo) {
    const base = grupo.wallets.find((wallet) => wallet.avisos) || grupo.wallets[0]
    const estado = walletsAvisosNuevos(base, "edicion")
    const firma = (wallet) =>
        JSON.stringify([
            Boolean(wallet.avisos),
            wallet.umbralAviso || "",
            { ...WALLETS_AVISOS_DEFECTO, ...(wallet.avisosConfig || {}) }
        ])
    estado.mixto = new Set(grupo.wallets.map(firma)).size > 1
    return estado
}

function walletsAvisosCuerpo() {
    const { avisos, umbral, config } = walletsAvisosEnlace
    return { avisos, umbralAviso: umbral, avisosConfig: config }
}

function walletsUmbralValido(texto) {
    return !texto || WALLETS_UMBRAL_VALIDO.test(texto)
}

function walletsNumeroAvisos(texto) {
    return Number(String(texto).replace(",", "."))
}

// El primer error del estado actual, como [campo, mensaje], o null si todo vale.
function walletsErrorAvisos() {
    const { umbral, config } = walletsAvisosEnlace
    const valores = { ...config, umbralAviso: umbral }
    for (const campo of WALLETS_AVISOS_NUMEROS) {
        if (!walletsUmbralValido(String(valores[campo] || "")))
            return [campo, "Pon un número sin signo, por ejemplo 0,5"]
    }
    for (const [campo, maximo] of Object.entries(WALLETS_AVISOS_ENTEROS)) {
        const texto = String(valores[campo] ?? "")
        if (texto && (!/^\d+$/.test(texto) || Number(texto) > maximo)) {
            return [campo, `Pon un número entero entre 0 y ${maximo}`]
        }
    }
    if (
        config.saldoMinimo &&
        config.saldoMaximo &&
        walletsNumeroAvisos(config.saldoMinimo) >= walletsNumeroAvisos(config.saldoMaximo)
    ) {
        return ["saldoMaximo", "El saldo mínimo tiene que ser menor que el máximo"]
    }
    if (Boolean(config.silencioDesde) !== Boolean(config.silencioHasta)) {
        return [config.silencioDesde ? "silencioHasta" : "silencioDesde", "Pon el principio y el final del silencio"]
    }
    if (config.silencioDesde && config.silencioDesde === config.silencioHasta) {
        return ["silencioHasta", "El silencio no puede empezar y acabar a la vez"]
    }
    return null
}

// El perfil que coincide con lo elegido, o null si es personalizado.
// despiertaDias llega como número o como texto según venga del servidor o del input.
function walletsAvisosPerfilActivo(umbral, config) {
    return (
        WALLETS_AVISOS_PERFILES.find(
            (perfil) =>
                perfil.umbral === umbral &&
                Object.entries(perfil.config).every(([campo, valor]) => String(config[campo]) === String(valor))
        ) || null
    )
}

// Un perfil enciende los avisos: elegirlo es la forma rápida de activarlos.
function walletsAplicarPerfil(id) {
    const perfil = WALLETS_AVISOS_PERFILES.find((p) => p.id === id)
    if (!perfil) return
    walletsAvisosEnlace = {
        ...walletsAvisosEnlace,
        avisos: true,
        umbral: perfil.umbral,
        config: { ...walletsAvisosEnlace.config, ...perfil.config },
        cambiado: true
    }
}

function walletsAvisosPartesQueAvisa(umbral, config) {
    const partes = []
    const tipos = WALLETS_AVISOS_TIPOS.filter(([campo]) => config[campo]).length
    if (tipos < WALLETS_AVISOS_TIPOS.length) partes.push(`${tipos}/${WALLETS_AVISOS_TIPOS.length} tipos`)
    if (umbral) partes.push(`desde ${umbral}`)
    if (config.minimoEur) partes.push(`desde ${config.minimoEur} €`)
    if (Number(config.despiertaDias)) partes.push(`dormida ${config.despiertaDias} d`)
    const sospechosos = WALLETS_AVISOS_SOSPECHOSOS.filter(([campo]) => config[campo]).length
    if (sospechosos) partes.push(`sospechosos ${sospechosos}/${WALLETS_AVISOS_SOSPECHOSOS.length}`)
    return partes
}

function walletsAvisosResumen() {
    const { avisos, umbral, config, mixto, cambiado } = walletsAvisosEnlace
    if (mixto && !cambiado) return "Distintos en cada wallet"
    if (!avisos) return "Desactivados"
    // Con un perfil, su nombre resume qué avisa; el saldo y la entrega van aparte.
    const perfil = walletsAvisosPerfilActivo(umbral, config)
    const partes = perfil ? [perfil.nombre] : walletsAvisosPartesQueAvisa(umbral, config)
    if (config.saldoMinimo || config.saldoMaximo) partes.push("saldo")
    if (config.agrupar) partes.push("agrupados")
    else if (Number(config.maxPorRevision)) partes.push(`máx. ${config.maxPorRevision}`)
    if (config.silencioDesde) partes.push(`silencio ${config.silencioDesde}–${config.silencioHasta}`)
    return ["Activados", ...partes].join(" · ")
}

function actualizarBotonAvisosWallets() {
    const boton = document.getElementById("walletsAvisosBtn")
    if (!boton) return
    const estado = boton.querySelector(".walletsAvisosEstado")
    estado.textContent = walletsAvisosResumen()
    estado.title = estado.textContent
    boton.classList.toggle("walletsAvisosBtn-activo", walletsAvisosEnlace.avisos)
}

function cerrarAvisosWallets() {
    document.getElementById("walletsAvisosVentana")?.remove()
}

function walletsAvisosInterruptorHtml(campo, titulo, marcado, ayuda = "") {
    return `
        <div class="ajustesSwitchRow">
            <div class="ajustesSwitchLabel">${escapeHtml(titulo)}${ayuda ? `<small>${escapeHtml(ayuda)}</small>` : ""}</div>
            <label class="ajustesSwitch">
                <input type="checkbox" data-campo="${campo}" aria-label="${escapeHtml(titulo)}"${marcado ? " checked" : ""}>
                <span class="ajustesSwitchTrack"></span>
            </label>
        </div>`
}

function walletsAvisosCampoHtml(
    campo,
    titulo,
    valor,
    { tipo = "decimal", placeholder = "", ayuda = "", detalle = "" } = {}
) {
    const atributos =
        tipo === "hora"
            ? `type="time"`
            : tipo === "entero"
              ? `type="text" inputmode="numeric" maxlength="4"`
              : `type="text" inputmode="decimal" maxlength="40"`
    const texto = tipo === "entero" && !Number(valor) ? "" : String(valor ?? "")
    return `
        <label class="walletsAvisosCampo"${detalle ? ` title="${escapeHtml(detalle)}"` : ""}>
            <span class="assetRowModalLabel">${escapeHtml(titulo)}${ayuda ? ` <small>(${escapeHtml(ayuda)})</small>` : ""}</span>
            <input class="assetRowModalInput" data-campo="${campo}" ${atributos} placeholder="${escapeHtml(placeholder)}" autocomplete="off" value="${escapeHtml(texto)}">
        </label>`
}

// Abierta si ya hay algo puesto dentro: plegada escondería un ajuste activo.
function walletsAvisosMasAbierto(config) {
    return Boolean(
        config.saldoMinimo ||
        config.saldoMaximo ||
        config.agrupar ||
        Number(config.maxPorRevision) ||
        config.silencioDesde ||
        config.silencioHasta
    )
}

function walletsAvisosPerfilesHtml() {
    const { umbral, config } = walletsAvisosEnlace
    const activo = walletsAvisosPerfilActivo(umbral, config)
    const botones = WALLETS_AVISOS_PERFILES.map(
        (perfil) => `
            <button type="button" class="walletsSegFiltro walletsAvisosPerfilBtn${activo?.id === perfil.id ? " activo" : ""}" data-perfil="${perfil.id}" title="${escapeHtml(perfil.ayuda)}" aria-pressed="${activo?.id === perfil.id}">${escapeHtml(perfil.nombre)}</button>`
    ).join("")
    return `
        <div class="walletsAvisosPerfiles" role="group" aria-label="Perfiles de avisos">
            ${botones}
            <span class="walletsSegFiltro walletsAvisosPerfilPropio${activo ? "" : " activo"}">Personalizado</span>
        </div>`
}

// Tras elegir un perfil: los campos y los botones pasan a enseñar el estado nuevo.
function walletsRellenarVentanaAvisos(ventana) {
    const { avisos, umbral, config } = walletsAvisosEnlace
    ventana.querySelectorAll("[data-campo]").forEach((campo) => {
        const nombre = campo.dataset.campo
        const valor = nombre === "avisos" ? avisos : nombre === "umbralAviso" ? umbral : config[nombre]
        if (campo.type === "checkbox") campo.checked = Boolean(valor)
        else campo.value = nombre === "despiertaDias" && !Number(valor) ? "" : String(valor ?? "")
    })
    ventana.querySelector(".walletsAvisosOpciones").disabled = !avisos
    walletsMarcarPerfilActivo(ventana)
}

function walletsMarcarPerfilActivo(ventana) {
    const { umbral, config } = walletsAvisosEnlace
    const activo = walletsAvisosPerfilActivo(umbral, config)
    ventana.querySelectorAll(".walletsAvisosPerfilBtn").forEach((boton) => {
        const elegido = boton.dataset.perfil === activo?.id
        boton.classList.toggle("activo", elegido)
        boton.setAttribute("aria-pressed", String(elegido))
    })
    ventana.querySelector(".walletsAvisosPerfilPropio")?.classList.toggle("activo", !activo)
}

function walletsAvisosVentanaHtml() {
    const { avisos, umbral, config, ambito, mixto } = walletsAvisosEnlace
    const ambitoTexto =
        ambito === "edicion"
            ? "Se aplican a todas las wallets de este seguimiento al pulsar «Guardar»."
            : "Valen para todas las wallets que enlaces ahora."
    return `
        <header class="walletsAvisosCab" title="Arrastra para moverla">
            <b>Avisos por Telegram</b>
            <button type="button" class="walletsAvisosCerrarBtn" title="Cerrar (Esc)" aria-label="Cerrar">${iconoHtml("Cerrar")}</button>
        </header>
        <div class="walletsAvisosCuerpo">
            ${mixto ? `<p class="ajustesAviso">Las wallets de este seguimiento tienen avisos distintos. Si cambias algo aquí, todas quedan igual.</p>` : ""}
            ${walletsAvisosInterruptorHtml("avisos", "Avisos activados", avisos, "Además, activa «Movimientos en las wallets» en Ajustes › Avisos")}
            ${walletsAvisosPerfilesHtml()}
            <fieldset class="walletsAvisosOpciones"${avisos ? "" : " disabled"}>
                <section class="walletsAvisosSeccion">
                    <h5>Qué movimientos avisan</h5>
                    <div class="walletsAvisosTipos">
                        ${WALLETS_AVISOS_TIPOS.map(([campo, titulo]) => walletsAvisosInterruptorHtml(campo, titulo, config[campo])).join("")}
                    </div>
                    <div class="walletsAvisosPar">
                        ${walletsAvisosCampoHtml("umbralAviso", "Mínimo (moneda)", umbral, { placeholder: "Ej: 0,5" })}
                        ${walletsAvisosCampoHtml("minimoEur", "Mínimo en euros", config.minimoEur, { placeholder: "Ej: 1000", ayuda: "sin precio no filtra", detalle: "Si no se conoce el precio de la moneda se avisa de todo. Elige una cripto de Activos o ponle ticker en Análisis › Seguimiento." })}
                    </div>
                    <p class="assetModalHint">Con un mínimo, los tokens no avisan: no se pueden comparar con la moneda ni tienen precio aquí. Los tokens imitación nunca avisan como movimiento normal: solo con «Tokens imitación», abajo.</p>
                </section>
                <section class="walletsAvisosSeccion">
                    <h5>Movimientos sospechosos</h5>
                    <div class="walletsAvisosTipos">
                        ${WALLETS_AVISOS_SOSPECHOSOS.map(([campo, titulo, ayuda]) => walletsAvisosInterruptorHtml(campo, titulo, config[campo], ayuda)).join("")}
                    </div>
                    <p class="assetModalHint">Avisan aunque el tipo o el mínimo de arriba no dejen pasar el movimiento.</p>
                </section>
                <section class="walletsAvisosSeccion walletsAvisosSeccionAncha">
                    <h5>Wallet que despierta</h5>
                    ${walletsAvisosCampoHtml("despiertaDias", "Avisar si se mueve tras estos días quieta", config.despiertaDias, { tipo: "entero", placeholder: "Vacío = no" })}
                </section>
                <details class="walletsAvisosMas"${walletsAvisosMasAbierto(config) ? " open" : ""}>
                <summary>Más opciones: saldo, entrega y silencio</summary>
                <section class="walletsAvisosSeccion">
                    <h5>Saldo</h5>
                    <div class="walletsAvisosPar">
                        ${walletsAvisosCampoHtml("saldoMinimo", "Avisar si baja de", config.saldoMinimo, { placeholder: "Vacío = no" })}
                        ${walletsAvisosCampoHtml("saldoMaximo", "Avisar si sube de", config.saldoMaximo, { placeholder: "Vacío = no" })}
                    </div>
                    <p class="assetModalHint">En la moneda de cada wallet. Avisa al cruzar el límite, no en cada revisión.</p>
                </section>
                <section class="walletsAvisosSeccion">
                    <h5>Entrega</h5>
                    ${walletsAvisosInterruptorHtml("agrupar", "Agrupar en un solo mensaje", config.agrupar, "Todo lo de cada revisión junto")}
                    ${walletsAvisosCampoHtml("maxPorRevision", "Máximo de mensajes por revisión", config.maxPorRevision, { tipo: "entero", placeholder: "Vacío = sin tope" })}
                    <div class="walletsAvisosPar">
                        ${walletsAvisosCampoHtml("silencioDesde", "Silencio desde", config.silencioDesde, { tipo: "hora" })}
                        ${walletsAvisosCampoHtml("silencioHasta", "Hasta", config.silencioHasta, { tipo: "hora" })}
                    </div>
                    <p class="assetModalHint">En las horas de silencio no se manda nada: lo que llegue sale en un solo mensaje al acabar. Hora del servidor.</p>
                </section>
                </details>
            </fieldset>
            <p class="walletsFilaError hidden" id="walletsAvisosError" role="alert"></p>
            <p class="assetModalHint">${ambitoTexto}</p>
        </div>
        <div class="walletsAvisosPie">
            <button type="button" class="primaryButton walletsAvisosListoBtn">Listo</button>
        </div>`
}

// Pasa lo que hay en la ventana al estado y marca el primer error. Devuelve si es válido.
function walletsLeerVentanaAvisos(ventana) {
    const estado = { ...walletsAvisosEnlace, config: { ...walletsAvisosEnlace.config }, cambiado: true }
    ventana.querySelectorAll("[data-campo]").forEach((campo) => {
        const valor = campo.type === "checkbox" ? campo.checked : campo.value.trim()
        if (campo.dataset.campo === "avisos") estado.avisos = valor
        else if (campo.dataset.campo === "umbralAviso") estado.umbral = valor
        else estado.config[campo.dataset.campo] = valor
    })
    walletsAvisosEnlace = estado
    ventana.querySelector(".walletsAvisosOpciones").disabled = !estado.avisos
    return walletsMarcarErrorAvisos(ventana)
}

function walletsMarcarErrorAvisos(ventana) {
    const error = walletsErrorAvisos()
    ventana.querySelectorAll("[data-campo]").forEach((campo) => {
        campo.toggleAttribute("aria-invalid", campo.dataset.campo === error?.[0])
    })
    const mensaje = ventana.querySelector("#walletsAvisosError")
    mensaje.textContent = error?.[1] || ""
    mensaje.classList.toggle("hidden", !error)
    return !error
}

function abrirAvisosWallets() {
    if (document.getElementById("walletsAvisosVentana")) return
    const ventana = document.createElement("aside")
    ventana.id = "walletsAvisosVentana"
    ventana.className = "walletsAvisosVentana"
    ventana.setAttribute("role", "dialog")
    ventana.setAttribute("aria-label", "Avisos por Telegram")
    ventana.innerHTML = walletsAvisosVentanaHtml()
    document.body.appendChild(ventana)

    const leer = () => {
        const valido = walletsLeerVentanaAvisos(ventana)
        walletsMarcarPerfilActivo(ventana)
        actualizarBotonAvisosWallets()
        return valido
    }
    ventana.addEventListener("input", leer)
    ventana.addEventListener("change", leer)
    ventana.addEventListener("click", (event) => {
        const perfil = event.target.closest(".walletsAvisosPerfilBtn")
        if (!perfil) return
        walletsAplicarPerfil(perfil.dataset.perfil)
        walletsRellenarVentanaAvisos(ventana)
        walletsMarcarErrorAvisos(ventana)
        actualizarBotonAvisosWallets()
    })
    ventana.querySelector(".walletsAvisosCerrarBtn").addEventListener("click", cerrarAvisosWallets)
    ventana.querySelector(".walletsAvisosListoBtn").addEventListener("click", () => {
        if (leer()) cerrarAvisosWallets()
        else ventana.querySelector("[data-campo][aria-invalid]")?.focus()
    })
    ventana.addEventListener("keydown", (event) => {
        if (event.key === "Escape") cerrarAvisosWallets()
    })
    // Al abrir no se lee la ventana: eso marcaría el estado como cambiado.
    walletsMarcarErrorAvisos(ventana)
    walletsColocarAvisos(ventana, walletsPosicionInicialAvisos(ventana))
    walletsBindMoverAvisos(ventana)
    ventana.querySelector('[data-campo="avisos"]')?.focus()
}

// Antes de enviar: si los avisos no valen, se dice y se abre su ventana.
function walletsAvisosValidos() {
    if (!walletsErrorAvisos()) return true
    showToast("Revisa los avisos de Telegram: hay un valor no válido", { type: "error" })
    abrirAvisosWallets()
    const ventana = document.getElementById("walletsAvisosVentana")
    if (ventana) walletsMarcarErrorAvisos(ventana)
    return false
}

// Junto al botón, por fuera de la ventana de enlazar si cabe a su derecha;
// si no, debajo del botón.
function walletsPosicionInicialAvisos(ventana) {
    const boton = document.getElementById("walletsAvisosBtn")?.getBoundingClientRect()
    const modal = document.querySelector("#walletsModalOverlay .walletsModal")?.getBoundingClientRect()
    if (!boton) return { x: (window.innerWidth - ventana.offsetWidth) / 2, y: 70 }
    if (modal && modal.right + 12 + ventana.offsetWidth <= window.innerWidth - 8) {
        return { x: modal.right + 12, y: boton.top }
    }
    return { x: boton.left, y: boton.bottom + 8 }
}

// Siempre entera dentro de la pantalla, para no perder la cabecera de arrastre.
function walletsColocarAvisos(ventana, pos) {
    const x = Math.max(8, Math.min(pos.x, window.innerWidth - ventana.offsetWidth - 8))
    const y = Math.max(8, Math.min(pos.y, window.innerHeight - ventana.offsetHeight - 8))
    ventana.style.left = `${x}px`
    ventana.style.top = `${y}px`
}

function walletsBindMoverAvisos(ventana) {
    const cabecera = ventana.querySelector(".walletsAvisosCab")
    cabecera.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest("button")) return
        event.preventDefault()
        const rect = ventana.getBoundingClientRect()
        const dx = event.clientX - rect.left
        const dy = event.clientY - rect.top
        ventana.classList.add("walletsAvisosMoviendo")
        const mover = (ev) => walletsColocarAvisos(ventana, { x: ev.clientX - dx, y: ev.clientY - dy })
        const soltar = () => {
            document.removeEventListener("pointermove", mover)
            document.removeEventListener("pointerup", soltar)
            ventana.classList.remove("walletsAvisosMoviendo")
        }
        document.addEventListener("pointermove", mover)
        document.addEventListener("pointerup", soltar)
    })
}

function walletsFilas() {
    return [...document.querySelectorAll("#walletsFilas .walletsFila")]
}

// La nueva línea copia la red de la anterior: lo normal es pegar varias
// direcciones seguidas de la misma red.
function anadirFilaWallet() {
    const lista = document.getElementById("walletsFilas")
    if (!lista) return
    const anterior = walletsFilas().pop()
    lista.insertAdjacentHTML("beforeend", walletsFilaHtml())
    const fila = walletsFilas().pop()
    if (anterior) fila.querySelector(".walletsFilaRed").value = anterior.querySelector(".walletsFilaRed").value
    actualizarFilaWallet(fila)
    fila.querySelector(".walletsFilaValor")?.focus()
}

// Siempre queda una línea: quitar la última solo la vacía.
function quitarFilaWallet(fila) {
    if (!fila) return
    if (walletsFilas().length > 1) {
        fila.remove()
    } else {
        fila.querySelectorAll("input").forEach((campo) => {
            campo.value = ""
        })
        walletsMarcarErrorFila(fila, "")
    }
    actualizarCampoEtherscan()
}

function walletsMarcarErrorFila(fila, mensaje) {
    const error = fila.querySelector(".walletsFilaError")
    if (!error) return
    error.textContent = mensaje
    error.classList.toggle("hidden", !mensaje)
    fila.classList.toggle("walletsFila-error", Boolean(mensaje))
}

function walletsGrupoElegido() {
    const clave = document.getElementById("walletsSeguimiento")?.value || ""
    return clave ? walletsGruposSeguimiento().find((grupo) => grupo.clave === clave) || null : null
}

// Cambia el valor de un desplegable desde el código. El `change` es para que el
// desplegable personalizado (shared-utils.js) repinte el texto que enseña.
function walletsFijarSelect(select, valor) {
    if (!select || select.value === valor) return
    select.value = valor
    select.dispatchEvent(new Event("change", { bubbles: true }))
}

// En un seguimiento que ya existe, «De quién es» lo fija el grupo y no se
// enseña: el desplegable personalizado no respeta `disabled`.
function actualizarCampoSeguimiento() {
    const grupo = walletsGrupoElegido()
    document.getElementById("walletsSeguimientoNombreCampo")?.classList.toggle("hidden", Boolean(grupo))
    document.getElementById("walletsPropiaCampo")?.classList.toggle("hidden", Boolean(grupo))
    if (grupo) walletsFijarSelect(document.getElementById("walletsPropia"), grupo.propia ? "si" : "no")
}

// Sin nombre, la red: «Bitcoin», y «Bitcoin 2» si el grupo ya tiene una de esa red.
function walletsAliasPorDefecto(grupo, red) {
    const nombreRed = walletsEstado.redes.find((r) => r.clave === red)?.nombre || red
    const repetidas = (grupo?.wallets || []).filter((wallet) => wallet.red === red).length
    return repetidas ? `${nombreRed} ${repetidas + 1}` : nombreRed
}

// La xpub solo existe en Bitcoin, y la cripto se propone según la red.
function actualizarFilaWallet(fila) {
    const red = fila.querySelector(".walletsFilaRed")?.value || ""
    const datosRed = walletsEstado.redes.find((r) => r.clave === red)
    const tipo = fila.querySelector(".walletsFilaTipo")
    if (tipo) {
        tipo.querySelectorAll("option[data-requiere]").forEach((opcion) => {
            opcion.disabled = !datosRed?.[opcion.dataset.requiere]
        })
        if (tipo.selectedOptions[0]?.disabled) walletsFijarSelect(tipo, "auto")
    }
    const sugerido = walletsActivoSugerido(red)
    if (sugerido) walletsFijarSelect(fila.querySelector(".walletsFilaActivo"), sugerido)
    actualizarCampoEtherscan()
}

// La clave de Etherscan solo hace falta si alguna línea es de ETH/BNB y no hay una guardada.
// Al editar un seguimiento con wallets de ETH/BNB se enseña siempre, para poder
// ponerla o cambiarla sin enlazar nada.
function actualizarCampoEtherscan() {
    const hace = walletsFilas().some((fila) =>
        WALLETS_REDES_ETHERSCAN.has(fila.querySelector(".walletsFilaRed")?.value)
    )
    document
        .getElementById("walletsEtherscanCampo")
        ?.classList.toggle("hidden", !walletsEdicionUsaEtherscan() && (!hace || walletsEstado.hayClaveEtherscan))
}

function walletsEdicionUsaEtherscan() {
    if (!document.getElementById("walletsEdicionLista")) return false
    return (walletsEdicionGrupo()?.wallets || []).some((wallet) => WALLETS_REDES_ETHERSCAN.has(wallet.red))
}

function walletsDatosFila(fila) {
    return {
        red: fila.querySelector(".walletsFilaRed")?.value || "",
        tipo: fila.querySelector(".walletsFilaTipo")?.value || "auto",
        valor: fila.querySelector(".walletsFilaValor")?.value.trim() || "",
        alias: fila.querySelector(".walletsFilaAlias")?.value.trim() || "",
        assetId: fila.querySelector(".walletsFilaActivo")?.value || ""
    }
}

// Enlaza una a una las líneas con dirección. Las que entran desaparecen de la
// lista; las que fallan se quedan con su error para corregirlas.
async function enlazarWalletsDesdeModal() {
    const boton = document.getElementById("walletsEnlazarBtn")
    const campoEtherscan = document.getElementById("walletsEtherscan")
    const grupo = walletsGrupoElegido()
    const seguimiento = grupo ? grupo.nombre : document.getElementById("walletsSeguimientoNombre")?.value.trim() || ""
    const propia = document.getElementById("walletsPropia")?.value !== "no"
    const filas = walletsFilas().filter((fila) => walletsDatosFila(fila).valor)
    filas.forEach((fila) => walletsMarcarErrorFila(fila, ""))

    if (!seguimiento || !filas.length) {
        showToast("Pon el nombre del seguimiento y al menos una dirección o xpub", { type: "error" })
        return
    }
    if (!walletsAvisosValidos()) return
    if (propia) {
        const sinActivo = filas.filter((fila) => !walletsDatosFila(fila).assetId)
        sinActivo.forEach((fila) => walletsMarcarErrorFila(fila, "Elige la cripto de Activos: es una wallet propia"))
        if (sinActivo.length) return
    }

    if (boton) boton.disabled = true
    const claveEtherscan = campoEtherscan?.value.trim() || ""
    // Para numerar los nombres por defecto («Bitcoin 2») con las que se van creando.
    const enGrupo = { wallets: [...(grupo?.wallets || [])] }
    const nuevas = []
    let fallos = 0
    try {
        const conEtherscan = filas.some((fila) => WALLETS_REDES_ETHERSCAN.has(walletsDatosFila(fila).red))
        if (claveEtherscan && conEtherscan) await walletsPost("/api/wallets/etherscan", { clave: claveEtherscan })
        for (const fila of filas) {
            const datos = walletsDatosFila(fila)
            try {
                const { wallet } = await walletsPost("/api/wallets", {
                    ...datos,
                    alias: datos.alias || walletsAliasPorDefecto(enGrupo, datos.red),
                    seguimiento,
                    propia,
                    ...walletsAvisosCuerpo()
                })
                enGrupo.wallets.push(wallet)
                nuevas.push(wallet.id)
                if (walletsFilas().length > 1) fila.remove()
                else quitarFilaWallet(fila)
            } catch (error) {
                fallos += 1
                walletsMarcarErrorFila(fila, error.message || "No se pudo enlazar")
            } finally {
                // El valor no se queda en el formulario ni aunque falle: se vuelve a pegar.
                const campo = fila.querySelector(".walletsFilaValor")
                if (campo) campo.value = ""
            }
        }
    } catch (error) {
        showToast(error.message || "No se pudo guardar la clave de Etherscan", { type: "error" })
    } finally {
        if (campoEtherscan?.isConnected) campoEtherscan.value = ""
        if (boton?.isConnected) boton.disabled = false
    }
    if (!nuevas.length) return

    const texto = `${nuevas.length} wallet${nuevas.length === 1 ? "" : "s"} enlazada${nuevas.length === 1 ? "" : "s"} en «${seguimiento}»`
    if (fallos) {
        // Las que fallaron siguen en la ventana; el seguimiento ya existe con ese nombre.
        walletsEstado = await walletsPeticion("/api/wallets")
        showToast(`${texto}. ${fallos} con error: vuelve a pegar su dirección.`, { type: "error", duration: 8000 })
    } else if (walletsContexto === "seguimiento") {
        cerrarWalletsModal()
        showToast(`${texto}. Leyendo su saldo…`, { type: "success" })
    } else {
        walletsEstado = await walletsPeticion("/api/wallets")
        renderWalletsModal()
        showToast(
            propia
                ? `${texto}. Pulsa «Sincronizar» para importar sus movimientos.`
                : `${texto}: las verás en Cripto › Seguimiento.`,
            { type: "success" }
        )
    }
    avisarCambioWallets({ nuevas })
}

function manejarClickListaWallets(event) {
    const sincronizar = event.target.closest(".walletsSincronizarBtn")
    if (sincronizar) {
        sincronizarWallet(sincronizar)
        return
    }
    const desenlazar = event.target.closest(".walletsDesenlazarBtn")
    if (desenlazar) {
        confirmarDesenlazarWallet(desenlazar.dataset.walletId)
    }
}

// Una importación limitada deja la posición sin cuadrar con la red: hay que decirlo.
function walletsAvisoTruncada(resultado, nombre = "") {
    const quien = nombre ? `${nombre}: ` : ""
    return `${quien}solo se han leído los últimos ${resultado.limite} movimientos, hasta el ${resultado.desde}. Puede haber otros más antiguos sin importar: sube [wallets] max_movimientos en config.ini y vuelve a sincronizar.`
}

function walletsResumenSincronizacion(resultado) {
    const partes = [
        `${resultado.anadidas} movimiento${resultado.anadidas === 1 ? "" : "s"} nuevo${resultado.anadidas === 1 ? "" : "s"}`
    ]
    if (resultado.yaImportadas) partes.push(`${resultado.yaImportadas} ya estaban`)
    if (resultado.pendientes) {
        partes.push(
            `${resultado.pendientes} entrada${resultado.pendientes === 1 ? "" : "s"} por verificar en Seguimiento`
        )
    }
    const sinActivo = Object.entries(resultado.sinActivo || {})
    if (sinActivo.length) {
        partes.push(`sin cripto en Activos: ${sinActivo.map(([simbolo, n]) => `${simbolo} (${n})`).join(", ")}`)
    }
    return partes.join(" · ")
}

async function sincronizarWallet(boton) {
    const textoOriginal = boton.textContent
    boton.disabled = true
    boton.textContent = "Sincronizando…"
    const wallet = walletsEstado.wallets.find((w) => w.id === boton.dataset.walletId)
    const progreso = iniciarProgreso(`Sincronizando «${wallet ? walletsNombreCompleto(wallet) : "wallet"}»`)
    try {
        // Lo que hubiera sin guardar en la tabla va antes: la importación escribe
        // sobre la última revisión del servidor.
        if (typeof flushTransaccionesPendingChanges === "function") await flushTransaccionesPendingChanges()
        const resultado = await walletsPost(`/api/wallets/${encodeURIComponent(boton.dataset.walletId)}/sincronizar`)
        if (typeof recargarTransaccionesDesdeServidor === "function") await recargarTransaccionesDesdeServidor()
        walletsEstado = await walletsPeticion("/api/wallets")
        if (document.getElementById("walletsModalOverlay")) renderWalletsModal()
        showToast(walletsResumenSincronizacion(resultado), { type: "success", duration: 6000 })
        if (resultado.truncada) showToast(walletsAvisoTruncada(resultado), { type: "warning", duration: 12000 })
        avisarCambioWallets()
    } catch (error) {
        showToast(error.message || "No se pudo sincronizar la wallet", { type: "error" })
        if (boton.isConnected) {
            boton.disabled = false
            boton.textContent = textoOriginal
        }
    } finally {
        progreso.terminar()
    }
}

function walletsAcumularSincronizacion(total, resultado) {
    total.anadidas += resultado.anadidas || 0
    total.yaImportadas += resultado.yaImportadas || 0
    total.pendientes += resultado.pendientes || 0
    for (const [simbolo, n] of Object.entries(resultado.sinActivo || {})) {
        total.sinActivo[simbolo] = (total.sinActivo[simbolo] || 0) + n
    }
}

/**
 * Importa varias wallets a Transacciones, una petición por wallet.
 *
 * Cada lectura de la red tiene que caber en el timeout de su petición, y una xpub
 * son decenas de llamadas: juntarlas en una sola petición podría no acabar nunca.
 * Una wallet que falla no impide importar las demás.
 *
 * @param {Array<object>} wallets Wallets propias que importar.
 * @returns {Promise<{total: object, truncadas: string[], fallos: string[]}>} Lo importado
 *     en conjunto y los avisos de las wallets limitadas o fallidas.
 */
async function walletsSincronizarLista(wallets) {
    const resumen = {
        total: { anadidas: 0, yaImportadas: 0, pendientes: 0, sinActivo: {} },
        truncadas: [],
        fallos: []
    }
    const progreso = iniciarProgreso("Sincronizando wallets", wallets.length)
    try {
        for (const wallet of wallets) {
            const nombre = walletsNombreCompleto(wallet)
            progreso.paso(nombre)
            try {
                const resultado = await walletsPost(`/api/wallets/${encodeURIComponent(wallet.id)}/sincronizar`)
                walletsAcumularSincronizacion(resumen.total, resultado)
                if (resultado.truncada) resumen.truncadas.push(walletsAvisoTruncada(resultado, nombre))
            } catch (error) {
                resumen.fallos.push(`${nombre}: ${error.message}`)
            }
        }
    } finally {
        progreso.terminar()
    }
    return resumen
}

function walletsAvisarSincronizacion({ total, truncadas, fallos }, numeroWallets) {
    // Lo importado de las que sí funcionaron se cuenta aunque otra fallase.
    if (fallos.length < numeroWallets) {
        showToast(walletsResumenSincronizacion(total), { type: "success", duration: 6000 })
    }
    if (truncadas.length) showToast(truncadas.join(" · "), { type: "warning", duration: 12000 })
    if (fallos.length) showToast(fallos.join(" · "), { type: "error", duration: 8000 })
}

/**
 * Importa a Transacciones los movimientos nuevos de todas las wallets propias.
 *
 * @param {HTMLButtonElement} boton Botón que lo lanza; queda desactivado mientras dura.
 * @returns {Promise<void>}
 */
async function sincronizarWalletsPropias(boton) {
    const textoOriginal = boton.textContent
    boton.disabled = true
    boton.textContent = "Sincronizando…"
    try {
        // Lo que hubiera sin guardar en la tabla va antes: la importación escribe
        // sobre la última revisión del servidor.
        if (typeof flushTransaccionesPendingChanges === "function") await flushTransaccionesPendingChanges()
        walletsEstado = await walletsPeticion("/api/wallets")
        const propias = walletsEstado.wallets.filter((wallet) => wallet.propia !== false)
        if (!propias.length) {
            showToast("No hay wallets propias enlazadas: añádelas en ··· › Wallets enlazadas", { type: "warning" })
            return
        }
        const resumen = await walletsSincronizarLista(propias)
        if (typeof recargarTransaccionesDesdeServidor === "function") await recargarTransaccionesDesdeServidor()
        walletsEstado = await walletsPeticion("/api/wallets")
        if (document.getElementById("walletsModalOverlay")) renderWalletsModal()
        walletsAvisarSincronizacion(resumen, propias.length)
        avisarCambioWallets()
    } catch (error) {
        showToast(error.message || "No se pudieron sincronizar las wallets", { type: "error" })
    } finally {
        if (boton.isConnected) {
            boton.disabled = false
            boton.textContent = textoOriginal
        }
    }
}

function confirmarDesenlazarWallet(walletId) {
    const wallet = walletsEstado.wallets.find((w) => w.id === walletId)
    if (!wallet) return
    // Como el modal de Transacciones: se cierra antes de confirmar para que el
    // diálogo no quede por debajo.
    const veniaDeLaVentana = Boolean(document.getElementById("walletsModalOverlay"))
    cerrarWalletsModal()
    openConfirmModal({
        title: "Desenlazar wallet",
        message: `Se borrará «${wallet.alias}» del servidor. Las transacciones ya importadas se quedan en la tabla.`,
        confirmLabel: "Desenlazar",
        onConfirm: async () => {
            try {
                await walletsPeticion(`/api/wallets/${encodeURIComponent(walletId)}`, { method: "DELETE" })
                walletsEstado = await walletsPeticion("/api/wallets")
                if (veniaDeLaVentana) renderWalletsModal()
                avisarCambioWallets()
            } catch (error) {
                showToast(error.message || "No se pudo desenlazar la wallet", { type: "error" })
            }
        }
    })
}

// ── Editar un seguimiento ─────────────────────────────────────────────────────
// Su nombre, el nombre y la cripto de cada wallet, quitar las que sobran y
// añadir direcciones o claves nuevas. La red y la dirección de una wallet ya
// enlazada no se cambian: sería otra wallet, con otros movimientos vistos y
// otro historial importado, así que se quita y se añade la nueva.
// Seguimiento que se edita. Si se renombra y algo falla después, la ventana
// sigue abierta y `clave` ya es la nueva, para poder reintentar.
let walletsEdicion = null

async function abrirEditarSeguimiento(clave) {
    try {
        ;[walletsEstado] = await Promise.all([walletsPeticion("/api/wallets"), cargarWalletsActivos()])
    } catch (error) {
        showError("No se pudieron cargar las wallets enlazadas", error)
        return
    }
    const grupo = walletsGruposSeguimiento().find((g) => g.clave === clave)
    if (!grupo) {
        showToast("Ese seguimiento ya no existe", { type: "error" })
        return
    }
    walletsEdicion = { clave }
    renderEditarSeguimientoModal(grupo)
}

function walletsEdicionGrupo() {
    return walletsGruposSeguimiento().find((grupo) => grupo.clave === walletsEdicion?.clave) || null
}

function walletsEdicionFilaHtml(wallet, propia) {
    const red = walletsEstado.redes.find((r) => r.clave === wallet.red)
    const activos = walletsActivosCripto()
    const opciones = activos.map(
        (asset) =>
            `<option value="${escapeHtml(asset.id)}"${asset.id === wallet.assetId ? " selected" : ""}>${escapeHtml(asset.name || asset.symbol || asset.id)}</option>`
    )
    // Si su cripto se borró de Activos se enseña igual: elegir la primera sin
    // avisar la cambiaría al guardar otra cosa.
    if (wallet.assetId && !activos.some((asset) => asset.id === wallet.assetId)) {
        opciones.unshift(
            `<option value="${escapeHtml(wallet.assetId)}" selected>${escapeHtml(wallet.assetId)} (ya no está en Activos)</option>`
        )
    }
    // Una propia necesita su cripto para importarse: el servidor no la deja vacía.
    if (!propia) opciones.unshift(`<option value=""${wallet.assetId ? "" : " selected"}>Sin cripto (sin €)</option>`)
    return `
        <li class="walletsEdicionFila" data-wallet-id="${escapeHtml(wallet.id)}" data-alias="${escapeHtml(wallet.alias)}" data-asset-id="${escapeHtml(wallet.assetId || "")}">
            <span class="walletsEdicionDato">${escapeHtml(red?.nombre || wallet.red)} · ${walletsTipoCorto(wallet.tipo)} · <code class="walletsEdicionValor" data-enmascarado="${escapeHtml(wallet.valorEnmascarado)}">${escapeHtml(wallet.valorEnmascarado)}</code></span>
            <input class="assetRowModalInput walletsEdicionAlias" type="text" maxlength="60" aria-label="Nombre de esta wallet" value="${escapeHtml(wallet.alias)}" autocomplete="off">
            <select class="assetRowModalSelect walletsEdicionActivo" aria-label="Cripto en Activos">${opciones.join("")}</select>
            <button type="button" class="dangerButton walletsEdicionQuitarBtn">Quitar</button>
            <p class="walletsFilaError hidden"></p>
        </li>`
}

function renderEditarSeguimientoModal(grupo) {
    cerrarWalletsModal()

    const overlay = document.createElement("div")
    overlay.id = "walletsModalOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"
    overlay.innerHTML = `
        <div class="assetModal assetRowModal modalDosColumnas walletsModal">
            <h3 class="assetModalTitle assetRowModalTitle">Editar seguimiento</h3>
            <div class="assetRowModalFields">
                ${grupo.propia && !walletsEstado.cifradoDisponible ? `<p class="ajustesAviso walletsCampoAncho">Falta una SECRET_KEY aleatoria de al menos 32 caracteres en .env. Hasta definirla no se pueden guardar cambios.</p>` : ""}
                <div class="assetRowModalField walletsCampoAncho">
                    <label class="assetRowModalLabel" for="walletsEdicionNombre">Nombre del seguimiento</label>
                    <input id="walletsEdicionNombre" class="assetRowModalInput" type="text" maxlength="60" value="${escapeHtml(grupo.nombre)}" autocomplete="off">
                </div>
                <div class="assetRowModalField walletsCampoAncho">
                    <span class="assetRowModalLabel">Avisos</span>
                    <button type="button" id="walletsAvisosBtn" class="cancelButton walletsAvisosBtn" aria-haspopup="dialog">
                        Avisos Telegram
                        <span class="walletsAvisosEstado"></span>
                    </button>
                </div>
                <div class="walletsEdicionCabecera walletsCampoAncho">
                    <h4 class="walletsSubtitulo">Sus wallets</h4>
                    <button type="button" id="walletsVerCompletasBtn" class="cancelButton walletsVerCompletasBtn">Ver completas</button>
                </div>
                <form id="walletsVerCompletasForm" class="walletsVerCompletas walletsCampoAncho hidden">
                    <input id="walletsVerCompletasClave" class="assetRowModalInput" type="password" autocomplete="current-password" aria-label="Contraseña de acceso a la web" placeholder="Contraseña de acceso a la web">
                    <button type="submit" class="primaryButton" data-no-autohide="true">Mostrar</button>
                </form>
                <ul id="walletsEdicionLista" class="walletsEdicionLista walletsCampoAncho">${grupo.wallets.map((wallet) => walletsEdicionFilaHtml(wallet, grupo.propia)).join("")}</ul>
                <h4 class="walletsSubtitulo walletsCampoAncho">Añadir direcciones o claves públicas</h4>
                <div class="walletsCampoAncho walletsFilasBloque">
                    <div class="walletsFilasCabecera" aria-hidden="true">
                        <span>Red</span><span>Enlazar con</span><span>Dirección o clave pública</span><span>Nombre</span><span>Cripto en Activos</span><span></span>
                    </div>
                    <ul id="walletsFilas" class="walletsFilas">${walletsFilaHtml()}</ul>
                    <button type="button" id="walletsAnadirFilaBtn" class="cancelButton walletsAnadirFilaBtn">+ Añadir otra wallet</button>
                </div>
                <div class="assetRowModalField walletsCampoAncho hidden" id="walletsEtherscanCampo">
                    <label class="assetRowModalLabel" for="walletsEtherscan">Clave de API de Etherscan (gratuita para ETH; BNB requiere plan de pago o NodeReal, en Ajustes › API)</label>
                    <input id="walletsEtherscan" class="assetRowModalInput" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${walletsEstado.hayClaveEtherscan ? "Ya hay una guardada: escribe otra solo para cambiarla" : "Sin ella no se leen las wallets que usan Etherscan"}">
                </div>
                <p class="assetModalHint walletsCampoAncho">«Quitar» desenlaza la wallet al guardar; las transacciones ya importadas se quedan en la tabla. La red y la dirección de una wallet no se cambian: quítala y añade la nueva. Las que añadas son ${grupo.propia ? "tuyas" : "ajenas"}, como el resto del seguimiento. Nunca pegues una clave privada ni tu frase semilla.</p>
            </div>
            <div class="assetRowModalFooter">
                <button type="button" id="walletsCerrarBtn" class="cancelButton">Cancelar</button>
                <button type="button" id="walletsEdicionGuardarBtn" class="primaryButton" data-no-autohide="true"${grupo.propia && !walletsEstado.cifradoDisponible ? " disabled" : ""}>Guardar</button>
            </div>
        </div>
    `
    document.body.appendChild(overlay)

    overlay.querySelector("#walletsCerrarBtn").addEventListener("click", cerrarWalletsModal)
    overlay.querySelector("#walletsEdicionGuardarBtn").addEventListener("click", guardarEdicionSeguimiento)
    overlay.querySelector("#walletsAnadirFilaBtn").addEventListener("click", anadirFilaWallet)
    overlay.querySelector("#walletsFilas").addEventListener("change", (event) => {
        const fila = event.target.closest(".walletsFila")
        if (fila && event.target.classList.contains("walletsFilaRed")) actualizarFilaWallet(fila)
    })
    overlay.querySelector("#walletsFilas").addEventListener("click", (event) => {
        const quitar = event.target.closest(".walletsFilaQuitarBtn")
        if (quitar) quitarFilaWallet(quitar.closest(".walletsFila"))
    })
    overlay.querySelector("#walletsEdicionLista").addEventListener("click", (event) => {
        const quitar = event.target.closest(".walletsEdicionQuitarBtn")
        if (quitar) alternarQuitarWalletEdicion(quitar.closest(".walletsEdicionFila"))
    })
    overlay.querySelector("#walletsAvisosBtn").addEventListener("click", abrirAvisosWallets)
    walletsAvisosEnlace = walletsAvisosDeGrupo(grupo)
    actualizarBotonAvisosWallets()
    overlay.querySelector("#walletsVerCompletasBtn").addEventListener("click", alternarWalletsCompletas)
    overlay.querySelector("#walletsVerCompletasForm").addEventListener("submit", (event) => {
        event.preventDefault()
        mostrarWalletsCompletas()
    })
    overlay.querySelectorAll(".walletsFila").forEach(actualizarFilaWallet)
}

// Los valores completos solo viven en el texto de esta ventana: al cerrarla o
// al pulsar «Ocultar» se pierden y verlos otra vez exige la contraseña.
function walletsMostrandoCompletas() {
    return document.getElementById("walletsVerCompletasBtn")?.dataset.mostrando === "si"
}

function alternarWalletsCompletas() {
    if (walletsMostrandoCompletas()) {
        ocultarWalletsCompletas()
        return
    }
    const formulario = document.getElementById("walletsVerCompletasForm")
    formulario?.classList.toggle("hidden")
    if (!formulario?.classList.contains("hidden")) document.getElementById("walletsVerCompletasClave")?.focus()
}

function ocultarWalletsCompletas() {
    document.querySelectorAll("#walletsEdicionLista .walletsEdicionValor").forEach((codigo) => {
        codigo.textContent = codigo.dataset.enmascarado || ""
    })
    const boton = document.getElementById("walletsVerCompletasBtn")
    if (boton) {
        boton.dataset.mostrando = ""
        boton.textContent = "Ver completas"
    }
}

async function mostrarWalletsCompletas() {
    const campo = document.getElementById("walletsVerCompletasClave")
    const contrasena = campo?.value || ""
    if (!contrasena) {
        showToast("Escribe la contraseña de acceso a la web", { type: "error" })
        return
    }
    const formulario = document.getElementById("walletsVerCompletasForm")
    const enviar = formulario?.querySelector("button[type=submit]")
    if (enviar) enviar.disabled = true
    try {
        const { valores } = await walletsPost("/api/wallets/seguimientos/ver-completas", {
            clave: walletsEdicion?.clave || "",
            currentPassword: contrasena
        })
        walletsEdicionFilas().forEach((fila) => {
            const codigo = fila.querySelector(".walletsEdicionValor")
            const valor = valores?.[fila.dataset.walletId]
            if (codigo && valor) codigo.textContent = valor
        })
        formulario?.classList.add("hidden")
        const boton = document.getElementById("walletsVerCompletasBtn")
        if (boton) {
            boton.dataset.mostrando = "si"
            boton.textContent = "Ocultar"
        }
    } catch (error) {
        showToast(error.message || "No se pudieron mostrar", { type: "error" })
    } finally {
        // La contraseña no se queda en el campo ni aunque falle.
        if (campo) campo.value = ""
        if (enviar?.isConnected) enviar.disabled = false
    }
}

// Quitar solo marca la línea; se desenlaza al guardar y hasta entonces se deshace.
function alternarQuitarWalletEdicion(fila) {
    if (!fila) return
    const quitada = fila.classList.toggle("walletsEdicionFila-quitada")
    fila.querySelector(".walletsEdicionAlias").disabled = quitada
    const boton = fila.querySelector(".walletsEdicionQuitarBtn")
    boton.textContent = quitada ? "Deshacer" : "Quitar"
    boton.className = `${quitada ? "cancelButton" : "dangerButton"} walletsEdicionQuitarBtn`
    walletsMarcarErrorFila(fila, "")
}

function walletsEdicionFilas() {
    return [...document.querySelectorAll("#walletsEdicionLista .walletsEdicionFila")]
}

// Solo lo que cambió en cada wallet que se queda: así un reintento no repite lo ya guardado.
function walletsEdicionAjustes(fila) {
    const alias = fila.querySelector(".walletsEdicionAlias")?.value.trim() || ""
    const assetId = fila.querySelector(".walletsEdicionActivo")?.value || ""
    const ajustes = {}
    if (alias !== fila.dataset.alias) ajustes.alias = alias
    if (assetId !== fila.dataset.assetId) ajustes.assetId = assetId
    return ajustes
}

// Comprueba la ventana antes de enviar nada. Devuelve false si hay algo que corregir.
function walletsEdicionValida(nombre, grupo, nuevas) {
    if (!nombre) {
        showToast("Pon el nombre del seguimiento", { type: "error" })
        return false
    }
    let valida = true
    for (const fila of walletsEdicionFilas()) {
        if (fila.classList.contains("walletsEdicionFila-quitada")) continue
        if (!fila.querySelector(".walletsEdicionAlias")?.value.trim()) {
            walletsMarcarErrorFila(fila, "Pon un nombre a la wallet")
            valida = false
        }
    }
    if (grupo.propia) {
        for (const fila of nuevas.filter((f) => !walletsDatosFila(f).assetId)) {
            walletsMarcarErrorFila(fila, "Elige la cripto de Activos: es una wallet propia")
            valida = false
        }
    }
    return valida
}

async function walletsEdicionRenombrar(grupo, nombre) {
    if (nombre === grupo.nombre) return
    const { wallets } = await walletsPost("/api/wallets/seguimientos/renombrar", { clave: grupo.clave, nombre })
    if (wallets[0]) walletsEdicion.clave = wallets[0].seguimientoClave
}

// Ajusta y desenlaza las wallets que ya estaban. Devuelve cuántas fallaron.
async function walletsEdicionGuardarExistentes() {
    let fallos = 0
    for (const fila of walletsEdicionFilas()) {
        const walletId = encodeURIComponent(fila.dataset.walletId)
        try {
            if (fila.classList.contains("walletsEdicionFila-quitada")) {
                await walletsPeticion(`/api/wallets/${walletId}`, { method: "DELETE" })
                fila.remove()
                continue
            }
            const ajustes = walletsEdicionAjustes(fila)
            if (!Object.keys(ajustes).length) continue
            const { wallet } = await walletsPost(`/api/wallets/${walletId}/ajustes`, ajustes)
            fila.dataset.alias = wallet.alias
            fila.dataset.assetId = wallet.assetId || ""
        } catch (error) {
            fallos += 1
            walletsMarcarErrorFila(fila, error.message || "No se pudo guardar")
        }
    }
    return fallos
}

// Enlaza en el seguimiento las líneas nuevas con dirección. Las que entran
// desaparecen; las que fallan se quedan con su error.
async function walletsEdicionEnlazarNuevas(grupo, nombre, filas) {
    // Las nuevas entran con los avisos de la ventana, que parten de los del grupo.
    const avisos = walletsAvisosCuerpo()
    const enGrupo = { wallets: [...grupo.wallets] }
    const nuevas = []
    let fallos = 0
    for (const fila of filas) {
        const datos = walletsDatosFila(fila)
        try {
            const { wallet } = await walletsPost("/api/wallets", {
                ...datos,
                alias: datos.alias || walletsAliasPorDefecto(enGrupo, datos.red),
                seguimiento: nombre,
                propia: grupo.propia,
                ...avisos
            })
            enGrupo.wallets.push(wallet)
            nuevas.push(wallet.id)
            quitarFilaWallet(fila)
        } catch (error) {
            fallos += 1
            walletsMarcarErrorFila(fila, error.message || "No se pudo enlazar")
        } finally {
            // El valor no se queda en el formulario ni aunque falle: se vuelve a pegar.
            const campo = fila.querySelector(".walletsFilaValor")
            if (campo) campo.value = ""
        }
    }
    return { nuevas, fallos }
}

// Guarda la clave de Etherscan si se escribió. Devuelve las wallets de ETH/BNB
// del seguimiento, que se vuelven a leer con ella. El campo se vacía siempre.
async function walletsEdicionGuardarEtherscan(grupo) {
    const campo = document.getElementById("walletsEtherscan")
    const clave = campo?.value.trim() || ""
    if (campo) campo.value = ""
    if (!clave) return []
    await walletsPost("/api/wallets/etherscan", { clave })
    walletsEstado.hayClaveEtherscan = true
    return grupo.wallets.filter((wallet) => WALLETS_REDES_ETHERSCAN.has(wallet.red)).map((wallet) => wallet.id)
}

async function guardarEdicionSeguimiento() {
    const grupo = walletsEdicionGrupo()
    if (!grupo) {
        cerrarWalletsModal()
        showToast("Ese seguimiento ya no existe", { type: "error" })
        return
    }
    const nombre = (document.getElementById("walletsEdicionNombre")?.value || "").trim().replace(/\s+/g, " ")
    const filasNuevas = walletsFilas().filter((fila) => walletsDatosFila(fila).valor)
    ;[...walletsEdicionFilas(), ...walletsFilas()].forEach((fila) => walletsMarcarErrorFila(fila, ""))
    if (!walletsEdicionValida(nombre, grupo, filasNuevas)) return
    if (walletsAvisosEnlace.cambiado && !walletsAvisosValidos()) return

    const boton = document.getElementById("walletsEdicionGuardarBtn")
    if (boton) boton.disabled = true
    const claveAntes = grupo.clave
    let nuevas = []
    let releer = []
    let fallos = 0
    try {
        // La clave va antes que las wallets nuevas: las de ETH/BNB la necesitan para leerse.
        releer = await walletsEdicionGuardarEtherscan(grupo)
        // Primero el nombre: las wallets nuevas entran ya con él.
        await walletsEdicionRenombrar(grupo, nombre)
        fallos += await walletsEdicionGuardarExistentes()
        if (filasNuevas.length) {
            const resultado = await walletsEdicionEnlazarNuevas(grupo, nombre, filasNuevas)
            nuevas = resultado.nuevas
            fallos += resultado.fallos
        }
        // Al final, para que cubra también a las recién enlazadas.
        if (walletsAvisosEnlace.cambiado) {
            await walletsPost("/api/wallets/seguimientos/avisos", {
                clave: walletsEdicion.clave,
                ...walletsAvisosCuerpo()
            })
            walletsAvisosEnlace = { ...walletsAvisosEnlace, mixto: false, cambiado: false }
        }
    } catch (error) {
        fallos += 1
        showToast(error.message || "No se pudo guardar el seguimiento", { type: "error" })
    } finally {
        if (boton?.isConnected) boton.disabled = false
    }

    try {
        walletsEstado = await walletsPeticion("/api/wallets")
    } catch (error) {
        showError("No se pudieron recargar las wallets", error)
    }
    // Seguimiento lee en el momento las de `nuevas`: también las que ahora tienen
    // clave de Etherscan, salvo las que se acaban de quitar.
    const aLeer = [...nuevas, ...releer.filter((id) => walletsEstado.wallets.some((wallet) => wallet.id === id))]
    avisarCambioWallets({ nuevas: aLeer, renombrado: { de: claveAntes, a: walletsEdicion.clave } })
    if (!fallos) {
        cerrarWalletsModal()
        showToast(nuevas.length ? "Seguimiento guardado. Leyendo el saldo de las nuevas…" : "Seguimiento guardado", {
            type: "success"
        })
    } else if (document.querySelector("#walletsModalOverlay .walletsFila-error")) {
        showToast("Algunos cambios no se guardaron: revisa las líneas marcadas", { type: "error", duration: 8000 })
    }
}
