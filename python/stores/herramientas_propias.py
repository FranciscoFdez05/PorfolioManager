"""Herramientas de cálculo que el usuario crea desde la página Herramientas.

Son la versión sin código de las de `html/analisis/herramientas-extra/`: en vez
de un `.html` y un `.js`, una descripción declarativa —campos de entrada y
resultados calculados con una fórmula— que el navegador convierte en el mismo
panel que las de serie. Se guardan en `ajustes.json` bajo la clave
`herramientasPropias` y no en un fichero aparte porque así viajan solas en las
copias de seguridad, las exportaciones y las importaciones, que ya llevan ese
fichero; y son globales porque una calculadora no es un dato de una cartera.

Este módulo no lee ni escribe disco: da forma a lo que llega del navegador (o de
un fichero importado) y aplica las altas, cambios y bajas sobre la lista. La
lectura y la escritura las hace quien lo llama con `stores.ajustes_store`, que a
su vez usa `normalizarLista` al leer, como hace con `stores.seguimiento_prefs`.

Las fórmulas se guardan como texto y aquí solo se comprueba su tamaño. Las
evalúa el navegador con su propio analizador (`js/analisis/herramientas-formula.js`),
sin `eval`, y es él quien avisa al guardar de una fórmula mal escrita o que usa
un campo que no existe. En el servidor no se ejecutan nunca.
"""

import logging
import math
import re
import secrets

log = logging.getLogger(__name__)

CLAVE = "herramientasPropias"

FORMATOS = ("numero", "moneda", "porcentaje")

MAX_HERRAMIENTAS = 50
MAX_CAMPOS = 12
MAX_RESULTADOS = 12
MAX_DECIMALES = 6
DECIMALES_DEFECTO = 2

_MAX_TITULO = 60
_MAX_DESCRIPCION = 200
_MAX_ETIQUETA = 60
_MAX_UNIDAD = 12
_MAX_FORMULA = 300

# El id acaba en el id de un elemento HTML (`toolPropia-<id>`) y en la URL de
# la API, así que se limita a lo que no hay que escapar en ninguno de los dos.
_ID_VALIDO = re.compile(r"^[a-z0-9]{1,16}$")

# Nombre con el que una fórmula usa un campo. Lo mismo que acepta el
# analizador del navegador como identificador.
_CLAVE_CAMPO = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,23}$")


class HerramientaInvalida(ValueError):
    """Lo recibido no describe una herramienta válida. El mensaje es para el usuario."""


class HerramientaNoEncontrada(LookupError):
    """No hay ninguna herramienta con ese id."""


def _texto(valor, maximo: int, nombre: str, obligatorio: bool = False) -> str:
    """Texto recortado y sin espacios en los extremos.

    Raises:
        HerramientaInvalida: si no es texto, si pasa del máximo o si falta
            siendo obligatorio.
    """
    if valor is None:
        valor = ""
    if not isinstance(valor, str):
        raise HerramientaInvalida(f"{nombre}: debe ser texto.")
    limpio = valor.strip()
    if obligatorio and not limpio:
        raise HerramientaInvalida(f"{nombre}: no puede quedar vacío.")
    if len(limpio) > maximo:
        raise HerramientaInvalida(f"{nombre}: como mucho {maximo} caracteres.")
    return limpio


def _numero(valor, nombre: str) -> float:
    """Número finito. Acepta texto numérico porque el input del navegador lo es.

    Raises:
        HerramientaInvalida: si no es un número finito.
    """
    if isinstance(valor, bool):
        raise HerramientaInvalida(f"{nombre}: debe ser un número.")
    if isinstance(valor, str):
        try:
            valor = float(valor.strip().replace(",", ".")) if valor.strip() else 0.0
        except ValueError as error:
            raise HerramientaInvalida(f"{nombre}: debe ser un número.") from error
    if valor is None:
        valor = 0.0
    if not isinstance(valor, (int, float)) or not math.isfinite(valor):
        # NaN e Infinity llegan por JSON de Flask pero no se pueden volver a
        # escribir como JSON válido.
        raise HerramientaInvalida(f"{nombre}: debe ser un número.")
    return float(valor)


