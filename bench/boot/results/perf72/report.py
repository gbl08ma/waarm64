#!/usr/bin/env python3
"""PERF loop 72: the diagnostic core's tallies (diag.patch), labelled.

  python3 report.py gates-vm.json            the gates' guests (bench/boot/preempt-counts.ts --json)
  python3 report.py pages/jit-last.json      a pages session's last jit.jsonl line ({steps, jit: {diag, ...}})

Each line: the slot, its count, its count per million steps. `ops.json` names the helper histogram's slots.
"""
import json
import os
import sys

JIT = ['back-edge', 'forward edge', 'transfer cache hit (no RET/BLR/BR: 0 here)', 'miss function entered',
       'jump cache hit (MMU off)', 'chain back', 'chain fwd', 'chain via jc back', 'chain via jc fwd',
       'by-VA link back (hit)', 'by-VA link fwd (hit)', 'host call', 'host return', 'poll']
DISP = ['block call after an exit', 'after a chunk end', 'after the interpreter, stopped before a compiled block',
        'after the interpreter, otherwise', 'after a compiled block, successor in the jump cache',
        'after a compiled block, successor through Jit::miss', 'block calls with a jump-cache hit',
        'compiled block, then interpreted code', 'interpreted runs', 'exits after a compiled block',
        'exits after interpreted code', 'chunk ends', 'interpreted steps (the dispatcher\'s runs)',
        'stops by the word at the dispatcher', 'of those, after a compiled block', '(state)']
X = ['transfer cache hit: RET', 'transfer cache hit: BLR', 'transfer cache hit: BR',
     'probe missed: unsaid', 'probe missed: RET', 'probe missed: BLR', 'probe missed: BR', 'probe missed: by-VA link',
     'miss function straight from a chain whose guard failed', 'miss function after a host return elsewhere',
     'miss function: entry zeroed', 'miss function: another tag', 'of those, same slot among 65,536 too',
     'miss function: an older generation', 'miss function: tag and generation right',
     'miss function failed (returns)', 'miss function found the block (fills, tail-calls)',
     'stops (a block returns, no exit, no transfer)', 'stops at depth > 0', 'stops: depths summed',
     'stops not by budget or stop word', 'of those at depth > 0', 'of those: depths summed',
     'host frames left unreturned', 'guest calls at the depth limit (tail calls)',
     'jump-cache probe of a static successor failed', 'jump-cache probe of a register branch failed (MMU off)']
T = {0: 'misses: EL0 read', 1: 'misses: EL0 write', 2: 'misses: EL0 exec', 3: 'misses: EL1 read',
     4: 'misses: EL1 write', 5: 'misses: EL1 exec', 6: 'miss with the page in another array',
     7: 'read miss, same EL\'s write array has the page', 8: 'write miss, same EL\'s read array has the page',
     9: 'exec miss, same EL\'s data arrays have the page', 10: 'data miss, same EL\'s exec array has the page',
     11: 'miss, the other EL\'s array of this use has the page', 12: 'miss on an empty slot',
     13: 'miss on a slot holding another page', 14: 'miss next to the last miss\'s page (+-1)',
     15: 'miss in the last miss\'s 2 MiB (same last-level table)',
     16: 'miss whose last-level table is in a 64-entry cache', 20: 'walks to level 0', 21: 'walks to level 1',
     22: 'walks to level 2', 23: 'walks to level 3', 24: 'walks that faulted', 25: 'walks without the permission',
     26: 'RAM fills with the page in another array', 27: 'RAM fills',
     28: 'read fills, the write array had the page', 29: 'write fills, the read array had the page',
     30: 'fills, the other EL\'s array had the page', 31: 'fills, only the other EL\'s array had it',
     32: 'fills (all)', 33: 'fills over another page\'s entry', 34: 'of those, apart among 32,768',
     35: 'of those, apart among 65,536', 36: 'flush_all', 39: 'flush_ng', 40: 'flush_ng, the nG list overflowed',
     41: 'flush_ng: listed slots dropped', 42: 'flush_va', 43: 'flush_va that scans the transfer cache',
     44: 'flush_va: generation bumps for blocks', 45: 'transfer cache generation bumps', 46: 'generation wraps',
     47: 'write fills of a watched page'}
Q = {0: 'TLBI IS: everything', 1: 'TLBI IS: by ASID', 2: 'TLBI IS: by VA, user half', 3: 'TLBI IS: by VA, kernel half',
     4: 'queued (per target)', 5: 'a full queue collapsed', 6: 'arrived at a collapsed queue',
     7: 'drains with something queued', 8: 'drains of a collapsed queue (flush_all)',
     9: 'of those, only user-half VAs and ASIDs since the last drain', 10: 'operations drained from lists',
     11: 'longest list drained (max over vCPUs summed)', 12: 'lists of 1', 13: 'lists of 2-7', 14: 'lists of 8-63',
     15: 'lists of 64', 16: 'lists with a flush of everything', 17: 'sampled: valid entries at a collapsed drain',
     18: 'sampled: global entries among them', 19: 'samples (one in 16)', 20: 'targets waited for',
     21: 'targets not waited for (another ASID)', 22: 'ASID operations in lists'}
M = ['jump cache fills', 'fills over another key', 'Jit::miss: compiled and installed, not in the jump cache',
     'interpreted steps reported at a key with no function', 'of those, at a region\'s member',
     'reports at a member', 'regions installed', 'heads that were members', 'members installed',
     'members that had a function']
G = ['regions of several blocks emitted', 'of those, never settled', 'bad fallbacks', 'single blocks emitted']


def show(name, steps, t, extra=''):
    print(f'== {name}: {steps / 1e6:.0f} M steps {extra}')

    def line(i, label):
        if t[i]:
            print(f'  [{i:4}] {label:<62} {t[i]:>14,}  {t[i] * 1e6 / steps:>12,.1f} /M')
    for i, l in enumerate(JIT):
        line(i, l)
    for i, l in enumerate(DISP[:15]):
        line(80 + i, l)
    for i, l in enumerate(X):
        line(96 + i, l)
    for i, l in sorted(T.items()):
        line(128 + i, l)
    for i, l in sorted(Q.items()):
        line(192 + i, l)
    for i, l in enumerate(M):
        line(224 + i, l)
    for i, l in enumerate(G):
        line(240 + i, l)
    ops = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ops.json')))
    h = sorted(((t[256 + i], op) for i, op in enumerate(ops) if t[256 + i]), reverse=True)
    total = sum(n for n, _ in h)
    print(f'  helper calls by Op: {total:,} ({total * 1e6 / steps:,.0f} /M)')
    acc = 0
    for n, op in h[:40]:
        acc += n
        print(f'    {op:<34} {n:>13,}  {100 * n / total:5.1f}%  cum {100 * acc / total:5.1f}%')


d = json.load(open(sys.argv[1]))
if 'runs' in d:
    for r in d['runs']:
        show(r['name'], r['steps'], r['t'], f"({r['ncpus']} vCPU)")
else:
    j = d['jit']
    show('pages session', d['steps'], j['diag'], f"(jit steps {j.get('steps', 0) / 1e6:.0f} M, helpers {j.get('helpers', 0):,})")
