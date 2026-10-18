// Imported by Node directly, outside the server test compiler's runtime alias.
// Public Node-conditioned client entries share one runtime and its hydration registries.
import * as runtime from 'octane';
import * as streamedSignals from 'octane/hydration/streamed-signals';
import * as internals from 'octane/internal/client';

const runtimeGlobal = globalThis;

export { internals, runtime, runtimeGlobal, streamedSignals };
