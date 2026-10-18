// fptest: Berkeley TestFloat's cases through AArch64's FP instructions
// (docs/testing.md "The FP suite"). testfloat_gen supplies the operands (its
// edge cases by format and operand count); SoftFloat 3e, linked in, computes
// what each instruction must give, with ARM's rules on top: tininess before
// rounding, FZ (denormal inputs flushed with IDC, tiny results flushed with UFC
// and no IXC), DN, NaN propagation in operand order (the addend first for the
// FMAs), FPNeg on NaNs, saturating integer conversions. Every case runs every
// scalar, vector, by-element and general-register form of its operation under
// each FPCR rounding mode, FZ and DN, with FPSR clear and with IXC already set
// (an emulator's fast paths may only run then), and vector lanes take
// consecutive cases (plain lanes beside odd ones). The program must pass on
// real hardware first (the oracle VM), so an error in these rules shows there.
//
//   fptest [-gen <testfloat_gen>] [-level 1|2] [-every <k>] [-n <cases>] [-part <k>/<n>] [-v] [<form name prefix>...]
//
// -every k keeps every kth case of testfloat_gen's (a sample of a whole level),
// -n stops a type after that many cases (testfloat_gen's own -n can't go below
// a level's count); either applies to every operand type, 3-operand ones by
// default -every 64 (level 1's FMA cases are 6.1M a format). -part k/n runs
// the forms whose index is k modulo n (one part per CPU).
//
// Prints one line per operand type, the first failures of each form, and
// "fptest: <checks> checks, <failures> failures"; exits 1 on any failure.

#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "softfloat.h"

typedef uint64_t u64;
typedef uint32_t u32;

// FPSR's cumulative bits.
enum { IOC = 1, DZC = 2, OFC = 4, UFC = 8, IXC = 16, IDC = 128 };

// ---- Formats -------------------------------------------------------------

typedef struct {
    int bytes, e, f; // size, exponent and fraction bits
} Fmt;
static const Fmt H = {2, 5, 10}, S = {4, 8, 23}, D = {8, 11, 52};

static u64 mask(int bytes) { return bytes == 8 ? ~0ull : (1ull << (8 * bytes)) - 1; }
static u64 sign(Fmt t) { return 1ull << (t.e + t.f); }
static u64 expo(Fmt t, u64 x) { return (x >> t.f) & ((1ull << t.e) - 1); }
static u64 frac(Fmt t, u64 x) { return x & ((1ull << t.f) - 1); }
static bool is_nan(Fmt t, u64 x) { return expo(t, x) == (1ull << t.e) - 1 && frac(t, x); }
static bool is_snan(Fmt t, u64 x) { return is_nan(t, x) && !(x >> (t.f - 1) & 1); }
static bool is_inf(Fmt t, u64 x) { return expo(t, x) == (1ull << t.e) - 1 && !frac(t, x); }
static bool is_zero(Fmt t, u64 x) { return (x & (sign(t) - 1)) == 0; }
static bool is_denormal(Fmt t, u64 x) { return expo(t, x) == 0 && frac(t, x); }
static u64 quiet(Fmt t, u64 x) { return x | 1ull << (t.f - 1); }
static u64 default_nan(Fmt t) { return ((1ull << t.e) - 1) << t.f | 1ull << (t.f - 1); }

// ---- The ARM rules over SoftFloat ----------------------------------------

typedef struct {
    int rm; // FPCR.RMode: 0 nearest, 1 +inf, 2 -inf, 3 zero
    bool fz, dn, ixc;
} Cfg;

// SoftFloat's rounding mode for FPCR.RMode.
static uint_fast8_t sf_mode(int rm) {
    static const uint_fast8_t m[4] = {softfloat_round_near_even, softfloat_round_max,
                                      softfloat_round_min, softfloat_round_minMag};
    return m[rm];
}

static u32 sf_flags(void) {
    u32 f = softfloat_exceptionFlags, r = 0;
    if (f & softfloat_flag_invalid) r |= IOC;
    if (f & softfloat_flag_infinite) r |= DZC;
    if (f & softfloat_flag_overflow) r |= OFC;
    if (f & softfloat_flag_underflow) r |= UFC;
    if (f & softfloat_flag_inexact) r |= IXC;
    return r;
}

static void sf_start(uint_fast8_t mode) {
    softfloat_roundingMode = mode;
    softfloat_detectTininess = softfloat_tininess_beforeRounding;
    softfloat_exceptionFlags = 0;
}

// An input under FZ: a denormal single or double becomes a signed zero, with IDC.
static u64 flush_in(Fmt t, u64 x, const Cfg *c, u32 *fl) {
    if (c->fz && t.bytes != 2 && is_denormal(t, x)) {
        *fl |= IDC;
        return x & sign(t);
    }
    return x;
}

// A float result under FZ (tiny before rounding: UFC raised, or denormal) and DN.
static u64 finish(Fmt t, u64 r, const Cfg *c, u32 *fl) {
    if (c->fz && t.bytes != 2 && !is_nan(t, r) && ((*fl & UFC) || is_denormal(t, r))) {
        r &= sign(t);
        *fl = (*fl & ~(IXC | UFC)) | UFC;
    }
    if (c->dn && is_nan(t, r)) r = default_nan(t);
    return r;
}

