import assert from 'node:assert/strict';

/** Capture failures across the whole navigation proof and release every listener. */
export function observeLocalizedNavigationErrors(page, url) {
  const errors = [];
  const origin = new URL(url).origin;
  const listeners = {
    pageerror: error => errors.push(`pageerror: ${String(error)}`),
    console: message => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    },
    requestfailed: request =>
      errors.push(
        `requestfailed: ${request.url()} ${request.failure()?.errorText ?? 'unknown failure'}`,
      ),
    response: response => {
      if (response.status() >= 400 && new URL(response.url()).origin === origin)
        errors.push(`HTTP ${response.status()}: ${response.url()}`);
    },
  };
  for (const [event, listener] of Object.entries(listeners))
    page.on(event, listener);
  return {
    assertClean: () =>
      assert.deepEqual(
        errors,
        [],
        'no browser, console, request or same-origin HTTP errors',
      ),
    stop: () => {
      for (const [event, listener] of Object.entries(listeners))
        page.off(event, listener);
    },
  };
}

/** Finish the native destination and its requests before intentionally replacing a document. */
export async function settleLocalizedNavigation(page, { item } = {}) {
  if (item) {
    await page.waitForFunction(
      expected => {
        const rendered = document.querySelector(
          '[data-testid="navigation-item"]',
        )?.textContent;
        return rendered && JSON.parse(rendered).id === expected;
      },
      {},
      item,
    );
  } else await page.waitForSelector('[data-testid="navigation-about"]');
  await page.waitForNetworkIdle({ idleTime: 500 });
}

/** Run against a normally generated, built and served candidate app. */
export async function assertLocalizedNavigation(page, url) {
  const errors = observeLocalizedNavigationErrors(page, url);
  const selector = name => `[data-testid="${name}"]`;
  const waitPath = pathname =>
    page.waitForFunction(
      expected => location.pathname === expected,
      {},
      pathname,
    );
  const assertDocument = async expected =>
    assert.equal(
      await page.evaluate(() => window.__navigationDocument),
      expected,
      'native SPA navigation preserves the document',
    );
  const expectAnchor = async (name, attribute, expected) =>
    assert.equal(
      await page.$eval(
        selector(name),
        (node, key) => node.getAttribute(key),
        attribute,
      ),
      expected,
    );
  const documentMarker = async () =>
    page.evaluate(() => {
      window.__navigationDocument = 'preserved';
    });
  try {
    await page.goto(`${url}/en/about?sort=alpha#start`, {
      waitUntil: 'networkidle0',
    });
    await page.waitForSelector(selector('navigation-about'));
    await documentMarker();
    await expectAnchor(
      'localized-product',
      'href',
      '/cs/polozky/red?sort=price#details',
    );
    await expectAnchor(
      'localized-external',
      'href',
      'https://example.invalid/outside',
    );
    await expectAnchor('localized-disabled', 'href', null);
    await expectAnchor('localized-disabled', 'aria-disabled', 'true');

    const preloaded = page.waitForResponse(response => {
      const target = new URL(response.url());
      return (
        /\/(?:items|polozky)\/red$/u.test(target.pathname) &&
        target.searchParams.get('sort') === 'price' &&
        response.request().resourceType() !== 'document'
      );
    });
    await page.hover(selector('localized-product'));
    assert.ok(
      (await preloaded).ok(),
      'native intent preload fetches destination data',
    );
    assert.equal(new URL(page.url()).pathname, '/en/about');
    await assertDocument('preserved');

    await page.click(selector('localized-product'));
    await waitPath('/cs/polozky/red');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="navigation-language"]')
          ?.textContent === 'cs',
    );
    await assertDocument('preserved');
    await expectAnchor('localized-product', 'data-selected', 'yes');
    const locationState = await page.$eval(
      selector('navigation-location'),
      node => JSON.parse(node.textContent),
    );
    assert.equal(locationState.state.cart, 'tractor');
    assert.equal(locationState.search.sort, 'price');
    assert.equal(locationState.hash, 'details');
    assert.deepEqual(
      await page.$eval(selector('navigation-item'), node =>
        JSON.parse(node.textContent),
      ),
      { id: 'red', sort: 'price' },
    );

    await page.click(selector('localized-replace'));
    await waitPath('/cs/polozky/blue');
    await settleLocalizedNavigation(page, { item: 'blue' });
    await page.goBack();
    await waitPath('/en/about');
    await settleLocalizedNavigation(page);
    await page.goForward();
    await waitPath('/cs/polozky/blue');
    await settleLocalizedNavigation(page, { item: 'blue' });
    await assertDocument('preserved');

    await page.goto(`${url}/en/about`, { waitUntil: 'networkidle0' });
    await documentMarker();
    await page.click(selector('localized-relative'));
    await waitPath('/cs/polozky/relative');
    await settleLocalizedNavigation(page, { item: 'relative' });
    await assertDocument('preserved');

    await page.goto(`${url}/en/blocked`, { waitUntil: 'networkidle0' });
    await documentMarker();
    await page.click(selector('localized-product'));
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="navigation-blocker"]')
          ?.textContent === 'blocked',
    );
    assert.equal(new URL(page.url()).pathname, '/en/blocked');
    await page.click(selector('navigation-reject'));
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="navigation-blocker"]')
          ?.textContent === 'idle',
    );
    assert.equal(new URL(page.url()).pathname, '/en/blocked');
    await page.click(selector('localized-product'));
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="navigation-blocker"]')
          ?.textContent === 'blocked',
    );
    await page.click(selector('navigation-accept'));
    await waitPath('/cs/polozky/red');
    await settleLocalizedNavigation(page, { item: 'red' });
    await assertDocument('preserved');

    await page.goto(`${url}/en/blocked`, { waitUntil: 'networkidle0' });
    await documentMarker();
    await page.click(selector('localized-bypass'));
    await waitPath('/cs/about');
    await settleLocalizedNavigation(page);
    await assertDocument('preserved');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0' }),
      page.click(selector('localized-document')),
    ]);
    assert.equal(new URL(page.url()).pathname, '/cs/about');
    assert.equal(new URL(page.url()).search, '?sort=document');
    assert.equal(new URL(page.url()).hash, '#document');
    assert.equal(
      await page.evaluate(() => window.__navigationDocument),
      undefined,
      'reloadDocument loads a new document at the advertised localized href',
    );
    errors.assertClean();
    return {
      nativeMasks: true,
      intentPreload: true,
      history: true,
      relativeNavigation: true,
      blockers: true,
      documentLifetime: true,
      noRuntimeErrors: true,
    };
  } finally {
    errors.stop();
  }
}
