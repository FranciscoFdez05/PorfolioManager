"""Caché por hilo de resultados que solo dependen de lo que hay en la base de datos.

La validez no se engancha a cada punto de escritura (eso es lo que se queda cojo
en cuanto alguien añade una ruta nueva): la clave de la caché es la propia foto
de la base de datos. `PRAGMA data_version` cambia cuando OTRA conexión (otro hilo
u otro worker) confirma una escritura, y `total_changes` cuenta las de la
conexión que pregunta, así que cualquier alta, baja o edición invalida todo. Es
el mismo criterio que usa `stores.ventas_fifo.calcularTodo`.

Lo que NO está en la base (el tipo de cambio de hoy, que sale de un proveedor)
no cambia la foto: el llamador lo declara con `validar`, que se ejecuta en cada
acierto y puede descartar la entrada.
"""

import threading
from collections.abc import Callable
from typing import Any

from core import db


def huellaDeLaBase(conn) -> tuple:
    """Foto de la base de datos: cambia con cualquier escritura de cualquier conexión.

    Args:
        conn: Conexión del hilo actual.

    Returns:
        Tupla comparable; incluye la generación de conexiones para cubrir
        restaurar o cambiar de cartera.
    """
    return (db._resetGeneration, conn.execute("PRAGMA data_version").fetchone()[0], conn.total_changes)


class CachePorFoto:
    """Resultados memorizados mientras la base de datos no cambie.

    Cada hilo tiene la suya, porque cada hilo tiene su propia conexión (core/db.py)
    y su propia vista de la base. Todas las entradas de un hilo caducan juntas al
    cambiar la foto.

    Example:
        cache = CachePorFoto()
        cuerpo = cache.obtener(conn, "clave", lambda: (calcular(), None))
    """

    def __init__(self, maxEntradas: int = 64) -> None:
        """Crea la caché.

        Args:
            maxEntradas: Tope de entradas por hilo; al superarlo se vacía.
        """
        self._local = threading.local()
        self._maxEntradas = maxEntradas

    def obtener(
        self,
        conn,
        clave: Any,
        calcular: Callable[[], tuple[Any, Any]],
        validar: Callable[[Any], bool] | None = None,
    ) -> Any:
        """Devuelve el valor de `clave`, calculándolo si no hay uno vigente.

        Args:
            conn: Conexión del hilo actual.
            clave: Identifica el resultado dentro de la foto actual.
            calcular: Función sin argumentos que devuelve `(valor, contexto)`;
                `contexto` es lo que `validar` necesita para decidir (por ejemplo,
                los tipos de cambio usados).
            validar: Función `(contexto) -> bool`; si devuelve False, la entrada
                se recalcula. Sin ella, la entrada vale mientras la foto no cambie.

        Returns:
            El valor memorizado o recién calculado. Es el mismo objeto en cada
            acierto: quien lo reciba no debe mutarlo.
        """
        huella = huellaDeLaBase(conn)
        estado = getattr(self._local, "estado", None)
        # Se guarda la conexión para que su id no se reutilice mientras la caché la use.
        if estado is None or estado["huella"] != huella or estado["conn"] is not conn:
            estado = {"huella": huella, "conn": conn, "entradas": {}}
            self._local.estado = estado

        entrada = estado["entradas"].get(clave)
        if entrada is not None and (validar is None or validar(entrada[1])):
            return entrada[0]

        valor, contexto = calcular()
        if len(estado["entradas"]) >= self._maxEntradas:
            estado["entradas"].clear()
        estado["entradas"][clave] = (valor, contexto)
        return valor
