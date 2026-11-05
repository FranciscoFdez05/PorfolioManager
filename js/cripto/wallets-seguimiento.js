// Cripto > Seguimiento: saldo, valor y últimos movimientos de cada seguimiento,
// propio o ajeno, y los avisos por Telegram de cada wallet.
//
// Un seguimiento agrupa varias wallets (direcciones, xpubs o claves públicas,
// de la misma red o de varias): las cuentas de un Ledger, las wallets de una
// misma persona. Cada tarjeta es un seguimiento con el total y el desglose.
//
// El servidor guarda el último saldo y los movimientos recientes que leyó (la
// vigilancia de fondo los refresca con el intervalo elegido aquí), así que la
// página carga sin llamar a ninguna red. «Actualizar» los lee en el momento.
//
// Al pulsar una tarjeta se abre su detalle: ficha, sus wallets con los avisos
// de cada una, estadísticas e historial leído de la red en el momento, de 100
// en 100, con flechas para pasar al seguimiento anterior o siguiente.
const WALLETS_SEG_TIPOS = { recibida: "Recibida", enviada: "Enviada", entre_wallet: "Entre direcciones propias" }
const WALLETS_SEG_TEXTO_PENDIENTE = "Pendiente de verificar"

// Una entrada de terceros no pasa a Transacciones hasta que el usuario la confirma.
// Si su origen acaba siendo una dirección propia, ya no es una entrada.
function walletsSegEsPendiente(mov) {
    return Boolean(mov.pendiente) && mov.tipo === "recibida"
}

function walletsSegTextoTipo(mov) {
    return walletsSegEsPendiente(mov) ? WALLETS_SEG_TEXTO_PENDIENTE : WALLETS_SEG_TIPOS[mov.tipo] || mov.tipo
}
const WALLETS_SEG_MOVIMIENTOS_VISIBLES = 2
// Fichas de moneda o token en la tarjeta; el resto se resume en «+N».
const WALLETS_SEG_ACTIVOS_VISIBLES = 6
const WALLETS_SEG_PAGINA = 100
// Lo leído hace menos de esto no se vuelve a pedir al entrar: pasar con Anterior y
// Siguiente por varios seguimientos no debe chocar con el límite de las APIs públicas.
const WALLETS_SEG_FRESCO_MS = 2 * 60 * 1000
const WALLETS_SEG_SIN_PRECIO =
    "No suma en euros y su mínimo en euros no filtra. Elige una cripto de Activos en Editar o ponle ticker en Análisis › Seguimiento."
const WALLETS_SEG_FILTROS = [
    { valor: "todos", texto: "Todos" },
    { valor: "recibida", texto: "Recibidas" },
    { valor: "enviada", texto: "Enviadas" },
    { valor: "entre_wallet", texto: "Entre propias" },
    { valor: "tokens", texto: "Tokens" },
    { valor: "imitaciones", texto: "Imitaciones" }
]
// Estado de un token frente a los contratos que el usuario ha verificado.
const WALLETS_SEG_ESTADOS_TOKEN = {
    verificado: {
        texto: "Verificado",
        titulo: "Has confirmado este contrato como el auténtico de este símbolo"
    },
    reconocido: {
        texto: "Verificado",
        titulo: "Las listas públicas de tokens (Uniswap, CoinGecko) dan este contrato por auténtico. Compruébalo y confírmalo, o márcalo como imitación"
    },
    imitacion: {
        texto: "Imitación",
        titulo: "Mismo símbolo que un token verificado o que la moneda de la red, pero otro contrato: no se importa a Transacciones"
    },
    sinVerificar: {
        texto: "Sin verificar",
        titulo: "Aún no has confirmado qué contrato es el auténtico de este símbolo: se importa por el símbolo"
    },
    legitimo: {
        texto: "No es imitación",
        titulo: "Lo has marcado tú como no imitación: se importa por el símbolo"
    }
}
const WALLETS_SEG_TITULO_IMITACION_MARCADA = "La has marcado tú como imitación: no se importa a Transacciones"
// Visor de UTXOs. Antigüedad por confirmaciones (un bloque cada ~10 minutos:
// 144 al día, 1008 a la semana, 4320 al mes, 52560 al año); la primera es la
// de los que siguen en la mempool.
const WALLETS_SEG_UTXO_EDADES = [
    { clave: "pendiente", texto: "Sin confirmar" },
    { clave: "dia", texto: "Último día", hasta: 144 },
    { clave: "semana", texto: "Última semana", hasta: 1008 },
    { clave: "mes", texto: "Último mes", hasta: 4320 },
    { clave: "anio", texto: "Último año", hasta: 52560 },
    { clave: "antiguo", texto: "Más de un año" }
]
// Por debajo de esto un UTXO cuesta casi tanto gastarlo como lo que vale.
const WALLETS_SEG_UTXO_POLVO = 1000
const WALLETS_SEG_UTXO_MAX_BLOQUES = 300
// Fracción del total por debajo de la cual un UTXO va al bloque «Otros», y el
// área mínima de ese bloque para que se vea.
const WALLETS_SEG_UTXO_FRACCION_MINIMA = 0.0005
const WALLETS_SEG_UTXO_FRACCION_OTROS = 0.02
const WALLETS_SEG_UTXO_ANCHO_DEFECTO = 800
const WALLETS_SEG_UTXO_ALTO = { minimo: 240, maximo: 380 }
// Tamaño mínimo en píxeles de un bloque para escribir dentro el importe, y para
// añadir debajo la altura del bloque.
const WALLETS_SEG_UTXO_ETIQUETA = { ancho: 72, alto: 30, altoDoble: 48 }
// Detalle abierto, o null si se ve la lista. `historiales` guarda, por wallet,
// lo leído de su red: cada una pagina por separado.
let walletsSegDetalle = null
// Lo ya leído en el detalle de cada seguimiento (historial, UTXOs y tokens),
// por su clave y con la hora de cada consulta: volver a abrirlo enseña esto en
// vez de releer la red, que con muchas wallets son minutos. Solo en memoria,
// como los tokens: son saldos que no conviene dejar en el navegador.
const walletsSegLeidos = new Map()
// Estado de los seguimientos con alguna lectura del detalle en marcha, por su
// clave. Salir del detalle o pasar a otro no corta la lectura: termina por su
// cuenta y deja lo leído en walletsSegLeidos, así varias van a la vez.
const walletsSegEnCurso = new Map()
// Secciones («propias», «ajenas») plegadas. Se guarda porque el HTML de la
// página se vuelve a cargar cada vez que se entra en ella.
const WALLETS_SEG_PLEGADOS_KEY = "walletsSegPlegados"
// Pestañas del detalle: cada una aparece solo si alguna wallet del seguimiento
// es de una red que la tenga. La elegida se recuerda en este navegador.
const WALLETS_SEG_PESTANA_KEY = "walletsSegPestana"
const WALLETS_SEG_PESTANAS = [
    { clave: "movimientos", nombre: "Movimientos", disponible: () => true },
    { clave: "direcciones", nombre: "Direcciones", disponible: () => true },
    // Siempre: además de los tokens de ETH/BNB lista la moneda propia de cada wallet.
    { clave: "tokens", nombre: "Tokens", disponible: () => true },
    { clave: "utxos", nombre: "UTXOs", disponible: (grupo) => grupo.wallets.some((wallet) => wallet.red === "btc") }
]
// Tokens leídos en el detalle, por id de wallet. Aquí solo en memoria: son saldos
// que no conviene dejar en el navegador; el servidor los guarda cifrados para la
// próxima visita (stores/wallets_lecturas.py), porque Etherscan gratuito pide una
// llamada por token. Sirven para que la tarjeta los muestre también.
const walletsSegTokensLeidos = new Map()
// Contratos de las listas públicas de tokens que el servidor manda junto a cada
// lectura, por «red|contrato». Solo se acumulan: recargar las wallets no debe
// dejar sin ellos al historial o a los tokens ya leídos.
const walletsSegTokensPublicos = new Map()

function walletsSegAnotarPublicos(lista) {
    for (const token of lista || []) walletsSegTokensPublicos.set(`${token.red}|${token.contrato}`, token)
}

function walletsSegNumero(valor, maximoDecimales = 8) {
    const numero = parseLooseNumber(valor)
    if (numero === null) return "—"
    return numero.toLocaleString("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: maximoDecimales })
}

function walletsSegEuros(valor) {
    const numero = parseLooseNumber(valor)
    if (numero === null) return ""
    return numero.toLocaleString("es-ES", { style: "currency", currency: "EUR" })
}

function walletsSegFecha(iso) {
    if (!iso) return "—"
    const fecha = new Date(iso)
    return Number.isNaN(fecha.getTime())
        ? "—"
        : fecha.toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })
}

function walletsSegAbreviar(texto) {
    const valor = String(texto || "")
    return valor.length > 16 ? `${valor.slice(0, 8)}…${valor.slice(-6)}` : valor
}

