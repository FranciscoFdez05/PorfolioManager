// Ajustes: actualizacion.
//
// Comprobación y aplicación de versiones nuevas. Lo mismo se ve en dos sitios:
// el panel de Ajustes y el desplegable que abre la versión de la barra de
// pestañas. Comparten estado y peticiones; cada sitio es una «vista» con los
// mismos elementos, y pintar es recorrerlas todas. Así una comprobación hecha
// desde uno deja el otro al día sin pedir nada más.
//
// Los dos botones de cada vista abren la misma ventana (#updateModalOverlay):
// qué hay publicado, qué trae según el CHANGELOG y, al confirmar, cómo va la
// instalación paso a paso con su barra de progreso.
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
// Mientras se instala: lo bastante seguido para que la barra no se quede
// parada en un paso que ya terminó, sin martillear a un servidor que reinicia.
const _UPDATE_SONDEO_MS = 2000
// Lo mismo que ESPERA_MAXIMA_SEGUNDOS del servidor: pasado esto sin noticias,
// la instalación no va a contar nada más.
const _UPDATE_SIN_NOTICIAS_MS = 15 * 60 * 1000
// El temporizador del vigilante pasa cada 30 s: el doble y algo, y ya es raro.
const _UPDATE_RECOGIDA_LENTA_MS = 75 * 1000

const _vistasUpdate = []
let _updateIniciado = false
let _versionAlPedir = null
let _sondeoUpdate = null
// Última respuesta del servidor: la ventana se abre con ella al instante y se
// repinta cuando llega la siguiente.
let _ultimosDatosUpdate = null
// Última versión publicada conocida: la usa la ventana para decir a qué se va
// a actualizar en vez de «a la versión nueva».
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
        _hayVersionNueva === true ? `Hay una versión nueva: la ${_versionPublicada}` : "Versión de PorfolioManager"
}

function _textoBotonUpdate(enMarcha) {
    if (enMarcha) return "Ver cómo va"
    return _hayVersionNueva && _versionPublicada ? `Actualizar a la ${_versionPublicada}` : "Actualizar ahora"
}

function _pintarUpdate(datos) {
    _ultimosDatosUpdate = datos
    _leerRemota(datos.remota)
    const aviso = _textoAvisoUpdate(datos)
    // Con una instalación en curso el botón no se apaga: abre la ventana con
    // el progreso, que es lo que se quiere ver en ese momento.
    const enMarcha = Boolean(datos.enMarcha) || _updSeguimiento.activo

    for (const vista of _vistasUpdate) {
        if (vista.version) vista.version.textContent = datos.version || "—"
        _pintarRemota(vista, datos.remota)
        if (vista.btnTexto) vista.btnTexto.textContent = _textoBotonUpdate(enMarcha)
        _pintarAvisoUpdate(vista, aviso)
        if (vista.btn) vista.btn.disabled = false
        if (vista.checkBtn) vista.checkBtn.disabled = enMarcha
    }

    _pintarMarcaVersion()
    if (_modalUpdAbierto() && _updModo === "info") _pintarInfoUpdate(datos)
}

async function _consultarUpdate(refrescar = false) {
    try {
        const res = await fetch(refrescar ? "/api/actualizacion?refrescar=1" : "/api/actualizacion")
        const datos = await res.json()
        if (datos.ok) _pintarUpdate(datos)
        return datos
    } catch {
        // Durante la actualización el contenedor se para: que la petición
        // falle es la señal de que va en serio, no un error que contar.
        return null
    }
}

function _mensajeConfirmacion() {
    const comun =
        "La aplicación se reiniciará: estarás un par de minutos sin servicio. Si la " +
        "versión nueva no arranca, el servidor vuelve solo a la anterior."

    if (_hayVersionNueva === true) return `Se instalará la ${_versionPublicada}. ${comun}`
    if (_hayVersionNueva === false) {
        // Reconstruir la misma versión es legítimo —cambiar .env, rehacer
        // una imagen corrupta— pero que nadie lo haga creyendo que trae algo.
        return (
            `Ya estás en la última publicada (${_versionPublicada}): se volverá a construir ` +
            `la misma versión, sin novedades. ${comun}`
        )
    }
    return `Se descargará y construirá la versión nueva. ${comun}`
}

