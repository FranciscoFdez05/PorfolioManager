"""Lógica de negocio de las hipotecas: validación de la entrada y cálculo.

Sin acceso a datos ni a Flask. El cuadro y las métricas los produce
`core.amortizacion`; aquí solo se decide qué tipo se aplica en cada fecha
(fijo, o Euríbor más diferencial) y se convierte el resultado a algo que
serializa JSON.

En una hipoteca variable el tipo de cada periodo es el último Euríbor
introducido con fecha igual o anterior al inicio de ese periodo, más el
diferencial. Los periodos futuros sin Euríbor propio arrastran el último
conocido: es una proyección, no un dato. Antes del primer Euríbor se usa `tin`,
que en variable es el tipo inicial pactado.
"""

import re
from collections.abc import Callable
from datetime import date
from decimal import Decimal

from core import amortizacion, dinero
from core.amortizacion import Amortizacion, AmortizacionInvalida
from core.errors import ValidationError
from core.validation import asDecimal, asInt, asRows, asText, oneOf

TIPOS = ("fija", "variable")
MODOS_AMORTIZACION = ("plazo", "cuota")
REVISIONES_VALIDAS = (6, 12)
MAX_PLAZO_MESES = 600
MAX_CAPITAL = Decimal("100000000")
MAX_TIPO = Decimal(30)
_FECHA = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _fecha(valor, campo: str) -> str:
    """Fecha ISO validada como fecha real, devuelta como texto."""
    texto = asText(valor, campo, maxLength=10, required=True)
    if not _FECHA.match(texto):
        raise ValidationError(f"«{campo}» debe tener formato AAAA-MM-DD", field=campo)
    try:
        date.fromisoformat(texto)
    except ValueError:
        raise ValidationError(f"«{campo}» no es una fecha válida", field=campo) from None
    return texto


def _texto(valor: Decimal) -> str:
    return dinero.aTexto(valor)


def sanearEuribor(filas) -> list[dict]:
    """Lista de revisiones `{fecha, valor}` ordenada por fecha.

    Args:
        filas: Entrada sin confiar, tal como llega del cliente.

    Returns:
        Revisiones validadas, sin fechas repetidas (gana la última enviada).

    Raises:
        ValidationError: si una fecha o un valor no son válidos.
    """
    porFecha = {}
    for fila in asRows(filas, "euribor", maxRows=200):
        fecha = _fecha(fila.get("fecha"), "euribor.fecha")
        valor = asDecimal(fila.get("valor"), "euribor.valor", required=True,
                          minimum=Decimal(-5), maximum=MAX_TIPO)
        porFecha[fecha] = _texto(valor)
    return [{"fecha": f, "valor": porFecha[f]} for f in sorted(porFecha)]


def sanearAmortizaciones(filas) -> list[dict]:
    """Lista de pagos anticipados `{fecha, importe, modo}` ordenada por fecha."""
    resultado = []
    for fila in asRows(filas, "amortizaciones", maxRows=500):
        resultado.append({
            "fecha": _fecha(fila.get("fecha"), "amortizaciones.fecha"),
            "importe": _texto(asDecimal(fila.get("importe"), "amortizaciones.importe",
                                        required=True, minimum=Decimal("0.01"),
                                        maximum=MAX_CAPITAL)),
            "modo": oneOf(fila.get("modo"), MODOS_AMORTIZACION, "amortizaciones.modo",
                          default="plazo"),
        })
    return sorted(resultado, key=lambda f: f["fecha"])


def sanearHipoteca(fila: dict) -> dict:
    """Valida y normaliza una hipoteca recibida del cliente.

    Args:
        fila: Objeto JSON de una hipoteca.

    Returns:
        La hipoteca con tipos y rangos comprobados e importes como texto
        canónico. `id` puede venir vacío; lo asigna quien guarda.

    Raises:
        ValidationError: ante cualquier campo fuera de rango o ilegible.
    """
    tipo = oneOf(fila.get("tipo"), TIPOS, "tipo", default="fija")
    revision = asInt(fila.get("revisionMeses"), "revisionMeses", default=12)
    if revision not in REVISIONES_VALIDAS:
        raise ValidationError("«revisionMeses» debe ser 6 o 12", field="revisionMeses")

    return {
        "id": asText(fila.get("id"), "id", maxLength=64),
        "alias": asText(fila.get("alias"), "alias", maxLength=80, required=True),
        "tipo": tipo,
        "capital": _texto(asDecimal(fila.get("capital"), "capital", required=True,
                                    minimum=Decimal("0.01"), maximum=MAX_CAPITAL)),
        "fechaInicio": _fecha(fila.get("fechaInicio"), "fechaInicio"),
        "plazoMeses": asInt(fila.get("plazoMeses"), "plazoMeses", required=True,
                            minimum=1, maximum=MAX_PLAZO_MESES),
        "tin": _texto(asDecimal(fila.get("tin"), "tin", default=Decimal(0),
                                minimum=Decimal(0), maximum=MAX_TIPO)),
        "diferencial": _texto(asDecimal(fila.get("diferencial"), "diferencial",
                                        default=Decimal(0), minimum=Decimal(-5),
                                        maximum=MAX_TIPO)),
        "revisionMeses": revision,
        "euribor": sanearEuribor(fila.get("euribor")),
        "amortizaciones": sanearAmortizaciones(fila.get("amortizaciones")),
        "nota": asText(fila.get("nota"), "nota", maxLength=500),
        "cuenta": asText(fila.get("cuenta"), "cuenta", maxLength=64),
        "diaCobro": sanearDiaCobro(fila.get("diaCobro")),
        "categoria": asText(fila.get("categoria"), "categoria", maxLength=80),
    }


