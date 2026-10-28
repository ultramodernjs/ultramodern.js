export type RedactConfig = boolean | { viewTransitions?: boolean };
export type ReactRuntimeConfig = {
  redact?: RedactConfig;
  server?: { rsc?: unknown };
};

export function validateRedactConfig(
  value: unknown,
): asserts value is RedactConfig | undefined {
  if (value === undefined || typeof value === 'boolean') return;
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null) &&
    Object.keys(value).every(key => key === 'viewTransitions') &&
    (!('viewTransitions' in value) ||
      value.viewTransitions === undefined ||
      typeof value.viewTransitions === 'boolean')
  )
    return;
  throw new Error(
    '[ultramodern] redact must be a boolean or { viewTransitions?: boolean }. Use redact: false to keep real React.',
  );
}

export function usesRedact(config: ReactRuntimeConfig): boolean {
  validateRedactConfig(config.redact);
  // Flight depends on React internals absent from Redact. Never split an RSC
  // app between runtimes, even its browser or auxiliary Node environments.
  return config.redact !== false && !config.server?.rsc;
}
