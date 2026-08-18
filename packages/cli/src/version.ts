/**
 * Build-time CLI version.
 *
 * `__CLI_VERSION__` is substituted by tsup's `define` from
 * `packages/cli/package.json`. The `typeof` guard keeps the module importable
 * outside a bundled build (vitest, `tsx src/index.ts`), where the identifier
 * does not exist.
 */

declare const __CLI_VERSION__: string;

export const CLI_VERSION: string =
  typeof __CLI_VERSION__ === 'string' ? __CLI_VERSION__ : '0.0.0-dev';