// FPProcessNaNs over n operands in order: the first signaling NaN, else the
// first quiet one, quieted (IOC for a signaling one). False without a NaN.
static bool nans(Fmt t, const u64 *x, int n, const Cfg *c, u64 *r, u32 *fl) {
    for (int pass = 0; pass < 2; pass++)
        for (int i = 0; i < n; i++)
            if (pass ? is_nan(t, x[i]) : is_snan(t, x[i])) {
                if (pass == 0) *fl |= IOC;
                *r = c->dn ? default_nan(t) : quiet(t, x[i]);
                return true;
            }
    return false;
}

static float16_t h16(u64 x) { return (float16_t){(uint16_t)x}; }
static float32_t f32(u64 x) { return (float32_t){(uint32_t)x}; }
static float64_t f64(u64 x) { return (float64_t){x}; }

// The operations a form computes per lane.
enum Kind {
    K_ADD, K_SUB, K_MUL, K_DIV, K_NMUL, K_FMA, K_SQRT, K_MAX, K_MIN, K_MAXNM, K_MINNM,
    K_CMP,  // NZCV (FCMP/FCMPE, FCCMP/FCCMPE with cond EQ and nzcv #5)
    K_CSEL, // FCSEL with cond EQ
    K_VCMP, // a vector compare's all-ones lane
    K_RINT, K_CVT, K_TOINT, K_FROMINT,
    K_ABD,    // FABD: |n - m|, NaNs too
    K_MULX,   // FMULX: ∞ × 0 is ±2
    K_RECPS,  // FRECPS: 2 - n·m fused (∞ × 0: 2)
    K_RSQRTS, // FRSQRTS: (3 - n·m) / 2 fused (∞ × 0: 1.5)
    K_RECPX,  // FRECPX: the exponent inverted
    K_RECPE,  // FRECPE: the 8-bit reciprocal estimate
    K_RSQRTE, // FRSQRTE: the 8-bit reciprocal square root estimate
};

// What one lane of a form gives: its parameters.
typedef struct {
    enum Kind k;
    int neg;          // K_FMA: bit 0 negates n, bit 1 the addend; K_VCMP: 1 compares |n|, |m|
    int cmp;          // K_VCMP: 0 eq, 1 ge, 2 gt, 3 le, 4 lt; K_CMP: 1 signaling (E), 2 conditional
    int rmode;        // K_RINT/K_TOINT: -1 FPCR's, else a SoftFloat mode; K_CVT: 1 round to odd
    bool exact;       // K_RINT: FRINTX
    bool sgn;         // K_TOINT/K_FROMINT: signed
    int width;        // K_TOINT/K_FROMINT: the integer's bits
    int fbits;        // K_TOINT/K_FROMINT: fixed point, the fraction's bits
} Op;

static uint_fast8_t mode_of(const Op *o, const Cfg *c) {
    return o->rmode < 0 ? sf_mode(c->rm) : (uint_fast8_t)o->rmode;
}

// Binary arithmetic in format t (no NaN operand).
static u64 arith2(enum Kind k, Fmt t, u64 a, u64 b) {
    if (t.bytes == 4) {
        float32_t x = f32(a), y = f32(b);
        switch (k) {
        case K_ADD: return f32_add(x, y).v;
        case K_SUB: return f32_sub(x, y).v;
        case K_DIV: return f32_div(x, y).v;
        default: return f32_mul(x, y).v;
        }
    }
    float64_t x = f64(a), y = f64(b);
    switch (k) {
    case K_ADD: return f64_add(x, y).v;
    case K_SUB: return f64_sub(x, y).v;
    case K_DIV: return f64_div(x, y).v;
    default: return f64_mul(x, y).v;
    }
}

// a < b and a == b, quietly (no NaN operand).
static bool lt(Fmt t, u64 a, u64 b) {
    return t.bytes == 4 ? f32_lt_quiet(f32(a), f32(b)) : f64_lt_quiet(f64(a), f64(b));
}
static bool eq(Fmt t, u64 a, u64 b) {
    return t.bytes == 4 ? f32_eq(f32(a), f32(b)) : f64_eq(f64(a), f64(b));
}

static u64 two(Fmt t, bool neg) { return (neg ? sign(t) : 0) | ((1ull << (t.e - 1)) << t.f); }
static u64 inf(Fmt t, bool neg) { return (neg ? sign(t) : 0) | ((1ull << t.e) - 1) << t.f; }
static u64 fmul(Fmt t, u64 a, u64 b) { return t.bytes == 4 ? f32_mul(f32(a), f32(b)).v : f64_mul(f64(a), f64(b)).v; }
static u64 fused(Fmt t, u64 n, u64 m, u64 a) {
    return t.bytes == 4 ? f32_mulAdd(f32(n), f32(m), f32(a)).v : f64_mulAdd(f64(n), f64(m), f64(a)).v;
}
// A float constant of format t from a double's bits (exact ones only).
static u64 kf(Fmt t, double v) {
    u64 b;
    memcpy(&b, &v, 8);
    if (t.bytes == 8) return b;
    float f = (float)v;
    u32 w;
    memcpy(&w, &f, 4);
    return w;
}

