import { fileURLToPath } from 'node:url';

export function getDtsCompilerOptions(env = process.env) {
  return {
    tsgo: true,
    typescriptPath:
      env.ULTRAMODERN_DTS_COMPILER_MODULE ||
      fileURLToPath(new URL('./version.cjs', import.meta.url)),
  };
}
