import * as core from '../../ultramodern-artifacts/transport.mjs';
import * as protocol from './protocol.mjs';

export { readBytes } from '../../ultramodern-artifacts/transport.mjs';
export const githubReader = (options = {}) =>
  core.githubReader({ ...options, protocol });
export const verifySource = (producer, readGithub, options = {}) =>
  core.verifySource({ ...options, protocol, producer, readGithub });
export const releaseBody = descriptor =>
  core.releaseBody({ protocol, descriptor });
export const verifyRelease = (release, descriptor, options = {}) =>
  core.verifyRelease({ ...options, protocol, release, descriptor });
export const authenticateDescriptor = (descriptor, options = {}) =>
  core.authenticateDescriptor({ ...options, protocol, descriptor });
