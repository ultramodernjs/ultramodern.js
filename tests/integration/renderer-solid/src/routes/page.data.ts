import type { DataHandlerInput } from '@modern-js/renderer-core/data';
import { deferData } from '@modern-js/renderer-core/data';
import { observedLater } from '../data/acceptance-lifecycle';
import { later } from '../data/late';

export function loader({ request }: DataHandlerInput) {
  const scenario = new URL(request.url).searchParams.get('case');
  if (scenario === 'deferred')
    return deferData(
      { message: 'Native critical value' },
      {
        late: request.headers.has('x-solid-acceptance-request')
          ? observedLater('Native late value', request)
          : later('Native late value'),
      },
    );
  if (scenario === 'not-found')
    throw new Response('Native route not found', { status: 404 });
  if (scenario === 'error') throw new Error('Native loader failure');
  if (scenario === 'redirect')
    return new Response(null, { status: 302, headers: { location: '/about' } });
  return { message: 'Native loader value' };
}

export async function action({ request }: DataHandlerInput) {
  const form = await request.formData();
  const name = form.get('name');
  if (typeof name !== 'string' || !name.trim())
    return Response.json(
      { fieldErrors: { name: 'Name required' } },
      { status: 422 },
    );
  if (form.get('intent') === 'redirect')
    return new Response(null, {
      status: 303,
      headers: {
        location: '/about',
        'set-cookie': 'renderer-saved=1; Path=/; SameSite=Lax',
      },
    });
  if (form.get('intent') === 'throw') throw new Error('Native action failure');
  return { saved: name };
}
