// The virtio-gpu backend without a guest (web/gpu.ts): commands on hand-built buffers, the
// answers the spec and QEMU give, the pixels, and a parser that survives random bytes; and the
// EDID generator (web/edid.ts) against edid-decode where it is installed.
import assert from 'node:assert/strict';
import { virglCaps } from '../web/virgl.ts';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { EDID_MAX, EDID_MIN, edid } from '../web/edid.ts';
import { Gpu, MAX_RESOURCE, hashRgba, type GpuHooks, type ScanoutSource } from '../web/gpu.ts';
import type { HostCall } from '../web/virgl-host.ts';
import { ramLayout } from '../web/ram.ts';

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
  const gpu = new Gpu(() => [ram], ramLayout(RAM_SIZE), { width: 800, height: 600, ...o });
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
  assert.equal(r.damage.length, 0, 'a transfer alone shows nothing: the flush does');
  // A rectangle in the middle: the offset is where its first pixel is in the guest's layout (y*stride + x*4).
  r.ram.fill(0xee, 0x1000, 48);
  r.ram.set([10, 20, 30, 0], 0x1000 + 1 * 16 + 1 * 4); // pixel (1,1)
  r.damage.length = 0;
  r.ok(cmd(T.TRANSFER, 1, 1, 1, 1, BigInt(1 * 16 + 1 * 4), 1, 0));
  assert.deepEqual(px(r, 1, 1, 1), [30, 20, 10, 255]);
  assert.deepEqual(px(r, 1, 0, 1), [19, 18, 17, 255], 'a neighbor is untouched');
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
  r.damage.length = 0;
  r.ok(cmd(T.SCANOUT, 1, 1, 2, 2, 0, 1));
  assert.deepEqual(r.scanouts.at(-1), [2, 2]);
  assert.deepEqual([r.sources.at(-1)!.x, r.sources.at(-1)!.y, r.sources.at(-1)!.width, r.sources.at(-1)!.height], [1, 1, 4, 3]);
  assert.equal(r.sources.at(-1)!.pixels, r.gpu.resources.get(1)!.pixels, 'the source is the resource itself: no copy');
  // The scanout change gave the page the whole picture: a flush with no transfer since has nothing more to show (a page flip's).
  assert.deepEqual(r.damage.map((d) => [d.x, d.y, d.w, d.h]), [[0, 0, 2, 2]]);
  r.damage.length = 0;
  r.ok(cmd(T.FLUSH, 0, 0, 4, 3, 1, 0));
  assert.equal(r.damage.length, 0);
  r.ok(cmd(T.TRANSFER, 0, 0, 4, 3, 0n, 1, 0));
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
    ram: () => [new Uint8Array(1 << 16)], layout: ramLayout(1 << 16), complete() {}, config: () => cfg, untaken: () => 0, features: () => 0n,
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

