//! Spot checks per instruction group. Encodings come from llvm-mc (asm in the
//! comments); expected values are worked out by hand. The golden corpus is the
//! broad check.

use super::*;
use crate::mem::tests::TestRam;

const CODE: u64 = 0x1000;
const DATA: u64 = 0x2000;
const RAM: usize = 0x10000;

struct T {
    c: Cpu,
    r: TestRam,
    end: u64,
}

impl T {
    fn new(prog: &[u32]) -> T {
        let r = TestRam::new(RAM);
        for (k, w) in prog.iter().enumerate() {
            r.mem.write(CODE + 4 * k as u64, 4, *w as u64).unwrap();
        }
        let c = Cpu {
            pc: CODE,
            ..Cpu::default()
        };
        T {
            c,
            r,
            end: CODE + 4 * prog.len() as u64,
        }
    }

    fn x(mut self, n: usize, v: u64) -> T {
        self.c.x[n] = v;
        self
    }

    fn nzcv(mut self, v: u64) -> T {
        self.c.nzcv = v;
        self
    }

    fn mem(self, addr: u64, size: u32, v: u64) -> T {
        self.r.mem.write(addr, size, v).unwrap();
        self
    }

    fn rd(&self, addr: u64, size: u32) -> u64 {
        self.r.mem.read(addr, size).unwrap()
    }

    /// Steps until the PC leaves the program.
    fn run(mut self) -> T {
        for _ in 0..10_000 {
            if !(CODE..self.end).contains(&self.c.pc) {
                return self;
            }
            step(&mut self.c, &self.r.mem).unwrap();
        }
        panic!("program didn't finish");
    }

    fn step(&mut self) -> R {
        step(&mut self.c, &self.r.mem)
    }
}

/// One instruction with register inputs; returns the CPU after it.
fn one(insn: u32, regs: &[(usize, u64)], nzcv: u64) -> Cpu {
    let mut t = T::new(&[insn]).nzcv(nzcv);
    for &(n, v) in regs {
        t.c.x[n] = v;
    }
    t.run().c
}

const N: u64 = 0x8000_0000;
const Z: u64 = 0x4000_0000;
const C: u64 = 0x2000_0000;
const V: u64 = 0x1000_0000;

#[test]
fn add_sub_flags() {
    let c = one(0xab020020, &[(1, u64::MAX), (2, 1)], 0); // adds x0, x1, x2
    assert_eq!((c.x[0], c.nzcv), (0, Z | C));
    let c = one(0x6b020020, &[(1, 0), (2, 1)], 0); // subs w0, w1, w2
    assert_eq!((c.x[0], c.nzcv), (0xffff_ffff, N));
    let c = one(0x2b020020, &[(1, 0x7fff_ffff), (2, 1)], 0); // adds w0, w1, w2
    assert_eq!((c.x[0], c.nzcv), (0x8000_0000, N | V));
    let c = one(0x914043e0, &[(31, 0x1000)], 0); // add x0, sp, #16, lsl #12
    assert_eq!(c.x[0], 0x11000);
    let c = one(0x8b22c820, &[(1, 100), (2, 0xffff_ffff)], 0); // add x0, x1, w2, sxtw #2
    assert_eq!(c.x[0], 96);
    let c = one(0x9a020020, &[(1, 1), (2, 2)], C); // adc x0, x1, x2
    assert_eq!(c.x[0], 4);
    let c = one(0x5a020020, &[(1, 5), (2, 3)], 0); // sbc w0, w1, w2
    assert_eq!(c.x[0], 1);
}

#[test]
fn logical_and_move() {
    let c = one(0x92089c20, &[(1, u64::MAX)], 0); // and x0, x1, #0xff00ff00ff00ff00
    assert_eq!(c.x[0], 0xff00_ff00_ff00_ff00);
    let c = one(0x3200f3e0, &[(0, u64::MAX)], 0); // orr w0, wzr, #0x55555555
    assert_eq!(c.x[0], 0x5555_5555);
    let c = one(0xea020020, &[(1, 0xf0), (2, 0x0f)], C | V); // ands x0, x1, x2
    assert_eq!((c.x[0], c.nzcv), (0, Z));
    let c = one(0x8a221020, &[(1, 0xff), (2, 0xf)], 0); // bic x0, x1, x2, lsl #4
    assert_eq!(c.x[0], 0x0f);
    assert_eq!(one(0xd2c24680, &[], 0).x[0], 0x1234_0000_0000); // movz x0, #0x1234, lsl #32
    let c = one(0xf297dde0, &[(0, 0x1234_0000_0000)], 0); // movk x0, #0xbeef
    assert_eq!(c.x[0], 0x1234_0000_beef);
    assert_eq!(one(0x12800001, &[], 0).x[1], 0xffff_ffff); // movn w1, #0
}

#[test]
fn bitfield_and_extract() {
    let x1 = |insn, x0, x1| one(insn, &[(0, x0), (1, x1)], 0).x[0];
    assert_eq!(x1(0xd3483c20, 0, 0x1234_5678), 0x56); // ubfx x0, x1, #8, #8
    assert_eq!(x1(0x93441c20, 0, 0xf0), u64::MAX); // sbfx x0, x1, #4, #4
    assert_eq!(x1(0xb3780c20, 0xffff, 5), 0xf5ff); // bfi x0, x1, #8, #4
    assert_eq!(x1(0x13047c20, 0, 0x8000_0000), 0xf800_0000); // asr w0, w1, #4
    assert_eq!(x1(0x93407c20, 0, 0x8000_0000), 0xffff_ffff_8000_0000); // sxtw x0, w1
    assert_eq!(x1(0xd3440c20, 0, 0x1f), 0xf000_0000_0000_0000); // lsl x0, x1, #60
    let c = one(0x93c22020, &[(1, 0x11), (2, 0x2233)], 0); // extr x0, x1, x2, #8
    assert_eq!(c.x[0], 0x1100_0000_0000_0022);
    // sbfm w0, w0, #0, #0 with N=1: reserved.
    assert_eq!(T::new(&[0x13400000]).step(), Err(Exit::Undefined));
}

#[test]
fn two_and_one_source() {
    let op2 = |insn, a, b| one(insn, &[(1, a), (2, b)], 0).x[0];
    assert_eq!(op2(0x9ac20820, 100, 0), 0); // udiv x0, x1, x2
    assert_eq!(op2(0x9ac20c20, i64::MIN as u64, u64::MAX), i64::MIN as u64); // sdiv x0, x1, x2
    assert_eq!(op2(0x1ac20c20, 0xffff_fff9, 2), 0xffff_fffd); // sdiv w0, w1, w2: -7 / 2
    assert_eq!(op2(0x9ac22020, 1, 65), 2); // lsl x0, x1, x2
    assert_eq!(op2(0x1ac22c20, 1, 1), 0x8000_0000); // ror w0, w1, w2
    assert_eq!(
        op2(0x1ac24020, 0xffff_ffff, 0x61),
        !0xe8b7_be43 & 0xffff_ffff
    ); // crc32b: "a"
    assert_eq!(
        op2(0x1ac25020, 0xffff_ffff, 0x61),
        !0xc1d0_4330 & 0xffff_ffff
    ); // crc32cb: "a"
    let op1 = |insn, a| one(insn, &[(1, a)], 0).x[0];
    assert_eq!(op1(0x5ac00020, 1), 0x8000_0000); // rbit w0, w1
    assert_eq!(
        op1(0xdac00c20, 0x0102_0304_0506_0708),
        0x0807_0605_0403_0201
    ); // rev x0, x1
    assert_eq!(op1(0x5ac00420, 0x1122_3344), 0x2211_4433); // rev16 w0, w1
    assert_eq!(
        op1(0xdac00820, 0x0102_0304_0506_0708),
        0x0403_0201_0807_0605
    ); // rev32 x0, x1
    assert_eq!(op1(0xdac01020, 1), 63); // clz x0, x1
    assert_eq!(op1(0x5ac01420, 0), 31); // cls w0, w1
    assert_eq!(op1(0xdac01420, u64::MAX), 63); // cls x0, x1
}

#[test]
fn three_source() {
    let op3 = |insn, a, b, c| one(insn, &[(1, a), (2, b), (3, c)], 0).x[0];
    assert_eq!(op3(0x9b020c20, 3, 4, 5), 17); // madd x0, x1, x2, x3
    assert_eq!(op3(0x1b028c20, 3, 4, 5), 0xffff_fff9); // msub w0, w1, w2, w3
    assert_eq!(op3(0x9b227c20, 0xffff_fffe, 3, 0), -6i64 as u64); // smull x0, w1, w2
    assert_eq!(op3(0x9bc27c20, u64::MAX, u64::MAX, 0), u64::MAX - 1); // umulh x0, x1, x2
    assert_eq!(op3(0x9b427c20, u64::MAX, u64::MAX, 0), 0); // smulh x0, x1, x2
    assert_eq!(op3(0x9ba20c20, 0xffff_ffff, 2, 1), 0x1_ffff_ffff); // umaddl x0, w1, w2, x3
}

#[test]
fn conditional() {
    // ccmp x1, x2, #5, eq
    assert_eq!(one(0xfa420025, &[(1, 5), (2, 5)], 0).nzcv, Z | V);
    assert_eq!(one(0xfa420025, &[(1, 5), (2, 5)], Z).nzcv, Z | C);
    assert_eq!(one(0x1a9f17e0, &[], Z).x[0], 1); // cset w0, eq
    assert_eq!(one(0x1a9f17e0, &[], 0).x[0], 0);
    // csneg x0, x1, x2, ne with Z set: -x2.
    assert_eq!(one(0xda821420, &[(1, 9), (2, 5)], Z).x[0], -5i64 as u64);
}

#[test]
fn branches() {
    // mov x1, #0; loop: add x1, x1, #2; subs x0, x0, #1; b.ne loop
    let t = T::new(&[0xd2800001, 0x91000821, 0xf1000400, 0x54ffffc1])
        .x(0, 5)
        .run();
    assert_eq!((t.c.x[0], t.c.x[1]), (0, 10));
    // bl f; b end; f: mov x2, #7; ret; end:
    let t = T::new(&[0x94000002, 0x14000003, 0xd28000e2, 0xd65f03c0]).run();
    assert_eq!((t.c.x[2], t.c.x[30], t.c.pc), (7, CODE + 4, CODE + 16));
    // tbnz x3, #40, .+8; mov x4, #1; cbz w5, .+8; mov x6, #1
    let prog = [0xb7400043, 0xd2800024, 0x34000045, 0xd2800026];
    let t = T::new(&prog).x(3, 1 << 40).x(5, 1 << 32).run();
    assert_eq!((t.c.x[4], t.c.x[6]), (0, 0));
    let t = T::new(&prog).x(5, 1).run();
    assert_eq!((t.c.x[4], t.c.x[6]), (1, 1));
    // blr x7
    let mut t = T::new(&[0xd63f00e0]).x(7, 0x3000);
    t.step().unwrap();
    assert_eq!((t.c.pc, t.c.x[30]), (0x3000, CODE + 4));
}

#[test]
fn system() {
    // nop; paciasp (a hint-space NOP here)
    let t = T::new(&[0xd503201f, 0xd503233f]).x(30, 0x1234).run();
    assert_eq!(t.c.x[30], 0x1234);
    let mut t = T::new(&[0xd4000841]); // svc #0x42
    assert_eq!((t.step(), t.c.pc), (Err(Exit::Svc(0x42)), CODE));
    assert_eq!(one(0xd53b4200, &[], N | V).x[0], N | V); // mrs x0, nzcv
    assert_eq!(one(0xd51b4201, &[(1, u64::MAX)], 0).nzcv, 0xf000_0000); // msr nzcv, x1
    assert_eq!(T::new(&[0]).step(), Err(Exit::Undefined)); // udf #0
    // mrs x0, midr_el1: an EL1 register, UNDEFINED at EL0 (Linux emulates it).
    assert_eq!(T::new(&[0xd5380000]).step(), Err(Exit::Undefined));
}

