"""Descomposición del resultado en efecto activo y efecto divisa.

El problema que resuelve: hoy un activo comprado en dólares muestra un único
número de rendimiento en euros, y ese número mezcla dos cosas que no tienen
nada que ver. Si compraste por 1.000 USD con el euro a 1,10 y hoy valen
1.200 USD con el euro a 1,05, ganas en euros por dos motivos distintos —el
activo subió y el dólar se apreció— y el número agregado no permite saber cuál
de los dos hizo el trabajo. Para decidir si una posición está funcionando eso
es justo lo que hace falta separar.

La descomposición, con V₀ y V₁ los importes en la divisa del activo y r₀ y r₁
los tipos de cambio a euros del día de la compra y de hoy:

    resultado total   = V₁*r₁ - V₀*r₀
    efecto activo     = (V₁ - V₀)*r₀      <- lo que hizo el activo, al tipo de
                                            cambio del día en que se compró
    efecto divisa     = V₁*(r₁ - r₀)      <- lo que hizo la divisa, sobre la
                                            posición que hay hoy

Y suman exactamente el total:

    (V₁ - V₀)*r₀ + V₁*(r₁ - r₀) = V₁*r₀ - V₀*r₀ + V₁*r₁ - V₁*r₀ = V₁*r₁ - V₀*r₀

La igualdad no es un detalle estético: significa que el desglose no inventa ni
pierde un céntimo respecto al resultado que ya se venía mostrando, así que se
puede enseñar al lado sin que las dos cifras se contradigan.

**Por qué esta atribución y no otra.** El reparto de un producto de dos
factores entre sus factores no es único (es el mismo problema que la
descomposición de Laspeyres/Paasche en números índice). La alternativa
simétrica sería `efecto activo = (V₁ - V₀)*r₁` y `efecto divisa = V₀*(r₁ - r₀)`,
igual de válida aritméticamente. Se elige la de arriba porque responde a la
pregunta que se hace quien mira la pantalla: "de lo que llevo ganado, ¿cuánto
es del activo?" —y eso se contesta valorando el recorrido del activo al tipo al
que se entró, que es el que se aceptó al comprar. El término cruzado
(V₁-V₀)*(r₁-r₀) queda dentro del efecto divisa, y se expone aparte para quien
quiera verlo.

Todo en Decimal: son importes de dinero y el binario de float introduce
diferencias que luego no cuadran contra el total ya publicado.
"""

from dataclasses import dataclass
from decimal import Decimal

from core import dinero

CENTIMO = Decimal("0.01")


@dataclass(frozen=True)
class Descomposicion:
    """Resultado de una posición, separado por su origen. Todo en euros."""

    total: Decimal = Decimal("0")
    efecto_activo: Decimal = Decimal("0")
    efecto_divisa: Decimal = Decimal("0")
    # Parte del efecto divisa que viene del término cruzado (la divisa aplicada
    # a la revalorización, no al capital inicial). Informativo: ya está incluido
    # dentro de `efecto_divisa`, no se suma aparte.
    termino_cruzado: Decimal = Decimal("0")
    # Invertido y valor actual, ambos convertidos a euros con su propio tipo.
    invertido_eur: Decimal = Decimal("0")
    valor_eur: Decimal = Decimal("0")
    # False cuando faltó algún tipo de cambio histórico y se cayó al actual: el
    # desglose sigue cuadrando, pero el reparto entre los dos efectos es una
    # aproximación y la pantalla debe decirlo.
    completo: bool = True

    def como_dict(self, escala=CENTIMO):
        def _q(valor):
            return f"{valor.quantize(escala)}"

        return {
            "total": _q(self.total),
            "efectoActivo": _q(self.efecto_activo),
            "efectoDivisa": _q(self.efecto_divisa),
            "terminoCruzado": _q(self.termino_cruzado),
            "invertidoEur": _q(self.invertido_eur),
            "valorEur": _q(self.valor_eur),
            "completo": self.completo,
        }


def _dec(valor, defecto=Decimal("0")):
    """Decimal tolerante. La conversión es la de `core.dinero`, no otra.

    Hacía `Decimal(str(valor))`, que devuelve cero ante un importe en formato
    español. Aquí eso era especialmente delicado: un `fxCompra` degradado a
    cero no revienta, se cuela como "tipo de cambio desconocido" y el efecto
    divisa del lote sale anulado sin que nada lo indique.
    """
    return dinero.aDecimal(valor, defecto=defecto)


def descomponer(invertido, valor_actual, fx_compra, fx_actual, completo=True):
    """Descompone **una** posición homogénea (un solo tipo de cambio de entrada).

    `invertido` y `valor_actual` van en la divisa del activo; `fx_compra` y
    `fx_actual`, en euros por unidad de esa divisa. Para un activo ya
    denominado en euros ambos tipos valen 1 y el efecto divisa sale cero, que es
    lo correcto y evita tener que llamar a esto solo para los extranjeros.
    """
    v0 = _dec(invertido)
    v1 = _dec(valor_actual)
    r0 = _dec(fx_compra, Decimal("1"))
    r1 = _dec(fx_actual, Decimal("1"))

    # Un tipo de cambio de cero o negativo no existe; tomarlo al pie de la letra
    # daría una posición valorada en cero sin ninguna señal de que algo va mal.
    if r0 <= 0:
        r0 = Decimal("1")
        completo = False
    if r1 <= 0:
        r1 = Decimal("1")
        completo = False

    invertido_eur = v0 * r0
    valor_eur = v1 * r1

    return Descomposicion(
        total=valor_eur - invertido_eur,
        efecto_activo=(v1 - v0) * r0,
        efecto_divisa=v1 * (r1 - r0),
        termino_cruzado=(v1 - v0) * (r1 - r0),
        invertido_eur=invertido_eur,
        valor_eur=valor_eur,
        completo=completo,
    )


def descomponer_lotes(lotes, fx_actual, completo=True):
    """Agrega la descomposición de varias compras con tipos de cambio distintos.

    Un activo normal no se compra de una vez: son varias entradas, cada una con
    su tipo de cambio. Aplicar un único tipo medio a todo el invertido daría un
    efecto divisa que no corresponde a ninguna operación real, así que cada lote
    se descompone con **su** tipo y luego se suman los efectos. Como cada
    descomposición cuadra por separado, la suma también cuadra.

    `lotes` es un iterable de dicts con `invertido`, `valorActual` y `fxCompra`.
    Un lote sin tipo de cambio conocido usa el actual, lo que anula su efecto
    divisa, y marca el conjunto como incompleto.
    """
    total = efecto_activo = efecto_divisa = Decimal("0")
    cruzado = invertido_eur = valor_eur = Decimal("0")

    for lote in lotes:
        fx_compra = lote.get("fxCompra")
        lote_completo = bool(fx_compra) and _dec(fx_compra) > 0
        if not lote_completo:
            fx_compra = fx_actual
            completo = False

        parcial = descomponer(
            lote.get("invertido"), lote.get("valorActual"),
            fx_compra, fx_actual, completo=lote_completo,
        )
        total += parcial.total
        efecto_activo += parcial.efecto_activo
        efecto_divisa += parcial.efecto_divisa
        cruzado += parcial.termino_cruzado
        invertido_eur += parcial.invertido_eur
        valor_eur += parcial.valor_eur

    return Descomposicion(
        total=total,
        efecto_activo=efecto_activo,
        efecto_divisa=efecto_divisa,
        termino_cruzado=cruzado,
        invertido_eur=invertido_eur,
        valor_eur=valor_eur,
        completo=completo,
    )
