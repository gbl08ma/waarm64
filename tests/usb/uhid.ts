// HID test devices through the kernel's uhid (/dev/uhid; docs/plans/usb.md §5): each UhidDevice is one HID device
// made from a report descriptor, seen by the host as a hidraw node and by Chromium's WebHID as a HID device. It
// sends input reports and answers GET_REPORT and SET_REPORT; output reports and feature writes are recorded.
// Needs read and write on /dev/uhid (tests/usb/gadget.sh install's udev rule).
//
// Node opens the node non-blocking and polls it every few milliseconds: a blocking read would hold one of libuv's
// four pool threads per device. The event layout is struct uhid_event from include/uapi/linux/uhid.h (packed: a u32
// type, then the request; UHID_CREATE2's is the largest, 4,372 bytes).
//
//   node tests/usb/uhid.ts [name...]   creates the named devices of tests/usb/hid-descriptors.ts and keeps them until
//                                      killed, printing what the host sends them
import { closeSync, constants, existsSync, openSync, readdirSync, readFileSync, readSync, writeSync } from 'node:fs';
import { DESCRIPTORS, type HidDescriptor } from './hid-descriptors.ts';

const EVENT_SIZE = 4 + 4372;
const DATA_MAX = 4096;
const T = { DESTROY: 1, START: 2, STOP: 3, OPEN: 4, CLOSE: 5, OUTPUT: 6, GET_REPORT: 9, GET_REPORT_REPLY: 10, CREATE2: 11, INPUT2: 12, SET_REPORT: 13, SET_REPORT_REPLY: 14 } as const;
/** uhid's report types (enum uhid_report_type). */
export const RTYPE = { feature: 0, output: 1, input: 2 } as const;
const RTYPE_NAME = ['feature', 'output', 'input'] as const;
const BUS_USB = 3;

export type HostWrite = { kind: 'output' | 'set-feature' | 'set-output'; data: Uint8Array };

export function uhidUsable(): string | undefined {
  if (!existsSync('/dev/uhid')) return 'no /dev/uhid (modprobe uhid)';
  try {
    closeSync(openSync('/dev/uhid', constants.O_RDWR | constants.O_NONBLOCK));
  } catch (e) {
    return `can't open /dev/uhid: ${(e as Error).message} (tests/usb/gadget.sh install)`;
  }
}

export class UhidDevice {
  readonly d: HidDescriptor;
  private fd: number;
  private timer: ReturnType<typeof setInterval>;
  private buf = Buffer.alloc(EVENT_SIZE);
  /** Feature reports by ID, what GET_REPORT(feature) answers (the first data byte is the ID when the device has IDs). */
  features = new Map<number, Uint8Array>();
  /** What the host sent: output reports (interrupt OUT or SET_REPORT(output)) and SET_REPORT(feature). */
  writes: HostWrite[] = [];
  started = false;
  opened = 0;
  private waiters: (() => void)[] = [];

  constructor(d: HidDescriptor, opts: { uniq?: string; phys?: string } = {}) {
    this.d = d;
    this.fd = openSync('/dev/uhid', constants.O_RDWR | constants.O_NONBLOCK);
    for (const [id, data] of d.features ?? []) this.features.set(id, data);
    const ev = Buffer.alloc(EVENT_SIZE);
    ev.writeUInt32LE(T.CREATE2, 0);
    ev.write(d.name, 4, 127, 'utf8');
    ev.write(opts.phys ?? `webpc-uhid/${d.id}`, 4 + 128, 63, 'utf8');
    ev.write(opts.uniq ?? '', 4 + 192, 63, 'utf8');
    ev.writeUInt16LE(d.rdesc.length, 4 + 256);
    ev.writeUInt16LE(BUS_USB, 4 + 258);
    ev.writeUInt32LE(d.vendorId, 4 + 260);
    ev.writeUInt32LE(d.productId, 4 + 264);
    ev.writeUInt32LE(d.version ?? 0x0100, 4 + 268);
    ev.writeUInt32LE(0, 4 + 272);
    Buffer.from(d.rdesc).copy(ev, 4 + 276);
    writeSync(this.fd, ev);
    this.timer = setInterval(() => this.poll(), 2);
  }

  /** An input report as the device would send it (with its ID byte first when the device uses IDs). */
  input(report: Uint8Array) {
    const ev = Buffer.alloc(4 + 2 + report.length);
    ev.writeUInt32LE(T.INPUT2, 0);
    ev.writeUInt16LE(report.length, 4);
    Buffer.from(report).copy(ev, 6);
    writeSync(this.fd, ev);
  }

  /** Resolves once the host has opened the hidraw node or bound a driver that reads (UHID_OPEN). */
  whenOpened(): Promise<void> {
    return this.opened > 0 ? Promise.resolve() : new Promise((r) => this.waiters.push(r));
  }

