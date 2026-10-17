import { useEffect, useId } from 'octane';
import { useSignal$ } from 'octane/signals/client';

export default function FederationPublisher(props: {
  label: string;
  initial: number;
  lifecycle?: (event: 'mount' | 'cleanup', id: string) => void;
}) {
  const count$ = useSignal$(props.initial);
  const id = useId();
  useEffect(() => {
    props.lifecycle?.('mount', id);
    return () => props.lifecycle?.('cleanup', id);
  }, []);
  return (
    <button
      id={id}
      data-publisher={props.label}
      onClick={() => count$.set(value => value + 1)}
    >
      {props.label}: {count$.get()}
    </button>
  );
}
