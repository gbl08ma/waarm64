// dEQP on the page (G4's correctness gate, the kickoff's decision 3; dev-only for now): the user's Arch image
// (`bench/results/local/myarch3.qcow2`, Mesa's virgl in the guest) on a 3D machine, dEQP on its second disk
// (images/deqp/build.sh → target/deqp/deqp.ext4, mounted at /mnt/vdb, the files in /mnt/vdb/deqp), deqp-gles2 or
// deqp-gles3 run as root on EGL's surfaceless platform (no compositor) over a case list: a mustpass list, every <n>th case of it (STRIDE), or the
// cases a file names (CASES). Writes <out>/results.json: the counts by status and every case that didn't pass, with
// the time a case took. The renderer's warnings come along (results.warnings).
//   node bench/gpu/deqp-run.ts <gles2|gles3> <image.qcow2> [outdir]
// DETAIL=<n> keeps dEQP's messages for the first n cases that didn't pass. CAPTURE=<file.vglt> keeps the 3D commands (web/virgl-trace.ts: fixtures for tests/virgl.test.ts). STRIDE=<n> (default 50), CASES=<file of case names, `*` wildcards allowed>, VIRGL_GPU=virgl,debug for the renderer's
// trace (<out>/virgl-debug.txt), LIMIT_S=<seconds the guest may run dEQP, default 1500>.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { encodeTrace } from '../../web/virgl-trace.ts';
import { openSession } from './guest-session.ts';

const api = process.argv[2] ?? 'gles2';
const image = process.argv[3];
if (!image || !/^gles[23]$/.test(api)) throw new Error('usage: node bench/gpu/deqp-run.ts <gles2|gles3> <image.qcow2> [outdir]');
const out = process.argv[4] ?? new URL(`../results/local/deqp/${api}/`, import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const STRIDE = Number(process.env.STRIDE ?? 50);
const LIMIT_S = Number(process.env.LIMIT_S ?? 1500);
const CAPTURE = process.env.CAPTURE;
const s = await openSession({ gpu: (process.env.VIRGL_GPU ?? 'virgl') + (CAPTURE ? ',capture' : ''), image, out, disk2: '/target/deqp/deqp.ext4' });
const { log, pasteSerial, rootShell, run, runLines } = s;
const results: Record<string, unknown> = { api, gl: s.gl, chromium: s.browser.version(), stride: STRIDE };
const save = () => {
  writeFileSync(`${out}/results.json`, JSON.stringify({ ...results, warnings: Object.fromEntries(s.warnings) }, null, 1));
  if (s.debugLines.length) writeFileSync(`${out}/virgl-debug.txt`, s.debugLines.join('\n') + '\n');
};


await rootShell();
results.info = await run('uname -r; pacman -Q mesa | tr "\\n" " "; mkdir -p /mnt/vdb; mount -o ro /dev/vdb /mnt/vdb && ls /mnt/vdb/deqp | tr "\\n" " "');
log('info', results.info);
// The case list, in the guest.
if (process.env.CASES) {
  const cases = readFileSync(process.env.CASES, 'utf8').trim();
  await pasteSerial(`cat > /tmp/patterns.txt <<'EOF'\n${cases}\nEOF`);
  // A name with `*` stands for the mustpass list's cases it matches (dEQP's case lists take no wildcards).
  await run(`while read -r p; do case "$p" in *'*'*) grep -E "^$(echo "$p" | sed 's/[.]/[.]/g; s/[*]/.*/g')$" /mnt/vdb/deqp/${api}-main.txt;; *) echo "$p";; esac; done < /tmp/patterns.txt > /tmp/cases.txt`);
} else await run(`awk 'NR % ${STRIDE} == 1' /mnt/vdb/deqp/${api}-main.txt > /tmp/cases.txt`);
results.cases = Number(await run('wc -l < /tmp/cases.txt'));
log('cases', results.cases);
// dEQP writes `Test case '<name>'..` then a status line per case; a status per case, with the seconds it took.
await pasteSerial(String.raw`cat > /tmp/deqp.sh <<'EOF'
cd /mnt/vdb/deqp/API
start=$(date +%s)
EGL_PLATFORM=surfaceless timeout LIMIT ./deqp-API --deqp-caselist-file=/tmp/cases.txt --deqp-surface-type=pbuffer --deqp-gl-config-name=rgba8888d24s8ms0 \
  --deqp-surface-width=256 --deqp-surface-height=256 --deqp-log-filename=/tmp/deqp.qpa --deqp-log-images=disable \
  --deqp-log-shader-sources=disable --deqp-watchdog=enable --deqp-archive-dir=/mnt/vdb/deqp/API 2>&1 |
  awk '/^Test case /{name=$3; sub(/^\047/, "", name); sub(/\047\.\.$/, "", name); t=systime(); next} /^  (Pass|Fail|NotSupported|QualityWarning|CompatibilityWarning|InternalError|Crash|Timeout|ResourceError) \(/{print name, $1, systime()-t; fflush()}' > /tmp/deqp.res
echo "elapsed $(( $(date +%s) - start ))"
EOF`.replaceAll('API', api).replace('LIMIT', String(LIMIT_S)));
const t0 = performance.now();
const elapsed = await run('sh /tmp/deqp.sh', (LIMIT_S + 120) * 1000);
const seconds = (performance.now() - t0) / 1000;
results.seconds = seconds;
log('ran', elapsed, seconds.toFixed(0), 's');
results.counts = Object.fromEntries((await runLines("awk '{print $2}' /tmp/deqp.res | sort | uniq -c")).map((l) => l.split(/\s+/)).map(([c, k]) => [k, +c]));
log('counts', JSON.stringify(results.counts));
// Every case that didn't pass, and the slowest that did.
results.notPassed = await runLines("awk '$2 != \"Pass\" {print $1, $2}' /tmp/deqp.res", 120_000);
results.slowest = await runLines('sort -k3 -n -r /tmp/deqp.res | head -10');
results.last = await run('tail -3 /tmp/deqp.res');
// DETAIL=<n>: dEQP's own messages (its log's Text and Result lines) for the first <n> cases that didn't pass.
if (process.env.DETAIL) {
  results.detail = await runLines(`awk '$2 != "Pass" && $2 != "NotSupported" {print $1}' /tmp/deqp.res | head -${Number(process.env.DETAIL)} | while read -r c; do echo "== $c"; awk -v c="$c" '/#beginTestCaseResult/{on = index($0, c) > 0} on && /<Text>|<Result /{gsub(/^[ \t]+/, ""); print}' /tmp/deqp.qpa | grep -v -E "^<Text>(Transform feedback varyings|GL_TRANSFORM_FEEDBACK|v_|Testing|Rendering result comparison|gl[A-Z]|//)" | head -12; done`, 120_000);
  log('detail', (results.detail as string[]).join('\n'));
}
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
