// Calendario del dinero: gastos, ingresos y mensualidades del año, día a día.
//
// No guarda nada. Lee el año de gastos y el de ingresos —los mismos JSON que
// pintan sus pantallas— y coloca cada apunte en el día de su fecha. Los cargos
// de las mensualidades y las ganancias recurrentes se calculan con la misma
// aritmética que usan sus tablas (getMensualidadCargos, normalizeRecurrente),
// así que aquí no hay una segunda versión de "qué día se cobra".
//
// Los chips de arriba eligen qué se ve. Son excluyentes con "Todo" y
// acumulables entre sí, igual que los filtros de tipo de Activos.

const CAL_FIN_TIPOS = [
    { key: "gastos", label: "Gastos", sign: -1 },
    { key: "ingresos", label: "Ingresos", sign: 1 },
    { key: "mensualidades", label: "Mensualidades", sign: -1 }
]

let calFinYears = []
let calFinYear = null
let calFinGastosData = null
let calFinIngresosData = null
// Tipos que se muestran. Con los tres dentro, el chip "Todo" es el activo.
let calFinTipos = new Set(CAL_FIN_TIPOS.map((tipo) => tipo.key))
// Día elegido ("mes-día"), que es lo que detalla el panel lateral.
let calFinSelection = null

function getCalFinTipo(key) {
    return CAL_FIN_TIPOS.find((tipo) => tipo.key === key) || CAL_FIN_TIPOS[0]
}

function calFinTodosActivos() {
    return CAL_FIN_TIPOS.every((tipo) => calFinTipos.has(tipo.key))
}

// La API responde 404 a un año que no existe en ese módulo: se puede tener
// 2025 en ingresos y no en gastos. Aquí eso es "sin datos", no un error.
async function calFinLoadYear(module, year) {
    try {
        return await Api.get(`/api/${module}/${encodeURIComponent(year)}`)
    } catch (error) {
        if (error?.status === 404) {
            return null
        }
        throw error
    }
}

async function calFinLoadYears(module) {
    try {
        const data = await Api.get(`/api/${module}`)
        return Array.isArray(data?.years) ? data.years : []
    } catch (error) {
        console.error(`No se pudo cargar la lista de años de ${module}:`, error)
        return []
    }
}

async function initCalendarioLogic() {
    const [gastosYears, ingresosYears] = await Promise.all([calFinLoadYears("gastos"), calFinLoadYears("ingresos")])
    const years = [...new Set([...gastosYears, ...ingresosYears].map(String))].sort()
    const currentYear = String(new Date().getFullYear())

    calFinYears = years.length ? years : [currentYear]
    calFinYear = calFinYears.includes(currentYear) ? currentYear : calFinYears[calFinYears.length - 1]
    calFinTipos = new Set(CAL_FIN_TIPOS.map((tipo) => tipo.key))
    calFinSelection = null

    bindCalFinEvents()
    await renderCalFinYear(calFinYear)
}

async function renderCalFinYear(year) {
    calFinYear = String(year)
    calFinSelection = null
    ;[calFinGastosData, calFinIngresosData] = await Promise.all([
        calFinLoadYear("gastos", calFinYear),
        calFinLoadYear("ingresos", calFinYear)
    ])
    renderCalFinYearButtons()
    renderCalFin()
}

function renderCalFinYearButtons() {
    const list = document.getElementById("calFinYearList")
    if (!list) {
        return
    }

    list.innerHTML = calFinYears
        .map(
            (year) =>
                `<button type="button" class="calFinYearBtn${year === calFinYear ? " active" : ""}" data-cal-year="${escapeGastosHtml(year)}">${escapeGastosHtml(year)}</button>`
        )
        .join("")
}

function renderCalFinChips() {
    const todos = calFinTodosActivos()
    document.querySelectorAll("#calFinFilters .calFinChip").forEach((chip) => {
        const key = chip.dataset.calType
        chip.classList.toggle("active", key === "all" ? todos : !todos && calFinTipos.has(key))
    })
}

