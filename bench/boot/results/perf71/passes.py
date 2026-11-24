import json, sys, statistics as st
# passes.py <ab.json> [arm]: PERF loop 71's diagnostic core (bench/results/local/perf71/diag-full.patch) packs, per
# compiled function, its emissions into the five flag counters; this unpacks the last measured sample's (the counts
# are cumulative over a page's life: the warm-up's and the samples' regions all count) for each workload.
d = json.load(open(sys.argv[1]))
arm = sys.argv[2] if len(sys.argv) > 2 else 'diag'
lo = lambda v: int(v) & 0xffffffff
hi = lambda v: int(v) >> 32
for w in sorted({r['workload'] for r in d['rows']}):
    rows = [r for r in d['rows'] if r['workload'] == w and r['arm'] == arm and 'stats' in r['s']]
    j = rows[-1]['s']['stats']['jit']
    single, single_red = lo(j['flagsStored']), hi(j['flagsStored'])
    h = {3: lo(j['flagsElided']), 4: hi(j['flagsElided']), 5: lo(j['condDirect']), 6: hi(j['condDirect']), 7: lo(j['condComputed'])}
    unset, bad = hi(j['condComputed']) & 0xffff, hi(j['condComputed']) >> 16
    red, tot = lo(j['condMemory']), hi(j['condMemory'])
    multi = sum(h.values())
    passes = 2 * single + sum(k * v for k, v in h.items())
    print(f'{w}: {single + multi} functions ({multi} of several blocks), {passes} emissions; single blocks {single} (2 passes; the second repeats the first: {single_red}, {100*single_red/max(single,1):.1f}%)')
    print(f'  several blocks by passes: ' + ', '.join(f'{k}{"+" if k == 7 else ""}: {v} ({100*v/max(multi,1):.1f}%)' for k, v in h.items()) + f'; unsettled {unset}, bad {bad}')
    print(f'  block-emissions {tot}, repeated {red} ({100*red/max(tot,1):.1f}%); emissions repeated {single_red + multi - unset} of {passes} ({100*(single_red + multi - unset)/max(passes,1):.1f}%, by count)')
