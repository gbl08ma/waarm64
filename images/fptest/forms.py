# Writes forms.h (one asm function per form) and table.h (what each form computes) for fptest.c into the directory given.
import sys
out = sys.argv[1]
forms = []  # (name, asm, op, t, to, shape, lanes, elt, zero)
def add(name, asm, op, t, to, shape, lanes=0, elt=0, zero=False):
    forms.append((name, asm, op, t, to, shape, lanes, elt, zero))
R = {'s': 'S', 'd': 'D', 'h': 'H'}
VEC = [('4s', 'S', 4), ('2s', 'S', 2), ('2d', 'D', 2)]
def op(k, **kw):
    d = dict(neg=0, cmp=0, rmode=0, exact='false', sgn='false', width=0, fbits=0)
    d.update(kw)
    return '{K_%s, %d, %d, %s, %s, %s, %d, %d}' % (k, d['neg'], d['cmp'], d['rmode'], d['exact'], d['sgn'], d['width'], d['fbits'])
# Arithmetic.
for m, k in [('fadd', 'ADD'), ('fsub', 'SUB'), ('fmul', 'MUL'), ('fdiv', 'DIV'), ('fnmul', 'NMUL')]:
    for r in 'sd':
        add(f'{m} {r}', f'{m} {r}0, {r}1, {r}2', op(k), R[r], R[r], 'SC')
    if m == 'fnmul': continue
    for a, t, n in VEC:
        add(f'{m} {a}', f'{m} v0.{a}, v1.{a}, v2.{a}', op(k), t, t, 'VEC', n)
for a, t, n in VEC:
    e = 'd' if t == 'D' else 's'
    add(f'fmul {a} elt', f'fmul v0.{a}, v1.{a}, v2.{e}[1]', op('MUL'), t, t, 'ELT', n, 1)
for r in 'sd':
    add(f'fmul {r} elt', f'fmul {r}0, {r}1, v2.{r}[1]', op('MUL'), R[r], R[r], 'ELT', 1, 1)
# FMA.
for m, neg in [('fmadd', 0), ('fmsub', 1), ('fnmadd', 3), ('fnmsub', 2)]:
    for r in 'sd':
        add(f'{m} {r}', f'{m} {r}0, {r}1, {r}2, {r}3', op('FMA', neg=neg), R[r], R[r], 'SC')
for m, neg in [('fmla', 0), ('fmls', 1)]:
    for a, t, n in VEC:
        e = 'd' if t == 'D' else 's'
        add(f'{m} {a}', f'{m} v0.{a}, v1.{a}, v2.{a}', op('FMA', neg=neg), t, t, 'VEC', n)
        add(f'{m} {a} elt', f'{m} v0.{a}, v1.{a}, v2.{e}[1]', op('FMA', neg=neg), t, t, 'ELT', n, 1)
    for r in 'sd':
        add(f'{m} {r} elt', f'{m} {r}0, {r}1, v2.{r}[1]', op('FMA', neg=neg), R[r], R[r], 'ELT', 1, 1)
# Square root, min/max.
for r in 'sd':
    add(f'fsqrt {r}', f'fsqrt {r}0, {r}1', op('SQRT'), R[r], R[r], 'SC')
for a, t, n in VEC:
    add(f'fsqrt {a}', f'fsqrt v0.{a}, v1.{a}', op('SQRT'), t, t, 'VEC', n)
for m in ['fmax', 'fmin', 'fmaxnm', 'fminnm']:
    k = m[1:].upper()
    for r in 'sd':
        add(f'{m} {r}', f'{m} {r}0, {r}1, {r}2', op(k), R[r], R[r], 'SC')
    for a, t, n in VEC:
        add(f'{m} {a}', f'{m} v0.{a}, v1.{a}, v2.{a}', op(k), t, t, 'VEC', n)
