"""Catálogo de carteras conocidas: buscar entidades (Binance, Satoshi…) para seguirlas.

Junta el catálogo de serie con lo que el usuario ha añadido, editado u ocultado
(`stores.carteras_conocidas_store`) y lo deja buscable sin distinguir acentos
ni mayúsculas, por nombre, alias, categoría, etiqueta o dirección.

Este módulo solo prepara la lista: seguir una entidad es enlazar sus
direcciones como wallets ajenas con el flujo de siempre (`/api/wallets`), así
que los límites, la validación y la vigilancia son los de cualquier wallet.

Reglas de la fusión:

* Una entidad del usuario con el id de una de serie la sustituye entera
  («editada»). Restaurarla borra la copia y vuelve a la de serie.
* Borrar una de serie no la borra del fichero de serie: la oculta.
* Las del usuario que no pisan ninguna de serie son «propias».
"""

import secrets
import unicodedata
from dataclasses import dataclass, replace
from typing import Callable, Iterable

from core.cripto_direcciones import REDES, TIPO_AUTO, DatoWalletInvalido, prepararDatoWallet
from stores.carteras_conocidas_store import (
    CarteraConocida,
    CarterasUsuarioRepository,
    CatalogoBase,
    CatalogoUsuario,
    DireccionConocida,
    leerCatalogoBase,
)
from stores.wallets_store import MAX_LARGO_ALIAS, WalletError

ORIGEN_SERIE = "serie"
ORIGEN_EDITADA = "editada"
ORIGEN_PROPIA = "propia"

CATEGORIAS = {
    "exchange": "Exchange",
    "exchange-cerrado": "Exchange cerrado",
    "fundador": "Fundador",
    "persona": "Persona",
    "fondo": "Fondo o empresa",
    "fundacion": "Fundación",
    "stablecoin": "Emisor de stablecoin",
    "gobierno": "Gobierno",
    "hackeo": "Hackeo o robo",
    "otra": "Otra",
}
# El nombre acaba como nombre del seguimiento y la etiqueta como alias de cada
# wallet: con el mismo tope que esos, seguir una entidad nunca falla por largo.
MAX_LARGO_NOMBRE = MAX_LARGO_ALIAS
MAX_LARGO_ETIQUETA = MAX_LARGO_ALIAS
MAX_LARGO_NOTA = 500
MAX_ALIAS = 10
MAX_LARGO_UN_ALIAS = 40
MAX_DIRECCIONES_POR_ENTIDAD = 100
MAX_ENTIDADES_USUARIO = 200
MAX_RESULTADOS = 100
_PREFIJO_ID_USUARIO = "usuario-"


class CarteraNoEncontrada(WalletError):
    """No hay ninguna entidad con ese id en el catálogo."""


class CarteraInvalida(WalletError):
    """Lo que se quiere guardar en el catálogo no es válido.

    Args:
        mensaje: Qué falla, para enseñarlo tal cual.
        campo: Campo del formulario al que se refiere.
    """

    def __init__(self, mensaje: str, campo: str = "") -> None:
        super().__init__(mensaje)
        self.campo = campo


@dataclass(frozen=True)
class Entrada:
    """Una entidad ya fusionada, con de dónde viene."""

    cartera: CarteraConocida
    origen: str


def plano(texto: str) -> str:
    """El texto sin acentos y en minúsculas, para buscar.

    Example:
        >>> plano("  Fundación Ethereum ")
        'fundacion ethereum'
    """
    descompuesto = unicodedata.normalize("NFKD", str(texto or ""))
    return " ".join("".join(c for c in descompuesto if not unicodedata.combining(c)).casefold().split())


def nuevoIdUsuario() -> str:
    """Id de una entidad creada por el usuario; el prefijo impide que pise una de serie."""
    return f"{_PREFIJO_ID_USUARIO}{secrets.token_hex(6)}"


