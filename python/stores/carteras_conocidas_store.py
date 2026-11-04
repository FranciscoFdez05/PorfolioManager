"""Carteras conocidas: el catálogo de serie y lo que el usuario le añade o cambia.

Hay dos fuentes, que se fusionan en `core.carteras_conocidas`:

* **De serie.** `core/datos/carteras_conocidas.json`, dentro del proyecto: las
  wallets públicas de exchanges, fundadores, gobiernos y fondos, copiadas una
  vez de fuentes abiertas (cada entidad dice de cuál). La aplicación no las
  descarga de ningún sitio: es un fichero de solo lectura que se actualiza con
  el código.
* **Del usuario.** Entidades nuevas, copias editadas de las de serie y las de
  serie que ha ocultado, en `API/carteras.key`. Va cifrado como las wallets
  (misma SECRET_KEY y misma sal, prefijo propio): una dirección con un nombre
  al lado dice de quién es, y lo que se añade aquí puede ser la de un conocido.
  Fuera de git (`API/*.key`) y nunca en claro en un ZIP, como `wallets.key`.

Fichero aparte y no una clave más de `wallets.key`: la vigilancia reescribe ese
fichero en cada pasada, y el catálogo no tiene por qué esperar a su bloqueo.

Patrón Repository: el servicio no sabe de ficheros ni de cifrado, y los tests
inyectan las rutas y el proveedor de Fernet.
"""

import json
import logging
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Callable

from cryptography.fernet import Fernet, InvalidToken

from core import bloqueo, paths
from core.escritura import escribirAtomico
from stores.wallets_store import LARGO_MINIMO_SECRET_KEY, AlmacenIlegible, CifradoNoDisponible, fernetWallets

log = logging.getLogger(__name__)

NOMBRE_FICHERO = "carteras.key"
_PREFIJO = b"CAT1:"
_ESPERA_BLOQUEO_SEGUNDOS = 5.0
RUTA_CATALOGO_BASE = Path(__file__).resolve().parent.parent / "core" / "datos" / "carteras_conocidas.json"


@dataclass(frozen=True)
class DireccionConocida:
    """Una dirección de una entidad. `valor` está en forma canónica (`prepararDatoWallet`)."""

    red: str
    tipo: str
    valor: str
    etiqueta: str = ""

    def comoDict(self) -> dict:
        return {"red": self.red, "tipo": self.tipo, "valor": self.valor, "etiqueta": self.etiqueta}


@dataclass(frozen=True)
class CarteraConocida:
    """Una entidad del catálogo (Binance, Satoshi…) con sus direcciones en las redes que se siguen.

    `fuentes` son claves de `CatalogoBase.fuentes`; en las del usuario va vacío.
    """

    id: str
    nombre: str
    categoria: str
    direcciones: tuple[DireccionConocida, ...]
    alias: tuple[str, ...] = ()
    nota: str = ""
    fuentes: tuple[str, ...] = ()

    @classmethod
    def desdeDict(cls, datos: dict) -> "CarteraConocida":
        """La entidad tal como se guarda en JSON.

        Raises:
            KeyError, TypeError, AttributeError: si le falta un campo o no tiene la forma esperada.
        """
        direcciones = tuple(
            DireccionConocida(d["red"], d["tipo"], d["valor"], d.get("etiqueta", "")) for d in datos["direcciones"]
        )
        return cls(
            id=datos["id"], nombre=datos["nombre"], categoria=datos["categoria"], direcciones=direcciones,
            alias=tuple(datos.get("alias", ())), nota=datos.get("nota", ""), fuentes=tuple(datos.get("fuentes", ())),
        )

    def comoDict(self) -> dict:
        return {
            "id": self.id, "nombre": self.nombre, "categoria": self.categoria, "alias": list(self.alias),
            "nota": self.nota, "fuentes": list(self.fuentes), "direcciones": [d.comoDict() for d in self.direcciones],
        }


@dataclass(frozen=True)
class CatalogoBase:
    """El catálogo de serie: las entidades y las fuentes de donde salieron."""

    entidades: tuple[CarteraConocida, ...]
    fuentes: dict = field(default_factory=dict)


@dataclass(frozen=True)
class CatalogoUsuario:
    """Lo que el usuario ha cambiado: entidades propias o editadas, e ids de serie ocultos."""

    entidades: tuple[CarteraConocida, ...] = ()
    ocultas: frozenset[str] = frozenset()


class CatalogoBaseIlegible(Exception):
    """El JSON de serie falta o está mal formado: es un fallo de la instalación."""


@lru_cache(maxsize=4)
def leerCatalogoBase(ruta: Path = RUTA_CATALOGO_BASE) -> CatalogoBase:
    """El catálogo de serie, leído una vez por proceso: solo cambia al actualizar el código.

    Raises:
        CatalogoBaseIlegible: si el fichero no existe o no tiene la forma esperada.
    """
    try:
        datos = json.loads(Path(ruta).read_text(encoding="utf-8"))
        entidades = tuple(CarteraConocida.desdeDict(e) for e in datos["entidades"])
        return CatalogoBase(entidades=entidades, fuentes=dict(datos.get("fuentes", {})))
    except OSError as error:
        raise CatalogoBaseIlegible(f"No se pudo leer el catálogo de carteras: {error.strerror or error}") from error
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        raise CatalogoBaseIlegible("El catálogo de carteras de serie está dañado") from error


