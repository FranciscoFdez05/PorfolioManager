// Páginas del menú «Alertas».
//
//   * Todas las alertas — el panel de alertas (js/cartera/alertas-panel.js)
//     con todas las alertas de la cartera y filtros por tipo y activo.
//   * Últimos avisos — lo que ha saltado: avisos de las reglas y alertas de
//     precio ya disparadas, el más reciente primero.
//
// «Todas las alertas» lleva además una columna lateral: estado del bot de
// Telegram (sin él no llega ningún aviso), los últimos avisos y qué vigila
// cada familia de alertas.

// Categorías de Ajustes › Avisos que cubren las alertas: si alguna está
// apagada, esas alertas se vigilan pero no avisan.
const alertasCategoriasTelegram = ["precios", "movimientos", "posicion", "cartera"]
const alertasUltimosMax = 5

const alertasGuiaGrupo = {
    Precio: "Llega a un precio o se mueve un % en el día. Avisa una vez.",
    Movimiento: "Caídas y subidas bruscas en un tramo corto de tiempo.",
    Posición: "Lo que ganas o pierdes y la distancia a tu precio medio.",
    Cotización: "Un activo se queda sin precio demasiado tiempo.",
    Cartera: "Valor total, caída de la cartera y peso de cada activo."
}

async function initAlertasPageLogic() {
    const contenedor = document.getElementById("alertasPaginaPanel")
    if (!contenedor) return
    alertasPintarGuia()
    document.getElementById("alertasVerAvisos")?.addEventListener("click", () => {
        document.querySelector('[data-page="alertasAvisos"]')?.click()
    })
    // El lateral no bloquea el panel: cada caja se rellena cuando llega lo suyo.
    alertasPintarTelegram()
    alertasPintarUltimos()
    await crearPanelAlertas(contenedor)
}

function alertasPintarGuia() {
    const guia = document.getElementById("alertasGuia")
    if (!guia) return
    guia.innerHTML = alertasGruposOrden
        .map(
            (grupo) => `
            <li class="alLateralGuiaItem">
                ${alertasIcono(grupo)}
                <span><strong>${escapeHtml(grupo)}</strong>${escapeHtml(alertasGuiaGrupo[grupo] || "")}</span>
            </li>`
        )
        .join("")
}

// El bot se configura en Ajustes › Conexiones; qué avisos se mandan, en
// Ajustes › Avisos.
async function alertasAbrirAjustes(pestana) {
    await openSettingsModal()
    document.querySelector(`.sttNavBtn[data-stt="${pestana}"]`)?.click()
    if (pestana === "conexiones") {
        document.getElementById("ajustesTelegramSection")?.scrollIntoView({ block: "start" })
    }
}

// Estado del bot en una frase, y qué hay que hacer si algo impide que lleguen
// los avisos: sin configurar, silenciado o con categorías apagadas.
function alertasEstadoTelegram(datos) {
    if (!datos.configurado) {
        return {
            clase: "error",
            texto: "Sin configurar",
            detalle: "Las alertas se vigilan, pero no llegará ningún aviso hasta que conectes el bot.",
            boton: "Configurar Telegram"
        }
    }
    const apagadas = (datos.avisos || [])
        .filter((aviso) => alertasCategoriasTelegram.includes(aviso.clave) && !aviso.activo)
        .map((aviso) => aviso.titulo)
    if (datos.silenciadoHasta) {
        return {
            clase: "aviso",
            texto: "Silenciado",
            detalle: `No se envía nada hasta el ${alertasFecha(datos.silenciadoHasta)}.`,
            boton: "Ajustes de Telegram"
        }
    }
    if (apagadas.length) {
        return {
            clase: "aviso",
            texto: "Conectado, con avisos apagados",
            detalle: `No avisan: ${apagadas.join(", ")}.`,
            boton: "Revisar avisos",
            pestana: "avisos"
        }
    }
    return {
        clase: "ok",
        texto: "Conectado",
        detalle: "Los avisos llegan a tu chat aunque la web esté cerrada.",
        boton: ""
    }
}

async function alertasPintarTelegram() {
    const cuerpo = document.getElementById("alertasTelegramCuerpo")
    if (!cuerpo) return
    try {
        const estado = alertasEstadoTelegram(await Api.get("/api/settings/telegram"))
        cuerpo.innerHTML = `
            <div class="alLateralEstado alLateralEstado--${estado.clase}">
                <span class="alLateralPunto" aria-hidden="true"></span>${escapeHtml(estado.texto)}
            </div>
            <p class="alLateralTexto">${escapeHtml(estado.detalle)}</p>
            ${estado.boton ? `<button type="button" class="secondaryButton alLateralBoton">${escapeHtml(estado.boton)}</button>` : ""}`
        cuerpo
            .querySelector(".alLateralBoton")
            ?.addEventListener("click", () => alertasAbrirAjustes(estado.pestana || "conexiones"))
    } catch (error) {
        cuerpo.innerHTML = `<span class="alLateralTenue">No se pudo comprobar: ${escapeHtml(Api.describeError(error))}</span>`
    }
}