def _lista(valor, minimo: int, maximo: int, nombre: str) -> list:
    """Lista con un número de elementos entre `minimo` y `maximo`.

    Raises:
        HerramientaInvalida: si no es una lista o su tamaño no encaja.
    """
    if not isinstance(valor, list):
        raise HerramientaInvalida(f"{nombre}: falta la lista.")
    if len(valor) < minimo:
        raise HerramientaInvalida(f"{nombre}: añade al menos {minimo}.")
    if len(valor) > maximo:
        raise HerramientaInvalida(f"{nombre}: como mucho {maximo}.")
    return valor


def _campo(crudo, posicion: int) -> dict:
    """Un campo de entrada: `{clave, etiqueta, unidad, defecto}`."""
    nombre = f"Campo {posicion}"
    if not isinstance(crudo, dict):
        raise HerramientaInvalida(f"{nombre}: formato no válido.")
    clave = _texto(crudo.get("clave"), 24, f"{nombre}, nombre en la fórmula", obligatorio=True)
    if not _CLAVE_CAMPO.match(clave):
        raise HerramientaInvalida(
            f"{nombre}: el nombre en la fórmula empieza por una letra y solo lleva "
            "letras sin acentos, números o guiones bajos."
        )
    return {
        "clave": clave,
        "etiqueta": _texto(crudo.get("etiqueta"), _MAX_ETIQUETA, f"{nombre}, etiqueta", obligatorio=True),
        "unidad": _texto(crudo.get("unidad"), _MAX_UNIDAD, f"{nombre}, unidad"),
        "defecto": _numero(crudo.get("defecto"), f"{nombre}, valor por defecto"),
    }


def _decimales(valor, nombre: str) -> int:
    """Decimales con que se pinta un resultado, entre 0 y `MAX_DECIMALES`."""
    if valor is None or valor == "":
        return DECIMALES_DEFECTO
    numero = _numero(valor, nombre)
    if numero != int(numero) or not 0 <= numero <= MAX_DECIMALES:
        raise HerramientaInvalida(f"{nombre}: un entero entre 0 y {MAX_DECIMALES}.")
    return int(numero)


def _resultado(crudo, posicion: int) -> dict:
    """Un resultado: `{etiqueta, formula, formato, decimales, sufijo, destacado}`."""
    nombre = f"Resultado {posicion}"
    if not isinstance(crudo, dict):
        raise HerramientaInvalida(f"{nombre}: formato no válido.")
    formato = crudo.get("formato") or "numero"
    if formato not in FORMATOS:
        raise HerramientaInvalida(f"{nombre}: formato desconocido.")
    return {
        "etiqueta": _texto(crudo.get("etiqueta"), _MAX_ETIQUETA, f"{nombre}, etiqueta", obligatorio=True),
        "formula": _texto(crudo.get("formula"), _MAX_FORMULA, f"{nombre}, fórmula", obligatorio=True),
        "formato": formato,
        "decimales": _decimales(crudo.get("decimales"), f"{nombre}, decimales"),
        "sufijo": _texto(crudo.get("sufijo"), _MAX_UNIDAD, f"{nombre}, sufijo"),
        "destacado": crudo.get("destacado") is True,
    }


def validar(datos, identificador: str) -> dict:
    """Herramienta completa con la forma que se guarda.

    Args:
        datos: Lo recibido del navegador o leído del fichero.
        identificador: Id que lleva la herramienta. Lo pone quien llama: al
            crear, uno nuevo; al editar, el de la URL.

    Returns:
        La herramienta saneada.

    Raises:
        HerramientaInvalida: si algo no tiene la forma esperada; el mensaje
            dice qué y está pensado para enseñarlo tal cual.

    Example:
        >>> validar({"titulo": "Doble", "campos": [{"clave": "x", "etiqueta": "X"}],
        ...          "resultados": [{"etiqueta": "Doble", "formula": "x * 2"}]}, "a1")["titulo"]
        'Doble'
    """
    if not isinstance(datos, dict):
        raise HerramientaInvalida("Formato de herramienta no válido.")
    if not isinstance(identificador, str) or not _ID_VALIDO.match(identificador):
        raise HerramientaInvalida("Identificador de herramienta no válido.")

    campos = [_campo(c, i) for i, c in enumerate(_lista(datos.get("campos"), 1, MAX_CAMPOS, "Campos"), 1)]
    claves = [c["clave"] for c in campos]
    if len(set(claves)) != len(claves):
        raise HerramientaInvalida("Dos campos no pueden usar el mismo nombre en la fórmula.")

    resultados = [
        _resultado(r, i) for i, r in enumerate(_lista(datos.get("resultados"), 1, MAX_RESULTADOS, "Resultados"), 1)
    ]

    return {
        "id": identificador,
        "titulo": _texto(datos.get("titulo"), _MAX_TITULO, "Título", obligatorio=True),
        "descripcion": _texto(datos.get("descripcion"), _MAX_DESCRIPCION, "Descripción"),
        "campos": campos,
        "resultados": resultados,
    }


