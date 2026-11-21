// Análisis > Herramientas: analizador de las fórmulas de las herramientas propias.
//
// Trozo de js/analisis/herramientas.js. Comparte con el resto de herramientas-*.js el
// ámbito global y se carga detrás de herramientas.js, en el orden de index.html.
//
// Las herramientas que el usuario crea desde la página calculan cada resultado
// con una fórmula escrita a mano («gasto / (tasa / 100)»). No se pasa a eval ni
// a new Function: la CSP de la página no lo permite y, aunque lo hiciera, una
// fórmula guardada sería código arbitrario ejecutándose con la sesión abierta.
// Aquí se analiza con una gramática cerrada que solo sabe de números, campos de
// la herramienta, cuatro operaciones, potencias y una lista fija de funciones.
//
//   expresion := termino (("+" | "-") termino)*
//   termino   := unario (("*" | "/") unario)*
//   unario    := ("-" | "+") unario | potencia
//   potencia  := primario ("^" unario)?          ← asocia por la derecha
//   primario  := numero | nombre | nombre "(" args ")" | "(" expresion ")"
//
// «-2 ^ 2» da -4, como en papel. El decimal va con punto y los argumentos se
// separan con coma: «max(a, 0.5)».

const H_FORMULA_FUNCIONES = {
    min: { minimo: 1, maximo: Infinity, f: (...xs) => Math.min(...xs) },
    max: { minimo: 1, maximo: Infinity, f: (...xs) => Math.max(...xs) },
    abs: { minimo: 1, maximo: 1, f: Math.abs },
    sqrt: { minimo: 1, maximo: 1, f: Math.sqrt },
    pow: { minimo: 2, maximo: 2, f: Math.pow },
    ln: { minimo: 1, maximo: 1, f: Math.log },
    log: { minimo: 1, maximo: 1, f: Math.log10 },
    exp: { minimo: 1, maximo: 1, f: Math.exp },
    floor: { minimo: 1, maximo: 1, f: Math.floor },
    ceil: { minimo: 1, maximo: 1, f: Math.ceil },
    // Con decimales opcionales: round(x, 2). Se redondea sobre el texto
    // exponencial para que round(1.005, 2) dé 1.01 y no 1.
    round: {
        minimo: 1,
        maximo: 2,
        f: (x, decimales = 0) => Number(Math.round(Number(`${x}e${decimales}`)) + `e-${decimales}`)
    }
}

class HFormulaError extends Error {
    /**
     * @param {string} mensaje Lo que se enseña al usuario.
     * @param {number} [posicion] Carácter de la fórmula donde está el fallo.
     */
    constructor(mensaje, posicion) {
        super(posicion == null ? mensaje : `${mensaje} (carácter ${posicion + 1})`)
        this.name = "HFormulaError"
        this.posicion = posicion
    }
}

/**
 * Trocea la fórmula en números, nombres y símbolos.
 *
 * @param {string} texto
 * @returns {{tipo: string, valor: string|number, pos: number}[]}
 * @throws {HFormulaError} Si aparece un carácter que la gramática no conoce.
 */
function hFormulaTokens(texto) {
    const tokens = []
    let i = 0
    while (i < texto.length) {
        const c = texto[i]
        if (/\s/.test(c)) {
            i++
            continue
        }
        const numero = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(texto.slice(i))
        if (numero) {
            tokens.push({ tipo: "numero", valor: Number(numero[0]), pos: i })
            i += numero[0].length
            continue
        }
        const nombre = /^[A-Za-z_][A-Za-z0-9_]*/.exec(texto.slice(i))
        if (nombre) {
            tokens.push({ tipo: "nombre", valor: nombre[0], pos: i })
            i += nombre[0].length
            continue
        }
        if ("+-*/^(),".includes(c)) {
            tokens.push({ tipo: c, valor: c, pos: i })
            i++
            continue
        }
        throw new HFormulaError(`Carácter no válido «${c}»`, i)
    }
    tokens.push({ tipo: "fin", valor: "", pos: texto.length })
    return tokens
}

/**
 * Analiza una fórmula y devuelve su árbol, listo para evaluarse muchas veces.
 *
 * @param {string} texto La fórmula, p. ej. "gasto / (tasa / 100)".
 * @returns {{arbol: object, variables: Set<string>}} El árbol y los nombres de
 *     campo que usa, para comprobar al guardar que todos existen.
 * @throws {HFormulaError} Si la fórmula está vacía o mal escrita.
 */
