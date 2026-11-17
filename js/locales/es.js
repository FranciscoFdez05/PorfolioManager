/**
 * Textos de la interfaz en español.
 *
 * Es el idioma de referencia y el de respaldo: toda clave que exista en otro
 * idioma tiene que existir aquí (lo comprueba tests-js/i18n.test.js), y los
 * textos de los elementos con data-i18n de index.html deben coincidir con los
 * de este fichero para que la interfaz no cambie al aplicar la traducción.
 *
 * Las entradas con formas plurales son objetos con las categorías de
 * Intl.PluralRules ("one", "other") y se piden con t(clave, { count }).
 */
window.i18nDiccionarios = window.i18nDiccionarios || {}
window.i18nDiccionarios.es = {
    comun: {
        guardado: "Guardado",
        error: "Error",
        errorRed: "Error de red"
    },
    portfolio: {
        nuevo: "Nuevo portfolio",
        importar: "↑ Importar portfolio"
    },
    metricasSuperiores: {
        totalCuenta: "Total Cuenta",
        porcentajeCuenta: "% cuenta",
        rendimientoEuros: "Rendimiento €",
        invertido: "Invertido",
        numActivos: "Nº activos",
        porcentajeAcciones: "% acciones",
        eurosAcciones: "€ acciones",
        porcentajeComoditis: "% comoditis",
        eurosComoditis: "€ comoditis",
        porcentajeCripto: "% cripto",
        eurosCripto: "€ cripto",
        dividendos: "€ dividendos",
        cuentaRemunerada: "€ C. Rem.",
        rentaFija: "€ Renta Fija",
        mercadoPrivado: "Mercado Privado",
        gastosAnio: "Gastos (año)",
        ingresosAnio: "Ingresos (año)"
    },
    menu: {
        vistaGeneral: "Vista general",
        activos: "Activos",
        mapas: "Mapas",
        fundamentales: "Fundamentales",
        sentimiento: "Sentimiento",
        paneles: "Paneles",
        bolsaInversion: "Bolsa e Inversión",
        operaciones: "Operaciones",
        cuentaRemunerada: "Cuenta Remunerada",
        dividendos: "Dividendos",
        rentaFija: "Renta Fija",
        ventas: "Ventas",
        mercadoPrivado: "Mercado Privado",
        cripto: "Cripto",
        conversiones: "Conversiones",
        transacciones: "Transacciones",
        seguimiento: "Seguimiento",
        planificacion: "Planificación",
        planes: "Planes",
        alertas: "Alertas",
        ultimosAvisos: "Últimos avisos",
        herramientas: "Herramientas",
        metricas: "Métricas",
        ocultarValores: "Ocultar valores",
        mostrarValores: "Mostrar valores",
        miDinero: "Mi dinero",
        patrimonio: "Patrimonio",
        gastos: "Gastos",
        ingresos: "Ingresos",
        calendario: "Calendario",
        mensualidades: "Mensualidades",
        ingresosRecurrentes: "Ingresos recurrentes",
        pagosFraccionados: "Pagos fraccionados",
        misFinanzas: "Mis finanzas",
        banco: "Banco",
        ahorro: "Ahorro",
        cuentas: "Cuentas",
        movimientos: "Movimientos",
        cuentaRemuneradaBanco: "Cuenta remunerada",
        deudas: "Deudas",
        hipotecas: "Hipotecas",
        microcreditos: "Microcréditos",
        comprasFinanciadas: "Compras financiadas",
        cuentaAhorro: "Cuenta de ahorro",
        ajustes: "Ajustes",
        version: "Versión de PorfolioManager"
    },
    panelLateral: {
        modoActivo: "Activo",
        modoActivoAyuda: "Pulsar un activo abre su ficha",
        modoGrafico: "Gráfico",
        modoGraficoAyuda: "Pulsar un activo abre su gráfico",
        elegirLista: "Elegir qué activos se muestran",
        columnaActivo: "Activo",
        columnaPrecio: "Precio",
        columnaVariacion: "Var.",
        tipo: "Tipo",
        posicion: "Posición",
        invertidoBruto: "Invertido bruto",
        pylComisiones: "P/L con comisiones",
        precioMedio: "Precio medio",
        comisiones: "Comisiones",
        variacionHoy: "Var. hoy",
        pesoCartera: "Peso cartera",
        rendimiento: "Rendimiento",
        estacionales: "Estacionales",
        tabla: "Tabla",
        tablaAyuda: "Rendimiento mensual por años",
        ampliarEstacionales: "Ampliar estacionales",
        datosTecnicos: "Datos técnicos",
        estadisticasClave: "Estadísticas clave"
    },
    ajustes: {
        titulo: "Ajustes",
        cerrar: "Cerrar ajustes",
        nav: {
            apariencia: "Apariencia",
            cuenta: "Cuenta",
            seguridad: "Seguridad",
            portfolio: "Portfolio",
            automatizacion: "Automatización",
            conexiones: "Conexiones",
            avisos: "Avisos",
            datos: "Datos",
            modulos: "Módulos",
            registro: "Registro"
        },
        paleta: {
            titulo: "Paleta de color",
            descripcion: "Elige el tema visual de la aplicación.",
            nocheClara: "Noche Clara",
            oscuro: "Oscuro",
            claro: "Claro"
        },
        densidad: {
            titulo: "Densidad del sidebar",
            descripcion: "Reduce el tamaño de los activos en la barra lateral para mostrar más en pantalla.",
            compacto: "Compacto"
        },
        rotacion: {
            titulo: "Rotación del detalle de activo",
            descripcion:
                "Cambia automáticamente el activo mostrado en el panel de detalle del sidebar. Se pausa al pasar el ratón por el sidebar.",
            activar: "Activar rotación automática",
            activarAyuda: "Recorre en bucle los activos visibles del sidebar"
        },
        privacidad: {
            titulo: "Privacidad al inicio",
            descripcion: "Oculta automáticamente los valores monetarios cada vez que abres la aplicación.",
            ocultar: "Ocultar valores al iniciar",
            ocultarAyudaAntes: "Equivale a pulsar el botón",
            ocultarAyudaDespues: "al abrir la app"
        },
        idioma: {
            titulo: "Idioma",
            descripcion: "Idioma de la interfaz. Los números y las fechas siguen sus propios ajustes de formato."
        },
        numeros: {
            titulo: "Formato de números",
            descripcion: "Separador decimal y de miles para todos los valores mostrados en la aplicación."
        },
        fecha: {
            titulo: "Formato de fecha",
            descripcion: "Orden en que se muestran día, mes y año.",
            ddmmaaaa: "DD/MM/AAAA",
            mmddaaaa: "MM/DD/AAAA",
            aaaammdd: "AAAA-MM-DD"
        }
    }
}
