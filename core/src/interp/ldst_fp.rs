//! SIMD&FP loads and stores: single register (every addressing mode), pairs,
//! literal, and the structure loads/stores (LD1–LD4, ST1–ST4, LD1R–LD4R). As in
//! `ldst`, every memory read happens before any register write.

use super::{Exit, R, bit, bits, extend, sext};
use crate::cpu::{Cpu, sctlr};
use crate::decode::Op;
use crate::mem::{Access, Fault, FaultKind};
use crate::mmu::Bus;

/// `SCTLR_EL1.A` on a Q register: one 16-byte element, though it's accessed as
/// two 8-byte ones.
#[inline]
fn q_aligned(c: &Cpu, addr: u64, access: Access) -> R {
    if c.sctlr_el1 & sctlr::A != 0 && addr & 15 != 0 {
        return Err(Exit::Fault(Fault {
            addr,
            access,
            kind: FaultKind::Align,
        }));
    }
    Ok(())
}

/// Little-endian read of 1, 2, 4, 8 or 16 bytes.
pub(super) fn load(c: &Cpu, m: &mut impl Bus, addr: u64, bytes: u32) -> R<u128> {
    Ok(if bytes == 16 {
        q_aligned(c, addr, Access::Read)?;
        m.read(c, addr, 8)? as u128 | (m.read(c, addr.wrapping_add(8), 8)? as u128) << 64
    } else {
        m.read(c, addr, bytes)? as u128
    })
}

/// Little-endian write of the low 1, 2, 4, 8 or 16 bytes of `v`.
pub(super) fn store(c: &Cpu, m: &mut impl Bus, addr: u64, bytes: u32, v: u128) -> R {
    if bytes == 16 {
        q_aligned(c, addr, Access::Write)?;
        // High half first: when only it faults, memory is left untouched.
        m.write(c, addr.wrapping_add(8), 8, (v >> 64) as u64)?;
        m.write(c, addr, 8, v as u64)?;
    } else {
        m.write(c, addr, bytes, v as u64)?;
    }
    Ok(())
}

/// The low `bytes` bytes of `v` (the rest of a scalar register is zeroed on write).
fn low(v: u128, bytes: u32) -> u128 {
    if bytes == 16 {
        v
    } else {
        v & ((1u128 << (8 * bytes)) - 1)
    }
}

