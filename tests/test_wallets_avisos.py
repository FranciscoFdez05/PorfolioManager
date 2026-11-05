"""Pruebas de las reglas de avisos de las wallets (core/wallets_avisos.py)."""

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from core import wallets_avisos as wa
from core.wallets_avisos import ConfigAvisos, ConfigAvisosInvalida
from providers.blockchain_clients import ENTRE_WALLETS, ENVIADA, RECIBIDA, MovimientoWallet


def _mov(cantidad="1", tipo=RECIBIDA, contrato=""):
    return MovimientoWallet(red="btc", hash="h", fecha=datetime(2026, 5, 1, tzinfo=UTC), simbolo="BTC",
                            cantidad=Decimal(cantidad), comision=None, tipo=tipo, contraparte="", contrato=contrato)


def testPorDefectoAvisaDeTodo():
    config = ConfigAvisos.validar({})

    assert config == ConfigAvisos()
    for movimiento in (_mov(tipo=RECIBIDA), _mov(tipo=ENVIADA), _mov(tipo=ENTRE_WALLETS), _mov(contrato="0xt")):
        assert wa.avisaDeMovimiento(config, "", movimiento, None)


def testValidarNormalizaLosNumeros():
    config = ConfigAvisos.validar({"minimoEur": " 1000,50 ", "saldoMinimo": "0.10", "despiertaDias": "30"})

    assert (config.minimoEur, config.saldoMinimo, config.despiertaDias) == ("1000.5", "0.1", 30)


@pytest.mark.parametrize("datos, campo", [
    ("no es un dict", "avisosConfig"),
    ({"recibidas": "si"}, "recibidas"),
    ({"minimoEur": "-1"}, "minimoEur"),
    ({"minimoEur": "abc"}, "minimoEur"),
    ({"saldoMaximo": "Infinity"}, "saldoMaximo"),
    ({"saldoMinimo": "5", "saldoMaximo": "5"}, "saldoMaximo"),
    ({"despiertaDias": "1.5"}, "despiertaDias"),
    ({"despiertaDias": 99999}, "despiertaDias"),
    ({"despiertaDias": True}, "despiertaDias"),
    ({"maxPorRevision": 51}, "maxPorRevision"),
    ({"silencioDesde": "25:00", "silencioHasta": "08:00"}, "silencioDesde"),
    ({"silencioDesde": "23:00"}, "silencioHasta"),
    ({"silencioDesde": "08:00", "silencioHasta": "08:00"}, "silencioHasta"),
])
def testValidarRechaza(datos, campo):
    with pytest.raises(ConfigAvisosInvalida) as error:
        ConfigAvisos.validar(datos)

    assert error.value.campo == campo


def testLoGuardadoIlegibleVuelveAlPorDefecto():
    assert ConfigAvisos.desdeGuardado({"minimoEur": "abc"}) == ConfigAvisos()
    assert ConfigAvisos.desdeGuardado(None) == ConfigAvisos()


@pytest.mark.parametrize("campo, tipo", [("recibidas", RECIBIDA), ("enviadas", ENVIADA), ("internas", ENTRE_WALLETS)])
def testCadaDireccionSePuedeApagar(campo, tipo):
    config = ConfigAvisos(**{campo: False})

    assert not wa.avisaDeMovimiento(config, "", _mov(tipo=tipo), None)
    otro = RECIBIDA if tipo != RECIBIDA else ENVIADA
    assert wa.avisaDeMovimiento(config, "", _mov(tipo=otro), None)


def testSinTokens():
    config = ConfigAvisos(tokens=False)

    assert not wa.avisaDeMovimiento(config, "", _mov(contrato="0xtoken"), None)
    assert wa.avisaDeMovimiento(config, "", _mov(), None)


def testMinimoEnEuros():
    config = ConfigAvisos(minimoEur="1000")

    assert not wa.avisaDeMovimiento(config, "", _mov("0.01"), Decimal("60000"))
    assert wa.avisaDeMovimiento(config, "", _mov("0.02"), Decimal("60000"))
    # Sin precio no se puede comparar: mejor avisar que perderlo.
    assert wa.avisaDeMovimiento(config, "", _mov("0.0001"), None)
    # Un token no tiene precio aquí.
    assert not wa.avisaDeMovimiento(config, "", _mov("99999", contrato="0xt"), Decimal("1"))


