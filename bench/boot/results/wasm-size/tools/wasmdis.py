# Ad hoc: a minimal wasm decoder for the JIT's modules and their `webpc.diag` section (the diagnostic patch).
import struct

def uleb(b, p):
    r = s = 0
    while True:
        x = b[p]; p += 1
        r |= (x & 0x7f) << s; s += 7
        if not x & 0x80:
            return r, p

def sleb(b, p):
    r = s = 0
    while True:
        x = b[p]; p += 1
        r |= (x & 0x7f) << s; s += 7
        if not x & 0x80:
            if x & 0x40:
                r -= 1 << s
            return r, p

NAMES = {
    0x00: 'unreachable', 0x01: 'nop', 0x02: 'block', 0x03: 'loop', 0x04: 'if', 0x05: 'else', 0x0b: 'end', 0x0c: 'br',
    0x0d: 'br_if', 0x0e: 'br_table', 0x0f: 'return', 0x10: 'call', 0x11: 'call_indirect', 0x12: 'return_call',
    0x13: 'return_call_indirect', 0x1a: 'drop', 0x1b: 'select', 0x20: 'local.get', 0x21: 'local.set', 0x22: 'local.tee',
    0x23: 'global.get', 0x24: 'global.set', 0x41: 'i32.const', 0x42: 'i64.const', 0x43: 'f32.const', 0x44: 'f64.const',
}
MEM = ['i32.load', 'i64.load', 'f32.load', 'f64.load', 'i32.load8_s', 'i32.load8_u', 'i32.load16_s', 'i32.load16_u',
       'i64.load8_s', 'i64.load8_u', 'i64.load16_s', 'i64.load16_u', 'i64.load32_s', 'i64.load32_u', 'i32.store',
       'i64.store', 'f32.store', 'f64.store', 'i32.store8', 'i32.store16', 'i64.store8', 'i64.store16', 'i64.store32']
for k, n in enumerate(MEM):
    NAMES[0x28 + k] = n
NUM = ('i32.eqz i32.eq i32.ne i32.lt_s i32.lt_u i32.gt_s i32.gt_u i32.le_s i32.le_u i32.ge_s i32.ge_u '
       'i64.eqz i64.eq i64.ne i64.lt_s i64.lt_u i64.gt_s i64.gt_u i64.le_s i64.le_u i64.ge_s i64.ge_u '
       'f32.eq f32.ne f32.lt f32.gt f32.le f32.ge f64.eq f64.ne f64.lt f64.gt f64.le f64.ge '
       'i32.clz i32.ctz i32.popcnt i32.add i32.sub i32.mul i32.div_s i32.div_u i32.rem_s i32.rem_u i32.and i32.or '
       'i32.xor i32.shl i32.shr_s i32.shr_u i32.rotl i32.rotr '
       'i64.clz i64.ctz i64.popcnt i64.add i64.sub i64.mul i64.div_s i64.div_u i64.rem_s i64.rem_u i64.and i64.or '
       'i64.xor i64.shl i64.shr_s i64.shr_u i64.rotl i64.rotr '
       'f32.abs f32.neg f32.ceil f32.floor f32.trunc f32.nearest f32.sqrt f32.add f32.sub f32.mul f32.div f32.min '
       'f32.max f32.copysign f64.abs f64.neg f64.ceil f64.floor f64.trunc f64.nearest f64.sqrt f64.add f64.sub '
       'f64.mul f64.div f64.min f64.max f64.copysign '
       'i32.wrap_i64 i32.trunc_f32_s i32.trunc_f32_u i32.trunc_f64_s i32.trunc_f64_u i64.extend_i32_s '
       'i64.extend_i32_u i64.trunc_f32_s i64.trunc_f32_u i64.trunc_f64_s i64.trunc_f64_u f32.convert_i32_s '
       'f32.convert_i32_u f32.convert_i64_s f32.convert_i64_u f32.demote_f64 f64.convert_i32_s f64.convert_i32_u '
       'f64.convert_i64_s f64.convert_i64_u f64.promote_f32 i32.reinterpret_f32 i64.reinterpret_f64 '
       'f32.reinterpret_i32 f64.reinterpret_i64 i32.extend8_s i32.extend16_s i64.extend8_s i64.extend16_s '
       'i64.extend32_s').split()
for k, n in enumerate(NUM):
    NAMES[0x45 + k] = n

def simd_imm(op):
    """What follows a 0xfd opcode: 'm' memarg, 'ml' memarg + lane, 'c16' 16 bytes, 'l' lane byte, '' nothing."""
    if op <= 11 or op in (92, 93):
        return 'm'
    if 84 <= op <= 91:
        return 'ml'
    if op in (12, 13):
        return 'c16'
    if 21 <= op <= 34:
        return 'l'
    return ''

