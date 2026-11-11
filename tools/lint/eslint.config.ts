// ESLint over the page's code (web/app/**; docs/frontend-code.md §7), not web/*.ts or the core: typescript-eslint's
// strict and stylistic type-checked sets, eslint-plugin-svelte's recommended set, and the rules of thumb that can be
// checked. `npm run lint` runs it from the repository's root, the base of the paths below, under ./ts6.ts. What fails
// today is grandfathered in ./eslint-suppressions.json, which only shrinks: the lint fails on a new violation and on
// a suppression that no longer matches one.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const REACH = 'Reach the element through bind:this, an action or an exported method (docs/frontend-code.md §4).';

export default defineConfig(
  { ignores: ['web/app/public/**'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  svelte.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        project: './tsconfig.svelte.json',
        tsconfigRootDir: root,
        extraFileExtensions: ['.svelte'],
      },
    },
  },
  {
    // A component's script, and the runes' modules: TypeScript under Svelte's parser.
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    rules: {
      // The rules of thumb (docs/frontend-code.md): size, complexity, casts, promises, defaults, keys, the DOM.
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 15],
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'allow-as-parameter' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      'svelte/require-each-key': 'error',
      'svelte/no-dom-manipulating': 'error',
      'svelte/no-at-html-tags': 'error',

      // Taste that fights the code's established style, tuned out (docs/frontend-code.md §7 lists them).
      // `type X = {…}` is the codebase's way to write an object type.
      '@typescript-eslint/consistent-type-definitions': 'off',
      // An index signature or a Record, whichever reads better at the place.
      '@typescript-eslint/consistent-indexed-object-style': 'off',
      // A number or a boolean in a template literal (a key, a size, a flag in a message) is meant.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      // `() => f()` for a handler and `return f()` to leave a function that returns nothing (async ones too) are the
      // codebase's idiom.
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  {
    // Components reach their elements through bind:this, actions and callbacks (§4), never by querying the document.
    files: ['**/*.svelte'],
    rules: {
      'no-restricted-properties': ['error', { object: 'document', property: 'getElementById', message: REACH }],
      'no-restricted-syntax': [
        'error',
        { selector: 'CallExpression[callee.property.name=/^querySelector(All)?$/]', message: REACH },
      ],
    },
  },
);
