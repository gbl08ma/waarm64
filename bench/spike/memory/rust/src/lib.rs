//! M0.5 memory spike: Rust-side guest RAM access.
//!
//! A toy interpreter shaped like core code (CPU struct in memory, decode, a
//! software TLB). Guest RAM is either in the module's own linear memory
//! (layout A with the wasm32 build, layout C with the wasm64 build) or reached
//! through imported accessor functions from a hand-written multi-memory module
//! (layout B: a wasm32 RAM memory, layout D: a memory64 RAM memory).

pub const GUEST_VA: u64 = 0x4000_0000;
const TLB: usize = 1024;

/// Guest RAM access, given a host address (guest VA + TLB addend).
pub trait Ram {
    fn ld(&self, host: u64) -> u64;
    fn st(&self, host: u64, v: u64);
}

/// RAM in this module's own linear memory: host addresses are pointers.
pub struct Direct;
impl Ram for Direct {
    #[inline(always)]
    fn ld(&self, host: u64) -> u64 {
        // SAFETY: host addresses come from the TLB, which only maps the RAM buffer.
        unsafe { (host as usize as *const u64).read() }
    }
    #[inline(always)]
    fn st(&self, host: u64, v: u64) {
        // SAFETY: as above.
        unsafe { (host as usize as *mut u64).write(v) }
    }
}

#[cfg(target_arch = "wasm32")]
mod import {
    #[link(wasm_import_module = "ram")]
    unsafe extern "C" {
        pub fn ld32(host: u32) -> u64;
        pub fn st32(host: u32, v: u64);
        pub fn read32(dst: *mut u8, host: u32, len: u32);
        pub fn ld64(host: u64) -> u64;
        pub fn st64(host: u64, v: u64);
        pub fn read64(dst: *mut u8, host: u64, len: u32);
    }
    /// B: RAM in a wasm32 memory the core can't address.
    pub struct Mem32;
    impl super::Ram for Mem32 {
        #[inline(always)]
        fn ld(&self, host: u64) -> u64 {
            // SAFETY: the accessor bounds-checks (wasm traps on out-of-bounds).
            unsafe { ld32(host as u32) }
        }
        #[inline(always)]
        fn st(&self, host: u64, v: u64) {
            // SAFETY: as above.
            unsafe { st32(host as u32, v) }
        }
    }
    /// D: RAM in a memory64 memory.
    pub struct Mem64;
    impl super::Ram for Mem64 {
        #[inline(always)]
        fn ld(&self, host: u64) -> u64 {
            // SAFETY: as above.
            unsafe { ld64(host) }
        }
        #[inline(always)]
        fn st(&self, host: u64, v: u64) {
            // SAFETY: as above.
            unsafe { st64(host, v) }
        }
    }
}

// Instruction word: op | rd << 4 | rn << 8 | rm << 12 | imm << 16 (imm is i16).
const ADDI: u32 = 0;
const ADD: u32 = 1;
const EOR: u32 = 2;
const ROL: u32 = 3;
const LSR: u32 = 4;
const AND: u32 = 5;
const MUL: u32 = 6;
const LDR: u32 = 7;
const STR: u32 = 8;
const CBNZ: u32 = 9;

const fn ins(op: u32, rd: u32, rn: u32, rm: u32, imm: i16) -> u32 {
    op | rd << 4 | rn << 8 | rm << 12 | (imm as u16 as u32) << 16
}

/// The mixed kernel of the JIT benchmarks, as guest code: random address,
/// two loads, ALU, a store, loop (14 instructions, 3 memory ops).
/// x5 LCG state, x6/x7 LCG constants, x8 mask, x9 GUEST_VA, x11 counter.
pub const PROGRAM: [u32; 14] = [
    ins(MUL, 5, 5, 6, 0),
    ins(ADD, 5, 5, 7, 0),
    ins(LSR, 10, 5, 0, 29),
    ins(AND, 10, 10, 8, 0),
    ins(ADD, 0, 10, 9, 0),
    ins(LDR, 1, 0, 0, 0),
    ins(LDR, 2, 0, 0, 8),
    ins(ADD, 3, 3, 2, 0),
    ins(EOR, 4, 4, 3, 0),
    ins(ROL, 4, 4, 0, 7),
    ins(ADD, 4, 4, 1, 0),
    ins(STR, 4, 0, 0, 16),
    ins(ADDI, 11, 11, 0, -1),
    ins(CBNZ, 11, 0, 0, 0),
];

#[repr(C)]
pub struct State {
    x: [u64; 16],
    pc: usize,
    tag: [u64; TLB],
    addend: [u64; TLB],
    /// Host address of guest VA 0x4000_0000 (a pointer for Direct, an offset in the RAM memory otherwise).
    ram_host: u64,
    prog: Vec<u32>,
    ram: Vec<u64>,
    buf: Vec<u8>,
}

impl State {
    pub fn new(ram_bytes: usize) -> Box<Self> {
        Box::new(State {
            x: [0; 16],
            pc: 0,
            tag: [u64::MAX; TLB],
            addend: [0; TLB],
            ram_host: 0,
            prog: PROGRAM.to_vec(),
            ram: vec![0; ram_bytes / 8],
            buf: vec![0; 1 << 16],
        })
    }

    fn translate(&mut self, va: u64) -> u64 {
        let i = (va >> 12) as usize & (TLB - 1);
        if self.tag[i] != va & !0xff8 {
            // Refill: the stand-in page walk maps guest RAM linearly.
            self.tag[i] = va & !0xfff;
            self.addend[i] = self.ram_host.wrapping_sub(GUEST_VA);
        }
        va.wrapping_add(self.addend[i])
    }

