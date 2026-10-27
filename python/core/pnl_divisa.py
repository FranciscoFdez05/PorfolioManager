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
    efectoActivo: Decimal = Decimal("0")
    efectoDivisa: Decimal = Decimal("0")
    # Parte del efecto divisa que viene del término cruzado (la divisa aplicada
    # a la revalorización, no al capital inicial). Informativo: ya está incluido
    # dentro de `efecto_divisa`, no se suma aparte.
    terminoCruzado: Decimal = Decimal("0")
    # Invertido y valor actual, ambos convertidos a euros con su propio tipo.
    invertidoEur: Decimal = Decimal("0")
    valorEur: Decimal = Decimal("0")
    # False cuando faltó algún tipo de cambio histórico y se cayó al actual: el
    # desglose sigue cuadrando, pero el reparto entre los dos efectos es una
    # aproximación y la pantalla debe decirlo.
    completo: bool = True

    def comoDict(self, escala=CENTIMO):
        def _q(valor):
            return f"{valor.quantize(escala)}"

        return {
            "total": _q(self.total),
            "efectoActivo": _q(self.efectoActivo),
            "efectoDivisa": _q(self.efectoDivisa),
            "terminoCruzado": _q(self.terminoCruzado),
            "invertidoEur": _q(self.invertidoEur),
            "valorEur": _q(self.valorEur),
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


def descomponer(invertido, valorActual, fxCompra, fxActual, completo=True):
    """Descompone **una** posición homogénea (un solo tipo de cambio de entrada).

    `invertido` y `valor_actual` van en la divisa del activo; `fx_compra` y
    `fx_actual`, en euros por unidad de esa divisa. Para un activo ya
    denominado en euros ambos tipos valen 1 y el efecto divisa sale cero, que es
    lo correcto y evita tener que llamar a esto solo para los extranjeros.
    """
    v0 = _dec(invertido)
    v1 = _dec(valorActual)
    r0 = _dec(fxCompra, Decimal("1"))
    r1 = _dec(fxActual, Decimal("1"))
    # Sin tipo actual se valora a 1, y presentarlo como completo inventaría un
    # efecto divisa: el desglose queda marcado como aproximado.
    if fxActual is None or str(fxActual).strip() == "":
        completo = False

    # Un tipo de cambio de cero o negativo no existe; tomarlo al pie de la letra
    # daría una posición valorada en cero sin ninguna señal de que algo va mal.
    if r0 <= 0:
        r0 = Decimal("1")
        completo = False
    if r1 <= 0:
        r1 = Decimal("1")
        completo = False

    invertidoEur = v0 * r0
    valorEur = v1 * r1

    return Descomposicion(
        total=valorEur - invertidoEur,
        efectoActivo=(v1 - v0) * r0,
        efectoDivisa=v1 * (r1 - r0),
        terminoCruzado=(v1 - v0) * (r1 - r0),
        invertidoEur=invertidoEur,
        valorEur=valorEur,
        completo=completo,
    )


def descomponerLotes(lotes, fxActual, completo=True):
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
    total = efectoActivo = efectoDivisa = Decimal("0")
    cruzado = invertidoEur = valorEur = Decimal("0")

    if fxActual is None or str(fxActual).strip() == "" or _dec(fxActual) <= 0:
        completo = False

    for lote in lotes:
        fxCompra = lote.get("fxCompra")
        loteCompleto = bool(fxCompra) and _dec(fxCompra) > 0
        if not loteCompleto:
            fxCompra = fxActual
            completo = False

        parcial = descomponer(
            lote.get("invertido"), lote.get("valorActual"),
            fxCompra, fxActual, completo=loteCompleto,
        )
        total += parcial.total
        efectoActivo += parcial.efectoActivo
        efectoDivisa += parcial.efectoDivisa
        cruzado += parcial.terminoCruzado
        invertidoEur += parcial.invertidoEur
        valorEur += parcial.valorEur

    return Descomposicion(
        total=total,
        efectoActivo=efectoActivo,
        efectoDivisa=efectoDivisa,
        terminoCruzado=cruzado,
        invertidoEur=invertidoEur,
        valorEur=valorEur,
        completo=completo,
    )
