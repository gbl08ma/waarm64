// The guest through real devices, in the dev VM (scripts/ci-usb.sh, docs/usb.md "The usbhost guest"): the USB test
// kernel for real devices (images/build.sh linux-usbhost) in the pinned Chromium, realtime, under the JIT, with a
// host device on connector 0. (i) testusb against the dummy_hcd Gadget Zero through the WebUSB passthrough; (ii) the
// guest's cdc_acm on the ACM gadget, echoed by the gadget's tty here, opened and closed three times (each close
// cancels cdc_acm's reads: the carry-over); (iii) a uhid device through WebHID: the guest's report descriptor
// parses to what the page can use, input reports arrive, output and feature reports reach the rig. Skips without
// WAARM64_USB_TESTS=1, the rigs or the image.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { normalizeCollections, parseReportDescriptor, visibleCollections, type HidCollectionInfo, type HidCollectionLike } from '../web/hid-descriptor.ts';
import type { UsbFromWorker, UsbIdentity } from '../web/usb-device.ts';
import { DESCRIPTORS } from './usb/hid-descriptors.ts';
import { gadgetMissing, openRig, uhidMissing, usbTests, type Rig } from './usb/rig.ts';
import { UhidDevice } from './usb/uhid.ts';

/** This file's origin (the policy grants 8190–8197; gates' tests have 8190–8192). */
const PORT = 8193;
const IMAGE = new URL('../target/images/linux-usbhost/Image', import.meta.url);
const TTY = '/dev/ttyGS0';

const why = !usbTests ? 'scripts/ci-usb.sh runs it (WAARM64_USB_TESTS=1)'
  : !existsSync(IMAGE) ? 'no linux-usbhost image (images/build.sh linux-usbhost)'
    : undefined;
const skip = why ? `SKIPPED: ${why}` : false;
const gadgetSkip = skip || ((m) => (m ? `SKIPPED: ${m}` : false))(gadgetMissing());
const ttySkip = gadgetSkip || ((): string | false => {
  try {
    accessSync(TTY, constants.R_OK | constants.W_OK);
    return false;
  } catch {
    return `SKIPPED: ${TTY} isn't usable by this user (tests/usb/gadget.sh install, then tests/usb/gadget.sh up acm)`;
  }
})();
const hidSkip = skip || ((m) => (m ? `SKIPPED: ${m}` : false))(uhidMissing());

let rig: Rig | undefined;
before(async () => {
  if (!skip) rig = await openRig(PORT, '/tests/browser/core.html');
});
after(async () => rig?.close());

type Result = { error?: string; steps: number; ms: number; console: string; usb?: UsbFromWorker | { error: string } };

/** Boots the usbhost kernel with `cmdline` and `device` on connector 0 (tests/browser/boot-worker.ts `?usbhost`). */
async function boot(device: UsbIdentity, cmdline: string, minutes = 3): Promise<Result> {
  const q = encodeURIComponent(JSON.stringify({ device, cmdline }));
  await rig!.page.goto(`${rig!.base}/tests/browser/boot.html?jit=1&realtime&usbhost=${q}`);
  const h = await rig!.page.waitForFunction(() => (window as never)['result'], null, { timeout: minutes * 60_000, polling: 500 });
  const r = (await h.jsonValue()) as Result;
  assert.equal(r.error, undefined, `the boot failed: ${r.error}`);
  const mode = cmdline.match(/usb_mode=(\w+)/)?.[1] ?? 'run';
  const log = new URL(`../target/tests/usb-guest-${mode}.log`, import.meta.url);
  mkdirSync(new URL('.', log), { recursive: true });
  writeFileSync(log, r.console);
  console.log(`# usbhost ${cmdline}: ${r.steps} steps in ${(r.ms / 1000).toFixed(1)} s (console: target/tests/usb-guest-${mode}.log)`);
  return { ...r, console: r.console.replaceAll('\r\n', '\n') };
}

const attached = (r: Result) => {
  assert.ok(r.usb && 'state' in r.usb && r.usb.state === 'attached', `the device attached: ${JSON.stringify(r.usb)}\n${r.console}`);
  return r.usb as Extract<UsbFromWorker, { state: 'attached' }>;
};

test('testusb -a against the dummy_hcd Gadget Zero, through the WebUSB passthrough (left in its other configuration first)', { skip: gadgetSkip, timeout: 5 * 60_000 }, async () => {
  // A real device can be in any configuration when it is attached: leave Gadget Zero in configuration 2 (loopback),
  // so the guest's reset and SET_CONFIGURATION 1 switch it.
  const other = await rig!.browser.newPage();
  await other.goto(`${rig!.base}/tests/browser/core.html`);
  const left = await other.evaluate(async () => {
    const d = (await (navigator as any).usb.getDevices()).find((x: any) => x.serialNumber === 'waarm64-zero');
    await d.open();
    await d.selectConfiguration(2);
    const v = d.configuration?.configurationValue;
    await d.close();
    return v;
  });
  await other.close();
  assert.equal(left, 2);
  const r = await boot({ api: 'usb', vendorId: 0x0525, productId: 0xa4a0, serialNumber: 'waarm64-zero' }, 'usb_mode=testusb usbtest.pattern=1 usb_devices=1 usb_args=-a,-c,10,-s,1024,-v,512,-g,16');
  assert.equal(attached(r).speed, 'high');
  assert.match(r.console, /^usb: gadget 1-1: Gadget Zero, 480 Mb\/s, configuration \d, interface driver usbtest$/m, r.console);
  assert.match(r.console, /^usb: pass 1: \d+ lines, 0 failed$/m, r.console);
  assert.ok(r.console.includes('waarm64: usb test ok\n'), r.console);
});

