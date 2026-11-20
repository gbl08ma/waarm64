// ESLint over the page's code (web/app/**; docs/frontend-code.md §7) and the host's (web/*.ts: the devices, workers and
// renderers; docs/host-code.md), not the core: typescript-eslint's strict and stylistic type-checked sets, with the
// rules of thumb that can be checked; eslint-plugin-svelte's recommended set for the page. The page's rules of size
// and style don't reach the host's code, where performance rules (docs/host-code.md "The linters"). `npm run lint`
// runs it from the repository's root, the base of the paths below, under ./ts6.ts. What fails today is grandfathered
// in ./eslint-suppressions.json, which only shrinks: the lint fails on a new violation and on a suppression that no
// longer matches one.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const REACH = 'Reach the element through bind:this, an action or an exported method (docs/frontend-code.md §4).';
const PAGE = ['web/app/**'];
const HOST = ['web/*.ts'];

export default defineConfig(
  { ignores: ['web/app/public/**'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    rules: {
      // Both: promises, defaults, empty blocks.
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',

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
    files: PAGE,
    extends: [svelte.configs.recommended],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        project: './tsconfig.svelte.json',
        tsconfigRootDir: root,
        extraFileExtensions: ['.svelte'],
      },
    },
    rules: {
      // The rules of thumb (docs/frontend-code.md): size, complexity, casts, keys, the DOM.
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 15],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'allow-as-parameter' },
      ],
      'svelte/require-each-key': 'error',
      'svelte/no-dom-manipulating': 'error',
      'svelte/no-at-html-tags': 'error',
      // A key dropped by destructuring its rest (`const { id: _, ...rest } = x`) is the codebase's way to omit one.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    // A component's script, and the runes' modules: TypeScript under Svelte's parser.
    files: ['web/app/**/*.svelte', 'web/app/**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    // Components reach their elements through bind:this, actions and callbacks (§4), never by querying the document.
    files: ['web/app/**/*.svelte'],
    rules: {
      'no-restricted-properties': ['error', { object: 'document', property: 'getElementById', message: REACH }],
      'no-restricted-syntax': [
        'error',
        { selector: 'CallExpression[callee.property.name=/^querySelector(All)?$/]', message: REACH },
      ],
    },
  },
  {
    // The host's code (docs/host-code.md "The linters"): correctness, not size; what a hot path needs is allowed.
    files: HOST,
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker },
      parserOptions: { project: './tsconfig.host.json', tsconfigRootDir: root },
    },
    rules: {
      // `!` states what a parsed structure or a protocol guarantees, where a check would cost a branch for nothing.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
      // An index loop is the hot path's loop (a typed array, a subrange, a stride); `for…of` where it reads better.
      '@typescript-eslint/prefer-for-of': 'off',
      // An interface's async method (a backend's `flush`, a source's `read`) may have nothing to wait for.
      '@typescript-eslint/require-await': 'off',
      // `a && f()` and `c ? f() : g()` as statements are the code's idiom for a guarded call.
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      // An interface's parameter a device doesn't use is named `_x`; a key dropped by a rest is the way to omit one.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // 9P's errors are `Err`s (an errno, no stack: thrown on paths as common as a lookup that misses).
      '@typescript-eslint/only-throw-error': ['error', { allow: [{ from: 'file', name: 'Err', path: 'web/9p.ts' }] }],
    },
  },
);
