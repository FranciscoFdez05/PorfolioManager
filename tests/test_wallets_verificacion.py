"""Direcciones de xpub y claves públicas en la libreta, y verificación manual de las entradas."""

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from core import wallets_libreta as wl, wallets_sync as wsync, wallets_vigilancia as wv
from core.cripto_direcciones import direccionesDeClavePublica
from providers import blockchain_clients as bc
from providers.blockchain_clients import ENTRE_WALLETS, ENVIADA, RECIBIDA, MovimientoWallet
from stores import revisiones, wallets_store as ws
from stores.rendimiento_activo import lotesVivos

_SECRET = "a" * 64
_ZPUB = (
    "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs"
)
_CLAVE = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
_PROPIA = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
_OTRA_PROPIA = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el"
_TERCERO = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g"
_ACTIVOS = [{"id": "bitcoin", "name": "Bitcoin", "symbol": "BTC", "marketSymbol": "BTC-USD"}]


def _wallet(**cambios) -> ws.Wallet:
    datos = {"id": "w1", "alias": "Trezor", "red": "btc", "tipo": "xpub", "valor": _ZPUB, "assetId": "bitcoin",
             "creada": "2026-01-01T00:00:00+00:00", **cambios}
    return ws.Wallet(**datos)


def _mov(hashTx="h1", tipo=RECIBIDA, contraparte=_TERCERO, contrapartes=()) -> MovimientoWallet:
    return MovimientoWallet(red="btc", hash=hashTx, fecha=datetime(2026, 3, 9, tzinfo=UTC), simbolo="BTC",
                            cantidad=Decimal("0.5"), comision=None, tipo=tipo, contraparte=contraparte,
                            contrapartes=contrapartes, propia=_OTRA_PROPIA)


# ── Direcciones de la libreta ─────────────────────────────────────────────────


def testUnaClavePublicaPropiaAportaTodasSusDirecciones():
    wallet = _wallet(tipo="clave", valor=_CLAVE)

    assert wl.direccionesDeWallet(wallet) == direccionesDeClavePublica(_CLAVE)
    assert len(wl.direccionesDeWallet(wallet)) == 4


def testUnaXpubAportaLasDireccionesYaDescubiertas():
    assert wl.direccionesDeWallet(_wallet()) == []
    assert not wl.entraEnLibreta(_wallet())

    wallet = _wallet(direccionesDerivadas=[_PROPIA, _OTRA_PROPIA])

    assert wl.direccionesDeWallet(wallet) == [_PROPIA, _OTRA_PROPIA]
    assert wl.entraEnLibreta(wallet)


@pytest.mark.parametrize("cambios", [
    {"tipo": "clave", "valor": _CLAVE}, {"direccionesDerivadas": [_PROPIA]}, {"tipo": "direccion", "valor": _PROPIA},
])
def testUnaWalletAjenaNoAportaNada(cambios):
    wallet = _wallet(propia=False, **cambios)

    assert wl.direccionesDeWallet(wallet) == []
    assert wl.Libreta.desde([], [wallet]).buscar("btc", _PROPIA) is None


def testUnaClaveDanadaNoRompeLaLibreta():
    wallet = _wallet(tipo="clave", valor="no-es-una-clave")

    assert wl.direccionesDeWallet(wallet) == []
    assert wl.destinosDeWallet(wallet) == []


def testLasFormasP2pkClasificanPeroNoSalenEnLaLista():
    wallet = _wallet(tipo="clave", valor=_CLAVE)
    libreta = wl.Libreta.desde([], [wallet])

    assert libreta.buscar("btc", _CLAVE).propia
    assert _CLAVE not in [direccion for _clave, direccion, _derivada in wl.filasLibretaDe(wallet)]