# Compares, conditional compares and selects.
for r in 'sd':
    for m, c in [('fcmp', 0), ('fcmpe', 1)]:
        add(f'{m} {r}', f'{m} {r}1, {r}2', op('CMP', cmp=c), R[r], R[r], 'NZ')
        add(f'{m} {r} #0', f'{m} {r}1, #0.0', op('CMP', cmp=c), R[r], R[r], 'NZ', zero=True)
    for m, c in [('fccmp', 2), ('fccmpe', 3)]:
        add(f'{m} {r}', f'{m} {r}1, {r}2, #5, eq', op('CMP', cmp=c), R[r], R[r], 'NZ')
    add(f'fcsel {r}', f'fcsel {r}0, {r}1, {r}2, eq', op('CSEL'), R[r], R[r], 'SC')
VC = [('fcmeq', 0, 0), ('fcmge', 1, 0), ('fcmgt', 2, 0), ('facge', 1, 1), ('facgt', 2, 1)]
VZ = [('fcmeq', 0), ('fcmge', 1), ('fcmgt', 2), ('fcmle', 3), ('fcmlt', 4)]
for m, c, ab in VC:
    for a, t, n in VEC:
        add(f'{m} {a}', f'{m} v0.{a}, v1.{a}, v2.{a}', op('VCMP', cmp=c, neg=ab), t, t, 'VEC', n)
    for r in 'sd':
        add(f'{m} {r}', f'{m} {r}0, {r}1, {r}2', op('VCMP', cmp=c, neg=ab), R[r], R[r], 'SC')
for m, c in VZ:
    for a, t, n in VEC:
        add(f'{m} {a} #0', f'{m} v0.{a}, v1.{a}, #0.0', op('VCMP', cmp=c), t, t, 'VEC', n, zero=True)
    for r in 'sd':
        add(f'{m} {r} #0', f'{m} {r}0, {r}1, #0.0', op('VCMP', cmp=c), R[r], R[r], 'SC', zero=True)
# Rounding to integral.
RINT = [('frintn', 'softfloat_round_near_even', 'false'), ('frinta', 'softfloat_round_near_maxMag', 'false'),
        ('frintp', 'softfloat_round_max', 'false'), ('frintm', 'softfloat_round_min', 'false'),
        ('frintz', 'softfloat_round_minMag', 'false'), ('frintx', '-1', 'true'), ('frinti', '-1', 'false')]
for m, md, ex in RINT:
    for r in 'sd':
        add(f'{m} {r}', f'{m} {r}0, {r}1', op('RINT', rmode=md, exact=ex), R[r], R[r], 'SC')
    for a, t, n in VEC:
        add(f'{m} {a}', f'{m} v0.{a}, v1.{a}', op('RINT', rmode=md, exact=ex), t, t, 'VEC', n)
# Conversions between formats.
for d, s_ in [('d', 's'), ('s', 'd'), ('s', 'h'), ('d', 'h'), ('h', 's'), ('h', 'd')]:
    add(f'fcvt {d} {s_}', f'fcvt {d}0, {s_}1', op('CVT'), R[s_], R[d], 'SC')
add('fcvtxn s d', 'fcvtxn s0, d1', op('CVT', rmode=1), 'D', 'S', 'SC')
add('fcvtl 2d', 'fcvtl v0.2d, v1.2s', op('CVT'), 'S', 'D', 'VEC', 2)
add('fcvtl2 2d', 'fcvtl2 v0.2d, v1.4s', op('CVT'), 'S', 'D', 'HI', 2)
add('fcvtl 4s', 'fcvtl v0.4s, v1.4h', op('CVT'), 'H', 'S', 'VEC', 4)
add('fcvtl2 4s', 'fcvtl2 v0.4s, v1.8h', op('CVT'), 'H', 'S', 'HI', 4)
add('fcvtn 2s', 'fcvtn v0.2s, v1.2d', op('CVT'), 'D', 'S', 'VEC', 2)
add('fcvtn2 4s', 'fcvtn2 v0.4s, v1.2d', op('CVT'), 'D', 'S', 'NHI', 2)
add('fcvtn 4h', 'fcvtn v0.4h, v1.4s', op('CVT'), 'S', 'H', 'VEC', 4)
add('fcvtn2 8h', 'fcvtn2 v0.8h, v1.4s', op('CVT'), 'S', 'H', 'NHI', 4)
add('fcvtxn 2s', 'fcvtxn v0.2s, v1.2d', op('CVT', rmode=1), 'D', 'S', 'VEC', 2)
add('fcvtxn2 4s', 'fcvtxn2 v0.4s, v1.2d', op('CVT', rmode=1), 'D', 'S', 'NHI', 2)
# To and from integers.
CV = [('n', 'softfloat_round_near_even'), ('a', 'softfloat_round_near_maxMag'), ('p', 'softfloat_round_max'),
      ('m', 'softfloat_round_min'), ('z', 'softfloat_round_minMag')]
