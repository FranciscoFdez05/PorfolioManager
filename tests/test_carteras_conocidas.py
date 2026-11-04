"""Pruebas del catálogo de carteras conocidas (core/carteras_conocidas.py y su store).

Dos bloques: que el JSON de serie que viaja con el proyecto es válido para
enlazar (cada dirección pasa el mismo validador que el formulario), y que la
fusión con lo del usuario (añadir, editar, ocultar, restaurar) se comporta y
se guarda cifrada.
"""

import pytest

from core import carteras_conocidas as cc
from core.cripto_direcciones import REDES, prepararDatoWallet
from stores import carteras_conocidas_store as store
from stores.wallets_store import CifradoNoDisponible, WalletError

_SECRET = "a" * 16 + "0123456789abcdef0123456789abcdef"
_GENESIS = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
_ETH = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045"


# ── Catálogo de serie ─────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def base():
    return store.leerCatalogoBase()


def testCadaDireccionDeSerieEsValidaYCanonica(base):
    for cartera in base.entidades:
        for direccion in cartera.direcciones:
            assert direccion.red in REDES, cartera.id
            # Lo mismo que hará /api/wallets al enlazarla: si no pasa aquí, fallaría allí.
            assert prepararDatoWallet(direccion.red, direccion.tipo, direccion.valor) == (
                direccion.tipo, direccion.valor), (cartera.id, direccion.valor)


def testElCatalogoDeSerieEsCoherente(base):
    ids = [c.id for c in base.entidades]
    assert len(ids) == len(set(ids))
    for cartera in base.entidades:
        assert cartera.direcciones, cartera.id
        assert cartera.categoria in cc.CATEGORIAS, cartera.id
        assert set(cartera.fuentes) <= base.fuentes.keys(), cartera.id
        assert len(cartera.nombre) <= cc.MAX_LARGO_NOMBRE
        assert len(cartera.direcciones) <= cc.MAX_DIRECCIONES_POR_ENTIDAD
        pares = [(d.red, d.valor) for d in cartera.direcciones]
        assert len(pares) == len(set(pares)), cartera.id
        assert all(len(d.etiqueta) <= cc.MAX_LARGO_ETIQUETA for d in cartera.direcciones)


@pytest.mark.parametrize("carteraId", ["binance", "coinbase", "bitvavo", "kraken", "bybit", "okx"])
def testLosGrandesExchangesTienenVariasRedes(base, carteraId):
    cartera = next(c for c in base.entidades if c.id == carteraId)

    assert len({d.red for d in cartera.direcciones}) >= 2


def testIncluyeLasEntidadesPedidas(base):
    ids = {c.id for c in base.entidades}

    assert {"binance", "coinbase", "bitvavo", "satoshi", "wlfi", "vitalik", "mtgox"} <= ids
    # Una persona con una atribución sin confirmar no va de serie en un repo público.
    assert "trump" not in ids
    satoshi = next(c for c in base.entidades if c.id == "satoshi")
    assert _GENESIS in {d.valor for d in satoshi.direcciones}
    assert any(d.tipo == "clave" for d in satoshi.direcciones)


def testUnCatalogoDeSerieDanadoDaUnErrorPropio(tmp_path):
    ruta = tmp_path / "malo.json"
    ruta.write_text('{"entidades": [{"id": "x"}]}', encoding="utf-8")

    with pytest.raises(store.CatalogoBaseIlegible):
        store.leerCatalogoBase(ruta)
    with pytest.raises(store.CatalogoBaseIlegible):
        store.leerCatalogoBase(tmp_path / "no-existe.json")


# ── Servicio con un catálogo de serie de prueba ───────────────────────────────

def _baseDePrueba():
    return store.CatalogoBase(
        entidades=(
            store.CarteraConocida("binance", "Binance", "exchange",
                                  (store.DireccionConocida("eth", "direccion", _ETH, "Binance 1"),),
                                  alias=("cz",), fuentes=("f1",)),
            store.CarteraConocida("ef", "Fundación Ethereum", "fundacion",
                                  (store.DireccionConocida("btc", "direccion", _GENESIS, "Génesis"),)),
        ),
        fuentes={"f1": {"nombre": "Fuente", "url": "https://example.org"}},
    )


@pytest.fixture
def catalogo(tmp_path, monkeypatch):
    monkeypatch.setenv("SECRET_KEY", _SECRET)
    repositorio = store.CarterasUsuarioRepository(ruta=tmp_path / "carteras.key")
    return cc.CatalogoCarteras(repositorio, leerBase=_baseDePrueba)


def _nueva(**cambios):
    return {"nombre": "Mi ballena", "categoria": "persona", "alias": ["whale"],
            "direcciones": [{"red": "btc", "valor": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "etiqueta": "Fría"}],
            **cambios}


@pytest.mark.parametrize("texto, esperado", [("  Fundación  ETHEREUM ", "fundacion ethereum"), ("", ""), (None, "")])
def testPlano(texto, esperado):
    assert cc.plano(texto) == esperado


