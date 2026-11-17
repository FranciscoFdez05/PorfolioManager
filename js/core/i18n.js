/**
 * Internacionalización de la interfaz.
 *
 * Los textos viven en diccionarios por idioma (js/locales/<idioma>.js), que se
 * cargan como scripts antes que este módulo y se registran en
 * `window.i18nDiccionarios`. Son .js y no .json porque el servidor solo sirve
 * una lista cerrada de extensiones y abrirla a .json expondría package.json y
 * compañía; como scripts, además, heredan el versionado `?v=` y la caché
 * inmutable del resto del código propio.
 *
 * El español es la fuente de verdad y el idioma de respaldo: cualquier clave
 * que falte en otro idioma se muestra en español, y el HTML sigue llevando el
 * texto en español como contenido por defecto, de modo que lo que aún no esté
 * migrado se ve en español en vez de vacío.
 *
 * El idioma (qué palabras) es independiente del formato regional de números
 * (`numLocale` en Ajustes, ver `_nl()` en shared-utils.js): un usuario puede
 * querer la interfaz en inglés con 1.234,56 €.
 *
 * Uso:
 *     t("comun.guardado")                         // "Guardado"
 *     t(clave, { count: 3 })                      // forma plural de 3
 *     aplicarI18n(contenedor)                     // traduce los data-i18n*
 */

// Locale BCP 47 que se usa para fechas con palabras (nombres de mes o de día)
// en cada idioma. Inglés británico y no estadounidense porque la aplicación
// trabaja en euros y con fiscalidad española: el orden día/mes es el esperado.
const i18nLocales = { es: "es-ES", en: "en-GB" }
const i18nIdiomaDefecto = "es"
// Copia local del idioma para pintar el armazón en el idioma correcto antes de
// que responda /api/settings, igual que hace el tema con "portfolioTheme".
const i18nClaveLocal = "portfolioIdioma"
// Atributos traducibles: data-i18n-<atributo>="clave".
const i18nAtributos = ["title", "placeholder", "aria-label", "alt"]

let _i18nIdioma = _i18nIdiomaInicial()

/**
 * Lee el idioma guardado en localStorage, validado contra los disponibles.
 *
 * Returns:
 *     Código de idioma ("es", "en"); el de defecto si no hay uno válido.
 */
function _i18nIdiomaInicial() {
    try {
        const guardado = localStorage.getItem(i18nClaveLocal)
        if (guardado && Object.hasOwn(i18nLocales, guardado)) return guardado
    } catch {
        // Sin acceso a localStorage (modo privado estricto): idioma de defecto.
    }
    return i18nIdiomaDefecto
}

/**
 * Idioma activo de la interfaz.
 *
 * Returns:
 *     Código de idioma ("es", "en").
 */
function idiomaActual() {
    return _i18nIdioma
}

/**
 * Locale para formatear fechas con palabras según el idioma de la interfaz.
 *
 * Los números no usan esta función sino `_nl()`, que sigue el ajuste de
 * formato regional.
 *
 * Returns:
 *     Locale BCP 47 ("es-ES", "en-GB").
 */
function uiLocale() {
    return i18nLocales[_i18nIdioma] || i18nLocales[i18nIdiomaDefecto]
}

/**
 * Cambia el idioma activo y lo recuerda para el siguiente arranque.
 *
 * No vuelve a pintar la interfaz: el texto generado por JS ya está en el DOM,
 * así que quien cambia el idioma desde Ajustes recarga la aplicación.
 *
 * Args:
 *     idioma: Código de idioma. Uno desconocido se ignora.
 *
 * Returns:
 *     true si el idioma cambió.
 */
function establecerIdioma(idioma) {
    if (!Object.hasOwn(i18nLocales, idioma) || idioma === _i18nIdioma) return false
    _i18nIdioma = idioma
    try {
        localStorage.setItem(i18nClaveLocal, idioma)
    } catch {
        // Sin localStorage solo se pierde evitar el parpadeo del próximo arranque.
    }
    document.documentElement.lang = idioma
    return true
}

