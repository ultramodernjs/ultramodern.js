import {
  reconstructArtifact,
  validateRecipe as validate,
  verifySourceQualification as verify,
} from '../../ultramodern-artifacts/reconstruct.mjs';
import * as protocol from './protocol.mjs';

export {
  applyExactPatch,
  packFiles,
} from '../../ultramodern-artifacts/reconstruct.mjs';
export const validateRecipe = recipe =>
  validate({ protocol: protocol, recipe });
export const verifySourceQualification = (recipe, evidence) =>
  verify({ protocol: protocol, recipe, evidence });
export const reconstruct = options =>
  reconstructArtifact({ ...options, protocol: protocol });
