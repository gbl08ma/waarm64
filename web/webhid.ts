// The WebHID device (docs/usb.md "The WebHID device"): an emulated USB HID
// device built from what WebHID tells about a HIDDevice, its report descriptor encoded back from
// `collections` (web/hid-descriptor.ts). It is a virtual device (web/usb-virtual.ts answers chapter
// 9); this file adds the HID class requests and moves reports between the guest and the HIDDevice.
// The WebHID surface is typed locally so Node's tests can pass a fake (and a MessagePort proxy
// from the page could stand in).

import type { Setup, UsbIdentity, UsbProblem, UsbResult, UsbTransfer } from './usb-device.ts';
import { VirtualDevice, type ControlAnswer } from './usb-virtual.ts';
import {
  encodeReportDescriptor,
  normalizeCollections,
  protectedCollections,
  reportSizes,
  usesReportIds,
  visibleCollections,
  type HidCollectionInfo,
  type HidCollectionLike,
  type ReportKind,
} from './hid-descriptor.ts';
import { UsbOpenError, notFound, openFailed, pickDevice } from './webusb.ts';

export type WebHidInputReport = { reportId: number; data: DataView };

export interface WebHidDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly opened: boolean;
  readonly collections: readonly HidCollectionLike[];
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
  addEventListener(type: 'inputreport', listener: (e: WebHidInputReport) => void): void;
  removeEventListener(type: 'inputreport', listener: (e: WebHidInputReport) => void): void;
}

/** `navigator.hid`, as much of it as the opener uses. */
export interface WebHidLike {
  getDevices(): Promise<WebHidDeviceLike[]>;
  addEventListener(type: 'disconnect', listener: (e: { device: WebHidDeviceLike }) => void): void;
  removeEventListener(type: 'disconnect', listener: (e: { device: WebHidDeviceLike }) => void): void;
}

/** Input reports kept for a guest that has no IN TD queued (usbhid always has one); the oldest goes past this. */
export const INPUT_QUEUE = 32;
export const EP_IN = 0x81;
export const EP_OUT = 0x01;

const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const bytesOf = (dv: DataView) => new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength).slice();

/** What the guest sees of a HID device: its descriptors and what they were built from. */
export type HidLayout = {
  collections: HidCollectionInfo[];
  report: Uint8Array;
  ids: boolean;
  sizes: Record<ReportKind, Map<number, number>>;
  speed: 'full' | 'high';
  inMax: number;
  outMax: number;
  device: Uint8Array;
  config: Uint8Array;
  hid: Uint8Array;
};

/**
 * The descriptors of the emulated device (docs/usb.md): the vendor and product IDs, USB
 * 2.00, one HID interface (class 3, no boot subclass), an interrupt IN endpoint sized by the largest
 * input report and its ID byte (at most 1024; high speed past 64), bInterval 1 ms, and an
 * interrupt OUT endpoint when the device has output reports.
 */
export function hidLayout(vendorId: number, productId: number, collections: HidCollectionInfo[]): HidLayout {
  const report = encodeReportDescriptor(collections);
  const sizes = reportSizes(collections);
  const ids = usesReportIds(collections);
  const largest = (m: Map<number, number>) => Math.max(0, ...m.values()) + (ids && m.size ? 1 : 0);
  const inMax = Math.min(1024, Math.max(1, largest(sizes.input)));
  const outMax = sizes.output.size ? Math.min(1024, Math.max(1, largest(sizes.output))) : 0;
  const speed = inMax > 64 || outMax > 64 ? 'high' : 'full';
  const interval = speed === 'high' ? 4 : 1; // 2^(4-1) microframes = 1 ms; 1 frame = 1 ms
  const device = Uint8Array.from([
    18,
    1,
    ...u16(0x0200),
    0,
    0,
    0,
    64,
    ...u16(vendorId),
    ...u16(productId),
    ...u16(0x0100),
    0,
    1,
    2,
    1,
  ]);
  const hid = Uint8Array.from([9, 0x21, ...u16(0x0111), 0, 1, 0x22, ...u16(report.length)]);
  const eps = [
    [7, 5, EP_IN, 3, ...u16(inMax), interval],
    ...(outMax ? [[7, 5, EP_OUT, 3, ...u16(outMax), interval]] : []),
  ];
  const body = [9, 4, 0, 0, eps.length, 3, 0, 0, 0, ...hid, ...eps.flat()];
  const total = 9 + body.length;
  const config = Uint8Array.from([9, 2, ...u16(total), 1, 1, 0, 0x80, 50, ...body]);
  return { collections, report, ids, sizes, speed, inMax, outMax, device, config, hid };
}

