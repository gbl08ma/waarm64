#!/usr/bin/env python3
"""PERF loop 74: the counts of `diag.patch`'s two cores, side by side (bench/boot/REPORT.md "PERF loop 74").

  python3 summary.py > summary.txt

`diag` is the tree's rule (a call's continuations are a function's entries), `all` every member where the head's
page has it (`WAARM64_ENTRIES_ALL`). The gates' guests in Node (gates-vm.json, gates-vm-all.json) and one Firefox pages
session each on the Mac (pages/diag-1, pages/all-1: the last line of jit.jsonl.gz as jit-last.json).
Slots (tally::M = 224): 3 interpreted steps reported at a key with no function, 4 of those at a region's member,
6 regions installed, 7 heads that were members, 8 members installed, 10-12 the member steps by what an entry there
would be (where the head's page has it outside a loop / in a region with a loop / elsewhere), 13 members where an
entry could be, 14 entries made, 15 heads that were members an entry could have been at.
"""
import gzip
import json
import os

here = os.path.dirname(os.path.abspath(__file__))


def load(path):
    return json.load(open(os.path.join(here, path)))


def last(path):
    with gzip.open(os.path.join(here, path), 'rt') as f:
        return json.loads(f.read().strip().split('\n')[-1])


def rows():
    a, b = load('gates-vm.json'), load('gates-vm-all.json')
    for x, y in zip(a['runs'], b['runs']):
        yield x['name'], x['steps'], x['t'], x['jit'], y['steps'], y['t'], y['jit']
    p, q = last('pages/diag-1/jit.jsonl.gz'), last('pages/all-1/jit.jsonl.gz')
    yield 'pages', p['steps'], p['jit']['diag'], p['jit'], q['steps'], q['jit']['diag'], q['jit']


JIT = ['bytes', 'modules', 'blocks', 'regionBlocks', 'inline', 'flagsStored', 'condMemory', 'emitNs', 'planNs',
       'compileNs', 'dispatches', 'decSteps']
for name, s0, t0, j0, s1, t1, j1 in rows():
    m0, m1 = t0[224:240], t1[224:240]
    print(f'== {name}: {s0:,} steps ({s1:,} with every entry)')
    print(f'  interpreted steps reported at a key with no function  {m0[3]:>15,} {m1[3]:>15,}')
    print(f'  of those at a member                                  {m0[4]:>15,} {m1[4]:>15,}  ({100 * m0[4] / m0[3]:.1f}% -> {100 * m1[4] / m1[3]:.1f}%)')
    for k, what in enumerate(['  where the head\'s page has it, no loop', '  in a region with a loop', '  elsewhere (another page)']):
        print(f'  {what:<52} {m0[10 + k]:>15,} {m1[10 + k]:>15,}')
    print(f'  regions; headed by a member; by one an entry could be  {m0[6]:,}; {m0[7]:,}; {m0[15]:,} -> {m1[6]:,}; {m1[7]:,}; {m1[15]:,}')
    print(f'  members; where an entry could be; entries made        {m0[8]:,}; {m0[13]:,}; {m0[14]:,} -> {m1[8]:,}; {m1[13]:,}; {m1[14]:,}')
    # The dispatcher's: block calls after interpreted code (slot 87, "compiled block, then interpreted code").
    print(f'  compiled block, then interpreted code (round trips)  {t0[87]:>15,} {t1[87]:>15,}')
    for k in JIT:
        a, b = j0[k], j1[k]
        print(f'  {k:<52} {a:>15,} {b:>15,}  {100 * (b - a) / a:+6.1f}%')
