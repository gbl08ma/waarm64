// Ad-hoc: a snapshot's DISK frames alone, in a snapshot file of their own (the harness's input): node extract.ts <in> <out>
import { openReadStream } from '../../../../snapz/fsread.ts';
import { openSnapshot, SnapshotWriter } from '../../../../../web/snapshot-file.ts';
import { lzCodec } from '../../../../../web/lz.ts';
import { readFileSync, writeFileSync } from 'node:fs';
const [inp, outp] = process.argv.slice(2);
const codec = await lzCodec(readFileSync(new URL('../../../../../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url)));
const s = await openSnapshot(openReadStream(inp), { codec });
const parts: Uint8Array[] = [];
const disks = (s.header.disks as { slot: number; size: number; blocks: number }[]).filter((d) => d.blocks > 0);
const w = new SnapshotWriter((b) => { parts.push(b.slice()); }, { ...s.header, disks }, { codec, concurrency: 1 });
await w.bytes('CORE', new Uint8Array(1));
await w.bytes('DEVS', new Uint8Array(1));
const blocks: { block: number; data: Uint8Array }[] = [];
for await (const f of s.frames()) {
  if (f.tag !== 'DISK') continue;
  for (let k = 0; k < f.data.length / 4096; k++) blocks.push({ block: f.index + k, data: f.data.slice(k * 4096, (k + 1) * 4096) });
}
await w.disk(blocks);
await w.end();
writeFileSync(outp, Buffer.concat(parts));
console.log(JSON.stringify({ disks, blocks: blocks.length }));
