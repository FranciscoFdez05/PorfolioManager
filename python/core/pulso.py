"""Cada hilo de fondo dice hasta cuándo se le puede dar por vivo.

El latido de `admin.worker` solo demuestra que vive el hilo principal: si el de
las copias se cuelga o muere, el contenedor sigue «sano» y las copias se paran
sin que nadie lo sepa. Con esto, cada hilo renueva su plazo en cada vuelta y el
worker se reinicia si alguno lo deja vencer.

El plazo lo pone cada hilo, no una tabla central, porque depende de lo que vaya
a hacer: el de snapshots duerme hasta el siguiente hueco, que es configurable.
"""

import time

_vencimientos: dict[str, float] = {}


def marcar(nombre: str, plazoSegundos: float) -> None:
    """Renueva el plazo de una tarea.

    Args:
        nombre: Nombre de la tarea.
        plazoSegundos: Tiempo máximo hasta la siguiente marca.
    """
    _vencimientos[nombre] = time.monotonic() + plazoSegundos


def vencidas() -> list[str]:
    """Nombres de las tareas que han dejado pasar su plazo.

    Returns:
        Lista ordenada; vacía si todas van a tiempo. Una tarea que nunca ha
        marcado no cuenta: puede estar desactivada por configuración.
    """
    ahora = time.monotonic()
    return sorted(nombre for nombre, vencimiento in list(_vencimientos.items()) if ahora > vencimiento)
