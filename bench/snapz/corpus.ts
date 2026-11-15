// Ad-hoc: a snapshot file's frames, unpacked, as a corpus for the codec bench:
//   node corpus.ts <in.waarm64snap> <out.bin>
// out = (u8 tag: 0 RAM, 1 DISK, 2 other) u32 len, bytes ... ; prints a summary.
import { openReadStream } from './fsread.ts';
import { openSnapshot } from '../../web/snapshot-file.ts';
import { lzCodec } from '../../web/lz.ts';
import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';

const [inp, outp] = process.argv.slice(2);
const codec = await lzCodec(readFileSync(new URL('../../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url)));
const s = await openSnapshot(openReadStream(inp), { codec });
const fd = openSync(outp, 'w');
const sum: Record<string, { frames: number; bytes: number }> = {};
for await (const f of s.frames()) {
  const k = (sum[f.tag] ??= { frames: 0, bytes: 0 });
  k.frames++;
  k.bytes += f.data.length;
  const head = Buffer.alloc(5);
  head[0] = f.tag === 'RAM ' ? 0 : f.tag === 'DISK' ? 1 : 2;
  head.writeUInt32LE(f.data.length, 1);
  writeSync(fd, head);
  writeSync(fd, f.data);
}
closeSync(fd);
console.log(JSON.stringify({ header: { ramSize: s.header.ramSize, disks: s.header.disks }, sum }, null, 1));
