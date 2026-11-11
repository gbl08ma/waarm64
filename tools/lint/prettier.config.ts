// Prettier's options for the page's code (web/app/**: .svelte, .ts, .svelte.ts; docs/frontend-code.md §7):
// the repository's style (two spaces, single quotes, semicolons, trailing commas) at 120 columns.
import type { Config } from 'prettier';

const config: Config = {
  printWidth: 120,
  singleQuote: true,
  plugins: ['prettier-plugin-svelte'],
  overrides: [{ files: '*.svelte', options: { parser: 'svelte' } }],
};
export default config;
