// The virtio-gpu backend without a guest (web/gpu.ts): commands on hand-built buffers, the
// answers the spec and QEMU give, the pixels, and a parser that survives random bytes; and the
// EDID generator (web/edid.ts) against edid-decode where it is installed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EDID_MAX, EDID_MIN, edid } from '../web/edid.ts';
import { Gpu, MAX_RESOURCE, hashRgba, type GpuHooks, type ScanoutSource } from '../web/gpu.ts';

const RAM_BASE = 0x4000_0000;
const RAM_SIZE = 1 << 20;

// Command and response types.
const T = { INFO: 0x100, CREATE: 0x101, UNREF: 0x102, SCANOUT: 0x103, FLUSH: 0x104, TRANSFER: 0x105, ATTACH: 0x106, DETACH: 0x107, EDID: 0x10a, UPDATE_CURSOR: 0x300, MOVE_CURSOR: 0x301 };
const OK = 0x1100, OK_INFO = 0x1101, OK_EDID = 0x1104, ERR_UNSPEC = 0x1200, ERR_OOM = 0x1201, ERR_SCANOUT = 0x1202, ERR_RES = 0x1203, ERR_PARAM = 0x1205;
const B8G8R8X8 = 2, B8G8R8A8 = 1, R8G8B8A8 = 67;

/** A command: header (type, flags 0, fence 0, ctx 0, ring 0) and u32 fields (a bigint is a u64). */
function cmd(type: number, ...fields: (number | bigint)[]) {
  const b = new Uint8Array(24 + fields.reduce<number>((n, f) => n + (typeof f === 'bigint' ? 8 : 4), 0));
  const v = new DataView(b.buffer);
  v.setUint32(0, type, true);
  let at = 24;
  for (const f of fields) {
    if (typeof f === 'bigint') v.setBigUint64(at, f, true), at += 8;
    else v.setUint32(at, f, true), at += 4;
  }
  return b;
}

function rig(o: Partial<ConstructorParameters<typeof Gpu>[2]> = {}) {
  const ram = new Uint8Array(RAM_SIZE);
  const damage: { x: number; y: number; w: number; h: number }[] = [];
  const scanouts: number[][] = [];
  const sources: (ScanoutSource | null)[] = [];
  const cursors: { image: Uint8Array | null; hotX: number; hotY: number; x: number; y: number }[] = [];
  const hooks: GpuHooks = {
    scanout: (w, h, src) => { scanouts.push([w, h]); sources.push(src); },
    damage: (r) => damage.push({ ...r }),
    cursor: (image, hotX, hotY, x, y) => cursors.push({ image, hotX, hotY, x, y }),
  };
  const gpu = new Gpu(() => ram, RAM_SIZE, { width: 800, height: 600, ...o });
  gpu.hooks = hooks;
  const events: number[] = [];
  gpu.raise = () => events.push(1);
  /** Runs a control command; returns the response type and the response. */
  const run = (c: Uint8Array, room = 4096) => {
    const r = gpu.control(c, room);
    return { type: r.length ? new DataView(r.buffer, r.byteOffset).getUint32(0, true) : -1, r };
  };
  const ok = (c: Uint8Array) => assert.equal(run(c).type, OK, `command ${new DataView(c.buffer).getUint32(0, true).toString(16)}`);
  /** The guest's backing: `n` bytes at RAM offset `off`, as one entry or several of `chunk` bytes. */
  const attach = (id: number, off: number, bytes: number, chunk = bytes) => {
    const n = Math.ceil(bytes / chunk);
    const head = cmd(T.ATTACH, id, n);
    const c = new Uint8Array(head.length + 16 * n);
    c.set(head);
    const v = new DataView(c.buffer);
    for (let k = 0; k < n; k++) {
      v.setBigUint64(head.length + 16 * k, BigInt(RAM_BASE + off + k * chunk), true);
      v.setUint32(head.length + 16 * k + 8, Math.min(chunk, bytes - k * chunk), true);
    }
    return c;
  };
  return { ram, gpu, run, ok, attach, damage, scanouts, sources, cursors, events };
}

const px = (r: ReturnType<typeof rig>, id: number, x: number, y: number) => {
  const res = r.gpu.resources.get(id)!;
  return [...res.pixels.subarray((y * res.width + x) * 4, (y * res.width + x) * 4 + 4)];
};

test('edid: checksum, the preferred timing is the size, edid-decode agrees', () => {
  const sizes = [[1024, 768], [1920, 1080], [2560, 1440], [3840, 2160], [801, 601], [640, 480], [EDID_MAX, EDID_MAX], [EDID_MIN.width, EDID_MIN.height]];
  const have = spawnSync('edid-decode', ['--version']).status === 0;
  for (const [w, h] of sizes) {
    const e = edid(w, h);
    assert.equal(e.length, 128);
    assert.equal(e.reduce((a, b) => a + b, 0) % 256, 0, 'checksum');
    assert.deepEqual([...e.subarray(0, 8)], [0, 255, 255, 255, 255, 255, 255, 0]);
    // The first detailed timing: active pixels and lines.
    assert.equal(e[56] | (e[58] >> 4) << 8, w);
    assert.equal(e[59] | (e[61] >> 4) << 8, h);
    assert.ok((e[54] | e[55] << 8) >= 1000, 'pixel clock of at least 10 MHz');
    assert.deepEqual([...edid(w, h)], [...e], 'deterministic');
    if (have) {
      const r = spawnSync('edid-decode', ['--check'], { input: e });
      assert.equal(r.status, 0, `edid-decode ${w}x${h}:\n${r.stdout}`);
      assert.match(String(r.stdout), /EDID conformity: PASS/);
    }
  }
  // Physical size from the DPI: 1920 px at 96 dpi is 508 mm.
  const d = edid(1920, 1080);
  assert.equal(d[66] | (d[68] >> 4) << 8, 508);
  assert.equal(edid(1920, 1080, { dpi: 192 })[66], 254);
  assert.throws(() => edid(EDID_MAX + 1, 100), RangeError);
  // A second mode as a detailed timing (what keeps a console's boot size reachable).
  const two = edid(1280, 800, { extra: [{ width: 640, height: 480 }] });
  assert.equal(two[72 + 2] | (two[72 + 4] >> 4) << 8, 640);
  if (have) assert.equal(spawnSync('edid-decode', ['--check'], { input: two }).status, 0);
});

