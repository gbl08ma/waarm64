// Joins single-round probe results into one file per arm and guest: node merge.ts <out.json> <in.json>...
import { readFileSync, writeFileSync } from 'node:fs';
const [out, ...ins] = process.argv.slice(2);
const rs = ins.map((f) => JSON.parse(readFileSync(f, 'utf8')));
writeFileSync(out, JSON.stringify({ meta: { ...rs[0].meta, rounds: rs.length, parts: rs.map((r) => ({ date: r.meta.date, core: r.meta.core, commit: r.meta.commit })) }, rounds: rs.flatMap((r) => r.rounds) }, null, 1) + '\n');
