// dEQP on the page (G4's correctness gate, the kickoff's decision 3; dev-only for now): an Arch image
// (images/deqp/build.sh's target/deqp/guest.qcow2, Mesa's virgl in the guest) on a 3D machine, dEQP on its second disk
// (images/deqp/build.sh → target/deqp/deqp.ext4, mounted at /mnt/vdb, the files in /mnt/vdb/deqp), deqp-gles2 or
// deqp-gles3 run as root on EGL's surfaceless platform (no compositor) over a case list: a slice of a mustpass list
// (every STRIDE-th case from the OFFSET-th) or the cases a file names (CASES; `#` lines are comments). Writes <out>/results.json: the counts
// by status and every case that didn't pass, with the time a case took; the renderer's warnings (results.warnings).
//   node bench/gpu/deqp-run.ts <gles2|gles3> <image.qcow2> [outdir]
// `vk` for dEQP-VK (VK2): images/deqp/build.sh vk's guest (target/deqp/guest-vk.qcow2, Venus's guest driver) on a machine
// with Vulkan (`?gpu=virgl,vulkan`; the page needs a WebGPU adapter: CHROMIUM_ARGS=--enable-unsafe-webgpu in the dev VM),
// deqp-vk from target/deqp/deqp-vk.ext4 (/mnt/vdb/deqp/vk), its case list from vk-main.txt (the direct set's groups).
//   node bench/gpu/deqp-run.ts vk target/deqp/guest-vk.qcow2 [outdir]
// STRIDE=<n> (default 50), OFFSET=<k> (0 to n-1, default 0), PREFIX=<groups, comma-separated: the list's cases under them>,
// CASES=<file of case names, `*` patterns allowed, `#` lines comments>,
// EXPECT=<file of a platform's expected failures, `<case or pattern> <status>` a line> (results.unexpected, nowPass),
// DETAIL=<n> (dEQP's messages for the first n cases that didn't pass; DETAIL_MATCH=<regex>: of those it names;
// DETAIL_NOTSUPPORTED=1: NotSupported ones too, their reasons), VIRGL_GPU=virgl,debug (the renderer's trace,
// <out>/virgl-debug.txt), CAPTURE=<file.vglt> (the 3D commands, web/virgl-trace.ts: fixtures for tests/virgl.test.ts),
// DISK2=<the second disk, a path under the repo, default target/deqp's>, GUEST_ENV=<VAR=value ... for deqp-vk: e.g. a Venus
// built from another Mesa on that disk, VK_DRIVER_FILES=/mnt/vdb/venus/virtio_icd.json (VK4 T24)>,
// LATE=<file of case names: run after the others, alone in one dEQP process: timing cases, whose calibration a busy host
// upsets; their statuses join the others'>, LATE_GO=stdin (before them, print `deqp-run: late cases waiting` and wait
// for a line on stdin: the caller holds them until no other machine runs), RAM_MIB=<the guest's RAM, default the session's>, JOBS=<n> (n dEQP processes at once, each a block of the list; JOBS_BLOCK=<k>: blocks of k cases dealt in turn), LIMIT_S=<seconds the guest may run dEQP, default 1500>, WATCHDOG=disable (no 30 s limit on a case's steps: how long a slow one takes), PASSED=1 (results.passed: the cases that passed), QPA=1 (dEQP's
// log with its images, <out>/deqp.qpa: for a few cases), CONSOLE_FILE=<path> (guest-session.ts: the renderers' console
// lines whole, a shader that didn't compile with its WGSL).
// A machine that crashes (the page's state `crashed` or `failed`: a lost WebGL context, say) ends the run at once, exit
// 3: results.crash (the page's message), results.crashDone (each process's count of statuses, from the terminal's
// `deqp-now` line, ~2 s old) and, for a CASES list without patterns dealt in JOBS_BLOCK blocks, results.crashRunning
// (the case each process was most likely in; the GPU may lose the context a few cases after the one that caused it).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { traceHeader } from '../../web/virgl-trace.ts';
import { MachineStopped, openSession } from './guest-session.ts';

