"""Forma admitida de los datos de Análisis > Seguimiento guardados por portfolio.

La lista propia, los activos ocultos y los símbolos retocados vivían en el
`localStorage` del navegador: no entraban en las copias de seguridad y se perdían
al cambiar de navegador. Ahora van en `prefs_<id>.json`, así que cada portfolio
tiene los suyos y viajan con él en copias, exportaciones e importaciones.

Es un JSON que construye el navegador o que llega dentro de un ZIP ajeno: aquí se
le da forma, igual que hace `stores.paneles_config` con los paneles.
"""

import json
import logging
import re

log = logging.getLogger(__name__)

CLAVE_LISTA = "seguimientoLista"
CLAVE_OCULTOS = "seguimientoOcultos"
CLAVE_OVERRIDES = "seguimientoOverrides"
# Orden de las tarjetas elegido arrastrándolas: `_segId` de cada una. Nunca vivió
# en el navegador, así que no tiene clave antigua que migrar ni que fusionar.
CLAVE_ORDEN = "seguimientoOrden"
# Listas con nombre que son subconjuntos de la de Seguimiento: `{idLista: {nombre,
# ids}}`, con los `_segId` de sus activos. Los mapas de Activos > Paneles eligen
# cuál enseñar. Tampoco vivió nunca en el navegador.
CLAVE_LISTAS = "seguimientoListas"

MAX_ELEMENTOS = 2000
MAX_LISTAS = 50
_MAX_CLAVE = 40
_MAX_NOMBRE_LISTA = 60
_MAX_TEXTO = 5000

# Nombres que usaba el navegador. El sufijo es el portfolio; sin él, es una clave
# de versiones anteriores a separar los datos por portfolio.
_RE_CLAVE_NAVEGADOR = re.compile(r"^seguimiento(List|Hidden|Overrides)(?:_(.+))?$")
_CAMPO_DE_CLAVE = {"List": CLAVE_LISTA, "Hidden": CLAVE_OCULTOS, "Overrides": CLAVE_OVERRIDES}


def _plano(elemento: dict) -> dict:
    """Solo los campos planos y de tamaño razonable: nada anidado infla el fichero."""
    return {
        clave: valor
        for clave, valor in elemento.items()
        if isinstance(clave, str) and len(clave) <= _MAX_CLAVE
        and (valor is None or isinstance(valor, (bool, int, float))
             or (isinstance(valor, str) and len(valor) <= _MAX_TEXTO))
    }


def _identidad(elemento: dict) -> str:
    """Lo que identifica una entrada de la lista; las muy antiguas no llevan `_segId`."""
    return str(elemento.get("_segId") or elemento.get("nombre") or "")


def normalizarLista(valor) -> list[dict]:
    """La lista propia de Seguimiento, sin entradas sin identificar ni repetidas.

    Args:
        valor: Lo recibido; cualquier cosa que no sea una lista da una lista vacía.

    Returns:
        Las entradas válidas, en su orden y con `MAX_ELEMENTOS` como tope.
    """
    if not isinstance(valor, list):
        return []
    limpia, vistas = [], set()
    for elemento in valor:
        if not isinstance(elemento, dict):
            continue
        plano = _plano(elemento)
        identidad = _identidad(plano)
        if identidad and identidad not in vistas and len(limpia) < MAX_ELEMENTOS:
            vistas.add(identidad)
            limpia.append(plano)
    return limpia


def normalizarOcultos(valor) -> list[str]:
    """Los identificadores ocultos, sin repetidos y en su orden."""
    if not isinstance(valor, list):
        return []
    textos = [t for t in valor if isinstance(t, str) and t.strip() and len(t) <= _MAX_TEXTO]
    return list(dict.fromkeys(textos))[:MAX_ELEMENTOS]


def normalizarOrden(valor) -> list[str]:
    """El orden de las tarjetas: identificadores sin repetidos, en su orden.

    Tiene la misma forma que los ocultos (lista de `_segId`), así que se valida igual.

    Args:
        valor: Lo recibido; cualquier cosa que no sea una lista da una lista vacía.

    Returns:
        Los identificadores válidos, con `MAX_ELEMENTOS` como tope.
    """
    return normalizarOcultos(valor)


