"""Resumen de una cartera en texto: para `/cartera` y para el resumen diario.

Las cifras salen de `valorar_portfolio`, el mismo cálculo que guarda los puntos
del histórico, así que lo que cuenta Telegram coincide con lo que dibuja el
gráfico de evolución. Trabaja sobre la base de datos activa del hilo; quien
quiera otra cartera lo envuelve en `core.db.use_db_path`.
"""

import time

from core import dinero
from core.db import get_db
from stores import alertas_store
from stores.valoracion import valorar_portfolio

_DIA = 86400


def _euros(numero) -> str:
    return f"{dinero.aTextoEs(numero, decimales=2)} €"


def _con_signo(numero, sufijo="") -> str:
    valor = dinero.aDecimal(numero)
    signo = "+" if valor > 0 else ("-" if valor < 0 else "")
    return f"{signo}{dinero.aTextoEs(abs(valor), decimales=2)}{sufijo}"


def _valor_de_hace_un_dia():
    """Valor de la cartera en el último punto del histórico anterior a hace 24 h."""
    fila = get_db().execute(
        "SELECT total_value FROM portfolio_snapshots WHERE ts <= ? ORDER BY ts DESC LIMIT 1",
        (int(time.time()) - _DIA,),
    ).fetchone()
    return None if fila is None else fila[0]


def calcular(refrescar_precios=True) -> dict:
    """Valor, invertido, resultado y variación a 24 h de la cartera activa."""
    valoracion = valorar_portfolio(refrescar_precios=refrescar_precios)
    valor = dinero.aDecimal(valoracion["total_value"])
    invertido = dinero.aDecimal(valoracion["total_invested"])
    resultado = valor - invertido

    antes = _valor_de_hace_un_dia()
    variacion_dia = None
    if antes:
        antes = dinero.aDecimal(antes)
        if antes > 0:
            variacion_dia = (valor - antes, (valor - antes) / antes * 100)

    return {
        "valor": valor,
        "invertido": invertido,
        "resultado": resultado,
        "resultadoPct": (resultado / invertido * 100) if invertido > 0 else None,
        "variacionDia": variacion_dia,
        "activos": valoracion["activos"],
        "preciosFrescos": valoracion["precios_frescos"],
        "alertasActivas": alertas_store.contar_activas(),
    }


def formatear(nombre, datos) -> str:
    if not datos["activos"]:
        return f"📊 {nombre}\nSin posiciones abiertas."

    lineas = [
        f"📊 {nombre}",
        f"Valor: {_euros(datos['valor'])}",
        f"Invertido: {_euros(datos['invertido'])}",
    ]
    resultado = f"Resultado: {_con_signo(datos['resultado'], ' €')}"
    if datos["resultadoPct"] is not None:
        resultado += f" ({_con_signo(datos['resultadoPct'], ' %')})"
    lineas.append(resultado)

    if datos["variacionDia"] is not None:
        importe, porcentaje = datos["variacionDia"]
        lineas.append(f"24 h: {_con_signo(importe, ' €')} ({_con_signo(porcentaje, ' %')})")

    lineas.append(f"Posiciones: {datos['activos']}")
    if datos["alertasActivas"]:
        lineas.append(f"Alertas de precio activas: {datos['alertasActivas']}")
    return "\n".join(lineas)
