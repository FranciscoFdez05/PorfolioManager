"""Las wallets en el paquete cifrado de las copias: volcar, restaurar y fallos parciales."""

import json
from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from core import exportables, wallets_copia
from core.satoshi_vigilancia import SatoshiEstadoRepository
from stores import wallets_store as ws
from stores.carteras_conocidas_store import CarterasUsuarioRepository


def _fernet() -> Fernet:
    return Fernet(Fernet.generate_key())


def _repos(carpeta: Path, fernet: Fernet | None):
    proveedor = lambda: fernet  # noqa: E731
    carpeta.mkdir(exist_ok=True)
    return (ws.WalletsRepository(ruta=carpeta / "wallets.key", proveedorFernet=proveedor),
            CarterasUsuarioRepository(ruta=carpeta / "carteras.key", proveedorFernet=proveedor),
            SatoshiEstadoRepository(ruta=carpeta / "satoshi.json"))


def _wallet(walletId: str, valor: str, propia: bool, **extra) -> ws.Wallet:
    return ws.Wallet(id=walletId, alias=walletId, red="btc", tipo="direccion", valor=valor, assetId="",
                     creada="2026-01-01T00:00:00+00:00", propia=propia, **extra)


def _lleno(carpeta: Path):
    repos = _repos(carpeta, _fernet())
    wallets, _carteras, satoshi = repos
    wallets.anadir(_wallet("mia", "bc1qmia", True, vigilanciaIniciada=True, avisosPendientes=["x"],
                           avisosReintento=["y"], ultimoError="fallo", lecturaIncompleta=True))
    wallets.anadir(_wallet("ajena", "bc1qajena", False, vigilanciaIniciada=True))
    wallets.guardarDireccion(ws.DireccionMarcada(red="btc", direccion="bc1qapodo", apodo="Apodo", propia=True))
    wallets.anotarContrapartes({"wallet-1": {"red": "btc", "direccion": "bc1qapodo", "sentido": "enviada"}})
    satoshi.modificar(lambda e: type(e)(activo=True, altura=123))
    return repos


def testRestauraEnOtraSecretKeyLoQueNoSePodiaLeer(tmp_path):
    volcado = wallets_copia.volcar(*_lleno(tmp_path / "origen"))
    # Paso por JSON: es como viaja dentro del ZIP.
    volcado = json.loads(json.dumps(volcado))

    destino = _repos(tmp_path / "destino", _fernet())
    # Lo que ya hubiera, cifrado con una SECRET_KEY perdida, no impide restaurar.
    destino[0].ruta.write_bytes(b"WAL1:ilegible")

    restauradas = wallets_copia.restaurar(volcado, *destino)

    assert set(restauradas) == {ws.NOMBRE_FICHERO, "satoshi_vigilancia.json"}
    wallets = {w.id: w for w in destino[0].listar()}
    assert wallets["mia"].valor == "bc1qmia" and wallets["ajena"].propia is False
    assert [d.apodo for d in destino[0].direcciones()] == ["Apodo"]
    assert destino[0].contrapartesImportadas()["wallet-1"]["direccion"] == "bc1qapodo"
    assert destino[2].leer().altura == 123
    assert b"bc1qmia" not in destino[0].ruta.read_bytes()


def testAlRestaurarNoSeAvisaDeLoAntiguoNiQuedanFallosViejos(tmp_path):
    origen = _lleno(tmp_path / "origen")
    destino = _repos(tmp_path / "destino", _fernet())

    wallets_copia.restaurar(wallets_copia.volcar(*origen), *destino)

    mia = destino[0].obtener("mia")
    assert mia.vigilanciaIniciada is False
    assert (mia.avisosPendientes, mia.avisosReintento, mia.ultimoError, mia.lecturaIncompleta) == ([], [], "", False)


def testSinSecretKeyNoSeQuedaMedioRestaurado(tmp_path):
    volcado = wallets_copia.volcar(*_lleno(tmp_path / "origen"))
    destino = _repos(tmp_path / "destino", None)

    restauradas = wallets_copia.restaurar(volcado, *destino)

    assert ws.NOMBRE_FICHERO not in restauradas
    assert not destino[0].rutaAjenas.exists()


def testSoloAjenasNoNecesitaSecretKey(tmp_path):
    origen = _repos(tmp_path / "origen", None)
    origen[0].anadir(_wallet("ajena", "bc1qajena", False))
    destino = _repos(tmp_path / "destino", None)

    assert ws.NOMBRE_FICHERO in wallets_copia.restaurar(wallets_copia.volcar(*origen), *destino)
    assert [w.id for w in destino[0].listar()] == ["ajena"]


@pytest.mark.parametrize("danado", [
    {"wallets": {"wallets": "no es una lista"}},
    {"wallets": {"wallets": [{"id": "x"}]}},
    {"wallets": {"wallets": [{"id": "x", "alias": "x", "red": "inventada", "tipo": "direccion", "valor": "v",
                              "assetId": "", "creada": ""}]}},
    {"wallets": {"contrapartes": []}},
])
def testUnaCopiaDanadaNoPisaLoQueHabia(tmp_path, danado):
    repos = _lleno(tmp_path / "destino")

    assert wallets_copia.restaurar(danado, *repos) == []
    assert {w.id for w in repos[0].listar()} == {"mia", "ajena"}


def testUnaFormaDesconocidaSeIgnora(tmp_path):
    assert wallets_copia.restaurar(["no", "es", "un", "dict"], *_repos(tmp_path, _fernet())) == []


def testSinNadaGuardadoNoHayNadaQueCopiar(tmp_path):
    assert wallets_copia.volcar(*_repos(tmp_path, _fernet())) == {}


def testUnWalletsKeyIlegibleNoDejaSinCopiaALoDemas(tmp_path):
    repos = _lleno(tmp_path / "origen")
    repos[0].ruta.write_bytes(b"WAL1:ilegible")

    assert set(wallets_copia.volcar(*repos)) == {"satoshi"}


def testLasWalletsSoloVanEnElPaqueteCifrado(tmp_path, monkeypatch):
    monkeypatch.setattr(exportables, "clavesEnClaro", lambda: {"finnhub": ["k"]})
    monkeypatch.setattr(wallets_copia, "volcar", lambda: {"wallets": {"wallets": []}})

    assert exportables.clavesConWallets() == {"finnhub": ["k"], wallets_copia.CLAVE_PAQUETE: {"wallets": {"wallets": []}}}


def testRestaurarClavesPasaLasWalletsASuServicio(monkeypatch):
    recibidas = []
    monkeypatch.setattr(wallets_copia, "restaurar", lambda partes: recibidas.append(partes) or ["wallets.key"])

    escritos = exportables.restaurarClaves({wallets_copia.CLAVE_PAQUETE: {"wallets": {}}})

    assert escritos == ["wallets.key"]
    assert recibidas == [{"wallets": {}}]
