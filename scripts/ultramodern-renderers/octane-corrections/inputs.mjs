export const source = Object.freeze({
  commit: '4c35afcdca0f4889921612fc462e6aabe507d78d',
  url: 'https://codeload.github.com/octanejs/octane/tar.gz/4c35afcdca0f4889921612fc462e6aabe507d78d',
  sha256: 'e12e4846d57c0e4913f60bd1d010637cfe175b833158cb50e2d175c7452f5900',
});
export const references = Object.freeze({
  commit: '2383d2ab1e702bb78abd4462069d7ce3c11ab9d2',
  // routerRenderSnapshot.ts.txt is an immutable source payload, copied byte-for-
  // byte to src/ssr/routerRenderSnapshot.ts, not a formatter-owned helper.
  // Runtime changes target the new split runtime, never replace it with this ref.
  snapshotSourceSha256:
    'a7d410186d5d571562c0e908ed877a0f8223189b09226ed01366e88f10a27168',
});
export const packages = Object.freeze([
  {
    name: 'octane',
    version: '0.18.0',
    directory: 'octane',
    url: 'https://registry.npmjs.org/octane/-/octane-0.18.0.tgz',
    integrity:
      'sha512-nMuONCV3pMMJhWjlXmC08Dn+i/bXju1micX/kKyAxY1b+dGK0zvCY6dCuMn791pyQfgXBs0jQ2X8apPysVrOhQ==',
  },
  {
    name: '@octanejs/tanstack-router',
    version: '0.3.4',
    directory: 'tanstack-router',
    url: 'https://registry.npmjs.org/@octanejs/tanstack-router/-/tanstack-router-0.3.4.tgz',
    integrity:
      'sha512-IuPkdjVHxwbpMyrsmY789XxV/A3Ozqn0bbgp0MT/MaSKVm003Hr7TJ50OmG9fekJHYCpEgq31iUGrD9SZ70j2w==',
  },
  {
    name: '@octanejs/rspack-plugin',
    version: '0.2.10',
    directory: 'rspack-plugin-octane',
    url: 'https://registry.npmjs.org/@octanejs/rspack-plugin/-/rspack-plugin-0.2.10.tgz',
    integrity:
      'sha512-J/yQ1vJBnNTpcTmOZWDaKucHXiK5bRnaFMqEwerzdeEi2GHihGvUTjTiYRwl2TCMva2Sd+ItSxUv+jRqSDMgyA==',
  },
]);
export const cohort = Object.freeze({
  '@tanstack/router-core': '1.171.39',
  '@tanstack/history': '1.162.5',
  '@tanstack/store': '0.11.2',
  '@tsrx/oxc': '0.24.0',
  typescript: '7.0.2',
});
