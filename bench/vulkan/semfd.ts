// VK3 L7.1b: Venus's guest driver and a semaphore exported as an opaque fd, which it doesn't offer (bench/vulkan/REPORT.md
// "VK3 L7.1b"). Runs semfd.py (ctypes over libvulkan) as root in the desktop guest (images/arch/desktop.sh) on the page:
// the external semaphore properties of opaque fds and sync files, two such semaphores made and each one's fd asked for twice.
//   CHROMIUM_ARGS="--enable-unsafe-webgpu --enable-features=Vulkan" node bench/vulkan/semfd.ts [image] [outdir]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openSession } from '../gpu/guest-session.ts';

const root = new URL('../..', import.meta.url).pathname;
const image = process.argv[2] && process.argv[2] !== '-' ? process.argv[2] : `${root}target/arch/desktop.qcow2`;
const out = process.argv[3] ?? `${root}bench/results/local/semfd`;
mkdirSync(out, { recursive: true });
const s = await openSession({ gpu: `virgl,vulkan${process.env.GPU_KNOBS ? `,${process.env.GPU_KNOBS}` : ''}`, image, out, ncpus: 4, ramMiB: 4096 });
try {
  await s.rootShell();
  await s.pasteSerial(`cat > /tmp/semfd.py <<'EOF_SEM'\n${readFileSync(new URL('./semfd.py', import.meta.url), 'utf8')}\nEOF_SEM`);
  const r = await s.run('timeout 20 python3 -u /tmp/semfd.py 2>&1 | tail -20; echo rc=${PIPESTATUS[0]}');
  console.log(r);
  writeFileSync(`${out}/semfd.txt`, `${r}\n${JSON.stringify(Object.fromEntries(s.warnings))}\n`);
} finally {
  await s.close();
}
