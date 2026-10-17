import assert from 'node:assert/strict';

/** Run against a normally generated, built and served candidate app. */
export async function assertLocalizedNavigation(page, url) {
  const errors = [];
  const onError = error => errors.push(String(error));
  page.on('pageerror', onError);
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
    await page.goBack();
    await waitPath('/en/about');
    await page.goForward();
    await waitPath('/cs/polozky/blue');
    await assertDocument('preserved');

    await page.goto(`${url}/en/about`, { waitUntil: 'networkidle0' });
    await documentMarker();
    await page.click(selector('localized-relative'));
    await waitPath('/cs/polozky/relative');
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
    await assertDocument('preserved');

    await page.goto(`${url}/en/blocked`, { waitUntil: 'networkidle0' });
    await documentMarker();
    await page.click(selector('localized-bypass'));
    await waitPath('/cs/about');
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
    assert.deepEqual(errors, [], 'no browser runtime or hydration errors');
  } finally {
    page.off('pageerror', onError);
  }
}