// RecipEstimate and RecipSqrtEstimate (the ARM ARM's, without FEAT_RPRES).
static u32 recip_estimate(u32 a) {
    a = a * 2 + 1;
    u32 b = (1u << 19) / a;
    return (b + 1) / 2;
}
static u32 rsqrt_estimate(u32 a) {
    if (a < 256) a = a * 2 + 1;
    else a = ((a >> 1) << 1), a = (a + 1) * 2;
    u64 b = 512;
    while ((u64)a * (b + 1) * (b + 1) < (1ull << 28)) b++;
    return (u32)((b + 1) / 2);
}
static long floordiv2(long x) { return x >= 0 ? x / 2 : -((-x + 1) / 2); }

// The lane's result (of the output format `to`) and flags: n, m, a are the
// operands (a: the addend), in format `t` (an integer for K_FROMINT).
static u64 model(const Op *o, Fmt t, Fmt to, u64 n, u64 m, u64 a, const Cfg *c, u32 *fl) {
    *fl = 0;
    u64 r = 0;
    sf_start(sf_mode(c->rm));
    switch (o->k) {
    case K_ADD: case K_SUB: case K_MUL: case K_DIV: case K_NMUL: {
        u64 x[2] = {flush_in(t, n, c, fl), flush_in(t, m, c, fl)};
        if (!nans(t, x, 2, c, &r, fl)) {
            r = arith2(o->k, t, x[0], x[1]);
            *fl |= sf_flags();
            r = finish(t, r, c, fl);
        }
        if (o->k == K_NMUL) r ^= sign(t); // FPNeg, NaNs too
        return r;
    }
    case K_FMA: {
        if (o->neg & 1) n ^= sign(t);
        if (o->neg & 2) a ^= sign(t);
        // FPMulAdd(addend, op1, op2): NaNs in that order, then a quiet-NaN
        // addend with infinity × zero is Invalid (the default NaN).
        u64 x[3] = {flush_in(t, a, c, fl), flush_in(t, n, c, fl), flush_in(t, m, c, fl)};
        if (nans(t, x, 3, c, &r, fl)) {
            bool iz = (is_inf(t, x[1]) && is_zero(t, x[2])) || (is_zero(t, x[1]) && is_inf(t, x[2]));
            if (is_nan(t, x[0]) && !is_snan(t, x[0]) && iz) {
                r = default_nan(t);
                *fl |= IOC;
            }
            return r;
        }
        r = t.bytes == 4 ? f32_mulAdd(f32(x[1]), f32(x[2]), f32(x[0])).v
                         : f64_mulAdd(f64(x[1]), f64(x[2]), f64(x[0])).v;
        *fl |= sf_flags();
        return finish(t, r, c, fl);
    }
    case K_SQRT: {
        u64 x = flush_in(t, n, c, fl);
        if (nans(t, &x, 1, c, &r, fl)) return r;
        r = t.bytes == 4 ? f32_sqrt(f32(x)).v : f64_sqrt(f64(x)).v;
        *fl |= sf_flags();
        return finish(t, r, c, fl);
    }
    case K_MAX: case K_MIN: case K_MAXNM: case K_MINNM: {
        u64 x[2] = {flush_in(t, n, c, fl), flush_in(t, m, c, fl)};
        bool nm = o->k == K_MAXNM || o->k == K_MINNM, max = o->k == K_MAX || o->k == K_MAXNM;
        // FMAXNM/FMINNM: one quiet NaN against a number gives the number.
        if (nm && !is_snan(t, x[0]) && !is_snan(t, x[1]) && is_nan(t, x[0]) != is_nan(t, x[1]))
            return is_nan(t, x[0]) ? x[1] : x[0];
        if (nans(t, x, 2, c, &r, fl)) return r;
        if (is_zero(t, x[0]) && is_zero(t, x[1])) // +0 above -0
            return max ? (x[0] & x[1]) : (x[0] | x[1]);
        return lt(t, x[0], x[1]) == max ? x[1] : x[0];
    }
    case K_CMP: case K_VCMP: {
        u64 x = flush_in(t, n, c, fl), y = flush_in(t, m, c, fl);
        bool un = is_nan(t, x) || is_nan(t, y);
        if (o->k == K_CMP) {
            // FCMP: Invalid on a signaling NaN; FCMPE on any NaN.
            if ((o->cmp & 1) ? un : (is_snan(t, x) || is_snan(t, y))) *fl |= IOC;
            if (un) return 0x30000000;
            return eq(t, x, y) ? 0x60000000 : lt(t, x, y) ? 0x80000000 : 0x20000000;
        }
        if (o->neg) x &= ~sign(t), y &= ~sign(t); // FACGE/FACGT
        // FCMEQ is quiet; the ordered compares signal on any NaN.
        if (o->cmp == 0 ? (is_snan(t, x) || is_snan(t, y)) : un) *fl |= IOC;
        bool v = false;
        if (!un) switch (o->cmp) {
            case 0: v = eq(t, x, y); break;
            case 1: v = !lt(t, x, y); break;
            case 2: v = !lt(t, x, y) && !eq(t, x, y); break;
            case 3: v = lt(t, x, y) || eq(t, x, y); break;
            default: v = lt(t, x, y);
            }
        return v ? mask(t.bytes) : 0;
    }
    case K_ABD: {
        u64 x[2] = {flush_in(t, n, c, fl), flush_in(t, m, c, fl)};
        if (!nans(t, x, 2, c, &r, fl)) {
            r = arith2(K_SUB, t, x[0], x[1]);
            *fl |= sf_flags();
            r = finish(t, r, c, fl);
        }
        return r & ~sign(t); // FPAbs, NaNs too
    }
    case K_MULX: case K_RECPS: case K_RSQRTS: {
        if (o->k != K_MULX) n ^= sign(t); // FPNeg(op1) first
        u64 x[2] = {flush_in(t, n, c, fl), flush_in(t, m, c, fl)};
        if (nans(t, x, 2, c, &r, fl)) return r;
        bool sg = ((x[0] ^ x[1]) & sign(t)) != 0;
        bool iz = (is_inf(t, x[0]) && is_zero(t, x[1])) || (is_zero(t, x[0]) && is_inf(t, x[1]));
        if (iz) return o->k == K_MULX ? two(t, sg) : o->k == K_RECPS ? two(t, false) : kf(t, 1.5);
        if (o->k == K_MULX) {
            r = fmul(t, x[0], x[1]);
        } else if (is_inf(t, x[0]) || is_inf(t, x[1])) {
            return inf(t, sg);
        } else if (o->k == K_RECPS) {
            r = fused(t, x[0], x[1], kf(t, 2.0));
        } else {
            // (3 + n·m) / 2 rounded once: 1.5 + (n/2)·m, halving whichever
            // factor stays normal (exact); with both tiny, the product
            // doesn't matter to the halving.
            if (expo(t, x[0]) > 1) r = fused(t, x[0] - (1ull << t.f), x[1], kf(t, 1.5));
            else if (expo(t, x[1]) > 1) r = fused(t, x[0], x[1] - (1ull << t.f), kf(t, 1.5));
            else {
                r = fused(t, x[0], x[1], kf(t, 3.0));
                r -= 1ull << t.f;
            }
        }
        *fl |= sf_flags();
        return finish(t, r, c, fl);
    }
    case K_RECPX: {
        u64 x = flush_in(t, n, c, fl);
        if (nans(t, &x, 1, c, &r, fl)) return r;
        u64 e = expo(t, x), ones = (1ull << t.e) - 1;
        return (x & sign(t)) | (e == 0 ? ones - 1 : (~e & ones)) << t.f;
    }
    case K_RECPE: case K_RSQRTE: {
        u64 x = flush_in(t, n, c, fl);
        if (nans(t, &x, 1, c, &r, fl)) return r;
        bool neg = (x & sign(t)) != 0;
        int F = t.f;
        if (o->k == K_RECPE) {
            if (is_inf(t, x)) return x & sign(t);
            if (is_zero(t, x)) {
                *fl |= DZC;
                return inf(t, neg);
            }
            // |x| < 2^-128 (single), 2^-1024 (double): the estimate overflows.
            u64 tiny = t.bytes == 4 ? 0x00200000ull : 0x0004000000000000ull;
            if ((x & ~sign(t)) < tiny) {
                bool to_inf = c->rm == 0 ? true : c->rm == 1 ? !neg : c->rm == 2 ? neg : false;
                *fl |= OFC | IXC;
                return to_inf ? inf(t, neg) : (inf(t, neg) - 1);
            }
            // FZ: a result in the denormal range flushes (|x| ≥ 2^126, 2^1022).
            if (c->fz && expo(t, x) >= (u64)(t.bytes == 4 ? 253 : 2045)) {
                *fl |= UFC;
                return x & sign(t);
            }
            u64 fr = frac(t, x);
            long e = (long)expo(t, x);
            if (e == 0) {
                if (!(fr >> (F - 1) & 1)) e = -1, fr = (fr << 2) & ((1ull << F) - 1);
                else fr = (fr << 1) & ((1ull << F) - 1);
            }
            u32 scaled = (u32)(0x100 | (fr >> (F - 8)));
            long re = (t.bytes == 4 ? 253 : 2045) - e;
            u64 est = recip_estimate(scaled) & 0xff;
            fr = est << (F - 8);
            if (re == 0) fr = (1ull << (F - 1)) | (fr >> 1);
            else if (re == -1) fr = (1ull << (F - 2)) | (fr >> 2), re = 0;
            return (x & sign(t)) | ((u64)re & ((1ull << t.e) - 1)) << F | fr;
        }
        if (is_zero(t, x)) {
            *fl |= DZC;
            return inf(t, neg);
        }
        if (neg) {
            *fl |= IOC;
            return default_nan(t);
        }
        if (is_inf(t, x)) return 0;
        u64 fr = frac(t, x);
        long e = (long)expo(t, x);
        if (e == 0) {
            while (!(fr >> (F - 1) & 1)) fr = (fr << 1) & ((1ull << F) - 1), e--;
            fr = (fr << 1) & ((1ull << F) - 1);
        }
        u32 scaled = (e & 1) == 0 ? (u32)(0x100 | (fr >> (F - 8))) : (u32)(0x80 | (fr >> (F - 7)));
        long re = floordiv2((t.bytes == 4 ? 380 : 3068) - e);
        u64 est = rsqrt_estimate(scaled) & 0xff;
        return ((u64)re & ((1ull << t.e) - 1)) << F | est << (F - 8);
    }
    case K_CSEL: return 0; // the caller picks
    case K_RINT: {
        u64 x = flush_in(t, n, c, fl);
        if (nans(t, &x, 1, c, &r, fl)) return r;
        uint_fast8_t md = mode_of(o, c);
        r = t.bytes == 4 ? f32_roundToInt(f32(x), md, o->exact).v : f64_roundToInt(f64(x), md, o->exact).v;
        *fl |= sf_flags();
        return r;
    }
    case K_CVT: {
        u64 x = flush_in(t, n, c, fl);
        if (is_nan(t, x)) {
            if (is_snan(t, x)) *fl |= IOC;
            if (c->dn) return default_nan(to);
            // FPConvertNaN: the sign, the fraction's top bits, quiet.
            u64 f = frac(t, x);
            f = to.f > t.f ? f << (to.f - t.f) : f >> (t.f - to.f);
            return (x & sign(t) ? sign(to) : 0) | ((1ull << to.e) - 1) << to.f | f | 1ull << (to.f - 1);
        }
        if (o->rmode == 1) softfloat_roundingMode = softfloat_round_odd; // FCVTXN
        if (t.bytes == 2) r = to.bytes == 4 ? f16_to_f32(h16(x)).v : f16_to_f64(h16(x)).v;
        else if (t.bytes == 4) r = to.bytes == 2 ? f32_to_f16(f32(x)).v : f32_to_f64(f32(x)).v;
        else r = to.bytes == 2 ? f64_to_f16(f64(x)).v : f64_to_f32(f64(x)).v;
        *fl |= sf_flags();
        if (to.bytes == 2) return c->dn && is_nan(to, r) ? default_nan(to) : r;
        return finish(to, r, c, fl);
    }
    case K_TOINT: {
        u64 x = flush_in(t, n, c, fl);
        uint_fast8_t md = mode_of(o, c);
        // Fixed point: x · 2^fbits, exact (or an overflow, which saturates as out of range).
        if (o->fbits && !is_nan(t, x)) x = fmul(t, x, ((u64)(((1ull << (t.e - 1)) - 1) + o->fbits)) << t.f);
        softfloat_exceptionFlags = 0;
        int w = o->width;
        if (t.bytes == 4) {
            float32_t v = f32(x);
            r = o->sgn ? (w == 32 ? (u64)(u32)f32_to_i32(v, md, true) : (u64)f32_to_i64(v, md, true))
                       : (w == 32 ? (u64)f32_to_ui32(v, md, true) : (u64)f32_to_ui64(v, md, true));
        } else {
            float64_t v = f64(x);
            r = o->sgn ? (w == 32 ? (u64)(u32)f64_to_i32(v, md, true) : (u64)f64_to_i64(v, md, true))
                       : (w == 32 ? (u64)f64_to_ui32(v, md, true) : (u64)f64_to_ui64(v, md, true));
        }
        *fl |= sf_flags();
        if (*fl & IOC) { // ARM saturates; a NaN gives 0
            u64 max = (o->sgn ? ~0ull >> 1 : ~0ull) >> (64 - w);
            u64 min = o->sgn ? (1ull << (w - 1)) : 0;
            r = is_nan(t, x) ? 0 : (x & sign(t)) ? min : max;
            *fl &= ~IXC;
        }
        return r & mask(w / 8);
    }
    case K_FROMINT: {
        int w = o->width;
        if (to.bytes == 4)
            r = o->sgn ? (w == 32 ? i32_to_f32((int32_t)n).v : i64_to_f32((int64_t)n).v)
                       : (w == 32 ? ui32_to_f32((u32)n).v : ui64_to_f32(n).v);
        else
            r = o->sgn ? (w == 32 ? i32_to_f64((int32_t)n).v : i64_to_f64((int64_t)n).v)
                       : (w == 32 ? ui32_to_f64((u32)n).v : ui64_to_f64(n).v);
        *fl |= sf_flags();
        // Fixed point: / 2^fbits, exact.
        if (o->fbits && !is_zero(to, r)) r -= (u64)o->fbits << to.f;
        return r;
    }
    }
    return 0;
}

