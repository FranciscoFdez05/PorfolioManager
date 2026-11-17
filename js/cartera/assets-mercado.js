// Pestaña "Mercado" de la ficha del activo: capitalización, suministro,
// derivados, tendencia y fundamentales de ESE activo.
//
// Los datos salen de /api/market/ficha (scanner de TradingView y, para cripto,
// el perpetuo USDT de Binance). El ticker es el mismo que resuelve
// `buildTVSymbol` para abrir el gráfico: aquí no hay listas de activos,
// bolsas ni divisas. Lo que un proveedor no publica se enseña como "—".
// Reutiliza los bloques y el formato de fundamentales.js (fnDetail*, fn*).

let _assetMercadoAsset = null
let _assetMercadoRequestId = 0

// Escala larga del español (1 B = un billón = 10^12). `Intl` con notation
// "compact" mezcla "6073 M" y "30,1 mil M" en el mismo panel según la cifra, y
// las tarjetas se leen en columna: una escala fija las hace comparables.
const _MK_SCALE = [
    { from: 1e12, divisor: 1e12, suffix: " B" },
    { from: 1e9, divisor: 1e9, suffix: " mil M" },
    { from: 1e6, divisor: 1e6, suffix: " M" }
]
const _MK_CACHE_TTL = 3 * 60 * 1000
const _mkCache = new Map() // ticker -> { ts, data }

// Se llama al montar la ficha: la pestaña se pinta al abrirla, no antes, para
// no gastar peticiones a los proveedores en fichas donde no se mira.
function assetMercadoRegistrar(asset) {
    _assetMercadoAsset = asset
}

function renderAssetMercadoSection() {
    const section = document.getElementById("assetMercadoSection")
    if (!section || !_assetMercadoAsset) return

    const tvSymbol = typeof buildTVSymbol === "function" ? String(buildTVSymbol(_assetMercadoAsset) || "").toUpperCase() : ""
    if (!tvSymbol.includes(":")) {
        section.innerHTML = mkMessage(
            "Este activo no tiene un ticker de TradingView con mercado (MERCADO:TICKER), así que no hay datos que mostrar. Puedes asignarlo desde Editar activo."
        )
        return
    }

    const cached = _mkCache.get(tvSymbol)
    if (cached && Date.now() - cached.ts < _MK_CACHE_TTL) {
        section.innerHTML = mkBuildHtml(cached.data, _assetMercadoAsset)
        mkLevelsAfterRender(section, cached.data, _assetMercadoAsset)
        return
    }

    mkLoad(section, tvSymbol)
}

async function mkLoad(section, tvSymbol) {
    // Si el usuario cambia de ficha mientras llega la respuesta, la respuesta
    // vieja no debe pisar la ficha nueva.
    const requestId = ++_assetMercadoRequestId
    section.innerHTML = mkMessage("Cargando datos de mercado…")

    let html
    let loaded = null
    try {
        const res = await fetch(`/api/market/ficha?symbol=${encodeURIComponent(tvSymbol)}`)
        const data = await res.json()
        if (!data.ok) throw new Error(data.error || "Respuesta no válida")
        _mkCache.set(tvSymbol, { ts: Date.now(), data })
        html = mkBuildHtml(data, _assetMercadoAsset)
        loaded = data
    } catch (err) {
        console.error("Mercado: error cargando datos", err)
        html = mkMessage(`No se pudieron cargar los datos de mercado: ${escapeHtml(err.message)}`, true)
    }

    if (requestId !== _assetMercadoRequestId) return
    section.innerHTML = html
    mkLevelsAfterRender(section, loaded, _assetMercadoAsset)
}

function mkMessage(text, withRetry = false) {
    const retry = withRetry ? `<button type="button" class="mkRetryBtn" data-mk-retry>Reintentar</button>` : ""
    return `<div class="mkMessage"><span>${text}</span>${retry}</div>`
}

// ── Composición ─────────────────────────────────────────────────────────────