def normalizarLista(valor) -> list[dict]:
    """Las herramientas guardadas que siguen siendo válidas, en su orden.

    Se usa al leer `ajustes.json`, que puede venir de una importación o de una
    edición a mano: lo que no vale se descarta con un aviso en el log en vez de
    tumbar la página, y un id repetido se queda en la primera aparición.

    Args:
        valor: Lo guardado; cualquier cosa que no sea una lista da una vacía.

    Returns:
        Las herramientas válidas, con `MAX_HERRAMIENTAS` como tope.
    """
    if not isinstance(valor, list):
        return []
    limpias, vistos = [], set()
    for crudo in valor:
        if len(limpias) >= MAX_HERRAMIENTAS:
            break
        identificador = crudo.get("id") if isinstance(crudo, dict) else None
        if not isinstance(identificador, str) or identificador in vistos:
            continue
        try:
            herramienta = validar(crudo, identificador)
        except HerramientaInvalida as error:
            log.warning("[herramientas] Se descarta una herramienta guardada (%s): %s", identificador, error)
            continue
        vistos.add(identificador)
        limpias.append(herramienta)
    return limpias


def _nuevoId(existentes: set) -> str:
    """Id corto y aleatorio que no choca con ninguno de los existentes."""
    while True:
        candidato = secrets.token_hex(4)
        if candidato not in existentes:
            return candidato


def crear(lista: list[dict], datos) -> tuple[list[dict], dict]:
    """Añade una herramienta al final.

    Args:
        lista: Las herramientas actuales (no se modifica).
        datos: La herramienta nueva, sin id.

    Returns:
        `(listaNueva, herramienta)`.

    Raises:
        HerramientaInvalida: si los datos no valen o ya se llegó al tope.
    """
    if len(lista) >= MAX_HERRAMIENTAS:
        raise HerramientaInvalida(f"Como mucho {MAX_HERRAMIENTAS} herramientas propias.")
    herramienta = validar(datos, _nuevoId({h["id"] for h in lista}))
    return [*lista, herramienta], herramienta


def actualizar(lista: list[dict], identificador: str, datos) -> tuple[list[dict], dict]:
    """Sustituye la herramienta `identificador` conservando su posición.

    Raises:
        HerramientaNoEncontrada: si no existe.
        HerramientaInvalida: si los datos no valen.
    """
    posicion = _posicion(lista, identificador)
    herramienta = validar(datos, identificador)
    nueva = list(lista)
    nueva[posicion] = herramienta
    return nueva, herramienta


def borrar(lista: list[dict], identificador: str) -> list[dict]:
    """Quita la herramienta `identificador`.

    Raises:
        HerramientaNoEncontrada: si no existe.
    """
    posicion = _posicion(lista, identificador)
    return lista[:posicion] + lista[posicion + 1:]


def _posicion(lista: list[dict], identificador: str) -> int:
    for posicion, herramienta in enumerate(lista):
        if herramienta["id"] == identificador:
            return posicion
    raise HerramientaNoEncontrada(identificador)


__all__ = [
    "CLAVE",
    "FORMATOS",
    "HerramientaInvalida",
    "HerramientaNoEncontrada",
    "actualizar",
    "borrar",
    "crear",
    "normalizarLista",
    "validar",
]