function walletsSegRed(wallet) {
    return walletsEstado.redes.find((r) => r.clave === wallet.red)
}

function walletsSegRedDeMovimiento(mov) {
    const wallet = walletsEstado.wallets.find((w) => w.id === mov.walletId)
    return wallet ? wallet.red : ""
}

// Sin acentos ni marcas: «ĖŢḤ» se compara como «ETH». Igual que esqueletoSimbolo().
function walletsSegEsqueletoSimbolo(simbolo) {
    return String(simbolo || "")
        .normalize("NFKD")
        .replace(/\p{Mn}/gu, "")
        .toUpperCase()
}

function walletsSegEsNombreDeLaRed(redClave, simbolo) {
    const red = walletsEstado.redes.find((r) => r.clave === redClave)
    return Boolean(red) && walletsSegEsqueletoSimbolo(simbolo) === red.simbolo
}

// La decisión del usuario sobre un contrato («imitacion» o «legitimo»), o "".
function walletsSegMarcaToken(mov, redClave) {
    const marcado = (walletsEstado.tokensMarcados || []).find(
        (token) => token.red === redClave && token.contrato === mov.contrato
    )
    return marcado ? marcado.marca : ""
}

// Etiqueta manual, aparte del estado: el usuario ve algo raro que ni las listas
// ni la regla delatan. No cambia lo que se importa.
const WALLETS_SEG_TITULO_SOSPECHOSO =
    "Lo has etiquetado tú como sospechoso: se sigue importando, solo es un aviso para ti"

function walletsSegEsSospechoso(mov, redClave) {
    return (walletsEstado.tokensSospechosos || []).some(
        (token) => token.red === redClave && token.contrato === mov.contrato
    )
}

// Ticker de cotización puesto a mano a un contrato, o null.
function walletsSegPrecioToken(mov, redClave) {
    return (
        (walletsEstado.preciosToken || []).find(
            (precio) => precio.red === redClave && precio.contrato === mov.contrato
        ) || null
    )
}

// Misma regla que estadoToken() en python/core/wallets_tokens.py, que es la que
// decide qué se importa: si cambia allí, cambia aquí. "" si no es un token.
function walletsSegEstadoToken(mov, redClave) {
    if (!mov.contrato) return ""
    const marca = walletsSegMarcaToken(mov, redClave)
    if (marca) return marca
    if (walletsSegEsNombreDeLaRed(redClave, mov.simbolo)) return "imitacion"
    const esqueleto = walletsSegEsqueletoSimbolo(mov.simbolo)
    const autenticos = (walletsEstado.tokensVerificados || []).filter(
        (token) => token.red === redClave && walletsSegEsqueletoSimbolo(token.simbolo) === esqueleto
    )
    if (autenticos.length) {
        return autenticos.some((token) => token.contrato === mov.contrato) ? "verificado" : "imitacion"
    }
    if (walletsSegTokensPublicos.has(`${redClave}|${mov.contrato}`)) return "reconocido"
    const publicos = [...walletsSegTokensPublicos.values()]
    return publicos.some((token) => token.red === redClave && walletsSegEsqueletoSimbolo(token.simbolo) === esqueleto)
        ? "imitacion"
        : "sinVerificar"
}

// Un tono fijo por contrato: dos «PEPE» de contratos distintos se distinguen de
// un vistazo aunque se llamen igual. Sin rojos ni verdes, que ya dicen
// «imitación» y «verificado».
const WALLETS_SEG_TONOS_TOKEN = [200, 225, 255, 285, 315, 35, 50, 180]

function walletsSegTonoContrato(contrato) {
    let hash = 0
    for (const caracter of contrato) hash = (hash * 31 + caracter.charCodeAt(0)) >>> 0
    return WALLETS_SEG_TONOS_TOKEN[hash % WALLETS_SEG_TONOS_TOKEN.length]
}

// La moneda propia de la red no tiene contrato y no se puede imitar.
function walletsSegNativaHtml(mov, red) {
    if (!red || walletsSegEsqueletoSimbolo(mov.simbolo) !== red.simbolo) return ""
    const titulo = `${red.simbolo} auténtico de ${red.nombre}: lo mueve la propia red, no un contrato, así que no puede ser una imitación`
    return `<span class="walletsSegToken walletsSegToken-nativa">
        <span class="walletsSegTokenEstado" title="${escapeHtml(titulo)}">${escapeHtml(red.simbolo)} real · moneda de la red</span>
    </span>`
}

// Marca del token: punto del color de su contrato, estado y contrato abreviado
// con enlace al explorador. Con `conAcciones`, los botones para decidir sobre él.
function walletsSegTokenHtml(mov, redClave, conAcciones) {
    const red = walletsEstado.redes.find((r) => r.clave === redClave)
    if (!mov.contrato) return walletsSegNativaHtml(mov, red)
    const estado = walletsSegEstadoToken(mov, redClave)
    if (!estado) return ""
    const marca = walletsSegMarcaToken(mov, redClave)
    const info = WALLETS_SEG_ESTADOS_TOKEN[estado]
    const titulo = marca === "imitacion" ? WALLETS_SEG_TITULO_IMITACION_MARCADA : info.titulo
    const corto = escapeHtml(walletsSegAbreviar(mov.contrato))
    const enlace = red?.exploradorToken
        ? red.exploradorToken.replace("{contrato}", encodeURIComponent(mov.contrato))
        : ""
    const contrato = enlace
        ? `<a class="walletsSegTokenContrato" href="${escapeHtml(enlace)}" target="_blank" rel="noopener noreferrer" title="Contrato ${escapeHtml(mov.contrato)}: ábrelo en el explorador para comprobarlo">${corto} ↗</a>`
        : `<span class="walletsSegTokenContrato" title="${escapeHtml(mov.contrato)}">${corto}</span>`
    const accion =
        conAcciones && red?.exploradorToken
            ? walletsSegAccionesTokenHtml(mov, redClave, estado, marca) +
              walletsSegAccionSospechosoHtml(mov, redClave, estado)
            : ""
    // En una imitación sobra: ya dice algo peor.
    const sospechoso =
        estado !== "imitacion" && walletsSegEsSospechoso(mov, redClave)
            ? `<span class="walletsSegTokenSospechoso" title="${escapeHtml(WALLETS_SEG_TITULO_SOSPECHOSO)}">Sospechoso</span>`
            : ""
    return `<span class="walletsSegToken walletsSegToken-${estado}" style="--tokenTono: ${walletsSegTonoContrato(mov.contrato)}">
        <span class="walletsSegTokenPunto" aria-hidden="true"></span>
        <span class="walletsSegTokenEstado" title="${escapeHtml(titulo)}">${info.texto}</span>
        ${sospechoso}${contrato}${accion}
    </span>`
}

// Lo que el usuario puede decidir en cada estado. La detección automática solo
// propone: una imitación detectada se puede desmentir, un token sin verificar se
// puede marcar como imitación, y cualquier marca se deshace.
// `claseBase` cambia solo el aspecto: en el menú ··· de una fila son opciones
// del desplegable y el clic se reconoce por la misma clase de acción.
function walletsSegAccionesTokenHtml(mov, redClave, estado, marca, claseBase = "walletsSegTokenBtn") {
    const datos = `data-red="${escapeHtml(redClave)}" data-contrato="${escapeHtml(mov.contrato)}" data-simbolo="${escapeHtml(mov.simbolo)}"`
    const boton = (clase, texto, extra = "") =>
        `<button type="button" class="${claseBase} ${clase}" ${datos}${extra}>${texto}</button>`
    if (marca) return boton("walletsSegTokenDesmarcarBtn", "Deshacer", ` title="Volver a la detección automática"`)
    if (estado === "verificado") return boton("walletsSegTokenOlvidarBtn", "Quitar")
    if (estado === "imitacion") return boton("walletsSegTokenLegitimoBtn", "No es imitación")
    if (estado === "reconocido") {
        return (
            boton(
                "walletsSegTokenVerificarBtn",
                "Confirmar",
                ` title="Confirmarlo tú: el símbolo queda anclado a este contrato aunque cambien las listas"`
            ) + boton("walletsSegTokenImitacionBtn", "Es imitación")
        )
    }
    return boton("walletsSegTokenVerificarBtn", "Verificar") + boton("walletsSegTokenImitacionBtn", "Es imitación")
}

// Etiquetar o desetiquetar como sospechoso. No en una imitación: ya no se importa.
function walletsSegAccionSospechosoHtml(mov, redClave, estado, claseBase = "walletsSegTokenBtn") {
    if (estado === "imitacion") return ""
    const sospechoso = walletsSegEsSospechoso(mov, redClave)
    return `<button type="button" class="${claseBase} walletsSegTokenSospechosoBtn" data-red="${escapeHtml(redClave)}" data-contrato="${escapeHtml(mov.contrato)}" data-sospechoso="${sospechoso ? "false" : "true"}"${sospechoso ? "" : ` title="Etiquétalo si ves algo raro que las listas de tokens no detectan. No cambia lo que se importa"`}>${sospechoso ? "No es sospechoso" : "Es sospechoso"}</button>`
}