class CarterasUsuarioRepository:
    """Lectura y escritura del fichero cifrado con el catálogo del usuario.

    Args:
        ruta: Fichero. Por defecto `API_DIR/carteras.key`, resuelto en cada
            llamada para que una prueba que redirige API/ no toque el real.
        proveedorFernet: Devuelve el Fernet o None. Inyectable para los tests.
    """

    def __init__(self, ruta: Path | None = None,
                 proveedorFernet: Callable[[], Fernet | None] = fernetWallets) -> None:
        self._ruta = ruta
        self._proveedorFernet = proveedorFernet

    @property
    def ruta(self) -> Path:
        return self._ruta if self._ruta is not None else paths.API_DIR / NOMBRE_FICHERO

    def _fernet(self) -> Fernet:
        fernet = self._proveedorFernet()
        if fernet is None:
            raise CifradoNoDisponible(
                f"Para guardar carteras en el catálogo hace falta una SECRET_KEY aleatoria de al menos "
                f"{LARGO_MINIMO_SECRET_KEY} caracteres en .env (docker-up.sh la genera)."
            )
        return fernet

    def leer(self) -> CatalogoUsuario:
        """El catálogo del usuario; vacío si aún no ha guardado nada.

        Sin fichero no hace falta SECRET_KEY: así el catálogo de serie se puede
        consultar en una instalación que todavía no la tiene.

        Raises:
            CifradoNoDisponible: si hay fichero y no hay SECRET_KEY válida.
            AlmacenIlegible: si el fichero no se puede descifrar o está corrupto.
        """
        return self._desdeDatos(self._leerDatos())

    def modificar(self, cambio: Callable[[CatalogoUsuario], CatalogoUsuario]) -> CatalogoUsuario:
        """Lee, aplica `cambio` y escribe, bajo un bloqueo entre procesos.

        Returns:
            El catálogo del usuario ya cambiado.

        Raises:
            CifradoNoDisponible: si no hay SECRET_KEY válida.
            AlmacenIlegible: si el fichero actual no se puede leer.
            Lo que lance `cambio`, sin escribir nada.
        """
        fernet = self._fernet()
        with bloqueo.exclusivo(self.ruta.with_name(f".{NOMBRE_FICHERO}.lock"), espera=_ESPERA_BLOQUEO_SEGUNDOS):
            nuevo = cambio(self.leer())
            claro = json.dumps({
                "version": 1,
                "entidades": [e.comoDict() for e in nuevo.entidades],
                "ocultas": sorted(nuevo.ocultas),
            }, ensure_ascii=False)
            escribirAtomico(self.ruta, _PREFIJO + fernet.encrypt(claro.encode("utf-8")), permisos=0o600)
        log.info("[carteras] Catálogo del usuario guardado (%d entidades, %d ocultas)",
                 len(nuevo.entidades), len(nuevo.ocultas))
        return nuevo

    def volcado(self) -> dict:
        """Lo guardado por el usuario, para el paquete cifrado de las copias.

        Raises:
            CifradoNoDisponible: si hay fichero y no hay SECRET_KEY válida.
            AlmacenIlegible: si el fichero no se puede descifrar o está corrupto.
        """
        return self._leerDatos()

    def restaurarVolcado(self, datos: dict) -> None:
        """Sustituye lo guardado por un `volcado`, sin leer lo anterior (puede ser de otra SECRET_KEY).

        Args:
            datos: Contenido de `volcado`; viene de un ZIP, así que no se da por bueno.

        Raises:
            AlmacenIlegible: si `datos` no tiene la forma esperada.
            CifradoNoDisponible: si no hay SECRET_KEY válida.
        """
        if not isinstance(datos, dict):
            raise AlmacenIlegible("La copia trae el catálogo de carteras dañado")
        nuevo = self._desdeDatos(datos)
        fernet = self._fernet()
        claro = json.dumps({
            "version": 1,
            "entidades": [e.comoDict() for e in nuevo.entidades],
            "ocultas": sorted(nuevo.ocultas),
        }, ensure_ascii=False)
        with bloqueo.exclusivo(self.ruta.with_name(f".{NOMBRE_FICHERO}.lock"), espera=_ESPERA_BLOQUEO_SEGUNDOS):
            escribirAtomico(self.ruta, _PREFIJO + fernet.encrypt(claro.encode("utf-8")), permisos=0o600)

    def _leerDatos(self) -> dict:
        if not self.ruta.exists():
            return {}
        try:
            crudo = self.ruta.read_bytes()
        except OSError as error:
            raise AlmacenIlegible(f"No se pudo leer {NOMBRE_FICHERO}: {error.strerror or error}") from error
        if not crudo.startswith(_PREFIJO):
            raise AlmacenIlegible(f"{NOMBRE_FICHERO} no tiene el formato esperado")
        try:
            datos = json.loads(self._fernet().decrypt(crudo[len(_PREFIJO):]).decode("utf-8"))
        except InvalidToken as error:
            raise AlmacenIlegible(
                "No se puede descifrar el catálogo de carteras. ¿Ha cambiado SECRET_KEY desde que se guardó?"
            ) from error
        except ValueError as error:
            raise AlmacenIlegible(f"{NOMBRE_FICHERO} está dañado") from error
        if not isinstance(datos, dict):
            raise AlmacenIlegible(f"{NOMBRE_FICHERO} está dañado")
        return datos

    @staticmethod
    def _desdeDatos(datos: dict) -> CatalogoUsuario:
        try:
            entidades = tuple(CarteraConocida.desdeDict(e) for e in datos.get("entidades", []))
            ocultas = frozenset(str(i) for i in datos.get("ocultas", []))
        except (KeyError, TypeError, AttributeError) as error:
            raise AlmacenIlegible(f"{NOMBRE_FICHERO} está dañado") from error
        return CatalogoUsuario(entidades=entidades, ocultas=ocultas)
