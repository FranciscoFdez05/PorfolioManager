// Ajustes: actualizacion.
//
// Comprobación y aplicación de versiones nuevas. Lo mismo se ve en dos sitios:
// el panel de Ajustes y el desplegable que abre la versión de la barra de
// pestañas. Comparten estado y peticiones; cada sitio es una «vista» con los
// mismos elementos, y pintar es recorrerlas todas. Así una comprobación hecha
// desde uno deja el otro al día sin pedir nada más.
//
// Arranca con la página (y no al abrir Ajustes) porque el punto de «hay
// versión nueva» de la barra tiene que salir sin que nadie entre a mirar.
//
// El botón no actualiza: deja una señal en data/tmp/ que recoge un vigilante
// del host (tools/actualizador/). No puede hacer más —dentro del contenedor no
// hay Docker ni repositorio, y docker-update.sh recrea el contenedor que lo
// ejecutaría, matándolo antes del retroceso automático—.

// Cada cuánto se vuelve a preguntar con la página abierta. El servidor guarda
// la respuesta de GitHub unas horas, así que esto no le cuesta una llamada
// fuera cada vez: solo recoge lo que el servidor ya sepa.
const _UPDATE_REPASO_MS = 60 * 60 * 1000

const _vistasUpdate = []
let _updateIniciado = false
let _versionAlPedir = null
let _sondeoUpdate = null
// Última versión publicada conocida: la usa el modal de confirmación para
// decir a qué se va a actualizar en vez de «a la versión nueva».
let _versionPublicada = null
// true / false / null (no se ha podido saber), tal cual lo dice el servidor.
let _hayVersionNueva = null

function _vistaUpdateAjustes() {
    return {
        version: document.getElementById("ajustesUpdateVersion"),
        publicadaFila: document.getElementById("ajustesUpdatePublicadaFila"),
        publicada: document.getElementById("ajustesUpdatePublicada"),
        etiqueta: document.getElementById("ajustesUpdateEtiqueta"),
        btnTexto: document.getElementById("ajustesUpdateBtnTexto"),
        aviso: document.getElementById("ajustesUpdateAviso"),
        msg: document.getElementById("ajustesUpdateMsg"),
        btn: document.getElementById("ajustesUpdateBtn"),
        checkBtn: document.getElementById("ajustesUpdateCheckBtn")
    }
}

function _vistaUpdatePopover() {
    const raiz = document.getElementById("versionPopover")
    if (!raiz) return null
    const el = (nombre) => raiz.querySelector(`[data-upd="${nombre}"]`)
    return {
        version: el("version"),
        publicadaFila: el("publicadaFila"),
        publicada: el("publicada"),
        etiqueta: el("etiqueta"),
        btnTexto: el("btnTexto"),
        aviso: el("aviso"),
        msg: el("msg"),
        btn: el("btn"),
        checkBtn: el("checkBtn")
    }
}

function _msgUpdate(texto, tipo) {
    for (const vista of _vistasUpdate) showMsg(vista.msg, texto, tipo)
}

function _pintarAvisoUpdate(vista, texto) {
    if (!vista.aviso) return
    vista.aviso.textContent = texto || ""
    vista.aviso.hidden = !texto
}

// Qué versión hay publicada en GitHub. La comprobación es solo eso, una
// lectura: quien actualiza sigue siendo el vigilante del host. Sirve para no
// pagar dos minutos de reinicio cuando no hay nada que traer.
function _leerRemota(remota) {
    _versionPublicada = null
    _hayVersionNueva = null
    if (!remota?.activo || !remota.publicada) return
    _versionPublicada = remota.publicada
    if (remota.hayNueva !== null && remota.hayNueva !== undefined) _hayVersionNueva = Boolean(remota.hayNueva)
}

function _pintarRemota(vista, remota) {
    if (!vista.publicadaFila) return

    if (!remota || !remota.activo) {
        vista.publicadaFila.hidden = true
        return
    }

    vista.publicadaFila.hidden = false

    if (!remota.publicada) {
        // Sin dato y con error: se dice, en vez de dejar un guion mudo que
        // se confunde con «no hay versión nueva».
        vista.publicada.textContent = "no se pudo comprobar"
        vista.publicadaFila.title = remota.error || ""
        vista.etiqueta.hidden = true
        return
    }

    vista.publicada.textContent = remota.publicada
    // Con error y dato a la vez, el dato es el de la última comprobación
    // que sí funcionó: se enseña, pero diciendo de cuándo es.
    vista.publicadaFila.title = remota.error
        ? `${remota.error}. Último dato del ${new Date(remota.comprobado).toLocaleString()}`
        : ""

    if (_hayVersionNueva === null) {
        vista.etiqueta.hidden = true
        return
    }

    vista.etiqueta.hidden = false
    vista.etiqueta.textContent = _hayVersionNueva ? "Hay actualización" : "Al día"
    vista.etiqueta.classList.toggle("hayNueva", _hayVersionNueva)
}

