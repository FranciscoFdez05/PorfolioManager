"""Lo que el ZIP lleva además de los datos: preferencias de interfaz y claves.

Aquí lo que se vigila es sobre todo **lo que no debe pasar**. Las claves de API
viajan en claro, así que el ZIP se convierte en un secreto en cuanto se
incluyen: que eso solo ocurra cuando se pide explícitamente no es un detalle de
comodidad, es la diferencia entre un fichero que se puede dejar en Descargas y
uno que no. Y el volcado de `localStorage` lo manda el navegador sin que nadie
lo mire, así que entra saneado o no entra.
"""

import io
import json
import zipfile

import pytest

from core import exportables


@pytest.fixture(autouse=True)
def clavesAisladas(tmp_path, monkeypatch):
    """Saca API/ del repositorio: estos tests escriben claves de verdad.

    El `assert` del final no es paranoia: la primera versión de este fichero
    parcheaba un sitio que no era, `exportables` se había quedado con la función
    original al importarse, y la prueba acabó sobrescribiendo el
    `API/movimientos.key` de la máquina. Comprobar a dónde apunta antes de
    escribir cuesta una línea.
    """
    from core import firma_hmac, paths

    destino = tmp_path / "API"
    destino.mkdir()
    monkeypatch.setattr(paths, "API_DIR", destino)
    monkeypatch.setattr(firma_hmac, "rutaFicheroClave", lambda: destino / "movimientos.key")
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")

    for proveedor in ("finnhub", exportables.CLAVE_ATAJO):
        assert tmp_path in exportables.destinoDe(proveedor).parents

    return destino


# ── Volcado de la interfaz ────────────────────────────────────────────────────

def testSeConservaLoQueMandaElNavegador():
    ui = exportables.sanearUi(
        {
            "sttSectionOrder-sttPage-api": '[["Claves API"],["Atajo de iOS"]]',
            "tableSort_btc": '{"col":2,"dir":"desc"}',
            "activosViewMode": "tarjetas",
        }
    )

    assert len(ui) == 3
    assert ui["activosViewMode"] == "tarjetas"


def testLoQueNoEsTextoSeDescartaSinTirarElExport():
    """`localStorage` solo guarda cadenas: lo que llegue de otro tipo no lo ha
    puesto la aplicación. Se descarta esa entrada, no la copia entera —perder un
    backup porque una extensión dejó basura en el almacenamiento sería un
    intercambio pésimo."""
    ui = exportables.sanearUi({"bueno": "sí", "raro": 12, "peor": {"a": 1}, 7: "clave no textual"})

    assert ui == {"bueno": "sí"}


def testHayTopeDeTamaño():
    """Lo manda el cliente y acaba en un fichero: sin tope, una pestaña con el
    almacenamiento lleno convierte el export en un ZIP de decenas de megas."""
    enorme = {f"clave{i}": "x" * 1000 for i in range(exportables.MAX_CLAVES_UI + 50)}

    assert len(exportables.sanearUi(enorme)) <= exportables.MAX_CLAVES_UI


def testUnValorGiganteNoEntra():
    ui = exportables.sanearUi({"normal": "vale", "gigante": "x" * (exportables.MAX_LARGO_VALOR + 1)})

    assert ui == {"normal": "vale"}


def testLoQueNoEsUnDiccionarioNoRompeNada():
    assert exportables.sanearUi(None) == {}
    assert exportables.sanearUi("una cadena") == {}
    assert exportables.sanearUi([1, 2, 3]) == {}


# ── Claves ────────────────────────────────────────────────────────────────────

def testLasClavesVuelvenCifradasConLaSecretKeyDeAquí(clavesAisladas):
    """Es el sentido de todo esto: entran en claro desde el ZIP y se guardan con
    la clave de ESTA instalación, que es lo que hace que una copia sirva en un
    servidor recién montado."""
    from core.secret_store import readSecretLines

    escritos = exportables.restaurarClaves({"finnhub": ["clave-finnhub"], "eodhd": ["una", "otra"]})

    assert sorted(escritos) == ["eodhd.key", "finnhub.key"]
    assert readSecretLines(clavesAisladas / "finnhub.key") == ["clave-finnhub"]
    assert readSecretLines(clavesAisladas / "eodhd.key") == ["una", "otra"]
    # Cifrado en reposo, no en texto plano dentro de API/.
    assert b"clave-finnhub" not in (clavesAisladas / "finnhub.key").read_bytes()