function mkBuildHtml(data, asset) {
    const s = data.stats
    if (!s) return mkMessage("TradingView no tiene datos para el ticker de este activo.")

    const cur = String(s.currency || asset.currency || "EUR").toUpperCase()
    // El popup de datos técnicos se abre más tarde, con lo que se pintó aquí.
    _mkTecActivo = { nombre: String(asset?.name || data.ticker || ""), stats: s, divisa: cur }
    const blocks = (data.isCrypto ? mkCryptoBlocks(data) : mkTraditionalBlocks(s, cur))

    return `
        <div class="mkWrap">
            ${blocks}
            <div class="mkSection">
                <div class="fnDetailGrid">
                    ${fnDetailPerformance(s)}
                    ${fnDetailRange(s, cur)}
                    ${mkTrendCol(s)}
                </div>
            </div>
            <div class="mkSection">
                <div class="fnDetailGrid">
                    ${mkLevelsCol(s, cur, data.ticker)}
                    ${mkQualityCol(s)}
                    ${mkGaugeCol(s)}
                </div>
            </div>
            <div class="mkSection">
                <div class="fnDetailGrid">
                    ${fnDetailMovingAverages(s, cur)}
                    ${fnDetailOscillators(s)}
                    ${mkPivotsCol(s, cur)}
                </div>
            </div>
            ${data.isCrypto ? "" : `<div class="mkSection"><div class="fnDetailGrid">${fnDetailFundamentals(s, cur)}${mkListingCol(s)}</div></div>`}
        </div>`
}

// ── Niveles clave y calidad técnica (columnas de filas, como Rendimiento) ───

// Una fila con el matiz de distancia al precio al lado, como en "Rango y volatilidad".
function mkNivelLinea(etiqueta, valor, close, cur, attrs = "") {
    const num = fnToNumber(valor)
    if (num === null) return ""
    return `<div class="fnDetailLine"${attrs}><span>${etiqueta}</span><span>${fnPrice(num, cur)}${fnDistanceHtml(close, num)}</span></div>`
}

/**
 * Columna "Niveles clave": mínimo histórico, máximo y mínimo del año en curso y
 * de uno y tres meses. El máximo histórico y las 52 semanas ya salen en "Rango y
 * volatilidad". Los del año no los publica el scanner: se rellenan después con
 * los cierres diarios.
 *
 * @param {object} s Estadísticas del scanner.
 * @param {string} cur Divisa de cotización.
 * @param {string} [ticker] Ticker con mercado, para pedir los cierres del año.
 * @returns {string} HTML de la columna.
 */
function mkLevelsCol(s, cur, ticker = "") {
    const anio = new Date().getFullYear()
    const anual = (clave, etiqueta) =>
        ticker
            ? `<div class="fnDetailLine" data-mk-anual="${clave}" title="Según cierres diarios"><span>${etiqueta} ${anio} (cierre)</span><span>—</span></div>`
            : ""

    return `
        <div class="fnDetailCol" data-mk-ticker="${escapeHtml(ticker)}">
            ${fnDetailColHead("Niveles clave")}
            ${mkNivelLinea("Mínimo histórico", s["Low.All"], s.close, cur)}
            ${anual("max", "Máximo")}
            ${anual("min", "Mínimo")}
            ${mkNivelLinea("Máximo 1 mes", s["High.1M"], s.close, cur)}
            ${mkNivelLinea("Mínimo 1 mes", s["Low.1M"], s.close, cur)}
            ${mkNivelLinea("Máximo 3 meses", s["High.3M"], s.close, cur)}
            ${mkNivelLinea("Mínimo 3 meses", s["Low.3M"], s.close, cur)}
        </div>`
}

/**
 * Rellena el máximo y el mínimo del año en curso con los cierres diarios.
 *
 * Reutiliza las velas y la caché de la ficha lateral (`detMkObtenerSerie`); el
 * scanner no publica estos niveles y por eso son de cierre, no intradía.
 *
 * @param {HTMLElement} section Sección de la pestaña Mercado ya pintada.
 * @param {string} ticker Ticker con mercado.
 * @param {number|string|null} close Precio actual, para la distancia.
 * @param {string} cur Divisa de cotización.
 * @returns {Promise<void>}
 */
async function mkLevelsFillYear(section, ticker, close, cur) {
    if (!ticker || typeof detMkObtenerSerie !== "function") return
    const puntos = await detMkObtenerSerie(ticker)
    // Si entretanto se pintó otra ficha, estos datos sobran.
    if (section.querySelector("[data-mk-ticker]")?.dataset.mkTicker !== ticker) return

    const anio = new Date().getFullYear()
    const cierres = (puntos || []).filter(([ts, c]) => c > 0 && new Date(ts * 1000).getFullYear() === anio).map(([, c]) => c)
    if (!cierres.length) return

    const niveles = { max: Math.max(...cierres), min: Math.min(...cierres) }
    for (const [clave, valor] of Object.entries(niveles)) {
        const celda = section.querySelector(`[data-mk-anual="${clave}"] span:last-child`)
        if (celda) celda.innerHTML = fnPrice(valor, cur) + fnDistanceHtml(close, valor)
    }
}