// ---- The instructions ----------------------------------------------------

// Machine state in and out: Q1, Q2, Q3 (operands: n, m, the scalar addend),
// Q0 (the destination before: vector FMA accumulators, FCVTN2's low half),
// X9 (a general-register operand), NZCV; out: Q0, X9, NZCV.
typedef struct {
    u64 q1[2], q2[2], q3[2], q0[2], x9, nzcv;
} In;
typedef struct {
    u64 q0[2], x9, nzcv;
} Out;
typedef void Run(const In *in, Out *out, u64 fpcr, u64 *fpsr);

#define RUN(fn, insn)                                                                   \
    static void fn(const In *in, Out *out, u64 fpcr, u64 *fpsr) {                       \
        u64 fs = *fpsr;                                                                 \
        __asm__ volatile("ldp q1, q2, [%[in]]\n\t"                                      \
                         "ldp q3, q0, [%[in], #32]\n\t"                                 \
                         "ldp x9, x10, [%[in], #64]\n\t"                                \
                         "msr nzcv, x10\n\t"                                            \
                         "msr fpcr, %[fpcr]\n\t"                                        \
                         "msr fpsr, %[fs]\n\t" insn "\n\t"                              \
                         "mrs %[fs], fpsr\n\t"                                          \
                         "mrs x10, nzcv\n\t"                                            \
                         "msr fpcr, xzr\n\t"                                            \
                         "str q0, [%[out]]\n\t"                                         \
                         "stp x9, x10, [%[out], #16]"                                   \
                         : [fs] "+r"(fs)                                                \
                         : [in] "r"(in), [out] "r"(out), [fpcr] "r"(fpcr)               \
                         : "v0", "v1", "v2", "v3", "x9", "x10", "cc", "memory");        \
        *fpsr = fs;                                                                     \
    }
