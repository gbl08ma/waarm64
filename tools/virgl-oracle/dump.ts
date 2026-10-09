// Reads a capture of the virgl oracle (capture.sh; the records of capture.patch: {u32 kind, u32 bytes, payload},
// kinds 1 submit {ctx, dwords}, 2 resource create (virgl_renderer_resource_create_args), 3/4 transfer write/read
// {handle, ctx, level, stride, layer_stride, box x y z w h d, offset}, 5 caps {set, version, blob}) and prints a
// summary: the commands by name (web/virgl.ts), resources, transfers, capsets.
//   node tools/virgl-oracle/dump.ts <file.dump> [--res] [--caps <prefix>]   (--caps: <prefix>.<set>.<version>.bin, and decoded)
import { readFileSync, writeFileSync } from 'node:fs';
import { decodeCaps, VirglStats } from '../../web/virgl.ts';

const [file, ...rest] = process.argv.slice(2);
const buf = readFileSync(file);
const stats = new VirglStats();
const res: number[][] = [];
let tw = 0, tr = 0, twBytes = 0, trBytes = 0;
const caps: { set: number; version: number; blob: Buffer }[] = [];
for (let at = 0; at + 8 <= buf.length;) {
  const kind = buf.readUInt32LE(at), len = buf.readUInt32LE(at + 4);
  const p = buf.subarray(at + 8, at + 8 + len);
  at += 8 + len;
  const u = new Uint32Array(p.buffer.slice(p.byteOffset, p.byteOffset + len));
  if (kind === 1) stats.count(u.subarray(1));
  else if (kind === 2) res.push([...u]);
  else if (kind === 3) { tw++; twBytes += u[8] * u[9] * u[10]; }
  else if (kind === 4) { tr++; trBytes += u[8] * u[9] * u[10]; }
  else if (kind === 5) caps.push({ set: u[0], version: u[1], blob: Buffer.from(p.subarray(8)) });
}
console.log(JSON.stringify({ ...stats.json(), resources: res.length, transfersIn: tw, transferInPixels: twBytes, transfersOut: tr, transferOutPixels: trBytes, caps: caps.map((c) => [c.set, c.version, c.blob.length]) }, null, 1));
if (rest.includes('--res')) for (const r of res) console.log('handle target format bind w h d array last nr flags:', r.join(' '));
const at = rest.indexOf('--caps');
if (at >= 0) for (const c of caps) {
  writeFileSync(`${rest[at + 1]}.${c.set}.${c.version}.bin`, c.blob);
  console.log(`capset ${c.set} v${c.version}:`, JSON.stringify(decodeCaps(c.blob)));
}