test('gpu: state saved and restored re-reads the pixels from the backing', async () => {
  const a = rig();
  a.ok(cmd(T.CREATE, 1, B8G8R8X8, 8, 8));
  a.ok(a.attach(1, 0x2000, 8 * 8 * 4, 100));
  for (let k = 0; k < 256; k++) a.ram[0x2000 + k] = k;
  a.ok(cmd(T.TRANSFER, 0, 0, 8, 8, 0n, 1, 0));
  a.ok(cmd(T.SCANOUT, 0, 0, 8, 8, 0, 1));
  a.ok(cmd(T.CREATE, 2, B8G8R8A8, 64, 64));
  a.ok(cmd(T.CREATE, 3, R8G8B8A8, 2, 2)); // no backing
  a.gpu.cursor(cmd(T.UPDATE_CURSOR, 0, 5, 6, 0, 2, 1, 2, 0));
  const saved = JSON.parse(JSON.stringify(await a.gpu.save()));
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
  // A console restored into a page of another size: the EDID's fallback mode is its buffer's size (the resource it shows),
  // not the size the new page started with, or fbcon finds no mode it can take and blanks the screen.
  const con = rig({ width: 1024, height: 768, keepConsole: true });
  con.ok(cmd(T.CREATE, 1, B8G8R8X8, 1024, 768));
  con.ok(cmd(T.SCANOUT, 0, 0, 1024, 768, 0, 1));
  const bigger = rig({ width: 1600, height: 900, keepConsole: true });
  bigger.gpu.restore(JSON.parse(JSON.stringify(await con.gpu.save())));
  bigger.gpu.setSize(1600, 900);
  const e = bigger.run(cmd(T.EDID, 0, 0)).r.subarray(24 + 8, 24 + 8 + 128);
  assert.deepEqual([e[56] | (e[58] >> 4) << 8, e[59] | (e[61] >> 4) << 8], [1600, 900], 'the preferred mode is the page\'s');
  assert.deepEqual([e[74] | (e[76] >> 4) << 8, e[77] | (e[79] >> 4) << 8], [1024, 768], 'the second is the console\'s buffer');
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
test('gpu: the conformance script gives the hashes the native twin gives, with a host too (its resources keep the guest\'s bytes)', () => {
  for (const hosted of [false, true]) {
    const r = rig();
    const calls: HostCall[] = [];
    if (hosted) r.gpu.host = { call: (c) => calls.push(c), fence: () => undefined };
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
    if (!hosted) continue;
    // The host's screen gets the bytes as the guest wrote them, and where R, G and B are in them.
    assert.equal(Buffer.compare(r.gpu.resources.get(1)!.pixels, r.ram.subarray(0x3000, 0x3100)), 0, 'the guest\'s bytes');
    const shown = calls.filter((c) => c.t === 'scanout').at(-1);
    assert.deepEqual(shown?.t === 'scanout' && shown.swizzle, [2, 1, 0]);
  }
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
  const ctx = { ram: () => [new Uint8Array(1 << 16)], layout: ramLayout(1 << 16), complete() {}, config: () => cfg, untaken: () => 0, features: () => 0n, changeConfig: (w: (c: Uint8Array) => void) => { events++; w(cfg); } };
  const b = gpuBackend(ctx, { width: 1024, height: 768, keepConsole: true });
  b.gpu.control(cmd(T.CREATE, 1, B8G8R8X8, 1024, 768), 4096);
  b.gpu.control(cmd(T.SCANOUT, 0, 0, 1024, 768, 0, 1), 4096);
  b.gpu.setSize(800, 600);
  assert.deepEqual([b.gpu.size.width, b.gpu.size.height, events], [800, 600, 1]);
  // fbcon answers with the same resource and a smaller rectangle: the display asks for the whole buffer again.
  b.gpu.control(cmd(T.SCANOUT, 0, 0, 800, 600, 0, 1), 4096);
  assert.deepEqual([b.gpu.size.width, b.gpu.size.height, events], [1024, 768, 2]);
  // The guest clears the event when it is done with the shrink, and that takes the floor's event with it: raised once more, once.
  const clear = () => { new DataView(cfg.buffer).setUint32(4, 1, true); b.config(); };
  clear();
  assert.deepEqual([new DataView(cfg.buffer).getUint32(0, true), events], [1, 3]);
  clear();
  assert.deepEqual([new DataView(cfg.buffer).getUint32(0, true), events], [0, 3]);
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

test('gpu: one flush is answered per frame, the first at once; what is queued behind a held one keeps its order', async () => {
  const { gpuBackend } = await import('../web/gpu.ts');
  const ram = new Uint8Array(1 << 16);
  const done: { w0: number; at: number }[] = [];
  const ctx = { ram: () => [ram], layout: ramLayout(ram.length), complete: (w0: number) => done.push({ w0, at: performance.now() }), config: () => new Uint8Array(256), changeConfig() {}, untaken: () => 0, features: () => 0n };
  const b = gpuBackend(ctx, { width: 800, height: 600, paceFlushes: true });
  const send = (w0: number, c: Uint8Array) => {
    ram.set(c, 0x100);
    return b.request({ w0, queue: 0, read: [{ off: 0x100, len: c.length, mem: 0 }], write: [{ off: 0x800, len: 512, mem: 0 }] });
  };
  const flush = cmd(T.FLUSH, 0, 0, 1, 1, 1, 0);
  assert.equal(send(1, cmd(T.CREATE, 1, B8G8R8X8, 4, 3)), 24, 'not a flush: at once');
  assert.equal(send(2, flush), 24, 'the first flush after idle: at once');
  const t0 = performance.now();
  assert.equal(send(3, cmd(T.INFO)), 24 + 16 * 24, 'nothing is held: at once');
  assert.equal(send(4, flush), undefined, 'a second flush in the frame waits for its end');
  assert.equal(send(5, cmd(T.INFO)), undefined, 'and what follows it, to keep the order');
  assert.equal(send(6, flush), undefined);
  assert.equal(send(7, cmd(T.INFO)), undefined);
  assert.equal(done.length, 0);
  for (let k = 0; k < 100 && done.length < 4; k++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(done.map((d) => d.w0), [4, 5, 6, 7]);
  assert.ok(done[1].at - done[0].at < 5, 'what was behind the first flush goes with it');
  // Frames are a 60th of a second after the flush that was answered at once (a late timer doesn't push the next one back).
  const frame = 1000 / 60, slack = 2;
  assert.ok(done[0].at - t0 >= frame - slack, `the held flush waits for the frame's end (${(done[0].at - t0).toFixed(1)} ms)`);
  assert.ok(done[2].at - t0 >= 2 * frame - slack, `the next one a frame more (${(done[2].at - t0).toFixed(1)} ms)`);
  // Idle again: at once.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(send(8, flush), 24);
  // A reset drops what is held (the core drops the requests).
  assert.equal(send(9, flush), undefined);
  b.reset();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(done.length, 4);
});

test('gpu: a transfer copies when it arrives, also while its reply is held (the guest reuses the buffer without waiting)', async () => {
  // Linux waits for no reply on a primary plane: a compositor draws its next frames into a buffer whose transfer's
  // reply is still held, so a copy that waited for the reply (or for the page's draw) showed half-drawn frames.
  const { gpuBackend } = await import('../web/gpu.ts');
  const ram = new Uint8Array(RAM_SIZE);
  const ctx = { ram: () => [ram], layout: ramLayout(RAM_SIZE), complete() {}, config: () => new Uint8Array(256), changeConfig() {}, untaken: () => 0, features: () => 0n };
  const b = gpuBackend(ctx, { width: 800, height: 600, paceFlushes: true });
  const send = (c: Uint8Array) => { ram.set(c, 0x100); return b.request({ w0: 1, queue: 0, read: [{ off: 0x100, len: c.length, mem: 0 }], write: [{ off: 0x800, len: 512, mem: 0 }] }); };
  const attach = cmd(T.ATTACH, 1, 1, BigInt(RAM_BASE + 0x4000), 64, 0);
  send(cmd(T.CREATE, 1, B8G8R8X8, 4, 4));
  send(attach);
  send(cmd(T.SCANOUT, 0, 0, 4, 4, 0, 1));
  const flush = cmd(T.FLUSH, 0, 0, 4, 4, 1, 0);
  send(flush);
  assert.equal(send(flush), undefined, 'held');
  ram.fill(0x11, 0x4000, 0x4040);
  assert.equal(send(cmd(T.TRANSFER, 0, 0, 4, 4, 0n, 1, 0)), undefined, 'the reply waits behind the flush');
  ram.fill(0x99, 0x4000, 0x4040); // the guest's next frame, into the same buffer
  assert.equal(b.gpu.resources.get(1)!.pixels[0], 0x11, 'the frame that was transferred');
  b.reset();
});

test('gpu: a ring fence\'s reply is out of line: what follows it is answered while it waits, and its own at its retirement', async () => {
  const { gpuBackend } = await import('../web/gpu.ts');
  const ram = new Uint8Array(RAM_SIZE);
  const done: number[] = [];
  const ctx = { ram: () => [ram], layout: ramLayout(RAM_SIZE), complete(w0: number) { done.push(w0); }, config: () => new Uint8Array(256), changeConfig() {}, untaken: () => 0, features: () => 0n };
  const b = gpuBackend(ctx, { width: 800, height: 600, virgl: true, venus: true });
  const retire: (() => void)[] = [];
  b.gpu.host = { call() {}, fence: () => new Promise<void>((r) => retire.push(r)) };
  const send = (w0: number, c: Uint8Array) => { ram.set(c, 0x100); return b.request({ w0, queue: 0, read: [{ off: 0x100, len: c.length, mem: 0 }], write: [{ off: 0x800, len: 512, mem: 0 }] }); };
  send(1, ctxCmd(3, V.CTX_CREATE, 0, 4));
  const ringed = (id: bigint) => {
    const s = ctxCmd(3, V.SUBMIT_3D, 8, 0, 0x11223344, 5);
    const v = new DataView(s.buffer);
    v.setUint32(4, 1 | 2, true);
    v.setBigUint64(8, id, true);
    v.setUint8(20, 1);
    return s;
  };
  done.length = 0;
  assert.equal(send(10, ringed(1n)), undefined, 'waits for its retirement');
  assert.notEqual(send(11, ctxCmd(3, V.SUBMIT_3D, 8, 0, 0x11223344, 5)), undefined, 'an unfenced command behind it is answered at once');
  assert.equal(send(12, ringed(2n)), undefined);
  retire[1]();
  await new Promise((r) => setTimeout(r));
  assert.deepEqual(done, [12], 'a later ring\'s fence retires on its own');
  retire[0]();
  await new Promise((r) => setTimeout(r));
  assert.deepEqual(done, [12, 10]);
  send(13, ringed(3n));
  b.reset();
  retire[2]();
  await new Promise((r) => setTimeout(r));
  assert.deepEqual(done, [12, 10], 'nothing is answered after a reset');
});

test('gpu: a Venus fence names its context and ring to the host; virgl\'s and a blob\'s hold name none', async () => {
  const { gpuBackend } = await import('../web/gpu.ts');
  const ram = new Uint8Array(RAM_SIZE);
  const ctx = { ram: () => [ram], layout: ramLayout(RAM_SIZE), complete() {}, config: () => new Uint8Array(256), changeConfig() {}, untaken: () => 0, features: () => 0n };
  const b = gpuBackend(ctx, { width: 800, height: 600, virgl: true, venus: true });
  const scopes: unknown[] = [];
  b.gpu.host = { call() {}, fence: (scope) => { scopes.push(scope); return new Promise<void>(() => {}); } };
  const send = (w0: number, c: Uint8Array) => { ram.set(c, 0x100); return b.request({ w0, queue: 0, read: [{ off: 0x100, len: c.length, mem: 0 }], write: [{ off: 0x800, len: 512, mem: 0 }] }); };
  send(1, ctxCmd(3, V.CTX_CREATE, 0, 4));
  send(2, ctxCmd(4, V.CTX_CREATE, 0, 1));
  const fenced = (ctxId: number, flags: number) => {
    const s = ctxCmd(ctxId, V.SUBMIT_3D, 8, 0, 0x11223344, 5);
    const v = new DataView(s.buffer);
    v.setUint32(4, flags, true);
    v.setBigUint64(8, 9n, true);
    v.setUint8(20, 2);
    return s;
  };
  send(3, fenced(3, 1 | 2));
  send(4, fenced(3, 1));
  const empty = ctxCmd(4, V.SUBMIT_3D, 0, 0);
  new DataView(empty.buffer).setUint32(4, 1, true);
  send(5, empty);
  assert.deepEqual(scopes, [{ ctx: 3, ring: 2, id: 9n, ringed: true }, { ctx: 3, ring: 0, id: 9n, ringed: false }, undefined], 'virgl\'s names none');
});

// A queue's work may wait for a signal the guest sends after it, from the thread that queued it; each ring fence held
// takes an entry of the page's 16, so 16 stopped that thread in the kernel (backlog "Synchronization", VK4 R1).
test('gpu: ring fences that fill the queue and stall give entries back, the next fence of their ring standing for them', async () => {
  const { gpuBackend } = await import('../web/gpu.ts');
  const ram = new Uint8Array(RAM_SIZE);
  const done: number[] = [];
  const replies = new Map<number, { flags: number; id: bigint }>();
  const at = (w0: number) => 0x1000 + w0 * 64;
  const reply = (w0: number) => { const v = new DataView(ram.buffer, at(w0)); return { flags: v.getUint32(4, true), id: v.getBigUint64(8, true) }; };
  const ctx = { ram: () => [ram], layout: ramLayout(RAM_SIZE), complete(w0: number) { done.push(w0); replies.set(w0, reply(w0)); }, config: () => new Uint8Array(256), changeConfig() {}, untaken: () => 0, features: () => 0n };
  const b = gpuBackend(ctx, { width: 800, height: 600, virgl: true, venus: true });
  const retire: (() => void)[] = [];
  b.gpu.host = { call() {}, fence: () => new Promise<void>((r) => retire.push(r)) };
  const send = (w0: number, c: Uint8Array) => { ram.set(c, 0x100); return b.request({ w0, queue: 0, read: [{ off: 0x100, len: c.length, mem: 0 }], write: [{ off: at(w0), len: 64, mem: 0 }] }); };
  send(1, ctxCmd(3, V.CTX_CREATE, 0, 4));
  const ringed = (id: bigint) => {
    const s = ctxCmd(3, V.SUBMIT_3D, 8, 0, 0x11223344, 5);
    const v = new DataView(s.buffer);
    v.setUint32(4, 1 | 2, true);
    v.setBigUint64(8, id, true);
    v.setUint8(20, 1);
    return s;
  };
  done.length = 0;
  replies.clear();
  for (let i = 1; i <= 40; i++) assert.equal(send(100 + i, ringed(BigInt(i))), undefined);
  assert.equal(done.length, 0, 'no entry comes back before a stall: the guest may wait for any of these fences alone');
  // RING_STALL_MS, 250 ms, then a timer: bounded, not timed, as a loaded host runs it late.
  for (let k = 0; k < 300 && done.length < 40 - 15; k++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(done.length, 40 - 15, 'stalled, entries come back until the queue has room, and no further');
  for (const r of replies.values()) assert.equal(r.flags & 1, 0, 'a reply given back says no fence: its fence hasn\'t retired');
  assert.ok(!done.includes(140), 'the newest keeps its entry: it stands for those before it');
  assert.ok(!done.includes(101), 'the oldest keeps its own');
  const second = done.length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(done.length, second, 'with room, no more');
  done.length = 0;
  retire[0]();
  await new Promise((r) => setTimeout(r));
  assert.deepEqual(done, [101]);
  // In order, as the worker answers them; a fence without an entry is said by the next with one.
  for (let i = 1; i < 40; i++) retire[i]();
  await new Promise((r) => setTimeout(r));
  assert.equal(done.length, 15, 'those that kept their entries');
  assert.equal(done.at(-1), 140);
  const last = replies.get(140)!;
  assert.deepEqual([last.flags & 1, last.id], [1, 40n], 'the last reply is the newest fence\'s, which signals every earlier one of its ring');
  b.reset();
});

// The review of R1 to R4's C2 (VK4 T36): a guest waiting for a fence that gave its entry back, alone, while the newest of
// its ring waits for what the guest does next. Its work done, it is signalled by the next reply that has no fence of its
// own: the guest's next command's, or, when the guest sends nothing, the display event's GET_DISPLAY_INFO (the kernel's
// own command, from its config-change work), never by the ring's next alone.
async function givenBack() {
  const { gpuBackend } = await import('../web/gpu.ts');
  const ram = new Uint8Array(RAM_SIZE);
  const config = new Uint8Array(256);
  let signalled = 0n, events = 0, w0 = 1000;
  const answered = new Set<number>();
  const at = (w: number) => 0x1000 + (w % 256) * 512;
  const ctx = {
    ram: () => [ram], layout: ramLayout(RAM_SIZE), untaken: () => 0, features: () => 0n,
    // The kernel's dequeue: a reply with the fence flag signals its fence and the earlier ones of its ring (one here).
    complete(w: number) {
      answered.add(w);
      const v = new DataView(ram.buffer, at(w));
      if (v.getUint32(4, true) & 1 && v.getBigUint64(8, true) > signalled) signalled = v.getBigUint64(8, true);
    },
    config: () => config,
    // The kernel's config-change work: GET_DISPLAY_INFO (and EDID) sent, the event cleared.
    changeConfig(f: (c: Uint8Array) => void) {
      f(config);
      events++;
      setTimeout(() => {
        send(w0++, cmd(T.EDID, 0, 0));
        send(w0++, cmd(T.INFO));
        new DataView(config.buffer).setUint32(4, new DataView(config.buffer).getUint32(0, true), true);
        b.config();
      });
    },
  };
  const b = gpuBackend(ctx, { width: 800, height: 600, virgl: true, venus: true });
  const retire: (() => void)[] = [];
  b.gpu.host = { call() {}, fence: () => new Promise<void>((r) => retire.push(r)) };
  // A reply returned is completed at once, as the transport does.
  const send = (w: number, c: Uint8Array) => {
    ram.set(c, 0x100);
    const n = b.request({ w0: w, queue: 0, read: [{ off: 0x100, len: c.length, mem: 0 }], write: [{ off: at(w), len: 512, mem: 0 }] });
    if (n !== undefined) ctx.complete(w);
    return n;
  };
  send(1, ctxCmd(3, V.CTX_CREATE, 0, 4));
  answered.clear();
  for (let i = 1; i <= 20; i++) {
    const s = ctxCmd(3, V.SUBMIT_3D, 8, 0, 0x11223344, 5);
    const v = new DataView(s.buffer);
    v.setUint32(4, 1 | 2, true);
    v.setBigUint64(8, BigInt(i), true);
    v.setUint8(20, 1);
    send(100 + i, s);
  }
  // Stalled: 5 entries come back (fences 15 to 19), the newest, 20, keeps its own.
  for (let k = 0; k < 300 && !answered.has(119); k++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([...answered].sort(), [115, 116, 117, 118, 119], 'given back');
  return { b, send, retire, signalled: () => signalled, events: () => events };
}

test('gpu: a fence that gave its entry back is signalled once its work is done, by the guest\'s next reply', async () => {
  const g = await givenBack();
  try {
    for (let i = 0; i < 19; i++) g.retire[i]();
    await new Promise((r) => setTimeout(r));
    assert.equal(g.signalled(), 14n, 'those with entries signal themselves');
    assert.notEqual(g.send(500, ctxCmd(3, V.SUBMIT_3D, 8, 0, 0x11223344, 5)), undefined, 'an unfenced command, answered at once');
    assert.equal(g.signalled(), 19n, 'its reply signals fence 19, whose work is done; 20\'s isn\'t');
    assert.equal(g.events(), 0, 'no display event');
  } finally {
    g.b.reset();
  }
});

test('gpu: a fence that gave its entry back is signalled once its work is done, by a display event\'s reply when the guest sends nothing', async () => {
  const g = await givenBack();
  try {
    for (let i = 0; i < 19; i++) g.retire[i]();
    for (let k = 0; k < 100 && g.signalled() < 19n; k++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(g.signalled(), 19n, 'the guest, waiting for fence 19 alone, gets it');
    assert.equal(g.events(), 1, 'one display event');
    g.retire[19]();
    await new Promise((r) => setTimeout(r));
    assert.equal(g.signalled(), 20n);
  } finally {
    g.b.reset();
  }
});

// A timer may fire before `performance.now()` says it is due (a cloud host's mostly fired a fraction of a millisecond
// early): the stall check then re-arms, and must re-arm for what is left of `RING_STALL_MS`, not all of it again, or the
// guest's queue waits twice the stall (backlog "CPU and ISA" until 2026-11-02; it flaked the test above's fixed wait).
test('gpu: a stall timer that fires early re-arms for what is left of the stall', async () => {
  const { gpuBackend } = await import('../web/gpu.ts');
  const ram = new Uint8Array(RAM_SIZE);
  const done: number[] = [];
  const ctx = { ram: () => [ram], layout: ramLayout(RAM_SIZE), complete(w0: number) { done.push(w0); }, config: () => new Uint8Array(256), changeConfig() {}, untaken: () => 0, features: () => 0n };
  const b = gpuBackend(ctx, { width: 800, height: 600, virgl: true, venus: true });
  b.gpu.host = { call() {}, fence: () => new Promise<void>(() => {}) };
  const send = (w0: number, c: Uint8Array) => { ram.set(c, 0x100); return b.request({ w0, queue: 0, read: [{ off: 0x100, len: c.length, mem: 0 }], write: [{ off: 0x800, len: 512, mem: 0 }] }); };
  send(1, ctxCmd(3, V.CTX_CREATE, 0, 4));
  // The backend's stall timer (`watchRings`) fires at half its delay; everything else's as asked.
  const real = globalThis.setTimeout;
  const arms: { ms: number; at: number; given: number }[] = [];
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    if (fn.name !== 'watchRings') return real(fn, ms, ...rest);
    arms.push({ ms: ms!, at: performance.now(), given: done.length });
    return real(fn, Math.floor(ms! / 2), ...rest);
  }) as typeof setTimeout;
  try {
    done.length = 0;
    for (let i = 1; i <= 20; i++) {
      const s = ctxCmd(3, V.SUBMIT_3D, 8, 0, 0x11223344, 5);
      const v = new DataView(s.buffer);
      v.setUint32(4, 1 | 2, true);
      v.setBigUint64(8, BigInt(i), true);
      v.setUint8(20, 1);
      send(100 + i, s);
    }
    const last = performance.now();
    for (let k = 0; k < 300 && done.length < 20 - 15; k++) await new Promise((r) => real(r, 10));
    assert.equal(done.length, 20 - 15, 'stalled, entries come back');
    const before = arms.filter((a) => a.given === 0 && a.at >= last);
    assert.ok(before.length >= 1, 'the early timer re-armed before the stall was due');
    for (const a of before) assert.ok(a.ms <= Math.ceil(last + 250 - a.at) + 1, `re-armed for ${a.ms} ms with ${(last + 250 - a.at).toFixed(1)} left`);
  } finally {
    globalThis.setTimeout = real;
    b.reset();
  }
});

test('gpu: a full queue whose fences go on retiring, or whose guest goes on sending, keeps its entries', async () => {
  const { gpuBackend } = await import('../web/gpu.ts');
  const ram = new Uint8Array(RAM_SIZE);
  const done: number[] = [];
  const ctx = { ram: () => [ram], layout: ramLayout(RAM_SIZE), complete(w0: number) { done.push(w0); }, config: () => new Uint8Array(256), changeConfig() {}, untaken: () => 0, features: () => 0n };
  const b = gpuBackend(ctx, { width: 800, height: 600, virgl: true, venus: true });
  const retire: (() => void)[] = [];
  b.gpu.host = { call() {}, fence: () => new Promise<void>((r) => retire.push(r)) };
  const send = (w0: number, c: Uint8Array) => { ram.set(c, 0x100); return b.request({ w0, queue: 0, read: [{ off: 0x100, len: c.length, mem: 0 }], write: [{ off: 0x800, len: 512, mem: 0 }] }); };
  send(1, ctxCmd(3, V.CTX_CREATE, 0, 4));
  for (let i = 1; i <= 20; i++) {
    const s = ctxCmd(3, V.SUBMIT_3D, 8, 0, 0x11223344, 5);
    const v = new DataView(s.buffer);
    v.setUint32(4, 1 | 2, true);
    v.setBigUint64(8, BigInt(i), true);
    v.setUint8(20, 1);
    send(100 + i, s);
  }
  done.length = 0;
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 100));
    retire[i]();
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(done, [101, 102, 103, 104], 'only those retired');
  b.reset();
});

// ---- virgl on the null renderer (web/gpu.ts `virgl`, web/virgl.ts) ----

const V = { CAPSET_INFO: 0x108, CAPSET: 0x109, CTX_CREATE: 0x200, CTX_DESTROY: 0x201, CTX_ATTACH: 0x202, CTX_DETACH: 0x203, CREATE_3D: 0x204, TO_HOST_3D: 0x205, FROM_HOST_3D: 0x206, SUBMIT_3D: 0x207 };
const OK_CAPSET_INFO = 0x1102, OK_CAPSET = 0x1103, ERR_CTX = 0x1204;

/** A command in context `ctx` (the header's ctx_id). */
function ctxCmd(ctx: number, type: number, ...fields: (number | bigint)[]) {
  const c = cmd(type, ...fields);
  new DataView(c.buffer).setUint32(16, ctx, true);
  return c;
}

/** SUBMIT_3D with `words` as its command buffer. */
function submit(ctx: number, words: number[]) {
  const c = ctxCmd(ctx, V.SUBMIT_3D, words.length * 4, 0, ...words);
  return c;
}

/** RESOURCE_CREATE_3D: id, target, format, bind, width, height, depth, array_size, last_level, nr_samples, flags, padding. */
const create3d = (id: number, target: number, w: number, h: number, bind = 2) => cmd(V.CREATE_3D, id, target, R8G8B8A8, bind, w, h, 1, 1, 0, 0, 0, 0);

test('virgl: off by default, the 3D commands are unknown', () => {
  const r = rig();
  for (const t of Object.values(V)) assert.equal(r.run(ctxCmd(1, t, 0, 0, 0, 0)).type, ERR_UNSPEC);
});

test('virgl: the capsets are VIRGL (v1, 308 bytes) and VIRGL2 (v2, 1408 bytes), GLES 3.0-level caps', async () => {
  const { decodeCaps, virglCaps } = await import('../web/virgl.ts');
  const r = rig({ virgl: true });
  const info = (k: number) => {
    const o = r.run(cmd(V.CAPSET_INFO, k, 0));
    const v = new DataView(o.r.buffer, o.r.byteOffset);
    return o.type === OK_CAPSET_INFO ? [v.getUint32(24, true), v.getUint32(28, true), v.getUint32(32, true)] : o.type;
  };
  assert.deepEqual([info(0), info(1), info(2)], [[1, 1, 308], [2, 2, 1408], ERR_PARAM]);
  const blob = r.run(cmd(V.CAPSET, 2, 2));
  assert.equal(blob.type, OK_CAPSET);
  assert.equal(Buffer.compare(blob.r.subarray(24), virglCaps(2)), 0);
  assert.equal(r.run(cmd(V.CAPSET, 2, 3)).type, ERR_PARAM, 'a version above the max');
  assert.equal(r.run(cmd(V.CAPSET, 3, 1)).type, ERR_PARAM);
  const v1 = r.run(cmd(V.CAPSET, 1, 1));
  assert.equal(v1.r.length, 24 + 308);
  const caps = decodeCaps(blob.r.subarray(24));
  assert.equal(caps.max_version, 2);
  assert.equal(caps.glsl_level, 130);
  assert.equal(caps.renderer, 'waarm64');
  assert.equal(decodeCaps(v1.r.subarray(24)).max_version, 1);
  // Nothing WebGL2 lacks: no dual-source blending, no fbfetch (VIRGL_CAP_TGSI_FBFETCH), no indep blend.
  assert.equal(caps.max_dual_source_render_targets, 0);
  assert.equal((caps.capability_bits as number) & (1 << 10), 0);
  assert.equal((caps.bset as number) & 3, 0);
});

test('virgl: caps encode and decode back', async () => {
  const { decodeCaps, encodeCaps, virglCaps } = await import('../web/virgl.ts');
  const blob = virglCaps(2);
  assert.equal(Buffer.compare(encodeCaps(decodeCaps(blob)), blob), 0);
});

test('virgl: contexts, 3D resources, transfers and submits on the null renderer', async () => {
  const r = rig({ virgl: true });
  assert.equal(r.run(ctxCmd(0, V.CTX_CREATE, 4, 0)).type, ERR_CTX, 'context 0 is the 2D one');
  r.ok(ctxCmd(1, V.CTX_CREATE, 4, 0));
  assert.equal(r.run(ctxCmd(1, V.CTX_CREATE, 4, 0)).type, ERR_CTX, 'twice');
  // A render target and a buffer, backed, attached to the context.
  r.ok(create3d(1, 2, 64, 32));
  r.ok(create3d(2, 0, 4096, 1, 16));
  assert.equal(r.run(create3d(2, 0, 4096, 1, 16)).type, ERR_RES, 'an id in use');
  assert.equal(r.run(create3d(3, 9, 1, 1)).type, ERR_PARAM, 'no such target');
  r.ok(r.attach(1, 0, 64 * 32 * 4));
  r.ok(r.attach(2, 0x10000, 4096));
  r.ok(ctxCmd(1, V.CTX_ATTACH, 1, 0));
  r.ok(ctxCmd(1, V.CTX_ATTACH, 2, 0));
  assert.equal(r.run(ctxCmd(2, V.CTX_ATTACH, 1, 0)).type, ERR_CTX);
  assert.equal(r.run(ctxCmd(1, V.CTX_ATTACH, 9, 0)).type, ERR_RES);
  // TRANSFER_TO_HOST_3D: box x y z w h d, offset (u64), resource, level, stride, layer_stride.
  r.ok(ctxCmd(1, V.TO_HOST_3D, 0, 0, 0, 64, 32, 1, 0n, 1, 0, 256, 0));
  r.ok(ctxCmd(1, V.TO_HOST_3D, 0, 0, 0, 1000, 1, 1, 0n, 2, 0, 0, 0));
  r.ok(ctxCmd(1, V.FROM_HOST_3D, 0, 0, 0, 64, 2, 1, 0n, 1, 0, 256, 0));
  assert.equal(r.run(ctxCmd(1, V.TO_HOST_3D, 0, 0, 0, 1, 1, 1, 0n, 7, 0, 4, 0)).type, ERR_RES);
  // A 2D transfer of a 3D resource is refused (its format may not be one 2D knows).
  assert.equal(r.run(cmd(T.TRANSFER, 0, 0, 1, 1, 0n, 1, 0)).type, ERR_PARAM);
  // A stream: CREATE_SUB_CTX (cmd 29, 1 dword), SET_SUB_CTX (28), CLEAR (7, 8 dwords), DRAW_VBO (8, 12 dwords).
  const hdr = (c: number, obj: number, len: number) => c | obj << 8 | len << 16;
  r.ok(submit(1, [hdr(29, 0, 1), 1, hdr(28, 0, 1), 1, hdr(7, 0, 8), 0, 0, 0, 0, 0, 0, 0, 0, hdr(8, 0, 12), ...new Array(12).fill(0), hdr(8, 0, 12), ...new Array(12).fill(0)]));
  assert.equal(r.run(submit(1, [hdr(7, 0, 8), 0])).type, ERR_PARAM, 'a length past the end');
  assert.equal(r.run(submit(2, [])).type, ERR_CTX);
  const truncated = submit(1, [0, 0]);
  assert.equal(r.run(truncated.subarray(0, truncated.length - 4)).type, ERR_PARAM, 'size past the payload');
  const st = r.gpu.state().virgl!;
  assert.equal(st.contexts, 1);
  assert.equal(st.toHostBytes, 256 * 32 + 1000);
  assert.equal(st.fromHostBytes, 256 * 2);
  assert.deepEqual(st.stream.commands.DRAW_VBO, { n: 2, dwords: 24 });
  assert.deepEqual([st.stream.submits, st.stream.bad], [2, 1], "the truncated one is refused before it is read");
  assert.equal(st.commands.SUBMIT_3D, 4);
  // Shown: black pixels, opaque. Not saved while 3D is in use.
  r.ok(cmd(T.SCANOUT, 0, 0, 64, 32, 0, 1));
  assert.deepEqual(px(r, 1, 5, 5), [0, 0, 0, 255]);
  assert.equal(r.run(cmd(T.SCANOUT, 0, 0, 1, 1, 0, 2)).type, ERR_PARAM, 'a buffer is never shown');
  // Saved on the null renderer (nothing is in a renderer): the 3D tables, the contexts and what they attached.
  const saved = JSON.parse(JSON.stringify(await r.gpu.save())) as { unsaveable?: string; three: [number, unknown][]; attached: [number, number[]][]; used: number[] };
  assert.equal(saved.unsaveable, undefined);
  assert.deepEqual([saved.three.map(([id]) => id), saved.used], [[1, 2], [1]]);
  const back = rig({ virgl: true });
  back.gpu.restore(saved);
  assert.deepEqual(back.gpu.state().resources, r.gpu.state().resources);
  assert.deepEqual(px(back, 1, 5, 5), [0, 0, 0, 255], 'the scanout is black again');
  // Unref leaves the context; destroy and reset forget it.
  r.ok(cmd(T.UNREF, 2, 0));
  r.ok(ctxCmd(1, V.CTX_DESTROY));
  assert.equal(r.run(ctxCmd(1, V.CTX_DESTROY)).type, ERR_CTX);
  r.ok(ctxCmd(3, V.CTX_CREATE, 4, 0));
  r.gpu.reset();
  assert.equal(r.gpu.state().virgl!.contexts, 0);
  assert.equal(r.gpu.resources.size, 0);
});

test('virgl: random 3D commands never throw, never write RAM, and answer in the spec', () => {
  let s = 0x1b873593;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const r = rig({ virgl: true });
  for (let k = 0; k < 256; k++) r.ram[k * 7] = k;
  const before = r.ram.slice();
  const types = [...Object.values(V), ...Object.values(T)];
  const interesting = [0, 1, 2, 3, 4, 8, 63, 64, 0xffff, 0x7fff_ffff, 0x8000_0000, 0xffff_ffff];
  const answers = new Set([OK, OK_INFO, OK_EDID, OK_CAPSET_INFO, OK_CAPSET, ERR_UNSPEC, ERR_OOM, ERR_SCANOUT, ERR_RES, ERR_CTX, ERR_PARAM]);
  let oks = 0;
  for (let k = 0; k < 20000; k++) {
    const ctx = Math.floor(rnd() * 4);
    if (rnd() < 0.1) r.run(ctxCmd(ctx, V.CTX_CREATE, 0, 0));
    if (rnd() < 0.2) r.run(create3d(1 + Math.floor(rnd() * 4), Math.floor(rnd() * 10), 1 + Math.floor(rnd() * 64), 1 + Math.floor(rnd() * 64)));
    if (rnd() < 0.1) r.run(r.attach(1 + Math.floor(rnd() * 4), Math.floor(rnd() * 4096), Math.floor(rnd() * 3000) + 1, Math.floor(rnd() * 500) + 1));
    let c: Uint8Array;
    if (rnd() < 0.3) c = submit(ctx, Array.from({ length: Math.floor(rnd() * 20) }, () => (rnd() < 0.5 ? interesting[Math.floor(rnd() * interesting.length)] : Math.floor(rnd() * 0x40000))));
    else c = ctxCmd(ctx, types[Math.floor(rnd() * types.length)], ...Array.from({ length: Math.floor(rnd() * 14) }, () => (rnd() < 0.5 ? interesting[Math.floor(rnd() * interesting.length)] : Math.floor(rnd() * 16))));
    if (rnd() < 0.1) c = c.subarray(0, Math.floor(rnd() * c.length));
    const out = r.run(c, rnd() < 0.1 ? Math.floor(rnd() * 60) : 4096);
    if (out.type !== -1) {
      assert.ok(answers.has(out.type), `answer ${out.type.toString(16)}`);
      if (out.type === OK) oks++;
    }
  }
  assert.ok(oks > 2000, `the random commands got somewhere (${oks} ok)`);
  assert.equal(Buffer.compare(before, r.ram), 0, 'guest RAM unchanged');
});

// Venus (docs/devices.md "The host-visible window"): contexts for the VENUS capset, blob resources mapped into the
// window, Venus's submits handed on, with a host that records the calls.
const VN = { ASSIGN_UUID: 0x10b, CREATE_BLOB: 0x10c, SCANOUT_BLOB: 0x10d, MAP_BLOB: 0x208, UNMAP_BLOB: 0x209 };
const OK_UUID = 0x1105, OK_MAP_INFO = 0x1106;
/** CTX_CREATE with `context_init` (the capset in its low byte) and a debug name. */
const ctxCreate = (ctx: number, capset: number, name = 'vk') => {
  const n = new TextEncoder().encode(name);
  const c = ctxCmd(ctx, V.CTX_CREATE, n.length, capset, ...new Array(16).fill(0));
  c.set(n, 32);
  return c;
};
/** RESOURCE_CREATE_BLOB: id, blob_mem, blob_flags, nr_entries, blob_id (u64), size (u64). */
const blob = (ctx: number, id: number, size: number, flags = 1, mem = 2, blobId = 0n) => ctxCmd(ctx, VN.CREATE_BLOB, id, mem, flags, 0, blobId, BigInt(size));

test('venus: off without the option; with it the features, the third capset and Venus contexts', async () => {
  const { deviceEntry } = await import('../web/devices.ts');
  assert.equal(deviceEntry({ type: 'gpu', width: 640, height: 480, virgl: true }).entry[1], 3n);
  const on = deviceEntry({ type: 'gpu', width: 640, height: 480, virgl: true, venus: true });
  assert.equal(on.entry[1], 0x1fn, 'VIRGL, EDID, RESOURCE_UUID, RESOURCE_BLOB, CONTEXT_INIT');
  assert.equal(new DataView(on.config.buffer).getUint32(12, true), 3, 'num_capsets');
  const plain = rig({ virgl: true });
  assert.equal(plain.run(blob(1, 1, 4096)).type, ERR_UNSPEC, 'no blobs without venus');
  const r = rig({ virgl: true, venus: true, window: 1 << 20 });
  const info = r.run(cmd(V.CAPSET_INFO, 2, 0));
  const iv = new DataView(info.r.buffer, info.r.byteOffset);
  assert.deepEqual([info.type, iv.getUint32(24, true), iv.getUint32(28, true), iv.getUint32(32, true)], [OK_CAPSET_INFO, 4, 0, 160]);
  const caps = r.run(cmd(V.CAPSET, 4, 0));
  const cv = new DataView(caps.r.buffer, caps.r.byteOffset + 24);
  assert.deepEqual([caps.type, cv.getUint32(0, true), cv.getUint32(4, true) >>> 12 & 0x3ff, cv.getUint32(16, true), cv.getUint32(20, true) & 1], [OK_CAPSET, 1, 4, 1, 1]);
  assert.equal(r.run(ctxCreate(1, 9)).type, ERR_PARAM, 'no such capset');
  r.ok(ctxCreate(1, 4));
  r.ok(ctxCreate(2, 0));
  assert.equal(r.run(blob(2, 1, 4096)).type, ERR_CTX, "a virgl context makes no blobs");
});

// VK4 R6 (the review's H4): a blob outlives its context (a compositor still holds a program's image), and a browser
// with other caps keeps the Venus capset.
test('venus: a blob left of a destroyed context refuses the snapshot, and caps restored keep the capset', async () => {
  const r = rig({ virgl: true, venus: true, window: 1 << 20 });
  r.gpu.host = { call: () => {}, fence: () => {} } as unknown as typeof r.gpu.host;
  r.ok(ctxCreate(3, 4, 'vkcube'));
  r.ok(blob(3, 10, 4096));
  r.ok(ctxCmd(3, V.CTX_DESTROY));
  assert.equal((await r.gpu.save()).unsaveable?.msg?.key, 'display:gpu.unsaveable.venus');
  // The check a snapshot makes before it touches the machine says the same.
  assert.equal((await r.gpu.refusal())?.msg?.key, 'display:gpu.unsaveable.venus');
  r.ok(cmd(T.UNREF, 10, 0));
  const saved = JSON.parse(JSON.stringify(await r.gpu.save()));
  assert.equal(saved.unsaveable, undefined);
  assert.equal(await r.gpu.refusal(), undefined);
  const other = rig({ virgl: true, venus: true, window: 1 << 20 });
  saved.caps = btoa(String.fromCharCode(...virglCaps(2).map((b, i) => (i === 200 ? b ^ 1 : b))));
  other.gpu.restore(saved);
  const info = other.run(cmd(V.CAPSET_INFO, 2, 0));
  assert.equal(new DataView(info.r.buffer, info.r.byteOffset).getUint32(24, true), 4, 'the third capset is still Venus');
});

test('venus: blobs, their mapping in the window, uuids and submits reach the host in order', async () => {
  const calls: { t: string }[] = [];
  let fences = 0;
  const r = rig({ virgl: true, venus: true, window: 1 << 20 });
  r.gpu.host = { call: (c) => calls.push(JSON.parse(JSON.stringify(c, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? [...v] : v)))), fence: () => { fences++; return Promise.resolve(); } };
  r.ok(ctxCreate(3, 4, 'vkcube'));
  r.ok(blob(3, 10, 64 << 10, 1, 2, 7n));
  assert.equal(r.run(blob(3, 10, 4096)).type, ERR_RES, 'an id in use');
  assert.equal(r.run(blob(3, 11, 100)).type, ERR_PARAM, 'not whole pages');
  assert.equal(r.run(blob(3, 11, 4096, 1, 1)).type, ERR_PARAM, 'guest memory blobs are not offered');
  r.ok(blob(3, 11, 8192, 0));
  r.ok(ctxCmd(3, V.CTX_ATTACH, 10, 0));
  // MAP_BLOB: resource, padding, offset (u64): in the window, page-aligned, over no other mapping, mappable only.
  const map = (id: number, off: number) => r.run(ctxCmd(3, VN.MAP_BLOB, id, 0, BigInt(off)));
  assert.equal(map(10, (1 << 20) - 4096).type, ERR_PARAM, 'past the window');
  assert.equal(map(10, 100).type, ERR_PARAM, 'not page-aligned');
  assert.equal(map(11, 0).type, ERR_PARAM, 'not mappable');
  const m = map(10, 0x8000);
  assert.deepEqual([m.type, new DataView(m.r.buffer, m.r.byteOffset).getUint32(24, true)], [OK_MAP_INFO, 1]);
  assert.equal(map(10, 0x20000).type, ERR_PARAM, 'mapped already');
  r.ok(blob(3, 12, 4096));
  assert.equal(map(12, 0x10000).type, ERR_PARAM, 'over the first');
  assert.equal(map(12, 0x18000).type, OK_MAP_INFO);
  const uuid = r.run(cmd(VN.ASSIGN_UUID, 10, 0));
  assert.deepEqual([uuid.type, uuid.r.length, new DataView(uuid.r.buffer, uuid.r.byteOffset).getUint32(36, false)], [OK_UUID, 40, 10]);
  assert.equal(r.run(cmd(VN.ASSIGN_UUID, 99, 0)).type, ERR_RES);
  // A Venus submit is handed on as its bytes, and a fenced one on a ring answers with its ring.
  const s = submit(3, [0x11223344, 5]);
  const sv = new DataView(s.buffer);
  sv.setUint32(4, 1 | 2, true);
  sv.setBigUint64(8, 77n, true);
  sv.setUint8(20, 2);
  const sr = r.run(s);
  const rv = new DataView(sr.r.buffer, sr.r.byteOffset);
  assert.deepEqual([sr.type, rv.getUint32(4, true), rv.getBigUint64(8, true), rv.getUint8(20)], [OK, 3, 77n, 2]);
  r.ok(ctxCmd(3, VN.UNMAP_BLOB, 10, 0));
  assert.equal(r.run(ctxCmd(3, VN.UNMAP_BLOB, 10, 0)).type, ERR_PARAM, 'not mapped');
  r.ok(cmd(T.UNREF, 12, 0));
  assert.equal(r.run(cmd(VN.SCANOUT_BLOB)).type, ERR_UNSPEC);
  assert.deepEqual(calls.map((c) => c.t), ['vctx', 'blob', 'blob', 'blob-ctx', 'blob-map', 'blob', 'blob-map', 'vsubmit', 'blob-unmap', 'blob-unref']);
  assert.deepEqual(calls[0], { t: 'vctx', id: 3, create: true, name: 'vkcube' });
  assert.deepEqual(calls[1], { t: 'blob', ctx: 3, res: 10, mem: 2, flags: 1, blobId: '7n', size: 65536 });
  assert.deepEqual(calls[4], { t: 'blob-map', res: 10, offset: 0x8000, size: 65536 });
  assert.deepEqual(calls[7], { t: 'vsubmit', ctx: 3, bytes: [0x44, 0x33, 0x22, 0x11, 5, 0, 0, 0], fence: { flags: 3, ring: 2, id: '77n' } });
  assert.ok(fences >= 7, 'creates, maps and unmaps wait for the host');
  // Not saved while a Venus context exists (the check before a snapshot says so too); a reset forgets them.
  assert.equal((await r.gpu.save()).unsaveable?.msg?.key, 'display:gpu.unsaveable.venus');
  assert.equal((await r.gpu.refusal())?.msg?.key, 'display:gpu.unsaveable.venus');
  r.gpu.reset();
  assert.equal((await r.gpu.save()).unsaveable, undefined);
  assert.equal(await r.gpu.refusal(), undefined);
});

test('venus: a virgl resource attached to a Venus context is imported there with its size, not attached in virgl', () => {
  const calls: { t: string }[] = [];
  const r = rig({ virgl: true, venus: true, window: 1 << 20 });
  r.gpu.host = { call: (c) => calls.push(JSON.parse(JSON.stringify(c, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)))), fence: () => Promise.resolve() };
  r.ok(ctxCreate(3, 4, 'mpv'));
  r.ok(ctxCreate(4, 0, 'mpv-va'));
  r.ok(create3d(20, 2, 864, 480));
  r.ok(ctxCmd(4, V.CTX_ATTACH, 20, 0));
  r.ok(ctxCmd(3, V.CTX_ATTACH, 20, 0));
  r.ok(ctxCmd(3, V.CTX_DETACH, 20, 0));
  // A VA-API surface's plane: the virgl context attaches it, the Venus one imports it (a dma-buf of its texels at 4
  // bytes each, at least: the guest's import may say so many) and lets it go.
  assert.deepEqual(calls.filter((c) => c.t === 'ctxres' || c.t === 'blob-ctx'), [
    { t: 'ctxres', ctx: 4, res: 20, attach: true },
    { t: 'blob-ctx', ctx: 3, res: 20, attach: true, size: 864 * 480 * 4 },
    { t: 'blob-ctx', ctx: 3, res: 20, attach: false, size: 864 * 480 * 4 },
  ]);
});