#include "forms.h"
#undef RUN

// How a form lays out its lanes.
enum Shape {
    SC,   // scalar: Vn, Vm, Va's low element to Vd's (the rest zero)
    VEC,  // vector: `lanes` lanes of `to`, from the same lanes of Vn, Vm and Vd
    ELT,  // by element: Vm's lane `elt` for every lane
    GIN,  // the integer operand in X9 (W9), the float to Vd's low element
    GOUT, // the float in Vn, the integer to X9 (W9)
    NZ,   // the result in NZCV
    HI,   // FCVTL2: Vn's upper lanes in
    NHI,  // FCVTN2/FCVTXN2: Vd's upper lanes out, its lower half kept
    PAIR, // pairwise: Vm:Vn's adjacent lanes, Vn's pairs to the low lanes
    SPAIR, // scalar pairwise: Vn's two lanes to Vd's low element
    RED,  // across lanes: Vn's four lanes reduced pairwise, to Vd's low element
};

typedef struct {
    const char *name;
    Run *run;
    Op op;
    Fmt t, to; // operand and result formats
    enum Shape shape;
    int lanes, elt;
    bool zero; // compares with zero: Vm's operand is +0
} Form;

#define F(name, fn, ...) {name, fn, __VA_ARGS__}
#include "table.h"

