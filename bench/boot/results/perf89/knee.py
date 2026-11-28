# PERF loop 89: where `PRESSURE_KNEE` engages in loop 63's long browser sessions (results/perf63/*/{mem,jit}.jsonl.gz):
# when the live modules cross 40, 80, 120 and 160 MiB (the knee at 1, 2 = today, 3, 4 eighths of 320 MiB, where the
# threshold leaves 1000 for 2000), and the steps run compiled and interpreted, and the wasm compiled, past 120 MiB.
# Usage: python3 knee.py (from this directory)
import gzip, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
for s in ('one', 'restart', 'j128'):
    d = os.path.join(HERE, '..', 'perf63', s)
    mem = [json.loads(l) for l in gzip.open(os.path.join(d, 'mem.jsonl.gz'), 'rt')]
    jit = [json.loads(l) for l in gzip.open(os.path.join(d, 'jit.jsonl.gz'), 'rt')]
    t0 = mem[0]['t']
    out = []
    for k in (40, 80, 120, 160):
        r = next((r for r in mem if r['memory']['jitLiveBytes'] >= k << 20), None)
        out.append(f'{k} MiB at ' + (f'{(r["t"] - t0) / 1000:.0f} s' if r else 'never'))
    last = mem[-1]
    print(f'{s}: {(last["t"] - t0) / 60000:.1f} min, budget {last["memory"]["jitBudget"] >> 20} MiB, live at the end '
          f'{last["memory"]["jitLiveBytes"] >> 20} MiB, flushes {last["jit"]["flushes"]}; live crosses ' + ', '.join(out))
    k = next((i for i, r in enumerate(jit) if r['jit']['bytes'] >= 120 << 20), None)
    if k is None or jit[-1]['jit']['flushes']:
        continue
    a, b, z = jit[k], jit[-1], jit[0]
    ds, dj = b['steps'] - a['steps'], b['jit']['steps'] - a['jit']['steps']
    print(f'  past 120 MiB: {(b["t"] - a["t"]) / 1000:.0f} s, {ds / 1e9:.1f} G steps, {100 * dj / ds:.2f}% compiled, '
          f'{(ds - dj) / 1e9:.2f} G interpreted, {(b["jit"]["bytes"] - a["jit"]["bytes"]) / 2**20:.1f} MiB of wasm, '
          f'{ds / (b["t"] - a["t"]) / 1e3:.0f} MIPS; before: '
          f'{100 * (a["jit"]["steps"] - z["jit"]["steps"]) / (a["steps"] - z["steps"]):.2f}% compiled')