#[test]
fn load_store_single() {
    // str x1, [x2, #8]!
    let t = T::new(&[0xf8008c41]).x(1, 0xdead).x(2, DATA).run();
    assert_eq!((t.rd(DATA + 8, 8), t.c.x[2]), (0xdead, DATA + 8));
    // ldr w0, [x2], #4
    let t = T::new(&[0xb8404440])
        .x(2, DATA)
        .mem(DATA, 8, 0x1_2345_6789)
        .run();
    assert_eq!((t.c.x[0], t.c.x[2]), (0x2345_6789, DATA + 4));
    // ldrsb x0, [x2]; ldrsh w0, [x2]
    let t = T::new(&[0x39800040]).x(2, DATA).mem(DATA, 2, 0xff80).run();
    assert_eq!(t.c.x[0], 0xffff_ffff_ffff_ff80);
    let t = T::new(&[0x79c00040]).x(2, DATA).mem(DATA, 2, 0xff80).run();
    assert_eq!(t.c.x[0], 0xffff_ff80);
    // ldr x0, [x2, x3, lsl #3]; ldr x0, [x2, w3, sxtw]
    let t = T::new(&[0xf8637840])
        .x(2, DATA)
        .x(3, 2)
        .mem(DATA + 16, 8, 77)
        .run();
    assert_eq!(t.c.x[0], 77);
    let t = T::new(&[0xf863c840])
        .x(2, DATA + 8)
        .x(3, 0xffff_fff8)
        .mem(DATA, 8, 78)
        .run();
    assert_eq!(t.c.x[0], 78);
    // ldur w0, [x2, #-1]; ldtr x0, [x2, #8]
    let t = T::new(&[0xb85ff040])
        .x(2, DATA + 1)
        .mem(DATA, 8, 0x5566_7788)
        .run();
    assert_eq!(t.c.x[0], 0x5566_7788);
    let t = T::new(&[0xf8408840]).x(2, DATA).mem(DATA + 8, 8, 79).run();
    assert_eq!(t.c.x[0], 79);
    // ldr x0, .+8 (literal)
    let mut t = T::new(&[0x58000040, 0xd503201f, 0x5566_7788, 0x1122_3344]);
    t.step().unwrap();
    assert_eq!(t.c.x[0], 0x1122_3344_5566_7788);
    // dc zva, x2 zeroes the aligned 64-byte block.
    let t = T::new(&[0xd50b7422])
        .x(2, DATA + 0x10)
        .mem(DATA, 8, 1)
        .mem(DATA + 0x38, 8, 1);
    let t = t.mem(DATA + 0x40, 8, 1).run();
    assert_eq!(
        (t.rd(DATA, 8), t.rd(DATA + 0x38, 8), t.rd(DATA + 0x40, 8)),
        (0, 0, 1)
    );
}

#[test]
fn load_store_pair() {
    // stp x1, x2, [sp, #-16]!; ldp x3, x4, [sp], #16
    let t = T::new(&[0xa9bf0be1, 0xa8c113e3])
        .x(31, 0x3000)
        .x(1, 1)
        .x(2, 2)
        .run();
    assert_eq!((t.rd(0x2ff0, 8), t.rd(0x2ff8, 8)), (1, 2));
    assert_eq!((t.c.x[3], t.c.x[4], t.c.x[31]), (1, 2, 0x3000));
    // ldpsw x3, x4, [x2]
    let t = T::new(&[0x69401043])
        .x(2, DATA)
        .mem(DATA, 8, 0x5_ffff_fffe)
        .run();
    assert_eq!((t.c.x[3], t.c.x[4]), (-2i64 as u64, 5));
}

#[test]
fn exclusives() {
    let (ldxr, stxr, clrex) = (0xc85f7c40, 0xc8037c41, 0xd5033f5f); // x0/x1/w3, [x2]
    let t = T::new(&[ldxr, stxr])
        .x(1, 9)
        .x(2, DATA)
        .x(3, 7)
        .mem(DATA, 8, 5)
        .run();
    assert_eq!((t.c.x[0], t.c.x[3], t.rd(DATA, 8)), (5, 0, 9));
    let t = T::new(&[stxr]).x(1, 9).x(2, DATA).mem(DATA, 8, 5).run();
    assert_eq!((t.c.x[3], t.rd(DATA, 8)), (1, 5));
    let t = T::new(&[ldxr, clrex, stxr]).x(1, 9).x(2, DATA).run();
    assert_eq!((t.c.x[3], t.rd(DATA, 8)), (1, 0));
    // stxr w3, w1, [x2] after a 64-bit ldxr: size mismatch fails.
    let t = T::new(&[ldxr, 0x88037c41]).x(1, 9).x(2, DATA).run();
    assert_eq!(t.c.x[3], 1);
    // Memory changed between ldxr and stxr: the compare-and-swap fails.
    let mut t = T::new(&[ldxr, stxr]).x(1, 9).x(2, DATA);
    t.step().unwrap();
    t.r.mem.write(DATA, 8, 4).unwrap();
    t.step().unwrap();
    assert_eq!((t.c.x[3], t.rd(DATA, 8)), (1, 4));
    // ldxp x0, x1, [x2]; stxp w3, x4, x5, [x2]
    let t = T::new(&[0xc87f0440, 0xc8231444]).x(2, DATA).x(4, 7).x(5, 8);
    let t = t.mem(DATA, 8, 1).mem(DATA + 8, 8, 2).run();
    assert_eq!((t.c.x[0], t.c.x[1], t.c.x[3]), (1, 2, 0));
    assert_eq!((t.rd(DATA, 8), t.rd(DATA + 8, 8)), (7, 8));
    // ldaxp w0, w1, [x2]; stlxp w3, w4, w5, [x2]
    let t = T::new(&[0x887f8440, 0x88239444]).x(2, DATA).x(4, 7).x(5, 8);
    let t = t.mem(DATA, 8, 0x2_0000_0001).x(3, 5).run();
    assert_eq!(
        (t.c.x[0], t.c.x[1], t.c.x[3], t.rd(DATA, 8)),
        (1, 2, 0, 0x8_0000_0007)
    );
    // ldar w0, [x2]; stlr x1, [x2]
    let t = T::new(&[0x88dffc40, 0xc89ffc41])
        .x(1, 3)
        .x(2, DATA)
        .mem(DATA, 8, 0x1_0000_0002);
    let t = t.run();
    assert_eq!((t.c.x[0], t.rd(DATA, 8)), (2, 3));
}

#[test]
fn lse() {
    let cas = 0xc8a07c41; // cas x0, x1, [x2]
    let t = T::new(&[cas])
        .x(0, 5)
        .x(1, 9)
        .x(2, DATA)
        .mem(DATA, 8, 5)
        .run();
    assert_eq!((t.c.x[0], t.rd(DATA, 8)), (5, 9));
    let t = T::new(&[cas])
        .x(0, 5)
        .x(1, 9)
        .x(2, DATA)
        .mem(DATA, 8, 6)
        .run();
    assert_eq!((t.c.x[0], t.rd(DATA, 8)), (6, 6));
    // casb w0, w1, [x2]: compares the low byte only.
    let t = T::new(&[0x08a07c41])
        .x(0, 0x105)
        .x(1, 0x1ff)
        .x(2, DATA)
        .mem(DATA, 2, 0x3305)
        .run();
    assert_eq!((t.c.x[0], t.rd(DATA, 2)), (5, 0x33ff));
    // casp x0, x1, x4, x5, [x2]
    let t = T::new(&[0x48207c44])
        .x(0, 1)
        .x(1, 2)
        .x(4, 7)
        .x(5, 8)
        .x(2, DATA);
    let t = t.mem(DATA, 8, 1).mem(DATA + 8, 8, 2).run();
    assert_eq!(
        (t.c.x[0], t.c.x[1], t.rd(DATA, 8), t.rd(DATA + 8, 8)),
        (1, 2, 7, 8)
    );
    let rmw = |insn, size, old: u64, v: u64| {
        let t = T::new(&[insn]).x(1, v).x(2, DATA).mem(DATA, 8, old).run();
        (t.c.x[0], t.rd(DATA, size))
    };
    assert_eq!(rmw(0xb8210040, 4, 0xffff_ffff, 2), (0xffff_ffff, 1)); // ldadd w1, w0, [x2]
    let (m5, m3) = (-5i64 as u64, -3i64 as u64);
    assert_eq!(rmw(0xf8214040, 8, m5, m3), (m5, m3)); // ldsmax x1, x0, [x2]
    assert_eq!(rmw(0x38218040, 2, 0x4412, 0x1ff), (0x12, 0x44ff)); // swpb w1, w0, [x2]
    assert_eq!(rmw(0xf8211040, 8, 0xff, 0x0f), (0xff, 0xf0)); // ldclr x1, x0, [x2]
    assert_eq!(rmw(0x78217040, 2, 0x8000, 0x7fff), (0x8000, 0x7fff)); // lduminh w1, w0, [x2]
}

fn fault(addr: u64, access: Access, kind: FaultKind) -> R {
    Err(Exit::Fault(Fault { addr, access, kind }))
}

#[test]
fn faults_leave_state_alone() {
    let mut t = T::new(&[0xf9400120]).x(9, 0xffff_0000).x(0, 1); // ldr x0, [x9]
    assert_eq!(t.step(), fault(0xffff_0000, Access::Read, FaultKind::Bus));
    assert_eq!((t.c.x[0], t.c.pc), (1, CODE));
    let mut t = T::new(&[0xc85f7d20]).x(9, DATA + 4); // ldxr x0, [x9]
    assert_eq!(t.step(), fault(DATA + 4, Access::Read, FaultKind::Align));
    // ldp x3, x4, [x9], #16 with the second word out of RAM.
    let a = RAM as u64 - 8;
    let mut t = T::new(&[0xa8c11123]).x(9, a).x(3, 1);
    assert_eq!(t.step(), fault(RAM as u64, Access::Read, FaultKind::Bus));
    assert_eq!((t.c.x[3], t.c.x[9]), (1, a));
    // ldr x0, [sp] with SP misaligned: SP alignment fault (SCTLR_EL1.SA0).
    let mut t = T::new(&[0xf94003e0]).x(31, DATA + 8);
    assert_eq!(t.step(), Err(Exit::Trap(0x26 << 26)));
}

/// DATA holds bytes 0, 1, 2, … (mod 256); `seq(k, n)` is the n-byte LE value at DATA + k.
fn seq_mem(t: T) -> T {
    for k in 0..256 {
        t.r.mem.write(DATA + k, 1, k).unwrap();
    }
    t
}

fn seq(k: u64, n: u64) -> u128 {
    (0..n).fold(0, |acc, j| acc | (((k + j) & 0xff) as u128) << (8 * j))
}

fn fp(prog: &[u32]) -> T {
    let mut t = seq_mem(T::new(prog)).x(2, DATA);
    t.c.v = core::array::from_fn(|n| u128::MAX - n as u128);
    t
}

#[test]
fn fp_load_store_single_and_pair() {
    assert_eq!(fp(&[0x3dc00040]).run().c.v[0], seq(0, 16)); // ldr q0, [x2]
    assert_eq!(fp(&[0xbd400441]).run().c.v[1], seq(4, 4)); // ldr s1, [x2, #4]
    let t = fp(&[0x7c5fe443]).run(); // ldr h3, [x2], #-2
    assert_eq!((t.c.v[3], t.c.x[2]), (seq(0, 2), DATA - 2));
    assert_eq!(fp(&[0x3c636844]).x(3, 9).run().c.v[4], 9); // ldr b4, [x2, x3]
    assert_eq!(fp(&[0xfc5f8046]).x(2, DATA + 16).run().c.v[6], seq(8, 8)); // ldur d6, [x2, #-8]
    assert_eq!(fp(&[0x9c000007]).run().c.v[7], 0x9c000007); // ldr q7, . (itself, then zeros)
    let t = fp(&[0xfc008c41]).run(); // str d1, [x2, #8]!
    assert_eq!(
        (t.rd(DATA + 8, 8), t.rd(DATA + 16, 1), t.c.x[2]),
        (!1, 16, DATA + 8)
    );
    let t = fp(&[0x3ca37845]).x(3, 1).run(); // str q5, [x2, x3, lsl #4]
    assert_eq!((t.rd(DATA + 16, 8), t.rd(DATA + 24, 8)), (!5, u64::MAX));
    let t = fp(&[0xad410440]).run(); // ldp q0, q1, [x2, #32]
    assert_eq!((t.c.v[0], t.c.v[1]), (seq(32, 16), seq(48, 16)));
    let t = fp(&[0x2c810c42]).run(); // stp s2, s3, [x2], #8
    assert_eq!((t.rd(DATA, 8), t.c.x[2]), (0xffff_fffc_ffff_fffd, DATA + 8));
    let t = fp(&[0x6c401444]).run(); // ldnp d4, d5, [x2]
    assert_eq!((t.c.v[4], t.c.v[5]), (seq(0, 8), seq(8, 8)));
}