def testElMinimoNativoYElDeEurosSeSuman():
    config = ConfigAvisos(minimoEur="100")

    assert not wa.avisaDeMovimiento(config, "1", _mov("0.5"), Decimal("60000"))
    assert wa.avisaDeMovimiento(config, "1", _mov("1"), Decimal("60000"))


@pytest.mark.parametrize("saldo, esperado", [("0.5", wa.BAJO), ("1", ""), ("3", ""), ("3.01", wa.ALTO), (None, "")])
def testEstadoSaldo(saldo, esperado):
    config = ConfigAvisos(saldoMinimo="1", saldoMaximo="3")

    assert wa.estadoSaldo(config, Decimal(saldo) if saldo else None) == esperado


def testDiasDormida():
    siguiente = datetime(2026, 5, 31, tzinfo=UTC)

    assert wa.diasDormida("2026-05-01T00:00:00+00:00", siguiente) == 30
    assert wa.diasDormida("", siguiente) is None
    assert wa.diasDormida("no es fecha", siguiente) is None


@pytest.mark.parametrize("desde, hasta, hora, esperado", [
    ("23:00", "08:00", "23:30", True),
    ("23:00", "08:00", "03:00", True),
    ("23:00", "08:00", "08:00", False),
    ("23:00", "08:00", "12:00", False),
    ("13:00", "15:00", "14:59", True),
    ("13:00", "15:00", "15:00", False),
    ("", "", "03:00", False),
])
def testEnSilencio(desde, hasta, hora, esperado):
    config = ConfigAvisos(silencioDesde=desde, silencioHasta=hasta)
    ahora = datetime.strptime(f"2026-05-01 {hora}", "%Y-%m-%d %H:%M")

    assert wa.enSilencio(config, ahora) is esperado


def testComponerMensajes():
    lineas = ["a", "b", "c"]

    assert wa.componerMensajes("L", lineas, ConfigAvisos()) == lineas
    assert wa.componerMensajes("L", lineas, ConfigAvisos(agrupar=True)) == ["3 avisos de «L»:\n\na\n\nb\n\nc"]
    assert wa.componerMensajes("L", ["a"], ConfigAvisos(agrupar=True)) == ["a"]
    assert wa.componerMensajes("L", lineas, ConfigAvisos(maxPorRevision=3)) == lineas
    assert wa.componerMensajes("L", lineas, ConfigAvisos(maxPorRevision=2)) == ["a", "Y 2 avisos más de «L»:\n\nb\n\nc"]
    assert wa.componerMensajes("L", lineas, ConfigAvisos(maxPorRevision=1)) == ["3 avisos de «L»:\n\na\n\nb\n\nc"]


_SOSPECHOSOS = ConfigAvisos(direccionNueva=True, vaciado=True, polvo=True, rafaga=True)
_CONOCIDA = "0xabcd1111111111111111111111111111111dead"


def testLosSospechososVienenApagados():
    config = ConfigAvisos()

    assert not (config.direccionNueva or config.vaciado or config.polvo or config.rafaga)
    assert wa.motivosSospecha(config, _mov("0", tipo=RECIBIDA), "x", set(), set(), None) == []


@pytest.mark.parametrize("direccion, esperado", [
    ("0xabcd9999999999999999999999999999999dead", True),
    (_CONOCIDA, False),
    ("0xabce1111111111111111111111111111111dead", False),
    ("0xabcd1111111111111111111111111111111beef", False),
    ("", False),
    ("0xabcdead", False),
])
def testPareceA(direccion, esperado):
    assert wa.pareceA(direccion, {_CONOCIDA}) is esperado


def testEnvioAUnaDireccionNueva():
    envio = _mov(tipo=ENVIADA)

    assert wa.motivosSospecha(_SOSPECHOSOS, envio, "nueva", {"vieja"}, set(), None) == [wa.MOTIVO_NUEVA]
    assert wa.motivosSospecha(_SOSPECHOSOS, envio, "vieja", {"vieja"}, set(), None) == []
    # La libreta cuenta como conocida, y sin contrapartes apuntadas no hay nada nuevo.
    assert wa.motivosSospecha(_SOSPECHOSOS, envio, "nueva", set(), {"nueva"}, None) == []
    assert wa.motivosSospecha(_SOSPECHOSOS, envio, "nueva", None, set(), None) == []
    # Lo recibido de una dirección nueva es lo normal.
    assert wa.motivosSospecha(_SOSPECHOSOS, _mov(tipo=RECIBIDA), "nueva", set(), set(), None) == []


