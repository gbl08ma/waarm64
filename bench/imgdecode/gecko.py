# Firefox's profile from desktop.ts GECKO=1 (<case>.gecko.json.xz): every thread's markers by name (count, total ms),
# and per round (from the content process's keydown DOMEvent markers) each thread's markers on one time axis.
#   python3 bench/imgdecode/gecko.py <file.gecko.json.xz> [names|rounds|round <k>|samples]
import json, lzma, sys, collections

p = json.load(lzma.open(sys.argv[1]) if sys.argv[1].endswith(".xz") else open(sys.argv[1]))
mode = sys.argv[2] if len(sys.argv) > 2 else 'names'

def threads(prof, proc=''):
    # Times in a subprocess are relative to its own meta.startTime: put them on the parent's axis.
    base = prof['meta']['startTime']
    for t in prof['threads']:
        yield proc or t.get('processName', ''), t, base
    for sub in prof.get('processes', []):
        yield from threads(sub, sub['threads'][0].get('processName', 'child') if sub['threads'] else 'child')

T0 = p['meta']['startTime']
def markers(t, base):
    """(name, start, end or None, data) on the parent's axis; phases: 0 instant, 1 interval, 2 start, 3 end (paired)."""
    sch = t['markers']['schema']
    st = t['stringTable']
    off = base - T0
    open_ = {}
    for m in t['markers']['data']:
        name = st[m[sch['name']]]
        s, e, ph = m[sch['startTime']], m[sch['endTime']], m[sch['phase']]
        data = m[sch['data']] if 'data' in sch and len(m) > sch['data'] else None
        if ph == 0: yield name, s + off, None, data
        elif ph == 1: yield name, s + off, e + off, data
        elif ph == 2: open_[name] = (s, data)
        elif ph == 3 and name in open_:
            s0, d0 = open_.pop(name)
            yield name, s0 + off, e + off, d0 or data

all_threads = [(pn, t['name'], t, base) for pn, t, base in threads(p)]
if mode == 'names':
    for pn, tn, t, base in all_threads:
        c = collections.Counter(); ms = collections.Counter()
        for name, s, e, d in markers(t, base):
            c[name] += 1
            if s is not None and e is not None: ms[name] += e - s
        if not c: continue
        print(f'== {pn} / {tn} ({len(t["samples"]["data"])} samples)')
        for k, v in c.most_common(25): print(f'   {v:6d} {ms[k]:9.1f} ms  {k}')
    sys.exit()

# Rounds: keydown DOMEvents in the content process's main thread.
starts = []
for pn, tn, t, base in all_threads:
    if tn == 'GeckoMain' and 'Content' in pn or tn == 'GeckoMain' and pn.startswith('Web'):
        for name, s, e, d in markers(t, base):
            if name == 'DOMEvent' and d and d.get('eventType') == 'keydown': starts.append(s)
starts.sort()
print('rounds at', [round(x) for x in starts])
if mode == 'rounds':
    # Per round, per thread: busy ms (markers' union is too fine; use CPU deltas from samples) and the last marker's time.
    for k, s0 in enumerate(starts):
        s1 = starts[k + 1] if k + 1 < len(starts) else s0 + 10000
        print(f'-- round {k} at {s0:.0f}')
        for pn, tn, t, base in all_threads:
            c = collections.Counter(); last = 0; ms = collections.Counter()
            for name, s, e, d in markers(t, base):
                if s is None or s < s0 or s >= s1: continue
                c[name] += 1; last = max(last, (e or s) - s0)
                if e is not None: ms[name] += e - s
            if c:
                top = ', '.join(f'{n}×{c[n]} {ms[n]:.0f}ms' for n, _ in c.most_common(6))
                print(f'   {pn[:14]:14s} {tn[:22]:22s} last {last:7.0f}  {top}')
elif mode == 'round':
    k = int(sys.argv[3]); s0 = starts[k]; s1 = starts[k + 1] if k + 1 < len(starts) else s0 + 10000
    ev = []
    for pn, tn, t, base in all_threads:
        for name, s, e, d in markers(t, base):
            if s is None or s < s0 - 1000 or s >= s1: continue
            if name in ('Awake',): continue
            extra = ''
            if d:
                for key in ('name', 'type', 'eventType', 'category', 'phase', 'messageType', 'uri', 'reason'):
                    if key in d and d[key] is not None: extra += f' {key}={str(d[key])[:60]}'
            ev.append((s - s0, (e - s) if e is not None else None, f'{pn[:12]}/{tn[:20]}', name, extra))
    ev.sort(key=lambda x: (x[0], x[2], x[3]))
    for s, dur, th, name, extra in ev:
        print(f'{s:8.1f} {("%7.1f" % dur) if dur is not None else "      -"} {th:34s} {name}{extra}')