def testUnProveedorInventadoNoEscribeNingúnFichero(clavesAisladas):
    """El nombre viene de un ZIP que puede haber tocado cualquiera: si se usara
    tal cual para componer la ruta, escribiría dentro de API/ lo que quisiera."""
    escritos = exportables.restaurarClaves({"../../etc/passwd": ["x"], "inventado": ["y"]})

    assert escritos == []
    assert list(clavesAisladas.iterdir()) == []


def testLaClaveDelAtajoTambiénViaja(clavesAisladas):
    """Se pierde en una reinstalación igual que las otras, y rehacerla obliga a
    volver a montar el Atajo en el iPhone."""
    escritos = exportables.restaurarClaves({exportables.CLAVE_ATAJO: ["clave-del-atajo"]})

    assert escritos == ["movimientos.key"]

    from core import firma_hmac

    assert firma_hmac.obtenerClaveSecreta() == b"clave-del-atajo"


def testUnaListaVacíaNoDejaUnFicheroVacío(clavesAisladas):
    assert exportables.restaurarClaves({"finnhub": []}) == []
    assert not (clavesAisladas / "finnhub.key").exists()


# ── El ZIP ────────────────────────────────────────────────────────────────────

@pytest.fixture
def bpAjustes():
    from routes.ajustes import ajustesBp
    return ajustesBp


def _nombres(datos):
    with zipfile.ZipFile(io.BytesIO(datos)) as zf:
        return zf.namelist()


def testPorDefectoElZipNoLlevaClaves(clienteAutenticado, bpAjustes, monkeypatch):
    """La comprobación que más importa de este fichero: sin marcar la casilla, el
    ZIP tiene que poder dejarse en Descargas sin pensarlo."""
    monkeypatch.setattr(exportables, "clavesEnClaro", lambda: {"finnhub": ["no-deberia-salir"]})
    client, cab, _app = clienteAutenticado(bpAjustes)

    for respuesta in (client.get("/api/export/zip"), client.post("/api/export/zip", headers=cab, json={})):
        assert respuesta.status_code == 200
        assert exportables.FICHERO_CLAVES not in _nombres(respuesta.data)
        assert b"no-deberia-salir" not in respuesta.data


def testConLaCasillaMarcadaLasClavesVanEnClaro(clienteAutenticado, bpAjustes, monkeypatch):
    monkeypatch.setattr(exportables, "clavesEnClaro", lambda: {"finnhub": ["clave-de-verdad"]})
    client, cab, _app = clienteAutenticado(bpAjustes)

    res = client.post("/api/export/zip", headers=cab, json={"incluirClaves": True})

    with zipfile.ZipFile(io.BytesIO(res.data)) as zf:
        claves = json.loads(zf.read(exportables.FICHERO_CLAVES))

    assert claves == {"finnhub": ["clave-de-verdad"]}


def testLasPreferenciasDeInterfazEntranEnElZip(clienteAutenticado, bpAjustes):
    client, cab, _app = clienteAutenticado(bpAjustes)

    res = client.post(
        "/api/export/zip",
        headers=cab,
        json={"ui": {"activosViewMode": "tarjetas", "tableSort_btc": '{"col":2}'}},
    )

    with zipfile.ZipFile(io.BytesIO(res.data)) as zf:
        ui = json.loads(zf.read(exportables.FICHERO_UI))

    assert ui["activosViewMode"] == "tarjetas"


def testSinPreferenciasNoSeMeteUnFicheroVacío(clienteAutenticado, bpAjustes):
    client, cab, _app = clienteAutenticado(bpAjustes)

    res = client.post("/api/export/zip", headers=cab, json={"ui": {}})

    assert exportables.FICHERO_UI not in _nombres(res.data)


# ── Claves protegidas con contraseña ──────────────────────────────────────────

def testCifrarYDescifrarDevuelveLasMismasClaves():
    paquete = exportables.cifrarClaves({"finnhub": ["abc"], "atajo": ["k"]}, "secreta")

    assert paquete["formato"] == "pbkdf2-sha256+fernet"
    assert "abc" not in json.dumps(paquete)
    assert exportables.descifrarClaves(paquete, "secreta") == {"finnhub": ["abc"], "atajo": ["k"]}


def testUnaContraseñaEquivocadaNoDescifraNada():
    paquete = exportables.cifrarClaves({"finnhub": ["abc"]}, "secreta")

    with pytest.raises(exportables.ContrasenaIncorrecta):
        exportables.descifrarClaves(paquete, "otra")