for c, md in CV:
    for u in 'su':
        m = f'fcvt{c}{u}'
        sg = 'true' if u == 's' else 'false'
        for g in 'wx':
            for r in 'sd':
                add(f'{m} {g} {r}', f'{m} {g}9, {r}1', op('TOINT', rmode=md, sgn=sg, width=32 if g == 'w' else 64), R[r], R[r], 'GOUT')
        for r in 'sd':
            add(f'{m} {r}', f'{m} {r}0, {r}1', op('TOINT', rmode=md, sgn=sg, width=32 if r == 's' else 64), R[r], R[r], 'SC')
        for a, t, n in VEC:
            add(f'{m} {a}', f'{m} v0.{a}, v1.{a}', op('TOINT', rmode=md, sgn=sg, width=32 if t == 'S' else 64), t, t, 'VEC', n)
for m in ['scvtf', 'ucvtf']:
    sg = 'true' if m == 'scvtf' else 'false'
    for r in 'sd':
        for g in 'wx':
            w = 32 if g == 'w' else 64
            add(f'{m} {r} {g}', f'{m} {r}0, {g}9', op('FROMINT', sgn=sg, width=w), 'S' if w == 32 else 'D', R[r], 'GIN')
        w = 32 if r == 's' else 64
        add(f'{m} {r}', f'{m} {r}0, {r}1', op('FROMINT', sgn=sg, width=w), R[r], R[r], 'SC')
    for a, t, n in VEC:
        add(f'{m} {a}', f'{m} v0.{a}, v1.{a}', op('FROMINT', sgn=sg, width=32 if t == 'S' else 64), t, t, 'VEC', n)
# FABD, FMULX, the reciprocal steps and estimates, FRECPX.
for m, k in [('fabd', 'ABD'), ('fmulx', 'MULX'), ('frecps', 'RECPS'), ('frsqrts', 'RSQRTS')]:
    for r in 'sd':
        add(f'{m} {r}', f'{m} {r}0, {r}1, {r}2', op(k), R[r], R[r], 'SC')
    for a, t, n in VEC:
        add(f'{m} {a}', f'{m} v0.{a}, v1.{a}, v2.{a}', op(k), t, t, 'VEC', n)
for a, t, n in VEC:
    e = 'd' if t == 'D' else 's'
    add(f'fmulx {a} elt', f'fmulx v0.{a}, v1.{a}, v2.{e}[1]', op('MULX'), t, t, 'ELT', n, 1)
for r in 'sd':
    add(f'fmulx {r} elt', f'fmulx {r}0, {r}1, v2.{r}[1]', op('MULX'), R[r], R[r], 'ELT', 1, 1)
    add(f'frecpx {r}', f'frecpx {r}0, {r}1', op('RECPX'), R[r], R[r], 'SC')
for m, k in [('frecpe', 'RECPE'), ('frsqrte', 'RSQRTE')]:
    for r in 'sd':
        add(f'{m} {r}', f'{m} {r}0, {r}1', op(k), R[r], R[r], 'SC')
    for a, t, n in VEC:
        add(f'{m} {a}', f'{m} v0.{a}, v1.{a}', op(k), t, t, 'VEC', n)
