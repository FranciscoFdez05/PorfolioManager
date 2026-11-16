"""Las wallets de seguimiento son de cada portfolio: no se comparten entre ellos."""

import pytest
from cryptography.fernet import Fernet

from core import db, paths, wallets_carpeta
from stores import wallets_store as ws


@pytest.fixture
def apiAislada(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "API_DIR", tmp_path / "API")
    return paths.API_DIR


def _repositorio() -> ws.WalletsRepository:
    fernet = Fernet(Fernet.generate_key())
    return ws.WalletsRepository(proveedorFernet=lambda: fernet)


def _wallet(walletId: str) -> ws.Wallet:
    return ws.Wallet(id=walletId, alias=walletId, red="btc", tipo="direccion", valor=f"bc1q{walletId}",
                     assetId="", creada="2026-01-01T00:00:00+00:00", propia=False)


def testCadaPortfolioVeSoloSusWallets(apiAislada, tmp_path):
    fernet = Fernet(Fernet.generate_key())
    repositorio = ws.WalletsRepository(proveedorFernet=lambda: fernet)
    with db.useDbPath(tmp_path / "uno.db"):
        repositorio.anadir(_wallet("a"))
    with db.useDbPath(tmp_path / "dos.db"):
        assert repositorio.listar() == []
        repositorio.anadir(_wallet("b"))
    with db.useDbPath(tmp_path / "uno.db"):
        assert [w.id for w in repositorio.listar()] == ["a"]


def testCarpetaPorId(apiAislada):
    assert wallets_carpeta.carpetaWalletsDe("uno") == apiAislada / "portfolios" / "uno"


@pytest.mark.parametrize("idMalo", ["", "../x", "A B", "a/b"])
def testIdNoValidoSeRechaza(idMalo):
    with pytest.raises(ValueError):
        wallets_carpeta.carpetaWalletsDe(idMalo)


def testLaMigracionMueveLoDeAntesAlPortfolioIndicado(apiAislada):
    apiAislada.mkdir()
    (apiAislada / "wallets.key").write_bytes(b"WAL1:x")
    (apiAislada / "wallets_lecturas").mkdir()
    (apiAislada / "etherscan.key").write_bytes(b"clave")

    movidos = wallets_carpeta.migrarWalletsAlPortfolio("uno")

    assert set(movidos) == {"wallets.key", "wallets_lecturas"}
    assert (apiAislada / "portfolios" / "uno" / "wallets.key").read_bytes() == b"WAL1:x"
    assert not (apiAislada / "wallets.key").exists()
    # Las claves de API son de la instalación: no se tocan.
    assert (apiAislada / "etherscan.key").exists()


def testLaMigracionNoPisaNiSeRepite(apiAislada):
    apiAislada.mkdir()
    destino = apiAislada / "portfolios" / "uno"
    destino.mkdir(parents=True)
    (destino / "wallets.key").write_bytes(b"nuevo")
    (apiAislada / "wallets.key").write_bytes(b"viejo")

    assert wallets_carpeta.migrarWalletsAlPortfolio("uno") == []
    assert (destino / "wallets.key").read_bytes() == b"nuevo"
    assert wallets_carpeta.migrarWalletsAlPortfolio("dos") == ["wallets.key"]


def testBorrarUnPortfolioApartaSusWallets(datosAislados):
    """Una cartera nueva con el mismo nombre no hereda las wallets de la borrada."""
    import json

    from admin import portfolios_manager as pm

    datosAislados["meta"].write_text(json.dumps({
        "active": "a", "portfolios": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}],
    }), "utf-8")
    carpetaB = wallets_carpeta.carpetaWalletsDe("b")
    carpetaB.mkdir(parents=True)
    (carpetaB / "wallets.key").write_bytes(b"WAL1:b")
    carpetaA = wallets_carpeta.carpetaWalletsDe("a")
    carpetaA.mkdir(parents=True)
    (carpetaA / "wallets.key").write_bytes(b"WAL1:a")

    pm.deletePortfolio("b")

    assert not carpetaB.exists()
    apartadas = list((datosAislados["data"] / "deleted").glob("wallets_b_*"))
    assert len(apartadas) == 1
    assert (apartadas[0] / "wallets.key").read_bytes() == b"WAL1:b"
    assert (carpetaA / "wallets.key").read_bytes() == b"WAL1:a"


def testBorrarUnPortfolioSinWalletsNoFalla(datosAislados):
    import json

    from admin import portfolios_manager as pm

    datosAislados["meta"].write_text(json.dumps({
        "active": "a", "portfolios": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}],
    }), "utf-8")

    pm.deletePortfolio("b")

    assert [p["id"] for p in json.loads(datosAislados["meta"].read_text("utf-8"))["portfolios"]] == ["a"]
