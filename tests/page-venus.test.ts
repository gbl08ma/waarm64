// Vulkan through Venus on the page (docs/devices.md "Venus"): images/debian-vulkan/build.sh's Debian on a 3D machine
// with `?gpu=vulkan` (vk/build.sh's renderer, target/vk/venus.wasm), its Vulkan device the renderer's, and vkcube on
// sway (headless, pixman; the WSI's CPU path) reaching steady frames: a short run and a long one both finish, and the
// frames between them come at a rate, drawn by the renderer's driver on the page's WebGPU device (whose pixels L3 of
// M8-VK2-HANDOVER.md checks). Skipped where the page has no adapter (with `--enable-unsafe-webgpu`: SwiftShader's in
// the dev VM), as without the image or the renderer. In scripts/ci-debian.sh, ~1.5 min.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withDebianLock } from './debian-lock.ts';

const root = new URL('..', import.meta.url).pathname;
const IMAGE = 'target/images/debian-vulkan/disk.qcow2';
const missing = [IMAGE, 'target/vk/venus.wasm'].filter((f) => !existsSync(join(root, f)));
const debian = (process.env.WEBPC_DISTROS ?? '').split(',').includes('debian');
const skip = !debian ? 'SKIPPED: scripts/ci-debian.sh runs it (WEBPC_DISTROS=debian)' : missing.length ? `SKIPPED: ${missing.join(' and ')} not built (images/debian-vulkan/build.sh, vk/build.sh)` : false;

// The frames of the short run and the long one: the rate is the difference's, past vkcube's start.
const SHORT = 60, LONG = 360;

const SWAY = 'mkdir -p -m 700 /tmp/xdg; printf "output HEADLESS-1 resolution 640x480\\n" > /tmp/sway.conf; '
  + '(XDG_RUNTIME_DIR=/tmp/xdg WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 sway -c /tmp/sway.conf > /tmp/sway.log 2>&1 &); '
  + 'for i in $(seq 50); do [ -S /tmp/xdg/wayland-1 ] && break; sleep 0.2; done; echo sway $(ls /tmp/xdg | grep -cx wayland-1)';
const vkcube = (frames: number) => 'S=$(date +%s%N); XDG_RUNTIME_DIR=/tmp/xdg WAYLAND_DISPLAY=wayland-1 MESA_VK_WSI_DEBUG=sw '
  + `timeout 120 vkcube --wsi wayland --c ${frames} > /tmp/vkcube.log 2>&1; echo "vkcube $? $(( ($(date +%s%N) - S) / 1000000 ))"; head -c 300 /tmp/vkcube.log`;

// The renderer once wrote memory 0's bottom 4 MiB through its stack (vk/README.md "The build"): the guest's kernel
// oopsed as vkcube started.
const OOPS = 'echo oopses $(dmesg | grep -c "Internal error")';

test('vkcube reaches steady frames through Venus on the page', { skip, timeout: 25 * 60_000 }, (t) => withDebianLock(async () => {
  const out = mkdtempSync(join(tmpdir(), 'webpc-venus-'));
  let passed = false;
  try {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'bench/vulkan/venus-run.ts', out], {
      cwd: root, env: { ...process.env, CHROMIUM_ARGS: `${process.env.CHROMIUM_ARGS ?? ''} --enable-unsafe-webgpu`, IMAGE, CMDS: [SWAY, vkcube(SHORT), vkcube(LONG), OOPS].join('\n') }, encoding: 'utf8', timeout: 8 * 60_000,
    });
    assert.equal(r.status, 0, `venus-run.ts failed (its output and the serial log: ${out}): ${(r.stdout + r.stderr).slice(-2000)}`);
    const res = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as Record<string, string>;
    if (!res.adapter) {
      passed = true;
      return t.skip('SKIPPED: the page has no WebGPU adapter');
    }
    assert.match(res.vulkaninfo, /deviceName\s*= Virtio-GPU Venus \(webpc WebGPU\)/, 'the guest\'s Vulkan device is the renderer\'s');
    assert.match(res[SWAY], /sway 1/, `sway started: ${res[SWAY]}`);
    const ran = [SHORT, LONG].map((n) => {
      const m = /vkcube (\d+) (\d+)/.exec(res[vkcube(n)] ?? '');
      assert.ok(m, `vkcube --c ${n} didn't report: ${res[vkcube(n)]}`);
      assert.equal(m[1], '0', `vkcube --c ${n} failed: ${res[vkcube(n)]}`);
      return Number(m[2]);
    });
    const fps = (LONG - SHORT) / ((ran[1] - ran[0]) / 1000);
    console.log(`vkcube: ${SHORT} frames in ${ran[0]} ms, ${LONG} in ${ran[1]} ms: ${fps.toFixed(1)} frames/s steady`);
    // SwiftShader's WebGPU on 2 vCPUs: ~50 frames/s in the dev VM; a stall (a fence or the ring not serviced) is far under.
    assert.ok(fps > 5, `${fps.toFixed(1)} frames/s`);
    assert.match(res[OOPS] ?? '', /oopses 0/, `the guest kernel oopsed: ${res[OOPS]}`);
    passed = true;
  } finally {
    if (passed) rmSync(out, { recursive: true, force: true });
  }
}));
