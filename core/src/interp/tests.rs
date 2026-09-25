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
    assert!(matches!(
        T::new(&[0x9e670020]).step(),
        Err(Exit::Unimplemented(_))
    )); // fmov d0, x1
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

#[test]
fn faults_leave_state_alone() {
    let mut t = T::new(&[0xf9400120]).x(9, 0xffff_0000).x(0, 1); // ldr x0, [x9]
    assert_eq!(t.step(), Err(Exit::Fault(Fault::Bus { addr: 0xffff_0000 })));
    assert_eq!((t.c.x[0], t.c.pc), (1, CODE));
    let mut t = T::new(&[0xc85f7d20]).x(9, DATA + 4); // ldxr x0, [x9]
    assert_eq!(t.step(), Err(Exit::Fault(Fault::Align { addr: DATA + 4 })));
    // ldp x3, x4, [sp], #16 with the second word out of RAM.
    let sp = RAM as u64 - 8;
    let mut t = T::new(&[0xa8c113e3]).x(31, sp).x(3, 1);
    assert_eq!(t.step(), Err(Exit::Fault(Fault::Bus { addr: RAM as u64 })));
    assert_eq!((t.c.x[3], t.c.x[31]), (1, sp));
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
