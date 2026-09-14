"""Genera el fichero `.shortcut` del Atajo de iOS a partir de la URL del servidor.

**Por qué se genera y no se distribuye ya hecho.** El Atajo lleva dentro la
dirección del servidor, y esa cambia con la instalación: la IP de la LAN, la del
túnel, el puerto y —desde que el HTTPS se enciende desde Ajustes— el esquema. Un
fichero fijo en el repositorio obligaría a editar tres acciones a mano en el
iPhone, que es justo donde se equivoca todo el mundo.

**Qué NO lleva dentro: la clave de firma.** El Atajo no la necesita, porque pide
la firma a `/api/preparar` en cada ejecución. Así que este fichero no es un
secreto: se puede guardar en Archivos o mandar por AirDrop sin exponer nada. Lo
único que contiene es la dirección del servidor.

**El formato.** Un `.shortcut` es un plist con la lista de acciones. Se genera en
XML y **sin firmar**, porque firmarlo exige las claves de Apple. Un atajo sin
firmar solo se importa con «Atajos no fiables» activado (Ajustes > Atajos), que a
su vez exige haber ejecutado algún atajo antes. Eso se le dice al usuario junto
al botón de descarga: sin el aviso, el fichero se abre y no ocurre nada.

**Por qué hay un «Si» después de cada llamada al servidor.** Atajos no trata
un 403 o un 404 como un error: «Obtener contenido de la URL» devuelve el JSON
del error tan campante, «Obtener valor del diccionario» no encuentra la clave y
sale vacío, y «Elegir de la lista» con una lista vacía **no pregunta nada y
sigue**. El resultado era un atajo que, con el filtro de red rechazando al
móvil, se saltaba la base de datos y la categoría, pedía concepto e importe,
enviaba un cuerpo vacío y terminaba con la notificación de «Apuntado» sin haber
apuntado nada. Ahora cada respuesta se guarda, se comprueba lo que se esperaba
de ella y, si no está, se enseña el `error` que ha devuelto el servidor y el
atajo se detiene ahí.

Las acciones son las mismas, y en el mismo orden, que la receta manual de
`docs/atajo-ios.md`. Ese documento explica **por qué** cada paso es como es;
este módulo solo la escribe en el formato que entiende iOS. Si se toca una, hay
que tocar la otra.
"""

import plistlib
import uuid

# Hueco que Atajos usa para una variable dentro de un texto. Las posiciones de
# `attachmentsByRange` se cuentan sobre la cadena ya con los huecos puestos, así
# que el texto y el mapa se construyen siempre a la vez (ver `_texto`).
HUECO = "￼"

# Identificadores internos de las acciones. No aparecen en la interfaz de
# Atajos, pero son lo que hay dentro de cualquier `.shortcut` exportado.
_URL = "is.workflow.actions.downloadurl"
_DICCIONARIO = "is.workflow.actions.getvalueforkey"
_ELEGIR = "is.workflow.actions.choosefromlist"
_VARIABLE = "is.workflow.actions.setvariable"
_TEXTO = "is.workflow.actions.gettext"
_PARTIR = "is.workflow.actions.text.split"
_PREGUNTAR = "is.workflow.actions.ask"
_NOTIFICAR = "is.workflow.actions.shownotification"
_SI = "is.workflow.actions.conditional"
_ALERTA = "is.workflow.actions.alert"
_PARAR = "is.workflow.actions.exit"

# Códigos internos de la condición del «Si». Son los de iOS 13 en adelante.
_NO_TIENE_VALOR = 101


def _accion(identificador, parametros=None):
    return {
        "WFWorkflowActionIdentifier": identificador,
        "WFWorkflowActionParameters": parametros or {},
    }


def _variable(nombre):
    """Referencia a una variable en un campo que la admite entera."""
    return {
        "Value": {"Type": "Variable", "VariableName": nombre},
        "WFSerializationType": "WFTextTokenAttachment",
    }


def _texto(*trozos):
    """Texto con variables intercaladas.

    Cada trozo es una cadena literal o `("var", nombre)`. Devuelve el formato que
    espera Atajos: la cadena con un hueco por variable, más el mapa de
    posiciones. Se calcula aquí en vez de escribirlo a mano porque si no, tocar
    una letra del texto descoloca todas las posiciones siguientes y el atajo se
    importa con las variables en el sitio equivocado.
    """
    cadena = ""
    adjuntos = {}

    for trozo in trozos:
        if isinstance(trozo, tuple):
            adjuntos[f"{{{len(cadena)}, 1}}"] = {"Type": "Variable", "VariableName": trozo[1]}
            cadena += HUECO
        else:
            cadena += trozo

    valor = {"string": cadena}
    if adjuntos:
        valor["attachmentsByRange"] = adjuntos

    return {"Value": valor, "WFSerializationType": "WFTextTokenString"}


