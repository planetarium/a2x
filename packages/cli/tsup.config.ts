import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

const define = {
  __CLI_VERSION__: JSON.stringify(pkg.version),
};

export default defineConfig([
  {
    name: 'esm',
    entry: ['src/index.ts'],
    outDir: 'dist',
    format: ['esm'],
    target: 'node20',
    clean: true,
    sourcemap: true,
    banner: {
      js: '#!/usr/bin/env node',
    },
    define,
  },
  {
    name: 'bin',
    entry: { a2x: 'src/index.ts' },
    outDir: 'bin-bundle',
    format: ['cjs'],
    target: 'node20',
    clean: true,
    sourcemap: false,
    noExternal: [/.*/],
    define,
  },
]);
