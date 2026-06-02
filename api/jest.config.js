/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Don't try to load the user's real .env during tests.
  setupFiles: ['<rootDir>/src/test-setup.ts'],
  // ts-jest's default error-on-isolatedModules-for-CommonJS noise is moot here.
  transform: {
    '^.+\\.ts$': ['ts-jest', { isolatedModules: true }],
  },
};
