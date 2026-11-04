"""Vigilancia de todas las monedas de Satoshi Nakamoto, bloque a bloque.

Satoshi minó unas 22.000 monedas de 50 BTC (los bloques «Patoshi») y casi
ninguna se ha movido. Seguirlas como wallets sueltas serían 22.000 consultas en
cada revisión. Aquí se parte de una foto de las que siguen sin gastar
(`core/datos/satoshi_monedas.csv.gz`, generada con
`tools/generar_satoshi_monedas.py`) y solo se mira cada bloque nuevo: unos 144
al día, dos peticiones cada uno. Si alguno gasta una de esas monedas, se apunta,
se descuenta del saldo y se avisa por Telegram.

El estado (hasta qué bloque se ha mirado, qué monedas se han movido y si está
activado) va en `API/satoshi_vigilancia.json`: son datos públicos de la cadena,
sin cifrar, como las wallets ajenas.
"""

import csv
import gzip
import json
import logging
from collections.abc import Callable
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path

from core import bloqueo, paths, telegram_notifier
from core.escritura import escribirAtomico
from providers.bitcoin_bloques import LectorBloques, gastosDeBloque

log = logging.getLogger(__name__)

RUTA_FOTO = Path(__file__).resolve().parent / "datos" / "satoshi_monedas.csv.gz"
NOMBRE_ESTADO = "satoshi_vigilancia.json"
CATEGORIA_AVISO = "wallets"
# Bloques por pasada: al día salen ~144 y la pasada es cada pocos minutos, así
# que alcanza de sobra; si el servidor estuvo apagado, se pone al día poco a poco
# en vez de bajar cientos de megas de golpe.
MAX_BLOQUES_POR_PASADA = 6
MAX_GASTADAS_GUARDADAS = 5000
SATOSHIS_POR_BTC = 100_000_000
_ESPERA_BLOQUEO_SEGUNDOS = 5.0
_EXPLORADOR_TX = "https://mempool.space/tx/{txid}"


class FotoNoDisponible(RuntimeError):
    """No está el fichero con las monedas de Satoshi o no se puede leer."""


@dataclass(frozen=True)
class FotoMonedas:
    """Las monedas de Satoshi sin gastar en el bloque `altura`.

    `monedas` va de (txid, salida) a (altura del bloque en que se minó, satoshis).
    """

    altura: int
    fecha: str
    claves: int
    monedas: dict[tuple[str, int], tuple[int, int]]

    @property
    def satoshis(self) -> int:
        return sum(satoshis for _, satoshis in self.monedas.values())


@dataclass(frozen=True)
class EstadoSatoshi:
    """Lo que recuerda el vigilante entre pasadas."""

    activo: bool = False
    avisos: bool = True
    # Último bloque revisado. 0: todavía ninguno (se empieza tras la foto).
    altura: int = 0
    ultimaRevision: str = ""
    error: str = ""
    # Una entrada por moneda movida: txid, vout, satoshis, alturaOrigen,
    # alturaGasto, txGasto y fecha en que se detectó.
    gastadas: list = field(default_factory=list)


@lru_cache(maxsize=4)
def leerFoto(ruta: Path = RUTA_FOTO) -> FotoMonedas:
    """La foto de monedas sin gastar. Se lee una vez por proceso.

    Raises:
        FotoNoDisponible: si falta el fichero o no tiene la forma esperada.
    """
    try:
        with gzip.open(ruta, "rt", encoding="utf-8", newline="") as fichero:
            cabecera = dict(parte.split("=", 1) for parte in fichero.readline().lstrip("# ").split() if "=" in parte)
            filas = csv.DictReader(fichero)
            monedas = {(f["txid"], int(f["vout"])): (int(f["altura"]), int(f["satoshis"])) for f in filas}
        return FotoMonedas(int(cabecera["altura"]), cabecera.get("fecha", ""), int(cabecera.get("claves", 0)), monedas)
    except FileNotFoundError as error:
        raise FotoNoDisponible(
            "Falta la foto de las monedas de Satoshi: genérala con tools/generar_satoshi_monedas.py"
        ) from error
    except (OSError, ValueError, KeyError) as error:
        raise FotoNoDisponible(f"No se puede leer {ruta.name}: {error}") from error