function bindCalFinEvents() {
    const yearList = document.getElementById("calFinYearList")
    if (yearList && !yearList.dataset.bound) {
        yearList.dataset.bound = "true"
        yearList.addEventListener("click", (event) => {
            const button = event.target.closest("[data-cal-year]")
            if (button && button.dataset.calYear !== calFinYear) {
                renderCalFinYear(button.dataset.calYear)
            }
        })
    }

    const filters = document.getElementById("calFinFilters")
    if (filters && !filters.dataset.bound) {
        filters.dataset.bound = "true"
        filters.addEventListener("click", (event) => {
            const chip = event.target.closest("[data-cal-type]")
            if (!chip) {
                return
            }

            const key = chip.dataset.calType
            if (key === "all") {
                calFinTipos = new Set(CAL_FIN_TIPOS.map((tipo) => tipo.key))
            } else if (calFinTodosActivos()) {
                // Desde "Todo", pulsar un tipo lo deja solo.
                calFinTipos = new Set([key])
            } else if (calFinTipos.has(key)) {
                calFinTipos.delete(key)
                // Sin ningún tipo no hay nada que ver: se vuelve a "Todo".
                if (!calFinTipos.size) {
                    calFinTipos = new Set(CAL_FIN_TIPOS.map((tipo) => tipo.key))
                }
            } else {
                calFinTipos.add(key)
            }

            calFinSelection = null
            renderCalFin()
        })
    }

    const calendar = document.getElementById("calFinCalendar")
    if (calendar && !calendar.dataset.bound) {
        calendar.dataset.bound = "true"
        calendar.addEventListener("click", (event) => {
            const day = event.target.closest("[data-cal-day]")
            if (!day) {
                return
            }

            // Pulsar el día elegido lo suelta y el panel vuelve al resumen del año.
            calFinSelection = calFinSelection === day.dataset.calDay ? null : day.dataset.calDay
            renderCalFinCalendar()
        })
    }
}

// ── Apuntes del año ─────────────────────────────────────────────────────────

// DD-MM-AAAA, como se escriben en las tablas de movimientos. Devuelve null si
// no es una fecha completa y real.
function calFinParseFecha(value) {
    const parts = String(value || "")
        .trim()
        .split("-")
    if (parts.length !== 3) {
        return null
    }

    const [day, month, year] = parts.map((part) => parseInt(part, 10))
    if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) {
        return null
    }

    if (month < 1 || month > 12 || day < 1 || day > new Date(year, month, 0).getDate()) {
        return null
    }

    return { day, monthIndex: month - 1, year }
}

// Un movimiento vive en el mes en que se apuntó, pero el día sale de su fecha.
// Una fecha de otro mes manda sobre el cajón (es lo que se escribió); una de
// otro año o incompleta deja el apunte en su mes "sin día".
function calFinMovimientoApunte(row, monthIndex, tipoKey, yearNumber) {
    const amount = parseEuroNumber(row?.cantidad || "")
    if (!amount) {
        return null
    }

    const fecha = calFinParseFecha(row.fecha)
    const enElAno = Boolean(fecha) && fecha.year === yearNumber
    const mes = enElAno ? fecha.monthIndex : monthIndex

    return {
        tipo: tipoKey,
        nombre: String(row.nombre || "").trim() || "Sin nombre",
        detalle: String(row.tipo || "").trim(),
        monthIndex: mes,
        sinDia: !enElAno,
        date: new Date(yearNumber, mes, enElAno ? fecha.day : 1),
        amount: Math.abs(amount),
        activa: true
    }
}

function calFinMovimientosApuntes(data, tipoKey, yearNumber) {
    const apuntes = []
    GASTOS_MONTHS.forEach((month, monthIndex) => {
        ;(data?.months?.[month.key]?.rows || []).forEach((row) => {
            const apunte = calFinMovimientoApunte(row, monthIndex, tipoKey, yearNumber)
            if (apunte) {
                apuntes.push(apunte)
            }
        })
    })
    return apuntes
}

// Una ganancia recurrente se cobra su día en cada mes con importe. Sin día
// definido se lista aparte, como los cargos sin día de las mensualidades.
function calFinRecurrentesApuntes(data, yearNumber) {
    const apuntes = []
    ;(data?.recurrentes || []).map(normalizeRecurrente).forEach((row) => {
        const dia = Number(row.diaCobro || 0)
        GASTOS_MONTHS.forEach((month, monthIndex) => {
            const amount = parseEuroNumber(row.meses?.[month.key] || "")
            if (!amount) {
                return
            }

            apuntes.push({
                tipo: "ingresos",
                nombre: row.nombre || "Sin nombre",
                detalle: row.categoria ? `${row.categoria} · recurrente` : "recurrente",
                monthIndex,
                sinDia: !dia,
                date: buildMensualidadDate(yearNumber, monthIndex, dia || 1),
                amount: Math.abs(amount),
                activa: row.activa
            })
        })
    })
    return apuntes
}

