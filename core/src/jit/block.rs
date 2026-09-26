//! Block formation and emission: each instruction inline (`emit`, M5 step 4)
//! or a call to an interpreter helper.
//!
//! A block starts at a physical address and runs straight on: it ends after a
//! branch or a system-class instruction, before an exception-generating or
//! unallocated one, at the end of the 4 KiB page, or at [`CAP`] instructions.
//! Its words are read at compile time, so the block executes the words it saw.

use super::emit;
use super::wasm::{I32, I64, Module};
use crate::decode::{Op, decode};
use crate::mem::Mem;

/// Instructions per block, at most.
pub const CAP: usize = 32;

/// Block key bits beside the (4-aligned) PA: the EL, and the MMU copy of the
/// interpreter (`SCTLR_EL1.M` or `.A` set), which picks the helper.
pub const KEY_EL1: u64 = 1;
pub const KEY_MMU: u64 = 2;

/// Where an instruction ends a block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    No,
    /// The block includes it and ends there.
    After,
    /// The block ends before it; the interpreter runs it.
    Before,
}

/// Branches and system-class instructions end a block after them;
/// exception-generating and unallocated encodings end it before them.
/// Hints that are NOPs here (PAC and BTI hint space, CSDB, …) don't end one.
// ponytail: conservative on purpose (every barrier, MRS/MSR, SYS, CLREX ends a
// block); relax with evidence once blocks link (M5 step 7).
pub fn end(op: Op) -> End {
    use Op::*;
    match op {
        B_uncond | BL | B_cond | CBZ | CBNZ | TBZ | TBNZ | BR | BLR | RET | ERET | MRS
        | MSR_reg | MSR_imm | SYS | SYSL | DC_IVAC | DC_ISW | DC_CSW | DC_CISW | DC_ZVA
        | DC_CVAC | DC_CVAU | DC_CIVAC | IC_IALLU | IC_IALLUIS | IC_IVAU | WFE | WFI | YIELD
        | SEV | SEVL | CLREX | DMB | DSB | ISB | SSBB | PSSBB => End::After,
        SVC | HVC | SMC | BRK | HLT | DCPS1 | DCPS2 | DCPS3 | DRPS | UnallocatedEncoding => {
            End::Before
        }
        _ => End::No,
    }
}

/// The words of the block at `pa` (empty if it would have none, or `pa` isn't RAM).
pub fn form(mem: &Mem, pa: u64) -> Vec<u32> {
    let mut words = Vec::new();
    let mut a = pa;
    while let Ok(w) = mem.read(a, 4) {
        let w = w as u32;
        match end(decode(w)) {
            End::Before => break,
            End::After => {
                words.push(w);
                break;
            }
            End::No => words.push(w),
        }
        a += 4;
        if a & 0xfff == 0 || words.len() == CAP {
            break;
        }
    }
    words
}

/// `n` words at `pa` (fewer if they leave RAM).
pub fn read(mem: &Mem, pa: u64, n: usize) -> Vec<u32> {
    (0..n as u64)
        .map_while(|k| mem.read(pa + 4 * k, 4).ok().map(|w| w as u32))
        .collect()
}

/// FNV-1a over a block's words, for the stale-code checker.
pub fn hash(words: &[u32]) -> u64 {
    words.iter().fold(0xcbf2_9ce4_8422_2325, |h, &w| {
        (h ^ w as u64).wrapping_mul(0x100_0000_01b3)
    })
}

/// A block to emit: its key (PA and regime bits), the VA it was first seen at
/// (for its name only) and its words.
pub struct Block {
    pub key: u64,
    pub va: u64,
    pub words: Vec<u32>,
}