// Tras pintar la sección (desde caché o desde la red) se piden los niveles del año.
function mkLevelsAfterRender(section, data, asset) {
    const s = data?.stats
    if (!s || !data.ticker) return
    const cur = String(s.currency || asset?.currency || "EUR").toUpperCase()
    mkLevelsFillYear(section, data.ticker, s.close, cur)
}

/**
 * Columna "Calidad técnica": dónde está el precio respecto a sus rangos y medias.
 * Cada fila que necesita un dato que el proveedor no da se omite.
 *
 * @param {object} s Estadísticas del scanner.
 * @returns {string} HTML de la columna.
 */
function mkQualityCol(s) {
    const precio = fnToNumber(s.close)
    const maximo = fnToNumber(s.price_52_week_high)
    const minimo = fnToNumber(s.price_52_week_low)
    const bandaAlta = fnToNumber(s["BB.upper"])
    const bandaBaja = fnToNumber(s["BB.lower"])
    const adx = fnToNumber(s.ADX)
    const atr = fnToNumber(s.ATR)
    const sma50 = fnToNumber(s.SMA50)
    const sma200 = fnToNumber(s.SMA200)
    const sub = (texto) => ` <small class="fnDetailSub">${texto}</small>`
    const filas = []

    if (precio !== null && maximo !== null && minimo !== null && maximo > minimo) {
        filas.push(["Posición en el rango de 52 sem.", fnPercentPlain(((precio - minimo) / (maximo - minimo)) * 100, 1)])
    }
    if (precio !== null && bandaAlta !== null && bandaBaja !== null && bandaAlta > bandaBaja) {
        const pctB = ((precio - bandaBaja) / (bandaAlta - bandaBaja)) * 100
        const ancho = ((bandaAlta - bandaBaja) / ((bandaAlta + bandaBaja) / 2)) * 100
        filas.push(["Bollinger %B / anchura", `${fnPercentPlain(pctB, 1)}${sub(fnPercentPlain(ancho, 1))}`])
    }
    if (adx !== null) {
        const fuerza = adx < 20 ? "sin tendencia" : adx < 25 ? "débil" : adx < 50 ? "fuerte" : "muy fuerte"
        filas.push(["Fuerza de tendencia (ADX)", `${fnRatio(adx, 1)}${sub(fuerza)}`])
    }
    if (precio && atr !== null) filas.push(["ATR / precio", fnPercentPlain((atr / precio) * 100, 2)])
    if (sma50 !== null && sma200 !== null && sma200 !== 0) {
        const alcista = sma50 >= sma200
        filas.push([
            "Media 50 vs. 200",
            `<span class="${alcista ? "fnPos" : "fnNeg"}">${alcista ? "Alcista" : "Bajista"}</span>${sub(fnPercentSigned((sma50 / sma200 - 1) * 100, 1))}`
        ])
    }
    const medias = mkTecMedias(s).filter((fila) => fila.accion)
    if (medias.length) {
        const aFavor = medias.filter((fila) => fila.accion === _MK_TEC_COMPRA).length
        filas.push(["Medias bajo el precio", `${aFavor} de ${medias.length}`])
    }

    return `
        <div class="fnDetailCol">
            ${fnDetailColHead("Calidad técnica")}
            ${filas.map(([etiqueta, valor]) => fnDetailLine(etiqueta, valor)).join("")}
        </div>`
}

/**
 * Columna de pivotes mensuales (método clásico), del soporte más lejano a la resistencia más lejana.
 *
 * @param {object} s Estadísticas del scanner.
 * @param {string} cur Divisa de cotización.
 * @returns {string} HTML de la columna, vacío si el scanner no publica pivotes.
 */
function mkPivotsCol(s, cur) {
    const niveles = [
        ["Resistencia R3", "R3"],
        ["Resistencia R2", "R2"],
        ["Resistencia R1", "R1"],
        ["Pivote", "Middle"],
        ["Soporte S1", "S1"],
        ["Soporte S2", "S2"],
        ["Soporte S3", "S3"]
    ]
    const filas = niveles.map(([etiqueta, nivel]) => mkNivelLinea(etiqueta, s[`Pivot.M.Classic.${nivel}`], s.close, cur)).join("")
    if (!filas.trim()) return ""
    return `
        <div class="fnDetailCol">
            ${fnDetailColHead("Pivotes mensuales (clásico)")}
            ${filas}
        </div>`
}

