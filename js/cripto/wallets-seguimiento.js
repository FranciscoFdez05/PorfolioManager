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