// Poner, cambiar o quitar el ticker de cotización. Solo en la pestaña Tokens,
// que es donde se ve si el token tiene activo asociado y valor.
function walletsSegAccionesPrecioHtml(mov, redClave, estado, claseBase = "walletsSegTokenBtn") {
    if (estado === "imitacion") return ""
    const datos = `data-red="${escapeHtml(redClave)}" data-contrato="${escapeHtml(mov.contrato)}" data-simbolo="${escapeHtml(mov.simbolo)}"`
    const precio = walletsSegPrecioToken(mov, redClave)
    if (precio) {
        return (
            `<button type="button" class="${claseBase} walletsSegTokenPrecioBtn" ${datos}>Cambiar ticker de precio</button>` +
            `<button type="button" class="${claseBase} walletsSegTokenPrecioQuitarBtn" ${datos}>Quitar ticker de precio</button>`
        )
    }
    // Con activo asociado ya tiene precio; el ticker se ofrece solo si no lo tiene.
    if (mov.activo) return ""
    return `<button type="button" class="${claseBase} walletsSegTokenPrecioBtn" ${datos}>Poner ticker de precio</button>`
}

// Menú ··· de una fila del historial con las mismas acciones. Cada opción lleva
// en sus data-* la red y el contrato de su propio movimiento, no la posición de
// la fila: aunque cambien el filtro, las fechas o el orden, actúa siempre sobre
// el token de la fila en la que está. "" si no hay nada que decidir.
// `conPrecio`: en la pestaña Tokens, también las opciones del ticker de precio.
function walletsSegMenuTokenHtml(mov, redClave, conPrecio = false) {
    const red = walletsEstado.redes.find((r) => r.clave === redClave)
    const estado = mov.contrato && red?.exploradorToken ? walletsSegEstadoToken(mov, redClave) : ""
    if (!estado) return ""
    const opciones =
        walletsSegAccionesTokenHtml(mov, redClave, estado, walletsSegMarcaToken(mov, redClave), "rowMenuItem") +
        walletsSegAccionSospechosoHtml(mov, redClave, estado, "rowMenuItem") +
        (conPrecio ? walletsSegAccionesPrecioHtml(mov, redClave, estado, "rowMenuItem") : "")
    return `
        <div class="rowMenu">
            <button type="button" class="rowMenuTrigger" title="Opciones del token ${escapeHtml(mov.simbolo)}" aria-label="Opciones del token ${escapeHtml(mov.simbolo)}">···</button>
            <div class="rowMenuDropdown">${opciones}</div>
        </div>`
}

async function initWalletsSeguimientoLogic() {
    window.alCambiarWallets = walletsSegAlCambiar
    walletsSegDetalle = null
    bindWalletsSegEventos()
    await cargarWalletsSeguimiento()
}

async function cargarWalletsSeguimiento() {
    try {
        const [datos] = await Promise.all([walletsPeticion("/api/wallets"), cargarWalletsActivos()])
        walletsEstado = datos
        walletsSegAnotarPublicos(datos.tokensPublicos)
    } catch (error) {
        showError("No se pudieron cargar las wallets", error)
        return
    }
    renderWalletsSeguimiento()
}

// Llamado por la ventana de enlazar (js/cripto/wallets.js). Las wallets recién
// enlazadas se leen en el momento para que salgan con su saldo, una a una como
// en «Actualizar todo».
async function walletsSegAlCambiar(detalle = {}) {
    if (!document.getElementById("walletsSegPropias")) return
    // Renombrar cambia la clave: el detalle abierto sigue en el mismo seguimiento.
    const renombrado = detalle.renombrado
    if (renombrado && walletsSegDetalle?.clave === renombrado.de) walletsSegDetalle.clave = renombrado.a
    if (renombrado && walletsSegLeidos.has(renombrado.de)) {
        walletsSegLeidos.set(renombrado.a, walletsSegLeidos.get(renombrado.de))
        walletsSegLeidos.delete(renombrado.de)
    }
    await cargarWalletsSeguimiento()
    for (const walletId of detalle.nuevas || []) await actualizarWalletSeguimiento(walletId)
}

function bindWalletsSegEventos() {
    const pagina = document.querySelector(".walletsSegPage")
    if (!pagina || pagina.dataset.bound) return
    pagina.dataset.bound = "true"

    document
        .getElementById("walletsSegEnlazarBtn")
        ?.addEventListener("click", () => abrirWalletsEnlazadas("seguimiento"))
    document.getElementById("walletsSegActualizarBtn")?.addEventListener("click", actualizarTodasSeguimiento)
    document.getElementById("walletsSegDireccionesBtn")?.addEventListener("click", abrirLibretaSeguimiento)
    document.getElementById("walletsSegIntervalo")?.addEventListener("change", guardarIntervaloSeguimiento)
    pagina.addEventListener("click", manejarClickSeguimiento)
    pagina.addEventListener("change", manejarCambioSeguimiento)
    pagina.addEventListener("keydown", manejarTeclaSeguimiento)
}

// Mismo orden que en pantalla: primero los propios, luego los ajenos.
function walletsSegOrdenados() {
    const grupos = walletsGruposSeguimiento()
    return [...grupos.filter((grupo) => grupo.propia), ...grupos.filter((grupo) => !grupo.propia)]
}

function walletsSegGrupo(clave) {
    return walletsGruposSeguimiento().find((grupo) => grupo.clave === clave) || null
}

// Total en euros de lo que tiene precio, y saldo por moneda nativa.
function walletsSegResumenGrupo(grupo) {
    const saldos = new Map()
    let euros = null
    for (const wallet of grupo.wallets) {
        const simbolo = walletsSegRed(wallet)?.simbolo || wallet.red
        const saldo = parseLooseNumber(wallet.saldo)
        if (saldo !== null) saldos.set(simbolo, (saldos.get(simbolo) || 0) + saldo)
        const valor = parseLooseNumber(wallet.valorEur)
        if (valor !== null) euros = (euros || 0) + valor
    }
    const fechas = (campo) =>
        grupo.wallets
            .map((wallet) => wallet[campo])
            .filter(Boolean)
            .sort()
    const leidas = fechas("saldoFecha")
    return {
        saldos: [...saldos].map(([simbolo, cantidad]) => `${walletsSegNumero(cantidad)} ${simbolo}`).join(" · "),
        euros: euros === null ? "" : walletsSegEuros(euros),
        // La lectura más antigua: es la que dice cuánto puede estar desfasado el total.
        saldoFecha: leidas.length === grupo.wallets.length ? leidas[0] : "",
        ultimoMovimiento: fechas("ultimoMovimiento").pop() || "",
        ultimaSincronizacion: fechas("ultimaSincronizacion").pop() || ""
    }
}

function renderWalletsSeguimiento() {
    // Un seguimiento que se queda sin wallets mientras se veía su detalle devuelve a la lista.
    if (walletsSegDetalle && !walletsSegGrupo(walletsSegDetalle.clave)) {
        walletsSegDetalle = null
    }
    document.getElementById("walletsSegLista")?.classList.toggle("hidden", Boolean(walletsSegDetalle))
    document.getElementById("walletsSegDetalle")?.classList.toggle("hidden", !walletsSegDetalle)
    if (walletsSegDetalle) {
        renderDetalleSeguimiento()
        return
    }

    const grupos = walletsGruposSeguimiento()
    const propios = grupos.filter((grupo) => grupo.propia)
    const ajenos = grupos.filter((grupo) => !grupo.propia)

    document.getElementById("walletsSegTotal").textContent = walletsSegEuros(walletsEstado.totalPropiasEur) || "0,00 €"
    document.getElementById("walletsSegTotalNota").textContent = walletsSegNotaTotal()
    document.getElementById("walletsSegSinCifrado")?.classList.toggle("hidden", walletsEstado.cifradoDisponible)
    document.getElementById("walletsSegVacio")?.classList.toggle("hidden", walletsEstado.wallets.length > 0)
    document.getElementById("walletsSegPropiasBloque")?.classList.toggle("hidden", !propios.length)
    document.getElementById("walletsSegAjenasBloque")?.classList.toggle("hidden", !ajenos.length)
    document.getElementById("walletsSegPropiasNum").textContent = propios.length
    document.getElementById("walletsSegAjenasNum").textContent = ajenos.length
    document.getElementById("walletsSegPropias").innerHTML = propios.map(walletsSegTarjetaHtml).join("")
    document.getElementById("walletsSegAjenas").innerHTML = ajenos.map(walletsSegTarjetaHtml).join("")
    renderPlegadosSeguimiento()
    renderIntervaloSeguimiento()
}

