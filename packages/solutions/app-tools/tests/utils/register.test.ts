import * as utils from '@modern-js/utils' with { rstest: 'importActual' };

const mockPathExists = rstest.fn();
const mockGetAliasConfig = rstest.fn();
const mockRegisterPathsLoader = rstest.fn();

const originalTypeScriptFeature = (process.features as any).typescript;

const setNativeTypeScriptSupport = (value: boolean | string | undefined) => {
  Object.defineProperty(process.features, 'typescript', {
    value,
    configurable: true,
    writable: true,
  });
};

rstest.mock('../../src/esm/register-esm.mjs', () => ({
  __esModule: true,
  registerPathsLoader: (...args: unknown[]) => mockRegisterPathsLoader(...args),
}));

rstest.mock('@modern-js/utils', () => ({
  __esModule: true,
  ...utils,
  fs: {
    ...utils.fs,
    pathExists: (...args: unknown[]) => mockPathExists(...args),
  },
  getAliasConfig: (...args: unknown[]) => mockGetAliasConfig(...args),
}));

describe('setupTsRuntime', () => {
  it('should reject a missing native TypeScript capability', async () => {
    const { resolveTsRuntimeRegisterMode } = await import(
      '../../src/utils/register'
    );
    setNativeTypeScriptSupport(undefined);
    const expected = 'unsupported';
    expect(resolveTsRuntimeRegisterMode()).toBe(expected);
  });

  it('should prefer native capability over node version', async () => {
    setNativeTypeScriptSupport(true);
    const { resolveTsRuntimeRegisterMode } = await import(
      '../../src/utils/register'
    );
    expect(resolveTsRuntimeRegisterMode()).toBe('node-loader');
  });

  it('should treat string native capability as supported', async () => {
    setNativeTypeScriptSupport('strip');
    const { resolveTsRuntimeRegisterMode } = await import(
      '../../src/utils/register'
    );
    expect(resolveTsRuntimeRegisterMode()).toBe('node-loader');
  });

  it('should reject unknown native TypeScript capabilities', async () => {
    setNativeTypeScriptSupport('bogus');
    const { resolveTsRuntimeRegisterMode } = await import(
      '../../src/utils/register'
    );
    expect(resolveTsRuntimeRegisterMode()).toBe('unsupported');
  });

  it('should reject disabled native TypeScript support without a version fallback', async () => {
    setNativeTypeScriptSupport(false);
    const { resolveTsRuntimeRegisterMode } = await import(
      '../../src/utils/register'
    );
    expect(resolveTsRuntimeRegisterMode()).toBe('unsupported');
  });

  beforeEach(() => {
    rstest.clearAllMocks();
    setNativeTypeScriptSupport(originalTypeScriptFeature);
    mockPathExists.mockResolvedValue(true);
    mockGetAliasConfig.mockReturnValue({
      absoluteBaseUrl: '/project',
      paths: {
        '@/*': ['src/*'],
      },
    });
  });

  afterAll(() => {
    setNativeTypeScriptSupport(originalTypeScriptFeature);
  });

  it('should use node loader when native capability is available', async () => {
    setNativeTypeScriptSupport(true);
    const { setupTsRuntime } = await import('../../src/utils/register');

    await setupTsRuntime('/project', '/project/dist', []);

    expect(mockRegisterPathsLoader).toBeCalledTimes(1);
    expect(mockRegisterPathsLoader).toBeCalledWith({
      baseUrl: '/project',
      appDir: '/project',
      paths: {
        '@/*': ['src/*'],
      },
    });
  });

  it('should fail clearly when native TypeScript is disabled', async () => {
    setNativeTypeScriptSupport(false);
    mockPathExists.mockResolvedValue(false);
    const { setupTsRuntime } = await import('../../src/utils/register');

    await expect(
      setupTsRuntime('/project', '/project/dist', []),
    ).rejects.toThrow(
      /requires Node\.js >=26\.12\.0 with native TypeScript support/,
    );

    expect(mockRegisterPathsLoader).not.toBeCalled();
  });

  it('should do nothing when tsconfig does not exist', async () => {
    mockPathExists.mockResolvedValue(false);
    const { setupTsRuntime } = await import('../../src/utils/register');

    await setupTsRuntime('/project', '/project/dist', []);

    expect(mockRegisterPathsLoader).not.toBeCalled();
  });
});
