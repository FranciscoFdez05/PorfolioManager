"""Reglas de alerta: catálogo de tipos, validación y persistencia.

Las alertas de precio de siempre («avísame cuando llegue a X») viven en
`stores.alertas_store` y saltan una sola vez. Este módulo guarda las demás,
que siguen vigilando después de avisar:

  * **Movimiento** — caída o subida brusca de un activo, o caída del valor de
    la cartera, en una ventana de tiempo. Se miden desde el máximo (o el
    mínimo) de la ventana y, tras un aviso, desde ese aviso.
  * **Nivel** — rentabilidad de la posición, precio frente al precio medio,
    sin cotización, valor total de la cartera y peso de un activo. Avisan al
    **entrar** en la condición y no repiten hasta que salen de ella y vuelven a
    entrar, con un enfriamiento mínimo entre avisos.

El catálogo (`tipos`) es la única definición de qué admite cada tipo: valida
lo que llega por HTTP y se envía tal cual al navegador para montar el
formulario, de modo que la interfaz y el servidor no pueden divergir. La
evaluación vive en `stores.reglas_alerta_motor`.
"""

import time
from dataclasses import asdict, dataclass, field
from decimal import Decimal

from core import dinero
from core.db import getDb

claveCartera = "*cartera*"

ventanasMovimiento = (15, 60, 240, 1440)
ventanasCartera = (60, 240, 1440)
duracionesSinCotizacion = (60, 180, 360, 720, 1440)
enfriamientosPermitidos = (15, 60, 240, 720, 1440)
ventanaMaximaSegundos = max(ventanasMovimiento + ventanasCartera + duracionesSinCotizacion) * 60

maxNota = 200
valorMaximo = Decimal("1000000000")
porcentajeTope = Decimal("100")


@dataclass(frozen=True)
class TipoRegla:
    """Qué admite un tipo de regla y cómo se presenta.

    Attributes:
        clave: identificador guardado en `alertas_reglas.tipo`.
        etiqueta: nombre que enseña la interfaz.
        grupo: familia en la interfaz y en el filtro.
        familia: "movimiento" (ventana desde el último aviso) o "nivel"
            (avisa al entrar en la condición).
        ambito: "activo" (un activo, o todos con posición si no se elige) o
            "cartera" (nunca lleva activo).
        fuente: "cotizacion" (se evalúa con la cotización de cada activo) o
            "valoracion" (con la valoración de la cartera entera).
        categoriaAviso: categoría de `core.telegram_notifier` con la que avisa.
        unidades: unidades admitidas; la primera es la de defecto.
        sentidos: {sentido: texto}; vacío si el tipo no tiene sentido.
        ventanas: minutos admitidos en `ventana_min`; vacío si no usa ventana.
        etiquetaVentana: texto del campo de la ventana en la interfaz.
        usaValor: False si el tipo no tiene umbral (sin cotización).
        necesitaPosicion: solo se evalúa sobre activos con posición viva.
    """

    clave: str
    etiqueta: str
    grupo: str
    familia: str
    ambito: str
    fuente: str
    categoriaAviso: str
    unidades: tuple = ("%",)
    sentidos: dict = field(default_factory=dict)
    ventanas: tuple = ()
    etiquetaVentana: str = ""
    usaValor: bool = True
    necesitaPosicion: bool = False


tipos = {
    t.clave: t for t in (
        TipoRegla("caida", "Caída brusca", "Movimiento", "movimiento", "activo", "cotizacion", "movimientos",
                  ventanas=ventanasMovimiento, etiquetaVentana="En menos de"),
        TipoRegla("subida", "Subida brusca", "Movimiento", "movimiento", "activo", "cotizacion", "movimientos",
                  ventanas=ventanasMovimiento, etiquetaVentana="En menos de"),
        TipoRegla("rentabilidad", "Rentabilidad de la posición", "Posición", "nivel", "activo", "cotizacion",
                  "posicion", unidades=("%", "EUR"),
                  sentidos={"arriba": "Ganancia de al menos", "abajo": "Pérdida de al menos"},
                  necesitaPosicion=True),
        TipoRegla("precio_medio", "Precio frente a tu precio medio", "Posición", "nivel", "activo", "cotizacion",
                  "posicion",
                  sentidos={"abajo": "Por debajo del precio medio un", "arriba": "Por encima del precio medio un"},
                  necesitaPosicion=True),
        TipoRegla("sin_cotizacion", "Sin cotización", "Cotización", "nivel", "activo", "cotizacion", "proveedores",
                  unidades=(), ventanas=duracionesSinCotizacion, etiquetaVentana="Durante más de",
                  usaValor=False),
        TipoRegla("cartera_valor", "Valor total de la cartera", "Cartera", "nivel", "cartera", "valoracion",
                  "cartera", unidades=("EUR",), sentidos={"abajo": "Baja de", "arriba": "Sube de"}),
        TipoRegla("cartera_caida", "Caída de la cartera", "Cartera", "movimiento", "cartera", "valoracion",
                  "cartera", ventanas=ventanasCartera, etiquetaVentana="En menos de"),
        TipoRegla("peso", "Peso de un activo en la cartera", "Cartera", "nivel", "activo", "valoracion",
                  "cartera", sentidos={"arriba": "Supera el"}, necesitaPosicion=True),
    )
}


