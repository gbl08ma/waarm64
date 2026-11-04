// Vulkan through Venus on the page (docs/devices.md "Venus"): images/debian-vulkan/build.sh's Debian on a 3D machine
// with `?gpu=vulkan` (vk/build.sh's renderer, target/vk/venus.wasm), its Vulkan device the renderer's, and vkcube on
// sway (headless, pixman; the WSI's CPU path) reaching steady frames: a short run and a long one both finish, and the
// frames between them come at a rate, drawn by the renderer's driver on the page's WebGPU device; vkcube's frames
// presented on a sway that renders with GLES on virgl (the WSI's images shared into virgl's textures), and through
// Xwayland there (X11's WSI: the prime blit's buffers shared); and, with
// images/vkframes/build.sh's disk, its captures (vkcube, vkmark's scenes, vkQuake) replayed on the device and their
// frames compared with lavapipe's. Skipped where the page has no adapter (with `--enable-unsafe-webgpu`: SwiftShader's in
// the dev VM), as without the image or the renderer. Any WebGPU error the page logged fails it (an invalid command drops
// its whole submit: VK3 L6c's vkQuake frame, 80% off). In scripts/ci-graphics.sh and scripts/ci-deqp-vk.sh, ~2 min.
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
const skip = !debian ? 'SKIPPED: scripts/ci-graphics.sh runs it (WEBPC_DISTROS=debian)' : missing.length ? `SKIPPED: ${missing.join(' and ')} not built (images/debian-vulkan/build.sh, vk/build.sh)` : false;

// The frames of the short run and the long one: the rate is the difference's, past vkcube's start.
const SHORT = 60, LONG = 360;

// Without Xwayland: X11's step below takes the GLES sway's (this one's, on pixman, would have no DRI3).
const SWAY = 'mkdir -p -m 700 /tmp/xdg; printf "output HEADLESS-1 resolution 640x480\\nxwayland disable\\n" > /tmp/sway.conf; '
  + '(XDG_RUNTIME_DIR=/tmp/xdg WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 sway -c /tmp/sway.conf > /tmp/sway.log 2>&1 &); '
  + 'for i in $(seq 50); do [ -S /tmp/xdg/wayland-1 ] && break; sleep 0.2; done; echo sway $(ls /tmp/xdg | grep -cx wayland-1)';
const vkcube = (frames: number) => 'S=$(date +%s%N); XDG_RUNTIME_DIR=/tmp/xdg WAYLAND_DISPLAY=wayland-1 MESA_VK_WSI_DEBUG=sw '
  + `timeout 120 vkcube --wsi wayland --c ${frames} > /tmp/vkcube.log 2>&1; echo "vkcube $? $(( ($(date +%s%N) - S) / 1000000 ))"; head -c 300 /tmp/vkcube.log`;

// A long GPU-process call (GD G3: Dawn's createShaderModule of Godot's Forward+ shader took 5 s on the GPU process's
// main thread, and the GPU worker's synchronous WebGL and WebGPU calls waited behind it) blocks the GPU worker's thread:
// nothing polls the rings, and Venus's watchdog in the guest (a wait checks the ring's alive bit every ~3.5 s: Mesa's
// vn_relax) aborted the program unless something else set the bit. vkcube runs across a 6 s stall of the GPU worker
// (`@stall`: bench/vulkan/venus-run.ts) and finishes; its time says it ran through it.
const STALL_MS = 6000;
const STALL_START = `(S=$(date +%s%N); XDG_RUNTIME_DIR=/tmp/xdg WAYLAND_DISPLAY=wayland-1 MESA_VK_WSI_DEBUG=sw timeout 150 vkcube --wsi wayland --c 1000 > /tmp/vkstall.log 2>&1; `
  + 'echo "$? $(( ($(date +%s%N) - S) / 1000000 ))" > /tmp/vkstall.rc) > /dev/null 2>&1 & sleep 3; echo started';
const STALL_END = 'for i in $(seq 150); do [ -f /tmp/vkstall.rc ] && break; sleep 1; done; echo "vkstall $(cat /tmp/vkstall.rc 2>/dev/null || echo none)"; head -c 400 /tmp/vkstall.log';

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

// X11 (GD G7): vkcube through Xwayland on the same sway. Mesa's X11 WSI takes the prime blit in our guest (its same-GPU
// check knows PCI devices only; our virtio-gpu is on virtio-mmio), copying each frame into a buffer it exports, which
// web/venus-share.ts copies into a texture: the window shows as under Wayland. Black before. Needs the image's Xwayland
// (images/debian-vulkan/build.sh since GD G7: `X11 none` otherwise, and the test says to rebuild).
const X11 = `X=$(ls /tmp/.X11-unix 2>/dev/null | sed -n 's/^X//p' | head -1); if [ -z "$X" ] || ! command -v Xwayland > /dev/null; then echo X11 none; else `
  + `(${GL_ENV} DISPLAY=:$X timeout 60 vkcube --wsi xcb --c 1500 > /tmp/vkcube3.log 2>&1 &); sleep 10; ${GL_ENV} grim -t ppm /tmp/a.ppm; sleep 1; ${GL_ENV} grim -t ppm /tmp/b.ppm; `
  + `${PPM} /tmp/a.ppm /tmp/b.ppm; cmp -s /tmp/a.ppm /tmp/b.ppm && echo frames same || echo frames differ; pkill -x vkcube; head -c 300 /tmp/vkcube3.log; fi`;