def testLasFilasDeLaListaDistinguenSueltasYDerivadas():
    suelta = _wallet(id="s", tipo="direccion", valor=_PROPIA)
    conXpub = _wallet(id="x", direccionesDerivadas=[_PROPIA, _OTRA_PROPIA])

    assert wl.filasLibretaDe(suelta) == [("s", _PROPIA, False)]
    assert wl.filasLibretaDe(conXpub) == [("x#0", _PROPIA, True), ("x#1", _OTRA_PROPIA, True)]


# ── Varias contrapartes ───────────────────────────────────────────────────────


def _libretaPropia():
    return wl.Libreta.desde([], [_wallet(direccionesDerivadas=[_PROPIA, _OTRA_PROPIA])])


def testUnMovimientoDesdeUnaDireccionDeLaXpubEsEntreWallets():
    movimiento = wl.aplicar(_mov(contraparte=_PROPIA), _libretaPropia())

    assert movimiento.tipo == ENTRE_WALLETS


@pytest.mark.parametrize("tipo", [RECIBIDA, ENVIADA])
def testUnaMezclaDePropiasYTercerosNoEsEntreWallets(tipo):
    movimiento = _mov(tipo=tipo, contraparte=_PROPIA, contrapartes=(_PROPIA, _TERCERO))

    assert wl.aplicar(movimiento, _libretaPropia()).tipo == tipo


def testSiTodasLasContrapartesSonPropiasEsEntreWallets():
    movimiento = _mov(contraparte=_PROPIA, contrapartes=(_PROPIA, _OTRA_PROPIA))

    assert wl.aplicar(movimiento, _libretaPropia()).tipo == ENTRE_WALLETS


def testAnotarRespetaLaMezclaYConservaElApodo():
    guardado = {"hash": "h1", "tipo": RECIBIDA, "contraparte": _PROPIA, "contrapartes": [_PROPIA, _TERCERO]}

    anotado = wl.anotar(guardado, "btc", _libretaPropia())

    assert anotado["tipo"] == RECIBIDA
    assert anotado["contraparteApodo"] == "Trezor"


def testElLectorDaTodasLasContrapartesDeUnaEntrada():
    tx = {
        "txid": "t1", "fee": 10, "status": {"confirmed": True, "block_time": 1},
        "vin": [{"prevout": {"scriptpubkey_address": _PROPIA, "value": 5}},
                {"prevout": {"scriptpubkey_address": _TERCERO, "value": 5}},
                {"prevout": {"scriptpubkey_address": _TERCERO, "value": 5}}],
        "vout": [{"scriptpubkey_address": _OTRA_PROPIA, "value": 5}],
    }

    movimiento = bc.LectorBitcoin._normalizar(tx, {_OTRA_PROPIA})

    assert movimiento.contraparte == _PROPIA
    assert movimiento.contrapartes == (_PROPIA, _TERCERO)


def testElLectorDaTodasLasContrapartesDeUnEnvio():
    tx = {
        "txid": "t1", "fee": 10, "status": {"confirmed": True, "block_time": 1},
        "vin": [{"prevout": {"scriptpubkey_address": _OTRA_PROPIA, "value": 15}}],
        "vout": [{"scriptpubkey_address": _PROPIA, "value": 5}, {"scriptpubkey_address": _TERCERO, "value": 5},
                 {"scriptpubkey": "6a", "value": 0}],
    }

    assert bc.LectorBitcoin._normalizar(tx, {_OTRA_PROPIA}).contrapartes == (_PROPIA, _TERCERO)


# ── Verificación de las entradas ──────────────────────────────────────────────


@pytest.fixture
def entorno(tmp_path, monkeypatch):
    monkeypatch.setenv("SECRET_KEY", _SECRET)
    return ws.WalletsRepository(ruta=tmp_path / "wallets.key")


