// HID report descriptors (HID 1.11 §6.2.2) to and from WebHID's parsed form (docs/plans/usb.md §4
// "The WebHID backend", docs/usb.md). WebHID gives a page `HIDDevice.collections`, the descriptor
// already parsed; the emulated device needs bytes again. `encodeReportDescriptor` writes them:
// each collection with its usage, its reports' items with the globals that changed and the locals
// they carry, report IDs where the device uses them. `parseReportDescriptor` reads a descriptor into
// the same shape the way Chromium does (an item belongs to its innermost collection, grouped into
// reports by type and ID), so a round trip can be checked and a raw descriptor compared with
// Chromium's parse.
//
// What the parsed form doesn't keep, the encoder can't restore: push and pop, delimiters, the
// original order of global items, string indices (WebHID resolves no strings), and, where one report
// ID's items are split between a collection and its children, how they interleaved (WebHID lists a
// collection's own items apart from its children's). The encoder puts children first by default
// (`childrenFirst`), which is what the descriptors that mix the two mostly do; a report's size is the
// same either way.

export type HidUnitSystem = 'none' | 'si-linear' | 'si-rotation' | 'english-linear' | 'english-rotation' | 'vendor-defined' | 'reserved';

/** WebHID's HIDReportItem (the fields the encoder uses; usages are extended: page << 16 | id). */
export type HidReportItem = {
  isAbsolute: boolean;
  isArray: boolean;
  isBufferedBytes: boolean;
  isConstant: boolean;
  isLinear: boolean;
  isRange: boolean;
  isVolatile: boolean;
  hasNull: boolean;
  hasPreferredState: boolean;
  wrap: boolean;
  usages: number[];
  usageMinimum: number;
  usageMaximum: number;
  reportSize: number;
  reportCount: number;
  unitExponent: number;
  unitSystem: HidUnitSystem;
  unitFactorLengthExponent: number;
  unitFactorMassExponent: number;
  unitFactorTimeExponent: number;
  unitFactorTemperatureExponent: number;
  unitFactorCurrentExponent: number;
  unitFactorLuminousIntensityExponent: number;
  logicalMinimum: number;
  logicalMaximum: number;
  physicalMinimum: number;
  physicalMaximum: number;
  strings: string[];
};

export type HidReportInfo = { reportId: number; items: HidReportItem[] };

export type HidCollectionInfo = {
  usagePage: number;
  usage: number;
  type: number;
  children: HidCollectionInfo[];
  inputReports: HidReportInfo[];
  outputReports: HidReportInfo[];
  featureReports: HidReportInfo[];
};

export type ReportKind = 'input' | 'output' | 'feature';

/** An item with WebHID's defaults (a data, variable, absolute, linear item with a preferred state) under `o`. */
export function hidItem(o: Partial<HidReportItem>): HidReportItem {
  return {
    isAbsolute: true, isArray: false, isBufferedBytes: false, isConstant: false, isLinear: true, isRange: false, isVolatile: false,
    hasNull: false, hasPreferredState: true, wrap: false, usages: [], usageMinimum: 0, usageMaximum: 0, reportSize: 0, reportCount: 0,
    unitExponent: 0, unitSystem: 'none', unitFactorLengthExponent: 0, unitFactorMassExponent: 0, unitFactorTimeExponent: 0,
    unitFactorTemperatureExponent: 0, unitFactorCurrentExponent: 0, unitFactorLuminousIntensityExponent: 0,
    logicalMinimum: 0, logicalMaximum: 0, physicalMinimum: 0, physicalMaximum: 0, strings: [], ...o,
  };
}

/** WebHID's HIDCollectionInfo as the browser gives it: a dictionary whose members may be missing. */
export type HidCollectionLike = {
  usagePage?: number; usage?: number; type?: number;
  children?: readonly HidCollectionLike[];
  inputReports?: readonly HidReportLike[]; outputReports?: readonly HidReportLike[]; featureReports?: readonly HidReportLike[];
};
export type HidReportLike = { reportId?: number; items?: readonly Partial<HidReportItem>[] };

