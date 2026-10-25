// virtio-rtc's protocol (web/clock.ts), as Linux's virtio_rtc driver speaks it: the messages it sends at probe and on
// a read, and the sizes it checks (an OK response fills the response's struct; an error is the head alone).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserClock, clockAnswer, clockStatus } from '../web/clock.ts';

/** A request: msg_type, then (for the per-clock ones) the clock's id at 8; 16 bytes, as the driver's structs are. */
const req = (type: number, clock = 0) => {
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  v.setUint16(0, type, true);
  v.setUint16(8, clock, true);
  return b;
};
const NOW = 1_792_950_000_123_456_789n;
const ask = (b: Uint8Array) => clockAnswer(b, () => NOW);
const u16 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint16(at, true);

test('the driver finds one clock, UTC with smeared leap seconds, without alarms or cross-timestamps', () => {
  const cfg = ask(req(0x1000));
  assert.equal(cfg.length, 16);
  assert.equal(clockStatus(cfg), 'ok');
  assert.equal(u16(cfg, 8), 1, 'num_clocks');
  const cap = ask(req(0x1001));
  assert.deepEqual([cap.length, ...cap.subarray(8, 11)], [16, 3, 0, 0], 'UTC_SMEARED, unspecified smearing, no ALARM_CAP');
  const cross = ask(req(0x1002));
  assert.deepEqual([cross.length, cross[0], cross[8]], [16, 0, 0], 'not cross-capable');
});

test('a read gives the clock in ns; what the device lacks is refused with the head alone', () => {
  const r = ask(req(0x0001));
  assert.equal(r.length, 16);
  assert.equal(new DataView(r.buffer).getBigUint64(8, true), NOW);
  for (const [b, why] of [[req(0x0001, 1), 'enodev'], [req(0x1001, 2), 'enodev'], [req(0x0002), 'eopnotsupp'], [req(0x1003), 'eopnotsupp'], [req(0x1004), 'eopnotsupp'], [req(0x7777), 'eopnotsupp'], [new Uint8Array(4), 'einval'], [req(0x0001).subarray(0, 8), 'einval']] as const) {
    const a = ask(b);
    assert.deepEqual([a.length, clockStatus(a)], [8, why], `${u16(b, 0).toString(16)}`);
  }
});

test("the browser's clock reads the wall clock with sub-millisecond steps", () => {
  const now = browserClock();
  const [a, b] = [now(), now()];
  assert.ok(b >= a);
  const ms = Number(a / 1_000_000n);
  assert.ok(Math.abs(ms - Date.now()) < 5, `${ms} vs ${Date.now()}`);
});