def _sincronizador(repositorio, movimientos, filas=()):
    estado = {"rows": list(filas), "revision": 1}

    def escribir(datos, revisionEsperada=None):
        if revisionEsperada != estado["revision"]:
            raise revisiones.ConflictoRevision(estado["revision"])
        estado["rows"] = datos["rows"]
        estado["revision"] += 1
        return estado["revision"]

    class Lector:
        def leer(self, tipo, valor, limite):
            return list(movimientos)

    servicio = wsync.SincronizadorWallets(
        repositorio=repositorio, fabricaLectores=lambda red: Lector(), leerActivos=lambda: _ACTIVOS,
        leerStablecoins=lambda: [], leerTransacciones=lambda: {"rows": list(estado["rows"])},
        escribirTransacciones=escribir, revisionActual=lambda: estado["revision"], maxMovimientos=lambda: 100,
        leerTokensPublicos=lambda: [],
    )
    return servicio, estado


def _enlazarDireccion(repositorio, **cambios):
    return repositorio.anadir(_wallet(id=ws.nuevoId(), tipo="direccion", valor=_OTRA_PROPIA, **cambios))


def _marcar(repositorio, propia, hashTx="h1"):
    repositorio.marcarMovimiento(ws.MovimientoMarcado(red="btc", hash=hashTx, contrato="", propia=propia,
                                                      comision="", assetId="bitcoin"))


def testUnaEntradaSinVerificarNoSeImportaYSeCuenta(entorno):
    wallet = _enlazarDireccion(entorno)
    servicio, estado = _sincronizador(entorno, [_mov()])

    resultado = servicio.sincronizar(wallet.id)

    assert estado["rows"] == []
    assert (resultado.anadidas, resultado.pendientes) == (0, 1)
    assert resultado.comoDict()["pendientes"] == 1


def testUnEnvioSeSigueImportandoSinVerificar(entorno):
    wallet = _enlazarDireccion(entorno)
    servicio, estado = _sincronizador(entorno, [_mov(tipo=ENVIADA)])

    resultado = servicio.sincronizar(wallet.id)

    assert [fila["walletTipo"] for fila in estado["rows"]] == [ENVIADA]
    assert resultado.pendientes == 0
    assert "pendientes" not in resultado.comoDict()


def testUnaEntradaDesdeUnaDireccionPropiaNoPideVerificacion(entorno):
    wallet = _enlazarDireccion(entorno)
    entorno.anadir(_wallet(id=ws.nuevoId(), direccionesDerivadas=[_PROPIA], seguimiento="Otra"))
    servicio, estado = _sincronizador(entorno, [_mov(contraparte=_PROPIA)])

    resultado = servicio.sincronizar(wallet.id)

    assert [fila["walletTipo"] for fila in estado["rows"]] == [ENTRE_WALLETS]
    assert resultado.pendientes == 0


@pytest.mark.parametrize("propia, tipo", [(False, RECIBIDA), (True, ENTRE_WALLETS)])
def testUnaEntradaVerificadaSeImportaComoSeHaElegido(entorno, propia, tipo):
    wallet = _enlazarDireccion(entorno)
    _marcar(entorno, propia)
    servicio, estado = _sincronizador(entorno, [_mov()])

    resultado = servicio.sincronizar(wallet.id)

    assert [fila["walletTipo"] for fila in estado["rows"]] == [tipo]
    assert resultado.pendientes == 0


def testUnaRecibidaDeAntesSeQuedaComoEstabaYNoSeCuenta(entorno):
    wallet = _enlazarDireccion(entorno)
    anterior = {"id": "wallet-antigua", "assetId": "bitcoin", "hashTransaccion": "H1", "walletTipo": RECIBIDA,
                "total": "0.5"}
    servicio, estado = _sincronizador(entorno, [_mov()], filas=[anterior])

    resultado = servicio.sincronizar(wallet.id)

    assert estado["rows"] == [anterior]
    assert resultado.pendientes == 0


def _filaPendiente(hashTx="h1", red="btc", assetId="bitcoin", **cambios):
    filaId = f"wallet-{wsync._huella(red, hashTx, assetId)}"
    return {"id": filaId, "assetId": assetId, "hashTransaccion": hashTx, "walletTipo": wl.PENDIENTE, "total": "0.5",
            "comisionRed": "", "walletDesde": _TERCERO, "walletDestino": "Trezor", **cambios}


