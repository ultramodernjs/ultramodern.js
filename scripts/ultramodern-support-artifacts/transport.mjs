import {
  authenticateDescriptor as authenticate,
  githubReader as reader,
  verifyRelease as release,
  verifySource as source,
} from '../ultramodern-artifacts/transport.mjs';
import { supportProtocol as protocol } from './protocol.mjs';
export const githubReader = options => reader({ ...options, protocol });
export const verifySource = (producer, readGithub, options) =>
  source({ ...options, protocol, producer, readGithub });
export const verifyRelease = (value, descriptor, options) =>
  release({ ...options, protocol, release: value, descriptor });
export const authenticateDescriptor = options =>
  authenticate({ ...options, protocol });