/**
 * Tercera columna: medidor de la valoración global que abre el popup de datos técnicos.
 *
 * @param {object} s Estadísticas del scanner.
 * @returns {string} HTML de la columna, vacío si no hay valoración.
 */
function mkGaugeCol(s) {
    if (fnToNumber(s["Recommend.All"]) === null) return ""
    return `
        <div class="fnDetailCol mkTecGaugeCol">
            ${fnDetailColHead("Datos técnicos")}
            <button type="button" class="mkTecMedidor" data-mk-tecnico aria-haspopup="dialog" title="Ver datos técnicos completos">
                ${mkTecGauge(s["Recommend.All"], "Valoración técnica global")}
                <span class="mkTecAmpliar">Ampliar</span>
            </button>
        </div>`
}

// ── Cripto ──────────────────────────────────────────────────────────────────

function mkCryptoBlocks(data) {
    const coin = data.coin
    const parts = [mkSectionTitle("Capital y suministro")]

    if (coin) {
        parts.push(`<div class="mkGrid">${mkCoinCards(coin)}</div>`)
        if (coin.crypto_common_categories?.length) {
            const chips = coin.crypto_common_categories.slice(0, 6).map((c) => `<span class="mkChip">${escapeHtml(c)}</span>`).join("")
            parts.push(`<div class="mkChips">${chips}</div>`)
        }
    } else {
        parts.push(mkMessage(data.coinError ? escapeHtml(data.coinError) : "TradingView no publica datos de suministro para esta moneda."))
    }

    parts.push(mkSectionTitle(`Derivados${data.derivatives ? ` · ${escapeHtml(data.derivatives.symbol)} perpetuo (Binance)` : ""}`))
    parts.push(mkDerivativesHtml(data, coin))
    return parts.join("")
}

function mkCoinCards(coin) {
    const cap = fnToNumber(coin.market_cap_calc)
    const volume = fnToNumber(coin["24h_vol_cmc"])
    const circulating = fnToNumber(coin.circulating_supply)
    const maxSupply = fnToNumber(coin.max_supply)
    const base = escapeHtml(coin.base_currency)

    const volRatio = cap && volume !== null ? (volume / cap) * 100 : null
    const issuedPct = circulating !== null && maxSupply ? (circulating / maxSupply) * 100 : null
    const rank = fnToNumber(coin.crypto_total_rank)

    return [
        mkCard("Capitalización de mercado", mkMoney(cap, "USD"), rank !== null ? `Puesto n.º ${rank}` : ""),
        mkCard("Volumen (24 h)", mkMoney(volume, "USD"), mkSignedSub(coin["24h_vol_change|5"])),
        mkCard("Vol. / Cap. de mercado", volRatio === null ? "—" : fnPercentPlain(volRatio, 1)),
        mkCard("FDV (valoración diluida)", mkMoney(fnToNumber(coin.market_cap_diluted_calc), "USD")),
        mkCard("Suministro en circulación", mkSupply(circulating, base), issuedPct === null ? "" : `${fnPercentPlain(issuedPct, 1)} del máximo`),
        mkCard("Suministro total", mkSupply(fnToNumber(coin.total_supply), base)),
        mkCard("Suministro máximo", maxSupply === null ? "Sin límite" : mkSupply(maxSupply, base))
    ].join("")
}

function mkDerivativesHtml(data, coin) {
    const d = data.derivatives
    if (!d) {
        const reason = data.derivativesError
            ? escapeHtml(data.derivativesError)
            : "Binance no tiene un perpetuo USDT para esta moneda."
        return mkMessage(reason)
    }

    const cap = coin ? fnToNumber(coin.market_cap_calc) : null
    const oiToCap = cap && d.openInterestUsd !== null ? (d.openInterestUsd / cap) * 100 : null
    // Tasa positiva: los largos pagan a los cortos (el mercado apuesta al alza).
    const funding = d.fundingRate === null ? null : d.fundingRate * 100
    const fundingSub = d.nextFundingTime
        ? `Próximo cobro ${new Date(Number(d.nextFundingTime)).toLocaleTimeString(uiLocale(), { hour: "2-digit", minute: "2-digit" })}`
        : ""

    return `<div class="mkGrid">${[
        mkCard("Precio de marca", fnMoneyFull(d.markPrice, "USD", d.markPrice >= 1 ? 2 : 6), mkSignedSub(d.basisPct, "frente al índice")),
        mkCard("Tasa de financiación", funding === null ? "—" : fnPercentSigned(funding, 4), fundingSub),
        mkCard("Interés abierto", mkMoney(d.openInterestUsd, "USD"), oiToCap === null ? "" : `${fnPercentPlain(oiToCap, 1)} de la capitalización`),
        mkCard("Volumen de futuros (24 h)", mkMoney(d.volume24hUsd, "USD"))
    ].join("")}</div>`
}

