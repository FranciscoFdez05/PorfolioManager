// Carteras conocidas: buscador del catálogo de wallets públicas (exchanges,
// Satoshi, gobiernos…), en el menú ⋯ de Cripto › Wallets.
//
// Elegir una entidad no enlaza nada: rellena el formulario de enlazar con sus
// direcciones como seguimiento ajeno, y el usuario lo revisa y pulsa «Enlazar».
// Así los límites, la validación y los avisos son los de cualquier wallet. El
// catálogo de serie viaja con la aplicación (python/core/datos/); lo que el
// usuario añade o edita se guarda cifrado en el servidor.
let carterasEstado = { carteras: [], categorias: [], ocultas: [], consulta: "", abierta: "", editando: null }
let carterasTemporizador = null
// Por defecto se marca una dirección por red: cada wallet es una consulta más
// en cada revisión, y seguirlas todas acaba topando con los límites de las APIs.
const CARTERAS_MARCADAS_POR_RED = 1
// Ficha del catálogo que lleva dentro el saldo completo y la vigilancia de
// bloques de js/cripto/satoshi-vigilancia.js.
const CARTERAS_ID_SATOSHI = "satoshi"

function carterasRedes() {
    return typeof walletsEstado !== "undefined" ? walletsEstado.redes || [] : []
}

function carterasNombreRed(clave) {
    return carterasRedes().find((red) => red.clave === clave)?.nombre || clave.toUpperCase()
}

function carterasAbreviar(valor) {
    const texto = String(valor || "")
    return texto.length > 26 ? `${texto.slice(0, 12)}…${texto.slice(-8)}` : texto
}

// Mismo criterio que claveSeguimiento() del servidor: «Binance» y « binance » son el mismo.
function carterasClaveSeguimiento(nombre) {
    return String(nombre || "")
        .split(/\s+/)
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
}

async function abrirCarterasConocidas() {
    carterasEstado = { ...carterasEstado, consulta: "", abierta: "", editando: null }
    // Cada vez que se abre la ventana se vuelve a leer: el worker la actualiza.
    if (typeof satoshiEstado !== "undefined") satoshiEstado = null
    renderCarterasModal()
    await cargarCarteras()
}

function cerrarCarterasConocidas() {
    clearTimeout(carterasTemporizador)
    document.getElementById("carterasOverlay")?.remove()
}

async function cargarCarteras() {
    const url = `/api/wallets/catalogo?q=${encodeURIComponent(carterasEstado.consulta)}`
    try {
        const datos = await walletsPeticion(url)
        // Si mientras tanto se ha escrito otra cosa, esta respuesta ya no vale.
        if (url !== `/api/wallets/catalogo?q=${encodeURIComponent(carterasEstado.consulta)}`) return
        carterasEstado = { ...carterasEstado, ...datos }
    } catch (error) {
        showToast(error.message || "No se pudo cargar el catálogo de carteras", { type: "error" })
    }
    pintarCarterasContenido()
}

