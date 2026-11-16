import {
  reconstructArtifact,
  validateRecipe as validate,
  verifySourceQualification as verify,
} from '../ultramodern-artifacts/reconstruct.mjs';
import { supportProtocol as protocol } from './protocol.mjs';
export const reconstruct = options =>
  reconstructArtifact({ ...options, protocol });
export const validateRecipe = recipe => validate({ protocol, recipe });
export const verifySourceQualification = (recipe, evidence) =>
  verify({ protocol, recipe, evidence });
