// Preloaded by the linters (`node --import ./tools/lint/ts6.ts`, package.json's `lint`): `typescript` is this
// package's TypeScript 6 wherever it is imported or required from. The root's TypeScript 7 has no compiler API, and
// the plugins load `typescript` from the working directory (eslint-plugin-svelte) or from where they are.
import { createRequire, registerHooks } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const main = pathToFileURL(require.resolve('typescript')).href;
const dir = pathToFileURL(dirname(require.resolve('typescript/package.json'))).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'typescript') return { url: main, format: 'commonjs', shortCircuit: true };
    if (specifier.startsWith('typescript/')) return next(`${dir}/${specifier.slice('typescript/'.length)}`, context);
    return next(specifier, context);
  },
});