// ── Valores tradicionales (acciones, ETF, índices, materias primas) ─────────

function mkTraditionalBlocks(s, cur) {
    const fundCur = s.fundamental_currency_code || cur
    const cap = fnToNumber(s.market_cap_basic)
    const aum = fnToNumber(s.aum)
    const shares = fnToNumber(s.total_shares_outstanding)
    const volume = fnToNumber(s.volume)
    const avgVolume = fnToNumber(s.average_volume_30d_calc)

    const cards = [
        cap !== null ? mkCard("Capitalización de mercado", mkMoney(cap, fundCur)) : "",
        aum !== null ? mkCard("Patrimonio del fondo", mkMoney(aum, fundCur)) : "",
        shares !== null ? mkCard("Acciones en circulación", mkCompact(shares)) : "",
        mkCard("Volumen (último día)", volume === null ? "—" : mkCompact(volume)),
        mkCard("Volumen medio (30 d)", avgVolume === null ? "—" : mkCompact(avgVolume))
    ].join("")

    return mkSectionTitle("Capital y negociación") + `<div class="mkGrid">${cards}</div>`
}

// Dónde cotiza el activo y qué es, tal cual lo clasifica el scanner.
function mkListingCol(s) {
    return `
        <div class="fnDetailCol">
            ${fnDetailColHead("Cotización")}
            ${fnDetailLine("Mercado", escapeHtml(s.exchange || "—"))}
            ${fnDetailLine("Tipo", escapeHtml([s.type, s.subtype].filter(Boolean).join(" · ") || "—"))}
            ${fnDetailLine("Divisa de cotización", escapeHtml(s.currency || "—"))}
            ${fnDetailLine("Sector", escapeHtml(s.sector || "—"))}
            ${fnDetailLine("Industria", escapeHtml(s.industry || "—"))}
            ${fnDetailLine("País", escapeHtml(s.country || "—"))}
        </div>`
}

// ── Tendencia ───────────────────────────────────────────────────────────────

function mkTrendCol(s) {
    const rating = (label, value) => {
        const info = fnRatingInfo(value)
        return fnDetailLine(label, `<span class="fnRatingBadge fnRatingMini ${info.cls}">${info.label}</span>`)
    }
    const rsi = fnToNumber(s.RSI)

    return `
        <div class="fnDetailCol">
            ${fnDetailColHead("Tendencia técnica")}
            ${rating("Valoración global", s["Recommend.All"])}
            ${rating("Medias móviles", s["Recommend.MA"])}
            ${rating("Osciladores", s["Recommend.Other"])}
            ${fnDetailLine("RSI (14)", rsi === null ? "—" : fnRatio(rsi, 1))}
            ${fnDetailLine("Precio vs. media 50", mkVersus(s.close, s.SMA50))}
            ${fnDetailLine("Precio vs. media 200", mkVersus(s.close, s.SMA200))}
        </div>`
}

function mkVersus(close, ma) {
    const price = fnToNumber(close)
    const ref = fnToNumber(ma)
    if (price === null || ref === null || ref === 0) return "—"
    const pct = (price / ref - 1) * 100
    return `<span class="${pct >= 0 ? "fnPos" : "fnNeg"}">${fnPercentSigned(pct, 1)}</span>`
}

// ── Análisis técnico: medidor, indicadores de calidad y popup ───────────────
//
// Todo sale de las columnas que ya trae /api/market/ficha: no hay peticiones
// nuevas. Los medidores usan las valoraciones de TradingView; las señales de
// cada fila (y sus recuentos) son zonas estándar de cada indicador aplicadas
// a esos mismos valores, así que pueden no coincidir al decimal con el
// recuento propio de TradingView, que mira también la dirección del indicador.

const _MK_TEC_COMPRA = "Compra"
const _MK_TEC_VENTA = "Venta"
const _MK_TEC_NEUTRAL = "Neutral"

