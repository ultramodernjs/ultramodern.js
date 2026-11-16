export const versions = {
  '@rstest/core': '0.12.6',
  'happy-dom': '21.0.4',
  'ioredis-mock': '8.13.1',
  '@types/ioredis-mock': '8.2.8',
  ioredis: '6.0.0',
};
export const corrections = {
  '@rstest/core': { 'happy-dom': '^20.8.3 || ^21.0.4' },
  'ioredis-mock': { ioredis: '^5 || ^6.0.0' },
  '@types/ioredis-mock': { ioredis: '^5 || ^6.0.0' },
};