def testUnaFilaPendienteNoCuentaComoImportada():
    assert wsync.hashesImportados([_filaPendiente()]) == set()
    assert wsync.hashesImportados([_filaPendiente(walletTipo=RECIBIDA)]) == {"h1"}


def testUnaFilaPendienteSigueContandoComoPendienteYNoSeDuplica(entorno):
    wallet = _enlazarDireccion(entorno)
    servicio, estado = _sincronizador(entorno, [_mov()], filas=[_filaPendiente()])

    resultado = servicio.sincronizar(wallet.id)

    assert [fila["walletTipo"] for fila in estado["rows"]] == [wl.PENDIENTE]
    assert (resultado.anadidas, resultado.pendientes) == (0, 1)


@pytest.mark.parametrize("propia, tipo", [(False, RECIBIDA), (True, ENTRE_WALLETS)])
def testVerificarUnaFilaPendienteLaHaceContar(entorno, propia, tipo):
    servicio, estado = _sincronizador(entorno, [], filas=[_filaPendiente()])
    _marcar(entorno, propia)

    assert servicio.aplicarMarca("btc", "h1", "bitcoin", RECIBIDA, "") == 1
    assert [fila["walletTipo"] for fila in estado["rows"]] == [tipo]


@pytest.mark.parametrize("propia", [False, True])
def testQuitarLaVerificacionDejaLaFilaImportadaPendiente(entorno, propia):
    servicio, estado = _sincronizador(entorno, [], filas=[_filaPendiente()])
    _marcar(entorno, propia)
    servicio.aplicarMarca("btc", "h1", "bitcoin", RECIBIDA, "")

    entorno.desmarcarMovimiento("btc", "h1", "")

    assert servicio.aplicarMarca("btc", "h1", "bitcoin", RECIBIDA, "") == 1
    assert [fila["walletTipo"] for fila in estado["rows"]] == [wl.PENDIENTE]


def testUnaFilaEscritaAManoNoQuedaPendienteAlQuitarLaMarca(entorno):
    manual = {"id": "manual", "assetId": "bitcoin", "hashTransaccion": "h1", "walletTipo": RECIBIDA, "comisionRed": ""}
    servicio, estado = _sincronizador(entorno, [], filas=[manual])
    _marcar(entorno, True)
    servicio.aplicarMarca("btc", "h1", "bitcoin", RECIBIDA, "")

    entorno.desmarcarMovimiento("btc", "h1", "")
    servicio.aplicarMarca("btc", "h1", "bitcoin", RECIBIDA, "")

    assert [fila["walletTipo"] for fila in estado["rows"]] == [RECIBIDA]


def testOlvidarUnaDireccionPropiaDejaLaEntradaPendiente(entorno):
    wallet = _enlazarDireccion(entorno)
    entorno.guardarDireccion(ws.DireccionMarcada(red="btc", direccion=_TERCERO, apodo="Mía", propia=True))
    servicio, estado = _sincronizador(entorno, [_mov()])
    servicio.sincronizar(wallet.id)
    assert [fila["walletTipo"] for fila in estado["rows"]] == [ENTRE_WALLETS]

    entorno.olvidarDireccion("btc", _TERCERO)
    servicio.reetiquetar("btc", _TERCERO)

    assert [fila["walletTipo"] for fila in estado["rows"]] == [wl.PENDIENTE]


def testSincronizarCorrigeUnaFilaPendienteYaVerificada(entorno):
    wallet = _enlazarDireccion(entorno)
    _marcar(entorno, False)
    servicio, estado = _sincronizador(entorno, [_mov()], filas=[_filaPendiente()])

    resultado = servicio.sincronizar(wallet.id)

    assert [fila["walletTipo"] for fila in estado["rows"]] == [RECIBIDA]
    assert (resultado.anadidas, resultado.pendientes) == (0, 0)