def memarg(b, p):
    a, p = uleb(b, p)
    mem = 0
    if a & 0x40:
        mem, p = uleb(b, p)
    o, p = uleb(b, p)
    return (a & 0x3f, mem, o), p

def decode(b, p, end):
    """Yields (offset, name, imm, length) for each instruction in b[p:end]."""
    while p < end:
        s = p
        op = b[p]; p += 1
        imm = None
        if op in (0x02, 0x03, 0x04):
            imm = b[p]; p += 1
            if imm not in (0x40, 0x7f, 0x7e, 0x7d, 0x7c, 0x7b):
                imm, p = sleb(b, p - 1)
            name = NAMES[op]
        elif op in (0x0c, 0x0d, 0x10, 0x12, 0x20, 0x21, 0x22, 0x23, 0x24):
            imm, p = uleb(b, p); name = NAMES[op]
        elif op in (0x11, 0x13):
            t, p = uleb(b, p); tb, p = uleb(b, p); imm = (t, tb); name = NAMES[op]
        elif op == 0x0e:
            n, p = uleb(b, p)
            ls = []
            for _ in range(n + 1):
                x, p = uleb(b, p); ls.append(x)
            imm = ls; name = 'br_table'
        elif op in (0x41, 0x42):
            imm, p = sleb(b, p); name = NAMES[op]
        elif op == 0x43:
            imm = b[p:p + 4]; p += 4; name = 'f32.const'
        elif op == 0x44:
            imm = b[p:p + 8]; p += 8; name = 'f64.const'
        elif 0x28 <= op <= 0x3e:
            imm, p = memarg(b, p); name = NAMES[op]
        elif op in (0x3f, 0x40):
            p += 1; name = 'memory.size' if op == 0x3f else 'memory.grow'
        elif op == 0xfc:
            sub, p = uleb(b, p)
            name = f'fc.{sub}'
            if sub == 10:
                p += 2
            elif sub == 11:
                p += 1
            elif sub in (8,):
                _, p = uleb(b, p); p += 1
            elif sub in (9, 13, 15, 16, 17):
                _, p = uleb(b, p)
            elif sub in (12, 14):
                _, p = uleb(b, p); _, p = uleb(b, p)
        elif op == 0xfd:
            sub, p = uleb(b, p)
            k = simd_imm(sub)
            name = f'v.{sub}'
            if k == 'm':
                imm, p = memarg(b, p)
            elif k == 'ml':
                imm, p = memarg(b, p); p += 1
            elif k == 'c16':
                imm = b[p:p + 16]; p += 16
            elif k == 'l':
                imm = b[p]; p += 1
        elif op == 0xfe:
            sub, p = uleb(b, p)
            name = f'atomic.{sub}'
            if sub == 3:
                p += 1
            else:
                imm, p = memarg(b, p)
        elif op in NAMES:
            name = NAMES[op]
        else:
            raise ValueError(f'opcode {op:#x} at {s}')
        yield s, name, imm, p - s

def module(b):
    """(nfunc_imports, bodies {func idx: (bytes, code start, code end)}, diag {func idx: entries}, names)."""
    assert b[:4] == b'\0asm'
    p = 8
    nimp = 0
    bodies, diag, names = {}, {}, {}
    while p < len(b):
        sid = b[p]; p += 1
        ln, p = uleb(b, p)
        end = p + ln
        if sid == 2:
            n, q = uleb(b, p)
            for _ in range(n):
                l, q = uleb(b, q); q += l
                l, q = uleb(b, q); q += l
                k = b[q]; q += 1
                if k == 0:
                    nimp += 1; _, q = uleb(b, q)
                elif k == 1:
                    q += 1; f = b[q]; q += 1; _, q = uleb(b, q)
                    if f & 1: _, q = uleb(b, q)
                elif k == 2:
                    f = b[q]; q += 1; _, q = uleb(b, q)
                    if f & 1: _, q = uleb(b, q)
                else:
                    q += 2
        elif sid == 10:
            n, q = uleb(b, p)
            for i in range(n):
                l, q = uleb(b, q)
                fe = q + l
                nl, r = uleb(b, q)
                for _ in range(nl):
                    _, r = uleb(b, r); r += 1
                bodies[nimp + i] = (r, fe)
                q = fe
        elif sid == 0:
            nl, q = uleb(b, p)
            nm = bytes(b[q:q + nl]).decode(); q += nl
            if nm == 'webpc.diag':
                n, q = uleb(b, q)
                for _ in range(n):
                    f, q = uleb(b, q)
                    c, q = uleb(b, q)
                    es = []
                    for _ in range(c):
                        w = struct.unpack_from('<I', b, q)[0]; q += 4
                        s0, q = uleb(b, q); s1, q = uleb(b, q)
                        k = b[q]; q += 1
                        l, q = uleb(b, q)
                        es.append((w, s0, s1, k, bytes(b[q:q + l]).decode())); q += l
                    diag[f] = es
        p = end
    return nimp, bodies, diag
