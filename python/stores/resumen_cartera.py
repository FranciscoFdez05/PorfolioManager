"""Resumen de una cartera en texto: para `/cartera` y para el resumen diario.

Las cifras salen de `valorarPortfolio`, el mismo cálculo que guarda los puntos
del histórico, así que lo que cuenta Telegram coincide con lo que dibuja el
gráfico de evolución. Trabaja sobre la base de datos activa del hilo; quien
quiera otra cartera lo envuelve en `core.db.useDbPath`.
"""

import time

from core import dinero
from core.db import getDb
from stores import alertas_store
from stores.valoracion import valorarPortfolio

_DIA = 86400


def _euros(numero) -> str:
    return f"{dinero.aTextoEs(numero, decimales=2)} €"


def _conSigno(numero, sufijo="") -> str:
    valor = dinero.aDecimal(numero)
    signo = "+" if valor > 0 else ("-" if valor < 0 else "")
    return f"{signo}{dinero.aTextoEs(abs(valor), decimales=2)}{sufijo}"


def _valorDeHaceUnDia():
    """Valor de la cartera en el último punto del histórico anterior a hace 24 h."""
    fila = getDb().execute(
        "SELECT total_value FROM portfolio_snapshots WHERE ts <= ? ORDER BY ts DESC LIMIT 1",
        (int(time.time()) - _DIA,),
    ).fetchone()
    return None if fila is None else fila[0]


def calcular(refrescarPrecios=True) -> dict:
    """Valor, invertido, resultado y variación a 24 h de la cartera activa."""
    valoracion = valorarPortfolio(refrescarPrecios=refrescarPrecios)
    valor = dinero.aDecimal(valoracion["total_value"])
    invertido = dinero.aDecimal(valoracion["total_invested"])
    resultado = valor - invertido

    antes = _valorDeHaceUnDia()
    variacionDia = None
    if antes:
        antes = dinero.aDecimal(antes)
        if antes > 0:
            variacionDia = (valor - antes, (valor - antes) / antes * 100)

    return {
        "valor": valor,
        "invertido": invertido,
        "resultado": resultado,
        "resultadoPct": (resultado / invertido * 100) if invertido > 0 else None,
        "variacionDia": variacionDia,
        "activos": valoracion["activos"],
        "preciosFrescos": valoracion["precios_frescos"],
        "alertasActivas": alertas_store.contarActivas(),
    }


def formatear(nombre, datos) -> str:
    if not datos["activos"]:
        return f"📊 {nombre}\nSin posiciones abiertas."

    lineas = [
        f"📊 {nombre}",
        f"Valor: {_euros(datos['valor'])}",
        f"Invertido: {_euros(datos['invertido'])}",
    ]
    resultado = f"Resultado: {_conSigno(datos['resultado'], ' €')}"
    if datos["resultadoPct"] is not None:
        resultado += f" ({_conSigno(datos['resultadoPct'], ' %')})"
    lineas.append(resultado)

    if datos["variacionDia"] is not None:
        importe, porcentaje = datos["variacionDia"]
        lineas.append(f"24 h: {_conSigno(importe, ' €')} ({_conSigno(porcentaje, ' %')})")

    lineas.append(f"Posiciones: {datos['activos']}")
    if datos["alertasActivas"]:
        lineas.append(f"Alertas de precio activas: {datos['alertasActivas']}")
    return "\n".join(lineas)
