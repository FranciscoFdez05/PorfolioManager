"""Límite de peticiones de escritura por IP.

El login ya tenía su propio bloqueo por intentos fallidos (routes/auth.py), pero
era el único punto con freno: una sesión válida —o una cookie robada— podía
lanzar miles de POST contra /api/restore, /api/backup o cualquier endpoint que
escribe en SQLite sin encontrar resistencia. Cada uno de esos abre conexiones,
copia ficheros .db y hace checkpoint del WAL, así que el coste por petición es
alto y basta con muy poco volumen para dejar la aplicación inservible.

Esto es un contador, no un antifraude: solo pretende que un bucle accidental o
un cliente descontrolado no tumben el servidor. Vive en memoria del proceso, de
modo que con varios workers de Gunicorn el límite efectivo se multiplica por el
número de workers. Se ha preferido eso a añadir Redis a un despliegue que hoy
es un contenedor y un fichero SQLite.

La ventana es deslizante: se guardan los instantes de las últimas peticiones de
cada IP y se descartan las que ya salieron de la ventana. Un contador por
intervalo fijo dejaría pasar el doble del límite a caballo entre dos intervalos.
"""

import threading
import time
from collections import deque


class LimitadorVentana:
    """Ventana deslizante de N eventos por IP.

    `consumir()` devuelve 0 si la petición pasa, o los segundos que faltan para
    que vuelva a haber hueco. Registrar el evento y decidir van juntos a
    propósito: separarlos abriría una carrera entre comprobar y anotar.
    """

    def __init__(self, maximo, ventana_segundos, max_clientes=1000):
        # `maximo` admite un invocable para poder leer el ajuste en cada
        # petición: config_ini recarga config.ini cuando cambia en disco, y
        # congelar el valor aquí obligaría a reiniciar para subir el límite.
        self._maximo = maximo
        self._ventana = float(ventana_segundos)
        self._max_clientes = max_clientes
        self._eventos: dict[str, deque] = {}
        self._lock = threading.Lock()

    def _valor(self, ajuste, defecto):
        try:
            return int(ajuste() if callable(ajuste) else ajuste)
        except Exception:
            return defecto

    def consumir(self, clave) -> int:
        maximo = self._valor(self._maximo, 0)
        if maximo <= 0:
            return 0  # límite desactivado

        ahora = time.monotonic()
        with self._lock:
            marcas = self._eventos.get(clave)
            if marcas is None:
                marcas = deque()
                self._eventos[clave] = marcas
                self._podar(ahora)

            corte = ahora - self._ventana
            while marcas and marcas[0] <= corte:
                marcas.popleft()

            if len(marcas) >= maximo:
                # La más antigua es la que libera el siguiente hueco.
                espera = self._ventana - (ahora - marcas[0])
                return max(1, int(espera) + 1)

            marcas.append(ahora)
            return 0

    def olvidar(self, clave) -> None:
        with self._lock:
            self._eventos.pop(clave, None)

    def reiniciar(self) -> None:
        """Vacía el registro. Pensado para los tests, no para uso normal."""
        with self._lock:
            self._eventos.clear()

    def _podar(self, ahora) -> None:
        """Descarta IPs sin actividad reciente para que el dict no crezca sin fin.

        Se llama solo al dar de alta una IP nueva —el único momento en que el
        diccionario puede crecer— y únicamente cuando ya se pasó del tope, así
        que en operación normal no cuesta nada.
        """
        if len(self._eventos) <= self._valor(self._max_clientes, 1000):
            return
        corte = ahora - self._ventana
        for clave in [k for k, marcas in self._eventos.items() if not marcas or marcas[-1] <= corte]:
            self._eventos.pop(clave, None)