def _campos(pares):
    """Diccionario de campos —cuerpo JSON o cabeceras— en el formato de Atajos."""
    return {
        "Value": {
            "WFDictionaryFieldValueItems": [
                {"WFItemType": 0, "WFKey": _texto(clave), "WFValue": valor}
                for clave, valor in pares
            ]
        },
        "WFSerializationType": "WFDictionaryFieldValue",
    }


def _guardar(nombre):
    return _accion(_VARIABLE, {"WFVariableName": nombre})


def _valorDe(clave, variable=None):
    """«Obtener valor del diccionario». Sin `variable`, sobre la acción anterior."""
    parametros = {"WFDictionaryKey": clave, "WFGetDictionaryValueType": "Value"}
    if variable:
        parametros["WFInput"] = _variable(variable)
    return _accion(_DICCIONARIO, parametros)


def _pararSiVacia(variable, respuesta, titulo):
    """«Si `variable` no tiene valor: avisa con el error del servidor y para».

    Las tres acciones del bloque —abrir el «Si», el cuerpo y cerrarlo— van
    unidas por el mismo `GroupingIdentifier`; es así como Atajos sabe dónde
    empieza y acaba. El mensaje sale del campo `error` de `respuesta`, que es
    el mismo en todos los endpoints, así que la alerta dice «Origen no
    autorizado» o «Portfolio 'x' no encontrado» y no un genérico.
    """
    grupo = str(uuid.uuid4()).upper()
    return [
        _accion(_SI, {
            "GroupingIdentifier": grupo,
            "WFControlFlowMode": 0,
            "WFCondition": _NO_TIENE_VALOR,
            "WFInput": {"Type": "Variable", "Variable": _variable(variable)},
        }),
        _valorDe("error", respuesta),
        _guardar("motivo"),
        _accion(_ALERTA, {
            "WFAlertActionTitle": _texto(titulo),
            "WFAlertActionMessage": _texto(("var", "motivo")),
            "WFAlertActionCancelButtonShown": False,
        }),
        _accion(_PARAR),
        _accion(_SI, {"GroupingIdentifier": grupo, "WFControlFlowMode": 2}),
    ]