const GET_REPORT = 0x01,
  GET_IDLE = 0x02,
  GET_PROTOCOL = 0x03,
  SET_REPORT = 0x09,
  SET_IDLE = 0x0a,
  SET_PROTOCOL = 0x0b;
const KINDS: Record<number, ReportKind> = { 1: 'input', 2: 'output', 3: 'feature' };

type InTd = { tag: number; length: number; done: (r: UsbResult) => void };

export type WebHidOptions = {
  /** The serial number the guest sees: fixed per connector, so its udev names stay stable. */
  serial?: string;
};

export class WebHidDevice extends VirtualDevice {
  readonly dev: WebHidDeviceLike;
  readonly layout: HidLayout;
  /** The collections WebHID keeps (part of) from the page, which the guest doesn't get either. */
  problems: UsbProblem[] = [];
  private tds: InTd[] = [];
  private reports: Uint8Array[] = [];
  private last = new Map<string, Uint8Array>();
  private idle = 0;
  private outChain: Promise<unknown> = Promise.resolve();
  private onInput = (e: WebHidInputReport) => this.input(e.reportId, bytesOf(e.data));

  constructor(dev: WebHidDeviceLike, layout: HidLayout, opts: WebHidOptions = {}) {
    super(layout.speed, {
      device: layout.device,
      configs: [layout.config],
      strings: [dev.productName || 'HID device', opts.serial ?? 'waarm64-hid'],
      extra: (type, index) =>
        index !== 0 ? undefined : type === 0x21 ? layout.hid : type === 0x22 ? layout.report : undefined,
    });
    this.dev = dev;
    this.layout = layout;
    dev.addEventListener('inputreport', this.onInput);
  }

  /** A report as the guest sees it: the ID byte first when the device numbers its reports. */
  private framed(id: number, data: Uint8Array): Uint8Array {
    if (!this.layout.ids) return data;
    const b = new Uint8Array(data.length + 1);
    b[0] = id;
    b.set(data, 1);
    return b;
  }

  private input(id: number, data: Uint8Array) {
    if (this.gone) return;
    const r = this.framed(id, data);
    this.last.set(`input:${id}`, r);
    const td = this.tds.shift();
    if (td) return td.done(fit(r, td.length));
    this.reports.push(r);
    if (this.reports.length > INPUT_QUEUE) this.reports.shift();
  }

  /** An OUT report's ID and payload: the guest puts the ID first when the device uses IDs. */
  private split(data: Uint8Array, id?: number): [number, Uint8Array] {
    if (!this.layout.ids) return [id ?? 0, data];
    return [data[0] ?? id ?? 0, data.subarray(1)];
  }

  protected override control(s: Setup, data?: Uint8Array): ControlAnswer | Promise<ControlAnswer> {
    if ((s.requestType & 0x60) !== 0x20 || (s.requestType & 0x1f) !== 1 || (s.index & 0xff) !== 0) return undefined;
    const kind = KINDS[s.value >> 8],
      id = s.value & 0xff;
    switch (s.request) {
      case GET_REPORT: {
        if (!kind) return undefined;
        if (kind === 'feature') {
          // Chromium's buffer already starts with the report ID when the device uses IDs (and has none otherwise): as the guest wants it.
          return this.dev.receiveFeatureReport(id).then(
            (dv) => bytesOf(dv),
            () => undefined,
          );
        }
        const size = this.layout.sizes[kind].get(id);
        if (size === undefined) return undefined;
        return this.last.get(`${kind}:${id}`) ?? this.framed(id, new Uint8Array(size));
      }
      case SET_REPORT: {
        if (kind !== 'output' && kind !== 'feature') return undefined;
        const [rid, payload] = this.split(data ?? new Uint8Array(0), id);
        const send =
          kind === 'output'
            ? this.dev.sendReport(rid, payload as Uint8Array<ArrayBuffer>)
            : this.dev.sendFeatureReport(rid, payload as Uint8Array<ArrayBuffer>);
        if (kind === 'output') this.last.set(`output:${rid}`, this.framed(rid, payload.slice()));
        return send.then(
          () => true,
          () => undefined,
        );
      }
      case SET_IDLE:
        this.idle = s.value >> 8;
        return true;
      case GET_IDLE:
        return Uint8Array.of(this.idle);
      case SET_PROTOCOL:
        return true;
      case GET_PROTOCOL:
        return Uint8Array.of(1); // the report protocol: no boot protocol is offered
      default:
        return undefined;
    }
  }

