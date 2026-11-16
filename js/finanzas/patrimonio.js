// Ventana «Patrimonio»: lo que se tiene menos lo que se debe.
//
// El cálculo lo hace el servidor (core/patrimonio.py) con cuentas, inversiones,
// renta fija y deudas. Aquí solo se pinta el resultado: tarjetas de resumen, la
// composición de cada lado en una barra y el desglose por grupo con el peso de
// cada partida. Los porcentajes se calculan aquí porque son presentación.

const PATRIMONIO_ETIQUETAS = {
    inversiones: "Inversiones",
    cuentas: "Cuentas",
    rentaFija: "Renta fija y bonos",
    hipotecas: "Hipotecas",
    financiaciones: "Compras financiadas",
    microcreditos: "Microcréditos"
}

// Cada grupo lleva siempre el mismo color (barra, leyenda y cabecera del grupo).
const PATRIMONIO_COLORES = {
    inversiones: 0,
    cuentas: 1,
    rentaFija: 2,
    hipotecas: 3,
    financiaciones: 4,
    microcreditos: 5
}

// Por debajo de medio céntimo una partida es un cero: no merece su propia fila.
const PATRIMONIO_UMBRAL_CERO = 0.005

function patrimonioEtiqueta(grupo) {
    return PATRIMONIO_ETIQUETAS[grupo] || grupo
}

function patrimonioColor(grupo) {
    return `patrimonioColor${PATRIMONIO_COLORES[grupo] ?? 6}`
}

// Porcentaje de `parte` sobre `total`; sin total positivo no hay proporción.
function patrimonioPorcentaje(parte, total) {
    return total > 0 ? (parte / total) * 100 : 0
}

function patrimonioFormatoPct(valor) {
    return prestamoFormatoPorcentaje(valor)
}

function patrimonioImporte(valor, clase = "") {
    return `<span class="patrimonioImporte ${clase}">${escapeHtml(formatEuro(valor))}</span>`
}

function patrimonioTarjeta(etiqueta, valorHtml, nota, clase = "") {
    const notaHtml = nota ? `<span class="patrimonioCardNota">${escapeHtml(nota)}</span>` : ""
    return `<div class="patrimonioCard ${clase}"><span class="patrimonioCardEtiqueta">${escapeHtml(etiqueta)}</span><span class="patrimonioCardValor">${valorHtml}</span>${notaHtml}</div>`
}

function patrimonioPintarResumen(datos) {
    const contenedor = document.getElementById("patrimonioTotales")
    if (!contenedor) return
    const activos = datos.activos.total
    const deudas = datos.pasivos.total
    const endeudamiento = activos > 0 ? patrimonioFormatoPct((deudas / activos) * 100) : "—"
    contenedor.innerHTML = [
        patrimonioTarjeta(
            "Patrimonio neto",
            patrimonioImporte(datos.neto),
            "Activos menos deudas",
            datos.neto >= 0 ? "patrimonioCardNeto positivo" : "patrimonioCardNeto negativo"
        ),
        patrimonioTarjeta("Total activos", patrimonioImporte(activos), "Lo que tengo"),
        patrimonioTarjeta("Total deudas", patrimonioImporte(deudas), "Lo que debo"),
        patrimonioTarjeta(
            "Endeudamiento",
            `<span class="patrimonioImporte">${escapeHtml(endeudamiento)}</span>`,
            "Deudas sobre activos"
        )
    ].join("")
}

// Los porcentajes se calculan sobre los importes positivos: una cuenta en
// descubierto no resta espacio a las demás (daría pesos de más del 100 %), aunque
// sí cuenta en el total que se muestra.
function patrimonioPositivo(partidas) {
    return partidas.reduce((suma, p) => suma + Math.max(0, p.importe), 0)
}

function patrimonioGruposConPeso(lado) {
    const grupos = lado.grupos
        .filter((g) => g.partidas.length)
        .map((g) => ({ ...g, peso: patrimonioPositivo(g.partidas) }))
    const base = grupos.reduce((suma, g) => suma + g.peso, 0)
    return { grupos, base }
}

function patrimonioPintarBarra(idBarra, idLeyenda, lado) {
    const barra = document.getElementById(idBarra)
    const leyenda = document.getElementById(idLeyenda)
    if (!barra || !leyenda) return
    const { grupos, base } = patrimonioGruposConPeso(lado)
    if (!grupos.length || base <= 0) {
        barra.innerHTML = '<span class="patrimonioBarraVacia">Sin datos</span>'
        leyenda.innerHTML = ""
        return
    }
    barra.innerHTML = grupos
        .filter((g) => g.peso > 0)
        .map((g) => {
            const pct = patrimonioPorcentaje(g.peso, base)
            return `<span class="patrimonioSegmento ${patrimonioColor(g.grupo)}" style="width:${pct}%" title="${escapeAttr(`${patrimonioEtiqueta(g.grupo)}: ${patrimonioFormatoPct(pct)}`)}"></span>`
        })
        .join("")
    leyenda.innerHTML = grupos
        .map(
            (g) =>
                `<li><span class="patrimonioPunto ${patrimonioColor(g.grupo)}" aria-hidden="true"></span>${escapeHtml(patrimonioEtiqueta(g.grupo))}<strong>${escapeHtml(patrimonioFormatoPct(patrimonioPorcentaje(g.peso, base)))}</strong></li>`
        )
        .join("")
}