/**
 * Busca una clave con puntos ("menu.cartera") dentro de un diccionario anidado.
 *
 * Args:
 *     diccionario: Objeto con los textos de un idioma.
 *     clave: Ruta separada por puntos.
 *
 * Returns:
 *     El texto u objeto de plurales, o undefined si no existe.
 */
function _i18nBuscar(diccionario, clave) {
    let nodo = diccionario
    for (const parte of clave.split(".")) {
        if (nodo == null || typeof nodo !== "object") return undefined
        nodo = nodo[parte]
    }
    return nodo
}

/**
 * Elige la forma plural según `Intl.PluralRules` del idioma activo.
 *
 * Args:
 *     formas: Objeto con las categorías del idioma ("one", "other"...).
 *     cuenta: Número que decide la forma.
 *
 * Returns:
 *     El texto de la forma que toca, o "other" si falta esa categoría.
 */
function _i18nPlural(formas, cuenta) {
    const categoria = new Intl.PluralRules(uiLocale()).select(Number(cuenta))
    return formas[categoria] ?? formas.other
}

/**
 * Sustituye los marcadores {nombre} por los valores dados.
 *
 * Los marcadores sin valor se dejan tal cual para que el hueco se vea en
 * pantalla en vez de convertirse en "undefined".
 */
function _i18nInterpolar(texto, variables) {
    if (!variables) return texto
    return texto.replace(/\{(\w+)\}/g, (marca, nombre) =>
        Object.hasOwn(variables, nombre) ? String(variables[nombre]) : marca
    )
}

/**
 * Devuelve el texto de una clave en el idioma activo.
 *
 * Orden de búsqueda: idioma activo, español y, si tampoco existe, la propia
 * clave (con un aviso en consola) para que la falta se vea al probar.
 *
 * Args:
 *     clave: Ruta del texto en el diccionario ("ajustes.guardado").
 *     variables: Valores para los marcadores {nombre}. `count` elige además la
 *         forma plural cuando la entrada es un objeto {one, other}.
 *
 * Returns:
 *     El texto traducido e interpolado.
 *
 * Example:
 *     // Con { meses: { one: "{count} mes", other: "{count} meses" } }:
 *     t(clave, { count: 1 })  // "1 mes"
 */
function t(clave, variables) {
    const diccionarios = window.i18nDiccionarios || {}
    let entrada = _i18nBuscar(diccionarios[_i18nIdioma], clave)
    if (entrada === undefined && _i18nIdioma !== i18nIdiomaDefecto) {
        entrada = _i18nBuscar(diccionarios[i18nIdiomaDefecto], clave)
    }
    if (entrada === undefined) {
        console.warn(`[i18n] Falta la clave "${clave}"`)
        return clave
    }
    if (typeof entrada === "object") {
        entrada = _i18nPlural(entrada, variables?.count ?? 0)
    }
    return _i18nInterpolar(String(entrada), variables)
}

/**
 * Traduce un atributo, respetando que tooltips.js lo haya movido a data-tip.
 */
function _i18nAplicarAtributo(el, atributo, texto) {
    if (atributo === "title" && !el.hasAttribute("title") && el.dataset.tip !== undefined) {
        el.dataset.tip = texto
        return
    }
    el.setAttribute(atributo, texto)
}

/**
 * Traduce los elementos marcados con data-i18n* dentro de una raíz.
 *
 * `data-i18n="clave"` sustituye el textContent, así que solo debe ponerse en
 * elementos cuyo contenido sea texto plano (si llevan hijos, el texto va en su
 * propio <span>). Las traducciones nunca se insertan como HTML.
 *
 * Args:
 *     raiz: Elemento o documento a recorrer. Por defecto, todo el documento.
 */
function aplicarI18n(raiz = document) {
    if (!raiz?.querySelectorAll) return
    raiz.querySelectorAll("[data-i18n]").forEach((el) => {
        el.textContent = t(el.dataset.i18n)
    })
    for (const atributo of i18nAtributos) {
        const dato = `data-i18n-${atributo}`
        raiz.querySelectorAll(`[${dato}]`).forEach((el) => {
            _i18nAplicarAtributo(el, atributo, t(el.getAttribute(dato)))
        })
    }
}

document.documentElement.lang = _i18nIdioma
