export function getDtsCompilerOptions(env = process.env) {
  return env.ULTRAMODERN_DTS_COMPILER_MODULE
    ? {
        tsgo: true,
        typescriptPath: env.ULTRAMODERN_DTS_COMPILER_MODULE,
      }
    : {};
}