// Host-visible memory mapped at once (GD G8): tests/venus/vkmap.py maps 6 memories of 128 MiB and keeps them mapped,
// as VMA keeps its blocks (Godot's: 128 MiB each on a 1 GiB heap). Linux gives each its place in the host-visible window
// when Venus makes its blob, at the first map, so a window smaller than what's mapped fails the map with -2 (the GI
// demo's "Couldn't map buffer memory"); the window holds the host-visible heap whole. The script reaches the guest in
// base64 lines short enough for the serial console's.
const VKMAP_B64 = readFileSync(join(root, 'tests/venus/vkmap.py')).toString('base64');
const VKMAP_UP = Array.from({ length: Math.ceil(VKMAP_B64.length / 600) }, (_, i) => `echo ${VKMAP_B64.slice(i * 600, (i + 1) * 600)} >> /tmp/vkmap.b64; echo up`);
const VKMAP = 'base64 -d /tmp/vkmap.b64 > /tmp/vkmap.py && timeout 120 python3 /tmp/vkmap.py 6 128 2>&1 | tail -3';

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
      cwd: root, env: { ...process.env, CHROMIUM_ARGS: `${process.env.CHROMIUM_ARGS ?? ''} --enable-unsafe-webgpu`, GPU_KNOBS: 'vkbreak=bitmap,vkbreak=canvas', IMAGE, REPLAY: frames ? 'all' : '', CMDS: ['rm -f /tmp/vkmap.b64', ...VKMAP_UP, VKMAP, SWAY, vkcube(SHORT), vkcube(LONG), STALL_START, `@stall ${STALL_MS}`, STALL_END, SWAY_GL, PRESENT, X11, OOPS].join('\n') }, encoding: 'utf8', timeout: 8 * 60_000,
    });
    assert.equal(r.status, 0, `venus-run.ts failed (its output and the serial log: ${out}): ${(r.stdout + r.stderr).slice(-2000)}`);
    const res = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as Record<string, string>;
    if (!res.adapter) {
      passed = true;
      return t.skip('SKIPPED: the page has no WebGPU adapter');
    }
    assert.match(res.vulkaninfo, /deviceName\s*= Virtio-GPU Venus \(webpc WebGPU\)/, 'the guest\'s Vulkan device is the renderer\'s');
    console.log(`host-visible memory mapped at once: ${res[VKMAP]}`);
    assert.match(res[VKMAP] ?? '', /vkmap mapped 6 of 6 x 128 MiB/, `host-visible memory mapped at once (the window too small?): ${res[VKMAP]}`);
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
    const stalled = /vkstall (\d+) (\d+)/.exec(res[STALL_END] ?? '');
    console.log(`vkcube across a ${STALL_MS} ms stall of the GPU worker: ${res[STALL_END]}`);
    assert.ok(stalled, `vkcube across the stall didn't finish: ${res[STALL_END]}`);
    assert.equal(stalled[1], '0', `vkcube didn't live through a ${STALL_MS} ms stall of the GPU worker (134: Venus's watchdog aborted it): ${res[STALL_END]}`);
    assert.ok(Number(stalled[2]) > 3000 + STALL_MS, `vkcube ended before the stall did: ${res[STALL_END]}`);
    // Mesa logs each watchdog check: one ran during the stall, and found the ring alive.
    assert.match(res[STALL_END] ?? '', /stuck in \w+ wait/, `vkcube's waits never reached Venus's watchdog: ${res[STALL_END]}`);
    assert.match(res[SWAY_GL], /sway 1/, `sway on GLES started: ${res[SWAY_GL]}`);
    const shots = [...(res[PRESENT] ?? '').matchAll(/shot grey (\d+) colours (\d+)/g)].map((m) => ({ grey: Number(m[1]), colours: Number(m[2]) }));
    console.log(`vkcube presented through virgl: ${res[PRESENT]}`);
    assert.equal(shots.length, 2, `grim's screenshots: ${res[PRESENT]}`);
    // The window fills sway's output; the clear colour is most of it (~75% on SwiftShader), the cube the rest.
    for (const s of shots) assert.ok(s.grey >= 40 && s.colours >= 100, `vkcube's frame isn't on sway's output: ${JSON.stringify(s)} (${res[PRESENT]})`);
    assert.match(res[PRESENT], /frames differ/, `vkcube's frames stopped reaching virgl: ${res[PRESENT]}`);
    console.log(`vkcube presented through Xwayland: ${res[X11]}`);
    assert.doesNotMatch(res[X11] ?? '', /X11 none/, 'the image has no Xwayland: rebuild it (images/debian-vulkan/build.sh)');
    const xshots = [...(res[X11] ?? '').matchAll(/shot grey (\d+) colours (\d+)/g)].map((m) => ({ grey: Number(m[1]), colours: Number(m[2]) }));
    assert.equal(xshots.length, 2, `grim's screenshots under X11: ${res[X11]}`);
    for (const s of xshots) assert.ok(s.grey >= 40 && s.colours >= 100, `vkcube's X11 frame isn't on sway's output (the prime blit's buffer not shared): ${JSON.stringify(s)} (${res[X11]})`);
    assert.match(res[X11], /frames differ/, `vkcube's X11 frames stopped reaching virgl: ${res[X11]}`);
    const share = res.share as unknown as { way: string; dropped: { way: string }[]; fromBuffers: number } | null;
    assert.ok((share?.fromBuffers ?? 0) > 0, `vkcube under X11 didn't take the prime blit (no frame copied from a buffer): ${JSON.stringify(share)}`);
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
