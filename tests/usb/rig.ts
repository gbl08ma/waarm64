// What the end-to-end USB tests share (scripts/ci-usb.sh, docs/testing.md "USB"): whether the dev VM's rigs are
// here, and a headless Chromium on a page whose origin Chromium's managed policy grants the rigs' devices to
// (tests/usb/gadget.sh install: every 0525 gadget for WebUSB, every HID device for WebHID, on 127.0.0.1:8190-8197).
// Permission comes from the policy alone: the DevTools protocol's DeviceAccess prompt events don't fire for WebUSB
// or WebHID on the pinned Chromium, so a test can't answer a chooser (docs/usb.md "Findings").
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../../tools/serve.ts';
import { uhidUsable } from './uhid.ts';

export const POLICY = '/etc/chromium/policies/managed/waarm64-usb.json';
/** The policy's origins; each test file takes its own port so files can run side by side. */
export const PORTS = { webusb: 8190, hid: 8191, record: 8192 } as const;

/** Why the gadget rig (dummy_hcd + configfs, tests/usb/gadget.sh) can't be used here, or undefined. */
export function gadgetMissing(): string | undefined {
  try {
    execFileSync('tests/usb/gadget.sh', ['check'], { stdio: 'pipe' });
  } catch (e) {
    return String((e as { stdout?: Buffer }).stdout ?? e).trim().replaceAll('\n', '; ') || 'tests/usb/gadget.sh check failed';
  }
}

/** Why the uhid rig (tests/usb/uhid.ts) can't be used here, or undefined. */
export function uhidMissing(): string | undefined {
  return uhidUsable() ?? (existsSync(POLICY) ? undefined : `no ${POLICY} (tests/usb/gadget.sh install)`);
}

/** Set by scripts/ci-usb.sh: the USB tests run there, alone, and skip elsewhere (npm test) without it. */
export const usbTests = process.env.WAARM64_USB_TESTS === '1';

export type Rig = { browser: Browser; page: Page; base: string; close: () => Promise<void> };

/** A Chromium on `path` (under the repo root) at 127.0.0.1:`port`. */
export async function openRig(port: number, path: string): Promise<Rig> {
  const server: Server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
  const page = await browser.newPage();
  await page.goto(`${base}${path}`);
  return {
    browser,
    page,
    base,
    close: async () => {
      await browser.close();
      server.close();
    },
  };
}