function calFinMensualidadesApuntes(data, yearNumber) {
    const apuntes = []
    ;(data?.mensualidades || []).map(normalizeMensualidad).forEach((row) => {
        getMensualidadCargos(row, yearNumber).forEach((cargo) => {
            apuntes.push({
                tipo: "mensualidades",
                nombre: row.nombre || "Sin nombre",
                detalle: getMensualidadFrecuencia(row.frecuencia).short,
                monthIndex: cargo.index,
                sinDia: cargo.sinDia,
                date: cargo.date,
                amount: Math.abs(cargo.amount),
                activa: row.activa
            })
        })
    })
    return apuntes
}

// Todos los apuntes del año de los tipos elegidos, ordenados por fecha. Es la
// lista que se pinta y de la que salen los totales del panel lateral.
function getCalFinApuntes() {
    const yearNumber = Number(calFinYear)
    if (!Number.isInteger(yearNumber)) {
        return []
    }

    const apuntes = []
    if (calFinTipos.has("gastos")) {
        apuntes.push(...calFinMovimientosApuntes(calFinGastosData, "gastos", yearNumber))
    }
    if (calFinTipos.has("ingresos")) {
        apuntes.push(...calFinMovimientosApuntes(calFinIngresosData, "ingresos", yearNumber))
        apuntes.push(...calFinRecurrentesApuntes(calFinIngresosData, yearNumber))
    }
    if (calFinTipos.has("mensualidades")) {
        apuntes.push(...calFinMensualidadesApuntes(calFinGastosData, yearNumber))
    }

    return apuntes.sort((a, b) => a.date - b.date || a.nombre.localeCompare(b.nombre))
}

// Suma por tipo de una lista de apuntes, en el orden de CAL_FIN_TIPOS.
function calFinTotalesPorTipo(apuntes) {
    return CAL_FIN_TIPOS.map((tipo) => {
        const delTipo = apuntes.filter((apunte) => apunte.tipo === tipo.key)
        return {
            ...tipo,
            count: delTipo.length,
            total: delTipo.reduce((sum, apunte) => sum + apunte.amount, 0)
        }
    })
}

// Lo que queda: ingresos menos gastos menos mensualidades.
function calFinBalance(apuntes) {
    return apuntes.reduce((sum, apunte) => sum + getCalFinTipo(apunte.tipo).sign * apunte.amount, 0)
}

function calFinDayKey(monthIndex, day) {
    return `${monthIndex}-${day}`
}

// Importe para una celda del calendario: sin el símbolo y sin céntimos a
// partir de 100, que es lo que cabe en 40 píxeles sin recortar. El importe
// completo va en el título de la celda y en el panel lateral.
function formatCalFinCompact(value) {
    return new Intl.NumberFormat(_nl(), {
        minimumFractionDigits: 0,
        maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2
    }).format(value)
}

function formatCalFinSigned(value) {
    const abs = formatEuro(Math.abs(value))
    if (value > 0) {
        return `+${abs}`
    }
    return value < 0 ? `−${abs}` : abs
}

// ── Pintado ─────────────────────────────────────────────────────────────────

function renderCalFin() {
    renderCalFinChips()
    renderCalFinSummary()
    renderCalFinCalendar()
}

// Las cuatro tarjetas cuentan el año entero, se filtre lo que se filtre: son
// el marco en el que leer el calendario, no otra vista de lo filtrado.
function renderCalFinSummary() {
    const container = document.getElementById("calFinSummary")
    if (!container) {
        return
    }

    const yearNumber = Number(calFinYear)
    const gastos = calFinMovimientosApuntes(calFinGastosData, "gastos", yearNumber)
    const ingresos = [
        ...calFinMovimientosApuntes(calFinIngresosData, "ingresos", yearNumber),
        ...calFinRecurrentesApuntes(calFinIngresosData, yearNumber)
    ]
    const mensualidades = calFinMensualidadesApuntes(calFinGastosData, yearNumber)
    const suma = (lista) => lista.reduce((sum, apunte) => sum + apunte.amount, 0)
    const cuenta = (lista) => `${lista.length} ${lista.length === 1 ? "apunte" : "apuntes"}`

    const totalIngresos = suma(ingresos)
    const totalGastos = suma(gastos)
    const totalMens = suma(mensualidades)
    const balance = totalIngresos - totalGastos - totalMens

    const cards = [
        { key: "ingresos", label: "Ingresos", value: formatEuro(totalIngresos), hint: cuenta(ingresos) },
        { key: "gastos", label: "Gastos", value: formatEuro(totalGastos), hint: cuenta(gastos) },
        {
            key: "mensualidades",
            label: "Mensualidades",
            value: formatEuro(totalMens),
            hint: `${cuenta(mensualidades)} · ${formatEuro(totalMens / 12)} al mes`
        },
        {
            key: balance >= 0 ? "positivo" : "negativo",
            label: "Balance",
            value: formatCalFinSigned(balance),
            hint: balance >= 0 ? "Lo que queda del año" : "Sale más de lo que entra"
        }
    ]

    container.innerHTML = cards
        .map(
            (card) => `
        <article class="calFinCard calFinCard-${card.key}">
            <p class="calFinCardLabel">${escapeGastosHtml(card.label)}</p>
            <p class="calFinCardValue">${escapeGastosHtml(card.value)}</p>
            <p class="calFinCardHint">${escapeGastosHtml(card.hint)}</p>
        </article>
    `
        )
        .join("")
}

