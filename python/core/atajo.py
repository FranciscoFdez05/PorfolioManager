"""Lo que Ajustes > API necesita saber y poder hacer con el Atajo de iOS.

El Atajo tenía todas las piezas repartidas por sitios que no se ven desde la
interfaz: la clave en `API/movimientos.key`, el interruptor y las redes en
`config.ini`, y el diagnóstico solo en el log del servidor. Cuando algo fallaba
—y lo que falla casi siempre es que no hay clave— la única forma de enterarse
era entrar por SSH a leer `docker compose logs`.

Aquí vive lo que hace falta para contarlo y arreglarlo desde el panel:

    estado()      qué hay puesto y qué falta
    generarClave() crear o rehacer la clave de firma
    probar()      recorrer el camino del Atajo sin escribir en la base de datos

Nada de esto habla con el iPhone: son comprobaciones del propio servidor sobre
sí mismo. La que sí sale a la red es la del Atajo, y para esa lo único que puede
hacer el panel es dejarlo todo listo.
"""

import json
import logging
import os
import time

from core import atajo_acceso, firma_hmac, red_local, settings
from core.secret_store import read_secret_lines
from stores.movimientos_store import DatosMovimientoInvalidos, sanitizarMovimiento

log = logging.getLogger(__name__)

# Movimiento de mentira con el que se recorre el camino en `probar()`. Los
# valores no llegan a ninguna base de datos: solo pasan por el validador y por
# la firma, que es donde están los fallos que se quieren cazar.
_EJEMPLO = {
    "tipo": "gasto",
    "categoria": "Prueba",
    "nombre": "Comprobación del Atajo",
    "importe": 1.23,
}


def _estadoDeLaClave() -> dict:
    """De dónde sale la clave de firma, o por qué no hay ninguna.

    Distingue «no existe» de «existe pero no se puede descifrar», que es la
    diferencia entre dos averías con soluciones opuestas: generar una clave
    nueva, o recuperar la `SECRET_KEY` con la que se cifró. Vistas desde el log
    eran idénticas, porque las dos acaban en una lista de claves vacía.
    """
    if os.environ.get(firma_hmac.ENV_CLAVE, "").strip():
        return {"hay": True, "origen": "entorno", "detalle": firma_hmac.ENV_CLAVE}

    ruta = firma_hmac.rutaFicheroClave()

    if read_secret_lines(ruta):
        return {"hay": True, "origen": "fichero", "detalle": ruta.name}

    if ruta.exists():
        return {
            "hay": False,
            "origen": "ilegible",
            "detalle": (
                f"{ruta.name} existe pero no se puede descifrar. Suele ser que la "
                "SECRET_KEY del .env ha cambiado desde que se guardó; si no la "
                "recuperas, genera una clave nueva y vuelve a montar el Atajo."
            ),
        }

    return {"hay": False, "origen": "ninguna", "detalle": ruta.name}


def estado(urlBase: str = "") -> dict:
    """Todo lo que el panel pinta de un vistazo."""
    return {
        "activado": bool(red_local.atajoActivado()),
        "clave": _estadoDeLaClave(),
        # En texto: son los CIDR tal y como los entiende el filtro, que es lo
        # que hay que comparar con la IP que sale rechazada en el log.
        "redes": [str(red) for red in red_local.leerRedesPermitidas()],
        "tolerancia": firma_hmac.toleranciaSegundos(),
        "urlBase": urlBase,
        # Con qué política se están aceptando las peticiones ahora mismo. El
        # panel lo necesita entero: si la firma no se exige, la red de origen es
        # la única barrera que queda y hay que poder verla y cambiarla ahí.
        "acceso": {
            "exigirFirma": atajo_acceso.exigirFirma(),
            "origenRedes": atajo_acceso.origenDeLasRedes(),
            "redesConfig": [str(r) for r in settings.obtener("atajo.redes_permitidas")],
        },
    }


def generarClave() -> str:
    """Crea una clave de firma nueva y la guarda cifrada. Devuelve el fichero.

    Rehacerla invalida las firmas anteriores, pero **no obliga a rehacer el
    Atajo**: el Atajo no guarda la clave, la pide a `/api/preparar` en cada
    ejecución. Por eso el panel puede ofrecer el botón sin letra pequeña.
    """
    ruta = firma_hmac.rutaFicheroClave()
    firma_hmac.escribirClaveNueva(ruta)
    log.info("[atajo] Clave de firma generada en %s", ruta.name)
    return ruta.name


def probar() -> dict:
    """Recorre el camino del Atajo sin tocar la base de datos.

    Los cuatro pasos son los mismos que hace una petición real, en el mismo
    orden, y se paran en el primero que falle: así el resultado señala **la**
    avería en vez de una lista de síntomas. Lo único que no se hace es el
    INSERT, porque una prueba que deje un gasto de mentira en el portfolio no se
    puede repetir sin ensuciar los datos.
    """
    pasos = []

    def _paso(titulo, ok, detalle=""):
        pasos.append({"paso": titulo, "ok": bool(ok), "detalle": detalle})
        return ok

    if not _paso(
        "La función está activada",
        red_local.atajoActivado(),
        "" if red_local.atajoActivado() else "[atajo] activado = false en config.ini: los endpoints responden 404.",
    ):
        return {"ok": False, "pasos": pasos}

    redes = red_local.leerRedesPermitidas()
    if not _paso(
        "Hay redes permitidas",
        redes,
        ", ".join(str(r) for r in redes) or "[atajo] redes_permitidas está vacío: no se acepta a nadie.",
    ):
        return {"ok": False, "pasos": pasos}

    if not atajo_acceso.exigirFirma():
        # Sin firma no hay clave que comprobar ni firma que verificar, así que
        # seguir sería inventarse un fallo: el camino de verdad termina aquí.
        # Se dice lo que queda en pie, que es lo que el usuario tiene que poder
        # leer sin ir a buscarlo a otra pantalla.
        _paso(
            "La firma no se exige",
            True,
            "Las peticiones se aceptan sin comprobar quién las manda: la única "
            "barrera son las redes de arriba. Se vuelve a exigir en este mismo panel.",
        )
        return {"ok": True, "pasos": pasos}

    clave = _estadoDeLaClave()
    if not _paso("Hay clave de firma", clave["hay"], clave["detalle"]):
        return {"ok": False, "pasos": pasos}

    # Firmar y verificar con el mismo camino que usa /api/movimiento. Cazaría
    # una clave ilegible o un reloj imposible antes de que lo haga el iPhone.
    try:
        movimiento = sanitizarMovimiento(dict(_EJEMPLO))
        cuerpo = json.dumps(
            {k: (str(v) if k != "importe" else v) for k, v in _EJEMPLO.items()},
            sort_keys=True,
            separators=(",", ":"),
        )
        marca = int(time.time())
        firma = firma_hmac.calcularFirma(firma_hmac.construirMensaje(marca, cuerpo))
        firma_hmac.verificarPeticionFirmada(
            {firma_hmac.CABECERA_FIRMA: firma, firma_hmac.CABECERA_TIMESTAMP: str(marca)},
            cuerpo,
        )
        _paso("Firma y verificación", True, f"Movimiento de prueba válido: {movimiento['nombre']}")
    except (firma_hmac.ErrorFirma, DatosMovimientoInvalidos) as e:
        _paso("Firma y verificación", False, str(e))
        return {"ok": False, "pasos": pasos}

    return {"ok": True, "pasos": pasos}
