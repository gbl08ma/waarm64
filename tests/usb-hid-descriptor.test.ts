// The HID report descriptor encoder and parser (web/hid-descriptor.ts): WebHID-shaped collections
// encoded and parsed back to the same, a raw descriptor of the HID spec parsed as Chromium groups
// it, and (when the gates lane's recorded Chromium parses are there) raw descriptors against
// Chromium's own parse of them.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import {
  encodeReportDescriptor, hidItem, normalizeCollections, parseReportDescriptor, reportSizes, usesReportIds,
  type HidCollectionInfo, type HidCollectionLike, type HidReportInfo,
} from '../web/hid-descriptor.ts';

const col = (usagePage: number, usage: number, type: number, o: Partial<HidCollectionInfo> = {}): HidCollectionInfo =>
  ({ usagePage, usage, type, children: [], inputReports: [], outputReports: [], featureReports: [], ...o });
const rep = (reportId: number, ...items: Partial<Parameters<typeof hidItem>[0]>[]): HidReportInfo => ({ reportId, items: items.map(hidItem) });
const u = (page: number, id: number) => ((page << 16) | id) >>> 0;

/** A game pad with report IDs: sticks in a physical child, buttons by range, padding, a hat with a null state and units, rumble out, a vendor feature. */
const gamepad: HidCollectionInfo[] = [
  col(0x01, 0x05, 0x01, {
    children: [col(0x01, 0x01, 0x00, {
      inputReports: [rep(1, { usages: [u(1, 0x30), u(1, 0x31), u(1, 0x32), u(1, 0x35)], logicalMaximum: 255, reportSize: 8, reportCount: 4 })],
    })],
    inputReports: [rep(1,
      { isRange: true, usageMinimum: u(9, 1), usageMaximum: u(9, 14), logicalMaximum: 1, reportSize: 1, reportCount: 14 },
      { isConstant: true, isArray: true, reportSize: 2, reportCount: 1, logicalMaximum: 1 },
      { usages: [u(1, 0x39)], logicalMaximum: 7, physicalMaximum: 315, unitSystem: 'english-rotation', unitFactorLengthExponent: 1,
        hasNull: true, reportSize: 4, reportCount: 1 },
      { isConstant: true, isArray: true, reportSize: 4, reportCount: 1, logicalMaximum: 1 },
    )],
    outputReports: [rep(5, { usages: [u(0xff00, 1)], logicalMaximum: 255, reportSize: 8, reportCount: 31 })],
    featureReports: [rep(0x12, { usages: [u(0xff02, 0x21)], logicalMaximum: 255, reportSize: 8, reportCount: 15 }),
      rep(0x13, { usages: [u(0xff02, 0x22)], logicalMaximum: 255, reportSize: 8, reportCount: 22, isVolatile: true })],
  }),
];

/** A keyboard's vendor configuration collection (as VIA's raw HID): no report IDs, 32 bytes each way. */
const via: HidCollectionInfo[] = [
  col(0xff60, 0x61, 0x01, {
    inputReports: [rep(0, { usages: [u(0xff60, 0x62)], logicalMaximum: 255, reportSize: 8, reportCount: 32 })],
    outputReports: [rep(0, { usages: [u(0xff60, 0x63)], logicalMaximum: 255, reportSize: 8, reportCount: 32, isVolatile: true })],
  }),
];

