"""Versión de la aplicación, en un único sitio.

Estaba escrita a mano en tres ficheros —`pyproject.toml`, `package.json` y una
constante en `routes/salud.py`— y los tres decían `1.0.0` porque nadie los había
subido nunca. Un número que no se mueve es peor que no tener número: `/api/health`
lo publica, así que informaba de una versión que no significaba nada.

Aquí vive el valor y de aquí lo lee el código. Que los otros dos ficheros digan
lo mismo lo comprueba `tests/test_version.py`, que además exige que la versión
tenga su entrada en el CHANGELOG: publicar sin decir qué cambió es la mitad del
problema que esto resuelve.

**Qué significa cada número** (SemVer, adaptado a que aquí no hay API pública
sino datos de usuario y un despliegue que se actualiza en sitio):

* **MAYOR** — la actualización necesita una intervención manual: mover ficheros,
  reconfigurar algo, o una migración que no se puede deshacer restaurando el
  backup previo.
* **MENOR** — funcionalidad nueva. Puede subir `ESQUEMA_VERSION`; la migración
  se aplica sola al arrancar y el backup previo permite volver atrás.
* **PARCHE** — correcciones. No toca el esquema.

Al subir la versión hay que tocar, en el mismo commit: este fichero,
`pyproject.toml`, `package.json`, el badge del `README.md` y `CHANGELOG.md`. El
test falla si falta alguno.
"""

__version__ = "1.4.1"

# La plantilla `index.html` lleva este marcador donde va la versión, y lo
# sustituye el servidor al servirla. Se hace así, y no con una petición del
# navegador a /api/health, porque la versión no cambia mientras la página está
# abierta: pedirla aparte sería una llamada más en cada carga y un hueco visible
# hasta que llegara la respuesta.
MARCADOR_VERSION = "__APP_VERSION__"


def insertar_version(html: str) -> str:
    """Sustituye el marcador de la plantilla por la versión en curso."""
    return html.replace(MARCADOR_VERSION, __version__)


__all__ = ["MARCADOR_VERSION", "__version__", "insertar_version"]