// Medidor semicircular de -1 (venta fuerte) a 1 (compra fuerte). Los tramos
// coinciden con los cortes de FN_RATING_TIERS para que aguja y etiqueta digan lo mismo.
const _MK_TEC_TRAMOS = [
    [-1, -0.5, "detMkArcStrongSell"],
    [-0.5, -0.1, "detMkArcSell"],
    [-0.1, 0.1, "detMkArcNeutral"],
    [0.1, 0.5, "detMkArcBuy"],
    [0.5, 1, "detMkArcStrongBuy"]
]

let _mkTecActivo = null // { nombre, stats, divisa } del activo cuya ficha se enseña

function mkTecPunto(valor, radio) {
    const angulo = Math.PI * (1 - (valor + 1) / 2)
    return { x: 60 + radio * Math.cos(angulo), y: 58 - radio * Math.sin(angulo) }
}

/**
 * Medidor semicircular de una valoración técnica.
 *
 * @param {number|string|null} valor Valoración de -1 a 1 (`Recommend.*`).
 * @param {string} titulo Texto accesible del medidor.
 * @returns {string} HTML del medidor con su etiqueta, o "Sin datos" si no hay valor.
 */
function mkTecGauge(valor, titulo) {
    const num = fnToNumber(valor)
    if (num === null) return `<div class="detMkGauge"><span class="mkTecSinDatos">Sin datos</span></div>`

    const info = fnRatingInfo(num)
    const hueco = 0.03
    const arcos = _MK_TEC_TRAMOS.map(([desde, hasta, clase]) => {
        const a = mkTecPunto(desde + hueco, 48)
        const b = mkTecPunto(hasta - hueco, 48)
        return `<path class="${clase}" d="M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A 48 48 0 0 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}" />`
    }).join("")
    const punta = mkTecPunto(Math.max(-1, Math.min(1, num)), 34)

    return `
        <div class="detMkGauge">
            <svg class="detMkGaugeSvg" viewBox="0 0 120 66" role="img" aria-label="${escapeHtml(titulo)}: ${escapeHtml(info.label)}">
                ${arcos}
                <line class="detMkNeedle" x1="60" y1="58" x2="${punta.x.toFixed(2)}" y2="${punta.y.toFixed(2)}" />
                <circle class="detMkNeedleHub" cx="60" cy="58" r="3" />
            </svg>
            <div class="detMkGaugeLabel ${info.cls}">${escapeHtml(info.label)}</div>
        </div>`
}

// Señal por zonas: compra por debajo de `bajo`, venta por encima de `alto`.
function mkTecZona(valor, bajo, alto) {
    if (valor === null) return null
    if (valor < bajo) return _MK_TEC_COMPRA
    if (valor > alto) return _MK_TEC_VENTA
    return _MK_TEC_NEUTRAL
}

// Señal por signo: positivo compra, negativo vende.
function mkTecSigno(valor, referencia = 0) {
    if (valor === null || referencia === null) return null
    if (valor > referencia) return _MK_TEC_COMPRA
    if (valor < referencia) return _MK_TEC_VENTA
    return _MK_TEC_NEUTRAL
}

/**
 * Filas de la tabla de osciladores con su señal.
 *
 * @param {object} s Estadísticas del scanner.
 * @returns {Array<{nombre: string, valor: number|null, decimales: number, accion: string|null}>}
 *   `accion` es null cuando el indicador no da señal por sí solo (ADX) o no hay dato.
 */
function mkTecOsciladores(s) {
    const n = (campo) => fnToNumber(s[campo])
    const macd = n("MACD.macd")
    const senal = n("MACD.signal")
    const fila = (nombre, valor, accion, decimales = 2) => ({ nombre, valor, decimales, accion })

    return [
        fila("Índice de fuerza relativa (14)", n("RSI"), mkTecZona(n("RSI"), 30, 70)),
        fila("Estocástico %K (14, 3, 3)", n("Stoch.K"), mkTecZona(n("Stoch.K"), 20, 80)),
        fila("Índice del canal de materias primas (20)", n("CCI20"), mkTecZona(n("CCI20"), -100, 100)),
        fila("Índice direccional medio (14)", n("ADX"), null),
        fila("Oscilador asombroso", n("AO"), mkTecSigno(n("AO"))),
        fila("Momentum (10)", n("Mom"), mkTecSigno(n("Mom"))),
        fila("Nivel MACD (12, 26)", macd, mkTecSigno(macd, senal)),
        fila("RSI estocástico rápido", n("Stoch.RSI.K"), mkTecZona(n("Stoch.RSI.K"), 20, 80)),
        fila("Rango porcentual de Williams (14)", n("W.R"), mkTecZona(n("W.R"), -80, -20)),
        fila("Oscilador último (7, 14, 28)", n("UO"), mkTecZona(n("UO"), 30, 70))
    ]
}