function hFormulaCompilar(texto) {
    const fuente = String(texto ?? "")
    if (!fuente.trim()) throw new HFormulaError("La fórmula está vacía")

    const tokens = hFormulaTokens(fuente)
    const variables = new Set()
    let i = 0

    const actual = () => tokens[i]
    const tomar = (tipo) => {
        const token = tokens[i]
        if (token.tipo !== tipo) {
            const visto = token.tipo === "fin" ? "el final" : `«${token.valor}»`
            throw new HFormulaError(`Se esperaba «${tipo}» y hay ${visto}`, token.pos)
        }
        i++
        return token
    }

    function expresion() {
        let nodo = termino()
        while (actual().tipo === "+" || actual().tipo === "-") {
            const op = tokens[i++].tipo
            nodo = { tipo: "binario", op, izq: nodo, der: termino() }
        }
        return nodo
    }

    function termino() {
        let nodo = unario()
        while (actual().tipo === "*" || actual().tipo === "/") {
            const op = tokens[i++].tipo
            nodo = { tipo: "binario", op, izq: nodo, der: unario() }
        }
        return nodo
    }

    function unario() {
        if (actual().tipo === "-" || actual().tipo === "+") {
            const op = tokens[i++].tipo
            const operando = unario()
            return op === "-" ? { tipo: "negativo", operando } : operando
        }
        return potencia()
    }

    function potencia() {
        const base = primario()
        if (actual().tipo !== "^") return base
        i++
        return { tipo: "binario", op: "^", izq: base, der: unario() }
    }

    function primario() {
        const token = actual()
        if (token.tipo === "numero") {
            i++
            return { tipo: "numero", valor: token.valor }
        }
        if (token.tipo === "(") {
            i++
            const nodo = expresion()
            tomar(")")
            return nodo
        }
        if (token.tipo === "nombre") {
            i++
            if (actual().tipo === "(") return llamada(token)
            variables.add(token.valor)
            return { tipo: "variable", nombre: token.valor, pos: token.pos }
        }
        const visto = token.tipo === "fin" ? "la fórmula acaba antes de tiempo" : `sobra «${token.valor}»`
        throw new HFormulaError(`Falta un número o un campo: ${visto}`, token.pos)
    }

    function llamada(token) {
        const funcion = H_FORMULA_FUNCIONES[token.valor]
        if (!funcion) throw new HFormulaError(`La función «${token.valor}» no existe`, token.pos)
        tomar("(")
        const args = []
        if (actual().tipo !== ")") {
            args.push(expresion())
            while (actual().tipo === ",") {
                i++
                args.push(expresion())
            }
        }
        tomar(")")
        if (args.length < funcion.minimo || args.length > funcion.maximo) {
            throw new HFormulaError(`Número de argumentos incorrecto en «${token.valor}»`, token.pos)
        }
        return { tipo: "funcion", nombre: token.valor, args }
    }

    const arbol = expresion()
    if (actual().tipo !== "fin") throw new HFormulaError(`Sobra «${actual().valor}»`, actual().pos)
    return { arbol, variables }
}

/**
 * Calcula el valor de un árbol de `hFormulaCompilar` con los valores dados.
 *
 * Una división entre cero o una raíz de un negativo no lanzan: devuelven
 * Infinity o NaN, que quien pinta el resultado enseña como «no calculable».
 *
 * @param {object} arbol
 * @param {Object<string, number>} valores Valor de cada campo por su nombre.
 * @returns {number}
 * @throws {HFormulaError} Si la fórmula usa un campo que no está en `valores`.
 */
function hFormulaEvaluar(arbol, valores) {
    switch (arbol.tipo) {
        case "numero":
            return arbol.valor
        case "variable":
            if (!Object.prototype.hasOwnProperty.call(valores, arbol.nombre)) {
                throw new HFormulaError(`El campo «${arbol.nombre}» no existe`, arbol.pos)
            }
            return Number(valores[arbol.nombre])
        case "negativo":
            return -hFormulaEvaluar(arbol.operando, valores)
        case "funcion":
            return H_FORMULA_FUNCIONES[arbol.nombre].f(...arbol.args.map((a) => hFormulaEvaluar(a, valores)))
        case "binario": {
            const a = hFormulaEvaluar(arbol.izq, valores)
            const b = hFormulaEvaluar(arbol.der, valores)
            if (arbol.op === "+") return a + b
            if (arbol.op === "-") return a - b
            if (arbol.op === "*") return a * b
            if (arbol.op === "/") return a / b
            return Math.pow(a, b)
        }
        default:
            throw new HFormulaError("Fórmula no válida")
    }
}

/**
 * Comprueba una fórmula contra los campos de su herramienta, sin calcularla.
 *
 * @param {string} texto
 * @param {Iterable<string>} campos Nombres de campo disponibles.
 * @returns {string|null} El motivo por el que no vale, o null si vale.
 */
function hFormulaProblema(texto, campos) {
    try {
        const { variables } = hFormulaCompilar(texto)
        const disponibles = new Set(campos)
        const desconocido = [...variables].find((v) => !disponibles.has(v))
        return desconocido ? `El campo «${desconocido}» no existe` : null
    } catch (error) {
        if (error instanceof HFormulaError) return error.message
        throw error
    }
}
