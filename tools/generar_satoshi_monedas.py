"""Genera la foto de las monedas de Satoshi que siguen sin gastar.

    python tools/generar_satoshi_monedas.py
    python tools/generar_satoshi_monedas.py --csv patoshi.csv --electrum electrum.blockstream.info:50002

Parte de la lista de bloques Patoshi (github.com/bensig/patoshi-addresses): una
salida de 50 BTC a una clave pública (P2PK) por cada bloque atribuido a Satoshi,
unas 22.000. Por cada clave se pregunta qué salidas sin gastar tiene su script y
se guardan en `python/core/datos/satoshi_monedas.csv.gz`, con la altura del
bloque más reciente en ese momento. A partir de ahí el vigilante
(`core.satoshi_vigilancia`) solo mira los bloques nuevos.

Por Electrum y no por la API web de Esplora: 22.000 peticiones HTTP seguidas
hacen que mempool.space corte la IP en segundos (429 y después ni conecta), y
es el servidor que usa la aplicación. Electrum también limita a quien no tiene
clave, así que va despacio, por lotes pequeños con pausa; si el servidor pide
esperar, espera lo que diga y reconecta. Lo hecho se guarda en un fichero de
avance (en el directorio temporal): si se corta, al relanzarlo sigue donde iba.
Puede tardar horas; es una sola vez.

Solo hace falta volver a generarlo si se amplía la lista de Patoshi; las monedas
que se muevan después las descuenta el vigilante.
"""

import argparse
import csv
import gzip
import hashlib
import io
import json
import logging
import re
import socket
import ssl
import sys
import tempfile
import time
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "python"))

from core import settings  # noqa: E402
from providers.conexion import abrir  # noqa: E402

URL_PATOSHI = "https://raw.githubusercontent.com/bensig/patoshi-addresses/main/patoshi_pubkeys_COMPLETE.csv"
ELECTRUM_POR_DEFECTO = "electrum.blockstream.info:50002"
DESTINO = RAIZ / "python" / "core" / "datos" / "satoshi_monedas.csv.gz"
LOTE = 20
PAUSA_SEGUNDOS = 2.0
TIMEOUT_SEGUNDOS = 60
AVANCE = Path(tempfile.gettempdir()) / "satoshi_monedas.avance.json"
# Si el servidor no dice cuánto esperar tras limitar, se espera esto.
ESPERA_LIMITE_SEGUNDOS = 300
_REINTENTAR_TRAS = re.compile(r"retry after (\d+) seconds", re.IGNORECASE)

log = logging.getLogger("generar_satoshi_monedas")


def leerPatoshi(origen: str) -> list[tuple[int, str]]:
    """(altura del bloque, clave pública en hex) de cada salida Patoshi, por altura.

    Args:
        origen: Ruta a un CSV local o URL del CSV del repositorio.
    """
    if origen.startswith("https://"):
        peticion = urllib.request.Request(origen, headers={"User-Agent": settings.proveedorUserAgent()})
        with abrir(peticion, timeout=TIMEOUT_SEGUNDOS) as respuesta:
            texto = respuesta.read().decode("utf-8")
    else:
        texto = Path(origen).read_text(encoding="utf-8")
    filas = csv.DictReader(io.StringIO(texto))
    return sorted({(int(f["Block Height"]), f["Address/Pubkey"].strip().lower())
                   for f in filas if f.get("Script Type", "").strip().lower() == "p2pk"})


def scripthashElectrum(claveHex: str) -> str:
    """El scripthash de Electrum del script P2PK de la clave: sha256 del script, invertido."""
    clave = bytes.fromhex(claveHex)
    script = bytes([len(clave)]) + clave + bytes([0xAC])  # <clave> OP_CHECKSIG
    return hashlib.sha256(script).digest()[::-1].hex()


class LimiteSuperado(RuntimeError):
    """El servidor pide esperar antes de seguir."""

    def __init__(self, mensaje: str, segundos: int) -> None:
        super().__init__(mensaje)
        self.segundos = segundos