test('gpu: display info, EDID, fences echoed', () => {
  const r = rig({ width: 1024, height: 768 });
  const info = r.run(cmd(T.INFO));
  assert.equal(info.type, OK_INFO);
  assert.equal(info.r.length, 24 + 16 * 24);
  const v = new DataView(info.r.buffer);
  assert.deepEqual([24, 28, 32, 36, 40].map((o) => v.getUint32(o, true)), [0, 0, 1024, 768, 1]);
  assert.equal(v.getUint32(24 + 24 + 16, true), 0, 'only one scanout enabled');
  const e = r.run(cmd(T.EDID, 0, 0));
  assert.equal(e.type, OK_EDID);
  assert.equal(e.r.length, 24 + 8 + 1024);
  assert.equal(new DataView(e.r.buffer).getUint32(24, true), 128);
  assert.deepEqual([...e.r.subarray(32, 32 + 128)], [...edid(1024, 768)]);
  assert.equal(r.run(cmd(T.EDID, 1, 0)).type, ERR_PARAM, 'no second scanout');
  // A fenced command: the flag, the fence id and the context come back on the response.
  const c = cmd(T.INFO);
  const cv = new DataView(c.buffer);
  cv.setUint32(4, 1, true);
  cv.setBigUint64(8, 0x1234_5678_9abcn, true);
  cv.setUint32(16, 7, true);
  const f = new DataView(r.run(c).r.buffer);
  assert.deepEqual([f.getUint32(4, true), f.getBigUint64(8, true), f.getUint32(16, true)], [1, 0x1234_5678_9abcn, 7]);
  // Not fenced: a clean header.
  assert.equal(new DataView(r.run(cmd(T.INFO)).r.buffer).getBigUint64(8, true), 0n);
  // Too little room for the answer: nothing is written.
  assert.equal(r.run(cmd(T.INFO), 100).type, -1);
});

test('gpu: a resource, its backing, a transfer into RGBA, flush and scanout', () => {
  const r = rig();
  // A 4×3 B8G8R8X8 resource whose backing is 3 pages' worth of chunks (16 bytes: the rows are 16 bytes).
  r.ok(cmd(T.CREATE, 1, B8G8R8X8, 4, 3));
  r.ok(r.attach(1, 0x1000, 48, 20)); // chunks of 20 bytes: rows straddle them
  for (let k = 0; k < 48; k++) r.ram[0x1000 + k] = k + 1;
  // Nothing on the scanout yet: a flush draws nothing.
  r.ok(cmd(T.SCANOUT, 0, 0, 4, 3, 0, 1));
  assert.deepEqual(r.scanouts, [[4, 3]]);
  r.damage.length = 0;
  r.ok(cmd(T.TRANSFER, 0, 0, 4, 3, 0n, 1, 0));
  // B,G,R,X bytes 1,2,3,4 are RGBA 3,2,1; the X byte would be alpha, but this resource is on the scanout.
  assert.deepEqual(px(r, 1, 0, 0), [3, 2, 1, 255], 'on the scanout: opaque');
  assert.deepEqual(px(r, 1, 3, 2), [47, 46, 45, 255]);
  assert.deepEqual(r.damage.map((d) => [d.x, d.y, d.w, d.h]), [[0, 0, 4, 3]]);
  // A rectangle in the middle: the offset is where its first pixel is in the guest's layout (y*stride + x*4).
  r.ram.fill(0xee, 0x1000, 48);
  r.ram.set([10, 20, 30, 0], 0x1000 + 1 * 16 + 1 * 4); // pixel (1,1)
  r.damage.length = 0;
  r.ok(cmd(T.TRANSFER, 1, 1, 1, 1, BigInt(1 * 16 + 1 * 4), 1, 0));
  assert.deepEqual(px(r, 1, 1, 1), [30, 20, 10, 255]);
  assert.deepEqual(px(r, 1, 0, 1), [19, 18, 17, 255], 'a neighbor is untouched');
  assert.deepEqual(r.damage.map((d) => [d.x, d.y, d.w, d.h]), [[1, 1, 1, 1]]);
  // Several rows of a narrower rectangle: the guest's rows are a resource-width apart, not the rectangle's.
  r.ram.fill(0, 0x1000, 48);
  for (const [x, y, b] of [[1, 1, 1], [2, 1, 2], [1, 2, 3], [2, 2, 4]]) r.ram.set([b, b, b, 0], 0x1000 + y * 16 + x * 4);
  r.ok(cmd(T.TRANSFER, 1, 1, 2, 2, BigInt(1 * 16 + 1 * 4), 1, 0));
  assert.deepEqual([px(r, 1, 1, 1)[0], px(r, 1, 2, 1)[0], px(r, 1, 1, 2)[0], px(r, 1, 2, 2)[0]], [1, 2, 3, 4]);
  // A flush of a rectangle outside the scanout resource's size is refused; inside, it's damage.
  r.damage.length = 0;
  assert.equal(r.run(cmd(T.FLUSH, 0, 0, 5, 3, 1, 0)).type, ERR_PARAM);
  r.ok(cmd(T.FLUSH, 2, 1, 2, 2, 1, 0));
  assert.deepEqual(r.damage.map((d) => [d.x, d.y, d.w, d.h]), [[2, 1, 2, 2]]);
  // The scanout can show part of a resource: the damage is clipped to it and moved to its origin.
  r.ok(cmd(T.SCANOUT, 1, 1, 2, 2, 0, 1));
  assert.deepEqual(r.scanouts.at(-1), [2, 2]);
  assert.deepEqual([r.sources.at(-1)!.x, r.sources.at(-1)!.y, r.sources.at(-1)!.width, r.sources.at(-1)!.height], [1, 1, 4, 3]);
  assert.equal(r.sources.at(-1)!.pixels, r.gpu.resources.get(1)!.pixels, 'the source is the resource itself: no copy');
  r.damage.length = 0;
  r.ok(cmd(T.FLUSH, 0, 0, 4, 3, 1, 0));
  assert.deepEqual(r.damage.map((d) => [d.x, d.y, d.w, d.h]), [[0, 0, 2, 2]]);
  r.damage.length = 0;
  r.ok(cmd(T.FLUSH, 3, 2, 1, 1, 1, 0));
  assert.deepEqual(r.damage, [], 'outside the scanout rectangle');
  // Unref of the scanout's resource turns the scanout off.
  r.ok(cmd(T.UNREF, 1, 0));
  assert.deepEqual(r.scanouts.at(-1), [0, 0]);
  assert.equal(r.run(cmd(T.UNREF, 1, 0)).type, ERR_RES);
});

