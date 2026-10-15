// Ad hoc: round trips between a blocking "vCPU" worker and a "device" worker, by how each side waits.
const log = (s) => { document.getElementById('log').textContent += s + '\n'; };
const N = 20000;
async function run(mode) {
  const sab = new SharedArrayBuffer(16);
  const nested = mode.includes('nested');
  const host = nested ? new Worker('nest.js', { type: 'module' }) : null;
  const dev = nested ? null : new Worker('dev.js', { type: 'module' });
  const cpu = new Worker('cpu.js', { type: 'module' });
  const devMode = mode.split('+')[0], cpuMode = mode.split('+')[1];
  (dev ?? host).postMessage({ sab, mode: devMode });
  await new Promise((r) => setTimeout(r, 200));
  const res = await new Promise((r) => { cpu.onmessage = (e) => r(e.data); cpu.postMessage({ sab, mode: cpuMode, n: N }); });
  (dev ?? host).terminate(); cpu.terminate();
  return res;
}
const out = {};
for (let round = 0; round < 3; round++)
  for (const m of ['async+wait', 'async+spin', 'sync+wait', 'sync+spin', 'spin+spin', 'async-nested+spin', 'sync-nested+spin', 'asyncbusy+spin']) {
    const r = await run(m);
    (out[m] ??= []).push(r);
    log(`${m}: median ${r.p50.toFixed(1)} µs, p90 ${r.p90.toFixed(1)}`);
  }
window.benchResult = { results: Object.entries(out).map(([name, rs]) => ({ name, unit: 'us', samples: rs.map((r) => r.p50) })), crossOriginIsolated, userAgent: navigator.userAgent };
