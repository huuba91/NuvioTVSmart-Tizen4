/* global __NUVIO_DEV_DIAGNOSTICS__ */
import { installConsoleDebugBuffer } from "./consoleDebugBuffer.js";

// Developer-diagnostics builds (NUVIO_DEV_DIAGNOSTICS=1) capture console
// warnings and errors for Settings > About > Console debug. Production builds
// define __NUVIO_DEV_DIAGNOSTICS__ as false, so esbuild drops this call and the
// capture buffer from the bundle.
if (typeof __NUVIO_DEV_DIAGNOSTICS__ !== "undefined" && __NUVIO_DEV_DIAGNOSTICS__) {
  installConsoleDebugBuffer();
}