#[test]
fn fp_load_store_structures() {
    let t = fp(&[0x0cdf8440]).run(); // ld2 {v0.4h, v1.4h}, [x2], #16
    assert_eq!(t.c.v[0], 0x0d0c_0908_0504_0100);
    assert_eq!((t.c.v[1], t.c.x[2]), (0x0f0e_0b0a_0706_0302, DATA + 16));
    let t = fp(&[0x4c40085e]).run(); // ld4 {v30.4s, v31.4s, v0.4s, v1.4s}, [x2]
    let lanes = |k: u64| (0..4).fold(0u128, |a, e| a | seq(k + 16 * e, 4) << (32 * e));
    assert_eq!(
        [t.c.v[30], t.c.v[31], t.c.v[0], t.c.v[1]],
        [lanes(0), lanes(4), lanes(8), lanes(12)]
    );
    let t = fp(&[0x4c836c40]).x(3, 100).run(); // st1 {v0.2d, v1.2d, v2.2d}, [x2], x3
    assert_eq!(
        (t.rd(DATA + 16, 8), t.rd(DATA + 32, 8), t.c.x[2]),
        (!1, !2, DATA + 100)
    );
    let t = fp(&[0x0d40b040]).run(); // ld3 {v0.s, v1.s, v2.s}[1], [x2]
    assert_eq!(
        t.c.v[1],
        (u128::MAX - 1) & !(0xffff_ffff << 32) | seq(4, 4) << 32
    );
    let t = fp(&[0x4d9f8440]).run(); // st1 {v0.d}[1], [x2], #8
    assert_eq!(
        (t.rd(DATA, 8), t.rd(DATA + 8, 1), t.c.x[2]),
        (u64::MAX, 8, DATA + 8)
    );
    let t = fp(&[0x4d40c440]).run(); // ld1r {v0.8h}, [x2]
    assert_eq!(t.c.v[0], 0x0100_0100_0100_0100_0100_0100_0100_0100);
    let t = fp(&[0x0dffe840]).run(); // ld4r {v0.2s, v1.2s, v2.2s, v3.2s}, [x2], #16
    assert_eq!(
        (t.c.v[3], t.c.x[2]),
        (seq(12, 4) * 0x1_0000_0001, DATA + 16)
    );
    assert_eq!(fp(&[0x0c407c40]).run().c.v[0], seq(0, 8)); // ld1 {v0.1d}, [x2]
    // ld4 {v0.16b-v3.16b}, [x2] and ld1 {v0.16b-v3.16b}, [x2] with the last
    // bytes past RAM: the fault leaves every register as it was.
    for insn in [0x4c400040, 0x4c402040] {
        let mut t = fp(&[insn]).x(2, RAM as u64 - 63);
        let before = t.c.v;
        assert_eq!(t.step(), fault(RAM as u64, Access::Read, FaultKind::Bus));
        assert!(t.c.v == before, "{insn:#x} wrote registers");
    }
    let t = fp(&[0x4c402040]).run(); // ld1 {v0.16b-v3.16b}, [x2]: v4 untouched
    assert_eq!([t.c.v[3], t.c.v[4]], [seq(48, 16), u128::MAX - 4]);
    // ld2 {v0.1d, v1.1d}: size 3 with Q=0 and more than one element per structure is reserved.
    assert_eq!(fp(&[0x0c408c40]).step(), Err(Exit::Undefined));
}

#[test]
fn fpcr_fpsr() {
    // msr fpsr, x1; mrs x0, fpcr (after msr fpcr, x1): only the implemented bits stick.
    let t = T::new(&[0xd51b4421]).x(1, u64::MAX).run();
    assert_eq!(t.c.fpsr, 0x0800_009f);
    let t = T::new(&[0xd51b4401, 0xd53b4400]).x(1, u64::MAX).run();
    assert_eq!(t.c.x[0], 0x07c0_0000);
}

#[test]
fn simd_moves() {
    // V0 is 0xcc bytes, V1 bytes 0x80..0x8f, X1 0x1122334455667788.
    let cc = u128::from_le_bytes([0xcc; 16]);
    let v1 = u128::from_le_bytes(core::array::from_fn(|k| 0x80 + k as u8));
    let run = |insn| {
        let mut t = T::new(&[insn]).x(1, 0x1122_3344_5566_7788);
        (t.c.v[0], t.c.v[1]) = (cc, v1);
        t.run().c
    };
    let rep = |x: u128, esize: u32| (0..128 / esize).fold(0u128, |a, e| a | x << (e * esize));
    let d1 = 0x8f8e_8d8c_8b8a_8988u64;
    let d0 = 0x8786_8584_8382_8180u64;
    for (insn, want) in [
        (0x4e0e0420, rep(0x8786, 16)),       // dup v0.8h, v1.h[3]
        (0x5e180420, d1 as u128),            // dup d0, v1.d[1]
        (0x0e040c20, 0x5566_7788_5566_7788), // dup v0.2s, w1
        (0x4e141c20, cc & !(0xffff_ffff << 64) | 0x5566_7788 << 64), // mov v0.s[2], w1
        (0x6e037420, cc & !0xff00 | 0x8e00), // mov v0.b[1], v1.b[14]
        (0x4f054560, rep(0x00ab_0000, 32)),  // movi v0.4s, #0xab, lsl #16
        (0x2f00c640, 0xffff_ed00_ffff_ed00), // mvni v0.2s, #0x12, msl #8
        (0x4f00b420, rep(0xcdcc, 16)),       // orr v0.8h, #0x1, lsl #8
        (0x2f0717e0, 0xcccc_cc00_cccc_cc00), // bic v0.2s, #0xff
        (0x2f05e540, 0xff00_ff00_ff00_ff00), // movi d0, #0xff00ff00ff00ff00
        (0x4f02e740, rep(0x5a, 8)),          // movi v0.16b, #0x5a
        (0x4f03f600, rep(0x3f80_0000, 32)),  // fmov v0.4s, #1.0
        (0x6f07f400, rep(0xbfe0_0000_0000_0000, 64)), // fmov v0.2d, #-0.5
        (0x1e270020, 0x5566_7788),           // fmov s0, w1
        (0x9eaf0020, cc as u64 as u128 | 0x1122_3344_5566_7788 << 64), // fmov v0.d[1], x1
        (0x1e604020, d0 as u128),            // fmov d0, d1
        (0x1e209000, 0x4020_0000),           // fmov s0, #2.5
        (0x1e77f000, 0xc03f_0000_0000_0000), // fmov d0, #-31.0
    ] {
        assert_eq!(run(insn).v[0], want, "{insn:#010x}");
    }
    for (insn, want) in [
        (0x4e1f2c20, 0xffff_ffff_ffff_ff8f), // smov x0, v1.b[15]
        (0x0e063c20, 0x8382),                // umov w0, v1.h[1]
        (0x4e183c20, d1),                    // mov x0, v1.d[1]
        (0x9e660020, d0),                    // fmov x0, d1
        (0x9eae0020, d1),                    // fmov x0, v1.d[1]
    ] {
        assert_eq!(run(insn).x[0], want, "{insn:#010x}");
    }
    // fmov h0, w1 (FEAT_FP16) and umov w0, v1.d[0] are UNDEFINED.
    for insn in [0x1ee70020, 0x0e083c20] {
        assert_eq!(T::new(&[insn]).step(), Err(Exit::Undefined), "{insn:#010x}");
    }
}

/// A vector from `esize`-bit lanes, lane 0 first.
fn vl(esize: u32, lanes: &[u64]) -> u128 {
    lanes.iter().enumerate().fold(0, |v, (e, &x)| {
        v | ((x as u128) & ((1u128 << esize) - 1)) << (e as u32 * esize)
    })
}

/// One instruction with V register inputs; returns the CPU after it.
fn vone(insn: u32, regs: &[(usize, u128)]) -> Cpu {
    let mut t = T::new(&[insn]);
    for &(n, v) in regs {
        t.c.v[n] = v;
    }
    t.run().c
}

const QC: u64 = 1 << 27;

#[test]
fn simd_three_same() {
    let c = vone(
        0x4e220c20,
        &[
            (1, vl(8, &[0x7f, 0x80, 0x10])),
            (2, vl(8, &[1, 0xff, 0x20])),
        ],
    ); // sqadd v0.16b
    assert_eq!((c.v[0], c.fpsr), (vl(8, &[0x7f, 0x80, 0x30]), QC));
    let c = vone(
        0x6e622c20,
        &[(1, vl(16, &[5, 0xffff])), (2, vl(16, &[7, 1]))],
    ); // uqsub v0.8h
    assert_eq!((c.v[0], c.fpsr), (vl(16, &[0, 0xfffe]), QC));
    assert_eq!(vone(0x7ee23420, &[(1, 2), (2, 1)]).v[0], u64::MAX as u128); // cmhi d0, d1, d2
    let c = vone(
        0x4ea25420, // srshl v0.4s, v1.4s, v2.4s
        &[
            (1, vl(32, &[0x10, (-5i32) as u64, 1, 0x4000_0000])),
            (2, vl(32, &[0xfd, 0xff, 31, 1])),
        ],
    );
    assert_eq!(c.v[0], vl(32, &[2, 0xffff_fffe, 0x8000_0000, 0x8000_0000]));
    let c = vone(
        0x4e62b420,
        &[
            (1, vl(16, &[0x8000, 0x4000])),
            (2, vl(16, &[0x8000, 0x4000])),
        ],
    ); // sqdmulh v0.8h
    assert_eq!((c.v[0], c.fpsr), (vl(16, &[0x7fff, 0x2000]), QC));
    let c = vone(
        0x4ea2bc20,
        &[(1, vl(32, &[1, 2, 3, 4])), (2, vl(32, &[10, 20, 30, 40]))],
    ); // addp v0.4s
    assert_eq!(c.v[0], vl(32, &[3, 7, 30, 70]));
    let bytes = |b: u8| u128::from_le_bytes([b; 16]);
    let c = vone(
        0x6e621c20,
        &[
            (0, vl(16, &[0x00ff; 8])),
            (1, bytes(0xaa)),
            (2, bytes(0x55)),
        ],
    ); // bsl
    assert_eq!(c.v[0], vl(16, &[0x55aa; 8]));
    let c = vone(
        0x2e229c20,
        &[(0, u128::MAX), (1, vl(8, &[3, 0x80])), (2, vl(8, &[3, 2]))],
    ); // pmul v0.8b
    assert_eq!(c.v[0], vl(8, &[5, 0]));
}

