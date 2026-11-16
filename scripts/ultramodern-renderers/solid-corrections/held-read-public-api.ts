import { heldRead as signalsHeldRead } from '@solidjs/signals';
import { render, renderToStream, heldRead as webHeldRead } from '@solidjs/web';
import { createMemo, createRoot, createSignal, heldRead } from 'solid-js';

const fromSignals: typeof signalsHeldRead = heldRead;
const fromWeb: typeof heldRead = webHeldRead;
const readCount: () => number = fromWeb;
createRoot(dispose => {
  const [value] = createSignal(1);
  const memo = createMemo(() => value() + fromSignals());
  const numeric: number = memo() + readCount();
  dispose();
  return numeric;
});
void render;
void renderToStream;
// @ts-expect-error The native compiler flag reader takes no arguments.
heldRead(1);
// @ts-expect-error Its public return type is numeric, not boolean.
const wrong: boolean = heldRead();
void wrong;
