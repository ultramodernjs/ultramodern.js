import { later } from '../../data/late';

export interface RedactLoaderData {
  slow: Promise<string>;
  fast: Promise<string>;
  row: Promise<string>;
  svg: Promise<string>;
}

// Request-owned promises keep every response genuinely streamed, even after
// the server's module cache is warm. The first child resolves after its sibling.
export function loader(): RedactLoaderData {
  return {
    slow: later('slow', 1200),
    fast: later('fast', 100),
    row: later('row', 250),
    svg: later('svg', 400),
  };
}
