import { useMatch } from '@modern-js/plugin-tanstack/runtime';
import { Suspense, use, useEffect, useId, useState } from 'react';
import type { RedactLoaderData } from './page.data';

// Only a committed client effect can expose this component's useId value.
// Server DOM alone is not evidence that its Suspense boundary hydrated.
function useHydratedId(id: string) {
  const [clientId, setClientId] = useState<string>();
  useEffect(() => setClientId(id), [id]);
  return clientId;
}

function Field({ name }: { name: string }) {
  const id = useId();
  const clientId = useHydratedId(id);
  const [clicks, setClicks] = useState(0);
  return (
    <div>
      <label data-probe={`${name}-label`} htmlFor={id}>
        {name}
      </label>
      <input data-probe={name} id={id} data-client-id={clientId} />
      <button
        type="button"
        data-probe={`${name}-button`}
        onClick={() => setClicks(value => value + 1)}
      >
        {clicks}
      </button>
    </div>
  );
}

function DeferredField({
  value,
  name,
}: {
  value: Promise<string>;
  name?: string;
}) {
  const resolved = use(value);
  return <Field name={name ?? resolved} />;
}

function DeferredRow({ value }: { value: Promise<string> }) {
  const name = use(value);
  const id = useId();
  const clientId = useHydratedId(id);
  return (
    <tr data-probe={name} id={id} data-client-id={clientId}>
      <td>Streamed table row</td>
    </tr>
  );
}

function DeferredCircle({ value }: { value: Promise<string> }) {
  const name = use(value);
  const id = useId();
  const clientId = useHydratedId(id);
  return (
    <circle
      data-probe={name}
      id={id}
      data-client-id={clientId}
      cx="10"
      cy="10"
      r="5"
    />
  );
}

// Keep the observation local: updating the parent would change the children
// of every still-pending Suspense boundary before its server reveal.
function HydrationMarker() {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return <span data-testid="redact-hydration" data-hydrated={hydrated} />;
}

export default function RedactAcceptance() {
  const data = useMatch({ strict: false }).loaderData as RedactLoaderData;
  const [mounted, setMounted] = useState(false);
  return (
    <section data-testid="redact-probe">
      <HydrationMarker />
      <Field name="outside" />
      <Suspense fallback={<p data-pending="slow">Slow pending</p>}>
        <DeferredField value={data.slow} />
      </Suspense>
      <Suspense fallback={<p data-pending="fast">Fast pending</p>}>
        <DeferredField value={data.fast} />
      </Suspense>
      <table>
        <tbody>
          <Suspense
            fallback={
              <tr data-pending="row">
                <td>Row pending</td>
              </tr>
            }
          >
            <DeferredRow value={data.row} />
          </Suspense>
        </tbody>
      </table>
      <svg aria-label="Streamed SVG" viewBox="0 0 20 20">
        <Suspense fallback={<g data-pending="svg" />}>
          <DeferredCircle value={data.svg} />
        </Suspense>
      </svg>
      {/* Exercise a/b hexadecimal transport ids, not only decimal-looking ids. */}
      {Array.from({ length: 8 }, (_, index) => `segment-${index}`).map(name => (
        <Suspense key={name} fallback={<span>Segment pending</span>}>
          <DeferredField value={data.fast} name={name} />
        </Suspense>
      ))}
      <button
        type="button"
        onClick={() => setMounted(true)}
        data-testid="mount-id"
      >
        Mount another field
      </button>
      {mounted && <Field name="client" />}
    </section>
  );
}
