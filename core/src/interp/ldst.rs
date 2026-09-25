//! Loads and stores: single register (every addressing mode), pairs, literal,
//! exclusives, acquire/release and LSE atomics. All memory reads happen before
//! any register write, so a fault leaves registers untouched.

use super::{Exit, R, bit, bits, extend, sext};
use crate::cpu::{Cpu, Monitor};
use crate::decode::Op;
use crate::mem::{Fault, Mem};

pub(super) fn exec(c: &mut Cpu, m: &Mem, i: u32, pc: u64, op: Op) -> R {
    use Op::*;
    let (rt, rn, rs) = (bits(i, 4, 0), bits(i, 9, 5), bits(i, 20, 16));
    let base = c.reg_sp(rn);
    match op {
        LDR_lit_gen | LDRSW_lit => {
            let addr = pc.wrapping_add(sext((bits(i, 23, 5) << 2) as u64, 21));
            let v = match (op, bit(i, 30)) {
                (LDRSW_lit, _) => m.read(addr, 4)? as i32 as u64,
                (_, false) => m.read(addr, 4)?,
                (_, true) => m.read(addr, 8)?,
            };
            c.set_reg(rt, v);
        }
        PRFM_lit | PRFM_imm | PRFM_unscaled_imm => {}

        // Single register. Size in 31:30, opc in 23:22.
        STRx_LDRx_imm_2 => {
            let off = (bits(i, 21, 10) as u64) << bits(i, 31, 30);
            single(c, m, i, base.wrapping_add(off), None, true)?;
        }
        STURx_LDURx | STTRB | LDTRB | LDTRSB | STTRH | LDTRH | LDTRSH | STTR | LDTR | LDTRSW => {
            // Unscaled, and unprivileged (the same as unscaled at EL0). PRFUM is PRFM_unscaled_imm.
            let off = sext(bits(i, 20, 12) as u64, 9);
            single(c, m, i, base.wrapping_add(off), None, op == STURx_LDURx)?;
        }
        STRx_LDRx_imm_1 => {
            let wb = base.wrapping_add(sext(bits(i, 20, 12) as u64, 9));
            let addr = if bit(i, 11) { wb } else { base };
            single(c, m, i, addr, Some(wb), false)?;
        }
        STRx_reg | LDRx_reg => {
            let option = bits(i, 15, 13);
            if option & 2 == 0 {
                return Err(Exit::Undefined);
            }
            let amt = if bit(i, 12) { bits(i, 31, 30) } else { 0 };
            let off = extend(c.reg(rs), option, amt);
            single(c, m, i, base.wrapping_add(off), None, true)?;
        }

        // Pairs.
        STP_LDP_gen | STNP_LDNP_gen => {
            let (opc, load) = (bits(i, 31, 30), bit(i, 22));
            let (size, signed) = match (opc, load) {
                (0, _) => (4, false),
                (2, _) => (8, false),
                (1, true) if op == STP_LDP_gen => (4, true), // LDPSW
                _ => return Err(Exit::Undefined),            // STGP, or reserved
            };
            let off = sext(bits(i, 21, 15) as u64, 7).wrapping_mul(size as u64);
            // 24:23 is 01 post-index, 11 pre-index, 10 (or 00 for the non-temporal forms) offset.
            let mode = bits(i, 24, 23);
            let addr = if mode == 1 {
                base
            } else {
                base.wrapping_add(off)
            };
            let (a2, rt2) = (addr.wrapping_add(size as u64), bits(i, 14, 10));
            if load {
                let (v1, v2) = (m.read(addr, size)?, m.read(a2, size)?);
                let ext = |v: u64| if signed { v as i32 as u64 } else { v };
                c.set_reg(rt, ext(v1));
                c.set_reg(rt2, ext(v2));
            } else {
                m.write(addr, size, c.reg(rt))?;
                m.write(a2, size, c.reg(bits(i, 14, 10)))?;
            }
            if mode & 1 == 1 {
                c.set_reg_sp(rn, base.wrapping_add(off));
            }
        }

        // Exclusives and acquire/release. Size in 31:30 (single) or 30 (pairs).
        LDXR | LDAXR => {
            let size = 1 << bits(i, 31, 30);
            let v = m.read_atomic(base, size)?;
            c.monitor = Monitor {
                addr: base,
                size: size as u64,
                val: [v, 0],
            };
            c.set_reg(rt, v);
        }
        LDXP | LDAXP => {
            let rt2 = bits(i, 14, 10);
            let (lo, hi, val) = if bit(i, 30) {
                let p = m.read_pair(base, 8)?;
                (p[0], p[1], p)
            } else {
                let v = m.read_atomic(base, 8)?;
                (v as u32 as u64, v >> 32, [v, 0])
            };
            let size = if bit(i, 30) { 16 } else { 8 };
            c.monitor = Monitor {
                addr: base,
                size,
                val,
            };
            c.set_reg(rt, lo);
            c.set_reg(rt2, hi);
        }
        STXR | STLXR => {
            let size = 1 << bits(i, 31, 30);
            aligned(base, size)?;
            let (mon, new) = (c.monitor, c.reg(rt));
            c.monitor.size = 0;
            let ok = mon.addr == base
                && mon.size == size as u64
                && m.cas(base, size, mon.val[0], new)? == mon.val[0];
            c.set_reg(rs, !ok as u64);
        }
        STXP | STLXP => {
            let rt2 = bits(i, 14, 10);
            let (mon, lo, hi) = (c.monitor, c.reg(rt), c.reg(rt2));
            c.monitor.size = 0;
            let ok = if bit(i, 30) {
                aligned(base, 16)?;
                mon.addr == base
                    && mon.size == 16
                    && m.cas_pair(base, 8, mon.val, [lo, hi])? == mon.val
            } else {
                aligned(base, 8)?;
                let new = lo as u32 as u64 | hi << 32;
                mon.addr == base && mon.size == 8 && m.cas(base, 8, mon.val[0], new)? == mon.val[0]
            };
            c.set_reg(rs, !ok as u64);
        }
        LDAR => {
            let v = m.read_atomic(base, 1 << bits(i, 31, 30))?;
            c.set_reg(rt, v);
        }
        STLR => m.write_atomic(base, 1 << bits(i, 31, 30), c.reg(rt))?,

        // LSE.
        CAS | CASB | CASH => {
            let size = 1 << bits(i, 31, 30);
            let mask = u64::MAX >> (64 - 8 * size);
            let old = m.cas(base, size, c.reg(rs) & mask, c.reg(rt) & mask)?;
            c.set_reg(rs, old);
        }
        CASP => {
            if rs & 1 == 1 || rt & 1 == 1 {
                return Err(Exit::Undefined);
            }
            let (e, n) = ([c.reg(rs), c.reg(rs + 1)], [c.reg(rt), c.reg(rt + 1)]);
            let old = if bit(i, 30) {
                m.cas_pair(base, 8, e, n)?
            } else {
                let join = |p: [u64; 2]| p[0] as u32 as u64 | p[1] << 32;
                let v = m.cas(base, 8, join(e), join(n))?;
                [v as u32 as u64, v >> 32]
            };
            c.set_reg(rs, old[0]);
            c.set_reg(rs + 1, old[1]);
        }
        _ => {
            // LD<op> and SWP: size in 31:30, o3:opc in 15:12.
            let size = 1 << bits(i, 31, 30);
            let bw = 8 * size;
            let mask = u64::MAX >> (64 - bw);
            let v = c.reg(rs) & mask;
            let s = |x: u64| sext(x, bw) as i64;
            let old = m.rmw(base, size, |old| {
                (match bits(i, 15, 12) {
                    0 => old.wrapping_add(v),
                    1 => old & !v,
                    2 => old ^ v,
                    3 => old | v,
                    4 => {
                        if s(old) > s(v) {
                            old
                        } else {
                            v
                        }
                    }
                    5 => {
                        if s(old) < s(v) {
                            old
                        } else {
                            v
                        }
                    }
                    6 => old.max(v),
                    7 => old.min(v),
                    _ => v, // SWP (8)
                }) & mask
            })?;
            c.set_reg(rt, old);
        }
    }
    Ok(())
}