#[test]
fn simd_three_different_and_by_element() {
    let c = vone(
        0x6ea2c020, // umull2 v0.2d, v1.4s, v2.4s
        &[
            (1, vl(32, &[0, 0, 0xffff_ffff, 2])),
            (2, vl(32, &[0, 0, 0xffff_ffff, 3])),
        ],
    );
    assert_eq!(c.v[0], vl(64, &[0xffff_fffe_0000_0001, 6]));
    let c = vone(
        0x0e629020, // sqdmlal v0.4s, v1.4h, v2.4h
        &[
            (0, vl(32, &[1, 0x7fff_ffff])),
            (1, vl(16, &[2, 0x8000])),
            (2, vl(16, &[3, 0x8000])),
        ],
    );
    assert_eq!((c.v[0], c.fpsr), (vl(32, &[13, 0x7fff_ffff]), QC));
    let c = vone(
        0x6e224020,
        &[(0, vl(64, &[0x1111, 7])), (1, vl(16, &[0x1280, 0xff80]))],
    ); // raddhn2 v0.16b
    assert_eq!(c.v[0], vl(64, &[0x1111, 0x13]));
    assert_eq!(vone(0x0e22e020, &[(1, 0xff), (2, 0xff)]).v[0], 0x5555); // pmull v0.8h, v1.8b, v2.8b
    let c = vone(
        0x6f720820,
        &[
            (0, vl(16, &[1; 8])),
            (1, vl(16, &[1, 2, 3, 4, 5, 6, 7, 8])),
            (2, 3 << 112),
        ],
    ); // mla v0.8h, v1.8h, v2.h[7]
    assert_eq!(c.v[0], vl(16, &[4, 7, 10, 13, 16, 19, 22, 25]));
    let c = vone(
        0x4fa2b820, // sqdmull2 v0.2d, v1.4s, v2.s[3]
        &[
            (1, vl(32, &[0, 0, 0x8000_0000, 2])),
            (2, vl(32, &[0, 0, 0, 0x8000_0000])),
        ],
    );
    assert_eq!(
        (c.v[0], c.fpsr),
        (vl(64, &[i64::MAX as u64, 0xffff_fffe_0000_0000]), QC)
    );
}

#[test]
fn simd_two_misc_and_across() {
    let c = vone(
        0x0e204820,
        &[(0, u128::MAX), (1, vl(8, &[0, 0xff, 1, 0x80, 0x3f]))],
    ); // cls v0.8b
    assert_eq!(c.v[0], vl(8, &[7, 7, 6, 0, 1, 7, 7, 7]));
    let c = vone(
        0x6e606820,
        &[
            (0, vl(32, &[1, 2, 3, 4])),
            (1, vl(16, &[0xffff, 0xffff, 1, 2])),
        ],
    ); // uadalp v0.4s
    assert_eq!(c.v[0], vl(32, &[0x1ffff, 5, 3, 4]));
    let c = vone(
        0x2e212820,
        &[(0, u128::MAX), (1, vl(16, &[0xffff, 0x100, 0x7f, 0x7fff]))],
    ); // sqxtun v0.8b
    assert_eq!((c.v[0], c.fpsr), (vl(8, &[0, 0xff, 0x7f, 0xff]), QC));
    let c = vone(0x6e600820, &[(1, vl(16, &[1, 2, 3, 4, 5, 6, 7, 8]))]); // rev32 v0.8h
    assert_eq!(c.v[0], vl(16, &[2, 1, 4, 3, 6, 5, 8, 7]));
    assert_eq!(vone(0x5ee0b820, &[(1, (-5i64) as u64 as u128)]).v[0], 5); // abs d0, d1
    assert_eq!(vone(0x6e703820, &[(1, u128::MAX)]).v[0], 0x7fff8); // uaddlv s0, v1.8h
    assert_eq!(vone(0x4e31a820, &[(1, vl(8, &[5, 0x80, 0x7f]))]).v[0], 0x80); // sminv b0, v1.16b
}

#[test]
fn simd_shift_immediate() {
    let c = vone(0x4f7f2420, &[(1, vl(64, &[3, (-3i64) as u64]))]); // srshr v0.2d, v1.2d, #1
    assert_eq!(c.v[0], vl(64, &[2, u64::MAX]));
    let c = vone(
        0x6f384420,
        &[
            (0, vl(32, &[0xaabb_ccdd; 4])),
            (1, vl(32, &[0x1122_3344; 4])),
        ],
    ); // sri v0.4s, v1.4s, #8
    assert_eq!(c.v[0], vl(32, &[0xaa11_2233; 4]));
    let c = vone(0x7f0b6420, &[(1, 0x20)]); // sqshlu b0, b1, #3
    assert_eq!((c.v[0], c.fpsr), (0xff, QC));
    let c = vone(
        0x4f1c9c20, // sqrshrn2 v0.8h, v1.4s, #4
        &[
            (0, 0x1234),
            (1, vl(32, &[0x18, 0x7fff_ffff, 0xffff_fff8, 0x8000_0000])),
        ],
    );
    assert_eq!(
        (c.v[0], c.fpsr),
        (vl(64, &[0x1234, 0x8000_0000_7fff_0002]), QC)
    );
    let c = vone(0x2f27a420, &[(1, vl(32, &[1, 0xffff_ffff]))]); // ushll v0.2d, v1.2s, #7
    assert_eq!(c.v[0], vl(64, &[0x80, 0x7f_ffff_ff80]));
}

#[test]
fn simd_permute_ext_table() {
    let (a, b) = (vl(32, &[1, 2, 3, 4]), vl(32, &[5, 6, 7, 8]));
    assert_eq!(
        vone(0x4e827820, &[(1, a), (2, b)]).v[0],
        vl(32, &[3, 7, 4, 8])
    ); // zip2 v0.4s
    let seq = |k: u8| u128::from_le_bytes(core::array::from_fn(|j| k + j as u8));
    let c = vone(0x0e021820, &[(1, seq(0)), (2, seq(16))]); // uzp1 v0.8b
    assert_eq!(c.v[0], vl(8, &[0, 2, 4, 6, 16, 18, 20, 22]));
    let c = vone(
        0x4e426820,
        &[
            (1, vl(16, &[0, 1, 2, 3, 4, 5, 6, 7])),
            (2, vl(16, &[10, 11, 12, 13, 14, 15, 16, 17])),
        ],
    ); // trn2 v0.8h
    assert_eq!(c.v[0], vl(16, &[1, 11, 3, 13, 5, 15, 7, 17]));
    assert_eq!(vone(0x6e021820, &[(1, seq(0)), (2, seq(16))]).v[0], seq(3)); // ext v0.16b, #3
    let c = vone(
        0x4e032020,
        &[
            (1, seq(0x40)),
            (2, seq(0x60)),
            (3, vl(8, &[0, 17, 31, 32, 255])),
        ],
    ); // tbl
    assert_eq!(
        c.v[0],
        vl(
            8,
            &[
                0x40, 0x61, 0x6f, 0, 0, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40,
                0x40
            ]
        )
    );
    let c = vone(
        0x0e031020,
        &[
            (0, u128::from_le_bytes([0xcc; 16])),
            (1, seq(0x40)),
            (3, vl(8, &[1, 16, 15, 200])),
        ],
    ); // tbx v0.8b
    assert_eq!(
        c.v[0],
        vl(8, &[0x41, 0xcc, 0x4f, 0xcc, 0x40, 0x40, 0x40, 0x40])
    );
}

#[test]
fn simd_float() {
    let s = |xs: &[f32]| {
        vl(
            32,
            &xs.iter().map(|x| x.to_bits() as u64).collect::<Vec<_>>(),
        )
    };
    let d = |xs: &[f64]| vl(64, &xs.iter().map(|x| x.to_bits()).collect::<Vec<_>>());
    const IOC: u64 = 1;
    const OFC: u64 = 4;
    const IXC: u64 = 16;
    let c = vone(
        0x6e22d420,
        &[
            (1, s(&[1.0, 2.0, 3.0, 4.0])),
            (2, s(&[10.0, 20.0, 30.0, 40.0])),
        ],
    ); // faddp v0.4s
    assert_eq!(c.v[0], s(&[3.0, 7.0, 30.0, 70.0]));
    let c = vone(
        0x4fc21820,
        &[
            (0, d(&[1.0, 2.0])),
            (1, d(&[3.0, 4.0])),
            (2, d(&[9.0, 0.5])),
        ],
    ); // fmla v0.2d, v1.2d, v2.d[1]
    assert_eq!(c.v[0], d(&[2.5, 4.0]));
    let c = vone(
        0x6e22e420,
        &[
            (1, s(&[1.0, f32::NAN, 2.0, -0.0])),
            (2, s(&[1.0, 1.0, 3.0, 0.0])),
        ],
    ); // fcmge v0.4s
    assert_eq!(
        (c.v[0], c.fpsr),
        (vl(32, &[0xffff_ffff, 0, 0, 0xffff_ffff]), IOC)
    );
    assert_eq!(vone(0x5ea1d820, &[(1, s(&[1.0]))]).v[0], 0x3f7f_8000); // frecpe s0, s1: 0.998046875
    assert_eq!(vone(0x7ea1d820, &[(1, s(&[4.0]))]).v[0], 0x3eff_8000); // frsqrte s0, s1: 0.4990234375
    let c = vone(0x0ea1c820, &[(1, vl(32, &[0x8000_0000, 0x7fff_ffff]))]); // urecpe v0.2s
    assert_eq!(c.v[0], vl(32, &[0xff80_0000, 0xffff_ffff]));
    let c = vone(
        0x4e216820,
        &[(0, 0x1234), (1, s(&[1.0, -2.0, 131008.0, 0.5]))],
    ); // fcvtn2 v0.8h, v1.4s
    assert_eq!(
        (c.v[0], c.fpsr),
        (vl(64, &[0x1234, 0x3800_7c00_c000_3c00]), OFC | IXC)
    );
    assert_eq!(
        vone(0x0e617820, &[(1, s(&[1.5, -0.25]))]).v[0],
        d(&[1.5, -0.25])
    ); // fcvtl v0.2d, v1.2s
    let c = vone(0x7e616820, &[(1, d(&[1.0 + 2f64.powi(-40)]))]); // fcvtxn s0, d1: round to odd
    assert_eq!((c.v[0], c.fpsr), (0x3f80_0001, IXC));
    let c = vone(0x4f3ffc20, &[(1, s(&[1.25, -1.75, 1e10, f32::NAN]))]); // fcvtzs v0.4s, v1.4s, #1
    assert_eq!(
        (c.v[0], c.fpsr),
        (
            vl(32, &[2, (-3i32) as u32 as u64, 0x7fff_ffff, 0]),
            IOC | IXC
        )
    );
    let c = vone(
        0x4e22fc20,
        &[
            (1, s(&[2.0, f32::INFINITY, 0.0, 1.0])),
            (2, s(&[0.5, 0.0, 3.0, 1.0])),
        ],
    ); // frecps
    assert_eq!((c.v[0], c.fpsr), (s(&[1.0, 2.0, 2.0, 1.0]), 0));
    let c = vone(0x6e30c820, &[(1, s(&[f32::NAN, 1.0, -5.0, 3.0]))]); // fmaxnmv s0, v1.4s
    assert_eq!(c.v[0], s(&[3.0]));
    assert_eq!(
        vone(0x7ee2d420, &[(1, d(&[1.0])), (2, d(&[3.5]))]).v[0],
        d(&[2.5])
    ); // fabd d0, d1, d2
}

// EL1 and the exception model (M3). Vectors at VBAR = 0x8000.

const VBAR: u64 = 0x8000;

impl T {
    /// At EL1h with FP enabled and VBAR set, as a kernel runs.
    fn el1(mut self) -> T {
        let pc = self.c.pc;
        self.c = Cpu {
            pc,
            vbar_el1: VBAR,
            cpacr_el1: 3 << 20,
            ..Cpu::reset()
        };
        self
    }

    /// One step of `run_system` (with a fresh TLB).
    fn sys(&mut self) -> R {
        let mut v = crate::mmu::Vcpu::new(self.c.clone());
        let r = run_system(&mut v, &self.r.mem, 1).1;
        self.c = v.cpu.clone();
        r
    }
}

