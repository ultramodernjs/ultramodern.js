import assert from 'node:assert/strict';

/** Hook ownership survives compatible HMR; edited effect closures reactivate. */
export function assertLifecycle(
  current,
  { previous, transition = 'initial', activations = [1, 1] } = {},
) {
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  for (const key of ['owners', 'activations', 'cleanups'])
    assert.ok(
      integer(current[key]),
      `lifecycle ${key} is a nonnegative integer`,
    );
  assert.equal(current.effects.length, current.activations);
  assert.equal(
    new Set(current.effects.map(effect => effect.ownerId)).size,
    current.owners,
    'every hook owner has an observed effect activation',
  );
  for (const [index, effect] of current.effects.entries()) {
    assert.equal(effect.id, index + 1, 'effect activation IDs are append-only');
    assert.ok(
      Number.isSafeInteger(effect.ownerId) &&
        effect.ownerId > 0 &&
        effect.ownerId <= current.owners,
      'effect activation belongs to a recorded hook owner',
    );
    assert.ok(
      effect.cleanups === 0 || effect.cleanups === 1,
      'each effect activation cleans up at most once',
    );
  }
  assert.equal(
    current.cleanups,
    current.effects.reduce((sum, effect) => sum + effect.cleanups, 0),
    'aggregate cleanup count matches individual activations',
  );
  const live = current.effects.filter(effect => effect.cleanups === 0);
  const mounted = transition !== 'unmounted';
  assert.equal(
    live.length,
    mounted ? 1 : 0,
    'exactly one live effect per mounted owner',
  );
  assert.equal(current.currentOwner, mounted ? live[0].ownerId : null);
  if (mounted)
    assert.equal(
      live[0].id,
      current.activations,
      'all older effect closures retired',
    );
  if (!previous) {
    assert.equal(transition, 'initial');
    assert.equal(current.owners, 1);
    assert.equal(current.activations, 1);
    assert.equal(current.cleanups, 0);
    assert.equal(current.currentOwner, 1);
    return;
  }
  const added = current.activations - previous.activations;
  assert.ok(
    added >= activations[0] && added <= activations[1],
    `effect activation delta ${added} is within ${activations.join('..')}`,
  );
  assert.equal(
    current.cleanups - previous.cleanups,
    added + (previous.currentOwner === null ? 0 : 1) - (mounted ? 1 : 0),
    'new activations retire the previous closure exactly once',
  );
  for (const [index, effect] of previous.effects.entries()) {
    const retained = current.effects[index];
    assert.ok(retained, 'previous activation history is retained');
    assert.equal(retained.id, effect.id);
    assert.equal(retained.ownerId, effect.ownerId);
    assert.ok(retained.cleanups >= effect.cleanups, 'cleanup never reverses');
  }
  if (transition === 'compatible')
    assert.notEqual(
      previous.currentOwner,
      null,
      'compatible refresh requires a live hook owner',
    );
  const expectedOwner =
    transition === 'new-owner' ? current.owners : previous.currentOwner;
  for (const effect of current.effects.slice(previous.activations))
    assert.equal(
      effect.ownerId,
      expectedOwner,
      'every new activation belongs to the retained or newly admitted owner',
    );
  if (transition === 'new-owner') {
    assert.equal(current.owners, previous.owners + 1);
    assert.equal(current.currentOwner, current.owners);
    assert.notEqual(current.currentOwner, previous.currentOwner);
  } else {
    assert.ok(transition === 'compatible' || transition === 'unmounted');
    assert.equal(
      current.owners,
      previous.owners,
      'compatible refresh keeps the hook owner',
    );
    if (mounted) assert.equal(current.currentOwner, previous.currentOwner);
  }
}

export const compatibleActivationDeltas = Object.freeze({
  componentAndDependencyRefresh: [1, 1],
  // version.ts has no accept boundary. Its update bubbles to Widget's native
  // webpack self-accept, whose retained component wrapper installs one body.
  reconnectedRefresh: [1, 1],
  burstRefresh: [1, 2],
  burstStableRefresh: [0, 0],
});
