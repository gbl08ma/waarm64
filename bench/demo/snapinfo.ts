// What a snapshot file's bytes are (bench/demo/REPORT.md "DEMO loop 1", decision 18): its frames by tag (the core's
// state, the devices', the RAM, the overlays' blocks: web/snapshot-file.ts's format), raw and as stored, and its header's
// pins (each disk's overlay blocks). Run as a tool it prints the JSON:
//   node bench/demo/snapinfo.ts <snapshot>
import { closeSync, openSync, readSync, statSync } from 'node:fs';

export type SnapInfo = {
  bytes: number;
  header: number;
  /** By tag ("CORE", "DEVS", "RAM ", "DISK", "BLOB", "END "): frames, raw bytes, bytes in the file (frame headers included). */
  tags: Record<string, { frames: number; raw: number; stored: number }>;
  /** The header's pins: slot, the overlay's blocks in the file, the overlay pinned. */
  pins: { slot: number; blocks: number; overlay?: string; generation?: number }[];
  template: boolean;
};

export function snapInfo(path: string): SnapInfo {
  const fd = openSync(path, 'r');
  const bytes = statSync(path).size;
  const read = (at: number, n: number) => {
    const b = Buffer.alloc(n);
    readSync(fd, b, 0, n, at);
    return b;
  };
  try {
    const fixed = read(0, 16);
    if (fixed.subarray(0, 8).toString('latin1') !== 'WAARMSNP') throw new Error(`${path}: not a snapshot`);
    const len = fixed.readUInt32LE(12);
    const header = JSON.parse(read(16, len).toString('utf8')) as { disks?: SnapInfo['pins']; template?: boolean };
    const tags: SnapInfo['tags'] = {};
    for (let at = 20 + len; at + 32 <= bytes; ) {
      const h = read(at, 32);
      const tag = h.subarray(0, 4).toString('latin1');
      const raw = h.readUInt32LE(16);
      const stored = h.readUInt32LE(20);
      const t = (tags[tag] ??= { frames: 0, raw: 0, stored: 0 });
      t.frames++;
      t.raw += raw;
      t.stored += 32 + stored;
      at += 32 + stored;
      if (tag === 'END ') break;
    }
    const pins = (header.disks ?? []).map((p) => ({ slot: p.slot, blocks: p.blocks, overlay: p.overlay, generation: p.generation }));
    return { bytes, header: 20 + len, tags, pins, template: !!header.template };
  } finally {
    closeSync(fd);
  }
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error('usage: node bench/demo/snapinfo.ts <snapshot>');
  console.log(JSON.stringify(snapInfo(path), null, 1));
}
