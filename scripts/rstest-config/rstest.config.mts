import { withTestPreset } from './src';

export default withTestPreset({
  root: __dirname,
  testEnvironment: 'node',
  setupFiles: ['./setup.ts'],
});