test('gpu: every 32-bit format reads its bytes in order', () => {
  // The memory order of each format, as RGBA of (r, g, b, a) = (10, 20, 30, 40); an X format's unused byte
  // (40 here) stays as alpha: a cursor on a dumb buffer (always B8G8R8X8 in Linux) carries its alpha there.
  const cases: [number, number[], number][] = [
    [1, [30, 20, 10, 40], 40], [2, [30, 20, 10, 40], 40], [3, [40, 10, 20, 30], 40], [4, [40, 10, 20, 30], 40],
    [67, [10, 20, 30, 40], 40], [68, [40, 30, 20, 10], 40], [121, [40, 30, 20, 10], 40], [134, [10, 20, 30, 40], 40],
  ];
  for (const [format, bytes, alpha] of cases) {
    const r = rig();
    r.ok(cmd(T.CREATE, 1, format, 1, 1));
    r.ok(r.attach(1, 0, 4));
    r.ram.set(bytes, 0);
    r.ok(cmd(T.TRANSFER, 0, 0, 1, 1, 0n, 1, 0));
    assert.deepEqual(px(r, 1, 0, 0), [10, 20, 30, alpha], `format ${format}`);
  }
  const r = rig();
  assert.equal(r.run(cmd(T.CREATE, 1, 99, 1, 1)).type, ERR_PARAM, 'unknown format');
});