function patrimonioFilaPartida(partida, baseDelLado) {
    const negativa = partida.importe < 0
    const pct = patrimonioPorcentaje(Math.max(0, partida.importe), baseDelLado)
    const ancho = Math.min(100, pct)
    // Una partida negativa no tiene peso: ni barra ni porcentaje.
    return `<li class="patrimonioPartida${negativa ? " negativa" : ""}">
        <span class="patrimonioPartidaNombre" title="${escapeAttr(partida.nombre)}">${escapeHtml(partida.nombre)}</span>
        <span class="patrimonioPartidaBarra" aria-hidden="true"><span style="width:${ancho}%"></span></span>
        <span class="patrimonioPartidaPct">${negativa ? "" : escapeHtml(patrimonioFormatoPct(pct))}</span>
        ${patrimonioImporte(partida.importe, "patrimonioPartidaImporte")}
    </li>`
}

// Las partidas a cero se resumen en una línea: una lista de cuentas vacías no
// deja ver lo que importa.
function patrimonioFilaCeros(ceros) {
    if (!ceros.length) return ""
    const nombres = ceros.map((p) => p.nombre).join(", ")
    const texto = `${ceros.length} ${ceros.length === 1 ? "partida a cero" : "partidas a cero"}`
    return `<li class="patrimonioCeros" title="${escapeAttr(nombres)}">${escapeHtml(texto)}</li>`
}

function patrimonioGrupoHtml(grupo, baseDelLado) {
    const ordenadas = [...grupo.partidas].sort((a, b) => b.importe - a.importe)
    const conImporte = ordenadas.filter((p) => Math.abs(p.importe) >= PATRIMONIO_UMBRAL_CERO)
    const ceros = ordenadas.filter((p) => Math.abs(p.importe) < PATRIMONIO_UMBRAL_CERO)
    const pct = patrimonioFormatoPct(patrimonioPorcentaje(grupo.peso, baseDelLado))
    return `<details class="patrimonioGrupo ${patrimonioColor(grupo.grupo)}" open>
        <summary>
            <span class="patrimonioPunto ${patrimonioColor(grupo.grupo)}" aria-hidden="true"></span>
            <span class="patrimonioGrupoNombre">${escapeHtml(patrimonioEtiqueta(grupo.grupo))}</span>
            <span class="patrimonioGrupoPct">${escapeHtml(pct)}</span>
            ${patrimonioImporte(grupo.total, "patrimonioGrupoTotal")}
        </summary>
        <ul class="patrimonioPartidas">
            ${conImporte.map((p) => patrimonioFilaPartida(p, baseDelLado)).join("")}
            ${patrimonioFilaCeros(ceros)}
        </ul>
    </details>`
}

function patrimonioPintarLado(idLista, idTotal, lado) {
    const lista = document.getElementById(idLista)
    const total = document.getElementById(idTotal)
    if (total) total.innerHTML = escapeHtml(formatEuro(lado.total))
    if (!lista) return ""
    const { grupos, base } = patrimonioGruposConPeso(lado)
    const html = grupos.map((g) => patrimonioGrupoHtml(g, base)).join("")
    lista.innerHTML = html
    return html
}

function patrimonioPintarAvisos(avisos) {
    const el = document.getElementById("patrimonioAvisos")
    if (!el) return
    const hay = Array.isArray(avisos) && avisos.length > 0
    el.textContent = hay ? `Fuera del total por no poder calcularse: ${avisos.join(" · ")}` : ""
    el.classList.toggle("hidden", !hay)
}

function patrimonioPintar(datos) {
    patrimonioPintarResumen(datos)
    patrimonioPintarBarra("patrimonioBarraActivos", "patrimonioLeyendaActivos", datos.activos)
    patrimonioPintarBarra("patrimonioBarraPasivos", "patrimonioLeyendaPasivos", datos.pasivos)
    patrimonioPintarLado("patrimonioActivosLista", "patrimonioActivosTotal", datos.activos)
    const htmlPasivos = patrimonioPintarLado("patrimonioPasivosLista", "patrimonioPasivosTotal", datos.pasivos)
    document.getElementById("patrimonioPasivosVacio")?.classList.toggle("hidden", Boolean(htmlPasivos))
    patrimonioPintarAvisos(datos.avisos)
}

async function initPatrimonioLogic() {
    window.flushPendingPageChanges = null
    const errorEl = document.getElementById("patrimonioError")
    errorEl?.classList.add("hidden")
    try {
        patrimonioPintar(await Api.get("/api/patrimonio"))
    } catch (error) {
        if (errorEl) {
            errorEl.textContent = `No se pudo calcular el patrimonio: ${error.message}`
            errorEl.classList.remove("hidden")
        }
    }
}
