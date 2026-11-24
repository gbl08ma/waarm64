import json, sys
# cycles.py <ab.json> [arm]: PERF loop 71's second diagnostic core (bench/results/local/perf71/diag2-full.patch):
# per workload, the regions whose entry states never settle, those whose states come back to an earlier one
# within the four iterations (a cycle: the iterations after it repeat emissions already made), and the
# block-emissions (an emission's blocks) each accounts for; the last measured sample's cumulative counts.
d = json.load(open(sys.argv[1]))
arm = sys.argv[2] if len(sys.argv) > 2 else 'diag2'
lo = lambda v: int(v) & 0xffffffff
hi = lambda v: int(v) >> 32
for w in sorted({r['workload'] for r in d['rows']}):
    rows = [r for r in d['rows'] if r['workload'] == w and r['arm'] == arm and 'stats' in r['s']]
    j = rows[-1]['s']['stats']['jit']
    tot, rep = lo(j['condDirect']), hi(j['condDirect'])
    uns, cyc = lo(j['flagsStored']), hi(j['flagsStored'])
    utot, usaved = lo(j['flagsElided']), hi(j['flagsElided'])
    cc = int(j['condComputed'])
    k2, k3 = cc & (2**21 - 1), (cc >> 21) & (2**21 - 1)
    print(f'{w}: block-emissions {tot}; the last repeating the one before {rep} ({100*rep/tot:.1f}%)')
    print(f'  unsettled regions {uns}: {utot} block-emissions ({100*utot/tot:.1f}%); cycling early {cyc} (at 2: {k2}, at 3: {k3}), '
          f'their repeated iterations {usaved} ({100*usaved/tot:.1f}%)')