// ── Ventana de actualización ─────────────────────────────────────────────────
//
// Tres modos: «comprobando» (preguntando a GitHub), «info» (qué hay y qué trae,
// con el botón de instalar) y «progreso» (instalando). El progreso no se
// inventa: cada paso lo anuncia docker-update.sh en data/tmp/actualizacion.fase
// y llega con el GET. Lo único estimado es cuánto avanza la barra DENTRO de un
// paso, que se acerca a su final sin llegar mientras el servidor no diga que
// ha pasado al siguiente.

// `peso`: parte de la barra que ocupa. `estimado`: segundos típicos, solo para
// que la barra se mueva dentro del paso. Construir es casi todo el tiempo.
const _UPD_PASOS = [
    { clave: "solicitud", texto: "Enviar la petición", peso: 2, estimado: 2 },
    { clave: "recogida", texto: "El servidor la recoge", peso: 6, estimado: 20 },
    { clave: "descargando", texto: "Descargar el código nuevo", peso: 8, estimado: 10 },
    { clave: "construyendo", texto: "Construir la imagen", peso: 54, estimado: 150 },
    { clave: "levantando", texto: "Reiniciar la aplicación", peso: 12, estimado: 20 },
    { clave: "esperando", texto: "Comprobar que arranca", peso: 14, estimado: 20 },
    { clave: "listo", texto: "Lista", peso: 4, estimado: 1 }
]
const _UPD_IDX = Object.fromEntries(_UPD_PASOS.map((p, i) => [p.clave, i]))
// Fases de docker-update.sh → paso en curso. «comprobando» es el arranque del
// script: la petición ya está recogida.
const _UPD_FASE_A_PASO = {
    comprobando: _UPD_IDX.descargando,
    descargando: _UPD_IDX.descargando,
    construyendo: _UPD_IDX.construyendo,
    levantando: _UPD_IDX.levantando,
    esperando: _UPD_IDX.esperando,
    correcta: _UPD_IDX.listo
}

let _updModo = null
const _updSeguimiento = {
    activo: false,
    // Momento (reloj del servidor) a partir del cual lo que se lee es de esta
    // instalación y no de una anterior.
    desde: null,
    inicio: 0,
    paso: -1,
    inicioPaso: 0,
    duraciones: [],
    resultado: null, // null | "ok" | "fallo"
    detalle: "",
    sinRespuesta: false,
    volviendo: false,
    ticker: null
}

function _modalUpd() {
    const id = (nombre) => document.getElementById(nombre)
    return {
        overlay: id("updateModalOverlay"),
        instalada: id("updModalInstalada"),
        publicada: id("updModalPublicada"),
        resumen: id("updModalResumen"),
        progreso: id("updModalProgreso"),
        barra: id("updModalBarra"),
        relleno: id("updModalBarraRelleno"),
        faseTexto: id("updModalFaseTexto"),
        tiempo: id("updModalTiempo"),
        pasos: id("updModalPasos"),
        aviso: id("updModalAviso"),
        novedadesCaja: id("updModalNovedadesCaja"),
        novedades: id("updModalNovedades"),
        nota: id("updModalNota"),
        cerrarBtn: id("updModalCerrarBtn"),
        comprobarBtn: id("updModalComprobarBtn"),
        actualizarBtn: id("updModalActualizarBtn"),
        recargarBtn: id("updModalRecargarBtn")
    }
}

function _modalUpdAbierto() {
    const overlay = document.getElementById("updateModalOverlay")
    return Boolean(overlay && !overlay.classList.contains("hidden"))
}

function _abrirModalUpd() {
    _cerrarVersionPopover()
    document.getElementById("updateModalOverlay")?.classList.remove("hidden")
}

function _cerrarModalUpd() {
    document.getElementById("updateModalOverlay")?.classList.add("hidden")
    // Cerrar no para nada: la instalación es del servidor, y el sondeo sigue
    // para que el botón y el mensaje de la barra se enteren de cómo acaba.
    if (!_updSeguimiento.activo) _updModo = null
}