// ---- Driving -------------------------------------------------------------

static void lane_set(u64 *q, int bytes, int i, u64 v) {
    int w = i * bytes / 8, s = 8 * (i * bytes % 8);
    q[w] = (q[w] & ~(mask(bytes) << s)) | (v & mask(bytes)) << s;
}

static const char *prefixes[64];
static int nprefixes, verbose, part, parts = 1;
static u64 checks, failures;

static bool wanted(int index, const char *name) {
    if (index % parts != part) return false;
    if (!nprefixes) return true;
    for (int i = 0; i < nprefixes; i++)
        if (!strncmp(name, prefixes[i], strlen(prefixes[i]))) return true;
    return false;
}

typedef struct {
    u64 v[3];
} Case;

// Runs form `f` on cases[i..] (one per lane) under `c`; compares; counts.
static void check(const Form *f, const Case *cs, int ncs, int i, const Cfg *c, u64 *fails) {
    In in;
    memset(&in, 0, sizeof in);
    int lanes = f->shape == SC || f->shape == GIN || f->shape == GOUT || f->shape == NZ ? 1 : f->lanes;
    bool fma_acc = f->op.k == K_FMA && f->shape != SC;
    bool cond = (i & 1) != 0; // FCSEL/FCCMP: EQ holds on odd cases
    in.x9 = 0x5555aaaa5555aaaaull;
    in.nzcv = cond ? 0x40000000 : 0;
    if (f->shape == NHI) in.q0[0] = 0x0123456789abcdefull; // FCVTN2 keeps it
    if (f->shape == NZ || f->shape == GOUT) in.q0[0] = 0x0123456789abcdefull, in.q0[1] = ~in.q0[0];
    Out want = {{0, 0}, in.x9, in.nzcv};
    if (f->shape == NHI) want.q0[0] = in.q0[0];
    if (f->shape == NZ || f->shape == GOUT) memcpy(want.q0, in.q0, 16);
    u64 mt = mask(f->t.bytes);
    u64 melt = cs[(i + f->elt) % ncs].v[1] & mt;
    u32 wfl = 0;
    if (f->shape == PAIR || f->shape == SPAIR || f->shape == RED) {
        // The operand lanes: cases i.. in Vn (and Vm for PAIR); concat = Vm:Vn's lanes.
        int in_lanes = f->shape == SPAIR ? 2 : f->shape == RED ? 4 : lanes;
        u64 cat[8];
        for (int j = 0; j < in_lanes; j++) {
            const Case *k = &cs[(i + j) % ncs];
            u64 n = (f->shape == SPAIR ? k->v[0] : k->v[0]) & mt, m = k->v[1] & mt;
            if (f->shape == SPAIR) n = (j == 0 ? cs[i % ncs].v[0] : cs[i % ncs].v[1]) & mt;
            lane_set(in.q1, f->t.bytes, j, n);
            cat[j] = n;
            if (f->shape == PAIR) lane_set(in.q2, f->t.bytes, j, m), cat[in_lanes + j] = m;
        }
        u32 fl;
        if (f->shape == PAIR) {
            for (int e = 0; e < lanes; e++) {
                lane_set(want.q0, f->to.bytes, e, model(&f->op, f->t, f->to, cat[2 * e], cat[2 * e + 1], 0, c, &fl));
                wfl |= fl;
            }
        } else if (f->shape == SPAIR) {
            lane_set(want.q0, f->to.bytes, 0, model(&f->op, f->t, f->to, cat[0], cat[1], 0, c, &fl));
            wfl |= fl;
        } else {
            u64 lo = model(&f->op, f->t, f->to, cat[0], cat[1], 0, c, &fl);
            wfl |= fl;
            u64 hi = model(&f->op, f->t, f->to, cat[2], cat[3], 0, c, &fl);
            wfl |= fl;
            lane_set(want.q0, f->to.bytes, 0, model(&f->op, f->t, f->to, lo, hi, 0, c, &fl));
            wfl |= fl;
        }
        lanes = in_lanes;
        goto run;
    }
    for (int j = 0; j < lanes; j++) {
        const Case *k = &cs[(i + j) % ncs];
        u64 n = k->v[0] & mt, m = f->zero ? 0 : k->v[1] & mt, a = k->v[2] & mt;
        switch (f->shape) {
        case GIN: n = k->v[0] & mask(f->op.width / 8), in.x9 = want.x9 = n; break;
        case SC: case NZ: case GOUT:
            lane_set(in.q1, f->t.bytes, 0, n);
            lane_set(in.q2, f->t.bytes, 0, m);
            lane_set(in.q3, f->t.bytes, 0, a);
            break;
        case ELT:
            lane_set(in.q1, f->t.bytes, j, n);
            lane_set(in.q2, f->t.bytes, j, m);
            m = melt;
            break;
        default: {
            int pin = f->shape == HI ? j + lanes : j;
            lane_set(in.q1, f->t.bytes, pin, n);
            lane_set(in.q2, f->t.bytes, pin, m);
        }
        }
        if (f->shape == ELT) lane_set(in.q2, f->t.bytes, f->elt, melt);
        if (fma_acc) lane_set(in.q0, f->t.bytes, j, a);
        u32 fl = 0;
        u64 r;
        if (f->op.k == K_CSEL) r = cond ? n : m;
        else if (f->op.k == K_CMP && (f->op.cmp & 2) && !cond) r = 0x50000000; // nzcv #5
        else r = model(&f->op, f->t, f->to, n, m, a, c, &fl);
        wfl |= fl;
        switch (f->shape) {
        case GOUT: want.x9 = r; break;
        case NZ: want.nzcv = r; break;
        case NHI: lane_set(want.q0, f->to.bytes, j + lanes, r); break;
        default: lane_set(want.q0, f->to.bytes, j, r);
        }
    }
run:;
    u64 fpcr = (u64)c->rm << 22 | (u64)c->fz << 24 | (u64)c->dn << 25;
    u64 fpsr = c->ixc ? IXC : 0, wfpsr = fpsr | wfl;
    Out got;
    f->run(&in, &got, fpcr, &fpsr);
    checks++;
    if (memcmp(&got, &want, sizeof got) || fpsr != wfpsr) {
        failures++;
        if ((*fails)++ < 5 || verbose) {
            printf("FAIL %s rm=%d fz=%d dn=%d ixc=%d:", f->name, c->rm, c->fz, c->dn, c->ixc);
            for (int j = 0; j < lanes; j++) {
                const Case *k = &cs[(i + j) % ncs];
                printf(" [%" PRIx64 " %" PRIx64 " %" PRIx64 "]", k->v[0], k->v[1], k->v[2]);
            }
            printf("\n  got  q0=%016" PRIx64 "%016" PRIx64 " x9=%" PRIx64 " nzcv=%" PRIx64 " fpsr=%" PRIx64
                   "\n  want q0=%016" PRIx64 "%016" PRIx64 " x9=%" PRIx64 " nzcv=%" PRIx64 " fpsr=%" PRIx64 "\n",
                   got.q0[1], got.q0[0], got.x9, got.nzcv, fpsr, want.q0[1], want.q0[0], want.x9, want.nzcv,
                   wfpsr);
        }
    }
}