class ReglaInvalida(ValueError):
    """La regla que se intenta crear no tiene sentido."""


def catalogo() -> list:
    """Los tipos como dicts serializables, en el orden en que se presentan."""
    return [asdict(t) for t in tipos.values()]


# ── Validación ────────────────────────────────────────────────────────────────

def _limiteDe(tipo: TipoRegla, sentido: str, unidad: str) -> Decimal:
    """Máximo admitido: una caída o una pérdida en % no pueden llegar al 100 %."""
    if unidad == "%" and (tipo.clave in ("caida", "cartera_caida", "peso") or sentido == "abajo"):
        return porcentajeTope
    return valorMaximo


def _validarValor(tipo: TipoRegla, sentido: str, unidad: str, valor) -> str:
    if not tipo.usaValor:
        return ""
    try:
        numero = dinero.aDecimal(valor, "valor")
    except dinero.ImporteInvalido:
        raise ReglaInvalida("El valor de la alerta no es un número válido") from None
    limite = _limiteDe(tipo, sentido, unidad)
    if numero <= 0 or numero >= limite:
        raise ReglaInvalida(f"El valor tiene que ser mayor que 0 y menor que {dinero.aTextoEs(limite, decimales=0)}")
    return dinero.aTexto(numero)


def _validarOpcion(valor, permitidos, nombre: str, defecto=None):
    if not permitidos:
        return defecto
    if valor in (None, "") and defecto is not None:
        return defecto
    if valor not in permitidos:
        raise ReglaInvalida(f"{nombre} no permitido")
    return valor


def _validarMinutos(valor, permitidos, nombre: str) -> int:
    if not permitidos:
        return 0
    try:
        minutos = int(valor)
    except (TypeError, ValueError):
        raise ReglaInvalida(f"{nombre} no válido") from None
    if minutos not in permitidos:
        raise ReglaInvalida(f"{nombre} no permitido")
    return minutos


def _validarActivo(conn, tipo: TipoRegla, assetId) -> str | None:
    activoId = str(assetId or "").strip() or None
    if tipo.ambito == "cartera":
        if activoId:
            raise ReglaInvalida("Este tipo de alerta es de toda la cartera y no lleva activo")
        return None
    if activoId and conn.execute("SELECT 1 FROM activos WHERE id = ?", (activoId,)).fetchone() is None:
        raise ReglaInvalida("Activo no encontrado")
    return activoId


# ── Persistencia ──────────────────────────────────────────────────────────────

_columnas = (
    "r.id, r.tipo, r.asset_id, r.sentido, r.unidad, r.valor, r.ventana_min, r.enfriamiento_min, r.nota, "
    "r.activa, r.creada_ts, a.name AS activo_nombre, a.symbol AS activo_simbolo, a.currency AS activo_moneda"
)
_desde = "FROM alertas_reglas r LEFT JOIN activos a ON a.id = r.asset_id"


def comoDict(fila) -> dict:
    """Una fila de `alertas_reglas` (con el JOIN de `_columnas`) para la API."""
    return {
        "id": fila["id"],
        "tipo": fila["tipo"],
        "assetId": fila["asset_id"],
        "activoNombre": fila["activo_nombre"] or "",
        "activoSimbolo": fila["activo_simbolo"] or "",
        "activoMoneda": fila["activo_moneda"] or "",
        "sentido": fila["sentido"],
        "unidad": fila["unidad"],
        "valor": fila["valor"],
        "ventanaMin": fila["ventana_min"],
        "enfriamientoMin": fila["enfriamiento_min"],
        "nota": fila["nota"],
        "activa": bool(fila["activa"]),
        "creada": fila["creada_ts"],
    }


def listar(assetId=None, incluirGenerales: bool = False) -> list:
    """Reglas, las activas primero.

    Args:
        assetId: solo las de este activo; None para todas.
        incluirGenerales: con `assetId`, añade también las reglas sin activo
            de tipos por activo, que también lo vigilan.
    """
    consulta = f"SELECT {_columnas} {_desde}"
    parametros: tuple = ()
    if assetId:
        consulta += " WHERE r.asset_id = ?"
        parametros = (assetId,)
        if incluirGenerales:
            porActivo = [t.clave for t in tipos.values() if t.ambito == "activo"]
            consulta += f" OR (r.asset_id IS NULL AND r.tipo IN ({','.join('?' * len(porActivo))}))"
            parametros += tuple(porActivo)
    consulta += " ORDER BY r.activa DESC, r.id"
    return [comoDict(f) for f in getDb().execute(consulta, parametros).fetchall()]


def activas(conn=None) -> list:
    """Filas de las reglas activas, para el motor."""
    conn = conn or getDb()
    return conn.execute(f"SELECT {_columnas} {_desde} WHERE r.activa = 1 ORDER BY r.id").fetchall()


