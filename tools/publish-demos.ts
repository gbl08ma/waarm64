// Assembles the demos' site for disks.waarm64.com in target/disks/ (tools/demo-site.ts says what it writes and checks;
// docs/remote-disks.md "Publishing the demos"). Prints the plan (each demo, what's retired, what a deploy would drop,
// the files against the budget) and writes nothing without --apply. Deploying is deploy/disks/deploy.sh's, and only
// when the user asks.
//   node tools/publish-demos.ts [source, default deploy/disks/demos.json] [--site target/disks] [--budget 15000] [--apply]
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { applyPlan, BUDGET, describe, planSite, readSource, siteCount } from './demo-site.ts';

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: { site: { type: 'string', default: 'target/disks' }, budget: { type: 'string', default: String(BUDGET) }, apply: { type: 'boolean', default: false } },
});
const root = resolve(new URL('..', import.meta.url).pathname);
const sourceFile = resolve(root, positionals[0] ?? 'deploy/disks/demos.json');
const site = resolve(root, a.site!);
try {
  const plan = await planSite(readSource(sourceFile), { root, site, budget: Number(a.budget) });
  for (const l of describe(plan)) console.log(l);
  if (!a.apply) console.log('a dry run: nothing written (--apply writes it)');
  else {
    applyPlan(plan, site);
    console.log(`written: ${site}, ${siteCount(site)} files`);
  }
} catch (e) {
  console.error(`refused: ${(e as Error).message}`);
  process.exit(1);
}