  /** The hidraw node the kernel made for this device, once it has started. */
  hidraw(): string | undefined {
    const base = '/sys/devices/virtual/misc/uhid';
    if (!existsSync(base)) return;
    for (const dev of readdirSync(base)) {
      const [bus, vid, pid] = dev.split(/[:.]/);
      if (Number.parseInt(bus, 16) !== BUS_USB || Number.parseInt(vid, 16) !== this.d.vendorId || Number.parseInt(pid, 16) !== this.d.productId) continue;
      try {
        if (!readFileSync(`${base}/${dev}/uevent`, 'utf8').includes(`HID_PHYS=webpc-uhid/${this.d.id}`)) continue;
        const nodes = readdirSync(`${base}/${dev}/hidraw`);
        if (nodes.length) return `/dev/${nodes[0]}`;
      } catch {
        // gone in between
      }
    }
  }

  private poll() {
    for (;;) {
      let n: number;
      try {
        n = readSync(this.fd, this.buf, 0, EVENT_SIZE, null);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EAGAIN') return;
        throw e;
      }
      if (n < 4) return;
      this.event(this.buf.subarray(0, n));
    }
  }

  private event(ev: Buffer) {
    const type = ev.readUInt32LE(0);
    switch (type) {
      case T.START: this.started = true; break;
      case T.STOP: this.started = false; break;
      case T.OPEN:
        this.opened++;
        for (const w of this.waiters.splice(0)) w();
        break;
      case T.CLOSE: this.opened--; break;
      case T.OUTPUT: {
        // struct uhid_output_req: data[4096], u16 size, u8 rtype.
        const size = ev.readUInt16LE(4 + DATA_MAX);
        this.writes.push({ kind: 'output', data: new Uint8Array(ev.subarray(4, 4 + size)) });
        break;
      }
      case T.GET_REPORT: {
        // struct uhid_get_report_req: u32 id, u8 rnum, u8 rtype. Reply: u32 id, u16 err, u16 size, data.
        const id = ev.readUInt32LE(4), rnum = ev[8], rtype = ev[9];
        const data = rtype === RTYPE.feature ? this.features.get(rnum) : undefined;
        const r = Buffer.alloc(4 + 8 + (data?.length ?? 0));
        r.writeUInt32LE(T.GET_REPORT_REPLY, 0);
        r.writeUInt32LE(id, 4);
        r.writeUInt16LE(data ? 0 : 5 /* EIO */, 8);
        r.writeUInt16LE(data?.length ?? 0, 10);
        if (data) Buffer.from(data).copy(r, 12);
        writeSync(this.fd, r);
        break;
      }
      case T.SET_REPORT: {
        // struct uhid_set_report_req: u32 id, u8 rnum, u8 rtype, u16 size, data. Reply: u32 id, u16 err.
        const id = ev.readUInt32LE(4), rnum = ev[8], rtype = ev[9], size = ev.readUInt16LE(10);
        const data = new Uint8Array(ev.subarray(12, 12 + size));
        this.writes.push({ kind: rtype === RTYPE.feature ? 'set-feature' : 'set-output', data });
        if (rtype === RTYPE.feature) this.features.set(rnum, data);
        const r = Buffer.alloc(4 + 6);
        r.writeUInt32LE(T.SET_REPORT_REPLY, 0);
        r.writeUInt32LE(id, 4);
        writeSync(this.fd, r);
        break;
      }
    }
  }

  destroy() {
    clearInterval(this.timer);
    const ev = Buffer.alloc(4);
    ev.writeUInt32LE(T.DESTROY, 0);
    try {
      writeSync(this.fd, ev);
    } finally {
      closeSync(this.fd);
    }
  }
}

export const reportTypeName = (t: number) => RTYPE_NAME[t];

if (import.meta.main) {
  const why = uhidUsable();
  if (why) {
    console.error(`uhid.ts: ${why}`);
    process.exit(1);
  }
  const names = process.argv.slice(2);
  const pick = names.length ? names.map((n) => DESCRIPTORS.find((d) => d.id === n) ?? (console.error(`unknown: ${n} (${DESCRIPTORS.map((d) => d.id).join(', ')})`), process.exit(2))) : DESCRIPTORS;
  const devs = pick.map((d) => new UhidDevice(d));
  setTimeout(() => {
    for (const u of devs) console.log(`${u.d.id} ${u.d.vendorId.toString(16).padStart(4, '0')}:${u.d.productId.toString(16).padStart(4, '0')} ${u.hidraw() ?? '(no hidraw yet)'}`);
  }, 300);
  setInterval(() => {
    for (const u of devs) for (const w of u.writes.splice(0)) console.log(`${u.d.id} ${w.kind} ${Buffer.from(w.data).toString('hex')}`);
  }, 100);
  const stop = () => { for (const u of devs) u.destroy(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