function _avisoModalUpd(texto) {
    const m = _modalUpd()
    if (!m.aviso) return
    m.aviso.textContent = texto || ""
    m.aviso.hidden = !texto
}

function _botonesModalUpd({ comprobar = false, actualizar = false, recargar = false, textoActualizar = "" }) {
    const m = _modalUpd()
    m.comprobarBtn.hidden = !comprobar
    m.actualizarBtn.hidden = !actualizar
    m.recargarBtn.hidden = !recargar
    if (textoActualizar) m.actualizarBtn.textContent = textoActualizar
}

function _hace(iso) {
    const ms = Date.now() - Date.parse(iso)
    if (!Number.isFinite(ms)) return ""
    const min = Math.round(ms / 60000)
    if (min < 1) return "hace un momento"
    if (min < 60) return `hace ${min} min`
    const horas = Math.round(min / 60)
    return horas < 24 ? `hace ${horas} h` : new Date(iso).toLocaleString()
}

function _resumenModalUpd(estado, texto, cuando) {
    const m = _modalUpd()
    m.resumen.replaceChildren()
    if (estado) {
        const chip = document.createElement("span")
        chip.className = `ajustesUpdateEtiqueta updateResumenChip ${estado}`
        chip.textContent = estado === "hayNueva" ? "Hay actualización" : estado === "alDia" ? "Al día" : "Sin dato"
        m.resumen.append(chip)
    }
    const span = document.createElement("span")
    span.textContent = texto
    m.resumen.append(span)
    if (cuando) {
        const hora = document.createElement("span")
        hora.className = "updateResumenHora"
        hora.textContent = `Comprobado ${_hace(cuando)}`
        m.resumen.append(hora)
    }
}

// ── Novedades: el CHANGELOG en Markdown, lo justo para leerlo ───────────────

function _mdEnLinea(texto) {
    const seguro = String(texto)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
    return seguro
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
}

