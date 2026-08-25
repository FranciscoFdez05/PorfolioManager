// Utilidades de DOM compartidas.
//
// `escapeHtml` vivía dentro de js/assets.js y el resto de módulos dependía de
// que ese fichero se cargara antes: una dependencia implícita entre un módulo
// de negocio y todos los demás. Aquí queda donde corresponde, cargada antes que
// cualquier módulo.
;(function () {
    "use strict"

    var HTML_ESCAPES = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }

    // Obligatorio para cualquier dato del usuario que se interpole en una
    // plantilla con innerHTML (nombres de activos, categorías, notas…).
    function escapeHtml(value) {
        return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
            return HTML_ESCAPES[ch]
        })
    }

    // Atributo entre comillas dobles. Igual que escapeHtml pero deja claro en
    // el punto de uso que el destino es un atributo, no texto.
    function escapeAttr(value) {
        return escapeHtml(value)
    }

    function clearNode(node) {
        if (!node) return node
        while (node.firstChild) node.removeChild(node.firstChild)
        return node
    }

    /**
     * Crea un elemento sin pasar por innerHTML.
     *   el("td", { class: "mTdName" }, asset.name)
     * El texto va siempre por textContent, así que no hay forma de inyectar
     * marcado aunque el valor venga del usuario.
     */
    function el(tag, attrs, children) {
        var node = document.createElement(tag)

        Object.keys(attrs || {}).forEach(function (key) {
            var value = attrs[key]
            if (value == null || value === false) return
            if (key === "class" || key === "className") {
                node.className = String(value)
            } else if (key === "dataset") {
                Object.keys(value).forEach(function (dataKey) {
                    node.dataset[dataKey] = String(value[dataKey])
                })
            } else if (key === "style" && typeof value === "object") {
                Object.keys(value).forEach(function (prop) {
                    node.style.setProperty(prop, String(value[prop]))
                })
            } else if (key.slice(0, 2) === "on" && typeof value === "function") {
                node.addEventListener(key.slice(2).toLowerCase(), value)
            } else {
                node.setAttribute(key, String(value))
            }
        })

        appendChildren(node, children)
        return node
    }

    function appendChildren(node, children) {
        if (children == null || children === false) return
        if (Array.isArray(children)) {
            children.forEach(function (child) {
                appendChildren(node, child)
            })
            return
        }
        node.appendChild(children instanceof Node ? children : document.createTextNode(String(children)))
    }

    function setText(node, value) {
        if (node) node.textContent = value == null ? "" : String(value)
        return node
    }

    // ── Avisos no bloqueantes ────────────────────────────────────────────────
    // Muchos errores acababan solo en console.error: el guardado fallaba y el
    // usuario seguía trabajando creyendo que se había guardado.
    var TOAST_STYLES = [
        ".appToastHost{position:fixed;right:16px;bottom:16px;z-index:9999;",
        "display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:min(380px,90vw)}",
        ".appToast{pointer-events:auto;padding:10px 14px;border-radius:8px;font-size:14px;",
        "line-height:1.35;box-shadow:0 4px 16px rgba(0,0,0,.28);opacity:0;transform:translateY(8px);",
        "transition:opacity .18s ease,transform .18s ease;word-break:break-word;",
        "background:#2b2f36;color:#f2f4f7;border-left:4px solid #6b7280}",
        ".appToast.isVisible{opacity:1;transform:translateY(0)}",
        ".appToast.isError{border-left-color:#e5484d}",
        ".appToast.isSuccess{border-left-color:#2ecc71}",
        ".appToast.isWarning{border-left-color:#f5a524}"
    ].join("")

    var toastHost = null

    function ensureToastHost() {
        if (toastHost && document.body.contains(toastHost)) return toastHost
        var style = document.getElementById("appToastStyles")
        if (!style) {
            style = document.createElement("style")
            style.id = "appToastStyles"
            style.textContent = TOAST_STYLES
            document.head.appendChild(style)
        }
        toastHost = document.createElement("div")
        toastHost.className = "appToastHost"
        document.body.appendChild(toastHost)
        return toastHost
    }

    /**
     * showToast("No se pudo guardar", { type: "error" })
     * type: "error" | "success" | "warning" | "info" (por defecto)
     */
    function showToast(message, options) {
        options = options || {}
        if (!document.body) return null

        var host = ensureToastHost()
        var toast = document.createElement("div")
        toast.className = "appToast"
        if (options.type === "error") toast.classList.add("isError")
        else if (options.type === "success") toast.classList.add("isSuccess")
        else if (options.type === "warning") toast.classList.add("isWarning")
        // textContent, nunca innerHTML: el mensaje puede venir del servidor.
        toast.textContent = String(message == null ? "" : message)
        toast.setAttribute("role", options.type === "error" ? "alert" : "status")
        host.appendChild(toast)

        requestAnimationFrame(function () {
            toast.classList.add("isVisible")
        })

        var duration = options.duration != null ? options.duration : options.type === "error" ? 6000 : 3500
        setTimeout(function () {
            toast.classList.remove("isVisible")
            setTimeout(function () {
                if (toast.parentNode) toast.parentNode.removeChild(toast)
            }, 220)
        }, duration)

        return toast
    }

    /** Muestra un error de forma consistente y lo deja en consola para depurar. */
    function showError(message, error) {
        if (error) console.error(message, error)
        var detail = error && window.Api ? window.Api.describeError(error) : ""
        showToast(detail && detail !== message ? message + ": " + detail : message, { type: "error" })
    }

    window.escapeHtml = escapeHtml
    window.escapeAttr = escapeAttr
    window.clearNode = clearNode
    window.el = el
    window.setText = setText
    window.showToast = showToast
    window.showError = showError
})()
