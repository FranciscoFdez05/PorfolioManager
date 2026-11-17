/**
 * Textos de la interfaz en inglés.
 *
 * Debe tener exactamente las mismas claves que es.js (lo comprueba
 * tests-js/i18n.test.js). Los términos de la fiscalidad española (IRPF,
 * modelo 720...) se dejan en español cuando aparezcan: traducirlos haría creer
 * que el cálculo vale para otros países.
 */
window.i18nDiccionarios = window.i18nDiccionarios || {}
window.i18nDiccionarios.en = {
    comun: {
        guardado: "Saved",
        error: "Error",
        errorRed: "Network error",
        centrarGrafico: "Reset view"
    },
    portfolio: {
        nuevo: "New portfolio",
        importar: "↑ Import portfolio"
    },
    metricasSuperiores: {
        totalCuenta: "Account total",
        porcentajeCuenta: "% account",
        rendimientoEuros: "Return €",
        invertido: "Invested",
        numActivos: "No. of assets",
        porcentajeAcciones: "% stocks",
        eurosAcciones: "€ stocks",
        porcentajeComoditis: "% commodities",
        eurosComoditis: "€ commodities",
        porcentajeCripto: "% crypto",
        eurosCripto: "€ crypto",
        dividendos: "€ dividends",
        cuentaRemunerada: "€ Int. acc.",
        rentaFija: "€ Fixed income",
        mercadoPrivado: "Private market",
        gastosAnio: "Expenses (year)",
        ingresosAnio: "Income (year)"
    },
    menu: {
        vistaGeneral: "Overview",
        activos: "Assets",
        mapas: "Heatmaps",
        fundamentales: "Fundamentals",
        sentimiento: "Sentiment",
        paneles: "Dashboards",
        bolsaInversion: "Investing",
        operaciones: "Trades",
        cuentaRemunerada: "Interest Account",
        dividendos: "Dividends",
        rentaFija: "Fixed Income",
        ventas: "Sales",
        mercadoPrivado: "Private Market",
        cripto: "Crypto",
        conversiones: "Conversions",
        transacciones: "Transactions",
        seguimiento: "Tracking",
        planificacion: "Planning",
        planes: "Plans",
        alertas: "Alerts",
        ultimosAvisos: "Recent alerts",
        herramientas: "Tools",
        metricas: "Metrics",
        ocultarValores: "Hide values",
        mostrarValores: "Show values",
        miDinero: "My money",
        patrimonio: "Net worth",
        gastos: "Expenses",
        ingresos: "Income",
        calendario: "Calendar",
        mensualidades: "Monthly payments",
        ingresosRecurrentes: "Recurring income",
        pagosFraccionados: "Instalments",
        misFinanzas: "My finances",
        banco: "Bank",
        ahorro: "Savings",
        cuentas: "Accounts",
        movimientos: "Account activity",
        cuentaRemuneradaBanco: "Interest account",
        deudas: "Debts",
        hipotecas: "Mortgages",
        microcreditos: "Microloans",
        comprasFinanciadas: "Financed purchases",
        cuentaAhorro: "Savings account",
        ajustes: "Settings",
        version: "PorfolioManager version"
    },
    panelLateral: {
        modoActivo: "Asset",
        modoActivoAyuda: "Clicking an asset opens its details",
        modoGrafico: "Chart",
        modoGraficoAyuda: "Clicking an asset opens its chart",
        elegirLista: "Choose which assets are shown",
        columnaActivo: "Asset",
        columnaPrecio: "Price",
        columnaVariacion: "Chg.",
        tipo: "Type",
        posicion: "Position",
        invertidoBruto: "Gross invested",
        pylComisiones: "P/L incl. fees",
        precioMedio: "Average price",
        comisiones: "Fees",
        variacionHoy: "Chg. today",
        pesoCartera: "Portfolio weight",
        rendimiento: "Performance",
        estacionales: "Seasonality",
        tabla: "Table",
        tablaAyuda: "Monthly return by year",
        ampliarEstacionales: "Expand seasonality",
        datosTecnicos: "Technicals",
        estadisticasClave: "Key statistics"
    },
    ajustes: {
        titulo: "Settings",
        cerrar: "Close settings",
        nav: {
            apariencia: "Appearance",
            cuenta: "Account",
            seguridad: "Security",
            portfolio: "Portfolio",
            automatizacion: "Automation",
            conexiones: "Connections",
            avisos: "Notifications",
            datos: "Data",
            modulos: "Modules",
            registro: "Log"
        },
        paleta: {
            titulo: "Colour palette",
            descripcion: "Choose the visual theme of the app.",
            nocheClara: "Soft Night",
            oscuro: "Dark",
            claro: "Light"
        },
        densidad: {
            titulo: "Sidebar density",
            descripcion: "Makes assets smaller in the sidebar so more fit on screen.",
            compacto: "Compact"
        },
        rotacion: {
            titulo: "Asset detail rotation",
            descripcion:
                "Automatically changes the asset shown in the sidebar detail panel. Pauses while the mouse is over the sidebar.",
            activar: "Enable automatic rotation",
            activarAyuda: "Loops through the assets visible in the sidebar"
        },
        privacidad: {
            titulo: "Privacy on start",
            descripcion: "Automatically hides monetary values every time you open the app.",
            ocultar: "Hide values on start",
            ocultarAyudaAntes: "Same as pressing the",
            ocultarAyudaDespues: "button when opening the app"
        },
        idioma: {
            titulo: "Language",
            descripcion: "Interface language. Numbers and dates follow their own format settings."
        },
        numeros: {
            titulo: "Number format",
            descripcion: "Decimal and thousands separators for every value shown in the app."
        },
        fecha: {
            titulo: "Date format",
            descripcion: "Order in which day, month and year are shown.",
            ddmmaaaa: "DD/MM/YYYY",
            mmddaaaa: "MM/DD/YYYY",
            aaaammdd: "YYYY-MM-DD"
        }
    }
}
