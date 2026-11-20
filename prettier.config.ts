// The repository's Prettier options are tools/lint/prettier.config.ts's (`npm run format`, `npm run lint:format`):
// re-exported here, where a bare `prettier` looks, so a run without `--config` formats as the lint checks (it found no
// config and wrapped the files at 80 columns, and objects stay expanded once wrapped).
export { default } from './tools/lint/prettier.config.ts';