test('gpu: errors, as the spec and QEMU have them', () => {
  const r = rig();
  assert.equal(r.run(cmd(T.CREATE, 0, B8G8R8X8, 4, 4)).type, ERR_RES, 'resource 0');
  r.ok(cmd(T.CREATE, 1, B8G8R8X8, 4, 4));
  assert.equal(r.run(cmd(T.CREATE, 1, B8G8R8X8, 4, 4)).type, ERR_RES, 'duplicate');
  assert.equal(r.run(cmd(T.CREATE, 2, B8G8R8X8, 0, 4)).type, ERR_PARAM, 'zero width');
  assert.equal(r.run(cmd(T.CREATE, 2, B8G8R8X8, 0xffff_ffff, 0xffff_ffff)).type, ERR_OOM, 'huge');
  assert.equal(r.run(cmd(T.CREATE, 2, B8G8R8X8, 4096, 4097)).type, ERR_OOM, 'over the resource limit');
  assert.ok(4096 * 4096 * 4 <= MAX_RESOURCE);
  // Backing: unknown resource, no entries, entries past the command, entries outside RAM, twice.
  assert.equal(r.run(r.attach(9, 0, 64)).type, ERR_RES);
  assert.equal(r.run(cmd(T.ATTACH, 1, 0)).type, ERR_PARAM);
  assert.equal(r.run(cmd(T.ATTACH, 1, 5)).type, ERR_PARAM, 'five entries announced, none there');
  assert.equal(r.run(cmd(T.ATTACH, 1, 1_000_000)).type, ERR_PARAM);
  const out = (addr: bigint, len: number) => {
    const c = cmd(T.ATTACH, 1, 1, addr, len, 0);
    return r.run(c).type;
  };
  assert.equal(out(0n, 64), ERR_PARAM, 'below RAM');
  assert.equal(out(BigInt(RAM_BASE + RAM_SIZE), 64), ERR_PARAM, 'at the end of RAM');
  assert.equal(out(BigInt(RAM_BASE + RAM_SIZE - 32), 64), ERR_PARAM, 'crossing the end');
  assert.equal(out(0xffff_ffff_ffff_fff0n, 64), ERR_PARAM, 'wrapping');
  assert.equal(out(BigInt(RAM_BASE), 0xffff_ffff), ERR_PARAM, 'longer than RAM');
  assert.equal(r.gpu.resources.get(1)!.backing, null, 'a refused attach leaves none');
  assert.equal(r.run(cmd(T.TRANSFER, 0, 0, 1, 1, 0n, 1, 0)).type, ERR_UNSPEC, 'a transfer without backing');
  r.ok(r.attach(1, 0, 64));
  assert.equal(r.run(r.attach(1, 0, 64)).type, ERR_UNSPEC, 'attached twice');
  // Transfers: unknown resource, rectangle outside, backing too short for the rows.
  assert.equal(r.run(cmd(T.TRANSFER, 0, 0, 1, 1, 0n, 7, 0)).type, ERR_RES);
  assert.equal(r.run(cmd(T.TRANSFER, 2, 0, 3, 1, 0n, 1, 0)).type, ERR_PARAM, 'past the width');
  assert.equal(r.run(cmd(T.TRANSFER, 0xffff_ffff, 0, 2, 1, 0n, 1, 0)).type, ERR_PARAM, 'overflowing x + w');
  assert.equal(r.run(cmd(T.TRANSFER, 0, 0, 4, 4, 16n, 1, 0)).type, ERR_PARAM, 'rows run past the backing');
  assert.equal(r.run(cmd(T.TRANSFER, 0, 0, 4, 4, 0xffff_ffff_ffff_fff0n, 1, 0)).type, ERR_PARAM, 'offset far past');
  r.ok(cmd(T.TRANSFER, 0, 0, 0, 0, 0n, 1, 0)); // empty: fine
  // Scanout: only 0 exists; the resource and rectangle must exist and fit.
  assert.equal(r.run(cmd(T.SCANOUT, 0, 0, 4, 4, 1, 1)).type, ERR_SCANOUT);
  assert.equal(r.run(cmd(T.SCANOUT, 0, 0, 4, 4, 0, 9)).type, ERR_RES);
  assert.equal(r.run(cmd(T.SCANOUT, 0, 0, 5, 4, 0, 1)).type, ERR_PARAM);
  r.ok(cmd(T.SCANOUT, 0, 0, 4, 4, 0, 1));
  r.ok(cmd(T.SCANOUT, 0, 0, 0, 0, 0, 0));
  assert.deepEqual(r.scanouts.at(-1), [0, 0]);
  // Flush of an unknown resource; detach of one; a command we don't have; a short command; a short header.
  assert.equal(r.run(cmd(T.FLUSH, 0, 0, 1, 1, 9, 0)).type, ERR_RES);
  assert.equal(r.run(cmd(T.DETACH, 9, 0)).type, ERR_RES);
  r.ok(cmd(T.DETACH, 1, 0));
  assert.equal(r.gpu.resources.get(1)!.backing, null);
  assert.equal(r.run(cmd(0x200)).type, ERR_UNSPEC, '3D: not here');
  assert.equal(r.run(cmd(T.CREATE, 3, B8G8R8X8)).type, ERR_UNSPEC, 'short');
  assert.equal(r.run(new Uint8Array(10)).type, ERR_UNSPEC, 'shorter than a header');
});

test('gpu: the resource budget is kept across unref and reset', () => {
  const r = rig();
  const big = (id: number) => r.run(cmd(T.CREATE, id, B8G8R8X8, 4096, 4096)).type;
  assert.deepEqual([1, 2, 3, 4].map(big), [OK, OK, OK, OK], '4 × 64 MiB is the limit');
  assert.equal(big(5), ERR_OOM);
  r.ok(cmd(T.UNREF, 2, 0));
  assert.equal(big(5), OK, 'unref gives the budget back');
  assert.equal(big(6), ERR_OOM);
  r.gpu.reset();
  assert.equal(r.gpu.resources.size, 0);
  assert.equal(big(6), OK, 'so does a reset');
});

test('gpu: the cursor', () => {
  const r = rig();
  r.ok(cmd(T.CREATE, 5, B8G8R8A8, 64, 64));
  r.ok(r.attach(5, 0, 64 * 64 * 4));
  for (let k = 0; k < 64 * 64; k++) r.ram.set([1, 2, 3, 4], 4 * k); // B, G, R, A
  r.ram.set([9, 9, 9, 255], 0);
  r.ok(cmd(T.TRANSFER, 0, 0, 64, 64, 0n, 5, 0));
  const cur = (type: number, x: number, y: number, id = 0, hx = 0, hy = 0) => r.gpu.cursor(cmd(type, 0, x, y, 0, id, hx, hy, 0));
  cur(T.UPDATE_CURSOR, 100, 50, 5, 3, 4);
  const c = r.cursors.at(-1)!;
  assert.deepEqual([c.hotX, c.hotY, c.x, c.y], [3, 4, 100, 50]);
  assert.deepEqual([...c.image!.subarray(0, 8)], [9, 9, 9, 255, 3, 2, 1, 4]);
  // A move changes only the position; the image is the one at the update (a later transfer doesn't reach it).
  r.ram.fill(0, 0, 16);
  r.ok(cmd(T.TRANSFER, 0, 0, 64, 64, 0n, 5, 0));
  cur(T.MOVE_CURSOR, 7, 8);
  const m = r.cursors.at(-1)!;
  assert.deepEqual([m.hotX, m.hotY, m.x, m.y], [3, 4, 7, 8]);
  assert.deepEqual([...m.image!.subarray(0, 4)], [9, 9, 9, 255]);
  // A new update takes the new pixels; resource 0 hides; a wrong size or unknown resource changes nothing.
  cur(T.UPDATE_CURSOR, 7, 8, 5, 3, 4);
  assert.deepEqual([...r.cursors.at(-1)!.image!.subarray(0, 4)], [0, 0, 0, 0]);
  r.ok(cmd(T.CREATE, 6, B8G8R8A8, 32, 32));
  const n = r.cursors.length;
  cur(T.UPDATE_CURSOR, 1, 1, 6);
  cur(T.UPDATE_CURSOR, 1, 1, 77);
  assert.equal(r.cursors.length, n);
  cur(T.UPDATE_CURSOR, 1, 1, 0);
  assert.equal(r.cursors.at(-1)!.image, null);
  assert.equal(r.gpu.state().cursor, null);
  r.gpu.cursor(new Uint8Array(5)); // short: ignored
  r.gpu.cursor(cmd(0x999, 0, 0, 0, 0, 0, 0, 0, 0)); // not a cursor command
  assert.equal(r.cursors.length, n + 1);
});

