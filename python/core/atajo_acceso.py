"""Quién puede escribir por los endpoints del Atajo, decidido desde Ajustes.

Esos endpoints no pueden llevar cookie —un Atajo de iOS no mantiene sesión—, así
que se defienden con dos barreras: **de dónde llega** la petición (el filtro de
red de `red_local.py`) y **quién la firma** (el HMAC de `firma_hmac.py`). Este
módulo guarda lo que el usuario decida sobre las dos desde la interfaz.

**Por qué se puede quitar la firma.** Porque la alternativa real no es «con firma
o sin firma», es «con firma o sin Atajo». La firma exige que el iPhone tenga la
clave, y cuando esa clave se pierde —una reinstalación, un backup que no la
llevaba— lo que ocurre no es que alguien entre, es que el usuario se queda sin
apuntar gastos hasta que vuelva a montarlo todo. Poder aflojar esa barrera
sabiendo lo que se afloja es mejor que no poder usarlo. Queda una barrera, y
sigue siendo obligatoria: sin redes permitidas no entra nadie.

**Lo que se pierde al quitarla.** Cualquiera que alcance el puerto desde una de
las redes permitidas puede escribir movimientos: la petición ya no prueba quién
la manda, solo desde dónde viene. En una LAN doméstica eso es «quien esté en tu
wifi»; con un rango ancho puesto ahí, bastante más. Por eso el valor de fábrica
es exigirla, el cambio se avisa en el log al arrancar y la interfaz lo dice sin
adornos.

**Dónde vive.** En `data/atajo/acceso.json`, no en config.ini, por lo mismo que
el estado del HTTPS: es una decisión tomada desde la interfaz, y config.ini está
versionado y se sobrescribe en cada `git pull`. `[atajo] redes_permitidas` sigue
siendo el valor por defecto —y el único que hay en una instalación sin tocar—;
lo que se guarde aquí manda sobre él.
"""

import ipaddress
import json
import logging
from datetime import UTC, datetime

from core import paths, settings

log = logging.getLogger(__name__)

ATAJO_DIR = paths.DATA_DIR / "atajo"
ACCESO_FILE = ATAJO_DIR / "acceso.json"

# Tope de rangos. No hay límite técnico, pero una lista larga aquí suele ser un
# pegado que no se ha revisado, y esto decide quién puede escribir.
MAX_REDES = 20

_POR_DEFECTO = {"exigirFirma": True, "redes": [], "actualizado": None}


def leer() -> dict:
    """Lo guardado, o los valores de fábrica si no hay fichero.

    Nunca lanza: esto lo consulta cada petición del Atajo, y un JSON corrupto no
    puede tumbar el endpoint. Un fichero ilegible se lee como «exige firma»,
    que es el estado cerrado: si algo va mal, que vaya mal hacia el lado seguro.
    """
    try:
        datos = json.loads(ACCESO_FILE.read_text("utf-8"))
    except FileNotFoundError:
        return dict(_POR_DEFECTO)
    except (OSError, ValueError) as e:
        log.warning("[atajo] acceso.json ilegible (%s); se exige firma", e)
        return dict(_POR_DEFECTO)

    if not isinstance(datos, dict):
        return dict(_POR_DEFECTO)

    return {
        # `is not False` y no `bool(...)`: un fichero al que le falte la clave
        # tiene que caer en «exige firma», no en «no la exige».
        "exigirFirma": datos.get("exigirFirma") is not False,
        "redes": [str(r) for r in datos.get("redes", []) if str(r).strip()],
        "actualizado": datos.get("actualizado"),
    }


def guardar(exigirFirma: bool, redes: list[str]) -> dict:
    estado = {
        "exigirFirma": bool(exigirFirma),
        "redes": list(redes),
        "actualizado": datetime.now(UTC).isoformat(timespec="seconds"),
    }
    ATAJO_DIR.mkdir(parents=True, exist_ok=True)
    # Escritura atómica: un corte a medias dejaría un JSON truncado, y este
    # fichero decide quién puede escribir en la base de datos.
    tmp = ACCESO_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(estado, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(ACCESO_FILE)
    return estado


def exigirFirma() -> bool:
    """¿Hay que verificar el HMAC de las peticiones del Atajo?"""
    return leer()["exigirFirma"]


def normalizarRedes(redes) -> list[str]:
    """Limpia la lista que llega de la interfaz y descarta lo que no es una red.

    Se guarda el texto normalizado por `ipaddress` y no el que se escribió: así
    `192.168.1.5/24` queda como `192.168.1.0/24`, que es lo que de verdad se va
    a comparar, en vez de dejar al usuario creyendo que ha permitido una IP
    suelta cuando ha permitido la red entera.
    """
    limpias = []
    for bruto in redes or []:
        texto = str(bruto).strip()
        if not texto:
            continue
        try:
            # strict=False acepta "192.168.1.5/24" además de "192.168.1.0/24".
            red = ipaddress.ip_network(texto, strict=False)
        except ValueError:
            continue
        if str(red) not in limpias:
            limpias.append(str(red))
    return limpias


def redesEfectivas() -> list[str]:
    """Los rangos que se están aplicando, vengan de donde vengan.

    Lo guardado desde la interfaz manda; si ahí no hay nada, el de config.ini.
    Vaciar la lista en el panel no es «no permitir a nadie», es «vuelve a lo que
    diga la configuración»: dejar que la interfaz cierre la puerta del todo sería
    ofrecer un botón cuyo único efecto es romper el Atajo sin avisar.
    """
    propias = leer()["redes"]
    if propias:
        return propias
    return [str(r) for r in settings.obtener("atajo.redes_permitidas")]


def origenDeLasRedes() -> str:
    """De dónde salen los rangos que se aplican, para poder decirlo en el panel."""
    return "ajustes" if leer()["redes"] else "config"


def avisoSinFirma() -> str | None:
    """Recordatorio de que la firma está desactivada, o None si se exige.

    Fuera de `settings.validar()` a propósito, igual que el aviso de HTTPS: allí
    van las configuraciones **mal** puestas, y esta no lo está —es una decisión
    tomada a sabiendas—. Pero es lo que hay que ver escrito al arrancar, porque
    desde fuera no se distingue de un servidor que sí comprueba quién escribe.
    """
    if exigirFirma():
        return None

    return (
        "Atajo sin firma: las peticiones de /api/movimiento se aceptan sin "
        f"comprobar quién las manda. La única barrera son las redes permitidas "
        f"({', '.join(redesEfectivas()) or 'ninguna'}): quien alcance el puerto "
        "desde ahí puede escribir movimientos. Se vuelve a exigir en "
        "Ajustes > API > Atajo de iOS."
    )
