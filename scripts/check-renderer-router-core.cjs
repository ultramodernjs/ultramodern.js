const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const native = require('./ultramodern-renderers/native-artifacts/protocol.mjs');

const core = '@tanstack/router-core';
const root = path.join(__dirname, '..');
const readManifest = pathRelative =>
  JSON.parse(
    fs.readFileSync(path.join(root, pathRelative, 'package.json'), 'utf8'),
  );

/**
 * A consumer that records an admitted native descriptor resolves exactly that
 * descriptor's canonical Core archive; every other consumer resolves the
 * registry release the native cohort corrects. The workspace admits one native
 * Core identity.
 */
function assertRendererRouterCore(dependency, read = readManifest) {
  let admitted;
  for (const { version, packages } of dependency.versions) {
    for (const { pathRelative } of packages) {
      const descriptor = read(pathRelative).ultramodern?.nativeArtifacts;
      let expected = native.cohort[core];
      if (descriptor) {
        try {
          native.validateDescriptor(descriptor);
        } catch (error) {
          throw new Error(
            `${pathRelative}: invalid native artifact descriptor: ${error.message}`,
            { cause: error },
          );
        }
        const pin = descriptor.packages[core];
        admitted ??= pin;
        assert.deepEqual(
          pin,
          admitted,
          `${pathRelative}: mixed native ${core} identities`,
        );
        expected = pin.request;
      }
      if (version !== expected) {
        throw new Error(
          `${pathRelative}: ${core} must resolve ${expected}, received ${version}`,
        );
      }
    }
  }
}

module.exports = { assertRendererRouterCore };