  protected override transfer(t: UsbTransfer, done: (r: UsbResult) => void): void {
    if (t.ep === EP_IN) {
      const r = this.reports.shift();
      if (r) return done(fit(r, t.length));
      this.tds.push({ tag: t.tag, length: t.length, done });
      return;
    }
    if (t.ep === EP_OUT) {
      const data = t.data ?? new Uint8Array(0);
      const [id, payload] = this.split(data);
      const p = this.outChain.then(() => this.dev.sendReport(id, payload as Uint8Array<ArrayBuffer>));
      this.outChain = p.catch(() => {});
      this.last.set(`output:${id}`, this.framed(id, payload.slice()));
      p.then(
        () => {
          if (!this.gone) done({ code: 'success', actual: data.length });
        },
        () => {
          if (!this.gone) done({ code: 'stall', actual: 0 });
        },
      );
      return;
    }
    done({ code: 'error', actual: 0 });
  }

  protected override cancelled(ep: number, tags: number[]): void {
    if (ep === EP_IN) this.tds = this.tds.filter((t) => !tags.includes(t.tag));
  }

  override reset(): void {
    this.tds = [];
    this.reports = [];
    this.idle = 0;
    super.reset();
  }

  override detach(): void {
    if (this.gone) return;
    super.detach();
    this.tds = [];
    this.reports = [];
    this.dev.removeEventListener('inputreport', this.onInput);
    this.dev.close().catch(() => {});
  }
}

/** An IN report for a TD of `length` bytes (a longer one is cut, as the endpoint's packet size would). */
function fit(r: Uint8Array, length: number): UsbResult {
  const data = r.length > length ? r.subarray(0, length) : r;
  return { code: data.length < length ? 'short' : 'success', actual: data.length, data };
}

/** Opens `dev` (if it isn't) and builds the guest's device; a device whose every collection WebHID hides has nothing to build from. */
export async function openWebHid(dev: WebHidDeviceLike, opts: WebHidOptions = {}): Promise<WebHidDevice> {
  // Only what the page can use: a protected collection's input and output reports never arrive and can't be sent.
  const all = normalizeCollections(dev.collections);
  const collections = visibleCollections(all);
  if (collections.length === 0)
    throw new UsbOpenError('usb:webhid.noCollections', undefined, [{ kind: 'no-collections' }]);
  try {
    if (!dev.opened) await dev.open();
  } catch (e) {
    throw openFailed(e);
  }
  const d = new WebHidDevice(dev, hidLayout(dev.vendorId, dev.productId, collections), opts);
  d.problems = protectedCollections(all).map((c): UsbProblem => ({ kind: 'protected-collection', ...c }));
  return d;
}

/**
 * The device worker's opener for `api: 'hid'` identities: the granted device by vendor and product
 * (`index` among identical ones; WebHID gives no serial number), opened, with `gone` called when
 * WebHID reports it disconnected.
 */
export function webHidOpener(hid: WebHidLike) {
  return async (id: UsbIdentity, ctx: { gone?: () => void; connector?: number } = {}): Promise<WebHidDevice> => {
    const devs = (await hid.getDevices()).map((d) => ({ d, vendorId: d.vendorId, productId: d.productId }));
    const dev = pickDevice(devs, { ...id, serialNumber: undefined })?.d;
    if (!dev) throw notFound();
    let fired = false;
    const onDisconnect = (e: { device: WebHidDeviceLike }) => {
      if (e.device !== dev || fired) return;
      fired = true;
      hid.removeEventListener('disconnect', onDisconnect);
      ctx.gone?.();
    };
    hid.addEventListener('disconnect', onDisconnect);
    try {
      return await openWebHid(dev, { serial: `waarm64-hid-${ctx.connector ?? 0}` });
    } catch (e) {
      hid.removeEventListener('disconnect', onDisconnect);
      throw e;
    }
  };
}
