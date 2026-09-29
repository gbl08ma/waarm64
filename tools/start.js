// `npm start` (M8 loop 5; docs/frontend.md "npm start"): from a fresh clone to the page's URL.
// Plain JavaScript so that an older Node says what's wrong instead of failing to load
// TypeScript; the work is in start.ts.
const want = 26;
const major = Number(process.versions.node.split('.')[0]);
if (major < want) {
  console.error(`webpc needs Node ${want} or newer (package.json "engines"), and this is Node ${process.versions.node}.\n` +
    `Install it from https://nodejs.org/ (or with a version manager, e.g. \`nvm install ${want}\`), then run \`npm start\` again.`);
  process.exit(1);
}
import('./start.ts').then((m) => m.start()).catch((e) => { console.error(e); process.exit(1); });
