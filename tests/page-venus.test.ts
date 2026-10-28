// Vulkan through Venus on the page (docs/devices.md "Venus"): images/debian-vulkan/build.sh's Debian on a 3D machine
// with `?gpu=vulkan` (vk/build.sh's renderer, target/vk/venus.wasm), its Vulkan device the renderer's, and vkcube on
// sway (headless, pixman; the WSI's CPU path) reaching steady frames: a short run and a long one both finish, and the
// frames between them come at a rate, drawn by the renderer's driver on the page's WebGPU device; vkcube's frames
// presented on a sway that renders with GLES on virgl (the WSI's images shared into virgl's textures); and, with
// images/vkframes/build.sh's disk, its captures (vkcube, vkmark's scenes, vkQuake) replayed on the device and their
// frames compared with lavapipe's. Skipped where the page has no adapter (with `--enable-unsafe-webgpu`: SwiftShader's in
// the dev VM), as without the image or the renderer. Any WebGPU error the page logged fails it (an invalid command drops
// its whole submit: VK3 L6c's vkQuake frame, 80% off). In scripts/ci-debian.sh and scripts/ci-deqp-vk.sh, ~1.5 min.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withDebianLock } from './debian-lock.ts';

const root = new URL('..', import.meta.url).pathname;
const IMAGE = 'target/images/debian-vulkan/disk.qcow2';
// images/vkframes/build.sh's disk: its programs' captures, replayed on the Venus device and compared with lavapipe's frames.
const FRAMES_DISK = 'target/vkframes/vkframes.ext4';
const frames = existsSync(join(root, FRAMES_DISK));
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

// Presentation (vk/README.md "Presentation"): a second sway, rendering with GLES on virgl, imports vkcube's WSI images
// as dma-bufs into virgl (web/venus-share.ts copies them into virgl's textures); grim's two screenshots a second apart,
// of sway's output read back through virgl, show vkcube's clear colour (0.2: 51) over most of the window and its cube,
// and differ (frames keep coming). Without the sharing the window is black. The page runs with the bitmap and canvas
// ways broken (`?gpu=vkbreak=…`: their copies black, no WebGPU canvas made): its check of the first copies drops both
// for the readback way, and the window is right all the same.
const SWAY_GL = 'mkdir -p -m 700 /tmp/xdg2; printf "output HEADLESS-1 resolution 640x480\\n" > /tmp/sway2.conf; '
  + '(XDG_RUNTIME_DIR=/tmp/xdg2 WLR_BACKENDS=headless WLR_RENDERER=gles2 WLR_LIBINPUT_NO_DEVICES=1 sway -c /tmp/sway2.conf > /tmp/sway2.log 2>&1 &); '
  + 'for i in $(seq 50); do [ -S /tmp/xdg2/wayland-1 ] && break; sleep 0.2; done; echo sway $(ls /tmp/xdg2 | grep -cx wayland-1)';
const GL_ENV = 'XDG_RUNTIME_DIR=/tmp/xdg2 WAYLAND_DISPLAY=wayland-1';
const PPM = `perl -e 'for $f (@ARGV) { open F, "<", $f; binmode F; local $/; $d = <F>; $d =~ s/^P6\\s+\\d+\\s+\\d+\\s+255\\s//s; %c = (); `
  + `for ($i = 0; $i < length($d); $i += 3) { $c{substr($d, $i, 3)}++ } print "shot grey ", int(100 * ($c{"\\x33\\x33\\x33"} // 0) / (length($d) / 3)), " colours ", scalar(keys %c), "\\n" }'`;
const PRESENT = `(${GL_ENV} timeout 60 vkcube --wsi wayland --c 1500 > /tmp/vkcube2.log 2>&1 &); sleep 8; ${GL_ENV} grim -t ppm /tmp/a.ppm; sleep 1; ${GL_ENV} grim -t ppm /tmp/b.ppm; `
  + `${PPM} /tmp/a.ppm /tmp/b.ppm; cmp -s /tmp/a.ppm /tmp/b.ppm && echo frames same || echo frames differ; pkill -x vkcube; head -c 300 /tmp/vkcube2.log`;