function buildCalFinMonth(monthIndex, apuntesDelMes, today, yearNumber) {
    const month = GASTOS_MONTHS[monthIndex]
    const conDia = apuntesDelMes.filter((apunte) => !apunte.sinDia)
    const sinDia = apuntesDelMes.filter((apunte) => apunte.sinDia)

    const porDia = new Map()
    conDia.forEach((apunte) => {
        const day = apunte.date.getDate()
        porDia.set(day, [...(porDia.get(day) || []), apunte])
    })

    const diasDelMes = new Date(yearNumber, monthIndex + 1, 0).getDate()
    // getDay() cuenta desde el domingo; aquí la semana empieza en lunes.
    const hueco = (new Date(yearNumber, monthIndex, 1).getDay() + 6) % 7

    const celdas = Array.from({ length: hueco }, () => '<span class="calFinDay calFinDayBlank"></span>')

    for (let day = 1; day <= diasDelMes; day += 1) {
        const delDia = porDia.get(day) || []
        const fecha = new Date(yearNumber, monthIndex, day)
        const classes = ["calFinDay"]

        if (fecha.getTime() === today.getTime()) {
            classes.push("calFinDayToday")
        }

        if (!delDia.length) {
            celdas.push(
                `<span class="${classes.join(" ")} calFinDayEmpty"><span class="calFinDayNum">${day}</span></span>`
            )
            continue
        }

        const key = calFinDayKey(monthIndex, day)
        const totales = calFinTotalesPorTipo(delDia).filter((tipo) => tipo.count)
        classes.push("calFinDayFilled")
        // Lo que aún no ha llegado son cargos previstos, no dinero movido.
        classes.push(fecha <= today ? "calFinDayPast" : "calFinDayNext")
        if (calFinSelection === key) {
            classes.push("calFinDaySelected")
        }

        const detalle = delDia.map((apunte) => `${apunte.nombre}: ${formatEuro(apunte.amount)}`).join(" · ")

        celdas.push(`
            <button type="button" class="${classes.join(" ")}" data-cal-day="${key}"
                    title="${escapeGastosHtml(`${day} de ${month.label.toLowerCase()} · ${detalle}`)}">
                <span class="calFinDayNum">${day}</span>
                ${totales
                    .map(
                        (tipo) =>
                            `<span class="calFinDayAmount calFinTipo-${tipo.key}">${formatCalFinCompact(tipo.total)}</span>`
                    )
                    .join("")}
                ${delDia.length > 1 ? `<span class="calFinDayCount">${delDia.length}</span>` : ""}
            </button>
        `)
    }

    const totalesMes = calFinTotalesPorTipo(apuntesDelMes).filter((tipo) => tipo.count)

    return `
        <article class="calFinMonth${apuntesDelMes.length ? "" : " calFinMonthEmpty"}">
            <header class="calFinMonthHead">
                <span class="calFinMonthName">${month.label}</span>
                <span class="calFinMonthTotals">${
                    totalesMes.length
                        ? totalesMes
                              .map(
                                  (tipo) =>
                                      `<span class="calFinMonthTotal calFinTipo-${tipo.key}" title="${tipo.label}">${formatEuro(tipo.total)}</span>`
                              )
                              .join("")
                        : "—"
                }</span>
            </header>
            <div class="calFinWeekdays">${MENS_CAL_WEEKDAYS.map((d) => `<span>${d}</span>`).join("")}</div>
            <div class="calFinDays">${celdas.join("")}</div>
            ${
                sinDia.length
                    ? `<p class="calFinNoDay">Sin día: ${escapeGastosHtml(sinDia.map((apunte) => apunte.nombre).join(", "))}</p>`
                    : ""
            }
        </article>
    `
}

