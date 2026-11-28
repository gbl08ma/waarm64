import json, sys
# counts.py <ab.json> [arm]: PERF loop 94's diagnostic core (diag.py): per workload, the regions of several blocks,
# those whose entry states never settle, the members emitted today (an emission of an n-block region counts n), and
# what re-emitting only the members whose inputs changed would cost: A every settle iteration so, B the first in
# full and the later ones so (then a full last emission unless the first iteration settled). The last sample's
# cumulative counts.
d = json.load(open(sys.argv[1]))
arm = sys.argv[2] if len(sys.argv) > 2 else 'base'
lo = lambda v: int(v) & 0xffffffff
hi = lambda v: int(v) >> 32
for w in sorted({r['workload'] for r in d['rows']}):
    rows = [r for r in d['rows'] if r['workload'] == w and r['arm'] == arm and 'stats' in r['s']]
    j = rows[-1]['s']['stats']['jit']
    today, tu = lo(j['condDirect']), hi(j['condDirect'])
    uns, regs = lo(j['flagsStored']), hi(j['flagsStored'])
    a, b = lo(j['flagsElided']), hi(j['flagsElided'])
    ua, ub = lo(j['condComputed']), hi(j['condComputed'])
    s8, s16 = lo(j['condMemory']), hi(j['condMemory'])
    print(f'{w}: regions of several blocks {regs}, never settled {uns} ({100*uns/regs:.1f}%)')
    print(f'  members emitted {today}, by the unsettled {tu} ({100*tu/today:.1f}%)')
    print(f'  incremental A {a} ({100*(a-today)/today:+.1f}%), B {b} ({100*(b-today)/today:+.1f}%); '
          f'the unsettled alone A {ua} ({100*(ua-tu)/tu:+.1f}%), B {ub} ({100*(ub-tu)/tu:+.1f}%)')
    print(f'  unsettled that settle by 8 iterations {s8}, by 16 {s16} (of {uns})')