pub(super) fn exec(c: &mut Cpu, m: &mut impl Bus, i: u32, pc: u64, op: Op) -> R {
    use Op::*;
    let (rt, rn, rm) = (bits(i, 4, 0) as usize, bits(i, 9, 5), bits(i, 20, 16));
    match op {
        LDR_lit_fpsimd => {
            let bytes = match bits(i, 31, 30) {
                3 => return Err(Exit::Undefined),
                opc => 4 << opc,
            };
            super::fp_enabled(c)?;
            let addr = pc.wrapping_add(sext((bits(i, 23, 5) << 2) as u64, 21));
            c.v[rt] = load(c, m, addr, bytes)?;
        }
        STP_LDP_fpsimd | STNP_LDNP_fpsimd => {
            let bytes = match bits(i, 31, 30) {
                3 => return Err(Exit::Undefined),
                opc => 4 << opc,
            };
            let base = base(c, rn)?;
            let off = sext(bits(i, 21, 15) as u64, 7).wrapping_mul(bytes as u64);
            // 24:23 is 01 post-index, 11 pre-index, 10 (or 00 for STNP/LDNP) offset.
            let mode = bits(i, 24, 23);
            let addr = if mode == 1 {
                base
            } else {
                base.wrapping_add(off)
            };
            let (a2, rt2) = (addr.wrapping_add(bytes as u64), bits(i, 14, 10) as usize);
            if bit(i, 22) {
                let (v1, v2) = (load(c, m, addr, bytes)?, load(c, m, a2, bytes)?);
                c.v[rt] = v1;
                c.v[rt2] = v2;
            } else {
                store(c, m, addr, bytes, c.v[rt])?;
                store(c, m, a2, bytes, c.v[rt2])?;
            }
            if mode & 1 == 1 {
                c.set_reg_sp(rn, base.wrapping_add(off));
            }
        }
        STR_imm_fpsimd_2 | LDR_imm_fpsimd_2 => {
            let bytes = single_size(i)?;
            let addr = base(c, rn)?.wrapping_add(bits(i, 21, 10) as u64 * bytes as u64);
            single(c, m, i, addr, bytes)?;
        }
        STUR_fpsimd | LDUR_fpsimd => {
            let bytes = single_size(i)?;
            let addr = base(c, rn)?.wrapping_add(sext(bits(i, 20, 12) as u64, 9));
            single(c, m, i, addr, bytes)?;
        }
        STR_imm_fpsimd_1 | LDR_imm_fpsimd_1 => {
            let bytes = single_size(i)?;
            let base = base(c, rn)?;
            let wb = base.wrapping_add(sext(bits(i, 20, 12) as u64, 9));
            single(c, m, i, if bit(i, 11) { wb } else { base }, bytes)?;
            c.set_reg_sp(rn, wb);
        }
        STR_reg_fpsimd | LDR_reg_fpsimd => {
            let bytes = single_size(i)?;
            let option = bits(i, 15, 13);
            if option & 2 == 0 {
                return Err(Exit::Undefined);
            }
            let amt = if bit(i, 12) {
                bytes.trailing_zeros()
            } else {
                0
            };
            let off = extend(c.reg(rm), option, amt);
            single(c, m, i, base(c, rn)?.wrapping_add(off), bytes)?;
        }
        STx_mult_1 | STx_mult_2 | LDx_mult_1 | LDx_mult_2 => multiple(c, m, i)?,
        _ => single_structure(c, m, i)?,
    }
    Ok(())
}

/// The checks after decoding, in the architecture's order: the FPEN trap, then
/// (`super::base_reg`) the SP alignment fault. Every form calls it once its
/// UNDEFINED encodings are ruled out, which come first.
fn base(c: &Cpu, rn: u32) -> R<u64> {
    super::fp_enabled(c)?;
    super::base_reg(c, rn)
}

/// Access size of a single-register SIMD&FP load/store: size (31:30), with opc<1> (23) selecting Q.
fn single_size(i: u32) -> R<u32> {
    match (bits(i, 31, 30), bit(i, 23)) {
        (0, true) => Ok(16),
        (s, false) => Ok(1 << s),
        _ => Err(Exit::Undefined),
    }
}

/// STR/LDR of one B/H/S/D/Q register (L in bit 22). Loads zero the rest of the register.
fn single(c: &mut Cpu, m: &mut impl Bus, i: u32, addr: u64, bytes: u32) -> R {
    let rt = bits(i, 4, 0) as usize;
    if bit(i, 22) {
        c.v[rt] = load(c, m, addr, bytes)?;
    } else {
        store(c, m, addr, bytes, low(c.v[rt], bytes))?;
    }
    Ok(())
}

/// Post-index writeback for the structure forms: Rm 31 adds the bytes transferred, else Xm.
fn post_index(c: &mut Cpu, i: u32, base: u64, total: u64) {
    if bit(i, 23) {
        let rm = bits(i, 20, 16);
        let off = if rm == 31 { total } else { c.reg(rm) };
        c.set_reg_sp(bits(i, 9, 5), base.wrapping_add(off));
    }
}

