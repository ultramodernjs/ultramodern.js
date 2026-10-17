import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLifecycle, compatibleActivationDeltas } from './lifecycle.mjs';

const initial = () => ({
  owners: 1,
  activations: 1,
  cleanups: 0,
  currentOwner: 1,
  effects: [{ id: 1, ownerId: 1, cleanups: 0 }],
});
const edited = () => ({
  owners: 1,
  activations: 2,
  cleanups: 1,
  currentOwner: 1,
  effects: [
    { id: 1, ownerId: 1, cleanups: 1 },
    { id: 2, ownerId: 1, cleanups: 0 },
  ],
});
const compatible = {
  previous: initial(),
  transition: 'compatible',
  activations: [1, 1],
};

test('edited closures clean up and reactivate while retaining the native hook owner', () => {
  assertLifecycle(initial());
  assertLifecycle(edited(), compatible);
});

test('stable rereads cannot manufacture another effect activation', () => {
  assertLifecycle(edited(), {
    previous: edited(),
    transition: 'compatible',
    activations: compatibleActivationDeltas.burstStableRefresh,
  });
  assert.throws(() =>
    assertLifecycle(edited(), {
      ...compatible,
      activations: compatibleActivationDeltas.burstStableRefresh,
    }),
  );
});

test('a version dependency bubbles to the native component accept boundary exactly once', () => {
  assertLifecycle(edited(), {
    ...compatible,
    activations: compatibleActivationDeltas.reconnectedRefresh,
  });
  assert.throws(() =>
    assertLifecycle(initial(), {
      ...compatible,
      activations: compatibleActivationDeltas.reconnectedRefresh,
    }),
  );
});

test('incompatible shape retires the old hook owner and leaves one new activation', () => {
  const next = edited();
  next.owners = 2;
  next.currentOwner = 2;
  next.effects[1].ownerId = 2;
  assertLifecycle(next, { ...compatible, transition: 'new-owner' });
  assert.throws(() => assertLifecycle(next, compatible));
  assert.throws(() =>
    assertLifecycle(edited(), { ...compatible, transition: 'new-owner' }),
  );
});

test('actual unmount retires the last closure without a new activation', () => {
  const removed = edited();
  removed.cleanups = 2;
  removed.currentOwner = null;
  removed.effects[1].cleanups = 1;
  assertLifecycle(removed, {
    previous: edited(),
    transition: 'unmounted',
    activations: [0, 0],
  });
});

test('a balanced burst cannot briefly reactivate an already retired hook owner', () => {
  const previous = {
    owners: 2,
    activations: 2,
    cleanups: 1,
    currentOwner: 2,
    effects: [
      { id: 1, ownerId: 1, cleanups: 1 },
      { id: 2, ownerId: 2, cleanups: 0 },
    ],
  };
  const current = {
    owners: 2,
    activations: 4,
    cleanups: 3,
    currentOwner: 2,
    effects: [
      { id: 1, ownerId: 1, cleanups: 1 },
      { id: 2, ownerId: 2, cleanups: 1 },
      { id: 3, ownerId: 1, cleanups: 1 },
      { id: 4, ownerId: 2, cleanups: 0 },
    ],
  };
  const options = {
    previous,
    transition: 'compatible',
    activations: compatibleActivationDeltas.burstRefresh,
  };
  assert.throws(
    () => assertLifecycle(current, options),
    /every new activation/,
  );
  current.effects[2].ownerId = 2;
  assertLifecycle(current, options);
});

for (const [name, corrupt] of [
  [
    'leaked previous effect',
    value => {
      value.cleanups = 0;
      value.effects[0].cleanups = 0;
    },
  ],
  [
    'duplicate cleanup',
    value => {
      value.cleanups = 2;
      value.effects[0].cleanups = 2;
    },
  ],
  [
    'wrong current hook owner',
    value => {
      value.currentOwner = 2;
    },
  ],
  [
    'forged aggregate cleanup',
    value => {
      value.cleanups = 0;
    },
  ],
  [
    'dropped activation history',
    value => {
      value.effects.shift();
    },
  ],
  [
    'reused activation ID',
    value => {
      value.effects[1].id = 1;
    },
  ],
  [
    'rewritten previous owner',
    value => {
      value.owners = 2;
      value.effects[0].ownerId = 2;
    },
  ],
  [
    'unobserved hook owner',
    value => {
      value.owners++;
    },
  ],
])
  test(`rejects ${name}`, () => {
    const value = edited();
    corrupt(value);
    assert.throws(() => assertLifecycle(value, compatible));
  });