function renderCarterasModal() {
    cerrarCarterasConocidas()
    const overlay = document.createElement("div")
    overlay.id = "carterasOverlay"
    overlay.className = "modalOverlay carterasOverlay"
    overlay.innerHTML = `
        <div class="assetModal carterasModal" role="dialog" aria-labelledby="carterasTitulo">
            <h3 id="carterasTitulo" class="assetModalTitle">Carteras conocidas</h3>
            <p class="assetModalHint">Direcciones públicas de exchanges, fundadores, gobiernos y fondos, incluidas en la aplicación con su fuente. Elige una y marca qué direcciones seguir: se abre la ventana de enlazar con ellas como seguimiento ajeno, que solo se vigila.</p>
            <div class="carterasBuscador">
                <input id="carterasBuscar" class="assetRowModalInput" type="search" autocomplete="off" spellcheck="false" placeholder="Buscar: Binance, Satoshi, gobierno, una dirección…" aria-label="Buscar carteras">
                <button type="button" id="carterasNuevaBtn" class="cancelButton">+ Nueva cartera</button>
            </div>
            <div id="carterasContenido" class="carterasContenido"><p class="assetModalHint">Cargando…</p></div>
            <div class="assetRowModalFooter">
                <button type="button" id="carterasCerrarBtn" class="cancelButton">Cerrar</button>
            </div>
        </div>`
    document.body.appendChild(overlay)

    overlay.querySelector("#carterasCerrarBtn").addEventListener("click", cerrarCarterasConocidas)
    overlay.querySelector("#carterasNuevaBtn").addEventListener("click", () => editarCartera(null))
    overlay.querySelector("#carterasBuscar").addEventListener("input", (event) => {
        clearTimeout(carterasTemporizador)
        carterasTemporizador = setTimeout(() => {
            carterasEstado = { ...carterasEstado, consulta: event.target.value.trim(), abierta: "", editando: null }
            cargarCarteras()
        }, 200)
    })
    overlay.querySelector("#carterasContenido").addEventListener("click", manejarClickCarteras)
    overlay.querySelector("#carterasContenido").addEventListener("change", (event) => {
        if (event.target.classList.contains("carterasDireccionCheck")) actualizarBotonUsarCartera()
    })
    overlay.querySelector("#carterasBuscar").focus()
}

function pintarCarterasContenido() {
    const contenedor = document.getElementById("carterasContenido")
    if (!contenedor) return
    contenedor.innerHTML = carterasEstado.editando ? carterasEditorHtml() : carterasListaHtml()
    if (carterasEstado.editando) contenedor.querySelector("#carterasEditorNombre")?.focus()
    actualizarBotonUsarCartera()
    if (typeof mostrarSatoshiVigilancia === "function") mostrarSatoshiVigilancia()
}

// ── Lista ─────────────────────────────────────────────────────────────────────

function carterasResumenRedes(cartera) {
    const cuentas = new Map()
    for (const direccion of cartera.direcciones) cuentas.set(direccion.red, (cuentas.get(direccion.red) || 0) + 1)
    return [...cuentas].map(([red, n]) => `${red.toUpperCase()} ${n}`).join(" · ")
}

function carterasListaHtml() {
    const { carteras, ocultas, consulta } = carterasEstado
    const vacia = consulta ? `Nada coincide con «${escapeHtml(consulta)}».` : "El catálogo está vacío."
    const items = carteras.length
        ? `<ul class="carterasLista">${carteras.map(carterasItemHtml).join("")}</ul>`
        : `<p class="assetModalHint">${vacia}</p>`
    const restaurables = ocultas.length
        ? `<div class="carterasOcultas"><span>Ocultas:</span>${ocultas
              .map(
                  (oculta) =>
                      `<button type="button" class="cancelButton" data-accion="restaurar" data-id="${escapeHtml(oculta.id)}" title="Volver a enseñarla">${escapeHtml(oculta.nombre)} ↺</button>`
              )
              .join("")}</div>`
        : ""
    return items + restaurables
}

