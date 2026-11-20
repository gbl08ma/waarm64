// virtio-rtc (virtio 1.4 §5.22; Linux's virtio_rtc, 6.16 and later; docs/devices.md "virtio-rtc"): one clock, UTC as
// the browser keeps it, read at every request. The guest gets a PTP clock from it (chrony's `refclock PHC`, which then
// follows the browser's clock: across a snapshot, the host's own sleep, its NTP) and a read-only RTC. No alarms (the
// ALARM feature is off: one queue) and no cross-timestamps (CROSS_CAP says so: chrony brackets plain reads instead).

/** The device ID (`VIRTIO_ID_CLOCK`). */
export const CLOCK_ID = 17;

// Requests (le16 msg_type at 0; a clock's le16 id at 8).
const READ = 0x0001;
const READ_CROSS = 0x0002;
const CFG = 0x1000;
const CLOCK_CAP = 0x1001;
const CROSS_CAP = 0x1002;
// Status (u8 at 0 of a response's 8-byte head).
const OK = 0;
const EOPNOTSUPP = 2;
const ENODEV = 3;
const EINVAL = 4;
/**
 * The clock's type, UTC_SMEARED (with the smearing unspecified): the browser's clock has no leap seconds (a JavaScript
 * time value never shows 23:59:60), and Linux makes its RTC device only for this type (it may step otherwise).
 */
const UTC_SMEARED = 3;

/**
 * The response to one request (its bytes: what the device writes), with `now` the clock's reading in ns since the
 * epoch. A response that isn't OK is its head alone (the driver takes any other size as an error).
 */
export function clockAnswer(req: Uint8Array, now: () => bigint): Uint8Array {
  const err = (status: number) => Uint8Array.of(status, 0, 0, 0, 0, 0, 0, 0);
  if (req.length < 8) return err(EINVAL);
  const v = new DataView(req.buffer, req.byteOffset, req.length);
  const type = v.getUint16(0, true);
  const out = new Uint8Array(16); // every OK response here is 16 bytes: the head, then 8 of fields
  const o = new DataView(out.buffer);
  if (type === CFG) {
    o.setUint16(8, 1, true); // num_clocks
    return out;
  }
  if (type !== READ && type !== READ_CROSS && type !== CLOCK_CAP && type !== CROSS_CAP) return err(EOPNOTSUPP); // the alarm requests too
  if (req.length < 16) return err(EINVAL);
  if (v.getUint16(8, true) !== 0) return err(ENODEV);
  switch (type) {
    case READ:
      o.setBigUint64(8, now(), true);
      return out;
    case CLOCK_CAP:
      out[8] = UTC_SMEARED; // leap_second_smearing 0 (unspecified), flags 0 (no alarm)
      return out;
    case CROSS_CAP:
      return out; // flags 0: no counter cross-timestamps
    default:
      return err(EOPNOTSUPP); // READ_CROSS
  }
}

/** The answer's status: OK, or the error a request got (for tests). */
export const clockStatus = (answer: Uint8Array) =>
  answer[0] === OK
    ? 'ok'
    : ({ [EOPNOTSUPP]: 'eopnotsupp', [ENODEV]: 'enodev', [EINVAL]: 'einval' } as Record<number, string>)[answer[0]];

/**
 * The browser's wall clock in ns: `performance.now()`'s resolution (µs) on `Date.now()`'s time, anchored again when
 * the two part by more than 2 ms (`Date.now()` is in whole ms): a step of the host's clock (its NTP, its own sleep,
 * which `performance.now()` may not count) shows at once.
 */
export function browserClock(): () => bigint {
  const mono = () => performance.timeOrigin + performance.now();
  let offset = Date.now() + 0.5 - mono();
  return () => {
    const m = mono();
    const d = Date.now() + 0.5 - m;
    if (Math.abs(d - offset) > 2) offset = d;
    return BigInt(Math.round((m + offset) * 1000)) * 1000n;
  };
}
