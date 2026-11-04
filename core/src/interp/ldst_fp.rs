//! SIMD&FP loads and stores: single register (every addressing mode), pairs,
//! literal, and the structure loads/stores (LD1–LD4, ST1–ST4, LD1R–LD4R). As in
//! `ldst`, every memory read happens before any register write.

use super::{Exit, R, bit, bits, extend, sext};
use crate::cpu::{Cpu, sctlr};
use crate::decode::Op;
use crate::mem::{self, Access, Fault, FaultKind};
use crate::mmu::{Bus, Use};

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

/// LD1–LD4 / ST1–ST4 (multiple structures). Out of line, as
/// [`single_structure`]: rare, and kept out of `exec`'s copies (measured
/// neutral either way: docs/cpu.md "The block interpreter").
#[inline(never)]
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
    let total = rpt as u32 * selem as u32 * datasize;
    // Loads build the new registers (at most four: register t + k is v[k])
    // and commit after the last read. Every element of each gets written, and
    // Q=0 clears the upper half, so they start at zero.
    let mut v = [0u128; 4];
    let u = if load_ { Use::Read } else { Use::Write };
    if let Some(p) = m.fast(c, base, total, u) {
        // The whole transfer is RAM in one page, with no alignment check: 8
        // bytes an access (an element never straddles two; each stays single-
        // copy atomic, as `mem::load`'s pieces are naturally aligned), and the
        // elements (de-)interleaved in a buffer.
        fast_multiple(
            c,
            p,
            load_,
            t,
            rpt * selem,
            selem,
            ebytes as usize,
            datasize as usize,
            &mut v,
        );
    } else {
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
    }
    if load_ {
        for (k, x) in v.iter().take(rpt * selem).enumerate() {
            c.v[(t + k) % 32] = *x;
        }
    }
    post_index(c, i, base, total as u64);
    Ok(())
}

/// [`multiple`]'s transfer through the host pointer `p` to `regs` registers'
/// worth of bytes: loads into `v`, stores from `c.v[t..]`. With one element a
/// structure, memory holds the registers in order; else structure `e` holds
/// element `e` of each register in turn.
#[allow(clippy::too_many_arguments)]
#[inline(never)]
fn fast_multiple(
    c: &Cpu,
    p: *mut u8,
    load_: bool,
    t: usize,
    regs: usize,
    selem: usize,
    ebytes: usize,
    datasize: usize,
    v: &mut [u128; 4],
) {
    let total = regs * datasize;
    let mut buf = [0u8; 64];
    let mut lanes = [[0u8; 16]; 4];
    if load_ {
        for (o, x) in buf[..total].as_chunks_mut::<8>().0.iter_mut().enumerate() {
            // SAFETY: `fast` found `total` bytes of RAM at `p`.
            *x = unsafe { mem::load(p.add(8 * o), 8) }.to_le_bytes();
        }
    } else {
        for (k, l) in lanes.iter_mut().take(regs).enumerate() {
            *l = c.v[(t + k) % 32].to_le_bytes();
        }
    }
    if selem == 1 {
        for (k, l) in lanes.iter_mut().take(regs).enumerate() {
            let m = &mut buf[k * datasize..(k + 1) * datasize];
            if load_ {
                l[..datasize].copy_from_slice(m);
            } else {
                m.copy_from_slice(&l[..datasize]);
            }
        }
    } else {
        let lanes = &mut lanes[..selem];
        let buf = &mut buf[..total];
        match ebytes {
            1 => interleave::<1>(buf, lanes, load_),
            2 => interleave::<2>(buf, lanes, load_),
            4 => interleave::<4>(buf, lanes, load_),
            _ => interleave::<8>(buf, lanes, load_),
        }
    }
    if load_ {
        for (x, l) in v.iter_mut().zip(lanes).take(regs) {
            *x = u128::from_le_bytes(l);
        }
    } else {
        for (o, x) in buf[..total].as_chunks::<8>().0.iter().enumerate() {
            // SAFETY: as for the loads.
            unsafe { mem::store(p.add(8 * o), 8, u64::from_le_bytes(*x)) };
        }
    }
}

/// Structure `e` of `buf` (E-byte elements) is element `e` of each of
/// `lanes` in turn: loads de-interleave `buf` into `lanes`, stores the reverse.
/// E is a constant so that each element is a move, not a `memcpy` call.
#[inline(always)]
fn interleave<const E: usize>(buf: &mut [u8], lanes: &mut [[u8; 16]], load_: bool) {
    let structs = buf.as_chunks_mut::<E>().0.chunks_exact_mut(lanes.len());
    for (e, xs) in structs.enumerate() {
        for (x, l) in xs.iter_mut().zip(lanes.iter_mut()) {
            let l: &mut [u8; E] = (&mut l[e * E..e * E + E]).try_into().unwrap();
            if load_ {
                *l = *x;
            } else {
                *x = *l;
            }
        }
    }
}

/// LD1–LD4 / ST1–ST4 (single structure) and LD1R–LD4R.
#[inline(never)]
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
    // The whole transfer through a host pointer when it's RAM in one page.
    let u = if load_ { Use::Read } else { Use::Write };
    let fast = m.fast(c, base, selem as u32 * ebytes, u);
    let mut addr = base;
    if index == u32::MAX {
        let mut vals = [0u128; 4];
        for x in vals.iter_mut().take(selem) {
            *x = lane_load(c, m, fast, base, addr, ebytes)?;
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
                *x = lane_load(c, m, fast, base, addr, ebytes)?;
            } else {
                let x = (c.v[tt] >> sh) & emask;
                match fast {
                    // SAFETY: `fast` found the transfer's bytes in RAM at `p`.
                    Some(p) => unsafe {
                        mem::store(p.add((addr - base) as usize), ebytes, x as u64)
                    },
                    None => store(c, m, addr, ebytes, x)?,
                }
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

/// One element of [`single_structure`]: through `fast`, the host pointer for
/// the transfer at `base`, else the bus.
#[inline(always)]
fn lane_load(
    c: &Cpu,
    m: &mut impl Bus,
    fast: Option<*mut u8>,
    base: u64,
    addr: u64,
    ebytes: u32,
) -> R<u128> {
    match fast {
        // SAFETY: `fast` found the transfer's bytes in RAM at `p`; `addr` is in it.
        Some(p) => Ok(unsafe { mem::load(p.add((addr - base) as usize), ebytes) } as u128),
        None => load(c, m, addr, ebytes),
    }
}