def fusionar(base: CatalogoBase, usuario: CatalogoUsuario) -> list[Entrada]:
    """El catálogo que ve el usuario: las de serie en su orden, luego las propias.

    Example:
        >>> fusionar(CatalogoBase(entidades=()), CatalogoUsuario())
        []
    """
    delUsuario = {e.id: e for e in usuario.entidades}
    entradas = []
    for cartera in base.entidades:
        if cartera.id in usuario.ocultas:
            continue
        editada = delUsuario.pop(cartera.id, None)
        entradas.append(Entrada(editada, ORIGEN_EDITADA) if editada else Entrada(cartera, ORIGEN_SERIE))
    entradas.extend(Entrada(c, ORIGEN_PROPIA) for c in delUsuario.values())
    return entradas


def relevancia(cartera: CarteraConocida, consulta: str) -> int | None:
    """Cuánto se parece la entidad a lo buscado (menor es mejor); None si no coincide.

    Args:
        cartera: Entidad candidata.
        consulta: Ya pasada por `plano`. Vacía coincide con todo.
    """
    if not consulta:
        return 0
    nombre = plano(cartera.nombre)
    if nombre.startswith(consulta):
        return 0
    if consulta in nombre or any(consulta in plano(a) for a in cartera.alias):
        return 1
    if consulta in plano(CATEGORIAS.get(cartera.categoria, cartera.categoria)):
        return 2
    # Una dirección se busca pegándola (o un trozo largo): con pocas letras
    # coincidirían casi todas por casualidad.
    if any(consulta in plano(d.etiqueta) for d in cartera.direcciones):
        return 3
    if len(consulta) >= 6 and any(consulta in d.valor.casefold() for d in cartera.direcciones):
        return 3
    return None


def _texto(datos: dict, campo: str, maximo: int, obligatorio: bool = False) -> str:
    valor = datos.get(campo)
    if valor is None:
        valor = ""
    if not isinstance(valor, str):
        raise CarteraInvalida(f"«{campo}» debe ser un texto", campo)
    valor = " ".join(valor.split())
    if obligatorio and not valor:
        raise CarteraInvalida(f"«{campo}» es obligatorio", campo)
    if len(valor) > maximo:
        raise CarteraInvalida(f"«{campo}» supera el máximo de {maximo} caracteres", campo)
    return valor


def _alias(datos: dict) -> tuple[str, ...]:
    crudos = datos.get("alias") or []
    if isinstance(crudos, str):
        crudos = crudos.split(",")
    if not isinstance(crudos, list):
        raise CarteraInvalida("«alias» debe ser una lista de textos", "alias")
    alias = []
    for crudo in crudos:
        if not isinstance(crudo, str):
            raise CarteraInvalida("«alias» debe ser una lista de textos", "alias")
        texto = " ".join(crudo.split())
        if len(texto) > MAX_LARGO_UN_ALIAS:
            raise CarteraInvalida(f"Cada alias admite como mucho {MAX_LARGO_UN_ALIAS} caracteres", "alias")
        if texto and plano(texto) not in {plano(a) for a in alias}:
            alias.append(texto)
    if len(alias) > MAX_ALIAS:
        raise CarteraInvalida(f"Como mucho {MAX_ALIAS} alias", "alias")
    return tuple(alias)


def _direccion(dato, indice: int) -> DireccionConocida:
    campo = f"direcciones.{indice}"
    if not isinstance(dato, dict):
        raise CarteraInvalida("Cada dirección debe ser un objeto", campo)
    red = str(dato.get("red") or "").strip().lower()
    if red not in REDES:
        raise CarteraInvalida("Red no soportada", campo)
    tipo = str(dato.get("tipo") or TIPO_AUTO).strip().lower()
    try:
        tipo, valor = prepararDatoWallet(red, tipo, dato.get("valor"))
    except DatoWalletInvalido as error:
        raise CarteraInvalida(str(error), campo) from error
    return DireccionConocida(red, tipo, valor, _texto(dato, "etiqueta", MAX_LARGO_ETIQUETA))