    /// Runs the program for `iters` loop iterations; returns a checksum.
    pub fn run<R: Ram>(&mut self, ram: &R, iters: u64, mask: u64, seed: u64) -> u64 {
        self.x = [0; 16];
        self.x[5] = seed;
        self.x[6] = 6364136223846793005;
        self.x[7] = 1442695040888963407;
        self.x[8] = mask;
        self.x[9] = GUEST_VA;
        self.x[11] = iters;
        self.pc = 0;
        self.tag = [u64::MAX; TLB];
        loop {
            let w = self.prog[self.pc];
            self.pc += 1;
            let (rd, rn, rm) = (
                (w >> 4 & 15) as usize,
                (w >> 8 & 15) as usize,
                (w >> 12 & 15) as usize,
            );
            let imm = (w >> 16) as u16 as i16 as i64 as u64;
            let (a, b) = (self.x[rn], self.x[rm]);
            match w & 15 {
                ADDI => self.x[rd] = a.wrapping_add(imm),
                ADD => self.x[rd] = a.wrapping_add(b),
                EOR => self.x[rd] = a ^ b,
                ROL => self.x[rd] = a.rotate_left(imm as u32),
                LSR => self.x[rd] = a >> imm,
                AND => self.x[rd] = a & b,
                MUL => self.x[rd] = a.wrapping_mul(b),
                LDR => {
                    let h = self.translate(a.wrapping_add(imm));
                    self.x[rd] = ram.ld(h);
                }
                STR => {
                    let h = self.translate(a.wrapping_add(imm));
                    ram.st(h, self.x[rd]);
                }
                CBNZ => {
                    if self.x[rd] != 0 {
                        self.pc = imm as usize;
                    } else {
                        return self.x[3] ^ self.x[4];
                    }
                }
                _ => unreachable!(),
            }
        }
    }
}

// --- exports (JS passes BigInt for usize/u64 on wasm64) -----------------

/// Allocates the interpreter state with `ram_bytes` of direct RAM.
#[unsafe(no_mangle)]
pub extern "C" fn setup(ram_bytes: usize) -> *mut State {
    Box::into_raw(State::new(ram_bytes))
}

/// kind 0: RAM in own memory (A / C); 1: accessor to wasm32 memory (B);
/// 2: accessor to memory64 (D), with RAM at host offset `ram_off` there.
///
/// # Safety
/// `s` comes from `setup`; for kinds 1 and 2 the accessor module is imported.
#[unsafe(no_mangle)]
#[cfg_attr(not(target_arch = "wasm32"), allow(unused_variables))]
pub unsafe extern "C" fn run(s: *mut State, kind: u32, iters: u64, mask: u64, ram_off: u64) -> u64 {
    // SAFETY: guaranteed by the caller.
    let s = unsafe { &mut *s };
    match kind {
        0 => {
            s.ram_host = s.ram.as_ptr() as u64;
            s.run(&Direct, iters, mask, 1)
        }
        #[cfg(target_arch = "wasm32")]
        1 => {
            s.ram_host = ram_off;
            s.run(&import::Mem32, iters, mask, 1)
        }
        #[cfg(target_arch = "wasm32")]
        2 => {
            s.ram_host = ram_off;
            s.run(&import::Mem64, iters, mask, 1)
        }
        _ => unreachable!(),
    }
}

/// Virtio-DMA stand-in: copies `reps` chunks of `len` bytes from guest RAM
/// (cycling through the first `span` bytes) into a core buffer. Same kinds as `run`.
///
/// # Safety
/// As for `run`; `len` ≤ 64 KiB and `span` ≤ the RAM size.
#[unsafe(no_mangle)]
#[cfg_attr(not(target_arch = "wasm32"), allow(unused_variables))]
pub unsafe extern "C" fn dma(
    s: *mut State,
    kind: u32,
    len: u32,
    reps: u32,
    span: u64,
    ram_off: u64,
) -> u8 {
    // SAFETY: guaranteed by the caller.
    let s = unsafe { &mut *s };
    let dst = s.buf.as_mut_ptr();
    let mut off = 0u64;
    for _ in 0..reps {
        match kind {
            // SAFETY: off + len stays within the RAM vec and len within buf.
            0 => unsafe {
                core::ptr::copy_nonoverlapping(
                    (s.ram.as_ptr() as *const u8).add(off as usize),
                    dst,
                    len as usize,
                )
            },
            #[cfg(target_arch = "wasm32")]
            // SAFETY: the accessor bounds-checks the source; dst has room for len.
            1 => unsafe { import::read32(dst, (ram_off + off) as u32, len) },
            #[cfg(target_arch = "wasm32")]
            // SAFETY: as above.
            2 => unsafe { import::read64(dst, ram_off + off, len) },
            _ => unreachable!(),
        }
        off = (off + len as u64) % span;
    }
    s.buf[0]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpreter_matches_reference() {
        let mask = ((1u64 << 20) - 1) & !63;
        let mut s = State::new(1 << 20);
        s.ram_host = s.ram.as_ptr() as u64;
        let got = s.run(&Direct, 1000, mask, 1);

        let mut ram = vec![0u64; 1 << 17];
        let (mut x3, mut x4, mut lcg) = (0u64, 0u64, 1u64);
        for _ in 0..1000 {
            lcg = lcg
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let a = ((lcg >> 29) & mask) as usize / 8;
            x3 = x3.wrapping_add(ram[a + 1]);
            x4 = (x4 ^ x3).rotate_left(7).wrapping_add(ram[a]);
            ram[a + 2] = x4;
        }
        assert_eq!(got, x3 ^ x4);
        assert_eq!(s.ram, ram);
    }
}