function walletsSegPlegados() {
    try {
        const guardado = JSON.parse(localStorage.getItem(WALLETS_SEG_PLEGADOS_KEY) || "[]")
        return new Set(Array.isArray(guardado) ? guardado.map(String) : [])
    } catch {
        return new Set()
    }
}

function renderPlegadosSeguimiento() {
    const plegados = walletsSegPlegados()
    for (const boton of document.querySelectorAll(".walletsSegPlegarBtn")) {
        const plegado = plegados.has(boton.dataset.plegar)
        boton.closest(".walletsSegBloque")?.classList.toggle("walletsSegBloquePlegado", plegado)
        boton.setAttribute("aria-expanded", plegado ? "false" : "true")
    }
}

function plegarSeccionSeguimiento(boton) {
    const plegado = boton.closest(".walletsSegBloque")?.classList.toggle("walletsSegBloquePlegado")
    boton.setAttribute("aria-expanded", plegado ? "false" : "true")

    const plegados = walletsSegPlegados()
    if (plegado) {
        plegados.add(boton.dataset.plegar)
    } else {
        plegados.delete(boton.dataset.plegar)
    }
    try {
        localStorage.setItem(WALLETS_SEG_PLEGADOS_KEY, JSON.stringify([...plegados]))
    } catch {
        // Sin localStorage se pliega igual, solo que no dura hasta la próxima visita.
    }
}

// Lo que el total no cuenta: sin decirlo, una wallet con solo tokens parece vacía.
function walletsSegNotaTotal() {
    const sinPrecio = Number(walletsEstado.totalSinPrecio) || 0
    const partes = ["Solo la moneda de cada red; los tokens se ven en el detalle"]
    if (sinPrecio)
        partes.push(
            `${sinPrecio} wallet${sinPrecio === 1 ? "" : "s"} sin precio no cuenta${sinPrecio === 1 ? "" : "n"}`
        )
    return partes.join(" · ")
}

function walletsSegTextoMinutos(minutos) {
    if (minutos === 0) return "Nunca (solo a mano)"
    if (minutos < 60) return `${minutos} minutos`
    if (minutos === 1440) return "1 día"
    return `${minutos / 60} hora${minutos === 60 ? "" : "s"}`
}

// Las ajenas tienen su propio mínimo ([wallets] ajenas_cada_minutos): el intervalo
// elegido no las revisa más a menudo que eso.
function walletsSegNotaIntervalo() {
    const ajenas = Number(walletsEstado.ajenasCadaMinutos) || 0
    if (!ajenas || walletsEstado.vigilanciaMinutos === 0 || ajenas <= walletsEstado.vigilanciaMinutos) return ""
    return `Las wallets que sigo, como mucho cada ${walletsSegTextoMinutos(ajenas)}`
}

function renderIntervaloSeguimiento() {
    const select = document.getElementById("walletsSegIntervalo")
    if (!select) return
    const texto = walletsSegTextoMinutos
    const nota = document.getElementById("walletsSegIntervaloNota")
    if (nota) nota.textContent = walletsSegNotaIntervalo()
    select.innerHTML = (walletsEstado.opcionesMinutos || [])
        .map(
            (minutos) =>
                `<option value="${minutos}"${minutos === walletsEstado.vigilanciaMinutos ? " selected" : ""}>${texto(minutos)}</option>`
        )
        .join("")
}

// Los recientes de todas las wallets del grupo, del más nuevo al más antiguo.
function walletsSegMovimientosHtml(grupo) {
    const varias = grupo.wallets.length > 1
    const recientes = grupo.wallets
        .flatMap((wallet) => (wallet.recientes || []).map((mov) => ({ ...mov, alias: wallet.alias, red: wallet.red })))
        .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))
        .slice(0, WALLETS_SEG_MOVIMIENTOS_VISIBLES)
    if (!recientes.length) {
        const leido = grupo.wallets.some((wallet) => wallet.saldoFecha)
        return `<p class="walletsSegSinMovimientos">${leido ? "Sin movimientos recientes." : "Pendiente de la primera lectura."}</p>`
    }
    // Una línea por movimiento; el hash y el contrato completos están en el detalle.
    return `<ul class="walletsSegMovimientos walletsSegMovimientosCompactos">${recientes
        .map((mov) => {
            const imitacion = walletsSegEstadoToken(mov, mov.red) === "imitacion"
            const sospechoso = !imitacion && Boolean(mov.contrato) && walletsSegEsSospechoso(mov, mov.red)
            return `
            <li class="walletsSegMovimiento walletsSegMov-${escapeHtml(mov.tipo)}">
                <span class="walletsSegMovTipo">${escapeHtml(walletsSegTextoTipo(mov))}${varias ? ` · ${escapeHtml(mov.alias)}` : ""} · ${escapeHtml(walletsSegFecha(mov.fecha))}${imitacion ? ` <span class="walletsSegMovImitacion" title="${escapeHtml(WALLETS_SEG_ESTADOS_TOKEN.imitacion.titulo)}">Imitación</span>` : ""}${sospechoso ? ` <span class="walletsSegTokenSospechoso" title="${escapeHtml(WALLETS_SEG_TITULO_SOSPECHOSO)}">Sospechoso</span>` : ""}</span>
                <span class="walletsSegMovCantidad">${mov.tipo === "enviada" ? "−" : mov.tipo === "recibida" ? "+" : ""}${walletsSegNumero(mov.cantidad)} ${escapeHtml(mov.simbolo)}</span>
            </li>`
        })
        .join("")}</ul>`
}

// Lo que hay dentro del seguimiento: la moneda de cada red y los tokens ya leídos
// en el detalle, sumados por moneda (o por contrato), de más a menos valor. Las
// imitaciones no cuentan: llevan el nombre de otro activo pero no valen como él.
function walletsSegActivosGrupo(grupo) {
    const activos = new Map()
    const sumar = (clave, simbolo, cantidad, valorEur) => {
        const actual = activos.get(clave) || { simbolo, cantidad: 0, euros: null, token: false }
        actual.cantidad += cantidad
        if (valorEur !== null) actual.euros = (actual.euros || 0) + valorEur
        activos.set(clave, actual)
        return actual
    }
    for (const wallet of grupo.wallets) {
        const saldo = parseLooseNumber(wallet.saldo)
        const simbolo = walletsSegRed(wallet)?.simbolo || wallet.red
        if (saldo !== null) sumar(simbolo, simbolo, saldo, parseLooseNumber(wallet.valorEur))
        for (const token of walletsSegTokensLeidos.get(wallet.id) || []) {
            const cantidad = parseLooseNumber(token.cantidad)
            if (!cantidad || walletsSegEstadoToken(token, wallet.red) === "imitacion") continue
            const { valorEur } = walletsSegTokenVisible(token)
            sumar(`${wallet.red}:${token.contrato}`, token.simbolo, cantidad, parseLooseNumber(valorEur)).token = true
        }
    }
    return [...activos.values()].sort((a, b) => (b.euros ?? -1) - (a.euros ?? -1))
}

function walletsSegActivosHtml(grupo) {
    const activos = walletsSegActivosGrupo(grupo)
    if (!activos.length) return ""
    const fichas = activos.slice(0, WALLETS_SEG_ACTIVOS_VISIBLES).map((activo) => {
        const euros = walletsSegEuros(activo.euros)
        return `
            <li class="walletsSegActivo${activo.token ? " walletsSegActivo-token" : ""}" title="${escapeHtml(`${walletsSegCantidadExacta(activo.cantidad)} ${activo.simbolo}${activo.token ? " (token)" : ""}`)}">
                <strong>${walletsSegNumero(activo.cantidad)} ${escapeHtml(activo.simbolo)}</strong>
                ${euros ? `<span>${escapeHtml(euros)}</span>` : ""}
            </li>`
    })
    const resto = activos.length - WALLETS_SEG_ACTIVOS_VISIBLES
    if (resto > 0) fichas.push(`<li class="walletsSegActivo walletsSegActivoResto">+${resto}</li>`)
    return `<ul class="walletsSegActivos">${fichas.join("")}</ul>`
}

// «2 wallets · Bitcoin, Ethereum»: el número y las redes, sin repetirlas.
function walletsSegRedesGrupo(grupo) {
    const numero = grupo.wallets.length
    const redes = [...new Set(grupo.wallets.map((wallet) => walletsSegRed(wallet)?.nombre || wallet.red))]
    return `${numero} wallet${numero === 1 ? "" : "s"} · ${redes.join(", ")}`
}