/** WebHID's objects (DOM dictionaries, possibly with missing members) as plain values with every field. */
export function normalizeCollections(cs: readonly HidCollectionLike[]): HidCollectionInfo[] {
  const reports = (rs: readonly HidReportLike[] | undefined): HidReportInfo[] =>
    (rs ?? []).map((r) => ({ reportId: r.reportId ?? 0, items: (r.items ?? []).map((i) => hidItem({ ...i, usages: [...(i.usages ?? [])], strings: [...(i.strings ?? [])] })) }));
  return cs.map((c) => ({
    usagePage: c.usagePage ?? 0,
    usage: c.usage ?? 0,
    type: c.type ?? 0,
    children: normalizeCollections(c.children ?? []),
    inputReports: reports(c.inputReports),
    outputReports: reports(c.outputReports),
    featureReports: reports(c.featureReports),
  }));
}

// Item tags (HID 1.11 §6.2.2.4–8): type 0 main, 1 global, 2 local.
const MAIN = 0, GLOBAL = 1, LOCAL = 2;
const T_INPUT = 8, T_OUTPUT = 9, T_COLLECTION = 0xa, T_FEATURE = 0xb, T_END_COLLECTION = 0xc;
const G_USAGE_PAGE = 0, G_LOGICAL_MIN = 1, G_LOGICAL_MAX = 2, G_PHYSICAL_MIN = 3, G_PHYSICAL_MAX = 4, G_UNIT_EXPONENT = 5;
const G_UNIT = 6, G_REPORT_SIZE = 7, G_REPORT_ID = 8, G_REPORT_COUNT = 9, G_PUSH = 0xa, G_POP = 0xb;
const L_USAGE = 0, L_USAGE_MIN = 1, L_USAGE_MAX = 2;
const MAIN_TAG: Record<ReportKind, number> = { input: T_INPUT, output: T_OUTPUT, feature: T_FEATURE };

const UNIT_SYSTEMS: HidUnitSystem[] = ['none', 'si-linear', 'si-rotation', 'english-linear', 'english-rotation'];
const unitNibble = (s: HidUnitSystem) => (s === 'vendor-defined' ? 0xf : s === 'reserved' ? 0x5 : UNIT_SYSTEMS.indexOf(s));
const unitSystemOf = (n: number): HidUnitSystem => (n === 0xf ? 'vendor-defined' : UNIT_SYSTEMS[n] ?? 'reserved');
const FACTORS = ['unitFactorLengthExponent', 'unitFactorMassExponent', 'unitFactorTimeExponent', 'unitFactorTemperatureExponent',
  'unitFactorCurrentExponent', 'unitFactorLuminousIntensityExponent'] as const;
const nibble = (v: number) => ((v << 28) >> 28);

function unitWord(i: HidReportItem): number {
  let w = unitNibble(i.unitSystem) & 0xf;
  FACTORS.forEach((f, k) => { w |= (i[f] & 0xf) << (4 * (k + 1)); });
  return w >>> 0;
}

class Writer {
  out: number[] = [];
  item(type: number, tag: number, data: number[]) {
    const code = data.length === 4 ? 3 : data.length;
    this.out.push((tag << 4) | (type << 2) | code, ...data);
  }
  unsigned(type: number, tag: number, v: number) {
    v >>>= 0;
    this.item(type, tag, v <= 0xff ? [v] : v <= 0xffff ? [v & 0xff, v >> 8] : le32(v));
  }
  signed(type: number, tag: number, v: number) {
    v |= 0;
    this.item(type, tag, v >= -0x80 && v <= 0x7f ? [v & 0xff] : v >= -0x8000 && v <= 0x7fff ? [v & 0xff, (v >> 8) & 0xff] : le32(v));
  }
}
const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

