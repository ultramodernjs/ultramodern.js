// Serialized into a clean installed workspace by sidecar qualification.
export async function packedRedactProbeMain() {
  const assert = (await import('node:assert/strict')).default;
  const fs = (await import('node:fs')).default;
  const path = (await import('node:path')).default;
  const { createRequire } = await import('node:module');
  const name = '@bleedingdev/tanstack-redact';
  const root = path.join(process.cwd(), 'node_modules', name);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, '0.2.2');
  assert.equal(
    fs.existsSync(path.join(process.cwd(), 'node_modules/@tanstack/redact')),
    false,
    'Upstream Redact must not satisfy the sidecar probe',
  );
  // The framework refuses a Redact install without this first line.
  const [marker] = fs
    .readFileSync(path.join(root, 'dist/server/stream.js'), 'utf8')
    .split('\n', 1);
  assert.equal(marker, '// ultramodern-redact-patch: v1');
  // The probe must load the installed sidecar, not a linked external tree.
  const installedRoot = path.join(
    fs.realpathSync(process.cwd()),
    'node_modules',
    name,
  );
  const resolve = createRequire(path.join(process.cwd(), 'package.json'));
  assert.ok(
    fs.realpathSync(root) === installedRoot &&
      fs
        .realpathSync(resolve.resolve(`${name}/server`))
        .startsWith(`${installedRoot}${path.sep}`),
    'Redact export escaped the clean installed workspace',
  );

  const { Suspense, useId } = await import(name);
  const { jsx } = await import(`${name}/jsx-runtime`);
  const server = await import(`${name}/server`);
  function Field() {
    const id = useId();
    return jsx('label', { htmlFor: id, id, children: 'field' });
  }
  const table = jsx('table', {
    children: jsx('tbody', {
      children: jsx('tr', {
        children: jsx('td', {
          children: [jsx(Field, {}), jsx(Field, {})],
        }),
      }),
    }),
  });
  const html = server.renderToString(table);
  // Patched ids follow tree position; upstream 0.2.1 renders :R0 and :R1.
  const ids = [...html.matchAll(/ id="([^"]+)"/gu)].map(match => match[1]);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  for (const id of ids) assert.match(id, /^_R_[0-9a-z]+_$/u);
  assert.equal(server.renderToString(table), html);
  assert.match(html, /^<table><tbody><tr><td><label /u);

  const stream = await server.renderToReadableStream(
    jsx(Suspense, {
      fallback: 'loading',
      children: jsx('p', { children: 'streamed' }),
    }),
  );
  assert.match(await new Response(stream).text(), /<p>streamed<\/p>/u);
  process.stdout.write(
    `${JSON.stringify({ probe: 'redact-sidecar', ids, marker })}\n`,
  );
}
