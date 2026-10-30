// M3 step 3 end to end: stage 1 translation with 4K pages, TTBR0 and TTBR1,
// translation/access flag/permission/alignment faults, TLBI, AT and PAR_EL1,
// EL0 permissions, and page-crossing accesses.
#include "lib.h"

#define RAM 0x40000000UL
#define PAGE_SZ 0x1000UL
// Descriptor bits.
#define VALID 1UL
#define TABLE 3UL
#define ATTR_NORMAL (0UL << 2) // MAIR attr 0
#define SH_INNER (3UL << 8)
#define AF (1UL << 10)
#define AP_EL0_RW (1UL << 6)
#define AP_RO (2UL << 6)
#define PXN (1UL << 53)
#define UXN (1UL << 54)
#define PAGE (3UL | AF | SH_INNER | ATTR_NORMAL)

typedef u64 table[512] __attribute__((aligned(4096)));
static table l0, l1, l2, l3;               // TTBR0: RAM's first 2 MiB, one page at a time
static table l2_test, l3_test;             // TTBR0: test pages at 0x8000_0000
static table l0_hi, l1_hi, l2_hi, l3_hi;   // TTBR1: 0xffff_0000_0000_0000
static u64 pages[4][512] __attribute__((aligned(4096)));
extern char stack_top[];

#define TEST_VA 0x80000000UL // l3_test slot n maps TEST_VA + n pages
#define HI_VA 0xffff000000000000UL
#define L3_OF(va) (((va) >> 12) & 511)

static volatile u64 n_exc, last_esr, prev_esr, last_far, last_vec, fix_af;

static void tlbi_va(u64 va) {
  __asm__ volatile("dsb ishst; tlbi vae1is, %0; dsb ish; isb" : : "r"(va >> 12) : "memory");
}

void on_exception(struct frame *f, u64 vec) {
  n_exc++;
  prev_esr = last_esr;
  last_esr = f->esr;
  last_far = f->far;
  last_vec = vec;
  u64 ec = f->esr >> 26;
  if (ec == 0x15 && (f->esr & 0xffff) == 1 && vec == VEC_EL0_SYNC) {
    f->elr = (u64)el0_return;
    f->spsr = 0x3c5;
    return;
  }
  // Access flag fault with fixing on: set AF and retry, as Linux does.
  if (fix_af && (ec == 0x25 || ec == 0x24) && (f->esr & 0x3c) == 0x08) {
    l3_test[L3_OF(f->far)] |= AF;
    tlbi_va(f->far);
    return;
  }
  if (ec != 0x15)
    f->elr += 4;
}

// Loads/stores whose fault the handler records and skips.
static u64 load(u64 va) {
  u64 v = 0xdead;
  __asm__ volatile("ldr %0, [%1]" : "+r"(v) : "r"(va) : "memory");
  return v;
}
static void store(u64 va, u64 v) { __asm__ volatile("str %0, [%1]" : : "r"(v), "r"(va) : "memory"); }
static u64 ldtr(u64 va) {
  u64 v = 0xdead;
  __asm__ volatile("ldtr %0, [%1]" : "+r"(v) : "r"(va) : "memory");
  return v;
}
static void sttr(u64 va, u64 v) { __asm__ volatile("sttr %0, [%1]" : : "r"(v), "r"(va) : "memory"); }
static u64 at_s1e1r(u64 va) {
  __asm__ volatile("at s1e1r, %0; isb" : : "r"(va));
  return sysreg(PAR_EL1);
}

#define DATA_ABORT_EL1(fsc, wnr) (0x96000000UL | (wnr) << 6 | (fsc))

// The word at `va` in TEST_VA's first two pages (on swapped PAs), from the
// identity map.
static u64 test_word(u64 va) {
  u64 off = va - TEST_VA;
  return pages[off < PAGE_SZ ? 1 : 0][(off % PAGE_SZ) / 8];
}

static u64 user_read_kernel(void) { return *(volatile u64 *)&pages[0][0]; }
static u64 user_write_ro(void) {
  *(volatile u64 *)(TEST_VA + 3 * PAGE_SZ) = 1;
  return 9;
}

