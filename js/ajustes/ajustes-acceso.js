// Ajustes: acceso.
//
// Panel de la pantalla de Ajustes separado de js/ajustes/ajustes.js. Antes todo
// vivía dentro de initAjustesLogic, una sola función de ~3.900 líneas; cada
// panel es ahora una función que initAjustesLogic llama en el mismo orden de
// siempre. Su código no ha cambiado: las funciones internas siguen anidadas.
// Atajo de iOS (clave, redes permitidas) y HTTPS.
function _initAjustesAtajoHttps() {
    // --- HTTPS ---
    // --- Atajo de iOS ---
    // El Atajo tenía todas sus piezas fuera de la vista: la clave en un fichero,
    // el interruptor y las redes en config.ini, y el diagnóstico solo en el log
    // del servidor. Cuando fallaba —y lo que falla casi siempre es que no hay
    // clave— la única forma de enterarse era entrar por SSH a leer los logs.
    const atajoEstadoEl = document.getElementById("ajustesAtajoEstado")
    const atajoDatosEl = document.getElementById("ajustesAtajoDatos")
    const atajoUrlEl = document.getElementById("ajustesAtajoUrl")
    const atajoRedesEl = document.getElementById("ajustesAtajoRedes")
    const atajoToleranciaEl = document.getElementById("ajustesAtajoTolerancia")
    const atajoTuIpEl = document.getElementById("ajustesAtajoTuIp")
    const atajoDescargarBtn = document.getElementById("ajustesAtajoDescargarBtn")
    const atajoProbarBtn = document.getElementById("ajustesAtajoProbarBtn")
    const atajoClaveBtn = document.getElementById("ajustesAtajoClaveBtn")
    const atajoMsg = document.getElementById("ajustesAtajoMsg")
    const atajoPruebaRes = document.getElementById("ajustesAtajoPruebaRes")
    const atajoRecetaEl = document.getElementById("ajustesAtajoReceta")
    const atajoRedesLista = document.getElementById("ajustesAtajoRedesLista")
    const atajoRedesAnadirBtn = document.getElementById("ajustesAtajoRedesAnadirBtn")
    const atajoExigirFirmaEl = document.getElementById("ajustesAtajoExigirFirma")
    const atajoAvisoFirmaEl = document.getElementById("ajustesAtajoAvisoFirma")
    const atajoAccesoBtn = document.getElementById("ajustesAtajoAccesoBtn")
    const atajoAccesoMsg = document.getElementById("ajustesAtajoAccesoMsg")
    const atajoRechazadasEl = document.getElementById("ajustesAtajoRechazadas")
    const atajoRechazadasLista = document.getElementById("ajustesAtajoRechazadasLista")
    const atajoRechazadasBtn = document.getElementById("ajustesAtajoRechazadasBtn")
    const atajoGuiaEl = document.getElementById("ajustesAtajoGuia")
    const atajoPasoClaveDetalle = document.getElementById("ajustesAtajoPasoClaveDetalle")
    const atajoPasoRedesDetalle = document.getElementById("ajustesAtajoPasoRedesDetalle")
    const atajoPasoProbarDetalle = document.getElementById("ajustesAtajoPasoProbarDetalle")
    const atajoRedesBtn = document.getElementById("ajustesAtajoRedesBtn")
    const atajoCopiarBtn = document.getElementById("ajustesAtajoCopiarBtn")

    // Lo último que devolvió el servidor: los botones de «Permitir» lo
    // necesitan para saber qué rangos hay y si se exige firma.
    let _atajoUltimo = null
    // Las redes guardadas en Ajustes (vacío = las de config.ini) y las de
    // config.ini, para decir a qué se vuelve al vaciar la lista.
    let _redesAjustes = []
    let _redesConfig = []

    function _pasoAtajo(id, estado) {
        const li = document.getElementById(id)
        if (li) li.dataset.estado = estado
    }

    let _atajoHayClave = false

    function _pintarAtajo(data) {
        if (!atajoEstadoEl) return

        let clase = "on"
        let texto = "<strong>Listo.</strong> Descarga el atajo y ábrelo en el iPhone."

        if (!data.activado) {
            clase = "roto"
            texto =
                "<strong>Desactivado.</strong> <code>[atajo] activado = false</code> en <code>config.ini</code>: estos endpoints responden 404."
        } else if (!data.redes || !data.redes.length) {
            clase = "roto"
            texto =
                "<strong>Sin redes permitidas.</strong> <code>[atajo] redes_permitidas</code> está vacío, y vacío no significa «todas»: no se acepta a nadie."
        } else if (data.acceso && data.acceso.exigirFirma === false) {
            clase = "off"
            texto =
                "<strong>Funcionando sin firma.</strong> Las peticiones se aceptan por venir de las redes permitidas, sin comprobar quién las manda."
        } else if (!data.clave || !data.clave.hay) {
            clase = "off"
            texto =
                data.clave && data.clave.origen === "ilegible"
                    ? `<strong>La clave no se puede leer.</strong> ${escapeHtml(data.clave.detalle)}`
                    : "<strong>Falta la clave de firma.</strong> Sin ella el servidor responde 503 y el Atajo no puede enviar nada. Se genera aquí mismo."
        } else if (data.clave.origen === "entorno") {
            texto = `<strong>Listo.</strong> La clave sale de <code>${escapeHtml(data.clave.detalle)}</code>, en el <code>.env</code> del servidor.`
        }

        atajoEstadoEl.className = "ajustesAtajoEstado " + clase
        atajoEstadoEl.innerHTML =
            '<span class="ajustesTlsPunto"></span><span class="ajustesTlsEstadoTexto">' + texto + "</span>"

        _atajoHayClave = !!(data.clave && data.clave.hay)
        _atajoUltimo = data

        _pintarPasosAtajo(data)

        if (atajoDatosEl) atajoDatosEl.hidden = false
        if (atajoUrlEl) atajoUrlEl.textContent = data.urlBase || "—"
        if (atajoRedesEl) atajoRedesEl.textContent = (data.redes || []).join(", ") || "ninguna"
        if (atajoToleranciaEl) atajoToleranciaEl.textContent = `±${data.tolerancia} s`

        // En Docker siempre hay un proxy delante, así que esta IP es la de Caddy
        // salvo que PROXY_FIX_HOPS esté bien puesto. Cuando no lo está, el filtro
        // deja de discriminar y el síntoma despista: el Atajo falla desde el
        // móvil con la IP correcta escrita en los rangos. Verla aquí lo resuelve
        // de un vistazo, y es lo primero que hay que mirar si se ha quitado la
        // firma, porque entonces es la única barrera que queda.
        if (atajoTuIpEl && data.verTe) {
            // Si es la IP de una red interna de Docker, todos los clientes se ven
            // igual y el filtro de red no distingue a nadie: se dice al lado.
            atajoTuIpEl.textContent = data.verTe.redInterna
                ? `${data.verTe.ip} — parece una red interna de Docker o del proxy, no la de tu equipo: revisa PROXY_FIX_HOPS`
                : data.verTe.ip
            atajoTuIpEl.classList.toggle("ajustesAtajoIpFuera", !data.verTe.permitida || Boolean(data.verTe.redInterna))
            atajoTuIpEl.title = data.verTe.permitida
                ? "Esta IP está dentro de las redes permitidas"
                : "Esta IP NO está dentro de las redes permitidas: una petición del Atajo desde aquí se rechazaría"
        }

        if (atajoClaveBtn) {
            // Generar y regenerar son la misma llamada, pero no la misma
            // decisión: con una clave puesta, el botón tiene que decir que la
            // sustituye.
            atajoClaveBtn.textContent = _atajoHayClave ? "Regenerar clave" : "Generar clave"
        }
        // Descargar el atajo sin clave da un atajo que no va a poder enviar nada,
        // salvo que la firma no se exija: entonces no hace falta ninguna.
        const _sinFirma = !!(data.acceso && data.acceso.exigirFirma === false)
        if (atajoDescargarBtn) atajoDescargarBtn.classList.toggle("ajustesBtnApagado", !_atajoHayClave && !_sinFirma)

        _pintarAccesoAtajo(data)

        _pintarRecetaAtajo(data.urlBase || "")
    }

    // --- Los cuatro pasos ---
    // Cada uno contesta una pregunta con un color: verde está hecho, ámbar
    // pide algo, rojo está roto. El texto de al lado dice qué, y el botón de
    // la derecha es lo que lo arregla. Así no hay que leer nada para saber
    // por dónde va uno.
    function _pintarPasosAtajo(data) {
        if (!atajoGuiaEl) return
        atajoGuiaEl.hidden = false

        const sinFirma = !!(data.acceso && data.acceso.exigirFirma === false)
        const clave = data.clave || {}

        // 1. Clave
        if (sinFirma) {
            _pasoAtajo("ajustesAtajoPasoClave", "aviso")
            _setTexto(
                atajoPasoClaveDetalle,
                "No se exige: las peticiones entran sin firmar. La clave no hace falta mientras esté así."
            )
        } else if (clave.hay) {
            _pasoAtajo("ajustesAtajoPasoClave", "ok")
            _setTexto(
                atajoPasoClaveDetalle,
                clave.origen === "entorno"
                    ? `Generada. Sale de ${clave.detalle}, en el .env del servidor.`
                    : `Generada y guardada en ${clave.detalle}.`
            )
        } else if (clave.origen === "ilegible") {
            _pasoAtajo("ajustesAtajoPasoClave", "mal")
            _setTexto(atajoPasoClaveDetalle, `No se puede leer. ${clave.detalle}`)
        } else {
            _pasoAtajo("ajustesAtajoPasoClave", "mal")
            _setTexto(
                atajoPasoClaveDetalle,
                "Falta. Sin ella el servidor no puede comprobar quién manda cada petición y el atajo no envía nada."
            )
        }

        // 2. Redes
        const redes = data.redes || []
        const rechazadas = (data.rechazadas || []).filter((r) => !r.permitida)
        const verTe = data.verTe || {}
        if (!data.activado) {
            _pasoAtajo("ajustesAtajoPasoRedes", "mal")
            _setTexto(
                atajoPasoRedesDetalle,
                "El Atajo está desactivado en config.ini ([atajo] activado = false): estas rutas responden 404."
            )
        } else if (!redes.length) {
            _pasoAtajo("ajustesAtajoPasoRedes", "mal")
            _setTexto(
                atajoPasoRedesDetalle,
                "No hay ninguna red permitida, y vacío no significa «todas»: no entra nadie."
            )
        } else if (rechazadas.length) {
            _pasoAtajo("ajustesAtajoPasoRedes", "aviso")
            _setTexto(
                atajoPasoRedesDetalle,
                rechazadas.length === 1
                    ? `Alguien ha llamado desde ${rechazadas[0].ip} y se ha rechazado. Si es el iPhone, permítelo aquí debajo.`
                    : `${rechazadas.length} direcciones han llamado y se han rechazado. Si una es el iPhone, permítela aquí debajo.`
            )
        } else if (verTe.ip && !verTe.permitida) {
            _pasoAtajo("ajustesAtajoPasoRedes", "aviso")
            _setTexto(
                atajoPasoRedesDetalle,
                `Se acepta desde ${redes.join(", ")}. Este navegador llega desde ${verTe.ip}, que queda fuera: si el iPhone está en la misma red, también quedará fuera.`
            )
        } else {
            _pasoAtajo("ajustesAtajoPasoRedes", "ok")
            const origen =
                data.acceso && data.acceso.origenRedes === "ajustes" ? "guardado aquí" : "lo que dice config.ini"
            _setTexto(
                atajoPasoRedesDetalle,
                `Se acepta desde ${redes.join(", ")} (${origen}). Nadie se ha quedado fuera desde que arrancó el servidor.`
            )
        }

        // 3. Instalar: se puede en cuanto hay clave (o no se exige) y redes.
        const puedeInstalar = data.activado && redes.length > 0 && (clave.hay || sinFirma)
        _pasoAtajo("ajustesAtajoPasoInstalar", puedeInstalar ? "ok" : "pendiente")

        // 4. Probar: hasta que se pulsa, no se sabe.
        if (!puedeInstalar) {
            _pasoAtajo("ajustesAtajoPasoProbar", "pendiente")
            if (atajoPruebaRes) atajoPruebaRes.hidden = true
            _setTexto(
                atajoPasoProbarDetalle,
                "Recorre el mismo camino que el atajo —clave, redes, firma— sin apuntar nada."
            )
        }
    }

    function _setTexto(el, texto) {
        if (el) el.textContent = texto
    }

    // --- Quién puede escribir por la API del Atajo ---
    // Las dos barreras que tienen esos endpoints, juntas y en la misma pantalla,
    // porque solo significan algo la una con la otra: quitar la firma deja la
    // red de origen como única puerta, y entonces qué rangos hay ahí deja de ser
    // un detalle de configuración.
    function _pintarAccesoAtajo(data) {
        const acceso = data.acceso || {}

        if (atajoExigirFirmaEl) atajoExigirFirmaEl.checked = acceso.exigirFirma !== false
        if (atajoAvisoFirmaEl) atajoAvisoFirmaEl.hidden = acceso.exigirFirma !== false

        // De config.ini no se copia nada a la lista: una lista vacía es lo que
        // significa «lo que diga config.ini», y rellenarla lo congelaría aquí
        // sin que nadie lo hubiera pedido.
        _redesAjustes = acceso.origenRedes === "ajustes" ? [...(data.redes || [])] : []
        _redesConfig = [...(acceso.redesConfig || [])]
        _pintarRedesAtajo()

        _pintarRechazadasAtajo(data)
    }

    // --- Lista de redes permitidas ---
    // Lo que hay guardado en Ajustes, una por línea y con lo que significa en
    // palabras: «solo esta IP» o «toda la red». El CIDR a pelo, en un campo de
    // texto separado por comas, obligaba a saber qué es una /32 antes de poder
    // dejar entrar al móvil.
    function _pintarRedesAtajo() {
        if (!atajoRedesLista) return
        atajoRedesLista.innerHTML = ""

        if (!_redesAjustes.length) {
            const vacio = document.createElement("div")
            vacio.className = "ajustesAtajoRedesVacio"
            vacio.textContent = _redesConfig.length
                ? `Ninguna aquí: se usan los rangos de config.ini (${_redesConfig.join(", ")}).`
                : "Ninguna aquí ni en config.ini: no se acepta a nadie."
            atajoRedesLista.appendChild(vacio)
            return
        }

        for (const cidr of _redesAjustes) {
            atajoRedesLista.appendChild(_filaRed(cidr, (btn) => _quitarRedAtajo(cidr, btn)))
        }
    }

    // Una línea de la lista: el rango, lo que significa, y el botón de quitar.
    // La usan la sección y el popup, que enseñan lo mismo.
    function _filaRed(cidr, onQuitar) {
        const fila = document.createElement("div")
        fila.className = "ajustesAtajoRedFila"

        const code = document.createElement("code")
        code.textContent = cidr
        fila.appendChild(code)

        const detalle = document.createElement("span")
        detalle.className = "ajustesAtajoRedDetalle"
        detalle.textContent = _describirRed(cidr)
        detalle.title = detalle.textContent
        fila.appendChild(detalle)

        const quitar = document.createElement("button")
        quitar.type = "button"
        quitar.className = "ajustesTlsAvisoBtn"
        quitar.textContent = "Quitar"
        quitar.addEventListener("click", () => onQuitar(quitar))
        fila.appendChild(quitar)

        return fila
    }

    // Quitar es guardar, igual que permitir: una fila menos y el servidor ya
    // no la acepta. Si era la última se vuelve a config.ini, y eso se dice.
    async function _quitarRedAtajo(cidr, btn) {
        const redes = _redesAjustes.filter((r) => r !== cidr)
        const ok = await _guardarRedesAtajo(redes, btn)
        if (ok) {
            showMsg(
                atajoAccesoMsg,
                redes.length ? `${cidr} quitada` : "Sin redes aquí: se usan las de config.ini",
                "ok"
            )
        }
    }

    // Lo que significa un rango, dicho para quien no sabe CIDR. Para IPv4 se
    // cuenta cuántas direcciones caben; para IPv6 no tiene sentido contarlas.
    function _describirRed(cidr) {
        const [ip, pref] = String(cidr).split("/")
        const prefijo = Number(pref)
        if (ip.includes(":")) return prefijo === 128 ? "solo esta IP" : "red IPv6"
        if (prefijo === 32) return "solo esta IP"
        if (prefijo === 24) return "toda la red · 256 direcciones"
        if (Number.isNaN(prefijo)) return "red"
        return `red · ${Math.pow(2, 32 - prefijo).toLocaleString("es-ES")} direcciones`
    }

    // Deja el rango como lo va a guardar el servidor: 192.168.1.5/24 pasa a
    // 192.168.1.0/24. Así la lista del popup enseña lo que de verdad se
    // permite, no lo que se tecleó. Devuelve null si no es una red válida.
    function _normalizarRed(texto) {
        const limpio = String(texto || "").trim()
        if (!limpio) return null
        const [ip, pref, ...resto] = limpio.split("/")
        if (resto.length) return null

        if (ip.includes(":")) {
            if (!/^[0-9a-fA-F:.]+$/.test(ip) || ip.split("::").length > 2) return null
            const prefijo = pref === undefined ? 128 : Number(pref)
            if (!Number.isInteger(prefijo) || prefijo < 0 || prefijo > 128) return null
            return `${ip.toLowerCase()}/${prefijo}`
        }

        const partes = ip.split(".")
        if (partes.length !== 4 || partes.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null
        const prefijo = pref === undefined ? 32 : Number(pref)
        if (!Number.isInteger(prefijo) || prefijo < 0 || prefijo > 32) return null

        const valor = partes.reduce((acc, p) => acc * 256 + Number(p), 0)
        const mascara = prefijo === 0 ? 0 : (0xffffffff << (32 - prefijo)) >>> 0
        const base = (valor & mascara) >>> 0
        const red = [24, 16, 8, 0].map((d) => (base >>> d) & 255).join(".")
        return `${red}/${prefijo}`
    }

    // Guarda la lista tal cual y repinta con lo que devuelve el servidor. Es el
    // camino por el que cambian las redes desde el popup y desde «Quitar»; la
    // firma se manda como esté el interruptor, sin tocarla.
    async function _guardarRedesAtajo(redes, btn) {
        const exigirFirma = atajoExigirFirmaEl ? !!atajoExigirFirmaEl.checked : true
        if (btn) btn.disabled = true
        showMsg(atajoAccesoMsg, "Guardando…", "")
        try {
            const res = await fetch("/api/atajo/acceso", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ exigirFirma, redes })
            })
            const data = await res.json()
            if (!data.ok) {
                showMsg(atajoAccesoMsg, data.error || "No se ha podido guardar", "error")
                return false
            }
            _pintarAtajo(data)
            showMsg(atajoAccesoMsg, "Guardado", "ok")
            return true
        } catch {
            showMsg(atajoAccesoMsg, "Error de red", "error")
            return false
        } finally {
            if (btn) btn.disabled = false
        }
    }

    // --- Popup de redes ---
    // Se escribe la IP del aparato y se elige si entra ella sola o toda su
    // wifi; quien sepa CIDR puede escribir la red directamente. Se parte de lo
    // que hay guardado y no se toca nada hasta pulsar Guardar.
    function _abrirModalRedes() {
        document.getElementById("ajustesRedesModalOverlay")?.remove()

        const redes = [..._redesAjustes]
        const data = _atajoUltimo || {}

        const overlay = document.createElement("div")
        overlay.id = "ajustesRedesModalOverlay"
        overlay.className = "modalOverlay ajustesPassModalOverlay"

        const modal = document.createElement("div")
        modal.className = "assetModal ajustesRedesModal"
        modal.setAttribute("role", "dialog")
        modal.setAttribute("aria-modal", "true")
        modal.innerHTML = `
            <h3 class="assetModalTitle">Redes desde las que se acepta</h3>
            <p class="ajustesPassModalText">
                Una por línea. Se acepta toda petición que llegue desde cualquiera de ellas y se
                rechaza el resto. Lo más fácil es poner la IP del iPhone y elegir si entra solo él
                o cualquier aparato de su wifi.
            </p>
            <div class="ajustesAtajoRedesLista" id="ajustesRedesModalLista"></div>

            <label class="assetModalLabel" for="ajustesRedesModalInput">Añadir</label>
            <div class="ajustesRedesModalAnadir">
                <input id="ajustesRedesModalInput" class="assetModalInput" type="text" autocomplete="off"
                       spellcheck="false" placeholder="192.168.1.25 o 10.0.0.0/8">
                <button type="button" class="ajustesTlsAvisoBtn" id="ajustesRedesModalSolo">Solo esta IP</button>
                <button type="button" class="ajustesTlsAvisoBtn" id="ajustesRedesModalRed">Toda su red</button>
            </div>
            <div class="ajustesFieldHint" id="ajustesRedesModalHint"></div>
            <p class="ajustesPassModalError hidden" id="ajustesRedesModalError"></p>

            <div class="ajustesRedesModalSugerencias" id="ajustesRedesModalSugerencias"></div>

            <div class="assetModalActions ajustesPassModalActions">
                <button type="button" class="cancelButton" id="ajustesRedesModalCancelar" data-no-autohide="true">Cancelar</button>
                <button type="button" class="primaryButton" id="ajustesRedesModalGuardar" data-no-autohide="true">Guardar</button>
            </div>
        `

        const lista = modal.querySelector("#ajustesRedesModalLista")
        const input = modal.querySelector("#ajustesRedesModalInput")
        const btnSolo = modal.querySelector("#ajustesRedesModalSolo")
        const btnRed = modal.querySelector("#ajustesRedesModalRed")
        const hint = modal.querySelector("#ajustesRedesModalHint")
        const errorEl = modal.querySelector("#ajustesRedesModalError")
        const sugerencias = modal.querySelector("#ajustesRedesModalSugerencias")
        const btnGuardar = modal.querySelector("#ajustesRedesModalGuardar")

        const cerrar = () => {
            overlay.remove()
            document.removeEventListener("keydown", onKey)
        }
        const onKey = (event) => {
            if (event.key === "Escape") cerrar()
        }
        const mostrarError = (msg) => {
            errorEl.textContent = msg
            errorEl.classList.toggle("hidden", !msg)
        }

        const pintarLista = () => {
            lista.innerHTML = ""
            if (!redes.length) {
                const vacio = document.createElement("div")
                vacio.className = "ajustesAtajoRedesVacio"
                vacio.textContent = _redesConfig.length
                    ? `Ninguna. Al guardar así se vuelve a los rangos de config.ini (${_redesConfig.join(", ")}).`
                    : "Ninguna. Al guardar así no se acepta a nadie."
                lista.appendChild(vacio)
                return
            }
            for (const cidr of redes) {
                lista.appendChild(
                    _filaRed(cidr, () => {
                        redes.splice(redes.indexOf(cidr), 1)
                        pintarLista()
                        pintarSugerencias()
                    })
                )
            }
        }

        const anadir = (cidr) => {
            const limpio = _normalizarRed(cidr)
            if (!limpio) {
                mostrarError("Eso no es una IP ni una red. Se escriben como 192.168.1.25 o 192.168.1.0/24.")
                input.focus()
                return
            }
            mostrarError("")
            if (!redes.includes(limpio)) redes.push(limpio)
            input.value = ""
            actualizarBotones()
            pintarLista()
            pintarSugerencias()
            input.focus()
        }

        // Lo escrito decide qué botones tienen sentido: con una IP suelta se
        // elige entre ella y su red; con una red ya escrita solo cabe añadirla.
        const actualizarBotones = () => {
            const texto = input.value.trim()
            const esRed = texto.includes("/")
            const esIpv6 = texto.includes(":")
            btnSolo.textContent = esRed ? "Añadir" : "Solo esta IP"
            btnRed.hidden = esRed
            btnRed.disabled = esIpv6
            btnRed.title = esIpv6 ? "Para IPv6 escribe la red con su prefijo" : ""
            hint.textContent = esRed
                ? "Se guardará la red tal cual, ajustada a su máscara."
                : "«Solo esta IP» deja entrar a ese aparato y a ningún otro. «Toda su red» deja entrar a cualquiera de su wifi (la /24, 256 direcciones)."
        }

        // Tu IP y las que el servidor ha rechazado, para no tener que
        // teclearlas: es de donde sale casi todo lo que se añade aquí.
        const pintarSugerencias = () => {
            sugerencias.innerHTML = ""
            const candidatas = []
            if (data.verTe?.ip) candidatas.push({ ip: data.verTe.ip, texto: "Este navegador" })
            for (const fila of data.rechazadas || []) {
                if (!candidatas.some((c) => c.ip === fila.ip)) candidatas.push({ ip: fila.ip, texto: "Rechazada" })
            }
            const pendientes = candidatas.filter((c) => {
                const sola = _cidrDeIp(c.ip)
                const red = _redDeIp(c.ip)
                return !redes.includes(sola) && !(red && redes.includes(red))
            })
            if (!pendientes.length) return

            const titulo = document.createElement("div")
            titulo.className = "ajustesRedesModalSugTitulo"
            titulo.textContent = "Añadir sin teclear"
            sugerencias.appendChild(titulo)

            for (const c of pendientes) {
                const fila = document.createElement("div")
                fila.className = "ajustesAtajoRechazo"
                const code = document.createElement("code")
                code.textContent = c.ip
                fila.appendChild(code)
                const detalle = document.createElement("span")
                detalle.className = "ajustesAtajoRechazoDetalle"
                detalle.textContent = c.texto
                fila.appendChild(detalle)
                const acciones = document.createElement("span")
                acciones.className = "ajustesAtajoRechazoAcciones"
                const solo = document.createElement("button")
                solo.type = "button"
                solo.className = "ajustesTlsAvisoBtn"
                solo.textContent = "Solo esta IP"
                solo.addEventListener("click", () => anadir(_cidrDeIp(c.ip)))
                acciones.appendChild(solo)
                const red = _redDeIp(c.ip)
                if (red) {
                    const toda = document.createElement("button")
                    toda.type = "button"
                    toda.className = "ajustesTlsAvisoBtn"
                    toda.textContent = `Toda su red (${red})`
                    toda.addEventListener("click", () => anadir(red))
                    acciones.appendChild(toda)
                }
                fila.appendChild(acciones)
                sugerencias.appendChild(fila)
            }
        }

        btnSolo.addEventListener("click", () => anadir(input.value))
        btnRed.addEventListener("click", () => {
            const red = _redDeIp(input.value.trim())
            if (!red) {
                mostrarError("Escribe una IPv4 para poder deducir su red.")
                input.focus()
                return
            }
            anadir(red)
        })
        input.addEventListener("input", () => {
            mostrarError("")
            actualizarBotones()
        })
        // Enter añade lo escrito, que es lo que se espera en una lista.
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault()
                anadir(input.value)
            }
        })
        modal.querySelector("#ajustesRedesModalCancelar").addEventListener("click", cerrar)
        btnGuardar.addEventListener("click", async () => {
            // Lo que quede en el campo sin añadir no se pierde en silencio.
            if (input.value.trim()) {
                mostrarError("Hay una IP escrita sin añadir: pulsa «Solo esta IP», «Toda su red» o borra el campo.")
                input.focus()
                return
            }
            const ok = await _guardarRedesAtajo(redes, btnGuardar)
            if (ok) cerrar()
        })
        document.addEventListener("keydown", onKey)

        actualizarBotones()
        pintarLista()
        pintarSugerencias()
        overlay.appendChild(modal)
        document.body.appendChild(overlay)
        input.focus()
    }

    // --- IPs que el filtro ha rechazado ---
    // Es la respuesta a «¿por qué no entra el móvil?» sin abrir el log: la IP
    // con la que llega, y un botón que la permite en el acto. Lo típico es una
    // wifi con más de una subred —invitados, un punto de acceso con su propio
    // DHCP— y el iPhone llegando desde una que no está en los rangos.
    function _pintarRechazadasAtajo(data) {
        if (!atajoRechazadasEl || !atajoRechazadasLista) return
        const filas = data.rechazadas || []
        atajoRechazadasEl.hidden = filas.length === 0
        atajoRechazadasLista.innerHTML = ""

        for (const fila of filas) {
            const div = document.createElement("div")
            div.className = "ajustesAtajoRechazo" + (fila.permitida ? " permitida" : "")

            const ip = document.createElement("code")
            ip.textContent = fila.ip
            div.appendChild(ip)

            const detalle = document.createElement("span")
            detalle.className = "ajustesAtajoRechazoDetalle"
            const veces = fila.veces > 1 ? ` · ${escapeHtml(fila.veces)} veces` : ""
            detalle.textContent = fila.permitida
                ? `ya permitida · ${_haceCuanto(fila.ultima)}${veces}`
                : `${_haceCuanto(fila.ultima)} · ${fila.metodo} ${fila.ruta}${veces}`
            div.appendChild(detalle)

            if (!fila.permitida) {
                const acciones = document.createElement("span")
                acciones.className = "ajustesAtajoRechazoAcciones"
                acciones.appendChild(_botonPermitir("Permitir", _cidrDeIp(fila.ip)))
                const red = _redDeIp(fila.ip)
                if (red) acciones.appendChild(_botonPermitir(`Su red (${red})`, red))
                div.appendChild(acciones)
            }

            atajoRechazadasLista.appendChild(div)
        }
    }

    function _botonPermitir(texto, cidr) {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = "ajustesTlsAvisoBtn"
        btn.textContent = texto
        btn.addEventListener("click", () => _permitirRedAtajo(cidr, btn))
        return btn
    }

    function _cidrDeIp(ip) {
        return ip.includes(":") ? `${ip}/128` : `${ip}/32`
    }

    // La /24 de una IPv4: es lo que reparte cualquier router doméstico. Para
    // IPv6 no se ofrece —la máscara depende del prefijo que dé el operador—.
    function _redDeIp(ip) {
        const partes = ip.split(".")
        if (partes.length !== 4 || partes.some((p) => !/^\d{1,3}$/.test(p))) return null
        return `${partes[0]}.${partes[1]}.${partes[2]}.0/24`
    }

    // Permitir es guardar: un toque y el móvil entra. Se parte de los rangos
    // que se están aplicando —los guardados aquí o, si no hay, los de
    // config.ini— porque lo que se guarda los sustituye: si no, permitir una
    // IP nueva quitaría la wifi entera sin avisar. La firma se deja como esté.
    async function _permitirRedAtajo(cidr, btn) {
        const data = _atajoUltimo || {}
        const base = [...(data.redes || [])]
        if (!base.includes(cidr)) base.push(cidr)
        const exigirFirma = !(data.acceso && data.acceso.exigirFirma === false)

        if (btn) btn.disabled = true
        showMsg(atajoMsg, `Permitiendo ${cidr}…`, "")
        try {
            const res = await fetch("/api/atajo/acceso", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ exigirFirma, redes: base })
            })
            const nuevo = await res.json()
            if (!nuevo.ok) {
                showMsg(atajoMsg, nuevo.error || "No se ha podido guardar", "error")
                return
            }
            _pintarAtajo(nuevo)
            showMsg(atajoMsg, `${cidr} permitida`, "ok")
        } catch {
            showMsg(atajoMsg, "Error de red", "error")
        } finally {
            if (btn) btn.disabled = false
        }
    }

    function _haceCuanto(iso) {
        const t = Date.parse(iso || "")
        if (Number.isNaN(t)) return "—"
        const seg = Math.max(0, Math.round((Date.now() - t) / 1000))
        if (seg < 60) return "hace un momento"
        if (seg < 3600) return `hace ${Math.round(seg / 60)} min`
        if (seg < 86400) return `hace ${Math.round(seg / 3600)} h`
        return `hace ${Math.round(seg / 86400)} d`
    }

    async function _guardarAccesoAtajo() {
        const redes = [..._redesAjustes]
        const exigirFirma = !!atajoExigirFirmaEl?.checked

        // Se pregunta solo al quitarla, y se dice lo que se pierde en concreto,
        // no un «¿seguro?»: lo que hay que poder valorar es el alcance.
        if (!exigirFirma) {
            const rangos = redes.join(", ") || _redesConfig.join(", ") || "los rangos de config.ini"
            const aviso =
                "Vas a aceptar peticiones sin comprobar quién las manda.\n\n" +
                `Cualquiera que alcance este puerto desde ${rangos} podrá apuntar movimientos en tu base de datos.\n\n` +
                "¿Continuar?"
            if (!window.confirm(aviso)) return
        }

        if (atajoAccesoBtn) atajoAccesoBtn.disabled = true
        showMsg(atajoAccesoMsg, "Guardando…", "")

        try {
            const res = await fetch("/api/atajo/acceso", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ exigirFirma, redes })
            })
            const data = await res.json()
            if (!data.ok) {
                showMsg(atajoAccesoMsg, data.error || "No se ha podido guardar", "error")
                return
            }
            _pintarAtajo(data)
            showMsg(atajoAccesoMsg, exigirFirma ? "Guardado" : "Guardado, sin firma", exigirFirma ? "ok" : "error")
        } catch {
            showMsg(atajoAccesoMsg, "Error de red", "error")
        } finally {
            if (atajoAccesoBtn) atajoAccesoBtn.disabled = false
        }
    }

    function _pintarRecetaAtajo(url) {
        if (!atajoRecetaEl) return

        // Las mismas acciones que lleva el fichero, por si iOS lo rechaza. Salen
        // de docs/atajo-ios.md, que es donde está el porqué de cada una.
        const conToken = "cabecera X-Atajo-Token = <em>token</em>"
        const pasos = [
            ["Obtener contenido de la URL", `${url}/api/portfolios-lista`, `GET · ${conToken}`],
            ["Obtener valor del diccionario", "clave <code>nombres</code>", ""],
            ["Elegir de la lista", "→ Establecer variable <code>bbdd</code>", ""],
            [
                "Texto",
                "<code>gasto</code> e <code>ingreso</code> en dos líneas → Dividir texto → Elegir de la lista → variable <code>tipo</code>",
                ""
            ],
            [
                "Obtener contenido de la URL",
                `${url}/api/categorias?portfolio=<em>bbdd</em>&amp;tipo=<em>tipo</em>`,
                `GET · ${conToken}`
            ],
            [
                "Obtener valor del diccionario",
                "clave <code>lista</code> → Elegir de la lista → variable <code>categoria</code>",
                ""
            ],
            [
                "Pedir entrada",
                "Texto «¿Concepto?» → variable <code>nombre</code>, y Número «¿Importe?» → variable <code>importe</code>",
                ""
            ],
            [
                "Obtener contenido de la URL",
                `${url}/api/preparar`,
                `POST · ${conToken} · cuerpo JSON con tipo, categoria, nombre, importe y portfolio`
            ],
            [
                "Obtener valor del diccionario",
                "claves <code>cuerpo</code>, <code>firma</code> y <code>timestamp</code> → variables <code>envio</code>, <code>sello</code> y <code>marca</code>",
                ""
            ],
            [
                "Obtener contenido de la URL",
                `${url}/api/movimiento`,
                "POST · cabeceras X-Signature, X-Timestamp y X-Atajo-Token · cuerpo <strong>Archivo</strong> = envio"
            ]
        ]

        const filas = pasos
            .map(
                ([accion, detalle, extra]) =>
                    `<li><strong>${accion}</strong> — ${detalle}${extra ? ` <span class="ajustesAtajoExtra">${extra}</span>` : ""}</li>`
            )
            .join("")

        atajoRecetaEl.innerHTML =
            "<p>La fecha no se pregunta: la pone el servidor con el día en que llega la petición.</p>" +
            `<ol class="ajustesAtajoPasos">${filas}</ol>` +
            "<p>El cuerpo del último paso va como <strong>Archivo</strong>, no como JSON: con JSON, Atajos vuelve a serializar el texto, cambian los bytes y la firma falla con un 401 que parece un problema de clave sin serlo.</p>" +
            "<p><strong>Token</strong> (trátalo como una contraseña; cambia al regenerar la clave): " +
            '<code id="ajustesAtajoTokenValor">oculto</code> ' +
            '<button id="ajustesAtajoTokenBtn" class="ajustesTlsAvisoBtn" type="button">Mostrar</button></p>'

        document.getElementById("ajustesAtajoTokenBtn")?.addEventListener("click", _mostrarTokenAtajo)
    }

    async function _mostrarTokenAtajo() {
        const destino = document.getElementById("ajustesAtajoTokenValor")
        if (!destino) return
        try {
            const res = await fetch("/api/atajo/token", { method: "POST" })
            const data = await res.json()
            // textContent: es un valor del servidor y no tiene por qué ser HTML.
            destino.textContent = data.ok ? data.token : data.error || "No disponible"
        } catch {
            destino.textContent = "Error de red"
        }
    }

    async function loadAtajo() {
        if (!atajoEstadoEl) return
        try {
            const res = await fetch("/api/atajo")
            const data = await res.json()
            if (data.ok) _pintarAtajo(data)
        } catch {
            atajoEstadoEl.className = "ajustesAtajoEstado roto"
            atajoEstadoEl.innerHTML =
                '<span class="ajustesTlsPunto"></span><span class="ajustesTlsEstadoTexto">No se ha podido consultar el estado.</span>'
        }
    }

    async function _generarClaveAtajo() {
        // Solo se pregunta al sustituir una que ya funciona, y se dice lo que
        // implica: el token del atajo instalado sale de esta clave, así que
        // regenerarla lo revoca (que es justo lo que se quiere si se perdió el iPhone).
        const aviso =
            "Vas a sustituir la clave de firma actual.\n\nEl atajo que tengas instalado dejará de funcionar: lleva un token derivado de esta clave. Después tendrás que volver a descargarlo."
        if (_atajoHayClave && !window.confirm(aviso)) return

        if (atajoClaveBtn) atajoClaveBtn.disabled = true
        showMsg(atajoMsg, "Generando…", "")

        try {
            const res = await fetch("/api/atajo/clave", { method: "POST" })
            const data = await res.json()
            if (!data.ok) {
                showMsg(atajoMsg, data.error || "No se ha podido generar", "error")
                return
            }
            _pintarAtajo(data)
            showMsg(atajoMsg, `Clave escrita en ${data.fichero}`, "ok")
        } catch {
            showMsg(atajoMsg, "Error de red", "error")
        } finally {
            if (atajoClaveBtn) atajoClaveBtn.disabled = false
        }
    }

    function _filaPasoAtajo(paso) {
        const fila = document.createElement("div")
        fila.className = "ajustesTlsPruebaFila " + (paso.ok ? "ok" : "mal")

        const nombre = document.createElement("span")
        nombre.className = "ajustesTlsPruebaNombre"
        nombre.textContent = paso.paso
        fila.appendChild(nombre)

        const detalle = document.createElement("span")
        detalle.className = "ajustesTlsPruebaDetalle"
        // textContent: el detalle puede traer rutas y mensajes del servidor.
        detalle.textContent = paso.detalle || ""
        fila.appendChild(detalle)

        return fila
    }

    async function _probarAtajo() {
        if (atajoProbarBtn) atajoProbarBtn.disabled = true
        showMsg(atajoMsg, "Comprobando…", "")

        try {
            const res = await fetch("/api/atajo/prueba", { method: "POST" })
            const data = await res.json()

            if (atajoPruebaRes) {
                atajoPruebaRes.hidden = false
                atajoPruebaRes.textContent = ""
                ;(data.pasos || []).forEach((paso) => atajoPruebaRes.appendChild(_filaPasoAtajo(paso)))
            }

            _pasoAtajo("ajustesAtajoPasoProbar", data.ok ? "ok" : "mal")
            _setTexto(
                atajoPasoProbarDetalle,
                data.ok
                    ? "Todo en orden: el servidor firma y verifica como lo hará con el atajo."
                    : "Hay algo sin configurar. Cada fila de abajo dice qué."
            )

            showMsg(atajoMsg, data.ok ? "Todo listo" : "Hay algo sin configurar", data.ok ? "ok" : "error")
        } catch {
            showMsg(atajoMsg, "Error de red", "error")
        } finally {
            if (atajoProbarBtn) atajoProbarBtn.disabled = false
        }
    }

    if (atajoClaveBtn) atajoClaveBtn.addEventListener("click", _generarClaveAtajo)
    if (atajoAccesoBtn) atajoAccesoBtn.addEventListener("click", _guardarAccesoAtajo)
    if (atajoRechazadasBtn) atajoRechazadasBtn.addEventListener("click", loadAtajo)
    if (atajoRedesBtn) atajoRedesBtn.addEventListener("click", _abrirModalRedes)
    if (atajoRedesAnadirBtn) atajoRedesAnadirBtn.addEventListener("click", _abrirModalRedes)
    if (atajoCopiarBtn) {
        atajoCopiarBtn.addEventListener("click", async () => {
            const url = atajoUrlEl?.textContent || ""
            try {
                await navigator.clipboard.writeText(url)
                showMsg(atajoMsg, "Dirección copiada", "ok")
            } catch {
                showMsg(atajoMsg, "No se ha podido copiar; selecciónala a mano", "error")
            }
        })
    }
    if (atajoExigirFirmaEl) {
        atajoExigirFirmaEl.addEventListener("change", () => {
            if (atajoAvisoFirmaEl) atajoAvisoFirmaEl.hidden = atajoExigirFirmaEl.checked
        })
    }
    if (atajoProbarBtn) atajoProbarBtn.addEventListener("click", _probarAtajo)
    loadAtajo()

    // Enciende y apaga el TLS del proxy que hay delante, en dos pulsaciones que
    // no se pueden juntar. La segunda —activar— configura el proxy, guarda el
    // estado y cambia la política de las cookies, y después el navegador tiene
    // que saltar a https:// porque el puerto es el mismo y a partir de ese
    // momento ya no habla claro. Por eso la primera existe: emitir el
    // certificado sin tocar el esquema, para que dé tiempo a instalarlo en cada
    // aparato mientras esta misma página sigue siendo alcanzable.
    const tlsEstadoEl = document.getElementById("ajustesTlsEstado")
    const tlsNombresEl = document.getElementById("ajustesTlsNombres")
    const tlsAvisoNombreEl = document.getElementById("ajustesTlsAvisoNombre")
    const tlsPrepararBtn = document.getElementById("ajustesTlsPrepararBtn")
    const tlsActivarBtn = document.getElementById("ajustesTlsActivarBtn")
    const tlsDesactivarBtn = document.getElementById("ajustesTlsDesactivarBtn")
    const tlsCaEl = document.getElementById("ajustesTlsCa")
    const tlsPaso2El = document.getElementById("ajustesTlsPaso2")
    const tlsConfirmaEl = document.getElementById("ajustesTlsConfirma")
    const tlsActivarMsg = document.getElementById("ajustesTlsActivarMsg")
    const tlsMsg = document.getElementById("ajustesTlsMsg")
    const tlsGuiaEl = document.getElementById("ajustesTlsGuia")
    const tlsPruebaEl = document.getElementById("ajustesTlsPrueba")
    const tlsPruebaBtn = document.getElementById("ajustesTlsPruebaBtn")
    const tlsPruebaMsg = document.getElementById("ajustesTlsPruebaMsg")
    const tlsPruebaRes = document.getElementById("ajustesTlsPruebaRes")
    const tlsPruebaAparatoBtn = document.getElementById("ajustesTlsPruebaAparatoBtn")
    const tlsPruebaAparatoHint = document.getElementById("ajustesTlsPruebaAparatoHint")
    const tlsAparatoResEl = document.getElementById("ajustesTlsAparatoRes")
    const tlsConfianzaEl = document.getElementById("ajustesTlsConfianza")
    const tlsConfirmaFila = document.getElementById("ajustesTlsConfirmaFila")

    function _pintarTls(data) {
        if (!tlsEstadoEl) return

        let clase = "off"
        let texto = "<strong>Desactivado.</strong> La contraseña y la cookie de sesión viajan en claro."

        if (!data.proxyDisponible) {
            clase = "roto"
            texto =
                "<strong>El proxy no responde.</strong> Comprueba que el contenedor <code>caddy</code> está en marcha; sin él no se puede activar el HTTPS."
        } else if (data.gestionadoPorEntorno) {
            clase = "on"
            texto =
                "<strong>Activado por configuración del servidor</strong> (<code>HTTPS_ENABLED</code> en <code>.env</code>). Se cambia allí, no desde aquí."
        } else if (data.activado) {
            clase = "on"
            const lista = escapeHtml((data.nombres || []).join(", "))
            texto = `<strong>Activado</strong> para ${lista || "(sin nombres)"}.`
        } else if (data.caDisponible) {
            // A medias, y decirlo importa: quien vuelve a esta pantalla después
            // de instalar el certificado en el móvil tiene que ver que lo que
            // queda es encenderlo, no volver a emitirlo.
            texto =
                "<strong>Desactivado, con el certificado ya emitido.</strong> Instálalo en cada aparato y enciéndelo aquí abajo; hasta entonces, la contraseña y la cookie de sesión siguen viajando en claro."
        }

        tlsEstadoEl.className = "ajustesTlsEstado " + clase
        tlsEstadoEl.innerHTML =
            '<span class="ajustesTlsPunto"></span><span class="ajustesTlsEstadoTexto">' + texto + "</span>"

        // Sin proxy o con el HTTPS impuesto por .env no hay nada que pulsar:
        // un botón que solo puede devolver un error es peor que ninguno.
        const editable = data.proxyDisponible && !data.gestionadoPorEntorno
        if (tlsNombresEl) {
            tlsNombresEl.disabled = !editable
            // Solo se rellena si el usuario no ha escrito nada: al recargar tras
            // guardar, machacar lo que tenga a medias sería perder su trabajo.
            if (!tlsNombresEl.value.trim()) {
                // La sugerencia la calcula el servidor: incluye la IP del
                // servidor en la LAN, que desde el navegador no hay forma de
                // saber y es justo la que se olvida al emitir el certificado.
                const sugerencia = (data.nombres || []).length
                    ? data.nombres.join(", ")
                    : (data.nombresSugeridos || []).join(", ") || data.nombreActual || location.hostname || ""
                tlsNombresEl.value = sugerencia
            }
        }
        const cifrando = data.activado && data.proxyDisponible
        // Con la CA ya emitida, el paso que toca no es emitirla otra vez: es
        // instalarla y encender. La hay tras preparar y también si el HTTPS
        // estuvo puesto alguna vez, porque la raíz vive en el volumen de Caddy.
        const conCa = !!data.caDisponible
        if (tlsPrepararBtn) {
            tlsPrepararBtn.style.display = editable && !data.activado && !conCa ? "" : "none"
            tlsPrepararBtn.disabled = !editable
        }
        if (tlsDesactivarBtn) {
            tlsDesactivarBtn.style.display = editable && data.activado ? "" : "none"
        }
        // El bloque del certificado ya no espera a que haya HTTPS: aparecer solo
        // después era el problema —para descargarlo había que atravesar el aviso
        // que provocaba no tenerlo—, así que se enseña en cuanto existe algo que
        // descargar.
        if (tlsCaEl) {
            tlsCaEl.style.display = cifrando || conCa ? "" : "none"
        }
        // Y colgando de él, el segundo paso: encender. Solo mientras esté
        // apagado; con el HTTPS puesto, lo que se ofrece debajo es comprobarlo.
        if (tlsPaso2El) {
            tlsPaso2El.style.display = editable && !data.activado && conCa ? "" : "none"
        }
        _avisarSiTeDejasFuera()
        // La comprobación también se adelanta: sirve para el certificado ya
        // emitido, no solo para el HTTPS ya puesto. Era el orden equivocado
        // —comprobar después de apostarse la sesión es un diagnóstico, no una
        // comprobación—, y es lo que se viene a arreglar.
        if (tlsPruebaEl) {
            tlsPruebaEl.style.display = cifrando || conCa ? "" : "none"
        }
        _pintarPruebaAparato(data)
        // La guía explica cómo encenderlo: con el HTTPS ya puesto sobra, y lo
        // que hace falta entonces —instalar la CA, comprobar— sale justo debajo.
        if (tlsGuiaEl) {
            tlsGuiaEl.style.display = editable && !data.activado ? "" : "none"
        }
        // Un resultado de antes de apagar el HTTPS seguiría diciendo «todo
        // correcto» sobre una conexión que ya va en claro.
        if (tlsPruebaRes && !cifrando) tlsPruebaRes.hidden = true
    }

    async function loadTls() {
        if (!tlsEstadoEl) return
        try {
            const res = await fetch("/api/tls")
            const data = await res.json()
            if (data.ok) _pintarTls(data)
        } catch {
            tlsEstadoEl.className = "ajustesTlsEstado roto"
            tlsEstadoEl.innerHTML =
                '<span class="ajustesTlsPunto"></span><span class="ajustesTlsEstadoTexto">No se ha podido consultar el estado.</span>'
        }
    }

    function _nombresEscritos() {
        return (tlsNombresEl?.value || "")
            .split(/[\n,;]+/)
            .map((n) => n.trim())
            .filter(Boolean)
    }

    // Misma limpieza que hace el servidor, para que el aviso de aquí abajo no
    // salte por un `https://` o un `:5000` que el certificado no ve.
    function _nombreLimpio(bruto) {
        return String(bruto)
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, "")
            .split("/")[0]
            .split(":")[0]
            .replace(/\.$/, "")
    }

    // El fallo que se lleva por delante el acceso: emitir un certificado que no
    // cubre la dirección por la que estás entrando. Al saltar a https:// el
    // navegador corta, y esta pantalla —la única desde la que se arregla— queda
    // detrás del aviso. El servidor lo rechaza igualmente; esto lo dice antes,
    // que es cuando todavía es un renglón que falta y no un problema.
    function _avisarSiTeDejasFuera() {
        if (!tlsAvisoNombreEl) return

        const actual = _nombreLimpio(location.hostname)
        const escritos = _nombresEscritos().map(_nombreLimpio)
        // localhost y 127.0.0.1 los añade el servidor siempre, se escriban o no.
        const cubierto = !actual || actual === "localhost" || actual === "127.0.0.1" || escritos.includes(actual)

        tlsAvisoNombreEl.hidden = cubierto
        if (cubierto) return

        tlsAvisoNombreEl.textContent = ""
        const texto = document.createElement("span")
        texto.innerHTML =
            `Estás entrando por <code>${actual}</code> y no está en la lista. ` +
            "Tal y como está, al activar el HTTPS tu propio navegador rechazaría la conexión."
        tlsAvisoNombreEl.appendChild(texto)

        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = "ajustesTlsAvisoBtn"
        btn.textContent = `Añadir ${actual}`
        btn.addEventListener("click", () => {
            const lista = _nombresEscritos()
            lista.push(actual)
            if (tlsNombresEl) tlsNombresEl.value = lista.join(", ")
            _avisarSiTeDejasFuera()
        })
        tlsAvisoNombreEl.appendChild(btn)
    }

    // --- Paso 1: emitir el certificado ---
    // No enciende nada. El proxy sigue sirviendo en claro por el mismo puerto y
    // esta página sigue donde estaba; lo único que cambia es que a partir de
    // aquí ya hay una CA que descargar e instalar. Que sea un paso aparte es el
    // arreglo: emitir e instalar tienen que caber antes de que el navegador
    // empiece a exigir un certificado que todavía no conoce.
    async function _prepararTls() {
        const nombres = _nombresEscritos()
        if (!nombres.length) {
            showMsg(tlsMsg, "Escribe al menos un nombre o IP", "error")
            return
        }

        if (tlsPrepararBtn) tlsPrepararBtn.disabled = true
        showMsg(tlsMsg, "Emitiendo el certificado…", "")

        try {
            const res = await fetch("/api/tls/preparar", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ nombres })
            })
            const data = await res.json()
            if (!data.ok) {
                showMsg(tlsMsg, data.error || "No se ha podido emitir", "error")
                return
            }
            _pintarTls(data)
            showMsg(tlsMsg, "Certificado emitido. Descárgalo e instálalo.", "ok")
            // Lo que hay que hacer ahora está más abajo y el panel es largo: sin
            // esto, la respuesta al botón es un cambio fuera de la pantalla.
            tlsCaEl?.scrollIntoView({ behavior: "smooth", block: "nearest" })
        } catch {
            // Aquí un error de red es un error de red y nada más: a diferencia
            // de activar, esta petición no toca el esquema por el que ha venido.
            showMsg(tlsMsg, "Error de red", "error")
        } finally {
            if (tlsPrepararBtn) tlsPrepararBtn.disabled = false
        }
    }

    // Tras activar, la página actual está en http:// y el servidor ya solo
    // atiende TLS en ese mismo puerto: cualquier petición siguiente fallaría sin
    // explicar por qué. Se avisa y se salta sola, dando margen para leerlo.
    function _saltarAHttps(nombres) {
        // Se mantiene el host por el que ha entrado si está entre los nombres
        // del certificado; si no, se usa el primero, que sí lo está. Saltar a un
        // nombre que no cubre el certificado daría un aviso evitable.
        const actual = location.hostname
        const destino = nombres.includes(actual) ? actual : nombres[0]
        const url = `https://${destino}${location.port ? ":" + location.port : ""}${location.pathname}`

        const aviso = document.createElement("div")
        aviso.className = "ajustesTlsSaltando"
        aviso.innerHTML =
            `<strong>HTTPS activado.</strong> Esta página se va a recargar en <code>${url}</code>. ` +
            "Si algún aparato avisa del certificado, es que ahí falta por instalar: el enlace para descargarlo sigue en este mismo panel."
        tlsPaso2El?.appendChild(aviso)

        setTimeout(() => {
            location.replace(url)
        }, 6000)
    }

    // --- Paso 2: encender ---
    async function _guardarTls(activado) {
        const nombres = _nombresEscritos()
        const msg = activado ? tlsActivarMsg : tlsMsg

        if (activado && !nombres.length) {
            showMsg(msg, "Escribe al menos un nombre o IP", "error")
            return
        }

        if (tlsActivarBtn) tlsActivarBtn.disabled = true
        if (tlsDesactivarBtn) tlsDesactivarBtn.disabled = true
        showMsg(msg, activado ? "Activando…" : "Desactivando…", "")

        try {
            const res = await fetch("/api/tls", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ activado, nombres })
            })
            const data = await res.json()
            if (!data.ok) {
                showMsg(msg, data.error || "No se ha podido aplicar", "error")
                return
            }
            _pintarTls(data)
            showMsg(msg, activado ? "HTTPS activado" : "HTTPS desactivado", "ok")
            if (activado) _saltarAHttps(data.nombres)
        } catch {
            // Al activar, el proxy recarga su configuración mientras esta misma
            // petición está en vuelo: es posible que haya funcionado y que la
            // respuesta no llegue, porque el puerto ya solo habla TLS. Decir
            // «error de red» sería mentir la mitad de las veces, así que se
            // salta igualmente y que lo confirme el propio navegador.
            if (activado) {
                showMsg(msg, "Aplicado; comprobando por https…", "")
                _saltarAHttps(nombres)
            } else {
                showMsg(msg, "Error de red", "error")
            }
        } finally {
            _permitirActivar()
            if (tlsDesactivarBtn) tlsDesactivarBtn.disabled = false
        }
    }

    // --- Comprobar el certificado ---
    // El estado de arriba solo repite lo que se pidió. Esto abre una conexión de
    // verdad contra el proxy por cada nombre declarado y valida el certificado
    // contra la CA que el usuario se descarga aquí mismo, que es la diferencia
    // entre «quedó guardado el interruptor» y «el navegador va a dejar de avisar».

    // --- Probar en este aparato ---
    // La única pregunta que el servidor no puede contestar: ¿se fía ESTE
    // navegador del certificado? Nadie más que él lo sabe. Se le da una página
    // servida con el mismo certificado en el puerto de comprobación: si carga,
    // la CA está bien instalada aquí; si avisa, avisaría igual con el HTTPS
    // puesto —y se ha averiguado sin ponerlo—.
    // --- Comprobar en este aparato ---
    // La única pregunta que el servidor no puede contestar: ¿se fía ESTE
    // navegador del certificado? Antes se resolvía abriendo una pestaña y
    // mirando, o sea pidiéndole al usuario que interpretara un aviso. Ahora la
    // hace el propio panel: si el fetch a la página de comprobación resuelve,
    // el navegador ha validado el certificado; si no se fía, el fetch falla.
    // No queda nada que creerse.
    //
    // El puerto de comprobación no sobrevive a un reinicio —al arrancar se
    // reaplica el estado guardado, y con el HTTPS apagado ahí no hay TLS—, así
    // que primero se le pide al servidor que lo levante. Sin eso, «conexión
    // rechazada» se confundiría con «no me fío», que manda a arreglar lo que no
    // está roto.
    let _aparatoDeConfianza = false

    async function _asegurarPuertoDePrueba() {
        try {
            const res = await fetch("/api/tls/comprobacion", { method: "POST" })
            const data = await res.json()
            return { ok: !!data.listo, error: data.error }
        } catch {
            return { ok: false, error: "No se ha podido hablar con el servidor" }
        }
    }

    function _urlDeComprobacion(puerto) {
        return puerto ? `https://${location.hostname}:${puerto}/` : ""
    }

    function _pintarAparato(estado, detalle, url) {
        if (!tlsAparatoResEl) return
        tlsAparatoResEl.hidden = false
        tlsAparatoResEl.className = "ajustesTlsAparatoRes " + estado
        tlsAparatoResEl.innerHTML = detalle
        if (estado === "mal" && url) {
            // El fetch no distingue «no me fío» de «no llego»: los dos fallan
            // igual. El navegador sí lo dice, con todas sus letras, si se abre
            // la página a mano; así que se ofrece.
            const enlace = document.createElement("a")
            enlace.className = "ajustesTlsAparatoEnlace"
            enlace.href = url
            enlace.target = "_blank"
            enlace.rel = "noopener"
            enlace.textContent = "Abrirla en otra pestaña para ver el motivo"
            tlsAparatoResEl.appendChild(document.createElement("br"))
            tlsAparatoResEl.appendChild(enlace)
        }
    }

    function _permitirActivar() {
        if (!tlsActivarBtn) return
        tlsActivarBtn.disabled = !(_aparatoDeConfianza || tlsConfirmaEl?.checked)

        // Comprobado de verdad, la casilla sobra: era el sustituto de esto.
        if (tlsConfirmaFila) tlsConfirmaFila.hidden = _aparatoDeConfianza
        if (tlsConfianzaEl) {
            tlsConfianzaEl.hidden = !_aparatoDeConfianza
            tlsConfianzaEl.innerHTML = _aparatoDeConfianza
                ? "<strong>Este aparato se fía del certificado.</strong> Si entras también desde el móvil o desde otro equipo, instálalo allí antes de encender: aquí solo se ha comprobado este."
                : ""
        }
    }

    async function _comprobarEnEsteAparato() {
        if (!tlsPruebaAparatoBtn) return
        const url = _urlDeComprobacion(tlsPruebaAparatoBtn.dataset.puerto)
        if (!url) return

        tlsPruebaAparatoBtn.disabled = true
        showMsg(tlsPruebaMsg, "Comprobando en este aparato…", "")

        try {
            const puerto = await _asegurarPuertoDePrueba()
            if (!puerto.ok) {
                showMsg(tlsPruebaMsg, "Sin comprobar", "error")
                _pintarAparato("mal", puerto.error || "No se ha podido levantar el puerto de comprobación", "")
                return
            }

            try {
                // cache: no-store para que no conteste un resultado viejo: lo
                // que se mide es el apretón de manos de ahora mismo.
                await fetch(url, { cache: "no-store" })
                _aparatoDeConfianza = true
                showMsg(tlsPruebaMsg, "Este aparato se fía", "ok")
                _pintarAparato(
                    "ok",
                    "<strong>El certificado funciona en este aparato.</strong> El navegador lo ha validado sin un solo aviso: " +
                        "con el HTTPS puesto entrarás igual que ahora.",
                    url
                )
            } catch {
                _aparatoDeConfianza = false
                showMsg(tlsPruebaMsg, "Este aparato no lo acepta", "error")
                _pintarAparato(
                    "mal",
                    "<strong>Este aparato no acepta el certificado.</strong> O no está instalado aquí —en Windows tiene que " +
                        "quedar en «Entidades de certificación raíz de confianza», no en «Personal»—, o no se llega al puerto " +
                        "de comprobación. Si activas el HTTPS ahora, este navegador te sacaría el aviso.",
                    url
                )
            }
        } finally {
            tlsPruebaAparatoBtn.disabled = false
            _permitirActivar()
        }
    }

    function _pintarPruebaAparato(data) {
        const puerto = data.puertoPrueba
        const hayCertificado = !!data.caDisponible || !!data.activado
        const url = puerto && hayCertificado ? _urlDeComprobacion(puerto) : ""

        if (tlsPruebaAparatoBtn) {
            tlsPruebaAparatoBtn.dataset.puerto = url ? puerto : ""
            tlsPruebaAparatoBtn.style.display = url ? "" : "none"
        }
        if (tlsPruebaAparatoHint) {
            tlsPruebaAparatoHint.innerHTML = url
                ? `Pide <code>${url}</code> desde este mismo navegador: una página servida con el mismo certificado ` +
                  "que servirá el HTTPS. Es la comprobación que el servidor no puede hacer por ti, y hay que repetirla " +
                  "en cada aparato desde el que entres."
                : ""
        }
        // Un «se fía» de antes de tocar los nombres ya no vale para nada.
        if (!url) {
            _aparatoDeConfianza = false
            if (tlsAparatoResEl) tlsAparatoResEl.hidden = true
        }
        _permitirActivar()
    }

    function _filaPrueba(r) {
        const fila = document.createElement("div")
        fila.className = "ajustesTlsPruebaFila " + (r.ok ? "ok" : "mal")

        const nombre = document.createElement("span")
        nombre.className = "ajustesTlsPruebaNombre"
        // textContent y no innerHTML: estos nombres los escribe el usuario.
        nombre.textContent = r.nombre
        fila.appendChild(nombre)

        const detalle = document.createElement("span")
        detalle.className = "ajustesTlsPruebaDetalle"
        if (!r.ok) {
            detalle.textContent = r.error || "No se ha podido comprobar"
        } else if (r.dias === null || r.dias === undefined) {
            detalle.textContent = "Certificado válido"
        } else {
            detalle.textContent = `Certificado válido, caduca en ${r.dias} días (${r.caduca})`
        }
        fila.appendChild(detalle)

        return fila
    }

    function _pintarPrueba(data) {
        if (!tlsPruebaRes) return
        tlsPruebaRes.hidden = false
        tlsPruebaRes.textContent = ""

        if (data.error) {
            tlsPruebaRes.className = "ajustesTlsPruebaRes roto"
            tlsPruebaRes.textContent = data.error
            return
        }

        tlsPruebaRes.className = "ajustesTlsPruebaRes"

        // Qué se ha comprobado exactamente. Sin esto, un «todo correcto» antes
        // de activar se lee como «ya está cifrado», que es justo lo que no es.
        if (data.modo === "previo") {
            const pie = document.createElement("div")
            pie.className = "ajustesTlsPruebaDetalle"
            pie.textContent = `Comprobado en el puerto ${data.puerto}, sobre el certificado que servirá el HTTPS. Todavía no está activado.`
            tlsPruebaRes.appendChild(pie)
        }
        ;(data.nombres || []).forEach((r) => tlsPruebaRes.appendChild(_filaPrueba(r)))
    }

    async function _probarTls() {
        if (!tlsPruebaBtn) return
        tlsPruebaBtn.disabled = true
        showMsg(tlsPruebaMsg, "Comprobando…", "")

        try {
            const res = await fetch("/api/tls/prueba")
            const data = await res.json()
            if (!data.ok) {
                showMsg(tlsPruebaMsg, data.error || "No se ha podido comprobar", "error")
                return
            }

            _pintarPrueba(data)

            const fallan = (data.nombres || []).filter((r) => !r.ok).length
            if (data.error) {
                showMsg(tlsPruebaMsg, "Sin comprobar", "error")
            } else if (fallan) {
                // En plural o en singular, pero siempre con el número: es lo que
                // dice cuántos aparatos van a seguir viendo el aviso.
                showMsg(tlsPruebaMsg, fallan === 1 ? "1 nombre sin cubrir" : `${fallan} nombres sin cubrir`, "error")
            } else if (data.modo === "previo") {
                // Aquí «correcto» solo cubre la mitad del problema: el
                // certificado está bien, pero que un aparato se fíe de él lo
                // dice el propio aparato, con el botón de al lado.
                showMsg(tlsPruebaMsg, "El certificado está bien emitido", "ok")
            } else {
                showMsg(tlsPruebaMsg, "Todo correcto", "ok")
            }
        } catch {
            showMsg(tlsPruebaMsg, "Error de red", "error")
        } finally {
            tlsPruebaBtn.disabled = false
        }
    }

    if (tlsNombresEl) tlsNombresEl.addEventListener("input", _avisarSiTeDejasFuera)
    if (tlsPruebaBtn) tlsPruebaBtn.addEventListener("click", _probarTls)
    if (tlsPruebaAparatoBtn) tlsPruebaAparatoBtn.addEventListener("click", _comprobarEnEsteAparato)
    if (tlsPrepararBtn) tlsPrepararBtn.addEventListener("click", _prepararTls)
    if (tlsActivarBtn) tlsActivarBtn.addEventListener("click", () => _guardarTls(true))
    if (tlsDesactivarBtn) tlsDesactivarBtn.addEventListener("click", () => _guardarTls(false))
    // El botón de activar no se habilita hasta que se marca que el certificado
    // ya está instalado. Es la única pulsación de este panel que puede dejar a
    // alguien fuera, y basta una casilla para que no se dé por accidente.
    if (tlsConfirmaEl) {
        tlsConfirmaEl.addEventListener("change", _permitirActivar)
    }
    loadTls()
}

