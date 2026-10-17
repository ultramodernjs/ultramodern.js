import { federatedComponent } from '../../src/federation';

const Child = federatedComponent<{ label: string }>('child/Widget');

export default function WorkerFederationParent(props: { label: string }) {
  return (
    <section data-native-worker-parent="">
      <Child label={props.label} />
    </section>
  );
}