def sanearDiaCobro(valor) -> str:
    """Día del mes en que se cobra la cuota; vacío = el día de la fecha de inicio.

    Args:
        valor: Entrada sin confiar.

    Returns:
        El día como texto, o `""` si no se indicó.

    Raises:
        ValidationError: si no es un entero entre 1 y 31.
    """
    if valor is None or str(valor).strip() == "":
        return ""
    return str(asInt(valor, "diaCobro", minimum=1, maximum=31))


def estrategiaDeTipo(hipoteca: dict) -> Callable[[date], Decimal]:
    """Función que da el TIN anual vigente en una fecha para esta hipoteca.

    Args:
        hipoteca: Hipoteca ya saneada.

    Returns:
        Un callable `fecha -> TIN en %`. A tipo fijo es constante; en variable
        busca el último Euríbor con fecha <= la consultada y le suma el
        diferencial, con `tin` como tipo inicial si aún no hay ninguno.
    """
    tin = dinero.aDecimal(hipoteca["tin"], "tin")
    if hipoteca["tipo"] == "fija":
        return lambda _fecha: tin

    diferencial = dinero.aDecimal(hipoteca["diferencial"], "diferencial")
    revisiones = [(date.fromisoformat(r["fecha"]), dinero.aDecimal(r["valor"], "euribor"))
                  for r in hipoteca["euribor"]]

    def tipoVariable(fecha: date) -> Decimal:
        vigente: Decimal | None = None
        for fechaRevision, valor in revisiones:
            if fechaRevision <= fecha:
                vigente = valor
            else:
                break
        return tin if vigente is None else max(vigente + diferencial, Decimal(0))

    return tipoVariable


def _amortizaciones(hipoteca: dict) -> list[Amortizacion]:
    return [Amortizacion(date.fromisoformat(a["fecha"]),
                         dinero.aDecimal(a["importe"], "importe"), a["modo"])
            for a in hipoteca["amortizaciones"]]


def _numero(valor) -> float:
    return float(dinero.redondear(valor, 2)) if isinstance(valor, Decimal) else valor


def generarCuadroDeHipoteca(hipoteca: dict, conAmortizaciones: bool = True) -> list[amortizacion.Recibo]:
    """Cuadro de amortización de una hipoteca saneada.

    Es el único sitio que lo construye: lo usan el cálculo de la ventana y la
    sincronización con Mensualidades, y deben coincidir recibo a recibo.

    Args:
        hipoteca: Hipoteca saneada.
        conAmortizaciones: `False` ignora los pagos anticipados (para medir el
            ahorro de intereses que suponen).

    Returns:
        Un recibo por mes hasta liquidar.

    Raises:
        AmortizacionInvalida: si los datos no permiten construir el cuadro.
    """
    revision = hipoteca["revisionMeses"] if hipoteca["tipo"] == "variable" else 0
    return amortizacion.generarCuadro(
        dinero.aDecimal(hipoteca["capital"], "capital"), hipoteca["plazoMeses"],
        date.fromisoformat(hipoteca["fechaInicio"]), estrategiaDeTipo(hipoteca), revision,
        _amortizaciones(hipoteca) if conAmortizaciones else [])


def calcularHipoteca(hipoteca: dict, hoy: date) -> dict:
    """Cuadro y métricas de una hipoteca a fecha `hoy`.

    Args:
        hipoteca: Hipoteca saneada.
        hoy: Fecha de referencia para lo pagado y lo pendiente.

    Returns:
        `{"resumen": {...}, "cuadro": [...]}` con importes como `float`, o
        `{"error": "..."}` si los datos no permiten un cuadro. Un error de
        cálculo no tumba el resto de hipotecas.
    """
    capital = dinero.aDecimal(hipoteca["capital"], "capital")

    try:
        cuadro = generarCuadroDeHipoteca(hipoteca)
        sinExtras = generarCuadroDeHipoteca(hipoteca, conAmortizaciones=False) if hipoteca["amortizaciones"] else None
    except AmortizacionInvalida as error:
        return {"error": str(error)}

    resumen = amortizacion.resumir(cuadro, capital, hoy, sinExtras)
    resumen = {k: (v.isoformat() if isinstance(v, date) else _numero(v)) for k, v in resumen.items()}
    return {
        "resumen": resumen,
        "cuadro": [
            {"numero": r.numero, "fecha": r.fecha.isoformat(), "cuota": _numero(r.cuota),
             "interes": _numero(r.interes), "capital": _numero(r.capital),
             "extra": _numero(r.extra), "pendiente": _numero(r.pendiente),
             "tipo": _numero(r.tipo), "pagado": r.fecha <= hoy}
            for r in cuadro
        ],
    }