#[test]
fn svc_from_el0_and_eret_back() {
    use crate::cpu::{DAIF, M_EL1H};
    let mut t = T::new(&[0xd4000841]).x(31, 0x3000).nzcv(Z); // svc #0x42
    t.c.sp_other = 0x7000; // SP_EL1
    t.c.vbar_el1 = VBAR;
    t.sys().unwrap();
    let c = &t.c;
    assert_eq!((c.pc, c.el(), c.pstate), (VBAR + 0x400, 1, M_EL1H | DAIF));
    assert_eq!(
        (c.esr_el1, c.elr_el1, c.spsr_el1),
        (0x5600_0042, CODE + 4, Z)
    );
    assert_eq!((c.x[31], c.sp_other), (0x7000, 0x3000));
    // eret at the vector goes back to EL0 with its SP and flags; it unmasks
    // IRQs, so it ends the chunk (retired) for a pending one to be taken
    // right after it, as an MSR that unmasks does.
    t.r.mem.write(VBAR + 0x400, 4, 0xd69f03e0).unwrap();
    t.c.nzcv = 0;
    let at_vector = t.c.clone();
    assert_eq!(steps(&mut t.c, &t.r.mem, None, 1), (0, Some(Exit::Resync)));
    assert_eq!(
        (t.c.pc, t.c.el(), t.c.nzcv, t.c.x[31]),
        (CODE + 4, 0, Z, 0x3000)
    );
    // With IRQs still masked in SPSR, nothing to resync.
    t.c = at_vector;
    t.c.spsr_el1 |= DAIF;
    assert_eq!(steps(&mut t.c, &t.r.mem, None, 1), (1, None));
    assert_eq!((t.c.pc, t.c.el(), t.c.pstate & DAIF), (CODE + 4, 0, DAIF));
}

#[test]
fn el0_faults_and_traps() {
    let esr = |prog: &[u32], f: fn(&mut Cpu)| {
        let mut t = T::new(prog).x(9, 0xffff_0000);
        t.c.vbar_el1 = VBAR;
        f(&mut t.c);
        t.sys().unwrap();
        assert_eq!((t.c.pc, t.c.elr_el1), (VBAR + 0x400, CODE));
        (t.c.esr_el1, t.c.far_el1)
    };
    let none = |_: &mut Cpu| {};
    assert_eq!(esr(&[0xd5381000], none).0, 0x0200_0000); // mrs x0, sctlr_el1: UNDEFINED
    assert_eq!(esr(&[0xd4000002], none).0, 0x0200_0000); // hvc #0
    assert_eq!(esr(&[0xd69f03e0], none).0, 0x0200_0000); // eret
    assert_eq!(esr(&[0xd51bd060], none).0, 0x0200_0000); // msr tpidrro_el0, x0
    assert_eq!(esr(&[0xd4200060], none).0, 0xf200_0003); // brk #3
    // str x0, [x9] to nothing: data abort from EL0, WnR, external abort.
    assert_eq!(esr(&[0xf9000120], none), (0x9200_0050, 0xffff_0000));
    // fmov d0, x1 with CPACR_EL1.FPEN = 0b01 (EL1 only).
    let fp_el1 = |c: &mut Cpu| c.cpacr_el1 = 1 << 20;
    assert_eq!(esr(&[0x9e670020], fp_el1).0, 0x1fe0_0000);
    assert_eq!(esr(&[0xd53b4400], fp_el1).0, 0x1fe0_0000); // mrs x0, fpcr
    // wfi (Linux leaves nTWI clear), and mrs x0, ctr_el0 without UCT: ISS has
    // op0 3, op2 1, op1 3, CRn 0, Rt 0, CRm 0, read.
    assert_eq!(esr(&[0xd503207f], none).0, 0x07e0_0000);
    let no_uct = |c: &mut Cpu| c.sctlr_el1 &= !crate::cpu::sctlr::UCT;
    assert_eq!(esr(&[0xd53b0020], no_uct).0, 0x6232_c001);
    // A misaligned PC (from br): PC alignment fault with FAR = PC.
    let mut t = T::new(&[0xd61f0120]).x(9, CODE + 2); // br x9
    t.c.vbar_el1 = VBAR;
    t.sys().unwrap();
    t.sys().unwrap();
    assert_eq!(
        (t.c.esr_el1, t.c.far_el1, t.c.elr_el1),
        (0x8a00_0000, CODE + 2, CODE + 2)
    );
}

#[test]
fn el1_registers() {
    let prog = [
        0xd5034fdf, // msr daifset, #15
        0xd50342ff, // msr daifclr, #2
        0xd53b4220, // mrs x0, daif
        0xd5384241, // mrs x1, currentel
        0xd5380402, // mrs x2, id_aa64pfr0_el1
        0xd5380623, // mrs x3, id_aa64isar1_el1 (RAZ)
        0xd5184104, // msr sp_el0, x4
        0xd50040bf, // msr spsel, #0
        0xd53b00e5, // mrs x5, dczid_el0
        0xd508831f, // tlbi vmalle1is
    ];
    let mut t = T::new(&prog).el1().x(4, 0x5000).x(3, 1).x(31, 0x9000);
    for _ in 0..prog.len() {
        t.sys().unwrap();
    }
    let c = &t.c;
    assert_eq!(
        (c.x[0], c.x[1], c.x[2], c.x[3]),
        (0x340, 4, 0x1100_0000_0000_0011, 0)
    );
    assert_eq!(
        (c.x[31], c.sp_other, c.pstate & 0xf, c.x[5]),
        (0x5000, 0x9000, 0b0100, 4)
    );
    // At EL1t, SP_EL0 is SP: MRS SP_EL0 is UNDEFINED, taken to the SP_EL0 vector.
    t.r.mem.write(t.c.pc, 4, 0xd5384100).unwrap(); // mrs x0, sp_el0
    t.end += 4;
    t.sys().unwrap();
    assert_eq!(
        (t.c.pc, t.c.esr_el1, t.c.x[31]),
        (VBAR, 0x0200_0000, 0x9000)
    );
}

#[test]
fn el1_aborts_hvc_and_illegal_return() {
    // Data abort from EL1 (EC 0x25), read.
    let mut t = T::new(&[0xf9400120]).el1().x(9, 0xffff_0000); // ldr x0, [x9]
    t.sys().unwrap();
    assert_eq!(
        (t.c.pc, t.c.esr_el1, t.c.far_el1),
        (VBAR + 0x200, 0x9600_0010, 0xffff_0000)
    );
    // HVC at EL1 goes to the host with the PC after it.
    let mut t = T::new(&[0xd4000002]).el1();
    assert_eq!(t.sys(), Err(Exit::Hvc(0)));
    assert_eq!(t.c.pc, CODE + 4);
    // ERET to EL2h is illegal: stay at EL1, and take an Illegal Execution State
    // exception whose ELR is the return target and whose SPSR has IL.
    let mut t = T::new(&[0xd69f03e0]).el1();
    (t.c.spsr_el1, t.c.elr_el1) = (0b1001 | N, 0x4444);
    t.sys().unwrap();
    let c = &t.c;
    assert_eq!(
        (c.pc, c.esr_el1, c.elr_el1),
        (VBAR + 0x200, 0x3a00_0000, 0x4444)
    );
    assert_eq!(c.spsr_el1, N | crate::cpu::SPSR_IL | 0b0101); // EL1h, D A I F cleared
}

#[test]
fn el1_exceptions_and_eret_state() {
    // Taken from EL1h: UNDEFINED and BRK to VBAR + 0x200 with ELR at the instruction.
    for (insn, esr) in [(0, 0x0200_0000), (0xd4200060, 0xf200_0003)] {
        let mut t = T::new(&[insn]).el1();
        t.sys().unwrap();
        assert_eq!(
            (t.c.pc, t.c.esr_el1, t.c.elr_el1),
            (VBAR + 0x200, esr, CODE)
        );
    }
    // Instruction aborts: br x9 to nothing, from EL1 (EC 0x21) and EL0 (EC 0x20).
    let mut t = T::new(&[0xd61f0120]).el1().x(9, 0xffff_0000);
    t.sys().unwrap();
    t.sys().unwrap();
    assert_eq!(
        (t.c.pc, t.c.esr_el1, t.c.far_el1),
        (VBAR + 0x200, 0x8600_0010, 0xffff_0000)
    );
    let mut t = T::new(&[0xd61f0120]).x(9, 0xffff_0000);
    t.c.vbar_el1 = VBAR;
    t.sys().unwrap();
    t.sys().unwrap();
    assert_eq!(
        (t.c.pc, t.c.esr_el1, t.c.elr_el1),
        (VBAR + 0x400, 0x8200_0010, 0xffff_0000)
    );
    // ERET to EL1t restores NZCV and DAIF and selects SP_EL0.
    let mut t = T::new(&[0xd69f03e0]).el1().x(31, 0x9000);
    t.c.sp_other = 0x5000;
    (t.c.spsr_el1, t.c.elr_el1) = (N | C | 0x80 | 0b0100, 0x4444);
    t.sys().unwrap();
    let c = &t.c;
    assert_eq!(
        (c.pc, c.nzcv, c.pstate, c.x[31], c.sp_other),
        (0x4444, N | C, 0x84, 0x5000, 0x9000)
    );
    // ERET to EL0 with SPSR.IL set: Illegal Execution State taken from EL0.
    let mut t = T::new(&[0xd69f03e0]).el1();
    (t.c.spsr_el1, t.c.elr_el1) = (crate::cpu::SPSR_IL, 0x4444);
    t.sys().unwrap();
    let c = &t.c;
    assert_eq!(
        (c.pc, c.esr_el1, c.elr_el1),
        (VBAR + 0x400, 0x3a00_0000, 0x4444)
    );
    assert_eq!(c.spsr_el1, crate::cpu::SPSR_IL); // from EL0t
    // at s1e1r, x0 with the MMU off: PAR_EL1 is the flat address, Device, outer shareable.
    let mut t = T::new(&[0xd5087800]).el1().x(0, 0x1234_5678);
    t.sys().unwrap();
    assert_eq!(t.c.par_el1, 0x1234_5000 | 2 << 7 | 1 << 11);
}

#[test]
fn el1_register_writes() {
    let prog = [
        0xd5101080, // msr oslar_el1, x0
        0xd5301181, // mrs x1, oslsr_el1
        0xd518101f, // msr sctlr_el1, xzr
        0xd5381002, // mrs x2, sctlr_el1
    ];
    let mut t = T::new(&prog).el1().x(0, 1);
    for _ in 0..prog.len() {
        t.sys().unwrap();
    }
    assert_eq!((t.c.x[1], t.c.x[2]), (0b1010, crate::cpu::sctlr::RES1));
}

#[test]
fn el0_privilege_and_dze() {
    // EL1-only cache maintenance is UNDEFINED at EL0 (op1 = 0).
    for insn in [
        0xd5087620, // dc ivac, x0
        0xd5087640, // dc isw, x0
        0xd5087a40, // dc csw, x0
        0xd5087e40, // dc cisw, x0
        0xd508751f, // ic iallu
        0xd508711f, // ic ialluis
    ] {
        assert_eq!(T::new(&[insn]).step(), Err(Exit::Undefined), "{insn:#x}");
    }
    // Without SCTLR_EL1.DZE: DC ZVA traps, and DCZID_EL0.DZP says so.
    let mut t = T::new(&[0xd50b7420]); // dc zva, x0
    t.c.sctlr_el1 &= !crate::cpu::sctlr::DZE;
    // EC 0x18; ISS op0 1, op2 1, op1 3, CRn 7, Rt 0, CRm 4, write.
    assert_eq!(t.step(), Err(Exit::Trap(0x6012_dc08)));
    let mut t = T::new(&[0xd53b00e0]); // mrs x0, dczid_el0
    t.c.sctlr_el1 &= !crate::cpu::sctlr::DZE;
    t.step().unwrap();
    assert_eq!(t.c.x[0], 0x14);
}

#[test]
fn sctlr_write_switches_interpreter_copy_mid_run() {
    // msr sctlr_el1, x0 (setting A); ldr x1, [x2] misaligned: one run_system call.
    let mut t = T::new(&[0xd5181000, 0xf9400041])
        .el1()
        .x(0, crate::cpu::sctlr::RES1 | crate::cpu::sctlr::A)
        .x(2, DATA + 1);
    let mut v = crate::mmu::Vcpu::new(t.c.clone());
    assert_eq!(run_system(&mut v, &t.r.mem, 2), (2, Ok(())));
    assert_eq!(
        (v.cpu.pc, v.cpu.esr_el1, v.cpu.far_el1),
        (VBAR + 0x200, 0x9600_0021, DATA + 1)
    );
    // step() retires the MSR and reports no exit.
    t.c.pc = CODE;
    assert_eq!(t.step(), Ok(()));
    assert_eq!(t.c.pc, CODE + 4);
}

