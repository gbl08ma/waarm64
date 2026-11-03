// VK1: Vulkan through Venus in a guest on the page (docs/devices.md "Venus"): images/debian-vulkan/build.sh's Debian on
// a 3D machine with `?gpu=vulkan`, vulkaninfo's summary and the kernel's virtio-gpu lines, then commands of the
// caller's (CMDS, one a line), then the frames of REPLAY's programs (comma-separated, or `all`: the disk's) checked against lavapipe's
// (images/vkframes/build.sh's disk as the second disk, its run.sh: results.json's `replay <name>`); also the page's
// WebGPU adapter. Writes <out>/results.json and the serial log. PROFILE=<file> also writes the guest's Vulkan device as
// a Khronos profile there (`vulkaninfo --json`): images/vkframes/venus-profile.json, which the frames' captures take,
// is made so (`PROFILE=images/vkframes/venus-profile.json`, on SwiftShader, whenever what the device advertises changes).
//   node bench/vulkan/venus-run.ts [image] [outdir]   (the image also IMAGE=, default target/images/debian-vulkan/disk.qcow2;
//   the form bench/gpu/sway-mac.sh calls with SCRIPT=../vulkan/venus-run.ts, mode `-`); GPU_KNOBS: more of `?gpu=`, comma-separated
//   (e.g. `vkvendor=nvidia,vkreadback`: web/app/main.ts); AFTER: commands after the replays, one a line; a CMDS line
//   `@stall <ms>` blocks the GPU worker's thread that long instead (GD G3)
import { mkdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { openSession } from '../gpu/guest-session.ts';

const args = process.argv.slice(2);
const out = args.at(-1) ?? new URL('../results/local/vk1/venus-run/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const image = (args.length > 1 ? args[0] : process.env.IMAGE) ?? new URL('../../target/images/debian-vulkan/disk.qcow2', import.meta.url).pathname;
const replay = (process.env.REPLAY ?? '').split(',').filter(Boolean);
const s = await openSession({ gpu: `virgl,vulkan${process.env.GPU_KNOBS ? `,${process.env.GPU_KNOBS}` : ''}`, image, out, byUrl: true, disk2: replay.length ? '/target/vkframes/vkframes.ext4' : undefined, ncpus: Number(process.env.NCPUS ?? 2), ramMiB: Number(process.env.RAM_MIB ?? 1024) });
const results: Record<string, unknown> = { chromium: s.browser.version(), gl: s.gl };
try {
  // The page's WebGPU adapter (VK2's renderer draws on it; tests/page-venus.test.ts skips without one), null for none.
  results.adapter = await s.page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter();
    return a ? `${a.info.vendor} ${a.info.architecture} ${a.info.description}`.trim() || 'an adapter' : null;
  });
  await s.rootShell();
  results.kernel = await s.run('uname -r; dmesg | grep -E "virtio_gpu|\\[drm\\]" | head -20');
  results.vulkaninfo = await s.run('VN_DEBUG=init vulkaninfo --summary 2>&1 | head -60', 120_000);
  for (const cmd of (process.env.CMDS ?? '').split('\n').filter(Boolean)) {
    // `@stall <ms>`: the GPU worker's thread blocked that long (the page's `__webpcStallGpu`), while the guest runs on.
    const stall = /^@stall (\d+)$/.exec(cmd);
    if (stall) await s.page.evaluate((ms) => (window as unknown as { __webpcStallGpu(ms: number): void }).__webpcStallGpu(ms), Number(stall[1]));
    else results[cmd] = await s.run(cmd, 300_000);
  }
  if (process.env.PROFILE) {
    // Compressed and in lines short enough for the serial screen (runLines reads 6 at a time; 300-character lines lost some).
    const b64 = await s.runLines('cd /tmp && rm -f VP_*.json && vulkaninfo --json >/dev/null 2>&1; gzip -9 < /tmp/VP_*.json | base64 -w 100', 300_000);
    const json = gunzipSync(Buffer.from(b64.join(''), 'base64')).toString('utf8');
    writeFileSync(process.env.PROFILE, json.endsWith('\n') ? json : `${json}\n`);
    results.profile = `${process.env.PROFILE}: ${json.length} bytes`;
  }
  // The kernel's mount lines would land in the output.
  if (replay.length) await s.run('dmesg -n 1; mkdir -p /vkf; mount -o ro /dev/vdb /vkf');
  const names = replay[0] === 'all' ? (await s.run("awk '{printf \"%s \", $1}' /vkf/programs")).split(/\s+/).filter(Boolean) : replay;
  // Venus's pipeline totals (the render stats' `venusPipelines`, a second's), after the stats' next second.
  const pipelines = async () => {
    await new Promise((r) => setTimeout(r, 1200));
    return s.page.evaluate(() => ((window as unknown as { __renderStats?: { venusPipelines?: Record<string, number> }[] }).__renderStats ?? []).at(-1)?.venusPipelines ?? null);
  };
  for (const name of names) {
    // A program replayed again is `<name>#2` and so on (its pipelines' second run: VK3 L3).
    let key = name;
    for (let n = 2; `replay ${key}` in results; n++) key = `${name}#${n}`;
    const before = await pipelines();
    const t0 = performance.now();
    results[`replay ${key}`] = await s.run(`/vkf/run.sh ${name}`, 300_000);
    results[`replay ${key} s`] = ((performance.now() - t0) / 1000).toFixed(1);
    const after = await pipelines();
    // What the replay's pipelines cost the renderer: made, held, translated, found in the store.
    if (before && after) results[`replay ${key} pipelines`] = Object.fromEntries(Object.keys(after).map((k) => [k, +(after[k] - (before[k] ?? 0)).toFixed(2)]));
    results[`replay ${key} log`] = await s.run(`grep -E 'Measured|oad' /tmp/vkf/${name}.log | head -4`);
  }
  // AFTER: commands run after the replays (a look at their frames, one a line).
  for (const cmd of (process.env.AFTER ?? '').split('\n').filter(Boolean)) results[cmd] = (await s.runLines(cmd, 300_000)).join('\n');
  // How Vulkan's frames reached virgl in the end (web/venus-share.ts: the way and its check), if any were shared.
  results.share = await s.page.evaluate(() => ((window as unknown as { __renderStats?: { share?: unknown }[] }).__renderStats ?? []).at(-1)?.share ?? null);
} finally {
  writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, warnings: Object.fromEntries(s.warnings) }, null, 1));
  for (const [k, v] of Object.entries(results)) console.log(`== ${k}\n${typeof v === 'object' ? JSON.stringify(v) : v}`);
  await s.close();
}