function carterasItemHtml(cartera) {
    const id = escapeHtml(cartera.id)
    const origen =
        cartera.origen === "serie"
            ? ""
            : `<span class="carterasEtiqueta carterasEtiqueta-origen">${cartera.origen === "editada" ? "Editada" : "Tuya"}</span>`
    const restaurar =
        cartera.origen === "editada"
            ? `<button type="button" class="cancelButton" data-accion="restaurar" data-id="${id}" title="Deshacer tus cambios">Restaurar</button>`
            : ""
    const abierta = carterasEstado.abierta === cartera.id
    return `
        <li class="carterasItem${abierta ? " carterasItem-abierta" : ""}" data-id="${id}">
            <div class="carterasItemCabecera">
                <div class="carterasItemDatos">
                    <strong>${escapeHtml(cartera.nombre)}</strong>
                    <span class="carterasEtiqueta">${escapeHtml(cartera.categoriaNombre)}</span>
                    ${origen}
                    <span class="carterasRedes">${escapeHtml(carterasResumenRedes(cartera))}</span>
                </div>
                <div class="carterasItemAcciones">
                    <button type="button" class="primaryButton" data-accion="seguir" data-id="${id}" aria-expanded="${abierta}">${abierta ? "Cerrar" : "Seguir…"}</button>
                    <button type="button" class="cancelButton" data-accion="editar" data-id="${id}">Editar</button>
                    ${restaurar}
                    <button type="button" class="dangerButton" data-accion="quitar" data-id="${id}">${cartera.origen === "propia" ? "Borrar" : "Ocultar"}</button>
                </div>
            </div>
            ${cartera.nota ? `<p class="carterasNota">${escapeHtml(cartera.nota)}</p>` : ""}
            ${cartera.id === CARTERAS_ID_SATOSHI ? `<section id="satoshiVigilancia" class="satoshiBloque" aria-label="Todas las monedas de Satoshi"></section>` : ""}
            ${abierta ? carterasSeleccionHtml(cartera) : ""}
        </li>`
}