function walletsSegAccionesGrupoHtml(grupo, conDetalle) {
    const clave = escapeHtml(grupo.clave)
    return `
        ${conDetalle ? `<button type="button" class="cancelButton walletsSegVerBtn" data-seguimiento="${clave}">Ver detalle</button>` : ""}
        <button type="button" class="cancelButton walletsSegActualizarGrupoBtn" data-seguimiento="${clave}">Actualizar</button>
        <button type="button" class="cancelButton walletsSegAnadirBtn" data-seguimiento="${clave}"${grupo.propia && !walletsEstado.cifradoDisponible ? " disabled" : ""}>Añadir wallet</button>
        <button type="button" class="cancelButton walletsSegEditarBtn" data-seguimiento="${clave}" title="Nombre, direcciones y claves de este seguimiento">Editar</button>
        ${grupo.propia ? `<button type="button" class="primaryButton walletsSegSincronizarGrupoBtn" data-seguimiento="${clave}" title="Importa los movimientos de todas sus wallets a Cripto › Transacciones">Sincronizar</button>` : ""}
        <button type="button" class="dangerButton walletsSegDejarBtn" data-seguimiento="${clave}" title="Desenlaza todas sus wallets">${grupo.propia ? "Desenlazar todas" : "Dejar de seguir"}</button>`
}

// Vista previa compacta: total, qué monedas y tokens hay y los últimos movimientos.
// Añadir wallet y Editar se quedan en el detalle, que se abre pulsando la tarjeta.
// Lo que ha ido mal en la vigilancia de estas wallets, que corre en otro proceso.
function walletsSegAlertasLectura(wallets) {
    const alertas = []
    const conError = wallets.filter((wallet) => wallet.ultimoError)
    if (conError.length) {
        const prefijo = wallets.length > 1 ? `${conError.length} de ${wallets.length}: ` : ""
        alertas.push(
            `Sin leer desde ${walletsSegFecha(conError[0].ultimoErrorFecha)} · ${prefijo}${conError[0].ultimoError}`
        )
    }
    if (wallets.some((wallet) => wallet.lecturaIncompleta)) {
        alertas.push("Muchos movimientos entre revisiones: algunos pueden no haberse leído ni avisado")
    }
    const sinEntregar = wallets.reduce((suma, wallet) => suma + (Number(wallet.avisosReintento) || 0), 0)
    if (sinEntregar)
        alertas.push(
            `${sinEntregar} aviso${sinEntregar === 1 ? "" : "s"} sospechoso${sinEntregar === 1 ? "" : "s"} sin entregar: se reintenta en la próxima revisión`
        )
    // Las imitaciones no se importan nunca: no hay nada que verificar.
    const porVerificar = wallets.reduce(
        (suma, wallet) =>
            suma +
            (wallet.recientes || []).filter(
                (mov) => walletsSegEsPendiente(mov) && walletsSegEstadoToken(mov, wallet.red) !== "imitacion"
            ).length,
        0
    )
    if (porVerificar) {
        alertas.push(
            `${porVerificar} entrada${porVerificar === 1 ? "" : "s"} de dinero por verificar: abre el movimiento y elige «Entrada real» o «Entre mis wallets». Hasta entonces no ${porVerificar === 1 ? "cuenta" : "cuentan"} en la posición`
        )
    }
    return alertas
}

function walletsSegAlertasHtml(wallets) {
    return walletsSegAlertasLectura(wallets)
        .map((alerta) => `<p class="walletsSegAlerta">${escapeHtml(alerta)}</p>`)
        .join("")
}

function walletsSegTarjetaHtml(grupo) {
    const resumen = walletsSegResumenGrupo(grupo)
    const clave = escapeHtml(grupo.clave)
    return `
        <article class="walletsSegTarjeta walletsSegTarjetaCompacta ${grupo.propia ? "walletsSegTarjeta-propia" : "walletsSegTarjeta-ajena"}" data-seguimiento="${clave}" title="Pulsa para ver el detalle">
            <header class="walletsSegTarjetaCabecera">
                <div>
                    <h4>${escapeHtml(grupo.nombre)} <span class="mTypeBadge">${grupo.propia ? "Mía" : "Ajena"}</span></h4>
                    <span class="walletsSegDato">${escapeHtml(walletsSegRedesGrupo(grupo))}</span>
                </div>
                <div class="walletsSegSaldo">
                    <strong>${escapeHtml(resumen.euros || resumen.saldos || "—")}</strong>
                </div>
            </header>
            ${walletsSegAlertasHtml(grupo.wallets)}
            ${walletsSegActivosHtml(grupo)}
            ${walletsSegMovimientosHtml(grupo)}
            <footer class="walletsSegTarjetaPie">
                <span class="walletsSegDato">Leído ${escapeHtml(walletsSegFecha(resumen.saldoFecha))}</span>
                <span class="walletsSegTarjetaAcciones">
                    <button type="button" class="cancelButton walletsSegActualizarGrupoBtn" data-seguimiento="${clave}">Actualizar</button>
                    ${grupo.propia ? `<button type="button" class="primaryButton walletsSegSincronizarGrupoBtn" data-seguimiento="${clave}" title="Importa los movimientos de todas sus wallets a Cripto › Transacciones">Sincronizar</button>` : ""}
                </span>
            </footer>
        </article>`
}

function manejarClickSeguimiento(event) {
    const plegar = event.target.closest(".walletsSegPlegarBtn")
    if (plegar) {
        plegarSeccionSeguimiento(plegar)
        return
    }
    const actualizar = event.target.closest(".walletsSegActualizarUnaBtn")
    if (actualizar) {
        actualizarWalletSeguimiento(actualizar.dataset.walletId, actualizar)
        return
    }
    const actualizarGrupo = event.target.closest(".walletsSegActualizarGrupoBtn")
    if (actualizarGrupo) {
        actualizarSeguimiento(actualizarGrupo.dataset.seguimiento, actualizarGrupo)
        return
    }
    const anadir = event.target.closest(".walletsSegAnadirBtn")
    if (anadir) {
        abrirWalletsEnlazadas("seguimiento", anadir.dataset.seguimiento)
        return
    }
    const editar = event.target.closest(".walletsSegEditarBtn")
    if (editar) {
        abrirEditarSeguimiento(editar.dataset.seguimiento)
        return
    }
    const sincronizarGrupo = event.target.closest(".walletsSegSincronizarGrupoBtn")
    if (sincronizarGrupo) {
        sincronizarSeguimiento(sincronizarGrupo.dataset.seguimiento, sincronizarGrupo)
        return
    }
    const dejar = event.target.closest(".walletsSegDejarBtn")
    if (dejar) {
        confirmarDejarSeguimiento(dejar.dataset.seguimiento)
        return
    }
    const sincronizar = event.target.closest(".walletsSincronizarBtn")
    if (sincronizar) {
        sincronizarWallet(sincronizar)
        return
    }
    const atajo = event.target.closest(".walletsSegAtajoBtn")
    if (atajo) {
        cambiarAtajoAvisos(atajo)
        return
    }
    const atajoTodas = event.target.closest(".walletsSegAtajoTodasBtn")
    if (atajoTodas) {
        cambiarAtajoTodas(atajoTodas)
        return
    }
    const desenlazar = event.target.closest(".walletsDesenlazarBtn")
    if (desenlazar) {
        confirmarDesenlazarWallet(desenlazar.dataset.walletId)
        return
    }
    const verificarToken = event.target.closest(".walletsSegTokenVerificarBtn")
    if (verificarToken) {
        confirmarVerificarToken(verificarToken.dataset)
        return
    }
    const olvidarToken = event.target.closest(".walletsSegTokenOlvidarBtn")
    if (olvidarToken) {
        confirmarOlvidarToken(olvidarToken.dataset)
        return
    }
    const legitimoToken = event.target.closest(".walletsSegTokenLegitimoBtn")
    if (legitimoToken) {
        confirmarTokenLegitimo(legitimoToken.dataset)
        return
    }
    const imitacionToken = event.target.closest(".walletsSegTokenImitacionBtn")
    if (imitacionToken) {
        const { red, contrato } = imitacionToken.dataset
        guardarTokenVerificado("/api/wallets/tokens/marcar", { red, contrato, marca: "imitacion" })
        return
    }
    const desmarcarToken = event.target.closest(".walletsSegTokenDesmarcarBtn")
    if (desmarcarToken) {
        const { red, contrato } = desmarcarToken.dataset
        guardarTokenVerificado("/api/wallets/tokens/desmarcar", { red, contrato })
        return
    }
    const sospechosoToken = event.target.closest(".walletsSegTokenSospechosoBtn")
    if (sospechosoToken) {
        const { red, contrato, sospechoso } = sospechosoToken.dataset
        guardarTokenVerificado("/api/wallets/tokens/sospechoso", { red, contrato, sospechoso: sospechoso === "true" })
        return
    }
    const precioToken = event.target.closest(".walletsSegTokenPrecioBtn")
    if (precioToken) {
        abrirPrecioToken(precioToken.dataset)
        return
    }
    const quitarPrecio = event.target.closest(".walletsSegTokenPrecioQuitarBtn")
    if (quitarPrecio) {
        const { red, contrato } = quitarPrecio.dataset
        guardarPrecioToken("/api/wallets/tokens/precio/quitar", { red, contrato })
        return
    }
    const copiable = event.target.closest(".walletsSegMovHash, .walletsSegCopiable")
    if (copiable && typeof copyHashTransaccionToClipboard === "function") {
        copyHashTransaccionToClipboard(copiable)
        return
    }
    if (event.target.closest(".walletsSegVolverBtn")) {
        cerrarDetalleSeguimiento()
        return
    }
    const navegar = event.target.closest(".walletsSegNavBtn")
    if (navegar) {
        navegarDetalleSeguimiento(Number(navegar.dataset.dir))
        return
    }
    // Antes que .walletsSegFiltro: comparte su clase para el estilo.
    const redBtn = event.target.closest(".walletsSegRedBtn")
    if (redBtn) {
        cambiarRedSeguimiento(redBtn.dataset.red)
        return
    }
    const filtro = event.target.closest(".walletsSegFiltro")
    if (filtro && walletsSegDetalle) {
        walletsSegDetalle.filtro = filtro.dataset.filtro
        renderDetalleSeguimiento()
        return
    }
    const calendario = event.target.closest(".walletsSegFechaBtn")
    if (calendario) {
        // Dentro de un <label>: sin esto el clic también enfocaría el input.
        event.preventDefault()
        abrirCalendarioFecha(calendario.closest("label").querySelector(".walletsSegFechaInput"), calendario)
        return
    }
    if (event.target.closest(".walletsSegFechasQuitarBtn") && walletsSegDetalle) {
        walletsSegDetalle.fechaDesde = ""
        walletsSegDetalle.fechaHasta = ""
        renderDetalleSeguimiento()
        return
    }
    if (event.target.closest(".walletsSegMasBtn")) {
        cargarHistorialDetalle()
        return
    }
    if (event.target.closest(".walletsSegReleerBtn")) {
        releerHistorialDetalle()
        return
    }
    if (event.target.closest(".walletsSegGrafoBtn")) {
        abrirGrafoSeguimiento()
        return
    }
    const pestana = event.target.closest(".walletsSegPestana")
    if (pestana) {
        cambiarPestanaSeguimiento(pestana.dataset.pestana)
        return
    }
    if (event.target.closest(".walletsSegUtxosCargarBtn")) {
        cargarUtxosDetalle()
        return
    }
    if (event.target.closest(".walletsSegTokensCargarBtn")) {
        cargarTokensDetalle()
        return
    }
    const utxo = event.target.closest(".walletsSegUtxo[data-indice]")
    if (utxo && walletsSegDetalle?.utxos) {
        abrirUtxoSeguimiento(walletsSegDetalle.utxos.visibles?.[Number(utxo.dataset.indice)])
        return
    }
    const fila = event.target.closest(".walletsSegFilaMov")
    // El desplegable ··· está dentro de la fila: un clic en su borde no la abre.
    if (fila && !event.target.closest("button, a, .rowMenu") && walletsSegDetalle) {
        abrirMovimientoSeguimiento(walletsSegDetalle.visibles?.[Number(fila.dataset.indice)])
        return
    }
    // Ver detalle: el botón o cualquier parte de la tarjeta que no sea un control.
    const ver = event.target.closest(".walletsSegVerBtn")
    const tarjeta = event.target.closest("#walletsSegLista .walletsSegTarjeta")
    if (ver || (tarjeta && !event.target.closest("button, input, label, a"))) {
        abrirDetalleSeguimiento((ver || tarjeta).dataset.seguimiento)
    }
}