/**
 * Filas de la tabla de medias móviles con su señal frente al precio.
 *
 * @param {object} s Estadísticas del scanner.
 * @returns {Array<{nombre: string, valor: number|null, decimales: null, accion: string|null}>}
 *   Compra si el precio está por encima de la media, venta si está por debajo.
 */
function mkTecMedias(s) {
    const precio = fnToNumber(s.close)
    const fila = (nombre, campo) => {
        const valor = fnToNumber(s[campo])
        return { nombre, valor, decimales: null, accion: precio === null ? null : mkTecSigno(precio, valor) }
    }
    return [
        fila("Media móvil exponencial (20)", "EMA20"),
        fila("Media móvil simple (20)", "SMA20"),
        fila("Media móvil exponencial (50)", "EMA50"),
        fila("Media móvil simple (50)", "SMA50"),
        fila("Media móvil exponencial (100)", "EMA100"),
        fila("Media móvil simple (100)", "SMA100"),
        fila("Media móvil exponencial (200)", "EMA200"),
        fila("Media móvil simple (200)", "SMA200"),
        fila("Media móvil ponderada por volumen (20)", "VWMA"),
        fila("Media móvil de casco (9)", "HullMA9"),
        fila("Línea base de Ichimoku (9, 26, 52, 26)", "Ichimoku.BLine")
    ]
}

/**
 * Cuenta las señales de venta, neutrales y de compra de un conjunto de filas.
 *
 * @param {Array<{accion: string|null}>} filas Filas de `mkTecOsciladores` o `mkTecMedias`.
 * @returns {{venta: number, neutral: number, compra: number}} Las filas sin señal no cuentan.
 */
function mkTecRecuento(filas) {
    const cuenta = { venta: 0, neutral: 0, compra: 0 }
    for (const { accion } of filas) {
        if (accion === _MK_TEC_VENTA) cuenta.venta += 1
        else if (accion === _MK_TEC_NEUTRAL) cuenta.neutral += 1
        else if (accion === _MK_TEC_COMPRA) cuenta.compra += 1
    }
    return cuenta
}

function mkTecSumarRecuentos(a, b) {
    return { venta: a.venta + b.venta, neutral: a.neutral + b.neutral, compra: a.compra + b.compra }
}

function mkTecClaseAccion(accion) {
    if (accion === _MK_TEC_COMPRA) return "fnPos"
    if (accion === _MK_TEC_VENTA) return "fnNeg"
    return "mkTecNeutral"
}

function mkTecRecuentoHtml({ venta, neutral, compra }) {
    return `
        <div class="mkTecRecuento">
            <span><small>Venta</small><b class="fnNeg">${venta}</b></span>
            <span><small>Neutral</small><b>${neutral}</b></span>
            <span><small>Compra</small><b class="fnPos">${compra}</b></span>
        </div>`
}

function mkTecTablaHtml(titulo, filas, divisa) {
    const cuerpo = filas
        .map(({ nombre, valor, decimales, accion }) => {
            const texto = decimales === null ? fnPrice(valor, divisa) : fnRatio(valor, decimales)
            const celdaAccion = accion ? `<span class="${mkTecClaseAccion(accion)}">${accion}</span>` : "—"
            return `<tr><td>${escapeHtml(nombre)}</td><td class="mkTecNum">${texto}</td><td class="mkTecAccion">${celdaAccion}</td></tr>`
        })
        .join("")
    return `
        <div class="mkTecTabla">
            <h4>${titulo}</h4>
            <table>
                <thead><tr><th>Nombre</th><th class="mkTecNum">Valor</th><th class="mkTecAccion">Acción</th></tr></thead>
                <tbody>${cuerpo}</tbody>
            </table>
        </div>`
}