def testUnPaqueteManipuladoSeTrataComoContraseñaIncorrecta():
    """Salt de dos bytes, iteraciones absurdas o un formato inventado: ninguno
    debe llegar a derivar una clave, y menos a tumbar la importación."""
    for paquete in (
        {"formato": "otro", "salt": "AAAA", "iteraciones": 600000, "datos": "x"},
        {"formato": "pbkdf2-sha256+fernet", "salt": "AA==", "iteraciones": 600000, "datos": "x"},
        {"formato": "pbkdf2-sha256+fernet", "salt": "AAAAAAAAAAAAAAAAAAAAAA==", "iteraciones": 10, "datos": "x"},
        "no es un dict",
    ):
        with pytest.raises(exportables.ContrasenaIncorrecta):
            exportables.descifrarClaves(paquete, "secreta")


def testConContraseñaLasClavesVanCifradasYNoEnClaro(clienteAutenticado, bpAjustes, monkeypatch):
    monkeypatch.setattr(exportables, "clavesEnClaro", lambda: {"finnhub": ["clave-de-verdad"]})
    client, cab, _app = clienteAutenticado(bpAjustes)

    res = client.post("/api/export/zip", headers=cab, json={"incluirClaves": True, "contrasena": "secreta"})

    nombres = _nombres(res.data)
    assert exportables.FICHERO_CLAVES_CIFRADAS in nombres
    assert exportables.FICHERO_CLAVES not in nombres
    assert b"clave-de-verdad" not in res.data


def testUnaContraseñaVacíaEsNoPonerContraseña(clienteAutenticado, bpAjustes, monkeypatch):
    monkeypatch.setattr(exportables, "clavesEnClaro", lambda: {"finnhub": ["clave-de-verdad"]})
    client, cab, _app = clienteAutenticado(bpAjustes)

    res = client.post("/api/export/zip", headers=cab, json={"incluirClaves": True, "contrasena": ""})

    assert exportables.FICHERO_CLAVES in _nombres(res.data)


def _zipConClavesCifradas(contrasena="secreta"):
    """Un ZIP de export mínimo: ajustes.json (para que valga) y las claves."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("ajustes.json", "{}")
        paquete = exportables.cifrarClaves({"finnhub": ["clave-restaurada"]}, contrasena)
        zf.writestr(exportables.FICHERO_CLAVES_CIFRADAS, json.dumps(paquete))
    return buf.getvalue()


def _importar(client, cab, datos, **campos):
    return client.post(
        "/api/import/zip",
        data={"file": (io.BytesIO(datos), "export.zip"), **campos},
        headers=cab, content_type="multipart/form-data",
    )


def testImportarSinContraseñaLaPideYNoTocaNada(clienteAutenticado, bpAjustes, datosAislados, tempDb, clavesAisladas):
    client, cab, _app = clienteAutenticado(bpAjustes)

    res = _importar(client, cab, _zipConClavesCifradas())

    assert res.status_code == 400
    assert res.get_json()["necesitaContrasena"] is True
    assert list(clavesAisladas.iterdir()) == [], "no se escribió ninguna clave"


def testUnaContraseñaIncorrectaSeDiceYSeVuelveAPedir(clienteAutenticado, bpAjustes, datosAislados, tempDb, clavesAisladas):
    client, cab, _app = clienteAutenticado(bpAjustes)

    res = _importar(client, cab, _zipConClavesCifradas(), contrasena="otra")

    datos = res.get_json()
    assert res.status_code == 400
    assert datos["necesitaContrasena"] is True
    assert "incorrecta" in datos["error"].lower()
    assert list(clavesAisladas.iterdir()) == []


def testConLaContraseñaLasClavesSeRestauran(clienteAutenticado, bpAjustes, datosAislados, tempDb, clavesAisladas):
    from core.secret_store import readSecretLines

    client, cab, _app = clienteAutenticado(bpAjustes)

    res = _importar(client, cab, _zipConClavesCifradas(), contrasena="secreta")

    assert res.status_code == 200
    assert res.get_json()["claves"] == ["finnhub.key"]
    assert readSecretLines(clavesAisladas / "finnhub.key") == ["clave-restaurada"]


def testSePuedeImportarElRestoSinLasClaves(clienteAutenticado, bpAjustes, datosAislados, tempDb, clavesAisladas):
    """Quien ha perdido la contraseña no pierde también la cartera."""
    client, cab, _app = clienteAutenticado(bpAjustes)

    res = _importar(client, cab, _zipConClavesCifradas(), sinClaves="1")

    assert res.status_code == 200
    assert res.get_json()["claves"] == []
    assert list(clavesAisladas.iterdir()) == []