def validarCartera(datos: dict, carteraId: str) -> CarteraConocida:
    """La entidad que se quiere guardar, validada y con las direcciones en forma canónica.

    Args:
        datos: Cuerpo de la petición: nombre, categoria, alias, nota y direcciones.
        carteraId: Id que tendrá (el de la de serie al editarla, o uno nuevo).

    Raises:
        CarteraInvalida: con el campo que falla.
    """
    nombre = _texto(datos, "nombre", MAX_LARGO_NOMBRE, obligatorio=True)
    categoria = str(datos.get("categoria") or "otra").strip().lower()
    if categoria not in CATEGORIAS:
        raise CarteraInvalida("Categoría no válida", "categoria")
    crudas = datos.get("direcciones")
    if not isinstance(crudas, list) or not crudas:
        raise CarteraInvalida("Añade al menos una dirección", "direcciones")
    if len(crudas) > MAX_DIRECCIONES_POR_ENTIDAD:
        raise CarteraInvalida(f"Como mucho {MAX_DIRECCIONES_POR_ENTIDAD} direcciones por entidad", "direcciones")
    direcciones, vistas = [], set()
    for indice, cruda in enumerate(crudas):
        direccion = _direccion(cruda, indice)
        if (direccion.red, direccion.valor) in vistas:
            raise CarteraInvalida("Esa dirección está repetida", f"direcciones.{indice}")
        vistas.add((direccion.red, direccion.valor))
        direcciones.append(direccion)
    return CarteraConocida(
        id=carteraId, nombre=nombre, categoria=categoria, direcciones=tuple(direcciones), alias=_alias(datos),
        nota=_texto(datos, "nota", MAX_LARGO_NOTA),
    )