def normalizarListas(valor) -> dict[str, dict]:
    """Las listas con nombre de Seguimiento: `{idLista: {"nombre": str, "ids": [str]}}`.

    Una lista sin identificador o sin nombre se descarta; los `_segId` repetidos
    de una lista se quedan en uno. No se comprueba que los activos existan: uno
    quitado de Seguimiento deja su id aquí y el navegador lo ignora, igual que
    hace con el orden de las tarjetas.

    Args:
        valor: Lo recibido; cualquier cosa que no sea un diccionario da uno vacío.

    Returns:
        Las listas válidas, en su orden y con `MAX_LISTAS` como tope.

    Example:
        >>> normalizarListas({"a": {"nombre": " Cripto ", "ids": ["x", "x"]}})
        {'a': {'nombre': 'Cripto', 'ids': ['x']}}
    """
    if not isinstance(valor, dict):
        return {}
    limpias: dict[str, dict] = {}
    for idLista, lista in valor.items():
        if len(limpias) >= MAX_LISTAS:
            break
        if not isinstance(idLista, str) or not idLista.strip() or len(idLista) > _MAX_CLAVE:
            continue
        if not isinstance(lista, dict) or not isinstance(lista.get("nombre"), str):
            continue
        nombre = lista["nombre"].strip()[:_MAX_NOMBRE_LISTA]
        if nombre:
            limpias[idLista] = {"nombre": nombre, "ids": normalizarOcultos(lista.get("ids"))}
    return limpias


def normalizarOverrides(valor) -> dict:
    """Los retoques por activo: `{segId: {campo: valor}}`, con campos planos."""
    if not isinstance(valor, dict):
        return {}
    pares = [(k, _plano(v)) for k, v in valor.items() if isinstance(k, str) and isinstance(v, dict)]
    return dict(pares[:MAX_ELEMENTOS])


def fusionar(prefs: dict, entrante: dict) -> dict:
    """`prefs` con lo de `entrante` añadido; si algo está en los dos, manda `prefs`.

    Fusiona y no sustituye porque cada navegador tenía su propia lista: traer la
    de uno no debe borrar lo que otro ya subió.

    Args:
        prefs: Preferencias actuales del portfolio.
        entrante: Datos con las mismas claves `seguimiento*`, sin validar.

    Returns:
        Copia de `prefs` con los tres campos de Seguimiento ya fusionados.

    Example:
        >>> fusionar({CLAVE_OCULTOS: ["a"]}, {CLAVE_OCULTOS: ["a", "b"]})[CLAVE_OCULTOS]
        ['a', 'b']
    """
    lista = normalizarLista(prefs.get(CLAVE_LISTA))
    presentes = {_identidad(e) for e in lista}
    nuevas = [e for e in normalizarLista(entrante.get(CLAVE_LISTA)) if _identidad(e) not in presentes]
    return {
        **prefs,
        CLAVE_LISTA: (lista + nuevas)[:MAX_ELEMENTOS],
        CLAVE_OCULTOS: normalizarOcultos(
            normalizarOcultos(prefs.get(CLAVE_OCULTOS)) + normalizarOcultos(entrante.get(CLAVE_OCULTOS))
        ),
        CLAVE_OVERRIDES: {
            **normalizarOverrides(entrante.get(CLAVE_OVERRIDES)),
            **normalizarOverrides(prefs.get(CLAVE_OVERRIDES)),
        },
    }


def _datosDeUi(ui: dict) -> dict:
    """`{portfolio o None: {campo: valor}}` con las claves de Seguimiento que se puedan leer."""
    porPortfolio = {}
    for clave, crudo in ui.items():
        coincide = _RE_CLAVE_NAVEGADOR.match(clave)
        if not coincide:
            continue
        try:
            valor = json.loads(crudo)
        except (TypeError, ValueError):
            log.warning("[seguimiento] Se ignora %s: no es JSON válido", clave)
            continue
        porPortfolio.setdefault(coincide.group(2), {})[_CAMPO_DE_CLAVE[coincide.group(1)]] = valor
    return porPortfolio


def separarDeUi(ui: dict, pidOrigen: str | None) -> tuple[dict | None, dict]:
    """Saca de un volcado de `localStorage` los datos de Seguimiento del portfolio exportado.

    Los ZIP anteriores volcaban el `localStorage` entero, con las listas de todos
    los portfolios de ese navegador. Solo vale la del exportado: las demás no
    pueden acabar en el perfil de destino. Si no se sabe cuál es y hay más de una,
    no se adivina.

    Args:
        ui: Volcado ya saneado (`exportables.sanearUi`).
        pidOrigen: Portfolio del que salió el ZIP, si se conoce.

    Returns:
        `(datos, resto)`: los datos para `fusionar`, o None si no hay ninguno que
        se pueda atribuir, y el volcado sin ninguna clave de Seguimiento.
    """
    resto = {clave: valor for clave, valor in ui.items() if not _RE_CLAVE_NAVEGADOR.match(clave)}
    porPortfolio = _datosDeUi(ui)
    if pidOrigen in porPortfolio:
        return porPortfolio[pidOrigen], resto
    if len(porPortfolio) == 1:
        return next(iter(porPortfolio.values())), resto
    if porPortfolio:
        log.warning("[seguimiento] El ZIP trae listas de varios portfolios y no se sabe cuál es: se ignoran")
    return None, resto
