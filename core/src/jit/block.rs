//! Block formation and emission (M5 step 2: gadget-only, every instruction a
//! helper call).
//!
//! A block starts at a physical address and runs straight on: it ends after a
//! branch or a system-class instruction, before an exception-generating or
//! unallocated one, at the end of the 4 KiB page, or at [`CAP`] instructions.
//! Its words are read at compile time, so the block executes the words it saw.

use super::wasm::{Code, I32, I64, Module};
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

/// Offset of `Cpu::pc` in the `Vcpu` a block gets.
const PC: u32 = 256;

/// One module with a function per block, `block(vcpu) -> retired`, named
/// `<va>_pa<pa>`. Instruction *i* is `if helper(vcpu, insn_i, pc + 4i) { return i }`,
/// with `pc` read at entry: blocks are keyed by PA, so one can run at any VA
/// that maps its page.
pub fn module(blocks: &[Block]) -> Vec<u8> {
    let mut m = Module::default();
    let bt = m.ty(&[I32], &[I32]);
    let ht = m.ty(&[I32, I32, I64], &[I32]);
    let flat = m.import_func("env", "jit_exec_flat", ht);
    let mmu = m.import_func("env", "jit_exec_mmu", ht);
    m.import_memory("env", "memory", 0, 65536);
    for b in blocks {
        let h = if b.key & KEY_MMU != 0 { mmu } else { flat };
        let mut c = Code::default();
        c.local_get(0).i64_load(PC).local_set(1);
        for (i, &w) in b.words.iter().enumerate() {
            c.local_get(0).i32_const(w as i32).local_get(1);
            if i > 0 {
                c.i64_const(4 * i as i64).i64_add();
            }
            c.call(h).if_().i32_const(i as i32).return_().end();
        }
        c.i32_const(b.words.len() as i32).end();
        let name = format!("{:#x}_pa{:#x}", b.va, b.key & !3);
        m.func(bt, &[(1, I64)], &c, &name);
    }
    m.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOP: u32 = 0xd503201f;
    const ADD: u32 = 0x91000c41; // add x1, x2, #3
    const PACIASP: u32 = 0xd503233f;

    fn mem_with(at: u64, words: &[u32]) -> (Vec<u128>, Mem) {
        let mut ram = vec![0u128; 0x4000 / 16];
        // SAFETY: `ram` outlives the Mem in each test and is 16-byte aligned.
        let mem = unsafe { Mem::new(ram.as_mut_ptr().cast(), 0x4000) };
        for (k, &w) in words.iter().enumerate() {
            mem.write(at + 4 * k as u64, 4, w as u64).unwrap();
        }
        (ram, mem)
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
            words: vec![ADD, 0xd65f03c0],
        };
        let bytes = module(&[b]);
        #[rustfmt::skip]
        let body = [
            1, 1, I64,                              // one i64 local: the entry PC
            0x20, 0, 0x29, 3, 0x80, 2, 0x21, 1,     // local.get 0; i64.load 256; local.set 1
            0x20, 0, 0x41, 0xc1, 0x98, 0x80, 0x88, 0x79, 0x20, 1, // vcpu, add, pc
            0x10, 1, 0x04, 0x40, 0x41, 0, 0x0f, 0x0b, // call mmu; if: return 0
            0x20, 0, 0x41, 0xc0, 0x87, 0xfc, 0xb2, 0x7d, 0x20, 1, 0x42, 4, 0x7c, // ret, pc + 4
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
}
