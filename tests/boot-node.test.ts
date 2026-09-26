// The Buildroot guest (images/build.sh linux) booted on the wasm core in Node,
// its root filesystem on virtio-blk from a `file:` URL (web/devices.ts
// `fileSource`), deterministic: the same step count as core/tests/boot.rs and
// the Chromium boot. Needs the wasm build and target/images (skipped without).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Exit, GUEST_CMDLINE, PSCI_SYSTEM_OFF, guestDevices, runToPowerOff } from '../web/vm.ts';

const IMG = new URL('../target/images/linux/', import.meta.url);
const WASM = new URL('../target/wasm32-unknown-unknown/release/webpc_core.wasm', import.meta.url);
/** The Buildroot boot's steps (PLAN.md §7 M4; core/tests/boot.rs prints the native count). */
const STEPS = 40_909_861;

test('Linux boots in Node with its root on a file: virtio-blk, interpreter', { skip: !existsSync(new URL('Image', IMG)) && 'SKIPPED: run images/build.sh' }, async () => {
  const r = await runToPowerOff(readFileSync(WASM), { ramSize: 256 << 20, kernel: readFileSync(new URL('Image', IMG)), cmdline: GUEST_CMDLINE, devices: guestDevices(new URL('rootfs.ext4', IMG).href) }, 1e9);
  console.log(`# node boot: ${r.steps} steps in ${(r.ms / 1000).toFixed(1)} s`);
  assert.equal(r.kind, Exit.PSCI);
  assert.equal(r.x[0], PSCI_SYSTEM_OFF);
  assert.match(r.console, /webpc: test ok/);
  assert.equal(r.steps, STEPS);
});
