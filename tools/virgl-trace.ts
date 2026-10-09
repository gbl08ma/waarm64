// Summarizes a virgl trace (web/virgl-trace.ts): the control commands, the data records, the stream's commands.
//   node tools/virgl-trace.ts <trace.vglt> [--commands]
import { readFileSync } from 'node:fs';
import { VirglStats, commandName, walk } from '../web/virgl.ts';
import { readTrace } from '../web/virgl-trace.ts';

const [file, flag] = process.argv.slice(2);
const NAMES: Record<number, string> = { 0x106: 'ATTACH_BACKING', 0x107: 'DETACH_BACKING', 0x102: 'UNREF', 0x103: 'SET_SCANOUT', 0x104: 'FLUSH', 0x109: 'GET_CAPSET', 0x200: 'CTX_CREATE', 0x201: 'CTX_DESTROY', 0x202: 'CTX_ATTACH', 0x203: 'CTX_DETACH', 0x204: 'CREATE_3D', 0x205: 'TO_HOST_3D', 0x206: 'FROM_HOST_3D', 0x207: 'SUBMIT_3D' };
const stats = new VirglStats();
const control: Record<string, number> = {};
let data = 0, dataBytes = 0;
for (const r of readTrace(new Uint8Array(readFileSync(file)))) {
  if (r.kind === 'note') console.log('note:', r.text);
  else if (r.kind === 'data') { data++; dataBytes += r.bytes.length; if (flag) console.log(`  data res ${r.res} +${r.offset} ${r.bytes.length}`); }
  else {
    const v = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.length);
    const type = v.getUint32(0, true), name = NAMES[type] ?? type.toString(16);
    control[name] = (control[name] ?? 0) + 1;
    if (type === 0x207) {
      const words = new Uint32Array(r.bytes.slice(32, 32 + v.getUint32(24, true)).buffer);
      stats.count(words);
      if (flag) walk(words, (c, o, _at, len) => console.log(`    ${commandName(c, o)} ${len}`));
    } else if (flag) console.log(name, [...new Uint32Array(r.bytes.slice(24, Math.min(r.bytes.length, 72)).buffer)].join(' '));
  }
}
console.log('control:', JSON.stringify(control));
console.log(`data: ${data} records, ${dataBytes} bytes`);
console.log('stream:', JSON.stringify(stats.json().commands));