test('gpu: a display change raises the event, the guest clears it', async () => {
  // The backend's side: events_read bit 0 set through the config change; events_clear is write-one-to-clear.
  const { gpuBackend } = await import('../web/gpu.ts');
  const cfg = new Uint8Array(256);
  const calls: string[] = [];
  const ctx = {
    ram: () => new Uint8Array(1 << 16), ramSize: 1 << 16, complete() {}, config: () => cfg,
    changeConfig: (w: (c: Uint8Array) => void) => { calls.push('change'); w(cfg); },
  };
  const b = gpuBackend(ctx, { width: 800, height: 600, resize: { after: 2, width: 1000, height: 700 } });
  const v = new DataView(cfg.buffer);
  b.gpu.setSize(1024, 768);
  assert.deepEqual([calls.length, v.getUint32(0, true)], [1, 1]);
  assert.equal(b.gpu.size.width, 1024);
  v.setUint32(4, 2, true); // clearing a bit that isn't set changes nothing
  b.config();
  assert.equal(v.getUint32(0, true), 1);
  v.setUint32(4, 1, true);
  b.config();
  assert.deepEqual([v.getUint32(0, true), v.getUint32(4, true)], [0, 0]);
  // The test hook: the second flush changes the size.
  b.gpu.control(cmd(T.CREATE, 1, B8G8R8X8, 2, 2), 4096);
  const flush = () => b.gpu.control(cmd(T.FLUSH, 0, 0, 1, 1, 1, 0), 4096);
  flush();
  assert.equal(calls.length, 1);
  flush();
  assert.deepEqual([calls.length, v.getUint32(0, true), b.gpu.size.width, b.gpu.size.height], [2, 1, 1000, 700]);
  flush();
  assert.equal(calls.length, 2, 'once');
});

test('gpu: state saved and restored re-reads the pixels from the backing', () => {
  const a = rig();
  a.ok(cmd(T.CREATE, 1, B8G8R8X8, 8, 8));
  a.ok(a.attach(1, 0x2000, 8 * 8 * 4, 100));
  for (let k = 0; k < 256; k++) a.ram[0x2000 + k] = k;
  a.ok(cmd(T.TRANSFER, 0, 0, 8, 8, 0n, 1, 0));
  a.ok(cmd(T.SCANOUT, 0, 0, 8, 8, 0, 1));
  a.ok(cmd(T.CREATE, 2, B8G8R8A8, 64, 64));
  a.ok(cmd(T.CREATE, 3, R8G8B8A8, 2, 2)); // no backing
  a.gpu.cursor(cmd(T.UPDATE_CURSOR, 0, 5, 6, 0, 2, 1, 2, 0));
  const saved = JSON.parse(JSON.stringify(a.gpu.save()));
  assert.ok(saved.screen && saved.cursor);
  const b = rig();
  b.ram.set(a.ram);
  b.gpu.restore(saved);
  assert.deepEqual(b.gpu.state(), a.gpu.state());
  assert.deepEqual(px(b, 1, 7, 7), px(a, 1, 7, 7));
  assert.deepEqual(b.scanouts.at(-1), [8, 8]);
  assert.ok(b.damage.length > 0, 'the scanout is drawn again');
  assert.equal(b.cursors.at(-1)!.hotY, 2);
  assert.throws(() => b.gpu.restore({}), /no state for the display/);
});

