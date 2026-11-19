// Flags a snapshot file as a template (docs/devices.md "A template's identity"): a snapshot every visitor restores the
// same, as a demo image's is, whose restore has the guest's agent make the guest's identity its own (the kernel's
// entropy, /etc/machine-id, systemd's random seed, the SSH host keys). An internal tool for making demo images and
// their snapshots: the page never sets the flag (its own snapshots keep their identity), and doesn't show it.
// `--deflate` also packs its frames again with raw deflate where that's smaller (web/snapshot-file.ts `repackFrames`:
// a template's download ~35% smaller than LZ4's; docs/platform.md "The snapshot file"), through the built core's
// miniz_oxide (target/wasm32-unknown-unknown/release/waarm64_core.wasm, or `--core <wasm>`).
//   node tools/snapshot-template.ts <snapshot> <out> [--off] [--deflate] [--core <wasm>]    (--off: the flag dropped)
import { openAsBlob, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { deflateCodec, lzCodec } from '../web/lz.ts';
import { asTemplate, repackFrames } from '../web/snapshot-file.ts';

const args = process.argv.slice(2);
const flag = (f: string) => (args.includes(f) ? (args.splice(args.indexOf(f), 1), true) : false);
const core = args.includes('--core') ? args.splice(args.indexOf('--core'), 2)[1] : new URL('../target/wasm32-unknown-unknown/release/waarm64_core.wasm', import.meta.url).pathname;
const off = flag('--off');
const deflate = flag('--deflate');
const [input, out] = args;
if (!input || !out || input === out) throw new Error('usage: node tools/snapshot-template.ts <snapshot> <out> [--off] [--deflate] [--core <wasm>] (out is another file)');
let blob = await asTemplate(await openAsBlob(input), !off);
if (deflate) {
  const wasm = await WebAssembly.compile(readFileSync(core));
  blob = await repackFrames(blob, await lzCodec(wasm), await deflateCodec(wasm));
}
await writeFile(out, blob.stream());
console.log(`${out}: ${off ? 'not a template' : 'a template'}${deflate ? ', its frames deflated' : ''} (${blob.size} bytes)`);