type Globals = {
  usagePage: number; logicalMinimum: number; logicalMaximum: number; physicalMinimum: number; physicalMaximum: number;
  unitExponent: number; unit: number; reportSize: number; reportId: number; reportCount: number;
};
const initialGlobals = (): Globals => ({
  usagePage: -1, logicalMinimum: 0, logicalMaximum: 0, physicalMinimum: 0, physicalMaximum: 0, unitExponent: 0, unit: 0, reportSize: 0, reportId: 0, reportCount: 0,
});

export type EncodeOptions = { childrenFirst?: boolean };

/** A report descriptor whose parse is `collections` (see the header for what can't come back). */
export function encodeReportDescriptor(collections: readonly HidCollectionInfo[], opts: EncodeOptions = {}): Uint8Array {
  const childrenFirst = opts.childrenFirst ?? true;
  const w = new Writer();
  // The usage page starts unset (-1), so the first usage always sets it; the rest start at the parser's zeros.
  const g = initialGlobals();
  const page = (p: number) => {
    if (g.usagePage !== p) { g.usagePage = p; w.unsigned(GLOBAL, G_USAGE_PAGE, p); }
  };
  /** A usage in the current page as its 16-bit ID; another page's as an extended 32-bit usage. */
  const usage = (tag: number, ext: number) => {
    ext >>>= 0;
    if (ext >>> 16 === g.usagePage) w.unsigned(LOCAL, tag, ext & 0xffff);
    else w.item(LOCAL, tag, le32(ext));
  };
  const setSigned = (key: 'logicalMinimum' | 'logicalMaximum' | 'physicalMinimum' | 'physicalMaximum', tag: number, v: number) => {
    if (g[key] === (v | 0)) return;
    g[key] = v | 0;
    w.signed(GLOBAL, tag, v);
  };
  const setUnsigned = (key: 'reportSize' | 'reportCount' | 'reportId' | 'unit', tag: number, v: number) => {
    if (g[key] === v) return;
    g[key] = v;
    w.unsigned(GLOBAL, tag, v);
  };
  const emitItem = (kind: ReportKind, it: HidReportItem) => {
    const first = it.isRange ? it.usageMinimum : it.usages[0];
    if (first !== undefined && (it.isRange || it.usages.length)) page(first >>> 16);
    setSigned('logicalMinimum', G_LOGICAL_MIN, it.logicalMinimum);
    // A maximum below a non-negative minimum is an unsigned 32-bit value WebHID reads as signed: written as 4 bytes.
    if (it.logicalMinimum >= 0 && it.logicalMaximum < 0) {
      if (g.logicalMaximum !== (it.logicalMaximum | 0)) { g.logicalMaximum = it.logicalMaximum | 0; w.item(GLOBAL, G_LOGICAL_MAX, le32(it.logicalMaximum)); }
    } else setSigned('logicalMaximum', G_LOGICAL_MAX, it.logicalMaximum);
    setSigned('physicalMinimum', G_PHYSICAL_MIN, it.physicalMinimum);
    setSigned('physicalMaximum', G_PHYSICAL_MAX, it.physicalMaximum);
    if (g.unitExponent !== it.unitExponent) {
      g.unitExponent = it.unitExponent;
      if (it.unitExponent >= -8 && it.unitExponent <= 7) w.item(GLOBAL, G_UNIT_EXPONENT, [it.unitExponent & 0xf]);
      else w.signed(GLOBAL, G_UNIT_EXPONENT, it.unitExponent);
    }
    setUnsigned('unit', G_UNIT, unitWord(it));
    setUnsigned('reportSize', G_REPORT_SIZE, it.reportSize);
    setUnsigned('reportCount', G_REPORT_COUNT, it.reportCount);
    if (it.isRange) {
      usage(L_USAGE_MIN, it.usageMinimum);
      usage(L_USAGE_MAX, it.usageMaximum);
    } else for (const u of it.usages) usage(L_USAGE, u);
    const flags = (it.isConstant ? 1 : 0) | (it.isArray ? 0 : 2) | (it.isAbsolute ? 0 : 4) | (it.wrap ? 8 : 0) | (it.isLinear ? 0 : 0x10)
      | (it.hasPreferredState ? 0 : 0x20) | (it.hasNull ? 0x40 : 0) | (it.isVolatile ? 0x80 : 0) | (it.isBufferedBytes ? 0x100 : 0);
    w.item(MAIN, MAIN_TAG[kind], flags > 0xff ? [flags & 0xff, flags >> 8] : [flags]);
  };
  const emitReports = (c: HidCollectionInfo) => {
    for (const [kind, list] of [['input', c.inputReports], ['output', c.outputReports], ['feature', c.featureReports]] as const) {
      for (const r of list) {
        if (r.items.length === 0) continue;
        setUnsigned('reportId', G_REPORT_ID, r.reportId);
        for (const it of r.items) emitItem(kind, it);
      }
    }
  };
  const emitCollection = (c: HidCollectionInfo) => {
    page(c.usagePage);
    w.unsigned(LOCAL, L_USAGE, c.usage);
    w.item(MAIN, T_COLLECTION, [c.type & 0xff]);
    if (!childrenFirst) emitReports(c);
    for (const ch of c.children) emitCollection(ch);
    if (childrenFirst) emitReports(c);
    w.item(MAIN, T_END_COLLECTION, []);
  };
  for (const c of collections) emitCollection(c);
  return Uint8Array.from(w.out);
}