def _cuotaTrasElPago(cuadro: list[amortizacion.Recibo], fecha: date) -> Decimal:
    """Cuota del recibo siguiente al que absorbe un pago anticipado del día `fecha`.

    El cuadro aplica el pago justo después del primer recibo con fecha >= `fecha`,
    así que la cuota "actual" no muestra el efecto: hay que mirar el recibo
    posterior. Si no queda ninguno, la del último.
    """
    indice = next((i for i, r in enumerate(cuadro) if r.fecha >= fecha), len(cuadro) - 1)
    return cuadro[min(indice + 1, len(cuadro) - 1)].cuota


def _metricasEscenario(cuadro: list[amortizacion.Recibo], capital: Decimal, hoy: date,
                       fechaPago: date) -> dict:
    """Subconjunto del resumen que se compara entre escenarios de la simulación."""
    resumen = amortizacion.resumir(cuadro, capital, hoy)
    metricas = {clave: resumen[clave] for clave in
                ("cuotasRestantes", "fechaFin", "interesesPendientes", "costeTotal")}
    metricas["cuotaTrasElPago"] = _cuotaTrasElPago(cuadro, fechaPago)
    return metricas


def _serializarEscenario(metricas: dict) -> dict:
    return {k: (v.isoformat() if isinstance(v, date) else _numero(v)) for k, v in metricas.items()}


def simularAmortizacion(hipoteca: dict, hoy: date, importe: Decimal, fecha: date) -> dict:
    """Compara la hipoteca actual con un pago anticipado hipotético.

    Calcula tres escenarios sobre el mismo cuadro: el actual, el de amortizar
    `importe` reduciendo el plazo y el de amortizarlo reduciendo la cuota. No
    guarda nada: es una consulta, la amortización real se añade desde la tabla
    de amortizaciones anticipadas.

    Args:
        hipoteca: Hipoteca saneada.
        hoy: Fecha de referencia para lo pagado y lo pendiente.
        importe: Capital a amortizar.
        fecha: Día del pago hipotético; no puede ser anterior a `hoy`, porque
            el cuadro aplicaría un pago pasado en el primer recibo.

    Returns:
        `{"actual": {...}, "plazo": {...}, "cuota": {...}}`; cada escenario de
        pago trae además `ahorroIntereses`, `mesesAhorrados` y `cuotaDiferencia`
        respecto al actual.

    Raises:
        ValidationError: si el importe supera el capital pendiente, la fecha es
            pasada o la hipoteca ya está liquidada.
        AmortizacionInvalida: si los datos de la hipoteca no permiten un cuadro.
    """
    if fecha < hoy:
        raise ValidationError("La fecha de la simulación no puede ser pasada", field="fecha")

    capital = dinero.aDecimal(hipoteca["capital"], "capital")
    cuadroActual = generarCuadroDeHipoteca(hipoteca)
    actual = _metricasEscenario(cuadroActual, capital, hoy, fecha)
    if actual["cuotasRestantes"] == 0:
        raise ValidationError("La hipoteca ya está liquidada", field="importe")

    pendiente = amortizacion.resumir(cuadroActual, capital, hoy)["capitalPendiente"]
    if importe > pendiente:
        raise ValidationError(
            f"El importe supera el capital pendiente ({dinero.aTextoEs(pendiente)} €)", field="importe")

    resultado = {"actual": _serializarEscenario(actual)}
    for modo in MODOS_AMORTIZACION:
        extra = {"fecha": fecha.isoformat(), "importe": dinero.aTexto(importe), "modo": modo}
        simulada = {**hipoteca, "amortizaciones": [*hipoteca["amortizaciones"], extra]}
        metricas = _metricasEscenario(generarCuadroDeHipoteca(simulada), capital, hoy, fecha)
        escenario = _serializarEscenario(metricas)
        escenario["ahorroIntereses"] = _numero(actual["interesesPendientes"] - metricas["interesesPendientes"])
        escenario["mesesAhorrados"] = actual["cuotasRestantes"] - metricas["cuotasRestantes"]
        escenario["cuotaDiferencia"] = _numero(actual["cuotaTrasElPago"] - metricas["cuotaTrasElPago"])
        resultado[modo] = escenario
    return resultado