class SatoshiEstadoRepository:
    """Lectura y escritura atómica del estado, con bloqueo entre procesos.

    Args:
        ruta: Fichero de estado. Por defecto `API_DIR/satoshi_vigilancia.json`,
            resuelto en cada llamada para que los tests puedan redirigir API/.
    """

    def __init__(self, ruta: Path | None = None) -> None:
        self._ruta = ruta

    @property
    def ruta(self) -> Path:
        return self._ruta if self._ruta is not None else paths.API_DIR / NOMBRE_ESTADO

    def leer(self) -> EstadoSatoshi:
        """El estado guardado, o el inicial si no hay. Un fichero dañado cuenta como inicial."""
        try:
            datos = json.loads(self.ruta.read_text(encoding="utf-8"))
            conocidos = EstadoSatoshi.__dataclass_fields__
            return EstadoSatoshi(**{k: v for k, v in datos.items() if k in conocidos})
        except FileNotFoundError:
            return EstadoSatoshi()
        except (OSError, ValueError, TypeError) as error:
            # Perderlo solo cuesta volver a mirar desde la foto: no se bloquea nada.
            log.warning("[satoshi] %s ilegible, se empieza de nuevo: %s", NOMBRE_ESTADO, error)
            return EstadoSatoshi()

    def restaurar(self, datos: dict) -> EstadoSatoshi:
        """Sustituye el estado por el de una copia.

        Args:
            datos: `EstadoSatoshi` como dict; viene de un ZIP, así que no se da por bueno.

        Returns:
            El estado ya guardado.

        Raises:
            ValueError: si `datos` no tiene la forma esperada.
        """
        conocidos = EstadoSatoshi.__dataclass_fields__
        if not isinstance(datos, dict):
            raise ValueError("estado de Satoshi no válido")
        estado = EstadoSatoshi(**{k: v for k, v in datos.items() if k in conocidos})
        if not (isinstance(estado.activo, bool) and isinstance(estado.avisos, bool)
                and isinstance(estado.altura, int) and isinstance(estado.gastadas, list)):
            raise ValueError("estado de Satoshi no válido")
        return self.modificar(lambda _anterior: estado)

    def modificar(self, cambio: Callable[[EstadoSatoshi], EstadoSatoshi]) -> EstadoSatoshi:
        """Lee, aplica `cambio` y guarda, todo bajo el bloqueo."""
        self.ruta.parent.mkdir(parents=True, exist_ok=True)
        with bloqueo.exclusivo(self.ruta.with_name(f".{NOMBRE_ESTADO}.lock"), espera=_ESPERA_BLOQUEO_SEGUNDOS):
            nuevo = cambio(self.leer())
            escribirAtomico(self.ruta, json.dumps(asdict(nuevo), ensure_ascii=False, indent=1).encode("utf-8"))
        return nuevo


def _btc(satoshis: int) -> str:
    entero, resto = divmod(satoshis, SATOSHIS_POR_BTC)
    return f"{entero:,}".replace(",", ".") + (f",{resto:08d}".rstrip("0").rstrip(",") if resto else "")


def textoAviso(gastadas: list[dict]) -> str:
    """El mensaje de Telegram por las monedas movidas en un mismo bloque."""
    total = sum(g["satoshis"] for g in gastadas)
    lineas = [f"Se han movido monedas de Satoshi Nakamoto: {len(gastadas)} ({_btc(total)} BTC) "
              f"en el bloque {gastadas[0]['alturaGasto']:,}".replace(",", ".")]
    for gastada in gastadas[:10]:
        lineas.append(f"· Minada en el bloque {gastada['alturaOrigen']}: {_btc(gastada['satoshis'])} BTC")
    if len(gastadas) > 10:
        lineas.append(f"· y {len(gastadas) - 10} más")
    for txGasto in dict.fromkeys(g["txGasto"] for g in gastadas):
        lineas.append(_EXPLORADOR_TX.format(txid=txGasto))
    return "\n".join(lineas)


