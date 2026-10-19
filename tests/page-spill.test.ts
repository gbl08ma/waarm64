// Guest RAM past memory 0 (docs/plans/spill-memories.md): Debian on the page with its RAM split by hand
// (`?split=2560,1024,512`): memory 0, then two spill memories, CPU-less NUMA nodes. The Machine menu's note for a size
// past memory 0 first; then one boot: the guest sees three nodes at the distances the DT gives, NUMA balancing is off through the SMBIOS credential, a tmpfs bound to node 1 keeps its data, and
// direct disk reads into node 1 and writes out of it are intact (the virtio records name the spill memory). Opt-in with
// WEBPC_DISTROS=debian (scripts/ci-debian.sh).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { startServer } from '../tools/serve.ts';
import { unattendedQuery } from './debian-unattended.ts';
import { withDebianLock } from './debian-lock.ts';
import { PAGE_QUERY } from './page-query.ts';
import { answerAsks } from './page-ask.ts';

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

test('Debian with RAM past memory 0: the Machine menu says so; three NUMA nodes, balancing off, data on node 1, disk reads and writes through it intact; a snapshot of it loads in a fresh profile', { skip, timeout: 25 * 60_000 }, () => withDebianLock(async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Headless Chromium's save picker would wait for a dialog nobody answers: the page downloads instead.
  await page.addInitScript(() => { (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = undefined; });
  await answerAsks(page);
  const query = `${PAGE_QUERY}ncpus=2&view=both&split=2560,1024,512&${unattendedQuery()}`;
  await page.goto(`${base}/web/app/?${query}`);
  // The Machine menu: the running split's note, the automatic one's for another size, none for a size memory 0 holds.
  await page.locator('#machine-menu summary').click();
  assert.match(await page.locator('#machine-numa').textContent() ?? '', /^2560 MiB of it is the machine's fast memory; the guest gets the other 1536 MiB as 2 more NUMA nodes/);
  await page.selectOption('#machine-ram', '8192');
  assert.match(await page.locator('#machine-numa').textContent() ?? '', /^3071 MiB of it .* other 5121 MiB as 2 more NUMA nodes/);
  await page.selectOption('#machine-ram', '2048');
  assert.equal(await page.locator('#machine-numa').count(), 0);
  await page.locator('#machine-menu summary').click();
  await page.waitForFunction(() => ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), undefined, { timeout: 300_000, polling: 250 });
  const [state, message] = await page.evaluate(() => [document.body.dataset.state, document.getElementById('message-text')?.textContent ?? '']);
  assert.equal(state, 'running', message);
  await page.locator('.xterm').click();
  await run(page, 'root', /root@\S+:~#\s/);
  const N = '/sys/devices/system/node';
  const field = (node: number, name: string) => `$(grep '${name}:' ${N}/node${node}/meminfo | tr -s ' ' | cut -d' ' -f4)`;

  // The nodes: memory 0's RAM is node 0 with both CPUs, the spill memories nodes 1 (1 GiB) and 2 (512 MiB), 20 apart.
  const [online, cpus, total1, total2, dist] = await run(page, `echo "R1 $(cat ${N}/online) $(cat ${N}/node0/cpulist) ${field(1, 'MemTotal')} ${field(2, 'MemTotal')} $(cat ${N}/node1/distance | tr ' ' ,)."`, /R1\s(\S+)\s(\S+)\s(\d+)\s(\d+)\s([\d,]+)\./);
  assert.deepEqual([online, cpus, dist], ['0-2', '0-1', '20,10,20']);
  assert.ok(Number(total1) > 900 * 1024 && Number(total1) <= 1024 * 1024, `node 1 has ${total1} kB`);
  assert.ok(Number(total2) > 400 * 1024 && Number(total2) <= 512 * 1024, `node 2 has ${total2} kB`);
  // The SMBIOS credential (core/src/smbios.rs NUMA_CREDENTIAL), and its sysctl applied.
  const [balancing, creds] = await run(page, 'echo "R2 $(cat /proc/sys/kernel/numa_balancing) $(systemd-creds --system list 2>/dev/null | grep -c sysctl.extra)."', /R2\s(\d)\s(\d+)\./);
  assert.deepEqual([balancing, creds], ['0', '1']);

  // A tmpfs bound to node 1: its pages are in the spill memory, and read back as written.
  const [a, b, shmem] = await run(page, `mkdir -p /n1 && mount -t tmpfs -o size=400m,mpol=bind:1 n1 /n1 && dd if=/dev/urandom of=/n1/a bs=1M count=300 status=none; echo "R3 $(sha256sum </n1/a | cut -c1-16) $(sha256sum </n1/a | cut -c1-16) ${field(1, 'Shmem')}."`, /R3\s([0-9a-f]{16})\s([0-9a-f]{16})\s(\d+)\./, 300_000);
  assert.equal(a, b);
  assert.ok(Number(shmem) >= 300 * 1024, `node 1 holds ${shmem} kB of shmem`);

  // Direct disk reads into a process bound to node 1 and writes from one bound to node 2 (systemd's NUMAPolicy): their
  // buffers are in the spill memories, so the disk's data goes into them and comes out of them.
  const bind = (node: number) => (cmd: string) => `systemd-run -q --pipe --wait -p NUMAPolicy=bind -p NUMAMask=${node} sh -c '${cmd}'`;
  const node1 = bind(1);
  const direct = 'dd if=/dev/vda15 bs=4M count=16 iflag=direct status=none | sha256sum | cut -c1-16';
  const [read0, read1, bound] = await run(page, `echo "R4 $(${direct}) $(${node1(`${direct}; grep -c bind:1 /proc/self/numa_maps`)} | tr '\\n' ' ')."`, /R4\s([0-9a-f]{16})\s([0-9a-f]{16})\s(\d+)\s\./);
  assert.equal(read1, read0);
  assert.ok(Number(bound) > 0, 'the process is not bound to node 1');
  const head = 'head -c 64M /n1/a | sha256sum | cut -c1-16';
  const [written, wrote] = await run(page, `${bind(2)('dd if=/n1/a of=/root/x bs=4M count=16 oflag=direct status=none')}; echo 3 >/proc/sys/vm/drop_caches; echo "R5 $(${head}) $(sha256sum </root/x | cut -c1-16)."`, /R5\s([0-9a-f]{16})\s([0-9a-f]{16})\./);
  assert.equal(wrote, written);

  // A snapshot (the spill memories' RAM after memory 0's), loaded in a fresh profile: the shell's variable and node 1's
  // tmpfs are as they were.
  await run(page, 'export MARK=kept-$((6*7)); echo "R6 $MARK."', /R6\skept-42\./);
  const dir = mkdtempSync(join(tmpdir(), 'webpc-spill-'));
  try {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 300_000 }), page.locator('#save-snapshot').click()]);
    const file = join(dir, 'spill.webpcsnap');
    await download.saveAs(file);
    await page.waitForFunction(() => /^Saved the snapshot /.test(document.getElementById('message-text')?.textContent ?? ''), null, { timeout: 120_000 });
    assert.deepEqual(errors, []);
    await context.close();
    const fresh = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const p2 = await fresh.newPage();
    const errors2: string[] = [];
    p2.on('pageerror', (e) => errors2.push(String(e)));
    await answerAsks(p2);
    await p2.goto(`${base}/web/app/?${query}`);
    await p2.setInputFiles('#load-snapshot-input', file);
    await p2.waitForFunction(() => document.getElementById('boot-title')!.textContent!.startsWith('Loading '), null, { timeout: 30_000, polling: 20 });
    await p2.waitForFunction(() => ['running', 'failed', 'crashed', 'idle', 'off'].includes(document.body.dataset.state!), undefined, { timeout: 300_000, polling: 250 })
      .catch(async (e) => { throw new Error(`${e}; the page is ${await p2.evaluate(() => `${document.body.dataset.state}: ${document.getElementById('status')?.textContent}`)}`); });
    const [state2, message2] = await p2.evaluate(() => [document.body.dataset.state, document.getElementById('message-text')?.textContent ?? '']);
    assert.equal(state2, 'running', message2);
    await p2.locator('.xterm').click();
    const [mark, again] = await run(p2, `clear; echo "R7 $MARK $(sha256sum </n1/a | cut -c1-16)."`, /R7\s(\S+)\s([0-9a-f]{16})\./);
    assert.deepEqual([mark, again], ['kept-42', a]);
    assert.deepEqual(errors2, []);
    await fresh.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}));