/// One module with a function per block, `block(vcpu) -> retired`, named
/// `<va>_pa<pa>`, and each block's count of inline instructions. Instruction
/// *i* is inline or `if helper(vcpu, insn_i, pc + 4i) { return i }`, with `pc`
/// read at entry: blocks are keyed by PA, so one can run at any VA that maps
/// its page. Helpers set `Cpu::pc` themselves; a block that ends on an inline
/// instruction other than a branch stores it before returning. Registers in
/// locals are written back before each helper call and before the return, and
/// reloaded on use after a helper (which may have written any of them); lazy
/// flags are stored at the same points. Also returns the module's flag counts.
pub fn module(blocks: &[Block], mem: &Mem) -> (Vec<u8>, Vec<u32>, emit::Counts) {
    let mut m = Module::default();
    let bt = m.ty(&[I32], &[I32]);
    let ht = m.ty(&[I32, I32, I64], &[I32]);
    let flat = m.import_func("env", "jit_exec_flat", ht);
    let mmu = m.import_func("env", "jit_exec_mmu", ht);
    m.import_memory("env", "memory", 0, 65536);
    let mut inl = Vec::with_capacity(blocks.len());
    let mut counts = emit::Counts::default();
    let (base, phys) = mem.base();
    for b in blocks {
        let cx = if b.key & KEY_MMU != 0 {
            let read = emit::tlb_array(b.key & KEY_EL1, 0);
            emit::Ctx {
                helper: mmu,
                bus: emit::Bus::Tlb { read },
            }
        } else {
            let (base, size) = (base as usize as u32, mem.size());
            emit::Ctx {
                helper: flat,
                bus: emit::Bus::Flat { base, phys, size },
            }
        };
        let h = cx.helper;
        let emit = |plain: u32| {
            let mut c = emit::Func::default();
            c.plain = plain;
            c.local_get(0).i64_load(emit::PC).local_set(1);
            let (mut n, mut last) = (0, false);
            for (i, &w) in b.words.iter().enumerate() {
                let op = decode(w);
                if end(op) == End::After {
                    c.commit_flags(); // see `commit_flags`
                }
                last = emit::inline(&mut c, w, op, i, &cx);
                if last {
                    n += 1;
                    // Branches end blocks and set the PC.
                    last = end(op) == End::No;
                    continue;
                }
                c.flush();
                c.sync_flags();
                c.local_get(0).i32_const(w as i32).local_get(1);
                if i > 0 {
                    c.i64_const(4 * i as i64).i64_add();
                }
                c.call(h).if_().i32_const(i as i32).return_().end();
                c.forget(!0);
            }
            if last {
                emit::set_pc(&mut c, 4 * b.words.len() as i64);
            }
            c.flush();
            c.sync_flags();
            c.i32_const(b.words.len() as i32).end();
            (c, n)
        };
        // Twice: the first emission finds the registers to read plainly (`Func::plain`).
        let first = emit(0).0;
        let (mut c, n) = emit(first.read & !first.reused);
        let name = format!("{:#x}_pa{:#x}", b.va, b.key & !3);
        let locals = c.locals();
        m.func(bt, &locals, &c.c, &name);
        inl.push(n);
        counts += c.counts;
    }
    (m.finish(), inl, counts)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOP: u32 = 0xd503201f;
    const ADD: u32 = 0x91000c41; // add x1, x2, #3
    const PACIASP: u32 = 0xd503233f;
    const MOVZ: u32 = 0xd2800061; // movz x1, #3
    const MRS: u32 = 0xd53b4200; // mrs x0, nzcv

    fn mem_with(at: u64, words: &[u32]) -> (Vec<u128>, Mem) {
        let mut ram = vec![0u128; 0x4000 / 16];
        // SAFETY: `ram` outlives the Mem in each test and is 16-byte aligned.
        let mem = unsafe { Mem::new(ram.as_mut_ptr().cast(), 0x4000) };
        for (k, &w) in words.iter().enumerate() {
            mem.write(at + 4 * k as u64, 4, w as u64).unwrap();
        }
        (ram, mem)
    }

    fn test_mem() -> Mem {
        // SAFETY: never accessed (module only reads its layout).
        unsafe { Mem::new(core::ptr::dangling_mut::<u128>().cast(), 0) }
    }

    #[test]
    fn end_rules() {
        for (w, e) in [
            (0x14000000, End::After),  // b .
            (0x94000000, End::After),  // bl .
            (0x54000041, End::After),  // b.ne
            (0xb4000000, End::After),  // cbz x0
            (0x36000000, End::After),  // tbz w0, #0
            (0xd61f0000, End::After),  // br x0
            (0xd63f0000, End::After),  // blr x0
            (0xd65f03c0, End::After),  // ret
            (0xd69f03e0, End::After),  // eret
            (0xd53b4200, End::After),  // mrs x0, nzcv
            (0xd51b4200, End::After),  // msr nzcv, x0
            (0xd508871f, End::After),  // tlbi vmalle1
            (0xd50b7520, End::After),  // ic ivau, x0
            (0xd503207f, End::After),  // wfi
            (0xd5033bbf, End::After),  // dmb ish
            (0xd5033fdf, End::After),  // isb
            (0xd4000001, End::Before), // svc #0
            (0xd4000002, End::Before), // hvc #0
            (0xd4200000, End::Before), // brk #0
            (0x00000000, End::Before), // udf #0
            (NOP, End::No),
            (PACIASP, End::No),
            (ADD, End::No),
            (0xf9400020, End::No), // ldr x0, [x1]
        ] {
            assert_eq!(end(decode(w)), e, "{w:#010x}");
        }
    }

    #[test]
    fn formation() {
        let (_r, m) = mem_with(0x100, &[ADD, PACIASP, 0x54000041, ADD]);
        assert_eq!(form(&m, 0x100), [ADD, PACIASP, 0x54000041]); // ends after b.ne
        let (_r, m) = mem_with(0x100, &[ADD, ADD, 0xd4000001, ADD]);
        assert_eq!(form(&m, 0x100), [ADD, ADD]); // ends before svc
        assert_eq!(form(&m, 0x108), []); // starts on svc: no block
        // The page's end, and the cap.
        let (_r, m) = mem_with(0xff8, &[ADD, ADD, ADD]);
        assert_eq!(form(&m, 0xff8), [ADD, ADD]);
        let (_r, m) = mem_with(0x1000, &[NOP; 40]);
        assert_eq!(form(&m, 0x1000).len(), CAP);
        // Outside RAM.
        assert_eq!(form(&m, 0x4000), []);
        let (_r, m) = mem_with(0x3ffc, &[ADD]);
        assert_eq!(form(&m, 0x3ffc), [ADD]);
    }

    #[test]
    fn two_instruction_block_bytes() {
        let b = Block {
            key: 0x4000_0100 | KEY_EL1 | KEY_MMU,
            va: 0xffff_0100,
            words: vec![MOVZ, MRS],
        };
        let (bytes, inl, _) = module(&[b], &test_mem());
        assert_eq!(inl, [1]);
        #[rustfmt::skip]
        let body = [
            1, 2, I64,                              // locals: the entry PC and x1, all it uses
            0x20, 0, 0x29, 3, 0x80, 2, 0x21, 1,     // local.get 0; i64.load 256; local.set 1
            0x42, 3, 0x21, 2,                      // movz inline: x1 (local 2) = 3
            0x20, 0, 0x20, 2, 0x37, 3, 8,          // written back before the helper
            0x20, 0, 0x41, 0x80, 0x84, 0xed, 0xa9, 0x7d, 0x20, 1, 0x42, 4, 0x7c, // mrs, pc + 4
            0x10, 1, 0x04, 0x40, 0x41, 1, 0x0f, 0x0b, // call mmu; if: return 1
            0x41, 2, 0x0b,                          // return 2
        ];
        let name = b"0xffff0100_pa0x40000100";
        #[rustfmt::skip]
        let mut want = vec![
            0, b'a', b's', b'm', 1, 0, 0, 0,
            1, 13, 2, 0x60, 1, I32, 1, I32, 0x60, 3, I32, I32, I64, 1, I32, // types
            2, 57, 3, // imports
            3, b'e', b'n', b'v', 13, b'j', b'i', b't', b'_', b'e', b'x', b'e', b'c', b'_', b'f', b'l', b'a', b't', 0, 1,
            3, b'e', b'n', b'v', 12, b'j', b'i', b't', b'_', b'e', b'x', b'e', b'c', b'_', b'm', b'm', b'u', 0, 1,
            3, b'e', b'n', b'v', 6, b'm', b'e', b'm', b'o', b'r', b'y', 2, 3, 0, 0x80, 0x80, 4,
            3, 2, 1, 0, // function section
            7, 6, 1, 2, b'f', b'0', 0, 2, // export f0 = function 2
            10, 2 + body.len() as u8, 1, body.len() as u8,
        ];
        want.extend(body);
        want.extend([0, 7 + 3 + name.len() as u8, 4, b'n', b'a', b'm', b'e', 1]);
        want.extend([3 + name.len() as u8, 1, 2, name.len() as u8]);
        want.extend(name);
        assert_eq!(bytes, want);
    }

    #[test]
    fn a_block_ending_inline_stores_the_pc() {
        let b = Block {
            key: 0x4000_0200,
            va: 0x4000_0200,
            words: vec![MOVZ, MOVZ],
        };
        let (bytes, inl, _) = module(&[b], &test_mem());
        assert_eq!(inl, [2]);
        // vcpu; entry + 8; i64.store 256; x1 written back; return 2
        #[rustfmt::skip]
        let tail = [
            0x20, 0, 0x20, 1, 0x42, 8, 0x7c, 0x37, 3, 0x80, 2,
            0x20, 0, 0x20, 2, 0x37, 3, 8, 0x41, 2, 0x0b,
        ];
        assert!(bytes.windows(tail.len()).any(|w| w == tail));
    }

    fn has(bytes: &[u8], w: &[u8]) -> bool {
        bytes.windows(w.len()).any(|x| x == w)
    }

    #[test]
    fn registers_stay_in_locals() {
        // add x1, x2, #3; add x3, x1, #1: the second reads x1 from its local,
        // and both results are written back once, at the end. x2, read once,
        // is a plain load (no local).
        let b = Block {
            key: 0x4000_0200,
            va: 0x4000_0200,
            words: vec![ADD, 0x91000423],
        };
        let (bytes, _, _) = module(&[b], &test_mem());
        #[rustfmt::skip]
        let body = [
            0x20, 0, 0x29, 3, 16, 0x42, 3, 0x7c, 0x21, 2, // x1 = x2 + 3
            0x20, 2, 0x42, 1, 0x7c, 0x21, 3,              // x3 = x1 + 1
        ];
        assert!(has(&bytes, &body));
        assert!(has(
            &bytes,
            &[0x20, 0, 0x20, 2, 0x37, 3, 8, 0x20, 0, 0x20, 3, 0x37, 3, 24]
        ));
        assert_eq!(bytes.windows(2).filter(|w| *w == [0x29, 3]).count(), 2); // the PC and x2
    }

    #[test]
    fn a_helper_writes_back_and_forgets() {
        // add x1, x2, #3; fmov x1, d0 (a helper); add x3, x1, #1: x1 is written
        // back before the call and loaded again after it.
        let b = Block {
            key: 0x4000_0200,
            va: 0x4000_0200,
            words: vec![ADD, 0x9e660001, 0x91000423],
        };
        let (bytes, inl, _) = module(&[b], &test_mem());
        assert_eq!(inl, [2]);
        #[rustfmt::skip]
        let around = [
            0x20, 0, 0x20, 2, 0x37, 3, 8,                    // x1 written back
            0x20, 0, 0x41,                                    // helper(vcpu, insn, …)
        ];
        assert!(has(&bytes, &around));
        #[rustfmt::skip]
        let after = [
            0x0f, 0x0b,                                       // …; if: return 1; end
            0x20, 0, 0x29, 3, 8, 0x22, 2, 0x42, 1, 0x7c, 0x21, 3, // x3 = x1 (reloaded) + 1
        ];
        assert!(has(&bytes, &after));
    }

    /// The number of NZCV stores (`i64.store 264`) in `bytes`.
    fn nzcv_stores(bytes: &[u8]) -> usize {
        bytes.windows(3).filter(|w| *w == [0x37, 3, 0x88]).count()
    }

    fn one(words: &[u32]) -> (Vec<u8>, emit::Counts) {
        let b = Block {
            key: 0x4000_0200,
            va: 0x4000_0200,
            words: words.to_vec(),
        };
        let (bytes, _, counts) = module(&[b], &test_mem());
        (bytes, counts)
    }

    #[test]
    fn dead_flags_and_direct_conditions() {
        // cmp x1, x2; cmp x3, x4; b.lt: the first compare's flags are dead,
        // b.lt is i64.lt_s on the second's operands, and NZCV is stored once,
        // at the end (live out of every block).
        let (bytes, counts) = one(&[0xeb02003f, 0xeb04007f, 0x5400000b]);
        // Locals after compaction: entry, two scratch (for the store), the flag locals.
        assert!(has(&bytes, &[0x20, 4, 0x20, 5, 0x53])); // i64.lt_s
        assert_eq!(nzcv_stores(&bytes), 1);
        assert!(!has(&bytes, &[0x28, 2, 0x88, 2])); // NZCV never loaded
        // Stored before the branch's PC store (`commit_flags`), not after it.
        let nzcv = bytes.windows(3).position(|w| w == [0x37, 3, 0x88]).unwrap();
        let pc = bytes.windows(3).position(|w| w == [0x37, 3, 0x80]).unwrap();
        assert!(nzcv < pc);
        let want = emit::Counts {
            flags_stored: 1,
            flags_elided: 1,
            cond_direct: 1,
            ..Default::default()
        };
        assert_eq!(counts, want);
        // tst w1, #1; b.ne: the i32 result against zero (i32.ne).
        let (bytes, _) = one(&[0x7200003f, 0x54000001]);
        assert!(has(&bytes, &[0x20, 2, 0x41, 0, 0x47])); // the i32 result, after the entry PC
        // adds x0, x1, x2; adc x3, x3, x3: the carry in is x + y < x, unsigned.
        let (bytes, counts) = one(&[0xab020020, 0x9a030063]);
        assert!(has(&bytes, &[0x20, 5, 0x20, 6, 0x7c, 0x20, 5, 0x54])); // i64.lt_u
        assert_eq!(counts.cond_direct, 1);
        // Flags from outside the block come from memory.
        let (_, counts) = one(&[0x5400000b]);
        assert_eq!(counts.cond_memory, 1);
        // adcs x0, x0, x0; b.vs: no direct form, NZCV computed in registers.
        let (_, counts) = one(&[0xba000000, 0x54000006]);
        assert_eq!(counts.cond_computed, 1);
    }

    #[test]
    fn flags_are_stored_before_helpers_and_on_failure_returns() {
        // cmp x1, x2; fmov x1, d0 (a helper): NZCV stored before the call; the
        // helper may write it, so nothing is left to store at the end.
        let (bytes, counts) = one(&[0xeb02003f, 0x9e660001]);
        assert_eq!(nzcv_stores(&bytes), 1);
        let at = bytes.windows(3).position(|w| w == [0x37, 3, 0x88]).unwrap();
        assert!(bytes[at..].windows(2).any(|w| w == [0x10, 0])); // the call comes after
        assert_eq!(counts.flags_stored, 1);
        // cmp x1, x2; ldr x0, [x1]: stored on the load's failure return, and at the end.
        let (bytes, counts) = one(&[0xeb02003f, 0xf9400020]);
        assert_eq!(nzcv_stores(&bytes), 2);
        let ret = bytes.windows(2).position(|w| w == [0x41, 1]).unwrap(); // i32.const 1; return
        assert_eq!(bytes[ret + 2], 0x0f);
        assert!(nzcv_stores(&bytes[..ret]) == 1);
        assert_eq!((counts.flags_stored, counts.flags_elided), (1, 0));
    }
}