class ClienteElectrum:
    """JSON-RPC de Electrum sobre TLS, con las peticiones de cada lote encadenadas."""

    def __init__(self, servidor: str) -> None:
        host, _, puerto = servidor.rpartition(":")
        contexto = ssl.create_default_context()
        crudo = socket.create_connection((host, int(puerto)), timeout=TIMEOUT_SEGUNDOS)
        self._socket = contexto.wrap_socket(crudo, server_hostname=host)
        self._fichero = self._socket.makefile("rwb")
        self._id = 0
        self.lote([("server.version", ["portfolio-manager", "1.4"])])

    def lote(self, llamadas: list[tuple[str, list]]) -> list:
        """Manda las llamadas seguidas y devuelve sus resultados en el mismo orden.

        Raises:
            RuntimeError: si el servidor responde un error a alguna.
        """
        ids = []
        for metodo, parametros in llamadas:
            self._id += 1
            ids.append(self._id)
            mensaje = {"jsonrpc": "2.0", "id": self._id, "method": metodo, "params": parametros}
            self._fichero.write((json.dumps(mensaje) + "\n").encode("utf-8"))
        self._fichero.flush()
        respuestas = {}
        while len(respuestas) < len(ids):
            linea = self._fichero.readline()
            if not linea:
                raise RuntimeError("El servidor Electrum cerró la conexión")
            respuesta = json.loads(linea)
            if respuesta.get("id") in ids:
                respuestas[respuesta["id"]] = respuesta
        errores = [r["error"] for r in respuestas.values() if r.get("error")]
        if errores:
            mensaje = str(errores[0].get("message", errores[0]) if isinstance(errores[0], dict) else errores[0])
            espera = _REINTENTAR_TRAS.search(mensaje)
            if espera or "rate" in mensaje.lower():
                raise LimiteSuperado(mensaje, int(espera.group(1)) if espera else ESPERA_LIMITE_SEGUNDOS)
            raise RuntimeError(f"Electrum respondió un error: {mensaje}")
        return [respuestas[i]["result"] for i in ids]

    def cerrar(self) -> None:
        self._socket.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--csv", default=URL_PATOSHI, help="CSV de patoshi-addresses (ruta o URL)")
    parser.add_argument("--electrum", default=ELECTRUM_POR_DEFECTO, help="Servidor Electrum TLS, host:puerto")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")

    salidas = leerPatoshi(args.csv)
    avance = _leerAvance(len(salidas))
    hechas, monedas, altura = avance["hechas"], {tuple(m) for m in avance["monedas"]}, avance["altura"]
    log.info("%d salidas Patoshi, %d ya consultadas; servidor %s", len(salidas), hechas, args.electrum)
    cliente = None
    while hechas < len(salidas):
        try:
            if cliente is None:
                cliente = ClienteElectrum(args.electrum)
                if not altura:
                    altura = int(cliente.lote([("blockchain.headers.subscribe", [])])[0]["height"])
            trozo = salidas[hechas:hechas + LOTE]
            resultados = cliente.lote([("blockchain.scripthash.listunspent", [scripthashElectrum(clave)])
                                       for _, clave in trozo])
        except LimiteSuperado as error:
            log.info("El servidor pide esperar %d s: %s", error.segundos, error)
            cliente = _cerrar(cliente)
            time.sleep(error.segundos + 5)
            continue
        except (OSError, RuntimeError, ValueError) as error:
            log.info("Fallo de conexión (%s); se reintenta en %d s", error, ESPERA_LIMITE_SEGUNDOS // 5)
            cliente = _cerrar(cliente)
            time.sleep(ESPERA_LIMITE_SEGUNDOS // 5)
            continue
        for utxos in resultados:
            monedas.update((int(u["height"]), u["tx_hash"], int(u["tx_pos"]), int(u["value"]))
                           for u in utxos if int(u.get("height") or 0) > 0)
        hechas += len(trozo)
        _guardarAvance(len(salidas), hechas, monedas, altura)
        if (hechas // LOTE) % 50 == 0:
            log.info("%d/%d claves, %d monedas sin gastar", hechas, len(salidas), len(monedas))
        time.sleep(PAUSA_SEGUNDOS)
    _cerrar(cliente)

    total = sum(m[3] for m in monedas)
    DESTINO.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(DESTINO, "wt", encoding="utf-8", newline="") as fichero:
        fichero.write(f"# altura={altura} fecha={datetime.now(UTC).isoformat(timespec='seconds')} "
                      f"claves={len(salidas)} fuente=https://github.com/bensig/patoshi-addresses\n")
        escritor = csv.writer(fichero)
        escritor.writerow(["altura", "txid", "vout", "satoshis"])
        escritor.writerows(sorted(monedas))
    log.info("%d monedas sin gastar, %.8f BTC, hasta el bloque %d -> %s",
             len(monedas), total / 1e8, altura, DESTINO.relative_to(RAIZ))
    AVANCE.unlink(missing_ok=True)
    return 0


def _cerrar(cliente: "ClienteElectrum | None") -> None:
    if cliente is not None:
        try:
            cliente.cerrar()
        except OSError:
            pass
    return None


def _leerAvance(total: int) -> dict:
    """Lo consultado en una ejecución anterior que se cortó, si era de la misma lista."""
    vacio = {"total": total, "hechas": 0, "monedas": [], "altura": 0}
    try:
        avance = json.loads(AVANCE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return vacio
    return avance if avance.get("total") == total else vacio


def _guardarAvance(total: int, hechas: int, monedas: set, altura: int) -> None:
    temporal = AVANCE.with_suffix(".tmp")
    temporal.write_text(json.dumps({"total": total, "hechas": hechas, "monedas": sorted(monedas),
                                    "altura": altura}), encoding="utf-8")
    temporal.replace(AVANCE)


if __name__ == "__main__":
    sys.exit(main())
