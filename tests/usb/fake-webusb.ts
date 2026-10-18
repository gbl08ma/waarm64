// A scripted WebUSB device for the passthrough's tests: answers GET_DESCRIPTOR from a fixture's raw
// descriptors, refuses to claim protected classes (as Chromium) and the interfaces a "host driver"
// holds, and leaves every bulk or interrupt IN pending until the test resolves it.

import { PROTECTED_CLASSES, parseConfig, type ConfigInfo, type WebUsbDeviceLike, type WebUsbInResult, type WebUsbOutResult, type WebUsbSetup } from '../../web/webusb.ts';
import type { Fixture } from './webusb-fixtures.ts';

type Pending = { length: number; resolve: (r: WebUsbInResult) => void; reject: (e: Error) => void };

const err = (name: string, message: string) => Object.assign(new Error(message), { name });
const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export class FakeUsb implements WebUsbDeviceLike {
  vendorId: number;
  productId: number;
  serialNumber: string | null = null;
  productName: string | null = null;
  opened = false;
  cfgValue: number | null;
  claimedSet = new Set<number>();
  hostHeld: Set<number>;
  log: string[] = [];
  /** Pending transferIn calls by endpoint number. */
  ins = new Map<number, Pending[]>();
  outs: { ep: number; data: Uint8Array }[] = [];
  /** The result of the next transferOut calls (default: everything written). */
  outScript: ((ep: number, data: Uint8Array) => Promise<WebUsbOutResult>) | null = null;
  /** Non-descriptor control IN requests. */
  controlIn: (s: WebUsbSetup, length: number) => Promise<WebUsbInResult> = async () => ({ status: 'stall' });
  controlOuts: { setup: WebUsbSetup; data: Uint8Array }[] = [];
  resetFails = false;
  fx: Fixture;
  parsed: ConfigInfo[];

  constructor(fx: Fixture, o: { configured?: boolean; hostHeld?: number[]; serial?: string } = {}) {
    this.fx = fx;
    this.vendorId = fx.device[8] | (fx.device[9] << 8);
    this.productId = fx.device[10] | (fx.device[11] << 8);
    this.serialNumber = o.serial ?? null;
    this.parsed = fx.configs.map(parseConfig);
    this.cfgValue = o.configured === false ? null : this.parsed[0].value;
    this.hostHeld = new Set(o.hostHeld ?? []);
  }

  get configuration() {
    if (this.cfgValue === null) return null;
    const c = this.parsed.find((p) => p.value === this.cfgValue)!;
    return {
      configurationValue: c.value,
      interfaces: [...c.interfaces.keys()].map((n) => ({ interfaceNumber: n, claimed: this.claimedSet.has(n) })),
    };
  }

  async open() { this.opened = true; this.log.push('open'); }
  async close() { this.opened = false; this.log.push('close'); }
  async selectConfiguration(v: number) {
    this.log.push(`selectConfiguration ${v}`);
    if (!this.parsed.some((p) => p.value === v)) throw err('NotFoundError', 'no such configuration');
    this.cfgValue = v;
    this.claimedSet.clear();
  }
  async claimInterface(n: number) {
    const alts = this.parsed.find((p) => p.value === this.cfgValue)?.interfaces.get(n);
    if (!alts) throw err('NotFoundError', 'no such interface');
    if (alts.some((a) => PROTECTED_CLASSES.has(a.cls))) throw err('SecurityError', 'The requested interface implements a protected class.');
    if (this.hostHeld.has(n)) throw err('NetworkError', 'Unable to claim interface.');
    this.log.push(`claim ${n}`);
    this.claimedSet.add(n);
  }
  async releaseInterface(n: number) { this.log.push(`release ${n}`); this.claimedSet.delete(n); }
  async selectAlternateInterface(n: number, alt: number) { this.log.push(`alt ${n} ${alt}`); }
  async clearHalt(dir: 'in' | 'out', n: number) { this.log.push(`clearHalt ${dir} ${n}`); }
  async reset() {
    this.log.push('reset');
    if (this.resetFails) throw err('NotFoundError', 'gone');
  }

  async controlTransferIn(s: WebUsbSetup, length: number): Promise<WebUsbInResult> {
    if (s.requestType === 'standard' && s.recipient === 'device' && s.request === 6) {
      const type = s.value >> 8, index = s.value & 0xff;
      let b: Uint8Array | undefined;
      if (type === 1) b = this.fx.device;
      else if (type === 2) b = this.fx.configs[index];
      else if (type === 0x0f) b = this.fx.bos;
      else if (type === 3) b = this.fx.strings.get(index === 0 ? '0:0' : `${index}:${s.index}`);
      this.log.push(`get ${type}:${index}:${s.index}`);
      if (!b) return { status: 'stall' };
      return { status: 'ok', data: dv(b.slice(0, length)) };
    }
    this.log.push(`controlIn ${s.requestType}/${s.recipient} ${s.request} ${s.value} ${s.index} ${length}`);
    return this.controlIn(s, length);
  }

  async controlTransferOut(s: WebUsbSetup, data?: BufferSource): Promise<WebUsbOutResult> {
    const b = data ? new Uint8Array(data as ArrayBuffer).slice() : new Uint8Array(0);
    this.controlOuts.push({ setup: s, data: b });
    this.log.push(`controlOut ${s.requestType}/${s.recipient} ${s.request} ${s.value} ${s.index} ${b.length}`);
    return { status: 'ok', bytesWritten: b.length };
  }

  transferIn(n: number, length: number): Promise<WebUsbInResult> {
    return new Promise((resolve, reject) => {
      const q = this.ins.get(n) ?? [];
      q.push({ length, resolve, reject });
      this.ins.set(n, q);
    });
  }

  /** Resolves the oldest pending transferIn on endpoint `n`. */
  answer(n: number, r: { data?: Uint8Array; status?: 'ok' | 'stall' | 'babble' } | Error) {
    const p = this.ins.get(n)?.shift();
    if (!p) throw new Error(`no transferIn pending on ${n}`);
    if (r instanceof Error) p.reject(r);
    else p.resolve({ status: r.status ?? 'ok', data: r.data ? dv(r.data) : undefined });
  }

  pending(n: number) { return this.ins.get(n)?.length ?? 0; }

  transferOut(n: number, data: BufferSource): Promise<WebUsbOutResult> {
    const b = new Uint8Array(data as ArrayBuffer).slice();
    this.outs.push({ ep: n, data: b });
    if (this.outScript) return this.outScript(n, b);
    return Promise.resolve({ status: 'ok', bytesWritten: b.length });
  }
}

export { err as namedError };