#[test]
fn v8_0_registers_the_sweep_found() {
    // IMPLEMENTATION DEFINED, debug and reset registers that exist at EL1 when
    // it's the highest EL (M3 step 7): RAZ/WI, or read-only.
    let prog = [
        0xd5381020, // mrs x0, actlr_el1
        0xd5181021, // msr actlr_el1, x1
        0xd538c041, // mrs x1, rmr_el1 (AA64 reads as one)
        0xd538c022, // mrs x2, rvbar_el1
        0xd5301003, // mrs x3, mdrar_el1
        0xd5100641, // msr oseccr_el1, x1
        0xd508751f, // ic iallu
        0xd5087500, // ic iallu with Rt = 0 (should-be-ones)
    ];
    let mut t = T::new(&prog).el1().x(0, 7).x(1, 7).x(2, 7).x(3, 7);
    for _ in 0..prog.len() {
        t.sys().unwrap();
    }
    assert_eq!((t.c.x[0], t.c.x[1], t.c.x[2], t.c.x[3]), (0, 1, 0, 0));
    assert_eq!(t.c.pc, CODE + 4 * prog.len() as u64, "no exception taken");
    // MDRAR_EL1 is read-only: MSR is UNDEFINED.
    let mut t = T::new(&[0xd5101000]).el1();
    t.sys().unwrap();
    assert_eq!((t.c.pc, t.c.esr_el1), (VBAR + 0x200, 0x0200_0000));
}

// The crypto extensions (M6.5): known-answer vectors driven through the
// instructions, one at a time on a CPU carried across them.

/// Runs one instruction on `c`'s vector registers.
fn vx(c: &mut Cpu, insn: u32) {
    let mut t = T::new(&[insn]);
    t.c.v = c.v;
    c.v = t.run().c.v;
}

/// `insn` with Rd, Rn and Rm.
fn rdnm(insn: u32, d: u32, n: u32, m: u32) -> u32 {
    insn | m << 16 | n << 5 | d
}

const AESE: u32 = 0x4e284800;
const AESD: u32 = 0x4e285800;
const AESMC: u32 = 0x4e286800;
const AESIMC: u32 = 0x4e287800;

/// A block written as hex, first byte first (FIPS 197's order).
fn block(s: &str) -> u128 {
    u128::from_be_bytes(u128::from_str_radix(s, 16).unwrap().to_le_bytes())
}

/// FIPS 197 5.2 KeyExpansion (Nk = 4 or 8), SubWord through AESE with a zero
/// state and key (ShiftRows moves nothing when all four columns are equal).
fn expand(key: &[u32]) -> Vec<u128> {
    let nk = key.len();
    let mut w = key.to_vec();
    let mut rcon = 1u32;
    let sub = |x: u32| {
        let mut c = Cpu::default();
        c.v[1] = (x as u128) * (u128::MAX / 0xffff_ffff);
        vx(&mut c, rdnm(AESE, 1, 2, 0));
        c.v[1] as u32
    };
    for i in nk..4 * (nk + 7) {
        let mut t = w[i - 1];
        if i % nk == 0 {
            t = sub(t.rotate_right(8)) ^ rcon;
            rcon = if rcon & 0x80 != 0 {
                (rcon << 1) ^ 0x11b
            } else {
                rcon << 1
            };
        } else if nk > 6 && i % nk == 4 {
            t = sub(t);
        }
        w.push(w[i - nk] ^ t);
    }
    w.chunks(4)
        .map(|q| q.iter().rev().fold(0, |o, &x| o << 32 | x as u128))
        .collect()
}

fn key_words(s: &str) -> Vec<u32> {
    let b = (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect::<Vec<_>>();
    b.chunks(4)
        .map(|w| u32::from_le_bytes(w.try_into().unwrap()))
        .collect()
}

/// Encrypts with AESE/AESMC and decrypts with AESD/AESIMC (the equivalent
/// inverse cipher, round keys through AESIMC), as OpenSSL and Linux do.
fn aes_block(key: &str, pt: &str, ct: &str) {
    let rk = expand(&key_words(key));
    let nr = rk.len() - 1;
    let mut c = Cpu::default();
    c.v[0] = block(pt);
    for (r, k) in rk.iter().enumerate().take(nr) {
        c.v[1] = *k;
        vx(&mut c, rdnm(AESE, 0, 1, 0));
        if r < nr - 1 {
            vx(&mut c, rdnm(AESMC, 0, 0, 0));
        }
    }
    assert_eq!(c.v[0] ^ rk[nr], block(ct), "encrypt with {key}");
    c.v[0] = block(ct);
    for r in (1..=nr).rev() {
        c.v[1] = rk[r];
        if r < nr {
            vx(&mut c, rdnm(AESIMC, 1, 1, 0));
        }
        vx(&mut c, rdnm(AESD, 0, 1, 0));
        if r > 1 {
            vx(&mut c, rdnm(AESIMC, 0, 0, 0));
        }
    }
    assert_eq!(c.v[0] ^ rk[0], block(pt), "decrypt with {key}");
}

#[test]
fn aes_known_answers() {
    // FIPS 197 appendix C.1 and C.3.
    aes_block(
        "000102030405060708090a0b0c0d0e0f",
        "00112233445566778899aabbccddeeff",
        "69c4e0d86a7b0430d8cdb78070b4c55a",
    );
    aes_block(
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        "00112233445566778899aabbccddeeff",
        "8ea2b7ca516745bfeafc49904b496089",
    );
    // FIPS 197 appendix A.1's key; NIST SP 800-38A F.1.1 (ECB-AES128) block 1.
    aes_block(
        "2b7e151628aed2a6abf7158809cf4f3c",
        "6bc1bee22e409f96e93d7e117393172a",
        "3ad77bb40d7a3660a89ecaf32466ef97",
    );
    // SP 800-38A F.1.5 (ECB-AES256) block 1.
    aes_block(
        "603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4",
        "6bc1bee22e409f96e93d7e117393172a",
        "f3eed1bdb5d2a03c064b5a7e3db181f8",
    );
}

const SHA1C: u32 = 0x5e000000;
const SHA1P: u32 = 0x5e001000;
const SHA1M: u32 = 0x5e002000;
const SHA1SU0: u32 = 0x5e003000;
const SHA256H: u32 = 0x5e004000;
const SHA256H2: u32 = 0x5e005000;
const SHA256SU1: u32 = 0x5e006000;
const SHA1H: u32 = 0x5e280800;
const SHA1SU1: u32 = 0x5e281800;
const SHA256SU0: u32 = 0x5e282800;

/// FIPS 180-4 padding into 64-byte blocks of 16 big-endian words.
fn sha_blocks(msg: &[u8]) -> Vec<[u32; 16]> {
    let mut m = msg.to_vec();
    m.push(0x80);
    while m.len() % 64 != 56 {
        m.push(0);
    }
    m.extend_from_slice(&(8 * msg.len() as u64).to_be_bytes());
    m.chunks(64)
        .map(|b| {
            core::array::from_fn(|i| u32::from_be_bytes(b[4 * i..4 * i + 4].try_into().unwrap()))
        })
        .collect()
}

fn quad(w: &[u32]) -> u128 {
    w.iter().rev().fold(0, |o, &x| o << 32 | x as u128)
}

fn add4(a: u128, b: u128) -> u128 {
    quad(
        &(0..4)
            .map(|e| ((a >> (32 * e)) as u32).wrapping_add((b >> (32 * e)) as u32))
            .collect::<Vec<_>>(),
    )
}

/// SHA-1 as Linux's sha1-ce and OpenSSL's sha1-armv8 run it: v0 abcd, v1 e,
/// v2 the round's W + K, v3 the saved e, v4–v7 the message schedule.
fn sha1(msg: &[u8]) -> [u32; 5] {
    let mut h = [
        0x67452301u32,
        0xefcdab89,
        0x98badcfe,
        0x10325476,
        0xc3d2e1f0,
    ];
    const K: [u32; 4] = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6];
    for b in sha_blocks(msg) {
        let mut c = Cpu::default();
        c.v[0] = quad(&h[..4]);
        c.v[1] = h[4] as u128;
        for (q, w) in b.chunks(4).enumerate() {
            c.v[4 + q] = quad(w);
        }
        for i in 0..20u32 {
            let m = 4 + i % 4;
            c.v[2] = add4(
                c.v[m as usize],
                K[i as usize / 5] as u128 * (u128::MAX / 0xffff_ffff),
            );
            vx(&mut c, rdnm(SHA1H, 3, 0, 0));
            let f = [SHA1C, SHA1P, SHA1M, SHA1P][i as usize / 5];
            vx(&mut c, rdnm(f, 0, 1, 2));
            c.v[1] = c.v[3];
            if i < 16 {
                let (m1, m2, m3) = (4 + (i + 1) % 4, 4 + (i + 2) % 4, 4 + (i + 3) % 4);
                vx(&mut c, rdnm(SHA1SU0, m, m1, m2));
                vx(&mut c, rdnm(SHA1SU1, m, m3, 0));
            }
        }
        for (e, h) in h.iter_mut().enumerate() {
            *h = h.wrapping_add((c.v[e / 4] >> (32 * (e % 4))) as u32);
        }
    }
    h
}

const K256: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// SHA-256 with SHA256H/H2/SU0/SU1: v0 abcd, v1 efgh, v2 W + K, v3 the saved abcd, v4–v7 the schedule.
fn sha256(msg: &[u8]) -> [u32; 8] {
    let mut h = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    for b in sha_blocks(msg) {
        let mut c = Cpu::default();
        c.v[0] = quad(&h[..4]);
        c.v[1] = quad(&h[4..]);
        for (q, w) in b.chunks(4).enumerate() {
            c.v[4 + q] = quad(w);
        }
        for i in 0..16u32 {
            let m = 4 + i % 4;
            c.v[2] = add4(
                c.v[m as usize],
                quad(&K256[4 * i as usize..4 * i as usize + 4]),
            );
            c.v[3] = c.v[0];
            vx(&mut c, rdnm(SHA256H, 0, 1, 2));
            vx(&mut c, rdnm(SHA256H2, 1, 3, 2));
            if i < 12 {
                let (m1, m2, m3) = (4 + (i + 1) % 4, 4 + (i + 2) % 4, 4 + (i + 3) % 4);
                vx(&mut c, rdnm(SHA256SU0, m, m1, 0));
                vx(&mut c, rdnm(SHA256SU1, m, m2, m3));
            }
        }
        for (e, h) in h.iter_mut().enumerate() {
            *h = h.wrapping_add((c.v[e / 4] >> (32 * (e % 4))) as u32);
        }
    }
    h
}

#[test]
fn sha_known_answers() {
    // FIPS 180-4's examples (NIST's "Example Algorithms"): one block and two.
    let two = b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    assert_eq!(
        sha1(b"abc"),
        [0xa9993e36, 0x4706816a, 0xba3e2571, 0x7850c26c, 0x9cd0d89d]
    );
    assert_eq!(
        sha1(two),
        [0x84983e44, 0x1c3bd26e, 0xbaae4aa1, 0xf95129e5, 0xe54670f1]
    );
    assert_eq!(
        sha256(b"abc"),
        [
            0xba7816bf, 0x8f01cfea, 0x414140de, 0x5dae2223, 0xb00361a3, 0x96177a9c, 0xb410ff61,
            0xf20015ad
        ]
    );
    assert_eq!(
        sha256(two),
        [
            0x248d6a61, 0xd20638b8, 0xe5c02693, 0x0c3e6039, 0xa33ce459, 0x64ff2167, 0xf6ecedd4,
            0x19db06c1
        ]
    );
    // The empty message (padding only), from NIST's CAVP SHA byte-oriented short messages.
    assert_eq!(
        sha1(b""),
        [0xda39a3ee, 0x5e6b4b0d, 0x3255bfef, 0x95601890, 0xafd80709]
    );
    assert_eq!(
        sha256(b""),
        [
            0xe3b0c442, 0x98fc1c14, 0x9afbf4c8, 0x996fb924, 0x27ae41e4, 0x649b934c, 0xa495991b,
            0x7852b855
        ]
    );
    // SHA1H alone: the rotation by 30, upper bits cleared.
    let mut c = Cpu::default();
    c.v[2] = u128::MAX << 32 | 0x8000_0001;
    vx(&mut c, rdnm(SHA1H, 1, 2, 0));
    assert_eq!(c.v[1], 0x6000_0000);
}