function mkTecModalHtml(nombre, s, divisa) {
    const osciladores = mkTecOsciladores(s)
    const medias = mkTecMedias(s)
    const recuentoOsc = mkTecRecuento(osciladores)
    const recuentoMed = mkTecRecuento(medias)
    const medidor = (titulo, valor, recuento) => `
        <div class="mkTecResumen">
            <h4>${titulo}</h4>
            ${mkTecGauge(valor, titulo)}
            ${mkTecRecuentoHtml(recuento)}
        </div>`

    return `
        <div class="calendarioModal mkTecModal" role="dialog" aria-modal="true" aria-labelledby="mkTecTitulo">
            <div class="calendarioModalHeader">
                <h3 class="assetModalTitle" id="mkTecTitulo">${escapeHtml(nombre)} · Datos técnicos</h3>
                <button type="button" class="calendarioCloseBtn" data-mk-tecnico-cerrar aria-label="Cerrar"><span class="icono iconoCerrar" aria-hidden="true"></span></button>
            </div>
            <div class="calendarioModalBody mkTecCuerpo">
                <div class="mkTecMedidores">
                    ${medidor("Osciladores", s["Recommend.Other"], recuentoOsc)}
                    ${medidor("Resumen", s["Recommend.All"], mkTecSumarRecuentos(recuentoOsc, recuentoMed))}
                    ${medidor("Medias móviles", s["Recommend.MA"], recuentoMed)}
                </div>
                <div class="mkTecTablas">
                    ${mkTecTablaHtml("Osciladores", osciladores, divisa)}
                    ${mkTecTablaHtml("Medias móviles", medias, divisa)}
                </div>
                <p class="mkTecNota">Temporalidad: 1 día. Los medidores son la valoración de TradingView; las señales de cada fila y los recuentos aplican zonas estándar de cada indicador (precio frente a la media, sobrecompra y sobreventa) a esos mismos valores.</p>
            </div>
        </div>`
}

function mkTecAbrir() {
    if (!_mkTecActivo) return
    let overlay = document.getElementById("mkTecOverlay")
    if (!overlay) {
        overlay = document.createElement("div")
        overlay.id = "mkTecOverlay"
        overlay.className = "modalOverlay hidden"
        document.body.appendChild(overlay)
    }
    overlay.innerHTML = mkTecModalHtml(_mkTecActivo.nombre, _mkTecActivo.stats, _mkTecActivo.divisa)
    overlay.classList.remove("hidden")
}

function mkTecCerrar() {
    document.getElementById("mkTecOverlay")?.classList.add("hidden")
}

document.addEventListener("click", (event) => {
    const objetivo = event.target
    if (objetivo.closest?.("[data-mk-tecnico]")) mkTecAbrir()
    else if (objetivo.closest?.("[data-mk-tecnico-cerrar]") || objetivo.id === "mkTecOverlay") mkTecCerrar()
})

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") mkTecCerrar()
})

// ── Piezas y formato ────────────────────────────────────────────────────────

function mkSectionTitle(text) {
    return `<h3 class="mkSectionTitle">${text}</h3>`
}

function mkCard(label, value, sub = "") {
    return `<div class="mkCard"><span class="mkCardLabel">${label}</span><span class="mkCardValue">${value}</span>${sub ? `<span class="mkCardSub">${sub}</span>` : ""}</div>`
}

function mkSignedSub(value, suffix = "") {
    const num = fnToNumber(value)
    if (num === null) return ""
    const cls = num > 0 ? "fnPos" : num < 0 ? "fnNeg" : ""
    return `<span class="${cls}">${fnPercentSigned(num, 2)}</span>${suffix ? ` ${suffix}` : ""}`
}

function mkCompact(value) {
    const abs = Math.abs(value)
    const tier = _MK_SCALE.find((t) => abs >= t.from)
    const number = tier ? value / tier.divisor : value
    const decimals = tier ? 2 : abs >= 100 ? 0 : 2
    return number.toLocaleString(_nl(), { minimumFractionDigits: 0, maximumFractionDigits: decimals }) + (tier ? tier.suffix : "")
}

function mkMoney(value, currency) {
    if (value === null || value === undefined) return "—"
    return `${mkCompact(value)} ${currencySuffix(currency)}`
}

function mkSupply(value, symbol) {
    if (value === null || value === undefined) return "—"
    return `${mkCompact(value)} ${symbol}`
}

// Un solo manejador para "Reintentar": la sección se repinta entera.
document.addEventListener("click", (event) => {
    if (!event.target.closest("[data-mk-retry]")) return
    if (_assetMercadoAsset && typeof buildTVSymbol === "function") {
        _mkCache.delete(String(buildTVSymbol(_assetMercadoAsset) || "").toUpperCase())
    }
    renderAssetMercadoSection()
})