// The renderer once wrote memory 0's bottom 4 MiB through its stack (vk/README.md "The build"): the guest's kernel
// oopsed as vkcube started.
const OOPS = 'echo oopses $(dmesg | grep -c "Internal error")';
// Of a frame's bytes, how many may differ from lavapipe's by more than 24 (of 255): each program's own, from the disk
// (rasterization and filtering differ at edges; SwiftShader: ~0.03% of vkcube's, up to 0.1% of vkmark's, 1.7% of
// vkQuake's; vkcube's front face inverted, ~12%).

test('vkcube reaches steady frames through Venus on the page', { skip, timeout: 25 * 60_000 }, (t) => withDebianLock(async () => {
  const out = mkdtempSync(join(tmpdir(), 'webpc-venus-'));
  let passed = false;
  try {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'bench/vulkan/venus-run.ts', out], {
      cwd: root, env: { ...process.env, CHROMIUM_ARGS: `${process.env.CHROMIUM_ARGS ?? ''} --enable-unsafe-webgpu`, GPU_KNOBS: 'vkbreak=bitmap,vkbreak=canvas', IMAGE, REPLAY: frames ? 'all' : '', CMDS: [SWAY, vkcube(SHORT), vkcube(LONG), SWAY_GL, PRESENT, OOPS].join('\n') }, encoding: 'utf8', timeout: 8 * 60_000,
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
    assert.match(res[SWAY_GL], /sway 1/, `sway on GLES started: ${res[SWAY_GL]}`);
    const shots = [...(res[PRESENT] ?? '').matchAll(/shot grey (\d+) colours (\d+)/g)].map((m) => ({ grey: Number(m[1]), colours: Number(m[2]) }));
    console.log(`vkcube presented through virgl: ${res[PRESENT]}`);
    assert.equal(shots.length, 2, `grim's screenshots: ${res[PRESENT]}`);
    // The window fills sway's output; the clear colour is most of it (~75% on SwiftShader), the cube the rest.
    for (const s of shots) assert.ok(s.grey >= 40 && s.colours >= 100, `vkcube's frame isn't on sway's output: ${JSON.stringify(s)} (${res[PRESENT]})`);
    assert.match(res[PRESENT], /frames differ/, `vkcube's frames stopped reaching virgl: ${res[PRESENT]}`);
    const share = res.share as unknown as { way: string; dropped: { way: string }[] } | null;
    assert.deepEqual([share?.way, share?.dropped.map((d) => d.way)], ['readback', ['bitmap', 'canvas']], `the check of the broken ways: ${JSON.stringify(share)}`);
    if (frames) {
      const names = Object.keys(res).filter((k) => /^replay [^ ]+$/.test(k)).map((k) => k.slice(7));
      for (const p of ['vkcube', 'vkmark-texture', 'vkquake']) assert.ok(names.includes(p), `${p} wasn't replayed (rebuild images/vkframes/build.sh's disk): ${names.join(' ')}`);
      for (const name of names) {
        const replay = res[`replay ${name}`] ?? '';
        console.log(`${name}'s capture replayed: ${replay}`);
        const m = /replay (\d+) fps \S+ tolerance ([\d.]+)/.exec(replay);
        assert.ok(m && m[1] === '0', `${name}: the replay failed: ${replay}`);
        const checked = [...replay.matchAll(/frame (\d+) bytes (\d+) differ (\d+) over (\d+) max (\d+)/g)];
        assert.ok(checked.length && !/missing/.test(replay), `${name}: frames missing: ${replay}`);
        for (const [, f, bytes, , over] of checked) assert.ok(Number(over) <= Number(bytes) * Number(m[2]), `${name}'s frame ${f}: ${over} of ${bytes} bytes off by more than 24 from lavapipe's`);
      }
    }
    assert.match(res[OOPS] ?? '', /oopses 0/, `the guest kernel oopsed: ${res[OOPS]}`);
    const invalid = Object.keys((res as unknown as { warnings: Record<string, number> }).warnings ?? {}).filter((w) => /^venus-gpu: WebGPU: /.test(w));
    assert.deepEqual(invalid, [], 'WebGPU errors on the page (each drops a submit)');
    passed = true;
  } finally {
    if (passed) rmSync(out, { recursive: true, force: true });
  }
}));
