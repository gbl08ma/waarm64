#!/usr/bin/env python3
# PERF loop 83's wake tallies (diag.patch: core/src/tally.rs W_* at 80-98, the worker's at 91-97), a second each:
#   python3 wakes.py counts-vm.json            # bench/boot/preempt-counts.ts --json (its runs' t, 104 words)
#   python3 wakes.py <session>/jit.jsonl.gz    # a pages session's JITLOG (`jit.wake`: words 80-103 summed)
#   python3 wakes.py idle.txt                  # idle-cpu.ts lines (`wakePerS`: words 80-103 a second)
import gzip, json, sys

NAMES = ['woken', 'timed', 'empty', 'emptyTimed', 'device', 'deviceEmpty', 'byCore', 'byIrq', 'bySignal', 'first',
         'last', 'emptyCoreNs', 'emptySpins', 'emptySpinHit', 'emptySpinNs', 'spins', 'spinHit', 'spinNs', 'rx']


def show(label, w, secs, ncpus):
    # w: words 80.. as a list (totals over `secs`), or rates when secs == 1
    r = {n: w[k] / secs for k, n in enumerate(NAMES)}
    # The host's bumps: the wake words' advance less the core's own (`Vm::wake`); `first` is the word + 1 at the first
    # entry, so a rate's `first` is 0 and the advance is `last`'s.
    adv = r['last'] - (r['first'] - ncpus / secs if r['first'] else 0)
    host = adv - r['byCore']
    cost = (r['emptyCoreNs'] + r['emptySpinNs']) / 1e7  # % of one core
    spin = r['spinNs'] / 1e7
    print(f"{label}: woken {r['woken']:.0f}/s, timed {r['timed']:.0f}/s; empty after a wake {r['empty']:.0f}/s "
          f"(taker of the device signal {r['deviceEmpty']:.0f}), empty timed {r['emptyTimed']:.0f}/s; "
          f"device signals taken {r['device']:.0f}/s, RX {r['rx']:.0f}/s; wakes by the core {r['byCore']:.0f}/s "
          f"(IRQ rise {r['byIrq']:.0f}, signal {r['bySignal']:.0f}), by the host ~{host:.0f}/s (summed over vCPUs); "
          f"empty exits' cost {cost:.2f}% of a core (core {r['emptyCoreNs'] / max(r['empty'], 1e-9) / 1e3:.1f} µs, "
          f"spin {r['emptySpinNs'] / max(r['emptySpins'], 1e-9) / 1e3:.1f} µs each; spin hit "
          f"{100 * r['emptySpinHit'] / max(r['emptySpins'], 1e-9):.0f}%); all spins {r['spins']:.0f}/s, "
          f"{spin:.2f}% of a core, hit {100 * r['spinHit'] / max(r['spins'], 1e-9):.0f}%")


for f in sys.argv[1:]:
    if f.endswith('.json'):
        for run in json.load(open(f))['runs']:
            show(f"{f} {run['name']}", run['t'][80:99], run['ms'] / 1000, run['ncpus'])
    elif 'jsonl' in f:
        op = gzip.open if f.endswith('.gz') else open
        rows = [json.loads(l) for l in op(f, 'rt') if l.strip()]
        rows = [x for x in rows if 'wake' in x.get('jit', {})]
        a, b = rows[0], rows[-1]
        secs = (b['t'] - a['t']) / 1000
        show(f"{f} ({secs:.0f} s)", [y - x for x, y in zip(a['jit']['wake'], b['jit']['wake'])][:19], secs, 0)
    else:
        for line in open(f):
            i = line.find('{')
            if i < 0:
                continue
            d = json.loads(line[i:])
            w = d['wakePerS'][:19]
            w[9] = 0
            show(f"{line[:i].strip() or f} cpu {d['cpuPct']}%", w, 1, d['ncpus'])