function _mdBloques(texto) {
    const raiz = document.createElement("div")
    raiz.className = "updateNovedadesTexto"
    let lista = null
    let actual = null // párrafo o elemento de lista al que se van sumando líneas

    for (const linea of String(texto).split("\n")) {
        const limpia = linea.trim()
        if (!limpia) {
            actual = null
            continue
        }
        const titulo = limpia.match(/^#{3,6}\s+(.*)$/)
        if (titulo) {
            const h = document.createElement("h5")
            h.innerHTML = _mdEnLinea(titulo[1])
            raiz.append(h)
            lista = actual = null
            continue
        }
        const vineta = linea.match(/^(\s*)[-*]\s+(.*)$/)
        if (vineta) {
            if (!lista) {
                lista = document.createElement("ul")
                raiz.append(lista)
            }
            const li = document.createElement("li")
            if (vineta[1].length >= 2) li.className = "anidado"
            li.innerHTML = _mdEnLinea(vineta[2])
            lista.append(li)
            actual = li
            continue
        }
        if (actual) {
            actual.innerHTML += " " + _mdEnLinea(limpia)
            continue
        }
        const p = document.createElement("p")
        p.innerHTML = _mdEnLinea(limpia)
        raiz.append(p)
        lista = null
        actual = p
    }
    return raiz
}

function _pintarNovedadesUpd(novedades) {
    const m = _modalUpd()
    m.novedades.replaceChildren()
    const lista = Array.isArray(novedades) ? novedades : []
    m.novedadesCaja.hidden = lista.length === 0

    lista.forEach((novedad, i) => {
        const bloque = document.createElement("details")
        bloque.className = "updateNovedad"
        // La más nueva abierta; las intermedias, a un clic.
        bloque.open = i === 0
        const titulo = document.createElement("summary")
        const version = document.createElement("strong")
        version.textContent = novedad.version
        titulo.append(version)
        if (novedad.fecha) {
            const fecha = document.createElement("span")
            fecha.className = "updateNovedadFecha"
            const d = new Date(`${novedad.fecha}T12:00:00`)
            fecha.textContent = Number.isNaN(d.getTime())
                ? novedad.fecha
                : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
            titulo.append(fecha)
        }
        bloque.append(titulo, _mdBloques(novedad.texto || ""))
        m.novedades.append(bloque)
    })
}

// ── Modo «comprobando» e «info» ─────────────────────────────────────────────

function _pintarInfoUpdate(datos) {
    const m = _modalUpd()
    const remota = datos?.remota
    _updModo = "info"

    m.progreso.hidden = true
    m.instalada.textContent = datos?.version || "—"

    if (!remota?.activo) {
        m.publicada.textContent = "—"
        _resumenModalUpd(null, "La comprobación de versión está desactivada en este servidor.")
    } else if (!remota.publicada) {
        m.publicada.textContent = "?"
        _resumenModalUpd(null, "No se pudo saber qué versión hay publicada.", remota.comprobado)
    } else {
        m.publicada.textContent = remota.publicada
        if (_hayVersionNueva === true) {
            const cuantas = (remota.novedades || []).length
            _resumenModalUpd(
                "hayNueva",
                cuantas > 1 ? `${cuantas} versiones por delante de la tuya.` : "Hay una versión nueva.",
                remota.comprobado
            )
        } else if (_hayVersionNueva === false) {
            _resumenModalUpd("alDia", "Tienes la última versión publicada.", remota.comprobado)
        } else {
            _resumenModalUpd(null, "No se pudo comparar con la versión publicada.", remota.comprobado)
        }
    }

    const avisos = [datos ? _textoAvisoUpdate(datos) : "", remota?.error].filter(Boolean)
    _avisoModalUpd(avisos.join(" · "))
    _pintarNovedadesUpd(_hayVersionNueva ? remota?.novedades : [])
    m.nota.textContent = _mensajeConfirmacion()
    m.nota.hidden = false

    _botonesModalUpd({
        comprobar: true,
        actualizar: true,
        textoActualizar:
            _hayVersionNueva === true
                ? `Actualizar a la ${_versionPublicada}`
                : _hayVersionNueva === false
                  ? "Reinstalar igualmente"
                  : "Actualizar"
    })
    // Al día, reinstalar es posible pero no lo que se espera que se pulse.
    m.actualizarBtn.className = _hayVersionNueva === false ? "cancelButton" : "primaryButton"
    m.comprobarBtn.disabled = false
    m.actualizarBtn.disabled = false
}

function _pintarComprobandoUpd() {
    const m = _modalUpd()
    _updModo = "comprobando"
    m.instalada.textContent = _ultimosDatosUpdate?.version || "—"
    m.publicada.textContent = "…"
    _resumenModalUpd(null, "Consultando la versión publicada en GitHub…")
    m.progreso.hidden = false
    m.pasos.hidden = true
    m.barra.classList.add("indeterminada")
    m.barra.classList.remove("ok", "fallo")
    m.relleno.style.width = ""
    m.faseTexto.textContent = "Comprobando…"
    m.tiempo.textContent = ""
    _avisoModalUpd("")
    m.novedadesCaja.hidden = true
    m.nota.hidden = true
    _botonesModalUpd({ comprobar: true, actualizar: true })
    m.comprobarBtn.disabled = true
    m.actualizarBtn.disabled = true
}

// Comprobar a mano. La respuesta de GitHub se guarda unas horas, así que sin
// esto habría que esperar a que caducara para ver una versión recién
// publicada; y el botón es además la forma de ver si la comprobación va.
async function _comprobarUpdate() {
    if (_updSeguimiento.activo) {
        _abrirSeguimientoUpd()
        return
    }
    _pintarComprobandoUpd()
    _abrirModalUpd()
    // Que la barra se vea aunque GitHub conteste al instante: un parpadeo no
    // dice que se haya preguntado de verdad.
    const [datos] = await Promise.all([_consultarUpdate(true), new Promise((r) => setTimeout(r, 600))])
    if (_updModo !== "comprobando") return

    if (!datos?.ok) {
        _pintarInfoUpdate(_ultimosDatosUpdate)
        _avisoModalUpd(datos ? "No se pudo comprobar" : "Error de red: no se pudo hablar con el servidor")
        return
    }
    _pintarInfoUpdate(datos)
}

// «Actualizar» del desplegable o de Ajustes: abre la ventana con lo que ya se
// sabe para que se vea qué se va a instalar antes de confirmar.
function _pedirUpdate() {
    if (_updSeguimiento.activo || _ultimosDatosUpdate?.enMarcha) {
        _abrirSeguimientoUpd()
        return
    }
    if (_ultimosDatosUpdate) _pintarInfoUpdate(_ultimosDatosUpdate)
    else _pintarComprobandoUpd()
    _abrirModalUpd()
    _consultarUpdate().then((datos) => {
        if (datos?.ok && _updModo === "comprobando") _pintarInfoUpdate(datos)
    })
}

// ── Modo «progreso» ─────────────────────────────────────────────────────────

function _irAPasoUpd(indice) {
    const s = _updSeguimiento
    if (indice <= s.paso) return
    const ahora = Date.now()
    // Los pasos que el servidor se salta (un vigilante antiguo no anuncia
    // fases) se dan por hechos sin tiempo propio.
    for (let i = Math.max(s.paso, 0); i < indice; i++) {
        if (s.duraciones[i] === undefined) s.duraciones[i] = i === s.paso ? ahora - s.inicioPaso : null
    }
    s.paso = indice
    s.inicioPaso = ahora
}

function _empezarSeguimientoUpd({ desde, pasoInicial, versionAlPedir }) {
    const s = _updSeguimiento
    Object.assign(s, {
        activo: true,
        desde,
        inicio: Date.now(),
        paso: -1,
        inicioPaso: Date.now(),
        duraciones: [],
        resultado: null,
        detalle: "",
        sinRespuesta: false,
        volviendo: false
    })
    _versionAlPedir = versionAlPedir
    _irAPasoUpd(pasoInicial)
    // Durante la instalación manda la lista de pasos: las novedades siguen a
    // mano, plegadas.
    for (const bloque of document.querySelectorAll("#updModalNovedades details")) bloque.open = false
    if (s.ticker) clearInterval(s.ticker)
    s.ticker = setInterval(_pintarProgresoUpd, 500)
    _sondearUpdate()
}

function _terminarSeguimientoUpd(resultado, detalle) {
    const s = _updSeguimiento
    if (resultado === "ok") _irAPasoUpd(_UPD_IDX.listo)
    s.duraciones[s.paso] = Date.now() - s.inicioPaso
    s.resultado = resultado
    s.detalle = detalle || ""
    s.activo = false
    if (s.ticker) clearInterval(s.ticker)
    s.ticker = null
    if (_sondeoUpdate) clearInterval(_sondeoUpdate)
    _sondeoUpdate = null
    // Al acabar cambian los botones (recargar o reintentar), no solo la barra.
    if (_updModo === "progreso") _pintarModoProgresoUpd()

    if (resultado === "ok") _msgUpdate(`Actualizada a la ${detalle}. Recarga la página.`, "ok")
    else _msgUpdate("La actualización falló; sigue la versión anterior", "error")
    if (_ultimosDatosUpdate) _pintarUpdate(_ultimosDatosUpdate)
}

// Lo que dice el servidor sobre la instalación en curso. Solo cuenta lo que
// sea posterior a la petición: el fichero de fase y el de estado se quedan de
// la vez anterior.
function _avanzarSeguimientoUpd(datos) {
    const s = _updSeguimiento
    if (!s.activo) return

    if (Date.now() - s.inicio > _UPDATE_SIN_NOTICIAS_MS) {
        _terminarSeguimientoUpd(
            "fallo",
            "Sin noticias del servidor en 15 minutos. Revisa logs/actualizacion.log en el servidor."
        )
        return
    }

    if (!datos) {
        // El contenedor se ha parado: docker compose up lo está recreando.
        s.sinRespuesta = true
        if (s.paso >= _UPD_IDX.recogida && s.paso < _UPD_IDX.levantando) _irAPasoUpd(_UPD_IDX.levantando)
        return
    }
    s.sinRespuesta = false

    const base = Date.parse(s.desde)
    const posterior = (momento) => Boolean(momento) && (!Number.isFinite(base) || Date.parse(momento) >= base - 2000)
    const { ultimo, fase } = datos

    if (datos.version && _versionAlPedir && datos.version !== _versionAlPedir) {
        _terminarSeguimientoUpd("ok", datos.version)
        return
    }
    if (ultimo && posterior(ultimo.momento)) {
        if (ultimo.estado === "ok") {
            _terminarSeguimientoUpd("ok", datos.version)
            return
        }
        if (ultimo.estado === "fallo") {
            _terminarSeguimientoUpd("fallo", `Código ${ultimo.codigo}. ${ultimo.detalle || ""}`.trim())
            return
        }
        if (ultimo.estado === "en_marcha") _irAPasoUpd(_UPD_IDX.descargando)
    }
    if (fase && posterior(fase.momento)) {
        if (fase.fase === "volviendo") s.volviendo = true
        const paso = _UPD_FASE_A_PASO[fase.fase]
        if (paso === _UPD_IDX.listo) {
            _terminarSeguimientoUpd("ok", fase.detalle || datos.version)
            return
        }
        if (paso !== undefined) _irAPasoUpd(paso)
    }

    if (s.paso === _UPD_IDX.recogida && Date.now() - s.inicioPaso > _UPDATE_RECOGIDA_LENTA_MS) {
        _avisoModalUpd(
            _textoAvisoUpdate(datos) ||
                "El vigilante del servidor aún no ha recogido la petición. Comprueba que su temporizador " +
                    "está activo: systemctl status portfolio-actualizador.timer"
        )
    }
}

function _sondearUpdate() {
    if (_sondeoUpdate) clearInterval(_sondeoUpdate)
    _sondeoUpdate = setInterval(async () => {
        _avanzarSeguimientoUpd(await _consultarUpdate())
    }, _UPDATE_SONDEO_MS)
}

function _reloj(ms) {
    const s = Math.max(0, Math.round(ms / 1000))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function _porcentajeUpd() {
    const s = _updSeguimiento
    if (s.resultado === "ok") return 100
    const total = _UPD_PASOS.reduce((suma, p) => suma + p.peso, 0)
    let hecho = 0
    for (let i = 0; i < s.paso; i++) hecho += _UPD_PASOS[i].peso
    const paso = _UPD_PASOS[s.paso]
    if (paso) {
        // Se acerca al final del paso sin llegar: solo el servidor dice cuándo
        // ha terminado.
        const t = (Date.now() - s.inicioPaso) / 1000
        hecho += paso.peso * Math.min(0.92, 1 - Math.exp(-t / paso.estimado))
    }
    return Math.min(99, Math.round((hecho / total) * 100))
}

function _textoFaseUpd() {
    const s = _updSeguimiento
    if (s.resultado === "ok") return `Actualizada a la ${s.detalle}`
    if (s.resultado === "fallo") return "La actualización falló; sigue la versión anterior"
    if (s.volviendo) return "La versión nueva no arrancó: volviendo a la anterior…"
    if (s.sinRespuesta) return "Reiniciando… la aplicación no responde mientras tanto"
    const paso = _UPD_PASOS[s.paso]
    return paso ? `${paso.texto}…` : ""
}

function _pintarProgresoUpd() {
    if (_updModo !== "progreso") return
    const m = _modalUpd()
    const s = _updSeguimiento
    const pct = _porcentajeUpd()

    m.barra.classList.remove("indeterminada")
    m.barra.classList.toggle("ok", s.resultado === "ok")
    m.barra.classList.toggle("fallo", s.resultado === "fallo" || s.volviendo)
    m.barra.setAttribute("aria-valuenow", String(pct))
    m.relleno.style.width = `${s.resultado === "fallo" ? 100 : pct}%`
    m.faseTexto.textContent = _textoFaseUpd()
    const final = s.resultado ? s.inicio + s.duraciones.reduce((a, d) => a + (d || 0), 0) : Date.now()
    m.tiempo.textContent = `${s.resultado ? "" : `${pct} % · `}${_reloj(final - s.inicio)}`

    m.pasos.hidden = false
    m.pasos.replaceChildren(
        ..._UPD_PASOS.map((paso, i) => {
            const li = document.createElement("li")
            const hecho = i < s.paso || (i === s.paso && s.resultado === "ok")
            const enCurso = i === s.paso && !s.resultado
            const fallido = i === s.paso && s.resultado === "fallo"
            li.className = hecho ? "hecho" : enCurso ? "actual" : fallido ? "fallo" : "pendiente"
            const texto = document.createElement("span")
            texto.textContent = paso.texto
            const tiempo = document.createElement("span")
            tiempo.className = "updatePasoTiempo"
            const dur = enCurso ? Date.now() - s.inicioPaso : s.duraciones[i]
            if (dur) tiempo.textContent = _reloj(dur)
            li.append(texto, tiempo)
            return li
        })
    )

    if (s.resultado === "fallo") _avisoModalUpd(s.detalle)
    else if (s.resultado === "ok") _avisoModalUpd("")
}

function _pintarModoProgresoUpd() {
    const m = _modalUpd()
    const s = _updSeguimiento
    _updModo = "progreso"
    m.instalada.textContent = _versionAlPedir || _ultimosDatosUpdate?.version || "—"
    m.publicada.textContent = _versionPublicada || "?"
    m.progreso.hidden = false
    m.novedadesCaja.hidden = !m.novedades.childElementCount
    if (s.resultado === "ok") {
        _resumenModalUpd("alDia", "Instalada. Recarga la página para usar la versión nueva.")
        m.nota.hidden = true
        _botonesModalUpd({ recargar: true })
    } else if (s.resultado === "fallo") {
        _resumenModalUpd(null, "No se ha cambiado nada: la versión anterior sigue en marcha.")
        m.nota.hidden = true
        _botonesModalUpd({ comprobar: true, actualizar: true, textoActualizar: "Reintentar" })
        m.comprobarBtn.disabled = false
        m.actualizarBtn.disabled = false
        m.actualizarBtn.className = "primaryButton"
    } else {
        _resumenModalUpd(null, "Instalando en el servidor…")
        m.nota.textContent = "Puedes cerrar esta ventana: la actualización sigue en el servidor y el botón de la versión la vuelve a abrir."
        m.nota.hidden = false
        _avisoModalUpd("")
        _botonesModalUpd({})
    }
    _pintarProgresoUpd()
}

function _abrirSeguimientoUpd() {
    const datos = _ultimosDatosUpdate
    // Abierta en otra pestaña, o la página se recargó a mitad: se retoma
    // desde lo que diga el servidor.
    if (!_updSeguimiento.activo && datos?.enMarcha) {
        _empezarSeguimientoUpd({
            desde: datos.ultimo?.momento,
            pasoInicial: _UPD_IDX.descargando,
            versionAlPedir: datos.version
        })
        _avanzarSeguimientoUpd(datos)
    }
    _pintarModoProgresoUpd()
    _abrirModalUpd()
}

async function _lanzarUpdate() {
    _empezarSeguimientoUpd({
        desde: null,
        pasoInicial: _UPD_IDX.solicitud,
        versionAlPedir: _ultimosDatosUpdate?.version || null
    })
    // Hasta que la petición esté dentro no hay nada que sondear.
    if (_sondeoUpdate) clearInterval(_sondeoUpdate)
    _sondeoUpdate = null
    _pintarModoProgresoUpd()
    _msgUpdate("Actualizando… la aplicación se reiniciará", "")

    try {
        const res = await fetch("/api/actualizacion", { method: "POST" })
        const datos = await res.json()
        if (!datos.ok) {
            _terminarSeguimientoUpd("fallo", datos.error || "No se pudo solicitar")
            return
        }
        _updSeguimiento.desde = datos.solicitada?.momento || null
        _versionAlPedir = datos.version
        _irAPasoUpd(_UPD_IDX.recogida)
        _sondearUpdate()
    } catch {
        _terminarSeguimientoUpd("fallo", "Error de red: la petición no llegó al servidor")
    }
}

function _initModalUpd() {
    const m = _modalUpd()
    if (!m.overlay) return
    m.cerrarBtn.addEventListener("click", _cerrarModalUpd)
    document.getElementById("updModalX")?.addEventListener("click", _cerrarModalUpd)
    m.comprobarBtn.addEventListener("click", _comprobarUpdate)
    m.actualizarBtn.addEventListener("click", _lanzarUpdate)
    m.recargarBtn.addEventListener("click", () => window.location.reload())
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && _modalUpdAbierto()) _cerrarModalUpd()
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

    _initModalUpd()
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
