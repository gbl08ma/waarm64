import json, sys, statistics as st
# counts.py <ab.json>: the diagnostic cores' tallies (diag.patch: PERF loop 66), per workload and arm, the measured
# samples' medians. The patch publishes them in the static flag counters' words:
#   flagsStored  entries into a loop head compiled alone through its redirected hot word (dynamic)
#   flagsElided  entries into such a head while its word still counts down (dynamic)
#   condDirect   heads compiled alone (a hot word)
#   condComputed blocks compiled again (compiled before since the last flush or the page's IC, or twice in one module)
#   condMemory   of those, blocks of tier-up loop regions
#   backEdges    blocks of tier-up loop regions
d = json.load(open(sys.argv[1]))
arms = [a['name'] for a in d['arms']]
J = lambda k: lambda s: s['stats']['jit'][k]
rows = [
    ('steps (G)', lambda s: s['stats']['steps'] / 1e9, '%.3f'),
    ('redirects (M)', lambda s: J('flagsStored')(s) / 1e6, '%.2f'),
    ('  per 1000 steps', lambda s: 1000 * J('flagsStored')(s) / s['stats']['steps'], '%.3f'),
    ('head entries counting (M)', lambda s: J('flagsElided')(s) / 1e6, '%.2f'),
    ('dispatches per 1000 steps', lambda s: 1000 * J('dispatches')(s) / s['stats']['steps'], '%.3f'),
    ('heads compiled alone', J('condDirect'), '%.0f'),
    ('tier-ups', J('tierUps'), '%.0f'),
    ('regions', J('blocks'), '%.0f'),
    ('  tier-ups/regions %', lambda s: 100 * J('tierUps')(s) / J('blocks')(s), '%.1f'),
    ('modules', J('modules'), '%.0f'),
    ('blocks in regions', J('regionBlocks'), '%.0f'),
    ('blocks of tier-up regions', J('backEdges'), '%.0f'),
    ('blocks compiled again', J('condComputed'), '%.0f'),
    ('  in tier-up regions', J('condMemory'), '%.0f'),
    ('  again/blocks %', lambda s: 100 * J('condComputed')(s) / J('regionBlocks')(s), '%.1f'),
    ('wasm MiB', lambda s: J('bytes')(s) / 2**20, '%.2f'),
    ('interpreted (M)', lambda s: J('decSteps')(s) / 1e6, '%.0f'),
    ('emit ms', lambda s: J('emitNs')(s) / 1e6, '%.0f'),
    ('plan ms', lambda s: J('planNs')(s) / 1e6, '%.0f'),
    ('V8 compile ms', lambda s: J('compileNs')(s) / 1e6, '%.0f'),
    ('wall ms', lambda s: s['ms'], '%.0f'),
]
for w in sorted({r['workload'] for r in d['rows']}):
    by = {a: [r['s'] for r in d['rows'] if r['arm'] == a and r['workload'] == w and not r.get('warm') and 'stats' in r['s']] for a in arms}
    print('workload', w, {a: len(v) for a, v in by.items()})
    print('%-28s' % '' + ''.join('%12s' % a for a in arms))
    for name, f, fmt in rows:
        print('%-28s' % name + ''.join('%12s' % (fmt % st.median([f(s) for s in by[a]]) if by[a] else '-') for a in arms))
    print()