class CatalogoCarteras:
    """Servicio del catálogo. Las dependencias son inyectables para los tests.

    Args:
        repositorio: Catálogo del usuario.
        leerBase: Devuelve el catálogo de serie.
    """

    def __init__(self, repositorio: CarterasUsuarioRepository | None = None,
                 leerBase: Callable[[], CatalogoBase] = leerCatalogoBase) -> None:
        self._repositorio = repositorio or CarterasUsuarioRepository()
        self._leerBase = leerBase

    def entradas(self) -> list[Entrada]:
        """Todo el catálogo fusionado.

        Raises:
            CatalogoBaseIlegible, AlmacenIlegible, CifradoNoDisponible: si no se puede leer.
        """
        return fusionar(self._leerBase(), self._repositorio.leer())

    def buscar(self, consulta: str = "", limite: int = MAX_RESULTADOS) -> list[Entrada]:
        """Las entidades que coinciden, las más parecidas primero y, a igualdad, en el orden del catálogo."""
        texto = plano(consulta)
        puntuadas = []
        for orden, entrada in enumerate(self.entradas()):
            puntos = relevancia(entrada.cartera, texto)
            if puntos is not None:
                puntuadas.append((puntos, orden, entrada))
        puntuadas.sort(key=lambda p: (p[0], p[1]))
        return [entrada for _, _, entrada in puntuadas[:max(1, limite)]]

    def obtener(self, carteraId: str) -> Entrada:
        """La entidad con ese id.

        Raises:
            CarteraNoEncontrada: si no está (o está oculta).
        """
        for entrada in self.entradas():
            if entrada.cartera.id == carteraId:
                return entrada
        raise CarteraNoEncontrada("Esa cartera ya no está en el catálogo")

    def guardar(self, datos: dict, carteraId: str = "") -> Entrada:
        """Crea una entidad (sin id) o guarda los cambios de una existente.

        Editar una de serie guarda una copia que la sustituye; la de serie no se toca.

        Raises:
            CarteraInvalida: si los datos no son válidos.
            CarteraNoEncontrada: si se edita un id que no existe.
            WalletError: si ya hay `MAX_ENTIDADES_USUARIO`.
        """
        base = self._leerBase()
        serie = {c.id: c for c in base.entidades}
        idsSerie = serie.keys()
        cartera = validarCartera(datos, carteraId or nuevoIdUsuario())
        if cartera.id in serie:
            # Las fuentes no se editan: siguen diciendo de dónde salió la original.
            cartera = replace(cartera, fuentes=serie[cartera.id].fuentes)

        def cambio(usuario: CatalogoUsuario) -> CatalogoUsuario:
            existentes = {e.id for e in usuario.entidades}
            visiblesSerie = idsSerie - usuario.ocultas
            if carteraId and carteraId not in existentes and carteraId not in visiblesSerie:
                raise CarteraNoEncontrada("Esa cartera ya no está en el catálogo")
            if cartera.id in existentes:
                entidades = tuple(cartera if e.id == cartera.id else e for e in usuario.entidades)
            elif len(usuario.entidades) >= MAX_ENTIDADES_USUARIO:
                raise WalletError(f"Como mucho se pueden guardar {MAX_ENTIDADES_USUARIO} carteras propias o editadas")
            else:
                entidades = (*usuario.entidades, cartera)
            return replace(usuario, entidades=entidades)

        self._repositorio.modificar(cambio)
        return Entrada(cartera, ORIGEN_EDITADA if cartera.id in idsSerie else ORIGEN_PROPIA)

    def eliminar(self, carteraId: str) -> None:
        """Borra una entidad propia, u oculta una de serie (con su copia editada, si la hay).

        Raises:
            CarteraNoEncontrada: si no está en el catálogo.
        """
        idsSerie = {c.id for c in self._leerBase().entidades}

        def cambio(usuario: CatalogoUsuario) -> CatalogoUsuario:
            restantes = tuple(e for e in usuario.entidades if e.id != carteraId)
            if carteraId in idsSerie and carteraId not in usuario.ocultas:
                return CatalogoUsuario(entidades=restantes, ocultas=usuario.ocultas | {carteraId})
            if len(restantes) == len(usuario.entidades):
                raise CarteraNoEncontrada("Esa cartera ya no está en el catálogo")
            return replace(usuario, entidades=restantes)

        self._repositorio.modificar(cambio)

    def restaurar(self, carteraId: str) -> Entrada:
        """Devuelve una entidad de serie a como venía: sin la copia editada y sin ocultar.

        Raises:
            CarteraNoEncontrada: si ese id no es de serie.
        """
        serie = next((c for c in self._leerBase().entidades if c.id == carteraId), None)
        if serie is None:
            raise CarteraNoEncontrada("Solo se pueden restaurar las carteras de serie")
        self._repositorio.modificar(lambda usuario: CatalogoUsuario(
            entidades=tuple(e for e in usuario.entidades if e.id != carteraId),
            ocultas=usuario.ocultas - {carteraId},
        ))
        return Entrada(serie, ORIGEN_SERIE)

    def ocultas(self) -> list[CarteraConocida]:
        """Las de serie que el usuario ha ocultado, para poder restaurarlas."""
        usuario = self._repositorio.leer()
        return [c for c in self._leerBase().entidades if c.id in usuario.ocultas]

    def fuentes(self) -> dict:
        """Las fuentes de serie por clave: nombre, url y licencia si la tiene."""
        return self._leerBase().fuentes


def entradaComoDict(entrada: Entrada, fuentes: dict, enlazadas: Iterable[tuple[str, str]] = ()) -> dict:
    """Lo que la pantalla necesita de una entidad.

    Las direcciones van completas: son públicas y hacen falta para enlazarlas.
    `enlazada` marca las que ya se siguen, para no ofrecerlas otra vez.

    Args:
        entrada: Entidad fusionada.
        fuentes: `CatalogoCarteras.fuentes()`.
        enlazadas: Pares (red, valor) de las wallets ya enlazadas.
    """
    yaEnlazadas = set(enlazadas)
    cartera = entrada.cartera
    return {
        **cartera.comoDict(),
        "categoriaNombre": CATEGORIAS.get(cartera.categoria, cartera.categoria),
        "origen": entrada.origen,
        "fuentes": [{"clave": f, **fuentes[f]} for f in cartera.fuentes if f in fuentes],
        "direcciones": [
            {**d.comoDict(), "enlazada": (d.red, d.valor) in yaEnlazadas} for d in cartera.direcciones
        ],
    }
