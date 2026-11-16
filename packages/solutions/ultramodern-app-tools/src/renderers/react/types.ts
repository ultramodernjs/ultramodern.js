import type { PluginSvgrOptions } from '@modern-js/app-tools-extensions/svgr';
import type { ReactNode } from 'react';

/** The selected React renderer's element contract for CLI route metadata. */
export type ReactCLIElement = ReactNode;

declare module '@modern-js/app-tools/cli-config' {
  interface CLIElementTypes {
    react: ReactCLIElement;
  }
}

declare module '@modern-js/builder/types' {
  interface BuilderSvgOptions {
    options: PluginSvgrOptions;
  }
}