def testUnaFilaPendienteNoSumaALaPosicion():
    base = {"asset_id": "bitcoin", "fecha_operacion": "01-11-2026", "total": "0.5", "comision_red": ""}
    sinContar = lotesVivos([], [], True, transacciones=[{**base, "wallet_tipo": wl.PENDIENTE}], moneda="EUR")
    contando = lotesVivos([], [], True, transacciones=[{**base, "wallet_tipo": RECIBIDA}], moneda="EUR")

    assert sinContar == []
    assert sum(lote["cantidad"] for lote in contando) == Decimal("0.5")


def _guardadoReciente():
    return wv.movimientoComoDict(_mov())


def testImportarUnMovimientoVerificadoNoLeeLaRed(entorno):
    wallet = _enlazarDireccion(entorno)
    wallet = entorno.actualizar(wallet.id, recientes=[_guardadoReciente()])
    _marcar(entorno, False)
    servicio, estado = _sincronizador(entorno, [])

    assert servicio.importarVerificado(wallet, "h1", "") == 1
    assert [(f["hashTransaccion"], f["walletTipo"], f["total"]) for f in estado["rows"]] == [("h1", RECIBIDA, "0.5")]
    assert servicio.importarVerificado(wallet, "h1", "") == 0


def testSinElMovimientoEnRecientesLoImportaraSincronizar(entorno):
    wallet = _enlazarDireccion(entorno)
    servicio, estado = _sincronizador(entorno, [])

    assert servicio.importarVerificado(wallet, "otro", "") is None
    assert estado["rows"] == []


@pytest.mark.parametrize("danado", [{"hash": "h1"}, {**wv.movimientoComoDict(_mov()), "cantidad": "x"},
                                    {**wv.movimientoComoDict(_mov()), "fecha": "ayer"}])
def testUnMovimientoGuardadoDanadoNoRompeLaVerificacion(entorno, danado):
    wallet = _enlazarDireccion(entorno)
    wallet = entorno.actualizar(wallet.id, recientes=[danado])
    servicio, estado = _sincronizador(entorno, [])

    assert servicio.importarVerificado(wallet, "h1", "") is None
    assert estado["rows"] == []


def testElMovimientoGuardadoConservaSusContrapartes():
    movimiento = _mov(contraparte=_PROPIA, contrapartes=(_PROPIA, _TERCERO))

    recuperado = wsync.movimientoDeGuardado("btc", wv.movimientoComoDict(movimiento))

    assert recuperado.contrapartes == (_PROPIA, _TERCERO)
    assert (recuperado.cantidad, recuperado.fecha) == (movimiento.cantidad, movimiento.fecha)


# ── Reetiquetado ──────────────────────────────────────────────────────────────


def _filaConContraparte(entorno, contraparte):
    fila = {"id": "wallet-f1", "assetId": "bitcoin", "hashTransaccion": "h1", "walletTipo": RECIBIDA,
            "walletDesde": _TERCERO, "walletDestino": "Trezor", "comisionRed": ""}
    entorno.anotarContrapartes({"wallet-f1": {"red": "btc", "sentido": RECIBIDA, **contraparte}})
    return fila


def testReetiquetarVariasCorrigeLoImportadoDeEsasDirecciones(entorno):
    entorno.anadir(_wallet(direccionesDerivadas=[_PROPIA]))
    fila = _filaConContraparte(entorno, {"direccion": _PROPIA})
    servicio, estado = _sincronizador(entorno, [], filas=[fila])

    assert servicio.reetiquetarVarias("btc", [_PROPIA, _OTRA_PROPIA]) == 1
    assert estado["rows"][0]["walletTipo"] == ENTRE_WALLETS


