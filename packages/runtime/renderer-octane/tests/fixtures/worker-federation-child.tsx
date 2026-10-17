import { useId } from 'octane';
import { useSignal$ } from 'octane/signals/client';

export default function WorkerFederationChild(props: { label: string }) {
  const count$ = useSignal$(3);
  const id = useId();
  return (
    <button
      id={id}
      data-native-worker-child=""
      onClick={() => count$.set(value => value + 1)}
    >
      {props.label}: {count$.get()}
    </button>
  );
}