class VigilanteSatoshi:
    """Revisa bloques nuevos en busca de monedas de Satoshi gastadas. Dependencias inyectables.

    Args:
        repositorio: Estado guardado.
        lector: Altura y bloques en bruto de Esplora.
        foto: Devuelve la foto de monedas sin gastar.
        notificar: `(categoria, texto) -> bool` que manda el aviso.
        ahora: Hora actual en UTC.
        maxBloques: Bloques como mucho por pasada.
    """

    def __init__(
        self,
        repositorio: SatoshiEstadoRepository | None = None,
        lector: LectorBloques | None = None,
        foto: Callable[[], FotoMonedas] = leerFoto,
        notificar: Callable[[str, str], bool] | None = None,
        ahora: Callable[[], datetime] | None = None,
        maxBloques: int = MAX_BLOQUES_POR_PASADA,
    ) -> None:
        self._repositorio = repositorio or SatoshiEstadoRepository()
        self._lector = lector or LectorBloques()
        self._foto = foto
        self._notificar = notificar or telegram_notifier.notificar
        self._ahora = ahora or (lambda: datetime.now(UTC))
        self._maxBloques = maxBloques

    def resumen(self) -> dict:
        """Saldo real, monedas, hasta dónde se ha mirado y las monedas movidas.

        Raises:
            FotoNoDisponible: si no hay foto.
        """
        foto = self._foto()
        estado = self._repositorio.leer()
        # Solo cuentan las que están en esta foto: si se regenera más adelante,
        # las movidas antes ya no vienen en ella.
        gastadas = [g for g in estado.gastadas if (g["txid"], g["vout"]) in foto.monedas]
        satoshis = foto.satoshis - sum(g["satoshis"] for g in gastadas)
        return {
            "activo": estado.activo,
            "avisos": estado.avisos,
            "satoshis": satoshis,
            "btc": f"{satoshis / SATOSHIS_POR_BTC:.8f}",
            "monedas": len(foto.monedas) - len(gastadas),
            "monedasFoto": len(foto.monedas),
            "claves": foto.claves,
            "alturaFoto": foto.altura,
            "fechaFoto": foto.fecha,
            "alturaRevisada": max(estado.altura, foto.altura),
            "ultimaRevision": estado.ultimaRevision,
            "error": estado.error,
            "gastadas": sorted(gastadas, key=lambda g: -g["alturaGasto"])[:50],
        }

    def ajustar(self, activo: bool | None = None, avisos: bool | None = None) -> dict:
        """Enciende o apaga la vigilancia o sus avisos y devuelve el resumen."""
        cambios = {k: v for k, v in (("activo", activo), ("avisos", avisos)) if v is not None}
        self._repositorio.modificar(lambda estado: replace(estado, **cambios))
        return self.resumen()

    def revisar(self, forzar: bool = False) -> int:
        """Mira los bloques que falten, hasta `maxBloques`, y avisa de las monedas movidas.

        Args:
            forzar: Revisar aunque la vigilancia esté apagada (botón «Revisar ahora»).

        Returns:
            Cuántas monedas movidas se han encontrado en esta pasada.

        Raises:
            FotoNoDisponible: si no hay foto.
        """
        foto = self._foto()
        estado = self._repositorio.leer()
        if not estado.activo and not forzar:
            return 0
        desde = max(estado.altura, foto.altura) + 1
        try:
            hasta = min(self._lector.altura(), desde + self._maxBloques - 1)
            encontradas = 0
            for altura in range(desde, hasta + 1):
                encontradas += self._revisarBloque(foto, altura)
        except Exception as error:
            # Lo revisado hasta el fallo ya quedó guardado; la próxima pasada sigue de ahí.
            mensaje = str(error)[:300]
            log.warning("[satoshi] Revisión interrumpida: %s", mensaje)
            self._repositorio.modificar(lambda e: replace(e, error=mensaje))
            raise
        self._repositorio.modificar(lambda e: replace(e, error="", ultimaRevision=self._ahora().isoformat()))
        return encontradas

    def _revisarBloque(self, foto: FotoMonedas, altura: int) -> int:
        bloque = self._lector.bloque(altura)
        detectada = self._ahora().isoformat(timespec="seconds")
        nuevas = [
            {"txid": origen, "vout": salida, "satoshis": foto.monedas[(origen, salida)][1],
             "alturaOrigen": foto.monedas[(origen, salida)][0], "alturaGasto": altura,
             "txGasto": txGasto, "fecha": detectada}
            for origen, salida, txGasto in gastosDeBloque(bloque)
            if (origen, salida) in foto.monedas
        ]

        def apuntar(estado: EstadoSatoshi) -> EstadoSatoshi:
            vistas = {(g["txid"], g["vout"]) for g in estado.gastadas}
            gastadas = estado.gastadas + [g for g in nuevas if (g["txid"], g["vout"]) not in vistas]
            return replace(estado, altura=altura, gastadas=gastadas[-MAX_GASTADAS_GUARDADAS:])

        estado = self._repositorio.modificar(apuntar)
        if nuevas:
            log.warning("[satoshi] %d monedas de Satoshi movidas en el bloque %d", len(nuevas), altura)
            if estado.avisos:
                self._notificar(CATEGORIA_AVISO, textoAviso(nuevas))
        return len(nuevas)