function _textoAvisoUpdate(datos) {
    if (!datos.vigilanteVisto) {
        // Sin vigilante instalado, la señal se queda ahí para siempre. Un
        // botón que gira sin fin es peor que decir que no está montado.
        return (
            "El vigilante del servidor no da señales de vida: no ha informado de ninguna " +
            "actualización todavía. Mientras no esté instalado (ver tools/actualizador/), " +
            "este botón deja la petición y nadie la recoge; hay que actualizar con " +
            "./docker-update.sh por SSH."
        )
    }
    if (!datos.enMarcha && datos.ultimo?.estado === "fallo") {
        return (
            `La última actualización falló (código ${datos.ultimo.codigo}). La versión anterior ` +
            `sigue en marcha. Detalle: ${datos.ultimo.detalle || "sin detalle"}`
        )
    }
    return ""
}

// El punto de la versión en la barra. Solo con un «sí» claro del servidor:
// sin dato no se sabe si hay algo, y un aviso que salta por un GitHub caído
// acaba por no mirarse.
function _pintarMarcaVersion() {
    const marca = document.getElementById("appVersion")
    if (!marca) return
    marca.classList.toggle("hayNueva", _hayVersionNueva === true)
    marca.title =
        _hayVersionNueva === true
            ? `Hay una versión nueva: la ${_versionPublicada}`
            : "Versión de PorfolioManager"
}

function _pintarUpdate(datos) {
    _leerRemota(datos.remota)
    const aviso = _textoAvisoUpdate(datos)

    for (const vista of _vistasUpdate) {
        if (vista.version) vista.version.textContent = datos.version || "—"
        _pintarRemota(vista, datos.remota)
        if (vista.btnTexto) {
            vista.btnTexto.textContent =
                _hayVersionNueva && _versionPublicada ? `Actualizar a la ${_versionPublicada}` : "Actualizar ahora"
        }
        _pintarAvisoUpdate(vista, aviso)
        if (vista.btn) vista.btn.disabled = Boolean(datos.enMarcha)
        if (vista.checkBtn) vista.checkBtn.disabled = Boolean(datos.enMarcha)
    }

    _pintarMarcaVersion()
    if (datos.enMarcha) _msgUpdate("Actualizando… la aplicación se reiniciará", "")
}

async function _consultarUpdate() {
    try {
        const res = await fetch("/api/actualizacion")
        const datos = await res.json()
        if (datos.ok) _pintarUpdate(datos)
        return datos
    } catch {
        // Durante la actualización el contenedor se para: que la petición
        // falle es la señal de que va en serio, no un error que contar.
        return null
    }
}

function _sondearUpdate() {
    if (_sondeoUpdate) clearInterval(_sondeoUpdate)
    _sondeoUpdate = setInterval(async () => {
        const datos = await _consultarUpdate()
        if (!datos) {
            _msgUpdate("Reiniciando… esperando a que vuelva", "")
            return
        }
        if (datos.version && _versionAlPedir && datos.version !== _versionAlPedir) {
            clearInterval(_sondeoUpdate)
            _sondeoUpdate = null
            _msgUpdate(`Actualizada a la ${datos.version}. Recarga la página.`, "ok")
            return
        }
        if (datos.ultimo?.estado === "fallo") {
            clearInterval(_sondeoUpdate)
            _sondeoUpdate = null
            _msgUpdate("La actualización falló; sigue la versión anterior", "error")
        }
    }, 5000)
}

// Comprobar a mano. La respuesta de GitHub se guarda unas horas, así que sin
// esto habría que esperar a que caducara para ver una versión recién
// publicada; y el botón es además la forma de ver si la comprobación va.
async function _comprobarUpdate() {
    for (const vista of _vistasUpdate) if (vista.checkBtn) vista.checkBtn.disabled = true
    _msgUpdate("Comprobando…", "")
    let enMarcha = false
    try {
        const res = await fetch("/api/actualizacion?refrescar=1")
        const datos = await res.json()
        if (!datos.ok) {
            _msgUpdate("No se pudo comprobar", "error")
            return
        }
        _pintarUpdate(datos)
        // Si la respuesta dice que hay una actualización en marcha, este
        // botón se queda apagado como el otro.
        enMarcha = Boolean(datos.enMarcha)
        const remota = datos.remota
        if (!remota?.activo) {
            _msgUpdate("La comprobación de versión está desactivada", "")
        } else if (remota.error && !remota.publicada) {
            _msgUpdate(remota.error, "error")
        } else if (remota.hayNueva) {
            _msgUpdate(`Hay una versión nueva: la ${remota.publicada}`, "ok")
        } else if (remota.hayNueva === false) {
            _msgUpdate("Estás en la última versión publicada", "ok")
        } else {
            _msgUpdate("No se pudo comparar la versión publicada", "")
        }
    } catch {
        _msgUpdate("Error de red", "error")
    } finally {
        for (const vista of _vistasUpdate) if (vista.checkBtn) vista.checkBtn.disabled = enMarcha
    }
}