// ── Tokens verificados ────────────────────────────────────────────────────────
// Se guardan en el servidor (con las wallets, cifrados) porque deciden qué se
// importa a Transacciones; aquí solo se piden y se repinta con la lista nueva.

// Movimientos leídos de una red: el historial del detalle abierto, o los
// recientes de todas las wallets si se ve la lista.
function walletsSegMovimientosDeRed(redClave) {
    const grupo = walletsSegDetalle && walletsSegGrupo(walletsSegDetalle.clave)
    const movimientos = grupo
        ? walletsSegMovimientosDetalle(walletsSegDetalle, grupo)
        : walletsEstado.wallets.flatMap((wallet) =>
              (wallet.recientes || []).map((mov) => ({ ...mov, walletId: wallet.id }))
          )
    return movimientos.filter((mov) => walletsSegRedDeMovimiento(mov) === redClave)
}

// Señales de que un token puede no ser el auténtico, sacadas de lo ya leído:
// ninguna lo prueba, pero juntas avisan antes de anclar un símbolo a una copia.
function walletsSegSenalesToken(redClave, contrato, simbolo) {
    const esqueleto = walletsSegEsqueletoSimbolo(simbolo)
    const delSimbolo = walletsSegMovimientosDeRed(redClave).filter(
        (mov) => mov.contrato && walletsSegEsqueletoSimbolo(mov.simbolo) === esqueleto
    )
    const senales = []
    const otros = new Set(delSimbolo.map((mov) => mov.contrato).filter((c) => c !== contrato))
    if (otros.size) {
        senales.push(
            `En los movimientos leídos hay ${otros.size} contrato${otros.size === 1 ? "" : "s"} más con el símbolo ${esqueleto}: solo uno puede ser el auténtico.`
        )
    }
    if (/[^\x20-\x7E]/.test(simbolo)) {
        senales.push(`El símbolo lleva caracteres que no son letras normales: es un truco habitual de las copias.`)
    }
    const propios = delSimbolo.filter((mov) => mov.contrato === contrato)
    if (propios.length && propios.every((mov) => mov.tipo === "recibida")) {
        senales.push(`Solo lo has recibido, nunca enviado: los tokens que llegan sin pedirlos suelen ser spam.`)
    }
    return senales
}

function confirmarVerificarToken({ red: redClave, contrato, simbolo }) {
    const red = walletsEstado.redes.find((r) => r.clave === redClave)
    const esqueleto = walletsSegEsqueletoSimbolo(simbolo)
    const yaHay = (walletsEstado.tokensVerificados || []).some(
        (token) => token.red === redClave && walletsSegEsqueletoSimbolo(token.simbolo) === esqueleto
    )
    const senales = walletsSegSenalesToken(redClave, contrato, simbolo)
    openConfirmModal({
        title: `Verificar ${simbolo}`,
        message:
            `Contrato: ${contrato} (${red?.nombre || redClave}). Compáralo carácter a carácter con el de la web oficial ` +
            `del proyecto o de CoinGecko/CoinMarketCap, no solo el principio y el final. ` +
            (senales.length ? `Atención: ${senales.join(" ")} ` : "") +
            (yaHay
                ? `Se añadirá a los contratos de ${simbolo} que ya verificaste.`
                : `Desde ahora, cualquier otro ${simbolo} de esa red se marcará como imitación y no se importará a Transacciones.`),
        confirmLabel: "Verificar",
        onConfirm: () => guardarTokenVerificado("/api/wallets/tokens/verificar", { red: redClave, contrato, simbolo })
    })
}

function confirmarOlvidarToken({ red: redClave, contrato, simbolo }) {
    openConfirmModal({
        title: `Quitar la verificación de ${simbolo}`,
        message:
            `${contrato} dejará de ser el ${simbolo} verificado. Si no queda ningún otro, ` +
            `los ${simbolo} de esa red volverán a importarse por el símbolo. Lo ya importado no cambia.`,
        confirmLabel: "Quitar",
        onConfirm: () => guardarTokenVerificado("/api/wallets/tokens/olvidar", { red: redClave, contrato })
    })
}

// Desmentir una imitación sí se confirma: a partir de ahí el token se importa.
// Marcar una imitación o deshacer una marca no, porque no importa nada nuevo.
function confirmarTokenLegitimo({ red: redClave, contrato, simbolo }) {
    const red = walletsEstado.redes.find((r) => r.clave === redClave)
    const senales = walletsSegSenalesToken(redClave, contrato, simbolo)
    openConfirmModal({
        title: `${simbolo} no es una imitación`,
        message:
            `Contrato: ${contrato} (${red?.nombre || redClave}). Compruébalo antes en el explorador. ` +
            (senales.length ? `Atención: ${senales.join(" ")} ` : "") +
            (walletsSegEsNombreDeLaRed(redClave, simbolo)
                ? `Dejará de marcarse como imitación, pero no se sumará nunca a la moneda de la red.`
                : `Dejará de marcarse como imitación y se importará a Transacciones por su símbolo, ` +
                  `como un token sin verificar. «Deshacer» vuelve a la detección automática.`),
        confirmLabel: "No es imitación",
        onConfirm: () =>
            guardarTokenVerificado("/api/wallets/tokens/marcar", { red: redClave, contrato, marca: "legitimo" })
    })
}

async function guardarTokenVerificado(url, cuerpo) {
    try {
        const datos = await walletsPost(url, cuerpo)
        walletsSegAplicarTokens(datos)
        renderWalletsSeguimiento()
    } catch (error) {
        showToast(error.message || "No se pudo guardar el token", { type: "error" })
    }
}

