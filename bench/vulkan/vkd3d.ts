// VK3 L7.5: vkd3d (WineHQ's Direct3D 12 on Vulkan, vkd3d's row: draw parameters, docs/graphics.md) on Venus in the desktop
// guest (images/arch/desktop.sh) on the page: Arch's vkd3d and spirv-tools packages and vkd3d.py on a second disk
// (target/vkd3d/vkd3d.ext4, made by `bench/vulkan/vkd3d.ts disk` in rootless Podman), installed at boot; then
// D3D12CreateDevice at each feature level with vkd3d's warnings (bench/vulkan/REPORT.md "VK3 L7.5"); then, where the disk
// has it, vkd3d's own Direct3D 12 tests (tests/d3d12 of vkd3d 1.19, built by `target/vkd3d/build-tests.sh` in an Arch
// container: offscreen, no window) for each name in TESTS (comma-separated; VKD3D_TEST_FILTER matches a part of a name).
//   node bench/vulkan/vkd3d.ts disk
//   CHROMIUM_ARGS="--enable-unsafe-webgpu --enable-features=Vulkan" node bench/vulkan/vkd3d.ts [image] [outdir]
// TESTS=all runs the whole suite (LIMIT_S, default 1500), keeping its summary and failures by d3d12.c line; then
//   node bench/vulkan/vkd3d.ts lines <outdir>/vkd3d.txt
// names the test each failing line is in (from target/vkd3d/src's d3d12.c).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openSession } from '../gpu/guest-session.ts';

const root = new URL('../..', import.meta.url).pathname;
const W = `${root}target/vkd3d`;
if (process.argv[2] === 'lines') {
  // Each `N d3d12.c:L: Test failed` of a run's output, by the test function L is in.
  const src = readFileSync(`${root}target/vkd3d/src/vkd3d-1.19/tests/d3d12.c`, 'utf8').split('\n');
  const fn = (line: number) => { for (let i = line - 1; i >= 0; i--) { const m = /^static void (test_\w+)\(/.exec(src[i]); if (m) return m[1]; } return '?'; };
  const most = new Map<number, number>();
  for (const m of readFileSync(process.argv[3], 'utf8').matchAll(/(\d+) d3d12\.c:(\d+): Test failed/g)) most.set(+m[2], Math.max(most.get(+m[2]) ?? 0, +m[1]));
  const by = new Map<string, number>();
  for (const [line, n] of most) by.set(fn(line), (by.get(fn(line)) ?? 0) + n);
  for (const [k, v] of [...by].sort((a, b) => b[1] - a[1])) console.log(v, k);
  process.exit(0);
}
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
  if (process.env.TESTS === 'all') {
    // The whole suite (VK4 T3), each test a process of its own (one that crashes ends only itself; the filter matches
    // a part of a name, so a test whose name is in another's runs both: `lines` takes each line's most), LIMIT_S at
    // most: each test's summary, then the failures by source line (d3d12.c's: `bench/vulkan/vkd3d.ts lines`).
    const limit = Number(process.env.LIMIT_S ?? 1500);
    const names = [...readFileSync(`${W}/src/vkd3d-1.19/tests/d3d12.c`, 'utf8').matchAll(/^\s*run_test\((test_\w+)\);/gm)].map((m) => m[1]);
    await s.run(': > /tmp/names.txt');
    // In lines under the console's 4,095 bytes.
    for (let i = 0; i < names.length; i += 40) await s.run(`printf '%s\\n' ${names.slice(i, i + 40).join(' ')} >> /tmp/names.txt`);
    const t0 = performance.now();
    await s.run(`cd /tmp && : > /tmp/all.sum && end=$(( $(date +%s) + ${limit} )); while read -r n; do [ $(date +%s) -lt $end ] || break; VKD3D_TEST_FILTER=$n timeout 120 /mnt/vkd3d/d3d12 > /tmp/one.txt 2>&1; echo "$n rc=$? $(grep -o '[0-9]* tests executed ([^)]*)' /tmp/one.txt)" >> /tmp/all.sum; grep -o 'd3d12.c:[0-9]*: Test failed' /tmp/one.txt | sort | uniq -c >> /tmp/all.sum; done < /tmp/names.txt; wc -l < /tmp/all.sum`, (limit + 180) * 1000);
    tests.push(`all: ${((performance.now() - t0) / 1000).toFixed(0)} s`);
    for (let at = 1; at < 4000; at += 12) {
      const part = await s.run(`sed -n '${at},${at + 11}p' /tmp/all.sum`);
      if (!part.trim()) break;
      tests.push(part);
    }
  }
  for (const name of (process.env.TESTS ?? '').split(',').filter((n) => n && n !== 'all')) {
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
