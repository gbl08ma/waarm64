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
// DETAIL=<n> (dEQP's messages for the first n cases that didn't pass; DETAIL_MATCH=<regex>: of those it names), VIRGL_GPU=virgl,debug (the renderer's trace,
// <out>/virgl-debug.txt), CAPTURE=<file.vglt> (the 3D commands, web/virgl-trace.ts: fixtures for tests/virgl.test.ts),
// LIMIT_S=<seconds the guest may run dEQP, default 1500>, PASSED=1 (results.passed: the cases that passed), QPA=1 (dEQP's
// log with its images, <out>/deqp.qpa: for a few cases).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { encodeTrace } from '../../web/virgl-trace.ts';
import { openSession } from './guest-session.ts';

const api = process.argv[2] ?? 'gles2';
const image = process.argv[3];
if (!image || !/^(gles[23]|vk)$/.test(api)) throw new Error('usage: node bench/gpu/deqp-run.ts <gles2|gles3|vk> <image.qcow2> [outdir]');
const vk = api === 'vk';
const out = process.argv[4] ?? new URL(`../results/local/deqp/${api}/`, import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const STRIDE = Number(process.env.STRIDE ?? 50);
const OFFSET = Number(process.env.OFFSET ?? 0);
const LIMIT_S = Number(process.env.LIMIT_S ?? 1500);
const CAPTURE = process.env.CAPTURE;
const s = await openSession({ gpu: (process.env.VIRGL_GPU ?? (vk ? 'virgl,vulkan' : 'virgl')) + (CAPTURE ? ',capture' : ''), image, out, disk2: vk ? '/target/deqp/deqp-vk.ext4' : '/target/deqp/deqp.ext4' });
const { log, pasteSerial, rootShell, run, runLines } = s;
const results: Record<string, unknown> = { api, gl: s.gl, chromium: s.browser.version(), stride: STRIDE, offset: OFFSET };
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
  await pasteSerial(`cat > /tmp/patterns.txt <<'EOF'\n${cases}\nEOF`);
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
  ? './deqp-vk --deqp-caselist-file=/tmp/cases.txt --deqp-shadercache-filename=/tmp/shadercache.bin'
  : `env EGL_PLATFORM=surfaceless ./deqp-${api} --deqp-caselist-file=/tmp/cases.txt --deqp-surface-type=pbuffer --deqp-gl-config-name=rgba8888d24s8ms0 --deqp-surface-width=256 --deqp-surface-height=256`;
// A case that crashes dEQP (or hangs past its watchdog) is recorded as `Crash` and dEQP goes on from the next one,
// until the list is done or LIMIT_S runs out; /tmp/deqp.cur names the case running.
await pasteSerial(String.raw`cat > /tmp/deqp.sh <<'EOF'
cd /mnt/vdb/deqp/API
echo core > /proc/sys/kernel/core_pattern; ulimit -c 0; dmesg -n 7
start=$(date +%s)
: > /tmp/deqp.res; : > /tmp/deqp.qpa; cp /tmp/cases.txt /tmp/rest.txt
while [ -s /tmp/rest.txt ]; do
  left=$(( LIMIT - ($(date +%s) - start) )); [ $left -gt 0 ] || break
  : > /tmp/deqp.cur
  timeout $left COMMAND \
    --deqp-log-filename=/tmp/deqp.part.qpa --deqp-log-images=IMAGES \
    --deqp-log-shader-sources=disable --deqp-watchdog=enable --deqp-archive-dir=/mnt/vdb/deqp/API 2>&1 |
    awk '/^Test case /{name=$3; sub(/^\047/, "", name); sub(/\047\.\.$/, "", name); t=systime(); print name > "/tmp/deqp.cur"; close("/tmp/deqp.cur"); next} /^  (Pass|Fail|NotSupported|QualityWarning|CompatibilityWarning|InternalError|Crash|Timeout|ResourceError) \(/{print name, $1, systime()-t; fflush(); name=""; printf "" > "/tmp/deqp.cur"; close("/tmp/deqp.cur")}' >> /tmp/deqp.res
  cat /tmp/deqp.part.qpa >> /tmp/deqp.qpa 2>/dev/null
  cur=$(cat /tmp/deqp.cur)
  [ -n "$cur" ] || break
  left=$(( LIMIT - ($(date +%s) - start) )); [ $left -gt 0 ] || break
  echo "$cur Crash 0" >> /tmp/deqp.res
  n=$(grep -n -x -F "$cur" /tmp/cases.txt | head -1 | cut -d: -f1)
  [ -n "$n" ] || break
  tail -n +$((n + 1)) /tmp/cases.txt > /tmp/rest.txt
done
echo "elapsed $(( $(date +%s) - start ))"
EOF`.replaceAll('API', api).replaceAll('LIMIT', String(LIMIT_S)).replace('IMAGES', process.env.QPA ? 'enable' : 'disable').replace('COMMAND', command.replace('/tmp/cases.txt', '/tmp/rest.txt')));
const t0 = performance.now();
const elapsed = await run('sh /tmp/deqp.sh', (LIMIT_S + 120) * 1000);
const seconds = (performance.now() - t0) / 1000;
results.seconds = seconds;
log('ran', elapsed, seconds.toFixed(0), 's');
results.counts = Object.fromEntries((await runLines("awk '{print $2}' /tmp/deqp.res | sort | uniq -c")).map((l) => l.split(/\s+/)).map(([c, k]) => [k, +c]));
log('counts', JSON.stringify(results.counts));
// Every case that didn't pass, and the slowest that did.
// Every case's status, gzipped through the terminal (a line a case would take a screen each six), then those that
// didn't pass; PASSED=1 keeps the ones that did (results.passed: what a pass list is made of).
const statuses = gunzipSync(Buffer.from((await runLines('gzip -9c /tmp/deqp.res | base64 -w 150', 300_000)).join(''), 'base64')).toString()
  .split('\n').filter(Boolean).map((l) => l.split(' '));
results.notPassed = statuses.filter(([, st]) => st !== 'Pass').map(([name, st]) => `${name} ${st}`);
if (process.env.PASSED) results.passed = statuses.filter(([, st]) => st === 'Pass').map(([name]) => name);
results.slowest = await runLines('sort -k3 -n -r /tmp/deqp.res | head -10');
results.last = await run('tail -3 /tmp/deqp.res');
// The guest kernel's log, whole, as <out>/dmesg.txt (gzipped through the terminal), and its warnings and worse in
// results.kernel: a run that ends in time kept none of it (VK3 L9: a SLUB allocation failure seen on the screen only).
const dmesg = gunzipSync(Buffer.from((await runLines('dmesg | gzip -9c | base64 -w 150', 120_000)).join(''), 'base64')).toString();
writeFileSync(`${out}/dmesg.txt`, dmesg);
results.kernel = (await runLines('dmesg --level=emerg,alert,crit,err,warn | tail -100')).filter(Boolean);
if ((results.kernel as string[]).length) log('kernel', (results.kernel as string[]).length, 'warnings or worse: dmesg.txt');
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
  results.detail = await runLines(`awk '$2 != "Pass" && $2 != "NotSupported"${match} {print $1}' /tmp/deqp.res | head -${Number(process.env.DETAIL)} | while read -r c; do echo "== $c"; awk -v c="$c" '/#beginTestCaseResult/{on = index($0, c) > 0} on && /<Text>|<Result /{gsub(/^[ \t]+/, ""); print}' /tmp/deqp.qpa | grep -v -E "^<Text>(Transform feedback varyings|GL_TRANSFORM_FEEDBACK|v_|Testing|Rendering result comparison|gl[A-Z]|//)" | head -12; done`, 120_000);
  log('detail', (results.detail as string[]).join('\n'));
}
// QPA=1: dEQP's whole log, its images in it, as <out>/deqp.qpa (for a few cases: it comes through the terminal).
if (process.env.QPA) writeFileSync(`${out}/deqp.qpa`, gunzipSync(Buffer.from((await runLines('gzip -9c /tmp/deqp.qpa | base64 -w 150', 600_000)).join(''), 'base64')));
if (CAPTURE) {
  // The guest's 3D commands with the memory they read, from boot (nothing 3D runs before dEQP) to the end.
  const b64 = await s.page.evaluate(() => {
    const rs = (window as unknown as { __virglCapture?: Uint8Array[] }).__virglCapture ?? [];
    let t = '';
    for (const r of rs) for (let k = 0; k < r.length; k += 8192) t += String.fromCharCode(...r.subarray(k, k + 8192));
    return btoa(t);
  });
  const trace = encodeTrace([new Uint8Array(Buffer.from(b64, 'base64'))]);
  writeFileSync(CAPTURE, trace);
  log(`${CAPTURE}: ${trace.length} bytes`);
}
save();
log('done', (results.notPassed as string[]).length, 'not passed; warnings', s.warnings.size);
await s.close();