const SHA512H: u32 = 0xce608000;
const SHA512H2: u32 = 0xce608400;
const SHA512SU1: u32 = 0xce608800;
const SHA512SU0: u32 = 0xcec08000;
const RAX1: u32 = 0xce608c00;
const XAR: u32 = 0xce800000;
const EOR3: u32 = 0xce000000;
const BCAX: u32 = 0xce200000;

/// FIPS 180-4's SHA-512 constants.
const K512: [u64; 80] = [
    0x428a2f98d728ae22,
    0x7137449123ef65cd,
    0xb5c0fbcfec4d3b2f,
    0xe9b5dba58189dbbc,
    0x3956c25bf348b538,
    0x59f111f1b605d019,
    0x923f82a4af194f9b,
    0xab1c5ed5da6d8118,
    0xd807aa98a3030242,
    0x12835b0145706fbe,
    0x243185be4ee4b28c,
    0x550c7dc3d5ffb4e2,
    0x72be5d74f27b896f,
    0x80deb1fe3b1696b1,
    0x9bdc06a725c71235,
    0xc19bf174cf692694,
    0xe49b69c19ef14ad2,
    0xefbe4786384f25e3,
    0x0fc19dc68b8cd5b5,
    0x240ca1cc77ac9c65,
    0x2de92c6f592b0275,
    0x4a7484aa6ea6e483,
    0x5cb0a9dcbd41fbd4,
    0x76f988da831153b5,
    0x983e5152ee66dfab,
    0xa831c66d2db43210,
    0xb00327c898fb213f,
    0xbf597fc7beef0ee4,
    0xc6e00bf33da88fc2,
    0xd5a79147930aa725,
    0x06ca6351e003826f,
    0x142929670a0e6e70,
    0x27b70a8546d22ffc,
    0x2e1b21385c26c926,
    0x4d2c6dfc5ac42aed,
    0x53380d139d95b3df,
    0x650a73548baf63de,
    0x766a0abb3c77b2a8,
    0x81c2c92e47edaee6,
    0x92722c851482353b,
    0xa2bfe8a14cf10364,
    0xa81a664bbc423001,
    0xc24b8b70d0f89791,
    0xc76c51a30654be30,
    0xd192e819d6ef5218,
    0xd69906245565a910,
    0xf40e35855771202a,
    0x106aa07032bbd1b8,
    0x19a4c116b8d2d0c8,
    0x1e376c085141ab53,
    0x2748774cdf8eeb99,
    0x34b0bcb5e19b48a8,
    0x391c0cb3c5c95a63,
    0x4ed8aa4ae3418acb,
    0x5b9cca4f7763e373,
    0x682e6ff3d6b2b8a3,
    0x748f82ee5defb2fc,
    0x78a5636f43172f60,
    0x84c87814a1f0ab72,
    0x8cc702081a6439ec,
    0x90befffa23631e28,
    0xa4506cebde82bde9,
    0xbef9a3f7b2c67915,
    0xc67178f2e372532b,
    0xca273eceea26619c,
    0xd186b8c721c0c207,
    0xeada7dd6cde0eb1e,
    0xf57d4f7fee6ed178,
    0x06f067aa72176fba,
    0x0a637dc5a2c898a6,
    0x113f9804bef90dae,
    0x1b710b35131c471b,
    0x28db77f523047d84,
    0x32caab7b40c72493,
    0x3c9ebe0a15c9bebc,
    0x431d67c49c100d4c,
    0x4cc5d4becb3e42b6,
    0x597f299cfc657e2a,
    0x5fcb6fab3ad6faec,
    0x6c44198c4a475817,
];

fn pair(lo: u64, hi: u64) -> u128 {
    (hi as u128) << 64 | lo as u128
}

fn add2(a: u128, b: u128) -> u128 {
    pair(
        (a as u64).wrapping_add(b as u64),
        ((a >> 64) as u64).wrapping_add((b >> 64) as u64),
    )
}

/// `ext Vd.16b, Vn.16b, Vm.16b, #8`: n's high half, then m's low half.
fn ext8(n: u128, m: u128) -> u128 {
    n >> 64 | m << 64
}

/// SHA-512 as Linux's sha512-ce runs it (its `dround`): the state in v0–v4,
/// two words a register, renamed round by round; the schedule in v12–v19.
fn sha512(msg: &[u8]) -> [u64; 8] {
    let mut h: [u64; 8] = [
        0x6a09e667f3bcc908,
        0xbb67ae8584caa73b,
        0x3c6ef372fe94f82b,
        0xa54ff53a5f1d36f1,
        0x510e527fade682d1,
        0x9b05688c2b3e6c1f,
        0x1f83d9abfb41bd6b,
        0x5be0cd19137e2179,
    ];
    let mut m = msg.to_vec();
    m.push(0x80);
    while m.len() % 128 != 112 {
        m.push(0);
    }
    m.extend_from_slice(&(8 * msg.len() as u128).to_be_bytes());
    // i0..i4 of the five drounds Linux cycles through.
    const ROT: [[usize; 5]; 5] = [
        [0, 1, 2, 3, 4],
        [3, 0, 4, 2, 1],
        [2, 3, 1, 4, 0],
        [4, 2, 0, 1, 3],
        [1, 4, 3, 0, 2],
    ];
    for b in m.chunks(128) {
        let w = |i: usize| u64::from_be_bytes(b[8 * i..8 * i + 8].try_into().unwrap());
        let mut c = Cpu::default();
        for q in 0..4 {
            c.v[q] = pair(h[2 * q], h[2 * q + 1]);
        }
        for q in 0..8 {
            c.v[12 + q] = pair(w(2 * q), w(2 * q + 1));
        }
        for k in 0..40 {
            let [i0, i1, i2, i3, i4] = ROT[k % 5];
            let r = |j: usize| 12 + (k + j) % 8;
            let (in0, in1, in2, in3, in4) = (r(0), r(1), r(7), r(4), r(5));
            let wk = add2(c.v[in0], pair(K512[2 * k], K512[2 * k + 1]));
            c.v[6] = ext8(c.v[i2], c.v[i3]);
            c.v[7] = ext8(c.v[i1], c.v[i2]);
            c.v[i3] = add2(c.v[i3], ext8(wk, wk));
            if k < 32 {
                c.v[5] = ext8(c.v[in3], c.v[in4]);
                vx(&mut c, rdnm(SHA512SU0, in0 as u32, in1 as u32, 0));
            }
            vx(&mut c, rdnm(SHA512H, i3 as u32, 6, 7));
            if k < 32 {
                vx(&mut c, rdnm(SHA512SU1, in0 as u32, in2 as u32, 5));
            }
            c.v[i4] = add2(c.v[i1], c.v[i3]);
            vx(&mut c, rdnm(SHA512H2, i3 as u32, i1 as u32, i0 as u32));
        }
        for (e, h) in h.iter_mut().enumerate() {
            *h = h.wrapping_add((c.v[e / 2] >> (64 * (e % 2))) as u64);
        }
    }
    h
}

/// `insn` (Vd = v0, Vn = v1, Vm = v2, Va or imm6 = `a`) on n, m and v3 = `va`.
fn sha3_op(insn: u32, a: u32, n: u128, m: u128, va: u128) -> u128 {
    let mut c = Cpu::default();
    (c.v[1], c.v[2], c.v[3]) = (n, m, va);
    vx(&mut c, insn | 2 << 16 | a << 10 | 1 << 5);
    c.v[0]
}

/// Keccak-f[1600] (FIPS 202 3.3) as Linux's sha3-ce writes a round: θ by EOR3
/// and RAX1, ρ and π by XAR, χ by BCAX. Two states, one a lane.
fn keccak(s: &mut [u128; 25]) {
    let mut rho = [0u32; 25];
    let (mut x, mut y) = (1, 0);
    for t in 0..24 {
        rho[x + 5 * y] = ((t + 1) * (t + 2) / 2) % 64;
        (x, y) = (y, (2 * x + 3 * y) % 5);
    }
    let mut lfsr = 1u8;
    for _ in 0..24 {
        let c: [u128; 5] = core::array::from_fn(|x| {
            let t = sha3_op(EOR3, 3, s[x], s[x + 5], s[x + 10]);
            sha3_op(EOR3, 3, t, s[x + 15], s[x + 20])
        });
        let d: [u128; 5] =
            core::array::from_fn(|x| sha3_op(RAX1, 0, c[(x + 4) % 5], c[(x + 1) % 5], 0));
        let mut b = [0u128; 25];
        for x in 0..5 {
            for y in 0..5 {
                let r = (64 - rho[x + 5 * y]) % 64;
                b[y + 5 * ((2 * x + 3 * y) % 5)] = sha3_op(XAR, r, s[x + 5 * y], d[x], 0);
            }
        }
        for x in 0..5 {
            for y in 0..5 {
                let (b1, b2) = (b[(x + 1) % 5 + 5 * y], b[(x + 2) % 5 + 5 * y]);
                s[x + 5 * y] = sha3_op(BCAX, 3, b[x + 5 * y], b2, b1);
            }
        }
        let mut rc = 0u64;
        for j in 0..7 {
            if lfsr & 1 != 0 {
                rc |= 1 << ((1 << j) - 1);
            }
            lfsr = if lfsr & 0x80 != 0 {
                lfsr << 1 ^ 0x71
            } else {
                lfsr << 1
            };
        }
        s[0] ^= pair(rc, rc);
    }
}

/// SHA3-256 of two messages of one block's rate (136 bytes) or less, one a lane.
fn sha3_256(a: &[u8], b: &[u8]) -> [[u8; 32]; 2] {
    let pad = |m: &[u8]| {
        let mut p = m.to_vec();
        p.resize(136, 0);
        p[m.len()] ^= 0x06;
        p[135] ^= 0x80;
        p
    };
    let (pa, pb) = (pad(a), pad(b));
    let mut s = [0u128; 25];
    for (l, s) in s.iter_mut().enumerate().take(17) {
        let lane = |p: &[u8]| u64::from_le_bytes(p[8 * l..8 * l + 8].try_into().unwrap());
        *s = pair(lane(&pa), lane(&pb));
    }
    keccak(&mut s);
    core::array::from_fn(|h| core::array::from_fn(|i| (s[i / 8] >> (64 * h + 8 * (i % 8))) as u8))
}

#[test]
fn sha512_and_sha3_known_answers() {
    // FIPS 180-4's examples: one block and two.
    let two = b"abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu";
    assert_eq!(
        sha512(b"abc"),
        [
            0xddaf35a193617aba,
            0xcc417349ae204131,
            0x12e6fa4e89a97ea2,
            0x0a9eeee64b55d39a,
            0x2192992a274fc1a8,
            0x36ba3c23a3feebbd,
            0x454d4423643ce80e,
            0x2a9ac94fa54ca49f
        ]
    );
    assert_eq!(
        sha512(two),
        [
            0x8e959b75dae313da,
            0x8cf4f72814fc143f,
            0x8f7779c6eb9f7fa1,
            0x7299aeadb6889018,
            0x501d289e4900f7e4,
            0x331b99dec4b5433a,
            0xc7d329eeb6dd2654,
            0x5e96e55b874be909
        ]
    );
    // FIPS 202's SHA3-256 of "abc" and of the empty message.
    let hex = |h: &[u8; 32]| h.iter().map(|b| format!("{b:02x}")).collect::<String>();
    let [abc, empty] = sha3_256(b"abc", b"");
    assert_eq!(
        hex(&abc),
        "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532"
    );
    assert_eq!(
        hex(&empty),
        "a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a"
    );
}