/**
 * The gadget's end of the ACM line: raw, and everything that arrives goes back. A reset of the device (the
 * guest's port reset reaches it through WebUSB's `reset()`) disconnects the gadget, which hangs its tty up: a
 * read then gives 0 bytes, and the line is opened again.
 */
function ttyEcho(path: string) {
  const open = () => {
    execFileSync('stty', ['-F', path, 'raw', '-echo']);
    return openSync(path, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOCTTY);
  };
  let fd = open();
  const buf = Buffer.alloc(4096);
  let bytes = 0, hangups = 0;
  const timer = setInterval(() => {
    for (;;) {
      let n: number;
      try {
        n = readSync(fd, buf, 0, buf.length, null);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EAGAIN') return;
        if (code !== 'EIO') throw e;
        n = 0;
      }
      if (n <= 0) {
        hangups++;
        closeSync(fd);
        fd = open();
        return;
      }
      bytes += n;
      for (let o = 0; o < n;) {
        try {
          o += writeSync(fd, buf, o, n - o);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e;
        }
      }
    }
  }, 2);
  return { bytes: () => bytes, hangups: () => hangups, stop: () => { clearInterval(timer); closeSync(fd); } };
}

test("the guest's cdc_acm on the ACM gadget: write, the echo back, close and reopen (the IN carry-over)", { skip: ttySkip, timeout: 5 * 60_000 }, async () => {
  const echo = ttyEcho(TTY);
  try {
    const r = await boot({ api: 'usb', vendorId: 0x0525, productId: 0xa4a7, serialNumber: 'waarm64-acm' }, 'usb_mode=acm usb_rounds=3');
    attached(r);
    for (const n of [1, 2, 3]) assert.ok(r.console.includes(`acm: round ${n}: 300 of 300 bytes echoed\n`), `round ${n} (the gadget got ${echo.bytes()} bytes): see target/tests/usb-guest-acm.log`);
    assert.ok(r.console.includes('waarm64: usb test ok\n'), r.console);
    assert.equal(echo.bytes(), 900, 'what the guest wrote reached the gadget, once');
  } finally {
    echo.stop();
  }
});

test('a uhid device through WebHID: the rebuilt descriptor, input reports in, output and feature reports out', { skip: hidSkip, timeout: 5 * 60_000 }, async () => {
  const d = DESCRIPTORS.find((x) => x.id === 'vendor-ids')!;
  const u = new UhidDevice(d, { phys: `waarm64-uhid/${d.id}-guest` });
  let n = 0;
  const sent: string[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  void u.whenOpened().then(() => {
    timer = setInterval(() => {
      const report = Uint8Array.of(1, n & 0xff, n >> 8, 3, 4, 5, 6, 7, 8);
      n++;
      sent.push(Buffer.from(report).toString('hex'));
      u.input(report);
    }, 50);
  });
  try {
    await new Promise((r) => setTimeout(r, 500)); // Chromium sees the new hidraw node
    const out = `03${'33'.repeat(16)}`;
    const r = await boot({ api: 'hid', vendorId: d.vendorId, productId: d.productId }, `usb_mode=hid usb_inputs=3 usb_out=${out} usb_setf=0409080706 usb_getf=5:64`);
    attached(r);
    assert.ok(r.console.includes('waarm64: usb test ok\n'), r.console);
    // The descriptor the guest got parses to what the page can use of Chromium's parse.
    const rdesc = r.console.match(/^hid: rdesc ([0-9a-f]+)$/m)?.[1];
    assert.ok(rdesc, r.console);
    const fx = JSON.parse(readFileSync(`tests/usb/hid-fixtures/${d.id}.json`, 'utf8')) as { collections: HidCollectionLike[] };
    const sorted = (cs: HidCollectionInfo[]): string => JSON.stringify(cs.map((c) => ({
      ...c, children: JSON.parse(sorted(c.children)),
      inputReports: [...c.inputReports].sort((a, b) => a.reportId - b.reportId),
      outputReports: [...c.outputReports].sort((a, b) => a.reportId - b.reportId),
      featureReports: [...c.featureReports].sort((a, b) => a.reportId - b.reportId),
    })));
    assert.ok(sorted(parseReportDescriptor(Buffer.from(rdesc, 'hex'))) === sorted(visibleCollections(normalizeCollections(fx.collections))), 'the guest\'s report descriptor parses to Chromium\'s');
    // Three input reports, ones the rig sent, in order.
    const inputs = [...r.console.matchAll(/^hid: input ([0-9a-f]+)$/gm)].map((m) => m[1]);
    assert.equal(inputs.length, 3, r.console);
    const at = inputs.map((x) => sent.indexOf(x));
    assert.ok(at.every((i) => i >= 0) && at[0] < at[1] && at[1] < at[2], `inputs ${inputs.join(' ')} are sent reports, in order`);
    // The output report and the feature write reached the rig; the feature read came from it.
    const writes = u.writes.map((w) => `${w.kind} ${Buffer.from(w.data).toString('hex')}`);
    assert.ok(writes.includes(`output ${out}`), writes.join('; '));
    assert.ok(writes.includes('set-feature 0409080706'), writes.join('; '));
    assert.match(r.console, new RegExp(`^hid: feature 05${'55'.repeat(63)}$`, 'm'), r.console);
  } finally {
    if (timer) clearInterval(timer);
    u.destroy();
  }
});