/** The odd corners: signed and wide values, unit exponents, flags, mixed-page usages, two top-level collections. */
const corners: HidCollectionInfo[] = [
  col(0x0c, 0x01, 0x01, {
    inputReports: [rep(4,
      { usages: [u(0x0c, 0xe9), u(0x0c, 0xea), u(0x0c, 0x223)], isArray: true, logicalMaximum: 0x3ff, reportSize: 16, reportCount: 1, hasPreferredState: false },
      { usages: [u(0x01, 0x30), u(0x02, 0xc5)], logicalMinimum: -127, logicalMaximum: 127, physicalMinimum: -1000, physicalMaximum: 1000, reportSize: 8, reportCount: 2, isAbsolute: false, wrap: true, isLinear: false },
      { usages: [u(0x20, 0x453)], logicalMinimum: -32768, logicalMaximum: 32767, unitSystem: 'si-linear', unitFactorLengthExponent: 1, unitFactorTimeExponent: -2, unitExponent: -3, reportSize: 16, reportCount: 3 },
      { usages: [u(0x20, 0x454)], logicalMinimum: 0, logicalMaximum: 0x7fffffff, reportSize: 32, reportCount: 1, unitSystem: 'vendor-defined' },
      { usages: [u(0x20, 0x455)], logicalMinimum: 0, logicalMaximum: -1, reportSize: 32, reportCount: 1 },
    )],
    featureReports: [rep(4, { usages: [u(0xffa0, 7)], logicalMaximum: 255, reportSize: 8, reportCount: 3, isBufferedBytes: true })],
  }),
  col(0xff00, 0x01, 0x01, {
    children: [col(0xff00, 0x02, 0x02, { children: [col(0xff00, 0x03, 0x02, { inputReports: [rep(6, { usages: [u(0xff00, 4)], logicalMaximum: 255, reportSize: 8, reportCount: 7 })] })] })],
    inputReports: [rep(6, { usages: [u(0xff00, 5)], logicalMaximum: 255, reportSize: 8, reportCount: 1 })],
  }),
];

for (const [name, cs] of [['game pad', gamepad], ['VIA', via], ['corners', corners]] as const) {
  test(`encode, then parse: the ${name} collections come back as they were`, () => {
    const bytes = encodeReportDescriptor(cs);
    assert.deepEqual(parseReportDescriptor(bytes), cs);
    // Parent items first gives the same parse (the order between a collection's items and its children's isn't in WebHID's form).
    assert.deepEqual(parseReportDescriptor(encodeReportDescriptor(cs, { childrenFirst: false })), cs);
  });
}

test('globals are written only when they change, usages of the current page as 16-bit IDs', () => {
  const b = encodeReportDescriptor(via);
  const hex = Buffer.from(b).toString('hex');
  // Usage Page 0xff60, Usage 0x61, Collection(Application); Logical Maximum 255 (two bytes, unambiguous), Report Size 8, Count 32, Usage 0x62, Input(Data,Var,Abs)
  assert.equal(hex, '0660ff0961a101' + '26ff00' + '7508' + '9520' + '0962' + '8102' + '0963' + '9182' + 'c0');
  // The game pad's second report ID 0x13 differs from 0x12 only by its count and usage: no repeated globals.
  const g = Buffer.from(encodeReportDescriptor(gamepad)).toString('hex');
  assert.equal((g.match(/26ff00/g) ?? []).length, 1 + 1, 'Logical Maximum 255 written for the sticks, and again after the hat\'s 7 and padding\'s 1');
  assert.ok(g.includes('8513') && g.includes('9516'), 'report 0x13 with count 22');
});

test('items: buffered bytes take a two-byte main item; another page\'s usage is extended', () => {
  const b = Buffer.from(encodeReportDescriptor(corners)).toString('hex');
  assert.ok(b.includes('b20201'), 'Feature with the buffered-bytes bit');
  assert.ok(b.includes('0bc5000200'), 'Usage 0x0002_00c5 as a 4-byte extended usage');
  assert.ok(b.includes('550d'), 'Unit Exponent -3 as a nibble');
  assert.ok(b.includes('27ffffffff'), 'a maximum WebHID reads as -1 over a non-negative minimum: four bytes');
});

