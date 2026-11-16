import {
  publishArtifactRelease,
  verifyPayloads as verify,
} from '../../ultramodern-artifacts/release.mjs';
import * as protocol from './protocol.mjs';
export const verifyPayloads = (descriptor, payloads) =>
  verify({ protocol, descriptor, payloads });
export const publishRelease = options =>
  publishArtifactRelease({ ...options, protocol });
