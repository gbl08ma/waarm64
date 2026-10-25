// VK1: the host-visible window's write-watch (docs/devices.md "virtio-gpu"), driven by tests/window-watch.test.ts.
// RAM and the window (16 MiB of RAM, a 2 MiB window right after it) mapped by 2 MiB blocks, the MMU on; then
// phases, each storing to a set of the window's pages in a loop hot enough for the JIT, after which the guest
// writes the phase's number to the mailbox and spins until the host has checked the dirty pages and bumped the
// watch's generation (the host's `go` word). Not run by the oracles: the window is ours.
// window: core/tests/baremetal.rs `window_watch` runs it, not `baremetal`.
#include "lib.h"

#define RAM 0x40000000UL
#define RAM_SIZE (16UL << 20)
#define WINDOW (RAM + RAM_SIZE)
#define PAGE_SZ 0x1000UL
#define MAILBOX (RAM + (8UL << 20)) // done at +0, go at +8: the host reads and writes them (the DTB is at the top)
#define BLOCK (1UL | 1UL << 10 | 3UL << 8) // a block, AF, inner shareable, MAIR attr 0
#define ITERS 3000

typedef u64 table[512] __attribute__((aligned(4096)));
static table l1, l2;

// Any exception fails the test (a fault would be the window not mapped, or not RAM).
void on_exception(struct frame *f, u64 vec) {
  power_off(100 + vec);
}

static void touch(u64 pages, u64 iters) {
  for (u64 i = 0; i < iters; i++)
    for (u64 p = 0; p < 64; p++)
      if (pages >> p & 1)
        *(volatile u64 *)(WINDOW + p * PAGE_SZ + 8 * (i & 7)) = i;
}

static void phase(u64 n) {
  volatile u64 *mb = (volatile u64 *)MAILBOX;
  __asm__ volatile("dsb sy" ::: "memory");
  mb[0] = n;
  while (mb[1] < n)
    __asm__ volatile("yield");
}

int main(void) {
  // TTBR0, 39-bit VAs from level 1: entry 1 (the GiB at RAM) points to l2, whose 2 MiB blocks map RAM and the window.
  l1[1] = (u64)l2 | 3;
  for (u64 k = 0; k < 9; k++)
    l2[k] = (RAM + (k << 21)) | BLOCK;
  set_sysreg(mair_el1, 0xff);
  set_sysreg(tcr_el1, 25UL | 1UL << 8 | 1UL << 10 | 3UL << 12 | 1UL << 23); // T0SZ 25, WB caches, ISH, EPD1
  set_sysreg(ttbr0_el1, (u64)l1);
  __asm__ volatile("tlbi vmalle1; dsb sy; isb");
  set_sysreg(sctlr_el1, sysreg(sctlr_el1) | 1 | 1 << 2 | 1 << 12); // M, C, I
  touch(1 << 1 | 1 << 2 | 1 << 3, ITERS);
  phase(1); // pages 1, 2, 3
  touch(1 << 5, ITERS);
  phase(2); // page 5 alone: 1 to 3 were taken at the last check
  touch(1 << 1, ITERS);
  (void)*(volatile u64 *)(WINDOW + 2 * PAGE_SZ);
  phase(3); // page 1 again (its write entry dropped at the bump), not page 2 (only read)
  for (u64 i = 0; i < ITERS; i++) {
    *(volatile u64 *)(WINDOW + 3 * PAGE_SZ) = i;
    *(volatile u32 *)(WINDOW + 8 * PAGE_SZ - 2) = (u32)i; // crosses into page 8
  }
  phase(4); // pages 3, 7, 8
  u64 old, fail;
  for (u64 i = 0; i < ITERS; i++) {
    __asm__ volatile(".arch_extension lse\n ldaddal %1, %0, [%2]" : "=&r"(old) : "r"(1UL), "r"(WINDOW + 9 * PAGE_SZ) : "memory");
    __asm__ volatile("1: ldxr %0, [%2]; add %0, %0, #1; stxr %w1, %0, [%2]; cbnz %w1, 1b"
                     : "=&r"(old), "=&r"(fail) : "r"(WINDOW + 10 * PAGE_SZ) : "memory");
  }
  phase(5); // pages 9 and 10, by atomics
  check(*(volatile u64 *)(WINDOW + 9 * PAGE_SZ) == ITERS, 1);
  check(*(volatile u64 *)(WINDOW + 10 * PAGE_SZ) == ITERS, 2);
  power_off(0);
}