test('gpu: random commands never throw, never write RAM, and answer in the spec', () => {
  // A seeded generator (mulberry32): valid commands with fields mutated or truncated, and pure noise.
  let s = 0x2545f491;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const r = rig();
  for (let k = 0; k < 256; k++) r.ram[k * 7] = k;
  const before = r.ram.slice();
  const types = [...Object.values(T), 0, 0x200, 0x108, 0x1100, 0xffff_ffff];
  const interesting = [0, 1, 2, 3, 4, 63, 64, 0xffff, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff];
  const answers = new Set([OK, OK_INFO, OK_EDID, ERR_UNSPEC, ERR_OOM, ERR_SCANOUT, ERR_RES, ERR_PARAM]);
  let oks = 0;
  for (let k = 0; k < 20000; k++) {
    let c: Uint8Array;
    if (rnd() < 0.15) c = Uint8Array.from({ length: Math.floor(rnd() * 80) }, () => Math.floor(rnd() * 256));
    else {
      const n = Math.floor(rnd() * 9);
      const fields = Array.from({ length: n }, () => (rnd() < 0.5 ? interesting[Math.floor(rnd() * interesting.length)] : Math.floor(rnd() * 16)));
      c = cmd(types[Math.floor(rnd() * types.length)], ...fields);
      if (rnd() < 0.1) c = c.subarray(0, Math.floor(rnd() * c.length));
      // Sometimes a plausible ATTACH with real entries.
      if (rnd() < 0.1) c = r.attach(1 + Math.floor(rnd() * 4), Math.floor(rnd() * 4096), Math.floor(rnd() * 3000) + 1, Math.floor(rnd() * 500) + 1);
    }
    // Resources 1..4 exist most of the time, so deeper paths run.
    if (rnd() < 0.2) r.run(cmd(T.CREATE, 1 + Math.floor(rnd() * 4), [B8G8R8X8, B8G8R8A8, R8G8B8A8][Math.floor(rnd() * 3)], 1 + Math.floor(rnd() * 40), 1 + Math.floor(rnd() * 40)));
    const out = r.run(c, rnd() < 0.1 ? Math.floor(rnd() * 60) : 4096);
    if (out.type !== -1) {
      assert.ok(answers.has(out.type), `answer ${out.type.toString(16)}`);
      if (out.type === OK) oks++;
    }
    r.gpu.cursor(c);
  }
  assert.ok(oks > 500, `the random commands got somewhere (${oks} ok)`);
  assert.equal(Buffer.compare(before, r.ram), 0, 'guest RAM unchanged');
});

test('edid: the bytes the native twin (core/tests/gpu.rs) is held to', () => {
  const want: Record<string, string> = JSON.parse(readFileSync(new URL('./gpu/edid.json', import.meta.url), 'utf8'));
  for (const [k, hex] of Object.entries(want)) {
    const m = /^(\d+)x(\d+)(?:\+(\d+)x(\d+))?(?:@(\d+)dpi)?$/.exec(k)!;
    const e = edid(+m[1], +m[2], { dpi: m[5] ? +m[5] : undefined, extra: m[3] ? [{ width: +m[3], height: +m[4] }] : [] });
    assert.equal(Buffer.from(e).toString('hex'), hex, k);
  }
});

/** The script core/tests/gpu.rs runs too: its screen and cursor hashes must be the same. */
test('gpu: the conformance script gives the hashes the native twin gives', () => {
  const r = rig();
  for (let k = 0; k < 8 * 8 * 4; k++) r.ram[0x3000 + k] = (k * 7 + 3) & 0xff;
  for (let k = 0; k < 64 * 64 * 4; k++) r.ram[0x8000 + k] = (k * 13 + k / 64) & 0xff;
  r.ok(cmd(T.CREATE, 1, B8G8R8X8, 8, 8));
  r.ok(r.attach(1, 0x3000, 256, 100));
  r.ok(cmd(T.TRANSFER, 0, 0, 8, 8, 0n, 1, 0));
  r.ok(cmd(T.SCANOUT, 1, 1, 6, 5, 0, 1));
  r.ok(cmd(T.CREATE, 2, B8G8R8A8, 64, 64));
  r.ok(r.attach(2, 0x8000, 64 * 64 * 4, 4096));
  r.ok(cmd(T.TRANSFER, 0, 0, 64, 64, 0n, 2, 0));
  r.gpu.cursor(cmd(T.UPDATE_CURSOR, 0, 11, 12, 0, 2, 5, 6, 0));
  const s = r.gpu.state();
  assert.deepEqual([s.screen, s.cursor?.hash], ['7270f777c2f4c1c5', 'e3974fc5495011dc']);
});

/** The pictures the gpu guest (images/gpu/init.c) draws, computed here from its code: what the host must show after each flush. */
function guestPictures() {
  const picture = (w: number, h: number, draw: (px: Uint32Array) => void) => {
    const px = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (0xff000000 | ((x ^ y) & 0xff) << 16 | Math.floor(y * 255 / h) << 8 | Math.floor(x * 255 / w)) >>> 0; // RGBA words
    const rect = (x0: number, y0: number, rw: number, rh: number, r: number, g: number, b: number) => {
      for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) px[y * w + x] = (0xff000000 | b << 16 | g << 8 | r) >>> 0;
    };
    void rect;
    draw(px);
    return hashRgba([px], true);
  };
  const rectOn = (w: number) => (px: Uint32Array, x0: number, y0: number, rw: number, rh: number, r: number, g: number, b: number) => {
    for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) px[y * w + x] = (0xff000000 | b << 16 | g << 8 | r) >>> 0;
  };
  const first = picture(640, 480, () => {});
  // The damaged rectangle and the bar in it; the pixel at (10, 10) was written without a DIRTYFB: not there.
  const second = picture(640, 480, (px) => {
    rectOn(640)(px, 100, 80, 200, 100, 0, 255, 0);
    rectOn(640)(px, 120, 100, 160, 8, 255, 255, 255);
  });
  const third = picture(800, 600, (px) => rectOn(800)(px, 50, 40, 100, 60, 255, 0, 0));
  // The cursor: 64×64 ARGB, as RGBA words.
  const c = new Uint32Array(64 * 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) c[y * 64 + x] = x < 32 ? (0xff000000 | (y * 4) << 16 | 0 << 8 | x * 4) >>> 0 : (((y * 4) << 24) | 0x00ffffff) >>> 0;
  return { trace: [first, second, third], cursor: hashRgba([c], false) };
}

test('the gpu guest: what init.c draws is what tests/gpu/guest.json expects (the pictures after each flush and the cursor, from first principles)', () => {
  const want = JSON.parse(readFileSync(new URL('./gpu/guest.json', import.meta.url), 'utf8')) as Record<string, string>;
  const t = guestPictures();
  assert.deepEqual([want.trace1, want.trace2, want.trace3, want.screen, want.cursor], [...t.trace, t.trace[2], t.cursor]);
});