const api = process.argv[2] ?? 'gles2';
const image = process.argv[3];
if (!image || !/^(gles[23]|vk)$/.test(api)) throw new Error('usage: node bench/gpu/deqp-run.ts <gles2|gles3|vk> <image.qcow2> [outdir]');
const vk = api === 'vk';
const out = process.argv[4] ?? new URL(`../results/local/deqp/${api}/`, import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const STRIDE = Number(process.env.STRIDE ?? 50);
const OFFSET = Number(process.env.OFFSET ?? 0);
const LIMIT_S = Number(process.env.LIMIT_S ?? 1500);
const JOBS = Math.max(1, Number(process.env.JOBS ?? 1));
// JOBS_BLOCK=<n>: the list dealt to the processes in blocks of n cases, in turn (a slow group shared out: dEQP-GLES3's
// builtin_functions.precision, ~1,250 cases of up to 30 s, kept one of four processes 1,500 s where the others took
// 120-400); else each process takes a contiguous block of it (dEQP-VK's runs: neighbours as in the list).
const JOBS_BLOCK = Number(process.env.JOBS_BLOCK ?? 0);
// /tmp/deqp.sh's split of its list ($1) to its processes ($2).
const SPLIT = JOBS_BLOCK > 0
  ? `awk -v b=${JOBS_BLOCK} -v j=$2 '{ f = sprintf("/tmp/jcases.%02d", int((NR - 1) / b) % j); print > f }' $1`
  : `split -n l/$2 -d -a 2 $1 /tmp/jcases.`;
const CAPTURE = process.env.CAPTURE;
// Dawn zeroes workgroup memory through Vulkan's VK_KHR_zero_initialize_workgroup_memory where the device has it, which
// costs SwiftShader ~17 s of compile for a 16 KiB array (VK4 T2: `max_workgroup_memory.*` timed out, a crash); Tint's
// own loop instead takes 19 ms. Both zero it; Metal has no such extension.
if (vk) process.env.CHROMIUM_ARGS = `${process.env.CHROMIUM_ARGS ?? ''} --disable-dawn-features=use_vulkan_zero_initialize_workgroup_memory_extension`;
const s = await openSession({ gpu: (process.env.VIRGL_GPU ?? (vk ? 'virgl,vulkan' : 'virgl')) + (CAPTURE ? ',capture' : ''), image, out, disk2: process.env.DISK2 ? `/${process.env.DISK2.replace(/^\/+/, '')}` : vk ? '/target/deqp/deqp-vk.ext4' : '/target/deqp/deqp.ext4', ...(process.env.RAM_MIB ? { ramMiB: Number(process.env.RAM_MIB) } : {}) });
const { log, pasteSerial, rootShell, run, runLines, terminal } = s;
// CAPTURE: the guest's 3D commands with the memory they read, from boot (nothing 3D runs before dEQP) to the end, drained
// from the page into the file every 5 s, 32 MiB at a time (held in the page to the end, a few hundred cases' records
// ran the browser out of memory).
let captured = 0, draining = false;
const drainCapture = async () => {
  const b64 = await s.page.evaluate(() => {
    const rs = (window as unknown as { __virglCapture?: Uint8Array[] }).__virglCapture ?? [];
    let t = '', n = 0, k = 0;
    for (; k < rs.length && n < 32 << 20; k++) {
      n += rs[k].length;
      for (let j = 0; j < rs[k].length; j += 8192) t += String.fromCharCode(...rs[k].subarray(j, j + 8192));
    }
    rs.splice(0, k);
    return btoa(t);
  });
  if (!b64) return false;
  const chunk = Buffer.from(b64, 'base64');
  appendFileSync(CAPTURE!, chunk);
  captured += chunk.length;
  return true;
};
if (CAPTURE) writeFileSync(CAPTURE, traceHeader());
const drainTimer = CAPTURE ? setInterval(() => {
  if (draining) return;
  draining = true;
  void drainCapture().catch(() => {}).finally(() => { draining = false; });
}, 5000) : undefined;
const results: Record<string, unknown> = { api, gl: s.gl, chromium: s.browser.version(), stride: STRIDE, offset: OFFSET, jobs: JOBS, jobsBlock: JOBS_BLOCK };
const save = () => {
  writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, warnings: Object.fromEntries(s.warnings) }, null, 1));
  if (s.debugLines.length) writeFileSync(`${out}/virgl-debug.txt`, s.debugLines.join('\n') + '\n');
};


