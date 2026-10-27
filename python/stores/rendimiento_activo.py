"""Totales de un activo: participaciones vivas, invertido neto y rendimiento.

Había dos copias de este cálculo. `listAssets` (la lista de la barra lateral y
del resumen) sumaba en `float` con un lector de importes; la ruta
`/api/activos/rendimiento-batch` (la tabla principal) sumaba en `Decimal` con
otro. La fórmula era la misma, pero cada arreglo había que hacerlo dos veces, y
en coma flotante el error de cada suma se arrastra hasta el total que se enseña:
la barra lateral y la tabla podían diferir en un céntimo para el mismo activo.

Aquí queda una sola versión, en `Decimal` y con el lector de `core.dinero`. Los
importes están en la divisa del activo; el desglose entre efecto activo y efecto
divisa (con el tipo de cambio de cada compra) lo añade la ruta batch encima de
estos totales.
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from core import dinero
from core.fifo import FifoError, parseFecha

CERO = Decimal("0")


def numero(valor) -> Decimal:
    """Importe de una columna TEXT; vacío o ilegible cuenta como cero."""
    return dinero.aDecimalONulo(valor) or CERO


@dataclass(frozen=True)
class Totales:
    participaciones: Decimal
    invertidoBruto: Decimal
    invertidoNeto: Decimal
    netoActual: Decimal
    rendimiento: Decimal
    rendimientoPct: Decimal

    def paraJson(self) -> dict:
        """Las cifras que enseña la interfaz, redondeadas una sola vez al final."""
        return {
            "rendimiento": float(dinero.redondear(self.rendimiento)),
            "invertidoNeto": float(dinero.redondear(self.invertidoNeto)),
            "rendimientoPct": float(dinero.redondear(self.rendimientoPct)),
            "netoActual": float(dinero.redondear(self.netoActual)),
        }


def _campo(fila, nombre: str):
    """Valor de una columna que puede no venir en la fila (dict o `sqlite3.Row`)."""
    try:
        return fila[nombre]
    except (IndexError, KeyError):
        return None


def _esConversionDeSalida(tipo) -> bool:
    normalizado = str(tipo or "").strip().lower()
    return " convertidos" in normalizado or normalizado == "convertidos"


def _esConversion(tipo) -> bool:
    normalizado = str(tipo or "").strip().lower()
    return _esConversionDeSalida(normalizado) or "convertidos a" in normalizado


def _convertir(importe, desde, hacia, tipo):
    """`importe` pasado de `desde` a `hacia` con el cambio de hoy; igual si no se sabe."""
    if tipo is None or desde == hacia:
        return importe
    cambio = tipo(desde, hacia)
    return importe * cambio if cambio is not None else importe


def _monedaDeFila(fila, moneda) -> str:
    """Divisa de una compra de cripto; el navegador solo distingue USD de EUR."""
    return "USD" if str(_campo(fila, "currency") or moneda).strip().upper() == "USD" else "EUR"


def _costeDeOperacion(op, cantidad, moneda, tipo):
    """Coste del lote de una compra de Operaciones, como lo calcula el navegador.

    Precio de la orden por cantidad (el Total se teclea a mano y a veces lleva la
    comisión dentro, así que solo se usa si no hay precio), más la comisión en
    euros: esa comisión se descuenta luego del invertido neto.
    """
    divisaOrden = str(_campo(op, "precio_currency") or _campo(op, "currency") or moneda).strip().upper()
    precio = _convertir(numero(_campo(op, "precio_orden")), divisaOrden, moneda, tipo)
    if precio > 0:
        base = precio * cantidad
    else:
        divisaTotal = str(_campo(op, "currency") or _campo(op, "precio_currency") or moneda).strip().upper()
        base = _convertir(numero(_campo(op, "total")), divisaTotal, moneda, tipo)
    comision = _convertir(max(CERO, numero(_campo(op, "comisiones_fiat"))), "EUR", moneda, tipo)
    return base + comision


def comisionesFiat(filas, operaciones, esCripto: bool, moneda: str = "EUR", tipo=None) -> Decimal:
    """Comisiones que el invertido neto descuenta del bruto, igual que la ficha.

    Una sola regla para todos los activos: el invertido neto es el importe sin
    comisiones, venga de la ficha o de Operaciones. De la ficha, la comisión en
    divisa de cada fila en cripto (en la divisa de cada una) y la columna de
    comisiones en el resto. De Operaciones, la comisión de las compras
    completadas, que va siempre en euros.
    """
    if esCripto:
        total = sum(
            (_convertir(numero(_campo(fila, "comisiones_fiat")), _monedaDeFila(fila, moneda), moneda, tipo)
             for fila in filas),
            CERO,
        )
    else:
        total = sum((numero(_campo(fila, "comisiones")) for fila in filas), CERO)
    for op in operaciones:
        if str(op["orden"] or "").strip().lower() == "compra":
            total += _convertir(max(CERO, numero(_campo(op, "comisiones_fiat"))), "EUR", moneda, tipo)
    return total


def _fechaOrden(texto) -> date:
    """Fecha de una operación; las ilegibles van al final de la línea temporal."""
    try:
        return parseFecha(texto)
    except FifoError:
        return date.max


_CONSULTAS_DE_POSICION = (
    ("filas", "SELECT asset_id, fecha_operacion, tipo_operacion, participaciones, precio_participacion, "
              "capital_invertido_bruto, comisiones, comisiones_fiat, comisiones_cripto, currency, fx_rate "
              "FROM activo_rows ORDER BY id"),
    ("operaciones", "SELECT asset_id, fecha_apertura, orden, cantidad, precio_orden, precio_currency, "
                    "comisiones_cripto, comisiones_fiat, total, currency, fx_rate "
                    "FROM activo_operation_rows WHERE estado = 'Completado' ORDER BY rowid"),
    ("ventas", "SELECT asset_id, fecha, cantidad FROM ventas ORDER BY year, rowid"),
    ("transacciones", "SELECT asset_id, fecha_operacion, total, comision_red, wallet_tipo "
                      "FROM transacciones ORDER BY rowid"),
    ("conversiones", "SELECT asset_id, fecha, par, tipo, cantidad FROM activo_conversion_rows ORDER BY rowid"),
)


def cargarPosiciones(conn) -> dict:
    """Todo lo que mueve las participaciones de cada activo, agrupado por `asset_id`.

    Son las mismas fuentes que usa el navegador para saber cuántas
    participaciones hay: la ficha, las operaciones completadas, las ventas, las
    transacciones entre wallets y las conversiones. Quien valore la cartera sin
    alguna de ellas da una cifra distinta de la que se ve en pantalla.

    Returns:
        `{asset_id: {"filas", "operaciones", "ventas", "transacciones", "conversiones"}}`.
    """
    posiciones = {}
    for clave, consulta in _CONSULTAS_DE_POSICION:
        for fila in conn.execute(consulta):
            datos = posiciones.setdefault(fila["asset_id"], {nombre: [] for nombre, _ in _CONSULTAS_DE_POSICION})
            datos[clave].append(fila)
    return posiciones


def lotesVivos(filas, operaciones, esCripto: bool, ventas=(), hasta=None, transacciones=(), conversiones=(),
               moneda: str = "EUR", tipo=None) -> list:
    """Lotes de compra que siguen en cartera tras aplicar las ventas por FIFO.

    Cada lote es `{"cantidad", "coste", "fx"}`: lo que queda de la compra, el
    coste bruto de esa parte y el tipo de cambio anotado en la compra (cadena
    vacía si no lo hay). Las ventas consumen de los lotes más antiguos y, si
    piden más de lo que hay, solo se llevan lo disponible, igual que el
    navegador. En cripto, la comisión en cripto reduce lo comprado y aumenta lo
    vendido.

    Args:
        filas: Filas de `activo_rows`.
        operaciones: Filas de `activo_operation_rows` en estado Completado.
        esCripto: Si el activo es de tipo cripto.
        ventas: Filas de la tabla `ventas` del activo (fecha, cantidad): también
            sacan participaciones de la cartera, igual que en el navegador.
        hasta: Si se indica (un `date`), solo cuentan las operaciones hasta ese
            día incluido: la posición que había entonces.
        transacciones: Filas de `transacciones` del activo: las recibidas suman
            participaciones sin coste, las enviadas las restan con su comisión de
            red y las que van entre wallets solo pierden la comisión.
        conversiones: Filas de `activo_conversion_rows` del activo. Se unen a las
            filas de la ficha con tipo «convertidos», que son las mismas
            conversiones en el formato antiguo; las repetidas cuentan una vez.
        moneda: Divisa del activo, en la que sale el coste de cada lote.
        tipo: Función `(desde, hacia) -> Decimal | None` con el cambio de hoy. Sin
            ella los importes no se convierten.

    Returns:
        Lista de lotes vivos, de más antiguo a más reciente.
    """
    eventos = []
    conversionesAntiguas = []
    for indice, fila in enumerate(filas):
        tipoFila = str(fila["tipo_operacion"] or "").strip()
        if _esConversion(tipoFila):
            # Las conversiones antiguas vivían en la ficha como filas con un tipo
            # «X convertidos» o «Convertidos a X»: no son compras ni ventas.
            conversionesAntiguas.append({
                "fecha": _campo(fila, "fecha_operacion"), "par": _campo(fila, "par") or "",
                "tipo": tipoFila, "cantidad": fila["participaciones"],
            })
            continue
        cantidad = numero(fila["participaciones"])
        comisionCripto = numero(_campo(fila, "comisiones_cripto")) if esCripto else CERO
        esVenta = tipoFila.lower() == "venta"
        coste = numero(fila["capital_invertido_bruto"])
        if coste <= 0:
            coste = numero(_campo(fila, "precio_participacion")) * cantidad
        if esCripto:
            coste = _convertir(coste, _monedaDeFila(fila, moneda), moneda, tipo)
        eventos.append((
            _fechaOrden(_campo(fila, "fecha_operacion")), indice, esVenta,
            cantidad + comisionCripto if esVenta else max(CERO, cantidad - comisionCripto),
            coste, _campo(fila, "fx_rate") or "",
        ))
    for indice, op in enumerate(operaciones, start=len(eventos)):
        cantidad = numero(op["cantidad"])
        comisionCripto = numero(op["comisiones_cripto"])
        esVenta = str(op["orden"] or "").strip().lower() == "venta"
        eventos.append((
            _fechaOrden(_campo(op, "fecha_apertura")), indice, esVenta,
            cantidad + comisionCripto if esVenta else max(CERO, cantidad - comisionCripto),
            CERO if esVenta else _costeDeOperacion(op, cantidad, moneda, tipo), _campo(op, "fx_rate") or "",
        ))

    for indice, venta in enumerate(ventas, start=len(eventos)):
        eventos.append((
            _fechaOrden(_campo(venta, "fecha")), indice, True,
            numero(venta["cantidad"]), CERO, "",
        ))

    for indice, fila in enumerate(transacciones, start=len(eventos)):
        cantidad = numero(fila["total"])
        comisionRed = max(CERO, numero(_campo(fila, "comision_red")))
        movimiento = str(fila["wallet_tipo"] or "").strip().lower()
        if cantidad <= 0 or movimiento not in ("entre_wallet", "enviada", "recibida"):
            continue
        fechaTransaccion = _fechaOrden(_campo(fila, "fecha_operacion"))
        if movimiento == "entre_wallet":
            eventos.append((fechaTransaccion, indice, True, comisionRed, CERO, ""))
        elif movimiento == "enviada":
            eventos.append((fechaTransaccion, indice, True, cantidad + comisionRed, CERO, ""))
        else:
            eventos.append((fechaTransaccion, indice, False, cantidad, CERO, ""))

    vistas = set()
    for fila in [*conversiones, *conversionesAntiguas]:
        esSalida = _esConversionDeSalida(fila["tipo"])
        clave = (str(fila["fecha"] or "").strip(), str(fila["par"] or "").strip(), esSalida,
                 str(fila["cantidad"] or "").strip())
        if clave in vistas:
            continue
        vistas.add(clave)
        eventos.append((
            _fechaOrden(fila["fecha"]), len(eventos), esSalida, numero(fila["cantidad"]), CERO, "",
        ))

    lotes = []
    for fecha, _indice, esVenta, cantidad, coste, fx in sorted(eventos, key=lambda e: (e[0], e[1])):
        if hasta is not None and fecha > hasta:
            continue
        if not esVenta:
            if cantidad > 0:
                lotes.append({"cantidad": cantidad, "coste": coste, "fx": fx})
            continue
        pendiente = cantidad
        for lote in lotes:
            if pendiente <= 0:
                break
            tomado = min(lote["cantidad"], pendiente)
            if tomado <= 0:
                continue
            lote["coste"] -= lote["coste"] * tomado / lote["cantidad"]
            lote["cantidad"] -= tomado
            pendiente -= tomado

    return [lote for lote in lotes if lote["cantidad"] > 0]


def calcular(filas, operaciones, esCripto: bool, precio, ventas=(), transacciones=(), conversiones=(),
             moneda: str = "EUR", tipo=None) -> Totales:
    """Totales a partir de las filas del activo y sus operaciones completadas.

    `filas` son filas de `activo_rows` (tipo_operacion, participaciones,
    capital_invertido_bruto, comisiones, comisiones_fiat, y opcionalmente
    fecha_operacion y comisiones_cripto) y `operaciones` de
    `activo_operation_rows` en estado Completado (orden, cantidad,
    comisiones_cripto, total, y opcionalmente fecha_apertura). Sirven
    `sqlite3.Row` o diccionarios.

    El invertido es el coste de lo que sigue en cartera: las ventas retiran el
    coste FIFO de lo vendido, no solo las participaciones.
    """
    vivos = lotesVivos(filas, operaciones, esCripto, ventas, None, transacciones, conversiones, moneda, tipo)
    participaciones = sum((lote["cantidad"] for lote in vivos), CERO)
    invertidoBruto = sum((lote["coste"] for lote in vivos), CERO)
    # En cripto la comisión que resta del invertido es la de divisa; la de cripto
    # ya se descontó de las participaciones recibidas.
    comisiones = comisionesFiat(filas, operaciones, esCripto, moneda, tipo)

    invertidoNeto = invertidoBruto - comisiones
    netoActual = max(CERO, participaciones) * numero(precio)
    rendimiento = netoActual - invertidoNeto
    rendimientoPct = rendimiento / invertidoNeto * 100 if invertidoNeto > 0 else CERO

    return Totales(participaciones, invertidoBruto, invertidoNeto, netoActual, rendimiento, rendimientoPct)