def testUnaFilaMixtaSoloCambiaCuandoTodasSusContrapartesSonPropias(entorno):
    fila = _filaConContraparte(entorno, {"direccion": _PROPIA, "todas": [_PROPIA, _OTRA_PROPIA]})
    wallet = entorno.anadir(_wallet(direccionesDerivadas=[_PROPIA]))
    servicio, estado = _sincronizador(entorno, [], filas=[fila])

    servicio.reetiquetarVarias("btc", [_PROPIA])
    assert estado["rows"][0]["walletTipo"] == RECIBIDA

    entorno.actualizar(wallet.id, direccionesDerivadas=[_PROPIA, _OTRA_PROPIA])
    assert servicio.reetiquetarVarias("btc", [_OTRA_PROPIA]) == 1
    assert estado["rows"][0]["walletTipo"] == ENTRE_WALLETS


# ── La vigilancia descubre las direcciones ────────────────────────────────────


class _LectorXpub:
    def __init__(self, usadas):
        self.usadas = usadas

    def saldo(self, tipo, valor):
        return Decimal("1")

    def leer(self, tipo, valor, limite):
        return []

    def direccionesUsadas(self, valor):
        return self.usadas


def _vigilante(repositorio, lector):
    return wv.VigilanteWallets(
        repositorio=repositorio, fabricaLectores=lambda red: lector, notificar=lambda categoria, texto: True,
        precioEur=lambda assetId: Decimal("60000"), leerTokensPublicos=lambda: [], puedeAvisar=lambda categoria: True,
    )


def testRevisarGuardaLasDireccionesNuevasYReetiquetaSoloEsas(entorno, monkeypatch):
    wallet = entorno.anadir(_wallet(direccionesDerivadas=[_PROPIA]))
    reetiquetadas = []
    monkeypatch.setattr(wv.SincronizadorWallets, "reetiquetarVarias",
                        lambda self, red, direcciones: reetiquetadas.append((red, direcciones)) or 0)

    leida, _avisos = _vigilante(entorno, _LectorXpub([_PROPIA, _OTRA_PROPIA])).revisar(wallet.id)

    assert leida.direccionesDerivadas == [_PROPIA, _OTRA_PROPIA]
    assert reetiquetadas == [("btc", [_OTRA_PROPIA])]


def testRevisarSinDireccionesNuevasNoReetiqueta(entorno, monkeypatch):
    wallet = entorno.anadir(_wallet(direccionesDerivadas=[_PROPIA]))
    monkeypatch.setattr(wv.SincronizadorWallets, "reetiquetarVarias",
                        lambda *a: pytest.fail("No había nada que reetiquetar"))

    leida, _avisos = _vigilante(entorno, _LectorXpub([_PROPIA])).revisar(wallet.id)

    assert leida.direccionesDerivadas == [_PROPIA]


def testUnFalloAlReetiquetarNoEstropeaLaLectura(entorno, monkeypatch):
    wallet = entorno.anadir(_wallet())

    def fallar(*_args):
        raise bc.ErrorLecturaWallet("Transacciones ocupada")

    monkeypatch.setattr(wv.SincronizadorWallets, "reetiquetarVarias", fallar)

    leida, _avisos = _vigilante(entorno, _LectorXpub([_PROPIA])).revisar(wallet.id)

    assert leida.direccionesDerivadas == [_PROPIA]
    assert leida.saldoFecha


def testUnaXpubAjenaNoGuardaDirecciones(entorno):
    wallet = entorno.anadir(_wallet(propia=False, assetId=""))

    leida, _avisos = _vigilante(entorno, _LectorXpub([_PROPIA])).revisar(wallet.id)

    assert leida.direccionesDerivadas == []


def testLasDireccionesDerivadasSobrevivenAGuardarYLeer(entorno):
    wallet = entorno.anadir(_wallet(direccionesDerivadas=[_PROPIA]))

    assert entorno.obtener(wallet.id).direccionesDerivadas == [_PROPIA]
    assert "direccionesDerivadas" not in wallet.resumen()
    assert _PROPIA.encode() not in entorno.ruta.read_bytes()