def contarActivas() -> int:
    """Número de reglas activas en el portfolio abierto."""
    return getDb().execute("SELECT COUNT(*) FROM alertas_reglas WHERE activa = 1").fetchone()[0]


def crear(tipo, assetId=None, sentido="", unidad="", valor=None, ventanaMin=None, enfriamientoMin=None,
          nota="") -> dict:
    """Crea una regla activa.

    Args:
        tipo: clave de `tipos`.
        assetId: activo concreto; vacío en un tipo por activo = todos con posición.
        sentido: uno de `tipos[tipo].sentidos`, si el tipo los tiene.
        unidad: una de `tipos[tipo].unidades`; vacío = la primera.
        valor: umbral (texto o número, coma o punto decimal).
        ventanaMin: minutos de la ventana o duración, si el tipo la usa.
        enfriamientoMin: minutos mínimos entre dos avisos de lo mismo.
        nota: texto libre opcional.

    Returns:
        La regla creada, con el formato de `listar`.

    Raises:
        ReglaInvalida: si algún valor no tiene sentido o el activo no existe.

    Example:
        >>> crear("caida", None, valor="5", ventanaMin=60, enfriamientoMin=240)["tipo"]
        'caida'
    """
    definicion = tipos.get(str(tipo or ""))
    if definicion is None:
        raise ReglaInvalida("Tipo de alerta desconocido")

    sentidoValido = _validarOpcion(sentido or None, tuple(definicion.sentidos), "Sentido",
                                   defecto=next(iter(definicion.sentidos), None)) or ""
    unidadValida = _validarOpcion(unidad or None, definicion.unidades, "Unidad",
                                  defecto=definicion.unidades[0] if definicion.unidades else None) or ""
    valorTexto = _validarValor(definicion, sentidoValido, unidadValida, valor)
    ventana = _validarMinutos(ventanaMin, definicion.ventanas, "Ventana")
    enfriamiento = _validarMinutos(enfriamientoMin, enfriamientosPermitidos, "Enfriamiento")

    conn = getDb()
    activoId = _validarActivo(conn, definicion, assetId)
    cursor = conn.execute(
        "INSERT INTO alertas_reglas (tipo, asset_id, sentido, unidad, valor, ventana_min, enfriamiento_min, "
        "nota, activa, creada_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
        (definicion.clave, activoId, sentidoValido, unidadValida, valorTexto, ventana, enfriamiento,
         str(nota or "").strip()[:maxNota], int(time.time())),
    )
    conn.commit()
    return comoDict(conn.execute(f"SELECT {_columnas} {_desde} WHERE r.id = ?", (cursor.lastrowid,)).fetchone())


def borrar(reglaId) -> bool:
    """Borra una regla y, en cascada, sus avisos. False si no existía."""
    conn = getDb()
    borradas = conn.execute("DELETE FROM alertas_reglas WHERE id = ?", (reglaId,)).rowcount
    conn.commit()
    return borradas > 0


def cambiarEstado(reglaId, activa: bool) -> bool:
    """Activa o pausa una regla. False si no existía.

    Reactivar no borra los avisos anteriores: el enfriamiento sigue contando
    desde el último, para que pausar y reactivar no sirva para repetirlo.
    """
    conn = getDb()
    cambiadas = conn.execute(
        "UPDATE alertas_reglas SET activa = ? WHERE id = ?", (1 if activa else 0, reglaId)
    ).rowcount
    conn.commit()
    return cambiadas > 0


def ultimosAvisos(limite: int = 30) -> list:
    """Los avisos más recientes de todas las reglas, el último primero."""
    filas = getDb().execute(
        "SELECT v.regla_id, v.clave, v.avisada_ts, v.valor, v.detalle, r.tipo, a.name, a.symbol "
        "FROM alertas_reglas_avisos v "
        "JOIN alertas_reglas r ON r.id = v.regla_id "
        "LEFT JOIN activos a ON a.id = v.clave "
        "WHERE v.avisada_ts > 0 "
        "ORDER BY v.avisada_ts DESC LIMIT ?",
        (int(limite),),
    ).fetchall()
    return [{
        "reglaId": f["regla_id"],
        "tipo": f["tipo"],
        "assetId": None if f["clave"] == claveCartera else f["clave"],
        "activoNombre": f["name"] or ("" if f["clave"] == claveCartera else f["clave"]),
        "activoSimbolo": f["symbol"] or "",
        "avisada": f["avisada_ts"],
        "valor": f["valor"],
        "detalle": f["detalle"],
    } for f in filas]


def activosSeleccionables() -> list:
    """Activos con símbolo de mercado: los únicos de los que se puede pedir cotización."""
    filas = getDb().execute(
        "SELECT id, name, symbol, currency FROM activos "
        "WHERE TRIM(market_symbol) <> '' OR TRIM(finnhub_symbol) <> '' "
        "ORDER BY sort_order, name"
    ).fetchall()
    return [{"id": f["id"], "name": f["name"] or f["id"], "symbol": f["symbol"], "currency": f["currency"]}
            for f in filas]
