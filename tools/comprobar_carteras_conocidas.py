#!/usr/bin/env python3
"""Comprueba contra la red las direcciones del catálogo de carteras conocidas.

Los exchanges cambian de direcciones y el catálogo de serie es una copia hecha a
mano de fuentes abiertas, sin un formato común del que regenerarlo. Esto no lo
actualiza: lee el saldo de cada dirección y lista las que han quedado a cero o no
se han podido leer, para decidir a mano si quitarlas. No escribe nada.

Una dirección a cero no tiene por qué estar mal: una caliente se vacía a menudo,
y las de una entidad ya cerrada o de un hackeo pueden seguir en el catálogo con
sentido. Es un motivo para mirarla, no para borrarla.

Uso (desde la raíz del proyecto, con el entorno virtual):
    python tools/comprobar_carteras_conocidas.py --entidad bitvavo --red btc
"""

import argparse
import logging
import sys
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from providers.blockchain_clients import ErrorLecturaWallet, lectorPara
from stores.carteras_conocidas_store import CarteraConocida, leerCatalogoBase

log = logging.getLogger("comprobar_carteras")


@dataclass(frozen=True)
class Revision:
    """Resultado de leer una dirección del catálogo: `saldo` None si no se pudo."""

    entidad: str
    red: str
    valor: str
    saldo: Decimal | None
    error: str = ""


def revisar(entidades: Iterable[CarteraConocida], red: str = "",
            leerSaldo: Callable[[str, str, str], Decimal] | None = None) -> list[Revision]:
    """Lee el saldo de cada dirección de `entidades`, de una en una.

    Args:
        entidades: Entidades del catálogo.
        red: Si viene, solo las direcciones de esa red.
        leerSaldo: `(red, tipo, valor) -> saldo`; por defecto, el lector de la red.

    Returns:
        Una `Revision` por dirección. Un fallo de lectura no corta las demás.
    """
    leer = leerSaldo or (lambda redActual, tipo, valor: lectorPara(redActual).saldo(tipo, valor))
    resultado = []
    for entidad in entidades:
        for direccion in entidad.direcciones:
            if red and direccion.red != red:
                continue
            try:
                saldo = leer(direccion.red, direccion.tipo, direccion.valor)
                resultado.append(Revision(entidad.id, direccion.red, direccion.valor, saldo))
            except ErrorLecturaWallet as error:
                resultado.append(Revision(entidad.id, direccion.red, direccion.valor, None, str(error)))
    return resultado


def paraMirar(revisiones: Iterable[Revision]) -> list[Revision]:
    """Las direcciones a cero o que no se han podido leer."""
    return [r for r in revisiones if r.saldo is None or r.saldo == 0]


def main() -> int:
    """Punto de entrada. Devuelve 0 aunque haya direcciones que mirar: no es un error."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--entidad", default="", help="Solo esta entidad (su id en el catálogo)")
    parser.add_argument("--red", default="", help="Solo esta red (btc, eth, bnb, sol, xrp)")
    argumentos = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    base = leerCatalogoBase()
    entidades = [e for e in base.entidades if not argumentos.entidad or e.id == argumentos.entidad]
    if not entidades:
        log.error("No hay ninguna entidad «%s» en el catálogo", argumentos.entidad)
        return 1
    revisiones = revisar(entidades, argumentos.red)
    for revision in paraMirar(revisiones):
        motivo = f"sin leer: {revision.error}" if revision.saldo is None else "saldo 0"
        log.info("%s | %s | %s | %s", revision.entidad, revision.red, revision.valor, motivo)
    log.info("%d direcciones revisadas, %d para mirar", len(revisiones), len(paraMirar(revisiones)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
