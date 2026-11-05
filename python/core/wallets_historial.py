"""Historial de una wallet: lo guardado más lo que se acaba de leer de la red.

Los lectores no tienen cursor, solo devuelven los `limite` movimientos más
recientes. Así que buscar lo nuevo es pedir una página y juntarla con lo guardado,
sin repetir el historial ya leído. Se guarda tal como lo da la red: la libreta y
las marcas se aplican al enseñarlo, y marcar una dirección se sigue viendo al momento.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass

from stores.wallets_lecturas import SECCION_MOVIMIENTOS, LecturasRepository
from stores.wallets_store import ahoraIso

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class HistorialLeido:
    """Resultado de leer el historial de una wallet.

    Attributes:
        filas: Lo guardado junto con lo leído, de más reciente a más antiguo.
        nuevas: Solo lo devuelto por la red en esta lectura.
        limite: Movimientos más recientes que ya se han pedido a la red.
        agotado: Si pedir más ya no traerá nada.
        guardado: Si ha quedado guardado para la próxima visita.
        fecha: Cuándo se ha leído.
        tokensPublicos: Contratos de las listas públicas para estas filas.
    """

    filas: list[dict]
    nuevas: list[dict]
    limite: int
    agotado: bool
    guardado: bool
    fecha: str
    tokensPublicos: list[dict]


def claveMovimiento(movimiento: dict) -> tuple:
    """Lo que identifica un movimiento dentro de su wallet.

    No basta el hash: una transacción puede mover la moneda y varios tokens. La
    fecha no entra para que una transacción pendiente, al confirmarse, sustituya a
    la guardada en vez de salir repetida.

    Args:
        movimiento: Movimiento en dict (`movimientoComoDict`).

    Returns:
        Tupla comparable y usable como clave.
    """
    campos = ("hash", "contrato", "simbolo", "tipo", "propia", "contraparte", "cantidad")
    return tuple(movimiento.get(campo, "") for campo in campos)


def fusionarMovimientos(nuevos: list[dict], guardados: list[dict], maximo: int) -> list[dict]:
    """Junta lo leído con lo guardado; si algo está en los dos, manda lo leído.

    Args:
        nuevos: Lo que acaba de devolver la red.
        guardados: Lo que había guardado.
        maximo: Tope de movimientos; se olvidan los más antiguos.

    Returns:
        Los movimientos de más reciente a más antiguo.
    """
    conocidos = {claveMovimiento(movimiento) for movimiento in nuevos}
    conservados = [m for m in guardados if claveMovimiento(m) not in conocidos]
    ordenados = sorted([*nuevos, *conservados], key=lambda m: str(m.get("fecha", "")), reverse=True)
    return ordenados[:maximo]


class HistorialWallets:
    """Servicio del historial guardado.

    Args:
        almacen: Dónde se guardan las lecturas. Inyectable para los tests.
    """

    def __init__(self, almacen: LecturasRepository | None = None) -> None:
        self._almacen = almacen or LecturasRepository()

    def leer(self, walletId: str, limite: int, maximo: int, leerRed: Callable[[int], list[dict]],
             publicosDe: Callable[[list[dict]], list[dict]], reiniciar: bool = False) -> HistorialLeido:
        """Lee de la red, lo junta con lo guardado y lo deja guardado.

        Si la lectura falla, la excepción sube sin haber tocado lo guardado.

        Args:
            walletId: Identificador de la wallet.
            limite: Movimientos más recientes que pedir.
            maximo: Tope de `[wallets] max_historial`.
            leerRed: Devuelve los N movimientos más recientes, en dict.
            publicosDe: Contratos de las listas públicas para unas filas.
            reiniciar: Descartar lo guardado y quedarse solo con lo leído. Es lo que
                limpia una transacción que la red ha descartado.

        Returns:
            El historial resultante.
        """
        anterior = {} if reiniciar else self._almacen.leer(walletId).get(SECCION_MOVIMIENTOS, {})
        guardadas = anterior.get("filas", [])
        limiteAnterior = int(anterior.get("limite", 0))
        nuevas, limiteLeido = self._leerEnlazando(leerRed, limite, maximo, guardadas)
        filas = fusionarMovimientos(nuevas, guardadas, maximo)
        # Algunas redes descartan transacciones que no mueven la moneda, así que
        # recibir menos de lo pedido no prueba que no haya más: lo prueba que
        # pedir más que antes no traiga nada nuevo.
        pedidoMas = limiteLeido > limiteAnterior
        sinMas = len(filas) <= len(guardadas) if pedidoMas else bool(anterior.get("sinMas"))
        limiteFinal = max(limiteLeido, limiteAnterior)
        fecha = ahoraIso()
        tokensPublicos = publicosDe(filas)
        guardado = self._almacen.guardar(walletId, SECCION_MOVIMIENTOS, {
            "filas": filas,
            "limite": limiteFinal,
            "sinMas": sinMas,
            "fecha": fecha,
            "tokensPublicos": tokensPublicos,
        })
        return HistorialLeido(filas, nuevas, limiteFinal, sinMas or limiteFinal >= maximo, guardado, fecha,
                              tokensPublicos)

    @staticmethod
    def _leerEnlazando(leerRed: Callable[[int], list[dict]], limite: int, maximo: int,
                       guardadas: list[dict]) -> tuple[list[dict], int]:
        """Lee hasta dar con algo ya guardado, para no dejar un hueco en el historial.

        Si desde la última visita hubo más movimientos que los que caben en una
        página, juntarla con lo guardado dejaría sin ver los de en medio.

        Returns:
            `(movimientos leídos, límite con el que se han leído)`.
        """
        conocidos = {claveMovimiento(movimiento) for movimiento in guardadas}
        leidos = leerRed(limite)
        while (conocidos and limite < maximo and len(leidos) >= limite
               and not any(claveMovimiento(movimiento) in conocidos for movimiento in leidos)):
            limite = min(limite * 2, maximo)
            log.debug("[wallets] Sin enlace con lo guardado: se piden %d movimientos", limite)
            leidos = leerRed(limite)
        return leidos, limite