int main(void) {
  // RAM's first 2 MiB (image, tables, stacks), EL1 only except the user stack.
  for (u64 i = 0; i < 512; i++) {
    u64 pa = RAM + i * PAGE_SZ;
    int user = pa >= (u64)stack_top && pa < (u64)user_stack_top;
    l3[i] = pa | PAGE | (user ? AP_EL0_RW | UXN | PXN : 0);
  }
  l2[0] = (u64)l3 | TABLE;
  l1[1] = (u64)l2 | TABLE; // 0x4000_0000
  l1[2] = (u64)l2_test | TABLE; // 0x8000_0000
  l2_test[0] = (u64)l3_test | TABLE;
  l0[0] = (u64)l1 | TABLE;
  // Test pages: 0, 1 adjacent VAs on swapped PAs; 2 no AF; 3 read-only for EL0 and EL1.
  l3_test[0] = (u64)pages[1] | PAGE;
  l3_test[1] = (u64)pages[0] | PAGE;
  l3_test[2] = ((u64)pages[2] | PAGE) & ~AF;
  l3_test[3] = (u64)pages[3] | PAGE | AP_RO | 1UL << 6; // AP = 11: EL0 and EL1 read-only
  // A kernel alias of pages[0] in the upper range.
  l0_hi[0] = (u64)l1_hi | TABLE;
  l1_hi[0] = (u64)l2_hi | TABLE;
  l2_hi[0] = (u64)l3_hi | TABLE;
  l3_hi[0] = (u64)pages[0] | PAGE | UXN | PXN;

  set_sysreg(mair_el1, 0xff); // attr 0: Normal write-back
  // T0SZ = T1SZ = 16, 4K granules, inner shareable write-back walks, 40-bit IPS.
  set_sysreg(tcr_el1, 16 | 1UL << 8 | 1UL << 10 | 3UL << 12 | 16UL << 16 | 1UL << 24 | 1UL << 26 |
                          3UL << 28 | 2UL << 30 | 2UL << 32);
  set_sysreg(ttbr0_el1, (u64)l0);
  set_sysreg(ttbr1_el1, (u64)l0_hi);
  __asm__ volatile("dsb ish; tlbi vmalle1; dsb ish; isb");
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) | 1 | 1UL << 2 | 1UL << 12); // M, C, I

  // Translations: TTBR1 alias, and AT/PAR.
  pages[0][1] = 0x1234;
  check(load(HI_VA + 8) == 0x1234, 1);
  check((at_s1e1r(TEST_VA + 0x18) & 0x0000fffffffff001UL) == (u64)pages[1], 2);
  check((at_s1e1r(TEST_VA + 0x10000) & 0x7f) == (0x07 << 1 | 1), 3); // translation, level 3

  // Faults: translation (level 1: nothing at 0x1_0000_0000), permission, and a
  // write to the TTBR1 alias with UXN/PXN still fine.
  u64 n0 = n_exc;
  check(load(0x100000000UL) == 0xdead && last_esr == DATA_ABORT_EL1(0x05, 0), 10);
  check(last_far == 0x100000000UL, 11);
  store(TEST_VA + 3 * PAGE_SZ + 8, 5);
  check(last_esr == DATA_ABORT_EL1(0x0f, 1) && last_far == TEST_VA + 3 * PAGE_SZ + 8, 12);
  store(HI_VA + 16, 6);
  check(pages[0][2] == 6 && n_exc == n0 + 2, 13);

  // Access flag: fault, fix, retry.
  n0 = n_exc;
  fix_af = 1;
  store(TEST_VA + 2 * PAGE_SZ, 7);
  fix_af = 0;
  check(n_exc == n0 + 1 && last_esr == DATA_ABORT_EL1(0x0b, 1) && pages[2][0] == 7, 20);

  // Remap and TLBI: the new page is what's read.
  pages[2][1] = 0x2222;
  pages[3][1] = 0x3333;
  check(load(TEST_VA + 2 * PAGE_SZ + 8) == 0x2222, 21);
  l3_test[2] = (u64)pages[3] | PAGE;
  tlbi_va(TEST_VA + 2 * PAGE_SZ);
  check(load(TEST_VA + 2 * PAGE_SZ + 8) == 0x3333, 22);

  // Page crossing: TEST_VA's two pages sit on swapped PAs.
  *(volatile u64 *)(TEST_VA + PAGE_SZ - 4) = 0x8877665544332211UL;
  check(((volatile u32 *)pages[1])[1023] == 0x44332211 && ((volatile u32 *)pages[0])[0] == 0x88776655, 30);
  check(*(volatile u32 *)(TEST_VA + PAGE_SZ - 2) == 0x66554433, 31);

  // Accesses off one base share a TLB probe in the JIT (docs/jit.md "Loads and
  // stores"): each must still reach its own page when they span two (the
  // swapped pages), with a writeback and an add to the base between them.
  for (u64 j = 0; j < 512; j++) {
    pages[1][j] = 0x1000 + j;
    pages[0][j] = 0x2000 + j;
  }
  for (int i = 0; i < 64; i++) {
    u64 b0 = TEST_VA + PAGE_SZ - 32 + 8 * (i % 5), b = b0, x, y, z;
    __asm__ volatile("ldr %0, [%3]; ldr %1, [%3, #8]; ldr %2, [%3, #-8]"
                     : "=&r"(x), "=&r"(y), "=&r"(z)
                     : "r"(b)
                     : "memory");
    check(x == test_word(b) && y == test_word(b + 8) && z == test_word(b - 8), 35);
    __asm__ volatile("ldr %0, [%3], #8; add %3, %3, #8; ldr %1, [%3]; ldr %2, [%3, #-16]"
                     : "=&r"(x), "=&r"(y), "=&r"(z), "+r"(b)
                     :
                     : "memory");
    check(b == b0 + 16 && x == test_word(b0) && y == test_word(b0 + 16) && z == test_word(b0), 36);
  }
  // A group's second store faults (page 3 is read-only, page 2 maps pages[3]
  // writable since check 22): the first is done, the second not.
  for (int i = 0; i < 64; i++) {
    u64 n1 = n_exc, b = TEST_VA + 3 * PAGE_SZ - 8, v = 0x77 + i;
    pages[3][511] = 0;
    __asm__ volatile("str %1, [%0]; str %1, [%0, #8]" : : "r"(b), "r"(v) : "memory");
    check(n_exc == n1 + 1 && last_esr == DATA_ABORT_EL1(0x0f, 1) && last_far == b + 8 && pages[3][511] == v, 37);
  }
  // A load into the base ends its group: the next load uses the new base.
  pages[1][0] = TEST_VA + 0x100;
  for (int i = 0; i < 64; i++) {
    u64 b = TEST_VA, x, y;
    __asm__ volatile("ldr %0, [%2, #8]; ldr %2, [%2]; ldr %1, [%2]" : "=&r"(x), "=&r"(y), "+r"(b) : : "memory");
    check(x == 0x1001 && b == TEST_VA + 0x100 && y == 0x1020, 38);
  }

  // LDTR/STTR at EL1 have EL0's permissions: they fault on EL1-only pages
  // (permission, level 3) and reach the user stack.
  n0 = n_exc;
  check(ldtr(TEST_VA + 8) == 0xdead && last_esr == DATA_ABORT_EL1(0x0f, 0) && last_far == TEST_VA + 8, 32);
  sttr(TEST_VA + 16, 1);
  check(last_esr == DATA_ABORT_EL1(0x0f, 1) && last_far == TEST_VA + 16 && n_exc == n0 + 2, 33);
  sttr((u64)user_stack_top - 16, 0x5555);
  check(ldtr((u64)user_stack_top - 16) == 0x5555 && n_exc == n0 + 2, 34);

  // SCTLR_EL1.A: misaligned accesses fault (alignment, DFSC 0x21).
  u64 sctlr = sysreg(SCTLR_EL1);
  set_sysreg(sctlr_el1, sctlr | 2);
  __asm__ volatile("ldr x0, [%0]" : : "r"(TEST_VA + 4) : "x0", "memory");
  set_sysreg(sctlr_el1, sctlr);
  check(last_esr == DATA_ABORT_EL1(0x21, 0) && last_far == TEST_VA + 4, 40);