// Cambio de usuario y contraseña.
function _initAjustesCredenciales() {
    // --- Cambiar nombre de usuario ---
    const credUserCurrentPwd = document.getElementById("ajustesCredUserCurrentPwd")
    const credNewUser = document.getElementById("ajustesCredNewUser")
    const guardarCredUserBtn = document.getElementById("ajustesGuardarCredUserBtn")
    const credUserMsg = document.getElementById("ajustesCredUserMsg")

    if (guardarCredUserBtn) {
        guardarCredUserBtn.addEventListener("click", async () => {
            const currentPassword = credUserCurrentPwd?.value || ""
            const newUsername = credNewUser?.value.trim() || ""

            if (!currentPassword) {
                showMsg(credUserMsg, "Introduce la contraseña actual", "error")
                return
            }
            if (!newUsername) {
                showMsg(credUserMsg, "El usuario no puede estar vacío", "error")
                return
            }

            guardarCredUserBtn.disabled = true
            showMsg(credUserMsg, "Guardando…", "")
            try {
                const res = await fetch("/api/settings/credentials/username", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ currentPassword, newUsername })
                })
                const data = await res.json()
                if (data.ok) {
                    showMsg(credUserMsg, "Usuario actualizado", "ok")
                    if (credUserCurrentPwd) credUserCurrentPwd.value = ""
                    if (credNewUser) credNewUser.value = ""
                } else {
                    showMsg(credUserMsg, data.error || "Error al guardar", "error")
                }
            } catch {
                showMsg(credUserMsg, "Error de red", "error")
            } finally {
                guardarCredUserBtn.disabled = false
            }
        })
    }

    // --- Cambiar contraseña ---
    const credPwdCurrentPwd = document.getElementById("ajustesCredPwdCurrentPwd")
    const credNewPwd = document.getElementById("ajustesCredNewPwd")
    const credNewPwd2 = document.getElementById("ajustesCredNewPwd2")
    const guardarCredPwdBtn = document.getElementById("ajustesGuardarCredPwdBtn")
    const credPwdMsg = document.getElementById("ajustesCredPwdMsg")

    if (guardarCredPwdBtn) {
        guardarCredPwdBtn.addEventListener("click", async () => {
            const currentPassword = credPwdCurrentPwd?.value || ""
            const newPassword = credNewPwd?.value || ""
            const newPassword2 = credNewPwd2?.value || ""

            if (!currentPassword) {
                showMsg(credPwdMsg, "Introduce la contraseña actual", "error")
                return
            }
            if (!newPassword) {
                showMsg(credPwdMsg, "La nueva contraseña no puede estar vacía", "error")
                return
            }
            if (newPassword !== newPassword2) {
                showMsg(credPwdMsg, "Las contraseñas no coinciden", "error")
                return
            }

            guardarCredPwdBtn.disabled = true
            showMsg(credPwdMsg, "Guardando…", "")
            try {
                const res = await fetch("/api/settings/credentials/password", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ currentPassword, newPassword })
                })
                const data = await res.json()
                if (data.ok) {
                    showMsg(credPwdMsg, "Contraseña actualizada", "ok")
                    if (credPwdCurrentPwd) credPwdCurrentPwd.value = ""
                    if (credNewPwd) credNewPwd.value = ""
                    if (credNewPwd2) credNewPwd2.value = ""
                } else {
                    showMsg(credPwdMsg, data.error || "Error al guardar", "error")
                }
            } catch {
                showMsg(credPwdMsg, "Error de red", "error")
            } finally {
                guardarCredPwdBtn.disabled = false
            }
        })
    }
}
