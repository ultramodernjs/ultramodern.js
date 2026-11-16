import { expect, test } from '@rstest/core';

test('the actual runner supplies happyDOM and supports its asynchronous lifecycle', async () => {
  expect(window.happyDOM).toBeDefined();
  expect(location.href).toBe('https://qualification.invalid/runner');
  document.body.innerHTML = '<button>click</button>';
  let clicked = false;
  document.querySelector('button').addEventListener('click', () => {
    clicked = true;
  });
  document.querySelector('button').click();
  expect(clicked).toBe(true);
  const mutated = new Promise(resolve =>
    new MutationObserver(resolve).observe(document.body, { childList: true }),
  );
  document.body.append(document.createElement('span'));
  await mutated;
  expect(await new Response('runner').text()).toBe('runner');
  await new Promise(resolve => setTimeout(resolve, 1));
  // These must be cleared by rstest's environment teardown, not by fixture cleanup.
  setTimeout(() => {
    throw new Error('test timeout escaped owning teardown');
  }, 500);
  setInterval(() => {
    throw new Error('test interval escaped owning teardown');
  }, 500);
});