function buildCalFinSideList(apuntes) {
    return `
        <ul class="calFinSideList">
            ${apuntes
                .map(
                    (apunte) => `
                <li class="calFinSideItem${apunte.activa ? "" : " calFinSideItemPaused"}">
                    <span class="calFinSideDot calFinTipo-${apunte.tipo}" aria-hidden="true"></span>
                    <span class="calFinSideName" title="${escapeGastosHtml(apunte.detalle)}">${escapeGastosHtml(apunte.nombre)}</span>
                    <span class="calFinSideAmount calFinTipo-${apunte.tipo}">${formatEuro(apunte.amount)}</span>
                </li>
            `
                )
                .join("")}
        </ul>
    `
}

// Totales por tipo de lo que se está viendo y, si hay más de uno, el balance.
function buildCalFinTotales(apuntes) {
    const totales = calFinTotalesPorTipo(apuntes).filter((tipo) => calFinTipos.has(tipo.key))
    const balance = calFinBalance(apuntes)

    return `
        ${totales
            .map(
                (tipo) =>
                    `<p class="calFinSideTotal"><span><span class="calFinSideDot calFinTipo-${tipo.key}" aria-hidden="true"></span>${tipo.label}</span><span>${formatEuro(tipo.total)}</span></p>`
            )
            .join("")}
        ${
            totales.length > 1
                ? `<p class="calFinSideTotal calFinSideBalance ${balance >= 0 ? "calFinPositivo" : "calFinNegativo"}"><span>Balance</span><span>${formatCalFinSigned(balance)}</span></p>`
                : ""
        }
    `
}

function buildCalFinDetalle(apuntes, today) {
    if (calFinSelection) {
        const [monthIndex, day] = calFinSelection.split("-").map(Number)
        const delDia = apuntes.filter(
            (apunte) => !apunte.sinDia && apunte.monthIndex === monthIndex && apunte.date.getDate() === day
        )

        if (delDia.length) {
            const fecha = delDia[0].date
            return `
                <p class="calFinSideLabel">${fecha <= today ? "Movido" : "Previsto"}</p>
                <p class="calFinSideTitle">${day} de ${GASTOS_MONTHS[monthIndex].label.toLowerCase()}</p>
                ${buildCalFinSideList(delDia)}
                ${buildCalFinTotales(delDia)}
            `
        }
    }

    // Sin día elegido, el panel cuenta el año de lo que se está viendo.
    const pendientes = apuntes.filter((apunte) => apunte.tipo === "mensualidades" && apunte.date > today)

    return `
        <p class="calFinSideLabel">Resumen de ${escapeGastosHtml(calFinYear)}</p>
        <p class="calFinSideTitle">${apuntes.length} ${apuntes.length === 1 ? "apunte" : "apuntes"}</p>
        ${buildCalFinTotales(apuntes)}
        ${
            pendientes.length
                ? `<p class="calFinSideLabel calFinSideLabelSpaced">Próximos cargos</p>
                   <ul class="calFinSideList">
                        ${pendientes
                            .slice(0, 6)
                            .map(
                                (apunte) => `
                            <li class="calFinSideItem">
                                <span class="calFinSideDot calFinTipo-mensualidades" aria-hidden="true"></span>
                                <span class="calFinSideName">${escapeGastosHtml(apunte.nombre)}</span>
                                <span class="calFinSideDate">${apunte.sinDia ? GASTOS_MONTHS[apunte.monthIndex].label.toLowerCase() : formatMensualidadDate(apunte.date)}</span>
                                <span class="calFinSideAmount">${formatEuro(apunte.amount)}</span>
                            </li>
                        `
                            )
                            .join("")}
                   </ul>`
                : ""
        }
        <p class="calFinSideHint">Pulsa un día para ver qué entró y qué salió.</p>
    `
}

function renderCalFinCalendar() {
    const container = document.getElementById("calFinCalendar")
    if (!container) {
        return
    }

    const yearNumber = Number(calFinYear)
    const apuntes = getCalFinApuntes()

    if (!apuntes.length) {
        const hayDatos = calFinGastosData || calFinIngresosData
        container.innerHTML = `<p class="calFinEmpty">${
            hayDatos
                ? "No hay apuntes de este tipo en el año."
                : `No hay gastos ni ingresos apuntados en ${escapeGastosHtml(calFinYear)}.`
        }</p>`
        return
    }

    const today = getGastosToday()
    const porMes = GASTOS_MONTHS.map((month, index) => apuntes.filter((apunte) => apunte.monthIndex === index))

    container.innerHTML = `
        <div class="calFinGrid">
            ${GASTOS_MONTHS.map((month, index) => buildCalFinMonth(index, porMes[index], today, yearNumber)).join("")}
        </div>
        <aside class="calFinSide">${buildCalFinDetalle(apuntes, today)}</aside>
    `
}
