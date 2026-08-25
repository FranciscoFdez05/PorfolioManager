# Contribuir

Es un proyecto personal, pero las issues y los PR son bienvenidos. Esto es lo que hace falta saber para que un cambio entre sin idas y venidas.

## Antes de empezar

Para un **fallo**, abre una issue con la versión (`GET /api/health` la devuelve) y los pasos para reproducirlo. Si es de seguridad, no la abras: mira [SECURITY.md](SECURITY.md).

Para una **funcionalidad nueva**, coméntala en una issue antes de escribir código. La aplicación cubre un caso de uso concreto —una cartera personal, un usuario, fiscalidad española— y no todo lo que encaja técnicamente encaja ahí.

## Poner en marcha el entorno

```bash
pip install -r requirements.txt -r requirements-dev.txt
npm ci
```

```bash
pytest -m "not network"    # backend, sin salir a internet
npm test                   # frontend
ruff check .               # lint de Python
npm run lint               # lint de JavaScript
npm run format             # prettier sobre js/ y css/
```

Los cuatro tienen que pasar; es lo mismo que corre CI.

**Las pruebas no tocan `data/` jamás.** Usan una base temporal vía `set_active_db_path()` y no importan `server`, porque ese módulo inicializa los portfolios reales al importarse: una prueba mal montada te borraría tu propia cartera. Si necesitas la capa HTTP, `tests/conftest.py` da `crear_app` y `cliente_autenticado`.

## Convenciones

**Los comentarios explican el _porqué_, no el _qué_.** Es la convención más visible del repositorio: si abres cualquier módulo verás que los comentarios largos cuentan qué se intentó antes, qué falló y por qué la solución es la que es. Un comentario que repite lo que dice el código sobra; uno que explica por qué el redondeo es `ROUND_HALF_UP` y no el de fábrica, no.

**El código y los comentarios, en español.** Los nombres de funciones de rutas y stores usan `camelCase` por coherencia con el frontend, y `ruff` tiene desactivadas las reglas de nomenclatura por eso.

**El dinero se calcula en `Decimal`.** Toda conversión entre el texto que guarda SQLite y un número pasa por `core/dinero.py`, que es la única que hay. `float()` solo vale al serializar y sobre un valor ya redondeado; `tests/test_frontera_dinero.py` lo comprueba sobre el AST y fallará si se cuela otra.

**Formato:** Prettier es obligatorio para `js/` y `css/`. Para Python **no** hay formateador: el código alinea asignaciones y comentarios en columnas a propósito y `ruff format` las deshace. `ruff check` sí es obligatorio.

## Pruebas

Un cambio de comportamiento necesita una prueba que falle sin él. Los módulos de cálculo (`fifo`, `fiscal_es`, `informe_renta`, `pnl_divisa`, `rentabilidad`, `dinero`) tienen un umbral de cobertura propio del 90 %: ahí un error no da un fallo visible, da una cifra equivocada en la declaración de la renta.

Las pruebas marcadas `@pytest.mark.network` salen a internet y CI las salta. No pongas ahí nada que deba decidir si un PR pasa.

## Si tocas la base de datos

1. Sube `ESQUEMA_VERSION` en `core/db.py`.
2. Añade el paso con `@_migracion(N)`.
3. Hazlo **idempotente**: una base puede tener aplicada parte de un paso posterior, porque antes de existir el contador todos se ejecutaban en cada arranque.
4. Dilo en el `CHANGELOG.md`, en la línea «Esquema de base de datos:».

Las migraciones son solo hacia delante. La vuelta atrás es restaurar la copia previa que la propia aplicación guarda antes de migrar.

## Commits

Mensajes en español, en imperativo, explicando **qué problema resuelve** el cambio y no solo qué toca. El historial de este repositorio se usa para entender decisiones pasadas, así que un `fix: bug` no vale de nada seis meses después.