/** Parses a report descriptor into WebHID's shape, the way Chromium groups it (see the header). */
export function parseReportDescriptor(b: Uint8Array): HidCollectionInfo[] {
  const top: HidCollectionInfo[] = [];
  const stack: HidCollectionInfo[] = [];
  // The maxima keep both readings: which one counts depends on the minimum in force at the main item.
  type ParseGlobals = Globals & { lmax: [number, number]; pmax: [number, number] };
  let g: ParseGlobals = { ...initialGlobals(), usagePage: 0, lmax: [0, 0], pmax: [0, 0] };
  const pushed: ParseGlobals[] = [];
  type Usage = { v: number; ext: boolean };
  let local = { usages: [] as Usage[], min: null as Usage | null, max: null as Usage | null };
  const resolve = (u: Usage) => (u.ext ? u.v >>> 0 : ((g.usagePage << 16) | (u.v & 0xffff)) >>> 0);
  for (let o = 0; o < b.length; ) {
    const prefix = b[o];
    if (prefix === 0xfe) { // a long item: skipped (none are defined)
      o += 3 + (b[o + 1] ?? 0);
      continue;
    }
    const size = [0, 1, 2, 4][prefix & 3];
    const type = (prefix >> 2) & 3, tag = prefix >> 4;
    let u = 0;
    for (let k = 0; k < size; k++) u |= (b[o + 1 + k] ?? 0) << (8 * k);
    u >>>= 0;
    const s = size === 0 ? 0 : size === 4 ? u | 0 : (u << (32 - 8 * size)) >> (32 - 8 * size);
    o += 1 + size;
    if (type === GLOBAL) {
      switch (tag) {
        case G_USAGE_PAGE: g.usagePage = u & 0xffff; break;
        case G_LOGICAL_MIN: g.logicalMinimum = s; break;
        case G_LOGICAL_MAX: g.lmax = [u | 0, s]; break;
        case G_PHYSICAL_MIN: g.physicalMinimum = s; break;
        case G_PHYSICAL_MAX: g.pmax = [u | 0, s]; break;
        case G_UNIT_EXPONENT: g.unitExponent = u <= 0xf ? nibble(u) : s; break;
        case G_UNIT: g.unit = u; break;
        case G_REPORT_SIZE: g.reportSize = u; break;
        case G_REPORT_ID: g.reportId = u; break;
        case G_REPORT_COUNT: g.reportCount = u; break;
        case G_PUSH: pushed.push({ ...g }); break;
        case G_POP: if (pushed.length) g = pushed.pop()!; break;
      }
    } else if (type === LOCAL) {
      const us: Usage = { v: u, ext: size === 4 };
      if (tag === L_USAGE) local.usages.push(us);
      else if (tag === L_USAGE_MIN) local.min = us;
      else if (tag === L_USAGE_MAX) local.max = us;
    } else if (type === MAIN) {
      if (tag === T_COLLECTION) {
        const first = local.usages[0] ?? local.min;
        const ext = first ? resolve(first) : 0;
        const c: HidCollectionInfo = { usagePage: ext >>> 16, usage: ext & 0xffff, type: u & 0xff, children: [], inputReports: [], outputReports: [], featureReports: [] };
        (stack.length ? stack[stack.length - 1].children : top).push(c);
        stack.push(c);
      } else if (tag === T_END_COLLECTION) {
        stack.pop();
      } else if (tag === T_INPUT || tag === T_OUTPUT || tag === T_FEATURE) {
        const c = stack[stack.length - 1];
        if (c) {
          // Logical and physical maxima are signed when their minimum is negative, unsigned otherwise (read as int32, as WebHID's are).
          const lmax = g.logicalMinimum < 0 ? g.lmax[1] : g.lmax[0];
          const pmax = g.physicalMinimum < 0 ? g.pmax[1] : g.pmax[0];
          const range = local.min !== null || local.max !== null;
          const item = hidItem({
            isConstant: !!(u & 1), isArray: !(u & 2), isAbsolute: !(u & 4), wrap: !!(u & 8), isLinear: !(u & 0x10),
            hasPreferredState: !(u & 0x20), hasNull: !!(u & 0x40), isVolatile: !!(u & 0x80), isBufferedBytes: !!(u & 0x100),
            isRange: range,
            usages: local.usages.map(resolve),
            usageMinimum: local.min ? resolve(local.min) : 0,
            usageMaximum: local.max ? resolve(local.max) : 0,
            reportSize: g.reportSize, reportCount: g.reportCount,
            unitExponent: g.unitExponent, unitSystem: unitSystemOf(g.unit & 0xf),
            logicalMinimum: g.logicalMinimum, logicalMaximum: lmax, physicalMinimum: g.physicalMinimum, physicalMaximum: pmax,
          });
          FACTORS.forEach((f, k) => { item[f] = nibble((g.unit >>> (4 * (k + 1))) & 0xf); });
          const list = tag === T_INPUT ? c.inputReports : tag === T_OUTPUT ? c.outputReports : c.featureReports;
          let r = list.find((x) => x.reportId === g.reportId);
          if (!r) { r = { reportId: g.reportId, items: [] }; list.push(r); }
          r.items.push(item);
        }
      }
      local = { usages: [], min: null, max: null };
    }
  }
  return top;
}

/** Every report's size in bytes (without the ID byte), by kind and report ID, summed over the collections that carry it. */
export function reportSizes(collections: readonly HidCollectionInfo[]): Record<ReportKind, Map<number, number>> {
  const bits: Record<ReportKind, Map<number, number>> = { input: new Map(), output: new Map(), feature: new Map() };
  const walk = (c: HidCollectionInfo) => {
    for (const [kind, list] of [['input', c.inputReports], ['output', c.outputReports], ['feature', c.featureReports]] as const) {
      for (const r of list) bits[kind].set(r.reportId, (bits[kind].get(r.reportId) ?? 0) + r.items.reduce((n, i) => n + i.reportSize * i.reportCount, 0));
    }
    c.children.forEach(walk);
  };
  collections.forEach(walk);
  for (const m of Object.values(bits)) for (const [id, n] of m) m.set(id, Math.ceil(n / 8));
  return bits;
}

/** Whether the device numbers its reports (any report ID other than 0). */
export function usesReportIds(collections: readonly HidCollectionInfo[]): boolean {
  const s = reportSizes(collections);
  return Object.values(s).some((m) => [...m.keys()].some((id) => id !== 0));
}