function carterasSeleccionHtml(cartera) {
    const porRed = new Map()
    cartera.direcciones.forEach((direccion, indice) => {
        if (!porRed.has(direccion.red)) porRed.set(direccion.red, [])
        porRed.get(direccion.red).push({ ...direccion, indice })
    })
    const grupos = [...porRed]
        .map(([red, direcciones]) => {
            let marcadas = 0
            const filas = direcciones
                .map((direccion) => {
                    const marcar = !direccion.enlazada && marcadas < CARTERAS_MARCADAS_POR_RED
                    if (marcar) marcadas += 1
                    const tipo = direccion.tipo === "clave" ? " (clave pública)" : ""
                    return `
                        <label class="carterasDireccion${direccion.enlazada ? " carterasDireccion-enlazada" : ""}" title="${escapeHtml(direccion.valor)}">
                            <input type="checkbox" class="carterasDireccionCheck" data-indice="${direccion.indice}"${marcar ? " checked" : ""}${direccion.enlazada ? " disabled" : ""}>
                            <span class="carterasDireccionEtiqueta">${escapeHtml(direccion.etiqueta || carterasNombreRed(red))}${tipo}</span>
                            <code>${escapeHtml(carterasAbreviar(direccion.valor))}</code>
                            ${direccion.enlazada ? `<span class="carterasEtiqueta">Ya la sigues</span>` : ""}
                        </label>`
                })
                .join("")
            return `<fieldset class="carterasRed"><legend>${escapeHtml(carterasNombreRed(red))}</legend>${filas}</fieldset>`
        })
        .join("")
    const fuentes = cartera.fuentes.length
        ? `<p class="carterasFuentes">Fuente: ${cartera.fuentes
              .map(
                  (fuente) =>
                      `<a href="${escapeHtml(fuente.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(fuente.nombre)}</a>`
              )
              .join(" · ")}</p>`
        : ""
    return `
        <div class="carterasSeleccion">
            ${grupos}
            ${fuentes}
            <div class="carterasSeleccionAcciones">
                <button type="button" class="cancelButton" data-accion="marcar-todas">Todas</button>
                <button type="button" class="cancelButton" data-accion="marcar-ninguna">Ninguna</button>
                <button type="button" class="primaryButton" data-accion="usar" data-id="${escapeHtml(cartera.id)}">Seguir las marcadas</button>
            </div>
        </div>`
}

function actualizarBotonUsarCartera() {
    const boton = document.querySelector('#carterasContenido [data-accion="usar"]')
    if (!boton) return
    const marcadas = document.querySelectorAll("#carterasContenido .carterasDireccionCheck:checked").length
    boton.disabled = !marcadas
    boton.textContent = `Seguir las marcadas (${marcadas})`
}

function carterasPorId(id) {
    return carterasEstado.carteras.find((cartera) => cartera.id === id) || null
}

function manejarClickCarteras(event) {
    const boton = event.target.closest("button[data-accion]")
    if (!boton) return
    const { accion, id } = boton.dataset
    if (accion === "seguir") {
        carterasEstado.abierta = carterasEstado.abierta === id ? "" : id
        pintarCarterasContenido()
    } else if (accion === "marcar-todas" || accion === "marcar-ninguna") {
        document.querySelectorAll("#carterasContenido .carterasDireccionCheck:not(:disabled)").forEach((check) => {
            check.checked = accion === "marcar-todas"
        })
        actualizarBotonUsarCartera()
    } else if (accion === "usar") {
        usarCarteraEnFormulario(carterasPorId(id))
    } else if (accion === "editar") {
        editarCartera(carterasPorId(id))
    } else if (accion === "quitar") {
        confirmarQuitarCartera(carterasPorId(id))
    } else if (accion === "restaurar") {
        restaurarCartera(id)
    } else if (accion === "editor-anadir") {
        anadirFilaEditorCartera()
    } else if (accion === "editor-quitar") {
        quitarFilaEditorCartera(boton.closest(".carterasEditorFila"))
    } else if (accion === "editor-cancelar") {
        carterasEstado.editando = null
        pintarCarterasContenido()
    } else if (accion === "editor-guardar") {
        guardarCarteraEditada()
    }
}

// ── Rellenar el formulario de enlazar ─────────────────────────────────────────

// El seguimiento se llama como la entidad. Si ya hay uno ajeno con ese nombre,
// las direcciones se le añaden; si es propio, no se pueden mezclar (el servidor
// lo rechazaría) y se propone otro nombre.
function carterasElegirSeguimiento(nombre) {
    const grupo = walletsGruposSeguimiento().find((g) => g.clave === carterasClaveSeguimiento(nombre))
    const selector = document.getElementById("walletsSeguimiento")
    if (grupo && !grupo.propia) {
        walletsFijarSelect(selector, grupo.clave)
    } else {
        walletsFijarSelect(selector, "")
        const campo = document.getElementById("walletsSeguimientoNombre")
        if (campo) campo.value = grupo ? `${nombre} (seguimiento)`.slice(0, 60) : nombre
        walletsFijarSelect(document.getElementById("walletsPropia"), "no")
    }
    actualizarCampoSeguimiento()
}

function carterasFilaLibre() {
    const libre = walletsFilas().find((fila) => !walletsDatosFila(fila).valor)
    if (libre) return libre
    anadirFilaWallet()
    return walletsFilas().pop()
}

// Todas las líneas del formulario van a un mismo seguimiento: si antes se eligió
// otra entidad, sus líneas se quitan para no enlazarlas con el nombre de esta.
// Las escritas a mano se quedan.
function carterasQuitarFilasDeOtra(carteraId) {
    for (const fila of walletsFilas()) {
        if (!fila.dataset.cartera || fila.dataset.cartera === carteraId) continue
        delete fila.dataset.cartera
        quitarFilaWallet(fila)
    }
}

function carterasRellenarFila(fila, direccion, carteraId) {
    fila.dataset.cartera = carteraId
    walletsFijarSelect(fila.querySelector(".walletsFilaRed"), direccion.red)
    actualizarFilaWallet(fila)
    walletsFijarSelect(fila.querySelector(".walletsFilaTipo"), direccion.tipo === "clave" ? "clave" : "auto")
    fila.querySelector(".walletsFilaValor").value = direccion.valor
    fila.querySelector(".walletsFilaAlias").value = String(direccion.etiqueta || "").slice(0, 60)
}

// El catálogo se abre desde la página de seguimiento, sin la ventana de enlazar
// debajo: se abre aquí y luego se rellena. Si ya estaba abierta, se aprovecha.
async function usarCarteraEnFormulario(cartera) {
    if (!cartera) return
    const indices = [...document.querySelectorAll("#carterasContenido .carterasDireccionCheck:checked")].map((check) =>
        Number(check.dataset.indice)
    )
    cerrarCarterasConocidas()
    if (!document.getElementById("walletsFilas")) await abrirWalletsEnlazadas("seguimiento")
    if (!document.getElementById("walletsFilas")) return
    carterasQuitarFilasDeOtra(cartera.id)
    const enFormulario = new Set(
        walletsFilas().map((fila) => `${walletsDatosFila(fila).red}|${walletsDatosFila(fila).valor}`)
    )
    const nuevas = indices
        .map((indice) => cartera.direcciones[indice])
        .filter((direccion) => direccion && !enFormulario.has(`${direccion.red}|${direccion.valor}`))

    carterasElegirSeguimiento(cartera.nombre)
    for (const direccion of nuevas) carterasRellenarFila(carterasFilaLibre(), direccion, cartera.id)
    const texto = `${nuevas.length} ${nuevas.length === 1 ? "dirección" : "direcciones"} de «${cartera.nombre}» en el formulario. Revisa y pulsa «Enlazar».`
    showToast(texto, { type: nuevas.length ? "success" : "info" })
}

// ── Quitar y restaurar ────────────────────────────────────────────────────────

function confirmarQuitarCartera(cartera) {
    if (!cartera) return
    const propia = cartera.origen === "propia"
    openConfirmModal({
        title: propia ? "Borrar cartera" : "Ocultar cartera",
        message: propia
            ? `Se borrará «${cartera.nombre}» de tu catálogo. Las wallets que ya sigues no cambian.`
            : `«${cartera.nombre}» dejará de salir en el catálogo; podrás volver a enseñarla desde «Ocultas». Las wallets que ya sigues no cambian.`,
        confirmLabel: propia ? "Borrar" : "Ocultar",
        onConfirm: async () => {
            try {
                await walletsPost("/api/wallets/catalogo/eliminar", { id: cartera.id })
                carterasEstado.abierta = ""
                await cargarCarteras()
            } catch (error) {
                showToast(error.message || "No se pudo quitar la cartera", { type: "error" })
            }
        }
    })
}

async function restaurarCartera(id) {
    try {
        await walletsPost("/api/wallets/catalogo/restaurar", { id })
        await cargarCarteras()
    } catch (error) {
        showToast(error.message || "No se pudo restaurar la cartera", { type: "error" })
    }
}

// ── Editor ────────────────────────────────────────────────────────────────────

function editarCartera(cartera) {
    carterasEstado.editando = cartera
        ? { ...cartera, alias: [...cartera.alias], direcciones: cartera.direcciones.map((d) => ({ ...d })) }
        : {
              id: "",
              nombre: "",
              categoria: "persona",
              alias: [],
              nota: "",
              direcciones: [{ red: "btc", valor: "", etiqueta: "" }]
          }
    pintarCarterasContenido()
}

function carterasEditorFilaHtml(direccion = { red: "btc", valor: "", etiqueta: "" }) {
    const redes = carterasRedes()
        .map(
            (red) =>
                `<option value="${escapeHtml(red.clave)}"${red.clave === direccion.red ? " selected" : ""}>${escapeHtml(red.nombre)} (${escapeHtml(red.simbolo)})</option>`
        )
        .join("")
    return `
        <li class="carterasEditorFila">
            <select class="assetRowModalSelect carterasEditorRed" aria-label="Red">${redes}</select>
            <input class="assetRowModalInput carterasEditorValor" type="text" value="${escapeHtml(direccion.valor)}" aria-label="Dirección o clave pública" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Dirección o clave pública">
            <input class="assetRowModalInput carterasEditorEtiqueta" type="text" maxlength="60" value="${escapeHtml(direccion.etiqueta || "")}" aria-label="Etiqueta" placeholder="Etiqueta (opcional)" autocomplete="off">
            <button type="button" class="cancelButton carterasEditorQuitarBtn" data-accion="editor-quitar" title="Quitar esta dirección" aria-label="Quitar esta dirección">×</button>
            <p class="walletsFilaError hidden"></p>
        </li>`
}

function carterasEditorHtml() {
    const cartera = carterasEstado.editando
    const categorias = carterasEstado.categorias
        .map(
            (categoria) =>
                `<option value="${escapeHtml(categoria.clave)}"${categoria.clave === cartera.categoria ? " selected" : ""}>${escapeHtml(categoria.nombre)}</option>`
        )
        .join("")
    const aviso =
        cartera.origen === "serie" || cartera.origen === "editada"
            ? `<p class="assetModalHint">Es una cartera de serie: se guardará tu versión y podrás volver a la original con «Restaurar».</p>`
            : ""
    return `
        <div class="carterasEditor">
            <h4 class="walletsSubtitulo">${cartera.id ? "Editar cartera" : "Nueva cartera"}</h4>
            ${aviso}
            <div class="carterasEditorCampos">
                <label class="assetRowModalLabel" for="carterasEditorNombre">Nombre</label>
                <input id="carterasEditorNombre" class="assetRowModalInput" type="text" maxlength="60" value="${escapeHtml(cartera.nombre)}" autocomplete="off" data-campo="nombre">
                <label class="assetRowModalLabel" for="carterasEditorCategoria">Categoría</label>
                <select id="carterasEditorCategoria" class="assetRowModalSelect" data-campo="categoria">${categorias}</select>
                <label class="assetRowModalLabel" for="carterasEditorAlias">Otros nombres para buscarla (separados por comas)</label>
                <input id="carterasEditorAlias" class="assetRowModalInput" type="text" value="${escapeHtml(cartera.alias.join(", "))}" autocomplete="off" data-campo="alias">
                <label class="assetRowModalLabel" for="carterasEditorNota">Nota</label>
                <textarea id="carterasEditorNota" class="assetRowModalInput carterasEditorNota" maxlength="500" rows="2" data-campo="nota">${escapeHtml(cartera.nota || "")}</textarea>
            </div>
            <ul id="carterasEditorFilas" class="carterasEditorFilas">${cartera.direcciones.map(carterasEditorFilaHtml).join("")}</ul>
            <button type="button" class="cancelButton walletsAnadirFilaBtn" data-accion="editor-anadir">+ Añadir dirección</button>
            <div class="carterasSeleccionAcciones">
                <button type="button" class="cancelButton" data-accion="editor-cancelar">Cancelar</button>
                <button type="button" class="primaryButton" data-accion="editor-guardar" data-no-autohide="true">Guardar</button>
            </div>
        </div>`
}

function carterasEditorFilas() {
    return [...document.querySelectorAll("#carterasEditorFilas .carterasEditorFila")]
}

function anadirFilaEditorCartera() {
    const lista = document.getElementById("carterasEditorFilas")
    if (!lista) return
    const red = carterasEditorFilas().pop()?.querySelector(".carterasEditorRed")?.value || "btc"
    lista.insertAdjacentHTML("beforeend", carterasEditorFilaHtml({ red, valor: "", etiqueta: "" }))
    carterasEditorFilas().pop().querySelector(".carterasEditorValor")?.focus()
}

function quitarFilaEditorCartera(fila) {
    if (!fila) return
    if (carterasEditorFilas().length > 1) fila.remove()
    else fila.querySelectorAll("input").forEach((campo) => (campo.value = ""))
}

function carterasLeerEditor() {
    const valor = (id) => document.getElementById(id)?.value || ""
    return {
        id: carterasEstado.editando?.id || "",
        nombre: valor("carterasEditorNombre").trim(),
        categoria: valor("carterasEditorCategoria"),
        alias: valor("carterasEditorAlias")
            .split(",")
            .map((alias) => alias.trim())
            .filter(Boolean),
        nota: valor("carterasEditorNota").trim(),
        direcciones: carterasEditorFilas()
            .map((fila) => ({
                red: fila.querySelector(".carterasEditorRed")?.value || "",
                tipo: "auto",
                valor: fila.querySelector(".carterasEditorValor")?.value.trim() || "",
                etiqueta: fila.querySelector(".carterasEditorEtiqueta")?.value.trim() || ""
            }))
            .filter((direccion) => direccion.valor)
    }
}

// El servidor dice qué campo falla: «direcciones.3» es la cuarta línea con dirección.
function carterasMarcarErrorEditor(campo, mensaje) {
    document
        .querySelectorAll("#carterasContenido .walletsFila-error")
        .forEach((el) => el.classList.remove("walletsFila-error"))
    document.querySelectorAll("#carterasEditorFilas .walletsFilaError").forEach((el) => el.classList.add("hidden"))
    const indice = /^direcciones\.(\d+)$/.exec(campo || "")?.[1]
    if (indice !== undefined) {
        const fila = carterasEditorFilas().filter((f) => f.querySelector(".carterasEditorValor")?.value.trim())[
            Number(indice)
        ]
        const error = fila?.querySelector(".walletsFilaError")
        if (error) {
            error.textContent = mensaje
            error.classList.remove("hidden")
            fila.classList.add("walletsFila-error")
            return
        }
    }
    document.querySelector(`#carterasContenido [data-campo="${campo}"]`)?.classList.add("walletsFila-error")
    showToast(mensaje, { type: "error" })
}