const PMULL: u32 = 0x0ee0e000;
const PMULL2: u32 = 0x4ee0e000;

/// GCM's multiply in GF(2¹²⁸) (SP 800-38D 6.3, bit 0 of a block = the MSB of its
/// first byte = the coefficient of x⁰): the four 64×64 products through
/// PMULL/PMULL2, the reduction by x¹²⁸ + x⁷ + x² + x + 1 in the test.
fn gf128_mul(x: u128, y: u128) -> u128 {
    // Blocks in memory order → polynomials with bit i = the coefficient of xⁱ.
    let to_poly = |b: u128| u128::from_be_bytes(b.to_le_bytes()).reverse_bits();
    let (a, b) = (to_poly(x), to_poly(y));
    let mut c = Cpu::default();
    c.v[1] = a;
    c.v[2] = b;
    c.v[3] = b.rotate_left(64);
    vx(&mut c, rdnm(PMULL, 4, 1, 2)); // a0·b0
    vx(&mut c, rdnm(PMULL2, 5, 1, 2)); // a1·b1
    vx(&mut c, rdnm(PMULL, 6, 1, 3)); // a0·b1
    vx(&mut c, rdnm(PMULL2, 7, 1, 3)); // a1·b0
    let mid = c.v[6] ^ c.v[7];
    let (mut lo, mut hi) = (c.v[4] ^ mid << 64, c.v[5] ^ mid >> 64);
    // Fold the high 128 bits down: x¹²⁸ = x⁷ + x² + x + 1.
    for _ in 0..2 {
        let over = hi;
        hi = 0;
        for s in [0, 1, 2, 7] {
            lo ^= over << s;
            if s > 0 {
                hi ^= over >> (128 - s);
            }
        }
    }
    let from_poly = |p: u128| u128::from_le_bytes(p.reverse_bits().to_be_bytes());
    from_poly(lo)
}

/// The same product bit by bit (SP 800-38D algorithm 1), for the check.
fn gf128_mul_ref(x: u128, y: u128) -> u128 {
    let (x, y) = (
        u128::from_be_bytes(x.to_le_bytes()),
        u128::from_be_bytes(y.to_le_bytes()),
    );
    let (mut z, mut v) = (0u128, y);
    for i in 0..128 {
        if x >> (127 - i) & 1 == 1 {
            z ^= v;
        }
        v = if v & 1 == 1 {
            v >> 1 ^ 0xe1 << 120
        } else {
            v >> 1
        };
    }
    u128::from_le_bytes(z.to_be_bytes())
}

#[test]
fn pmull_ghash() {
    // GCM test case 2 (McGrew and Viega): H = AES_0(0); GHASH over one ciphertext
    // block and the length block.
    let h = block("66e94bd4ef8a2c3b884cfa59ca342b2e");
    let ct = block("0388dace60b6a392f328c2b971b2fe78");
    let len = block("00000000000000000000000000000080");
    for mul in [gf128_mul, gf128_mul_ref] {
        let y = mul(mul(ct, h) ^ len, h);
        assert_eq!(y, block("f38cbb1ad69223dcc3457ae5b6b0f885"));
    }
    let mut s = 0x0123_4567_89ab_cdef_u128 << 64 | 0xfedc_ba98_7654_3210;
    for _ in 0..200 {
        s = s
            .wrapping_mul(0x2360_ed05_1fc6_5da4_4385_df64_9fcc_f645)
            .wrapping_add(0x5851_f42d_4c95_7f2d_1405_7b7e_f767_814f);
        let t = s.rotate_left(61) ^ s >> 3;
        assert_eq!(gf128_mul(s, t), gf128_mul_ref(s, t));
    }
    // PMULL2 takes the high halves; the 8-bit form (size 0) is unchanged.
    let mut c = Cpu::default();
    c.v[1] = 3u128 << 64 | 1;
    c.v[2] = 3u128 << 64 | 1;
    vx(&mut c, rdnm(PMULL2, 0, 1, 2));
    assert_eq!(c.v[0], 5);
    vx(&mut c, rdnm(PMULL, 0, 1, 2));
    assert_eq!(c.v[0], 1);
}

#[test]
fn crypto_feature_gate() {
    // Without FEATURE_CRYPTO the crypto instructions are UNDEFINED, ahead of the
    // FPEN trap; with it (every user-mode vCPU) they run.
    for insn in [
        rdnm(AESE, 1, 2, 0),
        rdnm(SHA256H, 1, 2, 3),
        rdnm(SHA1H, 1, 2, 0),
        rdnm(PMULL2, 1, 2, 3),
    ] {
        for cpacr in [3 << 20, 0] {
            let mut t = T::new(&[insn]);
            t.c.features = 0;
            t.c.cpacr_el1 = cpacr;
            assert_eq!(t.step(), Err(Exit::Undefined), "{insn:#x}");
        }
        let mut t = T::new(&[insn]);
        assert_eq!(t.step(), Ok(()), "{insn:#x}");
    }
    // SHA512 and SHA3 need FEATURE_SHA3 too, and it means nothing alone.
    use crate::cpu::{FEATURE_CRYPTO, FEATURE_SHA3};
    for insn in [
        rdnm(SHA512H, 1, 2, 3),
        rdnm(SHA512SU0, 1, 2, 0),
        rdnm(EOR3, 1, 2, 3) | 4 << 10,
        rdnm(XAR, 1, 2, 3) | 5 << 10,
    ] {
        for (features, cpacr) in [
            (0, 3 << 20),
            (FEATURE_CRYPTO, 3 << 20),
            (FEATURE_SHA3, 3 << 20),
            (FEATURE_CRYPTO, 0),
        ] {
            let mut t = T::new(&[insn]);
            t.c.features = features;
            t.c.cpacr_el1 = cpacr;
            assert_eq!(t.step(), Err(Exit::Undefined), "{insn:#x} {features}");
        }
        let mut t = T::new(&[insn]);
        t.c.features = FEATURE_CRYPTO | FEATURE_SHA3;
        assert_eq!(t.step(), Ok(()), "{insn:#x}");
    }
    // The 8-bit PMULL is plain AdvSIMD.
    let mut t = T::new(&[0x0e22e020]);
    t.c.features = 0;
    assert_eq!(t.step(), Ok(()));
    assert_eq!(sys::isar0(0), 2 << 20 | 1 << 16);
    assert_eq!(sys::isar0(FEATURE_SHA3), 2 << 20 | 1 << 16);
    assert_eq!(
        sys::isar0(FEATURE_CRYPTO),
        2 << 20 | 1 << 16 | 1 << 12 | 1 << 8 | 2 << 4
    );
    // SHA2 = 2 (SHA512) and SHA3 = 1.
    assert_eq!(
        sys::isar0(FEATURE_CRYPTO | FEATURE_SHA3),
        1 << 32 | 2 << 20 | 1 << 16 | 2 << 12 | 1 << 8 | 2 << 4
    );
}

#[test]
fn fast_completion_classes() {
    // mrs x1, cntvct_el0; mrs x1, cntpct_el0: counter reads; msr cntv_cval_el0, x1 and mrs x1, cntfrq_el0 aren't.
    assert!(sys::is_counter_read(0xd53be041));
    assert!(sys::is_counter_read(0xd53be021));
    assert!(!sys::is_counter_read(0xd51be341));
    assert!(!sys::is_counter_read(0xd53be001));
    // The counter and CNTFRQ show no timer state; mrs x1, cntv_ctl_el0 and mrs x1, isr_el1 do.
    assert!(!sys::shows_timers(0xd53be041));
    assert!(!sys::shows_timers(0xd53be001));
    assert!(sys::shows_timers(0xd53be321));
    assert!(sys::shows_timers(0xd538c101));
    // msr daifclr, #2; msr daifset, #2; msr daif, x1: DAIF writes; mrs x1, daif and msr sctlr_el1, x1 aren't.
    assert!(sys::is_daif_write(0xd50342ff));
    assert!(sys::is_daif_write(0xd50342df));
    assert!(sys::is_daif_write(0xd51b4221));
    assert!(!sys::is_daif_write(0xd53b4221));
    assert!(!sys::is_daif_write(0xd5181001));
}

#[test]
fn undefined_before_sp_alignment_and_fpen() {
    // Each with SP misaligned (SA0 set): a reserved encoding is UNDEFINED,
    // which decoding finds before the SP alignment check.
    let undefined = |insn: u32, cpacr: u64| {
        let mut t = T::new(&[insn]).x(31, DATA + 8).x(1, 8);
        t.c.cpacr_el1 = cpacr;
        t.step()
    };
    for insn in [
        0xf8610be0u32, // ldr x0, [sp, w1, uxtb] (option 000)
        0xe94003e0,    // ldp with opc 11
        0x48217fe0,    // casp with an odd Rs
        0x7dc003e0,    // ldr (SIMD&FP, unsigned offset) with size 01, opc 11
        0x0c400fe0,    // ld4 {.1d}
        0x4c4013e0,    // ld1-ld4 (multiple) with opcode 0001
    ] {
        assert_eq!(undefined(insn, 3 << 20), Err(Exit::Undefined), "{insn:#x}");
    }
    // And the SIMD&FP ones before the FPEN trap.
    for insn in [0x7dc003e0u32, 0x0c400fe0, 0x4c4013e0] {
        assert_eq!(undefined(insn, 0), Err(Exit::Undefined), "{insn:#x}");
    }
    // Their allocated neighbours: FPEN, then SP's alignment.
    assert_eq!(undefined(0xf8616be0, 3 << 20), Err(Exit::Trap(0x26 << 26))); // ldr x0, [sp, x1]
    assert_eq!(undefined(0x48207fe0, 3 << 20), Err(Exit::Trap(0x26 << 26))); // casp x0, x1, x0, x1, [sp]
    assert_eq!(undefined(0x4c4003e0, 3 << 20), Err(Exit::Trap(0x26 << 26))); // ld4 {v0.16b-v3.16b}, [sp]
    assert_eq!(
        undefined(0x4c4003e0, 0),
        Err(Exit::Trap(0x07 << 26 | sys::ISS_COND_AL))
    );
}

#[test]
fn stepped_external_abort_runs_again() {
    use crate::cpu::PSTATE_SS;
    // ldr x0, [x9] past RAM, stepped at EL0: the external abort leaves the
    // step active-not-pending (SPSR.SS = 1), as the other aborts do.
    let mut t = T::new(&[0xf9400120]).x(9, 0xffff_0000);
    t.c.vbar_el1 = VBAR;
    t.c.mdscr_el1 = debug::MDSCR_SS;
    t.c.pstate |= PSTATE_SS;
    debug::arm(&mut t.c);
    t.sys().unwrap();
    assert_eq!(t.c.esr_el1, 0x24 << 26 | 1 << 25 | 0x10);
    assert_eq!((t.c.elr_el1, t.c.spsr_el1 & PSTATE_SS), (CODE, PSTATE_SS));
    // Not stepped: SPSR.SS stays 0.
    let mut t = T::new(&[0xf9400120]).x(9, 0xffff_0000);
    t.c.vbar_el1 = VBAR;
    t.sys().unwrap();
    assert_eq!(t.c.spsr_el1 & PSTATE_SS, 0);
}

#[test]
fn run_loops_retire_the_smp_exits() {
    use crate::cpu::FEATURE_SMP;
    // wfe, sev, sevl at EL0 (nTWE set): each retires in `run`.
    let mut t = T::new(&[0xd503205f, 0xd503209f, 0xd50320bf]);
    t.c.features |= FEATURE_SMP;
    assert_eq!(run(&mut t.c, &t.r.mem, 3), (3, Ok(())));
    assert_eq!(t.c.pc, CODE + 12);
    // tlbi vmalle1is and wfe at EL1: they retire in `run_system`, no exception.
    let mut t = T::new(&[0xd508831f, 0xd503205f]).el1();
    t.c.features |= FEATURE_SMP;
    let mut v = crate::mmu::Vcpu::new(t.c.clone());
    assert_eq!(run_system(&mut v, &t.r.mem, 2), (2, Ok(())));
    assert_eq!((v.cpu.pc, v.cpu.el()), (CODE + 8, 1));
}
