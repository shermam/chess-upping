import { defineConfig } from 'vitest/config';

// Firestore security rules tests. Run through the emulator:
//   npm run rules:test
export default defineConfig({
  test: {
    include: ['firestore-tests/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