def testPolvo():
    def motivos(movimiento, precio):
        return wa.motivosSospecha(_SOSPECHOSOS, movimiento, "x", {"x"}, set(), precio)

    assert motivos(_mov("0", contrato="0xspam"), None) == [wa.MOTIVO_POLVO]
    assert motivos(_mov("0.00001"), Decimal("60000")) == [wa.MOTIVO_POLVO]
    assert motivos(_mov("0.001"), Decimal("60000")) == []
    # Sin precio solo cuenta el cero: mejor no avisar que inventar un umbral por moneda.
    assert motivos(_mov("0.00001"), None) == []
    assert motivos(_mov("5", contrato="0xt"), Decimal("60000")) == []


def testDireccionParecidaEnAmbosSentidos():
    imitacion = "0xabcd9999999999999999999999999999999dead"

    for tipo in (ENVIADA, RECIBIDA):
        motivos = wa.motivosSospecha(_SOSPECHOSOS, _mov(tipo=tipo), imitacion, {_CONOCIDA}, set(), None)
        assert wa.MOTIVO_PARECIDA in motivos


def testUnTokenImitacionNuncaAvisaComoMovimientoNormal():
    token = _mov("5000", contrato="0xt")

    assert wa.avisaDeMovimiento(ConfigAvisos(), "", token, None)
    assert not wa.avisaDeMovimiento(ConfigAvisos(), "", token, None, imitacion=True)
    assert not wa.avisaDeMovimiento(ConfigAvisos(imitaciones=True), "", token, None, imitacion=True)


def testUnTokenImitacionEsSospechosoSoloConSuInterruptor():
    token = _mov("5000", contrato="0xt")

    assert wa.motivosSospecha(ConfigAvisos(), token, "", None, set(), None, imitacion=True) == []
    con = ConfigAvisos(imitaciones=True)
    assert wa.motivosSospecha(con, token, "", None, set(), None, imitacion=True) == [wa.MOTIVO_IMITACION]
    assert wa.motivosSospecha(con, token, "", None, set(), None) == []


def testUnaImitacionConDireccionParecidaSigueAvisandoSinSuInterruptor():
    # El envenenamiento de direcciones suele llegar como un token falso: el
    # aviso de dirección parecida no se pierde por ser una imitación.
    motivos = wa.motivosSospecha(_SOSPECHOSOS, _mov("0", contrato="0xt"), "0xabcd9999999999999999999999999999999dead",
                                 {_CONOCIDA}, set(), None, imitacion=True)

    assert wa.MOTIVO_PARECIDA in motivos and wa.MOTIVO_IMITACION not in motivos


@pytest.mark.parametrize("previo, saldo, movimientos, esperado", [
    ("10", "0.5", [_mov(tipo=ENVIADA)], True),
    ("10", "1", [_mov(tipo=ENVIADA)], True),
    ("10", "1.1", [_mov(tipo=ENVIADA)], False),
    ("10", "0", [_mov(tipo=ENTRE_WALLETS)], False),
    ("10", "0", [_mov(tipo=ENVIADA, contrato="0xt")], False),
    ("0", "0", [_mov(tipo=ENVIADA)], False),
    (None, "0", [_mov(tipo=ENVIADA)], False),
])
def testVaciado(previo, saldo, movimientos, esperado):
    previo = Decimal(previo) if previo is not None else None

    assert wa.esVaciado(_SOSPECHOSOS, previo, Decimal(saldo), movimientos) is esperado
    assert wa.esVaciado(ConfigAvisos(), previo, Decimal(saldo), movimientos) is False


def testRafaga():
    envios = [_mov(tipo=ENVIADA)] * wa.MIN_RAFAGA

    assert wa.enviosRafaga(_SOSPECHOSOS, envios) == wa.MIN_RAFAGA
    assert wa.enviosRafaga(_SOSPECHOSOS, [*envios[1:], _mov(tipo=RECIBIDA)]) == 0
    assert wa.enviosRafaga(ConfigAvisos(), envios) == 0


def testValidarAceptaLosSospechosos():
    config = ConfigAvisos.validar({"vaciado": True, "polvo": True})

    assert config.vaciado and config.polvo and not config.rafaga
    with pytest.raises(ConfigAvisosInvalida):
        ConfigAvisos.validar({"rafaga": "si"})