@pytest.mark.parametrize("consulta, ids", [
    ("", ["binance", "ef"]),
    ("bin", ["binance"]),
    ("CZ", ["binance"]),
    ("fundacion", ["ef"]),
    ("exchange", ["binance"]),
    ("génesis", ["ef"]),
    (_GENESIS[:10], ["ef"]),
    (_ETH.upper()[2:12], ["binance"]),
    ("1A1", []),
    ("nadie", []),
])
def testBuscar(catalogo, consulta, ids):
    assert [e.cartera.id for e in catalogo.buscar(consulta)] == ids


def testBuscarPoneDelanteLoQueEmpiezaIgual(catalogo):
    catalogo.guardar(_nueva(nombre="Cuenta de Binance de Ana"))

    assert [e.cartera.nombre for e in catalogo.buscar("binance")] == ["Binance", "Cuenta de Binance de Ana"]


def testBuscarRespetaElLimite(catalogo):
    assert len(catalogo.buscar("", limite=1)) == 1


def testGuardarUnaNuevaQuedaCifradaYEsPropia(catalogo):
    entrada = catalogo.guardar(_nueva())

    contenido = catalogo._repositorio.ruta.read_bytes()
    assert contenido.startswith(b"CAT1:")
    assert b"bc1qw508" not in contenido and b"ballena" not in contenido
    assert entrada.origen == cc.ORIGEN_PROPIA
    assert entrada.cartera.id.startswith("usuario-")
    assert [e.cartera.id for e in catalogo.buscar("ballena")] == [entrada.cartera.id]
    assert catalogo.buscar("whale")[0].cartera.direcciones[0].etiqueta == "Fría"


def testEditarUnaPropiaLaSustituyeEnSuSitio(catalogo):
    primera = catalogo.guardar(_nueva()).cartera
    catalogo.guardar(_nueva(nombre="Otra"))

    catalogo.guardar(_nueva(nombre="Ballena renombrada"), primera.id)

    assert [e.cartera.nombre for e in catalogo.entradas()][2:] == ["Ballena renombrada", "Otra"]


def testEditarUnaDeSerieGuardaUnaCopiaYRestaurarLaQuita(catalogo):
    editada = catalogo.guardar(_nueva(nombre="Binance (mía)"), "binance")

    assert editada.origen == cc.ORIGEN_EDITADA
    assert editada.cartera.fuentes == ("f1",)
    assert catalogo.obtener("binance").cartera.nombre == "Binance (mía)"
    assert [e.cartera.id for e in catalogo.entradas()] == ["binance", "ef"]

    restaurada = catalogo.restaurar("binance")

    assert restaurada.origen == cc.ORIGEN_SERIE
    assert catalogo.obtener("binance").cartera.nombre == "Binance"


def testEliminarUnaDeSerieLaOcultaYSePuedeRestaurar(catalogo):
    catalogo.guardar(_nueva(nombre="Binance (mía)"), "binance")

    catalogo.eliminar("binance")

    assert [e.cartera.id for e in catalogo.entradas()] == ["ef"]
    assert [c.id for c in catalogo.ocultas()] == ["binance"]
    with pytest.raises(cc.CarteraNoEncontrada):
        catalogo.eliminar("binance")
    with pytest.raises(cc.CarteraNoEncontrada):
        catalogo.guardar(_nueva(), "binance")

    catalogo.restaurar("binance")

    assert catalogo.obtener("binance").origen == cc.ORIGEN_SERIE
    assert catalogo.ocultas() == []


def testEliminarUnaPropiaLaBorra(catalogo):
    propia = catalogo.guardar(_nueva()).cartera

    catalogo.eliminar(propia.id)

    assert [e.cartera.id for e in catalogo.entradas()] == ["binance", "ef"]
    with pytest.raises(cc.CarteraNoEncontrada):
        catalogo.eliminar(propia.id)


@pytest.mark.parametrize("accion", ["eliminar", "restaurar", "obtener"])
def testUnIdQueNoExisteNoSeEncuentra(catalogo, accion):
    with pytest.raises(cc.CarteraNoEncontrada):
        getattr(catalogo, accion)("no-existe")


def testEditarUnIdQueNoExisteFallaSinEscribir(catalogo):
    with pytest.raises(cc.CarteraNoEncontrada):
        catalogo.guardar(_nueva(), "usuario-000000000000")
    assert not catalogo._repositorio.ruta.exists()


