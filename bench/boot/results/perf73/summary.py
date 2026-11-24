#!/usr/bin/env python3
"""PERF loop 73: the counts before (PERF loop 72's, ../perf72) and after the sibling fill and the collapsed queue's
change. `python3 summary.py > summary.txt` (in this directory)."""
import json

T, Q, M, H = 128, 192, 224, 256


def rows(d):
    out = []
    for r in json.load(open(f'{d}/gates-vm.json'))['runs']:
        out.append((r['name'], r['steps'], r['t']))
        out += [(r['name'] + '/' + p['name'], p['steps'], p['t']) for p in r['phases']]
    p = json.load(open(f'{d}/pages/jit-last.json'))
    out.append(('pages (Mac)', p['steps'], p['jit']['diag']))
    return out


before, after = rows('../perf72'), rows('.')
print('TLB misses before -> after (per million steps), by array EL0 r/w/x EL1 r/w/x; fills that found the page in the same')
print("EL's other data array; sibling fills (at a read's walk / at a write's); instructions run by helpers")
for (n, s0, a), (_, s1, b) in zip(before, after):
    m0, m1 = sum(a[T:T + 6]), sum(b[T:T + 6])
    print(f"{n:20} misses {m0:>10,} -> {m1:>10,} ({100 * (m1 / s1) / (m0 / s0) - 100:+.1f}% a step; {m0 * 1e6 / s0:.0f} -> {m1 * 1e6 / s1:.0f}/M)")
    print(f"{'':20} by array {'/'.join(f'{x / 1e3:.0f}K' for x in a[T:T + 6])} -> {'/'.join(f'{x / 1e3:.0f}K' for x in b[T:T + 6])}")
    print(f"{'':20} the other array had the page {a[T + 28] + a[T + 29]:,} -> {b[T + 28] + b[T + 29]:,}; sibling fills {b[T + 48]:,} / {b[T + 49]:,} (over an entry: {b[T + 50]}); evictions {a[T + 33]:,} -> {b[T + 33]:,}; nG list overflows {a[T + 40]:,} of {a[T + 39]:,} -> {b[T + 40]:,} of {b[T + 39]:,} flush_ng")
    print(f"{'':20} helper instructions {sum(a[H:]):,} -> {sum(b[H:]):,} ({100 * (sum(b[H:]) / s1) / (sum(a[H:]) / s0) - 100:+.1f}% a step); steps {s0:,} -> {s1:,}")
    if any(b[Q:Q + 25]):
        print(f"{'':20} flush_all {a[T + 36]:,} -> {b[T + 36]:,}; collapsed queues {a[Q + 8]:,} -> {b[Q + 8]:,}, of user-half VAs and ASIDs only {a[Q + 9]:,} -> {b[Q + 23]:,} (the TLB with a low global entry: {b[Q + 24]}); at a collapse (sampled) {a[Q + 17] / max(a[Q + 19], 1):,.0f} valid entries, {a[Q + 18] / max(a[Q + 19], 1):,.0f} global -> {b[Q + 17] / max(b[Q + 19], 1):,.0f}, {b[Q + 18] / max(b[Q + 19], 1):,.0f}")
        print(f"{'':20} transfer cache generation bumps {a[T + 45]:,} -> {b[T + 45]:,}; miss function found/failed {a[96 + 16]:,}/{a[96 + 15]:,} -> {b[96 + 16]:,}/{b[96 + 15]:,}, on an older generation {a[96 + 13]:,} -> {b[96 + 13]:,}")