// An operand type of testfloat_gen ("f32 2", "i64") and the forms that read it.
typedef struct {
    const char *gen; // testfloat_gen's arguments
    int ops;         // operands per case
    bool (*takes)(const Form *);
} Type;

static bool is_fp(const Form *f, int bytes, int ops) {
    enum Kind k = f->op.k;
    int n = k == K_FMA ? 3
            : (k == K_SQRT || k == K_RINT || k == K_CVT || k == K_TOINT || k == K_RECPX || k == K_RECPE || k == K_RSQRTE) ? 1
            : f->zero ? 1 : 2;
    return k != K_FROMINT && f->t.bytes == bytes && n == ops;
}
#define TAKES(name, b, o) static bool name(const Form *f) { return is_fp(f, b, o); }
TAKES(h1, 2, 1) TAKES(s1, 4, 1) TAKES(s2, 4, 2) TAKES(s3, 4, 3) TAKES(d1, 8, 1) TAKES(d2, 8, 2) TAKES(d3, 8, 3)
#define INT(name, w, s) static bool name(const Form *f) { return f->op.k == K_FROMINT && f->op.width == w && f->op.sgn == s; }
INT(ti32, 32, true) INT(tu32, 32, false) INT(ti64, 64, true) INT(tu64, 64, false)