fn aligned(addr: u64, size: u32) -> R {
    if addr.is_multiple_of(size as u64) {
        Ok(())
    } else {
        Err(Exit::Fault(Fault::Align { addr }))
    }
}

/// One register load/store: STR/LDR/LDRS* by size (31:30) and opc (23:22).
/// `prfm` says whether size 3, opc 2 is PRFM here (else it's unallocated).
fn single(c: &mut Cpu, m: &Mem, i: u32, addr: u64, wb: Option<u64>, prfm: bool) -> R {
    let (size, opc, rt, rn) = (
        bits(i, 31, 30),
        bits(i, 23, 22),
        bits(i, 4, 0),
        bits(i, 9, 5),
    );
    let bytes = 1 << size;
    match opc {
        0 => m.write(addr, bytes, c.reg(rt))?,
        1 => {
            let v = m.read(addr, bytes)?;
            c.set_reg(rt, v);
        }
        2 if size == 3 && prfm => return Ok(()),
        _ if size == 3 || (size == 2 && opc == 3) => return Err(Exit::Undefined),
        _ => {
            // Sign-extending: opc 2 to 64 bits, opc 3 to 32 bits.
            let v = sext(m.read(addr, bytes)?, 8 * bytes);
            c.set_reg(rt, if opc == 3 { v as u32 as u64 } else { v });
        }
    }
    if let Some(wb) = wb {
        c.set_reg_sp(rn, wb);
    }
    Ok(())
}
