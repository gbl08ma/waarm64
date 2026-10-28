// VK3 L7.5: vkd3d (WineHQ's Direct3D 12 on Vulkan, vkd3d's row of plan §4: draw parameters) on Venus in the desktop
// guest (images/arch/desktop.sh) on the page: Arch's vkd3d and spirv-tools packages and vkd3d.py on a second disk
// (target/vkd3d/vkd3d.ext4, made by `bench/vulkan/vkd3d.ts disk` in rootless Podman), installed at boot; then
// D3D12CreateDevice at each feature level with vkd3d's warnings (bench/vulkan/REPORT.md "VK3 L7.5"); then, where the disk
// has it, vkd3d's own Direct3D 12 tests (tests/d3d12 of vkd3d 1.19, built by `target/vkd3d/build-tests.sh` in an Arch
// container: offscreen, no window) for each name in TESTS (comma-separated; VKD3D_TEST_FILTER matches a part of a name).
//   node bench/vulkan/vkd3d.ts disk
//   CHROMIUM_ARGS="--enable-unsafe-webgpu --enable-features=Vulkan" node bench/vulkan/vkd3d.ts [image] [outdir]
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { openSession } from '../gpu/guest-session.ts';

const root = new URL('../..', import.meta.url).pathname;
const W = `${root}target/vkd3d`;
if (process.argv[2] === 'disk') {
  mkdirSync(`${W}/disk`, { recursive: true });
  copyFileSync(new URL('./vkd3d.py', import.meta.url), `${W}/disk/vkd3d.py`);
  if (existsSync(`${W}/src/vkd3d-1.19/tests/.libs/d3d12`)) copyFileSync(`${W}/src/vkd3d-1.19/tests/.libs/d3d12`, `${W}/disk/d3d12`);
  const r = spawnSync('podman', ['run', '--rm', '-v', `${W}:/w:Z`, 'localhost/arch-base', 'sh', '-c',
    'pacman -Sw --noconfirm --cachedir /w/disk vkd3d >/dev/null && rm -f /w/disk/*.sig && rm -f /w/vkd3d.ext4 && mkfs.ext4 -q -L vkd3d -d /w/disk /w/vkd3d.ext4 32M'], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
const image = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : `${root}target/arch/desktop.qcow2`;
const out = process.argv[3] ?? `${root}bench/results/local/vkd3d`;
mkdirSync(out, { recursive: true });
const s = await openSession({ gpu: 'virgl,vulkan', image, out, ncpus: 4, ramMiB: 4096, disk2: '/target/vkd3d/vkd3d.ext4' });
try {
  await s.rootShell();
  const install = await s.run('mkdir -p /mnt/vkd3d && mount -o ro /dev/vdb /mnt/vkd3d && pacman -U --noconfirm --needed /mnt/vkd3d/*.pkg.tar.zst 2>&1 | tail -3', 300_000);
  console.log(install);
  // The log in parts: a command's output comes back through the serial console, whose last bytes the session keeps.
  await s.run('VKD3D_DEBUG=warn VKD3D_SHADER_DEBUG=warn timeout 60 python3 -u /mnt/vkd3d/vkd3d.py 2>&1 | grep -v -e "^$" -e "Optional user instance extension" > /tmp/vkd3d.txt; wc -l < /tmp/vkd3d.txt', 120_000);
  const parts: string[] = [];
  for (let at = 1; at < 200; at += 12) {
    const part = await s.run(`sed -n '${at},${at + 11}p' /tmp/vkd3d.txt`);
    if (!part.trim()) break;
    parts.push(part);
  }
  const tests: string[] = [];
  for (const name of (process.env.TESTS ?? '').split(',').filter(Boolean)) {
    const t = await s.run(`cd /tmp && VKD3D_TEST_FILTER=${name} timeout 120 /mnt/vkd3d/d3d12 > /tmp/t.txt 2>&1; echo "${name} rc=$?"; grep -v -e "Optional user instance extension" -e "^vkd3d:.*:warn:vkd3d_init" /tmp/t.txt | tail -8`, 180_000);
    console.log(t);
    tests.push(t);
  }
  const r = [...parts, ...tests].join('\n');
  console.log(r);
  writeFileSync(`${out}/vkd3d.txt`, `${install}\n${r}\n${JSON.stringify(Object.fromEntries(s.warnings))}\n`);
} finally {
  await s.close();
}