static const Type types[] = {
    {"f16 1", 1, h1}, {"f32 1", 1, s1}, {"f32 2", 2, s2}, {"f32 3", 3, s3}, {"f64 1", 1, d1},
    {"f64 2", 2, d2}, {"f64 3", 3, d3}, {"i32", 1, ti32}, {"ui32", 1, tu32}, {"i64", 1, ti64},
    {"ui64", 1, tu64},
};

#define CHUNK 4096

int main(int argc, char **argv) {
    const char *gen = "testfloat_gen";
    int level = 1;
    long n = 0, every = 0;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "-gen") && i + 1 < argc) gen = argv[++i];
        else if (!strcmp(argv[i], "-level") && i + 1 < argc) level = atoi(argv[++i]);
        else if (!strcmp(argv[i], "-n") && i + 1 < argc) n = atol(argv[++i]);
        else if (!strcmp(argv[i], "-every") && i + 1 < argc) every = atol(argv[++i]);
        else if (!strcmp(argv[i], "-v")) verbose = 1;
        else if (!strcmp(argv[i], "-part") && i + 1 < argc && sscanf(argv[++i], "%d/%d", &part, &parts) == 2 && parts > 0) continue;
        else if (nprefixes < 64) prefixes[nprefixes++] = argv[i];
    }
    const int nforms = sizeof forms / sizeof forms[0];
    static u64 fails[sizeof forms / sizeof forms[0]];
    static Case cs[CHUNK];
    for (size_t t = 0; t < sizeof types / sizeof types[0]; t++) {
        const Type *ty = &types[t];
        bool any = false;
        for (int f = 0; f < nforms; f++) any |= ty->takes(&forms[f]) && wanted(f, forms[f].name);
        if (!any) continue;
        char cmd[256];
        snprintf(cmd, sizeof cmd, "%s -level %d %s", gen, level, ty->gen);
        long keep = every ? every : ty->ops == 3 ? 64 : 1, seen = 0;
        FILE *p = popen(cmd, "r");
        if (!p) {
            perror(cmd);
            return 2;
        }
        u64 before = checks, cases = 0;
        char line[256];
        int ncs = 0;
        bool eof = false;
        while (!eof) {
            ncs = 0;
            while (ncs < CHUNK) {
                if ((n && (long)(cases + ncs) >= n) || !fgets(line, sizeof line, p)) {
                    eof = true;
                    break;
                }
                if (seen++ % keep) continue;
                char *s = line;
                Case k = {{0, 0, 0}};
                for (int o = 0; o < ty->ops; o++) k.v[o] = strtoull(s, &s, 16);
                cs[ncs++] = k;
            }
            cases += ncs;
            for (int f = 0; f < nforms; f++) {
                const Form *fm = &forms[f];
                if (!ty->takes(fm) || !wanted(f, fm->name)) continue;
                for (int rm = 0; rm < 4; rm++)
                    for (int b = 0; b < 8; b++) {
                        Cfg c = {rm, b & 1, (b >> 1) & 1, (b >> 2) & 1};
                        for (int i = 0; i < ncs; i++) check(fm, cs, ncs, i, &c, &fails[f]);
                    }
            }
        }
        // Stopped early (-n), testfloat_gen dies of SIGPIPE: that's fine.
        int status = pclose(p);
        if (status != 0 && !(n && (long)cases >= n)) {
            fprintf(stderr, "%s failed\n", cmd);
            return 2;
        }
        printf("fptest: %s: %" PRIu64 " cases, %" PRIu64 " checks\n", ty->gen, cases, checks - before);
        fflush(stdout);
    }
    for (int f = 0; f < nforms; f++)
        if (fails[f]) printf("fptest: %s: %" PRIu64 " failures\n", forms[f].name, fails[f]);
    printf("fptest: %" PRIu64 " checks, %" PRIu64 " failures\n", checks, failures);
    return failures != 0;
}
