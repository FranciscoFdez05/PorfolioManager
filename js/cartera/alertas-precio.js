// Pestaña «Alertas» de la ficha de un activo.
//
// Es el mismo panel que la página «Alertas > Todas las alertas»
// (js/cartera/alertas-panel.js) con el activo ya fijado: ofrece los tipos que
// se ponen sobre un activo —precio, caída o subida brusca, rentabilidad, precio
// medio, sin cotización y peso en la cartera— y lista las suyas junto a las
// reglas generales que también lo vigilan. El servidor las comprueba aunque no
// haya ninguna pestaña abierta y avisa por Telegram (Ajustes > Telegram).

function alertasPrecioActualizarPestana(activas) {
    const boton = document.getElementById("alertasTabBtn")
    if (boton) boton.textContent = activas ? `Alertas (${activas})` : "Alertas"
}

async function initAssetAlertasLogic(asset) {
    const seccion = document.getElementById("assetAlertasSection")
    if (!seccion || !asset?.id) return

    await crearPanelAlertas(seccion, { asset, alCambiar: alertasPrecioActualizarPestana })
}
