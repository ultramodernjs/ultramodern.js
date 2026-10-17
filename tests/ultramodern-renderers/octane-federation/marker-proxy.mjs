import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

/**
 * Capture native SSR nodes before hydration. Only the original entry responses
 * wait for the read-only marker. Absolute entries can redirect to their native
 * URL after capture, without serving native bytes under a proxy URL.
 */
export function createSSRMarkerProxy({
  target,
  signal,
  markerTimeout = 15_000,
  widgetSelector = '[data-testid="remote-widget"]',
  counterSelector,
  absoluteEntries,
  allowedEntrySources,
}) {
  const upstreamOrigin = new URL(target);
  assert.ok(
    absoluteEntries === undefined || absoluteEntries === 'redirect',
    'absolute entries use the explicit redirect mode',
  );
  const redirectEntries = absoluteEntries === 'redirect';
  const allowedSources = new Set();
  if (redirectEntries) {
    assert.ok(
      ['http:', 'https:'].includes(upstreamOrigin.protocol) &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(upstreamOrigin.hostname) &&
        upstreamOrigin.port &&
        !upstreamOrigin.username &&
        !upstreamOrigin.password,
      'absolute entries require an explicit owned loopback origin and port',
    );
    assert.ok(
      Array.isArray(allowedEntrySources) || allowedEntrySources instanceof Set,
      'absolute entries require an exact allowed source list',
    );
    for (const source of allowedEntrySources) {
      assert.equal(typeof source, 'string', 'allowed entry sources are URLs');
      const url = new URL(source);
      assert.ok(
        ['http:', 'https:'].includes(url.protocol) &&
          url.origin === upstreamOrigin.origin &&
          !url.username &&
          !url.password,
        'allowed entry sources belong to the exact owned target origin',
      );
      allowedSources.add(source);
    }
  }
  const markerPath = `/__octane_mf_marker_${randomUUID()}`;
  const closed = new AbortController();
  const state = {
    markerPath,
    markerCaptured: false,
    entryScripts: [],
    blockedEntries: 0,
    deliveredEntries: [],
    redirectedEntries: [],
    additionalDocuments: 0,
  };
  const entryURLs = new Set();
  const entryRedirects = new Map();
  let capturedDocument = false;
  let releaseMarker;
  const captured = new Promise(resolve => {
    releaseMarker = resolve;
  });
  const marker = `<script>
window.__ssrRemoteWidget = document.querySelector(${JSON.stringify(widgetSelector)});
window.__ssrRemoteCounter = ${counterSelector ? `document.querySelector(${JSON.stringify(counterSelector)})` : 'null'};
window.__ssrRemoteAlreadyHydrated = window.__ssrRemoteWidget?.getAttribute('data-hydrated') === 'true';
window.__ssrRemoteWidgetCapture = {
  present: window.__ssrRemoteWidget !== null,
  connected: window.__ssrRemoteWidget?.isConnected ?? false,
  outerHTML: window.__ssrRemoteWidget?.outerHTML ?? null,
  hydrateBoundaryId: window.__ssrRemoteWidget?.closest('[data-octane-hydrate-id]')?.getAttribute('data-octane-hydrate-id') ?? null,
  publisherDescriptor: window.__ssrRemoteWidget?.closest('[data-octane-hydrate-id]')?.querySelector('script[data-octane-publisher]')?.textContent ?? null,
  pendingSegmentIds: Array.from(document.querySelectorAll('[data-oct-s]')).map(node => node.getAttribute('data-oct-s')),
};
window.__ssrEntryScripts = Array.from(document.scripts).filter(script => script.type === 'module').map(script => ({ source: script.getAttribute('src'), asyncAttribute: script.hasAttribute('async'), asyncProperty: script.async }));
window.__remoteFallbackSeen = Boolean(document.querySelector('[data-testid="remote-fallback"]'));
new MutationObserver(records => {
  for (const record of records) for (const node of record.addedNodes) {
    if (node.nodeType === 1 && (node.matches('[data-testid="remote-fallback"]') || node.querySelector('[data-testid="remote-fallback"]'))) window.__remoteFallbackSeen = true;
  }
}).observe(document.getElementById('root'), { childList: true, subtree: true });
void fetch(${JSON.stringify(markerPath)}, { cache: 'no-store' }).catch(() => {});
</script>`;

  const server = createServer((request, response) => {
    const disconnected = new AbortController();
    const abort = () => disconnected.abort(new Error('Proxy request closed'));
    response.once('close', abort);
    void (async () => {
      const url = new URL(request.url, upstreamOrigin);
      if (url.pathname === markerPath) {
        state.markerCaptured = true;
        releaseMarker();
        response.writeHead(204).end();
        return;
      }
      const cancellation = AbortSignal.any([
        ...(signal ? [signal] : []),
        closed.signal,
        disconnected.signal,
        AbortSignal.timeout(30_000),
      ]);
      const redirect = entryRedirects.get(url.pathname + url.search);
      const entry = entryURLs.has(url.href);
      if (entry || redirect) {
        state.blockedEntries++;
        const timed = new AbortController();
        const waiting = AbortSignal.any([cancellation, timed.signal]);
        const timer = setTimeout(
          () =>
            timed.abort(new Error('SSR marker did not capture the document')),
          markerTimeout,
        );
        let stopWaiting;
        try {
          waiting.throwIfAborted();
          await Promise.race([
            captured,
            new Promise((_, reject) => {
              stopWaiting = () => reject(waiting.reason);
              waiting.addEventListener('abort', stopWaiting, { once: true });
            }),
          ]);
          waiting.throwIfAborted();
          assert.equal(state.markerCaptured, true);
        } finally {
          clearTimeout(timer);
          if (stopWaiting) waiting.removeEventListener('abort', stopWaiting);
        }
      }
      if (redirect) {
        state.redirectedEntries.push({
          url: redirect,
          markerCaptured: state.markerCaptured,
        });
        response
          .writeHead(307, { location: redirect, 'cache-control': 'no-store' })
          .end();
        return;
      }
      const upstream = await fetch(url, {
        headers: { accept: request.headers.accept ?? '*/*' },
        signal: cancellation,
      });
      const type = upstream.headers.get('content-type') ?? '';
      response.statusCode = upstream.status;
      if (type) response.setHeader('content-type', type);
      response.setHeader('cache-control', 'no-store');
      if (!type.includes('text/html')) {
        const body = Buffer.from(await upstream.arrayBuffer());
        if (entry)
          state.deliveredEntries.push({
            url: url.href,
            markerCaptured: state.markerCaptured,
          });
        response.end(body);
        return;
      }
      const html = await upstream.text();
      if (capturedDocument && redirectEntries) {
        state.additionalDocuments++;
        response.end(html);
        return;
      }
      assert.equal(capturedDocument, false, 'one document per marker proxy');
      assert.match(html, /\bid="root"/u, 'the document holds its native root');
      const nativeEntries = [...html.matchAll(/<script\b[^>]*>/giu)]
        .map(match => readModuleEntry(match))
        .filter(Boolean);
      assert.ok(nativeEntries.length > 0, 'the document has native entries');
      const relativeEntries = new Set();
      const redirects = [];
      for (const entry of nativeEntries) {
        const src = entry.source.replace(/&amp;/gu, '&');
        assert.ok(
          !src.startsWith('//'),
          'protocol-relative entries are rejected',
        );
        const relative = src.startsWith('/');
        assert.ok(
          relative || redirectEntries,
          'native entries pass through the proxy',
        );
        const entryURL = relative ? new URL(src, upstreamOrigin) : new URL(src);
        assert.equal(entryURL.origin, upstreamOrigin.origin);
        if (relative) relativeEntries.add(entryURL.href);
        else {
          assert.ok(
            allowedSources.has(src),
            'absolute native entries match an exact allowed source',
          );
          redirects.push({
            ...entry,
            target: src,
            path: `${markerPath}/entry_${randomUUID()}`,
          });
        }
      }
      assert.ok(
        relativeEntries.size + redirects.length < 6,
        'the HTTP/1.1 origin leaves a connection for the capture marker',
      );
      const bodyEnd = html.lastIndexOf('</body>');
      assert.ok(
        bodyEnd > html.lastIndexOf('data-octane-stream'),
        'native segments arrive before the body closes',
      );
      let document = html;
      for (const entry of redirects.toReversed()) {
        document =
          document.slice(0, entry.sourceOffset) +
          entry.path +
          document.slice(entry.sourceOffset + entry.source.length);
      }
      for (const entry of relativeEntries) entryURLs.add(entry);
      for (const entry of redirects)
        entryRedirects.set(entry.path, entry.target);
      state.entryScripts = nativeEntries.map(entry => entry.script);
      capturedDocument = true;
      const documentBodyEnd = document.lastIndexOf('</body>');
      response.end(
        document.slice(0, documentBodyEnd) +
          marker +
          document.slice(documentBodyEnd),
      );
    })()
      .catch(error => {
        if (response.headersSent || disconnected.signal.aborted)
          response.destroy();
        else response.writeHead(500).end(String(error));
      })
      .finally(() => response.off('close', abort));
  });
  server.proof = state;
  server.once('close', () => closed.abort(new Error('Marker proxy retired')));
  return server;
}

function readModuleEntry(match) {
  const script = match[0];
  const attributes = new Map();
  for (const attribute of script
    .slice(7, -1)
    .matchAll(
      /\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu,
    )) {
    const name = attribute[1].toLowerCase();
    const value = attribute[2] ?? attribute[3] ?? attribute[4];
    if (name !== 'type' && name !== 'src') continue;
    assert.ok(!attributes.has(name), `native script has one ${name} attribute`);
    const quoted = attribute[2] !== undefined || attribute[3] !== undefined;
    attributes.set(name, {
      value,
      offset:
        7 +
        attribute.index +
        attribute[0].length -
        (value?.length ?? 0) -
        (quoted ? 1 : 0),
    });
  }
  if (attributes.get('type')?.value !== 'module') return null;
  const source = attributes.get('src');
  assert.ok(source?.value, 'native entry modules have an external source');
  return {
    script,
    source: source.value,
    sourceOffset: match.index + source.offset,
  };
}