async function alertasPintarUltimos() {
    const caja = document.getElementById("alertasUltimosAvisos")
    if (!caja) return
    try {
        const filas = (await alertasLeerAvisos()).slice(0, alertasUltimosMax)
        caja.innerHTML = filas.length
            ? filas.map(alertasPintarAvisoCompacto).join("")
            : `<span class="alLateralTenue">Aún no ha saltado ninguna alerta.</span>`
    } catch (error) {
        caja.innerHTML = `<span class="alLateralTenue">No se pudieron cargar: ${escapeHtml(Api.describeError(error))}</span>`
    }
}

function alertasPintarAvisoCompacto(fila) {
    return `
        <div class="alLateralAviso">
            ${alertasIcono(fila.grupo)}
            <div class="alLateralAvisoTexto">
                <div class="alLateralAvisoSujeto">${escapeHtml(fila.sujeto)}</div>
                <div class="alLateralAvisoDetalle" title="${escapeHtml(fila.detalle)}">${escapeHtml(fila.detalle)}</div>
                <div class="alLateralAvisoHora">${escapeHtml(alertasFecha(fila.ts))}</div>
            </div>
        </div>`
}

// Tipo de regla -> [grupo, nombre corto] para la lista de avisos.
const alertasAvisoTipo = {
    caida: ["Movimiento", "Caída brusca"],
    subida: ["Movimiento", "Subida brusca"],
    rentabilidad: ["Posición", "Rentabilidad"],
    precio_medio: ["Posición", "Precio medio"],
    sin_cotizacion: ["Cotización", "Sin cotización"],
    cartera_valor: ["Cartera", "Valor de la cartera"],
    cartera_caida: ["Cartera", "Caída de la cartera"],
    peso: ["Cartera", "Peso en la cartera"]
}

function alertasAvisosFilas(reglas, precio, nombres) {
    const deReglas = (reglas.avisos || []).map((aviso) => {
        const [grupo, etiqueta] = alertasAvisoTipo[aviso.tipo] || ["Cartera", aviso.tipo]
        return {
            ts: aviso.avisada,
            grupo,
            etiqueta,
            sujeto: aviso.assetId
                ? alertasEtiquetaActivo({ name: aviso.activoNombre, symbol: aviso.activoSimbolo })
                : "Cartera",
            detalle: aviso.detalle
        }
    })
    const dePrecio = (precio.alertas || [])
        .filter((alerta) => alerta.disparada)
        .map((alerta) => ({
            ts: alerta.disparada,
            grupo: "Precio",
            etiqueta: "Alerta de precio",
            sujeto: nombres.get(alerta.assetId) || alerta.assetId,
            detalle: `${alertasFrasePrecio(alerta, "")} · saltó con ${alertasPrecioLegible(alerta.precioDisparo)}`
        }))
    return [...deReglas, ...dePrecio].sort((a, b) => b.ts - a.ts)
}

// Todos los avisos ya enviados, el más reciente primero.
async function alertasLeerAvisos() {
    const [reglas, precio, activos] = await Promise.all([
        Api.get("/api/alertas-reglas"),
        Api.get("/api/alertas"),
        Api.get("/api/alertas/activos")
    ])
    const nombres = new Map((activos.activos || []).map((a) => [a.id, alertasEtiquetaActivo(a)]))
    return alertasAvisosFilas(reglas, precio, nombres)
}

async function initAlertasAvisosLogic() {
    const lista = document.getElementById("alertasAvisosLista")
    if (!lista) return

    try {
        const filas = await alertasLeerAvisos()

        if (!filas.length) {
            lista.innerHTML = `
                <div class="alPanelVacio">
                    <strong>Aún no ha saltado ninguna alerta</strong>
                    <span>Aquí verás cada aviso enviado por Telegram, con lo que lo provocó.</span>
                </div>`
            return
        }
        lista.innerHTML = filas
            .map(
                (fila) => `
                <div class="alFila alFila--aviso">
                    ${alertasIcono(fila.grupo)}
                    <div class="alFilaTexto">
                        <div class="alFilaTitulo"><span class="alFilaAmbito">${escapeHtml(fila.sujeto)}</span><span class="alFilaSeparador">·</span>${escapeHtml(fila.detalle)}</div>
                        <div class="alFilaMeta">${escapeHtml(fila.etiqueta)}</div>
                    </div>
                    <span class="alFilaHora">${escapeHtml(alertasFecha(fila.ts))}</span>
                </div>`
            )
            .join("")
    } catch (error) {
        lista.innerHTML = `<div class="alPanelVacio"><strong>No se pudieron cargar los avisos</strong><span>${escapeHtml(Api.describeError(error))}</span></div>`
    }
}
