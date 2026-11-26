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

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from core import canjes as canjesFiscal, dinero
from core.cache_foto import CachePorFoto
from core.centimos import importeSql
from core.fifo import FifoError, parseFecha
from stores import canjes_store

CERO = Decimal("0")

# Índice a partir del cual van los movimientos de un canje dentro de su día: un
# canje se ejecuta al cierre, detrás de lo que se compró o vendió ese día (la
# misma regla que `core.canjes.ORDEN_BASE` en el cálculo fiscal).
_INDICE_CANJE = 10**9


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
              f"{importeSql('capital_invertido_bruto')} AS capital_invertido_bruto, "
              f"{importeSql('comisiones')} AS comisiones, {importeSql('comisiones_fiat')} AS comisiones_fiat, "
              "comisiones_cripto, currency, fx_rate "
              "FROM activo_rows ORDER BY id"),
    ("operaciones", "SELECT asset_id, fecha_apertura, orden, cantidad, precio_orden, precio_currency, "
                    f"comisiones_cripto, {importeSql('comisiones_fiat')} AS comisiones_fiat, "
                    f"{importeSql('total')} AS total, currency, fx_rate "
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
            datos = posiciones.setdefault(fila["asset_id"], _posicionVacia())
            datos[clave].append(fila)
    _incorporarCanjes(conn, posiciones)
    return posiciones


def _posicionVacia() -> dict:
    return {nombre: [] for nombre, _ in _CONSULTAS_DE_POSICION}


def _incorporarCanjes(conn, posiciones: dict) -> None:
    """Añade a la ficha de cada activo los movimientos de sus canjes.

    Un canje saca los títulos del activo entregado y mete los del recibido. Se
    representan como filas de la ficha (`Venta` y `Compra`) marcadas con la
    clave `canje`, para que todos los que leen `cargarPosiciones` (tabla
    principal, gráficos, valoración, snapshots) los vean sin cambiar nada. En
    régimen neutral el destino recibe un lote por cada lote vivo del origen, con
    su coste y su fecha de adquisición (`fecha_antiguedad`), menos la parte de
    compensación en dinero; en el general, un lote al valor de mercado.

    Los canjes se recorren en orden cronológico para que uno encadenado vea los
    lotes que el anterior dejó en su activo de origen.

    Args:
        conn: Conexión a la base.
        posiciones: Resultado parcial de `cargarPosiciones`; se modifica.
    """
    filas = canjes_store.leerFilas()
    if not filas:
        return
    activos = {fila["id"]: fila for fila in conn.execute("SELECT id, type, currency FROM activos")}
    ordenados = sorted(filas, key=lambda fila: (_fechaOrden(fila["fecha"]), fila["seq"]))
    for canje in ordenados:
        origen = activos.get(canje["activo_origen"])
        destino = activos.get(canje["activo_destino"])
        fecha = _fechaOrden(canje["fecha"])
        entregadas = numero(canje["cantidad_entregada"])
        if origen is None or destino is None or fecha == date.max or entregadas <= 0:
            continue
        datosOrigen = posiciones.setdefault(origen["id"], _posicionVacia())
        datosDestino = posiciones.setdefault(destino["id"], _posicionVacia())
        if canje["regimen"] == canjesFiscal.GRAVADO:
            entradas = _entradasGravado(canje)
        else:
            entradas = _entradasNeutral(canje, datosOrigen, origen, fecha, entregadas)
        datosDestino["filas"].extend(entradas)
        datosOrigen["filas"].append(_filaCanje(canje, origen["id"], "Venta", entregadas))


def _entradasNeutral(canje, datosOrigen: dict, origen, fecha: date, entregadas: Decimal) -> list:
    """Filas `Compra` del destino que heredan los lotes del origen, y la venta de los picos."""
    moneda = str(origen["currency"] or "EUR").strip().upper() or "EUR"
    lotes = lotesVivos(
        datosOrigen["filas"], datosOrigen["operaciones"], str(origen["type"] or "").strip().lower() == "cripto",
        datosOrigen["ventas"], fecha, datosOrigen["transacciones"], datosOrigen["conversiones"], moneda,
    )
    recibidas = numero(canje["cantidad_recibida"])
    picos = numero(canje["picos_cantidad"])
    factor = (recibidas + picos) / entregadas
    compensacion = numero(canje["compensacion"])

    entradas = []
    pendiente = entregadas
    for lote in lotes:
        if pendiente <= 0:
            break
        tomado = min(lote["cantidad"], pendiente)
        if tomado <= 0:
            continue
        pendiente -= tomado
        entradas.append(_filaCanje(
            canje, canje["activo_destino"], "Compra", tomado * factor,
            coste=lote["coste"] * tomado / lote["cantidad"], moneda=moneda, fx=lote["fx"],
            antiguedad=lote["fecha"], descuento=compensacion * tomado / entregadas,
        ))
    if entradas and picos > 0:
        entradas.append(_filaCanje(canje, canje["activo_destino"], "Venta", picos))
    return entradas


def _entradasGravado(canje) -> list:
    """Fila `Compra` del destino al valor de mercado, con la fecha del canje."""
    recibidas = numero(canje["cantidad_recibida"])
    if recibidas <= 0:
        return []
    return [_filaCanje(
        canje, canje["activo_destino"], "Compra", recibidas, coste=numero(canje["valor_mercado"]),
        moneda=str(canje["moneda"] or "EUR").strip().upper() or "EUR", fx=canje["fx_rate"] or "",
    )]


def _filaCanje(canje, assetId: str, tipo: str, cantidad: Decimal, *, coste: Decimal = CERO, moneda: str = "EUR",
               fx="", antiguedad: date | None = None, descuento: Decimal = CERO) -> dict:
    """Fila con las columnas de `activo_rows` que leen los cálculos de posición.

    `descuento` es la parte de compensación en dinero que rebaja el coste del
    lote, en la moneda del canje; se convierte junto con el coste en
    `_eventosOrdenados`, que es donde está el tipo de cambio.
    """
    return {
        "asset_id": assetId,
        "fecha_operacion": canje["fecha"],
        "tipo_operacion": tipo,
        "participaciones": dinero.aTexto(cantidad),
        "precio_participacion": "",
        "capital_invertido_bruto": dinero.aTexto(coste),
        "comisiones": "",
        "comisiones_fiat": "",
        "comisiones_cripto": "",
        "currency": moneda,
        "fx_rate": fx,
        "canje": canje["id"],
        "fecha_antiguedad": antiguedad,
        "canje_descuento": descuento,
        "canje_moneda": str(canje["moneda"] or "EUR").strip().upper() or "EUR",
    }


def _eventosOrdenados(filas, operaciones, esCripto: bool, ventas, transacciones, conversiones,
                      moneda: str, tipo) -> list:
    """Compras y ventas de un activo como eventos ordenados.

    Cada evento es `(fecha, orden, esVenta, cantidad, coste, fx, antiguedad,
    heredado)`. `antiguedad` es la fecha de adquisición del lote que crea (la
    del evento salvo en los lotes heredados de un canje neutral, que conservan
    la de los títulos entregados) y `heredado` dice si es uno de esos.

    Los une de todas las fuentes (ficha, operaciones, ventas, transacciones,
    conversiones y canjes) y los deja en el orden en que se aplican a los lotes.
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
        fechaFila = _fechaOrden(_campo(fila, "fecha_operacion"))
        if _campo(fila, "canje"):
            eventos.append(_eventoDeCanje(fila, indice, fechaFila, esVenta, cantidad, moneda, tipo))
            continue
        eventos.append((
            fechaFila, indice, esVenta,
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

    # Solo los eventos de canje traen antigüedad propia; el resto la toma de su
    # fecha y no es heredado.
    completos = [evento if len(evento) == 8 else (*evento, evento[0], False) for evento in eventos]
    return sorted(completos, key=lambda e: (e[0], e[1]))


def _eventoDeCanje(fila, indice: int, fecha: date, esVenta: bool, cantidad: Decimal, moneda: str, tipo) -> tuple:
    """Evento de una fila generada por `_incorporarCanjes`.

    Va detrás de todo lo demás de su día (`_INDICE_CANJE`). El coste del lote,
    en la moneda en que se generó, y la compensación que lo rebaja, en la del
    canje, se pasan a la del activo con el cambio de hoy, como las compras de
    cripto en otra divisa.
    """
    antiguedad = _campo(fila, "fecha_antiguedad")
    coste = CERO
    if not esVenta:
        coste = _convertir(numero(fila["capital_invertido_bruto"]), _campo(fila, "currency") or moneda, moneda, tipo)
        descuento = _convertir(_campo(fila, "canje_descuento") or CERO, _campo(fila, "canje_moneda") or moneda,
                               moneda, tipo)
        coste = max(CERO, coste - descuento)
    return (
        fecha, _INDICE_CANJE + indice, esVenta, cantidad, coste, _campo(fila, "fx_rate") or "",
        antiguedad or fecha, antiguedad is not None,
    )


def _aplicarEvento(lotes: list, esVenta: bool, cantidad: Decimal, coste: Decimal, fx,
                   antiguedad: date | None = None, heredado: bool = False) -> None:
    """Añade una compra a los lotes o consume de los más antiguos una venta (FIFO).

    Un lote heredado de un canje neutral se coloca por su antigüedad, delante de
    los adquiridos después, igual que en el FIFO fiscal (`core.fifo`).
    """
    if not esVenta:
        if cantidad > 0:
            lote = {"cantidad": cantidad, "coste": coste, "fx": fx, "fecha": antiguedad}
            posicion = len(lotes)
            if heredado:
                posicion = next(
                    (i for i, existente in enumerate(lotes)
                     if existente.get("fecha") is not None and existente["fecha"] > antiguedad),
                    len(lotes),
                )
            lotes.insert(posicion, lote)
        return
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


def lotesVivos(filas, operaciones, esCripto: bool, ventas=(), hasta=None, transacciones=(), conversiones=(),
               moneda: str = "EUR", tipo=None) -> list:
    """Lotes de compra que siguen en cartera tras aplicar las ventas por FIFO.

    Cada lote es `{"cantidad", "coste", "fx", "fecha"}`: lo que queda de la
    compra, el coste bruto de esa parte, el tipo de cambio anotado en la compra
    (cadena vacía si no lo hay) y su fecha de adquisición (`date.max` si es
    ilegible). Las ventas consumen de los lotes más antiguos y, si
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
    lotes = []
    for fecha, _indice, *evento in _eventosOrdenados(
        filas, operaciones, esCripto, ventas, transacciones, conversiones, moneda, tipo
    ):
        if hasta is not None and fecha > hasta:
            continue
        _aplicarEvento(lotes, *evento)

    return [lote for lote in lotes if lote["cantidad"] > 0]


def posicionPorDias(filas, operaciones, esCripto: bool, ventas, dias: list, transacciones=(),
                    conversiones=(), moneda: str = "EUR", tipo=None) -> dict:
    """Cantidad y coste vivos de un activo en varios días, con una sola pasada FIFO.

    Equivale a llamar a `lotesVivos(..., hasta=dia)` por cada día y sumar sus
    lotes, pero ordena y aplica los eventos una vez en vez de rehacerlo entero
    por día: con N días y M eventos pasa de O(N·M) a O(N+M).

    Args:
        filas: Filas de `activo_rows`.
        operaciones: Filas de `activo_operation_rows` en estado Completado.
        esCripto: Si el activo es de tipo cripto.
        ventas: Filas de la tabla `ventas` del activo.
        dias: Días a evaluar (`date`), en cualquier orden. `None` pide la
            posición completa, incluidas las operaciones con fecha ilegible, que
            ningún día alcanza (igual que `lotesVivos` con `hasta=None`).
        transacciones: Filas de `transacciones` del activo.
        conversiones: Filas de `activo_conversion_rows` del activo.
        moneda: Divisa del activo, en la que sale el coste.
        tipo: Función `(desde, hacia) -> Decimal | None` con el cambio de hoy.

    Returns:
        `{dia: (cantidad, coste)}` con la suma de los lotes vivos ese día.
    """
    eventos = _eventosOrdenados(filas, operaciones, esCripto, ventas, transacciones, conversiones, moneda, tipo)
    lotes: list = []
    resultado = {}
    siguiente = 0

    def resumen() -> tuple:
        vivos = [lote for lote in lotes if lote["cantidad"] > 0]
        return sum((lote["cantidad"] for lote in vivos), CERO), sum((lote["coste"] for lote in vivos), CERO)

    for dia in sorted({d for d in dias if d is not None}):
        while siguiente < len(eventos) and eventos[siguiente][0] <= dia:
            _aplicarEvento(lotes, *eventos[siguiente][2:])
            siguiente += 1
        resultado[dia] = resumen()
    if None in dias:
        for evento in eventos[siguiente:]:
            _aplicarEvento(lotes, *evento[2:])
        resultado[None] = resumen()
    return resultado


# Lotes vivos por activo, para no recalcular el FIFO de todos los activos en cada
# petición (/api/activos y rendimiento-batch lo hacían entero cada vez). Vale
# mientras la foto de la base no cambie: cualquier alta, baja o edición de
# operaciones, ventas, transacciones o conversiones la invalida (ver
# core/cache_foto.py), sin engancharse a cada ruta de escritura.
_cacheLotes = CachePorFoto(maxEntradas=5000)


def lotesVivosCacheados(conn, assetId: str, filas, operaciones, esCripto: bool, ventas=(), transacciones=(),
                        conversiones=(), moneda: str = "EUR", tipo: Callable | None = None) -> list:
    """`lotesVivos` de la posición completa de un activo, memorizado mientras la base no cambie.

    Los tipos de cambio no están en la base que huella la caché (vienen de otra
    caché y del proveedor), así que cada entrada recuerda los pares que consultó
    y con qué valor; solo se reutiliza si `tipo` sigue dando lo mismo.

    Args:
        conn: Conexión de la que salieron las filas.
        assetId: Id del activo; con el tipo de activo y la divisa, la clave.
        filas: Filas de `activo_rows` del activo.
        operaciones: Filas de `activo_operation_rows` en estado Completado.
        esCripto: Si el activo es de tipo cripto.
        ventas: Filas de `ventas` del activo.
        transacciones: Filas de `transacciones` del activo.
        conversiones: Filas de `activo_conversion_rows` del activo.
        moneda: Divisa del activo.
        tipo: Función `(desde, hacia) -> Decimal | None`, o None si no se convierte.

    Returns:
        Los lotes vivos; son copias, el llamador puede modificarlos.
    """

    def calcular() -> tuple:
        cambios: dict = {}

        def tipoRegistrado(desde, hacia):
            cambio = tipo(desde, hacia)
            cambios[(desde, hacia)] = cambio
            return cambio

        lotes = lotesVivos(filas, operaciones, esCripto, ventas, None, transacciones, conversiones, moneda,
                           None if tipo is None else tipoRegistrado)
        return lotes, cambios

    def sigueVigente(cambios: dict) -> bool:
        return all(tipo(*par) == cambio for par, cambio in cambios.items())

    lotes = _cacheLotes.obtener(conn, (assetId, esCripto, moneda, tipo is None), calcular, sigueVigente)
    return [dict(lote) for lote in lotes]


def calcular(filas, operaciones, esCripto: bool, precio, ventas=(), transacciones=(), conversiones=(),
             moneda: str = "EUR", tipo=None, vivos=None) -> Totales:
    """Totales a partir de las filas del activo y sus operaciones completadas.

    `filas` son filas de `activo_rows` (tipo_operacion, participaciones,
    capital_invertido_bruto, comisiones, comisiones_fiat, y opcionalmente
    fecha_operacion y comisiones_cripto) y `operaciones` de
    `activo_operation_rows` en estado Completado (orden, cantidad,
    comisiones_cripto, total, y opcionalmente fecha_apertura). Sirven
    `sqlite3.Row` o diccionarios.

    El invertido es el coste de lo que sigue en cartera: las ventas retiran el
    coste FIFO de lo vendido, no solo las participaciones.

    `vivos` son los lotes ya calculados (ver `lotesVivosCacheados`); sin ellos
    se calculan aquí.
    """
    if vivos is None:
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


@dataclass
class ComprasDelAnio:
    """Lo que entró en cartera un año y lo que queda de ello hoy, en la divisa del activo.

    Attributes:
        cantidadComprada: Participaciones que entraron ese año (netas de la
            comisión en cripto, como el lote que crean).
        costeComprado: Coste bruto de todo lo que entró ese año.
        cantidadViva: Participaciones de esas entradas que siguen en cartera.
        costeVivo: Coste bruto de la parte que sigue en cartera.
    """

    cantidadComprada: Decimal = CERO
    costeComprado: Decimal = CERO
    cantidadViva: Decimal = CERO
    costeVivo: Decimal = CERO


def comprasPorAnio(filas, operaciones, esCripto: bool, ventas=(), transacciones=(), conversiones=(),
                   moneda: str = "EUR", tipo=None) -> dict[int, ComprasDelAnio]:
    """Entradas de un activo agrupadas por su año de adquisición y lo que queda de cada una.

    Recorre los mismos eventos y el mismo FIFO que `lotesVivos`, así que la suma
    de `costeVivo` de todos los años es el invertido bruto de la ficha. El año es
    el de la antigüedad del lote: los títulos recibidos en un canje neutral
    cuentan en el año de los entregados, como en el FIFO fiscal.

    Args:
        filas: Filas de `activo_rows`.
        operaciones: Filas de `activo_operation_rows` en estado Completado.
        esCripto: Si el activo es de tipo cripto.
        ventas: Filas de `ventas` del activo.
        transacciones: Filas de `transacciones` del activo.
        conversiones: Filas de `activo_conversion_rows` del activo.
        moneda: Divisa del activo, en la que sale el coste.
        tipo: Función `(desde, hacia) -> Decimal | None` con el cambio de hoy.

    Returns:
        `{anio: ComprasDelAnio}`. Las entradas con fecha ilegible se aplican al
        FIFO (consumen y son consumidas) pero no aparecen: no tienen año.
    """
    lotes: list = []
    for _fecha, _indice, *evento in _eventosOrdenados(
        filas, operaciones, esCripto, ventas, transacciones, conversiones, moneda, tipo
    ):
        _aplicarEvento(lotes, *evento)
        # `_aplicarEvento` puede colocar el lote nuevo en cualquier posición (los
        # heredados van por antigüedad), así que se reconoce por no tener aún la
        # marca de lo comprado en lugar de por su índice.
        for lote in lotes:
            if "cantidadComprada" not in lote:
                lote["cantidadComprada"] = lote["cantidad"]
                lote["costeComprado"] = lote["coste"]

    porAnio: dict[int, ComprasDelAnio] = {}
    for lote in lotes:
        fecha = lote.get("fecha")
        if fecha is None or fecha == date.max:
            continue
        anio = porAnio.setdefault(fecha.year, ComprasDelAnio())
        anio.cantidadComprada += lote["cantidadComprada"]
        anio.costeComprado += lote["costeComprado"]
        anio.cantidadViva += max(CERO, lote["cantidad"])
        anio.costeVivo += max(CERO, lote["coste"]) if lote["cantidad"] > 0 else CERO
    return porAnio
