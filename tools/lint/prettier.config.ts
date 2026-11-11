// Prettier's options for the page's code (web/app/**: .svelte, .ts, .svelte.ts; docs/frontend-code.md §7):
// the repository's style (two spaces, single quotes, semicolons, trailing commas) at 120 columns.
import type { Config } from 'prettier';
import { fileURLToPath } from 'node:url';

const config: Config = {
  printWidth: 120,
  singleQuote: true,
  // A path, not a name: Prettier resolves a name from the working directory, outside this package.
  plugins: [fileURLToPath(import.meta.resolve('prettier-plugin-svelte'))],
  overrides: [{ files: '*.svelte', options: { parser: 'svelte' } }],
};
export default config;