function walletsSegAplicarTokens(datos) {
    walletsEstado.tokensVerificados = datos.tokensVerificados || []
    walletsEstado.tokensMarcados = datos.tokensMarcados || []
    walletsEstado.tokensSospechosos = datos.tokensSospechosos || []
    walletsEstado.preciosToken = datos.preciosToken || []
}

// ── Ticker de precio de un token ──────────────────────────────────────────────
// Para los tokens sin activo en Activos. Se guarda en el servidor, que lo usa
// para el valor del visor y para la lista «Seguimiento» de la Watchlist.

// `buscar` envuelve en una función a los buscadores de js/cartera/assets-ficha.js
// para resolverlos al usarlos, no al cargar este archivo.
const WALLETS_SEG_PROVEEDORES_PRECIO = {
    tradingview: {
        nombre: "TradingView",
        ejemplo: "BINANCE:PEPEUSDT",
        buscar: (datos) => handleTradingViewSearch(datos)
    },
    finnhub: { nombre: "Finnhub", ejemplo: "BINANCE:PEPEUSDT", buscar: (datos) => handleFinnhubSearch(datos) },
    eodhd: { nombre: "EODHD", ejemplo: "PEPE-USD.CC", buscar: (datos) => handleEodhdSearch(datos) },
    yahoo: { nombre: "Yahoo Finance", ejemplo: "PEPE24478-USD", buscar: (datos) => handleYahooSearch(datos) },
    alphavantage: { nombre: "Alpha Vantage", ejemplo: "", buscar: (datos) => handleAlphaVantageSearch(datos) }
}

function abrirPrecioToken({ red: redClave, contrato, simbolo }) {
    abrirVentanaTicker({
        titulo: `Ticker de precio de ${simbolo}`,
        texto: `Contrato ${contrato}. Con este ticker se calcula su valor y se cotiza en la lista «Seguimiento» de la Watchlist.`,
        simbolo,
        actual: walletsSegPrecioToken({ contrato }, redClave),
        guardarTicker: (proveedor, ticker) =>
            guardarPrecioToken("/api/wallets/tokens/precio", { red: redClave, contrato, proveedor, ticker }, false)
    })
}

// Ventana de proveedor y ticker, compartida con la Watchlist (js/analisis/seguimiento.js).
// `guardarTicker(proveedor, ticker)` devuelve el mensaje de error, o "" si se guardó.
// `simbolo` es lo que se busca mientras el campo del ticker esté vacío.
function abrirVentanaTicker({ titulo, texto, simbolo = "", actual, guardarTicker }) {
    document.getElementById("walletsSegPrecioOverlay")?.remove()
    // El orden y el de por defecto (el primero, TradingView) los manda el servidor.
    const claves = walletsEstado.proveedoresPrecio || Object.keys(WALLETS_SEG_PROVEEDORES_PRECIO)
    const proveedor = actual?.proveedor || claves[0]
    const opciones = claves
        .map(
            (clave) =>
                `<option value="${escapeHtml(clave)}"${clave === proveedor ? " selected" : ""}>${escapeHtml(WALLETS_SEG_PROVEEDORES_PRECIO[clave]?.nombre || clave)}</option>`
        )
        .join("")
    const overlay = document.createElement("div")
    overlay.id = "walletsSegPrecioOverlay"
    overlay.className = "modalOverlay"
    overlay.innerHTML = `
        <div class="assetModal" role="dialog" aria-modal="true" aria-labelledby="walletsSegPrecioTitulo">
            <h3 class="assetModalTitle" id="walletsSegPrecioTitulo">${escapeHtml(titulo)}</h3>
            <p class="assetModalHint">${escapeHtml(texto)}</p>
            <label class="assetModalLabel" for="walletsSegPrecioProveedor">Proveedor</label>
            <select id="walletsSegPrecioProveedor" class="assetModalSelect">${opciones}</select>
            <label class="assetModalLabel" for="walletsSegPrecioTicker">Ticker</label>
            <input id="walletsSegPrecioTicker" class="assetModalInput" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(actual?.ticker || "")}">
            <div class="assetSearchActions">
                <button type="button" class="secondaryButton" id="walletsSegPrecioBuscar"></button>
            </div>
            <div class="assetSearchFeedback hidden" id="walletsSegPrecioFeedback"></div>
            <div class="assetSearchResults hidden" id="walletsSegPrecioResultados"></div>
            <p class="gastosCreateModalFeedback hidden" id="walletsSegPrecioError"></p>
            <div class="assetModalActions">
                <button type="button" class="cancelButton" id="walletsSegPrecioCancelar">Cancelar</button>
                <button type="button" class="primaryButton" id="walletsSegPrecioGuardar" data-no-autohide="true">Guardar</button>
            </div>
        </div>`
    const select = overlay.querySelector("#walletsSegPrecioProveedor")
    const input = overlay.querySelector("#walletsSegPrecioTicker")
    const errorEl = overlay.querySelector("#walletsSegPrecioError")
    const guardar = overlay.querySelector("#walletsSegPrecioGuardar")
    const ponerEjemplo = () => {
        const ejemplo = WALLETS_SEG_PROVEEDORES_PRECIO[select.value]?.ejemplo
        input.placeholder = ejemplo ? `Ej: ${ejemplo}` : "Ticker en ese proveedor"
    }
    const cerrar = () => overlay.remove()
    const confirmar = async () => {
        const ticker = input.value.trim()
        if (!ticker) {
            errorEl.textContent = "Escribe el ticker."
            errorEl.classList.remove("hidden")
            return
        }
        guardar.disabled = true
        // El servidor comprueba que cotiza antes de guardarlo: el error se queda en la ventana.
        const error = await guardarTicker(select.value, ticker)
        guardar.disabled = false
        if (error) {
            errorEl.textContent = error
            errorEl.classList.remove("hidden")
            return
        }
        cerrar()
    }
    select.addEventListener("change", ponerEjemplo)
    overlay.querySelector("#walletsSegPrecioCancelar").addEventListener("click", cerrar)
    guardar.addEventListener("click", confirmar)
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") confirmar()
        if (event.key === "Escape") cerrar()
    })
    ponerEjemplo()
    activarBusquedaTicker(overlay, simbolo)
    document.body.appendChild(overlay)
    input.focus()
}

// Búsqueda con previsualización de la ventana del ticker: mismas tarjetas de precio
// y variación que al añadir un activo. Va con botón y no al teclear porque cada
// búsqueda gasta cuota del proveedor.
function activarBusquedaTicker(overlay, simbolo) {
    const select = overlay.querySelector("#walletsSegPrecioProveedor")
    const input = overlay.querySelector("#walletsSegPrecioTicker")
    const boton = overlay.querySelector("#walletsSegPrecioBuscar")
    const feedback = overlay.querySelector("#walletsSegPrecioFeedback")
    const resultados = overlay.querySelector("#walletsSegPrecioResultados")
    const errorEl = overlay.querySelector("#walletsSegPrecioError")
    const nombreProveedor = () => WALLETS_SEG_PROVEEDORES_PRECIO[select.value]?.nombre || select.value
    const ponerBoton = () => {
        boton.textContent = `Buscar ${nombreProveedor()}`
    }
    const limpiar = () => {
        setAssetSearchFeedback(feedback, "")
        renderMarketSearchResults(resultados, [], () => {})
    }
    // La tarjeta elegida se queda a la vista: es la previsualización de lo que se va
    // a guardar. El cambio de proveedor va primero porque su evento limpia la búsqueda.
    const elegir = (resultado) => {
        const proveedor = String(resultado.provider || "")
            .trim()
            .toLowerCase()
        if (proveedor && proveedor !== select.value && WALLETS_SEG_PROVEEDORES_PRECIO[proveedor]) {
            select.value = proveedor
            select.dispatchEvent(new Event("change", { bubbles: true }))
        }
        input.value = resultado.symbol
        errorEl.classList.add("hidden")
        const sinCotizacion = String(resultado.price || "").trim() === ""
        const aviso = sinCotizacion ? " — sin cotización disponible" : ""
        setAssetSearchFeedback(
            feedback,
            `Ticker seleccionado (${nombreProveedor()}): ${resultado.symbol}${aviso}`,
            sinCotizacion
        )
        renderMarketSearchResults(resultados, [resultado], elegir)
    }
    const buscar = async () => {
        boton.disabled = true
        try {
            await WALLETS_SEG_PROVEEDORES_PRECIO[select.value]?.buscar?.({
                query: input.value.trim() || simbolo,
                assetType: "cripto",
                feedbackElement: feedback,
                resultsElement: resultados,
                onSelect: elegir
            })
        } finally {
            boton.disabled = false
        }
    }
    select.addEventListener("change", () => {
        ponerBoton()
        limpiar()
    })
    // Lo que se ve debajo deja de corresponder al ticker en cuanto se edita a mano.
    input.addEventListener("input", limpiar)
    boton.addEventListener("click", buscar)
    ponerBoton()
}

