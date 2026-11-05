"""Lo último leído de la red en el detalle de cada wallet: historial, tokens y UTXOs.

Leer un seguimiento con muchas wallets son minutos, y sin guardarlo cada visita a
la página empezaba de cero. Es una caché: se regenera leyendo la red, así que
perderla no es un error (otra SECRET_KEY, un fichero dañado o un disco lleno solo
hacen que se vuelva a leer) y no entra en las copias de seguridad.

Un historial dice lo mismo que una xpub (direcciones, importes y fechas de toda la
wallet), así que va cifrado con la misma clave que `wallets.key`. Sin una
SECRET_KEY válida no se guarda nada, ni siquiera de las ajenas.

Un fichero por wallet: escribir lo de una no obliga a descifrar y volver a cifrar
las demás. Van en una subcarpeta a propósito: `server._encryptApiKeysAtRest` envuelve
en `ENC1:` todo `API/*.key` en cada arranque y los dejaría ilegibles.
"""

import json
import logging
import re
from collections.abc import Callable
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from core import bloqueo, paths
from core.escritura import escribirAtomico
from stores.wallets_store import fernetWallets

log = logging.getLogger(__name__)

NOMBRE_CARPETA = "wallets_lecturas"
SECCION_MOVIMIENTOS = "movimientos"
SECCION_TOKENS = "tokens"
SECCION_UTXOS = "utxos"

_PREFIJO = b"LEC1:"
_ESPERA_BLOQUEO_SEGUNDOS = 2.0
# El identificador acaba en una ruta: solo lo que puede generar `nuevoId`, sin separadores.
_PATRON_ID = re.compile(r"[A-Za-z0-9_-]{1,80}")


class LecturasRepository:
    """Lectura y escritura de las lecturas guardadas de cada wallet.

    Ningún método lanza por un fallo del almacén: al ser una caché, quien la usa
    sigue adelante con lo que acaba de leer de la red.

    Args:
        carpeta: Carpeta de los ficheros. Por defecto `API_DIR/wallets_lecturas`,
            resuelta en cada llamada para que una prueba que redirige API/ no toque la real.
        proveedorFernet: Devuelve el Fernet o None. Inyectable para los tests.
    """

    def __init__(self, carpeta: Path | None = None,
                 proveedorFernet: Callable[[], Fernet | None] = fernetWallets) -> None:
        self._carpeta = carpeta
        self._proveedorFernet = proveedorFernet

    @property
    def carpeta(self) -> Path:
        return self._carpeta if self._carpeta is not None else paths.API_DIR / NOMBRE_CARPETA

    @property
    def disponible(self) -> bool:
        """Si hay clave con la que guardar."""
        return self._proveedorFernet() is not None

    def _ruta(self, walletId: str) -> Path | None:
        return self.carpeta / f"{walletId}.key" if _PATRON_ID.fullmatch(walletId) else None

    def leer(self, walletId: str) -> dict:
        """Todo lo guardado de una wallet, por sección.

        Args:
            walletId: Identificador de la wallet.

        Returns:
            `{seccion: contenido}`; vacío si no hay nada o no se puede descifrar.
        """
        ruta, fernet = self._ruta(walletId), self._proveedorFernet()
        if ruta is None or fernet is None:
            return {}
        try:
            crudo = ruta.read_bytes()
            if not crudo.startswith(_PREFIJO):
                raise ValueError("cabecera desconocida")
            datos = json.loads(fernet.decrypt(crudo[len(_PREFIJO):]))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError, InvalidToken) as error:
            log.warning("[wallets] Lectura guardada ilegible, se volverá a leer de la red: %s", type(error).__name__)
            return {}
        return datos if isinstance(datos, dict) else {}

    def guardar(self, walletId: str, seccion: str, contenido: dict) -> bool:
        """Sustituye una sección de lo guardado de una wallet; deja las demás como estaban.

        Args:
            walletId: Identificador de la wallet.
            seccion: Una de las `SECCION_*`.
            contenido: Lo que se guarda, serializable a JSON.

        Returns:
            True si ha quedado guardado.
        """
        ruta, fernet = self._ruta(walletId), self._proveedorFernet()
        if ruta is None or fernet is None:
            return False
        try:
            # Sin bloqueo, dos workers con secciones distintas se pisarían la una a la otra.
            with bloqueo.exclusivo(self._rutaBloqueo(ruta), espera=_ESPERA_BLOQUEO_SEGUNDOS):
                datos = {**self.leer(walletId), seccion: contenido}
                claro = json.dumps(datos, ensure_ascii=False).encode("utf-8")
                escribirAtomico(ruta, _PREFIJO + fernet.encrypt(claro), permisos=0o600)
        except (OSError, bloqueo.BloqueoOcupado) as error:
            log.warning("[wallets] No se pudo guardar la lectura: %s", error)
            return False
        return True

    def borrar(self, walletId: str) -> None:
        """Olvida lo guardado de una wallet. No falla si no había nada.

        Args:
            walletId: Identificador de la wallet.
        """
        ruta = self._ruta(walletId)
        if ruta is None:
            return
        for fichero in (ruta, self._rutaBloqueo(ruta)):
            try:
                fichero.unlink(missing_ok=True)
            except OSError as error:
                log.warning("[wallets] No se pudo borrar una lectura guardada: %s", error)

    @staticmethod
    def _rutaBloqueo(ruta: Path) -> Path:
        return ruta.with_name(f".{ruta.name}.lock")
