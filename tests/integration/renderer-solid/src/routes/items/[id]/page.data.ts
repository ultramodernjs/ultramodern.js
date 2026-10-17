import type { DataHandlerInput } from '@modern-js/renderer-core/data';
import { barrier, observe } from '../../../data/acceptance-lifecycle';

export async function loader({ params, request }: DataHandlerInput) {
  await observe(request, 'loader-entered');
  await barrier(request);
  await observe(request, 'loader-released');
  return { item: `Item ${params.id}` };
}
