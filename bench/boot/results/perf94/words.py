import json, sys
# words.py <ab.json> [arm]: PERF loop 94's second diagnostic core (diag2.py): the guest instructions emitted per
# workload (an emission of a member counts its words), today's (the base: every emission whole, the settled one
# kept) against the change's (partial settling emissions, a whole last one).
d = json.load(open(sys.argv[1]))
arm = sys.argv[2] if len(sys.argv) > 2 else 'diag2'
for w in sorted({r['workload'] for r in d['rows']}):
    rows = [r for r in d['rows'] if r['workload'] == w and r['arm'] == arm and 'stats' in r['s']]
    j = rows[-1]['s']['stats']['jit']
    whole, red, skip, extra, funcs = (int(j[k]) for k in ('condDirect', 'flagsStored', 'flagsElided', 'condComputed', 'condMemory'))
    new = whole + red
    base = whole + red + skip - extra
    print(f'{w}: words in the functions {funcs}; emitted today {base} ({base/funcs:.2f} each), with the change {new} '
          f'({100*(new-base)/base:+.1f}%): whole {whole}, partial emitted {red} and skipped {skip}, last emissions added {extra}')