async function guardarCarteraEditada() {
    const boton = document.querySelector('#carterasContenido [data-accion="editor-guardar"]')
    const datos = carterasLeerEditor()
    if (boton) boton.disabled = true
    try {
        const respuesta = await fetch("/api/wallets/catalogo/guardar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(datos)
        })
        const cuerpo = await respuesta.json().catch(() => null)
        if (!respuesta.ok || cuerpo?.ok === false) {
            carterasMarcarErrorEditor(cuerpo?.field || "", cuerpo?.error || `HTTP ${respuesta.status}`)
            return
        }
        showToast(`«${cuerpo.cartera.nombre}» guardada en el catálogo`, { type: "success" })
        carterasEstado = { ...carterasEstado, editando: null, abierta: cuerpo.cartera.id, consulta: "" }
        const buscador = document.getElementById("carterasBuscar")
        if (buscador) buscador.value = ""
        await cargarCarteras()
    } catch (error) {
        showToast(error.message || "No se pudo guardar la cartera", { type: "error" })
    } finally {
        if (boton?.isConnected) boton.disabled = false
    }
}

// ── Menú ⋯ de la página de seguimiento ────────────────────────────────────────

function carterasFijarMenu(abierto) {
    const menu = document.getElementById("walletsSegMenu")
    const boton = document.getElementById("walletsSegMenuBtn")
    if (!menu || !boton) return
    menu.classList.toggle("open", abierto)
    boton.classList.toggle("active", abierto)
    boton.setAttribute("aria-expanded", String(abierto))
}

// La página (html/cripto/wallets-seguimiento.html) se carga y se repinta por su
// cuenta: por delegación no hay que volver a enganchar el menú cada vez.
document.addEventListener("click", (event) => {
    if (event.target.closest("#walletsSegMenuBtn")) {
        carterasFijarMenu(!document.getElementById("walletsSegMenu")?.classList.contains("open"))
        return
    }
    // El selector de "Revisar cada" vive dentro del menú: tocarlo no lo cierra.
    if (event.target.closest(".walletsSegIntervalo")) return
    if (event.target.closest("#walletsCatalogoBtn")) abrirCarterasConocidas()
    carterasFijarMenu(false)
})

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") carterasFijarMenu(false)
})
