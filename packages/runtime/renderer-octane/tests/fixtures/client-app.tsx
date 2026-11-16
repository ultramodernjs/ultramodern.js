import { createElement, useLayoutEffect, useState } from 'octane';

export function ClientApplication({
  label,
  onCleanup,
  shouldFail,
  onRender,
}: {
  label: string;
  onCleanup?: () => void;
  shouldFail?: boolean;
  onRender?: () => void;
}) {
  onRender?.();
  if (shouldFail) throw new Error('Native scheduled render failed');
  const [count, setCount] = useState(0);
  useLayoutEffect(() => () => onCleanup?.(), []);
  return (
    <section data-fixture="native-client">
      <p>{label}</p>
      <button onClick={() => setCount(count + 1)}>{`Count: ${count}`}</button>
    </section>
  );
}

// The lifecycle fixtures server-render this same runtime element through
// octane/server, so the client hydrates the exact server shape.
export function HydrationApplication() {
  return createElement('section', {
    'data-fixture': 'native-hydration',
    children: 'Native hydration',
  });
}

export function ThrowingApplication() {
  throw new Error('Native component failed');
}