if (vk) {
  // The page's WebGPU adapter (Venus's renderer draws on it; scripts/ci-deqp-vk.sh skips without one), null for none.
  results.adapter = await s.page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter();
    return a ? `${a.info.vendor} ${a.info.architecture} ${a.info.description}`.trim() || 'an adapter' : null;
  });
}
await rootShell();
results.info = await run('uname -r; pacman -Q mesa | tr "\\n" " "; mkdir -p /mnt/vdb; mount -o ro /dev/vdb /mnt/vdb && ls /mnt/vdb/deqp | tr "\\n" " "');
log('info', results.info);
// The case list, in the guest.
if (process.env.CASES) {
  const cases = readFileSync(process.env.CASES, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')).join('\n');
  // Gzipped through the terminal, as the results come back (its echo passes ~16 KB/s: dEQP-VK's whole pass list as
  // text, 9 MB, outlasted the paste's wait on the Windows VM's Chrome).
  const gz = gzipSync(`${cases}\n`, { level: 9 }).toString('base64').replace(/.{1,150}/g, '$&\n');
  await pasteSerial(`base64 -d > /tmp/patterns.gz <<'EOF'\n${gz}EOF`);
  await run('gunzip -c /tmp/patterns.gz > /tmp/patterns.txt; wc -l < /tmp/patterns.txt');
  // A name with `*` stands for the mustpass list's cases it matches (dEQP's case lists take no wildcards); each case once
  // (deqp-vk exits at once on a duplicate).
  await run(`while read -r p; do case "$p" in *'*'*) grep -E "^$(echo "$p" | sed 's/[.]/[.]/g; s/[*]/.*/g')$" /mnt/vdb/deqp/${api}-main.txt;; *) echo "$p";; esac; done < /tmp/patterns.txt | awk '!seen[$0]++' > /tmp/cases.txt`);
} else {
  // PREFIX=<a,b,...>: only the mustpass list's cases under those groups (e.g. dEQP-VK.draw.), then every STRIDE-th.
  const prefix = (process.env.PREFIX ?? '').split(',').filter(Boolean).map((p) => p.replace(/[.]/g, '[.]')).join('|');
  await run(`${prefix ? `grep -E '^(${prefix})' /mnt/vdb/deqp/${api}-main.txt` : `cat /mnt/vdb/deqp/${api}-main.txt`} | awk 'NR % ${STRIDE} == ${(OFFSET + 1) % STRIDE}' > /tmp/cases.txt`, 120_000);
}
results.cases = Number(await run('wc -l < /tmp/cases.txt'));
log('cases', results.cases);
// dEQP writes `Test case '<name>'..` then a status line per case; a status per case, with the seconds it took. No core
// dumps (a dEQP killed while the device hangs never finishes dumping: "Blocked by coredump"), and the kernel's info on
// the console (a hung task's stack: serial.txt when the run times out).
// deqp-vk: no EGL; its compiled shaders cached in /tmp (the disk is read-only) for the boot.
const command = vk
  ? `${process.env.GUEST_ENV ? `env ${process.env.GUEST_ENV} ` : ''}./deqp-vk --deqp-caselist-file=/tmp/cases.txt --deqp-shadercache-filename=$J/shadercache.bin`
  : `env EGL_PLATFORM=surfaceless ./deqp-${api} --deqp-caselist-file=/tmp/cases.txt --deqp-surface-type=pbuffer --deqp-gl-config-name=rgba8888d24s8ms0 --deqp-surface-width=256 --deqp-surface-height=256`;
// A case that crashes dEQP (or hangs past its watchdog) is recorded as `Crash` and dEQP goes on from the next one,
// until the list is done or LIMIT_S runs out; /tmp/deqp.cur names the case running.
// JOBS=<n> (tests/page-deqp-vk.test.ts takes 2): n dEQP processes at once, each on a contiguous block of the list in a directory of its own ($J), their
// statuses, logs and output joined after (one process waits on the device for most of a case: the guest's vCPUs idle).
await pasteSerial(String.raw`cat > /tmp/deqp1.sh <<'EOF'
cd /mnt/vdb/deqp/API
start=$(date +%s)
: > $J/deqp.res; : > $J/deqp.qpa; : > $J/deqp.out; cp $J/cases.txt $J/rest.txt
while [ -s $J/rest.txt ]; do
  left=$(( LIMIT - ($(date +%s) - start) )); [ $left -gt 0 ] || break
  : > $J/deqp.cur
  timeout $left COMMAND \
    --deqp-log-filename=$J/deqp.part.qpa --deqp-log-images=IMAGES \
    --deqp-log-shader-sources=disable --deqp-watchdog=WATCHDOG --deqp-archive-dir=/mnt/vdb/deqp/API 2>&1 |
    awk -v cur=$J/deqp.cur -v out=$J/deqp.out '/^Test case /{name=$3; sub(/^\047/, "", name); sub(/\047\.\.$/, "", name); t=systime(); print name > cur; close(cur); next} /^  (Pass|Fail|NotSupported|QualityWarning|CompatibilityWarning|InternalError|Crash|Timeout|ResourceError) \(/{print name, $1, systime()-t; fflush(); name=""; printf "" > cur; close(cur); next} !/^(  |$|Test run totals|Writing test log|DEQP Main|Testing |Test case duration)/ {print name ": " $0 >> out; fflush(out)}' >> $J/deqp.res
  cat $J/deqp.part.qpa >> $J/deqp.qpa 2>/dev/null
  cur=$(cat $J/deqp.cur)
  left=$(( LIMIT - ($(date +%s) - start) )); [ $left -gt 0 ] || break
  [ -z "$cur" ] || echo "$cur Crash 0" >> $J/deqp.res
  # On with the cases not recorded yet (dEQP runs them in its own order, not the list's, and may also die between
  # cases, none running: e.g. a device lost at a case's end), until a run records nothing.
  before=$(wc -l < $J/rest.txt)
  awk 'NR == FNR {done[$1] = 1; next} !($0 in done)' $J/deqp.res $J/cases.txt > $J/rest.txt
  [ "$(wc -l < $J/rest.txt)" -lt "$before" ] || break
done
echo "$(( $(date +%s) - start ))" > $J/elapsed
EOF
cat > /tmp/deqp.sh <<'EOF'
# sh /tmp/deqp.sh <cases> <processes>: the statuses, logs and output appended to /tmp/deqp.{res,qpa,out}.
echo core > /proc/sys/kernel/core_pattern; ulimit -c 0; dmesg -n 7
start=$(date +%s)
rm -rf /tmp/j[0-9]* /tmp/jcases.*
SPLIT
k=0; pids=; for f in /tmp/jcases.*; do mkdir -p /tmp/j$k; mv $f /tmp/j$k/cases.txt; J=/tmp/j$k sh /tmp/deqp1.sh & pids="$pids $!"; k=$((k + 1)); done
# Each process's count of statuses, on one line of the terminal rewritten every 2 s: what a crashed machine ran last.
( while :; do printf '\rdeqp-now'; for d in /tmp/j[0-9]*; do printf ' %s:%s' "$(echo $d | tr -dc 0-9)" "$(wc -l 2>/dev/null < $d/deqp.res)"; done; printf '\033[K'; sleep 2; done ) &
rep=$!
wait $pids
kill $rep; printf '\r\033[K'
cat /tmp/j[0-9]*/deqp.res >> /tmp/deqp.res; cat /tmp/j[0-9]*/deqp.qpa >> /tmp/deqp.qpa; cat /tmp/j[0-9]*/deqp.out >> /tmp/deqp.out
echo "elapsed $(( $(date +%s) - start )); each: $(cat /tmp/j[0-9]*/elapsed | tr '\n' ' ')"
EOF`.replaceAll('API', api).replaceAll('LIMIT', String(LIMIT_S)).replace('SPLIT', () => SPLIT).replace('IMAGES', process.env.QPA ? 'enable' : 'disable').replace('WATCHDOG', process.env.WATCHDOG ?? 'enable').replace('COMMAND', command.replace('/tmp/cases.txt', '$J/rest.txt')));
const t0 = performance.now();
const elapsed = await run(`: > /tmp/deqp.res; : > /tmp/deqp.qpa; : > /tmp/deqp.out; sh /tmp/deqp.sh /tmp/cases.txt ${JOBS}`, (LIMIT_S + 120) * 1000)
  .catch(async (e) => {
    if (!(e instanceof MachineStopped)) {
      // Another end (the page or the browser gone): what there is, saved, and the error.
      results.seconds = (performance.now() - t0) / 1000;
      results.error = String(e).slice(0, 2000);
      save();
      throw e;
    }
    // The machine crashed (a lost WebGL context, say): nothing more can be read from the guest. What each process had
    // done (the terminal's deqp-now line) and, where the list is known here (CASES with no patterns, JOBS_BLOCK's
    // dealing), the case each was most likely running; then out, saved.
    results.seconds = (performance.now() - t0) / 1000;
    results.crash = { state: e.state, message: e.pageMessage };
    const now = [...(await terminal().catch(() => '')).matchAll(/deqp-now((?: \d+:\d+)+)/g)].pop()?.[1].trim().split(' ').map((x) => x.split(':').map(Number));
    if (now) {
      results.crashDone = Object.fromEntries(now);
      const names = process.env.CASES ? readFileSync(process.env.CASES, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')) : [];
      if (JOBS_BLOCK > 0 && names.length && !names.some((n) => n.includes('*'))) {
        const list = [...new Set(names)];
        const jobs = Array.from({ length: JOBS }, (_, j) => list.filter((_, n) => Math.floor(n / JOBS_BLOCK) % JOBS === j));
        results.crashRunning = now.map(([j, done]) => jobs[j]?.[done]).filter(Boolean);
      }
    }
    log('crashed:', e.message, '| done', JSON.stringify(results.crashDone ?? null), '| running', JSON.stringify(results.crashRunning ?? null));
    save();
    await s.close().catch(() => {});
    process.exit(3);
  });
const seconds = (performance.now() - t0) / 1000;
results.seconds = seconds;
log('ran', elapsed, seconds.toFixed(0), 's');
// LATE: the timing cases, after the others, in one process (with LATE_GO=stdin once the caller says go); then counted
// with the list's (/tmp/cases.txt).
if (process.env.LATE) {
  const late = readFileSync(process.env.LATE, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  await pasteSerial(`cat > /tmp/late.txt <<'EOF'\n${late.join('\n')}\nEOF`);
  if (process.env.LATE_GO === 'stdin') {
    console.log('deqp-run: late cases waiting');
    const t = performance.now();
    await new Promise((resolve) => process.stdin.once('data', resolve));
    process.stdin.destroy();
    results.lateWaitS = Math.round((performance.now() - t) / 1000);
  }
  const t1 = performance.now();
  log('late', late.length, await run('sh /tmp/deqp.sh /tmp/late.txt 1; cat /tmp/late.txt >> /tmp/cases.txt', (LIMIT_S + 120) * 1000), ((performance.now() - t1) / 1000).toFixed(0), 's');
  results.late = late.length;
  results.cases = (results.cases as number) + late.length;
}
// Venus's pipelines over the run (web/gpu-messages.ts `venusPipelines`: made, their ms until ready, the translator's
// calls and ms): where a slow case's time goes (VK4 T21).
if (vk) {
  results.pipelines = await s.page.evaluate(() => ((window as unknown as { __renderStats?: { venusPipelines?: unknown }[] }).__renderStats ?? []).findLast((x) => x.venusPipelines)?.venusPipelines ?? null);
  log('pipelines', JSON.stringify(results.pipelines));
}
results.counts = Object.fromEntries((await runLines("awk '{print $2}' /tmp/deqp.res | sort | uniq -c")).map((l) => l.split(/\s+/)).map(([c, k]) => [k, +c]));
log('counts', JSON.stringify(results.counts));
// Every case that didn't pass, and the slowest that did.
// Every case's status, gzipped through the terminal (a line a case would take a screen each six), then those that
// didn't pass; PASSED=1 keeps the ones that did (results.passed: what a pass list is made of).
const statuses = gunzipSync(Buffer.from((await runLines('gzip -9c /tmp/deqp.res | base64 -w 150', 300_000)).join(''), 'base64')).toString()
  .split('\n').filter(Boolean).map((l) => l.split(' '));
results.notPassed = statuses.filter(([, st]) => st !== 'Pass').map(([name, st]) => `${name} ${st}`);
if (process.env.PASSED) results.passed = statuses.filter(([, st]) => st === 'Pass').map(([name]) => name);
// EXPECT=<file>: a platform's expected failures (tests/deqp/d3d11-expected.txt): `<case, * patterns> <status>` a line,
// `#` comments. results.unexpected is what didn't pass and isn't there (or not with that status), results.nowPass the
// expected ones that passed: a rerun on that platform shows only what's new.
if (process.env.EXPECT) {
  const want = readFileSync(process.env.EXPECT, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).map((l) => {
    const [pat, st] = l.split(/\s+/);
    return { re: new RegExp(`^${pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`), st };
  });
  const expected = (name: string, st: string) => want.some((w) => w.re.test(name) && w.st === st);
  results.unexpected = statuses.filter(([name, st]) => st !== 'Pass' && !expected(name, st)).map(([name, st]) => `${name} ${st}`);
  results.nowPass = statuses.filter(([name, st]) => st === 'Pass' && want.some((w) => w.re.test(name))).map(([name]) => name);
  log('expected', JSON.stringify({ unexpected: (results.unexpected as string[]).length, nowPass: (results.nowPass as string[]).length }));
}
results.slowest = await runLines('sort -k3 -n -r /tmp/deqp.res | head -10');
results.last = await run('tail -3 /tmp/deqp.res');
// deqp's own lines besides the statuses (an assertion's or a crash's message, prefixed with the case running), the last 40.
results.output = (await runLines('tail -40 /tmp/deqp.out')).filter(Boolean);
// The guest kernel's log, whole, as <out>/dmesg.txt (gzipped through the terminal), and its warnings and worse in
// results.kernel: a run that ends in time kept none of it (VK3 L9: a SLUB allocation failure seen on the screen only).
const dmesg = gunzipSync(Buffer.from((await runLines('dmesg | gzip -9c | base64 -w 150', 120_000)).join(''), 'base64')).toString();
writeFileSync(`${out}/dmesg.txt`, dmesg);
results.kernel = (await runLines('dmesg --level=emerg,alert,crit,err,warn | tail -100')).filter(Boolean);
if ((results.kernel as string[]).length) log('kernel', (results.kernel as string[]).length, 'warnings or worse: dmesg.txt');
// What the core's heap and (Venus) the renderer's arena touched by the end (web/vm.ts `heapUse`; MiB).
results.memory = await s.page.evaluate(async () => {
  const w = window as unknown as { __heap?: Record<string, number>; __waarm64Heap?: () => void };
  w.__heap = undefined;
  w.__waarm64Heap?.();
  for (let i = 0; i < 100 && !w.__heap; i++) await new Promise((r) => setTimeout(r, 50));
  const h = w.__heap;
  return h && Object.fromEntries(['highBytes', 'touchedBytes', 'arenaBytes', 'arenaTouchedBytes', 'arenaHighBytes'].map((k) => [k.replace('Bytes', 'MiB'), Math.round(h[k] / 2 ** 20 * 10) / 10]));
});
log('memory', JSON.stringify(results.memory));
// Fewer statuses than cases: dEQP stopped (a crash, or LIMIT_S); the next case is where.
const done = Object.values(results.counts as Record<string, number>).reduce((a, b) => a + b, 0);
if (done < (results.cases as number)) {
  results.stoppedAt = await run(`sed -n '${done + 1}p' /tmp/cases.txt`);
  log('stopped at', results.stoppedAt);
}
// DETAIL=<n>: dEQP's own messages (its log's Text and Result lines) for the first <n> cases that didn't pass (with
// DETAIL_MATCH=<a regex>, of those whose names match it).
if (process.env.DETAIL) {
  const match = process.env.DETAIL_MATCH ? ` && $1 ~ /${process.env.DETAIL_MATCH.replace(/[/'\\]/g, '')}/` : '';
  // One pass over the log (a census has hundreds of such cases), gzipped through the terminal.
  const notSupported = process.env.DETAIL_NOTSUPPORTED ? '' : ' && $2 != "NotSupported"';
  await run(`awk '$2 != "Pass"${notSupported}${match} {print $1}' /tmp/deqp.res | head -${Number(process.env.DETAIL)} > /tmp/detail.txt`);
  const lines = gunzipSync(Buffer.from((await runLines(String.raw`awk 'FILENAME == "/tmp/detail.txt" {want[$1] = 1; next} /^#beginTestCaseResult /{on = ($2 in want); n = 0; if (on) print "== " $2; next} on && n < 12 && /<Text>|<Result / && !/<Text>(Transform feedback varyings|GL_TRANSFORM_FEEDBACK|v_|Testing|Rendering result comparison|gl[A-Z]|\/\/)/ {gsub(/^[ \t]+/, ""); print; n++}' /tmp/detail.txt /tmp/deqp.qpa | gzip -9c | base64 -w 150`, 600_000)).join(''), 'base64')).toString();
  results.detail = lines.split('\n').filter(Boolean);
  log('detail', (results.detail as string[]).length, 'lines');
}
// QPA=1: dEQP's whole log, its images in it, as <out>/deqp.qpa (for a few cases: it comes through the terminal).
if (process.env.QPA) writeFileSync(`${out}/deqp.qpa`, gunzipSync(Buffer.from((await runLines('gzip -9c /tmp/deqp.qpa | base64 -w 150', 600_000)).join(''), 'base64')));
if (CAPTURE) {
  clearInterval(drainTimer);
  while (draining) await new Promise((r) => setTimeout(r, 100));
  while (await drainCapture());
  log(`${CAPTURE}: ${captured} bytes of records`);
}
save();
log('done', (results.notPassed as string[]).length, 'not passed; warnings', s.warnings.size);
await s.close();
