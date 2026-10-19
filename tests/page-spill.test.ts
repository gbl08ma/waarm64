// Guest RAM past memory 0 (docs/plans/spill-memories.md): Debian on the page with 4 GiB, of which memory 0 holds
// ~3 GiB and a spill memory the rest, a CPU-less NUMA node. One boot: the guest sees two nodes at the distances
// the DT gives, NUMA balancing is off through the SMBIOS credential, a tmpfs bound to node 1 keeps its data, and
// direct disk reads into node 1 and writes out of it are intact (the virtio records name the spill memory). Opt-in with
// WEBPC_DISTROS=debian (scripts/ci-debian.sh).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';

const debian = (process.env.WEBPC_DISTROS ?? '').split(',').includes('debian');
const IMAGE = new URL('../target/images/debian/disk.qcow2', import.meta.url);
const FIRMWARE = new URL('../target/images/edk2/QEMU_EFI.fd', import.meta.url);
const skip = !debian ? 'SKIPPED: scripts/ci-debian.sh runs it (WEBPC_DISTROS=debian)' : (!existsSync(IMAGE) || !existsSync(FIRMWARE)) && 'SKIPPED: run images/build.sh debian edk2';

let browser: Browser;
let base: string;
let close: () => void;
before(async () => {
  if (skip) return;
  const server = await startServer();
  close = () => server.close();
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
});
after(async () => { await browser?.close(); close?.(); });

const terminal = (page: Page) => page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '');
/** Types `cmd` on the serial terminal and waits for `re` (xterm's rows run together: match spaces with \s), returning its groups. */
async function run(page: Page, cmd: string, re: RegExp, ms = 120_000): Promise<string[]> {
  await page.keyboard.type(`${cmd}\n`, { delay: 5 });
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('.xterm-rows')?.textContent ?? ''), re.source, { timeout: ms, polling: 250 })
    .catch(async (e) => { throw new Error(`${e}; the terminal shows: ${await terminal(page)}`); });
  return (await terminal(page)).match(re)!.slice(1);
}

test('Debian with RAM past memory 0: two NUMA nodes, balancing off, data on node 1, disk reads and writes through it intact', { skip, timeout: 15 * 60_000 }, () => withDebianLock(async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/web/app/?${PAGE_QUERY}ncpus=2&view=both&ram=4096&${unattendedQuery()}`);
  await page.waitForFunction(() => ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), undefined, { timeout: 300_000, polling: 250 });
  const [state, message] = await page.evaluate(() => [document.body.dataset.state, document.getElementById('message-text')?.textContent ?? '']);
  assert.equal(state, 'running', message);
  await page.locator('.xterm').click();
  await run(page, 'root', /root@\S+:~#\s/);
  const N = '/sys/devices/system/node';
  const field = (node: number, name: string) => `$(grep '${name}:' ${N}/node${node}/meminfo | tr -s ' ' | cut -d' ' -f4)`;

  // The nodes: memory 0's RAM is node 0 with both CPUs, the spill memory node 1 (~1 GiB), 20 apart.
  const [online, cpus, total1, dist] = await run(page, `echo "R1 $(cat ${N}/online) $(cat ${N}/node0/cpulist) ${field(1, 'MemTotal')} $(cat ${N}/node1/distance | tr ' ' ,)."`, /R1\s(\S+)\s(\S+)\s(\d+)\s([\d,]+)\./);
  assert.deepEqual([online, cpus, dist], ['0-1', '0-1', '20,10']);
  assert.ok(Number(total1) > 900 * 1024, `node 1 has ${total1} kB`);
  // The SMBIOS credential (core/src/smbios.rs NUMA_CREDENTIAL), and its sysctl applied.
  const [balancing, creds] = await run(page, 'echo "R2 $(cat /proc/sys/kernel/numa_balancing) $(systemd-creds --system list 2>/dev/null | grep -c sysctl.extra)."', /R2\s(\d)\s(\d+)\./);
  assert.deepEqual([balancing, creds], ['0', '1']);

  // A tmpfs bound to node 1: its pages are in the spill memory, and read back as written.
  const [a, b, shmem] = await run(page, `mkdir -p /n1 && mount -t tmpfs -o size=400m,mpol=bind:1 n1 /n1 && dd if=/dev/urandom of=/n1/a bs=1M count=300 status=none; echo "R3 $(sha256sum </n1/a | cut -c1-16) $(sha256sum </n1/a | cut -c1-16) ${field(1, 'Shmem')}."`, /R3\s([0-9a-f]{16})\s([0-9a-f]{16})\s(\d+)\./, 300_000);
  assert.equal(a, b);
  assert.ok(Number(shmem) >= 300 * 1024, `node 1 holds ${shmem} kB of shmem`);

  // Direct disk reads and writes from a process bound to node 1 (systemd's NUMAPolicy): its buffers are in the
  // spill memory, so the disk's data goes into it and comes out of it.
  const node1 = (cmd: string) => `systemd-run -q --pipe --wait -p NUMAPolicy=bind -p NUMAMask=1 sh -c '${cmd}'`;
  const direct = 'dd if=/dev/vda15 bs=4M count=16 iflag=direct status=none | sha256sum | cut -c1-16';
  const [read0, read1, bound] = await run(page, `echo "R4 $(${direct}) $(${node1(`${direct}; grep -c bind:1 /proc/self/numa_maps`)} | tr '\\n' ' ')."`, /R4\s([0-9a-f]{16})\s([0-9a-f]{16})\s(\d+)\s\./);
  assert.equal(read1, read0);
  assert.ok(Number(bound) > 0, 'the process is not bound to node 1');
  const head = 'head -c 64M /n1/a | sha256sum | cut -c1-16';
  const [written, wrote] = await run(page, `${node1('dd if=/n1/a of=/root/x bs=4M count=16 oflag=direct status=none')}; echo 3 >/proc/sys/vm/drop_caches; echo "R5 $(${head}) $(sha256sum </root/x | cut -c1-16)."`, /R5\s([0-9a-f]{16})\s([0-9a-f]{16})\./);
  assert.equal(wrote, written);
  assert.deepEqual(errors, []);
  await context.close();
}));
