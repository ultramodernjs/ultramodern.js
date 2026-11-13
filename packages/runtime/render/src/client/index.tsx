import React, { createContext, useState } from 'react';
import {
  createFromFetch,
  createFromReadableStream,
  createServerReference,
  setServerCallback,
} from 'react-server-dom-rspack/client.browser';

export { rscStream } from '../rsc-html-stream/client';
export { callServer } from './callServer';
export {
  ElementsContext,
  RSCServerSlot,
  ServerElementsProvider,
} from './serverElements';
export { createFromFetch, createFromReadableStream, createServerReference };

declare global {
  interface Window {
    __MODERN_JS_ENTRY_NAME?: string;
  }
}

export const ResetRootContext = createContext<
  | {
      setRoot: (root: React.ReactNode) => void;
    }
  | undefined
>(undefined);

export { setServerCallback };

export function RscClientRoot({
  rscPayload,
}: {
  rscPayload: Promise<React.ReactNode>;
}) {
  const elements = React.use(rscPayload);
  const [root, setRoot] = useState<React.ReactNode>(elements);
  return (
    <ResetRootContext.Provider value={{ setRoot }}>
      {root}
    </ResetRootContext.Provider>
  );
}
