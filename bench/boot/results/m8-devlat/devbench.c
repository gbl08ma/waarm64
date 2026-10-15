// Ad hoc (bench/boot/results/m8-devlat): what an MMIO read, a GIC register read and a copy cost under the JIT,
// with the MMU on (1 GiB blocks: device below 1 GiB, RAM above). Built with tests/baremetal's runtime:
//   B=../../../../tests/baremetal; clang --target=aarch64-none-elf -march=armv8-a -O2 -ffreestanding -nostdlib -static \
//     -fno-stack-protector -fno-pie -fuse-ld=lld -Wl,-T,$B/link.ld -o devbench.elf $B/start.S devbench.c
//   llvm-objcopy -O binary devbench.elf devbench.bin   (into this directory; not committed)
#include "../../../../tests/baremetal/lib.h"
typedef unsigned char u8;
static u64 l1[512] __attribute__((aligned(4096)));
static u64 now(void) { u64 v; __asm__ volatile("isb; mrs %0, cntvct_el0" : "=r"(v)); return v; }
static u64 frq;
static void report(const char *what, u64 t0, u64 n, u64 bytes) {
  u64 ns = (now() - t0) * 1000000000ull / frq;
  uart_puts(what);
  uart_puts(": ");
  if (bytes) { uart_dec(bytes * 1000 / ns); uart_puts(" MB/s\n"); }
  else { uart_dec(ns * 1000 / n); uart_puts(" ps/op\n"); }
}
#define BUF ((u8 *)0x41000000UL)
#define SZ (64 << 10)
static void copy_q(u8 *d, const u8 *s, u64 n) { // glibc's __memcpy_generic loop shape: 64 bytes, two LDP/STP Q
  for (u64 i = 0; i < n; i += 64)
    __asm__ volatile("ldp q0, q1, [%1]; ldp q2, q3, [%1, #32]; stp q0, q1, [%0]; stp q2, q3, [%0, #32]"
                     : : "r"(d + i), "r"(s + i) : "v0", "v1", "v2", "v3", "memory");
}
static void copy_x(u8 *d, const u8 *s, u64 n) { // pairs of X registers
  for (u64 i = 0; i < n; i += 64)
    __asm__ volatile("ldp x2, x3, [%1]; ldp x4, x5, [%1, #16]; ldp x6, x7, [%1, #32]; ldp x8, x9, [%1, #48];"
                     "stp x2, x3, [%0]; stp x4, x5, [%0, #16]; stp x6, x7, [%0, #32]; stp x8, x9, [%0, #48]"
                     : : "r"(d + i), "r"(s + i) : "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9", "memory");
}
static void copy_t(u8 *d, const u8 *s, u64 n) { // the kernel's usercopy shape: LDTR/STTR of 8 bytes
  for (u64 i = 0; i < n; i += 32)
    __asm__ volatile("ldtr x2, [%1]; ldtr x3, [%1, #8]; ldtr x4, [%1, #16]; ldtr x5, [%1, #24];"
                     "sttr x2, [%0]; sttr x3, [%0, #8]; sttr x4, [%0, #16]; sttr x5, [%0, #24]"
                     : : "r"(d + i), "r"(s + i) : "x2", "x3", "x4", "x5", "memory");
}
static void zero_zva(u8 *d, u64 n) {
  for (u64 i = 0; i < n; i += 64) __asm__ volatile("dc zva, %0" : : "r"(d + i) : "memory");
}
int main(void) {
  frq = sysreg(CNTFRQ_EL0);
  for (u64 i = 0; i < 2; i++) l1[i] = i << 30 | 1 << 10 | (i ? 0 : 1 << 2 | 1UL << 54 | 1UL << 53) | (i ? 3 << 8 : 0) | 1;
  l1[2] = 1UL << 30 | 1 << 10 | 3 << 8 | 1 << 6 | 1UL << 54 | 1UL << 53 | 1; // RAM again at 2 GiB, EL0 read/write (LDTR/STTR)
  set_sysreg(mair_el1, 0x04ff); // attr 0 Normal WB, attr 1 Device-nGnRE
  set_sysreg(tcr_el1, 25 | 1UL << 8 | 1UL << 10 | 3UL << 12 | 1UL << 23 | 2UL << 32);
  set_sysreg(ttbr0_el1, (u64)l1);
  __asm__ volatile("tlbi vmalle1; dsb sy; isb");
  set_sysreg(sctlr_el1, sysreg(SCTLR_EL1) | 1 | 1UL << 2 | 1UL << 12);
  gic_init();
  for (int round = 0; round < 3; round++) {
    uart_puts("round "); uart_dec(round); uart_puts("\n");
    u64 t, n = 200000, acc = 0;
    t = now(); for (u64 i = 0; i < n; i++) acc += *(volatile u32 *)(BUF + (i & 1023) * 4); report("ram load", t, n, 0);
    t = now(); for (u64 i = 0; i < n; i++) acc += mmio32(UART + 0x18); report("pl011 FR read", t, n, 0);
    t = now(); for (u64 i = 0; i < n; i++) acc += mmio32(GICD); report("gicd CTLR read", t, n, 0);
    t = now(); for (u64 i = 0; i < n; i++) acc += mmio32(0x0a000000UL); report("virtio-mmio magic read", t, n, 0);
    t = now(); for (u64 i = 0; i < n; i++) { u64 v; __asm__ volatile("mrs %0, ICC_RPR_EL1" : "=r"(v)); acc += v; } report("ICC_RPR_EL1 read", t, n, 0);
    t = now(); for (u64 i = 0; i < n; i++) __asm__ volatile("msr ICC_PMR_EL1, %0" : : "r"(0xf0UL)); report("ICC_PMR_EL1 write", t, n, 0);
    u64 reps = 400;
    t = now(); for (u64 r = 0; r < reps; r++) copy_q(BUF + SZ, BUF, SZ); report("copy ldp/stp q 64K", t, 1, reps * SZ);
    t = now(); for (u64 r = 0; r < reps; r++) copy_x(BUF + SZ, BUF, SZ); report("copy ldp/stp x 64K", t, 1, reps * SZ);
    t = now(); for (u64 r = 0; r < reps; r++) copy_t(BUF + (1UL << 30) + SZ, BUF + (1UL << 30), SZ); report("copy ldtr/sttr 64K", t, 1, reps * SZ);
    t = now(); for (u64 r = 0; r < reps; r++) zero_zva(BUF + SZ, SZ); report("dc zva 64K", t, 1, reps * SZ);
    t = now(); for (u64 r = 0; r < 4; r++) copy_q(BUF + (8 << 20), BUF, 8 << 20); report("copy ldp/stp q 8M", t, 1, 4ull * (8 << 20));
    if (acc == 12345) uart_puts("!");
  }
  return 0;
}
void on_exception(struct frame *f, u64 vec) { uart_puts("exception esr "); uart_dec(f->esr); uart_puts(" far "); uart_dec(f->far); uart_puts("\n"); power_off(100 + vec); }