test('gpu: alpha is the X byte until a resource is shown, then opaque (a canvas takes the pixels as they are)', () => {
  const r = rig();
  r.ok(cmd(T.CREATE, 1, B8G8R8X8, 2, 1));
  r.ok(r.attach(1, 0, 8));
  r.ram.set([1, 2, 3, 77, 4, 5, 6, 88], 0);
  r.ok(cmd(T.TRANSFER, 0, 0, 2, 1, 0n, 1, 0));
  assert.deepEqual([px(r, 1, 0, 0)[3], px(r, 1, 1, 0)[3]], [77, 88], 'a cursor-like resource keeps it');
  r.ok(cmd(T.SCANOUT, 0, 0, 2, 1, 0, 1));
  assert.deepEqual([px(r, 1, 0, 0), px(r, 1, 1, 0)], [[3, 2, 1, 255], [6, 5, 4, 255]], 'shown: opaque, colors kept');
  r.ram.set([9, 9, 9, 5, 9, 9, 9, 5], 0);
  r.ok(cmd(T.TRANSFER, 0, 0, 2, 1, 0n, 1, 0));
  assert.equal(px(r, 1, 1, 0)[3], 255);
});

test('gpu: a cropped console keeps the display from shrinking below its buffer', async () => {
  const { gpuBackend } = await import('../web/gpu.ts');
  const cfg = new Uint8Array(256);
  let events = 0;
  const ctx = { ram: () => new Uint8Array(1 << 16), ramSize: 1 << 16, complete() {}, config: () => cfg, changeConfig: (w: (c: Uint8Array) => void) => { events++; w(cfg); } };
  const b = gpuBackend(ctx, { width: 1024, height: 768, keepConsole: true });
  b.gpu.control(cmd(T.CREATE, 1, B8G8R8X8, 1024, 768), 4096);
  b.gpu.control(cmd(T.SCANOUT, 0, 0, 1024, 768, 0, 1), 4096);
  b.gpu.setSize(800, 600);
  assert.deepEqual([b.gpu.size.width, b.gpu.size.height, events], [800, 600, 1]);
  // fbcon answers with the same resource and a smaller rectangle: the display asks for the whole buffer again.
  b.gpu.control(cmd(T.SCANOUT, 0, 0, 800, 600, 0, 1), 4096);
  assert.deepEqual([b.gpu.size.width, b.gpu.size.height, events], [1024, 768, 2]);
  b.gpu.setSize(640, 480);
  assert.deepEqual([b.gpu.size.width, b.gpu.size.height], [1024, 768]);
  b.gpu.setSize(1600, 900); // growing still reaches the guest
  assert.deepEqual([b.gpu.size.width, b.gpu.size.height], [1600, 900]);
  // The EDID lists the size the console was born at after the preferred mode: fbcon refuses a mode wider than its buffer and blanks the console with no other.
  const edidAt = (g: typeof b.gpu) => { const r = g.control(cmd(T.EDID, 0, 0), 4096); return r.subarray(24 + 8, 24 + 8 + 128); };
  const second = (e: Uint8Array) => e[72] | e[73] << 8 ? [e[74] | (e[76] >> 4) << 8, e[77] | (e[79] >> 4) << 8] : null;
  assert.deepEqual([b.gpu.size.width, b.gpu.size.height], [1600, 900]);
  assert.deepEqual(second(edidAt(b.gpu)), [1024, 768]);
  // A compositor makes a new resource per mode: a shrink is followed.
  const c = gpuBackend(ctx, { width: 1024, height: 768, keepConsole: true });
  c.gpu.control(cmd(T.CREATE, 1, B8G8R8X8, 1024, 768), 4096);
  c.gpu.control(cmd(T.SCANOUT, 0, 0, 1024, 768, 0, 1), 4096);
  c.gpu.setSize(800, 600);
  c.gpu.control(cmd(T.CREATE, 2, B8G8R8X8, 800, 600), 4096);
  c.gpu.control(cmd(T.SCANOUT, 0, 0, 800, 600, 0, 2), 4096);
  assert.deepEqual([c.gpu.size.width, c.gpu.size.height], [800, 600]);
});

test('gpu: lazy transfers give the pixels eager ones do, when the page draws or anything reads', () => {
  const eager = rig(), lazy = rig({ lazyTransfer: true });
  for (const r of [eager, lazy]) {
    r.ok(cmd(T.CREATE, 1, B8G8R8X8, 4, 3));
    r.ok(r.attach(1, 0x1000, 48, 20));
    for (let k = 0; k < 48; k++) r.ram[0x1000 + k] = k + 1;
    r.ok(cmd(T.SCANOUT, 0, 0, 4, 3, 0, 1));
    r.ok(cmd(T.TRANSFER, 0, 0, 2, 2, 0n, 1, 0)); // two rectangles whose union is noted
    r.ok(cmd(T.TRANSFER, 2, 1, 2, 2, BigInt(1 * 16 + 2 * 4), 1, 0));
  }
  assert.deepEqual(px(lazy, 1, 3, 2), [0, 0, 0, 255], 'not copied yet');
  lazy.sources.at(-1)!.sync!(); // the page's draw
  for (const [x, y] of [[0, 0], [1, 1], [2, 1], [3, 2]]) assert.deepEqual(px(lazy, 1, x, y), px(eager, 1, x, y), `pixel ${x},${y}`);
  assert.ok(lazy.gpu.state().screen, 'a state read brings it up to date');
  // The backing going away copies first; an offset that isn't the rectangle's corner is copied at once.
  lazy.ram.fill(0x55, 0x1000, 0x1030);
  lazy.ok(cmd(T.TRANSFER, 0, 0, 4, 3, 0n, 1, 0));
  lazy.ok(cmd(T.DETACH, 1, 0));
  assert.deepEqual(px(lazy, 1, 1, 1), [0x55, 0x55, 0x55, 255], 'copied before the detach');
});

