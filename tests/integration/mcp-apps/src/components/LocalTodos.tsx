import type { McpCapabilities } from '@modern-js/mcp-apps/react';
import type { ComponentProps } from 'react';
import { label } from './local-label';
import Todos from './Todos';

export default function LocalTodos(props: ComponentProps<typeof Todos>) {
  return (
    <>
      <p>{label}</p>
      <Todos {...props} />
    </>
  );
}

export const mcpCapabilities = {
  availableDisplayModes: ['inline'],
  experimental: { fixture: { source: 'local' } },
} satisfies McpCapabilities;