function _mensajeConfirmacion() {
    const comun =
        "La aplicación se reiniciará: estarás un par de minutos sin servicio. Si la " +
        "versión nueva no arranca, el servidor vuelve solo a la anterior."

    if (_hayVersionNueva === true) {
        return `Se instalará la ${_versionPublicada}. ${comun} ¿Continuar?`
    }
    if (_hayVersionNueva === false) {
        // Reconstruir la misma versión es legítimo —cambiar .env, rehacer
        // una imagen corrupta— pero que nadie lo haga creyendo que trae algo.
        return (
            `Ya estás en la última publicada (${_versionPublicada}): se volverá a construir ` +
            `la misma versión, sin novedades. ${comun} ¿Continuar?`
        )
    }
    return `Se descargará y construirá la versión nueva. ${comun} ¿Continuar?`
}

function _pedirUpdate() {
    _cerrarVersionPopover()
    openConfirmModal({
        title: "Actualizar la aplicación",
        message: _mensajeConfirmacion(),
        confirmLabel: "Actualizar",
        onConfirm: async () => {
            const botones = (deshabilitar) => {
                for (const vista of _vistasUpdate) if (vista.btn) vista.btn.disabled = deshabilitar
            }
            botones(true)
            _msgUpdate("Solicitando…", "")
            try {
                const res = await fetch("/api/actualizacion", { method: "POST" })
                const datos = await res.json()
                if (!datos.ok) {
                    _msgUpdate(datos.error || "No se pudo solicitar", "error")
                    botones(false)
                    return
                }
                _versionAlPedir = datos.version
                _msgUpdate("Lanzada. Esperando a que el servidor la recoja…", "")
                _sondearUpdate()
            } catch {
                _msgUpdate("Error de red", "error")
                botones(false)
            }
        }
    })
}

// ── Desplegable de la versión ────────────────────────────────────────────────

function _colocarVersionPopover() {
    const marca = document.getElementById("appVersion")
    const popover = document.getElementById("versionPopover")
    if (!marca || !popover) return
    const caja = marca.getBoundingClientRect()
    const ancho = popover.offsetWidth
    // Alineado al borde derecho de la versión, sin salirse de la ventana.
    const izquierda = Math.max(8, Math.min(caja.right - ancho, window.innerWidth - ancho - 8))
    popover.style.top = `${caja.bottom + 6}px`
    popover.style.left = `${izquierda}px`
}

function _abrirVersionPopover() {
    const popover = document.getElementById("versionPopover")
    if (!popover) return
    popover.classList.remove("hidden")
    document.getElementById("appVersion")?.setAttribute("aria-expanded", "true")
    _colocarVersionPopover()
    _consultarUpdate()
}

function _cerrarVersionPopover() {
    const popover = document.getElementById("versionPopover")
    if (!popover || popover.classList.contains("hidden")) return
    popover.classList.add("hidden")
    document.getElementById("appVersion")?.setAttribute("aria-expanded", "false")
}

function _initVersionPopover() {
    const marca = document.getElementById("appVersion")
    const popover = document.getElementById("versionPopover")
    if (!marca || !popover) return

    marca.addEventListener("click", (e) => {
        e.stopPropagation()
        if (popover.classList.contains("hidden")) _abrirVersionPopover()
        else _cerrarVersionPopover()
    })
    document.addEventListener("click", (e) => {
        if (!popover.contains(e.target)) _cerrarVersionPopover()
    })
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") _cerrarVersionPopover()
    })
    window.addEventListener("resize", _cerrarVersionPopover)
    // La barra desplaza en horizontal: al moverla, el desplegable se quedaría
    // colgando de donde estaba la versión.
    marca.closest("nav")?.addEventListener("scroll", _cerrarVersionPopover)
}

// ── Arranque ─────────────────────────────────────────────────────────────────

function _initActualizacion() {
    if (_updateIniciado) return
    _updateIniciado = true

    for (const vista of [_vistaUpdateAjustes(), _vistaUpdatePopover()]) {
        if (!vista) continue
        _vistasUpdate.push(vista)
        vista.checkBtn?.addEventListener("click", _comprobarUpdate)
        vista.btn?.addEventListener("click", _pedirUpdate)
    }

    _initVersionPopover()
    _consultarUpdate()
    setInterval(() => {
        if (!_sondeoUpdate) _consultarUpdate()
    }, _UPDATE_REPASO_MS)
}

// Lo llama initAjustesLogic al abrir Ajustes por primera vez: el panel ya está
// enganchado desde la carga, así que basta con traer el estado al día.
function _initAjustesActualizacion() {
    _initActualizacion()
    _consultarUpdate()
}

document.addEventListener("DOMContentLoaded", _initActualizacion)