def acciones(urlBase: str) -> list:
    """Las acciones del Atajo, en el orden en que se ejecutan.

    El orden no es libre: elegir la base de datos va lo primero, antes de nada
    que ramifique, para que ningún paso acabe dentro de una rama por error. Y la
    fecha no se pregunta ni se calcula —la pone el servidor con el día en que
    llega la petición—, que es lo que hace que apuntar un gasto quepa en una
    pulsación desde el Centro de Control.
    """
    base = urlBase.rstrip("/")

    return [
        # 1. En qué base de datos, de las que tenga el servidor. La lista se
        # guarda y se comprueba antes de elegir: «Elegir de la lista» con una
        # lista vacía no pregunta, y el atajo seguiría como si nada.
        _accion(_URL, {"WFURL": _texto(f"{base}/api/portfolios-lista"), "WFHTTPMethod": "GET"}),
        _guardar("respuesta"),
        _valorDe("nombres", "respuesta"),
        _guardar("opciones"),
        *_pararSiVacia("opciones", "respuesta", "No se pudieron leer las bases de datos"),
        _accion(_ELEGIR, {
            "WFInput": _variable("opciones"),
            "WFChooseFromListActionPrompt": "¿En qué base de datos?",
        }),
        _guardar("bbdd"),

        # 2. Gasto o ingreso. Un texto de dos líneas partido en lista, y no
        # «Elegir del menú»: el menú abre dos ramas y habría que duplicar dentro
        # de cada una todo lo que viene después.
        _accion(_TEXTO, {"WFTextActionText": _texto("gasto\ningreso")}),
        _accion(_PARTIR, {"WFTextSeparator": "New Lines"}),
        _accion(_ELEGIR, {"WFChooseFromListActionPrompt": "¿Gasto o ingreso?"}),
        _guardar("tipo"),

        # 3. Las categorías vivas de esa base de datos y ese tipo. Con `?tipo=`
        # el servidor devuelve `lista` ya filtrada, así que todas las claves se
        # teclean y las variables solo aparecen en la URL.
        _accion(_URL, {
            "WFURL": _texto(
                f"{base}/api/categorias?portfolio=", ("var", "bbdd"), "&tipo=", ("var", "tipo")
            ),
            "WFHTTPMethod": "GET",
        }),
        _guardar("respuesta"),
        _valorDe("lista", "respuesta"),
        _guardar("opciones"),
        *_pararSiVacia("opciones", "respuesta", "No se pudieron leer las categorías"),
        _accion(_ELEGIR, {
            "WFInput": _variable("opciones"),
            "WFChooseFromListActionPrompt": "¿Qué categoría?",
        }),
        _guardar("categoria"),

        # 4. Concepto e importe.
        _accion(_PREGUNTAR, {"WFAskActionPrompt": "¿Concepto?", "WFInputType": "Text"}),
        _guardar("nombre"),
        _accion(_PREGUNTAR, {"WFAskActionPrompt": "¿Importe?", "WFInputType": "Number"}),
        _guardar("importe"),

        # 5. Preparar y firmar. Se manda un diccionario nativo y el servidor
        # devuelve el cuerpo ya serializado: firma el mismo proceso que
        # serializa, así que los bytes coinciden por construcción. Sin `fecha`,
        # que es la del día en que llega la petición.
        _accion(_URL, {
            "WFURL": _texto(f"{base}/api/preparar"),
            "WFHTTPMethod": "POST",
            "WFHTTPBodyType": "Json",
            "WFJSONValues": _campos([
                ("tipo", _texto(("var", "tipo"))),
                ("categoria", _texto(("var", "categoria"))),
                ("nombre", _texto(("var", "nombre"))),
                ("importe", _texto(("var", "importe"))),
                ("portfolio", _texto(("var", "bbdd"))),
            ]),
        }),
        _guardar("preparado"),
        _valorDe("cuerpo", "preparado"),
        _guardar("envio"),
        *_pararSiVacia("envio", "preparado", "No se pudo preparar el movimiento"),
        _valorDe("firma", "preparado"),
        _guardar("sello"),
        _valorDe("timestamp", "preparado"),
        _guardar("marca"),

        # 6. Enviarlo. El cuerpo va como «Archivo» y no como JSON: con JSON,
        # Atajos vuelve a serializar el texto, cambian los bytes y la firma falla
        # con un 401 que parece un problema de clave sin serlo.
        _accion(_URL, {
            "WFURL": _texto(f"{base}/api/movimiento"),
            "WFHTTPMethod": "POST",
            "WFHTTPBodyType": "File",
            "WFRequestVariable": _variable("envio"),
            "WFHTTPHeaders": _campos([
                ("Content-Type", _texto("application/json")),
                ("X-Signature", _texto(("var", "sello"))),
                ("X-Timestamp", _texto(("var", "marca"))),
            ]),
        }),

        # 7. Confirmar. La notificación solo sale si la respuesta trae el
        # movimiento creado; si no, la alerta con el error y se para. Sin esto,
        # un 401 de firma o un 403 del filtro de red terminaban en «Apuntado».
        _guardar("resultado"),
        _valorDe("movimiento.cantidad", "resultado"),
        _guardar("cantidad"),
        *_pararSiVacia("cantidad", "resultado", "No se ha apuntado"),
        _accion(_NOTIFICAR, {
            "WFNotificationActionTitle": "Apuntado",
            "WFNotificationActionBody": _texto(("var", "nombre"), ": ", ("var", "importe"), " €"),
        }),
    ]


def construir(urlBase: str) -> bytes:
    """El `.shortcut` completo, listo para descargar."""
    atajo = {
        "WFWorkflowActions": acciones(urlBase),
        "WFWorkflowClientVersion": "1146.7",
        "WFWorkflowHasOutputFallback": False,
        "WFWorkflowHasShortcutInputVariables": False,
        # Glifo y color del icono, en los números internos de Atajos.
        "WFWorkflowIcon": {
            "WFWorkflowIconGlyphNumber": 59446,
            "WFWorkflowIconStartColor": 4251333119,
        },
        # Vacío a propósito: no pregunta nada al importarse, porque la dirección
        # del servidor ya va escrita en las acciones.
        "WFWorkflowImportQuestions": [],
        "WFWorkflowInputContentItemClasses": [],
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        # Dónde puede aparecer: widget del Centro de Control y Apple Watch.
        "WFWorkflowTypes": ["NCWidget", "WatchKit"],
    }
    return plistlib.dumps(atajo, fmt=plistlib.FMT_XML, sort_keys=False)