test('gpu: paced replies hold a burst to the frame and answer the first at once', async () => {
  const { gpuBackend } = await import('../web/gpu.ts');
  const ram = new Uint8Array(1 << 16);
  const done: number[] = [];
  const ctx = { ram: () => ram, ramSize: ram.length, complete: (w0: number) => done.push(w0), config: () => new Uint8Array(256), changeConfig() {} };
  const b = gpuBackend(ctx, { width: 800, height: 600, paceReplies: true });
  const send = (w0: number, c: Uint8Array) => {
    ram.set(c, 0x100);
    return b.request({ w0, queue: 0, read: [{ off: 0x100, len: c.length }], write: [{ off: 0x800, len: 64 }] });
  };
  assert.equal(send(1, cmd(T.CREATE, 1, B8G8R8X8, 4, 3)), 24, 'not a display command: at once');
  const flush = cmd(T.FLUSH, 0, 0, 1, 1, 1, 0);
  assert.equal(send(2, flush), 24, 'the first after idle');
  assert.equal(send(3, flush), undefined, 'a burst is held');
  assert.equal(send(4, cmd(T.INFO)), undefined, 'and what follows it, to keep the order');
  assert.deepEqual(done, []);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(done, [3, 4]);
});

test('gpu: a lazy transfer is copied before its reply reaches the guest (a compositor reuses the buffer at once)', async () => {
  // sway showed torn frames when the copy waited for the page's draw: the guest had drawn its next frame into the buffer.
  const { gpuBackend } = await import('../web/gpu.ts');
  const ram = new Uint8Array(RAM_SIZE);
  const done: number[] = [];
  const ctx = { ram: () => ram, ramSize: RAM_SIZE, complete: (w0: number) => done.push(w0), config: () => new Uint8Array(256), changeConfig() {} };
  for (const pace of [false, true]) {
    ram.fill(0);
    const b = gpuBackend(ctx, { width: 800, height: 600, lazyTransfer: true, paceReplies: pace });
    // The guest's command at RAM 0x100, the response room at 0x800.
    const send = (c: Uint8Array) => { ram.set(c, 0x100); return b.request({ w0: 1, queue: 0, read: [{ off: 0x100, len: c.length }], write: [{ off: 0x800, len: 512 }] }); };
    const attach = (() => { const head = cmd(T.ATTACH, 1, 1); const c = new Uint8Array(head.length + 16); c.set(head); const v = new DataView(c.buffer); v.setBigUint64(head.length, BigInt(RAM_BASE + 0x4000), true); v.setUint32(head.length + 8, 64, true); return c; })();
    send(cmd(T.CREATE, 1, B8G8R8X8, 4, 4));
    send(attach);
    send(cmd(T.SCANOUT, 0, 0, 4, 4, 0, 1));
    ram.fill(0x11, 0x4000, 0x4040);
    if (pace) await new Promise((r) => setTimeout(r, 40)); // idle: the next reply is at once
    const answered = send(cmd(T.TRANSFER, 0, 0, 4, 4, 0n, 1, 0));
    assert.ok(answered !== undefined, 'answered at once');
    ram.fill(0x99, 0x4000, 0x4040); // the guest's next frame
    b.gpu.settle();
    const res = b.gpu.resources.get(1)!;
    assert.equal(res.pixels[0], 0x11, `the first frame was copied before the reply (pace ${pace})`);
  }
});

test('gpu: the shown resource is re-read from its backing (a compositor draws after its flush)', () => {
  // sway rendered into the buffer it had just flipped to; a display scans memory continuously, so the screen has to follow.
  const r = rig();
  r.ok(cmd(T.CREATE, 1, B8G8R8X8, 8, 4));
  r.ok(r.attach(1, 0x2000, 8 * 4 * 4));
  r.ok(cmd(T.TRANSFER, 0, 0, 8, 4, 0n, 1, 0));
  r.ok(cmd(T.SCANOUT, 0, 0, 8, 4, 0, 1));
  r.ok(cmd(T.FLUSH, 0, 0, 8, 4, 1, 0));
  assert.equal(r.gpu.poll(), false, 'nothing changed');
  r.damage.length = 0;
  r.ram.fill(0x77, 0x2000 + 4 * (1 * 8 + 2), 0x2000 + 4 * (1 * 8 + 5)); // row 1, x 2..4: after the flush, no command
  r.ram.fill(0x55, 0x2000 + 4 * (3 * 8 + 7), 0x2000 + 4 * (3 * 8 + 8)); // row 3, x 7
  assert.equal(r.gpu.poll(), true);
  assert.deepEqual(r.damage, [{ x: 2, y: 1, w: 6, h: 3 }], 'the changed box, drawn');
  assert.deepEqual(px(r, 1, 3, 1), [0x77, 0x77, 0x77, 255]);
  assert.deepEqual(px(r, 1, 7, 3), [0x55, 0x55, 0x55, 255]);
  assert.equal(r.gpu.poll(), false, 'and now it is up to date');
});