test('the HID spec\'s mouse (HID 1.11 Appendix E.10) parses into WebHID\'s shape', () => {
  const raw = Buffer.from('05010902a1010901a1000509190129031500250195037501810295017505810105010930093115812' + '57f750895028106c0c0', 'hex');
  const [mouse] = parseReportDescriptor(raw);
  assert.deepEqual([mouse.usagePage, mouse.usage, mouse.type], [1, 2, 1]);
  assert.equal(mouse.inputReports.length, 0, 'the items are the pointer\'s, its innermost collection');
  const [ptr] = mouse.children;
  assert.deepEqual([ptr.usagePage, ptr.usage, ptr.type], [1, 1, 0]);
  const [btn, pad, xy] = ptr.inputReports[0].items;
  assert.deepEqual([btn.isRange, btn.usageMinimum, btn.usageMaximum, btn.reportSize, btn.reportCount, btn.isArray], [true, u(9, 1), u(9, 3), 1, 3, false]);
  assert.deepEqual([pad.isConstant, pad.reportSize], [true, 5]);
  assert.deepEqual([xy.usages, xy.logicalMinimum, xy.logicalMaximum, xy.isAbsolute], [[u(1, 0x30), u(1, 0x31)], -127, 127, false]);
  assert.deepEqual(parseReportDescriptor(encodeReportDescriptor(parseReportDescriptor(raw))), parseReportDescriptor(raw));
  assert.equal(reportSizes([mouse]).input.get(0), 3);
  assert.equal(usesReportIds([mouse]), false);
});

test('push and pop, and a usage before its page changes', () => {
  // Usage Page 1, Usage 2 (mouse), Collection; Push; Usage Page 9; Usage 1; ...; Pop; Usage 0x30 back on page 1.
  const raw = Uint8Array.from([0x05, 0x01, 0x09, 0x02, 0xa1, 0x01, 0xa4, 0x05, 0x09, 0x09, 0x01, 0x75, 0x01, 0x95, 0x08, 0x25, 0x01, 0x81, 0x02,
    0xb4, 0x09, 0x30, 0x75, 0x08, 0x95, 0x01, 0x15, 0x81, 0x25, 0x7f, 0x81, 0x06, 0xc0]);
  const [c] = parseReportDescriptor(raw);
  const [a, b] = c.inputReports[0].items;
  assert.deepEqual([a.usages, a.reportSize], [[u(9, 1)], 1]);
  assert.deepEqual([b.usages, b.reportSize, b.logicalMinimum], [[u(1, 0x30)], 8, -127]);
});

test('sizes per report ID sum the collections that carry it', () => {
  const s = reportSizes(gamepad);
  assert.equal(s.input.get(1), 4 + 3);
  assert.equal(s.output.get(5), 31);
  assert.equal(s.feature.get(0x13), 22);
  assert.equal(usesReportIds(gamepad), true);
});

test('WebHID\'s dictionaries with members missing normalize to full values', () => {
  const [c] = normalizeCollections([{ usagePage: 1, usage: 4, inputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 2, usages: [u(1, 0x30)] }] }] }]);
  assert.deepEqual(c.children, []);
  assert.equal(c.type, 0);
  assert.equal(c.inputReports[0].items[0].isAbsolute, true);
});

// The gates lane records Chromium's parse of real descriptors: <name>.json holding { descriptor: hex, collections: [...] }.
const FIXTURES = new URL('./usb/hid-fixtures/', import.meta.url);
const recorded = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((f) => f.endsWith('.json')) : [];
const byId = (cs: HidCollectionInfo[]): HidCollectionInfo[] => cs.map((c) => ({
  ...c,
  children: byId(c.children),
  inputReports: [...c.inputReports].sort((a, b) => a.reportId - b.reportId),
  outputReports: [...c.outputReports].sort((a, b) => a.reportId - b.reportId),
  featureReports: [...c.featureReports].sort((a, b) => a.reportId - b.reportId),
}));
test('recorded Chromium parses: ours of the raw descriptor matches, and ours of our encoding of Chromium\'s matches Chromium\'s', { skip: recorded.length === 0 && 'no recorded parses (tests/usb/hid-fixtures/)' }, () => {
  for (const f of recorded) {
    const j = JSON.parse(readFileSync(new URL(f, FIXTURES), 'utf8')) as { descriptor: string; collections: HidCollectionLike[] };
    const chromium = byId(normalizeCollections(j.collections));
    if (j.descriptor) assert.deepEqual(byId(parseReportDescriptor(Buffer.from(j.descriptor, 'hex'))), chromium, `${f}: our parse of the raw descriptor`);
    assert.deepEqual(byId(parseReportDescriptor(encodeReportDescriptor(chromium))), chromium, `${f}: the round trip`);
  }
});