/// LD1–LD4 / ST1–ST4 (multiple structures).
fn multiple(c: &mut Cpu, m: &mut impl Bus, i: u32) -> R {
    let (q, load_, size) = (bit(i, 30), bit(i, 22), bits(i, 11, 10));
    let (rpt, selem) = match bits(i, 15, 12) {
        0b0000 => (1, 4),
        0b0010 => (4, 1),
        0b0100 => (1, 3),
        0b0110 => (3, 1),
        0b0111 => (1, 1),
        0b1000 => (1, 2),
        0b1010 => (2, 1),
        _ => return Err(Exit::Undefined),
    };
    if size == 3 && !q && selem != 1 {
        return Err(Exit::Undefined);
    }
    let (ebytes, datasize) = (1u32 << size, if q { 16 } else { 8 });
    let elements = datasize / ebytes;
    let esize = 8 * ebytes;
    let emask = (1u128 << esize) - 1;
    let (t, base) = (bits(i, 4, 0) as usize, base(c, bits(i, 9, 5))?);
    // Loads build the new registers (at most four: register t + k is v[k])
    // and commit after the last read. Every element of each gets written, and
    // Q=0 clears the upper half, so they start at zero.
    let mut v = [0u128; 4];
    let mut addr = base;
    for r in 0..rpt {
        for e in 0..elements {
            for s in 0..selem {
                let (k, sh) = (r + s, e * esize);
                if load_ {
                    v[k] |= load(c, m, addr, ebytes)? << sh;
                } else {
                    store(c, m, addr, ebytes, (c.v[(t + k) % 32] >> sh) & emask)?;
                }
                addr = addr.wrapping_add(ebytes as u64);
            }
        }
    }
    if load_ {
        for (k, x) in v.iter().take(rpt * selem).enumerate() {
            c.v[(t + k) % 32] = *x;
        }
    }
    post_index(c, i, base, addr.wrapping_sub(base));
    Ok(())
}

/// LD1–LD4 / ST1–ST4 (single structure) and LD1R–LD4R.
fn single_structure(c: &mut Cpu, m: &mut impl Bus, i: u32) -> R {
    let (q, load_, s, size) = (bit(i, 30), bit(i, 22), bit(i, 12), bits(i, 11, 10));
    let opcode = bits(i, 15, 13);
    let selem = (((opcode & 1) << 1) | bit(i, 21) as u32) as usize + 1;
    let q_s = (q as u32) << 1 | s as u32;
    // (element size in bytes, lane index), or None to replicate.
    let (ebytes, index) = match opcode >> 1 {
        0 => (1, q_s << 2 | size),
        1 if size & 1 == 0 => (2, q_s << 1 | size >> 1),
        2 if size & 2 == 0 && size & 1 == 0 => (4, q_s),
        2 if size == 1 && !s => (8, q as u32),
        3 if load_ && !s => (1 << size, u32::MAX),
        _ => return Err(Exit::Undefined),
    };
    let (t, base) = (bits(i, 4, 0) as usize, base(c, bits(i, 9, 5))?);
    let esize = 8 * ebytes;
    let emask = (1u128 << esize) - 1;
    let mut addr = base;
    if index == u32::MAX {
        let mut vals = [0u128; 4];
        for x in vals.iter_mut().take(selem) {
            *x = load(c, m, addr, ebytes)?;
            addr = addr.wrapping_add(ebytes as u64);
        }
        let n = if q { 128 / esize } else { 64 / esize };
        for (k, x) in vals.iter().take(selem).enumerate() {
            c.v[(t + k) % 32] = (0..n).fold(0, |acc, e| acc | x << (e * esize));
        }
    } else {
        let sh = index * esize;
        let mut vals = [0u128; 4];
        for (k, x) in vals.iter_mut().take(selem).enumerate() {
            let tt = (t + k) % 32;
            if load_ {
                *x = load(c, m, addr, ebytes)?;
            } else {
                store(c, m, addr, ebytes, (c.v[tt] >> sh) & emask)?;
            }
            addr = addr.wrapping_add(ebytes as u64);
        }
        if load_ {
            for (k, x) in vals.iter().take(selem).enumerate() {
                let tt = (t + k) % 32;
                c.v[tt] = (c.v[tt] & !(emask << sh)) | x << sh;
            }
        }
    }
    post_index(c, i, base, addr.wrapping_sub(base));
    Ok(())
}
