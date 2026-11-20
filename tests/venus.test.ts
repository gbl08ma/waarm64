// Venus's device in a guest (docs/devices.md "The host-visible window"): the gpu test kernel (images/build.sh
// linux-gpu) on a virtio-gpu with `venus`, under the JIT. Linux's driver finds the host-visible window, the blob and
// context-init features and the VENUS capset, and the device still draws as before. The device's commands are
// tests/gpu.test.ts's ("venus: …"); the renderer's are its own.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runToPowerOff } from '../web/test-guests.ts';

const T = new URL('../target/', import.meta.url);
const IMAGE = new URL('images/linux-gpu/Image', T);

test('the gpu test kernel finds a Venus device: the window, the features, three capsets', { skip: !existsSync(IMAGE) && 'SKIPPED: run images/build.sh linux-gpu' }, async () => {
  const wasm = readFileSync(new URL('wasm32-unknown-unknown/release/waarm64_core.wasm', T));
  const r = await runToPowerOff(wasm, {
    ramSize: 256 << 20, kernel: readFileSync(IMAGE), initrd: readFileSync(new URL('images/linux-gpu/initramfs.cpio', T)), cmdline: 'console=ttyAMA0 panic=-1', jit: 1,
    devices: [{ type: 'gpu', width: 640, height: 480, virgl: true, venus: true }],
  }, 5e9);
  const out = r.console.replaceAll('\r\n', '\n');
  for (const want of ['[drm] Host memory window: 0x50000000 +0x50000000', '[drm] features: +virgl +edid +resource_blob +host_visible', '[drm] features: +context_init',
    '[drm] number of cap sets: 3', '[drm] cap set 2: id 4, max-version 0, max-size 160', 'gpu: mode set 640x480 pitch 2560\n', 'gpu: damage sent\n']) {
    assert.ok(out.includes(want), `missing ${JSON.stringify(want)}`);
  }
});
