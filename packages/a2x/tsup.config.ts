import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node20',
    outDir: 'dist',
  },
  {
    entry: {
      'auth/index': 'src/auth/index.ts',
      'provider/anthropic/index': 'src/provider/anthropic/index.ts',
      'provider/openai/index': 'src/provider/openai/index.ts',
      'provider/google/index': 'src/provider/google/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: false,
    target: 'node20',
    outDir: 'dist',
  },
]);
