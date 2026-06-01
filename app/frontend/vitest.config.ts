import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The Next tsconfig leaves jsx="preserve" for SWC, but vitest's esbuild
  // pipeline still needs to know how to compile JSX in test files. Force the
  // React 17+ automatic runtime so we don't have to add `import React` to
  // every *.test.tsx.
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