@pytest.mark.parametrize("cambios, campo", [
    ({"nombre": ""}, "nombre"),
    ({"nombre": "x" * (cc.MAX_LARGO_NOMBRE + 1)}, "nombre"),
    ({"nombre": 5}, "nombre"),
    ({"categoria": "rara"}, "categoria"),
    ({"direcciones": []}, "direcciones"),
    ({"direcciones": "bc1q"}, "direcciones"),
    ({"direcciones": ["texto"]}, "direcciones.0"),
    ({"direcciones": [{"red": "doge", "valor": _GENESIS}]}, "direcciones.0"),
    ({"direcciones": [{"red": "btc", "valor": "bc1qnovalida"}]}, "direcciones.0"),
    ({"direcciones": [{"red": "btc", "valor": " ".join(["abandon"] * 11 + ["about"])}]}, "direcciones.0"),
    ({"direcciones": [{"red": "btc", "valor": _GENESIS}, {"red": "btc", "valor": _GENESIS}]}, "direcciones.1"),
    ({"direcciones": [{"red": "eth", "valor": _ETH, "etiqueta": "x" * 61}]}, "etiqueta"),
    ({"alias": ["x" * 41]}, "alias"),
    ({"alias": [str(i) for i in range(cc.MAX_ALIAS + 1)]}, "alias"),
    ({"alias": [3]}, "alias"),
    ({"nota": "x" * (cc.MAX_LARGO_NOTA + 1)}, "nota"),
])
def testValidaLoQueSeGuarda(catalogo, cambios, campo):
    with pytest.raises(cc.CarteraInvalida) as error:
        catalogo.guardar(_nueva(**cambios))

    assert error.value.campo == campo
    assert not catalogo._repositorio.ruta.exists()


def testNormalizaDireccionesYAlias(catalogo):
    cartera = catalogo.guardar(_nueva(
        alias="Ballena,  ballena , Gorda",
        direcciones=[{"red": "ETH", "valor": _ETH.upper().replace("0X", "0x")}],
    )).cartera

    assert cartera.alias == ("Ballena", "Gorda")
    assert cartera.direcciones[0] == store.DireccionConocida("eth", "direccion", _ETH, "")


def testHayUnTopeDeCarterasDelUsuario(catalogo, monkeypatch):
    monkeypatch.setattr(cc, "MAX_ENTIDADES_USUARIO", 1)
    catalogo.guardar(_nueva())

    with pytest.raises(WalletError):
        catalogo.guardar(_nueva(nombre="Otra"))
    # Editar una que ya está no cuenta como una más.
    catalogo.guardar(_nueva(nombre="Binance (mía)"), catalogo.entradas()[-1].cartera.id)


def testSinSecretKeySeConsultaPeroNoSeGuarda(tmp_path, monkeypatch):
    monkeypatch.delenv("SECRET_KEY", raising=False)
    catalogo = cc.CatalogoCarteras(store.CarterasUsuarioRepository(ruta=tmp_path / "carteras.key"),
                                   leerBase=_baseDePrueba)

    assert len(catalogo.buscar()) == 2
    with pytest.raises(CifradoNoDisponible):
        catalogo.guardar(_nueva())
    assert not (tmp_path / "carteras.key").exists()


def testOtraSecretKeyNoAbreElFichero(catalogo, monkeypatch):
    catalogo.guardar(_nueva())
    monkeypatch.setenv("SECRET_KEY", "b" * 48)

    with pytest.raises(store.AlmacenIlegible):
        catalogo.buscar()


def testEntradaComoDictMarcaLasYaEnlazadas(catalogo):
    entrada = catalogo.obtener("binance")

    datos = cc.entradaComoDict(entrada, _baseDePrueba().fuentes, {("eth", _ETH)})

    assert datos["origen"] == cc.ORIGEN_SERIE
    assert datos["categoriaNombre"] == "Exchange"
    assert datos["fuentes"] == [{"clave": "f1", "nombre": "Fuente", "url": "https://example.org"}]
    assert datos["direcciones"] == [
        {"red": "eth", "tipo": "direccion", "valor": _ETH, "etiqueta": "Binance 1", "enlazada": True}]


def testComprobarListaLoQueHayQueMirarSinCortarseSiFallaUna(monkeypatch):
    import importlib.util
    from decimal import Decimal
    from pathlib import Path

    from providers.blockchain_clients import ErrorLecturaWallet
    from stores.carteras_conocidas_store import CarteraConocida, DireccionConocida

    ruta = Path(__file__).resolve().parent.parent / "tools" / "comprobar_carteras_conocidas.py"
    especificacion = importlib.util.spec_from_file_location("comprobar_carteras_conocidas", ruta)
    modulo = importlib.util.module_from_spec(especificacion)
    # dataclass busca el módulo en sys.modules al procesar las anotaciones.
    monkeypatch.setitem(__import__("sys").modules, especificacion.name, modulo)
    especificacion.loader.exec_module(modulo)

    def leer(red, tipo, valor):
        if valor == "roto":
            raise ErrorLecturaWallet("sin red")
        return Decimal("0") if valor == "vacia" else Decimal("1")

    entidad = CarteraConocida(id="x", nombre="X", categoria="exchange", direcciones=tuple(
        DireccionConocida(red=red, tipo="direccion", valor=valor)
        for red, valor in (("btc", "llena"), ("btc", "vacia"), ("btc", "roto"), ("eth", "otraRed"))
    ))

    revisiones = modulo.revisar([entidad], "btc", leerSaldo=leer)

    assert len(revisiones) == 3
    assert [r.valor for r in modulo.paraMirar(revisiones)] == ["vacia", "roto"]
