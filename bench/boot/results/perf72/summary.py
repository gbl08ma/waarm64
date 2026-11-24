#!/usr/bin/env python3
"""PERF loop 72: the tables behind the REPORT entry. `python3 summary.py > summary.txt` (in this directory)."""
import json

a = json.load(open('gates-vm.json'))['runs']
b = json.load(open('gates-vm-follow-all.json'))['runs']
p = json.load(open('pages/jit-last.json'))
X, T, Q, M = 96, 128, 192, 224


def rows(r):
    out = [(r['name'], r['steps'], r['t'])]
    for ph in r['phases']:
        out.append((r['name'] + '/' + ph['name'], ph['steps'], ph['t']))
    return out


all_rows = [x for r in a for x in rows(r)] + [('pages (Mac)', p['steps'], p['jit']['diag'])]
print('Transfers per 1000 steps (edges: inside a function; the rest leave it or call)')
print(f"{'':20} {'edges':>7} {'chain':>6} {'viajc':>6} {'byVA':>6} {'XC ret':>7} {'XC blr':>7} {'XC br':>6} {'miss':>6} {'hcall':>6} {'hret':>6} {'stops':>6} {'interp%':>7} {'c->i':>6}")
for n, s, t in all_rows:
    k = s / 1000
    print(f"{n:20} {(t[0]+t[1])/k:7.1f} {(t[5]+t[6])/k:6.1f} {(t[7]+t[8])/k:6.1f} {(t[9]+t[10])/k:6.1f} {(t[X]+t[X+4])/k:7.2f} {(t[X+1]+t[X+5])/k:7.2f} {(t[X+2]+t[X+6])/k:6.2f} {t[3]/k:6.2f} {t[11]/k:6.1f} {t[12]/k:6.1f} {t[X+17]/k:6.2f} {100*t[92]/s:7.2f} {t[87]/k:6.2f}")
print()
for n, s, t in all_rows:
    mi = sum(t[T:T + 6])
    print(f"{n:20} RET probes hit/miss {t[X]/1e6:.2f}/{t[X+4]/1e6:.2f}M; miss function found/failed {t[X+16]/1e6:.2f}/{t[X+15]/1e6:.2f}M, entry zeroed/another tag/(same slot among 65,536)/older generation/right {t[X+10]/1e6:.2f}/{t[X+11]/1e6:.2f}/{t[X+12]/1e6:.2f}/{t[X+13]/1e6:.2f}/{t[X+14]/1e6:.2f}M")
    print(f"{'':20} host frames left {t[X+23]/1e6:.2f}M; depths summed at stops not by budget or stop word {t[X+22]/1e6:.2f}M; jump cache fills/over another key/known refills {t[M]/1e3:.0f}K/{t[M+1]/1e3:.0f}K/{t[M+2]/1e3:.0f}K; interpreted steps at members {100*t[M+4]/max(t[M+3],1):.1f}% of {t[M+3]/1e6:.0f}M reported")
    print(f"{'':20} TLB misses {mi/1e6:.2f}M ({mi*1e6/s:.0f}/M steps); read fills with the write entry/write fills with the read entry {t[T+28]/1e6:.2f}/{t[T+29]/1e6:.2f}M ({100*(t[T+28]+t[T+29])/max(t[T+27],1):.1f}% of {t[T+27]/1e6:.2f}M fills); misses on a slot holding another page {100*t[T+13]/max(mi,1):.1f}%; evictions {t[T+33]/1e6:.2f}M (apart among 32,768/65,536: {t[T+34]/1e6:.2f}/{t[T+35]/1e6:.2f}M); next to the last miss {100*t[T+14]/max(mi,1):.1f}%; last-level table in a 64-entry cache {100*t[T+16]/max(mi,1):.1f}%; flush_all/flush_ng/(list overflowed)/flush_va {t[T+36]}/{t[T+39]}/{t[T+40]}/{t[T+42]}; nG slots dropped {t[T+41]/1e6:.2f}M")
    if any(t[Q:Q + 23]):
        print(f"{'':20} TLBI IS all/ASID/VA user/VA kernel {t[Q]}/{t[Q+1]}/{t[Q+2]}/{t[Q+3]}; queued {t[Q+4]}, at a collapsed queue {t[Q+6]}; drains {t[Q+7]}, collapsed {t[Q+8]} (user-half and ASID only: {t[Q+9]}); lists of 1/2-7/8-63/64: {t[Q+12]}/{t[Q+13]}/{t[Q+14]}/{t[Q+15]}; sampled at a collapse: {t[Q+17]/max(t[Q+19],1):.0f} valid entries, {t[Q+18]/max(t[Q+19],1):.0f} global ({t[Q+19]} samples)")
    if t[240]:
        print(f"{'':20} regions of several blocks {t[240]}, never settled {t[241]}, `bad` fallbacks {t[242]}")
print()
print('Followed calls (PERF loop 50\'s count again, 64-block regions): today -> every callee followed')
for x, y in zip(a, b):
    for (n, s, t), (_, _, t2) in zip(rows(x), rows(y)):
        go = t2[15] - t[15]
        print(f"{n:22} host calls {t[11]/1e6:7.2f}M -> {t2[11]/1e6:7.2f}M; followed calls/completed inside {t[14]/1e6:.2f}/{t[15]/1e6:.2f}M -> {t2[14]/1e6:.2f}/{t2[15]/1e6:.2f}M; host calls that would go {go/1e6:.2f}M ({100*go/max(t[11],1):.1f}%)")
