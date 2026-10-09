// Captures a virgl trace (web/virgl-trace.ts) of glcomp on `alpine-virgl` under the JIT in Node: the guest's 3D
// commands with the staging bytes they upload, for the renderer's tests (tests/virgl/). The device runs the null
// renderer, so the trace is what the guest sends whatever the host draws. Needs `images/build.sh alpine-gl alpine-virgl`.
// With `--llvmpipe` it runs glcomp on llvmpipe instead (no virgl) and writes the last frame's pixels (glcomp's dump,
// rows bottom-up, RGBA) to <out>: the reference a replay's pixels are compared with.
//   node tools/virgl-capture.ts [--llvmpipe] <out> [frames] [quads] [width] [height]
import { readFileSync, writeFileSync } from 'node:fs';
import { MessageChannel } from 'node:worker_threads';
import { DISTROS, guestDevices, runToPowerOff } from '../web/vm.ts';
import { encodeTrace, encodeRecord } from '../web/virgl-trace.ts';

const args = process.argv.slice(2);
const llvmpipe = args[0] === '--llvmpipe';
if (llvmpipe) args.shift();
const [out, frames = '3', quads = '3', width = '256', height = '192'] = args;
if (!out) throw new Error('usage: node tools/virgl-capture.ts <out.vglt> [frames] [quads] [width] [height]');
const WASM = readFileSync(new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url));
const IMAGES = new URL('../target/images/', import.meta.url);
const a = DISTROS.alpine;
const records: Uint8Array[] = [];
const port = new MessageChannel();
port.port1.on('message', (m: { type: string; record: Uint8Array }) => { if (m.type === 'capture') records.push(new Uint8Array(m.record)); });
const gpu = { type: 'gpu' as const, width: 1024, height: 768, virgl: true, capture: true, port: port.port2 as unknown as MessagePort };
const devices = [...guestDevices(new URL('alpine-virgl/rootfs-virgl.ext4', IMAGES).href), ...(llvmpipe ? [] : [gpu])];
const cmdline = `${a.cmdline} webpc.gl=${frames},${quads},${width},${height} webpc.lp=0${llvmpipe ? ' webpc.gldump=1' : ' webpc.gpu=1'}`;
const r = await runToPowerOff(WASM, { ramSize: 1 << 30, kernel: readFileSync(new URL(a.kernel, IMAGES)), initrd: readFileSync(new URL(a.initrd, IMAGES)), cmdline, devices, jit: 1 }, 60e9);
await new Promise((res) => setTimeout(res, 200)); // the port's last messages
port.port1.close();
const lines = r.console.split('\n').filter((l) => /glcomp/.test(l));
console.log(lines.filter((l) => !/ px /.test(l)).join('\n'));
if (llvmpipe) {
  const rows = lines.map((l) => /glcomp: px (\d+) ([0-9a-f]+)/.exec(l)).filter((m) => m !== null);
  if (rows.length !== Number(height)) throw new Error(`glcomp printed ${rows.length} rows of ${height}`);
  writeFileSync(out, Buffer.concat(rows.map((m) => Buffer.from(m![2], 'hex'))));
  console.log(`${out}: ${width}x${height} RGBA from llvmpipe`);
  process.exit(0);
}
const trace = encodeTrace([encodeRecord({ kind: 'note', text: `glcomp ${frames} ${quads} ${width} ${height}: ${lines.find((l) => /check/.test(l)) ?? ''}` }), ...records]);
writeFileSync(out, trace);
console.log(`${out}: ${records.length} records, ${trace.length} bytes; steps ${r.steps}, ${Math.round(r.ms)} ms`);
