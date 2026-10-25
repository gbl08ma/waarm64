// VK1: Vulkan through Venus in a guest on the page (docs/devices.md "Venus"): images/debian-vulkan/build.sh's Debian on
// a 3D machine with `?gpu=vulkan`, vulkaninfo's summary and the kernel's virtio-gpu lines, then commands of the
// caller's (CMDS, one a line); also the page's WebGPU adapter. Writes <out>/results.json and the serial log.
//   node bench/vulkan/venus-run.ts [outdir]       (IMAGE= the qcow2, default target/images/debian-vulkan/disk.qcow2)
import { mkdirSync, writeFileSync } from 'node:fs';
import { openSession } from '../gpu/guest-session.ts';

const out = process.argv[2] ?? new URL('../results/local/vk1/venus-run/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const image = process.env.IMAGE ?? new URL('../../target/images/debian-vulkan/disk.qcow2', import.meta.url).pathname;
const s = await openSession({ gpu: 'virgl,vulkan', image, out, byUrl: true, ncpus: Number(process.env.NCPUS ?? 2), ramMiB: Number(process.env.RAM_MIB ?? 1024) });
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
  for (const cmd of (process.env.CMDS ?? '').split('\n').filter(Boolean)) results[cmd] = await s.run(cmd, 300_000);
} finally {
  writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, warnings: Object.fromEntries(s.warnings) }, null, 1));
  for (const [k, v] of Object.entries(results)) console.log(`== ${k}\n${v}`);
  await s.close();
}