// Devuelve el mensaje de error, o "" si se guardó. Con los tokens ya leídos se
// vuelven a leer: el valor en euros lo calcula el servidor con el ticker.
// `avisar`: sacar el error como toast (la ventana del ticker lo enseña dentro).
async function guardarPrecioToken(url, cuerpo, avisar = true) {
    try {
        walletsSegAplicarTokens(await walletsPost(url, cuerpo))
    } catch (error) {
        const mensaje = error.message || "No se pudo guardar el ticker"
        if (avisar) showToast(mensaje, { type: "error" })
        return mensaje
    }
    renderWalletsSeguimiento()
    if (walletsSegDetalle?.tokens && !walletsSegDetalle.tokens.cargando) cargarTokensDetalle()
    return ""
}

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
            nota: `Incluye ${importe(mov.comisionExchange, mov.simbolo)} del exchange; se descuenta de la posición`
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
        // Fuera de la ventana cierra; dentro, solo el botón.
        if (event.target === overlay || event.target.closest(".walletsSegMovCerrarBtn")) {
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
}

function walletsSegTeclaMovimiento(event) {
    if (event.key === "Escape") cerrarMovimientoSeguimiento()
}

function cerrarMovimientoSeguimiento() {
    document.removeEventListener("keydown", walletsSegTeclaMovimiento)
    document.getElementById("walletsSegMovOverlay")?.remove()
}

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

// Por defecto se marcan las dos; una transacción ya marcada conserva lo que se
// eligió, para que al cambiar su comisión no se dé de alta la dirección del exchange.
function walletsSegMarcarOtraPorDefecto(mov) {
    return mov.marcaMovimiento !== "propia" || mov.contraparteMarca === "propia"
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

function walletsSegComisionCampoHtml(mov, etiqueta, placeholder, valor) {
    return `
        <label class="walletsSegContraApodo">
            <span>${escapeHtml(etiqueta)} (${escapeHtml(mov.simbolo)})</span>
            <input type="text" inputmode="decimal" class="assetRowModalInput walletsSegMarcaMovComision" maxlength="40" autocomplete="off"
                placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(valor)}">
        </label>`
}

// La parte de la red que se descuenta en un recibo. En Bitcoin con origen ajeno es
// la de todo el lote del exchange, y en un token se paga en otra moneda: no suma.
function walletsSegComisionRedQueCuenta(mov, wallet, origenPropio = walletsSegOrigenEsPropio(mov)) {
    const leida = mov.comisionLeida ?? mov.comision ?? ""
    if (leida) return leida
    return !mov.contrato && (wallet.red !== "btc" || origenPropio) ? mov.comisionTx || "" : ""
}

// Lo que se envía al marcar: el servidor suma las dos partes, con decimales exactos.
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
    // Un origen ya propio sigue siéndolo: una dirección de exchange también puede serlo.
    marcarMovimientoSeguimiento(mov, wallet, true, { marcarOtra: walletsSegOrigenEsPropio(mov) })
}

function walletsSegComisionRedDelApartadoHtml(mov, wallet) {
    if (!mov.comisionTx) return ""
    const simbolo = walletsSegRed(wallet)?.simbolo || ""
    const cuenta = walletsSegComisionRedQueCuenta(mov, wallet)
    const nota = cuenta ? "Fija; se suma a la del exchange" : "La pagó el remitente; no se suma"
    return `<p class="walletsSegDato walletsSegComisionRedFija">Comisión de red: <strong>${escapeHtml(`${walletsSegCantidadExacta(mov.comisionTx)} ${simbolo}`.trim())}</strong> · ${nota}</p>`
}

/**
 * Pinta el apartado para indicar lo que cobró el exchange por una retirada.
 *
 * La comisión de la red se enseña aparte y no se edita; la del exchange se suma a
 * ella en el total. El campo es el mismo que leen los botones de la clasificación:
 * solo hay uno en la ventana.
 *
 * @param {object} mov Movimiento con la libreta aplicada.
 * @param {object|undefined} wallet Wallet del movimiento.
 * @returns {string} El HTML del apartado; vacío si el movimiento no es un recibo propio.
 */
function walletsSegComisionExchangeHtml(mov, wallet) {
    if (!walletsSegAdmiteComisionExchange(mov, wallet)) return ""
    return `
        <section class="walletsSegContraparte walletsSegComisionExchange" aria-labelledby="walletsSegComisionExchangeTitulo">
            <h4 id="walletsSegComisionExchangeTitulo" class="walletsSegContraTitulo">Comisión del exchange</h4>
            <p class="walletsSegDato">Si retiraste de un exchange, indica lo que te cobró aparte de la comisión de red. Se suma a ella en el total y se resta de la posición. La transacción queda como «Entre mis wallets».</p>
            ${walletsSegComisionRedDelApartadoHtml(mov, wallet)}
            <div class="walletsSegComisionExchangeFila">
                ${walletsSegComisionCampoHtml(mov, "Comisión del exchange", "Ej: 0,000018", mov.comisionExchange || "")}
                <button type="button" class="primaryButton walletsSegComisionExchangeBtn">Aplicar comisión</button>
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
                <span class="walletsSegDato">Desmárcala si pertenece a un exchange. Si queda como tuya, todos sus movimientos, pasados y futuros, contarán como «entre wallets» sin verificación y asumirás su comisión de red.</span>
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

async function marcarMovimientoSeguimiento(mov, wallet, propia, { marcarOtra: forzarOtra } = {}) {
    const valorCampo = document.querySelector("#walletsSegMovOverlay .walletsSegMarcaMovComision")?.value || ""
    const marcarOtra =
        forzarOtra ?? document.querySelector("#walletsSegMovOverlay .walletsSegMarcaMovOtra")?.checked ?? true
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
        return
    }
    walletsSegAplicarLibretaDeMarca(wallet.red, datos)
    walletsSegAplicarMarca(mov, wallet.red, datos.marca)
    await walletsSegRepintarTrasMarcar()
    abrirMovimientoSeguimiento(mov)
    if (datos.avisoReetiquetado) {
        showToast(datos.avisoReetiquetado, { type: "error", duration: 8000 })
        return
    }
    showToast(walletsSegTextoMarcada(datos), { type: "success" })
}

// La marca puede haber dado de alta o sacado direcciones de la libreta.
function walletsSegAplicarLibretaDeMarca(red, datos) {
    if (!datos.efectivas) return
    walletsEstado.direcciones = datos.direcciones || []
    walletsEstado.direccionesEnlazadas = datos.direccionesEnlazadas || []
    for (const [direccion, efectiva] of Object.entries(datos.efectivas))
        walletsSegAplicarLibreta(red, direccion, efectiva)
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
    const datos = await guardarDireccionLibreta("/api/wallets/direcciones/guardar", {
        red: wallet.red,
        direccion: mov.contraparte,
        apodo,
        propia
    })
    if (datos) abrirMovimientoSeguimiento(mov)
}

async function olvidarContraparteMovimiento(mov, wallet) {
    const datos = await guardarDireccionLibreta("/api/wallets/direcciones/olvidar", {
        red: wallet.red,
        direccion: mov.contraparteClave || mov.contraparte
    })
    if (datos) abrirMovimientoSeguimiento(mov)
}

// Repinta sin volver a leer la red: aplica a los movimientos ya leídos de esa
// dirección lo mismo que wallets_libreta.anotar() en el servidor.
function walletsSegAplicarLibreta(red, direccion, efectiva) {
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
}

async function guardarDireccionLibreta(url, cuerpo) {
    let datos
    try {
        datos = await walletsPost(url, cuerpo)
    } catch (error) {
        showToast(error.message || "No se pudo guardar la dirección", { type: "error" })
        return null
    }
    walletsEstado.direcciones = datos.direcciones || []
    walletsEstado.direccionesEnlazadas = datos.direccionesEnlazadas || []
    walletsSegAplicarLibreta(datos.red, datos.direccion, datos.efectiva)
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
    const fallos = await walletsSegActualizarLista(grupo.wallets, `Actualizando «${grupo.nombre}»`)
    await cargarWalletsSeguimiento()
    walletsSegReabrirDetalleSi(grupo.wallets.map((wallet) => wallet.id))
    if (fallos.length) showToast(fallos.join(" · "), { type: "error", duration: 8000 })
    if (boton.isConnected) {
        boton.disabled = false
        boton.textContent = "Actualizar"
    }
}

async function actualizarTodasSeguimiento() {
    const boton = document.getElementById("walletsSegActualizarBtn")
    if (boton) boton.disabled = true
    const fallos = await walletsSegActualizarLista(walletsEstado.wallets, "Actualizando todas las wallets")
    await cargarWalletsSeguimiento()
    if (boton) boton.disabled = false
    if (fallos.length) showToast(fallos.join(" · "), { type: "error", duration: 8000 })
    else showToast("Wallets actualizadas", { type: "success" })
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
    if (boton.isConnected) {
        boton.disabled = false
        boton.textContent = "Sincronizar"
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
