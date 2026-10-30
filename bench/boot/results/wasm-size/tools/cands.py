# Ad hoc: per-instruction rewrites, sized from the words and the emitted segments.
import collections, pickle, sys
insts = pickle.load(open(sys.argv[1] + '/insts.pkl', 'rb'))
code = int(sys.argv[2])
def sleb_len(v):
    n = 1
    while not (-64 <= v < 64): v >>= 7; n += 1
    return n
def bits(i, h, l): return (i >> l) & ((1 << (h - l + 1)) - 1)
def const(v, sf):  # i64.const / i32.const of v
    w = 64 if sf else 32
    v &= (1 << w) - 1
    if v >> (w - 1): v -= 1 << w
    return 1 + sleb_len(v)
def ror(x, r, w): r %= w; return ((x >> r) | (x << (w - r))) & ((1 << w) - 1) if r else x
c = collections.Counter(); save = collections.Counter(); seen = collections.Counter()
for nm, w, seg in insts:
    ops = [o for o, _ in seg]
    sf = bits(w, 31, 31) == 1; W = 64 if sf else 32
    if nm == 'UBFM':
        immr, imms = bits(w, 21, 16), bits(w, 15, 10)
        # today: rotr immr (if any) + and (wmask & tmask)
        cur = sum(1 + (const(v, sf) if False else 0) for v in []) # placeholder
        rot = (const(immr, sf) + 1) if immr else 0
        if imms >= immr:
            width = imms - immr + 1
            mask = ((1 << width) - 1)
        else:
            width = imms + 1
            mask = ((1 << width) - 1) << (W - immr)
        cur = rot + const(mask, sf) + 1
        if imms == W - 1:
            new, kind = const(immr, sf) + 1, 'LSR'
        elif imms + 1 == immr:
            new, kind = const(W - immr, sf) + 1, 'LSL'
        elif imms >= immr:
            new, kind = ((const(immr, sf) + 1) if immr else 0) + const((1 << width) - 1, sf) + 1, 'UBFX'
        else:
            new, kind = const((1 << width) - 1, sf) + 1 + const(W - immr, sf) + 1, 'UBFIZ'
        if new > cur: new = cur
        seen['UBFM ' + kind] += 1; save['UBFM ' + kind] += cur - new
    if nm in ('SBFM', 'SXTW', 'SXTB_1', 'SXTB_2', 'SXTH_1', 'SXTH_2', 'ASR_1', 'ASR_2'):
        immr, imms = bits(w, 21, 16), bits(w, 15, 10)
        if immr == 0 and imms in (7, 15, 31) and (sf or imms < 31):
            # shl (W-1-imms) + shr_s (W-1-imms): two consts and ops -> one extend op
            k = W - 1 - imms
            seen['SXT* as extendN_s'] += 1; save['SXT* as extendN_s'] += 2 * (const(k, sf) + 1) - 1
    if nm in ('CSINC', 'CSINV') and bits(w, 9, 5) == 31 and bits(w, 20, 16) == 31:
        # today: const 0, const 0, const 1|-1, add|xor, cond, select ; new: cond (+extend | 0 - x)
        cur = 2 * const(0, sf) + const(1 if nm == 'CSINC' else -1, sf) + 1 + 1
        new = (0 if nm == 'CSINC' else const(0, sf) + 1) + (1 if sf else 0)
        if nm == 'CSINV' and sf: new += 0
        seen[nm + ' (CSET/CSETM)'] += 1; save[nm + ' (CSET/CSETM)'] += cur - new
    if nm == 'MOVK':
        seen['MOVK'] += 1
    if nm in ('ADD_imm', 'SUB_imm') and bits(w, 21, 10) == 0:
        seen['ADD/SUB #0 (MOV to/from SP)'] += 1; save['ADD/SUB #0 (MOV to/from SP)'] += 3
tot = 0
for k in sorted(seen): print(f'{k:34} n={seen[k]:7} saves {save[k]:8} B  {100*save[k]/code:.2f}%')
