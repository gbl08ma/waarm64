#!/usr/bin/env python3
"""PERF loop 75: the counts of `diag.patch`'s core (bench/boot/REPORT.md "PERF loop 75").

  python3 summary.py > summary.txt

The gates' guests in Node (gates-vm.json) and two Firefox pages sessions on the Mac (pages/diag-1, and pages/first-1 with the core before
slots 20-23 were added: the last line of jit.jsonl.gz). Slots from tally::A = 1152 (`block::dom_counts`): run by compiled code, 0 immediate probes, 1 accesses a
group's probe covers, 2 other loads and stores, 3-5 probes an earlier probe of the region already made along every
edge in with today's entries (SP / X29 / other bases), 6-8 the same if an entry's way in probed again, 9 all bases if
SP and X19-X29 also kept their probes across host calls, 10 probes an earlier probe of the same block made (no group
took them), 11 member runs, 12 the immediate probes of looped regions, 13 slots 3-5 there, 14 slots 3-5 in members in
another page; 20 backward chains to an entry, 21 backward by-VA links that hit an entry, 22 backward chains through
the jump cache that hit one, 23 ways in at an entry (the prologue's). A+64.. the same counted statically (once per region compiled). A+96..: Liftoff's fill (row 19): calls
of functions that fill, their fill turns, the turns with X registers sharing locals (PERF loop 27's model), functions
that fill (static).
"""
import gzip
import json
import os

here = os.path.dirname(os.path.abspath(__file__))
A = 1152


def rows():
    g = json.load(open(os.path.join(here, 'gates-vm.json')))
    for x in g['runs']:
        yield x['name'], x['steps'], x['t'], x['jit']
    for d, name in [('diag-1', 'pages'), ('first-1', 'pages, the first core (no backward-entry counters)')]:
        p = os.path.join(here, 'pages', d, 'jit.jsonl.gz')
        with gzip.open(p, 'rt') as f:
            q = json.loads(f.read().strip().split('\n')[-1])
        yield name, q['steps'], q['jit']['diag'], q['jit']


def pct(a, b):
    return 100 * a / b if b else 0


for name, steps, t, jit in rows():
    d, s, fl = t[A:A + 16], t[A + 64:A + 80], t[A + 96:A + 100]
    print(f'== {name}: {steps:,} steps; wasm {jit["bytes"]:,} bytes, {jit["modules"]:,} modules')
    print(f'  immediate probes run {d[0]:,} ({d[0] / steps:.3f} a step); group followers {d[1]:,}; other accesses {d[2]:,}')
    for lab, a, b in [('today\'s entries', 3, 6), ('entries probing again', 6, 9)]:
        dom = sum(d[a:b])
        sdom = sum(s[a:b])
        print(f'  made earlier in the region, {lab:<22} {dom:>15,} ({pct(dom, d[0]):5.2f}% of the probes run; SP {pct(d[a], d[0]):.2f}, X29 {pct(d[a + 1], d[0]):.2f}, other {pct(d[a + 2], d[0]):.2f}); static {sdom:,} of {s[0]:,} ({pct(sdom, s[0]):.2f}%)')
    print(f'  ... and SP, X19-X29 across host calls      {d[9]:>15,} ({pct(d[9], d[0]):5.2f}%); static {s[9]:,} ({pct(s[9], s[0]):.2f}%)')
    print(f'  made earlier in the same block (no group)  {d[10]:>15,} ({pct(d[10], d[0]):5.2f}%); static {s[10]:,} ({pct(s[10], s[0]):.2f}%)')
    print(f'  member runs {d[11]:,}; looped regions\' probes {d[12]:,} ({pct(d[12], d[0]):.1f}%), dominated there {d[13]:,}; in other-page members {d[14]:,}')
    if t[A + 23]:
        back = t[A + 20] + t[A + 21] + t[A + 22]
        print(f'  backward transfers to an entry {back:,} (chains {t[A + 20]:,}, by-VA links {t[A + 21]:,}, through the jump cache {t[A + 22]:,}) of {t[A + 23]:,} ways in at an entry; loop back-edges {t[0]:,}')
    if fl[0]:
        print(f'  fill: calls of filling functions {fl[0]:,} ({1000 * fl[0] / steps:.2f} per 1000 steps), turns {fl[1]:,} ({fl[1] / fl[0]:.1f} a call, {fl[1] / steps:.3f} a step), with sharing {fl[2]:,} ({pct(fl[1] - fl[2], fl[1]):.1f}% fewer); functions that fill {fl[3]:,}')
    for k in ['emitNs', 'compileNs', 'decSteps']:
        print(f'  {k} {jit[k]:,}')