#if !defined(ORACLE) || defined(HVF) // QEMU TCG doesn't raise SP alignment faults; we follow the architecture
  // SCTLR_EL1.SA: SP as a misaligned base faults (EC 0x26). Done on SP_EL0 so
  // the handler's own stack stays aligned.
  set_sysreg(sp_el0, (u64)user_stack_top - 8);
  set_sysreg(sctlr_el1, sctlr | 8);
  __asm__ volatile("msr spsel, #0; ldr x0, [sp]; msr spsel, #1" ::: "x0", "memory");
  set_sysreg(sctlr_el1, sctlr);
  check(last_esr == 0x9a000000UL && last_vec == VEC_EL1T_SYNC, 41);
#endif

  // EL0: runs from EL1-only text (EL0 may execute it), faults reading EL1
  // data (permission, level 3) and writing a read-only page.
  n0 = n_exc;
  run_el0(user_read_kernel, (u64)user_stack_top); // the load's result is whatever was in x0
  check(n_exc == n0 + 2 && prev_esr == 0x9200000fUL && last_far == (u64)pages[0], 50); // abort, svc #1
  n0 = n_exc;
  check(run_el0(user_write_ro, (u64)user_stack_top) == 9, 52);
  check(n_exc == n0 + 2 && prev_esr == 0x9200004fUL && last_far == TEST_VA + 3 * PAGE_SZ, 53);
  return 0;
}