# Pairwise and across lanes.
for m, k in [('faddp', 'ADD'), ('fmaxp', 'MAX'), ('fminp', 'MIN'), ('fmaxnmp', 'MAXNM'), ('fminnmp', 'MINNM')]:
    for a, t, n in VEC:
        add(f'{m} {a}', f'{m} v0.{a}, v1.{a}, v2.{a}', op(k), t, t, 'PAIR', n)
    add(f'{m} s pair', f'{m} s0, v1.2s', op(k), 'S', 'S', 'SPAIR')
    add(f'{m} d pair', f'{m} d0, v1.2d', op(k), 'D', 'D', 'SPAIR')
for m, k in [('fmaxv', 'MAX'), ('fminv', 'MIN'), ('fmaxnmv', 'MAXNM'), ('fminnmv', 'MINNM')]:
    add(f'{m} 4s', f'{m} s0, v1.4s', op(k), 'S', 'S', 'RED')
# Fixed point.
for u in 'su':
    sg = 'true' if u == 's' else 'false'
    for fb in [1, 16, 32]:
        for g, w in [('w', 32), ('x', 64)]:
            for r in 'sd':
                add(f'fcvtz{u} {g} {r} #{fb}', f'fcvtz{u} {g}9, {r}1, #{fb}', op('TOINT', rmode='softfloat_round_minMag', sgn=sg, width=w, fbits=fb), R[r], R[r], 'GOUT')
                add(f'{u}cvtf {r} {g} #{fb}', f'{u}cvtf {r}0, {g}9, #{fb}', op('FROMINT', sgn=sg, width=w, fbits=fb), 'S' if w == 32 else 'D', R[r], 'GIN')
        for r in 'sd':
            w = 32 if r == 's' else 64
            add(f'fcvtz{u} {r} #{fb}', f'fcvtz{u} {r}0, {r}1, #{fb}', op('TOINT', rmode='softfloat_round_minMag', sgn=sg, width=w, fbits=fb), R[r], R[r], 'SC')
            add(f'{u}cvtf {r} #{fb}', f'{u}cvtf {r}0, {r}1, #{fb}', op('FROMINT', sgn=sg, width=w, fbits=fb), R[r], R[r], 'SC')
        for a, t, n in VEC:
            w = 32 if t == 'S' else 64
            add(f'fcvtz{u} {a} #{fb}', f'fcvtz{u} v0.{a}, v1.{a}, #{fb}', op('TOINT', rmode='softfloat_round_minMag', sgn=sg, width=w, fbits=fb), t, t, 'VEC', n)
            add(f'{u}cvtf {a} #{fb}', f'{u}cvtf v0.{a}, v1.{a}, #{fb}', op('FROMINT', sgn=sg, width=w, fbits=fb), t, t, 'VEC', n)
for u in 'su':
    sg = 'true' if u == 's' else 'false'
    for g, w in [('x', 64)]:
        for r in 'sd':
            add(f'fcvtz{u} {g} {r} #64', f'fcvtz{u} {g}9, {r}1, #64', op('TOINT', rmode='softfloat_round_minMag', sgn=sg, width=w, fbits=64), R[r], R[r], 'GOUT')
            add(f'{u}cvtf {r} {g} #64', f'{u}cvtf {r}0, {g}9, #64', op('FROMINT', sgn=sg, width=w, fbits=64), 'D', R[r], 'GIN')
hdr = "// Generated by images/fptest/forms.py: the forms fptest runs.\n"
with open(f'{out}/forms.h', 'w') as f:
    f.write(hdr)
    for i, x in enumerate(forms):
        f.write(f'RUN(run{i}, "{x[1]}")\n')
with open(f'{out}/table.h', 'w') as f:
    f.write(hdr + 'static const Form forms[] = {\n')
    for i, (name, asm, o, t, to, shape, lanes, elt, zero) in enumerate(forms):
        f.write(f'    F("{name}", run{i}, {o}, {t}, {to}, {shape}, {lanes}, {elt}, {"true" if zero else "false"}),\n')
    f.write('};\n')
print(len(forms), 'forms')
