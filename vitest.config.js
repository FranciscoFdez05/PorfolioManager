// Configuración de las pruebas del frontend.
//
// El frontend no se empaqueta: js/ se sirve tal cual con etiquetas <script>
// clásicas, así que los módulos no exportan nada y sus funciones viven en el
// ámbito global. `tests-js/cargar.js` reproduce esa carga dentro de jsdom, que
// es lo que permite probarlos sin reescribirlos a ESM.
import { defineConfig } from "vitest/config"

export default defineConfig({
    test: {
        // jsdom y no node: shared-utils.js usa window, document e Intl con el
        // locale del navegador, y api.js manipula window.location y fetch.
        environment: "jsdom",
        include: ["tests-js/**/*.test.js"],
        // Sin aislamiento por fichero el estado global de un módulo (los
        // window._* que usa la aplicación) se filtraría entre suites.
        isolate: true,
        coverage: {
            provider: "v8",
            include: ["js/core/**/*.js"],
            exclude: ["js/vendor/**"],
            reporter: ["text", "lcov"]
        }
    }
})
